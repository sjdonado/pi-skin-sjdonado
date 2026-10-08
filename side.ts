import { defineDoc, type Conversation, type Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

export const Side = defineDoc<{ parent: number | null; boundary: number; closed: boolean }>({
  kind: "harness.side", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ parent: null, boundary: 0, closed: false }),
});
export const SIDE_BOUNDARY = "Side conversation boundary: inherited history is reference context only, not your current task. Answer only the question submitted after this boundary. Do not continue the parent's plans, tool calls, approvals or work. This is lightweight non-mutating exploration: do not edit files, execute shell commands, manage processes, publish, or delegate. The main conversation continues independently. Side answers are not appended to it.";

export async function forkSide(harness: Harness, parent: Conversation, tools: readonly ToolRegistration[]) {
  const last = (await parent.entries({}, 1, undefined, ctx)).items[0];
  const init = async (tx: Parameters<Parameters<Harness["commit"]>[0]>[0], id: any) => {
    const side = await tx.doc(Side, id); side.parent = parent.id; side.boundary = last?.id ?? 0;
  };
  const agent = await parent.agent(ctx);
  const options = { ownership: { kind: "ownerless" as const }, init,
    agent: { model: agent.model, thinkingLevel: agent.thinkingLevel, cwd: agent.cwd,
      tools: tools.filter(t => ["read", "web_search"].includes(t.name)),
      instructions: `${agent.instructions ?? ""}\n\n${SIDE_BOUNDARY}` } };
  return last ? parent.fork(last.id, options, ctx) : harness.createConversation(options, ctx);
}

export async function closeSide(harness: Harness, side: Conversation) {
  await side.abort(ctx);
  await harness.commit(async tx => { (await tx.doc(Side, side.id)).closed = true; }, ctx);
}
