import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImportedOpencodeSession, Run, Task } from "../shared/types.ts";

// Orchestrator plumbing for the opencode kind (docs/plans/add-opencode-harness.md
// W2-A / W2-T1): start → discovered session id → follow-ups resume it, the
// one-shot turn queue, graceful teardown (D-10), boot reattach, the
// server-option flow (D-4), the D-19 breadcrumb and the imported-session
// gates (D-13). Turns run through the in-process fake driver (D-18), which
// feeds canned v2 NDJSON through the real line processor.

// db.ts captures AGETOR_DATA_DIR at first import.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-opencode-orch-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_OPENCODE_DRIVER = "fake";

// `checkHarness` (startTask's pre-flight) and `cachedCliVersion` (follow-ups,
// reattach) probe `--version`; the stubs answer as an OpenCode 2 / 1 build.
const binDir = mkdtempSync(path.join(tmpdir(), "agetor-opencode-bin-"));
function writeStub(name: string, version: string): string {
  const p = path.join(binDir, name);
  writeFileSync(
    p,
    [
      "#!/bin/sh",
      `if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi`,
      'if [ "$1" = "auth" ]; then echo "[]"; exit 0; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(p, 0o755);
  return p;
}
const V2_BIN = writeStub("opencode", "2.1.3");
const V1_BIN = writeStub("opencode-v1", "1.19.4");
process.env.AGETOR_OPENCODE_BIN = V2_BIN;

/**
 * A fake `tmux` that logs every call and answers `has-session` from a mode
 * file: `absent` (exit 1), `live` (exit 0), or `once` (exit 0 the first time,
 * then absent — what a session that dies on `C-c` looks like). Every other
 * command exits 0.
 */
const tmuxDir = mkdtempSync(path.join(tmpdir(), "agetor-opencode-tmux-"));
const tmuxLog = path.join(tmuxDir, "log");
const tmuxMode = path.join(tmuxDir, "mode");
{
  const bin = path.join(tmuxDir, "tmux");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${tmuxLog}'`,
      'case "$*" in',
      "  *has-session*)",
      `    mode=$(cat '${tmuxMode}' 2>/dev/null)`,
      '    if [ "$mode" = live ]; then exit 0; fi',
      `    if [ "$mode" = once ]; then echo absent > '${tmuxMode}'; exit 0; fi`,
      "    exit 1;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  process.env.AGETOR_TMUX_BIN = bin;
}
function setTmux(mode: "absent" | "live" | "once"): void {
  writeFileSync(tmuxMode, mode);
  writeFileSync(tmuxLog, "");
}
function tmuxCalls(): string[] {
  return existsSync(tmuxLog) ? readFileSync(tmuxLog, "utf8").split("\n").filter(Boolean) : [];
}

const WORKDIR = mkdtempSync(path.join(tmpdir(), "agetor-opencode-wd-"));

let db: typeof import("./db.ts");
let restoreHarnesses: (() => void) | undefined;
let orch: typeof import("./orchestrator.ts");

beforeAll(async () => {
  db = await import("./db.ts");
  restoreHarnesses = (await import("./test-harness-state.ts")).snapshotHarnessState();
  orch = await import("./orchestrator.ts");
  db.harnesses.setEnabled("opencode", true);
  setTmux("absent");
});

afterAll(async () => {
  restoreHarnesses?.();
  const { rmTestDataDir } = await import("./test-data-dir.ts");
  rmTestDataDir(DATA_DIR);
});

async function settle(ms = 250): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Poll until `fn` is truthy (or the deadline passes). */
async function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function newTask(overrides: Partial<Parameters<typeof orch.createTask>[0]> = {}): Promise<Task> {
  const created = await orch.createTask({
    title: "opencode task",
    prompt: "turn one",
    agent: "opencode",
    workdir: WORKDIR,
    isolation: "none",
    taskType: "task",
    ...overrides,
  });
  if ("error" in created) throw new Error(created.error);
  return created.task;
}

function statusLines(runId: string): string[] {
  return db.runs.events(runId).filter((e) => e.stream === "status").map((e) => e.data);
}
function userLines(runId: string): string[] {
  return db.runs.events(runId).filter((e) => e.stream === "user").map((e) => e.data);
}
/** Runs oldest-first (listForTask is newest-first). */
function runsOf(taskId: string): Run[] {
  return [...db.runs.listForTask(taskId)].reverse();
}
function allSettled(taskId: string): boolean {
  return db.runs.listForTask(taskId).every((r) => r.status !== "running");
}

test("start persists the discovered session id; an idle follow-up resumes it with -s and the D-19 breadcrumb", async () => {
  const task = await newTask();
  const started = await orch.startTask(task.id);
  if ("error" in started) throw new Error(started.error);
  await waitFor(() => allSettled(task.id));

  const [first] = runsOf(task.id);
  expect(first?.status).toBe("succeeded");
  const sessionId = first?.opencodeSessionId;
  expect(sessionId).toMatch(/^ses_fake/);
  // The opening status line names the CLI line, effective server, model
  // label, effort and mode (D-19).
  const { defaultModeFor } = await import("../shared/types.ts");
  expect(statusLines(first!.id)[0]).toBe(
    `opencode 2.x · server=shared · model=OpenCode default · effort=auto · mode=${defaultModeFor("opencode")}`,
  );
  expect(db.tasks.get(task.id)?.column).toBe("review");

  const sent = await orch.sendInput(first!.id, "turn two");
  expect(sent.delivered).toBe(true);
  if (!sent.delivered) return;
  expect(sent.runId).not.toBe(first!.id);
  await waitFor(() => allSettled(task.id));

  const second = db.runs.get(sent.runId);
  expect(second?.status).toBe("succeeded");
  // The fake honors `resumeSessionId` exactly like `-s <id>`: same session.
  expect(second?.opencodeSessionId).toBe(sessionId);
  const lines = statusLines(sent.runId);
  expect(lines[0]).toStartWith("opencode 2.x · server=shared · ");
  expect(lines[1]).toBe(`resuming OpenCode session ${sessionId!.slice(0, 8)}…`);
});

test("follow-ups sent while a turn is busy queue and drain in order, each resuming the same session", async () => {
  const task = await newTask({ prompt: "first" });
  const started = await orch.startTask(task.id);
  if ("error" in started) throw new Error(started.error);
  const firstRunId = "runId" in started ? started.runId : "";
  // Same tick: the fake turn is still in flight, so both queue on it.
  const a = await orch.sendInput(firstRunId, "queued A");
  const b = await orch.sendInput(firstRunId, "queued B");
  expect(a.delivered && a.runId).toBe(firstRunId);
  expect(b.delivered && b.runId).toBe(firstRunId);
  expect(db.runs.listForTask(task.id)).toHaveLength(1);
  // The bubbles land on the active run right away.
  expect(userLines(firstRunId)).toEqual(expect.arrayContaining(["queued A", "queued B"]));

  await waitFor(() => db.runs.listForTask(task.id).length === 3 && allSettled(task.id));
  const list = runsOf(task.id);
  expect(list).toHaveLength(3);
  expect(userLines(list[1]!.id)).toEqual(["queued A"]);
  expect(userLines(list[2]!.id)).toEqual(["queued B"]);
  const sessionId = list[0]!.opencodeSessionId;
  expect(list[1]!.opencodeSessionId).toBe(sessionId);
  expect(list[2]!.opencodeSessionId).toBe(sessionId);
  expect(list.every((r) => r.status === "succeeded")).toBe(true);
});

test("delete clears the queue and tears the session down gracefully (C-c, then kill)", async () => {
  setTmux("once");
  const task = await newTask({ prompt: "first" });
  const started = await orch.startTask(task.id);
  if ("error" in started) throw new Error(started.error);
  const firstRunId = "runId" in started ? started.runId : "";
  await orch.sendInput(firstRunId, "queued");
  await orch.deleteTask(task.id);
  await settle(300);
  expect(db.tasks.get(task.id)).toBeNull();
  expect(db.runs.listForTask(task.id)).toHaveLength(0);
  const { opencodeSessionNameFor } = await import("./opencode-tmux.ts");
  const name = opencodeSessionNameFor(task.id);
  const calls = tmuxCalls();
  const ctrlC = calls.findIndex((c) => c.includes("send-keys") && c.includes(`=${name}:`) && c.endsWith("C-c"));
  const kill = calls.findIndex((c) => c.includes("kill-session") && c.includes(`=${name}`));
  expect(ctrlC).toBeGreaterThanOrEqual(0);
  expect(kill).toBeGreaterThan(ctrlC);
  setTmux("absent");
});

test("archive (stopRun) clears the queue — no queued turn spawns after the stopped one settles", async () => {
  setTmux("once");
  const task = await newTask({ prompt: "first" });
  const started = await orch.startTask(task.id);
  if ("error" in started) throw new Error(started.error);
  const firstRunId = "runId" in started ? started.runId : "";
  await orch.sendInput(firstRunId, "queued 1");
  await orch.sendInput(firstRunId, "queued 2");
  const archived = await orch.archiveTask(task.id, { force: true, stopRun: true, awaitTeardown: true });
  if ("error" in archived) throw new Error(archived.error);
  await waitFor(() => allSettled(task.id));
  await settle(250);
  const list = db.runs.listForTask(task.id);
  expect(list).toHaveLength(1);
  expect(list[0]?.status).toBe("cancelled");
  const { opencodeSessionNameFor } = await import("./opencode-tmux.ts");
  const name = opencodeSessionNameFor(task.id);
  const calls = tmuxCalls();
  expect(calls.some((c) => c.includes("send-keys") && c.includes(`=${name}:`) && c.endsWith("C-c"))).toBe(true);
  expect(calls.some((c) => c.includes("kill-session") && c.includes(`=${name}`))).toBe(true);
  setTmux("absent");
});

test("a same-kind agent switch drops the session gracefully, clears the queue, and keeps the server option", async () => {
  db.harnesses.insert({ id: "opencode-switch-alt", kind: "opencode", label: "OpenCode (alt)" });
  db.harnesses.setEnabled("opencode-switch-alt", true);
  setTmux("once");
  const task = await newTask({ prompt: "first", opencodeServer: "standalone" });
  const started = await orch.startTask(task.id);
  if ("error" in started) throw new Error(started.error);
  const firstRunId = "runId" in started ? started.runId : "";
  await orch.sendInput(firstRunId, "queued for the old harness");
  const before = db.tasks.get(task.id)!;
  const after = db.tasks.update(task.id, { agent: "opencode-switch-alt" })!;
  await orch.reconcileTaskSession(task.id, before, after);
  await waitFor(() => allSettled(task.id));
  await settle(250);
  // The in-flight turn finished on its own; the queued line was dropped
  // instead of spawning against the new harness.
  expect(db.runs.listForTask(task.id)).toHaveLength(1);
  const { opencodeSessionNameFor } = await import("./opencode-tmux.ts");
  const name = opencodeSessionNameFor(task.id);
  const calls = tmuxCalls();
  const ctrlC = calls.findIndex((c) => c.includes("send-keys") && c.includes(`=${name}:`) && c.endsWith("C-c"));
  expect(ctrlC).toBeGreaterThanOrEqual(0);
  expect(calls.findIndex((c) => c.includes("kill-session") && c.includes(`=${name}`))).toBeGreaterThan(ctrlC);
  // Same-kind switch: the picks (server option included) stay valid.
  expect(db.tasks.get(task.id)?.opencodeServer).toBe("standalone");
  setTmux("absent");
});

test("a cross-kind agent switch resets opencodeServer to shared", async () => {
  const task = await newTask({ opencodeServer: "standalone" });
  expect(task.opencodeServer).toBe("standalone");
  const before = db.tasks.get(task.id)!;
  const after = db.tasks.update(task.id, { agent: "claude-code" })!;
  await orch.reconcileTaskSession(task.id, before, after);
  const fresh = db.tasks.get(task.id)!;
  expect(fresh.opencodeServer).toBe("shared");
  expect(fresh.model).toBeNull();
});

/** A `running` OpenCode subagent row on `runId` (what a killed turn leaves). */
async function seedRunningChild(taskId: string, runId: string, description: string): Promise<string> {
  const { registerOpencodeSubagent, opencodeSubagentId } = await import("./opencode-subagents.ts");
  const child = `ses_left${randomUUID().replace(/-/g, "")}`;
  registerOpencodeSubagent({
    taskId,
    runId,
    notice: { childSessionId: child, description, agentType: "explore", toolUseId: `call-${child}`, background: true },
  });
  return opencodeSubagentId(child);
}

/** Insert a bare task + one run row directly (no spawn). */
function insertTaskWithRun(over: { agent: string; column: Task["column"]; runStatus: Run["status"] }): { taskId: string; runId: string } {
  const taskId = randomUUID();
  const runId = randomUUID();
  const now = Date.now();
  db.tasks.insert({
    id: taskId, title: "left rows", prompt: "p", column: over.column, agent: over.agent, workdir: WORKDIR,
    isolation: "none", taskType: "task", branch: null, branchSource: "created", worktreePath: null, baseRef: null,
    prUrl: null, mode: null, model: null, effort: null, speed: "off", maxMode: false, opencodeServer: "shared",
    references: [], backlog: [], plans: [], draft: null, runId, createdAt: now, updatedAt: now,
    hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0, archivedAt: null,
  });
  db.runs.insert({
    id: runId, taskId, agent: over.agent, status: over.runStatus, startedAt: now,
    endedAt: over.runStatus === "running" ? null : now, exitCode: over.runStatus === "succeeded" ? 0 : null,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null,
    fxSessionId: null, antigravitySessionId: null, opencodeSessionId: null,
  });
  return { taskId, runId };
}

test("an agent switch away from opencode orphans the subagent rows the dropped turn left running", async () => {
  // The drop resolves the tail without `beforeSettle`, so no final refresh
  // will ever settle them — left `running` they'd hold the next claude run.
  const { taskId, runId } = insertTaskWithRun({ agent: "opencode", column: "review", runStatus: "succeeded" });
  const rowId = await seedRunningChild(taskId, runId, "Background scan");
  const before = db.tasks.get(taskId)!;
  const after = db.tasks.update(taskId, { agent: "claude-code" })!;
  await orch.reconcileTaskSession(taskId, before, after);
  expect(db.subagents.get(rowId)?.status).toBe("orphaned");
  expect(db.subagents.hasRunning(taskId)).toBe(false);
  expect(statusLines(runId)).toContain('OpenCode subagent "Background scan" was left unfinished — the task switched harness');
});

test("boot reconcile orphans OpenCode rows no live tail will settle — and releases a claude task they held", async () => {
  setTmux("absent");
  // An opencode task whose turn died with the restart (no tmux session).
  const oc = insertTaskWithRun({ agent: "opencode", column: "review", runStatus: "succeeded" });
  const ocRow = await seedRunningChild(oc.taskId, oc.runId, "Died with the restart");
  // A claude task (switched from opencode) held in `running` by a leftover row.
  const cl = insertTaskWithRun({ agent: "claude-code", column: "running", runStatus: "succeeded" });
  const clRow = await seedRunningChild(cl.taskId, cl.runId, "Leftover");
  await orch.reconcileOrphans();
  expect(db.subagents.get(ocRow)?.status).toBe("orphaned");
  expect(db.subagents.get(clRow)?.status).toBe("orphaned");
  // The settle hook's held-task release moved the claude card on.
  expect(db.tasks.get(cl.taskId)?.column).toBe("review");
  expect(db.tasks.get(oc.taskId)?.column).toBe("review");
});

/** The D-19 opening line a turn of `server` on CLI `major` persists. */
function seedBreadcrumb(runId: string, major: 1 | 2, server: "shared" | "standalone" | "n/a"): void {
  db.runs.appendEvent(runId, "status", `opencode ${major}.x · server=${server} · model=OpenCode default · effort=auto · mode=auto`);
}

test("an agent switch off a Standalone turn fails the rows it left (the children died with it) — no later export", async () => {
  const { taskId, runId } = insertTaskWithRun({ agent: "opencode", column: "review", runStatus: "succeeded" });
  seedBreadcrumb(runId, 2, "standalone");
  const rowId = await seedRunningChild(taskId, runId, "Standalone scan");
  const before = db.tasks.get(taskId)!;
  const after = db.tasks.update(taskId, { agent: "claude-code" })!;
  await orch.reconcileTaskSession(taskId, before, after);
  expect(db.subagents.get(rowId)?.status).toBe("failed");
  expect(statusLines(runId)).toContain('OpenCode subagent "Standalone scan" stopped — the task switched harness');

  // A failed row is never re-checked: a later turn end runs no export for it.
  const exportMod = await import("./opencode-export.ts");
  const exported: string[] = [];
  const prev = exportMod.__forTest.setExportRunner(async (a) => {
    exported.push(a.sessionId);
    return null;
  });
  try {
    const { refreshOpencodeSubagents } = await import("./opencode-subagents.ts");
    await refreshOpencodeSubagents({ taskId, bin: "opencode", env: {}, cwd: WORKDIR, major: 2, standalone: false, final: true });
    expect(exported).toEqual([]);
  } finally {
    exportMod.__forTest.setExportRunner(prev);
  }
});

test("the turn's recorded mode wins over the task's current opencodeServer", async () => {
  // The turn ran Shared; the task was switched to Standalone afterwards.
  const { taskId, runId } = insertTaskWithRun({ agent: "opencode", column: "review", runStatus: "succeeded" });
  seedBreadcrumb(runId, 2, "shared");
  db.tasks.update(taskId, { opencodeServer: "standalone" });
  const rowId = await seedRunningChild(taskId, runId, "Shared scan");
  const before = db.tasks.get(taskId)!;
  const after = db.tasks.update(taskId, { agent: "claude-code" })!;
  await orch.reconcileTaskSession(taskId, before, after);
  expect(db.subagents.get(rowId)?.status).toBe("orphaned");
});

test("boot reconcile fails the rows a dead v1 turn left running", async () => {
  setTmux("absent");
  const oc = insertTaskWithRun({ agent: "opencode", column: "review", runStatus: "succeeded" });
  seedBreadcrumb(oc.runId, 1, "n/a");
  const rowId = await seedRunningChild(oc.taskId, oc.runId, "v1 child");
  await orch.reconcileOrphans();
  expect(db.subagents.get(rowId)?.status).toBe("failed");
  expect(statusLines(oc.runId)).toContain('OpenCode subagent "v1 child" stopped — agetor restarted while it was running');
});

test("deleting a held task settles its rows without moving the card (no column event)", async () => {
  // Held: the turn succeeded, a background child keeps the card in `running`.
  const { taskId, runId } = insertTaskWithRun({ agent: "opencode", column: "running", runStatus: "succeeded" });
  await seedRunningChild(taskId, runId, "Held child");
  const columns: string[] = [];
  const unsubscribe = orch.subscribeGlobal((e) => {
    if (e.kind === "column" && e.taskId === taskId) columns.push(e.column);
  });
  try {
    await orch.deleteTask(taskId);
    await settle(100);
  } finally {
    unsubscribe();
  }
  expect(db.tasks.get(taskId)).toBeNull();
  expect(columns).toEqual([]);
});

test("createTask: a valid opencodeServer is stored, anything else reads as shared", async () => {
  expect((await newTask({ opencodeServer: "standalone" })).opencodeServer).toBe("standalone");
  expect((await newTask({ opencodeServer: "shared" })).opencodeServer).toBe("shared");
  expect((await newTask()).opencodeServer).toBe("shared");
  // The route 400s junk first; createTask itself never stores it.
  expect((await newTask({ opencodeServer: "bogus" as never })).opencodeServer).toBe("shared");
});

test("profile freeze copies opencodeServer: create takes the profile's, a live edit before the first run is copied down", async () => {
  const profile = db.agentProfiles.insert({
    name: `oc-profile-${randomUUID().slice(0, 8)}`,
    harness: "opencode",
    model: "opencode-default",
    opencodeServer: "standalone",
  });
  // The profile wins over a body value.
  const task = await newTask({ agentProfileId: profile.id, opencodeServer: "shared" });
  expect(task.opencodeServer).toBe("standalone");
  db.agentProfiles.update(profile.id, { opencodeServer: "shared" });
  const started = await orch.startTask(task.id);
  if ("error" in started) throw new Error(started.error);
  await waitFor(() => allSettled(task.id));
  const fresh = db.tasks.get(task.id)!;
  expect(fresh.opencodeServer).toBe("shared");
  expect(fresh.agentProfile?.opencodeServer).toBe("shared");
  const [run] = runsOf(task.id);
  expect(statusLines(run!.id)[0]).toContain("server=shared");
});

test("breadcrumb: a harness with a home runs Standalone; a v1 CLI reports server=n/a; a real model and effort are named", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "agetor-opencode-home-"));
  db.harnesses.insert({ id: "opencode-home", kind: "opencode", label: "OpenCode (home)", home });
  db.harnesses.setEnabled("opencode-home", true);
  db.harnesses.insert({ id: "opencode-v1", kind: "opencode", label: "OpenCode 1", bin: V1_BIN });
  db.harnesses.setEnabled("opencode-v1", true);

  const homed = await newTask({ agent: "opencode-home", opencodeServer: "shared" });
  const s1 = await orch.startTask(homed.id);
  if ("error" in s1) throw new Error(s1.error);
  await waitFor(() => allSettled(homed.id));
  expect(statusLines(runsOf(homed.id)[0]!.id)[0]).toContain("opencode 2.x · server=standalone · ");

  const v1 = await newTask({ agent: "opencode-v1", model: "opencode/big-pickle", effort: "high", mode: "plan" });
  const s2 = await orch.startTask(v1.id);
  if ("error" in s2) throw new Error(s2.error);
  await waitFor(() => allSettled(v1.id));
  expect(statusLines(runsOf(v1.id)[0]!.id)[0]).toBe(
    "opencode 1.x · server=n/a · model=opencode/big-pickle · effort=high · mode=plan",
  );
});

