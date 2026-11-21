/**
 * Pure helpers for the native-menu actions the webview receives
 * (`menu_action` AppEvent, `src/bun/app-menu.ts`) and for ⌘, in the page.
 * `App.tsx`'s `runMenuAction` is the single place an action runs; the event
 * handler and the ⌘, listener both call it. Contract: docs/architecture/app-bar.md.
 */
import { APP_MENU_ACTIONS, type AppMenuAction } from "../../shared/types.ts";

/** A menu action does nothing while a modal dialog is open: the dialog owns
 *  the screen, and a click on the bar is blocked by its overlay too. */
export const MENU_ACTION_BLOCKING_LAYERS = '[role="dialog"][aria-modal="true"]';

export function isAppMenuAction(v: unknown): v is AppMenuAction {
  return typeof v === "string" && (APP_MENU_ACTIONS as readonly string[]).includes(v);
}

/** ⌘, on macOS, Ctrl+, elsewhere. Any extra modifier disqualifies it. */
export function isSettingsShortcut(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  isMac: boolean,
): boolean {
  if (e.key !== ",") return false;
  if (e.altKey || e.shiftKey) return false;
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}
