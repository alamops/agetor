# Plan — Fallback card for unknown/unparsable Claude Code prompts

| Field | Value |
| --- | --- |
| Date | 2026-08-18 |
| Source | User request + screenshot of Claude Code 2.1.234 "Set up auto mode" startup wizard |
| Config | AGENTS_CONFIG.yml (balanced) |
| Flags | none |
| Branch | fix/missing-unknown-claude-code-prompts-in-a (cut from main @ 295d91e) |
| Base SHA | 295d91eb0c6ca10e0a6e4b79103551941f6c7b49 (tree clean except this plan file) |

## 1. Objective & success criteria

When Claude Code sits blocked on an interactive prompt that none of agetor's matchers can
parse, the RunPanel must show **something**: a fallback interaction card with the raw pane
text and an **Open in Terminal** button (the existing Attach flow), instead of today's
silence. Success:

- The screenshotted "Set up auto mode for your environment?" wizard (claude 2.1.234)
  surfaces a card — at boot *and* mid-session — and the boot timeout no longer kills the
  run while it's on screen.
- Any future unknown modal with a recognizable claude footer does the same.
- A turn that is silently stuck (>60s, no JSONL, no working spinner) surfaces the card too.
- The card auto-resolves when the prompt is answered in the attached terminal (existing
  `__external__` sweep) and never fires while claude is working or idle at the input box.

## 2. Context & constraints (Phase 1 findings)

- **The gap**: `scrapeOnce` tries only `matchNumberedModal ?? matchYesNoModal` for
  non-AskUserQuestion panes (`src/bun/claude-tmux.ts:3931-3933`); on null it silently
  returns (`:3955-3958`). The boot poller mirrors the same two matchers and silently
  `continue`s on no-match (`:4767-4810`), so an unmatched startup prompt strands the run
  until `BOOT_TIMEOUT_MS` (30s) kills it.
- **Prompt families that fall through**: unnumbered arrow-key widgets (the screenshot),
  free-text/device-code auth prompts, single-option modals (`numbered.length < 2` rejects),
  prose confirmations, update notices, new startup dialogs absent from
  `STARTUP_CONSENT_DIALOGS`.
- **The screenshot prompt**: header question, prose description, `◂ Mixed ▸` value
  selector, `[ ]` checkbox rows with `❯` cursor, bold `Continue`, footer
  `←/→ to change usage · Enter to continue · Esc to cancel`. Cannot be auto-answered
  (privacy choice — scanning shell history) and is too widget-rich to drive remotely; the
  fallback card + Attach is the *designed* handler, not a stopgap.
- **Registration infra**: `registerTmuxPrompt` (`src/bun/interactions.ts:272-306`) creates
  a `TmuxPromptRequest`, broadcasts on the task SSE stream + a global notification event
  (`orchestrator.ts:475-522`). The `__external__` sweep (`claude-tmux.ts:3935-3944`, boot
  analogue `:4775-4782`) resolves any registered prompt whose fingerprint no longer matches
  the live pane — so a fallback "match" must keep producing a stable fingerprint every tick
  while the modal is up, or the sweep kills its own card.
- **Stability gates**: `clearedStabilityGate` (`:3507-3509`) — two-tick fingerprint
  stability, with an Esc-footer high-confidence fast path. The fallback will use the
  two-tick path only (repaint/paste transients must never register a card).
- **Working/idle signals**: `claudeIsWriting` = JSONL grew < 500ms ago (`:3872`);
  `turnInFlight(state)` (`:4294-4297`); raw tail contains `esc to interrupt` while a turn
  streams (the spinner line, `VOLATILE_PANE_LINE_RE:3786`); `state.lastJsonlAppendAt`.
- **AskUserQuestion routing**: when `detectAskModal` fires, generic matchers are suppressed
  unless `askFallbackAllowed` latches after `MAX_ASK_GROW_ATTEMPTS=3` (`:3744`). Once that
  latch opens and numbered/yes-no *also* fail, the new fallback becomes the final net — the
  intended completion of the existing give-up path.
- **Attach**: `POST /tasks/:id/open-tmux` (`server.ts:3571-3654`) → `healWindowSize` →
  AppleScript → Terminal.app `tmux attach`; client `api.openTmux(taskId)`
  (`api.ts:1306-1308`). Reused as-is (owner decision).
- **UI**: interaction cards render via the `renderInteraction` switch on `kind`
  (`RunPanel.tsx:3953-3968`); `TmuxPromptCard` (`:5522-5670`) is the visual template;
  `modalPending = interactions.length > 0` (`:1546`) gates the composer automatically for
  any pending interaction. `PendingTmuxPrompt` is hand-mirrored in
  `src/mainview/lib/api.ts:190-223` (not shared/types.ts).
