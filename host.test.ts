import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { openHost } from "./host.ts";
import { listSessions, openSession } from "./session.ts";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

test("session lock rejects concurrent owners and releases for continuation", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lock-test-"));
  try {
    const session = openSession(dir, false, dir);
    expect(() => openSession(dir, true, dir)).toThrow("owned by live process");
    session.release();
    const resumed = openSession(dir, true, dir); expect(resumed.dir).toBe(session.dir); resumed.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("explicit resume targets the selected session rather than a newer empty one", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-resume-test-"));
  try {
    const first = openSession(dir, false, dir); first.release();
    const newer = openSession(dir, false, dir); newer.release();
    const selected = openSession(dir, false, dir, first.id);
    expect(selected.dir).toBe(first.dir); selected.release();
    expect(listSessions(dir, dir).map(s => s.id)).toContain(first.id);
    expect(() => openSession(dir, false, dir, "../outside")).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("Durable host persists conversations and discovers shared skills without inference", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-host-test-"));
  let host = await openHost({ cwd: dir, stateDir: join(dir, "state"), noMcp: true });
  try {
    const tools = (await host.conversation.agent(ctx)).tools.map(t => t.name);
    expect(tools).toContain("codemode"); expect(tools).toContain("subagent"); expect(tools).toContain("bg_start");
    expect(host.prompt.skills.map(s => s.name)).toContain("yolo");
    const marker = await host.harness.commit(tx => tx.appendEntry(host.conversation.id, { kind: "harness.test", data: { marker: "persisted" } }), ctx);
    const session = host.session.dir;
    await host.close();
    host = await openHost({ cwd: dir, stateDir: join(dir, "state"), noMcp: true, resume: true });
    expect(host.session.dir).toBe(session);
    expect((await host.harness.commit(tx => tx.entry(marker.id), ctx))?.data).toEqual({ marker: "persisted" });
  } finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("local slash tools render as native tool calls without inference", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-local-tool-test-"));
  const host = await openHost({ cwd: dir, stateDir: join(dir, "state"), noMcp: true });
  try {
    await host.localTool("bg_list", {}, () => host.processes.list());
    const entries = await host.harness.commit(tx => tx.scanEntries({ conversationId: host.conversation.id }, 10), ctx);
    const call = entries.items.find(e => e.kind === "pi.assistant" && JSON.stringify(e.model ?? []).includes("bg_list"));
    const result = entries.items.find(e => e.kind === "pi.tool-result" && JSON.stringify(e.model ?? []).includes("toolCallId"));
    expect(call).toBeDefined();
    expect(result).toBeDefined();
    const callMsg: any = (call!.model as any[])[0];
    expect(callMsg.role).toBe("assistant");
    expect(callMsg.stopReason).toBe("toolUse");
    expect(callMsg.content).toHaveLength(1);
    expect(callMsg.content[0].type).toBe("toolCall");
    expect(callMsg.content[0].name).toBe("bg_list");
    expect(callMsg.content[0].arguments).toEqual({});
    const resultMsg: any = (result!.model as any[])[0];
    expect(resultMsg.role).toBe("toolResult");
    expect(resultMsg.toolCallId).toBe(callMsg.content[0].id);
    expect(resultMsg.toolName).toBe("bg_list");
    expect(resultMsg.isError).toBe(false);
    expect(JSON.stringify(resultMsg.content)).toContain("[]");
    await host.localTool("bg_logs", { id: "missing" }, () => { throw new Error("nope"); });
    const after = await host.harness.commit(tx => tx.scanEntries({ conversationId: host.conversation.id }, 10), ctx);
    expect(JSON.stringify(after.items[0]?.model)).toContain("nope");
  } finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Durable loop delegates to a fresh child and returns its result without external inference", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-delegate-test-"));
  const host = await openHost({ cwd: dir, stateDir: join(dir, "state"), noMcp: true });
  const requests: any[] = [];
  host.models.streamSimple = ((model: any, context: any) => {
    requests.push(context);
    const n = requests.length;
    const stream = createAssistantMessageEventStream();
    const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: n === 1 ? "toolUse" : "stop",
      content: n === 1 ? [{ type: "toolCall", id: "delegate-1", name: "subagent", arguments: { task: "Return CHILD_RESULT" } }]
        : [{ type: "text", text: n === 2 ? "CHILD_RESULT" : "PARENT_DONE" }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); });
    return stream;
  }) as any;
  try {
    const result = await (await host.conversation.submit({ type: "input", content: "PARENT_ONLY_MARKER; delegate a task" }, ctx)).wait(ctx);
    expect(result.status).toBe("done");
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[1])).toContain("CHILD_RESULT");
    expect(JSON.stringify(requests[1])).not.toContain("PARENT_ONLY_MARKER");
    const conversations = await host.harness.commit(tx => tx.scanConversations({}, 10), ctx);
    expect(conversations.items).toHaveLength(2);
    const child = conversations.items.find(c => c.id !== host.conversation.id)!;
    expect((await (await host.harness.conversation(child.id, ctx))!.agent(ctx)).tools.map(t => t.name)).not.toContain("subagent");
  } finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
}, 15000);
