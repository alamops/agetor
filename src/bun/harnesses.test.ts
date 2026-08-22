import { test, expect, beforeEach } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Set AGETOR_DATA_DIR before any import that pulls in db.ts. ES imports
// hoist before top-level code, so we use dynamic `await import()` below
// instead of a top-level `import { db } from "./db.ts"`.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-harnesses-"));
const { db, harnesses, HarnessBuiltinError, HarnessInUseError } = await import("./db.ts");

beforeEach(() => {
  // Wipe any user-added aliases between tests; built-ins (is_builtin=1)
  // stay so each test sees the seeded baseline. Also re-enable any built-in
  // a prior test may have toggled off, so the baseline truly is "default".
  db.run(`DELETE FROM harnesses WHERE is_builtin = 0`);
  db.run(`UPDATE harnesses SET enabled = 1 WHERE is_builtin = 1`);
});

test("seed leaves the two built-in harnesses in place", () => {
  const list = harnesses.list();
  // is_builtin DESC then created_at ASC → both builtins come first in
  // claude-code, codex order (matching the migration INSERT order).
  expect(list.map((h) => h.id)).toEqual(expect.arrayContaining(["claude-code", "codex"]));
  for (const id of ["claude-code", "codex"]) {
    const h = harnesses.get(id)!;
    expect(h.isBuiltin).toBe(true);
    expect(h.kind).toBe(id as "claude-code" | "codex");
  }
});

test("insert creates a user alias that round-trips through get/list", () => {
  const inserted = harnesses.insert({
    id: "claude-work",
    kind: "claude-code",
    label: "Claude (work)",
    home: "/tmp/agetor-test-home",
    bin: null,
    env: { FOO: "bar" },
  });
  expect(inserted.id).toBe("claude-work");
  expect(inserted.isBuiltin).toBe(false);

  const fetched = harnesses.get("claude-work")!;
  expect(fetched.home).toBe("/tmp/agetor-test-home");
  expect(fetched.env).toEqual({ FOO: "bar" });
});

test("insert rejects ids that aren't slugs", () => {
  expect(() =>
    harnesses.insert({ id: "Bad Id", kind: "claude-code", label: "x" }),
  ).toThrow(/invalid harness id/);
});

test("update mutates fields and refuses to touch built-ins", () => {
  harnesses.insert({ id: "claude-alt", kind: "claude-code", label: "Alt" });
  const after = harnesses.update("claude-alt", { home: "/tmp/alt-home" });
  expect(after.home).toBe("/tmp/alt-home");

  expect(() => harnesses.update("claude-code", { label: "Renamed" })).toThrow(HarnessBuiltinError);
});

test("delete refuses built-ins and refuses aliases in use by a task", () => {
  expect(() => harnesses.delete("claude-code")).toThrow(HarnessBuiltinError);

  harnesses.insert({ id: "claude-tmp", kind: "claude-code", label: "Tmp" });
  // Manually wire a fake task row referencing the alias — the table is
  // free-form TEXT so we can write directly without going through
  // createTask (which would also resolve a workdir, worktrees, etc.).
  const taskId = "task-using-alias";
  db.run(
    `INSERT INTO tasks
       (id, title, prompt, "column", agent, workdir, isolation,
        branch, worktree_path, base_ref, mode, model, effort, refs,
        run_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [taskId, "t", "p", "backlog", "claude-tmp", "/tmp", "none",
     null, null, null, null, null, null, "[]", null, Date.now(), Date.now()],
  );

  let caught: InstanceType<typeof HarnessInUseError> | null = null;
  try {
    harnesses.delete("claude-tmp");
  } catch (e) {
    if (e instanceof HarnessInUseError) caught = e;
  }
  expect(caught).not.toBeNull();
  expect(caught!.taskIds).toEqual([taskId]);

  // After clearing the reference, delete proceeds.
  db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  harnesses.delete("claude-tmp");
  expect(harnesses.get("claude-tmp")).toBeNull();
});

test("setEnabled toggles built-ins (carve-out from immutability) and update still refuses other built-in edits", () => {
  // Built-ins start enabled.
  expect(harnesses.get("claude-code")!.enabled).toBe(true);

  // Carve-out: enabled flag is mutable on built-ins.
  const disabled = harnesses.setEnabled("claude-code", false);
  expect(disabled.enabled).toBe(false);
  expect(harnesses.get("claude-code")!.enabled).toBe(false);

  // Identity/config fields stay immutable.
  expect(() => harnesses.update("claude-code", { label: "Renamed" })).toThrow(HarnessBuiltinError);

  // Re-enable.
  expect(harnesses.setEnabled("claude-code", true).enabled).toBe(true);
});

test("usage counts running and total tasks referencing the harness", () => {
  harnesses.insert({ id: "claude-busy", kind: "claude-code", label: "Busy" });
  const insertTask = (id: string, column: string) => {
    db.run(
      `INSERT INTO tasks
         (id, title, prompt, "column", agent, workdir, isolation,
          branch, worktree_path, base_ref, mode, model, effort, refs,
          run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, "t", "p", column, "claude-busy", "/tmp", "none",
       null, null, null, null, null, null, "[]", null, Date.now(), Date.now()],
    );
  };
  insertTask("t-run-1", "running");
  insertTask("t-run-2", "running");
  insertTask("t-done", "done");

  const u = harnesses.usage("claude-busy");
  expect(u.harnessId).toBe("claude-busy");
  expect(u.totalTaskCount).toBe(3);
  expect(u.runningTaskIds.sort()).toEqual(["t-run-1", "t-run-2"]);

  // Cleanup so subsequent tests aren't surprised by leftover rows.
  db.run(`DELETE FROM tasks WHERE agent = 'claude-busy'`);
});

