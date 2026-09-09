// React hook + pure text helpers for the fx "paused, resumable" badge and
// notice countdown (`docs/plans/fx-recovery-follow-ups.md` §3.5/3.6) — the
// bridge between `TaskFxRecovery`'s raw `autoResume.at` timestamp and the
// live `m:ss` text both `TaskCard`'s `fx-paused-badge` and `RunPanel`'s
// `PausedRecoveryNotice` render. The formatting itself
// (`fxAutoResumeCountdownText`) stays in `src/shared/fx-recovery.ts` so
// bun-side code (CLI/TUI) can reuse it with no React dependency; this file
// is the one place the webview turns that pure formatter into a ticking
// value plus the two label strings the card badge needs.
import { useEffect, useState } from "react";
import { fxAutoResumeCountdownText } from "../../shared/fx-recovery.ts";
import { FX_AUTO_RESUME_MAX, type TaskFxRecovery } from "../../shared/types.ts";

/**
 * Live `m:ss` (or `"now"`) countdown to an auto-resume firing at `at` (ms
 * epoch), ticking once a second — or `null` when there's nothing pending
 * (`at` is `null`/`undefined`). The interval is armed only while `at` is
 * set and is cleared on unmount and on every change to `at` (a new
 * schedule, a cleared one, or a fired-and-rescheduled one), so a card or
 * notice with no pending auto-resume never runs a timer.
 */
export function useCountdown(at: number | null | undefined): string | null {
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (at == null) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [at]);
  if (at == null) return null;
  return fxAutoResumeCountdownText(at, Date.now());
}

/**
 * Badge text for `TaskCard`'s `fx-paused-badge`: `"auto-resume m:ss"` while
 * a timer is pending and a countdown string is available, else the terse
 * `"paused"` — covers both "no timer scheduled" (`rec.autoResume` is
 * `null`, e.g. auto-resume is off, exhausted, or cancelled) and the
 * degenerate case where `countdown` hasn't been computed yet.
 */
export function fxPausedBadgeText(rec: TaskFxRecovery, countdown: string | null): string {
  return rec.autoResume && countdown ? `auto-resume ${countdown}` : "paused";
}

/**
 * Badge `title` (hover tooltip) for `fx-paused-badge`: fx's own recovery
 * `message` (when the pause sentinel carried one) followed by a status
 * suffix describing the auto-resume schedule — how many attempts remain
 * pending (`rec.autoResume`), or why none is pending any more
 * (`rec.autoResumeStopped`). `FX_AUTO_RESUME_MAX` (not `rec.autoResume?.max`)
 * backs the "gave up" wording because by the time a chain reads
 * `"exhausted"`, `autoResume` itself has already gone back to `null` — the
 * cap that was hit is a constant, not per-row state. When neither a
 * pending timer nor a stopped reason is recorded (e.g. the row was just
 * written and the orchestrator's scheduling decision hasn't landed yet),
 * the suffix falls back to a generic pointer at the task panel.
 */
export function fxPausedBadgeTitle(rec: TaskFxRecovery): string {
  const suffix = rec.autoResume
    ? `auto-resume ${rec.autoResume.attempt}/${rec.autoResume.max} pending`
    : rec.autoResumeStopped === "exhausted"
      ? `auto-resume gave up (${FX_AUTO_RESUME_MAX} attempts)`
      : rec.autoResumeStopped === "cancelled"
        ? "auto-resume cancelled"
        : rec.autoResumeStopped === "disabled"
          ? "auto-resume disabled in Settings"
          : "resume from the task panel";
  return rec.message ? `${rec.message} — ${suffix}` : suffix;
}
