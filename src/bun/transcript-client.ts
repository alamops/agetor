// Main-thread API for transcript reads (docs/plans/non-blocking-core.md, T7;
// the subagent watcher adopts it in T11).
//
//   const client = createTranscriptClient({ workerFactory: () => new Worker(...) });
//   const { lines, nextOffset, eof } = await client.readChunk(path, offset, 256 * 1024);
//   const meta = await client.readMeta(subagentsDir, id);
//
// Two modes:
//   * "worker": requests are posted to a Worker built by the injected
//     `workerFactory` (the core-worker entry, role `transcript`), so the stat,
//     read, UTF-8 decode and JSON.parse run off the main thread. The wire
//     contract is documented in workers/transcript-handler.ts.
//   * "inprocess": the same handler is called directly on the calling thread
//     (tests, and where a worker is unavailable).
// The default is "inprocess" under NODE_ENV=test and "worker" otherwise.
//
// Worker mode runs one request at a time, in call order (FIFO), so a reply is
// always matched to the request that is in flight. A crash (error event, exit,
// unserialisable reply) or a request that outlives `timeoutMs` terminates the
// worker, rejects the in-flight call and leaves queued calls to run on a fresh
// worker; restarts are capped (`maxRestartsPerWindow` per `restartWindowMs`),
// after which calls reject with a clear error until the window clears. A
// handler-level failure (`ok: false`) rejects only its own call.

import {
  handleTranscriptMessage,
  type ReadChunkReply,
  type TranscriptReply,
  type TranscriptRequest,
} from "./workers/transcript-handler.ts";
import type { TranscriptMeta } from "./transcript-parse.ts";

export type { ParsedLine, TranscriptMeta } from "./transcript-parse.ts";
export type { ReadChunkReply as TranscriptChunk } from "./workers/transcript-handler.ts";

/** The slice of the Worker API the client uses (Bun's `Worker` satisfies it). */
export interface TranscriptWorkerLike {
  postMessage(msg: unknown): void;
  terminate(): unknown;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
}

export type TranscriptClientMode = "worker" | "inprocess";

