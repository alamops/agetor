# Grill — terminal open fails on a worktree that drifted off `task.branch`

| Field | Value |
| --- | --- |
| Date | 2026-10-12 |
| Source | Investigation brief `docs/plans/codex-terminal-worktree-error-investigation.md` (pipeline step "Investigation"), screenshot `~/Desktop/Screenshot 2026-10-12 at 2.18.19 AM.png` |
| Mode | interactive, answered by the owner (three structured passes) |
| Flags | none |

## Settled by evidence (not asked)

- **Root cause.** `createTerminal` (`src/bun/terminals.ts:138`) resolves its cwd through `prepareWorkdir`. The reuse branch (`src/bun/worktree.ts:797-808`) runs `git checkout <task.branch>` whenever HEAD differs. Conflicting edits produce the toast. A clean or untracked-only tree is switched silently under the running agent (spike, brief §2).
- **Terminal open is the only `prepareWorkdir` caller with no live-run guard.** `startTask` refuses when the task is live. The `sendInput`/`unarchive` restores only run when the directory is missing. The pipeline's `refreshParentWorktree` M-R6 guard (`src/bun/pipeline-runner.ts:494-512`) exists precisely to avoid this checkout.
- **Drift is routine.** The owner's `implement` (`~/.agents/skills/implement/SKILL.md:344`) and `execute-plan` (`~/.agents/skills/execute-plan/SKILL.md:28`) skills cut `implement/<slug>` whenever "no target branch was named", which is always true inside an agetor task. There is one copy, symlinked into `~/.claude/skills`; it is not a git repo.
- **Found during the grill (missing from the brief).** Archive calls `detachWorktree` (`src/bun/worktree.ts:1280`), which removes the directory and keeps every branch. Unarchive then re-materializes on `task.branch`. Under drift, the resumed agent therefore lands on the branch *without* its own commits. The live branch is unrecoverable from git once the directory is gone.
- **Delete contract today.** `DELETE /tasks/:id` answers `204` with no body (`src/bun/server.ts:5102-5103`). `removeWorktree` runs `git branch -D task.branch` and skips `branchSource: "existing"` (`src/bun/worktree.ts:1211-1220`).
- **Live branch on the wire.** `GET /tasks/:id/git-status` already returns the live `branch` and `isDefaultBranch` (`headBranchState`, `src/bun/server.ts:5592`, `src/bun/worktree.ts:286`). `prHeadBranch` prefers `task.branch` over it (`src/mainview/lib/commit-push.ts:53-58`).
- **Next free migration:** `063` (latest is `062_normalize_cursor_haiku_5_5.sql`).

