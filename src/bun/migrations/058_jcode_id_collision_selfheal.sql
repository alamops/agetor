-- Self-heal for the exact id collision 057's own header warned about and
-- that reproduces deterministically: if a harness row already existed at id
-- 'jcode' with a DIFFERENT kind (e.g. a user's own custom alias named
-- "jcode" for an fx/claude-code/etc. account, created before jcode ever
-- existed as a kind — HARNESS_ID_RE (db.ts) allows any lowercase slug, so
-- nothing ever stopped a user from picking that id), 057's `INSERT OR IGNORE
-- INTO harnesses (id='jcode', kind='jcode', ...)` collided on the existing
-- primary key. INSERT OR IGNORE never touches an existing row, so the
-- built-in jcode harness was silently never seeded on that DB — the "Jcode"
-- option never appeared in the harness picker, with no error anywhere.
-- Confirmed via a direct migration-runner repro (apply every migration up to
-- 056, insert a synthetic `('jcode', 'fx', ...)` row, then apply 057): the
-- row survives 057 completely unchanged and no kind='jcode' row is ever
-- created.
--
-- The colliding row is deliberately NOT renamed, deleted, or reassigned
-- here. Two reasons:
--   1. `tasks.agent`/`runs.agent` reference a harness by id in application
--      code (`harnesses.getByIdOrKind`, orchestrator.ts's `resolveHarness`)
--      rather than a SQL foreign key (see 032's header) — any task that
--      already picked agent='jcode' before this migration expects THAT
--      existing row's kind (the user's own alias), not jcode's. Rewriting
--      id='jcode' out from under those tasks would silently reassign their
--      agent kind to jcode on their next resume/follow-up.
--   2. Harness ids are immutable in the app — `harnesses.update` (db.ts)
--      only ever patches label/home/bin/env, never `id` — so there is no
--      supported "rename the collision away" path this migration could
--      trigger even if it wanted to.
--
-- Instead: seed the true jcode builtin under a fallback id ('jcode-builtin')
-- whenever no kind='jcode' row exists ANYWHERE in the table — this covers
-- both the collision case above and a jcode row missing for any other
-- reason (the same table-rebuild-drops-rows failure class 024/038/046
-- document and self-heal for their own kinds). Gated by `WHERE NOT EXISTS
-- (... kind = 'jcode')` rather than a bare id-keyed `INSERT OR IGNORE`,
-- because the id being free doesn't by itself mean the kind is missing (a
-- healthy DB already has kind='jcode' sitting at id='jcode' from 057, and
-- this must stay a no-op there) — `OR IGNORE` is kept too, belt-and-braces,
-- in case 'jcode-builtin' itself was ever independently taken by an
-- unrelated user alias. Idempotent either way: a healthy DB sees zero rows
-- change; a collided one gets exactly one new row, once.
INSERT OR IGNORE INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled)
SELECT
  'jcode-builtin', 'jcode', 'Jcode', 1, NULL, NULL, '{}',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  0
WHERE NOT EXISTS (SELECT 1 FROM harnesses WHERE kind = 'jcode');
