# Grill — pipeline handoff lost when a reminder races a background-task continuation

| Field | Value |
| --- | --- |
| Date | 2026-10-27 |
| Source | `docs/plans/handoff-identification-fix-investigation.md` (§4 must-ask list), plus code reading of `src/bun/orchestrator.ts`, `src/bun/pipeline-runner.ts`, `src/cli/commands/pipeline.ts`, `src/mainview/components/pipelines/PipelineRunView.tsx` |
| Mode | interactive, answered by the owner (three structured passes via AskUserQuestion) |
| Flags | none |

## Already settled by evidence (not asked)

- The `<handoff>` was present and valid. It sat on continuation run `87382327` (`run_events` 1130800), so this is not a parser miss. Do **not** fix it by loosening `parseHandoff` (e.g. by accepting a bare trailing JSON object).
- The watcher, not the tailer, released the hold: `subagents.ended_at` 27.081 < continuation `started_at` 27.105.
- The reminder split into a second concurrent run (`5016143c`) instead of folding into the continuation. Claude 2.1.312 folded the paste mid-turn, so one `end_turn` covered two slots.
- This is systematic: 11 overlaps and 10 lost handoffs since 2026-10-02, 9 of them after PR #264, and 3 in this same pipeline run. HEAD is affected (`v1.0.2..HEAD` does not touch this logic).
- No pipeline parent is stuck today, so there is no data to repair.

