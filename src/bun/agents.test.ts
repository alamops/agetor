import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_OPTIONS,
  defaultModeFor,
  FX_PROVIDER_STATUS_PREFIX,
  FX_RECOVERY_STATUS_PREFIX,
  FX_SESSION_TITLE_STATUS_PREFIX,
  FX_USAGE_STATUS_PREFIX,
  type AgentKind,
  type Harness,
  type RunEventStream,
  type Task,
} from "../shared/types.ts";
import { FX_FAILED_SUMMARY_SUFFIX, FX_PAUSED_SUMMARY_SUFFIX } from "../shared/fx-recovery.ts";

// agents.ts imports codex-tmux.ts/gemini-tmux.ts, both of which import
// dataDir from db.ts — db.ts opens its sqlite connection at module-load
// time. A plain top-level `import` is hoisted ahead of any other code in
// this file, so AGETOR_DATA_DIR must be set before a *dynamic* import
// instead (same pattern as harnesses.test.ts). Without this, this file (or
// whichever file `bun test` loads first) can silently open the real
// ~/.agetor-dev database.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-agents-db-"));
const {
  buildCommand,
  buildHarnessTerminalCommand,
  CLAUDE_PROMPT_ARGV_MAX_BYTES,
  GEMINI_PROMPT_ARGV_MAX_BYTES,
  isValidEnvKey,
  toTerminalAppleScript,  claudeModelPickerFamily,
  spawnAgent,
  FAKE_FX_RECOVERY_PROMPT_MARKER,
  FAKE_FX_PERMISSION_PROMPT_MARKER,
  FAKE_FX_REPAUSE_PROMPT_MARKER,
  FAKE_FX_RECOVERY_URL_PROMPT_MARKER,
  FAKE_FX_EFFORT_UNOFFERED_PROMPT_MARKER,
  FAKE_FX_RECOVERY_FAILED_PROMPT_MARKER,
  FAKE_FX_SPEED_UNOFFERED_PROMPT_MARKER,
  FAKE_FX_TOOL_META_PROMPT_MARKER,
  FAKE_FX_STEER_PROMPT_MARKER,
  FAKE_CURSOR_STREAM_PROMPT_MARKER,
  FAKE_CLAUDE_HANDOFF_PROMPT_MARKER,
  buildFxLaunchOptions,
  resolveBin,
  harnessEnv,
  opencodeEffectiveServerFor,
  OPENCODE_TITLE_MAX_CHARS,
  FAKE_OPENCODE_SUBAGENT_PROMPT_MARKER,
  FAKE_OPENCODE_ERROR_PROMPT_MARKER,
  FAKE_OPENCODE_RESUME_FAIL_PROMPT_MARKER,
  fakeOpencodeChildSessionId,
  opencodeResumeFailedStatusLine,
} = await import("./agents.ts");
const { FX_STEER_DROPPED_STATUS, fxSpeedNotOfferedLine } = await import("./fx-acp.ts");
const { dataDir, tasks, runs, subagents: subagentsDb } = await import("./db.ts");

// `bun test` runs every file in one process: restore the bin/args/driver
// vars `beforeEach` overwrites once this file is done, so a later file never
// inherits `AGETOR_OPENCODE_BIN = "opencode"` and runs the real CLI (which
// writes OpenCode state into $HOME — src/test-preload.ts points it at a
// missing binary by default).
const ENV_KEYS_RESET_PER_TEST = [
  "AGETOR_CLAUDE_BIN", "AGETOR_CODEX_BIN", "AGETOR_CURSOR_BIN", "AGETOR_GEMINI_BIN",
  "AGETOR_FX_BIN", "AGETOR_ANTIGRAVITY_BIN", "AGETOR_OPENCODE_BIN",
  "AGETOR_CLAUDE_ARGS", "AGETOR_CODEX_ARGS", "AGETOR_CURSOR_ARGS", "AGETOR_GEMINI_ARGS",
  "AGETOR_FX_ARGS", "AGETOR_ANTIGRAVITY_ARGS", "AGETOR_OPENCODE_ARGS", "AGETOR_FX_DRIVER",
] as const;
const envBeforeFile = new Map(ENV_KEYS_RESET_PER_TEST.map((k) => [k, process.env[k]] as const));
afterAll(() => {
  for (const [k, v] of envBeforeFile) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  // Force the literal "claude" / "codex" names in argv. Production
  // `resolveBin()` now goes through `Bun.which(name, { PATH })` to dodge
  // Bun's startup PATH cache (see agent-status.ts) — without these
  // overrides, tests on a machine with claude installed would see an
  // absolute path in argv[0] and the equality checks would drift per host.
  process.env.AGETOR_CLAUDE_BIN = "claude";
  process.env.AGETOR_CODEX_BIN = "codex";
  process.env.AGETOR_CURSOR_BIN = "cursor-agent";
  process.env.AGETOR_GEMINI_BIN = "gemini";
  process.env.AGETOR_FX_BIN = "fx";
  process.env.AGETOR_ANTIGRAVITY_BIN = "agy";
  process.env.AGETOR_OPENCODE_BIN = "opencode";
  delete process.env.AGETOR_CLAUDE_ARGS;
  delete process.env.AGETOR_CODEX_ARGS;
  delete process.env.AGETOR_CURSOR_ARGS;
  delete process.env.AGETOR_GEMINI_ARGS;
  delete process.env.AGETOR_FX_ARGS;
  delete process.env.AGETOR_ANTIGRAVITY_ARGS;
  delete process.env.AGETOR_OPENCODE_ARGS;
  delete process.env.AGETOR_FX_DRIVER;
});

// The fx repause/recovery-URL fake-driver toggles below are process-wide
// (mirrors AGETOR_FAKE_FX_RECOVERY/AGETOR_FAKE_FX_PERMISSION) — reset them
// unconditionally after every test so a test that sets one and then throws
// (or simply forgets a `finally`) can't leak it into an unrelated later
// test, the same hygiene `beforeEach` already applies to the bin/args vars
// above.
afterEach(() => {
  delete process.env.AGETOR_FAKE_FX_REPAUSE;
  delete process.env.AGETOR_FAKE_FX_RECOVERY_URL;
  delete process.env.AGETOR_FAKE_FX_RECOVERY;
  delete process.env.AGETOR_FAKE_FX_EFFORT_UNOFFERED;
  delete process.env.AGETOR_FAKE_FX_RECOVERY_FAILED;
  delete process.env.AGETOR_FAKE_FX_STEER_HOLD_MS;
  delete process.env.AGETOR_FAKE_CURSOR_STREAM;
  delete process.env.AGETOR_FAKE_CURSOR_PLAN;
  delete process.env.AGETOR_CURSOR_DRIVER;
  delete process.env.AGETOR_CLAUDE_DRIVER;
  delete process.env.AGETOR_OPENCODE_DRIVER;
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
const codexDefaults = { mode: "auto", model: "gpt-6-astra", effort: "high" } as const;
// Cursor's effort rides inside the --model id (`cursorModelArg` composes
// model + effort + the Fast speed tier into one string), not a separate flag.
const cursorDefaults = { mode: "auto", model: "grok-4.7", effort: "high" } as const;
// Gemini has no effort flag at all (see MODEL_EFFORT_SUPPORT.gemini in
// shared/types.ts) — buildCommand's gemini branch never reads opts.effort.
const geminiDefaults = { mode: "auto", model: "gemini-3.1-pro-preview" } as const;
// fx has no effort flag either (silently ignored, mirrors gemini) but,
// unlike every other kind, buildCommand also requires `runId` (used to build
// the deterministic --log-file path) — see the throw tests below.
const fxDefaults = { mode: "auto", model: "fx-default", runId: "run-fx-1" } as const;

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

test("claude-code 'opus-5.5' maps to --model claude-opus-5-5", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "do thing", { ...claudeDefaults, model: "opus-5.5", mode: "auto" });
  expect(cmd).toEqual([
    "claude",
    "--model", "claude-opus-5-5",
    "--permission-mode", "auto",
    "--", "do thing",
  ]);
});

test("claude-code 'opus-5' maps to --model claude-opus-5", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "do thing", { ...claudeDefaults, model: "opus-5", mode: "auto" });
  expect(cmd).toEqual([
    "claude",
    "--model", "claude-opus-5",
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

test("claude-code 'mythos-5' maps to --model claude-mythos-5", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "do thing", { ...claudeDefaults, model: "mythos-5", mode: "auto" });
  expect(cmd).toEqual([
    "claude",
    "--model", "claude-mythos-5",
    "--permission-mode", "auto",
    "--", "do thing",
  ]);
});

test("claude-code 'fable-5.1' maps to --model claude-fable-5-1", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "do thing", { ...claudeDefaults, model: "fable-5.1", mode: "auto" });
  expect(cmd).toEqual([
    "claude",
    "--model", "claude-fable-5-1",
    "--permission-mode", "auto",
    "--", "do thing",
  ]);
});

test("claude-code 'mythos-5.1' maps to --model claude-mythos-5-1", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "do thing", { ...claudeDefaults, model: "mythos-5.1", mode: "auto" });
  expect(cmd).toEqual([
    "claude",
    "--model", "claude-mythos-5-1",
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

test("claude-code 'sonnet-5.5' maps to --model claude-sonnet-5-5", () => {
  const { cmd } = buildCommand(builtin("claude-code"), "do thing", { ...claudeDefaults, model: "sonnet-5.5", mode: "auto" });
  expect(cmd).toEqual([
    "claude",
    "--model", "claude-sonnet-5-5",
    "--permission-mode", "auto",
    "--", "do thing",
  ]);
});

test("claude-code 'haiku-5.5' maps to --model claude-haiku-5-5 and sets effort env", () => {
  const { cmd, env } = buildCommand(builtin("claude-code"), "do thing", {
    ...claudeDefaults,
    model: "haiku-5.5",
    mode: "auto",
    effort: "high",
  });
  expect(cmd).toContain("--model");
  expect(cmd[cmd.indexOf("--model") + 1]).toBe("claude-haiku-5-5");
  expect(env?.CLAUDE_CODE_EFFORT_LEVEL).toBe("high");
});

// ---------------------------------------------------------------------------
// claudeModelPickerFamily (src/bun/agents.ts) — maps an agetor claude-code
// model id to the model-FAMILY label claude 2.1.246's bare `/model` picker
// actually offers as a selectable row. Sole caller: reconcileTaskSession's
// model mirror (orchestrator.ts), which feeds the result to
// mirrorModelViaPicker (claude-tmux.ts).
// ---------------------------------------------------------------------------

test("claudeModelPickerFamily maps each current-release id to its picker row family", () => {
  expect(claudeModelPickerFamily("opus-5.5")).toBe("Opus");
  expect(claudeModelPickerFamily("sonnet-5.5")).toBe("Sonnet");
  expect(claudeModelPickerFamily("fable-5.1")).toBe("Fable");
  expect(claudeModelPickerFamily("haiku-5.5")).toBe("Haiku");
});

test("claudeModelPickerFamily returns null for ids the picker's single per-family row would misrepresent, has no row for, or doesn't recognize", () => {
  // Superseded-within-family ids: the picker's row always resolves to the
  // family's CURRENT release, which is a DIFFERENT specific version than
  // these — mirroring would silently switch the session to the wrong one.
  expect(claudeModelPickerFamily("opus-4.8")).toBeNull();
  expect(claudeModelPickerFamily("opus-4.7")).toBeNull();
  expect(claudeModelPickerFamily("opus-4.6")).toBeNull();
  expect(claudeModelPickerFamily("sonnet-4.6")).toBeNull();
  // fable-5 is now superseded by fable-5.1 — same "wrong version" hazard.
  expect(claudeModelPickerFamily("fable-5")).toBeNull();
  // opus-5 is now superseded by opus-5.5 — claude 2.1.280 makes
  // claude-opus-5-5 the default Opus model, so the picker's Opus row would
  // land on the wrong version.
  expect(claudeModelPickerFamily("opus-5")).toBeNull();
  // sonnet-5 is now superseded by sonnet-5.5 — claude 2.1.284 makes
  // claude-sonnet-5-5 the default Sonnet model, so the picker's Sonnet row
  // would land on the wrong version.
  expect(claudeModelPickerFamily("sonnet-5")).toBeNull();
  // haiku-4.5 is superseded by haiku-5.5 on CLI 2.1.293 (alias haiku →
  // claude-haiku-5-5), so the picker's Haiku row would land on the wrong version.
  expect(claudeModelPickerFamily("haiku-4.5")).toBeNull();
  // No picker row at all for either Mythos id.
  expect(claudeModelPickerFamily("mythos-5")).toBeNull();
  expect(claudeModelPickerFamily("mythos-5.1")).toBeNull();
  // Unknown/future raw id — never guess.
  expect(claudeModelPickerFamily("claude-opus-6")).toBeNull();
  // Empty string.
  expect(claudeModelPickerFamily("")).toBeNull();
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

test("claude-code 'ask' mode emits an EXPLICIT --permission-mode default", () => {
  // Omitting the flag would inherit the user-level `defaultMode` from
  // ~/.claude/settings.json (e.g. `auto`), silently running the task in a
  // looser mode than the one stored on it.
  const { cmd } = buildCommand(builtin("claude-code"), "p", { ...claudeDefaults, mode: "ask" });
  const i = cmd.indexOf("--permission-mode");
  expect(i).toBeGreaterThan(-1);
  expect(cmd[i + 1]).toBe("default");
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

// --- deferred prompt (CLAUDE_PROMPT_ARGV_MAX_BYTES) -------------------------
// Above CLAUDE_PROMPT_ARGV_MAX_BYTES, embedding the prompt in argv blows
// tmux's ~16KB client-command cap ("command too long"). buildCommand omits
// the prompt from argv entirely above the threshold and returns it as
// `deferredPrompt` instead; at-or-below the threshold argv is byte-identical
// to today's shape.

test("claude-code prompt of exactly CLAUDE_PROMPT_ARGV_MAX_BYTES bytes still rides argv, deferredPrompt undefined", () => {
  const prompt = "a".repeat(CLAUDE_PROMPT_ARGV_MAX_BYTES);
  const { cmd, deferredPrompt } = buildCommand(builtin("claude-code"), prompt, { ...claudeDefaults });
  expect(cmd[cmd.length - 2]).toBe("--");
  expect(cmd[cmd.length - 1]).toBe(prompt);
  expect(deferredPrompt).toBeUndefined();
});

test("claude-code prompt one byte over CLAUDE_PROMPT_ARGV_MAX_BYTES is deferred, not in argv", () => {
  const prompt = "a".repeat(CLAUDE_PROMPT_ARGV_MAX_BYTES + 1);
  const { cmd, deferredPrompt } = buildCommand(builtin("claude-code"), prompt, { ...claudeDefaults });
  expect(cmd).not.toContain(prompt);
  // No dangling `--` terminator left behind for the (now-absent) prompt.
  expect(cmd[cmd.length - 1]).not.toBe("--");
  expect(deferredPrompt).toBe(prompt);
});

test("claude-code deferred prompt still emits --resume <id>; only the prompt itself is deferred", () => {
  const prompt = "a".repeat(CLAUDE_PROMPT_ARGV_MAX_BYTES + 1);
  const { cmd, deferredPrompt } = buildCommand(builtin("claude-code"), prompt, {
    ...claudeDefaults,
    resumeSessionId: "abc-123-uuid",
  });
  const i = cmd.indexOf("--resume");
  expect(i).toBeGreaterThan(-1);
  expect(cmd[i + 1]).toBe("abc-123-uuid");
  expect(cmd).not.toContain(prompt);
  expect(cmd[cmd.length - 1]).not.toBe("--");
  expect(deferredPrompt).toBe(prompt);
});

test("claude-code defers on UTF-8 byte length, not JS string length (multi-byte prompt)", () => {
  // "€" is 1 UTF-16 code unit (.length counts it as 1) but 3 UTF-8 bytes.
  // 2000 of them → .length 2000 (well under the threshold) but byteLength
  // 6000 (over it) — this only defers if the check is Buffer.byteLength.
  const prompt = "€".repeat(2000);
  expect(prompt.length).toBeLessThan(CLAUDE_PROMPT_ARGV_MAX_BYTES);
  expect(Buffer.byteLength(prompt, "utf8")).toBeGreaterThan(CLAUDE_PROMPT_ARGV_MAX_BYTES);
  const { cmd, deferredPrompt } = buildCommand(builtin("claude-code"), prompt, { ...claudeDefaults });
  expect(cmd).not.toContain(prompt);
  expect(deferredPrompt).toBe(prompt);
});

test("codex is unaffected by prompt size — always delivered via stdin, never deferred", () => {
  // Codex's prompt never rides argv (it's piped via stdin, the trailing `-`
  // sentinel), so it has no size-driven argv problem and no deferredPrompt.
  const prompt = "a".repeat(CLAUDE_PROMPT_ARGV_MAX_BYTES * 4);
  const result = buildCommand(builtin("codex"), prompt, { ...codexDefaults });
  expect(result.cmd).not.toContain(prompt);
  expect(result.cmd[result.cmd.length - 1]).toBe("-");
  expect(result.deferredPrompt).toBeUndefined();
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
  // so the UI sends null and buildCommand emits no effort env var (the
  // prompt-suggestion default still rides along).
  const result = buildCommand(builtin("claude-code"), "p", {
    mode: "auto",
    model: "haiku-4.5",
    effort: null,
  });
  expect(result.env).toEqual({ CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false" });
  expect(result.env?.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
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
    "--model", "gpt-6-astra",
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
    "--model", "gpt-6-astra",
    "-c", "model_reasoning_effort=high",
    "--json", "--color", "never", "--skip-git-repo-check",
    "--sandbox", "read-only",
    "-",
  ]);
});

test("codex model 'gpt-6-astra' passes through verbatim as --model", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", { ...codexDefaults, model: "gpt-6-astra", mode: "auto" });
  expect(cmd).toEqual([
    "codex", "exec",
    "--model", "gpt-6-astra",
    "-c", "model_reasoning_effort=high",
    "--json", "--color", "never", "--skip-git-repo-check",
    "--sandbox", "workspace-write",
    "-",
  ]);
});

test("codex model 'gpt-6-astra-aeon' passes through verbatim as --model", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", { ...codexDefaults, model: "gpt-6-astra-aeon", mode: "auto" });
  expect(cmd).toEqual([
    "codex", "exec",
    "--model", "gpt-6-astra-aeon",
    "-c", "model_reasoning_effort=high",
    "--json", "--color", "never", "--skip-git-repo-check",
    "--sandbox", "workspace-write",
    "-",
  ]);
});

test("codex model 'gpt-6.1-sol' passes through verbatim as --model", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", { ...codexDefaults, model: "gpt-6.1-sol", mode: "auto" });
  expect(cmd).toEqual([
    "codex", "exec",
    "--model", "gpt-6.1-sol",
    "-c", "model_reasoning_effort=high",
    "--json", "--color", "never", "--skip-git-repo-check",
    "--sandbox", "workspace-write",
    "-",
  ]);
});

test("codex model 'gpt-6-sol' passes through verbatim as --model", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", { ...codexDefaults, model: "gpt-6-sol", mode: "auto" });
  expect(cmd).toEqual([
    "codex", "exec",
    "--model", "gpt-6-sol",
    "-c", "model_reasoning_effort=high",
    "--json", "--color", "never", "--skip-git-repo-check",
    "--sandbox", "workspace-write",
    "-",
  ]);
});

test("codex model 'gpt-6-luna' passes through verbatim as --model", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", { ...codexDefaults, model: "gpt-6-luna", mode: "auto" });
  expect(cmd).toEqual([
    "codex", "exec",
    "--model", "gpt-6-luna",
    "-c", "model_reasoning_effort=high",
    "--json", "--color", "never", "--skip-git-repo-check",
    "--sandbox", "workspace-write",
    "-",
  ]);
});

test("codex model 'gpt-6.1-terra' passes through verbatim as --model", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", { ...codexDefaults, model: "gpt-6.1-terra", mode: "auto" });
  expect(cmd).toEqual([
    "codex", "exec",
    "--model", "gpt-6.1-terra",
    "-c", "model_reasoning_effort=high",
    "--json", "--color", "never", "--skip-git-repo-check",
    "--sandbox", "workspace-write",
    "-",
  ]);
});

test("codex model 'gpt-5.6-sol' passes through verbatim as --model", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", { ...codexDefaults, model: "gpt-5.6-sol", mode: "auto" });
  expect(cmd).toEqual([
    "codex", "exec",
    "--model", "gpt-5.6-sol",
    "-c", "model_reasoning_effort=high",
    "--json", "--color", "never", "--skip-git-repo-check",
    "--sandbox", "workspace-write",
    "-",
  ]);
});

