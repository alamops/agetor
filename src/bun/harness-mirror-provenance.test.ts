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
  test("upsert is keyed by (account, path, key) and replaces every other column", () => {
    mirrorProvenance.upsert(row());
    mirrorProvenance.upsert(row({ valueHash: "h2", srcMtimeMs: 200, srcSize: 20, preexisted: true, backupRef: "bk/1", updatedAt: 9, stackId: "s" }));
    expect(mirrorProvenance.list(A)).toHaveLength(1);
    expect(mirrorProvenance.get(A, "/acct/a/settings.json")).toEqual(
      row({ valueHash: "h2", srcMtimeMs: 200, srcSize: 20, preexisted: true, backupRef: "bk/1", updatedAt: 9, stackId: "s" }),
    );
    // A key row for the same path is a separate row.
    mirrorProvenance.upsert(row({ scope: "key", key: "env.X" }));
    mirrorProvenance.upsert(row({ scope: "link", path: "/acct/a/skills", key: "" }));
    expect(mirrorProvenance.list(A).map((r) => `${r.path}|${r.key}|${r.scope}`)).toEqual([
      "/acct/a/settings.json||file",
      "/acct/a/settings.json|env.X|key",
      "/acct/a/skills||link",
    ]);
    expect(mirrorProvenance.listForPath(A, "/acct/a/settings.json").map((r) => r.key)).toEqual(["", "env.X"]);
    expect(mirrorProvenance.get(A, "/missing")).toBeNull();
  });

  test("remove, removeForPath and deleteForHarness delete exactly their scope", () => {
    mirrorProvenance.upsert(row({ harnessId: B }));
    mirrorProvenance.remove(A, "/acct/a/settings.json", "env.X");
    expect(mirrorProvenance.get(A, "/acct/a/settings.json", "env.X")).toBeNull();
    expect(mirrorProvenance.get(A, "/acct/a/settings.json")).not.toBeNull();
    mirrorProvenance.removeForPath(A, "/acct/a/settings.json");
    expect(mirrorProvenance.list(A).map((r) => r.path)).toEqual(["/acct/a/skills"]);
    mirrorProvenance.deleteForHarness(A);
    expect(mirrorProvenance.list(A)).toEqual([]);
    expect(mirrorProvenance.list(B)).toHaveLength(1);
    mirrorProvenance.deleteForHarness(B);
  });

  test("a row read back from SQL with an unknown scope is coerced to file, never passed through", () => {
    db.exec(`PRAGMA ignore_check_constraints = ON`);
    try {
      db.run(`INSERT INTO harness_mirror_provenance (harness_id, scope, path, updated_at) VALUES (?, 'weird', '/w', 1)`, [A]);
    } finally {
      db.exec(`PRAGMA ignore_check_constraints = OFF`);
    }
    expect(mirrorProvenance.get(A, "/w")?.scope).toBe("file");
    mirrorProvenance.deleteForHarness(A);
  });
});

describe("harnessIdsWithProvenance", () => {
  test("is distinct per account however many rows it has, and drops an account on deleteForHarness", () => {
    for (let i = 0; i < 3; i++) mirrorProvenance.upsert(row({ path: `/p/${i}` }));
    mirrorProvenance.upsert(row({ harnessId: B }));
    const ids = harnessIdsWithProvenance();
    expect(ids.filter((id) => id === A)).toHaveLength(1);
    expect(ids.filter((id) => id === B)).toHaveLength(1);
    mirrorProvenance.deleteForHarness(A);
    expect(harnessIdsWithProvenance()).not.toContain(A);
    expect(harnessIdsWithProvenance()).toContain(B);
    mirrorProvenance.deleteForHarness(B);
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

  test("the stamp round-trips through the table", () => {
    mirrorProvenance.upsert(row({ srcMtimeMs: UNOWNED_STAMP, srcSize: UNOWNED_STAMP, preexisted: true, backupRef: "bk/2" }));
    const back = mirrorProvenance.get(A, "/acct/a/settings.json")!;
    expect(isUnownedRow(back)).toBe(true);
    // A later write that re-adopts the item replaces the stamp.
    mirrorProvenance.upsert({ ...back, srcMtimeMs: 7, srcSize: 8 });
    expect(isUnownedRow(mirrorProvenance.get(A, "/acct/a/settings.json")!)).toBe(false);
    mirrorProvenance.deleteForHarness(A);
  });
});

describe("table constraints", () => {
  test("no foreign keys; the scope CHECK refuses anything but file/key/link", () => {
    expect(db.query(`PRAGMA foreign_key_list(harness_mirror_provenance)`).all()).toEqual([]);
    // An account that does not exist in harnesses is accepted (085 lesson).
    expect(() => mirrorProvenance.upsert(row({ harnessId: `no-such-${tag}` }))).not.toThrow();
    mirrorProvenance.deleteForHarness(`no-such-${tag}`);
    for (const scope of ["bogus", "", "FILE"]) {
      expect(() =>
        db.run(`INSERT INTO harness_mirror_provenance (harness_id, scope, path, updated_at) VALUES (?, ?, '/x', 1)`, [A, scope]),
      ).toThrow();
    }
    expect(mirrorProvenance.list(A)).toEqual([]);
  });
});
