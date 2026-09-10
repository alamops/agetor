import { expect, test } from "bun:test";
import { clampFxAutoResumeDelay, parseFxAutoResumeDelayInput } from "./fx-auto-resume-prefs.ts";

// --- parseFxAutoResumeDelayInput -----------------------------------------
//
// Mirrors the server's `parseFxAutoResumePrefs` delay parsing in
// `src/shared/fx-recovery.ts` (`Number.parseInt(text.trim(), 10)`, fall back
// to the 120 s default on a non-finite result, else clamp to [10, 3600]) so
// a value committed through the Settings number field always round-trips
// identically to what the server would have stored for the same typed text.

test("empty string falls back to the 120 s default", () => {
  expect(parseFxAutoResumeDelayInput("")).toBe(120);
});

test("non-numeric garbage falls back to the 120 s default", () => {
  expect(parseFxAutoResumeDelayInput("abc")).toBe(120);
});

test('"1e3" parses only the leading digit run (1), then clamps up to the 10 s floor', () => {
  // Number.parseInt("1e3", 10) === 1 — it stops at the "e", it does not
  // interpret exponential notation. 1 is a finite result, so it's clamped
  // like any other parsed value rather than falling back to the default.
  expect(parseFxAutoResumeDelayInput("1e3")).toBe(10);
});

test('"12abc" parses the leading digit run (12) and ignores the trailing letters', () => {
  expect(parseFxAutoResumeDelayInput("12abc")).toBe(12);
});

test("surrounding whitespace is trimmed before parsing", () => {
  expect(parseFxAutoResumeDelayInput(" 45 ")).toBe(45);
});

test("a value below the floor clamps up to 10", () => {
  expect(parseFxAutoResumeDelayInput("5")).toBe(10);
});

test("a value above the ceiling clamps down to 3600", () => {
  expect(parseFxAutoResumeDelayInput("99999")).toBe(3600);
});

test("a value already inside the clamp range round-trips unchanged", () => {
  expect(parseFxAutoResumeDelayInput("120")).toBe(120);
});

test("negative and zero inputs clamp up to the 10 s floor", () => {
  expect(parseFxAutoResumeDelayInput("0")).toBe(10);
  expect(parseFxAutoResumeDelayInput("-5")).toBe(10);
});

// --- clampFxAutoResumeDelay -----------------------------------------------
//
// The numeric-input sibling of parseFxAutoResumeDelayInput — same fallback
// and clamp rule, applied to an already-parsed number instead of raw text.

test("clampFxAutoResumeDelay: NaN falls back to the 120 s default", () => {
  expect(clampFxAutoResumeDelay(Number.NaN)).toBe(120);
});

test("clampFxAutoResumeDelay: +/-Infinity falls back to the 120 s default", () => {
  expect(clampFxAutoResumeDelay(Number.POSITIVE_INFINITY)).toBe(120);
  expect(clampFxAutoResumeDelay(Number.NEGATIVE_INFINITY)).toBe(120);
});

test("clampFxAutoResumeDelay: clamps below the floor and above the ceiling", () => {
  expect(clampFxAutoResumeDelay(5)).toBe(10);
  expect(clampFxAutoResumeDelay(99999)).toBe(3600);
});

test("clampFxAutoResumeDelay: a value already inside the range round-trips unchanged", () => {
  expect(clampFxAutoResumeDelay(500)).toBe(500);
});

test("clampFxAutoResumeDelay: truncates a fractional value rather than rounding", () => {
  expect(clampFxAutoResumeDelay(45.9)).toBe(45);
});

// --- Parity between the two entry points ----------------------------------

test("parseFxAutoResumeDelayInput(String(n)) agrees with clampFxAutoResumeDelay(n) for a representative sample", () => {
  for (const n of [0, 5, 10, 45, 120, 500, 3600, 99999]) {
    expect(parseFxAutoResumeDelayInput(String(n))).toBe(clampFxAutoResumeDelay(n));
  }
});