- **Tests**: `claude-tmux-scraper.test.ts` uses inline pane-string fixtures + the
  `__forTest` export bag; nothing currently exercises the all-matchers-null fallthrough.
- **Runnability**: `bun run typecheck` + `bun test` (per file:
  `bun test src/bun/claude-tmux-scraper.test.ts`). No e2e harness exists; live tmux/claude
  is not exercised by the suite (fake drivers + pane fixtures are the convention).

## 3. Approach & key decisions

1. **Reuse the `tmux_prompt` interaction kind with an `unparsable: true` flag and
   `choices: []`**, rather than a new interaction kind. Rationale: the fallback card *is* a
   tmux prompt — it lives in the same `tmuxPrompts` map, so the `__external__`
   sweep, `listPendingForTask`, SSE broadcast, global notification, and `modalPending`
   gating all work unchanged. A new kind would force parallel plumbing through
   interactions.ts, server.ts, api.ts, and the sweep for zero user-visible gain.
2. **Footer-gated detection** (`matchUnparsableModal`): fires only when the last 3
   non-blank tail lines contain a claude modal footer
   (`/esc to cancel|enter to confirm|enter to continue|esc to go back/i` — checked over
   non-blank lines because tmux capture emits trailing blank rows, same as
   `clearedStabilityGate`). Runs strictly after `matchNumberedModal` and `matchYesNoModal`
   return null, so parseable modals always win. Fingerprint = sha1 of the cleaned tail
   block, stable across ticks while the modal is up. Two-tick stability gate, **no**
   high-confidence fast path (footer presence is the trigger itself, not extra confidence;
   transient paste/repaint frames must age out).
3. **Stuck-turn watchdog** as a second trigger for the *same* match: when
   `turnInFlight && now - lastJsonlAppendAt > STUCK_TURN_FALLBACK_MS (60s)` and the raw
   tail has no `esc to interrupt` working spinner and no ask card/collection is live,
   `matchUnparsableModal` fires even without a footer (footerless unknown prompt or a
   wedged TUI). Decision extracted as a pure function for unit tests. The condition stays
   true while stuck, so the fingerprint persists and the sweep doesn't kill the card; when
   JSONL resumes or the pane moves on, the match disappears and the sweep resolves the card
   `__external__`.
4. **Boot-window coverage**: the boot poller, after `matchNumberedModal ?? matchYesNoModal`
   returns null, tries footer-gated `matchUnparsableModal` (watchdog arm excluded — no turn
   in flight at boot) and registers the fallback card through the existing generic-card
   path, setting `sawStartupPromptThisWindow` so the boot window re-arms instead of dying
   at 30s. This is the exact fix for the screenshotted wizard, which appears pre-JSONL.
5. **Card UX** (owner decisions): explanation line ("Claude is asking something agetor
   can't read — answer it in the terminal"), cleaned pane preview (`cleanPromptPane`,
   `whitespace-pre-wrap break-words`), one primary **Open in Terminal** button →
   `api.openTmux(task.id)` with the route's error taxonomy surfaced via toast
   (`tmux-missing` / `session-missing`). No Esc button (declined). No in-app terminal
   (declined — Terminal.app reuse). Auto-resolve note in muted text.
6. **No dedicated matcher for the auto-mode wizard**: it can't be auto-answered and can't
   be safely driven remotely; the fallback card is the correct terminal state. Its pane
   text becomes the canonical test fixture instead.
7. **Task stays `running`** with a pending interaction (matches every other prompt card;
   `blocked` remains reserved for dead sessions).

## 4. Work breakdown — implementation tasks

Wave 1 (parallel, file-disjoint):

- **T1 — Bun-side detection + registration.** Owns `src/bun/claude-tmux.ts`,
  `src/bun/interactions.ts`.
  - `interactions.ts`: add optional `unparsable?: boolean` to `TmuxPromptRequest`;
    `registerTmuxPrompt` passes it through (empty `choices` already legal).
  - `claude-tmux.ts`: add `MODAL_FOOTER_RE`, `STUCK_TURN_FALLBACK_MS = 60_000`;
    `matchUnparsableModal(tail, opts)` returning a `ScrapeMatch`-shaped
    `{fingerprint, paneText, choices: [], cursorIndex: 0, unparsable: true}` under (a) the
    footer signal or (b) the watchdog signal (pure decision helper
    `stuckTurnFallbackArmed({turnInFlight, lastJsonlAppendAt, now, tailHasSpinner,
    askCardLive})`); wire it as the final `??` arm at `:3931-3933` (runtime) and into the
    boot poller's generic branch (`:4767-4810`) footer-arm-only + set
    `sawStartupPromptThisWindow`; thread `unparsable` into `registerTmuxPrompt`; ensure the
    two-tick gate applies (no high-confidence for unparsable matches); export new pieces in
    `__forTest`.
  - Acceptance: typecheck green; auto-mode pane registers via footer arm; sweep resolves it
    when the pane moves on; numbered/yes-no/ask matches always take precedence.