test("getByIdOrKind synthesises a built-in row for legacy kind ids without a matching row", () => {
  // Even if a future migration accidentally dropped the seed, legacy
  // `tasks.agent ∈ {"claude-code","codex"}` rows must keep resolving.
  //
  // Deletes a built-in row, which is normally harmless because this file
  // runs against its own throwaway mkdtemp db (lines 6-10 above) — but that
  // isolation only protects a db.ts module instance THIS file is the first
  // to trigger; if some other file `bun test` happens to load earlier
  // static-imports its way into db.ts first (module instances are cached
  // per process, and bun test runs every file in one process), this DELETE
  // runs against whatever db.ts actually opened — which could be the real
  // ~/.agetor-dev. Capture + restore in `finally` so this test can never
  // leave a builtin permanently missing even in that case.
  const saved = db.query(`SELECT * FROM harnesses WHERE id = ?`).get("claude-code");
  try {
    db.run(`DELETE FROM harnesses WHERE id = ?`, ["claude-code"]);
    const synth = harnesses.getByIdOrKind("claude-code");
    expect(synth?.kind).toBe("claude-code");
    expect(synth?.isBuiltin).toBe(true);
    // And unknown ids still return null — no silent fallback to a random kind.
    expect(harnesses.getByIdOrKind("does-not-exist")).toBeNull();
  } finally {
    if (saved) {
      const s = saved as Record<string, SQLQueryBindings>;
      db.run(
        `INSERT OR IGNORE INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [s.id, s.kind, s.label, s.is_builtin, s.home, s.bin, s.env_json, s.created_at, s.updated_at, s.enabled] as SQLQueryBindings[],
      );
    }
  }
});

test("gemini is a built-in row (carve-out setEnabled toggle works like every other built-in)", () => {
  // 033_harness_kind_gemini.sql seeds gemini with enabled=0 (mirrors codex's
  // 016 disabled-by-default rollout) — verified directly against a fresh
  // migrate() run in the migrations smoke check, not re-asserted here since
  // this file's beforeEach unconditionally re-enables every built-in for
  // test isolation (`UPDATE harnesses SET enabled = 1 WHERE is_builtin = 1`),
  // which would make a "seeds disabled" assertion here just test the
  // beforeEach, not the migration.
  const h = harnesses.get("gemini")!;
  expect(h.isBuiltin).toBe(true);
  expect(h.kind).toBe("gemini");
  expect(harnesses.setEnabled("gemini", false).enabled).toBe(false);
  expect(harnesses.get("gemini")!.enabled).toBe(false);
  expect(() => harnesses.update("gemini", { label: "Renamed" })).toThrow(HarnessBuiltinError);
});

test("insert accepts kind:'gemini' and round-trips a gemini alias", () => {
  const inserted = harnesses.insert({
    id: "gemini-work",
    kind: "gemini",
    label: "Gemini (work)",
    home: "/tmp/agetor-test-gemini-home",
    bin: null,
    env: {},
  });
  expect(inserted.kind).toBe("gemini");
  expect(harnesses.get("gemini-work")!.home).toBe("/tmp/agetor-test-gemini-home");
});

test("fx is a built-in row (carve-out setEnabled toggle works like every other built-in)", () => {
  // 045_fx_harness.sql seeds fx with enabled=0 (mirrors codex's 016 /
  // cursor's / gemini's disabled-by-default rollout posture) — not
  // re-asserted here for the same reason the gemini test above doesn't
  // re-assert it: this file's beforeEach unconditionally re-enables every
  // built-in for test isolation.
  const h = harnesses.get("fx")!;
  expect(h.isBuiltin).toBe(true);
  expect(h.kind).toBe("fx");
  expect(h.label).toBe("fx.sh");
  expect(harnesses.setEnabled("fx", false).enabled).toBe(false);
  expect(harnesses.get("fx")!.enabled).toBe(false);
  expect(() => harnesses.update("fx", { label: "Renamed" })).toThrow(HarnessBuiltinError);
});

test("insert accepts kind:'fx' and round-trips an fx alias", () => {
  const inserted = harnesses.insert({
    id: "fx-work",
    kind: "fx",
    label: "fx (work)",
    home: "/tmp/agetor-test-fx-home",
    bin: null,
    env: {},
  });
  expect(inserted.kind).toBe("fx");
  expect(harnesses.get("fx-work")!.home).toBe("/tmp/agetor-test-fx-home");
});

test("getByIdOrKind synthesises a built-in fx row for legacy id without a matching row", () => {
  // Same capture/restore rationale as the claude-code/gemini versions of
  // this test above.
  const saved = db.query(`SELECT * FROM harnesses WHERE id = ?`).get("fx");
  try {
    db.run(`DELETE FROM harnesses WHERE id = ?`, ["fx"]);
    const synth = harnesses.getByIdOrKind("fx");
    expect(synth?.kind).toBe("fx");
    expect(synth?.isBuiltin).toBe(true);
    expect(synth?.label).toBe("fx.sh");
  } finally {
    if (saved) {
      const s = saved as Record<string, SQLQueryBindings>;
      db.run(
        `INSERT OR IGNORE INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [s.id, s.kind, s.label, s.is_builtin, s.home, s.bin, s.env_json, s.created_at, s.updated_at, s.enabled] as SQLQueryBindings[],
      );
    }
  }
});

