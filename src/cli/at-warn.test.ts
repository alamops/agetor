import { test, expect, mock, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgetorClient } from "./api-client.ts";

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

const {
  filterUnresolvedRefs,
  unresolvedWarningLine,
  warnUnresolvedRefs,
  isSafeClientRelPath,
  existsInLiveScope,
  discoveredExtensionNames,
} = await import("./at-warn.ts");

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

// ── isSafeClientRelPath ──────────────────────────────────────────────────

test("isSafeClientRelPath: rejects empty string", () => {
  expect(isSafeClientRelPath("")).toBe(false);
});

test("isSafeClientRelPath: rejects a leading slash (absolute path)", () => {
  expect(isSafeClientRelPath("/etc/passwd")).toBe(false);
});

test("isSafeClientRelPath: rejects a NUL byte", () => {
  expect(isSafeClientRelPath("foo\0bar")).toBe(false);
});

test("isSafeClientRelPath: rejects a bare '..' segment", () => {
  expect(isSafeClientRelPath("..")).toBe(false);
  expect(isSafeClientRelPath("../secrets.env")).toBe(false);
  expect(isSafeClientRelPath("a/../../b")).toBe(false);
});

test("isSafeClientRelPath: accepts an ordinary repo-relative path", () => {
  expect(isSafeClientRelPath("src/bun/db.ts")).toBe(true);
  expect(isSafeClientRelPath(".env")).toBe(true);
});

// ── existsInLiveScope ─────────────────────────────────────────────────────

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "at-warn-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("existsInLiveScope: true for a gitignored-but-present file on disk", () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, ".env"), "SECRET=1");
    expect(existsInLiveScope(dir, ".env")).toBe(true);
  });
});

test("existsInLiveScope: false for a path that doesn't exist", () => {
  withTempDir((dir) => {
    expect(existsInLiveScope(dir, "nope.txt")).toBe(false);
  });
});

test("existsInLiveScope: strips a trailing slash before checking a directory", () => {
  withTempDir((dir) => {
    mkdirSync(path.join(dir, "sub"));
    expect(existsInLiveScope(dir, "sub/")).toBe(true);
  });
});

test("existsInLiveScope: false for an unsafe path even if something exists there", () => {
  withTempDir((dir) => {
    // The parent of `dir` definitely exists, but `../` must never be
    // "rescued" by a stat outside the project.
    expect(existsInLiveScope(dir, "../")).toBe(false);
    expect(existsInLiveScope(dir, "../etc/passwd")).toBe(false);
  });
});

test("existsInLiveScope: false for an empty path", () => {
  withTempDir((dir) => {
    expect(existsInLiveScope(dir, "")).toBe(false);
  });
});

// ── discoveredExtensionNames ──────────────────────────────────────────────

function fakeTask(): { agent: string; workdir: string; branch: string | null } {
  return { agent: "claude-code", workdir: "/tmp/whatever", branch: null };
}

test("discoveredExtensionNames: maps `@`-prefixed inserts by stripping the leading `@`, others by name", async () => {
  const client = {
    agentDiscovery: async () => ({
      commands: [],
      extensions: [
        { name: "github-ext", insert: "@github" },
        { name: "plain-name", insert: "plain-name" },
      ],
    }),
  } as unknown as AgetorClient;

  const names = await discoveredExtensionNames(client, fakeTask());
  expect(names).toEqual(new Set(["github", "plain-name"]));
});

test("discoveredExtensionNames: a discovery failure fails open to an empty set", async () => {
  const client = {
    agentDiscovery: async () => {
      throw new Error("network down");
    },
  } as unknown as AgetorClient;

  const names = await discoveredExtensionNames(client, fakeTask());
  expect(names).toEqual(new Set());
});

test("discoveredExtensionNames: passes agent/workdir/branch through to agentDiscovery verbatim", async () => {
  const calls: Array<[string, string, string | null]> = [];
  const client = {
    agentDiscovery: async (agent: string, workdir: string, branch: string | null) => {
      calls.push([agent, workdir, branch]);
      return { commands: [], extensions: [] };
    },
  } as unknown as AgetorClient;

  await discoveredExtensionNames(client, { agent: "codex", workdir: "/x", branch: "feature/y" });
  expect(calls).toEqual([["codex", "/x", "feature/y"]]);
});
