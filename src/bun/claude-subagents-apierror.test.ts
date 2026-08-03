/* ────────────────────────────────────────────────────────────────────────── *
 * Background-agent API errors end the run (docs/plans/bg-agent-api-error-ends-run.md).
 *
 * Covers the subagent-tailer side only (T2 in the plan): `claude-subagents.ts`'s
 * `tailFile` peeking `isApiErrorMessage`/`apiErrorStatus` straight off a
 * subagent's own `agent-<id>.jsonl` line, settling that row `failed`
 * immediately (no `DONE_IDLE_MS` wait), and firing the injected `onApiError`
 * callback so `claude-tmux.ts`'s `signalSubagentApiError` can abort the main
 * turn. This file does NOT touch `signalSubagentApiError` itself (that's T3,
 * a disjoint file) — only the watcher's detection + settle + callback wiring.
 *
 * Conventions mirrored from `claude-subagents.test.ts` (read first): temp
 * `AGETOR_DATA_DIR` via `mkdtempSync` before any `./db.ts`-importing import;
 * `attachSubagentWatcher({ manual: true })` + `pump()` driving; fixture jsonl
 * written with `writeFileSync`/`appendFileSync` under
 * `<dir>/<sessionId>/subagents/agent-<id>.jsonl`; save/restore
 * `setSubagentEmitter`/`setSubagentSettleHook` in beforeEach/afterEach (bun
 * test shares one process/DB across files — leaked hooks strand sibling
 * files); track created task ids and hard-delete in afterEach.
 * ────────────────────────────────────────────────────────────────────────── */

import { test, expect, beforeAll, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunEvent } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-subagents-apierror-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

// Whatever the orchestrator registered at its module load (or `null` if this
// file runs before it). `bun test` shares one process across every file, so
// hard-resetting these to `null` in `afterEach` would leave every later file
// with no SSE sink and no release path. Capture by read-modify-restore and
// put the originals back — same posture as claude-subagents.test.ts.
let originalEmitter: ((e: RunEvent) => void) | null = null;
let originalSettleHook: ((taskId: string) => void) | null = null;

beforeAll(async () => {
  await import("./db.ts");
  const { setSubagentEmitter, setSubagentSettleHook } = await import("./claude-subagents.ts");
  originalEmitter = setSubagentEmitter(null);
  setSubagentEmitter(originalEmitter);
  originalSettleHook = setSubagentSettleHook(null);
  setSubagentSettleHook(originalSettleHook);
});

const createdTaskIds: string[] = [];

afterEach(async () => {
  const { detachWatcherFor, setSubagentEmitter, setSubagentSettleHook } = await import(
    "./claude-subagents.ts"
  );
  setSubagentEmitter(originalEmitter);
  setSubagentSettleHook(originalSettleHook);
  if (createdTaskIds.length === 0) return;
  const { tasks } = await import("./db.ts");
  for (const id of createdTaskIds) {
    try {
      detachWatcherFor(id);
    } catch {
      /* best-effort */
    }
    try {
      tasks.delete(id);
    } catch {
      /* best-effort */
    }
  }
  createdTaskIds.length = 0;
});

/** Build a temp `<sessionId>/subagents/` layout + a seeded task/run, returning
 *  the jsonlPath the watcher derives the subagents dir from. Mirrors
 *  claude-subagents.test.ts's `seed()` exactly (same task/run shape, same
 *  reconcileOrphans trap avoidance rationale). */
