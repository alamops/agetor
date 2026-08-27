import { describe, expect, test } from "bun:test";
import {
  hasTextSelection,
  keepsNativeContextMenu,
  moveMenuIndex,
  NATIVE_CONTEXT_MENU_SELECTOR,
  placeContextMenu,
  type PlaceContextMenuInput,
} from "./context-menu.ts";

// --- placeContextMenu ------------------------------------------------------

describe("placeContextMenu", () => {
  const base: PlaceContextMenuInput = {
    x: 100,
    y: 100,
    width: 50,
    height: 50,
    viewportWidth: 1000,
    viewportHeight: 1000,
  };

  test("fits entirely on-screen -> opens bottom-right of the cursor unchanged", () => {
    expect(placeContextMenu(base)).toEqual({ top: 100, left: 100 });
  });

  test("overflow on the right -> flips left of the cursor", () => {
    const result = placeContextMenu({ ...base, x: 990 });
    expect(result).toEqual({ top: 100, left: 940 });
  });

  test("overflow on the bottom -> flips above the cursor", () => {
    const result = placeContextMenu({ ...base, y: 990 });
    expect(result).toEqual({ top: 940, left: 100 });
  });

  test("overflow on both axes -> flips both", () => {
    const result = placeContextMenu({ ...base, x: 990, y: 990 });
    expect(result).toEqual({ top: 940, left: 940 });
  });

  test("menu wider and taller than the viewport -> clamped to margin, never negative or NaN", () => {
    const result = placeContextMenu({
      x: 10,
      y: 10,
      width: 2000,
      height: 2000,
      viewportWidth: 800,
      viewportHeight: 600,
      margin: 8,
    });
    expect(result).toEqual({ top: 8, left: 8 });
    expect(Number.isNaN(result.top)).toBe(false);
    expect(Number.isNaN(result.left)).toBe(false);
    expect(result.top).toBeGreaterThanOrEqual(0);
    expect(result.left).toBeGreaterThanOrEqual(0);
  });

  test("custom margin is honored even when the naive placement 'fits'", () => {
    // x=5/y=5 is within the viewport and doesn't trigger the overflow flip,
    // but a 30px margin still pulls the panel in from the edge.
    const result = placeContextMenu({
      x: 5,
      y: 5,
      width: 50,
      height: 50,
      viewportWidth: 1000,
      viewportHeight: 1000,
      margin: 30,
    });
    expect(result).toEqual({ top: 30, left: 30 });
  });

  test("default margin is 8 when omitted", () => {
    const withoutMargin = placeContextMenu({
      x: 2,
      y: 2,
      width: 50,
      height: 50,
      viewportWidth: 1000,
      viewportHeight: 1000,
    });
    const withExplicitEight = placeContextMenu({
      x: 2,
      y: 2,
      width: 50,
      height: 50,
      viewportWidth: 1000,
      viewportHeight: 1000,
      margin: 8,
    });
    expect(withoutMargin).toEqual({ top: 8, left: 8 });
    expect(withoutMargin).toEqual(withExplicitEight);
  });
});

// --- moveMenuIndex ----------------------------------------------------------

describe("moveMenuIndex", () => {
  test("current -1, delta 1 -> lands on the first enabled item", () => {
    expect(moveMenuIndex(-1, 1, [true, true, true])).toBe(0);
  });

  test("current -1, delta 1 -> skips a disabled leading item to land on the first enabled one", () => {
    expect(moveMenuIndex(-1, 1, [false, false, true, true])).toBe(2);
  });

  test("current -1, delta -1 -> lands on the last enabled item", () => {
    expect(moveMenuIndex(-1, -1, [true, true, true])).toBe(2);
  });

  test("current -1, delta -1 -> skips a disabled trailing item to land on the last enabled one", () => {
    expect(moveMenuIndex(-1, -1, [true, true, false, false])).toBe(1);
  });

  test("wraps forward past the end to the first enabled item", () => {
    expect(moveMenuIndex(2, 1, [true, true, true])).toBe(0);
  });

  test("wraps backward past the start to the last enabled item", () => {
    expect(moveMenuIndex(0, -1, [true, true, true])).toBe(2);
  });

  test("skips consecutive disabled/separator indices moving forward", () => {
    // 0 enabled, 1+2 disabled (consecutive), 3 enabled.
    expect(moveMenuIndex(0, 1, [true, false, false, true])).toBe(3);
  });

  test("skips consecutive disabled/separator indices moving backward", () => {
    expect(moveMenuIndex(3, -1, [true, false, false, true])).toBe(0);
  });

  test("wraps around fully, skipping every other disabled index, back to the sole enabled item", () => {
    expect(moveMenuIndex(2, 1, [false, false, true])).toBe(2);
  });

  test("all disabled -> returns current unchanged", () => {
    expect(moveMenuIndex(1, 1, [false, false, false])).toBe(1);
    expect(moveMenuIndex(1, -1, [false, false, false])).toBe(1);
  });

  test("all disabled with current -1 -> returns -1 unchanged", () => {
    expect(moveMenuIndex(-1, 1, [false, false, false])).toBe(-1);
  });

  test("empty array -> returns current unchanged", () => {
    expect(moveMenuIndex(5, 1, [])).toBe(5);
    expect(moveMenuIndex(-1, -1, [])).toBe(-1);
  });
});

