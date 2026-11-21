// The backlog op and the batched run-event append added for the OpenCode driver
// and the session imports (db-core/ops/backlog-ops.ts, runs.appendEvents,
// runs.firstStatusDataWithPrefixes).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-backlog-ops-"));

const { op, runs: asyncRuns } = await import("./db-async.ts");
const dbm = await import("./db.ts");

const taskIds: string[] = [];
afterAll(() => {
  for (const id of taskIds) dbm.db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
});

function mkTask(): { taskId: string; runId: string } {
  const taskId = `task-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  taskIds.push(taskId);
  const now = Date.now();
  dbm.tasks.insert({
    id: taskId, title: "t", prompt: "p", agent: "claude-code", workdir: "/tmp", isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null, mode: null, model: null,
    effort: null, speed: "off", maxMode: false, opencodeServer: "shared", references: [], backlog: [], plans: [],
    draft: null, column: "ready", runId: null, createdAt: now, updatedAt: now, archivedAt: null,
  } as never);
  dbm.runs.insert({
    id: runId, taskId, agent: "claude-code", status: "running", startedAt: now, endedAt: null, exitCode: null,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  return { taskId, runId };
}

describe("backlog.stashTexts", () => {
  test("adds the texts newest-first, skips one already in the tray, and says whether the task exists", async () => {
    const { taskId } = mkTask();
    expect(await op("backlog.stashTexts", [taskId, ["first", "second"]])).toBe(true);
    // `first` is the newest-on-top item after `second`.
    expect(dbm.tasks.get(taskId)!.backlog.map((b) => b.text)).toEqual(["first", "second"]);
    // A duplicate is not added twice, a new text goes on top.
    expect(await op("backlog.stashTexts", [taskId, ["third", "second"]])).toBe(true);
    expect(dbm.tasks.get(taskId)!.backlog.map((b) => b.text)).toEqual(["third", "first", "second"]);
    // A task that is gone keeps nothing.
    expect(await op("backlog.stashTexts", [`task-gone-${randomUUID()}`, ["x"]])).toBe(false);
    expect(await op("backlog.stashTexts", [taskId, []])).toBe(false);
  });

  test("two concurrent stashes of the same text store it once", async () => {
    const { taskId } = mkTask();
    await Promise.all([op("backlog.stashTexts", [taskId, ["same"]]), op("backlog.stashTexts", [taskId, ["same"]])]);
    expect(dbm.tasks.get(taskId)!.backlog.map((b) => b.text)).toEqual(["same"]);
  });
});

describe("runs.appendEvents", () => {
  test("stores the items in order in one call, dedupes a repeated line uuid and reports each result", async () => {
    const { runId } = mkTask();
    const first = await asyncRuns.appendEvents(runId, [
      { stream: "status", data: "a" },
      { stream: "assistant", data: "b", lineUuid: "u-1" },
      { stream: "assistant", data: "b again", lineUuid: "u-1" },
      { stream: "assistant", data: "c", lineUuid: "u-2", subagentId: null, ts: 1_700_000_000_000 },
    ]);
    expect(first.map((r) => r !== null)).toEqual([true, true, false, true]);
    const ids = first.filter((r): r is { id: number; ts: number } => r !== null).map((r) => r.id);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    expect(first[3]!.ts).toBe(1_700_000_000_000);
    expect(dbm.runs.events(runId).map((e) => e.data)).toEqual(["a", "b", "c"]);
  });

  test("a failing item rolls the whole batch back", async () => {
    const { runId } = mkTask();
    await expect(
      asyncRuns.appendEvents(runId, [
        { stream: "status", data: "kept?" },
        { stream: "status", data: "boom", ts: Number.NaN as never, lineUuid: { not: "a string" } as never },
      ]),
    ).rejects.toThrow();
    expect(dbm.runs.events(runId)).toHaveLength(0);
  });
});

describe("runs.firstStatusDataWithPrefixes", () => {
  test("answers per run, the first prefix that matches, null when none does", async () => {
    const a = mkTask();
    const b = mkTask();
    const c = mkTask();
    dbm.runs.appendEvent(a.runId, "status", "opencode 2.x · server=agetor · model=m", "x1");
    dbm.runs.appendEvent(b.runId, "status", "opencode 1.x · server=n/a · model=m", "x2");
    const got = await asyncRuns.firstStatusDataWithPrefixes([a.runId, b.runId, c.runId], ["opencode 2.x · server=", "opencode 1.x · server="]);
    expect(got).toEqual(["opencode 2.x · server=agetor · model=m", "opencode 1.x · server=n/a · model=m", null]);
    expect(await asyncRuns.firstStatusDataWithPrefixes([], ["x"])).toEqual([]);
  });
});
