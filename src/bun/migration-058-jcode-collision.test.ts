import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

/**
 * Migration 057 seeds the built-in `jcode` harness with `INSERT OR IGNORE
 * INTO harnesses (id='jcode', kind='jcode', ...)`. `INSERT OR IGNORE` never
 * touches an existing row, so if a harness row already existed at id
 * 'jcode' with a DIFFERENT kind (a user's own custom alias — `HARNESS_ID_RE`
 * in db.ts allows any lowercase slug, so nothing ever stopped a user from
 * naming an alias "jcode" before jcode existed as a kind), the built-in
 * jcode harness was silently never seeded: no error, no kind='jcode' row
 * anywhere, and the "Jcode" option simply never appeared in the harness
 * picker. This actually happened on a real dev machine (the incident 058's
 * own header documents). 058 self-heals it by seeding the true jcode builtin
 * under a fallback id ('jcode-builtin') whenever no kind='jcode' row exists
 * anywhere in the table, without touching the pre-existing colliding row
 * (harness ids are immutable in the app, and any task that already picked
 * agent='jcode' expects THAT row's kind, not jcode's).
 *
 * Run against an in-memory DB via the raw migration runner (not `db.ts`'s
 * exported `harnesses`), so this test controls migration ordering directly
 * — applying every migration up to (not including) 057, hand-seeding the
 * collision row, THEN applying 057+058 — which `db.ts`'s own module-load
 * time `migrate()` call (always start-to-finish) can't express.
 */
function migrateUpTo(db: Database, stopBeforeId: string): typeof migrations {
  const idx = migrations.findIndex((m) => m.id === stopBeforeId);
  if (idx === -1) throw new Error(`no such migration: ${stopBeforeId}`);
  const upTo = migrations.slice(0, idx);
  migrate(db, upTo);
  return upTo;
}

function harnessRows(db: Database) {
  return db
    .query<{ id: string; kind: string; label: string; is_builtin: number; enabled: number }, []>(
      `SELECT id, kind, label, is_builtin, enabled FROM harnesses ORDER BY id`,
    )
    .all();
}

test("058 is a no-op on a healthy DB — 057 already seeded kind='jcode' at id='jcode'", () => {
  const db = new Database(":memory:");
  migrate(db, migrations); // every migration, including 057 and 058, in order
  const rows = harnessRows(db);
  const jcodeRows = rows.filter((r) => r.kind === "jcode");
  expect(jcodeRows).toHaveLength(1);
  expect(jcodeRows[0]).toMatchObject({ id: "jcode", kind: "jcode", label: "Jcode", is_builtin: 1, enabled: 0 });
  // No fallback-id row was created on a healthy DB.
  expect(rows.some((r) => r.id === "jcode-builtin")).toBe(false);
});

test("058 self-heals the exact id collision: a pre-existing non-jcode row at id='jcode' silently blocks 057's seed, so 058 seeds the builtin under a fallback id instead", () => {
  const db = new Database(":memory:");
  migrateUpTo(db, "057_jcode_harness");
  // Simulate: a user's own custom fx-kind harness alias, named "jcode",
  // created before jcode ever existed as a kind.
  db.run(
    `INSERT INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled)
     VALUES ('jcode', 'fx', 'My fx alias', 0, '/tmp/fake-home', NULL, '{}', 1000, 1000, 1)`,
  );

  migrate(db, migrations); // apply 057, then 058, against the collided DB

  const rows = harnessRows(db);

  // The user's pre-existing row at id='jcode' is untouched — its kind,
  // label, is_builtin, and enabled state all survive verbatim. Renaming or
  // reassigning it would silently change the kind of any task that already
  // picked agent='jcode'.
  const collided = rows.find((r) => r.id === "jcode");
  expect(collided).toMatchObject({ id: "jcode", kind: "fx", label: "My fx alias", is_builtin: 0, enabled: 1 });

  // The true jcode builtin now exists — just under the fallback id, since
  // 'jcode' itself was taken.
  const builtin = rows.find((r) => r.kind === "jcode");
  expect(builtin).toBeDefined();
  expect(builtin).toMatchObject({ id: "jcode-builtin", kind: "jcode", label: "Jcode", is_builtin: 1, enabled: 0 });

  // Exactly one row of each kind — no duplicate jcode builtins, no row lost.
  expect(rows.filter((r) => r.kind === "jcode")).toHaveLength(1);
  expect(rows.filter((r) => r.id === "jcode")).toHaveLength(1);
});

test("058 running twice (idempotent) does not create a second fallback row", () => {
  const db = new Database(":memory:");
  migrateUpTo(db, "057_jcode_harness");
  db.run(
    `INSERT INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled)
     VALUES ('jcode', 'codex', 'My codex alias', 0, NULL, NULL, '{}', 1000, 1000, 1)`,
  );
  migrate(db, migrations);
  const first = harnessRows(db).filter((r) => r.kind === "jcode");
  expect(first).toHaveLength(1);

  // Re-running migrate() against an already-fully-migrated DB is exactly
  // what happens on every subsequent daemon boot — must stay a pure no-op.
  migrate(db, migrations);
  const second = harnessRows(db).filter((r) => r.kind === "jcode");
  expect(second).toHaveLength(1);
  expect(second).toEqual(first);
});
