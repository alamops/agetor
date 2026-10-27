# Plan — pipeline handoff lost when a reminder races a background-task continuation

| Field | Value |
| --- | --- |
| Date | 2026-10-27 |
| Source | `docs/plans/handoff-identification-fix-investigation.md` (RC1–RC4, prod forensics) + `docs/plans/handoff-identification-fix-grill.md` (D1–D19, O1–O6) |
| Flags | none |
| Gates | grilled by owner (D1–D19); this plan resolves O2–O6 as design choices (§3, §8) |
| Branch | `fix/handoff-identification-fix` |
| Base SHA | `5b1d38c67cac0581d693dac2359756c7a05f4ef4` |

## 1. Objective & success criteria

A claude pipeline step whose background subagent finishes must advance on the `<handoff>` Claude writes in its continuation. Agetor must not paste a reminder into a busy session, must not split one Claude turn into two run rows, and must not drop a handoff because it landed on a run that is no longer `task.runId`.

Success criteria (all owner-approved):

1. **RC1.** When a held claude step is released and the task-notification line is already on disk, the continuation is adopted first and the release bails. No `review` flicker, and no settle of the pre-continuation run. When the line is not on disk yet (`checkDone`/`checkStale` releases), the runner waits up to 10 s for a continuation before reminding (D2, D3).
2. **RC2 + D12.** A claude follow-up decides fold vs. new turn on a fresh task read, after a synchronous JSONL drain, in one synchronous section with the run insert. Adopting a continuation never displaces an agetor-initiated turn that is being minted. Result: at most one in-flight run per task in every interleaving.
3. **RC3.** Each settle of a step looks back over every run of the step task in the current attempt window and advances on the newest settled run that has a valid handoff (D4, D10, D11). The orchestrator reports displaced-run settles to the runner only, so they never reach toasts, OS notifications, the TUI or `logs --notify` (D4). The step never advances while any run of the step task is live (D5).
4. **RC4.** The handoff reminder is sent only into an idle session, for every harness. The idle check happens in the same synchronous section as the send decision. A refused reminder records nothing and blocks nothing (D6).
5. **Breadcrumb.** The history row records which run supplied the handoff. When that run is not the one whose settle advanced the step, the history row shows a non-interactive chip, `agetor pipeline status` shows a dim `(handoff from run <short id>)` tag, and the supplying run gets a status line (D7–D9, O2).
6. **Tests.** One unit test per root cause, each shown failing on HEAD before the fix (D19). A new `e2e/pipelines-run.spec.ts` fake scenario covers an overlapping continuation and a second run, the chip, the status line, and the absence of a reminder.
7. `bun run typecheck` is green. `bun test` is green apart from the known pre-existing failures (tmux-socket ×2, one reconcile cancel test). The new e2e passes, and the existing `pipelines-run.spec.ts` scenarios still pass.

## 2. Context & constraints

Prod forensics settled the evidence (investigation §1–2): app v1.0.2, Claude Code 2.1.312. `git diff v1.0.2..HEAD` does not touch this logic, so the bug is live on HEAD. There are 11 overlaps and 10 lost handoffs since 2026-10-02.

**RC1: release vs. adoption.**
- The tailer adopts a continuation before it fires a settle: `maybeAdoptContinuation` at `src/bun/claude-tmux.ts:4527` runs before `fireBackgroundTaskSettled` at `:4554`.
- The subagent watcher scans the same JSONL independently (`claude-subagents.ts:3298`, ordinary-row settle `:3353`, `FAST_POLL_MS` 600 ms). It settles through `fireSettle`, which reaches the hook `maybeReleaseHeldTask` (`orchestrator.ts:365`, `:627-633`).
- `maybeReleaseHeldTask` releases whenever `runs.get(task.runId).status === "succeeded"` and nothing is running.
- For a held step, the runner's only settle is the `review` branch of `handleColumnChange` (`pipeline-runner.ts:2535-2559`), which settles `runs.listForTask(taskId)[0]`.
- `flushSync` (`claude-tmux.ts:4846-4872`) ends by firing a staged `pendingEndTurn` (`:4871`). That tail is wrong for a release-path drain.
- Async `flush` advances `state.offset` before its dispatch loop (`:4934-4947`). A sync read during its `await readAppended` makes it drop its batch (`:4927` guard). A sync read from inside its dispatch loop would dispatch later lines before earlier ones, so it needs a re-entry guard.
- `dispatchLine` → `fireBackgroundTaskSettled` → `handleBackgroundTaskNotification` → `fireSettle` → `maybeReleaseHeldTask` reaches the release synchronously from inside the tailer's own dispatch.

**RC2: stale snapshot across an await.**
- `sendClaudeTurn` (`orchestrator.ts:5659`) reads `task` and then awaits `sessionLiveness` (`:5678`). It passes that stale `task` to `sendTurnInExistingSession` (`:5713`), whose fold check `task.runId && active.has(task.runId)` (`:5729`) cannot see a continuation adopted during the await.
- `startContinuationRun` (`:6037-6088`) sets `task.runId` and registers the run in `active` synchronously, via `onAdopted` at `claude-tmux.ts:4408`.
- The idle branch inserts a run and overwrites `task.runId` (`:5786-5806`), then `await sendTurn` (`:5818`).
- **Reverse variant (D12).** `sendTurn` calls `flushSync` before pushing its slot (`claude-tmux.ts:8873`). That flush can adopt a continuation, through `startContinuationRun`, and overwrite the `task.runId` that was just minted. `sendTurnInExistingSession` claims `startingTaskIds` (`:5778`) before calling `sendTurn`, so the claim is held at that moment.

**RC3: only the current run is ever classified.**
- `attachDoneHandler` (`orchestrator.ts:2545`) moves the column and emits `run-status` only when `task.runId === runId` (`:2609`, `:2668-2670`; `.catch` twin at `:2699`, `:2714`).
- `settleStepRun` (`pipeline-runner.ts:2058-2449`) classifies only `assistantTextFrom(mainStreamEventsForRun(runId))` for the run that settled (`:2090`).
- PR #264's guards (`differentCurrentRunId`/`runningSuccessorSupersedes` `:363-385`, `deferReminderToSuccessor` `:1866-1889`, the stamp lock `:1937-1951`) find "the successor" only through `task.runId`.

