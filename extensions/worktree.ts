/**
 * pi-worktree — one isolated git worktree per pi session.
 *
 * Why: pi's `ctx.cwd` is read-only, so an extension cannot chdir the agent.
 * Instead this extension:
 *   1. On `session_start`, detects the repo and (unless already isolated)
 *      creates `.worktrees/<branch>` and makes it the *tool target*.
 *   2. Re-registers pi's own tool definitions (`read`, `bash`, `edit`, `write`,
 *      `grep`, `find`, `ls`) bound to that directory. pi resolves relative paths
 *      from the per-call `ctx.cwd`, so each definition is wrapped to report the
 *      worktree — the agent then really works in the worktree, instead of only
 *      getting `cd <wt> &&` prefixed commands. `before_agent_start` points the
 *      system prompt's working-directory section at the same path, and the
 *      user's own `!cmd` shell runs there too (`user_bash`).
 *      Path rewriting (`tool_call`) stays as fallback/correction.
 *   3. Adds a `/worktree` command family (new | list | use | rename | clean | finish | status).
 *
 * pi's own process/session cwd still points at the checkout pi was started in
 * (no API to change it) — `bin/pi-wt` launches pi directly inside the worktree
 * when you want the process cwd too.
 *
 * Env knobs:
 *   PI_WORKTREE_OFF=1      disable everything
 *   PI_WORKTREE_AUTO=0     don't auto-create on session_start (commands still work)
 *   PI_WORKTREE_BASE=.worktrees   worktree container dir (default .worktrees)
 *   PI_WORKTREE_STRICT=0   allow writes outside the worktree (default: rewrite + notify)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, DynamicBorder, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import {
	defaultBranchName,
	isLinkedWorktree,
	parseWorktreeList,
	sanitizeBranchName,
	worktreeName,
	worktreePathFor,
} from "./worktree-utils.mjs";

const exec = promisify(execFile);
const SUBCOMMANDS = ["new", "list", "use", "rename", "clean", "finish", "status"] as const;

// --- in-memory session state -------------------------------------------------

let activeWorktree: string | undefined;
let repoRootCache: string | undefined;
let runtime: ExtensionAPI | undefined;

// --- git plumbing ------------------------------------------------------------

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
	const { stdout } = await exec("git", args, { cwd, signal });
	return stdout.trim();
}

function gitError(err: unknown): string {
	const e = err as { stderr?: string; message?: string };
	const first = e.stderr?.trim().split("\n")[0] || e.message || String(err);
	return first.trim();
}

async function detectRepo(ctx: { cwd: string }): Promise<
	{ root: string; gitDir: string; gitCommon: string; branch: string } | null
> {
	try {
		const root = await git(ctx.cwd, ["rev-parse", "--show-toplevel"]);
		const gitDir = await git(ctx.cwd, ["rev-parse", "--git-dir"]);
		const gitCommon = await git(ctx.cwd, ["rev-parse", "--git-common-dir"]);
		const abs = (p: string) => (p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : join(ctx.cwd, p));
		let branch = "";
		try {
			branch = await git(ctx.cwd, ["branch", "--show-current"]);
		} catch {
			branch = await git(ctx.cwd, ["rev-parse", "--short", "HEAD"]);
		}
		return { root, gitDir: abs(gitDir), gitCommon: abs(gitCommon), branch };
	} catch {
		return null; // not a git repo
	}
}

async function ensureIgnored(root: string): Promise<boolean> {
	const base = process.env.PI_WORKTREE_BASE || ".worktrees";
	try {
		await git(root, ["check-ignore", "-q", base]);
		return true; // already ignored
	} catch {
		// not ignored — append to .gitignore (untracked helper, user commits if they want)
		try {
			const gi = await readFile(join(root, ".gitignore"), "utf8").catch(() => "");
			if (!gi.split("\n").some((l) => l.trim() === base || l.trim() === `/${base}`)) {
				await appendFile(join(root, ".gitignore"), `\n# pi-worktree isolation\n${base}/\n`);
			}
			return false;
		} catch {
			return false;
		}
	}
}

async function createWorktree(
	root: string,
	branchRaw: string,
): Promise<{ path: string; branch: string }> {
	const branch = sanitizeBranchName(branchRaw) || defaultBranchName();
	const wtPath = worktreePathFor(root, branch, process.env.PI_WORKTREE_BASE || ".worktrees");
	await ensureIgnored(root);
	// `git worktree add <path> -b <branch>` fails if branch exists → fall back to plain add
	try {
		await git(root, ["worktree", "add", wtPath, "-b", branch]);
	} catch (e) {
		const msg = gitError(e);
		if (/already exists/i.test(msg)) {
			await git(root, ["worktree", "add", wtPath, branch]);
		} else throw e;
	}
	return { path: wtPath, branch };
}

async function refreshWorktreeStatus(ctx: { cwd: string; ui?: any }): Promise<void> {
	try {
		if (activeWorktree) {
			let dirty = "";
			try {
				dirty = (await git(activeWorktree, ["status", "--porcelain"])).split("\n").filter(Boolean).length.toString();
			} catch {
				dirty = "?";
			}
			const name = worktreeName(activeWorktree) || "(unnamed)";
			ctx.ui?.setStatus?.("worktree", `wt:on · ${name} · ${dirty} changed`);
			return;
		}
		const info = await detectRepo(ctx);
		if (!info) {
			ctx.ui?.setStatus?.("worktree", undefined);
			return;
		}
		if (isLinkedWorktree(info.gitDir, info.gitCommon)) {
			ctx.ui?.setStatus?.("worktree", `wt:on · ${worktreeName(info.root) || info.branch || "detached"}`);
		} else {
			ctx.ui?.setStatus?.("worktree", `wt:off · ${info.branch || "?"}`);
		}
	} catch {
		ctx.ui?.setStatus?.("worktree", undefined);
	}
}

// --- tool binding (the core isolation) ----------------------------------------
//
// `ctx.cwd` is read-only for extensions, and pi's built-in tools resolve relative
// paths from the per-call ctx (`resolveReadPathAsync(path, ctx?.cwd || cwd)` in
// dist/core/tools/read.js), so the factory `cwd` alone does nothing. What moves the
// agent is re-registering the same definitions with an `execute` that shadows
// `ctx.cwd` with the worktree. Path rewriting below stays as the fallback for
// absolute paths that point into the original checkout.

type ToolFactory = (cwd: string, options?: any) => any;

/** pi's own tool factories — re-registering them keeps descriptions/renderers exact. */
const TOOL_FACTORY_EXPORTS: Record<string, string> = {
	read: "createReadToolDefinition",
	bash: "createBashToolDefinition",
	powershell: "createPowerShellToolDefinition",
	edit: "createEditToolDefinition",
	write: "createWriteToolDefinition",
	grep: "createGrepToolDefinition",
	find: "createFindToolDefinition",
	ls: "createLsToolDefinition",
};

