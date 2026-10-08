import { test, expect } from "bun:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { SearchUsage, searchExtension } from "./search.ts";

for (const provider of ["openai-codex", "opencode-go"]) test(`web search uses ${provider}'s native route with stable session identity`, async () => {
  const apiName = provider === "openai-codex" ? "openai-codex-responses" : "openai-responses";
  const model: any = { provider, api: apiName, id: "gpt-6-luna", baseUrl: "https://fixture.invalid/v1", reasoning: true };
  const runtime: any = { getModel: () => model, getAvailableSnapshot: () => [model],
    getAuth: async () => ({ auth: { apiKey: "invalid-fixture-key", headers: { "chatgpt-account-id": "fixture", removed: null } } }) };
  const extension = searchExtension(runtime);
  const requests: { body: any; headers: Headers }[] = [];
  const previousFetch = globalThis.fetch;
  const output: string[] = [];
  globalThis.fetch = (async (_url: any, options: any) => {
    requests.push({ body: JSON.parse(options.body), headers: new Headers(options.headers) });
    return new Response([
      { type: "response.output_item.done", item: { type: "web_search_call", id: "fixture-search", action: { query: "fixture", sources: [{ title: "Fixture", url: "https://example.org" }] } } },
      { type: "response.output_text.delta", delta: "Fixture answer" },
      { type: "response.completed", response: { output: [] } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }) as any;
  let unknownUsage = 0;
  const api: any = { callId: "search-1", conversationId: 1,
    agent: async () => ({ model: { provider, modelId: model.id }, thinkingLevel: "medium" }),
    output: (text: string) => output.push(text),
    commit: async (fn: any) => fn({ doc: async (token: any) => token === SearchUsage
      ? { get callsWithUnknownUsage() { return unknownUsage; }, set callsWithUnknownUsage(value: number) { unknownUsage = value; } }
      : { sessionId: "fixture-session" } }),
  };
  try {
    const result = await extension.tool.execute({ query: "fixture" }, api, ctx);
    expect(result.isError).not.toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].body.tools).toEqual([{ type: "web_search" }]);
    expect(requests[0].body.reasoning).toEqual({ effort: "medium" });
    expect(requests[0].headers.has("removed")).toBe(false);
    if (provider === "opencode-go") expect(requests[0].headers.get("x-opencode-session")).toBe("fixture-session");
    expect(JSON.stringify(result.content)).toContain("Fixture answer");
    expect(unknownUsage).toBe(1);
  } finally { globalThis.fetch = previousFetch; }
});

test("unsupported Go completion search fails before auth or fetch without model fallback", async () => {
  const runtime: any = { getModel: () => ({ provider: "opencode-go", api: "openai-completions", id: "deepseek-v4.1-flash" }),
    getAuth: async () => { throw new Error("No auth request expected"); } };
  const result = await searchExtension(runtime).tool.execute({ query: "fixture" }, {
    agent: async () => ({ model: { provider: "opencode-go", modelId: "deepseek-v4.1-flash" } }),
  } as any, ctx);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("no fallback was used");
});
