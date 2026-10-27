import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunEvent, Subagent, Task } from "../shared/types.ts";

// db.ts captures AGETOR_DATA_DIR at first import — set it before importing.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-opencode-subagents-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

let db: typeof import("./db.ts");
let mod: typeof import("./opencode-subagents.ts");
let exportMod: typeof import("./opencode-export.ts");
let rmTestDataDir: typeof import("./test-data-dir.ts").rmTestDataDir;

beforeAll(async () => {
  db = await import("./db.ts");
  mod = await import("./opencode-subagents.ts");
  exportMod = await import("./opencode-export.ts");
  ({ rmTestDataDir } = await import("./test-data-dir.ts"));
});

afterAll(() => {
  rmTestDataDir(DATA_DIR);
});

const emitted: RunEvent[] = [];
let prevEmitter: ((e: RunEvent) => void) | null = null;
let prevRunner: Parameters<typeof import("./opencode-export.ts").__forTest.setExportRunner>[0] = null;
afterEach(() => {
  mod.setOpencodeSubagentEmitter(prevEmitter);
  exportMod.__forTest.setExportRunner(prevRunner);
  emitted.length = 0;
});
function installEmitter() {
  prevEmitter = mod.setOpencodeSubagentEmitter((e) => emitted.push(e));
}
function installExports(byId: Record<string, string | null | "throw">) {
  prevRunner = exportMod.__forTest.setExportRunner(async (a) => {
    const f = byId[a.sessionId];
    if (f === "throw") throw new Error("export exploded");
    if (!f) return null;
    return exportMod.parseOpencodeExport(readFileSync(path.join(FIXTURES, f), "utf8"), a.major);
  });
}

const FIXTURES = path.join(import.meta.dir, "fixtures", "opencode");

function seedTask(): { taskId: string; runId: string } {
  const taskId = `task-ocsub-${randomUUID()}`;
  const runId = `run-ocsub-${randomUUID()}`;
  const now = Date.now();
  const t: Task = {
    id: taskId, title: "t", prompt: "p", agent: "opencode", workdir: "/tmp", isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: null, model: null, effort: null, speed: "off", maxMode: false, opencodeServer: "shared",
    references: [], backlog: [], plans: [], draft: null, column: "running", runId: null,
    createdAt: now, updatedAt: now, hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0, archivedAt: null,
  };
  db.tasks.insert(t);
  db.runs.insert({
    id: runId, taskId, agent: "opencode", status: "running", startedAt: now, endedAt: null, exitCode: null,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  return { taskId, runId };
}

function notice(child: string, extra: Partial<{ description: string; agentType: string; background: boolean }> = {}) {
  return {
    childSessionId: child,
    description: extra.description ?? "List files",
    agentType: extra.agentType ?? "explore",
    toolUseId: `call-${child}`,
    background: extra.background ?? false,
  };
}
const refreshArgs = (taskId: string, over: Partial<{ major: 1 | 2; standalone: boolean; final: boolean }> = {}) => ({
  taskId, bin: "opencode", env: {}, cwd: "/tmp", major: over.major ?? 2, standalone: over.standalone ?? false, final: over.final ?? true,
});
function row(child: string): Subagent {
  return db.subagents.get(mod.opencodeSubagentId(child))!;
}

test("register inserts one running opencode_subagent row (idempotent) and emits started", () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const child = `ses_reg${randomUUID().replace(/-/g, "")}`;
  mod.registerOpencodeSubagent({ taskId, runId, notice: notice(child) });
  mod.registerOpencodeSubagent({ taskId, runId, notice: notice(child) });
  const r = row(child);
  expect(r).toMatchObject({
    taskId, runId, sourcePath: `opencode-session:${child}`,
    status: "running", toolUseId: `call-${child}`, description: "List files", agentType: "explore", endedAt: null,
  });
  // The stored kind (read raw: db.ts's row mapper may not list the kind yet).
  const raw = db.db.query<{ parent_kind: string }, [string]>("SELECT parent_kind FROM subagents WHERE id = ?").get(r.id);
  expect(raw?.parent_kind).toBe("opencode_subagent");
  expect(db.subagents.hasRunning(taskId)).toBe(true);
  const lifecycle = emitted.filter((e) => e.stream === "subagent");
  expect(lifecycle).toHaveLength(1);
  expect(JSON.parse(lifecycle[0]!.data).phase).toBe("started");
});

test("complete child: events appended under subagent_id, row completed, refresh is idempotent", async () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const child = "ses_e82612922ffe6VVY5SiPNRsanX";
  installExports({ [child]: "v2-session-export-child.json" });
  mod.registerOpencodeSubagent({ taskId, runId, notice: notice(child) });
  await mod.refreshOpencodeSubagents(refreshArgs(taskId));
  expect(row(child).status).toBe("completed");
  expect(row(child).endedAt).not.toBeNull();
  const seen = db.runs.seenLineUuidsForSubagent(taskId, row(child).id);
  expect(seen.has("opencode:msg_17d9ed72b001SI4oiUSW42BHpq:1:use")).toBe(true);
  const streamed = emitted.filter((e) => e.subagentId === row(child).id && e.stream !== "subagent");
  expect(streamed.length).toBe(seen.size);
  expect(streamed.some((e) => e.stream === "assistant")).toBe(true);
  expect(JSON.parse(emitted.filter((e) => e.stream === "subagent").at(-1)!.data)).toMatchObject({ phase: "finished", subagent: { status: "completed" } });
  expect(db.subagents.hasRunning(taskId)).toBe(false);

  // A second refresh sees no running/orphaned rows: nothing re-appended.
  const n = emitted.length;
  await mod.refreshOpencodeSubagents(refreshArgs(taskId));
  expect(emitted.length).toBe(n);
});

