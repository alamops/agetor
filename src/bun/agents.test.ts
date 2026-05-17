import { test, expect, beforeEach } from "bun:test";
import { buildCommand } from "./agents.ts";
import { AGENT_OPTIONS, type AgentKind, type Harness } from "../shared/types.ts";

beforeEach(() => {
  delete process.env.AGETOR_CLAUDE_BIN;
  delete process.env.AGETOR_CLAUDE_ARGS;
  delete process.env.AGETOR_CODEX_BIN;
  delete process.env.AGETOR_CODEX_ARGS;
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
function alias(kind: AgentKind, opts: { home?: string; bin?: string; env?: Record<string, string> } = {}): Harness {
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

// Per-kind defaults used by every test that isn't probing the
// missing-model / missing-effort guards. Mirrors what the UI + orchestrator
// will now always pass at runtime.
const claudeDefaults = { mode: "auto", model: "opus-4.7", effort: "high" } as const;
const codexDefaults = { mode: "auto", model: "gpt-5-codex", effort: "high" } as const;

test("aliased claude-code with HOME override emits HOME only (no CLAUDE_CONFIG_DIR)", () => {
  const result = buildCommand(
    alias("claude-code", { home: "/tmp/agetor-test/claude-2" }),
    "p",
    { ...claudeDefaults },
  );
  expect(result.env?.HOME).toBe("/tmp/agetor-test/claude-2");
  expect(result.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
});

test("aliased codex with HOME override emits HOME + CODEX_HOME", () => {
  const result = buildCommand(
    alias("codex", { home: "/tmp/agetor-test/codex-2" }),
    "p",
    { ...codexDefaults },
  );
  expect(result.env?.HOME).toBe("/tmp/agetor-test/codex-2");
  expect(result.env?.CODEX_HOME).toBe("/tmp/agetor-test/codex-2/.codex");
});

test("aliased harness bin override beats the AGETOR_*_BIN env fallback", () => {
  process.env.AGETOR_CLAUDE_BIN = "/env-fallback/claude";
  expect(buildCommand(builtin("claude-code"), "p", { ...claudeDefaults }).cmd[0]).toBe("/env-fallback/claude");
  expect(
    buildCommand(alias("claude-code", { bin: "/alias/claude" }), "p", { ...claudeDefaults }).cmd[0],
  ).toBe("/alias/claude");
});

test("aliased harness env merges with at-spawn effort (task-level effort wins)", () => {
  const result = buildCommand(
    alias("claude-code", { env: { CLAUDE_CODE_EFFORT_LEVEL: "max", FOO: "bar" } }),
    "p",
    { ...claudeDefaults, effort: "low" },
  );
  expect(result.env?.CLAUDE_CODE_EFFORT_LEVEL).toBe("low");
  expect(result.env?.FOO).toBe("bar");
});

test("aliased codex env CODEX_HOME overrides the home-derived default", () => {
  const result = buildCommand(
    alias("codex", {
      home: "/tmp/agetor-test",
      env: { CODEX_HOME: "/custom/path/.codex" },
    }),
    "p",
    { ...codexDefaults },
  );
  expect(result.env?.HOME).toBe("/tmp/agetor-test");
  expect(result.env?.CODEX_HOME).toBe("/custom/path/.codex");
});

// Claude-code launches the *interactive* REPL — `--print` is gone. The
// argv that buildCommand returns is what we hand to tmux after `--`; the
// initial prompt rides as the final argv element (claude's documented
// `claude "query"` form), removing the need to paste it via tmux after
// spawn. Follow-up turns still go via tmux paste-buffer.

test("claude-code with defaults launches interactive REPL with --model opus-4.7 + --permission-mode auto", () => {
  // Default `mode` is `auto`, which now maps to claude's real
  // `--permission-mode auto` (server-side AI classifier handles per-call
  // judgment). The narrow PreToolUse matcher in hook-installer.ts is what
  // lets the classifier actually run for every tool except
  // AskUserQuestion/ExitPlanMode.
  const { cmd } = buildCommand(builtin("claude-code"), "the prompt", { ...claudeDefaults });
  expect(cmd).toEqual([
    "claude",
    "--model", "claude-opus-4-7",
    "--permission-mode", "auto",
    "the prompt",
  ]);
  expect(cmd).not.toContain("--print");
  expect(cmd).not.toContain("--dangerously-skip-permissions");
});

test("claude-code 'opus-4.7' + 'auto' translates to --model and --permission-mode auto", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "do thing", { ...claudeDefaults, model: "opus-4.7", mode: "auto" });
  expect(cmd).toEqual([
    "claude",
    "--model", "claude-opus-4-7",
    "--permission-mode", "auto",
    "do thing",
  ]);
});

test("claude-code 'bypass' mode emits --dangerously-skip-permissions", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "x", { ...claudeDefaults, mode: "bypass" });
  expect(cmd).toContain("--dangerously-skip-permissions");
  expect(cmd).not.toContain("--permission-mode");
});

