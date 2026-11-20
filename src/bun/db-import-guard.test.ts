/**
 * Guard: no production file imports `src/bun/db.ts`
 * (docs/plans/non-blocking-core.md, T15 and X9; docs/architecture/persistence.md).
 *
 * `db.ts` opens the SQLite file and runs the migrations the moment it is
 * evaluated. The database worker owns the only production connection, so a
 * production import of `db.ts` would quietly open a second one on the main
 * thread and put every query back on the event loop. Production code reaches
 * the database through `db-async.ts` / `db-rpc.ts`; `db.ts` belongs to tests
 * (which run in-process) and to `db-rpc.ts`'s in-process branch alone.
 *
 * The scan covers `src/bun`, `src/shared` and `src/cli` (`src/mainview` is the
 * webview and cannot reach a bun:sqlite file) and flags every import form:
 * `import … from`, `export … from`, `import("…")` and `require("…")`, with or
 * without the `.ts` (or `.js`, which Bun resolves to the same file) extension and
 * whatever the relative depth. A dynamic `import(x)` / `require(x)` whose
 * specifier is not a plain string literal (a variable, a template with `${…}`)
 * cannot be resolved by a scan, so production code may not have one unless it is
 * allow-listed with its reason.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(import.meta.dir, "..");
const DB_MODULE = path.join(SRC, "bun", "db");

/** Non-test production files allowed to import `db.ts`, each with its reason. */
const ALLOWED_IMPORTERS: Record<string, string> = {
  "bun/db-rpc.ts": "the in-process branch dynamically imports db.ts (tests, and the AGETOR_DB_MODE=inprocess kill switch); worker mode never evaluates it",
  "bun/test-harness-state.ts": "test helper: snapshots and restores the db.ts singleton's harness rows between test files",
};

/** Non-test production files allowed a dynamic import whose specifier is not a
 *  string literal, each with its reason. */
const ALLOWED_COMPUTED_IMPORTS: Record<string, string> = {};

const SCANNED_ROOTS = ["bun", "shared", "cli"];

/** Whether a file is a test file (not production code). */
function isTestFile(rel: string): boolean {
  return /\.test\.tsx?$/.test(rel);
}

/** Every module specifier `source` imports, in any form. A parser handles
 *  import/export-from/dynamic/require; a regex pass is a second net for forms
 *  a scanner might skip (a computed-looking `import(` with a literal). */
export function importedSpecifiers(source: string, loader: "ts" | "tsx"): string[] {
  const found = new Set<string>();
  try {
    for (const imp of new Bun.Transpiler({ loader }).scanImports(source)) found.add(imp.path);
  } catch {
    // An unparsable file still gets the regex pass below.
  }
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bimport\s*["']([^"']+)["']/g,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) found.add(m[1]!);
  return [...found];
}

/** Dynamic `import(...)` / `require(...)` calls in `source` whose specifier is
 *  not a string literal (a variable, an expression, or a template literal with
 *  an interpolation), as the call's first argument text. */
