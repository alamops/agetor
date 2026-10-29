import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CORE_EXIT_PARK,
  LOGIN_ITEM_LABELS,
  SUPERVISOR_EXIT_BUNDLE_CHANGED,
  launchedBy,
  resolveIdleTimeoutMs,
} from "./daemon-mode.ts";

describe("launchedBy", () => {
  test("login-item only for the exact marker value", () => {
    expect(launchedBy({ AGETOR_LAUNCHED_BY: "login-item" })).toBe("login-item");
  });

  test("unset and unknown values are the CLI path", () => {
    expect(launchedBy({})).toBe("cli");
    expect(launchedBy({ AGETOR_LAUNCHED_BY: "" })).toBe("cli");
    expect(launchedBy({ AGETOR_LAUNCHED_BY: "Login-Item" })).toBe("cli");
    expect(launchedBy({ AGETOR_LAUNCHED_BY: "launchd" })).toBe("cli");
  });

  test("defaults to process.env", () => {
    const prev = process.env.AGETOR_LAUNCHED_BY;
    try {
      process.env.AGETOR_LAUNCHED_BY = "login-item";
      expect(launchedBy()).toBe("login-item");
      delete process.env.AGETOR_LAUNCHED_BY;
      expect(launchedBy()).toBe("cli");
    } finally {
      if (prev === undefined) delete process.env.AGETOR_LAUNCHED_BY;
      else process.env.AGETOR_LAUNCHED_BY = prev;
    }
  });
});

describe("resolveIdleTimeoutMs", () => {
  test("unset on the CLI path keeps the 5-minute default", () => {
    expect(resolveIdleTimeoutMs({})).toBe(300_000);
    expect(resolveIdleTimeoutMs({ AGETOR_LAUNCHED_BY: "cli" })).toBe(300_000);
  });

  test("a login-item core never idles out", () => {
    expect(resolveIdleTimeoutMs({ AGETOR_LAUNCHED_BY: "login-item" })).toBe(0);
  });

  test("an explicit value wins over the CLI default", () => {
    expect(resolveIdleTimeoutMs({ AGETOR_DAEMON_IDLE_MS: "1500" })).toBe(1500);
    // ...including 0 (a CLI daemon that must not exit).
    expect(resolveIdleTimeoutMs({ AGETOR_DAEMON_IDLE_MS: "0" })).toBe(0);
  });

  test("an explicit value wins over the login-item default", () => {
    expect(
      resolveIdleTimeoutMs({ AGETOR_LAUNCHED_BY: "login-item", AGETOR_DAEMON_IDLE_MS: "2500" }),
    ).toBe(2500);
  });

  test("a value that is not a finite positive number reads as 0 (disabled), not as the default", () => {
    for (const bad of ["abc", "NaN", "-5", "-1", "Infinity", "", "  "]) {
      expect(resolveIdleTimeoutMs({ AGETOR_DAEMON_IDLE_MS: bad })).toBe(0);
      expect(
        resolveIdleTimeoutMs({ AGETOR_LAUNCHED_BY: "login-item", AGETOR_DAEMON_IDLE_MS: bad }),
      ).toBe(0);
    }
  });

  test("defaults to process.env", () => {
    const keys = ["AGETOR_DAEMON_IDLE_MS", "AGETOR_LAUNCHED_BY"] as const;
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      delete process.env.AGETOR_DAEMON_IDLE_MS;
      delete process.env.AGETOR_LAUNCHED_BY;
      expect(resolveIdleTimeoutMs()).toBe(300_000);
      process.env.AGETOR_LAUNCHED_BY = "login-item";
      expect(resolveIdleTimeoutMs()).toBe(0);
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  });
});

