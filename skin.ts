import { Type } from "typebox";
import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	configure,
	defineDoc,
	defineExtension,
	defineTool,
	section,
	ProviderDoc,
	type PromptInput,
} from "@earendil-works/pi-durable";
import {
	ModelRegistry,
	formatSkillsForPrompt,
	getAgentDir,
	loadProjectContextFiles,
	loadSkills,
	type ModelRuntime,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type ExtensionAPI,
	type ExtensionContext,
	type SettingsManager,
	type Skill,
	type ToolDefinition,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { buildSystemPromptSections } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { bashToolSystemPromptContribution } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js";
import { editToolSystemPromptContribution } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js";
import { readToolSystemPromptContribution } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js";
import { writeToolSystemPromptContribution } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/tools/write.js";
import { McpClient, StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { TSchema } from "typebox";
import type { JsonValue } from "@earendil-works/chord";

// ─── prompt: pi's system prompt as one extension ────────────────────────────

const CONTRIBUTIONS = {
	read: readToolSystemPromptContribution,
	bash: bashToolSystemPromptContribution,
	edit: editToolSystemPromptContribution,
	write: writeToolSystemPromptContribution,
};

/** pi's section order; `buildSystemPromptSections()` omits the ones without content. */
const KEYS = ["preamble", "tools", "rules", "docs", "project_context", "skills", "cwd"] as const;

// Skill discovery mirrors pi's effective set: project `.agents/skills` up to
// the repo root, the shared `~/.agents/skills`, pi defaults, installed
// extension skills, and configured paths. One cache serves the prompt and
// the completion list so the model and the popup agree.
const skinSkillCache = new Map<string, Skill[]>();
function extensionSkillDirs(): string[] {
	const dirs: string[] = [];
	try {
		const root = join(homedir(), ".pi/agent/npm/node_modules");
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			try {
				const manifest = JSON.parse(readFileSync(join(root, entry.name, "package.json"), "utf8"));
				for (const declared of manifest.pi?.skills ?? []) dirs.push(join(root, entry.name, declared));
			} catch {
				// A broken package must never break skill discovery.
			}
		}
	} catch {
		// No local package store; skip extension skills.
	}
	return dirs.filter((dir) => existsSync(dir));
}
export function loadSkinSkills(settings: SettingsManager, cwd: string): Skill[] {
	let found = skinSkillCache.get(cwd);
	if (found === undefined) {
		const agentDir = getAgentDir();
	 const walk: string[] = [];
		for (let dir = cwd; ; dir = dirname(dir)) {
			const path = join(dir, ".agents/skills");
			if (existsSync(path)) walk.push(path);
			if (existsSync(join(dir, ".git")) || dirname(dir) === dir || dir === homedir()) break;
		}
		const homeShared = join(homedir(), ".agents/skills");
		found = loadSkills({
			cwd,
			agentDir,
			skillPaths: [
				...walk,
				...(existsSync(homeShared) ? [homeShared] : []),
				...extensionSkillDirs(),
				...settings.getSkillPaths(),
			],
			includeDefaults: true,
		}).skills;
		skinSkillCache.set(cwd, found);
	}
	return found;
}

const skinPromptCache = new Map<string, { contextFiles: { path: string; content: string }[] }>();

export function createSkinPrompt(settings: SettingsManager, fallbackCwd: string) {
	const load = (cwd: string) => {
		let found = skinPromptCache.get(cwd);
		if (found === undefined) {
			found = { contextFiles: loadProjectContextFiles({ cwd, agentDir: getAgentDir() }) };
			skinPromptCache.set(cwd, found);
		}
		return { ...found, skills: loadSkinSkills(settings, cwd) };
	};
	const built = new WeakMap<PromptInput, Record<string, string>>();
	const build = (input: PromptInput): Record<string, string> => {
		let sections = built.get(input);
		if (sections === undefined) {
			sections = buildSections(input);
			built.set(input, sections);
		}
		return sections;
	};
	const buildSections = (input: PromptInput): Record<string, string> => {
		const cwd = input.env?.cwd ?? input.agent.cwd ?? fallbackCwd;
		const selectedTools = input.agent.tools.map((tool) => tool.name);
		const snippets: Record<string, string> = {};
		const guidelines: Record<string, string[]> = {};
		for (const name of selectedTools) {
			const contribution = CONTRIBUTIONS[name as keyof typeof CONTRIBUTIONS];
			if (contribution === undefined) continue;
			snippets[name] = contribution.snippet;
			guidelines[name] = [...contribution.guidelines];
		}
		return {
			preamble:
				"You are Pi, a general-purpose interactive coding harness. Work in the current project, investigate before editing, use the project's checks, and complete the user's requested scope. Read applicable nested project instructions before edits. Load a relevant skill by reading its SKILL.md. Do not read environment-secret files. Do not commit, push or publish without user authorization. Use foreground bash for finite work and bg_start for servers, watchers and long commands. Subagents have fresh contexts: give each the task and authoritative file paths, not hidden conversation assumptions.",
			...buildSystemPromptSections({
				cwd,
				selectedTools,
				toolSnippets: snippets,
				toolGuidelines: guidelines,
				...load(cwd),
			}),
		};
	};
	return defineExtension({
		name: "skin-prompt",
		sections: KEYS.map((key) => section(key, (input) => build(input)[key], { tag: false })),
	});
}

// ─── slash completion: pi's message-bar autocomplete ────────────────────────
// The sample TUI has no completion; this feeds the editor the same slash
// commands plus the discovered skills, with live model names for /model.

export function listSkills(settings: SettingsManager, cwd: string): Skill[] {
	return loadSkinSkills(settings, cwd);
}

/** Drop cached skills and prompt resources so `/reload` picks up disk changes. */
export function clearSkinCaches(): void {
	skinSkillCache.clear();
	skinPromptCache.clear();
}

export function buildSlashCommands(
	skills: Skill[],
	getModels: () => readonly { provider: string; modelId: string }[],
): SlashCommand[] {
	const choices =
		(values: readonly string[]) => (prefix: string) =>
			values.filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v }));
	return [
		{ name: "model", description: "Select provider/model", argumentHint: "[provider/model]", getArgumentCompletions: (prefix: string) => choices(getModels().map((m) => `${m.provider}/${m.modelId}`))(prefix) },
		{ name: "tasks", description: "Show or hide the task panel" },
		{ name: "agents", description: "Switch conversations" },
		{ name: "compact", description: "Compact this conversation", argumentHint: "[instructions]" },
		{ name: "copy", description: "Copy the last assistant message" },
		{ name: "name", description: "Name this session", argumentHint: "<name>" },
		{ name: "session", description: "Show session info" },
		{ name: "resume", description: "Resume a saved session" },
		{ name: "reload", description: "Reload skills and prompt resources" },
		{ name: "quit", description: "Exit the session" },
		{ name: "mcp", description: "Configure MCP servers in pi" },
		{ name: "settings", description: "Change settings in pi" },
		{ name: "ps", description: "List background terminals" },
		{ name: "stop", description: "Stop all background terminals" },
		{ name: "thinking", description: "Select thinking level", argumentHint: "[level]" },
		{ name: "new", description: "Start a fresh session" },
		{ name: "debug", description: "Write a debug log" },
		{ name: "changelog", description: "Show what is new" },
		{ name: "hotkeys", description: "Show keyboard shortcuts" },
		{ name: "export", description: "Export transcript to JSONL", argumentHint: "[path]" },
		{ name: "import", description: "Import a transcript JSONL file", argumentHint: "<path>" },
		{ name: "share", description: "Share transcript as a secret gist" },
		...skills.map((skill) => ({ name: `skill:${skill.name}`, description: skill.description, argumentHint: "[task]" })),
	];
}
import type { SlashCommand } from "@earendil-works/pi-tui";

