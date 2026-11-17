import { describe, expect, test } from "bun:test";
import { effortPassesSpawnCheck } from "./effort-check.ts";

describe("effortPassesSpawnCheck", () => {
  test("claude accepts low..max always; none and ultra only when discovered", () => {
    for (const e of ["low", "medium", "high", "xhigh", "max"]) expect(effortPassesSpawnCheck("claude-code", e, null)).toBe(true);
    expect(effortPassesSpawnCheck("claude-code", "none", null)).toBe(false);
    expect(effortPassesSpawnCheck("claude-code", "turbo", null)).toBe(false);
    expect(effortPassesSpawnCheck("claude-code", "turbo", ["turbo"])).toBe(true);
  });

  test("codex and copilot accept the known ids except auto", () => {
    for (const k of ["codex", "copilot"] as const) {
      expect(effortPassesSpawnCheck(k, "ultra", null)).toBe(true);
      expect(effortPassesSpawnCheck(k, "none", null)).toBe(true);
    }
    expect(effortPassesSpawnCheck("codex", "auto", ["auto"])).toBe(false);
    expect(effortPassesSpawnCheck("fx", "auto", null)).toBe(true);
  });

  test("an unknown id passes only via discovery and the charset", () => {
    expect(effortPassesSpawnCheck("codex", "turbo", null)).toBe(false);
    expect(effortPassesSpawnCheck("codex", "turbo", ["low"])).toBe(false);
    expect(effortPassesSpawnCheck("codex", "turbo", ["turbo"])).toBe(true);
  });

  test("injection-shaped and oversized ids never pass, even when discovered", () => {
    for (const bad of ["x y", "a;b", "$(id)", "a\nb", "", "z".repeat(33), "Turbo", "a=b"]) {
      expect(effortPassesSpawnCheck("codex", bad, [bad]), JSON.stringify(bad)).toBe(false);
      expect(effortPassesSpawnCheck("claude-code", bad, [bad]), JSON.stringify(bad)).toBe(false);
    }
  });
});
