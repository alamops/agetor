import { expect, test } from "bun:test";
import type { DiffRow } from "./diff-rows.ts";
import {
  DIFF_SELECTION_HEADING,
  addRangeToSelection,
  composeDiffMessage,
  formatDiffSelection,
  groupSelectedRows,
  isRowInDragRange,
  selectableIndicesInRange,
  type DiffDragRange,
  type DiffSelectionBlock,
} from "./diff-selection.ts";

function rows(...specs: [DiffRow["kind"], number | null, number | null, string][]): DiffRow[] {
  return specs.map(([kind, old, neu, text]) => ({ kind, old, neu, text }));
}

// --- groupSelectedRows -------------------------------------------------

test("groupSelectedRows collects a single contiguous run", () => {
  const r = rows(
    ["hunk", null, null, "@@ -1,3 +1,3 @@"],
    ["ctx", 1, 1, "a"],
    ["del", 2, null, "b"],
    ["add", null, 2, "c"],
    ["ctx", 3, 3, "d"],
  );
  const blocks = groupSelectedRows("f.ts", r, new Set([1, 2, 3]));
  expect(blocks).toHaveLength(1);
  expect(blocks[0]!.path).toBe("f.ts");
  expect(blocks[0]!.lines.map((l) => l.text)).toEqual(["a", "b", "c"]);
});

test("groupSelectedRows splits on a gap in selected indices", () => {
  const r = rows(
    ["ctx", 1, 1, "a"],
    ["ctx", 2, 2, "b"],
    ["ctx", 3, 3, "c"],
    ["ctx", 4, 4, "d"],
  );
  // rows 0 and 3 selected, 1 and 2 are not — a gap, even though both
  // endpoints are individually selectable.
  const blocks = groupSelectedRows("f.ts", r, new Set([0, 3]));
  expect(blocks).toHaveLength(2);
  expect(blocks[0]!.lines.map((l) => l.text)).toEqual(["a"]);
  expect(blocks[1]!.lines.map((l) => l.text)).toEqual(["d"]);
});

test("groupSelectedRows splits when an intervening hunk row sits between two selected rows", () => {
  const r = rows(
    ["ctx", 1, 1, "a"],
    ["hunk", null, null, "@@ -5,1 +5,1 @@"],
    ["ctx", 5, 5, "b"],
  );
  const blocks = groupSelectedRows("f.ts", r, new Set([0, 2]));
  expect(blocks).toHaveLength(2);
  expect(blocks[0]!.lines.map((l) => l.text)).toEqual(["a"]);
  expect(blocks[1]!.lines.map((l) => l.text)).toEqual(["b"]);
});

test("groupSelectedRows ignores hunk/meta rows and out-of-range indices even when selected", () => {
  const r = rows(
    ["hunk", null, null, "@@ -1,2 +1,2 @@"],
    ["ctx", 1, 1, "a"],
    ["meta", null, null, "\\ No newline at end of file"],
  );
  const blocks = groupSelectedRows("f.ts", r, new Set([0, 1, 2, 99, -1]));
  expect(blocks).toHaveLength(1);
  expect(blocks[0]!.lines.map((l) => l.text)).toEqual(["a"]);
});

test("groupSelectedRows returns multiple blocks in row order", () => {
  const r = rows(
    ["add", null, 1, "x"],
    ["ctx", 1, 2, "y"],
    ["hunk", null, null, "@@ -10,1 +10,1 @@"],
    ["del", 10, null, "z"],
  );
  const blocks = groupSelectedRows("f.ts", r, new Set([3, 0, 1]));
  expect(blocks).toHaveLength(2);
  expect(blocks[0]!.lines.map((l) => l.text)).toEqual(["x", "y"]);
  expect(blocks[1]!.lines.map((l) => l.text)).toEqual(["z"]);
});

test("groupSelectedRows returns no blocks for an empty selection", () => {
  const r = rows(["ctx", 1, 1, "a"]);
  expect(groupSelectedRows("f.ts", r, new Set())).toEqual([]);
});

// --- formatDiffSelection: labels ---------------------------------------

