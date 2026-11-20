// The two db-worker steps both entry points (index.ts, headless.ts) share:
// wait for the worker's DB to be open and migrated before the boot gate opens,
// and drain the core log and close the worker on the way out
// (docs/plans/non-blocking-core.md §3).

import { closeDb, dbReady } from "./db-async.ts";
import { flushCoreLog } from "./core-log.ts";

export const DB_READY_BACKOFF_START_MS = 500;
export const DB_READY_BACKOFF_MAX_MS = 15_000;
/** Ceiling on the whole quit drain: the log flush plus the worker close. */
export const QUIT_DRAIN_MAX_MS = 5_000;
export const DB_CLOSE_TIMEOUT_MS = 3_000;

export interface AwaitDbReadyDeps {
  ready?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** True once the process is shutting down: stop retrying. */
  isStopped?: () => boolean;
  /** Reaches core.log (console.error is teed there). */
  logError?: (msg: string) => void;
  backoffStartMs?: number;
  backoffMaxMs?: number;
}

/**
 * Resolves once the db worker has opened the database and run migrations.
 * A rejection (the worker could not start, or restarted too often) is logged
 * and retried with a capped, doubling backoff: a core that cannot open its DB
 * must not open the boot gate, and must not exit either, since the failure may
 * be transient. Never rejects. Resolves `false` only when `isStopped()` ends
 * the wait, so the caller can skip the rest of boot.
 */
export async function awaitDbReady(deps: AwaitDbReadyDeps = {}): Promise<boolean> {
  const ready = deps.ready ?? dbReady;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const logError = deps.logError ?? ((m: string) => console.error(m));
  const max = deps.backoffMaxMs ?? DB_READY_BACKOFF_MAX_MS;
  let delay = deps.backoffStartMs ?? DB_READY_BACKOFF_START_MS;
  for (;;) {
    if (deps.isStopped?.()) return false;
    try {
      await ready();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      logError(`[agetor] database not ready, retrying in ${delay} ms: ${msg}`);
      await sleep(delay);
      delay = Math.min(delay * 2, max);
    }
  }
}

export interface QuitDrainDeps {
  flush?: () => Promise<void>;
  close?: (opts: { timeoutMs: number }) => Promise<void>;
  maxMs?: number;
  closeTimeoutMs?: number;
}

/**
 * Graceful-quit tail: flush the core log, then close the db worker. Bounded by
 * `maxMs` in total, never rejects, so a quit can never hang on it.
 */
export async function drainCoreForQuit(deps: QuitDrainDeps = {}): Promise<void> {
  const flush = deps.flush ?? flushCoreLog;
  const close = deps.close ?? closeDb;
  const work = (async () => {
    try {
      await flush();
    } catch {
      /* logging never blocks a quit */
    }
    try {
      await close({ timeoutMs: deps.closeTimeoutMs ?? DB_CLOSE_TIMEOUT_MS });
    } catch {
      /* the process is exiting; the worker dies with it */
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deps.maxMs ?? QUIT_DRAIN_MAX_MS);
  });
  try {
    await Promise.race([work, bound]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Ceiling on the whole desktop quit sequence: the quit effects plus the drain. */
export const QUIT_SEQUENCE_MAX_MS = 8_000;

export interface QuitSequenceDeps {
  /** The quit's own effects (supervisor stop, OpenCode stop, creds removal).
   *  They may touch the database, so they run BEFORE the worker is closed. */
  effects: () => Promise<void> | void;
  drain?: () => Promise<void>;
  maxMs?: number;
  log?: (msg: string) => void;
}

/**
 * Effects first, then the drain (flush core.log, close the db worker), the
 * whole thing bounded by `maxMs`. A failing effect is logged and the drain
 * still runs; on timeout it logs and returns so the caller quits anyway.
 * Never rejects.
 */
export async function runQuitSequence(deps: QuitSequenceDeps): Promise<void> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const drain = deps.drain ?? drainCoreForQuit;
  let timedOut = false;
  const work = (async () => {
    try {
      await deps.effects();
    } catch (err) {
      log(`[agetor] quit effects failed: ${String(err)}`);
    }
    await drain();
  })().catch((err) => log(`[agetor] quit sequence failed: ${String(err)}`));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, deps.maxMs ?? QUIT_SEQUENCE_MAX_MS);
  });
  try {
    await Promise.race([work, bound]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (timedOut) log("[agetor] quit sequence timed out; quitting anyway");
}

export interface QuitSequencerDeps {
  /** The bounded effects-then-drain sequence (`runQuitSequence`). Runs once. */
  run: () => Promise<void>;
  /** Re-issue the quit once the sequence is done (`armForceQuit` + `Utils.quit()`). */
  requeue: (opts: { completely: boolean }) => void;
}

/**
 * The desktop before-quit state machine around the quit sequence. Call
 * `allowQuit` where the handler would allow the quit: `false` means veto
 * (the first pass starts the sequence; a quit during it is absorbed and only
 * its `completely` is kept), `true` means the sequence is done, let it through
 * and apply nothing.
 */
export function createQuitSequencer(deps: QuitSequencerDeps): { allowQuit(completely: boolean): boolean } {
  let state: "idle" | "running" | "done" = "idle";
  let completelyWanted = false;
  return {
    allowQuit(completely: boolean): boolean {
      if (state === "done") return true;
      completelyWanted = completelyWanted || completely;
      if (state === "idle") {
        state = "running";
        void deps.run().finally(() => {
          state = "done";
          deps.requeue({ completely: completelyWanted });
        });
      }
      return false;
    },
  };
}