test("codex model 'gpt-5.6-cyber' passes through verbatim as --model", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", { ...codexDefaults, model: "gpt-5.6-cyber", mode: "auto" });
  expect(cmd).toEqual([
    "codex", "exec",
    "--model", "gpt-5.6-cyber",
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

test("codex effort 'ultra' passes through verbatim on gpt-6-astra (-c model_reasoning_effort=ultra)", () => {
  // buildCommand never filters efforts against MODEL_EFFORT_SUPPORT — that
  // gate lives at the picker layer (supportedEfforts), not the CLI-argv
  // layer, so any effort id the caller passes rides straight through.
  const { cmd } = buildCommand(builtin("codex"), "hi", {
    ...codexDefaults,
    model: "gpt-6-astra",
    effort: "ultra",
    mode: "auto",
  });
  expect(cmd).toContain("-c");
  expect(cmd[cmd.indexOf("-c") + 1]).toBe("model_reasoning_effort=ultra");
});

test("codex effort 'none' passes through verbatim on gpt-5.6-sol (-c model_reasoning_effort=none)", () => {
  // Pins that the CLI path never filters efforts: "none" is curated for Sol
  // today, but this contract holds regardless of the curated table's shape.
  const { cmd } = buildCommand(builtin("codex"), "hi", {
    ...codexDefaults,
    model: "gpt-5.6-sol",
    effort: "none",
    mode: "auto",
  });
  expect(cmd).toContain("-c");
  expect(cmd[cmd.indexOf("-c") + 1]).toBe("model_reasoning_effort=none");
});

test("codex gpt-6.1-terra with effort none emits -c model_reasoning_effort=none", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", {
    ...codexDefaults,
    model: "gpt-6.1-terra",
    effort: "none",
    mode: "auto",
  });
  expect(cmd).toContain("-c");
  expect(cmd[cmd.indexOf("-c") + 1]).toBe("model_reasoning_effort=none");
});

test("codex effort 'ultra' passes through verbatim on gpt-6.1-sol (-c model_reasoning_effort=ultra)", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", {
    ...codexDefaults,
    model: "gpt-6.1-sol",
    effort: "ultra",
    mode: "auto",
  });
  expect(cmd).toContain("-c");
  expect(cmd[cmd.indexOf("-c") + 1]).toBe("model_reasoning_effort=ultra");
});

test("codex effort 'ultra' passes through verbatim on gpt-6-sol (-c model_reasoning_effort=ultra)", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", {
    ...codexDefaults,
    model: "gpt-6-sol",
    effort: "ultra",
    mode: "auto",
  });
  expect(cmd).toContain("-c");
  expect(cmd[cmd.indexOf("-c") + 1]).toBe("model_reasoning_effort=ultra");
});

test("codex effort 'none' passes through verbatim on gpt-6-luna (-c model_reasoning_effort=none)", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", {
    ...codexDefaults,
    model: "gpt-6-luna",
    effort: "none",
    mode: "auto",
  });
  expect(cmd).toContain("-c");
  expect(cmd[cmd.indexOf("-c") + 1]).toBe("model_reasoning_effort=none");
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
// --resume. Cursor effort/Fast/Max Mode are composed into the --model id.
test("cursor with defaults emits -p --output-format stream-json --model grok-4.7-high --force --sandbox disabled", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", { ...cursorDefaults });
  expect(cmd).toEqual([
    "cursor-agent",
    "-p", "--output-format", "stream-json",
    "--model", "grok-4.7-high",
    "--force", "--sandbox", "disabled",
  ]);
});

test("cursor 'ask' mode emits --mode ask --trust and no --force / --sandbox (read-only Q&A — cursor can't execute headlessly)", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", { ...cursorDefaults, mode: "ask" });
  expect(cmd).toEqual([
    "cursor-agent",
    "-p", "--output-format", "stream-json",
    "--model", "grok-4.7-high",
    "--mode", "ask",
    "--trust",
  ]);
  expect(cmd).not.toContain("--force");
  expect(cmd).not.toContain("--sandbox");
});

test("cursor 'plan' mode emits --mode plan --trust after --model, and no --force / --sandbox", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", { ...cursorDefaults, mode: "plan" });
  expect(cmd).toEqual([
    "cursor-agent",
    "-p", "--output-format", "stream-json",
    "--model", "grok-4.7-high",
    "--mode", "plan",
    "--trust",
  ]);
});

test("cursor 'auto' mode keeps --force --sandbox disabled and never adds --trust or --mode", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", { ...cursorDefaults, mode: "auto" });
  expect(cmd).not.toContain("--trust");
  expect(cmd).not.toContain("--mode");
});

test("cursor unknown mode id gets no mode flag, but --trust since nothing passes --force (house passthrough)", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", { ...cursorDefaults, mode: "mystery-mode" });
  expect(cmd).toEqual([
    "cursor-agent",
    "-p", "--output-format", "stream-json",
    "--model", "grok-4.7-high",
    "--trust",
  ]);
});

test("cursor --trust lands before AGETOR_CURSOR_ARGS extras and before --resume", () => {
  process.env.AGETOR_CURSOR_ARGS = "--verbose";
  const { cmd } = buildCommand(builtin("cursor"), "hi", { ...cursorDefaults, mode: "plan", resumeSessionId: "sess-2" });
  expect(cmd.slice(-6)).toEqual(["--mode", "plan", "--trust", "--verbose", "--resume", "sess-2"]);
});

test("cursor non-auto mode with an AGETOR_CURSOR_ARGS --force gets no --trust (the argv already contains --force)", () => {
  process.env.AGETOR_CURSOR_ARGS = "--force";
  const { cmd } = buildCommand(builtin("cursor"), "hi", { ...cursorDefaults, mode: "ask" });
  expect(cmd).not.toContain("--trust");
  expect(cmd.filter((a) => a === "--force")).toEqual(["--force"]);
});

test("cursor null mode defaults to auto (--force --sandbox disabled), house convention", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", { model: "auto", mode: null });
  expect(cmd).toContain("--force");
  expect(cmd).toContain("--sandbox");
  expect(cmd[cmd.indexOf("--sandbox") + 1]).toBe("disabled");
});

test("cursor composes a curated model plus effort into Cursor's concrete model id", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", {
    ...cursorDefaults,
    model: "claude-opus-4-8",
    effort: "max",
  });
  expect(cmd).toEqual([
    "cursor-agent",
    "-p", "--output-format", "stream-json",
    "--model", "claude-opus-4-8-max",
    "--force", "--sandbox", "disabled",
  ]);
});

test("cursor Gemini 3.8 Flash + medium effort composes gemini-3.8-flash-medium", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", {
    ...cursorDefaults,
    model: "gemini-3.8-flash",
    effort: "medium",
  });
  expect(cmd).toEqual([
    "cursor-agent",
    "-p", "--output-format", "stream-json",
    "--model", "gemini-3.8-flash-medium",
    "--force", "--sandbox", "disabled",
  ]);
});

test("cursor Gemini 3.8 Flash with null effort falls back to the high variant", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", {
    ...cursorDefaults,
    model: "gemini-3.8-flash",
    effort: null,
  });
  expect(cmd[cmd.indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");
});

test("cursor Gemini 3.7 Flash + low effort composes gemini-3.7-flash-low", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", {
    ...cursorDefaults,
    model: "gemini-3.7-flash",
    effort: "low",
  });
  expect(cmd[cmd.indexOf("--model") + 1]).toBe("gemini-3.7-flash-low");
});

test("cursor Gemini 4 Argon + medium effort composes gemini-4-argon-medium", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", {
    ...cursorDefaults,
    model: "gemini-4-argon",
    effort: "medium",
  });
  expect(cmd).toEqual([
    "cursor-agent",
    "-p", "--output-format", "stream-json",
    "--model", "gemini-4-argon-medium",
    "--force", "--sandbox", "disabled",
  ]);
});

test("cursor Gemini 4 Argon with null effort falls back to the high variant", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", {
    ...cursorDefaults,
    model: "gemini-4-argon",
    effort: null,
  });
  expect(cmd[cmd.indexOf("--model") + 1]).toBe("gemini-4-argon-high");
});

test("cursor Gemini 4 Argon ignores speed fast and maxMode (no fast variant, no Max Mode)", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", {
    ...cursorDefaults,
    model: "gemini-4-argon",
    effort: "high",
    speed: "fast",
    maxMode: true,
  });
  expect(cmd[cmd.indexOf("--model") + 1]).toBe("gemini-4-argon-high");
});

test("cursor Gemini 3.8 Flash ignores speed fast and maxMode (no fast variant, no Max Mode)", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", {
    ...cursorDefaults,
    model: "gemini-3.8-flash",
    effort: "high",
    speed: "fast",
    maxMode: true,
  });
  expect(cmd[cmd.indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");
});

// docs/plans/add-gpt-6-1-terra.md D1 (2026-10-26): the three new Cursor
// families, from the task row to the argv cursor-agent actually receives.
test("cursor DeepSeek V4.1 Flash 1017 + low effort launches the deepseek-v41-flash-1017-low variant", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", {
    ...cursorDefaults,
    model: "deepseek-v41-flash-1017",
    effort: "low",
    mode: "ask",
  });
  expect(cmd).toEqual([
    "cursor-agent",
    "-p", "--output-format", "stream-json",
    "--model", "deepseek-v41-flash-1017-low",
    "--mode", "ask", "--trust",
  ]);
});

test("cursor DeepSeek V4.1 Flash 1017 + none effort launches the -none variant (none exists only on this family)", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", {
    ...cursorDefaults,
    model: "deepseek-v41-flash-1017",
    effort: "none",
  });
  expect(cmd[cmd.indexOf("--model") + 1]).toBe("deepseek-v41-flash-1017-none");
});

test("cursor Muse Spark 1.3 + Max Mode launches the bracket form with its effort and no fast= (no Fast tier)", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", {
    ...cursorDefaults,
    model: "muse-spark-1.3",
    effort: "minimal",
    speed: "fast",
    maxMode: true,
  });
  expect(cmd[cmd.indexOf("--model") + 1]).toBe("muse-spark-1.3[context=1m,effort=minimal]");
});

test("cursor Muse Spark 1.3 without Max Mode launches the plain effort variant", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", {
    ...cursorDefaults,
    model: "muse-spark-1.3",
    effort: "xhigh",
  });
  expect(cmd[cmd.indexOf("--model") + 1]).toBe("muse-spark-1.3-xhigh");
});

test("cursor Muse Wonder 1.0 ignores speed fast and maxMode (no Fast variant, no Max Mode)", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", {
    ...cursorDefaults,
    model: "muse-wonder-1.0",
    effort: "minimal",
    speed: "fast",
    maxMode: true,
  });
  expect(cmd[cmd.indexOf("--model") + 1]).toBe("muse-wonder-1.0-minimal");
});

test("cursor Muse Wonder 1.0 with null effort falls back to the high variant", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", {
    ...cursorDefaults,
    model: "muse-wonder-1.0",
    effort: null,
  });
  expect(cmd[cmd.indexOf("--model") + 1]).toBe("muse-wonder-1.0-high");
});

test("cursor speed fast selects the Fast model variant when that effort supports it", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", {
    ...cursorDefaults,
    model: "gpt-5.6-sol",
    effort: "max",
    speed: "fast",
  });
  expect(cmd[cmd.indexOf("--model") + 1]).toBe("gpt-5.6-sol-max-fast");
});

test("cursor speed off and ultrafast both launch the standard model variant (cursor has no Ultrafast tier)", () => {
  for (const speed of ["off", "ultrafast", null, undefined] as const) {
    const { cmd } = buildCommand(builtin("cursor"), "hi", {
      ...cursorDefaults,
      model: "gpt-5.6-sol",
      effort: "max",
      speed,
    });
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("gpt-5.6-sol-max");
  }
});

test("cursor maxMode selects large context without changing reasoning effort", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", {
    ...cursorDefaults,
    model: "gpt-5.6-sol",
    effort: "high",
    speed: "fast",
    maxMode: true,
  });
  expect(cmd[cmd.indexOf("--model") + 1]).toBe("gpt-5.6-sol[context=1m,effort=high,fast=true]");
});

test("cursor maxMode is ignored for models without a large-context override", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", {
    ...cursorDefaults,
    model: "composer-2.5",
    speed: "fast",
    maxMode: true,
  });
  expect(cmd[cmd.indexOf("--model") + 1]).toBe("composer-2.5-fast");
});

test("cursor speed fast is ignored for model/effort pairs without a fast variant", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", {
    ...cursorDefaults,
    model: "claude-sonnet-5",
    effort: "max",
    speed: "fast",
  });
  expect(cmd[cmd.indexOf("--model") + 1]).toBe("claude-sonnet-5-max");
});

test("cursor model with no effort levels can still expose a fast variant", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", {
    ...cursorDefaults,
    model: "composer-2.5",
    speed: "fast",
  });
  expect(cmd[cmd.indexOf("--model") + 1]).toBe("composer-2.5-fast");
});

test("cursor unknown model id passes through verbatim (house convention: unknown ids just work)", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", {
    ...cursorDefaults,
    model: "cursor-mystery-9000",
    effort: "max",
    speed: "fast",
  });
  const i = cmd.indexOf("--model");
  expect(i).toBeGreaterThan(-1);
  expect(cmd[i + 1]).toBe("cursor-mystery-9000");
});

