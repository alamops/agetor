import { describe, expect, test } from "bun:test";
import {
  BOARD_KEYBOARD_CODES,
  BOARD_SCREEN_READER_INSTRUCTIONS,
  boardKeyboardCoordinates,
  handleCardKeyDown,
  makeBoardAnnouncements,
  nextColumnX,
} from "./board-keyboard.ts";

const COLS = [
  { id: "backlog", left: 0, width: 288 },
  { id: "ready", left: 300, width: 288 },
  { id: "review", left: 600, width: 288 },
];
// Centre-aligning a 240 px card over a 288 px column: left + 144 − 120.
const centred = (c: { left: number; width: number }) => c.left + c.width / 2 - 120;

describe("nextColumnX", () => {
  test("ArrowRight and ArrowLeft move to the neighbouring column's centre", () => {
    expect(nextColumnX("ArrowRight", COLS, "backlog", 240)).toBe(centred(COLS[1]!));
    expect(nextColumnX("ArrowLeft", COLS, "review", 240)).toBe(centred(COLS[1]!));
  });

  test("the ends do nothing", () => {
    expect(nextColumnX("ArrowLeft", COLS, "backlog", 240)).toBeNull();
    expect(nextColumnX("ArrowRight", COLS, "review", 240)).toBeNull();
  });

  test("up and down do nothing", () => {
    expect(nextColumnX("ArrowUp", COLS, "ready", 240)).toBeNull();
    expect(nextColumnX("ArrowDown", COLS, "ready", 240)).toBeNull();
  });

  test("unsorted input still resolves by left", () => {
    const shuffled = [COLS[2]!, COLS[0]!, COLS[1]!];
    expect(nextColumnX("ArrowRight", shuffled, "backlog", 240)).toBe(centred(COLS[1]!));
  });

  test("no current column steps to the nearest end", () => {
    expect(nextColumnX("ArrowRight", COLS, null, 240)).toBe(centred(COLS[0]!));
    expect(nextColumnX("ArrowLeft", COLS, null, 240)).toBe(centred(COLS[2]!));
  });

  test("no columns: nothing", () => {
    expect(nextColumnX("ArrowRight", [], null, 240)).toBeNull();
  });
});

// A stub of dnd-kit's SensorContext carrying only what the getter reads.
function stubContext(over: { id: string } | null, collisionLeft = 10) {
  const rects = new Map(COLS.map((c) => [c.id, { left: c.left, width: c.width }]));
  return {
    droppableContainers: { getEnabled: () => COLS.map((c) => ({ id: c.id })) },
    droppableRects: { get: (id: string) => rects.get(id) },
    collisionRect: { left: collisionLeft, width: 240 },
    draggingNodeRect: { width: 240 },
    over,
  } as never;
}
const key = (code: string) => {
  let prevented = false;
  return { event: { code, preventDefault: () => { prevented = true; } } as unknown as KeyboardEvent, prevented: () => prevented };
};

describe("boardKeyboardCoordinates", () => {
  test("ArrowRight returns the next column's x and keeps y", () => {
    const k = key("ArrowRight");
    const out = boardKeyboardCoordinates(k.event, {
      active: "t1",
      currentCoordinates: { x: 10, y: 77 },
      context: stubContext({ id: "backlog" }),
    });
    expect(out).toEqual({ x: centred(COLS[1]!), y: 77 });
    expect(k.prevented()).toBe(true);
  });

  test("with no `over`, the column under the card's centre is current", () => {
    const k = key("ArrowRight");
    const out = boardKeyboardCoordinates(k.event, {
      active: "t1",
      currentCoordinates: { x: 10, y: 0 },
      context: stubContext(null, 10),
    });
    expect(out).toEqual({ x: centred(COLS[1]!), y: 0 });
  });

  test("an arrow at the end returns undefined", () => {
    const out = boardKeyboardCoordinates(key("ArrowLeft").event, {
      active: "t1",
      currentCoordinates: { x: 10, y: 0 },
      context: stubContext({ id: "backlog" }),
    });
    expect(out).toBeUndefined();
  });

  test("up/down are swallowed so the page does not scroll under the card", () => {
    const k = key("ArrowDown");
    const out = boardKeyboardCoordinates(k.event, { active: "t1", currentCoordinates: { x: 0, y: 0 }, context: stubContext(null) });
    expect(out).toBeUndefined();
    expect(k.prevented()).toBe(true);
  });
});

