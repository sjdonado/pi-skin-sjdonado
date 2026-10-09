import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

export type Job = {
	id: string; name: string; command: string; cwd: string; owner: number;
	status: string; output: string; timeoutMs: number; startedAt: number;
	pid?: number; exitCode?: number; finishedAt?: number;
};
export class Processes {
	private children = new Map<string, ReturnType<typeof spawn>>();
	private closing = false;
	constructor(readonly dir: string, readonly cwd: string, readonly notify: (job: Job) => void = () => {}) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		// A prior host's supervisors clean up through pipe EOF. Never trust or signal persisted PIDs.
		for (const job of this.list()) if (["running", "starting"].includes(job.status)) {
			job.status = "interrupted"; this.save(job);
		}
	}
	private file(id: string) {
		if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid process ID");
		return join(this.dir, id + ".json");
	}
	private save(job: Job) {
		writeFileSync(this.file(job.id) + ".tmp", JSON.stringify(job), { mode: 0o600 });
		renameSync(this.file(job.id) + ".tmp", this.file(job.id));
	}
	get(id: string): Job { return JSON.parse(readFileSync(this.file(id), "utf8")); }
	list(): Job[] {
		return readdirSync(this.dir).filter(n => n.endsWith(".json")).map(n => this.get(n.slice(0, -5)));
	}
	start(command: string, name: string, owner: number, timeoutMs = 60 * 60 * 1000): Job {
		if (this.closing) throw new Error("Harness is closing");
		if (this.children.size >= 4) throw new Error("Four background jobs are already active; stop one before starting another");
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw new Error("Timeout must be 1 ms to 24 hours");
		const id = randomUUID();
		const job: Job = { id, name, command, owner, cwd: this.cwd, timeoutMs,
			status: "starting", output: join(this.dir, id + ".log"), startedAt: Date.now() };
		writeFileSync(job.output, "", { mode: 0o600 }); this.save(job);
		const child = spawn(process.execPath, [join(import.meta.dir, "process-worker.ts"), this.file(id)], {
			cwd: this.cwd, stdio: ["pipe", "ignore", "ignore"],
		});
		this.children.set(id, child);
		child.on("error", error => { job.status = "failed"; this.save(job); this.children.delete(id); });
		child.on("exit", () => { this.children.delete(id); if (!this.closing) this.notify(this.get(id)); });
		return job;
	}
	logs(id: string): string {
		const file = this.get(id).output;
		const size = statSync(file).size, bytes = Buffer.alloc(Math.min(size, 50 * 1024));
		const fd = openSync(file, "r");
		try { readSync(fd, bytes, 0, bytes.length, size - bytes.length); } finally { closeSync(fd); }
		return bytes.toString();
	}
	async stop(id: string) {
		const child = this.children.get(id);
		if (!child) return this.get(id); // Historical job; never kill its potentially reused PID.
		const stopped = new Promise<void>(resolve => child.once("exit", () => resolve()));
		child.stdin?.end();
		await stopped;
		return this.get(id);
	}
	async stopOwner(owner: number) {
		await Promise.all(this.list().filter(j => j.owner === owner && this.children.has(j.id)).map(j => this.stop(j.id)));
	}
	async stopAll() {
		await Promise.all([...this.children.keys()].map(id => this.stop(id)));
		return this.list().filter(j => ["starting", "running"].includes(j.status)).length;
	}
	async close() { this.closing = true; await Promise.all([...this.children.keys()].map(id => this.stop(id))); }
}

export function processTools(manager: Processes) {
	const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
	return defineExtension({ name: "processes", tools: [
		defineTool({ name: "bg_start", description: "Start an owned background shell terminal. Use for servers, watchers and long commands while you keep working. Stops on conversation abort or harness exit; never silently restarts.",
			parameters: Type.Object({ command: Type.String(), name: Type.String(), timeoutMs: Type.Optional(Type.Number()) }),
			execute: async (args, api) => result(manager.start(args.command, args.name, api.conversationId, args.timeoutMs)) }),
		defineTool({ name: "bg_list", description: "List current and historical background terminals, including interrupted jobs.", parameters: Type.Object({}), replay: "safe",
			execute: async () => result(manager.list()) }),
		defineTool({ name: "bg_logs", description: "Read bounded output of a background terminal.", parameters: Type.Object({ id: Type.String() }), replay: "safe",
			execute: async args => result(manager.logs(args.id)) }),
		defineTool({ name: "bg_stop", description: "Stop an owned background terminal and its descendants.", parameters: Type.Object({ id: Type.String() }),
			execute: async args => result(await manager.stop(args.id)) }),
	] });
}
