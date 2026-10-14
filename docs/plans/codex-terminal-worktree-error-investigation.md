# Investigation — terminal open fails when a task's worktree drifted off `task.branch`

| Field | Value |
| --- | --- |
| Date | 2026-10-12 |
| Change | Opening a terminal tab on a worktree-isolated task whose checkout is no longer on the recorded `task.branch` fails with `worktree is on "<live>" not "<task.branch>" and could not be switched: … Your local changes to the following files would be overwritten by checkout …`. Decide (a) whether a terminal open may ever mutate the worktree's branch and (b) what every other `prepareWorkdir` caller should do when the worktree's HEAD has drifted off the recorded branch. |
| Agents | none (pipeline step forbade subagents; research + 1 spike run inline) |
| Flags | none |
| Branch | fix/codex-terminal-worktree-error |
| Evidence | Screenshot `~/Desktop/Screenshot 2026-10-12 at 2.18.19 AM.png`: a red toast with the error above, live branch `implement/window-application-recording`, recorded branch `feature/record-window-or-application`, ~20 Swift/test/doc files listed as "would be overwritten", in a ZoomIt-Mac repo task driven by codex. |

## 1. What we know

### The code path that produced the toast

- RunPanel's TERMINAL section (`src/mainview/components/kanban/RunPanel.tsx:3851`, `<TerminalsSection key={`terminals-${task.id}`}>`) mounts `TerminalView`; its `+` handler `openTerminal` (`src/mainview/components/kanban/TerminalView.tsx:325-336`) calls `api.createTerminal(taskId)` and, on an `ApiError`, renders the server's message verbatim through `toast.error` (`:332`). That is the red `!` toast in the screenshot.
- `POST /tasks/:id/terminals` (`src/bun/server.ts:7202-7213`) calls `createTerminal` and maps `{ error }` to HTTP 400 (404 only for an unknown task).
- `createTerminal` (`src/bun/terminals.ts:124-205`) resolves the shell's cwd by calling **`prepareWorkdir(task)`** (`:138`, via a dynamic import — see the db.ts ↔ worktree.ts cycle note at `:23-29`) and aborts on `{ error }` before spawning anything (`:139`). The doc comment (`:114-120`) explains why: it reuses the orchestrator's path so a first terminal open on a never-run task *materializes* the worktree and pins `branch`/`worktreePath` on the row, exactly like `startTask`. Nothing in `createTerminal` checks whether the task's agent is mid-turn.
- `prepareWorkdir`'s **reuse-in-place branch** (`src/bun/worktree.ts:797-815`) fires when `task.worktreePath && task.branch && existsSync(task.worktreePath)`. It reads the live HEAD with `git symbolic-ref --quiet --short HEAD` and, when that differs from `task.branch`, runs **`git checkout <task.branch>`** (10 s timeout). A failed checkout returns the error string above with git's stderr appended (`:803-807`); a *successful* checkout returns normally with `note: "reusing worktree … on <task.branch>"` — the worktree has been silently switched. The inline rationale (`:798-799`): "A user cd-ing in and switching branches shouldn't silently redirect the agent." A detached HEAD skips the check entirely (`head.ok` is false). The block is unchanged since the initial commit (`git blame` → `3492804`, 2026-05-17).

### Why the worktree was on another branch

- The owner's `execute-plan` and `implement` skills — mirrored in `~/.agents/skills/` (both present there), which codex discovers alongside `.codex/skills` — instruct the agent: *"If you're on `main`/`master` or no target branch was named, create one from the plan slug (`implement/<slug>`) and announce it"* (`~/.claude/skills/execute-plan/SKILL.md:28`, `~/.claude/skills/implement/SKILL.md:344`). An agetor-launched task never names a target branch in its prompt, so "no target branch was named" is always true and the agent cuts `implement/<slug>` off the task's `feature/…` branch and commits there. The screenshot's pair (`implement/window-application-recording` vs `feature/record-window-or-application`) is exactly that shape. Expect this drift on every `/implement`-style run inside an agetor worktree, for every harness, and also whenever a user `cd`s into the worktree and switches branches by hand.
- Codex itself never re-runs `prepareWorkdir` on follow-up turns: each turn is a fresh `tmux new-session -c <cwd>` with `cwd` taken from the task row (`src/bun/codex-tmux.ts:490`), so codex keeps working on whatever branch the worktree is on. Follow-up messages are therefore unaffected by this bug; only the paths listed next hit the checkout.

### Who else calls `prepareWorkdir`, and how each guards a live agent

