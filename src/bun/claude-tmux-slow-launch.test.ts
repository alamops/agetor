import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

/* ────────────────────────────────────────────────────────────────────────── *
 * U3 — docs/plans/task-details-blank-while-session-restores.md §3.2/§4 (T2)
 * /§5 (U3). `spawnClaudeViaTmux` times its three awaited pre-launch stages
 * (`killTaskSession`, `ensureInstalledForCwd`, `tmux new-session`); when
 * their combined total exceeds `SLOW_LAUNCH_WARN_MS` it logs a
 * `console.warn` breakdown and emits one `status` chunk naming the slow
 * stage(s) — purely observability, never a control-flow change (see
 * claude-tmux.ts around `SLOW_LAUNCH_WARN_MS`/`formatSlowLaunchStatus`/
 * `spawnClaudeViaTmux`). This file covers:
 *   (a) the pure formatter (`formatSlowLaunchStatus`) — exact string/rounding
 *   (b) the test seam's save/restore contract (`setSlowLaunchWarnMs`)
 *   (c) an integration test driving `spawnClaudeViaTmux` itself through a
 *       stub tmux binary whose `new-session` sleeps, proving the breadcrumb
 *       actually fires (and, in the negative case, doesn't) through the real
 *       code path — not just the formatter in isolation.
 * ────────────────────────────────────────────────────────────────────────── */

// Pre-set AGETOR_DATA_DIR before claude-tmux.ts's transitive db.ts import — a
// static top-level import would be hoisted ahead of any in-file assignment
// (see event-loop-responsiveness.test.ts / claude-tmux-death.test.ts for the
// same pattern). db.ts reads AGETOR_DATA_DIR once, at first import, across
// the whole `bun test` process.
const testDataDir = mkdtempSync(path.join(tmpdir(), "agetor-slow-launch-data-"));
process.env.AGETOR_DATA_DIR = testDataDir;

const {
  SLOW_LAUNCH_WARN_MS,
  setSlowLaunchWarnMs,
  formatSlowLaunchStatus,
  spawnClaudeViaTmux,
  dropSession,
  jsonlPathFor,
} = await import("./claude-tmux.ts");

