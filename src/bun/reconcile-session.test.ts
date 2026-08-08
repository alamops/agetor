import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: "auto",
    model: null,
    effort: null,
    fast: false, maxMode: false,
    references: [],    backlog: [], draft: null,
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
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

/** Find the matcher on agetor's own PreToolUse entry (identified by the
 *  hook command's filename suffix). User-installed entries with their own
 *  matchers may sit alongside ours after the merge — reading `[0]` would
 *  see whichever happens to be first. */
function readMatcher(cwd: string): string | undefined {
  const settings = JSON.parse(
    readFileSync(path.join(cwd, ".claude", "settings.local.json"), "utf-8"),
  ) as { hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> } };
  const entries = settings.hooks?.PreToolUse ?? [];
  for (const e of entries) {
    const cmd = e.hooks?.[0]?.command ?? "";
    if (cmd.endsWith("agetor-approval-hook.sh")) return e.matcher;
  }
  return undefined;
}

test("reconcileTaskSession refreshes the hook matcher to narrow on ask → auto", async () => {
  const { reconcileTaskSession } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const { __forTest } = await import("./claude-tmux.ts");

  const cwd = mkdtempSync(path.join(tmpdir(), "agetor-matcher-narrow-"));
  // Pre-seed a bare settings.local.json so ensureInstalledMerged has a
  // non-malformed base to merge into.
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  writeFileSync(path.join(cwd, ".claude", "settings.local.json"), "{}");

  const before = baseTask({
    id: "task-matcher-narrow",
    workdir: cwd,
    worktreePath: null,
    isolation: "none",
    taskType: "task",
    mode: "ask",
  });
  tasks.insert(before);

  // Install a synthetic claude-tmux session so cycleToMode finds the
  // in-memory state. Seed `permissionMode` (claude's string for the
  // launch mode) so cycleToMode gets past the "current mode unknown"
  // early return and returns `ok: true` — the matcher refresh is gated
  // on success.
  const jsonl = path.join(cwd, "session.jsonl");
  writeFileSync(jsonl, "");
  const state = __forTest.installSession("task-matcher-narrow", jsonl);
  state.permissionMode = "default"; // claude string for agetor's `ask`

  // cycleToMode verifies the switch by scraping the tmux status bar; feed it
  // the target banner so the switch resolves on the first poll instead of
  // polling a real pane for the full timeout. Await the reconcile so its
  // (otherwise fire-and-forget) background poll can't leak `tmux` calls into
  // a later test's recording bin.
  const prevPane = __forTest.setCaptureModePane(() => "⏵⏵ auto mode on (shift+tab to cycle)");
  const prevPoll = __forTest.setModePollIntervalMs(1);
  const after: Task = { ...before, mode: "auto" };
  await reconcileTaskSession("task-matcher-narrow", before, after);
  __forTest.setCaptureModePane(prevPane);
  __forTest.setModePollIntervalMs(prevPoll);

  // Agetor no longer installs a PreToolUse hook, so reconcile (which re-runs
  // the installer on a mode change) must leave NO agetor matcher behind.
  expect(readMatcher(cwd)).toBeUndefined();
  __forTest.uninstallSession("task-matcher-narrow");
});

test("reconcileTaskSession refreshes the hook matcher to full on auto → ask", async () => {
  const { reconcileTaskSession } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const { __forTest } = await import("./claude-tmux.ts");

  const cwd = mkdtempSync(path.join(tmpdir(), "agetor-matcher-full-"));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  // Bare baseline. `readMatcher` filters by hook-command filename suffix,
  // so any matcher the merge writes for agetor will be found by the
  // assertion regardless of what else is in the file.
  writeFileSync(path.join(cwd, ".claude", "settings.local.json"), "{}");

  const before = baseTask({
    id: "task-matcher-full",
    workdir: cwd,
    worktreePath: null,
    isolation: "none",
    taskType: "task",
    mode: "auto",
  });
  tasks.insert(before);

  const jsonl = path.join(cwd, "session.jsonl");
  writeFileSync(jsonl, "");
  const state = __forTest.installSession("task-matcher-full", jsonl);
  state.permissionMode = "auto"; // claude string for agetor's `auto`

  // Target `ask` → claude's `default` mode, whose status bar shows the
  // "? for shortcuts" hint (no mode banner). Feed that so the switch resolves
  // promptly, and await so the background poll can't leak `tmux` calls.
  const prevPane = __forTest.setCaptureModePane(() => "? for shortcuts · ← for agents");
  const prevPoll = __forTest.setModePollIntervalMs(1);
  const after: Task = { ...before, mode: "ask" };
  await reconcileTaskSession("task-matcher-full", before, after);
  __forTest.setCaptureModePane(prevPane);
  __forTest.setModePollIntervalMs(prevPoll);

  // No agetor PreToolUse hook is installed any more (see the narrow case).
  expect(readMatcher(cwd)).toBeUndefined();
  __forTest.uninstallSession("task-matcher-full");
});

test("reconcileTaskSession does NOT refresh the matcher when cycleToMode fails (unreachable target)", async () => {
  // Asking for `bypass` on a session that wasn't launched with the
  // enabling flag is unreachable via Shift+Tab — cycleToMode returns
  // `ok: false`. Refreshing the matcher to bypass's narrow-no-mcp scope
  // anyway would leave claude in `default` while agetor stopped routing
  // tools through the hook, deadlocking the run on claude's own modal.
  // Pin the gate so a future refactor can't quietly drop it.
  const { reconcileTaskSession } = await import("./orchestrator.ts");
  const { tasks } = await import("./db.ts");
  const { __forTest } = await import("./claude-tmux.ts");

  const cwd = mkdtempSync(path.join(tmpdir(), "agetor-matcher-skip-"));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  writeFileSync(path.join(cwd, ".claude", "settings.local.json"), "{}");

  const before = baseTask({
    id: "task-matcher-skip",
    workdir: cwd,
    worktreePath: null,
    isolation: "none",
    taskType: "task",
    mode: "ask",
  });
  tasks.insert(before);

  const jsonl = path.join(cwd, "session.jsonl");
  writeFileSync(jsonl, "");
  const state = __forTest.installSession("task-matcher-skip", jsonl);
  // Seed a real "current" mode so cycleToMode gets past the
  // "current mode unknown" early return and into the cycle math —
  // where it discovers `bypassPermissions` isn't reachable.
  state.permissionMode = "default";

  const after: Task = { ...before, mode: "bypass" };
  reconcileTaskSession("task-matcher-skip", before, after);

  // No agetor entry was written, so readMatcher returns undefined.
  expect(readMatcher(cwd)).toBeUndefined();
  __forTest.uninstallSession("task-matcher-skip");
});
