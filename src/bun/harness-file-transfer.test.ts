// Entry-budget accounting for the cooperative tree copy (T04 / R17-S1). The
// walk used to charge each file twice (once when its parent listed it, once
// after the copy), halving every caller's documented budget.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  copyRegularFileDetailed,
  copyTreeCooperative,
  removeCopiedPaths,
  resolvePathLexically,
  rootRedirectRefusal,
  setTccHomeForTests,
} from "./harness-file-transfer.ts";

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

/** A fake home (realpath'd, so `/var` → `/private/var` does not matter) with
 *  a `Documents` folder the test can lock: with its mode at 000 any lstat
 *  BELOW it fails with EACCES, so a resolution that stays clean proves nothing
 *  inside the protected folder was touched. */
function fakeHome(): { home: string; documents: string; lock: () => void } {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-tcc-home-")));
  const documents = path.join(home, "Documents");
  mkdirSync(path.join(documents, "acct"), { recursive: true });
  writeFileSync(path.join(documents, "acct", "settings.json"), "{}");
  locked.push(documents);
  return { home, documents, lock: () => chmodSync(documents, 0o000) };
}

const locked: string[] = [];
afterEach(() => {
  setTccHomeForTests(null);
  for (const dir of locked.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Already gone.
    }
  }
});

describe("resolvePathLexically (review R-S5, contract CR4)", () => {
  test("follows relative, absolute and chained links like realpath, applying .. to the resolved prefix", () => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-lex-")));
    mkdirSync(path.join(base, "real", "deep", "x"), { recursive: true });
    symlinkSync(path.join(base, "real", "deep"), path.join(base, "hop"));
    symlinkSync("hop/x", path.join(base, "chain"));
    // `..` after a link is taken from the link's TARGET (real/deep/..), as
    // realpath does, not lexically from `base/hop/..`.
    mkdirSync(path.join(base, "real", "sibling"));
    // Built by hand: `path.join` would collapse `hop/..` lexically.
    const viaDotDot = `${base}/hop/../sibling`;
    expect(resolvePathLexically(viaDotDot)).toEqual({
      path: path.join(base, "real", "sibling"),
      missing: false,
      protectedFolder: null,
      error: null,
    });
    expect(resolvePathLexically(path.join(base, "chain")).path).toBe(path.join(base, "real", "deep", "x"));
    // tmpdir() on macOS goes through /var → /private/var; resolved the same.
    const unresolved = mkdtempSync(path.join(tmpdir(), "agetor-lex-var-"));
    expect(resolvePathLexically(unresolved).path).toBe(realpathSync(unresolved));
  });

  test("a missing component is reported and the rest is joined lexically", () => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-lex-missing-")));
    symlinkSync(path.join(base, "nowhere"), path.join(base, "dangling"));
    const result = resolvePathLexically(path.join(base, "dangling", "a"));
    expect(result.missing).toBe(true);
    expect(result.path).toBe(path.join(base, "nowhere", "a"));
  });

  test("a link loop is an error, not a hang", () => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-lex-loop-")));
    symlinkSync(path.join(base, "b"), path.join(base, "a"));
    symlinkSync(path.join(base, "a"), path.join(base, "b"));
    expect(resolvePathLexically(path.join(base, "a")).error).toContain("too many levels");
  });

  test("stops at a protected folder without stat'ing anything below it", () => {
    const { home, documents, lock } = fakeHome();
    setTccHomeForTests(home);
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-lex-out-")));
    symlinkSync(path.join(documents, "acct"), path.join(outside, "link"));
    lock();
    // With Documents locked, an lstat inside it would fail (EACCES → error);
    // the walk must stop at the folder instead.
    const result = resolvePathLexically(path.join(outside, "link", "sub"));
    expect(result.error).toBeNull();
    expect(result.protectedFolder).toBe("Documents");
    expect(result.path).toBe(path.join(documents, "acct", "sub"));
    // A `..` after an unresolvable component inside the folder cannot climb
    // back out of it.
    const climbing = resolvePathLexically(`${documents}/acct/../../.claude`);
    expect(climbing.protectedFolder).toBe("Documents");
    expect(climbing.error).toBeNull();
  });
});

