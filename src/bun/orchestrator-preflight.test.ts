import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-preflight-"));
process.env.AGETOR_CLAUDE_BIN = "definitely-not-a-real-binary-xyz123";

test("startTask returns a friendly error when the agent is not installed", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const created = await createTask({
    title: "x",
    prompt: "x",
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);

  const res = await startTask(created.task.id);
  expect("error" in res).toBe(true);
  if ("error" in res) {
    // The error uses the harness label ("Claude Code" for the built-in) now
    // that the orchestrator resolves the task's harness id before probing.
    expect(res.error).toContain("Claude Code is not available");
    expect(res.error).toContain("not found on PATH");
    expect(res.error).toContain("Install it with");
  }
});
