import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunEvent, Subagent, Task } from "../shared/types.ts";
import { OpencodeHttpError as HttpErr, type OpencodeClient } from "./opencode-http.ts";
import type { OpencodeMappedChunk } from "./opencode-events.ts";

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
  // Each frame is its stored row, in id order (forward resume D11): a resumed
  // stream replays exactly what was sent live.
  const stored = db.db
    .query<{ id: number; ts: number; stream: string; data: string }, [string]>(
      "SELECT id, ts, stream, data FROM run_events WHERE subagent_id = ? ORDER BY id",
    )
    .all(row(child).id);
  expect<unknown>(streamed.map((e) => ({ id: e.id, ts: e.ts, stream: e.stream, data: e.data }))).toEqual(stored);
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

function seedBreadcrumb(runId: string, major: 1 | 2, server: "shared" | "standalone" | "agetor" | "n/a"): void {
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

/* ── agetor-server turns: live child sessions (plan T12) ─────────────────── */

const childId = (tag: string) => `ses_${tag}${randomUUID().replace(/-/g, "")}`;
function reg(taskId: string, runId: string, child: string, over: Partial<Parameters<typeof import("./opencode-subagents.ts").registerOpencodeChildSession>[0]> = {}) {
  mod.registerOpencodeChildSession({ taskId, runId, parentSessionId: "ses_parent", childSessionId: child, title: "Count files", agent: "General", depth: 1, ...over });
}
const text = (child: string, msg: string, ord: number, data: string): OpencodeMappedChunk => ({
  stream: "assistant", data, lineUuid: `opencode:${child}:text:${msg}:${ord}`,
});
function childEvents(child: string): Array<{ id: number; stream: string; data: string; line_uuid: string | null }> {
  return db.db
    .query<{ id: number; stream: string; data: string; line_uuid: string | null }, [string]>(
      "SELECT id, stream, data, line_uuid FROM run_events WHERE subagent_id = ? ORDER BY id",
    )
    .all(mod.opencodeSubagentId(child));
}

test("registerOpencodeChildSession creates one running opencode_subagent row, idempotently", () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const child = childId("regc");
  reg(taskId, runId, child);
  reg(taskId, runId, child, { title: "Other title", depth: 3 });
  expect(row(child)).toMatchObject({
    taskId, runId, parentKind: "opencode_subagent", sourcePath: `opencode-session:${child}`,
    status: "running", description: "Count files", agentType: "General", spawnDepth: 1, endedAt: null,
  });
  const raw = db.db.query<{ parent_kind: string }, [string]>("SELECT parent_kind FROM subagents WHERE id = ?").get(row(child).id);
  expect(raw?.parent_kind).toBe("opencode_subagent");
  expect(emitted.filter((e) => e.stream === "subagent").map((e) => JSON.parse(e.data).phase)).toEqual(["started"]);
  // An existing row that already settled is not reopened by a replayed register.
  mod.settleOpencodeChild({ taskId, childSessionId: child, outcome: "completed" });
  reg(taskId, runId, child);
  expect(row(child).status).toBe("completed");
});

test("ingestOpencodeChildChunks appends under the child's subagent id, dedupes by lineUuid and broadcasts stored frames", () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const child = childId("ingc");
  reg(taskId, runId, child);
  const a = text(child, "msg_1", 0, "hello");
  const b = text(child, "msg_1", 1, "world");
  mod.ingestOpencodeChildChunks({ taskId, childSessionId: child, chunks: [a, b] });
  mod.ingestOpencodeChildChunks({ taskId, childSessionId: child, chunks: [a, b, text(child, "msg_2", 0, "more")] });
  const stored = childEvents(child);
  expect(stored.map((e) => e.data)).toEqual(["hello", "world", "more"]);
  const frames = emitted.filter((e) => e.subagentId === row(child).id && e.stream !== "subagent");
  expect(frames.map((e) => ({ id: e.id, data: e.data, runId: e.runId }))).toEqual(stored.map((e) => ({ id: e.id, data: e.data, runId })));
  // Main-stream events of the run are untouched.
  expect(db.runs.seenLineUuidsForTask(taskId).size).toBe(0);
});

