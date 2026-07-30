// Turn a user's diff-line selection into a message the agent can read. The
// dialog just tracks which row indices are checked; grouping those into
// contiguous per-file blocks and rendering them as backtick-safe fenced
// snippets involves enough range/label arithmetic to deserve its own
// unit-tested module rather than living inline in DiffDialog.tsx.

import type { DiffRow } from "./diff-rows";

export interface DiffSelectionBlock {
  path: string;
  lines: Pick<DiffRow, "old" | "neu" | "kind" | "text">[];
}

/** Heading used above the rendered diff-selection block, mirroring
 *  REFS_HEADING in shared/refs.ts. */
export const DIFF_SELECTION_HEADING = "Selected lines from the current diff:";

const SELECTABLE_KINDS = new Set<DiffRow["kind"]>(["ctx", "add", "del"]);

const KIND_PREFIX: Record<"ctx" | "add" | "del", string> = {
  ctx: " ",
  add: "+",
  del: "-",
};

/** Contiguous runs of selected, selectable rows for one file, in row order.
 *  Only kinds "ctx" | "add" | "del" are selectable; indices pointing at
 *  "hunk"/"meta" rows (or out of range) are ignored. A gap in selected
 *  indices — or an intervening non-selectable row between two selected
 *  indices — splits blocks. */
export function groupSelectedRows(path: string, rows: DiffRow[], selected: Set<number>): DiffSelectionBlock[] {
  const indices = [...selected]
    .filter((i) => i >= 0 && i < rows.length && SELECTABLE_KINDS.has(rows[i]!.kind))
    .sort((a, b) => a - b);

  const blocks: DiffSelectionBlock[] = [];
  let current: DiffSelectionBlock["lines"] = [];
  let prev = Number.NaN;
  for (const i of indices) {
    // A non-consecutive row index means either a gap in the selection or a
    // non-selectable (hunk/meta) row sat between the two selected rows —
    // either way the run breaks here.
    if (current.length && i !== prev + 1) {
      blocks.push({ path, lines: current });
      current = [];
    }
    const row = rows[i]!;
    current.push({ old: row.old, neu: row.neu, kind: row.kind, text: row.text });
    prev = i;
  }
  if (current.length) blocks.push({ path, lines: current });
  return blocks;
}

/** Longest run of backticks in `content`, so the wrapping fence can always
 *  be one backtick longer (min 3) and content can never fence-break out. */
