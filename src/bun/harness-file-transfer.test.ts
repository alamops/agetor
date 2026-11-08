// Entry-budget accounting for the cooperative tree copy (T04 / R17-S1). The
// walk used to charge each file twice (once when its parent listed it, once
// after the copy), halving every caller's documented budget.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { copyTreeCooperative } from "./harness-file-transfer.ts";

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
