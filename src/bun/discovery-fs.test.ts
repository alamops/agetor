import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDisclaimSwitch, setDisclaimSwitch } from "./disclaim.ts";
import {
  __clearDisclaimedJsonCacheForTest,
  __setLoadTimeoutMsForTest,
  discoveryFs,
  disclaimedDiscoveryFs,
  inProcessDiscoveryFs,
  markdownTree,
  safeReadJsonCached,
  singleFile,
  skillsDir,
} from "./discovery-fs.ts";

// commands.ts pulls in worktree.ts -> db.ts, which opens sqlite at module load:
// point it at a temp dir before the dynamic import (same pattern as commands.test.ts).
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-discovery-fs-db-"));
const { listAgentCapabilities } = await import("./commands.ts");

const scratch = mkdtempSync(path.join(tmpdir(), "discovery-fs-"));
const ORIGINAL_DISCLAIM_BIN = process.env.AGETOR_DISCLAIM_BIN;
const ORIGINAL_SWITCH = getDisclaimSwitch();

afterEach(() => {
  if (ORIGINAL_DISCLAIM_BIN === undefined) delete process.env.AGETOR_DISCLAIM_BIN;
  else process.env.AGETOR_DISCLAIM_BIN = ORIGINAL_DISCLAIM_BIN;
  setDisclaimSwitch(ORIGINAL_SWITCH);
  __clearDisclaimedJsonCacheForTest();
  __setLoadTimeoutMsForTest(null);
});

