# Code review — Pipeline Human Step

Reviewed at head `cdda5adcc7dcbfd7554fa0804223530e465b1fab` against base
`e4cc58e52f1520362022067708fead8a310bfe3a` (5 commits, 58 files, ~5.4k
insertions). Read-only, one pass over every changed file plus the callers and
docs the change touches. Re-verified by hand: `bun run typecheck` clean; the
plan's targeted suites green (`src/shared/pipeline|bundle|bundle-import` 401
pass; `src/bun/pipelines|pipeline-runner|pipelines-endpoint|orchestrator|
route-policy|headless-notifications|pipeline-human-step-resume-spike` 359
pass; `src/mainview/lib/*` + `src/cli/*` 367 pass). **Not run:** the
Playwright e2e specs (claimed green by the implementer), and a full repo-wide
`bun test` (started, stopped after ~13 min still running the integration
files, no failures observed before the stop).

**Does:**
- Adds `PipelineStep.type: "human"` — a gate with no agent/subagents, exactly
  one incoming edge, never the start step, no human→human edge; it is entered
  by the ordinary `launchStep` path and parks the run in a new non-terminal
  `review` status mapped to the Review column.
- Adds `reviewHumanStep` behind `POST /tasks/:id/pipeline/review`: Accept
  follows the gate's transition (comment optional, carried as trusted
  `PipelineJoinArrival.comment` into `## Human review feedback`), Return
  re-runs the sole incoming source fresh or resumed and forces the re-run back
  to the gate via `returnToStepId`.
- Ships the launcher, stop/restart/reconcile, card/context-menu/toast wiring,
  the run-view `HumanStepPanel`, CLI `pipeline review` + status rendering,
  conditional bundle v2, headless notifications, e2e specs and docs.

**Needs attention:**
- Human Accept feedback is silently lost on two normal paths: a join target
  that completes from a *sibling* branch, and any run-level hold + Retry
  (step cap, worktree, archived parent, launch throw). The plan (R6) says the
  retry carries the comment; it does not.
- A Return whose launch is held loses `returnToStepId`/`returned`, so the
  Retry can re-run the step and settle to a *different* outgoing step,
  bypassing the review gate entirely.
- The board card at a gate renders Stop as the primary action **twice** and
  Review third, with no Open — contradicting the owner's round-1
  "Open + Review" and round-2 "Review primary, danger Stop secondary"
  decisions and plan success criterion #3.
- The resume Return awaits an unbounded `sendInput` while holding the
  per-parent lock — the exact pattern the runner already documents as L-R7
  and deliberately avoids for handoff reminders.

**Verdict: Request changes.** The model, validator, persistence sanitizers,
bundle v2, runner gate entry, idempotent decision and the UI wiring are solid
and well tested. The defects above are all in the *transport* of a decision
across a hold/join and in the card's action row; fix those plus the CLI/test
gaps before merge.

| Severity | Count |
| --- | --- |
| BLOCKER | 0 |
| MUST-FIX | 4 |
| SHOULD-FIX | 5 |
| NIT | 5 |

### Claims vs the code

| Claim | Where made | What the code does |
| --- | --- | --- |
| The card offers **Open + Review**, Done suppressed | plan §1 criterion 3, `T10` C1, grill round-1 `card-action` | No Open while a gate is pending; two Stop buttons; Review is a third, outline button (`TaskCard.tsx:365-393`) |
| "Review as the primary action and a danger Stop as a secondary action" | grill round-2 Q2 | Stop is the primary destructive action (rendered twice); Review is secondary |
| "a retry after a step-cap or launch-failure hold carries the same comment (via `pending.arrivals[].comment`)" | plan `T4` R6 | The comment is stored on the hold but dropped by `retryPendingBlocks` and the other arrival mappings (M1) |
| `status`/`show` print pending gates and `(human)` for a null task id | `docs/architecture/pipelines.md` §11 "Surfaces" | `pipeline status` does; `show` prints neither (S2) |
| T0 proved resume for `claude-code` **and at least one one-shot harness** | plan `T0` | Only the fake claude driver ran; the spike doc records the deviation (S5) |
| Targeted suites green | plan §11 | Confirmed by re-running them |
| E2E green (4 + 14 + 28) | plan §11 | Not re-run here |

