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
 * The one ticking clock behind every countdown in the webview: returns the
 * current epoch-ms, re-rendering once a second while `active`, and resets to
 * "now" whenever `resetKey` changes (a new task or a new target). The interval
 * is armed only while active and is cleared on unmount, so a panel with no
 * pending timer never runs one. Shared by `useCountdown` and the harness-stack
 * banner so the two cannot drift into duplicate interval implementations.
 */
export function useNowTicker(active: boolean, resetKey?: unknown): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, resetKey]);
  return now;
}

/**
 * Live `m:ss` (or `"now"`) countdown to an auto-resume firing at `at` (ms
 * epoch), ticking once a second — or `null` when there's nothing pending
 * (`at` is `null`/`undefined`). The interval is armed only while `at` is
 * set and is cleared on unmount and on every change to `at` (a new
 * schedule, a cleared one, or a fired-and-rescheduled one), so a card or
 * notice with no pending auto-resume never runs a timer.
 */
export function useCountdown(at: number | null | undefined): string | null {
  const now = useNowTicker(at != null, at);
  if (at == null) return null;
  return fxAutoResumeCountdownText(at, now);
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
 * cap that was hit is a constant, not per-row state. `"failed"` — a timer
 * fired but the resume it tried to start couldn't (see
 * `TaskFxRecovery.autoResumeStopped`'s doc) — is reported distinctly from
 * `"cancelled"` so the tooltip never claims the user cancelled something
 * that actually tried and failed to start. When neither a pending timer
 * nor a stopped reason is recorded (e.g. the row was just written and the
 * orchestrator's scheduling decision hasn't landed yet), the suffix falls
 * back to a generic pointer at the task panel.
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
          : rec.autoResumeStopped === "failed"
            ? "auto-resume could not start"
            : "resume from the task panel";
  return rec.message ? `${rec.message} — ${suffix}` : suffix;
}