test("ingest drops usage lines, unknown children and rows of another task", () => {
  installEmitter();
  const t1 = seedTask();
  const t2 = seedTask();
  const child = childId("dropc");
  reg(t1.taskId, t1.runId, child);
  mod.ingestOpencodeChildChunks({
    taskId: t1.taskId, childSessionId: child,
    chunks: [{ stream: "status", data: 'fx-usage: {"inputTokens":1}', lineUuid: `opencode:${child}:usage:msg_1` }],
  });
  mod.ingestOpencodeChildChunks({ taskId: t2.taskId, childSessionId: child, chunks: [text(child, "msg_1", 0, "x")] });
  mod.ingestOpencodeChildChunks({ taskId: t1.taskId, childSessionId: "ses_nope", chunks: [text("ses_nope", "msg_1", 0, "x")] });
  expect(childEvents(child)).toHaveLength(0);
  expect(emitted.filter((e) => e.stream !== "subagent")).toHaveLength(0);
});

test("ingest replace:true rewrites a tool_use in place (same row id) and re-broadcasts it; a missing target inserts", () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const child = childId("repc");
  reg(taskId, runId, child);
  const use = (name: string, extra: Partial<OpencodeMappedChunk> = {}): OpencodeMappedChunk => ({
    stream: "tool_use", data: JSON.stringify({ id: "call_1", name, input: {} }), lineUuid: `opencode:${child}:tool:call_1:use`, ...extra,
  });
  mod.ingestOpencodeChildChunks({ taskId, childSessionId: child, chunks: [use("tool", { provisional: true })] });
  const before = childEvents(child);
  expect(before).toHaveLength(1);
  mod.ingestOpencodeChildChunks({ taskId, childSessionId: child, chunks: [use("Bash", { replace: true })] });
  const after = childEvents(child);
  expect(after).toHaveLength(1);
  expect(after[0]!.id).toBe(before[0]!.id);
  expect(JSON.parse(after[0]!.data).name).toBe("Bash");
  const frames = emitted.filter((e) => e.stream === "tool_use");
  expect(frames).toHaveLength(2);
  expect(frames[1]).toMatchObject({ id: before[0]!.id, subagentId: row(child).id });
  expect(JSON.parse(frames[1]!.data).name).toBe("Bash");
  // A replace whose target was never persisted inserts it.
  const lone: OpencodeMappedChunk = { stream: "tool_use", data: JSON.stringify({ id: "call_2", name: "Read", input: {} }), lineUuid: `opencode:${child}:tool:call_2:use`, replace: true };
  mod.ingestOpencodeChildChunks({ taskId, childSessionId: child, chunks: [lone] });
  expect(childEvents(child)).toHaveLength(2);
});

test("ingest brings an orphaned row back to running, and leaves a settled row's status alone", () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const live = childId("revc");
  reg(taskId, runId, live);
  db.subagents.setStatus(mod.opencodeSubagentId(live), "orphaned", Date.now());
  mod.ingestOpencodeChildChunks({ taskId, childSessionId: live, chunks: [text(live, "msg_1", 0, "still going")] });
  expect(row(live)).toMatchObject({ status: "running", endedAt: null });
  expect(emitted.filter((e) => e.stream === "subagent").map((e) => JSON.parse(e.data).phase)).toEqual(["started", "started"]);

  const done = childId("donec");
  reg(taskId, runId, done);
  mod.settleOpencodeChild({ taskId, childSessionId: done, outcome: "completed" });
  mod.ingestOpencodeChildChunks({ taskId, childSessionId: done, chunks: [text(done, "msg_1", 0, "late line")] });
  expect(row(done).status).toBe("completed");
  expect(childEvents(done).map((e) => e.data)).toEqual(["late line"]);
});

test("settleOpencodeChild maps each outcome, fires the hook once per settle and never reopens a settled row", () => {
  installEmitter();
  const fired: string[] = [];
  const prev = mod.setOpencodeSubagentSettleHook((id) => fired.push(id));
  try {
    const { taskId, runId } = seedTask();
    const cases = [
      { outcome: "completed", want: "completed" },
      { outcome: "failed", want: "failed" },
      { outcome: "interrupted", want: "cancelled" },
    ] as const;
    for (const c of cases) {
      const child = childId(`set${c.outcome}`);
      reg(taskId, runId, child);
      mod.settleOpencodeChild({ taskId, childSessionId: child, outcome: c.outcome });
      expect(row(child).status).toBe(c.want);
      expect(row(child).endedAt).not.toBeNull();
    }
    expect(fired).toEqual([taskId, taskId, taskId]);
    expect(db.subagents.hasRunning(taskId)).toBe(false);
    const finished = emitted.filter((e) => e.stream === "subagent").map((e) => JSON.parse(e.data)).filter((p) => p.phase === "finished");
    expect(finished.map((p) => p.subagent.status)).toEqual(["completed", "failed", "cancelled"]);

    // A second terminal for the same child: no change, no second hook.
    const firstChild = db.subagents.listForTask(taskId)[0]!;
    mod.settleOpencodeChild({ taskId, childSessionId: mod.opencodeChildSessionOf(firstChild)!, outcome: "failed" });
    expect(db.subagents.get(firstChild.id)?.status).toBe("completed");
    expect(fired).toHaveLength(3);

    // An unknown child or another task's id is ignored.
    mod.settleOpencodeChild({ taskId, childSessionId: "ses_missing", outcome: "completed" });
    expect(fired).toHaveLength(3);
  } finally {
    mod.setOpencodeSubagentSettleHook(prev);
  }
});

