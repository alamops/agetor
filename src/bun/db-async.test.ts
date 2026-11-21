/**
 * The async facade (docs/plans/non-blocking-core.md, T8): the same Task JSON
 * comes out of it whether the database sits behind a real worker thread or the
 * in-process db.ts connection, with the main-thread badge counts overlaid.
 *
 * The in-process side uses the db.ts singleton (data dir set at the top level,
 * first import wins); the worker side opens its own temp database file.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.ts";
import type { TaskDecorationDeps } from "./db-core/tasks.ts";
import { rmTestDataDir } from "./test-data-dir.ts";
import { makeTask } from "./db-rpc-test-util.ts";
import { BUILD_ID } from "./build-id.ts";

const dataDir = process.env.AGETOR_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), "agetor-db-async-"));
process.env.AGETOR_DATA_DIR = dataDir;

type DbModule = typeof import("./db.ts");
type AsyncModule = typeof import("./db-async.ts");
let dbm: DbModule;
let am: AsyncModule;
let workerDir: string;
let inproc: ReturnType<AsyncModule["createDbAsync"]>;
let worker: ReturnType<AsyncModule["createDbAsync"]>;
let workerRpc: ReturnType<AsyncModule["createDbRpc"]>;
const inprocIds: string[] = [];
const afterBare: Array<{ closeDb(o?: { timeoutMs?: number }): Promise<void> }> = [];

// Fake main-thread registries: what interactions.ts and terminals.ts would report.
const pendingCounts = new Map<string, number>();
const terminalCounts = new Map<string, number>();
const fakeDecorations: TaskDecorationDeps = {
  countPendingForTask: (id) => pendingCounts.get(id) ?? 0,
  countTerminals: (id) => terminalCounts.get(id) ?? 0,
  pendingCountsByTask: () => new Map(pendingCounts),
  terminalCountsByTask: () => new Map(terminalCounts),
};

beforeAll(async () => {
  dbm = await import("./db.ts");
  am = await import("./db-async.ts");
  workerDir = mkdtempSync(path.join(tmpdir(), "agetor-db-async-worker-"));
  const holder = { current: fakeDecorations };
  // One client per mode, built once (createDbAsync takes a getter, called per call).
  const inprocRpc = am.createDbRpc({ mode: "inprocess" });
  inproc = am.createDbAsync(() => inprocRpc, holder);
  workerRpc = am.createDbRpc({
    mode: "worker",
    dbPath: path.join(workerDir, "agetor.sqlite"),
    workerFactory: (dbPath) => {
      const w = new Worker(path.join(import.meta.dir, "core-worker.ts"));
      w.postMessage({ role: "db", dbPath, buildId: BUILD_ID });
      return w as never;
    },
  });
  worker = am.createDbAsync(() => workerRpc, holder);
  await workerRpc.dbReady();
});

afterAll(async () => {
  await workerRpc.closeDb({ timeoutMs: 1000 });
  for (const r of afterBare) await r.closeDb({ timeoutMs: 1000 }).catch(() => {});
  for (const id of inprocIds) dbm.tasks.delete(id);
  rmSync(workerDir, { recursive: true, force: true });
  rmTestDataDir(dataDir);
});

/** The same logical fixtures in both databases: a plain task with a pending
 *  interaction and open terminals, a pipeline parent, and its hidden step. */
function fixtures() {
  const base = Date.now();
  const plain = makeTask({ id: randomUUID(), title: "plain", createdAt: base + 3, updatedAt: base + 3 });
  const parent = makeTask({ id: randomUUID(), title: "parent", createdAt: base + 2, updatedAt: base + 2 });
  const step = makeTask({ id: randomUUID(), title: "step", createdAt: base + 1, updatedAt: base + 1, pipelineParentId: parent.id });
  return { plain, parent, step };
}

