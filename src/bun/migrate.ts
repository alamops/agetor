import { Database } from "bun:sqlite";

export interface Migration {
  id: string;   // e.g. "001_init" — must match the .sql filename (without extension)
  sql: string;
  /** Previous ids used by pre-merge/dogfood branches before this migration was
   *  renumbered. If any alias is already present, the migration's SQL has
   *  already run and only the canonical id needs backfilling. */
  aliases?: string[];
}

/**
 * Split a migration file's SQL into individual statements.
 *
 * `Database.exec()`/`.run()` given a multi-statement string does NOT stop at
 * the first failing statement the way every table-rebuild migration's own
 * comments assume ("this whole file runs inside the migration runner's one
 * transaction — the drop/rename only commits if every step succeeded").
 * Verified directly: a 3-statement string where statement 2 violates a CHECK
 * constraint throws no error and statement 3 still runs — for a rebuild
 * recipe (CREATE new / INSERT...SELECT / DROP old / RENAME), that means a
 * CHECK violation on the copy step silently no-ops the copy (0 rows) while
 * the DROP and RENAME after it still execute, permanently replacing the old
 * table with an empty one. Running each statement through its own `db.run()`
 * call instead makes the failure throw where it happens, so the `.transaction()`
 * wrapper in `migrate()` below can actually roll back like the comments say.
 *
 * Splits on top-level `;` — respects single-quoted string literals (with
 * `''` as an escaped quote, standard SQL), `--` line comments, and C-style
 * block comments, so a semicolon inside any of those doesn't split. This is
 * intentionally minimal (no double-quoted-identifier or dollar-quoting
 * support) — sufficient for this project's own hand-written migration files,
 * not a general-purpose SQL parser for arbitrary/untrusted input.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      // Consume the whole string literal, including any '' escapes, so a
      // semicolon or comment-opener inside it is never mistaken for one.
      current += ch;
      i++;
      while (i < sql.length) {
        current += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { current += sql[i + 1]; i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      current += sql.slice(i, nl === -1 ? sql.length : nl);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === ";") {
      statements.push(current);
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim()) statements.push(current);
  // Drop statements that are empty once comments/whitespace are stripped —
  // a trailing `-- comment\n` after the last `;` would otherwise become a
  // bogus "empty" statement that `db.run()` rejects.
  return statements
    .map((s) => s.trim())
    .filter((s) => s.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim().length > 0);
}

export function migrate(db: Database, migrations: Migration[]): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db.query<{ id: string }, []>(`SELECT id FROM _migrations`).all().map((r) => r.id),
  );

  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    if (!m.aliases?.some((alias) => applied.has(alias))) continue;
    db.run(
      `INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`,
      [m.id, Date.now()],
    );
    applied.add(m.id);
  }

  const pending = migrations.filter((m) => !applied.has(m.id));

  const applyOne = db.transaction((m: Migration) => {
    for (const statement of splitSqlStatements(m.sql)) db.run(statement);
    db.run(`INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`, [m.id, Date.now()]);
  });

  for (const m of pending) applyOne(m);
  return pending.map((m) => m.id);
}