// ─── shared answers ─────────────────────────────────────────────────────────

async function answerText(entry: { model?: readonly unknown[] } | undefined): Promise<string> {
	const message = entry?.model?.[0] as { role?: string; content?: { type: string; text?: string }[] } | undefined;
	return message?.role === "assistant"
		? (message.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n")
		: "";
}

function resolveChildModel(
	parent: { provider?: string; modelId?: string } | undefined,
	requested: string | undefined,
	known: (provider: string, modelId: string) => unknown,
) {
	const fallback = parent;
	const [provider, ...parts] = requested?.split("/") ?? [];
	const selected =
		requested === undefined || requested === "inherit"
			? parent
			: parts.length
				? { provider, modelId: parts.join("/") }
				: { provider: "openai", modelId: requested };
	if (!selected?.provider || !selected?.modelId || !known(selected.provider, selected.modelId)) {
		throw new Error("Subagent model is not in the configured catalog");
	}
	return selected as { provider: string; modelId: string };
}

// ─── subagent: one general-purpose delegate ────────────────────────────────
// Like Codex and pi-subagents' delegate: no special instructions, same as the
// parent unless asked. The task carries the instructions, the parent picks the
// model explicitly or not at all.

const subagent = defineTool({
	name: "subagent",
	description:
		"Delegate a bounded task to a general-purpose child conversation and get its answer back. The child works like the parent session. Supply the task, authoritative file paths and acceptance checks in the task itself. Parent cancellation aborts child work.",
	parameters: Type.Object({
		task: Type.String(),
		model: Type.Optional(
			Type.String({
				description:
					"Configured provider/model or a bare Codex model ID. Defaults to the parent's model.",
			}),
		),
	}),
	// A rerun after a crash finds the child it created and the submission it made.
	replay: "safe",
	execute: async (args, api, context) => {
		const parent = await api.agent(context);
		const selected = resolveChildModel(parent.model, args.model, (p, m) => api.models.getModel(p, m));
		const childId = await api.commit(async (tx) => {
			const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
			if (existing !== undefined) return existing.id;
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
			await configure(tx, child.id, {
				model: selected,
				thinkingLevel: "medium",
				tools: { remove: [subagent, btw] },
			});
			return child.id;
		}, context);
		await api.details({ conversationId: childId }, context);
		const child = (await api.conversation(childId, context))!;
		const result = await (
			await child.submit({ type: "input", content: args.task, requestId: `subagent:${api.taskId}` }, context)
		).wait(context);
		if (result.status !== "done" || result.type !== "input") {
			throw new Error(`Child did not answer: ${result.status}`);
		}
		const entry = await api.commit((tx) => tx.entry(result.answer), context);
		return {
			content: [{ type: "text" as const, text: await answerText(entry) }],
			details: { conversationId: childId },
		};
	},
});


// ─── btw: a side question is just a task ────────────────────────────────────

const SIDE_BOUNDARY =
	"Side conversation boundary: inherited history is reference context only, not your current task. Answer only the question submitted after this boundary. Do not continue the parent's plans, tool calls, approvals or work. This is lightweight non-mutating exploration: do not edit files, execute shell commands, manage processes, publish, or delegate. Side answers are not appended to the parent conversation.";

const btw = defineTool({
	name: "btw",
	description:
		"Ask a side question with the parent history as reference context, without interrupting the main work. Returns the side answer; it is never appended to the parent. Side tools are read/search only.",
	parameters: Type.Object({ question: Type.String({ description: "The side question to answer from parent history" }) }),
	replay: "safe",
	execute: async (args, api, context) => {
		const parent = await api.agent(context);
		const last = await api.commit(
			async (tx) => (await tx.scanEntries({ conversationId: api.conversationId }, 1)).items[0],
			context,
		);
		if (last === undefined) throw new Error("Nothing to reference yet");
		const childId = await api.commit(async (tx) => {
			const record = await tx.forkConversation(api.conversationId, last.id, {
				ownership: { kind: "ownerless" },
			});
			await configure(tx, record.id, {
				model: parent.model,
				thinkingLevel: parent.thinkingLevel,
				cwd: parent.cwd,
				tools: { remove: parent.tools.filter((t) => !["read", "web_search"].includes(t.name)) },
				instructions: `${parent.instructions ?? ""}\n\n${SIDE_BOUNDARY}`,
			});
			return record.id;
		}, context);
		await api.details({ conversationId: childId }, context);
		const child = (await api.conversation(childId, context))!;
		const result = await (
			await child.submit({ type: "input", content: args.question, requestId: `btw:${api.taskId}` }, context)
		).wait(context);
		if (result.status !== "done" || result.type !== "input") {
			throw new Error(`Side question did not answer: ${result.status}`);
		}
		const entry = await api.commit((tx) => tx.entry(result.answer), context);
		return { content: [{ type: "text" as const, text: await answerText(entry) }] };
	},
});

export function subagentsExtension() {
	return defineExtension({ name: "skin", tools: [subagent, btw] });
}

// ─── search: provider-native web search ─────────────────────────────────────
// pi-web-search adapted to the model, auth and per-conversation identity APIs.
// Static specifiers so bundlers trace the source-only package.

const registerWebSearch = (await import("pi-web-search")).default as (pi: ExtensionAPI) => void;
const { webSearch, WebSearchSchema } = (await import("pi-web-search/src/web_search.ts")) as {
	WebSearchSchema: TSchema;
	webSearch: (
		id: string,
		args: { query: string; urls?: string[] },
		signal: AbortSignal,
		update: AgentToolUpdateCallback | undefined,
		context: ExtensionContext,
		thinking?: ModelThinkingLevel,
	) => Promise<AgentToolResult<Record<string, JsonValue>>>;
};

export const SearchUsage = defineDoc<{ callsWithUnknownUsage: number }>({
	kind: "harness.search-usage",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ callsWithUnknownUsage: 0 }),
});
const definitions: ToolDefinition[] = [];
// Capture this package's native renderer; it is not an ambient Durable extension.
registerWebSearch({
	registerTool: (tool: ToolDefinition) => definitions.push(tool),
	on() {},
	getActiveTools: () => [],
	setActiveTools() {},
} as unknown as ExtensionAPI);
export const searchRenderer: ToolRenderers = definitions.find((t) => t.name === "web_search")!;

