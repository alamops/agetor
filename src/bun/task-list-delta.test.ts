// `GET /tasks?delta=1[&since=<cursor>]`, the `tasks.changedSince` op and the
// `tasks-changed` push (docs/plans/non-blocking-core.md T12/T14b, X5;
// docs/architecture/core-responsiveness.md "Delta and push"). Same harness as
// task-list-archived.test.ts: AGETOR_DATA_DIR and a unique AGETOR_API_PORT are
// set before `./db.ts` / `./server.ts` load, and only this file's rows are
// asserted on (the db singleton is shared by every file in the process).
import { test, expect, beforeAll, afterAll, afterEach, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { GlobalEvent, Task, TaskDelta } from "../shared/types.ts";
import { applyTaskDelta } from "../shared/task-delta.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-task-list-delta-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT.
process.env.AGETOR_API_PORT = "4831";
const BASE = "http://127.0.0.1:4831";

let server: { stop: () => void };
let token: string;
let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;
let CHANGED_SINCE_SQL: string;
let createTasksChangedPush: typeof import("./task-change-push.ts").createTasksChangedPush;
let noteDecorationChanged: typeof import("./task-decoration-rev.ts").noteDecorationChanged;
let onTasksChanged: typeof import("./task-change-bus.ts").onTasksChanged;
let markStalled: typeof import("./stall-registry.ts").markStalled;
let clearStalled: typeof import("./stall-registry.ts").clearStalled;
let interactions: typeof import("./interactions.ts");
let terminalsMod: typeof import("./terminals.ts");

const SAVED_SHELL = process.env.SHELL;

beforeAll(async () => {
  process.env.SHELL = "/bin/sh";
  ({ db, tasks, runs } = await import("./db.ts"));
  ({ CHANGED_SINCE_SQL } = await import("./db-core/ops/delta-ops.ts"));
  ({ createTasksChangedPush } = await import("./task-change-push.ts"));
  ({ noteDecorationChanged } = await import("./task-decoration-rev.ts"));
  ({ onTasksChanged } = await import("./task-change-bus.ts"));
  ({ markStalled, clearStalled } = await import("./stall-registry.ts"));
  interactions = await import("./interactions.ts");
  terminalsMod = await import("./terminals.ts");
  const mod = await import("./server.ts");
  server = mod.startApiServer() as unknown as { stop: () => void };
  token = mod.API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
  if (SAVED_SHELL === undefined) delete process.env.SHELL;
  else process.env.SHELL = SAVED_SHELL;
  rmTestDataDir(DATA_DIR);
});

const createdTaskIds: string[] = [];
afterEach(async () => {
  for (const id of createdTaskIds.splice(0)) {
    await terminalsMod.killTerminalsForTask(id);
    clearStalled(id);
    db.run(`DELETE FROM subagents WHERE task_id = ?`, [id]);
    db.run(`DELETE FROM runs WHERE task_id = ?`, [id]);
    tasks.delete(id);
  }
  interactions.__testing.reset();
});

function makeTask(archivedAt: number | null = null, extra: Partial<Task> = {}): string {
  const now = Date.now();
  const id = randomUUID();
  tasks.insert({
    id,
    title: `delta-${id.slice(0, 6)}`,
    prompt: "p",
    column: archivedAt == null ? "ready" : "done",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    speed: "off", maxMode: false, opencodeServer: "shared",
    references: [], backlog: [], plans: [], draft: null,
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
  createdTaskIds.push(id);
  return id;
}

function addRun(taskId: string, status: "running" | "succeeded"): string {
  const id = randomUUID();
  runs.insert({
    id,
    taskId,
    agent: "claude-code",
    status,
    startedAt: Date.now(),
    endedAt: status === "running" ? null : Date.now(),
    exitCode: null,
    tmuxSession: null,
    claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  return id;
}

const getText = async (p: string) => {
  const res = await fetch(`${BASE}${p}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, text: await res.text() };
};
const getDelta = async (qs: string, since?: string): Promise<TaskDelta> => {
  const q = `delta=1${qs ? `&${qs}` : ""}${since !== undefined ? `&since=${encodeURIComponent(since)}` : ""}`;
  const { status, text } = await getText(`/tasks?${q}`);
  expect(status).toBe(200);
  return JSON.parse(text) as TaskDelta;
};
const idsOf = (d: TaskDelta) => d.tasks.map((t) => t.id);

describe("GET /tasks?delta=1", () => {
  test("no cursor: a full snapshot with a cursor, no removals", async () => {
    const a = makeTask();
    const b = makeTask();
    const d = await getDelta("");
    expect(d.format).toBe("delta");
    expect(d.snapshot).toBe(true);
    expect(d.removedIds).toEqual([]);
    expect(d.cursor).toMatch(/^[0-9a-f]+-[0-9a-f]+:\d+:\d+$/);
    expect(idsOf(d)).toEqual(expect.arrayContaining([a, b]));
  });

  test("a delta after an update carries only the changed row", async () => {
    const a = makeTask();
    const b = makeTask();
    const first = await getDelta("");
    await tasks.update(a, { title: "renamed" });
    const d = await getDelta("", first.cursor);
    expect(d.snapshot).toBe(false);
    expect(idsOf(d)).toEqual([a]);
    expect(d.tasks[0]!.title).toBe("renamed");
    expect(idsOf(d)).not.toContain(b);
    // Nothing changed since: an empty delta whose cursor does not move.
    const again = await getDelta("", d.cursor);
    expect(again.snapshot).toBe(false);
    expect(again.tasks).toEqual([]);
    expect(again.removedIds).toEqual([]);
    expect(again.cursor).toBe(d.cursor);
  });

  test("archive: removedIds under archived=exclude, still returned when kept", async () => {
    const a = makeTask();
    const kept = makeTask();
    const first = await getDelta("archived=exclude");
    expect(idsOf(first)).toEqual(expect.arrayContaining([a, kept]));
    const firstKept = await getDelta(`archived=exclude&keep=${kept}`);
    db.run(`UPDATE tasks SET "column" = 'done' WHERE id IN (?, ?)`, [a, kept]);
    await tasks.update(a, { archivedAt: Date.now() });
    await tasks.update(kept, { archivedAt: Date.now() });

    const d = await getDelta("archived=exclude", first.cursor);
    expect(d.snapshot).toBe(false);
    expect(d.removedIds).toEqual(expect.arrayContaining([a, kept]));
    expect(idsOf(d)).not.toContain(a);

    const dk = await getDelta(`archived=exclude&keep=${kept}`, firstKept.cursor);
    expect(dk.removedIds).toContain(a);
    expect(dk.removedIds).not.toContain(kept);
    expect(idsOf(dk)).toContain(kept);

    // The merge helper drops the archived card and keeps the kept one.
    const merged = applyTaskDelta(first.tasks, d);
    expect(merged.map((t) => t.id)).not.toContain(a);
  });

  test("delete: a tombstone in removedIds", async () => {
    const a = makeTask();
    const first = await getDelta("");
    await tasks.delete(a);
    const d = await getDelta("", first.cursor);
    expect(d.removedIds).toContain(a);
    expect(idsOf(d)).not.toContain(a);
  });

  test("a server-managed column write moves the cursor without touching updated_at", async () => {
    const a = makeTask();
    const before = db.query<{ updated_at: number }, [string]>(`SELECT updated_at FROM tasks WHERE id = ?`).get(a)!;
    const first = await getDelta("");
    db.run(`UPDATE tasks SET last_seen_event_id = 42 WHERE id = ?`, [a]);
    const d = await getDelta("", first.cursor);
    expect(idsOf(d)).toEqual([a]);
    const after = db.query<{ updated_at: number }, [string]>(`SELECT updated_at FROM tasks WHERE id = ?`).get(a)!;
    expect(after.updated_at).toBe(before.updated_at);
    expect(d.tasks[0]!.updatedAt).toBe(before.updated_at);
  });

  test("a run status change and a subagent status change each bump their task", async () => {
    const a = makeTask();
    const b = makeTask();
    const runId = addRun(a, "running");
    db.run(
      `INSERT INTO subagents (id, task_id, run_id, parent_kind, agent_type, description, spawn_depth, source_path, status, started_at)
       VALUES (?, ?, ?, 'subagent', 'general-purpose', 'd', 1, ?, 'running', ?)`,
      [`agent-${randomUUID()}`, b, runId, `/tmp/${randomUUID()}.jsonl`, Date.now()],
    );
    const first = await getDelta("");
    expect(first.tasks.find((t) => t.id === b)?.runningSubagents).toBe(1);
    expect(first.decorations[b]?.runningSubagents).toBe(1);

    db.run(`UPDATE runs SET status = 'succeeded' WHERE id = ?`, [runId]);
    const afterRun = await getDelta("", first.cursor);
    expect(idsOf(afterRun)).toEqual([a]);
    expect(afterRun.tasks[0]!.hasOpenableRun).toBe(true);

    db.run(`UPDATE subagents SET status = 'completed', ended_at = ? WHERE task_id = ?`, [Date.now(), b]);
    const afterSub = await getDelta("", afterRun.cursor);
    expect(idsOf(afterSub)).toEqual([b]);
    expect(afterSub.tasks[0]!.runningSubagents).toBe(0);
  });

  test("an epoch mismatch, a cursor from another boot, a malformed or a future cursor all snapshot", async () => {
    const a = makeTask();
    const first = await getDelta("");
    const [head, rev, dec] = first.cursor.split(":") as [string, string, string];
    const [epoch, boot] = head.split("-") as [string, string];
    const cases = [
      `${"0".repeat(epoch.length)}-${boot}:${rev}:${dec}`,
      `${epoch}-${"f".repeat(boot.length)}:${rev}:${dec}`,
      `${epoch}-${boot}:${Number(rev) + 1_000_000}:${dec}`,
      `${epoch}-${boot}:${rev}:${Number(dec) + 1_000_000}`,
      "not-a-cursor",
      "",
      `${epoch}-${boot}:abc:${dec}`,
    ];
    for (const since of cases) {
      const d = await getDelta("", since);
      expect(d.snapshot).toBe(true);
      expect(d.removedIds).toEqual([]);
      expect(idsOf(d)).toContain(a);
    }
  });

  test("a write after the read lands in the next delta, never skipped", async () => {
    const a = makeTask();
    const first = await getDelta("");
    const metaAtRead = db.query<{ rev: number }, []>(`SELECT rev FROM task_rev_meta WHERE id = 1`).get()!.rev;
    expect(Number(first.cursor.split(":")[1])).toBe(metaAtRead);
    // A write racing in right after the delta's read transaction closed.
    await tasks.update(a, { title: "late" });
    const metaAfter = db.query<{ rev: number }, []>(`SELECT rev FROM task_rev_meta WHERE id = 1`).get()!.rev;
    expect(metaAfter).toBeGreaterThan(metaAtRead);
    const d = await getDelta("", first.cursor);
    expect(idsOf(d)).toEqual([a]);
    expect(Number(d.cursor.split(":")[1])).toBe(metaAfter);
    // And re-asking from the cursor the first delta returned finds it exactly once.
    const again = await getDelta("", d.cursor);
    expect(again.tasks).toEqual([]);
  });

  test("the cursor range scan SEARCHes task_revs by rev", () => {
    const plan = db
      .query<{ detail: string }, [number, number]>(`EXPLAIN QUERY PLAN ${CHANGED_SINCE_SQL}`)
      .all(0, 10)
      .map((r) => r.detail);
    expect(plan.some((d) => /SEARCH task_revs USING (COVERING )?INDEX idx_task_revs_rev/.test(d))).toBe(true);
    expect(plan.some((d) => /^SCAN/.test(d))).toBe(false);
  });
});

describe("legacy GET /tasks", () => {
  test("is byte-identical to the pre-delta handler's output, and the delta snapshot agrees row for row", async () => {
    const live = makeTask();
    const archived = makeTask(Date.now());
    addRun(live, "succeeded");
    markStalled(live, 1234);
    const { status, text } = await getText("/tasks?archived=exclude");
    expect(status).toBe(200);
    // The handler as it was before `?delta=1`: list, trim pipelineRun, two decorations.
    const counts = await (await import("./db-async.ts")).subagents.runningCountsByTask();
    const { stalledSince } = await import("./stall-registry.ts");
    const legacy = (await (await import("./db-async.ts")).tasks.list({ archived: "exclude", keepIds: [] })).map((t) => ({
      ...t,
      runningSubagents: counts.get(t.id) ?? 0,
      stalledSince: stalledSince(t.id),
    }));
    expect(text).toBe(JSON.stringify(legacy));
    expect(JSON.parse(text).some((t: Task) => t.id === archived)).toBe(false);

    const d = await getDelta("archived=exclude");
    const byId = new Map(d.tasks.map((t) => [t.id, JSON.stringify(t)] as const));
    for (const t of legacy) expect(byId.get(t.id)).toBe(JSON.stringify(t));
    expect(d.tasks).toHaveLength(legacy.length);
    expect(d.decorations[live]?.stalledSince).toBe(1234);
  });
});

describe("sparse decorations and push", () => {
  test("a stall mark rides the next delta and fires a push trigger", async () => {
    const a = makeTask();
    const first = await getDelta("");
    const reasons: Array<string | undefined> = [];
    const off = onTasksChanged((r) => reasons.push(r));
    markStalled(a, 777);
    off();
    expect(reasons).toContain("decoration");
    const d = await getDelta("", first.cursor);
    expect(d.snapshot).toBe(false);
    expect(d.decorations[a]).toEqual({ pendingInteractions: 0, openTerminals: 0, stalledSince: 777 });
    // The merge helper overlays it on the row without a row refetch.
    const merged = applyTaskDelta(first.tasks, d);
    expect(merged.find((t) => t.id === a)?.stalledSince).toBe(777);
    clearStalled(a);
    const cleared = await getDelta("", d.cursor);
    expect(cleared.decorations[a]?.stalledSince).toBeNull();
    // An unchanged repeat: no decoration, no rows.
    const quiet = await getDelta("", cleared.cursor);
    expect(quiet.decorations).toEqual({});
    expect(quiet.tasks).toEqual([]);
  });

  test("an interaction card registers and resolves through the delta", async () => {
    const a = makeTask();
    const first = await getDelta("");
    const req = interactions.registerScrapedAskQuestions({
      taskId: a,
      runId: "run-x",
      questions: [{ question: "Pick", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }],
      fingerprint: `fp-${a}`,
    });
    const d1 = await getDelta("", first.cursor);
    expect(d1.decorations[a]?.pendingInteractions).toBe(1);
    expect(d1.snapshot).toBe(false);
    expect(d1.tasks).toEqual([]);
    interactions.resolveScrapedAskQuestions(req.id);
    const d2 = await getDelta("", d1.cursor);
    expect(d2.decorations[a]?.pendingInteractions).toBe(0);
  });

  test("a terminal open and close rides the delta", async () => {
    const a = makeTask();
    const first = await getDelta("");
    const tab = await terminalsMod.createTerminal(a);
    expect("error" in tab).toBe(false);
    const d1 = await getDelta("", first.cursor);
    expect(d1.decorations[a]?.openTerminals).toBe(1);
    terminalsMod.closeTerminal((tab as { id: string }).id);
    const d2 = await getDelta("", d1.cursor);
    expect(d2.decorations[a]?.openTerminals).toBe(0);
  });

  test("a pipeline step's card also moves its parent's decoration", async () => {
    const parent = makeTask();
    const step = makeTask(null, { pipelineParentId: parent });
    interactions.notePipelineParent(step, parent);
    const first = await getDelta("");
    interactions.registerScrapedAskQuestions({
      taskId: step,
      runId: "run-x",
      questions: [{ question: "Pick", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }],
      fingerprint: `fp-${step}`,
    });
    const d = await getDelta("", first.cursor);
    expect(d.decorations[step]?.pendingInteractions).toBe(1);
    expect(d.decorations[parent]?.pendingInteractions).toBe(1);
    interactions.forgetPipelineParent(step);
  });

  test("decoration history older than the tracked window snapshots", async () => {
    const { MAX_TRACKED } = await import("./task-decoration-rev.ts");
    const a = makeTask();
    const first = await getDelta("");
    for (let i = 0; i <= MAX_TRACKED + 1; i++) noteDecorationChanged(`ghost-${i}`);
    const d = await getDelta("", first.cursor);
    expect(d.snapshot).toBe(true);
    expect(idsOf(d)).toContain(a);
  });
});

describe("tasks-changed throttle", () => {
  function harness() {
    let t = 1000;
    const timers: Array<{ at: number; fn: () => void; id: number; live: boolean }> = [];
    let nextId = 0;
    const published: GlobalEvent[] = [];
    let listener: (() => void) | null = null;
    let cursorSeq = 0;
    const stop = createTasksChangedPush({
      subscribe: (cb) => { listener = cb; return () => { listener = null; }; },
      cursor: async () => `c${++cursorSeq}`,
      publish: (e) => published.push(e),
      intervalMs: 250,
      now: () => t,
      setTimer: (fn, ms) => { const h = { at: t + ms, fn, id: nextId++, live: true }; timers.push(h); return h; },
      clearTimer: (h) => { (h as { live: boolean }).live = false; },
      log: () => {},
    });
    const advance = async (ms: number) => {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = due.at;
        due.live = false;
        due.fn();
      }
      t = end;
      await Promise.resolve();
      await Promise.resolve();
    };
    const fire = async () => { listener!(); await Promise.resolve(); await Promise.resolve(); };
    return { published, advance, fire, stop, listening: () => listener !== null };
  }

  test("leading edge at once, then at most one trailing event per window", async () => {
    const h = harness();
    await h.fire();
    expect(h.published).toHaveLength(1);
    expect(h.published[0]).toMatchObject({ kind: "tasks-changed", cursor: "c1" });
    for (let i = 0; i < 100; i++) await h.fire(); // a burst inside the window
    expect(h.published).toHaveLength(1);
    await h.advance(249);
    expect(h.published).toHaveLength(1);
    await h.advance(1);
    expect(h.published).toHaveLength(2); // one coalesced trailing event
    await h.advance(1000);
    expect(h.published).toHaveLength(2); // quiet: nothing more
    h.stop();
    expect(h.listening()).toBe(false);
  });

  test("a change after a quiet period leads again; a change after the trailing emit opens a new window", async () => {
    const h = harness();
    await h.fire();
    await h.advance(300);
    await h.fire();
    expect(h.published).toHaveLength(2); // leading again
    await h.fire();
    await h.advance(250);
    expect(h.published).toHaveLength(3); // trailing
    await h.fire(); // inside the trailing emit's own window
    expect(h.published).toHaveLength(3);
    await h.advance(250);
    expect(h.published).toHaveLength(4);
    h.stop();
  });

  test("a failed cursor read drops that event and the next change emits again", async () => {
    let t = 0;
    let fail = true;
    const published: GlobalEvent[] = [];
    let listener: (() => void) | null = null;
    createTasksChangedPush({
      subscribe: (cb) => { listener = cb; return () => {}; },
      cursor: async () => { if (fail) throw new Error("db restarting"); return "ok"; },
      publish: (e) => published.push(e),
      intervalMs: 250,
      now: () => t,
      setTimer: () => 0,
      clearTimer: () => {},
      log: () => {},
    });
    listener!();
    await Promise.resolve();
    await Promise.resolve();
    expect(published).toHaveLength(0);
    fail = false;
    t = 1000;
    listener!();
    await Promise.resolve();
    await Promise.resolve();
    expect(published).toHaveLength(1);
  });

  test("production wiring: a stall mark reaches the global stream as one tasks-changed event with a cursor", async () => {
    const { startTasksChangedPush } = await import("./task-change-push.ts");
    const { subscribeGlobal } = await import("./orchestrator.ts");
    const events: GlobalEvent[] = [];
    const off = subscribeGlobal((e) => { if (e.kind === "tasks-changed") events.push(e); });
    const stop = startTasksChangedPush();
    const a = makeTask();
    markStalled(a, 5);
    const deadline = Date.now() + 3000;
    while (events.length === 0 && Date.now() < deadline) await Bun.sleep(10);
    stop();
    off();
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events[0] as Extract<GlobalEvent, { kind: "tasks-changed" }>;
    expect(ev.cursor).toMatch(/^[0-9a-f]+-[0-9a-f]+:\d+:\d+$/);
  });
});
