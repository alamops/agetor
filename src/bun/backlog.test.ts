import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Top-level so db.ts captures our throwaway dir on first import (see the note
// in db.ts about the beforeAll race).
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-backlog-"));

let createTask: typeof import("./orchestrator.ts").createTask;
let backlog: typeof import("./db.ts").backlog;
let tasks: typeof import("./db.ts").tasks;
let db: typeof import("./db.ts").db;

beforeAll(async () => {
  ({ createTask } = await import("./orchestrator.ts"));
  ({ backlog, tasks, db } = await import("./db.ts"));
});

async function newTask(): Promise<string> {
  const created = await createTask({
    title: "backlog test",
    prompt: "noop",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none", // don't materialize a worktree off the live repo
  });
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}

test("add prepends newest-first, mints ids, and persists", async () => {
  const id = await newTask();
  try {
    let t = backlog.add(id, { text: "first" })!;
    expect(t.backlog).toHaveLength(1);
    expect(t.backlog[0]!.text).toBe("first");
    expect(t.backlog[0]!.id).toBeTruthy();
    expect(t.backlog[0]!.createdAt).toBeGreaterThan(0);

    t = backlog.add(id, {
      text: "second",
      references: [{ path: "/tmp/x", isDirectory: false }],
    })!;
    expect(t.backlog.map((m) => m.text)).toEqual(["second", "first"]);
    expect(t.backlog[0]!.references).toEqual([{ path: "/tmp/x", isDirectory: false }]);

    // Survives a fresh read from the row.
    expect(tasks.get(id)!.backlog.map((m) => m.text)).toEqual(["second", "first"]);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("updateItem edits text/refs; unknown id is a no-op", async () => {
  const id = await newTask();
  try {
    const itemId = backlog.add(id, { text: "draft" })!.backlog[0]!.id;
    const t1 = backlog.updateItem(id, itemId, { text: "edited" })!;
    expect(t1.backlog[0]!.text).toBe("edited");
    // refs left untouched when the patch omits them
    expect(t1.backlog[0]!.references).toEqual([]);

    const t2 = backlog.updateItem(id, "nope", { text: "ghost" })!;
    expect(t2.backlog[0]!.text).toBe("edited"); // unchanged
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("remove drops the item", async () => {
  const id = await newTask();
  try {
    const itemId = backlog.add(id, { text: "gone" })!.backlog[0]!.id;
    expect(backlog.remove(id, itemId)!.backlog).toHaveLength(0);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("reorder honors order and appends items missing from a stale/partial order", async () => {
  const id = await newTask();
  try {
    backlog.add(id, { text: "a" });
    backlog.add(id, { text: "b" });
    const t = backlog.add(id, { text: "c" })!; // order: c, b, a
    const [c, b, a] = t.backlog.map((m) => m.id);

    const r1 = backlog.reorder(id, [a!, b!, c!])!;
    expect(r1.backlog.map((m) => m.text)).toEqual(["a", "b", "c"]);

    // A partial order (only `c`) must not drop anything — the rest keep their
    // existing relative order and are appended.
    const r2 = backlog.reorder(id, [c!])!;
    expect(r2.backlog.map((m) => m.text)).toEqual(["c", "a", "b"]);

    // Unknown ids are ignored (no crash, no drop).
    const r3 = backlog.reorder(id, ["ghost", b!])!;
    expect(r3.backlog.map((m) => m.text)).toEqual(["b", "c", "a"]);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("parseBacklog sanitizes malformed rows (drops id-less/non-object entries, coerces fields)", async () => {
  const id = await newTask();
  try {
    // Write junk directly, bypassing the module, to exercise the parser.
    db.run(`UPDATE tasks SET backlog = ? WHERE id = ?`, [
      JSON.stringify([
        { id: "keep", text: "ok", references: [{ path: "/p", isDirectory: true }], createdAt: 1 },
        { text: "no id" }, // dropped — no id
        "not an object", // dropped
        { id: "", text: "empty id" }, // dropped — empty id
        { id: "coerce", text: 5, references: "bad", createdAt: "x" }, // kept, coerced
      ]),
      id,
    ]);
    const t = tasks.get(id)!;
    expect(t.backlog.map((m) => m.id)).toEqual(["keep", "coerce"]);
    expect(t.backlog[0]!.references).toEqual([{ path: "/p", isDirectory: true }]);
    expect(t.backlog[1]!.text).toBe(""); // non-string text → ""
    expect(t.backlog[1]!.references).toEqual([]); // non-array refs → []
    expect(t.backlog[1]!.createdAt).toBe(0); // non-number createdAt → 0
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});
