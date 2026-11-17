#!/usr/bin/env node
/**
 * pi-wt — launch pi inside a fresh isolated git worktree.
 *
 * Usage:
 *   pi-wt [branch-name] [-- <pi args...>]
 *   pi-wt -- <pi args...>            # auto branch name, forward args to pi
 *   pi-wt feature/foo "list tests"   # branch + initial prompt
 *
 * What it does (mirrors the using-git-worktrees skill, step 0 → 1b):
 *   0. Detects repo root, GIT_DIR vs GIT_COMMON_DIR. If already inside a
 *      linked worktree, just execs pi (no nesting).
 *   1. Ensures `.worktrees/` exists and is git-ignored (appends .gitignore).
 *   2. Runs `git worktree add .worktrees/<leaf> -b <branch>`.
 *   3. Spawns `pi` with cwd inside the new worktree.
 *
 * Multiple pi sessions in the same repo each get their own worktree/branch.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sanitizeBranchName, defaultBranchName, worktreePathFor, isLinkedWorktree } from "../extensions/worktree-utils.mjs";

function sh(cwd, cmd, args) {
	return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function main() {
	const raw = process.argv.slice(2);
	// split on -- : left = branch?, right = pi args
	let branchPart = [];
	let piArgs = [];
	const dd = raw.indexOf("--");
	if (dd >= 0) {
		branchPart = raw.slice(0, dd);
		piArgs = raw.slice(dd + 1);
	} else {
		// heuristic: first token that doesn't start with - and isn't a pi flag value
		// simplest: treat ALL tokens as pi args unless a single bare token is given
		// `pi-wt feature/foo "prompt"` → branch=feature/foo, piArgs=["prompt"]
		if (raw.length >= 1 && !raw[0].startsWith("-") && (raw.length > 1 || !/\s/.test(raw[0]) || true)) {
			// ambiguous single prompt vs branch — prefer: explicit --branch/-b wins,
			// otherwise first token is branch only when a second token exists
			// or when it looks like a branch (no spaces).
			if (raw.length >= 2 && !raw[0].startsWith("-")) {
				branchPart = [raw[0]];
				piArgs = raw.slice(1);
			} else if (raw.length === 1 && !raw[0].startsWith("-") && !raw[0].includes(" ")) {
				branchPart = [raw[0]];
				piArgs = [];
			} else {
				piArgs = raw;
			}
		} else {
			// -b / --branch <name> form
			const bi = raw.findIndex((a) => a === "-b" || a === "--branch");
			if (bi >= 0 && raw[bi + 1]) {
				branchPart = [raw[bi + 1]];
				piArgs = [...raw.slice(0, bi), ...raw.slice(bi + 2)];
			} else {
				piArgs = raw;
			}
		}
	}

	const cwd = process.cwd();
	let root;
	try {
		root = sh(cwd, "git", ["rev-parse", "--show-toplevel"]);
	} catch {
		console.error("pi-wt: not a git repository (run inside one).");
		process.exit(1);
	}

	// Step 0 — already isolated?
	try {
		const gitDirRaw = sh(cwd, "git", ["rev-parse", "--git-dir"]);
		const gitCommonRaw = sh(cwd, "git", ["rev-parse", "--git-common-dir"]);
		const abs = (p) => (p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : join(cwd, p));
		if (isLinkedWorktree(abs(gitDirRaw), abs(gitCommonRaw))) {
			console.error(`pi-wt: already in a linked worktree (${cwd}) — launching pi here.`);
			return launchPi(cwd, piArgs);
		}
	} catch { /* ignore, fall through */ }

	const base = process.env.PI_WORKTREE_BASE || ".worktrees";
	const rawBranch = branchPart.join(" ").trim() || process.env.PI_WORKTREE_BRANCH || defaultBranchName();
	const branch = sanitizeBranchName(rawBranch) || defaultBranchName();
	const wtPath = worktreePathFor(root, branch, base);

	// ensure ignored (append .gitignore, don't commit — tell the user)
	try {
		execFileSync("git", ["check-ignore", "-q", base], { cwd: root, stdio: "ignore" });
	} catch {
		try {
			const giPath = join(root, ".gitignore");
			const gi = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
			if (!gi.split("\n").some((l) => l.trim() === base || l.trim() === `/${base}` || l.trim() === `${base}/`)) {
				appendFileSync(giPath, `\n# pi-worktree isolation\n${base}/\n`);
				console.error(`pi-wt: added \`${base}/\` to .gitignore (commit it to silence this).`);
			}
		} catch (e) {
			console.error(`pi-wt: warning — could not update .gitignore: ${e.message}`);
		}
	}

	if (!existsSync(wtPath)) {
		try {
			execFileSync("git", ["worktree", "add", wtPath, "-b", branch], { cwd: root, stdio: "inherit" });
		} catch (e) {
			// branch may already exist → attach instead of -b
			console.error(`pi-wt: 'worktree add -b' failed, retrying without -b…`);
			execFileSync("git", ["worktree", "add", wtPath, branch], { cwd: root, stdio: "inherit" });
		}
	} else {
		console.error(`pi-wt: reusing existing worktree ${wtPath}`);
	}

	console.error(`pi-wt: launching pi in ${wtPath} (branch ${branch})`);
	return launchPi(wtPath, piArgs);
}

function launchPi(cwd, args) {
	const child = spawn("pi", args, { cwd: resolve(cwd), stdio: "inherit", shell: process.platform === "win32" });
	child.on("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		else process.exit(code ?? 0);
	});
	child.on("error", (err) => {
		console.error(`pi-wt: failed to launch pi: ${err.message}`);
		process.exit(1);
	});
}

main();