### MUST-FIX

**M1. A human Accept comment is silently dropped when the target launches
through a join completed by a sibling, or through any run-level hold and its
Retry.**
`src/bun/pipeline-runner.ts:1041` (archived hold), `:1416` (`launchTarget`
catch), `:1553` (`retryPendingBlocks`), `:3147` (stopped-run hold), `:3278`
(join completion in `advanceOnHandoff`); `src/shared/types.ts:700` (the
pending-block shape).

`PreviousArrival` carries `comment` and the accept path maps it correctly
(`:1119`, `:2320`), and the gate→join accept stores it on
`run.joins[].arrivals` (`:2339`). Every other conversion back to a launch
rebuilds the arrival as `{ fromStepId/fstepId, seq, handoff }` and drops
`comment`. Three of those convert a *stored* pending/join arrival:

- `retryPendingBlocks` maps `pending.arrivals` without `comment`, then calls
  `launchTarget`, whose prompt feedback is built from `p.comment`.
- `holdForArchivedParent`, `holdForStoppedRun` and `launchTarget`'s catch
  build the pending block from `previous` without `comment` (the step-cap /
  worktree / profile holds in `launchStep` do keep it, so the round trip
  still loses it).
- `advanceOnHandoff`'s join branches map `arrivals` without `comment` before
  launching a join that another branch just completed.

Scenario: `A → H`, `H → D(join:"all")`, `C → D`. The owner accepts `H` with
"tighten the header" while `C` is still running; the comment is stored in
`run.joins[D]`. `C` settles, completes the join, and `D` launches with a
prompt that has **no** `## Human review feedback` — the step runs without the
review it exists to implement. Same loss for an accept that hits the step cap
or a worktree/launch failure and is completed by Retry.

Fix: carry `comment` in every `PipelineJoinArrival` → `PreviousArrival`
mapping (including the pending-block mapping and `retryPendingBlocks`), and
add a runner test for "accept into a join completed later" and "accept →
step-cap hold → retry" that asserts the prompt contains the comment.

**M2. A Return whose launch is held loses the forced return edge, so the Retry
can settle to another outgoing step and bypass the gate.**
`src/bun/pipeline-runner.ts:1155-1190` (the holds), `:1410-1420` (catch),
`:1553-1561` (retry re-launch), `:2374-2379` (the only place the options are
passed); `src/shared/types.ts:700` has no field for them.

`reviewHumanStep`'s fresh Return launches with
`{ returnToStepId, returned, humanFeedback }`. If that launch is held before
an active row exists (step cap, worktree refresh failure, profile-missing,
launch throw, archived parent), the hold stores only `{ stepId, arrivals }`.
`retryPendingBlocks` re-launches it with `{ skipWorktreeRefresh: true }` and
no options, so the new execution carries no `returnToStepId` and
`settleStepRun` resolves the graph/handoff normally — and the comment/
returned copy is gone too (M1).

Scenario: a `choose` step `A` with edges to `H` and `B`; `A → H`; the owner
Returns `A`; `run.stepCount` is at `maxSteps` (the documented R17 case), so
the re-launch is held as `step-cap`; the owner clicks Retry; `A` re-runs
without the forced edge, its handoff names `B`, and `B` launches — the gate
never re-opens and the Return is silently discarded.

Fix: persist the launch options on the pending block (e.g.
`pending.returnToStepId` / `pending.returned` / `pending.humanFeedback`) or on
the history record, and re-apply them in `retryPendingBlocks`; test
"return → step-cap hold → retry → gate re-opens".

**M3. At a gate the board card shows Stop twice and Review third, with no
Open — the opposite of the owner's decision.**
`src/mainview/components/kanban/TaskCard.tsx:125-127` (`stoppable` includes
`gatePending`), `:365` (primary destructive Stop wins the action ternary),
`:378` (the icon Stop also renders for `gatePending`), `:385-393` (Review,
outline), `:394` (Done correctly suppressed).

The owner chose **Open + Review, Done suppressed** (grill round-1
`card-action`) and **Review as the primary action with a danger Stop as the
secondary** (round-2 Q2); plan success criteria #3/C1 repeat "Open + Review".
The code has `gatePending → stoppable`, so the first branch is the destructive
Stop, and the `(awaiting || gatePending) && stoppable` icon button adds a
second Stop. Only pressing the card body (which opens the run view *without*
the gate focused) or the third button gets the user to the review.

