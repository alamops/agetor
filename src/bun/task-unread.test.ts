import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import — beforeAll would
// race with a sibling test file that already imported db.ts (see the same
// convention in orchestrator.test.ts / task-events.test.ts). The claude fake
// driver env vars steer the orchestrator-integration tests below through an
// in-process fake instead of tmux + a real CLI; setting them here (rather
// than inside those test bodies) matches task-events.test.ts's rationale —
// AGETOR_CLAUDE_DRIVER=fake is harmless for every other test in this file.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-task-unread-"));
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT
// (see the convention comment repeated across sibling *-endpoint.test.ts
// files — 4561 isn't claimed by any of them as of this writing).
process.env.AGETOR_API_PORT = "4561";

const BASE = "http://127.0.0.1:4561";

let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;
let createTask: typeof import("./orchestrator.ts").createTask;
let startTask: typeof import("./orchestrator.ts").startTask;
let server: { stop: () => void };
let token: string;

beforeAll(async () => {
  ({ db, tasks, runs } = await import("./db.ts"));
  ({ createTask, startTask } = await import("./orchestrator.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

const call = (p: string, init: RequestInit = {}) =>
  fetch(`${BASE}${p}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

// Minimal hand-built Task fixture for direct db.ts-level tests that don't
// need a real orchestrator run — mirrors task-events.test.ts's makeTaskRow.
// `unread`/`todoProgress` are deliberately omitted: both are optional,
// server-managed fields that `db.ts` always populates on read (see their
// doc comments in shared/types.ts), so a fixture predating them is fine.
function makeTaskRow(taskId: string): Task {
  return {
    id: taskId,
    title: "t",
    prompt: "p",
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
    fast: false,
    maxMode: false,
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    column: "ready",
    runId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
  };
}

function watermarkRow(taskId: string) {
  return db
    .query<{ last_assistant_event_id: number | null; last_seen_event_id: number | null }, [string]>(
      `SELECT last_assistant_event_id, last_seen_event_id FROM tasks WHERE id = ?`,
    )
    .get(taskId);
}

function makeRun(taskId: string): string {
  const runId = randomUUID();
  const now = Date.now();
  runs.insert({
    id: runId,
    taskId,
    agent: "claude-code",
    status: "running",
    startedAt: now,
    endedAt: null,
    exitCode: null,
    tmuxSession: "agetor-test-unread",
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
  });
  return runId;
}

// ---------------------------------------------------------------------------
// 1. runs.appendEvent: returns the inserted id, null on line_uuid dedup.
// ---------------------------------------------------------------------------

test("appendEvent returns the inserted event id, and null when a duplicate (run_id, line_uuid) is appended again", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    const runId = makeRun(taskId);

    const firstId = runs.appendEvent(runId, "assistant", "hello", "line-1");
    expect(typeof firstId).toBe("number");
    expect(firstId).not.toBeNull();

    // Same (run_id, line_uuid) again — the INSERT OR IGNORE dedup path.
    const dupeId = runs.appendEvent(runId, "assistant", "hello", "line-1");
    expect(dupeId).toBeNull();

    // A distinct line_uuid on the same run still inserts normally, with a
    // strictly greater id.
    const secondId = runs.appendEvent(runId, "assistant", "again", "line-2");
    expect(secondId).not.toBeNull();
    expect(secondId as number).toBeGreaterThan(firstId as number);

    // No line_uuid at all (e.g. a status/stderr chunk) always inserts.
    const thirdId = runs.appendEvent(runId, "status", "turn complete");
    expect(thirdId).not.toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// 2. tasks.noteAssistantEvent: sets when NULL, bumps only strictly-greater,
//    never moves backwards, never touches updatedAt.
// ---------------------------------------------------------------------------

test("noteAssistantEvent sets the watermark from NULL, bumps only for strictly-greater ids, and never touches updatedAt", async () => {
  const taskId = randomUUID();
  const inserted = tasks.insert(makeTaskRow(taskId));
  const originalUpdatedAt = inserted.updatedAt;
  try {
    expect(watermarkRow(taskId)?.last_assistant_event_id).toBeNull();

    // First bump: NULL -> 10.
    tasks.noteAssistantEvent(taskId, 10);
    expect(watermarkRow(taskId)?.last_assistant_event_id).toBe(10);

    // Older id: no-op, watermark stays at 10 (never moves backwards).
    tasks.noteAssistantEvent(taskId, 3);
    expect(watermarkRow(taskId)?.last_assistant_event_id).toBe(10);

    // Equal id: also a no-op (not strictly greater).
    tasks.noteAssistantEvent(taskId, 10);
    expect(watermarkRow(taskId)?.last_assistant_event_id).toBe(10);

    // Strictly greater id: bumps.
    tasks.noteAssistantEvent(taskId, 25);
    expect(watermarkRow(taskId)?.last_assistant_event_id).toBe(25);

    // None of the above touched updated_at — the watermark is server-managed
    // read/producer state, not a task mutation (db.ts's doc comment on
    // noteAssistantEvent).
    await new Promise((r) => setTimeout(r, 5));
    expect(tasks.get(taskId)?.updatedAt).toBe(originalUpdatedAt);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// 3. unread derivation lifecycle via tasks.get / tasks.list.
// ---------------------------------------------------------------------------

test("unread derivation: false on a fresh task, true after an assistant event, false after markSeen, true again on a later event", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    expect(tasks.get(taskId)?.unread).toBe(false);
    // Also true on the bulk list() path, not just the single-row get().
    expect(tasks.list().find((t) => t.id === taskId)?.unread).toBe(false);

    tasks.noteAssistantEvent(taskId, 100);
    expect(tasks.get(taskId)?.unread).toBe(true);
    expect(tasks.list().find((t) => t.id === taskId)?.unread).toBe(true);

    tasks.markSeen(taskId);
    expect(tasks.get(taskId)?.unread).toBe(false);

    // A later assistant event flips it true again.
    tasks.noteAssistantEvent(taskId, 101);
    expect(tasks.get(taskId)?.unread).toBe(true);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// 4. tasks.markSeen semantics.
// ---------------------------------------------------------------------------

test("markSeen returns the updated Task, is idempotent, and never touches updatedAt", async () => {
  const taskId = randomUUID();
  const inserted = tasks.insert(makeTaskRow(taskId));
  const originalUpdatedAt = inserted.updatedAt;
  try {
    tasks.noteAssistantEvent(taskId, 5);
    expect(tasks.get(taskId)?.unread).toBe(true);

    const seen = tasks.markSeen(taskId);
    expect(seen).not.toBeNull();
    expect(seen?.id).toBe(taskId);
    expect(seen?.unread).toBe(false);

    // Idempotent: calling again while already caught up still succeeds and
    // still returns the Task (not null), unread stays false.
    const seenAgain = tasks.markSeen(taskId);
    expect(seenAgain).not.toBeNull();
    expect(seenAgain?.unread).toBe(false);

    await new Promise((r) => setTimeout(r, 5));
    expect(tasks.get(taskId)?.updatedAt).toBe(originalUpdatedAt);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("markSeen no-ops (but still returns the Task) on a task with no assistant events at all", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    expect(watermarkRow(taskId)?.last_assistant_event_id).toBeNull();

    const seen = tasks.markSeen(taskId);
    expect(seen).not.toBeNull();
    expect(seen?.unread).toBe(false);
    // Guarded UPDATE's WHERE clause requires last_assistant_event_id IS NOT
    // NULL, so it never fires here — last_seen_event_id stays NULL too.
    expect(watermarkRow(taskId)?.last_seen_event_id).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("markSeen returns null for an unknown task id", () => {
  expect(tasks.markSeen("does-not-exist")).toBeNull();
});

// ---------------------------------------------------------------------------
// 5. Generic tasks.update doesn't clobber the watermarks.
// ---------------------------------------------------------------------------

test("a generic tasks.update (e.g. title change) does not clobber the unread watermarks", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    tasks.noteAssistantEvent(taskId, 42);
    expect(tasks.get(taskId)?.unread).toBe(true);

    const updated = tasks.update(taskId, { title: "renamed" });
    expect(updated?.title).toBe("renamed");
    // Unrelated edit must leave the watermark — and therefore unread — alone.
    expect(updated?.unread).toBe(true);
    expect(tasks.get(taskId)?.unread).toBe(true);
    expect(watermarkRow(taskId)?.last_assistant_event_id).toBe(42);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// 6. POST /tasks/:id/seen route.
// ---------------------------------------------------------------------------

test("POST /tasks/:id/seen returns 200 with the full Task JSON, unread flipped to false", async () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    tasks.noteAssistantEvent(taskId, 7);
    expect(tasks.get(taskId)?.unread).toBe(true);

    const res = await call(`/tasks/${taskId}/seen`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Task;
    expect(body.id).toBe(taskId);
    expect(body.unread).toBe(false);
    // Full Task shape, not just a partial ack — spot-check a couple of
    // unrelated fields round-tripped.
    expect(body.title).toBe("t");
    expect(body.column).toBe("ready");
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("POST /tasks/:id/seen 404s for an unknown task id", async () => {
  const res = await call(`/tasks/does-not-exist/seen`, { method: "POST" });
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("not found");
});

test("POST /tasks/:id/seen works on an archived task (clearing the dot in the archived view is not a mutation)", async () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    tasks.noteAssistantEvent(taskId, 3);
    tasks.update(taskId, { archivedAt: Date.now() });
    expect(tasks.get(taskId)?.unread).toBe(true);
    expect(tasks.get(taskId)?.archivedAt).not.toBeNull();

    const res = await call(`/tasks/${taskId}/seen`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Task;
    expect(body.unread).toBe(false);
    // Still archived — marking seen isn't a task mutation and shouldn't
    // touch archivedAt either way.
    expect(body.archivedAt).not.toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// 7. End-to-end through the real orchestrator chunk handler (fake claude
//    driver — see agents.ts's makeFakeAgent). This exercises the actual
//    `makeChunkHandler` code path in orchestrator.ts, not a reimplementation
//    of its logic at the db layer.
// ---------------------------------------------------------------------------

test("a run that never emits an assistant chunk (user prompt + stdout + status only) never flips unread", async () => {
  const created = await createTask({
    title: "no assistant chunk",
    prompt: "hello world",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  try {
    const res = await startTask(taskId);
    expect("runId" in res).toBe(true);

    // Default fake driver: onChunk("user", prompt) fires synchronously at
    // spawn (real makeChunkHandler code path — the exact same closure a real
    // claude-tmux run would use), then onChunk("stdout", ...) at ~5ms, then
    // onChunk("status", "turn complete") + resolveDone(0) at ~20ms. None of
    // "user"/"stdout"/"status" are the "assistant" stream the detector keys
    // on, so the watermark should never move.
    await new Promise((r) => setTimeout(r, 200));

    const after = tasks.get(taskId);
    expect(after?.column).toBe("review"); // ran to completion
    expect(after?.unread).toBe(false);
    expect(watermarkRow(taskId)?.last_assistant_event_id).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("a run that emits a top-level assistant chunk flips the task to unread by the time it settles", async () => {
  const prevTodos = process.env.AGETOR_FAKE_CLAUDE_TODOS;
  process.env.AGETOR_FAKE_CLAUDE_TODOS = "1";

  const created = await createTask({
    title: "assistant chunk",
    prompt: "plan and implement",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  try {
    const res = await startTask(taskId);
    expect("runId" in res).toBe(true);

    // The AGETOR_FAKE_CLAUDE_TODOS scenario (agents.ts's makeFakeAgent) emits
    // a TaskCreate/TaskUpdate tool_use/tool_result sequence, THEN a single
    // top-level onChunk("assistant", "Starting Phase 1 — Investigate now.")
    // at ~23ms, then status/done at ~26ms — exercising the real chunk
    // handler with the same tool_use/tool_result chunks a genuine plan-mode
    // session produces, none of which should flip the watermark on their
    // own; only the assistant chunk does.
    await new Promise((r) => setTimeout(r, 250));

    const after = tasks.get(taskId);
    expect(after?.column).toBe("review");
    expect(after?.unread).toBe(true);
    expect(watermarkRow(taskId)?.last_assistant_event_id).not.toBeNull();
  } finally {
    if (prevTodos === undefined) delete process.env.AGETOR_FAKE_CLAUDE_TODOS;
    else process.env.AGETOR_FAKE_CLAUDE_TODOS = prevTodos;
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// 8. Task.hasAssistantMessages derivation, and tasks.markUnread no-op on a
//    task that has never observed an assistant event (nothing to re-flag).
// ---------------------------------------------------------------------------

test("hasAssistantMessages is false on a fresh task and flips true after noteAssistantEvent; markUnread is a no-op with no assistant event yet", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    expect(tasks.get(taskId)?.hasAssistantMessages).toBe(false);

    // No assistant event yet — `last_assistant_event_id IS NOT NULL` guard
    // fails, so this is a no-op: still caught-up/false on both derived
    // fields, not a spurious unread flip.
    const noop = tasks.markUnread(taskId);
    expect(noop).not.toBeNull();
    expect(noop?.unread).toBe(false);
    expect(noop?.hasAssistantMessages).toBe(false);
    expect(watermarkRow(taskId)?.last_seen_event_id).toBeNull();

    tasks.noteAssistantEvent(taskId, 1);
    expect(tasks.get(taskId)?.hasAssistantMessages).toBe(true);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// 9. tasks.markUnread semantics: flips a caught-up task back to unread, and
//    is idempotent (the raw watermark column doesn't keep moving on repeat
//    calls).
// ---------------------------------------------------------------------------

test("markUnread flips a caught-up task back to unread, and is idempotent (raw last_seen_event_id column stable across repeat calls)", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    tasks.noteAssistantEvent(taskId, 20);
    tasks.markSeen(taskId);
    expect(tasks.get(taskId)?.unread).toBe(false);

    const unread = tasks.markUnread(taskId);
    expect(unread).not.toBeNull();
    expect(unread?.id).toBe(taskId);
    expect(unread?.unread).toBe(true);
    // last_assistant_event_id - 1: exactly the latest message reads as
    // unread, not the whole history.
    expect(watermarkRow(taskId)?.last_seen_event_id).toBe(19);

    // Idempotent: calling again while already unread is a no-op (the `>=`
    // guard fails once last_seen_event_id < last_assistant_event_id), and
    // the raw column does not move any further on the repeat call.
    const unreadAgain = tasks.markUnread(taskId);
    expect(unreadAgain).not.toBeNull();
    expect(unreadAgain?.unread).toBe(true);
    expect(watermarkRow(taskId)?.last_seen_event_id).toBe(19);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// 10. markSeen re-clears after markUnread, and a later assistant event
//     flips it back to unread again — watermark semantics stay intact
//     through a full mark-unread → mark-seen → new-message cycle.
// ---------------------------------------------------------------------------

test("markSeen re-clears after markUnread, and a later assistant event flips it back to unread", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    tasks.noteAssistantEvent(taskId, 30);
    tasks.markSeen(taskId);
    expect(tasks.get(taskId)?.unread).toBe(false);

    tasks.markUnread(taskId);
    expect(tasks.get(taskId)?.unread).toBe(true);

    const seenAgain = tasks.markSeen(taskId);
    expect(seenAgain?.unread).toBe(false);
    expect(watermarkRow(taskId)?.last_seen_event_id).toBe(30);

    tasks.noteAssistantEvent(taskId, 31);
    expect(tasks.get(taskId)?.unread).toBe(true);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// 11. markUnread's guard: a task that's already unread because of a
//     watermark well below (not just caught up to) last_assistant_event_id
//     must not have its raw last_seen_event_id column moved at all — the
//     `>=` guard only fires when the task is currently caught-up-or-ahead.
// ---------------------------------------------------------------------------

test("markUnread does not move the raw watermark when the task is already unread via a lower (not just caught-up) last_seen_event_id", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    tasks.noteAssistantEvent(taskId, 10);
    tasks.markSeen(taskId); // caught up at 10
    tasks.noteAssistantEvent(taskId, 50); // new message; last_seen_event_id stays at 10, well below 50
    expect(watermarkRow(taskId)?.last_seen_event_id).toBe(10);
    expect(tasks.get(taskId)?.unread).toBe(true);

    const result = tasks.markUnread(taskId);
    expect(result).not.toBeNull();
    expect(result?.unread).toBe(true);
    // Guard `COALESCE(last_seen_event_id, 0) >= last_assistant_event_id`
    // (10 >= 50) is false, so the UPDATE never fires — the raw column must
    // stay exactly where it was, not jump up to last_assistant_event_id - 1.
    expect(watermarkRow(taskId)?.last_seen_event_id).toBe(10);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// 12. Neither markUnread nor markSeen bumps updated_at — both are
//     server-managed read-state, not a task mutation.
// ---------------------------------------------------------------------------

test("markUnread and markSeen never touch updatedAt, across a full mark-unread/mark-seen cycle", async () => {
  const taskId = randomUUID();
  const inserted = tasks.insert(makeTaskRow(taskId));
  const originalUpdatedAt = inserted.updatedAt;
  try {
    tasks.noteAssistantEvent(taskId, 5);

    await new Promise((r) => setTimeout(r, 5));
    tasks.markSeen(taskId);
    expect(tasks.get(taskId)?.updatedAt).toBe(originalUpdatedAt);

    await new Promise((r) => setTimeout(r, 5));
    tasks.markUnread(taskId);
    expect(tasks.get(taskId)?.updatedAt).toBe(originalUpdatedAt);

    await new Promise((r) => setTimeout(r, 5));
    tasks.markSeen(taskId);
    expect(tasks.get(taskId)?.updatedAt).toBe(originalUpdatedAt);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// 13. markUnread on an unknown task id.
// ---------------------------------------------------------------------------

test("markUnread returns null for an unknown task id", () => {
  expect(tasks.markUnread("does-not-exist")).toBeNull();
});

// ---------------------------------------------------------------------------
// 14. DELETE /tasks/:id/seen route ("Mark as unread" in the board's task
//     context menu).
// ---------------------------------------------------------------------------

test("DELETE /tasks/:id/seen returns 200 with the full Task JSON, unread flipped to true, and stays true on a repeat call", async () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    tasks.noteAssistantEvent(taskId, 7);
    const seenRes = await call(`/tasks/${taskId}/seen`, { method: "POST" });
    expect(seenRes.status).toBe(200);
    expect(((await seenRes.json()) as Task).unread).toBe(false);

    const res = await call(`/tasks/${taskId}/seen`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Task;
    expect(body.id).toBe(taskId);
    expect(body.unread).toBe(true);
    expect(body.hasAssistantMessages).toBe(true);
    // Full Task shape, not just a partial ack.
    expect(body.title).toBe("t");
    expect(body.column).toBe("ready");

    // Repeat DELETE: still 200, still unread (idempotent no-op underneath).
    const res2 = await call(`/tasks/${taskId}/seen`, { method: "DELETE" });
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as Task).unread).toBe(true);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("DELETE /tasks/:id/seen 404s for an unknown task id, and 401s without a bearer token", async () => {
  const res = await call(`/tasks/does-not-exist/seen`, { method: "DELETE" });
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("not found");

  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    tasks.noteAssistantEvent(taskId, 1);
    const unauthed = await fetch(`${BASE}/tasks/${taskId}/seen`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    });
    expect(unauthed.status).toBe(401);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("DELETE /tasks/:id/seen works on an archived task (re-flagging in the archived view is not a mutation)", async () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    tasks.noteAssistantEvent(taskId, 3);
    tasks.markSeen(taskId);
    tasks.update(taskId, { archivedAt: Date.now() });
    expect(tasks.get(taskId)?.unread).toBe(false);
    expect(tasks.get(taskId)?.archivedAt).not.toBeNull();

    const res = await call(`/tasks/${taskId}/seen`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Task;
    expect(body.unread).toBe(true);
    // Still archived — marking unread isn't a task mutation and shouldn't
    // touch archivedAt either way.
    expect(body.archivedAt).not.toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

// ---------------------------------------------------------------------------
// 15. hasAssistantMessages surfaces on both GET /tasks and GET /tasks/:id
//     (the board's task context menu gates "Mark as unread" on it).
// ---------------------------------------------------------------------------

test("GET /tasks and GET /tasks/:id include hasAssistantMessages as a boolean, flipping true after an assistant event", async () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    const singleBefore = await call(`/tasks/${taskId}`);
    const singleBeforeBody = (await singleBefore.json()) as Task;
    expect(typeof singleBeforeBody.hasAssistantMessages).toBe("boolean");
    expect(singleBeforeBody.hasAssistantMessages).toBe(false);

    const listBefore = (await (await call(`/tasks`)).json()) as Task[];
    const listBeforeRow = listBefore.find((t) => t.id === taskId);
    expect(typeof listBeforeRow?.hasAssistantMessages).toBe("boolean");
    expect(listBeforeRow?.hasAssistantMessages).toBe(false);

    tasks.noteAssistantEvent(taskId, 9);

    const singleAfter = (await (await call(`/tasks/${taskId}`)).json()) as Task;
    expect(singleAfter.hasAssistantMessages).toBe(true);

    const listAfter = (await (await call(`/tasks`)).json()) as Task[];
    const listAfterRow = listAfter.find((t) => t.id === taskId);
    expect(listAfterRow?.hasAssistantMessages).toBe(true);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});
