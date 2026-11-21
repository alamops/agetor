// Fast guard for the async-correctness lint gate. `bun run lint:async` (part of
// `bun run check`) is what enforces the rules repo-wide; this file only pins
// that eslint.config.js still configures them, without running the typed
// linter (a typed run takes minutes, which is why the old sample-file test
// was moved out of the unit suite). It also runs the REAL config (minus the
// typed rules) through ESLint's Linter on good and bad sample code, so the test
// block's `local/await-matcher` rule, its globs and the block order are
// exercised, and checks that `json()` rejects a Promise at compile time.
// Nothing runs `lint:async` automatically (there is no CI): `bun run check` is the gate.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { Linter } from "eslint";
import config from "../../eslint.config.js";
import type { NotPromise } from "./server.ts";

type Block = { files?: string[]; rules?: Record<string, unknown> };
const blocks = config as Block[];

const sourceBlock = blocks.find((b) => b.files?.some((f) => f.startsWith("src/bun")));
const testBlock = blocks.find((b) => b.files?.some((f) => f.includes(".test.")));

function level(rule: unknown): unknown {
  return Array.isArray(rule) ? rule[0] : rule;
}

describe("eslint.config.js async gate", () => {
  test("the typed async rules are errors for production and tests", () => {
    for (const rule of [
      "@typescript-eslint/no-floating-promises",
      "@typescript-eslint/no-misused-promises",
      "@typescript-eslint/restrict-template-expressions",
      "@typescript-eslint/await-thenable",
    ]) {
      expect(level(sourceBlock?.rules?.[rule]), rule).toBe("error");
    }
  });

  test("floating promises may only be ignored with an explicit `void`", () => {
    const opts = (sourceBlock?.rules?.["@typescript-eslint/no-floating-promises"] as [string, { ignoreVoid?: boolean }])[1];
    expect(opts.ignoreVoid).toBe(true);
  });

  test("misused-promises checks conditionals and function arguments (forEach / setTimeout / on)", () => {
    const opts = (sourceBlock?.rules?.["@typescript-eslint/no-misused-promises"] as [
      string,
      { checksConditionals?: boolean; checksVoidReturn?: { arguments?: boolean } },
    ])[1];
    expect(opts.checksConditionals).toBe(true);
    expect(opts.checksVoidReturn?.arguments).toBe(true);
  });

  test("a Promise in a template literal is flagged (only number, boolean, nullish pass)", () => {
    const opts = (sourceBlock?.rules?.["@typescript-eslint/restrict-template-expressions"] as [string, Record<string, boolean>])[1];
    expect(opts.allowNumber).toBe(true);
    expect(opts.allowNullish).toBe(true);
  });

  test("block order and file globs: the test block comes after the source block and matches test files", () => {
    // Flat config is last-wins: a test block above the source block would be
    // overridden and `await-thenable` would fire on every `.rejects`.
    expect(sourceBlock).toBeDefined();
    expect(testBlock).toBeDefined();
    expect(blocks.indexOf(testBlock!)).toBeGreaterThan(blocks.indexOf(sourceBlock!));
    expect(sourceBlock!.files).toEqual(["src/bun/**/*.ts", "src/cli/**/*.{ts,tsx}", "src/shared/**/*.ts"]);
    expect(testBlock!.files).toEqual(["src/**/*.test.ts", "src/**/*.test.tsx"]);
    expect(level(testBlock?.rules?.["@typescript-eslint/await-thenable"])).toBe("off");
    expect(level(testBlock?.rules?.["local/await-matcher"])).toBe("error");
  });
});

// The REAL config, run through ESLint's Linter. The typed rules need the whole
// project's type information (minutes), so they are dropped here and pinned by
// the option checks above; everything else (the block list, the globs, the
// test-file rule) is the repo's own, so this fails when the config stops
// matching test files or the rule stops catching a form.
const TYPED_RULES = new Set([
  "@typescript-eslint/no-floating-promises",
  "@typescript-eslint/no-misused-promises",
  "@typescript-eslint/restrict-template-expressions",
  "@typescript-eslint/await-thenable",
]);

