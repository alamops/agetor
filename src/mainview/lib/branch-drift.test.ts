import { test, expect } from "bun:test";
import { driftOf, driftTitle } from "./branch-drift.ts";

test("driftOf: unknown observation never counts as drift", () => {
  expect(driftOf("agetor/a-b", null)).toEqual({ drifted: false, live: "agetor/a-b" });
  expect(driftOf("agetor/a-b", undefined)).toEqual({ drifted: false, live: "agetor/a-b" });
});

test("driftOf: same branch → not drifted", () => {
  expect(driftOf("agetor/a-b", "agetor/a-b")).toEqual({ drifted: false, live: "agetor/a-b" });
});

test("driftOf: different branch → drifted, live is the observed one", () => {
  expect(driftOf("agetor/a-b", "implement/x")).toEqual({ drifted: true, live: "implement/x" });
});

test("driftOf: no task branch (isolation none) is never drift", () => {
  expect(driftOf(null, "feat/thing")).toEqual({ drifted: false, live: "feat/thing" });
  expect(driftOf(null, null)).toEqual({ drifted: false, live: null });
});

test("driftTitle names the task branch", () => {
  expect(driftTitle("agetor/a-b")).toBe("task branch: agetor/a-b");
  expect(driftTitle(null)).toBe("task branch: —");
});
