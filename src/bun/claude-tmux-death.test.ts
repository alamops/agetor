import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SESSION_DIED_STATUS_PREFIX } from "../shared/types.ts";

// Pre-set AGETOR_DATA_DIR before claude-tmux.ts's transitive db.ts import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-tmux-death-"));

const { __forTest, sessionLiveness, fileWrittenWithin, deathTickOutcome } = await import("./claude-tmux.ts");

/** Write an executable fake `tmux` that emits `stderr` and exits `code`, then
 *  point AGETOR_TMUX_BIN at it. Returns a restore fn. */
function fakeTmux(code: number, stderr: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-faketmux-"));
  const bin = path.join(dir, "tmux");
  writeFileSync(bin, `#!/bin/sh\n>&2 printf '%s' ${JSON.stringify(stderr)}\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  const prev = process.env.AGETOR_TMUX_BIN;
  process.env.AGETOR_TMUX_BIN = bin;
  return () => {
    if (prev === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = prev;
  };
}

interface Recorded { stream: string; data: string }
function recorder() {
  const out: Recorded[] = [];
  return {
    out,
    onChunk: (stream: string, data: string) => out.push({ stream, data }),
  };
}

function freshSession() {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-death-"));
  const jsonlPath = path.join(dir, `${randomUUID()}.jsonl`);
  writeFileSync(jsonlPath, "");
  const taskId = randomUUID();
  const state = __forTest.installSession(taskId, jsonlPath);
  return { taskId, jsonlPath, state };
}

test("signalSessionDeath settles the in-flight turn and emits the session-died sentinel", async () => {
  const { taskId, state } = freshSession();
  const rec = recorder();
  try {
    // A turn is in flight: push a slot whose `done` promise the driver awaits.
    const done = __forTest.pushTurnSlot(state, rec.onChunk);
    expect(__forTest.turnInFlight(state)).toBe(true);

    __forTest.signalSessionDeath(state);

    // The turn's promise resolves (with 0 — the orchestrator distinguishes a
    // death from success via the handle flag, not the exit code).
    const code = await done;
    expect(code).toBe(0);

    // A sentinel status chunk was emitted so the orchestrator flips to
    // `blocked` and the user sees why the run stopped.
    const sentinel = rec.out.find(
      (c) => c.stream === "status" && c.data.startsWith(SESSION_DIED_STATUS_PREFIX),
    );
    expect(sentinel).toBeDefined();

    // The slot was consumed — no longer in flight.
    expect(__forTest.turnInFlight(state)).toBe(false);
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("signalSessionDeath is a no-op when no turn is in flight (idle session death)", async () => {
  const { taskId, state } = freshSession();
  const rec = recorder();
  try {
    // No slot pushed and no reattach onEndOfTurn → not in flight.
    expect(__forTest.turnInFlight(state)).toBe(false);

    __forTest.signalSessionDeath(state);

    // Nothing emitted — an idle session dying between turns isn't a "running
    // task" problem, so we don't surface a spurious blocked event.
    expect(rec.out.length).toBe(0);
  } finally {
    __forTest.uninstallSession(taskId);
  }
});

test("sessionLiveness: exit 0 is alive", () => {
  const restore = fakeTmux(0, "");
  try { expect(sessionLiveness("agetor-x")).toBe("alive"); } finally { restore(); }
});

test("sessionLiveness: 'can't find session' with a responsive server is gone", () => {
  const restore = fakeTmux(1, "can't find session: agetor-x");
  try { expect(sessionLiveness("agetor-x")).toBe("gone"); } finally { restore(); }
});

test("sessionLiveness: any ambiguous / unknown failure is unreachable, never a death", () => {
  // The regression: a busy shared tmux server too swamped to answer, an ambiguous
  // connect error, or ANY string we don't recognize must never be read as a dead
  // session — that's what abandoned live, working sessions. We don't know the
  // incident's exact transient string, so the unknown case must be conservative.
  for (const stderr of [
    "error connecting to /tmp/tmux-501/default (Resource temporarily unavailable)",
    "resource temporarily unavailable",
    "error connecting to /tmp/tmux-501/default (No such file or directory)", // ambiguous
    "some unrecognized tmux error", // unknown → conservative
    "", // a torn-down client can exit non-zero with no diagnostics
  ]) {
    const restore = fakeTmux(1, stderr);
    try { expect(sessionLiveness("agetor-x")).toBe("unreachable"); } finally { restore(); }
  }
});

test("sessionLiveness: only an UNAMBIGUOUS dead session or dead server is gone", () => {
  // During an in-flight turn our own session keeps the shared server alive, so
  // "no server running"/"lost server" means the server died WITH our session — a
  // real death. "session not found" is the server saying our session is absent.
  // These strings are never emitted spuriously, so they're safe to fire on.
  for (const stderr of [
    "can't find session: agetor-x",
    "session not found: agetor-x",
    "no such session: agetor-x",
    "no server running on /tmp/tmux-501/default",
    "lost server",
  ]) {
    const restore = fakeTmux(1, stderr);
    try { expect(sessionLiveness("agetor-x")).toBe("gone"); } finally { restore(); }
  }
});

test("deathTickOutcome: only consecutive gone+stale ticks fire; alive/unreachable/fresh-log reset", () => {
  const t = 4;
  // A live or merely-unreachable probe always resets, regardless of accumulated misses.
  expect(deathTickOutcome({ liveness: "alive", logFresh: false, misses: 3, threshold: t })).toBe("reset");
  expect(deathTickOutcome({ liveness: "unreachable", logFresh: false, misses: 3, threshold: t })).toBe("reset");
  // A `gone` probe is vetoed by a freshly-written log (agent provably alive).
  expect(deathTickOutcome({ liveness: "gone", logFresh: true, misses: 3, threshold: t })).toBe("reset");
  // `gone` + stale log accumulates, then fires on the threshold-th consecutive tick.
  expect(deathTickOutcome({ liveness: "gone", logFresh: false, misses: 0, threshold: t })).toBe("wait");
  expect(deathTickOutcome({ liveness: "gone", logFresh: false, misses: 2, threshold: t })).toBe("wait");
  expect(deathTickOutcome({ liveness: "gone", logFresh: false, misses: 3, threshold: t })).toBe("fire");
});

test("fileWrittenWithin: true for a just-written file, false once it ages out, false when missing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-recency-"));
  const f = path.join(dir, "log.jsonl");
  writeFileSync(f, "x");
  expect(fileWrittenWithin(f, 3_000)).toBe(true);
  // Backdate the mtime well past the window.
  const old = Date.now() / 1000 - 60;
  utimesSync(f, old, old);
  expect(fileWrittenWithin(f, 3_000)).toBe(false);
  expect(fileWrittenWithin(path.join(dir, "nope.jsonl"), 3_000)).toBe(false);
});

test("signalSessionDeath fires the reattach onEndOfTurn hook when there's no slot", async () => {
  const { taskId, state } = freshSession();
  try {
    // Reattached in-flight run: no in-process slot, but an onEndOfTurn hook the
    // orchestrator installed so it can flip the run row on completion.
    let fired = false;
    state.onEndOfTurn = () => { fired = true; };
    expect(__forTest.turnInFlight(state)).toBe(true);

    __forTest.signalSessionDeath(state);

    expect(fired).toBe(true);
    // Fire-once: the hook is cleared so a stray later tick can't double-fire.
    expect(state.onEndOfTurn).toBeNull();
    expect(__forTest.turnInFlight(state)).toBe(false);
  } finally {
    __forTest.uninstallSession(taskId);
  }
});
