# Grill — Pipeline Human Step

| Field | Value |
| --- | --- |
| Date | 2026-11-04 |
| Source | Pipeline step task text (committed as `docs/specs/pipeline-human-step.md`) + `docs/plans/pipeline-human-step-investigation.md` |
| Mode | Interactive via the decision form (round 1), answered by **Alamo**. The form server was killed before it wrote `answers.json`, so the owner's pasted submission is saved verbatim as `round-1/answers.owner-paste.json`. Three consequence questions were then answered in chat (`round-2/chat-answers.md`). |
| Answers | `docs/plans/pipeline-human-step-grill/round-1/answers.owner-paste.json`; `docs/plans/pipeline-human-step-grill/round-2/chat-answers.md` |
| Flags | none |
| Spec | `docs/specs/pipeline-human-step.md` |

> **How to read this record.** The owner answered all 21 required round-1 questions; the optional mock upload was left blank. The form server was killed by the harness before it could write `answers.json`, so the raw owner payload is the evidence file. Four round-1 answers overrode the recommendation (`fanout`, `return-mechanics`, `pending-actions`, `bundle-compat`); the round-2 chat settles their consequences. No answer was invented, and no skipped required question was filled in.

## What changed the shape of the work

1. **`immediate-review` is the biggest state-machine change.** The run status and card flip to Review as soon as a gate arrives, even while sibling agents are still writing. `review` therefore coexists with `run.active`, outranks `blocked` while a gate is pending, and every consumer that assumes "review means idle" must be audited.
2. **Both Return modes ship in v1.** The fresh path reuses `launchStep`; the resume path needs a spike into `sendInput`, re-arming a settled execution, and the settle/look-back/held state. This is the largest scope increase and the highest delivery risk.
3. **Bundle compatibility is now conditional v2.** A bundle containing a human step is written as version 2; old readers refuse it with the existing "update agetor" error. Human-free bundles stay version 1 and remain byte-identical.
4. **Stop while a gate is pending is a new lifecycle path.** Stop must work with no live executions, cancel the run, dismiss the gate, keep history and move the card to Ready; the card's Stop asks for confirmation.
5. **Single incoming keeps the join complexity out.** No human join state, no return-target picker; Accept to a `join:"all"` step still needs the human comment carried on the arrival.
6. **The panel is a substantial new surface.** A modal over the run view with goal, "What to check", last handoff, history, transcript links, prior human rounds and a worktree diff.

## One-way doors

**Bundle compatibility** was the only one-way door. The owner answered it explicitly: **`conditional-v2`** (see row 14). No one-way door is left unratified.

## Decisions

### Run state & card

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| 1 | Card at a gate | What should the card offer when a human step is pending in Review? | `review-open`: keep the card in the Review column; show Open plus a neutral **Review** action that opens the human panel; suppress Done until `run.status === "done"`. The card stays neutral, not amber. `TaskCard`, the context menu and the PATCH guard change together. | owner (`round-1/answers.owner-paste.json#card-action`; accepted recommendation) |
| 2 | Run status | New `review` status, or reuse `blocked` / `running`? | New non-terminal `review` status mapped to the Review column. `endedAt` stays null until terminal. `persist` maps `review → review`. Every exhaustive `Record<PipelineRunStatus, …>`, the sanitizer, CLI/TUI labels and the card's Done guard gain the case. | owner (`round-1/answers.owner-paste.json#run-status`; accepted recommendation) |
| 3 | Fan-out | What pauses when one branch reaches a gate while siblings run? | `immediate-review`: the run status and column flip to `review` as soon as a gate arrives; live siblings keep running; the human can decide immediately; multiple gates are independent. After the gate resolves, the status returns to `running` while siblings remain. | owner (`round-1/answers.owner-paste.json#fanout`; override) |
| 4 | Accept targets | How is the next step chosen when the gate has several outgoing edges? | Reuse the step's `transition`: `choose` shows the outgoing steps and the human picks one; `all` launches every outgoing step; zero outgoing finishes the run. | owner (`round-1/answers.owner-paste.json#accept-targets`; accepted recommendation) |
| 5 | Blocked vs Review | Which status wins when a sibling is blocked and a gate is pending? | **Review wins while a gate is pending.** The block is surfaced in the run view, not by turning the card amber. A stopped/cancelled run still wins over Review; with no gate pending, the old blocked-wins rule applies. This deliberately departs from today's `deriveRunStatus` precedence and needs its own tests. | owner (`round-2/chat-answers.md#q3`) |
| 6 | Card Stop | Stop disappeared from the card because status is no longer `running`. What now? | Keep Review as the primary action and a secondary danger **Stop** whenever the run has live executions or a pending gate. Stop asks for confirmation, then cancels the run, dismisses the gate, preserves history and moves the card to Ready. | owner (`round-2/chat-answers.md#q2`) |

