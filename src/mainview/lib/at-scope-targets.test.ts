import { describe, expect, test } from "bun:test";
import { multiScopeStatTargets } from "./at-scope-targets.ts";

const scopes = [
  { name: "frontend", dir: "/wt/t1/frontend" },
  { name: "backend", dir: "/wt/t1/backend", ref: "release/next" },
];

describe("multiScopeStatTargets", () => {
  test("stats an unprefixed token against the workspace root (no false warning)", () => {
    const targets = multiScopeStatTargets(
      [{ path: "notes.md" }],
      scopes,
      "/wt/t1",
    );
    expect(targets).toEqual([{ dir: "/wt/t1", paths: new Map([["notes.md", "notes.md"]]) }]);
  });

  test("maps a prefixed token to its own repository scope and strips the prefix key", () => {
    const targets = multiScopeStatTargets(
      [{ path: "frontend/src/a.ts" }],
      scopes,
      "/wt/t1",
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]!.dir).toBe("/wt/t1/frontend");
    expect([...targets[0]!.paths.keys()]).toEqual(["frontend/src/a.ts"]);
  });

  test("skips a ref scope: its listing is exactly what the worktree will contain", () => {
    const targets = multiScopeStatTargets(
      [{ path: "backend/src/a.ts" }],
      scopes,
      "/wt/t1",
    );
    expect(targets).toEqual([]);
  });

  test("without a workspace root an unprefixed token keeps the listing verdict", () => {
    expect(multiScopeStatTargets([{ path: "notes.md" }], scopes, null)).toEqual([]);
    expect(multiScopeStatTargets([{ path: "notes.md" }], scopes, "   ")).toEqual([]);
  });

  test("rejects absolute and escaping paths", () => {
    const targets = multiScopeStatTargets(
      [{ path: "/etc/passwd" }, { path: "../outside.md" }, { path: "\0bad" }],
      scopes,
      "/wt/t1",
    );
    expect(targets).toEqual([]);
  });

  test("groups tokens by target and drops empty targets", () => {
    const targets = multiScopeStatTargets(
      [{ path: "notes.md" }, { path: "TODO.md" }, { path: "frontend/a.ts" }],
      scopes,
      "/wt/t1",
    );
    expect(targets).toHaveLength(2);
    const root = targets.find((t) => t.dir === "/wt/t1");
    expect([...root!.paths.keys()]).toEqual(["notes.md", "TODO.md"]);
  });
});
