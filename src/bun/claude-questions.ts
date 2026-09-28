/**
 * Native AskUserQuestion modal: detection, pane parsing, and answer-keystroke
 * planning.
 *
 * Agetor no longer intercepts AskUserQuestion via the PreToolUse hook. Claude
 * renders its native Ink modal in the tmux pane; the scraper detects it (via
 * `detectAskModal`), the run panel renders an agetor-native card from the
 * question content scraped off the pane (`parseModalPane`, walking tabs for a
 * multi-question modal), and the user's answer is driven back into the pane as
 * keystrokes and typed text (`planAskAnswers`).
 *
 * The pane is the ONLY live source of the question. Spike-verified on claude
 * 2.1.284: the AskUserQuestion `tool_use` is NOT written to the session JSONL
 * while the modal is open — nothing lands on disk until the user answers or
 * declines, at which point `assistant tool_use` + `user tool_result` flush in
 * one batch. (Same result as fleet knowledge for 2.1.168/2.1.170.)
 *
 * Everything here is derived from captures of claude-code's AskUserQuestion
 * TUI (see src/bun/fixtures/askuserquestion/*.txt — the `v284_*` files are real
 * 2.1.284 captures, the rest are 2.1.161–2.1.183). The keystroke state-machine
 * is documented inline so a future claude version that changes the bindings can
 * be re-validated against fresh captures.
 *
 * Observed state machine (claude 2.1.284)
 * ───────────────────────────────────────
 * Every modal starts with a full-width `─` rule; the footer is
 * `Enter to select · ↑/↓ to navigate · Esc to cancel` (flat) or
 * `Enter to select · Tab/Arrow keys to navigate · Esc to cancel` (tabbed). With
 * the cursor on the Type/Chat row claude inserts ` · ctrl+g to edit in Vim`
 * before `Esc`, and at 80 cols the tabbed footer then WRAPS (`… · Esc to` /
 * `cancel`) — so footer detection must tolerate the wrap.
 *
 * Single question, single-select — NO tab bar, NO review screen:
 *     ☐ <header>
 *
 *    │ <question>                          ← `│ ` gutter on EVERY row when the
 *    │ <question, wrapped>                    question wraps; a bare `│` row is
 *                                             a paragraph break inside it
 *    ❯ 1. <opt>
 *         <description>                    ← indent 5 (9 when multiSelect)
 *      2. <opt>
 *      N. Type something.                  ← inline text input (see below)
 *    ──────
 *      N+1. Chat about this                ← escape hatch (every modal has it)
 *    Drive: Down×idx, Enter → resolves immediately.
 *
 * Multi-question (and a single multiSelect question) — tab bar:
 *     ←  ☐ <h1>  ☐ <h2>  ✔ Submit  →     (`☐` unanswered, `☒` answered; the
 *                                          ACTIVE tab is marked only by ANSI
 *                                          colour — plain capture is identical
 *                                          for every tab)
 *    <question for the active tab>
 *    ❯ 1. [ ] <opt>                       ← checkboxes when multiSelect
 *      ...
 *      N. [ ] Type something
 *         Next                            ← unnumbered but a REAL focusable row
 *                                           (`Submit` on the last question)
 *      N+1. Chat about this
 *    - the cursor resets to option 1 every time you enter a tab;
 *    - multiSelect option + Enter  → toggles [ ]↔[✔], cursor stays put;
 *    - single-select option + Enter → selects AND auto-advances one tab;
 *    - Right / Left move one tab and CLAMP at the ends (no wrap); Tab does
 *      nothing; all three are dead while the cursor is on a Type/Chat row
 *      (Left/Right move the text caret there instead);
 *    - the final "✔ Submit" tab is a review screen (it has no footer):
 *          Review your answers
 *           ● <question>
 *             → <answer, answer>
 *          Ready to submit your answers?
 *          ❯ 1. Submit answers
 *            2. Cancel
 *      Enter (cursor defaults to "1. Submit answers") submits everything.
 *      `planAskAnswers` marks this shape with `confirmsReview: true`, so the
 *      driver (`driveAskAnswers` in claude-tmux.ts) withholds that final
 *      Enter until the review screen is actually rendered — and, once sent,
 *      re-verifies the modal actually closed rather than trusting the
 *      keystroke's exit code, since the review screen's full-summary repaint
 *      is Ink's heaviest and can swallow a keystroke arriving mid-repaint.
 *
 * The "Type something." row (the Other / custom entry) is an INLINE TEXT INPUT
 * in 2.1.284: typing fills it (`❯ 4. purple`, the row keeps its number), and
 * the recorded answer is the plain string. Semantics `planAskAnswers` drives:
 *    - single-select: typing then Enter submits the text as the answer (and
 *      auto-advances, or resolves for a lone flat question). The row is ONE
 *      choice, so typed text replaces any highlighted option;
 *    - multiSelect: typing AUTO-CHECKS the row (`❯ 5. [✔] Peppers`), and Enter
 *      on that row would UN-check it — so the advance goes Down onto the real
 *      `Next`/`Submit` row and Enter there;
 *    - Enter on an EMPTY Type row declines the whole modal — never send it.
 * A custom answer that can't be typed safely (multi-line, containing control
 * characters, over `ASK_TYPED_ANSWER_MAX_CHARS`, or for a question with no Type
 * row — the preview layout, where typed characters would be hotkeys) falls back
 * to `mode: "message"`: Esc to dismiss the modal, then send the formatted answer
 * as a normal follow-up.
 */

import { createHash } from "node:crypto";
import type { AskQuestion } from "./interactions.ts";

