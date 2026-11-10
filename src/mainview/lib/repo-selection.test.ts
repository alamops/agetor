import { describe, expect, test } from "bun:test";
import {
  MANY_REPOSITORIES,
  collapseToProject,
  dedupeSelections,
  selectionName,
  selectionNames,
  tooManyRepositories,
} from "./repo-selection.ts";

describe("dedupeSelections", () => {
  test("keeps the first entry per git root", () => {
    expect(
      dedupeSelections([
        { path: "/repo/packages/a", root: "/repo" },
        { path: "/repo/packages/b", root: "/repo" },
        { path: "/other", root: "/other" },
      ]).map((e) => e.path),
    ).toEqual(["/repo/packages/a", "/other"]);
  });

  test("keeps every entry whose root is unknown", () => {
    expect(
      dedupeSelections([
        { path: "/a", root: null },
        { path: "/b", root: null },
        { path: "/c", root: "/c" },
      ]).map((e) => e.path),
    ).toEqual(["/a", "/b", "/c"]);
  });

  test("preserves order and does not mutate the input", () => {
    const input = [
      { path: "/b", root: "/b" },
      { path: "/a", root: "/a" },
    ];
    expect(dedupeSelections(input).map((e) => e.path)).toEqual(["/b", "/a"]);
    expect(input.map((e) => e.path)).toEqual(["/b", "/a"]);
  });
});

describe("selection names", () => {
  test("uses sanitized basenames, uniquified on collision", () => {
    expect(selectionNames([{ path: "/x/App One" }, { path: "/y/app-one" }])).toEqual(["app-one", "app-one-2"]);
  });
  test("selectionName is the unsuffixed basename", () => {
    expect(selectionName({ path: "/x/Backend" })).toBe("backend");
  });
});

describe("warning threshold", () => {
  test("warns only above the documented limit", () => {
    expect(tooManyRepositories(MANY_REPOSITORIES)).toBe(false);
    expect(tooManyRepositories(MANY_REPOSITORIES + 1)).toBe(true);
  });
});

describe("collapseToProject", () => {
  test("collapses a selection to the chosen project", () => {
    const prev = [
      { path: "/a", root: "/a" },
      { path: "/b", root: "/b" },
    ];
    expect(collapseToProject("/b", prev)).toEqual([{ path: "/b", root: "/b" }]);
    expect(collapseToProject("/c", prev)).toEqual([{ path: "/c", root: null }]);
    expect(collapseToProject("", prev)).toEqual([]);
  });
});