**RC4: no idle-only send.** `deliverHandoffReminder` (`pipeline-runner.ts:1914`) calls `sendInput(p.runId, text)` (`:1927`). `sendInput` (`orchestrator.ts:3468`, opts `{ bounded?: boolean }`) has no idle-only mode. Each one-shot kind queues or steers when busy: codex `:3817`, cursor `:4110`, gemini `:4289`, antigravity `:4467`, fx `:4796`.

**Shapes to extend.**
- `PipelineStepRecord` (`src/shared/types.ts:687-705`) carries `startedAt`, `responseKind?` and `reminder?`. It has no settling run id and no retry time.
- `sanitizeStepRecord` (`src/bun/db.ts:613-640`) whitelists the fields.
- The Retry path is `retryActiveExecutions` → `startTask(t.taskId)` (`pipeline-runner.ts:931-979`, `:961`).
- Launch pushes `history` with `startedAt: now` before `startTask` (`:837-840`), so every run of the attempt has `startedAt >= history.startedAt`.
- Manual Advance writes `outcome = "advanced-manually"` (`:1431`). The m11 reset lives in `handleColumnChange` `running` (`:2513-2534`).
- Run view: the history row chips are at `PipelineRunView.tsx:1274-1298`, and the history signature is `stepId:taskId:outcome:reminder.at` (`:535-537`). The CLI history line is at `src/cli/commands/pipeline.ts:481-491`.
- `isTaskRunLive` (`orchestrator.ts:1386-1399`) checks only `task.runId` (plus starting and held). `active` maps runId → `{ taskId, … }` (`:194`, `:234`), so a displaced live run is visible there.
- `subagents.listForTask` (`db.ts:3447`) returns rows with `runId`/`startedAt`/`endedAt`, which makes "this run was held" derivable from the DB.
- `appendRunStatusLine` (`orchestrator.ts:4774`) persists and broadcasts on any run.

**Consumers checked (D18).** No toast or notification gate relies on the release flicker: `notify.ts:49` and `tui/useGlobalEvents.ts:70` key on `column === "blocked"`, `notification-hooks.ts:75` keys on leaving `blocked`, and `App.tsx:1422` only forwards to the pipeline-events store. Neither the TUI nor `agetor show` renders per-history reminder or responseKind tags (grill ledger).

**Test seams that exist.**
- `claude-tmux.__forTest`: `installSession`, `uninstallSession`, `pushTurnSlot`, `flushSync`, `getContinuationWatchdog`.
- `setContinuationRunFactory` save/restore (`claude-continuation.test.ts:11-213`).
- A fake tmux binary with a scripted `has-session` (`claude-turn-routing.test.ts:39-60`).
- Runner seams `setBeforeReminderSend`/`setBeforeReminderStamp`/`handleRunStatus`/`handleColumnChange`/`setListenerEnabled` (`pipeline-runner.ts:2692-2707`).
- `openContinuationRun` (`claude-tmux.ts:188`).
- The fake handoff marker `__agetor_fake_claude_handoff__` and its `continue-then-done` path (`agents.ts:960-1000`, `:1277-1323`, `:2124-2152`).

**Constraints.**
- `flushSync` must stay synchronous.
- Fold-while-busy keeps at most one in-flight run per task. Its pieces stay intact: `holdUntilIdle`, `handlePasteWithheld` re-stash, `startingTaskIds`, and the bounded-spawn `pending` semantics.
- Codex, cursor, gemini, antigravity and fx are unaffected by RC1 and RC2 (claude-only continuation model). The runner changes and D6 apply to them too, and a fresh run per reminder stays legitimate there.

## 3. Approach & key decisions

### 3.1 RC1: drain before release, plus a runner grace

- **`drainSessionJsonl(taskId): boolean`** is a new claude-tmux export.
  - It reads the bytes past `state.offset` synchronously and dispatches them. It never fires a staged `pendingEndTurn`.
  - When it dispatched at least one line, it mirrors async `flush`'s bookkeeping: `lastJsonlAppendAt` and `bumpActivity`.
  - It is a no-op without a live `SessionState`, and while that session is mid-dispatch.
  - The re-entry guard is a new `SessionState.dispatchDepth` counter, incremented around the dispatch loops of `flush`, `flushSync` and the drain itself.
  - `flushSync` is refactored onto the same read-and-dispatch body and keeps its fire tail.
  - *Evidence:* the ordering hazard is documented at `:4895-4934`; the in-dispatch path is traced in §2.
- **`maybeReleaseHeldTask`** calls `drainSessionJsonl(taskId)` first, then re-reads the task. If the line was on disk, the continuation is now `task.runId` with status `running`, so the existing `!== "succeeded"` check bails.
  - Re-entry from the tailer's own dispatch is safe without a drain, because adoption already ran before the settle (`:4527` before `:4554`).
  - *Evidence:* the incident's watcher released 503 ms after the line hit disk.
- **Runner grace (D2b, D3).** A settle can be reminder-eligible: the settling run is `handoff-missing` or `handoff-invalid`, and no supplier was found (§3.3). If the run was held, the grace applies.
  - "Held" is DB-derived: some `subagents.listForTask(taskId)` row with `runId === settling run` and `endedAt > run.endedAt`.
  - The grace applies while `now < releaseAt + RELEASE_CONTINUATION_GRACE_MS` (10 000 ms, test-overridable), where `releaseAt` is the max `endedAt` of those rows.
  - During the grace, the runner leaves the execution active and unblocked, with `responseKind = null`. It arms one unref'd per-task timer that calls `resettleCurrentRun(taskId)` (§3.3) at the deadline.
  - The grace check comes **before** the "already reminded → block" check, so a released held step never blocks inside its grace window.
  - Re-entry is idempotent. A continuation that appeared meanwhile is live (D5 → no-op), or it already advanced the step (execution gone → no-op).
  - *Reasoning:* DB-derived detection survives restarts and needs no bookkeeping to clear. Re-settling the current run, not the stale run id, keeps every path on one decision body.

Rejected alternatives (grill D2): drain only; stopping the watcher's notification scan while a tailer is live; fast-polling the tailer; grace only.

### 3.2 RC2 + D12: one synchronous decision section

