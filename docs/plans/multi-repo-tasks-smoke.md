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
  src/cli/commands/add.test.ts src/cli/commands/show.test.ts \
  src/cli/commands/shell.test.ts src/cli/commands/rm.test.ts src/cli/tui/at-complete.test.ts
bun node_modules/@playwright/test/cli.js test e2e/multi-repo-task.spec.ts
```

## Results

| Check | Result |
| --- | --- |
| `bun run typecheck` | green |
| Focused multi-repo/unit suites | green (see the command above) |
| `bun test src/bun` | 7,437 tests, 302 files — green except three load-related flakes verified green in isolation (`opencode-server`, `opencode-tmux` timing, and the whitespace path-gate test updated for `itemField`) |
| `bun test src/shared src/mainview src/cli` | 5,044 tests, 192 files, green |
| `bun node_modules/@playwright/test/cli.js test e2e/multi-repo-task.spec.ts` | 3 passed |
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
