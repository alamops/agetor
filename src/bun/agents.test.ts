import { test, expect, beforeEach } from "bun:test";
import {
  buildCommand,
  buildHarnessTerminalCommand,
  isValidEnvKey,
  toTerminalAppleScript,
} from "./agents.ts";
import { AGENT_OPTIONS, type AgentKind, type Harness } from "../shared/types.ts";

beforeEach(() => {
  // Force the literal "claude" / "codex" names in argv. Production
  // `resolveBin()` now goes through `Bun.which(name, { PATH })` to dodge
  // Bun's startup PATH cache (see agent-status.ts) — without these
  // overrides, tests on a machine with claude installed would see an
  // absolute path in argv[0] and the equality checks would drift per host.
  process.env.AGETOR_CLAUDE_BIN = "claude";
  process.env.AGETOR_CODEX_BIN = "codex";
  process.env.AGETOR_CURSOR_BIN = "cursor-agent";
  delete process.env.AGETOR_CLAUDE_ARGS;
  delete process.env.AGETOR_CODEX_ARGS;
  delete process.env.AGETOR_CURSOR_ARGS;
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
// Cursor has no effort knob — omitted from the defaults object entirely
// (unlike claude/codex, `buildCommand`'s cursor branch never inspects
// `opts.effort`, so leaving it unset is the realistic runtime shape).
const cursorDefaults = { mode: "auto", model: "auto" } as const;

test("aliased claude-code with a config-dir override emits CLAUDE_CONFIG_DIR (not HOME)", () => {
  // HOME is deliberately not overridden — see harnessEnv: re-homing breaks
  // macOS keychain access for claude's "Claude Code-credentials" lookup and
  // surfaces as "Not logged in" even with valid tokens.
  const result = buildCommand(
    alias("claude-code", { home: "/tmp/agetor-test/claude-2" }),
    "p",
    { ...claudeDefaults },
  );
  expect(result.env?.CLAUDE_CONFIG_DIR).toBe("/tmp/agetor-test/claude-2");
  expect(result.env?.HOME).toBeUndefined();
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

test("aliased cursor with HOME override emits HOME only (no CODEX_HOME)", () => {
  // cursor-agent has no dedicated config-dir env var, so isolating an
  // additional account means a plain HOME override — unlike codex, which
  // also sets CODEX_HOME.
  const result = buildCommand(
    alias("cursor", { home: "/tmp/agetor-test/cursor-2" }),
    "p",
    { ...cursorDefaults },
  );
  expect(result.env?.HOME).toBe("/tmp/agetor-test/cursor-2");
  expect(result.env?.CODEX_HOME).toBeUndefined();
});

test("cursor harness without a home override sets neither HOME nor CODEX_HOME (env undefined)", () => {
  const result = buildCommand(builtin("cursor"), "p", { ...cursorDefaults });
  expect(result.env).toBeUndefined();
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
    "--", "the prompt",
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
    "--", "do thing",
  ]);
});

test("claude-code 'opus-4.8' maps to --model claude-opus-4-8", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "do thing", { ...claudeDefaults, model: "opus-4.8", mode: "auto" });
  expect(cmd).toEqual([
    "claude",
    "--model", "claude-opus-4-8",
    "--permission-mode", "auto",
    "--", "do thing",
  ]);
});

test("claude-code 'fable-5' maps to --model claude-fable-5", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "do thing", { ...claudeDefaults, model: "fable-5", mode: "auto" });
  expect(cmd).toEqual([
    "claude",
    "--model", "claude-fable-5",
    "--permission-mode", "auto",
    "--", "do thing",
  ]);
});

test("claude-code 'sonnet-5' maps to --model claude-sonnet-5", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "do thing", { ...claudeDefaults, model: "sonnet-5", mode: "auto" });
  expect(cmd).toEqual([
    "claude",
    "--model", "claude-sonnet-5",
    "--permission-mode", "auto",
    "--", "do thing",
  ]);
});

