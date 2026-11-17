/**
 * Pure worktree helpers (dependency-free, testable on plain Node).
 * The .ts extension imports these so `npm test` runs with zero tooling.
 */

/**
 * Sanitize a user-supplied string into a safe git branch / directory name.
 * - trims, lowercases spaces to dashes
 * - strips characters illegal in git refs: ~ ^ : ? * [ \ space + leading - / .
 * - collapses repeated dashes, trims leading/trailing dashes/dots/slashes
 * Returns "" when nothing usable remains.
 */
export function sanitizeBranchName(input) {
	if (typeof input !== "string") return "";
	let s = input.trim().replace(/\s+/g, "-");
	// strip illegal ref chars + backslash + leading dash/dot/slash handled below
	s = s.replace(/[~^:?*[\]\\ ]/g, "");
	s = s.replace(/\/+/g, "/");
	s = s.replace(/-+/g, "-");
	s = s.replace(/^[/.-]+|[/.-]+$/g, "");
	// disallow components like .. and trailing .lock
	s = s
		.split("/")
		.filter((p) => p && p !== "." && p !== ".." && !p.endsWith(".lock"))
		.join("/");
	return s.slice(0, 120);
}

/** Default worktree branch name for a new pi session. */
export function defaultBranchName(now = new Date(), rand = Math.floor(Math.random() * 10000)) {
	const stamp = now
		.toISOString()
		.replace(/[-:T]/g, "")
		.slice(0, 12); // YYYYMMDDHHmm
	return `pi/${stamp}-${String(rand).padStart(4, "0")}`;
}

/** Where to place the worktree given the repo root + branch. */
export function worktreePathFor(root, branch, baseDir = ".worktrees") {
	const safe = sanitizeBranchName(branch) || "pi-session";
	const leaf = safe.replace(/\//g, "-");
	// strip trailing slash from root
	const r = root.replace(/\/+$/, "");
	return `${r}/${baseDir}/${leaf}`;
}

/**
 * Parse `git worktree list --porcelain` into [{ path, branch, bare, detached }].
 */
export function parseWorktreeList(porcelain) {
	const entries = [];
	let cur = null;
	for (const rawLine of porcelain.split("\n")) {
		const line = rawLine.trim();
		if (!line) {
			if (cur?.path) entries.push(cur);
			cur = null;
			continue;
		}
		if (line.startsWith("worktree ")) {
			if (cur?.path) entries.push(cur);
			cur = { path: line.slice(9), branch: "", bare: false, detached: false };
		} else if (line.startsWith("branch ")) {
			if (cur) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
		} else if (line === "bare") {
			if (cur) cur.bare = true;
		} else if (line === "detached") {
			if (cur) cur.detached = true;
		}
	}
	if (cur?.path) entries.push(cur);
	return entries;
}

/** True when gitDir !== gitCommonDir (i.e. already inside a linked worktree). */
export function isLinkedWorktree(gitDir, gitCommonDir) {
	if (!gitDir || !gitCommonDir) return false;
	const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");
	return norm(gitDir) !== norm(gitCommonDir);
}
