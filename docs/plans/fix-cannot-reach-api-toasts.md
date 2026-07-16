# Plan — Fix "cannot reach agetor API" toasts

| Field | Value |
| --- | --- |
| Date | 2026-07-14 |
| Source | /implement — recurring toast `cannot reach agetor API at http://127.0.0.1:4317 (…) — is the bun process running?` on archive/start/etc., increasing in frequency |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/cannot-reach-api |
| Base SHA | 3f4b057e826383869fff20bf118f7c33b0072d0f |
| Mode | **Autonomous** — grill (Phase 2) and plan approval (Phase 3) gates bypassed; all assumptions logged in §8 |

## 1. Objective & success criteria

Stop the false "cannot reach API" toasts that fire while the Bun process is alive and healthy. Success:
- Archiving a task whose worktree takes >10s to remove completes without a toast.
- Starting a task (worktree materialization) completes without a toast.
- A mutation issued after minutes of user inactivity (stale pooled keep-alive socket) succeeds transparently.
- A genuinely dead server still produces the toast (no false "everything is fine").
- `bun run typecheck` green; full `bun test` green.

## 2. Context & constraints (grounded findings)

**Primary root cause — Bun's default 10s `idleTimeout` on `Bun.serve`:**
- `src/bun/server.ts:443-449` — `Bun.serve({ port, hostname: "127.0.0.1", development: false, websocket, routes, fetch })`. No `idleTimeout`, no `server.timeout()` anywhere in the repo. Bun 1.3.10 default is **10s**, max **255**, `0` disables (confirmed: bun.com/docs/runtime/http/server, oven-sh/bun#13712).
- The idle timer is a single per-connection inactivity timer. It fires **(a)** on idle pooled keep-alive sockets between requests, and **(b)** mid-request while a handler is still awaiting and hasn't written a byte — async or sync makes no difference (oven-sh/bun#13712, closed as intended).
- WKWebView/CFNetwork **never auto-retries POSTs** on a dropped reused connection; only idempotent GET/PUT are retried (Apple Technical Q&A QA1941). A dropped socket surfaces as WebKit's bare `"Load failed"`.
- `src/mainview/lib/api.ts:263-293` — `j()` maps **every** fetch rejection with message `"Load failed"` to the toast text. No retry, no timeout, no classification. Background polls swallow errors (`App.tsx:120-133`, `RunPanel.tsx:359-397`); only user mutations surface it (`App.tsx:424-517`) — exactly matching the report (archive, start).

So the two reported cases are directly explained:
- **Archive** → `POST /tasks/:id/archive` (`server.ts:3105-3107`) awaits `archiveTask` → `detachWorktree` (`orchestrator.ts:1806`) → `git worktree remove/prune` + `rmSync` of the whole worktree (`worktree.ts:819`). >10s of no response bytes → Bun kills the connection → "Load failed" → toast.
- **Start** → `POST /tasks/:id/start` (`server.ts:3096`) awaits worktree materialization (`git worktree add` on the user's repo) — same >10s window on big repos.
- **Any mutation after idle** → pooled socket idled >10s, server closed it, WKWebView reuses it for a POST, no auto-retry → toast. Explains sporadic failures on quick actions too.

**Amplifiers (why "more and more recently"):**
- SSE keepalive pings are every **15s** (`server.ts:3789,3829,3916,4052`) — longer than the 10s idle window, so quiet SSE streams are killed and silently reconnect constantly (EventSource auto-reconnects; adds churn, no toast).
- `rmSync` (`worktree.ts:771,819`) blocks the whole single-threaded Bun process during archive/delete.
- Usage growth: `c0878ae` (Jul 7) added a 400ms-per-running-task `spawnSync` death-watch; `ee151a8` (Jul 12) added the GitHub dialog's heavy fetch fan-out. More concurrency → more pooled connections going stale, more event-loop jitter.
- The toast text has existed unchanged since the initial commit (`3492804`); the *frequency* changed with usage, not the code path.

**Constraints:** Electrobun (not Electron); `Bun.serve` object-style `routes`; `/health` is unauthenticated + CORS-allowed (`server.ts:457`) — usable as a client-side liveness probe. Route handlers close over the outer `const server`, so `server.timeout(req, 0)` is callable inside handlers (pattern verified by a prior fleet finding on Bun 1.3.10).

## 3. Approach & key decisions

1. **Server: set `idleTimeout: 255` (max) on `Bun.serve`** — one line, removes the 10s trap for pooled sockets and for handlers up to ~4 min. Chose 255 over `0` (disable): keeps a safety reaper for genuinely dead sockets while being far above WKWebView's own pool-idle horizon, and far above the 15s SSE ping cadence so streams stay alive.
2. **Server: `server.timeout(req, 0)` on the four long-op handlers** — `/tasks/:id/start`, `/tasks/:id/archive`, `/tasks/:id/unarchive`, `DELETE /tasks/:id` — worktree add/remove on a huge repo could plausibly exceed even 255s. Mirrors the per-request pattern already proven in this codebase family.
3. **Client: health-gated single retry in `j()`** — on any fetch *rejection* (network layer, incl. "Load failed"): probe `GET /health` with a short abort (1.5s). If the server answers → the failure was a transient socket race; retry the original request **once** (bodies are JSON strings, safely re-sendable). If the probe fails or the retry fails → surface a toast that now distinguishes "server not responding" from "request failed twice despite a healthy server". Logic extracted into a pure, dependency-injected helper (`src/mainview/lib/net-retry.ts`) so it's unit-testable under `bun test`.
4. **Server: `rmSync` → async `rm`** in `removeWorktree` + `detachWorktree` (`worktree.ts:771,819`) — stops multi-second event-loop stalls on archive/delete from starving every other connection.
5. **Out of scope (recommended follow-up, logged, not done here):** converting `claude-tmux.ts`/`codex-tmux.ts` timer-driven `Bun.spawnSync` tmux calls to async. Those stalls are milliseconds each and cannot by themselves trip a 10s/255s idle timer; the conversion touches delicate death-watch/scraper logic and deserves its own branch.

Alternatives considered: `idleTimeout: 0` (rejected — loses dead-socket reaping for no extra benefit); `Connection: close` per response (not supported on `Bun.serve`); blind POST retry without health probe (rejected — Apple explicitly warns; health gate + single-shot keeps duplicate risk negligible since a stale-socket failure means the request never reached the server).

## 4. Work breakdown — implementation tasks

| ID | Goal | Owns (exclusive) | Deps | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | `idleTimeout: 255` on `Bun.serve` + `server.timeout(req, 0)` in start/archive/unarchive/delete handlers, with comments explaining the 10s default trap | `src/bun/server.ts` | — | typecheck green; options + 4 handlers updated |
| T2 | Health-gated single-retry fetch layer; clearer failure messages | `src/mainview/lib/api.ts`, `src/mainview/lib/net-retry.ts` (new) | — | `j()` delegates to injected helper; behavior per §3.3 |
| T3 | Async worktree removal | `src/bun/worktree.ts` | — | `rmSync` gone from both call sites; awaited `rm` from `node:fs/promises`; comments/semantics preserved |

## 5. Work breakdown — test tasks

| ID | Goal | Owns | Covers |
| --- | --- | --- | --- |
| TT1 | Integration test: keep-alive socket reused after >10s idle succeeds; boots real server per `server-auth.test.ts` conventions (temp `AGETOR_DATA_DIR`) | `src/bun/server-keepalive.test.ts` (new) | T1 |
| TT2 | Unit tests for retry helper with fake fetch: transient error + healthy → retried once & succeeds; server down → "cannot reach" error; retry fails → error; HTTP 4xx/5xx → no retry | `src/mainview/lib/net-retry.test.ts` (new) | T2 |

T3 is covered by the existing `worktree.test.ts` suite (removal semantics unchanged, only sync→async).

## 6. Execution waves

- **Wave 1 (parallel):** T1, T2, T3 — fully file-disjoint. Barrier: typecheck + commit.
- **Wave 2 (parallel):** TT1, TT2 — file-disjoint, depend on Wave 1. Barrier: commit.
- Then: code review (opus), full `bun test` + `bun run typecheck`, fixes if needed.

## 7. Blast radius & risks

- `idleTimeout: 255` is global: a truly dead connection lingers up to 255s instead of 10s — harmless on loopback.
- `server.timeout(req, 0)`: only the four named handlers; a hung git op would hold that one connection open indefinitely — the handlers already have their own git timeouts (`worktree.ts` `git()` helper).
- Client retry: residual duplicate-mutation risk if a request reached the server *and* the connection died before any response byte *and* the health probe then succeeded. Single retry only; considered acceptable for a local single-user app (worst realistic case: a duplicated backlog draft or a re-sent agent message).
- Async `rm`: `deleteTask`/`archiveTask` already `await` these functions; no caller change needed. Best-effort semantics preserved.
- Tests: `bun`/`tmux` are not on non-interactive-shell PATH — export `/opt/homebrew/bin` + `~/.bun/bin` (known fleet gotcha). New tests must set `AGETOR_DATA_DIR` to a mkdtemp dir before importing db/orchestrator modules.

## 8. Open questions / assumptions (autonomous mode)

1. **Assumed** single retry of mutations gated on a successful `/health` probe is acceptable duplicate-risk for a local app (owner unavailable to confirm). The health-gate + the fact that stale-socket failures occur before request delivery make duplicates very unlikely.
2. **Assumed** 255s is an acceptable ceiling for pooled-socket lifetime; chose it over `0` to keep dead-socket reaping.
3. **Assumed** the tmux `spawnSync` conversion is out of scope for this fix branch (follow-up recommended).
4. **Not verified live** (no running instance to trace): that a specific failing request coincides with a stale pooled socket — but the mechanism is confirmed by Bun docs + Apple QA1941, and the archive/start >10s-handler path is deterministic.
