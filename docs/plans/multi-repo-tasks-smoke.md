# Smoke & verification — multiple repositories in one task (#291)

Verification evidence for `docs/plans/multi-repo-tasks.md` (T17). Re-run from
the repo root; every command below was executed on this branch.

## Reproduction before the fix

The reported behavior was reproduced with the scratch probe from plan §1: a
`createTask({ repositories: [{ path: a }, { path: b }] })` call on the base
commit (`8e308518`) silently dropped the unknown `repositories` key (the create
input had no field for it) and `prepareWorkdir` materialized exactly one
worktree at `<dataDir>/worktrees/<task-id>`. The permanent regression is
`src/bun/multi-repo-repro.test.ts`, which asserts both repositories survive the
create and that one worktree per repository exists under
`<dataDir>/worktrees/<task-id>/<slug>`. Run against a detached worktree at
`8e308518` it failed on its own first assertion — expected `[a, b]`, received
`undefined` — and it passes on this branch (observed on 2026-11-10).

## Commands

```bash
bun run typecheck
bun test
bun test src/bun/multi-repo-repro.test.ts src/bun/orchestrator-multi-repo.test.ts \
  src/bun/server-multi-repo.test.ts src/bun/worktree.test.ts src/bun/task-repos.test.ts \
  src/bun/db-repositories.test.ts src/bun/migrate.test.ts src/bun/route-policy.test.ts \
  src/bun/pull-create-task-url.test.ts src/bun/worktrees-list.test.ts \
  src/bun/worktree-git-status.test.ts src/bun/server-teardown-preview.test.ts \
  src/bun/pipeline-runner.test.ts src/bun/terminals.test.ts src/bun/agents.test.ts \
  src/shared/multi-repo.test.ts src/shared/file-scope.test.ts \
  src/mainview/lib/repo-selection.test.ts src/mainview/lib/pr-proposal.test.ts \
  src/mainview/lib/use-project-files.test.ts src/mainview/lib/diff-selection.test.ts \
  src/mainview/lib/commit-push.test.ts src/cli/commands/add.test.ts \
  src/cli/commands/show.test.ts src/cli/commands/shell.test.ts \
  src/cli/commands/rm.test.ts src/cli/tui/at-complete.test.ts src/cli/at-warn.test.ts
bun node_modules/@playwright/test/cli.js test e2e/multi-repo-task.spec.ts
```

## Results

| Check | Result |
| --- | --- |
| `bun run typecheck` | green |
| Focused multi-repo/unit suites | green — 1,138 tests across the 28 files above |
| `bun test` | Round-3 full-suite evidence: 12,512 tests, 496 files — 12,477 pass, 31 skip, 4 fail, all load/timing-sensitive fake-tmux/opencode-fixture cases that rotated and passed on rerun. Round 4 re-ran the focused suite above and `bun test src/shared src/mainview src/cli` (5,084 pass); a fresh full-suite attempt was stopped under shared-machine load after 43/496 files with only the same known fake-tmux/claude-session timing failures. |
| `bun test src/shared src/mainview src/cli` | green — 5,084 tests across 193 files |
| `bun node_modules/@playwright/test/cli.js test e2e/multi-repo-task.spec.ts` | 6 passed |
| Migration 087 on an 086 DB | `src/bun/db-repositories.test.ts` / `src/bun/migrate.test.ts` |
| Existing worktree tests | unchanged and green (the pre-change 116 plus the new multi-repo cases) |

## Review-round regressions

The first review round found one blocker and two must-fix defects; each has a
permanent regression test:

