import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelChoices, modelReference, useOpenCodeGo } from "../main.ts";

test("model picker passes the catalog through without filtering", () => {
  const snapshot = [
    { provider: "anthropic", id: "claude-opus" },
    { provider: "openai-codex", id: "gpt-6-luna" },
  ];
  expect(modelChoices({ getAvailableSnapshot: () => snapshot } as any)).toEqual(snapshot as any);
  expect(modelReference("openai-codex/gpt-6-luna", snapshot as any)).toEqual({ provider: "openai-codex", modelId: "gpt-6-luna" });
  expect(() => modelReference("nope/nope", snapshot as any)).toThrow();
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