## Decisions

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| D1 | Terminal | What should `+` do on a drifted worktree? | **Open the shell at the worktree as-is. Never run git checkout.** No toast; drift shows through the UI in D8. | owner |
| D2 | Core policy | Adopt the live branch into `task.branch`, tolerate drift, or enforce the recorded branch? | **Tolerate, don't adopt.** Never `git checkout` on reuse, and never rewrite `task.branch`. `task.branch` stays "the branch agetor created". Each surface that needs the real branch reads it live from git, or from the D6 recorded value. | owner |
| D3 | Delete | Which branches does delete remove under drift? | **Both.** Right before teardown, delete reads the worktree's HEAD. If HEAD is a *different named* branch, delete removes it alongside `task.branch`. **Both are named in the confirm dialog and in `agetor rm` output.** It never removes the repo default branch, a `branchSource: "existing"` (PR-head) branch, or a branch another task holds (another row's `task.branch` or last-seen checkout). | owner (confirmed as "live read at delete" after D2) |
| D4 | PR-head tasks | Do `branchSource: "existing"` tasks get the same policy or a stricter one? | **Never adopt (moot under D2), and warn.** A stronger run-log warning says commits aren't landing on the PR head, and the drift badge uses the warning tone. | owner |
| D5 | Delete source | When delete can't read the live branch (directory gone, git error, archived task) | Use the recorded last-seen checkout (D6). If that is null too, remove only `task.branch`. | owner (confirmed default #7) |
| D6 | Unarchive | How does unarchive avoid landing on the branch without the agent's commits? | **Record at archive.** Before detaching, archive reads the live branch and stores it in a **new server-managed column**; `task.branch` is untouched. Unarchive re-materializes the worktree on that recorded branch. Delete of an archived task uses it (D5). | owner |
| D7 | Create PR | Which branch is the PR head under drift? | **The live branch** (git-status `branch`) when it differs from `task.branch` and isn't the default branch. Otherwise `task.branch`. **PR-head tasks keep `task.branch`** (default #4). | owner |
| D8 | Drift UI | How far should drift be surfaced? | **Everywhere.** RunPanel header chip and Task-details row show the live branch from the existing 5 s git-status poll, plus "task branch: `<task.branch>`". The Worktrees page reads HEAD per row. The board card, `agetor show` and `agetor ls` show a display-only **last-seen checkout** value (the same column as D6), refreshed at run start, run settle, terminal open and archive. The UI falls back to `task.branch` while it is null. | owner |
| D9 | Skills | Change the skill wording that causes most drift? | **Edit both skill files in this change** (`~/.agents/skills/implement/SKILL.md:344`, `~/.agents/skills/execute-plan/SKILL.md:28`). Cut `implement/<slug>` only when on `main`/`master`. If already on a non-default branch, stay there and announce it. These files are outside this repo and are not committed with the fix. | owner |
| D10 | Tests | Test bar | **Unit + a new e2e spec.** Unit coverage: `prepareWorkdir` with no checkout across clean, conflicting, untracked-only and detached HEAD; `createTerminal` on a drifted worktree; delete removing both branches and honouring every exclusion; archive recording and unarchive restoring; the `prHeadBranch` live rule, with the PR-head exception; pipeline refresh. E2e: a fake-driver task drifts its worktree, a terminal opens (needs a new xterm readiness harness — none exists today), and the drift chip and Create PR head are asserted. | owner |
| D11 | Reuse path | Scope of the no-checkout rule | `prepareWorkdir`'s reuse branch drops `git checkout` for **every** caller: Run/re-run, terminal open, pipeline Retry/Advance/Restart, and step `startTask` reuse. The pipeline M-R6 guard stays, because the materialize path still mutates. | owner (confirmed default #1) |
| D12 | Detached HEAD | Rebase or bisect in progress | Open and run as-is, with no checkout. Nothing is recorded as the last-seen checkout, since there is no branch name. | owner (confirmed default #2) |
| D13 | Run log | Drift notice on run start | Every run start on a drifted worktree writes the status line `worktree is on <live> (task branch <task.branch>) — running there`. PR-head tasks get the stronger D4 warning. | owner (confirmed default #3) |
| D14 | Pipelines | Where the last-seen checkout lives | On the **parent**, refreshed at each step's start and settle. Step rows mirror it, like `branch`/`worktreePath` (`propagateWorktreeToActiveSteps`). | owner (confirmed default #5) |
| D15 | Backfill | Existing rows | **No backfill.** The new column starts null and fills on the next run start/settle, terminal open or archive. | owner (confirmed default #6) |
| D16 | Docs | Docs that describe today's checkout | Update in this change: `CLAUDE.md` orchestration step 2 ("Idempotent — reused across re-runs"), `CLAUDE.md` item 19's M-R6 sentence ("whose reuse branch force-checks-out the parent branch"), `docs/plans/pipelines.md` D2, and the inline rationale at `src/bun/worktree.ts:798-799`. Also document the new column in `CLAUDE.md`'s Persistence skipped-columns list. | owner (confirmed default #8) |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| Remove the reuse checkout from `prepareWorkdir` (every caller) | in this change | owner (D2, D11) |
| `createTerminal` opens on the live branch | in this change | owner (D1) |
| Re-run (`startTaskInner`) runs on the live branch and logs a drift line | in this change | owner (D2, D13) |
| Pipeline `refreshParentWorktree` and step reuse follow the same rule | in this change | owner (D11, D14) |
| New server-managed "last-seen checkout" column (migration `063`), its refresh points, wire field, and exclusion from the generic SET and PATCH allow-list | in this change | owner (D6, D8) |
| Archive records the live branch; unarchive restores onto it | in this change | owner (D6) |
| Delete removes both branches, with exclusions; the confirm dialog and `agetor rm` name them | in this change | owner (D3, D5) |
| `prHeadBranch` live-branch rule with the PR-head exception | in this change | owner (D7) |
| Drift UI: RunPanel chip/details, Worktrees page, card, `agetor show`/`ls` | in this change | owner (D8) |
| PR-head stronger warning and warning-tone badge | in this change | owner (D4, D13) |
| Skill wording fix in `~/.agents/skills/{implement,execute-plan}` | in this change (outside the repo, not committed) | owner (D9) |
| Unit tests and a new terminal e2e spec with an xterm readiness harness | in this change | owner (D10) |
| Docs: `CLAUDE.md` step 2, item 19, Persistence list; `docs/plans/pipelines.md` D2; inline comment | in this change | owner (D16) |
| Backfill of the new column for existing rows | out of scope | owner (D15): the column fills on next use and the UI falls back to `task.branch` |
| Race where terminal open and Run both materialize a never-run worktree at once | out of scope | owner (confirmed default #9): pre-existing and unrelated to drift; a separate ticket |
| Worktrees-page orphan delete (`rm -rf` only) | out of scope | unchanged behaviour; it never touches branches |
| Adopting the live branch into `task.branch` | out of scope | owner rejected it (D2) |

## Assumptions still open

These are for `write-plan` to settle or ground. None changes the decisions above.

- **How delete names both branches before it runs.** `DELETE /tasks/:id` answers `204` with no body, and card deletes happen without an open RunPanel. The plan must pick a mechanism. One option is a teardown-preview read (live HEAD or last-seen checkout, after exclusions) that both the webview confirm and `agetor rm` call before deleting. Another is changing the delete response to carry the removed branches; that is a contract change, so check every caller of `api.deleteTask` and the CLI wrapper. *If the plan picks the response-body route:* older CLI or webview builds that expect `204` must keep working.
- **Column shape.** Name (e.g. `checkout_branch`) and semantics: null means "unknown or same as `task.branch`". The working assumption follows the `sent_files`/`fx_recovery` convention: a targeted UPDATE, excluded from the generic `tasks.update` SET clause and from `ALLOWED_PATCH_FIELDS`. *If it must bump `updated_at` to re-render the card,* the plan should check `reconcileById` identity preservation.
- **Refresh writes avoid a GET side effect.** The value refreshes only at run start, run settle, terminal open and archive, never from the `git-status` GET poll. The RunPanel reads live instead.
- **"Held by another task" for the delete exclusion** compares against other rows' `task.branch` *and* their last-seen checkout, in the same workdir.
- **Run settle for every harness.** The "settle" refresh point has to cover the orchestrator's shared done handler, so it applies to all six harness kinds, not just codex. The plan should anchor it to `attachDoneHandler` or its equivalent.
- **Unarchive onto a branch that no longer exists** (deleted by hand while archived). Assumed: fall back to `task.branch` and log a status line. *If the owner wants it to refuse instead,* the restore path errors.
- **The `sendInput` restore path** (worktree missing on disk, `src/bun/orchestrator.ts:3310-3325`) re-materializes, just like unarchive. Assumed: it also prefers the recorded last-seen checkout over `task.branch`, for the same reason as D6.
