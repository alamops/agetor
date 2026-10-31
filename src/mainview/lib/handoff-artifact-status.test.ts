import { describe, expect, test } from "bun:test";
import { classifyHandoffArtifact, type HandoffArtifact, type HandoffArtifactContext } from "./handoff-artifacts.ts";
import {
  artifactCandidatePaths,
  artifactOpenOrder,
  artifactPrimaryPath,
  artifactStatsKey,
  createArtifactStatsCache,
  pathArtifactStatus,
  type ArtifactPathStat,
} from "./handoff-artifact-status.ts";
import { expandDetailOf } from "./expand-on-jump.ts";

const ctx: HandoffArtifactContext = { roots: ["/wt/task", "/src/repo"], homeDir: "/home/u" };

function pathOf(entry: string, c: HandoffArtifactContext = ctx): Extract<HandoffArtifact, { kind: "path" }> {
  const a = classifyHandoffArtifact(entry, c);
  if (a.kind !== "path") throw new Error(`expected a path artifact for ${entry}`);
  return a;
}

function stats(entries: Record<string, ArtifactPathStat>): ReadonlyMap<string, ArtifactPathStat> {
  return new Map(Object.entries(entries));
}

describe("artifactCandidatePaths / artifactStatsKey", () => {
  test("collects unique sorted absolute candidates of path artifacts only", () => {
    const list = [
      classifyHandoffArtifact("docs/b.md", ctx),
      classifyHandoffArtifact("https://example.invalid/x", ctx),
      classifyHandoffArtifact("commit 1234abc on main", ctx),
      classifyHandoffArtifact("/abs/a.txt", ctx),
      classifyHandoffArtifact("docs/b.md (again)", ctx),
    ];
    expect(artifactCandidatePaths(list)).toEqual(["/abs/a.txt", "/src/repo/docs/b.md", "/wt/task/docs/b.md"]);
  });

  test("a relative path with no roots contributes nothing", () => {
    expect(artifactCandidatePaths([classifyHandoffArtifact("docs/b.md", { roots: [], homeDir: null })])).toEqual([]);
  });

  test("key is order-independent and de-duplicated; empty for nothing", () => {
    expect(artifactStatsKey(["/b", "/a", "/b"])).toBe("/a\n/b");
    expect(artifactStatsKey(["/a", "/b"])).toBe(artifactStatsKey(["/b", "/a"]));
    expect(artifactStatsKey([])).toBe("");
    expect(artifactStatsKey(["relative"])).toBe("");
  });
});

describe("pathArtifactStatus", () => {
  const a = pathOf("docs/b.md");

  test("unknown stats are never missing", () => {
    expect(pathArtifactStatus(a, null)).toEqual({ missing: false, isDirectory: false, confirmed: null });
  });

  test("missing only when every candidate is stat'ed and absent", () => {
    const none = stats({
      "/wt/task/docs/b.md": { exists: false, isDirectory: false },
      "/src/repo/docs/b.md": { exists: false, isDirectory: false },
    });
    expect(pathArtifactStatus(a, none).missing).toBe(true);
    const partial = stats({ "/wt/task/docs/b.md": { exists: false, isDirectory: false } });
    expect(pathArtifactStatus(a, partial).missing).toBe(false);
  });

  test("the first existing candidate is confirmed, falling back to a later root", () => {
    const s = stats({
      "/wt/task/docs/b.md": { exists: false, isDirectory: false },
      "/src/repo/docs/b.md": { exists: true, isDirectory: true },
    });
    expect(pathArtifactStatus(a, s)).toEqual({ missing: false, isDirectory: true, confirmed: "/src/repo/docs/b.md" });
  });

  test("no absolute candidate → never missing", () => {
    const rel = pathOf("docs/b.md", { roots: [], homeDir: null });
    expect(pathArtifactStatus(rel, stats({})).missing).toBe(false);
  });
});

describe("artifactOpenOrder / artifactPrimaryPath", () => {
  const a = pathOf("docs/b.md:12");

  test("unknown stats try the candidates in root order", () => {
    expect(artifactOpenOrder(a, null)).toEqual(["/wt/task/docs/b.md", "/src/repo/docs/b.md"]);
    expect(artifactPrimaryPath(a, null)).toBe("/wt/task/docs/b.md");
  });

  test("a confirmed candidate goes first", () => {
    const s = stats({
      "/wt/task/docs/b.md": { exists: false, isDirectory: false },
      "/src/repo/docs/b.md": { exists: true, isDirectory: false },
    });
    expect(artifactOpenOrder(a, s)).toEqual(["/src/repo/docs/b.md", "/wt/task/docs/b.md"]);
    expect(artifactPrimaryPath(a, s)).toBe("/src/repo/docs/b.md");
  });

  test("no candidates fall back to the display path (resolved server-side)", () => {
    const rel = pathOf("docs/b.md", { roots: [], homeDir: null });
    expect(artifactOpenOrder(rel, null)).toEqual(["docs/b.md"]);
    expect(artifactPrimaryPath(rel, null)).toBe("docs/b.md");
  });
});

