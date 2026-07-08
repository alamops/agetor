# Plan — Move task to `blocked` when a running tmux session dies mid-run

| Field | Value |
| --- | --- |
| Date | 2026-07-07 |
| Source | `/implement` — "If a task is running then the tmux session suddenly ends (claude-code, codex), move the ticket to blocked and inform the user in the stream. Currently a blind spot." |
| Config | none loaded — running `self` for planning; investigation done inline (Explore agents) |
| Branch | `agetor/4fb4f36bb962-move-task-to-blocked-if-tmux-session-end` (already on it) |
| Base SHA | `833529b837989cf11a8ff141049d14fdd3b3835f` |
| Status | ✅ Implemented + reviewed + tests green (702 pass / 0 fail, typecheck clean) as of 2026-07-07 |

## 1. Objective & success criteria

When a task is **running** and its per-task tmux session dies unexpectedly (crash, `tmux kill-server`, machine wakes with the server gone, an errant `kill`), agetor must, **live** (not only at the next boot):

1. Resolve the in-flight run and move the task card to the **`blocked`** column.
2. Emit a visible status line into the run/stream event list, e.g. `session ended: tmux session agetor-xxxx ended unexpectedly — task blocked`, so the user understands *why* the card stopped.
3. Record the run row honestly and fire a toast that reads as "the session died", not "waiting on you".

Applies to **both** claude-code and codex.

**Done =** killing a live run's tmux session (verified via a fake-driver test and a manual repro) flips the card to `blocked` within ~1s, drops a `session ended: …` line in the stream, and the run row settles terminal — with the full suite + typecheck green.

## 2. Context & constraints (grounded findings, file:line)

