import { expect, test } from "bun:test";
import { shortenTaskPaths } from "./shorten-task-paths";

const WT = "/data/worktrees/abc123";
const WD = "/Users/me/projects/repo";

test("bare path under a root folds to the @ mention", () => {
  expect(shortenTaskPaths(`look at ${WT}/src/db.ts please`, [WT, WD]))
    .toBe("look at @src/db.ts please");
});

test("trailing sentence punctuation stays outside the mention", () => {
  expect(shortenTaskPaths(`see ${WT}/README.md.`, [WT])).toBe("see @README.md.");
  expect(shortenTaskPaths(`(${WT}/a.ts)`, [WT])).toBe(`(${WT}/a.ts)`); // no leading whitespace/BOF → untouched
  expect(shortenTaskPaths(`x ${WT}/a.ts),`, [WT])).toBe("x @a.ts),");
});

test("directories keep their trailing slash", () => {
  expect(shortenTaskPaths(`walk ${WT}/src/bun/ now`, [WT])).toBe("walk @src/bun/ now");
});

test("quoted spaced paths fold to the quoted mention", () => {
  expect(shortenTaskPaths(`read "${WT}/docs/my notes.md" twice`, [WT]))
    .toBe('read @"docs/my notes.md" twice');
});

test("refs-block bullets fold too (whitespace-anchored)", () => {
  expect(shortenTaskPaths(`Referenced files/folders:\n- ${WD}/src/app.ts`, [WT, WD]))
    .toBe("Referenced files/folders:\n- @src/app.ts");
});

test("paths under no listed root are untouched", () => {
  const other = "/tmp/elsewhere/file.ts";
  expect(shortenTaskPaths(`see ${other} and ${WT}/a.ts`, [WT])).toBe(`see ${other} and @a.ts`);
});

test("the bare root itself (no /rel) is untouched; sibling-prefix dirs never match", () => {
  expect(shortenTaskPaths(`in ${WT} here`, [WT])).toBe(`in ${WT} here`);
  expect(shortenTaskPaths(`in ${WT}2/x.ts here`, [WT])).toBe(`in ${WT}2/x.ts here`);
});

test("falsy roots are dropped; longest root wins on nesting", () => {
  expect(shortenTaskPaths(`${WD}/sub/x.ts`, [null, undefined, WD, `${WD}/sub`]))
    .toBe("@x.ts");
});

test("BOF-anchored path folds", () => {
  expect(shortenTaskPaths(`${WT}/a.ts first`, [WT])).toBe("@a.ts first");
});

test("no slash fast path returns the same string", () => {
  const s = "plain text";
  expect(shortenTaskPaths(s, [WT])).toBe(s);
});

test("code spans are never folded: fenced blocks, inline code, unterminated fences", () => {
  const fenced = "look:\n```\nError at " + WT + "/src/db.ts:3\n```\nand " + WT + "/src/db.ts";
  expect(shortenTaskPaths(fenced, [WT]))
    .toBe("look:\n```\nError at " + WT + "/src/db.ts:3\n```\nand @src/db.ts");
  expect(shortenTaskPaths("see `" + WT + "/a.ts` and " + WT + "/a.ts", [WT]))
    .toBe("see `" + WT + "/a.ts` and @a.ts");
  const unterminated = "log:\n```\ntrace " + WT + "/x.ts";
  expect(shortenTaskPaths(unterminated, [WT])).toBe(unterminated);
});