export function computedSpecifiers(source: string, loader: "ts" | "tsx" = "ts"): string[] {
  const out: string[] = [];
  // Transpile first: it drops comments and types, so prose like "import (the ...)" is not a call.
  let code = source;
  try { code = new Bun.Transpiler({ loader }).transformSync(source); } catch { /* scan the raw text */ }
  for (const m of code.matchAll(/(?<![\w.$])(?:import|require)\s*\(\s*([^\n]*)/g)) {
    // Prose inside a string ("this wouldn't import (...)") is not a call: skip a
    // match that sits inside an open quote or template on its own line.
    const linePrefix = code.slice(code.lastIndexOf("\n", m.index!) + 1, m.index);
    if ((linePrefix.match(/`/g)?.length ?? 0) % 2 === 1 || (linePrefix.match(/(?<!\\)"/g)?.length ?? 0) % 2 === 1) continue;
    const arg = m[1]!.trimStart();
    if (arg === "") continue; // the argument starts on the next line: not a call this scan judges
    const quote = arg[0]!;
    if (quote === '"' || quote === "'") continue;
    if (quote === "`") {
      const end = arg.indexOf("`", 1);
      if (end !== -1 && !arg.slice(1, end).includes("${")) continue; // an interpolation-free template is a literal
    }
    out.push(arg.slice(0, 60));
  }
  return out;
}

/** Whether `specifier`, written in the file at `fromFile`, resolves to db.ts. */
export function resolvesToDb(fromFile: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const target = path.resolve(path.dirname(fromFile), specifier);
  return target === DB_MODULE || target === `${DB_MODULE}.ts` || target === `${DB_MODULE}.js`;
}

function productionFiles(): string[] {
  const out: string[] = [];
  for (const root of SCANNED_ROOTS) {
    for (const rel of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: path.join(SRC, root) })) {
      const relFromSrc = `${root}/${rel}`;
      if (!isTestFile(relFromSrc) && !relFromSrc.endsWith(".d.ts")) out.push(relFromSrc);
    }
  }
  return out.sort();
}

function importsDb(relFromSrc: string): boolean {
  const abs = path.join(SRC, relFromSrc);
  const loader = abs.endsWith(".tsx") ? "tsx" : "ts";
  return importedSpecifiers(readFileSync(abs, "utf8"), loader).some((s) => resolvesToDb(abs, s));
}

describe("no production import of db.ts", () => {
  test("only the allow-listed files import db.ts", () => {
    const files = productionFiles();
    expect(files.length).toBeGreaterThan(100); // the walk is not vacuous
    const offenders = files.filter((f) => importsDb(f) && !(f in ALLOWED_IMPORTERS));
    expect(
      offenders,
      `production code must use db-async.ts, not db.ts (a second main-thread connection): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  test("no production file imports through a specifier the scan cannot resolve", () => {
    const offenders: string[] = [];
    for (const rel of productionFiles()) {
      if (rel in ALLOWED_COMPUTED_IMPORTS) continue;
      const hits = computedSpecifiers(readFileSync(path.join(SRC, rel), "utf8"), rel.endsWith(".tsx") ? "tsx" : "ts");
      if (hits.length > 0) offenders.push(`${rel}: ${hits.join(" | ")}`);
    }
    expect(
      offenders,
      `a computed import/require specifier could reach db.ts unseen; use a literal or allow-list it: ${offenders.join("; ")}`,
    ).toEqual([]);
  });

  test("every computed-import allow-list entry still has one (no stale exemption)", () => {
    for (const rel of Object.keys(ALLOWED_COMPUTED_IMPORTS)) {
      expect(computedSpecifiers(readFileSync(path.join(SRC, rel), "utf8")).length, rel).toBeGreaterThan(0);
    }
  });

  test("the computed-specifier detector flags variables and interpolated templates, not literals", () => {
    const cases: [string, boolean][] = [
      [`const m = await import(name);`, true],
      [`const m = await import(\`./${"$"}{x}.ts\`);`, true],
      [`const m = require(path.join(a, "db.ts"));`, true],
      [`const m = await import("./db.ts");`, false],
      [`const m = await import('./db.ts');`, false],
      [`const m = await import(\`./db.ts\`);`, false],
      [`const m = require("node:fs");`, false],
      [`const u = import.meta.url; const r = myimport(x);`, false],
    ];
    for (const [code, expected] of cases) expect(computedSpecifiers(code).length > 0, code).toBe(expected);
  });

  test("every allow-list entry still imports db.ts (no stale exemption)", () => {
    for (const rel of Object.keys(ALLOWED_IMPORTERS)) {
      expect(importsDb(rel), `${rel} no longer imports db.ts: drop it from ALLOWED_IMPORTERS`).toBe(true);
    }
  });

  test("the detector recognises every import form and resolves relative depth", () => {
    const here = path.join(SRC, "bun", "workers", "x.ts");
    const cases: [string, boolean][] = [
      [`import { db } from "../db.ts";`, true],
      [`import { db } from "../db";`, true],
      [`import * as d from '../db.ts';`, true],
      [`export { tasks } from "../db.ts";`, true],
      [`export * from "../db";`, true],
      [`const m = await import("../db.ts");`, true],
      [`const m = import("../db");`, true],
      [`const m = require("../db.ts");`, true],
      [`import "../db.ts";`, true],
      [`import type { Database } from "../db.ts";`, true],
      [`import { db } from "../db.js";`, true],
      [`const m = await import("../db.js");`, true],
      [`import { x } from "../db-async.ts";`, false],
      [`import { x } from "../db-rpc.ts";`, false],
      [`import { x } from "../db-core/tasks.ts";`, false],
      [`import { x } from "./db.ts";`, false], // workers/db.ts is another file
      [`import { x } from "bun:sqlite";`, false],
    ];
    for (const [code, expected] of cases) {
      const hit = importedSpecifiers(code, "ts").some((s) => resolvesToDb(here, s));
      expect(hit, code).toBe(expected);
    }
    // The same specifier from the right directory.
    expect(resolvesToDb(path.join(SRC, "bun", "x.ts"), "./db.ts")).toBe(true);
    expect(resolvesToDb(path.join(SRC, "cli", "x.ts"), "../bun/db.ts")).toBe(true);
    expect(resolvesToDb(path.join(SRC, "shared", "x.ts"), "../bun/db")).toBe(true);
  });
});
