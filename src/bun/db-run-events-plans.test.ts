/**
 * Query-plan guard for every statement the db layer runs against `run_events`
 * (docs/plans/non-blocking-session-restore.md, TT1).
 *
 * `run_events` is the largest table in a long-lived database (multi-GB, 76 %
 * of it `tool_result` payloads), and it runs on the Bun main thread: one
 * accidental `SCAN run_events` blocks every request for a second or more. That
 * is exactly how `seenLineUuidsForSubagent` once cost ~105 s for a 96-subagent
 * task. This file makes that class of regression a red test instead of a
 * production stall:
 *
 *   1. Every method on every exported db module whose source mentions
 *      `run_events` (or the `TOOL_RESULT_TRIM_SQL` constant) is DISCOVERED by
 *      `Function.prototype.toString()` and must be invoked here with
 *      representative args and must have run at least one statement — so a
 *      newly added `run_events` method can't escape the guard (the coverage
 *      test fails naming it).
 *   2. Every captured statement that references `run_events` (plus the
 *      exported `TOOL_RESULT_TRIM_SQL` / `RETENTION_SQL` constants) is run
 *      through `EXPLAIN QUERY PLAN`; no plan row may be a `SCAN` of
 *      `run_events` (or of the alias the statement gives it).
 *   3. `idx_run_events_user_history` (migration 039) was built for exactly two
 *      queries — `lastUserEventId` and `userMessageHistory` — and is a trap
 *      for everything else (it indexes `stream` only, not `run_id`, so it walks
 *      every task's rows). No other statement may plan through it.
 *
 * Inline `run_events` SQL that lives outside db.ts is reported at the bottom
 * (`INLINE_SQL_OUTSIDE_DB`).
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.ts";

// db.ts opens (and migrates) its sqlite file on first import and `bun test`
// runs every file in ONE process, so whichever file imports it first wins the
// data dir. Set ours at the top level (same as the sibling db-*.test.ts files)
// and tolerate an already-open db: every row below carries a fresh uuid and is
// removed in afterAll, nothing assumes an empty table.
process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-run-events-plans-"));

type DbModule = typeof import("./db.ts");
let dbm: DbModule;
let retentionSql: readonly string[];

/** `module.method` names that mention `run_events` / `TOOL_RESULT_TRIM_SQL`. */
let discovered: string[] = [];
/** method name → statements captured while it ran (all invocations). */
const capturedByMethod = new Map<string, Set<string>>();
/** Method names the harness invoked at least once. */
const invoked = new Set<string>();

const API_ERROR_PREFIX = "claude api error: ";
const TAIL_EVENTS = 40;

// Rows this file inserted, for cleanup.
const seededTaskIds: string[] = [];
const seededRunIds: string[] = [];

