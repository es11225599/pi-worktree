/**
 * Smoke test: load the worktree extension with a mock pi object + real temp git repo.
 * Verifies session_start auto-creates a worktree and tool_call rewrites into it.
 *
 * Run: node --import jiti/register scripts/test-extension-load.ts
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import extension from "../extensions/worktree.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const handlers: Record<string, Array<(event: any, ctx: any) => Promise<any>>> = {};
const commands: Record<string, unknown> = {};

const mockPi = {
	on: (event: string, fn: any) => {
		(handlers[event] ??= []).push(fn);
	},
	registerCommand: (name: string, def: unknown) => {
		commands[name] = def;
	},
	registerTool: () => {},
	getActiveTools: () => [],
	getAllTools: () => [],
	setActiveTools: () => {},
	appendEntry: () => {},
	exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
} as unknown as ExtensionAPI;

// real temp repo so git plumbing runs for real
const tmp = mkdtempSync(join(tmpdir(), "pi-wt-test-"));
execSync("git init -b main", { cwd: tmp, stdio: "ignore" });
execSync("git config user.email t@t.t && git config user.name t", { cwd: tmp, stdio: "ignore" });
writeFileSync(join(tmp, "a.txt"), "hi\n");
execSync("git add . && git commit -qm init", { cwd: tmp, stdio: "ignore" });

const notes: string[] = [];
const ctx: any = {
	cwd: tmp,
	hasUI: true,
	ui: {
		notify: (msg: string, level: string) => void notes.push(`[${level}] ${String(msg).slice(0, 60)}`),
		setStatus: () => {},
		input: async () => undefined,
		confirm: async () => false,
		custom: async () => null,
	},
	sessionManager: { getBranch: () => [], getEntries: () => [], getCwd: () => tmp },
};

function assert(cond: boolean, message: string) {
	if (!cond) throw new Error(`ASSERT FAILED: ${message}`);
}

async function main() {
	await extension(mockPi);
	assert(commands["worktree"] !== undefined, "registers /worktree command");
	assert((handlers["session_start"]?.length ?? 0) > 0, "subscribes session_start");
	assert((handlers["tool_call"]?.length ?? 0) > 0, "subscribes tool_call");

	process.env.PI_WORKTREE_AUTO = "1";
	for (const fn of handlers["session_start"]) await fn({ reason: "startup" }, ctx);

	const toolCall = handlers["tool_call"][0];
	const r1 = await toolCall({ toolName: "write", input: { path: "foo.txt" } }, ctx);
	assert(r1 === undefined, "tool_call returns nothing (blocking is the only return contract)");

	// pi's contract is in-place mutation of event.input — assert the real behavior.
	const writeEvent: any = { toolName: "write", input: { path: "foo.txt" } };
	await toolCall(writeEvent, ctx);
	assert(
		String(writeEvent.input.path).includes(".worktrees"),
		`write path mutated into worktree (got ${writeEvent.input.path})`,
	);

	const bashEvent: any = { toolName: "bash", input: { command: "ls -la" } };
	await toolCall(bashEvent, ctx);
	assert(
		String(bashEvent.input.command).startsWith("cd "),
		`bash command mutated with cd (got ${bashEvent.input.command})`,
	);

	const readEvent: any = { toolName: "read", input: { path: writeEvent.input.path } };
	await toolCall(readEvent, ctx);
	assert(
		readEvent.input.path === writeEvent.input.path,
		"paths already inside worktree pass through untouched",
	);

	const relEvent: any = { toolName: "read", input: { path: "a.txt" } };
	await toolCall(relEvent, ctx);
	assert(
		dirname(String(relEvent.input.path)) === dirname(String(writeEvent.input.path)),
		`relative path resolves inside the worktree (got ${relEvent.input.path})`,
	);

	console.log("session_start + tool_call rewrite: OK");
	console.log("sample notifies:", notes.slice(0, 2).join(" | "));

	// cleanup temp repo (worktrees live under tmp, removed with it)
	try {
		execFileSync("git", ["worktree", "prune"], { cwd: tmp, stdio: "ignore" });
	} catch { /* best effort */ }
	rmSync(tmp, { recursive: true, force: true });
	console.log("EXTENSION LOAD OK");
}

await main();
