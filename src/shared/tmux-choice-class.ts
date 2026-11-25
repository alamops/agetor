/**
 * Classifies one choice of a tmux card (`TmuxPromptChoice {key, label}`) for the phone router (grill D8, D9).
 *
 * FAIL CLOSED. Only EXACT known label shapes are `once` or `reject`; a label with an extra word, a different wording
 * or a missing "Yes" is `unknown`, and an always-style row ("don't ask again", "allow all", "during this session") is
 * `always`. The router refuses `always` and `unknown` from a phone ("Answer on your Mac"), signs `once`, and treats
 * `reject` as removal. The ExitPlanMode modal's three rows are `plan-auto`, `plan-manual` and `plan-revise`, but only
 * when the prompt text really is that modal.
 *
 * The labels come from rows seen in src/bun/claude-tmux-scraper.test.ts, claude-prompt-screens.ts and
 * claude-tmux-card-drive.test.ts. Extend the tables here (and add a fixture) when a new exact shape needs a phone answer.
 * Pure: no imports from either process.
 */

export type TmuxChoiceClass = "once" | "reject" | "always" | "unknown" | "plan-auto" | "plan-manual" | "plan-revise";

/** Exact labels that run or accept something one time. */
const ONCE_LABELS: ReadonlySet<string> = new Set([
  "Yes",
  "Yes, proceed",
  "Yes, I trust this folder",
  "Yes, I accept",
]);

/** Exact labels that decline. */
const REJECT_LABELS: ReadonlySet<string> = new Set([
  "No",
  "No, exit",
  "No, go back",
  "No, keep browser tools off",
  "No, and tell Claude what to do differently",
  "No, cancel",
  "Cancel",
]);

/** Any "Yes" row that widens the grant beyond this one action. Checked before the exact tables. */
const ALWAYS_RE = /\b(?:don'?t ask again|do not ask again|allow all|always|for the rest of|during this session|for this session|every time|from now on|remember)\b/i;

const PLAN_AUTO = "Yes, and use auto mode";
const PLAN_MANUAL = "Yes, manually approve edits";
const PLAN_REVISE = "Tell Claude what to change";

/** Key hints Claude Code prints at the end of a row. Only these are stripped; anything else makes the label unknown. */
const TRAILING_HINT_RE = /\s+\((?:esc|shift\+tab|ctrl\+g|recommended)\)$/i;

/** The label as the row's own words: no cursor glyph, no "N." prefix, no key hint, single spaces. */
export function normalizeChoiceLabel(label: string): string {
  let s = label.replace(/\s+/g, " ").trim();
  s = s.replace(/^[❯>›▶●○◉]\s*/, "");
  s = s.replace(/^\d{1,2}[.)]\s+/, "");
  s = s.replace(TRAILING_HINT_RE, "");
  return s.trim();
}

/** True when the prompt text is the ExitPlanMode approval modal: its first two rows are both on screen. */
export function isClaudePlanModal(promptText: string): boolean {
  return promptText.includes(PLAN_AUTO) && promptText.includes(PLAN_MANUAL);
}

export function classifyTmuxChoice(promptText: string, choice: { key?: string; label: string }): TmuxChoiceClass {
  const label = normalizeChoiceLabel(choice.label);
  if (label.length === 0 || label.length > 200) return "unknown";

  if (isClaudePlanModal(promptText)) {
    if (label === PLAN_AUTO) return "plan-auto";
    if (label === PLAN_MANUAL) return "plan-manual";
    if (label === PLAN_REVISE) return "plan-revise";
    // Any other row of the plan modal (a clear-context variant, say) is not on the allow list.
    return ALWAYS_RE.test(label) ? "always" : "unknown";
  }

  if (/^Yes\b/i.test(label) && ALWAYS_RE.test(label)) return "always";
  if (ONCE_LABELS.has(label)) return "once";
  if (REJECT_LABELS.has(label)) return "reject";
  if (/^Yes\b/i.test(label) || ALWAYS_RE.test(label)) return /\b(?:always|allow all|don'?t ask again)\b/i.test(label) ? "always" : "unknown";
  return "unknown";
}
