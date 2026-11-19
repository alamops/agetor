import { describe, expect, test } from "bun:test";
import { naturalPopoverHeight, placePopover, VIEWPORT_MARGIN } from "./popover-position.ts";

const vp = { viewportWidth: 1000, viewportHeight: 800 };

describe("placePopover", () => {
  test("opens below when it fits", () => {
    const p = placePopover({ trigger: { top: 100, left: 50, width: 200, height: 36 }, popoverHeight: 200, ...vp });
    expect(p.side).toBe("below");
    expect(p.top).toBe(100 + 36 + 4);
    expect(p.maxHeight).toBe(200);
  });
  test("flips above when there is no room below but room above", () => {
    const p = placePopover({ trigger: { top: 700, left: 50, width: 200, height: 36 }, popoverHeight: 300, ...vp });
    expect(p.side).toBe("above");
    expect(p.top).toBe(700 - 4 - 300);
  });
  test("picks the roomier side and caps the height when neither fits", () => {
    const p = placePopover({ trigger: { top: 100, left: 50, width: 200, height: 36 }, popoverHeight: 900, ...vp });
    expect(p.side).toBe("below");
    expect(p.maxHeight).toBeLessThan(900);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(800 - VIEWPORT_MARGIN);
  });
  test("clamps inside the right edge and never wider than the viewport", () => {
    const p = placePopover({ trigger: { top: 100, left: 900, width: 200, height: 36 }, popoverHeight: 100, ...vp });
    expect(p.left + p.width).toBeLessThanOrEqual(1000 - VIEWPORT_MARGIN);
    const w = placePopover({ trigger: { top: 100, left: 0, width: 5000, height: 36 }, popoverHeight: 100, ...vp });
    expect(w.width).toBe(1000 - VIEWPORT_MARGIN * 2);
    expect(w.left).toBe(VIEWPORT_MARGIN);
  });
  test("honors the preferred side when both fit", () => {
    const p = placePopover({ trigger: { top: 400, left: 50, width: 200, height: 36 }, popoverHeight: 100, prefer: "above", ...vp });
    expect(p.side).toBe("above");
  });
});

describe("naturalPopoverHeight", () => {
  test("equals the panel's own height when the list shows everything", () => {
    expect(naturalPopoverHeight({ panelScrollHeight: 120, listClientHeight: 80, listScrollHeight: 80, maxListHeight: 288 })).toBe(120);
  });
  test("adds back the rows a stale max-height hides, so rows that arrived while open grow the panel", () => {
    // Placed with one 40 px row, then three more arrived: the list scrolls inside a 40 px panel.
    expect(naturalPopoverHeight({ panelScrollHeight: 40, listClientHeight: 30, listScrollHeight: 150, maxListHeight: 288 })).toBe(160);
  });
  test("never asks for more list than the list's own cap", () => {
    expect(naturalPopoverHeight({ panelScrollHeight: 40, listClientHeight: 30, listScrollHeight: 2000, maxListHeight: 288 })).toBe(40 + 288 - 30);
  });
});
