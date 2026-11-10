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
  src/shared/multi-repo.test.ts src/shared/file-scope.test.ts \
  src/mainview/lib/repo-selection.test.ts src/mainview/lib/pr-proposal.test.ts \
  src/cli/commands/add.test.ts src/cli/commands/show.test.ts
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
| Existing 116 worktree tests | unchanged and green |

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
