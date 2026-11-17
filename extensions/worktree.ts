/**
 * pi-worktree — one isolated git worktree per pi session.
 *
 * Why: pi's `ctx.cwd` is read-only, so an extension cannot chdir the agent.
 * Instead this extension:
 *   1. On `session_start`, detects the repo and (unless already isolated)
 *      creates `.worktrees/<branch>` and makes it the *tool target*.
 *   2. Rewrites `read`/`write`/`edit` paths and prefixes `bash` commands so
 *      the agent transparently works inside the worktree even though pi's
 *      visible cwd still points at the original checkout.
 *   3. Adds a `/worktree` command family (new | list | use | clean | finish | status).
 *
 * Pair with `bin/pi-wt` (true isolation: the wrapper creates the worktree
 * FIRST and launches `pi` with cwd inside it) when you want the whole
 * session — including shell tool defaults — to start in the worktree.
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
const SUBCOMMANDS = ["new", "list", "use", "clean", "finish", "status"] as const;

// --- in-memory session state -------------------------------------------------

let activeWorktree: string | undefined;
let repoRootCache: string | undefined;

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

// --- path rewriting (the core isolation) -------------------------------------

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
	activeWorktree = path;
	ctx.ui.notify(`Worktree ready: ${path} (branch ${branch}) — agent file ops now target it`, "info");
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
	await selectDialog(ctx, "Worktrees", items, "Enter to activate · Esc to exit").then((pick) => {
		if (pick) {
			activeWorktree = pick;
			ctx.ui.notify(`Active worktree → ${pick}`, "info");
			void refreshWorktreeStatus(ctx);
		}
	});
}

async function cmdUse(ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
	const info = await detectRepo(ctx);
	if (!info) throw new Error("not a git repository");
	const want = rest.join(" ").trim();
	const porcelain = await git(info.root, ["worktree", "list", "--porcelain"]);
	const entries = parseWorktreeList(porcelain);
	const hit = entries.find((e) => e.path === want || e.branch === want || e.path.endsWith(want));
	if (!hit) throw new Error(`no such worktree: ${want || "(empty)"}`);
	activeWorktree = hit.path;
	ctx.ui.notify(`Active worktree → ${hit.path}`, "info");
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
	if (activeWorktree === pick) activeWorktree = undefined;
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
	ctx.ui.notify(
		[
			`root: ${info.root}`,
			`here: ${ctx.cwd}${linked ? " (already an isolated worktree ✓)" : ""}`,
			`active worktree: ${activeWorktree ?? "(none — agent uses session cwd)"}`,
			` TIP: run pi via bin/pi-wt for true cwd isolation.`,
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
	pi.registerCommand("worktree", {
		description: "Isolated git worktrees: new | list | use | clean | finish | status",
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
				// Already isolated (e.g. launched via pi-wt) — just track it.
				activeWorktree = ctx.cwd;
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
				activeWorktree = path;
				if ((ctx as any).hasUI) {
					(ctx as any).ui.notify(
						`Isolated workspace ready: ${path}\nAll read/write/edit + bash now target it. See /worktree status.`,
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

	// Transparently retarget file + shell tools into the active worktree.
	// pi's `tool_call` contract: mutate `event.input` in place; return values are
	// only for blocking (`{ block, reason, terminate }`). Returning a new input
	// object is ignored — that silently disabled isolation before.
	pi.on("tool_call", async (event: any, ctx: any) => {
		try {
			if (!activeWorktree || process.env.PI_WORKTREE_OFF === "1") return undefined;
			const root = repoRootCache ?? ctx?.cwd;
			const input = event?.input;
			if (!root || !input) return undefined;
			const name = event.toolName as string;
			if ((name === "read" || name === "write" || name === "edit") && input.path) {
				input.path = toWorktreePath(input.path as string, ctx.cwd, root, activeWorktree);
				return undefined;
			}
			if (name === "bash" && typeof input.command === "string") {
				input.command = prefixBash(input.command, activeWorktree);
				if (typeof input.cwd === "string") input.cwd = activeWorktree;
				return undefined;
			}
			return undefined;
		} catch {
			return undefined;
		}
	});
}