test("formatDiffSelection labels a single selected line singular, using the new-side number", () => {
  const blocks: DiffSelectionBlock[] = [{ path: "src/a.ts", lines: [{ old: 4, neu: 5, kind: "ctx", text: "hi" }] }];
  const out = formatDiffSelection(blocks);
  expect(out).toContain("src/a.ts (line 5)");
  expect(out).not.toContain("lines 5");
});

test("formatDiffSelection labels a single deleted line by its old number (no neu)", () => {
  const blocks: DiffSelectionBlock[] = [{ path: "src/a.ts", lines: [{ old: 9, neu: null, kind: "del", text: "gone" }] }];
  const out = formatDiffSelection(blocks);
  expect(out).toContain("src/a.ts (line 9)");
});

test("formatDiffSelection labels a mixed range with new-side numbers, plural, en-dash", () => {
  const blocks: DiffSelectionBlock[] = [
    {
      path: "src/b.ts",
      lines: [
        { old: 1, neu: 1, kind: "ctx", text: "a" },
        { old: 2, neu: null, kind: "del", text: "b" },
        { old: null, neu: 2, kind: "add", text: "c" },
        { old: 3, neu: 3, kind: "ctx", text: "d" },
      ],
    },
  ];
  const out = formatDiffSelection(blocks);
  // First line's neu (1) to last line's neu (3), joined with an en-dash.
  expect(out).toContain("src/b.ts (lines 1–3)");
});

test("formatDiffSelection labels a deletion-only block with old-side numbers", () => {
  const blocks: DiffSelectionBlock[] = [
    {
      path: "src/c.ts",
      lines: [
        { old: 10, neu: null, kind: "del", text: "x" },
        { old: 11, neu: null, kind: "del", text: "y" },
        { old: 12, neu: null, kind: "del", text: "z" },
      ],
    },
  ];
  const out = formatDiffSelection(blocks);
  expect(out).toContain("src/c.ts (old lines 10–12)");
  expect(out).not.toContain("(lines 10");
});

test("formatDiffSelection labels a deletion-first block using only new-side numbers, not the old-side start", () => {
  // Mirrors hunk "@@ -140,6 +100,6 @@": selecting a run that starts with
  // deleted lines (old-side numbering) and continues into added/context
  // lines (new-side numbering) must not mix the two sides — e.g. old=140
  // paired with neu=101 must never render as "(lines 140–101)".
  const blocks: DiffSelectionBlock[] = [
    {
      path: "src/d.ts",
      lines: [
        { old: 140, neu: null, kind: "del", text: "removed one" },
        { old: 141, neu: null, kind: "del", text: "removed two" },
        { old: 142, neu: 100, kind: "ctx", text: "shared" },
        { old: null, neu: 101, kind: "add", text: "added" },
      ],
    },
  ];
  const out = formatDiffSelection(blocks);
  expect(out).toContain("src/d.ts (lines 100–101)");
  expect(out).not.toContain("140");
});

// --- formatDiffSelection: fence safety + re-prefixing -------------------

test("formatDiffSelection re-prefixes lines by kind and uses a plain ```diff fence by default", () => {
  const blocks: DiffSelectionBlock[] = [
    {
      path: "f.ts",
      lines: [
        { old: 1, neu: 1, kind: "ctx", text: "context" },
        { old: 2, neu: null, kind: "del", text: "removed" },
        { old: null, neu: 2, kind: "add", text: "added" },
      ],
    },
  ];
  const out = formatDiffSelection(blocks);
  expect(out).toContain("```diff");
  expect(out).toContain(" context");
  expect(out).toContain("-removed");
  expect(out).toContain("+added");
});

test("formatDiffSelection widens the fence past a backtick run in the content", () => {
  const blocks: DiffSelectionBlock[] = [
    {
      path: "f.md",
      lines: [{ old: 1, neu: 1, kind: "ctx", text: "some ```code``` here" }],
    },
  ];
  const out = formatDiffSelection(blocks);
  // Content contains a run of 3 backticks, so the fence must be 4+.
  expect(out).toContain("````diff");
  const fenceCount = (out.match(/````/g) ?? []).length;
  expect(fenceCount).toBe(2); // opening + closing
});

test("formatDiffSelection returns empty string for no blocks", () => {
  expect(formatDiffSelection([])).toBe("");
});