- **`sendTurnInExistingSession(taskId, line, rawLine, opts)`** no longer takes a `task` argument. Its first statements, with no `await` until `pasteFollowUp`/`sendTurn` is called:
  1. `drainSessionJsonl(taskId)`.
  2. `const task = tasks.get(taskId)`, a fresh read.
  3. `busy = !!task.runId && active.has(task.runId)`. This is the unchanged fold criterion, now on fresh state.
  4. If `opts.onlyIfIdle`, use `isAnyRunOfTaskLive(taskId) || sessionHasTurn(taskId)` instead (§3.4). When true, return a busy refusal with no side effects.
  5. Fold (busy) or claim `startingTaskIds` and mint (idle), as today.
- **`sendClaudeTurn`**:
  - Keeps the `hasSessionState && await sessionLiveness` gate and no longer passes a snapshot.
  - Its dead-session branch also runs the `onlyIfIdle` check, on a fresh read, right before its `startingTaskIds` claim. Today a fake-driver or no-state task with an active run would mint a second run here.
- **`startContinuationRun`** returns `null` (declines adoption) while `startingTaskIds.has(taskId)`. An agetor-initiated turn being minted owns the content that arrives in that window.
  - In the D12 window, the line falls to the existing `lastChunk` routing. Then `sendTurn` pushes its slot, and the rest of Claude's (folded) turn lands on the minted run.
  - This is the grill's "`startingTaskIds` against `startContinuationRun`".
  - *Reasoning:* the claim is already held exactly across `sendTurn`'s `flushSync`, and after the slot push adoption is ineligible anyway (`turnInFlight`).
- **`sessionHasTurn(taskId): boolean`** is a new claude-tmux export: `turnInFlight(state) || state.turnQueue.length > 0 || state.continuationWatchdog != null`. It is consulted only for the idle-only gate (O3: "do both regardless").
- **Test seam:** `claude-tmux.__forTest.setBeforeSendTurnFlush(hook)` runs inside `sendTurn` right before its `flushSync`, so a test can append a notification line into the D12 window.

### 3.3 RC3: displaced-run report, attempt-window look-back, wait while live

**Runner-only report (O6).** The orchestrator gets `setDisplacedStepRunSettledHandler(fn): prev`, a module-level setter in the same pattern as the claude-tmux seams; it avoids an import cycle.
- `attachDoneHandler` calls it, in both the `.then` and `.catch` branches, when `!isTerminalRun && task?.pipelineParentId`. The call is wrapped in try/catch and never breaks settlement.
- It is not a `GlobalEvent`, so no SSE, toast, notification, TUI or CLI consumer can see it.
- `initPipelineRunner` installs `handleDisplacedRunSettle`, gated by `listenerEnabled`. That handler calls `resettleCurrentRun(taskId)`.
- `resettleCurrentRun(taskId)` reads `task.runId`'s row. If it is terminal, it calls `handleRunStatus(taskId, currentId, status)`. If it is live, it is a no-op, because that run's own settle will come.
- *Reasoning:* a displaced run is older than the current one. Re-entering the current run's settle keeps "the run whose settle advanced the step" well defined (O5) and reuses every existing guard.

**Liveness (D5).** New orchestrator export `isAnyRunOfTaskLive(taskId)` = `isTaskRunLive(taskId) || [...active.values()].some(h => h.taskId === taskId)`.
- It is in-memory and authoritative. A stale `running` DB row, which boot reconcile would orphan, does not freeze a step forever.

**Attempt window (D11).**
- New optional `PipelineStepRecord.attemptStartedAt`. `retryActiveExecutions` sets it to a timestamp taken just before `startTask`, and only on a successful start (a live-refusal skip must not move the window past a live run).
- `attemptWindowStart(record) = max(record.startedAt, record.attemptStartedAt ?? 0)`.
- A user's own message does not touch it.

**New `settleStepRun` decision order.** It still runs under the per-parent lock, and the `remindersInFlight.get(taskId) === runId` guard stays first.

1. `succeeded` and held by background agents → stamp `responseKind` and return. This is M-R3, unchanged.
2. If `status !== "cancelled"` and `isAnyRunOfTaskLive(taskId)` → **wait (D5).** Persist with the execution active and unblocked. Set `responseKind = null` when no outcome is recorded. Return.
3. `cancelled` → the existing branch, unchanged. A deliberate Stop never looks back.
4. `failed`/`orphaned` with `historyEntry.outcome !== null` → return (existing idempotency).
5. **Classify the settling run.** For `succeeded` this is as today. For `failed`/`orphaned` it yields `error`/`cancelled`.
   - If it is `handoff` or `handoff-blocked`, it competes in the look-back below like any other run.
   - If it is `user-ask`, the existing user-ask path runs. A live question on the newest run is not overridden by an older handoff (§8 A3).
6. **Look-back.** Candidates come from `handoffLookbackOrder(runs.listForTask(taskId), windowStart)`: `succeeded` runs with `endedAt != null` and `startedAt >= windowStart`, ordered by `endedAt` desc then `startedAt` desc, capped at `HANDOFF_LOOKBACK_MAX_RUNS = 20`.
   - Each candidate is classified lazily (`mainStreamEventsForRun` → `classifyStepResponse`). The first `handoff` or `handoff-blocked` is the supplier. Newest settled wins, and a blocked handoff counts (D10).
   - For `orphaned`, the look-back is skipped when `run.status === "cancelled" || isDeliberateWholeRunStop(run, taskId)`.
7. **Supplier found:**
   - Set `historyEntry.responseKind` to the supplier's kind (D13).
   - Set `historyEntry.handoffRunId = supplier`.
   - Set `historyEntry.handoffFromOtherRun = supplier !== runId` (D8, O5).
   - When `handoffFromOtherRun` is newly true for that supplier, append `handoffSourceStatusLine(supplier.startedAt, settlingRun.startedAt)` to the supplier run (O2, see below).
   - Then run the existing handoff-blocked, resolve, advance and hold code with that handoff. The advance records `outcome = "succeeded"` even when the settling run itself failed or was orphaned.
   - A stamped reminder no longer blocks (D14), because this path never reaches `attemptHandoffReminderOrBlock`.
8. **No supplier:**
   - `succeeded` missing/invalid → grace check (§3.1), then `attemptHandoffReminderOrBlock`, whose `runningSuccessorSupersedes` check is removed (step 2 makes it provably redundant for genuinely live runs).
   - `failed` → the existing step-failed block.
   - `orphaned` → the existing cancelled/orphaned branch.