| Finding | Fix | Test |
| --- | --- | --- |
| `agetor shell <task-id>` skipped positional 0 when `--repo` was absent | `repoIdx < 0 || i !== repoIdx + 1` | `src/cli/commands/shell.test.ts` |
| A secondary repository re-attached a branch left by an archived task | per-repository `ensureUniqueBranch` at create | `orchestrator-multi-repo.test.ts` — "gives a secondary repository a fresh branch…" |
| A multi-repo pipeline step materialized an empty `<WORKTREES>/<step-id>` | `workspacePathFor` reuses the parent's mirrored workspace | `pipeline-runner.test.ts` — "runs its step in the parent's workspace…" |
| Delete ignored the per-repository teardown plan | `removeWorktree` takes `repositories[]` | `orchestrator-multi-repo.test.ts` — "removes the branch … drifted onto" |
| "Create all PRs" could open duplicate PRs | `repositoriesNeedingPr` skips stamped entries | `src/mainview/lib/pr-proposal.test.ts` |
| `SpawnAgentArgs.extraDirectories` was unread; follow-up turns lost the roots | `spawnAgentOrFail` injects `opts.extraDirectories` on every spawn path | `src/bun/agents.test.ts` argv families + the multi pipeline spawn test |
| A submodule made a legacy orphan worktree look like a multi workspace | expansion requires a linked-worktree `.git` pointer with exactly one segment after `.git/worktrees/`; the real `<repo>/.git/worktrees/<wt>/modules/<sub>` shape is rejected | `src/bun/worktrees-list.test.ts` (real git-2.54 pointer shape), `src/bun/worktree.test.ts` |
| `rm` docs claimed a per-repository preview the CLI never printed | `teardownPhrase` + `--json` carry `repositories[]` | `src/cli/commands/rm.test.ts` |
| Header "View issue" passed the non-git workspace root on a multi task | the issue repo (`issueRepoPath`) is passed instead | issue flow uses the repository whose remote matched the issue URL |
| "Commit & push" showed only when the selected tab was dirty | aggregate gate (`shouldOfferCommitPushForTask`) across every repository | `src/mainview/lib/commit-push.test.ts` |
| `Repository: agetor_api` proposals were dropped | label capture keeps `_`; markdown emphasis is stripped | `src/mainview/lib/pr-proposal.test.ts` |
| A never-started multi repository was promised branch removals | per-repo plan is empty when `worktreePath` is null, matching delete | `src/bun/server-teardown-preview.test.ts` |

The second review round added five more regressions:

| Finding | Fix | Test |
| --- | --- | --- |
| The board card's "View issue" still passed the non-git workspace root | the same `issueProjectPath` helper the run-panel header uses (it also falls back to the first repository, never the workspace); the GitHub dialog's default project uses `taskProjectPath` for the same reason | `src/mainview/lib/repo-selection.test.ts` |
| The issue dialog's `@` listing only covered the issue repository | `PromptComposer` gets the same multi `fileScopes` as New Task (shared `repositoryFileScopes`, so colliding basenames get the workspace's `-2` suffix too) | `src/mainview/lib/repo-selection.test.ts` |
| A terminal open refused by a concurrent archive/delete skipped cleanup for multi, leaking the worktrees it materialized | `discardRefusedWorktree` takes the materialized entries and forwards the per-repository plan | `src/bun/terminals.test.ts` — "refused by an archive during prepareTaskWorkdir…" |
| No per-repository "View PR" in the card context menu | `view-repo-pr` entries resolved to each repository's URL and worktree | `src/mainview/lib/task-context-menu.test.ts` |
| A slug ending in `_` lost its PR proposal | only a *balanced* emphasis pair is stripped; edge underscores stay | `src/mainview/lib/pr-proposal.test.ts` |

Nits also closed: multi rows lazily pin each repository's `baseRef` on start/terminal
open (`pinMissingRepositoryBaseRefs`), the card comment says tooltip (not
popover), the repro test no longer sleeps, the e2e spec no longer carries
unreachable `test.skip` guards, and the commit-chip regression is now asserted
through the real UI (only a sibling repository dirty) rather than the pure
helper alone.

The third review round found four must-fix defects (nothing shipped to users —
all on this branch) plus the should-fixes below:

| Finding | Fix | Test |
| --- | --- | --- |
| A codex multi-repository run could not `git add`/`git commit`: the workspace root is not a git checkout, so `gitWritableRoots` returned `[]` and the sandbox stayed on `workspace-write` while each child's shared `.git` lives in its source repo | `gitWritableRoots` now falls back to the direct children with a `.git` pointer file and unions their common dirs; `buildCodexCommand` escalates as it already did for a single linked worktree | `worktree.test.ts` — "finds every linked worktree's common dir…" and "buildCodexCommand escalates from a multi-repository workspace root" |
| The per-repository terminal selector was unwired: `TerminalView`'s repo state was never set, defaulted to `repositories[0]` (not the documented workspace root), and had no UI; the run panel tab never reached it | `TerminalView` defaults to `null` (workspace), grows a `Workspace`/repository `<select>` for new shells, shows each tab's repository, and follows the run-panel repository tab; `RunPanelBody` passes `repoTab` down | `e2e/multi-repo-task.spec.ts` — "the terminal section defaults to the workspace and follows the repository tab" |
| `repoTab`/`allPrsBusy` were not reset in `RunPanelBody`'s `[task.id]` effect | both reset with the rest of the per-task state (documented rule in `run-panel.md`) | `docs/architecture/run-panel.md` |
| Archiving/deleting a Claude multi task left `<worktrees>/<task-id>` forever: `ensureInstalledForCwd` writes `.claude/settings.local.json` into the non-git workspace root, so the non-recursive `removeDirIfEmpty` refused | `removeWorkspaceIfEmpty` prunes only agetor's own `.claude/settings.local.json` (and the `.claude` dir once empty) before the non-recursive rmdir; the boot sweep also enqueues when only that root is left; orphan deletion reuses the same helper | `orchestrator-multi-repo.test.ts` — archive/delete tests seed the scratch and assert the workspace is gone |

