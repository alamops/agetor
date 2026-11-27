import { describe, expect, test } from "bun:test";
import type { RemoteAuditHead, RemoteAuditInput, RemoteAuditRow, RemoteAuditVerify } from "../../shared/remote-types.ts";
import { REFUSAL_COALESCE_MS, createAudit, type AuditStore } from "./audit.ts";
import { AUDIT_MAX_AGE_MS, AUDIT_MAX_ROWS, startAuditRetention, trimAuditNow } from "./audit-retention.ts";

/** An in-memory store with the real store's contract (the chain itself is tested in db-remote.test.ts). */
function memoryStore() {
  const rows: RemoteAuditRow[] = [];
  const calls = { verify: 0, trim: [] as unknown[] };
  const store: AuditStore = {
    async append(e: RemoteAuditInput): Promise<RemoteAuditHead> {
      const seq = rows.length + 1;
      rows.push({
        seq, ts: e.ts, kind: e.kind ?? "entry", deviceId: e.deviceId ?? null, sessionHash: e.sessionHash ?? null, action: e.action, route: e.route ?? null,
        targetJson: e.target === undefined ? null : JSON.stringify(e.target), resultCode: e.resultCode ?? null, attemptSeq: e.attemptSeq ?? null,
        bodyHash: e.bodyHash ?? null, signature: e.signature ?? null, prevHash: "p".repeat(64), hash: String(seq).padStart(64, "0"),
      });
      return { seq, hash: String(seq).padStart(64, "0") };
    },
    async head() {
      const r = rows[rows.length - 1];
      return r ? { seq: r.seq, hash: r.hash } : null;
    },
    async page({ beforeSeq, limit }) {
      return rows.filter((r) => beforeSeq === undefined || r.seq < beforeSeq).sort((a, b) => b.seq - a.seq).slice(0, limit);
    },
    async resultFor(attemptSeq) {
      return rows.find((r) => r.attemptSeq === attemptSeq) ?? null;
    },
    async verify(): Promise<RemoteAuditVerify> {
      calls.verify++;
      return { ok: true, firstBadSeq: null, rows: rows.length };
    },
    async trim(opts) {
      calls.trim.push(opts);
      return { dropped: 0, anchorSeq: null };
    },
  };
  return { rows, store, calls };
}

describe("attempt before, result after", () => {
  test("an attempt row is written first and names the route, the session and a body HASH, never a body", async () => {
    const m = memoryStore();
    const audit = createAudit(m.store, () => 1000);
    const seq = await audit.attempt({ deviceId: "d1", sessionHash: "ab", route: "POST /runs/r1/input", target: { runId: "r1" }, bodyHash: "cd".repeat(32), signature: "ef".repeat(64) });
    expect(seq).toBe(1);
    expect(m.rows[0]).toMatchObject({ action: "route", deviceId: "d1", route: "POST /runs/r1/input", bodyHash: "cd".repeat(32), signature: "ef".repeat(64), ts: 1000 });
    expect(JSON.stringify(m.rows)).not.toContain("follow-up text");
  });

  test("the result row names its attempt", async () => {
    const m = memoryStore();
    const audit = createAudit(m.store);
    const attempt = await audit.attempt({ deviceId: "d1", sessionHash: "ab", route: "GET /tasks" });
    await audit.result(attempt, "200", { deviceId: "d1" });
    expect(m.rows[1]).toMatchObject({ action: "route-result", attemptSeq: attempt, resultCode: "200" });
  });

  test("an attempt with no result reads outcome unknown; one with a result reads its code", async () => {
    const m = memoryStore();
    const audit = createAudit(m.store);
    const a = await audit.attempt({ deviceId: "d1", sessionHash: "ab", route: "POST /a" });
    await audit.attempt({ deviceId: "d1", sessionHash: "ab", route: "POST /b" });
    await audit.result(a, "202");
    const page = await audit.page({ limit: 10 });
    const byRoute = Object.fromEntries(page.rows.filter((r) => r.action === "route").map((r) => [r.route, r.outcome]));
    expect(byRoute).toEqual({ "POST /a": "202", "POST /b": "unknown" });
  });
});

