import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rmTestDataDir } from "./test-data-dir.ts";

/* ────────────────────────────────────────────────────────────────────────── *
 * Responsiveness regression test — docs/plans/fix-task-details-load-delay.md
 * §1/§5 (TT1). The bug: `tmux()` (claude-tmux.ts) and the one-shot drivers'
 * `spawnSync`/`Bun.spawnSync` calls held Bun's single event-loop thread for
 * the full fork+exec+wait of every tmux invocation — so opening the
 * task-details panel (an ordinary HTTP GET) could stall for as long as
 * another task's warm-up tmux call took, because `Bun.serve` and the whole
 * orchestrator share that one thread. The fix (T1/T2) converts every
 * warm-up-path tmux invocation to `Bun.spawn` + `await proc.exited`, so the
 * wait happens off-thread and concurrent event-loop work (an HTTP response,
 * a timer, another awaited op) keeps flowing while a tmux child is alive.
 *
 * This file proves that property directly: point `AGETOR_TMUX_BIN` at a stub
 * that SLEEPS for a full second before exiting, call an op that hits the
 * tmux choke point, and race a 25ms `Bun.sleep` against it. Under the fixed
 * async implementation the probe returns in ~25ms regardless of how long the
 * tmux child takes. Under the old synchronous implementation the calling op
 * itself blocked the thread for ~1000ms before `killSessionByName` /
 * `sessionExists` / etc. even returned control to the caller — so the probe
 * could not have completed until ~1000ms had elapsed either, which is what
 * the 500ms assertion below (20x margin over the 25ms ideal, still 2x under
 * the 1000ms failure signal) catches. See the repo's flake-class rule: never
 * assert a tight wall-clock bound against a fake-tmux spawn — this bound is
 * structurally safe because the failure mode is >=1000ms, not "a bit slow".
 * ────────────────────────────────────────────────────────────────────────── */

// Pre-set AGETOR_DATA_DIR before claude-tmux.ts's/codex-tmux.ts's transitive
// db.ts import — a static top-level import would be hoisted and evaluated
// before any in-file assignment runs, capturing the wrong data dir (db.ts
// reads AGETOR_DATA_DIR once, at first import, across the whole `bun test`
// process — see claude-tmux-death.test.ts for the same pattern).
const testDataDir = mkdtempSync(path.join(tmpdir(), "agetor-evloop-data-"));
process.env.AGETOR_DATA_DIR = testDataDir;

// Stub tmux: sleeps 1s then exits 0, regardless of argv. Any op that hits
// the `tmux()` choke point pays that full second as CHILD process time —
// but under the fixed async spawn, that second belongs to the child, not to
// Bun's event-loop thread, so a concurrent `Bun.sleep` probe returns close
// to on-time. Under the old `Bun.spawnSync`/`spawnSync` implementation the
// whole process (including any other in-flight HTTP request) blocked for
// that same second.
const tmuxStubDir = mkdtempSync(path.join(tmpdir(), "agetor-evloop-tmux-"));
const tmuxBin = path.join(tmuxStubDir, "tmux");
writeFileSync(tmuxBin, "#!/bin/sh\nsleep 1\nexit 0\n");
chmodSync(tmuxBin, 0o755);
process.env.AGETOR_TMUX_BIN = tmuxBin;

const { killSessionByName, sessionExists } = await import("./claude-tmux.ts");
// codex-tmux.ts (T2: one-shot drivers) — `dropCodexSession` is a minimal,
// fully-representative T2 op: no prompt/log files, no tailer, no watcher to
// clean up (a fresh random taskId has no in-memory CodexSessionState, so it
// short-circuits straight to `await killSessionByName(...)`). This is
// deliberately NOT `spawnCodexViaTmux`: a real spawn writes a prompt/log
// file, starts a tailer with a file watcher + poll/death timers, and (since
// the stub never produces a `turn.completed` line) its `done` promise never
// resolves — none of that machinery is needed to prove the event loop stays
// free while a T2 driver's tmux call is in flight, and dragging it in would
// leave dangling timers/watchers this file would then have to reach into
// private state to tear down. `dropCodexSession` hits the exact same
// `tmux()` choke point through the T2 module's own async call path and
// resolves cleanly to `void`.
const { dropCodexSession } = await import("./codex-tmux.ts");

afterAll(() => {
  rmTestDataDir(testDataDir);
  rmSync(tmuxStubDir, { recursive: true, force: true });
});

/** 20x margin over the 25ms probe sleep, while staying 2x under the ~1000ms
 *  failure signal a blocked event loop would produce (see file header). */
const RESPONSIVENESS_BUDGET_MS = 500;
const PROBE_SLEEP_MS = 25;

/** Starts `op`, races a `PROBE_SLEEP_MS` sleep against it, and returns how
 *  long the probe itself took to get scheduled + wake (`elapsed`) alongside
 *  `op`'s eventual result. `elapsed` staying near `PROBE_SLEEP_MS` proves the
 *  event loop was free to service other work (a timer, here; an HTTP
 *  response, in production) while `op` was in flight. Always awaits `op` to
 *  completion before returning, so the caller can assert it produced a
 *  well-formed result and didn't hang. */
async function measureLoopDrift<T>(op: () => Promise<T>): Promise<{ elapsed: number; result: T }> {
  const t0 = performance.now();
  const p = op();
  await Bun.sleep(PROBE_SLEEP_MS);
  const elapsed = performance.now() - t0;
  const result = await p;
  return { elapsed, result };
}

test("killSessionByName (claude-tmux.ts, T1) does not block the event loop while its tmux child sleeps", async () => {
  const { elapsed, result } = await measureLoopDrift(() =>
    killSessionByName("agetor-nonexistent-test")
  );
  expect(elapsed).toBeLessThan(RESPONSIVENESS_BUDGET_MS);
  // Completed (didn't hang) and, being `void`, resolved to undefined — a
  // reintroduced sync spawn would either blow the elapsed budget above or,
  // if somehow fast, still prove nothing broke; the real regression this
  // guards is the timing assertion, this is the "didn't throw/hang" half.
  expect(result).toBeUndefined();
});

test("sessionExists (claude-tmux.ts, T1) does not block the event loop while its tmux child sleeps", async () => {
  const taskId = `evloop-${randomUUID()}`;
  const { elapsed, result } = await measureLoopDrift(() => sessionExists(taskId));
  expect(elapsed).toBeLessThan(RESPONSIVENESS_BUDGET_MS);
  // The stub always exits 0, so `has-session` reads as "exists" — asserting
  // `true` (rather than just "didn't throw") proves the op actually ran the
  // tmux call and parsed its result, not that it short-circuited.
  expect(result).toBe(true);
});

test("dropCodexSession (codex-tmux.ts, T2 one-shot driver) does not block the event loop while its tmux child sleeps", async () => {
  const taskId = `evloop-${randomUUID()}`;
  const { elapsed, result } = await measureLoopDrift(() => dropCodexSession(taskId));
  expect(elapsed).toBeLessThan(RESPONSIVENESS_BUDGET_MS);
  expect(result).toBeUndefined();
});
