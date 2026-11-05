# Code review — Pipeline Human Step (round 4, re-review)

Reviewed the fix round as an uncommitted working tree on top of
`cdda5adcc7dcbfd7554fa0804223530e465b1fab` (5 commits, 58 files at that head)
against base `e4cc58e52f1520362022067708fead8a310bfe3a`. One read-only pass
over every changed file (committed feature + the fix diff) plus their callers,
the plan, and the subsystem docs. Re-ran:

- `bun run typecheck` — clean.
- 1,172 targeted tests across the plan's §5.4 suites (18 files, in three
  batches) — all pass.

**Not run:** the Playwright specs (the fix round's own
`test-results/.last-run.json` says `passed` with no failed tests; not
re-executed here), a repo-wide `bun test`, and no CI.

**Does:**
- The fix round carries a human Accept comment through every launch conversion
  (`previousToJoinArrival`/`joinArrivalToPrevious`/`pendingLaunch`), persists
  a Return's forced edge + feedback on the hold, and re-applies it in
  `retryPendingBlocks`, so a join/hold/retry can no longer drop a decision.
- Moves a Resume Return's `sendInput` outside the per-parent lock, with a
  counted in-flight marker that makes the re-armed execution a pending runner
  decision (so Stop still wins), a post-send confirm that cancels the turn it
  started, a rollback that only undoes a re-arm still owned by this send, and
  a second-gate refusal while a send is in flight.
- Restores the owner-decided card row (Open + primary Review + one secondary
  danger Stop), keys the review panel per gate, removes the review OS
  notification when the run leaves Review, trims comments from the board poll,
  adds the CLI usage/`show`/`ls` surfaces, and fills most of the R1–R21 test
  matrix.

**Needs attention:**
- The board poll still ships a *held* launch verbatim: `blocked[].pending`
  keeps the reviewed handoff, the arrival comment and `humanFeedback`, all
  outside the trimmer.
- A fan-out that opens two gates in one persist announces only the first
  gate; the second is marked announced and never gets a webview toast or OS
  notification.
- The headless notifier still drops pending-question/owed bookkeeping when a
  run enters Review, unlike the webview change made for exactly that case.
- The S6 race test cannot fail for the “late running event after the marker”
  behaviour it names: its stub never mints the resumed turn's run.

**Verdict: Comment.** No blockers and no must-fixes remain; the model,
validator, persistence sanitizers, bundle v2, runner gate entry, decision
idempotency, hold transport and the OUTSIDE-the-lock dispatch are sound and
well covered. The four should-fix items are bounded (payload,
notification surfacing, one regression test), but three of them contradict a
concrete claim the change makes about itself, so one short fix round is
warranted before merge.

| Severity | Count |
| --- | --- |
| BLOCKER | 0 |
| MUST-FIX | 0 |
| SHOULD-FIX | 4 |
| NIT | 2 |

### Claims vs the code

| Claim | Where made | What the code does |
| --- | --- | --- |
| “the webview and headless notifier each raise one ... alert per `(runStartedAt, gate.seq)`” | `docs/architecture/pipelines.md:389-391`; `src/bun/headless-notifications.test.ts:430` | Both consumers raise **one alert per event**, for `fresh[0]` only, and mark every fresh seq announced (`App.tsx:1739`, `headless-notifications.ts:400`). Two gates opened by one persist → one alert, second never announced (R-S2) |
| “human arrival handoffs must be nulled like history/joins or every 2s poll ships them” | plan `docs/plans/pipeline-human-step.md:411`; the fix's own N4 rationale at `server.ts:1109-1111` | `trimPipelineRunForList` trims history/joins/humanSteps only; `blocked[].pending` (handoff + comment + `humanFeedback`) rides every poll (R-S1) |
| “both race branches … plus late running events before/after the marker” | fix-round handoff | The test's send stub returns the addressed (old) run id and mints no run, so `stoppedRunId` equals `currentRunRow` with or without the new confirm assignment (R-S3) |
| Targeted suites green | fix-round handoff | Confirmed (typecheck + 1,172 tests) |
| human-step Playwright 5/5 | fix-round handoff | `test-results/.last-run.json` reports a pass; not re-run here |

### Re-review scorecard (previous round)

