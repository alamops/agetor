# Plan — Fix stranded "Submit answers" on AskUserQuestion drive

| Field | Value |
| --- | --- |
| Date | 2026-07-15 |
| Source | Agetor task: "task details get stuck on `submit answers` from claude code questions; TUI stays in tmux; user must attach and confirm manually" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/claude-code-not-submiting-answers |
| Base SHA | b49e3f878fe10f8d5fa3735034a5e49466b88d80 (tree clean) |
| Mode | Autonomous — grill + plan-approval gates self-served; assumptions logged in §8 |

## 1. Objective & success criteria

When a user answers a multi-question / multiSelect AskUserQuestion card from Agetor's task
details, the drive must reliably confirm the native TUI's "Ready to submit your answers?"
review screen — and when any keystroke is nonetheless swallowed, Agetor must self-heal
(retry, or surface a clickable card) instead of stranding the modal until the user attaches
to tmux manually.

Success =
- The confirm `Enter` is sent only after the review screen is actually rendered, and the
  drive result is verified against pane content (modal gone), not `send-keys` exit codes.
- A swallowed confirm is retried automatically (bounded).
- A review screen that persists anyway (or that the user reaches manually) produces a
  generic numbered-prompt card ("1. Submit answers / 2. Cancel") in the UI instead of
  being structurally invisible.
- `bun run typecheck` green, full `bun test` green, new unit tests cover the changed logic.

## 2. Context & constraints (Phase 1 findings)

- Drive plan: `planAskAnswers` (`src/bun/claude-questions.ts:434-501`). Every non-singleFlat
  plan ends with a bare trailing `Enter` (line ~498) that assumes the review screen is
  already rendered with cursor on "1. Submit answers".
- Driver: `sendModalKeys` (`src/bun/claude-tmux.ts:1243-1259`) — one `tmux send-keys` per
  key, flat 35ms gap, `stillCurrent()` re-gate. Success = every send-keys exited 0.
  **No pane-content verification anywhere on the drive path.** The transition onto the
  `✔ Submit` tab triggers Ink's heaviest repaint (full review summary); the confirm Enter
  arrives 35ms later and is intermittently swallowed → false `ok:true`.
- Route: `POST /ask-questions/:id/answer` (`src/bun/server.ts:3454-3499`) calls
  `resolveAskCard` unconditionally (intended: scraper re-collects on failure).
- The self-heal is structurally broken for the review screen: `scrapeOnce`
  (`src/bun/claude-tmux.ts:3011-3027`) computes `askOnPane = detectAskModal(tail) !== null`,
  which is true for BOTH `"question"` and `"review"`; it suppresses
  `matchNumberedModal`/`matchYesNoModal` whenever true, but `collectAndRegisterAskCard` →
  `parseModalPane` requires question/footer signatures the review screen lacks, and the
  JSONL has no tool_use until the modal is answered. Net: a stranded review screen matches
  nothing, forever, on every tick.
- `matchNumberedModal` (`claude-tmux.ts:~2620-2732`) WOULD match the review screen
  (`❯ 1. Submit answers` / `2. Cancel`: ≥2 numbered choices, cursor marker, "1." anchor).
  No footer → not high-confidence → two-tick stability gate (~2 ticks) before registering.
- Prior art to mirror: `cycleToMode` verify-and-retry (only content-verified drive in the
  codebase); repo comment doctrine "prefer raising gaps over lowering"
  (`claude-tmux.ts:4610-4625`); `collectAskQuestionsFromPane`'s injectable `io`
  (capture/send/sleep) pattern for unit-testability; fixture
  `src/bun/fixtures/askuserquestion/review_submit.txt` (review screen, already used by
  `claude-questions.test.ts`).
- `captureTail(state)` (`claude-tmux.ts:1710`) captures the pane tail; usable inside
  `queueTmuxOp` callbacks.

## 3. Approach & key decisions

Three coordinated changes (defense in depth):

1. **Deterministic confirm**: teach the plan which drives end on the review screen
   (`confirmsReview: !singleFlat` on the drive-mode `SubmitPlan`), and replace the blind
   trailing 35ms-gap Enter with: send all body keys → poll `capture-pane` until
   `detectAskModal(tail) === "review"` (bounded, ~80ms steps up to ~800ms) → send Enter.
2. **Verify-and-retry**: after the full plan (and for singleFlat too), poll until
   `detectAskModal(tail) === null` (bounded). If `"review"` is still present after the
   confirm, resend `Enter` (max 2 resends — a stray Enter at the empty REPL is benign;
   a "question" sighting during verification is treated as "keep waiting" since it can be
   a teardown transient; genuine mis-drives time out to `ok:false`). New function
   `driveAskAnswers(taskId, plan)` in `claude-tmux.ts` wraps body-keys + confirm + verify
   inside one `queueTmuxOp`; `sendModalKeys` stays as-is for the Escape paths.
3. **Un-strand the review screen**: in `scrapeOnce`, narrow the ask-modal suppression to
   `detectAskModal(tail) === "question"`. A persistent review screen then flows to
   `matchNumberedModal` → a normal tmux_prompt card the user can click ("Submit answers"),
   and the existing auto-cancel sweep cleans it up if the modal leaves the pane.

Alternatives considered:
- Only raising the flat inter-key gap (e.g. 35→150ms): shrinks but does not close the race,
  and slows every drive. Rejected as sole fix; wait-for-render replaces it exactly where
  needed.
- Having the scraper auto-press Enter on a lingering review screen: decides on the user's
  behalf (they may have navigated there manually intending to cancel). Rejected — surface
  a card instead.
- Gating `resolveAskCard` on `ok`: unnecessary once the scraper backstop works (documented
  rationale for the unconditional resolve remains valid: clearing `askCardId` is what lets
  re-collection happen), and keeping the card while keys were partially driven would show a
  stale cursor-state card. Keep unconditional.