describe("createArtifactStatsCache", () => {
  test("maps the server's existing paths and marks the rest missing", async () => {
    const cache = createArtifactStatsCache(async () => [{ path: "/a", isDirectory: true }]);
    const v = await cache.load("/a\n/b", ["/a", "/b"]);
    expect(v.get("/a")).toEqual({ exists: true, isDirectory: true });
    expect(v.get("/b")).toEqual({ exists: false, isDirectory: false });
    expect(cache.peek("/a\n/b")).toBe(v);
  });

  test("de-duplicates concurrent loads of one key", async () => {
    let calls = 0;
    const cache = createArtifactStatsCache(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return [];
    });
    const [x, y] = await Promise.all([cache.load("/a", ["/a"]), cache.load("/a", ["/a"])]);
    expect(calls).toBe(1);
    expect(x).toBe(y);
    await cache.load("/a", ["/a"]);
    expect(calls).toBe(1);
  });

  test("entries expire after the TTL", async () => {
    let t = 0;
    let calls = 0;
    const cache = createArtifactStatsCache(
      async () => {
        calls++;
        return [];
      },
      { ttlMs: 100, now: () => t },
    );
    await cache.load("/a", ["/a"]);
    t = 50;
    expect(cache.peek("/a")).toBeDefined();
    t = 151;
    expect(cache.peek("/a")).toBeUndefined();
    await cache.load("/a", ["/a"]);
    expect(calls).toBe(2);
  });

  test("a failure is not cached and the next load retries", async () => {
    let calls = 0;
    const cache = createArtifactStatsCache(async () => {
      calls++;
      if (calls === 1) throw new Error("offline");
      return [{ path: "/a", isDirectory: false }];
    });
    await expect(cache.load("/a", ["/a"])).rejects.toThrow("offline");
    expect(cache.peek("/a")).toBeUndefined();
    const v = await cache.load("/a", ["/a"]);
    expect(v.get("/a")?.exists).toBe(true);
    expect(calls).toBe(2);
  });

  test("invalidate drops one entry so the next load stats again (a contradicting click)", async () => {
    let exists = false;
    let calls = 0;
    const cache = createArtifactStatsCache(async () => {
      calls++;
      return exists ? [{ path: "/a", isDirectory: false }] : [];
    });
    await cache.load("/a", ["/a"]);
    await cache.load("/b", ["/b"]);
    expect(cache.peek("/a")?.get("/a")?.exists).toBe(false);
    exists = true;
    cache.invalidate("/a");
    expect(cache.peek("/a")).toBeUndefined();
    expect(cache.peek("/b")).toBeDefined();
    const v = await cache.load("/a", ["/a"]);
    expect(v.get("/a")?.exists).toBe(true);
    expect(calls).toBe(3);
  });

  test("keeps at most maxEntries sets, dropping the oldest", async () => {
    const cache = createArtifactStatsCache(async () => [], { maxEntries: 2 });
    await cache.load("/a", ["/a"]);
    await cache.load("/b", ["/b"]);
    await cache.load("/c", ["/c"]);
    expect(cache.peek("/a")).toBeUndefined();
    expect(cache.peek("/b")).toBeDefined();
    expect(cache.peek("/c")).toBeDefined();
  });

  test("subscribers of a key hear every landed load, not other keys or failures", async () => {
    let fail = false;
    const cache = createArtifactStatsCache(async (paths) => {
      if (fail) throw new Error("offline");
      return paths.map((path) => ({ path, isDirectory: false }));
    });
    const heardA: number[] = [];
    let heardB = 0;
    const offA = cache.subscribe("/a", () => heardA.push(heardA.length));
    cache.subscribe("/b", () => heardB++);
    await cache.load("/a", ["/a"]);
    expect(heardA.length).toBe(1);
    // A fresh hit lands nothing new, so nobody is told.
    await cache.load("/a", ["/a"]);
    expect(heardA.length).toBe(1);
    // A forced re-check (invalidate + load) by ANOTHER view reaches this one.
    cache.invalidate("/a");
    await cache.load("/a", ["/a"]);
    expect(heardA.length).toBe(2);
    fail = true;
    cache.invalidate("/a");
    await expect(cache.load("/a", ["/a"])).rejects.toThrow("offline");
    expect(heardA.length).toBe(2);
    expect(heardB).toBe(0);
    offA();
    fail = false;
    await cache.load("/a", ["/a"]);
    expect(heardA.length).toBe(2);
  });

  test("a throwing subscriber doesn't stop the others or fail the load", async () => {
    const cache = createArtifactStatsCache(async () => []);
    let heard = 0;
    cache.subscribe("/a", () => {
      throw new Error("boom");
    });
    cache.subscribe("/a", () => heard++);
    await cache.load("/a", ["/a"]);
    expect(heard).toBe(1);
    expect(cache.peek("/a")).toBeDefined();
  });
});

describe("expandDetailOf", () => {
  test("reads a string query off a CustomEvent-like detail", () => {
    expect(expandDetailOf({ detail: { query: "uniquetoken" } })).toEqual({ query: "uniquetoken" });
  });

  test("tolerates a missing or malformed detail", () => {
    expect(expandDetailOf({})).toEqual({});
    expect(expandDetailOf({ detail: null })).toEqual({});
    expect(expandDetailOf({ detail: { query: 3 } })).toEqual({});
    expect(expandDetailOf(null)).toEqual({});
  });
});
