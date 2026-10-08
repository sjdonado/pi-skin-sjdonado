import { test, expect } from "bun:test";
import { CombinedAutocompleteProvider, Container, Spacer, setKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { slashCommands } from "./ui-commands.ts";
import { DurableTranscript } from "./transcript.ts";
import { DurableFooter } from "./footer.ts";
import { KeybindingsManager } from "./native-ui.ts";

initTheme("light", false);
setKeybindings(KeybindingsManager.create());
const usage = { input: 1000, output: 50, cacheRead: 2000, cacheWrite: 0, totalTokens: 3050, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
const assistant = (content: any, stopReason = "stop") => ({ role: "assistant", content, stopReason, usage, model: "gpt-6-luna", provider: "openai-codex", api: "openai-codex-responses", timestamp: 1 });
const plain = (lines: string[]) => stripTerminalSequences(lines.join("\n"));

test("native slash completion includes Durable commands, skills and model arguments", async () => {
  const commands = slashCommands([{ name: "ask", description: "Answer a question", filePath: "/skills/ask/SKILL.md" } as any]);
  const completion = new CombinedAutocompleteProvider(commands, process.cwd());
  const signal = new AbortController().signal;
  const suggestions = await completion.getSuggestions(["/"], 0, 1, { signal });
  expect(suggestions?.items.map(i => i.value)).toContain("model");
  expect(suggestions?.items.map(i => i.value)).toContain("login");
  expect(suggestions?.items.map(i => i.value)).not.toContain("models");
  expect(suggestions?.items.map(i => i.value)).toContain("ps");
  expect(suggestions?.items.map(i => i.value)).toContain("skill:ask");
  const model = suggestions!.items.find(i => i.value === "model")!;
  expect(completion.applyCompletion(["/"], 0, 1, model, suggestions!.prefix).lines[0]).toBe("/model ");
  const models = await commands.find(c => c.name === "model")!.getArgumentCompletions!("gpt-6");
  expect(models?.map(m => m.value)).toEqual(["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"]);
});

test("native transcript hides system entries and collapses tool output without losing its arguments", () => {
  const ui = { requestRender() {} } as any;
  const transcript = new DurableTranscript(ui, process.cwd());
  const entries = [
    { id: 1, kind: "pi.system", model: [{ role: "system", content: "SYSTEM_ONLY" }] },
    { id: 2, kind: "pi.user", model: [{ role: "user", content: "Inspect README", timestamp: 1 }] },
    { id: 3, kind: "pi.assistant", model: [assistant([{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "/skills/ask/SKILL.md", offset: 1, limit: 100 } }], "toolUse")] },
    { id: 4, kind: "pi.tool-result", model: [{ role: "toolResult", toolName: "read", toolCallId: "read-1", content: [{ type: "text", text: Array.from({ length: 60 }, (_, i) => `READ_DETAIL_${i}`).join("\n") }], isError: false, timestamp: 1 }] },
    { id: 5, kind: "pi.assistant", model: [assistant([{ type: "text", text: "Review complete" }])] },
  ];
  try {
    transcript.apply({ entries, docs: {} } as any);
    const collapsed = plain(transcript.render(100));
    expect(collapsed).toContain("[skill] ask:1-100");
    expect(collapsed).toContain("ctrl+o");
    expect(collapsed).not.toContain("SYSTEM_ONLY");
    expect(collapsed).not.toContain("undefined");
    expect(collapsed).not.toContain("READ_DETAIL_59");
    transcript.setExpanded(true);
    expect(plain(transcript.render(100))).toContain("READ_DETAIL_59");
    transcript.apply({ entries, docs: {} } as any);
    expect(plain(transcript.render(100)).match(/Review complete/g)).toHaveLength(1);
  } finally { transcript.reset(); }
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
  expect(plain(footer.render(120))).toContain("1 background process");
  expect(footer.render(20).slice(0, 2).every(line => visibleWidth(line) <= 20)).toBe(true);
});

test("reply-to-user spacing exactly follows Pi-agent's native message layout", () => {
  const answer = assistant([{ type: "text", text: "Previous reply" }]);
  const expected = new Container();
  expected.addChild(new AssistantMessageComponent(answer as any));
  expected.addChild(new Spacer(1));
  expected.addChild(new UserMessageComponent("Next question"));
  const actual = new DurableTranscript({ requestRender() {} } as any, process.cwd());
  try {
    actual.apply({ entries: [
      { id: 1, kind: "pi.assistant", model: [answer] },
      { id: 2, kind: "pi.user", model: [{ role: "user", content: "Next question", timestamp: 1 }] },
    ], docs: {} } as any);
    expect(plain(actual.render(100))).toBe(plain(expected.render(100)));
  } finally { actual.reset(); }
});