### Return

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| 7 | Return mechanics | Fresh re-run of the previous step, resume its session, or both? | **Both in v1.** A per-gate mode choice, default **fresh**. Fresh reuses `launchStep` with a new task/session and the normal handoff contract. Resume uses `sendInput` into the previous task's session after a spike into re-arming, settle/look-back and held state. Both paths must honor forced-return. If the spike cannot make resume deterministic, planning stops and returns to the owner rather than silently dropping it. | owner (`round-1/answers.owner-paste.json#return-mechanics`; override) + owner (`round-2/chat-answers.md#q1`) |
| 8 | Sticky return | How is the review loop guaranteed to come back to the same gate? | **Forced return.** The returned execution records `returnToStepId`; when it settles, the resolver takes that edge regardless of `transition`/`next`. Other outgoing edges of that execution are not launched. Both fresh and resume paths must honor it. If the previous step is `join:"all"` with several incoming edges, launch it directly and bypass the join wait, as manual Advance does. | owner (`round-1/answers.owner-paste.json#return-sticky`; accepted recommendation) |
| 9 | Incoming edges | May a gate have more than one incoming edge? | **Exactly one incoming.** Return is always unambiguous; no human join state, no arrival picker. The validator and editor reject more than one incoming. A branch that needs its own review gets its own gate. A fan-in gate is not possible in v1. | owner (`round-1/answers.owner-paste.json#incoming-edges`; accepted recommendation) |
| 10 | Return target | Which previous step does Return target? | The gate's sole incoming source; for a manual Advance into a gate, the step it was advanced from. | derived from decision 9 + owner (`round-1/answers.owner-paste.json#manual-advance`; accepted recommendation) |

### Panel & UX

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| 11 | Panel form | Modal, inline side panel, or full page? | **Modal/drawer over the run view**, opened from the human node, a run-view Review button and the card's Review action. No auto-open on arrival; the node highlights and a notification fires. Closing keeps the gate pending; a half-typed comment stays while the run view is open. | owner (`round-1/answers.owner-paste.json#panel-form`; accepted recommendation) |
| 12 | Panel content | What must the panel show? | **All seven:** pipeline goal; the human step's "What to check" instructions (read-only, never sent to an agent); the last arrival handoff; the run history; links to each completed step's transcript; prior human decisions on this gate; a "View changes" button for the shared worktree diff. | owner (`round-1/answers.owner-paste.json#panel-content`; accepted recommendation) |
| 13 | Escape hatches | What run-level actions remain while a gate is pending? | **Restart + Stop.** Restart confirms, clears the human state and history, and starts a fresh run. Stop confirms, cancels the run, dismisses the gate, keeps history and moves the card to Ready. Stop must work with no live executions. Retry/Advance/Done are hidden for the gate. | owner (`round-1/answers.owner-paste.json#pending-actions`; override) + owner (`round-2/chat-answers.md#q2`) |

### CLI & bundle

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| 14 | Bundle | How does a human step travel in an exported bundle? | **`conditional-v2`.** Human-free bundles stay version 1 and remain byte-identical. A bundle containing a human step writes version 2. The parser accepts versions 1 and 2. Old readers refuse v2 with the existing "update agetor" error. `BundleStep` gains `type`; export chooses the version from the selected pipelines; docs and tests move with it. | owner (`round-1/answers.owner-paste.json#bundle-compat`; override; one-way door answered) |
| 15 | CLI | How much CLI parity? | **Full.** `agetor pipeline review <ref> --accept\|--return --comment … [--next <step>] [--mode fresh\|resume]`; `show` and `status` display human gates and handle a nullable `taskId`; tests. The route is `app+cli` and gets a `ROUTE_POLICY` entry. | owner (`round-1/answers.owner-paste.json#cli-parity`; accepted recommendation) + decision 7 |

### Confirm list (all accepted as recommended)