async function seed() {
  const { tasks, runs } = await import("./db.ts");
  const taskId = `task-sub-apierr-${randomUUID()}`;
  const runId = `run-sub-apierr-${randomUUID()}`;
  createdTaskIds.push(taskId);
  const now = Date.now();
  tasks.insert({
    id: taskId, title: "t", prompt: "p", column: "running", agent: "claude-code",
    workdir: "/tmp", isolation: "none", taskType: "task", branch: null, branchSource: "created", worktreePath: null,
    baseRef: null, mode: null, model: null, effort: null, references: [], backlog: [], draft: null, runId,
    prUrl: null,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    archivedAt: null, createdAt: now, updatedAt: now,
  });
  runs.insert({
    id: runId, taskId, agent: "claude-code", status: "succeeded", startedAt: now,
    endedAt: now, exitCode: 0, tmuxSession: null, claudeSessionId: null, codexSessionId: null,
  });

  const sessionId = randomUUID();
  const proj = path.join(DATA_DIR, "projects", "encoded");
  const subagentsDir = path.join(proj, sessionId, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  const jsonlPath = path.join(proj, `${sessionId}.jsonl`);
  return { taskId, runId, jsonlPath, subagentsDir };
}

/** A normal (non-error) sidechain opener: a user turn + a tool_use reply.
 *  Same shape claude-subagents.test.ts uses to get past discovery. */
function sidechainLines(): string {
  return [
    JSON.stringify({ type: "user", isSidechain: true, uuid: "u1", message: { role: "user", content: "do the thing" } }),
    JSON.stringify({ type: "assistant", isSidechain: true, uuid: "a1", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } }),
  ].join("\n") + "\n";
}

/** A synthetic `isApiErrorMessage: true` line, matching the shape claude code
 *  actually writes (mirrors claude-tmux.test.ts's own fixture for the
 *  main-stream mapper test). `uuid` is a caller-supplied param (not baked in)
 *  so the uuid-less-line test (case 2) can omit it entirely. */
function apiErrorLine(opts: { uuid?: string; status?: number }): string {
  const body: Record<string, unknown> = {
    type: "assistant",
    isSidechain: true,
    isApiErrorMessage: true,
    apiErrorStatus: opts.status ?? 529,
    message: {
      role: "assistant",
      stop_reason: "stop_sequence",
      content: [{ type: "text", text: `API Error: ${opts.status ?? 529} Overloaded. This is a server-side issue, usually temporary — try again in a moment.` }],
    },
  };
  if (opts.uuid !== undefined) body.uuid = opts.uuid;
  return JSON.stringify(body);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 1. Immediate settle + callback
 * ────────────────────────────────────────────────────────────────────────── */

test("an isApiErrorMessage line settles the subagent row failed on the same pump, no DONE_IDLE_MS wait, and fires onApiError once", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setSubagentSettleHook } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, runId, jsonlPath, subagentsDir } = await seed();

  const captured: RunEvent[] = [];
  setSubagentEmitter((e) => captured.push(e));
  const settleCalls: string[] = [];
  setSubagentSettleHook((tid) => settleCalls.push(tid));
  const apiErrorCalls: { subagentId: string; detail: string; runId: string }[] = [];

  const agentId = `apierr1-${randomUUID()}`;
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType: "Explore", description: "errors out", spawnDepth: 1 }));
  // The whole file — normal opener + the terminal api-error line — is present
  // BEFORE the first pump, so discovery, tailing, and the settle all happen
  // inside that single pump() call. No idle wait is involved anywhere.
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`),
    sidechainLines() + apiErrorLine({ uuid: "err1", status: 529 }) + "\n");

  const w = attachSubagentWatcher({
    taskId, jsonlPath, manual: true,
    onApiError: (info) => apiErrorCalls.push(info),
  });
  w.pump(Date.now());

  const row = subagents.get(agentId)!;
  expect(row.status).toBe("failed");
  expect(row.endedAt).not.toBeNull();

  const finished = captured.filter((e) => e.stream === "subagent" && JSON.parse(e.data).phase === "finished");
  expect(finished.length).toBe(1);
  expect(finished[0]!.subagentId).toBe(agentId);

  expect(settleCalls).toEqual([taskId]);

  expect(apiErrorCalls.length).toBe(1);
  expect(apiErrorCalls[0]!.subagentId).toBe(agentId);
  expect(apiErrorCalls[0]!.runId).toBe(runId);
  expect(apiErrorCalls[0]!.detail).toContain("HTTP 529");

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 2. uuid-less line does not fire
 * ────────────────────────────────────────────────────────────────────────── */

test("an isApiErrorMessage line with no uuid does not settle the row or fire onApiError", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath, subagentsDir } = await seed();

  setSubagentEmitter(() => { /* drain */ });
  const apiErrorCalls: unknown[] = [];

  const agentId = `apierr2-${randomUUID()}`;
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType: "Explore", description: "no uuid", spawnDepth: 1 }));
  // Same error payload as case 1, but the line carries no `uuid` field —
  // the detection gate in tailFile requires a durable dedup key before it
  // will fire the settle (a uuid-less line can't be seeded into `seen` /
  // `run_events.line_uuid`, so replaying it on a future reattach would look
  // brand-new every time and could re-fire the abort forever).
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`),
    sidechainLines() + apiErrorLine({ status: 529 }) + "\n");

  const w = attachSubagentWatcher({
    taskId, jsonlPath, manual: true,
    onApiError: (info) => apiErrorCalls.push(info),
  });
  w.pump(Date.now());

  const row = subagents.get(agentId)!;
  expect(row.status).toBe("running");
  expect(apiErrorCalls.length).toBe(0);

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 3. Replay does not re-fire
 * ────────────────────────────────────────────────────────────────────────── */

