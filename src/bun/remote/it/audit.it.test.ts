// TS3 and invariant 12 (SC7): the hash-chained audit. In-process on a real SQLite file: the chain verifies, a forged row is detected, a trim leaves
// an anchor that still verifies, and an attempt with no result reads "outcome unknown" even after the process that wrote it is gone.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { pinDataDir, principal } from "./inproc.ts";

const DATA = pinDataDir("audit");
const { createAudit } = await import("../audit.ts");
const { createRouter } = await import("../router.ts");
const { createDecisions } = await import("../decisions.ts");
const { createIdempotency } = await import("../idempotency.ts");
const { RateLimiter } = await import("../rate-limit.ts");
const asyncDb = await import("../../db-async.ts");
const { db } = await import("../../db.ts");
const { rmTestDataDir } = await import("../../test-data-dir.ts");
afterAll(() => rmTestDataDir(DATA));
afterEach(() => {
  db.run(`DROP TRIGGER IF EXISTS remote_audit_no_update`);
  db.run(`DROP TRIGGER IF EXISTS remote_audit_no_delete`);
  db.run(`DELETE FROM remote_audit`);
  db.run(`DELETE FROM sqlite_sequence WHERE name = 'remote_audit'`);
  db.run(`CREATE TRIGGER remote_audit_no_update BEFORE UPDATE ON remote_audit BEGIN SELECT RAISE(ABORT, 'remote_audit is append-only'); END`);
  db.run(`CREATE TRIGGER remote_audit_no_delete BEFORE DELETE ON remote_audit BEGIN SELECT RAISE(ABORT, 'remote_audit is append-only'); END`);
});

describe("the chain", () => {
  test("rows verify, the head is the last row, and every row names the one before it", async () => {
    const audit = createAudit();
    for (let i = 0; i < 12; i++) await audit.event("session-open", { deviceId: "ab".repeat(16) });
    const page = await audit.page({ limit: 50 });
    expect(page.chain).toEqual({ ok: true, firstBadSeq: null });
    expect(page.rows).toHaveLength(12);
    expect((await audit.head())?.seq).toBe(12);
    expect(page.rows[0]!.prevHash).toBe(page.rows[1]!.hash);
  });

  test("a forged row is detected: with the append-only triggers dropped (an attacker with the file), editing one row breaks the chain at that row", async () => {
    const audit = createAudit();
    for (let i = 0; i < 6; i++) await audit.event("pair", { deviceId: "ab".repeat(16), target: { n: i } });
    db.run(`DROP TRIGGER remote_audit_no_update`);
    db.run(`UPDATE remote_audit SET action = 'revoke' WHERE seq = 3`);
    const page = await createAudit().page({ limit: 50 });
    expect(page.chain.ok).toBe(false);
    expect(page.chain.firstBadSeq).toBe(3);
  });

  test("the triggers refuse an update or a delete by an ordinary statement", () => {
    db.run(`INSERT INTO remote_audit (ts, kind, action, prev_hash, hash) VALUES (1, 'entry', 'pair', '', 'h1')`);
    expect(() => db.run(`UPDATE remote_audit SET action = 'x'`)).toThrow();
    expect(() => db.run(`DELETE FROM remote_audit`)).toThrow();
  });

  test("a trim leaves an anchor row holding the hash of the last dropped entry, and the chain still verifies from it", async () => {
    const audit = createAudit();
    for (let i = 0; i < 20; i++) await audit.event("session-open", { deviceId: "ab".repeat(16) });
    const trimmed = await asyncDb.op("remote.auditTrim", [{ maxAgeMs: 365 * 86_400_000, maxRows: 5, now: Date.now() }]) as { dropped: number; anchorSeq: number | null };
    expect(trimmed.dropped).toBeGreaterThan(0);
    expect(trimmed.anchorSeq).not.toBeNull();
    const page = await createAudit().page({ limit: 100 });
    expect(page.chain.ok).toBe(true);
    expect(page.rows.some((r) => r.kind === "anchor")).toBe(true);
    expect(page.rows.length).toBeLessThan(20);
    // appending after a trim keeps chaining
    await createAudit().event("revoke", { deviceId: "ab".repeat(16) });
    expect((await createAudit().page({ limit: 100 })).chain.ok).toBe(true);
  });
});

describe("invariant 12: audited first", () => {
  function rigWithHandler(handler: () => Promise<Response>) {
    const audit = createAudit();
    const routes = { "/runs/:id/cancel": { POST: handler }, "/tasks": { GET: async () => Response.json({ tasks: [] }) } };
    const router = createRouter({
      limiter: new RateLimiter(), idempotency: createIdempotency(), decisions: createDecisions(), audit,
      lookups: { tmuxPrompt: async () => null, fxPermission: async () => null, askQuestionTask: async () => null, runTask: async () => "t1", previewInScope: async () => true, task: async () => ({ agent: "claude-code", mode: "ask" }) },
      routes: () => routes as never,
    });
    return { router, audit };
  }

  test("inv12: the attempt row is in the log BEFORE the handler runs, and the result row after; a handler that never answers leaves 'outcome unknown'", async () => {
    let atHandler: { rows: number } | null = null;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { router, audit } = rigWithHandler(async () => {
      atHandler = { rows: (await createAudit().page({ limit: 50 })).rows.length };
      await gate; // never finishes: the process "dies" here
      return Response.json({});
    });
    const call = router.invoke(principal("respond"), { method: "POST", path: "/runs/r1/cancel", query: null, body: {}, idem: "9f".repeat(16), decision: null });
    await new Promise((r) => setTimeout(r, 200));
    // while the handler is mid-flight the attempt is already durable
    expect(atHandler).not.toBeNull();
    expect(atHandler!.rows).toBe(1);
    const mid = await audit.page({ limit: 50 });
    expect(mid.rows[0]).toMatchObject({ action: "route", route: "POST /runs/r1/cancel" });
    expect(mid.rows[0]!.outcome).toBe("unknown");
    // a "restart": a brand new audit over the same file still reads the attempt as unknown
    expect((await createAudit().page({ limit: 50 })).rows[0]!.outcome).toBe("unknown");
    release();
    await call;
    const done = await createAudit().page({ limit: 50 });
    expect(done.rows.map((r) => r.action)).toEqual(["route-result", "route"]);
    expect(done.rows[1]!.outcome).toBe("200");
  });

  test("inv12: when the attempt row cannot be written the handler never runs", async () => {
    let ran = 0;
    const { router } = rigWithHandler(async () => (ran++, Response.json({})));
    db.run(`DROP TRIGGER remote_audit_no_update`);
    db.run(`CREATE TRIGGER remote_audit_block BEFORE INSERT ON remote_audit BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    try {
      const res = await router.invoke(principal("respond"), { method: "POST", path: "/runs/r1/cancel", query: null, body: {}, idem: "8e".repeat(16), decision: null });
      expect(res.status).toBe(500);
      expect(ran).toBe(0);
    } finally {
      db.run(`DROP TRIGGER remote_audit_block`);
    }
  });
});
