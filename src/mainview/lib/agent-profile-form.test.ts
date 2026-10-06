import { describe, expect, test } from "bun:test";
import { agentProfileTextDirty, duplicateAgentName, type AgentProfileTextDraft } from "./agent-profile-form.ts";

function draft(overrides: Partial<AgentProfileTextDraft> = {}): AgentProfileTextDraft {
  return { name: "Bug fixer", instructions: "Be terse.", skills: ["review", "test"], ...overrides };
}

describe("agentProfileTextDirty", () => {
  test("identical drafts are clean", () => {
    expect(agentProfileTextDirty(draft(), draft())).toBe(false);
  });

  test("two empty drafts are clean", () => {
    const empty = { name: "", instructions: "", skills: [] };
    expect(agentProfileTextDirty(empty, { ...empty, skills: [] })).toBe(false);
  });

  test("a changed name is dirty", () => {
    expect(agentProfileTextDirty(draft({ name: "Bug fixers" }), draft())).toBe(true);
  });

  test("a trailing space in the name is dirty (exact compare)", () => {
    expect(agentProfileTextDirty(draft({ name: "Bug fixer " }), draft())).toBe(true);
  });

  test("changed instructions are dirty", () => {
    expect(agentProfileTextDirty(draft({ instructions: "Be verbose." }), draft())).toBe(true);
  });

  test("an added skill is dirty", () => {
    expect(agentProfileTextDirty(draft({ skills: ["review", "test", "lint"] }), draft())).toBe(true);
  });

  test("a removed skill is dirty", () => {
    expect(agentProfileTextDirty(draft({ skills: ["review"] }), draft())).toBe(true);
  });

  test("a reordered skill list is dirty (ordered compare)", () => {
    expect(agentProfileTextDirty(draft({ skills: ["test", "review"] }), draft())).toBe(true);
  });

  test("a replaced skill of the same length is dirty", () => {
    expect(agentProfileTextDirty(draft({ skills: ["review", "lint"] }), draft())).toBe(true);
  });

  test("a fresh but equal skills array is clean", () => {
    expect(agentProfileTextDirty(draft({ skills: ["review", "test"] }), draft())).toBe(false);
  });
});

describe("duplicateAgentName", () => {
  test("appends (copy) when nothing collides", () => {
    expect(duplicateAgentName("Bug fixer", [])).toBe("Bug fixer (copy)");
  });

  test("numbers the copy when (copy) is taken", () => {
    expect(duplicateAgentName("Bug fixer", ["Bug fixer (copy)"])).toBe("Bug fixer (copy 2)");
  });

  test("collision check ignores case and surrounding whitespace", () => {
    expect(duplicateAgentName("Bug fixer", ["  bug fixer (copy)  ", "Bug fixer (copy 2)"])).toBe(
      "Bug fixer (copy 3)",
    );
  });

  test("an 80-char base is truncated to fit with the suffix", () => {
    const out = duplicateAgentName("A".repeat(80), []);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith(" (copy)")).toBe(true);
  });

  test("never splits a surrogate pair when truncating", () => {
    const out = duplicateAgentName("😀".repeat(10), [], 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith(" (copy)")).toBe(true);
    const last = out.charCodeAt(out.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  test("does not throw with many collisions", () => {
    const taken = ["Bug fixer (copy)"];
    for (let n = 2; n <= 1000; n++) taken.push(`Bug fixer (copy ${n})`);
    expect(typeof duplicateAgentName("Bug fixer", taken)).toBe("string");
  });
});
