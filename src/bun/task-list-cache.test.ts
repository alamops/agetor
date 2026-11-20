import { test, expect, describe } from "bun:test";
import { countsFingerprint, createTaskListCache, etagFor, ifNoneMatchMatches } from "./task-list-cache.ts";

describe("createTaskListCache", () => {
  function setup(maxAgeMs = 10_000, maxEntries = 8) {
    let t = 1_000;
    let builds = 0;
    const cache = createTaskListCache({ maxAgeMs, maxEntries, now: () => t });
    const build = (body: string) => () => { builds++; return body; };
    return { cache, build, advance: (ms: number) => { t += ms; }, builds: () => builds };
  }

  test("reuses the built answer while the version holds", () => {
    const s = setup();
    const a = s.cache.get("exclude|", "v1", s.build("[1]"));
    const b = s.cache.get("exclude|", "v1", s.build("[2]"));
    expect(b).toBe(a);
    expect(b.body).toBe("[1]");
    expect(s.builds()).toBe(1);
  });

  test("rebuilds when the version changes", () => {
    const s = setup();
    s.cache.get("exclude|", "v1", s.build("[1]"));
    const b = s.cache.get("exclude|", "v2", s.build("[2]"));
    expect(b.body).toBe("[2]");
    expect(s.builds()).toBe(2);
  });

  test("rebuilds after maxAge even with the same version, keeping the ETag when the body is equal", () => {
    const s = setup(10_000);
    const a = s.cache.get("k", "v1", s.build("[1]"));
    s.advance(9_999);
    s.cache.get("k", "v1", s.build("[1]"));
    expect(s.builds()).toBe(1);
    s.advance(1);
    const c = s.cache.get("k", "v1", s.build("[1]"));
    expect(s.builds()).toBe(2);
    expect(c.etag).toBe(a.etag);
  });

  test("keys are independent and the least recently used one is evicted", () => {
    const s = setup(10_000, 2);
    s.cache.get("a", "v", s.build("[a]"));
    s.cache.get("b", "v", s.build("[b]"));
    s.cache.get("a", "v", s.build("[a2]")); // hit: a is now the most recent
    s.cache.get("c", "v", s.build("[c]")); // evicts b
    expect(s.cache.size()).toBe(2);
    expect(s.cache.get("a", "v", s.build("[a3]")).body).toBe("[a]");
    expect(s.cache.get("b", "v", s.build("[b2]")).body).toBe("[b2]");
  });
});

describe("etagFor / ifNoneMatchMatches", () => {
  test("equal bodies share an ETag, different bodies don't", () => {
    expect(etagFor("[1]")).toBe(etagFor("[1]"));
    expect(etagFor("[1]")).not.toBe(etagFor("[2]"));
    expect(etagFor("[1]")).toMatch(/^"[0-9a-z]+"$/);
  });

  test("matches the exact tag, a list, a weak form and *", () => {
    const e = etagFor("[1]");
    expect(ifNoneMatchMatches(e, e)).toBe(true);
    expect(ifNoneMatchMatches(`"x", ${e}`, e)).toBe(true);
    expect(ifNoneMatchMatches(`W/${e}`, e)).toBe(true);
    expect(ifNoneMatchMatches("*", e)).toBe(true);
    expect(ifNoneMatchMatches(`"x"`, e)).toBe(false);
    expect(ifNoneMatchMatches(null, e)).toBe(false);
    expect(ifNoneMatchMatches("", e)).toBe(false);
  });
});

describe("countsFingerprint", () => {
  test("ignores insertion order and zero counts, and tells maps apart", () => {
    const a = new Map([["t1", 1], ["t2", 2]]);
    const b = new Map([["t2", 2], ["t1", 1], ["t3", 0]]);
    expect(countsFingerprint([a])).toBe(countsFingerprint([b]));
    expect(countsFingerprint([a, new Map()])).not.toBe(countsFingerprint([new Map(), a]));
    expect(countsFingerprint([new Map([["t1", 2]])])).not.toBe(countsFingerprint([new Map([["t1", 1]])]));
  });
});
