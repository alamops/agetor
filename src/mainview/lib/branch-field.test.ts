import { test, expect, describe } from "bun:test";
import { branchFieldState, type BranchFieldInput } from "./branch-field.ts";

const TOKEN = "a1b2c3";

function input(overrides: Partial<BranchFieldInput> = {}): BranchFieldInput {
  return {
    dirty: false,
    override: "",
    pattern: "feature/<slug>",
    title: "Add login page",
    projectName: "my-cool-app",
    taskType: "task",
    token: TOKEN,
    ...overrides,
  };
}

describe("branchFieldState — clean", () => {
  test("displayValue is the rendered pattern, resolved matches, submitValue is the raw pattern", () => {
    const state = branchFieldState(input());
    expect(state.displayValue).toBe("feature/add-login-page");
    expect(state.resolved).toBe(state.displayValue);
    // Server-authoritative contract: submitValue is the UNRENDERED template,
    // not the resolved display string.
    expect(state.submitValue).toBe("feature/<slug>");
  });

  test("follows the title in realtime — a different title yields a different displayValue", () => {
    const first = branchFieldState(input({ title: "Add login page" }));
    const second = branchFieldState(input({ title: "Fix broken nav" }));
    expect(first.displayValue).toBe("feature/add-login-page");
    expect(second.displayValue).toBe("feature/fix-broken-nav");
    expect(first.displayValue).not.toBe(second.displayValue);
    // submitValue stays the raw pattern regardless of title.
    expect(first.submitValue).toBe("feature/<slug>");
    expect(second.submitValue).toBe("feature/<slug>");
  });

  test("empty title falls back to the token — no dangling prefix", () => {
    const state = branchFieldState(input({ title: "" }));
    expect(state.displayValue).toBe(`feature/${TOKEN}`);
    expect(state.resolved).toBe(`feature/${TOKEN}`);
  });
});

describe("branchFieldState — dirty", () => {
  test("displayValue is the verbatim override, submitValue is trimmed, and stale pattern/title don't leak", () => {
    const state = branchFieldState(
      input({
        dirty: true,
        override: "  my-manual-branch  ",
        // Deliberately stale/mismatched pattern + title — must not appear anywhere in the output.
        pattern: "feature/<slug>",
        title: "Some Other Title",
      }),
    );
    expect(state.displayValue).toBe("  my-manual-branch  ");
    expect(state.submitValue).toBe("my-manual-branch");
    expect(state.displayValue).not.toContain("feature/");
    expect(state.displayValue).not.toContain("some-other-title");
    expect(state.submitValue).not.toContain("feature/");
  });

  test("tags in the override still resolve, but displayValue stays the raw override", () => {
    const state = branchFieldState(
      input({
        dirty: true,
        override: "bugfix/<slug>-<type>",
        title: "Add login page",
        taskType: "bug",
      }),
    );
    expect(state.displayValue).toBe("bugfix/<slug>-<type>");
    expect(state.resolved).toBe("bugfix/add-login-page-bug");
  });

  test("a tag-free override resolves to itself (identity)", () => {
    const state = branchFieldState(input({ dirty: true, override: "bugfix/my-manual-branch" }));
    expect(state.resolved).toBe("bugfix/my-manual-branch");
    expect(state.displayValue).toBe("bugfix/my-manual-branch");
  });

  test("empty/whitespace override yields an empty submitValue", () => {
    const empty = branchFieldState(input({ dirty: true, override: "" }));
    expect(empty.submitValue).toBe("");

    const whitespace = branchFieldState(input({ dirty: true, override: "   " }));
    expect(whitespace.submitValue).toBe("");
  });
});

describe("branchFieldState — <project_name> tag wiring", () => {
  test("renders from projectName when clean", () => {
    const state = branchFieldState(
      input({ pattern: "<project_name>/<slug>", projectName: "my-cool-app" }),
    );
    expect(state.displayValue).toBe("my-cool-app/add-login-page");
  });

  test("falls back per renderBranchTemplate's rules when projectName is empty", () => {
    const state = branchFieldState(
      input({ pattern: "<project_name>/<slug>", projectName: "" }),
    );
    expect(state.displayValue).toBe("project/add-login-page");
  });
});
