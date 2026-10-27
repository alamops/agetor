import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PATH_NOT_ACCESSIBLE_MESSAGE,
  PROJECT_TREE_TAR_MAX_BYTES,
  callerProjectTree,
  gateCallerPath,
  probePaths,
  type ProbeKind,
} from "./caller-fs.ts";
import { getDisclaimSwitch, setDisclaimSwitch } from "./disclaim.ts";
import { PROJECT_CAPABILITY_PATHSPECS, diskProjectTree, type ProjectTree } from "./ref-tree.ts";

// Under `bun test` disclaim is unavailable (no AGETOR_DISCLAIM_BIN), so the
// CLI path runs the very same child undisclaimed. One block below installs a
// recording stub to prove the child really goes through the helper.

const scratch = mkdtempSync(path.join(tmpdir(), "caller-fs-"));
const ORIGINAL_DISCLAIM_BIN = process.env.AGETOR_DISCLAIM_BIN;
const ORIGINAL_SWITCH = getDisclaimSwitch();

afterEach(() => {
  if (ORIGINAL_DISCLAIM_BIN === undefined) delete process.env.AGETOR_DISCLAIM_BIN;
  else process.env.AGETOR_DISCLAIM_BIN = ORIGINAL_DISCLAIM_BIN;
  setDisclaimSwitch(ORIGINAL_SWITCH);
});

afterAll(() => {
  // chmod'd dirs would block the recursive rm.
  try {
    chmodSync(path.join(scratch, "locked"), 0o755);
  } catch {
    // not created
  }
  rmSync(scratch, { recursive: true, force: true });
});

const fx = {
  dir: path.join(scratch, "a dir"),
  file: path.join(scratch, "a file.txt"),
  linkToDir: path.join(scratch, "link-to-dir"),
  linkToFile: path.join(scratch, "link-to-file"),
  dangling: path.join(scratch, "dangling"),
  missing: path.join(scratch, "nope", "nada"),
  nl: path.join(scratch, "new\nline"),
  dashDir: path.join(scratch, "dash"),
  locked: path.join(scratch, "locked"),
  fifo: path.join(scratch, "fifo"),
};

beforeAll(() => {
  mkdirSync(fx.dir);
  writeFileSync(fx.file, "x");
  symlinkSync(fx.dir, fx.linkToDir);
  symlinkSync(fx.file, fx.linkToFile);
  symlinkSync(path.join(scratch, "does-not-exist"), fx.dangling);
  writeFileSync(fx.nl, "x");
  mkdirSync(fx.dashDir);
  writeFileSync(path.join(fx.dashDir, "-leading"), "x");
  mkdirSync(path.join(fx.locked, "child"), { recursive: true });
  Bun.spawnSync(["/usr/bin/mkfifo", fx.fifo]);
});

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("probePaths classification", () => {
  const cases: Array<[string, () => string, ProbeKind]> = [
    ["directory", () => fx.dir, "dir"],
    ["regular file", () => fx.file, "file"],
    ["symlink to a directory", () => fx.linkToDir, "dir"],
    ["symlink to a file", () => fx.linkToFile, "file"],
    ["dangling symlink", () => fx.dangling, "missing"],
    ["missing", () => fx.missing, "missing"],
    ["path through a file (ENOTDIR)", () => path.join(fx.file, "child"), "missing"],
    ["name with a newline", () => fx.nl, "file"],
    ["name with spaces", () => path.join(fx.dir, "..", "a dir"), "dir"],
    ["FIFO", () => fx.fifo, "other"],
    ["empty string", () => "", "missing"],
  ];
  for (const [name, p, want] of cases) {
    test(`${name}: cli and app agree on ${want}`, async () => {
      const [cli] = await probePaths([p()], "cli");
      const [app] = await probePaths([p()], "app");
      expect(cli).toBe(want);
      expect(app).toBe(want);
    });
  }

  test("returns results in input order, one per path", async () => {
    const paths = [fx.file, fx.missing, fx.dir, fx.nl, fx.dangling];
    expect(await probePaths(paths, "cli")).toEqual(["file", "missing", "dir", "file", "missing"]);
    expect(await probePaths([], "cli")).toEqual([]);
  });

  test("a path with a NUL byte is missing and does not break its neighbours", async () => {
    expect(await probePaths([fx.dir, "bad\0path", fx.file], "cli")).toEqual(["dir", "missing", "file"]);
  });

  test("a relative path starting with '-' is a path, not a stat flag", async () => {
    const prev = process.cwd();
    process.chdir(fx.dashDir);
    try {
      expect(await probePaths(["-leading", "-missing", "--", "-f"], "cli")).toEqual(["file", "missing", "missing", "missing"]);
      expect(await probePaths(["-leading"], "app")).toEqual(["file"]);
    } finally {
      process.chdir(prev);
    }
  });

  test("shell metacharacters in a path are data, never executed", async () => {
    const marker = path.join(scratch, "pwned");
    const evil = `$(touch ${marker}); \`touch ${marker}\` ' " \\ ; | & *`;
    expect(await probePaths([evil], "cli")).toEqual(["missing"]);
    expect(existsSync(marker)).toBe(false);
  });

  test.skipIf(isRoot)("a path under a chmod 000 parent is denied", async () => {
    chmodSync(fx.locked, 0o000);
    try {
      const target = path.join(fx.locked, "child");
      expect(await probePaths([target], "cli")).toEqual(["denied"]);
      expect(await probePaths([target], "app")).toEqual(["denied"]);
      // The locked directory itself exists but the child cannot read it: the CLI
      // probe reports that as denied; the app probe is plain stat and says dir.
      expect(await probePaths([fx.locked], "cli")).toEqual(["denied"]);
      expect(await probePaths([fx.locked], "app")).toEqual(["dir"]);
    } finally {
      chmodSync(fx.locked, 0o755);
    }
  });

  test("more than 256 paths are split across children and stay in order", async () => {
    const paths: string[] = [];
    const want: ProbeKind[] = [];
    for (let i = 0; i < 600; i++) {
      const kind = i % 3;
      if (kind === 0) (paths.push(fx.dir), want.push("dir"));
      else if (kind === 1) (paths.push(path.join(scratch, `missing-${i}`)), want.push("missing"));
      else (paths.push(fx.file), want.push("file"));
    }
    expect(await probePaths(paths, "cli")).toEqual(want);
  });

  test("unanswered paths are denied when the child times out", async () => {
    // 1 ms cannot cover a process spawn: the child is killed before it answers.
    const got = await probePaths([fx.dir, fx.file], "cli", { timeoutMs: 1 });
    expect(got).toEqual(["denied", "denied"]);
  });
});

