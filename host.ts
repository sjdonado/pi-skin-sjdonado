import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, createRegistry, type Conversation, type HarnessSettings } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { openSession } from "./session.ts";
import { Processes, processTools } from "./processes.ts";
import { connectMcp, loadMcp } from "./mcp.ts";
import { promptExtension } from "./prompt.ts";
import { subagentExtension } from "./subagent.ts";
import { writeFileSync } from "node:fs";
import { Side, forkSide, closeSide } from "./side.ts";
import { listSessions } from "./session.ts";
import { useOpenCodeGo } from "./providers.ts";
import { searchExtension } from "./search.ts";

export async function openHost(options: { cwd: string; resume?: boolean; sessionId?: string; noMcp?: boolean; stateDir?: string }) {
  const session = openSession(options.cwd, options.resume, options.stateDir, options.sessionId);
  const environments = new Map<string, NodeExecutionEnv>();
  let root: Conversation | undefined;
  let closing = false;
  const notices: string[] = [];
  const processes = new Processes(join(session.dir, "processes"), session.cwd, job => {
    notices.push(`Background ${job.name}: ${job.status} (${job.id})`);
    if (root && !closing && !["stopped", "owner-exited"].includes(job.status)) void root.submit({ type: "input", requestId: `process:${job.id}:${job.status}`,
      content: `Background process ${job.id} (${job.name}) is ${job.status}. Inspect logs if needed. Do not restart it automatically.`,
      whenBusy: "followUp" }, ctx).catch(error => notices.push(String(error)));
  });
  let harness: Harness | undefined;
  let mcp: Awaited<ReturnType<typeof connectMcp>> | undefined;
  try {
    const models = await ModelRuntime.create();
    await useOpenCodeGo(models);
    const settings = SettingsManager.create(session.cwd);
    const prompt = promptExtension(session.cwd);
    const registry = createRegistry();
    registry.install(CodingTools); registry.install(prompt.extension);
    registry.install(processTools(processes)); registry.install(subagentExtension(processes));
    registry.install(searchExtension(models).extension);
    mcp = await connectMcp(session.cwd, options.noMcp ? {} : loadMcp(session.cwd));
    registry.install(mcp.extension);
    const policy: HarnessSettings = {
      get compaction() { return { ...settings.getCompactionSettings(), backgroundTokens: 0 }; },
      get retry() { return settings.getRetrySettings(); },
      get stream() { return { timeoutMs: settings.getHttpIdleTimeoutMs(), maxRetries: 0 }; },
      toolExecution: "parallel",
    };
    harness = await Harness.open(await openNodeJsonlStorage(join(session.dir, "storage"), ctx, { fsync: true }), {
      models, registry, settings: policy,
      env: ({ cwd = session.cwd }) => {
        let env = environments.get(cwd);
        if (!env) { env = new NodeExecutionEnv({ cwd, shellPath: "/bin/bash" }); environments.set(cwd, env); }
        return env;
      },
      onReport: error => notices.push(String(error)),
    }, ctx);
    root = await harness.root(ctx);
    const agent = await root.agent(ctx);
    if (!agent.model) {
      const provider = settings.getDefaultProvider() ?? "openai-codex", modelId = settings.getDefaultModel() ?? "gpt-6-luna";
      await root.configure({ cwd: session.cwd, model: { provider, modelId },
        thinkingLevel: settings.getModelThinkingLevel(provider, modelId) ?? settings.getDefaultThinkingLevel() ?? "medium" }, ctx);
    }
    const opened = harness, clients = mcp;
    let shown = root;
    let sideParent: Conversation | undefined;
    // Codex-style side conversations are ephemeral work, not automatic resume targets.
    for (const record of (await opened.commit(tx => tx.scanConversations({}, 1000), ctx)).items) {
      const side = await opened.snapshot(Side, record.id, ctx);
      if (side?.parent !== undefined && side.parent !== null && !side.closed) await closeSide(opened, (await opened.conversation(record.id, ctx))!);
    }
    return {
      session, harness: opened, models, registry, settings, prompt, processes, notices, mcp: clients,
      get conversation() { return shown; },
      get sideParentId() { return sideParent?.id; },
      sessions: () => listSessions(session.cwd, options.stateDir),
      async conversations() {
        const result = [];
        for (const record of (await opened.commit(tx => tx.scanConversations({}, 1000), ctx)).items) {
          const side = await opened.snapshot(Side, record.id, ctx);
          if (side?.closed) continue;
          result.push({ ...record, label: side?.parent ? "Side question" : record.owner ? `Agent ${record.id}` : "Main" });
        }
        return result;
      },
      async submit(text: string, whenBusy: "steer" | "followUp" = "steer") {
        if (!sideParent) writeFileSync(join(session.dir, "preview.json"), JSON.stringify({ title: text.replace(/\s+/g, " ").slice(0, 120) }), { mode: 0o600 });
        return shown.submit({ type: "input", content: text, whenBusy }, ctx);
      },
      async btw(question?: string) {
        if (sideParent) throw new Error("A side conversation is already open; use /back first");
        const parent = shown;
        const child = await forkSide(opened, parent, (await parent.agent(ctx)).tools);
        sideParent = parent; shown = child;
        if (question) return child.submit({ type: "input", content: question }, ctx);
      },
      async back() {
        if (!sideParent) return;
        await closeSide(opened, shown); shown = sideParent; sideParent = undefined;
      },
      async switchConversation(id: number) {
        if (sideParent) { await closeSide(opened, shown); sideParent = undefined; }
        const next = await opened.conversation(id as any, ctx);
        if (!next) throw new Error("Conversation not found"); shown = next;
      },
      async abort() { await shown.abort(ctx); await processes.stopOwner(shown.id); },
      resume() { opened.resume(); },
      async close() {
        if (closing) return; closing = true;
        try {
          if (sideParent) await closeSide(opened, shown);
          await processes.close(); await opened.close(ctx);
          await Promise.all([...environments.values()].map(env => env.cleanup(ctx)));
          await clients.close();
        } finally { session.release(); }
      },
    };
  } catch (error) {
    closing = true;
    await processes.close(); await harness?.close(ctx); await mcp?.close();
    session.release(); throw error;
  }
}
export type Host = Awaited<ReturnType<typeof openHost>>;
