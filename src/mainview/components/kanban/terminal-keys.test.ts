import { describe, expect, test } from "bun:test";
import { macEditSequence } from "./terminal-keys.ts";

/** Build a minimal key-event shape; all modifiers default off. */
const key = (
  k: string,
  mods: Partial<{ metaKey: boolean; altKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {},
) => ({ metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, key: k, ...mods });

describe("macEditSequence", () => {
  test("⌘ line navigation / deletion", () => {
    expect(macEditSequence(key("ArrowLeft", { metaKey: true }))).toBe("\x01"); // Ctrl-A
    expect(macEditSequence(key("ArrowRight", { metaKey: true }))).toBe("\x05"); // Ctrl-E
    expect(macEditSequence(key("Backspace", { metaKey: true }))).toBe("\x15"); // Ctrl-U
    expect(macEditSequence(key("Delete", { metaKey: true }))).toBe("\x0b"); // Ctrl-K
  });

  test("⌥ word navigation / deletion", () => {
    expect(macEditSequence(key("ArrowLeft", { altKey: true }))).toBe("\x1bb");
    expect(macEditSequence(key("ArrowRight", { altKey: true }))).toBe("\x1bf");
    expect(macEditSequence(key("Backspace", { altKey: true }))).toBe("\x1b\x7f");
    expect(macEditSequence(key("Delete", { altKey: true }))).toBe("\x1bd");
  });

  test("Shift-modified combos fall through to xterm (selection gestures)", () => {
    expect(macEditSequence(key("ArrowLeft", { metaKey: true, shiftKey: true }))).toBeNull();
    expect(macEditSequence(key("ArrowRight", { altKey: true, shiftKey: true }))).toBeNull();
  });

  test("extra modifiers disqualify the combo", () => {
    // ⌘+⌥ together → not a recognized combo
    expect(macEditSequence(key("ArrowLeft", { metaKey: true, altKey: true }))).toBeNull();
    // ⌃+⌥ together → not a recognized combo
    expect(macEditSequence(key("ArrowLeft", { altKey: true, ctrlKey: true }))).toBeNull();
  });

  test("unmodified and unhandled keys pass through", () => {
    expect(macEditSequence(key("ArrowLeft"))).toBeNull(); // bare arrow → xterm default
    expect(macEditSequence(key("a", { altKey: true }))).toBeNull(); // Opt+letter → macOptionIsMeta
    expect(macEditSequence(key("Home", { metaKey: true }))).toBeNull(); // unhandled key
  });
});
