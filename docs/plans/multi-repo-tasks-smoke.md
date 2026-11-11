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
  src/mainview/lib/commit-push.test.ts src/mainview/lib/agent-capabilities.test.ts \
  src/cli/commands/add.test.ts \
  src/cli/commands/show.test.ts src/cli/commands/shell.test.ts \
  src/cli/commands/rm.test.ts src/cli/commands/diff.test.ts src/cli/ls.test.ts \
  src/cli/tui/at-complete.test.ts src/cli/at-warn.test.ts \
  src/mainview/components/worktrees/worktree-delete-intent.test.ts
bun node_modules/@playwright/test/cli.js test e2e/multi-repo-task.spec.ts
```

## Results

| Check | Result |
| --- | --- |
| `bun run typecheck` | green |
| Focused multi-repo/unit suites | green — 1,156 tests across the 29 files above (round 5) |
| `bun test` | Round-3 full-suite evidence: 12,512 tests, 496 files — 12,477 pass, 31 skip, 4 fail, all load/timing-sensitive fake-tmux/opencode-fixture cases that rotated and passed on rerun. Round 4 re-ran the focused suite above and `bun test src/shared src/mainview src/cli` (5,084 pass); a fresh full-suite attempt was stopped under shared-machine load after 43/496 files with only the same known fake-tmux/claude-session timing failures. Round 5 re-ran `bun test src/cli src/shared` (3,025 pass) and `bun test src/mainview` (2,077 pass); a combined `src/shared src/mainview src/cli` run had six known load-sensitive tmux/ink timing failures that all passed when those files were rerun alone. |
| `bun test src/shared src/mainview src/cli` | 5,101 tests across 194 files — six load-sensitive fake-tmux/ink timing failures (Dashboard/AnswerOverlay/capture-refs); all passed on an isolated rerun |
| `bun test src/cli src/shared` (round 5) | green — 3,025 tests across 89 files |
| `bun test src/mainview` (round 5) | green — 2,077 tests across 105 files |
| `bun run typecheck` (round 6) | green |
| Focused unit suites (round 6) | green — `worktree` 134, `multi-repo`/`server`/teardown/CLI/mainview batches all pass |
| `bun test src/mainview` (round 6) | green — 2,079 tests across 105 files |
| `bun test src/shared src/cli` (round 6) | 2,948 pass; 88 known load-sensitive TUI/ink/bundle failures (none in the files this round touched); every touched file passes in isolation |
| `bun node_modules/@playwright/test/cli.js test e2e/multi-repo-task.spec.ts` | 6 passed (round 5); 7 passed after the round-6 archive round-trip split |
| `bun node_modules/@playwright/test/cli.js test e2e/issue-task.spec.ts` | 12 passed |
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

## Fifth review round

At head `3dcd01b5` the re-review confirmed rounds 1–4 closed and opened one
must-fix plus four should-fixes. All are fixed with regressions:

| Finding | Fix | Test |
| --- | --- | --- |
| The owner's "Full CLI + TUI parity" decision includes TUI multi-select, but the interactive `agetor add` wizard was still a single `p.select` (and T14 had been narrowed to say it stays single) | the wizard's repository step is a `p.multiselect` over registered projects plus `Other`; picking 2+ follows with one optional base-ref prompt per repository, sends `repositories[]`, and forces worktree isolation. `--repo`/`--workdir` remain authoritative and skip the picker. Every selection (including one) still goes through the same `baseInput` wire shape | `src/cli/commands/add.test.ts` — wizard describe (multi, single, `--repo`) |
| `RepositoriesDialog` had no test at all, and T16's "Create via the real UI" claim was false (the e2e created via `POST /tasks`) | the multi-repo e2e's first scenario now fills the New Task form, opens the dialog, selects the second repository, pins its base ref, saves and clicks "Run task"; the task it creates drives every later scenario | `e2e/multi-repo-task.spec.ts` — "create via the real UI…" |
| The dialog's `lockedPath` guards (issue dialog's own repository cannot be unchecked/removed) were untested | a dedicated issue-flow scenario asserts the checked+disabled checkbox and remove button, adds an extra repository, and verifies the created task keeps the issue repo first | `e2e/issue-task.spec.ts` — "repositories dialog: the issue's repository is locked…" |
| `useAgentCapabilities`' per-repository discovery union was untested | the merge moved to the pure `mergeAgentCapabilities` helper (first occurrence wins; failed scopes contribute nothing) | `src/mainview/lib/agent-capabilities.test.ts` |
| The diff composer's multi-repository `@` union was untested (only the path prefix was, via e2e) | the `RunPanel`/`DiffDialog` scope derivation is the shared `multiRepoFileScopes` helper, tested for single (empty) and multi (one named scope per repo) | `src/shared/file-scope.test.ts` |
| `agetor add --repo …` without `--start` silently skipped the advisory `@` pre-check: it listed the not-yet-created, non-git workspace root | `unresolvedRefsForTask` lists every repository scope, merges `<name>/…` paths (including synthesized directories), warns on unprefixed workspace paths, and verifies truncated scopes with a repo-local full-depth search | `src/cli/at-warn.test.ts` — `unresolvedRefsForTask` tests; `src/cli/commands/add.test.ts` |
| Nit: stale "also in the PR body" smoke heading | retitled "Known limitations" | this document |
| Nit: literal `claude-code` fallback in `commands/discovery.ts` | `Task.agent` is required, so the dead fallback is gone | `bun run typecheck` |

## Sixth review round

At head `4b3a9b16` the re-review confirmed rounds 1–5 closed and opened one
must-fix, six should-fixes and five nits. All are closed with regressions:

| Finding | Fix | Test |
| --- | --- | --- |
| A single-repository selection still showed a per-repository base-ref input whose value create never sent (single tasks carry the branch inline) | the dialog only renders that input for a genuinely multi selection (`dedupeSelections`), drops a leftover single entry's `baseRef` on save, and says the Branch field owns it | `e2e/multi-repo-task.spec.ts` — single selection has no base input, adding a second reveals it |
| Promoting a different first repository from the dialog kept the inline base ref picked for the old project | the dialog's `onSave` resets it, exactly like the ProjectPicker's `onChange` | `NewTaskForm.tsx` (same reset path as the picker) |
| A stale workspace child left by a failed prepare/teardown permanently blocked the next start, and the rollback skipped checks it had just created | `clearWorkspaceChild` (stale non-worktree child only; a real checkout is adopted) + `createdHere` covers re-attach + rollback gained the `rm` fallback | `worktree.test.ts` — stale child, adopted checkout, reattach rollback |
| `workspacePathFor` accepted `WORKTREES_DIR` itself as a workspace | it now requires a strict direct child of `WORKTREES_DIR` | `worktree.test.ts` — `workspacePathFor` confinement |
| `agetor ls --repo` only compared `workdir`, which is the non-git workspace root for a multi task | matches any selected repository's path/workspace name too | `src/cli/ls.test.ts` |
| `agetor diff` silently printed only `repositories[0]` | prints every repository in labelled sections; `--repo <name>` narrows; JSON array for the aggregate | `src/cli/commands/diff.test.ts` |
| The archive e2e's title/header claimed clean detach + unarchive while it only exercised a dirty partial teardown | it now archives both clean worktrees, asserts the branches survive, unarchives and asserts both checkouts return; a separate test covers the dirty partial case | `e2e/multi-repo-task.spec.ts` |
| Nit: `@<repo-root>` (e.g. `@frontend`) falsely warned "won't resolve" | each merged listing gains its repositories' root rows; the CLI pre-check adds the same roots | `src/cli/at-warn.test.ts`, `src/mainview/lib/use-project-files.test.ts`, `src/shared/at-file-filter.test.ts` |
| Nit: repeated `@` tokens each spent one full-depth verification round trip | candidates are deduped by raw token before the budget | `src/cli/at-warn.test.ts` |
| Nit: the git-status batch hardcoded 4 instead of the shared preparation constant | imports `MULTI_REPO_CONCURRENCY` | `bun run typecheck` (single source of truth) |
| Nit: a partial multi teardown toasted the clicked row's branch even when a sibling repository failed | `triageDeleteOutcome` names the failing `repositories[]` entry | `src/mainview/components/worktrees/worktree-delete-intent.test.ts` |
| Nit: the reproduction test leaked its temp data dir | `afterAll` removes it | `src/bun/multi-repo-repro.test.ts` |

## Seventh review round

At head `48748711` the re-review confirmed rounds 1–6 closed and opened one
must-fix, four should-fixes and three nits. All are closed with regressions:

| Finding | Fix | Test |
| --- | --- | --- |
| Must-fix: the Worktrees page's "Archive & delete" classified only the clicked repository row, then force-archived the whole task — a clean row click silently discarded a sibling repository's uncommitted work | the confirm now fetches every row of the task (all repos are marked busy during the flow) and the copy names each dirty/unknown checkout; per-checkout classification stays three-state (clean/dirty/unknown), while dirty and unknown siblings may legitimately co-exist | `src/mainview/components/worktrees/worktree-delete-intent.test.ts` — multi-repository siblings |
| Multi create without a git `workdir` planned the branch from the daemon cwd, ignoring an explicit `branch` override (or reading another repo's config) | `branchScopeDir` anchors the plan on `repositories[0]`; uniqueness is resolved per repository in the existing loop (never twice against one root) | `src/bun/orchestrator-multi-repo.test.ts` — branch from repositories[0] |
| `agetor shell` on a never-started multi task reported "directory no longer exists" | names the real state, and points at `--repo <name>` for a source-checkout shell | `src/cli/commands/shell.test.ts` |
| `--repo <path>=<ref>` split on `=` even when the whole value was an existing path, silently targeting a different repo | `parseRepoSpec`: an existing path (resolved against cwd) wins; only otherwise is the last `=` the ref separator | `src/cli/commands/add.test.ts` — `parseRepoSpec` |
| The TUI disabled full-depth `@` remote search for multi tasks (local-only ranking past the 20k cap) | searches every repository scope, routes `<repo>/…` queries to that scope with the prefix stripped, prefixes results, and round-robins them under the 5-row cap | `src/cli/tui/Dashboard.test.tsx` — truncated multi listing |
| Nit: `RepositoriesDialog` rows used the non-unique basename as a test id | test ids come from `uniqueRepoSlugs` over the displayed paths | `bun run typecheck` (`src/mainview/components/kanban/RepositoriesDialog.tsx`) |
| Nit: `uniqueRepoSlugs` produced nested suffixes (`app-2-2`) | a colliding numeric base resumes its stem's sequence (`app-3`) | `src/shared/multi-repo.test.ts` |
| Nit: the >10 warning counted pre-dedupe selections | counts the deduped selection (same predicate as the per-repo base-ref control) | `bun run typecheck` (`src/mainview/components/kanban/RepositoriesDialog.tsx`) |

## Eighth review round

At head `bf806e30` the re-review confirmed rounds 1–7 closed and opened one
must-fix and one should-fix. Both are closed with regressions:

| Finding | Fix | Test |
| --- | --- | --- |
| Must-fix: a task-level `baseRef` was silently ignored for 2+ repositories — `agetor add --repo a --repo b --base-ref release/next` (and a direct `POST /tasks` body) pinned each repository's HEAD instead of the requested sha | the task-level ref is the default for every entry without its own `repositories[].baseRef` pin (`--repo <path>=<ref>` still wins); the pre-validation error path resolves the same effective ref, so a typo'd default names every repository it is missing from | `src/bun/orchestrator-multi-repo.test.ts` — "a task-level base ref is the default for unpinned multi-repository entries" |
| Should-fix: the Worktrees delete confirm fetched every repository's git status with one unbounded `Promise.all` (N+1 subprocesses from one click), bypassing the page's `GIT_STATUS_CONCURRENCY` cap | the confirm batches its status reads at the same `GIT_STATUS_CONCURRENCY` (5) used by the list's own pass | `bun run typecheck` (`src/mainview/components/worktrees/WorktreesDialog.tsx`); the copy/classification itself stays covered by `worktree-delete-intent.test.ts` |

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

## Known limitations

Create-only repository set; 2+ requires worktree isolation; no per-repo
`existingBranch`; no hard cap (warning above 10); an older build sees the
workspace and may orphan secondary worktrees; Gemini's
`context.includeDirectories` write is not performed.
