import { describe, expect, test } from "bun:test";
import {
  agentProfileTextDirty,
  duplicateAgentName,
  LAUNCH_INTERACTION_SETTERS,
  trackLaunchInteractions,
  type AgentProfileTextDraft,
} from "./agent-profile-form.ts";

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
    const result = duplicateAgentName("Bug fixer", taken);
    expect(taken.map((n) => n.trim().toLowerCase())).not.toContain(result.trim().toLowerCase());
  });
});

describe("trackLaunchInteractions", () => {
  // A stand-in for `TaskLaunch`: current values plus recording setters, and
  // one unrelated field the tracker must pass through.
  function fakeLaunch() {
    const calls: [string, unknown][] = [];
    const launch = {
      agent: "opencode",
      mode: "auto",
      model: "opencode-default",
      effort: null as string | null,
      speed: "off" as "off" | "fast" | "ultrafast",
      maxMode: false,
      opencodeServer: "shared" as "shared" | "standalone",
      kind: "opencode",
      switchAgent: (v: string) => void calls.push(["switchAgent", v]),
      setMode: (v: string) => void calls.push(["setMode", v]),
      setModel: (v: string) => void calls.push(["setModel", v]),
      setEffort: (v: string | null) => void calls.push(["setEffort", v]),
      setSpeed: (v: "off" | "fast" | "ultrafast") => void calls.push(["setSpeed", v]),
      setMaxMode: (v: boolean) => void calls.push(["setMaxMode", v]),
      setOpencodeServer: (v: "shared" | "standalone") => void calls.push(["setOpencodeServer", v]),
    };
    return { launch, calls };
  }

  test("an OpenCode server pick that changes the value is an interaction", () => {
    const { launch, calls } = fakeLaunch();
    let touched = 0;
    trackLaunchInteractions(launch, () => touched++).setOpencodeServer("standalone");
    expect(touched).toBe(1);
    expect(calls).toEqual([["setOpencodeServer", "standalone"]]);
  });

  test("re-picking the current OpenCode server is not an interaction, but still forwards", () => {
    const { launch, calls } = fakeLaunch();
    let touched = 0;
    trackLaunchInteractions(launch, () => touched++).setOpencodeServer("shared");
    expect(touched).toBe(0);
    expect(calls).toEqual([["setOpencodeServer", "shared"]]);
  });

  test("every launch setter counts a changed value and ignores an unchanged one", () => {
    const changed: Record<keyof typeof LAUNCH_INTERACTION_SETTERS, unknown> = {
      switchAgent: "claude-code",
      setMode: "plan",
      setModel: "anthropic/claude-x",
      setEffort: "auto",
      setSpeed: "fast",
      setMaxMode: true,
      setOpencodeServer: "standalone",
    };
    for (const setter of Object.keys(LAUNCH_INTERACTION_SETTERS) as (keyof typeof LAUNCH_INTERACTION_SETTERS)[]) {
      const { launch } = fakeLaunch();
      let touched = 0;
      const tracked = trackLaunchInteractions(launch, () => touched++) as unknown as Record<string, (v: unknown) => void>;
      tracked[setter]!(launch[LAUNCH_INTERACTION_SETTERS[setter]]);
      expect(touched).toBe(0);
      tracked[setter]!(changed[setter]);
      expect(touched).toBe(1);
    }
  });

  test("a null effort re-set is unchanged; null → a value is a change", () => {
    const { launch } = fakeLaunch();
    let touched = 0;
    const tracked = trackLaunchInteractions(launch, () => touched++);
    tracked.setEffort(null);
    expect(touched).toBe(0);
    tracked.setEffort("high");
    expect(touched).toBe(1);
  });

  test("wrapping never calls onTouch and leaves the original and other fields alone", () => {
    const { launch, calls } = fakeLaunch();
    const original = launch.setOpencodeServer;
    let touched = 0;
    const tracked = trackLaunchInteractions(launch, () => touched++);
    expect(touched).toBe(0);
    expect(calls).toEqual([]);
    expect(launch.setOpencodeServer).toBe(original);
    expect(tracked.kind).toBe("opencode");
    expect(tracked.opencodeServer).toBe("shared");
  });
});
