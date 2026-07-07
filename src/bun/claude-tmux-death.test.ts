import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SESSION_DIED_STATUS_PREFIX } from "../shared/types.ts";

// Pre-set AGETOR_DATA_DIR before claude-tmux.ts's transitive db.ts import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-tmux-death-"));

const { __forTest } = await import("./claude-tmux.ts");

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