test("claude-code prefixes the prompt with `--` so a leading-dash prompt isn't parsed as a flag", () => {
  // Regression: a prompt like a markdown checklist item starts with `-`.
  // Without the `--` terminator claude's CLI errors `unknown option` and
  // exits before writing any JSONL — the tmux driver then only sees a dead
  // session + empty pane + 30s timeout. The `--` must sit immediately before
  // the prompt and after every flag.
  const { cmd } = buildCommand(
    builtin("claude-code"),
    "- [ ] Add a button",
    { ...claudeDefaults, mode: "auto" },
  );
  expect(cmd[cmd.length - 2]).toBe("--");
  expect(cmd[cmd.length - 1]).toBe("- [ ] Add a button");
  // `--` comes after the permission flag, not before it.
  expect(cmd.indexOf("--")).toBeGreaterThan(cmd.indexOf("--permission-mode"));
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

// The prompt is delivered on stdin (trailing `-`), not as an argv element, so
// the driver can pipe it in and a `-`-leading prompt can't be misparsed.
// `--json --color never --skip-git-repo-check` are the structured-streaming +
// clean-capture + run-anywhere flags the tmux driver depends on.
test("codex with defaults emits --model + reasoning effort + structured-stream flags + --sandbox workspace-write, prompt via stdin", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", { ...codexDefaults });
  expect(cmd).toEqual([
    "codex", "exec",
    "--model", "gpt-5-codex",
    "-c", "model_reasoning_effort=high",
    "--json", "--color", "never", "--skip-git-repo-check",
    "--sandbox", "workspace-write",
    "-",
  ]);
});

test("codex 'ask' mode uses --sandbox read-only so codex can't change anything", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", { ...codexDefaults, mode: "ask" });
  expect(cmd).not.toContain("workspace-write");
  expect(cmd).toEqual([
    "codex", "exec",
    "--model", "gpt-5-codex",
    "-c", "model_reasoning_effort=high",
    "--json", "--color", "never", "--skip-git-repo-check",
    "--sandbox", "read-only",
    "-",
  ]);
});

test("codex model 'gpt-5.5' passes through verbatim as --model", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", { ...codexDefaults, model: "gpt-5.5", mode: "auto" });
  expect(cmd).toEqual([
    "codex", "exec",
    "--model", "gpt-5.5",
    "-c", "model_reasoning_effort=high",
    "--json", "--color", "never", "--skip-git-repo-check",
    "--sandbox", "workspace-write",
    "-",
  ]);
});

test("codex model 'gpt-5' adds --model gpt-5", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", { ...codexDefaults, model: "gpt-5", mode: "auto" });
  expect(cmd).toEqual([
    "codex", "exec",
    "--model", "gpt-5",
    "-c", "model_reasoning_effort=high",
    "--json", "--color", "never", "--skip-git-repo-check",
    "--sandbox", "workspace-write",
    "-",
  ]);
});

test("codex resume injects the `resume <thread_id>` subcommand before the stdin sentinel", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", { ...codexDefaults, resumeSessionId: "thread-abc" });
  // Parent flags must precede `resume`; the stdin `-` is last.
  expect(cmd.slice(-3)).toEqual(["resume", "thread-abc", "-"]);
  expect(cmd.indexOf("--json")).toBeLessThan(cmd.indexOf("resume"));
});

test("codex auto with external git dirs escalates to danger-full-access + approval_policy=never", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", {
    ...codexDefaults,
    mode: "auto",
    codexExternalGitDirs: ["/Users/me/Projects/app/.git"],
  });
  // Sandbox is dropped to full access (workspace-write can't reach the external
  // .git), paired with approval_policy=never so headless exec never stalls.
  expect(cmd).toContain("danger-full-access");
  expect(cmd).not.toContain("workspace-write");
  const ap = cmd.indexOf("approval_policy=never");
  expect(ap).toBeGreaterThan(-1);
  expect(cmd[ap - 1]).toBe("-c");
});

test("codex auto + external git dirs keeps the escalation before the `resume` subcommand", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", {
    ...codexDefaults,
    mode: "auto",
    codexExternalGitDirs: ["/repo/.git"],
    resumeSessionId: "thread-xyz",
  });
  // Parent flags (incl. the approval_policy -c) must precede `resume`.
  expect(cmd.indexOf("danger-full-access")).toBeLessThan(cmd.indexOf("resume"));
  expect(cmd.indexOf("approval_policy=never")).toBeLessThan(cmd.indexOf("resume"));
});

