import { test, expect } from "bun:test";
import { reconcileById } from "./reconcile";

type Row = { id: string; status: string; n?: number };
const key = (r: Row) => r.id;

test("returns the previous array itself when nothing changed", () => {
  const prev: Row[] = [{ id: "a", status: "running" }, { id: "b", status: "succeeded" }];
  const next: Row[] = [{ id: "a", status: "running" }, { id: "b", status: "succeeded" }];
  expect(reconcileById(prev, next, key)).toBe(prev);
});

test("keeps identity for unchanged entries and swaps only the changed one", () => {
  const a = { id: "a", status: "running" };
  const b = { id: "b", status: "running" };
  const out = reconcileById([a, b], [{ id: "a", status: "running" }, { id: "b", status: "succeeded" }], key);
  expect(out).not.toBe([a, b]);
  expect(out[0]).toBe(a);
  expect(out[1]).not.toBe(b);
  expect(out[1]!.status).toBe("succeeded");
});

test("order and length changes produce a new array in the fetched order", () => {
  const a = { id: "a", status: "x" };
  const b = { id: "b", status: "y" };
  const out = reconcileById([a, b], [{ id: "b", status: "y" }, { id: "c", status: "z" }], key);
  expect(out.map((r) => r.id)).toEqual(["b", "c"]);
  expect(out[0]).toBe(b);
});

test("the optional cache memoizes serialized forms and evicts ids that disappear", () => {
  const cache = new Map<string, { obj: Row; json: string }>();
  const first = reconcileById<Row>([], [{ id: "a", status: "x" }, { id: "b", status: "y" }], key, cache);
  expect(cache.size).toBe(2);
  const second = reconcileById(first, [{ id: "a", status: "x" }], key, cache);
  expect(second[0]).toBe(first[0]);
  expect(cache.size).toBe(1);
  expect(cache.has("b")).toBe(false);
});
