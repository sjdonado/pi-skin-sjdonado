import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ConversationView, UsageState } from "@earendil-works/pi-durable";
import { formatTokens, theme } from "./native-ui.ts";

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
    if (this.running) lines.push(theme.fg("accent", `${this.running} background process${this.running === 1 ? "" : "es"} · /ps to view · /stop to close`));
    if (this.side) lines.push(theme.fg("accent", "Side conversation · main continues · /back or Ctrl+C to return"));
    const search = this.view?.docs["harness.search-usage"] as { callsWithUnknownUsage?: number } | undefined;
    if (search?.callsWithUnknownUsage) lines.push(theme.fg("dim", "Web search usage unavailable; cost/token totals exclude those requests"));
    return lines;
  }
}
