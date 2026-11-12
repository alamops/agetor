import { test, expect, mock, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgetorClient } from "./api-client.ts";
import type { Task } from "../shared/types.ts";

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
  unresolvedRefsForTask,
  verifyTokensViaSearch,
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

type ScopeTask = Pick<
  Task,
  "agent" | "workdir" | "worktreePath" | "isolation" | "baseRef" | "branchSource" | "branch"
> & { repositories?: Task["repositories"]; multiRepo?: boolean };

/** Defaults to a plain, non-isolated task (no worktree, no ref) — the
 *  simplest scope — with per-test overrides for the fields that drive
 *  `fileScopeForTask`/`discoveryParamsForTask` (`src/shared/file-scope.ts`). */
function fakeTask(overrides: Partial<ScopeTask> = {}): ScopeTask {
  return {
    agent: "claude-code",
    workdir: "/tmp/whatever",
    worktreePath: null,
    isolation: "none",
    baseRef: null,
    branchSource: "created",
    branch: null,
    ...overrides,
  };
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

test("discoveredExtensionNames: passes the task's agent through to agentDiscovery verbatim", async () => {
  const calls: Array<[string, string, string | null]> = [];
  const client = {
    agentDiscovery: async (agent: string, workdir: string, branch: string | null) => {
      calls.push([agent, workdir, branch]);
      return { commands: [], extensions: [] };
    },
  } as unknown as AgetorClient;

  await discoveredExtensionNames(client, fakeTask({ agent: "codex", workdir: "/x" }));
  expect(calls).toEqual([["codex", "/x", null]]);
});

// Review S3: the workspace root is not a git repository, so one discovery call
// there found nothing from any selected repository. A multi task unions every
// repository's own scope; a failed scope must not discard the others.
function multiRepoTask(): ScopeTask {
  const entry = (path: string, name: string) => ({
    path,
    name,
    branch: "feature/auth",
    branchSource: "created" as const,
    worktreePath: `/wt/t1/${name}`,
    baseRef: "abc123",
    checkoutBranch: "feature/auth",
    prUrl: null,
  });
  return fakeTask({
    workdir: "/wt/t1",
    worktreePath: "/wt/t1",
    isolation: "worktree",
    repositories: [entry("/src/frontend", "frontend"), entry("/src/backend", "backend")],
  });
}

test("discoveredExtensionNames: unions every repository's extensions, never the workspace root", async () => {
  const calls: Array<[string, string, string | null]> = [];
  const client = {
    agentDiscovery: async (agent: string, workdir: string, branch: string | null) => {
      calls.push([agent, workdir, branch]);
      return {
        commands: [],
        extensions: workdir.endsWith("frontend")
          ? [{ name: "front-ext", insert: "@front" }]
          : [{ name: "back-ext", insert: "back" }],
      };
    },
  } as unknown as AgetorClient;

  const names = await discoveredExtensionNames(client, multiRepoTask());
  expect(calls).toEqual([
    ["claude-code", "/wt/t1/frontend", null],
    ["claude-code", "/wt/t1/backend", null],
  ]);
  expect(names).toEqual(new Set(["front", "back-ext"]));
});

test("discoveredExtensionNames: a failed repository scope keeps the others' extensions", async () => {
  const client = {
    agentDiscovery: async (_agent: string, workdir: string) => {
      if (workdir.endsWith("frontend")) throw new Error("boom");
      return { commands: [], extensions: [{ name: "back-ext", insert: "@back" }] };
    },
  } as unknown as AgetorClient;

  expect(await discoveredExtensionNames(client, multiRepoTask())).toEqual(new Set(["back"]));
});

// `discoveredExtensionNames` derives `agentDiscovery`'s workdir/branch args via
// `discoveryParamsForTask` (`src/shared/file-scope.ts`), NOT the task's raw
// `workdir`/`branch` fields — this is the fix for the defect where
// `agetor send`/`start`/`add --start` and the TUI warned on the wrong tree
// for a materialized worktree (reading the agetor branch's committed tree in
// the source repo instead of the live worktree) or a not-yet-started
// isolated task (reading `task.branch`, which is only set once a worktree
// materializes, instead of the pinned `baseRef`). These four cases mirror
// `at-complete.test.ts`'s `fileScopeForTask` coverage, one per scope shape.
test("discoveredExtensionNames: a materialized worktree reads the live worktree, no ref", async () => {
  const calls: Array<[string, string, string | null]> = [];
  const client = {
    agentDiscovery: async (agent: string, workdir: string, branch: string | null) => {
      calls.push([agent, workdir, branch]);
      return { commands: [], extensions: [] };
    },
  } as unknown as AgetorClient;

  await discoveredExtensionNames(
    client,
    fakeTask({
      workdir: "/repo",
      worktreePath: "/worktrees/t1",
      isolation: "worktree",
      baseRef: "main",
      branch: "agetor/t1-slug",
    }),
  );
  expect(calls).toEqual([["claude-code", "/worktrees/t1", null]]);
});

test("discoveredExtensionNames: an isolated task with no worktree yet reads workdir @ baseRef", async () => {
  const calls: Array<[string, string, string | null]> = [];
  const client = {
    agentDiscovery: async (agent: string, workdir: string, branch: string | null) => {
      calls.push([agent, workdir, branch]);
      return { commands: [], extensions: [] };
    },
  } as unknown as AgetorClient;

  await discoveredExtensionNames(
    client,
    fakeTask({ workdir: "/repo", worktreePath: null, isolation: "worktree", baseRef: "main" }),
  );
  expect(calls).toEqual([["claude-code", "/repo", "main"]]);
});

test("discoveredExtensionNames: an existing-branch task (e.g. a PR head) reads workdir @ branch, not baseRef", async () => {
  const calls: Array<[string, string, string | null]> = [];
  const client = {
    agentDiscovery: async (agent: string, workdir: string, branch: string | null) => {
      calls.push([agent, workdir, branch]);
      return { commands: [], extensions: [] };
    },
  } as unknown as AgetorClient;

  await discoveredExtensionNames(
    client,
    fakeTask({
      workdir: "/repo",
      worktreePath: null,
      isolation: "worktree",
      branchSource: "existing",
      branch: "pr-123",
      baseRef: "main",
    }),
  );
  expect(calls).toEqual([["claude-code", "/repo", "pr-123"]]);
});

test("discoveredExtensionNames: isolation none reads the plain workdir, no ref", async () => {
  const calls: Array<[string, string, string | null]> = [];
  const client = {
    agentDiscovery: async (agent: string, workdir: string, branch: string | null) => {
      calls.push([agent, workdir, branch]);
      return { commands: [], extensions: [] };
    },
  } as unknown as AgetorClient;

  await discoveredExtensionNames(
    client,
    fakeTask({ workdir: "/repo", worktreePath: null, isolation: "none", baseRef: "main", branch: "agetor/old" }),
  );
  expect(calls).toEqual([["claude-code", "/repo", null]]);
});

// ── verifyTokensViaSearch ─────────────────────────────────────────────────

test("verifyTokensViaSearch: a token the search finds is proven listed — not returned as missing", async () => {
  const calls: Array<{ q?: string | null; limit?: number }> = [];
  const client = {
    listProjectFiles: async (scope: { dir: string; ref?: string | null; q?: string | null; limit?: number }) => {
      calls.push({ q: scope.q, limit: scope.limit });
      return { files: ["src/bun/db.ts"], truncated: true };
    },
  } as unknown as AgetorClient;

  const tokens = [{ raw: "@src/bun/db.ts", path: "src/bun/db.ts", isDirectory: false }];
  const missing = await verifyTokensViaSearch(client, { dir: "/repo" }, tokens);
  expect(missing).toEqual([]);
  expect(calls).toEqual([{ q: "src/bun/db.ts", limit: 20 }]);
});

test("verifyTokensViaSearch: a token absent from the search result is returned as missing", async () => {
  const client = {
    listProjectFiles: async () => ({ files: [], truncated: true }),
  } as unknown as AgetorClient;

  const tokens = [{ raw: "@nope.md", path: "nope.md", isDirectory: false }];
  const missing = await verifyTokensViaSearch(client, { dir: "/repo" }, tokens);
  expect(missing).toEqual(tokens);
});

test("verifyTokensViaSearch: a throwing search request leaves that token unproven — never reported missing", async () => {
  const client = {
    listProjectFiles: async () => {
      throw new Error("network down");
    },
  } as unknown as AgetorClient;

  const tokens = [{ raw: "@nope.md", path: "nope.md", isDirectory: false }];
  const missing = await verifyTokensViaSearch(client, { dir: "/repo" }, tokens);
  expect(missing).toEqual([]);
});

test("verifyTokensViaSearch: caps at 8 candidates — a 9th token is never searched", async () => {
  const queried: string[] = [];
  const client = {
    listProjectFiles: async (scope: { q?: string | null }) => {
      queried.push(scope.q ?? "");
      return { files: [], truncated: true };
    },
  } as unknown as AgetorClient;

  const tokens = Array.from({ length: 9 }, (_, i) => ({
    raw: `@f${i}.md`,
    path: `f${i}.md`,
    isDirectory: false,
  }));
  const missing = await verifyTokensViaSearch(client, { dir: "/repo" }, tokens);
  expect(queried.length).toBe(8);
  expect(missing.length).toBe(8);
  expect(missing.some((t) => t.path === "f8.md")).toBe(false);
});

// ── unresolvedRefsForTask (issue #291 review S4) ─────────────────────────
//
// `agetor add --repo ...` without `--start` used to derive ONE scope from
// `fileScopeForTask`, which for a multi task is the non-git workspace root —
// the listing came back empty and the whole advisory pre-check was silently
// skipped. These tests pin the multi-scope union (and the unchanged
// single-scope contract).

function singleRepoTask(overrides: Partial<ScopeTask> = {}): ScopeTask {
  return fakeTask({
    workdir: "/wt/t1",
    worktreePath: "/wt/t1",
    isolation: "worktree",
    baseRef: "main",
    ...overrides,
  });
}

test("unresolvedRefsForTask: single repository warns only on paths missing from a complete listing", async () => {
  const client = {
    listProjectFiles: async () => ({ files: ["src/a.ts"], truncated: false }),
    agentDiscovery: async () => ({ commands: [], extensions: [] }),
  } as unknown as AgetorClient;

  expect(await unresolvedRefsForTask(client, singleRepoTask(), "look at @src/a.ts and @missing.ts")).toEqual([
    "@missing.ts",
  ]);
});

test("unresolvedRefsForTask: multi lists every repository, never the workspace root", async () => {
  const dirs: string[] = [];
  const client = {
    listProjectFiles: async (scope: { dir: string }) => {
      dirs.push(scope.dir);
      return scope.dir.endsWith("frontend")
        ? { files: ["src/a.ts"], truncated: false }
        : { files: ["src/b.ts"], truncated: false };
    },
    agentDiscovery: async () => ({ commands: [], extensions: [] }),
  } as unknown as AgetorClient;

  const warned = await unresolvedRefsForTask(
    client,
    multiRepoTask(),
    "@frontend/src/a.ts @backend/src/b.ts @src/a.ts @frontend/nope.ts",
  );
  expect(warned).toEqual(["@src/a.ts", "@frontend/nope.ts"]);
  expect(dirs.sort()).toEqual(["/wt/t1/backend", "/wt/t1/frontend"]);
});

test("unresolvedRefsForTask: a repository's own root resolves (`@frontend`, `@frontend/`)", async () => {
  const client = {
    listProjectFiles: async (scope: { dir: string }) => (
      scope.dir.endsWith("frontend")
        ? { files: ["src/a.ts"], truncated: false }
        : // An empty listing still proves nothing about tokens, but the
          // repository root itself is a real directory at the workspace root.
          { files: [], truncated: false }
    ),
    agentDiscovery: async () => ({ commands: [], extensions: [] }),
  } as unknown as AgetorClient;

  expect(
    await unresolvedRefsForTask(
      client,
      multiRepoTask(),
      "read @frontend, @frontend/ and @backend/ plus @frontend/src/a.ts",
    ),
  ).toEqual([]);
});

test("unresolvedRefsForTask: repeated tokens spend the verification budget once", async () => {
  const searches: string[] = [];
  const client = {
    listProjectFiles: async (scope: { dir: string; q?: string | null }) => {
      if (scope.q) {
        searches.push(scope.q);
        return { files: [], truncated: true };
      }
      return scope.dir.endsWith("frontend")
        ? { files: ["src/known.ts"], truncated: true }
        : { files: ["src/b.ts"], truncated: false };
    },
    agentDiscovery: async () => ({ commands: [], extensions: [] }),
  } as unknown as AgetorClient;

  const repeated = Array.from({ length: 9 }, () => "@frontend/missing.ts").join(" ");
  const warned = await unresolvedRefsForTask(
    client,
    multiRepoTask(),
    `${repeated} @frontend/other.ts`,
  );
  // Deduped before the 8-candidate budget, so `other.ts` is still verified —
  // and the warning names each distinct reference once.
  expect(searches.sort()).toEqual(["missing.ts", "other.ts"]);
  expect(warned.sort()).toEqual(["@frontend/missing.ts", "@frontend/other.ts"]);
});

test("unresolvedRefsForTask: a truncated repository verifies its own repo-local path", async () => {
  const searches: Array<{ dir: string; q?: string | null }> = [];
  const client = {
    listProjectFiles: async (scope: { dir: string; q?: string | null }) => {
      if (scope.q) {
        searches.push({ dir: scope.dir, q: scope.q });
        return { files: ["src/maybe.ts"], truncated: true };
      }
      return scope.dir.endsWith("frontend")
        ? { files: ["src/known.ts"], truncated: true }
        : { files: ["src/b.ts"], truncated: false };
    },
    agentDiscovery: async () => ({ commands: [], extensions: [] }),
  } as unknown as AgetorClient;

  const warned = await unresolvedRefsForTask(
    client,
    multiRepoTask(),
    "@frontend/src/known.ts @frontend/src/maybe.ts @backend/nope.ts @loose.ts",
  );
  // `maybe` is found by the full-depth search, so it is NOT proven missing;
  // the complete backend listing proves `nope`, and an unprefixed workspace
  // path can never resolve at the multi root.
  expect(warned).toEqual(["@backend/nope.ts", "@loose.ts"]);
  expect(searches).toEqual([{ dir: "/wt/t1/frontend", q: "src/maybe.ts" }]);
});

test("unresolvedRefsForTask: empty listings cannot prove a token unresolved", async () => {
  let discoveryCalls = 0;
  const client = {
    listProjectFiles: async () => ({ files: [], truncated: false }),
    agentDiscovery: async () => {
      discoveryCalls++;
      return { commands: [], extensions: [] };
    },
  } as unknown as AgetorClient;

  expect(await unresolvedRefsForTask(client, multiRepoTask(), "@loose.ts")).toEqual([]);
  expect(discoveryCalls).toBe(0);
});

test("unresolvedRefsForTask: extension mentions and restrictTo filter the final warnings", async () => {
  const client = {
    listProjectFiles: async () => ({ files: ["src/a.ts"], truncated: false }),
    agentDiscovery: async () => ({ commands: [], extensions: [{ name: "github", insert: "@github" }] }),
  } as unknown as AgetorClient;

  const warned = await unresolvedRefsForTask(
    client,
    singleRepoTask(),
    "ping @github about @nope.md and @other.md",
    { restrictTo: "ping @github about @nope.md" },
  );
  expect(warned).toEqual(["@nope.md"]);
});

test("unresolvedRefsForTask: a listed directory ('src/') resolves like a file", async () => {
  const client = {
    listProjectFiles: async () => ({ files: ["src/a.ts"], truncated: false }),
    agentDiscovery: async () => ({ commands: [], extensions: [] }),
  } as unknown as AgetorClient;

  expect(await unresolvedRefsForTask(client, singleRepoTask(), "look in @src/ please")).toEqual([]);
});

test("unresolvedRefsForTask: a multi task left with one repository still needs the `<name>/` prefix (round 15)", async () => {
  const dirs: string[] = [];
  const searches: string[] = [];
  const client = {
    listProjectFiles: async (scope: { dir: string; q?: string | null }) => {
      if (scope.q) {
        searches.push(scope.q);
        return { files: ["src/deep.ts"], truncated: true };
      }
      dirs.push(scope.dir);
      return { files: ["src/b.ts"], truncated: true };
    },
    agentDiscovery: async () => ({ commands: [], extensions: [] }),
  } as unknown as AgetorClient;
  const task = fakeTask({
    workdir: "/wt/t1",
    worktreePath: "/wt/t1",
    isolation: "worktree",
    multiRepo: true,
    repositories: [{
      path: "/src/backend",
      name: "backend",
      branch: "feature/auth",
      branchSource: "created",
      worktreePath: "/wt/t1/backend",
      baseRef: "abc123",
      checkoutBranch: "feature/auth",
      prUrl: null,
    }],
  });
  // The agent's cwd is the workspace root: only `backend/…` resolves there,
  // and a truncated listing verifies the repo-local path (prefix stripped).
  expect(await unresolvedRefsForTask(client, task, "@backend/src/b.ts @backend/src/deep.ts @src/b.ts")).toEqual([
    "@src/b.ts",
  ]);
  expect(dirs).toEqual(["/wt/t1/backend"]);
  expect(searches).toEqual(["src/deep.ts"]);
});
