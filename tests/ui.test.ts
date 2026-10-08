import { test, expect } from "bun:test";
import { CombinedAutocompleteProvider, setKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { slashCommands } from "../main.ts";
import { DurableFooter } from "../main.ts";
import { KeybindingsManager } from "../main.ts";

initTheme("light", false);
setKeybindings(KeybindingsManager.create());
const usage = { input: 1000, output: 50, cacheRead: 2000, cacheWrite: 0, totalTokens: 3050, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
const assistant = (content: any, stopReason = "stop") => ({ role: "assistant", content, stopReason, usage, model: "gpt-6-luna", provider: "openai-codex", api: "openai-codex-responses", timestamp: 1 });
const plain = (lines: string[]) => stripTerminalSequences(lines.join("\n"));

test("native slash completion includes scheme commands, skills and model arguments", async () => {
  const commands = slashCommands([{ name: "ask", description: "Answer a question", filePath: "/skills/ask/SKILL.md" } as any],
    ["openai-codex/gpt-6-luna", "openai-codex/gpt-6.1-sol"]);
  const completion = new CombinedAutocompleteProvider(commands, process.cwd());
  const signal = new AbortController().signal;
  const suggestions = await completion.getSuggestions(["/"], 0, 1, { signal });
  expect(suggestions?.items.map(i => i.value)).toContain("model");
  expect(suggestions?.items.map(i => i.value)).toContain("tasks");
  expect(suggestions?.items.map(i => i.value)).toContain("agents");
  expect(suggestions?.items.map(i => i.value)).not.toContain("login");
  expect(suggestions?.items.map(i => i.value)).not.toContain("ps");
  expect(suggestions?.items.map(i => i.value)).toContain("skill:ask");
  const model = suggestions!.items.find(i => i.value === "model")!;
  expect(completion.applyCompletion(["/"], 0, 1, model, suggestions!.prefix).lines[0]).toBe("/model ");
  const models = await commands.find(c => c.name === "model")!.getArgumentCompletions!("openai-codex/gpt-6");
  expect(models?.map((m: any) => m.value)).toEqual(["openai-codex/gpt-6-luna", "openai-codex/gpt-6.1-sol"]);
});

test("native-style footer preserves usage/model alignment and adds background status", () => {
  const footer = new DurableFooter("/project", "main");
  footer.view = { entries: [{ model: [assistant([{ type: "text", text: "done" }])] }], docs: {
    "pi.agent": { model: { provider: "openai-codex", modelId: "gpt-6-luna" }, thinkingLevel: "medium" },
    "pi.usage": { models: { "openai-codex/gpt-6-luna": usage } },
  } } as any;
  footer.contextWindow = 272000;
  expect(plain(footer.render(120))).toContain("gpt-6-luna · medium");
  expect(plain(footer.render(120))).toContain("(auto)");
  expect(plain(footer.render(120))).toContain("/project (main)");
  footer.running = 1;
  expect(plain(footer.render(120))).toContain("1 background task");
  expect(footer.render(20).slice(0, 2).every(line => visibleWidth(line) <= 20)).toBe(true);
});