afterAll(() => {
  // Leave the module-level seam at its default for any other test file that
  // shares this `bun test` process — mirrors setContinuationWatchdogMs's
  // save/restore contract (see claude-tmux.ts's doc on `setSlowLaunchWarnMs`).
  setSlowLaunchWarnMs(null);
  rmTestDataDir(testDataDir);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * (a) formatSlowLaunchStatus — pure, no side effects, no tmux/db involved.
 * ────────────────────────────────────────────────────────────────────────── */

test("formatSlowLaunchStatus formats the stage breakdown with a one-decimal total", () => {
  expect(
    formatSlowLaunchStatus({ killMs: 4000, settingsMs: 1200, newSessionMs: 300 }),
  ).toBe("session launch took 5.5s (kill 4000ms · settings 1200ms · tmux new-session 300ms)");
});

test("formatSlowLaunchStatus rounds only the displayed total, not the per-stage ms values", () => {
  expect(
    formatSlowLaunchStatus({ killMs: 0, settingsMs: 0, newSessionMs: 5001 }),
  ).toBe("session launch took 5.0s (kill 0ms · settings 0ms · tmux new-session 5001ms)");
});

test("formatSlowLaunchStatus handles a sub-second total", () => {
  expect(
    formatSlowLaunchStatus({ killMs: 1, settingsMs: 2, newSessionMs: 3 }),
  ).toBe("session launch took 0.0s (kill 1ms · settings 2ms · tmux new-session 3ms)");
});

test("formatSlowLaunchStatus sums all three stages into the total, not just the largest", () => {
  // 2500 + 2500 + 2500 = 7500ms = 7.5s — no single stage alone would round to
  // that total, so this pins that the total is a genuine sum.
  expect(
    formatSlowLaunchStatus({ killMs: 2500, settingsMs: 2500, newSessionMs: 2500 }),
  ).toBe("session launch took 7.5s (kill 2500ms · settings 2500ms · tmux new-session 2500ms)");
});

/* ────────────────────────────────────────────────────────────────────────── *
 * (b) setSlowLaunchWarnMs — save/restore seam contract.
 * ────────────────────────────────────────────────────────────────────────── */

test("setSlowLaunchWarnMs returns the previous value, and null restores SLOW_LAUNCH_WARN_MS", () => {
  // Module starts at the default (nothing has overridden it yet in this file).
  expect(setSlowLaunchWarnMs(1000)).toBe(SLOW_LAUNCH_WARN_MS);
  expect(setSlowLaunchWarnMs(2000)).toBe(1000);
  expect(setSlowLaunchWarnMs(null)).toBe(2000);
  // Default is restored — the next override's reported "previous" value
  // proves it, without needing a getter.
  expect(setSlowLaunchWarnMs(3000)).toBe(SLOW_LAUNCH_WARN_MS);
  setSlowLaunchWarnMs(null);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * (c) Integration: drive spawnClaudeViaTmux itself through a stub tmux whose
 * `new-session` sleeps, proving the breadcrumb fires through the real spawn
 * path (not just the formatter). The JSONL is pre-created at the
 * deterministic path spawnClaudeViaTmux expects (same trick
 * claude-turn-routing.test.ts's "launchEffort" tests use), so the
 * fire-and-forget boot-wait IIFE resolves on `waitForJsonlAt`'s synchronous
 * `existsSync` fast path instead of the 30s BOOT_TIMEOUT_MS poller — this is
 * what keeps the test from needing to wait out (or race) that timer.
 * ────────────────────────────────────────────────────────────────────────── */

type Chunk = { stream: string; data: string };

/** Executable stub tmux: `new-session` sleeps `sleepMs` (via a synchronous
 *  `Atomics.wait` — no top-level `await` needed in the shebang'd script)
 *  before exiting 0; every other subcommand (kill-session, has-session,
 *  capture-pane, …) exits 0 immediately. Mirrors `fakeRoutingTmuxBin`'s
 *  argv-based stub shape (claude-turn-routing.test.ts) but keyed on
 *  presence of the literal `"new-session"` argv element rather than
 *  `"has-session"`. */
function makeSlowNewSessionTmuxBin(sleepMs: number): { bin: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-slow-launch-tmux-"));
  const bin = path.join(dir, "tmux");
  writeFileSync(
    bin,
    `#!${process.execPath}\n` +
      `const argv = process.argv.slice(2);\n` +
      `if (argv.includes("new-session")) {\n` +
      `  const sab = new Int32Array(new SharedArrayBuffer(4));\n` +
      `  Atomics.wait(sab, 0, 0, ${sleepMs});\n` +
      `}\n` +
      `process.exit(0);\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, dir };
}

/** Shared setup/teardown for the two integration cases below: writes the
 *  stub tmux, points AGETOR_TMUX_BIN at it, pre-creates the session's JSONL,
 *  spawns via spawnClaudeViaTmux, collects chunks, and restores every seam
 *  it touched — env var, threshold, and the temp dirs it created. */
async function runSpawnWithStubTmux(opts: {
  newSessionSleepMs: number;
  warnThresholdMs: number;
}): Promise<Chunk[]> {
  const savedTmuxBin = process.env.AGETOR_TMUX_BIN;
  const prevThreshold = setSlowLaunchWarnMs(opts.warnThresholdMs);
  const { bin, dir: tmuxDir } = makeSlowNewSessionTmuxBin(opts.newSessionSleepMs);
  process.env.AGETOR_TMUX_BIN = bin;

  const taskId = `task-slow-launch-${randomUUID()}`;
  const sessionId = randomUUID();
  const cwd = mkdtempSync(path.join(tmpdir(), "agetor-slow-launch-cwd-"));
  const jsonlPath = jsonlPathFor(cwd, sessionId, null);
  mkdirSync(path.dirname(jsonlPath), { recursive: true });
  writeFileSync(jsonlPath, "");

  const chunks: Chunk[] = [];
  try {
    const agent = await spawnClaudeViaTmux({
      taskId,
      argv: ["claude", "--session-id", sessionId, "hello"],
      env: {},
      cwd,
      onChunk: (stream, data) => {
        chunks.push({ stream, data });
      },
      sessionId,
      configDir: null,
      mode: null,
    });
    // `done` never resolves in this fake-tmux harness (no real claude turn
    // ever completes) and dropSession's teardown below rejects it — swallow
    // that here so it never surfaces as an unhandled rejection (same
    // pattern claude-turn-routing.test.ts's "launchEffort" tests use).
    agent.done.catch(() => {});

    // Let the fire-and-forget boot-wait IIFE settle (attachTailer + the
    // "ready (jsonl: …)" status chunk) before we inspect/tear down — the
    // pre-created JSONL means this resolves near-instantly rather than
    // waiting out BOOT_TIMEOUT_MS.
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    await dropSession(taskId);
    setSlowLaunchWarnMs(prevThreshold);
    if (savedTmuxBin === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = savedTmuxBin;
    rmSync(path.dirname(jsonlPath), { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(tmuxDir, { recursive: true, force: true });
  }
  return chunks;
}

test("spawnClaudeViaTmux emits the slow-launch breadcrumb before the ready status when the launch is slow", async () => {
  // Threshold well under the stub's new-session sleep, so kill+settings+new-
  // session's combined total is guaranteed to cross it.
  const chunks = await runSpawnWithStubTmux({ newSessionSleepMs: 400, warnThresholdMs: 200 });

  const breadcrumbIdx = chunks.findIndex(
    (c) => c.stream === "status" && c.data.includes("session launch took"),
  );
  const readyIdx = chunks.findIndex(
    (c) => c.stream === "status" && c.data.includes("ready (jsonl:"),
  );

  expect(breadcrumbIdx).toBeGreaterThanOrEqual(0);
  expect(chunks[breadcrumbIdx]!.data).toMatch(
    /^session launch took \d+\.\ds \(kill \d+ms · settings \d+ms · tmux new-session \d+ms\)$/,
  );
  // The breadcrumb is emitted synchronously right after `tmux new-session`
  // resolves, before the boot-wait IIFE's own "ready" status — it must never
  // be sandwiched after it (see spawnClaudeViaTmux's doc comment above the
  // breadcrumb block).
  expect(readyIdx).toBeGreaterThan(breadcrumbIdx);
});

test("spawnClaudeViaTmux does not emit a slow-launch breadcrumb when the launch is under threshold", async () => {
  // Threshold set far above the stub's new-session sleep — the combined
  // pre-launch total can never cross it, so no breadcrumb should fire even
  // though the launch itself still takes real wall-clock time.
  const chunks = await runSpawnWithStubTmux({ newSessionSleepMs: 50, warnThresholdMs: 5_000_000 });

  const breadcrumbIdx = chunks.findIndex(
    (c) => c.stream === "status" && c.data.includes("session launch took"),
  );
  const readyIdx = chunks.findIndex(
    (c) => c.stream === "status" && c.data.includes("ready (jsonl:"),
  );

  expect(breadcrumbIdx).toBe(-1);
  // Sanity: the spawn itself still completed normally (ready chunk present)
  // — the negative assertion above isn't just "nothing happened at all".
  expect(readyIdx).toBeGreaterThanOrEqual(0);
});
