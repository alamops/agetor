import { describe, expect, test } from "bun:test";
import { isSubmitShortcut, shouldFireSubmit } from "./submit-shortcut.ts";

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
  test("inert when consumed, while a popover is open, or when Run is off", () => {
    expect(shouldFireSubmit({ defaultPrevented: false, scopeHasOpenPopover: false, canRun: true })).toBe(true);
    expect(shouldFireSubmit({ defaultPrevented: true, scopeHasOpenPopover: false, canRun: true })).toBe(false);
    expect(shouldFireSubmit({ defaultPrevented: false, scopeHasOpenPopover: true, canRun: true })).toBe(false);
    expect(shouldFireSubmit({ defaultPrevented: false, scopeHasOpenPopover: false, canRun: false })).toBe(false);
  });
});
