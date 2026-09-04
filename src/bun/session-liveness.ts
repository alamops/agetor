/**
 * Fork-free tmux session liveness for the per-driver death watches.
 *
 * Before this module every death-watch tick — 400 ms, for every in-flight
 * run, for as long as the run lasted — forked a `tmux has-session` client via
 * `Bun.spawnSync`: 2.5 process spawns per second per running task, each one a
 * posix_spawn + dyld + a socket round-trip to the tmux server, with the main
 * process's event loop blocked for the duration. Profiled as the single
 * largest recurring CPU source in the main process with one task running
 * (`__posix_spawn` was the top non-idle leaf frame in a 5 s `sample`).
 *
 * `createDeathProbe` keeps the exact contract the watches already rely on
 * (`alive` / `gone` / `unreachable`, fed unchanged into `deathTickOutcome`)
 * but answers the overwhelmingly common case — "the session is still there"
 * — with a `kill(pid, 0)` syscall against the pane's process, which forks
 * nothing and costs microseconds. The authoritative tmux probe is reserved
 * for three things:
 *
 *   1. Confirming a death. A pid that has vanished is only ever reported
 *      `gone` once tmux itself says so, so the watches' transient-failure
 *      safety (`unreachable` never counts; `DEATH_MISS_THRESHOLD` consecutive
 *      `gone` probes) is untouched — this module can only ever *add* an
 *      `alive` answer, never invent a `gone` one.
 *   2. Periodic re-validation (`AUTHORITATIVE_EVERY_MS`). macOS recycles
 *      pids, so a pane pid that died and was re-issued to an unrelated
 *      process would otherwise read as alive forever. A scheduled tmux probe
 *      that reports `gone` while the pid still "lives" drops the cached pid,
 *      after which every tick is authoritative until the session is
 *      re-resolved — bounding a pid-reuse false-alive to one window.
 *   3. (Re)learning the pid — at most once per window. A tmux whose
 *      `list-panes` output we can't parse (the test fakes, an exotic build)
 *      therefore degrades to exactly the old one-fork-per-tick behaviour
 *      plus one extra fork per window, never to two forks per tick.
 *
 * Deliberately has no runtime import from `claude-tmux.ts` (only its
 * `SessionLiveness` type) so all four drivers can share it without a cycle;
 * the tmux-facing pieces (`sessionLiveness`, `panePidFor`) are injected.
 */
import type { SessionLiveness } from "./claude-tmux.ts";

/** How often the death watch re-runs the real `tmux has-session` probe even
 *  while the pane pid still answers `kill(pid, 0)` — the pid-reuse bound. */
export const AUTHORITATIVE_EVERY_MS = 10_000;

/** `kill(pid, 0)`: true when a process with this pid exists. EPERM means it
 *  exists but belongs to someone we can't signal — still alive. ESRCH (and
 *  any other failure) reads as gone; the authoritative probe has the final
 *  say either way, so a wrong "gone" here only costs one fork. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

export interface DeathProbeOptions {
  sessionName: string;
  /** The real tmux probe (`sessionLiveness`). Called only when the fast path
   *  can't vouch for the session, or when re-validation is due. Async since
   *  docs/plans/fix-task-details-load-delay.md (claude-tmux.ts's `tmux()`
   *  choke point moved off `Bun.spawnSync`) — a plain sync return still works
   *  (every caller `await`s the result either way). */
  authoritative: (sessionName: string) => SessionLiveness | Promise<SessionLiveness>;
  /** Maps a session name to its pane's pid (`panePidFor`); `null` when it
   *  can't. Called at most once per `authoritativeEveryMs`. Async for the same
   *  reason as `authoritative`. */
  resolvePid: (sessionName: string) => number | null | Promise<number | null>;
  /** Injectable for tests; defaults to the real `kill(pid, 0)`. Deliberately
   *  stays synchronous — it's a bare `kill(pid, 0)` syscall, not a subprocess,
   *  and is the whole point of the fast path this module exists to provide. */
  pidAlive?: (pid: number) => boolean;
  authoritativeEveryMs?: number;
  now?: () => number;
}

export interface DeathProbe {
  /** One death-watch tick's liveness verdict — drop-in for `sessionLiveness`.
   *  Async because the slow path awaits `authoritative`/`resolvePid`, which
   *  (as of the sync→async tmux conversion) fork a real `tmux` client; the
   *  fast `kill(pid, 0)` path still returns effectively immediately, just
   *  wrapped in the same Promise so callers don't need to branch. */
  probe(): Promise<SessionLiveness>;
  /** The pane pid currently trusted for the fast path, or null. Diagnostic /
   *  test surface only. */
  pid(): number | null;
}

export function createDeathProbe(opts: DeathProbeOptions): DeathProbe {
  const isAlive = opts.pidAlive ?? pidAlive;
  const every = opts.authoritativeEveryMs ?? AUTHORITATIVE_EVERY_MS;
  const now = opts.now ?? Date.now;
  let pid: number | null = null;
  let lastAuthoritativeAt = -Infinity;
  let lastResolveAt = -Infinity;
  return {
    pid: () => pid,
    async probe(): Promise<SessionLiveness> {
      const t = now();
      const due = t - lastAuthoritativeAt >= every;
      // Fast path: a known pid that still answers, inside the validation
      // window. No fork, no tmux round-trip.
      if (pid !== null && !due && isAlive(pid)) return "alive";
      // Slow path: the pid is unknown, has vanished, or re-validation is due.
      const liveness = await opts.authoritative(opts.sessionName);
      lastAuthoritativeAt = t;
      if (liveness === "gone") {
        // Whatever pid we held is stale (dead, or recycled by an unrelated
        // process — the case the periodic probe exists for). Forget it so
        // every tick until the session is re-resolved is authoritative and
        // the miss counter can actually reach its threshold.
        pid = null;
      } else if (liveness === "alive" && (pid === null || !isAlive(pid)) && t - lastResolveAt >= every) {
        // Session is up but we can't vouch for it cheaply — (re)learn the
        // pane pid, throttled so an unparseable `list-panes` can't turn every
        // tick into two forks.
        lastResolveAt = t;
        pid = await opts.resolvePid(opts.sessionName);
      }
      // `unreachable` keeps whatever pid we had: a busy tmux server says
      // nothing about the pane process, and the next tick's `kill(pid, 0)`
      // will vouch for it without needing the server at all.
      return liveness;
    },
  };
}
