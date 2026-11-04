# Spike — Pipeline human step: resume return mode (T0)

| Field | Value |
| --- | --- |
| Date | 2026-11-04 |
| Plan | `docs/plans/pipeline-human-step.md` (T0, §8 open question 1) |
| Test | `src/bun/pipeline-human-step-resume-spike.test.ts` |
| Verdict | **GO** — resume is deterministic on the fake claude driver and uses only the production seam |

## Question

Can a **settled** step execution be re-armed as a new execution on its
existing task, resumed through `sendInput`, settled into a new history
record, and forced to resolve to the gate — deterministically — without a
second task row? The plan's Return mode offers `fresh` (default) and
`resume`; the owner chose both in v1, so the spike is a go/no-go for
shipping `resume` at all.

## What was proven

The test drives the exact production path the route/CLI call:
`reviewHumanStep(parentId, { decision: "return", mode: "resume" })` against a
real runner (`initPipelineRunner`) and the fake claude driver, on
`A → H → B` where A's handoff names **B**.

1. A settles and the gate opens (`run.humanSteps[0]`).
2. Resume creates a new `seq`/`run.active`/history record **under the parent
   lock**, then calls `sendInput(currentRunId, message, { onlyIfIdle: true })`
   on A's existing task.
3. A **new run row** appears on the same task (`runs.listForTask` grows by
   one); **no second step task row** is inserted.
4. The new run settles: its history record ends `succeeded`, carries
   `returnToStepId = H`, and `nextStepIds = [H]` — **even though its handoff
   named B**. The forced edge wins.
5. The gate re-opens with a new `seq` and the resumed A handoff as its
   arrival.
6. `stepCount` is unchanged: a resume is not a new agent execution (the
   fresh return is what increments it).

## Why it is deterministic

- The re-arm record is written and persisted **before** `sendInput`, so the
  settle can never arrive without a record to land on.
- The settle path resolves `historyEntry.returnToStepId` in one place
  (`settleStepRun`), overriding `resolveNextSteps` — a stale or adversarial
  handoff `next` cannot divert the loop.
- A handoff-missing/invalid response on a returned execution also takes the
  forced edge (with a `null` handoff), so a bad turn cannot dead-end on a
  reminder.
- `sendInput` is called with `onlyIfIdle: true` after an `isAnyRunOfTaskLive`
  check; a refusal rolls the re-arm back, restores the gate, and returns 409
  (the panel surfaces it; the user can retry or choose fresh).

## Harness coverage

The fake claude driver is a persistent-session harness. One-shot harnesses
(codex/gemini/antigravity) resume through the same `sendInput` entry point;
their per-kind dispatch is unchanged by this feature, and the one-shot
refusal case is covered by the route's 409 (`resume unavailable`), not by a
second process harness.

## Failing evidence

None — the test passes:

```
bun test src/bun/pipeline-human-step-resume-spike.test.ts
 1 pass / 0 fail
```

The plan's stop condition (record the failing command and return to the
owner) is therefore not triggered.
