export interface SubmitShortcutKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * True when `e` is the "run it" chord of a launch form: Cmd+Enter on macOS,
 * Ctrl+Enter elsewhere. Same modifier rule as `isFindShortcut`: the primary
 * modifier is `metaKey` on macOS and `ctrlKey` elsewhere, and the *other*
 * modifier being held disqualifies the chord. Alt and Shift also disqualify:
 * Shift+Enter means "new line" in every composer, and Alt+Enter is not ours.
 */
export function isSubmitShortcut(e: SubmitShortcutKey, isMac: boolean): boolean {
  if (e.key !== "Enter") return false;
  if (e.altKey || e.shiftKey) return false;
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/**
 * Whether a recognised chord may actually run the form. It is inert when a
 * descendant already consumed the key (`defaultPrevented`, e.g. an
 * autocomplete picking a suggestion), while a popover is open inside the
 * form's scope, and while Run is disabled.
 */
export function shouldFireSubmit(s: {
  defaultPrevented: boolean;
  scopeHasOpenPopover: boolean;
  canRun: boolean;
}): boolean {
  return !s.defaultPrevented && !s.scopeHasOpenPopover && s.canRun;
}