**Status lines (O2).**
- `"handoff taken from this run — the step's newer run had none"` when the settling run started after the supplier.
- `"handoff taken from this run — another run of this step ended without one"` otherwise.
- Both are exported constants in `src/shared/pipeline.ts`.

**Other reset rules.**
- m11 (`handleColumnChange` `running`) also resets `handoffRunId` to null and `handoffFromOtherRun` to false, and counts them in its "changed" check. They describe the latest settle, like `responseKind`.
- Manual Advance (`advancePipeline` at `:1431`) clears both fields (D8: a manual Advance leaves it empty).
- `retryActiveExecutions` (`:942`) and `advancePipeline`'s M4 live check (`:1403`) switch to `isAnyRunOfTaskLive`, so Retry and Advance respect D5's shared-worktree rationale.

**PR #264 guards.** They are re-checked against the new rules, not deleted blindly.
- `runningSuccessorSupersedes` in `attemptHandoffReminderOrBlock`: removed. Step 2 covers it.
- `deferReminderToSuccessor`: replaced by `recheckReminder(p, ignoreRunId?)` under the lock. It returns `"send"`, `"abandon"`, or `{ resettle: true }`:
  - abandon when ownership is lost, or the execution is no longer active with that `seq`;
  - abandon (releasing ownership) when any run other than `ignoreRunId` is live;
  - resettle when the look-back finds a supplier. It releases ownership, then `handleRunStatus(p.taskId, p.runId, "succeeded")`.
  - It runs before the send and again after a delivered send, with `ignoreRunId = sent.runId`. It finds handoffs on displaced runs as well (a superset of the old `task.runId` check).
- The stamp lock's ownership check plus `runningSuccessorSupersedes(p.taskId, p.runId, sent.runId)` stay. They are not redundant: a user message can mint a run after the reminder lands.
- `remindersInFlight` and `releaseReminderOwnership` stay.
- `differentCurrentRunId` goes if it becomes unused.

### 3.4 RC4: idle-only `sendInput`

- `sendInput(runId, line, opts: { bounded?: boolean; onlyIfIdle?: boolean })`. `SendInputResult`'s `delivered: false` variant gains `busy?: true`.
- With `onlyIfIdle`, each kind's send function refuses, before any side effect (no run row, no user event, no queue push, no steer), when `isAnyRunOfTaskLive(taskId)`:
  - `sendClaudeTurn` and `sendTurnInExistingSession` (§3.2) also check `sessionHasTurn`;
  - `sendCodexTurn`, `sendCursorTurn`, `sendGeminiTurn`, `sendAntigravityTurn` and `sendFxTurn` check at the top of each, in the same synchronous read as their existing `active.has` check.
- The refusal is `{ delivered: false, busy: true, reason: "the agent is busy with a turn — not sent" }`.
- Only `deliverHandoffReminder` passes `onlyIfIdle`. The HTTP route, cursor plan approval and the ask-card fallback are unchanged.
- In `deliverHandoffReminder`:
  - `sent.busy` → `abandonReminderForSuccessor(p)`. It records nothing and blocks nothing, and the live turn's own settle classifies it (D6).
  - A new test seam, `setBeforeReminderDispatch(hook)`, runs between the pre-send recheck and `sendInput`.
- The reminder record is unchanged. A delivered reminder reads "Reminder sent" with no fold marker (D14).

### 3.5 Breadcrumb surfaces (D7–D9)

- **Types.** `PipelineStepRecord` gains three optional fields: `handoffRunId?: string | null`, `handoffFromOtherRun?: boolean` and `attemptStartedAt?: number | null`.
  - `sanitizeStepRecord` round-trips them: a string or null; a boolean that defaults to `false`; a finite number or null.
  - Rows saved before the change read as empty (D9.3).
- **Run view.** The history row renders a `data-testid="pipeline-run-handoff-source"` span next to the reminder chip, when `handoffFromOtherRun && handoffRunId`.
  - Text: `Handoff from run <first 8>`. `title` = the full run id. Muted/info tone. Non-interactive.
  - A pure helper `handoffSourceChip(record)` in `src/mainview/lib/pipelines.ts` returns `{ text, title } | null`.
  - The `PipelineRunView.tsx:536` history signature adds `handoffRunId` and the flag.
- **CLI.** `agetor pipeline status` appends a dim `(handoff from run <short id>)` after the reminder tag, under the same condition.

### 3.6 E2E fake scenario

The fake driver (`agents.ts`) gets a new handoff suffix, `continue-overlap`. On turn 1:

1. Run A writes text with no handoff and resolves.
2. A microtask adopts continuation **B** through `openContinuationRun(taskId, "notification")`. B writes a terminal handoff but does not resolve yet.
3. Continuation **C** is opened with `openContinuationRun(taskId, "user")`. It displaces B as `task.runId` and writes `"Picking this back up."` with no handoff.
4. B resolves after `FAKE_OVERLAP_B_MS` (400 ms). C resolves after `FAKE_OVERLAP_C_MS` (1200 ms).

Later turns emit an ordinary terminal handoff, as `continue-then-done` does.

Expected flow after the fix:
- A's settle waits (D5).
- B's displaced settle → `resettleCurrentRun` → C is live, so it is a no-op.
- C's settle looks back to B and advances.
- The run view shows the chip with title = B's id, and B's run carries "…the step's newer run had none".
- There is no reminder.

On HEAD, C's settle reminds instead.

## 4. Work breakdown — implementation tasks

Pinned interfaces, so that tasks in one wave can code against each other:

