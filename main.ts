#!/usr/bin/env bun
// pi-skin-sjdonado: my scheme for running a harness in Pi.
//
// One file, mirroring the upstream Durable sample (the `durable/` coding agent
// and the `vacation/` research pattern in earendil-works/pi): everything the
// harness runs is a task, and subagents are conversations owned by the task
// that started them. This file is the thin scheme on top: session ownership,
// the TUI wiring, and the composed extensions. Log in with pi itself;
// credentials are shared, so there is no login UI here.

// ─── imports ────────────────────────────────────────────────────────────────
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  Harness, createRegistry, defineDoc, defineExtension, defineTask, defineTool, configure, section,
  AssistantEntry, ProviderDoc,
  type Conversation, type ConversationId, type HarnessSettings,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  ModelRuntime, SettingsManager, ModelRegistry,
  getAgentDir, loadProjectContextFiles, loadSkills, formatSkillsForPrompt,
  type AgentToolResult, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext,
  type Skill, type ToolDefinition, type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "typebox";
import {
  CombinedAutocompleteProvider, Container, ProcessTerminal, SelectList, SettingsList, Spacer, Text,
  TuiAltScreen, setKeybindings, truncateToWidth, visibleWidth, type Component, type TUI,
} from "@earendil-works/pi-tui";
import {
  AssistantMessageComponent, CustomEditor, ModelSelectorComponent, ThemeSelectorComponent,
  ThinkingSelectorComponent, ToolExecutionComponent, UserMessageComponent,
  getSelectListTheme, getSettingsListTheme, initTheme,
} from "@earendil-works/pi-coding-agent";
import type { ConversationView, EntryRecord, LiveState, UsageState } from "@earendil-works/pi-durable";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { McpClient, StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";

// ─── native UI seam ─────────────────────────────────────────────────────────
// Version-pinned compatibility seam for upstream UI helpers not exported by
// the SDK root. Cover them with UI tests before changing Pi versions.
import { KeybindingsManager } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { createAllToolRenderers } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/index.js";
import { getAvailableThemes, getEditorTheme, theme } from "./node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { InteractiveThemeController } from "./node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-controller.js";
import { WorkingStatusIndicator } from "./node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/status-indicator.js";
import { formatTokens } from "./node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js";
import { createChatViewport } from "./node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
export {
  KeybindingsManager, createAllToolRenderers, getAvailableThemes, getEditorTheme, theme,
  InteractiveThemeController, WorkingStatusIndicator, formatTokens, createChatViewport,
};

// ─── session ────────────────────────────────────────────────────────────────
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === "EPERM"; }
}

export function sessionRoot(cwd: string, base = join(homedir(), ".pi", "harness")) {
  return join(base, createHash("sha256").update(realpathSync(resolve(cwd))).digest("hex").slice(0, 20));
}
export function listSessions(cwd: string, base?: string) {
  const root = sessionRoot(cwd, base);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(id => /^\d+-[a-f0-9-]+$/.test(id)).sort().reverse().map(id => {
    const dir = join(root, id);
    let title = "New conversation";
    const preview = join(dir, "preview.json");
    if (existsSync(preview)) title = JSON.parse(readFileSync(preview, "utf8")).title;
    return { id, dir, cwd: realpathSync(resolve(cwd)), title, createdAt: Number(id.split("-")[0]) };
  });
}
export function openSession(cwd: string, resume = false, base = join(homedir(), ".pi", "harness"), sessionId?: string) {
  cwd = realpathSync(resolve(cwd));
  const root = sessionRoot(cwd, base);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const latest = readdirSync(root).filter(n => /^\d+-[a-f0-9-]+$/.test(n)).sort().at(-1);
  if (resume && !latest) throw new Error("No scheme session exists for this project yet. Run pss first.");
  if (sessionId && (!/^\d+-[a-f0-9-]+$/.test(sessionId) || !existsSync(join(root, sessionId)))) throw new Error("Session ID is not valid for this project");
  const id = sessionId ?? (resume ? latest! : `${Date.now()}-${randomUUID()}`);
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, "lock");
  if (existsSync(lock)) {
    const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
    if (alive(owner.pid)) throw new Error(`Session is owned by live process ${owner.pid}`);
    rmSync(lock, { recursive: true });
  }
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  writeFileSync(join(dir, "project.json"), JSON.stringify({ cwd }), { mode: 0o600 });
  return { id, cwd, dir, release: () => rmSync(lock, { recursive: true, force: true }) };
}

// ─── prompt/skills ──────────────────────────────────────────────────────────
export function promptExtension(cwd: string) {
  const agentDir = getAgentDir();
  const skillPaths = [join(homedir(), ".agents/skills")];
  for (let dir = cwd; ; dir = dirname(dir)) {
    const path = join(dir, ".agents/skills");
    if (existsSync(path)) skillPaths.push(path);
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir || dir === homedir()) break;
  }
  const skills = loadSkills({ cwd, agentDir, includeDefaults: true, skillPaths });
  const files = loadProjectContextFiles({ cwd, agentDir });
  return { skills: skills.skills, files,
    extension: defineExtension({ name: "instructions", sections: [
      section("role", () => "You are Pi, a general-purpose interactive coding harness. Work in the current project, investigate before editing, use the project's checks, and complete the user's requested scope. Read applicable nested project instructions before edits. Load a relevant skill by reading its SKILL.md. Do not read environment-secret files. Do not commit, push or publish without user authorization. Use foreground bash for finite work and the background tool for work that should outlive this turn. Subagents have fresh contexts: give each the task and authoritative file paths, not hidden conversation assumptions."),
      section("project_context", () => files.map(f => `File: ${f.path}\n${f.content}`).join("\n\n")),
      section("skills", () => formatSkillsForPrompt(skills.skills)),
      section("cwd", () => cwd),
    ] }) };
}