test("formatDiffSelection returns empty string when every block has no lines", () => {
  const blocks: DiffSelectionBlock[] = [
    { path: "f.ts", lines: [] },
    { path: "g.ts", lines: [] },
  ];
  expect(formatDiffSelection(blocks)).toBe("");
});

test("formatDiffSelection includes the heading and separates multiple blocks", () => {
  const blocks: DiffSelectionBlock[] = [
    { path: "a.ts", lines: [{ old: 1, neu: 1, kind: "ctx", text: "one" }] },
    { path: "b.ts", lines: [{ old: 2, neu: 2, kind: "ctx", text: "two" }] },
  ];
  const out = formatDiffSelection(blocks);
  expect(out.startsWith(DIFF_SELECTION_HEADING)).toBe(true);
  expect(out).toContain("a.ts (line 1)");
  expect(out).toContain("b.ts (line 2)");
});

// --- composeDiffMessage --------------------------------------------------

test("composeDiffMessage returns the raw text when there are no blocks", () => {
  expect(composeDiffMessage("just a message", [])).toBe("just a message");
});

test("composeDiffMessage returns only the formatted block when text is blank", () => {
  const blocks: DiffSelectionBlock[] = [{ path: "f.ts", lines: [{ old: 1, neu: 1, kind: "ctx", text: "hi" }] }];
  const out = composeDiffMessage("", blocks);
  expect(out).toBe(formatDiffSelection(blocks));
  expect(out.startsWith(DIFF_SELECTION_HEADING)).toBe(true);
});

test("composeDiffMessage joins text and formatted block with a blank line", () => {
  const blocks: DiffSelectionBlock[] = [{ path: "f.ts", lines: [{ old: 1, neu: 1, kind: "ctx", text: "hi" }] }];
  const out = composeDiffMessage("look at this", blocks);
  expect(out).toBe(`look at this\n\n${formatDiffSelection(blocks)}`);
});

// --- selectableIndicesInRange -------------------------------------------

test("selectableIndicesInRange keeps ctx/add/del and skips hunk/meta rows within the range", () => {
  const r = rows(
    ["hunk", null, null, "@@ -1,3 +1,3 @@"],
    ["ctx", 1, 1, "a"],
    ["del", 2, null, "b"],
    ["add", null, 2, "c"],
    ["meta", null, null, "\\ No newline at end of file"],
    ["ctx", 3, 3, "d"],
  );
  expect(selectableIndicesInRange(r, 0, 5)).toEqual([1, 2, 3, 5]);
});

test("selectableIndicesInRange normalizes reversed bounds (a > b) to the same result", () => {
  const r = rows(["ctx", 1, 1, "a"], ["del", 2, null, "b"], ["add", null, 2, "c"]);
  expect(selectableIndicesInRange(r, 2, 0)).toEqual(selectableIndicesInRange(r, 0, 2));
  expect(selectableIndicesInRange(r, 2, 0)).toEqual([0, 1, 2]);
});

test("selectableIndicesInRange with a === b returns a single index for a selectable row", () => {
  const r = rows(["ctx", 1, 1, "a"]);
  expect(selectableIndicesInRange(r, 0, 0)).toEqual([0]);
});

test("selectableIndicesInRange with a === b returns [] for a non-selectable row", () => {
  const r = rows(["hunk", null, null, "@@ -1,1 +1,1 @@"]);
  expect(selectableIndicesInRange(r, 0, 0)).toEqual([]);
});

test("selectableIndicesInRange returns [] when the whole range is non-selectable rows", () => {
  const r = rows(
    ["hunk", null, null, "@@ -1,2 +1,2 @@"],
    ["meta", null, null, "\\ No newline at end of file"],
  );
  expect(selectableIndicesInRange(r, 0, 1)).toEqual([]);
});

test("selectableIndicesInRange handles bounds at the array edges", () => {
  const r = rows(["ctx", 1, 1, "a"], ["del", 2, null, "b"], ["add", null, 2, "c"]);
  expect(selectableIndicesInRange(r, 0, 2)).toEqual([0, 1, 2]);
});

test("selectableIndicesInRange skips out-of-range indices past the array end", () => {
  const r = rows(["ctx", 1, 1, "a"], ["ctx", 2, 2, "b"]);
  expect(selectableIndicesInRange(r, 0, 5)).toEqual([0, 1]);
});