| # | Topic | Decision | Source |
| --- | --- | --- | --- |
| 16 | Graph rules | Never the start step; exactly one incoming; no agent or subagents; no human→human edges; allowed at the end (terminal Accept finishes). Validator + editor enforce; a human step saves with `agentProfileId: null`, empty subagents and no Set-as-start. | owner (`round-1/answers.owner-paste.json#graph-rules`) |
| 17 | Comment rules | Trimmed; non-blank required for Return; optional for Accept; max 8,000 chars (`PIPELINE_LIMITS.handoffField`); terminal Accept needs none. Blank Return is rejected by the route and disabled in the UI. | owner (`round-1/answers.owner-paste.json#comment-rules`) |
| 18 | Trust | Human comments are trusted and rendered as a separate `## Human review feedback` section outside the untrusted-handoff markers. Agent handoffs stay fenced. The comment is stored on the human history record and carried on the pending launch/arrival, so it survives a blocked/retried Accept/Return; it is never folded into a `Handoff`. | owner (`round-1/answers.owner-paste.json#feedback-trust`) |
| 19 | Step cap | Human gate entries do not count toward `maxSteps`. They are recorded in history and shown in progress, but do not increment `stepCount`; entering a gate is never blocked by the cap. The Return re-run of the previous agent step still counts and bounds the loop. | owner (`round-1/answers.owner-paste.json#step-cap`) |
| 20 | Visual | Info-tinted border + "Human" chip + user-check icon; no "No agent" warning; no amber attention ring. The pending gate gets the same info highlight on the canvas and in the panel header; the run status chip reads "Review". | owner (`round-1/answers.owner-paste.json#visual`) |
| 21 | Editor | Add a "Human step" choice to Add step and a type switch in the step panel. Insertion between two steps uses the existing Add step + Connect to… flow; no one-click edge split. A human step cannot be Set as start. Switching agent→human clears agent/subagents; human→agent starts unbound; `deleteStep` never promotes a human step to start. | owner (`round-1/answers.owner-paste.json#editor-add`) |
| 22 | No third action | The panel has exactly two decisions: Return and Accept. No separate Reject/Stop/Escalate. Accept follows the outgoing edges and only finishes when there are none; abandoning the run stays Restart/Stop/archive/delete. | owner (`round-1/answers.owner-paste.json#no-third-action`) |
| 23 | Manual Advance | Advance may target a human step. It enters the gate with `handoff: null`; the panel shows "no handoff"; Return targets the step it was advanced from. | owner (`round-1/answers.owner-paste.json#manual-advance`) |
| 24 | Notifications | One "Pipeline needs your review" toast/OS notification per gate, deduped per run+gate seq. Clicking opens the run view with the gate selected. No "Pipeline finished" until a terminal Accept; the headless core mirrors the same rule. | owner (`round-1/answers.owner-paste.json#notify`) |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| `PipelineStep` type discriminator, validator, editor | in this change | Core of the feature. |
| New `review` run status + every exhaustive consumer | in this change | Decision 2; TypeScript will catch most, tests must cover the rest. |
| `PipelineRunState.humanSteps` pending state (step, seq, arrivals, comment/decision) + sanitizer + board-poll trim | in this change | The gate has no task row, so its state must live on the run and be sanitized/trimmed like the rest. |
| Nullable human `PipelineStepRecord.taskId` + every caller (run-view history, `stepTaskFor`/`stepNodeTaskFor`, `stepAttention`, `pipelineAttentionStepTask`, CLI `status`) | in this change | A human record has no task; the current CLI `status` crashes on `taskId.slice`. |
| `PipelineJoinArrival` / pending-block human-comment carry | in this change | An Accept into a `join:"all"` step or a blocked/retried launch must not lose the comment. |
| Card Review action, Done suppression, context menu, drag-to-Done guard | in this change | Decision 1; the current Done 409s. |
| Human panel modal + all seven content items + diff wiring | in this change | Decisions 11–12. |
| Human decision route, API client, CLI command, route policy | in this change | Decision 15. |
| Idempotent decision route (run + gate seq); stale/double submit returns 409, never launches twice | in this change | Two windows or a retried request must not launch the next step twice or record two decisions. |
| Fresh Return path | in this change | Decision 7. |
| Resume Return path + spike | in this change | Owner chose both in v1; the spike is the first task and a go/no-go. |
| Forced-return guarantee on both paths | in this change | Decision 8; the loop must be deterministic. |
| Single-incoming validation + editor | in this change | Decision 9. |
| Immediate-review status precedence + Review-wins-over-blocked | in this change | Decisions 3 and 5; audit every `review` consumer. |
| Card secondary Stop with confirmation | in this change | Decision 6. |
| Stop/cancel with no live work + history preserved | in this change | Decision 13. |
| Step-cap exemption for human entries | in this change | Decision 19. |
| Conditional bundle v2 + parser accepts 1 and 2 + import mapping/preview | in this change | Decision 14. |
| Manual Advance into a gate | in this change | Decision 23. |
| Trusted human-feedback prompt section + join/retry durability | in this change | Decision 18. |
| Board poll trims human arrival handoffs | in this change | Otherwise every 2s poll ships them; same treatment as history/joins. |
| `startPipelineRun` guard for `review`, Restart clears human state | in this change | A plain Run must not silently discard the gate. |
| Boot reconcile for a review run | in this change | A pending gate must survive an app restart. |
| Docs: `docs/architecture/pipelines.md`, `docs/plans/pipelines.md`, `README.md`, `docs/architecture/bundle.md`, `docs/architecture/notifications.md`, `docs/architecture/task-context-menu.md` | in this change | Repo rule: update the subsystem doc in the same change. |
| Unit + endpoint + e2e tests | in this change | Validation, status, prompt, sanitizer, trim, CLI, bundle, panel, pause/return/accept flow. |
| Multi-incoming fan-in gates | out of scope | Owner chose single-in; a separate ticket. |
| Auto-open the panel on arrival | out of scope | Owner chose no auto-open in decision 11. |
| Comment draft across app reload | out of scope | The modal only keeps it while the run view is open. |
| Third Reject/Stop panel action | out of scope | Owner confirmed exactly two decisions; Stop is run-level. |
| CLI `--to` for multi-incoming return target | out of scope | Single-in removes the need. |
| Human gate as a join collector | out of scope | Same as multi-incoming. |
| Bundle v1 downgrade support for human steps | out of scope | Conditional-v2 means old readers refuse; no downgrade path. |
| Separate human-step task row or transcript | out of scope | The design uses no task row; the panel's transcript links cover prior agent steps only. |
| PRD or design mock | not provided | The spec is the task text (`docs/specs/pipeline-human-step.md`); the optional mock upload was left blank. If a mock arrives later it can refine the panel, not block it. |
| Multi-tenant/auth | not applicable | Local single-user desktop app with loopback tokens. |

