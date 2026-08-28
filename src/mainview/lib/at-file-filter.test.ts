import { test, expect } from "bun:test";
import {
  buildFileEntries,
  descendInto,
  filterFileEntries,
  fuzzyPathMatch,
  type FileEntry,
} from "./at-file-filter.ts";

// ── buildFileEntries ────────────────────────────────────────────────────────

test("buildFileEntries: empty input returns empty", () => {
  expect(buildFileEntries([])).toEqual([]);
});

test("buildFileEntries: root files (no slash) get no directory entries", () => {
  const entries = buildFileEntries(["package.json", "readme.md"]);
  expect(entries).toEqual([
    { path: "package.json", isDirectory: false },
    { path: "readme.md", isDirectory: false },
  ]);
});

test("buildFileEntries: nested directory prefixes are derived once each, not per file", () => {
  const entries = buildFileEntries(["src/bun/db.ts", "src/bun/agents.ts", "src/mainview/app.tsx"]);
  const dirs = entries.filter((e) => e.isDirectory).map((e) => e.path);
  // "src/" is implied by all three files but must appear exactly once.
  expect(dirs).toEqual(["src/", "src/bun/", "src/mainview/"]);
  const files = entries.filter((e) => !e.isDirectory).map((e) => e.path);
  expect(files.sort()).toEqual(["src/bun/agents.ts", "src/bun/db.ts", "src/mainview/app.tsx"]);
});

test("buildFileEntries: a directory sorts immediately before its own contents", () => {
  const entries = buildFileEntries(["readme.md", "src/bun/db.ts", "src/mainview/app.tsx"]);
  expect(entries.map((e) => e.path)).toEqual([
    "readme.md",
    "src/",
    "src/bun/",
    "src/bun/db.ts",
    "src/mainview/",
    "src/mainview/app.tsx",
  ]);
});

test("buildFileEntries: a file named like a directory prefix coexists with that directory", () => {
  // "src/bun" is a real file here (no extension); "src/bun/db.ts" separately
  // implies a directory entry "src/bun/". Both must appear, distinct.
  const entries = buildFileEntries(["src/bun", "src/bun/db.ts"]);
  expect(entries).toEqual([
    { path: "src/", isDirectory: true },
    { path: "src/bun", isDirectory: false },
    { path: "src/bun/", isDirectory: true },
    { path: "src/bun/db.ts", isDirectory: false },
  ]);
});

// ── fuzzyPathMatch: null cases, case-insensitivity, indices ────────────────

test("fuzzyPathMatch: every query char must appear in order — out-of-order fails", () => {
  // "abc" is not a subsequence of "acb" (no 'c' remains after matching 'b').
  expect(fuzzyPathMatch("abc", "acb")).toBeNull();
});

test("fuzzyPathMatch: missing char fails", () => {
  expect(fuzzyPathMatch("xyz", "abc")).toBeNull();
});

test("fuzzyPathMatch: query longer than path fails", () => {
  expect(fuzzyPathMatch("abcdef", "abc")).toBeNull();
});

test("fuzzyPathMatch: empty query matches trivially with score 0 and no indices", () => {
  expect(fuzzyPathMatch("", "anything.ts")).toEqual({ score: 0, indices: [] });
});

test("fuzzyPathMatch: case-insensitive in both directions", () => {
  expect(fuzzyPathMatch("DB", "db.ts")).not.toBeNull();
  expect(fuzzyPathMatch("db", "DB.TS")).not.toBeNull();
});

test("fuzzyPathMatch: indices point at the unique matching positions", () => {
  // Only one valid subsequence alignment exists for "abc" in "aXbXc".
  const match = fuzzyPathMatch("abc", "aXbXc");
  expect(match).not.toBeNull();
  expect(match!.indices).toEqual([0, 2, 4]);
});

test("fuzzyPathMatch: indices are positions in the original (not lowercased) path", () => {
  const match = fuzzyPathMatch("db", "DB.ts");
  expect(match).not.toBeNull();
  expect(match!.indices).toEqual([0, 1]);
});

