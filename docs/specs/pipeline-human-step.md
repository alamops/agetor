# Spec — Pipeline Human Step

| Field | Value |
| --- | --- |
| Date | 2026-11-04 |
| Source | The pipeline step task text for "Pipeline \"Alamo Pipeline (OpenCode)\" — step 1 of at most 50: Investigation" (owner-authored). Committed here so later decisions cite a repo path. |
| Status | Contract as given; implementation decisions are in `docs/plans/pipeline-human-step-grill.md`. |

## Requirement (verbatim)

> We must introduce a new type of element in the Pipeline: Human Step. It adds a “pause” / “review” / “breaker” in the pipeline. It can be added between two steps, and at the end, but never as first step. It must have different UI (or border), and when the pipeline reaches this step, behavior of the card/pipeline must be the same of the “Review” status. On the human step, the owner/human must have a control panel view/modal of the work done so far, including the last handoff (from the previous step to to the human step). Once in this step, the human, can add a comment and decide to send that as a return to the previous step, or accept and send to the next step (if exists). The comments are necessary when sending to the previous step, but option when sending to the next step (if any)

## What is fixed by this spec

- A human step is a graph element, addable between two steps and at the end, never first.
- It has a distinct visual treatment (border/UI).
- Reaching it makes the pipeline card behave like the Review status.
- The owner gets a control panel showing the work done so far and the last handoff into the human step.
- The owner can comment and either return to the previous step (comment required) or accept and continue to the next step when one exists (comment optional).

## What the spec leaves to the implementation decisions

The run-state representation, card actions, fan-out behavior, return mechanics, incoming-edge rules, panel contents, escape hatches, CLI parity and bundle compatibility are decided in `docs/plans/pipeline-human-step-grill.md`, grounded in `docs/plans/pipeline-human-step-investigation.md`.
