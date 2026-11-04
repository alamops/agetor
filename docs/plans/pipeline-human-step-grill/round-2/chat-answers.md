# Round 2 — chat follow-ups

| Field | Value |
| --- | --- |
| Date | 2026-11-04 |
| Mode | Chat (the decision-form server was killed before it accepted the round-1 submission; see `../round-1/answers.owner-paste.json`) |
| Answered by | Alamo |

These three questions exist because the round-1 answers overrode recommendations in ways that materially change the plan. They do not re-ask the same questions; they settle the consequences.

## Q1 — Return modes scope

**Context.** The round-1 answer was `either` for `return-mechanics`: offer both a fresh execution of the previous step and a resume of its existing session. The investigation found that the resume path needs a spike (`sendInput`, re-arming the execution, the settle/look-back/held state) while the fresh path reuses `launchStep`.

**Question.** Should both modes ship in v1, or should v1 ship fresh and add resume as a follow-up?

**Answer.** **Both in v1.**

**Consequence recorded.** v1 includes a resume spike (first task, go/no-go), both modes in the panel and CLI, a per-gate mode choice that defaults to fresh, and tests for both paths. If the spike cannot make resume deterministic, the plan must stop and return to the owner rather than silently drop it.

## Q2 — Card Stop while the run is in Review

**Context.** The round-1 answer was `immediate-review` for `fanout`: the card flips to Review as soon as a gate arrives, even while sibling agents are still writing to the shared worktree. `TaskCard` gates Stop on `pipelineRun.status === "running"`, so Stop would disappear from the card.

**Question.** Should the card keep a Stop for the live siblings, and should it confirm?

**Answer.** **Review + secondary Stop with confirm.**

**Consequence recorded.** The card keeps Review as the primary action and a danger Stop as a secondary action whenever the run still has live executions or a pending gate. Stop asks for confirmation, then cancels the run, dismisses the gate, preserves history and moves the card to Ready.

## Q3 — Blocked sibling vs pending gate

**Context.** The existing `deriveRunStatus` returns `blocked` before anything else. With `immediate-review`, a sibling branch can be blocked while the human gate is pending.

**Question.** Which run status wins?

**Answer.** **Review wins.**

**Consequence recorded.** While a human gate is pending, `review` wins over `blocked`; the card stays in Review and the block is surfaced in the run view. This deliberately departs from today's blocked-wins rule and needs its own tests. A stopped/cancelled run still wins over Review, and when no gate is pending the old precedence applies.
