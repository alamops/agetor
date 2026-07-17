import { test, expect, beforeEach } from "bun:test";
import { buildCommand, harnessEnv, resolveBin } from "./agents.ts";
import type { AgentKind, Harness } from "../shared/types.ts";

// Loose 8-4-4-4-12 hex-with-dashes check — good enough to confirm
// `crypto.randomUUID()` (or a hand-rolled test uuid of the same shape) was
// used, without pinning to a specific UUID version's variant bits.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => {
  // Force literal bin names in argv, same rationale as agents.test.ts:
  // resolveBin() goes through Bun.which({ PATH }) to dodge Bun's startup
  // PATH cache, so without these overrides a machine with claude/codex/kimi
  // installed would see an absolute path in argv[0] and the equality checks
  // would drift per host.
  process.env.AGETOR_CLAUDE_BIN = "claude";
  process.env.AGETOR_CODEX_BIN = "codex";
  process.env.AGETOR_KIMI_BIN = "kimi";
  delete process.env.AGETOR_CLAUDE_ARGS;
  delete process.env.AGETOR_CODEX_ARGS;
  delete process.env.AGETOR_KIMI_ARGS;
});

/** Build a built-in harness for tests — kind doubles as id, no overrides. */
function builtin(kind: AgentKind): Harness {
  return {
    id: kind,
    kind,
    label: kind,
    isBuiltin: true,
    home: null,
    bin: null,
    env: {},
    enabled: true,
  };
}

/** Build a user alias for tests — every override populated. */
function alias(
  kind: AgentKind,
  opts: { home?: string; bin?: string; env?: Record<string, string> } = {},
): Harness {
  return {
    id: `${kind}-alias`,
    kind,
    label: `${kind} alias`,
    isBuiltin: false,
    home: opts.home ?? null,
    bin: opts.bin ?? null,
    env: opts.env ?? {},
    enabled: true,
  };
}

// Per-kind defaults mirroring the pattern in agents.test.ts's claudeDefaults
// / codexDefaults — kimi never needs `effort` (it declines the flag), so
// it's omitted rather than set to a value buildCommand would ignore anyway.
const kimiDefaults = { mode: "auto", model: "kimi-k2.7-code" } as const;

// --- buildCommand: argv shape -----------------------------------------------

test("kimi auto fresh turn: argv exact shape, sessionId matches the argv-embedded uuid", () => {
  const result = buildCommand(builtin("kimi"), "hi", kimiDefaults);
  const sid = result.sessionId!;
  expect(sid).toMatch(UUID_RE);
  expect(result.cmd).toEqual([
    "kimi",
    "--print",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--session", sid,
    "--model", "kimi-k2.7-code",
  ]);
});

test("kimi resume: resumeSessionId is reused verbatim in argv and as sessionId — no new uuid minted", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const result = buildCommand(builtin("kimi"), "hi", { ...kimiDefaults, resumeSessionId: id });
  expect(result.sessionId).toBe(id);
  const i = result.cmd.indexOf("--session");
  expect(i).toBeGreaterThan(-1);
  expect(result.cmd[i + 1]).toBe(id);
  // Only one --session flag — the resumed id, not a freshly-minted one too.
  expect(result.cmd.filter((a) => a === "--session").length).toBe(1);
});

test("kimi mode 'ask' appends a trailing --plan", () => {
  const result = buildCommand(builtin("kimi"), "hi", { ...kimiDefaults, mode: "ask" });
  expect(result.cmd[result.cmd.length - 1]).toBe("--plan");
});

test("kimi mode 'auto' and null both emit no --plan", () => {
  const autoResult = buildCommand(builtin("kimi"), "hi", { ...kimiDefaults, mode: "auto" });
  expect(autoResult.cmd).not.toContain("--plan");

  const nullModeResult = buildCommand(builtin("kimi"), "hi", { ...kimiDefaults, mode: null });
  expect(nullModeResult.cmd).not.toContain("--plan");
});

test("kimi throws when model is missing (parity with codex)", () => {
  expect(() => buildCommand(builtin("kimi"), "hi", { mode: "auto" })).toThrow(
    /model is required for kimi/,
  );
});

