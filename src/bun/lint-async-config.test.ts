// Fast guard for the async-correctness lint gate. `bun run lint:async` (part of
// `bun run check`) is what enforces the rules repo-wide; this file only pins
// that eslint.config.js still configures them, without running the typed
// linter (a typed run takes minutes, which is why the old sample-file test
// was moved out of the unit suite). It also checks the test-file block's
// syntax rule, which needs no type information, on real sample code, and that
// `json()` rejects a Promise at compile time.
import { describe, expect, test } from "bun:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
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

  test("test files turn off await-thenable (bun:test types `.rejects` as void) but forbid an un-awaited .resolves/.rejects", () => {
    expect(level(testBlock?.rules?.["@typescript-eslint/await-thenable"])).toBe("off");
    const linter = new Linter();
    const run = (code: string) =>
      linter.verify(code, [
        {
          languageOptions: { parser: tseslint.parser },
          rules: { "no-restricted-syntax": testBlock?.rules?.["no-restricted-syntax"] as never },
        },
      ]);
    const bad = [
      "expect(p).rejects.toThrow();",
      "expect(p).resolves.toBe(1);",
      "expect(p).not.rejects.toThrow();",
      "expect(p).resolves.not.toBe(2);",
    ];
    for (const code of bad) expect(run(code).map((m) => m.ruleId), code).toEqual(["no-restricted-syntax"]);
    const good = [
      "async function f() { await expect(p).rejects.toThrow(); }",
      "async function f() { await expect(p).resolves.toBe(1); }",
      "function f() { return expect(p).rejects.toThrow(); }",
      "expect(1).toBe(1);",
      "test('x', async () => { await expect(p).rejects.toThrow(); });",
    ];
    for (const code of good) expect(run(code), code).toEqual([]);
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