describe("facade parity, worker vs in-process", () => {
  test("tasks.get and tasks.list return identical, decorated Task JSON", async () => {
    const { plain, parent, step } = fixtures();
    const mine = new Set([plain.id, parent.id, step.id]);
    for (const t of [plain, parent, step]) {
      inprocIds.push(t.id);
      await inproc.tasks.insert(t);
      await worker.tasks.insert(t);
    }
    pendingCounts.clear();
    terminalCounts.clear();
    pendingCounts.set(plain.id, 1);
    terminalCounts.set(plain.id, 3);
    pendingCounts.set(step.id, 2);
    try {
      for (const t of [plain, parent, step]) {
        const a = await inproc.tasks.get(t.id);
        const b = await worker.tasks.get(t.id);
        expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      }
      const plainTask = (await worker.tasks.get(plain.id))!;
      expect(plainTask.pendingInteractionCount).toBe(1);
      expect(plainTask.openTerminalCount).toBe(3);

      const listA = (await inproc.tasks.list()).filter((t) => mine.has(t.id));
      const listB = (await worker.tasks.list()).filter((t) => mine.has(t.id));
      expect(listA.length).toBe(3);
      expect(JSON.stringify(listB)).toBe(JSON.stringify(listA));
      const byId = new Map(listB.map((t) => [t.id, t]));
      expect(byId.get(plain.id)!.pendingInteractionCount).toBe(1);
      expect(byId.get(step.id)!.pendingInteractionCount).toBe(2);
      // D11: the step's pending interactions are folded into its parent in a list.
      expect(byId.get(parent.id)!.pendingInteractionCount).toBe(2);
    } finally {
      pendingCounts.clear();
      terminalCounts.clear();
    }
  });

  test("a non-list Task result is decorated with the task's own counts", async () => {
    const t = makeTask();
    inprocIds.push(t.id);
    pendingCounts.set(t.id, 4);
    terminalCounts.set(t.id, 2);
    try {
      const inserted = await worker.tasks.insert(t);
      expect(inserted.pendingInteractionCount).toBe(4);
      expect(inserted.openTerminalCount).toBe(2);
      const marked = await worker.tasks.markSeen(t.id);
      expect(marked?.pendingInteractionCount).toBe(4);
    } finally {
      pendingCounts.clear();
      terminalCounts.clear();
    }
  });

  test("a Task an op returns carries the same badge counts as a module call, in worker mode", async () => {
    const t = makeTask();
    inprocIds.push(t.id);
    pendingCounts.set(t.id, 3);
    terminalCounts.set(t.id, 2);
    try {
      await worker.tasks.insert(t);
      // Array result with a hole: `orchestrator.getTasks` returns (Task | null)[].
      const viaOp = await worker.op("orchestrator.getTasks", [[t.id, "no-such-task"]]);
      expect(viaOp[1]).toBeNull();
      expect(viaOp[0]!.pendingInteractionCount).toBe(3);
      expect(viaOp[0]!.openTerminalCount).toBe(2);
      // The same call without the overlay (the raw client) reports zeros: the
      // overlay is what makes the two agree.
      const raw = await workerRpc.op("orchestrator.getTasks", [[t.id]]);
      expect(raw[0]!.pendingInteractionCount).toBe(0);
      // A single Task result, and a non-Task one left alone, through a fake client.
      const fake = {
        op: async (name: string) => (name === "single" ? { ...raw[0]! } : { count: 5 }),
        call: async () => [],
      } as never;
      const viaFake = am.createDbAsync(() => fake, { current: fakeDecorations });
      const single = await (viaFake.op as unknown as (n: string, a: unknown[]) => Promise<Task>)("single", []);
      expect(single.pendingInteractionCount).toBe(3);
      expect(await (viaFake.op as unknown as (n: string, a: unknown[]) => Promise<unknown>)("other", [])).toEqual({ count: 5 });
    } finally {
      pendingCounts.clear();
      terminalCounts.clear();
    }
  });

  test("with no decorations registered nothing is overlaid", async () => {
    const plain = createBare();
    const t = makeTask();
    inprocIds.push(t.id);
    pendingCounts.set(t.id, 9);
    try {
      await plain.worker.tasks.insert(t);
      expect((await plain.worker.tasks.get(t.id))!.pendingInteractionCount).toBe(0);
    } finally {
      pendingCounts.clear();
    }
  });

  test("a pipeline parent's get adds its steps' pending counts", async () => {
    const { parent, step } = fixtures();
    // Mark the parent as a real pipeline parent row.
    const asParent: Task = { ...parent, pipelineId: randomUUID() };
    inprocIds.push(asParent.id, step.id);
    const asStep: Task = { ...step, pipelineParentId: asParent.id };
    await inproc.tasks.insert(asParent);
    await inproc.tasks.insert(asStep);
    await worker.tasks.insert(asParent);
    await worker.tasks.insert(asStep);
    pendingCounts.set(asStep.id, 5);
    pendingCounts.set(asParent.id, 1);
    try {
      const a = await inproc.tasks.get(asParent.id);
      const b = await worker.tasks.get(asParent.id);
      expect(b!.pendingInteractionCount).toBe(6);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    } finally {
      pendingCounts.clear();
    }
  });
});