| Caller | Anchor | When it reaches the reuse branch | Live-run guard |
| --- | --- | --- | --- |
| `createTerminal` | `src/bun/terminals.ts:138` | every terminal open on a task with an existing worktree | **none** |
| `startTaskInner` (Run / re-run, `agetor start`, `agetor add --start`) | `src/bun/orchestrator.ts:1502` | every (re-)run | `startTask` refuses `task already running` / `already starting` first (`:1340-1341`) |
| `sendInput` restore | `src/bun/orchestrator.ts:3310-3325` | only when `worktreePath` is set but **missing on disk** | n/a (dir absent) |
| `unarchiveTask` restore | `src/bun/orchestrator.ts:6560-6570` | only when the dir is **missing on disk** | n/a |
| pipeline `refreshParentWorktree` (Run/Retry/Advance/Restart) | `src/bun/pipeline-runner.ts:494-512` | parent with nothing live | **M-R6**: while any execution is live it only `existsSync`-verifies, explicitly because "its reuse branch runs `git symbolic-ref`/`git checkout` in the directory an agent is actively writing to" |

So the terminal path is the **only** caller that can run `git checkout` inside a worktree while that task's agent is mid-turn. The pipeline runner already treats that as unsafe and routes around it; `createTerminal` does not. The error the user saw is the *benign* outcome of that gap — a clean tree would have been switched under the running codex session instead (proved below).

### Surfaces that read the stored `task.branch` and go stale under drift

- Board card branch line: `src/mainview/components/kanban/TaskCard.tsx:288-292`.
- RunPanel header chip and Task-details row: `src/mainview/components/kanban/RunPanel.tsx:3640`, `:7246-7249`.
- Context menu "Copy branch": `src/mainview/lib/task-context-menu.ts:151`.
- Worktrees page rows: `listWorktrees` reports `task?.branch` (`src/bun/orchestrator.ts:6970`); its live git signals (`dirty`/`ahead`/`merged`) are computed against the directory, not the recorded branch.
- CLI: `agetor show` (`src/cli/commands/show.ts:36`), `agetor ls` search (`src/cli/commands/ls.ts:90`).
- **Create PR head**: `prHeadBranch` (`src/mainview/lib/commit-push.ts:53-58`) *prefers* `task.branch` over the live branch that `GET /tasks/:id/git-status` reports (`headBranchState(dir)`, `src/bun/server.ts:5592`, `src/bun/worktree.ts:286-300`). On a drifted worktree, "Create PR" would therefore open the PR from the recorded branch — the one *without* the agent's commits — while "Commit & push" is a machine message the agent executes on whatever branch is checked out. The two chips disagree under drift today.
- **Delete**: `removeWorktree` runs `git branch -D task.branch` (`src/bun/worktree.ts:1218-1219`), so under drift it deletes the recorded branch and leaves the drifted `implement/…` branch behind as an untracked ref (its commits survive; nothing points at them).
- `DiffDialog` diffs the directory against `task.baseRef` (`src/mainview/components/kanban/DiffDialog.tsx:518`), so the diff view is correct under drift.

### Test and doc coverage

- No test anywhere exercises the checkout guard: `grep "could not be switched"` matches nothing under `src/**/*.test.ts` or `e2e/`. `src/bun/terminals.test.ts:204-223` covers first materialization only; `src/bun/worktree.test.ts:1438-1462` covers detach → re-attach at the same path. A naive fix in either direction would keep the suite green — the plan must add tests that pin the chosen behaviour.
- No e2e spec drives terminals (no `e2e/*terminal*`, no xterm fixture in `e2e/fixtures.ts`); `terminals.test.ts` pins `SHELL=/bin/sh` and spawns a real PTY.
- Docs that describe the current behaviour: `CLAUDE.md` orchestration step 2 ("Idempotent — reused across re-runs"), `CLAUDE.md` item 19 (M-R6 sentence: "`prepareWorkdir`, whose reuse branch force-checks-out the parent branch"), `docs/plans/pipelines.md` D2, `docs/plans/archive-worktree-cleanup.md:32` (`createTerminal` degrades when the dir is missing).

### Reusable building blocks