test("settle settles an orphaned row (a late terminal), and a failed outcome's error lands in the child's tab once", () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const child = childId("errc");
  reg(taskId, runId, child);
  db.subagents.setStatus(mod.opencodeSubagentId(child), "orphaned", Date.now());
  mod.settleOpencodeChild({ taskId, childSessionId: child, outcome: "failed", error: "Upstream\u0007request failed" });
  expect(row(child).status).toBe("failed");
  expect(childEvents(child).map((e) => e.data)).toEqual(["opencode: Upstream request failed"]);

  // The mapper already wrote an error line for this child: no second one.
  const mapped = childId("errm");
  reg(taskId, runId, mapped);
  mod.ingestOpencodeChildChunks({
    taskId, childSessionId: mapped,
    chunks: [{ stream: "status", data: "opencode: boom", lineUuid: `opencode:${mapped}:error:execution:msg_1` }],
  });
  mod.settleOpencodeChild({ taskId, childSessionId: mapped, outcome: "failed", error: "boom" });
  expect(childEvents(mapped).map((e) => e.data)).toEqual(["opencode: boom"]);
});

// A stub of the three client calls the sync uses. Messages are ascending; pages are served newest first.
// `active` is what the server's active-session listing returns (an Error makes the call fail).
function stubClient(
  messages: unknown[],
  session: unknown | null = { id: "x", title: "Find TODOs", agent: "explore" },
  active: Record<string, { type: string }> | Error = {},
) {
  const calls = { listMessages: 0, getSession: 0, activeSessions: 0 };
  const client = {
    async activeSessions() {
      calls.activeSessions++;
      if (active instanceof Error) throw active;
      return active;
    },
    async getSession() {
      calls.getSession++;
      return session;
    },
    async listMessages(_id: string, a: { limit?: number; cursor?: string; order?: string } = {}) {
      calls.listMessages++;
      await Promise.resolve();
      const desc = messages.slice().reverse();
      const limit = a.limit ?? 50;
      const start = a.cursor ? Number(a.cursor) : 0;
      const page = desc.slice(start, start + limit);
      const next = start + limit < desc.length ? String(start + limit) : undefined;
      return { data: page, cursor: next ? { next } : {} };
    },
  };
  return { client: client as unknown as OpencodeClient, calls };
}
const userMsg = (id: string) => ({ id, type: "user", time: { created: 1 }, text: "do it" });
const asstMsg = (id: string, txt: string) => ({
  id, type: "assistant", time: { created: 1, completed: 2 }, finish: "stop", content: [{ type: "text", text: txt }],
});
const idleMsg = (outcome: string, error?: unknown) => ({ id: `msg_idle_${randomUUID()}`, type: "idle", time: { created: 3 }, outcome, ...(error ? { error } : {}) });

test("sync from the server: creates the row from getSession, pages through a long history, settles from the idle tail", async () => {
  installEmitter();
  const fired: string[] = [];
  const prev = mod.setOpencodeSubagentSettleHook((id) => fired.push(id));
  try {
    const { taskId, runId } = seedTask();
    const child = childId("syncc");
    const msgs: unknown[] = [userMsg("msg_u1")];
    for (let i = 0; i < 250; i++) msgs.push(asstMsg(`msg_a${String(i).padStart(3, "0")}`, `line ${i}`));
    msgs.push(idleMsg("succeeded"));
    const { client, calls } = stubClient(msgs);
    await mod.syncOpencodeChildFromServer({ taskId, runId, client, childSessionId: child });
    expect(row(child)).toMatchObject({ status: "completed", description: "Find TODOs", agentType: "explore", runId, taskId });
    const stored = childEvents(child);
    expect(stored).toHaveLength(250);
    expect(stored[0]!.data).toBe("line 0");
    expect(stored[249]!.data).toBe("line 249");
    expect(calls.listMessages).toBeGreaterThan(2); // 252 messages over 100-message pages
    expect(fired).toEqual([taskId]);

    // A repeat sync adds nothing and does not settle twice.
    const n = emitted.length;
    await mod.syncOpencodeChildFromServer({ taskId, runId, client, childSessionId: child });
    expect(emitted.length).toBe(n);
    expect(fired).toEqual([taskId]);
  } finally {
    mod.setOpencodeSubagentSettleHook(prev);
  }
});