describe("events and refusals", () => {
  test("events carry the action and the fields they are given", async () => {
    const m = memoryStore();
    const audit = createAudit(m.store, () => 5);
    await audit.event("session-open", { deviceId: "d1", sessionHash: "ab" });
    await audit.event("revoke-all", { target: { count: 3 } });
    expect(m.rows.map((r) => [r.action, r.deviceId, r.ts])).toEqual([["session-open", "d1", 5], ["revoke-all", null, 5]]);
  });

  test("a refusal a device can repeat at will is written at most once a minute", async () => {
    const m = memoryStore();
    let t = 1_000_000;
    const audit = createAudit(m.store, () => t);
    expect(await audit.refusal("d1", "rate")).toBe(true);
    for (let i = 0; i < 50; i++) expect(await audit.refusal("d1", "rate")).toBe(false);
    expect(await audit.refusal("d2", "rate")).toBe(true);
    t += REFUSAL_COALESCE_MS;
    expect(await audit.refusal("d1", "rate")).toBe(true);
    expect(m.rows).toHaveLength(3);
  });
});

describe("the viewer", () => {
  test("pages newest first with the chain status, and the chain check is cached until the next append", async () => {
    const m = memoryStore();
    const audit = createAudit(m.store);
    for (let i = 0; i < 5; i++) await audit.event("session-open", { deviceId: "d1" });
    const first = await audit.page({ limit: 3 });
    expect(first.rows.map((r) => r.seq)).toEqual([5, 4, 3]);
    expect(first.chain).toEqual({ ok: true, firstBadSeq: null });
    await audit.page({ limit: 3, beforeSeq: 3 });
    expect(m.calls.verify).toBe(1);
    await audit.event("session-close", { deviceId: "d1" });
    await audit.page({ limit: 3 });
    expect(m.calls.verify).toBe(2);
  });

  test("head serves the hello", async () => {
    const m = memoryStore();
    const audit = createAudit(m.store);
    expect(await audit.head()).toBeNull();
    await audit.event("pair", { deviceId: "d1" });
    expect(await audit.head()).toEqual({ seq: 1, hash: "1".padStart(64, "0") });
  });
});

describe("retention", () => {
  test("trims with one year and 50,000 rows", async () => {
    const m = memoryStore();
    await trimAuditNow({ store: m.store, now: () => 123 });
    expect(m.calls.trim).toEqual([{ maxAgeMs: AUDIT_MAX_AGE_MS, maxRows: AUDIT_MAX_ROWS, now: 123 }]);
    expect(AUDIT_MAX_AGE_MS).toBe(365 * 24 * 3600 * 1000);
    expect(AUDIT_MAX_ROWS).toBe(50_000);
  });

  test("the daily job runs after a minute, then every day, and stops when told", async () => {
    const m = memoryStore();
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const stop = startAuditRetention({ store: m.store, setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimer: () => undefined });
    expect(timers[0]!.ms).toBe(60_000);
    timers[0]!.fn();
    await new Promise((r) => setTimeout(r, 5));
    expect(m.calls.trim).toHaveLength(1);
    expect(timers[1]!.ms).toBe(24 * 3600 * 1000);
    stop();
    timers[1]!.fn();
    await new Promise((r) => setTimeout(r, 5));
    expect(m.calls.trim).toHaveLength(1);
  });

  test("a failing trim is reported, never thrown, and the job keeps its schedule", async () => {
    const m = memoryStore();
    m.store.trim = async () => { throw new Error("db down"); };
    const errors: unknown[] = [];
    const timers: Array<() => void> = [];
    startAuditRetention({ store: m.store, onError: (e) => errors.push(e), setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => undefined });
    timers[0]!();
    await new Promise((r) => setTimeout(r, 5));
    expect(errors).toHaveLength(1);
    expect(timers).toHaveLength(2);
  });
});
