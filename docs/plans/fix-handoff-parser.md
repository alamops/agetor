# Plan — Don't remind for a missing handoff while a newer run is still writing

| Field | Value |
| --- | --- |
| Date | 2026-10-06 |
| Source | Pipeline step transcript: a real `<handoff>` was visible, then "HANDOFF MISSING — SENT ONE AUTOMATIC REMINDER", then the reminder turn idle-closed |
| Config | AGENTS_CONFIG.yml (v1 balanced; `/implement --update` exists, not applied mid-task) |
| Flags | none |
| Gates | Grill skipped by the owner ("continue with the information you already have"). Assumptions below are the decisions this run proceeds on. |
| Branch | fix/fix-handoff-parser |
| Base SHA | 39f2a46 |

## 1. Objective & success criteria

A step turn that settles with no `<handoff>` must not send the automatic reminder, must not record a block, and must not stamp `responseKind: "handoff-missing"` when a newer run of that same step is already `running`. The newer run's own settle classifies its reply. If that reply has a valid handoff, the step advances and `history.reminder` stays unset. If it also lacks a handoff, that settle sends the one reminder.

A successor that has already left `running` before the reminder is queued does not suppress the decision inside `attemptHandoffReminderOrBlock`. `deliverHandoffReminder` still does not paste the reminder onto the old run: it classifies the successor. A handoff there advances the step. No handoff there sends the one reminder.

## 2. Context & constraints

The parser is not the failure. `parseHandoff` / `findLastHandoffBlock` (`src/shared/pipeline.ts`) only scan the assistant text of the run that just settled (`assistantTextFrom` in `src/bun/pipeline-runner.ts`). The task transcript merges every run.

Incident (Photo Pipeline · Code Review, parent `108b967a-e72b-459a-93cf-3dc50b7e54de`, step `e911ec51-522d-43ee-a578-4d6435ca89b0`), read from `~/.agetor/agetor.sqlite`:

- Run `f0a381e4` succeeded with a findings JSON array and no `<handoff>` tag. The runner classified `handoff-missing` and sent the reminder (status event 813986, 19:42:37).
- Run `17faaf7d` (`origin: continuation`) had already replaced `task.runId` at 19:42:36 ("auto-continued after background task"). The real `<handoff>` (`next: "Bug Fix"`, `status: "done"`) was assistant event 813993 on that run at 19:43:13, and the later settle accepted it (`responseKind: "handoff"`).
- Run `98480aa4` was the reminder, created 9 ms after the continuation. It never got an `end_turn` and idle-closed ~60 s later.

`attemptHandoffReminderOrBlock` and `deliverHandoffReminder` did not look at `task.runId`. A settle that arrives while `remindersInFlight` is set returns without classifying, so the flag must not be set when the reminder is abandoned.

## 3. Approach & key decisions

- Add `runningSuccessorSupersedes(taskId, settledRunId)`: `task.runId` is set, differs from the settled run, and that run's status is `running`. Any newer running run, not only `origin === "continuation"`.
- In `attemptHandoffReminderOrBlock`, after the existing skip/block checks: return null with no block, no `remindersInFlight` entry, and `responseKind` cleared. Persist so the cleared stamp is what a poll reads.
- In `deliverHandoffReminder`, before `sendInput` and again after it returns: if a newer run is still `running`, or is terminal and already has a handoff, do not send and do not stamp over that handoff. A terminal handoff is re-entered through `handleRunStatus`. A still-running successor is left for its own settle. A terminal successor with no handoff does not defer — the one reminder still goes out on the queued run, which is the live session. The run `sendInput` just delivered the reminder on is that reminder turn, not a successor. Deferring to it never stamps `reminder`, so every later settle of the same execution queues another send.
- `remindersInFlight` records the run id. `settleStepRun` drops only that run. A different run is classified. `attemptHandoffReminderOrBlock` does not queue a second reminder while one is in flight. The `ready`/`review` column settle skips only when the latest run is the in-flight reminder's run.
- Do not accept a trailing bare JSON object as a handoff. The findings before the tag were a fenced array; the real tag parses.
- Do not change `line_uuid` sharing across content blocks. That drop is real and did not cause this incident: the handoff was persisted as its own assistant event.