export interface TranscriptClientOptions {
  /** Defaults to "inprocess" under NODE_ENV=test, else "worker". */
  mode?: TranscriptClientMode;
  /** Builds a fresh worker; required in worker mode. Called again after a crash. */
  workerFactory?: () => TranscriptWorkerLike;
  /** Per-request budget in worker mode. Default 30 s. */
  timeoutMs?: number;
  /** Restarts allowed per `restartWindowMs`. Default 5. */
  maxRestartsPerWindow?: number;
  /** Sliding window for the restart cap. Default 60 s. */
  restartWindowMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export interface TranscriptClient {
  readonly mode: TranscriptClientMode;
  readChunk(path: string, offset: number, maxBytes: number): Promise<ReadChunkReply>;
  readMeta(dir: string, id: string): Promise<TranscriptMeta>;
  /** Terminate the worker and reject queued and in-flight calls. The client
   *  may not be used afterwards. */
  close(): void;
}

/** Error from a failed request; `code` is the errno-style code when known. */
export class TranscriptClientError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "TranscriptClientError";
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESTARTS = 5;
const DEFAULT_RESTART_WINDOW_MS = 60_000;

type RequestBody = Omit<TranscriptRequest, "id">;

interface Job {
  body: RequestBody;
  resolve: (reply: TranscriptReply) => void;
  reject: (err: Error) => void;
}

function defaultMode(): TranscriptClientMode {
  return process.env.NODE_ENV === "test" ? "inprocess" : "worker";
}

function unwrap<T>(reply: TranscriptReply): T {
  if (reply.ok) return reply.result as T;
  throw new TranscriptClientError(reply.error.message, reply.error.code);
}

export function createTranscriptClient(opts: TranscriptClientOptions = {}): TranscriptClient {
  const mode = opts.mode ?? defaultMode();
  if (mode === "worker" && !opts.workerFactory) {
    throw new TranscriptClientError("createTranscriptClient: worker mode needs a workerFactory");
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRestarts = opts.maxRestartsPerWindow ?? DEFAULT_MAX_RESTARTS;
  const windowMs = opts.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;
  const now = opts.now ?? Date.now;

  let seq = 0;
  let closed = false;

  // ---- in-process ----
  if (mode === "inprocess") {
    const call = async <T>(body: RequestBody): Promise<T> => {
      if (closed) throw new TranscriptClientError("transcript client is closed");
      const reply = await handleTranscriptMessage({ id: ++seq, ...body });
      return unwrap<T>(reply);
    };
    return {
      mode,
      readChunk: (path, offset, maxBytes) =>
        call<ReadChunkReply>({ op: "readChunk", args: { path, offset, maxBytes } }),
      readMeta: (dir, id) => call<TranscriptMeta>({ op: "readMeta", args: { dir, id } }),
      close() { closed = true; },
    };
  }

  // ---- worker ----
  const factory = opts.workerFactory!;
  const queue: Job[] = [];
  let worker: TranscriptWorkerLike | null = null;
  let active: { id: number; job: Job; timer: ReturnType<typeof setTimeout> } | null = null;
  const crashes: number[] = [];

  /** Drop the worker and fail the in-flight call. Queued calls stay queued and
   *  run on a fresh worker (subject to the restart cap). */
  function crash(failed: TranscriptWorkerLike, reason: string): void {
    if (worker !== failed) return; // a stale event from an already-replaced worker
    worker = null;
    crashes.push(now());
    try { void failed.terminate(); } catch { /* already gone */ }
    const cur = active;
    active = null;
    if (cur) {
      clearTimeout(cur.timer);
      cur.job.reject(new TranscriptClientError(`transcript worker failed: ${reason}`, "EWORKER"));
    }
    pump();
  }

  function onReply(from: TranscriptWorkerLike, data: unknown): void {
    if (worker !== from || !active) return;
    const reply = data as TranscriptReply | null;
    if (!reply || typeof reply !== "object" || reply.id !== active.id) return; // not ours: ignore
    const cur = active;
    active = null;
    clearTimeout(cur.timer);
    cur.job.resolve(reply);
    pump();
  }

  function startWorker(): TranscriptWorkerLike {
    const w = factory();
    worker = w;
    w.addEventListener("message", (ev) => onReply(w, (ev as { data?: unknown }).data));
    w.addEventListener("error", (ev) => {
      const e = ev as { message?: unknown; error?: { message?: unknown } };
      const m = e.error?.message ?? e.message;
      crash(w, typeof m === "string" && m ? m : "worker error");
    });
    w.addEventListener("messageerror", () => crash(w, "unserialisable worker reply"));
    w.addEventListener("close", () => crash(w, "worker exited"));
    return w;
  }

  function pump(): void {
    while (!active && queue.length > 0) {
      const job = queue.shift()!;
      if (closed) {
        job.reject(new TranscriptClientError("transcript client is closed"));
        continue;
      }
      let w = worker;
      if (!w) {
        const cutoff = now() - windowMs;
        while (crashes.length > 0 && crashes[0]! < cutoff) crashes.shift();
        if (crashes.length >= maxRestarts) {
          job.reject(
            new TranscriptClientError(
              `transcript worker restarted too often (${crashes.length} failures in ${windowMs} ms)`,
              "ERESTART",
            ),
          );
          continue;
        }
        try {
          w = startWorker();
        } catch (e) {
          crashes.push(now());
          job.reject(new TranscriptClientError(`transcript worker could not start: ${e instanceof Error ? e.message : String(e)}`, "EWORKER"));
          continue;
        }
      }
      const id = ++seq;
      const started = w;
      const timer = setTimeout(() => crash(started, `no reply within ${timeoutMs} ms`), timeoutMs);
      timer.unref?.();
      active = { id, job, timer };
      try {
        w.postMessage({ id, ...job.body });
      } catch (e) {
        crash(w, e instanceof Error ? e.message : String(e));
      }
    }
  }

  function call<T>(body: RequestBody): Promise<T> {
    if (closed) return Promise.reject(new TranscriptClientError("transcript client is closed"));
    return new Promise<TranscriptReply>((resolve, reject) => {
      queue.push({ body, resolve, reject });
      pump();
    }).then((reply) => unwrap<T>(reply));
  }

  return {
    mode,
    readChunk: (path, offset, maxBytes) => call<ReadChunkReply>({ op: "readChunk", args: { path, offset, maxBytes } }),
    readMeta: (dir, id) => call<TranscriptMeta>({ op: "readMeta", args: { dir, id } }),
    close() {
      if (closed) return;
      closed = true;
      const w = worker;
      worker = null;
      if (w) { try { void w.terminate(); } catch { /* already gone */ } }
      const cur = active;
      active = null;
      if (cur) {
        clearTimeout(cur.timer);
        cur.job.reject(new TranscriptClientError("transcript client is closed"));
      }
      for (const job of queue.splice(0)) job.reject(new TranscriptClientError("transcript client is closed"));
    },
  };
}