// ─── providers ──────────────────────────────────────────────────────────────
export async function useOpenCodeGo(models: Pick<ModelRuntime, "hasConfiguredAuth" | "setRuntimeApiKey">,
  file = join(homedir(), ".local/share/opencode/auth.json")): Promise<boolean> {
  if (models.hasConfiguredAuth("opencode-go")) return true;
  if (!existsSync(file)) return false;
  // Opaque, in-memory handoff to the model runtime. Never copy or print credentials.
  const entry = JSON.parse(readFileSync(file, "utf8"))["opencode-go"];
  if (entry?.type !== "api" || typeof entry.key !== "string" || !entry.key) return false;
  await models.setRuntimeApiKey("opencode-go", entry.key);
  return true;
}

export function modelChoices(models: Pick<ModelRuntime, "getAvailableSnapshot">) {
  return [...models.getAvailableSnapshot()];
}

export function modelReference(input: string, models: readonly Model<any>[]) {
  const match = models.find(m => `${m.provider}/${m.id}` === input) ??
    models.find(m => m.provider === "openai-codex" && m.id === input);
  if (!match) throw new Error("Model is not available for a configured provider. Use /model.");
  return { provider: match.provider, modelId: match.id };
}

// ─── search ─────────────────────────────────────────────────────────────────
// The source-only package targets older header types. Keep its compatibility boundary
// typed locally and normalize nullable Pi 1.1 headers instead of modifying package files.
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

// ─── mcp ────────────────────────────────────────────────────────────────────
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

// ─── subagents ──────────────────────────────────────────────────────────────
// Foreground delegation plus the sample's background pattern: a background task
// owns the child conversation and posts its report back to the main
// conversation as a follow-up message, so the main run stays free.
function resolveChildModel(parent: { provider?: string; modelId?: string } | undefined, requested: string | undefined,
  known: (provider: string, modelId: string) => unknown) {
  const fallback = parent?.provider === "openai-codex" ? { provider: "openai-codex", modelId: "gpt-6-luna" } : parent;
  const [provider, ...parts] = requested?.split("/") ?? [];
  const selected = requested === "inherit" ? parent : requested
    ? parts.length ? { provider, modelId: parts.join("/") } : { provider: "openai-codex", modelId: requested }
    : fallback;
  if (!selected?.provider || !selected?.modelId || !known(selected.provider, selected.modelId))
    throw new Error("Subagent model is not in the configured catalog");
  return selected as { provider: string; modelId: string };
}

async function answerText(entry: EntryRecord | undefined): Promise<string> {
  const message = entry?.model?.[0];
  return message?.role === "assistant" ? message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") : "";
}

const subagent = defineTool({ name: "subagent", replay: "safe",
  description: "Delegate a bounded task to a fresh Durable child conversation. Supply authoritative file paths and acceptance checks. Parent cancellation aborts child work. Returns the child's answer; no automatic model fallback or recursive delegation.",
  parameters: Type.Object({ task: Type.String(), model: Type.Optional(Type.String({ description: "Configured provider/model, a bare Codex model ID, or inherit. Defaults to Luna for Codex parents and the current model for Go parents." })) }),
  execute: async (args, api, context) => {
    const parent = await api.agent(context);
    const selected = resolveChildModel(parent.model, args.model, (p, m) => api.models.getModel(p, m));
    const childId = await api.commit(async tx => {
      const old = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
      if (old) return old.id;
      const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
      await configure(tx, child.id, { model: selected, thinkingLevel: "medium", tools: { remove: [subagent, background] } });
      return child.id;
    }, context);
    await api.details({ conversationId: childId }, context);
    const child = (await api.conversation(childId, context))!;
    const result = await (await child.submit({ type: "input", content: args.task, requestId: `subagent:${api.taskId}` }, context)).wait(context);
    if (result.status !== "done" || result.type !== "input") throw new Error(`Child did not answer: ${result.status}`);
    const entry = await api.commit(tx => tx.entry(result.answer), context);
    return { content: [{ type: "text" as const, text: await answerText(entry) }], details: { conversationId: childId } };
  },
});

type BackgroundState = { phase: "deliver" } | { phase: "report"; report: string };

