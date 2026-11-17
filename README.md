# pi-worktree

One isolated git worktree per pi session — run many pi sessions in the same repo without them overwriting each other.

> Limitation, stated up front: **pi extensions cannot change pi's own `ctx.cwd`** (it is read-only, and the footer follows the session cwd). So this package isolates you two ways:
>
> 1. **`pi-wt` launcher (true isolation)** — creates `.worktrees/<branch>` *first*, then launches `pi` with cwd inside it. The whole session, including pi's own cwd and any process you spawn yourself, starts in the worktree.
> 2. **Extension guard (in-session binding)** — if you start `pi` in the main checkout, the extension auto-creates a worktree on `session_start` and **re-registers pi's own built-in tools bound to it**: the agent's tools run with the worktree as their working directory (bash `pwd` *is* the worktree, no `cd` prefix), the system prompt reports the worktree as cwd, and user `!` shell commands run there too. Only pi's process cwd stays on the checkout. The footer shows `wt:on · <name>`.

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

**Better — plain `pi` in the main checkout:**

- On session start the extension auto-creates `.worktrees/pi-<stamp>`, binds `read`/`write`/`edit`/`grep`/`find`/`ls`/`bash`/`powershell` to it, points the system prompt's cwd at it, and routes your `!` commands there. Run `/worktree status` to see the binding (`agent tools: … ✓`).
- Set `PI_WORKTREE_AUTO=0` to start unbound and pick a worktree with `/worktree use`.

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

- `session_start`: `git rev-parse --show-toplevel / --git-dir / --git-common-dir`. `gitDir !== gitCommonDir` ⇒ already isolated, track `ctx.cwd`. Else `git worktree add .worktrees/<branch> -b <branch>` (falls back to attach when the branch exists). Ensures `.worktrees/` is git-ignored (appends `.gitignore`, never commits for you). The new worktree is then activated.
- Activation: re-registers pi's built-in tool definitions (`create{Read,Bash,Edit,Write,Grep,Find,Ls}ToolDefinition` from `@earendil-works/pi-coding-agent`) with the worktree as their factory cwd, and wraps each `execute` so the per-call `ctx.cwd` reports the worktree — pi's tools prefer `ctx.cwd`, so this is what makes relative paths and `pwd` land in the worktree. Definitions are byte-for-byte pi's own (labels, params, renderers); only the working directory differs. Inactive tools stay inactive (`defaultActive: false`).
- `before_agent_start`: sets `systemPromptOptions.cwd` to the active worktree, so the prompt and the model's own `pwd` agree.
- `user_bash`: runs your `!` commands through `createLocalBashOperations()` with cwd pinned to the worktree.
- `tool_call`: fallback for pi builds where binding fails — `read`/`write`/`edit`/`grep`/`find`/`ls` paths are rewritten under the active worktree, and `bash.command` is prefixed `cd "<wt>" && …` *only* when the tools could not be bound.
- Footer: `wt:on · <leaf> · N changed` inside a worktree, `wt:off · <branch>` outside one, refreshed on session start and after every subcommand.

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
extensions/worktree.ts        # session_start + before_agent_start + user_bash + tool_call + /worktree family
extensions/worktree-utils.mjs # pure helpers (sanitize, parse porcelain) — zero deps
bin/pi-wt.mjs                 # launcher: create worktree, then spawn pi inside it
test/worktree.test.mjs        # node:test self-check
scripts/test-extension-load.ts # loads the extension, exercises binding + rewriting
```

## Dev

```bash
npm test
```

## Known limitations

- pi's own process cwd cannot be changed from an extension, so the footer's cwd chip and `git` run from your shell still point at the checkout. Use `pi-wt` when you need the process itself inside the worktree. The in-session binding covers the agent's tools, the prompt, and `!` commands; it does not chdir pi.
- Binding needs pi's tool factories (`create*ToolDefinition`). On a pi build that does not export them, the package degrades to path rewriting + `cd` prefixes, which any command that starts with its own `cd` can escape.
- No remote-branch worktrees, no `git worktree lock/unlock` UI.
- `finish` refuses to merge dirty worktrees — commit inside the session first.
