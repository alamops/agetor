import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";
import type { GlobalEvent, RunEvent } from "../shared/types.ts";

// Every saved row is sent live with its stored `id` and `ts`, nothing is sent
// for a dedup hit, send order is id order, and the settle-path lines
// (`started —`, `exit:N`, `cancelled (exit:N)`, the hold line, a rejected
// spawn's stderr) are saved on their run
// (docs/plans/event-stream-forward-resume.md, T3/T4).

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-live-event-ids-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

// Scoped to this file and restored afterwards: `bun test` shares one process.
const ENV_OVERRIDES: Record<string, string> = {
  AGETOR_CLAUDE_DRIVER: "fake",
  AGETOR_CLAUDE_BIN: "/bin/echo",
  AGETOR_TMUX_BIN: "/bin/echo",
  AGETOR_CLAUDE_ARGS: "",
};
const savedEnv: Record<string, string | undefined> = {};

let orch: typeof import("./orchestrator.ts");
let dbmod: typeof import("./db.ts");
const createdTaskIds: string[] = [];
const frames: RunEvent[] = [];
let unsubscribe: (() => void) | null = null;

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV_OVERRIDES)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  dbmod = await import("./db.ts");
  orch = await import("./orchestrator.ts");
  unsubscribe = orch.subscribe((e) => frames.push(e));
});

afterAll(async () => {
  unsubscribe?.();
  for (const id of createdTaskIds) {
    try {
      await orch.deleteTask(id);
    } catch {
      /* best-effort */
    }
  }
  for (const k of Object.keys(ENV_OVERRIDES)) {
    const prev = savedEnv[k];
    if (prev === undefined) delete process.env[k];
    else process.env[k] = prev;
  }
  rmTestDataDir(DATA_DIR);
});

interface StoredRow {
  id: number;
  ts: number;
  stream: string;
  data: string;
  subagentId: string | null;
}

function storedRows(runId: string): StoredRow[] {
  return dbmod.db
    .query<StoredRow, [string]>(
      `SELECT id, ts, stream, data, subagent_id AS subagentId FROM run_events WHERE run_id = ? ORDER BY id ASC`,
    )
    .all(runId);
}

function framesOf(runId: string): RunEvent[] {
  return frames.filter((f) => f.runId === runId);
}

