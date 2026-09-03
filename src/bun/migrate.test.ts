import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, splitSqlStatements, type Migration } from "./migrate.ts";
import reseedBuiltins from "./migrations/024_reseed_harness_builtins.sql" with { type: "text" };
import retireGemini3ProPreview from "./migrations/049_retire_gemini_3_pro_preview.sql" with { type: "text" };
import { migrations } from "./migrations/index.ts";

// Minimal harnesses table matching the shape after 013 + 014 (adds `enabled`).
const HARNESSES_DDL = `
  CREATE TABLE harnesses (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('claude-code', 'codex')),
    label TEXT NOT NULL,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    home TEXT, bin TEXT, env_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
  );`;

test("applies pending migrations in order, skips already-applied ones", () => {
  const db = new Database(":memory:");
  const m: Migration[] = [
    { id: "001_init", sql: "CREATE TABLE foo (id INTEGER);" },
    { id: "002_add",  sql: "CREATE TABLE bar (id INTEGER);" },
  ];

  expect(migrate(db, m)).toEqual(["001_init", "002_add"]);
  expect(migrate(db, m)).toEqual([]); // idempotent

  const extra: Migration = { id: "003_extra", sql: "CREATE TABLE baz (id INTEGER);" };
  expect(migrate(db, [...m, extra])).toEqual(["003_extra"]);

  const tables = db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
  ).all().map((r) => r.name);
  expect(tables).toEqual(["_migrations", "bar", "baz", "foo"]);
});

test("skips a renamed migration when a legacy alias is already applied", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, cursor_session_id TEXT);
    CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO _migrations (id, applied_at) VALUES ('025_cursor_session_id', 1);
  `);

  const renamed: Migration = {
    id: "033_cursor_session_id",
    aliases: ["025_cursor_session_id"],
    sql: "ALTER TABLE runs ADD COLUMN cursor_session_id TEXT;",
  };

  expect(migrate(db, [renamed])).toEqual([]);
  expect(migrate(db, [renamed])).toEqual([]);

  const applied = db
    .query<{ id: string }, []>(`SELECT id FROM _migrations ORDER BY id`)
    .all()
    .map((r) => r.id);
  expect(applied).toEqual(["025_cursor_session_id", "033_cursor_session_id"]);
});

test("rolls back a failing migration so it can be retried", () => {
  const db = new Database(":memory:");
  const bad: Migration = {
    id: "001_bad",
    sql: "CREATE TABLE ok (id INTEGER); INSERT INTO missing VALUES (1);",
  };
  expect(() => migrate(db, [bad])).toThrow();

  const applied = db.query<{ id: string }, []>(`SELECT id FROM _migrations`).all();
  expect(applied).toEqual([]);

  const hasOk = db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE name='ok'`,
  ).all();
  expect(hasOk).toEqual([]);
});