let piModule: Promise<any> | undefined;
let boundCwd: string | undefined;

/** Load pi lazily so a renamed/absent export degrades to path rewriting instead of breaking the extension. */
function loadPiModule(): Promise<any> {
	piModule ??= import("@earendil-works/pi-coding-agent").catch(() => null);
	return piModule;
}

async function loadToolFactories(): Promise<Record<string, ToolFactory> | null> {
	const mod = await loadPiModule();
	if (!mod) return null;
	const out: Record<string, ToolFactory> = {};
	for (const [name, exportName] of Object.entries(TOOL_FACTORY_EXPORTS)) {
		if (typeof mod[exportName] === "function") out[name] = mod[exportName] as ToolFactory;
	}
	return Object.keys(out).length ? out : null;
}

/** Same tool, but every call sees `cwd` as its working directory. */
export function withCwd<T extends { execute: (...args: any[]) => any }>(def: T, cwd: string): T {
	return {
		...def,
		execute: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) =>
			def.execute(
				toolCallId,
				params,
				signal,
				onUpdate,
				Object.create(ctx ?? {}, { cwd: { value: cwd, enumerable: true, configurable: true } }),
			),
	} as T;
}

/**
 * Re-register the configured built-in tools bound to `cwd`. Returns the bound names.
 * Tools that are not currently active are registered with `defaultActive: false`, so a
 * session's tool loadout never changes just because isolation kicked in.
 * Mirrors the options pi builds its own definitions with (image resize, shell prefix/path).
 */
