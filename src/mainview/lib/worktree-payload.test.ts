import { test, expect, describe } from "bun:test";
import { worktreePayload, type WorktreePayloadInput } from "./worktree-payload.ts";

function input(overrides: Partial<WorktreePayloadInput> = {}): WorktreePayloadInput {
  return {
    isolate: true,
    baseRef: "",
    branchSubmitValue: "",
    ...overrides,
  };
}

describe("worktreePayload — isolate on", () => {
  test("empty baseRef and empty branchSubmitValue: isolation worktree, baseRef and branch both undefined", () => {
    const payload = worktreePayload(input());
    expect(payload).toEqual({ isolation: "worktree", baseRef: undefined, branch: undefined });
  });

  test("whitespace-only baseRef is treated as empty: baseRef undefined", () => {
    const payload = worktreePayload(input({ baseRef: "   " }));
    expect(payload.baseRef).toBeUndefined();
  });

  test("a set baseRef is trimmed", () => {
    const payload = worktreePayload(input({ baseRef: "  main  " }));
    expect(payload.baseRef).toBe("main");
  });

  test("a baseRef with no surrounding whitespace passes through unchanged", () => {
    const payload = worktreePayload(input({ baseRef: "develop" }));
    expect(payload.baseRef).toBe("develop");
  });

  test("empty branchSubmitValue: branch is undefined", () => {
    const payload = worktreePayload(input({ branchSubmitValue: "" }));
    expect(payload.branch).toBeUndefined();
  });

  test("a set branchSubmitValue is passed through VERBATIM — not trimmed here", () => {
    // worktreePayload deliberately does not re-trim branchSubmitValue: per
    // the source's doc comment, it's already trimmed when dirty (the caller,
    // branchFieldState, trims on the dirty path) and is the raw un-rendered
    // pattern when clean, where trimming would be incorrect. Confirm the
    // pass-through is truly verbatim, whitespace and all.
    const payload = worktreePayload(input({ branchSubmitValue: "  feature/<slug>  " }));
    expect(payload.branch).toBe("  feature/<slug>  ");
  });

  test("a clean-path submitValue (unrendered template, e.g. containing tags) passes through as-is", () => {
    const payload = worktreePayload(input({ branchSubmitValue: "feature/<slug>" }));
    expect(payload.branch).toBe("feature/<slug>");
  });

  test("baseRef set AND branchSubmitValue set: both present, exact payload", () => {
    const payload = worktreePayload(input({ baseRef: "  release/2.0  ", branchSubmitValue: "bugfix/my-fix" }));
    expect(payload).toEqual({ isolation: "worktree", baseRef: "release/2.0", branch: "bugfix/my-fix" });
  });

  test("baseRef whitespace AND branchSubmitValue set: baseRef undefined, branch present", () => {
    const payload = worktreePayload(input({ baseRef: "  ", branchSubmitValue: "bugfix/my-fix" }));
    expect(payload).toEqual({ isolation: "worktree", baseRef: undefined, branch: "bugfix/my-fix" });
  });

  test("baseRef set AND branchSubmitValue empty: baseRef present, branch undefined", () => {
    const payload = worktreePayload(input({ baseRef: "main", branchSubmitValue: "" }));
    expect(payload).toEqual({ isolation: "worktree", baseRef: "main", branch: undefined });
  });
});

describe("worktreePayload — isolate off", () => {
  test("isolation is 'none' regardless of baseRef/branchSubmitValue", () => {
    const payload = worktreePayload({ isolate: false, baseRef: "main", branchSubmitValue: "feature/x" });
    expect(payload.isolation).toBe("none");
  });

  test("baseRef and branch are both undefined even when set, since isolate gates both", () => {
    const payload = worktreePayload({ isolate: false, baseRef: "  main  ", branchSubmitValue: "feature/x" });
    expect(payload).toEqual({ isolation: "none", baseRef: undefined, branch: undefined });
  });

  test("empty baseRef/branchSubmitValue while isolate is off: same undefined result", () => {
    const payload = worktreePayload({ isolate: false, baseRef: "", branchSubmitValue: "" });
    expect(payload).toEqual({ isolation: "none", baseRef: undefined, branch: undefined });
  });

  test("whitespace-only baseRef while isolate is off: still undefined (not gated on the trim check alone)", () => {
    const payload = worktreePayload({ isolate: false, baseRef: "   ", branchSubmitValue: "" });
    expect(payload.baseRef).toBeUndefined();
  });
});
