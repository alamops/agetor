# Plan — Mark a finished pipeline Done

| Field | Value |
| --- | --- |
| Date | 2026-10-06 |
| Source | Owner report: pipeline run sits at Done while the board card stays in Review; clicking Done returns `pipeline task's column is managed by its run` |
| Config | AGENTS_CONFIG.yml (older phase→runners file, balanced preset). Host: Cursor. Investigate ran on Claude Sonnet. `/implement --update` would move this file to schema v3 without changing those choices. |
| Flags | none. Grill questions were skipped; assumptions below are the narrow reading of the original request. |
| Gates | Grill skipped by the owner — proceeding on the assumptions in §8. Plan written and followed in the same run because the owner said to continue with the information already in hand. |
| Branch | fix/pipeline-done |
| Base SHA | 39f2a46 |

## 1. Objective & success criteria

A pipeline whose run status is `done` can be moved into the board's Done column by:

- the card's existing Done button (and the context menu's Mark done)
- a Done button on the pipeline run view
- dragging the card onto the Done column

The card stays in Review when the run finishes, matching a normal agent run. Clicking Done no longer returns `pipeline task's column is managed by its run`. Restart still moves the card back to Running, because that is a real status change.

## 2. Context & constraints

- `ColumnId` includes a real `done` column (`src/shared/types.ts`). Done is a column move. Archive is a separate action that becomes available once the card is in Done.
- A finished pipeline is mirrored to Review on purpose (`src/bun/pipeline-runner.ts` `persist()`, `done: "review"`). `docs/plans/pipelines.md` D9: last step → parent `review`, same as a normal exit 0.
- `PATCH /tasks/:id` refuses every column change on a pipeline parent (`src/bun/server.ts`, around the M-S4 guard). The card's Done button calls `api.moveTask(id, "done")` and surfaces that 409.
- `persist()` only mirrors the column when `pipelineRun.status` actually changes. A card parked in Done is not snapped back to Review by a later bookkeeping write. Restart changes the status, so the card returns to Running. That behavior already exists; the 409 is what made the park unreachable. The two `pipelineUpdateColumn(..., "done")` calls in the runner move **step** tasks, not the parent.
- `handleColumnChange` ignores events whose task has no `pipelineParentId`, so moving the parent does not settle a step.
- The board drag handler refuses every drop of a pipeline parent before the request (`src/mainview/App.tsx` `onDragEnd`).
- `PipelineRunView` header has Stop / Retry / Restart and no Done button.
- `GET /tasks` trims handoffs but keeps `pipelineRun.status`, so the board can tell a finished run from a live one.
- Existing finished pipelines are stored as `column=review`. No migration.

## 3. Approach & key decisions

Allow exactly one manual column write: `column: "done"` when `pipelineRun.status === "done"`. Every other column change on a pipeline parent still 409s, including a cancelled run (it sits in Ready) and a finished run moved anywhere except Done.

The run view Done button calls the same `markDone` the card uses, so the board updates immediately, then reloads the run view so the button hides once the card is in Done.

Drag onto Done is allowed only for that same case. Other drops keep the existing toast.

This rests on the runner comment and the `persist()` transition guard already in the code, not on a new column-mapping rule. Finishing a pipeline still lands in Review.

## 4. Work breakdown — implementation tasks

### T1 — Server exception
Owns: `src/bun/server.ts`, the `persist()` comment in `src/bun/pipeline-runner.ts`, the one sentence in `CLAUDE.md` item 19.
Acceptance: a parent with `pipelineRun.status === "done"` accepts `PATCH {column:"done"}`. Any other target column still 409s. A parent whose status is not `done` still 409s on `column:"done"`. Same-value resend still 200.

### T2 — Done affordances
Owns: `src/mainview/components/pipelines/PipelineRunView.tsx`, `src/mainview/App.tsx`.
Acceptance: run view shows `pipeline-run-done` when status is `done` and the card is not already in Done. It calls `markDone` and reloads. Drag onto Done works only in that same case. Other pipeline drags still toast and do not request.

## 5. Work breakdown — test tasks

E2e applies. The move crosses the webview, the PATCH route, and the board column.

- Endpoint test in `src/bun/pipelines-endpoint.test.ts` covers the new allow and the still-refused cases. The existing M-S4 test (idle parent, `column:"done"` → 409) stays.
- E2e in `e2e/pipelines-run.spec.ts`: a finished run shows the run-view Done button; clicking it stores `column=done` and hides the button; the board card's Done button does the same for a second finished pipeline. Existing tests that wait for Review after a run finishes stay valid.
- Drag has no existing board-drag harness. The server contract covers the request drag will send. No new drag e2e.

Run recipe: `bun test src/bun/pipelines-endpoint.test.ts` and `bunx playwright test e2e/pipelines-run.spec.ts -g "Done column"`. App start for e2e is the Playwright `freshBackend` fixture (fake claude driver). No extra credentials.

## 6. Execution waves

Wave 1: T1 and T2 together (disjoint files).
Wave 2: endpoint test and e2e (disjoint files), after the implementation lands.

## 7. Blast radius & risks

- Callers of the parent column: `persist()` (unchanged mapping), the PATCH guard (exception added), board drag (exception added), card `markDone`, context menu (already calls `markDone`), CLI `agetor move` (same PATCH, so it gains the same exception with no CLI change).
- TUI has no mark-done for any task. Out of scope.
- Restart from the Done column must still flip the card to Running via the existing status transition. The e2e restart test still expects Review after a restart that began in Review; this run does not change that test.
- A bookkeeping `persist()` while status stays `done` must not pull the card out of Done. That is the existing `previousStatus !== run.status` guard.

## 8. Open questions / assumptions

Grill form was skipped. Proceeding on these:

| Question | Answer | Source | Confidence |
| --- | --- | --- | --- |
| Which moves, once the run is Done? | Card Done, context-menu Mark done, run-view Done, and drag onto Done. No other column. | Owner asked for both Done buttons. Drag is the same column write, so leaving it blocked would keep a caller on the old refusal. | High |
| Cancelled pipelines (they sit in Ready)? | Not markable Done. | Owner described a run that is already Done. Narrower than also unlocking Ready. | Medium — easy to widen later |
| After the card is in Done? | Restart returns it to Running. Archive works like any other Done card. Existing finished pipelines stay in Review until someone clicks Done. | Existing `persist()` and archive rules. No backfill. | High |

## 9. Completeness ledger

| Item | Disposition |
| --- | --- |
| PATCH guard exception | In this run — T1 |
| Card Done button and context menu | In this run — they already call `markDone`; T1 makes the request succeed |
| Run-view Done button | In this run — T2 |
| Drag onto Done only | In this run — T2 |
| Other column moves, including cancelled → Done | In this run — still refused |
| `persist()` snap-back | In this run — no code change; comment updated to match the exception. Existing transition guard is the mechanism |
| CLI `agetor move` | In this run — same PATCH, no separate CLI edit |
| TUI mark-done | Out of scope — the TUI has no mark-done for ordinary tasks either |
| Backfill of existing Review cards | Out of scope — a different data migration; the owner can click Done |
| Auto-move to Done when the run finishes | Out of scope — would change D9 (finish lands in Review) |
| Step-task column 409 | Out of scope — step columns stay runner-owned |