```ts
// src/shared/types.ts — PipelineStepRecord additions (T1)
handoffRunId?: string | null;        // run that supplied the handoff used (null: none / manual advance / pre-change row)
handoffFromOtherRun?: boolean;       // true when handoffRunId !== the run whose settle advanced/recorded the step
attemptStartedAt?: number | null;    // last successful Retry start; window = max(startedAt, attemptStartedAt ?? 0)

// src/shared/pipeline.ts (T1)
export const HANDOFF_LOOKBACK_MAX_RUNS = 20;
export const HANDOFF_FROM_NEWER_RUN_STATUS = "handoff taken from this run — the step's newer run had none";
export const HANDOFF_FROM_OTHER_RUN_STATUS = "handoff taken from this run — another run of this step ended without one";
export function attemptWindowStart(r: { startedAt: number; attemptStartedAt?: number | null }): number;
export function handoffLookbackOrder(
  runs: ReadonlyArray<{ id: string; status: string; startedAt: number; endedAt: number | null }>,
  windowStart: number,
): string[];
export function handoffSourceStatusLine(supplierStartedAt: number, settlingStartedAt: number): string;

// src/bun/claude-tmux.ts (T2)
export function drainSessionJsonl(taskId: string): boolean;
export function sessionHasTurn(taskId: string): boolean;
// __forTest.setBeforeSendTurnFlush(hook: ((taskId: string) => void) | null): previous hook

// src/bun/orchestrator.ts (T4)
export type SendInputResult =
  | { delivered: true; runId: string; unresolvedRefs?: string[]; pending?: true }
  | { delivered: false; reason: string; withheld?: true; savedToBacklog?: boolean; busy?: true };
export async function sendInput(runId: string, line: string, opts?: { bounded?: boolean; onlyIfIdle?: boolean }): Promise<SendInputResult>;
export function isAnyRunOfTaskLive(taskId: string): boolean;
export type DisplacedStepRunSettledHandler = (taskId: string, runId: string, status: "succeeded" | "failed" | "cancelled") => void;
export function setDisplacedStepRunSettledHandler(fn: DisplacedStepRunSettledHandler | null): DisplacedStepRunSettledHandler | null;

// src/bun/pipeline-runner.ts (T5) — __forTest additions
// setReleaseGraceMs(ms: number): number (returns previous); setBeforeReminderDispatch(hook | null); handleDisplacedRunSettle; resettleCurrentRun

// src/mainview/lib/pipelines.ts (T3)
export function handoffSourceChip(r: PipelineStepRecord): { text: string; title: string } | null;
```