function fenceFor(content: string): string {
  let longest = 0;
  const runs = content.match(/`+/g);
  if (runs) for (const run of runs) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

function labelFor(block: DiffSelectionBlock): string {
  const { path, lines } = block;
  if (lines.length === 1) {
    const line = lines[0]!;
    return `${path} (line ${line.neu ?? line.old})`;
  }

  // Range endpoints must come from the same numbering side, or a
  // deletion-first block (old-side start, new-side end) mislabels itself —
  // e.g. hunk "@@ -140,6 +100,6 @@", selecting del(old=140)…ctx(neu=101)
  // must not read "(lines 140–101)". Prefer new-side numbers, but derive
  // both endpoints only from lines that actually have one.
  const neuLines = lines.filter((l) => l.neu != null);
  if (neuLines.length) {
    const first = neuLines[0]!;
    const last = neuLines[neuLines.length - 1]!;
    return `${path} (lines ${first.neu}–${last.neu})`;
  }
  // No line in the block has a new-side number (a pure deletion run) — label
  // with old-side numbers instead so it isn't misread as new-side.
  const first = lines[0]!;
  const last = lines[lines.length - 1]!;
  return `${path} (old lines ${first.old}–${last.old})`;
}

/** DIFF_SELECTION_HEADING + one labeled fenced snippet per block:
 *    <path> (line N)          — single line
 *    <path> (lines A–B)       — range, new-side numbers from the lines that
 *                                have one (never mixed with an old-side
 *                                endpoint), when any line in the block has neu
 *    <path> (old lines A–B)   — deletion-only blocks (no neu anywhere)
 *  followed by a ```diff fence whose lines are re-prefixed by kind:
 *  "+" for add, "-" for del, " " for ctx. The fence must be longer than the
 *  longest backtick run in the content (min 3) so content can't break out.
 *  Returns "" for no blocks / all-empty blocks. */
export function formatDiffSelection(blocks: DiffSelectionBlock[]): string {
  const nonEmpty = blocks.filter((b) => b.lines.length > 0);
  if (!nonEmpty.length) return "";

  const sections = nonEmpty.map((block) => {
    const content = block.lines
      .map((l) => `${KIND_PREFIX[l.kind as "ctx" | "add" | "del"] ?? " "}${l.text}`)
      .join("\n");
    const fence = fenceFor(content);
    return `${labelFor(block)}\n${fence}diff\n${content}\n${fence}`;
  });

  return `${DIFF_SELECTION_HEADING}\n\n${sections.join("\n\n")}`;
}

/** `${text}\n\n${formatted}`; text-only when no blocks; formatted-only when
 *  text is blank — exactly the appendReferences contract in shared/refs.ts. */
export function composeDiffMessage(text: string, blocks: DiffSelectionBlock[]): string {
  const formatted = formatDiffSelection(blocks);
  if (!formatted) return text;
  if (!text) return formatted;
  return `${text}\n\n${formatted}`;
}

/** A pending or active drag-to-select gesture, anchored at the row that was
 *  mouse-downed. `currentIndex` tracks the row currently under the pointer
 *  (or the same-file clamp when the pointer strays outside the anchor file —
 *  see DiffDialog's clamp logic); both indices are into the anchor file's
 *  `toRows` output. `null` means no drag is in progress. */
export interface DiffDragRange {
  path: string;
  anchorIndex: number;
  currentIndex: number;
}

/** Inclusive index range between `a` and `b` (either order), filtered to rows
 *  whose kind is selectable ("ctx" | "add" | "del"). Shared by shift-click
 *  range extension and drag-to-select commit so both gestures walk identical
 *  logic. Out-of-range indices are naturally skipped since `rows[i]` is
 *  undefined there. */
export function selectableIndicesInRange(rows: DiffRow[], a: number, b: number): number[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const result: number[] = [];
  for (let i = lo; i <= hi; i++) {
    const kind = rows[i]?.kind;
    if (kind && SELECTABLE_KINDS.has(kind)) result.push(i);
  }
  return result;
}

/** Union the selectable rows in `[a, b]` (inclusive, either order) into
 *  `path`'s entry in `selected`. Immutable: returns a new Map, and — only
 *  when the touched path's set actually changes — a new Set for that path;
 *  `selected` and any of its Sets are never mutated in place. Mirrors the
 *  existing convention that an empty selection isn't represented as an
 *  empty Set: if the range contains no selectable rows and `path` had no
 *  prior entry, no entry is inserted for it. */
export function addRangeToSelection(
  selected: Map<string, Set<number>>,
  path: string,
  rows: DiffRow[],
  a: number,
  b: number,
): Map<string, Set<number>> {
  const indices = selectableIndicesInRange(rows, a, b);
  const next = new Map(selected);
  if (indices.length === 0) return next;
  const current = new Set(next.get(path) ?? []);
  for (const i of indices) current.add(i);
  next.set(path, current);
  return next;
}

/** Whether row `index` of `path` falls inside the (inclusive, direction-
 *  agnostic) bounds of an active/pending drag. `false` when there's no drag
 *  (`drag` is `null`) or the drag anchors a different file. Pure bounds
 *  check — callers are expected to have already filtered to selectable
 *  rows (mirroring how `isSelected` is only meaningful for selectable rows
 *  in DiffDialog's render). */
export function isRowInDragRange(drag: DiffDragRange | null, path: string, index: number): boolean {
  if (!drag || drag.path !== path) return false;
  const lo = Math.min(drag.anchorIndex, drag.currentIndex);
  const hi = Math.max(drag.anchorIndex, drag.currentIndex);
  return index >= lo && index <= hi;
}
