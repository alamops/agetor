import { Database } from "bun:sqlite";

export interface Migration {
  id: string;   // e.g. "001_init" — must match the .sql filename (without extension)
  sql: string;
  /** Previous ids used by pre-merge/dogfood branches before this migration was
   *  renumbered. If any alias is already present, the migration's SQL has
   *  already run and only the canonical id needs backfilling. */
  aliases?: string[];
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
    db.exec(m.sql);
    db.run(`INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`, [m.id, Date.now()]);
  });

  for (const m of pending) applyOne(m);
  return pending.map((m) => m.id);
}