- `hasUncommittedChanges(dir)` → `boolean | null` (`src/bun/worktree.ts:95-101`); `headBranchState(dir)` → `{ branch, isDefaultBranch }` (`:286`); the private `git()` wrapper never throws (`:31`).
- `isTaskRunLive(taskId)` is exported from `src/bun/orchestrator.ts:1290` (counts `startingTaskIds`, an `active` handle, and a held-for-subagents task). `terminals.ts` cannot import it statically (db.ts → terminals.ts → orchestrator.ts → db.ts); a dynamic import inside the function body is the established pattern (`terminals.ts:137`).
- `PrepareResult` is `PreparedWorkdir | PrepareError` (`src/bun/worktree.ts:750-765`); `prepareWorkdir` already takes an `opts` object (`takenBranches`), so an additive option is cheap.

## 2. What we proved

Spike: `scratchpad/spikes/reuse-checkout/spike.ts` imports the repo's `prepareWorkdir`/`tasks` with `AGETOR_DATA_DIR` pointed at the scratchpad, builds a temp repo per scenario, materializes the task's worktree on `feature/record-window-or-application`, then (as the agent would) `git checkout -b implement/window-application-recording` + one commit touching `README.md`, and calls `prepareWorkdir` again.

| Scenario | Verdict | Evidence | Versions |
| --- | --- | --- | --- |
| Agent branch + **uncommitted edit to a file the two branches differ on** | **Fails with the screenshot's exact error** | `prepareWorkdir -> ERROR: worktree is on "implement/window-application-recording" not "feature/record-window-or-application" and could not be switched: error: Your local changes to the following files would be overwritten by checkout: README.md Please commit your changes or stash them before you switch branches. Aborting`; HEAD stays on `implement/…`, `git status` → `M README.md` | git 2.54.0 (Apple Git-157), Bun 1.3.x, macOS 25.6 |
| Agent branch, **clean tree** | **Silently switches** the worktree back | `prepareWorkdir -> OK note="reusing worktree … on feature/record-window-or-application"`; HEAD before `implement/…`, HEAD after `feature/…` | same |
| Agent branch + **untracked file only** | **Silently switches**, carrying the untracked file | OK; HEAD after `feature/…`; `git status` → `?? other.txt` | same |

Takeaways: (1) the diagnosis is exact; (2) the "error" is the lucky case — with a clean tree a terminal open would have moved a working codex session's checkout to a branch that lacks its own commits, mid-turn; (3) "would the tests notice?" — no: nothing pins either behaviour today (see §1, test coverage).

## 3. What we're assuming

- **A terminal is an observation surface.** The owner wants `+` to open a shell at the worktree *as it is*, never to change its branch. If wrong, the fix is a clearer error rather than a behaviour change.
- **Drift is legitimate, not an error state.** The owner's own skills cut branches inside agetor worktrees by design, so agetor must tolerate HEAD ≠ `task.branch` rather than fight it. If wrong (drift should be prevented), the fix moves to the skills and agetor only needs the terminal path unblocked.
- **Codex was mid-turn or just finished** when `+` was clicked. Either way the terminal path needs the same change; it only decides whether a live-run guard is also warranted beyond "never checkout".
- **No worktree task relies on the reuse branch to undo a user's manual branch switch.** No test, doc, or plan references that use; the inline comment is the only trace.

## 4. What we must ask the owner

