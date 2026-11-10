import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-swap-history-"));

const { db } = await import("./db.ts");
const { harnessSwapEvents } = await import("./harness-swap-history.ts");
const { mirrorProvenance } = await import("./harness-mirror-provenance.ts");

const stackId = `st-${randomUUID()}`;
db.run(`INSERT INTO harness_stacks (id, label, kind, created_at, updated_at) VALUES (?, 'S', 'claude-code', 1, 1)`, [stackId]);
afterAll(() => {
  db.run(`DELETE FROM harness_stacks WHERE id = ?`, [stackId]);
  db.run(`DELETE FROM harness_mirror_provenance WHERE harness_id LIKE 'prov-%'`);
});

const base = {
  stackId, taskId: null, taskTitle: "t", fromHarnessId: "a", fromLabel: "A", toHarnessId: "b", toLabel: "B",
  trigger: "limit" as const, reason: "quota" as const, source: "claude-pane" as const, message: null, model: null,
  resetsAtMs: null, fromRunId: null, toRunId: null, continuation: null,
};

describe("harnessSwapEvents", () => {
  test("pages newest first with a stable cursor across equal timestamps; bad cursor = first page", () => {
    for (let i = 0; i < 5; i++) harnessSwapEvents.insert({ ...base, at: 1000 + (i < 3 ? 0 : i) });
    expect(harnessSwapEvents.countForStack(stackId)).toBe(5);
    const p1 = harnessSwapEvents.page(stackId, { limit: 2 });
    expect(p1.events.map((e) => e.at)).toEqual([1004, 1003]);
    const p2 = harnessSwapEvents.page(stackId, { limit: 2, before: p1.nextCursor });
    const p3 = harnessSwapEvents.page(stackId, { limit: 2, before: p2.nextCursor });
    const all = [...p1.events, ...p2.events, ...p3.events];
    expect(new Set(all.map((e) => e.id)).size).toBe(5);
    expect(p3.nextCursor).toBeNull();
    expect(harnessSwapEvents.page(stackId, { limit: 2, before: "%%garbage" }).events).toEqual(p1.events);
    expect(harnessSwapEvents.page(stackId, { limit: 9999 }).events).toHaveLength(5);
  });

  test("the page query searches the index", () => {
    for (const sql of [
      `SELECT * FROM harness_swap_events WHERE stack_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
      `SELECT * FROM harness_swap_events WHERE stack_id = ? AND (at, id) < (?, ?) ORDER BY at DESC, id DESC LIMIT ?`,
    ]) {
      const stmt = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
      try {
        const args = sql.includes("(at, id) <") ? [stackId, 1, "x", 5] : [stackId, 5];
        const plan = (stmt.all(...(args as never[])) as { detail: string }[]).map((r) => r.detail).join("\n");
        expect(plan).toContain("SEARCH");
        expect(plan).not.toContain("SCAN");
        if (sql.includes("(at, id) <")) expect(plan).toMatch(/stack_id=\? AND \(at,id\)<\(\?,\?\)/);
        expect(plan).not.toContain("TEMP B-TREE");
      } finally {
        stmt.finalize();
      }
    }
  });
});

describe("validation", () => {
  test("insert refuses unknown values; reads drop unknown triggers and null unknown fields", () => {
    expect(() => harnessSwapEvents.insert({ ...base, trigger: "bogus" as never })).toThrow();
    expect(() => harnessSwapEvents.insert({ ...base, reason: "x" as never })).toThrow();
    expect(() => harnessSwapEvents.insert({ ...base, source: "x" as never })).toThrow();
    expect(() => harnessSwapEvents.insert({ ...base, continuation: "x" as never })).toThrow();
    const sid = `st-${randomUUID()}`;
    db.run(`INSERT INTO harness_stacks (id, label, kind, created_at, updated_at) VALUES (?, 'V', 'claude-code', 1, 1)`, [sid]);
    db.run(`INSERT INTO harness_swap_events (id, stack_id, trigger, at) VALUES ('bad', ?, 'evil', 9)`, [sid]);
    db.run(`INSERT INTO harness_swap_events (id, stack_id, trigger, reason, source, at) VALUES ('odd', ?, 'limit', 'r', 's', 8)`, [sid]);
    const page = harnessSwapEvents.page(sid);
    expect(page.events.map((e) => e.id)).toEqual(["odd"]);
    expect(page.events[0]).toMatchObject({ reason: null, source: null, continuation: null, trigger: "limit" });
    db.run(`DELETE FROM harness_stacks WHERE id = ?`, [sid]);
  });
});

describe("mirrorProvenance", () => {
  test("upsert/get/list/remove round-trip", () => {
    const row = {
      harnessId: "prov-1", stackId: null, scope: "key" as const, path: "/a/settings.json", key: "env.X",
      valueHash: "h", srcMtimeMs: 5, srcSize: 6, preexisted: true, backupRef: null, updatedAt: 1,
    };
    mirrorProvenance.upsert(row);
    mirrorProvenance.upsert({ ...row, key: "", scope: "file", preexisted: false });
    mirrorProvenance.upsert({ ...row, valueHash: "h2" });
    expect(mirrorProvenance.get("prov-1", "/a/settings.json", "env.X")?.valueHash).toBe("h2");
    expect(mirrorProvenance.get("prov-1", "/a/settings.json")?.preexisted).toBe(false);
    expect(mirrorProvenance.list("prov-1")).toHaveLength(2);
    expect(mirrorProvenance.listForPath("prov-1", "/a/settings.json")).toHaveLength(2);
    mirrorProvenance.remove("prov-1", "/a/settings.json", "env.X");
    expect(mirrorProvenance.list("prov-1")).toHaveLength(1);
    mirrorProvenance.removeForPath("prov-1", "/a/settings.json");
    expect(mirrorProvenance.list("prov-1")).toEqual([]);
    mirrorProvenance.upsert(row);
    mirrorProvenance.deleteForHarness("prov-1");
    expect(mirrorProvenance.list("prov-1")).toEqual([]);
  });
});