describe("a pipeline parent keeps its steps' pending counts on every Task-returning method", () => {
  async function pipelineFixture() {
    const { parent, step } = fixtures();
    const asParent: Task = { ...parent, pipelineId: randomUUID() };
    const asStep: Task = { ...step, pipelineParentId: asParent.id };
    inprocIds.push(asParent.id, asStep.id);
    for (const side of [inproc, worker]) {
      await side.tasks.insert(asParent);
      await side.tasks.insert(asStep);
    }
    pendingCounts.set(asStep.id, 5);
    pendingCounts.set(asParent.id, 1);
    return asParent;
  }

  test("tasks.update, tasks.markSeen and a backlog write: 6 in both modes, byte-identical", async () => {
    const parent = await pipelineFixture();
    try {
      const calls: Array<[string, (s: typeof inproc) => Promise<Task | null>]> = [
        ["tasks.update", (s) => s.tasks.update(parent.id, { title: "renamed" })],
        ["tasks.markSeen", (s) => s.tasks.markSeen(parent.id)],
        ["backlog.add", (s) => s.backlog.add(parent.id, { text: "note" })],
      ];
      for (const [label, fn] of calls) {
        const a = await fn(inproc);
        const b = await fn(worker);
        expect(b?.pendingInteractionCount, label).toBe(6);
        expect(a?.pendingInteractionCount, label).toBe(6);
        // Bytes, modulo the fields a write stamps with the clock or a fresh id.
        const strip = (t: Task | null) => JSON.stringify({ ...t, updatedAt: 0, backlog: (t?.backlog ?? []).map((i) => ({ ...i, id: "", createdAt: 0 })) });
        expect(strip(b), label).toBe(strip(a));
      }
    } finally {
      pendingCounts.clear();
    }
  });

  test("an idempotent overlay: the result passed through twice is unchanged", async () => {
    const parent = await pipelineFixture();
    try {
      const once = await worker.tasks.markSeen(parent.id);
      const again = await worker.tasks.get(parent.id);
      expect(once!.pendingInteractionCount).toBe(6);
      expect(again!.pendingInteractionCount).toBe(6);
    } finally {
      pendingCounts.clear();
    }
  });
});