test("cursor resumeSessionId adds --resume <id> as the final argv elements (--resume is a flag, no subcommand ordering constraint)", () => {
  const { cmd } = buildCommand(builtin("cursor"), "hi", { ...cursorDefaults, resumeSessionId: "sess-99" });
  expect(cmd.slice(-2)).toEqual(["--resume", "sess-99"]);
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
    "--model", "grok-4.7-high",
    "--force", "--sandbox", "disabled",
    "--verbose", "--foo",
    "--resume", "sess-1",
  ]);
});

// ── fake cursor driver (plan §5 "Fake-driver seams") ──

async function runFakeCursor(taskId: string, prompt: string, opts: Record<string, unknown> = {}) {
  process.env.AGETOR_CURSOR_DRIVER = "fake";
  const chunks: { stream: RunEventStream; data: string; lineUuid?: string }[] = [];
  let sessionId: string | undefined;
  const handle = await spawnAgent({
    taskId,
    runId: `run-${taskId}`,
    harness: builtin("cursor"),
    prompt,
    cwd: "/tmp",
    onChunk: (stream, data, lineUuid) => { chunks.push({ stream, data, lineUuid }); },
    onSessionId: (id) => { sessionId = id; },
    opts: { ...cursorDefaults, ...opts },
  });
  const code = await handle.done;
  return { chunks, code, sessionId };
}

test("cursor stream marker: one thinking chunk per block (stable cursor:thinking:<line> keys), tool use/result named globToolCall, one assistant reply, one usage sentinel", async () => {
  const { chunks, code, sessionId } = await runFakeCursor("task-cursor-stream-1", `go ${FAKE_CURSOR_STREAM_PROMPT_MARKER}`);
  expect(code).toBe(0);
  expect(sessionId).toBe("fake-cursor-session-task-cursor-stream-1");

  expect(chunks.map((c) => [c.stream, c.lineUuid])).toEqual([
    ["thinking", "cursor:thinking:2"],
    ["tool_use", "tool_call:call-fake-stream-1\nfc_fake_stream_1:started"],
    ["tool_result", "tool_call:call-fake-stream-1\nfc_fake_stream_1:completed"],
    ["thinking", "cursor:thinking:8"],
    ["assistant", "cursor:11"],
    ["status", "cursor:usage:12"],
  ]);
  expect(chunks[0]!.data).toBe("Looking for the notes file first.");
  expect(chunks[3]!.data).toBe("Found it. Answering now.");
  expect(JSON.parse(chunks[1]!.data).name).toBe("globToolCall");
  expect(chunks[4]!.data).toBe("The notes file is ./notes.txt.");
  expect(chunks[5]!.data).toBe(
    `${FX_USAGE_STATUS_PREFIX}${JSON.stringify({ turn: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 3400, cacheWriteTokens: 0 } })}`,
  );
});

test("cursor stream env twin (AGETOR_FAKE_CURSOR_STREAM=1) drives the same turn without the marker", async () => {
  process.env.AGETOR_FAKE_CURSOR_STREAM = "1";
  const { chunks } = await runFakeCursor("task-cursor-stream-2", "go");
  expect(chunks.filter((c) => c.stream === "thinking")).toHaveLength(2);
  expect(chunks.filter((c) => c.lineUuid?.startsWith("cursor:usage:"))).toHaveLength(1);
});

test("cursor stream marker wins over AGETOR_FAKE_CURSOR_PLAN=1; the plan env still wins over the stream env twin", async () => {
  process.env.AGETOR_FAKE_CURSOR_PLAN = "1";
  const marked = await runFakeCursor("task-cursor-stream-3", `go ${FAKE_CURSOR_STREAM_PROMPT_MARKER}`);
  expect(marked.chunks.some((c) => c.stream === "thinking")).toBe(true);
  process.env.AGETOR_FAKE_CURSOR_STREAM = "1";
  const unmarked = await runFakeCursor("task-cursor-stream-4", "go");
  expect(unmarked.chunks.some((c) => c.stream === "thinking")).toBe(false);
  expect(JSON.parse(unmarked.chunks.find((c) => c.stream === "tool_use")!.data).name).toBe("createPlanToolCall");
});

test("fake cursor without the stream marker/env is unchanged: no thinking, no usage sentinel", async () => {
  const { chunks, code } = await runFakeCursor("task-cursor-plain-1", "go");
  expect(code).toBe(0);
  expect(chunks.map((c) => c.data)).toEqual(["fake response to: go", "turn complete"]);
});

test("fake cursor accepts plan mode (the run's opening mode= breadcrumb reads the task's own mode)", async () => {
  const { code } = await runFakeCursor("task-cursor-plan-mode-1", "go", { mode: "plan" });
  expect(code).toBe(0);
});

// Prompt rides in argv (`-p <prompt>`) — see GEMINI_PROMPT_ARGV_MAX_BYTES's
// doc comment for why this differs from codex's stdin delivery.
test("gemini with defaults emits -m + stream-json + --yolo + --skip-trust, prompt via -p", () => {
  const { cmd } = buildCommand(builtin("gemini"), "hi", { ...geminiDefaults });
  expect(cmd).toEqual([
    "gemini",
    "-m", "gemini-3.1-pro-preview",
    "--output-format", "stream-json",
    "--yolo",
    "--skip-trust",
    "-p", "hi",
  ]);
});

test("gemini-4-argon model id is emitted verbatim via -m", () => {
  const { cmd } = buildCommand(builtin("gemini"), "hi", { ...geminiDefaults, model: "gemini-4-argon" });
  expect(cmd).toEqual([
    "gemini",
    "-m", "gemini-4-argon",
    "--output-format", "stream-json",
    "--yolo",
    "--skip-trust",
    "-p", "hi",
  ]);
});

test("gemini-3.8-flash model id is emitted verbatim via -m", () => {
  const { cmd } = buildCommand(builtin("gemini"), "hi", { ...geminiDefaults, model: "gemini-3.8-flash" });
  expect(cmd).toEqual([
    "gemini",
    "-m", "gemini-3.8-flash",
    "--output-format", "stream-json",
    "--yolo",
    "--skip-trust",
    "-p", "hi",
  ]);
});

test("gemini-3.8-flash-cyber (Fairwind-gated) model id is emitted verbatim via -m", () => {
  const { cmd } = buildCommand(builtin("gemini"), "hi", { ...geminiDefaults, model: "gemini-3.8-flash-cyber" });
  expect(cmd).toEqual([
    "gemini",
    "-m", "gemini-3.8-flash-cyber",
    "--output-format", "stream-json",
    "--yolo",
    "--skip-trust",
    "-p", "hi",
  ]);
});

// Antigravity (`agy`): effort lives in the model id suffix, so the builder must
// never emit `--effort` whatever `opts.effort` carries (owner decision D6/D7,
// docs/plans/add-gemini-4-argon.md). The prompt rides as the shell wrapper's
// `$(cat <promptfile>)` after a trailing `-p`.
const antigravityDefaults = { mode: "auto", model: "gemini-4-argon-high", effort: "high" } as const;
const ANTIGRAVITY_AUTO_ARGV = [
  "agy",
  "--output-format", "stream-json",
  "--model", "gemini-4-argon-high",
  "--dangerously-skip-permissions",
  "-p",
];

test("antigravity auto mode emits exact argv and never --effort (effort high)", () => {
  const { cmd } = buildCommand(builtin("antigravity"), "hi", { ...antigravityDefaults });
  expect(cmd).toEqual(ANTIGRAVITY_AUTO_ARGV);
  expect(cmd).not.toContain("--effort");
});

test("antigravity ignores effort max: same argv, no --effort", () => {
  const { cmd } = buildCommand(builtin("antigravity"), "hi", { ...antigravityDefaults, effort: "max" });
  expect(cmd).toEqual(ANTIGRAVITY_AUTO_ARGV);
  expect(cmd).not.toContain("--effort");
});

test("antigravity ignores null effort: same argv, no --effort", () => {
  const { cmd } = buildCommand(builtin("antigravity"), "hi", { ...antigravityDefaults, effort: null });
  expect(cmd).toEqual(ANTIGRAVITY_AUTO_ARGV);
  expect(cmd).not.toContain("--effort");
});

test("antigravity plan mode uses --mode plan instead of the skip-permissions flag", () => {
  const { cmd } = buildCommand(builtin("antigravity"), "hi", { ...antigravityDefaults, mode: "plan" });
  expect(cmd).not.toContain("--dangerously-skip-permissions");
  expect(cmd).toEqual([
    "agy",
    "--output-format", "stream-json",
    "--model", "gemini-4-argon-high",
    "--mode", "plan",
    "-p",
  ]);
});

test("antigravity ask mode maps to --mode accept-edits", () => {
  const { cmd } = buildCommand(builtin("antigravity"), "hi", { ...antigravityDefaults, mode: "ask" });
  expect(cmd).not.toContain("--dangerously-skip-permissions");
  expect(cmd).toEqual([
    "agy",
    "--output-format", "stream-json",
    "--model", "gemini-4-argon-high",
    "--mode", "accept-edits",
    "-p",
  ]);
});

test("antigravity resumeSessionId adds --conversation before -p", () => {
  const { cmd } = buildCommand(builtin("antigravity"), "hi", {
    ...antigravityDefaults,
    resumeSessionId: "conv-1",
  });
  expect(cmd).toEqual([
    "agy",
    "--output-format", "stream-json",
    "--model", "gemini-4-argon-high",
    "--dangerously-skip-permissions",
    "--conversation", "conv-1",
    "-p",
  ]);
  expect(cmd.indexOf("--conversation")).toBeLessThan(cmd.indexOf("-p"));
});

test("AGETOR_ANTIGRAVITY_ARGS is spliced before the trailing -p", () => {
  process.env.AGETOR_ANTIGRAVITY_ARGS = "--foo bar";
  const { cmd } = buildCommand(builtin("antigravity"), "hi", { ...antigravityDefaults });
  expect(cmd).toEqual([
    "agy",
    "--output-format", "stream-json",
    "--model", "gemini-4-argon-high",
    "--dangerously-skip-permissions",
    "--foo", "bar",
    "-p",
  ]);
});

test("antigravity without a model throws", () => {
  expect(() =>
    buildCommand(builtin("antigravity"), "hi", { mode: "auto", model: null, effort: null }),
  ).toThrow("model is required for antigravity");
});