test("sync fills only what is missing after a resync gap, and settles failed and interrupted tails", async () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const child = childId("gapc");
  reg(taskId, runId, child);
  // Live ingest got only the first line before the stream dropped.
  mod.ingestOpencodeChildChunks({ taskId, childSessionId: child, chunks: [text(child, "msg_a1", 0, "first")] });
  const msgs = [userMsg("msg_u1"), asstMsg("msg_a1", "first"), asstMsg("msg_a2", "second"), idleMsg("failed", { message: "model refused" })];
  const { client } = stubClient(msgs);
  await mod.syncOpencodeChildFromServer({ taskId, runId, client, childSessionId: child });
  expect(childEvents(child).map((e) => e.data)).toEqual(["first", "second", "opencode: model refused"]);
  expect(row(child).status).toBe("failed");

  const stopped = childId("stpc");
  const { client: c2 } = stubClient([userMsg("msg_u1"), asstMsg("msg_a1", "partial"), idleMsg("interrupted")]);
  await mod.syncOpencodeChildFromServer({ taskId, runId, client: c2, childSessionId: stopped });
  expect(row(stopped).status).toBe("cancelled");
});

test("sync of a child with no idle tail leaves it running and revives an orphaned row the server lists as active", async () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const child = childId("runc");
  reg(taskId, runId, child);
  db.subagents.setStatus(mod.opencodeSubagentId(child), "orphaned", Date.now());
  const { client } = stubClient([userMsg("msg_u1"), asstMsg("msg_a1", "working")], undefined, { [child]: { type: "running" } });
  await mod.syncOpencodeChildFromServer({ taskId, runId, client, childSessionId: child });
  expect(row(child)).toMatchObject({ status: "running", endedAt: null });
  expect(childEvents(child).map((e) => e.data)).toEqual(["working"]);
  expect(db.subagents.hasRunning(taskId)).toBe(true);
});

test("sync never revives an orphaned row the server does not list as active; a positive 'not active' with no idle tail settles it for good (S10, S6)", async () => {
  installEmitter();
  const fired: string[] = [];
  const prevHook = mod.setOpencodeSubagentSettleHook((id) => fired.push(id));
  const { taskId, runId } = seedTask();
  const msgs = [userMsg("msg_u1"), asstMsg("msg_a1", "working")]; // no idle tail: an old child that never finished

  const idle = childId("s10a");
  reg(taskId, runId, idle, { title: "Dig" });
  const orphanedAt = Date.now() - 1000;
  db.subagents.setStatus(mod.opencodeSubagentId(idle), "orphaned", orphanedAt);
  const notActive = stubClient(msgs, undefined, { ses_someone_else: { type: "running" } });
  try {
    await mod.syncOpencodeChildFromServer({ taskId, runId, client: notActive.client, childSessionId: idle });
  } finally {
    mod.setOpencodeSubagentSettleHook(prevHook);
  }
  expect(notActive.calls.activeSessions).toBe(1);
  expect(row(idle).status).toBe("failed");
  expect(row(idle).endedAt).not.toBe(orphanedAt);
  expect(fired).toEqual([taskId]);
  expect(mod.listOpenOpencodeChildSessions(taskId)).not.toContain(idle);
  expect(emitted.filter((e) => e.stream === "status").map((e) => e.data)).toEqual([
    'OpenCode subagent "Dig" is no longer running on the OpenCode server',
  ]);
  expect(childEvents(idle).map((e) => e.data)).toEqual(["working"]); // the history is still filled in

  // The active-session listing failing is "not active", not "assume alive".
  const flaky = childId("s10b");
  reg(taskId, runId, flaky);
  db.subagents.setStatus(mod.opencodeSubagentId(flaky), "orphaned", orphanedAt);
  const err = console.error;
  console.error = () => {};
  try {
    await mod.syncOpencodeChildFromServer({ taskId, runId, client: stubClient(msgs, undefined, new Error("boom")).client, childSessionId: flaky });
  } finally {
    console.error = err;
  }
  expect(row(flaky).status).toBe("orphaned");

  // A trailing idle still settles an orphan without asking who is active.
  const done = childId("s10c");
  reg(taskId, runId, done);
  db.subagents.setStatus(mod.opencodeSubagentId(done), "orphaned", orphanedAt);
  const finished = stubClient([...msgs, idleMsg("succeeded")]);
  await mod.syncOpencodeChildFromServer({ taskId, runId, client: finished.client, childSessionId: done });
  expect(row(done).status).toBe("completed");
  expect(finished.calls.activeSessions).toBe(0);
});