| ID | Goal | Owned files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Shared record fields + pure look-back/status-line helpers + sanitizer | `src/shared/types.ts`, `src/shared/pipeline.ts`, `src/bun/db.ts` | — | The three fields exist with doc comments. The helpers match the pinned signatures, and `handoffLookbackOrder` filters (succeeded, `endedAt` set, `startedAt >= windowStart`), orders by endedAt desc then startedAt desc, and caps. `sanitizeStepRecord` round-trips the fields, defaults old rows to `null`/`false`/`null`, and collapses junk to the defaults. Typecheck green. |
| T2 | Re-entry-guarded tailer drain; `sessionHasTurn`; `setBeforeSendTurnFlush` seam | `src/bun/claude-tmux.ts` | — | `SessionState.dispatchDepth` (initialized in `makeSessionState`) is incremented around the dispatch loops of `flush`, `flushSync` and the drain. `flushSync` shares the read-and-dispatch body and keeps its `pendingEndTurn` fire. `drainSessionJsonl` never fires a staged end_turn, returns false for no session or `dispatchDepth > 0`, and bumps activity only when it dispatched lines. Doc comments name RC1 and the ordering hazard. |
| T3 | Breadcrumb UI + CLI tag | `src/mainview/lib/pipelines.ts`, `src/mainview/components/pipelines/PipelineRunView.tsx`, `src/cli/commands/pipeline.ts` | T1 (pinned fields, same wave) | The chip renders only when `handoffFromOtherRun && handoffRunId` (testid `pipeline-run-handoff-source`, title = full id, non-interactive span) and can show next to "Reminder sent". The `:536` signature includes both fields. The CLI prints a dim `(handoff from run <8>)` after the reminder tag under the same condition. |
| T4 | Orchestrator: RC1 release drain, RC2/D12 sync decision, D6 `onlyIfIdle` for all kinds, displaced-run hook, `isAnyRunOfTaskLive` | `src/bun/orchestrator.ts` | T2 (wave 1) | `maybeReleaseHeldTask` drains first. `sendTurnInExistingSession(taskId, line, rawLine, opts)` follows §3.2, and the dead-session branch checks `onlyIfIdle`. `startContinuationRun` returns null while `startingTaskIds.has(taskId)`. `sendInput` threads `onlyIfIdle` to all six kinds with the busy refusal (§3.4), with no side effects on refusal. `attachDoneHandler` `.then`/`.catch` fire the displaced handler for non-current step runs only (try/catch-wrapped, never on the global bus). `isAnyRunOfTaskLive` exported. The `SendInputResult` doc updated. The HTTP route behavior is unchanged. |
| T5 | Runner: D5 gate, attempt-window look-back, supplier recording + status line, grace, displaced handler + `resettleCurrentRun`, idle-only reminder + recheck refactor, Retry window, m11/Advance field resets | `src/bun/pipeline-runner.ts` | T1 (wave 1); T4 (pinned, same wave) | `settleStepRun` follows the §3.3 order, and the failed/orphaned/cancelled rules are as specified. `attemptHandoffReminderOrBlock` drops `runningSuccessorSupersedes` and gains the grace check before the already-reminded block. `deliverHandoffReminder` uses `recheckReminder` before and after the send, passes `onlyIfIdle`, and handles `busy`. `deferReminderToSuccessor` is removed (and `differentCurrentRunId` if unused). `retryActiveExecutions` sets `attemptStartedAt` on a successful start. `retryActiveExecutions` and the `advancePipeline` M4 check use `isAnyRunOfTaskLive`. The m11 branch and Advance reset the new fields. `initPipelineRunner` installs the displaced handler. The `__forTest` additions are present and the doc comments updated (module doc, `PendingReminder`, settle doc). |
| T6 | Fake-driver `continue-overlap` handoff suffix | `src/bun/agents.ts` | T4 (pinned, same wave; uses the existing `openContinuationRun`) | Turn 1 follows §3.6 (A no handoff → B notification-continuation with handoff, unresolved → C user-continuation displacing B, no handoff → B resolves at 400 ms, C at 1200 ms). Turn 2+ emit a terminal handoff. The suffix doc block is extended next to `continue-then-done`. The existing suffixes are byte-identical. |
| T10 | Docs | `CLAUDE.md` | T4, T5 (wave 2) | Item 19 describes the D5 wait, the attempt-window look-back (newest settled wins, blocked counts, Retry resets, user message doesn't), the runner-only displaced report, the 10 s release grace, idle-only reminders (`onlyIfIdle`, refused = nothing recorded), the new fields + chip + CLI tag + status lines, and the m11/Advance resets, and drops the `task.runId`-only successor wording. The "Claude session lifecycle" busy/idle bullets describe the drain + fresh read in one synchronous section, `startContinuationRun` declining while `startingTaskIds` is held, and `maybeReleaseHeldTask`'s drain. No historical plan docs are edited. |
| T11 | Fleet knowledge hygiene (no repo files) | — (JubarteAI entries) | T5 | The entries "Stamp the handoff reminder only while that send still owns the step" and "Handoff reminder fires on the pre-continuation run" are updated (or superseded) to the new rules, and one `decision` entry records O2/O5/O6/D12. |

## 5. Work breakdown — test tasks

Every test that pins a root cause must be **shown failing on the base without the fix** before it is trusted. Run it against the wave-1 checkpoint in a scratch worktree: `git worktree add <scratch>/base-check <wave-1 SHA>`, symlink `node_modules`, copy the new test file(s) in, run, and paste the failing output into the task report. Never use `git stash` and never check out files you don't own.

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| U1 | unit | T1 helpers | `src/shared/pipeline.test.ts` | `attemptWindowStart` (with/without retry). `handoffLookbackOrder`: excludes running/failed/cancelled/orphaned and `endedAt == null`; window boundary inclusive; endedAt-desc then startedAt-desc tie-break; cap. `handoffSourceStatusLine` returns the "newer" text when settling started after the supplier, else the "another run" text. |
| U2 | unit | T1 sanitizer | `src/bun/pipelines.test.ts` | `parsePipelineRunState` round-trips `handoffRunId`/`handoffFromOtherRun`/`attemptStartedAt`. A pre-change row reads `null`/`false`/`null`, and junk collapses to the defaults without dropping the entry. |
| U3 | unit | T2 drain | `src/bun/claude-continuation.test.ts` | (a) A notification line appended but not tailed → `drainSessionJsonl` adopts the continuation and returns true. (b) A staged `pendingEndTurn` on an in-flight slot survives a drain (slot unresolved), while `flushSync` still fires it. (c) A drain called from inside dispatch (via a background-task-settled hook that calls it) is a no-op, with no double or out-of-order dispatch. (d) An async `flush` awaiting its read drops its batch after a drain. (e) `sessionHasTurn` truth table. (f) `setBeforeSendTurnFlush` fires once before the flush. |
| U4 | unit (integration, real orchestrator) | **RC1** | `src/bun/claude-release-drain.test.ts` (new) | A claude task is held (succeeded run R, running subagent row, installed session, JSONL offset at EOF). A task-notification line is appended to disk, then the subagent is settled (`settleSubagentById`). **Expect:** a continuation run (`origin: "continuation"`) is current, the column stays `running`, no `column→review` global event, and R gets no settle. Negative: the line is not on disk → release to `review` as today. **Fails on base.** |
| U5 | unit (integration) | **RC2 + D12** | `src/bun/claude-turn-routing.test.ts` | (a) A notification line is on disk but untailed when `sendInput` is called on an idle-looking task → the message folds into the adopted continuation: no new run row, one `running` run, the user event on the continuation. (b) A continuation is adopted *during* the `has-session` await (fake tmux with a delayed probe, plus a tailer flush in the gap) → it folds the same way. (c) D12: `setBeforeSendTurnFlush` appends a notification line in the mint window → the minted run stays `task.runId`, exactly one in-flight run, no continuation row. **(a)–(c) fail on base.** |
| U6 | unit (integration) | **RC4/D6 orchestrator side** + displaced hook | `src/bun/orchestrator-send-idle-only.test.ts` (new), `src/bun/orchestrator-continuation.test.ts` | `onlyIfIdle` while a run is live → `{delivered:false, busy:true}`, with no run row, no user event, no queue entry. Covered for claude (continuation active), codex (active run) and fx (active run: no steer, no queue). `onlyIfIdle` while idle → delivered. A displaced step run settling fires the handler and emits no `run-status` global event, while a non-step task's displaced run fires nothing. `startContinuationRun` declines while a fake-driver `startTask` spawn holds the claim (`AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS`). **The idle-only and displaced-hook cases fail on base.** |
| U7 | unit (runner) | **RC3**, D5, D10, D11, D13, D14, D15, grace, D6 runner side | `src/bun/pipeline-runner.test.ts` | New tests, building overlaps with `openContinuationRun` from the test for deterministic resolve order: **(1) incident shape:** A no handoff; B continuation with handoff displaced by C (no handoff); B resolves, then C → advance on B, `handoffRunId = B`, `handoffFromOtherRun`, `responseKind "handoff"`, B carries the "newer run had none" line, no reminder. **(2)** C resolves first while B is live → no reminder or block meanwhile; B's displaced settle advances. **(3)** D10: older `done` and newer `blocked` handoffs → step-blocked with the newer. **(4)** D11: a handoff from a run before the last Retry is ignored, and a user message doesn't reset the window. **(5)** D14: an already-reminded, blocked execution advances when a displaced run with a handoff settles. **(6)** D15: listener disabled, runs settled, `reconcilePipelineRuns` advances on the look-back. **(7)** grace: a held-then-released run with no handoff and no continuation → no reminder before the grace (shrunk to ~150 ms), then the reminder; with a continuation inside the grace → no reminder, advance on it. **(8)** D6: `setBeforeReminderDispatch` opens a continuation → reminder refused busy → no `reminder`, no block, the continuation's handoff advances. **(9)** user-ask on the settling run wins over an older handoff. **(10)** orphaned settle looks back; cancelled does not. **(1), (2), (5), (8) fail on base.** Existing tests that encode replaced semantics (`:2067`, `:2167`, `:2239`, `:2326`, `:2418`, `:2580`, `:3264`) are re-run and, where they fail, rewritten to the §3.3 rule with the reason in the commit, never loosened. |
| U8 | unit | T3 surfaces | `src/mainview/lib/pipelines.test.ts`, `src/cli/commands/pipeline.test.ts` | `handoffSourceChip` → null unless both fields are set, text uses the 8-char short id, title is the full id. The CLI prints the dim tag only for `handoffFromOtherRun`, with nothing for pre-change rows. |
| E1 | e2e | RC3/RC4 end to end + D9 UI | `e2e/pipelines-run.spec.ts` | New test in "pipelines run: executing a run": step A `${MARKER}:continue-overlap` → B `${MARKER}:done`. **Expect:** run status Done; `pipeline-run-reminder` count 0; `pipeline-run-blocked` count 0; row A has `response-kind[data-kind="handoff"]` and a `pipeline-run-handoff-source` chip whose `title` equals the id of the step task's earliest-started `origin: "continuation"` run (via REST `GET /tasks/:id/runs`); A's panel transcript contains "handoff taken from this run — the step's newer run had none" and no `handoff-reminder-badge`. The existing `continue-then-done`, `missing-then-done`, `:missing` and `invalid-then-done` scenarios stay green. |

**E2E applies** to the pipeline run flow: webview → API → runner → fake driver, crossing process boundaries. Unit tests own RC1/RC2 because the fake driver bypasses claude-tmux. A live smoke against real claude is not required (D19).

**Run recipe:**
- Setup: `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`, then `bun install` (fresh worktree).
- Types: `bun run typecheck`.
- Unit (targeted): `bun test src/shared/pipeline.test.ts src/bun/pipelines.test.ts src/bun/claude-continuation.test.ts src/bun/claude-release-drain.test.ts src/bun/claude-turn-routing.test.ts src/bun/orchestrator-send-idle-only.test.ts src/bun/orchestrator-continuation.test.ts src/bun/pipeline-runner.test.ts src/mainview/lib/pipelines.test.ts src/cli/commands/pipeline.test.ts`.
- Unit (full): `bun test`. Known pre-existing failures: tmux-socket ×2 and one reconcile cancel test. Check `uptime` first, since CLI tests stall at load 30+.
- E2E: `bun node_modules/@playwright/test/cli.js test e2e/pipelines-run.spec.ts`, then the full `e2e/` suite. One Playwright run at a time.
- The fixture spawns its own headless backend with the fake drivers, a per-worker data dir and fake seams, so no credentials or seed data are needed. Never run against `~/.agetor`.

## 6. Execution waves

| Wave | Tasks (parallel, file-disjoint) | Barrier |
| --- | --- | --- |
| 1 | T1, T2, T3 + U1, U2, U3, U8 | Checkpoint commit. `bun run typecheck` and the wave's tests are green. Record its SHA: wave 2's tests prove "fails on base" against it. |
| 2 | T4, T5, T6 + U4, U5, U6, U7 | Checkpoint commit. Typecheck green. Targeted unit suite green, and each U4–U7 report includes its failing-on-base output. Full `bun test` is green apart from the known pre-existing failures. |
| 3 | T10, E1, T11 | E1 passes. The existing `pipelines-run.spec.ts` passes. The full e2e suite and full unit suite are green, apart from the known pre-existing failures. Final commit. |

Ownership was cross-checked per wave, with no path appearing twice in a wave.
- **Wave 1:** T1 owns `types.ts`, `shared/pipeline.ts` and `db.ts`. T2 owns `claude-tmux.ts`. T3 owns `mainview/lib/pipelines.ts`, `PipelineRunView.tsx` and `cli/commands/pipeline.ts`. U1, U2, U3 and U8 each own their own test files.
- **Wave 2:** T4 owns `orchestrator.ts`. T5 owns `pipeline-runner.ts`. T6 owns `agents.ts`. U4 owns its new file. U5 owns `claude-turn-routing.test.ts`. U6 owns its new file plus `orchestrator-continuation.test.ts`. U7 owns `pipeline-runner.test.ts`.
- **Wave 3:** T10 owns `CLAUDE.md`. E1 owns `e2e/pipelines-run.spec.ts`.

Within wave 2, T5, T6, U6 and U7 code against T4's pinned interfaces (§4). A pinned-interface mismatch found at the barrier is fixed by the interface's owner (T4), not by the caller.

## 7. Blast radius & risks

- **Every claude follow-up (T4).**
  - The fold/idle decision now runs after a sync drain on a fresh read. The fold criterion itself (`active.has(task.runId)`) is unchanged.
  - Risk: the drain dispatches lines (including settle hooks) on the send path. *Mitigation:* the dispatch is exactly what the tailer would do a tick later. U5 plus the existing `claude-turn-routing`/`claude-tmux-queue`/`orchestrator-continuation` suites are the guard.
- **`startContinuationRun` declining while `startingTaskIds` is held.** Content that arrives in a mint window routes to `lastChunk` (the previous run) until the new slot is pushed.
  - The windows are a fresh `startTask` spawn, a `--resume` spawn, and the idle mint.
  - Risk: a breadcrumb line lands on the older run. Accepted: the alternative is a displaced run.
- **Release path (RC1).** Synchronous file reads now happen inside the watcher's settle. They are bounded to the bytes appended since the offset, the same cost as `flushSync`.
  - Re-entry is guarded by `dispatchDepth`.
  - Ordinary claude cards lose the `review`→`running` flicker. No toast or notification gate depends on it (§2).
- **D5 wait.** A step whose sibling run never settles waits. Today's idle-fire, stuck-turn watchdog, 10-min continuation watchdog and boot orphaning bound this.
  - Liveness is in-memory, so stale `running` rows can't freeze a step.
- **Look-back cost.** `mainStreamEventsForRun` loads every row of a run, subagent rows included. The look-back classifies lazily, newest first, and stops at the first supplier, capped at 20 runs. Typical cost is 1–2 loads per settle.
  - A `stream`-filtered db query is out of scope (§9).
- **Runner semantics for every harness.**
  - D6 refuses a reminder into a live one-shot turn (a queued follow-up being spawned). The live turn's settle then decides, so the existing one-reminder rule holds.
  - Failed and orphaned settles may now advance on an earlier valid handoff in the window. Cancelled never does.
- **Status line on a finished run.** `appendRunStatusLine` on the supplier appends at the bottom of the merged transcript (id order). It is appended once per new supplier.
- **No migration, no flag, no backfill (D16).** The new fields are optional JSON inside `tasks.pipeline_run`. Old rows read as empty. Rollback is a revert.

## 8. Open questions / assumptions

| # | Question | Resolution | Source / confidence |
| --- | --- | --- | --- |
| O2 | Status-line wording when the supplier is the newer run | Two constants: "…the step's newer run had none" when the settling run started after the supplier, "…another run of this step ended without one" otherwise. | plan (owner's meaning kept, D9) |
| O3 | Is a fresh read in one sync section enough? | Yes for the fold decision, because `onAdopted` registers `active` synchronously (`claude-tmux.ts:4408`). The idle-only gate additionally consults `sessionHasTurn`. | code + plan |
| O4 | Is the drain safe re-entrantly? | A `dispatchDepth` guard makes in-dispatch calls no-ops, and adoption already precedes the settle there. The async-flush overlap is covered by its existing offset guard. No fallback is needed. | code (`:4527/:4554`, `:4927`) |
| O5 | Storage for "came from another run" | Two flat optional fields, `handoffRunId` and `handoffFromOtherRun`, decided at settle time, where the settling run is known. Surfaces need no extra lookup. | plan |
| O6 | Report channel | A dedicated runner-only setter hook, never a `GlobalEvent`. | plan |
| A1 | Which runs can supply a handoff? | Only `succeeded` runs. A failed or cancelled run's text is never trusted as a handoff. | plan, medium-high |
| A2 | Which settles look back? | `succeeded`, `failed` and `orphaned`. The orphaned look-back is skipped on a whole-run stop. `cancelled` never looks back, because a deliberate Stop wins. This makes D15's boot reconcile recover the incident shape. | plan, medium |
| A3 | `user-ask` on the settling run vs. an older handoff | `user-ask` wins, because a live question is not orphaned by advancing. | plan, medium |
| A4 | Grace detection | DB-derived: a subagent of the settling run that ended after the run did. The window is anchored on the last such `endedAt`. A boot-time settle long after release gets no grace (deadline passed), which is correct. | plan, high |
| A5 | Grace vs. already-reminded | The grace runs first, so a released held step never blocks inside its window. | plan |
| A6 | Retry/Advance liveness | Widened to `isAnyRunOfTaskLive`, the same shared-worktree rationale as D5. | plan |
| A7 | `continuationWatchdog` in `sessionHasTurn` | It counts as busy (an adopted turn awaiting content). | plan |
| O1 | Claude always auto-continues after a notification | Unchanged (grill). If wrong, the reminder goes out after 10 s, which is intended. | owner |

None of these is a one-way door. Each is a revertible runtime rule with no schema change.

## 9. Completeness ledger

| Item | Disposition | Task / reason / who deferred |
| --- | --- | --- |
| RC1 drain in `maybeReleaseHeldTask` (re-entry guarded, no end_turn fire) | in this run | T2, T4; U3, U4 |
| RC1 10 s runner grace for released held steps | in this run | T5; U7(7) |
| RC2 fresh-read sync decision (drain + read + decide + mint) | in this run | T4; U5(a,b) |
| RC2 reverse variant (D12) via `startContinuationRun` decline | in this run | T2 seam, T4; U5(c), U6 |
| RC3 displaced-run report (runner-only) | in this run | T4, T5; U6, U7(2) |
| RC3 attempt-window look-back, newest wins, blocked counts | in this run | T1, T5; U1, U7(1,3) |
| D5 never advance while any run of the step is live | in this run | T4 (`isAnyRunOfTaskLive`), T5; U7(2) |
| D11 Retry resets window (`attemptStartedAt`), user message doesn't | in this run | T1, T5; U7(4) |
| RC4 `onlyIfIdle` for claude/codex/cursor/gemini/antigravity/fx | in this run | T4; U6 |
| RC4 runner: refused reminder records nothing, blocks nothing | in this run | T5; U7(8) |
| PR #264 guards re-checked: `runningSuccessorSupersedes` in attempt (removed), `deferReminderToSuccessor` → `recheckReminder`, stamp-lock checks kept, `remindersInFlight` kept | in this run | T5; U7 existing-test re-run |
| D13 `responseKind` re-stamp from the supplier | in this run | T5; U7(1) |
| D14 stamped reminder no longer blocks once a handoff is found | in this run | T5; U7(5) |
| D15 boot reconcile uses look-back | in this run | T5 (via `handleRunStatus`); U7(6) |
| New fields: types, sanitizer, old rows read empty | in this run | T1; U2 |
| Run-view chip + `:536` signature | in this run | T3; U8, E1 |
| CLI `pipeline status` tag | in this run | T3; U8 |
| Status line on the supplying run (both O2 texts) | in this run | T1 constants, T5; U1, U7, E1 |
| m11 reset + manual Advance clearing the new fields | in this run | T5; U7 |
| Retry/Advance liveness → `isAnyRunOfTaskLive` | in this run | T5 |
| Item-21 toast/notification gates vs. vanished flicker | in this run (verified, no change) | §2 consumer check; T4 reviewer re-confirms |
| Fake-driver `continue-overlap` scenario | in this run | T6 |
| New pipeline e2e scenario | in this run | E1 |
| One failing-on-base unit test per RC | in this run | U4 (RC1), U5 (RC2), U7(1/2) (RC3), U6 + U7(8) (RC4) |
| `CLAUDE.md` item 19 + session-lifecycle text | in this run | T10 |
| Fleet knowledge entries describing old successor semantics | in this run | T11 |
| `differentCurrentRunId` orphaned by the refactor | in this run | T5 removes it if unused |
| Historical plan docs (`adopt-continuation…`, `fix-stuck-subagent…`, `fix-handoff-parser`, `hold-task-running…`) | out of scope | owner D17: historical records |
| Data backfill / repair of past history rows | out of scope | owner D16: nothing stuck; old rows read empty |
| Feature flag | out of scope | owner D16 |
| TUI / `agetor show` display of the new field | out of scope | grill: neither renders per-history tags today |
| Live smoke with real claude | out of scope | owner D19 |
| Accepting a bare trailing JSON object as a handoff | out of scope | evidence: not a parser miss (investigation, PR #264) |
| `stream`-filtered `run_events` query for the look-back | out of scope | separate perf ticket. It touches the `run_events` query-plan guard (`db-run-events-plans.test.ts`), and today's cost is bounded (§7). |
| Keeping one `fx acp` child across turns, etc. | out of scope | unrelated harness work |