| Area | Fixed | Partial | Not fixed | Regressed |
| --- | --- | --- | --- | --- |
| Runner: comment/forced-edge transport (M1, M2) | ✔ | | | |
| Board card actions (M3) | ✔ | | | |
| Resume send outside the lock (M4; S6/S7 in the fix handoff) | ✔ | | | |
| CLI usage / `show` / `ls` (S1, S2) | ✔ | | | |
| `nextStepIds` acceptance rules (S3) | ✔ | | | |
| R1–R21 test coverage (S4) | ✔ | | | |
| One-shot harness resume proof (S5) | ✔ | | | |
| Per-gate panel (N1) | ✔ (one nit left) | | | |
| Gate notification removal (N2) | ✔ | | | |
| Stop-confirm copy (N3) | ✔ | | | |
| Board-poll trimming (N4) | | **partial** — `blocked[].pending` still ships | | |
| `stepCount` doc (N5) | ✔ | | | |
| Archived-parent gate → Review on unarchive (fix nit) | ✔ | | | |
| Multi-gate Playwright (fix nit) | ✔ | | | |

Fixed: M1, M2, M3, M4, S1, S2, S3, S4, S5, N1, N2, N3, N5 plus both fix-round
nits. Partial: N4 (see R-S1).

### SHOULD-FIX

**R-S1. The trimmed board poll still ships a held human decision in full: `blocked[].pending` keeps the handoff, the arrival comment and `humanFeedback`.**
`src/bun/server.ts:1108-1135`, `src/shared/types.ts:704-718`, call site
`src/bun/server.ts:5424`; the plan's own blast-radius note
`docs/plans/pipeline-human-step.md:411`.

`trimPipelineRunForList` narrows `snapshot.profiles`, `history[].handoff`,
`history[].human.comment`, `joins[].arrivals` and `humanSteps[].arrivals` — but
`blocked` is passed through by the `...run` spread. The fix round makes the
pending launch a comment/handoff carrier: `pending.arrivals[].handoff` is the
reviewed handoff (up to the handoff field caps), `pending.arrivals[].comment`
is the owner's Accept feedback, and `pending.humanFeedback` is the Return
comment (both up to 8,000 chars). All three now ride `GET /tasks` every 2 s
for every blocked pipeline parent.

Scenario: `A → H`, `maxSteps` reached, the owner Accepts `H` with a long
comment. `B`'s launch is held (`step-cap`) with `pending.humanFeedback` = B's
whole comment; the board poll ships that comment and the reviewed handoff to
every client twice a second until Retry — the exact payload N4 closed for
joins. (Same for a held fresh Return: `returnToStepId`/`returned`/
`humanFeedback`.)

Fix: trim `blocked[].pending` in the same helper — null `arrivals[].handoff`
and `arrivals[].comment`, drop `humanFeedback` — and add a unit test that a
blocked pending launch comes back trimmed. The single-run routes keep the full
state, as with the other fields.

**R-S2. Two gates opened by one persist announce only the first; the second is marked announced and never alerts.**
`src/mainview/App.tsx:1724-1741`, `src/bun/headless-notifications.ts:386-415`,
`docs/architecture/pipelines.md:389-391`.

Both consumers compute `fresh` (`newHumanGateSeqs`), then raise exactly one
alert for `fresh[0]` while storing **all** of `fresh` in the announced set. If
one `pipeline` event carries two new gate seqs, the second seq is permanently
treated as announced and no later event can raise it.

Scenario: `S` (`transition:"all"`) → `H1` and `H2` (two human gates; the
validator allows two human steps each with one incoming edge). `S` settles,
`advanceOnHandoff` enters both gates, then persists once — the event carries
`humanStepSeqs:[h1.seq, h2.seq]`. The owner sees one “Pipeline needs your
review” toast/OS banner whose Open target is `H1`; nothing ever announces
`H2`, so the only cue for the second gate is the run view's section. The doc
promises one alert per gate seq.

Fix: loop the fresh seqs and raise one alert per seq (the blocking-toast layer
already dedupes per task; the headless notifier posts one entry per task, so
decide explicitly whether the second is a second post or a single post naming
both). Add the `review([2,4])`-in-one-event case to
`headless-notifications.test.ts` and the equivalent App/toast test.

**R-S3. The S6 race test cannot fail for the behaviour it names — the resumed turn's run is never simulated.**
`src/bun/pipeline-runner.test.ts:6464-6589` (the send stub and the two
`handleColumnChange(aTaskId, "running")` calls).

The stub is `setReviewResumeSend(async (runId) => { …; return { delivered: true, runId } })`
and mints no run row or task `runId`. So `sent.runId` is the *previous,
settled* run id; `cancelPipelineRun` already wrote that same id to
`historyEntry.stoppedRunId`, and `currentRunRow(taskId)` returns that same run.
`isTurnSinceStop` therefore returns `false` for both “late running event”
assertions whether or not the confirm's
`execution.stoppedRunId = sent.runId` (`pipeline-runner.ts:2620-2624`) exists —
and whether or not the in-flight marker check
(`pipeline-runner.ts:4008-4011`) exists, because `cancelPipelineRun` already
stopped the “event” through the pre-existing old-run guard.

