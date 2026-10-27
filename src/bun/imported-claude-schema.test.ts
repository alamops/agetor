import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ImportedClaudeSession, Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";
import { splitSqlStatements } from "./migrate.ts";
import m069 from "./migrations/069_imported_claude_session_unique.sql" with { type: "text" };
import m070 from "./migrations/070_imported_claude_session_backfill.sql" with { type: "text" };

// db.ts opens sqlite on first import. Set the data dir at module top, before
// the dynamic import below (same convention as db-fx-recovery.test.ts).
const dataDir = mkdtempSync(path.join(tmpdir(), "agetor-imported-claude-"));
process.env.AGETOR_DATA_DIR ??= dataDir;

let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;
let ImportedClaudeSessionTaken: typeof import("./db.ts").ImportedClaudeSessionTaken;

beforeAll(async () => {
  ({ db, tasks, runs, ImportedClaudeSessionTaken } = await import("./db.ts"));
});

afterAll(() => {
  rmTestDataDir(dataDir);
});

function makeTaskRow(taskId: string): Task {
  return {
    id: taskId,
    title: "t",
    prompt: "p",
    agent: "claude-code",
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
  };
}

function provenance(overrides: Partial<ImportedClaudeSession> = {}): ImportedClaudeSession {
  return {
    sessionId: "sess-1",
    gitBranch: "main",
    importedAt: 1_700_000_000_000,
    configDir: "/home/me/.claude",
    status: "importing",
    backfillOffset: 128,
    error: null,
    ...overrides,
  };
}

type PlanRow = { id: number; parent: number; notused: number; detail: string };

/** Uncached EXPLAIN — `db.query` leaves the statement open and later COMMITs
 *  in this process fail with "SQL statements in progress". */
function explain(sql: string): string[] {
  const stmt = db.prepare<PlanRow, []>(`EXPLAIN QUERY PLAN ${sql}`);
  try {
    return stmt.all().map((r) => r.detail);
  } finally {
    stmt.finalize();
  }
}