describe("keyboard codes", () => {
  test("Space starts and drops, Escape and Tab cancel, Enter is not a drag key", () => {
    expect(BOARD_KEYBOARD_CODES.start).toEqual(["Space"]);
    expect(BOARD_KEYBOARD_CODES.end).toEqual(["Space"]);
    expect(BOARD_KEYBOARD_CODES.cancel).toEqual(["Escape", "Tab"]);
    expect(BOARD_KEYBOARD_CODES.end).not.toContain("Enter");
  });

  test("instructions mention every key", () => {
    for (const w of ["Space", "arrow", "Escape", "Enter"]) expect(BOARD_SCREEN_READER_INSTRUCTIONS).toContain(w);
  });
});

describe("makeBoardAnnouncements", () => {
  const ann = makeBoardAnnouncements(
    (id) => (id === "uuid-1" ? "Fix login" : ""),
    (id) => ({ ready: "Ready", review: "Review" })[id] ?? "",
  );
  const active = { id: "uuid-1" } as never;

  test("name the task and the column, never the id", () => {
    expect(ann.onDragStart({ active })).toBe("Picked up Fix login.");
    expect(ann.onDragOver({ active, over: { id: "ready" } as never })).toBe("Fix login is over Ready.");
    expect(ann.onDragEnd({ active, over: { id: "review" } as never })).toBe("Fix login was dropped in Review.");
    expect(ann.onDragCancel({ active, over: null })).toBe("Moving Fix login was cancelled.");
    for (const m of [ann.onDragStart({ active }), ann.onDragOver({ active, over: { id: "ready" } as never })]) {
      expect(m).not.toContain("uuid-1");
    }
  });

  test("an unknown id falls back to wording that is not the id", () => {
    expect(ann.onDragStart({ active: { id: "uuid-9" } as never })).toBe("Picked up task.");
    expect(ann.onDragEnd({ active, over: { id: "nope" } as never })).toBe("Fix login was dropped in a column.");
  });

  test("dropped outside any column", () => {
    expect(ann.onDragEnd({ active, over: null })).toBe("Fix login was dropped.");
    expect(ann.onDragOver({ active, over: null })).toBe("Fix login is not over a column.");
  });
});

describe("handleCardKeyDown", () => {
  const card = {};
  const button = {};
  const ev = (key: string, target: object) => {
    let prevented = false;
    return { e: { key, target, currentTarget: card, preventDefault: () => { prevented = true; } }, prevented: () => prevented };
  };

  test("Enter on the card opens it once and never reaches dnd-kit", () => {
    let opened = 0;
    let drag = 0;
    const k = ev("Enter", card);
    expect(handleCardKeyDown(k.e, () => { opened++; }, () => { drag++; })).toBe(true);
    expect([opened, drag, k.prevented()]).toEqual([1, 0, true]);
  });

  test("Enter while the card is held in a keyboard drag does not open it", () => {
    let opened = 0;
    let drag = 0;
    const k = ev("Enter", card);
    expect(handleCardKeyDown(k.e, () => { opened++; }, () => { drag++; }, true)).toBe(false);
    expect([opened, drag, k.prevented()]).toEqual([0, 1, false]);
  });

  test("Enter on a nested button does not open the card", () => {
    let opened = 0;
    let drag = 0;
    expect(handleCardKeyDown(ev("Enter", button).e, () => { opened++; }, () => { drag++; })).toBe(false);
    expect([opened, drag]).toEqual([0, 1]);
  });

  test("Space goes to dnd-kit (which only starts a drag from the card itself)", () => {
    let drag = 0;
    handleCardKeyDown(ev(" ", button).e, () => {}, () => { drag++; });
    expect(drag).toBe(1);
  });
});
