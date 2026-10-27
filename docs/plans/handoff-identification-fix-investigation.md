# Investigation — pipeline handoff lost when a reminder races a background-task continuation

| Field | Value |
| --- | --- |
| Date | 2026-10-27 |
| Change | Find why a claude pipeline step's real `<handoff>` was ignored, and why the handoff reminder was pasted into a session that was still working after its background subagent. Informs the fix plan. |
| Agents | none spawned (pipeline step forbids delegation); 1 inline codebase pass, 1 inline git-history pass, read-only prod-DB forensics, 1 web lookup |
| Flags | none (no spikes run; prod forensics settled every load-bearing question, see §2) |

## 0. The incident in one paragraph

Step task `22076376` (step "Code Review", claude-code, CLI 2.1.312, prod app v1.0.2) launched `/code-review` as a forked background skill and ended its turn with "running in the background, I'll wait for its findings". The step was correctly **held** in `running`. Six minutes later the subagent finished. Three independent races then fired in a row:

1. The subagent watcher released the hold before the session tailer adopted Claude's auto-continuation, so the runner settled the pre-continuation run as `handoff-missing` and queued the one reminder.
2. The reminder's `sendInput` decided "idle" from a stale task snapshot and minted a second concurrent run. It should have folded into the continuation that had just been adopted, and that second run displaced the continuation as `task.runId`.
3. Claude folded the queued reminder into the running turn and wrote the real `<handoff>`. It landed on the displaced continuation run, whose settle never reaches the pipeline runner. The empty reminder run then idle-closed and was classified "still no valid handoff after one reminder".

The pipeline stalled for 24 minutes until the user typed "try again sending the handoff".

## 1. What we know

### 1.1 Timeline of the incident (UTC, prod DB `~/.agetor/agetor.sqlite`, read-only)

| Time | Event | Evidence |
| --- | --- | --- |
| 22:32:57.371 | run `ac514cf5` starts; prompt pasted 22:32:59.845 | `runs`, event 1130560 |
| 22:33:04.4 | `Skill code-review` launched forked, in the background; subagent row `a66f2f11…` (general-purpose) | events 1130563/4, `subagents` |
| 22:33:07.641 | assistant: "…running in the background. I'll wait for its findings…" → end_turn; run `ac514cf5` `succeeded` 22:33:07.659; task **held** in `running`; runner stamps `responseKind` and keeps the execution active (`pipeline-runner.ts:2103`) | events 1130568/70 |
| 22:39:26.151 | subagent writes its final findings message | event 1130752 |
| 22:39:26.578 | main JSONL line 45: `queue-operation enqueue <task-notification>` (then a `dequeue`, then the `user` line with `origin.kind = task-notification`) | session JSONL |
| **22:39:27.081** | subagent row → `completed`, **before** the tailer saw line 45 | `subagents.ended_at` |
| ~27.08 | `maybeReleaseHeldTask` → `review` → runner `handleColumnChange(review)` → `settleStepRun(ac514cf5)` → `handoff-missing` → no successor yet → reminder queued → `sendInput(ac514cf5)` | code path, §1.2 |
| **22:39:27.105** | tailer dispatches line 45 → continuation run `87382327` adopted (`origin=continuation`, `task.runId=87382327`, in `active`) | `runs.started_at`, event 1130753 "auto-continued after background task" |
| **22:39:27.130** | reminder's `sendInput` takes the **idle** branch → new run `5016143c`, `task.runId=5016143c`, a second turn slot pushed behind the continuation's | `runs.started_at`, event 1130757 |
| 22:39:27.680 | Claude Code enqueues the paste and folds it into the running turn as a `queued_command` attachment (no turn of its own) | JSONL lines 57, 63 (`remove`), 65 |
| 22:39:27.695 | `sendInput` returns `delivered`, `runId 5016143c` → not deferred (current run = the run just sent) → `reminder` stamped, status "handoff missing — sent one automatic reminder" | event 1130759; `pipeline_run.history[seq 11].reminder.runId = 5016143c` |
| 22:40:11–13 | Claude writes the real `<handoff>` (next: "Bug Fix") → head slot = continuation `87382327` → `succeeded` 22:40:13.250. `task.runId` is `5016143c`, so `isTerminalRun` is false: **no column change, no `run-status`**, and the runner never sees it | event 1130800 has `<handoff>` |
| 22:41:16.196 | `5016143c` (zero assistant rows) idle-closed after 60 s ("claude sat idle at the input box for 60s with no end_turn") → terminal → `run-status` → classified `handoff-missing` → already reminded → block "still no valid handoff after one reminder…" | events 1130844/5 |
| 23:04:18 | user: "try again sending the handoff" → run `c35dc2f2` → handoff re-emitted → step advanced to "Bug Fix" (seq 12) at 23:04:42 | `history[seq 11].endedAt` |

