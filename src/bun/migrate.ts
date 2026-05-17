import { Database } from "bun:sqlite";

export interface Migration {
  id: string;   // e.g. "001_init" — must match the .sql filename (without extension)
  sql: string;
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

  const pending = migrations.filter((m) => !applied.has(m.id));

  const applyOne = db.transaction((m: Migration) => {
    db.exec(m.sql);
    db.run(`INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`, [m.id, Date.now()]);
  });

  for (const m of pending) applyOne(m);
  return pending.map((m) => m.id);
}
