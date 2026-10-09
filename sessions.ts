import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** One session directory holding `session.sqlite`, locked by this process. */
export interface SessionLocation {
	id: string;
	directory: string;
	database: string;
	cwd: string;
	created: boolean;
	release(): Promise<void>;
}

/** A new session for `cwd`, its newest one with `continueSession`, or the given id. */
export async function selectSession(
	cwdInput: string,
	continueSession: boolean,
	sessionId?: string,
): Promise<SessionLocation> {
	const cwd = await realpath(resolve(cwdInput));
	const root = join(
		getAgentDir(),
		"experimental",
		"pss-sessions",
		createHash("sha256").update(cwd).digest("hex").slice(0, 24),
	);
	await mkdir(root, { recursive: true });

	let directory: string;
	let created = false;
	if (sessionId !== undefined) {
		if (!/^\d{13}-[0-9a-f-]{36}$/u.test(sessionId)) throw new Error(`Not a session id: ${sessionId}`);
		directory = join(root, sessionId);
		try {
			if (!(await stat(directory)).isDirectory()) throw new Error();
		} catch {
			throw new Error(`No such session for ${cwd}: ${sessionId}`);
		}
	} else if (continueSession) {
		const newest = (await listSessions(cwd)).at(-1);
		if (newest === undefined) throw new Error(`No pss session exists for ${cwd}`);
		directory = newest.directory;
	} else {
		directory = join(root, `${String(Date.now()).padStart(13, "0")}-${randomUUID()}`);
		await mkdir(directory);
		created = true;
	}

	let release: () => Promise<void>;
	try {
		// A lock left by a crashed process goes stale after 10 s; wait that long before giving up.
		release = await lockfile.lock(directory, {
			realpath: false,
			retries: { retries: 12, minTimeout: 1000, maxTimeout: 1000 },
		});
	} catch (error) {
		throw new Error(`Session is already open in another process: ${directory}`, { cause: error });
	}
	return { id: basename(directory), directory, database: join(directory, "session.sqlite"), cwd, created, release };
}

/** Every session directory for `cwd`, oldest first, with display names. */
export async function listSessions(cwdInput: string): Promise<{ id: string; directory: string; name?: string }[]> {
	const cwd = await realpath(resolve(cwdInput));
	const root = join(
		getAgentDir(),
		"experimental",
		"pss-sessions",
		createHash("sha256").update(cwd).digest("hex").slice(0, 24),
	);
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const sessions = [];
	for (const entry of entries
		.filter((e) => e.isDirectory() && /^\d{13}-[0-9a-f-]{36}$/u.test(e.name))
		.map((e) => e.name)
		.sort()) {
		let name: string | undefined;
		try {
			name = (await readFile(join(root, entry, "name"), "utf8")).trim() || undefined;
		} catch {
			name = undefined;
		}
		sessions.push({ id: entry, directory: join(root, entry), name });
	}
	return sessions;
}

/** A display name for a session directory, shown in `/resume` and `/session`. */
export async function sessionName(directory: string): Promise<string | undefined> {
	try {
		return ((await readFile(join(directory, "name"), "utf8")).trim() || undefined) as string | undefined;
	} catch {
		return undefined;
	}
}

/** Persist a display name for a session directory. */
export async function setSessionName(directory: string, name: string): Promise<void> {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("Usage: /name <name>");
	await writeFile(join(directory, "name"), trimmed);
}