const BackgroundWork = defineTask<{ task: string; model: { provider: string; modelId: string } }, BackgroundState, null>({
  name: "skin.background",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: async (task, runtime, context) => {
      // The child conversation is owned by this task. A rerun after a crash finds it again.
      let owned: ConversationId | undefined;
      await runtime.commit(async tx => {
        owned = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0]?.id;
        return undefined;
      }, context);
      const child = await runtime.conversation(owned!, context);
      // A rerun after a crash gets the same submission back.
      const settled = await (await child!.submit(
        { type: "input", content: task.input.task, requestId: `background:${task.id}` }, context)).wait(context);
      await runtime.commit(async tx => {
        let report = `[background report] The background work failed: ${settled.status === "unanswered" ? (settled as any).reason : "?"}`;
        if (settled.status === "done" && settled.type === "input")
          report = `[background report] ${await answerText(await tx.entry(AssistantEntry, settled.answer))}`;
        return { status: "running", checkpoint: { phase: "report", report } };
      }, context);
    },
    report: async (task, runtime, context) => {
      const main = await runtime.conversation(runtime.conversationId, context);
      await main!.submit({ type: "input", content: task.state.checkpoint.report, whenBusy: "followUp", requestId: `background-report:${task.id}` }, context);
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

const background = defineTool({ name: "background",
  description: "Start bounded work in the background: a child conversation works while the main conversation stays free, and its report arrives later as a message starting with [background report]. Aborting this call aborts the child.",
  parameters: Type.Object({ task: Type.String({ description: "What the background worker should do, with file paths and acceptance checks" }),
    model: Type.Optional(Type.String({ description: "Configured provider/model, a bare Codex model ID, or inherit. Same defaults as subagent." })) }),
  execute: async (args, api, context) => {
    const parent = await api.agent(context);
    const selected = resolveChildModel(parent.model, args.model, (p, m) => api.models.getModel(p, m));
    const owner = await api.commit(async tx => {
      const owner = await tx.createTask(BackgroundWork, { task: args.task, model: selected },
        { ownership: { kind: "conversation" }, background: true });
      const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
      await configure(tx, child.id, { model: selected, thinkingLevel: "medium", tools: { remove: [subagent, background] } });
      return owner;
    }, context);
    await api.details({ conversationId: (await api.commit(async tx =>
      (await tx.scanConversations({ ownerTaskId: owner }, 1)).items[0]?.id, context))! }, context);
    return { content: [{ type: "text" as const, text: "Background work started; its report will arrive as a message." }] };
  },
});

export function subagentExtension() {
  return defineExtension({ name: "subagents", tools: [subagent, background], tasks: [BackgroundWork] });
}

// ─── side ───────────────────────────────────────────────────────────────────
export const Side = defineDoc<{ parent: number | null; boundary: number; closed: boolean }>({
  kind: "harness.side", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ parent: null, boundary: 0, closed: false }),
});
export const SIDE_BOUNDARY = "Side conversation boundary: inherited history is reference context only, not your current task. Answer only the question submitted after this boundary. Do not continue the parent's plans, tool calls, approvals or work. This is lightweight non-mutating exploration: do not edit files, execute shell commands, manage processes, publish, or delegate. The main conversation continues independently. Side answers are not appended to it.";

