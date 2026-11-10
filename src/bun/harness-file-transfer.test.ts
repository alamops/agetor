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
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  atomicWriteFile,
  copyRegularFileDetailed,
  copyTreeCooperative,
  removeCopiedPaths,
  resolvePathLexically,
  rootRedirectRefusal,
  setStaleTempAgeForTests,
  setTccHomeForTests,
  sweepStaleTempFiles,
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
  test("asked before the first file: a yes retains everything, a no removes everything", async () => {
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
    const stopped = await ft.removeCopiedPathsDetailed(files, root, "claude-code", sid, { shouldStop: () => true });
    expect(stopped.removed).toEqual([]);
    expect(stopped.retained).toEqual(files);
    for (const f of files) expect(existsSync(f)).toBe(true);
    let calls = 0;
    const done = await ft.removeCopiedPathsDetailed(files, root, "claude-code", sid, { shouldStop: () => (calls++, false) });
    expect(done.removed).toEqual(files);
    // Asked once, not per file: nothing else can run between two yields.
    expect(calls).toBe(1);
  });
});

describe("stale .agetor-tmp-* leftovers (review N3)", () => {
  afterEach(() => setStaleTempAgeForTests(null));

  function plant(dir: string) {
    const outside = path.join(mkdtempSync(path.join(tmpdir(), "agetor-sweep-outside-")), "target.txt");
    writeFileSync(outside, "keep");
    const file = path.join(dir, `.agetor-tmp-${randomUUID()}`);
    const link = path.join(dir, `.agetor-tmp-${randomUUID()}`);
    const folder = path.join(dir, `.agetor-tmp-${randomUUID()}`);
    const lookalike = path.join(dir, ".agetor-tmp-backup.json");
    writeFileSync(file, "half a write");
    symlinkSync(outside, link);
    mkdirSync(folder);
    writeFileSync(path.join(folder, "inner"), "x");
    writeFileSync(lookalike, "not ours");
    return { outside, file, link, folder, lookalike };
  }

  test("a write into a folder removes old temp files and temp links there, never a folder, a look-alike or a link's target", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agetor-sweep-"));
    const t = plant(dir);
    setStaleTempAgeForTests(0);
    await atomicWriteFile(path.join(dir, "settings.json"), "{}");
    expect(existsSync(t.file)).toBe(false);
    expect(existsSync(t.link)).toBe(false);
    expect(readFileSync(t.outside, "utf8")).toBe("keep");
    expect(readFileSync(path.join(t.folder, "inner"), "utf8")).toBe("x");
    expect(readFileSync(t.lookalike, "utf8")).toBe("not ours");
    expect(readFileSync(path.join(dir, "settings.json"), "utf8")).toBe("{}");
  });

  test("a session-transfer style file copy sweeps its destination folder too", async () => {
    const src = mkdtempSync(path.join(tmpdir(), "agetor-sweep-src-"));
    const dest = mkdtempSync(path.join(tmpdir(), "agetor-sweep-dest-"));
    writeFileSync(path.join(src, "s.jsonl"), "{}\n");
    const t = plant(dest);
    setStaleTempAgeForTests(0);
    await copyRegularFileDetailed(path.join(src, "s.jsonl"), path.join(dest, "s.jsonl"));
    expect(existsSync(t.file)).toBe(false);
    expect(existsSync(t.link)).toBe(false);
    expect(readFileSync(path.join(dest, "s.jsonl"), "utf8")).toBe("{}\n");
  });

  test("a fresh temp file (a write in progress) is kept, even with an old mtime stamped on it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agetor-sweep-fresh-"));
    const live = path.join(dir, `.agetor-tmp-${randomUUID()}`);
    writeFileSync(live, "copying");
    // A mirror copy stamps the source's mtime on its temp file before the
    // rename; the inode change time stays fresh.
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(live, old, old);
    setStaleTempAgeForTests(null);
    expect(sweepStaleTempFiles(dir)).toBe(0);
    expect(existsSync(live)).toBe(true);
  });

  test("one sweep per folder per interval", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agetor-sweep-memo-"));
    setStaleTempAgeForTests(0);
    expect(sweepStaleTempFiles(dir)).toBe(0);
    writeFileSync(path.join(dir, `.agetor-tmp-${randomUUID()}`), "later");
    expect(sweepStaleTempFiles(dir)).toBe(0);
    setStaleTempAgeForTests(0);
    expect(sweepStaleTempFiles(dir)).toBe(1);
  });
});

describe("temp-file mode is set by descriptor (re-review nit)", () => {
  test("a link swapped in at the temp name is never chmod-ed through", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agetor-fchmod-"));
    const victim = path.join(mkdtempSync(path.join(tmpdir(), "agetor-fchmod-victim-")), "victim.txt");
    writeFileSync(victim, "outside");
    chmodSync(victim, 0o600);
    const writing = atomicWriteFile(path.join(dir, "out.sh"), "x".repeat(4 * 1024 * 1024), { mode: 0o755 });
    let done = false;
    const settled = writing.then(() => { done = true; }, () => { done = true; });
    let swapped = false;
    const { renameSync } = await import("node:fs");
    while (!done) {
      if (!swapped) {
        const tmp = readdirSync(dir).find((n) => n.startsWith(".agetor-tmp-"));
        if (tmp) {
          // An agent replaces the temp file with a link before the mode is set.
          const link = path.join(path.dirname(victim), "link");
          symlinkSync(victim, link);
          renameSync(link, path.join(dir, tmp));
          swapped = true;
        }
      }
      await Bun.sleep(0);
    }
    await settled;
    expect(swapped).toBe(true);
    expect(statSync(victim).mode & 0o777).toBe(0o600);
  });
});