test("Stop records the run cancelled from the handle flag", async () => {
  const task = await newTask();
  const started = await orch.startTask(task.id);
  if ("error" in started) throw new Error(started.error);
  const runId = "runId" in started ? started.runId : "";
  expect(await orch.cancelRun(runId)).toBe(true);
  await waitFor(() => allSettled(task.id));
  expect(db.runs.get(runId)?.status).toBe("cancelled");
  expect(db.tasks.get(task.id)?.column).toBe("ready");
});

test("boot reconcile reattaches a running opencode run with the subagent hooks wired", async () => {
  setTmux("live");
  const { opencodeLogPath, opencodeExitPath, opencodeSessionNameFor } = await import("./opencode-tmux.ts");
  const { opencodeSubagentId } = await import("./opencode-subagents.ts");
  const taskId = randomUUID();
  const runId = randomUUID();
  const now = Date.now();
  const sessionId = "ses_reattachparent01";
  const child = "ses_fakechildreattach1";
  db.tasks.insert({
    id: taskId,
    title: "reattach",
    prompt: "p",
    column: "running",
    agent: "opencode",
    workdir: WORKDIR,
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: "auto",
    model: "opencode-default",
    effort: "auto",
    speed: "off",
    maxMode: false,
    opencodeServer: "shared",
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    runId,
    createdAt: now,
    updatedAt: now,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
  });
  db.runs.insert({
    id: runId,
    taskId,
    agent: "opencode",
    status: "running",
    startedAt: now,
    endedAt: null,
    exitCode: null,
    tmuxSession: opencodeSessionNameFor(taskId),
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    antigravitySessionId: null,
    opencodeSessionId: sessionId,
  });
  // The turn finished while agetor was down: its log and exit file are on disk.
  const env = (type: string, body: Record<string, unknown>) => JSON.stringify({ type, timestamp: now, sessionID: sessionId, ...body });
  mkdirSync(path.dirname(opencodeLogPath(runId)), { recursive: true });
  writeFileSync(
    opencodeLogPath(runId),
    [
      env("step_start", { part: { id: "prt_r1", sessionID: sessionId, messageID: "msg_r1", type: "step-start" } }),
      env("tool_use", {
        part: {
          partID: "prt_r2",
          sessionID: sessionId,
          messageID: "msg_r1",
          type: "tool",
          id: "call-reattach-subagent",
          tool: "subagent",
          state: {
            status: "completed",
            input: { prompt: "look around", description: "Reattached child", agent: "explore" },
            output: `<subagent sessionID="${child}" state="completed">\ndone\n</subagent>`,
            title: "subagent",
            metadata: { metadata: { sessionID: child, status: "completed" } },
            time: { start: now, end: now + 1 },
          },
        },
      }),
      env("text", { part: { id: "prt_r3", sessionID: sessionId, messageID: "msg_r1", type: "text", text: "reattached reply" } }),
      env("step_finish", { part: { id: "prt_r4", sessionID: sessionId, messageID: "msg_r1", type: "step-finish", reason: "stop", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } }),
      "",
    ].join("\n"),
  );
  writeFileSync(opencodeExitPath(runId), "0\n");

  await orch.reconcileOrphans();
  await waitFor(() => db.runs.get(runId)?.status !== "running");
  expect(db.runs.get(runId)?.status).toBe("succeeded");
  expect(statusLines(runId)).toContain("reconnected to live session after agetor restart");
  expect(db.runs.events(runId).some((e) => e.stream === "assistant" && e.data.includes("reattached reply"))).toBe(true);
  // onSubagent registered the child; beforeSettle exported it (the fake's
  // canned complete child export) and settled the row.
  const row = db.subagents.listForTask(taskId).find((s) => s.id === opencodeSubagentId(child));
  expect(row?.parentKind).toBe("opencode_subagent");
  expect(row?.status).toBe("completed");
  expect(db.tasks.get(taskId)?.column).toBe("review");
  setTmux("absent");
});

