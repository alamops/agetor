import { test, expect } from "bun:test";
import { canonicalInstructions, formatAgentProfileListRow, parseAgentProfileFlags, taskCountText } from "./agent-profile.ts";
import type { AgentProfile } from "../../shared/types.ts";

/**
 * `cmdAgentProfile` itself obtains its client via `getClient(flags)` (like
 * `cmdAdd` does — see `add.test.ts`'s header comment) and reads real files
 * for `--instructions-file`, so it isn't exercised here. This suite covers
 * the pure, I/O-free flag parser `parseAgentProfileFlags` — the file read
 * for `--instructions-file` happens later, in `resolveInstructions`, so this
 * only asserts the parsed path (or `-` for stdin) comes through untouched.
 */

// ── individual flags ─────────────────────────────────────────────────────

test("parseAgentProfileFlags: --name", () => {
  const f = parseAgentProfileFlags(["--name", "My Agent"]);
  expect(f.name).toBe("My Agent");
});

test("parseAgentProfileFlags: --harness", () => {
  const f = parseAgentProfileFlags(["--harness", "codex"]);
  expect(f.harness).toBe("codex");
});

test("parseAgentProfileFlags: --model", () => {
  const f = parseAgentProfileFlags(["--model", "gpt-6-astra"]);
  expect(f.model).toBe("gpt-6-astra");
});

test("parseAgentProfileFlags: --effort", () => {
  const f = parseAgentProfileFlags(["--effort", "high"]);
  expect(f.effort).toBe("high");
});

test("parseAgentProfileFlags: --mode", () => {
  const f = parseAgentProfileFlags(["--mode", "ask"]);
  expect(f.mode).toBe("ask");
});

test("parseAgentProfileFlags: --fast sets fast true", () => {
  const f = parseAgentProfileFlags(["--fast"]);
  expect(f.fast).toBe(true);
});

test("parseAgentProfileFlags: --no-fast sets fast false", () => {
  const f = parseAgentProfileFlags(["--no-fast"]);
  expect(f.fast).toBe(false);
});

test("parseAgentProfileFlags: --fast then --no-fast — last one wins", () => {
  const f = parseAgentProfileFlags(["--fast", "--no-fast"]);
  expect(f.fast).toBe(false);
});

test("parseAgentProfileFlags: --no-fast then --fast — last one wins", () => {
  const f = parseAgentProfileFlags(["--no-fast", "--fast"]);
  expect(f.fast).toBe(true);
});

test("parseAgentProfileFlags: --max-mode sets maxMode true", () => {
  const f = parseAgentProfileFlags(["--max-mode"]);
  expect(f.maxMode).toBe(true);
});

test("parseAgentProfileFlags: --no-max-mode sets maxMode false", () => {
  const f = parseAgentProfileFlags(["--no-max-mode"]);
  expect(f.maxMode).toBe(false);
});

test("parseAgentProfileFlags: neither --fast/--no-fast nor --max-mode/--no-max-mode leaves them undefined", () => {
  const f = parseAgentProfileFlags([]);
  expect(f.fast).toBeUndefined();
  expect(f.maxMode).toBeUndefined();
});

test("parseAgentProfileFlags: --instructions sets instructions verbatim, does not touch instructionsFile", () => {
  const f = parseAgentProfileFlags(["--instructions", "Always run tests first."]);
  expect(f.instructions).toBe("Always run tests first.");
  expect(f.instructionsFile).toBeUndefined();
});

test("parseAgentProfileFlags: --instructions-file <path> stores the path verbatim — no file read here", () => {
  const f = parseAgentProfileFlags(["--instructions-file", "/tmp/does-not-exist-instructions.md"]);
  expect(f.instructionsFile).toBe("/tmp/does-not-exist-instructions.md");
  expect(f.instructions).toBeUndefined();
});

test("parseAgentProfileFlags: --instructions-file - (stdin marker) is accepted as a bare dash", () => {
  const f = parseAgentProfileFlags(["--instructions-file", "-"]);
  expect(f.instructionsFile).toBe("-");
});

