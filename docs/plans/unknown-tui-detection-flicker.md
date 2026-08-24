# Plan — Fix false-positive "unknown Claude Code TUI" fallback card flicker

| Field | Value |
| --- | --- |
| Date | 2026-08-22 |
| Source | User request: "fix the unknown Claude Code TUI warning that is wrongly detecting normal messaging for a fraction of time which is making the card flickering between the `answer` status and the `run` status" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Flags | none |
| Gates | grill dismissed by owner (no answer) → self-resolved autonomously; decisions recorded in §8 |
| Branch | fix/fix-unknown-tui-detection (already checked out) |
| Base SHA | 1e5f65491e9f059a29da52bedee0604df98e5139 (tree clean) |

## 1. Objective & success criteria

The #185 fallback card (`matchUnparsableModal`, "Claude is asking something Agetor can't
read") must stop registering during **normal** Claude Code 2.1.239 activity, which today
makes the board card flip between the **Answer** state (amber ring / `pendingInteractionCount`)
and **Run**, and fires a spurious native "waiting on you" notification each flip.

Success:
- No fallback card (and no notification) registers while a turn is working normally:
  streaming, thinking, running a tool (incl. long shells), or waiting on background agents —
  even across the long JSONL-quiet windows those produce.
- A genuinely unknown/unparsable **prompt** (the 2.1.234+ auto-mode wizard, a footer-bearing
  modal no matcher parses) still surfaces the card, at boot and mid-session.
- Usage-limit **auto-continue** notices (`Usage limit reached · continuing automatically …
  · esc to cancel`) do not surface a card — nothing for the user to answer; claude resumes
  itself.
- `bun run typecheck` green; `bun test` green (modulo the known pre-existing flake noted in
  the fleet's claude-tmux-queue timing note); new 2.1.239 fixtures assert both the
  non-firing (normal work) and firing (real wizard) cases.

## 2. Context & constraints (Phase 1 findings — all with evidence)

Live evidence: 4 running agetor sessions watched read-only for ~9 min (555 ticks), plus 6
throwaway claude **2.1.239** tmux sessions (~190 deduped frames) covering idle, argv turn,
pasted follow-up, queued-while-busy follow-up, long `sleep` shell, background-Agent wait,
AskUserQuestion mid-turn, auto + manual modes. Installed claude is **2.1.239**; the running
release build is Agetor 0.1.1 with the #185 code bundled (verified the shipped
`MODAL_FOOTER_RE`/`SPINNER_RE`/`STUCK_TURN_FALLBACK_MS` in `bun/index.js`).

- **The registration→resolution path** (`src/bun/claude-tmux.ts:3921-4118`): `scrapeOnce`
  runs each `SCRAPE_INTERVAL_MS` (1s). `claudeIsWriting` = JSONL appended < `JSONL_RECENT_WRITE_MS`
  (500ms) ago (`:3982`). The match chain is
  `matchNumberedModal ?? matchYesNoModal ?? matchUnparsableModal(tail, stuckTurnFallbackArmed(...))`
  (`:4041-4049`), forced null while `claudeIsWriting` or an ask "question" modal is on-pane.
  The **`__external__` auto-cancel sweep** (`:4051-4060`) runs **every tick** — including
  `claudeIsWriting` ticks where match is null — and resolves any registered prompt whose
  fingerprint isn't the current match. So register (2 lucky consecutive-tick matches) →
  next JSONL write / pane change → sweep resolves ≈ 1s later → **flicker**. The two-tick
  gate (`clearedStabilityGate`, `:3513`) needs the **same fingerprint on two consecutive
  ticks**; `scrapeLastFingerprint` resets to null on any null-match tick (`:4072`).
- **Board effect** (why it reads as answer↔run): registering a `tmux_prompt` never changes
  `task.column`; it bumps `pendingInteractionCount` (`db.ts:286` ← `interactions.ts` counts,
  incl. `unparsable`). `TaskCard.tsx:53-67` renders `awaiting` (amber ring + "Answer") when
  `pendingCount>0`. `App.tsx:609-635` optimistically increments on the `interaction` SSE
  `pending` event **and** fires `notifyWaitingInput` on the first pending interaction — so
  each spurious registration is also a native notification.
