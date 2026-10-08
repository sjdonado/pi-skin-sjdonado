import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

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

export function preferredModels(models: readonly Model<any>[]): Model<any>[] {
  const codex = models.filter(m => m.provider === "openai-codex");
  const astra = codex.filter(m => /^gpt-[\d.]+-astra(?:-|$)/.test(m.id))
    .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
  return models.filter(m => m.provider === "opencode-go" ||
    (m.provider === "openai-codex" && (["gpt-6.1-sol", "gpt-6-luna"].includes(m.id) || m === astra)));
}

export function modelReference(input: string, models: readonly Model<any>[]) {
  const match = models.find(m => `${m.provider}/${m.id}` === input) ??
    models.find(m => m.provider === "openai-codex" && m.id === input);
  if (!match) throw new Error("Model is not available for a configured provider. Use /models or /model.");
  return { provider: match.provider, modelId: match.id };
}

export function modelChoices(models: Pick<ModelRuntime, "getAvailableSnapshot">) {
  return [...models.getAvailableSnapshot()];
}