test("parseAgentProfileFlags: --instructions-file requires allowDash — a following flag is not swallowed as its value", () => {
  expect(() => parseAgentProfileFlags(["--instructions-file", "--name", "X"])).toThrow(
    /needs a value/,
  );
});

test("parseAgentProfileFlags: --skill is repeatable and preserves order (raw, unnormalized)", () => {
  const f = parseAgentProfileFlags(["--skill", "code-review", "--skill", "/deploy", "--skill", "code-review"]);
  // The parser itself does no dedup/normalization — that's `normalizeSkillList`
  // in agent-profile.ts, which isn't exported, so raw tokens (including a
  // literal duplicate and a leading "/") pass straight through here.
  expect(f.skills).toEqual(["code-review", "/deploy", "code-review"]);
});

test("parseAgentProfileFlags: no --skill flags leaves skills as an empty array (not undefined)", () => {
  const f = parseAgentProfileFlags([]);
  expect(f.skills).toEqual([]);
});

test("parseAgentProfileFlags: --clear-skills sets clearSkills true", () => {
  const f = parseAgentProfileFlags(["--clear-skills"]);
  expect(f.clearSkills).toBe(true);
});

test("parseAgentProfileFlags: no --clear-skills leaves clearSkills undefined", () => {
  const f = parseAgentProfileFlags([]);
  expect(f.clearSkills).toBeUndefined();
});

// ── missing values / malformed flags ─────────────────────────────────────

test("parseAgentProfileFlags: a value flag with nothing after it throws 'needs a value'", () => {
  expect(() => parseAgentProfileFlags(["--name"])).toThrow(/needs a value/);
  expect(() => parseAgentProfileFlags(["--harness"])).toThrow(/needs a value/);
  expect(() => parseAgentProfileFlags(["--model"])).toThrow(/needs a value/);
  expect(() => parseAgentProfileFlags(["--effort"])).toThrow(/needs a value/);
  expect(() => parseAgentProfileFlags(["--mode"])).toThrow(/needs a value/);
  expect(() => parseAgentProfileFlags(["--instructions"])).toThrow(/needs a value/);
  expect(() => parseAgentProfileFlags(["--instructions-file"])).toThrow(/needs a value/);
  expect(() => parseAgentProfileFlags(["--skill"])).toThrow(/needs a value/);
});

test("parseAgentProfileFlags: a value flag followed by another flag doesn't swallow it as the value", () => {
  expect(() => parseAgentProfileFlags(["--name", "--harness"])).toThrow(/needs a value/);
});

// ── unknown flags: ignored, per house convention (parseAdd's `default: break`) ──

test("parseAgentProfileFlags: an unrecognized flag is silently ignored, not thrown on", () => {
  const f = parseAgentProfileFlags(["--bogus"]);
  expect(f).toEqual({ skills: [] });
});

test("parseAgentProfileFlags: an unrecognized flag's would-be value is also ignored (not consumed as a value, not mistaken for a later flag's value)", () => {
  const f = parseAgentProfileFlags(["--bogus", "something", "--name", "Real Name"]);
  expect(f.name).toBe("Real Name");
  expect(f).toEqual({ skills: [], name: "Real Name" });
});

// ── everything together ──────────────────────────────────────────────────

test("parseAgentProfileFlags: every flag combined parses into one flags object", () => {
  const f = parseAgentProfileFlags([
    "--name",
    "Reviewer",
    "--harness",
    "codex",
    "--model",
    "gpt-6-astra",
    "--effort",
    "high",
    "--mode",
    "auto",
    "--fast",
    "--max-mode",
    "--instructions",
    "Be thorough.",
    "--skill",
    "code-review",
    "--skill",
    "security-review",
    "--clear-skills",
  ]);
  expect(f).toEqual({
    name: "Reviewer",
    harness: "codex",
    model: "gpt-6-astra",
    effort: "high",
    mode: "auto",
    fast: true,
    maxMode: true,
    instructions: "Be thorough.",
    skills: ["code-review", "security-review"],
    clearSkills: true,
  });
});

