import { ModelRegistry, type ModelRuntime, type ExtensionContext, type ToolDefinition, type ExtensionAPI, type ToolRenderers, type AgentToolResult, type AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { defineDoc, defineExtension, defineTool, ProviderDoc } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { JsonValue } from "@earendil-works/chord";

// The source-only package targets older header types. Keep its compatibility boundary
// typed locally and normalize nullable Pi 1.1 headers instead of modifying package files.
// Static specifiers (not file URLs) so `bun build --compile` bundles the package.
const registerWebSearch = (await import("pi-web-search")).default as (pi: ExtensionAPI) => void;
const { webSearch, WebSearchSchema } = await import("pi-web-search/src/web_search.ts") as {
  WebSearchSchema: TSchema;
  webSearch: (id: string, args: { query: string; urls?: string[] }, signal: AbortSignal, update: AgentToolUpdateCallback | undefined,
    context: ExtensionContext, thinking?: ModelThinkingLevel) => Promise<AgentToolResult<Record<string, JsonValue>>>;
};

export const SearchUsage = defineDoc<{ callsWithUnknownUsage: number }>({
  kind: "harness.search-usage", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ callsWithUnknownUsage: 0 }),
});
const definitions: ToolDefinition[] = [];
// Capture this package's native renderer; it is not an ambient Durable extension.
registerWebSearch({ registerTool: (tool: ToolDefinition) => definitions.push(tool), on() {}, getActiveTools: () => [], setActiveTools() {} } as unknown as ExtensionAPI);
export const searchRenderer: ToolRenderers = definitions.find(t => t.name === "web_search")!;

export function searchExtension(models: ModelRuntime) {
  const registry = new ModelRegistry(models);
  const tool = defineTool({ name: "web_search", description: definitions[0].description,
    parameters: WebSearchSchema,
    execute: async (args, api, context) => {
      const agent = await api.agent(context);
      const model = agent.model && models.getModel(agent.model.provider, agent.model.modelId);
      // Go completion routes have no native search, and its Messages gateway is unverified.
      if (model?.provider === "opencode-go" && model.api !== "openai-responses") {
        return { isError: true, content: [{ type: "text" as const,
          text: `${model.id} does not have a verified provider-native search route through OpenCode Go. Select a Responses-backed Go model or a Codex model explicitly; no fallback was used.` }] };
      }
      const sessionId = await api.commit(async tx => (await tx.doc(ProviderDoc, api.conversationId)).sessionId, context);
      // Record before dispatch so interruption cannot silently erase unknown usage.
      await api.commit(async tx => { (await tx.doc(SearchUsage, api.conversationId)).callsWithUnknownUsage++; }, context);
      const pluginContext = { model, modelRegistry: {
        find: registry.find.bind(registry), getAvailable: registry.getAvailable.bind(registry),
        getApiKeyAndHeaders: async (model: Parameters<ModelRegistry["getApiKeyAndHeaders"]>[0]) => {
          const auth = await registry.getApiKeyAndHeaders(model);
          return auth.ok ? { ...auth, headers: auth.headers && Object.fromEntries(Object.entries(auth.headers).filter(([, value]) => value !== null)) } : auth;
        },
      }, sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
      let previous = "";
      const result = await webSearch(api.callId, args as { query: string; urls?: string[] }, context.abortSignal ?? new AbortController().signal,
        update => {
          const text = update.content.filter(p => p.type === "text").map(p => p.text).join("\n");
          api.output(text.startsWith(previous) ? text.slice(previous.length) : "\n" + text); previous = text;
        },
        pluginContext, agent.thinkingLevel);
      const normalized = JSON.parse(JSON.stringify(result)) as typeof result;
      if (normalized.details?.error) return { ...normalized, isError: true };
      // The plugin does not report search-request usage. Do not present it as zero.
      return normalized;
    },
  });
  return { extension: defineExtension({ name: "web-search", tools: [tool] }), tool };
}