Should-fixes closed with them: per-repository checkouts are refreshed on run
settle (`noteRunSettledCheckout` loops entries via `setRepositoryCheckout`) and
the header drift banner compares against the live `git-status` branch (not the
stored `checkoutBranch`); `teardownBranchesForTask` fetches the row list and
memoizes `repoRoot` and the default-branch lookup once per preview, removing
the N+1 git spawns per repository; `setRepositories` merges a possibly-stale
prepare snapshot with the current row so it can no longer erase a concurrent
PR stamp or checkout write (with a dedicated `recordPreparedRepositoryCheckouts`
at the refresh points); "Create all PRs" is gated by each repository's pushed/
synced git state and uses its live (possibly drifted) branch as the PR head
(`repositoryPrHead` in `commit-push.ts`); the three new test files use
`rmTestDataDir`; and the five fixed 350 ms sleeps are replaced with a poll on
the run's settled status.

## Fourth review round

At head `6f3db47a` the re-review confirmed rounds 1–3 closed and opened two
must-fixes plus four should-fixes. All are fixed with regressions:

| Finding | Fix | Test |
| --- | --- | --- |
| `bun run typecheck` was red: `rows` possibly null in the new search-limit test | the assertion reads `rows?.map(...)`, so a null answer fails the expected value instead of breaking the typecheck | `src/mainview/lib/use-project-files.test.ts` |
| The diff dialog's composer was repo-local while the agent reads the message at the workspace root, so labels omitted `<name>/` and `@` suggestions did not resolve | `prefixDiffSelectionPaths` prefixes each selected block with the active repository's workspace name; the composer now unions every repository's `@` scope, exactly like RunPanel, and renders the prefixed merged listing | `src/mainview/lib/diff-selection.test.ts` plus the e2e diff flow's compose-and-save assertion (`<name>/front.txt`) |
| A single `agetor add --repo <path>=<ref>` silently branched from HEAD | `createTask` reads the surviving single entry's `baseRef` when no top-level ref is given (top-level still wins) | `src/bun/orchestrator-multi-repo.test.ts` — "a single repositories entry keeps its per-repository base ref" |
| The issue dialog's fixed primary could be unchecked and re-added without git-root dedupe, so a same-root sibling made the client show multi while the server created single | `RepositoriesDialog` takes `lockedPath` (the issue repo cannot be unchecked or removed) and `pinPrimaryRepository` runs the same `dedupeSelections` as the dialog | `src/mainview/lib/repo-selection.test.ts` — "collapses a same-root sibling added while the primary was selected" |
| Capability discovery was not unioned per repo: RunPanel used only the active tab and CLI/TUI discovered at the non-git workspace root | `discoveryScopesForTask` is the shared multi-scope contract; `useAgentCapabilities` unions any number of scopes, `RunPanel` passes every repository, and the CLI/TUI (`discoveredExtensionNames`, `agetor commands`) merge one call per repository | `src/shared/file-scope.test.ts`, `src/cli/at-warn.test.ts` |
| The smoke doc claimed a green typecheck and five e2e tests, and had no round-4 record | results and the round-4 table above are current | this document |

## Live harness smoke matrix

Layout support is universal (the agent runs at the workspace root). Extra
per-repo roots (`--add-dir`) are added only for flag-capable kinds.

| Harness | Binary present | `--add-dir` | Status |
| --- | --- | --- | --- |
| claude-code | yes | yes | layout + extra roots supported; fake-driver integration test drives the spawn (`orchestrator-multi-repo.test.ts`) |
| codex | yes | yes | layout + extra roots supported (argv assertion in `agents.test.ts` families) |
| fx | yes | no | layout only (cwd); ACP `session/new` accepts the non-git workspace |
| opencode | yes | no | layout only (cwd) |
| cursor | yes | no | layout only (cwd); plan-limited account, not launched here |
| gemini | no | no | layout-supported, smoke-pending (owner accepted) |
| antigravity (`agy`) | no | no | layout-supported, smoke-pending |
| copilot | no | yes (argv) | layout + flag supported, smoke-pending |

The e2e fixture's fake claude driver is the automated proof of the spawn path
(prompt block, workspace cwd, persisted entries); a credentialed live launch is
the reviewer's manual step.

## Known limitations (also in the PR body)

Create-only repository set; 2+ requires worktree isolation; no per-repo
`existingBranch`; no hard cap (warning above 10); an older build sees the
workspace and may orphan secondary worktrees; Gemini's
`context.includeDirectories` write is not performed.