test("a child the server answers 404 for is settled for good: failed once, never revived by a later sync (S6)", async () => {
  installEmitter();
  const fired: string[] = [];
  const prev = mod.setOpencodeSubagentSettleHook((id) => fired.push(id));
  try {
    const { taskId, runId } = seedTask();
    const gone = childId("s6a");
    reg(taskId, runId, gone);
    const notFound = {
      getSession: async () => null,
      listMessages: async () => {
        throw new HttpErr("listMessages", 404, "no such session", "SessionNotFoundError");
      },
      activeSessions: async () => ({}),
    } as unknown as OpencodeClient;
    await mod.syncOpencodeChildFromServer({ taskId, runId, client: notFound, childSessionId: gone });
    const first = row(gone);
    expect(first.status).toBe("failed");
    expect(first.endedAt).not.toBeNull();
    expect(mod.listOpenOpencodeChildSessions(taskId)).not.toContain(gone);
    const goneLines = () => emitted.filter((e) => e.stream === "status" && e.data.includes("no longer known to the OpenCode server"));
    expect(goneLines()).toHaveLength(1);
    expect(fired).toEqual([taskId]);

    // Later syncs: still 404 -> untouched (endedAt is not refreshed, nothing fires or is written again).
    await Bun.sleep(5);
    await mod.syncOpencodeChildFromServer({ taskId, runId, client: notFound, childSessionId: gone });
    expect(row(gone)).toMatchObject({ status: "failed", endedAt: first.endedAt });
    expect(goneLines()).toHaveLength(1);
    expect(fired).toEqual([taskId]);

    // ... and even a server that now answers with an unfinished history and no active entry does not revive it.
    await mod.syncOpencodeChildFromServer({
      taskId, runId, client: stubClient([userMsg("msg_u1"), asstMsg("msg_a1", "x")], undefined, { [gone]: { type: "running" } }).client, childSessionId: gone,
    });
    expect(row(gone).status).toBe("failed");

    // A recently orphaned row (a turn or a lost server parked it) that now 404s is settled too, not kept
    // open for the 24 h re-check window.
    const parked = childId("s6p");
    reg(taskId, runId, parked);
    db.subagents.setStatus(mod.opencodeSubagentId(parked), "orphaned", Date.now() - 1000);
    expect(mod.listOpenOpencodeChildSessions(taskId)).toContain(parked);
    fired.length = 0;
    await mod.syncOpencodeChildFromServer({ taskId, runId, client: notFound, childSessionId: parked });
    expect(row(parked).status).toBe("failed");
    expect(mod.listOpenOpencodeChildSessions(taskId)).not.toContain(parked);
    expect(fired).toEqual([taskId]);

    // A terminal row is left alone by a 404.
    const done = childId("s6b");
    reg(taskId, runId, done);
    mod.settleOpencodeChild({ taskId, childSessionId: done, outcome: "completed" });
    fired.length = 0;
    await mod.syncOpencodeChildFromServer({ taskId, runId, client: notFound, childSessionId: done });
    expect(row(done).status).toBe("completed");
    expect(fired).toEqual([]);
  } finally {
    mod.setOpencodeSubagentSettleHook(prev);
  }
});

test("listOpenOpencodeChildSessions: running rows and recently orphaned rows, not old orphans or settled rows (S6)", () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const running = childId("s6run");
  const fresh = childId("s6new");
  const old = childId("s6old");
  const done = childId("s6done");
  for (const c of [running, fresh, old, done]) reg(taskId, runId, c);
  const now = Date.now();
  db.subagents.setStatus(mod.opencodeSubagentId(fresh), "orphaned", now - 60_000);
  db.subagents.setStatus(mod.opencodeSubagentId(old), "orphaned", now - mod.ORPHAN_RECHECK_MAX_AGE_MS - 60_000);
  db.subagents.setStatus(mod.opencodeSubagentId(done), "completed", now);
  expect(mod.listOpenOpencodeChildSessions(taskId, now).sort()).toEqual([running, fresh].sort());
  // the age limit is measured from when it was orphaned
  expect(mod.listOpenOpencodeChildSessions(taskId, now + mod.ORPHAN_RECHECK_MAX_AGE_MS).sort()).toEqual([running]);
});