- **`"blocked"` column already exists** — `ColumnId = "backlog" | "ready" | "running" | "blocked" | "review" | "done"` (`src/shared/types.ts:1`). No migration needed (column is free-text, no CHECK constraint). It is already used for the claude **API-error** case, which is the exact pattern to mirror.
- **The API-error → blocked path is the template** (`src/bun/orchestrator.ts:551-569`): claude-tmux emits a sentinel `status` chunk prefixed `CLAUDE_API_ERROR_STATUS_PREFIX` (`claude-tmux.ts:349,632`); `makeChunkHandler` pattern-matches it, sets `handle.apiError=true`, and calls `updateColumn(taskId, runId, "blocked", "api-error")`; `attachDoneHandler` (`orchestrator.ts:594-672`) reads the flag and keeps the card in `blocked` with run status `failed` instead of bouncing to `ready`.
- **`updateColumn` only emits when the column actually changes** (`orchestrator.ts:159`) — so a second `updateColumn(…, "blocked")` from `attachDoneHandler` after `makeChunkHandler` already flipped it is a safe no-op (no duplicate event). `reason` union is currently `"api-error" | "approval"` (`src/shared/types.ts:775`).
- **claude has NO live death detection** — `attachTailer` (`claude-tmux.ts:2518`) installs an fs.watch + 400ms `pollTimer` that only reads JSONL; nothing checks `tmux has-session`. A dead session produces "no new data" forever, so the run sits in `running` until the next boot's `reconcileOrphans`. **This is the blind spot.**
- **codex ALREADY has the death-watch mechanism** — `startCodexTailer` (`codex-tmux.ts:359-370`) runs a `deathTimer` at `DEATH_POLL_MS=400` that polls `sessionExistsByName(state.sessionName)`, waits `DEATH_GRACE_MS=250` for final bytes, flushes, then `resolveCodexDone(state, lastCode ?? 1)` → currently lands the task in **`ready`/`failed`** with **no explanatory stream line**. So codex isn't a blind spot for *detection*, but it does the wrong thing (ready, silent) for this requirement.
- **Liveness helpers exist**: `sessionExists(taskId)` / `sessionExistsByName(name)` (`claude-tmux.ts:733,739`) — `tmux has-session`. Session-level chunk sink: `state.lastChunk` / `state.turnQueue[0]?.onChunk` (`claude-tmux.ts:1276,1305`).
- **No false positives on intentional kills**: cancel/Stop sends Ctrl+C but **keeps the session alive** (`has-session` still true → deathTimer won't fire). `deleteTask` → `dropSession` → `disposeSessionState` (clears timers) **before** `killTaskSession` (`claude-tmux.ts:3283-3320`), so the death poll is gone before the session dies. Boot reattach only reattaches sessions that are alive.
- **Boot-orphan is separate and unchanged**: `reconcileOrphans` (`orchestrator.ts:269-423`) marks boot-found running rows `orphaned` and returns the task to **`ready`** (a restart is routine/re-runnable). `reconcile.test.ts:64` pins this (`status === "orphaned"`). We are **not** touching it.
- **Fake-driver test seam**: `AGETOR_CLAUDE_DRIVER=fake` + `AGETOR_FAKE_CLAUDE_API_ERROR=1` (`agents.ts:442-479`) simulates the api-error sentinel + resolve for orchestrator tests (`orchestrator-blocked.test.ts`). We add a parallel `AGETOR_FAKE_CLAUDE_SESSION_DIED` knob.
- **UI**: `status` stream events already render in `RunPanel` (existing "turn complete"/"exit:0" lines), so the sentinel line shows with no webview change. Toast routing lives in `App.tsx:306-341`; `reason==="api-error"`→`toastApiError`, else→`toastPending` ("Waiting on you"); `run-status` `orphaned`→`toastError` with the copy **"agetor restarted while running"** (`App.tsx:316`) — which would be a lie for a live death, the one UI subtlety to handle.

## 3. Approach & key decisions

**Mirror the shipped API-error → blocked mechanism**, adding a single new "session died" sentinel that both drivers emit and the orchestrator recognizes — rather than inventing a new resolution channel. This reuses the proven flag-override + no-op-`updateColumn` machinery.

New sentinel prefix lives in `src/shared/types.ts` (both drivers + orchestrator reference one constant; it's cross-driver, unlike the claude-only api-error prefix): `export const SESSION_DIED_STATUS_PREFIX = "session ended: ";`

**Decision A — run row status for a live death: `failed`** (owner-confirmed 2026-07-07). Exactly mirrors the shipped api-error precedent and codex's current death code path; no `orphaned`-toast surgery. The `session ended: …` stream line is what distinguishes it from an ordinary non-zero exit in history.

**Decision B — boot-orphan stays `ready`** (owner-confirmed). Only the *live* "task is running when it dies" case goes to `blocked`; `reconcileOrphans` is untouched.

## 4. Work breakdown — implementation tasks

Small feature; **all edits are sequenced by me inline (no parallel wave needed)** — the files interlock (shared constant → drivers → orchestrator → UI) and are too few to partition without churn.

- **T1 — shared constant + reason union** (`src/shared/types.ts`)
  - Add `export const SESSION_DIED_STATUS_PREFIX = "session ended: ";`
  - Extend the column-event `reason` union to `"api-error" | "approval" | "session-died"` (`:775`).

- **T2 — claude live death detection** (`src/bun/claude-tmux.ts`)
  - Add `deathTimer` to `SessionState` (default `null` in the state factory ~`:1147`); clear it in `disposeSessionState` (~`:3301`).
  - In `attachTailer` install a death poll mirroring codex: `setInterval` @400ms; when `!sessionExistsByName(state.sessionName)`, clear the timer, then after a ~250ms grace `flushSync(state)` and call a new `signalSessionDeath(state)`.
  - `signalSessionDeath`: only act if a turn is **in flight** (head `turnQueue` slot has a live `resolve`, or reattach `onEndOfTurn` is set); emit `onChunk("status", SESSION_DIED_STATUS_PREFIX + "tmux session " + name + " ended unexpectedly — task blocked")` through the active slot/`lastChunk`, then settle the in-flight `done` (shift+`resolve(0)` for a slot, or fire `onEndOfTurn`) so `attachDoneHandler` runs; stop the tailer timers (watcher/poll/scraper) since the session is a corpse. If not in flight (session died while idle between turns) → just clear the timer and return (out of scope; a later re-run self-heals via `spawnClaudeViaTmux`'s pre-kill).
  - Define local `DEATH_POLL_MS`/`DEATH_GRACE_MS` (or import codex's constants — keep them per-file to avoid cross-module coupling).

- **T3 — codex: emit sentinel + route to blocked** (`src/bun/codex-tmux.ts`)
  - In the `deathTimer` grace callback (`:365-368`), after the final `flushCodexLog`, guard on `!state.resolved` (a terminal event in the final flush ⇒ not a death), then emit `state.onChunk("status", SESSION_DIED_STATUS_PREFIX + …)` **before** `resolveCodexDone(...)`. Leaves the resolve code as-is; the orchestrator flag drives the outcome.

- **T4 — orchestrator: recognize sentinel + honor flag** (`src/bun/orchestrator.ts`)
  - `makeChunkHandler`: add a branch parallel to the api-error one — `stream==="status" && data.startsWith(SESSION_DIED_STATUS_PREFIX)` ⇒ set `handle.sessionDied=true`, `updateColumn(taskId, runId, "blocked", "session-died")` (both agents, not gated on kind).
  - Add `sessionDied: boolean` to the active-handle type + `registerActiveRun` default `false`.
  - `attachDoneHandler.then`: extend the status + column mapping to honor `sessionDied` (status per Decision A; column `blocked`). Keep cancel > sessionDied > apiError precedence consistent with the existing cancel > apiError ordering.

- **T5 — UI toast accuracy** (`src/mainview/App.tsx`, `src/mainview/lib/toasts.ts`)
  - Route `column`+`blocked`+`reason==="session-died"` to a new `toastSessionEnded` (two-line addition per `toasts.ts:77` — `toast.error`, heading e.g. "Session ended").
  - If Decision A = `orphaned`: make the `run-status` `orphaned` toast copy conditional so a live death (card is `blocked`) doesn't say "agetor restarted while running".

- **T6 — fake-driver knob** (`src/bun/agents.ts`)
  - Add `AGETOR_FAKE_CLAUDE_SESSION_DIED` branch in `makeFakeAgent`, mirroring the api-error branch: emit the `SESSION_DIED_STATUS_PREFIX` sentinel then `resolveDone(0)`.

## 5. Work breakdown — test tasks

- **TT1 — orchestrator contract** (`src/bun/orchestrator-blocked.test.ts`, new cases): with `AGETOR_FAKE_CLAUDE_SESSION_DIED=1`, assert task column → `blocked`, run row status → (per Decision A), and a `column` global event carrying `reason:"session-died"`. Add a cancel-precedence case (cancel wins → `ready`), mirroring the existing api-error precedence test.
- **TT2 — claude driver death** (`src/bun/claude-tmux*.test.ts` or a new `claude-tmux-death.test.ts`): real-tmux integration — spawn a real session, attach the tailer with a fixture JSONL + an in-flight slot, `kill-session`, assert `done` resolves and a `SESSION_DIED_STATUS_PREFIX` chunk was emitted; and a negative case that an **idle** session death does not emit/settle. (codex's deathTimer is currently untested; this closes that gap for claude.)
- **TT3 — codex death emits sentinel** (`src/bun/codex-tmux.test.ts` or `orchestrator-codex.test.ts`): the death path now emits the sentinel and lands `blocked` (not `ready`).
- **Regression**: `reconcile.test.ts` (boot orphan → ready) must stay green — proves we didn't disturb the boot path.

## 6. Execution waves

Single implementer (me), sequential: **T1 → T2/T3/T4 → T5/T6 → tests (TT1–TT3) → run suite → fix**. No file-ownership collisions since it's one worker.

## 7. Blast radius & risks

- **False positive on intentional teardown** — mitigated: cancel keeps the session alive; delete disposes timers before kill; the in-flight guard means an idle session's death is ignored.
- **Grace-window race** (codex): guarding the sentinel on `!state.resolved` after the final flush prevents mislabeling a just-completed turn as a death.
- **Double toast**: `updateColumn` no-op-dedupe + the toast lifecycle's per-task dedupe (`toasts.ts:83-84`) keep this in line with the already-shipped api-error behavior.
- **Timer leak** on a dead-but-undeleted claude session — mitigated by stopping the tailer timers in `signalSessionDeath`.
- **Shared-socket safety** (per prior fleet knowledge): we only ever *observe* liveness (`has-session`) here and never enumerate-or-kill foreign sessions, so the reconcile-sweep hazard doesn't apply.

## 8. Open questions / assumptions

- **Q (Decision A):** live-death run badge = `orphaned` (recommended, precise) or `failed` (simplest, mirrors api-error)? — **default `orphaned`** unless owner prefers `failed`.
- **Assumption (Decision B):** boot-orphan behavior unchanged (stays `ready`); only the *live* case goes to `blocked`.
- **Assumption:** an **idle** claude session dying between turns (no run in flight) is out of scope — the card isn't "running", and the next re-run self-heals.
- **Assumption:** toast polish (accurate "Session ended" copy) is in scope since the request says "inform the user"; the load-bearing requirement (stream line + blocked card) does not depend on it.
