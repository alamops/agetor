import { test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Set AGETOR_DATA_DIR before any import that pulls in db.ts (terminals.ts
// imports `tasks` from db.ts, which opens + migrates the database on load).
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-terminals-"));

const { tasks } = await import("./db.ts");
const {
  createTerminal,
  listTerminals,
  countTerminals,
  writeTerminal,
  closeTerminal,
  killTerminalsForTask,
  attachSocket,
} = await import("./terminals.ts");

import type { Task } from "../shared/types.ts";
import type { ServerWebSocket } from "bun";
import type { TerminalSocketData } from "./terminals.ts";

/** The manager spawns `$SHELL -l`. Under test, pin that to `/bin/sh`: the
 *  assertions below are about the MANAGER (a PTY round-trip, exit-driven
 *  removal), not about the developer's own shell — a `zsh -l` that sources
 *  a heavyweight profile (nvm, brew shellenv, a banner) can take seconds to
 *  even reach its first prompt on a loaded machine, which is exactly the
 *  flake this file used to have. Restored after the file so nothing else
 *  in the shared `bun test` process sees the override. */
const SAVED_SHELL = process.env.SHELL;
beforeAll(() => { process.env.SHELL = "/bin/sh"; });
afterAll(() => {
  if (SAVED_SHELL === undefined) delete process.env.SHELL;
  else process.env.SHELL = SAVED_SHELL;
});

/** Deadline-based readiness wait — polls `pred` every `intervalMs` until it
 *  holds or `timeoutMs` elapses. A generous ceiling costs nothing when the
 *  condition lands quickly (the common case) and absorbs a slow login shell
 *  on a loaded box instead of failing at a fixed 2s the way the old
 *  `40 × 50ms` loops did. */
async function waitFor(pred: () => boolean, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await Bun.sleep(intervalMs);
  }
  return pred();
}

/** How long a spawned login shell gets to start, run a command, and (for the
 *  exit test) terminate — far above the expected sub-second path, so only a
 *  genuine manager bug trips it. */
const SHELL_READY_MS = 20_000;

let taskCounter = 0;
function makeTask(workdir: string, extra: Partial<Task> = {}): Task {
  const id = `term-task-${++taskCounter}`;
  return tasks.insert({
    id,
    title: "terminal host",
    prompt: "n/a",
    column: "backlog",
    agent: "codex",
    workdir,
    isolation: "none", // no git repo needed; cwd resolves to workdir
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    fast: false, maxMode: false,
    references: [],    backlog: [], plans: [], draft: null,
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...extra,
  });
}

async function git(args: string[], cwd: string) {
  await Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
}

async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-term-repo-"));
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), "hi\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  return repo;
}

/** Minimal fake of a Bun ServerWebSocket that records what the manager sends. */
function fakeSocket() {
  const binary: Uint8Array[] = [];
  const text: string[] = [];
  const ws = {
    readyState: 1,
    data: { terminalId: "" },
    sendBinary(d: Uint8Array) { binary.push(d); },
    send(s: string) { text.push(s); },
    close() { this.readyState = 3; },
  };
  return { ws: ws as unknown as ServerWebSocket<TerminalSocketData>, binary, text };
}

function decodeAll(chunks: Uint8Array[]): string {
  const dec = new TextDecoder();
  return chunks.map((c) => dec.decode(c)).join("");
}

afterEach(async () => {
  // Clean up any leftover shells so the test process can exit.
  for (let i = 1; i <= taskCounter; i++) await killTerminalsForTask(`term-task-${i}`);
});