export async function bindToolsToCwd(
	pi: ExtensionAPI,
	cwd: string,
	injected?: Record<string, ToolFactory>,
): Promise<string[]> {
	if (boundCwd === cwd) return [];
	const factories = injected ?? (await loadToolFactories());
	if (!factories) return [];
	const active = new Set(pi.getActiveTools?.() ?? []);
	const configured = (pi.getAllTools?.() ?? []).map((tool) => tool.name);
	const names = (configured.length ? configured : [...active]).filter((name) => factories[name]);
	if (!names.length) return []; // nothing declared — leave the loadout alone
	const settings = (pi.getSettings?.() ?? {}) as Record<string, any>;
	const options: Record<string, any> = {
		read: { autoResizeImages: settings.images?.autoResize ?? true },
		bash: { commandPrefix: settings.shellCommandPrefix, shellPath: settings.shellPath },
	};
	const bound: string[] = [];
	for (const name of names) {
		try {
			const boundDef = withCwd(factories[name](cwd, options[name]), cwd);
			pi.registerTool({ ...boundDef, defaultActive: active.has(name) });
			bound.push(name);
		} catch {
			// older pi may refuse to re-register a built-in name — keep the rewrite fallback
		}
	}
	if (bound.length) boundCwd = cwd;
	return bound;
}

/** Activate `cwd` (or none) and rebind the tools that point at it. Returns the bound tool names. */
async function activateWorktree(cwd: string | undefined): Promise<string[]> {
	activeWorktree = cwd;
	if (!runtime || !cwd) return [];
	return bindToolsToCwd(runtime, cwd).catch(() => []);
}

// --- path rewriting (fallback) ------------------------------------------------

/** Tools whose path argument should be resolved into the worktree. */
const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

const norm = (p: string) => p.replace(/\\/g, "/");
const isAbs = (p: string) => /^([A-Za-z]:)?\//.test(norm(p));
const isWinPath = (p: string) => /^[A-Za-z]:\//.test(norm(p));

/** True when `p` is `dir` itself or inside it (boundary-aware, case-insensitive on Windows). */
function isInside(p: string, dir: string): boolean {
	let a = norm(p);
	let b = norm(dir).replace(/\/+$/, "");
	if (isWinPath(b)) {
		a = a.toLowerCase();
		b = b.toLowerCase();
	}
	return a === b || a.startsWith(b + "/");
}

function toWorktreePath(p: string, ctxCwd: string, root: string, wt: string): string {
	if (!p) return p;
	if (isInside(p, wt)) return p; // already inside the worktree — don't double-rewrite
	if (isAbs(p)) {
		// absolute path inside the original repo → mirror into worktree
		const rel = relative(root, p);
		if (rel && !rel.startsWith("..")) return join(wt, rel);
		return p; // outside repo entirely — leave alone
	}
	// relative path → resolve against worktree, not ctx.cwd
	void ctxCwd;
	return join(wt, p);
}

