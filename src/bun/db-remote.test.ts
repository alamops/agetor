// Migrations 094–096 and the Companion's ops (docs/architecture/persistence.md "Remote tables"): the registry rows, the hash-chained audit
// log with its triggers and trim, and the idempotency store. In-process on the db.ts singleton (the real worker thread: db-remote-worker.test.ts).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalize } from "@agetor/remote-protocol/canonical-json";
import type { RemoteDeviceInsert } from "../shared/remote-types.ts";
import type { IdempotencyPut } from "./db-core/ops/remote-ops.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-db-remote-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

let db: typeof import("./db.ts").db;
let asyncDb: typeof import("./db-async.ts");

beforeAll(async () => {
  ({ db } = await import("./db.ts"));
  asyncDb = await import("./db-async.ts");
});
afterAll(() => rmTestDataDir(DATA_DIR));
afterEach(() => {
  db.run(`DROP TRIGGER IF EXISTS remote_audit_no_update`);
  db.run(`DROP TRIGGER IF EXISTS remote_audit_no_delete`);
  db.run(`DELETE FROM remote_audit`);
  db.run(`DELETE FROM sqlite_sequence WHERE name = 'remote_audit'`);
  db.run(`CREATE TRIGGER remote_audit_no_update BEFORE UPDATE ON remote_audit BEGIN SELECT RAISE(ABORT, 'remote_audit is append-only'); END`);
  db.run(`CREATE TRIGGER remote_audit_no_delete BEFORE DELETE ON remote_audit BEGIN SELECT RAISE(ABORT, 'remote_audit is append-only'); END`);
  db.run(`DELETE FROM remote_devices`);
  db.run(`DELETE FROM remote_idempotency`);
});

const b = (n: number, fill = 1): Uint8Array => new Uint8Array(n).fill(fill);
const id = (n: number) => n.toString(16).padStart(32, "0");

function device(n: number, over: Partial<RemoteDeviceInsert> = {}): RemoteDeviceInsert {
  return {
    id: id(n), name: `Phone ${n}`, platform: "ios", appVersion: "1.0.0", sessionPub: b(65, 2), approvePub: b(65, 3), pushPub: b(32, 4),
    linkSecret: b(32, 5), level: "respond", enrolledAt: 1_000_000 + n, sig: b(64, 6), ...over,
  };
}

const T0 = 1_800_000_000_000;

describe("the tables", () => {
  test("094, 095 and 096 are applied", () => {
    const tables = db.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'remote_%'`).all().map((r) => r.name).sort();
    expect(tables).toEqual(["remote_audit", "remote_devices", "remote_idempotency"]);
    const triggers = db.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'remote_audit_%'`).all().map((r) => r.name).sort();
    expect(triggers).toEqual(["remote_audit_no_delete", "remote_audit_no_update"]);
    const applied = db.query<{ id: string }, []>(`SELECT id FROM _migrations WHERE id LIKE '09%'`).all().map((r) => r.id);
    expect(applied).toEqual(expect.arrayContaining(["094_remote_devices", "095_remote_audit", "096_remote_idempotency"]));
  });

  test("a bad level, platform or status is refused by the table", async () => {
    await expect(asyncDb.op("remote.addDevice", [device(1, { level: "full" as never }), { ts: T0, action: "pair" }])).rejects.toThrow();
    await expect(asyncDb.op("remote.addDevice", [device(2, { platform: "windows" as never }), { ts: T0, action: "pair" }])).rejects.toThrow();
    expect(await asyncDb.remoteDevices.list()).toEqual([]);
  });
});

