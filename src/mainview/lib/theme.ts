import type { ResolvedTheme, ThemePreference } from "../../shared/types.ts";

/**
 * Pure theme-resolution logic — no DOM, no React. This is the unit-tested
 * seam (see `theme.test.ts`); `theme-provider.tsx` and the boot-time inline
 * script in `index.html` are thin DOM-touching wrappers around these
 * functions (the inline script necessarily duplicates the parsing logic
 * since it can't import a module before first paint).
 */

const VALID_PREFERENCES: readonly ThemePreference[] = ["auto", "dark", "light"];

/**
 * Parse a persisted/URL-carried theme value. Anything that isn't exactly
 * `"dark"` or `"light"` — including `undefined`, `null`, numbers, or unknown
 * strings — resolves to `"auto"`, which is the safe/back-compat default for
 * every existing install that predates this feature.
 */
export function parseThemePreference(v: unknown): ThemePreference {
  return typeof v === "string" && VALID_PREFERENCES.includes(v as ThemePreference)
    ? (v as ThemePreference)
    : "auto";
}

/**
 * Resolve a preference to the concrete theme that should be painted. `auto`
 * defers to the caller-supplied system reading (`matchMedia("(prefers-color-scheme: dark)").matches`
 * in the browser) so this function stays synchronous and side-effect-free.
 */
export function resolveTheme(pref: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (pref === "dark") return "dark";
  if (pref === "light") return "light";
  return systemPrefersDark ? "dark" : "light";
}

/**
 * Extract the `theme` param from the boot URL hash (`#api=...&token=...&theme=light`),
 * the same hand-rolled parsing convention `api.ts` uses for `api`/`token` since
 * `URLSearchParams` on a leading `#` needs the `#` stripped first anyway.
 * Tolerant of a missing leading `#`, a missing/empty `theme` key, any param
 * ordering, and malformed input — all of those fall back to `"auto"`.
 */
export function readThemeFromHash(hash: string): ThemePreference {
  const stripped = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!stripped) return "auto";
  try {
    const params = new URLSearchParams(stripped);
    return parseThemePreference(params.get("theme"));
  } catch {
    return "auto";
  }
}
