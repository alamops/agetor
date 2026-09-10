import {
  FX_AUTO_RESUME_DEFAULT_DELAY_SEC,
  FX_AUTO_RESUME_DELAY_PREF,
  FX_AUTO_RESUME_MAX,
  FX_AUTO_RESUME_MAX_DELAY_SEC,
  FX_AUTO_RESUME_MIN_DELAY_SEC,
  FX_AUTO_RESUME_PREF,
} from "../../shared/types.ts";

/**
 * Webview-facing re-exports of the fx auto-resume preference keys + cap —
 * see `docs/plans/fx-recovery-follow-ups.md` §3 and the doc comments on the
 * originals in `src/shared/types.ts` for the full contract. Kept as a
 * dedicated lib file (rather than importing the shared module everywhere)
 * to match the `STICKY_USER_MESSAGES_PREF` precedent in
 * `user-message-display.ts` — one small, documented home per preference
 * pair that both `App.tsx` and `SettingsDialog.tsx` import from.
 */
export { FX_AUTO_RESUME_DELAY_PREF, FX_AUTO_RESUME_MAX, FX_AUTO_RESUME_PREF };

/** Shared clamp: bounds an already-finite candidate value into
 *  `[FX_AUTO_RESUME_MIN_DELAY_SEC, FX_AUTO_RESUME_MAX_DELAY_SEC]`. Both
 *  {@link clampFxAutoResumeDelay} and {@link parseFxAutoResumeDelayInput}
 *  funnel through this one function so the two entry points (a numeric
 *  value vs. raw input text) can never independently drift on the clamp
 *  bounds or the truncation rule. */
function clampDelaySeconds(n: number): number {
  return Math.min(FX_AUTO_RESUME_MAX_DELAY_SEC, Math.max(FX_AUTO_RESUME_MIN_DELAY_SEC, Math.trunc(n)));
}

/**
 * Clamp a candidate `fxAutoResumeDelaySec` value (typically parsed from a
 * number `<input>`) into `[FX_AUTO_RESUME_MIN_DELAY_SEC,
 * FX_AUTO_RESUME_MAX_DELAY_SEC]`. A non-finite input (`NaN` from an empty or
 * malformed field) falls back to `FX_AUTO_RESUME_DEFAULT_DELAY_SEC` instead
 * of clamping garbage — mirrors `parseFxAutoResumePrefs`'s server-side
 * parsing in `src/shared/fx-recovery.ts`, so a value the Settings input
 * commits always round-trips identically through the preferences store.
 * Kept for numeric callers (e.g. a value already parsed elsewhere); a raw
 * text field should go through {@link parseFxAutoResumeDelayInput} instead,
 * which applies the identical fallback/clamp rule to a string.
 */
export function clampFxAutoResumeDelay(n: number): number {
  if (!Number.isFinite(n)) return FX_AUTO_RESUME_DEFAULT_DELAY_SEC;
  return clampDelaySeconds(n);
}

/**
 * Parse a raw `fxAutoResumeDelaySec` input string (e.g. the Settings number
 * field's live text, which may be empty, partially typed, or garbage mid-
 * keystroke) the same way the server parses the persisted preference value
 * in `parseFxAutoResumePrefs` (`src/shared/fx-recovery.ts`): `text.trim()`
 * through `Number.parseInt(…, 10)`, falling back to
 * `FX_AUTO_RESUME_DEFAULT_DELAY_SEC` when that's not finite (empty string,
 * no leading digits), else clamped via the same {@link clampDelaySeconds}
 * helper `clampFxAutoResumeDelay` uses. Keeping both entry points on one
 * shared parse is what guarantees a value committed through the Settings
 * input always round-trips identically to what the server would have
 * stored for the same typed text.
 */
export function parseFxAutoResumeDelayInput(text: string): number {
  const parsed = Number.parseInt(text.trim(), 10);
  if (!Number.isFinite(parsed)) return FX_AUTO_RESUME_DEFAULT_DELAY_SEC;
  return clampDelaySeconds(parsed);
}
