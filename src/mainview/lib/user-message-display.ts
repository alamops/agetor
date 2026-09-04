/** Preference key used by the Settings toggle and the app-level mirror. */
export const STICKY_USER_MESSAGES_PREF = "stickyUserMessages";

/**
 * Existing installs have no stored value, so sticky must be the fallback.
 * Only an explicit `"false"` selects the standard scrolling chat list;
 * malformed values retain the safe, requested default.
 */
export function parseStickyUserMessagesPreference(value: unknown): boolean {
  return value !== "false";
}