test("claude-code 'auto' and 'bypass' produce distinct argv shapes", () => {
  // `auto` uses claude's real --permission-mode auto (classifier).
  // `bypass` uses --dangerously-skip-permissions (no classifier).
  // Both share a narrow PreToolUse install scope (see hook-installer.ts),
  // but the CLI shape diverges so the on-spawn behaviour is unambiguous.
  const autoCmd = buildCommand(builtin("claude-code"), "x", { ...claudeDefaults, mode: "auto" }).cmd;
  const bypassCmd = buildCommand(builtin("claude-code"), "x", { ...claudeDefaults, mode: "bypass" }).cmd;
  expect(autoCmd).toContain("--permission-mode");
  expect(autoCmd[autoCmd.indexOf("--permission-mode") + 1]).toBe("auto");
  expect(autoCmd).not.toContain("--dangerously-skip-permissions");
  expect(bypassCmd).toContain("--dangerously-skip-permissions");
  expect(bypassCmd).not.toContain("--permission-mode");
});

test("claude-code 'plan' mode emits --permission-mode plan", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "p", { ...claudeDefaults, mode: "plan" });
  expect(cmd).toContain("--permission-mode");
  expect(cmd[cmd.indexOf("--permission-mode") + 1]).toBe("plan");
  expect(cmd).not.toContain("--dangerously-skip-permissions");
  expect(cmd).not.toContain("--print");
});

test("claude-code 'ask' mode emits no permission flag", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "p", { ...claudeDefaults, mode: "ask" });
  expect(cmd).not.toContain("--permission-mode");
  expect(cmd).not.toContain("--dangerously-skip-permissions");
  expect(cmd).not.toContain("--print");
});

test("claude-code unknown mode is passed through as --permission-mode <id>", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "p", { ...claudeDefaults, mode: "future-mode" });
  const i = cmd.indexOf("--permission-mode");
  expect(i).toBeGreaterThan(-1);
  expect(cmd[i + 1]).toBe("future-mode");
});

test("claude-code unknown model is passed through verbatim", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "p", { ...claudeDefaults, model: "claude-mystery-9-0" });
  const i = cmd.indexOf("--model");
  expect(cmd[i + 1]).toBe("claude-mystery-9-0");
});

test("claude-code appends the prompt as the final argv element", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "this should appear", { ...claudeDefaults });
  expect(cmd[cmd.length - 1]).toBe("this should appear");
});

test("claude-code with empty prompt does not append an empty argv element", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "", { ...claudeDefaults });
  expect(cmd).not.toContain("");
});

test("claude-code resumeSessionId adds --resume <id> to the argv (no --session-id)", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "x", {
    ...claudeDefaults,
    resumeSessionId: "abc-123-uuid",
  });
  const i = cmd.indexOf("--resume");
  expect(i).toBeGreaterThan(-1);
  expect(cmd[i + 1]).toBe("abc-123-uuid");
  expect(cmd).not.toContain("--session-id");
});

test("claude-code sessionId adds --session-id <uuid> to the argv", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "x", {
    ...claudeDefaults,
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
  });
  const i = cmd.indexOf("--session-id");
  expect(i).toBeGreaterThan(-1);
  expect(cmd[i + 1]).toBe("550e8400-e29b-41d4-a716-446655440000");
});

test("claude-code resumeSessionId takes precedence over sessionId", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "x", {
    ...claudeDefaults,
    resumeSessionId: "resumed-id",
    sessionId: "fresh-id",
  });
  expect(cmd).toContain("--resume");
  expect(cmd).not.toContain("--session-id");
});

test("claude-code without resumeSessionId or sessionId omits both flags", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "x", { ...claudeDefaults });
  expect(cmd).not.toContain("--resume");
  expect(cmd).not.toContain("--session-id");
});

test("claude-code with haiku-4.5 model + null effort emits no CLAUDE_CODE_EFFORT_LEVEL", () => {
  // Haiku 4.5 is the carve-out: the model doesn't accept the effort flag,
  // so the UI sends null and buildCommand emits no env var.
  const result = buildCommand(builtin("claude-code"), "p", {
    mode: "auto",
    model: "haiku-4.5",
    effort: null,
  });
  expect(result.env).toBeUndefined();
  expect(result.cmd).toContain("--model");
});

test("claude-code throws when model is missing", () => {
  expect(() =>
    buildCommand(builtin("claude-code"), "p", { mode: "auto", effort: "high" }),
  ).toThrow(/model is required/);
});

