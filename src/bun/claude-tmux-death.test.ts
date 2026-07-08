import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SESSION_DIED_STATUS_PREFIX } from "../shared/types.ts";

// Pre-set AGETOR_DATA_DIR before claude-tmux.ts's transitive db.ts import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-tmux-death-"));

const { __forTest, sessionLiveness, fileWrittenWithin } = await import("./claude-tmux.ts");

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

test("sessionLiveness: a transient server failure is unreachable, NOT gone", () => {
  // The regression: a busy/unreachable shared tmux server must never be read as
  // a dead session — that abandoned live, working sessions.
  for (const stderr of [
    "no server running on /tmp/tmux-501/default",
    "error connecting to /tmp/tmux-501/default (Resource temporarily unavailable)",
    "lost server",
    "", // a torn-down client can exit non-zero with no message
  ]) {
    const restore = fakeTmux(1, stderr);
    try { expect(sessionLiveness("agetor-x")).toBe("unreachable"); } finally { restore(); }
  }
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
