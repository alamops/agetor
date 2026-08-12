import { preferences } from "./db.ts";
import type { ThemePreference } from "../shared/types.ts";
import { clampFontSizePercent, FONT_SIZE_DEFAULT } from "../shared/types.ts";

/**
 * Resolve the persisted theme preference for the boot payload. Falls back to
 * "auto" for a missing key or any value that isn't one of the three known
 * preferences — same default `parseThemePreference` (src/mainview/lib/theme.ts)
 * applies client-side, reimplemented here rather than imported since
 * src/bun and src/mainview are separate processes that only share
 * src/shared (see CLAUDE.md).
 *
 * This is the first DB read in the window-build path (`buildWindow` in
 * `index.ts` calls it before constructing the `BrowserWindow`) — previously
 * that path did no DB I/O at all. A locked or corrupt SQLite file throwing
 * here must not reject the caller's promise and prevent the main window from
 * ever opening, so a throw is swallowed and treated the same as "nothing
 * stored": fall back to "auto".
 */
export function resolveThemePreference(): ThemePreference {
  let stored: string | null;
  try {
    stored = preferences.get("theme");
  } catch {
    return "auto";
  }
  return stored === "dark" || stored === "light" ? stored : "auto";
}

/**
 * Resolve the persisted font-size preference for the boot payload, mirroring
 * `resolveThemePreference` exactly: a synchronous DB read run through the
 * shared clamp, with any throw (locked/corrupt SQLite file) swallowed and
 * treated as "nothing stored" — falls back to FONT_SIZE_DEFAULT rather than
 * rejecting the caller's promise and blocking the main window from ever
 * opening. `clampFontSizePercent` already normalizes a missing/garbage
 * value to FONT_SIZE_DEFAULT, so the try/catch only needs to guard the read
 * itself.
 */
export function resolveFontSizePreference(): number {
  let stored: string | null;
  try {
    stored = preferences.get("fontSize");
  } catch {
    return FONT_SIZE_DEFAULT;
  }
  return clampFontSizePercent(stored);
}

/**
 * Pure builder for the URL hash fragment carrying the per-launch boot
 * payload to the dev (Vite `http://`) window URL —
 * `#api=<port>&token=<token>&theme=<pref>[&fontSize=<n>]`. Exported so a
 * bun-side test can assert on the exact fragment shape without constructing
 * a BrowserWindow. This only backs the `isHttpUrl` branch below; the bundled
 * `views://` path threads the same fields through `bootGlobals`
 * (`window.__AGETOR`) instead, since that scheme handler rejects URLs
 * carrying a fragment (see the comment on `buildWindow` below).
 *
 * `fontSize` is a required field (callers must always resolve one via
 * `resolveFontSizePreference`), but the param is appended to the hash only
 * when it's not FONT_SIZE_DEFAULT (100) — this keeps the common-case URL
 * identical to the pre-font-size shape, and the mainview's boot parser
 * already defaults an absent param to 100.
 */
export function buildWindowHash(input: {
  port: string;
  token: string;
  theme: ThemePreference;
  fontSize: number;
}): string {
  const base = `#api=${input.port}&token=${input.token}&theme=${input.theme}`;
  return input.fontSize === FONT_SIZE_DEFAULT ? base : `${base}&fontSize=${input.fontSize}`;
}