## 4. Work breakdown — implementation tasks

### T1 — suppress the reminder

Owns `src/bun/pipeline-runner.ts`. Acceptance: both call sites above, comment on the check order, no status line on the skip.

## 5. Work breakdown — test tasks

### T2 — regression

Owns `src/bun/pipeline-runner.test.ts`.

- Running successor, no handoff on the settled run: no reminder user event, no block, execution stays active, `reminder` and `responseKind` null. Then a valid `<handoff>` on the successor settles to `done` / `review` with `responseKind: "handoff"` and `reminder` still null.
- Successor already `succeeded` with no handoff of its own: the one reminder still goes out.
- Successor already `succeeded` with a valid handoff: the step advances, `reminder` stays null, no reminder user event.
- Successor settles with a valid handoff while the reminder is queued (`beforeReminderSend`): same advance, no reminder user event.

e2e: `e2e/pipelines-run.spec.ts` drives `:continue-then-done` through the board and the run view. The fake driver opens a real continuation run after the first reply (no `<handoff>`) and writes the handoff there. The run reaches Done with no reminder chip and no blocked banner. The existing missing / invalid / missing-then-done specs stay the regression that a step with no newer run still gets exactly one reminder.

## 6. Execution waves

One wave. T1 and T2 touch different files and can land together; this run writes both inline because the change is one helper and two call sites.

## 7. Blast radius & risks

- A genuine missing handoff with no newer run still reminds (`:missing-then-done` unchanged).
- A few milliseconds remain if the continuation starts after the pre-send check and during `sendInput`, and then itself lacks a handoff: the paste may already have gone out, and it is stamped as the one reminder. A continuation that writes a handoff in that window is classified and the stamp is skipped. The incident had the continuation first; the pre-send check covers it.
- Re-entering `handleRunStatus` for a successor that finished during the queued reminder must not recurse into another reminder for the same run. It classifies the successor, which is a different `runId`.

## 8. Open questions / assumptions

| Question | Answer | Source | Confidence |
| --- | --- | --- | --- |
| Suppress only `origin: "continuation"`, or any newer running run? | Any newer running run. A user follow-up that already started is the same situation. | Incident plus `startContinuationRun` / `sendInput` both move `task.runId` | high |
| Loosen `parseHandoff` to accept bare JSON? | No. | The stored handoff is a real tag; the previous run's text is a findings array | high |
| Change the line-uuid scheme so multi-block JSONL lines aren't dropped? | Out of scope. Not this incident. | Event 813993 is its own assistant row | high |
| Idle-close of the reminder run? | Goes away when the reminder is not sent. No separate change. | Reminder run `98480aa4` existed only because the reminder was sent | high |

## 9. Completeness ledger

| Item | Disposition |
| --- | --- |
| In-lock skip when a newer run is already `running` | In this run (T1) |
| Pre-send skip, including clearing `remindersInFlight` so the successor settle is not dropped | In this run (T1) |
| Re-settle a successor that reached a terminal status while the reminder was queued, including one that is already terminal when `deliverHandoffReminder` checks | In this run (T1) |
| Classify a different run while `remindersInFlight` points at the previous run | In this run (T1) |
| Regression: running successor; finished successor with no handoff still reminds; finished successor with a handoff advances; in-flight settle of a handoff is not dropped | In this run (T2) |
| e2e: `:continue-then-done` reaches Done with no reminder; missing / invalid / missing-then-done / invalid-then-done still send exactly one reminder | In this run (T3) |
| Accepting bare JSON as a handoff | Out of scope — different ticket; the tag parser already accepts this handoff |
| Per-content-block `line_uuid` | Out of scope — different ticket; did not drop this handoff |
| Migration / backfill | Out of scope — no stored shape change. The incident's history row already shows both the false reminder and the later accepted handoff; this run does not rewrite old rows |
