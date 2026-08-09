import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Set AGETOR_DATA_DIR before any import that pulls in db.ts. ES imports
// hoist before top-level code, so we use dynamic `await import()` below
// instead of a top-level `import { db } from "./db.ts"`.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-saved-prompts-"));
const { db, savedPrompts } = await import("./db.ts");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => {
  db.run(`DELETE FROM saved_prompts`);
});

test("insert returns the full object with a UUID id and equal created/updated timestamps", () => {
  const created = savedPrompts.insert({ name: "Greeting", content: "Say hello" });
  expect(created.id).toMatch(UUID_RE);
  expect(created.name).toBe("Greeting");
  expect(created.content).toBe("Say hello");
  expect(created.createdAt).toBe(created.updatedAt);
  expect(typeof created.createdAt).toBe("number");
});

test("list orders by created_at ASC, id ASC and is stable across calls", async () => {
  const first = savedPrompts.insert({ name: "First", content: "one" });
  await new Promise((r) => setTimeout(r, 5));
  const second = savedPrompts.insert({ name: "Second", content: "two" });
  await new Promise((r) => setTimeout(r, 5));
  const third = savedPrompts.insert({ name: "Third", content: "three" });

  // Distinct millisecond timestamps (guaranteed by the sleeps above) fully
  // order the rows, so list() must return them in insertion order.
  const expectedOrder = [first.id, second.id, third.id];
  expect(savedPrompts.list().map((p) => p.id)).toEqual(expectedOrder);
  // Calling again returns the same order — deterministic, not incidental.
  expect(savedPrompts.list().map((p) => p.id)).toEqual(expectedOrder);
});

test("get on a missing id returns null", () => {
  expect(savedPrompts.get("does-not-exist")).toBeNull();
});

test("update patches only the provided fields and bumps updated_at", async () => {
  const created = savedPrompts.insert({ name: "Original", content: "orig content" });
  await new Promise((r) => setTimeout(r, 5));

  const nameOnly = savedPrompts.update(created.id, { name: "Renamed" });
  expect(nameOnly).not.toBeNull();
  expect(nameOnly!.name).toBe("Renamed");
  expect(nameOnly!.content).toBe("orig content"); // untouched
  expect(nameOnly!.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
  expect(nameOnly!.createdAt).toBe(created.createdAt); // created_at never changes

  await new Promise((r) => setTimeout(r, 5));

  const contentOnly = savedPrompts.update(created.id, { content: "new content" });
  expect(contentOnly).not.toBeNull();
  expect(contentOnly!.name).toBe("Renamed"); // untouched from previous patch
  expect(contentOnly!.content).toBe("new content");
  expect(contentOnly!.updatedAt).toBeGreaterThanOrEqual(nameOnly!.updatedAt);
});

test("update on a missing id returns null", () => {
  expect(savedPrompts.update("does-not-exist", { name: "x" })).toBeNull();
});

test("delete removes the row; delete on a missing id returns false", () => {
  const created = savedPrompts.insert({ name: "Temp", content: "temp content" });
  expect(savedPrompts.delete(created.id)).toBe(true);
  expect(savedPrompts.get(created.id)).toBeNull();
  expect(savedPrompts.delete(created.id)).toBe(false);
  expect(savedPrompts.delete("never-existed")).toBe(false);
});
