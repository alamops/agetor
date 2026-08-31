import { test, expect, mock, afterAll } from "bun:test";

/**
 * `warnUnresolvedRefs` writes through `./output.ts`'s `errln` — mocked here
 * (same idiom as `add.test.ts`/`logs.test.ts`) so the tests can assert on
 * what got printed instead of polluting the real test-runner stderr.
 */

import * as realOutput from "./output.ts";

const realOutputSnapshot = { ...realOutput };
const errLines: string[] = [];

mock.module("./output.ts", () => ({
  ...realOutputSnapshot,
  errln: (msg = "") => {
    errLines.push(msg);
  },
}));

afterAll(() => {
  mock.module("./output.ts", () => realOutputSnapshot);
});

const { filterUnresolvedRefs, unresolvedWarningLine, warnUnresolvedRefs } = await import("./at-warn.ts");

// ── filterUnresolvedRefs ─────────────────────────────────────────────────

test("filterUnresolvedRefs: no opts keeps every parseable raw token", () => {
  expect(filterUnresolvedRefs(["@a.md", "@b.md"])).toEqual(["@a.md", "@b.md"]);
});

test("filterUnresolvedRefs: drops a token whose path is a known extension name", () => {
  const kept = filterUnresolvedRefs(["@github", "@nope.md"], {
    extensionNames: new Set(["github"]),
  });
  expect(kept).toEqual(["@nope.md"]);
});

test("filterUnresolvedRefs: extension-name exemption is case-sensitive / exact-path, not fuzzy", () => {
  const kept = filterUnresolvedRefs(["@GitHub", "@github"], {
    extensionNames: new Set(["github"]),
  });
  expect(kept).toEqual(["@GitHub"]);
});

test("filterUnresolvedRefs: restrictTo keeps only tokens whose raw form also appears in restrictTo's text", () => {
  const kept = filterUnresolvedRefs(["@a.md", "@octocat", "@b.md"], {
    restrictTo: "please look at @a.md and @b.md, cc @octocat-elsewhere",
  });
  expect(kept).toEqual(["@a.md", "@b.md"]);
});

test("filterUnresolvedRefs: restrictTo of null applies no restriction at all", () => {
  const kept = filterUnresolvedRefs(["@a.md", "@octocat"], { restrictTo: null });
  expect(kept).toEqual(["@a.md", "@octocat"]);
});

test("filterUnresolvedRefs: restrictTo omitted applies no restriction (same as null)", () => {
  const kept = filterUnresolvedRefs(["@a.md", "@octocat"]);
  expect(kept).toEqual(["@a.md", "@octocat"]);
});

test("filterUnresolvedRefs: restrictTo of an empty string keeps nothing (no tokens to match against)", () => {
  const kept = filterUnresolvedRefs(["@a.md"], { restrictTo: "" });
  expect(kept).toEqual([]);
});

test("filterUnresolvedRefs: quoted raw tokens match restrictTo by their exact raw form, not just the inner path", () => {
  const kept = filterUnresolvedRefs([`@"docs/my notes.md"`], {
    restrictTo: `see @"docs/my notes.md" please`,
  });
  expect(kept).toEqual([`@"docs/my notes.md"`]);
});

test("filterUnresolvedRefs: a bare token doesn't match a differently-quoted occurrence in restrictTo", () => {
  const kept = filterUnresolvedRefs(["@a.md"], { restrictTo: `@"a.md"` });
  expect(kept).toEqual([]);
});

test("filterUnresolvedRefs: skips raw tokens findAtTokens can't parse back into a token", () => {
  const kept = filterUnresolvedRefs(["@", "not-a-token-at-all", "", "@ok.md"]);
  expect(kept).toEqual(["@ok.md"]);
});

test("filterUnresolvedRefs: extensionNames exemption applies even when restrictTo would otherwise keep it", () => {
  const kept = filterUnresolvedRefs(["@github"], {
    extensionNames: new Set(["github"]),
    restrictTo: "ping @github about this",
  });
  expect(kept).toEqual([]);
});

test("filterUnresolvedRefs: preserves input order and de-dupes nothing on its own", () => {
  const kept = filterUnresolvedRefs(["@b.md", "@a.md", "@b.md"]);
  expect(kept).toEqual(["@b.md", "@a.md", "@b.md"]);
});

// ── unresolvedWarningLine ─────────────────────────────────────────────────

test("unresolvedWarningLine: empty list is null", () => {
  expect(unresolvedWarningLine([])).toBeNull();
});

test("unresolvedWarningLine: singular copy for exactly one token", () => {
  expect(unresolvedWarningLine(["@nope.md"])).toBe(
    "@nope.md won't resolve to a project file — sent as plain text",
  );
});

test("unresolvedWarningLine: two tokens use plural copy, listing both, no 'and N more'", () => {
  expect(unresolvedWarningLine(["@a", "@b"])).toBe(
    "2 @ references won't resolve to project files — sent as plain text: @a, @b",
  );
});

test("unresolvedWarningLine: exactly three tokens are all listed with no 'and N more'", () => {
  expect(unresolvedWarningLine(["@a", "@b", "@c"])).toBe(
    "3 @ references won't resolve to project files — sent as plain text: @a, @b, @c",
  );
});

test("unresolvedWarningLine: more than three tokens caps the list at three plus 'and N more'", () => {
  expect(unresolvedWarningLine(["@a", "@b", "@c", "@d", "@e"])).toBe(
    "5 @ references won't resolve to project files — sent as plain text: @a, @b, @c, and 2 more",
  );
});

// ── warnUnresolvedRefs ────────────────────────────────────────────────────

test("warnUnresolvedRefs: no-op on an empty list", () => {
  errLines.length = 0;
  warnUnresolvedRefs([]);
  expect(errLines).toEqual([]);
});

test("warnUnresolvedRefs: prints one yellow-prefixed line for a non-empty list", () => {
  errLines.length = 0;
  warnUnresolvedRefs(["@nope.md"]);
  expect(errLines.length).toBe(1);
  expect(errLines[0]).toBe("! @nope.md won't resolve to a project file — sent as plain text");
});
