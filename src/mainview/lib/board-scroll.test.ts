import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  boardScrollOffsets,
  discardBoardDeparture,
  recordBoardDeparture,
  resetBoardScrollMemoryForTest,
  restoreBoardScroll,
  revealScrollDelta,
  saveBoardScroll,
  takeBoardDeparture,
  type ViewportRect,
} from "./board-scroll.ts";

beforeEach(() => resetBoardScrollMemoryForTest());

/** The board's client box in these tests: 1000 × 600 at (100, 50). */
const VIEW: ViewportRect = { left: 100, top: 50, right: 1100, bottom: 650 };

/** A 280 × 120 card (about a board card's size) with its top-left at (x, y). */
function card(x: number, y: number, w = 280, h = 120): ViewportRect {
  return { left: x, top: y, right: x + w, bottom: y + h };
}

describe("revealScrollDelta — leaves a card that is at least partly visible alone (D6)", () => {
  test("fully inside", () => {
    expect(revealScrollDelta(VIEW, card(200, 100))).toBeNull();
  });

  test("partly visible on the x axis", () => {
    expect(revealScrollDelta(VIEW, card(1000, 100))).toBeNull();
    expect(revealScrollDelta(VIEW, card(-100, 100))).toBeNull();
  });

  test("partly visible on the y axis", () => {
    expect(revealScrollDelta(VIEW, card(200, 600))).toBeNull();
    expect(revealScrollDelta(VIEW, card(200, -20))).toBeNull();
  });

  test("partly visible in a corner", () => {
    expect(revealScrollDelta(VIEW, card(1050, 600))).toBeNull();
  });
});

describe("revealScrollDelta — reveals an entirely hidden card by the minimum distance (D7)", () => {
  test("touching the view's right edge exactly counts as out of view", () => {
    expect(revealScrollDelta(VIEW, card(VIEW.right, 100))).toEqual({ dx: 280, dy: 0 });
  });

  test("touching the view's bottom edge exactly counts as out of view", () => {
    expect(revealScrollDelta(VIEW, card(200, VIEW.bottom))).toEqual({ dx: 0, dy: 120 });
  });

  test("entirely right: right edges become flush", () => {
    const target = card(1500, 100);
    expect(revealScrollDelta(VIEW, target)).toEqual({ dx: target.right - VIEW.right, dy: 0 });
  });

  test("entirely left: left edges become flush", () => {
    const target = card(-600, 100);
    expect(revealScrollDelta(VIEW, target)).toEqual({ dx: target.left - VIEW.left, dy: 0 });
  });

  test("entirely above: top edges become flush", () => {
    const target = card(200, -400);
    expect(revealScrollDelta(VIEW, target)).toEqual({ dx: 0, dy: target.top - VIEW.top });
  });

  test("entirely below: bottom edges become flush", () => {
    const target = card(200, 900);
    expect(revealScrollDelta(VIEW, target)).toEqual({ dx: 0, dy: target.bottom - VIEW.bottom });
  });

  test("diagonal: both axes move, each by its minimum", () => {
    const target = card(1400, 800);
    expect(revealScrollDelta(VIEW, target)).toEqual({
      dx: target.right - VIEW.right,
      dy: target.bottom - VIEW.bottom,
    });
  });

  test("out on x and partly out on y: y moves just enough to bring it fully in", () => {
    const target = card(1400, 600); // y spans 600..720, the view ends at 650
    expect(revealScrollDelta(VIEW, target)).toEqual({ dx: target.right - VIEW.right, dy: 70 });
  });

  test("out on x, already inside on y: y doesn't move", () => {
    const target = card(-500, 200);
    expect(revealScrollDelta(VIEW, target)).toEqual({ dx: target.left - VIEW.left, dy: 0 });
  });

  test("taller than the view and overlapping it on y: y doesn't move", () => {
    const target = card(1500, 0, 280, 800); // y spans 0..800 around the 50..650 view
    expect(revealScrollDelta(VIEW, target)).toEqual({ dx: target.right - VIEW.right, dy: 0 });
  });

  test("wider than the view and out on x: its start aligns with the view's start", () => {
    const right = card(1200, 100, 1500, 120);
    expect(revealScrollDelta(VIEW, right)).toEqual({ dx: right.left - VIEW.left, dy: 0 });
    const left = card(-2000, 100, 1500, 120);
    expect(revealScrollDelta(VIEW, left)).toEqual({ dx: left.left - VIEW.left, dy: 0 });
  });

  test("taller than the view and below it: its top aligns with the view's top", () => {
    const target = card(200, 700, 280, 900);
    expect(revealScrollDelta(VIEW, target)).toEqual({ dx: 0, dy: target.top - VIEW.top });
  });
});