test("a CHECK-constraint failure mid-migration rolls back statements that ran before AND after it", () => {
  // Regression: `Database.exec()`/`.run()` given a multi-statement string
  // does NOT stop at a failing statement the way the "rolls back a failing
  // migration" test above might suggest — that test's failure ("no such
  // table") is a different SQLite error class than a CHECK-constraint
  // violation, and only the former aborts the batch. Verified directly
  // against bun:sqlite: a 3-statement string where statement 2 violates a
  // CHECK constraint throws no error at all, and statement 3 (which would
  // succeed on its own) still runs. For the table-rebuild recipe several
  // migrations use (CREATE new / INSERT...SELECT / DROP old / RENAME), that
  // silently no-ops the row copy on a CHECK violation while the DROP and
  // RENAME after it still execute — permanently replacing the old table
  // with an empty one, with no thrown error to catch. This is why
  // `migrate()` runs each statement through its own `db.run()` call
  // (`splitSqlStatements`) instead of one `db.exec()` per file.
  const db = new Database(":memory:");
  const bad: Migration = {
    id: "001_bad_check",
    sql: `
      CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL CHECK (v IN ('a', 'b')));
      INSERT INTO t (id, v) VALUES (1, 'z');
      INSERT INTO t (id, v) VALUES (2, 'b');
    `,
  };
  expect(() => migrate(db, [bad])).toThrow(/CHECK constraint failed/);

  // Whole migration rolled back — not just the table create, but also the
  // second INSERT that would have succeeded on its own.
  const tables = db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='t'`,
  ).all();
  expect(tables).toEqual([]);
  const applied = db.query<{ id: string }, []>(`SELECT id FROM _migrations`).all();
  expect(applied).toEqual([]);
});

test("splitSqlStatements respects semicolons inside string literals and comments", () => {
  const sql = `
    -- a comment; with a semicolon
    INSERT INTO t (v) VALUES ('has; a semicolon'' and '' quotes');
    /* block; comment */
    INSERT INTO t (v) VALUES ('second');
  `;
  const statements = splitSqlStatements(sql);
  expect(statements).toHaveLength(2);
  expect(statements[0]).toContain("has; a semicolon");
  expect(statements[1]).toContain("second");
});

test("024_reseed_harness_builtins restores wiped builtins, is idempotent, and preserves enabled", () => {
  const db = new Database(":memory:");
  db.exec(HARNESSES_DDL);

  // Simulate the damaged prod state: builtins wiped out by a bad table rebuild.
  expect(db.query(`SELECT COUNT(*) n FROM harnesses`).get() as { n: number }).toEqual({ n: 0 });

  db.exec(reseedBuiltins);
  const afterFirst = db
    .query<{ id: string; kind: string; enabled: number; is_builtin: number }, []>(
      `SELECT id, kind, enabled, is_builtin FROM harnesses ORDER BY id`,
    )
    .all();
  expect(afterFirst).toEqual([
    { id: "claude-code", kind: "claude-code", enabled: 1, is_builtin: 1 },
    { id: "codex", kind: "codex", enabled: 0, is_builtin: 1 },
  ]);

  // Idempotent: re-running does not duplicate or overwrite. Flip claude-code
  // off first to prove OR IGNORE leaves an existing row's enabled untouched.
  db.run(`UPDATE harnesses SET enabled = 0 WHERE id = 'claude-code'`);
  db.exec(reseedBuiltins);
  const afterSecond = db
    .query<{ id: string; enabled: number }, []>(`SELECT id, enabled FROM harnesses ORDER BY id`)
    .all();
  expect(afterSecond).toEqual([
    { id: "claude-code", enabled: 0 }, // preserved, not reset to 1
    { id: "codex", enabled: 0 },
  ]);
});

test("049_retire_gemini_3_pro_preview rewrites only tasks pinned to the shut-down id (any harness), clears the stale lastModel:gemini preference, normalizes suffixed Cursor Gemini Flash variants to base id + effort, idempotently", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE harnesses (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      model TEXT,
      effort TEXT
    );
    CREATE TABLE preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    INSERT INTO harnesses (id, kind) VALUES
      ('gemini', 'gemini'), ('gemini-2', 'gemini'),
      ('cursor', 'cursor'), ('cursor-2', 'cursor'),
      ('fx', 'fx'), ('codex', 'codex');
  `);

  db.exec(`
    INSERT INTO tasks (id, agent, model, effort) VALUES
      ('t01', 'gemini', 'gemini-3-pro-preview', NULL),
      ('t02', 'gemini-2', 'gemini-3-pro-preview', NULL),
      ('t03', 'gemini', 'gemini-3.7-flash', NULL),
      ('t04', 'cursor', 'gemini-3.1-pro', 'high'),
      ('t05', 'fx', 'google/gemini-3.1-pro-preview', NULL),
      ('t06', 'codex', 'gpt-5.6-sol', 'high'),
      ('t07', 'gemini', NULL, NULL),
      ('t08', 'cursor', 'gemini-3.8-flash-high', NULL),
      ('t09', 'cursor-2', 'gemini-3.7-flash-low', 'high'),
      ('t10', 'cursor', 'gemini-3.8-flash-medium', 'medium'),
      ('t11', 'gemini', 'gemini-3.8-flash-medium', NULL),
      ('t12', 'cursor', 'gemini-3.6-flash', 'minimal');
  `);

  db.exec(`
    INSERT INTO preferences (key, value, updated_at) VALUES
      ('lastModel:gemini', 'gemini-3-pro-preview', 1),
      ('lastModel:codex', 'gpt-5.6-sol', 1),
      ('lastMode:gemini', 'auto', 1),
      ('lastModel:cursor', 'gemini-3.1-pro', 1);
  `);

  const readAll = () =>
    db
      .query<{ id: string; agent: string; model: string | null; effort: string | null }, []>(
        `SELECT id, agent, model, effort FROM tasks ORDER BY id`,
      )
      .all();

  const readPrefs = () =>
    db
      .query<{ key: string; value: string }, []>(
        `SELECT key, value FROM preferences ORDER BY key`,
      )
      .all();

  db.exec(retireGemini3ProPreview);
  expect(readAll()).toEqual([
    { id: "t01", agent: "gemini", model: "gemini-3.1-pro-preview", effort: null }, // rewritten
    { id: "t02", agent: "gemini-2", model: "gemini-3.1-pro-preview", effort: null }, // rewritten — additional-account harness, no join needed
    { id: "t03", agent: "gemini", model: "gemini-3.7-flash", effort: null }, // untouched
    { id: "t04", agent: "cursor", model: "gemini-3.1-pro", effort: "high" }, // untouched — different literal
    { id: "t05", agent: "fx", model: "google/gemini-3.1-pro-preview", effort: null }, // untouched — different literal
    { id: "t06", agent: "codex", model: "gpt-5.6-sol", effort: "high" }, // untouched — unrelated kind
    { id: "t07", agent: "gemini", model: null, effort: null }, // untouched — still NULL
    { id: "t08", agent: "cursor", model: "gemini-3.8-flash", effort: "high" }, // variant → base + effort
    { id: "t09", agent: "cursor-2", model: "gemini-3.7-flash", effort: "low" }, // variant wins over a stale effort; additional cursor harness via the kind join
    { id: "t10", agent: "cursor", model: "gemini-3.8-flash", effort: "medium" }, // variant → base, effort already matched
    { id: "t11", agent: "gemini", model: "gemini-3.8-flash-medium", effort: null }, // untouched — not a cursor-kind harness
    { id: "t12", agent: "cursor", model: "gemini-3.6-flash", effort: "minimal" }, // untouched — already base + effort
  ]);
  expect(readPrefs()).toEqual([
    { key: "lastMode:gemini", value: "auto" }, // untouched — not a lastModel key
    { key: "lastModel:codex", value: "gpt-5.6-sol" }, // untouched — other kind
    { key: "lastModel:cursor", value: "gemini-3.1-pro" }, // untouched — other kind
    // lastModel:gemini (the dead id) is gone
  ]);

  // Idempotent: re-applying against the already-rewritten rows is a no-op
  // for both tables.
  const tasksBeforeSecond = readAll();
  const prefsBeforeSecond = readPrefs();
  db.exec(retireGemini3ProPreview);
  expect(readAll()).toEqual(tasksBeforeSecond);
  expect(readPrefs()).toEqual(prefsBeforeSecond);
});

test("049 leaves a lastModel:gemini pref that already points at a live model alone", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE harnesses (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      model TEXT,
      effort TEXT
    );
    CREATE TABLE preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    INSERT INTO preferences (key, value, updated_at) VALUES
      ('lastModel:gemini', 'gemini-3.7-flash', 1);
  `);

  db.exec(retireGemini3ProPreview);

  const prefs = db
    .query<{ key: string; value: string }, []>(
      `SELECT key, value FROM preferences ORDER BY key`,
    )
    .all();
  expect(prefs).toEqual([{ key: "lastModel:gemini", value: "gemini-3.7-flash" }]);
});

test("049 is registered last in the migrations index", () => {
  const last = migrations[migrations.length - 1];
  expect(last?.id).toBe("049_retire_gemini_3_pro_preview");
  expect(last?.sql).toContain("gemini-3.1-pro-preview");
});
