// The cross-task inbox builder (docs/specs/remote-readiness-spec.md "One needs-you query"): cards across tasks with a step's
// card folded into its parent, gates waiting for a human, and the per-task builder the old route inlined.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PipelineRunState, Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-pending-inbox-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;
let interactions: typeof import("./interactions.ts");
let inbox: typeof import("./pending-inbox.ts");

beforeAll(async () => {
  ({ db, tasks } = await import("./db.ts"));
  interactions = await import("./interactions.ts");
  inbox = await import("./pending-inbox.ts");
});
afterAll(() => rmTestDataDir(DATA_DIR));
afterEach(() => {
  for (const t of tasks.list()) interactions.cancelPendingForTask(t.id, "test done");
  db.run(`DELETE FROM run_events`);
  db.run(`DELETE FROM runs`);
  db.run(`DELETE FROM tasks`);
});

function row(id: string, extra: Partial<Task> = {}): Task {
  return {
    id, title: `task ${id.slice(0, 4)}`, prompt: "p", agent: "claude-code", workdir: "/tmp", isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null, mode: null, model: null, effort: null,
    speed: "off", maxMode: false, opencodeServer: "shared", references: [], backlog: [], plans: [], draft: null, column: "ready",
    runId: null, createdAt: Date.now(), updatedAt: Date.now(), hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    archivedAt: null, ...extra,
  };
}

function card(taskId: string, label: string) {
  const reg = interactions.registerTmuxPrompt({
    taskId, runId: "r", paneText: `Do you want to ${label}?`, fingerprint: `fp-${label}-${taskId}`,
    choices: [{ key: "1", label: "Yes" }, { key: "2", label: "No" }],
  });
  void reg.answer.catch(() => undefined);
  return reg.req;
}

describe("pending inbox", () => {
  test("an empty core has an empty inbox", async () => {
    expect(await inbox.buildPendingInbox()).toEqual({ cards: [], gates: [] });
  });

  test("cards across tasks come oldest first, each with its own parentTaskId", async () => {
    const a = randomUUID();
    const b = randomUUID();
    tasks.insert(row(a));
    tasks.insert(row(b));
    card(b, "first");
    await new Promise((r) => setTimeout(r, 3));
    card(a, "second");
    const got = await inbox.buildPendingInbox();
    expect(got.cards.map((c) => [c.taskId, c.parentTaskId])).toEqual([[b, b], [a, a]]);
  });

  test("a pipeline step's card is folded into its parent", async () => {
    const parent = randomUUID();
    const step = randomUUID();
    tasks.insert(row(parent, { pipelineId: "p1" } as Partial<Task>));
    tasks.insert(row(step, { pipelineParentId: parent } as Partial<Task>));
    card(step, "step");
    const got = await inbox.buildPendingInbox();
    expect(got.cards.map((c) => [c.taskId, c.parentTaskId])).toEqual([[step, parent]]);
  });

  test("the per-task builder still unions a pipeline parent's steps, and a plain task's own cards", async () => {
    const parent = randomUUID();
    const step = randomUUID();
    const plain = randomUUID();
    tasks.insert(row(parent, { pipelineId: "p1" } as Partial<Task>));
    tasks.insert(row(step, { pipelineParentId: parent } as Partial<Task>));
    tasks.insert(row(plain));
    card(step, "step");
    card(plain, "plain");
    expect((await inbox.pendingCardsForTask(parent)).map((c) => c.taskId)).toEqual([step]);
    expect((await inbox.pendingCardsForTask(plain)).map((c) => c.taskId)).toEqual([plain]);
    expect(await inbox.pendingCardsForTask("unknown")).toEqual([]);
  });

  test("gates waiting for a human are listed, oldest first, and an archived parent's are not", async () => {
    const live = randomUUID();
    const archived = randomUUID();
    tasks.insert(row(live, { pipelineId: "p1" } as Partial<Task>));
    tasks.insert(row(archived, { pipelineId: "p2", archivedAt: Date.now() }));
    const run = (stepId: string, seq: number, startedAt: number) =>
      ({
        pipelineId: "p1", pipelineName: "P", status: "review", active: [], history: [], blocked: [], startedAt: 1,
        humanSteps: [{ stepId, seq, startedAt, arrivals: [{ fromStepId: "s0", seq: 1, handoff: null }] }],
      }) as unknown as PipelineRunState;
    tasks.setPipelineRun(live, run("gate-1", 4, 200));
    tasks.setPipelineRun(archived, run("gate-2", 5, 100));
    const got = await inbox.pendingGatesAcrossTasks();
    expect(got.map((g) => [g.taskId, g.stepId, g.seq])).toEqual([[live, "gate-1", 4]]);
    expect(got[0]!.arrivals[0]!.fromStepId).toBe("s0");
  });
});
