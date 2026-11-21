import { describe, expect, test } from "bun:test";
import { applyTaskDelta, isTaskDelta, taskDeltaPath } from "./task-delta.ts";
import type { Task, TaskDelta } from "./types.ts";

// X6 (docs/plans/non-blocking-core.md): the shared delta merge both the webview
// and the TUI use.

function task(id: string, createdAt: number, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: `t-${id}`,
    createdAt,
    updatedAt: createdAt,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    ...extra,
  } as Task;
}

function delta(extra: Partial<TaskDelta> = {}): TaskDelta {
  return { format: "delta", cursor: "e-b:1:0", snapshot: false, tasks: [], removedIds: [], decorations: {}, ...extra };
}

const prev = [task("c", 300), task("b", 200), task("a", 100)];

describe("applyTaskDelta", () => {
  test("an empty delta returns the same array reference", () => {
    expect(applyTaskDelta(prev, delta())).toBe(prev);
  });

  test("an unchanged row keeps its object; a changed row is replaced; the rest keep identity", () => {
    const next = applyTaskDelta(prev, delta({ tasks: [task("b", 200), task("a", 100, { title: "renamed" })] }));
    expect(next).not.toBe(prev);
    expect(next.map((t) => t.id)).toEqual(["c", "b", "a"]);
    expect(next[0]).toBe(prev[0]!);
    expect(next[1]).toBe(prev[1]!); // deep-equal: kept
    expect(next[2]).not.toBe(prev[2]!);
    expect(next[2]!.title).toBe("renamed");
  });

  test("a delta whose rows are all deep-equal returns the same array", () => {
    expect(applyTaskDelta(prev, delta({ tasks: [task("c", 300), task("a", 100)] }))).toBe(prev);
  });

  test("removedIds drop rows; an unknown id is harmless", () => {
    const next = applyTaskDelta(prev, delta({ removedIds: ["b", "zzz"] }));
    expect(next.map((t) => t.id)).toEqual(["c", "a"]);
    expect(next[0]).toBe(prev[0]!);
  });

  test("a new row lands at its createdAt position (newest first)", () => {
    const next = applyTaskDelta(prev, delta({ tasks: [task("n", 250), task("old", 50), task("top", 999)] }));
    expect(next.map((t) => t.id)).toEqual(["top", "c", "n", "b", "a", "old"]);
  });

  test("decorations overlay the four fields and leave absent keys alone", () => {
    const withStall = [task("a", 100, { stalledSince: 5, runningSubagents: 2 })];
    const next = applyTaskDelta(
      withStall,
      delta({ decorations: { a: { pendingInteractions: 3, openTerminals: 1, stalledSince: null } } }),
    );
    expect(next[0]).toMatchObject({
      pendingInteractionCount: 3,
      openTerminalCount: 1,
      stalledSince: null,
      runningSubagents: 2, // not mentioned: untouched
    });
    expect(withStall[0]!.pendingInteractionCount).toBe(0); // input not mutated
  });

  test("a decoration equal to the row's value changes nothing (array identity kept)", () => {
    expect(
      applyTaskDelta(prev, delta({ decorations: { a: { pendingInteractions: 0, openTerminals: 0, stalledSince: null } } })),
    ).toBe(prev);
  });

  test("a decoration on a changed row and on an id with no row", () => {
    const next = applyTaskDelta(
      prev,
      delta({
        tasks: [task("a", 100, { title: "x" })],
        decorations: { a: { runningSubagents: 4 }, ghost: { pendingInteractions: 9 } },
      }),
    );
    expect(next.find((t) => t.id === "a")).toMatchObject({ title: "x", runningSubagents: 4 });
    expect(next.map((t) => t.id)).toEqual(["c", "b", "a"]);
  });

  test("a snapshot replaces the list in the server's order but keeps identity of equal rows", () => {
    const next = applyTaskDelta(prev, delta({ snapshot: true, tasks: [task("a", 100), task("d", 400), task("c", 300, { title: "z" })] }));
    expect(next.map((t) => t.id)).toEqual(["a", "d", "c"]);
    expect(next[0]).toBe(prev[2]!);
    expect(next[2]!.title).toBe("z");
  });

  test("a snapshot equal to the list returns the same array; an empty snapshot empties it", () => {
    expect(applyTaskDelta(prev, delta({ snapshot: true, tasks: [task("c", 300), task("b", 200), task("a", 100)] }))).toBe(prev);
    expect(applyTaskDelta(prev, delta({ snapshot: true, tasks: [] }))).toEqual([]);
  });

  test("a shared serialization cache is kept in step and evicts removed ids", () => {
    const cache = new Map<string, { obj: Task; json: string }>();
    const first = applyTaskDelta([], delta({ snapshot: true, tasks: prev }), { cache });
    expect([...cache.keys()].sort()).toEqual(["a", "b", "c"]);
    const next = applyTaskDelta(first, delta({ removedIds: ["a"], tasks: [task("b", 200, { title: "q" })] }), { cache });
    expect([...cache.keys()].sort()).toEqual(["b", "c"]);
    expect(cache.get("b")!.obj).toBe(next[1]!);
  });
});

describe("isTaskDelta / taskDeltaPath", () => {
  test("tells an envelope from a bare array", () => {
    expect(isTaskDelta(delta())).toBe(true);
    expect(isTaskDelta([])).toBe(false);
    expect(isTaskDelta(null)).toBe(false);
    expect(isTaskDelta({ format: "delta" })).toBe(false);
  });

  test("builds the query like taskListPath plus delta and since", () => {
    expect(taskDeltaPath()).toBe("/tasks?delta=1");
    expect(taskDeltaPath({ archived: "exclude", keep: ["x", "y"] }, "e-b:3:1")).toBe(
      "/tasks?archived=exclude&keep=x%2Cy&delta=1&since=e-b%3A3%3A1",
    );
    expect(taskDeltaPath({ archived: "include", keep: ["x"] })).toBe("/tasks?delta=1");
  });
});