Scenario: any pipeline parent parked at a gate with no sibling question — the
card renders `[Stop] [⏹] [Review]`; two identical Stops and no Open, and
"Review" is visually the least prominent action on the one card that needs it.

Fix: when `gatePending`, render Review as the primary (neutral) action, one
neutral Open, and a single secondary destructive Stop; keep the icon Stop only
for `awaiting && !gatePending`. Update `e2e/pipelines-human-step.spec.ts`
(it currently locates the icon via `button[title="Stop"]`) to pin Open +
Review and exactly one Stop.

**M4. The resume Return holds the per-parent lock across an unbounded
`sendInput`, repeating the L-R7 lesson recorded in this same file.**
`src/bun/pipeline-runner.ts:2432` inside the `runExclusive` body.

The runner's own reminder code documents that `sendInput` "can hold for
several seconds (a claude paste awaits its outcome, bounded by a 5 s race; a
one-shot harness's spawn is raced against `SPAWN_RESPONSE_BUDGET_MS`), and
every other settle/route mutation for the same parent would otherwise queue
behind it" — and deliberately sends outside the lock (`deliverHandoffReminder`
/ `recheckReminder`). `reviewHumanStep` calls it with no `bounded`, so the
whole inner send (floor probe, teardown wait, worktree restore, `@`-expansion,
the paste) runs while the parent lock is held.

Scenario: a fan-out sibling is live when the owner picks Resume; while the
paste is in flight the sibling settles and its settle (which would launch the
next step) queues; a Stop or Advance issued meanwhile queues too. The board's
pipeline state for that parent stalls for the duration (seconds on claude, up
to a spawn budget on one-shot harnesses), and the review request itself is
held open for the same time.

Fix: persist the re-arm, release the lock, send, then re-acquire to confirm or
roll back — or pass `bounded: true` and treat `pending: true` as delivered
(today `bounded` would return `{ delivered: true, pending: true }`, so the
rollback must key on an explicit `delivered: false`). Add a test that another
mutation for the same parent completes while the resume send is in flight.

### SHOULD-FIX

**S1. `agetor pipeline review` has no usage entry.** `src/cli/usage.ts:300`
(the `pipeline` synopsis omits `review`) and `:314-356` (no
`"pipeline review"` block). `usageError("pipeline review")` therefore returns
`unknown command: pipeline review` for a bad flag combination
(`pipeline.ts:132-147`) — e.g. `--return` without `--comment` says "unknown
command" instead of telling the user a comment is required. Add the block,
list the subcommand in the pipeline synopsis, and mention the pending-gate
output in `pipeline status`'s copy.

**S2. `docs/architecture/pipelines.md` §11 says `status`/`show` print pending
gates; `show` does not.** `src/cli/commands/show.ts:75-88` prints the run
status/progress and blocks only; only `pipeline status`
(`src/cli/commands/pipeline.ts:591-600`) prints gates. Either print them in
`show` (with `agetor pipeline review <ref>`) or correct the doc; also consider
a `needs` hint in `agetor ls` (`src/cli/commands/ls.ts:166` currently hints
only `pipeline blocked`).

**S3. Accept silently ignores `nextStepIds` unless the gate is `choose` with
2+ outgoing edges.** `src/bun/pipeline-runner.ts:2273-2290` resolves targets by
`transition` and never rejects a supplied `nextStepIds` on an `all` or
single-edge gate. `agetor pipeline review --accept --next X`
(`src/cli/commands/pipeline.ts:146-160`) therefore launches *every* outgoing
step (or the sole one) instead of `X`, with no error. Reject
`nextStepIds` when it cannot be honored (400), or honor it for `all`; test
both.

**S4. Coverage is well below the plan's own `T4` R1–R20 / `T2` acceptance.**
`src/bun/pipeline-runner.test.ts` covers gate entry, terminal accept,
accept→next, return-fresh, validation/idempotency, stop, restart and forced
return. Missing: accept into an incomplete join (R6), accept target rules
(R7), the step-cap exemption across a gate (R17), reconcile on a review run
(R20), an archived-parent gate (R21), resume rollback on a refused send (R11),
immediate-review beats blocked at the runner level (R2/R3), and — in
`src/shared/bundle-import.test.ts` — that a human step raises no
"step has no Agent" warning and previews as Human (T2). The M1/M2 defects sit
exactly in those untested paths.