## Assumptions still open

1. **The raw paste is the answer evidence.** The form server was SIGTERM'd before writing `answers.json`; no canonical `answers.json` exists. If a schema-shaped file is required later, it can be generated from the paste, but the record cites the paste.
2. **`review` now outranks `blocked` while a gate is pending.** This reverses today's first rule in `deriveRunStatus`. The run view must make a sibling block impossible to miss; the card will not go amber. If the owner expected the block to dominate the card, this needs revisiting.
3. **Resume may not survive its spike.** If the resumed session cannot be re-armed and forced back to the gate deterministically, planning must stop and return to the owner. Do not silently drop resume.
4. **Default Return mode is fresh.** The owner chose both modes but not the default. Resume is opt-in per gate. If resume should be the default, flip it.
5. **No human-step task row.** Transcript links in the panel open prior agent step tasks only. If the owner expects a transcript of the human decision itself, the history record is the transcript.
6. **Status precedence is `cancelled (stopped) > review (gate pending) > blocked > running > done`.** The owner's "Review wins" settles review vs blocked; the stopped case is inferred from the Stop decision. A stopped run should not read Review.
7. **`review` can coexist with `run.active`.** Every consumer that assumed review means idle must be audited: `isTerminalRunStatus`, `hasLiveExecution`, `cancelPipelineRun`, `reconcilePipelineRuns`, `reviewActive`, `pipelineStepProgress`, the card's Stop, notifications and the CLI/TUI. The plan owns this audit.
8. **The resume path's forced-return guarantee is unproven.** The spike must show how a resumed session is made to hand off to the gate; otherwise the plan needs a guard or a fallback to fresh.
9. **The card's Stop confirmation copy and dialog are design details.** The plan will propose copy; the behavior (cancel, dismiss gate, keep history) is fixed.
10. **`pipelineStepProgress` shows the pending gate as the current step.** The exact label and whether the gate counts as "completed" are presentation details; decision 19 fixes the step-cap behavior.
11. **Conditional v2 is a dynamic export version.** `BUNDLE_VERSION` cannot remain a single export constant; export picks 1 or 2 from the selected pipelines, and the parser accepts both. If a future bundle adds another v2-only feature, the version rule needs revisiting.
12. **The optional mock was not supplied.** The panel layout follows the existing run-view visual language and the seven content items; a later mock can refine it.