async function createClaudeTask(prompt = "p"): Promise<string> {
  const created = await orch.createTask({
    title: "live ids",
    prompt,
    agent: "claude-code",
    workdir: mkdtempSync(path.join(tmpdir(), "agetor-live-event-ids-wd-")),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  createdTaskIds.push(created.task.id);
  return created.task.id;
}

async function startAndSettle(taskId: string): Promise<string> {
  const started = await orch.startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  await waitSettled(taskId);
  return started.runId;
}

async function waitSettled(taskId: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rs = dbmod.runs.listForTask(taskId);
    if (rs.length > 0 && rs.every((r) => r.status !== "running")) {
      // The exit line is saved after the status flips; let the done handler finish.
      await new Promise((r) => setTimeout(r, 60));
      return;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function waitUntil(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** A run row to dispatch synthetic chunks onto (settled, so nothing else writes to it). */
async function settledRun(): Promise<{ taskId: string; runId: string }> {
  const taskId = await createClaudeTask();
  const runId = await startAndSettle(taskId);
  return { taskId, runId };
}

function expectFrameEqualsRow(frame: RunEvent, row: StoredRow): void {
  expect(frame.id).toBe(row.id);
  expect(frame.ts).toBe(row.ts);
  expect(frame.stream).toBe(row.stream as RunEvent["stream"]);
  expect(frame.data).toBe(row.data);
  expect(frame.subagentId ?? null).toBe(row.subagentId);
}

test("a dispatched chunk is sent with the stored id and ts", async () => {
  const { taskId, runId } = await settledRun();
  const before = framesOf(runId).length;

  orch.__dispatchChunkForTest(runId, taskId, "claude-code", "assistant", "hello ids", "uuid-hello");

  const sent = framesOf(runId).slice(before);
  expect(sent.length).toBe(1);
  const row = storedRows(runId).find((r) => r.data === "hello ids")!;
  expect(row).toBeDefined();
  expectFrameEqualsRow(sent[0]!, row);
});

test("a repeated lineUuid is saved and sent once", async () => {
  const { taskId, runId } = await settledRun();
  const before = framesOf(runId).length;

  orch.__dispatchChunkForTest(runId, taskId, "claude-code", "assistant", "same line", "uuid-dup");
  orch.__dispatchChunkForTest(runId, taskId, "claude-code", "assistant", "same line", "uuid-dup");

  expect(framesOf(runId).slice(before).filter((f) => f.data === "same line").length).toBe(1);
  expect(storedRows(runId).filter((r) => r.data === "same line").length).toBe(1);
});

test("appendRunStatusLine is sent with the stored id and ts", async () => {
  const { taskId, runId } = await settledRun();
  const before = framesOf(runId).length;

  orch.appendRunStatusLine(taskId, runId, "a status breadcrumb");

  const sent = framesOf(runId).slice(before);
  expect(sent.length).toBe(1);
  const row = storedRows(runId).find((r) => r.data === "a status breadcrumb")!;
  expectFrameEqualsRow(sent[0]!, row);
});

test("ids strictly increase in send order across an interleaved burst", async () => {
  const a = await settledRun();
  const b = await settledRun();
  const before = frames.length;

  for (let i = 0; i < 20; i++) {
    const run = i % 2 === 0 ? a : b;
    if (i % 3 === 0) orch.appendRunStatusLine(run.taskId, run.runId, `burst status ${i}`);
    else orch.__dispatchChunkForTest(run.runId, run.taskId, "claude-code", "assistant", `burst ${i}`, `burst-${i}`);
  }

  const sent = frames.slice(before).filter((f) => f.data.startsWith("burst"));
  expect(sent.length).toBe(20);
  const ids = sent.map((f) => f.id!);
  for (let i = 1; i < ids.length; i++) expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);
});

test("a fake claude run sends every saved row with its id, and saves started — then exit:0 in send order", async () => {
  const taskId = await createClaudeTask("plain prompt");
  const runId = await startAndSettle(taskId);

  const rows = storedRows(runId);
  const sent = framesOf(runId);
  // Every frame of the run is a saved row (no live-only stream here) and
  // matches its row field for field, in the same order.
  expect(sent.length).toBe(rows.length);
  sent.forEach((f, i) => expectFrameEqualsRow(f, rows[i]!));

  const startedIdx = rows.findIndex((r) => r.stream === "status" && r.data.startsWith("started — "));
  const exitIdx = rows.findIndex((r) => r.stream === "status" && r.data === "exit:0");
  expect(startedIdx).toBeGreaterThanOrEqual(0);
  expect(exitIdx).toBeGreaterThan(startedIdx);
});

test("a cancelled run saves cancelled (exit:N)", async () => {
  const prev = process.env.AGETOR_FAKE_CLAUDE_TURN_MS;
  process.env.AGETOR_FAKE_CLAUDE_TURN_MS = "1500";
  try {
    const taskId = await createClaudeTask("hold open");
    const started = await orch.startTask(taskId);
    if ("error" in started) throw new Error(started.error);
    const runId = started.runId;
    await new Promise((r) => setTimeout(r, 100));
    expect(await orch.cancelRun(runId)).toBe(true);
    await waitSettled(taskId);

    const rows = storedRows(runId);
    expect(rows.some((r) => r.stream === "status" && /^cancelled \(exit:-?\d+\)$/.test(r.data))).toBe(true);
    const sent = framesOf(runId);
    expect(sent.length).toBe(rows.length);
    sent.forEach((f, i) => expectFrameEqualsRow(f, rows[i]!));
  } finally {
    if (prev === undefined) delete process.env.AGETOR_FAKE_CLAUDE_TURN_MS;
    else process.env.AGETOR_FAKE_CLAUDE_TURN_MS = prev;
  }
});

test("a settle whose exit line can't be saved (run row gone) still records the outcome, moves the card and emits run-status", async () => {
  // `saveStatusLineQuietly`: losing a breadcrumb must not derail
  // `attachDoneHandler`. Were the failed save to throw, the `.catch` branch
  // would re-settle the run as `failed` and send the card to `ready`.
  const prev = process.env.AGETOR_FAKE_CLAUDE_TURN_MS;
  process.env.AGETOR_FAKE_CLAUDE_TURN_MS = "800";
  const globals: GlobalEvent[] = [];
  const unsubGlobal = orch.subscribeGlobal((g) => globals.push(g));
  try {
    const taskId = await createClaudeTask("settles after its run row is gone");
    const started = await orch.startTask(taskId);
    if ("error" in started) throw new Error(started.error);
    const runId = started.runId;
    await waitUntil(() => storedRows(runId).some((r) => r.data.startsWith("started — ")));
    // Mid-turn: the run row (and its events, by cascade) disappears; the task
    // still names it, so the settle is the task's terminal one.
    dbmod.db.run(`DELETE FROM runs WHERE id = ?`, [runId]);

    const runStatus = () => globals.filter((g) => g.kind === "run-status" && g.runId === runId);
    await waitUntil(() => runStatus().length > 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(runStatus()).toHaveLength(1);
    expect((runStatus()[0] as Extract<GlobalEvent, { kind: "run-status" }>).status).toBe("succeeded");
    expect(dbmod.tasks.get(taskId)?.column).toBe("review");
    // Nothing was saved, so nothing was sent for the exit line.
    expect(framesOf(runId).some((f) => f.stream === "status" && /^exit:/.test(f.data))).toBe(false);
  } finally {
    unsubGlobal();
    if (prev === undefined) delete process.env.AGETOR_FAKE_CLAUDE_TURN_MS;
    else process.env.AGETOR_FAKE_CLAUDE_TURN_MS = prev;
  }
});

test("a rejected done persists the stderr row", async () => {
  const taskId = await createClaudeTask("__agetor_fake_claude_done_reject__");
  const runId = await startAndSettle(taskId);

  const rows = storedRows(runId);
  const row = rows.find((r) => r.stream === "stderr");
  expect(row?.data).toBe("Error: fake done rejection");
  const frame = framesOf(runId).find((f) => f.stream === "stderr")!;
  expectFrameEqualsRow(frame, row!);
});

test("a monitor event stores and sends the line's own time", async () => {
  const { attachSubagentWatcher, setSubagentEmitter } = await import("./claude-subagents.ts");
  const { runId, taskId } = await settledRun();

  const captured: RunEvent[] = [];
  const original = setSubagentEmitter(null);
  setSubagentEmitter((e) => {
    captured.push(e);
    original?.(e);
  });

  const sessionId = randomUUID();
  const proj = path.join(DATA_DIR, "projects", "encoded");
  mkdirSync(path.join(proj, sessionId, "subagents"), { recursive: true });
  const jsonlPath = path.join(proj, `${sessionId}.jsonl`);

  const t0 = Date.now();
  const stubTs = new Date(t0 - 120_000).toISOString();
  const eventMs = t0 - 60_000;
  const toolUseId = "toolu_ids1";
  const monitorId = "mon_ids1";
  const line = (o: unknown) => JSON.stringify(o) + "\n";
  writeFileSync(
    jsonlPath,
    line({
      type: "assistant",
      timestamp: stubTs,
      uuid: randomUUID(),
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name: "Monitor", input: { command: "tail -f build.log", description: "ids" } }],
      },
    })
      + line({
        type: "user",
        timestamp: stubTs,
        uuid: randomUUID(),
        message: {
          role: "user",
          content: [{
            tool_use_id: toolUseId,
            type: "tool_result",
            content: `Monitor started (task ${monitorId}, timeout 1500000ms). You will be notified on each event. Keep working — do not poll or sleep.`,
          }],
        },
        toolUseResult: { taskId: monitorId, timeoutMs: 1_500_000, persistent: false },
      }),
  );

  const w = attachSubagentWatcher({ taskId, jsonlPath, manual: true });
  try {
    w.pump(t0);
    const content = `<task-notification>\n<task-id>${monitorId}</task-id>\n<summary>Monitor event: "ids"</summary>\n<event>3 passed</event>\n</task-notification>`;
    appendFileSync(
      jsonlPath,
      line({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: new Date(eventMs).toISOString(),
        sessionId: randomUUID(),
        content,
      })
        + line({
          type: "user",
          uuid: randomUUID(),
          origin: { kind: "task-notification" },
          promptSource: "system",
          timestamp: new Date(eventMs).toISOString(),
          message: { role: "user", content },
        }),
    );
    w.pump(t0 + 1);

    const row = dbmod.db
      .query<StoredRow, [string]>(
        `SELECT id, ts, stream, data, subagent_id AS subagentId FROM run_events WHERE subagent_id = ? AND stream = 'stdout' ORDER BY id`,
      )
      .all(monitorId)[0];
    expect(row).toBeDefined();
    expect(row!.ts).toBe(eventMs);
    const sent = captured.filter((e) => e.stream === "stdout" && e.subagentId === monitorId);
    expect(sent.length).toBe(1);
    expectFrameEqualsRow(sent[0]!, row!);
    void runId;
  } finally {
    w.detach();
    setSubagentEmitter(original);
  }
});