test("codex 'ask' mode stays read-only even when external git dirs are present", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", { ...codexDefaults, mode: "ask", codexExternalGitDirs: ["/repo/.git"] });
  expect(cmd).toContain("read-only");
  expect(cmd).not.toContain("danger-full-access");
  expect(cmd).not.toContain("approval_policy=never");
});

test("codex auto with no external git dirs stays on workspace-write (ordinary checkout)", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", { ...codexDefaults, mode: "auto", codexExternalGitDirs: [] });
  expect(cmd).toContain("workspace-write");
  expect(cmd).not.toContain("danger-full-access");
  expect(cmd).not.toContain("approval_policy=never");
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

// Cursor is hosted in tmux exactly like codex (one-shot turn per invocation),
// but the prompt is NOT an argv element here — cursor-tmux.ts appends it at
// spawn time via its own injection-safe quoting. `buildCommand`'s job is just
// the flags: -p stream-json, --model, the auto/ask force+sandbox posture, and
// --resume. There is no effort flag at all (cursor-agent has none).
test("cursor with defaults emits -p --output-format stream-json --model auto --force --sandbox disabled", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", { ...cursorDefaults });
  expect(cmd).toEqual([
    "cursor-agent",
    "-p", "--output-format", "stream-json",
    "--model", "auto",
    "--force", "--sandbox", "disabled",
  ]);
});

test("cursor 'ask' mode emits no --force / --sandbox flags (propose-only — cursor can't execute headlessly)", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", { ...cursorDefaults, mode: "ask" });
  expect(cmd).toEqual([
    "cursor-agent",
    "-p", "--output-format", "stream-json",
    "--model", "auto",
  ]);
  expect(cmd).not.toContain("--force");
  expect(cmd).not.toContain("--sandbox");
});

test("cursor null mode defaults to auto (--force --sandbox disabled), house convention", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", { model: "auto", mode: null });
  expect(cmd).toContain("--force");
  expect(cmd).toContain("--sandbox");
  expect(cmd[cmd.indexOf("--sandbox") + 1]).toBe("disabled");
});

test("cursor explicit model 'claude-opus-4.8' passes through verbatim as --model", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", { ...cursorDefaults, model: "claude-opus-4.8" });
  expect(cmd).toEqual([
    "cursor-agent",
    "-p", "--output-format", "stream-json",
    "--model", "claude-opus-4.8",
    "--force", "--sandbox", "disabled",
  ]);
});

test("cursor unknown model id passes through verbatim (house convention: unknown ids just work)", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", { ...cursorDefaults, model: "cursor-mystery-9000" });
  const i = cmd.indexOf("--model");
  expect(i).toBeGreaterThan(-1);
  expect(cmd[i + 1]).toBe("cursor-mystery-9000");
});

test("cursor resumeSessionId adds --resume <id> as the final argv elements (--resume is a flag, no subcommand ordering constraint)", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", { ...cursorDefaults, resumeSessionId: "sess-99" });
  expect(cmd.slice(-2)).toEqual(["--resume", "sess-99"]);
});

test("cursor ignores effort entirely — argv and env are identical with or without an effort id", () => {
  const withEffort = buildCommand(builtin("cursor"), "hi", { ...cursorDefaults, effort: "high" });
  const withoutEffort = buildCommand(builtin("cursor"), "hi", { ...cursorDefaults });
  expect(withEffort.cmd).toEqual(withoutEffort.cmd);
  expect(withEffort.env).toEqual(withoutEffort.env);
});

test("cursor throws when model is missing", () => {
  expect(() =>
    buildCommand(builtin("cursor"), "hi", { mode: "auto" }),
  ).toThrow(/model is required/);
});

test("AGETOR_CURSOR_BIN override is respected for the built-in cursor harness", () => {
  process.env.AGETOR_CURSOR_BIN = "/env-fallback/cursor-agent";
  expect(buildCommand(builtin("cursor"), "hi", { ...cursorDefaults }).cmd[0]).toBe(
    "/env-fallback/cursor-agent",
  );
});