## Decisions

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| D1 | Scope | Which root causes to fix? | **All four: RC1, RC2, RC3, RC4.** RC2 is fixed as the general claude send-routing bug it is, not pipeline-only. | owner |
| D2 | RC1 approach | How to stop a held claude step from being released before Claude's continuation is adopted? | **Drain + runner grace.** (a) The release path (`maybeReleaseHeldTask`) synchronously drains the claude-tmux tailer before deciding, so a continuation whose notification line is already on disk is adopted first and the release bails. The drain must be re-entry guarded and must **not** fire a staged `pendingEndTurn` (unlike `flushSync`'s tail). (b) When a released held step's settled run has no handoff, the runner waits up to the grace window for a continuation of that step task before sending the reminder. This covers the `checkDone`/`checkStale` releases the drain can't. Rejected: drain only (seq 7's needless reminder stays possible); stop the watcher's scan from settling while a tailer is live (lags up to 5 s, still loses to `checkDone`); runner grace only (the card flicker stays). | owner |
| D3 | RC1 grace | How long is the grace window? | **10 s.** It starts at the held-step release. It ends early when a continuation run of the step task appears; D5 then applies. If it expires with no continuation, the reminder flow continues, gated by D6. | owner (accepted default) |
| D4 | RC3 source | When a step's run settles with no handoff, where else may the runner find it? | **Report + look back.** (a) The orchestrator also reports the settle of a **displaced (non-current) run of a pipeline step task** to the runner. Today `attachDoneHandler` only emits `run-status` when `task.runId === runId`. This new signal must not reach toasts, OS notifications, the TUI or `agetor logs --notify` as a user-facing run settle. (b) On any settle, the runner takes the newest valid handoff from any run of that step task inside the current attempt. Rejected: look back only (+60 s in the incident), overlap only, report only. | owner |
| D5 | RC3 advance rule | May a valid handoff on a displaced run advance the pipeline while a newer run of the same step task is still live? | **No, wait for it.** The pipeline never advances while any run of that step task is still live, because the next step shares the worktree. Once nothing is live, the runner advances on the newest valid handoff in the attempt window. | owner |
| D6 | RC4 | Should the reminder refuse to paste into a busy session? | **Yes, idle-only, for every harness.** The busy check runs in the same synchronous section as RC2's busy/idle decision, via a `sendInput` option such as "only if idle". A refused reminder records nothing and blocks nothing. The execution stays active and unblocked, and the live turn's own settle classifies it. That settle may still send the one reminder if it also ends without a handoff. | owner |
| D7 | Breadcrumb | How is "the handoff came from another run" explained? | **Status line + history field.** The run that supplied the handoff gets a status line, and the history row records which run supplied it. | owner |
| D8 | Field semantics | When is the new history field recorded and shown? | **Record always, show only if from another run.** Every execution that advances on a parsed handoff records the run id that supplied it; a manual Advance leaves it empty. The run view chip, the CLI tag and the status line appear only when that run is not the one whose settle advanced the step. The plan decides the storage shape, e.g. a `handoffRunId` plus whatever marker makes "other run" decidable on read. | owner |
| D9 | Field UI | Chip / tag / status-line details | (1) The run-view chip is non-interactive, with the full run id as its tooltip. It sits next to the existing "Reminder sent" chip, and both can show together. (2) The CLI `agetor pipeline status` tag is dim: `(handoff from run <short id>)`. (3) The `db.ts` sanitizer whitelist round-trips the field, and history rows saved before the change read it as empty. (4) The pipeline e2e asserts both the chip and the status line. (5) Status-line text: "handoff taken from this run — the step's newer run had none". See open assumption O2. | owner (accepted defaults) |
| D10 | Multiple handoffs | Several runs in the attempt carry a handoff | **The newest settled one wins.** A `status:"blocked"` handoff counts as a handoff, as today, so a newer blocked handoff beats an older done one. | owner (accepted default) |
| D11 | Attempt boundary | Which runs are "inside the current attempt"? | Runs that started at or after the later of the execution's launch and its last Retry. A user's own message to the step does **not** reset the window. | owner (accepted default) |
| D12 | RC2 reverse variant | Also close the unobserved reverse race? | **Yes.** `sendTurn`'s `flushSync` adopting a continuation after `sendTurnInExistingSession` has already set `task.runId` to the new run must not displace that run or create a second in-flight run. | owner (accepted default) |
| D13 | responseKind | Which run does the history row's `responseKind` describe? | The run whose handoff was used. A row first stamped `handoff-missing` is re-stamped `handoff`/`handoff-blocked` when a look-back or a displaced-run report supplies the handoff. | owner (accepted default) |
| D14 | Reminder record | How is a delivered reminder shown? | It stays "Reminder sent", with no "folded" marker. D6 makes a fold rare, and agetor can't reliably detect Claude's own mid-turn fold. A stamped reminder no longer blocks the execution once a valid handoff is found on any run in the attempt window. | owner (accepted default) |
| D15 | Boot reconcile | Does `reconcilePipelineRuns` use the same look-back? | Yes. It funnels through `handleRunStatus` → `settleStepRun` and gets the same window and the same D5 wait rule. | owner (accepted default) |
| D16 | Rollout | Flag / backfill? | No feature flag. No data backfill, because no parent is stuck today and old history rows stay as-is. | owner (accepted default) |
| D17 | Docs | Which docs change? | Update `CLAUDE.md` item 19 (reminder / settle / successor semantics, the new field) and the "Claude session lifecycle" fold/busy text (RC2). Historical plan docs stay untouched. | owner (accepted default) |
| D18 | Non-pipeline effect | Release-path change for ordinary claude tasks | Ordinary claude cards lose the brief `review`→`running` flicker on release. No toast or notification change is intended; the plan must check item 21's gates for anything that relied on the flicker. | owner (accepted default) |
| D19 | Acceptance | Test bar | **Unit + pipeline e2e.** One unit test per root cause, each shown failing on HEAD before the fix. RC1/RC2 are pinned by claude-tmux/orchestrator tests that drive `dispatchLine`/`flushSync` with synthetic JSONL and a stubbed `sessionLiveness`; RC3/RC4/grace by runner tests. Plus a new fake-driver scenario in `e2e/pipelines-run.spec.ts` where a continuation and a second run overlap, asserting the step advances on the continuation's handoff, the D9 chip and status line, and no needless reminder. Live smoke against real claude: not required. | owner |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| RC1: re-entry-guarded tailer drain in the release path, with no staged end_turn fire | in this change | owner (D1, D2) |
| RC1: runner 10 s continuation grace for released held steps | in this change | owner (D2, D3) |
| RC2: busy/idle re-decided on a fresh task read in one synchronous section with the run insert (consulting `active`/session turn state, plus `startingTaskIds` against `startContinuationRun`) | in this change | owner (D1) |
| RC2 reverse variant (`sendTurn`'s `flushSync` adoption) | in this change | owner (D12) |
| RC3: orchestrator → runner report for displaced step-run settles, kept off user-facing surfaces | in this change | owner (D4) |
| RC3: attempt-window look-back, newest-wins, wait-while-live rule | in this change | owner (D4, D5, D10, D11) |
| RC4: `sendInput` idle-only option used by `deliverHandoffReminder`, all harnesses | in this change | owner (D6) |
| Re-check PR #264's guards (`differentCurrentRunId`, `runningSuccessorSupersedes(…, ignoreRunId)`, `deferReminderToSuccessor`'s `sentRunId` special case, `remindersInFlight`) against the new rules. Simplify only what is provably redundant, never delete blindly | in this change | unfinished otherwise: the guards locate successors only via `task.runId`, the very thing RC3 changes |
| New history field: `src/shared/types.ts`, `db.ts` `sanitizeStepRecord` whitelist, `PipelineRunView.tsx` chip, `agetor pipeline status` tag, status line on the supplying run | in this change | owner (D7–D9) |
| `PipelineRunView.tsx`'s history signature (`:536`, currently `stepId:taskId:outcome:reminder.at`) must include the new field, or the chip won't repaint | in this change | unfinished otherwise |
| `responseKind` re-stamp when a later look-back supplies the handoff | in this change | owner (D13) |
| Boot reconcile uses the same look-back | in this change | owner (D15) |
| `CLAUDE.md` item 19 + Claude session-lifecycle text | in this change | owner (D17) |
| Unit tests per RC (failing on HEAD first) + new pipeline e2e fake scenario | in this change | owner (D19) |
| Item-21 toast/notification gates checked against the vanished release flicker | in this change | owner (D18) |
| Update the fleet knowledge entries this changes ("Stamp the handoff reminder only while that send still owns the step", "Handoff reminder fires on the pre-continuation run") | in this change (knowledge hygiene at implement time) | they will describe superseded behavior |
| Historical plan docs (`adopt-continuation-on-task-notification.md`, `fix-stuck-subagent-running-detection.md`, `fix-handoff-parser.md`, `hold-task-running-while-background-agents-run.md`) | out of scope | owner (D17): historical decision records, not living docs |
| Data backfill / repair of past history rows | out of scope | owner (D16): nothing is stuck; old rows read the new field as empty |
| Feature flag | out of scope | owner (D16) |
| TUI and `agetor show <parent>` display of the new field | out of scope | neither surface renders per-history reminder/responseKind tags today (only `agetor pipeline status` and the run view do), so parity holds |
| Live smoke with real claude | out of scope | owner (D19): the race can't be forced live; the e2e plus unit tests are the bar |
| Accepting a bare trailing JSON object as a handoff | out of scope | evidence: not a parser miss; explicitly ruled out by the investigation and PR #264 |

## Assumptions still open

- **O1 (A2 in the brief).** Claude Code always auto-continues after a background-agent task-notification on an idle session. *If wrong:* the 10 s grace (D3) expires and the reminder goes out on an idle session. That is the intended fallback, so no change is needed, only a 10 s delay in that rare case.
- **O2.** The accepted status-line text, "the step's newer run had none", assumes the run that ended without a handoff is newer than the supplying run. In an interleaving where the supplying run is the newer one, the plan must keep the line true, e.g. "another run of this step ended without one". The meaning the owner approved is unchanged.
- **O3 (A3).** Re-reading the task and doing the busy/idle decision plus the run insert in one synchronous section closes RC2. *If wrong* (some `registerActiveRun` happens after an await): the fold check must also consult the session's `turnQueue`/`turnInFlight` directly. The plan should do both regardless.
- **O4 (A4).** The tailer drain closes RC1 whenever the notification line is already on disk, which is always true for the watcher-scan path. For `checkDone`/`checkStale`, the D3 grace is the backstop. *If the drain proves unsafe re-entrantly:* fall back to the grace alone for the runner, and accept the card flicker for non-pipeline tasks. That would need the owner's sign-off, since it narrows D2.
- **O5.** D8's "show only if from another run" needs the history row to know which run's settle advanced it. Today the record carries no settling run id, so the plan picks the storage shape: a second field, or a stored boolean.
- **O6.** The D4 displaced-run report must reach only the pipeline runner. If it rides the existing `run-status` global event, every consumer (App toasts, OS notifications, TUI, CLI notify) must ignore it. A dedicated runner-only hook is the safer shape; the plan decides.
