import { describe, expect, test } from "bun:test";
import { contentSignature, reuseIfSameContent } from "./pipeline-run-signature";

describe("contentSignature", () => {
  test("equal content, different objects: same signature", () => {
    const a = { history: [{ taskId: "t", handoff: { summary: "s" } }], n: 1 };
    const b = JSON.parse(JSON.stringify(a));
    expect(a).not.toBe(b);
    expect(contentSignature(a)).toBe(contentSignature(b));
  });
  test("changed content: different signature", () => {
    expect(contentSignature({ n: 1 })).not.toBe(contentSignature({ n: 2 }));
    expect(contentSignature(null)).not.toBe(contentSignature(undefined));
    expect(contentSignature(null)).not.toBe(contentSignature({}));
  });
  test("a cyclic value never matches itself twice", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(contentSignature(cyc)).not.toBe(contentSignature(cyc));
  });
});

describe("reuseIfSameContent", () => {
  test("keeps the previous object when content is unchanged", () => {
    const first = reuseIfSameContent(null, { a: [1, 2] });
    const second = reuseIfSameContent(first, { a: [1, 2] });
    expect(second).toBe(first);
    expect(second.value).toBe(first.value);
  });
  test("takes the new value when content changed", () => {
    const first = reuseIfSameContent(null, { a: 1 });
    const next = { a: 2 };
    const second = reuseIfSameContent(first, next);
    expect(second).not.toBe(first);
    expect(second.value).toBe(next);
  });
  test("null run is stable too", () => {
    const first = reuseIfSameContent<null>(null, null);
    expect(reuseIfSameContent(first, null)).toBe(first);
  });
});