describe("rootRedirectRefusal (contract CR4)", () => {
  test("a root that became a symlink into a protected folder is refused; nothing below it is touched", () => {
    const { home, documents, lock } = fakeHome();
    setTccHomeForTests(home);
    const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-cr4-")));
    const root = path.join(parent, "acct-home");
    symlinkSync(path.join(documents, "acct"), root);
    lock();
    const reason = rootRedirectRefusal(root, "this account's config directory");
    expect(reason).toContain("this account's config directory now resolves into the macOS-protected folder ~/Documents");
    // A redirected PARENT is the same thing.
    const viaParent = path.join(parent, "via");
    symlinkSync(documents, viaParent);
    expect(rootRedirectRefusal(path.join(viaParent, "acct", ".codex"), "CODEX_HOME")).toContain("~/Documents");
  });

  test("a root saved under a protected folder, a plain root, a missing root and system links are accepted", () => {
    const { home, documents, lock } = fakeHome();
    setTccHomeForTests(home);
    lock();
    // Named by the stored path itself: it was gated as such when saved.
    expect(rootRedirectRefusal(path.join(documents, "acct"), "root")).toBeNull();
    expect(rootRedirectRefusal(path.join(home, ".claude-work"), "root")).toBeNull();
    // `tmpdir()` goes through `/var` → `/private/var` on macOS.
    expect(rootRedirectRefusal(path.join(mkdtempSync(path.join(tmpdir(), "agetor-cr4-ok-")), "not-yet"), "root")).toBeNull();
    if (existsSync("/tmp")) expect(rootRedirectRefusal("/tmp/agetor-cr4-not-there/.claude", "root")).toBeNull();
  });

  test("a root saved under one protected folder that now lands in another is refused", () => {
    const { home, documents } = fakeHome();
    setTccHomeForTests(home);
    mkdirSync(path.join(home, "Desktop", "elsewhere"), { recursive: true });
    symlinkSync(path.join(home, "Desktop", "elsewhere"), path.join(documents, "moved"));
    // Documents is not locked here: the walk stops at Documents anyway, so a
    // link inside a folder the path names is not followed or refused.
    expect(rootRedirectRefusal(path.join(documents, "moved"), "root")).toBeNull();
    // Through a link outside the protected folders into Desktop, though, the
    // stored Documents path does not name Desktop.
    const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-cr4-two-")));
    symlinkSync(path.join(home, "Desktop"), path.join(parent, "d"));
    expect(rootRedirectRefusal(path.join(parent, "d", "elsewhere"), "root")).toContain("~/Desktop");
  });

  test("removeCopiedPaths removes nothing under a redirected root", async () => {
    const { home, documents } = fakeHome();
    setTccHomeForTests(home);
    const recorded = path.join(documents, "acct", "projects", "enc", "s.jsonl");
    mkdirSync(path.dirname(recorded), { recursive: true });
    writeFileSync(recorded, "theirs");
    const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-cr4-rm-")));
    const root = path.join(parent, "acct-home");
    symlinkSync(path.join(documents, "acct"), root);
    const removed = await removeCopiedPaths([path.join(root, "projects", "enc", "s.jsonl")], root, "claude-code", "s");
    expect(removed).toEqual([]);
    expect(readFileSync(recorded, "utf8")).toBe("theirs");
  });
});

describe("removeCopiedPathsDetailed shouldStop", () => {
  test("stops before the next file once asked, retaining the rest", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = (await import("node:path")).default;
    const ft = await import("./harness-file-transfer.ts");
    const root = mkdtempSync(path.join(tmpdir(), "agetor-stop-"));
    const sid = "12121212-1212-4212-8212-121212121212";
    const dir = path.join(root, "projects", "enc", sid, "subagents");
    mkdirSync(dir, { recursive: true });
    const files = ["a.jsonl", "b.jsonl", "c.jsonl"].map((n) => path.join(dir, n));
    for (const f of files) writeFileSync(f, "x");
    let calls = 0;
    const result = await ft.removeCopiedPathsDetailed(files, root, "claude-code", sid, { shouldStop: () => ++calls > 1 });
    expect(result.removed).toEqual(files.slice(0, 1));
    expect(result.retained).toEqual(files.slice(1));
    expect(existsSync(files[1]!)).toBe(true);
    expect(existsSync(files[2]!)).toBe(true);
  });
});