test("reattaching a fresh watcher over an already-settled api-error transcript does not re-fire onApiError or re-flip the row", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setSubagentSettleHook } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, jsonlPath, subagentsDir } = await seed();

  setSubagentEmitter(() => { /* drain */ });
  setSubagentSettleHook(() => { /* drain */ });

  const agentId = `apierr3-${randomUUID()}`;
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType: "Explore", description: "replay", spawnDepth: 1 }));
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`),
    sidechainLines() + apiErrorLine({ uuid: "err3", status: 500 }) + "\n");

  const firstCalls: unknown[] = [];
  const w = attachSubagentWatcher({
    taskId, jsonlPath, manual: true,
    onApiError: (info) => firstCalls.push(info),
  });
  w.pump(Date.now());
  expect(subagents.get(agentId)!.status).toBe("failed");
  expect(firstCalls.length).toBe(1);
  w.detach();

  // Fresh watcher over the SAME files — the reattach path. Rehydration seeds
  // `seen` from `run_events.line_uuid` (persisted for the api-error line
  // because `tailFile` asks the mapper to carry the line's uuid on its own
  // status chunk too), so the dedup check must skip the line before the
  // api-error peek ever runs again.
  const secondCalls: unknown[] = [];
  const w2 = attachSubagentWatcher({
    taskId, jsonlPath, manual: true,
    onApiError: (info) => secondCalls.push(info),
  });
  w2.pump(Date.now());

  expect(secondCalls.length).toBe(0);
  const row = subagents.get(agentId)!;
  expect(row.status).toBe("failed");

  w2.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 4. Retry flips back without losing toolUseId
 * ────────────────────────────────────────────────────────────────────────── */

test("a retry after an api-error settle flips the row back to running and preserves toolUseId for the tool_result fallback", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setSubagentSettleHook } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, runId, jsonlPath, subagentsDir } = await seed();

  setSubagentEmitter(() => { /* drain */ });
  setSubagentSettleHook(() => { /* drain */ });

  const agentId = `apierr4-${randomUUID()}`;
  const toolUseId = "toolu_retry_x";
  const file = path.join(subagentsDir, `agent-${agentId}.jsonl`);
  // Seed the row directly as already `failed` from a prior api-error settle
  // (rehydration reconstructs the `apiErrored` latch from `status ===
  // "failed"` — see claude-subagents.ts), with nothing on disk yet at attach
  // time: `replayFloor` pins to 0 there, so the retry line written below is
  // unambiguously "beyond the floor" (W1) rather than replayed history that
  // the flip-back block must ignore.
  writeFileSync(file, "");
  const now = Date.now();
  subagents.insertIfAbsent({
    id: agentId, taskId, runId, parentKind: "subagent",
    agentType: "Explore", description: "retry", spawnDepth: 1,
    sourcePath: file, status: "failed", startedAt: now - 60_000, endedAt: now - 30_000,
    toolUseId,
  });

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  // Retry: a resumed background agent appends a fresh (non-terminal) turn,
  // written strictly after attach — beyond the replay floor, so it flips the
  // `failed` row back to running.
  writeFileSync(file,
    JSON.stringify({ type: "assistant", isSidechain: true, uuid: "retryA", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "pwd" } }] } }) + "\n");
  w.pump(t0);
  expect(subagents.get(agentId)!.status).toBe("running");

  // Prove `toolUseId` survived the flip-back (the `apiErrored` latch's whole
  // reason for existing) by exercising the tool_result fallback settle path
  // (`scanMainForToolResults`), which only considers `running` rows with a
  // non-null `toolUseId`. If the flip-back block had nulled it (as it does
  // for an ordinary `completed`-row flip), this tool_result would never be
  // matched and the row would stay stuck `running` forever.
  writeFileSync(jsonlPath,
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] } }) + "\n");
  w.pump(t0 + 1);

  expect(subagents.get(agentId)!.status).toBe("completed");

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 5. Regression: ordinary end_turn idle-completion path is untouched
 * ────────────────────────────────────────────────────────────────────────── */

