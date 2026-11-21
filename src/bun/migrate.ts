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
  // CREATE TRIGGER bodies hold `;`-terminated statements between BEGIN and END,
  // so inside a trigger a `;` only ends the statement at block depth 0. BEGIN
  // and CASE open a block, END closes one (a `CASE ... END` expression nests).
  // `isTrigger` caches the "does this statement start with CREATE TRIGGER"
  // check, which is only evaluated when a BEGIN/CASE/END token shows up.
  let depth = 0;
  let isTrigger: boolean | null = null;
  const isWordChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$]/.test(c);
  while (i < sql.length) {
    const ch = sql[i];
    if (/[A-Za-z_]/.test(ch!) && !isWordChar(sql[i - 1])) {
      let end = i + 1;
      while (end < sql.length && isWordChar(sql[end])) end++;
      const word = sql.slice(i, end);
      const upper = word.toUpperCase();
      if (upper === "BEGIN" || upper === "CASE" || upper === "END") {
        // A quoted identifier ("end", `end`, [end]) is not a keyword.
        const quoted = /["`\[]/.test(sql[i - 1] ?? "") && /["`\]]/.test(sql[end] ?? "");
        // A token after `.` (`NEW.end`, `OLD.case`) is a column name.
        const member = sql[i - 1] === ".";
        if (!quoted && !member) {
          if (isTrigger === null) {
            const bare = current.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
            isTrigger = /^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(bare);
          }
          if (isTrigger) depth += upper === "END" ? -1 : 1;
        }
      }
      current += word;
      i = end;
      continue;
    }
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
      if (isTrigger && depth > 0) {
        current += ch;
        i++;
        continue;
      }
      statements.push(current);
      current = "";
      depth = 0;
      isTrigger = null;
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
      `INSERT OR IGNORE INTO _migrations (id, applied_at) VALUES (?, ?)`,
      [m.id, Date.now()],
    );
    applied.add(m.id);
  }

  const pending = migrations.filter((m) => !applied.has(m.id));

  // Each migration is checked and applied inside one BEGIN IMMEDIATE
  // transaction. The `applied` set above is only a hint: a second connection
  // migrating the same file concurrently may have applied this migration since
  // it was read, so it is re-read here after the write lock is held (the loser
  // of the lock waits on busy_timeout, then sees the row and skips).
  const applyOne = db.transaction((m: Migration): boolean => {
    const isApplied = (id: string) =>
      db.query<{ id: string }, [string]>(`SELECT id FROM _migrations WHERE id = ?`).get(id) !== null;
    if (isApplied(m.id) || m.aliases?.some(isApplied)) return false;
    for (const statement of splitSqlStatements(m.sql)) db.run(statement);
    db.run(`INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`, [m.id, Date.now()]);
    return true;
  });

  const ran: string[] = [];
  for (const m of pending) if (applyOne.immediate(m)) ran.push(m.id);
  return ran;
}
