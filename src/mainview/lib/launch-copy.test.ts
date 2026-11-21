import { describe, expect, test } from "bun:test";
import { CODE_MODE_TOOLTIP, effortTooltip, harnessTooltip, planModeTooltip, usageNote } from "./launch-copy.ts";
import { agentSummary, moreOptionsNotes, workspaceSummary } from "./launch-summary.ts";
import { LAUNCH_KINDS } from "./launch-state.ts";
import type { AgentStatus } from "../../shared/types.ts";

describe("launch-copy", () => {
  test("every kind has a Plan tooltip, and the strings match what the UI always said", () => {
    for (const k of LAUNCH_KINDS) expect(planModeTooltip(k).length).toBeGreaterThan(10);
    expect(planModeTooltip("codex")).toBe("Codex has no native plan mode — routed to 'ask' so nothing auto-executes.");
    expect(planModeTooltip("claude-code")).toBe("Plan only — agent describes what it would do without making changes.");
    expect(CODE_MODE_TOOLTIP).toContain("Execute changes");
  });
  test("harnessTooltip orders email, usage, reason, auth help, path, version, and falls back to the id", () => {
    const status = {
      account: { email: "me@x.dev" },
      usage: { today: { inputTokens: 1500, outputTokens: 500 } },
      reason: "r",
      loggedIn: false,
      authHelp: "run login",
      path: "/bin/x",
      version: "1.2.3",
    } as unknown as AgentStatus;
    expect(harnessTooltip(status, "h")).toBe("me@x.dev — today 2.0k tok — r — run login — /bin/x — 1.2.3");
    expect(harnessTooltip(undefined, "h")).toBe("h");
    expect(harnessTooltip({ loggedIn: false, authHelp: null } as unknown as AgentStatus, "h")).toBe("Not logged in");
  });
  test("usage notes for Fable and Mythos only", () => {
    expect(usageNote("claude-code", "fable-5-2", "Fable 5.2")).toBe("Fable 5.2 uses 2x the usage of Opus.");
    expect(usageNote("claude-code", "mythos-1", undefined)).toBe("mythos-1 uses 2x the usage of Opus and requires approved-org (Project Glasswing) access.");
    expect(usageNote("claude-code", "opus-5-5", "Opus")).toBeNull();
    expect(usageNote("codex", "fable-5-2", "x")).toBeNull();
  });
  test("effort tooltip", () => {
    expect(effortTooltip("codex", false)).toContain("doesn't accept");
    expect(effortTooltip("claude-code", true)).toContain("thinking keyword");
    expect(effortTooltip("codex", true)).toContain("Reasoning effort");
  });
});

describe("launch-summary", () => {
  test("workspaceSummary", () => {
    expect(workspaceSummary({ projectLabels: ["agetor"], baseRefs: [""], isolate: true, branch: "fix/7c5261" })).toBe(
      "agetor · current branch · isolated · fix/7c5261",
    );
    expect(workspaceSummary({ projectLabels: ["a"], baseRefs: ["main"], isolate: false, branch: "" })).toBe("a · main · in place");
    expect(workspaceSummary({ projectLabels: ["a", "b"], baseRefs: [], isolate: true, branch: "" })).toBe("2 projects · isolated");
    expect(workspaceSummary({ projectLabels: [], baseRefs: [], isolate: true, branch: "" })).toBe("No project selected");
  });
  test("agentSummary", () => {
    expect(agentSummary({ harnessLabel: "Claude Code", modelLabel: "Opus 5.5", effortLabel: "High", primary: "code" })).toBe(
      "Claude Code · Opus 5.5 · High · Code",
    );
    expect(agentSummary({ harnessLabel: "x", primary: "plan" })).toBe("x · Plan");
    expect(agentSummary({ pipelineName: "Review", harnessLabel: "x", primary: "code" })).toBe("Pipeline · Review");
    expect(agentSummary({ profileName: "Fast", harnessLabel: "x", primary: "code" })).toBe("Agent · Fast");
  });
  test("moreOptionsNotes lists only non-default rare values", () => {
    expect(moreOptionsNotes({})).toEqual([]);
    expect(moreOptionsNotes({ speed: "off" })).toEqual([]);
    expect(moreOptionsNotes({ speed: "fast", speedLabel: "Fast", maxMode: true, modeVariantLabel: "Accept edits", branchEdited: true })).toEqual([
      "Speed: Fast", "Max Mode", "Mode: Accept edits", "Branch name edited",
    ]);
  });
});
