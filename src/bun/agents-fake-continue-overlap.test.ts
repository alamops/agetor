import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

// db.ts opens its sqlite connection at module-load time, so AGETOR_DATA_DIR
// and the fake-driver env must be set before any dynamic import touches
// db.ts/orchestrator.ts (same bootstrap as pipeline-runner.test.ts).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-fake-continue-overlap-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

beforeAll(async () => {
  // Importing the orchestrator installs the continuation-run factory the
  // fake driver's `openContinuationRun` relies on.
  await import("./orchestrator.ts");
});

afterAll(async () => {
  const { tasks } = await import("./db.ts");
  const { deleteTask } = await import("./orchestrator.ts");
  for (const t of tasks.list()) await deleteTask(t.id).catch(() => {});
  await new Promise((r) => setTimeout(r, 150));
  rmTestDataDir(DATA_DIR);
});

async function waitFor<T>(fn: () => T | null | undefined, timeoutMs = 6000, intervalMs = 15): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test("continue-overlap: A has no handoff, B (handoff) is displaced by C (no handoff), B ends first, task.runId is C", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { tasks, runs } = await import("./db.ts");
  const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER, FAKE_OVERLAP_B_MS, FAKE_OVERLAP_C_MS } = await import("./agents.ts");

  expect(FAKE_OVERLAP_B_MS).toBeLessThan(FAKE_OVERLAP_C_MS);

  const created = await createTask({
    title: "continue-overlap",
    prompt: `do the thing ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:continue-overlap`,
    workdir: mkdtempSync(path.join(tmpdir(), "agetor-fake-continue-overlap-wd-")),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  const started = await startTask(taskId);
  if ("error" in started) throw new Error(started.error);

  // Three runs, all settled.
  const all = await waitFor(() => {
    const rs = runs.listForTask(taskId);
    return rs.length === 3 && rs.every((r) => r.status !== "running") ? rs : undefined;
  });
  const ordered = [...all].sort((a, b) => a.startedAt - b.startedAt);
  const [A, B, C] = ordered as [typeof ordered[number], typeof ordered[number], typeof ordered[number]];

  // A: the original run, succeeded, no handoff.
  expect(A.origin).not.toBe("continuation");
  expect(A.status).toBe("succeeded");
  const handoffText = (id: string) =>
    runs.events(id).filter((e) => e.stream === "assistant").map((e) => e.data).join("\n");
  expect(handoffText(A.id)).toContain("forgot the handoff");
  expect(handoffText(A.id)).not.toContain("<handoff>");

  // B: notification-continuation carrying the terminal handoff.
  expect(B.origin).toBe("continuation");
  expect(handoffText(B.id)).toContain("<handoff>");
  expect(handoffText(B.id)).toContain('"next":null');
  expect(
    runs.events(B.id).some((e) => e.stream === "status" && e.data.includes("auto-continued after background task")),
  ).toBe(true);

  // C: user-continuation, started while B was still running, no handoff.
  expect(C.origin).toBe("continuation");
  expect(handoffText(C.id)).toContain("Picking this back up.");
  expect(handoffText(C.id)).not.toContain("<handoff>");
  expect(
    runs.events(C.id).some((e) => e.stream === "status" && e.data.includes("turn started from the terminal")),
  ).toBe(true);
  expect(C.startedAt).toBeGreaterThanOrEqual(B.startedAt);
  expect(C.startedAt).toBeLessThan(B.endedAt as number);

  // B ends before C; C is the task's current run at the end.
  expect(B.endedAt as number).toBeLessThan(C.endedAt as number);
  expect(tasks.get(taskId)?.runId).toBe(C.id);
});
