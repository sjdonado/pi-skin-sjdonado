// A separate supervisor owns the shell group. Parent pipe EOF also arrives after SIGKILL.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";

// argv[2] in both modes: dev runs `bun process-worker.ts <job>`, while compiled
// binaries run with argv ["bun", "/$bunfs/root/<entry>", "<job>"].
const file = process.argv[2];
if (!file || !file.endsWith(".json") || !existsSync(file)) {
	console.error(`process-worker: missing job file argument in ${JSON.stringify(process.argv.slice(1))}`);
	process.exit(2);
}
const job = JSON.parse(readFileSync(file, "utf8"));
function save() {
	writeFileSync(file + ".tmp", JSON.stringify(job), { mode: 0o600 });
	renameSync(file + ".tmp", file);
}
const output = createWriteStream(job.output, { flags: "a", mode: 0o600 });
const child = spawn("/bin/bash", ["-c", job.command], {
	cwd: job.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
});
job.pid = child.pid; job.status = "running"; save();
let reason = "completed";
let bytes = 0;
let escalation: ReturnType<typeof setTimeout> | undefined;
function stop(next = "stopped") {
	if (reason !== "completed") return;
	reason = next;
	try { process.kill(-child.pid!, "SIGTERM"); } catch {}
	escalation = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 1500);
}
const deadline = setTimeout(() => stop("timed-out"), job.timeoutMs);
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => {
	bytes += chunk.length;
	if (bytes > 20 * 1024 * 1024) stop("output-limit");
	else output.write(chunk);
});
process.stdin.resume();
process.stdin.on("end", () => stop("owner-exited"));
process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop());
child.on("error", error => { job.error = error.message; });
child.on("exit", () => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} });
child.on("close", code => {
	// Kill remaining descendants even if the shell itself exited successfully.
	try { process.kill(-child.pid!, "SIGKILL"); } catch {}
	clearTimeout(deadline); if (escalation) clearTimeout(escalation);
	output.end(() => {
		job.status = reason === "completed" ? (code === 0 ? "completed" : "failed") : reason;
		job.exitCode = code; job.finishedAt = Date.now(); save();
		process.exit(0);
	});
});
