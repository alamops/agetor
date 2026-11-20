// The named ops that own the harness-stack tables (db-core/ops/harness-stacks-ops.ts):
// membership writes, the stale-draft check, the delete that clears task state in
// the same transaction, and the account-wide / per-model cooldown rows.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-stacks-ops-"));

const { op } = await import("./db-async.ts");
const dbm = await import("./db.ts");

const stackIds: string[] = [];
const taskIds: string[] = [];

afterAll(() => {
  for (const id of stackIds) dbm.db.run(`DELETE FROM harness_stacks WHERE id = ?`, [id]);
  for (const id of taskIds) dbm.db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  dbm.db.run(`DELETE FROM harness_limit_state WHERE harness_id LIKE 'ops-%'`);
});

async function mkStack(members: string[]): Promise<string> {
  const id = `st-${randomUUID()}`;
  stackIds.push(id);
  await op("stacks.create", [id, "train", "claude-code", "full", 100, members]);
  return id;
}

function mkTask(stackId: string): string {
  const id = `task-${randomUUID()}`;
  taskIds.push(id);
  dbm.tasks.insert({
    id, title: "t", prompt: "p", agent: "claude-code", workdir: "/tmp", isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null, mode: null, model: null,
    effort: null, speed: "off", maxMode: false, opencodeServer: "shared", references: [], backlog: [], plans: [],
    draft: null, column: "ready", runId: null, createdAt: Date.now(), updatedAt: Date.now(), archivedAt: null,
  } as never);
  dbm.tasks.setHarnessState(id, { stackId, position: 0, tried: [], pendingSwap: null, allExhausted: null, lastMove: null });
  return id;
}

describe("stack membership ops", () => {
  test("create stores the ordered members; get, getByMember, memberships and snapshot read them back", async () => {
    const id = await mkStack(["ops-a", "ops-b", "ops-c"]);
    const got = await op("stacks.get", [id]);
    expect(got?.stack.label).toBe("train");
    expect(got?.members.map((m) => `${m.harness_id}@${m.position}`)).toEqual(["ops-a@0", "ops-b@1", "ops-c@2"]);
    expect((await op("stacks.getByMember", ["ops-b"]))?.stack.id).toBe(id);
    expect(await op("stacks.getByMember", ["ops-nobody"])).toBeNull();
    expect(await op("stacks.memberships", [["ops-a", "ops-nobody"]])).toEqual({ "ops-a": id });
    const snap = await op("stacks.snapshot", []);
    expect(snap.stacks.some((s) => s.id === id)).toBe(true);
    expect(snap.members.filter((m) => m.stack_id === id)).toHaveLength(3);
  });

  test("a create that throws midway rolls every row back (a member claimed by another stack)", async () => {
    const first = await mkStack(["ops-dup"]);
    const second = `st-${randomUUID()}`;
    stackIds.push(second);
    await expect(op("stacks.create", [second, "second", "claude-code", "full", 1, ["ops-free", "ops-dup"]])).rejects.toThrow();
    expect(await op("stacks.get", [second])).toBeNull();
    expect((await op("stacks.get", [first]))?.members).toHaveLength(1);
  });

  test("update replaces fields and the whole ordering, stamps strictly increasing, and reports missing / stale", async () => {
    const id = await mkStack(["ops-u1", "ops-u2"]);
    expect(await op("stacks.update", [id, "renamed", "claude-code", "safe", 50, ["ops-u2", "ops-u1"], null])).toBe("ok");
    const got = await op("stacks.get", [id]);
    expect(got?.stack.label).toBe("renamed");
    expect(got?.stack.mirror_mode).toBe("safe");
    expect(got?.members.map((m) => m.harness_id)).toEqual(["ops-u2", "ops-u1"]);
    // `now` (50) is older than the stored stamp (100): the stamp still moves forward.
    expect(got?.stack.updated_at).toBe(101);
    expect(await op("stacks.update", [id, "x", "claude-code", "full", 500, ["ops-u1"], 100])).toBe("changed");
    expect((await op("stacks.get", [id]))?.stack.label).toBe("renamed");
    expect(await op("stacks.update", [id, "x", "claude-code", "full", 500, ["ops-u1"], 101])).toBe("ok");
    expect(await op("stacks.update", ["st-missing", "x", "claude-code", "full", 1, [], null])).toBe("missing");
  });

  test("delete removes the stack and clears the failover state of the tasks naming it, together", async () => {
    const id = await mkStack(["ops-d1"]);
    const other = await mkStack(["ops-d2"]);
    const named = mkTask(id);
    const elsewhere = mkTask(other);
    await op("stacks.delete", [id]);
    expect(await op("stacks.get", [id])).toBeNull();
    expect(dbm.tasks.get(named)?.harnessState).toBeNull();
    expect(dbm.tasks.get(elsewhere)?.harnessState?.stackId).toBe(other);
    expect(await op("stacks.clearTaskState", [other])).toBe(1);
    expect(dbm.tasks.get(elsewhere)?.harnessState).toBeNull();
  });
});

describe("limit-state ops", () => {
  const set = (harness: string, model: string, reset: number | null, now: number, reason = "quota") =>
    op("limit.set", [harness, model, reason, "claude-api-error", null, reset, 600_000, now]);

  test("set stores a provider reset as is, and a fallback never shortens a later active reset", async () => {
    expect(await set("ops-l1", "", 9_000, 1_000)).toBe(9_000);
    // No reset time in the signal: the fallback (now + 600000) would be later here, so it applies.
    expect(await set("ops-l1", "", null, 1_000, "rate_limit")).toBe(601_000);
    // A fallback that would end sooner than an active provider reset leaves that reset in place.
    expect(await set("ops-l2", "", 5_000_000, 1_000)).toBe(5_000_000);
    expect(await set("ops-l2", "", null, 2_000)).toBe(5_000_000);
  });

  test("set sweeps expired rows first, and rowsFor reads the account row plus one model's row", async () => {
    await set("ops-l3", "", 100, 50);
    await set("ops-l3", "m1", 10_000, 50);
    await set("ops-l4", "", 10_000, 5_000); // sweeps ops-l3's expired account row (100 <= 5000)
    const rows = await op("limit.rowsFor", ["ops-l3", "m1"]);
    expect(rows.map((r) => r.model)).toEqual(["m1"]);
    expect((await op("limit.rowsFor", ["ops-l3", ""])).length).toBe(0);
  });

  test("clear removes exactly its scope and prune drops expired rows", async () => {
    await set("ops-l5", "", 90_000, 10);
    await set("ops-l5", "m", 90_000, 20);
    await op("limit.clear", ["ops-l5", "model", "m", 0]);
    expect((await op("limit.rowsFor", ["ops-l5", "m"])).map((r) => r.model)).toEqual([""]);
    await set("ops-l5", "m", 90_000, 30);
    // Rows written at or before 25 go; the later "m" row (30) stays.
    await op("limit.clear", ["ops-l5", "startedAt", "m", 25]);
    expect((await op("limit.rowsFor", ["ops-l5", "m"])).map((r) => r.model)).toEqual(["m"]);
    await op("limit.clear", ["ops-l5", "accountWide", "", 0]);
    await op("limit.clear", ["ops-l5", "all", "", 0]);
    expect((await op("limit.list", [])).filter((r) => r.harness_id === "ops-l5")).toEqual([]);
    await set("ops-l6", "", 10, 5);
    await op("limit.prune", [1_000]);
    expect((await op("limit.list", [])).filter((r) => r.harness_id === "ops-l6")).toEqual([]);
  });
});
