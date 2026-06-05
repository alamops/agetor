/**
 * Native AskUserQuestion modal: detection, and answer-keystroke planning.
 *
 * Agetor no longer intercepts AskUserQuestion via the PreToolUse hook. Claude
 * renders its native Ink modal in the tmux pane; the scraper detects it (via
 * `detectAskModal`), the run panel renders an agetor-native card from the
 * structured tool_use content that's already in the JSONL, and the user's
 * answer is driven back into the pane as keystrokes (`planAskAnswers`).
 *
 * Everything here is derived from captures of claude-code 2.1.161's
 * AskUserQuestion TUI (see src/bun/fixtures/askuserquestion/*.txt). The
 * keystroke state-machine is documented inline so a future claude version
 * that changes the bindings can be re-validated against fresh captures.
 *
 * Observed state machine (claude 2.1.161)
 * ───────────────────────────────────────
 * Single question, single-select — NO tab bar:
 *     ☐ <header>
 *    <question>
 *    ❯ 1. <opt>
 *      2. <opt>
 *      N. Type something.            ← the "Other" / custom-text entry
 *    ──────
 *      N+1. Chat about this          ← escape hatch (every modal has this)
 *    "Enter to select · ↑/↓ to navigate · Esc to cancel"
 *    Drive: Down×idx, Enter → submits immediately (there is NO review screen).
 *
 * Multi-question (and a single multiSelect question) — tab bar:
 *     ←  ☐ <h1>  ☐ <h2>  ✔ Submit  →     (a tab flips ☐→☒ once answered)
 *    <question for the active tab>
 *    ❯ 1. [ ] <opt>                       ← checkboxes when multiSelect
 *      ...
 *      Next
 *      N. Chat about this
 *    "Enter to select · Tab/Arrow keys to navigate · Esc to cancel"
 *    - the cursor resets to option 1 every time you enter a tab;
 *    - multiSelect option + Enter  → toggles [ ]↔[✔], cursor stays put;
 *    - single-select option + Enter → selects AND auto-advances one tab;
 *    - Right → next tab;
 *    - the final "✔ Submit" tab is a review screen:
 *          Review your answers
 *           ● <question>
 *             → <answer, answer>
 *          Ready to submit your answers?
 *          ❯ 1. Submit answers
 *            2. Cancel
 *      Enter (cursor defaults to "1. Submit answers") submits everything.
 *
 * "Type something." (the Other/custom entry) does NOT open an inline field in
 * 2.1.161 — selecting it cancels the structured question ("User declined to
 * answer questions") and drops to the REPL. So a custom/free-text answer is
 * delivered the robust, version-independent way instead: Esc to dismiss the
 * modal, then send the formatted answer as a normal follow-up message.
 * `planAskAnswers` returns `mode: "message"` for that path.
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
}

/** The user's answer to a single question, from the agetor card. */
export interface AskAnswer {
  /** Picked option labels (must be a subset of the spec's `options`). */
  selected: string[];
  /** Free-text "Other" answer. Presence forces message-mode delivery. */
  custom?: string;
}

/**
 * How to deliver the answer back to claude:
 *  - `drive`: emulate keystrokes into the native modal and let claude record
 *     a real structured tool_result. Only possible when every answer is a
 *     non-empty subset of preset options.
 *  - `message`: dismiss the modal (Esc) and post the answer as a normal turn.
 *     Used whenever a custom/free-text answer is involved, or the picks can't
 *     be driven safely (empty answer, unknown label, arity mismatch). `text`
 *     is the message body to paste; `reason` explains the choice (for logs).
 */
export type SubmitPlan =
  | { mode: "drive"; keys: NavKey[] }
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
const FOOTER_SIGNATURE = /Esc to cancel/;

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
   *  the structured JSONL content can't be matched. */
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
 * AskUserQuestion modal is present. The card *content* comes from the JSONL
 * tool_use, so this deliberately extracts only what the scraper needs:
 * kind, layout flavour, a display snippet, and a fingerprint.
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
 * Pane parsing (the live source of question content)
 *
 * Claude does NOT write the AskUserQuestion tool_use to the JSONL until the
 * modal is *answered*, so while it's open the only source of the question text
 * + options is the rendered tmux pane. `parseModalPane` extracts the currently
 * visible question; for a multi-question (tabbed) modal the caller walks the
 * tabs (one `→` at a time) and parses each, since only the active tab's options
 * are on screen.
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
  /** Real answer options — excludes "Type something" / "Chat about this" / "Next". */
  options: Array<{ label: string; description?: string; checked: boolean }>;
  /** 0-based cursor position among `options`, or -1 when the cursor is elsewhere. */
  cursorIndex: number;
}

