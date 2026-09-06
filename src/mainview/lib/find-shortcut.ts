export interface FindShortcutKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/**
 * True when `e` is the platform find chord: Cmd+F on macOS, Ctrl+F
 * elsewhere. Mirrors `fontSizeShortcutAction`'s modifier rule
 * (`src/mainview/lib/font-size.ts`): the primary modifier is `metaKey` on
 * macOS, `ctrlKey` elsewhere, and the *other* modifier being also held
 * disqualifies — Mac wants meta-without-ctrl, other platforms want
 * ctrl-without-meta — so a combo like Ctrl+Cmd+F, which some window
 * managers or IMEs can report, doesn't ambiguously fire both this and a
 * platform-native binding. `altKey` also disqualifies, for the same reason
 * font-size's shortcut disqualifies it: Option/Alt-modified keys produce
 * different glyphs on some layouts and aren't part of this shortcut's
 * contract. Shift is tolerated (`key.toLowerCase()`) for parity with
 * RunPanel's pre-existing Cmd/Ctrl+F behavior, which never checked
 * `shiftKey`.
 */
export function isFindShortcut(e: FindShortcutKey, isMac: boolean): boolean {
  if (e.altKey) return false;
  if (e.key.toLowerCase() !== "f") return false;
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/**
 * Selector for the layers that outrank the find chord: a modal dialog
 * (`[role="dialog"][aria-modal="true"]`) or an open popover
 * (`[data-popover-open]`) — so ⌘F doesn't hijack the browser/OS's own find
 * behavior, or a dialog's own input, while one of those is up. Popovers
 * marked `data-popover-keys="escape-only"` (SlashAutocomplete,
 * AtFileAutocomplete, ExtensionPicker) are excluded from the guard: they
 * only want Escape yielded to them, so ⌘F stays live while the `/` or `@`
 * menu or the Extensions popover is open (see the `data-popover-keys`
 * convention documented in CLAUDE.md's "Shared task-composition modules"
 * bullet, and this exact string previously inline in RunPanel.tsx's
 * Cmd/Ctrl+F handler).
 */
export const FIND_SHORTCUT_BLOCKING_LAYERS =
  '[role="dialog"][aria-modal="true"], [data-popover-open]:not([data-popover-keys="escape-only"])';