test("sync never throws: a missing session creates no row, a failing client leaves the row as it was", async () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const gone = childId("gonec");
  await mod.syncOpencodeChildFromServer({ taskId, runId, client: stubClient([], null).client, childSessionId: gone });
  expect(db.subagents.get(mod.opencodeSubagentId(gone))).toBeNull();

  const child = childId("badc");
  reg(taskId, runId, child);
  const broken = { getSession: async () => null, listMessages: async () => { throw new Error("connection refused"); } } as unknown as OpencodeClient;
  const err = console.error;
  console.error = () => {};
  try {
    await mod.syncOpencodeChildFromServer({ taskId, runId, client: broken, childSessionId: child });
  } finally {
    console.error = err;
  }
  expect(row(child).status).toBe("running");

  // An existing child with an empty history stays as it is.
  await mod.syncOpencodeChildFromServer({ taskId, runId, client: stubClient([]).client, childSessionId: child });
  expect(row(child).status).toBe("running");
});

test("concurrent syncs of one child share a single read", async () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const child = childId("sharec");
  const { client, calls } = stubClient([userMsg("msg_u1"), asstMsg("msg_a1", "x"), idleMsg("succeeded")]);
  await Promise.all([
    mod.syncOpencodeChildFromServer({ taskId, runId, client, childSessionId: child }),
    mod.syncOpencodeChildFromServer({ taskId, runId, client, childSessionId: child }),
  ]);
  expect(calls.getSession).toBe(1);
  expect(childEvents(child)).toHaveLength(1);
});

test("refreshOpencodeSubagents is a no-op for a turn carried by the agetor server — no export, row untouched", async () => {
  const { taskId, runId } = seedTask();
  seedBreadcrumb(runId, 2, "agetor");
  const child = childId("noopc");
  reg(taskId, runId, child);
  db.subagents.setStatus(mod.opencodeSubagentId(child), "orphaned", Date.now() - 1000);
  const exported: string[] = [];
  prevRunner = exportMod.__forTest.setExportRunner(async (a) => {
    exported.push(a.sessionId);
    return null;
  });
  await mod.refreshOpencodeSubagents(refreshArgs(taskId));
  expect(exported).toEqual([]);
  expect(row(child).status).toBe("orphaned");
  const running = childId("noopr");
  reg(taskId, runId, running);
  await mod.refreshOpencodeSubagents(refreshArgs(taskId, { final: false }));
  expect(exported).toEqual([]);
  expect(row(running).status).toBe("running");

  // A tmux-driven row on the same task (its own turn) is still refreshed.
  const tmuxRun = `run-ocsub-${randomUUID()}`;
  db.runs.insert({
    id: tmuxRun, taskId, agent: "opencode", status: "running", startedAt: Date.now(), endedAt: null, exitCode: null,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  seedBreadcrumb(tmuxRun, 2, "shared");
  const tmuxChild = childId("tmuxc");
  mod.registerOpencodeSubagent({ taskId, runId: tmuxRun, notice: notice(tmuxChild) });
  await mod.refreshOpencodeSubagents(refreshArgs(taskId));
  expect(exported).toEqual([tmuxChild]);
});

test("orphanRunningOpencodeSubagents leaves an agetor-server child orphaned, never failed (the server outlives the turn)", () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  seedBreadcrumb(runId, 2, "agetor");
  expect(mod.opencodeTurnOfRun(runId)).toEqual({ major: 2, server: "agetor" });
  const child = childId("orphc");
  reg(taskId, runId, child, { title: "Job" });
  expect(mod.orphanRunningOpencodeSubagents(taskId, "agetor restarted")).toBe(1);
  expect(row(child).status).toBe("orphaned");
  expect(emitted.filter((e) => e.stream === "status").map((e) => e.data)).toEqual([
    'OpenCode subagent "Job" was left unfinished — agetor restarted',
  ]);
});

/* ── fix round 3: dead orphans, a lost server, the stopped-by-agetor store, the settled list ── */

test("an orphaned child stays open while the server can't be asked, and is settled only once it positively answers (S6)", async () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const msgs = [userMsg("msg_u1"), asstMsg("msg_a1", "working")];
  const child = childId("s6u");
  reg(taskId, runId, child);
  const orphanedAt = Date.now() - 1000;
  db.subagents.setStatus(mod.opencodeSubagentId(child), "orphaned", orphanedAt);
  const err = console.error;
  console.error = () => {};
  try {
    // The listing fails: nothing is known, so nothing is settled.
    await mod.syncOpencodeChildFromServer({ taskId, runId, client: stubClient(msgs, undefined, new Error("ECONNREFUSED")).client, childSessionId: child });
    expect(row(child)).toMatchObject({ status: "orphaned", endedAt: orphanedAt });
    expect(mod.listOpenOpencodeChildSessions(taskId)).toContain(child);
    // The history read itself fails (server down): same.
    const down = { getSession: async () => null, listMessages: async () => { throw new Error("connection refused"); }, activeSessions: async () => ({}) } as unknown as OpencodeClient;
    await mod.syncOpencodeChildFromServer({ taskId, runId, client: down, childSessionId: child });
    expect(row(child)).toMatchObject({ status: "orphaned", endedAt: orphanedAt });
  } finally {
    console.error = err;
  }
  // The server is back and lists the child as running: revived.
  await mod.syncOpencodeChildFromServer({ taskId, runId, client: stubClient(msgs, undefined, { [child]: { type: "running" } }).client, childSessionId: child });
  expect(row(child).status).toBe("running");
});

