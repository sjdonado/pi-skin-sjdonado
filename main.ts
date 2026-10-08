#!/usr/bin/env bun

import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDurable } from "./runtime.ts";
import { runDurableTui } from "./tui.ts";
import { listMcpServers } from "./skin.ts";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { initTheme, theme } from "./node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

function parseArgs(argv: readonly string[]): { continueSession: boolean; check: boolean; sessionId?: string } {
	let continueSession = false;
	let check = false;
	let sessionId: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--continue" || arg === "-c") continueSession = true;
		else if (arg === "--check") check = true;
		else if (arg === "--session") {
			sessionId = argv[++i];
			if (sessionId === undefined) throw new Error("--session needs an ID");
		} else if (arg === "--help" || arg === "-h") {
			console.log(
				"pss [--continue | --session ID] [--check]\n\npss --check   startup/resource checks, no model calls\npi            upstream Pi CLI",
			);
			process.exit(0);
		} else throw new Error(`Unknown argument: ${arg}`);
	}
	return { continueSession, check, sessionId };
}

const options = parseArgs(process.argv.slice(2));
// --check opens a throwaway session in a temp dir so it never becomes the newest real session.
const checkDir = options.check ? mkdtempSync(join(tmpdir(), "pss-startup-check-")) : undefined;
let selected = options.sessionId;
let resume = options.continueSession;
while (true) {
	const durable = await openDurable({ cwd: checkDir, continueSession: resume, sessionId: selected });
	try {
		if (options.check) {
			const view = durable.view.current();
			let codemode = "untested";
			try {
				const sandbox = new CodemodeSandbox({ timeoutMs: 10_000, globals: [], tools: [] });
				try {
					const result = await sandbox.execute(`text("codemode-ok");`, {});
					if (!result.ok) throw new Error(result.error.message);
					codemode = "ok";
				} finally {
					await sandbox.close();
				}
			} catch (error) {
				throw new Error(
					`Codemode sandbox failed: ${error instanceof Error ? error.message : String(error)}. Run: bun install --ignore-scripts --no-save --cwd "${import.meta.dir}"`,
				);
			}
			console.log(
				JSON.stringify(
					{
						runtime: "pi-skin-sjdonado",
						models: view.models.map((m) => `${m.provider}/${m.modelId}`),
						notices: view.notices,
						mcp: listMcpServers(process.cwd()),
						codemode,
						session: view.session,
					},
					null,
					2,
				),
			);
			break;
		}
		if (!process.stdin.isTTY) {
			throw new Error("Interactive chat needs a terminal. Use --check for offline startup checks.");
		}
		const next = await runDurableTui(durable.view, durable.controller, durable.settings);
		if (next === undefined) {
			if (process.stdout.isTTY) {
				initTheme();
				const id = durable.view.current().session.id;
				process.stdout.write(`${theme.fg("dim", "To resume this session:")} pss --session ${id}\n`);
			}
			break;
		}
		selected = next;
		resume = false;
	} finally {
		const checkSession = options.check ? durable.view.current().session.directory : undefined;
		await durable.close();
		if (checkDir !== undefined) {
			rmSync(checkDir, { recursive: true, force: true });
			if (checkSession !== undefined) {
				rmSync(checkSession, { recursive: true, force: true });
				try {
					rmdirSync(dirname(checkSession));
				} catch {
					// Another session shares the directory; leave it alone.
				}
			}
		}
	}
}