1. **Terminal open semantics** — open the shell at the worktree as-is with no git mutation (recommended; mirrors M-R6's reasoning), or refuse with a clearer, actionable message when HEAD ≠ `task.branch`? A middle ground (open as-is and show a non-blocking "worktree is on `<live>`" note) is also possible. Evidence: §2 shows the checkout is harmful even when it succeeds.
2. **Re-run (`startTask`) on a drifted worktree** — today it force-checks-out and fails on conflicting edits (same toast on the Run button, and on `agetor start`). Options: keep force-checkout with a better message; **adopt** the live branch into `task.branch` and run there; or refuse unless the tree is clean. Adopting changes what Create PR, the card label, and delete's `git branch -D` act on (§1, stale surfaces) — a one-way door for the row.
3. **Create PR head under drift** — should `prHeadBranch` prefer the live `git-status.branch` over `task.branch` for worktree tasks when they differ? Today the PR would be opened from the branch without the agent's commits while Commit & push lands on the live one.
4. **Delete/archive under drift** — delete removes the recorded branch and leaves the drifted one as an orphan ref. Acceptable, or should teardown also remove (or warn about) the live branch?
5. **Pipeline parent with no live execution** — `refreshParentWorktree` still force-checks-out on Retry/Advance/Restart; apply the same policy as re-run (Q2)?
6. **Skills wording (outside this repo)** — amend `execute-plan`/`implement` so they only cut `implement/<slug>` when on the default branch, keeping the agetor-minted `feature/…` branch otherwise? Agetor cannot control third-party agents, so the product fix is needed regardless; this just removes the most common trigger.
7. **Surface drift in the UI?** A small badge/row ("checkout on `<live>`") on the card, RunPanel details, and Worktrees page is cheap once `git-status` already reports `branch`. In scope for this fix, or a follow-up?
8. **`branchSource: "existing"` tasks** (PR-head worktrees) — same policy, or stricter (never adopt a different branch)?

## 5. Completeness inventory

- **Callers of `prepareWorkdir`** (direct): `src/bun/terminals.ts:138`, `src/bun/orchestrator.ts:1502`, `:3317`, `:6566`, `src/bun/pipeline-runner.ts:509`. Indirect entry points: `POST /tasks/:id/terminals`, `POST /tasks/:id/start`, `POST /runs/:id/input`, `POST /tasks/:id/unarchive`, `POST /tasks/:id/pipeline/{retry,advance,restart}`, CLI `agetor start|send|add --start|pipeline retry|advance|restart`, TUI `s`.
- **Propagation surface**: `PrepareResult`/`PreparedWorkdir` (`src/bun/worktree.ts:750-765`); `Task.branch`/`worktreePath` docs (`src/shared/types.ts:1389-1402`); `TaskGitStatus.branch` (live head, already on the wire); `prHeadBranch` (`src/mainview/lib/commit-push.ts`); `listWorktrees` row shape (`src/bun/orchestrator.ts:6913+`); `CLAUDE.md` step 2 and item 19 (M-R6 sentence); `docs/plans/pipelines.md` D2.
- **Existing data to backfill**: none — no schema change is implied by any option; adopting the live branch (Q2) would be a targeted `tasks.update` at run time, not a migration.
- **Docs/config/examples describing current behaviour**: `CLAUDE.md` (orchestration step 2; item 19 M-R6; `TerminalsSection` key note), `docs/plans/pipelines.md`, `docs/plans/archive-worktree-cleanup.md:32`, the inline comment at `src/bun/worktree.ts:798-799`.
- **What the change would orphan**: nothing today; if the checkout is removed from the reuse branch entirely, the "user cd-ing in and switching branches shouldn't silently redirect the agent" rationale (`worktree.ts:798-799`) needs rewriting, and the M-R6 sentence in `CLAUDE.md`/`pipeline-runner.ts:494-500` becomes partially moot.

## 6. Runnability

- Start locally: `bun install`; `bun run dev:hmr` (Vite + Electrobun, `AGETOR_DATA_DIR=$HOME/.agetor-dev`); `bun run dev` for main-process-only changes. In an agetor worktree shell, `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"` first (`bun` is not on the default PATH here).
- Tests: `bun run typecheck`; `bun test`; targeted `bun test src/bun/terminals.test.ts` (spawns a real PTY, pins `SHELL=/bin/sh`) and `bun test src/bun/worktree.test.ts` (temp repos via `makeRepo()`, `AGETOR_DATA_DIR` mkdtemp before importing `db.ts`). Known pre-existing failures on main: two tmux-socket tests and one reconcile-cancel test.
- E2E: Playwright, `bun node_modules/@playwright/test/cli.js test` (one run at a time); fake drivers via `AGETOR_*_DRIVER=fake`; **no terminal spec exists** — a new one would need a fake-driver task, a real PTY under the headless core, and an xterm readiness wait.

## 7. Risks & blast radius

- **Removing the checkout from the terminal path only** is low-risk: first materialization is untouched (`terminals.test.ts:204`), and the shell simply opens on the live branch. Re-run and pipeline retry keep today's behaviour unless Q2/Q5 change it.
- **Adopting the live branch into `task.branch`** touches delete (`git branch -D`), Create PR head, card/panel labels, the Worktrees page, `takenBranches` collision sets (`orchestrator.ts:1502-1509`, `server.ts:1491`, `createTask`'s existing-branch guard at `orchestrator.ts:5966`), and pipeline steps (which copy the parent's `branch`; `propagateWorktreeToActiveSteps`, `pipeline-runner.ts:519-526`). It must never run while the task is live.
- **Pipeline step tasks share one worktree**; any change to the reuse branch applies to every step's own `startTask` reuse check (`pipeline-runner.ts:527-528`).
- **Running `git checkout` under a live agent** (today's terminal path) can corrupt an in-flight turn's view of the tree; any retained checkout needs the same `isTaskRunLive` gate M-R6 uses.
- Rollback is trivial for any option: no migration, no persisted shape change.