test("an orphaned child with no messages that the server doesn't list as active is settled; a running one is left to the live stream", async () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const orphan = childId("s6e");
  reg(taskId, runId, orphan);
  db.subagents.setStatus(mod.opencodeSubagentId(orphan), "orphaned", Date.now() - 1000);
  await mod.syncOpencodeChildFromServer({ taskId, runId, client: stubClient([]).client, childSessionId: orphan });
  expect(row(orphan).status).toBe("failed");

  // A running row is never settled by the active listing: it may be about to start.
  const running = childId("s6r");
  reg(taskId, runId, running);
  const { client, calls } = stubClient([userMsg("msg_u1"), asstMsg("msg_a1", "x")]);
  await mod.syncOpencodeChildFromServer({ taskId, runId, client, childSessionId: running });
  await mod.syncOpencodeChildFromServer({ taskId, runId, client: stubClient([]).client, childSessionId: running });
  expect(row(running).status).toBe("running");
  expect(calls.activeSessions).toBe(0);
});

test("a dead child agetor itself stopped settles as cancelled, not failed", async () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const child = childId("s6c");
  reg(taskId, runId, child);
  db.subagents.setStatus(mod.opencodeSubagentId(child), "orphaned", Date.now() - 1000);
  mod.noteOpencodeChildStoppedByAgetor({ taskId, childSessionId: child });
  await mod.syncOpencodeChildFromServer({ taskId, runId, client: stubClient([userMsg("msg_u1")]).client, childSessionId: child });
  expect(row(child).status).toBe("cancelled");
});

test("orphanRunningOpencodeChildrenOfTask parks a lost server's running children orphaned, leaves settled rows and other tasks alone (S10)", async () => {
  installEmitter();
  const fired: string[] = [];
  const prev = mod.setOpencodeSubagentSettleHook((id) => fired.push(id));
  try {
    const { taskId, runId } = seedTask();
    seedBreadcrumb(runId, 2, "agetor");
    const a = childId("lsa");
    const b = childId("lsb");
    const done = childId("lsd");
    for (const c of [a, b, done]) reg(taskId, runId, c, { title: "Job" });
    mod.settleOpencodeChild({ taskId, childSessionId: done, outcome: "completed" });
    const other = seedTask();
    const otherChild = childId("lso");
    reg(other.taskId, other.runId, otherChild);
    fired.length = 0;

    expect(db.subagents.hasRunning(taskId)).toBe(true);
    expect(mod.orphanRunningOpencodeChildrenOfTask(taskId)).toBe(2);
    expect([row(a).status, row(b).status, row(done).status]).toEqual(["orphaned", "orphaned", "completed"]);
    expect(row(otherChild).status).toBe("running");
    expect(db.subagents.hasRunning(taskId)).toBe(false);
    expect(fired).toEqual([taskId]);
    expect(emitted.filter((e) => e.stream === "status").map((e) => e.data)).toEqual([
      'OpenCode subagent "Job" was left unfinished — the OpenCode server stopped',
      'OpenCode subagent "Job" was left unfinished — the OpenCode server stopped',
    ]);
    // Idempotent.
    expect(mod.orphanRunningOpencodeChildrenOfTask(taskId)).toBe(0);
    expect(fired).toEqual([taskId]);

    // The next sync against a server that no longer runs them settles them for good.
    await mod.syncOpencodeChildFromServer({ taskId, runId, client: stubClient([userMsg("msg_u1")]).client, childSessionId: a });
    expect(row(a).status).toBe("failed");
  } finally {
    mod.setOpencodeSubagentSettleHook(prev);
  }
});