- **T2 — Webview card.** Owns `src/mainview/lib/api.ts`, `src/mainview/components/kanban/RunPanel.tsx`.
  - `api.ts`: mirror `unparsable?: boolean` on `PendingTmuxPrompt`.
  - `RunPanel.tsx`: in `TmuxPromptCard`, branch on `req.unparsable` (or empty `choices`):
    warning-tinted card, `Terminal` icon, explanation line, cleaned pane `<pre>`
    (existing `cleanPromptPane`), primary "Open in Terminal" button → `api.openTmux` with
    `toast.error` on failure (same copy pattern as the TaskDetails Attach button), muted
    "resolves automatically once answered" hint. Semantic tokens only (`bg-warning/10`
    etc.), no literal palette classes.
  - Acceptance: typecheck green; card renders from a synthetic interaction; composer is
    gated while pending (comes free via `modalPending`).

No shared files between T1 and T2 (`api.ts` mirror is hand-maintained by design). The type
contract between them is fixed by this plan (§3.1), so they can run concurrently.

## 5. Work breakdown — test tasks

- **T3 — Scraper tests.** Owns `src/bun/claude-tmux-scraper.test.ts` (+ optional fixture
  file under `src/bun/fixtures/`): the auto-mode wizard pane as fixture (from the
  screenshot); assert `matchNumberedModal`/`matchYesNoModal` both null on it and
  `matchUnparsableModal` fires with a stable fingerprint; footer detection tolerates
  trailing blank rows; null on a normal idle pane, on a working/spinner pane, and on a
  numbered-modal pane; `stuckTurnFallbackArmed` truth-table (in-flight/quiet/spinner/ask
  combinations); two-tick gate applies to unparsable matches.
- **T4 — Interactions test.** Owns `src/bun/interactions.test.ts`: register a
  `tmux_prompt` with `choices: []` + `unparsable: true`, assert broadcast shape and
  `__external__` resolution path.

**E2e: not applicable.** The repo has no e2e harness; the scraper's convention is pane-text
fixtures + pure-function gates (live tmux/claude is explicitly out of test scope). Manual
smoke: run a claude task in `~/.agetor-dev` (never prod `~/.agetor`) and observe the card.

## 6. Execution waves

1. **Wave 1**: T1 + T2 in parallel (Phase 4).
2. **Review** (Phase 5): diff vs base, opus.
3. **Wave 2**: T3 + T4 in parallel (Phase 6) — after T1 lands `__forTest` exports.
4. **Run** (Phase 7): `bun run typecheck` + `bun test`; fix loop (Phase 8) as needed.

## 7. Blast radius & risks

- **False positives** are the main risk: a fallback card gates the composer. Mitigations:
  footer allow-list (not a "looks boxy" heuristic), strict post-precedence ordering,
  `claudeIsWriting` gate, two-tick stability, 60s watchdog threshold + spinner exclusion.
  A transient card self-heals via the `__external__` sweep, but we bias to precision.
- **Sweep interaction**: the fallback match must re-fire with the same fingerprint every
  tick while the modal is up, or the sweep resolves its own card — covered by
  fingerprinting the cleaned tail and by the watchdog condition being persistent.
- **Boot re-arm**: reuses the existing `sawStartupPromptThisWindow` machinery (proven by
  the Chrome-extension-prompt fix); a genuinely hung boot with no prompt still dies at 30s.
- **AskUserQuestion give-up path**: after `askFallbackAllowed` latches, an unparsable ask
  modal now lands on the fallback card instead of nothing — intended, but T3 should pin
  precedence so a *parseable* ask modal never reaches it.
- Recent churn in the same files (#183/#184 touched `claude-tmux.ts`/`RunPanel.tsx`) — the
  branch is cut from `295d91e` (post-both), so no conflict expected.

## 8. Open questions / assumptions

- Footer regex seeded with the four phrasings we have evidence for; future claude versions
  may add new footer texts (extending the regex is a one-line change, and the watchdog arm
  is the version-proof net for in-turn prompts).
- The watchdog threshold (60s) is a judgment call approved by the owner; not empirically
  tuned.
- Boot-window watchdog arm is deliberately excluded (no turn in flight; boot has its own
  timeout semantics).
