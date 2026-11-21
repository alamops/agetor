import { describe, expect, test } from "bun:test";
import { isSubmitShortcut, shouldFireSubmit, SUBMIT_BLOCKING_POPOVERS } from "./submit-shortcut.ts";

const key = (o: Partial<Parameters<typeof isSubmitShortcut>[0]>) => ({
  key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o,
});

describe("isSubmitShortcut", () => {
  test("Cmd+Enter on macOS, Ctrl+Enter elsewhere", () => {
    expect(isSubmitShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isSubmitShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isSubmitShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isSubmitShortcut(key({ metaKey: true }), false)).toBe(false);
  });
  test("both primary modifiers, Alt and Shift disqualify; plain Enter never fires", () => {
    expect(isSubmitShortcut(key({ metaKey: true, ctrlKey: true }), true)).toBe(false);
    expect(isSubmitShortcut(key({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(isSubmitShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isSubmitShortcut(key({}), true)).toBe(false);
    expect(isSubmitShortcut(key({ metaKey: true, key: "a" }), true)).toBe(false);
  });
});

describe("shouldFireSubmit", () => {
  const base = { defaultPrevented: false, scopeHasBlockingPopover: false, keyFromInsidePopover: false, canRun: true };
  test("fires only when nothing consumed or holds the key and Run is on", () => {
    expect(shouldFireSubmit(base)).toBe(true);
    expect(shouldFireSubmit({ ...base, defaultPrevented: true })).toBe(false);
    expect(shouldFireSubmit({ ...base, scopeHasBlockingPopover: true })).toBe(false);
    expect(shouldFireSubmit({ ...base, keyFromInsidePopover: true })).toBe(false);
    expect(shouldFireSubmit({ ...base, canRun: false })).toBe(false);
  });
});

describe("SUBMIT_BLOCKING_POPOVERS", () => {
  test("pins the selector: an open popover blocks the chord unless it is escape-only", () => {
    expect(SUBMIT_BLOCKING_POPOVERS).toBe('[data-popover-open]:not([data-popover-keys="escape-only"])');
  });
});
