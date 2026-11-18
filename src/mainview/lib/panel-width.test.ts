import { expect, test } from "bun:test";
import type { PanelStorage } from "./panel-collapse.ts";
import {
  RUN_PANEL_DEFAULT_WIDTH,
  RUN_PANEL_MAX_VIEWPORT_FRACTION,
  RUN_PANEL_MIN_WIDTH,
  RUN_PANEL_WIDTH_KEY,
  clampPanelWidth,
  readPanelWidth,
  writePanelWidth,
  NEW_TASK_PANEL_DEFAULT_WIDTH,
  NEW_TASK_PANEL_MAX_WIDTH,
  NEW_TASK_PANEL_MIN_WIDTH,
  NEW_TASK_PANEL_WIDTH_KEY,
  clampNewTaskPanelWidth,
  clampWidth,
  readNewTaskPanelWidth,
  writeNewTaskPanelWidth,
} from "./panel-width.ts";

/** In-memory stand-in for `window.localStorage`. */
function fakeStorage(seed: Record<string, string> = {}): PanelStorage & {
  map: Map<string, string>;
} {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
  };
}

/** Storage that throws on every access — privacy mode / quota exceeded. */
const throwingStorage: PanelStorage = {
  getItem() { throw new Error("SecurityError"); },
  setItem() { throw new Error("QuotaExceededError"); },
};

const KEY = RUN_PANEL_WIDTH_KEY;
const VIEWPORT = 1440;

// --- clampPanelWidth ------------------------------------------------------

test("clampPanelWidth passes through an in-range width", () => {
  expect(clampPanelWidth(700, VIEWPORT)).toBe(700);
});

test("clampPanelWidth enforces the minimum", () => {
  expect(clampPanelWidth(100, VIEWPORT)).toBe(RUN_PANEL_MIN_WIDTH);
  expect(clampPanelWidth(RUN_PANEL_MIN_WIDTH - 1, VIEWPORT)).toBe(RUN_PANEL_MIN_WIDTH);
});

test("clampPanelWidth caps at 90% of the viewport", () => {
  const cap = Math.floor(VIEWPORT * RUN_PANEL_MAX_VIEWPORT_FRACTION);
  expect(clampPanelWidth(5000, VIEWPORT)).toBe(cap);
});

test("clampPanelWidth lets the minimum win over the viewport cap when the window is tiny", () => {
  // 90% of 300px is below the minimum — state stays at the minimum (the CSS
  // max-w-[90vw] backstop caps the rendered width in that degenerate case).
  expect(clampPanelWidth(700, 300)).toBe(RUN_PANEL_MIN_WIDTH);
});

test("clampPanelWidth rounds fractional widths and rejects non-finite input", () => {
  expect(clampPanelWidth(700.6, VIEWPORT)).toBe(701);
  expect(clampPanelWidth(NaN, VIEWPORT)).toBe(RUN_PANEL_DEFAULT_WIDTH);
  expect(clampPanelWidth(Infinity, VIEWPORT)).toBe(RUN_PANEL_DEFAULT_WIDTH);
});

// --- readPanelWidth -------------------------------------------------------

test("readPanelWidth defaults when the key was never written", () => {
  expect(readPanelWidth(VIEWPORT, fakeStorage())).toBe(RUN_PANEL_DEFAULT_WIDTH);
});

test("readPanelWidth reads back a persisted width", () => {
  expect(readPanelWidth(VIEWPORT, fakeStorage({ [KEY]: "800" }))).toBe(800);
});

test("readPanelWidth clamps a persisted width for the current viewport", () => {
  const cap = Math.floor(VIEWPORT * RUN_PANEL_MAX_VIEWPORT_FRACTION);
  expect(readPanelWidth(VIEWPORT, fakeStorage({ [KEY]: "5000" }))).toBe(cap);
  expect(readPanelWidth(VIEWPORT, fakeStorage({ [KEY]: "50" }))).toBe(RUN_PANEL_MIN_WIDTH);
});