describe("remote.addDevice", () => {
  test("inserts the row and its pair audit entry together", async () => {
    const head = await asyncDb.op("remote.addDevice", [device(1, { level: "operate" }), { ts: T0, target: { name: "Phone 1", level: "operate" } } as never]);
    expect(head.seq).toBe(1);
    const row = await asyncDb.remoteDevices.get(id(1));
    expect(row).toMatchObject({ id: id(1), name: "Phone 1", platform: "ios", level: "operate", status: "active", lastSeenAt: null, pushRef: null, pushDead: false });
    expect(row!.sessionPub).toEqual(b(65, 2));
    expect(row!.linkSecret).toEqual(b(32, 5));
    const audit = await asyncDb.remoteAudit.page({ limit: 10 });
    expect(audit.map((a) => [a.action, a.deviceId, a.kind])).toEqual([["pair", id(1), "entry"]]);
  });

  test("a duplicate id rolls back, and leaves no audit row", async () => {
    await asyncDb.op("remote.addDevice", [device(1), { ts: T0, action: "pair" }]);
    await expect(asyncDb.op("remote.addDevice", [device(1), { ts: T0 + 1, action: "pair" }])).rejects.toThrow();
    expect((await asyncDb.remoteAudit.page({ limit: 10 })).length).toBe(1);
    expect((await asyncDb.remoteDevices.list()).length).toBe(1);
  });

  test("reads: list order, last seen, push registration and a dead push", async () => {
    await asyncDb.op("remote.addDevice", [device(2), { ts: T0, action: "pair" }]);
    await asyncDb.op("remote.addDevice", [device(1), { ts: T0, action: "pair" }]);
    expect((await asyncDb.remoteDevices.list()).map((d) => d.id)).toEqual([id(1), id(2)]);
    await asyncDb.remoteDevices.setLastSeen(id(1), T0 + 5);
    await asyncDb.remoteDevices.setPushRef(id(1), "ref-1", b(32, 9));
    let d = (await asyncDb.remoteDevices.get(id(1)))!;
    expect(d).toMatchObject({ lastSeenAt: T0 + 5, pushRef: "ref-1", pushDead: false });
    expect(d.pushSendKey).toEqual(b(32, 9));
    await asyncDb.remoteDevices.markPushDead(id(1));
    expect((await asyncDb.remoteDevices.get(id(1)))!.pushDead).toBe(true);
    await asyncDb.remoteDevices.setPushRef(id(1), "ref-2", b(32, 8));
    d = (await asyncDb.remoteDevices.get(id(1)))!;
    expect(d).toMatchObject({ pushRef: "ref-2", pushDead: false });
    expect(await asyncDb.remoteDevices.get("nope")).toBeNull();
  });
});

describe("remote.revokeDevices", () => {
  test("marks the rows revoked and audits each id, including one with no row", async () => {
    await asyncDb.op("remote.addDevice", [device(1), { ts: T0, action: "pair" }]);
    const res = await asyncDb.op("remote.revokeDevices", [[id(1), id(99)], "settings", T0 + 10]);
    expect(res.revoked).toEqual([id(1), id(99)]);
    expect((await asyncDb.remoteDevices.get(id(1)))!.status).toBe("revoked");
    const audit = await asyncDb.remoteAudit.page({ limit: 10 });
    expect(audit.map((a) => [a.action, a.deviceId]).reverse()).toEqual([["pair", id(1)], ["revoke", id(1)], ["revoke", id(99)]]);
    expect(JSON.parse(audit[0]!.targetJson!)).toEqual({ reason: "settings" });
  });
});

