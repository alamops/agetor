# Plan — Stop `/model` & `/effort` responses being flagged as unknown prompts

| Field | Value |
| --- | --- |
| Date | 2026-08-25 |
| Source | User request: "agetor is detecting /model and /effort responses from Claude Code TUI as unknown messages, blocking sending messages in Task Details wrongly while asking the user to open the terminal. Fix it." |
| Config | AGENTS_CONFIG.yml (balanced) — investigate/implement/tests: sonnet, review: opus, test-run: haiku, planning: self |
| Flags | none |
| Gates | **grill self-resolved** (unattended agetor-launched session — no `ask_user` tool registered, owner cannot answer mid-task; see §8) · plan self-approved on the same basis |
| Branch | fix/model-and-effort (cut from main @ ef320a6) |
| Base SHA | ef320a6ea8a6fbbb44947a1cfcd0f8f44a0bbe38 (tree clean except this plan file) |

## 1. Objective & success criteria

Claude Code **2.1.245** handles `/model` and `/effort` entirely inside its Ink TUI. Today
every path by which those commands reach a task's live session ends in the #185 fallback
card ("Claude is asking something Agetor can't read — Open in Terminal", `tmux_prompt` with
`unparsable: true`), which gates the Task Details composer (`modalPending`) even though
the pane is either a perfectly parseable widget or a plain idle input box. Success:

- Typing `/model <id>` or `/effort <id>` in the composer prints claude's inline result,
  the run **settles** (`succeeded`) within ~1s of the `<local-command-stdout>` JSONL line,
  the composer stays usable, and **no** fallback card ever registers (today one appears
  60s later via the stuck-turn watchdog, on an idle pane, and never self-heals).
- Typing bare `/effort` surfaces a **clickable** card (low / medium / high / xhigh / max /
  ultracode) that drives claude's slider with ←/→ + Enter — not the Open-in-Terminal card.
- Typing bare `/model` keeps surfacing the existing numbered card (already parses on
  2.1.245 — pinned by a fixture) and, once answered, the run settles instead of hanging.
- Claude's new mid-conversation **"Switch model?" / "Change effort level?"** Yes/No confirms
  (2.1.245) are auto-accepted when the change came from agetor's own Task Details
  model/effort dropdowns (the user already chose), and relayed as a normal numbered card
  when the user typed the command themselves.
- The stuck-turn watchdog can no longer card a pane that shows claude **idle at the input
  box**; when a turn is provably over (idle box, JSONL quiet > 60 s, 3 stable ticks) the
  run is settled instead — the version-proof net for any future "no `end_turn`" case.
- `bun run typecheck` and `bun test` green; new 2.1.245 pane + JSONL fixtures pin every
  behaviour above.

## 2. Context & constraints (Phase 1 findings — all evidence-backed)

Live spike (claude **2.1.245**, tmux 3.6a, throwaway session in the scratchpad; three
passes, transcripts kept at `<scratchpad>/spikes/model-effort-pane/`):

- **`/model <id>` and `/effort <id>` are inline one-shots.** Pane after `/model sonnet`:
  `❯ /model sonnet` / `⎿  Set model to Sonnet 5 and saved as your default for new sessions`,
  input box immediately usable. JSONL appends exactly: a `file-history-snapshot`, a
  `type:"user", isMeta:true` line whose content is `<local-command-caveat>…</local-command-caveat>`,
  a `type:"user"` (non-meta) line `<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>`,
  and a `type:"user"` (non-meta) line `<local-command-stdout>Set model to Sonnet 5 and saved …</local-command-stdout>`
  (the model name is wrapped in ANSI bold escapes inside the stdout text).
  **Never** a `type:"assistant"` / `stop_reason:"end_turn"` line (0 across all three
  transcripts). First-command-in-a-fresh-session variant: the same two payloads arrive as
  `type:"system", subtype:"local_command", content:"<command-name>…"` / `content:"<local-command-stdout>…"`
  (flat, no `message` wrapper).
- **Bare `/model` = numbered picker**: `1. Default (recommended) …` … `❯ 6. Opus 4.8 ✔ …`,
  an extra `◉ xHigh effort ←/→ to adjust` row, footer
  `Enter to set as default · s to use this session only · Esc to cancel`. Probe against the
  real `__forTest` matchers: `matchNumberedModal` → 6 choices, `cursorIndex: 5`,
  `highConfidence: true` (footer carries `Esc to cancel`). Parseable today; it wins the chain
  over `matchUnparsableModal` (which would also fire on its footer).
- **Bare `/effort` = slider, no digits**: title `Effort`, `Faster … Smarter` legend, a track
  line of `─` with a single `▲` marker and a `┆` reference tick
  (`──────────────────────────────▲────────────┆──────────────────`), a label row
  `low     medium     high     xhigh      max       ultracode` (+ a sub-label row
  `xhigh + workflows` under the last), footer `←/→ to adjust · Enter to confirm · Esc to cancel`.
  Probe: numbered/yes-no null, `paneShowsClaudeWorking` false, `matchUnparsableModal`
  **fires on the footer arm** → the Open-in-Terminal card. Cursor↔label: `▲` at col 59 with
  labels starting at 29/37/48/57/68/78 → nearest centre = `xhigh` (header confirmed xHigh);
  second capture `▲` at col 49 → `high` (confirmed). Esc → `⎿  Cancelled` stdout line.
