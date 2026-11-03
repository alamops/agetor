// DB-level tests for the OpenCode harness (docs/plans/add-opencode-harness.md
// W1-B / W1-T2): `tasks.opencode_server` / `agent_profiles.opencode_server`
// (migration 079) round-tripping through the `tasks`/`agentProfiles` modules,
// the lenient read of frozen snapshots without `opencodeServer`, the
// imported-OpenCode provenance + unique session claim
// (`tasks.setImportedOpencode` and friends), `runs.opencode_session_id`
// (migration 078) through `toRun`, `runs.sessionIdsForTask`, and the
// `harnessAutoEnabled` bookkeeping module (migration 080).
// Same setup as db-speed.test.ts: AGETOR_DATA_DIR is set at module scope
// BEFORE `./db.ts` is dynamically imported (the db opens — and migrates — on
// module load), and `rmTestDataDir` tears the dir down.
import { test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ImportedOpencodeSession, Run, Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-db-opencode-"));
process.env.AGETOR_DATA_DIR = dataDir;

type DbModule = typeof import("./db.ts");
let db: DbModule["db"];
let tasks: DbModule["tasks"];
let runs: DbModule["runs"];
let agentProfiles: DbModule["agentProfiles"];
let harnessAutoEnabled: DbModule["harnessAutoEnabled"];
let parsePipelineRunState: DbModule["parsePipelineRunState"];
let hiddenOpencodeSessionIds: DbModule["hiddenOpencodeSessionIds"];
let ImportedOpencodeSessionTaken: DbModule["ImportedOpencodeSessionTaken"];
let SESSION_ID_COLUMNS: DbModule["SESSION_ID_COLUMNS"];

beforeAll(async () => {
  ({
    db, tasks, runs, agentProfiles, harnessAutoEnabled, parsePipelineRunState,
    hiddenOpencodeSessionIds, ImportedOpencodeSessionTaken, SESSION_ID_COLUMNS,
  } = await import("./db.ts"));
});

beforeEach(() => {
  db.run(`DELETE FROM runs`);
  db.run(`DELETE FROM tasks`);
  db.run(`DELETE FROM agent_profiles`);
  db.run(`DELETE FROM harness_auto_enabled`);
});

afterAll(() => {
  rmTestDataDir(dataDir);
});

function makeTaskRow(overrides: Partial<Task> = {}): Task {
  return {
    id: randomUUID(),
    title: "t",
    prompt: "p",
    agent: "opencode",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    speed: "off",
    maxMode: false,
    opencodeServer: "shared",
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    column: "ready",
    runId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    ...overrides,
  };
}

function makeRun(taskId: string, overrides: Partial<Run> = {}): Run {
  return {
    id: randomUUID(),
    taskId,
    agent: "opencode",
    status: "succeeded",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    ...overrides,
  };
}

function importedValue(overrides: Partial<ImportedOpencodeSession> = {}): ImportedOpencodeSession {
  return {
    sessionId: "ses_abc123",
    harnessId: "opencode",
    directory: "/tmp/project",
    importedAt: 1_700_000_000_000,
    status: "importing",
    error: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// tasks.opencode_server
// ---------------------------------------------------------------------------

test("tasks.insert round-trips opencodeServer and defaults a missing value to shared", () => {
  const standalone = tasks.insert(makeTaskRow({ opencodeServer: "standalone" }));
  expect(standalone.opencodeServer).toBe("standalone");
  expect(tasks.get(standalone.id)!.opencodeServer).toBe("standalone");
  expect(tasks.list().find((t) => t.id === standalone.id)?.opencodeServer).toBe("standalone");

  // A caller that predates the field (no opencodeServer) stores the default.
  const legacy = makeTaskRow();
  delete (legacy as Partial<Task>).opencodeServer;
  const inserted = tasks.insert(legacy);
  expect(inserted.opencodeServer).toBe("shared");
  expect(db.query<{ v: string }, [string]>(`SELECT opencode_server AS v FROM tasks WHERE id = ?`).get(inserted.id)?.v).toBe("shared");
});

test("tasks.update patches opencodeServer (it is in the generic SET) and an unrelated patch keeps it", () => {
  const task = tasks.insert(makeTaskRow());
  expect(tasks.update(task.id, { opencodeServer: "standalone" })!.opencodeServer).toBe("standalone");
  expect(tasks.update(task.id, { title: "renamed" })!.opencodeServer).toBe("standalone");
  expect(tasks.update(task.id, { opencodeServer: "shared" })!.opencodeServer).toBe("shared");
});

test("the opencode_server CHECK refuses junk on tasks and agent_profiles", () => {
  const task = tasks.insert(makeTaskRow());
  expect(() => db.run(`UPDATE tasks SET opencode_server = 'remote' WHERE id = ?`, [task.id])).toThrow();
  expect(tasks.get(task.id)!.opencodeServer).toBe("shared");
  const profile = agentProfiles.insert({ name: "OC", harness: "opencode", model: "opencode-default" });
  expect(() => db.run(`UPDATE agent_profiles SET opencode_server = 'remote' WHERE id = ?`, [profile.id])).toThrow();
});

// ---------------------------------------------------------------------------
// agent profiles + snapshots
// ---------------------------------------------------------------------------

test("agentProfiles.insert defaults opencodeServer to shared, round-trips standalone, and update patches it", () => {
  const plain = agentProfiles.insert({ name: "Plain", harness: "opencode", model: "opencode-default" });
  expect(plain.opencodeServer).toBe("shared");

  const solo = agentProfiles.insert({ name: "Solo", harness: "opencode", model: "opencode-default", opencodeServer: "standalone" });
  expect(solo.opencodeServer).toBe("standalone");
  expect(agentProfiles.get(solo.id)!.opencodeServer).toBe("standalone");
  expect(agentProfiles.list().find((p) => p.id === solo.id)?.opencodeServer).toBe("standalone");

  expect(agentProfiles.update(plain.id, { opencodeServer: "standalone" })!.opencodeServer).toBe("standalone");
  expect(agentProfiles.update(plain.id, { model: "anthropic/claude-x" })!.opencodeServer).toBe("standalone");
});

test("agentProfiles refuses an opencodeServer outside OPENCODE_SERVER_MODES", () => {
  expect(() =>
    agentProfiles.insert({ name: "Bad", harness: "opencode", model: "m", opencodeServer: "remote" as never }),
  ).toThrow("opencodeServer must be one of shared, standalone");
  expect(agentProfiles.findByName("Bad")).toBeNull();
  const ok = agentProfiles.insert({ name: "Ok", harness: "opencode", model: "m" });
  expect(() => agentProfiles.update(ok.id, { opencodeServer: "remote" as never })).toThrow(/opencodeServer/);
  expect(agentProfiles.get(ok.id)!.opencodeServer).toBe("shared");
});

function snapshotJson(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "profile-oc",
    name: "OC Agent",
    harness: "opencode",
    harnessKind: "opencode",
    harnessLabel: "OpenCode",
    model: "opencode-default",
    effort: null,
    mode: "auto",
    speed: "off",
    maxMode: false,
    instructions: "",
    skills: [],
    capturedAt: 1,
    ...extra,
  };
}

test("a task snapshot without opencodeServer (frozen before 078) keeps it absent (means shared); an invalid one reads as shared", () => {
  const task = tasks.insert(makeTaskRow());
  db.run(`UPDATE tasks SET agent_profile_id = ?, agent_profile = ? WHERE id = ?`, [
    "profile-oc", JSON.stringify(snapshotJson({})), task.id,
  ]);
  expect(tasks.get(task.id)!.agentProfile!.opencodeServer).toBeUndefined();

  db.run(`UPDATE tasks SET agent_profile = ? WHERE id = ?`, [JSON.stringify(snapshotJson({ opencodeServer: 7 })), task.id]);
  expect(tasks.get(task.id)!.agentProfile!.opencodeServer).toBe("shared");

  const bound = tasks.setAgentProfile(
    task.id, "profile-oc",
    snapshotJson({ opencodeServer: "standalone" }) as unknown as NonNullable<Task["agentProfile"]>,
  )!;
  expect(bound.agentProfile!.opencodeServer).toBe("standalone");
});

test("pipeline-run snapshot profiles keep a missing opencodeServer absent (means shared) and normalize an invalid one, strict and lenient entries alike", () => {
  const raw = JSON.stringify({
    pipelineId: "pl", pipelineName: "P", status: "running", active: [], blocked: [], history: [],
    stepCount: 1, startedAt: 1, endedAt: null,
    snapshot: {
      graph: { steps: [{ id: "s1", name: "S", position: { x: 0, y: 0 }, agentProfileId: "p1" }], edges: [], startStepId: "s1" },
      profiles: {
        p1: snapshotJson({ id: "p1" }),
        p2: snapshotJson({ id: "p2", opencodeServer: "standalone" }),
        // No `model` — the strict sanitizer refuses it; the lenient fallback keeps it.
        p3: { id: "p3", name: "Odd" },
        p4: { id: "p4", name: "Odd", opencodeServer: "nope" },
      },
      maxSteps: 25, capturedAt: 1,
    },
  });
  const profiles = parsePipelineRunState(raw)!.snapshot!.profiles;
  expect(profiles.p1!.opencodeServer).toBeUndefined();
  expect(profiles.p2!.opencodeServer).toBe("standalone");
  expect(profiles.p3!.opencodeServer).toBeUndefined();
  expect(profiles.p4!.opencodeServer).toBe("shared");
});

// ---------------------------------------------------------------------------
// imported OpenCode sessions
// ---------------------------------------------------------------------------

test("setImportedOpencode writes provenance + claim without bumping updated_at; a generic update leaves both alone", () => {
  const task = tasks.insert(makeTaskRow({ updatedAt: 42 }));
  db.run(`UPDATE tasks SET updated_at = 42 WHERE id = ?`, [task.id]);
  const set = tasks.setImportedOpencode(task.id, importedValue())!;
  expect(set.importedOpencode).toEqual(importedValue());
  expect(set.updatedAt).toBe(42);
  expect(tasks.importingOpencodeIds()).toEqual([task.id]);

  tasks.update(task.id, { title: "renamed" });
  const row = db.query<{ j: string | null; c: string | null }, [string]>(
    `SELECT imported_opencode AS j, imported_opencode_session_id AS c FROM tasks WHERE id = ?`,
  ).get(task.id)!;
  expect(JSON.parse(row.j!)).toEqual(importedValue());
  expect(row.c).toBe("ses_abc123");

  // A status change on the same task's own claim never conflicts.
  expect(tasks.setImportedOpencode(task.id, importedValue({ status: "ready" }))!.importedOpencode!.status).toBe("ready");
  expect(tasks.importingOpencodeIds()).toEqual([]);
  // A fresh task has no provenance.
  expect(tasks.insert(makeTaskRow()).importedOpencode).toBeNull();
});

test("a second claim of the same OpenCode session id throws ImportedOpencodeSessionTaken; claim:false writes the JSON only", () => {
  const first = tasks.insert(makeTaskRow());
  const second = tasks.insert(makeTaskRow());
  tasks.setImportedOpencode(first.id, importedValue());

  let caught: unknown;
  try {
    tasks.setImportedOpencode(second.id, importedValue());
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ImportedOpencodeSessionTaken);
  expect((caught as InstanceType<typeof ImportedOpencodeSessionTaken>).sessionId).toBe("ses_abc123");
  expect(tasks.get(second.id)!.importedOpencode).toBeNull();

  const failed = tasks.setImportedOpencode(
    second.id, importedValue({ status: "failed", error: "already imported" }), { claim: false },
  )!;
  expect(failed.importedOpencode!.status).toBe("failed");
  expect(db.query<{ c: string | null }, [string]>(`SELECT imported_opencode_session_id AS c FROM tasks WHERE id = ?`).get(second.id)!.c).toBeNull();

  expect(tasks.findTaskByImportedOpencodeSession("ses_abc123")?.id).toBe(first.id);
  expect(tasks.findTaskByImportedOpencodeSession("ses_other")).toBeNull();
  expect(tasks.findTaskByImportedOpencodeSession("")).toBeNull();
  expect(tasks.importedOpencodeSessionHeldElsewhere(second.id, "ses_abc123")).toBe(true);
  expect(tasks.importedOpencodeSessionHeldElsewhere(first.id, "ses_abc123")).toBe(false);
  expect(tasks.importedOpencodeSessionIds()).toEqual(new Set(["ses_abc123"]));

  // Clearing releases the claim, so another task can take it.
  tasks.setImportedOpencode(first.id, null);
  expect(tasks.get(first.id)!.importedOpencode).toBeNull();
  expect(tasks.setImportedOpencode(second.id, importedValue())!.importedOpencode!.sessionId).toBe("ses_abc123");
});

test("a malformed imported_opencode blob reads as null and never throws", () => {
  const task = tasks.insert(makeTaskRow());
  for (const bad of ["{not json", JSON.stringify({ sessionId: "ses_x" }), JSON.stringify(importedValue({ status: "weird" as never }))]) {
    db.run(`UPDATE tasks SET imported_opencode = ? WHERE id = ?`, [bad, task.id]);
    expect(tasks.get(task.id)!.importedOpencode).toBeNull();
    expect(tasks.importingOpencodeIds()).toEqual([]);
  }
});

test("Claude and OpenCode claims are independent columns", () => {
  const task = tasks.insert(makeTaskRow());
  tasks.setImportedOpencode(task.id, importedValue({ sessionId: "ses_shared_name" }));
  expect(tasks.importedClaudeSessionIds().has("ses_shared_name")).toBe(false);
  expect(tasks.get(task.id)!.importedClaude).toBeNull();
});

// ---------------------------------------------------------------------------
// runs.opencode_session_id
// ---------------------------------------------------------------------------

test("runs round-trip opencodeSessionId through insert, update and toRun", () => {
  const task = tasks.insert(makeTaskRow());
  const inserted = runs.insert(makeRun(task.id, { opencodeSessionId: "ses_run1" }));
  expect(inserted.opencodeSessionId).toBe("ses_run1");
  expect(runs.get(inserted.id)!.opencodeSessionId).toBe("ses_run1");
  expect(runs.listForTask(task.id)[0]!.opencodeSessionId).toBe("ses_run1");

  const bare = runs.insert(makeRun(task.id));
  expect(runs.get(bare.id)!.opencodeSessionId).toBeNull();
  expect(runs.update(bare.id, { opencodeSessionId: "ses_run2" })!.opencodeSessionId).toBe("ses_run2");
  expect(runs.get(bare.id)!.opencodeSessionId).toBe("ses_run2");
  // An unrelated update keeps it.
  runs.update(bare.id, { status: "failed" });
  expect(runs.get(bare.id)!.opencodeSessionId).toBe("ses_run2");

  expect(runs.opencodeSessionIdsOwned()).toEqual(new Set(["ses_run1", "ses_run2"]));
  expect(runs.hasOpencodeSessionId("ses_run1")).toBe(true);
  expect(runs.hasOpencodeSessionId("ses_nope")).toBe(false);
  expect(runs.hasOpencodeSessionId("")).toBe(false);
});

test("hiddenOpencodeSessionIds is the union of run-owned ids and import claims", () => {
  const owner = tasks.insert(makeTaskRow());
  runs.insert(makeRun(owner.id, { opencodeSessionId: "ses_from_run" }));
  const claimer = tasks.insert(makeTaskRow());
  tasks.setImportedOpencode(claimer.id, importedValue({ sessionId: "ses_from_claim" }));
  expect(hiddenOpencodeSessionIds()).toEqual(new Set(["ses_from_run", "ses_from_claim"]));
});

test("runs.sessionIdsForTask lists one column's non-null ids newest first with each run's harness id", () => {
  const task = tasks.insert(makeTaskRow());
  const other = tasks.insert(makeTaskRow());
  runs.insert(makeRun(task.id, { startedAt: 100, agent: "opencode", opencodeSessionId: "ses_old" }));
  runs.insert(makeRun(task.id, { startedAt: 300, agent: "opencode-2" as Run["agent"], opencodeSessionId: "ses_new" }));
  runs.insert(makeRun(task.id, { startedAt: 200, agent: "opencode", opencodeSessionId: "ses_mid" }));
  runs.insert(makeRun(task.id, { startedAt: 400, agent: "opencode" })); // no session id — skipped
  runs.insert(makeRun(task.id, { startedAt: 500, agent: "codex", codexSessionId: "thread-1" }));
  runs.insert(makeRun(other.id, { startedAt: 999, opencodeSessionId: "ses_other_task" }));

  expect(runs.sessionIdsForTask(task.id, "opencode_session_id")).toEqual([
    { sessionId: "ses_new", agent: "opencode-2" },
    { sessionId: "ses_mid", agent: "opencode" },
    { sessionId: "ses_old", agent: "opencode" },
  ]);
  expect(runs.sessionIdsForTask(task.id, "codex_session_id")).toEqual([{ sessionId: "thread-1", agent: "codex" }]);
  expect(runs.sessionIdsForTask(task.id, "fx_session_id")).toEqual([]);
  // Every whitelisted column is queryable.
  for (const column of SESSION_ID_COLUMNS) expect(Array.isArray(runs.sessionIdsForTask(task.id, column))).toBe(true);
});

test("runs.sessionIdsForTask refuses a column outside the whitelist instead of interpolating it", () => {
  const task = tasks.insert(makeTaskRow());
  expect(() => runs.sessionIdsForTask(task.id, "id; DROP TABLE runs" as never)).toThrow(/unknown session id column/);
  expect(() => runs.sessionIdsForTask(task.id, "tmux_session" as never)).toThrow(/unknown session id column/);
  expect(db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'runs'`).get()!.n).toBe(1);
});

// ---------------------------------------------------------------------------
// harnessAutoEnabled
// ---------------------------------------------------------------------------

test("harnessAutoEnabled records once, lists pending notices oldest first, and marks them notified", () => {
  expect(harnessAutoEnabled.has("codex")).toBe(false);
  expect(harnessAutoEnabled.pending()).toEqual([]);

  harnessAutoEnabled.record("opencode", 20);
  harnessAutoEnabled.record("codex", 10);
  expect(harnessAutoEnabled.has("codex")).toBe(true);
  expect(harnessAutoEnabled.has("opencode")).toBe(true);
  expect(harnessAutoEnabled.pending()).toEqual(["codex", "opencode"]);

  harnessAutoEnabled.markNotified(["codex"]);
  expect(harnessAutoEnabled.pending()).toEqual(["opencode"]);

  // A repeat record keeps the first enabled_at and never resets notified.
  harnessAutoEnabled.record("codex", 99);
  expect(harnessAutoEnabled.all()).toEqual([
    { harnessId: "codex", enabledAt: 10, notified: true },
    { harnessId: "opencode", enabledAt: 20, notified: false },
  ]);

  harnessAutoEnabled.markNotified([]);
  harnessAutoEnabled.markNotified(["opencode", "unknown-id"]);
  expect(harnessAutoEnabled.pending()).toEqual([]);
});

test("harnessAutoEnabled rows survive deleting the harness (no FK)", () => {
  db.run(`INSERT INTO harnesses (id, kind, label, created_at, updated_at) VALUES ('opencode-tmp', 'opencode', 'tmp', 1, 1)`);
  harnessAutoEnabled.record("opencode-tmp", 5);
  db.run(`DELETE FROM harnesses WHERE id = 'opencode-tmp'`);
  expect(harnessAutoEnabled.has("opencode-tmp")).toBe(true);
});

// ---------------------------------------------------------------------------
// OpenCode server driver queries (fix round 3; migration 082)
// ---------------------------------------------------------------------------

function planOf(sql: string, ...params: (string | number | null)[]): string[] {
  return db.query<{ detail: string }, (string | number | null)[]>(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail);
}

test("runs.lastOpencodeSessionRunPerTask: live tasks only by default; archivedSinceMs adds recently archived ones flagged archived", () => {
  const live = tasks.insert(makeTaskRow());
  const archivedNew = tasks.insert(makeTaskRow());
  const archivedOld = tasks.insert(makeTaskRow());
  const noSession = tasks.insert(makeTaskRow());
  const lastLacksSession = tasks.insert(makeTaskRow());
  const t = 1_800_000_000_000;
  runs.insert(makeRun(live.id, { startedAt: t, opencodeSessionId: "ses_old" }));
  const liveLast = runs.insert(makeRun(live.id, { startedAt: t + 10, opencodeSessionId: "ses_live" }));
  const newLast = runs.insert(makeRun(archivedNew.id, { startedAt: t, opencodeSessionId: "ses_new", agent: "opencode-2" }));
  runs.insert(makeRun(archivedOld.id, { startedAt: t, opencodeSessionId: "ses_gone" }));
  runs.insert(makeRun(noSession.id, { startedAt: t }));
  runs.insert(makeRun(lastLacksSession.id, { startedAt: t, opencodeSessionId: "ses_before" }));
  runs.insert(makeRun(lastLacksSession.id, { startedAt: t + 5, agent: "codex" }));
  db.run(`UPDATE tasks SET archived_at = ? WHERE id = ?`, [t + 1000, archivedNew.id]);
  db.run(`UPDATE tasks SET archived_at = ? WHERE id = ?`, [t - 1000, archivedOld.id]);

  const byTask = (rows: ReturnType<typeof runs.lastOpencodeSessionRunPerTask>) =>
    Object.fromEntries(rows.map((r) => [r.taskId, r]));

  const plain = byTask(runs.lastOpencodeSessionRunPerTask());
  expect(Object.keys(plain)).toEqual([live.id]);
  expect(plain[live.id]).toEqual({ runId: liveLast.id, taskId: live.id, agent: "opencode", sessionId: "ses_live", archived: false });

  const since = byTask(runs.lastOpencodeSessionRunPerTask({ archivedSinceMs: t + 1000 })); // "at or after"
  expect(Object.keys(since).sort()).toEqual([live.id, archivedNew.id].sort());
  expect(since[live.id]!.archived).toBe(false);
  expect(since[archivedNew.id]).toEqual({ runId: newLast.id, taskId: archivedNew.id, agent: "opencode-2", sessionId: "ses_new", archived: true });

  const wider = byTask(runs.lastOpencodeSessionRunPerTask({ archivedSinceMs: 0 }));
  expect(Object.keys(wider).sort()).toEqual([live.id, archivedNew.id, archivedOld.id].sort());
  expect(Object.keys(byTask(runs.lastOpencodeSessionRunPerTask({ archivedSinceMs: t + 1001 })))).toEqual([live.id]);
  // A deleted task has no runs, so it is never listed.
  tasks.delete(live.id);
  expect(byTask(runs.lastOpencodeSessionRunPerTask({ archivedSinceMs: 0 }))[live.id]).toBeUndefined();
});

test("runs.lastOpencodeSessionRunPerTask keeps its task set on the pinned partial session-id index", () => {
  const seen: string[] = [];
  const realQuery = db.query;
  // Capture the statement the method prepares, then plan it.
  (db as unknown as { query: typeof db.query }).query = function (this: typeof db, sql: string) {
    if (sql.includes("runs_opencode_session_id_idx")) seen.push(sql);
    return realQuery.call(this, sql);
  } as typeof db.query;
  try {
    runs.lastOpencodeSessionRunPerTask({ archivedSinceMs: 1 });
  } finally {
    (db as unknown as { query: typeof db.query }).query = realQuery;
  }
  expect(seen).toHaveLength(1);
  const plans = seen.map((sql) => planOf(sql, 1));
  expect(plans[0]!.some((d) => d.includes("USING COVERING INDEX runs_opencode_session_id_idx") || d.includes("USING INDEX runs_opencode_session_id_idx"))).toBe(true);
  expect(plans[0]!.some((d) => /^SCAN (runs|r)\b(?!.*INDEX)/.test(d))).toBe(false);
});

test("runs.latestForTask returns the newest run (later insert on a tie), or null", () => {
  const task = tasks.insert(makeTaskRow());
  expect(runs.latestForTask(task.id)).toBeNull();
  const t = 1_800_000_000_000;
  runs.insert(makeRun(task.id, { startedAt: t }));
  const newest = runs.insert(makeRun(task.id, { startedAt: t + 50, opencodeSessionId: "ses_x" }));
  runs.insert(makeRun(task.id, { startedAt: t + 10 }));
  expect(runs.latestForTask(task.id)).toEqual(runs.get(newest.id));
  expect(runs.latestForTask(task.id)!.id).toBe(runs.listForTask(task.id)[0]!.id);
  const tie = runs.insert(makeRun(task.id, { startedAt: t + 50 }));
  expect(runs.latestForTask(task.id)!.id).toBe(tie.id);
  expect(runs.latestForTask("no-such-task")).toBeNull();
  expect(planOf(`SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`, task.id).join(" | ")).toContain("idx_runs_task");
});

test("subagents.opencodeOrphanedTaskIdsSince and settledOpencodeChildSessionIds SEARCH idx_subagents_opencode_status", async () => {
  const { subagents } = await import("./db.ts");
  const task = tasks.insert(makeTaskRow());
  const other = tasks.insert(makeTaskRow());
  const run = runs.insert(makeRun(task.id));
  const t = 1_800_000_000_000;
  const add = (taskId: string, child: string, status: string, endedAt: number | null, kind = "opencode_subagent") =>
    subagents.insertIfAbsent({
      id: `opencode-${child}`, taskId, runId: taskId === task.id ? run.id : null, parentKind: kind as "opencode_subagent",
      agentType: null, description: null, spawnDepth: 1, sourcePath: `opencode-session:${child}`, toolUseId: null,
      status: status as "running", startedAt: t, endedAt,
    });
  add(task.id, "ses_run", "running", null);
  add(task.id, "ses_orph_new", "orphaned", t + 100);
  add(task.id, "ses_orph_old", "orphaned", t - 100);
  add(task.id, "ses_done", "completed", t);
  add(task.id, "ses_fail", "failed", t);
  add(task.id, "ses_cancel", "cancelled", t);
  add(task.id, "ses_claude", "completed", t, "subagent");
  add(other.id, "ses_other", "orphaned", t + 100);

  expect(subagents.opencodeOrphanedTaskIdsSince(t).sort()).toEqual([task.id, other.id].sort());
  expect(subagents.opencodeOrphanedTaskIdsSince(t + 101)).toEqual([]);
  expect(subagents.settledOpencodeChildSessionIds(task.id, t).sort()).toEqual(["ses_cancel", "ses_done", "ses_fail", "ses_orph_old"]);
  expect(subagents.settledOpencodeChildSessionIds(task.id, t + 101).sort()).toEqual(["ses_cancel", "ses_done", "ses_fail", "ses_orph_new", "ses_orph_old"]);
  expect(subagents.settledOpencodeChildSessionIds(other.id, t)).toEqual([]);

  const orphanedPlan = planOf(
    `SELECT DISTINCT task_id FROM subagents
      WHERE status = 'orphaned' AND parent_kind = 'opencode_subagent' AND COALESCE(ended_at, started_at) >= ?`,
    t,
  );
  // Unpinned, the planner picks the 082 index on its own; the method pins it anyway.
  expect(orphanedPlan.join(" | ")).toContain("SEARCH subagents USING INDEX idx_subagents_opencode_status (status=?)");
  expect(orphanedPlan.some((d) => /^SCAN subagents/.test(d))).toBe(false);
  const settledPlan = planOf(
    `SELECT source_path FROM subagents INDEXED BY idx_subagents_opencode_status
      WHERE status IN ('completed', 'failed', 'cancelled', 'orphaned') AND task_id = ?1 AND parent_kind = 'opencode_subagent'
        AND (status != 'orphaned' OR COALESCE(ended_at, started_at) < ?2)`,
    task.id, t,
  );
  expect(settledPlan.join(" | ")).toContain("SEARCH subagents USING INDEX idx_subagents_opencode_status (status=? AND task_id=?)");
});

test("opencodeStoppedChildren notes by primary key, refreshes on re-note and prunes through its time index", async () => {
  const { opencodeStoppedChildren } = await import("./db.ts");
  db.run(`DELETE FROM opencode_stopped_children`);
  opencodeStoppedChildren.note("ses_a", "task-1", 100, 0);
  opencodeStoppedChildren.note("ses_b", "task-1", 200, 0);
  expect(opencodeStoppedChildren.stoppedAt("ses_a")).toBe(100);
  opencodeStoppedChildren.note("ses_a", "task-2", 300, 0);
  expect(db.query<{ task_id: string; stopped_at: number }, []>(`SELECT task_id, stopped_at FROM opencode_stopped_children WHERE child_session_id = 'ses_a'`).get())
    .toEqual({ task_id: "task-2", stopped_at: 300 });
  opencodeStoppedChildren.note("ses_c", "task-1", 400, 250); // prunes ses_b (200 < 250)
  expect(opencodeStoppedChildren.stoppedAt("ses_b")).toBeNull();
  expect(opencodeStoppedChildren.stoppedAt("ses_a")).toBe(300);
  expect(opencodeStoppedChildren.stoppedAt("ses_none")).toBeNull();
  expect(planOf(`SELECT stopped_at FROM opencode_stopped_children WHERE child_session_id = ?`, "x").join(" | ")).toContain("USING INDEX sqlite_autoindex_opencode_stopped_children_1");
  expect(planOf(`DELETE FROM opencode_stopped_children WHERE stopped_at < ?`, 1).join(" | ")).toContain("opencode_stopped_children_at_idx");
});
