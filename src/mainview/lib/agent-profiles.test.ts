import { describe, expect, test } from "bun:test";
import { filterAgentProfiles, resolveTaskProfileDisplay } from "./agent-profiles.ts";
import { agentProfileSummary } from "../../shared/agent-profile.ts";
import type { AgentProfile, AgentProfileSnapshot, Harness, Task } from "../../shared/types.ts";

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "profile-1",
    name: "My Agent",
    harness: "harness-1",
    model: "model-1",
    effort: null,
    mode: null,
    fast: false,
    maxMode: false,
    instructions: "",
    skills: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<AgentProfileSnapshot> = {}): AgentProfileSnapshot {
  return {
    id: "profile-1",
    name: "Snapshot Name",
    harness: "harness-1",
    harnessKind: "claude-code",
    harnessLabel: "Claude Code",
    model: "snapshot-model",
    effort: "low",
    mode: "auto",
    fast: false,
    maxMode: false,
    instructions: "",
    skills: [],
    capturedAt: 0,
    ...overrides,
  };
}

function makeHarness(overrides: Partial<Harness> = {}): Harness {
  return {
    id: "harness-1",
    kind: "claude-code",
    label: "Claude Code",
    isBuiltin: true,
    home: null,
    bin: null,
    env: {},
    enabled: true,
    ...overrides,
  };
}

type TaskProfileFields = Pick<Task, "agentProfileId" | "agentProfile">;

// ---------------------------------------------------------------------------
// filterAgentProfiles

