/* ────────────────────────────────────────────────────────────────────────── *
 * Gate tests for the turn-stall watchdog (2dot2dot code-review incident
 * 2026-08-15: an `/auto-mode-setup` wizard the pane scraper had no matcher
 * for froze an in-flight review turn for 13 minutes while the card showed a
 * healthy green "running" — no JSONL writes, no signal anywhere).
 *
 * Three layers, same harness as claude-tmux-death.test.ts:
 *   1. `stallTickOutcome` — the pure per-tick decision (mirror of
 *      `deathTickOutcome`).
 *   2. `checkTurnStall` driven against a synthetic session via
 *      `__forTest.installSession` — sentinel emission, latch, resume, and
 *      the silent clear when the turn ends while marked.
 *   3. `subagentActivityWithin` — the veto probe (a parent turn quietly
 *      waiting on live background agents is normal, not a wedge).
 * ────────────────────────────────────────────────────────────────────────── */

import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TURN_STALLED_STATUS_PREFIX, TURN_STALL_RESUMED_STATUS_PREFIX } from "../shared/types.ts";

// Pre-set AGETOR_DATA_DIR before claude-tmux.ts's transitive db.ts import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-tmux-stall-"));

const { __forTest, stallTickOutcome, TURN_STALL_DEFAULT_MS } = await import("./claude-tmux.ts");
const { subagentActivityWithin } = await import("./claude-subagents.ts");
const { subagents, tasks } = await import("./db.ts");

/** Minimal task row so subagent inserts satisfy the FK. */
function seedTask(): string {
  const id = randomUUID();
  const now = Date.now();
  tasks.insert({
    id, title: "t", prompt: "x", column: "running", agent: "claude-code",
    workdir: "/tmp", isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: "auto", model: null, effort: null,
    fast: false, maxMode: false, references: [], backlog: [], plans: [], draft: null, runId: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    createdAt: now, updatedAt: now, archivedAt: null,
  });
  return id;
}

const never = () => false;
const always = () => true;

afterEach(() => {
  delete process.env.AGETOR_TURN_STALL_MS;
});

/* ── 1. stallTickOutcome ─────────────────────────────────────────────────── */

test("stallTickOutcome: quiet in-flight turn past threshold fires once, then holds", () => {
  const base = { turnInFlight: true, thresholdMs: 100, subagentsFresh: never };
  expect(stallTickOutcome({ ...base, quietMs: 99, fired: false })).toBe("none");
  expect(stallTickOutcome({ ...base, quietMs: 100, fired: false })).toBe("fire");
  // Latched — the same continuous stall never re-fires.
  expect(stallTickOutcome({ ...base, quietMs: 5_000, fired: true })).toBe("none");
});

test("stallTickOutcome: activity returning mid-turn clears live; turn ending clears silently", () => {
  const base = { thresholdMs: 100, subagentsFresh: never };
  // Quiet dropped under threshold (a flush stamped the append clock) while
  // the turn is still going → announce the recovery.
  expect(stallTickOutcome({ ...base, turnInFlight: true, quietMs: 10, fired: true })).toBe("clear-live");
  // Turn over → unlatch without an event (the done handler owns that clear).
  expect(stallTickOutcome({ ...base, turnInFlight: false, quietMs: 5_000, fired: true })).toBe("clear-silent");
  // Nothing armed, nothing in flight → nothing at all.
  expect(stallTickOutcome({ ...base, turnInFlight: false, quietMs: 5_000, fired: false })).toBe("none");
});

test("stallTickOutcome: live subagent activity vetoes the fire (and clears an existing mark)", () => {
  const base = { turnInFlight: true, quietMs: 5_000, thresholdMs: 100 };
  expect(stallTickOutcome({ ...base, fired: false, subagentsFresh: always })).toBe("none");
  // A subagent waking up counts as recovery for an already-marked turn too.
  expect(stallTickOutcome({ ...base, fired: true, subagentsFresh: always })).toBe("clear-live");
});

test("stallTickOutcome: the veto thunk is not consulted below the threshold", () => {
  let asked = false;
  const spy = () => { asked = true; return false; };
  stallTickOutcome({ turnInFlight: true, quietMs: 10, thresholdMs: 100, fired: false, subagentsFresh: spy });
  expect(asked).toBe(false);
});

/* ── 2. checkTurnStall against a synthetic session ───────────────────────── */

interface Recorded { stream: string; data: string }
function recorder() {
  const out: Recorded[] = [];
  return { out, onChunk: (stream: string, data: string) => out.push({ stream, data }) };
}

function freshSession() {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-stall-"));
  const jsonlPath = path.join(dir, `${randomUUID()}.jsonl`);
  writeFileSync(jsonlPath, "");
  const taskId = randomUUID();
  const state = __forTest.installSession(taskId, jsonlPath);
  return { taskId, jsonlPath, state };
}

