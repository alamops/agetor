import { describe, expect, test } from "bun:test";
import { REMOTE_LEVELS, isRemoteLevel, levelAtLeast } from "./levels.ts";

describe("levels", () => {
  test("the order is pinned", () => {
    expect([...REMOTE_LEVELS]).toEqual(["observe", "respond", "operate", "configure"]);
  });
  test("levelAtLeast compares by rank", () => {
    expect(levelAtLeast("respond", "observe")).toBe(true);
    expect(levelAtLeast("observe", "respond")).toBe(false);
    expect(levelAtLeast("configure", "configure")).toBe(true);
    expect(levelAtLeast("operate", "configure")).toBe(false);
  });
  test("isRemoteLevel refuses anything else", () => {
    expect(isRemoteLevel("operate")).toBe(true);
    expect(isRemoteLevel("full")).toBe(false);
    expect(isRemoteLevel(3)).toBe(false);
  });
});