test("AGETOR_CURSOR_ARGS extra args land after the mode flags and before --resume", () => {
  process.env.AGETOR_CURSOR_ARGS = "--verbose --foo";
  const { cmd } = buildCommand(builtin("cursor"), "hi", {
    ...cursorDefaults,
    resumeSessionId: "sess-1",
  });
  expect(cmd).toEqual([
    "cursor-agent",
    "-p", "--output-format", "stream-json",
    "--model", "auto",
    "--force", "--sandbox", "disabled",
    "--verbose", "--foo",
    "--resume", "sess-1",
  ]);
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

test("AGETOR_CLAUDE_ARGS extra args land before the prompt (and before the `--` terminator)", () => {
  process.env.AGETOR_CLAUDE_ARGS = "--verbose --foo";
  const { cmd } = buildCommand(builtin("claude-code"), "p", { ...claudeDefaults });
  expect(cmd.slice(-4)).toEqual(["--verbose", "--foo", "--", "p"]);
});

test("AGETOR_CODEX_ARGS extra args land before the stdin sentinel", () => {
  process.env.AGETOR_CODEX_ARGS = "--verbose --foo";
  const { cmd } = buildCommand(builtin("codex"), "p", { ...codexDefaults });
  expect(cmd.slice(-3)).toEqual(["--verbose", "--foo", "-"]);
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

// --- isValidEnvKey -----------------------------------------------------------

test("isValidEnvKey accepts POSIX identifiers and rejects everything else", () => {
  for (const ok of ["FOO", "_x", "A1_B2", "CLAUDE_CONFIG_DIR"]) {
    expect(isValidEnvKey(ok)).toBe(true);
  }
  for (const bad of ["1FOO", "FOO BAR", "FOO=BAR", "X; rm -rf ~", "FOO-BAR", "", "a.b"]) {
    expect(isValidEnvKey(bad)).toBe(false);
  }
});

// --- buildHarnessTerminalCommand ---------------------------------------------

test("the built-in claude-code launches the bare agent — no env prefix, no PATH", () => {
  expect(buildHarnessTerminalCommand(builtin("claude-code"))).toBe("claude");
});

test("a config-dir alias launches with CLAUDE_CONFIG_DIR inline and never HOME (keychain stays put)", () => {
  const cmd = buildHarnessTerminalCommand(alias("claude-code", { home: "/cfg" }));
  expect(cmd).toBe("CLAUDE_CONFIG_DIR='/cfg' claude");
  expect(cmd).not.toContain("HOME=");
});

test("a codex alias re-homes inline via HOME + CODEX_HOME", () => {
  expect(buildHarnessTerminalCommand(alias("codex", { home: "/cfg" }))).toBe(
    "HOME='/cfg' CODEX_HOME='/cfg/.codex' codex",
  );
});

test("an explicit bin override prepends its dir to PATH so the bare name resolves", () => {
  expect(buildHarnessTerminalCommand(alias("claude-code", { bin: "/opt/bin/claude" }))).toBe(
    "PATH='/opt/bin':$PATH claude",
  );
});

test("env values with shell metacharacters are single-quote-escaped inline", () => {
  const cmd = buildHarnessTerminalCommand(
    alias("claude-code", { env: { TOKEN: "pa$$'w", SPACED: 'a b "c"' } }),
  );
  // ' is closed-escaped-reopened; $ and " stay literal inside single quotes.
  expect(cmd).toContain("TOKEN='pa$$'\\''w'");
  expect(cmd).toContain(`SPACED='a b "c"'`);
  expect(cmd.endsWith(" claude")).toBe(true);
});

test("non-identifier env keys are dropped, neutralizing injection from legacy rows", () => {
  const cmd = buildHarnessTerminalCommand(
    alias("claude-code", { env: { GOOD: "1", "EVIL; touch /tmp/pwned": "2" } }),
  );
  expect(cmd).toContain("GOOD='1'");
  expect(cmd).not.toContain("touch /tmp/pwned");
});

// --- toTerminalAppleScript ---------------------------------------------------

test("toTerminalAppleScript escapes quotes/backslashes and wraps in do script + activate", () => {
  const script = toTerminalAppleScript('echo "hi"; cd /x\\y');
  expect(script).toContain('do script "echo \\"hi\\"; cd /x\\\\y"');
  expect(script).toContain('activate application "Terminal"');
});
