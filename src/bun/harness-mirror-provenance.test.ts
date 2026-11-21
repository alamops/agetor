// Mirror provenance store (migration 087): CRUD, the distinct-account scan,
// per-account delete, the unowned stamp, and the table's own constraints.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

process.env.AGETOR_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "agetor-mirror-provenance-"));

const { db } = await import("./db.ts");
const prov = await import("./harness-mirror-provenance.ts");
const { mirrorProvenance, harnessIdsWithProvenance, isUnownedRow, UNOWNED_STAMP } = prov;

const tag = randomUUID().slice(0, 8);
const A = `prov-a-${tag}`;
const B = `prov-b-${tag}`;
const row = (over: Partial<import("./harness-mirror-provenance.ts").MirrorProvenanceRow> = {}) => ({
  harnessId: A,
  stackId: null,
  scope: "file" as const,
  path: "/acct/a/settings.json",
  key: "",
  valueHash: "h1",
  srcMtimeMs: 100,
  srcSize: 10,
  preexisted: false,
  backupRef: null,
  updatedAt: 1,
  ...over,
});

afterAll(() => {
  db.run(`DELETE FROM harness_mirror_provenance WHERE harness_id IN (?, ?)`, [A, B]);
});

describe("mirrorProvenance CRUD", () => {
  test("upsert is keyed by (account, path, key) and replaces every other column", async () => {
    await mirrorProvenance.upsert(row());
    await mirrorProvenance.upsert(row({ valueHash: "h2", srcMtimeMs: 200, srcSize: 20, preexisted: true, backupRef: "bk/1", updatedAt: 9, stackId: "s" }));
    expect(await mirrorProvenance.list(A)).toHaveLength(1);
    expect(await mirrorProvenance.get(A, "/acct/a/settings.json")).toEqual(
      row({ valueHash: "h2", srcMtimeMs: 200, srcSize: 20, preexisted: true, backupRef: "bk/1", updatedAt: 9, stackId: "s" }),
    );
    // A key row for the same path is a separate row.
    await mirrorProvenance.upsert(row({ scope: "key", key: "env.X" }));
    await mirrorProvenance.upsert(row({ scope: "link", path: "/acct/a/skills", key: "" }));
    expect((await mirrorProvenance.list(A)).map((r) => `${r.path}|${r.key}|${r.scope}`)).toEqual([
      "/acct/a/settings.json||file",
      "/acct/a/settings.json|env.X|key",
      "/acct/a/skills||link",
    ]);
    expect((await mirrorProvenance.listForPath(A, "/acct/a/settings.json")).map((r) => r.key)).toEqual(["", "env.X"]);
    expect(await mirrorProvenance.get(A, "/missing")).toBeNull();
  });

  test("remove, removeForPath and deleteForHarness delete exactly their scope", async () => {
    await mirrorProvenance.upsert(row({ harnessId: B }));
    await mirrorProvenance.remove(A, "/acct/a/settings.json", "env.X");
    expect(await mirrorProvenance.get(A, "/acct/a/settings.json", "env.X")).toBeNull();
    expect(await mirrorProvenance.get(A, "/acct/a/settings.json")).not.toBeNull();
    await mirrorProvenance.removeForPath(A, "/acct/a/settings.json");
    expect((await mirrorProvenance.list(A)).map((r) => r.path)).toEqual(["/acct/a/skills"]);
    await mirrorProvenance.deleteForHarness(A);
    expect(await mirrorProvenance.list(A)).toEqual([]);
    expect(await mirrorProvenance.list(B)).toHaveLength(1);
    await mirrorProvenance.deleteForHarness(B);
  });

  test("removeAllButPath keeps only the named path's rows, of that account only", async () => {
    await mirrorProvenance.upsert(row({ path: ".claude.json", scope: "key", key: "mcpServers.x" }));
    await mirrorProvenance.upsert(row({ path: ".claude.json", scope: "key", key: "mcpServers.y" }));
    await mirrorProvenance.upsert(row({ path: "CLAUDE.md" }));
    await mirrorProvenance.upsert(row({ path: "settings.json", scope: "key", key: "env.X" }));
    await mirrorProvenance.upsert(row({ harnessId: B, path: "CLAUDE.md" }));
    await mirrorProvenance.removeAllButPath(A, ".claude.json");
    expect((await mirrorProvenance.list(A)).map((r) => `${r.path}|${r.key}`)).toEqual([".claude.json|mcpServers.x", ".claude.json|mcpServers.y"]);
    expect(await mirrorProvenance.list(B)).toHaveLength(1);
    await mirrorProvenance.deleteForHarness(A);
    await mirrorProvenance.deleteForHarness(B);
  });

  test("a row read back from SQL with an unknown scope is coerced to file, never passed through", async () => {
    db.exec(`PRAGMA ignore_check_constraints = ON`);
    try {
      db.run(`INSERT INTO harness_mirror_provenance (harness_id, scope, path, updated_at) VALUES (?, 'weird', '/w', 1)`, [A]);
    } finally {
      db.exec(`PRAGMA ignore_check_constraints = OFF`);
    }
    expect((await mirrorProvenance.get(A, "/w"))?.scope).toBe("file");
    await mirrorProvenance.deleteForHarness(A);
  });
});

