import { describe, expect, test } from "bun:test";
import { FIND_SHORTCUT_BLOCKING_LAYERS, isFindShortcut, type FindShortcutKey } from "./find-shortcut.ts";

function key(overrides: Partial<FindShortcutKey> = {}): FindShortcutKey {
  return { key: "f", metaKey: false, ctrlKey: false, altKey: false, ...overrides };
}

describe("isFindShortcut", () => {
  describe("on Mac (isMac = true)", () => {
    const cases: { name: string; event: FindShortcutKey; expected: boolean }[] = [
      { name: "Meta+f fires", event: key({ metaKey: true }), expected: true },
      // The interface has no shiftKey field; Shift held is represented here as an
      // uppercase key, and isFindShortcut lowercases before comparing — parity with
      // RunPanel's pre-existing Cmd/Ctrl+F behavior, which never checked shiftKey.
      { name: "Meta+F (Shift held, uppercase key) fires", event: key({ key: "F", metaKey: true }), expected: true },
      { name: "Ctrl+f alone does not fire", event: key({ ctrlKey: true }), expected: false },
      {
        name: "Meta+Ctrl+f does not fire — the other modifier disqualifies",
        event: key({ metaKey: true, ctrlKey: true }),
        expected: false,
      },
      { name: "Meta+Alt+f does not fire — altKey disqualifies", event: key({ metaKey: true, altKey: true }), expected: false },
      { name: "bare f (no modifiers) does not fire", event: key(), expected: false },
      { name: "Meta+g does not fire — wrong key", event: key({ key: "g", metaKey: true }), expected: false },
      { name: "Meta+Enter does not fire — wrong key", event: key({ key: "Enter", metaKey: true }), expected: false },
      { name: 'Meta+"" (empty key) does not fire', event: key({ key: "", metaKey: true }), expected: false },
    ];

    for (const { name, event, expected } of cases) {
      test(name, () => {
        expect(isFindShortcut(event, true)).toBe(expected);
      });
    }
  });

  describe("on non-Mac (isMac = false)", () => {
    const cases: { name: string; event: FindShortcutKey; expected: boolean }[] = [
      { name: "Ctrl+f fires", event: key({ ctrlKey: true }), expected: true },
      { name: "Ctrl+F (uppercase key) fires", event: key({ key: "F", ctrlKey: true }), expected: true },
      { name: "Meta+f alone does not fire", event: key({ metaKey: true }), expected: false },
      {
        name: "Ctrl+Meta+f does not fire — the other modifier disqualifies",
        event: key({ ctrlKey: true, metaKey: true }),
        expected: false,
      },
      { name: "Ctrl+Alt+f does not fire — altKey disqualifies", event: key({ ctrlKey: true, altKey: true }), expected: false },
      { name: "bare f (no modifiers) does not fire", event: key(), expected: false },
      { name: "Ctrl+other (wrong key) does not fire", event: key({ key: "g", ctrlKey: true }), expected: false },
    ];

    for (const { name, event, expected } of cases) {
      test(name, () => {
        expect(isFindShortcut(event, false)).toBe(expected);
      });
    }
  });
});

describe("FIND_SHORTCUT_BLOCKING_LAYERS", () => {
  test("pins the exact selector string — shared by App.tsx and RunPanel.tsx, a silent edit must fail this test", () => {
    expect(FIND_SHORTCUT_BLOCKING_LAYERS).toBe(
      '[role="dialog"][aria-modal="true"], [data-popover-open]:not([data-popover-keys="escape-only"])',
    );
  });

  test("structurally excludes escape-only popovers while still matching modal dialogs — no DOM available here, so asserted on the selector string itself", () => {
    expect(FIND_SHORTCUT_BLOCKING_LAYERS).toContain(':not([data-popover-keys="escape-only"])');
    expect(FIND_SHORTCUT_BLOCKING_LAYERS).toContain('[role="dialog"][aria-modal="true"]');
  });
});
