import * as React from "react";
import { toast } from "sonner";
import { FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN } from "../../shared/types.ts";
import { api } from "@/lib/api";
import {
  fontSizeShortcutAction,
  readFontSizeFromBoot,
  rootFontSizeStyle,
  stepFontSize,
  type FontSizeAction,
} from "@/lib/font-size";
import { isMacPlatform } from "@/lib/platform";

// Trailing-edge debounce for the persisted write: a burst of Cmd+= presses
// updates the optimistic UI state on every keystroke, but only writes once,
// ~300ms after the last press, with whatever value settled.
const PERSIST_DEBOUNCE_MS = 300;

/** Options accepted by `increase`/`decrease`/`reset`. `silent: true` suppresses
 *  the sonner toast — used by Settings → General's stepper buttons, where the
 *  toast's top-right, very-high-z-index surface can cover the dialog's own
 *  Close button and eat the next click. The keyboard-shortcut path (which has
 *  no on-screen readout to lean on) always calls `applyStep` directly and so
 *  keeps its toast regardless of this option. */
export interface FontSizeStepOptions {
  silent?: boolean;
}

export interface FontSizeContextValue {
  percent: number;
  setPercent: (pct: number) => void;
  increase: (opts?: FontSizeStepOptions) => void;
  decrease: (opts?: FontSizeStepOptions) => void;
  reset: (opts?: FontSizeStepOptions) => void;
  /** Live mirror of `percent`, updated synchronously every render — for
   *  App.tsx's one-shot boot reconcile, which runs inside an async
   *  `.then()` callback where the `percent` value closed over at effect-
   *  registration time would otherwise be stale by the time it resolves.
   *  Not meant for general consumption; prefer `percent` in render. */
  percentRef: React.RefObject<number>;
  /** Flips to `true` the first time the user makes a deliberate font-size
   *  change — a recognized shortcut press or a Settings → General stepper
   *  click (see `applyStep` below) — and never resets. App.tsx's boot
   *  reconcile checks this to avoid clobbering a state the user has already
   *  deliberately changed with a possibly-stale DB read that raced it. */
  hasUserAdjustedRef: React.RefObject<boolean>;
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
 * deliberately global on macOS — it fires with focus anywhere (an input, a
 * terminal, a dialog) since Cmd+=/−/0 have no conflicting editable-text
 * meaning there. On non-Mac dev builds it steps aside for a focused
 * terminal instead: Ctrl+- doubles as readline's `undo` and Ctrl+_ is its
 * literal binding, so swallowing them would break shell editing.
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
  // the stable-identity callbacks below so a failed save can roll back
  // (and a stale write can recognize it's stale) without making those
  // callbacks depend on (and be re-created by) `percent`.
  const percentRef = React.useRef(percent);
  percentRef.current = percent;

  const hasUserAdjustedRef = React.useRef(false);

  // The last value confirmed to have round-tripped to the server (seeded
  // from the boot value, which is either the DB's own last-written value or
  // the untouched default — either way a safe rollback target before any
  // write has completed). Updated only on a successful PUT.
  const persistedRef = React.useRef(percent);

  // Debounce + flush plumbing for the actual network write — see the
  // module doc comment. `generationRef` lets a failed write recognize it's
  // been superseded by a later one (in which case the later write, not this
  // stale failure, should own the eventual rollback-or-not decision).
  const debounceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPctRef = React.useRef<number | null>(null);
  const generationRef = React.useRef(0);

  const doPersist = React.useCallback((pct: number) => {
    const gen = ++generationRef.current;
    void api
      .setPreference("fontSize", String(pct))
      .then(() => {
        persistedRef.current = pct;
      })
      .catch(() => {
        // Only roll back if no newer write has since been scheduled AND the
        // live value hasn't already moved past what this write attempted to
        // persist — either signals a later write should own the outcome
        // instead of this stale failure stomping on it.
        if (generationRef.current !== gen) return;
        if (percentRef.current !== pct) return;
        setPercentState(persistedRef.current);
        toast.error("Couldn't save font size preference", {
          description: "Reverted to the previous setting — try again.",
        });
      });
  }, []);

  const setPercent = React.useCallback(
    (pct: number) => {
      setPercentState(pct);
      pendingPctRef.current = pct;
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        const p = pendingPctRef.current;
        pendingPctRef.current = null;
        if (p !== null) doPersist(p);
      }, PERSIST_DEBOUNCE_MS);
    },
    [doPersist],
  );

  // Flush any still-pending debounced write on unmount (in practice: HMR in
  // dev — this provider mounts once for the app's lifetime otherwise) so a
  // burst right before teardown still round-trips instead of being silently
  // dropped because its timer never got to fire.
  React.useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      const p = pendingPctRef.current;
      pendingPctRef.current = null;
      if (p !== null) doPersist(p);
    };
  }, [doPersist]);

  const applyStep = React.useCallback(
    (action: FontSizeAction, opts?: FontSizeStepOptions) => {
      hasUserAdjustedRef.current = true;
      const next = stepFontSize(percentRef.current, action);
      // Feedback fires for every recognized press, even a no-op at a bound
      // (Cmd+= already at 170%, Cmd+0 already at 100%) — only the state
      // update + persist stay behind the no-change guard below. Skipped
      // entirely for `silent` callers (the Settings stepper), which have
      // their own on-screen readout as feedback instead.
      if (!opts?.silent) {
        if (next === FONT_SIZE_MAX) {
          toast(`Font size: maximum (${FONT_SIZE_MAX}%)`, { id: "font-size" });
        } else if (next === FONT_SIZE_MIN) {
          toast(`Font size: default (${FONT_SIZE_MIN}%)`, { id: "font-size" });
        } else {
          toast(`Font size: ${next}%`, { id: "font-size" });
        }
      }
      if (next === percentRef.current) return;
      setPercent(next);
    },
    [setPercent],
  );

  const increase = React.useCallback(
    (opts?: FontSizeStepOptions) => applyStep("increase", opts),
    [applyStep],
  );
  const decrease = React.useCallback(
    (opts?: FontSizeStepOptions) => applyStep("decrease", opts),
    [applyStep],
  );
  const reset = React.useCallback(
    (opts?: FontSizeStepOptions) => applyStep("reset", opts),
    [applyStep],
  );

  React.useEffect(() => {
    const isMac = isMacPlatform();
    const onKey = (e: KeyboardEvent) => {
      // OS key-repeat on a held Cmd+=/− would otherwise slam straight from
      // 100 to 170 on one long press instead of stepping once per tap.
      if (e.repeat) return;
      const action = fontSizeShortcutAction(e, isMac);
      if (!action) return;
      // Non-Mac only: a focused terminal pane owns Ctrl+-/Ctrl+_ (readline
      // undo) — let it through instead of swallowing it here. On Mac the
      // shortcut stays global including terminals, per the plan (there's no
      // Cmd+-bound readline binding to protect).
      if (!isMac && (e.target as Element | null)?.closest?.(".xterm")) return;
      e.preventDefault();
      applyStep(action);
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [applyStep]);

  const value = React.useMemo<FontSizeContextValue>(
    () => ({ percent, setPercent, increase, decrease, reset, percentRef, hasUserAdjustedRef }),
    [percent, setPercent, increase, decrease, reset],
  );

  return <FontSizeContext.Provider value={value}>{children}</FontSizeContext.Provider>;
}

export function useFontSize(): FontSizeContextValue {
  const ctx = React.useContext(FontSizeContext);
  if (!ctx) throw new Error("useFontSize must be used inside <FontSizeProvider>");
  return ctx;
}