/** A numbered option row: optional `❯`/`›` cursor, number, optional `[ ]`/`[✔]`
 *  checkbox, then the label. */
const OPTION_RE = /^\s*([›❯])?\s*(\d+)\.\s+(?:\[([ xX✔])\]\s*)?(.+?)\s*$/;
/** Rows that look like options but are the modal's built-in actions, not real
 *  answers. */
const EXCLUDED_OPTION = /^(Type something\.?|Chat about this)$/;

/**
 * Parse the currently-visible AskUserQuestion modal from a tmux pane capture.
 * Returns null when no question modal is on the pane. The review/submit screen
 * is intentionally not parsed here (it has no options to answer).
 */
export function parseModalPane(tail: string): ParsedQuestionPane | null {
  if (!QUESTION_SIGNATURE.test(tail) || !FOOTER_SIGNATURE.test(tail)) return null;
  const lines = tail.split("\n").map((l) => l.replace(/\s+$/, ""));

  // Tab bar (multi-question only): `←  ☐ Toppings  ☒ Size  ✔ Submit  →`.
  const tabLine = lines.find((l) => /✔\s*Submit/.test(l) && /[☐☒]/.test(l));
  const tabHeaders = tabLine
    ? tabLine.replace(/[←→]/g, "").split(/\s{2,}/).map((s) => s.trim())
        .filter((s) => /^[☐☒]/.test(s)).map((s) => s.replace(/^[☐☒]\s*/, "").trim())
    : [];

  // Every numbered row, in order.
  const raw = lines
    .map((l, idx) => {
      const m = l.match(OPTION_RE);
      return m ? { idx, cursor: !!m[1], checkbox: m[3] ?? null, label: m[4]!.trim() } : null;
    })
    .filter((r): r is { idx: number; cursor: boolean; checkbox: string | null; label: string } => r !== null);

  // Real answer options (drop the built-in "Type something" / "Chat about this").
  const kept = raw.filter((r) => !EXCLUDED_OPTION.test(r.label));
  if (kept.length === 0) return null;
  const multiSelect = kept.some((r) => r.checkbox !== null);
  const cursorIndex = kept.findIndex((r) => r.cursor);

  // A per-option description renders on the line right below it (e.g. "Add
  // cheese"). Grab it when present; skip when the next line is another option,
  // a separator, "Next", blank, or the footer.
  const isNoise = (l: string | undefined): boolean =>
    l === undefined || l.trim() === "" || /^[─-]{3,}$/.test(l.trim())
    || /^Next$/.test(l.trim()) || /Esc to cancel/.test(l) || OPTION_RE.test(l)
    // TUI chrome that the pane sometimes interleaves with options: an option's
    // multi-line `preview`/description collapsed to "✂ N lines hidden" / "── N
    // lines hidden ──", and the "press n to add notes" hint. Never part of a
    // description — keep them out so the card isn't garbled in the pane fallback.
    || /✂|\blines hidden\b/.test(l) || /^Notes:|press n to add notes/i.test(l.trim());
  const options = kept.map((r) => {
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

  // Question text: claude hard-wraps a long question across several pane rows,
  // so gather the whole contiguous block just above the first option — skipping
  // the blank / tab bar / `☐ <header>` / separator that frame it — and join.
  // Taking only the nearest row (the old behaviour) dropped everything but the
  // wrapped tail (e.g. "OpenAI). How are they used?").
  const firstOptIdx = kept[0]!.idx;
  const qLines: string[] = [];
  for (let i = firstOptIdx - 1; i >= 0; i--) {
    const l = lines[i]!.trim();
    if (/^[☐☒←→]/.test(l) || /✔\s*Submit/.test(l) || /^[─-]{3,}$/.test(l)) {
      if (qLines.length > 0) break; // a frame row above the gathered block → done
      continue;                      // frame row below the question → keep scanning up
    }
    if (l === "") {
      if (qLines.length > 0) break; // blank above the question → top boundary
      continue;                      // blank between question and options → skip
    }
    qLines.unshift(l);               // a (possibly wrapped) question row
  }
  const questionText = qLines.join(" ");

  return { tabbed: tabHeaders.length > 0, tabHeaders, questionText, multiSelect, options, cursorIndex };
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
    const pieces = [...a.selected];
    if (a.custom && a.custom.trim()) pieces.push(a.custom.trim());
    const value = pieces.length ? pieces.join(", ") : "(no answer)";
    const escape = (s: string) => s.replace(/"/g, '\\"');
    return `"${escape(spec.question)}"="${escape(value)}"`;
  });
  return `Here are my answers: ${parts.join(", ")}.`;
}

/** Reasons a submit falls back to message-mode. Exported for assertions. */
export type MessageFallbackReason =
  | "custom-text"
  | "empty-answer"
  | "unknown-option"
  | "arity-mismatch";

/**
 * Plan how to deliver `answers` for `specs` to the native modal.
 *
 * Returns `mode:"drive"` with the exact keystroke list when every question is
 * answered purely from its preset options, and `mode:"message"` otherwise (the
 * driver dismisses the modal and posts {@link formatAnswersMessage} as a turn).
 *
 * The drive sequence follows the observed 2.1.161 state machine:
 *   - per question, the cursor starts on option 1;
 *   - multiSelect: for each picked option in ascending index order, arrow to
 *     it and Enter (toggle), then Right to advance to the next tab;
 *   - single-select: arrow to the one pick and Enter (which auto-advances);
 *   - a single single-select question submits on that Enter (no review screen);
 *     every other shape ends on the review screen, so a trailing Enter confirms
 *     "1. Submit answers".
 */
export function planAskAnswers(specs: AskQuestionSpec[], answers: AskAnswer[]): SubmitPlan {
  const fallback = (reason: MessageFallbackReason): SubmitPlan => ({
    mode: "message",
    text: formatAnswersMessage(specs, answers),
    reason,
  });

  if (specs.length !== answers.length) return fallback("arity-mismatch");

  // Any custom text anywhere → message-mode for the whole submit. The native
  // "Type something." path can't be driven (it bails to the REPL), so we don't
  // try to mix driven picks with a typed answer.
  if (answers.some((a) => a.custom != null && a.custom.trim() !== "")) {
    return fallback("custom-text");
  }

  // Resolve every pick to an option index up-front; bail to message-mode on
  // any empty answer or label we can't place (defensive — the card only ever
  // submits labels from the spec, but an unknown label must never be driven
  // as a blind keypress).
  const perQuestion: number[][] = [];
  for (let qi = 0; qi < specs.length; qi++) {
    const spec = specs[qi]!;
    const sel = answers[qi]!.selected;
    if (!sel || sel.length === 0) return fallback("empty-answer");
    const idxs = new Set<number>();
    for (const label of sel) {
      const idx = spec.options.indexOf(label);
      if (idx < 0) return fallback("unknown-option");
      idxs.add(idx);
    }
    if (!spec.multiSelect && idxs.size !== 1) {
      // A single-select question can only carry one pick; more than one means
      // the card and spec disagree — don't guess, fall back.
      return fallback("unknown-option");
    }
    perQuestion.push([...idxs].sort((a, b) => a - b));
  }

  const keys: NavKey[] = [];
  const singleFlat = specs.length === 1 && !specs[0]!.multiSelect;

  specs.forEach((spec, qi) => {
    const idxs = perQuestion[qi]!;
    if (spec.multiSelect) {
      let cursor = 0;
      for (const idx of idxs) {
        const delta = idx - cursor;
        const arrow: NavKey = delta >= 0 ? "Down" : "Up";
        for (let i = 0; i < Math.abs(delta); i++) keys.push(arrow);
        keys.push("Enter"); // toggle this checkbox
        cursor = idx;
      }
      // multiSelect Enter only toggles — advance to the next tab explicitly.
      keys.push("Right");
    } else {
      const idx = idxs[0]!;
      for (let i = 0; i < idx; i++) keys.push("Down");
      keys.push("Enter"); // selects AND auto-advances one tab (except singleFlat)
    }
  });

  // Everything except the flat single-select-single-question case ends on the
  // review screen with the cursor on "1. Submit answers".
  if (!singleFlat) keys.push("Enter");

  return { mode: "drive", keys };
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
