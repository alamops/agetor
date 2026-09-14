import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  diskProjectTree,
  emptyProjectTree,
  refProjectTree,
  loadRefProjectTree,
} from "./ref-tree.ts";

// ref-tree.ts has no db.ts / worktree.ts import (only node:fs, node:path, and
// Bun.spawn), so unlike commands.test.ts there's no AGETOR_DATA_DIR ordering
// concern here — but `bun test` may load this file in the same process as
// commands.test.ts, which DOES set AGETOR_DATA_DIR before its dynamic
// import. Nothing in this file touches that, so no interaction either way.

// --- fixture repo ----------------------------------------------------------

/** Run git in `cwd`, throwing with stderr on a non-zero exit. */
function git(args: string[], cwd: string): { stdout: string } {
  const res = Bun.spawnSync(["git", ...args], { cwd });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed: ${res.stderr.toString()}`);
  }
  return { stdout: res.stdout.toString() };
}

const ALPHA_SKILL_MD = [
  "---",
  "description: descrição — ✓",
  "---",
  "",
  "Multi-line body",
  "with a second line",
  "and a third línea → ✓",
  "",
].join("\n");

let repo: string;
let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "agetor-reftree-"));
  repo = mkdtempSync(path.join(tmpRoot, "repo-"));

  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "test"], repo);
  git(["config", "commit.gpgsign", "false"], repo);

  const write = (rel: string, content: string) => {
    const abs = path.join(repo, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  write("README.md", "hello\n");
  write(".claude/commands/top.md", "top-level command\n");
  write(".claude/commands/nested/child.md", "nested command\n");
  write(".claude/skills/alpha/SKILL.md", ALPHA_SKILL_MD);
  write(".claude/skills/alpha/extra.md", "extra supporting doc\n");
  write(".mcp.json", JSON.stringify({ mcpServers: { x: { command: "y" } } }));
  write(".claude/settings.json", ""); // zero-length on purpose
  write(".codex/prompts/p.md", "codex prompt\n");
  write("src/app.ts", "export const x = 1;\n"); // outside the default pathspecs

  git(["add", "."], repo);
  git(["commit", "-q", "-m", "init"], repo);

  // Side branch adding a skill that must not be visible from `main`.
  git(["checkout", "-q", "-b", "feature/x"], repo);
  write(".claude/skills/beta/SKILL.md", "---\ndescription: Beta\n---\nbody\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "add beta"], repo);

  git(["checkout", "-q", "main"], repo);

  // Untracked-on-disk skill, present only in the working tree, never committed.
  write(".claude/skills/untracked/SKILL.md", "---\ndescription: Untracked\n---\nbody\n");
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// --- loadRefProjectTree: main ref, default pathspecs ------------------------

describe("loadRefProjectTree — main ref, default pathspecs", () => {
  test("list('') has .claude/.codex/.mcp.json with correct isDir, nothing outside the pathspecs", async () => {
    const tree = await loadRefProjectTree(repo, "main");
    expect(tree).not.toBeNull();
    const root = tree!.list("");
    const byName = new Map(root.map((e) => [e.name, e.isDir]));
    expect(byName.get(".claude")).toBe(true);
    expect(byName.get(".codex")).toBe(true);
    expect(byName.get(".mcp.json")).toBe(false);
    // README.md and src/ are outside the default pathspecs entirely.
    expect(byName.has("README.md")).toBe(false);
    expect(byName.has("src")).toBe(false);
  });

  test("list('.claude/commands') has top.md (file) + nested (dir)", async () => {
    const tree = await loadRefProjectTree(repo, "main");
    const entries = tree!.list(".claude/commands");
    const byName = new Map(entries.map((e) => [e.name, e.isDir]));
    expect(byName.get("top.md")).toBe(false);
    expect(byName.get("nested")).toBe(true);
  });

  test("list('.claude/skills') has alpha, not beta, not untracked", async () => {
    const tree = await loadRefProjectTree(repo, "main");
    const names = tree!.list(".claude/skills").map((e) => e.name).sort();
    expect(names).toEqual(["alpha"]);
  });

  test("read() returns the exact committed UTF-8 text, including non-ASCII", async () => {
    const tree = await loadRefProjectTree(repo, "main");
    expect(tree!.read(".claude/skills/alpha/SKILL.md")).toBe(ALPHA_SKILL_MD);
  });

  test("read() on a zero-length committed file returns '' (not null)", async () => {
    const tree = await loadRefProjectTree(repo, "main");
    expect(tree!.read(".claude/settings.json")).toBe("");
  });

  test("read()/list() outside the pathspecs see nothing", async () => {
    const tree = await loadRefProjectTree(repo, "main");
    expect(tree!.read("src/app.ts")).toBeNull();
    expect(tree!.list("src")).toEqual([]);
  });

  test("read() on a path that was never listed returns null", async () => {
    const tree = await loadRefProjectTree(repo, "main");
    expect(tree!.read("nope")).toBeNull();
  });
});

// --- loadRefProjectTree: feature branch -------------------------------------

test("loadRefProjectTree at feature/x shows the branch-only skill", async () => {
  const tree = await loadRefProjectTree(repo, "feature/x");
  expect(tree).not.toBeNull();
  const names = tree!.list(".claude/skills").map((e) => e.name).sort();
  expect(names).toEqual(["alpha", "beta"]);
});

// --- shouldRead filter -------------------------------------------------------

test("shouldRead filters which listed files get content, without removing them from list()", async () => {
  const tree = await loadRefProjectTree(repo, "main", {
    shouldRead: (p) => p !== ".claude/skills/alpha/extra.md",
  });
  expect(tree).not.toBeNull();
  const names = tree!.list(".claude/skills/alpha").map((e) => e.name).sort();
  expect(names).toEqual(["SKILL.md", "extra.md"]);
  // Listed, but shouldRead rejected it -> null.
  expect(tree!.read(".claude/skills/alpha/extra.md")).toBeNull();
  // Listed AND accepted -> real content.
  expect(tree!.read(".claude/skills/alpha/SKILL.md")).toBe(ALPHA_SKILL_MD);
});

// --- custom pathspecs ---------------------------------------------------------

test("custom pathspecs option is respected", async () => {
  const tree = await loadRefProjectTree(repo, "main", { pathspecs: ["src"] });
  expect(tree).not.toBeNull();
  // Now in-scope.
  expect(tree!.read("src/app.ts")).toBe("export const x = 1;\n");
  // .claude is no longer in scope at all -> not even listed.
  expect(tree!.list("")).toEqual([{ name: "src", isDir: true }]);
  expect(tree!.read(".claude/skills/alpha/SKILL.md")).toBeNull();
});

// --- origin-only ref ----------------------------------------------------------

test("a ref that exists only as refs/remotes/origin/<ref> resolves via the retry", async () => {
  const featureSha = git(["rev-parse", "feature/x"], repo).stdout.trim();
  git(["update-ref", "refs/remotes/origin/only-remote", featureSha], repo);
  const tree = await loadRefProjectTree(repo, "only-remote");
  expect(tree).not.toBeNull();
  const names = tree!.list(".claude/skills").map((e) => e.name).sort();
  expect(names).toEqual(["alpha", "beta"]);
});

// --- resolution failure modes -------------------------------------------------

describe("resolution failures return null (never throw)", () => {
  test("unknown ref", async () => {
    const tree = await loadRefProjectTree(repo, "totally-unknown-ref-xyz");
    expect(tree).toBeNull();
  });

  test("leading-dash ref is rejected without spawning git", async () => {
    expect(await loadRefProjectTree(repo, "-x")).toBeNull();
    expect(await loadRefProjectTree(repo, "--output=x")).toBeNull();
  });

  test("non-git directory", async () => {
    const plain = mkdtempSync(path.join(tmpRoot, "not-a-repo-"));
    const tree = await loadRefProjectTree(plain, "main");
    expect(tree).toBeNull();
  });

  test("nonexistent directory", async () => {
    const tree = await loadRefProjectTree(path.join(tmpRoot, "does-not-exist-at-all"), "main");
    expect(tree).toBeNull();
  });
});

// --- subdir cwd ----------------------------------------------------------------

test("resolves root-relative paths (--full-tree) even when dir is a repo subdirectory", async () => {
  const tree = await loadRefProjectTree(path.join(repo, "src"), "main");
  expect(tree).not.toBeNull();
  expect(tree!.read(".claude/skills/alpha/SKILL.md")).toBe(ALPHA_SKILL_MD);
  const root = tree!.list("");
  expect(root.some((e) => e.name === ".claude" && e.isDir)).toBe(true);
});

// --- refProjectTree (pure, map-backed) ------------------------------------------

describe("refProjectTree", () => {
  test("derives directories from path prefixes and answers list/read", () => {
    const tree = refProjectTree(new Map([["a/b/c.md", "x"], ["a/d.md", null]]));
    expect(tree.list("")).toEqual([{ name: "a", isDir: true }]);
    const aEntries = tree.list("a");
    const byName = new Map(aEntries.map((e) => [e.name, e.isDir]));
    expect(byName.get("b")).toBe(true);
    expect(byName.get("d.md")).toBe(false);
    expect(tree.read("a/d.md")).toBeNull(); // listed, value null -> unread
    expect(tree.read("a/b/c.md")).toBe("x");
  });

  test("normalizeRel strips a trailing slash but NOT a leading './'", () => {
    const tree = refProjectTree(new Map([["a/b/c.md", "x"], ["a/d.md", null]]));
    // Trailing slash is stripped, so this is equivalent to list("a").
    expect(tree.list("a/")).toEqual(tree.list("a"));
    // A leading "./" is NOT stripped by normalizeRel, so this key never
    // matches the stored "a/d.md" — read() returns null, same as any other
    // miss. This pins the observed contract, not an assumed "nice" behavior.
    expect(tree.read("./a/d.md")).toBeNull();
  });
});

// --- diskProjectTree -------------------------------------------------------------

describe("diskProjectTree", () => {
  test("mirrors disk entries; a symlinked directory counts as a dir", () => {
    const root = mkdtempSync(path.join(tmpRoot, "disk-"));
    mkdirSync(path.join(root, "realdir"));
    writeFileSync(path.join(root, "realdir", "f.txt"), "hi");
    writeFileSync(path.join(root, "file.txt"), "content");
    symlinkSync(path.join(root, "realdir"), path.join(root, "linkdir"));

    const tree = diskProjectTree(root);
    const entries = tree.list("");
    const byName = new Map(entries.map((e) => [e.name, e.isDir]));
    expect(byName.get("realdir")).toBe(true);
    expect(byName.get("file.txt")).toBe(false);
    expect(byName.get("linkdir")).toBe(true);

    expect(tree.read("file.txt")).toBe("content");
    expect(tree.list("realdir").map((e) => e.name)).toEqual(["f.txt"]);
  });

  test("missing dir/file -> []/null, without throwing", () => {
    const root = mkdtempSync(path.join(tmpRoot, "disk-missing-"));
    const tree = diskProjectTree(root);
    expect(tree.list("nope-dir")).toEqual([]);
    expect(tree.read("nope-file")).toBeNull();
  });

  test("a root that doesn't exist at all -> []/null", () => {
    const tree = diskProjectTree(path.join(tmpRoot, "no-such-root-at-all"));
    expect(tree.list("")).toEqual([]);
    expect(tree.read("x")).toBeNull();
  });

  test("an unreadable file -> read() null, not a throw", () => {
    const root = mkdtempSync(path.join(tmpRoot, "disk-unreadable-"));
    const p = path.join(root, "secret.txt");
    writeFileSync(p, "shh");
    chmodSync(p, 0o000);
    try {
      const tree = diskProjectTree(root);
      expect(tree.read("secret.txt")).toBeNull();
    } finally {
      chmodSync(p, 0o644);
    }
  });
});

// --- emptyProjectTree -------------------------------------------------------------

test("emptyProjectTree always answers empty/missing", () => {
  const tree = emptyProjectTree();
  expect(tree.list("")).toEqual([]);
  expect(tree.read("anything")).toBeNull();
});