describe("the audit chain", () => {
  async function appendN(n: number, ts = T0) {
    for (let i = 1; i <= n; i++) await asyncDb.op("remote.auditAppend", [{ ts: ts + i, action: "route", deviceId: id(1), route: `GET /r${i}`, target: { n: i } }]);
  }

  test("each row's hash is SHA-256(prev_hash || canonical JSON of the row), and the chain verifies", async () => {
    await appendN(5);
    const rows = db.query<Record<string, unknown>, []>(`SELECT * FROM remote_audit ORDER BY seq`).all();
    let prev = "0".repeat(64);
    for (const r of rows) {
      const { hash, ...rest } = r as { hash: string } & Record<string, unknown>;
      expect(rest.prev_hash).toBe(prev);
      expect(hash).toBe(createHash("sha256").update(prev).update(canonicalize(rest)).digest("hex"));
      prev = hash;
    }
    expect(await asyncDb.op("remote.auditVerify", [])).toEqual({ ok: true, firstBadSeq: null, rows: 5 });
    expect(await asyncDb.remoteAudit.head()).toEqual({ seq: 5, hash: prev });
  });

  test("an empty log verifies, and has no head", async () => {
    expect(await asyncDb.op("remote.auditVerify", [])).toEqual({ ok: true, firstBadSeq: null, rows: 0 });
    expect(await asyncDb.remoteAudit.head()).toBeNull();
  });

  test("UPDATE and DELETE are refused", async () => {
    await appendN(2);
    expect(() => db.run(`UPDATE remote_audit SET action = 'x' WHERE seq = 1`)).toThrow("append-only");
    expect(() => db.run(`DELETE FROM remote_audit WHERE seq = 1`)).toThrow("append-only");
    expect(() => db.run(`DELETE FROM remote_audit`)).toThrow("append-only");
    expect((await asyncDb.remoteAudit.page({ limit: 10 })).length).toBe(2);
  });

  test("a forged row (trigger dropped, action edited) is found by its seq", async () => {
    await appendN(5);
    db.run(`DROP TRIGGER remote_audit_no_update`);
    db.run(`UPDATE remote_audit SET action = 'revoke-all' WHERE seq = 3`);
    expect(await asyncDb.op("remote.auditVerify", [])).toMatchObject({ ok: false, firstBadSeq: 3 });
  });

  test("a deleted middle row breaks the chain at the next row", async () => {
    await appendN(5);
    db.run(`DROP TRIGGER remote_audit_no_delete`);
    db.run(`DELETE FROM remote_audit WHERE seq = 3`);
    expect(await asyncDb.op("remote.auditVerify", [])).toMatchObject({ ok: false, firstBadSeq: 4 });
  });

  test("a truncated front with no anchor is refused; a front that starts at seq 1 needs zero as its prev hash", async () => {
    await appendN(4);
    db.run(`DROP TRIGGER remote_audit_no_delete`);
    db.run(`DELETE FROM remote_audit WHERE seq <= 2`);
    expect(await asyncDb.op("remote.auditVerify", [])).toMatchObject({ ok: false, firstBadSeq: 3 });
  });

  test("page is newest first, pages backwards and caps the limit", async () => {
    await appendN(7);
    expect((await asyncDb.remoteAudit.page({ limit: 3 })).map((r) => r.seq)).toEqual([7, 6, 5]);
    expect((await asyncDb.remoteAudit.page({ beforeSeq: 5, limit: 3 })).map((r) => r.seq)).toEqual([4, 3, 2]);
    expect((await asyncDb.remoteAudit.page({ limit: 9999 })).length).toBe(7);
  });

  test("an attempt without a result row is findable, and one with a result row links to it", async () => {
    const attempt = await asyncDb.op("remote.auditAppend", [{ ts: T0, action: "route", deviceId: id(1), route: "POST /runs/r/input", bodyHash: "ab".repeat(32) }]);
    expect(await asyncDb.remoteAudit.resultFor(attempt.seq)).toBeNull();
    await asyncDb.op("remote.auditAppend", [{ ts: T0 + 1, action: "route-result", deviceId: id(1), attemptSeq: attempt.seq, resultCode: "200" }]);
    expect((await asyncDb.remoteAudit.resultFor(attempt.seq))!.resultCode).toBe("200");
  });

  test("a body is never stored, only its hash, and a signature is stored", async () => {
    await asyncDb.op("remote.auditAppend", [{ ts: T0, action: "route", bodyHash: "cd".repeat(32), signature: "ef".repeat(64), target: { taskId: "t1" } }]);
    const row = (await asyncDb.remoteAudit.page({ limit: 1 }))[0]!;
    expect(row.bodyHash).toBe("cd".repeat(32));
    expect(row.signature).toBe("ef".repeat(64));
    expect(JSON.stringify(row)).not.toContain("secret follow-up text");
  });
});

