import { describe, expect, test } from "bun:test";
import { duplicateAgentName } from "./duplicate-name.ts";

describe("duplicateAgentName", () => {
  test("no collision gives (copy)", () => {
    expect(duplicateAgentName("Bug fixer", [])).toBe("Bug fixer (copy)");
  });

  test("taken (copy) gives (copy 2)", () => {
    expect(duplicateAgentName("Bug fixer", ["Bug fixer (copy)"])).toBe("Bug fixer (copy 2)");
  });

  test("case and whitespace count as taken", () => {
    expect(duplicateAgentName("Bug fixer", ["  BUG FIXER (COPY) "])).toBe("Bug fixer (copy 2)");
  });

  test("long base is shortened, suffix survives", () => {
    const r = duplicateAgentName("A".repeat(80), []);
    expect(r.length).toBeLessThanOrEqual(80);
    expect(r.endsWith(" (copy)")).toBe(true);
  });

  test("explicit maxLen 80 keeps suffix", () => {
    const r = duplicateAgentName("A".repeat(80), [], 80);
    expect(r.length).toBeLessThanOrEqual(80);
    expect(r.endsWith(" (copy)")).toBe(true);
  });

  test("emoji cut never leaves a lone high surrogate", () => {
    const r = duplicateAgentName("😀".repeat(10), [], 10);
    const last = r.charCodeAt(r.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(r.length).toBeLessThanOrEqual(10);
    expect(r.includes("copy")).toBe(true);
  });

  test("1000 colliding names does not throw", () => {
    const names = ["X (copy)"];
    for (let n = 2; n <= 1000; n++) names.push(`X (copy ${n})`);
    expect(() => duplicateAgentName("X", names)).not.toThrow();
  });
});
