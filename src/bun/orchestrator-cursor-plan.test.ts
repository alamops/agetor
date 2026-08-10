import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Task } from "../shared/types.ts";

// db.ts captures AGETOR_DATA_DIR at first import — set before any import of
// ./db.ts or ./orchestrator.ts.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-cursor-plan-"));
// Drive cursor through the in-process fake (no tmux, no real CLI).
process.env.AGETOR_CURSOR_DRIVER = "fake";
process.env.AGETOR_CURSOR_BIN = "/bin/echo";
// Make every fake cursor turn in this file end on a `createPlanToolCall` —
// see `makeFakeCursorPlanAgent` in agents.ts. This is safe file-wide: plan
// detection itself is still gated on cursor-kind in `detectCursorPlan`, so a
// claude-code task (used only for the non-cursor guard test) is unaffected.
process.env.AGETOR_FAKE_CURSOR_PLAN = "1";
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT.
process.env.AGETOR_API_PORT = "4517";

const BASE = "http://127.0.0.1:4517";

let server: { stop: () => void };
let token: string;
let createTask: typeof import("./orchestrator.ts").createTask;
let startTask: typeof import("./orchestrator.ts").startTask;
let sendInput: typeof import("./orchestrator.ts").sendInput;
let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;
let db: typeof import("./db.ts").db;
let harnesses: typeof import("./db.ts").harnesses;

