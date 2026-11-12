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