test("fuzzyPathMatch: indices are dropped (not misaligned) when toLowerCase() changes the string's length", () => {
  // U+0130 (LATIN CAPITAL LETTER I WITH DOT ABOVE) lowercases to two UTF-16
  // code units ("i" + a combining dot above), so `path.toLowerCase()` is one
  // char longer than `path` itself. Mapping a lowerPath-relative index back
  // onto `path` in that case would point at the wrong character (or past
  // the end) — the match must still succeed, but with empty `indices`.
  const path = "İstanbul.md";
  expect(path.toLowerCase().length).not.toBe(path.length);
  const match = fuzzyPathMatch("ist", path);
  expect(match).not.toBeNull();
  expect(match!.score).toBeGreaterThan(0);
  expect(match!.indices).toEqual([]);
});

test("fuzzyPathMatch: a fully consecutive match scores higher than one with gaps", () => {
  const consecutive = fuzzyPathMatch("db", "db.ts")!;
  const gappy = fuzzyPathMatch("dt", "db.ts")!; // d...t, skips "b."
  expect(consecutive.score).toBeGreaterThan(gappy.score);
});

// ── ranking assertions from the spec ───────────────────────────────────────

test("ranking: exact basename match ranks first — 'db.ts' beats 'dbx/foo.ts'", () => {
  const entries = buildFileEntries(["db.ts", "dbx/foo.ts"]);
  const result = filterFileEntries(entries, "db.ts");
  expect(result[0]?.path).toBe("db.ts");
});

test("ranking: exact basename match ranks first — 'src/bun/db.ts' beats 'src/bun/db.test.ts'", () => {
  const entries = buildFileEntries(["src/bun/db.ts", "src/bun/db.test.ts"]);
  const result = filterFileEntries(entries, "db.ts");
  expect(result[0]?.path).toBe("src/bun/db.ts");
});

test("ranking: a '/'-anchored prefix match outranks a scattered subsequence", () => {
  const anchored = fuzzyPathMatch("src/bun/d", "src/bun/db.ts");
  const scattered = fuzzyPathMatch("s/b/d", "scripts/build/dist.ts");
  expect(anchored).not.toBeNull();
  expect(scattered).not.toBeNull();
  expect(anchored!.score).toBeGreaterThan(scattered!.score);
});

test("ranking: a scattered query can still find a nested path", () => {
  expect(fuzzyPathMatch("s/b/d", "src/bun/db.ts")).not.toBeNull();
});

// ── empty-query ordering ────────────────────────────────────────────────────

test("empty query: shallowest first, directories before files at the same depth", () => {
  const entries = buildFileEntries(["readme.md", "src/bun/db.ts", "src/mainview/app.tsx"]);
  const result = filterFileEntries(entries, "");
  // Depth is measured by ancestor-directory count, with a directory's own
  // trailing "/" stripped before counting — so "src/" (depth 0) ties with
  // "readme.md" (depth 0) and, per the directories-first tie-break, sorts
  // ahead of it, rather than reading as "one level deeper".
  expect(result.map((e) => e.path)).toEqual([
    "src/",
    "readme.md",
    "src/bun/",
    "src/mainview/",
    "src/bun/db.ts",
    "src/mainview/app.tsx",
  ]);
});

test("empty query (whitespace-only) behaves the same as truly empty", () => {
  const entries = buildFileEntries(["b.ts", "a.ts"]);
  expect(filterFileEntries(entries, "   ")).toEqual(filterFileEntries(entries, ""));
});

// ── limit ───────────────────────────────────────────────────────────────────

test("limit caps the empty-query listing", () => {
  const entries = buildFileEntries(["a.ts", "b.ts", "c.ts", "d.ts"]);
  expect(filterFileEntries(entries, "", 2)).toHaveLength(2);
});

test("limit caps fuzzy-filtered results, keeping the highest scores", () => {
  const entries = buildFileEntries(["foo1.ts", "foo2.ts", "foo3.ts", "bar.ts"]);
  const result = filterFileEntries(entries, "foo", 2);
  expect(result).toHaveLength(2);
  for (const e of result) expect(e.path.startsWith("foo")).toBe(true);
});

test("default limit is 50", () => {
  const files = Array.from({ length: 80 }, (_, i) => `file${i}.ts`);
  const entries = buildFileEntries(files);
  expect(filterFileEntries(entries, "file")).toHaveLength(50);
});

// ── trailing-slash (Tab-descend) query ──────────────────────────────────────