beforeAll(async () => {
  ({ createTask, startTask, sendInput } = await import("./orchestrator.ts"));
  ({ tasks, runs, db, harnesses } = await import("./db.ts"));
  harnesses.setEnabled("cursor", true);
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

async function settle(ms = 80) {
  await new Promise((r) => setTimeout(r, ms));
}

const call = (p: string, init: RequestInit = {}) =>
  fetch(`${BASE}${p}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

/** A fresh scratch dir per task — NEVER a real repo. Approving a plan writes
 *  a real `.cursor/plans/*.plan.md` file under this dir (isolation: "none"
 *  means the cwd is the workdir itself), so this must be a throwaway temp
 *  dir, not process.cwd() / the actual agetor repo. */
function scratchWorkdir(): string {
  return mkdtempSync(path.join(tmpdir(), "agetor-plan-wd-"));
}

async function newCursorTask(opts: { mode?: string } = {}): Promise<{ id: string; workdir: string }> {
  const workdir = scratchWorkdir();
  const created = await createTask({
    title: "cursor plan task",
    prompt: "make a plan",
    agent: "cursor",
    workdir,
    isolation: "none",
    taskType: "task",
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
  if ("error" in created) throw new Error(created.error);
  return { id: created.task.id, workdir };
}

/** Starts the task and waits for the fake driver's turn (and the plan
 *  detection it triggers in attachDoneHandler) to resolve. Returns the
 *  freshly-read task plus the run id that produced the plan. */
async function startAndDetect(id: string): Promise<{ task: Task; runId: string }> {
  const started = await startTask(id);
  if ("error" in started) throw new Error(started.error);
  const runId = "runId" in started ? started.runId : "";
  await settle();
  const task = tasks.get(id)!;
  return { task, runId };
}

const FAKE_PLAN_MARKDOWN = "# Fake Plan\n\n- step one\n- step two";

// --- 1. Detection: a run ending on createPlanToolCall lands a pending plan --

test("cursor run ending on createPlanToolCall lands in review with a pending plan", async () => {
  const { id } = await newCursorTask();
  const { task, runId } = await startAndDetect(id);

  expect(task.column).toBe("review");
  expect(task.plans.length).toBe(1);
  const plan = task.plans[0]!;
  expect(plan.status).toBe("pending");
  expect(plan.content).toBe(FAKE_PLAN_MARKDOWN);
  // Real cursor call_ids embed a newline (plan §2) — the fake mirrors that.
  expect(plan.toolCallId).toContain("\n");
  expect(plan.runId).toBe(runId);

  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

// --- 2. PATCH edit route ----------------------------------------------------

test("PATCH plan edit: validation and persistence", async () => {
  const { id } = await newCursorTask();
  const { task } = await startAndDetect(id);
  const planId = task.plans[0]!.id;
  const originalContent = task.plans[0]!.content;

  // Whitespace-only edit is rejected outright.
  let res = await call(`/tasks/${id}/plans/${planId}`, {
    method: "PATCH",
    body: JSON.stringify({ editedContent: "   \n  " }),
  });
  expect(res.status).toBe(400);

  // Oversized edit (>256 KiB) is rejected.
  const huge = "a".repeat(256 * 1024 + 1);
  res = await call(`/tasks/${id}/plans/${planId}`, {
    method: "PATCH",
    body: JSON.stringify({ editedContent: huge }),
  });
  expect(res.status).toBe(400);

  // A valid edit persists.
  res = await call(`/tasks/${id}/plans/${planId}`, {
    method: "PATCH",
    body: JSON.stringify({ editedContent: "an edited plan" }),
  });
  expect(res.status).toBe(200);
  let body = (await res.json()) as Task;
  expect(body.plans[0]!.editedContent).toBe("an edited plan");

  // An edit equal to the original content normalizes to null (no draft).
  res = await call(`/tasks/${id}/plans/${planId}`, {
    method: "PATCH",
    body: JSON.stringify({ editedContent: originalContent }),
  });
  expect(res.status).toBe(200);
  body = (await res.json()) as Task;
  expect(body.plans[0]!.editedContent).toBeNull();

  // Approve the plan, then confirm further edits are rejected (not pending).
  const approveRes = await call(`/tasks/${id}/plans/${planId}/approve`, { method: "POST" });
  expect(approveRes.status).toBe(200);
  res = await call(`/tasks/${id}/plans/${planId}`, {
    method: "PATCH",
    body: JSON.stringify({ editedContent: "too late" }),
  });
  expect(res.status).toBe(400);

  // Edit on a missing plan id is also rejected.
  res = await call(`/tasks/${id}/plans/does-not-exist`, {
    method: "PATCH",
    body: JSON.stringify({ editedContent: "x" }),
  });
  expect(res.status).toBe(400);

  await settle(); // let the approval's follow-up turn quiesce before teardown
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

// --- 3. Approve unedited -----------------------------------------------------

test("approve (unedited): writes the original content to .cursor/plans, marks approved, sends an approval message", async () => {
  const { id, workdir } = await newCursorTask(); // mode defaults to auto
  const { task: beforeApprove } = await startAndDetect(id);
  const plan = beforeApprove.plans[0]!;
  const runCountBefore = runs.listForTask(id).length;

  const res = await call(`/tasks/${id}/plans/${plan.id}/approve`, { method: "POST" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Task;
  const approved = body.plans.find((p) => p.id === plan.id)!;
  expect(approved.status).toBe("approved");
  expect(approved.approvedEdited).toBe(false);
  expect(approved.filePath).not.toBeNull();

  const filePath = path.join(workdir, approved.filePath!);
  expect(approved.filePath).toBe(path.join(".cursor", "plans", `fake_plan_${plan.id}.plan.md`));
  expect(existsSync(filePath)).toBe(true);
  expect(readFileSync(filePath, "utf8")).toBe(FAKE_PLAN_MARKDOWN);

  // A new run was spawned to deliver the approval, and it carries a `user`
  // event with the (unedited) approval wording — auto mode does NOT embed
  // the full plan text.
  expect(runs.listForTask(id).length).toBe(runCountBefore + 1);
  const events = runs.eventsForTask(id);
  const approvalEvent = events.find(
    (e) => e.stream === "user" && e.data.includes("The plan is approved"),
  );
  expect(approvalEvent).toBeDefined();
  expect(approvalEvent!.data).toContain(approved.filePath!);
  expect(approvalEvent!.data).not.toContain("with edits by the user");
  expect(approvalEvent!.data).not.toContain("--- Approved plan ---");
  expect(approvalEvent!.runId).not.toBe(beforeApprove.runId);

  await settle(); // let the follow-up turn (which detects its own plan) quiesce
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

// --- 4. Approve edited -------------------------------------------------------

test("approve (edited): writes the EDITED content, wording says 'with edits', approvedEdited=true", async () => {
  const { id, workdir } = await newCursorTask();
  const { task } = await startAndDetect(id);
  const plan = task.plans[0]!;

  const patchRes = await call(`/tasks/${id}/plans/${plan.id}`, {
    method: "PATCH",
    body: JSON.stringify({ editedContent: "# Edited Plan\n\n- do it differently" }),
  });
  expect(patchRes.status).toBe(200);

  const res = await call(`/tasks/${id}/plans/${plan.id}/approve`, { method: "POST" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Task;
  const approved = body.plans.find((p) => p.id === plan.id)!;
  expect(approved.approvedEdited).toBe(true);

  const filePath = path.join(workdir, approved.filePath!);
  expect(readFileSync(filePath, "utf8")).toBe("# Edited Plan\n\n- do it differently");

  const events = runs.eventsForTask(id);
  const approvalEvent = events.find(
    (e) => e.stream === "user" && e.data.includes("with edits by the user"),
  );
  expect(approvalEvent).toBeDefined();
  expect(approvalEvent!.data).toContain(approved.filePath!);

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

// --- 5. Ask-mode embeds the full plan ---------------------------------------

test("approve on an ask-mode task embeds the full effective plan inline", async () => {
  const { id } = await newCursorTask({ mode: "ask" });
  const { task } = await startAndDetect(id);
  const plan = task.plans[0]!;

  const res = await call(`/tasks/${id}/plans/${plan.id}/approve`, { method: "POST" });
  expect(res.status).toBe(200);

  const events = runs.eventsForTask(id);
  const approvalEvent = events.find(
    (e) => e.stream === "user" && e.data.includes("The plan is approved"),
  );
  expect(approvalEvent).toBeDefined();
  expect(approvalEvent!.data).toContain("--- Approved plan ---");
  expect(approvalEvent!.data).toContain(FAKE_PLAN_MARKDOWN);

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

// --- 6. Double-approve --------------------------------------------------------

test("double-approve: the second POST is rejected and does not re-send", async () => {
  const { id } = await newCursorTask();
  const { task } = await startAndDetect(id);
  const plan = task.plans[0]!;

  const first = await call(`/tasks/${id}/plans/${plan.id}/approve`, { method: "POST" });
  expect(first.status).toBe(200);
  const runCountAfterFirst = runs.listForTask(id).length;

  const second = await call(`/tasks/${id}/plans/${plan.id}/approve`, { method: "POST" });
  expect(second.status).toBeGreaterThanOrEqual(400);
  expect(second.status).toBeLessThan(500);

  // No second turn was spawned for the rejected second approve.
  expect(runs.listForTask(id).length).toBe(runCountAfterFirst);

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

// --- 7. Supersede -------------------------------------------------------------

test("a second detected plan supersedes a still-pending first plan", async () => {
  const { id } = await newCursorTask();
  const { task: firstState, runId: firstRunId } = await startAndDetect(id);
  const firstPlan = firstState.plans[0]!;
  expect(firstPlan.status).toBe("pending");

  // Leave the first plan un-approved and send another turn — the fake
  // driver emits a brand-new call_id per spawn, so this is a genuinely new
  // plan, not a re-detection of the same one.
  const sendResult = await sendInput(firstRunId, "keep going");
  expect(sendResult.delivered).toBe(true);
  await settle();

  const after = tasks.get(id)!;
  expect(after.plans.length).toBe(2);
  const [supersededPlan, newPlan] = after.plans;
  expect(supersededPlan!.id).toBe(firstPlan.id);
  expect(supersededPlan!.status).toBe("superseded");
  expect(newPlan!.status).toBe("pending");
  expect(newPlan!.toolCallId).not.toBe(firstPlan.toolCallId);

  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

// --- 8. Archived task --------------------------------------------------------

test("archived task: both PATCH edit and approve are rejected", async () => {
  const { id } = await newCursorTask();
  const { task } = await startAndDetect(id);
  const plan = task.plans[0]!;

  tasks.update(id, { archivedAt: Date.now() });

  const patchRes = await call(`/tasks/${id}/plans/${plan.id}`, {
    method: "PATCH",
    body: JSON.stringify({ editedContent: "nope" }),
  });
  expect(patchRes.status).toBe(400);

  const approveRes = await call(`/tasks/${id}/plans/${plan.id}/approve`, { method: "POST" });
  expect(approveRes.status).toBe(400);

  // Plan is still pending, untouched.
  expect(tasks.get(id)!.plans[0]!.status).toBe("pending");

  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

// --- 9. Non-cursor task guard --------------------------------------------------

test("plan routes 400 on a non-cursor (claude-code) task, before any runId/plan check", async () => {
  // No need to start this task at all: `planCursorKindGuard` runs
  // immediately after the task lookup, before either route touches
  // `task.plans` or `task.runId` — so the guard fires even for a
  // never-started task with an empty `plans` array and a bogus plan id.
  const created = await createTask({
    title: "claude guard",
    prompt: "noop",
    agent: "claude-code",
    workdir: scratchWorkdir(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const id = created.task.id;
  expect(created.task.runId).toBeNull();
  expect(created.task.plans).toHaveLength(0);

  const patchRes = await call(`/tasks/${id}/plans/whatever`, {
    method: "PATCH",
    body: JSON.stringify({ editedContent: "x" }),
  });
  expect(patchRes.status).toBe(400);
  const patchBody = (await patchRes.json()) as { error: string };
  expect(patchBody.error).toContain("cursor");

  const approveRes = await call(`/tasks/${id}/plans/whatever/approve`, { method: "POST" });
  expect(approveRes.status).toBe(400);
  const approveBody = (await approveRes.json()) as { error: string };
  expect(approveBody.error).toContain("cursor");

  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});
