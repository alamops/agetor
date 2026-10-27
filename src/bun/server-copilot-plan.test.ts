// HTTP-level tests for the GitHub Copilot server routes (T9 / TT5 of
// docs/plans/github-copilot-harness.md): `POST /harnesses` accepts the
// `copilot` kind, both `/agent-models` maps carry it, and the plan routes
// (`planKindGuard`) approve a copilot plan WITHOUT writing a file — the
// effective plan always rides inline in the approval message, an unbound Plan
// task flips to Auto (reverted when the send fails), a profile-bound task keeps
// Plan and gets the warning, and a concurrent approve is a 409.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Harness, Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// db.ts captures AGETOR_DATA_DIR at first import — set before any import of
// ./db.ts or ./orchestrator.ts.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-copilot-plan-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Drive copilot through the in-process fake (no tmux, no real CLI).
process.env.AGETOR_COPILOT_DRIVER = "fake";
// The identity gate in `checkHarness` requires "GitHub Copilot CLI" in
// `--version` (it rules out AWS Copilot's same-named binary), so `/bin/echo`
// can't stand in — plant a tiny stub script instead.
const STUB_DIR = mkdtempSync(path.join(tmpdir(), "agetor-copilot-plan-bin-"));
const STUB_BIN = path.join(STUB_DIR, "copilot");
writeFileSync(STUB_BIN, '#!/bin/sh\necho "GitHub Copilot CLI 1.34.0"\n');
chmodSync(STUB_BIN, 0o755);
process.env.AGETOR_COPILOT_BIN = STUB_BIN;
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT.
process.env.AGETOR_API_PORT = "4766";

const BASE = "http://127.0.0.1:4766";

let server: { stop: () => void };
let token: string;
let createTask: typeof import("./orchestrator.ts").createTask;
let startTask: typeof import("./orchestrator.ts").startTask;
let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;
let db: typeof import("./db.ts").db;
let harnesses: typeof import("./db.ts").harnesses;
let upsertDetectedPlan: typeof import("./task-plans.ts").upsertDetectedPlan;
const scratchDirs: string[] = [];