test("claude-code throws when effort is missing for a model that supports it", () => {
  expect(() =>
    buildCommand(builtin("claude-code"), "p", { mode: "auto", model: "opus-4.7" }),
  ).toThrow(/effort is required/);
});

test("codex with defaults emits --model gpt-5-codex + reasoning effort + --full-auto", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", { ...codexDefaults });
  expect(cmd).toEqual([
    "codex", "exec",
    "--model", "gpt-5-codex",
    "-c", "model_reasoning_effort=high",
    "--full-auto",
    "hi",
  ]);
});

test("codex 'ask' mode drops --full-auto so codex prompts as usual", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", { ...codexDefaults, mode: "ask" });
  expect(cmd).not.toContain("--full-auto");
  expect(cmd).toEqual([
    "codex", "exec",
    "--model", "gpt-5-codex",
    "-c", "model_reasoning_effort=high",
    "hi",
  ]);
});

test("codex model 'gpt-5' adds --model gpt-5 before the prompt", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", { ...codexDefaults, model: "gpt-5", mode: "auto" });
  expect(cmd).toEqual([
    "codex", "exec",
    "--model", "gpt-5",
    "-c", "model_reasoning_effort=high",
    "--full-auto",
    "hi",
  ]);
});

test("codex effort 'high' adds -c model_reasoning_effort=high", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", { ...codexDefaults, effort: "high", mode: "auto" });
  expect(cmd).toContain("-c");
  expect(cmd[cmd.indexOf("-c") + 1]).toBe("model_reasoning_effort=high");
});

test("codex throws when model is missing", () => {
  expect(() =>
    buildCommand(builtin("codex"), "hi", { mode: "auto", effort: "high" }),
  ).toThrow(/model is required/);
});

test("codex throws when effort is missing for a model that supports it", () => {
  expect(() =>
    buildCommand(builtin("codex"), "hi", { mode: "auto", model: "gpt-5" }),
  ).toThrow(/effort is required/);
});

test("claude-code 'max' effort sets CLAUDE_CODE_EFFORT_LEVEL=max env", () => {
  const result = buildCommand(builtin("claude-code"), "do the thing", { ...claudeDefaults, effort: "max", mode: "auto" });
  expect(result.env).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: "max" });
});

test.each(["low", "medium", "high", "xhigh"])(
  "claude-code '%s' effort sets CLAUDE_CODE_EFFORT_LEVEL accordingly",
  (level) => {
    const result = buildCommand(builtin("claude-code"), "p", { ...claudeDefaults, effort: level, mode: "auto" });
    expect(result.env).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: level });
  },
);

test("claude-code unknown effort id is dropped (no env)", () => {
  // Unknown values still satisfy the "effort was provided" check but are
  // filtered out of CLAUDE_EFFORT_VALUES so they don't reach the CLI.
  const result = buildCommand(builtin("claude-code"), "p", { ...claudeDefaults, effort: "yolo", mode: "auto" });
  expect(result.env).toBeUndefined();
});

test("AGETOR_CLAUDE_ARGS extra args land before the prompt", () => {
  process.env.AGETOR_CLAUDE_ARGS = "--verbose --foo";
  const { cmd } = buildCommand(builtin("claude-code"), "p", { ...claudeDefaults });
  expect(cmd.slice(-3)).toEqual(["--verbose", "--foo", "p"]);
});

test("AGETOR_CODEX_ARGS extra args still land before the prompt", () => {
  process.env.AGETOR_CODEX_ARGS = "--verbose --foo";
  const { cmd } = buildCommand(builtin("codex"), "p", { ...codexDefaults });
  expect(cmd.slice(-3)).toEqual(["--verbose", "--foo", "p"]);
});

// Invariant test for AGENT_OPTIONS — guards against re-introducing the
// "default" placeholder. No id in any list should be the literal string
// "default" anymore (the per-kind DEFAULT_MODEL / DEFAULT_EFFORT constants
// supersede it). All ids within a list must be unique.
const AGENTS = Object.keys(AGENT_OPTIONS) as AgentKind[];
test.each(AGENTS)("AGENT_OPTIONS[%s] has unique ids and no 'default' placeholder", (agent) => {
  const { models, modes, efforts } = AGENT_OPTIONS[agent];

  const modelIds = models.map((m) => m.id);
  expect(new Set(modelIds).size).toBe(modelIds.length);
  expect(modelIds).not.toContain("default");

  const modeIds = modes.map((m) => m.id);
  expect(new Set(modeIds).size).toBe(modeIds.length);
  expect(modeIds).not.toContain("default");

  const effortIds = efforts.map((m) => m.id);
  expect(effortIds.length).toBeGreaterThan(0);
  expect(new Set(effortIds).size).toBe(effortIds.length);
  expect(effortIds).not.toContain("default");
});
