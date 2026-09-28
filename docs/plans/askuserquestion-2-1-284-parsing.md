# Plan — AskUserQuestion cards on Claude Code 2.1.284: complete, deduplicated, full-text, and typed answers

| Field | Value |
| --- | --- |
| Date | 2026-09-28 |
| Source | Task: "Review Claude Code updates and check our implementation; fix the AskUserQuestion parsing that sometimes doesn't identify the ask from the TUI, sometimes doesn't list all questions, sometimes duplicates questions, sometimes doesn't show full question text." |
| Config | AGENTS_CONFIG.yml (balanced, schema v1 — loads fine; `/implement --update` available) |
| Flags | none |
| Gates | grilled + approved by owner (AskUserQuestion cards; the first 4-question card itself reproduced the bug — only Q1 was delivered — so Q2–Q4 were re-asked with short descriptions) |
| Branch | `fix/review-claude-code-updates` (agetor worktree, already checked out) |
| Base SHA | `bd5adcb` |

## 1. Objective & success criteria

Make the pane-scraped AskUserQuestion card match what Claude Code 2.1.284 actually renders, so that on the default 80x24 detached tmux pane:

1. a 4-question modal with long option descriptions registers ONE card listing all four questions, each exactly once, in order, with full question text (no `│` gutter bars) and full option labels;
2. a modal is never carded as a single question because its tab bar scrolled off the top of the pane;
3. a swallowed `Right` keystroke during the tab walk can no longer produce a duplicated question + a missing last question;
4. detection survives the footer wrapping (`… ctrl+g to edit in Vim · Esc to` / `cancel`);
5. cards appear ~2 s sooner (the JSONL grace wait, whose premise is false, is gone);
6. a typed custom answer is delivered through the native `Type something` row (a real structured tool_result) instead of Esc + follow-up message, with the message path kept only as the fallback for what can't be typed;
7. every change is pinned by unit tests against REAL 2.1.284 captures, and a live smoke through the real driver confirms (1).

## 2. Context & constraints (grounded findings)

**Ground truth, spike-verified on 2.1.284 (haiku, `tmux -L agetor-spike`, 269 captures under the session scratchpad `spikes/ask-tui-284/`; binary read of the Ink component):**

