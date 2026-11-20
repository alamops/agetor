// The single worker entry. The first message names a role and carries its init;
// every later message goes to that role's handler:
//
//   { role: "db", dbPath }   open the database (migrations included), post
//                            { ready: true } or { ready: false, error }, then
//                            serve requests in arrival order (workers/db-handler.ts)
//   { role: "transcript" }   serve transcript reads (workers/transcript-handler.ts)
//
// Test-only: under NODE_ENV=test a `{ kind: "__crash" }` message exits the worker thread,
// so a test can prove the main thread restarts a dead worker. It is
// never honored outside tests.
//
// This file runs in a worker thread: it imports no main-thread module
// (db.ts, interactions, terminals, orchestrator, server).

import { handleDbMessage, openWorkerDb, type WorkerDb } from "./workers/db-handler.ts";
import { handleTranscriptMessage } from "./workers/transcript-handler.ts";

declare const self: {
  postMessage(msg: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
};

type Role = "db" | "transcript";
interface InitMessage {
  role: Role;
  dbPath?: string;
}

let role: Role | null = null;
let db: WorkerDb | null = null;
/** Set by the test-only crash message: the worker answers nothing more while it exits. */
let dying = false;

function isInit(msg: unknown): msg is InitMessage {
  return typeof msg === "object" && msg !== null
    && ((msg as InitMessage).role === "db" || (msg as InitMessage).role === "transcript");
}

function init(msg: InitMessage): void {
  role = msg.role;
  if (msg.role !== "db") return;
  try {
    if (typeof msg.dbPath !== "string" || msg.dbPath === "") throw new TypeError("db role needs a dbPath");
    db = openWorkerDb(msg.dbPath);
    self.postMessage({ ready: true });
  } catch (e) {
    self.postMessage({ ready: false, error: e instanceof Error ? e.message : String(e) });
  }
}

self.onmessage = (ev) => {
  if (dying) return;
  const msg = ev.data;
  if (role === null) {
    if (isInit(msg)) init(msg);
    return;
  }
  if (process.env.NODE_ENV === "test" && typeof msg === "object" && msg !== null && (msg as { kind?: unknown }).kind === "__crash") {
    // Exits the worker thread (not the process); the main thread sees `close`.
    // Not a throw: an uncaught worker error is printed at the top level of the
    // test runner. `process.exit` does not stop this handler synchronously, so
    // return right after it.
    dying = true;
    process.exit(1);
    return;
  }
  if (role === "transcript") {
    void handleTranscriptMessage(msg).then((reply) => self.postMessage(reply));
    return;
  }
  const id = typeof msg === "object" && msg !== null && typeof (msg as { id?: unknown }).id === "number"
    ? (msg as { id: number }).id
    : -1;
  if (!db) {
    self.postMessage({ id, ok: false, error: { name: "Error", message: "db worker has no open database" }, rev: 0 });
    return;
  }
  const reply = handleDbMessage(db, msg);
  try {
    self.postMessage(reply);
  } catch (e) {
    // A result that is not structured-clone safe fails its own call, not the worker.
    self.postMessage({
      id,
      ok: false,
      error: { name: "DbResultNotCloneable", message: e instanceof Error ? e.message : String(e) },
      rev: reply.rev,
    });
  }
};
