// Main-thread client for the database (docs/plans/non-blocking-core.md, T8).
//
//   await dbReady();                                  // worker open + migrated
//   const task = await call("tasks", "get", [id]);    // a db-core method
//   const n = await op("__test.setPreferences", [...]); // a named atomic op
//   const off = onRevChanged((rev) => { ... });      // task revision moved
//
// Production code does not use this directly: `db-async.ts` wraps it in a typed
// facade with db.ts's module names.
//
// Two modes, chosen once from `AGETOR_DB_MODE` (`worker` | `inprocess`; default
// `inprocess` under NODE_ENV=test, else `worker`):
//   * worker: the one SQLite connection lives in a worker thread
//     (`core-worker.ts`, role `db`). Requests are posted in call order and
//     answered in that order (one thread, one message at a time), so a read
//     after a write sees the write. Each reply carries `task_rev_meta.rev`.
//   * inprocess: the same dispatcher runs against the `db.ts` singleton on the
//     calling thread (tests, and until callers move). `db.ts` is imported
//     dynamically so a worker-mode bundle never executes it.
//
// A worker that errors or exits rejects every in-flight call with
// `DbRestartingError` (logged with console.error, so it reaches core.log) and
// is restarted, at most `maxRestartsPerWindow` times per `restartWindowMs`;
// past that, calls reject with `DbUnavailableError` until the window passes.
// Calls made while the worker is starting, or between a crash and its restart,
// wait their turn rather than fail. A transaction never spans a thread hop:
// multi-statement work is a named op that runs whole inside the worker.
//
// OUTCOME UNKNOWN. A call that was in flight when the worker crashed or the
// client closed rejects with `DbRestartingError` (or `DbUnavailableError`), but
// the worker may already have committed it: only the reply was lost. The caller
// cannot tell. So NO layer (this client, the facade, a route handler, an HTTP
// client) may automatically retry a call that is not idempotent
// (`tasks.insert`, `backlog.add`, `runs.appendEvent`, `savedPrompts.insert`, ...):
// a retry could write twice. This client never retries a posted call. Only a
// caller that knows its call is idempotent, or that re-reads to find out, may retry.
//
// Worker output. The worker's console is forwarded as `{ log: { level, text } }`
// messages (core-worker.ts) and re-emitted here on the main-thread console with a
// `[agetor:db-worker]` prefix, so it reaches core.log. Such a message is data for
// the console only: it carries no id and is never answered.
//
// Ready timer. Only OPENING the database is timed (`readyTimeoutMs`). The worker
// posts `{ migrating: true }` once the connection is open, and the timer stops
// there, so a long migration is not killed. A worker that dies mid-migration is
// still seen through its `close`/`error` event.

import type { Database } from "bun:sqlite";
import {
  AgentProfileNameError,
  HarnessBuiltinError,
  HarnessInUseError,
  ImportedClaudeSessionTaken,
  ImportedOpencodeSessionTaken,
  PipelineNameError,
} from "./db-core/errors.ts";
import type { DbModules } from "./db-core/modules.ts";
import { executeDbRequest, serializeDbError, type DbErrorPayload, type DbReply } from "./workers/db-handler.ts";
import { resolveDbPath } from "./db-path.ts";
import { BUILD_ID } from "./build-id.ts";
import { createCoreWorker, type CoreWorkerLike } from "./worker-entry.ts";
import { markTasksChanged } from "./task-change-bus.ts";
import type { OpArgs, OpName, OpResult } from "./db-core/ops/index.ts";

export type DbMode = "worker" | "inprocess";

/** In-flight calls fail with this when the worker dies; the worker restarts.
 *
 *  The outcome of a write that was in flight is UNKNOWN: the worker may have
 *  committed it before the crash (or before `closeDb` terminated it), with only
 *  the reply lost. No layer may auto-retry a non-idempotent call on this error. */
export class DbRestartingError extends Error {
  constructor(reason: string) {
    super(`database worker restarting: ${reason}`);
    this.name = "DbRestartingError";
  }
}