test("v1 complete child export fills the tab", async () => {
  const { taskId, runId } = seedTask();
  const child = "ses_e825eafb7ffeOjjZhBrQwKVqet";
  installExports({ [child]: "v1-session-export-child.json" });
  mod.registerOpencodeSubagent({ taskId, runId, notice: notice(child) });
  await mod.refreshOpencodeSubagents(refreshArgs(taskId, { major: 1 }));
  expect(row(child).status).toBe("completed");
  expect(db.runs.seenLineUuidsForSubagent(taskId, row(child).id).has("opencode:tool:prt_17da154d0001ErCrWx11EONtG1:use")).toBe(true);
});

test("unfinished child on a Standalone turn → failed with a status line (A6)", async () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const child = "ses_e8250f036ffepNNRrhaD7yBOwE";
  installExports({ [child]: "v2-session-export-bg-child-dead.json" });
  mod.registerOpencodeSubagent({ taskId, runId, notice: notice(child, { description: "Sleep then list files", background: true }) });
  await mod.refreshOpencodeSubagents(refreshArgs(taskId, { standalone: true }));
  expect(row(child).status).toBe("failed");
  // The child's own "Step interrupted" lands in its tab; the stop notice on the main stream.
  expect(emitted.some((e) => e.subagentId === row(child).id && e.data === "opencode: Step interrupted")).toBe(true);
  const status = emitted.find((e) => e.stream === "status" && e.subagentId === null);
  expect(status).toMatchObject({ subagentId: null, data: 'OpenCode subagent "Sleep then list files" stopped when the turn ended' });
});

test("unfinished child on a v2 Shared turn → orphaned once, re-checked and completed on a later turn", async () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const child = `ses_shared${randomUUID().replace(/-/g, "")}`;
  installExports({ [child]: "v2-session-export-bg-child-dead.json" });
  mod.registerOpencodeSubagent({ taskId, runId, notice: notice(child, { description: "Long job" }) });
  await mod.refreshOpencodeSubagents(refreshArgs(taskId, { standalone: false }));
  expect(row(child).status).toBe("orphaned");
  expect(db.subagents.hasRunning(taskId)).toBe(false);
  expect(emitted.filter((e) => e.stream === "status").map((e) => e.data)).toEqual([
    'OpenCode subagent "Long job" is still running — its tab fills when a later turn finishes',
  ]);
  // Still unfinished at the next turn end: stays orphaned, no second status line.
  await mod.refreshOpencodeSubagents(refreshArgs(taskId, { standalone: false }));
  expect(row(child).status).toBe("orphaned");
  expect(emitted.filter((e) => e.stream === "status")).toHaveLength(1);
  // Finished by the turn after.
  exportMod.__forTest.setExportRunner(async () => exportMod.parseOpencodeExport(
    readFileSync(path.join(FIXTURES, "v2-session-export-child.json"), "utf8"), 2));
  await mod.refreshOpencodeSubagents(refreshArgs(taskId));
  expect(row(child).status).toBe("completed");
});