test("createTerminal spawns a shell, streams output, and tracks count", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-term-cwd-"));
  const task = makeTask(dir);

  const created = await createTerminal(task.id);
  expect("error" in created).toBe(false);
  if ("error" in created) return;

  expect(countTerminals(task.id)).toBe(1);
  expect(listTerminals(task.id)).toHaveLength(1);
  // The computed Task field reflects the open terminal.
  expect(tasks.get(task.id)!.openTerminalCount).toBe(1);

  // Attach a socket and drive a command through the PTY.
  const sock = fakeSocket();
  expect(attachSocket(created.id, sock.ws)).toBe(true);
  writeTerminal(created.id, "echo TERMINAL_MARKER_42\r");

  // Wait for the echoed marker (real PTY round-trip).
  const seen = await waitFor(() => decodeAll(sock.binary).includes("TERMINAL_MARKER_42"), SHELL_READY_MS);
  expect(seen).toBe(true);

  // Closing the tab drops the count.
  expect(closeTerminal(created.id)).toBe(true);
  expect(countTerminals(task.id)).toBe(0);
  expect(tasks.get(task.id)!.openTerminalCount).toBe(0);
}, SHELL_READY_MS + 10_000);

test("createTerminal enforces the per-task limit", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-term-limit-"));
  const task = makeTask(dir);

  for (let i = 0; i < 8; i++) {
    const r = await createTerminal(task.id);
    expect("error" in r).toBe(false);
  }
  expect(countTerminals(task.id)).toBe(8);

  const overflow = await createTerminal(task.id);
  expect("error" in overflow).toBe(true);
  expect(countTerminals(task.id)).toBe(8);
});

test("archiving a task closes its terminals", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-term-archive-"));
  // archiveTask only acts on `done` tasks with no live run.
  const task = makeTask(dir, { column: "done" });

  await createTerminal(task.id);
  await createTerminal(task.id);
  expect(countTerminals(task.id)).toBe(2);

  const { archiveTask } = await import("./orchestrator.ts");
  const res = await archiveTask(task.id);
  expect("task" in res).toBe(true);

  // archiveTask awaits killTerminalsForTask (a live shell would block the
  // worktree detach), so the tabs are gone once it resolves.
  expect(countTerminals(task.id)).toBe(0);
  expect(tasks.get(task.id)!.openTerminalCount).toBe(0);
});

test("killTerminalsForTask tears down every tab for a task", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-term-kill-"));
  const task = makeTask(dir);

  await createTerminal(task.id);
  await createTerminal(task.id);
  expect(countTerminals(task.id)).toBe(2);

  await killTerminalsForTask(task.id);
  expect(countTerminals(task.id)).toBe(0);
});

test("createTerminal materializes the worktree for an isolation task and pins it on the task", async () => {
  const repo = await makeRepo();
  const task = makeTask(repo, { isolation: "worktree", agent: "claude-code" });
  // Pre-state: no worktree yet.
  expect(tasks.get(task.id)!.worktreePath).toBeNull();
  expect(tasks.get(task.id)!.branch).toBeNull();

  const created = await createTerminal(task.id);
  expect("error" in created).toBe(false);
  if ("error" in created) return;

  // The worktree was created and pinned back onto the task, so a later agent
  // run reuses the same isolated dir.
  const after = tasks.get(task.id)!;
  expect(after.worktreePath).not.toBeNull();
  expect(after.branch).not.toBeNull();
  expect(existsSync(after.worktreePath!)).toBe(true);
  // The terminal's cwd is the worktree, not the source repo.
  expect(created.cwd).toBe(after.worktreePath!);
});

test("a shell that exits is auto-removed from the manager", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-term-exit-"));
  const task = makeTask(dir);

  const created = await createTerminal(task.id);
  expect("error" in created).toBe(false);
  if ("error" in created) return;
  expect(countTerminals(task.id)).toBe(1);

  // Tell the shell to exit; the manager should drop the entry on process exit.
  writeTerminal(created.id, "exit\r");
  const gone = await waitFor(() => countTerminals(task.id) === 0, SHELL_READY_MS);
  expect(gone).toBe(true);
  expect(tasks.get(task.id)!.openTerminalCount).toBe(0);
}, SHELL_READY_MS + 10_000);