/** The database cannot be reached: closed, failed to open, or restarted too often. */
export class DbUnavailableError extends Error {
  constructor(reason: string) {
    super(`database unavailable: ${reason}`);
    this.name = "DbUnavailableError";
  }
}

// ---- error reconstruction ----

const ERROR_CLASSES: Record<string, { prototype: Error }> = {
  AgentProfileNameError,
  HarnessBuiltinError,
  HarnessInUseError,
  ImportedClaudeSessionTaken,
  ImportedOpencodeSessionTaken,
  PipelineNameError,
};

/** Rebuild a worker-side error on the main thread. A known db-core class comes
 *  back as an instance of that class (so `instanceof` in callers still works)
 *  with its own fields restored; anything else is a plain `Error` that keeps its
 *  name, message, code and fields. */
export function reconstructDbError(payload: DbErrorPayload): Error {
  const known = Object.prototype.hasOwnProperty.call(ERROR_CLASSES, payload.name)
    ? ERROR_CLASSES[payload.name]
    : undefined;
  const err = known ? (Object.create(known.prototype) as Error) : new Error(payload.message);
  Object.defineProperty(err, "message", { value: payload.message, writable: true, configurable: true, enumerable: false });
  err.name = payload.name;
  if (known) {
    Object.defineProperty(err, "stack", { value: new Error(payload.message).stack, writable: true, configurable: true, enumerable: false });
  }
  if (payload.code !== undefined) (err as { code?: string }).code = payload.code;
  if (payload.data) Object.assign(err, payload.data);
  return err;
}

// ---- client ----