- **Stale TUI signals (the core drift).** `SPINNER_RE=/esc to interrupt/i` (`:3889`) and
  `VOLATILE_PANE_LINE_RE=esc to interrupt|^\s*Tip:` (`:3896`) no longer describe 2.1.239:
  - Working indicator is now a **ticking spinner line**: `✽ Frosting… (2m 52s · ↓ 12.1k
    tokens)`, `✻ Cooked for 2m 18s`, `✻ Brewed for 9s · 1 shell still running`,
    `✻ Waiting for 1 background agent to finish` (glyph cycles `✻ ✽ ✶ ✳ ✢ ·`).
  - `esc to interrupt` moved into the **status bar** (`⏵⏵ auto mode on (shift+tab to cycle)
    · esc to interrupt · ← 1 agent`) and **blinks on/off at ~1 Hz** (watcher logged it
    toggling `true→false→true` every tick). During background-agent waits and long tool
    calls it is **absent for the whole window** while JSONL is silent.
  - Consequence A — **watchdog false-fires**: `stuckTurnFallbackArmed` (`:3572`) = turnInFlight
    && jsonlQuiet>60s && `!tailHasSpinner` && !askCardLive. Normal long-quiet turns satisfy
    all four (my Fable/auto session: **9 JSONL gaps >60s in 25 min**; bg-agent wait shows no
    `esc to interrupt` at all). → a working turn is flagged "stuck" → card.
  - Consequence B — **fingerprint/activity jitter**: the animated glyph + `(… · ↓ N tokens)`
    counter line is not in `VOLATILE_PANE_LINE_RE`, so it changes the fallback fingerprint
    and the activity diff tick-to-tick.
- **Footer arm is clean for real prompts, but catches notices.** Across all normal-work
  frames, **no** frame carried a `MODAL_FOOTER_RE` phrase in its last 3 non-blank lines; a
  real modal (AskUserQuestion, permission) or wizard **replaces** the status bar. The only
  normal-session strings matching `MODAL_FOOTER_RE` are usage-limit notices — from the
  2.1.239 binary: `Usage limit reached · continuing automatically at <t> · esc to cancel`,
  `… continuing shortly · esc to cancel`, `… continuing automatically when it resets · esc
  to cancel`, and `Usage limit has reset · press enter to continue`. The first three are
  **auto-continue** (nothing to answer).
