/**
 * Pure decision logic for the `files-sent` `GlobalEvent` (see
 * `src/shared/types.ts`) — no DOM, no React, no sonner. `App.tsx` calls
 * `notifyFilesSent` (`src/mainview/lib/toasts.ts`), which composes these
 * three functions with the actual toast/native-notification calls. Kept
 * separate so the "when does this fire" rules are unit-testable without a
 * jsdom-shaped harness (this repo has none — see CLAUDE.md's test-seam
 * notes).
 */

/** Cap on the notification body derived from the tool call's `caption`,
 *  matching `RunPanel.tsx`'s `truncateString` convention: a body longer than
 *  this is cut to exactly this many characters plus a trailing ellipsis. */
const CAPTION_BODY_MAX_CHARS = 120;

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/**
 * Title + body for the `files-sent` toast/notification. Title is always
 * present ("1 file sent to you" / "N files sent to you" — singular only at
 * exactly one). Body is the caption's first line, trimmed and capped at
 * {@link CAPTION_BODY_MAX_CHARS}, or `null` when there's no caption (or the
 * first line is blank once trimmed).
 */
export function filesSentCopy(
  input: { count: number; caption: string | null },
): { title: string; body: string | null } {
  const title = input.count === 1 ? "1 file sent to you" : `${input.count} files sent to you`;
  if (input.caption === null) return { title, body: null };
  const firstLine = input.caption.split("\n")[0]?.trim() ?? "";
  const body = firstLine.length > 0 ? truncate(firstLine, CAPTION_BODY_MAX_CHARS) : null;
  return { title, body };
}

/**
 * Whether to show the in-app sonner toast. Suppressed only when the task is
 * both the open RunPanel *and* the window is focused — that's the one case
 * where the delivered-files card is already visible on screen. Every other
 * combination (open panel but backgrounded window, or any other task) gets
 * the toast.
 */
export function shouldToastFilesSent(s: { isSelected: boolean; isFocused: boolean }): boolean {
  return !(s.isSelected && s.isFocused);
}

/**
 * Whether to fire the native OS notification. Normally gated on the window
 * being unfocused (matches every other `maybeNotifyOS` caller in
 * `toasts.ts`), but a `proactive` send — Claude volunteered the files
 * without being asked in the current turn — always notifies, focused window
 * or not: the user has no other signal that something just landed.
 */
export function shouldNotifyOsFilesSent(s: { isFocused: boolean; proactive: boolean }): boolean {
  return !s.isFocused || s.proactive;
}
