/**
 * db-rpc in in-process mode (docs/plans/non-blocking-core.md, T8, X3): calls run
 * through the same dispatcher the worker uses, against the db.ts singleton.
 * db.ts opens one sqlite file per process, so the data dir is set at the top
 * level (first import wins) and every assertion is relative to fresh uuids.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";
import { makeRun, makeTask } from "./db-rpc-test-util.ts";

const dataDir = process.env.AGETOR_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), "agetor-db-rpc-"));
process.env.AGETOR_DATA_DIR = dataDir;

type DbModule = typeof import("./db.ts");
type RpcModule = typeof import("./db-rpc.ts");
let dbm: DbModule;
let rpcm: RpcModule;
let rpc: ReturnType<RpcModule["createDbRpc"]>;
const createdTaskIds: string[] = [];
const createdPrefKeys: string[] = [];

beforeAll(async () => {
  dbm = await import("./db.ts");
  rpcm = await import("./db-rpc.ts");
  rpc = rpcm.createDbRpc({ mode: "inprocess" });
  await rpc.dbReady();
});

afterAll(() => {
  for (const id of createdTaskIds) dbm.tasks.delete(id);
  for (const key of createdPrefKeys) dbm.db.run(`DELETE FROM preferences WHERE key = ?`, [key]);
  rmTestDataDir(dataDir);
});

function newTask() {
  const t = makeTask();
  createdTaskIds.push(t.id);
  return t;
}

describe("in-process calls", () => {
  test("return the same values as the synchronous db.ts call", async () => {
    const t = newTask();
    const inserted = await rpc.call("tasks", "insert", [t]);
    expect(inserted).toEqual(dbm.tasks.get(t.id)!);
    expect(await rpc.call("tasks", "get", [t.id])).toEqual(dbm.tasks.get(t.id));
    expect(await rpc.call("tasks", "get", [randomUUID()])).toBeNull();
    expect(await rpc.call("tasks", "list", [{ archived: "include" }])).toEqual(dbm.tasks.list({ archived: "include" }));
    const run = makeRun(t.id);
    await rpc.call("runs", "insert", [run]);
    const ev = (await rpc.call("runs", "appendEvent", [run.id, "stdout", "hello"])) as { id: number };
    expect(ev.id).toBeGreaterThan(0);
    expect(await rpc.call("runs", "events", [run.id])).toEqual(dbm.runs.events(run.id));
    // A Set result round-trips as a Set.
    expect(await rpc.call("runs", "seenLineUuidsForRun", [run.id])).toBeInstanceOf(Set);
  });

  test("a call with a method defined on the module of a different shape resolves through hiddenSessionIds", async () => {
    const ids = await rpc.call("hiddenSessionIds", "hiddenClaudeSessionIds", []);
    expect(ids).toBeInstanceOf(Set);
  });

  test("an unknown module, an unknown method and prototype members are refused", async () => {
    await expect(rpc.call("nope", "get", [])).rejects.toThrow("unknown db module");
    await expect(rpc.call("tasks", "nope", [])).rejects.toThrow("unknown db method");
    await expect(rpc.call("tasks", "constructor", [])).rejects.toThrow("unknown db method");
    await expect(rpc.call("tasks", "__proto__", [])).rejects.toThrow("unknown db method");
    await expect(rpc.call("constructor", "get", [])).rejects.toThrow("unknown db module");
    await expect(rpc.op("not.an.op" as never, [] as never)).rejects.toThrow("unknown db op");
  });
});

describe("named ops", () => {
  test("a tx op commits every write", async () => {
    const k1 = `rpc-test-${randomUUID()}`;
    const k2 = `rpc-test-${randomUUID()}`;
    createdPrefKeys.push(k1, k2);
    const n = await rpc.op("__test.setPreferences", [[[k1, "a"], [k2, "b"]], null]);
    expect(n).toBe(2);
    expect(dbm.preferences.get(k1)).toBe("a");
    expect(dbm.preferences.get(k2)).toBe("b");
  });

  test("a tx op rolls back every write when it throws", async () => {
    const k1 = `rpc-test-${randomUUID()}`;
    const k2 = `rpc-test-${randomUUID()}`;
    createdPrefKeys.push(k1, k2);
    await expect(rpc.op("__test.setPreferences", [[[k1, "a"], [k2, "b"]], 1])).rejects.toThrow("forced failure");
    expect(dbm.preferences.get(k1)).toBeNull();
    expect(dbm.preferences.get(k2)).toBeNull();
  });

  test("an op without tx keeps the writes made before the throw", async () => {
    const k1 = `rpc-test-${randomUUID()}`;
    const k2 = `rpc-test-${randomUUID()}`;
    createdPrefKeys.push(k1, k2);
    await expect(rpc.op("__test.setPreferencesNoTx", [[[k1, "a"], [k2, "b"]], 1])).rejects.toThrow("forced failure");
    expect(dbm.preferences.get(k1)).toBe("a");
    expect(dbm.preferences.get(k2)).toBeNull();
  });

  test("test ops are refused outside NODE_ENV=test", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(rpc.op("__test.setPreferences", [[], null])).rejects.toThrow("unknown db op");
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});

describe("in-process mode is faithful to worker mode (structured clone, serialised errors)", () => {
  test("a caller mutating its arguments right after the call cannot affect the call", async () => {
    const t = newTask();
    const pending = rpc.call("tasks", "insert", [t]);
    t.title = "mutated after the call";
    t.references.push({ path: "/x" } as never);
    await pending;
    const stored = (await rpc.call("tasks", "get", [t.id])) as { title: string; references: unknown[] };
    expect(stored.title).toBe("db-rpc");
    expect(stored.references).toEqual([]);
  });

  test("an argument that cannot be structured-cloned rejects that call", async () => {
    const k = `rpc-test-${randomUUID()}`;
    await expect(rpc.call("preferences", "set", [k, () => 1])).rejects.toThrow();
    expect(dbm.preferences.get(k)).toBeNull();
  });

  test("a result is a clone: mutating it does not reach the next read", async () => {
    const t = newTask();
    await rpc.call("tasks", "insert", [t]);
    const first = (await rpc.call("tasks", "get", [t.id])) as { title: string };
    first.title = "scribbled";
    expect(((await rpc.call("tasks", "get", [t.id])) as { title: string }).title).toBe("db-rpc");
  });

  test("a thrown error is a rebuilt instance, never the original", async () => {
    const { HarnessBuiltinError } = await import("./db-core/errors.ts");
    const builtin = dbm.harnesses.list().find((h) => h.isBuiltin)!;
    let direct: unknown;
    try { dbm.harnesses.assertDeletable(builtin.id); } catch (e) { direct = e; }
    const viaRpc = await rpc.call("harnesses", "assertDeletable", [builtin.id]).then(() => null, (e: unknown) => e);
    expect(viaRpc).toBeInstanceOf(HarnessBuiltinError);
    expect(viaRpc).not.toBe(direct);
    expect((viaRpc as Error).message).toBe((direct as Error).message);
  });
});

describe("error reconstruction", () => {
  test("HarnessInUseError keeps its class and fields", async () => {
    // Same path the worker takes: serialise, send, rebuild.
    const { serializeDbError } = await import("./workers/db-handler.ts");
    const { HarnessInUseError } = await import("./db-core/errors.ts");
    const rebuilt = rpcm.reconstructDbError(serializeDbError(new HarnessInUseError(["t1", "t2"], ["p1"])));
    expect(rebuilt).toBeInstanceOf(HarnessInUseError);
    expect(rebuilt).toBeInstanceOf(Error);
    expect((rebuilt as InstanceType<typeof HarnessInUseError>).taskIds).toEqual(["t1", "t2"]);
    expect((rebuilt as InstanceType<typeof HarnessInUseError>).profileIds).toEqual(["p1"]);
    expect(rebuilt.name).toBe("HarnessInUseError");
    expect(rebuilt.message).toBe("harness in use by 2 task(s) and 1 agent(s)");
  });

  test("every exported db-core error class is rebuilt as itself", async () => {
    const { serializeDbError } = await import("./workers/db-handler.ts");
    const e = await import("./db-core/errors.ts");
    const samples: Error[] = [
      new e.AgentProfileNameError("dup"),
      new e.HarnessBuiltinError("delete"),
      new e.HarnessInUseError(["a"], []),
      new e.ImportedClaudeSessionTaken("s1"),
      new e.ImportedOpencodeSessionTaken("s2"),
      new e.PipelineNameError("pipe"),
    ];
    for (const sample of samples) {
      const rebuilt = rpcm.reconstructDbError(serializeDbError(sample));
      expect(rebuilt.constructor).toBe(sample.constructor);
      expect(rebuilt).toBeInstanceOf(sample.constructor as new (...a: never[]) => Error);
      expect(rebuilt.name).toBe(sample.name);
      expect(rebuilt.message).toBe(sample.message);
      expect({ ...rebuilt }).toEqual({ ...sample });
    }
    const claude = rpcm.reconstructDbError(serializeDbError(new e.ImportedClaudeSessionTaken("s1")));
    expect((claude as InstanceType<typeof e.ImportedClaudeSessionTaken>).sessionId).toBe("s1");
  });

  test("an unknown error keeps its name, message, code and fields as a plain Error", async () => {
    const rebuilt = rpcm.reconstructDbError({ name: "SQLiteError", message: "boom", code: "SQLITE_BUSY", data: { errno: 5 } });
    expect(rebuilt).toBeInstanceOf(Error);
    expect(rebuilt.constructor).toBe(Error);
    expect(rebuilt.name).toBe("SQLiteError");
    expect(rebuilt.message).toBe("boom");
    expect((rebuilt as { code?: string }).code).toBe("SQLITE_BUSY");
    expect((rebuilt as { errno?: number }).errno).toBe(5);
    // A prototype-member name never resolves to a class.
    expect(rpcm.reconstructDbError({ name: "constructor", message: "x" }).constructor).toBe(Error);
  });

  test("an error thrown by a db-core method reaches the caller as the real class", async () => {
    const { HarnessBuiltinError } = await import("./db-core/errors.ts");
    const builtin = dbm.harnesses.list().find((h) => h.isBuiltin);
    expect(builtin).toBeDefined();
    await expect(rpc.call("harnesses", "assertDeletable", [builtin!.id])).rejects.toBeInstanceOf(HarnessBuiltinError);
  });
});

describe("rev tracking", () => {
  test("onRevChanged fires after a task insert and not after a pure read", async () => {
    await rpc.call("tasks", "list", []); // baseline
    const seen: number[] = [];
    const off = rpc.onRevChanged((rev) => seen.push(rev));
    try {
      await rpc.call("tasks", "list", []);
      await rpc.call("tasks", "get", [randomUUID()]);
      expect(seen).toEqual([]);
      const before = rpc.currentRev();
      await rpc.call("tasks", "insert", [newTask()]);
      expect(seen.length).toBe(1);
      expect(seen[0]).toBeGreaterThan(before);
      expect(rpc.currentRev()).toBe(seen[0]!);
      await rpc.call("tasks", "list", []);
      expect(seen.length).toBe(1);
    } finally {
      off();
    }
  });

  test("a rev move is announced on the task change bus", async () => {
    const { onTasksChanged } = await import("./task-change-bus.ts");
    const reasons: Array<string | undefined> = [];
    const off = onTasksChanged((r) => reasons.push(r));
    try {
      await rpc.call("tasks", "insert", [newTask()]);
      expect(reasons).toEqual(["rev"]);
    } finally {
      off();
    }
  });

  test("an unsubscribed listener is not called", async () => {
    let n = 0;
    const off = rpc.onRevChanged(() => { n++; });
    off();
    await rpc.call("tasks", "insert", [newTask()]);
    expect(n).toBe(0);
  });
});

describe("close", () => {
  test("a closed client refuses further calls", async () => {
    const other = rpcm.createDbRpc({ mode: "inprocess" });
    await other.closeDb();
    await expect(other.call("tasks", "list", [])).rejects.toBeInstanceOf(rpcm.DbUnavailableError);
    // The shared db.ts connection is untouched.
    expect(dbm.tasks.list().length).toBeGreaterThan(0);
  });
});
