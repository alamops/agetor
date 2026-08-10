# Plan — Quote-on-select in the messages list

| Field | Value |
| --- | --- |
| Date | 2026-08-10 |
| Source | /implement task: "quote system when the user selects text from the messages list" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/quote-messages-list |
| Base SHA | f241c9d0d61e641046301ef65dd13e4b85080e72 |
| Mode | Autonomous (agetor worktree; owner unreachable mid-task — both human gates self-approved, assumptions logged in §8) |

## 1. Objective & success criteria

Selecting any text in the run panel's messages list (user, assistant, thinking, tool_use, tool_result, status — any rendered event) surfaces a floating **Quote** button (quote icon + "Quote" label) near the selection. It stays visible while the selection is live. Clicking it appends the selected text to the composer as a markdown blockquote (`> ` per line), separated from any existing composer text by one blank line, and focuses the composer with the caret on the line below the inserted quote so the user can keep typing. Repeatable any number of times on the same message draft.

Success = the flow above works in `bun run dev:hmr`, `bun run typecheck` green, unit tests green, e2e spec (or documented fallback, §5) green.

## 2. Context & constraints (Phase 1 findings)

- Messages scroll viewport: `logRef` div in `RunPanel.tsx` (~:2553), content in `logContentRef`; every event block is wrapped in `<div data-evid={…}>` by `wrap()` (~:3746) — usable to scope "selection is inside the stream".
- Nothing in the stream blocks native selection (no `user-select:none` in the render path). `ToolUseBlock`'s header button already guards click-vs-selection via `window.getSelection()?.toString()` (~:4270).
- Composer: controlled `input` state (`RunPanel.tsx:1535`), textarea `sendRef` (`:1791`). Draft autosave keys off `input` state — a plain `setInput(...)` is all persistence needs.
- **Caret-before-focus is load-bearing**: `setSelectionRange(...)` must run *before* `.focus()` (proven bug fix `bcf0d07` — `SlashAutocomplete` syncs caret on the native `focus` event; wrong order can pop the slash menu and eat the next Enter).
- Blank-line join convention: `appendReferences` (`src/shared/refs.ts:24`) and `composeDiffMessage` (`lib/diff-selection.ts:125`) both use `text ? `${text}\n\n${block}` : block` — same contract as this feature's "one line below".
- Floating UI convention: hand-rolled popovers carry `data-popover-open`; RunPanel's Escape listeners check `[role="dialog"][aria-modal="true"], [data-popover-open], [data-search-open]` before closing the panel. The Quote button must carry `data-popover-open` while visible, or Escape will close the panel underneath the user.
- Perf trap: `RunEventList`'s `sections` memo and hoisted `ReactMarkdown` component maps must not receive selection state — selection handling stays imperative (listeners + `getSelection()`), fully outside the message render path.
- "Composing is decoupled from sending": pickers (`ExtensionPicker`, `MessageHistoryPicker`) render whenever the composer renders, gated only on `sending || backlogBusy`, not `canSend`/`modalPending`. Quote follows the same rule.
- Tests: pure logic lives in `src/mainview/lib/*.ts` with colocated `bun:test` `*.test.ts`; **no component test harness** — JSX wiring is verified by typecheck + e2e/manual. E2E: Playwright (`playwright.config.ts`, `e2e/theme.spec.ts`) drives Chromium against `scripts/dev-headless.sh` (real Bun API, dedicated `~/.agetor-dev-e2e` data dir, pinned token). Fake agent drivers exist (`AGETOR_CLAUDE_DRIVER=fake`) to produce run events without tmux/CLI.
- No existing selection-toolbar precedent anywhere in the repo; `position:fixed` + `Range.getBoundingClientRect()` placement is new territory (existing popovers are absolute-in-relative-wrapper).

## 3. Approach & key decisions

- **Pure formatter module** `src/mainview/lib/quote-selection.ts` (no React imports), mirroring `diff-selection.ts` structure:
  - `formatQuote(selected: string): string` — normalize CRLF→LF, strip leading/trailing blank lines, prefix every line with `> ` (bare `>` for empty inner lines). Whitespace-only input → `""`.
  - `appendQuote(existing: string, quoted: string): { text: string; caret: number }` — `""` existing → `quoted + "\n\n"`; else `existing trimmed of trailing whitespace + "\n\n" + quoted + "\n\n"`. `caret = text.length`. The trailing blank line is deliberate: caret lands on a line *below* the quote **and** outside markdown lazy-continuation, so typed text isn't swallowed into the blockquote. Repeat calls naturally stack quotes with single blank lines.