**S5. T0's go/no-go gate required a one-shot harness proof; only the fake
claude driver ran.** `src/bun/pipeline-human-step-resume-spike.test.ts` sets
`AGETOR_CLAUDE_DRIVER=fake` only, and
`docs/plans/pipeline-human-step-resume-spike.md` records the deviation. The
plan said a one-shot harness (codex fake) had to be proven or the spike
records a failure and planning stops; `mode: "resume"` now ships for every
harness. Add the codex-fake case (the settle path is harness-agnostic, so it
should pass), or gate Resume in the panel/CLI to proven harnesses.

### NIT

- **N1** With two pending gates, every "Open review" button in the run view
  calls the same `setHumanPanelOpen(true)`, and the panel is bound to
  `primaryGate` — so a second gate's card opens the first gate's panel
  (`PipelineRunView.tsx:1096-1130`, `:1266-1279`).
- **N2** The review OS notification (`kind: "blocked"`) is never removed when
  the gate is decided: `removalForEvent` only fires on a `column` leaving
  `blocked` or an answered interaction (`src/bun/notification-hooks.ts:70-80`),
  and a gate moves `running → review → running`, so the banner lingers in
  Notification Center until the next notification for the task replaces it.
- **N3** `PipelineRunView.handleStop`'s confirm always says "the pending review
  dismissed", including for a running pipeline with no gate
  (`PipelineRunView.tsx:778-787`).
- **N4** `trimPipelineRunForList` keeps `joins[].arrivals[].comment` (up to
  8,000 chars) on the 2 s `GET /tasks` poll while nulling handoffs
  (`src/bun/server.ts:1112-1121`); a gate's Accept comment can ride that path.
- **N5** `src/shared/types.ts:872-873` still documents `stepCount` as "Total
  executions started this run"; a resumed execution starts a new run row and
  a new history record but does not increment it (see Q1).

### KEEP

- `validatePipelineGraph` as the single authority for the gate's graph rules,
  with `newStep` applying the human normalization *after* the spread so a
  caller cannot build a shape the validator rejects
  (`src/shared/pipeline.ts:360-371`, `:451-460`, `:638-670`).
- The human feedback block rendered **outside** the untrusted-handoff markers
  and after the step's instructions (`src/shared/pipeline.ts:1384-1400`);
  `Handoff` never carries it.
- Gate removal + decision recorded in one critical section under
  `runExclusive`, so `stepId`+`seq` is a real idempotency key
  (`src/bun/pipeline-runner.ts:2226-2305`).
- The human branch in `launchStep` placed before the archived/worktree/step-cap
  checks, so a gate costs no worktree, no profile and no step count
  (`src/bun/pipeline-runner.ts:1136-1141`).
- `reconcilePipelineRuns` sweeping a review run only while it still has active
  executions, so a gate-only run can never be flipped to done
  (`src/bun/pipeline-runner.ts:3951-3959`).

### QUESTIONS

1. Should a **resumed** Return count toward `maxSteps`? Today it creates a new
   run row and history record but leaves `stepCount` unchanged (pinned by the
   spike test), so repeated Return→Resume loops never trip the cap while fresh
   Returns do. If that is intended, update `PipelineRunState.stepCount`'s doc;
   if not, increment it (or cap resume loops separately).
2. The route is `app+cli` (full CLI parity was an owner decision), and the
   repo's own docs say any process running as the user — an agent included —
   can read the CLI token. The comment is then rendered as *"authoritative —
   follow it"* in the next step's prompt, while agent handoffs are fenced as
   untrusted. Is a CLI-token caller posting "human" guidance acceptable under
   the threat model, or should that framing change?
3. The two owner answers combine to three card actions (Open + Review + a
   secondary danger Stop). Confirm the intended final row so the M3 fix does
   not undo round-2 Q2.
4. Is shipping `resume` for unproven harnesses acceptable (S5), or should the
   panel/CLI gate it per harness until each is exercised?