test("readPanelWidth treats junk values as the default rather than throwing", () => {
  for (const junk of ["", "wide", "{}", "true"]) {
    expect(readPanelWidth(VIEWPORT, fakeStorage({ [KEY]: junk }))).toBe(RUN_PANEL_DEFAULT_WIDTH);
  }
});

test("readPanelWidth falls back to the default when storage is unavailable or throws", () => {
  expect(readPanelWidth(VIEWPORT, null)).toBe(RUN_PANEL_DEFAULT_WIDTH);
  expect(readPanelWidth(VIEWPORT, throwingStorage)).toBe(RUN_PANEL_DEFAULT_WIDTH);
});

// --- writePanelWidth ------------------------------------------------------

test("writePanelWidth persists the rounded width under its key", () => {
  const s = fakeStorage();
  writePanelWidth(812.4, s);
  expect(s.map.get(KEY)).toBe("812");
});

test("writePanelWidth is a no-op when storage is unavailable and swallows a throwing storage", () => {
  expect(() => writePanelWidth(700, null)).not.toThrow();
  expect(() => writePanelWidth(700, throwingStorage)).not.toThrow();
});

// --- round trip -----------------------------------------------------------

test("a resized panel round-trips through storage (restart survival)", () => {
  const s = fakeStorage();
  writePanelWidth(860, s);
  expect(readPanelWidth(VIEWPORT, s)).toBe(860);
});

test("the storage key is namespaced so it can't collide with other apps", () => {
  expect(KEY).toBe("agetor:runPanelWidth");
});

// --- New Task panel width -------------------------------------------------

test("clampWidth bounds by min/max and viewport, and the lower bound wins", () => {
  const o = { min: 100, max: 300, fallback: 200 };
  expect(clampWidth(50, o)).toBe(100);
  expect(clampWidth(999, o)).toBe(300);
  expect(clampWidth(Number.NaN, o)).toBe(200);
  expect(clampWidth(280, { ...o, viewportWidth: 500, minRemaining: 300 })).toBe(200);
  expect(clampWidth(280, { ...o, viewportWidth: 200, minRemaining: 300 })).toBe(100);
});

test("the New Task panel width defaults to 384 and clamps to 320..560", () => {
  expect(NEW_TASK_PANEL_DEFAULT_WIDTH).toBe(384);
  expect(readNewTaskPanelWidth(1600, fakeStorage())).toBe(384);
  expect(clampNewTaskPanelWidth(10, 1600)).toBe(NEW_TASK_PANEL_MIN_WIDTH);
  expect(clampNewTaskPanelWidth(9999, 1600)).toBe(NEW_TASK_PANEL_MAX_WIDTH);
});

test("the New Task panel leaves the board at least 480px, never going under 320", () => {
  expect(clampNewTaskPanelWidth(560, 900)).toBe(420);
  expect(clampNewTaskPanelWidth(560, 600)).toBe(NEW_TASK_PANEL_MIN_WIDTH);
});

test("the New Task panel width round-trips and survives bad storage", () => {
  const s = fakeStorage();
  writeNewTaskPanelWidth(500.4, s);
  expect(s.map.get(NEW_TASK_PANEL_WIDTH_KEY)).toBe("500");
  expect(readNewTaskPanelWidth(1600, s)).toBe(500);
  expect(readNewTaskPanelWidth(1600, fakeStorage({ [NEW_TASK_PANEL_WIDTH_KEY]: "junk" }))).toBe(384);
  expect(readNewTaskPanelWidth(1600, throwingStorage)).toBe(384);
  expect(readNewTaskPanelWidth(1600, null)).toBe(384);
  expect(() => writeNewTaskPanelWidth(500, throwingStorage)).not.toThrow();
  expect(NEW_TASK_PANEL_WIDTH_KEY).toBe("agetor:newTaskPanelWidth");
});
