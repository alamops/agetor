import {
  clampFontSizePercent,
  FONT_SIZE_BASE_PX,
  FONT_SIZE_DEFAULT,
  FONT_SIZE_STEP,
  TERMINAL_FONT_SIZE_BASE_PX,
} from "../../shared/types.ts";

/**
 * Pure font-size logic — no DOM, no React. Mirrors `theme.ts`'s split:
 * `font-size-provider.tsx` and the boot-time inline script in `index.html`
 * (owned by the boot-channel side of this feature) are thin DOM-touching
 * wrappers around these functions.
 */

export type FontSizeAction = "increase" | "decrease" | "reset";

/** Step `pct` by one `FONT_SIZE_STEP` increment (or jump straight to
 *  `FONT_SIZE_DEFAULT` on "reset"), clamped to [FONT_SIZE_MIN, FONT_SIZE_MAX].
 *  `pct` is assumed already-valid (callers hold clamped state); the result is
 *  re-clamped anyway so a caller passing a stray out-of-range value can't
 *  escape the bounds. */
export function stepFontSize(pct: number, action: FontSizeAction): number {
  if (action === "reset") return FONT_SIZE_DEFAULT;
  const delta = action === "increase" ? FONT_SIZE_STEP : -FONT_SIZE_STEP;
  return clampFontSizePercent(pct + delta);
}

/** The `documentElement.style.fontSize` value for a given percent, or `null`
 *  at exactly `FONT_SIZE_DEFAULT` — callers must *remove* the inline property
 *  in that case (not set it to the computed 16px) so the default state stays
 *  pristine, matching the boot-channel contract in `src/shared/types.ts`. */
export function rootFontSizeStyle(pct: number): string | null {
  if (pct === FONT_SIZE_DEFAULT) return null;
  return `${(FONT_SIZE_BASE_PX * pct) / 100}px`;
}

/** xterm's `fontSize` option scales off its own 12px baseline (unrelated to
 *  the 16px root rem baseline — see `TerminalView.tsx`, which reads CSS
 *  variables for everything else but sets this as an absolute pixel value). */
export function terminalFontSize(pct: number): number {
  return Math.round((TERMINAL_FONT_SIZE_BASE_PX * pct) / 100);
}

/**
 * Read the boot-seeded font size: `window.__AGETOR.fontSize` first (the
 * WKUserScript `preload` payload for the bundled `views://` path), the
 * `fontSize` URL-hash param second (Vite dev path — see `buildWindowHash` in
 * `src/bun/window-url.ts`), `FONT_SIZE_DEFAULT` when neither is present.
 * `agetorGlobal` is passed in (rather than read from `window` directly) so
 * this stays testable without a DOM.
 */
export function readFontSizeFromBoot(agetorGlobal: unknown, hash: string): number {
  const injected = (agetorGlobal as { fontSize?: unknown } | null | undefined)?.fontSize;
  // Only a number or string counts as "present" — matches index.html's inline
  // boot script, which falls through to the hash param unless __AGETOR.fontSize
  // is one of those two types. Without this, an unexpected shape (object,
  // boolean, …) would resolve via clampFontSizePercent's NaN fallback (100)
  // instead of consulting the hash the way the boot script does.
  if (typeof injected === "number" || typeof injected === "string") {
    return clampFontSizePercent(injected);
  }

  const stripped = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!stripped) return FONT_SIZE_DEFAULT;
  try {
    const params = new URLSearchParams(stripped);
    const fromHash = params.get("fontSize");
    return fromHash === null ? FONT_SIZE_DEFAULT : clampFontSizePercent(fromHash);
  } catch {
    return FONT_SIZE_DEFAULT;
  }
}

/**
 * Map a keydown to a font-size action, or `null` if the combo isn't one we
 * handle. The primary modifier is `metaKey` on macOS, `ctrlKey` elsewhere,
 * matching `isFindShortcut`'s (`find-shortcut.ts`) Cmd/Ctrl+F convention
 * exactly — `RunPanel.tsx` merely calls that predicate: the *other*
 * modifier being also held disqualifies (Mac wants meta-without-ctrl, other
 * platforms want ctrl-without-meta) so a combo like Ctrl+Cmd+= — which some
 * window managers or IMEs can report — doesn't ambiguously fire both this
 * and a platform-native binding. `altKey` also disqualifies, since
 * Option/Alt-modified punctuation produces different glyphs on some layouts
 * and isn't part of this shortcut's contract.
 */
export function fontSizeShortcutAction(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean },
  isMac: boolean,
): FontSizeAction | null {
  if (e.altKey) return null;
  const primaryDown = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!primaryDown) return null;
  switch (e.key) {
    case "=":
    case "+":
      return "increase";
    case "-":
    case "_":
      return "decrease";
    case "0":
      return "reset";
    default:
      return null;
  }
}
