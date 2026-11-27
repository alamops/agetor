// Pins the rule in docs/architecture/harness-antigravity.md: agetor never
// asks Google's services about an Antigravity account's usage limits or
// quota. Google has reported that out-of-band quota requests can get an
// account flagged or banned, so the only traffic agetor causes is the `agy`
// CLI's own (a turn, `agy models`, `agy --version`).
//
// Static and shared-module checks only: importing the usage poller would
// open the db.ts singleton, and the rule is about what exists in the source.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { HARNESS_STACK_KINDS, USAGE_SUPPORTED_KINDS } from "../shared/types.ts";
import { classifyHarnessLimitSignal } from "../shared/harness-limits.ts";

const SRC = path.resolve(import.meta.dir, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "fixtures") continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** Drops block and line comments (a `//` preceded by `:` is kept, so URLs survive). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("antigravity: no usage-limit or quota checks", () => {
  test("antigravity has no usage provider", () => {
    expect((USAGE_SUPPORTED_KINDS as readonly string[]).includes("antigravity")).toBe(false);
    // The poller's registry (`USAGE_PROVIDERS`) is a Partial, so a key could be
    // added without touching USAGE_SUPPORTED_KINDS: no usage module's code
    // (comments aside, which explain this rule) may name it.
    for (const file of sourceFiles(path.join(SRC, "bun", "usage"))) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect({ file, hit: /antigravity|\bagy\b/i.test(code) }).toEqual({ file, hit: false });
    }
  });

  test("antigravity is not a harness-stack kind (no limit cooldowns or limit retries)", () => {
    expect((HARNESS_STACK_KINDS as readonly string[]).includes("antigravity")).toBe(false);
  });

  test("the limit classifier never reports a signal for antigravity", () => {
    const text = "You've hit your usage limit. Quota exceeded, resets at 5pm. RESOURCE_EXHAUSTED (429)";
    expect(classifyHarnessLimitSignal("antigravity", { text })).toBeNull();
    expect(classifyHarnessLimitSignal("antigravity", { text, code: "rate_limit_error" })).toBeNull();
  });

  test("no source file calls a Google quota or usage endpoint", () => {
    // The Cloud Code endpoints Antigravity's quota tooling uses. agetor talks
    // to Antigravity only through the `agy` binary.
    const forbidden = /fetchAvailableModels|retrieveUserQuota|loadCodeAssist|cloudcode-pa\.googleapis|daily-cloudcode/i;
    const hits = sourceFiles(SRC).filter((f) => forbidden.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});
