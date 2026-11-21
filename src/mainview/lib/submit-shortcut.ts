import { KEYBOARD_OWNING_POPOVERS } from "./find-shortcut";

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
 * The open popovers inside a launch form's scope that make the chord inert
 * wherever focus is. A popover marked `data-popover-keys="escape-only"` (the
 * `/` and `@` autocompletes, the `@` "couldn't list files" notice, the
 * Extensions popover) only wants Escape yielded to it, so it is left out here:
 * the `/` and `@` menus consume Enter themselves (native listener on the
 * textarea, `preventDefault`, seen as `defaultPrevented`), and a key typed
 * inside any open popover is held back by `keyFromInsidePopover` instead.
 * See the `data-popover-keys` convention in docs/architecture/prompt-composer.md.
 * For a portaled picker (`ui/picker.tsx`) this is a backstop: its panel takes
 * focus in `document.body`, outside the scope, so the key never reaches the
 * form's listener while it is open.
 */
export const SUBMIT_BLOCKING_POPOVERS = KEYBOARD_OWNING_POPOVERS;

/**
 * Whether a recognised chord may actually run the form. It is inert when a
 * descendant already consumed the key (`defaultPrevented`, e.g. an
 * autocomplete picking a suggestion), while a popover that owns the keyboard
 * is open inside the form's scope (`SUBMIT_BLOCKING_POPOVERS`), when the key
 * was typed inside an open popover of any kind (the Extensions popover's
 * search box handles Enter in a React handler that runs after this
 * listener), and while Run is disabled.
 */
export function shouldFireSubmit(s: {
  defaultPrevented: boolean;
  scopeHasBlockingPopover: boolean;
  keyFromInsidePopover: boolean;
  canRun: boolean;
}): boolean {
  return !s.defaultPrevented && !s.scopeHasBlockingPopover && !s.keyFromInsidePopover && s.canRun;
}