### 1.2 Root causes (each with anchors)

**RC1: the hold release races continuation adoption, because two independent readers tail the same main JSONL.**
- The adopt-before-settle ordering exists only inside the tailer's `dispatchLine`: `maybeAdoptContinuation` at `src/bun/claude-tmux.ts:4527`, then `fireBackgroundTaskSettled` at `:4554`. Its doc says this ordering exists precisely so `maybeReleaseHeldTask` "sees `task.runId` already pointing at a running continuation run and bails" (`claude-tmux.ts:4516-4526`; plan `docs/plans/adopt-continuation-on-task-notification.md`, PR #97).
- The subagent watcher also scans the main JSONL (`scanMainSignals` → `scanLineForTaskNotification`, `src/bun/claude-subagents.ts:3298`). Since the W3 widening (PR #141, `docs/plans/fix-stuck-subagent-running-detection.md:100`), that scan settles an **ordinary** running async row on the notification line (`claude-subagents.ts:3353`). It goes through `settleSubagent` → `fireSettle` → the orchestrator's settle hook `maybeReleaseHeldTask` (`src/bun/orchestrator.ts:365, :627`). The hook releases whenever `task.runId`'s run is `succeeded` and nothing is running, so it flips the card to `review`.
- Cadence makes the watcher the usual winner after a long background wait. The watcher polls at `FAST_POLL_MS = 600` while a subagent is active (`claude-subagents.ts:440`). The tailer's poll backs off to `POLL_SLOW_MS = 5_000` after 30 s idle (`claude-tmux.ts:7860-7872`), and its doc notes fs.watch drops notifications on slow appends. Here the watcher settled 503 ms after the line hit disk; the tailer adopted 24 ms later.
- `checkDone` (subagent end_turn + `DONE_IDLE_MS = 1500`, `claude-subagents.ts:460`) and `checkStale` are other watcher-side releases that can also precede adoption. Here `checkDone` is ruled out, since the earliest it could fire is ≥ 27.65 s.
- Pipeline effect: the runner's `handleColumnChange` `review` branch (`src/bun/pipeline-runner.ts:2549-2559`) is the **only** settle a held step gets. At that instant no successor exists, so `attemptHandoffReminderOrBlock`'s `runningSuccessorSupersedes` check (`pipeline-runner.ts:1779`) passes and the reminder is queued. For a non-pipeline task the same race is only a `review` → `running` flicker.

**RC2: `sendClaudeTurn` decides busy vs idle from a task snapshot taken before an `await`.**
- `sendClaudeTurn` reads `task` (`orchestrator.ts:5660`), then awaits `sessionLiveness` (a `tmux has-session` fork, `:5678`; `claude-tmux.ts:1846`). It then passes that **stale** snapshot to `sendTurnInExistingSession`, whose fold-while-busy check is `task.runId && active.has(task.runId)` (`orchestrator.ts:5729`).
- A continuation adopted during the await (`startContinuationRun`, `orchestrator.ts:6037`, which sets `task.runId` and registers the run in `active` synchronously) is invisible to that check. The idle branch then inserts a second `running` run and overwrites `task.runId` (`orchestrator.ts:5784-5806`).
- Neither `startContinuationRun` nor the fold check claims or consults `startingTaskIds` against the other path.
- Consequence: two turn slots, while Claude produces one end_turn. Claude Code 2.1.312 folds input queued mid-turn into the running turn (`queued_command` attachment, JSONL line 65). So the second slot strands until the 60 s idle-fire. This is exactly the stranding class fold-while-busy was built to prevent (`orchestrator.ts:5719-5728`).
- **Not pipeline-specific**: any claude follow-up sent within the adoption window does this.
- Related hypothesis (not observed here): `sendTurn` calls `flushSync` before pushing its slot (`claude-tmux.ts:8873`). That flush can itself adopt a continuation after `sendTurnInExistingSession` has already set `task.runId`, which would displace the new run instead (the reverse variant).

**RC3: the runner only ever classifies the one run that becomes terminal; a handoff on a superseded run is dropped.**
- `attachDoneHandler` emits `run-status` and moves the column only when `task.runId === runId` (`orchestrator.ts:2609`, `:2669`; the `.catch` twin at `:2699`). A run displaced as `task.runId` settles silently.
- `settleStepRun` classifies only `assistantTextFrom(mainStreamEventsForRun(runId))` for the settling run (`pipeline-runner.ts:2090`).
- `handleColumnChange` picks only `runs.listForTask(taskId)[0]`, the newest run by start time (`:2552`).
- PR #264's guards (`differentCurrentRunId` / `runningSuccessorSupersedes` / `deferReminderToSuccessor`, `pipeline-runner.ts:363-392, 1866-1912`) all locate "the successor" through `task.runId`. They cannot see a continuation that the reminder's own run displaced. Worse, `deferReminderToSuccessor(p, sentRunId)` explicitly treats `sentRunId` (here the displacing run) as "the reminder turn, not a continuation" (`:1866-1880`).

**RC4 (contributing): the reminder can be pasted into a busy session.** `deliverHandoffReminder` (`pipeline-runner.ts:1914`) re-checks for successors before `sendInput` (`:1927`) only via `task.runId`. `sendInput` itself has no "only if idle" mode, so a reminder that arrives while Claude is mid-continuation is folded (or, via RC2, split) into a turn that would produce the handoff anyway. This is the user-visible half of "tried to send the retry with a still running session".

### 1.3 It is systematic, not a one-off (read-only DB-wide query)

- **11** reminder runs since 2026-10-02 started while a `continuation` run of the same step task was still running (gaps 6 ms – 1,986 ms). In **10** of them the continuation carried `<handoff>` and the reminder run had none, so the step stalled until a human nudged it. **9** of them post-date PR #264 (merged 2026-10-07).
- The same pipeline run as this incident hit it **3 times**:
  - seq 1 "Investigation" (task `5f5d34d5`): continuation `80f8e74b` held the handoff; reminder run `ab84efb6` idle-closed empty; the user typed "try again" **78 min** later.
  - seq 11: this incident, a 24 min stall.
  - seq 7 "Code Review" (task `a5534b8f`): the reminder run `412a3853` was minted *before* the tailer saw the notification, so no continuation was adopted. The reminder run absorbed the continuation and carried the handoff, so it recovered, but the reminder was needless.
- 322 reminder runs exist in total; the 11 are the subset with this exact overlap signature.
- No pipeline parent is stuck in this state right now (all active parents read `running`, `blocked: []`), so there is no existing-data repair to do.
- The prod app is v1.0.2. `git diff v1.0.2..HEAD` does not touch any of the code above (only a `fast`→`speed` field rename in `launchStep`), so the bug is live on HEAD.

### 1.4 What already works and must not regress

- Adopt-on-notification + watchdog (`CONTINUATION_WATCHDOG_MS`, 10 min) — PR #97.
- The held-step settle contract M-R3 (`pipeline-runner.ts:2096-2106`, and the `review` branch at `:2531-2559`).
- PR #264's successor guards and the stamp-ownership rule (knowledge entries "Handoff reminder fires on the pre-continuation run" and "Stamp the handoff reminder only while that send still owns the step"). Do **not** "fix" this by accepting a bare trailing JSON object.
- `flushSync` must stay sync. Async `flush` advances `state.offset` **before** its dispatch loop (`claude-tmux.ts:4895-4920`), so a nested `flushSync` from inside `dispatchLine` would dispatch later lines before earlier ones. Any new "drain the tailer" call must not run re-entrantly from the tailer's own dispatch.
- `flushSync` ends by firing any staged end_turn ("a new human prompt is definitive proof the previous turn ended", `claude-tmux.ts:4866-4870`). That is correct for `sendTurn`, wrong for a release-path drain.

## 2. What we proved

| Question | Verdict | Evidence | Versions | Artifact |
| --- | --- | --- | --- | --- |
| Was the handoff present but ignored (not a parser miss)? | **Yes** | `run_events` 1130800 (run `87382327`, main stream) contains `<handoff>{…"next":"Bug Fix"…}`; seq 11 history only advanced at 23:04:42 off run `c35dc2f2` | app v1.0.2 / HEAD 5b1d38c | prod DB, read-only |
| Did the watcher, not the tailer, release the hold? | **Yes** | `subagents.ended_at` 27.081 < continuation `started_at` 27.105. The tailer path adopts before it settles (`claude-tmux.ts:4527` before `:4554`). `checkDone` is impossible before 27.65 | same | prod DB |
| Did the reminder split into a second concurrent run instead of folding? | **Yes** | runs `87382327` (27.105) and `5016143c` (27.130) both `running`; the reminder user event is on `5016143c`; only one end_turn in the JSONL (line 76) | Claude Code 2.1.312 | session JSONL lines 45–77 |
| Did Claude fold the reminder into the running turn? | **Yes** | JSONL `queue-operation enqueue` (line 57), `queued_command` attachment (line 65), `queue-operation remove` (line 63); one `turn_duration` (line 77) | Claude Code 2.1.312 | session JSONL |
| Is it recurring? | **Yes, 11 overlaps and 10 lost handoffs since 2026-10-02** | DB-wide query in §1.3 | — | prod DB |

No scratch spikes were run. Every load-bearing claim above was settled by production timestamps plus code reading.

## 3. What we're assuming

- **A1.** No test currently pins RC1–RC3. The fake claude driver bypasses tmux, so neither the watcher/tailer race nor `sendClaudeTurn`'s `sessionLiveness` await is exercised. `continue-then-done` adopts via `openContinuationRun` after `done` resolves, which is not this interleaving. *If wrong:* fewer new tests are needed. The plan must prove each new test fails on HEAD before trusting a green run.
- **A2.** Claude Code always auto-continues after a background-agent task-notification on an idle session; the 10-minute watchdog covers the rare no-continuation case. *If wrong:* a fix that waits for a continuation before settling a released hold needs a bounded fallback (the watchdog already provides one).
- **A3.** Re-reading the task and doing the busy/idle decision plus run insert in one synchronous section closes RC2. *If wrong (e.g. `registerActiveRun` happens after an await somewhere):* the fold check must also consult the session's `turnQueue`/`turnInFlight` directly.
- **A4.** A synchronous tailer drain from `maybeReleaseHeldTask` (guarded against re-entry, without firing a pending end_turn) closes RC1 whenever the notification line is already on disk, which is always true for the watcher-scan path. For the `checkDone`/`checkStale` paths the line may not be on disk yet. Those then rely on RC2/RC3/RC4 hardening. *If wrong:* a grace window or a "continuation expected" state is needed instead.

## 4. What we must ask the owner

1. **Scope.** Fix all four root causes, or only the pipeline-visible ones? RC2 is a general claude bug: any message sent during adoption splits the turn and strands a run for 60 s. *Recommend all four.* Each covers an interleaving the others miss: §1.3's seq 7 shows a reminder minted before adoption, and seq 1 shows the watchdog settle racing a second notification.
2. **RC1 approach.** Options:
   - (a) drain the tailer synchronously in `maybeReleaseHeldTask` before deciding, the mirror of `pumpWatcherForHoldCheck` (*recommended*);
   - (b) stop the watcher's notification scan from settling ordinary rows while a live tailer is attached, keeping it as the restart-only backstop (still loses to `checkDone`, and the release lags up to 5 s);
   - (c) fast-poll the tailer while subagents run (narrows the window, doesn't close it);
   - (d) a runner-side grace delay before settling a released hold (rejected in PR #97 for the card; maybe acceptable for the runner only).
3. **RC3 semantics.** When a step's settling run has no handoff, which other runs may supply it?
   - (a) any run of the step task that settled since the current attempt began (the boundary being the step launch, a Retry, or a user resend);
   - (b) only runs that overlapped the settling run;
   - (c) the orchestrator reports superseded-run settles of step tasks to the runner, which classifies them on their own.

   And: may a valid handoff on a superseded run **advance the pipeline while a newer run of the same step is still `running`** (e.g. a stranded reminder slot that will idle-close)? Or must the runner first settle or cancel that run?
4. **RC4.** Should the handoff reminder refuse to send whenever the step's session is busy, deferring to that live turn's own settle (e.g. a `sendInput` "only if idle" option checked in the same synchronous section as RC2's fix)? Or should folding a reminder into a busy turn stay allowed?
5. **Already-reminded executions.** After the fix, a run that settles with a handoff on a superseded run should advance even though `reminder` is already stamped (today the next bad settle blocks immediately, `pipeline-runner.ts:1726`). Confirm the history should still show "Reminder sent" in that case, or whether a reminder pasted into a busy turn should be recorded differently (e.g. `delivered: true` but marked "folded into a running turn").
6. **Breadcrumbs.** Should the run carrying the handoff get a status line (e.g. "handoff taken from the continuation run") so the run view explains why a different run advanced the step?

## 5. Completeness inventory

- **Callers / touch points**
  - `src/bun/orchestrator.ts`: `maybeReleaseHeldTask` (`:627`, sole caller: settle hook `:365`); `isHeldByBackgroundAgents` (`:614`, also used by `pipeline-runner.ts:2103` and Stop at `:3316, :6920`); `sendClaudeTurn` (`:5659`, sole caller: `sendInputInner` at `:3686`); `sendTurnInExistingSession` (`:5713`, sole caller `:5679`); `startContinuationRun` (`:6037`, wired by `setContinuationRunFactory` at `:378`); `attachDoneHandler` (`:2545`; `isTerminalRun` gates at `:2609` and `:2699`); `sendInput` (`:3468`).
  - `src/bun/claude-tmux.ts`: `dispatchLine` (`:4418`, adoption `:4527`, settle `:4554`); `maybeAdoptContinuation` (`:4352`); `flushSync` (`:4846`, called from `sendTurn` `:8873` and `:7846`); async `flush` (`:4895`); `sendTurn` (`:8851`); `pasteFollowUp`; `hasSessionState` (`:1673`); `sessionLiveness` (`:1846`); the poll constants (`:7860-7872`).
  - `src/bun/claude-subagents.ts`: `fireSettle` call sites `:1684, :2917, :2933, :2983, :3042, :3867, :4519`; `scanLineForTaskNotification` (`:3298`, ordinary-row settle `:3353`); `handleBackgroundTaskNotification` (`:1745`); `settleSubagent` (`:4490`).
  - `src/bun/pipeline-runner.ts`: `differentCurrentRunId`/`runningSuccessorSupersedes` (`:363-392`), `mainStreamEventsForRun`/`assistantTextFrom` (`:394-410`), `attemptHandoffReminderOrBlock` (`:1710`), `releaseReminderOwnership`/`deferReminderToSuccessor`/`deliverHandoffReminder` (`:1828-2025`), `settleStepRun` (`:2058`), `handleRunStatus` (`:2451`), `handleColumnChange` (`:2473`), `reconcilePipelineRuns` (`:2619`).
  - `src/shared/pipeline.ts`: `classifyStepResponse`, `parseHandoff` (unchanged unless RC3 picks multi-run text).
- **Propagation surface:** `PipelineStepRecord.reminder` / `responseKind` (types in `src/shared/types.ts`; whitelist `sanitizeStepReminder` / `sanitizeResponseKind` in `src/bun/db.ts`) if Q5 changes what's recorded. Run-view chips `pipeline-run-reminder` / `pipeline-run-response-kind` (`src/mainview/lib/pipelines.ts` `responseKindLabel`), and the CLI `agetor pipeline status` tags, only if the record shape changes. No API contract change is expected otherwise.
- **Existing data to backfill:** none. No parent is currently blocked by this; historical history entries can stay as-is.
- **Docs that describe current behavior:** `CLAUDE.md` item 19 (one-shot handoff reminder; RC2's fold/busy wording in "Claude session lifecycle"); `docs/plans/fix-handoff-parser.md`; `docs/plans/adopt-continuation-on-task-notification.md` (its ordering claim no longer holds since W3); `docs/plans/fix-stuck-subagent-running-detection.md` (W3); `docs/plans/hold-task-running-while-background-agents-run.md`.
- **Tests to extend:** `src/bun/pipeline-runner.test.ts` (has `continue-then-done`, M-R3 hold, successor/reminder races via the `beforeReminderSend`/`beforeReminderStamp` seams); `src/bun/claude-continuation.test.ts` (adoption ordering, synthetic notification lines); `src/bun/orchestrator-continuation.test.ts`; `src/bun/claude-turn-routing.test.ts` (send routing); `src/bun/claude-tmux-queue.test.ts`; `src/bun/claude-workflow-agents.test.ts` (`pumpWatcherForHoldCheck` pattern); `e2e/pipelines-run.spec.ts` (fake seams `__agetor_fake_claude_handoff__:continue-then-done`, `__agetor_fake_claude_subagent__`).
- **Would orphan:** nothing expected. If RC3 option (a)/(b) is chosen, the "the run `sendInput` just started is the reminder turn" special case in `deferReminderToSuccessor` / `runningSuccessorSupersedes(…, ignoreRunId)` may become partly redundant; re-check it rather than delete it blindly.

## 6. Runnability

- **Setup:** `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`. A fresh worktree needs `bun install`.
- **Unit:** `bun test` (targeted: `bun test src/bun/pipeline-runner.test.ts src/bun/claude-continuation.test.ts src/bun/orchestrator-continuation.test.ts src/bun/claude-turn-routing.test.ts`).
- **Types:** `bun run typecheck`.
- **E2E:** Playwright via `bun node_modules/@playwright/test/cli.js test e2e/pipelines-run.spec.ts`. Run one Playwright run at a time.
- **Dev app:** `bun run dev:hmr` against `~/.agetor-dev` (never prod `~/.agetor`).
- **Known pre-existing unit failures on main:** tmux-socket ×2 and one reconcile cancel test. Report them as pre-existing.
- **Seam gap:** the fake claude driver bypasses claude-tmux, so RC1/RC2 need claude-tmux/orchestrator-level unit tests that drive `dispatchLine`/`flushSync` with synthetic JSONL plus a stubbed `sessionLiveness`. Pipeline e2e can still cover RC3/RC4 through a new fake scenario where a continuation and a second run overlap.

## 7. Risks & blast radius

- **RC2's fix changes routing for every claude follow-up.** It must keep the "at most one in-flight run per task" invariant, the `startingTaskIds` claim, `holdUntilIdle`, and the withheld-paste re-stash semantics (`handlePasteWithheld`).
- **A tailer drain inside the release path runs inside the watcher's settle**, i.e. inside `settleSubagent` → `fireSettle`. Re-entrancy with the tailer's own `dispatchLine` → `fireBackgroundTaskSettled` → `settleSubagent` path must be guarded. Firing a staged end_turn from that drain would resolve a turn early.
- **Advancing on a superseded run's handoff while a newer run is `running`** leaves a live run on a step task whose execution is already `done`. Its later settle hits `activeIdx === -1` (a no-op), but the card/column and the run view must stay honest.
- The non-pipeline flicker (`review` → `running`) disappears as a side effect of RC1's fix. The toast and notification gates (item 21 in CLAUDE.md) should be checked for any behavior that relied on it.
- Codex/cursor/gemini/fx steps are unaffected by RC1/RC2 (claude-only continuation model), but RC3/RC4 runner changes apply to every harness and must not change one-shot reminder semantics (a fresh run per reminder there is legitimate).