Scenario: the confirm assignment is deleted in a later refactor. The real
production path (claude/codex mint a new run id before/inside the send, so
`latest.id !== stoppedRunId` would read as a user resume and revive the
stopped run) breaks, but this test stays green.

Fix: inside the stub, mint a real run row for the step task (and point
`task.runId` at it) before resolving, so the late `running` event resolves to
the new run; then assert the run stays `cancelled` with and without the marker.
Also assert the marker path itself: with the send held, the event must be
ignored while `reviewResumeSendsInFlight` is set (the current test's stub
setup can't distinguish that).

**R-S4. The headless notifier drops a sibling's pending-question/owed state on the Review transition that the webview deliberately keeps.**
`src/bun/headless-notifications.ts:380-385` vs `src/mainview/App.tsx:1714-1723`.

The webview was changed to `if (ev.status !== "blocked" && ev.status !== "review")`
so a gate opening while a sibling step is still asking a question does not
forget that question. The headless handler still clears
`pendingByTarget.delete(ev.taskId)` and `owed.delete(ev.taskId)` for **every**
non-`blocked` status, Review included. Its own comment says it mirrors the
webview's `OwedPipelineAlerts`.

Scenario: step `C` asks a question (headless posts “Waiting on you” for the
parent; `pendingByTarget[parent]` holds it), then `B` settles into a gate
(`pipeline` event `review`). Headless forgets the question and posts the
review banner over the single per-task OS entry. When the owner accepts and
`C` is still pending, the run blocks; `hasPendingQuestion` now reads false, so
`headlessNotificationFor` posts the generic “Pipeline needs you” instead of
leaving the question cue, and any owed alert was dropped rather than raised
after the answer (`settleOwed` sees no `owed` entry).

Fix: mirror the webview condition in the headless handler (keep both maps on
`review`), and add a test: question pending → `review` event → the question
still suppresses the generic block notification when the run later blocks.

### NIT

- **R-N1** Closing the panel on a **non-primary** gate loses that gate's
  half-typed comment: `onClose` sets the key to `null`, so `panelGate` falls
  back to `primaryGate` and the `key` change unmounts the component whose
  draft the comment claims survives (`PipelineRunView.tsx:472-475`,
  `:1280-1290`). Remember the last opened gate while closed, or keep the panel
  mounted on the opened gate.
- **R-N2** `sanitizeJoinArrival` stores `comment` with no length cap while
  `sanitizeBlockPending` caps `humanFeedback` at `PIPELINE_LIMITS.handoffField`
  (`db.ts:532`, `:569-577`). A hand-edited or pre-cap row can put an unbounded
  comment into a join/pending arrival, the board poll and the next prompt.
  Cap it with the same limit.

### KEEP

- `previousToJoinArrival` / `joinArrivalToPrevious` plus `pendingLaunch` as the
  single transport pair for a human decision — every new arrival/hold mapping
  must go through them (`pipeline-runner.ts:1058-1091`).
- The out-of-lock dispatch with a re-acquire confirm/rollback that only undoes
  a re-arm still owned by this send (`pipeline-runner.ts:2600-2666`); the
  “still ours” checks are what make the release safe.
- `reviewResumeSendsInFlight` as a counted marker feeding
  `hasPendingStepDecision` (`pipeline-runner.ts:2293-2306`, `:806-811`), so
  Stop's “is anything running?” test sees the send.
- Per-gate panel identity (`stepId:seq`) instead of one boolean
  (`PipelineRunView.tsx:464-476`).
- The human branch in `launchStep` before archived/worktree/cap checks
  (`pipeline-runner.ts:1204-1214`), and `persist` skipping the column write
  while archived with `unarchiveTask` restoring Review for a pending gate
  (`pipeline-runner.ts:324-343`, `orchestrator.ts:9103-9111`).

### QUESTIONS

1. Stop during a Resume Return's send now wins: the confirm cancels the turn
   the send started and returns 409. Confirm that is the owner's intent (the
   previous fix-round handoff left this open).
2. The Return→Resume loop is still exempt from `maxSteps` (documented in
   `types.ts`, `stepCount`'s doc). Is that intended, or should a resumed
   Return count/cap separately? Owner confirmation has never been recorded.
3. A CLI-token caller (any process running as the user, including an agent)
   can post a review comment that the next prompt renders as trusted,
   authoritative feedback. Is that acceptable under the threat model, or
   should the framing change?
4. R-S2's fix needs an explicit product decision for the OS layer: two gates
   opened at once — one notification naming both, or two sequential banners
   (the task notifier keeps one entry per task, so the second would replace
   the first)?
