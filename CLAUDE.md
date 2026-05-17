# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Agetor is a local desktop app that orchestrates CLI coding agents (Claude Code, OpenAI Codex, others) from a kanban board. Each task is a prompt + working directory + agent choice; running it spawns the agent as a child process, streams its stdout/stderr to the UI, and moves the card through columns based on exit status.

It is **Electrobun** (not Electron) — native webviews driven by a Bun main process. Do not reach for Electron APIs, IPC patterns, or Node-only modules.

## Stack and architecture

Two processes share this repo and a small shared types directory:

- **Bun main process** (`src/bun/`) owns the Electrobun `BrowserWindow`, a SQLite store, and an HTTP API the webview talks to. The webview is loaded either from the Vite dev server (`http://localhost:5173` when present) or from the bundled `views://mainview/index.html`.
- **React webview** (`src/mainview/`) renders the kanban board with dnd-kit, talks to the Bun side over `fetch` + SSE, and uses hand-rolled shadcn/ui primitives styled with Tailwind v3 + CSS variables.
- **Shared** (`src/shared/types.ts`) is the only place both processes import from. Keep it free of runtime imports from either side.

The browser ↔ main connection is intentionally a localhost HTTP API (`Bun.serve` on `AGETOR_API_PORT`, default `4317`), not Electrobun's RPC. **The API binds to `127.0.0.1` only** and gates every route (except `/health`) on a **per-launch random token** generated in `src/bun/server.ts:API_TOKEN`. Both the port and the token are passed to the webview via `#api=…&token=…` on the window URL (hash fragment, **not** query string — the bundled `views://` scheme handler treats anything after the scheme as a literal file path and would otherwise look for a file named `mainview/index.html?api=…`). `src/mainview/lib/api.ts` reads them at load and echoes back as `Authorization: Bearer …` on fetches and as `?token=…` on the SSE URL (EventSource can't set headers). A site the user happens to visit can't read the token, so even with `ACAO` set permissively, drive-by CSRF can't drive an agent run.

### Orchestration flow

1. UI calls `POST /tasks` → `orchestrator.createTask` (async) → row in `tasks` table (column `backlog`). `isolation` defaults to `"worktree"`. When isolation is on and `workdir` is a git repo, `createTask` **resolves the base ref to a sha at create time** and pins it on the task row. Default base is `HEAD`; an explicit `baseRef` ("main", "v1.2.3", a sha…) is honored and validated — bad refs return `{ error }` instead of inserting. This pinning is what makes re-runs reproducible: the worktree is always built off the same starting commit even after the source repo moves.
2. UI calls `POST /tasks/:id/start` → `orchestrator.startTask`:
   - **Pre-flight 1 — agent availability** (`agent-status.ts`): if the agent binary isn't on `PATH`, returns a friendly error with an install hint *before* any state mutation.
   - **Pre-flight 2 — workdir isolation** (`worktree.ts`, `prepareWorkdir`): if `task.isolation === "worktree"` and `workdir` is inside a git repo, creates `~/.agetor/worktrees/<task-id>/` on a fresh branch `agetor/<short-id>-<slug>` off the current HEAD. Idempotent — reused across re-runs. Falls back to running in `workdir` if isolation is off or the dir isn't a git repo.
   - Inserts a `runs` row, flips the task to column `running`, persists `branch` + `worktreePath` on the task row, sets `task.runId`.
   - `agents.spawnAgent` calls `Bun.spawn` with the command from `buildCommand(agent, prompt)` and the prepared cwd (worktree path, or raw workdir on fallback).
   - Every stdout/stderr chunk is appended to `run_events` **and** broadcast to all SSE subscribers.
   - On exit: status row updated, task moves to `review` (exit 0) or back to `ready` (non-zero).
3. UI subscribes via `EventSource` on `/runs/:id/events`. The endpoint replays persisted events first, then streams live ones — this is what lets you close and reopen the run panel without losing scrollback.
4. `DELETE /tasks/:id` → `orchestrator.deleteTask` kills any active run, then `removeWorktree` best-effort tears down `git worktree remove --force` + `git branch -D`. If the worktree path still exists afterwards and lives under `dataDir/worktrees/` (our owned namespace), `removeWorktree` does an `rm -rf` fallback — this catches the case where the user changed `task.workdir` after the worktree was materialized, so git in the new workdir doesn't know about the registration. Never blocks the delete.
5. **Boot reconciliation**: `index.ts` calls `orchestrator.reconcileOrphans()` before starting the API. Any rows with `status='running'` from a previous process are flipped to `status='orphaned'` (a new run status alongside `succeeded` / `failed` / `cancelled`), their parent tasks go back to `column='ready'` with `run_id=NULL`, and a status event is appended explaining what happened. Cancellation is tracked via a `cancelled: boolean` flag on the in-memory `active` map entry — the exit handler reads it to decide whether to record `cancelled` vs `failed`.
6. **PATCH /tasks/:id allow-list**: only `title`, `prompt`, `agent`, `workdir`, `column` are patchable. Worktree-derived fields (`branch`, `worktreePath`, `baseRef`) and identity fields (`id`, `runId`, `createdAt`, `updatedAt`, `isolation`) are server-managed. The webview's edit dialog also locks the `workdir` field once `task.worktreePath !== null`, so the UI prevents the orphan scenario before the server would have to clean it up.

