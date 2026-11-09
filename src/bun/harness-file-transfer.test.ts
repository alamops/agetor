// Entry-budget accounting for the cooperative tree copy (T04 / R17-S1). The
// walk used to charge each file twice (once when its parent listed it, once
// after the copy), halving every caller's documented budget.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { copyRegularFileDetailed, copyTreeCooperative } from "./harness-file-transfer.ts";

function fixture(fileCount: number): { src: string; dest: string; names: string[] } {
  const src = mkdtempSync(path.join(tmpdir(), "agetor-budget-src-"));
  const dest = mkdtempSync(path.join(tmpdir(), "agetor-budget-dest-"));
  const names: string[] = [];
  for (let i = 0; i < fileCount; i++) {
    const name = `f${String(i).padStart(2, "0")}.md`;
    names.push(name);
    writeFileSync(path.join(src, name), `# ${i}\n`);
  }
  return { src, dest, names };
}

describe("copyTreeCooperative entry budget", () => {
  test("a tree of N files fits an N-entry budget (each entry counted once)", async () => {
    const { src, dest, names } = fixture(10);
    const result = await copyTreeCooperative(src, dest, { maxEntries: 10 });
    expect(result.truncated).toBe(false);
    expect([...result.copied].sort()).toEqual(names.sort());
    expect(readdirSync(dest).sort()).toEqual(names);
    expect(readFileSync(path.join(dest, "f00.md"), "utf8")).toBe("# 0\n");
  });

  test("the entry after the budget is truncated, not half the tree before it", async () => {
    const { src, dest } = fixture(11);
    const result = await copyTreeCooperative(src, dest, { maxEntries: 10 });
    expect(result.copied).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(result.skipped).toHaveLength(1);
    // The tree root itself is not an entry, so a one-file tree fits a budget
    // of one.
    const single = fixture(1);
    const oneFile = await copyTreeCooperative(single.src, single.dest, { maxEntries: 1 });
    expect(oneFile.copied).toHaveLength(1);
    expect(oneFile.truncated).toBe(false);
  });

  test("directories share the budget but do not double-charge their files", async () => {
    const src = mkdtempSync(path.join(tmpdir(), "agetor-budget-dir-src-"));
    const dest = mkdtempSync(path.join(tmpdir(), "agetor-budget-dir-dest-"));
    mkdirSync(path.join(src, "nested"), { recursive: true });
    writeFileSync(path.join(src, "nested", "a.md"), "a");
    writeFileSync(path.join(src, "b.md"), "b");
    // nested + two files = 3 entries.
    const result = await copyTreeCooperative(src, dest, { maxEntries: 3 });
    expect(result.truncated).toBe(false);
    expect([...result.copied].sort()).toEqual([path.join("nested", "a.md"), "b.md"].sort());
  });
});

describe("copyTreeCooperative created/unchanged reporting (contracts C4, C5)", () => {
  test("created lists only destinations that did not exist; skipUnchanged leaves matching files alone", async () => {
    const src = mkdtempSync(path.join(tmpdir(), "agetor-created-src-"));
    const dest = mkdtempSync(path.join(tmpdir(), "agetor-created-dest-"));
    writeFileSync(path.join(src, "new.md"), "new");
    writeFileSync(path.join(src, "existing.md"), "from source");
    writeFileSync(path.join(dest, "existing.md"), "destination's own");

    const first = await copyTreeCooperative(src, dest, { skipUnchanged: true });
    expect(first.copied.sort()).toEqual(["existing.md", "new.md"]);
    // The destination already had `existing.md`: overwritten, never "created".
    expect(first.created).toEqual(["new.md"]);
    expect(first.unchanged).toEqual([]);
    expect(readFileSync(path.join(dest, "existing.md"), "utf8")).toBe("from source");
    // The source mtime is preserved, so the next run can match it.
    expect(Math.abs(statSync(path.join(dest, "new.md")).mtimeMs - statSync(path.join(src, "new.md")).mtimeMs)).toBeLessThan(1);

    const ino = statSync(path.join(dest, "new.md")).ino;
    const second = await copyTreeCooperative(src, dest, { skipUnchanged: true });
    expect(second.copied).toEqual([]);
    expect(second.unchanged.sort()).toEqual(["existing.md", "new.md"]);
    expect(statSync(path.join(dest, "new.md")).ino).toBe(ino);
  });

  test("without skipUnchanged every file is rewritten and the mtime is the copy's own", async () => {
    const src = mkdtempSync(path.join(tmpdir(), "agetor-plain-src-"));
    const dest = mkdtempSync(path.join(tmpdir(), "agetor-plain-dest-"));
    writeFileSync(path.join(src, "a.md"), "a");
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(path.join(src, "a.md"), old, old);
    const first = await copyTreeCooperative(src, dest);
    const second = await copyTreeCooperative(src, dest);
    expect(first.copied).toEqual(["a.md"]);
    expect(second.copied).toEqual(["a.md"]);
    expect(second.created).toEqual([]);
    expect(statSync(path.join(dest, "a.md")).mtimeMs).toBeGreaterThan(old.getTime() + 1_000);
  });

  test("copyRegularFileDetailed reports a fresh destination as created", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agetor-detailed-"));
    writeFileSync(path.join(dir, "src"), "x");
    const fresh = await copyRegularFileDetailed(path.join(dir, "src"), path.join(dir, "out"));
    expect(fresh).toEqual({ bytes: 1, created: true, unchanged: false });
    const again = await copyRegularFileDetailed(path.join(dir, "src"), path.join(dir, "out"));
    expect(again.created).toBe(false);
  });
});
