/**
 * The Companion's ops and modules against a REAL worker thread (docs/architecture/persistence.md "Remote tables"): every op runs inside the
 * database worker, the chain is walked there, and the rows cross the thread boundary as structured clones. Like db-rpc-worker.test.ts it opens
 * its own temp database file and never imports db.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RemoteAuditHead, RemoteAuditRow, RemoteAuditVerify, RemoteDeviceRow, RemoteIdempotencyRow } from "../shared/remote-types.ts";
import { createCoreWorker } from "./worker-entry.ts";

const dataDir = process.env.AGETOR_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), "agetor-db-remote-worker-data-"));
process.env.AGETOR_DATA_DIR = dataDir;
const savedEnv = { AGETOR_DB_MODE: process.env.AGETOR_DB_MODE, AGETOR_CORE_WORKER_ENTRY: process.env.AGETOR_CORE_WORKER_ENTRY };
process.env.AGETOR_DB_MODE = "worker";
process.env.AGETOR_CORE_WORKER_ENTRY = path.join(import.meta.dir, "core-worker.ts");

type RpcModule = typeof import("./db-rpc.ts");
let rpcm: RpcModule;
let rpc: ReturnType<RpcModule["createDbRpc"]>;
let dir: string;

beforeAll(async () => {
  rpcm = await import("./db-rpc.ts");
  dir = mkdtempSync(path.join(tmpdir(), "agetor-db-remote-worker-"));
  rpc = rpcm.createDbRpc({ mode: "worker", dbPath: path.join(dir, "agetor.sqlite"), workerFactory: (p) => createCoreWorker("db", { dbPath: p }) });
  await rpc.dbReady();
});
afterAll(async () => {
  await rpc.closeDb({ timeoutMs: 1000 }).catch(() => {});
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const b = (n: number, fill = 1): Uint8Array => new Uint8Array(n).fill(fill);
const id = (n: number) => n.toString(16).padStart(32, "0");
const T0 = 1_800_000_000_000;

const device = (n: number) => ({
  id: id(n), name: `Phone ${n}`, platform: "android" as const, appVersion: "2.0", sessionPub: b(65, 2), approvePub: b(65, 3), pushPub: b(32, 4),
  linkSecret: b(32, 5), level: "configure" as const, enrolledAt: T0, sig: b(64, 6),
});

describe("the Companion tables on the worker thread", () => {
  test("migrations 094 to 096 are applied", async () => {
    expect(await rpc.call("remoteDevices", "list", [])).toEqual([]);
    expect(await rpc.call("remoteAudit", "head", [])).toBeNull();
  });

  test("addDevice stores the row (bytes survive the clone) and its audit entry in one op", async () => {
    const head = (await rpc.op("remote.addDevice", [device(1), { ts: T0, action: "pair", target: { level: "configure" } }])) as RemoteAuditHead;
    expect(head.seq).toBe(1);
    const row = (await rpc.call("remoteDevices", "get", [id(1)])) as RemoteDeviceRow;
    expect(row.level).toBe("configure");
    expect(row.sessionPub).toEqual(b(65, 2));
    expect(row.linkSecret).toEqual(b(32, 5));
    expect(row.sig).toEqual(b(64, 6));
  });

  test("a duplicate device rolls the whole op back", async () => {
    await expect(rpc.op("remote.addDevice", [device(1), { ts: T0 + 1, action: "pair" }])).rejects.toThrow();
    expect(((await rpc.call("remoteAudit", "page", [{ limit: 50 }])) as RemoteAuditRow[]).length).toBe(1);
  });

  test("the chain is appended, verified and trimmed inside the worker", async () => {
    for (let i = 0; i < 30; i++) await rpc.op("remote.auditAppend", [{ ts: T0 + 1000 * (i + 1), action: "route", deviceId: id(1), target: { i } }]);
    expect(await rpc.op("remote.auditVerify", [])).toEqual({ ok: true, firstBadSeq: null, rows: 31 } satisfies RemoteAuditVerify);
    const trimmed = (await rpc.op("remote.auditTrim", [{ maxAgeMs: 1e12, maxRows: 10, now: T0 + 60_000 }])) as { dropped: number; anchorSeq: number | null };
    expect(trimmed.dropped).toBe(21);
    expect(trimmed.anchorSeq).toBe(32);
    expect(await rpc.op("remote.auditVerify", [])).toMatchObject({ ok: true, rows: 11 });
  });

  test("idempotency survives and answers a repeat; prune clears the window", async () => {
    const put = { deviceId: id(1), idemKey: "k", bodyHash: "aa".repeat(32), status: 201, contentType: "application/json", response: b(5, 8), createdAt: T0 };
    expect(await rpc.op("remote.idempotencyPut", [put])).toBe(true);
    expect(await rpc.op("remote.idempotencyPut", [{ ...put, status: 500 }])).toBe(false);
    const got = (await rpc.call("remoteIdempotency", "get", [id(1), "k"])) as RemoteIdempotencyRow;
    expect(got.status).toBe(201);
    expect(got.response).toEqual(b(5, 8));
    expect(await rpc.op("remote.idempotencyPrune", [T0 + 600_001])).toBe(1);
    expect(await rpc.call("remoteIdempotency", "get", [id(1), "k"])).toBeNull();
  });

  test("revoke marks the row and audits through the worker", async () => {
    await rpc.op("remote.revokeDevices", [[id(1)], "test", T0 + 70_000]);
    expect(((await rpc.call("remoteDevices", "get", [id(1)])) as RemoteDeviceRow).status).toBe("revoked");
  });
});
