# Plan — Kimi follow-ups: wire.jsonl thinking parity + exit-75 auto-retry (+ migration renumber check)

| Field | Value |
| --- | --- |
| Date | 2026-07-17 |
| Source | /implement (deferred items from docs/plans/kimi-code-cli-harness.md §8) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Mode | **Autonomous** — no ask_user tool; gates self-approved; assumptions in §8 |
| Branch | feature/kimi-code-cli-acp-support |
| Base SHA | 3f19c6b (clean tree) |

## 1. Objective & success criteria

**A — Auto-retry on exit 75.** A kimi turn that exits with Moonshot's documented *retryable* code (rate limit / 5xx / timeout) is automatically re-spawned with backoff instead of dumping the task back to `ready`. Capped attempts; Stop/delete/archive/agent-switch always win over a pending retry.

**B — Thinking parity.** Kimi's reasoning (absent from stdout stream-json by design) is surfaced as `thinking` chunks in the run panel by tailing the session's `wire.jsonl`, best-effort behind a kill switch (`AGETOR_KIMI_TRACK_THINKING=0`).

**C — Migration renumber check.** RESOLVED during investigation: cursor/grok are **not** merged to origin/main (verified 2026-07-17; main is at d6954f6 with no kind commits). 028/029 stand; no code change. The merge-time note in the previous plan remains the guard.

Done = typecheck green, full suite green, both features covered by fake-driver/pure-mapper tests, review verdict addressed.

## 2. Context & constraints (file:line anchors from investigation)

