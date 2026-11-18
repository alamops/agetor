import { expect, test } from "bun:test";
import {
  NEW_TASK_PANEL_COLLAPSED_KEY,
  launchMoreKey,
  launchSectionKey,
  readCollapsed,
  writeCollapsed,
  type PanelStorage,
} from "./panel-collapse.ts";

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

const KEY = NEW_TASK_PANEL_COLLAPSED_KEY;

// --- readCollapsed -------------------------------------------------------

test("readCollapsed defaults to expanded when the key was never written", () => {
  expect(readCollapsed(KEY, fakeStorage())).toBe(false);
});

test("readCollapsed returns true only for the '1' sentinel", () => {
  expect(readCollapsed(KEY, fakeStorage({ [KEY]: "1" }))).toBe(true);
});

test("readCollapsed treats the '0' sentinel as expanded", () => {
  expect(readCollapsed(KEY, fakeStorage({ [KEY]: "0" }))).toBe(false);
});

test("readCollapsed treats junk values as expanded rather than throwing", () => {
  for (const junk of ["true", "false", "", "{}", "yes"]) {
    expect(readCollapsed(KEY, fakeStorage({ [KEY]: junk }))).toBe(false);
  }
});

test("readCollapsed falls back to expanded when storage is unavailable", () => {
  expect(readCollapsed(KEY, null)).toBe(false);
});

test("readCollapsed falls back to expanded when storage throws", () => {
  expect(readCollapsed(KEY, throwingStorage)).toBe(false);
});

test("readCollapsed only looks at its own key", () => {
  const s = fakeStorage({ "agetor:somethingElse": "1" });
  expect(readCollapsed(KEY, s)).toBe(false);
});

// --- writeCollapsed ------------------------------------------------------

test("writeCollapsed persists both states under the given key", () => {
  const s = fakeStorage();
  writeCollapsed(KEY, true, s);
  expect(s.map.get(KEY)).toBe("1");
  writeCollapsed(KEY, false, s);
  expect(s.map.get(KEY)).toBe("0");
});

test("writeCollapsed is a no-op when storage is unavailable", () => {
  expect(() => writeCollapsed(KEY, true, null)).not.toThrow();
});

test("writeCollapsed swallows a throwing storage", () => {
  expect(() => writeCollapsed(KEY, true, throwingStorage)).not.toThrow();
});

// --- round trip ----------------------------------------------------------

test("a collapsed panel round-trips through storage (restart survival)", () => {
  const s = fakeStorage();
  writeCollapsed(KEY, true, s);
  expect(readCollapsed(KEY, s)).toBe(true);
  writeCollapsed(KEY, false, s);
  expect(readCollapsed(KEY, s)).toBe(false);
});

test("the storage key is namespaced so it can't collide with other apps", () => {
  expect(KEY).toBe("agetor:newTaskPanelCollapsed");
});

test("launch section keys are namespaced per surface and section", () => {
  expect(launchSectionKey("panel", "workspace")).toBe("agetor:launch:panel:workspace:collapsed");
  expect(launchSectionKey("dialog", "agent")).toBe("agetor:launch:dialog:agent:collapsed");
  expect(launchMoreKey("panel", "agent")).toBe("agetor:launch:panel:agent:more");
  const keys = new Set([
    launchSectionKey("panel", "workspace"), launchSectionKey("panel", "agent"),
    launchSectionKey("dialog", "workspace"), launchSectionKey("dialog", "agent"),
    launchMoreKey("panel", "workspace"), launchMoreKey("panel", "agent"),
    launchMoreKey("dialog", "workspace"), launchMoreKey("dialog", "agent"),
  ]);
  expect(keys.size).toBe(8);
});

test("a launch section's flag round-trips and defaults when storage throws", () => {
  const s = fakeStorage();
  const key = launchSectionKey("panel", "agent");
  expect(readCollapsed(key, s)).toBe(false);
  writeCollapsed(key, true, s);
  expect(readCollapsed(key, s)).toBe(true);
  expect(readCollapsed(key, throwingStorage)).toBe(false);
});