function makeTaskRow(taskId: string): Task {
  return {
    id: taskId,
    title: "plan-guard",
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
    fast: false,
    maxMode: false,
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

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

/** `sql` with every single-quoted string literal blanked, so `?`, `:name` and
 *  table names inside literals (`'%"name":"TodoWrite"%'`, `ESCAPE '\\'`) don't
 *  confuse the placeholder counter or the alias detector. */
function stripStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

const NOT_AN_ALIAS = new Set([
  "WHERE", "JOIN", "INNER", "LEFT", "RIGHT", "CROSS", "NATURAL", "ON", "USING", "ORDER",
  "GROUP", "LIMIT", "UNION", "SET", "VALUES", "INDEXED", "NOT", "HAVING", "AND", "OR",
]);

/** Every name the statement gives `run_events` — the table itself plus any
 *  alias (`FROM run_events e`, `JOIN run_events AS e`). A plan row says
 *  `SCAN e`, not `SCAN run_events`, when an alias is in play. */
function runEventsNames(sql: string): string[] {
  const stripped = stripStringLiterals(sql);
  const names = new Set<string>(["run_events"]);
  const re = /\b(?:FROM|JOIN|INTO|UPDATE)\s+run_events\b(?:\s+INDEXED\s+BY\s+\w+)?(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi;
  for (let m = re.exec(stripped); m; m = re.exec(stripped)) {
    const alias = m[1];
    if (alias && !NOT_AN_ALIAS.has(alias.toUpperCase())) names.add(alias);
  }
  return [...names];
}

/** Dummy bind values for `sql`: an array for positional `?` placeholders, an
 *  object for named ones. Plan shape never depends on the bound values. */
function dummyBindings(sql: string): unknown[] | Record<string, unknown> {
  const stripped = stripStringLiterals(sql);
  const named = [...stripped.matchAll(/[:@$]([A-Za-z_]\w*)/g)].map((m) => m[0]);
  if (named.length > 0) return Object.fromEntries(named.map((n) => [n, 1]));
  const count = (stripped.match(/\?/g) ?? []).length;
  return Array.from({ length: count }, () => 1);
}

type PlanRow = { id: number; parent: number; notused: number; detail: string };

/** `EXPLAIN QUERY PLAN` of `sql`. Uses an uncached `prepare` + `finalize`,
 *  never `db.query`: bun:sqlite caches `query()` statements un-finalized, and
 *  an EXPLAIN of an UPDATE/INSERT left in that cache keeps counting as an
 *  active WRITER on the shared connection even after `.all()` — every later
 *  `COMMIT` in the same `bun test` process then fails with "cannot commit
 *  transaction - SQL statements in progress" (it broke
 *  orchestrator-cursor-plan.test.ts in a full run). */
function explain(sql: string): string[] {
  const bindings = dummyBindings(sql);
  const stmt = dbm.db.prepare<PlanRow, any>(`EXPLAIN QUERY PLAN ${sql}`);
  try {
    const rows = Array.isArray(bindings) ? stmt.all(...bindings) : stmt.all(bindings);
    return rows.map((r) => r.detail);
  } finally {
    stmt.finalize();
  }
}

/** Whether a plan detail line is a full SCAN of `run_events` (or its alias). */
function isRunEventsScan(detail: string, names: string[]): boolean {
  return names.some((n) => new RegExp(`^SCAN ${n}(\\s|$)`).test(detail));
}

/** The user-history index is legitimate for exactly these two methods
 *  (migration 039 built `idx_run_events_user_history` for them: they filter
 *  `stream = 'user'` over the partial `subagent_id IS NULL` set and the index
 *  is the only one that serves a stream-first predicate). */
const USER_HISTORY_INDEX_ALLOWED = new Set(["runs.lastUserEventId", "runs.userMessageHistory"]);

// ---------------------------------------------------------------------------
// Seeding + the per-method invocation table
// ---------------------------------------------------------------------------

type Seed = {
  taskId: string;
  runId: string;
  subagentId: string;
  firstEventId: number;
  lastEventId: number;
  midEventId: number;
};

function seed(): Seed {
  const { tasks, runs, db } = dbm;
  const taskId = randomUUID();
  const runId = randomUUID();
  const subagentId = `sub-${randomUUID().slice(0, 8)}`;
  seededTaskIds.push(taskId);
  seededRunIds.push(runId);
  tasks.insert(makeTaskRow(taskId));
  const now = Date.now();
  runs.insert({
    id: runId, taskId, agent: "claude-code", status: "succeeded",
    startedAt: now, endedAt: now + 1, exitCode: 0,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null,
    geminiSessionId: null, fxSessionId: null,
  });
  const ids: number[] = [];
  db.transaction(() => {
    // The user message comes FIRST so an anchored window (limit < events) has
    // to look past its default floor and exercise the "below" read.
    ids.push(runs.appendEvent(runId, "user", "plan-guard first user message", "u-0")!);
    for (let i = 0; i < TAIL_EVENTS; i++) {
      ids.push(runs.appendEvent(runId, "assistant", `assistant ${i}`, `a-${i}`)!);
      if (i % 5 === 0) {
        ids.push(runs.appendEvent(runId, "tool_use", JSON.stringify({ id: `toolu_${i}`, name: "TaskCreate", input: {} }), `tu-${i}`)!);
        ids.push(runs.appendEvent(runId, "tool_result", JSON.stringify({ toolUseId: `toolu_${i}`, content: `Task #${i} created successfully` }), `tr-${i}`)!);
      }
    }
    ids.push(runs.appendEvent(runId, "status", `${API_ERROR_PREFIX}overloaded`)!);
    ids.push(runs.appendEvent(runId, "assistant", "subagent line", `sa-0`, subagentId)!);
    ids.push(runs.appendEvent(runId, "status", "monitor:x:terminal:done", "monitor:x:terminal:0", subagentId)!);
  })();
  return {
    taskId,
    runId,
    subagentId,
    firstEventId: ids[0]!,
    lastEventId: ids[ids.length - 1]!,
    midEventId: ids[Math.floor(ids.length / 2)]!,
  };
}

type Invocation = { label: string; run: () => unknown };

/** Representative calls per `module.method`. A discovered method with no entry
 *  here fails the coverage test — add its calls when you add the method. */
function invocationTable(s: Seed): Record<string, Invocation[]> {
  const { runs } = dbm;
  const anchor = { maxEvents: 3000, maxBytes: 16 * 1024 * 1024 };
  return {
    "runs.events": [{ label: "events(runId)", run: () => runs.events(s.runId) }],
    "runs.lastEventData": [{ label: "lastEventData(runId)", run: () => runs.lastEventData(s.runId) }],
    "runs.lastToolUseData": [{ label: "lastToolUseData(runId)", run: () => runs.lastToolUseData(s.runId) }],
    "runs.findToolUseEvent": [
      { label: "findToolUseEvent(runId, id)", run: () => runs.findToolUseEvent(s.runId, "toolu_0") },
    ],
    "runs.eventsForTask": [
      { label: "eventsForTask(taskId) — no limit", run: () => runs.eventsForTask(s.taskId) },
      { label: "eventsForTask {limit}", run: () => runs.eventsForTask(s.taskId, { limit: 10 }) },
      {
        label: "eventsForTask {limit, beforeId}",
        run: () => runs.eventsForTask(s.taskId, { limit: 10, beforeId: s.lastEventId }),
      },
      {
        label: "eventsForTask {limit, maxBytes, minEvents}",
        run: () => runs.eventsForTask(s.taskId, { limit: 20, maxBytes: 200, minEvents: 3 }),
      },
      {
        label: "eventsForTask {limit, anchor}",
        run: () => runs.eventsForTask(s.taskId, { limit: 5, anchor }),
      },
      {
        label: "eventsForTask {limit, beforeId, maxBytes, anchor}",
        run: () =>
          runs.eventsForTask(s.taskId, {
            limit: 5,
            beforeId: s.lastEventId,
            maxBytes: 4096,
            minEvents: 2,
            anchor,
          }),
      },
    ],
    "runs.userMessageHistory": [{ label: "userMessageHistory(limit)", run: () => runs.userMessageHistory(20) }],
    "runs.todoRelevantEventsForTask": [
      { label: "todoRelevantEventsForTask(taskId)", run: () => runs.todoRelevantEventsForTask(s.taskId) },
    ],
    "runs.hasEventsBefore": [
      { label: "hasEventsBefore(taskId, id)", run: () => runs.hasEventsBefore(s.taskId, s.lastEventId) },
    ],
    "runs.lastUserEventId": [
      { label: "lastUserEventId(taskId)", run: () => runs.lastUserEventId(s.taskId) },
      { label: "lastUserEventId(taskId, beforeId)", run: () => runs.lastUserEventId(s.taskId, s.lastEventId) },
    ],
    "runs.appendEvent": [
      {
        label: "appendEvent without a dedup key",
        run: () => runs.appendEvent(s.runId, "status", "plan-guard append"),
      },
      {
        label: "appendEvent with a dedup key + subagent",
        run: () => runs.appendEvent(s.runId, "assistant", "plan-guard append", `pg-${randomUUID()}`, s.subagentId),
      },
    ],
    "runs.seenLineUuidsForTask": [
      { label: "seenLineUuidsForTask(taskId)", run: () => runs.seenLineUuidsForTask(s.taskId) },
    ],
    "runs.seenLineUuidsForSubagent": [
      {
        label: "seenLineUuidsForSubagent(taskId, subagentId)",
        run: () => runs.seenLineUuidsForSubagent(s.taskId, s.subagentId),
      },
    ],
    "runs.hasLineUuidPrefixForSubagent": [
      {
        label: "hasLineUuidPrefixForSubagent(taskId, subagentId, prefix)",
        run: () => runs.hasLineUuidPrefixForSubagent(s.taskId, s.subagentId, "monitor:x:terminal:"),
      },
    ],
    "runs.hasPriorApiErrorStatus": [
      {
        label: "hasPriorApiErrorStatus(runId, prefix)",
        run: () => runs.hasPriorApiErrorStatus(s.runId, API_ERROR_PREFIX),
      },
    ],
    "runs.lastStatusDataWithPrefix": [
      {
        label: "lastStatusDataWithPrefix(runId, prefix)",
        run: () => runs.lastStatusDataWithPrefix(s.runId, "fx-recovery: "),
      },
    ],
    "runs.toolResultRowsForTrim": [
      {
        label: "toolResultRowsForTrim(runId, minBytes, afterId, limit)",
        run: () => runs.toolResultRowsForTrim(s.runId, 4096, 0, 200),
      },
    ],
    "runs.maxEventIdForRun": [{ label: "maxEventIdForRun(runId)", run: () => runs.maxEventIdForRun(s.runId) }],
    "runs.replaceEventData": [
      {
        // Rewrites one of the seeded rows we own through the real statement.
        label: "replaceEventData(id, data)",
        run: () => runs.replaceEventData(s.midEventId, "plan-guard replace"),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Capture harness
// ---------------------------------------------------------------------------

/** Innermost db method currently running. Statements are attributed to it, not
 *  to the outer harness call: `eventsForTask({anchor})` calls
 *  `runs.lastUserEventId` internally, and that statement legitimately uses the
 *  user-history index while the caller's own never may. */
let currentMethod: string | null = null;
const restoreFns: Array<() => void> = [];

function installCapture(): void {
  const raw = dbm.db as unknown as Record<string, unknown>;
  for (const fn of ["query", "prepare", "run"] as const) {
    const original = raw[fn] as ((sql: string, ...rest: unknown[]) => unknown) | undefined;
    if (typeof original !== "function") continue;
    raw[fn] = function (this: unknown, sql: string, ...rest: unknown[]) {
      if (currentMethod && typeof sql === "string") {
        let set = capturedByMethod.get(currentMethod);
        if (!set) capturedByMethod.set(currentMethod, (set = new Set()));
        set.add(sql);
      }
      return original.call(this ?? dbm.db, sql, ...rest);
    };
    restoreFns.push(() => {
      raw[fn] = original;
    });
  }
}

/** Wrap every discovered method so nested calls through the module object
 *  (`runs.lastUserEventId(...)` inside `eventsForTask`) are attributed to the
 *  innermost method. Restored by `restoreFns`. */
function installMethodAttribution(methods: string[]): void {
  for (const full of methods) {
    const [modName, name] = full.split(".") as [string, string];
    const target = (dbm as unknown as Record<string, Record<string, unknown>>)[modName]!;
    const original = target[name] as (...args: unknown[]) => unknown;
    target[name] = function (this: unknown, ...args: unknown[]) {
      const outer = currentMethod;
      currentMethod = full;
      try {
        return original.apply(this, args);
      } finally {
        currentMethod = outer;
      }
    };
    restoreFns.push(() => {
      target[name] = original;
    });
  }
}

/** Methods (on any exported plain-object module of db.ts) whose source text
 *  mentions `run_events` or the trim-SQL constant. */
function discoverRunEventsMethods(mod: DbModule): string[] {
  const out: string[] = [];
  for (const [modName, value] of Object.entries(mod)) {
    if (value === null || typeof value !== "object") continue;
    for (const [name, fn] of Object.entries(value as Record<string, unknown>)) {
      if (typeof fn !== "function") continue;
      const src = Function.prototype.toString.call(fn);
      if (/run_events|TOOL_RESULT_TRIM_SQL/.test(src)) out.push(`${modName}.${name}`);
    }
  }
  return out.sort();
}

beforeAll(async () => {
  dbm = await import("./db.ts");
  ({ RETENTION_SQL: retentionSql } = await import("./retention.ts"));
  discovered = discoverRunEventsMethods(dbm);

  const s = seed();
  const table = invocationTable(s);
  installCapture();
  installMethodAttribution(discovered);
  try {
    for (const method of discovered) {
      const calls = table[method];
      if (!calls) continue; // reported by the coverage test, by name
      for (const call of calls) call.run();
      invoked.add(method);
    }
  } finally {
    currentMethod = null;
    for (const restore of restoreFns.splice(0).reverse()) restore();
  }
});

afterAll(() => {
  // Other test files share this process-wide db; leave nothing of ours behind.
  const { db } = dbm;
  for (const runId of seededRunIds) db.run(`DELETE FROM run_events WHERE run_id = ?`, [runId]);
  for (const runId of seededRunIds) db.run(`DELETE FROM runs WHERE id = ?`, [runId]);
  for (const taskId of seededTaskIds) db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("run_events query-plan guard", () => {
  test("discovery sees the known run_events methods (the sweep itself is not vacuous)", () => {
    // If the toString() sweep ever stops matching (minified build, renamed
    // table alias), this fails instead of the guard silently passing on zero.
    for (const known of [
      "runs.eventsForTask",
      "runs.seenLineUuidsForSubagent",
      "runs.hasLineUuidPrefixForSubagent",
      "runs.hasPriorApiErrorStatus",
      "runs.lastToolUseData",
      "runs.lastUserEventId",
      "runs.userMessageHistory",
      "runs.toolResultRowsForTrim",
      "runs.maxEventIdForRun",
      "runs.replaceEventData",
    ]) {
      expect(discovered, `${known} was not discovered`).toContain(known);
    }
  });

  test("every run_events method was invoked and ran at least one statement", () => {
    const uncovered = discovered.filter((m) => !invoked.has(m));
    expect(
      uncovered,
      `run_events method(s) with no representative invocation in invocationTable(): ${uncovered.join(", ")}`,
    ).toEqual([]);
    const silent = discovered.filter((m) => (capturedByMethod.get(m)?.size ?? 0) === 0);
    expect(
      silent,
      `run_events method(s) that ran but issued no captured statement (a cached prepared statement?): ${silent.join(", ")}`,
    ).toEqual([]);
  });

  test("the retention SQL constants are exported and non-empty", () => {
    expect(dbm.TOOL_RESULT_TRIM_SQL).toContain("run_events");
    expect(retentionSql.length).toBeGreaterThan(0);
    expect(retentionSql).toContain(dbm.TOOL_RESULT_TRIM_SQL);
  });

  test("no captured or exported run_events statement SCANs run_events or plans through the user-history index", () => {
    type Entry = { owner: string; sql: string };
    const entries: Entry[] = [];
    for (const [method, sqls] of capturedByMethod) {
      for (const sql of sqls) if (/run_events/.test(sql)) entries.push({ owner: method, sql });
    }
    entries.push({ owner: "TOOL_RESULT_TRIM_SQL (db.ts)", sql: dbm.TOOL_RESULT_TRIM_SQL });
    retentionSql.forEach((sql, i) => entries.push({ owner: `RETENTION_SQL[${i}] (retention.ts)`, sql }));

    expect(entries.length).toBeGreaterThan(10);
    const failures: string[] = [];
    for (const { owner, sql } of entries) {
      const names = runEventsNames(sql);
      let plan: string[];
      try {
        plan = explain(sql);
      } catch (err) {
        failures.push(`${owner}: EXPLAIN QUERY PLAN threw (${(err as Error).message}) for: ${sql.replace(/\s+/g, " ")}`);
        continue;
      }
      for (const detail of plan) {
        if (isRunEventsScan(detail, names)) {
          failures.push(`${owner}: full scan of run_events — "${detail}" in: ${sql.replace(/\s+/g, " ")}`);
        }
        if (detail.includes("idx_run_events_user_history") && !USER_HISTORY_INDEX_ALLOWED.has(owner)) {
          failures.push(
            `${owner}: plans run_events through idx_run_events_user_history (stream-first, walks every task's rows) — "${detail}". Add INDEXED BY idx_run_events_run or join through runs.`,
          );
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  test("the user-history index is still what the two allowed queries use (the allow-list is justified)", () => {
    for (const method of USER_HISTORY_INDEX_ALLOWED) {
      const sqls = [...(capturedByMethod.get(method) ?? [])].filter((q) => /run_events/.test(q));
      expect(sqls.length, `${method} captured no run_events statement`).toBeGreaterThan(0);
      const usesIt = sqls.some((sql) => explain(sql).some((d) => d.includes("idx_run_events_user_history")));
      // If this starts failing the index (or the allow-list entry) is dead
      // weight: prune the allow-list rather than loosening the guard above.
      expect(usesIt, `${method} no longer plans through idx_run_events_user_history`).toBe(true);
    }
  });

  function planOf(method: string): string[] {
    const sqls = [...(capturedByMethod.get(method) ?? [])].filter((q) => /run_events/.test(q));
    expect(sqls.length, `${method} captured no run_events statement`).toBeGreaterThan(0);
    return sqls.flatMap((sql) => explain(sql));
  }

  test("seenLineUuidsForSubagent / hasLineUuidPrefixForSubagent use the covering (run_id, IFNULL(subagent_id), line_uuid) index", () => {
    for (const method of ["runs.seenLineUuidsForSubagent", "runs.hasLineUuidPrefixForSubagent"]) {
      const plan = planOf(method);
      expect(
        plan.some((d) => d.includes("USING COVERING INDEX run_events_run_sub_line_uuid")),
        `${method}: expected USING COVERING INDEX run_events_run_sub_line_uuid, plan was:\n${plan.join("\n")}`,
      ).toBe(true);
      expect(
        plan.some((d) => /^SEARCH (e|run_events) /.test(d)),
        `${method}: run_events must be SEARCHed, plan was:\n${plan.join("\n")}`,
      ).toBe(true);
    }
  });

  test("lastToolUseData / hasPriorApiErrorStatus / lastStatusDataWithPrefix walk idx_run_events_run", () => {
    for (const method of ["runs.lastToolUseData", "runs.hasPriorApiErrorStatus", "runs.lastStatusDataWithPrefix"]) {
      const plan = planOf(method);
      expect(
        plan.some((d) => d.includes("idx_run_events_run")),
        `${method}: expected idx_run_events_run, plan was:\n${plan.join("\n")}`,
      ).toBe(true);
    }
  });

  test("the retention candidate query SEARCHes idx_run_events_run in id order with no temp b-tree sort", () => {
    const plan = explain(dbm.TOOL_RESULT_TRIM_SQL);
    expect(
      plan.some((d) => /^SEARCH run_events USING INDEX idx_run_events_run \(run_id=\? AND id>\?\)/.test(d)),
      `expected a SEARCH of idx_run_events_run on (run_id, id>?), plan was:\n${plan.join("\n")}`,
    ).toBe(true);
    expect(
      plan.filter((d) => d.includes("TEMP B-TREE")),
      "ORDER BY id must ride the index, not a temp b-tree",
    ).toEqual([]);
  });

  test("replaceEventData is a primary-key UPDATE", () => {
    const plan = planOf("runs.replaceEventData");
    expect(plan.some((d) => /SEARCH run_events USING INTEGER PRIMARY KEY/.test(d)), plan.join("\n")).toBe(true);
  });

  test("the alias detector understands aliased and INDEXED BY forms (the guard can't be dodged by renaming)", () => {
    expect(runEventsNames("SELECT 1 FROM run_events e JOIN runs r ON r.id = e.run_id")).toContain("e");
    expect(runEventsNames("SELECT 1 FROM runs r JOIN run_events AS ev ON ev.run_id = r.id")).toContain("ev");
    expect(runEventsNames("SELECT 1 FROM run_events INDEXED BY idx_run_events_run WHERE run_id = ?")).toEqual([
      "run_events",
    ]);
    expect(runEventsNames("SELECT 1 FROM run_events WHERE data = 'x'")).toEqual(["run_events"]);
    expect(isRunEventsScan("SCAN e USING INDEX foo", ["run_events", "e"])).toBe(true);
    expect(isRunEventsScan("SCAN run_events", ["run_events"])).toBe(true);
    expect(isRunEventsScan("SEARCH run_events USING INDEX idx_run_events_run (run_id=?)", ["run_events"])).toBe(false);
    expect(isRunEventsScan("SCAN runs", ["run_events"])).toBe(false);
  });

  test("a scan really would be caught: an unindexed predicate on run_events plans as SCAN", () => {
    // Negative control for the detector: `ts` has no index, so this MUST scan.
    const sql = `SELECT id FROM run_events WHERE ts = ?`;
    const plan = explain(sql);
    expect(plan.some((d) => isRunEventsScan(d, runEventsNames(sql)))).toBe(true);
  });
});

/**
 * `run_events` SQL outside db.ts escapes the toString() sweep above, so the
 * rule is that reads live in db.ts. The only statement left elsewhere is
 * `reconcileOrphans`' plain `INSERT INTO run_events …` (no read path, nothing
 * to plan); `latestResumableFxPause`'s sentinel read was lifted into
 * `runs.lastStatusDataWithPrefix`. This test keeps it that way.
 */
describe("run_events reads outside db.ts", () => {
  test("orchestrator.ts and retention.ts do not read run_events directly", async () => {
    const offenders: string[] = [];
    for (const file of ["orchestrator.ts", "retention.ts", "server.ts"]) {
      const src = await Bun.file(path.join(import.meta.dir, file)).text();
      const normalized = src.replace(/\s+/g, " ");
      if (/FROM run_events/i.test(normalized) || /JOIN run_events/i.test(normalized)) offenders.push(file);
    }
    expect(offenders, `move these run_events reads into db.ts: ${offenders.join(", ")}`).toEqual([]);
  });
});
