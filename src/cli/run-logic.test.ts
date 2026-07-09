import { test, expect } from "bun:test";
import { runControl, resumableRunId } from "./run-logic.ts";
import type { Task, Run } from "../shared/types.ts";

const task = (over: Partial<Task>): Task =>
  ({
    id: "task-1",
    column: "backlog",
    runId: null,
    archivedAt: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    ...over,
  }) as unknown as Task;

test("runControl mirrors the webview TaskCard precedence", () => {
  // active → Stop
  expect(runControl(task({ column: "running" }))).toBe("stop");
  expect(runControl(task({ column: "blocked" }))).toBe("stop");
  // finished (a succeeded/orphaned run exists) → Open (continue via send)
  expect(runControl(task({ column: "review", hasOpenableRun: true }))).toBe("open");
  expect(runControl(task({ column: "done", hasOpenableRun: true }))).toBe("open");
  // never-run, and failed/cancelled-only (no openable run) → Run
  expect(runControl(task({ column: "backlog", hasOpenableRun: false }))).toBe("run");
  expect(runControl(task({ column: "ready", hasOpenableRun: false }))).toBe("run");
});

test("resumableRunId prefers the live run, then the newest, then null", () => {
  const runs = [{ id: "r-new" }, { id: "r-old" }] as unknown as Run[]; // newest-first
  expect(resumableRunId(task({ runId: "r-live" }), runs)).toBe("r-live");
  expect(resumableRunId(task({ runId: null }), runs)).toBe("r-new");
  expect(resumableRunId(task({ runId: null }), [])).toBeNull();
});
