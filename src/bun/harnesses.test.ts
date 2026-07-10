import { test, expect, beforeEach } from "bun:test";
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
  // stay so each test sees the seeded baseline. Also reset any built-in a
  // prior test may have toggled, so the baseline truly is "default" —
  // claude-code/codex seed enabled=1 (013), but grok seeds enabled=0 (024,
  // D7's disabled-by-default rollout), so the reset is kind-specific rather
  // than a blanket "enabled=1 for every built-in".
  db.run(`DELETE FROM harnesses WHERE is_builtin = 0`);
  db.run(`UPDATE harnesses SET enabled = 1 WHERE is_builtin = 1 AND kind IN ('claude-code', 'codex')`);
  db.run(`UPDATE harnesses SET enabled = 0 WHERE is_builtin = 1 AND kind = 'grok'`);
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
  db.run(`DELETE FROM harnesses WHERE id = ?`, ["claude-code"]);
  const synth = harnesses.getByIdOrKind("claude-code");
  expect(synth?.kind).toBe("claude-code");
  expect(synth?.isBuiltin).toBe(true);
  // And unknown ids still return null — no silent fallback to a random kind.
  expect(harnesses.getByIdOrKind("does-not-exist")).toBeNull();
});

// --- grok (T2/T3: migration 026 + db.ts widening) --------------------------

test("migrated builtin grok row exists and is seeded disabled by default (D7 rollout)", () => {
  const h = harnesses.get("grok")!;
  expect(h).not.toBeNull();
  expect(h.kind).toBe("grok");
  expect(h.isBuiltin).toBe(true);
  expect(h.enabled).toBe(false);
});

test("insert accepts kind 'grok' and round-trips through get/list", () => {
  const inserted = harnesses.insert({
    id: "grok-work",
    kind: "grok",
    label: "Grok (work)",
    home: "/tmp/agetor-test-grok-home",
    bin: null,
    env: { FOO: "bar" },
  });
  expect(inserted.id).toBe("grok-work");
  expect(inserted.kind).toBe("grok");
  expect(inserted.isBuiltin).toBe(false);

  const fetched = harnesses.get("grok-work")!;
  expect(fetched.kind).toBe("grok");
  expect(fetched.home).toBe("/tmp/agetor-test-grok-home");
  expect(fetched.env).toEqual({ FOO: "bar" });

  expect(harnesses.list().map((h) => h.id)).toContain("grok-work");
});

test("insert rejects a bogus kind — 'cursor' is permitted by the widened CHECK but not yet whitelisted at the app layer", () => {
  // Migration 024's CHECK also lists 'cursor' (a sibling branch's future
  // kind) so the two rebuilds are order-independent, but db.ts's app-level
  // whitelist is the actual gate on what can be inserted today — 'cursor'
  // must still be rejected here even though SQLite's CHECK would allow it.
  expect(() =>
    harnesses.insert({ id: "cursor-work", kind: "cursor" as any, label: "x" }),
  ).toThrow(/unknown harness kind/);
});

test("getByIdOrKind('grok') resolves the seeded builtin row", () => {
  const h = harnesses.getByIdOrKind("grok");
  expect(h?.kind).toBe("grok");
  expect(h?.isBuiltin).toBe(true);
  expect(h?.id).toBe("grok");
});

test("getByIdOrKind synthesises a grok built-in row when the seeded row is missing", () => {
  db.run(`DELETE FROM harnesses WHERE id = ?`, ["grok"]);
  const synth = harnesses.getByIdOrKind("grok");
  expect(synth?.kind).toBe("grok");
  expect(synth?.isBuiltin).toBe(true);
  // Restore the seeded row: bun test shares ONE SQLite DB across all files,
  // and later files (orchestrator-grok.test.ts) call setEnabled("grok", …),
  // which needs the real row — leaving it deleted makes them flake on order.
  db.run(
    `INSERT OR IGNORE INTO harnesses (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled)
     VALUES ('grok', 'grok', 'Grok Build', 1, NULL, NULL, '{}', ?, ?, 0)`,
    [Date.now(), Date.now()],
  );
});