/** A tmux key name we send via `send-keys` (no `-l`, so these are keys). */
export type NavKey = "Up" | "Down" | "Left" | "Right" | "Enter" | "Escape" | "Tab";

/** One question as it arrives in the AskUserQuestion tool_use input. Mirrors
 *  the `AskQuestion` shape in interactions.ts but flattened to option labels —
 *  the planner only needs the label order + multiSelect. */
export interface AskQuestionSpec {
  question: string;
  multiSelect: boolean;
  /** Option labels in the exact order claude rendered them (the JSONL order). */
  options: string[];
  /** Whether the live modal has an inline "Type something" row (the only place
   *  a custom answer can be typed). `false` for the preview layout, which
   *  renders just a bare `Chat about this`; `undefined` (unknown / JSONL-sourced
   *  spec) is treated as "has one" — the normal layout. */
  hasTypeRow?: boolean;
}

/** The user's answer to a single question, from the agetor card. */
export interface AskAnswer {
  /** Picked option labels (must be a subset of the spec's `options`). */
  selected: string[];
  /** Free-text "Other" answer. Typed into the modal's native "Type something"
   *  row and driven like any pick — unless it is multiline, contains control
   *  characters, is over {@link ASK_TYPED_ANSWER_MAX_CHARS}, or the question has
   *  no Type row (`spec.hasTypeRow === false`), in which case the whole submit
   *  falls back to message mode. */
  custom?: string;
}

/** One driver action for a `drive` plan: a tmux key, or literal text typed into
 *  the modal's inline "Type something" input (`send-keys -l`, never a key
 *  name — so the type system stops a text step being sent as a key). */
export type DriveStep = NavKey | { type: "text"; text: string };

/**
 * How to deliver the answer back to claude:
 *  - `drive`: emulate keystrokes (and typed text for a custom answer) into the
 *     native modal and let claude record a real structured tool_result.
 *     `steps` is the full sequence, including the trailing confirm `Enter`
 *     when the drive ends on the "Ready to submit your answers?" review
 *     screen. `confirmsReview` tells the driver whether that trailing key is
 *     a blind Enter (false — the singleFlat case, a single single-select
 *     question, resolves directly on the selection Enter and no review screen
 *     ever renders) or a confirm that must be sent only once the review
 *     screen is actually on the pane (true — every other shape). The driver
 *     (`driveAskAnswers` in claude-tmux.ts) uses this flag to gate and verify
 *     the confirm instead of firing it blind.
 *  - `message`: dismiss the modal (Esc) and post the answer as a normal turn.
 *     Used when the answer can't be driven safely (empty answer, unknown
 *     label, arity mismatch, a multi-line / control-char / over-long custom text,
 *     or a custom answer for a question with no Type row). `text`
 *     is the message body to paste; `reason` explains the choice (for logs).
 */
export type SubmitPlan =
  | { mode: "drive"; steps: DriveStep[]; confirmsReview: boolean }
  | { mode: "message"; text: string; reason: string };

/* ────────────────────────────────────────────────────────────────────────── *
 * Detection / parsing (for the pane scraper)
 * ────────────────────────────────────────────────────────────────────────── */

/** The "Chat about this" escape hatch is present on every AskUserQuestion
 *  question screen and on nothing else claude renders — the strongest single
 *  signature we have. The review screen drops it for the submit/cancel pair. */
const QUESTION_SIGNATURE = /Chat about this/;
const REVIEW_SIGNATURE = /Ready to submit your answers\?/;
const SUBMIT_CHOICE = /\bSubmit answers\b/;
/** `Esc to cancel` — at 80 cols the tabbed footer with the `ctrl+g to edit in
 *  Vim` hint WRAPS as `… · Esc to` / `cancel`, so tolerate one line break. */
const FOOTER_SIGNATURE = /Esc to[ \t]*\n?[ \t]*cancel/;

/** Tab bar line, e.g. `←  ☐ Toppings  ☒ Size  ✔ Submit  →`. Its presence (or
 *  any `[ ]`/`[✔]` checkbox option) marks the multi-question / multiSelect
 *  variant. */
const TAB_BAR_SIGNATURE = /✔\s*Submit/;
const CHECKBOX_OPTION = /^\s*[›❯]?\s*\d+\.\s*\[[ x✔]\]/m;

export type AskModalKind = "question" | "review";

export interface ParsedAskModal {
  kind: AskModalKind;
  /** True when the modal uses the tab bar / checkbox (multiSelect or
   *  multi-question) layout — the variant that ends on a review screen. */
  tabbed: boolean;
  /** Trailing slice of the pane shown verbatim in the card as a fallback when
   *  the structured question content can't be parsed off the pane. */
  paneText: string;
  /** Stable hash of the matched block — used for the scraper's two-tick
   *  stability gate and dup suppression, same contract as the numbered modal. */
  fingerprint: string;
}

/**
 * Classify the trailing pane text. Returns the modal kind or null. Cheap and
 * allocation-light so the 1s scraper tick can call it every poll.
 */
export function detectAskModal(tail: string): AskModalKind | null {
  if (REVIEW_SIGNATURE.test(tail) && SUBMIT_CHOICE.test(tail)) return "review";
  if (QUESTION_SIGNATURE.test(tail) && FOOTER_SIGNATURE.test(tail)) return "question";
  return null;
}

/** Whether the question screen is the tabbed (multiSelect / multi-question)
 *  variant rather than the flat single-select one. */
