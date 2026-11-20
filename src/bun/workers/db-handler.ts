// Worker-side handler for the database role. `src/bun/core-worker.ts` (role
// `db`) opens the connection with `openWorkerDb` and passes each message it
// receives to `handleDbMessage`.
//
// Message contract (structured-clone friendly):
//
//   request  { id, kind: "call", module, method, args }   a db-core method
//            { id, kind: "op",   name,   args }           a named atomic op
//   reply    { id, ok: true,  result, rev }
//            { id, ok: false, error: { name, message, code?, data? }, rev }
//
// `rev` is `task_rev_meta.rev` read after the request ran, so the main thread
// learns about task changes without a second round trip. `data` carries an
// error's own enumerable fields (a `HarnessInUseError`'s `taskIds`, …) so the
// main thread can rebuild the same class.
//
// One thread handles one message at a time, in arrival order: reads after
// writes are consistent. A request names a module and a method; both must be
// OWN properties and the method a function, so `constructor`, `__proto__` and
// prototype members never resolve. Nothing here evaluates code.
//
// This module must stay free of main-thread side effects: no db.ts,
// interactions, terminals, orchestrator or server.

import { Database } from "bun:sqlite";
import { migrate } from "../migrate.ts";
import { migrations } from "../migrations/index.ts";
import { applyConnectionPragmas } from "../db-core/connection.ts";
import { buildDbModules, type DbModules } from "../db-core/modules.ts";
import { findOp, runOp } from "../db-core/ops/index.ts";

export type DbRequest =
  | { id: number; kind: "call"; module: string; method: string; args: unknown[] }
  | { id: number; kind: "op"; name: string; args: unknown[] };

export interface DbErrorPayload {
  name: string;
  message: string;
  code?: string;
  data?: Record<string, unknown>;
}

export type DbReply =
  | { id: number; ok: true; result: unknown; rev: number }
  | { id: number; ok: false; error: DbErrorPayload; rev: number };

export interface WorkerDb {
  readonly conn: Database;
  readonly modules: DbModules;
  /** `task_rev_meta.rev`. */
  readRev(): number;
  close(): void;
}

/** Open the database, apply the pragmas, run the migrations and instantiate
 *  every db-core module (task decorations stay at their zero default: the main
 *  thread overlays them). */
export function openWorkerDb(dbPath: string): WorkerDb {
  const conn = new Database(dbPath);
  try {
    applyConnectionPragmas(conn);
    const applied = migrate(conn, migrations);
    if (applied.length) console.log(`[agetor] applied migrations: ${applied.join(", ")}`);
    const modules = buildDbModules(conn);
    const revQuery = conn.query<{ rev: number }, []>(`SELECT rev FROM task_rev_meta WHERE id = 1`);
    return {
      conn,
      modules,
      readRev: () => revQuery.get()?.rev ?? 0,
      close: () => conn.close(),
    };
  } catch (e) {
    try { conn.close(); } catch { /* the open already failed */ }
    throw e;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

const own = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** Serialise a thrown value. Own enumerable fields ride along in `data` (a
 *  `message`/`stack`/`name` is not an enumerable own field of an Error, so they
 *  are named explicitly). */
export function serializeDbError(e: unknown): DbErrorPayload {
  if (!(e instanceof Error)) return { name: "Error", message: String(e) };
  const payload: DbErrorPayload = { name: e.name, message: e.message };
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string") payload.code = code;
  const data: Record<string, unknown> = {};
  for (const key of Object.keys(e)) {
    if (key === "code" || key === "name" || key === "message") continue;
    data[key] = (e as unknown as Record<string, unknown>)[key];
  }
  if (Object.keys(data).length > 0) payload.data = data;
  return payload;
}

/** Run one request against the modules and return its result; throws on a
 *  malformed request, an unknown module/method/op, or a failing method. Shared
 *  by the worker and by in-process mode so both validate identically. */
export function executeDbRequest(target: { conn: Database; modules: DbModules }, msg: unknown): unknown {
  if (!isObject(msg) || !Array.isArray(msg.args)) {
    throw new TypeError("db request needs an args array");
  }
  const args = msg.args as unknown[];
  if (msg.kind === "call") {
    const { module, method } = msg;
    if (typeof module !== "string" || typeof method !== "string") {
      throw new TypeError("db call needs a module and a method name");
    }
    if (!own(target.modules, module)) throw new TypeError(`unknown db module: ${module}`);
    const mod = (target.modules as unknown as Record<string, unknown>)[module];
    if (!isObject(mod) || !own(mod, method) || typeof mod[method] !== "function") {
      throw new TypeError(`unknown db method: ${module}.${method}`);
    }
    return (mod[method] as (...a: unknown[]) => unknown).apply(mod, args);
  }
  if (msg.kind === "op") {
    const { name } = msg;
    const def = typeof name === "string" ? findOp(name) : null;
    if (!def) throw new TypeError(`unknown db op: ${String(name)}`);
    return runOp(def, { conn: target.conn, modules: target.modules }, args);
  }
  throw new TypeError("db request kind must be call or op");
}

/** Handle one request. Never throws: a malformed request or a failing method
 *  comes back as `ok: false`. */
export function handleDbMessage(db: WorkerDb, msg: unknown): DbReply {
  const id = isObject(msg) && typeof msg.id === "number" ? msg.id : -1;
  try {
    return { id, ok: true, result: executeDbRequest(db, msg), rev: db.readRev() };
  } catch (e) {
    return { id, ok: false, error: serializeDbError(e), rev: safeRev(db) };
  }
}

function safeRev(db: WorkerDb): number {
  try { return db.readRev(); } catch { return 0; }
}
