import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Static guard for the spawn wrapper (docs/plans/master-token-agent-read.md,
// §3 "Spawn wrapper", P2/P3, D1/D8/D22). Every process the core launches must
// go through `coreSpawn` / `coreSpawnSync` (src/bun/core-spawn.ts), which
// scrubs the env and runs the child through the disclaim helper. A raw
// `Bun.spawn` anywhere else would let an agent-plantable program (a repo's
// `core.fsmonitor`, a binary earlier on PATH) run with Agetor's macOS
// identity, so this test fails on any spawn primitive that is neither in
// core-spawn.ts nor carries an explicit exemption marker on the line above:
//
//   // spawn-exempt(<category>): <reason>
//
// The exact (file, category) list is pinned below. Adding an exemption needs
// an edit HERE, in the same change, so it gets reviewed.

const ROOT = path.resolve(import.meta.dir, "..", "..");
const SCAN_DIRS = ["src/bun", "src/shared"];
const WRAPPER = "src/bun/core-spawn.ts";
const CATEGORIES = ["osascript", "terminal-tab", "notifier"] as const;

/** The pinned exemption list: `<file>:<category>` repeated once per site. */
const EXPECTED_EXEMPTIONS = [
  "src/bun/server.ts:osascript",
  "src/bun/server.ts:osascript",
  "src/bun/task-notifier.ts:notifier",
  "src/bun/terminals.ts:terminal-tab",
];

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    const abs = path.join(ROOT, rel);
    if (statSync(abs).isDirectory()) {
      out.push(...listSources(rel));
    } else if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith("-test-util.ts")
    ) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * The file's lines with comments blanked (line numbers preserved): `/* … *\/`
 * blocks, JSDoc continuation lines and `//` tails. A `//` right after `:` or
 * a quote is kept, so a URL inside a string is not mistaken for a comment.
 * Several files mention `Bun.spawn(...)` in prose; only code may match.
 */
function codeLines(source: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of source.split("\n")) {
    let line = "";
    let i = 0;
    while (i < raw.length) {
      if (inBlock) {
        const end = raw.indexOf("*/", i);
        if (end === -1) {
          i = raw.length;
        } else {
          inBlock = false;
          i = end + 2;
        }
        continue;
      }
      if (raw.startsWith("/*", i)) {
        inBlock = true;
        i += 2;
        continue;
      }
      if (raw.startsWith("//", i) && !/[:"'`\\]/.test(raw[i - 1] ?? "")) break;
      line += raw[i];
      i++;
    }
    out.push(line);
  }
  return out;
}

/** The spawn primitives the wrapper replaces. One hit per line is enough. */
const SPAWN_PATTERNS: RegExp[] = [
  /\bBun\.spawn\(/,
  /\bBun\.spawnSync\(/,
  /\bspawnSync\(/,
  /\bexecFile(Sync)?\(/,
  /\bBun\.\$/,
  /\bfrom\s+["'](node:)?child_process["']/,
  /\brequire\(\s*["'](node:)?child_process["']/,
  /\bimport\(\s*["'](node:)?child_process["']/,
  /\{[^}]*\$[^}]*\}\s*from\s*["']bun["']/,
];

const MARKER = /^\s*\/\/\s*spawn-exempt\(([a-z-]+)\):\s*(\S.*)$/;

interface Hit {
  file: string;
  line: number;
  text: string;
  category: string | null;
  reasonOk: boolean;
}

function scan(): { hits: Hit[]; disclaimArgvCalls: string[]; tmuxClientEnv: string[] } {
  const hits: Hit[] = [];
  const disclaimArgvCalls: string[] = [];
  const tmuxClientEnv: string[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of listSources(dir)) {
      const raw = readFileSync(path.join(ROOT, file), "utf8").split("\n");
      const code = codeLines(raw.join("\n"));
      code.forEach((text, idx) => {
        if (/\bdisclaimArgv\(/.test(text) && file !== WRAPPER && file !== "src/bun/disclaim.ts") {
          disclaimArgvCalls.push(`${file}:${idx + 1}`);
        }
        if (/\btmuxClientEnv\b/.test(text)) tmuxClientEnv.push(`${file}:${idx + 1}`);
        if (file === WRAPPER) return;
        if (!SPAWN_PATTERNS.some((re) => re.test(text))) return;
        const marker = idx > 0 ? MARKER.exec(raw[idx - 1]!) : null;
        hits.push({
          file,
          line: idx + 1,
          text: text.trim(),
          category: marker ? marker[1]! : null,
          reasonOk: marker ? marker[2]!.trim().length > 0 : false,
        });
      });
    }
  }
  return { hits, disclaimArgvCalls, tmuxClientEnv };
}

describe("core spawn allowlist", () => {
  const { hits, disclaimArgvCalls, tmuxClientEnv } = scan();

  test("the scan sees the wrapper and the source tree (guards against a vacuous pass)", () => {
    const files = SCAN_DIRS.flatMap(listSources);
    expect(files).toContain(WRAPPER);
    expect(files.length).toBeGreaterThan(50);
    // core-spawn.ts really contains the primitives the scanner looks for, so a
    // broken pattern would be noticed by this sanity check.
    const wrapperCode = codeLines(readFileSync(path.join(ROOT, WRAPPER), "utf8")).join("\n");
    expect(SPAWN_PATTERNS.some((re) => re.test(wrapperCode))).toBe(true);
  });

  test("every spawn primitive outside core-spawn.ts carries a valid spawn-exempt marker", () => {
    const bad = hits.filter(
      (h) => !h.category || !h.reasonOk || !(CATEGORIES as readonly string[]).includes(h.category),
    );
    expect(
      bad.map(
        (h) =>
          `${h.file}:${h.line}  ${h.text}\n    -> route it through coreSpawn/coreSpawnSync (src/bun/core-spawn.ts), ` +
          `or mark it with "// spawn-exempt(<${CATEGORIES.join("|")}>): <reason>" on the line above ` +
          `and add it to EXPECTED_EXEMPTIONS in this test`,
      ),
    ).toEqual([]);
  });

  test("the exemption list is exactly the pinned (file, category) set", () => {
    const actual = hits.map((h) => `${h.file}:${h.category}`).sort();
    expect(actual).toEqual([...EXPECTED_EXEMPTIONS].sort());
  });

  test("disclaimArgv is only called from core-spawn.ts", () => {
    // Call sites must not wrap themselves, or the helper would be exec'd twice
    // (tmux server start, fx). disclaim.ts only DEFINES it.
    expect(disclaimArgvCalls).toEqual([]);
  });

  test("tmuxClientEnv is gone (replaced by childEnv)", () => {
    expect(tmuxClientEnv).toEqual([]);
  });
});
