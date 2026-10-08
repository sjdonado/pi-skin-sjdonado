import { Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { ConversationView, EntryRecord, LiveState } from "@earendil-works/pi-durable";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { createAllToolRenderers, theme } from "./native-ui.ts";
import { searchRenderer } from "./search.ts";

export class DurableTranscript extends Container {
  private ids: number[] = [];
  private cards: ToolExecutionComponent[] = [];
  private latest = new Map<string, ToolExecutionComponent>();
  private streaming?: AssistantMessageComponent;
  private streamingCalls = new Set<string>();
  private expanded = false;
  private renderers: Record<string, ToolRenderers> = { ...createAllToolRenderers(), web_search: searchRenderer };
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