test("stopped-by-agetor notes: recorded without a subagent row, read from the DB, unknown ids false, expire after 24 h (C2)", async () => {
  const { taskId } = seedTask();
  const child = childId("stop");
  expect(mod.wasOpencodeChildStoppedByAgetor(child)).toBe(false);
  mod.noteOpencodeChildStoppedByAgetor({ taskId, childSessionId: child });
  expect(mod.wasOpencodeChildStoppedByAgetor(child)).toBe(true);
  // No subagent row (no tab) was invented for it.
  expect(db.subagents.get(mod.opencodeSubagentId(child))).toBeNull();
  expect(db.subagents.listForTask(taskId)).toEqual([]);
  // The DB row is the record.
  const stored = db.db.query<{ task_id: string; stopped_at: number }, [string]>(
    `SELECT task_id, stopped_at FROM opencode_stopped_children WHERE child_session_id = ?`,
  ).get(child);
  expect(stored?.task_id).toBe(taskId);

  // A fresh copy of the module (a restarted core has no in-memory state) still knows.
  const fresh = (await import(`./opencode-subagents.ts?restart=${randomUUID()}`)) as typeof import("./opencode-subagents.ts");
  expect(fresh).not.toBe(mod);
  expect(fresh.wasOpencodeChildStoppedByAgetor(child)).toBe(true);
  // ... including a note an earlier core wrote straight into the table.
  const earlier = childId("stope");
  db.db.run(`INSERT INTO opencode_stopped_children (child_session_id, task_id, stopped_at) VALUES (?, ?, ?)`, [earlier, taskId, Date.now() - 60_000]);
  expect(fresh.wasOpencodeChildStoppedByAgetor(earlier)).toBe(true);

  // Unknown and empty ids.
  expect(mod.wasOpencodeChildStoppedByAgetor(childId("never"))).toBe(false);
  expect(mod.wasOpencodeChildStoppedByAgetor("")).toBe(false);

  // Expiry: true just inside the window, false at its edge and after.
  const t0 = Date.now();
  const old = childId("stopo");
  mod.noteOpencodeChildStoppedByAgetor({ taskId, childSessionId: old }, t0);
  expect(mod.wasOpencodeChildStoppedByAgetor(old, t0 + mod.OPENCODE_STOPPED_CHILD_TTL_MS - 1)).toBe(true);
  expect(mod.wasOpencodeChildStoppedByAgetor(old, t0 + mod.OPENCODE_STOPPED_CHILD_TTL_MS)).toBe(false);
  // Re-noting refreshes the time.
  mod.noteOpencodeChildStoppedByAgetor({ taskId, childSessionId: old }, t0 + 1000);
  expect(mod.wasOpencodeChildStoppedByAgetor(old, t0 + mod.OPENCODE_STOPPED_CHILD_TTL_MS)).toBe(true);
  // A later note prunes the expired rows.
  mod.noteOpencodeChildStoppedByAgetor({ taskId, childSessionId: childId("stopn") }, t0 + 2 * mod.OPENCODE_STOPPED_CHILD_TTL_MS);
  expect(db.db.query(`SELECT 1 FROM opencode_stopped_children WHERE child_session_id = ?`).get(old)).toBeNull();
});

test("listSettledOpencodeChildSessions is exactly the OpenCode rows listOpenOpencodeChildSessions leaves out", () => {
  installEmitter();
  const { taskId, runId } = seedTask();
  const now = Date.now();
  const ids = {
    running: childId("lr"), fresh: childId("lf"), old: childId("lo"), edge: childId("le"),
    done: childId("ld"), failed: childId("lx"), cancelled: childId("lc"),
  };
  for (const c of Object.values(ids)) reg(taskId, runId, c);
  const set = (c: string, st: Subagent["status"], at: number) => db.subagents.setStatus(mod.opencodeSubagentId(c), st, at);
  set(ids.fresh, "orphaned", now - 60_000);
  set(ids.old, "orphaned", now - mod.ORPHAN_RECHECK_MAX_AGE_MS - 60_000);
  set(ids.edge, "orphaned", now - mod.ORPHAN_RECHECK_MAX_AGE_MS);
  set(ids.done, "completed", now);
  set(ids.failed, "failed", now);
  set(ids.cancelled, "cancelled", now);
  // A Claude subagent row on the same task is never listed.
  db.subagents.insertIfAbsent({
    id: `claude-${randomUUID()}`, taskId, runId, parentKind: "subagent", agentType: null, description: null, spawnDepth: 1,
    sourcePath: "/tmp/agent-x.jsonl", toolUseId: null, status: "completed", startedAt: now, endedAt: now,
  });
  const open = mod.listOpenOpencodeChildSessions(taskId, now).sort();
  const settled = mod.listSettledOpencodeChildSessions(taskId, now).sort();
  expect(open).toEqual([ids.running, ids.fresh].sort());
  expect(settled).toEqual([ids.old, ids.edge, ids.done, ids.failed, ids.cancelled].sort());
  expect(mod.OPENCODE_SUBAGENT_SOURCE_PREFIX).toBe("opencode-session:");
});
