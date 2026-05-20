import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Task } from "../shared/types.ts";

// Top-level: db.ts captures AGETOR_DATA_DIR at first import.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-recon-"));
// Drive claude through the fake driver; we exercise reconcileTaskSession
// separately (it gates on `sessionExists` from claude-tmux, which goes
// through the real tmux binary). For the kill-on-agent-change check we
// don't need a live session — the function no-ops gracefully.
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_TMUX_BIN = "/bin/echo"; // probe passes

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "t",
    prompt: "p",
    column: "ready",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    branch: null,
    worktreePath: null,
    baseRef: null,
    mode: "auto",
    model: null,
    effort: null,
    references: [],
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

test("reconcileTaskSession resets mode/model/effort when the harness kind changes", async () => {
  const { reconcileTaskSession } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");

  // Seed an alias for codex so the cross-kind transition has a concrete
  // target. Built-in claude-code is already seeded by migration.
  harnesses.insert({ id: "codex-alias", kind: "codex", label: "Codex alias" });

  const before = baseTask({
    id: "cross-kind-task",
    agent: "claude-code",
    mode: "acceptEdits", // valid for claude, invalid for codex
    model: "opus-4.7",
    effort: "max",
  });
  // Persist the row so reconcileTaskSession's tasks.update has something
  // to mutate.
  tasks.insert(before);

  const after: Task = { ...before, agent: "codex-alias" };
  await reconcileTaskSession(before.id, before, after);

  const updated = tasks.get(before.id)!;
  // Reset mode → codex's first option (auto), and model/effort cleared.
  expect(updated.mode).toBe("auto");
  expect(updated.model).toBeNull();
  expect(updated.effort).toBeNull();
});

test("reconcileTaskSession preserves mode/model/effort on same-kind alias swap", async () => {
  const { reconcileTaskSession } = await import("./orchestrator.ts");
  const { tasks, harnesses } = await import("./db.ts");

  harnesses.insert({ id: "claude-alt", kind: "claude-code", label: "Claude alt" });

  const before = baseTask({
    id: "same-kind-task",
    agent: "claude-code",
    mode: "acceptEdits",
    model: "opus-4.7",
    effort: "max",
  });
  tasks.insert(before);

  const after: Task = { ...before, agent: "claude-alt" };
  await reconcileTaskSession(before.id, before, after);

  const updated = tasks.get(before.id)!;
  // Same kind → ids stay valid → keep the picks.
  expect(updated.mode).toBe("acceptEdits");
  expect(updated.model).toBe("opus-4.7");
  expect(updated.effort).toBe("max");
});

test("reconcileTaskSession is a no-op when there's no live tmux session", async () => {
  const { reconcileTaskSession } = await import("./orchestrator.ts");
  // Different mode/model/effort, but no session exists — function should
  // simply return without throwing.
  const before = baseTask({ mode: "auto", model: null, effort: null });
  const after = baseTask({ mode: "plan", model: "opus-4.7", effort: "high" });
  await expect(reconcileTaskSession("nonexistent-task", before, after)).resolves.toBeUndefined();
});

test("reconcileTaskSession drops the claude session when the agent flips", async () => {
  const { reconcileTaskSession } = await import("./orchestrator.ts");
  // Same no-session scenario — we just want to confirm the agent-change branch
  // exits cleanly (dropSession is best-effort and no-ops without a session).
  const before = baseTask({ agent: "claude-code" });
  const after = baseTask({ agent: "codex" });
  await expect(reconcileTaskSession("t1", before, after)).resolves.toBeUndefined();
});

test("reconcileTaskSession ignores codex tasks (no live tmux for codex)", async () => {
  const { reconcileTaskSession } = await import("./orchestrator.ts");
  const before = baseTask({ agent: "codex", mode: "auto" });
  const after = baseTask({ agent: "codex", mode: "ask" });
  await expect(reconcileTaskSession("t1", before, after)).resolves.toBeUndefined();
});