describe("remote.auditTrim", () => {
  const DAY = 24 * 3600 * 1000;
  async function seed() {
    for (let i = 1; i <= 10; i++) await asyncDb.op("remote.auditAppend", [{ ts: T0 + i * DAY, action: "route", deviceId: id(1), target: { i } }]);
  }

  test("drops by age, writes an anchor, and the chain verifies from the anchor", async () => {
    await seed();
    const res = await asyncDb.op("remote.auditTrim", [{ maxAgeMs: 4.5 * DAY, maxRows: 50_000, now: T0 + 10 * DAY }]);
    // rows at days 1..5 are older than 4.5 days before day 10
    expect(res.dropped).toBe(5);
    expect(res.anchorSeq).toBe(11);
    const rows = await asyncDb.remoteAudit.page({ limit: 50 });
    expect(rows.map((r) => r.seq).reverse()).toEqual([6, 7, 8, 9, 10, 11]);
    expect(rows[0]).toMatchObject({ kind: "anchor", action: "trim" });
    expect(JSON.parse(rows[0]!.targetJson!)).toMatchObject({ droppedThrough: 5, dropped: 5 });
    expect(await asyncDb.op("remote.auditVerify", [])).toMatchObject({ ok: true, rows: 6 });
  });

  test("drops by count, keeps the newest rows, and never the head", async () => {
    await seed();
    const res = await asyncDb.op("remote.auditTrim", [{ maxAgeMs: 10_000 * DAY, maxRows: 3, now: T0 + 10 * DAY }]);
    expect(res.dropped).toBe(7);
    const seqs = (await asyncDb.remoteAudit.page({ limit: 50 })).map((r) => r.seq).reverse();
    expect(seqs).toEqual([8, 9, 10, 11]);
    expect(await asyncDb.op("remote.auditVerify", [])).toMatchObject({ ok: true });
    // even an absurd limit keeps the head
    const again = await asyncDb.op("remote.auditTrim", [{ maxAgeMs: 0, maxRows: 0, now: T0 + 99 * DAY }]);
    expect(again.dropped).toBeGreaterThan(0);
    expect((await asyncDb.remoteAudit.head())!.seq).toBeGreaterThan(11);
    expect(await asyncDb.op("remote.auditVerify", [])).toMatchObject({ ok: true });
  });

  test("nothing to drop changes nothing; the DELETE trigger is back after a trim", async () => {
    await seed();
    expect(await asyncDb.op("remote.auditTrim", [{ maxAgeMs: 100 * DAY, maxRows: 50_000, now: T0 + 10 * DAY }])).toEqual({ dropped: 0, anchorSeq: null });
    await asyncDb.op("remote.auditTrim", [{ maxAgeMs: 4.5 * DAY, maxRows: 50_000, now: T0 + 10 * DAY }]);
    expect(() => db.run(`DELETE FROM remote_audit WHERE seq = 8`)).toThrow("append-only");
    expect(await asyncDb.op("remote.auditTrim", [{ maxAgeMs: 1, maxRows: 1, now: T0 }])).toBeDefined();
  });

  test("a trim with no rows is a no-op", async () => {
    expect(await asyncDb.op("remote.auditTrim", [{ maxAgeMs: 1, maxRows: 1, now: T0 }])).toEqual({ dropped: 0, anchorSeq: null });
  });

  test("tampering after a trim is still found", async () => {
    await seed();
    await asyncDb.op("remote.auditTrim", [{ maxAgeMs: 4.5 * DAY, maxRows: 50_000, now: T0 + 10 * DAY }]);
    db.run(`DROP TRIGGER remote_audit_no_update`);
    db.run(`UPDATE remote_audit SET route = 'GET /evil' WHERE seq = 8`);
    expect(await asyncDb.op("remote.auditVerify", [])).toMatchObject({ ok: false, firstBadSeq: 8 });
  });
});

