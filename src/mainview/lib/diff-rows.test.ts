import { expect, test } from "bun:test";
import { toRows } from "./diff-rows.ts";

test("toRows resolves old/new line numbers from the hunk header", () => {
  const hunks = [
    "@@ -10,3 +10,4 @@ func()",
    " context a",
    "-removed b",
    "+added c",
    "+added d",
    " context e",
  ].join("\n");
  const rows = toRows(hunks);

  expect(rows.map((r) => r.kind)).toEqual(["hunk", "ctx", "del", "add", "add", "ctx"]);
  // Context line at header start: old 10 / new 10.
  expect(rows[1]).toMatchObject({ kind: "ctx", old: 10, neu: 10, text: "context a" });
  // Deleted line advances only the old counter (side LEFT uses `old`).
  expect(rows[2]).toMatchObject({ kind: "del", old: 11, neu: null, text: "removed b" });
  // Added lines advance only the new counter (side RIGHT uses `neu`).
  expect(rows[3]).toMatchObject({ kind: "add", old: null, neu: 11, text: "added c" });
  expect(rows[4]).toMatchObject({ kind: "add", old: null, neu: 12, text: "added d" });
  // Trailing context: old resumes at 12, new at 13.
  expect(rows[5]).toMatchObject({ kind: "ctx", old: 12, neu: 13, text: "context e" });
});

test("toRows keeps counters independent across multiple hunks", () => {
  const hunks = [
    "@@ -1,1 +1,1 @@",
    "-a",
    "+b",
    "@@ -50,1 +50,2 @@",
    " keep",
    "+new",
  ].join("\n");
  const rows = toRows(hunks);
  const secondHunk = rows.slice(3);
  expect(secondHunk[0]).toMatchObject({ kind: "hunk" });
  expect(secondHunk[1]).toMatchObject({ kind: "ctx", old: 50, neu: 50 });
  expect(secondHunk[2]).toMatchObject({ kind: "add", old: null, neu: 51 });
});

test("toRows treats the no-newline marker as meta and drops a trailing blank context line", () => {
  const hunks = [
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
    "\\ No newline at end of file",
    " ",
    "",
  ].join("\n");
  const rows = toRows(hunks);
  // The final empty context row is popped; the "\\ No newline" line is meta.
  expect(rows.some((r) => r.kind === "meta" && r.text.startsWith("\\"))).toBe(true);
  expect(rows[rows.length - 1]!.kind).not.toBe("meta");
  // A single-space context line survives as an empty-text context row.
  expect(rows.filter((r) => r.kind === "ctx").length).toBe(1);
});