- Frontend `{ ok }` handling (RunPanel ignores it): with the backstop, a failed drive
  produces a fresh card within ~1-3s via the normal interaction channels. Out of scope.

Known acceptable edge: during a *retrying* drive the review screen can persist ≥2 scrape
ticks and register a ghost "Submit answers" card just as the retry lands; the next tick's
auto-cancel sweep (`answerTmuxPrompt(..., "__external__")`) resolves it. Rare, self-healing.

## 4. Work breakdown — implementation tasks

**T1 (single agent — the three files are one coherent change and the edits are small):**
- `src/bun/claude-questions.ts`: add `confirmsReview: boolean` to the drive variant of
  `SubmitPlan`; set it to `!singleFlat` in `planAskAnswers`; update the module docstring's
  drive-sequence description.
- `src/bun/claude-tmux.ts`:
  - Add `driveAskAnswers(taskId, plan)` (exported): inside one `queueTmuxOp` — send body
    keys (plan.keys minus the trailing confirm when `confirmsReview`) with the existing
    35ms gap + `stillCurrent()` re-gate; if `confirmsReview`, poll pane until review screen
    renders (WAIT_FOR_REVIEW: ~80ms steps, ≤10 attempts), then send Enter; verify with
    polls until `detectAskModal` returns null (VERIFY: ~120ms steps, ≤8 attempts), resending
    Enter on a `"review"` sighting at most 2 times; every sleep followed by a
    `stillCurrent()` re-gate. Return verified boolean. Structure the poll/decide logic as a
    pure, exported-for-test helper (mirror `__forTest` / injectable-io conventions) so unit
    tests need no tmux.
  - `scrapeOnce`: `const askKind = detectAskModal(tail); const askOnPane = askKind === "question";`
    (suppression + collect + card lifecycle all key off question-kind only). Update the
    block comment to explain why `"review"` deliberately falls through to the numbered
    matcher.
- `src/bun/server.ts`: import `driveAskAnswers`; in the `/ask-questions/:id/answer` drive
  branch call `ok = await driveAskAnswers(pending.taskId, plan)` instead of
  `sendModalKeys(pending.taskId, plan.keys)`. Escape paths unchanged.
- Acceptance: typecheck green; existing test suite green; no behavior change for
  singleFlat drives beyond added verification.

## 5. Work breakdown — test tasks

**TT1 (single agent):**
- `src/bun/claude-questions.test.ts`: assert `confirmsReview` on existing plan shapes
  (multi-question → true; single multiSelect → true; singleFlat → false; message-mode
  unaffected).
- `src/bun/claude-tmux-scraper.test.ts`: `matchNumberedModal` on the review-screen tail
  (from `fixtures/askuserquestion/review_submit.txt`) → 2 choices ("Submit answers",
  "Cancel"), cursor 0, not high-confidence.
- New tests for the drive verify logic (same file as sibling driver tests or a new
  `claude-tmux-askdrive.test.ts`): via the pure helper / injectable io — confirm Enter is
  sent only after review renders; swallowed-confirm (review persists) → Enter resent then
  ok; review persists past retries → false; question-screen sighting mid-verify then gone →
  true; question persists → false; singleFlat (no confirm wait) verifies modal-gone.
- Covers: T1.

## 6. Execution waves

- Wave 1: T1 (one sonnet agent — owns `src/bun/claude-questions.ts`,
  `src/bun/claude-tmux.ts`, `src/bun/server.ts`).
- Review (opus) on the wave-1 diff.
- Wave 2: TT1 (one sonnet agent — owns the test files only).
- Test run (haiku): `bun run typecheck` + `bun test`.
- Fixes as needed (sonnet), re-run to green.

## 7. Blast radius & risks

- `sendModalKeys` keeps its exact semantics (still used for `Escape` at
  `server.ts:3481`/`:3530`); only the answer-drive call site changes.
- Narrowing the scrapeOnce suppression: the `"review"` kind now takes the numbered-modal
  path. Two-tick stability prevents transient mid-drive review screens (<1s) from
  registering; the recently-answered TTL + auto-cancel sweep handle churn. The
  `askCardLive` full-rate polling and the modal-gone card resolution keep working —
  when review is on the pane and an ask card is still registered (user navigated manually
  via tmux attach), the card now resolves as externally-answered, which matches the
  existing external-dismissal backstop semantics.
- `collectAndRegisterAskCard`'s mid-collect abort checks `detectAskModal(...) === null` —
  unchanged and still correct (a review sighting mid-collect means the user advanced; the
  collect result is discarded on the next gate).
- Drive duration grows by the verification window (~120ms-1s typical, bounded ~2.5s worst
  case) — well under the route's ordinary latency expectations; the run panel already
  treats answering as async.
- Claude Code version drift: fixtures were captured on 2.1.161-2.1.183; if a future TUI
  changes the review wording, `detectAskModal` misses it and we fall back to today's
  behavior minus stranding (numbered matcher may still catch it). No regression vector.

## 8. Open questions / assumptions (autonomous mode — logged, not asked)

1. Assumed the intermittency is the Ink repaint race, not a Claude Code layout change —
   supported by "sometimes" in the report and by fixtures matching current signatures.
2. Assumed a stray `Enter` at the empty claude REPL prompt is a no-op (basis for benign
   bounded resends). Verified behavior on claude-code ≤2.1.183.
3. Assumed surfacing a clickable "Submit answers / Cancel" card is the right UX for a
   review screen Agetor cannot safely auto-drive (vs. auto-submitting on the user's
   behalf).
4. Frontend continues to ignore `{ ok }`; deemed out of scope since the backstop card
   makes failures visible and actionable.
