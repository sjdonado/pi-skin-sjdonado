import { Type } from "typebox";
import { configure, defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Processes } from "./processes.ts";

export function subagentExtension(processes: Processes) {
  const subagent = defineTool({ name: "subagent", replay: "safe",
    description: "Delegate a bounded task to a fresh Durable child conversation. Supply authoritative file paths and acceptance checks. Parent cancellation aborts child work. Returns the child's answer; no automatic model fallback or recursive delegation.",
    parameters: Type.Object({ task: Type.String(), model: Type.Optional(Type.String({ description: "Configured provider/model, a bare Codex model ID, or inherit. Defaults to Luna for Codex parents and the current model for Go parents." })) }),
    execute: async (args, api, context) => {
      const parent = await api.agent(context);
      const fallback = parent.model?.provider === "openai-codex" ? { provider: "openai-codex", modelId: "gpt-6-luna" } : parent.model;
      const [provider, ...parts] = args.model?.split("/") ?? [];
      const selected = args.model === "inherit" ? parent.model : args.model
        ? parts.length ? { provider, modelId: parts.join("/") } : { provider: "openai-codex", modelId: args.model }
        : fallback;
      if (!selected || !api.models.getModel(selected.provider, selected.modelId)) throw new Error("Subagent model is not in the configured catalog");
      const childId = await api.commit(async tx => {
        const old = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (old) return old.id;
        const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        await configure(tx, child.id, { model: selected,
          thinkingLevel: "medium", tools: { remove: [subagent] } });
        return child.id;
      }, context);
      await api.details({ conversationId: childId }, context);
      try {
        const child = (await api.conversation(childId, context))!;
        const result = await (await child.submit({ type: "input", content: args.task, requestId: `subagent:${api.taskId}` }, context)).wait(context);
        if (result.status !== "done" || result.type !== "input") throw new Error(`Child did not answer: ${result.status}`);
        const entry = await api.commit(tx => tx.entry(result.answer), context);
        const message = entry?.model?.[0];
        const text = message?.role === "assistant" ? message.content.filter(c => c.type === "text").map(c => c.text).join("\n") : "";
        return { content: [{ type: "text" as const, text }], details: { conversationId: childId } };
      } finally { await processes.stopOwner(childId); }
    },
  });
  return defineExtension({ name: "subagents", tools: [subagent] });
}