function realConfigWithoutTypedRules(): unknown[] {
  return (config as Array<Record<string, any>>).map((b) => ({
    ...b,
    ...(b.languageOptions ? { languageOptions: { ...b.languageOptions, parserOptions: {} } } : {}),
    ...(b.rules ? { rules: Object.fromEntries(Object.entries(b.rules).filter(([k]) => !TYPED_RULES.has(k))) } : {}),
  }));
}

const repoRoot = path.resolve(import.meta.dir, "..", "..");
function lintReal(code: string, file: string): string[] {
  const linter = new Linter({ cwd: repoRoot });
  return linter
    .verify(code, realConfigWithoutTypedRules() as never, { filename: path.join(repoRoot, file) })
    .map((m) => `${m.ruleId ?? "fatal"}${m.fatal ? `: ${m.message}` : ""}`);
}

describe("the real config on sample code (test files)", () => {
  const TEST_FILE = "src/bun/sample.test.ts";
  const bad = [
    "expect(p).rejects.toThrow();",
    "expect(p).resolves.toBe(1);",
    "expect(p).not.rejects.toThrow();",
    "expect(p).resolves.not.toBe(2);",
    "void expect(p).rejects.toThrow();",
    "cond && expect(p).rejects.toThrow();",
    "cond ? expect(p).rejects.toThrow() : null;",
    'expect(p)["rejects"].toThrow();',
    "const r = expect(p).resolves.toBe(1);",
    "let r; r = expect(p).resolves.toBe(1);",
    "xs.forEach((x) => { expect(x).rejects.toThrow(); });",
    "xs.forEach((x) => expect(x).rejects.toThrow());",
    "expect(p).rejects.toThrow().catch(() => {});",
    "expect(p).rejects.toThrow().then(() => 1);",
    "Promise.all([expect(p).rejects.toThrow()]);",
  ];
  for (const code of bad) {
    test(`flags: ${code}`, () => {
      expect(lintReal(code, TEST_FILE), code).toEqual(["local/await-matcher"]);
    });
  }

  const good = [
    "async function f() { await expect(p).rejects.toThrow(); }",
    "async function f() { await expect(p).resolves.toBe(1); }",
    'async function f() { await expect(p)["rejects"].toThrow(); }',
    "function f() { return expect(p).rejects.toThrow(); }",
    "expect(1).toBe(1);",
    "test('x', async () => { await expect(p).rejects.toThrow(); });",
    "test('x', () => expect(p).rejects.toThrow());",
    "async function f() { await Promise.all([expect(a).rejects.toThrow(), expect(b).resolves.toBe(1)]); }",
    "async function f() { await Promise.all(xs.map((x) => expect(x).rejects.toThrow())); }",
    "async function f() { await (cond && expect(p).rejects.toThrow()); }",
    "async function f() { return await expect(p).rejects.toThrow(); }",
  ];
  for (const code of good) {
    test(`allows: ${code}`, () => {
      expect(lintReal(code, TEST_FILE), code).toEqual([]);
    });
  }

  test("a production file is not subject to the matcher rule, and a webview file is ignored", () => {
    expect(lintReal("expect(p).rejects.toThrow();", "src/bun/sample.ts")).toEqual([]);
    expect(lintReal("expect(p).rejects.toThrow();", "src/mainview/sample.test.ts")).not.toContain("local/await-matcher");
  });

  test("a .test.tsx file is covered too", () => {
    expect(lintReal("expect(p).rejects.toThrow();", "src/cli/tui/sample.test.tsx")).toEqual(["local/await-matcher"]);
  });
});

describe("json() compile-time guard", () => {
  test("NotPromise rejects a PromiseLike and passes plain data", () => {
    // @ts-expect-error a Promise must not be assignable to NotPromise<Promise<number>> (never)
    const bad: NotPromise<Promise<number>> = Promise.resolve(1);
    const ok: NotPromise<{ a: number }> = { a: 1 };
    expect(ok.a).toBe(1);
    void bad;
  });
});
