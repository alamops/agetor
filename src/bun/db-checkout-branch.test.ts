import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import (same convention
// as db-fx-recovery.test.ts and every sibling that imports db.ts).
const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-db-checkout-branch-"));
process.env.AGETOR_DATA_DIR = dataDir;

let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;

beforeAll(async () => {
  ({ db, tasks } = await import("./db.ts"));
});

afterAll(() => {
  rmTestDataDir(dataDir);
});

// Minimal hand-built fixture — `checkoutBranch` deliberately omitted (it's
// optional; db.ts populates it on read).
function makeTaskRow(overrides: Partial<Task> = {}): Task {
  return {
    id: randomUUID(),
    title: "t",
    prompt: "p",
    agent: "codex",
    workdir: "/tmp",
    isolation: "worktree",
    taskType: "task",
    branch: "agetor/abc-fix",
    branchSource: "created",
    worktreePath: "/tmp/wt",
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    speed: "off",
    maxMode: false,
    opencodeServer: "shared",
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    column: "ready",
    runId: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    ...overrides,
  };
}

function rawRow(id: string) {
  return db
    .query<{ checkout_branch: string | null; updated_at: number }, [string]>(
      `SELECT checkout_branch, updated_at FROM tasks WHERE id = ?`,
    )
    .get(id);
}

test("a task inserted without the field reads checkoutBranch null", () => {
  const t = tasks.insert(makeTaskRow());
  expect(t.checkoutBranch).toBeNull();
  expect(rawRow(t.id)?.checkout_branch).toBeNull();
});

test("insert persists a provided checkoutBranch", () => {
  const t = tasks.insert(makeTaskRow({ checkoutBranch: "implement/x" }));
  expect(tasks.get(t.id)?.checkoutBranch).toBe("implement/x");
});

test("setCheckoutBranch writes without bumping updated_at", () => {
  const t = tasks.insert(makeTaskRow());
  tasks.setCheckoutBranch(t.id, "implement/x");
  expect(rawRow(t.id)).toEqual({ checkout_branch: "implement/x", updated_at: 1_000 });
  expect(tasks.get(t.id)?.checkoutBranch).toBe("implement/x");
  // null (detached HEAD) is a real value, written the same way.
  tasks.setCheckoutBranch(t.id, null);
  expect(rawRow(t.id)).toEqual({ checkout_branch: null, updated_at: 1_000 });
});

test("an unchanged value is a no-op write (compare-then-write)", () => {
  const t = tasks.insert(makeTaskRow());
  tasks.setCheckoutBranch(t.id, "implement/x");
  const before = db.query<{ c: number }, []>(`SELECT total_changes() AS c`).get()!.c;
  tasks.setCheckoutBranch(t.id, "implement/x");
  const after = db.query<{ c: number }, []>(`SELECT total_changes() AS c`).get()!.c;
  expect(after).toBe(before);
});

test("a generic tasks.update leaves the column intact and cannot write it", () => {
  const t = tasks.insert(makeTaskRow());
  tasks.setCheckoutBranch(t.id, "implement/x");
  tasks.update(t.id, { title: "renamed", checkoutBranch: "something-else" } as Partial<Task>);
  const after = tasks.get(t.id)!;
  expect(after.title).toBe("renamed");
  expect(after.checkoutBranch).toBe("implement/x");
});

test("a pipeline step row's write mirrors onto its parent", () => {
  const parent = tasks.insert(makeTaskRow({ title: "parent" }));
  const step = tasks.insert(makeTaskRow({ title: "step", pipelineParentId: parent.id, pipelineStepId: "s1" }));
  tasks.setCheckoutBranch(step.id, "implement/x");
  expect(tasks.get(step.id)?.checkoutBranch).toBe("implement/x");
  expect(tasks.get(parent.id)?.checkoutBranch).toBe("implement/x");
  expect(rawRow(parent.id)?.updated_at).toBe(1_000);
  // A parent write does NOT fan out to steps (steps are copied explicitly).
  tasks.setCheckoutBranch(parent.id, "other");
  expect(tasks.get(step.id)?.checkoutBranch).toBe("implement/x");
});

test("an unknown task id is a silent no-op", () => {
  expect(() => tasks.setCheckoutBranch("no-such-task", "x")).not.toThrow();
});
