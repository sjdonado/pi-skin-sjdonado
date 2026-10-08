import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { openHost } from "../main.ts";
import { listSessions, openSession } from "../main.ts";
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
    expect(tools).toContain("codemode"); expect(tools).toContain("subagent"); expect(tools).toContain("background"); expect(tools).not.toContain("bg_start");
    expect(host.prompt.skills.map(s => s.name)).toContain("yolo");
    const marker = await host.harness.commit(tx => tx.appendEntry(host.conversation.id, { kind: "harness.test", data: { marker: "persisted" } }), ctx);
    const session = host.session.dir;
    await host.close();
    host = await openHost({ cwd: dir, stateDir: join(dir, "state"), noMcp: true, resume: true });
    expect(host.session.dir).toBe(session);
    expect((await host.harness.commit(tx => tx.entry(marker.id), ctx))?.data).toEqual({ marker: "persisted" });
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

test("background tool frees the main turn and posts its report back without external inference", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-background-test-"));
  const host = await openHost({ cwd: dir, stateDir: join(dir, "state"), noMcp: true });
  const requests: string[] = [];
  let childServed = false;
  host.models.streamSimple = ((model: any, context: any) => {
    const stream = createAssistantMessageEventStream();
    // The child transcript holds only the task input; the main transcript gains
    // the marker via the tool call, so serve the child answer exactly once.
    const isChild = !childServed && JSON.stringify(context).includes("BG_TASK_MARKER");
    if (isChild) childServed = true;
    const firstMain = requests.length === 0;
    const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: isChild ? "stop" : firstMain ? "toolUse" : "stop",
      content: isChild ? [{ type: "text", text: "BG_RESULT" }]
        : firstMain ? [{ type: "toolCall", id: "bg-1", name: "background", arguments: { task: "BG_TASK_MARKER return BG_RESULT" } }]
        : [{ type: "text", text: "MAIN_DONE" }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    requests.push(isChild ? "child" : "main");
    queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); });
    return stream;
  }) as any;
  try {
    const result = await (await host.conversation.submit({ type: "input", content: "start background work" }, ctx)).wait(ctx);
    expect(result.status).toBe("done");
    expect(requests[0]).toBe("main");
    // The main turn finishes while the background child still works.
    const deadline = Date.now() + 10000;
    for (;;) {
      const entries = await host.harness.commit(tx => tx.scanEntries({ conversationId: host.conversation.id }, 50), ctx);
      if (JSON.stringify(entries.items).includes("[background report] BG_RESULT")) break;
      if (Date.now() > deadline) throw new Error("Background report never arrived");
      await Bun.sleep(50);
    }
    expect(requests).toContain("child");
    const tasks = await host.backgroundTasks();
    expect(tasks.every(t => t.task.state.status === "terminal")).toBe(true);
    const conversations = await host.harness.commit(tx => tx.scanConversations({}, 10), ctx);
    expect(conversations.items).toHaveLength(2);
  } finally { await host.close(); rmSync(dir, { recursive: true, force: true }); }
}, 20000);
