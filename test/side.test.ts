import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { openHost } from "../main.ts";
import { Side } from "../main.ts";

const message = (text: string, model: any) => ({ role: "assistant" as const, api: model.api, provider: model.provider, model: model.id,
  content: [{ type: "text" as const, text }], stopReason: "stop" as const, timestamp: 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

test("btw forks reference context while parent keeps working, and back does not merge the answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-side-test-"));
  const host = await openHost({ cwd: dir, stateDir: join(dir, "state"), noMcp: true });
  const parent = host.conversation;
  const requests: any[] = [];
  let mainStream: ReturnType<typeof createAssistantMessageEventStream> | undefined;
  let mainModel: any;
  host.models.streamSimple = ((model: any, context: any) => {
    requests.push(context); const stream = createAssistantMessageEventStream();
    if (requests.length === 1) { mainStream = stream; mainModel = model; }
    else { const answer = message("SIDE_ANSWER", model); queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message: answer }); stream.end(answer); }); }
    return stream;
  }) as any;
  try {
    const main = await host.submit("PARENT_TASK_MARKER; keep working");
    while (!mainStream) await Bun.sleep(1);
    const side = await host.btw("SIDE_QUESTION_MARKER");
    const child = host.conversation;
    expect((await side!.wait(ctx)).status).toBe("done");
    expect(child.id).not.toBe(parent.id);
    expect(JSON.stringify(requests[1])).toContain("PARENT_TASK_MARKER");
    expect(JSON.stringify(requests[1])).toContain("Side conversation boundary");
    expect(JSON.stringify(requests[1])).toContain("SIDE_QUESTION_MARKER");
    expect((await child.agent(ctx)).tools.map(t => t.name)).toEqual(["read", "web_search"]);
    const state = await parent.viewState(ctx); expect(state.value.docs["pi.live"]?.run).toBeDefined(); state.dispose();
    await host.back(); expect(host.conversation.id).toBe(parent.id);
    expect((await host.harness.snapshot(Side, child.id, ctx))?.closed).toBe(true);
    const answer = message("MAIN_DONE", mainModel); mainStream!.push({ type: "done", reason: "stop", message: answer }); mainStream!.end(answer);
    expect((await main.wait(ctx)).status).toBe("done");
    expect(JSON.stringify((await parent.entries({}, 100, undefined, ctx)).items)).not.toContain("SIDE_ANSWER");
  } finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
}, 15000);
