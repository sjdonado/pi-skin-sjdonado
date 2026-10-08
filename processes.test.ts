import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Processes } from "./processes.ts";
import { alive } from "./session.ts";

async function until(check: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error("Process condition did not settle"); await Bun.sleep(20); }
}
test("owned process captures output, stops descendants, and retains restart history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-process-test-"));
  const manager = new Processes(dir, dir);
  try {
    const job = manager.start("sleep 60 & echo $!; wait", "server", 1);
    await until(() => manager.logs(job.id).trim().length > 0);
    const childPid = Number(manager.logs(job.id).trim());
    expect(alive(childPid)).toBe(true);
    const stopped = await manager.stop(job.id);
    await until(() => !alive(childPid));
    expect(stopped.status).toBe("owner-exited");
    const restart = manager.restart(job.id);
    expect(restart.id).not.toBe(job.id);
    await manager.close();
    expect(manager.list().filter(j => ["running", "starting"].includes(j.status))).toHaveLength(0);
  } finally { await manager.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("supervisor cleans its shell group after an owner SIGKILL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-crash-test-"));
  const source = `import {Processes} from ${JSON.stringify(join(import.meta.dir, "processes.ts"))}; const m=new Processes(${JSON.stringify(dir)},${JSON.stringify(dir)}); console.log(m.start("sleep 60 & echo $!; wait", "crash", 1).id); setInterval(()=>{},1000);`;
  const owner = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
  const reader = owner.stdout.getReader();
  let id = "";
  try {
    const chunk = await reader.read(); id = Buffer.from(chunk.value!).toString().trim();
    const get = () => JSON.parse(readFileSync(join(dir, id + ".json"), "utf8"));
    await until(() => get().status === "running" && readFileSync(get().output, "utf8").trim().length > 0);
    const childPid = Number(readFileSync(get().output, "utf8").trim());
    owner.kill(9); await owner.exited;
    await until(() => get().status === "owner-exited" && !alive(childPid));
    const reopened = new Processes(dir, dir);
    expect(reopened.get(id).status).toBe("owner-exited");
    await reopened.close();
  } finally { owner.kill(); reader.releaseLock(); rmSync(dir, { recursive: true, force: true }); }
});

test("reopen reconciles a stale PID without signaling or silently restarting it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-stale-test-"));
  const id = crypto.randomUUID();
  writeFileSync(join(dir, id + ".json"), JSON.stringify({ id, name: "old", command: "sleep 60", cwd: dir,
    owner: 1, status: "running", output: join(dir, id + ".log"), timeoutMs: 60000, startedAt: 1, pid: process.pid }));
  const manager = new Processes(dir, dir);
  try {
    expect(manager.get(id).status).toBe("interrupted");
    expect((await manager.stop(id)).status).toBe("interrupted");
    expect(alive(process.pid)).toBe(true);
    expect(manager.list()).toHaveLength(1);
  } finally { await manager.close(); rmSync(dir, { recursive: true, force: true }); }
});
