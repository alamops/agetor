import * as React from "react";
import { toast } from "sonner";
import { FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN } from "../../shared/types.ts";
import { api } from "@/lib/api";
import {
  fontSizeShortcutAction,
  isMacPlatform,
  readFontSizeFromBoot,
  rootFontSizeStyle,
  stepFontSize,
  type FontSizeAction,
} from "@/lib/font-size";

export interface FontSizeContextValue {
  percent: number;
  setPercent: (pct: number) => void;
  increase: () => void;
  decrease: () => void;
  reset: () => void;
}

const FontSizeContext = React.createContext<FontSizeContextValue | null>(null);

/**
 * Mount once near the React root, alongside `ThemeProvider` — see App.tsx's
 * root export for where the two are wired in together.
 *
 * Seeds `percent` synchronously from whichever boot channel carried it
 * (`window.__AGETOR.fontSize` for the bundled `views://` path, else the URL
 * hash for the Vite dev path) — the same value `src/bun/index.ts` resolved
 * and `index.html`'s inline boot script already applied to `<html>` before
 * first paint, so this provider's initial render is a no-op repaint, not the
 * moment scaling first takes effect. Mirrors `ThemeProvider`'s seeding
 * exactly (see that file's doc comment for the full rationale).
 *
 * The keydown listener is registered in the **capture phase** so a focused
 * xterm pane (which attaches its own key handler — see `TerminalView.tsx`)
 * can't swallow the shortcut first; `terminal-keys.ts`'s `macEditSequence`
 * doesn't map any of `=`/`+`/`-`/`_`/`0`, so there's no real contention, but
 * capture-phase + `preventDefault()` would win regardless. The shortcut is
 * deliberately global — it fires with focus anywhere (an input, a terminal,
 * a dialog) since Cmd+=/−/0 have no conflicting editable-text meaning.
 */
export function FontSizeProvider({ children }: { children: React.ReactNode }) {
  const [percent, setPercentState] = React.useState<number>(() => {
    if (typeof window === "undefined") return FONT_SIZE_DEFAULT;
    return readFontSizeFromBoot((window as unknown as { __AGETOR?: unknown }).__AGETOR, window.location.hash);
  });

  React.useEffect(() => {
    const root = document.documentElement;
    const style = rootFontSizeStyle(percent);
    if (style === null) {
      root.style.removeProperty("font-size");
    } else {
      root.style.fontSize = style;
    }
  }, [percent]);

  // Mirrors ThemeProvider's `preferenceRef` pattern: read via a ref inside
  // the stable-identity callbacks below so a failed save can roll back to
  // whatever was current *at the moment of that call*, without making the
  // callbacks depend on (and be re-created by) `percent`.
  const percentRef = React.useRef(percent);
  percentRef.current = percent;

  const setPercent = React.useCallback((pct: number) => {
    const previous = percentRef.current;
    setPercentState(pct);
    void api.setPreference("fontSize", String(pct)).catch(() => {
      setPercentState(previous);
      toast.error("Couldn't save font size preference", {
        description: "Reverted to the previous setting — try again.",
      });
    });
  }, []);

  const applyStep = React.useCallback(
    (action: FontSizeAction) => {
      const next = stepFontSize(percentRef.current, action);
      if (next === percentRef.current) return;
      setPercent(next);
      if (next === FONT_SIZE_MAX) {
        toast(`Font size: maximum (${FONT_SIZE_MAX}%)`, { id: "font-size" });
      } else if (next === FONT_SIZE_MIN) {
        toast(`Font size: default (${FONT_SIZE_MIN}%)`, { id: "font-size" });
      } else {
        toast(`Font size: ${next}%`, { id: "font-size" });
      }
    },
    [setPercent],
  );

  const increase = React.useCallback(() => applyStep("increase"), [applyStep]);
  const decrease = React.useCallback(() => applyStep("decrease"), [applyStep]);
  const reset = React.useCallback(() => applyStep("reset"), [applyStep]);

  React.useEffect(() => {
    const isMac = isMacPlatform();
    const onKey = (e: KeyboardEvent) => {
      const action = fontSizeShortcutAction(e, isMac);
      if (!action) return;
      e.preventDefault();
      applyStep(action);
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [applyStep]);

  const value = React.useMemo<FontSizeContextValue>(
    () => ({ percent, setPercent, increase, decrease, reset }),
    [percent, setPercent, increase, decrease, reset],
  );

  return <FontSizeContext.Provider value={value}>{children}</FontSizeContext.Provider>;
}

export function useFontSize(): FontSizeContextValue {
  const ctx = React.useContext(FontSizeContext);
  if (!ctx) throw new Error("useFontSize must be used inside <FontSizeProvider>");
  return ctx;
}