beforeAll(async () => {
  ({ createTask, startTask } = await import("./orchestrator.ts"));
  ({ tasks, runs, db, harnesses } = await import("./db.ts"));
  ({ upsertDetectedPlan } = await import("./task-plans.ts"));
  harnesses.setEnabled("copilot", true);
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
  rmTestDataDir(DATA_DIR);
  rmTestDataDir(STUB_DIR);
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

const PLAN_MARKDOWN = "# Copilot Plan\n\n- step one\n- step two";
const FLIP_STATUS = "plan approved — switched this task to Auto so GitHub Copilot can implement it";
const BOUND_WARNING =
  "plan approved, but this task's agent runs GitHub Copilot in Plan mode — detach the agent or switch the mode to implement";

/** A throwaway workdir per task (never a real repo); `isolation: "none"`
 *  makes it the agent's cwd, which is where a (wrongly) written plan file
 *  would land. */
function scratchWorkdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-copilot-plan-wd-"));
  scratchDirs.push(dir);
  return dir;
}

/** Creates + starts a copilot task, waits for the fake turn to settle, then
 *  records a pending plan on it (the way `detectCopilotPlan` would) and
 *  returns the fresh task. */
async function newPlannedTask(
  opts: { agent?: string; mode?: string } = {},
): Promise<{ id: string; workdir: string; task: Task }> {
  const workdir = scratchWorkdir();
  const created = await createTask({
    title: "copilot plan task",
    prompt: "make a plan",
    agent: opts.agent ?? "copilot",
    workdir,
    isolation: "none",
    taskType: "task",
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
  if ("error" in created) throw new Error(created.error);
  const id = created.task.id;
  const started = await startTask(id);
  if ("error" in started) throw new Error(started.error);
  await settle();
  const running = tasks.get(id)!;
  tasks.update(id, {
    plans: upsertDetectedPlan(running.plans, {
      toolCallId: `copilot-plan:${running.runId}`,
      runId: running.runId!,
      name: null,
      content: PLAN_MARKDOWN,
      now: Date.now(),
    }),
  });
  return { id, workdir, task: tasks.get(id)! };
}

const approve = (id: string, planId: string) =>
  call(`/tasks/${id}/plans/${planId}/approve`, { method: "POST" });

// --- Harness + model routes ----------------------------------------------

test("POST /harnesses accepts kind copilot", async () => {
  const res = await call("/harnesses", {
    method: "POST",
    body: JSON.stringify({ id: "copilot-work", kind: "copilot", label: "Copilot (work)" }),
  });
  expect(res.status).toBe(200);
  const created = (await res.json()) as Harness;
  expect(created.kind).toBe("copilot");
  expect(created.id).toBe("copilot-work");
  db.run(`DELETE FROM harnesses WHERE id = 'copilot-work'`);
});

test("POST /harnesses with an unknown kind lists copilot in the error copy", async () => {
  const res = await call("/harnesses", {
    method: "POST",
    body: JSON.stringify({ id: "nope", kind: "bogus", label: "x" }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("'copilot'");
});

test("GET and POST /agent-models carry a copilot key", async () => {
  const got = (await (await call("/agent-models")).json()) as Record<string, unknown>;
  expect(got).toHaveProperty("copilot");
  expect(Array.isArray(got.copilot)).toBe(true);
  const posted = (await (await call("/agent-models?harness=copilot", { method: "POST" })).json()) as Record<
    string,
    unknown
  >;
  expect(posted).toHaveProperty("copilot");
});

// --- Plan approve ----------------------------------------------------------

test("approve on an unbound plan-mode copilot task flips to auto, embeds the plan, writes no file", async () => {
  const { id, workdir, task } = await newPlannedTask({ mode: "plan" });
  expect(task.mode).toBe("plan");
  const plan = task.plans[0]!;
  const planRunId = task.runId!;
  const runCountBefore = runs.listForTask(id).length;

  // The approval's `user` event is emitted synchronously from the follow-up
  // turn's spawn — read the persisted mode at that exact moment.
  const { subscribe } = await import("./orchestrator.ts");
  let modeWhenSent: string | null | undefined;
  const unsubscribe = subscribe((e) => {
    if (e.taskId === id && e.stream === "user" && e.data.includes("The plan is approved")) {
      modeWhenSent = tasks.get(id)?.mode;
    }
  });
  let res: Response;
  try {
    res = await approve(id, plan.id);
  } finally {
    unsubscribe();
  }
  expect(res.status).toBe(200);
  const body = (await res.json()) as Task & { warning?: string };
  expect(body.mode).toBe("auto");
  expect(body.warning).toBeUndefined();
  const approved = body.plans.find((p) => p.id === plan.id)!;
  expect(approved.status).toBe("approved");
  expect(approved.approvedEdited).toBe(false);
  expect(approved.filePath).toBeNull();
  expect(modeWhenSent).toBe("auto");

  // A new run delivered the approval, and its message embeds the plan.
  expect(runs.listForTask(id).length).toBe(runCountBefore + 1);
  const events = runs.eventsForTask(id);
  const approvalEvent = events.find((e) => e.stream === "user" && e.data.includes("The plan is approved"));
  expect(approvalEvent).toBeDefined();
  expect(approvalEvent!.data).toContain("implement it now");
  expect(approvalEvent!.data).toContain("Approved plan:");
  expect(approvalEvent!.data).toContain(PLAN_MARKDOWN);
  expect(approvalEvent!.data).not.toContain("edits by the user");
  const flipLine = events.find((e) => e.stream === "status" && e.data === FLIP_STATUS);
  expect(flipLine).toBeDefined();
  expect(flipLine!.runId).toBe(planRunId);

  // Nothing written under the workdir (no .copilot / .cursor plan files).
  expect(existsSync(path.join(workdir, ".copilot"))).toBe(false);
  expect(existsSync(path.join(workdir, ".cursor"))).toBe(false);
  expect(readdirSync(workdir)).toEqual([]);

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

test("approve of an edited plan sends the edited text", async () => {
  const { id, workdir, task } = await newPlannedTask();
  const plan = task.plans[0]!;
  const EDITED = "# Edited Plan\n\n- do it differently";

  const patchRes = await call(`/tasks/${id}/plans/${plan.id}`, {
    method: "PATCH",
    body: JSON.stringify({ editedContent: EDITED }),
  });
  expect(patchRes.status).toBe(200);

  const res = await approve(id, plan.id);
  expect(res.status).toBe(200);
  const body = (await res.json()) as Task;
  const approved = body.plans.find((p) => p.id === plan.id)!;
  expect(approved.approvedEdited).toBe(true);
  expect(approved.filePath).toBeNull();

  const approvalEvent = runs
    .eventsForTask(id)
    .find((e) => e.stream === "user" && e.data.includes("The plan is approved"));
  expect(approvalEvent).toBeDefined();
  expect(approvalEvent!.data).toContain("edits by the user");
  expect(approvalEvent!.data).toContain("follow this version");
  expect(approvalEvent!.data).toContain(EDITED);
  expect(approvalEvent!.data).not.toContain("- step one");
  expect(readdirSync(workdir)).toEqual([]);

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

test("approve on a profile-bound plan-mode copilot task keeps plan and returns the warning", async () => {
  const { id, task } = await newPlannedTask({ mode: "plan" });
  const plan = task.plans[0]!;
  const planRunId = task.runId!;
  tasks.setAgentProfile(id, "synthetic-profile-1", null);

  const res = await approve(id, plan.id);
  expect(res.status).toBe(200);
  const body = (await res.json()) as Task & { warning?: string };
  expect(body.mode).toBe("plan");
  expect(body.warning).toBe(BOUND_WARNING);
  expect(body.plans.find((p) => p.id === plan.id)!.status).toBe("approved");
  expect(tasks.get(id)!.mode).toBe("plan");

  const events = runs.eventsForTask(id);
  const warningLine = events.find((e) => e.stream === "status" && e.data === BOUND_WARNING);
  expect(warningLine).toBeDefined();
  expect(warningLine!.runId).toBe(planRunId);
  expect(events.some((e) => e.data === FLIP_STATUS)).toBe(false);
  const approvalEvent = events.find((e) => e.stream === "user" && e.data.includes("The plan is approved"));
  expect(approvalEvent!.data).toContain(PLAN_MARKDOWN);
  // The plan is embedded exactly once (cursor's `--- Approved plan ---`
  // appendix is not added on top of copilot's inline form).
  expect(approvalEvent!.data).not.toContain("--- Approved plan ---");

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

test("a plan-mode approve whose message is not delivered reverts the flip and leaves the plan pending", async () => {
  const { id, task } = await newPlannedTask({ mode: "plan" });
  const plan = task.plans[0]!;
  // A run row naming a harness that doesn't resolve makes `sendInput` refuse
  // after the route already flipped the mode.
  db.run(`UPDATE runs SET agent = 'synthetic-missing-harness' WHERE id = ?`, [task.runId!]);

  const res = await approve(id, plan.id);
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toContain("approval message not delivered");

  const after = tasks.get(id)!;
  expect(after.mode).toBe("plan");
  expect(after.plans.find((p) => p.id === plan.id)!.status).toBe("pending");
  expect(runs.eventsForTask(id).some((e) => e.data === FLIP_STATUS)).toBe(false);

  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

test("a concurrent approve of the same plan is refused and the approval is sent once", async () => {
  const { id, task } = await newPlannedTask();
  const plan = task.plans[0]!;

  // Several POSTs in one tick. The first claims `approvalsInFlight` before any
  // `await`; the fake driver settles so quickly that a loser may land either
  // while the claim is held (409 "already in flight") or just after the plan
  // left `pending` (400) — the contract is that exactly one is delivered and
  // every other request is refused.
  const responses = await Promise.all(Array.from({ length: 6 }, () => approve(id, plan.id)));
  const statuses = responses.map((r) => r.status);
  expect(statuses.filter((s) => s === 200)).toHaveLength(1);
  expect(statuses.every((s) => s === 200 || s === 409 || s === 400)).toBe(true);

  const approvalEvents = runs
    .eventsForTask(id)
    .filter((e) => e.stream === "user" && e.data.includes("The plan is approved"));
  expect(approvalEvents).toHaveLength(1);
  expect(tasks.get(id)!.plans.find((p) => p.id === plan.id)!.status).toBe("approved");

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

// --- Kind guard ----------------------------------------------------------

test("plan routes 400 on a codex task with the new copy, before any plan lookup", async () => {
  const created = await createTask({
    title: "codex guard",
    prompt: "noop",
    agent: "codex",
    workdir: scratchWorkdir(),
    isolation: "none",
    taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const id = created.task.id;

  const patchRes = await call(`/tasks/${id}/plans/whatever`, {
    method: "PATCH",
    body: JSON.stringify({ editedContent: "x" }),
  });
  expect(patchRes.status).toBe(400);
  expect(((await patchRes.json()) as { error: string }).error).toContain("cursor or GitHub Copilot");

  const approveRes = await approve(id, "whatever");
  expect(approveRes.status).toBe(400);
  expect(((await approveRes.json()) as { error: string }).error).toContain("cursor or GitHub Copilot");

  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

test("PATCH plan edit works on a copilot task", async () => {
  const { id, task } = await newPlannedTask();
  const plan = task.plans[0]!;
  const res = await call(`/tasks/${id}/plans/${plan.id}`, {
    method: "PATCH",
    body: JSON.stringify({ editedContent: "an edited plan" }),
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as Task).plans[0]!.editedContent).toBe("an edited plan");

  await settle();
  db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});