function importedProvenance(status: ImportedOpencodeSession["status"], error: string | null = null): ImportedOpencodeSession {
  return {
    sessionId: "ses_importedoc0001",
    harnessId: "opencode",
    directory: WORKDIR,
    importedAt: Date.now(),
    status,
    error,
  };
}

test("imported OpenCode task: Run is refused; send refuses importing/failed and resumes the seed run's session once ready", async () => {
  const task = await newTask();
  const seedRunId = randomUUID();
  const now = Date.now();
  db.runs.insert({
    id: seedRunId,
    taskId: task.id,
    agent: "opencode",
    status: "succeeded",
    startedAt: now,
    endedAt: now,
    exitCode: 0,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    antigravitySessionId: null,
    opencodeSessionId: "ses_importedoc0001",
    origin: "imported",
  });
  db.tasks.update(task.id, { runId: seedRunId, column: "review" });
  db.tasks.setImportedOpencode(task.id, importedProvenance("importing"));

  expect(await orch.startTask(task.id)).toEqual({
    error: "imported OpenCode session — send a message to continue",
    code: "imported-session",
  });
  expect(await orch.sendInput(seedRunId, "hello")).toEqual({
    delivered: false,
    reason: "OpenCode history is still importing",
  });
  db.tasks.setImportedOpencode(task.id, importedProvenance("failed", "export failed"));
  expect(await orch.sendInput(seedRunId, "hello")).toEqual({ delivered: false, reason: "export failed" });
  expect(db.runs.listForTask(task.id)).toHaveLength(1);

  db.tasks.setImportedOpencode(task.id, importedProvenance("ready"));
  const sent = await orch.sendInput(seedRunId, "please continue");
  expect(sent.delivered).toBe(true);
  if (!sent.delivered) return;
  await waitFor(() => allSettled(task.id));
  expect(db.runs.get(sent.runId)?.opencodeSessionId).toBe("ses_importedoc0001");
  expect(statusLines(sent.runId)).toContain("resuming OpenCode session ses_impo…");
});

test("imported OpenCode duplicate whose claim belongs to another task is refused", async () => {
  const winner = await newTask();
  const loser = await newTask();
  const seedRunId = randomUUID();
  const now = Date.now();
  const held = { ...importedProvenance("ready"), sessionId: `ses_dup${randomUUID().slice(0, 8)}` };
  db.tasks.setImportedOpencode(winner.id, held);
  db.db.run(
    `UPDATE tasks SET imported_opencode = ?, imported_opencode_session_id = NULL WHERE id = ?`,
    [JSON.stringify(held), loser.id],
  );
  db.runs.insert({
    id: seedRunId,
    taskId: loser.id,
    agent: "opencode",
    status: "succeeded",
    startedAt: now,
    endedAt: now,
    exitCode: 0,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    opencodeSessionId: held.sessionId,
    origin: "imported",
  });
  db.tasks.update(loser.id, { runId: seedRunId, column: "review" });
  expect(await orch.sendInput(seedRunId, "hi")).toEqual({
    delivered: false,
    reason: db.IMPORTED_OPENCODE_HELD_ELSEWHERE,
  });
  expect(db.runs.listForTask(loser.id)).toHaveLength(1);
});