export function isTabbedAskModal(tail: string): boolean {
  return TAB_BAR_SIGNATURE.test(tail) || CHECKBOX_OPTION.test(tail);
}

/**
 * Parse the trailing pane into a {@link ParsedAskModal}, or null when no
 * AskUserQuestion modal is present. The card *content* is parsed separately by
 * {@link parseModalPane}, so this deliberately extracts only what the scraper
 * needs: kind, layout flavour, a display snippet, and a fingerprint.
 */
export function parseAskModal(tail: string): ParsedAskModal | null {
  const kind = detectAskModal(tail);
  if (!kind) return null;
  const tabbed = kind === "review" ? true : isTabbedAskModal(tail);
  const lines = tail.split("\n");
  // Show the last ~14 non-trailing-blank lines: enough for the question +
  // options (or the review summary) without dragging in unrelated scrollback.
  const trimmed = lines.map((l) => l.replace(/\s+$/, ""));
  while (trimmed.length && trimmed[trimmed.length - 1] === "") trimmed.pop();
  const paneText = trimmed.slice(-14).join("\n");
  const fingerprint = createHash("sha1")
    .update(`ask:${kind}:${tabbed ? "tabbed" : "flat"}:${paneText}`)
    .digest("hex");
  return { kind, tabbed, paneText, fingerprint };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Pane parsing (the ONLY live source of question content)
 *
 * Claude does not write the pending AskUserQuestion tool_use to the session
 * JSONL until the modal is answered (verified on 2.1.284), so the rendered tmux
 * pane is the sole source of the question text + options while it is open.
 * `parseModalPane` extracts the currently visible question from that pane; for
 * a multi-question (tabbed) modal the caller walks the tabs (one `→` at a
 * time) and parses each, since only the active tab's options are on screen.
 * Because `capture-pane` only ever shows what fits on the live window, a tall
 * modal can push its top (tab bar / header / question) off the visible area, and
 * a long option label soft-wraps at the pane width — `complete` on the returned
 * {@link ParsedQuestionPane}, {@link paneWrapRisk} and {@link isLossyAskPane}
 * flag those cases so the caller (the driver in claude-tmux.ts) knows not to
 * trust a partial read.
 * ────────────────────────────────────────────────────────────────────────── */

export interface ParsedQuestionPane {
  /** True when the modal uses the multi-question tab bar. */
  tabbed: boolean;
  /** Question headers from the tab bar (e.g. ["Toppings","Size"]); [] when flat. */
  tabHeaders: string[];
  /** The active question's prompt text. */
  questionText: string;
  /** True when options render as `[ ]`/`[✔]` checkboxes (multiSelect). */
  multiSelect: boolean;
  /** Real answer options — excludes "Type something" / "Chat about this" / "Next".
   *  `preview` is the focused option's example panel scraped from the side box
   *  (only the highlighted option's preview is ever on the pane); `previewTruncated`
   *  is true when the TUI collapsed it to "✂ N lines hidden" and a taller pane is
   *  needed to read it in full. */
  options: Array<{ label: string; description?: string; checked: boolean; preview?: string; previewTruncated?: boolean }>;
  /** 0-based cursor position among `options`, or -1 when the cursor is elsewhere
   *  (including on the Type row, which is not an option). */
  cursorIndex: number;
  /** True when the modal has an inline "Type something" row. Detected
   *  structurally: the numbered row directly above the numbered `Chat about
   *  this` row IS the Type row whatever its label (once text is typed it reads
   *  `❯ 4. purple` / `❯ 5. [✔] Peppers`), and it is excluded from `options`.
   *  Falls back to the `Type something` label when there is no numbered Chat
   *  row. False for the preview layout (bare, unnumbered `Chat about this`,
   *  no Type row), where typed characters would act as hotkeys. */
  hasTypeRow: boolean;
  /** True when this parse is trustworthy: the first real option's rendered
   *  number is `1`, non-empty question text was gathered, a `[☐☒]` row (the flat
   *  ` ☐ Header` or the tab bar) sits ABOVE the question block inside the parsed
   *  text, AND the option list isn't {@link windowed}. `false` means the capture
   *  is missing its top (or part of its list) and must not be trusted to drive
   *  an answer. The `[☐☒]` requirement is the important one: on an 80x24 pane a
   *  tall modal scrolls the tab bar (and question head) off the top while option
   *  1 is still visible, and the old rule (option 1 + non-empty question) then
   *  registered a 4-question modal as ONE question. A hard-wrapped option 1
   *  description can likewise be mistaken for the question text once option 1's
   *  own label row is off-screen (see `truncated_top` fixture). The caller
   *  (claude-tmux.ts) decides what to do about it — grow the pane and retry,
   *  or (as a last resort) refuse to register a card at all. */
  complete: boolean;
  /** True when an `↑`/`↓` marker sits in the pointer column of an option row —
   *  claude windows the option list (≤ 5 rows) on short panes, so some options
   *  are off-screen. */
  windowed: boolean;
  /** The ` ☐ Header` row's text when the modal is flat (single-select single
   *  question, no tab bar); undefined for a tabbed modal (see `tabHeaders`) or
   *  when the header row isn't on the pane. */
  flatHeader?: string;
}

/** A numbered option row: up to 3 leading spaces, then an optional `❯`/`›` cursor
 *  (group 1) or `↑`/`↓` window-edge marker (group 2) in the pointer column and
 *  one optional space, number (group 3), optional `[ ]`/`[✔]` checkbox
 *  (group 4), then the label (group 5). Without a pointer the number must start
 *  within the first 4 columns, so a description row indented 5+ that merely
 *  begins `2. …` is never an option. */
const OPTION_RE = /^\s{0,3}(?:([❯›])|([↑↓]))?\s?(\d{1,2})\.\s+(?:\[([ xX✔])\]\s*)?(.+?)\s*$/;
/** A revisited, already-answered option carries a trailing ` ✔`. */
const ANSWERED_SUFFIX_RE = /\s+✔$/;

/**
 * When an AskUserQuestion option carries a `preview` example panel, claude
 * renders a **side-by-side** layout: the option list on the left, a
 * box-drawn preview panel on the right of the focused option. tmux
 * `capture-pane` flattens that into text, so the preview box ends up on the
 * SAME rows as the option labels — e.g.
 *
 *     ❯ 1. One combined line            ┌────────────────────────────┐
 *       2. Separate name + flag         │ Name on one line, role tag  │
 *                                       │ — or —                      │
 *                                       ├─── ✂ ─── 2 lines hidden ────┤
 *                                       └─────────────────────────────┘
 *                                       Notes: press n to add notes
 *
 * Left as-is, `OPTION_RE` swallows the box content into the label and the
 * description-gather loop scoops up the box rows — so option 2 above renders
 * as `Separate name + flag | Name on one line, role tag …`. Strip the right-hand
 * preview column from every captured row before parsing: cut a trailing
 * `<≥2 spaces gutter><box-corner/border char>…` segment off each line.
 *
 * Two guards keep this from eating real text:
 *  - the trigger char must be a corner/vertical/scissor char, NOT a bare
 *    `─`/`━`, so full-width separator rows (which start at column 0 with
 *    horizontals) are preserved; and
 *  - the candidate segment must contain at least TWO box-drawing chars — a
 *    genuine panel row always has them (both borders `│ … │`, a `┌──┐`/`└──┘`
 *    edge, or `├── ✂ ──┤`), whereas a label that merely happens to contain a
 *    lone `│` after a double space (e.g. `Use A  │ B`) is left intact.
 *
 * The pane is the only live source of the question (the JSONL tool_use isn't
 * written until the modal is answered), so this keeps the lossy pane read from
 * garbling labels. */
const PREVIEW_COLUMN_RE = /\s{2,}[┌┐└┘├┤┬┴┼│╭╮╰╯✂].*$/u;
const BOX_DRAWING_CHAR = /[┌┐└┘├┤┬┴┼│╭╮╰╯✂─━]/gu;
export function stripPreviewColumn(line: string): string {
  const m = PREVIEW_COLUMN_RE.exec(line);
  if (!m) return line;
  const boxChars = m[0].match(BOX_DRAWING_CHAR)?.length ?? 0;
  return boxChars >= 2 ? line.slice(0, m.index) : line;
}
/** Rows that look like options but are the modal's built-in actions, not real
 *  answers. */
const EXCLUDED_OPTION = /^(Type something\.?|Chat about this)$/;

/* ────────────────────────────────────────────────────────────────────────── *
 * Side-by-side preview panel
 *
 * `stripPreviewColumn` (above) cleans the box OFF each row so it can't bleed
 * into a label/description. `extractFocusedPreview` (below) does the opposite —
 * it reads the FOCUSED option's preview text OUT of that box. claude renders the
 * panel to the RIGHT of the option list, one option at a time;
 * `collectAskQuestionsFromPane` walks the options to collect them all. Verified
 * against real 2.1.170 / 2.1.183 captures (fixtures single_preview_full /
 * single_preview_truncated): borders ┌─┐│├┤└┘, 1-space interior padding, tall
 * previews collapsed to "├── ✂ N lines hidden ──┤".
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Extract the FOCUSED option's `preview` from a pane capture's side panel.
 * Returns the joined preview text plus whether the TUI truncated it
 * ("✂ N lines hidden"), or null when no panel is on the pane. Column-anchored on
 * the ┌…┐ top border so preview content that itself contains box glyphs can't
 * confuse it. Drops the box's 1-space left padding and trailing padding while
 * preserving interior (e.g. ASCII-art) indentation and blank lines.
 */
export function extractFocusedPreview(
  lines: string[],
): { text: string; truncated: boolean } | null {
  const cp = lines.map((l) => [...l]);
  let top = -1, left = -1, right = -1;
  for (let i = 0; i < cp.length; i++) {
    const l = cp[i]!;
    const lc = l.indexOf("┌");
    if (lc < 2 || l[lc - 1] !== " " || l[lc - 2] !== " ") continue; // need a ≥2-space gutter
    const rc = l.indexOf("┐", lc + 1);
    if (rc < 0) continue;
    top = i; left = lc; right = rc; break;
  }
  if (top < 0) return null;

  const out: string[] = [];
  let truncated = false;
  for (let i = top + 1; i < cp.length; i++) {
    const l = cp[i]!;
    const lb = l[left];
    if (lb === "└") break;                 // bottom border → panel end
    if (lb === "├") { truncated = true; break; } // "├── ✂ N lines hidden ──┤"
    if (lb !== "│") break;                 // panel ended unexpectedly (defensive)
    let inner = l.slice(left + 1, right).join("");
    if (inner.startsWith(" ")) inner = inner.slice(1); // drop the 1-space left pad
    out.push(inner.replace(/\s+$/, ""));   // drop right padding; keep interior
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  if (out.length === 0 && !truncated) return null;
  return { text: out.join("\n"), truncated };
}

/**
 * Parse the currently-visible AskUserQuestion modal from a tmux pane capture.
 * Returns null when no question modal is on the pane. The review/submit screen
 * is intentionally not parsed here (it has no options to answer).
 */
export function parseModalPane(tail: string): ParsedQuestionPane | null {
  if (!QUESTION_SIGNATURE.test(tail) || !FOOTER_SIGNATURE.test(tail)) return null;
  // Trim trailing whitespace from each row. Read the focused option's preview
  // from the side panel BEFORE stripping it off, then strip every row so the
  // box never bleeds into a label / description / the question text below.
  const rawLines = tail.split("\n").map((l) => l.replace(/\s+$/, ""));
  const focusedPreview = extractFocusedPreview(rawLines);
  const lines = rawLines.map(stripPreviewColumn);

  // Tab bar (multi-question only): `←  ☐ Toppings  ☒ Size  ✔ Submit  →`.
  const tabLine = lines.find((l) => /✔\s*Submit/.test(l) && /[☐☒]/.test(l));
  const tabHeaders = tabLine
    ? tabLine.replace(/[←→]/g, "").split(/\s{2,}/).map((s) => s.trim())
        .filter((s) => /^[☐☒]/.test(s)).map((s) => s.replace(/^[☐☒]\s*/, "").trim())
    : [];

  // Every numbered row, in order. `num` is the row's own rendered number
  // (e.g. `1` in "❯ 1. Red") — kept alongside the label so the completeness
  // check below can tell a genuine option 1 from a capture that starts mid-
  // list because the top of the modal scrolled off the visible pane. `edge`
  // marks a `↑`/`↓` window-edge row.
  type RawRow = { idx: number; cursor: boolean; edge: boolean; num: number; checkbox: string | null; label: string };
  const raw = lines
    .map((l, idx): RawRow | null => {
      const m = l.match(OPTION_RE);
      return m
        ? {
            idx,
            cursor: !!m[1],
            edge: !!m[2],
            num: Number(m[3]),
            checkbox: m[4] ?? null,
            label: m[5]!.replace(ANSWERED_SUFFIX_RE, "").trim(),
          }
        : null;
    })
    .filter((r): r is RawRow => r !== null);

  // Real answer options (drop the built-in "Type something" / "Chat about this").
  // The Type row is found STRUCTURALLY first: it is the numbered row directly
  // above the numbered `Chat about this` row, whatever it currently says — once
  // the user has typed into it, it reads `❯ 4. purple` / `❯ 5. [✔] Peppers` and
  // a label match would mistake it for a real option. Without a numbered Chat
  // row (the preview layout renders it bare) fall back to the label.
  const chatRow = raw.find((r) => r.label === "Chat about this");
  const typeRow = chatRow ? raw.find((r) => r.num === chatRow.num - 1) : undefined;
  const kept = raw.filter((r) => r !== typeRow && !EXCLUDED_OPTION.test(r.label));
  const hasTypeRow = typeRow !== undefined || raw.some((r) => /^Type something\.?$/.test(r.label));
  if (kept.length === 0) return null;
  const multiSelect = kept.some((r) => r.checkbox !== null);
  const cursorIndex = kept.findIndex((r) => r.cursor);
  const windowed = raw.some((r) => r.edge);

  // A per-option description renders on the line right below it (e.g. "Add
  // cheese"). Grab it when present; skip when the next line is another option,
  // a separator, "Next"/"Submit", blank, or the footer.
  const isNoise = (l: string | undefined): boolean =>
    l === undefined || l.trim() === "" || /^[─-]{3,}$/.test(l.trim())
    // The preview layout renders "Chat about this" as a bare, unnumbered row
    // directly under the last option — never part of that option's description.
    || l.trim() === "Chat about this"
    || /^(Next|Submit)$/.test(l.trim()) || /Esc to cancel/.test(l) || OPTION_RE.test(l)
    // TUI chrome that the pane sometimes interleaves with options: an option's
    // multi-line `preview`/description collapsed to "✂ N lines hidden" / "── N
    // lines hidden ──", and the "press n to add notes" hint. Never part of a
    // description — keep them out so the card isn't garbled in the pane fallback.
    || /✂|\blines hidden\b/.test(l) || /^Notes:|press n to add notes/i.test(l.trim());
  const options: ParsedQuestionPane["options"] = kept.map((r) => {
    // A description may hard-wrap across several rows; gather every row between
    // this option and the next noise boundary (next option / separator / blank
    // / footer), not just the first.
    const descLines: string[] = [];
    for (let i = r.idx + 1; !isNoise(lines[i]); i++) descLines.push(lines[i]!.trim());
    return {
      label: r.label,
      description: descLines.length > 0 ? descLines.join(" ") : undefined,
      checked: r.checkbox === "✔" || r.checkbox?.toLowerCase() === "x",
    };
  });

  // Question text: claude hard-wraps a long question across several pane rows —
  // and prefixes EVERY row of a wrapped question with a `│ ` gutter (a bare `│`
  // row is a paragraph break inside a multi-paragraph question). Gather the
  // whole contiguous block just above the first option — skipping the blank /
  // tab bar / `☐ <header>` / separator that frame it — strip the gutter, join
  // wrapped rows with a space and paragraphs with "\n". Taking only the nearest
  // row (the old behaviour) dropped everything but the wrapped tail (e.g.
  // "OpenAI). How are they used?").
  const firstOptIdx = kept[0]!.idx;
  const paragraphs: string[][] = [[]];
  let topIdx = -1; // index of the topmost gathered question row
  let gathered = 0;
  for (let i = firstOptIdx - 1; i >= 0; i--) {
    const l = lines[i]!.trim();
    if (/^[☐☒←→]/.test(l) || /✔\s*Submit/.test(l) || /^[─-]{3,}$/.test(l)) {
      if (gathered > 0) break;       // a frame row above the gathered block → done
      continue;                      // frame row below the question → keep scanning up
    }
    if (l === "") {
      if (gathered > 0) break;       // blank above the question → top boundary
      continue;                      // blank between question and options → skip
    }
    if (l === "│") {                 // paragraph break inside the question
      if (gathered > 0 && paragraphs[0]!.length > 0) paragraphs.unshift([]);
      continue;
    }
    paragraphs[0]!.unshift(l.replace(/^│ ?/, "").trim()); // a (possibly wrapped) question row
    topIdx = i;
    gathered++;
  }
  const questionText = paragraphs.filter((p) => p.length > 0).map((p) => p.join(" ")).join("\n");

  // The modal's top: the first non-blank row above the question block must be
  // the `[☐☒]` header (flat) or tab bar. Absent ⇒ the top scrolled off.
  let headerRow: string | null = null;
  if (topIdx >= 0) {
    for (let i = topIdx - 1; i >= 0; i--) {
      const l = lines[i]!.trim();
      if (l === "") continue;
      if (/^(?:←\s*)?[☐☒]/.test(l)) headerRow = l;
      break;
    }
  }
  const flatHeaderMatch = tabHeaders.length === 0 && headerRow ? /^[☐☒]\s*(.+)$/.exec(headerRow) : null;
  const flatHeader = flatHeaderMatch ? flatHeaderMatch[1]!.trim() : undefined;

  // The side panel only ever shows the highlighted option's preview — attach it
  // to the cursor option. The caller walks the options (one Down at a time),
  // re-parsing at each focus, to collect every option's preview.
  if (focusedPreview && cursorIndex >= 0 && options[cursorIndex]) {
    options[cursorIndex]!.preview = focusedPreview.text;
    options[cursorIndex]!.previewTruncated = focusedPreview.truncated;
  }

  // Completeness verdict: trustworthy only when the first REAL option is
  // rendered as "1." (nothing above it — including option 1's own label row
  // — scrolled off the captured pane), we actually gathered question text,
  // the modal's `[☐☒]` header / tab bar is visible above that text, and the
  // option list isn't windowed. "Type something." / "Chat about this" are
  // excluded from `kept` before this check, so it can't be fooled by them ever
  // landing at number 1 — claude always numbers real options first and appends
  // those two last.
  const complete =
    kept[0]!.num === 1 && questionText.trim().length > 0 && headerRow !== null && !windowed;

  return {
    tabbed: tabHeaders.length > 0,
    tabHeaders,
    questionText,
    multiSelect,
    options,
    cursorIndex,
    hasTypeRow,
    complete,
    windowed,
    ...(flatHeader !== undefined ? { flatHeader } : {}),
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Lossy-pane detection (drives the driver's "grow the pane and re-read" path)
 * ────────────────────────────────────────────────────────────────────────── */

/** Width of the modal's own full-width `─` rule row (the widest run of only `─`
 *  that is at least 20 columns), or 0 when there is none. */
function modalRuleWidth(lines: string[]): number {
  let width = 0;
  for (const l of lines) {
    const t = l.replace(/\s+$/, "");
    if (t.length >= 20 && /^─+$/.test(t) && t.length > width) width = t.length;
  }
  return width;
}

/**
 * True when an option label or question row reached within 12 columns of the
 * pane's right edge — a label that hit the edge has probably soft-wrapped, and
 * a wrapped label's continuation lands at the description indent (5 cols), so
 * the parser would split one label into "label + fake description". The pane
 * width is the length of the modal's own `─` rule row; false when there is no
 * such row. False positives only cost one grow-and-re-read.
 *
 * Also true when an option (or ungutted question) row is followed by an
 * indented continuation row and would not have fit the continuation's first
 * word on its own line (`row + 1 + word > width`) — Ink's real wrap condition,
 * which trips well short of the edge when the next token is a long path/URL.
 * Only rows from the modal's own header / tab bar down are inspected, never the
 * scrollback above it.
 *
 * Question rows that carry the `│ ` gutter don't count: claude gutters EVERY
 * row of a wrapped question and `parseModalPane` rejoins them, so a wrapped
 * question is fully recovered and near-edge gutter rows are the normal case.
 * (An ungutted question row near the edge is suspect, since a genuinely wrapped
 * question would have been gutted.) Description rows likewise are joined, not
 * split, so they are ignored.
 */
export function paneWrapRisk(tail: string): boolean {
  const lines = tail.split("\n").map((l) => stripPreviewColumn(l.replace(/\s+$/, "")));
  const width = modalRuleWidth(lines);
  if (width === 0) return false;
  const limit = width - 12;
  const parsed = parseModalPane(tail);
  // The modal's own top bounds the region we inspect — rows above it are
  // scrollback (an echoed user prompt, an earlier numbered list…), often
  // full-width text that says nothing about the modal. The top is the header /
  // tab-bar row (`[☐☒]`, the last one on the pane); when it has scrolled off
  // there is nothing to bound by, so the whole capture counts.
  let scanStart = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*(?:←\s*)?[☐☒]/.test(lines[i]!)) { scanStart = i; break; }
  }
  const firstOptIdx = lines.findIndex((l, i) => {
    if (i < scanStart) return false;
    const m = l.match(OPTION_RE);
    return m !== null && !EXCLUDED_OPTION.test(m[5]!.trim());
  });
  const isNoiseRow = (l: string): boolean => {
    const t = l.trim();
    return t === "" || /^[─-]{3,}$/.test(t) || t === "Chat about this" || /^(Next|Submit)$/.test(t)
      || /Esc to cancel/.test(l) || /✂|\blines hidden\b/.test(l) || /^Notes:|press n to add notes/i.test(t);
  };
  for (let i = scanStart; i < lines.length; i++) {
    const l = lines[i]!;
    const isOption = OPTION_RE.test(l);
    // A question-block row: between the modal's header and the first option,
    // not the tab bar / header, and without the `│` gutter.
    const isUngutteredQuestion =
      !isOption && parsed !== null && firstOptIdx >= 0 && i >= scanStart && i < firstOptIdx
      && !/^[─-]{3,}$/.test(l.trim()) && !/^\s*(?:←\s*)?[☐☒]/.test(l) && !/✔\s*Submit/.test(l)
      && !/^\s*│/.test(l) && l.trim() !== "";
    if (!isOption && !isUngutteredQuestion) continue;
    if (l.length >= limit) return true;
    // Ink wraps a row as soon as its next word would not fit, so a long token
    // (a path, a URL) wraps well short of the edge: the row is followed by an
    // indented continuation that `parseModalPane` would read as a description.
    const next = lines[i + 1];
    if (
      next !== undefined && /^ {5,}\S/.test(next) && !OPTION_RE.test(next) && !isNoiseRow(next)
      && l.length + 1 + (next.trim().split(/\s+/)[0]?.length ?? 0) > width
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether reading the question off this pane can't be trusted as-is and the
 * caller should grow the pane and re-read: the parse is incomplete (top
 * scrolled off, first option off-screen, windowed list), a `✂`/`lines hidden`
 * collapse marker is present (a preview or description was truncated), or a
 * label/question probably wrapped ({@link paneWrapRisk}). A null parse is NOT
 * lossy — callers only ask once `detectAskModal` already said "question".
 */
export function isLossyAskPane(tail: string): boolean {
  const parsed = parseModalPane(tail);
  if (parsed !== null && !parsed.complete) return true;
  if (/✂|\blines hidden\b/.test(tail)) return true;
  return paneWrapRisk(tail);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Answer-keystroke planning
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Build the message body used for the `mode: "message"` fallback (custom
 * text, or anything we can't drive). Phrased as the user's own answer so
 * claude — which just saw "User declined to answer questions" from the Esc —
 * reads it as the response and continues. Mirrors the shape of claude's own
 * answered-questions string for familiarity.
 */
export function formatAnswersMessage(specs: AskQuestionSpec[], answers: AskAnswer[]): string {
  const parts = specs.map((spec, i) => {
    const a = answers[i] ?? { selected: [] as string[] };
    const custom = a.custom && a.custom.trim() ? a.custom.trim() : null;
    // A single-select question has exactly one answer, and the typed drive lets
    // the custom text win over any pick — the message must say the same.
    const pieces = custom !== null && !spec.multiSelect ? [] : [...a.selected];
    if (custom !== null) pieces.push(custom);
    const value = pieces.length ? pieces.join(", ") : "(no answer)";
    const escape = (s: string) => s.replace(/"/g, '\\"');
    return `"${escape(spec.question)}"="${escape(value)}"`;
  });
  return `Here are my answers: ${parts.join(", ")}.`;
}

/** Longest custom (typed) answer `planAskAnswers` will drive into the native
 *  "Type something" row — the largest size verified byte-exact live on 2.1.284
 *  (one `send-keys -l`), and well under claude's ~3 KB typed-paste heuristic.
 *  Longer text falls back to message mode. */
export const ASK_TYPED_ANSWER_MAX_CHARS = 400;

/** Reasons a submit falls back to message-mode. Exported for assertions. */
export type MessageFallbackReason =
  | "multiline-custom"
  | "unsafe-custom"
  | "custom-too-long"
  | "no-type-row"
  | "empty-answer"
  | "unknown-option"
  | "arity-mismatch";

/**
 * Plan how to deliver `answers` for `specs` to the native modal.
 *
 * Returns `mode:"drive"` with the exact step list (keys + typed text) when every
 * answer can be entered into the modal, and `mode:"message"` otherwise (the
 * driver dismisses the modal and posts {@link formatAnswersMessage} as a turn).
 * Every question is validated up-front; any fallback reason aborts the whole
 * plan to message mode before a single step is emitted.
 *
 * The drive sequence follows the observed 2.1.284 state machine (see the header
 * comment). Per question the cursor starts on option 1, the Type row sits at
 * index `options.length`, and the `Next`/`Submit` row is one below it:
 *   - single-select WITH custom text: `Down × options.length`, type the text,
 *     `Enter` (auto-advances). The Type row is one choice, so custom wins over
 *     any `selected` pick for that question;
 *   - single-select without custom: `Down × idx`, `Enter` (auto-advances);
 *   - multiSelect: for each picked option in ascending index order, arrow to
 *     it and Enter (toggle). Then, with custom text: `Down` onto the Type row,
 *     type the text (which auto-checks it), `Down` onto `Next`/`Submit`,
 *     `Enter` — never `Enter` on the Type row (it un-checks the typed text) and
 *     never on an empty Type row (it declines the modal). Without custom text:
 *     `Right` to advance to the next tab;
 *   - a single single-select question resolves on that Enter (no review
 *     screen); every other shape ends on the review screen, so a trailing Enter
 *     confirms "1. Submit answers". `confirmsReview` mirrors that split (`false`
 *     for the singleFlat case, `true` otherwise) so the driver knows whether the
 *     last step needs to wait for the review screen to render before it's safe
 *     to send.
 * Custom text is trimmed; an empty/whitespace custom counts as absent.
 */
export function planAskAnswers(specs: AskQuestionSpec[], answers: AskAnswer[]): SubmitPlan {
  const fallback = (reason: MessageFallbackReason): SubmitPlan => ({
    mode: "message",
    text: formatAnswersMessage(specs, answers),
    reason,
  });

  if (specs.length !== answers.length) return fallback("arity-mismatch");

  // Validate every question up-front: resolve picks to option indexes and vet
  // the custom text. Bail to message-mode on any empty answer, unplaceable
  // label or untypeable custom text (defensive — the card only ever submits
  // labels from the spec, but an unknown label must never be driven as a blind
  // keypress, and a multi-line/over-long text must never be typed).
  const perQuestion: Array<{ idxs: number[]; custom: string | null }> = [];
  for (let qi = 0; qi < specs.length; qi++) {
    const spec = specs[qi]!;
    const answer = answers[qi]!;
    const custom = answer.custom != null && answer.custom.trim() !== "" ? answer.custom.trim() : null;
    if (custom !== null) {
      if (/[\r\n]/.test(custom)) return fallback("multiline-custom");
      // Typed text is sent as literal keystrokes: a tab, ESC or any other C0/C1
      // control char would act as a key (focus move, dismiss…), not text.
      if (/[\u0000-\u001f\u007f-\u009f]/.test(custom)) return fallback("unsafe-custom");
      if (custom.length > ASK_TYPED_ANSWER_MAX_CHARS) return fallback("custom-too-long");
      // No inline Type row (preview layout): typed characters would be hotkeys.
      if (spec.hasTypeRow === false) return fallback("no-type-row");
      if (!spec.multiSelect) {
        // The Type row is one choice: typed text replaces any highlighted pick.
        perQuestion.push({ idxs: [], custom });
        continue;
      }
    }
    const sel = answer.selected;
    if (custom === null && (!sel || sel.length === 0)) return fallback("empty-answer");
    const idxs = new Set<number>();
    for (const label of sel ?? []) {
      const idx = spec.options.indexOf(label);
      if (idx < 0) return fallback("unknown-option");
      idxs.add(idx);
    }
    if (!spec.multiSelect && idxs.size !== 1) {
      // A single-select question can only carry one pick; more than one means
      // the card and spec disagree — don't guess, fall back.
      return fallback("unknown-option");
    }
    perQuestion.push({ idxs: [...idxs].sort((a, b) => a - b), custom });
  }

  const steps: DriveStep[] = [];
  const singleFlat = specs.length === 1 && !specs[0]!.multiSelect;

  specs.forEach((spec, qi) => {
    const { idxs, custom } = perQuestion[qi]!;
    if (spec.multiSelect) {
      let cursor = 0;
      for (const idx of idxs) {
        const delta = idx - cursor;
        const arrow: NavKey = delta >= 0 ? "Down" : "Up";
        for (let i = 0; i < Math.abs(delta); i++) steps.push(arrow);
        steps.push("Enter"); // toggle this checkbox
        cursor = idx;
      }
      if (custom !== null) {
        // Onto the Type row, type (auto-checks it), then Down onto the real
        // `Next`/`Submit` row and Enter there to advance.
        for (let i = 0; i < spec.options.length - cursor; i++) steps.push("Down");
        steps.push({ type: "text", text: custom });
        steps.push("Down");
        steps.push("Enter");
      } else {
        // multiSelect Enter only toggles — advance to the next tab explicitly.
        steps.push("Right");
      }
    } else if (custom !== null) {
      for (let i = 0; i < spec.options.length; i++) steps.push("Down");
      steps.push({ type: "text", text: custom });
      steps.push("Enter"); // submits the typed text AND auto-advances one tab (except singleFlat)
    } else {
      const idx = idxs[0]!;
      for (let i = 0; i < idx; i++) steps.push("Down");
      steps.push("Enter"); // selects AND auto-advances one tab (except singleFlat)
    }
  });

  // Everything except the flat single-select-single-question case ends on the
  // review screen with the cursor on "1. Submit answers".
  if (!singleFlat) steps.push("Enter");

  return { mode: "drive", steps, confirmsReview: !singleFlat };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Tool-input parsing
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Defensively parse claude's AskUserQuestion tool_use `input` into the
 * `AskQuestion[]` the UI card renders. Skips malformed questions/options
 * rather than throwing — a future claude shape tweak degrades gracefully.
 * Shared by the JSONL tailer (which registers the card) and the legacy
 * /approvals route.
 */
export function parseAskQuestionsInput(input: unknown): AskQuestion[] {
  if (!input || typeof input !== "object") return [];
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const qq = q as Record<string, unknown>;
    if (typeof qq.question !== "string" || !qq.question.trim()) continue;
    const optionsRaw = Array.isArray(qq.options) ? qq.options : [];
    const options = optionsRaw
      .map((o) => (o && typeof o === "object" ? (o as Record<string, unknown>) : null))
      .filter((o): o is Record<string, unknown> => o !== null && typeof o.label === "string")
      .map((o) => ({
        label: o.label as string,
        description: typeof o.description === "string" ? o.description : undefined,
      }));
    out.push({
      question: qq.question,
      header: typeof qq.header === "string" ? qq.header : undefined,
      multiSelect: Boolean(qq.multiSelect),
      options,
    });
  }
  return out;
}
