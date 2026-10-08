import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === "EPERM"; }
}

export function sessionRoot(cwd: string, base = join(homedir(), ".pi", "harness")) {
  return join(base, createHash("sha256").update(realpathSync(resolve(cwd))).digest("hex").slice(0, 20));
}
export function listSessions(cwd: string, base?: string) {
  const root = sessionRoot(cwd, base);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(id => /^\d+-[a-f0-9-]+$/.test(id)).sort().reverse().map(id => {
    const dir = join(root, id);
    let title = "New conversation";
    const preview = join(dir, "preview.json");
    if (existsSync(preview)) title = JSON.parse(readFileSync(preview, "utf8")).title;
    return { id, dir, cwd: realpathSync(resolve(cwd)), title, createdAt: Number(id.split("-")[0]) };
  });
}
export function openSession(cwd: string, resume = false, base = join(homedir(), ".pi", "harness"), sessionId?: string) {
  cwd = realpathSync(resolve(cwd));
  const root = sessionRoot(cwd, base);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const latest = readdirSync(root).filter(n => /^\d+-[a-f0-9-]+$/.test(n)).sort().at(-1);
  if (resume && !latest) throw new Error("No Durable session exists for this project yet. Run pi first.");
  if (sessionId && (!/^\d+-[a-f0-9-]+$/.test(sessionId) || !existsSync(join(root, sessionId)))) throw new Error("Session ID is not valid for this project");
  const id = sessionId ?? (resume ? latest! : `${Date.now()}-${randomUUID()}`);
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, "lock");
  if (existsSync(lock)) {
    const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
    if (alive(owner.pid)) throw new Error(`Session is owned by live process ${owner.pid}`);
    rmSync(lock, { recursive: true });
  }
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  writeFileSync(join(dir, "project.json"), JSON.stringify({ cwd }), { mode: 0o600 });
  return { id, cwd, dir, release: () => rmSync(lock, { recursive: true, force: true }) };
}