- **Floating button component** `src/mainview/components/kanban/QuoteSelectionButton.tsx`: props `{ containerRef, disabled?, onQuote(quoted: string) }`. Imperative listeners (`selectionchange` on document + scroll/resize repositioning via rAF); shows a `position:fixed` pill (lucide `TextQuote` icon + "Quote" label, `Button` primitive styling, semantic tokens only) near the selection's end rect, clamped to the viewport; visible only while a non-collapsed, non-whitespace selection lives inside `containerRef.current`. `onMouseDown={e => e.preventDefault()}` so clicking doesn't collapse the selection before `onClick` reads it. Carries `data-popover-open` while visible; Escape hides it (and only it). After quoting: `removeAllRanges()` + hide.
- **RunPanel wiring**: mount `<QuoteSelectionButton containerRef={logRef} …/>` only when the editable composer surface exists (not on background-agent tabs, not on archived tasks). Handler: `const { text, caret } = appendQuote(input, quoted); setInput(text); requestAnimationFrame(() => { el.setSelectionRange(caret, caret); el.focus(); })` — caret set **before** focus.
- Rejected alternative: rendering selection state through React props into the stream (breaks the `sections` memo — the search plan explicitly rejected this shape) and a `<mark>`-based highlight (same trap). Rejected `absolute` positioning inside the scroll container (would be clipped by `overflow-y-auto` and complicates coordinates); `fixed` + viewport rect is simpler and scroll-repositioning is cheap.

## 4. Work breakdown — implementation tasks

Single wave, single agent (small, context-sharing feature; splitting risks contract drift for no wall-clock win).

- **T1 — feature (one agent)**
  - Files owned: `src/mainview/lib/quote-selection.ts` (new), `src/mainview/components/kanban/QuoteSelectionButton.tsx` (new), `src/mainview/components/kanban/RunPanel.tsx` (wiring only).
  - Acceptance: behavior in §1; conventions in §2/§3 honored (data-popover-open, caret-before-focus, decoupled-from-sending gating, semantic tokens, no changes to `sections` memo or markdown component maps); `bun run typecheck` green.

## 5. Work breakdown — test tasks

- **TT1 — unit tests** `src/mainview/lib/quote-selection.test.ts` (`bun:test`): multi-line, CRLF, embedded blank lines, whitespace-only → `""`, already-quoted text (gets double-prefixed `> > ` — accepted, it's how quoting quoted text reads in MD), empty/non-empty existing draft joins, caret position, repeated appends stacking.
- **TT2 — e2e** `e2e/quote.spec.ts`: **applies** — the feature is a pure UI flow. Recipe: existing harness (`playwright.config.ts` webServer → `scripts/dev-headless.sh`, data dir `~/.agetor-dev-e2e`, token pinned). Seed a task via `POST /tasks` (isolation `none`), produce stream events via the fake claude driver (`AGETOR_CLAUDE_DRIVER=fake` added to webServer env — inert for the theme spec, which never starts runs) or, if the fake driver can't yield a rendered assistant message, fall back to asserting on the task's *user* message event. In-page: `page.evaluate` builds a `Range` over rendered message text + dispatches `mouseup`/selectionchange, then assert the Quote button appears, click it, assert composer value is the blockquote + trailing blank line and `selectionStart === value.length`. Quote twice → stacked quotes. No pixel assertions (WKWebView ≠ Chromium). If event seeding proves genuinely infeasible in the harness, TT2 downgrades to a documented manual runbook in the final report — recorded, not silent.
- Run commands: `bun test src/mainview/lib/quote-selection.test.ts`, full `bun test`, `bunx playwright test` (no package.json script — invoked directly), `bun run typecheck`.

## 6. Execution waves

- Wave 1: T1 (Phase 4) → checkpoint commit.
- Phase 5: code review (opus) on `git diff f241c9d…HEAD`.
- Wave 2: TT1 + TT2 in parallel (disjoint files: `lib/*.test.ts` vs `e2e/*` + `playwright.config.ts`).
- Phase 7: run unit + typecheck + e2e; Phase 8 fixes if needed.

## 7. Blast radius & risks

- `RunPanel.tsx` is a convergence point for many features — wiring kept minimal (one mount + one handler) to limit merge risk.
- Escape layering: forgetting `data-popover-open` closes the whole panel when the user dismisses the button — covered in acceptance.
- Selection collapse on button mousedown — covered by `preventDefault`.
- Draft autosave picks up programmatic inserts automatically (keyed off `input` state); no server surface touched — zero backend blast radius.
- `selectionchange` fires at high frequency — handler must be cheap (bail fast when no selection / not in container) and reposition via rAF.
- Selections spanning multiple event blocks: `Selection.toString()` inserts newlines between block elements in Chromium/WebKit; each visual line gets its own `> `. Acceptable per A2.

## 8. Open questions / assumptions (autonomous mode — logged, not asked)

- **A1**: Quote is hidden on read-only surfaces (background-agent tabs, archived tasks) — there is no editable composer to insert into there.
- **A2**: Cross-block selections are allowed; the quote is the selection's rendered plain text (markdown syntax stripped by rendering), one `> ` per visual line. Rendered-text (not raw-source) quoting is expected behavior.
- **A3**: Append always goes to the end of the draft (not at caret), per the stated "one line below the previous inputted text".
- **A4**: A trailing blank line follows the quote so the caret sits below it *outside* the blockquote (markdown lazy continuation would otherwise absorb typed text into the quote).
- **A5**: No size cap on quoted text (consistent with diff-selection's A6) and no dedup of identical repeated quotes.
- **A6**: Whitespace-only selections never show the button.
- **A7**: Both human gates (grill, plan approval) self-approved under autonomous mode.