- **JSONL timing.** The `AskUserQuestion` tool_use is NOT written to the session JSONL while the modal is open — nothing lands until the user answers/declines, then `assistant thinking` + `assistant tool_use` + `user tool_result` flush in one batch (re-confirmed after a 125 s idle). So `readPendingAskQuestionsFromJsonl` (`claude-tmux.ts:3210`) returns null for the entire open lifetime; `shouldWaitForAskJsonl`/`ASK_JSONL_GRACE_MS = 2000` (`:3592–3624`) only ever add 2 s of latency; and every comment/doc that says "claude DOES write the pending tool_use pre-answer" (`claude-questions.ts:187`, `claude-tmux.ts:2495`, `:3139`, `:3178`, `:5359`, CLAUDE.md "Ask cards" bullet) is wrong. Same as fleet knowledge for 2.1.168/2.1.170 — the pane is the ONLY live source.
- **Real usage shape** (8 recent agetor sessions): 4 questions per call, options with 100–450-char descriptions; schema caps: max 4 questions, 2–4 options, `description` required (may be `""`).
- **2.1.284 rendering (plain `capture-pane -p`):**
  - Modal = full-width `─` rule, then ` ☐ Header` (flat single question, no arrows) or the tab bar `←  ☐ Toppings  ☐ Size  ☐ Delivery  ✔ Submit  →` (2+ questions, or a single multiSelect), blank, question, blank, options, `N+1. Type something.` (single) / `N+1. [ ] Type something` + `     Next` (multi; `     Submit` on the last question), rule, `N+2. Chat about this`, blank, footer.
  - **Question gutter:** a question that wraps to 2+ rows gets a `│ ` prefix on EVERY row (Ink `borderLeft`); a one-row question has none. A question containing `\n` also gets it.
  - **Descriptions** render on the row(s) below the label at a fixed indent: 5 cols (single-select), 9 cols (multi-select); wrapped continuation rows keep that indent. **A wrapped LABEL's continuation also lands at that same indent** (`longopts-80x24b-1open`), so at 80 cols the parser splits a long label into label + fake description.
  - **Tab bar:** glyph `☐` = unanswered, `☒` = answered; the ACTIVE tab is marked only by ANSI colour — plain capture is byte-identical across tabs. Max 4 questions → the bar never truncates/wraps at 80 cols (worst case 78 cols). Header fallback `Q1`, `Q2`…
  - **Navigation:** `Right`/`Left` clamp at the ends (no wrap); `Tab` does nothing; entering a tab resets the cursor to option 1; single-select Enter auto-advances; multi-select Enter/Space toggles, `Next`/`Submit` row advances; the review tab (`Review your answers`, `Ready to submit your answers?`, `❯ 1. Submit answers / 2. Cancel`) has NO footer; Right/Left/Tab are dead while the cursor is on the `Type something` row (Left/Right move the caret).
  - **Option list windowing:** at most 5 option rows are visible (`min(5, floor((rows-8)/2))`); an off-screen remainder puts `↑`/`↓` in the pointer column of the edge rows. 4 options + Other = 5 → only ever windowed on panes under ~18 rows.
  - **Footer:** `Enter to select · ↑/↓ to navigate · Esc to cancel` (single) / `Enter to select · Tab/Arrow keys to navigate · Esc to cancel` (tabbed); with the cursor on the Type/Chat row claude inserts ` · ctrl+g to edit in Vim` before `Esc`, and at 80 cols that footer WRAPS: `… · Esc to` / `cancel`.
  - **Preview layout** (single-select with `preview`s): unchanged from the 2.1.183 fixtures — side-by-side box, bare (unnumbered) `Chat about this`, `n to add notes`.
  - **Typed custom answers:** the `Type something` row is an inline text input — typing fills it (`❯ 4. purple`), Enter submits it as the answer (single-question: resolves immediately; multi-question: auto-advances); in multi-select typing auto-checks the row (`❯ 5. [✔] Peppers`) and Enter on that row UN-checks it, so the advance must go through `Next`. Enter on an EMPTY Type row declines the whole modal. The recorded answer is the plain string (`"<q>"="purple"`, or `Cheese, Peppers` for multi). Exact key sequences: spike 2 (`spikes/ask-drive-284/`), folded into D6.
  - **Not a factor:** `kind: "text"|"number"` questions are gated to SDK/desktop entrypoints (env `CLAUDE_CODE_QUESTION_EXTENDED` + entrypoint allow-list) and fail validation in a terminal session; AFK auto-continue (`CLAUDE_AFK_TIMEOUT_MS`, default 60 s when enabled) is opt-in — nothing happened in 125 s idle; ASCII-glyph fallback (`>`/`[×]`/`√`) only on non-Unicode terminals.
