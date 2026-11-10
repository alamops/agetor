import { describe, expect, test } from "bun:test";
import { groupStickySections, type StickyItem } from "./sticky-sections.ts";

describe("groupStickySections", () => {
  test("preamble, then one section per visible user message", () => {
    const items: StickyItem<string>[] = [
      { kind: "body", key: "k0", nodes: ["status"] },
      { kind: "turn", key: "k1", header: "U1", before: ["int1"] },
      { kind: "body", key: "k2", nodes: ["a1"] },
      { kind: "turn", key: "k3", header: "U2", before: [] },
      { kind: "body", key: "k4", nodes: ["a2"] },
    ];
    expect(groupStickySections(items, ["tail"])).toEqual([
      { key: "k0", header: null, body: ["status"] },
      { key: "k1", header: "U1", body: ["int1", "a1"] },
      { key: "k3", header: "U2", body: ["a2", "tail"] },
    ]);
  });

  test("a hidden user message (renders nothing) does not open a headerless section (N4)", () => {
    const items: StickyItem<string>[] = [
      { kind: "turn", key: "k1", header: "U1", before: [] },
      { kind: "body", key: "k2", nodes: ["a1", "swap-divider"] },
      // The hidden continuation the swap sends on the next account.
      { kind: "turn", key: "k3", header: null, before: ["int"] },
      { kind: "body", key: "k4", nodes: ["a2"] },
    ];
    expect(groupStickySections(items)).toEqual([
      { key: "k1", header: "U1", body: ["a1", "swap-divider", "int", "a2"] },
    ]);
  });

  test("a hidden first message keeps the preamble headerless and keyed", () => {
    const items: StickyItem<string>[] = [
      { kind: "turn", key: "k0", header: null, before: [] },
      { kind: "body", key: "k1", nodes: ["a1"] },
    ];
    expect(groupStickySections(items)).toEqual([{ key: "k0", header: null, body: ["a1"] }]);
  });

  test("nothing renders nothing", () => {
    expect(groupStickySections<string>([])).toEqual([]);
  });
});