describe("facade shape", () => {
  test("a facade module is never probed into an RPC by JSON.stringify, inspect or coercion", async () => {
    const calls: string[] = [];
    const spy = {
      mode: "inprocess" as const,
      onRevChanged: () => () => {},
      currentRev: () => 0,
      dbReady: async () => {},
      closeDb: async () => {},
      op: async () => { throw new Error("no ops here"); },
      call: async (m: string, method: string) => { calls.push(`${m}.${method}`); return null; },
    };
    const facade = am.createDbAsync(() => spy as never);
    const mod = facade.tasks as unknown as Record<PropertyKey, unknown>;
    for (const key of ["toJSON", "then", "constructor", "inspect", Symbol.for("nodejs.util.inspect.custom"), Symbol.toPrimitive, Symbol.iterator, Symbol.toStringTag]) {
      expect(mod[key], String(key)).toBeUndefined();
    }
    expect(JSON.stringify(facade.tasks)).toBe("{}");
    expect(typeof Bun.inspect(facade.tasks)).toBe("string");
    expect(String(`${Object.prototype.toString.call(facade.tasks)}`)).toContain("object");
    await Promise.resolve(facade.tasks);
    expect(calls).toEqual([]);
  });

  test("types: tasks.get is Promise<Task | null>, tasks.list is Promise<Task[]>", async () => {
    const get: Promise<Task | null> = worker.tasks.get("x");
    const list: Promise<Task[]> = worker.tasks.list();
    // @ts-expect-error a get is not a Promise<string>
    const wrong: Promise<string> = worker.tasks.get("x");
    await Promise.all([get, list, wrong.catch(() => undefined)]);
    expect(true).toBe(true);
  });

  test("module facades are not thenables and unknown methods reject", async () => {
    expect((worker.tasks as unknown as { then?: unknown }).then).toBeUndefined();
    const resolved = await Promise.resolve(worker.tasks);
    expect(resolved).toBe(worker.tasks);
    const bogus = (worker.tasks as unknown as { nope: () => Promise<unknown> }).nope();
    expect(await bogus.then(() => null, (e: Error) => e.message)).toContain("unknown db method");
  });

  test("the process-wide exports cover db.ts's module names and re-export its errors and constants", async () => {
    for (const name of [
      "tasks", "runs", "harnesses", "subagents", "preferences", "backlog", "drafts", "projects", "retentionSweeps",
      "claudeSessionSeen", "harnessAutoEnabled", "harnessSessionHandoffs", "harnessOrphanedCopies", "harnessUsage",
      "savedPrompts", "agentProfiles", "pipelines", "opencodeStoppedChildren", "opencodeWatchTombstones",
      "insertCursorAsk", "resolveCursorAsk", "listOpenCursorAsks", "hiddenClaudeSessionIds", "hiddenOpencodeSessionIds",
      "HarnessInUseError", "SESSION_ID_COLUMNS", "OPENCODE_CHILD_SOURCE_PREFIX", "dbReady", "closeDb", "op",
      "onRevChanged", "DbRestartingError", "DbUnavailableError", "setTaskDecorations",
    ]) {
      expect(name in am).toBe(true);
    }
    // Every module name db.ts exports is also exported here.
    const skip = new Set(["db", "default"]);
    for (const name of Object.keys(dbm)) {
      if (skip.has(name)) continue;
      expect(name in am).toBe(true);
    }
  });

  test("a non-task module returns its result untouched", async () => {
    const k = `facade-${randomUUID()}`;
    await worker.preferences.set(k, "v");
    expect(await worker.preferences.get(k)).toBe("v");
    expect(await worker.hiddenClaudeSessionIds()).toBeInstanceOf(Set);
  });
});

/** A worker facade with no decorations, over its own database file. */
function createBare() {
  const dir = mkdtempSync(path.join(workerDir, "bare-"));
  const rpc = am.createDbRpc({
    mode: "worker",
    dbPath: path.join(dir, "agetor.sqlite"),
    workerFactory: (dbPath) => {
      const w = new Worker(path.join(import.meta.dir, "core-worker.ts"));
      w.postMessage({ role: "db", dbPath, buildId: BUILD_ID });
      return w as never;
    },
  });
  afterBare.push(rpc);
  return { worker: am.createDbAsync(() => rpc) };
}
