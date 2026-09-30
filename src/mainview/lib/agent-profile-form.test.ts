import { describe, expect, test } from "bun:test";
import { agentProfileTextDirty, type AgentProfileTextDraft } from "./agent-profile-form.ts";

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
