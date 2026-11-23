import { describe, expect, test } from "bun:test";
import { agentProfileMatches } from "./AgentProfilesSection.tsx";
import type { AgentProfile } from "../../../shared/types.ts";

const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  id: "p1", name: "Reviewer", harness: "codex", model: "gpt-x", effort: "high", mode: null, speed: "off",
  maxMode: false, opencodeServer: "shared", instructions: "Review the diff for bugs", skills: [], createdAt: 0, updatedAt: 0,
  ...over,
} as AgentProfile);

describe("agentProfileMatches (Settings → Agents search)", () => {
  test("an empty or blank query matches everything", () => {
    expect(agentProfileMatches(profile(), "")).toBe(true);
    expect(agentProfileMatches(profile(), "   ")).toBe(true);
  });
  test("matches the name, harness id or label, model and instructions, case-insensitively", () => {
    expect(agentProfileMatches(profile(), "review")).toBe(true);
    expect(agentProfileMatches(profile(), "CODEX")).toBe(true);
    expect(agentProfileMatches(profile(), "work account", "Codex work account")).toBe(true);
    expect(agentProfileMatches(profile(), "gpt-x")).toBe(true);
    expect(agentProfileMatches(profile(), "bugs")).toBe(true);
  });
  test("every term must match", () => {
    expect(agentProfileMatches(profile(), "reviewer codex")).toBe(true);
    expect(agentProfileMatches(profile(), "reviewer claude")).toBe(false);
  });
});
