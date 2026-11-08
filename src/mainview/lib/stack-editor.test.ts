import { describe, expect, test } from "bun:test";
import {
  addMember,
  draftBlockers,
  draftFromStack,
  draftPatch,
  draftWarnings,
  emptyDraft,
  moveMember,
  removeMember,
  virtualWindow,
} from "./stack-editor.ts";
import type { Harness, HarnessStack } from "../../shared/types.ts";

const harness = (id: string, kind: Harness["kind"] = "claude-code", enabled = true): Harness => ({
  id,
  kind,
  label: id,
  isBuiltin: false,
  home: `/${id}`,
  bin: null,
  env: {},
  enabled,
});

const HARNESSES = [harness("a"), harness("b"), harness("c"), harness("x", "codex"), harness("off", "claude-code", false)];

describe("stack draft", () => {
  test("add, remove and reorder keep order and dedupe", () => {
    let draft = emptyDraft();
    draft = addMember(draft, "a");
    draft = addMember(draft, "b");
    draft = addMember(draft, "a");
    expect(draft.members).toEqual(["a", "b"]);
    draft = moveMember(draft, 0, 1);
    expect(draft.members).toEqual(["b", "a"]);
    draft = removeMember(draft, "b");
    expect(draft.members).toEqual(["a"]);
  });

  test("draftFromStack preserves the primary order and mirror mode", () => {
    const stack = {
      id: "s",
      label: "L",
      kind: "claude-code",
      mirrorMode: "safe",
      members: [
        { harnessId: "a", position: 0, label: "a", kind: "claude-code", enabled: true },
        { harnessId: "b", position: 1, label: "b", kind: "claude-code", enabled: true },
      ],
      createdAt: 1,
      updatedAt: 1,
      warnings: [],
    } satisfies HarnessStack;
    expect(draftFromStack(stack)).toEqual({ label: "L", kind: "claude-code", members: ["a", "b"], mirrorMode: "safe" });
  });

  test("draftPatch only sends what changed (a rename does not resend members)", () => {
    const stack = {
      id: "s",
      label: "L",
      kind: "claude-code",
      mirrorMode: "safe",
      members: [
        { harnessId: "a", position: 0, label: "a", kind: "claude-code", enabled: true },
        { harnessId: "b", position: 1, label: "b", kind: "claude-code", enabled: true },
      ],
      createdAt: 1,
      updatedAt: 1,
      warnings: [],
    } satisfies HarnessStack;

    expect(draftPatch(stack, { ...draftFromStack(stack), label: "Renamed" })).toEqual({ label: "Renamed" });
    expect(draftPatch(stack, { ...draftFromStack(stack), members: ["b", "a"] })).toEqual({ members: ["b", "a"] });
    expect(draftPatch(stack, { ...draftFromStack(stack), mirrorMode: "full" })).toEqual({ mirrorMode: "full" });
    expect(draftPatch(stack, draftFromStack(stack))).toEqual({});
  });

  test("blockers cover label, members, kind, unknown and prior membership", () => {
    const membership = new Map([["c", "other-stack"]]);
    const problems = draftBlockers(
      { label: "", kind: "claude-code", members: ["a", "x", "ghost", "c", "a"], mirrorMode: "full" },
      { harnesses: HARNESSES, stackId: null, membership },
    );
    const codes = problems.map((p) => p.code);
    expect(codes).toContain("no-label");
    expect(codes).toContain("duplicate-member");
    expect(codes).toContain("mixed-kinds");
    expect(codes).toContain("unknown-harness");
    expect(codes).toContain("already-in-stack");
    // Editing the stack that already owns the account is not a blocker.
    expect(
      draftBlockers(
        { label: "ok", kind: "claude-code", members: ["c"], mirrorMode: "full" },
        { harnesses: HARNESSES, stackId: "other-stack", membership },
      ),
    ).toEqual([]);
  });

  test("two members sharing a config directory are blocked like the server", () => {
    const sameHome = { ...harness("q"), home: "/a" };
    const problems = draftBlockers(
      { label: "L", kind: "claude-code", members: ["a", "q"], mirrorMode: "full" },
      { harnesses: [...HARNESSES, sameHome], stackId: null, membership: new Map() },
    );
    expect(problems.map((p) => p.code)).toContain("same-home");
    expect(problems.find((p) => p.code === "same-home")?.message).toContain("share the same config directory");
    // An explicit CLAUDE_CONFIG_DIR wins over `home`, exactly as the server's
    // `claudeConfigDirFor` precedence does.
    const envPinned = { ...harness("r"), home: "/elsewhere", env: { CLAUDE_CONFIG_DIR: "/a" } };
    expect(
      draftBlockers(
        { label: "L", kind: "claude-code", members: ["a", "r"], mirrorMode: "full" },
        { harnesses: [...HARNESSES, envPinned], stackId: null, membership: new Map() },
      ).map((p) => p.code),
    ).toContain("same-home");
    // Codex roots are `<home>/.codex`; distinct homes stay distinct.
    expect(
      draftBlockers(
        { label: "L", kind: "codex", members: ["x", "y"], mirrorMode: "full" },
        { harnesses: [...HARNESSES, harness("y", "codex")], stackId: null, membership: new Map() },
      ).map((p) => p.code),
    ).not.toContain("same-home");
  });

  test("warnings cover <2, >10, full mirror and disabled", () => {
    const codes = draftWarnings(
      { label: "L", kind: "claude-code", members: ["a"], mirrorMode: "full" },
      { harnesses: HARNESSES },
    ).map((w) => w.code);
    expect(codes).toContain("too-few-members");
    expect(codes).toContain("full-mirror-hooks");
    expect(codes).not.toContain("member-disabled");
  });
});

describe("virtualWindow", () => {
  test("renders everything at or below the threshold", () => {
    expect(virtualWindow({ rowCount: 20, scrollTop: 400, rowHeight: 40, viewportHeight: 400 })).toEqual({
      start: 0,
      end: 20,
      leading: 0,
      trailing: 0,
      count: 20,
    });
  });

  test("above the threshold it renders the visible slice plus overscan", () => {
    const win = virtualWindow({ rowCount: 100, scrollTop: 40 * 20, rowHeight: 40, viewportHeight: 400, overscan: 2 });
    expect(win.start).toBe(18);
    expect(win.count).toBeLessThan(100);
    expect(win.leading).toBe(18);
    expect(win.end).toBeLessThanOrEqual(100);
    expect(win.end - win.start).toBe(win.count);
    // The bottom spacer keeps the scrollbar honest: leading + rows + trailing
    // must cover the whole list, or the list can never scroll to its end.
    expect(win.leading + win.count + win.trailing).toBe(100);
    expect(win.trailing).toBe(100 - win.end);
  });
});