test("an orphaned child re-checked by a later Standalone (or v1) turn stays orphaned, never relabeled stopped", async () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const child = `ses_orph${randomUUID().replace(/-/g, "")}`;
  installExports({ [child]: "v2-session-export-bg-child-dead.json" });
  mod.registerOpencodeSubagent({ taskId, runId, notice: notice(child, { description: "Shared job" }) });
  await mod.refreshOpencodeSubagents(refreshArgs(taskId, { standalone: false }));
  expect(row(child).status).toBe("orphaned");
  // A later turn ran Standalone / on v1: it says nothing about a child an
  // earlier Shared turn left in OpenCode's service.
  await mod.refreshOpencodeSubagents(refreshArgs(taskId, { standalone: true }));
  await mod.refreshOpencodeSubagents(refreshArgs(taskId, { major: 1 }));
  expect(row(child).status).toBe("orphaned");
  expect(emitted.some((e) => e.stream === "status" && e.data.includes("stopped when the turn ended"))).toBe(false);
});

test("every settle fires the settle hook — a refresh that lands late still releases a held task", async () => {
  const fired: string[] = [];
  const prev = mod.setOpencodeSubagentSettleHook((id) => fired.push(id));
  try {
    const { taskId, runId } = seedTask();
    const done = `ses_hook${randomUUID().replace(/-/g, "")}`;
    installExports({ [done]: "v2-session-export-child.json" });
    mod.registerOpencodeSubagent({ taskId, runId, notice: notice(done) });
    await mod.refreshOpencodeSubagents(refreshArgs(taskId));
    expect(row(done).status).toBe("completed");
    expect(fired).toEqual([taskId]);
  } finally {
    mod.setOpencodeSubagentSettleHook(prev);
  }
});

test("orphanRunningOpencodeSubagents flips only running OpenCode rows, posts a status line and fires the hook once", () => {
  installEmitter();
  const fired: string[] = [];
  const prev = mod.setOpencodeSubagentSettleHook((id) => fired.push(id));
  try {
    const { taskId, runId } = seedTask();
    const a = `ses_dropa${randomUUID().replace(/-/g, "")}`;
    const b = `ses_dropb${randomUUID().replace(/-/g, "")}`;
    mod.registerOpencodeSubagent({ taskId, runId, notice: notice(a, { description: "Job A" }) });
    mod.registerOpencodeSubagent({ taskId, runId, notice: notice(b) });
    db.subagents.setStatus(mod.opencodeSubagentId(b), "completed", Date.now());
    // A Claude row on the same task is left alone (its own watcher owns it).
    const claudeRow: Subagent = {
      id: `claude-${randomUUID()}`, taskId, runId, parentKind: "subagent", agentType: "x", description: null,
      spawnDepth: 1, sourcePath: "/tmp/agent-x.jsonl", toolUseId: null, status: "running", startedAt: Date.now(), endedAt: null,
    };
    db.subagents.insertIfAbsent(claudeRow);

    expect(mod.orphanRunningOpencodeSubagents(taskId, "the task switched harness")).toBe(1);
    expect(row(a).status).toBe("orphaned");
    expect(row(b).status).toBe("completed");
    expect(db.subagents.get(claudeRow.id)?.status).toBe("running");
    expect(fired).toEqual([taskId]);
    expect(emitted.filter((e) => e.stream === "status").map((e) => e.data)).toEqual([
      'OpenCode subagent "Job A" was left unfinished — the task switched harness',
    ]);
    // Nothing left to flip: no second hook call.
    expect(mod.orphanRunningOpencodeSubagents(taskId, "again")).toBe(0);
    expect(fired).toEqual([taskId]);
  } finally {
    mod.setOpencodeSubagentSettleHook(prev);
  }
});

function seedBreadcrumb(runId: string, major: 1 | 2, server: "shared" | "standalone" | "n/a"): void {
  db.runs.appendEvent(runId, "status", `opencode ${major}.x · server=${server} · model=OpenCode default · effort=auto · mode=auto`);
}

