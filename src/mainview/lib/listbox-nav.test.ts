import { describe, expect, test } from "bun:test";
import { firstEnabled, isTypeAheadKey, lastEnabled, navigate, nextEnabled, prevEnabled, typeAhead } from "./listbox-nav.ts";

const items = [{ label: "Alpha" }, { label: "Beta", disabled: true }, { label: "Bravo" }, { label: "Charlie" }];

describe("listbox-nav", () => {
  test("first and last skip disabled rows", () => {
    expect(firstEnabled(items)).toBe(0);
    expect(lastEnabled(items)).toBe(3);
    expect(firstEnabled([{ disabled: true }])).toBe(-1);
    expect(lastEnabled([])).toBe(-1);
  });
  test("next/prev wrap and skip disabled", () => {
    expect(nextEnabled(items, 0)).toBe(2);
    expect(nextEnabled(items, 3)).toBe(0);
    expect(nextEnabled(items, -1)).toBe(0);
    expect(prevEnabled(items, 2)).toBe(0);
    expect(prevEnabled(items, 0)).toBe(3);
    expect(prevEnabled(items, -1)).toBe(3);
    expect(nextEnabled([{ disabled: true }], 0)).toBe(-1);
  });
  test("navigate maps keys and ignores others", () => {
    expect(navigate(items, 0, "ArrowDown")).toBe(2);
    expect(navigate(items, 2, "ArrowUp")).toBe(0);
    expect(navigate(items, 2, "Home")).toBe(0);
    expect(navigate(items, 0, "End")).toBe(3);
    expect(navigate(items, 1, "x")).toBeNull();
    expect(navigate([{ disabled: true }], 0, "ArrowDown")).toBe(0);
  });
  test("typeAhead cycles a repeated letter and refines a prefix", () => {
    expect(typeAhead(items, 0, "b")).toBe(2); // Beta is disabled
    expect(typeAhead(items, 2, "b")).toBe(2); // wraps back to the only enabled "b"
    expect(typeAhead(items, 0, "c")).toBe(3);
    expect(typeAhead(items, 0, "ch")).toBe(3);
    expect(typeAhead(items, 0, "zz")).toBe(-1);
    expect(typeAhead(items, 0, "")).toBe(-1);
  });
  test("isTypeAheadKey excludes space and chords", () => {
    expect(isTypeAheadKey({ key: "a", ctrlKey: false, metaKey: false, altKey: false })).toBe(true);
    expect(isTypeAheadKey({ key: " ", ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
    expect(isTypeAheadKey({ key: "a", ctrlKey: true, metaKey: false, altKey: false })).toBe(false);
    expect(isTypeAheadKey({ key: "Enter", ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
  });
});