test("an ordinary subagent (no api error) still completes via the end_turn + DONE_IDLE_MS idle path", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { taskId, jsonlPath, subagentsDir } = await seed();

  setSubagentEmitter(() => { /* drain */ });

  const agentId = `apierr5-${randomUUID()}`;
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType: "general-purpose", description: "normal", spawnDepth: 1 }));
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`), sidechainLines());

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  const t0 = Date.now();
  w.pump(t0);
  expect(subagents.get(agentId)!.status).toBe("running");

  appendFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`),
    JSON.stringify({ type: "assistant", isSidechain: true, uuid: "a2", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }) + "\n");
  w.pump(t0 + 1); // sawEndOfTurn=true, but not idle yet
  expect(subagents.get(agentId)!.status).toBe("running");

  w.pump(t0 + 10_000); // idle past DONE_IDLE_MS -> completed
  const row = subagents.get(agentId)!;
  expect(row.status).toBe("completed");
  expect(row.endedAt).not.toBeNull();

  w.detach();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * 6. onApiError throwing does not break the tick
 * ────────────────────────────────────────────────────────────────────────── */

test("a throwing onApiError callback does not crash the pump, and the row still settles failed", async () => {
  const { subagents } = await import("./db.ts");
  const { attachSubagentWatcher, setSubagentEmitter, setSubagentSettleHook } = await import(
    "./claude-subagents.ts"
  );
  const { taskId, jsonlPath, subagentsDir } = await seed();

  setSubagentEmitter(() => { /* drain */ });
  let settleFired = 0;
  setSubagentSettleHook(() => { settleFired++; });

  const agentId = `apierr6-${randomUUID()}`;
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType: "Explore", description: "throws", spawnDepth: 1 }));
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`),
    sidechainLines() + apiErrorLine({ uuid: "err6", status: 400 }) + "\n");

  let hookCalls = 0;
  const w = attachSubagentWatcher({
    taskId, jsonlPath, manual: true,
    onApiError: () => {
      hookCalls++;
      throw new Error("onApiError boom");
    },
  });

  expect(() => w.pump(Date.now())).not.toThrow();
  expect(hookCalls).toBe(1);
  // The settle hook (a DIFFERENT injected callback, fired before onApiError)
  // still ran, and the DB write landed before onApiError was even invoked —
  // a throwing onApiError must not roll any of that back.
  expect(settleFired).toBe(1);
  expect(subagents.get(agentId)!.status).toBe("failed");

  w.detach();
});