afterAll(() => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function w(file: string, body: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}

let counter = 0;
/** A passthrough disclaim stub that records the program each child runs. */
function recordingStub(): { log: string; children: () => string[] } {
  const name = `stub-${counter++}`;
  const stub = path.join(scratch, name);
  const log = path.join(scratch, `${name}.log`);
  writeFileSync(log, "");
  writeFileSync(stub, `#!/bin/sh\necho "$1" >> '${log}'\nexec "$@"\n`, { mode: 0o755 });
  process.env.AGETOR_DISCLAIM_BIN = stub;
  setDisclaimSwitch(true);
  return { log, children: () => readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

describe("discoveryFs() selection", () => {
  test("in-process while the switch is off, even with a helper present", () => {
    recordingStub();
    setDisclaimSwitch(false);
    expect(discoveryFs()).toBe(inProcessDiscoveryFs);
  });

  test.skipIf(process.platform !== "darwin")("disclaimed while the switch is on and the helper is present", () => {
    recordingStub();
    expect(discoveryFs()).toBe(disclaimedDiscoveryFs);
  });

  test("in-process under test without a helper", () => {
    delete process.env.AGETOR_DISCLAIM_BIN;
    setDisclaimSwitch(true);
    expect(discoveryFs().disclaimed).toBe(false);
  });
});

describe("in-process reads (switch off)", () => {
  test("a plain and an account-mode read of one file share one cache entry", () => {
    setDisclaimSwitch(false);
    const file = path.join(scratch, "shared-key", ".claude.json");
    w(file, JSON.stringify({ projects: {} }));
    const plain = safeReadJsonCached(file);
    expect(plain).toEqual({ projects: {} });
    // Same object: parsed once, not once per key.
    expect(safeReadJsonCached(file, { accountFile: true })).toBe(plain);
  });

  test.skipIf(process.platform === "win32")("a FIFO under a discovered name is refused without blocking", async () => {
    setDisclaimSwitch(false);
    const dir = path.join(scratch, "fifo-project");
    mkdirSync(path.join(dir, ".claude", "commands"), { recursive: true });
    for (const rel of [".mcp.json", ".claude/commands/x.md", ".claude.json"]) {
      expect(Bun.spawnSync(["/usr/bin/mkfifo", path.join(dir, rel)]).exitCode).toBe(0);
    }
    expect(safeReadJsonCached(path.join(dir, ".claude.json"))).toBeNull();
    expect(safeReadJsonCached(path.join(dir, ".claude.json"), { accountFile: true })).toBeNull();
    const reader = await inProcessDiscoveryFs.load([]);
    expect(reader.text(path.join(dir, ".mcp.json"))).toBeNull();
    expect(reader.json(path.join(dir, ".mcp.json"))).toBeNull();
    expect(reader.tree(dir).read(".claude/commands/x.md")).toBeNull();
  });
});

describe.skipIf(process.platform !== "darwin")("disclaimed load()", () => {
  const cfg = path.join(scratch, "cfg");
  const outside = path.join(scratch, "outside-the-config-dir");

  beforeAll(() => {
    w(path.join(cfg, "commands/a.md"), "# a");
    w(path.join(cfg, "commands/sub/b.md"), "# b");
    w(path.join(cfg, "commands/readme.txt"), "not markdown");
    w(path.join(cfg, "skills/real/SKILL.md"), "real skill");
    w(path.join(cfg, "skills/real/assets/big.bin"), "x".repeat(1000));
    w(path.join(cfg, "skills/real/deep/SKILL.md"), "too deep");
    w(path.join(cfg, "skills/node_modules/pkg/SKILL.md"), "pruned");
    w(path.join(cfg, "settings.json"), '{"enabledPlugins":{}}');
    // A planted symlink: a skill folder that points outside the config dir.
    w(path.join(outside, "SKILL.md"), "from behind a symlink");
    symlinkSync(outside, path.join(cfg, "skills/linked"));
    symlinkSync("/nonexistent-target", path.join(cfg, "skills/dangling"));
  });

  test("reads exactly the selected files, one find per (depth, name) and one tar, following symlinks inside them", async () => {
    const { children } = recordingStub();
    const reader = await disclaimedDiscoveryFs.load([
      markdownTree(path.join(cfg, "commands")),
      skillsDir(path.join(cfg, "skills")),
      singleFile(path.join(cfg, "settings.json")),
      singleFile(path.join(scratch, "does-not-exist.json")),
    ]);
    // Direct children only (no shell pipeline the timeout could not reach into).
    expect(children().sort()).toEqual(["/usr/bin/find", "/usr/bin/find", "/usr/bin/find", "/usr/bin/tar"]);

    const tree = reader.tree(cfg);
    expect(tree.read("commands/a.md")).toBe("# a");
    expect(tree.read("commands/sub/b.md")).toBe("# b");
    expect(tree.read("commands/readme.txt")).toBeNull(); // not selected
    expect(tree.read("skills/real/SKILL.md")).toBe("real skill");
    expect(tree.read("skills/real/assets/big.bin")).toBeNull(); // never archived
    expect(tree.read("skills/real/deep/SKILL.md")).toBeNull(); // past maxDepth
    expect(tree.read("skills/node_modules/pkg/SKILL.md")).toBeNull(); // pruned
    expect(tree.read("skills/linked/SKILL.md")).toBe("from behind a symlink");
    expect(tree.list("skills").map((e) => e.name).sort()).toEqual(["linked", "real"]);
    expect(reader.text(path.join(cfg, "settings.json"))).toBe('{"enabledPlugins":{}}');
    expect(reader.json(path.join(cfg, "settings.json"))).toEqual({ enabledPlugins: {} });
    expect(reader.text(path.join(scratch, "does-not-exist.json"))).toBeNull();
  });

  test("a missing root yields an empty tree; no selectors spawn nothing", async () => {
    const { children } = recordingStub();
    const reader = await disclaimedDiscoveryFs.load([skillsDir(path.join(scratch, "no-such-dir"))]);
    expect(reader.tree(path.join(scratch, "no-such-dir")).list("")).toEqual([]);
    // Nothing listed, so no tar.
    expect(children()).toEqual(["/usr/bin/find"]);
    await disclaimedDiscoveryFs.load([]);
    expect(children()).toEqual(["/usr/bin/find"]);
  });

  test("paths with spaces, a leading dash component and unicode survive", async () => {
    recordingStub();
    const odd = path.join(scratch, "-odd dir ✓");
    w(path.join(odd, "skills/s p/SKILL.md"), "odd");
    const reader = await disclaimedDiscoveryFs.load([skillsDir(path.join(odd, "skills"))]);
    expect(reader.tree(odd).read("skills/s p/SKILL.md")).toBe("odd");
  });

  test("a big unrelated file next to a skill cannot hide it (nothing but selected files is archived)", async () => {
    recordingStub();
    const root = path.join(scratch, "bigroot");
    w(path.join(root, "skills/x/SKILL.md"), "needle");
    writeFileSync(path.join(root, "skills/x/huge.bin"), Buffer.alloc(9 * 1024 * 1024, 0x61));
    const reader = await disclaimedDiscoveryFs.load([skillsDir(path.join(root, "skills"))]);
    expect(reader.tree(root).read("skills/x/SKILL.md")).toBe("needle");
  });

  test("a lower-case skill.md is read like the in-process read on a case-insensitive volume", async () => {
    recordingStub();
    const root = path.join(scratch, "caseroot");
    w(path.join(root, "skills/lower/skill.md"), "lower-case name");
    w(path.join(root, "skills/upper/SKILL.md"), "exact name");
    const reader = await disclaimedDiscoveryFs.load([skillsDir(path.join(root, "skills"))]);
    const tree = reader.tree(root);
    expect(tree.read("skills/lower/SKILL.md")).toBe("lower-case name");
    expect(tree.read("skills/upper/SKILL.md")).toBe("exact name");
    // Same answer as the in-process read wherever the volume folds case (the
    // default APFS volume does).
    if (existsSync(path.join(root, "skills/lower/SKILL.md"))) {
      const inProcess = (await inProcessDiscoveryFs.load([])).tree(root);
      expect(inProcess.read("skills/lower/SKILL.md")).toBe("lower-case name");
    }
  });

  test("a find that never finishes is killed and load() returns near the deadline", async () => {
    // A helper that turns every `find` into a process that never exits and
    // leaves a grandchild holding stdout — the worst case for the old shell
    // pipeline, whose kill reached only `sh`.
    const name = `hang-stub-${counter++}`;
    const stub = path.join(scratch, name);
    writeFileSync(
      stub,
      `#!/bin/sh
if [ "$1" = /usr/bin/find ]; then /bin/sleep 3 & exec /bin/sleep 3; fi
exec "$@"
`,
      { mode: 0o755 },
    );
    process.env.AGETOR_DISCLAIM_BIN = stub;
    setDisclaimSwitch(true);
    __setLoadTimeoutMsForTest(300);
    const started = Date.now();
    const reader = await disclaimedDiscoveryFs.load([skillsDir(path.join(cfg, "skills"))]);
    const elapsed = Date.now() - started;
    expect(reader.tree(cfg).list("")).toEqual([]);
    // timeout (300 ms) + kill grace (1 s) + slack, well short of the 3 s hang.
    expect(elapsed).toBeLessThan(2_200);
  });

  test("hitting the read cap logs one warning naming the root", async () => {
    recordingStub();
    const root = path.join(scratch, "caproot");
    for (let i = 0; i < 12; i++) w(path.join(root, `commands/c${i}.md`), "y".repeat(1024 * 1024));
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
    try {
      await disclaimedDiscoveryFs.load([markdownTree(path.join(root, "commands"))]);
    } finally {
      console.warn = warn;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(path.join(root, "commands"));
  });
});

describe.skipIf(process.platform !== "darwin")("disclaimed readJsonCached()", () => {
  test("parses, re-reads only when mtime+size change, and answers null when missing", async () => {
    recordingStub();
    const file = path.join(scratch, "claude.json");
    const T = 1_700_000_000; // whole seconds, so a restored mtime matches exactly
    w(file, '{"v":1}');
    utimesSync(file, T, T);
    expect(await disclaimedDiscoveryFs.readJsonCached(file)).toEqual({ v: 1 });

    // Same size, same mtime, different bytes: the cache key still matches, so
    // the old parse is returned (proves the content was not re-read).
    writeFileSync(file, '{"v":2}');
    utimesSync(file, T, T);
    expect(await disclaimedDiscoveryFs.readJsonCached(file)).toEqual({ v: 1 });

    // A size change invalidates it.
    writeFileSync(file, '{"v":22}');
    utimesSync(file, T, T);
    expect(await disclaimedDiscoveryFs.readJsonCached(file)).toEqual({ v: 22 });

    // So does a new mtime.
    writeFileSync(file, '{"v":33}');
    utimesSync(file, T + 5, T + 5);
    expect(await disclaimedDiscoveryFs.readJsonCached(file)).toEqual({ v: 33 });

    expect(await disclaimedDiscoveryFs.readJsonCached(path.join(scratch, "missing.json"))).toBeNull();
    writeFileSync(file, "not json");
    utimesSync(file, T + 9, T + 9);
    expect(await disclaimedDiscoveryFs.readJsonCached(file)).toBeNull();
  });

  test("follows a symlink inside the child", async () => {
    recordingStub();
    const real = path.join(scratch, "real-claude.json");
    const link = path.join(scratch, "link-claude.json");
    w(real, '{"via":"link"}');
    symlinkSync(real, link);
    expect(await disclaimedDiscoveryFs.readJsonCached(link)).toEqual({ via: "link" });
  });

  test("a FIFO answers null at once instead of blocking cat until the timeout", async () => {
    recordingStub();
    __setLoadTimeoutMsForTest(5_000);
    const fifo = path.join(scratch, "fifo-claude.json");
    expect(Bun.spawnSync(["/usr/bin/mkfifo", fifo]).exitCode).toBe(0);
    for (let i = 0; i < 2; i++) {
      const started = performance.now();
      expect(await disclaimedDiscoveryFs.readJsonCached(fifo)).toBeNull();
      // Well under the 5 s budget a blocked `cat` would use up, every time.
      expect(performance.now() - started).toBeLessThan(2_000);
    }
  });
});

describe.skipIf(process.platform !== "darwin")("listAgentCapabilities through the disclaimed child", () => {
  const home = path.join(scratch, "claude-home");
  const proj = path.join(scratch, "proj");
  const plugin = path.join(scratch, "plugin-install");
  const outside = path.join(scratch, "planted-target");

  beforeAll(() => {
    w(path.join(home, "commands/user-cmd.md"), "---\ndescription: user command\n---\n");
    w(path.join(home, "skills/user-skill/SKILL.md"), "---\ndescription: user skill\n---\n");
    // Planted symlink: a user skill that is really a folder elsewhere.
    w(path.join(outside, "SKILL.md"), "---\ndescription: planted\n---\n");
    symlinkSync(outside, path.join(home, "skills/planted"));
    w(path.join(home, "settings.json"), JSON.stringify({ enabledPlugins: { "demo@mp": true } }));
    w(
      path.join(home, "plugins/installed_plugins.json"),
      JSON.stringify({ plugins: { "demo@mp": [{ scope: "user", installPath: plugin }] } }),
    );
    w(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { userMcp: { command: "x" } } }));
    w(path.join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ description: "Demo plugin" }));
    w(path.join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: { demo: { url: "https://example.com/mcp" } } }));
    w(path.join(plugin, "commands/hello.md"), "---\ndescription: hi\n---\n");
    w(path.join(plugin, "skills/pskill/SKILL.md"), "---\ndescription: plugin skill\n---\n");
    w(path.join(proj, ".claude/commands/proj-cmd.md"), "---\ndescription: project command\n---\n");
    w(path.join(proj, ".claude/skills/proj-skill/SKILL.md"), "---\ndescription: project skill\n---\n");
    w(path.join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { projMcp: { command: "y" } } }));
    w(path.join(proj, ".claude/junk/blob.bin"), "z".repeat(50_000));
  });

  const claudeOpts = () => ({ agent: "claude-code" as const, workdir: proj, harnessHome: home });

  test("same answer as the in-process read, in a bounded number of children", async () => {
    setDisclaimSwitch(false);
    const inProcess = await listAgentCapabilities(claudeOpts());

    const { children } = recordingStub();
    const disclaimed = await listAgentCapabilities(claudeOpts());
    expect(disclaimed).toEqual(inProcess);

    const names = disclaimed.commands.map((c) => c.name);
    expect(names).toContain("/planted"); // the symlinked skill, read via the child
    expect(names).toContain("/proj-cmd");
    expect(names).toContain("/demo:hello");
    expect(disclaimed.extensions.map((e) => e.name)).toEqual(
      expect.arrayContaining(["userMcp", "projMcp", "demo", "proj-skill"]),
    );
    // Two load stages (user+project files, then the plugin's files), one tar
    // each, plus the ~/.claude.json read.
    expect(children().filter((c) => c === "/usr/bin/tar")).toHaveLength(2);
    expect(children().filter((c) => c === "/bin/sh")).toHaveLength(1);
    // At most one find per (depth, name) per stage — never one per root or plugin.
    expect(children().filter((c) => c === "/usr/bin/find").length).toBeLessThanOrEqual(6);
    expect(
      children().every((c) => ["/usr/bin/find", "/usr/bin/tar", "/bin/sh"].includes(c) || c.endsWith("/git")),
    ).toBe(true);
  });

  test("a project loader is not needed (and not used) while disclaiming", async () => {
    recordingStub();
    let called = false;
    const out = await listAgentCapabilities({
      ...claudeOpts(),
      projectTreeLoader: async () => {
        called = true;
        throw new Error("must not run");
      },
    });
    expect(called).toBe(false);
    expect(out.commands.map((c) => c.name)).toContain("/proj-cmd");
  });

  test("codex and cursor each cost one find per selector shape plus one tar", async () => {
    const codexHome = path.join(scratch, "codex-home");
    w(path.join(codexHome, ".codex/prompts/p.md"), "---\ndescription: prompt\n---\n");
    w(path.join(codexHome, ".codex/skills/cs/SKILL.md"), "---\ndescription: codex skill\n---\n");
    w(path.join(codexHome, ".codex/config.toml"), '[mcp_servers.alpha]\ncommand = "a"\n');
    const rec = recordingStub();
    const codex = await listAgentCapabilities({ agent: "codex", workdir: null, harnessHome: codexHome });
    expect(codex.commands.map((c) => c.name)).toEqual(expect.arrayContaining(["/p", "/cs"]));
    expect(codex.extensions.map((e) => e.name)).toContain("alpha");
    // prompts (*.md), skills (SKILL.md), config.toml (single file).
    expect(rec.children().sort()).toEqual(["/usr/bin/find", "/usr/bin/find", "/usr/bin/find", "/usr/bin/tar"]);

    const cursorHome = path.join(scratch, "cursor-home");
    w(path.join(cursorHome, ".cursor/skills/cur/SKILL.md"), "---\ndescription: cursor skill\n---\n");
    w(path.join(cursorHome, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { beta: { command: "b" } } }));
    const rec2 = recordingStub();
    const cursor = await listAgentCapabilities({ agent: "cursor", workdir: null, harnessHome: cursorHome });
    expect(cursor.commands.map((c) => c.name)).toContain("/cur");
    expect(cursor.extensions.map((e) => e.name)).toContain("beta");
    // skills dirs (SKILL.md), mcp.json (single file).
    expect(rec2.children().sort()).toEqual(["/usr/bin/find", "/usr/bin/find", "/usr/bin/tar"]);
  });

  test("gemini reads nothing and spawns nothing", async () => {
    const rec = recordingStub();
    const out = await listAgentCapabilities({ agent: "gemini", workdir: null });
    expect(out).toEqual({ commands: [], extensions: [] });
    expect(rec.children()).toEqual([]);
  });
});