test("kimi accepts an explicit effort without throwing, but never emits it in argv or env (kimi-cli has no graded effort flag)", () => {
  expect(() =>
    buildCommand(builtin("kimi"), "hi", { ...kimiDefaults, effort: "high" }),
  ).not.toThrow();
  const result = buildCommand(builtin("kimi"), "hi", { ...kimiDefaults, effort: "high" });
  expect(result.cmd).not.toContain("--thinking");
  expect(result.cmd.join(" ").toLowerCase()).not.toContain("effort");
  expect(result.env?.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
});

test("AGETOR_KIMI_ARGS extra args are spliced at the tail (codex-parity position — after all flags, right before return)", () => {
  process.env.AGETOR_KIMI_ARGS = "--foo bar";
  try {
    const result = buildCommand(builtin("kimi"), "hi", kimiDefaults);
    expect(result.cmd.slice(-2)).toEqual(["--foo", "bar"]);
  } finally {
    delete process.env.AGETOR_KIMI_ARGS;
  }
});

test("AGETOR_KIMI_ARGS extra args land after --plan when mode is 'ask'", () => {
  process.env.AGETOR_KIMI_ARGS = "--foo bar";
  try {
    const result = buildCommand(builtin("kimi"), "hi", { ...kimiDefaults, mode: "ask" });
    expect(result.cmd.slice(-3)).toEqual(["--plan", "--foo", "bar"]);
  } finally {
    delete process.env.AGETOR_KIMI_ARGS;
  }
});

// --- env hygiene -------------------------------------------------------------

test("kimi env hygiene: NO_COLOR, telemetry, and auto-update opt-outs are set by default", () => {
  const result = buildCommand(builtin("kimi"), "hi", kimiDefaults);
  expect(result.env?.NO_COLOR).toBe("1");
  expect(result.env?.KIMI_DISABLE_TELEMETRY).toBe("1");
  expect(result.env?.KIMI_CODE_NO_AUTO_UPDATE).toBe("1");
  expect(result.env?.KIMI_CLI_NO_AUTO_UPDATE).toBe("1");
});

test("kimi env hygiene: a harness env_json override (NO_COLOR=0) wins over the hygiene default", () => {
  const h = alias("kimi", { env: { NO_COLOR: "0" } });
  const result = buildCommand(h, "hi", kimiDefaults);
  expect(result.env?.NO_COLOR).toBe("0");
  // The other hygiene defaults are untouched by the override.
  expect(result.env?.KIMI_DISABLE_TELEMETRY).toBe("1");
});

// --- harnessEnv ---------------------------------------------------------------

test("kimi harnessEnv: home set forces both HOME and KIMI_CODE_HOME to home", () => {
  const h = alias("kimi", { home: "/tmp/agetor-test/kimi-2" });
  const env = harnessEnv(h);
  expect(env.HOME).toBe("/tmp/agetor-test/kimi-2");
  expect(env.KIMI_CODE_HOME).toBe("/tmp/agetor-test/kimi-2");
});

test("kimi harnessEnv: no home set forces neither HOME nor KIMI_CODE_HOME", () => {
  const env = harnessEnv(builtin("kimi"));
  expect(env.HOME).toBeUndefined();
  expect(env.KIMI_CODE_HOME).toBeUndefined();
});

// --- resolveBin ----------------------------------------------------------------

test("kimi resolveBin: harness.bin wins over AGETOR_KIMI_BIN", () => {
  process.env.AGETOR_KIMI_BIN = "/env/kimi";
  const h = alias("kimi", { bin: "/alias/kimi" });
  expect(resolveBin(h)).toBe("/alias/kimi");
});

test("kimi resolveBin: AGETOR_KIMI_BIN wins when harness.bin is unset", () => {
  process.env.AGETOR_KIMI_BIN = "/env/kimi";
  expect(resolveBin(builtin("kimi"))).toBe("/env/kimi");
});

test("kimi resolveBin: falls back to PATH lookup, then the bare name when not found on PATH", () => {
  // No AGETOR_KIMI_BIN, no harness.bin — resolveBin goes through
  // Bun.which("kimi", { PATH }). Point PATH somewhere with no kimi binary so
  // the assertion doesn't depend on whether the test host happens to have
  // kimi installed.
  delete process.env.AGETOR_KIMI_BIN;
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent-agetor-test-path";
  try {
    expect(resolveBin(builtin("kimi"))).toBe("kimi");
  } finally {
    process.env.PATH = originalPath;
  }
});

// --- claude/codex regression (parity guard) -------------------------------
// Lightweight guard that adding the kimi branch didn't perturb the existing
// codex argv shape — copies the known-good expectation from agents.test.ts's
// "codex with defaults" case.

test("regression: codex buildCommand with known-good defaults is unchanged", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", {
    mode: "auto",
    model: "gpt-5-codex",
    effort: "high",
  });
  expect(cmd).toEqual([
    "codex", "exec",
    "--model", "gpt-5-codex",
    "-c", "model_reasoning_effort=high",
    "--json", "--color", "never", "--skip-git-repo-check",
    "--sandbox", "workspace-write",
    "-",
  ]);
});

test("regression: claude-code buildCommand with known-good defaults is unchanged", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "the prompt", {
    mode: "auto",
    model: "opus-4.7",
    effort: "high",
  });
  expect(cmd).toEqual([
    "claude",
    "--model", "claude-opus-4-7",
    "--permission-mode", "auto",
    "--", "the prompt",
  ]);
});
