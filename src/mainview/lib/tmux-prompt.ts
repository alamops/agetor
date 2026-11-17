import { OAUTH_CODE_MAX_LEN, oauthCodeErrorText, validateOAuthCode } from "../../shared/oauth-code.ts";

// Display helpers for `TmuxPromptCard`'s choice buttons (RunPanel.tsx).
//
// Background: every `tmux_prompt` choice carries a synthetic 1-based `key`
// that the answer route validates and `dismissTmuxPrompt` navigates to (arrow
// keys from the observed cursor, then Enter) — it is never typed literally for
// a menu widget. For a NUMBERED pane (a tool-permission dialog, the `/model`
// picker) the key is also on screen: the card's `1. Yes` matches the pane's
// `❯ 1. Yes`, so showing it is helpful. For an UNNUMBERED pane (issue #298's
// "Claude in Chrome extension detected" prompt, claude 2.1.322's `er` select
// with `hideIndexes`) there is no number anywhere in the TUI, and inventing
// one would just be wrong: the reporter's card showed numbered buttons for a
// two-row menu that had none.
//
// The `hideKeys` flag on `PendingTmuxPrompt` / `TmuxPromptRequest` (set only by
// `matchUnnumberedModal`) tells this helper which shape it is looking at.
// Purely textual — no React/DOM dependency — so it is unit-testable on its
// own (see the paired test).

/** One choice as the webview receives it (`PendingTmuxPrompt["choices"][n]`). */
export interface TmuxChoiceLike {
  key: string;
  label: string;
}

/**
 * The button text for a tmux prompt choice.
 *
 * `hideKeys === true` → the pane's own label, verbatim (`"Yes, use my
 * browser"`). Anything else (false / undefined, i.e. every numbered, yes-no
 * and slider prompt) → the long-standing `"<key>. <label>"` form
 * (`"2. Yes"`).
 */
export function tmuxChoiceLabel(choice: TmuxChoiceLike, hideKeys?: boolean): string {
  return hideKeys === true ? choice.label : `${choice.key}. ${choice.label}`;
}

/** What a `tmux_prompt` card asks of the user (`PendingTmuxPrompt.answerKind`,
 *  absent ≡ a choice card). Anything but the literal `"enter"` / `"code"` is a
 *  choice card: the value crosses an SSE JSON boundary, and a wrong guess here
 *  would offer a text box on a menu. */
export function tmuxPromptAnswerKind(req: { answerKind?: unknown }): "choice" | "enter" | "code" {
  return req.answerKind === "enter" || req.answerKind === "code" ? req.answerKind : "choice";
}

/** The most an OAuth code box accepts (the shared limit; the server validates again). */
export const OAUTH_CODE_INPUT_MAX_LEN = OAUTH_CODE_MAX_LEN;

/** The shared validator, to disable Submit and say why. Returns the trimmed
 *  code, or a fixed reason that never quotes the value. The server is the
 *  authority. */
export function checkOAuthCodeInput(raw: string): { ok: true; code: string } | { ok: false; reason: string } {
  const r = validateOAuthCode(raw);
  return r.ok ? r : { ok: false, reason: oauthCodeErrorText(r.error) };
}
