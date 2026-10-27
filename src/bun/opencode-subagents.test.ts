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