test("migration 068 adds tasks.imported_claude and the partial claude_session_id index", () => {
  const row = db
    .query<{ id: string }, [string]>(`SELECT id FROM _migrations WHERE id = ?`)
    .get("068_imported_claude_session");
  expect(row?.id).toBe("068_imported_claude_session");

  const columns = db.query<{ name: string }, []>(`PRAGMA table_info(tasks)`).all();
  expect(columns.some((c) => c.name === "imported_claude")).toBe(true);

  const idx = db
    .query<{ sql: string }, []>(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'runs_claude_session_id_idx'`,
    )
    .get();
  expect(idx?.sql).toContain("WHERE claude_session_id IS NOT NULL");
});

test("setImportedClaude round-trips and a generic tasks.update does not clear it", async () => {
  const taskId = randomUUID();
  const inserted = tasks.insert(makeTaskRow(taskId));
  expect(inserted.importedClaude).toBeNull();
  const before = inserted.updatedAt;
  try {
    await new Promise((r) => setTimeout(r, 5));
    const value = provenance();
    const written = tasks.setImportedClaude(taskId, value);
    expect(written?.importedClaude).toEqual(value);
    expect(written?.updatedAt).toBe(before);

    const updated = tasks.update(taskId, { title: "renamed" });
    expect(updated?.title).toBe("renamed");
    expect(updated?.importedClaude).toEqual(value);
    expect(tasks.get(taskId)?.importedClaude).toEqual(value);
    const claim = db
      .query<{ imported_claude_session_id: string | null }, [string]>(
        `SELECT imported_claude_session_id FROM tasks WHERE id = ?`,
      )
      .get(taskId);
    expect(claim?.imported_claude_session_id).toBe(value.sessionId);
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("bad imported_claude JSON reads back as null", () => {
  const taskId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  try {
    db.run(`UPDATE tasks SET imported_claude = ? WHERE id = ?`, ["{not json", taskId]);
    expect(() => tasks.get(taskId)).not.toThrow();
    expect(tasks.get(taskId)?.importedClaude).toBeNull();

    db.run(`UPDATE tasks SET imported_claude = ? WHERE id = ?`, [JSON.stringify({ sessionId: "x" }), taskId]);
    expect(tasks.get(taskId)?.importedClaude).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("seenLineUuidsForRun returns only that run's uuids", () => {
  const taskId = randomUUID();
  const runA = randomUUID();
  const runB = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  const now = Date.now();
  const base = {
    taskId,
    agent: "claude-code",
    status: "succeeded" as const,
    startedAt: now,
    endedAt: now,
    exitCode: 0,
    tmuxSession: null,
    claudeSessionId: "owned-sid",
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
  };
  try {
    runs.insert({ ...base, id: runA });
    runs.insert({ ...base, id: runB, claudeSessionId: "other-sid" });
    runs.appendEvent(runA, "assistant", "a", "uuid-a");
    runs.appendEvent(runB, "assistant", "b", "uuid-b");
    expect([...runs.seenLineUuidsForRun(runA)]).toEqual(["uuid-a"]);
    expect([...runs.seenLineUuidsForRun(runB)]).toEqual(["uuid-b"]);
    expect(runs.claudeSessionIds().has("owned-sid")).toBe(true);
    expect(runs.claudeSessionIds().has("other-sid")).toBe(true);
  } finally {
    db.run(`DELETE FROM run_events WHERE run_id IN (?, ?)`, [runA, runB]);
    db.run(`DELETE FROM runs WHERE id IN (?, ?)`, [runA, runB]);
    db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  }
});

test("EXPLAIN QUERY PLAN uses runs_claude_session_id_idx for claudeSessionIds", () => {
  const plan = explain(`SELECT claude_session_id FROM runs WHERE claude_session_id IS NOT NULL`);
  expect(plan.some((detail) => detail.includes("runs_claude_session_id_idx"))).toBe(true);
});

test("one imported session id binds one task, and runs may still share that id", () => {
  const row = db
    .query<{ id: string }, [string]>(`SELECT id FROM _migrations WHERE id = ?`)
    .get("069_imported_claude_session_unique");
  expect(row?.id).toBe("069_imported_claude_session_unique");

  const columns = db.query<{ name: string }, []>(`PRAGMA table_info(tasks)`).all();
  expect(columns.some((c) => c.name === "imported_claude_session_id")).toBe(true);

  const idx = db
    .query<{ sql: string }, []>(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'tasks_imported_claude_session_uidx'`,
    )
    .get();
  expect(idx?.sql).toContain("UNIQUE");
  expect(idx?.sql).toContain("imported_claude_session_id");
  expect(idx?.sql).toContain("WHERE imported_claude_session_id IS NOT NULL");

  const plan = explain(`SELECT id FROM tasks WHERE imported_claude_session_id = ?`);
  expect(plan.some((detail) => detail.includes("tasks_imported_claude_session_uidx"))).toBe(true);

  const taskA = randomUUID();
  const taskB = randomUUID();
  const loser = randomUUID();
  const runA = randomUUID();
  const runB = randomUUID();
  tasks.insert(makeTaskRow(taskA));
  tasks.insert(makeTaskRow(taskB));
  const now = Date.now();
  try {
    tasks.setImportedClaude(taskA, provenance({ sessionId: "claim-sid" }));
    expect(tasks.findByImportedSessionId("claim-sid")?.id).toBe(taskA);
    expect(() => tasks.setImportedClaude(taskB, provenance({ sessionId: "claim-sid" }))).toThrow(
      ImportedClaudeSessionTaken,
    );
    expect(tasks.get(taskB)?.importedClaude).toBeNull();
    const rewritten = tasks.setImportedClaude(taskA, provenance({ sessionId: "claim-sid", status: "ready" }));
    expect(rewritten?.importedClaude?.status).toBe("ready");

    const base = {
      taskId: taskA,
      agent: "claude-code",
      status: "succeeded" as const,
      startedAt: now,
      endedAt: now,
      exitCode: 0,
      tmuxSession: null,
      claudeSessionId: "claim-sid",
      codexSessionId: null,
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: null,
    };
    runs.insert({ ...base, id: runA });
    runs.insert({ ...base, id: runB });
    expect(runs.hasClaudeSessionId("claim-sid")).toBe(true);
    expect(runs.hasClaudeSessionId("missing-sid")).toBe(false);

    tasks.insert(makeTaskRow(loser));
    const failed = provenance({ sessionId: "claim-sid", status: "failed", error: "held" });
    expect(() => tasks.setImportedClaude(loser, failed, { claim: false })).not.toThrow();
    expect(tasks.get(loser)?.importedClaude).toEqual(failed);
    const loserClaim = db.query<{ imported_claude_session_id: string | null }, [string]>(
      `SELECT imported_claude_session_id FROM tasks WHERE id = ?`,
    ).get(loser);
    expect(loserClaim?.imported_claude_session_id).toBeNull();
    expect(tasks.findByImportedSessionId("claim-sid")?.id).toBe(taskA);
  } finally {
    db.run(`DELETE FROM runs WHERE id IN (?, ?)`, [runA, runB]);
    db.run(`DELETE FROM tasks WHERE id IN (?, ?, ?)`, [taskA, taskB, loser]);
  }
});

