import * as React from "react";
import type { ResolvedTheme, ThemePreference } from "../../shared/types.ts";
import { api } from "@/lib/api";
import { parseThemePreference, readThemeFromHash, resolveTheme } from "@/lib/theme";

export interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (pref: ThemePreference) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(DARK_MEDIA_QUERY).matches;
}

/**
 * Read the theme preference `src/bun/index.ts` injected via `window.__AGETOR`
 * (the WKUserScript `preload` payload for the bundled `views://` path — see
 * `api.ts`'s identical port/token read for why that path can't use the URL
 * hash). Cast rather than extending the ambient `Window.__AGETOR` type that
 * `api.ts` already declares, to avoid a conflicting redeclaration across files.
 */
function readInjectedTheme(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { __AGETOR?: { theme?: string } }).__AGETOR?.theme;
}

/**
 * Mount once near the React root (not done here — App.tsx owns wiring it in).
 * Seeds `preference` from whichever boot channel carried it — `window.__AGETOR.theme`
 * for the bundled `views://` path, else the URL hash (`#...&theme=...`) for the
 * Vite dev path — the same value `src/bun/index.ts` resolved and `index.html`'s
 * inline boot script already applied to `<html>` before first paint, so this
 * provider's initial render is a no-op repaint, not the moment theming first
 * takes effect.
 *
 * `resolved` tracks the live OS appearance while `preference === "auto"` via
 * a `matchMedia` listener (added/removed as the preference changes), and is
 * re-applied to `document.documentElement` on every change: the `dark` class
 * for Tailwind's `darkMode: "class"`, and `style.colorScheme` for the native
 * chrome (scrollbars, form controls) that no CSS variable reaches.
 *
 * `setPreference` updates local state immediately (optimistic UI), then
 * best-effort persists via `api.setPreference("theme", pref)` — mirroring
 * `onPickDefault`/`onPickTmuxSource` in SettingsDialog.tsx: a persistence
 * failure is swallowed rather than reverted, since the next reconcile from
 * `/preferences` (done by the App.tsx consumer, not here) will catch drift.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = React.useState<ThemePreference>(() => {
    if (typeof window === "undefined") return "auto";
    const injected = readInjectedTheme();
    return injected ? parseThemePreference(injected) : readThemeFromHash(window.location.hash);
  });
  const [resolved, setResolved] = React.useState<ResolvedTheme>(() =>
    resolveTheme(preference, systemPrefersDark()),
  );

  React.useEffect(() => {
    if (preference !== "auto") {
      setResolved(resolveTheme(preference, false));
      return;
    }
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(DARK_MEDIA_QUERY);
    setResolved(resolveTheme("auto", mql.matches));
    const onChange = (e: MediaQueryListEvent) => setResolved(resolveTheme("auto", e.matches));
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [preference]);

  React.useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolved === "dark");
    root.style.colorScheme = resolved;
  }, [resolved]);

  const setPreference = React.useCallback((pref: ThemePreference) => {
    const next = parseThemePreference(pref);
    setPreferenceState(next);
    void api.setPreference("theme", next).catch(() => {
      // Best-effort — matches SettingsDialog's onPickDefault/onPickTmuxSource.
      // A reload re-derives from the boot hash / a later /preferences fetch.
    });
  }, []);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
