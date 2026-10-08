#!/usr/bin/env bun
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { openHost } from "./host.ts";
import { runTui } from "./tui.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const allowed = new Set(["--continue", "-c", "--check", "--no-mcp", "--help", "-h"]);
let selected: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--session") { selected = args[++i]; if (!selected) throw new Error("--session needs an ID"); continue; }
  if (!allowed.has(args[i])) throw new Error(`Unknown option ${args[i]}; use --help`);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log("Pi Durable harness\n\npi [--continue | --session ID] [--no-mcp]\npi --check [--no-mcp]   startup/resource checks, no model calls\npi-agent                upstream standalone CLI\n\nCommands: /settings /model /login /logout /thinking /theme /resume /btw /back /agents /compact /ps /logs /stop /restart /quit");
} else {
  while (true) {
  const inspectOnly = args.includes("--check");
  const checkDir = inspectOnly ? mkdtempSync(join(tmpdir(), "pi-startup-check-")) : undefined;
  const host = await openHost({ cwd: process.cwd(), resume: !checkDir && !selected && (args.includes("--continue") || args.includes("-c")),
    sessionId: checkDir ? undefined : selected, noMcp: args.includes("--no-mcp"), stateDir: checkDir ?? process.env.PI_HARNESS_STATE_DIR });
  let exiting = false;
  const resumeHint = () => console.log(`\nTo resume this conversation, run:\n  pi --session ${host.session.id}\n`);
  const shutdown = async () => { if (exiting) return; exiting = true; await host.close(); if (!inspectOnly) resumeHint(); process.exit(0); };
  process.once("SIGTERM", shutdown);
  let next: string | undefined;
  try {
    if (args.includes("--check")) {
      const agent = await host.conversation.agent(ctx);
      let codemode: string;
      try {
        const { CodemodeSandbox } = await import("@earendil-works/pi-codemode");
        const { sandboxAssets } = await import("./mcp.ts");
        const sandbox = new CodemodeSandbox({ timeoutMs: 10_000, globals: [], tools: [],
          wasm: sandboxAssets.wasm, workerUrl: sandboxAssets.workerUrl });
        try {
          const result = await sandbox.execute(`text("codemode-ok");`, {});
          if (!result.ok) throw new Error(result.error.message);
          codemode = "ok";
        } finally { await sandbox.close(); }
      } catch (error) {
        throw new Error(`Codemode sandbox failed (quickjs.wasm missing?): ${error instanceof Error ? error.message : String(error)}. Run: bun install --ignore-scripts --no-save --cwd "$HOME/Developer/pi-durable"`);
      }
      console.log(JSON.stringify({ runtime: "pi-durable", model: agent.model, thinking: agent.thinkingLevel,
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