describe("gateCallerPath", () => {
  test("app caller is never refused", async () => {
    expect(await gateCallerPath(fx.dir, "app", "exists")).toBeNull();
    expect(await gateCallerPath(fx.missing, "app", "nearest-ancestor")).toBeNull();
  });

  test("exists: existing and missing paths pass", async () => {
    expect(await gateCallerPath(fx.dir, "cli", "exists")).toBeNull();
    expect(await gateCallerPath(fx.file, "cli", "exists")).toBeNull();
    expect(await gateCallerPath(fx.missing, "cli", "exists")).toBeNull();
  });

  test("nearest-ancestor: a not-yet-existing destination under an existing dir passes", async () => {
    expect(await gateCallerPath(path.join(fx.dir, "a", "b", "c"), "cli", "nearest-ancestor")).toBeNull();
    expect(await gateCallerPath(path.join(scratch, "no", "such", "tree"), "cli", "nearest-ancestor")).toBeNull();
  });

  test.skipIf(isRoot)("a denied path is refused with the pinned 403 body in both modes", async () => {
    chmodSync(fx.locked, 0o000);
    try {
      const target = path.join(fx.locked, "child");
      const expected = { status: 403, error: PATH_NOT_ACCESSIBLE_MESSAGE, code: "path-not-accessible" } as const;
      expect(await gateCallerPath(target, "cli", "exists")).toEqual(expected);
      expect(await gateCallerPath(path.join(target, "new", "dest"), "cli", "nearest-ancestor")).toEqual(expected);
      // The app caller is the user acting directly: not gated.
      expect(await gateCallerPath(target, "app", "exists")).toBeNull();
    } finally {
      chmodSync(fx.locked, 0o755);
    }
  });

  test("refusal copy is the documented sentence", () => {
    expect(PATH_NOT_ACCESSIBLE_MESSAGE).toBe(
      "This path isn't accessible to Agetor's CLI token (macOS protects it for other apps, or a permission prompt is waiting — answer it and try again).",
    );
  });

  test("a stuck child (e.g. a pending TCC prompt) is denied at the timeout, not waited on", async () => {
    // A disclaim stub that sleeps stands in for a child blocked on a prompt.
    const stub = path.join(scratch, "sleepy-disclaim");
    writeFileSync(stub, '#!/bin/sh\nsleep 5\nexec "$@"\n', { mode: 0o755 });
    if (process.platform !== "darwin") return;
    process.env.AGETOR_DISCLAIM_BIN = stub;
    setDisclaimSwitch(true);
    const t0 = Date.now();
    expect(await probePaths([fx.dir], "cli", { timeoutMs: 300 })).toEqual(["denied"]);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

// ---- project tree --------------------------------------------------------

function walkFiles(tree: ProjectTree, rels: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (rel: string) => {
    const kids = tree.list(rel);
    if (kids.length > 0) {
      for (const k of kids) {
        const child = rel ? `${rel}/${k.name}` : k.name;
        if (k.isDir) visit(child);
        else {
          const text = tree.read(child);
          if (text !== null) out.set(child, text);
        }
      }
      return;
    }
    const text = tree.read(rel);
    if (text !== null) out.set(rel, text);
  };
  for (const r of rels) visit(r);
  return out;
}

describe("callerProjectTree", () => {
  const root = path.join(scratch, "proj");
  const longName = "L".repeat(110);

  beforeAll(() => {
    const w = (rel: string, text: string) => {
      const p = path.join(root, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, text);
    };
    w(".claude/skills/x/SKILL.md", "---\nname: x\n---\nbody");
    w(".claude/shared-skill/SKILL.md", "---\nname: shared\n---\n");
    symlinkSync("../shared-skill", path.join(root, ".claude/skills/linked"));
    w(`.claude/skills/${longName}/SKILL.md`, "---\nname: long\n---\n");
    w(".claude/commands/café-日本.md", "# non ascii ✓\n");
    w(".claude/settings.json", '{"enabledPlugins":{}}');
    w(".mcp.json", '{"mcpServers":{}}');
    w("skills/a/SKILL.md", "bare skills dir");
    w(".claude/skills/bom/SKILL.md", "﻿with bom");
    // Excluded by the tar command line; the disk tree would show them.
    w(".claude/skills/x/.git/config", "[core]");
    w(".claude/node_modules/pkg/index.js", "module.exports = 1");
    // Not a capability path: never requested.
    w("src/app.ts", "not requested");
  });

  const parityRoots = PROJECT_CAPABILITY_PATHSPECS;

  test("cli tree matches the live-disk tree for the capability roots", async () => {
    const cli = await callerProjectTree(root, "cli", parityRoots, () => true);
    const disk = diskProjectTree(root);
    const cliFiles = walkFiles(cli, parityRoots);
    const diskFiles = walkFiles(disk, parityRoots);
    // The only legitimate differences are the excluded .git / node_modules.
    for (const k of [...diskFiles.keys()]) {
      if (k.includes("/.git/") || k.includes("/node_modules/")) diskFiles.delete(k);
    }
    expect([...cliFiles.keys()].sort()).toEqual([...diskFiles.keys()].sort());
    for (const [k, v] of diskFiles) expect(cliFiles.get(k)).toBe(v);

    // The cases the plan calls out, asserted directly as well.
    expect(cliFiles.get(".claude/skills/x/SKILL.md")).toContain("name: x");
    expect(cliFiles.get(".claude/skills/linked/SKILL.md")).toContain("name: shared"); // symlinked dir followed
    expect(cliFiles.get(`.claude/skills/${longName}/SKILL.md`)).toContain("name: long"); // > 100-char path
    expect(cliFiles.get(".claude/commands/café-日本.md")).toBe("# non ascii ✓\n");
    expect(cliFiles.get(".claude/skills/bom/SKILL.md")).toBe("﻿with bom"); // BOM preserved
    expect(cliFiles.get(".mcp.json")).toBe('{"mcpServers":{}}'); // a root that is a file
    expect(cliFiles.get("skills/a/SKILL.md")).toBe("bare skills dir");
    expect(cliFiles.has("src/app.ts")).toBe(false);
  });

  test("cli tree excludes .git and node_modules and AppleDouble siblings", async () => {
    const cli = await callerProjectTree(root, "cli", parityRoots, () => true);
    const files = [...walkFiles(cli, parityRoots).keys()];
    expect(files.some((f) => f.includes("/.git/"))).toBe(false);
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(files.some((f) => path.basename(f).startsWith("._"))).toBe(false);
  });

  test("list() shapes match the disk tree for directories that hold files", async () => {
    const cli = await callerProjectTree(root, "cli", parityRoots, () => true);
    const disk = diskProjectTree(root);
    const norm = (t: ProjectTree, d: string) =>
      t
        .list(d)
        .map((e) => `${e.name}:${e.isDir}`)
        .filter((s) => !s.startsWith(".git:") && !s.startsWith("node_modules:"))
        .sort();
    for (const d of [".claude/skills", ".claude/commands", "skills", ".claude/skills/linked"]) {
      expect(norm(cli, d)).toEqual(norm(disk, d));
    }
  });

  test("only files shouldRead accepts are archived", async () => {
    const cli = await callerProjectTree(root, "cli", parityRoots, (rel) => rel.endsWith("SKILL.md"));
    expect(cli.read(".claude/skills/x/SKILL.md")).toContain("name: x");
    expect(cli.read(".mcp.json")).toBeNull();
    expect(cli.list(".claude").map((e) => e.name)).not.toContain("settings.json");
    expect(cli.list(".claude/skills").map((e) => e.name)).toContain("x");
  });

  test("a big unrelated file under .claude/ cannot hide a capability file", async () => {
    const proj = path.join(scratch, "unrelated-big");
    mkdirSync(path.join(proj, ".claude/skills/x"), { recursive: true });
    mkdirSync(path.join(proj, ".claude/junk"), { recursive: true });
    // Sorts and walks BEFORE the skill, and alone exceeds the 8 MB cap.
    writeFileSync(path.join(proj, ".claude/junk/blob.bin"), Buffer.alloc(PROJECT_TREE_TAR_MAX_BYTES + 4096, 0x63));
    writeFileSync(path.join(proj, ".claude/skills/x/SKILL.md"), "---\nname: x\n---\n");
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
    try {
      const tree = await callerProjectTree(proj, "cli", [".claude"], (rel) => rel.endsWith("SKILL.md"));
      expect(tree.read(".claude/skills/x/SKILL.md")).toContain("name: x");
      expect(tree.list(".claude/junk")).toEqual([]);
    } finally {
      console.warn = warn;
    }
    expect(warnings).toEqual([]);
  });

  test("hitting the read cap logs one warning naming the root", async () => {
    const proj = path.join(scratch, "cap-warn");
    mkdirSync(path.join(proj, ".claude/commands"), { recursive: true });
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    for (let i = 0; i < 12; i++) writeFileSync(path.join(proj, `.claude/commands/c${i}.md`), chunk);
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
    try {
      await callerProjectTree(proj, "cli", [".claude"], () => true);
    } finally {
      console.warn = warn;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(proj);
  });

  test("roots that don't exist are skipped instead of failing the archive", async () => {
    const cli = await callerProjectTree(root, "cli", [".codex", ".cursor", ".mcp.json", ".fx"], () => true);
    expect(cli.read(".mcp.json")).toBe('{"mcpServers":{}}');
    const none = await callerProjectTree(root, "cli", [".codex", ".nothing"], () => true);
    expect(none.list("")).toEqual([]);
    const missingRoot = await callerProjectTree(path.join(scratch, "no-such-project"), "cli", parityRoots, () => true);
    expect(missingRoot.list("")).toEqual([]);
  });

  test("a root with spaces and a leading dash path component works", async () => {
    const odd = path.join(scratch, "-odd root with spaces");
    mkdirSync(path.join(odd, ".claude/skills/s"), { recursive: true });
    writeFileSync(path.join(odd, ".claude/skills/s/SKILL.md"), "odd");
    const tree = await callerProjectTree(odd, "cli", parityRoots, () => true);
    expect(tree.read(".claude/skills/s/SKILL.md")).toBe("odd");
  });

  test("app caller gets the live-disk tree (incl. what tar would exclude)", async () => {
    const app = await callerProjectTree(root, "app", parityRoots, () => true);
    expect(app.read(".claude/skills/x/.git/config")).toBe("[core]");
  });

  test("output over the cap is cut: some files survive, the child is stopped, nothing throws", async () => {
    const big = path.join(scratch, "bigproj");
    mkdirSync(path.join(big, ".claude/blob"), { recursive: true });
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    for (let i = 0; i < 24; i++) writeFileSync(path.join(big, `.claude/blob/f${String(i).padStart(2, "0")}.bin`), chunk);
    expect(24 * chunk.length).toBeGreaterThan(PROJECT_TREE_TAR_MAX_BYTES * 2);
    const t0 = Date.now();
    const tree = await callerProjectTree(big, "cli", [".claude"], () => true);
    const listed = tree.list(".claude/blob").length;
    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThanOrEqual(PROJECT_TREE_TAR_MAX_BYTES / chunk.length);
    expect(listed).toBeLessThan(24);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  test("a single file larger than the cap is dropped, not truncated into the tree", async () => {
    const huge = path.join(scratch, "hugeproj");
    mkdirSync(path.join(huge, ".claude"), { recursive: true });
    writeFileSync(path.join(huge, ".claude/huge.bin"), Buffer.alloc(PROJECT_TREE_TAR_MAX_BYTES + 4096, 0x62));
    const tree = await callerProjectTree(huge, "cli", [".claude"], () => true);
    expect(tree.read(".claude/huge.bin")).toBeNull();
    expect(tree.list(".claude")).toEqual([]);
  });
});

// ---- disclaim wiring -----------------------------------------------------

describe.skipIf(process.platform !== "darwin")("disclaimed children", () => {
  function recordingStub(name: string): { stub: string; log: string } {
    const stub = path.join(scratch, name);
    const log = path.join(scratch, `${name}.log`);
    writeFileSync(log, "");
    // Records the program it was asked to run (first argument), then execs it.
    writeFileSync(stub, `#!/bin/sh\necho "$1" >> '${log}'\nexec "$@"\n`, { mode: 0o755 });
    return { stub, log };
  }
  const lines = (log: string) => readFileSync(log, "utf8").split("\n").filter(Boolean);

  test("the probe child runs through the disclaim helper, one child per 256 paths", async () => {
    const { stub, log } = recordingStub("disclaim-probe");
    process.env.AGETOR_DISCLAIM_BIN = stub;
    setDisclaimSwitch(true);
    const paths = Array.from({ length: 600 }, (_, i) => (i % 2 ? fx.dir : fx.missing));
    const got = await probePaths(paths, "cli");
    expect(got[0]).toBe("missing");
    expect(got[1]).toBe("dir");
    expect(lines(log)).toEqual(["/bin/sh", "/bin/sh", "/bin/sh"]); // 256 + 256 + 88
  });

  test("the tar child runs through the disclaim helper", async () => {
    const { stub, log } = recordingStub("disclaim-tar");
    process.env.AGETOR_DISCLAIM_BIN = stub;
    setDisclaimSwitch(true);
    const tree = await callerProjectTree(path.join(scratch, "proj"), "cli", PROJECT_CAPABILITY_PATHSPECS, () => true);
    expect(tree.read(".mcp.json")).toBe('{"mcpServers":{}}');
    // First the enumeration (find), then the archive of the accepted members (tar).
    expect(lines(log)).toEqual(["/usr/bin/find", "/usr/bin/tar"]);
  });

  test("with the switch off the child runs directly, with no helper", async () => {
    const { stub, log } = recordingStub("disclaim-off");
    process.env.AGETOR_DISCLAIM_BIN = stub;
    setDisclaimSwitch(false);
    expect(await probePaths([fx.dir], "cli")).toEqual(["dir"]);
    expect(lines(log)).toEqual([]);
  });

  test("the app caller never spawns anything", async () => {
    const { stub, log } = recordingStub("disclaim-app");
    process.env.AGETOR_DISCLAIM_BIN = stub;
    setDisclaimSwitch(true);
    expect(await probePaths([fx.dir, fx.missing], "app")).toEqual(["dir", "missing"]);
    expect(await gateCallerPath(fx.missing, "app", "nearest-ancestor")).toBeNull();
    const tree = await callerProjectTree(path.join(scratch, "proj"), "app", PROJECT_CAPABILITY_PATHSPECS, () => true);
    expect(tree.read(".mcp.json")).toBe('{"mcpServers":{}}');
    expect(lines(log)).toEqual([]);
  });

  test("the child env never carries the master API token", async () => {
    const stub = path.join(scratch, "disclaim-env");
    const out = path.join(scratch, "disclaim-env.out");
    writeFileSync(stub, `#!/bin/sh\nenv > '${out}'\nexec "$@"\n`, { mode: 0o755 });
    process.env.AGETOR_DISCLAIM_BIN = stub;
    setDisclaimSwitch(true);
    const prev = process.env.AGETOR_API_TOKEN;
    process.env.AGETOR_API_TOKEN = "secret-master-token";
    try {
      await probePaths([fx.dir], "cli");
    } finally {
      if (prev === undefined) delete process.env.AGETOR_API_TOKEN;
      else process.env.AGETOR_API_TOKEN = prev;
    }
    const env = readFileSync(out, "utf8");
    expect(env).not.toContain("secret-master-token");
    expect(env).toContain("LC_ALL=C");
  });
});
