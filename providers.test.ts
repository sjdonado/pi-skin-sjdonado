import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preferredModels, modelReference, useOpenCodeGo } from "./providers.ts";

test("provider catalog keeps preferred Codex models/latest Astra and every configured Go model", () => {
  const entries = ["gpt-5-sol", "gpt-6.1-sol", "gpt-6-luna", "gpt-5-astra", "gpt-6-astra"].map(id => ({ provider: "openai-codex", id }));
  entries.push({ provider: "opencode-go", id: "deepseek-v4.1-flash" });
  const models = preferredModels(entries as any);
  expect(models.map(m => m.id)).toEqual(["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra", "deepseek-v4.1-flash"]);
  expect(modelReference("opencode-go/deepseek-v4.1-flash", models)).toEqual({ provider: "opencode-go", modelId: "deepseek-v4.1-flash" });
  expect(() => modelReference("gpt-5-sol", models)).toThrow();
});
test("Go credential handoff is in-memory and does not rewrite the source store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-go-test-")), file = join(dir, "auth.json");
  const original = JSON.stringify({ "opencode-go": { type: "api", key: "invalid-fixture-key" }, unrelated: { type: "api", key: "leave-alone" } });
  writeFileSync(file, original);
  let accepted = false;
  try {
    expect(await useOpenCodeGo({ hasConfiguredAuth: () => false, setRuntimeApiKey: async (provider, key) => { accepted = provider === "opencode-go" && key === "invalid-fixture-key"; } }, file)).toBe(true);
    expect(accepted).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(await useOpenCodeGo({ hasConfiguredAuth: () => true, setRuntimeApiKey: async () => { throw new Error("Should preserve configured Pi auth"); } }, file)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