### Agent command shape

`src/bun/agents.ts` is the single source of truth for how each agent is invoked. `buildCommand(agent, prompt, { mode, model, effort })` returns the launch argv and any env additions; `spawnAgent(...)` then dispatches:

- **`claude-code`** → driven through `src/bun/claude-tmux.ts`. One tmux session per task hosts the interactive `claude` REPL. Launch argv looks like `claude [--model claude-opus-4-7] [--dangerously-skip-permissions | --permission-mode <id>]` (no `--print` — `claude -p` would draw from a separate Agent SDK credit starting 2026-06-15, so we use the regular subscription quota via interactive mode). The prompt is delivered as keystrokes via `tmux load-buffer + paste-buffer + send-keys Enter`. Structured output comes from tailing `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Effort maps to `CLAUDE_CODE_EFFORT_LEVEL` env. Tmux is a hard prereq — `checkAgent` reports unavailable if `tmux -V` fails.
- **`codex`** → still a one-shot `codex exec [--model gpt-5] [--full-auto] <prompt>` via `Bun.spawn`. Effort → `-c model_reasoning_effort=<id>`.

Defaults preserve hands-off behavior: `null` `task.mode` becomes `auto` (`--dangerously-skip-permissions` for claude-code, `--full-auto` for codex). Unknown mode/model ids are passed through verbatim so unreleased options "just work" without code changes.

The curated lists shown in the UI live in **`AGENT_OPTIONS`** in `src/shared/types.ts`. To add a model or mode: extend the relevant `AgentOptions.models` / `AgentOptions.modes` array, then teach `buildCommand` how to translate it (or rely on the verbatim passthrough). The webview picks it up on next load.

Override per-agent at runtime with env vars: `AGETOR_CLAUDE_BIN`, `AGETOR_CLAUDE_ARGS`, `AGETOR_CODEX_BIN`, `AGETOR_CODEX_ARGS`, `AGETOR_TMUX_BIN`. Tests use `/bin/echo` via these overrides for codex and the `agent-status` probe, and `AGETOR_CLAUDE_DRIVER=fake` to bypass tmux + the real CLI entirely.

### Claude session lifecycle (one tmux session per task)

- `startTask` on a claude task → `tmux new-session -d -s agetor-<taskId-prefix> -c <cwd> -- claude …`, sends the prompt, and tails the JSONL. The run row records `tmux_session`.
- Each subsequent user message from the run panel (`sendInput`) creates a **new run row** and routes through `sendTurn` — same tmux session, fresh "done on next end_turn" listener. The run history therefore grows one row per user turn. The run panel shows a **unified task-level event stream** (every run's events merged in id order via `GET /tasks/:id/events`), so the badge race that used to make a fast claude reply land the new row as `succeeded` before the UI observed the `running` transition is no longer a UX issue — the user sees their message + the assistant response stream live regardless of per-row status. The runs list itself is an informational, expandable summary; it doesn't gate the stream view.
- **Stop** (`cancelRun`) sends `Ctrl+C` via `tmux send-keys`. The session stays alive for follow-ups; only the in-progress turn aborts.
- **Delete task** (`deleteTask`) calls `dropSession(taskId)` → `tmux kill-session` before tearing down the worktree.
- **Boot reconciliation** kills any leftover `agetor-*` tmux sessions (we can't safely reattach JSONL tailing across an agetor restart), then flips `running` rows to `orphaned`.

To add a new agent kind, extend the `AgentKind` union in `src/shared/types.ts`, add an entry to `AGENT_OPTIONS`, and add a branch in `buildCommand` + `spawnAgent`. The orchestrator and UI pick it up automatically.

### Persistence

`bun:sqlite` at `$AGETOR_DATA_DIR/agetor.sqlite`. The packaged .app defaults to `~/.agetor/`; the dev scripts (`bun run dev` / `bun run dev:hmr`) set `AGETOR_DATA_DIR=$HOME/.agetor-dev` in `package.json` so an in-progress migration, a fixture, or a corrupt seed can't poison the release build's state. Wipe the dev dir with `bun run wipe:dev` (only ever touches `~/.agetor-dev`). WAL + foreign keys on. Tests set `AGETOR_DATA_DIR` in `beforeAll` to a `mkdtemp` directory — keep doing that for any new test that imports `./db.ts` or `./orchestrator.ts`, since the db opens (and migrates) on module load.

**Migrations** live in `src/bun/migrations/` as numbered `.sql` files (`001_init.sql`, `002_…sql`, …). The runner (`src/bun/migrate.ts`) applies each pending file in a single transaction and records it in the `_migrations` table; rerunning is a no-op. To add a migration:

1. Create `src/bun/migrations/00N_short_name.sql` with `CREATE …` / `ALTER …` statements.
2. Add a matching entry to the `migrations` array in `src/bun/migrations/index.ts` (import via `with { type: "text" }`). The array's order is the apply order — append, never reorder.
3. **Never edit a migration that has already been applied** — write a new one. The `_migrations` table only tracks ids, so silent edits will diverge from existing user databases.

SQL is inlined at bundle time via text imports (not `readdirSync`) because `electrobun build` produces a single `bun/index.js` and the `migrations/` directory is not copied into the packaged app.

## Commands

```bash
bun install                      # install deps
bun run dev                      # Electrobun, no HMR (loads from views://, requires `bun run build` first)
bun run dev:hmr                  # Vite + Electrobun together — preferred for UI work
bun run build                    # vite build → electrobun build (produces a packaged app)
bun run typecheck                # tsc --noEmit; must be green
bun test                         # bun's test runner
bun test src/bun/orchestrator.test.ts   # run a single test file
bun test -t "createTask"         # filter by test name
```

When iterating on the webview, run `bun run dev:hmr`. When iterating on `src/bun/*`, restart `bun run dev` — main-process changes don't HMR.

## UI conventions

- Dark mode is the default and only currently supported theme. `<html class="dark">` is set in `src/mainview/index.html`; the light tokens in `index.css` exist only so an explicit `class=""` would still render. Don't add a theme toggle without also adding a light visual pass.
- shadcn primitives live under `src/mainview/components/ui/` and were added manually (no shadcn CLI). `components.json` is configured (`new-york`, base color `zinc`, alias `@/components`, `@/lib/utils`) so `bunx shadcn add <component>` will work for future additions.
- Tailwind v3 with class-based dark mode and shadcn-style HSL CSS variables — do not migrate to Tailwind v4 without updating `tailwind.config.js` and the `@layer base` block in `index.css` together.
- The `@/` import alias is wired in **both** `vite.config.ts` (`resolve.alias`) and `tsconfig.json` (`paths`). Keep them in sync.

## Things that will trip you up

- `electrobun/bun` transitively imports `three`. TypeScript without `@types/three` errors out, so `src/types/three.d.ts` ships a `declare module "three";` shim. Don't delete it unless you've installed real types.
- The Bun-side default `bun init` left behind `.cursor/rules/use-bun-instead-of-node-vite-npm-pnpm.mdc`. Its "don't use vite" advice does **not** apply here — this project intentionally uses Vite for the webview (HMR + JSX). The rule's other advice (`Bun.serve`, `bun:sqlite`, `Bun.spawn`, `Bun.file`) is followed.
- `Bun.serve` routes in `src/bun/server.ts` use the new object-style `routes` API with path params (e.g. `/tasks/:id`). When adding routes, follow that shape — `fetch()` is only the 404 fallback.
- The kanban board polls `/tasks` every 2s for simplicity. If you replace it with push updates, make sure the run panel's SSE subscription still gets a refreshed `task` object when columns change (App.tsx already keeps `selected` in sync from `tasks`).
- `RunPanel` keeps its own state (selected run, log buffer) keyed by `task.id` (see `<RunPanel key={selected.id} … />` in `App.tsx`). Switching to a different task remounts it, which is intentional — without the key the previous task's `selectedRunId` would leak across.
- `GET /tasks/:id/runs` returns the full run history for a task, newest first. The run panel polls this every 2s while open so finished runs flip their status badge and durations tick.
- Agents run with the user's full shell privileges in whatever `workdir` the task specifies. There is no sandbox. Don't add a "run on remote repo" feature without thinking about that.
- Worktree isolation creates branches in the **user's source repo** (`workdir`), not a clone. Branches are named `agetor/<short-id>-<slug>` and worktrees live under `~/.agetor/worktrees/<task-id>/`. Tests must use a temp git repo (see `worktree.test.ts`) or pass `isolation: "none"` (see `orchestrator.test.ts`), otherwise they will create real branches in whatever repo `process.cwd()` resolves to.