// --- keepsNativeContextMenu / NATIVE_CONTEXT_MENU_SELECTOR ------------------

/** Stub that duck-types the `closest(selector)` contract: it "matches" only
 *  when the selector string passed in contains `token`, mirroring how a real
 *  `Element.closest()` would match one clause of a comma-separated selector
 *  list against an ancestor of that type. */
function hostWithToken(token: string): EventTarget {
  return {
    closest: (selector: string) => (selector.includes(token) ? {} : null),
  } as unknown as EventTarget;
}

describe("keepsNativeContextMenu", () => {
  test("true for a textarea host", () => {
    expect(keepsNativeContextMenu(hostWithToken("textarea"))).toBe(true);
  });

  test("true for a text-input host", () => {
    expect(keepsNativeContextMenu(hostWithToken("input:not"))).toBe(true);
  });

  test("true for a contenteditable host", () => {
    expect(keepsNativeContextMenu(hostWithToken("[contenteditable]"))).toBe(true);
  });

  test("true for an .xterm host", () => {
    expect(keepsNativeContextMenu(hostWithToken(".xterm"))).toBe(true);
  });

  test("false for a card/body host (closest never matches)", () => {
    // Token deliberately absent from NATIVE_CONTEXT_MENU_SELECTOR.
    expect(keepsNativeContextMenu(hostWithToken("card"))).toBe(false);
    expect(keepsNativeContextMenu(hostWithToken("body"))).toBe(false);
  });

  test("false for null target", () => {
    expect(keepsNativeContextMenu(null)).toBe(false);
  });

  test("false for undefined target", () => {
    expect(keepsNativeContextMenu(undefined as unknown as EventTarget | null)).toBe(false);
  });

  test("false for an object with no closest method", () => {
    expect(keepsNativeContextMenu({} as unknown as EventTarget)).toBe(false);
  });
});

describe("NATIVE_CONTEXT_MENU_SELECTOR", () => {
  test("includes textarea", () => {
    expect(NATIVE_CONTEXT_MENU_SELECTOR).toContain("textarea");
  });

  test("includes .xterm", () => {
    expect(NATIVE_CONTEXT_MENU_SELECTOR).toContain(".xterm");
  });

  test('includes the contenteditable clause, excluding contenteditable="false"', () => {
    expect(NATIVE_CONTEXT_MENU_SELECTOR).toContain('[contenteditable]:not([contenteditable="false"])');
  });

  test("excludes checkbox/radio/button/submit/range/file input variants", () => {
    for (const type of ["button", "checkbox", "radio", "submit", "range", "file"]) {
      expect(NATIVE_CONTEXT_MENU_SELECTOR).toContain(`:not([type="${type}"])`);
    }
  });
});

describe("hasTextSelection", () => {
  test("null / undefined selection → false", () => {
    expect(hasTextSelection(null)).toBe(false);
    expect(hasTextSelection(undefined)).toBe(false);
  });

  test("a collapsed selection is not a selection, even if toString has text", () => {
    expect(hasTextSelection({ isCollapsed: true, toString: () => "abc" })).toBe(false);
  });

  test("non-collapsed but empty or whitespace-only → false", () => {
    expect(hasTextSelection({ isCollapsed: false, toString: () => "" })).toBe(false);
    expect(hasTextSelection({ isCollapsed: false, toString: () => "  \n\t " })).toBe(false);
  });

  test("non-collapsed with real text → true", () => {
    expect(hasTextSelection({ isCollapsed: false, toString: () => "Starting Phase 1" })).toBe(true);
    expect(hasTextSelection({ isCollapsed: false, toString: () => " x " })).toBe(true);
  });
});
