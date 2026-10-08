import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { terminalScreen } from "./terminal-screen.test-helper.ts";
import { openSession } from "./session.ts";
import { openHost } from "./host.ts";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

(process.platform === "darwin" ? test : test.skip)("actual terminal offers native slash/model/settings UI and an exact resume hint without inference", async () => {
  const evidence = mkdtempSync(join(import.meta.dir, "results-ui-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-ui-test-"));
  const older = openSession(cwd, false, join(cwd, "state"));
  writeFileSync(join(older.dir, "preview.json"), JSON.stringify({ title: "Saved fixture conversation" }));
  older.release();
  const seed = await openHost({ cwd, stateDir: join(cwd, "state"), sessionId: older.id, noMcp: true });
  await seed.harness.commit(tx => tx.appendEntry(seed.conversation.id, { kind: "pi.assistant", model: [{
    role: "assistant", api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-luna", timestamp: 1, stopReason: "stop",
    content: [{ type: "text", text: Array.from({ length: 50 }, (_, i) => `Fixture paragraph ${i}`).join("\n\n") + "\n\nFIXTURE_LAST_REPLY" }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }] }), context);
  await seed.close();
  // Bun's stdio sockets make macOS script fail its terminal ioctl. Ordinary pipes
  // around script preserve a real child PTY while keeping this test headless.
  const proc = spawn("/bin/bash", ["-c", 'cat | /usr/bin/script -q "$1" "$2" "$3" --no-mcp | cat', "_",
    join(evidence, "terminal.log"), process.execPath, join(import.meta.dir, "main.ts")], {
    cwd, detached: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_HARNESS_STATE_DIR: join(cwd, "state"), PI_OFFLINE: "1" },
  });
  let raw = "";
  const collect = (async () => { for await (const bytes of proc.stdout) raw += Buffer.from(bytes).toString(); })();
  const stderr = (async () => { let text = ""; for await (const bytes of proc.stderr) text += bytes.toString(); return text; })();
  const closed = new Promise<void>(resolve => proc.once("close", () => resolve()));
  let finished = false; proc.once("close", () => finished = true);
  const stop = () => { if (!finished) { try { process.kill(-proc.pid!, "SIGTERM"); } catch {} } };
  const send = (text: string) => proc.stdin.write(text);
  async function wait(text: string) {
    const deadline = Date.now() + 10000;
    while (!terminalScreen(raw).includes(text)) {
      if (Date.now() > deadline) throw new Error(`Terminal did not show ${text}`);
      await Bun.sleep(10);
    }
  }
  const deadline = setTimeout(stop, 30000);
  try {
    await wait("(sub)");
    send("\x1b]10;rgb:0000/0000/0000\x07\x1b]11;rgb:ffff/ffff/ffff\x07\x1b[?1;2c");
    send("/"); await wait("Select provider/model");
    send("\x03/model\r"); await wait("Scope:");
    send("gpt-6.1-sol\r"); await wait("gpt-6.1-sol · medium");
    send("/settings\r"); await wait("Auto-compaction");
    send("\x1b"); await Bun.sleep(100);
    send("/resume\r"); await wait("Saved fixture conversation");
    send("\x1b[B\r"); await wait("gpt-6-luna · medium");
    await wait("FIXTURE_LAST_REPLY");
    const screen = terminalScreen(raw).split("\n");
    const border = screen.findIndex(line => /^─/.test(line));
    expect(border).toBeGreaterThan(1);
    expect(screen[border - 1].trim()).toBe("");
    send("/quit\r");
    proc.stdin.end();
    await closed; await collect;
    const text = stripTerminalSequences(raw);
    expect(text).toContain("pi --session ");
    expect(text).toContain(`pi --session ${older.id}`);
    expect(text).not.toContain("Tool undefined");
    expect(proc.exitCode).toBe(0);
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: true, inference: "not invoked", assertions: ["slash completion", "native model selection", "native settings", "session picker", "exact exit resume hint"], stderr: await stderr }));
  } catch (error) {
    stop(); await closed; await collect;
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: false, error: String(error), stderr: await stderr, exitCode: proc.exitCode, output: stripTerminalSequences(raw), inference: "not invoked" }));
    throw error;
  } finally { clearTimeout(deadline); proc.stdin.end(); stop(); await closed; await collect; rmSync(cwd, { recursive: true, force: true }); }
}, 35000);