test("antigravity gemini-3.8-flash-high model id is emitted verbatim via --model (control)", () => {
  const { cmd } = buildCommand(builtin("antigravity"), "hi", {
    ...antigravityDefaults,
    model: "gemini-3.8-flash-high",
  });
  expect(cmd[cmd.indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");
  expect(cmd).not.toContain("--effort");
});

test("gemini 'ask' mode uses --approval-mode plan instead of --yolo", () => {
  const { cmd } = buildCommand(builtin("gemini"), "hi", { ...geminiDefaults, mode: "ask" });
  expect(cmd).not.toContain("--yolo");
  expect(cmd).toEqual([
    "gemini",
    "-m", "gemini-3.1-pro-preview",
    "--output-format", "stream-json",
    "--approval-mode", "plan",
    "--skip-trust",
    "-p", "hi",
  ]);
});

test("gemini resumeSessionId adds --resume <id> to the argv (no --session-id)", () => {
  const { cmd } = buildCommand(builtin("gemini"), "hi", {
    ...geminiDefaults,
    resumeSessionId: "b89c9f01-1938-474f-b8be-19be0dc071ad",
  });
  const i = cmd.indexOf("--resume");
  expect(i).toBeGreaterThan(-1);
  expect(cmd[i + 1]).toBe("b89c9f01-1938-474f-b8be-19be0dc071ad");
  expect(cmd).not.toContain("--session-id");
});

test("gemini sessionId adds --session-id <uuid> to the argv", () => {
  const { cmd } = buildCommand(builtin("gemini"), "hi", {
    ...geminiDefaults,
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
  });
  const i = cmd.indexOf("--session-id");
  expect(i).toBeGreaterThan(-1);
  expect(cmd[i + 1]).toBe("550e8400-e29b-41d4-a716-446655440000");
});

test("gemini resumeSessionId takes precedence over sessionId", () => {
  const { cmd } = buildCommand(builtin("gemini"), "hi", {
    ...geminiDefaults,
    resumeSessionId: "resumed-id",
    sessionId: "fresh-id",
  });
  expect(cmd).toContain("--resume");
  expect(cmd).not.toContain("--session-id");
});

test("gemini without resumeSessionId or sessionId omits both flags", () => {
  const { cmd } = buildCommand(builtin("gemini"), "hi", { ...geminiDefaults });
  expect(cmd).not.toContain("--resume");
  expect(cmd).not.toContain("--session-id");
});

test("gemini throws when model is missing", () => {
  expect(() =>
    buildCommand(builtin("gemini"), "hi", { mode: "auto" }),
  ).toThrow(/model is required/);
});

test("gemini never requires effort — no flag emitted, no throw, even when omitted", () => {
  const { cmd, env } = buildCommand(builtin("gemini"), "hi", { mode: "auto", model: "gemini-3.1-pro-preview" });
  expect(cmd).toContain("-p");
  // No effort-shaped flag anywhere in argv, and no env var either.
  expect(cmd.join(" ")).not.toMatch(/effort/i);
  expect(env?.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
});

test("gemini throws when the prompt is missing", () => {
  expect(() =>
    buildCommand(builtin("gemini"), "", { ...geminiDefaults }),
  ).toThrow(/prompt is required/);
});

test("gemini throws above GEMINI_PROMPT_ARGV_MAX_BYTES — no deferred-paste fallback exists", () => {
  const prompt = "a".repeat(GEMINI_PROMPT_ARGV_MAX_BYTES + 1);
  expect(() =>
    buildCommand(builtin("gemini"), prompt, { ...geminiDefaults }),
  ).toThrow(/exceeds .* bytes/);
});

test("gemini stays within GEMINI_PROMPT_ARGV_MAX_BYTES for an at-budget prompt", () => {
  const prompt = "a".repeat(GEMINI_PROMPT_ARGV_MAX_BYTES);
  const { cmd } = buildCommand(builtin("gemini"), prompt, { ...geminiDefaults });
  expect(cmd).toContain(prompt);
});

test("AGETOR_GEMINI_ARGS extra args land before -p", () => {
  process.env.AGETOR_GEMINI_ARGS = "--include-directories /tmp/extra";
  const { cmd } = buildCommand(builtin("gemini"), "hi", { ...geminiDefaults });
  expect(cmd.indexOf("--include-directories")).toBeLessThan(cmd.indexOf("-p"));
  expect(cmd.slice(-2)).toEqual(["-p", "hi"]);
});

test("aliased gemini with a home override emits GEMINI_CLI_HOME (not HOME)", () => {
  // GEMINI_CLI_HOME is gemini's own dedicated home-override env var — unlike
  // codex, there's no need to also touch the real HOME (verified in the
  // bundled CLI source; see harnessEnv's doc comment).
  const result = buildCommand(
    alias("gemini", { home: "/tmp/agetor-test/gemini-2" }),
    "hi",
    { ...geminiDefaults },
  );
  expect(result.env?.GEMINI_CLI_HOME).toBe("/tmp/agetor-test/gemini-2");
  expect(result.env?.HOME).toBeUndefined();
});

// --- fx -----------------------------------------------------------------
// fx — driven over ACP/stdio (fx-acp.ts), never tmux. The prompt rides over
// the ACP session/prompt call, not argv, so there's no argv-size budget to
// enforce here (unlike claude/gemini). Mode rides as an env var
// (FX_PERMISSION_MODE), not an argv flag; effort is silently ignored (no
// per-invocation effort knob, mirrors gemini's silent-ignore); model has no
// translation table (unlike claude) — every id, known or not, rides verbatim.

test("fx with defaults emits acp --model <id> --log-file <dataDir>/fx-logs/<runId>.log", () => {
  const { cmd } = buildCommand(builtin("fx"), "hi", { ...fxDefaults });
  expect(cmd).toEqual([
    "fx",
    "acp",
    "--model", "fx-default",
    "--log-file", path.join(dataDir, "fx-logs", "run-fx-1.log"),
  ]);
});

test("fx model id passes through verbatim — no translation table, unlike claude", () => {
  const { cmd } = buildCommand(builtin("fx"), "hi", { ...fxDefaults, model: "openai/gpt-5.2" });
  const i = cmd.indexOf("--model");
  expect(i).toBeGreaterThan(-1);
  expect(cmd[i + 1]).toBe("openai/gpt-5.2");
});

test.each([
  "openai/gpt-6.1-terra",
  "minimax/minimax-m3.1-flash",
  "meta/muse-spark-open",
  "inception/mercury-3",
  "moonshotai/kimi-k3.1-pro",
  "deepseek/deepseek-v4.1-flash-1017",
  "meta/muse-wonder-1.0",
  "mistral/mistral-large-4",
  "reflection/beam",
])("fx model '%s' (curated 2026-10-26) passes through verbatim as --model", (model) => {
  const { cmd } = buildCommand(builtin("fx"), "hi", { ...fxDefaults, model });
  expect(cmd[cmd.indexOf("--model") + 1]).toBe(model);
});

test("codex gpt-6.1-terra with effort ultra emits -c model_reasoning_effort=ultra", () => {
  const { cmd } = buildCommand(builtin("codex"), "hi", {
    ...codexDefaults,
    model: "gpt-6.1-terra",
    effort: "ultra",
    mode: "auto",
  });
  expect(cmd[cmd.indexOf("--model") + 1]).toBe("gpt-6.1-terra");
  expect(cmd[cmd.indexOf("-c") + 1]).toBe("model_reasoning_effort=ultra");
});

test.each(["auto", "ask", "yolo"])(
  "fx mode '%s' maps straight through to FX_PERMISSION_MODE env (no translation table)",
  (mode) => {
    const { env } = buildCommand(builtin("fx"), "hi", { ...fxDefaults, mode });
    expect(env?.FX_PERMISSION_MODE).toBe(mode);
  },
);

test("fx null mode defaults to FX_PERMISSION_MODE=yolo via defaultModeFor(\"fx\") (Full access is now the house default — docs/plans/fx-recovery-follow-ups.md §3.6)", () => {
  const { env } = buildCommand(builtin("fx"), "hi", { ...fxDefaults, mode: null });
  expect(defaultModeFor("fx")).toBe("yolo");
  expect(env?.FX_PERMISSION_MODE).toBe("yolo");
});

test("fx unknown mode id passes through verbatim to FX_PERMISSION_MODE", () => {
  const { env } = buildCommand(builtin("fx"), "hi", { ...fxDefaults, mode: "some-future-mode" });
  expect(env?.FX_PERMISSION_MODE).toBe("some-future-mode");
});

test("fx buildCommand still emits no argv/env for effort (fx ≥0.0.9: effort rides over ACP via fx-acp.ts's applyFxEffort/session-set_config_option, not argv/env — see agents.ts's buildCommand fx branch comment)", () => {
  const { cmd, env } = buildCommand(builtin("fx"), "hi", { ...fxDefaults, effort: "max" });
  // The --log-file value is a path under the process-wide data dir, whose
  // mkdtemp name may itself contain "effort" (orchestrator-discovered-efforts
  // .test.ts), so it is left out of the match.
  const argv = cmd.filter((_, i) => cmd[i - 1] !== "--log-file");
  expect(argv).toContain("--log-file");
  expect(argv.join(" ")).not.toMatch(/effort/i);
  expect(env?.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  expect(Object.keys(env ?? {})).not.toContain("FX_EFFORT");
});

test("fx throws when model is missing", () => {
  expect(() =>
    buildCommand(builtin("fx"), "hi", { mode: "auto", runId: "run-fx-1" }),
  ).toThrow(/model is required for fx/);
});

test("fx throws when runId is missing", () => {
  expect(() =>
    buildCommand(builtin("fx"), "hi", { mode: "auto", model: "fx-default" }),
  ).toThrow(/runId is required for fx/);
});

test("AGETOR_FX_BIN override is respected for the built-in fx harness", () => {
  process.env.AGETOR_FX_BIN = "/env-fallback/fx";
  expect(buildCommand(builtin("fx"), "hi", { ...fxDefaults }).cmd[0]).toBe("/env-fallback/fx");
});

test("AGETOR_FX_ARGS extra args land at the end of argv, after --log-file", () => {
  process.env.AGETOR_FX_ARGS = "--verbose --foo";
  const { cmd } = buildCommand(builtin("fx"), "hi", { ...fxDefaults });
  expect(cmd.slice(-2)).toEqual(["--verbose", "--foo"]);
});

test("aliased fx with a home override emits HOME (no dedicated fx config-dir env var, mirrors cursor)", () => {
  const result = buildCommand(
    alias("fx", { home: "/tmp/agetor-test/fx-2" }),
    "hi",
    { ...fxDefaults },
  );
  expect(result.env?.HOME).toBe("/tmp/agetor-test/fx-2");
});

test("fx harness without a home override sets no HOME (env carries only FX_PERMISSION_MODE)", () => {
  const result = buildCommand(builtin("fx"), "hi", { ...fxDefaults });
  expect(result.env?.HOME).toBeUndefined();
  expect(result.env?.FX_PERMISSION_MODE).toBe("auto");
});

test("fx AGETOR_FX_DRIVER=fake yields a fake handle and fires onSessionId with fake-fx-session-<taskId>", async () => {
  process.env.AGETOR_FX_DRIVER = "fake";
  let sessionId: string | undefined;
  const handle = await spawnAgent({
    taskId: "task-fx-1",
    runId: "run-fx-1",
    harness: builtin("fx"),
    prompt: "hi",
    cwd: "/tmp",
    onChunk: () => {},
    onSessionId: (id) => { sessionId = id; },
    opts: { ...fxDefaults },
  });
  expect(sessionId).toBe("fake-fx-session-task-fx-1");
  expect(handle).toBeDefined();
  expect(typeof handle.kill).toBe("function");
  expect(typeof handle.writeInput).toBe("function");
  handle.kill();
});

test("fx AGETOR_FX_DRIVER=fake still exercises buildCommand's validation (throws on missing model)", async () => {
  process.env.AGETOR_FX_DRIVER = "fake";
  await expect(
    spawnAgent({
      taskId: "task-fx-2",
      runId: "run-fx-2",
      harness: builtin("fx"),
      prompt: "hi",
      cwd: "/tmp",
      onChunk: () => {},
      opts: { mode: "auto" },
    }),
  ).rejects.toThrow(/model is required for fx/);
});

test("fx buildCommand for mode 'yolo' sets FX_PERMISSION_MODE=yolo verbatim (never rewritten to 'full-access')", () => {
  const { env } = buildCommand(builtin("fx"), "hi", { ...fxDefaults, mode: "yolo" });
  expect(env?.FX_PERMISSION_MODE).toBe("yolo");
});

/**
 * docs/plans/fx-0.0.8-compat.md §3 "Fake fx driver per turn" — the fake fx
 * driver (AGETOR_FX_DRIVER=fake) must emit, per completed turn: a `thinking`
 * chunk ("fake fx reasoning"), then the turn's assistant/stdout text, then
 * the two `fx-usage: ` sentinels (context used/size, then per-turn
 * input/output tokens), then the `fx-title: ` session-title sentinel, then
 * the existing "turn complete" status — with the `fx-provider: ` sentinel
 * emitted somewhere in the stream (order-independent, per the shared spec).
 * These tests assert relative order via indices into the collected chunk
 * list rather than an exact total count, so they don't need updating if an
 * unrelated status chunk is added to a scenario later.
 */
test("fx AGETOR_FX_DRIVER=fake plain-prompt turn: thinking -> text -> usage(used/size) -> usage(turn) -> title -> turn complete, provider sentinel present", async () => {
  process.env.AGETOR_FX_DRIVER = "fake";
  const chunks: { stream: RunEventStream; data: string }[] = [];
  const handle = await spawnAgent({
    taskId: "task-fx-order-1",
    runId: "run-fx-order-1",
    harness: builtin("fx"),
    prompt: "hi",
    cwd: "/tmp",
    onChunk: (stream, data) => { chunks.push({ stream, data }); },
    opts: { ...fxDefaults, runId: "run-fx-order-1" },
  });
  await handle.done;

  const usage1 = `${FX_USAGE_STATUS_PREFIX}${JSON.stringify({ used: 1234, size: 128000 })}`;
  const usage2 = `${FX_USAGE_STATUS_PREFIX}${JSON.stringify({ turn: { inputTokens: 42, outputTokens: 7 } })}`;
  const title = `${FX_SESSION_TITLE_STATUS_PREFIX}Fake fx session`;

  const thinkingIdx = chunks.findIndex((c) => c.stream === "thinking" && c.data === "fake fx reasoning");
  const textIdx = chunks.findIndex((c, i) => i > thinkingIdx && (c.stream === "assistant" || c.stream === "stdout"));
  const usage1Idx = chunks.findIndex((c, i) => i > textIdx && c.stream === "status" && c.data === usage1);
  const usage2Idx = chunks.findIndex((c, i) => i > usage1Idx && c.stream === "status" && c.data === usage2);
  const titleIdx = chunks.findIndex((c, i) => i > usage2Idx && c.stream === "status" && c.data === title);
  const completeIdx = chunks.findIndex((c, i) => i > titleIdx && c.stream === "status" && c.data === "turn complete");

  expect(thinkingIdx).toBeGreaterThanOrEqual(0);
  expect(textIdx).toBeGreaterThan(thinkingIdx);
  expect(usage1Idx).toBeGreaterThan(textIdx);
  expect(usage2Idx).toBeGreaterThan(usage1Idx);
  expect(titleIdx).toBeGreaterThan(usage2Idx);
  expect(completeIdx).toBeGreaterThan(titleIdx);

  const providerIdx = chunks.findIndex((c) => c.stream === "status" && c.data === `${FX_PROVIDER_STATUS_PREFIX}gateway`);
  expect(providerIdx).toBeGreaterThanOrEqual(0);
});

/**
 * docs/plans/fx-0.0.10-compat.md §3.7 / shared spec — the fake fx driver
 * mirrors `applyFxEffort`'s (fx-acp.ts) "isn't offered" breadcrumb: when the
 * prompt carries FAKE_FX_EFFORT_UNOFFERED_PROMPT_MARKER (or the env twin),
 * it emits exactly one status chunk naming the task's effort/model, right
 * after the provider sentinel and before the thinking chunk — otherwise the
 * fake stays silent about effort, mirroring the real driver's success path.
 */
test("fx AGETOR_FX_DRIVER=fake with the effort-unoffered marker in the prompt: one breadcrumb naming the requested effort, after the provider sentinel and before the thinking chunk", async () => {
  process.env.AGETOR_FX_DRIVER = "fake";
  const chunks: { stream: RunEventStream; data: string }[] = [];
  const handle = await spawnAgent({
    taskId: "task-fx-effort-1",
    runId: "run-fx-effort-1",
    harness: builtin("fx"),
    prompt: `do the thing ${FAKE_FX_EFFORT_UNOFFERED_PROMPT_MARKER}`,
    cwd: "/tmp",
    onChunk: (stream, data) => { chunks.push({ stream, data }); },
    opts: { ...fxDefaults, runId: "run-fx-effort-1", effort: "high", model: "zai/glm-5.3-flash" },
  });
  await handle.done;

  const expected = "fx: effort high isn't offered for zai/glm-5.3-flash (offers: auto, low, high, max) — running at fx's default";
  const breadcrumbs = chunks.filter((c) => c.stream === "status" && c.data === expected);
  expect(breadcrumbs.length).toBe(1);

  const providerIdx = chunks.findIndex((c) => c.stream === "status" && c.data === `${FX_PROVIDER_STATUS_PREFIX}gateway`);
  const breadcrumbIdx = chunks.findIndex((c) => c.stream === "status" && c.data === expected);
  const thinkingIdx = chunks.findIndex((c) => c.stream === "thinking" && c.data === "fake fx reasoning");
  expect(providerIdx).toBeGreaterThanOrEqual(0);
  expect(breadcrumbIdx).toBeGreaterThan(providerIdx);
  expect(thinkingIdx).toBeGreaterThan(breadcrumbIdx);
});

test("fx AGETOR_FX_DRIVER=fake with the effort-unoffered ENV twin (AGETOR_FAKE_FX_EFFORT_UNOFFERED=1) and no explicit opts.effort: the breadcrumb says 'effort auto'", async () => {
  process.env.AGETOR_FX_DRIVER = "fake";
  process.env.AGETOR_FAKE_FX_EFFORT_UNOFFERED = "1";
  const chunks: { stream: RunEventStream; data: string }[] = [];
  const handle = await spawnAgent({
    taskId: "task-fx-effort-2",
    runId: "run-fx-effort-2",
    harness: builtin("fx"),
    prompt: "do the thing",
    cwd: "/tmp",
    onChunk: (stream, data) => { chunks.push({ stream, data }); },
    opts: { ...fxDefaults, runId: "run-fx-effort-2", model: "zai/glm-5.3-flash" },
  });
  await handle.done;

  const expected = "fx: effort auto isn't offered for zai/glm-5.3-flash (offers: auto, low, high, max) — running at fx's default";
  expect(chunks.some((c) => c.stream === "status" && c.data === expected)).toBe(true);
});

test("fx AGETOR_FX_DRIVER=fake plain turn with no marker and no env twin: no 'running at fx's default' breadcrumb at all", async () => {
  process.env.AGETOR_FX_DRIVER = "fake";
  const chunks: { stream: RunEventStream; data: string }[] = [];
  const handle = await spawnAgent({
    taskId: "task-fx-effort-3",
    runId: "run-fx-effort-3",
    harness: builtin("fx"),
    prompt: "do the thing, no marker here",
    cwd: "/tmp",
    onChunk: (stream, data) => { chunks.push({ stream, data }); },
    opts: { ...fxDefaults, runId: "run-fx-effort-3", effort: "high" },
  });
  await handle.done;

  expect(chunks.some((c) => c.stream === "status" && c.data.includes("running at fx's default"))).toBe(false);
});

// ── fx launch options (docs/plans/fx-0.0.14-and-cursor-updates.md §3.2) ──
// `spawnAgent` builds the real fx spawn's FxLaunchOptions through
// `buildFxLaunchOptions`, so these pin what reaches `spawnFxViaAcp` without
// spawning an fx child.
function fxLaunch(harness: Harness, opts: Record<string, unknown>) {
  return buildFxLaunchOptions(
    { taskId: "task-fx-launch", runId: "run-fx-launch", harness, prompt: "hi", cwd: "/tmp", onChunk: () => {}, opts },
    { cmd: ["fx", "acp"], env: { FX_PERMISSION_MODE: "yolo" } },
  );
}

test("fx launch options carry the task's speed tier verbatim (fast / ultrafast / off)", () => {
  for (const speed of ["fast", "ultrafast", "off"] as const) {
    expect(fxLaunch(builtin("fx"), { ...fxDefaults, speed }).speed).toBe(speed);
  }
});

test("fx launch options pass speed null when the run carries none (the driver then skips speed reconciliation)", () => {
  expect(fxLaunch(builtin("fx"), { ...fxDefaults }).speed).toBeNull();
  expect(fxLaunch(builtin("fx"), { ...fxDefaults, speed: null }).speed).toBeNull();
});

test("fx launch options: profileMcpServers is on unless the harness explicitly turns it off", () => {
  expect(fxLaunch(builtin("fx"), { ...fxDefaults }).profileMcpServers).toBe(true);
  expect(fxLaunch({ ...builtin("fx"), profileMcpServers: true }, { ...fxDefaults }).profileMcpServers).toBe(true);
  expect(fxLaunch({ ...builtin("fx"), profileMcpServers: false }, { ...fxDefaults }).profileMcpServers).toBe(false);
});

test("fx launch options forward onSteerDropped from the spawn args (absent when the caller passed none)", () => {
  const dropped: string[] = [];
  const onSteerDropped = (text: string) => { dropped.push(text); return true; };
  const launch = buildFxLaunchOptions(
    { taskId: "task-fx-launch", runId: "run-fx-launch", harness: builtin("fx"), prompt: "hi", cwd: "/tmp", onChunk: () => {}, onSteerDropped, opts: { ...fxDefaults } },
    { cmd: ["fx", "acp"], env: {} },
  );
  expect(launch.onSteerDropped).toBe(onSteerDropped);
  expect(fxLaunch(builtin("fx"), { ...fxDefaults }).onSteerDropped).toBeUndefined();
});

test("fx launch options keep the rest of the spawn shape (argv/env/mode/effort/model/resume)", () => {
  const launch = fxLaunch(builtin("fx"), { ...fxDefaults, mode: "ask", effort: "high", resumeSessionId: "sess-fx-1", continueRecovery: true });
  expect(launch).toMatchObject({
    taskId: "task-fx-launch",
    runId: "run-fx-launch",
    argv: ["fx", "acp"],
    env: { FX_PERMISSION_MODE: "yolo" },
    cwd: "/tmp",
    promptText: "hi",
    mode: "ask",
    effort: "high",
    model: "fx-default",
    resumeSessionId: "sess-fx-1",
    continueRecovery: true,
  });
});

// ── fx fake-driver seams (plan §5 "Fake-driver seams") ──

async function runFakeFx(taskId: string, prompt: string, opts: Record<string, unknown> = {}) {
  process.env.AGETOR_FX_DRIVER = "fake";
  const chunks: { stream: RunEventStream; data: string; lineUuid?: string }[] = [];
  const handle = await spawnAgent({
    taskId,
    runId: `run-${taskId}`,
    harness: builtin("fx"),
    prompt,
    cwd: "/tmp",
    onChunk: (stream, data, lineUuid) => { chunks.push({ stream, data, lineUuid }); },
    opts: { ...fxDefaults, runId: `run-${taskId}`, ...opts },
  });
  const code = await handle.done;
  return { chunks, code };
}

function recoveryStates(chunks: { stream: RunEventStream; data: string }[]): string[] {
  return chunks
    .filter((c) => c.stream === "status" && c.data.startsWith(FX_RECOVERY_STATUS_PREFIX))
    .map((c) => (JSON.parse(c.data.slice(FX_RECOVERY_STATUS_PREFIX.length)) as { state: string }).state);
}

test("fx failed-recovery marker: two active sentinels, then failed + its summary line, then 'fx turn ended: refused' and exit 1", async () => {
  const { chunks, code } = await runFakeFx("task-fx-failed-1", `go ${FAKE_FX_RECOVERY_FAILED_PROMPT_MARKER}`);
  expect(code).toBe(1);
  expect(recoveryStates(chunks)).toEqual(["active", "active", "failed"]);
  const status = chunks.filter((c) => c.stream === "status").map((c) => c.data);
  const summary = status.filter((d) => d.endsWith(FX_FAILED_SUMMARY_SUFFIX));
  expect(summary).toEqual(["⚠ Provider unavailable · HTTP 503 · fake gateway outage · request failed after 3/3 attempts" + FX_FAILED_SUMMARY_SUFFIX]);
  // Not resumable: the refused line carries no "(… — resumable)" tail.
  expect(status[status.length - 1]).toBe("fx turn ended: refused");
  expect(status.some((d) => d.endsWith(FX_PAUSED_SUMMARY_SUFFIX))).toBe(false);
  // Mapped through the real mapFxUpdate: every sentinel carries its fx:<runId>:<seq> line uuid.
  const sentinelUuids = chunks.filter((c) => c.data.startsWith(FX_RECOVERY_STATUS_PREFIX)).map((c) => c.lineUuid);
  expect(sentinelUuids.every((u) => typeof u === "string" && u.startsWith("fx:run-task-fx-failed-1:"))).toBe(true);
  expect(new Set(sentinelUuids).size).toBe(3);
}, 5_000);

test("fx failed-recovery env twin (AGETOR_FAKE_FX_RECOVERY_FAILED=1) drives the same failed turn", async () => {
  process.env.AGETOR_FAKE_FX_RECOVERY_FAILED = "1";
  const { chunks, code } = await runFakeFx("task-fx-failed-2", "go");
  expect(code).toBe(1);
  expect(recoveryStates(chunks)).toEqual(["active", "active", "failed"]);
}, 5_000);

test("fx failed-recovery env twin does not apply to a continueRecovery launch (that still recovers)", async () => {
  process.env.AGETOR_FAKE_FX_RECOVERY_FAILED = "1";
  const { chunks, code } = await runFakeFx("task-fx-failed-3", "", { continueRecovery: true });
  expect(code).toBe(0);
  expect(recoveryStates(chunks)).toEqual(["recovered"]);
}, 5_000);

test("fx speed-unoffered marker: one breadcrumb for fast and for ultrafast, naming the task's model, before the thinking chunk", async () => {
  for (const speed of ["fast", "ultrafast"] as const) {
    const { chunks } = await runFakeFx(`task-fx-speed-${speed}`, `go ${FAKE_FX_SPEED_UNOFFERED_PROMPT_MARKER}`, {
      speed,
      model: "vendor/model-x",
    });
    const expected = fxSpeedNotOfferedLine(speed, "vendor/model-x");
    expect(chunks.filter((c) => c.stream === "status" && c.data === expected)).toHaveLength(1);
    const crumbIdx = chunks.findIndex((c) => c.data === expected);
    const thinkingIdx = chunks.findIndex((c) => c.stream === "thinking");
    expect(thinkingIdx).toBeGreaterThan(crumbIdx);
  }
});

test("fx speed-unoffered marker is silent for speed off (and for no speed at all)", async () => {
  for (const speed of ["off", null] as const) {
    const { chunks } = await runFakeFx(`task-fx-speed-silent-${speed}`, `go ${FAKE_FX_SPEED_UNOFFERED_PROMPT_MARKER}`, { speed });
    expect(chunks.some((c) => c.data.includes("isn't offered for"))).toBe(false);
  }
});

test("fx without the speed marker: no speed breadcrumb even on a fast task", async () => {
  const { chunks } = await runFakeFx("task-fx-speed-none", "go", { speed: "fast" });
  expect(chunks.some((c) => c.data.includes("Fast isn't offered"))).toBe(false);
});

test("fx tool-meta marker: internal call stamped on use + result, MCP call labelled 'server · tool', notice status line, then a reply and success", async () => {
  const { chunks, code } = await runFakeFx("task-fx-toolmeta-1", `go ${FAKE_FX_TOOL_META_PROMPT_MARKER}`);
  expect(code).toBe(0);

  const uses = chunks.filter((c) => c.stream === "tool_use").map((c) => ({ ...JSON.parse(c.data), lineUuid: c.lineUuid }));
  const results = chunks.filter((c) => c.stream === "tool_result").map((c) => JSON.parse(c.data));
  expect(uses).toHaveLength(2);
  expect(results).toHaveLength(2);

  const internalUse = uses.find((u) => u.id === "fake-fx-internal-1");
  expect(internalUse).toMatchObject({ name: "capability_search", internal: true, lineUuid: "fx:tool:fake-fx-internal-1:use" });
  expect(results.find((r) => r.toolUseId === "fake-fx-internal-1")).toMatchObject({ internal: true, isError: false });

  const mcpUse = uses.find((u) => u.id === "fake-fx-mcp-1");
  expect(mcpUse).toMatchObject({ name: "e2e-mcp · lookup", mcp: { server: "e2e-mcp", tool: "lookup" } });
  expect(mcpUse.internal).toBeUndefined();
  expect(results.find((r) => r.toolUseId === "fake-fx-mcp-1")?.internal).toBeUndefined();

  expect(chunks.some((c) => c.stream === "status" && c.data === "⚠ fx: e2e notice")).toBe(true);
  const replyIdx = chunks.findIndex((c) => c.stream === "assistant" && c.data === "Looked it up: alpha is 42.");
  const noticeIdx = chunks.findIndex((c) => c.data === "⚠ fx: e2e notice");
  expect(replyIdx).toBeGreaterThan(noticeIdx);
  expect(chunks[chunks.length - 1]).toMatchObject({ stream: "status", data: "turn complete" });
});

test("fx plain turn without any new marker is byte-identical to before: no tool, notice, recovery or speed chunks", async () => {
  const { chunks, code } = await runFakeFx("task-fx-plain-seams", "go", { speed: "ultrafast" });
  expect(code).toBe(0);
  expect(chunks.map((c) => c.stream)).not.toContain("tool_use");
  expect(recoveryStates(chunks)).toEqual([]);
  expect(chunks.some((c) => c.data.includes("e2e notice") || c.data.includes("isn't offered"))).toBe(false);
  expect(chunks.map((c) => c.data)).toEqual([
    `${FX_PROVIDER_STATUS_PREFIX}gateway`,
    "fake fx reasoning",
    "fake response to: go",
    `${FX_USAGE_STATUS_PREFIX}${JSON.stringify({ used: 1234, size: 128000 })}`,
    `${FX_USAGE_STATUS_PREFIX}${JSON.stringify({ turn: { inputTokens: 42, outputTokens: 7 } })}`,
    `${FX_SESSION_TITLE_STATUS_PREFIX}Fake fx session`,
    "turn complete",
  ]);
});

// ── fx steer seam (plan §5: `__agetor_fake_fx_steer__:<absorbed|dropped>`) ──

/** Spawn a fake fx steer turn, steer `steers` into it while it holds, and
 *  collect its chunks plus every `onSteerDropped` call — each tagged with
 *  whether `done` had already resolved when it fired. */
async function runFakeFxSteer(taskId: string, prompt: string, steers: string[], queued = true) {
  process.env.AGETOR_FX_DRIVER = "fake";
  process.env.AGETOR_FAKE_FX_STEER_HOLD_MS = "80";
  const chunks: { stream: RunEventStream; data: string }[] = [];
  const dropped: { text: string; afterDone: boolean }[] = [];
  let doneResolved = false;
  const handle = await spawnAgent({
    taskId,
    runId: `run-${taskId}`,
    harness: builtin("fx"),
    prompt,
    cwd: "/tmp",
    onChunk: (stream, data) => { chunks.push({ stream, data }); },
    onSteerDropped: (text) => { dropped.push({ text, afterDone: doneResolved }); return queued; },
    opts: { ...fxDefaults, runId: `run-${taskId}` },
  });
  const accepted = steers.map((line) => handle.steer?.(line));
  const code = await handle.done.then((c) => { doneResolved = true; return c; });
  return { handle, chunks, dropped, accepted, code };
}

test("fx fake agent without the steer marker carries no steer at all", async () => {
  process.env.AGETOR_FX_DRIVER = "fake";
  const handle = await spawnAgent({
    taskId: "task-fx-steer-none",
    runId: "run-fx-steer-none",
    harness: builtin("fx"),
    prompt: "go",
    cwd: "/tmp",
    onChunk: () => {},
    opts: { ...fxDefaults, runId: "run-fx-steer-none" },
  });
  expect("steer" in handle).toBe(false);
  await handle.done;
});

test("fx steer marker :absorbed — steer() takes the line mid-turn, the turn acknowledges it before finishing, nothing is dropped", async () => {
  const { handle, chunks, dropped, accepted, code } = await runFakeFxSteer(
    "task-fx-steer-abs",
    `go ${FAKE_FX_STEER_PROMPT_MARKER}:absorbed`,
    ["also check the tests"],
  );
  expect(code).toBe(0);
  expect(accepted).toEqual([true]);
  expect(dropped).toEqual([]);
  const ackIdx = chunks.findIndex((c) => c.stream === "assistant" && c.data.includes("also check the tests"));
  const doneIdx = chunks.findIndex((c) => c.stream === "status" && c.data === "turn complete");
  expect(ackIdx).toBeGreaterThan(-1);
  expect(doneIdx).toBeGreaterThan(ackIdx);
  expect(chunks.some((c) => c.data === FX_STEER_DROPPED_STATUS)).toBe(false);
  // Once the turn settled, steering is over.
  expect(handle.steer?.("too late")).toBe(false);
});

test("fx steer marker :dropped — onSteerDropped(text) fires before done resolves, with the dropped status line", async () => {
  const { chunks, dropped, accepted, code } = await runFakeFxSteer(
    "task-fx-steer-drop",
    `go ${FAKE_FX_STEER_PROMPT_MARKER}:dropped`,
    ["first", "second"],
  );
  expect(code).toBe(0);
  expect(accepted).toEqual([true, true]);
  expect(dropped).toEqual([{ text: "first", afterDone: false }, { text: "second", afterDone: false }]);
  expect(chunks.filter((c) => c.stream === "status" && c.data === FX_STEER_DROPPED_STATUS)).toHaveLength(2);
  expect(chunks.some((c) => c.stream === "assistant" && c.data.includes("first"))).toBe(false);
});

test("fx steer marker :dropped — a steer the caller didn't queue is still handed back, but gets no 'sending it as the next turn' line", async () => {
  const { chunks, dropped, accepted, code } = await runFakeFxSteer(
    "task-fx-steer-drop-unqueued",
    `go ${FAKE_FX_STEER_PROMPT_MARKER}:dropped`,
    ["discarded"],
    false,
  );
  expect(code).toBe(0);
  expect(accepted).toEqual([true]);
  expect(dropped).toEqual([{ text: "discarded", afterDone: false }]);
  expect(chunks.some((c) => c.data === FX_STEER_DROPPED_STATUS)).toBe(false);
});

test("fx steer marker is read from the task's stored prompt when the turn's own prompt lacks it (a steered/re-queued follow-up)", async () => {
  const taskId = "task-fx-steer-stored";
  tasks.insert({ ...makeHandoffTaskRow(taskId, `go ${FAKE_FX_STEER_PROMPT_MARKER}:dropped`), agent: "fx" });
  const { dropped, accepted } = await runFakeFxSteer(taskId, "a follow-up", ["late thought"]);
  expect(accepted).toEqual([true]);
  expect(dropped.map((d) => d.text)).toEqual(["late thought"]);
});

test("fx steer marker: a killed :dropped turn reports its pending steers dropped before done resolves, then refuses steers", async () => {
  process.env.AGETOR_FX_DRIVER = "fake";
  process.env.AGETOR_FAKE_FX_STEER_HOLD_MS = "5000";
  for (const mode of ["dropped", "absorbed"] as const) {
    const dropped: string[] = [];
    let doneResolved = false;
    const handle = await spawnAgent({
      taskId: `task-fx-steer-kill-${mode}`,
      runId: `run-fx-steer-kill-${mode}`,
      harness: builtin("fx"),
      prompt: `go ${FAKE_FX_STEER_PROMPT_MARKER}:${mode}`,
      cwd: "/tmp",
      onChunk: () => {},
      onSteerDropped: (text) => { dropped.push(`${text}:${doneResolved}`); return true; },
      opts: { ...fxDefaults, runId: `run-fx-steer-kill-${mode}` },
    });
    void handle.done.then(() => { doneResolved = true; });
    expect(handle.steer?.("one")).toBe(true);
    handle.kill();
    await handle.done;
    expect(handle.steer?.("two")).toBe(false);
    expect(dropped).toEqual(mode === "dropped" ? ["one:false"] : []);
  }
});

test("fx AGETOR_FAKE_FX_PERMISSION=1 with mode 'yolo' auto-allows and still emits the same relative sentinel order, plus the provider sentinel", async () => {
  process.env.AGETOR_FX_DRIVER = "fake";
  process.env.AGETOR_FAKE_FX_PERMISSION = "1";
  const chunks: { stream: RunEventStream; data: string }[] = [];
  try {
    const handle = await spawnAgent({
      taskId: "task-fx-yolo-perm-1",
      runId: "run-fx-yolo-perm-1",
      harness: builtin("fx"),
      prompt: "hi",
      cwd: "/tmp",
      onChunk: (stream, data) => { chunks.push({ stream, data }); },
      opts: { ...fxDefaults, mode: "yolo", runId: "run-fx-yolo-perm-1" },
    });
    await handle.done;
  } finally {
    delete process.env.AGETOR_FAKE_FX_PERMISSION;
  }

  const usage1 = `${FX_USAGE_STATUS_PREFIX}${JSON.stringify({ used: 1234, size: 128000 })}`;
  const usage2 = `${FX_USAGE_STATUS_PREFIX}${JSON.stringify({ turn: { inputTokens: 42, outputTokens: 7 } })}`;
  const title = `${FX_SESSION_TITLE_STATUS_PREFIX}Fake fx session`;

  const thinkingIdx = chunks.findIndex((c) => c.stream === "thinking" && c.data === "fake fx reasoning");
  const textIdx = chunks.findIndex((c, i) => i > thinkingIdx && c.stream === "assistant");
  const usage1Idx = chunks.findIndex((c, i) => i > textIdx && c.stream === "status" && c.data === usage1);
  const usage2Idx = chunks.findIndex((c, i) => i > usage1Idx && c.stream === "status" && c.data === usage2);
  const titleIdx = chunks.findIndex((c, i) => i > usage2Idx && c.stream === "status" && c.data === title);
  const completeIdx = chunks.findIndex((c, i) => i > titleIdx && c.stream === "status" && c.data === "turn complete");

  expect(thinkingIdx).toBeGreaterThanOrEqual(0);
  expect(textIdx).toBeGreaterThan(thinkingIdx);
  expect(usage1Idx).toBeGreaterThan(textIdx);
  expect(usage2Idx).toBeGreaterThan(usage1Idx);
  expect(titleIdx).toBeGreaterThan(usage2Idx);
  expect(completeIdx).toBeGreaterThan(titleIdx);

  // Yolo never reaches the session/request_permission registry round-trip —
  // no fx_permission card, so no "fake fx permission resolved: …" status.
  expect(chunks.some((c) => c.data.startsWith("fake fx permission resolved:"))).toBe(false);
  expect(chunks.some((c) => c.data === "fake fx permission auto-allowed (yolo)")).toBe(true);

  const providerIdx = chunks.findIndex((c) => c.stream === "status" && c.data === `${FX_PROVIDER_STATUS_PREFIX}gateway`);
  expect(providerIdx).toBeGreaterThanOrEqual(0);
});

// --- fx model-response-recovery (docs/plans/fix-fx-harness-rate-limit.md TT3) ---
// The fake driver's two recovery scenarios (see makeFakeAgent in agents.ts):
// the "storm" variant (three retry attempts then a terminal paused update,
// selected by AGETOR_FAKE_FX_RECOVERY=1 or the FAKE_FX_RECOVERY_PROMPT_MARKER
// prompt substring) and the "continue" variant (opts.continueRecovery: true,
// which always wins regardless of prompt content — checked first in the
// scenario's own `||` condition).

test(
  "fx AGETOR_FX_DRIVER=fake recovery storm (prompt marker): provider sentinel, 3 active recovery sentinels (attempt 1/2/3, delaySeconds only on attempt 2), the paused sentinel, its plain summary line, the enriched refused status, exit code 1",
  async () => {
    process.env.AGETOR_FX_DRIVER = "fake";
    const chunks: { stream: RunEventStream; data: string }[] = [];
    const handle = await spawnAgent({
      taskId: "task-fx-recovery-storm-1",
      runId: "run-fx-recovery-storm-1",
      harness: builtin("fx"),
      prompt: `hi ${FAKE_FX_RECOVERY_PROMPT_MARKER}`,
      cwd: "/tmp",
      onChunk: (stream, data) => { chunks.push({ stream, data }); },
      opts: { ...fxDefaults, runId: "run-fx-recovery-storm-1" },
    });
    const code = await handle.done;
    expect(code).toBe(1);

    const providerIdx = chunks.findIndex((c) => c.stream === "status" && c.data === `${FX_PROVIDER_STATUS_PREFIX}gateway`);
    expect(providerIdx).toBeGreaterThanOrEqual(0);

    const recoveryChunks = chunks.filter((c) => c.stream === "status" && c.data.startsWith(FX_RECOVERY_STATUS_PREFIX));
    const payloads = recoveryChunks.map(
      (c) => JSON.parse(c.data.slice(FX_RECOVERY_STATUS_PREFIX.length)) as Record<string, unknown>,
    );
    // Three active attempts (delaySeconds only on attempt 2), then paused —
    // exactly the shared spec's per-turn shape.
    expect(payloads.map((p) => [p.state, p.attempt, p.delaySeconds ?? null])).toEqual([
      ["active", 1, null],
      ["active", 2, 1],
      ["active", 3, null],
      ["paused", 3, null],
    ]);
    expect(payloads[3]).toMatchObject({ attemptLimit: 3, requiredAction: "continue_later" });

    // Provider sentinel precedes every recovery sentinel (emitted
    // synchronously before the first `after()` timer fires).
    expect(chunks.indexOf(recoveryChunks[0]!)).toBeGreaterThan(providerIdx);

    const statusChunks = chunks.filter((c) => c.stream === "status");
    const summaryLines = statusChunks.filter((c) => c.data.endsWith(FX_PAUSED_SUMMARY_SUFFIX));
    expect(summaryLines).toHaveLength(1);

    expect(
      statusChunks.some((c) => c.data === "fx turn ended: refused (response paused after 3/3 attempts — resumable)"),
    ).toBe(true);
  },
  8_000,
);

test(
  "fx AGETOR_FX_DRIVER=fake continueRecovery scenario: recovered sentinel + its plain summary, thinking, assistant text, usage/title sentinels, exit code 0",
  async () => {
    process.env.AGETOR_FX_DRIVER = "fake";
    const chunks: { stream: RunEventStream; data: string }[] = [];
    const handle = await spawnAgent({
      taskId: "task-fx-continue-1",
      runId: "run-fx-continue-1",
      harness: builtin("fx"),
      // Empty prompt — a continueRecovery turn's prompt text is ignored
      // entirely (see AgentRunOptions.continueRecovery's doc comment).
      prompt: "",
      cwd: "/tmp",
      onChunk: (stream, data) => { chunks.push({ stream, data }); },
      opts: {
        ...fxDefaults,
        runId: "run-fx-continue-1",
        resumeSessionId: "prior-fx-session-1",
        continueRecovery: true,
      },
    });
    const code = await handle.done;
    expect(code).toBe(0);

    const recoveryChunks = chunks.filter((c) => c.stream === "status" && c.data.startsWith(FX_RECOVERY_STATUS_PREFIX));
    expect(recoveryChunks).toHaveLength(1);
    const payload = JSON.parse(recoveryChunks[0]!.data.slice(FX_RECOVERY_STATUS_PREFIX.length)) as { state: string };
    expect(payload.state).toBe("recovered");

    const statusChunks = chunks.filter((c) => c.stream === "status");
    expect(statusChunks.some((c) => c.data === "✓ recovered · succeeded on attempt 1/3")).toBe(true);

    expect(chunks.some((c) => c.stream === "thinking" && c.data === "fake fx reasoning")).toBe(true);
    expect(chunks.some((c) => c.stream === "assistant" && c.data === "recovered answer")).toBe(true);

    const usage1 = `${FX_USAGE_STATUS_PREFIX}${JSON.stringify({ used: 1234, size: 128000 })}`;
    const usage2 = `${FX_USAGE_STATUS_PREFIX}${JSON.stringify({ turn: { inputTokens: 42, outputTokens: 7 } })}`;
    const title = `${FX_SESSION_TITLE_STATUS_PREFIX}Fake fx session`;
    expect(statusChunks.some((c) => c.data === usage1)).toBe(true);
    expect(statusChunks.some((c) => c.data === usage2)).toBe(true);
    expect(statusChunks.some((c) => c.data === title)).toBe(true);
  },
  8_000,
);

test(
  "fx AGETOR_FX_DRIVER=fake continueRecovery wins even when the prompt also carries the fx-permission marker",
  async () => {
    process.env.AGETOR_FX_DRIVER = "fake";
    const chunks: { stream: RunEventStream; data: string }[] = [];
    const handle = await spawnAgent({
      taskId: "task-fx-continue-vs-permission-1",
      runId: "run-fx-continue-vs-permission-1",
      harness: builtin("fx"),
      prompt: FAKE_FX_PERMISSION_PROMPT_MARKER,
      cwd: "/tmp",
      onChunk: (stream, data) => { chunks.push({ stream, data }); },
      opts: {
        ...fxDefaults,
        runId: "run-fx-continue-vs-permission-1",
        resumeSessionId: "prior-fx-session-2",
        continueRecovery: true,
      },
    });
    const code = await handle.done;
    expect(code).toBe(0);

    // The "continue" recovery variant ran (a single recovered sentinel) —
    // not the fx_permission-card scenario the prompt marker would otherwise
    // select. `makeFakeAgent`'s recovery branch is checked before the
    // fx-permission branch, and `continueRecovery === true` is the first
    // (short-circuiting) condition in its own `||` chain, so it wins
    // regardless of prompt content.
    const recoveryChunks = chunks.filter((c) => c.stream === "status" && c.data.startsWith(FX_RECOVERY_STATUS_PREFIX));
    expect(recoveryChunks).toHaveLength(1);
    expect(chunks.some((c) => c.data.startsWith("fake fx permission"))).toBe(false);
  },
  8_000,
);

test(
  "fx AGETOR_FX_DRIVER=fake recovery storm: kill() mid-storm (200ms) settles immediately and never emits the paused/refused chunks afterwards",
  async () => {
    process.env.AGETOR_FX_DRIVER = "fake";
    const chunks: { stream: RunEventStream; data: string }[] = [];
    const handle = await spawnAgent({
      taskId: "task-fx-recovery-kill-1",
      runId: "run-fx-recovery-kill-1",
      harness: builtin("fx"),
      prompt: `hi ${FAKE_FX_RECOVERY_PROMPT_MARKER}`,
      cwd: "/tmp",
      onChunk: (stream, data) => { chunks.push({ stream, data }); },
      opts: { ...fxDefaults, runId: "run-fx-recovery-kill-1" },
    });

    await new Promise((r) => setTimeout(r, 200));
    handle.kill();
    // makeFakeAgent's kill() clears every pending timer and resolves `done`
    // with code 0 unconditionally (see agents.ts) — regardless of which
    // scenario was mid-flight.
    const code = await handle.done;
    expect(code).toBe(0);

    // Wait past when the storm's later timers (400ms/800ms/1500ms) would
    // have fired had kill() not cleared them, then assert they never did.
    await new Promise((r) => setTimeout(r, 1800));

    const recoveryStates = chunks
      .filter((c) => c.stream === "status" && c.data.startsWith(FX_RECOVERY_STATUS_PREFIX))
      .map((c) => (JSON.parse(c.data.slice(FX_RECOVERY_STATUS_PREFIX.length)) as { state: string }).state);
    expect(recoveryStates).not.toContain("paused");
    expect(chunks.some((c) => c.data.endsWith(FX_PAUSED_SUMMARY_SUFFIX))).toBe(false);
    expect(chunks.some((c) => c.data.startsWith("fx turn ended: refused"))).toBe(false);
  },
  8_000,
);

// --- fx repause (FAKE_FX_REPAUSE_PROMPT_MARKER/AGETOR_FAKE_FX_REPAUSE) and
// recovery-URL (FAKE_FX_RECOVERY_URL_PROMPT_MARKER/AGETOR_FAKE_FX_RECOVERY_URL)
// fake-driver triggers — docs/plans/fx-recovery-follow-ups.md §3.6/T3.

test(
  "fx AGETOR_FX_DRIVER=fake continueRecovery under AGETOR_FAKE_FX_REPAUSE=1 storms and pauses again (3/3, refused, exit 1); the identical continueRecovery launch without it recovers (exit 0)",
  async () => {
    process.env.AGETOR_FX_DRIVER = "fake";

    // Baseline first, with the repause toggle still off: a continueRecovery
    // launch recovers, exactly like the "continueRecovery scenario" test
    // above — asserted here again for the direct with/without contrast the
    // test title promises.
    const baselineChunks: { stream: RunEventStream; data: string }[] = [];
    const baselineHandle = await spawnAgent({
      taskId: "task-fx-repause-baseline-1",
      runId: "run-fx-repause-baseline-1",
      harness: builtin("fx"),
      prompt: "",
      cwd: "/tmp",
      onChunk: (stream, data) => { baselineChunks.push({ stream, data }); },
      opts: {
        ...fxDefaults,
        runId: "run-fx-repause-baseline-1",
        resumeSessionId: "prior-fx-session-repause-baseline",
        continueRecovery: true,
      },
    });
    expect(await baselineHandle.done).toBe(0);
    const baselineStates = baselineChunks
      .filter((c) => c.stream === "status" && c.data.startsWith(FX_RECOVERY_STATUS_PREFIX))
      .map((c) => (JSON.parse(c.data.slice(FX_RECOVERY_STATUS_PREFIX.length)) as { state: string }).state);
    expect(baselineStates).toEqual(["recovered"]);
    expect(baselineChunks.some((c) => c.data.startsWith("fx turn ended: refused"))).toBe(false);

    // Now the same continueRecovery shape, but with the repause toggle on:
    // makeFakeAgent's `repause` check wins over `continueRecovery` alone
    // (see FAKE_FX_REPAUSE_PROMPT_MARKER's doc comment), so it re-storms
    // instead of recovering — this is what makes the auto-resume cap
    // (FX_AUTO_RESUME_MAX) exercisable without chaining three real pauses.
    process.env.AGETOR_FAKE_FX_REPAUSE = "1";
    const stormChunks: { stream: RunEventStream; data: string }[] = [];
    const stormHandle = await spawnAgent({
      taskId: "task-fx-repause-storm-1",
      runId: "run-fx-repause-storm-1",
      harness: builtin("fx"),
      prompt: "",
      cwd: "/tmp",
      onChunk: (stream, data) => { stormChunks.push({ stream, data }); },
      opts: {
        ...fxDefaults,
        runId: "run-fx-repause-storm-1",
        resumeSessionId: "prior-fx-session-repause-storm",
        continueRecovery: true,
      },
    });
    expect(await stormHandle.done).toBe(1);

    const recoveryChunks = stormChunks.filter(
      (c) => c.stream === "status" && c.data.startsWith(FX_RECOVERY_STATUS_PREFIX),
    );
    const payloads = recoveryChunks.map(
      (c) => JSON.parse(c.data.slice(FX_RECOVERY_STATUS_PREFIX.length)) as Record<string, unknown>,
    );
    expect(payloads.map((p) => [p.state, p.attempt, p.delaySeconds ?? null])).toEqual([
      ["active", 1, null],
      ["active", 2, 1],
      ["active", 3, null],
      ["paused", 3, null],
    ]);
    expect(payloads[3]).toMatchObject({ attemptLimit: 3, requiredAction: "continue_later" });

    const stormStatusChunks = stormChunks.filter((c) => c.stream === "status");
    const summaryLines = stormStatusChunks.filter((c) => c.data.endsWith(FX_PAUSED_SUMMARY_SUFFIX));
    expect(summaryLines).toHaveLength(1);
    expect(
      stormStatusChunks.some(
        (c) => c.data === "fx turn ended: refused (response paused after 3/3 attempts — resumable)",
      ),
    ).toBe(true);
  },
  8_000,
);

test(
  "fx AGETOR_FX_DRIVER=fake: a prompt carrying ONLY FAKE_FX_REPAUSE_PROMPT_MARKER (no FAKE_FX_RECOVERY_PROMPT_MARKER) storms on its very first, non-continue launch",
  async () => {
    process.env.AGETOR_FX_DRIVER = "fake";
    const chunks: { stream: RunEventStream; data: string }[] = [];
    const handle = await spawnAgent({
      taskId: "task-fx-repause-first-run-1",
      runId: "run-fx-repause-first-run-1",
      harness: builtin("fx"),
      // Only the repause marker — never the plain recovery marker — is
      // present, per FAKE_FX_REPAUSE_PROMPT_MARKER's doc comment: it's also
      // wired into the top-level scenario-selection condition, so a fresh
      // (non-continue) launch storms on it alone.
      prompt: `hi ${FAKE_FX_REPAUSE_PROMPT_MARKER}`,
      cwd: "/tmp",
      onChunk: (stream, data) => { chunks.push({ stream, data }); },
      opts: { ...fxDefaults, runId: "run-fx-repause-first-run-1" },
    });
    const code = await handle.done;
    expect(code).toBe(1);

    const recoveryChunks = chunks.filter((c) => c.stream === "status" && c.data.startsWith(FX_RECOVERY_STATUS_PREFIX));
    const states = recoveryChunks.map(
      (c) => (JSON.parse(c.data.slice(FX_RECOVERY_STATUS_PREFIX.length)) as { state: string }).state,
    );
    expect(states).toEqual(["active", "active", "active", "paused"]);
    expect(
      chunks.some(
        (c) => c.stream === "status" && c.data === "fx turn ended: refused (response paused after 3/3 attempts — resumable)",
      ),
    ).toBe(true);
  },
  8_000,
);

test(
  "fx AGETOR_FX_DRIVER=fake recovery storm + AGETOR_FAKE_FX_RECOVERY_URL=1: every active/paused message carries ' · upgrade at https://example.invalid/upgrade', never a recovered message",
  async () => {
    process.env.AGETOR_FX_DRIVER = "fake";
    process.env.AGETOR_FAKE_FX_RECOVERY_URL = "1";
    const chunks: { stream: RunEventStream; data: string }[] = [];
    const handle = await spawnAgent({
      taskId: "task-fx-recovery-url-storm-1",
      runId: "run-fx-recovery-url-storm-1",
      harness: builtin("fx"),
      prompt: `hi ${FAKE_FX_RECOVERY_PROMPT_MARKER}`,
      cwd: "/tmp",
      onChunk: (stream, data) => { chunks.push({ stream, data }); },
      opts: { ...fxDefaults, runId: "run-fx-recovery-url-storm-1" },
    });
    expect(await handle.done).toBe(1);

    const recoveryChunks = chunks.filter((c) => c.stream === "status" && c.data.startsWith(FX_RECOVERY_STATUS_PREFIX));
    const payloads = recoveryChunks.map(
      (c) => JSON.parse(c.data.slice(FX_RECOVERY_STATUS_PREFIX.length)) as { state: string; message: string },
    );
    expect(payloads).toHaveLength(4);
    for (const p of payloads) {
      expect(["active", "paused"]).toContain(p.state);
      expect(p.message.endsWith(" · upgrade at https://example.invalid/upgrade")).toBe(true);
    }
  },
  8_000,
);

test(
  "fx AGETOR_FX_DRIVER=fake continueRecovery + AGETOR_FAKE_FX_RECOVERY_URL=1: the recovered message never carries the upgrade-URL suffix",
  async () => {
    process.env.AGETOR_FX_DRIVER = "fake";
    process.env.AGETOR_FAKE_FX_RECOVERY_URL = "1";
    const chunks: { stream: RunEventStream; data: string }[] = [];
    const handle = await spawnAgent({
      taskId: "task-fx-recovery-url-recovered-1",
      runId: "run-fx-recovery-url-recovered-1",
      harness: builtin("fx"),
      prompt: "",
      cwd: "/tmp",
      onChunk: (stream, data) => { chunks.push({ stream, data }); },
      opts: {
        ...fxDefaults,
        runId: "run-fx-recovery-url-recovered-1",
        resumeSessionId: "prior-fx-session-recovery-url",
        continueRecovery: true,
      },
    });
    expect(await handle.done).toBe(0);

    const recoveryChunks = chunks.filter((c) => c.stream === "status" && c.data.startsWith(FX_RECOVERY_STATUS_PREFIX));
    expect(recoveryChunks).toHaveLength(1);
    const payload = JSON.parse(recoveryChunks[0]!.data.slice(FX_RECOVERY_STATUS_PREFIX.length)) as {
      state: string;
      message: string;
    };
    expect(payload.state).toBe("recovered");
    expect(payload.message).toBe("✓ recovered · succeeded on attempt 1/3");
    expect(payload.message.includes("upgrade at")).toBe(false);
  },
  8_000,
);

test(
  "fx AGETOR_FX_DRIVER=fake recovery storm WITHOUT AGETOR_FAKE_FX_RECOVERY_URL: messages stay byte-identical to the pre-existing (no-URL) expectations",
  async () => {
    process.env.AGETOR_FX_DRIVER = "fake";
    const chunks: { stream: RunEventStream; data: string }[] = [];
    const handle = await spawnAgent({
      taskId: "task-fx-recovery-no-url-1",
      runId: "run-fx-recovery-no-url-1",
      harness: builtin("fx"),
      prompt: `hi ${FAKE_FX_RECOVERY_PROMPT_MARKER}`,
      cwd: "/tmp",
      onChunk: (stream, data) => { chunks.push({ stream, data }); },
      opts: { ...fxDefaults, runId: "run-fx-recovery-no-url-1" },
    });
    expect(await handle.done).toBe(1);

    const recoveryChunks = chunks.filter((c) => c.stream === "status" && c.data.startsWith(FX_RECOVERY_STATUS_PREFIX));
    const messages = recoveryChunks.map(
      (c) => (JSON.parse(c.data.slice(FX_RECOVERY_STATUS_PREFIX.length)) as { message: string }).message,
    );
    expect(messages).toEqual([
      "⚠ Rate limited · HTTP 429 · fake gateway limit · retrying request · attempt 1/3",
      "⚠ Rate limited · HTTP 429 · fake gateway limit · retrying request in 1s · attempt 2/3",
      "⚠ Rate limited · HTTP 429 · fake gateway limit · retrying request · attempt 3/3",
      "⚠ Rate limited · HTTP 429 · fake gateway limit · recovery paused after 3/3 attempts",
    ]);
  },
  8_000,
);

test("AGENT_OPTIONS.fx.modes[0] is 'yolo' (Full access is the default mode)", () => {
  expect(AGENT_OPTIONS.fx.modes[0]?.id).toBe("yolo");
});

test("fx buildCommand: a null stored mode now resolves to FX_PERMISSION_MODE=yolo via defaultModeFor (the owner's explicit reversal of the earlier no-silent-escalation decision — docs/plans/fx-recovery-follow-ups.md §3.6, item 6)", () => {
  const { env } = buildCommand(builtin("fx"), "hi", { ...fxDefaults, mode: null });
  expect(env?.FX_PERMISSION_MODE).toBe(defaultModeFor("fx"));
  expect(env?.FX_PERMISSION_MODE).toBe("yolo");
});

// --- defaultModeFor(kind) parity across every kind's buildCommand branch --
// docs/plans/fx-recovery-follow-ups.md §3.6, item 6: `defaultModeFor(kind)`
// (`AGENT_OPTIONS[kind].modes[0]?.id ?? "auto"`) is now the single fallback
// every buildCommand branch uses for `opts.mode ?? …` — not just fx's. A
// stored `null` mode must therefore produce byte-identical argv/env to
// passing that kind's default mode explicitly, for every kind, not only fx
// (whose default happens to differ from "auto").

test("claude-code: a null mode yields the exact same argv/env as passing defaultModeFor(\"claude-code\") explicitly", () => {
  expect(defaultModeFor("claude-code")).toBe("auto");
  const nullResult = buildCommand(builtin("claude-code"), "hi", { ...claudeDefaults, mode: null });
  const explicitResult = buildCommand(builtin("claude-code"), "hi", {
    ...claudeDefaults,
    mode: defaultModeFor("claude-code"),
  });
  expect(nullResult).toEqual(explicitResult);
});

test("codex: a null mode yields the exact same argv/env as passing defaultModeFor(\"codex\") explicitly", () => {
  expect(defaultModeFor("codex")).toBe("auto");
  const nullResult = buildCommand(builtin("codex"), "hi", { ...codexDefaults, mode: null });
  const explicitResult = buildCommand(builtin("codex"), "hi", { ...codexDefaults, mode: defaultModeFor("codex") });
  expect(nullResult).toEqual(explicitResult);
});

test("cursor: a null mode yields the exact same argv/env as passing defaultModeFor(\"cursor\") explicitly", () => {
  expect(defaultModeFor("cursor")).toBe("auto");
  const nullResult = buildCommand(builtin("cursor"), "hi", { ...cursorDefaults, mode: null });
  const explicitResult = buildCommand(builtin("cursor"), "hi", { ...cursorDefaults, mode: defaultModeFor("cursor") });
  expect(nullResult).toEqual(explicitResult);
});

test("gemini: a null mode yields the exact same argv/env as passing defaultModeFor(\"gemini\") explicitly", () => {
  expect(defaultModeFor("gemini")).toBe("auto");
  const nullResult = buildCommand(builtin("gemini"), "hi", { ...geminiDefaults, mode: null });
  const explicitResult = buildCommand(builtin("gemini"), "hi", { ...geminiDefaults, mode: defaultModeFor("gemini") });
  expect(nullResult).toEqual(explicitResult);
});

test("fx: a null mode yields the exact same argv/env as passing defaultModeFor(\"fx\") explicitly (\"yolo\" — the one kind whose default isn't \"auto\")", () => {
  expect(defaultModeFor("fx")).toBe("yolo");
  const nullResult = buildCommand(builtin("fx"), "hi", { ...fxDefaults, mode: null });
  const explicitResult = buildCommand(builtin("fx"), "hi", { ...fxDefaults, mode: defaultModeFor("fx") });
  expect(nullResult).toEqual(explicitResult);
});

test("claude-code 'max' effort sets CLAUDE_CODE_EFFORT_LEVEL=max env", () => {
  const result = buildCommand(builtin("claude-code"), "do the thing", { ...claudeDefaults, effort: "max", mode: "auto" });
  expect(result.env).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: "max", CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false" });
});

test.each(["low", "medium", "high", "xhigh"])(
  "claude-code '%s' effort sets CLAUDE_CODE_EFFORT_LEVEL accordingly",
  (level) => {
    const result = buildCommand(builtin("claude-code"), "p", { ...claudeDefaults, effort: level, mode: "auto" });
    expect(result.env).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: level, CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false" });
  },
);

test("claude-code unknown effort id is dropped (no env)", () => {
  // Unknown values still satisfy the "effort was provided" check but are
  // filtered out of CLAUDE_EFFORT_VALUES so they don't reach the CLI.
  const result = buildCommand(builtin("claude-code"), "p", { ...claudeDefaults, effort: "yolo", mode: "auto" });
  expect(result.env).toEqual({ CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false" });
});

// Claude Code's prompt suggestions and the startup `Try "…"` sample render as
// dim text on the `❯` row; agetor turns them off on every claude-code launch
// (docs/plans/claude-code-placeholder.md, P6).
test("claude-code (built-in) with effort carries CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false", () => {
  const { env } = buildCommand(builtin("claude-code"), "p", { ...claudeDefaults });
  expect(env?.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION).toBe("false");
  expect(env?.CLAUDE_CODE_EFFORT_LEVEL).toBe("high");
});

test("claude-code (built-in) without effort carries CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false", () => {
  const { env } = buildCommand(builtin("claude-code"), "p", { mode: "auto", model: "haiku-4.5", effort: null });
  expect(env?.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION).toBe("false");
});

test("an extra-account claude-code harness carries CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false beside its own env", () => {
  const secondary: Harness = {
    ...alias("claude-code", { home: "/tmp/agetor-test/claude-2", env: { FOO: "bar" } }),
    id: "secondary-claude-code",
    label: "secondary-claude-code",
  };
  const { env } = buildCommand(secondary, "p", { ...claudeDefaults });
  expect(env?.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION).toBe("false");
  expect(env?.CLAUDE_CONFIG_DIR).toBe("/tmp/agetor-test/claude-2");
  expect(env?.FOO).toBe("bar");
});

test("claude-code resumeSessionId launch carries CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false", () => {
  const { cmd, env } = buildCommand(builtin("claude-code"), "p", {
    ...claudeDefaults,
    resumeSessionId: "abc-123-uuid",
  });
  expect(cmd).toContain("--resume");
  expect(env?.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION).toBe("false");
});

test("a claude-code harness whose own env sets CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION keeps its value", () => {
  const { env } = buildCommand(
    alias("claude-code", { env: { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "true" } }),
    "p",
    { ...claudeDefaults },
  );
  expect(env?.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION).toBe("true");
});

test("non-claude kinds never get CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION", () => {
  const launches: { env?: Record<string, string> }[] = [
    buildCommand(builtin("codex"), "p", { ...codexDefaults }),
    buildCommand(builtin("gemini"), "p", { ...geminiDefaults }),
    buildCommand(builtin("cursor"), "p", { ...cursorDefaults }),
    buildCommand(builtin("fx"), "p", { ...fxDefaults }),
    buildCommand(alias("codex", { home: "/tmp/agetor-test/codex-2" }), "p", { ...codexDefaults }),
  ];
  for (const { env } of launches) {
    expect(env?.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION).toBeUndefined();
  }
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

// --- AGETOR_CLAUDE_DRIVER=fake pipeline-handoff two-turn suffixes -----------
// See docs/plans/pipelines.md and agents.ts's FAKE_CLAUDE_HANDOFF_PROMPT_MARKER
// doc comment: the pipeline runner sends ONE automatic reminder (a plain
// follow-up sendInput turn, no marker of its own) when a step's reply lacked
// a valid <handoff>, and `missing-then-done` / `invalid-then-done` /
// `missing-then-<StepName>` model "fail the first turn, succeed after the
// reminder" so pipeline-runner.test.ts (owned elsewhere) can exercise that
// recovery path against the fake driver. These tests drive `spawnAgent`
// directly against the claude-code fake driver, mirroring the fx fake-driver
// tests above.

/** Minimal hand-built Task fixture — mirrors db-sent-files.test.ts's
 *  makeTaskRow. Only `prompt` matters here: it's what
 *  `resolveFakeHandoffPromptSource` falls back to when a follow-up turn's
 *  own prompt carries no marker. */
function makeHandoffTaskRow(taskId: string, prompt: string): Task {
  return {
    id: taskId,
    title: "t",
    prompt,
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    speed: "off",
    maxMode: false,
    opencodeServer: "shared",
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    column: "ready",
    runId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
  };
}

/** Spawn one fake claude-code handoff turn for `taskId` with the given
 *  `prompt`, collect its assistant text, and return whether a <handoff> tag
 *  was present in it — `"missing"` (no tag at all), `"invalid"` (tag present
 *  but JSON.parse fails), or the parsed handoff object. */
async function runFakeHandoffTurn(
  taskId: string,
  prompt: string,
): Promise<"missing" | "invalid" | { next: string | null }> {
  process.env.AGETOR_CLAUDE_DRIVER = "fake";
  let assistantText = "";
  const handle = await spawnAgent({
    taskId,
    runId: `run-${taskId}-${Date.now()}-${Math.random()}`,
    harness: builtin("claude-code"),
    prompt,
    cwd: "/tmp",
    onChunk: (stream, data) => { if (stream === "assistant") assistantText += data; },
    opts: { model: "claude-opus-4-7", effort: "high" },
  });
  await handle.done;
  if (!assistantText.includes("<handoff>")) return "missing";
  const match = /<handoff>\n([\s\S]*?)\n<\/handoff>/.exec(assistantText);
  if (!match) return "invalid";
  try {
    return JSON.parse(match[1] as string) as { next: string | null };
  } catch {
    return "invalid";
  }
}

test("claude fake driver: missing-then-done emits no handoff on turn 1 and a valid handoff on turn 2 for the same taskId", async () => {
  const taskId = "task-handoff-missing-then-done";
  const prompt = `Do the step. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing-then-done`;
  const turn1 = await runFakeHandoffTurn(taskId, prompt);
  expect(turn1).toBe("missing");
  const turn2 = await runFakeHandoffTurn(taskId, prompt);
  expect(turn2).not.toBe("missing");
  expect(turn2).not.toBe("invalid");
  expect((turn2 as { next: string | null }).next).toBeNull();
});

test("claude fake driver: invalid-then-done emits an unparsable handoff on turn 1 and a valid handoff on turn 2", async () => {
  const taskId = "task-handoff-invalid-then-done";
  const prompt = `Do the step. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:invalid-then-done`;
  const turn1 = await runFakeHandoffTurn(taskId, prompt);
  expect(turn1).toBe("invalid");
  const turn2 = await runFakeHandoffTurn(taskId, prompt);
  expect((turn2 as { next: string | null }).next).toBeNull();
});

test("claude fake driver: missing-then-<StepName> emits no handoff on turn 1 and a handoff naming that step on turn 2", async () => {
  const taskId = "task-handoff-missing-then-step";
  const prompt = `Do the step. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing-then-StepB`;
  const turn1 = await runFakeHandoffTurn(taskId, prompt);
  expect(turn1).toBe("missing");
  const turn2 = await runFakeHandoffTurn(taskId, prompt);
  expect((turn2 as { next: string | null }).next).toBe("StepB");
});

test("claude fake driver: a follow-up prompt without a marker inherits the task's original stored-prompt marker", async () => {
  const taskId = "task-handoff-inherit-plain";
  tasks.insert(makeHandoffTaskRow(taskId, `Do the step. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:StepC`));
  // The follow-up line itself (e.g. a real pipeline-runner reminder, or any
  // other marker-less resend) carries no marker at all.
  const result = await runFakeHandoffTurn(taskId, "please try again and include a <handoff> block");
  expect(result).not.toBe("missing");
  expect(result).not.toBe("invalid");
  expect((result as { next: string | null }).next).toBe("StepC");
});

test("claude fake driver: a follow-up without a marker plus an unstarted/unknown taskId never enters the handoff branch", async () => {
  process.env.AGETOR_CLAUDE_DRIVER = "fake";
  let assistantText = "";
  const handle = await spawnAgent({
    taskId: "task-handoff-unknown-no-marker",
    runId: "run-handoff-unknown-no-marker",
    harness: builtin("claude-code"),
    prompt: "plain follow-up with no marker and no task row",
    cwd: "/tmp",
    onChunk: (stream, data) => { if (stream === "assistant") assistantText += data; },
    opts: { model: "claude-opus-4-7", effort: "high" },
  });
  await handle.done;
  expect(assistantText).not.toContain("<handoff>");
  expect(assistantText).not.toContain("I finished the work but forgot the handoff.");
});

test("claude fake driver: two-turn inheritance combines with a task's stored marker (turn 1 missing, turn 2 done via reminder-style follow-up)", async () => {
  const taskId = "task-handoff-inherit-two-turn";
  const original = `Do the step. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:missing-then-done`;
  tasks.insert(makeHandoffTaskRow(taskId, original));
  // Turn 1: launched with the task's own original prompt (as the real
  // pipeline runner does on first launch).
  const turn1 = await runFakeHandoffTurn(taskId, original);
  expect(turn1).toBe("missing");
  // Turn 2: the runner's automatic reminder — no marker of its own —
  // inherits the ORIGINAL prompt's marker/suffix and, since this is now
  // turn 2 for this taskId, resolves to the "then" (done) behavior.
  const turn2 = await runFakeHandoffTurn(taskId, "no <handoff> was found in your last reply — please retry");
  expect((turn2 as { next: string | null }).next).toBeNull();
});

// ── opencode (docs/plans/add-opencode-harness.md D-3/D-4/D-5/D-6/D-9/D-18, spike A10) ──

const V2 = "opencode v2.1.3";
const V1 = "1.19.4";
const opencodeDefaults = { mode: "auto", model: "opencode-default", effort: "auto" } as const;
const BASE = ["opencode", "run", "--format", "json", "--thinking"];

/** A harness of an unknown kind — the exhaustive `never` arms must throw on
 *  it rather than falling through to codex/gemini. */
function bogusHarness(home: string | null = null): Harness {
  return { ...builtin("codex"), id: "bogus", kind: "bogus" as AgentKind, home };
}

test("opencode resolveBin: AGETOR_OPENCODE_BIN override, harness.bin wins over it", () => {
  expect(resolveBin(builtin("opencode"))).toBe("opencode");
  process.env.AGETOR_OPENCODE_BIN = "/opt/oc/opencode";
  expect(resolveBin(builtin("opencode"))).toBe("/opt/oc/opencode");
  expect(resolveBin(alias("opencode", { bin: "/usr/local/bin/opencode" }))).toBe("/usr/local/bin/opencode");
});

test("opencode harnessEnv: a home pins HOME plus all four XDG dirs under it; the harness env map still wins", () => {
  expect(harnessEnv(builtin("opencode"))).toEqual({});
  expect(harnessEnv(alias("opencode", { home: "/h/oc-2", env: { XDG_CACHE_HOME: "/elsewhere" } }))).toEqual({
    HOME: "/h/oc-2",
    XDG_CONFIG_HOME: "/h/oc-2/.config",
    XDG_DATA_HOME: "/h/oc-2/.local/share",
    XDG_STATE_HOME: "/h/oc-2/.local/state",
    XDG_CACHE_HOME: "/elsewhere",
  });
});

test("gemini harnessEnv stays GEMINI_CLI_HOME after the fall-through became an explicit arm", () => {
  expect(harnessEnv(alias("gemini", { home: "/h/g" }))).toEqual({ GEMINI_CLI_HOME: "/h/g" });
});

test("opencode buildHarnessTerminalCommand re-homes inline through HOME + XDG", () => {
  expect(buildHarnessTerminalCommand(alias("opencode", { home: "/h" }))).toBe(
    "HOME='/h' XDG_CONFIG_HOME='/h/.config' XDG_DATA_HOME='/h/.local/share' XDG_STATE_HOME='/h/.local/state' XDG_CACHE_HOME='/h/.cache' opencode",
  );
});

// Argv matrix: major × mode × server × model × effort × resume/title.
type OcCase = {
  name: string;
  harness?: Harness;
  opts: Record<string, unknown>;
  cmd: string[];
};
const OC_CASES: OcCase[] = [
  { name: "v2 shared auto sentinel", opts: { cliVersion: V2 }, cmd: [...BASE, "--auto"] },
  { name: "v1 shared auto sentinel", opts: { cliVersion: V1 }, cmd: [...BASE, "--auto"] },
  { name: "v2 standalone", opts: { cliVersion: V2, opencodeServer: "standalone" }, cmd: [...BASE, "--auto", "--standalone"] },
  { name: "v1 ignores standalone (no flag on v1)", opts: { cliVersion: V1, opencodeServer: "standalone" }, cmd: [...BASE, "--auto"] },
  { name: "v2 harness with a home forces standalone", harness: alias("opencode", { home: "/h" }), opts: { cliVersion: V2, opencodeServer: "shared" }, cmd: [...BASE, "--auto", "--standalone"] },
  { name: "v1 harness with a home: still no flag", harness: alias("opencode", { home: "/h" }), opts: { cliVersion: V1 }, cmd: [...BASE, "--auto"] },
  { name: "unknown/missing version reads as v2", opts: { cliVersion: null, opencodeServer: "standalone" }, cmd: [...BASE, "--auto", "--standalone"] },
  { name: "v2 plan", opts: { cliVersion: V2, mode: "plan" }, cmd: [...BASE, "--agent", "plan"] },
  { name: "v1 plan", opts: { cliVersion: V1, mode: "plan" }, cmd: [...BASE, "--agent", "plan"] },
  { name: "null mode resolves to auto", opts: { cliVersion: V2, mode: null }, cmd: [...BASE, "--auto"] },
  { name: "unknown mode gets no flag", opts: { cliVersion: V2, mode: "mystery" }, cmd: [...BASE] },
  { name: "v2 real model, auto effort", opts: { cliVersion: V2, model: "opencode/big-pickle" }, cmd: [...BASE, "-m", "opencode/big-pickle", "--auto"] },
  { name: "v1 real model, auto effort", opts: { cliVersion: V1, model: "opencode/big-pickle" }, cmd: [...BASE, "-m", "opencode/big-pickle", "--auto"] },
  { name: "v2 real model, null effort", opts: { cliVersion: V2, model: "anthropic/claude-x", effort: null }, cmd: [...BASE, "-m", "anthropic/claude-x", "--auto"] },
  { name: "v2 variant rides in the model id", opts: { cliVersion: V2, model: "opencode/deepseek-v4.1-flash-free", effort: "high" }, cmd: [...BASE, "-m", "opencode/deepseek-v4.1-flash-free#high", "--auto"] },
  { name: "v1 variant is --variant", opts: { cliVersion: V1, model: "opencode/deepseek-v4.1-flash-free", effort: "high" }, cmd: [...BASE, "-m", "opencode/deepseek-v4.1-flash-free", "--variant", "high", "--auto"] },
  { name: "sentinel drops a stored variant", opts: { cliVersion: V2, effort: "high" }, cmd: [...BASE, "--auto"] },
  { name: "fresh session carries --title", opts: { cliVersion: V2, title: "Fix the login bug" }, cmd: [...BASE, "--auto", "--title=Fix the login bug"] },
  // A dash-leading title must stay one `--title=` item: OpenCode v2 parses a
  // separate `-v2 migration` value as `-v` (prints the version, runs nothing).
  { name: "dash-leading title stays the --title= value", opts: { cliVersion: V2, title: "-v2 migration" }, cmd: [...BASE, "--auto", "--title=-v2 migration"] },
  { name: "double-dash title stays the --title= value (v1)", opts: { cliVersion: V1, title: "--version bump" }, cmd: [...BASE, "--auto", "--title=--version bump"] },
  { name: "blank title is omitted", opts: { cliVersion: V2, title: "   " }, cmd: [...BASE, "--auto"] },
  { name: "v2 resume: -s, no --title, then --standalone", opts: { cliVersion: V2, title: "T", resumeSessionId: "ses_abc123", opencodeServer: "standalone", mode: "plan", model: "p/m", effort: "low" }, cmd: [...BASE, "-m", "p/m#low", "--agent", "plan", "-s", "ses_abc123", "--standalone"] },
  { name: "v1 resume", opts: { cliVersion: V1, resumeSessionId: "ses_abc123", model: "p/m", effort: "low" }, cmd: [...BASE, "-m", "p/m", "--variant", "low", "--auto", "-s", "ses_abc123"] },
];
test.each(OC_CASES)("opencode argv: $name", ({ harness, opts, cmd }) => {
  const built = buildCommand(harness ?? builtin("opencode"), "the prompt", { ...opencodeDefaults, ...opts });
  expect(built.cmd).toEqual(cmd);
  // The prompt never rides in argv — the driver feeds it on stdin.
  expect(built.cmd).not.toContain("the prompt");
  expect(built.deferredPrompt).toBeUndefined();
});

test("opencode resume returns a freshArgv: the same argv without -s, plus --title", () => {
  const built = buildCommand(builtin("opencode"), "p", {
    ...opencodeDefaults,
    cliVersion: V2,
    opencodeServer: "standalone",
    model: "p/m",
    effort: "high",
    resumeSessionId: "ses_old1",
    title: "Task title",
  });
  expect(built.cmd).toEqual([...BASE, "-m", "p/m#high", "--auto", "-s", "ses_old1", "--standalone"]);
  expect(built.freshArgv).toEqual([...BASE, "-m", "p/m#high", "--auto", "--title=Task title", "--standalone"]);
});

test("opencode fresh session returns no freshArgv", () => {
  const built = buildCommand(builtin("opencode"), "p", { ...opencodeDefaults, cliVersion: V2, title: "x" });
  expect(built.freshArgv).toBeUndefined();
});

test("other kinds never get a freshArgv, even when resuming", () => {
  expect(buildCommand(builtin("codex"), "p", { ...codexDefaults, resumeSessionId: "t1" }).freshArgv).toBeUndefined();
  expect(buildCommand(builtin("cursor"), "p", { ...cursorDefaults, resumeSessionId: "c1" }).freshArgv).toBeUndefined();
});

test("opencode --title is cut to OPENCODE_TITLE_MAX_CHARS code points, never mid-surrogate", () => {
  const title = "😀".repeat(OPENCODE_TITLE_MAX_CHARS + 50);
  const { cmd } = buildCommand(builtin("opencode"), "p", { ...opencodeDefaults, cliVersion: V2, title });
  const value = cmd.find((a) => a.startsWith("--title="))!.slice("--title=".length);
  expect(Array.from(value)).toHaveLength(OPENCODE_TITLE_MAX_CHARS);
  expect(value).toBe("😀".repeat(OPENCODE_TITLE_MAX_CHARS));
});

test("opencode env: OPENCODE_DISABLE_AUTOUPDATE defaults to 1; a harness env value wins", () => {
  expect(buildCommand(builtin("opencode"), "p", { ...opencodeDefaults, cliVersion: V2 }).env).toEqual({ OPENCODE_DISABLE_AUTOUPDATE: "1" });
  const env = buildCommand(alias("opencode", { home: "/h", env: { OPENCODE_DISABLE_AUTOUPDATE: "0" } }), "p", { ...opencodeDefaults, cliVersion: V2 }).env;
  expect(env?.OPENCODE_DISABLE_AUTOUPDATE).toBe("0");
  expect(env?.XDG_DATA_HOME).toBe("/h/.local/share");
  expect(env?.HOME).toBe("/h");
});

test("AGETOR_OPENCODE_ARGS land last, after --standalone", () => {
  process.env.AGETOR_OPENCODE_ARGS = "--print-logs  --log-level DEBUG";
  const { cmd } = buildCommand(builtin("opencode"), "p", { ...opencodeDefaults, cliVersion: V2, opencodeServer: "standalone" });
  expect(cmd).toEqual([...BASE, "--auto", "--standalone", "--print-logs", "--log-level", "DEBUG"]);
});

test("opencodeEffectiveServerFor: v1 → null, a home → standalone, else the task's value (absent = shared)", () => {
  expect(opencodeEffectiveServerFor(builtin("opencode"), { opencodeServer: "standalone" }, V1)).toBeNull();
  expect(opencodeEffectiveServerFor(alias("opencode", { home: "/h" }), { opencodeServer: "shared" }, V2)).toBe("standalone");
  expect(opencodeEffectiveServerFor(builtin("opencode"), { opencodeServer: "standalone" }, V2)).toBe("standalone");
  expect(opencodeEffectiveServerFor(builtin("opencode"), {}, V2)).toBe("shared");
  expect(opencodeEffectiveServerFor(builtin("opencode"), { opencodeServer: null }, null)).toBe("shared");
});

test("exhaustive never arms: an unknown kind throws instead of falling through to codex/gemini", async () => {
  expect(() => buildCommand(bogusHarness(), "p", { ...codexDefaults })).toThrow(/unknown harness kind bogus/);
  expect(() => harnessEnv(bogusHarness("/h"))).toThrow(/unknown harness kind bogus/);
  expect(() => resolveBin(bogusHarness())).toThrow(/unknown harness kind bogus/);
  process.env.AGETOR_CODEX_DRIVER = "fake";
  try {
    await expect(
      spawnAgent({ taskId: "t-bogus", runId: "r-bogus", harness: bogusHarness(), prompt: "p", cwd: "/tmp", onChunk: () => {}, opts: { ...codexDefaults } }),
    ).rejects.toThrow(/unknown harness kind bogus/);
  } finally {
    delete process.env.AGETOR_CODEX_DRIVER;
  }
});

// ── fake opencode driver (D-18) ──

type OcChunk = { stream: RunEventStream; data: string; lineUuid?: string };
async function runFakeOpencode(taskId: string, prompt: string, opts: Record<string, unknown> = {}, runId = `run-${taskId}`) {
  process.env.AGETOR_OPENCODE_DRIVER = "fake";
  const chunks: OcChunk[] = [];
  const sessionIds: string[] = [];
  const handle = await spawnAgent({
    taskId,
    runId,
    harness: builtin("opencode"),
    prompt,
    cwd: "/tmp",
    onChunk: (stream, data, lineUuid) => { chunks.push({ stream, data, lineUuid }); },
    onSessionId: (id) => { sessionIds.push(id); },
    opts: { ...opencodeDefaults, cliVersion: V2, ...opts },
  });
  const code = await handle.done;
  return { chunks, code, sessionIds, handle };
}
const toolUses = (chunks: OcChunk[]) => chunks.filter((c) => c.stream === "tool_use").map((c) => JSON.parse(c.data) as { name: string; input: Record<string, unknown> });

test("fake opencode turn: thinking → shell tool → TodoWrite → assistant text, usage sentinels, discovered ses_fake<id8> session, exit 0", async () => {
  const { chunks, code, sessionIds } = await runFakeOpencode("task-oc-plain-1", "go");
  expect(code).toBe(0);
  expect(sessionIds[0]).toBe("ses_faketaskoc");
  expect(sessionIds[0]).toMatch(/^ses_[A-Za-z0-9]+$/);

  const thinkingIdx = chunks.findIndex((c) => c.stream === "thinking" && c.data === "fake opencode reasoning");
  const uses = toolUses(chunks);
  expect(uses.map((u) => u.name)).toEqual(["shell", "TodoWrite"]);
  expect(chunks.filter((c) => c.stream === "tool_result")).toHaveLength(2);
  const shellIdx = chunks.findIndex((c) => c.stream === "tool_use");
  const assistantIdx = chunks.findIndex((c) => c.stream === "assistant");
  expect(thinkingIdx).toBeGreaterThanOrEqual(0);
  expect(thinkingIdx).toBeLessThan(shellIdx);
  expect(shellIdx).toBeLessThan(assistantIdx);
  expect(chunks[assistantIdx]!.data).toBe("fake response to: go");
  const todos = uses[1]!.input.todos as { content: string; status: string }[];
  expect(todos.map((t) => t.content)).toEqual(["inspect the project", "answer the user"]);

  const usage = chunks.filter((c) => c.stream === "status" && c.data.startsWith(FX_USAGE_STATUS_PREFIX));
  expect(usage.length).toBeGreaterThan(0);
  const last = JSON.parse(usage.at(-1)!.data.slice(FX_USAGE_STATUS_PREFIX.length)) as { cost?: { currency: string }; turn?: Record<string, number> };
  expect(last.cost?.currency).toBe("USD");
  expect(last.turn?.inputTokens).toBeGreaterThan(0);
  // Every persisted chunk carries a line uuid, so a reattach replay dedups.
  for (const c of chunks) expect(c.lineUuid).toBeTruthy();
});

test("fake opencode: two turns of one task never share a line uuid", async () => {
  const a = await runFakeOpencode("task-oc-uuid-1", "one", {}, "run-oc-uuid-a");
  const b = await runFakeOpencode("task-oc-uuid-1", "two", { resumeSessionId: a.sessionIds[0] }, "run-oc-uuid-b");
  const ua = new Set(a.chunks.map((c) => c.lineUuid));
  expect(b.chunks.some((c) => ua.has(c.lineUuid))).toBe(false);
});

test("fake opencode honors resumeSessionId", async () => {
  const { sessionIds, code } = await runFakeOpencode("task-oc-resume-1", "again", { resumeSessionId: "ses_prior42" });
  expect(code).toBe(0);
  expect(sessionIds[0]).toBe("ses_prior42");
});

test("fake opencode error marker: an error event surfaces as a status line and the turn exits 1", async () => {
  const { chunks, code } = await runFakeOpencode("task-oc-error-1", `go ${FAKE_OPENCODE_ERROR_PROMPT_MARKER}`);
  expect(code).toBe(1);
  expect(chunks.some((c) => c.stream === "status" && c.data.includes("fake opencode error"))).toBe(true);
  expect(chunks.some((c) => c.stream === "assistant")).toBe(false);
});

test("fake opencode resume-fail marker: on a resumed turn, the D-9 line, then a NEW session id", async () => {
  const { chunks, code, sessionIds } = await runFakeOpencode("task-oc-rf-1", `go ${FAKE_OPENCODE_RESUME_FAIL_PROMPT_MARKER}`, { resumeSessionId: "ses_gone1234" });
  expect(code).toBe(0);
  expect(chunks.some((c) => c.stream === "status" && c.data === opencodeResumeFailedStatusLine("ses_gone1234"))).toBe(true);
  expect(sessionIds).toHaveLength(1);
  expect(sessionIds[0]).not.toBe("ses_gone1234");
  expect(sessionIds[0]).toMatch(/^ses_[A-Za-z0-9]+$/);
});

test("fake opencode resume-fail marker is ignored on a fresh turn", async () => {
  const { chunks, sessionIds } = await runFakeOpencode("task-oc-rf-2", `go ${FAKE_OPENCODE_RESUME_FAIL_PROMPT_MARKER}`);
  expect(chunks.some((c) => c.data.startsWith("couldn't resume OpenCode session"))).toBe(false);
  expect(sessionIds[0]).toBe("ses_faketaskoc");
});

test("fake opencode kill() settles as the SIGINT exit (130) and emits nothing afterwards", async () => {
  process.env.AGETOR_OPENCODE_DRIVER = "fake";
  const chunks: OcChunk[] = [];
  const handle = await spawnAgent({
    taskId: "task-oc-kill-1",
    runId: "run-oc-kill-1",
    harness: builtin("opencode"),
    prompt: "go",
    cwd: "/tmp",
    onChunk: (stream, data, lineUuid) => { chunks.push({ stream, data, lineUuid }); },
    opts: { ...opencodeDefaults, cliVersion: V2 },
  });
  handle.kill();
  expect(await handle.done).toBe(130);
  const n = chunks.length;
  await Bun.sleep(80);
  expect(chunks.length).toBe(n);
});

test("fake opencode subagent marker: the subagent tool registers an opencode_subagent row that is not left running after settle", async () => {
  const taskId = "task-oc-sub-1";
  const runId = "run-oc-sub-1";
  tasks.insert({ ...makeHandoffTaskRow(taskId, "go"), agent: "opencode" });
  runs.insert({
    id: runId,
    taskId,
    agent: "opencode",
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
  });
  const { chunks, code } = await runFakeOpencode(taskId, `go ${FAKE_OPENCODE_SUBAGENT_PROMPT_MARKER}`, {}, runId);
  expect(code).toBe(0);
  expect(toolUses(chunks).map((u) => u.name)).toContain("subagent");
  const child = fakeOpencodeChildSessionId(taskId);
  const rows = subagentsDb.listForTask(taskId).filter((r) => r.parentKind === "opencode_subagent");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.sourcePath).toBe(`opencode-session:${child}`);
  expect(rows[0]!.status).not.toBe("running");
});
