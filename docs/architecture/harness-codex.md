# Harness: codex

> Moved from `CLAUDE.md`, where this was the `codex` bullet of “Agent command shape”. Index of all subsystem docs: the [Topic map in CLAUDE.md](../../CLAUDE.md#topic-map).

**`codex`** → driven through `src/bun/codex-tmux.ts`.
Each turn is a one-shot `codex exec [--model gpt-6.1-sol] -c model_reasoning_effort=<id> --json --color never --skip-git-repo-check --sandbox <workspace-write|read-only> [resume <thread_id>] -` (prompt via stdin, the trailing `-`), but it runs **inside a detached per-task tmux session** (`sh -c 'exec <argv> < promptfile > runlog 2>&1'`) so a mid-turn run survives an agetor restart.
Structured output comes from tailing codex's `--json` NDJSON log (`dataDir/codex-logs/<runId>.jsonl`); the mapper (`mapCodexEvent`) turns its events into the same `assistant`/`thinking`/`tool_use`/`tool_result` streams claude emits, keyed by `line_uuid = "${event.type}:${item.id}"`.
The `thread.started` event's `thread_id` is persisted as `runs.codex_session_id` and replayed via `codex exec resume <thread_id>` for follow-up turns — codex's tmux session lives only DURING a turn (it's one-shot), so multi-turn continuity is carried by the thread id, not a live REPL.

**Effort → `-c model_reasoning_effort=<id>`.** Note: `gpt-5`/`gpt-5-codex` are rejected on ChatGPT-account auth.
The GPT-6 rows are gated on the **codex CLI version**, not the account: OpenAI's `chatgpt.com/backend-api/codex/models` catalog is `client_version`-gated (NousResearch/hermes-agent#119412), and an old CLI answers a 400 whose text blames the ChatGPT account.
Measured 2026-09-22 on a ChatGPT-plan account: 0.147.0 400s Astra ("requires a newer version of Codex") and Sol/Luna ("not supported when using Codex with a ChatGPT account"), 0.153.0/0.154.0 run Astra but still 400 Sol, 0.155.1 runs all three.
`MODEL_MIN_CLI_VERSION` (`src/shared/types.ts`; codex: gpt-6.1-sol/gpt-6.1-terra → 0.159.0, gpt-6-sol/gpt-6-luna → 0.155.0, gpt-6-astra/-aeon → 0.153.0) plus `startTask`'s Pre-flight 1b (`minCliVersionError` in `orchestrator.ts` over `cliVersionSatisfies` in `src/shared/cli-version.ts`, right after the logged-in gate and before `prepareWorkdir`; re-run by `spawnCodexTurnNow` for every follow-up turn) refuse such a run before any run row/worktree exists, with the installed version, the floor and the upgrade hint (`upgradeHintFor`) in the error — strictly fail-open when the probed version doesn't parse (every `/bin/echo` test override), so it can never block a stub.
GPT-6.1 Sol (released 2026-09-29, the upgrade to GPT-6 Sol at the same price — near-Astra quality) is the default (owner decision, `docs/plans/add-gpt-6-1-sol.md`, superseding the 2026-09-22 GPT-6 Sol decision in `docs/plans/add-gpt-6-sol-and-luna.md`); it needs codex ≥ 0.159.0 (0.147.0–0.158.0 all omit it from `model/list`; live turns on 0.147.0/0.155.1/0.158.0 answer the same misleading ChatGPT-account 400; codex 0.159.1 made it its own bundled default), offers low/medium/high/xhigh/max + `ultra` and — unlike every earlier Sol — rejects `none` with a live 400; GPT-6 Sol stays available with no retirement date.
GPT-6.1 Terra (released 2026-10-26; replaces GPT-5.6 Terra at about half its price, `docs/plans/add-gpt-6-1-terra.md`) sits directly under 6.1 Sol in the picker and needs codex ≥ 0.159.0 too (0.158.0 answers the same misleading ChatGPT-account 400); unlike 6.1 Sol it accepts `none` live (`none`, `low` and `ultra` all ran on 0.162.1; `minimal` 400s), plus `ultra` — but codex's own catalog lists it low…max + `ultra` without `none`, so the live picker (where discovered efforts win) shows ultra…low and the curated `none` only surfaces when discovery is empty.
As of 0.159.2 codex's catalog carries no upgrade pointers on the GPT-5.6 Sol/Terra/Luna rows any more.

**GPT-5.5 is retired from the codex picker**: codex no longer lists it and a ChatGPT-plan turn answers a 400, so the row and its `MODEL_EFFORT_SUPPORT.codex` key are gone and migration `075_retire_codex_gpt_5_5.sql` moves codex-kind `tasks` and `agent_profiles` plus the `lastModel:codex` preference to `gpt-6.1-sol`, kind-joined on `harnesses.kind = 'codex'` (Cursor's `gpt-5.5` spec is a live row and fx's `openai/gpt-5.5` is a separate model; both stay untouched); on the rows it moves, an effort GPT-6.1 Sol rejects (`none`, `minimal`, `auto`, anything outside ultra…low) becomes `high`, while frozen agent-profile snapshots, `updated_at` and `lastEffort:codex` are left alone.
One-way and idempotent.
`--sandbox` replaces the deprecated `--full-auto`.
Effort `ultra` is Codex's delegation tier (offered for Astra/Aeon/GPT-6.1 Sol/GPT-6.1 Terra/GPT-6 Sol/GPT-5.6 Sol/Terra/Cyber, not either Luna).

**Worktree git writes → full-access escalation**: in `workspace-write`, a linked-worktree task's `.git` is a *file* pointing at the source repo's `.git/worktrees/<id>`, and a `git commit`'s objects/refs land in the shared `<repo>/.git` *outside* the worktree root codex makes writable — so codex's sandbox blocks the commit.
When `git rev-parse --git-common-dir` for the run's cwd resolves outside that cwd (a linked worktree, or an isolation=none task whose workdir is a repo subdir), `buildCommand` escalates the `auto` run from `workspace-write` to `--sandbox danger-full-access -c approval_policy=never` (granting the external `.git` via `sandbox_workspace_write.writable_roots` is unreliable — codex keeps `.git` read-only under some workspace policies).
That's consistent with agetor's no-sandbox philosophy and claude-code's hands-off `auto` mode (`--permission-mode auto`; `--dangerously-skip-permissions` is claude-code's `bypass` mode); `approval_policy=never` keeps headless `codex exec` from stalling on an approval it can't surface.
The external-git signal is resolved by the async `gitWritableRoots(cwd, codexWorkspaceRepos)` in `worktree.ts` (it shells out through the file's async `git()` helper, never a sync spawn, because every codex spawn runs on the core's shared thread; returns `[]` for an ordinary in-cwd `.git`, leaving `workspace-write` in place) and threaded in via `buildCodexCommand` → `spawnAgent` — the single choke point all codex spawn paths share.
**Multi-repository workspaces** ([multi-repo-tasks.md](multi-repo-tasks.md)): the run's cwd is the task's workspace root, which is not a git checkout, so `git rev-parse` there fails. The orchestrator then passes the task row's own checkouts as `codexWorkspaceRepos` (`{ worktreePath, repoPath }` per materialized repository whose checkout exists on disk at spawn time, set by `withTaskRepositoryRoots` in `spawnAgentOrFail` on every spawn path; absent for a single-repository task, and for a multi task none of whose checkouts exist).
A checkout's git common dir becomes an external git dir only when the checkout is strictly inside the cwd, `git rev-parse --show-toplevel` there is exactly that path, and its common dir equals the common dir of the source repository the entry names; any one qualifying checkout escalates the `auto` run exactly as a single linked worktree does.
Nothing is found by scanning the cwd: the old fallback that unioned every child directory's `.git` let an agent plant a checkout whose `.git` lives anywhere (`git init --separate-git-dir`, a worktree of another repository) and get full access on its next turn, and it read the workspace in the core's own process (D25, [security.md](security.md)).
A non-git cwd with no `codexWorkspaceRepos` gets `[]` and stays on `workspace-write`.
Live-verified on codex-cli 0.166.0 (2026-11-12, `docs/plans/multi-repo-tasks-smoke.md`): an `auto` multi-repository run recorded `sandbox_policy: danger-full-access` and `approval_policy: never`, accepted `--add-dir`, and committed in each checkout; a follow-up turn resumed and stayed escalated.
The same checkouts also ride the argv as `--add-dir <checkout>` (after the `--sandbox` flag, before `resume`), one per repository, on every turn including `exec resume`.
The read-only (`ask`) sandbox is never escalated.

**Model discovery**: `codex prompt --models` never existed (both 0.147.0 and 0.153.0 reject it as an unknown argument), so `discoverCodex` speaks `codex app-server` JSON-RPC instead — `initialize` → `initialized` → `model/list` — an account-scoped, server-fetched catalog (cached by codex itself in `~/.codex/models_cache.json`) that carries each model's `supportedReasoningEfforts` alongside its id/label.
Wherever agetor decides which efforts a model supports (the four pickers, `agetor add`, `createTask`'s default effort, the PATCH null-clear guard, model-change cascades), a model's discovered effort set wins over the curated `MODEL_EFFORT_SUPPORT` table when the CLI reported one; the curated table is only the fallback when discovery is empty.
The PATCH guard stays null-clear-only and never rejects a non-null effort id, because Codex's own catalog understates what the API accepts (`ultra` ran live on Luna despite not being offered there, and `none` ran live on GPT-5.6 Sol and Luna, GPT-6 Luna and GPT-6.1 Terra although the catalog omits it; GPT-6.1 Sol is the exception that answers `none` with a 400, above) — rejecting on the catalog would block values that actually run.
A catalog change that only alters efforts (not ids) still republishes `agent_models_changed`.

## `CODEX_HOME` isolation and harness stacks

`CODEX_HOME` alone owns login (`auth.json`), config, sessions, MCP servers and
every write; `HOME` is not overridden. The account's own env map may pin
`CODEX_HOME` itself, which wins over the home-derived `<home>/.codex` (the
mirror and rollout transfer use that same root). An account with neither is
handed this process's `CODEX_HOME`, or has it unset (`pinCodexHome`), so the
long-lived tmux server's env can never redirect it. A harness-stack failover
copies the rollout to the same relative path under the destination `CODEX_HOME`, runs
`codex migrate-rollouts --apply` when a `thread_history_*.sqlite` already
exists (30 s timeout, best-effort), and resumes with `exec resume <threadId>`.
A failed resume blocks the swap visibly rather than starting a fresh session.
MCP OAuth tokens are not copied (no stable standalone file in `auto`/`file`
mode); the swap warns that sign-in may need repeating. The mirror never imports
the primary's login-bearing `config.toml` keys or `[model_providers.*]` tables.

A limit signal comes only from a terminal `turn.failed` (its own message, or
the classification remembered from the last top-level `error`). A top-level
`error`, an `error` item and a non-JSON log line never signal, and
`turn.completed` or any `item.*` event discards a remembered one (a codex that
exits with no terminal event while one is remembered emits it instead of the
"ended unexpectedly" sentinel), so a 429 that codex retried and
recovered from is never a limit; the orchestrator also ignores a codex limit on
a run that exited 0. Codex 0.166 reports quota in prose — "You've hit your usage
limit. … try again at <date> <time>" (quota, with the reset parsed) and "Quota
exceeded. Check your plan and billing details." (out of credits) — and the
classifier matches that prose plus the snake_case codes (`usage_limit_reached`,
`rate_limit_exceeded`, …) and honours a structured `codex_error_info` /
`error.code` / `error.type` when one is present. Full behaviour:
[harness-stacks.md](harness-stacks.md).