- **Current code paths** (`src/bun/claude-questions.ts`, `src/bun/claude-tmux.ts`):
  - `detectAskModal` (`claude-questions.ts:150`) = `Chat about this` + `Esc to cancel` on the 40-line tail → breaks on the wrapped footer.
  - `parseModalPane` (`:338`) — `OPTION_RE` (`:234`) accepts any `N.` row at any indent (a description row starting `2. …` becomes an option); the question gather (`:400–414`) keeps the `│ ` gutter; `complete` (`:430`) = first option numbered 1 + non-empty question — it does NOT require the modal's top (`☐`/tab bar) to be visible.
  - `collectAskQuestionsFromPane` (`claude-tmux.ts:3468`): `n = first.tabbed ? headers.length : 1` from the 80x24 tail; **fast path** (`:3487`) registers straight from that tail when `n === 1 && !preview && complete` — so a 4-question modal whose tab bar (2–3 rows) scrolled off the top, with option 1 still visible, registers as ONE question. This is the reproduced "not listing all questions" bug (it hit the owner's own grill card during this run). The tab walk (`:3520–3543`) sends `Right`, sleeps 180 ms, parses, and never verifies the tab changed → a swallowed key = duplicated question + missing last one. The post-collect recheck (`:3643`) discards a finished collection on one mid-repaint capture.
  - `collectAndRegisterAskCard` (`:3626`) — JSONL grace wait (`:3639`).
  - `driveAskAnswers` (`:2241`) sends `NavKey`s only; `planAskAnswers` (`claude-questions.ts:484`) returns `mode:"message"` for any custom text; the route `/ask-questions/:id/answer` (`server.ts:5065`) Esc's the modal and pastes `formatAnswersMessage` via `sendInput` for message mode.
  - Tests: `claude-questions.test.ts` (44, fixture-driven, fixtures from 2.1.161–2.1.183 in `src/bun/fixtures/askuserquestion/`), `claude-tmux.test.ts` (`collectAskQuestionsFromPane` against `renderFakeModal`/`makeFakePane` at `:2065–2480`, `shouldWaitForAskJsonl` at `:2004`/`:2022`), `claude-tmux-askdrive.test.ts` (`decideAskDriveStep`).
  - e2e: the fake claude driver renders no tmux pane, so the pane parser has no e2e seam — unit tests + a live smoke are the verification layers.

## 3. Approach & key decisions

- **D1 — Grow on wrap risk (owner).** Keep the instant fast path for a small, fully-visible modal, but route to the grow-and-walk path whenever the pane is *lossy*: no `☐`/`☒` header/tab-bar row visible above the question (top scrolled off), `✂ … lines hidden` collapse markers, `↑`/`↓` edge markers (windowed list), or any option-label row / question row that reaches within 12 columns of the pane's right edge (width = length of the modal's own full-width `─` rule row; false positives only cost one grow). The grow target becomes **200 cols × 100 rows** (`GROW_PANE_COLS`, was `PREVIEW_PANE_MIN_COLS = 120`) so labels up to ~190 chars don't wrap; previews still fit (`maxWidth = columns − 34`).
- **D2 — Completeness requires the modal top.** `ParsedQuestionPane.complete` additionally requires a `[☐☒]` row (flat header or tab bar) above the question block inside the parsed region. Both 2.1.161 and 2.1.284 render one, so this is backward-compatible, and it is what stops the tab-bar-scrolled-off fast-path registration.
- **D3 — Verify every tab switch by body, not by ANSI (reasoning).** The active tab is invisible in plain capture. Two questions in one call cannot be identical (claude keys answers by question text), so after each `Right` the collector compares `{questionText, option labels}` with the previous tab's parse; identical ⇒ the key was swallowed ⇒ resend `Right` once (bounded); still identical ⇒ abort this collection (counts toward the give-up latch). Version-proof; no `capture-pane -e` parsing.
- **D4 — Remove the JSONL grace (owner).** Keep the cheap `readPendingAskQuestionsFromJsonl` first attempt (harmless if a future CLI flushes early), delete `shouldWaitForAskJsonl`/`ASK_JSONL_GRACE_MS`/`askFirstSeenAt`-based waiting, and rewrite the comments + CLAUDE.md to state the verified fact.
- **D5 — Strip the question gutter; keep paragraphs.** `│ ` / `│` prefixes are removed per row; a bare `│` row is a paragraph break, so `questionText` keeps `\n` between paragraphs and the card renders it `whitespace-pre-wrap`.
- **D6 — Drive typed custom answers (owner: include in this run; sequences spike-verified live, `spikes/ask-drive-284/`).** `planAskAnswers` returns `mode:"drive"` with `steps: DriveStep[]` where `DriveStep = NavKey | { type: "text"; text: string }` (`keys` is replaced by `steps`; the type change is deliberate so no consumer can send a text step as a key). Every question starts with the cursor on option 1; the Type row is at index `options.length`; `Next`/`Submit` is the row below it. Verified sequences:
  - **single-select with custom** (custom wins over any pick — the row is one choice): `Down × options.length`, `{text}`, `Enter` (single-question: resolves immediately, no review; multi-question: auto-advances).
  - **multi-select, picks ± custom:** toggle picks in ascending index order exactly as today (`Down`/`Up` + `Enter`); then if custom: `Down` until the cursor is on the Type row (`options.length − cursor` presses), `{text}` (auto-checks the row), `Down` (to `Next`/`Submit`), `Enter`. **Never `Enter` on the Type row** (it un-checks the typed text) and **never `Enter` on an empty Type row** (declines the whole modal). Without custom the existing `Right` advance stays (verified still valid from an option row).
  - the final review `Enter` (`confirmsReview`, every shape but the flat single-select single question — a single multiSelect question DOES go through review) is unchanged.
  - fallbacks stay message-mode with new reasons: `multiline-custom` (text contains `\n`/`\r`), `custom-too-long` (> `ASK_TYPED_ANSWER_MAX_CHARS` = 400 — the largest size verified byte-exact live, well under claude's ~3 KB typed-paste heuristic), plus the existing `unknown-option` / `arity-mismatch` / `empty-answer`.
  - `driveAskAnswers` sends a text step as ONE `tmux send-keys -t <session> -l <text>` (argv element, no shell; `bumpKeystroke`), waits ~120 ms, then verifies the pane shows a focused row `❯ N. [\[ ✔\] ]?<first ≤ 40 chars of text>` (the row soft-wraps at a 5-space indent, so only the prefix is checked) before sending the next step; on a miss it polls up to 5 × 120 ms, then aborts the drive (`ok=false`, status line `typed answer did not land in the modal — answer it in the terminal or retry`) WITHOUT pressing Enter (an Enter on an empty/partial row would decline or submit garbage); the route returns `ok:false` and the scraper re-collects the still-open modal as today.
- **D7 — Footer tolerance.** `FOOTER_SIGNATURE = /Esc to[ \t]*\n?[ \t]*cancel/` so the wrapped 80-col footer still detects; `isNoise` also treats `Next`/`Submit` rows and `↑`/`↓`-prefixed option rows correctly; `OPTION_RE` requires the number to start within the first 3 columns (`^\s{0,2}(?:[❯›↑↓]\s?)?\d+\.\s`) so an indented description row can never be read as an option.
- **D8 — Post-collect recheck retries once** (150 ms) before discarding a finished collection; a discarded collection now counts toward `askGrowAttempts` like any other failure.
- **D9 — Flat header + `✔` suffix.** The flat ` ☐ Header` row becomes the question's `header`; a revisited answered option's trailing ` ✔` is stripped from the label.

Alternatives rejected: parsing `capture-pane -e` ANSI for the active tab / dim descriptions (fragile across versions, and would need every regex to strip SGR); always-grow (owner chose wrap-risk); keeping the message-mode custom path (owner chose to drive the row).

## 4. Work breakdown — implementation tasks

| ID | Goal | Owns (exact files) | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| **T1** | Parser + planner for 2.1.284 | `src/bun/claude-questions.ts`; NEW fixtures `src/bun/fixtures/askuserquestion/v284_*.txt` (copied verbatim from spike captures: `flat-80x24-1open`, `multi-80x24b-1open`, `multi-80x24b-5size-down` (tab 2), `multi-80x24b-6size-enter`/`7deliv-enter` (tab 3 + review), `longopts-80x24b-1open`, `preview-80x24-1open`, `flat-80x24-6typesomething-typed`, `multi-80x24-6typed`, a synthetic `v284_tabbar_scrolled_off.txt` = `multi-80x24b-1open` minus its first rows through the tab bar, a synthetic `v284_footer_wrapped.txt`) | — | D2, D5, D7, D9 implemented; `complete` false when no `[☐☒]` row precedes the question; gutter stripped; `paneWrapRisk(tail)`/`isLossyAskPane(tail)` exported for T2; `planAskAnswers` returns `steps` (D6) with the new fallback reasons; `parseModalPane` on every new fixture yields the expected questions/labels (see §5 T4); all existing `claude-questions.test.ts` tests still pass except those asserting `keys` (rename to `steps`). No behaviour of `extractFocusedPreview`/`stripPreviewColumn` changes. |
| **T2** | Collector + driver | `src/bun/claude-tmux.ts`; `src/bun/claude-tmux.test.ts` ONLY to delete/adjust the two `shouldWaitForAskJsonl` tests and any `keys`→`steps` rename (no new tests here — T5 adds them) | T1 (exports) | D1, D3, D4, D6-drive, D8: fast path only when `!isLossyAskPane(firstTail)`; grow to `GROW_PANE_COLS=200`×100; per-tab body verification with one bounded `Right` resend; grace removed (`askFirstSeenAt` may stay as a diagnostic stamp or be removed — remove `shouldWaitForAskJsonl` + `ASK_JSONL_GRACE_MS` + their `__forTest` exports); `driveAskAnswers` accepts `steps` with `{type:"text"}` sent via `send-keys -l` and verified on the pane; recheck retry; comments at `:2495`, `:3139`, `:3178`, `:3234-3245`, `:5359` rewritten to the verified fact (tool_use lands on answer only); `bun run typecheck` green; `bun test src/bun/claude-tmux.test.ts src/bun/claude-tmux-askdrive.test.ts` green. |
| **T3** | Route/UI/docs | `src/bun/server.ts` (only if the plan type change touches the route — it should not, `driveAskAnswers(taskId, plan)` keeps its signature), `src/mainview/components/kanban/RunPanel.tsx` (`AskQuestionsCard`: question text `whitespace-pre-wrap`; custom textarea placeholder `Custom answer (replaces the selection)` for single-select, `Custom answer (added to the selection)` for multi-select), `CLAUDE.md` ("Ask cards" bullet in the claude-code section: the pane is the sole live source, tool_use lands on answer, wrap-risk grow, tab verification, typed-answer drive) | — (contract fixed by this plan) | Typecheck green; no other RunPanel behaviour changes. |

## 5. Work breakdown — test tasks

| ID | Layer | Owns | Covers |
| --- | --- | --- | --- |
| **T4** | unit | `src/bun/claude-questions.test.ts` | T1: every `v284_*` fixture → expected `tabbed/tabHeaders/questionText/options/multiSelect/complete`; gutter stripping incl. a paragraph break; `complete=false` on `v284_tabbar_scrolled_off`; wrapped footer detection; `↑`/`↓` edge marker rows parse + mark incomplete; indented `2. …` description row is NOT an option; `paneWrapRisk` true for `longopts-80x24b-1open`, false for `flat-80x24-1open`; `planAskAnswers` step sequences for: single custom, single custom-after-pick (custom wins), multi picks + custom, multi custom only, mixed 3-question, multiline → `multiline-custom`, over-length → `custom-too-long`; old fixtures still parse identically (regression). |
| **T5** | unit | `src/bun/claude-tmux.test.ts` (collector section only, extend `renderFakeModal`/`makeFakePane`) | T2: fast path skipped on a lossy tail (no tab bar) and the walk registers 4 questions once; fake pane that SWALLOWS the first `Right` → resend → still 4 distinct questions; fake pane that swallows every `Right` → null + `askGrowAttempts` incremented; grow uses 200 cols; recheck retry; grace removed (no wait before the pane path). |
| **T6** | unit | `src/bun/claude-tmux-askdrive.test.ts` | T2 drive: a fake tmux recording `send-keys` args proves a text step is sent as `-l <text>`, the echo verification passes/resends/fails, and `steps` ordering; `decideAskDriveStep` table untouched. |
| e2e | — | not applicable: the fake claude driver renders no tmux pane, so nothing in Playwright can exercise the parser or the drive. Replaced by the **live smoke** (§6, Phase 7b). |

**Live smoke recipe (Phase 7b):** `AGETOR_DATA_DIR=<mkdtemp> AGETOR_API_PORT=<free port> bun src/bun/headless.ts` (token: read from the headless log / `api-config.ts`), create a claude-code task (`POST /tasks`, `isolation:"none"`, workdir = a throwaway `git init` dir, model `claude-haiku-4-5-20251001`, prompt asking for ONE AskUserQuestion with 4 questions × 3–4 options × 200-char descriptions), `POST /tasks/:id/start`, poll `GET /tasks/:id/interactions` until an `ask_questions` card exists, assert 4 distinct questions with the full question text (no `│`), then `POST /ask-questions/:id/answer` with picks for Q1–Q3 and a custom text for Q4, and assert the run's tool_result JSONL line carries all four answers (custom as the plain string). Never point the CLI at this core without `--data-dir`/`--port` (the CLI otherwise talks to the user's production core). Kill the headless core and its `agetor-<dir-basename>` tmux server afterwards.

