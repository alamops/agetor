// Noise filtering for `TmuxPromptCard`'s pane excerpt (RunPanel.tsx).
//
// Background: when the tmux pane scraper catches a REPL modal it hasn't
// carved into a first-class card (plan-mode dialog aside), it registers a
// `tmux_prompt` interaction whose `paneText` is the raw last-12-lines tail of
// the pane (see `lines.slice(-12)` in `claude-tmux.ts`). That tail is
// display-only chrome, not agetor's own copy, so it drags in whatever claude's
// TUI happened to be drawing right next to the modal: keyboard-shortcut
// footers ("esc to cancel", "↑/↓ to navigate", …) and — because the working
// spinner footer sits directly above/below modals in the same viewport —
// claude's "is working" status line too (e.g.
// `"✱ Scurrying… (1m 13s · ↓ 3.7k tokens · esc to interrupt)"`). None of that
// helps the user answer the prompt, so it's stripped before display. Purely
// textual — no React/DOM dependency — so it's unit-testable on its own (see
// the paired test task).

/**
 * Line-level noise patterns. Kept as small, independently testable regexes
 * rather than one mega-pattern so a bad match is easy to isolate and a new
 * footer variant is a one-line addition.
 */
export const PROMPT_NOISE_RE = [
  /^esc to cancel\b/i,
  /^enter to (confirm|select|continue)\b/i,
  /^↑\/↓/,
  /^tab to amend\b/i,
  /\bctrl\+e to explain\b/i,
  /\(ctrl\+b ctrl\+b/i,
  /to run in background\)/i,
  // claude's TUI "is working" spinner/status footer, e.g.
  // "✱ Scurrying… (1m 13s · ↓ 3.7k tokens)" or
  // "* Reticulating… (3s · esc to interrupt)". The leading glyph (✱ ✳ ✶ ✻ ✽
  // · * +, or none) and the gerund verb both rotate freely across claude
  // versions, so anchoring on either would be a whack-a-mole game. Instead
  // this anchors on the one structural invariant: an ellipsis (either the
  // single "…" glyph or "...") immediately followed by a parenthesized tail
  // that carries a duration ("1m 13s", "3s"), a token count ("3.7k tokens"),
  // and/or "esc to interrupt". That combination doesn't occur in legitimate
  // modal body/choice text (e.g. "Do you want to proceed?", "1. Yes, run
  // it") or in a plain "please wait…" status line with no parenthesized
  // tail, so it can't be tripped by those.
  /(?:…|\.\.\.)\s*\([^)]*(?:\d+\s*[hms]\b|\btokens?\b|\besc to interrupt\b)[^)]*\)\s*$/i,
];

/** Does `line` match one of the noise patterns above? */
export function isPromptNoiseLine(line: string): boolean {
  return PROMPT_NOISE_RE.some((re) => re.test(line));
}

/**
 * Strips noise lines and collapses tmux repaint duplicates (the same line
 * emitted twice in a row as the pane redraws) from a scraped pane excerpt.
 */
export function cleanPromptPane(text: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (isPromptNoiseLine(line.trim())) continue;
    if (out.length > 0 && out[out.length - 1] === line) continue; // repaint dup row
    out.push(line);
  }
  return out.join("\n").replace(/^\n+|\n+$/g, "");
}
