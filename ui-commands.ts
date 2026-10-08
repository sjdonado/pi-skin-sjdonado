import type { SlashCommand } from "@earendil-works/pi-tui";
import type { Skill } from "@earendil-works/pi-coding-agent";

export const MODEL_IDS = ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const choices = (values: readonly string[]) => (prefix: string) => values.filter(v => v.startsWith(prefix)).map(v => ({ value: v, label: v }));

export function slashCommands(skills: Skill[], models: readonly string[] = MODEL_IDS): SlashCommand[] {
  return [
    { name: "settings", description: "Open harness settings" },
    { name: "model", description: "Select provider/model", argumentHint: "[provider/model]", getArgumentCompletions: choices(models) },
    { name: "login", description: "Sign in to a provider", argumentHint: "[provider]" },
    { name: "thinking", description: "Select thinking level", argumentHint: "[level]", getArgumentCompletions: choices(THINKING_LEVELS) },
    { name: "theme", description: "Select terminal theme" },
    { name: "resume", description: "Resume a saved project conversation" },
    { name: "btw", description: "Ask a side question with parent history as reference", argumentHint: "[question]" },
    { name: "back", description: "Close side conversation and return to main" },
    { name: "agents", description: "Switch Durable conversations", argumentHint: "[id]" },
    { name: "compact", description: "Compact this conversation", argumentHint: "[instructions]" },
    { name: "ps", description: "List background processes" },
    { name: "logs", description: "Read process output", argumentHint: "<id>" },
    { name: "stop", description: "Stop an owned process", argumentHint: "<id>" },
    { name: "restart", description: "Explicitly restart a historical process", argumentHint: "<id>" },
    { name: "help", description: "Show commands and shortcuts" },
    { name: "quit", description: "Exit and clean up owned processes" },
    ...skills.map(skill => ({ name: `skill:${skill.name}`, description: skill.description, argumentHint: "[task]" })),
  ];
}