test("checkTurnStall: fires the sentinel once on a quiet in-flight turn, resumes on activity", () => {
  process.env.AGETOR_TURN_STALL_MS = "50";
  const { taskId, state } = freshSession();
  const rec = recorder();
  void __forTest.pushTurnSlot(state, rec.onChunk);

  // Fresh turn — quiet clock floored at install time, still under threshold.
  __forTest.checkTurnStall(state);
  expect(rec.out).toHaveLength(0);

  // Age the clock past the threshold.
  state.stallFloorAt = Date.now() - 60;
  __forTest.checkTurnStall(state);
  expect(rec.out).toHaveLength(1);
  expect(rec.out[0]!.stream).toBe("status");
  expect(rec.out[0]!.data.startsWith(TURN_STALLED_STATUS_PREFIX)).toBe(true);
  // The hint names the exact tmux session so the user can attach.
  expect(rec.out[0]!.data).toContain(state.sessionName);

  // Latched — a second tick on the same stall stays quiet.
  __forTest.checkTurnStall(state);
  expect(rec.out).toHaveLength(1);

  // Transcript activity returns (what `flush` stamps on real appended
  // bytes) → one resume sentinel, then quiet again.
  state.lastJsonlAppendAt = Date.now();
  __forTest.checkTurnStall(state);
  expect(rec.out).toHaveLength(2);
  expect(rec.out[1]!.data.startsWith(TURN_STALL_RESUMED_STATUS_PREFIX)).toBe(true);
  __forTest.checkTurnStall(state);
  expect(rec.out).toHaveLength(2);

  __forTest.uninstallSession(taskId);
});

test("checkTurnStall: includes the last scraped pane lines when available", () => {
  process.env.AGETOR_TURN_STALL_MS = "1";
  const { taskId, state } = freshSession();
  const rec = recorder();
  void __forTest.pushTurnSlot(state, rec.onChunk);
  state.stallFloorAt = Date.now() - 10;
  state.scrapeLastPaneText = "Set up auto mode for your environment?\n  Continue\n  Esc to cancel";
  __forTest.checkTurnStall(state);
  expect(rec.out).toHaveLength(1);
  expect(rec.out[0]!.data).toContain("last screen:");
  expect(rec.out[0]!.data).toContain("Set up auto mode");
  __forTest.uninstallSession(taskId);
});

test("checkTurnStall: a turn that ends while marked unlatches silently, and an idle session never fires", () => {
  process.env.AGETOR_TURN_STALL_MS = "1";
  const { taskId, state } = freshSession();
  const rec = recorder();
  void __forTest.pushTurnSlot(state, rec.onChunk);
  state.stallFloorAt = Date.now() - 10;
  __forTest.checkTurnStall(state);
  expect(rec.out).toHaveLength(1);

  // Turn settles (what popEndOfTurn does to the queue) — the next tick must
  // reset the latch WITHOUT emitting a resume banner after the fact.
  const slot = state.turnQueue.shift()!;
  slot.resolve?.(0);
  __forTest.checkTurnStall(state);
  expect(rec.out).toHaveLength(1);
  expect(state.stallFired).toBe(false);

  // Idle session (no turn in flight), however quiet — never fires.
  state.stallFloorAt = Date.now() - 60_000;
  __forTest.checkTurnStall(state);
  expect(rec.out).toHaveLength(1);

  __forTest.uninstallSession(taskId);
});

test("default threshold is 10 minutes (long tool calls write no JSONL — anything shorter false-positives)", () => {
  expect(TURN_STALL_DEFAULT_MS).toBe(600_000);
});

/* ── 3. subagentActivityWithin ───────────────────────────────────────────── */

function seedSubagent(taskId: string, opts: { status: "running" | "completed"; mtimeAgoMs: number }): void {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-stall-sub-"));
  const file = path.join(dir, `agent-${randomUUID()}.jsonl`);
  writeFileSync(file, "{}\n");
  const then = new Date(Date.now() - opts.mtimeAgoMs);
  utimesSync(file, then, then);
  subagents.insertIfAbsent({
    id: randomUUID(),
    taskId,
    runId: null,
    parentKind: "subagent",
    agentType: "Explore",
    description: null,
    spawnDepth: 1,
    sourcePath: file,
    toolUseId: null,
    status: opts.status,
    startedAt: Date.now() - 60_000,
    endedAt: opts.status === "completed" ? Date.now() : null,
  });
}

test("subagentActivityWithin: fresh running subagent → true; stale or settled → false", () => {
  const freshTask = seedTask();
  seedSubagent(freshTask, { status: "running", mtimeAgoMs: 0 });
  expect(subagentActivityWithin(freshTask, 60_000)).toBe(true);

  const staleTask = seedTask();
  seedSubagent(staleTask, { status: "running", mtimeAgoMs: 120_000 });
  expect(subagentActivityWithin(staleTask, 60_000)).toBe(false);

  // A settled subagent's file may be fresh (it just finished writing) but it
  // isn't ongoing work — must not veto.
  const settledTask = seedTask();
  seedSubagent(settledTask, { status: "completed", mtimeAgoMs: 0 });
  expect(subagentActivityWithin(settledTask, 60_000)).toBe(false);

  // No rows at all.
  expect(subagentActivityWithin(randomUUID(), 60_000)).toBe(false);
});