export async function forkSide(harness: Harness, parent: Conversation, tools: readonly any[]) {
  const last = (await parent.entries({}, 1, undefined, ctx)).items[0];
  const init = async (tx: any, id: any) => {
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

// ─── transcript ─────────────────────────────────────────────────────────────
export class DurableTranscript extends Container {
  private ids: number[] = [];
  private cards: ToolExecutionComponent[] = [];
  private latest = new Map<string, ToolExecutionComponent>();
  private streaming?: AssistantMessageComponent;
  private streamingCalls = new Set<string>();
  private expanded = false;
  private renderers: Record<string, any> = { ...createAllToolRenderers(), web_search: searchRenderer };
  constructor(private ui: TUI, private cwd: string, private hideThinking = false) { super(); }

  setExpanded(expanded: boolean) {
    this.expanded = expanded;
    for (const card of this.cards) card.setExpanded(expanded);
    this.ui.requestRender();
  }
  setHideThinking(hidden: boolean) { this.hideThinking = hidden; this.reset(); }
  private card(name: string, id: string, args?: unknown, fresh = false) {
    let card = fresh ? undefined : this.latest.get(id);
    if (!card) {
      card = new ToolExecutionComponent(name, id, args ?? {}, {}, this.renderers[name], this.ui, this.cwd);
      card.setExpanded(this.expanded); this.latest.set(id, card); this.cards.push(card); this.addChild(card);
    } else if (args !== undefined) card.updateArgs(args);
    return card;
  }
  private add(entry: EntryRecord) {
    const message = entry.model?.[0];
    if (!message) return;
    if (message.role === "user" && entry.kind === "pi.user") {
      const text = typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      // Match InteractiveMode.addMessageToChat: user turns have one leading gap
      // after existing content; the native message itself supplies its gray padding.
      if (this.children.length > 0) this.addChild(new Spacer(1));
      this.addChild(new UserMessageComponent(text));
    } else if (message.role === "assistant") {
      const answer = this.streaming ?? new AssistantMessageComponent(undefined, this.hideThinking);
      if (!this.streaming) this.addChild(answer);
      this.streaming = undefined; answer.updateContent(message, false);
      for (const call of message.content.filter(c => c.type === "toolCall")) {
        if (message.stopReason !== "toolUse" && !this.streamingCalls.has(call.id)) continue;
        const card = this.card(call.name, call.id, call.arguments, !this.streamingCalls.has(call.id));
        card.setArgsComplete();
        if (message.stopReason !== "toolUse") card.updateResult({ content: [{ type: "text", text: "Not run: response interrupted." }], isError: true });
      }
      this.streamingCalls.clear();
    } else if (message.role === "toolResult") {
      const result = message as ToolResultMessage;
      this.card(result.toolName, result.toolCallId).updateResult(result);
    } else if (entry.kind === "pi.compaction") {
      this.addChild(new Text(theme.fg("muted", "[Earlier context summarized]"), 1, 0));
    }
    // Instruction/system entries remain in model history, not as phantom tool cards.
  }
  apply(view: ConversationView) {
    const side = view.docs["harness.side"] as { parent?: number; boundary?: number } | undefined;
    if (side?.parent) view = { ...view, entries: view.entries.filter(e => e.id > (side.boundary ?? 0)) };
    const live = (view.docs["pi.live"] ?? {}) as LiveState;
    if (this.ids.some((id, index) => view.entries[index]?.id !== id)) this.reset();
    if (!live.generation?.message && this.streaming && view.entries.length === this.ids.length) this.reset();
    for (const entry of view.entries.slice(this.ids.length)) { this.add(entry); this.ids.push(entry.id); }
    const partial = live.generation?.message as AssistantMessage | undefined;
    if (partial) {
      if (!this.streaming) { this.streaming = new AssistantMessageComponent(undefined, this.hideThinking); this.addChild(this.streaming); }
      this.streaming.updateContent(partial, true);
      for (const call of partial.content.filter(c => c.type === "toolCall")) {
        this.card(call.name, call.id, call.arguments, !this.streamingCalls.has(call.id)); this.streamingCalls.add(call.id);
      }
    }
    for (const slot of live.tools ?? []) {
      const card = this.latest.get(slot.callId);
      if (!card || slot.status !== "running") continue;
      card.markExecutionStarted();
      if (slot.output) card.updateResult({ content: [{ type: "text", text: slot.output }], details: slot.details, isError: false }, true);
    }
  }
  reset() {
    // Native tool renderers own timers while running; finalize before dropping them.
    for (const card of this.cards) card.updateResult({ content: [], isError: false }, false);
    this.cards = []; this.latest.clear(); this.ids = []; this.streamingCalls.clear(); this.streaming = undefined; this.clear();
  }
}

// ─── footer ─────────────────────────────────────────────────────────────────
export class DurableFooter implements Component {
  view?: ConversationView;
  running = 0;
  contextWindow = 0;
  autoCompact = true;
  side = false;
  constructor(private cwd: string, private branch: string) {}
  invalidate() {}
  render(width: number): string[] {
    const agent = this.view?.docs["pi.agent"] as any;
    const usage = this.view?.docs["pi.usage"] as UsageState | undefined;
    const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const item of Object.values(usage?.models ?? {})) {
      total.input += item.input; total.output += item.output; total.cacheRead += item.cacheRead;
      total.cacheWrite += item.cacheWrite; total.cost += item.cost.total;
    }
    const last = this.view?.entries.flatMap(e => e.model ?? []).filter(m => m.role === "assistant").at(-1);
    const tokens = last?.role === "assistant" ? last.usage.totalTokens : undefined;
    const context = this.contextWindow ? ` ${tokens === undefined ? "?" : ((tokens / this.contextWindow) * 100).toFixed(1)}%/${formatTokens(this.contextWindow)} (${this.autoCompact ? "auto" : "manual"})` : "";
    const left = `↑${formatTokens(total.input)} ↓${formatTokens(total.output)} R${formatTokens(total.cacheRead)}${total.cacheWrite ? ` W${formatTokens(total.cacheWrite)}` : ""} $${total.cost.toFixed(3)}${agent?.model?.provider === "openai-codex" ? " (sub)" : ""}${context}`;
    const right = `${agent?.model?.modelId ?? "no model"} · ${agent?.thinkingLevel ?? "medium"}`;
    const available = Math.max(0, width - visibleWidth(right) - 1);
    const trimmed = truncateToWidth(left, available);
    const lines = [
      theme.fg("dim", truncateToWidth(`${this.cwd}${this.branch ? ` (${this.branch})` : ""}`, width)),
      theme.fg("dim", truncateToWidth(trimmed + " ".repeat(Math.max(1, width - visibleWidth(trimmed) - visibleWidth(right))) + right, width)),
    ];
    if (this.running) lines.push(theme.fg("accent", `${this.running} background task${this.running === 1 ? "" : "s"} · /tasks to view`));
    if (this.side) lines.push(theme.fg("accent", "Side conversation · main continues · /back or Ctrl+C to return"));
    const search = this.view?.docs["harness.search-usage"] as { callsWithUnknownUsage?: number } | undefined;
    if (search?.callsWithUnknownUsage) lines.push(theme.fg("dim", "Web search usage unavailable; cost/token totals exclude those requests"));
    return lines;
  }
}

// ─── slash commands ─────────────────────────────────────────────────────────
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const choices = (values: readonly string[]) => (prefix: string) => values.filter(v => v.startsWith(prefix)).map(v => ({ value: v, label: v }));

export function slashCommands(skills: Skill[], models: readonly string[] = []): any[] {
  return [
    { name: "settings", description: "Open scheme settings" },
    { name: "model", description: "Select provider/model", argumentHint: "[provider/model]", getArgumentCompletions: choices(models) },
    { name: "thinking", description: "Select thinking level", argumentHint: "[level]", getArgumentCompletions: choices(THINKING_LEVELS) },
    { name: "theme", description: "Select terminal theme" },
    { name: "resume", description: "Resume a saved project conversation" },
    { name: "btw", description: "Ask a side question with parent history as reference", argumentHint: "[question]" },
    { name: "back", description: "Close side conversation and return to main" },
    { name: "agents", description: "Switch conversations", argumentHint: "[id]" },
    { name: "tasks", description: "List background tasks" },
    { name: "compact", description: "Compact this conversation", argumentHint: "[instructions]" },
    { name: "help", description: "Show commands and shortcuts" },
    { name: "quit", description: "Exit the scheme" },
    ...skills.map(skill => ({ name: `skill:${skill.name}`, description: skill.description, argumentHint: "[task]" })),
  ];
}

// ─── host ───────────────────────────────────────────────────────────────────
export async function openHost(options: { cwd: string; resume?: boolean; sessionId?: string; noMcp?: boolean; stateDir?: string }) {
  const session = openSession(options.cwd, options.resume, options.stateDir, options.sessionId);
  const environments = new Map<string, NodeExecutionEnv>();
  let root: Conversation | undefined;
  let closing = false;
  const notices: string[] = [];
  let harness: Harness | undefined;
  let mcp: Awaited<ReturnType<typeof connectMcp>> | undefined;
  try {
    const models = await ModelRuntime.create();
    await useOpenCodeGo(models);
    const settings = SettingsManager.create(session.cwd);
    const prompt = promptExtension(session.cwd);
    const registry = createRegistry();
    registry.install(CodingTools); registry.install(prompt.extension);
    registry.install(subagentExtension());
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
    // Side conversations are ephemeral work, not automatic resume targets.
    for (const record of (await opened.commit(tx => tx.scanConversations({}, 1000), ctx)).items) {
      const side = await opened.snapshot(Side, record.id, ctx);
      if (side?.parent !== undefined && side.parent !== null && !side.closed) await closeSide(opened, (await opened.conversation(record.id, ctx))!);
    }
    return {
      session, harness: opened, models, registry, settings, prompt, notices, mcp: clients,
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
      async backgroundTasks() {
        const tasks = (await opened.commit(tx => tx.scanTasks({ background: true }, 100), ctx)).items;
        const live = tasks.filter(t => t.state.status !== "terminal");
        const out = [];
        for (const task of live) {
          const owned = await opened.commit(tx => tx.scanConversations({ ownerTaskId: task.id }, 1), ctx);
          out.push({ task, conversationId: owned.items[0]?.id as number | undefined });
        }
        return out;
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
        if (id === shown.id) return;
        const next = await opened.conversation(id as any, ctx);
        if (!next) throw new Error("Conversation not found");
        if (sideParent) { await closeSide(opened, shown); sideParent = undefined; }
        shown = next;
      },
      async abort() { await shown.abort(ctx); },
      resume() { opened.resume(); },
      async close() {
        if (closing) return; closing = true;
        try {
          if (sideParent) await closeSide(opened, shown);
          await opened.close(ctx);
          await Promise.all([...environments.values()].map(env => env.cleanup(ctx)));
          await clients.close();
        } finally { session.release(); }
      },
    };
  } catch (error) {
    closing = true;
    await harness?.close(ctx); await mcp?.close();
    session.release(); throw error;
  }
}
export type Host = Awaited<ReturnType<typeof openHost>>;

// ─── tui ────────────────────────────────────────────────────────────────────
export async function runTui(host: Host) {
  let nextSession: string | undefined;
  initTheme();
  const tui = new TuiAltScreen(new ProcessTerminal());
  const chat = new DurableTranscript(tui, host.session.cwd, host.settings.getHideThinkingBlock());
  const notices = new Container();
  const branch = Bun.spawnSync(["git", "branch", "--show-current"], { cwd: host.session.cwd, stderr: "ignore" }).stdout.toString().trim();
  const footer = new DurableFooter(host.session.cwd, branch);
  const editorArea = new Container();
  const keys = KeybindingsManager.create(); setKeybindings(keys);
  const editor = new CustomEditor(tui, getEditorTheme(), keys, { paddingX: host.settings.getEditorPaddingX(), embedWorkingStatus: true });
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands(host.prompt.skills, modelChoices(host.models).map(m => `${m.provider}/${m.id}`)), host.session.cwd));
  editorArea.addChild(editor);
  let selector: (Component & { dispose?: () => void }) | undefined;
  let exit!: () => void;
  const done = new Promise<void>(resolve => exit = resolve);
  let unsubscribe = () => {};
  let mounted: Awaited<ReturnType<typeof host.conversation.viewState>> | undefined;
  let indicator: WorkingStatusIndicator | undefined;
  let lastStatus = "";
  let expanded = false;
  const note = (message: string) => { host.notices.push(message); render(); };
  function render() {
    const view = mounted?.value;
    if (view) chat.apply(view);
    const live = view?.docs["pi.live"] as any;
    notices.clear();
    for (const notice of host.notices.slice(-3)) notices.addChild(new Text(theme.fg("muted", notice), 1, 0));
    const agent = view?.docs["pi.agent"] as any;
    editor.borderColor = theme.getThinkingBorderColor(agent?.thinkingLevel ?? "medium");
    const tool = live?.tools?.find((slot: any) => slot.status === "running");
    const status = live?.compactions?.length ? "Compacting..." : tool ? `Running ${tool.name}... (esc to abort)` : live?.run ? "Working... (esc to abort)" : "";
    if (status !== lastStatus) {
      lastStatus = status; indicator?.dispose();
      indicator = status ? new WorkingStatusIndicator(tui, status, undefined, editor.borderColor) : undefined;
      editor.setWorkingStatusIndicator(indicator);
    }
    footer.view = view; footer.running = bgCount;
    footer.contextWindow = agent?.model ? host.models.getModel(agent.model.provider, agent.model.modelId)?.contextWindow ?? 0 : 0;
    footer.autoCompact = host.settings.getCompactionEnabled();
    footer.side = host.sideParentId !== undefined;
    tui.requestRender();
  }
  let bgCount = 0;
  async function mount() {
    unsubscribe(); mounted?.dispose(); chat.reset(); mounted = await host.conversation.viewState(ctx);
    unsubscribe = mounted.subscribe(render); render();
  }
  function restoreEditor() {
    selector?.dispose?.(); selector = undefined;
    editorArea.clear(); editorArea.addChild(editor); tui.setFocus(editor); tui.requestRender();
  }
  function showSelector(component: Component & { dispose?: () => void }, focus: Component = component) {
    selector?.dispose?.(); selector = component;
    editorArea.clear(); editorArea.addChild(component); tui.setFocus(focus); tui.requestRender();
  }
  async function selectModel() {
    const agent = await host.conversation.agent(ctx);
    const current = agent.model && host.models.getModel(agent.model.provider, agent.model.modelId);
    const scoped = modelChoices(host.models).map(model => ({ model }));
    showSelector(new ModelSelectorComponent(tui, current, host.models, scoped,
      model => {
        restoreEditor();
        void host.conversation.configure({ model: { provider: model.provider, modelId: model.id } }, ctx).catch(error => note(String(error)));
      }, restoreEditor, undefined,
      model => {
        host.settings.setDefaultModelAndProvider(model.provider, model.id); restoreEditor();
        void host.conversation.configure({ model: { provider: model.provider, modelId: model.id } }, ctx).catch(error => note(String(error)));
      }, { provider: host.settings.getDefaultProvider() ?? "openai-codex", id: host.settings.getDefaultModel() ?? "gpt-6-luna" }));
  }
  async function selectThinking() {
    const agent = await host.conversation.agent(ctx);
    const model = agent.model && host.models.getModel(agent.model.provider, agent.model.modelId);
    showSelector(new ThinkingSelectorComponent(agent.thinkingLevel, model ? getSupportedThinkingLevels(model) : [...THINKING_LEVELS],
      level => { restoreEditor(); void host.conversation.configure({ thinkingLevel: level }, ctx).catch(error => note(String(error))); }, restoreEditor,
      level => {
        if (agent.model) host.settings.setModelThinkingLevel(agent.model.provider, agent.model.modelId, level);
        restoreEditor(); void host.conversation.configure({ thinkingLevel: level }, ctx).catch(error => note(String(error)));
      }, agent.model ? host.settings.getModelThinkingLevel(agent.model.provider, agent.model.modelId) ?? host.settings.getDefaultThinkingLevel() : undefined));
  }
  async function selectSettings() {
    const agent = await host.conversation.agent(ctx);
    const list = new SettingsList([
      { id: "model", label: "Model", currentValue: `${agent.model?.provider}/${agent.model?.modelId}`, values: modelChoices(host.models).map(m => `${m.provider}/${m.id}`) },
      { id: "thinking", label: "Thinking level", currentValue: agent.thinkingLevel, values: [...THINKING_LEVELS] },
      { id: "hideThinking", label: "Hide thinking", currentValue: String(host.settings.getHideThinkingBlock()), values: ["false", "true"] },
      { id: "compaction", label: "Auto-compaction", currentValue: String(host.settings.getCompactionEnabled()), values: ["true", "false"] },
      { id: "autocomplete", label: "Command suggestions", currentValue: String(host.settings.getAutocompleteMaxVisible()), values: ["5", "10", "15"] },
      { id: "theme", label: "Theme", currentValue: host.settings.getTheme() ?? "system", values: getAvailableThemes() },
    ], 10, getSettingsListTheme(), (id, value) => {
      if (id === "model" || id === "thinking") void command(`/${id} ${value}`).catch(error => note(String(error)));
      if (id === "hideThinking") { host.settings.setHideThinkingBlock(value === "true"); chat.setHideThinking(value === "true"); render(); }
      if (id === "compaction") host.settings.setCompactionEnabled(value === "true");
      if (id === "autocomplete") { host.settings.setAutocompleteMaxVisible(Number(value)); editor.setAutocompleteMaxVisible(Number(value)); }
      if (id === "theme") { host.settings.setTheme(value); themes.applyFromSettings(); }
    }, restoreEditor);
    showSelector(list);
  }
  async function command(text: string, whenBusy: "steer" | "followUp" = "steer") {
    const [name, ...rest] = text.split(/\s+/); const arg = rest.join(" ");
    if (name === "/quit") return exit();
    if (name === "/resume") {
      const sessions = host.sessions();
      const list = new SelectList(sessions.map(s => ({ value: s.id, label: s.title, description: `${new Date(s.createdAt).toLocaleString()}${s.id === host.session.id ? " (current)" : ""}` })), 10, getSelectListTheme());
      list.onSelect = item => { restoreEditor(); if (item.value !== host.session.id) { nextSession = item.value; exit(); } };
      list.onCancel = restoreEditor; showSelector(list); return;
    }
    if (name === "/btw") {
      const submission = await host.btw(arg || undefined); await mount();
      if (submission) void submission.wait(ctx).then(result => { if (result.status !== "done") note(`Side question ended: ${result.status}`); }).catch(error => note(String(error)));
      return;
    }
    if (name === "/back") { await host.back(); await mount(); return; }
    if (name === "/settings") return selectSettings();
    if (name === "/theme") {
      const picker = new ThemeSelectorComponent(host.settings.getTheme() ?? "system",
        name => { host.settings.setTheme(name); restoreEditor(); themes.applyFromSettings(); },
        () => { restoreEditor(); themes.applyFromSettings(); }, name => themes.preview(name));
      showSelector(picker, picker.getSelectList()); return;
    }
    if (name === "/model") {
      if (!arg) return selectModel();
      await host.conversation.configure({ model: modelReference(arg, modelChoices(host.models)) }, ctx); return;
    }
    if (name === "/thinking") {
      if (!arg) return selectThinking();
      if (!(THINKING_LEVELS as readonly string[]).includes(arg)) throw new Error(`Choose ${THINKING_LEVELS.join(", ")}`);
      await host.conversation.configure({ thinkingLevel: arg as any }, ctx); return;
    }
    if (name === "/agents") {
      if (arg) { await host.switchConversation(Number(arg)); await mount(); }
      else {
        const agents = await host.conversations();
        const list = new SelectList(agents.map(c => ({ value: String(c.id), label: c.label, description: `Conversation ${c.id}` })), 8, getSelectListTheme());
        list.onSelect = item => { restoreEditor(); void host.switchConversation(Number(item.value)).then(mount).catch(error => note(String(error))); };
        list.onCancel = restoreEditor; showSelector(list);
      }
      return;
    }
    if (name === "/tasks") {
      const tasks = await host.backgroundTasks();
      if (!tasks.length) { note("No background tasks."); return; }
      const list = new SelectList(tasks.map(t => ({
        value: String(t.conversationId ?? t.task.id),
        label: String((t.task.input as any)?.task ?? t.task.kind).slice(0, 80),
        description: `${t.task.kind} · ${t.task.state.status}${t.conversationId ? ` · conversation ${t.conversationId}` : ""}`,
      })), 8, getSelectListTheme());
      list.onSelect = item => {
        restoreEditor();
        const id = Number(item.value);
        if (Number.isSafeInteger(id)) void host.switchConversation(id).then(mount).catch(error => note(String(error)));
        else note("That task has no conversation yet.");
      };
      list.onCancel = restoreEditor; showSelector(list); return;
    }
    if (name === "/compact") { await host.conversation.compact(arg || undefined, ctx); return; }
    if (name === "/help") return note("/settings /model /thinking /theme /resume /btw /back /agents /tasks /compact /quit. Ctrl+L selects model; Ctrl+P cycles models; Shift+Tab cycles thinking; Ctrl+O expands tools. Esc closes a picker or aborts; Ctrl+C clears (press twice while empty to exit).");
    if (name.startsWith("/skill:")) {
      const skill = host.prompt.skills.find(s => s.name === name.slice(7));
      if (!skill) throw new Error("Unknown skill");
      text = `${readFileSync(skill.filePath, "utf8")}\n\nSkill location: ${skill.filePath}\n\n${arg}`;
    } else
    if (name.startsWith("/")) throw new Error("Unknown command; use /help");
    const submitted = await host.submit(text, whenBusy);
    void submitted.wait(ctx).then(result => { if (result.status !== "done") note(`Run ended: ${JSON.stringify(result)}`); }).catch(error => note(String(error)));
  }
  editor.onSubmit = text => {
    if (!text.trim()) return;
    editor.addToHistory(text); editor.setText("");
    void command(text.trim()).catch(error => note(String(error)));
  };
  editor.onEscape = () => { void host.abort().catch(error => note(String(error))); };
  editor.onCtrlD = exit;
  let lastClear = 0;
  editor.onAction("app.clear", () => {
    if (editor.getText()) { editor.setText(""); return; }
    if (host.sideParentId !== undefined) { void host.back().then(mount).catch(error => note(String(error))); return; }
    if (Date.now() - lastClear < 1000) return exit();
    lastClear = Date.now(); note("Press Ctrl+C again to exit, or /quit.");
  });
  editor.onAction("app.model.select", () => void selectModel().catch(error => note(String(error))));
  const cycleModel = (direction: number) => void host.conversation.agent(ctx).then(agent => {
    const models = modelChoices(host.models); if (!models.length) throw new Error("No configured models");
    const current = models.findIndex(m => m.provider === agent.model?.provider && m.id === agent.model.modelId);
    const next = models[(current + direction + models.length) % models.length];
    return host.conversation.configure({ model: { provider: next.provider, modelId: next.id } }, ctx);
  }).catch(error => note(String(error)));
  editor.onAction("app.model.cycleForward", () => cycleModel(1));
  editor.onAction("app.model.cycleBackward", () => cycleModel(-1));
  editor.onAction("app.thinking.cycle", () => void host.conversation.agent(ctx).then(agent => host.conversation.configure({ thinkingLevel: THINKING_LEVELS[(THINKING_LEVELS.indexOf(agent.thinkingLevel as any) + 1) % THINKING_LEVELS.length] }, ctx)).catch(error => note(String(error))));
  editor.onAction("app.tools.expand", () => { expanded = !expanded; chat.setExpanded(expanded); });
  editor.onAction("app.thinking.toggle", () => { const hidden = !host.settings.getHideThinkingBlock(); host.settings.setHideThinkingBlock(hidden); chat.setHideThinking(hidden); render(); });
  editor.onAction("app.message.followUp", () => { const text = editor.getText(); if (text.trim()) { editor.setText(""); void command(text, "followUp").catch(error => note(String(error))); } });
  editor.onAction("app.editor.external", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-editor-")), file = join(dir, "prompt.txt");
    writeFileSync(file, editor.getText(), { mode: 0o600 });
    tui.stop();
    try {
      const quoted = `'${file.replaceAll("'", "'\\''")}'`;
      const result = spawnSync(`${host.settings.getExternalEditorCommand()} ${quoted}`, { shell: "/bin/sh", stdio: "inherit", cwd: host.session.cwd });
      if (result.status !== 0) throw new Error("External editor failed");
      editor.setText(readFileSync(file, "utf8"));
    } catch (error) { note(String(error)); }
    finally { rmSync(dir, { recursive: true, force: true }); tui.start(); themes.rebindTui(); tui.requestRender(true); }
  });
  tui.addChild(chat); tui.addChild(notices); tui.addChild(editorArea); tui.addChild(footer); tui.setFocus(editor);
  // Reuse the upstream viewport/dock instead of approximating its spacing.
  const viewport = createChatViewport({ document: chat, pendingMessages: new Container(),
    status: notices, widgetsAbove: new Spacer(1), editor: editorArea, footer,
    scrollbar: host.settings.getFullscreenScrollbar(),
    scrollbarTrackStyle: text => theme.fg("scrollbarTrack", text),
    scrollbarThumbStyle: text => theme.fg("scrollbarThumb", text) });
  tui.setLayoutRoot(viewport.root);
  await mount(); tui.start();
  const themes = new InteractiveThemeController(tui, { getSettingsManager: () => host.settings,
    showError: note, onChanged: () => { chat.invalidate(); render(); } });
  themes.applyFromSettings();
  const refreshBg = () => host.backgroundTasks()
    .then(tasks => { bgCount = tasks.length; footer.running = bgCount; render(); }).catch(() => {});
  const clock = setInterval(() => { render(); void refreshBg(); }, 1000);
  try { await done; } finally { clearInterval(clock); selector?.dispose?.(); indicator?.dispose(); themes.dispose(); chat.reset(); unsubscribe(); mounted?.dispose(); tui.stop(); }
  return nextSession;
}