function backfillUpdate(sql: string): string {
  const stmt = splitSqlStatements(sql).find((s) => s.includes("SET imported_claude_session_id"));
  const at = stmt?.indexOf("UPDATE tasks") ?? -1;
  if (!stmt || at < 0) throw new Error("backfill UPDATE missing");
  return stmt.slice(at);
}

test("069 and 070 copy the same session-claim backfill", () => {
  const row = db
    .query<{ id: string }, [string]>(`SELECT id FROM _migrations WHERE id = ?`)
    .get("070_imported_claude_session_backfill");
  expect(row?.id).toBe("070_imported_claude_session_backfill");
  expect(backfillUpdate(m069)).toBe(backfillUpdate(m070));
});

test("session-claim backfill copies valid provenance and skips bad or duplicate rows", () => {
  const earlier = randomUUID();
  const later = randomUUID();
  const malformed = randomUUID();
  const nonString = randomUUID();
  const held = randomUUID();
  const duplicateOfHeld = randomUUID();
  for (const id of [earlier, later, malformed, nonString, held, duplicateOfHeld]) {
    tasks.insert(makeTaskRow(id));
  }
  const valid = JSON.stringify(provenance({ sessionId: "backfill-sid" }));
  const heldValue = provenance({ sessionId: "kept-sid" });
  try {
    tasks.setImportedClaude(held, heldValue);
    db.run(
      `UPDATE tasks SET imported_claude = ?, imported_claude_session_id = NULL, created_at = ? WHERE id = ?`,
      [valid, 10, earlier],
    );
    db.run(
      `UPDATE tasks SET imported_claude = ?, imported_claude_session_id = NULL, created_at = ? WHERE id = ?`,
      [valid, 20, later],
    );
    db.run(
      `UPDATE tasks SET imported_claude = ?, imported_claude_session_id = NULL WHERE id = ?`,
      ["{not json", malformed],
    );
    db.run(
      `UPDATE tasks SET imported_claude = ?, imported_claude_session_id = NULL WHERE id = ?`,
      [JSON.stringify({ sessionId: 12 }), nonString],
    );
    db.run(
      `UPDATE tasks SET imported_claude = ?, imported_claude_session_id = NULL WHERE id = ?`,
      [JSON.stringify(heldValue), duplicateOfHeld],
    );

    expect(() => db.run(backfillUpdate(m070))).not.toThrow();

    expect(tasks.findByImportedSessionId("backfill-sid")?.id).toBe(earlier);
    const laterClaim = db
      .query<{ imported_claude_session_id: string | null }, [string]>(
        `SELECT imported_claude_session_id FROM tasks WHERE id = ?`,
      )
      .get(later);
    expect(laterClaim?.imported_claude_session_id).toBeNull();
    expect(tasks.get(malformed)?.importedClaude).toBeNull();
    expect(tasks.get(nonString)?.importedClaude).toBeNull();
    expect(tasks.findByImportedSessionId("kept-sid")?.id).toBe(held);
    const stolen = db
      .query<{ imported_claude_session_id: string | null }, [string]>(
        `SELECT imported_claude_session_id FROM tasks WHERE id = ?`,
      )
      .get(duplicateOfHeld);
    expect(stolen?.imported_claude_session_id).toBeNull();
  } finally {
    db.run(`DELETE FROM tasks WHERE id IN (?, ?, ?, ?, ?, ?)`, [
      earlier, later, malformed, nonString, held, duplicateOfHeld,
    ]);
  }
});
