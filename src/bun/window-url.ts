import { preferences } from "./db.ts";
import type { ThemePreference } from "../shared/types.ts";

/**
 * Resolve the persisted theme preference for the boot payload. Falls back to
 * "auto" for a missing key or any value that isn't one of the three known
 * preferences — same default `parseThemePreference` (src/mainview/lib/theme.ts)
 * applies client-side, reimplemented here rather than imported since
 * src/bun and src/mainview are separate processes that only share
 * src/shared (see CLAUDE.md).
 */
export function resolveThemePreference(): ThemePreference {
  const stored = preferences.get("theme");
  return stored === "dark" || stored === "light" ? stored : "auto";
}

/**
 * Pure builder for the URL hash fragment carrying the per-launch boot
 * payload to the dev (Vite `http://`) window URL — `#api=<port>&token=<token>&theme=<pref>`.
 * Exported so a bun-side test can assert on the exact fragment shape without
 * constructing a BrowserWindow. This only backs the `isHttpUrl` branch below;
 * the bundled `views://` path threads the same three fields through
 * `bootGlobals` (`window.__AGETOR`) instead, since that scheme handler
 * rejects URLs carrying a fragment (see the comment on `buildWindow` below).
 */
export function buildWindowHash(input: { port: string; token: string; theme: ThemePreference }): string {
  return `#api=${input.port}&token=${input.token}&theme=${input.theme}`;
}
