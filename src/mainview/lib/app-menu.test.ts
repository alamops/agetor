import { describe, expect, test } from "bun:test";
import { APP_MENU_ACTIONS } from "../../shared/types.ts";
import { isAppMenuAction, isSettingsShortcut, MENU_ACTION_BLOCKING_LAYERS } from "./app-menu.ts";

const key = (o: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key: ",",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...o,
});

describe("isAppMenuAction", () => {
  test("accepts every member and nothing else", () => {
    for (const a of APP_MENU_ACTIONS) expect(isAppMenuAction(a)).toBe(true);
    for (const v of ["nope", "", "Settings", null, undefined, 1, {}, ["settings"]]) expect(isAppMenuAction(v)).toBe(false);
  });
});

describe("isSettingsShortcut", () => {
  test("macOS needs ⌘ and no Ctrl", () => {
    expect(isSettingsShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isSettingsShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isSettingsShortcut(key({ metaKey: true, ctrlKey: true }), true)).toBe(false);
    expect(isSettingsShortcut(key(), true)).toBe(false);
  });

  test("other platforms need Ctrl and no ⌘", () => {
    expect(isSettingsShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isSettingsShortcut(key({ metaKey: true }), false)).toBe(false);
    expect(isSettingsShortcut(key({ metaKey: true, ctrlKey: true }), false)).toBe(false);
  });

  test("Alt or Shift disqualifies, and so does any other key", () => {
    expect(isSettingsShortcut(key({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(isSettingsShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isSettingsShortcut(key({ metaKey: true, key: "." }), true)).toBe(false);
    expect(isSettingsShortcut(key({ metaKey: true, key: "s" }), true)).toBe(false);
  });
});

test("only a modal dialog blocks a menu action", () => {
  expect(MENU_ACTION_BLOCKING_LAYERS).toBe('[role="dialog"][aria-modal="true"]');
});