describe("revealScrollDelta — degenerate targets", () => {
  test("a zero-width target is never revealed", () => {
    expect(revealScrollDelta(VIEW, card(1500, 100, 0, 120))).toBeNull();
  });

  test("a zero-height target is never revealed", () => {
    expect(revealScrollDelta(VIEW, card(1500, 100, 280, 0))).toBeNull();
  });

  test("a negative-size target is never revealed", () => {
    expect(revealScrollDelta(VIEW, { left: 1500, top: 100, right: 1400, bottom: 220 })).toBeNull();
  });
});

describe("board scroll memory", () => {
  test("offsets start at 0,0 and round-trip", () => {
    expect(boardScrollOffsets()).toEqual({ left: 0, top: 0 });
    saveBoardScroll(320, 480);
    expect(boardScrollOffsets()).toEqual({ left: 320, top: 480 });
    saveBoardScroll(10, 0);
    expect(boardScrollOffsets()).toEqual({ left: 10, top: 0 });
  });

  test("the returned offsets are a copy", () => {
    saveBoardScroll(5, 6);
    const read = boardScrollOffsets();
    read.left = 999;
    expect(boardScrollOffsets()).toEqual({ left: 5, top: 6 });
  });

  test("takeBoardDeparture returns the record once, then null", () => {
    expect(takeBoardDeparture()).toBeNull();
    recordBoardDeparture("task-a");
    expect(takeBoardDeparture()).toBe("task-a");
    expect(takeBoardDeparture()).toBeNull();
  });

  test("discardBoardDeparture clears the record", () => {
    recordBoardDeparture("task-a");
    discardBoardDeparture();
    expect(takeBoardDeparture()).toBeNull();
  });

  test("a second record overwrites the first", () => {
    recordBoardDeparture("task-a");
    recordBoardDeparture("task-b");
    expect(takeBoardDeparture()).toBe("task-b");
  });

  test("resetBoardScrollMemoryForTest clears offsets and the departure", () => {
    saveBoardScroll(1, 2);
    recordBoardDeparture("task-a");
    resetBoardScrollMemoryForTest();
    expect(boardScrollOffsets()).toEqual({ left: 0, top: 0 });
    expect(takeBoardDeparture()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// restoreBoardScroll — the DOM glue the board's callback ref calls on mount.
// There is no DOM under `bun test`, so it runs against a duck-typed scroller:
// scroll offsets clamp like a browser's, and each card's client rect follows
// the current scroll position.
// ---------------------------------------------------------------------------

interface FakeScrollerOptions {
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  /** Border width on every side (`clientLeft`/`clientTop`). */
  border?: number;
  /** Cards by task id, as rects in scroll-content coordinates. */
  cards?: Record<string, ViewportRect>;
}

/** The scroller's border box sits at (100, 50) in client coordinates. */
const BOX = { left: 100, top: 50 };

function fakeScroller(o: FakeScrollerOptions) {
  const border = o.border ?? 0;
  const maxLeft = o.scrollWidth - o.clientWidth;
  const maxTop = o.scrollHeight - o.clientHeight;
  let left = 0;
  let top = 0;
  const originX = BOX.left + border;
  const originY = BOX.top + border;
  const el = {
    get scrollLeft() { return left; },
    set scrollLeft(v: number) { left = Math.min(Math.max(v, 0), maxLeft); },
    get scrollTop() { return top; },
    set scrollTop(v: number) { top = Math.min(Math.max(v, 0), maxTop); },
    clientLeft: border,
    clientTop: border,
    clientWidth: o.clientWidth,
    clientHeight: o.clientHeight,
    getBoundingClientRect: () => ({
      left: BOX.left,
      top: BOX.top,
      right: BOX.left + 2 * border + o.clientWidth,
      bottom: BOX.top + 2 * border + o.clientHeight,
    }),
    querySelector(selector: string) {
      // Like a real CSS parser: an unescaped `"` ends the value, so the
      // selector is invalid (the browser throws a SyntaxError too).
      const m = /^\[data-task-id="((?:[^"\\]|\\.)*)"\]$/.exec(selector);
      if (!m) throw new Error(`invalid selector ${selector}`);
      const rect = o.cards?.[m[1]!.replace(/\\(.)/g, "$1")];
      if (!rect) return null;
      return {
        getBoundingClientRect: () => ({
          left: originX + rect.left - left,
          top: originY + rect.top - top,
          right: originX + rect.right - left,
          bottom: originY + rect.bottom - top,
        }),
      };
    },
  };
  return {
    el,
    restore: () => restoreBoardScroll(el as unknown as HTMLElement),
    offsets: () => ({ left: el.scrollLeft, top: el.scrollTop }),
    /** The card's rect in client coordinates, as the scroller shows it now. */
    cardRect: (id: string) => el.querySelector(`[data-task-id="${id}"]`)!.getBoundingClientRect(),
    /** The scroller's client box (the view a reveal measures against). */
    view: (): ViewportRect => ({
      left: originX,
      top: originY,
      right: originX + o.clientWidth,
      bottom: originY + o.clientHeight,
    }),
  };
}

/** A 1000 × 600 view onto a 3000 × 2000 board. */
const BOARD = { clientWidth: 1000, clientHeight: 600, scrollWidth: 3000, scrollHeight: 2000 };

describe("restoreBoardScroll", () => {
  const g = globalThis as { CSS?: { escape(s: string): string } };
  const originalCss = g.CSS;
  beforeAll(() => {
    // `bun test` has no CSS global; this covers what task ids can contain.
    g.CSS ??= { escape: (s: string) => s.replace(/["\\]/g, "\\$&") };
  });
  afterAll(() => {
    // Remove the shim outright when there was no global before, so later
    // files in the same bun process don't see an own `CSS: undefined`.
    if (originalCss === undefined) delete g.CSS;
    else g.CSS = originalCss;
  });

  test("writes the saved offsets onto a fresh scroller and keeps them", () => {
    saveBoardScroll(300, 200);
    const s = fakeScroller(BOARD);
    s.restore();
    expect(s.offsets()).toEqual({ left: 300, top: 200 });
    expect(boardScrollOffsets()).toEqual({ left: 300, top: 200 });
  });

  test("saves the offsets the browser clamped them to", () => {
    saveBoardScroll(5000, 5000);
    const s = fakeScroller(BOARD);
    s.restore();
    expect(s.offsets()).toEqual({ left: 2000, top: 1400 });
    expect(boardScrollOffsets()).toEqual({ left: 2000, top: 1400 });
  });

  test("reveals an entirely hidden departure card by the minimum distance, then forgets it", () => {
    recordBoardDeparture("p");
    const s = fakeScroller({ ...BOARD, cards: { p: card(1500, 100) } });
    s.restore();
    expect(s.offsets()).toEqual({ left: 780, top: 0 });
    expect(s.cardRect("p").right).toBe(s.view().right);
    expect(boardScrollOffsets()).toEqual({ left: 780, top: 0 });
    expect(takeBoardDeparture()).toBeNull();
  });

  test("leaves a partly visible departure card alone, and still forgets it", () => {
    saveBoardScroll(0, 40);
    recordBoardDeparture("p");
    const s = fakeScroller({ ...BOARD, cards: { p: card(900, 100) } });
    s.restore();
    expect(s.offsets()).toEqual({ left: 0, top: 40 });
    expect(takeBoardDeparture()).toBeNull();
  });

  test("a departure whose card isn't rendered is still forgotten, so a later return can't act on it", () => {
    recordBoardDeparture("p");
    fakeScroller(BOARD).restore();
    expect(boardScrollOffsets()).toEqual({ left: 0, top: 0 });

    const later = fakeScroller({ ...BOARD, cards: { p: card(1500, 100) } });
    later.restore();
    expect(later.offsets()).toEqual({ left: 0, top: 0 });
  });

  test("restores without moving when there is no departure, even if a card is off-screen", () => {
    saveBoardScroll(10, 20);
    const s = fakeScroller({ ...BOARD, cards: { p: card(1500, 900) } });
    s.restore();
    expect(s.offsets()).toEqual({ left: 10, top: 20 });
  });

  test("a second call on the same element keeps the revealed offsets (StrictMode's double ref call)", () => {
    recordBoardDeparture("p");
    const s = fakeScroller({ ...BOARD, cards: { p: card(1500, 100) } });
    s.restore();
    s.restore();
    expect(s.offsets()).toEqual({ left: 780, top: 0 });
    expect(boardScrollOffsets()).toEqual({ left: 780, top: 0 });
  });

  test("measures the view from the client box, inside the scroller's border", () => {
    saveBoardScroll(1000, 0);
    recordBoardDeparture("p");
    // Entirely left of and below the view at (1000, 0).
    const s = fakeScroller({ ...BOARD, border: 10, cards: { p: card(100, 700) } });
    s.restore();
    expect(s.offsets()).toEqual({ left: 100, top: 220 });
    const rect = s.cardRect("p");
    expect(rect.left).toBe(s.view().left);
    expect(rect.bottom).toBe(s.view().bottom);
  });

  test("finds a card whose id needs escaping in the selector", () => {
    recordBoardDeparture('odd"id');
    const s = fakeScroller({ ...BOARD, cards: { 'odd"id': card(1500, 100) } });
    s.restore();
    expect(s.offsets()).toEqual({ left: 780, top: 0 });
  });
});