test("insert rejects kind:'grok'/'kimi' even though the harnesses.kind CHECK constraint permits them", () => {
  // migrations/045_fx_harness.sql widens the `harnesses.kind` CHECK to admit
  // 'grok' and 'kimi' — reserved kinds the migration's own comment documents
  // as not shipped here, kept in the CHECK so the table-rebuild recipe's
  // INSERT...SELECT row copy stays order-independent regardless of which
  // kind's migration lands first (a rebuild whose CHECK excludes an
  // already-seeded kind fails its row copy). That widened CHECK is a
  // SQLite-schema-level allowance only: `harnesses.insert` (db.ts) enforces
  // its own separate app-layer whitelist (`claude-code` | `codex` |
  // `cursor` | `gemini` | `fx`) that does not include 'grok'/'kimi', so an
  // attempt to insert either is rejected before the CHECK constraint is
  // ever consulted.
  for (const kind of ["grok", "kimi"]) {
    expect(() =>
      harnesses.insert({ id: `${kind}-work`, kind: kind as never, label: kind }),
    ).toThrow(new RegExp(`unknown harness kind: ${kind}`));
  }
});

test("getByIdOrKind returns null for CHECK-permitted-but-app-unrecognized kinds ('grok', 'kimi')", () => {
  // Mirrors the insert rejection above: getByIdOrKind's synthesis whitelist
  // is the same closed set as insert's, so a legacy/foreign 'grok' or 'kimi'
  // id (which the CHECK constraint would happily store, but which no
  // migration has ever seeded a builtin row for) resolves to null rather
  // than silently fabricating a builtin for a kind agetor doesn't drive.
  for (const kind of ["grok", "kimi"]) {
    expect(harnesses.getByIdOrKind(kind)).toBeNull();
  }
});

test("getByIdOrKind synthesises a built-in gemini row for legacy id without a matching row", () => {
  // Same capture/restore rationale as the claude-code version of this test
  // above — belt-and-braces against this file's isolation being defeated.
  const saved = db.query(`SELECT * FROM harnesses WHERE id = ?`).get("gemini");
  try {
    db.run(`DELETE FROM harnesses WHERE id = ?`, ["gemini"]);
    const synth = harnesses.getByIdOrKind("gemini");
    expect(synth?.kind).toBe("gemini");
    expect(synth?.isBuiltin).toBe(true);
    expect(synth?.label).toBe("Gemini CLI");
  } finally {
    if (saved) {
      const s = saved as Record<string, SQLQueryBindings>;
      db.run(
        `INSERT OR IGNORE INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [s.id, s.kind, s.label, s.is_builtin, s.home, s.bin, s.env_json, s.created_at, s.updated_at, s.enabled] as SQLQueryBindings[],
      );
    }
  }
});
