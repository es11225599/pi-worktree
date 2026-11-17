/**
 * Smoke test: load the worktree extension with a mock pi object + real temp git repo.
 * Verifies session_start auto-creates a worktree, tool_call rewrites into it, and that
 * bindToolsToCwd re-registers pi's tools with the worktree as the per-call cwd.
 *
 * Run: node --import jiti/register scripts/test-extension-load.ts
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import extension, { bindToolsToCwd } from "../extensions/worktree.ts";
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
	assert((handlers["before_agent_start"]?.length ?? 0) > 0, "subscribes before_agent_start (prompt cwd)");
	assert((handlers["user_bash"]?.length ?? 0) > 0, "subscribes user_bash");

	// --- tool binding: what actually moves the agent's cwd -------------------
	const registered: any[] = [];
	const bindPi = {
		getActiveTools: () => ["read", "bash", "edit", "write"],
		getAllTools: () => [{ name: "read" }, { name: "grep" }],
		getSettings: () => ({
			images: { autoResize: false },
			shellCommandPrefix: "source ~/.profile;",
			shellPath: "/bin/zsh",
		}),
		registerTool: (def: any) => void registered.push(def),
	} as unknown as ExtensionAPI;

	const stubFactory = (name: string) => (cwd: string, options?: any) => ({
		name,
		label: name,
		description: "stub",
		parameters: {},
		execute: async (_id: string, params: any, _s: any, _u: any, tctx: any) => ({
			content: [
				{
					type: "text",
					text: `${tctx.cwd}|${params.path ?? ""}|${options?.autoResizeImages}|${tctx.extra}`,
				},
			],
		}),
	});

	const boundNames = await bindToolsToCwd(bindPi, "/tmp/wt-bound", {
		read: stubFactory("read"),
		grep: stubFactory("grep"),
	});
	assert(boundNames.join(",") === "read,grep", `binds configured builtins (got ${boundNames.join(",")})`);
	assert(registered.length === 2, `re-registers each name once (got ${registered.length})`);
	const readDef = registered.find((d) => d.name === "read");
	const grepDef = registered.find((d) => d.name === "grep");
	assert(readDef?.defaultActive === true, "active tool stays active");
	assert(grepDef?.defaultActive === false, "inactive tool is registered without joining the loadout");
	const res: any = await readDef.execute("1", { path: "a.txt" }, undefined, undefined, {
		cwd: "/orig-repo",
		extra: 42,
	});
	assert(
		res.content[0].text === "/tmp/wt-bound|a.txt|false|42",
		`bound tool sees the worktree as cwd, keeps other ctx fields, mirrors session settings (got ${res.content[0].text})`,
	);
	assert((await bindToolsToCwd(bindPi, "/tmp/wt-bound", { read: stubFactory("read") })).length === 0, "rebinding the same cwd is a no-op");

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

	const grepEvent: any = { toolName: "grep", input: { pattern: "x", path: "a.txt" } };
	await toolCall(grepEvent, ctx);
	assert(
		dirname(String(grepEvent.input.path)) === dirname(String(writeEvent.input.path)),
		`grep paths resolve into the worktree too (got ${grepEvent.input.path})`,
	);

	const promptEvent: any = { systemPromptOptions: { cwd: tmp } };
	await handlers["before_agent_start"][0](promptEvent, ctx);
	assert(
		String(promptEvent.systemPromptOptions.cwd).includes(".worktrees"),
		`system prompt cwd points at the worktree (got ${promptEvent.systemPromptOptions.cwd})`,
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