// --- addRangeToSelection --------------------------------------------------

test("addRangeToSelection unions into an existing set for the path, preserving pre-selected indices", () => {
  const r = rows(["ctx", 1, 1, "a"], ["del", 2, null, "b"], ["add", null, 2, "c"]);
  const selected = new Map([["f.ts", new Set([0])]]);
  const next = addRangeToSelection(selected, "f.ts", r, 1, 2);
  expect([...next.get("f.ts")!].sort()).toEqual([0, 1, 2]);
});

test("addRangeToSelection creates the set when the path is absent", () => {
  const r = rows(["ctx", 1, 1, "a"], ["del", 2, null, "b"]);
  const next = addRangeToSelection(new Map(), "f.ts", r, 0, 1);
  expect([...next.get("f.ts")!].sort()).toEqual([0, 1]);
});

test("addRangeToSelection does not insert an empty set when the range has zero selectable rows on an absent path", () => {
  const r = rows(["hunk", null, null, "@@ -1,1 +1,1 @@"], ["meta", null, null, "\\ No newline at end of file"]);
  const next = addRangeToSelection(new Map(), "f.ts", r, 0, 1);
  expect(next.has("f.ts")).toBe(false);
});

test("addRangeToSelection does not mutate the input Map or its Sets, and returns a new Map", () => {
  const r = rows(["ctx", 1, 1, "a"], ["del", 2, null, "b"]);
  const originalSet = new Set([0]);
  const selected = new Map([["f.ts", originalSet]]);
  const next = addRangeToSelection(selected, "f.ts", r, 0, 1);

  expect(next).not.toBe(selected);
  expect(selected.get("f.ts")).toBe(originalSet);
  expect([...originalSet]).toEqual([0]);
  expect(next.get("f.ts")).not.toBe(originalSet);
  expect([...next.get("f.ts")!].sort()).toEqual([0, 1]);
});

test("addRangeToSelection carries over other paths' sets unchanged", () => {
  const r = rows(["ctx", 1, 1, "a"], ["del", 2, null, "b"]);
  const otherSet = new Set([5]);
  const selected = new Map([["other.ts", otherSet]]);
  const next = addRangeToSelection(selected, "f.ts", r, 0, 1);

  expect(next.get("other.ts")).toBe(otherSet);
  expect([...next.get("f.ts")!].sort()).toEqual([0, 1]);
});

// --- isRowInDragRange ------------------------------------------------------

test("isRowInDragRange returns false when there is no drag", () => {
  expect(isRowInDragRange(null, "f.ts", 0)).toBe(false);
});

test("isRowInDragRange returns false when the drag anchors a different file", () => {
  const drag: DiffDragRange = { path: "other.ts", anchorIndex: 0, currentIndex: 5 };
  expect(isRowInDragRange(drag, "f.ts", 2)).toBe(false);
});

test("isRowInDragRange is inclusive at both bounds", () => {
  const drag: DiffDragRange = { path: "f.ts", anchorIndex: 2, currentIndex: 5 };
  expect(isRowInDragRange(drag, "f.ts", 2)).toBe(true);
  expect(isRowInDragRange(drag, "f.ts", 5)).toBe(true);
  expect(isRowInDragRange(drag, "f.ts", 3)).toBe(true);
});

test("isRowInDragRange is inclusive when anchor/current are reversed (currentIndex < anchorIndex)", () => {
  const drag: DiffDragRange = { path: "f.ts", anchorIndex: 5, currentIndex: 2 };
  expect(isRowInDragRange(drag, "f.ts", 2)).toBe(true);
  expect(isRowInDragRange(drag, "f.ts", 5)).toBe(true);
  expect(isRowInDragRange(drag, "f.ts", 3)).toBe(true);
});

test("isRowInDragRange returns false for an index just outside either bound", () => {
  const drag: DiffDragRange = { path: "f.ts", anchorIndex: 2, currentIndex: 5 };
  expect(isRowInDragRange(drag, "f.ts", 1)).toBe(false);
  expect(isRowInDragRange(drag, "f.ts", 6)).toBe(false);
});