test("opencodeTurnOfRun reads the run's D-19 line and ignores this module's own OpenCode status lines", () => {
  const { runId } = seedTask();
  expect(mod.opencodeTurnOfRun(runId)).toBeNull();
  expect(mod.opencodeTurnOfRun(null)).toBeNull();
  seedBreadcrumb(runId, 2, "standalone");
  // A later `OpenCode subagent …` line (LIKE is case-insensitive) must not shadow it.
  db.runs.appendEvent(runId, "status", 'OpenCode subagent "x" is still running — its tab fills when a later turn finishes');
  expect(mod.opencodeTurnOfRun(runId)).toEqual({ major: 2, server: "standalone" });
  const v1 = seedTask();
  seedBreadcrumb(v1.runId, 1, "n/a");
  expect(mod.opencodeTurnOfRun(v1.runId)).toEqual({ major: 1, server: null });
});

test("orphanRunningOpencodeSubagents fails rows of a Standalone or v1 turn, orphans those of a Shared one", () => {
  installEmitter();
  const cases = [
    { major: 2, server: "standalone", want: "failed" },
    { major: 1, server: "n/a", want: "failed" },
    { major: 2, server: "shared", want: "orphaned" },
  ] as const;
  for (const c of cases) {
    const { taskId, runId } = seedTask();
    seedBreadcrumb(runId, c.major, c.server);
    const child = `ses_turn${randomUUID().replace(/-/g, "")}`;
    mod.registerOpencodeSubagent({ taskId, runId, notice: notice(child, { description: "Job" }) });
    expect(mod.orphanRunningOpencodeSubagents(taskId, "the task was archived")).toBe(1);
    expect(row(child).status).toBe(c.want);
  }
  expect(emitted.filter((e) => e.stream === "status").map((e) => e.data)).toEqual([
    'OpenCode subagent "Job" stopped — the task was archived',
    'OpenCode subagent "Job" stopped — the task was archived',
    'OpenCode subagent "Job" was left unfinished — the task was archived',
  ]);
});

test("an orphaned row still unfinished past the re-check window is given up on (failed), once", async () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const stale = `ses_stale${randomUUID().replace(/-/g, "")}`;
  const fresh = `ses_fresh${randomUUID().replace(/-/g, "")}`;
  installExports({ [stale]: "v2-session-export-bg-child-dead.json", [fresh]: "v2-session-export-bg-child-dead.json" });
  mod.registerOpencodeSubagent({ taskId, runId, notice: notice(stale, { description: "Stale job" }) });
  mod.registerOpencodeSubagent({ taskId, runId, notice: notice(fresh, { description: "Fresh job" }) });
  db.subagents.setStatus(mod.opencodeSubagentId(stale), "orphaned", Date.now() - mod.ORPHAN_RECHECK_MAX_AGE_MS - 1000);
  db.subagents.setStatus(mod.opencodeSubagentId(fresh), "orphaned", Date.now() - 1000);
  await mod.refreshOpencodeSubagents(refreshArgs(taskId, { standalone: false }));
  expect(row(stale).status).toBe("failed");
  expect(row(fresh).status).toBe("orphaned");
  expect(emitted.filter((e) => e.stream === "status" && e.subagentId === null).map((e) => e.data)).toEqual([
    'OpenCode subagent "Stale job" never reported finishing — stopped checking on it',
  ]);
  // A complete export still wins over the window: the outcome is recorded.
  const late = `ses_late${randomUUID().replace(/-/g, "")}`;
  exportMod.__forTest.setExportRunner(async () => exportMod.parseOpencodeExport(
    readFileSync(path.join(FIXTURES, "v2-session-export-child.json"), "utf8"), 2));
  mod.registerOpencodeSubagent({ taskId, runId, notice: notice(late) });
  db.subagents.setStatus(mod.opencodeSubagentId(late), "orphaned", Date.now() - mod.ORPHAN_RECHECK_MAX_AGE_MS - 1000);
  await mod.refreshOpencodeSubagents(refreshArgs(taskId));
  expect(row(late).status).toBe("completed");
});

test("v1: an unfinished child is failed even without --standalone", async () => {
  const { taskId, runId } = seedTask();
  const child = `ses_v1${randomUUID().replace(/-/g, "")}`;
  installExports({ [child]: null });
  mod.registerOpencodeSubagent({ taskId, runId, notice: notice(child) });
  await mod.refreshOpencodeSubagents(refreshArgs(taskId, { major: 1 }));
  expect(row(child).status).toBe("failed");
});