## 6. Execution waves

- **Wave 1 (parallel, file-disjoint):** T1, T3.
- **Barrier:** typecheck.
- **Wave 2:** T2.
- **Phase 5:** code review (opus, `code-review` skill rubric) over `git diff bd5adcb...HEAD`.
- **Phase 6 (parallel):** T4, T5, T6.
- **Phase 7:** `bun run typecheck`; `bun test src/bun/claude-questions.test.ts src/bun/claude-tmux.test.ts src/bun/claude-tmux-askdrive.test.ts src/bun/claude-tmux-scraper.test.ts`; full `bun test` (check `uptime` load first — CLI daemon tests hang under load; 3 pre-existing failures on main are known: tmux-socket ×2 + reconcile cancel); then the live smoke (7b).
- **Phase 8:** fixes, re-run (≤ 3 rounds).

## 7. Blast radius & risks

- `planAskAnswers`'s return shape changes (`keys` → `steps`): consumers are `server.ts` (`/ask-questions/:id/answer`, passes the plan through) and `driveAskAnswers`; tests in `claude-questions.test.ts`. `sendModalKeys` is untouched (still used for `Escape`).
- `__forTest` exports removed: `shouldWaitForAskJsonl`; renamed constant `PREVIEW_PANE_MIN_COLS` → `GROW_PANE_COLS` (grep for both).
- `parseModalPane.complete` is stricter: a pane with no `☐`/`☒` row now reads incomplete → routes to the grow path instead of registering. Older CLIs (≤ 2.1.183) also render the row, so no regression there; a future CLI that drops it would degrade to "grow, then give up after 3 attempts → generic numbered card", never a wrong card.
- Grow width 200: `resize-window -x 200` on an attached client shows a momentarily wide window (restored afterwards, same as today's 120).
- Typed-answer drive: text with tmux-special characters is passed as ONE argv element after `-l` (no shell) — safe; newlines are excluded by the planner. Claude's paste heuristic wraps ~3 KB typed at once; the 400-char cap keeps well under it.
- CLI parity: `agetor answer` posts the same route; TUI `AnswerOverlay` likewise — no change needed (they only send `selected`/`custom`).
- Rollback: revert the branch; no migrations, no persisted-shape changes.

## 8. Open questions / assumptions

- Spike 2 verified the typed-answer sequences (A–F, all WORKS/CONFIRMED). Untested: typed text > 400 chars (capped by the planner), `Esc` from a Type row holding text, 120-col geometry for typing (labels/rows only get wider).
- The wrap-risk margin (12 columns) is a heuristic; a false positive costs one grow.
- The ASCII-glyph fallback (`>`/`[×]`/`√`) is not handled — agetor pins a UTF-8 renderer env; out of scope.

## 9. Completeness ledger

| Candidate remainder | Disposition |
| --- | --- |
| Tab bar scrolled off → single-question card (root cause) | in this run — T1 (D2) + T2 (D1) |
| Swallowed `Right` → duplicated/missing question | in this run — T2 (D3) |
| `│ ` gutter in question text; paragraph breaks | in this run — T1 (D5) + T3 (pre-wrap) |
| Wrapped labels split into label + description | in this run — T2 (D1, grow on wrap risk, 200 cols) |
| Wrapped footer breaks detection | in this run — T1 (D7) |
| 2 s JSONL grace + wrong comments/docs | in this run — T2 (D4) + T3 (CLAUDE.md) |
| Indented description row parsed as an option; `↑`/`↓` edge rows; `Next`/`Submit` rows; `✔` suffix; flat header | in this run — T1 |
| Post-collect recheck discards a good collection | in this run — T2 (D8) |
| Typed custom answers via the native row | in this run — T1 + T2 + T3 (owner: include) |
| Fixtures from 2.1.284 + regression of old fixtures | in this run — T1 + T4 |
| `kind: "text"/"number"` questions | out of scope — gated off for terminal sessions (spike-verified); a terminal never receives them |
| AFK auto-continue handling | out of scope — opt-in (`CLAUDE_AFK_TIMEOUT_MS`), inert by default (125 s idle observed); no agetor behaviour depends on it |
| ASCII-glyph terminals | out of scope — agetor's session env pins a UTF-8 Ink renderer; no report of this |
| ANSI-based active-tab detection | out of scope — superseded by D3 (body verification) |
| e2e test for the parser | out of scope — no seam (fake driver renders no pane); covered by unit fixtures + live smoke |

## 10. Review round 1 (opus, `code-review` rubric) — fix list

Critical `#1` (tab count from the short tail) was fixed in `11ae5ab` before the review landed. The rest, all accepted, are dispositioned into three file-disjoint fix tasks:

| # | Sev | Finding | Fix | Task |
| --- | --- | --- | --- | --- |
| 2 | high | Typed answers driven into preview-layout questions (no `Type something` row; typed chars act as hotkeys, `n` opens notes) | `parseModalPane` records `hasTypeRow` (structural: the numbered row right before the `Chat about this` row, else the `Type something` label); carried on `AskQuestion`/`AskQuestionSpec`; planner sends custom text for a `hasTypeRow === false` question to message mode (`no-type-row`); driver additionally refuses to type unless the focused row is an EMPTY Type row | F-A (parser/planner/type), F-B (driver guard), F-C (route passes it) |
| 3 | high | A failed typed drive leaves a dirty modal; re-collect mis-drives it | `driveAskAnswers` returns `"typed-abort"` distinctly; the route then runs the existing message-mode fallback (Esc + `formatAnswersMessage`); the collector refuses to register unless `cursorIndex === 0` (counts toward the latch); the structural Type-row rule keeps a typed row out of `options` | F-B, F-C |
| 4 | high | `Left` return trip and preview `Up` restore unverified | after the Lefts, compare `tabBodyKey` with tab 0's key, bounded extra Lefts, else count a failure and don't register; after the Ups require `cursorIndex === 0` (bounded extra Ups) | F-B |
| 5 | med | Echo check false negatives on word-wrap / CJK | join the `❯` row with its indented continuation rows, collapse whitespace on both sides, compare the prefix | F-B |
| 6 | med | tmux drops a trailing `;` from `send-keys -l -- <text>` | escape a trailing `;` as `\;` (verified on 3.6a) | F-B |
| 7 | med | Control characters driven as keystrokes | planner: any `[\u0000-\u001f\u007f-\u009f]` → message mode (`unsafe-custom`) | F-A |
| 8 | med | `if (!first) return null` skips grow + latch | a null first parse takes the grow path (n starts at 1, re-derived from the grown capture); the walk's null `base` is counted | F-B |
| 9 | med | `paneWrapRisk` misses long-word wraps | also flag an option/question row followed by an indented continuation row when `row.length + 1 + firstWord(next).length > width` | F-A |
| 10 | low | Scrollback numbered lists defeat the fast path | `paneWrapRisk` scans from the modal's top rule; the fast path parses `sliceModalRegion(firstTail)` | F-A (scan), F-B (slice) |
| 11 | low | `sliceModalRegion` literal `Esc to cancel` | share the wrapped-footer rule | F-B |
| 12 | low | D8 recheck window too short | poll 3 × 150 ms | F-B |
| 13 | low | Review summary shows pick + custom for single-select while the drive sends custom only | `answerSummary` and `formatAnswersMessage`: custom wins for single-select | F-C (UI), F-A (message) |
| 14 | low | Failed drive invisible in the card | toast on `!res.ok` | F-C |
| 15 | low | Stale docs / dead code (`AskAnswer.custom` doc, RunPanel Escape rationale, `approvals-endpoint.test.ts:70` title, OPTION_RE column doc, plan §7 "500" → 400, dead `custom-text` reason) | fix each | F-A / F-C |

Also landed between waves (outside the review's diff): `d4df873` — 2.1.284's unnumbered workspace-trust dialog is now auto-confirmed (found by the live smoke, which stalled on it), and a bare `Chat about this` row can no longer be folded into an option description.

## 11. Review round 2 — all round-1 findings verified fixed; 10 new (2 medium, 8 low), all fixed in `41b2126`

| # | Sev | Finding | Fix |
| --- | --- | --- | --- |
| N1 | med | typed-abort fallback never verified the Escape closed the modal or cleaned the composer | `dismissAskModalForMessage` (Escape ×≤2, verify `detectAskModal === null`, `COMPOSER_CLEAR_KEYS` only when a draft is visible, re-verify); the route pastes only on a clean composer, else `ok:false` + reason |
| N2 | med | boot-confirm retry could land a stale Enter on a "No, exit"-default dialog | retry only after two identical post-window sightings, 1.5 s window, Enter-only when the cursor is already on the affirmative |
| N3 | low | one flicker frame emitted a false `auto-confirmed` and reset the cap | a dialog counts as gone only after two absent polls |
| N4 | low | give-up left no card | falls through to the generic prompt card |
| N5 | low | `bootSettled` exit lost the breadcrumb | flush on that path too, but only for dialogs not matched on the last poll (no false breadcrumb on a boot timeout) |
| N6 | low | echo check matched the placeholder row for `T`/`Type`… | rows matching `EMPTY_TYPE_ROW_RE` never count |
| N7 | low | Left verification could not leave the review tab | presses Left when the capture is the review screen |
| N8 | low | backslashes before a trailing `;` | the reviewer's `2k+1` formula was verified WRONG on tmux 3.6a (tmux eats exactly one backslash); the existing `\;` escape is correct and now pinned by tests |
| N9 | low | failure toast wrong on the message path | route returns `delivery: "drive" \| "message"`; toast worded per path |
| N10 | low | structural Type-row lookup not scoped to the modal | nearest row above the Chat row |

Verification at `41b2126`: typecheck green; ask-related suites 516 tests green; full suite and a final live smoke (4-question card, typed answers, and a preview-layout question answered by the message path) recorded in the final report.