test("trailing-slash query lists that directory's direct children first, then deeper matches", () => {
  const entries = buildFileEntries([
    "src/bun/db.ts",
    "src/bun/agents.ts",
    "src/bun/nested/deep.ts",
    "src/mainview/app.tsx",
  ]);
  const result = filterFileEntries(entries, "src/bun/");
  const paths = result.map((e) => e.path);

  // Direct children of src/bun/: agents.ts, db.ts, nested/ (dir before files,
  // then listing order) — all must come before the deeper "nested/deep.ts"
  // and before the unrelated "src/mainview/app.tsx".
  const directChildIdx = {
    nested: paths.indexOf("src/bun/nested/"),
    agents: paths.indexOf("src/bun/agents.ts"),
    db: paths.indexOf("src/bun/db.ts"),
  };
  const deeperIdx = paths.indexOf("src/bun/nested/deep.ts");

  expect(Object.values(directChildIdx).every((i) => i !== -1)).toBe(true);
  expect(deeperIdx).toBeGreaterThan(Math.max(...Object.values(directChildIdx)));
  // The directory itself is not re-listed as a candidate.
  expect(paths).not.toContain("src/bun/");
});

test("trailing-slash query excludes unrelated entries that don't fuzzy-match at all", () => {
  const entries = buildFileEntries(["src/bun/db.ts", "docs/readme.md"]);
  const result = filterFileEntries(entries, "src/bun/");
  expect(result.map((e) => e.path)).not.toContain("docs/readme.md");
});

// ── descendInto ──────────────────────────────────────────────────────────────

test("descendInto: adds exactly one trailing slash", () => {
  expect(descendInto("src/bun")).toBe("src/bun/");
});

test("descendInto: collapses existing trailing slashes to exactly one", () => {
  expect(descendInto("src/bun//")).toBe("src/bun/");
  expect(descendInto("src/bun/")).toBe("src/bun/");
});

// ── performance ──────────────────────────────────────────────────────────────
//
// Exercises the two-stage ranking design documented at the top of
// at-file-filter.ts (cheap subsequence reject → cheap greedy score → cap to
// the top 300 → exact DP only on those). The fixture is built to give each
// query a large, realistic survivor set — not just a handful of entries that
// isSubsequence rejects outright — so the DP-on-300-finalists stage is
// actually exercised, not skipped:
//   - every path contains "database", so both "d" and "db" (a genuine
//     substring of "database", not just a scattered subsequence) match
//     essentially every one of the 20k+ entries;
//   - a fifth of paths sit under "src/bun/", so "src/bun/d" gets a large
//     (but not universal) survivor set anchored on a real directory prefix,
//     the same shape as the ranking tests above ("src/bun/db.ts").
function buildPerfFixture(): FileEntry[] {
  const dirs = ["src/bun", "src/mainview", "src/shared", "docs", "scripts"];
  const files: string[] = [];
  for (let i = 0; i < 20_000; i++) {
    const dir = dirs[i % dirs.length];
    files.push(`${dir}/module${i % 250}/database${i}.ts`);
  }
  return buildFileEntries(files);
}

function medianMs(fn: () => void, runs = 5): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

test("filters a 20k-entry listing within a tight per-keystroke budget", () => {
  const entries = buildPerfFixture();
  expect(entries.length).toBeGreaterThan(20_000);

  // Soft target from the design: median ≤ 15ms on a healthy machine. Not
  // asserted directly (CI/dev-machine load makes single-digit-ms timing
  // flaky) — only logged so a real regression is visible without failing
  // the suite on noise. The assertion below is the hard, skip-safe ceiling.
  const softTargetMs = 15;
  const hardCeilingMs = 60;

  for (const query of ["d", "db", "src/bun/d"]) {
    const elapsed = medianMs(() => {
      const result = filterFileEntries(entries, query, 50);
      expect(result.length).toBeLessThanOrEqual(50);
    });
    if (elapsed > softTargetMs) {
      console.warn(
        `filterFileEntries("${query}") median ${elapsed.toFixed(2)}ms exceeds the ${softTargetMs}ms soft target (still under the ${hardCeilingMs}ms hard ceiling)`,
      );
    }
    expect(elapsed).toBeLessThan(hardCeilingMs);
  }
});
