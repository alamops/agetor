# Agetor

**Website:** [agetor.dev](https://agetor.dev)

> A local-first kanban board for orchestrating CLI coding agents — Claude Code, OpenAI Codex, and friends — across many tasks and many repos at once.

Agetor turns a kanban board into a control plane for AI coding agents. Each card is a prompt plus a working directory plus an agent choice; starting it spawns the agent as a child process inside an isolated git worktree, streams its output back to the UI, and moves the card through columns as the run progresses. Approvals, clarifying questions, and follow-up messages flow through structured cards in the run panel instead of getting buried in a TUI.

It runs entirely on your machine. No cloud relay, no remote sandbox — agents execute with your shell privileges in your repos, the same way they would if you launched them by hand. Agetor just adds the orchestration, isolation, and UI on top.

![Agetor app preview](docs/agetor-demo.png)

---

## Highlights

- **Multi-agent, multi-account.** Built-in support for `claude-code` and `codex`. Define additional *harnesses* to run a second Claude or Codex account in parallel — each one gets a dedicated `$HOME` so logins, history, and config never collide.
- **Per-task git worktrees.** Every task runs on its own branch (`agetor/<short-id>-<slug>`) in a dedicated worktree under `~/.agetor/worktrees/`. Two agents can hammer the same repo simultaneously without stepping on each other. Base ref is pinned at create time, so re-runs always start from the same commit.
- **Interactive Claude sessions.** Claude Code is hosted in a per-task `tmux` session that stays alive across multiple turns. Follow up on a task without losing the conversation. Output is streamed by tailing Claude's own JSONL transcript, so assistant text, thinking blocks, tool calls, and tool results all render with their own UI components.
- **Approvals and questions, lifted out of the TUI.** Agetor watches Claude's tmux pane and JSONL transcript to detect `AskUserQuestion` / `ExitPlanMode` modals and tool-permission prompts, and surfaces them in the run panel as structured cards — radios, checkboxes, free-text. It's fully non-invasive: it registers no MCP server and installs no hook (it only strips stale entries left by older builds). Codex prompts are detected heuristically from stdout and surfaced the same way.
- **Live event stream.** SSE per task and a global event channel. Status toasts and native notifications fire when a run finishes, succeeds, fails, or blocks waiting on input.
- **Reproducible re-runs.** Run history persists per task. Cancelling a run keeps the tmux session alive so you can iterate; deleting a task tears down its worktree, branch, and session.
- **Local SQLite.** All state — tasks, runs, events, projects, harnesses, preferences, approval rules — lives in `~/.agetor/agetor.sqlite` with a versioned migration runner. Nothing leaves your machine.

---

## How it works

Agetor is an [Electrobun](https://github.com/blackboardsh/electrobun) app — a Bun main process that owns the window and a native WebView that renders the UI.

```
┌─────────────────────────┐       HTTP + SSE        ┌─────────────────────────┐
│  React webview          │ ◀──────────────────────▶│  Bun main process        │
│  (kanban, run panel)    │   127.0.0.1 + token     │  (SQLite, orchestrator) │
└─────────────────────────┘                         └─────────────┬───────────┘
                                                                  │ spawn
                                                  ┌───────────────┴───────────────┐
                                                  ▼                               ▼
                                       ┌──────────────────┐            ┌──────────────────┐
                                       │  tmux: claude    │            │  codex exec      │
                                       │  (per task)      │            │  (one-shot)      │
                                       └──────────────────┘            └──────────────────┘
                                                  │                               │
                                                  ▼                               ▼
                                       ┌──────────────────┐            ┌──────────────────┐
                                       │ git worktree per │            │ git worktree per │
                                       │ task             │            │ task             │
                                       └──────────────────┘            └──────────────────┘
```

Some key design decisions:

- **Localhost API, not Electrobun RPC.** The webview talks to the main process over a plain HTTP API bound to `127.0.0.1` on a configurable port. Every route (except `/health`) is gated on a per-launch random bearer token passed to the webview via a `WKUserScript` preload. A site you happen to visit can't drive an agent run even if it guesses the port.
- **One tmux session per Claude task.** `claude` runs in interactive mode (so you draw from your normal subscription quota, not the Agent SDK credit). Prompts are delivered as keystrokes via `tmux load-buffer + paste-buffer + send-keys`. Output is read from the JSONL Claude writes to `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
- **Codex stays one-shot.** Each Codex run is a fresh `codex exec` invocation; follow-ups create a new run record on the same task.
- **Boot reconciliation.** On startup, any tmux sessions left over from a previous Agetor process are killed, and any rows still marked `running` are flipped to `orphaned`. The kanban never shows stuck cards.

The full architecture, schema, and lifecycle is documented in [`CLAUDE.md`](./CLAUDE.md).

---

## Requirements

- **Bun** ≥ 1.1 ([install](https://bun.sh))
- **tmux** — hard requirement for the Claude Code driver
  - macOS: `brew install tmux`
  - Debian/Ubuntu: `apt install tmux`
- **At least one agent CLI on `PATH`:**
  - `claude-code`: `npm i -g @anthropic-ai/claude-code`
  - `codex`: `npm i -g @openai/codex`
- **Git** — required for worktree isolation
- **Platforms:** macOS (primary). Linux and Windows builds are configured in `electrobun.config.ts` but are not currently tested.

Agents are launched with your full shell privileges in whatever directory the task points at. There is no sandbox.

---

## Getting started

```bash
# Clone and install
git clone https://github.com/alamops/agetor.git
cd agetor
bun install

# Build the webview bundle once (required for `bun run dev`)
bun run build

# Run it
bun run dev
```

For UI iteration, run Vite and Electrobun together:

```bash
bun run dev:hmr
```

That starts Vite on port `5173` for hot reload and Electrobun in dev mode in parallel. Main-process changes (anything under `src/bun/`) do *not* hot-reload — restart `bun run dev:hmr` after editing them.

### First task

1. Click **New task** in the left rail.
2. Pick a workdir (any local folder; if it's a git repo, you'll get worktree isolation for free).
3. Choose an agent and a model, and write your prompt.
4. Hit **Run task** to start it immediately, or **To backlog** to queue it.

Drag cards between columns to override flow manually. Open a card to see the live event stream, send follow-up messages, or answer approval prompts.

---

## Command-line interface (`agetor`)

Agetor also ships as a standalone terminal CLI — drive the same board from your shell, with or without the desktop app open.

### Install

```bash
curl -fsSL https://github.com/alamops/agetor/releases/latest/download/install.sh | sh
```

The installer is arm64-macOS only (matching the app), verifies a SHA-256 checksum, and drops a single `agetor` binary in `/usr/local/bin` (falling back to `~/.local/bin`). To build it from source instead:

```bash
bun run build:cli          # → artifacts/agetor-arm64 (+ .sha256, install.sh)
# …or run straight from source, no build:
bun src/cli/index.ts --help
```

### How it connects

The CLI is a thin client over the same localhost API the webview uses. It discovers the running core through a `0600` credentials file (`~/.agetor/agetor-core.json`, written on launch with the per-launch port + token). If the desktop app is open, the CLI talks to it; if not, it **auto-starts a headless background daemon** that shares the same `~/.agetor` state — so a task you add from the CLI shows up in the app and vice-versa. When you later open the app, the daemon hands the port off to it.

It honors the same `AGETOR_DATA_DIR` / `AGETOR_API_PORT` as the app, so e.g. `AGETOR_DATA_DIR=~/.agetor-dev agetor ls` targets the dev tree.

### Commands

```bash
agetor                      # full-screen live dashboard (board + streaming detail)
agetor add                  # create a task (guided wizard, or --title/--prompt[/--start])
agetor ls                   # list all tasks        (ps = running/blocked only)
agetor show <id>            # details, runs, pending interactions
agetor start <id>           # start a task
agetor send <id> <msg…>     # message a running task
agetor answer <id>          # answer a task that needs input (interactive picker)
agetor logs <id>            # stream a task's live conversation (--no-follow for a snapshot)
agetor cancel <id>          # stop the active run
agetor rm <id> --yes        # delete a task (worktree + branch)
agetor daemon status|start|stop
```

Every command accepts `--json` for scripting, `--data-dir <dir>` / `--port <n>` to target a specific core, and `--no-daemon` to fail instead of auto-spawning one. Short id prefixes (the 8 chars shown in `agetor ls`) work anywhere an `<id>` is expected. The desktop `.dmg`/`.app` is unchanged — the CLI is an additional surface, not a replacement.

---

## Configuration

All persistent state lives in `~/.agetor/` (override with `AGETOR_DATA_DIR`):

```
~/.agetor/
├── agetor.sqlite               # tasks, runs, events, projects, harnesses, preferences
├── agetor-core.json            # 0600 creds file: the running core's port + token (CLI auth)
├── daemon.log                  # headless CLI daemon log (when the app isn't running)
├── worktrees/<task-id>/        # per-task git worktrees
└── harnesses/<id>/             # optional per-harness HOME (multi-account)
```

### Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `AGETOR_DATA_DIR` | Where the SQLite db, worktrees, and bin scripts live. | `~/.agetor` |
| `AGETOR_API_PORT` | Localhost port the main process binds. | `4317` |
| `AGETOR_CLAUDE_BIN` | Override the `claude` binary path. | `claude` on `PATH` |
| `AGETOR_CLAUDE_ARGS` | Extra args appended to every Claude spawn. | *(none)* |
| `AGETOR_CODEX_BIN` | Override the `codex` binary path. | `codex` on `PATH` |
| `AGETOR_CODEX_ARGS` | Extra args appended to every Codex spawn. | *(none)* |
| `AGETOR_TMUX_BIN` | Override the `tmux` binary path. | `tmux` on `PATH` |
| `AGETOR_CLAUDE_DRIVER` | Set to `fake` to skip tmux + the real CLI (test-only). | unset |
| `AGETOR_DAEMON_IDLE_MS` | CLI daemon: idle-shutdown after this long with no run and no attached client. `0` disables. | `300000` (5 min) |

Per-harness `bin`, `home`, and `env` overrides are configured through the Settings dialog and stored in SQLite — they take precedence over the corresponding env vars.

---

## Concepts

### Tasks, columns, and runs

A **task** is a prompt + workdir + agent. It lives in one of six columns:

| Column | Meaning |
| --- | --- |
| Backlog | Queued, not started. |
| Ready | Created via "Run task" but waiting on pre-flight. |
| Running | Agent is actively producing output. |
| Blocked | Agent is waiting on an approval, question, or plan review. |
| Review | Last run exited `0`. The diff is yours to inspect. |
| Done | You've decided you're satisfied. |

A **run** is a single invocation of the agent on a task. Tasks accumulate run history; the run panel can replay any past run's events.

### Harnesses

A **harness** is a named agent configuration. The two built-ins (`claude-code`, `codex`) wrap each CLI directly. User-defined harnesses are *aliases* that wrap the same underlying kind with extra env, an alternate binary, or — most usefully — a per-account `$HOME` override. That last knob lets you run a second Claude or Codex account in parallel without their logins overwriting each other.

Add a harness from **Settings → Harnesses**. Templates pre-fill common patterns.

### Modes, models, and effort

Each task picks:

- a **mode** — how much permission the agent has (`auto`, `ask`, `acceptEdits`, `plan`, `bypass` — exposed per agent),
- a **model** — Opus / Sonnet / Haiku for Claude, GPT-5 / GPT-5 Codex for Codex,
- an **effort** level — reasoning depth, where the model supports it.

The picker filters incompatible combinations (e.g. effort is hidden on Haiku 4.5 because Anthropic's API doesn't accept it there).

### Worktree isolation

When `isolation: "worktree"` (the default), starting a task in a git repo:

1. Resolves the base ref to a sha (pinned on the row — re-runs reproduce).
2. Creates `~/.agetor/worktrees/<task-id>/` on a fresh branch off that sha.
3. Spawns the agent with that path as `cwd`.

Worktree teardown happens automatically on task delete: `git worktree remove --force` plus `git branch -D`, with an `rm -rf` fallback for the case where the user moved `workdir` out from under us.

Set isolation to `"none"` to run directly in `workdir` — useful for one-off scripts where a worktree would be overhead.

### Approvals and clarifying questions

When Claude is about to use a tool, the Agetor-installed `PreToolUse` hook posts the tool name and input to `127.0.0.1:<port>/approvals`. The run panel renders a card; the user clicks **Allow**, **Allow always**, or **Deny**. "Allow always" persists a `(task, tool)` rule in SQLite so future fires are auto-allowed without bothering you.

When Claude wants to ask a structured question, it calls the `ask_user` tool on Agetor's MCP server. The webview renders radios / checkboxes / textarea, and the MCP server's response unblocks the agent.

`AskUserQuestion` and `ExitPlanMode` from Claude's built-in tools are intercepted the same way.

---

## HTTP API

The main process exposes a small JSON + SSE API on `127.0.0.1:$AGETOR_API_PORT`. All routes except `/health` require `Authorization: Bearer $AGETOR_API_TOKEN` (or `?token=...` for `EventSource`).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness probe. |
| `GET` | `/info` | App version + boot info. |
| `GET` | `/defaults` | Home dir and other defaults the UI needs to expand `~`. |
| `GET` / `POST` | `/tasks` | List or create tasks. |
| `GET` / `PATCH` / `DELETE` | `/tasks/:id` | Inspect, edit allow-listed fields, or delete a task. |
| `POST` | `/tasks/:id/start` | Start a run for the task. |
| `GET` | `/tasks/:id/runs` | Run history for the task (newest first). |
| `GET` | `/tasks/:id/events` | SSE: unified event stream across all runs for the task. |
| `POST` | `/runs/:id/cancel` | Send Ctrl-C to the in-progress run; tmux session survives. |
| `POST` | `/runs/:id/input` | Send a follow-up user message (Claude only). |
| `GET` | `/runs/:id/events` | SSE: events for a single run (replays history, then streams live). |
| `GET` / `POST` / `DELETE` | `/harnesses[...]` | Manage harness configs. |
| `GET` | `/agents` | Per-harness availability + version probes. |
| `GET` | `/agent-models` | Models discovered by probing each CLI. |
| `GET` | `/agent-commands` | Slash commands supported by the active agent. |
| `POST` | `/approvals/:id/answer` | Resolve a pending tool approval. |
| `POST` | `/questions/:id/answer` | Resolve a pending `ask_user` question. |
| `POST` | `/ask-questions/:id/answer` | Resolve an intercepted `AskUserQuestion`. |
| `POST` | `/plan-approvals/:id/answer` | Resolve an intercepted `ExitPlanMode`. |
| `GET` | `/tasks/:id/interactions/pending` | Anything currently blocking the task. |
| `GET` / `POST` / `DELETE` | `/projects[...]` | Working-directory shortcuts shown in the New Task form. |
| `GET` / `PATCH` | `/preferences[...]` | Per-user preferences (key/value). |
| `POST` | `/open-path` | Reveal a path in Finder / Files. |
| `GET` | `/events` | SSE: global lifecycle stream (toasts, native notifications). |

The full route list is in [`src/bun/server.ts`](./src/bun/server.ts).

---

## Commands

```bash
bun install                                # install deps
bun run dev                                # Electrobun, loads packaged webview
bun run dev:hmr                            # Vite + Electrobun in parallel (preferred for UI work)
bun run build                              # production bundle (vite build → electrobun build)
bun run build:canary                       # canary channel build
bun run build:stable                       # stable channel build
bun run typecheck                          # tsc --noEmit; must be green
bun test                                   # full test suite (Bun's test runner)
bun test src/bun/orchestrator.test.ts      # single file
bun test -t "createTask"                   # by test name
```

---

## Project layout

```
src/
├── bun/                       # main process: API, orchestration, persistence
│   ├── index.ts               # entrypoint: menus, reconcile orphans, start server, open window
│   ├── server.ts              # Bun.serve routes (HTTP + SSE)
│   ├── orchestrator.ts        # task lifecycle, spawn/cancel/cleanup, event fanout
│   ├── agents.ts              # buildCommand / spawnAgent — single source of truth per agent
│   ├── claude-tmux.ts         # tmux session lifecycle + JSONL tailer
│   ├── agent-status.ts        # availability + version probes per harness
│   ├── agent-discovery.ts     # async model-list discovery
│   ├── worktree.ts            # git worktree create/remove
│   ├── interactions.ts        # approvals + questions registry (in-memory)
│   ├── hook-installer.ts      # writes PreToolUse hook + MCP launcher per task
│   ├── hooks/                 # bundled hook script + system prompt
│   ├── mcp/agetor-mcp.ts      # stdio MCP server exposing `ask_user`
│   ├── commands.ts            # slash-command catalogue per agent
│   ├── db.ts                  # bun:sqlite + bindings
│   ├── migrate.ts             # numbered SQL migration runner
│   └── migrations/            # 001_init.sql … 013_harnesses.sql
├── mainview/                  # React webview (kanban, run panel, settings)
│   ├── App.tsx
│   ├── components/
│   │   ├── kanban/            # board, columns, cards, run panel, pickers
│   │   ├── settings/
│   │   └── ui/                # shadcn-style primitives (hand-rolled)
│   └── lib/api.ts             # typed wrapper around the Bun HTTP API
└── shared/                    # types both processes import (no runtime side effects)
    └── types.ts               # Task, Run, Harness, AGENT_OPTIONS, etc.
```

---

## Security model

- The API binds to `127.0.0.1` only and is gated on a per-launch random token. Even if `Access-Control-Allow-Origin` were misconfigured, a foreign origin can't read the token.
- The token is delivered to the webview via a `WKUserScript` preload (not a query string or hash, so it never appears in the URL bar or logs).
- Agents run **with your full shell privileges** in whatever `workdir` the task names. Agetor does not sandbox them. Treat it like running the agent CLI directly — because that's exactly what it's doing.
- Approval rules are scoped to a single task, never globally. Each new task starts fresh.

If you find a security issue, please disclose it privately to `alamo@alamoweb.com.br` rather than filing a public issue.

---

## Contributing

Issues and pull requests are welcome — including AI-assisted and fully vibecoded ones. If Claude, Codex, Cursor, or any other agent wrote most of the diff, that's fine. Just hold it to the same bar as a hand-written PR: tests green, types clean, and a description that makes the *why* obvious. (Agetor itself is built to make this kind of contribution easier — eat your own dog food.)

A few conventions worth knowing before opening a PR:

- **`bun run typecheck` must be green.** TypeScript is strict (`noUncheckedIndexedAccess` is on).
- **Tests are required for behavioural changes.** The orchestrator and Claude-tmux modules have particularly thorough coverage; mirror that style. Tests must set `AGETOR_DATA_DIR` at the top of the file (not in `beforeAll`) to avoid the production-db-pollution trap documented in `src/bun/db.ts`.
- **Never edit an already-applied migration.** Add a new numbered `.sql` file and append it to `src/bun/migrations/index.ts`. The migration runner only tracks ids, so silent edits will diverge from existing user databases.
- **Shared types are runtime-free.** `src/shared/types.ts` is imported by both processes — no Node, Bun, React, or DOM imports there.
- **Agent options live in `AGENT_OPTIONS`.** To add a model or mode, extend the curated list and teach `buildCommand` how to translate it. Unknown ids are passed through verbatim so users can paste a fresh release before Agetor knows about it.

Adding a new agent kind:

1. Extend the `AgentKind` union in `src/shared/types.ts`.
2. Add an entry to `AGENT_OPTIONS` with models / modes / effort.
3. Add a branch in `buildCommand` (`src/bun/agents.ts`) and `spawnAgent`.
4. Surface availability hints in `agent-status.ts`.
5. The orchestrator and UI pick it up automatically.

The architecture and the gotchas worth knowing are documented in [`CLAUDE.md`](./CLAUDE.md). Reading that file before your first PR is the highest-leverage thing you can do.

---

## Roadmap

This is an early-stage project. Things on the near-term list:

- An uninstall flow that strips the `PreToolUse` hook and MCP-server entries from `.claude/settings.local.json` across every repo Agetor touched.
- First-class Linux and Windows builds (currently configured but untested).
- More agent kinds: Cursor agents, Aider, Gemini CLI.
- Optional Slack / native push notifications on terminal state, not just toasts.

---

## License

[MIT](./LICENSE) © 2026 Alamo Saravali

---

## Acknowledgements

- [Electrobun](https://github.com/blackboardsh/electrobun) — the native-webview-on-Bun runtime this app is built on.
- [Claude Code](https://github.com/anthropics/claude-code) and [OpenAI Codex CLI](https://github.com/openai/codex) — the agents Agetor was built to orchestrate.
- [dnd-kit](https://dndkit.com/), [shadcn/ui](https://ui.shadcn.com/), [Tailwind CSS](https://tailwindcss.com/), [Lucide](https://lucide.dev/), [Sonner](https://sonner.emilkowal.ski/) — the front-end stack.
