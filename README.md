# pi-worktree

One isolated git worktree per pi session — run many pi sessions in the same repo without them overwriting each other.

> Limitation, stated up front: **pi extensions cannot change `ctx.cwd`** (it is read-only). So this package isolates you two ways:
>
> 1. **`pi-wt` launcher (true isolation)** — creates `.worktrees/<branch>` *first*, then launches `pi` with cwd inside it. The whole session, including shell defaults, starts in the worktree.
> 2. **Extension guard (transparent fallback)** — if you start `pi` in the main checkout, the extension auto-creates a worktree on `session_start` and rewrites `read`/`write`/`edit` paths + prefixes `bash` with `cd <worktree>`, so the agent still works in the worktree. The footer shows `wt:<name>`.

## Install

```bash
pi install git:github.com/es11225599/pi-worktree.git
# or raw URL
pi install https://github.com/es11225599/pi-worktree
# or local dev
cd /path/to/pi-worktree
pi install .
```

Try without installing:

```bash
cp extensions/worktree.ts ~/.pi/agent/extensions/
```

## Use

**Preferred — launcher (each terminal = one session = one worktree):**

```bash
pi-wt feature/foo            # new worktree + branch, launch pi in it
pi-wt feature/foo -- --model sonnet   # forward flags to pi
pi-wt                        # auto branch pi/YYYYMMDDHHmm-XXXX
```

**Fallback — plain `pi` in the main checkout:**

- On session start the extension auto-creates `.worktrees/pi-<stamp>` and retargets tools into it. Run `/worktree status` to see where you are.

## Commands

```
/worktree            # interactive menu
/worktree new [name] # create + activate
/worktree list       # show + activate
/worktree use <path|branch>
/worktree clean      # prune + remove a worktree (asks first)
/worktree finish [path]  # merge worktree branch back with --no-ff
/worktree status     # root, cwd, active worktree
```

## Env knobs

| Var | Effect |
| --- | --- |
| `PI_WORKTREE_OFF=1` | disable extension entirely |
| `PI_WORKTREE_AUTO=0` | don't auto-create on session start (commands still work) |
| `PI_WORKTREE_BASE` | container dir (default `.worktrees`) |
| `PI_WORKTREE_STRICT=0` | reserved: allow writes outside the worktree |
| `PI_WORKTREE_BRANCH` | force branch name for `pi-wt` auto mode |

## How it works

- `session_start`: `git rev-parse --show-toplevel / --git-dir / --git-common-dir`. `gitDir !== gitCommonDir` ⇒ already isolated, track `ctx.cwd`. Else `git worktree add .worktrees/<branch> -b <branch>` (falls back to attach when the branch exists). Ensures `.worktrees/` is git-ignored (appends `.gitignore`, never commits for you).
- `tool_call`: `read`/`write`/`edit` relative-or-in-repo paths are rewritten under the active worktree; `bash.command` is prefixed `cd "<wt>" && …` (skipped when already referencing it). Nothing else is touched.
- Footer: `wt:<leaf> · N changed`, refreshed on session start and after every subcommand.

## Merge back

```bash
/worktree finish     # merges active worktree branch --no-ff into current branch
/worktree clean      # removes the worktree directory
# or manually:
git -C <repo> merge --no-ff pi/xxxx
git -C <repo> worktree remove --force .worktrees/pi-xxxx
```

## Layout

```
package.json                  # pi manifest (extensions: ["./extensions"]), keyword "pi-package"
extensions/worktree.ts        # session_start + tool_call + /worktree family
extensions/worktree-utils.mjs # pure helpers (sanitize, parse porcelain) — zero deps
bin/pi-wt.mjs                 # launcher: create worktree, then spawn pi inside it
test/worktree.test.mjs        # node:test self-check
```

## Dev

```bash
npm test
```

## Known limitations

- The extension cannot chdir pi itself — only `pi-wt` gives true cwd isolation. The in-session fallback rewrites tool inputs, which covers agent file/shell tools but not processes the user spawns manually.
- No remote-branch worktrees, no `git worktree lock/unlock` UI.
- `finish` refuses to merge dirty worktrees — commit inside the session first.