- Exit-75 today: `kimi-tmux.ts:349-386` death-watch reads the sidecar via `readKimiExitCode` (`:96-105`), emits a plain `"kimi exited with code 75 (retryable)"` status string, and `resolveKimiDone` resolves `done` with the bare code. `attachDoneHandler` (`orchestrator.ts:926-1004`) only branches on `code === 0` / `apiError` / `sessionDied` / `cancelled` → 75 lands the task in `ready` as a generic failure. The exit code never crosses the boundary as structured data.
- Proven signal pattern: `SESSION_DIED_STATUS_PREFIX` — emit in driver, match in `makeChunkHandler` (`orchestrator.ts:891-900`), flag on `ActiveRun` (`:97-121`, fields `apiError`/`sessionDied`), read in `attachDoneHandler` **before** `active.delete`. `cancelled` is set by `cancelRun` (`:1209-1211`) before kill — a retry must honor it.
- No retry/backoff precedent exists anywhere in the codebase; timer disposal precedent is `disposeKimiState` (`kimi-tmux.ts:612-619`) + the three sites that clear `kimiTurnQueue` (`orchestrator.ts:1064-1065` agent-switch, `:2058-2059` archive, `:2135-2136` delete). Fleet knowledge `cecadcaf`: a chunk/spawn firing after deleteTask hits `runs.appendEvent` FK errors — retry timers must be cleared at all teardown sites.
- Fake driver: `makeFakeAgent` (`agents.ts:608-658`) always resolves `done(0)`; needs an env hook to resolve with an arbitrary code for tests. The `AGETOR_FAKE_CLAUDE_*` hooks are kind-agnostic.
- Primary tailer skeleton to mirror: `flushKimiLog` (`kimi-tmux.ts:284-320`), POLL_MS 150 + opportunistic fs.watch. `KimiSessionState` does NOT retain `sessionId` or `cwd` (`:239-263`) — both must be added and threaded through `KimiLaunchOptions`/`KimiReattachOptions` (reconcile arm at `orchestrator.ts:530-536`).
- Dedup: unique index is `(run_id, IFNULL(subagent_id,''), line_uuid)` (migration 022). Keys `kimiwire:<lineNo>` with NULL subagent_id share the primary namespace safely and are auto-included in `seenLineUuidsForTask` on reattach — zero DB changes.
- `thinking` is a first-class `RunEventStream`; RunPanel renders it kind-agnostically (`RunPanel.tsx:2202-2203`). No whitelist anywhere.
- wire.jsonl ground truth (source-verified from both repos; see fleet entry "Kimi Code CLI contract" + this plan's research):
  - **Leaf shape identical in both products:** `{"type":"think","think":"<text>","encrypted":null|string}` (field names verified in Python kosong `message.py` and TS `llmProtocol/message.ts`). Thinking is **coalesced chunks**, not per-token deltas.
  - **kimi-cli layout:** `<share-dir>/sessions/<md5(canonical-cwd)>/<sessionId>/wire.jsonl`; line = `{"timestamp":…,"message":{"type":"ContentPart","payload":{…leaf…}}}`; header line `{"type":"metadata","protocol_version":"1.10"}`. Subagent events mirrored into parent as `message.type=="SubagentEvent"` with nested envelope. `--print` writes wire.jsonl unconditionally (source-verified).
  - **kimi-code layout:** `$KIMI_CODE_HOME/sessions/wd_<slug>_<sha256:12>/<sessionId>/agents/main/wire.jsonl`; line = `{"type":"context.append_loop_event","time":…,"event":{"type":"content.part",…,"part":{…leaf…}}}`; same metadata header shape. Print-mode persistence architecturally certain but not source-traced past an RPC boundary.
  - **Tailer gotchas:** file may be **rewritten/truncated** (healing rewrites, session fork) — must detect size-shrink and reset offset to 0; tolerate truncated trailing line; file appears lazily on first event (poll-wait, don't error); both products may own the `kimi` binary name → **discover** the session dir by probing for a dir literally named `<sessionId>` (our own uuid) under both roots rather than reimplementing either hash.

## 3. Approach & key decisions

**A (retry):** the sentinel pattern, third use. New `KIMI_RETRYABLE_STATUS_PREFIX` in `shared/types.ts`; driver's exit-75 branch emits `${PREFIX}kimi exited with code 75` (no other driver change). `makeChunkHandler` matches prefix → sets new `ActiveRun.retryable = true`. `attachDoneHandler` resolve path: when `retryable && !wasCancelled && !wasApiError && !wasSessionDied && code !== 0`:
- record the attempt's run row as `failed` (truthful, exitCode kept),
- consult `kimiRetryState: Map<taskId, { count: number; timer: ReturnType<typeof setTimeout> | null }>` (lives beside `kimiTurnQueue`),
- if `count < KIMI_RETRY_MAX` (2): **skip the column flip** (task stays `running`), append a status event `"retrying after exit 75 (attempt N/2, in Xs)"`, and `setTimeout` a re-spawn of the **same prompt** (read from the failed run's row; verify the run row stores the prompt — if not, carry it in the retry state) via the `spawnKimiTurnNow` path with `resumeSessionId = findLastKimiSessionId(taskId)`. Backoff: `KIMI_RETRY_DELAYS_MS = [5000, 15000]`, overridable via `AGETOR_KIMI_RETRY_DELAY_MS` (tests).
- if exhausted: normal failure flow (task → `ready`), reset state.
- Reset `count` on any successful kimi run. Guard at fire time: task still exists, still kimi, not archived, no active run, retry state not cleared. Clear `{timer, count}` at ALL FOUR teardown sites that touch `kimiTurnQueue` (agent-switch, archive, delete, and `cancelRun`/Stop — Stop must also clear a *pending* timer, not just set `cancelled`). User follow-ups queued in `kimiTurnQueue` during the backoff window: the retry re-spawn happens first (it re-establishes the turn); the queue drains after it settles, preserving FIFO.
- Fake seam: `makeFakeAgent` gains `AGETOR_FAKE_KIMI_EXIT_CODE=<n>` — when set, emits the retryable sentinel iff n==75, then `resolveDone(n)`.

**B (wire tailer):** second tailer inside `kimi-tmux.ts` (no new module), started from the same spawn/reattach sites, disposed by `disposeKimiState`.
- `KimiSessionState` gains `sessionId`, `cwd`, and wire-tailer fields (`wirePath | null`, `wireOffset`, `wirePartial`, `wireLineNo`, `wireDecoder`, `wireDiscoveryDeadline`); `KimiReattachOptions` gains `sessionId`, `cwd` (orchestrator threads `row.kimi_session_id` + the task's `worktreePath ?? workdir`).
- **Discovery, not derivation:** poll (same 150ms tick or a slower 1s tick) for the first existing candidate: `<home>/.kimi/sessions/*/<sessionId>/wire.jsonl` and `$KIMI_CODE_HOME (or <home>/.kimi-code)/sessions/*/<sessionId>/agents/main/wire.jsonl`, where `<home>` honors the harness home override (state.cwd irrelevant to roots; use the spawn env's HOME/KIMI_CODE_HOME — thread the resolved values into the state at spawn; on reattach recompute from the harness row the same way `harnessEnv` does). Give up silently after 60s (thinking just doesn't render — best-effort).
- Pure parser `mapKimiWireEvent(line, onChunk, lineNo)`: skip `type:"metadata"` (but if `protocol_version` major ≠ "1", disable the tailer for this run and emit one debug status); extract the think leaf from exactly two envelope shapes — `message.payload` where `payload.type==="think"` (kimi-cli) and `event.part` where `part.type==="think"` (kimi-code); emit `onChunk("thinking", text, "kimiwire:"+lineNo)`. **Skip** `SubagentEvent`-wrapped and `agents/<other>/` subagent thinking in v1 (avoids interleaving confusion; noted §8). Skip `encrypted`-only parts with no plaintext.
- Truncation guard in the wire flush: if `stat.size < wireOffset` → reset offset/partial/lineNo to 0 (dedupe keys make the replay idempotent for identical content; diverged content after a rewrite is accepted best-effort).
- Kill switch `AGETOR_KIMI_TRACK_THINKING=0` checked once at tailer start (grok's `AGETOR_GROK_TRACK_SUBAGENTS` precedent). Default ON.

## 4. Work breakdown — implementation tasks

**T1 (wave 1) — driver + types.** Files: `src/bun/kimi-tmux.ts`, `src/shared/types.ts`. Add `KIMI_RETRYABLE_STATUS_PREFIX` (types.ts, beside SESSION_DIED_STATUS_PREFIX); change the exit-75 status emission to use it; implement the whole of §3-B in kimi-tmux.ts (state fields, discovery, `mapKimiWireEvent` exported for tests, wire flush with truncation guard, kill switch, disposal). Acceptance: typecheck green; existing kimi-tmux tests still pass; wire tailer is inert when no wire.jsonl appears.

**T2 (wave 2) — fake seam.** File: `src/bun/agents.ts` only. `AGETOR_FAKE_KIMI_EXIT_CODE` branch in `makeFakeAgent` per §3-A. Acceptance: existing agents tests green; hook emits sentinel for 75 and resolves with the code.

**T3 (wave 2) — orchestrator retry + reattach threading.** File: `src/bun/orchestrator.ts` only. `ActiveRun.retryable`; `makeChunkHandler` prefix match; `attachDoneHandler` retry branch per §3-A; `kimiRetryState` map + clearing at cancelRun/agent-switch/archive/delete; thread `sessionId`+`cwd` into the `reattachKimiSession` call (reconcile arm). Acceptance: typecheck green; retry never fires after Stop/delete; codex/claude paths untouched.

## 5. Work breakdown — test tasks

**T4 (extend `src/bun/kimi-tmux.test.ts`; owns that file only):** `mapKimiWireEvent` — kimi-cli envelope think → thinking chunk `kimiwire:<n>`; kimi-code envelope think; metadata line skipped; protocol_version 2.x → disabled; text/tool parts ignored; SubagentEvent skipped; encrypted-only skipped; malformed line silent (wire is best-effort — no stderr noise); replay idempotency of keys.

**T5 (extend `src/bun/orchestrator-kimi.test.ts`; owns that file only):** with `AGETOR_FAKE_KIMI_EXIT_CODE=75` + `AGETOR_KIMI_RETRY_DELAY_MS=10`: run fails retryable → task stays `running` → retry run spawns and (after clearing the env) succeeds → task `review`, two run rows (failed 75 + succeeded), status event mentions retry; cap exhaustion (leave 75 set) → exactly 1+2 runs then `ready`; Stop during backoff → no retry fires, run `cancelled`... (Stop applies to active run; for pending-timer case assert timer cleared → task stays wherever Stop leaves it and no new run appears); deleteTask during backoff → no spawn, no FK error; non-75 exit code → no retry.

## 6. Execution waves

Wave 1: T1 alone (T2/T3 import its constant/option fields). Wave 2: T2 ∥ T3 (agents.ts / orchestrator.ts — disjoint). Then review (opus) → T4 ∥ T5 (disjoint files) → full suite (haiku) → fix loop ≤3.

## 7. Blast radius & risks

- Retry branch is inside the shared `attachDoneHandler` — guard strictly on the `retryable` flag (only kimi's driver ever emits the prefix) so claude/codex resolution is byte-identical.
- Pending-timer leaks: cleared at four teardown sites; fire-time re-validation is the backstop (fleet entry `cecadcaf`'s post-delete FK race).
- Wire tailer is read-only/best-effort: worst case it emits nothing (discovery timeout) or stops (protocol bump). It shares the session's onChunk sink, so post-delete emission is prevented by disposal in `disposeKimiState` (same lifecycle as the primary tailer).
- Run-row prompt availability for retry re-spawn: investigation didn't confirm `runs` stores the prompt — T3 must verify and fall back to carrying the prompt in `kimiRetryState` if not.

## 8. Open questions / assumptions (autonomous)

1. Retry policy: max 2 retries, delays 5s/15s, no jitter; only exit 75 triggers (not generic non-zero). Attempt rows recorded `failed` (truthful history), task held in `running` during backoff.
2. Wire thinking ships default-ON behind `AGETOR_KIMI_TRACK_THINKING=0` kill switch, consistent with the harness itself being disabled-by-default + Experimental.
3. Subagent thinking (SubagentEvent / `agents/<id>/wire.jsonl`) excluded in v1.
4. kimi-code print-mode wire persistence is architecturally-certain-but-unverified; discovery timeout degrades gracefully. Live-binary smoke test still owed for the harness overall (previous plan §8.7) — now also covers wire.jsonl.
5. Migration renumber (item C): verified unnecessary today; standing note in the previous plan covers the merge-order contingency.