// ─── cli ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

async function cli() {
  const allowed = new Set(["--continue", "-c", "--check", "--no-mcp", "--help", "-h"]);
  let selected: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session") { selected = args[++i]; if (!selected) throw new Error("--session needs an ID"); continue; }
    if (!allowed.has(args[i])) throw new Error(`Unknown option ${args[i]}; use --help`);
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log("pi-skin-sjdonado (pss)\n\npss [--continue | --session ID] [--no-mcp]\npss --check [--no-mcp]   startup/resource checks, no model calls\npi-agent                upstream standalone CLI\n\nCommands: /settings /model /thinking /theme /resume /btw /back /agents /tasks /compact /quit");
  } else {
    while (true) {
    const inspectOnly = args.includes("--check");
    const checkDir = inspectOnly ? mkdtempSync(join(tmpdir(), "pi-startup-check-")) : undefined;
    const host = await openHost({ cwd: process.cwd(), resume: !checkDir && !selected && (args.includes("--continue") || args.includes("-c")),
      sessionId: checkDir ? undefined : selected, noMcp: args.includes("--no-mcp"), stateDir: checkDir ?? process.env.PI_HARNESS_STATE_DIR });
    let exiting = false;
    const resumeHint = () => console.log(`\nTo resume this conversation, run:\n  pss --session ${host.session.id}\n`);
    const shutdown = async () => { if (exiting) return; exiting = true; await host.close(); if (!inspectOnly) resumeHint(); process.exit(0); };
    process.once("SIGTERM", shutdown);
    let next: string | undefined;
    try {
      if (args.includes("--check")) {
        const agent = await host.conversation.agent(ctx);
        let codemode: string;
        try {
          const sandbox = new CodemodeSandbox({ timeoutMs: 10_000, globals: [], tools: [] });
          try {
            const result = await sandbox.execute(`text("codemode-ok");`, {});
            if (!result.ok) throw new Error(result.error.message);
            codemode = "ok";
          } finally { await sandbox.close(); }
        } catch (error) {
          throw new Error(`Codemode sandbox failed (quickjs.wasm missing?): ${error instanceof Error ? error.message : String(error)}. Run: bun install --ignore-scripts --no-save --cwd "${import.meta.dir}"`);
        }
        console.log(JSON.stringify({ runtime: "pi-skin-sjdonado", model: agent.model, thinking: agent.thinkingLevel,
          tools: agent.tools.map(t => t.name), skills: host.prompt.skills.map(s => s.name),
          instructions: host.prompt.files.map(f => f.path), mcp: host.mcp.status, codemode, session: host.session.dir }, null, 2));
      } else {
        if (!process.stdin.isTTY) throw new Error("Interactive chat needs a terminal. Use --check for offline startup checks or pi-agent for headless jobs.");
        host.resume(); next = await runTui(host);
      }
    } finally { await host.close(); process.off("SIGTERM", shutdown); if (checkDir) rmSync(checkDir, { recursive: true, force: true }); }
    if (!next) { if (!inspectOnly) resumeHint(); break; }
    selected = next;
    }
  }
}

if (import.meta.main) await cli();
