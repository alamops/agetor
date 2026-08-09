import { afterEach, beforeEach, expect, test } from "bun:test";
import { EXPAND_EVENT, isExpandTargetFor } from "./expand-on-jump.ts";

// `isExpandTargetFor` guards with `target instanceof Node` before trusting
// `.contains()`. bun:test runs with no DOM, so `Node` is not a global here —
// confirmed empirically (`typeof Node === "undefined"` under `bun -e`) — and
// `x instanceof Node` throws ("right-hand side of 'instanceof' is not
// callable") rather than returning false when `Node` is undefined. To
// exercise the `contains`-calling branches honestly (not just the early
// `!root` / non-object bailouts), we install a minimal `FakeNode` as the
// global `Node` for the duration of this file and restore whatever was there
// before (nothing, on bun) afterward.
class FakeNode {
  private readonly containsImpl: (other: unknown) => boolean;
  constructor(containsImpl: (other: unknown) => boolean = () => false) {
    this.containsImpl = containsImpl;
  }
  contains(other: unknown): boolean {
    return this.containsImpl(other);
  }
}

const hadOwnNode = Object.prototype.hasOwnProperty.call(globalThis, "Node");
const originalNode = (globalThis as Record<string, unknown>).Node;

beforeEach(() => {
  (globalThis as Record<string, unknown>).Node = FakeNode;
});

afterEach(() => {
  if (hadOwnNode) {
    (globalThis as Record<string, unknown>).Node = originalNode;
  } else {
    delete (globalThis as Record<string, unknown>).Node;
  }
});

test("isExpandTargetFor: null root is always false, regardless of target", () => {
  expect(isExpandTargetFor(null, null)).toBe(false);
  expect(isExpandTargetFor(new FakeNode(() => true), null)).toBe(false);
  expect(isExpandTargetFor("anything", null)).toBe(false);
});

test("isExpandTargetFor: undefined target is false", () => {
  const root = new FakeNode() as unknown as Element;
  expect(isExpandTargetFor(undefined, root)).toBe(false);
});

test("isExpandTargetFor: primitive targets are false", () => {
  const root = new FakeNode() as unknown as Element;
  for (const primitive of [0, 1, "", "str", true, false, Symbol("x")]) {
    expect(isExpandTargetFor(primitive, root)).toBe(false);
  }
});

test("isExpandTargetFor: a plain object shaped like a Node (duck-typed contains) is still false", () => {
  // Not `instanceof Node` even though it structurally looks like one — the
  // guard rejects it before ever calling `.contains()`.
  const root = new FakeNode() as unknown as Element;
  const duckTyped = { contains: () => true };
  expect(isExpandTargetFor(duckTyped, root)).toBe(false);
});

test("isExpandTargetFor: a real Node whose contains() returns false is false", () => {
  const root = new FakeNode() as unknown as Element;
  const target = new FakeNode(() => false);
  expect(isExpandTargetFor(target, root)).toBe(false);
});

test("isExpandTargetFor: a real Node whose contains(root) returns true is true", () => {
  const root = new FakeNode() as unknown as Element;
  const target = new FakeNode((other) => other === root);
  expect(isExpandTargetFor(target, root)).toBe(true);
});

test("isExpandTargetFor: target === root (self-containment) is true", () => {
  // `node.contains(node)` is true for a real DOM node, and the implementation
  // relies on that: a block whose own root dispatched the event should still
  // expand. Model that self-containment explicitly in the fake.
  let node!: FakeNode;
  node = new FakeNode((other) => other === node);
  const root = node as unknown as Element;
  expect(isExpandTargetFor(node, root)).toBe(true);
});

test("EXPAND_EVENT is a non-empty, stable event-name string", () => {
  expect(typeof EXPAND_EVENT).toBe("string");
  expect(EXPAND_EVENT.length).toBeGreaterThan(0);
  expect(EXPAND_EVENT).toBe("agetor:expand-on-jump");
});
