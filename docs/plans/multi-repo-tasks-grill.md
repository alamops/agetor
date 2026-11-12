# Grill — multiple repositories in one card (#291)

| Field | Value |
| --- | --- |
| Date | 2026-11-10 |
| Source | [alamops/agetor#291](https://github.com/alamops/agetor/issues/291) + its 1-comment thread; investigation `docs/plans/multi-repo-tasks-investigation.md` |
| Mode | interactive via decision form, answered by the owner in 2 rounds |
| Answers | `docs/plans/multi-repo-tasks-grill/round-1/answers.json`, `docs/plans/multi-repo-tasks-grill/round-2/answers.json` |
| Flags | none |
| Spec | `docs/specs/multi-repo-tasks.md` |

## One-way doors awaiting a human

None. Both one-way doors were answered in round 2: `isolation-none-final` and `legacy-columns`.
No required question was skipped (`summary.complete: true` in both rounds).

## Decisions

Confidence is **high** for every row because every row is the owner's direct answer. "Round 1" and
"Round 2" refer to the answers files above.

| # | Topic | Question | Answer | Source | Confidence |
| --- | --- | --- | --- | --- | --- |
| 1 | Architecture | What does a multi-repo task look like to the agent? | A per-task workspace root containing one subdirectory per repo; the agent's cwd is the workspace root; one conversation sees every repo. Single-repo tasks keep today's layout. | owner (round-1/answers.json#agent-architecture, accepted recommendation) | high |
| 2 | Scope | Which of the issue's six bullets ships? | All six: selection, per-repo worktrees, one agent seeing them, shared context, per-repo diff/status, per-repo PRs. No separate bulk-PR flow beyond the aggregate one below. | owner (round-1/answers.json#v1-scope, accepted recommendation) | high |
| 3 | Isolation | Must a multi-repo task use worktree isolation? | **Yes.** Multi-repo requires `isolation: "worktree"`; `none` stays single-repo. This reverses round 1's `support-none-live`, which contradicted the workspace-root cwd and the accepted create rejection. | owner (round-2/answers.json#isolation-none-final, accepted recommendation; supersedes round-1/answers.json#isolation-none) | high |
| 4 | Repo set | When may the repository set change? | **Create-only.** The set is fixed at creation; changing it means a new card. This consciously narrows the issue's "creating or editing a card" to creation. **Amended after implementation (owner):** one repository can be removed from an existing multi-repo task; adding one still needs a new card. See "Owner decisions after implementation" below. | owner (round-1/answers.json#repo-set-editing; confirmed in round-2/answers.json#create-only-confirm) | high |
| 5 | Failure | What happens when one repo's worktree cannot be created at start? | All-or-nothing: validate every repo, create all worktrees, then spawn. On failure remove the worktrees created in that attempt and return an error; the error must list every repo that failed. | owner (round-1/answers.json#partial-failure, accepted recommendation + note) | high |
| 6 | Harnesses | Which harnesses get multi-repo? | All eight, with a smoke matrix: Claude/Codex/Cursor/fx live-smoked; Gemini/Copilot/Antigravity/OpenCode layout-supported but smoke-pending until accounts exist. **Status (post-implementation):** live smoke run on 2026-11-12: Claude, Codex (first turn and a follow-up, escalated) and fx succeeded end to end; OpenCode 2.x's server accepted the non-git workspace, but the turn failed on account credits; Copilot was not installed; Cursor was not run; a harness-stack failover was not run. See "Amendments after implementation" below. | owner (round-1/answers.json#harness-scope, accepted recommendation) | high |
| 7 | Prompt | How do the repo directories reach the agent? | A new machine-added `Repositories:` paragraph in the launch prompt. Exact shape in row 20. | owner (round-1/answers.json#prompt-context, override of the references-block recommendation) | high |
| 8 | Branches | How are branch names and base refs chosen? | One shared branch name across repositories by default; a base ref per repo. If a repo's config/validation/git refuses the shared name, that repo falls back to its own derived name and the dialog shows it. | owner (round-1/answers.json#branch-base; fallback confirmed in round-2/answers.json#same-branch-fallback) | high |
| 9 | Commit/PR | How do commit/push and PR creation work? | One aggregate commit/push prompt lists every repo and branch and asks for one PR proposal per repo. A single `Create all PRs` action walks the repos with per-repo best effort: one failure does not block the others; results and retries are per repo. | owner (round-1/answers.json#commit-pr; failure policy in round-2/answers.json#aggregate-result) | high |
| 10 | Pipelines/issues | Do pipelines and issue-created tasks support multiple repos? | Both. Pipeline parents may be multi-repo (steps copy the workspace/repo set; teardown stays parent-owned). Create-from-issue may add extra repos; the issue's repo is recorded for `Closes #N`. | owner (round-1/answers.json#pipelines-issue, accepted recommendation) | high |
| 11 | CLI/TUI | How far does CLI/TUI parity go? | Full parity: `agetor add --repo` (repeatable), `show`/`shell`/`rm` repo-aware, TUI multi-select and multi-scope `@` completion. | owner (round-1/answers.json#cli-parity, override) | high |
| 12 | Legacy columns | What do `workdir`, `branch`, `worktreePath`, `baseRef`, `prUrl` mean without a primary? | For multi-repo rows: `workdir` and `worktreePath` are the workspace root; `branch`, `baseRef` and `prUrl` are null. All per-repo data lives in `repositories[]`. Single-repo rows are unchanged. Older builds see a non-git workspace; no downgrade guard. | owner (round-2/answers.json#legacy-columns, accepted recommendation, one-way door) | high |
| 13 | No primary | Is there a primary repo? | No. All repos are equally important in the model and the UI. The round-1 "first selection is primary" was rejected. | owner (round-1/answers.json#primary-mirrors, override) | high |
| 14 | Identity/cap | How are duplicate repos and large sets handled? | Dedupe by git root (two registered projects under one repo collapse to one worktree). No hard cap and no 400 for a large selection; a non-blocking warning appears above 10 repos. Worktree creation and polling run in bounded batches. | owner (round-1/answers.json#repo-identity-cap, override of primary+cap; confirmed in round-2/answers.json#dedupe-no-cap) | high |
| 15 | Layout | What is the on-disk and Worktrees-page shape? | Multi-repo workspace is `<dataDir>/worktrees/<task-id>/<slug>` (slug = repo basename, uniquified); single-repo keeps `<dataDir>/worktrees/<task-id>`. Worktrees page shows one row per repo grouped under its task, id `<taskId>__<slug>`. Owned rows route deletion to archiving the task; orphan rows keep per-row delete. | owner (round-1/answers.json#workspace-layout, accepted recommendation) | high |
| 16 | UI | What the user sees in the form, card, diff and filters. | A shared `Repositories` dialog (multi-select registered projects, `Add folder…`, per-repo base branch, remove) instead of per-repo rows in the New Task panel; with one repo, today's inline branch/base fields stay. The card shows a **worktree icon plus the repository count**, with a popover listing every repo. Diff dialog gets per-repo tabs/selector. Repo filter and search match any repo. Context menu gets a per-repo submenu. The agent's todo progress stays one shared list; per-repo change counts live in the run panel. | owner (round-1/answers.json#ui-surfaces + note; card override in round-2/answers.json#card-without-primary; dialog scope in round-2/answers.json#repo-dialog-scope) | high |
| 17 | Validation | What does create validate? | Reject 400 if any selected repo is missing, is not a git repo, has an unresolvable base ref, has an invalid branch name, or has that branch checked out in another live task; nothing is created. Multi-repo + `isolation: none` is rejected. | owner (round-1/answers.json#create-validation, accepted recommendation) | high |
| 18 | Archive/delete | What happens with dirty repos? | Archive teardown is best-effort per repo: clean worktrees are detached, dirty ones stay on disk with their branch, every outcome is reported, archive still succeeds. Delete is explicit and per repo; never deletes a `branchSource: "existing"` branch. | owner (round-1/answers.json#archive-dirty, accepted recommendation) | high |
| 19 | Runtime | Terminals, polling and extra roots. | Terminals open at the workspace root with a repo selector. `GET /tasks/:id/git-status` returns all repo statuses in one batched response per poll. Each repo is also passed as an extra root (`--add-dir` / include-directories) where supported, even though cwd is the workspace. **As shipped:** `--add-dir` for claude-code, codex and copilot only; Gemini's include-directories is not used (plan A6: gemini not installed, unverified). | owner (round-1/answers.json#runtime-defaults, accepted recommendation) | high |
| 20 | Prompt text | Exact `Repositories:` block. | In the launch prompt only: `Repositories:` then one bullet per repo: `- <name>: <absolute worktree path> (branch <branch>)`. No product name, no other prose. The aggregate commit/push template names repos itself and does not repeat it. | owner (round-2/answers.json#prompt-block-format, accepted recommendation) | high |
| 21 | Issue PR | Which repo's PR gets `Closes #N`? | Record the issue's source repo with the task; only that repo's PR body prefills `Closes #N`. Exact field name/shape is left to the plan. | owner (round-2/answers.json#issue-repo-attribution, accepted recommendation) | high |
| 22 | `existingBranch` | Can a multi-repo task pin pre-existing branches? | No. `existingBranch` stays single-repo only; a multi-repo create that sends it is rejected 400. | owner (round-2/answers.json#existing-branch-multi, accepted recommendation) | high |
| 23 | Spec/tests | What is the source of truth and the acceptance bar? | Commit the issue's asks and these decisions as `docs/specs/multi-repo-tasks.md` before planning. Add one e2e spec (create → fake-driver run → two worktrees/branches → per-repo diff → per-repo PR stamp → archive teardown) and unit tests for per-repo prepare/reuse/cleanup, nested worktree ids, route policy and pipeline step copy. | owner (round-1/answers.json#spec-and-tests, accepted recommendation) | high |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| Workspace root, per-repo worktrees, one agent conversation | in this change | round 1 #agent-architecture |
| `repositories[]` column (migration 087) + legacy read fallback + workspace mirror of the legacy scalars | in this change | round 2 #legacy-columns; additive, no backfill |
| Create-time validation, dedupe by git root, no cap, soft warning above 10, bounded batches | in this change | round 1 #create-validation; round 2 #dedupe-no-cap |
| Shared branch name + per-repo base + per-repo fallback | in this change | round 1 #branch-base; round 2 #same-branch-fallback |
| Shared `Repositories` dialog in New Task and `CreateTaskFromIssueDialog`; one repo keeps inline branch/base | in this change | round 2 #repo-dialog-scope |
| `Repositories:` launch-prompt block + prompt-text rule amendment + tests | in this change | round 1 #prompt-context; round 2 #prompt-block-format |
| Per-repo diff/status, batched git-status endpoint, terminals at workspace root, extra roots | in this change | round 1 #runtime-defaults; round 1 #v1-scope |
| Aggregate commit/push + per-repo best-effort PR creation + per-repo `prUrl` + issue repo attribution | in this change | round 1 #commit-pr; round 2 #aggregate-result, #issue-repo-attribution |
| Archive/delete per repo, dirty preservation, nested Worktrees rows and ids | in this change | round 1 #archive-dirty; round 1 #workspace-layout |
| Pipeline parent multi-repo + step copy + parent-owned teardown | in this change | round 1 #pipelines-issue |
| Card worktree icon + count popover, diff tabs, filters/search, per-repo context menu | in this change | round 1 #ui-surfaces + note; round 2 #card-without-primary |
| Full CLI/TUI parity | in this change | round 1 #cli-parity |
| Harness support for all eight + smoke matrix for installed four | layout support in this change; live smoke run for claude/codex/fx (end to end) and OpenCode (server + non-git workspace only, billing blocked the edit); cursor not run | round 1 #harness-scope; see "Amendments after implementation" |
| Live smoke for Gemini/Copilot/Antigravity/OpenCode | out of scope for this change | round 1 #harness-scope accepted "layout-supported, smoke-pending"; no accounts on this machine |
| Editing the repo set after creation | removing one repository: in this change (owner decision after implementation); adding: out of scope (owner-deferred) | round 1 #repo-set-editing + round 2 #create-only-confirm; amended by the owner after implementation (see below) |
| Multi-repo `isolation: none` (symlink/live/copy workspace) | out of scope | round 2 #isolation-none-final — worktree isolation is required |
| Per-repo `existingBranch` selection | out of scope | round 2 #existing-branch-multi |
| Downgrade guard / down migration for older builds | out of scope | round 2 #legacy-columns — older builds see the workspace and may orphan secondary worktrees; accepted |
| Copy/sync live checkouts into the workspace | out of scope | round 2 #isolation-none-final — not a usable `none` mode |
| Hard cap on repository count | out of scope (owner-deferred) | round 1 #repo-identity-cap + round 2 #dedupe-no-cap — soft warning only |
| Per-repo branch names from each project's config | out of scope | round 1 #branch-base — shared name with fallback |
| Coordinator + one agent per repo | out of scope | round 1 #agent-architecture — one conversation |
| Compatibility mirror of one repo in the legacy columns | out of scope | round 2 #legacy-columns — no primary |
| Repo set persistence and read fallback for existing rows | in this change | round 2 #legacy-columns; investigation §5.6 |
| Docs updates (`CLAUDE.md`, task-lifecycle, at-file-references, pipelines, prompt-composer, security, persistence) | in this change | repo rule: update the subsystem doc in the same change |

## Assumptions still open

- **No hard cap.** A task with dozens of repositories is allowed. The plan bounds concurrency and
  warns above 10; if the runtime cost is unacceptable, a cap is a small follow-up. Wrong → the
  task may be slow to start, not incorrect.
- **Uninstalled harnesses are smoke-pending.** If Gemini/Copilot/Antigravity/OpenCode behave
  differently under a non-git workspace, the fix is a per-kind follow-up; the workspace layout
  does not change.
- **Older builds are not guarded.** A multi-repo row shows a non-git workspace to an older build,
  and an older delete may remove the workspace root and orphan the repo worktrees. The owner
  accepted this; a downgrade guard would be a new change.
- **`issueRepoPath` shape is left to the plan.** The decision is that the issue's source repo is
  recorded and only its PR gets `Closes #N`; the field name (top-level path vs per-repo
  `issueUrl`) is an implementation choice.
- **The exact card icon is a design choice.** The decision is "worktree icon + repository count,
  with a popover", not a specific icon asset.
- **The new prompt paragraph is a rule amendment.** If a reviewer rejects the exception, the
  fallback is the existing references block; the plan should record the exception in `CLAUDE.md`
  and its tests so it is visible.

## Amendments after implementation

These are facts about the shipped code and its verification, recorded so this file does not
overstate what was decided or done. None of them is an owner decision, and none has been approved
by the owner.

- **Live harness smoke (decision 6), 2026-11-12.** Run at branch head `2f147818` against two fresh
  repositories with worktree isolation (ledger: `docs/plans/multi-repo-tasks-smoke.md`). Claude Code
  2.1.322, codex-cli 0.166.0 and fx 0.0.15 each committed in both checkouts; codex ran with
  `danger-full-access` escalated from the task's verified checkouts, accepted `--add-dir`, and a
  follow-up turn resumed and stayed escalated; Claude's hook installer wrote its settings file at the
  non-git workspace root, and delete removed it. OpenCode v2.1.3's agetor-owned server accepted the
  non-git workspace directory and took the turn, but the provider refused it for account credits, so
  no end-to-end edit was verified. Not run: Copilot (not installed), Cursor, Gemini, Antigravity, and a
  harness-stack failover of a multi-repository task. Live teardown: delete removed the workspace and
  the branches, archive kept the branches, unarchive restored both checkouts. This records what was
  run, not an owner sign-off.
- **Extra roots (decision 19).** "Include-directories where supported" shipped as `--add-dir` for
  claude-code, codex and copilot. Gemini's include-directories is not used (plan A6); cursor, fx,
  OpenCode, Antigravity and Gemini rely on the cwd.

## Owner decisions after implementation

Taken by the owner after the first implementation and review rounds; the shipped contract is in
`docs/architecture/multi-repo-tasks.md`.

- **One-repository multi tasks are allowed.** A task created with
  two or more repositories stays multi-repo when repositories are removed down to one; "is this
  multi-repo" is the derived `Task.multiRepo`, not `repositories.length > 1`.
- **Remove a repository from an existing multi task (amends decision 4).**
  `DELETE /tasks/:id/repositories/:name`, the run panel's "Remove from task" and
  `agetor edit <task> --remove-repo <name>`. A clean checkout is detached and its branch kept; a
  missing checkout or source just drops the entry; refused while running, for the last repository,
  for a dirty checkout, on a single task and on a pipeline step. It is the fix for a task whose
  repository source was deleted.
- **Extra roots skip missing checkouts (amends decision 19).** `--add-dir` and codex's workspace
  repositories name only checkouts that exist at spawn time.
- **Copilot needs no escalation change.** Auto already passes `--allow-all` and
  `COPILOT_ALLOW_ALL=true` and gets the checkouts as `--add-dir`; Read-only and Plan deny writes by
  design. Not live-verified (Copilot not installed on the smoke machine).
- **Pipeline-step PR stamps stay on the step.** The parent card doesn't show a step's PR, and the
  parent's "Create all PRs" can retry that repository and show GitHub's 422 as a failure: a
  documented limitation, no code change.
