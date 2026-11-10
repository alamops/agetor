# Harness account stacks

A **harness stack** is an ordered group of two or more accounts of the **same
harness kind** (Claude Code or Codex). Position 0 is the **primary**; the rest
are **backups**. When the account a task is running on hits its provider limit,
the task continues on the next account with the same conversation, tools, MCP
servers, skills, commands, plugins and settings. A visible divider appears
between the task's messages and the execution keeps going — the card never
leaves `running`.

Stacks are machine-local and opt-in. There is **no global flag**: with no
stack, every path below is inert, and deleting the stack is the rollback.

Plan and decisions: `docs/plans/harness-account-stacks.md` (binding),
`docs/plans/harness-account-stacks-grill.md` (owner decisions),
`docs/plans/harness-account-stacks-codex-spike.md` (T00 evidence). The fix round
(per-model cooldowns, mirror provenance, swap history, switch to next account,
the merged Harnesses page) is `docs/plans/harness-stacks-fix-round.md`.

## Model

| Table / column | Purpose |
| --- | --- |
| `harness_stacks` | `id`, `label`, `kind` (`claude-code`/`codex`), `mirror_mode` (`full`/`safe`), timestamps. |
| `harness_stack_members` | `(stack_id, harness_id, position)`. `UNIQUE(harness_id)` enforces **one stack per account**; `UNIQUE(stack_id, position)` keeps the order unique. Cascades with its stack but has **no FK to `harnesses`** (migration 085): a `harnesses` table rebuild would otherwise cascade every membership away. `harnesses.delete` removes the account's row explicitly and re-packs the ranks. |
| `harness_limit_state` | Cooldown rows keyed by `(harness_id, model)` (migration 087); `model = ''` is the whole account, a model id (lower-cased) is a provider limit scoped to that model. Columns: reason, source, message, `exhausted_until_ms`, `updated_at`. Deliberately has **no FK** and survives a stack delete — a limit is a fact about the account. |
| `harness_swap_events` | The per-stack swap history (see [Swap history](#swap-history)). `stack_id` is an FK with `ON DELETE CASCADE` and it is the **only** FK: task and account ids are plain columns and the labels and task title are denormalized, so a row survives a task or account delete and goes only with its stack. |
| `harness_mirror_provenance` | What a mirror run wrote into a backup, `(harness_id, path, key)` → scope (`file`/`key`/`link`), value hash, source mtime/size, `preexisted`, `backup_ref`. **No FK**; rows are untrusted on use (see [Mirror provenance, backups, preview and Restore](#mirror-provenance-backups-preview-and-restore)). |
| `harness_session_handoffs` | `(task_id, harness_id, column_name)` → copied session id + `copied_paths_json` (the cleanup allowlist). The one exception to per-account session scoping. |
| `tasks.harness_state` | `TaskHarnessState` JSON: `stackId`, `position`, `count`, `tried[]`, `pendingSwap`, `allExhausted` (`attempts`, `inFlight`, `nextAttemptAt`, `earliestResetAtMs`, `reason`, plus `cleanRetryOf` and `memberReasons`), `lastMove` (`reason` is `member-removed`, `member-disabled`, `member-unavailable`, `manual-switch` or `switch-now`) and `scheduledSwitch` (`{ requestedAt }`). Server-managed (targeted UPDATE, no `updated_at`, skipped by the generic PATCH clause). Every optional field is omitted when absent, so older state still parses. |

A task's stack is **derived** from `Task.agent` (`harnessStacks.resolveForTask`):
the account's CURRENT membership wins, so editing an account into another stack
moves its tasks' failover there; the recorded `harnessState.stackId` is only the
fallback while an account removed from every stack still resolves (marked
`orphaned`) until the next move. No `Task`, `AgentProfile`, pipeline or bundle
field references a stack, so profiles and pipelines inherit the stack
automatically and bundles stay portable.

A stack with fewer than two members is **inert** (plan assumption 6): the
editor and `validateInput` require at least one member but allow saving the
shell before backups are added, and selection, failover, automatic retries and
the Claude pane limit signal all require a real backup. A task on such a stack
behaves exactly like a lone account. That includes a Run or message
(`prepareTaskHarness` returns at once for a stack of fewer than two members and
clears a stale failover state and armed retry left from when it had a backup),
so the normal pre-flight error is what the user sees.

## Selection: one lap, then wrap

`pickNextMember` (`src/shared/harness-stack.ts`) walks **forward** from the
current account and wraps once. A member is skipped — and **not** marked tried —
when it is:

- already in `tried` (it ended a run in a limit this lap);
- disabled;
- cooling for this task's model (`harnessStacks.isCooling(id, now, model)`: the
  account-wide row, or the row of the task's resolved model, whichever expires
  later; the model is `task.model ?? DEFAULT_MODEL[kind]`, lower-cased by
  `cooldownModelFor`, so a per-model Codex limit cools only tasks on that
  model);
- quota-exhausted by a fresh `HarnessQuota` snapshot
  (`harnessQuotaLooksExhausted`; stale (older than 20 min), missing or
  non-`ok` fails open). The rule: **any** blocking window (`five_hour`,
  `session`, `seven_day`, `weekly`, `weekly_all`; model-scoped weeklies and the
  routines meter never block) at 100% with an unexpired reset, **unless** a
  credits meter (`extra_usage`, `credits`) still has headroom. The reset used
  for the retry timer (`harnessQuotaResetAt`) is the **latest** reset among the
  exhausted windows, because the account stays blocked until the last one
  resets. The Codex usage meter reports a `credits` balance of zero or less as
  100% (`src/bun/usage/codex-usage.ts`);
- unusable for the task's model/CLI (not installed, login evidence `false`,
  known model catalog excludes the model, cached CLI below the model floor).
  The model is the one the turn would really run: a task with no explicit model
  resolves to `DEFAULT_MODEL[kind]` exactly as `startTask` does, so a backup
  that cannot serve the default model is skipped too. The catalog is the
  per-harness list for fx, Codex and OpenCode and the kind-level list for
  everything else (Claude included).

A successful or cancelled terminal turn resets the lap; a manual Run also resets
it and forces a cooling account. The walk returns `next`, `all-exhausted`
(something is limit-blocked and a reset can help) or `none-usable` (only a
manual fix can help). A **complete lap** — every member already in `tried` —
is `all-exhausted` even when a cooldown has already expired: every one of
those accounts ended a run in a limit, so the retry restarts a fresh lap (with
its earliest reset when one is still known, otherwise the backoff). This is
the two-account sequential-limit path; it must never fall through to
`none-usable`, which arms no timer and blocks forever.

A **tried member whose cooldown has expired** (and whose quota is not
exhausted, and that is otherwise usable) is available again: the plan's
earliest reset becomes `now`, so the retry fires at the retry-wait floor
instead of waiting for another member's far-off reset. A tried member that has
since logged out or cannot run the model schedules nothing early.

`planManualSwitchTarget(task)` (used by [Switch to next
account](#switch-to-next-account)) is a pure variant of the same walk: it
starts after the current account, wraps, treats only the current account as
tried, ignores the task's `tried` list, and writes no state. `memberReasonsFor`
gives the per-member text ("cooling until 15:00 for gpt-5.6", "quota exhausted
until …", "logged out", "disabled", "tried this lap", "available") that
banners, refusals and `allExhausted.memberReasons` show.

## Limits: conservative by design

`classifyHarnessLimitSignal` (`src/shared/harness-limits.ts`) accepts only
provider quota, HTTP 429 and 402/insufficient credits. Explicit negatives:
5xx/529/`overloaded`, network/timeouts, 401/403/auth, `model_not_found` and
"not supported/available". A false swap would burn a backup and can duplicate
work, so the classifier is a table-tested allowlist, not a heuristic on "error".

Writers:

- **Claude pane** — on a stack task **with a backup** (two or more members),
  `scrapeOnce` emits one `harness-limit:` status for the live usage-limit
  notice, then resolves the turn. The notice is read relative to the input box
  (the last pair of `─` border rows around the `❯` row): only the hint slot —
  at most four non-blank rows directly above the box, the upward walk stopping
  at any transcript/tool gutter row (`⎿`, `│`, `|`, `>`, `⏺`, `●`, `❯`), at
  the spinner row (`✻ Thinking…`) and at a glyph-less row that continues a
  transcript entry (contiguous with a `⎿`/`⏺` row, no blank line between) — or the
  footer below it counts, and the head row may start only with indentation or
  an optional `⚠`. So a notice quoted in the scrollback, echoed in a tool
  result or typed into the input box never settles a healthy turn; with no
  input box on the pane nothing matches. Accepted wordings: `Usage limit
  reached · continuing automatically …` (and `… reached again …`), the
  standalone `Continuing automatically <when> · Esc to cancel`, `Usage limit
  reached · limit resets <t>`, the bare `Usage limit reached`, and `You've hit
  your limit · resets <t>`. The grace-window `Usage limit reached · wrapping up`
  counts only once the turn has stopped (Claude keeps working through the
  grace), and the usage-credits wrap-up never counts (credits keep the account
  working). The detection window is also what is stored, so a reset time that
  wraps keeps its parsed instant. A per-turn latch prevents re-emitting while
  the notice stays on screen. A lone account (no stack, or a 0/1-member stack) is
  inert: the notice is not carded and Claude's own auto-continue keeps the turn
  in flight, exactly as before stacks existed (plan §2.2).
- **Claude API error** — the existing synthetic `api error:` line remains; the
  orchestrator's chunk handler classifies 429/402 as a backstop, gated on that
  sentinel. Arbitrary status prose (a compaction/background summary, an account
  label that merely contains "rate limit", …) is never classified, so a healthy
  turn cannot be mistaken for a limit and swapped. When that API error *is* a
  provider limit on a stack with a backup, the swap owns the settlement: the
  card stays `running` and no `api-error` block (or its sticky retry toast/OS
  notification) is painted before the successor starts.
- **Codex** — only a terminal `turn.failed` emits the structured signal, from
  its own message or from the classification remembered from the last
  top-level `error`. A top-level `error` alone, an `error` item and a non-JSON
  log line never signal, and `turn.completed`/`turn.started` or any `item.*`
  event discard a remembered one (so a retried 429 never attaches to a later,
  unrelated failure). A codex that exits without `turn.completed`/`turn.failed`
  while a limit is remembered emits that limit instead of the "ended
  unexpectedly" sentinel; the orchestrator never classifies raw codex text and ignores
  a codex limit on a run that exited 0 (`limitSignalForSettle`). So a 429 that
  codex retried and recovered from — or an MCP tool error mentioning 429 — is
  never a limit. Codex 0.166 reports quota in prose: "You've hit your usage
  limit. … or try again at <date> <time>" (quota) and "Quota exceeded. Check
  your plan and billing details." (out of credits); the classifier matches that
  prose plus the snake_case codes (`usage_limit_reached`/`_exceeded`,
  `workspace_*_credits_depleted`, `rate_limit_exceeded`, …) and honours a
  structured `codex_error_info`/`error.code`/`error.type` (a known non-limit
  code is a definitive negative).
- **Reset times** — `parseClaudeResetNotice` reads the time after `resets` /
  `until` / `at` / `try again at`, date-first or time-first (`Nov 10, 3pm`,
  `Tue, Nov 10, 9:30am`, Codex's `Nov 10th, 2026 3:00 PM`, `3pm on Nov 12`,
  weekdays, `15:00`). A dated reset resolves to that date (a past one is
  null), a weekday to its next occurrence, a passed time-only reset to the next
  calendar day (DST-safe), and anything over 31 days out is null. A time-only
  (or same-day weekday) reset that passed **less than an hour ago** is a limit
  that just expired, not tomorrow's: it reads as null, so the caller's short
  fallback cooldown applies instead of a day-long wait.
- **Per-model Codex limit** — "You've hit your usage limit for <model>." is
  scoped to that model: `parseLimitedModel` returns the id (lower-cased; the
  candidate must contain a digit or hyphen, so "usage limit for your plan."
  never parses as a model) and the signal carries `model`. The cooldown row is
  then keyed `(account, model)`, and only tasks whose resolved model matches
  skip the account. Every other phrasing is account-wide.
- **Fake drivers** — `__agetor_fake_claude_limit__`,
  `__agetor_fake_claude_limit_clean__`, `__agetor_fake_claude_limit_pane__`
  (the pane-sourced variant used by the passthrough session-drop test),
  `__agetor_fake_codex_limit__` (and the `AGETOR_FAKE_*_LIMIT` env twins) drive
  the e2e/unit paths. The fake codex limit emits the real prose ("You've hit
  your usage limit. Upgrade to Plus … or try again at 3:00 PM.") and exits 1,
  like the CLI on `turn.failed`.

The cooldown is account-global: `harnessStacks.setLimitState`, one row per
`(account, model)`. Its expiry is the provider reset when the driver parsed
one, else 60 s for a rate limit and 10 min for quota/credits. A provider reset
replaces the stored expiry of that row even when it is earlier; a fallback
(signal with no reset time) never shortens a still-active later provider reset
on the same row. The reads (`getLimitState`, `isCooling`) take the task's model
and return the account-wide row or that model's row, whichever expires later;
`listLimitStates` returns every active row.

What clears a cooldown:

- **A successful turn clears only what it can disprove.** The settle calls
  `clearLimitState(account, { startedAtMs: run.startedAt, model })`, which
  deletes rows of the account-wide key and the turn's model whose `updated_at`
  is at or before the turn's start. A limit another task recorded while this
  turn ran is newer evidence and survives.
- **A Codex turn that hit a remembered 429 but still completed** (exit 0)
  clears exactly the row its own chunk handler stored (`limitRecorded`: key and
  `updatedAt`), and only while that row is still the stored one; a newer
  overwrite is never touched.
- **The explicit "Clear cooldown" action** (`DELETE /harnesses/:id/limit-state`):
  `?model=<id>` deletes just that model's row, `?scope=account` just the
  account-wide row, and no parameter every row of the account (`?model=` wins
  over `?scope=`). It does not change what the provider will accept: the confirm
  text says so. Afterwards `rearmRetriesAfterCooldownClear` walks the tasks
  waiting out a limit on a stack that contains the account (an `allExhausted`
  that is not `inFlight`, not `no-usable-member`, under the attempt cap, not
  archived): it refreshes their `memberReasons`, re-arms the countdown one retry
  floor (`retryMinMs()`) out without spending an attempt, and writes a "cooldown
  cleared on <account> — retrying soon" status line. The response is `{ cleared,
  rearmed, limitStates }`, `rearmed` being the number of tasks re-armed. The
  Settings account-wide chip clears only the account-wide row and a per-model
  chip only that model's.
- Expiry, and the harness delete.

A manual Run/message forces a cooling account **for that task only** and never
deletes the account-global cooldown: another task may still be probing an
account the provider has not reset, so only a successful turn, the reset or the
explicit clear removes it.

## Settlement and the swap

`attachDoneHandler` checks `ActiveRun.limitHit` before normal settlement. On a
stack task it hands everything to `handleHarnessLimitSettlement`
(`src/bun/orchestrator.ts`):

1. The task's start claim is taken before any await (no competing turn). If a
   claim is already held when a limit lands, what happens depends on whose it
   is. When it is **this task's own swap window or boot swap claim** (a
   successor limited while its held follow-ups were still being delivered, or
   the boot reconcile owns the task), the signal is queued
   (`deferredLimitSettlements`), the run stays `running` with a status line
   ("switching once the current switch settles"), and the settlement re-runs as
   soon as the claim is released, so the run's column is decided exactly once
   and no second successor is minted beside the one the window finishes. When
   the claim is any other (a manual start, a same-stack account switch), the
   run takes the **normal** failed settle like a lone account's limit
   (status, column, queued follow-up drain). A run is never recorded failed
   with its column undecided.
2. The current account is marked tried and cooled.
3. Pending interaction cards are cancelled; the limited session is dropped; any
   running background agents are orphaned with a status line naming them. A
   requested "switch to next account" (`scheduledSwitch`) is consumed here: the
   failover moves or blocks the task anyway, so there is no second move.
4. `planNextMember` picks the successor.
5. `pendingSwap` is persisted before the mirror/transfer starts (crash
   safety); the earlier teardown awaits are idempotent. If launches are frozen
   (the port is being handed to another core) the swap stops here: the old run
   is recorded failed with `reason: "harness-swap"`, the card stays `running`
   and the persisted intent is left for the next owner's boot.
6. The move itself is `executeStackSwap` → `moveTaskToMember`
   (`src/bun/harness-failover.ts`), the one implementation every account move
   shares (this settlement, the all-exhausted retry, the manual prepare move,
   the same-stack PATCH switch and the boot manual switch); each caller keeps
   its own failure policy. It runs `mirrorForSwap(stack, toHarnessId)` (a
   `mirrorStack` wrapper with the destination account, single-flight per
   destination), then the transfer, then commits `Task.agent` and the state;
   mirror/transfer warnings come back as status lines. A mirror failure is a
   warning, never a block.
7. The continuation gate decides:
   - **any tool call in this run, a recorded handoff, or an earlier run on this
     account with a provider session** → copy the provider session (Claude
     transcript + sidecars, or Codex rollout), record the handoff, spawn with
     `--resume`/`exec resume` and the hidden continuation prompt. The third
     clause is the follow-up case: a user's earlier turns produced the
     session, a later follow-up hits the limit before its own first tool call,
     and the whole conversation must still move. A same-account retry in this
     branch resumes the existing session in place (no copy). A Claude
     follow-up pasted into the REPL mid-turn that never reached the transcript
     (a live echo with no JSONL twin) is appended to the continuation prompt,
     so it is not lost with the dropped REPL.

     **Follow-ups never end up nowhere.** Whenever a handled ending leaves no
     *started* successor — a blocked ending (all-exhausted with a transfer
     retry or no timer, transfer failed), Stop, superseded, a frozen handoff,
     a failed or stopped spawn, a cancelled retry countdown, or a paused REPL
     dropped on the passthrough branch — one helper
     (`stashFollowUpsWithoutSuccessor`) puts everything the account switch left
     behind into the task's backlog tray with a status line, in typed order
     (the tray prepends, so the groups are stashed newest first: messages held
     during the swap window, then whatever sits in the per-kind turn queues —
     Codex queues a live-turn follow-up as its own later turn — then the
     Claude mid-turn follow-ups the transcript never received: whether one
     reached the transcript is decided by pairing the run's echo rows with
     their JSONL twins (`line_uuid`) per canonical text, so two identical unread
     sends are not mistaken for one delivered pair). A started
     successor drains these itself and never stashes. An all-exhausted
     **clean** retry replays the follow-ups itself while it is armed (see the
     clean-retry chain below). A hard crash still loses what was only in memory
     until the settlement ended; the clean-retry chain is persisted, so it does
     not.
   - **the task's first turn on the account with no tool call** → resend the
     request on a fresh session (the clean-retry branch), avoiding a duplicate
     provider user message. The text is rebuilt by
     `composeCleanRetryText(runs.mainUserRows(oldRunId))`: each main-stream
     user row is reduced to delivered text (claude's XML/`<pasted_content>`
     JSONL twin of a send, recognised by its `line_uuid`, pairs with the live
     echo of the same text so one send is one message, while two separate sends
     of the same text both survive), a predecessor's hidden continuation
     wrapper is unwrapped, and a REPL follow-up folded into the turn is
     replayed after the original prompt in order. A sequential-turn harness
     (Codex) keeps only the first row, because its live-turn follow-ups are
     queued as separate turns. Its
     divider says "Restarting the request on this account." — it never claims
     a transferred conversation that does not exist. A Claude clean retry whose
     text is a slash command (starts with `/`) is sent **alone** and unwrapped,
     as typed — Claude runs a command only from the start of the input, so the
     wrapper would turn it into prose; that one visible bubble is the accepted
     cost. The follow-ups folded into the limited turn are never its arguments:
     they follow as a queued hidden-continuation follow-up.
   A present-but-unreadable session is a hard block (`harness-swap-failed`), not
   a silent fresh start.
8. The old run is recorded `failed` with `run-status.reason: "harness-swap"`
   (the failure toast/notification is suppressed); the task stays `running`.
   When the settled run was itself an all-exhausted retry attempt, its
   `attempts` count is carried onto the successor (only `inFlight`/
   `nextAttemptAt` reset), so a retry that moves on to a member whose cooldown
   just expired cannot reset the three-attempt cap and loop forever.
9. `spawnSwapContinuation` inserts the new run (`origin: "harness-swap"`, the
   explicit session id), writes the **visible divider as the run's first status
   event**, emits the `harness-swap` global event, and spawns.
10. `pendingSwap` is cleared once the successor registered.

If no member can run, the old run is recorded failed and the task moves to
`blocked` with `harness-exhausted` (limit-blocked) or `harness-swap-failed`
(manual fix needed). `planExhausted` persists `allExhausted` and arms a timer at
the earliest reset, or 10 minutes when unknown, clamped to `[10 s, 24 h]`, with
at most 3 **started retries**. The initial exhaustion and a timer re-arm that
found nothing usable do not spend an attempt; a retry run that returns to
exhausted does. A manual Run resets the cap. When every member is unusable for
a non-limit reason, no timer is armed. A spawn failure that reaches the cap
writes "Every account in this stack is out of quota — run the task manually after a reset." Messages held during the
settlement are stashed to the task's backlog as soon as it ends blocked — timer
or not — so nothing typed is kept only in memory across a countdown.

`planExhausted` also persists `allExhausted.memberReasons`
(`{ harnessId, label, reason }[]`, one per member including the account that was
running the task, via `memberReasonsFor`), so the banner and `agetor show` can
say why each account could not take the task, and `earliestResetAtMs`, which the
banner and `show` print as the earliest reset.

**The clean-retry chain.** When the limited run was a first turn on its account
with no tool call, the retry restarts the request on a fresh session and replays
the follow-ups itself. An armed (not yet running) clean retry therefore persists
`allExhausted.cleanRetryOf = <the limited run>`; a second consecutive clean
retry keeps pointing at the **original** run, whose rows are tagged, instead of
the successor that holds the whole request as one wrapper row. If the retry ends
without running — a cancel (Stop, drag off `blocked`, stack delete), a manual
Run or message (which resets `allExhausted`), a same-stack account move, a
hard block, a failed spawn that reaches the attempt cap, the cap itself, or a
success/cancel that resets the lap — `endCleanRetry` clears the marker first
(so it happens at most once) and stashes the unread follow-ups, recomputed from
the persisted rows of that original run through `cleanRetryChainParts` (a
Codex retry replays only the first row, its follow-ups were already stashed as
queued turns), plus what later swap-origin runs in the chain received after their
first row. The **same chain function feeds the retry's own text** (so a retry
whose spawn failed once, leaving an empty failed successor as the latest run,
still replays the right parts) and the stash. The stash drops the chain's first
part only when it is the task prompt (what the replay would have re-sent
anyway); a first part that is something else — a fresh start on another account
whose first message was a follow-up — is kept. Because the marker and the rows
are persisted, this survives a restart. An `inFlight`
retry already started its successor, which carries the follow-ups.

**One history row per move or blocked outcome.** Every account move writes
exactly one row to the [swap history](#swap-history) and no move writes two;
the trigger depends on the path:

| Path | Trigger | Written by |
| --- | --- | --- |
| a provider limit moved the task | `limit` | `spawnSwapContinuation`, with both run ids and `continuation` (`transferred` when the conversation was copied and resumed on the destination, `restarted` for a clean retry) |
| the all-exhausted retry fired (also on the same account) | `retry` | `spawnSwapContinuation` |
| a swap, or a manual switch, completed by the boot reconcile | `boot-resume` | `spawnSwapContinuation` / `moveTaskToMember`'s `history` |
| Run or message found the account removed, disabled or unavailable and moved on | `unavailable` | `moveTaskToMember`'s `history` (from `prepareTaskHarness`) |
| a same-stack change from the picker or `agetor edit --agent`, or "Switch to next account" on an idle task | `manual` | `moveTaskToMember`'s `history` (from `reconcileTaskSession`; also written when the transcript could not be copied, with `continuation: "restarted"`) |
| "Switch to next account" applied at turn end | `scheduled` | the same |
| no usable member, every account out of quota, a boot resume that could not finish, or a move that failed after a limit | `blocked` | `recordBlockedHistory` (reason `quota` for a limit-blocked stack, otherwise `no-usable-member`; a move that threw or could not transfer after a provider limit carries that limit's reason and source, with the message "the account switch failed: …") |

The armed timer respects the user: it is cancelled (`cancelHarnessRetryForTask`
— timer, `allExhausted`, held follow-ups and the clean-retry follow-ups, plus a
status line "automatic account retry cancelled", or "… cancelled — the stack was
deleted" for a stack delete) when the card is no longer `blocked` (a drag,
`agetor move` or any `PATCH /tasks/:id` column change off `blocked`), when the
user presses Stop on the blocked card, and on archive/delete/stack delete (a
stack delete also drops a task's scheduled switch with its own status line).
A retry whose successor run is still live is not "cancelled": only the loop
marker goes, with no claim and no stash (the live successor carries the
follow-ups). The timer itself bails the same way if it fires on a card the user
moved. A fire
while a run is live or the task is held by background agents is deferred by
10 s (`deferAutoRetryNow`) rather than consumed.

A retry in flight is persisted (`allExhausted.inFlight` with
`nextAttemptAt: 0`) before its spawn, so a crash, a spawn failure or the retry
run failing for a **non-limit** reason can never strand the task: boot re-arms
an interrupted attempt without spending one, a spawn failure spends one (so a
permanently broken destination reaches the visible cap) and a non-limit settle
ends the failover loop and leaves the normal visible failure. `inFlight` stays
true for the **whole life of the successor run** — it is the only marker the
normal settle reads to end the loop — and is cleared only when that run
succeeds/cancels or by the next `planExhausted`. A hard block clears the marker
and leaves the task blocked for a manual fix. A retry run that is still live
after boot (re-attached) keeps its `inFlight` marker, so its own settle stays
armed to end the loop; only a dead/orphaned attempt is re-armed or ended by
boot. An **unexpected throw** out of the retry handler (before a successor run
is live) is recovered in place: the in-flight marker is cleared, the attempt is
spent like a handled spawn failure, and the normal backoff is re-armed — a
persisted `inFlight` with `nextAttemptAt: 0` and no timer would otherwise leave
the card on "Retrying…" until the next boot.

A limit with no swap target — the stack was deleted mid-run, the task was
archived, or the stack has fewer than two members — hands the run back to the
**normal** settle. It is recorded failed exactly like a lone account's failure
and takes the same column, checkout note and queued-follow-up drain; it never
arms an `allExhausted` retry. A **pane** limit (`source: "claude-pane"`) is the
exception to "leave the session alone": it leaves Claude's REPL parked on the
notice, so the passthrough drops that session before the normal settle. An
API-error or Codex limit does not pause a reusable session and is left as-is.
A message typed after the run then starts a clean turn instead of landing in a
REPL waiting for a limit nobody will continue.

The swap spawn window honours user control exactly like `startTaskInner`: a Stop
recorded against the claim is adopted onto the successor, and a Stop, delete,
replace, force-archive or stack delete that lands while the spawn is in flight
kills the successor, records it `cancelled` and returns the card to `ready`.
A Stop that lands even earlier — after the old run's handler dropped its handle
but before `pendingSwap` is persisted — is recorded on the task's swap window
and aborts the settlement before any mirror/transfer/spawn, recording the old
run `cancelled` (not failed; a pipeline step settles `cancelled` too); the
blocked all-exhausted branch honours it too, so no retry is armed.
A Stop during an all-exhausted retry's mirror/transfer aborts the account move
and settles like a Stop on an armed retry ("cancelled by user during the
account retry"; the card stays blocked, the account does not change), and a
Stop recorded during a retry is cleared when that retry ends, so it can never
cancel a later, unrelated failover. When a launch freeze already left the swap
for the next owner, a Stop clears `pendingSwap` and records the run
`cancelled`, so the next owner does not finish it.
The post-transfer step also re-reads the task, so an archive/stack delete during
the mirror/transfer can never resurrect a swap and spawn onto an archived task.

## The continuation prompt

The transfer branch sends exactly:

```
<harness-stack-continuation>
Continue the task from where it stopped. The previous account reached its usage limit; no work was lost. Do not repeat completed steps, re-read files you already changed, or ask the user to confirm. Pick up the next action.
</harness-stack-continuation>
```

When the limited run carried undelivered mid-turn follow-ups (see step 7), the
body continues with "The user also sent these messages before the switch; they
were not delivered yet:" followed by each message
(`composeHarnessStackContinuationPrompt(undelivered)`); with none it is exactly
the text above.

The clean-retry branch wraps the user's own reconstructed text in the same tag
(the body is the user's words, not a continuation instruction; a slash command
is the unwrapped exception above). A literal tag inside the user's text is
neutralized first (`neutralizeHarnessStackContinuationTags`, shared with the
transfer prompt), so a message that quotes the tag cannot break the wrapper. Its source is
`composeCleanRetryText(runs.mainUserRows(oldRunId))` — normalized, echo/twin-paired
and unwrapped — so a second consecutive clean retry strips the previous wrapper
before wrapping again; nesting would stop the value being recognised and leak
the hidden prompt as a visible bubble.

`isHarnessStackContinuation` hides only a value that is exactly the wrapper —
checked after `normalizeDeliveredUserText`, because claude's JSONL twin of the
pasted prompt is `<pasted_content>`-wrapped. Every renderer (RunPanel, CLI
`logs`, TUI, message history, event search, the sticky user-message headers)
skips it, and the first-load anchor never lands on it. A user message that
merely mentions the tag stays visible. It contains no product name. Because a
hidden value is recognised by its text, only agetor's own swap sends may
produce one: user text that is exactly the wrapper is refused with a 400
(`HIDDEN_CONTINUATION_REFUSAL`) by `sendInput`, `createTask`, `startTask` and a
task-prompt `PATCH /tasks/:id` — otherwise a CLI-token caller could hand an
agent an instruction no transcript shows.

## Mirror: config only, never login

`src/shared/harness-mirror.ts` is the single allowlist; `src/bun/harness-mirror.ts`
implements it. Source is always position 0. Both sides resolve their config
root through `claudeConfigDirFor` / `codexHomeFor`, which honour the harness's
own env map (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) exactly like `harnessEnv` does
— the env override wins over the home-derived path, so the mirror and a session
transfer target the directory the CLI really reads.

- **Claude**: merge `settings.json` (primary scalars win, an **array the
  primary defines replaces the backup's whole array** — a union kept a server's
  old and new `args` side by side and left a server in both
  `enabledMcpjsonServers` and `disabledMcpjsonServers` — objects deep-merge,
  and `env`, `mcpServers` and `enabledPlugins` entries are replaced **per
  name**; `hooks` and `permissions` are replaced outright by the primary's in
  full mode, so an edited hook does not run twice on the backup and a revoked
  permission does not survive there; a primary without the key leaves the
  backup's alone) and only the `mcpServers` / `enabledPlugins` keys of
  `.claude.json` plus the `mcpServers` of each `projects.<path>` entry
  (`claude mcp add` defaults to project scope), each server replaced whole by
  name, with backup-only servers kept; no other per-project field crosses.
  Copy the user-level instruction
  files (`CLAUDE.md`, `output-styles/`), `skills/`, `commands/`, `agents/`,
  the installed plugin payload (`plugins/cache/`), the marketplaces and
  `plugins/data/`. The two plugin registries
  (`plugins/installed_plugins.json`, `plugins/known_marketplaces.json`) are
  merged with every absolute path under the primary's config root rewritten to
  the destination root, so a backup loads its own payload copy rather than
  silently reading the primary's directory. `installed_plugins.json` arrays
  hold one record per install identity — a `user`/`local` scope and, for a
  project install, its `projectPath` — so they merge **by scope +
  `projectPath`** (the primary wins on an identity it defines; a plugin's
  several project records and the backup's own project records survive)
  instead of a plain union that would install one plugin twice or a scope-only
  key that would silently drop the other projects.
- **Codex**: section-preserving text merge of `config.toml` (the primary's
  top-level scalars replace by key while backup-only keys are kept; a table
  the primary defines — `[mcp_servers.*]`, `[profiles.*]` — replaces the
  backup's whole table with the same header; backup-only sections are kept).
  Blocks are split by a string-aware scanner: a `[x]` line inside a multi-line
  string or a multi-line array is part of that value, not a header. A backup
  **subtable** of a table the primary replaces that would conflict with the
  primary's keys (a primary that moved `env` inline would otherwise leave
  `[x.env]` behind and the file could never parse again), or that belongs to an
  `mcp_servers.<name>` entry, is dropped after its original is saved. The
  result is validated twice: `Bun.TOML.parse` must accept it, and a
  **lost-key backstop** (`findLostKeys`) checks that every key the primary
  contributes and every backup key the merge was not meant to replace is still
  there; otherwise the backup is left untouched with a warning. The
  **login-bearing** keys are never imported from the
  primary — `model_provider`, `forced_login_method`,
  `forced_chatgpt_workspace_id`, `preferred_auth_method`,
  `cli_auth_credentials_store`, `mcp_oauth_credentials_store`,
  `mcp_enterprise_managed_auth`, `chatgpt_base_url`, `openai_base_url` (top
  level, dotted, inside `[profiles.*]`, as a dotted key of a `[profiles]`
  table such as `work.model_provider`, or an inline `profiles` table) and every
  `[model_providers]`/`[model_providers.*]` table, which can carry a bearer
  token or auth headers; and, on top of the logins, two secret shapes:
  credential-shaped variables in `[shell_environment_policy] set` (table,
  dotted or inline form; an inline table is filtered member by member) and any
  `headers` under `[otel]`. Each assignment of a primary table is judged by its
  full key path; an inline profile table that names a login key is dropped
  whole. The backup's own values and blocks survive — its own profile login
  keys are carried into the merged table even when the primary's same-named
  profile has none — and one warning names what was skipped; copy `AGENTS.md` (the user-level instruction file),
  `prompts/`, `skills/`, `plugins/` including the installed payload cache
  (never the derived `store/`/catalog caches or the transient
  `.remote-plugin-install-staging/`).
- **Never copied**: `.credentials.json`, `auth.json`, session stores,
  transcripts, `thread_history_*.sqlite`, `state_*.sqlite`, session/log
  caches, logs, `mcp-oauth-locks/`, the primary's `[projects.*]` trust entries
  (header form **and** dotted/inline `projects."/x".trust_level = …`; trust is
  per account), and any `.git` directory/file at any depth (a marketplace clone's
  `.git/config` can hold a remote URL with an embedded token).
- **Provider login and cloud credential env keys** (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `AWS_SECRET_ACCESS_KEY`, `AWS_BEARER_TOKEN_BEDROCK`,
  `AZURE_OPENAI_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`,
  `ANTHROPIC_CUSTOM_HEADERS`, …) are stripped from the primary's merged
  `settings.json`; a backup's own key survives. The rule is **shape-based**:
  any `_`-separated `TOKEN`/`SECRET`/`PASSWORD`/`KEY`/`CREDENTIAL`/
  `AUTHORIZATION` segment matches whatever the vendor (`OPENROUTER_API_KEY`,
  `GITHUB_TOKEN`, `AWS_WEB_IDENTITY_TOKEN_FILE`), plus the vendor-prefix
  markers for names whose credential shape is not a whole segment. The mirror
  widens that, case-insensitively (`github_token` is as much a secret), with
  whole segments `APIKEY`, `PASS`, `PASSWD`, `PAT`, `AUTH`, `HEADERS`,
  `COOKIE(S)`, `SESSION`, `DSN`, `WEBHOOK`, `CONNECTION` and `PASSPHRASE`
  (`SERPAPI_APIKEY`, `DB_PASS`, `OTEL_EXPORTER_OTLP_HEADERS`; only a whole
  `_`-separated segment matches, so `PATH` is safe). These extra segments are
  deliberately not login evidence (`TERM_SESSION_ID` is not a harness login).
  Any env variable whose **value** is a URL carrying userinfo
  (`scheme://user:pw@host`, `HTTPS_PROXY`, `DATABASE_URL`) is stripped whatever
  its name, and an `extraKnownMarketplaces` entry or a plugin-registry entry
  whose URL carries userinfo never crosses (one warning counts them). A
  non-credential setting (`*_MODEL`, `*_MAX_TOKENS`, `AWS_REGION`) still
  mirrors. Every provider/login **selector** is never imported either — the
  switches that pick the provider or endpoint the account authenticates
  against (`CLAUDE_CODE_USE_BEDROCK`/`VERTEX`/`FOUNDRY`/…,
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_BEDROCK_BASE_URL`,
  `ANTHROPIC_VERTEX_BASE_URL`, `ANTHROPIC_VERTEX_PROJECT_ID`,
  `CLAUDE_CODE_SKIP_*_AUTH`, `OPENAI_BASE_URL`, …) and the login-selecting
  cloud settings (`AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, `AWS_ROLE_ARN`, the AWS
  config/credentials file pointers) — otherwise a subscription backup would
  run on the primary's cloud identity and quota. The process environment is not modified (a warning names the
  first kind-relevant credential it sees, cloud keys included).
- **Login-selecting `settings.json` keys** (`apiKeyHelper`,
  `forceLoginOrgUUID`, `awsCredentialExport`, `awsAuthRefresh`,
  `gcpAuthRefresh`, `forceLoginMethod`, `proxyAuthHelper`) are treated the
  same way, in both modes: never imported from the primary, and a backup's own
  value survives. Only the credential-producing ones (`apiKeyHelper`,
  `forceLoginOrgUUID`, the `aws*` pair, `gcpAuthRefresh`) count as login
  evidence; `forceLoginMethod` and `proxyAuthHelper` select or proxy a login
  without providing one.
- **Codex MCP sign-in** is not copied (OAuth store, security review deviation);
  when the primary defines `[mcp_servers.*]` the mirror warns that the backup
  may need to sign in once.
- **Static tool auth is mirrored on purpose.** An MCP server definition
  (`.claude.json` `mcpServers.*`, Codex `[mcp_servers.*]`) is copied whole,
  including any token in its `env`/`headers`/`http_headers`: the owner
  sanctioned tool auth crossing accounts, never the harness's own login
  (`docs/plans/harness-account-stacks-grill.md`).
- **Login evidence ignores Claude Code's own session variables.** Inside the
  `CLAUDE_CODE_` namespace only the real login variables
  (`CLAUDE_CODE_OAUTH_TOKEN` and its file-descriptor/refresh forms,
  `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`, `CLAUDE_CODE_GATEWAY_TOKEN`, the
  remote-session tokens) count, so Agetor started from inside a Claude Code
  session (which exports e.g. `CLAUDE_CODE_MESSAGING_TOKEN`) does not read every
  account as logged in; the mirror still strips every secret-shaped key.
- **Safe mirror** skips settings hooks, permissions and every setting that
  runs a command — Claude Code 2.1.319's own list: `apiKeyHelper`,
  `awsAuthRefresh`, `awsCredentialExport`, `fileSuggestion`, `gcpAuthRefresh`,
  `otelHeadersHelper`, `policyHelpers`, `processWrapper`, `proxyAuthHelper`,
  `statusLine`, `subagentStatusLine` (Codex: `notify`); plugins and MCP
  servers are still mirrored. The backup's own value of every skipped key
  survives; the primary still wins the keys that are not skipped (`model`, …).
  Safe mode also refuses every `settings.json` `env` variable that runs a
  command when it is set (`isCommandRunningEnvKey`): `NODE_OPTIONS`, `BASH_ENV`,
  `ENV`, `PROMPT_COMMAND`, `LD_PRELOAD`/`LD_LIBRARY_PATH`, `DYLD_*`,
  `PYTHONSTARTUP`/`PYTHONPATH`, `NODE_PATH`, the Perl/Ruby `*LIB`/`*OPT`
  variables, `GIT_EXTERNAL_DIFF`, `GIT_PAGER`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`,
  `SSH_ASKPASS`, `BROWSER`, `ZDOTDIR`, `EDITOR`, `VISUAL`, `PAGER`,
  `CLAUDE_CODE_SHELL_PREFIX` and any name ending `_HELPER` or `_COMMAND`; a
  warning counts them and the backup's own value survives.

All reads are no-follow/regular-file; every write is atomic and 0600; symlinks,
FIFOs and oversize trees are skipped with a warning — except a **top-level**
symlink in Claude `skills/`/`commands/`/`agents/` or Codex `skills/`/`prompts/`
(a skills-manager layout links them in), which is recreated in the backup as an
absolute link to the source link's target without reading through it. The
target is resolved **lexically** (lstat + readlink per component, never
`realpath`; nothing below a protected folder is ever stat'ed), because an
agent can plant such a link. A dangling target, a link loop, a target at or
above either account root, a never-copy/credential path, a `.git` path, or a
target that reaches a macOS-protected home folder (`Desktop`, `Documents`,
`Downloads`, `Pictures`, `Movies`, `Music`, `Library/Mobile Documents`,
`Library/Mail`, `Library/Messages`, `Library/Safari`, `Library/Containers`,
`Library/Group Containers`) is refused. A real backup entry is never
replaced; an existing backup **link** is (primary wins — owner decision), after
its old target is saved.

**Dotfile-symlinked configs.** A dotfile manager (stow, chezmoi, home-manager)
often links the primary's top-level `CLAUDE.md`, `AGENTS.md`, `settings.json`,
`config.toml` and `.claude.json` into a dotfiles repo. Those five names, and
only those, are read through the link on the **primary** side, resolved the
same lexical way (`resolveDotfile`; no stat inside a protected folder). A target
is refused when it is dangling or a loop, in a protected home folder, at or
above either account root or inside one of its never-copy paths, a `.git`
path, a credential file by name (`.credentials.json`, `auth.json`; a
`.claude.json` link may point only at a file of that name), inside a
secret-bearing home folder (`.ssh`, `.aws`, `.gnupg`, `.config/gh`, `.netrc`,
`.docker`, `.git-credentials`, `.npmrc`, `.kube`, `.config/gcloud`, `.pypirc`),
inside **or above Agetor's own data directory** (it holds the core token file
and the saved originals), not a regular file, or not of the entry's own
extension (`.md`, `.json`, `.toml`: a link must not turn `CLAUDE.md` into some
other file's contents). The accepted path has no symlink left, so it is read
with a no-follow final component. On the **backup** side a symlinked file is
never replaced by a regular file: a symlinked merged file, a symlinked
destination or a destination reached through a symlinked directory is skipped
with a warning, and every destination is checked with `destinationState`, which
walks the path one component at a time, before anything is stat'ed or read, so a
symlinked parent never makes the core stat inside a protected folder under
Agetor's identity.

Mirror copies keep the source
mtime, and a destination that is already a regular file of the same size and
mtime is skipped, as is a merged file whose result equals the backup's
current text, so a swap does not rewrite thousands of unchanged plugin files.
`mirrorForSwap` is single-flight per destination account and all mirror work
for one destination is serialized, so a stack save and N tasks swapping onto
the same backup never interleave. Before any other I/O, mirror, both transfer
adapters and cleanup resolve each account root (and, for Claude, each
`.claude.json` directory) lexically and refuse it when it lands in a
protected home folder its stored path did not name — a root swapped for a
symlink after it was gated (mirror: one warning, nothing written; transfer:
`unsafe-source`; cleanup: nothing removed). A root saved under such a folder
on purpose, and the `/tmp`/`/var` system links, are unaffected. Mirror and
both transfer adapters also refuse two accounts whose config roots are the
same directory **by realpath** (a symlinked alias included). A **source** path is also
refused when any component between the trusted account root and the leaf is a
symlink, not just the leaf: a linked intermediate folder (`plugins/` → outside
the account) would otherwise make the target's regular file look like the
account's own. Directory copy is **additive**: the source tree is merged over
the destination, so a backup's own skills/plugins/prompts are never deleted,
and each file is written atomically. A destination path that would traverse a
symlink is refused. Copy caps: 64 MB and 5,000 entries per user-config tree,
and a larger bounded 512 MB / 25,000 entries for the plugin payload trees (a
marketplace install is naturally much bigger); the walk yields every ~20 ms and
every individual read/write is chunked (1 MiB) and asynchronous, so one large
transcript cannot freeze the shared Bun main thread. `copyTreeCooperative`
reports whether a cap truncated the tree: if a plugin payload copy was
incomplete, the mirror leaves that account's plugin registry untouched and
warns, so a rewritten registry can never point at payload files that were never
copied.

Codex MCP OAuth: the binary's default store is `auto`; no stable standalone
filename exists for `file` mode. Per the T00 deviation, tokens are **not**
copied and the swap warns that MCP sign-in may need repeating on the backup.

## Mirror provenance, backups, preview and Restore

A mirror writes into a *backup* account's real config. The fix round makes that
recorded, previewable and reversible. All of it is `src/bun/harness-mirror.ts`
plus `src/bun/harness-mirror-backup.ts` and `src/bun/harness-mirror-provenance.ts`.

**One code path, two sinks.** Every phase of `mirrorOne` first *decides* what it
would do and then applies it through one effect layer (`MirrorCtx.dry`). A real
run copies, writes, saves originals and records provenance; a dry run records
the same decisions into a `MirrorPlan` per backup (`files.add|update|remove`,
`keys` as `{file, key, action}`, `backups`, `kept`, `warnings`) and writes
nothing: no file, no saved original, no provenance row. So a preview is exactly
what a real run would do. A plan carries names only, never a value (values can
be secrets). `previewMirror(draft, { stackId? })` runs the dry pass for a draft
stack; `overwrites` is true when any plan backs something up or removes
something. A mirror, a preview and a Restore of one destination account are
serialized (`serializeForDestination`).

**What is recorded.** For every file, merged key and symlink the mirror *wrote*,
one `harness_mirror_provenance` row: `scope` (`file`, `key`, `link`), `path`
(relative to the account's config root; `.claude.json` is relative to its own
directory), `key` (`''` for a file or link; the key path for a merged file —
`env.FOO`, `mcpServers.x`, `projects.<path>.mcpServers.x` in JSON, a table
header or top-level key in `config.toml`), the hash of what the mirror wrote
(sha256 of the file, of the canonical JSON value or TOML text; the target for a
link), the source's mtime and size (a cheap "nothing changed" check), whether
the target `preexisted`, and the saved original's `backup_ref`. An item the
backup **already had with identical content is not recorded**: the mirror did
not write it, so it never removes it. A row written before a crash and not yet
stamped with a source mtime marks an interrupted write and is refreshed on the
next run.

**Deletion propagation.** Only when the primary's config root is a real
directory, and never for something the primary merely could not be read for (a
missing or unsafe file, a tree that hit its copy cap, a refused symlink):

- something the mirror wrote, that the primary no longer has, whose *current*
  hash still equals the recorded one, and that did not preexist → **removed**
  (a file is unlinked and its now-empty mirrored directories pruned; a key is
  deleted from the merged document);
- the same, but the backup edited it → **kept**, listed in `plan.kept` with a
  warning, and ownership is dropped, so it is never mirrored or removed again;
- a `preexisted` item → ownership is dropped and the backup's file or value
  stays (a primary deletion must not destroy it, nor resurrect an older value).

Rows live in SQLite, which an agent can write, so a row is a claim: before any
removal or restore the path must pass the mirror-allowlist shape check
(`isMirrorCopyShape`), lie below the account root with no symlinked component
(`isPlainPathUnder`), be a regular file (or a symlink for a link row), and still
hash to the recorded value. A row failing a check is dropped, never obeyed.

**Primary wins, but reversibly.** If a mirrored item the backup edited since the
mirror wrote it is overwritten by a later mirror (the primary still wins), the
edit is saved as the item's original first, its row is marked `preexisted`, and
it appears in `plan.backups`, so the preview asks before saving and Restore can
bring the edit back.

**Backups.** The first time a write would replace or remove something the
backup already had, the original goes to
`<dataDir>/mirror-backups/<harnessId>/`: `files/<rel>` (bytes, up to 64 MB),
`modes/<rel>` (permission bits only, never setuid/setgid/sticky), `links/<rel>`
(a symlink's target) and `keys/<encoded file>.json` (original key values, TOML
as block text). The store is in the data directory, never in an account root
(an agent writes those); directories are 0700, files 0600, every write is
atomic, a symlinked or non-directory path component is refused, and a ref is
recomputed from the account id and the relative path, never taken from a row's
text. They can hold secrets (a replaced env value), which is why they are
removed with the account. The saved original is **never stale**: an unforced
backup keeps the first original, and a forced one (used when no row references
the entry, or when the account's own edit must become the original) replaces an
orphan; the intent row is written before the overwrite, so a crash leaves the
link to the saved original; a backup that cannot be written aborts the write,
so an original is never overwritten unsaved; and dropping a row deletes its
saved original, **except** a `preexisted` row with a saved original: that stays
as an *un-owned restore pointer* (below). The store does not trust its own
directory tree either: every access resolves its ref through
`resolveBackupPath`, which `lstat`s each component from `mirror-backups/` down
and treats a symlink or non-directory parent as missing (a write refuses it);
reads open no-follow handles asynchronously; and `removeMirrorBackups` walks the
tree cooperatively without following a link (a symlink is unlinked as itself,
and a directory swapped for a link between the check and the listing is
skipped). A mirror in flight when its account is deleted stops writing
(`accountAlive`) so it recreates neither rows nor backups.

**Un-owned restore pointers.** When the mirror stops owning a `preexisted` item
that has a saved original — the primary deleted it, or safe mode no longer
mirrors that key — the item stays on the backup as the mirror last wrote it and
its row is kept, re-stamped with `UNOWNED_STAMP` (-1) in both source columns
(`isUnownedRow`; no schema change, a real stamp is never negative). Deletion
propagation and later merges skip such a row, a later mirror write that adopts
the item again replaces the stamp with the original intact, and Restore still
puts the original back. Every other dropped row goes with its saved original; an
invalid-shape row is purged outright.

**Restore** (`restoreMirror`, `POST /harnesses/:id/mirror-restore`) works row by
row after the same checks:

- a `preexisted` file, link or key goes back from the saved original, provided
  the item still holds what the mirror wrote (an item edited since is **kept**,
  reported, and its original not restored);
- an item the mirror added is removed while unedited, kept when edited, and
  simply forgotten when already gone;
- a merged TOML file whose restored text would not parse is left alone;
- a `preexisted` file whose leaf the account has since deleted gets its original
  written back (only a path through a symlinked parent is refused as unsafe), a
  link row is restored the same way (missing parent directories are created
  under the root first), and an added item the account already deleted just has
  its row forgotten.

A row that was fully handled (restored, removed, nothing left to do, or garbage)
is deleted together with its saved original. A row that was kept or failed
**stays**, so Restore can be retried. When no row remains the account's whole
backup directory is removed. The result lists `restored`, `removed`, `kept`
and `warnings`. Restore is offered on every Claude and Codex account (with no
rows it does nothing); on a current backup member the UI and CLI warn that the next mirror (a stack
save or a swap) re-applies the primary's config. Deleting an account removes its
provenance rows (in `harnesses.delete`'s transaction); the route then calls
`deleteMirrorStateForHarness`, which runs inside the account's mirror queue (so
it waits for a mirror or Restore already writing there and nothing is recreated
after it), drops the rows again and removes the backup directory, best effort.

**Safe-mode un-own.** Switching a stack from full to safe ends the mirror's
ownership of every key safe mode no longer mirrors (hooks, permissions, command
settings, command-running env, Codex `notify`/`hooks`/`permissions`) without
deleting anything on the backup; a `preexisted` key keeps an un-owned restore
pointer.

**Surfaces.** `POST /harness-stacks/mirror-preview` (body: `kind`, `members`,
optional `mirrorMode` and `stackId` of the stack being edited) validates the
draft like a save, then returns `MirrorPreview`. For a CLI-token caller the
member-root path gate runs **before** the validation (validation resolves the
account roots and reads login evidence inside them, in the core's process). The Settings editor calls it on
Save when the change is mirror-relevant (a new stack with a backup, or an edit
that changes members, their order or the mirror mode) and shows the preview
dialog **only when `overwrites` is true**; the CLI `harness stack create|edit`
prints the preview with `--dry-run` and saves nothing, and without `--yes`
refuses (exit 1, after printing the preview) a save that would overwrite or
remove; `harness stack preview <stack>` prints it for a saved stack. Restore is
a button on the account row in Settings → Harnesses (with a confirm; shown only for accounts with mirror records) and
`agetor harness restore <account> [--yes]` (`--yes` is needed for a current
backup member).

## Codex `CODEX_HOME`

The T00 spike proved `CODEX_HOME` alone isolates login (`auth.json`), config,
MCP servers, sessions and writes on codex-cli 0.166.0. `harnessEnv` therefore
emits only `CODEX_HOME=<home>/.codex`; `HOME` stays the user's real home. This
applies to **every** Codex account with a `home`, stacked or not (an owner
decision): before stacks, such an account also had `HOME=<home>`, so an alias
that relied on its own `HOME` for `.gitconfig`/`.ssh`/`gh` now runs shell tools
under the user's main identity — pin `HOME` in the account's env map to keep
the old behaviour.

All config roots resolve through one precedence, the pure
`src/shared/harness-config-root.ts`, which `src/bun/harness-config-root.ts`
feeds with the process values (used by the spawn env, mirror, transfer,
command discovery and the usage meters), matching what the spawn makes the CLI
read. The **spawn pin** (`claudeConfigDirOverrideFor` /
`codexHomeOverrideFor`) is only the env map's value, else `home`: an env-map
`HOME` alone pins nothing. Such a Claude account spawns without
`CLAUDE_CONFIG_DIR` (so on macOS it uses the unsuffixed keychain item) and
reads `<HOME>/.claude` and `<HOME>/.claude.json`; an unpinned spawn is handed
this process's `CLAUDE_CONFIG_DIR`/`CODEX_HOME` or has it unset
(`pinClaudeConfigDir`, `pinCodexHome`), so the long-lived tmux server's env can
never redirect it. Every reader uses `claudeConfigDirFor`/`claudeJsonDirFor`/
`codexHomeFor`. Codex: the env map's
`CODEX_HOME` → `<home>/.codex` → the process `CODEX_HOME` → `<env-map
HOME>/.codex` → `~/.codex`. Claude: the env map's `CLAUDE_CONFIG_DIR` → `home`
→ the process `CLAUDE_CONFIG_DIR` → `<env-map HOME>/.claude` → `~/.claude`
(`.claude.json` lives in the config dir when one is pinned, else in that
HOME). Blank values count as unset, and `harnessEnv` drops a blank
`CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`HOME` from the env map so the spawn agrees. The rollout adapter copies the
rollout to the same relative path under the destination `CODEX_HOME` and, when
a `thread_history_*.sqlite` already exists, runs `codex migrate-rollouts
--apply` (30 s timeout, `coreSpawn`) once with `CODEX_HOME` set to the
destination's resolved root for every account shape (an env-map `HOME` one
included, so it never touches the user's own `~/.codex`); a failure is a warning and a failed
resume blocks the swap visibly.

## Session transfer

`src/bun/harness-session-transfer.ts` moves one provider session from the
source account's config root to the destination's (adapters: Claude, Codex).

- **No size cap.** A transcript or rollout is never refused for its size
  (dropping the conversation to stay under a cap loses exactly what the swap
  exists to keep); the copy streams in 1 MiB asynchronous chunks, so a huge file
  still yields to the shared main thread. The `too-large` failure reason no
  longer exists. A symlink or special file is still refused (`unsafe-source`).
- **What moves for Claude.** The transcript
  `projects/<project dir>/<sid>.jsonl`, the session's sidecar trees
  `projects/<project dir>/<sid>/{subagents,tool-results,mcp-tasks}/`, and
  `file-history/<sid>/` (the `/rewind` checkpoints; that folder sits beside
  `projects/`, and only this session's folder moves, the mirror never copies
  `file-history` as a whole). The transcript is the conversation; a sidecar or
  checkpoint tree that cannot be copied in full is reported as a **warning**
  (surfaced as a status line on the run), never a failed transfer and never
  silent: the entry budget (50,000 per tree), skipped entries (links, special
  files, vanished files) and a tree that errors out each say so.
- **Finding the source.** The project dir name is `encodeProjectPath(cwd)`, but
  Claude hashes an encoded name longer than 200 characters in a way that
  function cannot reproduce. A long name goes straight to a scan, and a miss on
  a short name falls back to it: the scan looks for `<sid>.jsonl` in each
  project dir (a session id is a UUID, unique across projects; a symlinked
  project dir is not followed; at most 50,000 entries). The directory name
  found on the source is reused verbatim on the destination, because its Claude
  derives the same name from the same cwd. Nothing is stat'ed before the chain
  of directories between the trusted config root and the leaf has been
  `lstat`-checked.
- **Destination checks walk per component** (`destinationState`): a missing
  component means the destination is absent, a symlink or non-directory parent
  means unsafe (the transfer is refused), and only the leaf of a verified plain
  chain is `lstat`ed. A destination that already exists is the account's own
  file (an A→B→A wrap): it is updated by the copy but never put on the cleanup
  allowlist.
- **Paths are recorded before the copy.** The files the copy is *about to
  create* (`recordIntended`, including the planned sidecar destinations) are
  upserted into `harness_session_handoffs` first, so a crash between the copy
  and the final row never leaves files nothing can clean up. A new row is
  stamped `createdAt` 0, and `findSessionIdForHarness` **never resumes a row
  stamped 0**: it is an intent whose copy never completed; the final upsert
  stamps the real time. A failed transfer puts the row back to what it was. A
  path recorded but never created is harmless (cleanup skips a missing file).
- **Superseded copies are removed after success.** When the account already had
  a handoff for a different session, its copies are removed only *after* the new
  copy succeeded (a failed transfer must leave the old conversation intact),
  under the **old** session id captured before the row was re-keyed. Copies that
  cannot be removed produce a warning; see Known limitations for what that leaves
  behind.
- Codex: the rollout is copied to the same relative path under the destination
  `CODEX_HOME` (only `sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl` is a
  recognised shape), with the same pre-recording, then `codex migrate-rollouts`
  as described above.

## Crash safety and boot

- **`reconcileOrphans` does not orphan a swap's old run.** A `running` run that
  is the `runId` of a non-manual `pendingSwap` is recorded `failed` (exit code
  -1) with `run-status.reason: "harness-swap"` and a status line ("the core
  restarted during the account switch — finishing it"). Its task keeps its
  column and `run_id`, and no `orphaned` run-status is emitted: an `orphaned`
  event would settle a pipeline step, the card would drop to `ready`, `run_id`
  would be cleared and the swap reconcile would block instead of resuming.
- A persisted `pendingSwap` is completed if its successor already exists and is
  live, or left alone if it already settled (its visible outcome is
  authoritative). When **no successor was ever minted** (`task.runId ===
  pending.runId` — the run insert and the `runId` update are one transaction;
  defensively, `task.runId == null` with the limited run being the task's latest
  run counts too), boot re-runs the swap (`resumeInterruptedSwap`; the transfer
  is idempotent, history trigger `boot-resume`) after re-validating the
  destination. Only when the destination is no longer usable, or a successor
  exists that cannot be accounted for, is the task visibly blocked with
  `harness-swap-failed` — a blind second spawn could duplicate work. If the
  resumed mirror or transfer **throws** (EACCES, ENOSPC, …), the task is blocked
  with `harness-swap-failed` too, a blocked history row is written and the
  held follow-ups go to the tray; otherwise the card would stay `running` and the
  persisted swap would throw again on every boot.
- **Scheduled switches are completed at boot.** After the pending swaps
  (`reconcileScheduledSwitchesAtBoot`, inside `reconcilePendingHarnessSwaps`,
  i.e. after the boot gate), a task with `scheduledSwitch` whose turn ended
  during the downtime is switched now; an archived task's request is dropped; a
  task that still has a live run, a swap/start claim, a pending swap or
  background agents keeps the request for its own turn end. Under a launch freeze
  the request stays persisted for the next owner.
- `allExhausted.nextAttemptAt` is re-armed on boot; overdue retries are
  staggered (`now + 5 s + i × 2 s`) so N tasks on one stack do not all mirror
  into the same backup in one tick, and a card `reconcileOrphans` sent to
  `ready` while its retry is armed is put back in `blocked`.
- Expired cooldowns are filtered out of read payloads and pruned on boot and on
  every cooldown write; a GET never writes.
- `reconcileHarnessFailover({ includeSwaps: false })` runs after
  `reconcileOrphans()` and before `markBootReady()` in `index.ts` and
  `headless.ts`; the swap reconcile (`reconcilePendingHarnessSwaps`, which may
  copy a transcript) runs **after** the boot gate opens, holding each affected
  task's start claim, so routes never wait on a copy.
- `freezeLaunches()` (the port is being handed to another core, or the app is
  quitting) stops every retry timer in this process (the persisted schedules
  are re-armed by the next owner), stashes held follow-ups to the backlog, and
  makes an in-flight swap stop before its spawn, leaving `pendingSwap` for the
  next owner. Headless shutdown and the app's `exit` stop the timers too.

## Cleanup

- **An agent switch never removes copied files.** After a swap the successor
  resumes the copied transcript/rollout, which then holds every later turn on
  that account — it is the live conversation, not a disposable copy. A switch
  outside the stack (and a same-stack switch whose transfer failed) clears the
  failover state but keeps the files and handoff rows; a handoff only steers a
  resume on the account it was copied onto, so switching back resumes the
  conversation there. Only task delete, retention and harness delete remove
  copies. A destination file that already existed before a copy (an A→B→A
  wrap overwrites A's own original) is never recorded, so cleanup can never
  delete an account's own transcript.
- **What cleanup trusts.** The database is agent-writable, so a recorded path
  is unlinked only when it lies below the destination account's root, matches
  a handoff shape **tied to the row's recorded session id** (Claude
  `projects/<enc>/<sid>.jsonl`, `projects/<enc>/<sid>/{subagents,tool-results,
  mcp-tasks}/…` or `file-history/<sid>/…`; Codex
  `sessions/YYYY/MM/DD/rollout-*-<sid>.jsonl`), so a planted row cannot delete
  another session's transcript. It also has no symlinked component and is a
  regular file, and nothing is removed under a root that resolves into a
  protected folder its stored path did not name. Nothing is removed
  recursively; afterwards only empty plain directories inside those shapes
  (the session folder and its sidecar folders, `file-history/<sid>`, Codex's date
  folders) are pruned. The unlink loop is cooperative. Each recorded path is
  classified `removed`, `gone`, `rejected` (never ours: wrong shape or session,
  symlinked component, not a regular file) or `retained` (may still be ours: it
  lies outside the account's **current** root because its `home` was changed
  after the copy, the root is refused, or the unlink failed). **A handoff row is
  deleted only when nothing was retained**; otherwise the row stays and cleanup
  returns a warning, so a later cleanup can still remove the file.
  Handoff upserts merge `copied_paths_json`, so a second copy onto the same
  account never orphans the first copy's files.
- **Delete** clears failover state and cancels timers first, then removes the
  copied session files at the very end — immediately before the task row (and
  its handoff rows) is deleted. Every step in between can throw (the pipeline
  cascade, the worktree teardown, the issue snapshot removal); a failed delete
  leaves the task row alive, so its copied conversation must still be there to
  resume. A recorded path is removed only when every component below the
  account root is a real, non-symlink path: a symlinked parent inside an
  agent-writable home must never redirect a cleanup outside the account.
- **Archive** clears failover state and keeps the copies so an unarchive can
  resume; the archived-history retention pass removes them after the threshold.
- **Harness delete** captures the copied session files it owns as a handoff
  destination while the row can still resolve the root, deletes the row
  (whose built-in/in-use guard is atomic with it — a refused 409 leaves the
  live task's copied transcript untouched), then removes the captured files.
  `harnesses.delete` removes its membership row explicitly (there is no FK
  cascade, see Model), re-packs the surviving ranks to `0..n-1` (the API also
  derives `position` from the surviving order, so a pre-fix database with a gap
  still reads contiguously) and bumps the stack's `updated_at` strictly
  upward, so an open editor's `expectedUpdatedAt` conflicts. The same
  transaction deletes the account's cooldown rows, handoff rows and mirror
  provenance rows; its mirror backup directory is removed right after (best
  effort). The account's swap-history rows stay (denormalized labels).
- **Stack delete** clears the failover state and cancels the retry timer of
  every task whose recorded `stackId` **or currently resolved stack** is the
  deleted one (`failoverTaskIdsForStack`, computed before the delete), so an
  account edited into the stack after a task's last state write is caught too;
  an armed retry or all-exhausted block is cancelled first with a status line
  naming the deleted stack (its held and clean-retry follow-ups go to the
  tray), and a scheduled switch is cancelled with its own line. The stack's
  swap history is deleted with it (FK cascade); cooldowns stay account-scoped. Every orchestrator state write goes through
  `updateTaskState`/`patchTaskState`, which re-point `stackId`, `position` and
  `count` from the current resolution.

## Manual paths

- `prepareTaskHarness({ manual: true })` runs before a Run/message: a cooling
  account is forced; an account removed/disabled/logged out moves to the next
  usable one, mirrors the config onto it and transfers the conversation
  (`moveTaskToMember`; its warnings become status lines on the run). A live
  run — or a task held by running background agents — is left alone (the
  message queues). The message path holds the task's start claim for the whole
  move, so an armed retry cannot mint a competing successor mid-copy.
- `PATCH /tasks/:id` with an `agent` inside the same stack is refused while a
  run is live (409 "stop the run before switching accounts") and while the
  task is held by running background agents (409 "stop the background agents
  before switching accounts"); for a CLI-token caller both members' roots are
  re-probed through the CLI path gate first (403 `path-not-accessible`). An
  outside-stack switch keeps the old kill/reset behavior.
- A same-stack manual switch is AWAITED by the PATCH route (which lifts Bun's
  255 s idle cap with `server.timeout(req, 0)`, because a large transcript copy
  can outlast it; the CLI gives `agetor edit --agent` the 15-minute mirror
  budget and says "the switch may have gone through" on a dropped connection)
  and holds the task's start claim for the whole transcript copy
  (`accountSwitchTaskIds` plus `startingTaskIds`). A Run during the copy is refused ("switching accounts —
  try again in a moment") and a message is declined for the same reason: the old
  REPL is about to be dropped and a fresh session would be displaced by the
  handoff. A same-stack switch of a task held by running background agents is
  refused at every entry (the route answers 409; `claimTaskForAccountSwitch`
  and `reconcileTaskSession` revert a direct caller's switch with a status
  line), so the REPL hosting them is never dropped. The intent is persisted as `harnessState.pendingSwap.manual` **before**
  the task row changes accounts, so a crash between the row update and the
  transcript copy is completed by the boot reconcile (the transcript is still on
  the source account) or visibly reported — never silently lost. The move
  records `lastMove.reason = "manual-switch"`, so the task header says "Switched
  to … — continuing this conversation" rather than claiming the previous
  account left or was unavailable. The move is recorded even when the task has
  no provider session to copy (nothing ran on the old account yet), matching
  the boot reconcile instead of silently clearing the state.
- A same-stack manual switch mirrors the config, transfers and keeps queued
  follow-ups; the boot completion of an interrupted manual switch mirrors too.
  Outside the stack the old fresh-start behavior applies (but copied files are
  kept, see Cleanup). In the RunPanel, a same-kind account switch PATCHes only
  `{ agent }`, so the task keeps its mode, model, effort, speed and Max mode;
  the request is sent with `retry: false` (a lost answer is never replayed),
  the picker is disabled with a "Switching…" note while the awaited copy runs,
  and the response updates the panel at once. A refused or failed switch shows
  an error toast with the server's reason ("may have gone through" on a dropped
  connection — `taskPatchFailureToast`, `src/mainview/lib/task-patch-failure.ts`),
  while other dropdown PATCH failures stay quiet.
- **The picker lists only the stack's members.** For a task whose account is in
  a stack of two or more, the RunPanel account picker shows the members in stack
  order (`<label> n/m`, a model-aware "⏳ cooling until …" mark, and
  "(unavailable)" / "(not logged in)"), not every account
  (`stackPickerOptions`, `src/mainview/lib/stack-badge.ts`). The restriction is
  webview-only: `agetor edit --agent` and `PATCH /tasks/:id` still accept any
  account, and a switch **outside** the stack keeps the old fresh-start
  behavior. When the task's account cannot be edited the Harness row shows the
  account's label, not its id.
- A message typed during a swap window is held (`swapWindowTaskIds`) and
  delivered in order to the successor as soon as it registers, through the
  ordinary mid-turn path (Claude folds it into the live turn, Codex queues it);
  a settle-time drain onto the run that actually executes it remains the
  fallback. That send is the message's only `user` bubble — the window does
  not write one on the displaced run (that duplicated it).
  Stop/archive/delete, a settlement that ends blocked (timer or not), a refused
  send and a launch freeze re-stash it to the backlog at once; a message typed later,
  during an all-exhausted countdown, is a manual message and runs through
  `prepareTaskHarness` immediately.

## Switch to next account

A user action that moves a stacked task to its next usable account without a
provider limit (`switchTaskAccountNow` / `cancelScheduledAccountSwitch` in
`src/bun/orchestrator.ts`). `POST /tasks/:id/switch-account` answers
`{ status: "switched" | "scheduled", task }`; `DELETE` cancels a scheduled
switch and answers `{ task }` (a no-op when nothing is scheduled).

**Target.** `planManualSwitchTarget`: forward from the task's current account,
wrapping, the first member an automatic swap would also accept (enabled, not
cooling for the task's model, quota not exhausted, installed, logged in, model
and CLI floor). It ignores `tried` and **never cools an account or marks one
tried**: the move writes `tried: []`, `lastMove.reason = "switch-now"` (the
header reads "Switched to the next account — continuing this conversation."
— the shared `harnessMoveNote`, which `agetor show` also prints, under the same
24 h `harnessStackBannerMode` window as the webview banner) and one history row.

**Refusals** (HTTP 409, body `{ error, code, reasons? }`; `reasons` is one
`{ harnessId, label, reason }` per member, shown by the webview toast and the CLI
as one line each):

| `code` | When |
| --- | --- |
| `not-in-stack` | the task's account is in no stack or in a stack of fewer than two accounts |
| `archived` | the task is archived (unarchive it first) |
| `launches-frozen` | an idle task while launches are frozen (the port is being handed to another core, or the app is quitting); a live run can still schedule, and boot performs it for the next owner |
| `no-usable-member` | no other member can take the task now, with `reasons` |
| `background-agents` | running background agents hold the task (the switch would drop the REPL that hosts them) |
| `busy` | another account switch is copying; a swap window, a non-manual `pendingSwap`, an in-flight retry or a boot swap claim holds the task (a request scheduled inside one of those would be lost when the swap rewrites the task's state); a start claim exists with no live turn to wait for; or the row was put back because background agents appeared meanwhile |

An unknown task is 404. For a CLI-token caller the roots of the task's account
and of every member are re-probed through the CLI path gate first (403
`path-not-accessible`). The handler lifts Bun's idle timeout, because an idle
switch awaits the transcript copy.

**Idle task.** The route claims the task (`claimTaskForAccountSwitch`: the
account-switch and start claims) and runs the same same-stack move a PATCH does
(`reconcileTaskSession` → `moveTaskToMember`: mirror, then transfer, queued
follow-ups kept), with history trigger `manual` and reason `user`. If the
transcript cannot be copied the account still changes, the status line says it
starts fresh, queued follow-ups go to the tray (the reset would delete them),
and the history row is written with `continuation: "restarted"`.

**Live turn** (only a genuinely live run: an active or `running` run; a swap,
a retry or a pending swap is a `busy` refusal instead). The request is persisted as `harnessState.scheduledSwitch =
{ requestedAt }` with a status line, so it survives a reload, the CLI and a
restart, and the answer is `scheduled`. Asking again is a no-op. At the end of the
turn (`settleScheduledSwitchAtTurnEnd`, called before the queued follow-ups
drain, so they start on the new account):

- the target is **re-planned**; with no usable member the request is dropped
  with the member reasons in a status line; a failed move drops it with the
  error;
- a **Stop** (the run settled `cancelled`, or Stop on a task held by background
  agents) drops it with "scheduled account switch cancelled (stopped)"; it is
  also dropped by a Stop during a swap;
- a **provider limit supersedes it**: failover moves or blocks the task anyway,
  so the request is consumed in the limit settlement with no second move;
- **background agents** still holding the task at turn end defer it with a status
  line; it runs when they release the task (`maybeReleaseHeldTask`);
- a newer turn that already owns the task decides at its own end; a **launch
  freeze** leaves it persisted for the next owner (boot performs it, see Crash
  safety); a stack delete cancels it with a status line.

**Order at a turn end.** The move runs before the queued follow-ups drain, and
the messages held during it go out **after** whatever the turn had queued
(a Codex turn's queued follow-ups first, then the held messages), so the order
stays oldest first; under a launch freeze or for a pipeline step Stop they are
stashed to the tray instead. `claimTaskForAccountSwitch` itself refuses under a
launch freeze. A scheduled switch dropped because the stack was cut to a single
member writes a "scheduled account switch dropped — the stack has fewer than two
accounts" status line.

**Messages during the move.** While a switch-now claim is held, a message (a
pipeline handoff reminder included) is **held, never refused**, and delivered
through the ordinary mid-turn path after the move (`switchNowTaskIds`,
`drainSwapFollowUps`); only the task having no run at all answers "the task is
starting". A plain PATCH switch still declines a message with "switching
accounts — try again in a moment".

**Stop during the copy.** The copy is not aborted (a half-moved conversation is
worse); it finishes, and what was queued or held for the task goes to the
backlog tray instead of draining onto the new account
(`switchStopRequested`).

**History.** Trigger `manual` for an idle switch, `scheduled` for one applied at
turn end.

Surfaces: the RunPanel "Switch to next account" button (with a "Switch scheduled
for the end of this turn" line and Cancel), `agetor switch-account <task>
[--cancel]`, the `⇄` marker in `agetor ls` and the TUI header, the `switch:`
line in `agetor show`, and the card badge ("switch scheduled").

## Swap history

`harness_swap_events` (migration 087) is a per-stack, append-only log of every
account move and every blocked outcome. The trigger per path is the table under
[Settlement and the swap](#settlement-and-the-swap).

- **Row.** `stack_id` (the one FK, cascade), `task_id`/`task_title`,
  `from_*`/`to_*` harness id and label, `trigger`, `reason` (a limit reason,
  `no-usable-member`, a move reason, or `user`), `source`, `message` (the
  provider's text, truncated), `model`, `resets_at_ms`, `from_run_id`,
  `to_run_id`, `continuation` (`transferred` / `restarted`), `at`. A `blocked`
  row has no `to`. Labels fall back to the id.
- **Lifetime.** Nothing references tasks or accounts, so history survives a
  task delete, an archive and an account delete; it is deleted only with its
  stack. There is **no cap and no pruning**.
- **Writes.** `recordHarnessSwapEvent` never throws (a history failure is
  logged and must not break a swap). The store validates on insert: an unknown
  trigger, reason, source or continuation throws and nothing is written.
- **Reads.** `harnessSwapEvents.page(stackId, { limit, before })`, newest first
  by `(at, id)`, via the index `(stack_id, at DESC, id DESC)`; the default page
  is 50 and the limit is clamped to 1–200. `nextCursor` is an opaque base64url
  token taken from the last raw row (pass it back as `before`); a malformed or
  tampered cursor reads as the first page. The database is agent-writable, so a
  row with an unknown trigger is **dropped** on read, and an unknown reason,
  source or continuation is coerced to `null`.
- **Surfaces.** `GET /harness-stacks/:id/history?limit=&before=`
  (`HarnessSwapHistoryPage`, 404 for an unknown stack; app+cli, no path gate: it
  touches no files); the "History" button on each stack card in Settings →
  Harnesses opens a paged list (`StackHistory`); `agetor harness stack history
  <stack> [--limit n] [--before cursor]` prints it, with the next cursor on the
  last line (`--json` prints the page). Every renderer words a row through the
  shared `formatHarnessSwapEvent`, and the CLI escapes the line.

## Surfaces

- **API.** Every route below is `app+cli` in `ROUTE_POLICY`
  (`src/bun/route-policy.ts`); none takes a path, so none declares `pathParams`,
  and the ones that reach an account's config root probe those roots for a
  CLI-token caller in the handler (`gateStackMemberRoots`, 403
  `path-not-accessible`).

  | Route | What | CLI path gate |
  | --- | --- | --- |
  | `GET /harness-stacks`, `POST /harness-stacks` | list (with `limitStates`) / create (runs the mirror inline) | create |
  | `GET /harness-stacks/:id`, `PATCH`, `DELETE` | detail / edit (mirror inline; `expectedUpdatedAt`) / delete | edit |
  | `GET /harness-stacks/:id/history` | the [swap history](#swap-history) page | no |
  | `POST /harness-stacks/mirror-preview` | the mirror dry run for a draft | every member |
  | `DELETE /harnesses/:id/limit-state[?model=\|?scope=account]` | clear an account's cooldown rows (all, one model's, or just the account-wide one) and re-arm waiting countdowns; answers `{ cleared, rearmed, limitStates }` | no |
  | `POST /harnesses/:id/mirror-restore` | [Restore](#mirror-provenance-backups-preview-and-restore) | the account |
  | `POST`, `DELETE /tasks/:id/switch-account` | [switch to next account](#switch-to-next-account) / cancel it | POST: the task's account and every member |

  `GET /harnesses` carries `stacks`, `limitStates` (one row per account and,
  for a per-model limit, per model) and `mirrorRestorable` (the ids of accounts
  with mirror provenance rows, i.e. where a Restore has something to undo); `GET /tasks` carries `harnessState`;
  `GET /usage` (CLI scope) carries the quota snapshots the meters read, and
  `POST /harnesses/:id/usage/refresh` stays desktop-only. Create/edit run the
  config mirror inline when the change is mirror-relevant, so those handlers call
  `server.timeout(req, 0)` — a large plugin payload on a slow volume must not hit
  Bun's 255 s idle cap after the stack row is already saved (the preview,
  restore, switch and same-stack account PATCH routes lift it for the same
  reason); the CLI gives these calls a 15-minute budget and the webview sends
  create/edit with `retry: false`, and a connection dropped before the answer says
  the stack "may have been saved" and reloads instead of re-posting. **Optimistic
  concurrency:** `PATCH /harness-stacks/:id` accepts `expectedUpdatedAt`; if the
  stored `updatedAt` differs the answer is `409 { error, code: "stack-changed",
  stack }` with the stored copy, and nothing is written. `updatedAt` is strictly
  increasing (two edits in one millisecond still differ), and an account delete
  that removes a member bumps it. Omitting the field keeps last-write-wins for
  older clients; create ignores it. Member warnings (install, login, model,
  process key) are computed only by the list, the detail `GET
  /harness-stacks/:id` and the create/edit responses; the runtime lookups (`get`,
  `getByMember`, `resolveForTask`) are plain DB reads. `POST`/`PATCH /harnesses`
  refuse (400, every caller) a non-blank `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`HOME`
  env value that is not absolute as given (relative, `~`, leading whitespace),
  refuse a `..` segment, and otherwise store `home` and those values exactly as
  given — the stored `CLAUDE_CONFIG_DIR`/`home` spelling is the string Claude
  hashes into its keychain item. `PATCH /harnesses/:id` refuses re-pointing a
  stack member onto another member's config root or another kind
  (`harnessStacks.validateMemberRoot`), and a `PATCH /tasks/:id` column move off
  `blocked` cancels an armed retry. The CLI client URL-encodes the ids it puts in
  request paths (tasks, runs, interactions, stacks, harnesses;
  `src/cli/api-client.ts`).
- **CLI.** `agetor harness stack ls|create|show|edit|preview|history|rm` (listed
  in `agetor harness --help`; `agetor harness stack <sub> --help` prints that
  subcommand's flags). A `<stack>` argument resolves as an exact id, then an exact
  label, then a unique id prefix; a label shared by two stacks is an error naming
  both ids (`src/cli/resolve-stack.ts`). `stack edit` takes `--member` (replace
  the list) or `--add`, `--remove` and `--move <account>:<position>` (repeatable,
  applied in order, not mixable with `--member`), `--label`, `--kind`, `--mirror`;
  it always sends the `updatedAt` it just fetched, so an edit made elsewhere in
  between is refused (409 `stack-changed`; re-run). `create`/`edit` take
  `--dry-run` (print the mirror preview, save nothing) and `--yes` (a save that
  would overwrite or remove files on a backup refuses, after printing the
  preview, without it). `stack preview <stack>` prints the preview of a saved
  stack; `stack history <stack> [--limit n] [--before cursor]` pages the history;
  `agetor harness cooldown clear <account> [--model id]` (without `--model` it
  clears every cooldown row of the account and says so; the account may be a kind
  name, resolved like the core does; it reports how many waiting tasks were
  re-armed); `agetor harness restore <account> [--yes]`; `agetor
  switch-account <task> [--cancel]` (a refusal prints one heading and each member
  reason once); `agetor harness stack rm` says the stack's switch history is
  deleted with it. `agetor harness ls` and
  `stack ls|show` show each account's cooldown (reason, reset, the provider's
  message, the model for a per-model row) and 5-hour / weekly quota with the
  snapshot age (`stale` past 20 minutes); there is no force-refresh from the CLI.
  `agetor ls` shows `· 2/3` and the markers `⏳` (the current account is cooling
  for the task's model), `out of quota` / `blocked: no usable account`,
  `retrying (attempt n/m)` while the retry run is live (in place of the
  out-of-quota marker; it does not hide `⏳`) and `⇄` (a switch is scheduled); `agetor show` prints `stack:` / `failover:` lines,
  the cooling rows that apply to the task's model (the account-wide row and its
  model's, never another model's), and for an all-exhausted task the earliest reset and one line
  per member reason, pointing at Settings → Harnesses; `agetor edit --agent`
  refused for a live run suggests `switch-account`. The formatted notice appears
  in `logs`; the TUI shows the toast, the notice and the active account with its
  position (`<label> · 2/3`) and markers in the task header. While a retry run is
  live, `show` reads "running on <account> after a quota reset (attempt n/3)". A
  stored harness label or id can carry control characters (the route keeps it as
  typed), so every terminal renderer escapes it (`escapeControlChars` for
  identifiers, `escapeFreeText` for provider messages and titles) — a
  switch/continue line cannot repaint the log. A hidden continuation prints
  nothing (not even a blank line).
- **Webview.** *Settings → Harnesses* is the one page for accounts and stacks (the
  "Stacks" sidebar entry is gone; an old `stacks` deep link opens Harnesses).
  Each stack is a card of its accounts, primary first, with Edit, History and
  Delete; the accounts in no stack follow under "Other accounts". Every account
  row shows: the position chip (no chip for a stack of fewer than two accounts),
  for a stack member a compact 5-hour / weekly **quota meter** from the App-level
  usage map (no extra fetch; dimmed and marked "stale" past 20 minutes, "no
  quota data" without a snapshot), a **cooldown chip** per active row (reason,
  reset, "for <model>", the provider's message as plain text beside it and in a tooltip) with a
  **Clear** action (confirm, naming what it clears — the account-wide chip clears
  only the account-wide row, a per-model chip only that model's; the provider may
  still refuse until its own reset), and **Restore pre-stack config**, offered only
  on accounts listed in `mirrorRestorable` (confirm; a current backup member is
  warned that the next mirror re-applies). The delete-stack confirm says the
  stack's switch history is deleted too. The editor
  sub-page (order, members, mirror mode) keeps the disabled-member and
  same-config-directory blockers (the latter uses the shared spawn precedence of
  `src/shared/harness-config-root.ts`, env-map `HOME` included, lexically — the
  real home is `~` and a process `CLAUDE_CONFIG_DIR`/`CODEX_HOME` is unknown
  there, so the server stays authoritative), asks to confirm a kind change that
  would drop selected members, answers an unchanged Save with "No changes to
  save", sends `expectedUpdatedAt`, and on a mirror-relevant Save calls the
  preview route, showing the preview dialog (per backup: files overwritten or
  removed, keys, what is backed up first, what is kept) **only when `overwrites`
  is true**. Confirm writes **exactly the draft that was previewed**: a draft
  edited while the dry run was in flight, or after the dialog opened, is previewed
  again instead of being saved unseen. (The editor lives in
  `src/mainview/components/settings/StackEditor.tsx`.) A 409 `stack-changed` toasts "This stack changed elsewhere —
  reloaded" and replaces the draft with the stored copy. The History sub-page
  pages the stack's swap history. *Board and RunPanel:* New Task/TaskCard and the
  task-launch pickers' badges (a not-yet-run task derives its `n/m` from the
  account's stack membership; the badge's cooling mark is model-aware and has an
  `aria-label`; a scheduled switch shows "switch scheduled"); the RunPanel account
  line, **Switch to next account** button (see that section), the picker limited
  to the stack's members, the countdown banner with a **Run now** action (forces a
  cooling account and resets the attempt cap; disabled with "Starting…" while its
  request is in flight) and the swap divider. The exhausted banner also prints
  the earliest reset ("Next reset around …"), one line per member reason
  (`allExhausted.memberReasons`) and an **Open Harnesses** button. A stack
  blocked with nothing a reset can fix (`no-usable-member`, no timer) reads "No
  account in this stack can run this task — fix one in Settings → Harnesses."
  While the retry run itself is
  live the banner reads "Running on <account> after a quota reset (attempt n/3)."
  with no Run now (`src/mainview/lib/harness-stack-banner.ts`). The launch pickers
  (`NewTaskForm`) say "This account can't start right now — the run starts on the
  next usable account in its stack" instead of a red "not installed" box when
  `stackBackupCanServe`.
- **Launch surfaces**: a launch is never refused client-side on an account
  that is disabled, unavailable or logged out when its stack has a usable
  backup (`stackBackupCanServe`, `src/mainview/lib/stack-launch.ts`): the Git
  issue/PR dialogs gate submit on `effectiveLaunchable`, the pipeline
  preflight (`resolvePipelineLaunch`) returns ready, and a hint says the run
  starts on the next usable account — the core's `startTask` makes the move.
- **One-account stacks**: a stack with fewer than two members is inert, so no
  surface shows an `n/m` position or "fails over" copy for it (webview, CLI,
  TUI, notifications); the card badge shows only a live state word. The rule
  lives once in `stackPositionText` (`src/shared/harness-stack.ts`), which the
  CLI and the webview's `stackPositionFor` both use.
- **Notifications**: `harness-swap` is a quiet kind and its text omits the
  `(n/m)` position for a stack of fewer than two accounts (webview toast,
  headless core and CLI `--notify`, all by the one-account rule above);
  `blocked` with a stack
  reason reads "Stack out of quota" / "No usable backup account" (webview,
  headless core, TUI and CLI `--notify`). The old run's failed settle is
  silent for both `harness-swap` and `harness-exhausted`
  (`runStatusToastKind`, `src/mainview/lib/run-status-toast.ts`).
- **Pipelines**: a step's `run-status` with `reason: "harness-swap"` or
  `"harness-exhausted"` is non-terminal; the successor's settle is the step's
  outcome, and the retry's `running`/settle events clear the step block. A
  harness-stack successor (`origin: "harness-swap"`) is the same execution, not
  a user turn: it never resumes a stopped step. A pipeline Stop counts a step
  waiting on an armed stack retry as something it can stop and cancels the
  timer, so nothing fires after the Stop.
- **Bundles**: stacks are machine-local and are not exported.

## Known limitations

- A mirrored marketplace clone loses its `.git` metadata: the repository can
  carry a remote URL with an embedded access token, so it is never copied. The
  plugin payload still works; a git-based marketplace update on a backup
  re-clones instead of fast-forwarding.
- A stack deleted mid-turn (or an inert 0/1-member stack) takes the
  **lone-account** path on purpose: the limit is recorded as a normal run
  failure, the card returns to `ready`, and a status line reads "account
  limit reached (<usage limit|rate limit|out of credits>)". Nothing is hidden — `agetor show`/`logs` still carry the
  failed run and the message — but the card does not block, because a lone
  account has never blocked on a quota notice (Claude's own auto-continue keeps
  the turn alive). Re-create/re-enable the stack before the next Run to resume
  failover.
- A Claude **built-in** account (no pinned config dir) uses the unsuffixed
  keychain item, so a logout of that account cannot be detected at pre-flight
  (its login evidence is "unknown", never "logged out"). Stack pre-flight login
  evidence for a pinned account reads its own config directory
  (`~/.claude*` / `CLAUDE_CONFIG_DIR`): `.credentials.json`, the credential in
  its `settings.json` `env` or `harness.env` map, or an `apiKeyHelper`-style
  login (`apiKeyHelper`, `forceLoginOrgUUID`, `awsCredentialExport`,
  `awsAuthRefresh`, `gcpAuthRefresh`). On **macOS** a pinned account keeps its OAuth login in the keychain,
  not in a file, so when none of those is present the core asks the keychain
  whether the item exists — existence only, never the secret:
  `/usr/bin/security find-generic-password -s "Claude
  Code-credentials-<first 8 hex of sha256(CLAUDE_CONFIG_DIR as given, NFC)>"`
  (or of `CLAUDE_SECURESTORAGE_CONFIG_DIR` when set), without `-w`, run as an
  async `coreSpawn` (2 s kill), single-flight per service, cached 60 s: found →
  logged in, missing (exit 44) → logged out, any error → unknown. Readers never
  block the main thread: they get the cached (or stale) value, or unknown until
  the first lookup lands, and trigger a background refresh. Test seams:
  `setLoginEvidenceDepsForTests` (`keychainProbe`, `securityRunner`) and
  `settleKeychainProbesForTests` (under `NODE_ENV=test` with no seam the probe
  reports "no item"). A Codex account whose
  `config.toml` sets `cli_auth_credentials_store = "keyring"|"auto"` and has no
  `auth.json` is "unknown" too. A Bedrock/Vertex/custom-provider setup (or a
  custom endpoint) fails **open** — it is never reported as logged out — in
  any of those scopes, including a **process-level** selector that every spawn
  inherits; a Codex `config.toml` that is present but unreadable fails open the
  same way. Such an account still cannot be verified, so use accounts with
  their own config directory for a train.
- **Cloud credential env keys are login evidence only with a selector.** For
  Claude, an `AWS_*`, `BEDROCK_*`, `AZURE_*`, `VERTEX_*` or
  `GOOGLE_APPLICATION_*` credential key (account env map, process env or
  `settings.json` `env`) counts only when a provider selector
  (`CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`) is truthy **in the same
  scope**, and then as "unknown" (`null`), never "logged in": a key left over
  from the user's other tooling says nothing about Claude. Without a selector
  the key is ignored (and the process-key warning does not name it). The
  direct `ANTHROPIC_*` / `CLAUDE*` keys still count as a login.
- **Re-keyed handoff rows.** A handoff row names one session. When the same
  task moves to the same account again under a different session id, the old
  session's copies are removed after the new copy succeeds; any that cannot be
  removed (a failed unlink, the account's root changed) stay on disk and in the
  row under a session id they no longer match, so cleanup skips them
  (`isHandoffCopyShape` is tied to the recorded id). A per-session handoff store
  would fix it and is out of scope. The transfer reports a warning.
- **Retained copies are lost with the task.** When a cleanup retains a copied
  file (the account's root was changed after the copy) the handoff row is kept
  so a later cleanup can remove it; but the row cascades with the task, so
  deleting the task afterwards forgets the file, which stays on disk.
- **A deleted primary merged file does not propagate key removals.** If the
  primary's `settings.json`, `.claude.json` or `config.toml` is deleted
  outright, the mirror treats it as "nothing to merge" (like an unreadable
  file), so keys it had written earlier stay on the backup. Deleting a *key*
  from a file that still exists, or a mirrored *file* from a directory that
  still exists, propagates.
- **Backup removal has a narrow directory-swap race.** `removeMirrorBackups`
  `lstat`s a directory, lists it, re-checks that it is the same inode and only
  then descends, so an agent that swaps a directory for a link in the window
  between those calls is mostly but not entirely excluded: Bun's `fs` has no
  fd-based directory operations to close it. The window is reduced, not closed.
- **A backup's own edit to something the mirror owns loses to the primary**
  (the primary wins), reversibly: it is saved first and Restore brings it
  back, but it is not preserved in place.

## Risks

- A mid-turn resume may repeat a tool whose result was lost. Accepted by the
  owner; the continuation prompt says not to repeat completed steps.
- A false limit classifier burns a backup. The negative table is the mitigation.
- A backup with a lower plan/model cannot run the task's model; selection skips
  a known-excluding catalog and an unknown catalog fails open.
- A profile-bound task's frozen snapshot still names the original account while
  `task.agent` moves. Same-kind stacks keep the prompt kind and model valid.
- Mirror/copy latency makes the swap gap seconds; the task stays `running` and
  the copy is cooperative.