export interface DbRpcOptions {
  /** Defaults to the `AGETOR_DB_MODE` env var (`inprocess` is the kill switch and is honored anywhere, with a boot warning), then "inprocess" under NODE_ENV=test, else "worker". */
  mode?: DbMode;
  /** Worker mode: the database file. Defaults to `resolveDbPath()`. */
  dbPath?: string;
  /** Worker mode: builds a fresh worker; called again after a crash. */
  workerFactory?: (dbPath: string) => CoreWorkerLike;
  /** Worker mode: how long to wait for the worker to open and migrate. Default 30 s. */
  readyTimeoutMs?: number;
  /** Worker mode: restarts allowed per `restartWindowMs`. Default 5. */
  maxRestartsPerWindow?: number;
  /** Worker mode: sliding window for the restart cap. Default 60 s. */
  restartWindowMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export interface DbRpc {
  readonly mode: DbMode;
  /** Resolves once the database is open and migrated. */
  dbReady(): Promise<void>;
  call(module: string, method: string, args: readonly unknown[]): Promise<unknown>;
  op<K extends OpName>(name: K, args: OpArgs<K>): Promise<OpResult<K>>;
  /** Stop taking calls, wait for in-flight ones, then terminate the worker. */
  closeDb(opts?: { timeoutMs?: number }): Promise<void>;
  /** Fires with the new `rev` whenever a reply's rev is greater than the last seen. */
  onRevChanged(cb: (rev: number) => void): () => void;
  /** The highest `task_rev_meta.rev` seen so far (0 before any reply). */
  currentRev(): number;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESTARTS = 5;
const DEFAULT_RESTART_WINDOW_MS = 60_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3000;
const CLOSE_ACK_TIMEOUT_MS = 2000;

type WorkerLogLevel = "log" | "info" | "warn" | "error" | "debug";
const LOG_LEVELS: readonly WorkerLogLevel[] = ["log", "info", "warn", "error", "debug"];

/** Re-emit a worker's `{ level, text }` log message on the main-thread console. */
function forwardWorkerLog(log: unknown): void {
  if (typeof log !== "object" || log === null) return;
  const { level, text } = log as { level?: unknown; text?: unknown };
  if (typeof text !== "string") return;
  const method: WorkerLogLevel = LOG_LEVELS.includes(level as WorkerLogLevel) ? (level as WorkerLogLevel) : "log";
  console[method](`[agetor:db-worker] ${text}`);
}

interface Waiter {
  /** The request to post once the worker is ready; null for a `dbReady()` waiter. */
  request: { kind: "call" | "op"; module?: string; method?: string; name?: string; args: readonly unknown[] } | null;
  resolve(value: unknown): void;
  reject(err: Error): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/** Environment default, read when a client is created. */
function defaultMode(): DbMode {
  const fromEnv = process.env.AGETOR_DB_MODE;
  // `inprocess` is the plan's kill switch (docs/plans/non-blocking-core.md §5):
  // it runs the one connection on the main thread instead of the worker, a debug
  // escape hatch if the worker misbehaves. Honored anywhere and warned at boot
  // (getDbRpc). It never adds a second connection: in-process mode starts no worker.
  if (fromEnv === "worker" || fromEnv === "inprocess") return fromEnv;
  return process.env.NODE_ENV === "test" ? "inprocess" : "worker";
}

export function createDbRpc(opts: DbRpcOptions = {}): DbRpc {
  const mode = opts.mode ?? defaultMode();
  const now = opts.now ?? Date.now;
  const revListeners = new Set<(rev: number) => void>();
  let lastRev = 0;

  function noteRev(rev: number): void {
    if (!(rev > lastRev)) return;
    lastRev = rev;
    for (const cb of [...revListeners]) {
      try {
        cb(rev);
      } catch (e) {
        console.error("[agetor:db-rpc] onRevChanged listener threw:", toError(e).message);
      }
    }
    markTasksChanged("rev");
  }

  const base = {
    mode,
    onRevChanged(cb: (rev: number) => void): () => void {
      revListeners.add(cb);
      return () => { revListeners.delete(cb); };
    },
    currentRev: () => lastRev,
  };

  return mode === "inprocess" ? inProcessClient(base, noteRev) : workerClient(base, noteRev, opts, now);
}

// ---- in-process ----

type Base = Pick<DbRpc, "mode" | "onRevChanged" | "currentRev">;

function inProcessClient(base: Base, noteRev: (rev: number) => void): DbRpc {
  interface Loaded { conn: Database; modules: DbModules; readRev(): number }
  let loading: Promise<Loaded> | null = null;
  let closed = false;

  function load(): Promise<Loaded> {
    // Dynamic import only: a worker-mode bundle never executes db.ts.
    loading ??= import("./db.ts").then((m) => {
      const modules = {
        harnesses: m.harnesses,
        harnessSessionHandoffs: m.harnessSessionHandoffs,
        harnessOrphanedCopies: m.harnessOrphanedCopies,
        harnessStore: { resetOrphanStampForTests: m.resetOrphanStampForTests },
        harnessUsage: m.harnessUsage,
        tasks: m.tasks,
        backlog: m.backlog,
        drafts: m.drafts,
        projects: m.projects,
        preferences: m.preferences,
        retentionSweeps: m.retentionSweeps,
        claudeSessionSeen: m.claudeSessionSeen,
        harnessAutoEnabled: m.harnessAutoEnabled,
        savedPrompts: m.savedPrompts,
        agentProfiles: m.agentProfiles,
        pipelines: m.pipelines,
        runs: m.runs,
        subagents: m.subagents,
        opencodeStoppedChildren: m.opencodeStoppedChildren,
        opencodeWatchTombstones: m.opencodeWatchTombstones,
        cursorAsks: {
          insertCursorAsk: m.insertCursorAsk,
          resolveCursorAsk: m.resolveCursorAsk,
          listOpenCursorAsks: m.listOpenCursorAsks,
        },
        hiddenSessionIds: {
          hiddenClaudeSessionIds: m.hiddenClaudeSessionIds,
          hiddenOpencodeSessionIds: m.hiddenOpencodeSessionIds,
        },
      } satisfies DbModules;
      const revQuery = m.db.query<{ rev: number }, []>(`SELECT rev FROM task_rev_meta WHERE id = 1`);
      return { conn: m.db, modules, readRev: () => revQuery.get()?.rev ?? 0 };
    });
    return loading;
  }

  // Worker mode hands the worker a structured clone of the arguments (taken when
  // the call is posted) and the caller a structured clone of the result, and
  // rebuilds an error from its serialised form. Do all three here too, always,
  // so a method that returns a class instance, a function or a live object, a
  // caller that mutates its arguments or a returned object, or code that relies
  // on an error's identity behaves the same in both modes.
  async function run(request: Record<string, unknown>): Promise<unknown> {
    const args = structuredClone(request.args); // synchronous: a later caller mutation cannot reach the call
    if (closed) throw new DbUnavailableError("db client is closed");
    const loaded = await load();
    try {
      const result = executeDbRequest(loaded, { ...request, args });
      try {
        return structuredClone(result);
      } catch (e) {
        throw reconstructDbError({ name: "DbResultNotCloneable", message: toError(e).message });
      }
    } catch (e) {
      if (e instanceof Error && e.name === "DbResultNotCloneable") throw e;
      // Same path as a worker reply: serialise, clone, rebuild.
      throw reconstructDbError(structuredClone(serializeDbError(e)));
    } finally {
      noteRev(loaded.readRev());
    }
  }

  return {
    ...base,
    dbReady: async () => { await load(); },
    call: (module, method, args) => run({ kind: "call", module, method, args }),
    op: (name, args) => run({ kind: "op", name, args }) as Promise<never>,
    // The db.ts singleton is shared by the whole process, so closing it is not
    // ours to do. A quit still checkpoints the WAL, as the worker's close does:
    // the kill switch must not leave a long WAL behind. Never throws (a busy
    // checkpoint returns a result row, and the short busy_timeout bounds the wait).
    closeDb: async () => {
      if (closed) return;
      closed = true;
      if (!loading) return;
      try {
        const loaded = await loading;
        loaded.conn.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch (e) {
        console.error("[agetor:db-rpc] in-process checkpoint on close failed:", toError(e).message);
      }
    },
  };
}

// ---- worker ----

function workerClient(
  base: Base,
  noteRev: (rev: number) => void,
  opts: DbRpcOptions,
  now: () => number,
): DbRpc {
  const dbPath = opts.dbPath ?? resolveDbPath();
  const factory = opts.workerFactory ?? ((p: string) => createCoreWorker("db", { dbPath: p }));
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const maxRestarts = opts.maxRestartsPerWindow ?? DEFAULT_MAX_RESTARTS;
  const windowMs = opts.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;

  let seq = 0;
  let worker: CoreWorkerLike | null = null;
  let ready = false;
  let closing = false;
  let closed = false;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Calls (and `dbReady` waiters) not yet posted, in arrival order. */
  let waiting: Waiter[] = [];
  const pending = new Map<number, Pending>();
  const crashes: number[] = [];
  let drainWaiters: Array<() => void> = [];
  /** Set once a worker reported a different build id: the client then refuses every
   *  call instead of starting another worker from the same mismatched bundle. */
  let refusal: string | null = null;
  /** Set while `closeDb` waits for the worker's `{ closed: true }`. */
  let closeAck: (() => void) | null = null;

  function crashesInWindow(): number {
    const cutoff = now() - windowMs;
    while (crashes.length > 0 && crashes[0]! < cutoff) crashes.shift();
    return crashes.length;
  }

  function settleDrain(): void {
    if (pending.size > 0 || waiting.length > 0) return;
    const ws = drainWaiters;
    drainWaiters = [];
    for (const w of ws) w();
  }

  function clearReadyTimer(): void {
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = null;
  }

  function failWaiting(err: Error): void {
    const ws = waiting;
    waiting = [];
    for (const w of ws) w.reject(err);
  }

  function post(w: CoreWorkerLike, waiter: Waiter): void {
    const id = ++seq;
    pending.set(id, { resolve: waiter.resolve, reject: waiter.reject });
    try {
      w.postMessage({ id, ...waiter.request });
    } catch (e) {
      // Arguments that cannot be structured-cloned fail this call only.
      pending.delete(id);
      waiter.reject(toError(e));
    }
  }

  function flush(w: CoreWorkerLike): void {
    const ws = waiting;
    waiting = [];
    for (const waiter of ws) {
      if (waiter.request === null) waiter.resolve(undefined);
      else post(w, waiter);
    }
    settleDrain();
  }

  /** The worker died or never opened. `restart` is false for an open failure,
   *  which is retried by the next call instead of in a tight loop. */
  function down(w: CoreWorkerLike, reason: string, restart: boolean): void {
    if (worker !== w) return; // a stale event from an already-replaced worker
    worker = null;
    ready = false;
    clearReadyTimer();
    crashes.push(now());
    try { void w.terminate(); } catch { /* already gone */ }
    console.error(`[agetor:db-rpc] database worker down: ${reason}`);
    const inflight = [...pending.values()];
    pending.clear();
    const err = new DbRestartingError(reason);
    for (const p of inflight) p.reject(err);
    if (closing) {
      closeAck?.(); // the worker is gone; nothing left to wait for
      closeAck = null;
      failWaiting(new DbUnavailableError("db client is closed"));
      settleDrain();
      return;
    }
    if (!restart) {
      failWaiting(new DbUnavailableError(reason));
      return;
    }
    if (crashesInWindow() > maxRestarts) {
      console.error(`[agetor:db-rpc] database worker crashed ${crashes.length} times in ${windowMs} ms; not restarting`);
      failWaiting(new DbUnavailableError(`worker restarted too often (${crashes.length} failures in ${windowMs} ms)`));
      return;
    }
    console.error("[agetor:db-rpc] restarting database worker");
    start();
  }

  function onMessage(w: CoreWorkerLike, data: unknown): void {
    if (worker !== w || typeof data !== "object" || data === null) return;
    const msg = data as Record<string, unknown>;
    if ("log" in msg) {
      forwardWorkerLog(msg.log);
      return; // never a reply, never answered
    }
    if ("migrating" in msg) {
      // The connection is open; migrations may legitimately take a long time.
      if (!ready) clearReadyTimer();
      return;
    }
    if ("closed" in msg) {
      const ack = closeAck;
      closeAck = null;
      ack?.();
      return;
    }
    if ("ready" in msg) {
      if (ready) return;
      if (msg.buildMismatch === true || (msg.ready === true && msg.buildId !== BUILD_ID)) {
        // The worker bundle is from another build than this code. Never let it
        // (or a restart of it) serve a call; a newer one would also have run its
        // migrations under this older core.
        const theirs = typeof msg.buildId === "string" ? msg.buildId : "unknown";
        refusal = `core worker build mismatch: worker ${theirs}, main thread ${BUILD_ID}; restart Agetor`;
        down(w, refusal, false);
        return;
      }
      if (msg.ready === true) {
        ready = true;
        clearReadyTimer();
        flush(w);
      } else {
        const why = typeof msg.error === "string" ? msg.error : "unknown error";
        down(w, `worker could not open the database: ${why}`, false);
      }
      return;
    }
    const reply = data as DbReply;
    const p = pending.get(reply.id);
    if (!p) return;
    pending.delete(reply.id);
    noteRev(reply.rev);
    if (reply.ok) p.resolve(reply.result);
    else p.reject(reconstructDbError(reply.error));
    settleDrain();
  }

  function start(): void {
    let w: CoreWorkerLike;
    try {
      w = factory(dbPath);
    } catch (e) {
      crashes.push(now());
      failWaiting(new DbUnavailableError(`worker could not start: ${toError(e).message}`));
      return;
    }
    worker = w;
    ready = false;
    w.addEventListener("message", (ev) => onMessage(w, (ev as { data?: unknown }).data));
    w.addEventListener("error", (ev) => {
      const e = ev as { message?: unknown; error?: { message?: unknown } };
      const m = e.error?.message ?? e.message;
      down(w, typeof m === "string" && m ? m : "worker error", true);
    });
    w.addEventListener("messageerror", () => down(w, "unserialisable worker message", true));
    w.addEventListener("close", () => down(w, "worker exited", true));
    clearReadyTimer();
    readyTimer = setTimeout(() => down(w, `worker not ready within ${readyTimeoutMs} ms`, false), readyTimeoutMs);
    readyTimer.unref?.();
  }

  function enqueue(request: Waiter["request"]): Promise<unknown> {
    if (closing || closed) return Promise.reject(new DbUnavailableError("db client is closed"));
    if (refusal !== null) return Promise.reject(new DbUnavailableError(refusal));
    return new Promise<unknown>((resolve, reject) => {
      if (!worker) {
        if (crashesInWindow() > maxRestarts) {
          reject(new DbUnavailableError(`worker restarted too often (${crashes.length} failures in ${windowMs} ms)`));
          return;
        }
        start();
        if (!worker) {
          reject(new DbUnavailableError("worker could not start"));
          return;
        }
      }
      const waiter: Waiter = { request, resolve, reject };
      // Posting directly is only FIFO-safe when nothing is waiting ahead of us.
      if (ready && waiting.length === 0 && worker) {
        if (request === null) resolve(undefined);
        else post(worker, waiter);
      } else {
        waiting.push(waiter);
      }
    });
  }

  return {
    ...base,
    dbReady: async () => { await enqueue(null); },
    call: (module, method, args) => enqueue({ kind: "call", module, method, args }),
    op: (name, args) => enqueue({ kind: "op", name, args }) as Promise<never>,
    async closeDb({ timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS } = {}): Promise<void> {
      if (closed) return;
      closing = true;
      if (pending.size > 0 || waiting.length > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
          drainWaiters.push(() => { clearTimeout(timer); resolve(); });
        });
      }
      closed = true;
      clearReadyTimer();
      const w = worker;
      // Let the worker close its connection (which checkpoints the WAL) before it
      // is terminated; bounded, because a wedged worker must not hang the quit.
      if (w && ready) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { closeAck = null; resolve(); }, CLOSE_ACK_TIMEOUT_MS);
          timer.unref?.();
          closeAck = () => { clearTimeout(timer); resolve(); };
          try {
            w.postMessage({ kind: "close" });
          } catch {
            clearTimeout(timer);
            closeAck = null;
            resolve();
          }
        });
      }
      worker = null;
      ready = false;
      if (w) { try { void w.terminate(); } catch { /* already gone */ } }
      const err = new DbUnavailableError("db client closed before the call completed");
      const inflight = [...pending.values()];
      pending.clear();
      for (const p of inflight) p.reject(err);
      failWaiting(err);
    },
  };
}

