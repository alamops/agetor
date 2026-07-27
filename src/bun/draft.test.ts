import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Top-level so db.ts captures our throwaway dir on first import (see the note
// in db.ts about the beforeAll race).
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-draft-"));

let createTask: typeof import("./orchestrator.ts").createTask;
let drafts: typeof import("./db.ts").drafts;
let tasks: typeof import("./db.ts").tasks;
let db: typeof import("./db.ts").db;

beforeAll(async () => {
  ({ createTask } = await import("./orchestrator.ts"));
  ({ drafts, tasks, db } = await import("./db.ts"));
});

async function newTask(): Promise<string> {
  const created = await createTask({
    title: "draft test",
    prompt: "noop",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none", // don't materialize a worktree off the live repo
  });
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}

test("pre-existing tasks read draft: null", async () => {
  const id = await newTask();
  try {
    expect(tasks.get(id)!.draft).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("drafts.set round-trips text + references", async () => {
  const id = await newTask();
  try {
    const t = drafts.set(id, {
      text: "hello there",
      references: [{ path: "/tmp/x", isDirectory: false }],
    })!;
    expect(t.draft).toEqual({
      text: "hello there",
      references: [{ path: "/tmp/x", isDirectory: false }],
    });

    // Survives a fresh read from the row.
    expect(tasks.get(id)!.draft).toEqual({
      text: "hello there",
      references: [{ path: "/tmp/x", isDirectory: false }],
    });
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("drafts.set null clears the draft", async () => {
  const id = await newTask();
  try {
    drafts.set(id, { text: "some draft", references: [] });
    const t = drafts.set(id, null)!;
    expect(t.draft).toBeNull();
    expect(tasks.get(id)!.draft).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("empty text + empty refs normalizes to null", async () => {
  const id = await newTask();
  try {
    const t = drafts.set(id, { text: "", references: [] })!;
    expect(t.draft).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("whitespace-only text + no refs normalizes to null", async () => {
  const id = await newTask();
  try {
    const t = drafts.set(id, { text: "   \n\t  ", references: [] })!;
    expect(t.draft).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("a references-only draft (empty text, valid refs) survives", async () => {
  const id = await newTask();
  try {
    const t = drafts.set(id, {
      text: "",
      references: [{ path: "/tmp/refs-only", isDirectory: true }],
    })!;
    expect(t.draft).toEqual({
      text: "",
      references: [{ path: "/tmp/refs-only", isDirectory: true }],
    });
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("drafts.set sanitizes junk references (bad shapes dropped)", async () => {
  const id = await newTask();
  try {
    const t = drafts.set(id, {
      text: "keep me",
      // biome-ignore lint: intentionally passing junk shapes to exercise sanitizeRefs
      references: [
        { path: "/tmp/good", isDirectory: false },
        { path: "", isDirectory: false }, // dropped — empty path
        { isDirectory: true }, // dropped — no path
        "not an object", // dropped
        null, // dropped
      ] as never,
    })!;
    expect(t.draft).toEqual({
      text: "keep me",
      references: [{ path: "/tmp/good", isDirectory: false }],
    });
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("a draft that becomes empty after sanitizing junk refs stores NULL, not a zombie row", async () => {
  const id = await newTask();
  try {
    const t = drafts.set(id, {
      text: "  ", // whitespace only — empty for the emptiness check
      // biome-ignore lint: intentionally passing junk shapes to exercise sanitizeRefs
      references: [
        { path: "", isDirectory: false },
        { isDirectory: true },
        "not an object",
      ] as never,
    })!;
    expect(t.draft).toBeNull();
    expect(tasks.get(id)!.draft).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("parseDraft tolerates malformed JSON in the raw column — reads back as null", async () => {
  const id = await newTask();
  try {
    db.run(`UPDATE tasks SET draft = ? WHERE id = ?`, ["{not valid json", id]);
    expect(tasks.get(id)!.draft).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("parseDraft tolerates a non-object JSON value in the raw column", async () => {
  const id = await newTask();
  try {
    db.run(`UPDATE tasks SET draft = ? WHERE id = ?`, [JSON.stringify("just a string"), id]);
    expect(tasks.get(id)!.draft).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("parseDraft coerces missing/malformed fields and drops junk refs from raw JSON", async () => {
  const id = await newTask();
  try {
    db.run(`UPDATE tasks SET draft = ? WHERE id = ?`, [
      JSON.stringify({
        text: 5, // non-string → ""... but no refs either, so this collapses to null unless refs survive
        references: [{ path: "/tmp/legacy", isDirectory: true }, { path: "" }, "junk"],
      }),
      id,
    ]);
    const draft = tasks.get(id)!.draft;
    expect(draft).toEqual({
      text: "",
      references: [{ path: "/tmp/legacy", isDirectory: true }],
    });
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [id]);
  }
});

test("drafts.set on an unknown task id returns null", () => {
  expect(drafts.set("does-not-exist", { text: "x", references: [] })).toBeNull();
});