describe("filterAgentProfiles", () => {
  test("empty query returns the identical list (same reference)", () => {
    const list = [makeProfile()];
    expect(filterAgentProfiles(list, "")).toBe(list);
  });

  test("whitespace-only query returns the identical list (same reference)", () => {
    const list = [makeProfile()];
    expect(filterAgentProfiles(list, "   ")).toBe(list);
  });

  test("case-insensitive match on name", () => {
    const p = makeProfile({ id: "1", name: "Code Reviewer" });
    expect(filterAgentProfiles([p], "CODE review")).toEqual([p]);
  });

  test("case-insensitive match on harness id", () => {
    const p = makeProfile({ id: "1", harness: "MyHarnessId" });
    expect(filterAgentProfiles([p], "myharnessid")).toEqual([p]);
  });

  test("case-insensitive match on model", () => {
    const p = makeProfile({ id: "1", model: "Claude-Opus-5" });
    expect(filterAgentProfiles([p], "claude-opus")).toEqual([p]);
  });

  test("case-insensitive match on effort", () => {
    const p = makeProfile({ id: "1", effort: "Ultra" });
    expect(filterAgentProfiles([p], "ultra")).toEqual([p]);
  });

  test("case-insensitive match on mode", () => {
    const p = makeProfile({ id: "1", mode: "Full Access" });
    expect(filterAgentProfiles([p], "full access")).toEqual([p]);
  });

  test("case-insensitive match on instructions", () => {
    const p = makeProfile({ id: "1", instructions: "Always run the Test Suite first" });
    expect(filterAgentProfiles([p], "test suite")).toEqual([p]);
  });

  test("null effort/mode never throw and are simply not matched", () => {
    const p = makeProfile({ id: "1", effort: null, mode: null });
    expect(() => filterAgentProfiles([p], "null")).not.toThrow();
    expect(filterAgentProfiles([p], "null")).toEqual([]);
  });

  test("a query matching no field on any profile returns an empty list", () => {
    const p = makeProfile({
      id: "1",
      name: "Alpha",
      harness: "h",
      model: "m",
      effort: "low",
      mode: "auto",
      instructions: "do things",
    });
    expect(filterAgentProfiles([p], "zzz-nomatch")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveTaskProfileDisplay

describe("resolveTaskProfileDisplay", () => {
  test("returns null when the task carries neither agentProfileId nor agentProfile", () => {
    const task: TaskProfileFields = { agentProfileId: null, agentProfile: null };
    expect(resolveTaskProfileDisplay(task, null)).toBeNull();
    expect(resolveTaskProfileDisplay(task, [])).toBeNull();
  });

  test("returns null when both fields are undefined (fixture-compat shape)", () => {
    const task = {} as TaskProfileFields;
    expect(resolveTaskProfileDisplay(task, null)).toBeNull();
  });

  test("snapshot-only (live list null) → snapshot values, deleted: false", () => {
    const snapshot = makeSnapshot({
      id: "p1",
      name: "Snap Name",
      harnessKind: "codex",
      harnessLabel: "Codex",
      model: "snap-model",
      effort: "high",
      mode: "ask",
    });
    const task: TaskProfileFields = { agentProfileId: "p1", agentProfile: snapshot };
    const result = resolveTaskProfileDisplay(task, null);
    expect(result).toEqual({
      id: "p1",
      name: "Snap Name",
      harnessKind: "codex",
      harnessLabel: "Codex",
      summary: agentProfileSummary({ harnessLabel: "Codex", model: "snap-model", effort: "high", mode: "ask" }),
      deleted: false,
    });
  });

  test("live list present and id found → SNAPSHOT values win (frozen at bind/launch time), deleted: false", () => {
    const snapshot = makeSnapshot({
      id: "p1",
      name: "Old Name",
      harnessKind: "codex",
      harnessLabel: "Codex (snapshot)",
      model: "old-model",
      effort: "low",
      mode: "auto",
    });
    const task: TaskProfileFields = { agentProfileId: "p1", agentProfile: snapshot };
    const live: AgentProfile[] = [
      makeProfile({
        id: "p1",
        name: "New Name",
        harness: "h1",
        model: "new-model",
        effort: "high",
        mode: "ask",
      }),
    ];
    const harnesses: Harness[] = [makeHarness({ id: "h1", kind: "codex", label: "Codex" })];
    const result = resolveTaskProfileDisplay(task, live, harnesses);
    expect(result).toEqual({
      id: "p1",
      name: "Old Name",
      harnessKind: "codex",
      harnessLabel: "Codex (snapshot)",
      summary: agentProfileSummary({ harnessLabel: "Codex (snapshot)", model: "old-model", effort: "low", mode: "auto" }),
      deleted: false,
    });
  });

  test("live list present and id found, but the harness itself isn't in `harnesses` → snapshot's recorded kind/label are used regardless (the live harness lookup is never consulted when a snapshot is present)", () => {
    const snapshot = makeSnapshot({ id: "p1", harnessKind: "gemini", harnessLabel: "Gemini (recorded)" });
    const task: TaskProfileFields = { agentProfileId: "p1", agentProfile: snapshot };
    const live: AgentProfile[] = [makeProfile({ id: "p1", harness: "missing-harness" })];
    const result = resolveTaskProfileDisplay(task, live, []);
    expect(result?.harnessKind).toBe("gemini");
    expect(result?.harnessLabel).toBe("Gemini (recorded)");
    expect(result?.deleted).toBe(false);
  });

  test("live === null → deleted is always false, regardless of whether task.agentProfileId matches anything", () => {
    const snapshot = makeSnapshot({ id: "p1" });
    const task: TaskProfileFields = { agentProfileId: "p1", agentProfile: snapshot };
    expect(resolveTaskProfileDisplay(task, null)?.deleted).toBe(false);
    const orphanTask: TaskProfileFields = { agentProfileId: "nonexistent-id", agentProfile: snapshot };
    expect(resolveTaskProfileDisplay(orphanTask, null)?.deleted).toBe(false);
  });

  test("live list present and id missing → deleted: true, values come from the snapshot", () => {
    const snapshot = makeSnapshot({
      id: "p-missing",
      name: "Gone Profile",
      harnessKind: "fx",
      harnessLabel: "Fx",
      model: "gone-model",
      effort: "ultra",
      mode: "yolo",
    });
    const task: TaskProfileFields = { agentProfileId: "p-missing", agentProfile: snapshot };
    const live: AgentProfile[] = [makeProfile({ id: "other-id" })];
    const result = resolveTaskProfileDisplay(task, live);
    expect(result).toEqual({
      id: "p-missing",
      name: "Gone Profile",
      harnessKind: "fx",
      harnessLabel: "Fx",
      summary: agentProfileSummary({ harnessLabel: "Fx", model: "gone-model", effort: "ultra", mode: "yolo" }),
      deleted: true,
    });
  });

  test("live list present (empty array) and id set → deleted: true", () => {
    const snapshot = makeSnapshot({ id: "p1" });
    const task: TaskProfileFields = { agentProfileId: "p1", agentProfile: snapshot };
    const result = resolveTaskProfileDisplay(task, []);
    expect(result?.deleted).toBe(true);
  });

  test("summary always matches agentProfileSummary's own output for the resolved fields", () => {
    const live: AgentProfile[] = [
      makeProfile({ id: "p1", model: "m", effort: null, mode: "auto" }),
    ];
    const harnesses: Harness[] = [makeHarness({ id: "harness-1", kind: "cursor", label: "Cursor" })];
    const task: TaskProfileFields = { agentProfileId: "p1", agentProfile: null };
    const result = resolveTaskProfileDisplay(task, live, harnesses);
    expect(result?.summary).toBe(
      agentProfileSummary({ harnessLabel: "Cursor", model: "m", effort: null, mode: "auto" }),
    );
  });
});
