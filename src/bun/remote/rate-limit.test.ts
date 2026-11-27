import { describe, expect, test } from "bun:test";
import { RateLimiter } from "./rate-limit.ts";

function limiter() {
  let t = 1_000_000;
  const l = new RateLimiter(() => t);
  return { l, advance: (ms: number) => void (t += ms) };
}

describe("rate limits", () => {
  test("a burst of 100 requests: 30 pass, the rest are 429", () => {
    const { l } = limiter();
    const results = Array.from({ length: 100 }, () => l.check("d1", "normal"));
    expect(results.filter((r) => r.ok)).toHaveLength(30);
    const refused = results.find((r) => !r.ok);
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
  });

  test("a cancel during the burst passes: stop is never limited", () => {
    const { l } = limiter();
    for (let i = 0; i < 100; i++) l.check("d1", "normal");
    for (let i = 0; i < 50; i++) expect(l.check("d1", "stop")).toEqual({ ok: true });
  });

  test("tokens refill: 30 a second", () => {
    const { l, advance } = limiter();
    for (let i = 0; i < 30; i++) l.check("d1", "normal");
    expect(l.check("d1", "normal").ok).toBe(false);
    advance(100); // 3 tokens
    const after = Array.from({ length: 5 }, () => l.check("d1", "normal").ok);
    expect(after.filter(Boolean)).toHaveLength(3);
    advance(5000);
    expect(Array.from({ length: 40 }, () => l.check("d1", "normal").ok).filter(Boolean)).toHaveLength(30);
  });

  test("heavy reads: 2 a second, and each also takes a request token", () => {
    const { l } = limiter();
    expect(l.check("d1", "heavy").ok).toBe(true);
    expect(l.check("d1", "heavy").ok).toBe(true);
    expect(l.check("d1", "heavy").ok).toBe(false);
    // The two heavy reads used two of the 30 request tokens.
    expect(Array.from({ length: 40 }, () => l.check("d1", "normal").ok).filter(Boolean)).toHaveLength(28);
  });

  test("a refused heavy read spends nothing", () => {
    const { l } = limiter();
    l.check("d1", "heavy");
    l.check("d1", "heavy");
    for (let i = 0; i < 20; i++) l.check("d1", "heavy");
    expect(Array.from({ length: 40 }, () => l.check("d1", "normal").ok).filter(Boolean)).toHaveLength(28);
  });

  test("handshakes: 6 a minute per device", () => {
    const { l, advance } = limiter();
    expect(Array.from({ length: 10 }, () => l.check("d1", "handshake").ok).filter(Boolean)).toHaveLength(6);
    advance(10_000);
    expect(l.check("d1", "handshake").ok).toBe(true);
    expect(l.check("d1", "handshake").ok).toBe(false);
  });

  test("devices have separate buckets, and forget drops them", () => {
    const { l } = limiter();
    for (let i = 0; i < 30; i++) l.check("d1", "normal");
    expect(l.check("d1", "normal").ok).toBe(false);
    expect(l.check("d2", "normal").ok).toBe(true);
    l.forget("d1");
    expect(l.check("d1", "normal").ok).toBe(true);
  });
});
