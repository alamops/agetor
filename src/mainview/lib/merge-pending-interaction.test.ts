import { expect, test } from "bun:test";
import { mergePendingInteraction, mergePendingInteractionSnapshot } from "./merge-pending-interaction.ts";

test("mergePendingInteraction appends a new id and keeps the previous list's other cards", () => {
  const current = [{ id: "a", delivery: "live" }];
  const next = mergePendingInteraction(current, { id: "b", delivery: "live" });
  expect(next).toEqual([
    { id: "a", delivery: "live" },
    { id: "b", delivery: "live" },
  ]);
  expect(current).toEqual([{ id: "a", delivery: "live" }]);
});

test("mergePendingInteraction replaces a same-id card when delivery changes", () => {
  const current = [{ id: "ask-1", delivery: "live", title: "Pick" }];
  const incoming = { id: "ask-1", delivery: "restart-followup", title: "Pick" };
  const next = mergePendingInteraction(current, incoming);
  expect(next).toHaveLength(1);
  expect(next[0]).toEqual(incoming);
  expect(next[0]).not.toBe(current[0]);
});

test("mergePendingInteraction returns the same array when the payload is unchanged", () => {
  const current = [{ id: "ask-1", delivery: "live" }];
  expect(mergePendingInteraction(current, { id: "ask-1", delivery: "live" })).toBe(current);
});

test("mergePendingInteractionSnapshot fills an empty list from the bootstrap", () => {
  const snapshot = [{ id: "ask-1", delivery: "live" }];
  expect(mergePendingInteractionSnapshot([], snapshot, new Set())).toEqual(snapshot);
});

test("mergePendingInteractionSnapshot keeps a stream update over an older snapshot of the same id", () => {
  const current = [{ id: "ask-1", delivery: "restart-followup" }];
  const snapshot = [{ id: "ask-1", delivery: "live" }];
  expect(mergePendingInteractionSnapshot(current, snapshot, new Set())).toBe(current);
});

test("mergePendingInteractionSnapshot does not resurrect an id the stream already resolved", () => {
  const current = [{ id: "keep", delivery: "live" }];
  const snapshot = [
    { id: "keep", delivery: "live" },
    { id: "gone", delivery: "live" },
  ];
  expect(mergePendingInteractionSnapshot(current, snapshot, new Set(["gone"]))).toBe(current);
});

test("mergePendingInteractionSnapshot appends a bootstrap card the stream has not seen", () => {
  const current = [{ id: "live", delivery: "restart-followup" }];
  const snapshot = [
    { id: "live", delivery: "live" },
    { id: "earlier", delivery: "live" },
  ];
  expect(mergePendingInteractionSnapshot(current, snapshot, new Set())).toEqual([
    { id: "live", delivery: "restart-followup" },
    { id: "earlier", delivery: "live" },
  ]);
});