function prefixBash(cmd: string, wt: string): string {
	if (!cmd || !wt) return cmd;
	if (cmd.includes(wt) || norm(cmd).includes(norm(wt))) return cmd;
	// avoid double-prefix on repeated calls
	if (/^\s*cd\s+["']?.worktrees/.test(cmd)) return cmd;
	return `cd "${wt}" && ${cmd}`;
}

// --- dialogs ------------------------------------------------------------------

function selectDialog(ctx: ExtensionCommandContext, title: string, items: SelectItem[], hint?: string) {
	const padded = items.map((it) => ({ ...it, label: " " + it.label }));
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		if (hint) container.addChild(new Text(theme.fg("dim", hint), 1, 0));
		const list = new SelectList(padded, Math.min(padded.length, 12), {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		});
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

// --- subcommands ---------------------------------------------------------------

async function cmdNew(ctx: ExtensionCommandContext, nameArg: string): Promise<void> {
	const info = await detectRepo(ctx);
	if (!info) throw new Error("not a git repository");
	let name = nameArg.trim() || ((await ctx.ui.input("New worktree branch:", defaultBranchName())) ?? "");
	name = sanitizeBranchName(name);
	if (!name) return;
	const { path, branch } = await createWorktree(info.root, name);
	await activateWorktree(path);
	ctx.ui.notify(`Worktree ready: ${path} (branch ${branch}) — agent tools now run there`, "info");
	await refreshWorktreeStatus(ctx);
}

async function cmdList(ctx: ExtensionCommandContext): Promise<void> {
	const info = await detectRepo(ctx);
	if (!info) throw new Error("not a git repository");
	const porcelain = await git(info.root, ["worktree", "list", "--porcelain"]);
	const entries = parseWorktreeList(porcelain);
	if (!entries.length) {
		ctx.ui.notify("No worktrees", "info");
		return;
	}
	const items: SelectItem[] = entries.map((e) => ({
		value: e.path,
		label: `${e.path} · ${e.detached ? "detached" : e.branch || "bare"}`,
	}));
	const pick = await selectDialog(ctx, "Worktrees", items, "Enter to activate · Esc to exit");
	if (pick) {
		await activateWorktree(pick);
		ctx.ui.notify(`Active worktree → ${pick}`, "info");
		await refreshWorktreeStatus(ctx);
	}
}

async function cmdUse(ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
	const info = await detectRepo(ctx);
	if (!info) throw new Error("not a git repository");
	const want = rest.join(" ").trim();
	const porcelain = await git(info.root, ["worktree", "list", "--porcelain"]);
	const entries = parseWorktreeList(porcelain);
	const hit = entries.find((e) => e.path === want || e.branch === want || e.path.endsWith(want));
	if (!hit) throw new Error(`no such worktree: ${want || "(empty)"}`);
	await activateWorktree(hit.path);
	ctx.ui.notify(`Active worktree → ${hit.path}`, "info");
	await refreshWorktreeStatus(ctx);
}

/** Rename the active worktree: branch first, then the directory (`git worktree move`). */
async function cmdRename(ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
	const info = await detectRepo(ctx);
	if (!info) throw new Error("not a git repository");
	if (!activeWorktree) throw new Error("no active worktree — /worktree list first");
	const entry = parseWorktreeList(await git(info.root, ["worktree", "list", "--porcelain"])).find(
		(e) => e.path === activeWorktree,
	);
	if (!entry) throw new Error(`active worktree not in git worktree list: ${activeWorktree}`);
	const raw = rest.join(" ").trim() || ((await ctx.ui.input("Rename worktree to:", worktreeName(entry.path))) ?? "");
	const name = sanitizeBranchName(raw);
	if (!name) return;
	const newPath = worktreePathFor(info.root, name, process.env.PI_WORKTREE_BASE || ".worktrees");
	if (name === entry.branch && newPath === entry.path) return;
	if (entry.branch && entry.branch !== name) await git(entry.path, ["branch", "-m", name]);
	if (newPath !== entry.path) {
		try {
			await git(info.root, ["worktree", "move", entry.path, newPath]);
		} catch (e) {
			// branch is already renamed — keep the session usable on the old path
			await refreshWorktreeStatus(ctx);
			throw new Error(`branch renamed to ${name}, but moving the directory failed: ${gitError(e)}`);
		}
	}
	await activateWorktree(newPath);
	ctx.ui.notify(`Renamed → ${newPath} (branch ${name})`, "info");
	await refreshWorktreeStatus(ctx);
}

async function cmdClean(ctx: ExtensionCommandContext): Promise<void> {
	const info = await detectRepo(ctx);
	if (!info) throw new Error("not a git repository");
	await git(info.root, ["worktree", "prune"]);
	const porcelain = await git(info.root, ["worktree", "list", "--porcelain"]);
	const entries = parseWorktreeList(porcelain).filter((e) => e.path !== info.root);
	if (!entries.length) {
		ctx.ui.notify("Nothing to clean", "info");
		return;
	}
	const items: SelectItem[] = entries.map((e) => ({
		value: e.path,
		label: `${e.path} · ${e.branch}`,
	}));
	const pick = await selectDialog(ctx, "Remove worktree", items, "Enter to remove (disk) · Esc to cancel");
	if (!pick) return;
	const ok = await ctx.ui.confirm(`Remove ${pick}?`, "The worktree directory will be deleted. Uncommitted work is lost.");
	if (!ok) return;
	await git(info.root, ["worktree", "remove", "--force", pick]);
	if (activeWorktree === pick) {
		// the bound directory is gone — put the tools back on the session cwd
		activeWorktree = undefined;
		if (runtime) await bindToolsToCwd(runtime, ctx.cwd).catch(() => []);
	}
	ctx.ui.notify(`Removed ${pick}`, "info");
	await refreshWorktreeStatus(ctx);
}

async function cmdFinish(ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
	const info = await detectRepo(ctx);
	if (!info) throw new Error("not a git repository");
	const wt = rest.join(" ").trim() || activeWorktree;
	if (!wt) throw new Error("no active worktree — /worktree list first");
	const porcelain = await git(info.root, ["worktree", "list", "--porcelain"]);
	const entry = parseWorktreeList(porcelain).find((e) => e.path === wt || e.branch === wt);
	if (!entry || !entry.branch) throw new Error(`cannot determine branch for ${wt}`);
	const dirty = await git(entry.path, ["status", "--porcelain"]);
	if (dirty.trim()) throw new Error(`worktree ${entry.path} has uncommitted changes — commit first`);
	const ok = await ctx.ui.confirm(
		`Merge ${entry.branch} into ${info.branch || "current branch"}?`,
		`Runs: git merge --no-ff ${entry.branch} in ${info.root}`,
	);
	if (!ok) return;
	await git(info.root, ["merge", "--no-ff", entry.branch]);
	ctx.ui.notify(`Merged ${entry.branch} — remove the worktree with /worktree clean`, "info");
}

async function cmdStatus(ctx: ExtensionCommandContext): Promise<void> {
	const info = await detectRepo(ctx);
	if (!info) {
		ctx.ui.notify("Not a git repository", "warning");
		return;
	}
	const linked = isLinkedWorktree(info.gitDir, info.gitCommon);
	repoRootCache = info.root;
	const toolsAt = boundCwd ? (boundCwd === activeWorktree ? `${boundCwd} ✓` : boundCwd) : "(not bound — path rewriting only)";
	ctx.ui.notify(
		[
			`root: ${info.root}`,
			`session cwd: ${ctx.cwd}${linked ? " (already an isolated worktree ✓)" : ""}`,
			`active worktree: ${activeWorktree ?? "(none — agent uses session cwd)"}`,
			`agent tools: ${toolsAt}`,
			` TIP: run pi via bin/pi-wt to give pi's own process cwd the worktree.`,
		].join("\n"),
		"info",
	);
	await refreshWorktreeStatus(ctx);
}

async function runSubcommand(ctx: ExtensionCommandContext, sub: string, rest: string[]): Promise<void> {
	switch (sub) {
		case "new":
			return cmdNew(ctx, rest.join(" "));
		case "list":
			return cmdList(ctx);
		case "use":
			return cmdUse(ctx, rest);
		case "rename":
			return cmdRename(ctx, rest);
		case "clean":
			return cmdClean(ctx);
		case "finish":
			return cmdFinish(ctx, rest);
		case "status":
			return cmdStatus(ctx);
		default:
			throw new Error(`unknown subcommand: ${sub}`);
	}
}

// --- extension entry ------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	runtime = pi;
	pi.registerCommand("worktree", {
		description: "Isolated git worktrees: new | list | use | rename | clean | finish | status",
		getArgumentCompletions(prefix: string) {
			const items = SUBCOMMANDS.map((s) => ({ value: s, label: s }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length ? filtered : null;
		},
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (!sub) {
					const pick = await selectDialog(
						ctx,
						"Worktree",
						[
							{ value: "new", label: "New worktree…", description: "Create + activate" },
							{ value: "list", label: "List…", description: "Show + activate" },
							{ value: "status", label: "Status", description: "Show repo + active worktree" },
							{ value: "rename", label: "Rename…", description: "Rename active worktree branch + dir" },
							{ value: "clean", label: "Clean…", description: "Remove a worktree" },
							{ value: "finish", label: "Finish…", description: "Merge branch back" },
						],
						"Esc to exit",
					);
					if (!pick) return;
					await runSubcommand(ctx, pick, []);
					return;
				}
				if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
					ctx.ui.notify(`Unknown subcommand "${sub}" — usage: /worktree <${SUBCOMMANDS.join("|")}>`, "info");
					return;
				}
				await runSubcommand(ctx, sub, rest);
			} catch (err) {
				ctx.ui.notify(gitError(err), "error");
			}
		},
	});

	// Auto-isolate each fresh session into its own worktree.
	pi.on("session_start", async (_event, ctx) => {
		try {
			if (process.env.PI_WORKTREE_OFF === "1") return;
			const info = await detectRepo(ctx);
			if (!info) return; // not a repo — stay silent
			repoRootCache = info.root;
			if (isLinkedWorktree(info.gitDir, info.gitCommon)) {
				// Already isolated (e.g. launched via pi-wt) — tools already start here.
				await activateWorktree(ctx.cwd);
				await refreshWorktreeStatus(ctx as any);
				return;
			}
			if (process.env.PI_WORKTREE_AUTO === "0") {
				await refreshWorktreeStatus(ctx as any);
				return;
			}
			const branch = defaultBranchName();
			try {
				const { path } = await createWorktree(info.root, branch);
				const bound = await activateWorktree(path);
				if ((ctx as any).hasUI) {
					(ctx as any).ui.notify(
						`Isolated workspace ready: ${path}\n` +
							(bound.length
								? `Tools bound there: ${bound.join(", ")}. See /worktree status.`
								: "Tools not bound (this pi build) — using path rewriting. See /worktree status."),
						"info",
					);
				}
			} catch (e) {
				if ((ctx as any).hasUI) (ctx as any).ui.notify(`Worktree auto-create failed: ${gitError(e)}`, "warning");
			}
			await refreshWorktreeStatus(ctx as any);
		} catch {
			// never break session start
		}
	});

	// Point the working-directory section of the system prompt at the worktree: that is
	// where the tools (and therefore the model's relative paths) live, not pi's own cwd.
	pi.on("before_agent_start", async (event: any) => {
		try {
			if (!activeWorktree || process.env.PI_WORKTREE_OFF === "1") return undefined;
			const options = event?.systemPromptOptions;
			if (options && options.cwd !== activeWorktree) options.cwd = activeWorktree;
			return undefined;
		} catch {
			return undefined;
		}
	});

	// The user's own `!cmd` shell commands (`user_bash`) run in the worktree too, so the
	// footer status is not a lie about what the session is touching.
	pi.on("user_bash", async (event: any) => {
		try {
			const wt = activeWorktree;
			if (!wt || process.env.PI_WORKTREE_OFF === "1") return undefined;
			if (event?.cwd === wt) return undefined;
			const mod = await loadPiModule();
			const createOps = mod?.createLocalBashOperations;
			if (typeof createOps !== "function") return undefined;
			const settings = (pi.getSettings?.() ?? {}) as Record<string, any>;
			const ops = createOps({ shellPath: settings.shellPath });
			return {
				operations: {
					exec: (command: string, _cwd: string, options: any) => ops.exec(command, wt, options),
				},
			};
		} catch {
			return undefined;
		}
	});

	// Fallback/correction layer. pi's `tool_call` contract: mutate `event.input` in place;
	// return values are only for blocking (`{ block, reason, terminate }`). Returning a
	// new input object is ignored — that silently disabled isolation before.
	// With the tools bound above, relative paths already resolve inside the worktree;
	// this still matters for absolute paths that point into the original checkout.
	pi.on("tool_call", async (event: any, ctx: any) => {
		try {
			if (!activeWorktree || process.env.PI_WORKTREE_OFF === "1") return undefined;
			const root = repoRootCache ?? ctx?.cwd;
			const input = event?.input;
			if (!root || !input) return undefined;
			const name = event.toolName as string;
			if (FILE_TOOLS.has(name) && typeof input.path === "string") {
				const rewritten = toWorktreePath(input.path, ctx.cwd, root, activeWorktree);
				if (rewritten !== input.path) input.path = rewritten;
				return undefined;
			}
			if (name === "bash" && typeof input.command === "string") {
				// bound tools already start in the worktree — no `cd` prefix needed
				if (boundCwd !== activeWorktree) input.command = prefixBash(input.command, activeWorktree);
				if (typeof input.cwd === "string") input.cwd = activeWorktree;
				return undefined;
			}
			return undefined;
		} catch {
			return undefined;
		}
	});
}