test("never left running after a final refresh — export missing or throwing", async () => {
  const { taskId, runId } = seedTask();
  const missing = `ses_miss${randomUUID().replace(/-/g, "")}`;
  const boom = `ses_boom${randomUUID().replace(/-/g, "")}`;
  installExports({ [missing]: null, [boom]: "throw" });
  mod.registerOpencodeSubagent({ taskId, runId, notice: notice(missing) });
  mod.registerOpencodeSubagent({ taskId, runId, notice: notice(boom) });
  await mod.refreshOpencodeSubagents(refreshArgs(taskId, { standalone: false }));
  expect(row(missing).status).toBe("orphaned");
  expect(row(boom).status).toBe("orphaned");
  expect(db.subagents.hasRunning(taskId)).toBe(false);
});

test("a non-final refresh leaves an unfinished child running but settles a complete one", async () => {
  const { taskId, runId } = seedTask();
  const notDone = `ses_nd${randomUUID().replace(/-/g, "")}`;
  installExports({ [notDone]: "v2-session-export-bg-child-dead.json" });
  mod.registerOpencodeSubagent({ taskId, runId, notice: notice(notDone) });
  await mod.refreshOpencodeSubagents(refreshArgs(taskId, { final: false }));
  expect(row(notDone).status).toBe("running");
});

test("a non-final refresh settles a complete child and fills its tab", async () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const done = `ses_nfdone${randomUUID().replace(/-/g, "")}`;
  installExports({ [done]: "v2-session-export-child.json" });
  mod.registerOpencodeSubagent({ taskId, runId, notice: notice(done) });
  await mod.refreshOpencodeSubagents(refreshArgs(taskId, { final: false }));
  expect(row(done).status).toBe("completed");
  expect(emitted.some((e) => e.subagentId === row(done).id && e.stream === "assistant")).toBe(true);
});

test("the re-check window only gives up on a final refresh; a throwing export still gives up", async () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const expired = `ses_exp${randomUUID().replace(/-/g, "")}`;
  installExports({ [expired]: "throw" });
  mod.registerOpencodeSubagent({ taskId, runId, notice: notice(expired, { description: "Expired job" }) });
  db.subagents.setStatus(mod.opencodeSubagentId(expired), "orphaned", Date.now() - mod.ORPHAN_RECHECK_MAX_AGE_MS - 1000);
  // A mid-turn (non-final) refresh says nothing about a child left by an
  // earlier turn: it stays orphaned, no status line.
  await mod.refreshOpencodeSubagents(refreshArgs(taskId, { final: false }));
  expect(row(expired).status).toBe("orphaned");
  expect(emitted.filter((e) => e.stream === "status")).toEqual([]);
  // The turn end gives up on it even though its export threw.
  await mod.refreshOpencodeSubagents(refreshArgs(taskId, { final: true }));
  expect(row(expired).status).toBe("failed");
  expect(emitted.filter((e) => e.stream === "status").map((e) => e.data)).toEqual([
    'OpenCode subagent "Expired job" never reported finishing — stopped checking on it',
  ]);
});

test("a row orphaned just inside the re-check window keeps being re-checked", async () => {
  const { taskId, runId } = seedTask();
  const recent = `ses_recent${randomUUID().replace(/-/g, "")}`;
  installExports({ [recent]: null });
  mod.registerOpencodeSubagent({ taskId, runId, notice: notice(recent) });
  db.subagents.setStatus(mod.opencodeSubagentId(recent), "orphaned", Date.now() - mod.ORPHAN_RECHECK_MAX_AGE_MS + 60_000);
  await mod.refreshOpencodeSubagents(refreshArgs(taskId, { final: true }));
  expect(row(recent).status).toBe("orphaned");
});

test("the Claude subagent watcher never seeds opencode_subagent rows", async () => {
  const { taskId, runId } = seedTask();
  const child = `ses_watch${randomUUID().replace(/-/g, "")}`;
  mod.registerOpencodeSubagent({ taskId, runId, notice: notice(child) });
  const { attachSubagentWatcher, subagentActivityWithin } = await import("./claude-subagents.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-ocsub-watch-"));
  const handle = attachSubagentWatcher({ taskId, jsonlPath: path.join(dir, "session.jsonl"), manual: true });
  await handle.ready;
  handle.pump();
  await handle.settled;
  // Untouched: still running, still pointing at its pseudo path.
  expect(row(child)).toMatchObject({ status: "running", sourcePath: `opencode-session:${child}` });
  expect(subagentActivityWithin(taskId, 60_000)).toBe(false);
  handle.detach();
});
