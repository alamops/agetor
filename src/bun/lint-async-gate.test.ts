// Proves the async-correctness lint gate (eslint.config.js) fires on the
// patterns a missed `await` produces, and that `json()` rejects a Promise at
// compile time. The lint half writes a throwaway sample next to this file
// (the typed-lint project service only sees files on disk), lints it with the
// repo config, and always deletes it.
import { afterAll, describe, expect, test } from "bun:test";
import { ESLint } from "eslint";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NotPromise } from "./server.ts";

const root = join(import.meta.dir, "..", "..");
const sample = join(import.meta.dir, `lint-async-gate-sample-${process.pid}.ts`);

async function lint(code: string) {
  writeFileSync(sample, code);
  const eslint = new ESLint({ cwd: root, overrideConfigFile: join(root, "eslint.config.js") });
  const [res] = await eslint.lintFiles([sample]);
  return (res?.messages ?? []).map((m) => m.ruleId);
}

afterAll(() => rmSync(sample, { force: true }));

describe("async lint gate", () => {
  test("forEach(async) is flagged by no-misused-promises", async () => {
    expect(await lint("[1].forEach(async () => {});\nexport {};\n")).toContain(
      "@typescript-eslint/no-misused-promises",
    );
  });
  test("setTimeout(async) is flagged by no-misused-promises", async () => {
    expect(await lint("setTimeout(async () => {}, 1);\nexport {};\n")).toContain(
      "@typescript-eslint/no-misused-promises",
    );
  });
  test("a Promise in a template literal is flagged", async () => {
    expect(await lint("export const s = `${Promise.resolve(1)}`;\n")).toContain(
      "@typescript-eslint/restrict-template-expressions",
    );
  });
  test("number and nullish values in templates are not flagged", async () => {
    const rules = await lint("export const n: number | null = null;\nexport const s = `${n} ${1}`;\n");
    expect(rules).not.toContain("@typescript-eslint/restrict-template-expressions");
  });
  test("a Promise used as a condition is flagged", async () => {
    expect(await lint("export const p = Promise.resolve(1);\nif (p) { console.log(1); }\n")).toContain(
      "@typescript-eslint/no-misused-promises",
    );
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