- **AskUserQuestion is NOT the flicker source.** `detectAskModal` (needs `Chat about this`
  + `Esc to cancel`) drives the structured-card path and suppresses the generic matchers
  while a question modal is on-pane; the `WOULD-FIRE footer=true` hits the watcher logged
  were exactly such a modal (this session's own grill), which the real scraper suppresses.
- **Runnability**: `bun run typecheck`, `bun test`, per-file
  `bun test src/bun/claude-tmux-scraper.test.ts` (54 pass standalone; auto-mkdtemps its own
  `AGETOR_DATA_DIR`). No e2e harness; convention is pane-string fixtures + pure-function
  gates. `bun` is at `~/.bun/bin/bun`; tmux/claude at `/opt/homebrew/bin/tmux`,
  `~/.local/bin/claude`. Manual smoke only against `~/.agetor-dev` (never prod `~/.agetor`).
- **Existing tests**: `claude-tmux-scraper.test.ts` (~lines 524-788) exercise
  `matchUnparsableModal`/`stuckTurnFallbackArmed`/`MODAL_FOOTER_RE` with inline pane strings;
  none drive `scrapeOnce` across a working↔quiet transition (the actual flicker path is
  uncovered). `interactions.test.ts` covers the `unparsable` flag + `__external__` resolve.

## 3. Approach & key decisions

The fix is entirely inside the scraper's detection logic in `src/bun/claude-tmux.ts` +
its test file. No UI, interactions, orchestrator, or contract change (the card renders fine;
the defect is that it should never have registered). Four coordinated changes:

1. **Sync a `WORKING_LINE_RE` to 2.1.239** (evidence-backed, extensible like `MODAL_FOOTER_RE`)
   recognizing claude is busy on the pane: the ticking-spinner line (a leading spinner glyph
   from `✻✽✶✳✢·` followed by a word and `…`, OR `<Word> for <n>s`/`(…s · … tokens)` elapsed
   forms), `Waiting for N background agent`, `N shell[s] still running`/`· N shell`, and the
   legacy `esc to interrupt`. Fold it into `VOLATILE_PANE_LINE_RE` (so the animated
   spinner/counter never jitters fingerprints or the activity diff) and expose a pure
   `paneShowsClaudeWorking(tail: string): boolean`. Decision: keep `SPINNER_RE` as one input,
   but stop treating `esc to interrupt` as the *sole* busy signal — its 1 Hz blink is exactly
   what makes the current guard unreliable.
2. **Gate both fallback arms on `!paneShowsClaudeWorking(tail)`.** The footer arm and the
   watchdog arm only fire when the pane shows claude is *not* visibly working. This kills the
   watchdog false-positive on background-agent waits and long tool calls (they now read as
   working) and hardens the footer arm against a stray phrase during a working frame. Rests
   on the measured fact that a real prompt/wizard replaces the working chrome (§2), so the
   gate can't hide a genuine prompt.
3. **Raise unparsable stability to ≥3 consecutive ticks** (from 2). Add a small
   `scrapeUnparsableStreak` counter in `SessionState`: increment when this tick's unparsable
   fingerprint equals last tick's, reset on any change/non-match; register only at
   `UNPARSABLE_STABILITY_TICKS` (3). Real prompts sit on screen for many seconds, so this is
   free for true positives but defeats a 1–2 tick blip. (Parseable numbered/yes-no/ask paths
   are untouched — they keep their existing gates and high-confidence fast path.)
4. **Exclude usage-limit auto-continue notices.** A `MODAL_NOTICE_RE`
   (`/continuing automatically|continuing shortly|continuing now/i`) that, when present in the
   footer window, vetoes the footer arm — claude resumes itself, nothing to answer. Decision
   (§8): keep `Usage limit has reset · press enter to continue` eligible (it is genuinely
   actionable), suppress only the auto-continue variants.

The watchdog arm is **kept, not removed**: with gate (2) applied it still catches a genuinely
wedged, footerless TUI (no working chrome, no JSONL, quiet past threshold) — its original
purpose — without firing on the normal long-quiet turns that were the false-positive source.
Threshold left at 60s (gate (2) already removes the false positives; raising it would only
delay a true catch).

Boot poller (`:4894`) already passes `watchdogArmed=false`; add the same
`!paneShowsClaudeWorking` guard + notice veto to its footer-arm call so boot behaves
identically (a real startup wizard has no working chrome, so it still surfaces).

## 4. Work breakdown — implementation tasks

**Wave 1 — single task (localized, one file; no parallel fan-out warranted).**
- **T1 — Detection sync + arm gating.** Owns `src/bun/claude-tmux.ts` only.
  - Add `WORKING_LINE_RE` + `MODAL_NOTICE_RE` (evidence comments citing the 2.1.239 forms in
    §2); refactor `VOLATILE_PANE_LINE_RE` to include `WORKING_LINE_RE`; add pure
    `paneShowsClaudeWorking(tail)`.
  - Gate the runtime match chain (`:4041-4049`) footer+watchdog behind `!paneShowsClaudeWorking`
    and the notice veto; thread the same into the boot poller (`:4894`).
  - Replace `matchUnparsableModal`'s implicit 2-tick reliance with the `scrapeUnparsableStreak`
    ≥3 gate: add `scrapeUnparsableStreak: number` to `SessionState` (init 0 where the other
    scrape fields init), increment/reset in `scrapeOnce`, register only at the threshold; keep
    the `unparsable` match itself never `highConfidence`.
  - Keep `stuckTurnFallbackArmed`'s signature stable but change its `tailHasSpinner` input to
    the broader `paneShowsClaudeWorking` at the call site (or add a `paneWorking` param) — do
    not silently drift the two.
  - Export new pieces (`WORKING_LINE_RE`, `MODAL_NOTICE_RE`, `paneShowsClaudeWorking`,
    `UNPARSABLE_STABILITY_TICKS`) in `__forTest`.
  - Acceptance: typecheck green; auto-mode wizard still registers; a bg-agent-wait / long-shell
    / ticking-spinner pane never registers; numbered/yes-no/ask precedence unchanged.

## 5. Work breakdown — test tasks

**Wave 2 — single task (after T1 lands `__forTest` exports).**
- **T2 — Scraper tests + 2.1.239 fixtures.** Owns `src/bun/claude-tmux-scraper.test.ts`
  (+ any new fixture strings inline, matching the file's convention).
  - `paneShowsClaudeWorking` truth table over real 2.1.239 forms: ticking spinner
    (`✽ Frosting… (2m52s · ↓12.1k tokens)`), `✻ Cooked for 2m18s`, `✻ Waiting for 1
    background agent to finish`, `✻ Brewed for 9s · 1 shell still running`, status-bar
    `esc to interrupt`; false on an idle input-box pane and on the auto-mode wizard.
  - Footer arm: does **not** fire on any working pane above; does **not** fire on
    `Usage limit reached · continuing automatically at 8am · esc to cancel`; **does** fire on
    the auto-mode wizard and on a footer-bearing unknown modal with no working chrome.
  - Watchdog arm: `stuckTurnFallbackArmed`/`paneShowsClaudeWorking` combination — a
    bg-agent-wait pane (turn in flight, jsonl quiet >60s) does **not** arm because the pane
    shows working; a truly blank/wedged pane still arms.
  - Stability: an unparsable match needs 3 consecutive equal-fingerprint sightings; a 1–2
    tick blip never registers. (Drive via the exported streak helper or a minimal
    `scrapeOnce` seam if one exists; otherwise assert the pure gate.)
  - Regression: fingerprint stable across the animated glyph + token-counter changing between
    ticks (now stripped by the widened `VOLATILE_PANE_LINE_RE`).
  - Keep the existing 15 fallback tests passing (adjust only where behavior deliberately
    changed, with a comment explaining why).

**E2e: not applicable.** No e2e harness; the scraper's contract is pane-string fixtures +
pure gates. Manual smoke (owner, later): run a claude task in `~/.agetor-dev`, drive a long
tool call / background-agent wave, confirm no flicker; trigger the auto-mode wizard, confirm
the card still appears.

## 6. Execution waves

1. Wave 1: T1 (implementation runner = sonnet).
2. Review (opus): diff vs base `1e5f654`; rubric incl. "does the working-gate ever hide a
   real prompt?" and precedence of parseable matchers.
3. Wave 2: T2 (tests runner = sonnet).
4. Run (haiku / direct): `bun run typecheck` + `bun test src/bun/claude-tmux-scraper.test.ts`
   + `bun test src/bun/interactions.test.ts`, then full `bun test`. Fix loop as needed (≤3
   rounds).

## 7. Blast radius & risks

- **Under-firing (new risk we accept small)**: gate (2) could suppress a real prompt if a
  genuine prompt ever co-rendered with working chrome. Measured false: a real prompt replaces
  the status bar. Mitigation: the watchdog (still present) catches a footerless wedge; the
  footer arm still fires the instant working chrome clears.
- **`WORKING_LINE_RE` breadth**: too broad and it could mask a real modal that happens to
  contain a matched word. Mitigation: anchor the spinner form on the leading glyph + `…`/
  elapsed pattern, and keep it evidence-backed (comment each phrase to a captured 2.1.239
  frame), exactly like `MODAL_FOOTER_RE`.
- **Fingerprint change**: widening `VOLATILE_PANE_LINE_RE` changes `normalizePaneForActivity`
  and the fallback fingerprint — intended (kills jitter), but re-confirm the reaper's activity
  diff still bumps on real transcript changes (a working line stripped, real content not).
- **Version-proofing**: 2.1.240+ may rename spinners again; the watchdog arm + the evidence
  comment (add-a-phrase-with-a-captured-pane rule) are the maintenance contract.
- Files churned since #185 (`1e5f654`/#189 RunPanel, `2f2316b`/#188, `c141b73`/#187) do not
  touch the scraper matchers — no conflict.

## 8. Open questions / assumptions — self-resolved (owner dismissed the grill)

| Question | Answer | Source | Confidence |
| --- | --- | --- | --- |
| What is claude doing when the card flickers? | Normal work: mid-turn streaming/tool, and especially background-agent waits / long tool calls (long JSONL-quiet windows). | Live watcher + JSONL gap stats (9 gaps >60s/25min); watchdog-arm analysis | High |
| Is AskUserQuestion the trigger? | No — `detectAskModal` suppresses it; the observed `WOULD-FIRE` was a real ask modal the production scraper suppresses. | Source + watcher | High |
| Suppress usage-limit auto-continue notice? | Yes — no user action; keep `press enter to continue` eligible. | 2.1.239 binary strings; recommended option | Med-High |
| Remove the watchdog arm entirely? | No — keep it, but gate on `paneShowsClaudeWorking` so it only catches a true footerless wedge. Removing it would drop the only net for footerless unknown prompts. | Design judgment | Medium |
| Raise the 60s watchdog threshold? | No — gate (2) removes the false positives; a higher threshold would only slow a real catch. | Design judgment | Medium |
| Change the card copy/UX? | No — complaint is false-firing, not copy. Out of scope. | Request scope | High |

**No one-way doors**: no data migration, no public API/contract change, no auth/tenancy
change — all changes are reversible detection-logic edits behind tests.

## 10. Post-review addendum (2026-08-22)

Two review passes ran on the implementation (opus sub-agent, then `/code-review`); every
valid finding was applied and re-verified. Net changes on top of §3:

- **Notice veto window** — `MODAL_NOTICE_RE` is checked over the card's own 12-line
  stripped window (`paneLines`), not the last 3 lines: claude draws notice-class lines in
  the hint slot *above* the input box (5 non-blank rows from the bottom for the observed
  weekly-limit hint), outside the footer window but inside the card's. The veto is an early
  return before **both** arms (a footer-only veto let the 60 s watchdog still card a
  mid-turn limit pause). `press enter to continue` in that slot reaches the user via the
  watchdog arm, not instantly — documented on `MODAL_NOTICE_RE`.
- **Bounded working-chrome window** — `paneShowsClaudeWorking` inspects only the last
  `WORKING_CHROME_WINDOW_LINES` (16) non-blank lines (the widget area; deepest live capture
  was 13 with 4 background agents), so transcript text that merely resembles chrome (a tool
  result echoing a pane, prose like `· 3 shell scripts`, `Waiting for 2 background agents`)
  can't hide a real prompt rendered below it. Every arm is also anchored to its chrome
  shape (leading `SPINNER_GLYPH`; spinner `…` must be followed by `(` or EOL; status-bar
  shell item must be `·`-delimited).
- **Elapsed spinner form** added (`✻ Cooked for 2m 18s`), `SPINNER_RE` deleted, shared
  fragments (`ESC_TO_INTERRUPT`, `SPINNER_GLYPH`, `SPINNER_ACTIVE_LINE`,
  `SPINNER_ELAPSED_LINE`, `TOKEN_COUNTER_LINE`) are the single source of truth for both
  `WORKING_LINE_RE` and `VOLATILE_PANE_LINE_RE`.
- **Streak logic extracted** into pure `nextUnparsableStreak` / `unparsableStreakCleared`
  (exported via `__forTest`) and driven by sequence tests (A,A,A registers on the 3rd;
  A,B,A and A,A,∅,A,A never; 1–2-tick blips never).

Verification after the addendum: `bun run typecheck` clean; scraper file 84 pass / 0 fail;
interactions 22 pass; full suite green (see final report). Manual smoke in `~/.agetor-dev`
remains the owner's step.
