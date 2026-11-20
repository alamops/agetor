// The single worker entry. The first message names a role and carries its init;
// every later message goes to that role's handler:
//
//   { role: "db", dbPath }   open the database, post { migrating: true }, run the
//                            migrations, then post { ready: true } or
//                            { ready: false, error }, then serve requests in
//                            arrival order (workers/db-handler.ts)
//   { role: "transcript" }   serve transcript reads (workers/transcript-handler.ts)
//
// Messages a worker posts that are NOT replies to a request (none carries an
// `id`; a client must never treat one as a reply, and never echo one back):
//
//   { ready: true } | { ready: false, error }   db role: open and migrated, or failed
//   { migrating: true }    db role: the connection is open and migrations are about
//                          to run (synchronously, so no heartbeat can follow). The
//                          client stops its ready timer: only OPENING is timed.
//   { closed: true }       db role: the answer to `{ kind: "close" }`; the connection
//                          is closed (WAL checkpointed) and the client may terminate.
//   { log: { level, text } }   BOTH roles. The worker's own console is patched
//                          (log, info, warn, error, debug) so its output reaches
//                          the main thread, whose console is what core.log
//                          captures. `level` is "log" | "info" | "warn" | "error" |
//                          "debug"; `text` is the util.format of the arguments,
//                          cut to LOG_TEXT_MAX_CHARS characters. The main-thread
//                          client calls the matching `console[level]` with a
//                          `[agetor:db-worker]` / `[agetor:transcript-worker]` prefix.
//                          Nothing is printed in the worker itself.
//
// Messages the main thread may send besides requests (db role):
//
//   { kind: "close" }      close the connection, answer { closed: true }.
//
// Test-only: under NODE_ENV=test a `{ kind: "__crash" }` message exits the worker thread,
// so a test can prove the main thread restarts a dead worker, and a db init's
// `testMigrateDelayMs` stalls that long before the migrations (a stand-in for a
// slow one). Neither is honored outside tests.
//
// This file runs in a worker thread: it imports no main-thread module
// (db.ts, interactions, terminals, orchestrator, server).

import { format } from "node:util";
import { handleDbMessage, openWorkerDb, type WorkerDb } from "./workers/db-handler.ts";
import { handleTranscriptMessage } from "./workers/transcript-handler.ts";

declare const self: {
  postMessage(msg: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
};

/** Longest `text` a forwarded log message carries; longer output is cut with a marker. */
export const LOG_TEXT_MAX_CHARS = 8192;

function forwardConsole(): void {
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    console[level] = (...args: unknown[]) => {
      let text: string;
      try {
        text = format(...args);
      } catch {
        text = "[unprintable log arguments]";
      }
      if (text.length > LOG_TEXT_MAX_CHARS) text = `${text.slice(0, LOG_TEXT_MAX_CHARS)}... [truncated]`;
      try {
        self.postMessage({ log: { level, text } });
      } catch {
        // Never let logging fail a request.
      }
    };
  }
}
forwardConsole();

type Role = "db" | "transcript";
interface InitMessage {
  role: Role;
  dbPath?: string;
  testMigrateDelayMs?: number;
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
    const stallMs = process.env.NODE_ENV === "test" && typeof msg.testMigrateDelayMs === "number" ? msg.testMigrateDelayMs : 0;
    db = openWorkerDb(msg.dbPath, {
      beforeMigrate: () => {
        self.postMessage({ migrating: true });
        if (stallMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallMs);
      },
    });
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
  const kind = typeof msg === "object" && msg !== null ? (msg as { kind?: unknown }).kind : undefined;
  if (process.env.NODE_ENV === "test" && kind === "__crash") {
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
  if (kind === "close") {
    // Closing the connection checkpoints the WAL; the client terminates after the ack.
    try { db?.close(); } catch (e) { console.error("[agetor] db worker close failed:", e instanceof Error ? e.message : String(e)); }
    db = null;
    self.postMessage({ closed: true });
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