const webSearchTool = defineTool({
		name: "web_search",
		description: definitions[0].description,
		parameters: WebSearchSchema,
		execute: async (args, api, context) => {
			const registry = new ModelRegistry(api.models as ModelRuntime);
			const agent = await api.agent(context);
			const model = agent.model && api.models.getModel(agent.model.provider, agent.model.modelId);
			// Go completion routes have no native search, and its Messages gateway is unverified.
			if ((model as { provider?: string; api?: string; id?: string } | undefined)?.provider === "opencode-go") {
				const apiName = (model as { api?: string }).api;
				if (apiName !== "openai-responses") {
					return {
						isError: true,
						content: [
							{
								type: "text" as const,
								text: `${(model as { id?: string }).id} does not have a verified provider-native search route through OpenCode Go. Select a Responses-backed Go model or a Codex model explicitly; no fallback was used.`,
							},
						],
					};
				}
			}
			const sessionId = await api.commit(
				async (tx) => (await tx.doc(ProviderDoc, api.conversationId)).sessionId,
				context,
			);
			// Record before dispatch so interruption cannot silently erase unknown usage.
			await api.commit(async (tx) => {
				(await tx.doc(SearchUsage, api.conversationId)).callsWithUnknownUsage++;
			}, context);
			const pluginContext = {
				model,
				modelRegistry: {
					find: registry.find.bind(registry),
					getAvailable: registry.getAvailable.bind(registry),
					getApiKeyAndHeaders: async (candidate: Parameters<ModelRegistry["getApiKeyAndHeaders"]>[0]) => {
						const auth = await registry.getApiKeyAndHeaders(candidate);
						return auth.ok
							? {
									...auth,
									headers:
										auth.headers &&
										Object.fromEntries(Object.entries(auth.headers).filter(([, value]) => value !== null)),
								}
							: auth;
					},
				},
				sessionManager: { getSessionId: () => sessionId },
			} as unknown as ExtensionContext;
			let previous = "";
			const result = await webSearch(
				api.callId,
				args as { query: string; urls?: string[] },
				context.abortSignal ?? new AbortController().signal,
				(update) => {
					const text = update.content
						.filter((p) => p.type === "text")
						.map((p) => p.text)
						.join("\n");
					api.output(text.startsWith(previous) ? text.slice(previous.length) : "\n" + text);
					previous = text;
				},
				pluginContext,
				agent.thinkingLevel,
			);
			const normalized = JSON.parse(JSON.stringify(result)) as typeof result;
			if (normalized.details?.error) return { ...normalized, isError: true };
			// The plugin does not report search-request usage. Do not present it as zero.
			return normalized;
		},
	});