// ---- the process-wide client ----

let defaultRpc: DbRpc | null = null;
let modeLogged = false;

/** The process-wide client, created on first use from the environment. */
export function getDbRpc(): DbRpc {
  if (!defaultRpc) {
    defaultRpc = createDbRpc();
    if (!modeLogged) {
      modeLogged = true;
      if (defaultRpc.mode === "inprocess" && process.env.NODE_ENV !== "test") {
        console.warn(
          "[agetor:db-rpc] database mode: inprocess (AGETOR_DB_MODE kill switch): SQLite runs on the main thread, so a heavy query can stall the app",
        );
      } else {
        console.info(`[agetor:db-rpc] database mode: ${defaultRpc.mode}`);
      }
    }
  }
  return defaultRpc;
}

/** Test seam: drop the process-wide client so the next use re-reads the environment. */
export function resetDbRpcForTests(): void {
  const dropped = defaultRpc;
  defaultRpc = null;
  // Close it so a worker-mode client does not leave its thread (and connection) running.
  void dropped?.closeDb({ timeoutMs: 500 }).catch(() => {});
}

export const dbReady = (): Promise<void> => getDbRpc().dbReady();
export const call = (module: string, method: string, args: readonly unknown[]): Promise<unknown> =>
  getDbRpc().call(module, method, args);
export const op = <K extends OpName>(name: K, args: OpArgs<K>): Promise<OpResult<K>> => getDbRpc().op(name, args);
export const closeDb = (opts?: { timeoutMs?: number }): Promise<void> => getDbRpc().closeDb(opts);
export const onRevChanged = (cb: (rev: number) => void): (() => void) => getDbRpc().onRevChanged(cb);
export const currentRev = (): number => getDbRpc().currentRev();
