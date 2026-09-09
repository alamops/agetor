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

/**
 * Clamp a candidate `fxAutoResumeDelaySec` value (typically parsed from a
 * number `<input>`) into `[FX_AUTO_RESUME_MIN_DELAY_SEC,
 * FX_AUTO_RESUME_MAX_DELAY_SEC]`. A non-finite input (`NaN` from an empty or
 * malformed field) falls back to `FX_AUTO_RESUME_DEFAULT_DELAY_SEC` instead
 * of clamping garbage — mirrors `parseFxAutoResumePrefs`'s server-side
 * parsing in `src/shared/fx-recovery.ts`, so a value the Settings input
 * commits always round-trips identically through the preferences store.
 */
export function clampFxAutoResumeDelay(n: number): number {
  if (!Number.isFinite(n)) return FX_AUTO_RESUME_DEFAULT_DELAY_SEC;
  return Math.min(FX_AUTO_RESUME_MAX_DELAY_SEC, Math.max(FX_AUTO_RESUME_MIN_DELAY_SEC, Math.trunc(n)));
}