export const Search = defineExtension({ name: "skin-search", tools: [webSearchTool] });

// ─── mcp: lazy codemode bridge ──────────────────────────────────────────────
// MCP servers connect on first use, never at startup: nothing connects during
// --check, and a dead server cannot break startup. The process never changes
// directory, so the launch directory stays correct for server commands.

export type ServerConfig = {
	command?: string;
	args?: string[];
	url?: string;
	headers?: Record<string, string>;
	enabled?: boolean;
	cwd?: string;
};
export type McpConfig = Record<string, ServerConfig>;
const expand = (s: string) => s.replace(/^~(?=\/|$)/, homedir());

export function loadMcp(cwd: string): McpConfig {
	const load = (file: string) => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).mcpServers ?? {}) : {});
	return { ...load(join(homedir(), ".pi/agent/mcp.json")), ...load(join(cwd, ".pi/mcp.json")) };
}

export function listMcpServers(cwd: string): string[] {
	return Object.entries(loadMcp(cwd))
		.filter(([, config]) => config.enabled !== false)
		.map(([name]) => name);
}

type McpBridge = Awaited<ReturnType<typeof connectMcp>>;
const bridges = new Map<string, Promise<McpBridge>>();
function mcpBridge(cwd: string): Promise<McpBridge> {
	let bridge = bridges.get(cwd);
	if (bridge === undefined) {
		bridge = connectMcp(cwd, loadMcp(cwd));
		bridges.set(cwd, bridge);
		// A failed first connection must not poison later calls.
		void bridge.catch(() => {
			if (bridges.get(cwd) === bridge) bridges.delete(cwd);
		});
	}
	return bridge;
}