describe("idempotency", () => {
  const row = (key: string, extra: Partial<IdempotencyPut> = {}): IdempotencyPut => ({
    deviceId: id(1), idemKey: key, bodyHash: "aa".repeat(32), status: 200, contentType: "application/json", response: b(10, 7), createdAt: T0, ...extra,
  });

  test("the first put stores, a second with the same key keeps the first", async () => {
    expect(await asyncDb.op("remote.idempotencyPut", [row("k1")])).toBe(true);
    expect(await asyncDb.op("remote.idempotencyPut", [row("k1", { status: 500, response: b(3, 9) })])).toBe(false);
    const got = await asyncDb.remoteIdempotency.get(id(1), "k1");
    expect(got).toMatchObject({ status: 200, bodyHash: "aa".repeat(32), contentType: "application/json", createdAt: T0 });
    expect(got!.response).toEqual(b(10, 7));
    expect(await asyncDb.remoteIdempotency.get(id(2), "k1")).toBeNull();
  });

  test("an expired row (not yet pruned) is replaced by a put of the same key; a live one is kept", async () => {
    const WINDOW = 10 * 60_000;
    expect(await asyncDb.op("remote.idempotencyPut", [row("exp", { createdAt: T0 })])).toBe(true);
    // 11 minutes later the old row is outside the window: the new result is stored
    const later = T0 + WINDOW + 60_000;
    expect(await asyncDb.op("remote.idempotencyPut", [row("exp", { createdAt: later, expiredBefore: later - WINDOW, status: 201, response: b(4, 2) })])).toBe(true);
    expect(await asyncDb.remoteIdempotency.get(id(1), "exp")).toMatchObject({ status: 201, createdAt: later });
    // and inside the window it is still kept
    expect(await asyncDb.op("remote.idempotencyPut", [row("exp", { createdAt: later + 1000, expiredBefore: later + 1000 - WINDOW, status: 500 })])).toBe(false);
    expect(await asyncDb.remoteIdempotency.get(id(1), "exp")).toMatchObject({ status: 201 });
  });

  test("through createIdempotency on the real store: a key reused after its window (not yet pruned) runs once, and its repeat is the new result", async () => {
    const { IDEMPOTENCY_WINDOW_MS, createDbIdempotencyStore, createIdempotency } = await import("./remote/idempotency.ts");
    let t = T0;
    const idem = createIdempotency(createDbIdempotencyStore(), () => t);
    const KEY = "cd".repeat(16);
    const res = (status: number, text: string) => ({ status, contentType: "application/json", body: new TextEncoder().encode(text) });
    const first = await idem.claim(id(1), KEY, "h-first");
    expect(first.kind).toBe("run");
    if (first.kind === "run") await first.commit(res(200, "first"));
    // past the window and before the once-a-minute prune: the old row is still in the table
    t += IDEMPOTENCY_WINDOW_MS + 60_000;
    expect(await asyncDb.remoteIdempotency.get(id(1), KEY)).toMatchObject({ createdAt: T0 });
    const second = await idem.claim(id(1), KEY, "h-second");
    expect(second.kind).toBe("run");
    if (second.kind === "run") await second.commit(res(201, "second"));
    // the repeat of the new call answers its stored result instead of applying it again
    const repeat = await idem.claim(id(1), KEY, "h-second");
    expect(repeat.kind).toBe("hit");
    if (repeat.kind === "hit") {
      expect(repeat.result.status).toBe(201);
      expect(new TextDecoder().decode(repeat.result.body!)).toBe("second");
    }
    // and the old body is now a different call under a live key
    expect((await idem.claim(id(1), KEY, "h-first")).kind).toBe("mismatch");
  });

  test("R5: at exactly the window's end the key is expired for both the claim and the write: the new call runs and its result is kept", async () => {
    const { IDEMPOTENCY_WINDOW_MS, createDbIdempotencyStore, createIdempotency } = await import("./remote/idempotency.ts");
    let t = T0;
    const idem = createIdempotency(createDbIdempotencyStore(), () => t);
    const KEY = "ef".repeat(16);
    const res = (status: number, text: string) => ({ status, contentType: "application/json", body: new TextEncoder().encode(text) });
    const first = await idem.claim(id(1), KEY, "h-first");
    if (first.kind === "run") await first.commit(res(200, "first"));
    t = T0 + IDEMPOTENCY_WINDOW_MS; // the first claim calls this expired (`now - createdAt < window` is false)
    const second = await idem.claim(id(1), KEY, "h-second");
    expect(second.kind).toBe("run");
    if (second.kind === "run") await second.commit(res(201, "second"));
    expect(await asyncDb.remoteIdempotency.get(id(1), KEY)).toMatchObject({ createdAt: T0 + IDEMPOTENCY_WINDOW_MS, status: 201 });
    const repeat = await idem.claim(id(1), KEY, "h-second");
    expect(repeat.kind).toBe("hit");
  });

  test("a response over 64 KB is stored as status only", async () => {
    await asyncDb.op("remote.idempotencyPut", [row("big", { response: b(64 * 1024 + 1) })]);
    expect((await asyncDb.remoteIdempotency.get(id(1), "big"))!.response).toBeNull();
    await asyncDb.op("remote.idempotencyPut", [row("edge", { response: b(64 * 1024) })]);
    expect((await asyncDb.remoteIdempotency.get(id(1), "edge"))!.response!.length).toBe(64 * 1024);
  });

  test("prune drops rows older than the cutoff only", async () => {
    await asyncDb.op("remote.idempotencyPut", [row("old", { createdAt: T0 })]);
    await asyncDb.op("remote.idempotencyPut", [row("new", { createdAt: T0 + 20 * 60_000 })]);
    expect(await asyncDb.op("remote.idempotencyPrune", [T0 + 10 * 60_000])).toBe(1);
    expect(await asyncDb.remoteIdempotency.get(id(1), "old")).toBeNull();
    expect(await asyncDb.remoteIdempotency.get(id(1), "new")).not.toBeNull();
  });
});
