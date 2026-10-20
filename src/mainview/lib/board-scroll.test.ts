import { beforeEach, describe, expect, test } from "bun:test";
import {
  boardScrollOffsets,
  discardBoardDeparture,
  recordBoardDeparture,
  resetBoardScrollMemoryForTest,
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