describe.skipIf(process.platform !== "darwin")("disclaimed discovery timeouts are reported", () => {
  /** A helper that turns every child whose program is `prog` into a 3 s hang. */
  function hangStub(prog: string): void {
    const stub = path.join(scratch, `hang-${counter++}`);
    writeFileSync(stub, `#!/bin/sh\nif [ "$1" = ${prog} ]; then exec /bin/sleep 3; fi\nexec "$@"\n`, { mode: 0o755 });
    process.env.AGETOR_DISCLAIM_BIN = stub;
    setDisclaimSwitch(true);
    __setLoadTimeoutMsForTest(300);
  }
  async function captureWarnings(fn: () => Promise<unknown>): Promise<string[]> {
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
    try {
      await fn();
    } finally {
      console.warn = warn;
    }
    return warnings;
  }

  test("a load() whose find times out logs one warning naming the root", async () => {
    hangStub("/usr/bin/find");
    const root = path.join(scratch, "timeout-root", "skills");
    const warnings = await captureWarnings(() => disclaimedDiscoveryFs.load([skillsDir(root)]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("timed out");
    expect(warnings[0]).toContain(root);
  });

  test("a readJsonCached() that times out answers null, warns, and caches nothing", async () => {
    const file = path.join(scratch, "slow-claude.json");
    w(file, '{"v":1}');
    hangStub("/bin/sh");
    let value: unknown = "unset";
    const warnings = await captureWarnings(async () => {
      value = await disclaimedDiscoveryFs.readJsonCached(file);
    });
    expect(value).toBeNull();
    expect(warnings.some((m) => m.includes("timed out") && m.includes(file))).toBe(true);
    // The next read, no longer stuck, parses the file instead of answering a
    // cached null.
    recordingStub();
    expect(await disclaimedDiscoveryFs.readJsonCached(file)).toEqual({ v: 1 });
  });

  test("a readJsonCached() that times out after a good read answers that read and keeps retrying", async () => {
    const file = path.join(scratch, "slow-cached-claude.json");
    w(file, '{"v":1}');
    recordingStub();
    expect(await disclaimedDiscoveryFs.readJsonCached(file)).toEqual({ v: 1 });
    writeFileSync(file, '{"v":22}');
    hangStub("/bin/sh");
    let value: unknown = "unset";
    const warnings = await captureWarnings(async () => {
      value = await disclaimedDiscoveryFs.readJsonCached(file);
    });
    expect(value).toEqual({ v: 1 });
    expect(warnings.some((m) => m.includes("timed out") && m.includes(file))).toBe(true);
    // The cache was left as it was, so an unstuck read sees the new content.
    recordingStub();
    expect(await disclaimedDiscoveryFs.readJsonCached(file)).toEqual({ v: 22 });
  });
});
