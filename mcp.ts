import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { McpClient, StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import wasmFile from "quickjs-wasi/quickjs.wasm" with { type: "file" };

// Compiled `bin/pi-*` binaries embed the codemode worker entrypoint and the
// QuickJS wasm; dev (`bun`) resolves both from node_modules instead. The same
// basename predicate as processes.ts: anything not launched by bun is compiled.
const execName = basename(process.execPath);
const runningCompiled = execName !== "bun" && execName !== "bun-debug";
export const sandboxAssets = {
  wasm: loadQuickJSWasm(wasmFile),
  workerUrl: runningCompiled ? "./codemode-worker.ts" : new URL("./codemode-worker.ts", import.meta.url),
};

export type ServerConfig = { command?: string; args?: string[]; url?: string; headers?: Record<string, string>; enabled?: boolean; cwd?: string };
export type McpConfig = Record<string, ServerConfig>;
const expand = (s: string) => s.replace(/^~(?=\/|$)/, homedir());
export function loadMcp(cwd: string): McpConfig {
  const load = (file: string) => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).mcpServers ?? {} : {};
  return { ...load(join(homedir(), ".pi/agent/mcp.json")), ...load(join(cwd, ".pi/mcp.json")) };
}
export async function connectMcp(cwd: string, configs: McpConfig) {
  const clients: McpClient[] = [];
  const tools: { name: string; description: string; inputSchema: any; client: McpClient; original: string }[] = [];
  const status: Record<string, string> = {};
  await Promise.all(Object.entries(configs).map(async ([name, config]) => {
    if (config.enabled === false) return;
    const client = new McpClient({ name: "pi-harness", version: "0.1.0", roots: [{ uri: pathToFileURL(cwd).href }] });
    clients.push(client);
    try {
      const transport = config.url
        ? new StreamableHttpTransport({ url: config.url, headers: config.headers })
        : new StdioTransport({ command: expand(config.command!), args: config.args?.map(expand), cwd: config.cwd ? expand(config.cwd) : cwd });
      await client.connect(transport);
      const listed = await client.listTools();
      for (const tool of listed) tools.push({ name: `${name}_${tool.name}`.replace(/[^\w]/g, "_"),
        description: tool.description ?? tool.name, inputSchema: tool.inputSchema, client, original: tool.name });
      status[name] = `${listed.length} tools`;
    } catch (error) {
      status[name] = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
      await client.close().catch(() => {});
    }
  }));
  const codemode = defineTool({ name: "codemode",
    description: `Execute JavaScript in a sandbox to call MCP tools. No filesystem, network or process APIs in scripts. Use searchTools("keyword") to discover tool names/descriptions and describeTool("name") for input schemas, then await tools.name(args). Use text(value) or return for output. Namespaces: ${Object.keys(status).join(", ")}. MCP calls execute with the host's authority.`,
    parameters: Type.Object({ code: Type.String() }),
    execute: async ({ code }, api, context) => {
      const sandbox = new CodemodeSandbox({ timeoutMs: 60_000,
        wasm: sandboxAssets.wasm, workerUrl: sandboxAssets.workerUrl,
        globals: [
          { name: "searchTools", execute: async query => tools.filter(t => `${t.name} ${t.description}`.toLowerCase().includes(String(query).toLowerCase())).map(t => ({ name: t.name, description: t.description })) },
          { name: "describeTool", execute: async name => { const tool = tools.find(t => t.name === name); if (!tool) throw new Error("Unknown MCP tool"); return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema }; } },
        ],
        tools: tools.map(tool => ({ name: tool.name, description: tool.description,
          execute: async (args, { signal }) => {
            // Retain actual nested tool intent/outcome without adding huge schemas to model context.
            await api.commit(tx => tx.appendEntry(api.conversationId, { kind: "harness.mcp", data: { tool: tool.name, status: "started" } }), context);
            const result = await tool.client.callTool(tool.original, args as Record<string, unknown>, { signal });
            await api.commit(tx => tx.appendEntry(api.conversationId, { kind: "harness.mcp", data: { tool: tool.name, status: result.isError ? "error" : "completed" } }), context);
            if (result.isError) throw new Error(JSON.stringify(result.content));
            return result.structuredContent ?? result.content;
          } })),
      });
      try {
        const result = await sandbox.execute(code, { signal: context.abortSignal });
        if (!result.ok) throw new Error(result.error.message);
        const content = [...result.output];
        if (result.value !== undefined) content.push({ type: "text", text: JSON.stringify(result.value) });
        return { content };
      } finally { await sandbox.close(); }
    },
  });
  return { extension: defineExtension({ name: "mcp-codemode", tools: [codemode] }), status, tools,
    close: () => Promise.all(clients.map(c => c.close().catch(() => {}))) };
}