test("parseAgentProfileFlags: --instructions-file wins the slot over --instructions when both are passed (last-write-wins on their own fields, not mutually exclusive at parse time)", () => {
  const f = parseAgentProfileFlags(["--instructions", "inline text", "--instructions-file", "/tmp/x.md"]);
  // The parser sets both fields independently; precedence between them is
  // `resolveInstructions`'s job (not exported, not covered here) — this just
  // proves the parser doesn't clear one when the other is given.
  expect(f.instructions).toBe("inline text");
  expect(f.instructionsFile).toBe("/tmp/x.md");
});

// ── canonicalInstructions ────────────────────────────────────────────────
//
// `resolveInstructions` itself isn't exported (it does real file/stdin I/O),
// but the trimming it applies to both `--instructions-file` delivery
// channels (a real path and the `-` stdin marker) is factored into this
// pure helper so it's covered without touching the filesystem.

test("canonicalInstructions: trims leading and trailing whitespace", () => {
  expect(canonicalInstructions("  Always run tests first.  ")).toBe("Always run tests first.");
});

test("canonicalInstructions: trims surrounding newlines (e.g. a file read via readFileSync)", () => {
  expect(canonicalInstructions("Be thorough.\n")).toBe("Be thorough.");
  expect(canonicalInstructions("\n\nBe thorough.\n\n")).toBe("Be thorough.");
});

test("canonicalInstructions: preserves internal whitespace/newlines", () => {
  expect(canonicalInstructions("  Line one.\nLine two.  ")).toBe("Line one.\nLine two.");
});

test("canonicalInstructions: whitespace-only input canonicalizes to an empty string", () => {
  expect(canonicalInstructions("   \n\t  ")).toBe("");
});

test("canonicalInstructions: already-trimmed text is unchanged", () => {
  expect(canonicalInstructions("Be thorough.")).toBe("Be thorough.");
});

// ── taskCountText / formatAgentProfileListRow (docs/plans/agent-profiles.md
// "used by N tasks" counter, follow-up) ─────────────────────────────────

test("taskCountText: singular for 1", () => {
  expect(taskCountText(1)).toBe("1 task");
});

test("taskCountText: plural for 0 and N>1", () => {
  expect(taskCountText(0)).toBe("0 tasks");
  expect(taskCountText(3)).toBe("3 tasks");
});

function fakeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "p1",
    name: "Reviewer",
    harness: "codex",
    model: "gpt-6-astra",
    effort: "high",
    mode: "auto",
    fast: false,
    maxMode: false,
    instructions: "Be thorough and check for regressions carefully across the whole diff.",
    skills: ["code-review", "security-review"],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

test("formatAgentProfileListRow: places the tasks column after skills, before instructions", () => {
  const row = formatAgentProfileListRow(fakeProfile({ taskCount: 5 }));
  // name, harness, model, effort, mode, skills, tasks, instructions
  expect(row).toHaveLength(8);
  expect(row[5]).toBe("2"); // skills.length
  expect(row[6]).toBe("5"); // taskCount
});

test("formatAgentProfileListRow: undefined taskCount (older server payload) renders as 0", () => {
  const row = formatAgentProfileListRow(fakeProfile({ taskCount: undefined }));
  expect(row[6]).toBe("0");
});

test("formatAgentProfileListRow: name/harness/model/effort/mode come through verbatim", () => {
  const row = formatAgentProfileListRow(fakeProfile({ taskCount: 0 }));
  expect(row[0]).toBe("Reviewer");
  expect(row[1]).toBe("codex");
  expect(row[2]).toBe("gpt-6-astra");
  expect(row[3]).toBe("high");
  expect(row[4]).toBe("auto");
});

test("formatAgentProfileListRow: null effort/mode render as '-'", () => {
  const row = formatAgentProfileListRow(fakeProfile({ effort: null, mode: null, taskCount: 0 }));
  expect(row[3]).toBe("-");
  expect(row[4]).toBe("-");
});