describe("harnessIdsWithProvenance", () => {
  test("is distinct per account however many rows it has, and drops an account on deleteForHarness", async () => {
    for (let i = 0; i < 3; i++) await mirrorProvenance.upsert(row({ path: `/p/${i}` }));
    await mirrorProvenance.upsert(row({ harnessId: B }));
    const ids = await harnessIdsWithProvenance();
    expect(ids.filter((id) => id === A)).toHaveLength(1);
    expect(ids.filter((id) => id === B)).toHaveLength(1);
    await mirrorProvenance.deleteForHarness(A);
    expect(await harnessIdsWithProvenance()).not.toContain(A);
    expect(await harnessIdsWithProvenance()).toContain(B);
    await mirrorProvenance.deleteForHarness(B);
  });
});

describe("unowned stamp", () => {
  test("UNOWNED_STAMP is negative, so a real source stamp can never collide with it", () => {
    expect(UNOWNED_STAMP).toBeLessThan(0);
  });

  test("isUnownedRow needs BOTH columns at the stamp", () => {
    expect(isUnownedRow(row({ srcMtimeMs: UNOWNED_STAMP, srcSize: UNOWNED_STAMP }))).toBe(true);
    expect(isUnownedRow(row({ srcMtimeMs: UNOWNED_STAMP, srcSize: 10 }))).toBe(false);
    expect(isUnownedRow(row({ srcMtimeMs: 100, srcSize: UNOWNED_STAMP }))).toBe(false);
    expect(isUnownedRow(row({ srcMtimeMs: null, srcSize: null }))).toBe(false);
    expect(isUnownedRow(row())).toBe(false);
  });

  test("the stamp round-trips through the table", async () => {
    await mirrorProvenance.upsert(row({ srcMtimeMs: UNOWNED_STAMP, srcSize: UNOWNED_STAMP, preexisted: true, backupRef: "bk/2" }));
    const back = (await mirrorProvenance.get(A, "/acct/a/settings.json"))!;
    expect(isUnownedRow(back)).toBe(true);
    // A later write that re-adopts the item replaces the stamp.
    await mirrorProvenance.upsert({ ...back, srcMtimeMs: 7, srcSize: 8 });
    expect(isUnownedRow((await mirrorProvenance.get(A, "/acct/a/settings.json"))!)).toBe(false);
    await mirrorProvenance.deleteForHarness(A);
  });
});

describe("table constraints", () => {
  test("no foreign keys; the scope CHECK refuses anything but file/key/link", async () => {
    expect(db.query(`PRAGMA foreign_key_list(harness_mirror_provenance)`).all()).toEqual([]);
    // An account that does not exist in harnesses is accepted (085 lesson).
    await mirrorProvenance.upsert(row({ harnessId: `no-such-${tag}` }));
    await mirrorProvenance.deleteForHarness(`no-such-${tag}`);
    for (const scope of ["bogus", "", "FILE"]) {
      expect(() =>
        db.run(`INSERT INTO harness_mirror_provenance (harness_id, scope, path, updated_at) VALUES (?, ?, '/x', 1)`, [A, scope]),
      ).toThrow();
    }
    expect(await mirrorProvenance.list(A)).toEqual([]);
  });
});

describe("guarded account edit (harnesses.updateGuarded)", () => {
  test("the edit saves while the mirror records match the fingerprint, and is refused (nothing written) once a mirror run changed them", async () => {
    const { op } = await import("./db-async.ts");
    const dbm = await import("./db.ts");
    const id = `guard-${tag}`;
    dbm.harnesses.insert({ id, kind: "claude-code", label: "before", home: null, env: {} } as never);
    try {
      const sig = await mirrorProvenance.signature(id);
      const ok = await op("harnesses.updateGuarded", [id, { label: "after" }, sig]);
      expect(ok.ok).toBe(true);
      expect(dbm.harnesses.get(id)?.label).toBe("after");
      // A mirror run records a row between the check and the write.
      await mirrorProvenance.upsert(row({ harnessId: id }));
      const stale = await op("harnesses.updateGuarded", [id, { label: "stale" }, sig]);
      expect(stale).toEqual({ ok: false });
      expect(dbm.harnesses.get(id)?.label).toBe("after");
      // No fingerprint: no check.
      expect((await op("harnesses.updateGuarded", [id, { label: "free" }, null])).ok).toBe(true);
    } finally {
      await mirrorProvenance.deleteForHarness(id);
      dbm.db.run(`DELETE FROM harnesses WHERE id = ?`, [id]);
    }
  });
});
