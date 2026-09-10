import { expect, test } from "bun:test";
import { FX_AUTO_RESUME_MAX, type TaskFxRecovery } from "../../shared/types.ts";
import { fxPausedBadgeText, fxPausedBadgeTitle } from "./fx-auto-resume.ts";

// Pure text helpers only — no jsdom/testing-library in this repo (see
// CLAUDE.md), so `useCountdown` (a React hook) is exercised only via
// Playwright. `fxPausedBadgeText`/`fxPausedBadgeTitle` take a plain
// `TaskFxRecovery` and return a string, so they're testable directly here.

function baseRec(overrides: Partial<TaskFxRecovery> = {}): TaskFxRecovery {
  return {
    state: "paused",
    runId: "run-1",
    pausedAt: 1_700_000_000_000,
    autoResume: null,
    autoResumeCount: 0,
    ...overrides,
  };
}

// --- fxPausedBadgeText ----------------------------------------------------

test("fxPausedBadgeText: a pending timer with a countdown string reads 'auto-resume m:ss'", () => {
  const rec = baseRec({ autoResume: { at: 1_700_000_120_000, attempt: 1, max: 3, delaySec: 120 } });
  expect(fxPausedBadgeText(rec, "1:58")).toBe("auto-resume 1:58");
});

test("fxPausedBadgeText: no pending timer reads the terse 'paused'", () => {
  expect(fxPausedBadgeText(baseRec(), "1:58")).toBe("paused");
});

test("fxPausedBadgeText: a pending timer with no countdown yet still falls back to 'paused'", () => {
  const rec = baseRec({ autoResume: { at: 1_700_000_120_000, attempt: 1, max: 3, delaySec: 120 } });
  expect(fxPausedBadgeText(rec, null)).toBe("paused");
});

// --- fxPausedBadgeTitle ----------------------------------------------------

test("fxPausedBadgeTitle: a pending timer reports the attempt fraction", () => {
  const rec = baseRec({ autoResume: { at: 1_700_000_120_000, attempt: 2, max: 3, delaySec: 120 } });
  expect(fxPausedBadgeTitle(rec)).toBe("auto-resume 2/3 pending");
});

test("fxPausedBadgeTitle: \"exhausted\" reports the cap via FX_AUTO_RESUME_MAX, not the row's own autoResume.max", () => {
  const rec = baseRec({ autoResumeStopped: "exhausted" });
  expect(fxPausedBadgeTitle(rec)).toBe(`auto-resume gave up (${FX_AUTO_RESUME_MAX} attempts)`);
});

test("fxPausedBadgeTitle: \"cancelled\" reports a plain cancellation", () => {
  const rec = baseRec({ autoResumeStopped: "cancelled" });
  expect(fxPausedBadgeTitle(rec)).toBe("auto-resume cancelled");
});

test("fxPausedBadgeTitle: \"disabled\" points at Settings", () => {
  const rec = baseRec({ autoResumeStopped: "disabled" });
  expect(fxPausedBadgeTitle(rec)).toBe("auto-resume disabled in Settings");
});

test("fxPausedBadgeTitle: \"failed\" — a fired auto-resume that could not start — is reported distinctly from a user cancel", () => {
  const rec = baseRec({ autoResumeStopped: "failed" });
  expect(fxPausedBadgeTitle(rec)).toBe("auto-resume could not start");
  expect(fxPausedBadgeTitle(rec)).not.toContain("cancelled");
});

test("fxPausedBadgeTitle: no pending timer and no stopped reason falls back to a generic pointer", () => {
  expect(fxPausedBadgeTitle(baseRec())).toBe("resume from the task panel");
});

test("fxPausedBadgeTitle: fx's own message, when present, prefixes the suffix with an em dash", () => {
  const rec = baseRec({ autoResumeStopped: "failed", message: "⚠ Rate limited · HTTP 429" });
  expect(fxPausedBadgeTitle(rec)).toBe("⚠ Rate limited · HTTP 429 — auto-resume could not start");
});

test("fxPausedBadgeTitle: every autoResumeStopped reason renders a distinct suffix", () => {
  const suffixes = new Set(
    (["exhausted", "cancelled", "disabled", "failed"] as const).map(
      (reason) => fxPausedBadgeTitle(baseRec({ autoResumeStopped: reason })),
    ),
  );
  expect(suffixes.size).toBe(4);
});