- **Mid-conversation `/effort <id>` and `/model <id>` pop a confirm** (2.1.245) when the
  value actually changes *and* an assistant turn has been generated since the last switch:
  `Change effort level?` / `Your next response will be slower and use more tokens` / `This
  conversation is cached for the current effort level. Switching to low means the full history
  gets re-read on your next message.` / `❯ 1. Yes, switch to low` / `  2. No, go back`; and
  `Switch model?` / … / `❯ 1. Yes, switch to Opus 5` / `  2. No, go back` (display name, not
  id). Footer-less; numbered → parses (not `highConfidence` → 2-tick gate). Only after Enter
  does the `<local-command-stdout>` land. The *same* command is inline (no confirm) when
  nothing changed or no assistant turn ran since the last switch — so both paths must be
  handled for one command shape. The confirm also appears after answering the slider with a
  different value.
- **Idle input box, verbatim** (last rows): `─`×120 top border, `❯ ` (bare prompt), `─`×120
  bottom border, then the status bar — one of five variants:
  `⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent`,
  `⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent`,
  `⏸ manual mode on · ? for shortcuts · ← 1 agent` (no `shift+tab` hint),
  `⏵⏵ accept edits on (shift+tab to cycle) · ← 1 agent`,
  `⏸ plan mode on (shift+tab to cycle) · ← 1 agent`. Every modal captured (picker, slider,
  both confirms, and the #185/#191 wizards) **replaces** the input box + status bar. Probe: on
  the idle-after-inline pane the footer arm is null but the **watchdog arm fires** when armed.
- **Why the run hangs** (`src/bun/claude-tmux.ts`): `sendTurn` (`:5300-5343`) pushes a
  `TurnSlot` and the slot is popped only by `popEndOfTurn` (`:2210`) — via a staged
  `pendingEndTurn` (`isEndOfTurnEvent` `:2247`, assistant-only), the 800 ms idle-fire
  (`END_TURN_IDLE_FIRE_MS` `:2204`, `flush` `:3306`), an interrupt `tool_result`, session
  death, or `signalUnknownCommand` (`:4547`, only for `● Unknown command: /x`). The `user`
  branch of `mapParsedEventToChunks` (`:860-970`) always returns `endOfTurn:false`; a
  `<local-command-stdout>` line is forwarded verbatim as a `user` chunk (the webview's
  `lib/command-message.ts` renders it as a "command output" bubble — that part already works).
  So `turnInFlight` (`:4581`) stays true forever; `stuckTurnFallbackArmed` (`:3579`) = in flight
  ∧ `lastJsonlAppendAt≠0` ∧ quiet > `STUCK_TURN_FALLBACK_MS` (60 s) ∧ ¬working ∧ no ask card
  → `matchUnparsableModal(tail, true)` (`:3637`) on the idle pane → after
  `UNPARSABLE_STABILITY_TICKS` (3) the fallback card registers (`:4278`) and, the pane being
  static, the `__external__` sweep (`:4198-4203`) never clears it.
- **Dropdown mirror path** (`orchestrator.ts:1541-1546` → `sendSlashCommand` `:5420`,
  non-bracketed `queuePaste` with `slashCommandSettleMs` 700 ms): pushes **no** slot, so it
  never hangs a run — but on 2.1.245 it now leaves the "Switch model?" / "Change effort
  level?" confirm on the pane, which the scraper turns into a numbered card the user has to
  click for a choice they already made in the dropdown. Both `after.model`/`after.effort` are
  guarded truthy, so this path never sends a bare command. `toClaudeModelArg` (`agents.ts:135`)
  maps agetor ids to claude's `/model` argument.
- **Answer driver**: `dismissTmuxPrompt` (`:1454`) arrow-navigates `Down`/`Up` by
  `targetIndex - cursorIndex` then Enter (digits are ignored by Ink's select-input); server
  route `server.ts:4206` passes `{choices, cursorIndex}`. Only vertical today.
  `registerTmuxPrompt` (`interactions.ts:280`) / `TmuxPromptRequest` (`:100-135`) /
  `PendingTmuxPrompt` (`api.ts:207`, hand-mirrored) carry `cursorIndex` + `unparsable`.
- **Chain**: runtime `scrapeOnce` `:4195-4202`
  (`matchNumberedModal ?? matchYesNoModal ?? (paneWorking ? null : matchUnparsableModal(...))`),
  boot poller generic branch `:5069`. `markTmuxPromptAnswered` (`:4298`) stamps a fingerprint
  as just-answered so the next tick can't ghost-register it.
- **Prior art** (fleet knowledge b44dc9c5 / fa681e87, plans `unknown-claude-prompts-fallback.md`,
  `unknown-tui-detection-flicker.md`): the fallback's own acceptance criterion is "never fires
  while claude is working **or idle at the input box**" — the idle half was never gated. Two
  review-caught rules to honour: a veto must scan the same window the card is built from, and
  a busy/idle gate must read only the bottom widget area, anchored to chrome shape.
- **Tests/runnability**: `export PATH="$HOME/.bun/bin:$PATH"`; `bun run typecheck`;
  `bun test src/bun/claude-tmux-scraper.test.ts` (inline pane fixtures + `__forTest`),
  `src/bun/claude-tmux-unknown-command.test.ts` (`installSession`/`uninstallSession` +
  `recorder()` for driving `dispatchLine`), `src/bun/interactions.test.ts`, full `bun test`
  (known environmental flake: `terminals.test.ts` PTY timing under load). Playwright e2e exists
  (`e2e/`, run via `bun node_modules/@playwright/test/cli.js test`) but drives the fake claude
  driver, which bypasses tmux + JSONL entirely → **e2e not applicable** to this change.

## 3. Approach & key decisions

1. **Settle a local-command turn on its `<local-command-stdout>` line** (evidence: spike —
   that line is the command's terminal signal; no assistant line ever follows). Add
   `slashCommand: string | null` to `TurnSlot` (from `slashTokenOf(prompt)` at the two
   prompt-bearing push sites: spawn `:4863`, `sendTurn` `:5334`; `null` for adopted
   continuations `:2979` and reattach `:5842`). In `dispatchLine`, when the head slot is a
   slash turn and `isLocalCommandStdoutEvent(evt)` (pure: non-meta `user` string content
   starting with `<local-command-stdout>`, or `system`/`subtype:"local_command"` whose
   `content` carries it), stage `pendingEndTurn { messageId: null, emitBanner: false }` —
   reusing the existing confirm-or-idle-fire machinery (next line fires it unless it's a
   `tool_result`; else `flush` fires after 800 ms). Gating on the slot's own prompt is the
   safety valve: a `/effort x` folded into a *real* in-flight turn via `pasteFollowUp`, or
   sent by the dropdown mirror mid-turn, can never settle that turn. Reattach replay is
   deliberately not handled here (decision 3 covers it after 60 s). No "turn complete"
   banner for local commands — nothing to divide from.
2. **Render the `system`/`local_command` twins as `user` chunks** so the first-command-in-
   session shape gets the same command/command-output bubbles as the `user` shape, and
   **silence the `<local-command-caveat>` isMeta breadcrumb** (claude's note-to-self, not
   user-relevant — same silent treatment as the image-marker meta line).
3. **Idle-input-box gate on the watchdog arm → settle, don't card.** New pure
   `paneShowsIdleInputBox(tail)`: within the last `IDLE_CHROME_WINDOW_LINES` (4) non-blank
   lines, a status-bar line matching `STATUS_BAR_RE` (anchored: `^\s*(⏵⏵|⏸)\s.*(\(shift\+tab to cycle\)|\? for shortcuts)`)
   **and** a bare prompt line `^\s*❯\s*$` above it. `stuckTurnFallbackArmed` gains
   `paneIdle` and is false when idle (signature stays honest, like `paneWorking`). Separately
   in `scrapeOnce`: when the *other* watchdog conditions hold and the pane is idle, count a
   `scrapeIdleSettleStreak`; at `UNPARSABLE_STABILITY_TICKS` call `signalIdleSettle(state)`
   (mirrors `signalUnknownCommand`: clear `pendingEndTurn`/`holdUntilIdle`/`pendingSlashToken`,
   emit `status: "turn complete"`, `popEndOfTurn`). Rests on the measured fact that every
   modal replaces the input box + status bar; a modal that ever co-renders with the status
   bar would be missed by the watchdog — accepted, documented on the regex.
4. **Slider matcher** `matchSliderModal(tail)` tried **after** numbered/yes-no and **before**
   `matchUnparsableModal` (runtime + boot chain): track line `^\s*[─┆]*▲[─┆]*\s*$` (exactly one
   `▲`), next non-blank line = ≥2 tokens `[a-z][a-z0-9+]*` separated by ≥2 spaces, footer
   `←/→ to adjust` within the last 3 non-blank lines. `choices` keyed `"1".."N"` with the token
   as label (renders `1. low` … through the existing generic card, no UI change);
   `cursorIndex` = label whose centre column is nearest the `▲` column (ties → lower index);
   fingerprint `slider:<labels>|@<cursor>`; `highConfidence: true` (footer present);
   `nav: "horizontal"`. Plumb `nav?: "vertical" | "horizontal"` through
   `ScrapeMatch` → `registerTmuxPrompt` → `TmuxPromptRequest` → `PendingTmuxPrompt` (api.ts
   mirror) → server route → `dismissTmuxPrompt` ctx, which sends `Right`/`Left` instead of
   `Down`/`Up`. Chosen over leaving the Open-in-Terminal card: the widget is fully
   readable and drivable, and the owner's standing preference is the complete path.
5. **Auto-accept the dropdown-initiated confirms.** `sendSlashCommand(taskId, line,
   opts?: { autoConfirm?: "model" | "effort" })`: inside the same queued tmux op, after the
   settle window, poll the pane (≤ 2 s, 200 ms steps) for `matchSlashConfirmModal(tail, kind)`
   — a numbered match whose header line is exactly `Switch model?` (kind `model`) or
   `Change effort level?` (kind `effort`), whose option 1 label starts with `Yes, switch to `,
   and whose cursor is on option 1; then `markTmuxPromptAnswered` (so a card that raced in
   is not ghost-registered) and send Enter. Anything else on the pane → do nothing (a
   permission prompt can never match that header/label pair; the inline no-confirm path is
   the common case and costs only the ≤ 2 s poll, which runs inside the op the next paste is
   already serialized behind). Orchestrator passes `{ autoConfirm: "model" }` /
   `{ autoConfirm: "effort" }` on the two mirror calls. User-typed `/model x` / `/effort x`
   keep relaying the confirm as a normal numbered card (claude asked; the user answers).
6. **`/model` picker answer stays Enter** ("set as default"), matching the TUI and
   `/model <id>`'s own "saved as your default" semantics; `s` (session-only) is a one-line
   flip in `dismissTmuxPrompt` if the owner prefers no global side effect (§8 Q6).
7. Out of scope (different tickets): syncing `task.model`/`task.effort` from typed slash
   commands; reattach-replay settlement of a local-command run; `/compact` (no stdout,
   already unsettled today).

## 4. Work breakdown — implementation tasks

**Wave 1** (file-disjoint, parallel):

- **T1 — Local-command settle + idle-settle net.** Owns `src/bun/claude-tmux.ts` only.
  - `TurnSlot.slashCommand`; set at `:4863` (spawn prompt) and `:5334` (`sendTurn`) via
    `slashTokenOf`; `null` at `:2979` and `:5842`.
  - Pure `isLocalCommandStdoutEvent(evt)` (both shapes; NOT the isMeta caveat, NOT the
    `<command-name>` line). `ParsedJsonlEvent` gains top-level `content?: string` if missing.
  - `dispatchLine`: after `mapParsedEventToChunks`, if `!endOfTurn && slot?.slashCommand &&
    isLocalCommandStdoutEvent(evt)` → `state.pendingEndTurn = { messageId: null, uuid,
    emitBanner: false, stagedAt: Date.now() }`. Not applied on the seen-uuid replay branch.
  - Mapper: `system`/`subtype:"local_command"` with string `content` → emit as `user` chunk
    (CR-normalised); `user` isMeta whose text starts with `<local-command-caveat>` → silent.
  - `paneShowsIdleInputBox`, `STATUS_BAR_RE`, `IDLE_CHROME_WINDOW_LINES`; `stuckTurnFallbackArmed`
    gains `paneIdle` (false when idle); `SessionState.scrapeIdleSettleStreak` (init with the
    other scrape fields, reset in `markTmuxPromptAnswered`/`disposeSessionState`);
    `signalIdleSettle(state)`; wire both into `scrapeOnce` (`:4194-4202`) — the idle-settle
    check runs only when `turnInFlight`, quiet > threshold, `!paneWorking`, no ask card,
    and no live tmux prompt for the task.
  - Add `nav?: "vertical" | "horizontal"` to `dismissTmuxPrompt`'s ctx type and
    `opts?: { autoConfirm?: "model" | "effort" }` to `sendSlashCommand`'s signature as
    *accepted-but-inert* optional parameters (so T2 typechecks in Wave 1); T3 implements them.
  - Export via `__forTest`: `isLocalCommandStdoutEvent`, `paneShowsIdleInputBox`,
    `STATUS_BAR_RE`, `signalIdleSettle`, `IDLE_CHROME_WINDOW_LINES`.
  - Acceptance: typecheck green; existing scraper/unknown-command/turn-routing tests still
    pass; a slash slot + caveat + command-name + stdout sequence pops the slot with code 0
    after the idle window; a non-slash slot never stages on stdout; idle pane never cards.
- **T2 — `nav` plumbing + orchestrator hook.** Owns `src/bun/interactions.ts`,
  `src/bun/server.ts`, `src/mainview/lib/api.ts`, `src/bun/orchestrator.ts`.
  - `interactions.ts`: `TmuxPromptRequest.nav?: "vertical" | "horizontal"` (doc: which arrow
    pair drives the cursor; undefined ≡ vertical), `registerTmuxPrompt` arg passthrough.
  - `server.ts:4206`: pass `nav: pending.nav` into `dismissTmuxPrompt` ctx.
  - `api.ts:207`: mirror `nav?` on `PendingTmuxPrompt`.
  - `orchestrator.ts:1543/1546`: `sendSlashCommand(taskId, \`/model …\`, { autoConfirm: "model" })`
    and `sendSlashCommand(taskId, \`/effort …\`, { autoConfirm: "effort" })`.
  - Acceptance: typecheck green against T1's inert optional params.

**Wave 2** (sequential on the same file):

- **T3 — Slider matcher, horizontal nav, slash-confirm auto-accept.** Owns `src/bun/claude-tmux.ts`.
  - `matchSliderModal` + `SLIDER_TRACK_RE` / `SLIDER_FOOTER_RE` / label-row parse /
    nearest-centre cursor; `ScrapeMatch.nav`; thread `nav` into both `registerTmuxPrompt`
    call sites (`:4278`, `:5097`); insert into both chains before `matchUnparsableModal`.
  - `dismissTmuxPrompt` ctx `nav` → `Right`/`Left`.
  - `matchSlashConfirmModal(tail, kind)` (pure, built on `matchNumberedModal`) +
    `sendSlashCommand(..., { autoConfirm })` confirm step inside the queued op.
  - `__forTest`: `matchSliderModal`, `matchSlashConfirmModal`, `SLIDER_TRACK_RE`.
  - Acceptance: typecheck green; slider fixture parses with the measured cursor for both
    captures; picker/confirm fixtures still route to `matchNumberedModal`; unparsable never
    reached for slider.

## 5. Work breakdown — test tasks

**Wave 3** (file-disjoint, parallel):

- **T4 — Scraper fixtures (2.1.245).** Owns `src/bun/claude-tmux-scraper.test.ts`.
  Model picker (numbered, 6 choices, cursor 5, highConfidence, unparsable not consulted);
  effort slider (matchSliderModal choices/cursor for `▲@59→xhigh` and `▲@49→high`,
  `nav:"horizontal"`, stable fingerprint, numbered/yes-no null, chain precedence over
  unparsable); "Change effort level?" and "Switch model?" confirms (numbered, cursor 0, not
  highConfidence; `matchSlashConfirmModal` true for the matching kind, false for the other
  kind, false on the picker, false when the cursor is on "No"); `paneShowsIdleInputBox` true
  for all 5 status-bar variants, false for picker / slider / confirm / working spinner /
  auto-mode wizard, and false when the status-bar text appears in scrollback above a modal;
  `stuckTurnFallbackArmed` false when `paneIdle`.
- **T5 — Local-command turn tests.** Owns new `src/bun/claude-tmux-local-command.test.ts`
  (pattern: `installSession`/`recorder()` from `claude-tmux-unknown-command.test.ts`).
  `isLocalCommandStdoutEvent` truth table (user non-meta stdout ✓, system/local_command
  stdout ✓, caveat isMeta ✗, command-name ✗, assistant ✗); slash slot + the 3-line sequence
  stages a bannerless pending and idle-fires → slot resolves 0, `user` chunks emitted for
  command-name + stdout, no status chunk for the caveat; non-slash slot + same lines → no
  pending; stdout followed by an assistant line → fires on the next line;
  system/local_command shape → same settle + user chunks; `signalIdleSettle` pops the slot
  and emits `turn complete`; `dismissTmuxPrompt` with `nav:"horizontal"` sends
  `Right`×2 + Enter (and `Left` for a negative delta) via the send-keys recorder seam.
- **T6 — Interactions passthrough.** Owns `src/bun/interactions.test.ts`: `nav` survives
  `registerTmuxPrompt` → broadcast → `listPendingForTask` → JSON round-trip; undefined by
  default.

**E2e: not applicable** — every change is inside the tmux/JSONL driver; the Playwright
harness runs the fake claude driver, which has no pane and no JSONL. Manual smoke (owner,
later, in `~/.agetor-dev` — never prod): type `/effort high`, `/effort`, `/model`, and change
the model/effort dropdowns on a live task; expect no Open-in-Terminal card and the run to
settle.

## 6. Execution waves

1. Wave 1: T1 ∥ T2 (sonnet). Checkpoint: typecheck + `bun test src/bun/claude-tmux*.test.ts`.
2. Wave 2: T3 (sonnet). Checkpoint: typecheck.
3. Review (opus): `git diff <base>...HEAD`; rubric incl. "can the stdout settle ever pop a
   real model turn?", "can the idle gate hide a genuine prompt?", "can the auto-confirm
   press Enter on anything but the two confirms?".
4. Wave 3: T4 ∥ T5 ∥ T6 (sonnet). Run (haiku): typecheck + targeted files + full `bun test`.
   Fix loop ≤ 3 rounds.
5. Orchestrator: CLAUDE.md note under the claude-code agent bullet (local-command settle,
   slider card, idle-settle net, dropdown auto-confirm).

## 7. Blast radius & risks

- **False settle** (stdout staging pops a real turn): gated on the head slot's own prompt
  being a slash command, and the dropdown mirror pushes no slot — a folded mid-turn
  `/effort x` cannot settle the active turn. A slash command that *then* calls the model
  (none observed for `/model`/`/effort`) would settle early and rely on the existing
  continuation-adoption path — same posture as today's end_turn split handling.
- **Idle-settle net**: settles only after the identical 60 s + 3-tick conditions that today
  *card* the pane, so its worst case is "run flips to review a minute after claude went
  idle" instead of "composer blocked forever". Reversible detection-logic change.
- **Slider regex breadth**: anchored on the `▲` track line + adjacent label row + `←/→ to
  adjust` footer — three independent signals; a transcript echo of a slider (dogfooding)
  above a real modal is defeated by the footer window rule. `▲` never appears in the
  numbered/yes-no shapes.
- **Auto-confirm**: Enter is sent only when the parsed numbered modal's header is exactly
  `Switch model?` / `Change effort level?` for the requested kind and option 1 starts with
  `Yes, switch to ` with the cursor on it; otherwise a no-op. Serialized inside the paste's
  own tmux op, so a user paste can't interleave.
- Recent churn: `2e75c7f` (#191) rewrote the `matchUnparsableModal` region; this branch is
  cut post-#192, no conflict.

## 8. Open questions / assumptions — autonomous grill (owner unavailable)

| # | Question | Answer | Source | Confidence |
| --- | --- | --- | --- | --- |
| 1 | Which flows reproduce the report? | All four: typed `/model <id>`/`/effort <id>` (60 s watchdog card on the idle pane), typed bare `/effort` (footer-arm card in ~3 s), typed bare `/model` (numbered card works, but the run hangs → watchdog card after answering), dropdown mirror (no card, but the new confirm modal needs a click). | Spike + `__forTest` probe | High |
| 2 | When a local command's stdout lands with no assistant reply, settle the run (→ `review`) or keep it running? | Settle `succeeded`, same as every other turn and the `signalUnknownCommand` precedent. | Code (`popEndOfTurn` contract) | High |
| 3 | Emit the "turn complete" banner for that settle? | No — nothing to divide. Idle-settle (Q4) does emit it, since there the run is being closed by agetor, not by claude's own output. | Judgment | Med (cosmetic) |
| 4 | Watchdog on an idle input box: card / ignore / settle? | Settle after the same 60 s + 3 stable ticks (**owner confirmed 2026-08-26: settle succeeded → review**). "Never fires while idle at the input box" is the fallback's own acceptance criterion; ignoring would recreate the pre-#185 stuck-running state. | `unknown-claude-prompts-fallback.md` §1; spike idle captures | Med-High |
| 5 | Bare `/effort` slider: keep the Open-in-Terminal card or build a driven card? | Driven card (←/→ + Enter). Fully readable widget; owner's standing preference is the complete path. | Spike; user memory | High |
| 6 | `/model` picker: confirm with Enter (sets global default) or `s` (session only)? | **Owner decision (2026-08-26): `s`** — a card click inside agetor must not rewrite the user's global claude default; `task.model` syncs from the stdout either way. Implemented generically: `matchNumberedModal` sets `confirmKey: "s"` when the footer offers `s to use this session only`, plumbed through `TmuxPromptRequest.confirmKey` to `dismissTmuxPrompt`. | Spike footer text; owner | High |
| 7 | Auto-accept the "Switch model?" / "Change effort level?" confirms for the dropdown mirror? | Yes, both (user already chose; strictly matched on header + `Yes, switch to ` + cursor). The confirm is conditional (real change + an assistant turn since the last switch), so the inline path must remain a no-op. | Spike follow-ups B and C | Med-High |
| 8 | Sync `task.effort`/`task.model` when the user changes them via typed commands? | Out of scope — different ticket (settings model), not remainder of this fix. | Scope test | High |
| 9 | Handle reattach replay of a local-command run after an agetor restart? | Out of scope for the JSONL path; the idle-settle net (Q4) closes it within ~60 s of reattach. | Design | Medium |
| 10 | Silence the `<local-command-caveat>` breadcrumb? | Yes — tiny, cosmetic, part of rendering these responses properly. | Spike JSONL | High |
| 11 | E2e? | Not applicable (fake driver has no pane/JSONL). | Repo | High |
| 12 | One-way doors? | None: no migration, no API contract break, no auth change; all detection/turn logic behind tests. | — | High |

**Unverified because the owner was absent:** Q4's settle-vs-ignore choice and Q6's Enter-vs-`s`
are the two answers a human should check first; both are single-line flips.

## 9. Post-review addendum (2026-08-25)

Opus review (via the `code-review` skill) on the wave 1+2 diff returned *request changes*;
every valid finding was applied in commit `9b29bf6` and re-verified. Net changes on top of §3:

- **Identity-checked settle (must-fix).** The stdout staging tested *whether* the head slot
  was a slash turn, not *which* command — a `/implement …` task whose owner flipped the effort
  dropdown mid-run (or folded a `/effort x` follow-up) would have been settled by the foreign
  `<local-command-stdout>`. `SessionState.lastLocalCommandName` now records the
  `<command-name>` line that always precedes a command's stdout (`localCommandNameOf`, both
  JSONL shapes), and staging requires `slot.slashCommand === lastLocalCommandName`; the name
  is cleared on stage, `popEndOfTurn`, and dispose.
- **Idle gate anchored on chrome, not a row count.** `IDLE_CHROME_WINDOW_LINES = 4` failed
  *open* whenever a `Tip:` banner, `✔ Update installed` notice, or the `⏺ main`/`◯` agent
  roster sat in the widget area (up to 13 rows per `WORKING_CHROME_WINDOW_LINES`'s evidence).
  `paneShowsIdleInputBox` now requires the `STATUS_BAR_RE` line to be one of the last two
  non-blank lines, rejects a bar carrying `esc to interrupt` (a working pane shows the same
  `(shift+tab to cycle)` phrase; the blink-off tick is still covered by
  `paneShowsClaudeWorking`), and searches `IDLE_PROMPT_SEARCH_LINES` (8) rows above it for
  the bare `❯`.
- **Real slider track required.** `SLIDER_TRACK_MIN_CHARS = 10` — a lone `▲` in prose or a
  dogfooded pane echo could otherwise have become a *drivable* horizontal card.
- **Confirm poll early-exit.** `sendSlashCommand({ autoConfirm })` returns after
  `SLASH_CONFIRM_IDLE_BREAK_TICKS` (2) consecutive idle polls instead of holding the task's
  tmux chain for the full 2 s on the common inline path.
- **Idle-settle is explained.** `signalIdleSettle` emits `IDLE_SETTLE_STATUS_TEXT` before the
  `turn complete` banner so the transcript shows the run was closed by agetor, not by claude.
- `nav` dropped from the hand-mirrored `PendingTmuxPrompt` (the webview never reads it; the
  server owns the driving).
- **Not taken:** F4 — a confirm that first paints *after* the 2 s window could be accepted by
  the next queued op's Enter. Same hazard class as any modal racing a paste today, and the
  confirm renders within a few hundred ms in every capture; noted as a follow-up candidate.

Verification after the addendum: `bun run typecheck` clean; driver + interactions files
364 pass / 0 fail; full `bun test` 3131 pass / 3 skip / 0 fail (fix agent's run; the haiku
Phase 7 run is recorded in the final report).

## 10. Completeness addendum — swept-in follow-ups (owner: "include them", 2026-08-25)

| Item | Disposition | Owner task |
| --- | --- | --- |
| Review F4 — a confirm that paints after the auto-confirm window is accepted by the next queued paste's Enter | **In this run**, generalized: no `queuePaste` may ever type Enter into a live claude modal | T7 |
| `task.model` / `task.effort` drift after a typed `/model x` / `/effort x`, a picker/slider/confirm card answer, or a terminal-side change | **In this run**: sync the task row from claude's own `<local-command-stdout>` outcome | T7 + T8 |

**Design.**
- **Paste guard (T7).** Pure `paneShowsBlockingPrompt(tail)` = numbered ∨ yes/no ∨ slider ∨
  `detectAskModal` ∨ footer-armed `matchUnparsableModal(tail, false)` — exactly the set the
  scraper would card. `queuePaste` captures the pane (new `capturePastePane` seam, default
  `captureTail`) right before `pastePromptSync`; while a blocking prompt is showing it polls
  every `PASTE_MODAL_POLL_MS` (250) for at most `PASTE_MODAL_GRACE_MS` (1 500) — the grace
  covers a repaint after an auto-confirm, but must stay short because the card click that
  clears the modal (`dismissTmuxPrompt`) is queued on the **same** per-task tmux chain and
  would otherwise wait behind us. If the prompt is still there, the paste is **withheld**:
  `reportPasteFailure`-style status (`paste withheld: claude is waiting on a prompt — answer
  the card (or the terminal) and resend`) + `onPasteFailure({ op: "modal-guard" })`, so
  `sendTurn` settles its slot (run `failed` → task `ready`) instead of losing the message and
  silently confirming whatever the cursor was on. The boot-time deferred paste keeps the
  check with a zero grace (`modalGuardGraceMs: 0`) — its give-up branch can reach the paste
  with an un-carded prompt on screen; `skipModalGuard` remains a test-only opt-out. The auto-confirm poll
  also stops when a *foreign* blocking prompt appears (left to the scraper).
- **Setting sync (T7 + T8).** The driver's `lastLocalCommand` now keeps `{ name, args }` from
  the `<command-name>` line; on a `<local-command-stdout>` for `/model` or `/effort` it fires
  `setLocalSettingChangedHandler` (orchestrator-injected seam, same shape as
  `setBackgroundTaskSettledHandler`) with `{ setting, args, stdout }` — regardless of slot,
  so the dropdown mirror, a typed command, a card answer and a terminal-side change all
  flow through one path. New `src/bun/claude-local-setting.ts` (pure, unit-tested):
  `parseClaudeLocalSetting(info)` → `{ model } | { effort } | null`. Model: an arg equal to a
  `CLAUDE_MODEL_FLAG` value maps back to its agetor id; otherwise the stdout display name
  (`Set model to <name> …`, qualifiers `(1M context)` / `(default)` and ANSI bold stripped)
  is matched by longest `AGENT_OPTIONS["claude-code"].models[].label` prefix (so the picker's
  session-only `s` suffix parses too); a raw `claude-…` id passes through verbatim; the arg is
  consulted only AFTER stdout confirms a `Set model to …` outcome; `Kept model as …` syncs
  (drift correction after a declined confirm); anything else → `unrepresentable` breadcrumb. Effort: `Set effort level to <id>`
  (outcome-first — the typed arg is never trusted on its own) restricted to the claude-supported ids
  (`max|xhigh|high|medium|low`); `ultracode` / `Cancelled` → null. Orchestrator
  `applyClaudeLocalSetting(taskId, info)`: claude-code tasks only; no-op when the value is
  unchanged (model compared through `toClaudeModelArg` so an alias can't flip the id);
  `tasks.update` directly (the PATCH route is the only `reconcileTaskSession` caller, so this
  never re-mirrors) + a status breadcrumb on the latest run (`model synced from claude: …`).
  A model sync cascades the RunPanel effort-fallback rule into the same `tasks.update` and
  deliberately does NOT mirror `/effort` into the live session — claude owns its live pair;
  the row is for the next spawn.

**Not swept in (different tickets):** `/compact` turns (no stdout, unsettled today);
reattach replay of a local-command run (idle-settle covers it).

**§10 review + verification (2026-08-25).** Opus review of `c72714f` (via the `code-review`
skill) returned *request changes* with 15 findings (6 should-fix, 9 nice-to-have); all 15 were
applied in `b628fe7`. The ones that changed behaviour: the effort sync is outcome-first
(claude's `Set effort level to …` line is required; the typed arg is only a fallback — a
declined confirm can no longer write it) and validated against `supportedEfforts(model)`, with
a model sync cascading RunPanel's effort fallback into the same update; `Kept model as …`
syncs (drift correction) and unrepresentable values (`ultracode`, an unknown display name)
leave a breadcrumb instead of vanishing; withheld pastes are never reported as success —
`cycleToMode`'s `/plan` returns `paste withheld` (so the PreToolUse matcher is not narrowed
for a mode claude never entered), the dropdown mirror and a folded follow-up leave
breadcrumbs (the follow-up's text is re-stashed into the backlog tray); the bracketed path
re-reads the pane after the Enter gap (a modal painting inside the up-to-3 s image-attach
gap can no longer receive the Enter); the boot deferred paste keeps the check with a zero
grace instead of opting out; `paneShowsBlockingPrompt` mirrors `scrapeOnce`'s working-pane
gate. Known-benign: when the mirror paste itself is withheld, the queued auto-confirm op
still takes one pane read before bailing (no keystroke is ever sent).
Verification: `bun run typecheck` clean; `claude-tmux-local-command` + `claude-tmux-queue`
100/100, `claude-local-setting` + `orchestrator` + `agents` 144/144; full `bun test`
3197 pass / 3 skip / 0 fail (Fix-D's run; the haiku Phase 7 run is in the final report).

**/code-review "fix all" (2026-08-26).** A third pass (own read of the two review-fix commits +
three delegated sub-reviews) found 3 high / 5 medium / 9 low / 2 info; all 19 applied. The
behaviour changes: the idle-settle net additionally requires 60 s since `lastActivityAt`
(a just-sent prompt on a long-idle session could otherwise be settled ~3 s after Send —
`decideScrapeTick` runs every 1 s while a turn is in flight, and an image paste sleeps up
to 3 s before Enter); every withhold is double-sampled (`stillBlocking`); withheld outcomes
carry a `phase`, a `pre-enter` withhold leaves the text in claude's composer and the driver
clears it with `Escape Escape` before the next idle paste (spike-verified on 2.1.245: `C-u`
never clears, `C-c` arms the exit hint, nothing clears mid-turn — so mid-turn the next paste
is withheld `composer-dirty` and re-stashed); `sendTurn` forwards `onPasteFailure` so an idle
send is re-stashed like a folded one; the model parser is outcome-first and matches display
names by longest label prefix; a `null`-model row is not pinned by `Kept model as <default>`;
the slider needs its footer both within 3 lines of the label row AND at the bottom of the
pane; `markTmuxPromptAnswered` is stamped after the Enter lands; hot-path regex/prompt-list
allocations hoisted; the idle-settle text derives from `STUCK_TURN_FALLBACK_MS`. Tests: the
idle-settle net (`idleSettleTick`), `slashCommand` population, the orchestrator withhold
handlers, `nav` end-to-end, a late-rendering confirm, and the shared `pickScrapeMatch` chain
are now pinned; guard tests run against a 20 ms grace seam.
Re-review of that delta (opus) found 1 high / 4 medium / 6 low, all applied: the composer
predicates now anchor on the LIVE `❯` row (the bottom-most one above the status bar — the
transcript echo of the previous line uses the same glyph and had made an empty composer read
as "text present"); the clear is verified positively and the pane re-guarded before the
paste; `pre-enter` withholds are re-stashed too (the clear deletes the composer copy); real
tmux failures get their own wording; display-name matching requires a word boundary (`Opus
5.1` → unrepresentable, not `opus-5`); `sendTurn` always notifies its caller; a failed
trailing Enter marks the composer dirty; the clear keystroke's result is checked;
`paneShowsBlockingPrompt` delegates to `pickScrapeMatch`; the `PASTE_MODAL_*` test exports
are live getters.

## 11. Grill + headless smoke + wave 5 (2026-08-26)

Owner decisions (grill): idle-settle stays *succeeded → review*; the `/model` picker card
confirms with **`s`** (`ee155a7`, generic `confirmKey`); no push / PR / `ultracode` for now.

**Smoke** (real `startApiServer()` on `~/.agetor-dev`, real claude **2.1.246**, throwaway
task, deleted): baseline, typed `/effort`, bare `/effort` (6-choice card, horizontal nav
verified with a real `Left`), bare `/model` (`s` → `Set model to … for this session only`,
`~/.claude/settings.json` untouched, `task.model` synced), the paste guard while a permission
modal was up (withheld at +1.9 s, backlog re-stash, modal cursor untouched, stray composer
text cleared) and cleanup all **passed**. Scenario 5 (dropdown mirror) **failed** on three
counts, all claude-version facts: `CLAUDE_CODE_EFFORT_LEVEL` (pinned at spawn) outranks every
`/effort` form; typed `/model <id>` writes the user's global default; and the mirror's JSONL
twins were adopted as an `origin: continuation` run that sat `running` for 6 min — the
idle-settle net was defeated by the flickering right-hand `● high · /effort` status-bar hint
resetting `lastActivityAt`. This is very likely the original report's reproduction path.

**Wave 5 (owner decisions):** effort is never mirrored (row + `applies on the next run`
breadcrumb, `getSessionLaunchEffort`); the model mirror drives the picker with `s`
(`mirrorModelViaPicker` + `claudeModelPickerFamily`; unrepresentable ids → breadcrumb);
local-command twins are never continuation content; the idle-settle gate keys on
`lastKeystrokeAt` and the status-bar row is volatile for the activity diff; `sendTurn` /
`pasteFollowUp` expose `pasteOutcome`, `sendInput` awaits it (5 s race) and returns
`withheld` + `savedToBacklog`, and every `sendRunInput` caller in the webview (composer, tray,
commit/push, resolve-conflicts, diff composer) clears its draft and toasts instead of
treating the send as delivered; `<local-command-stdout>` ANSI is stripped in the bubble.

**Wave-5 re-review + smoke 2 + wave 6 (2026-08-26).** The opus re-review of wave 5 found 6
medium / 5 low, all applied: keystroke clock bumped at paste *enqueue*; `mirrorModelViaPicker`
bails `turn in flight` on a busy session and sets `drivingPrompt` so the scraper never cards
the picker it is driving; the `target not offered` Escape is `.ok`-checked; the ask-card
free-text route threads `withheld`/`savedToBacklog`; the `pasteOutcome` race is a 15 s
backstop with its timer cleared; backlog re-stash dedupes against the whole backlog (the tray
no longer filters locally); `no live session` / `turn in flight` get next-run wording; a
dropped paste carries a descriptive `stderr`; only the flickering `● high · /effort` suffix is
volatile (`EFFORT_HINT_SUFFIX_RE`, applied to both the activity diff and the unparsable
fingerprint), not the whole status-bar row; `sendSlashCommand` is test-only.
Smoke 2 (2.1.246): effort dropdown (no paste + breadcrumb), the withheld route
(`{delivered:false, withheld:true, savedToBacklog:true}` in 1.9 s), backlog dedupe, the
ask-card free-text answer and a 90 s idle sanity all **passed**; the model mirror **never
fired** — `paneShowsClaudeWorking` matched the completed-turn summary row
(`✻ Churned for 1s · done 5:35 PM`) as working chrome, so every idle pane that ever finished a
turn read as busy (also the second contributor to smoke 1's stuck run). Wave 6:
`SPINNER_ELAPSED_WORKING_LINE` excludes `TURN_DONE_SUMMARY_RE` (the row stays volatile), and
`Kept model as …` drift-corrects the row only when agetor's own mirror produced it
(`viaMirror`) — a user's Esc on the picker no longer clobbers a next-run selection.