describe("constants the supervisor and core agree on", () => {
  test("exit codes are distinct and non-zero", () => {
    expect(CORE_EXIT_PARK).toBe(76);
    expect(SUPERVISOR_EXIT_BUNDLE_CHANGED).toBe(75);
    expect(CORE_EXIT_PARK).not.toBe(SUPERVISOR_EXIT_BUNDLE_CHANGED);
  });

  test("channel labels differ so a canary build never collides with the stable job", () => {
    expect(LOGIN_ITEM_LABELS.stable).not.toBe(LOGIN_ITEM_LABELS.canary);
  });
});

// --- Import-graph guard ----------------------------------------------------
//
// The login-item supervisor runs with no database. If any module it imports
// reaches `db.ts` (which opens + migrates `agetor.sqlite` on import), merely
// starting the supervisor would create a database. A static scan of import
// specifiers, followed transitively, keeps that from creeping in.

const SPECIFIER_RES = [
  /\bfrom\s*["']([^"']+)["']/g, // import x from "./a.ts" / export … from "./a.ts"
  /\bimport\s*["']([^"']+)["']/g, // import "./a.ts"
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // import("./a.ts")
];

function relativeImports(file: string, read: (f: string) => string): string[] {
  const src = read(file);
  const out = new Set<string>();
  for (const re of SPECIFIER_RES) {
    for (const m of src.matchAll(re)) {
      const spec = m[1];
      if (!spec || !spec.startsWith(".") || !spec.endsWith(".ts")) continue; // skip node:*, packages, json
      out.add(path.resolve(path.dirname(file), spec));
    }
  }
  return [...out];
}

/** Returns the import chain from `entry` to the first `forbidden` file, or null. */
function findImportChain(
  entry: string,
  forbidden: (f: string) => boolean,
  read: (f: string) => string = (f) => readFileSync(f, "utf8"),
): string[] | null {
  const seen = new Set<string>();
  const walk = (file: string, chain: string[]): string[] | null => {
    if (seen.has(file)) return null;
    seen.add(file);
    const here = [...chain, file];
    if (forbidden(file)) return here;
    for (const dep of relativeImports(file, read)) {
      const hit = walk(dep, here);
      if (hit) return hit;
    }
    return null;
  };
  return walk(entry, []);
}

const BUN_DIR = import.meta.dir;
const isDb = (f: string) => path.basename(f) === "db.ts";

describe("import graph", () => {
  test("the scanner finds a transitive path to a forbidden file (positive control)", () => {
    const files: Record<string, string> = {
      "/x/a.ts": `import { b } from "./b.ts";\nimport fs from "node:fs";`,
      "/x/b.ts": `export * from "./c.ts";`,
      "/x/c.ts": `const m = await import("./db.ts");`,
      "/x/db.ts": "",
    };
    const chain = findImportChain("/x/a.ts", isDb, (f) => files[f] ?? "");
    expect(chain?.map((f) => path.basename(f))).toEqual(["a.ts", "b.ts", "c.ts", "db.ts"]);
    // Side-effect import form too.
    const chain2 = findImportChain("/y/a.ts", isDb, (f) => (f === "/y/a.ts" ? `import "./db.ts";` : ""));
    expect(chain2?.map((f) => path.basename(f))).toEqual(["a.ts", "db.ts"]);
  });

  test("the scanner reaches db.ts from a real module that imports it (background.ts)", () => {
    const chain = findImportChain(path.join(BUN_DIR, "background.ts"), isDb);
    expect(chain).not.toBeNull();
    expect(path.basename(chain![chain!.length - 1]!)).toBe("db.ts");
  });

  for (const entry of [
    "daemon-mode.ts",
    "login-daemon-state.ts",
    "login-item-helper.ts",
    "login-daemon.ts",
    "login-daemon-machine.ts",
    "background-derive.ts",
  ]) {
    test(`${entry} never reaches db.ts`, () => {
      const chain = findImportChain(path.join(BUN_DIR, entry), isDb);
      expect(chain ? chain.map((f) => path.relative(BUN_DIR, f)).join(" -> ") : null).toBeNull();
    });
  }
});
