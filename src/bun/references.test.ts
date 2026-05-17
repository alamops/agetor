import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Top-level — db.ts freezes AGETOR_DATA_DIR at first import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-refs-test-"));

test("formatReferences returns empty string for empty list", async () => {
  const { formatReferences } = await import("../shared/refs.ts");
  expect(formatReferences([])).toBe("");
});

test("formatReferences renders bullets and trailing slashes for directories", async () => {
  const { formatReferences } = await import("../shared/refs.ts");
  const out = formatReferences([
    { path: "/abs/foo.ts", isDirectory: false },
    { path: "/abs/src", isDirectory: true },
    { path: "/abs/space file.md", isDirectory: false },
  ]);
  expect(out).toBe(
    "Referenced files/folders:\n"
    + "- /abs/foo.ts\n"
    + "- /abs/src/\n"
    + "- /abs/space file.md",
  );
});

test("appendReferences leaves prompt unchanged when refs empty", async () => {
  const { appendReferences } = await import("../shared/refs.ts");
  expect(appendReferences("hello", [])).toBe("hello");
});

test("appendReferences joins prompt + block with a blank line", async () => {
  const { appendReferences } = await import("../shared/refs.ts");
  const out = appendReferences("hello", [
    { path: "/a.ts", isDirectory: false },
  ]);
  expect(out).toBe("hello\n\nReferenced files/folders:\n- /a.ts");
});

test("appendReferences drops leading blank lines when text is empty", async () => {
  const { appendReferences } = await import("../shared/refs.ts");
  const out = appendReferences("", [
    { path: "/a.ts", isDirectory: false },
  ]);
  // Refs-only send shouldn't start with stray newlines.
  expect(out).toBe("Referenced files/folders:\n- /a.ts");
});

test("createTask persists references and they survive a get()", async () => {
  const { createTask } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const created = await createTask({
    title: "with refs",
    prompt: "do stuff",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
    references: [
      { path: "/abs/file.ts", isDirectory: false },
      { path: "/abs/src", isDirectory: true },
    ],
  });
  if ("error" in created) throw new Error(created.error);
  const fetched = tasks.get(created.task.id);
  expect(fetched?.references).toEqual([
    { path: "/abs/file.ts", isDirectory: false },
    { path: "/abs/src", isDirectory: true },
  ]);

  // Cleanup so this row doesn't leak into reconcile / list-based tests
  // that run later in the same `bun test` process.
  tasks.delete(created.task.id);
});