async function connectMcp(cwd: string, configs: McpConfig) {
	const clients: McpClient[] = [];
	const tools: { name: string; description: string; inputSchema: any; client: McpClient; original: string }[] = [];
	const status: Record<string, string> = {};
	await Promise.all(
		Object.entries(configs).map(async ([name, config]) => {
			if (config.enabled === false) return;
			const client = new McpClient({
				name: "pi-harness",
				version: "0.1.0",
				roots: [{ uri: pathToFileURL(cwd).href }],
			});
			clients.push(client);
			try {
				const transport = config.url
					? new StreamableHttpTransport({ url: config.url, headers: config.headers })
					: new StdioTransport({
							command: expand(config.command!),
							args: config.args?.map(expand),
							cwd: config.cwd ? expand(config.cwd) : cwd,
						});
				await client.connect(transport);
				const listed = await client.listTools();
				for (const tool of listed)
					tools.push({
						name: `${name}_${tool.name}`.replace(/[^\w]/g, "_"),
						description: tool.description ?? tool.name,
						inputSchema: tool.inputSchema,
						client,
						original: tool.name,
					});
				status[name] = `${listed.length} tools`;
			} catch (error) {
				status[name] = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
				await client.close().catch(() => {});
			}
		}),
	);
	return {
		status,
		tools,
		close: () => Promise.all(clients.map((c) => c.close().catch(() => {}))),
	};
}

async function runCodemode(
	code: string,
	live: {
		name: string;
		description: string;
		inputSchema: unknown;
		call: (args: any, signal: any) => Promise<any>;
	}[],
	api: { commit: any },
	context: Context,
) {
	const sandbox = new CodemodeSandbox({
		timeoutMs: 60_000,
		globals: [
			{
				name: "searchTools",
				execute: async (query) =>
					live
						.filter((t) => `${t.name} ${t.description}`.toLowerCase().includes(String(query).toLowerCase()))
						.map((t) => ({ name: t.name, description: t.description })),
			},
			{
				name: "describeTool",
				execute: async (name) => {
					const tool = live.find((t) => t.name === name);
					if (!tool) throw new Error("Unknown MCP tool");
					return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
				},
			},
		],
		tools: live.map((tool) => ({
			name: tool.name,
			description: tool.description,
			execute: async (args, { signal }: { signal?: AbortSignal }) => tool.call(args, signal),
		})),
	});
	try {
		const result = await sandbox.execute(code, { signal: context.abortSignal });
		if (!result.ok) throw new Error(result.error.message);
		const content = [...result.output];
		if (result.value !== undefined) content.push({ type: "text", text: JSON.stringify(result.value) });
		return { content };
	} finally {
		await sandbox.close();
	}
}

export function mcpExtension(cwd: string) {
	return defineExtension({
		name: "skin-mcp",
		tools: [
			defineTool({
				name: "codemode",
				description:
					"Execute JavaScript in a sandbox to call MCP tools. No filesystem, network or process APIs in scripts. Use searchTools(\"keyword\") to discover tool names/descriptions and describeTool(\"name\") for input schemas, then await tools.name(args). Use text(value) or return for output. MCP calls execute with the host's authority.",
				parameters: Type.Object({ code: Type.String() }),
				execute: async ({ code }, api, context) => {
					const connected = await mcpBridge(cwd);
					return runCodemode(
						code,
						connected.tools.map((tool) => ({
							name: tool.name,
							description: tool.description,
							inputSchema: tool.inputSchema,
							call: async (args: any, signal: any) => {
								await api.commit(async (tx) => {
									await tx.appendEntry(api.conversationId, {
										kind: "harness.mcp",
										data: { tool: tool.name, status: "started" },
									});
								}, context);
								const result = await tool.client.callTool(tool.original, args, { signal });
								await api.commit(async (tx) => {
									await tx.appendEntry(api.conversationId, {
										kind: "harness.mcp",
										data: { tool: tool.name, status: result.isError ? "error" : "completed" },
									});
								}, context);
								if (result.isError) throw new Error(JSON.stringify(result.content));
								return result.structuredContent ?? result.content;
							},
						})),
						api,
						context,
					);
				},
			}),
		],
	});
}
