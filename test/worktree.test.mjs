import test from "node:test";
import assert from "node:assert/strict";
import {
	sanitizeBranchName,
	defaultBranchName,
	worktreePathFor,
	parseWorktreeList,
	isLinkedWorktree,
	worktreeName,
} from "../extensions/worktree-utils.mjs";

test("sanitizeBranchName strips illegal ref chars", () => {
	assert.equal(sanitizeBranchName("feature/my change!"), "feature/my-change!");
	assert.equal(sanitizeBranchName("  spaces  here  "), "spaces-here");
	assert.equal(sanitizeBranchName("bad~name^here?"), "badnamehere");
	assert.equal(sanitizeBranchName("-leading"), "leading");
	assert.equal(sanitizeBranchName(""), "");
	assert.equal(sanitizeBranchName("a/b/../c"), "a/b/c");
});

test("defaultBranchName is a safe pi/ branch", () => {
	const n = defaultBranchName(new Date("2026-01-02T03:04:05Z"), 7);
	assert.match(n, /^pi\/\d+-0007$/);
	assert.ok(sanitizeBranchName(n) === n);
});

test("worktreePathFor nests under base dir with slashes flattened", () => {
	assert.equal(
		worktreePathFor("/repo", "pi/abc-123"),
		"/repo/.worktrees/pi-abc-123",
	);
	assert.equal(
		worktreePathFor("/repo/", "feature/foo", "worktrees"),
		"/repo/worktrees/feature-foo",
	);
});

test("parseWorktreeList reads porcelain", () => {
	const out = [
		"worktree /repo",
		"HEAD abc123",
		"branch refs/heads/main",
		"",
		"worktree /repo/.worktrees/pi-1",
		"HEAD def456",
		"branch refs/heads/pi/1",
		"",
		"worktree /repo/.worktrees/det",
		"HEAD 789",
		"detached",
		"",
	].join("\n");
	const entries = parseWorktreeList(out);
	assert.equal(entries.length, 3);
	assert.equal(entries[0].branch, "main");
	assert.equal(entries[1].path, "/repo/.worktrees/pi-1");
	assert.equal(entries[2].detached, true);
});

test("isLinkedWorktree compares normalized dirs", () => {
	assert.equal(isLinkedWorktree("/repo/.git", "/repo/.git"), false);
	assert.equal(
		isLinkedWorktree("/repo/.git/worktrees/pi-1", "/repo/.git"),
		true,
	);
	assert.equal(isLinkedWorktree("", ""), false);
});

test("worktreeName is the leaf name on every platform", () => {
	// POSIX (Linux / macOS)
	assert.equal(worktreeName("/home/u/repo/.worktrees/pi-1"), "pi-1");
	assert.equal(worktreeName("/Users/u/repo/.worktrees/feature-foo"), "feature-foo");
	assert.equal(worktreeName("/repo/.worktrees/pi-1/"), "pi-1");
	// Windows (git prints /, but \\ can arrive from the OS)
	assert.equal(worktreeName("E:/Open Source Projects/pi-worktree/.worktrees/pi-202611171638-1918"), "pi-202611171638-1918");
	assert.equal(worktreeName("E:\\repo\\.worktrees\\pi-1"), "pi-1");
	assert.equal(worktreeName("E:\\repo\\.worktrees\\pi-1\\"), "pi-1");
	// mixed separators + edge cases
	assert.equal(worktreeName("E:/repo\\sub/pi-2"), "pi-2");
	assert.equal(worktreeName("pi-plain"), "pi-plain");
	assert.equal(worktreeName(""), "");
	assert.equal(worktreeName("/"), "");
	assert.equal(worktreeName("E:/"), "");
	assert.equal(worktreeName(undefined), "");
});
