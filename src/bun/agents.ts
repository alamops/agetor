import path from "node:path";
import { MODEL_EFFORT_SUPPORT, type AgentKind, type Harness } from "../shared/types.ts";
import {
  CLAUDE_API_ERROR_STATUS_PREFIX,
  spawnClaudeViaTmux,
  toClaudeModeString,
  type ChunkHandler,
  type SpawnedAgent,
} from "./claude-tmux.ts";
import { spawnCodexViaTmux } from "./codex-tmux.ts";

export type { SpawnedAgent };

export interface AgentCommand {
  cmd: string[];
  env?: Record<string, string>;
}

export interface AgentRunOptions {
  /** Friendly mode id; see AGENT_OPTIONS in shared/types.ts. */
  mode?: string | null;
  /** Friendly model id; see AGENT_OPTIONS in shared/types.ts. */
  model?: string | null;
  /** Friendly reasoning-effort id (codex: minimal|low|medium|high). */
  effort?: string | null;
  /**
   * Existing session id to resume a prior conversation on a follow-up turn.
   * For claude-code: the JSONL session uuid, resumed via `claude --resume
   * <id>`. For codex: the `thread_id`, resumed via `codex exec resume <id>`.
   * Either way the new prompt attaches to the full prior conversation instead
   * of starting fresh.
   */
  resumeSessionId?: string | null;
  /**
   * For claude-code: pre-generated UUID passed via `--session-id <uuid>` so
   * claude writes its JSONL transcript to a path we know in advance. With
   * this set we can `fs.watch` the exact filename instead of racing an
   * mtime-based directory poll, and the run row's `claude_session_id` is
   * known synchronously at spawn (no `onSessionId` round-trip). Mutually
   * exclusive with `resumeSessionId` — claude rejects both together.
   * Ignored by codex.
   */
  sessionId?: string | null;
}

// Map friendly model ids to the exact strings the claude-code CLI expects.
// Unknown ids are passed through verbatim (so a user can type a model the
// curated list doesn't know about yet). Codex accepts the friendly ids as-is
// so it doesn't need a translation table.
const CLAUDE_MODEL_FLAG: Record<string, string> = {
  "fable-5": "claude-fable-5",
  "opus-4.8": "claude-opus-4-8",
  "opus-4.7": "claude-opus-4-7",
  "opus-4.6": "claude-opus-4-6",
  "sonnet-4.6": "claude-sonnet-4-6",
  "haiku-4.5": "claude-haiku-4-5",
};

/**
 * Map a friendly claude-code model id (from AGENT_OPTIONS) to the exact
 * string the CLI / `/model` slash command wants. Unknown ids fall through
 * verbatim so a future curated entry "just works" until the table catches
 * up. Exported because the orchestrator needs the same translation when
 * issuing `/model <id>` to a live session.
 */
export function toClaudeModelArg(id: string): string {
  return CLAUDE_MODEL_FLAG[id] ?? id;
}

/**
 * Effort → `CLAUDE_CODE_EFFORT_LEVEL` env var on the spawned process. Same
 * lever the `/effort` slash command uses internally, so it works on every
 * claude model rather than relying on per-model API support. Unknown ids are
 * dropped rather than passed through — better than letting a typo silently
 * become a no-op or surface as a CLI error mid-run.
 *
 * Keep this in sync with `MODEL_EFFORT_SUPPORT['claude-code'][<model>]` in
 * `shared/types.ts` — the latter drives the picker, this drives the env-var
 * emit. Both list the same five ids today; if you extend one, extend the
 * other.
 */
const CLAUDE_EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh", "max"]);

/**
 * True when the named model is one we know doesn't accept any effort flag
 * (Haiku 4.5 today). For these models, `null`/missing effort is allowed and
 * `buildCommand` emits no env var / `-c` flag. Every other model must carry
 * an explicit effort id; `buildCommand` throws otherwise.
 */
function modelDeclinesEffort(kind: AgentKind, model: string): boolean {
  const support = MODEL_EFFORT_SUPPORT[kind][model];
  return Array.isArray(support) && support.length === 0;
}

/**
 * Resolve the binary path for a harness. Per-harness `bin` wins (set by the
 * user when adding an alias). Falls back to the corresponding process env
 * override for back-compat with `AGETOR_CLAUDE_BIN` / `AGETOR_CODEX_BIN`,
 * then to the kind's default name resolved against the current PATH.
 *
 * The PATH lookup goes through `Bun.which` with an explicit `{ PATH }` to
 * dodge Bun's startup PATH cache (see agent-status.ts). Without this, codex
 * (which is spawned via `Bun.spawn` directly, not through tmux) would fail
 * to launch from a packaged .app even though `claude` finds it during
 * `agent-status.checkHarness()`.
 */
export function resolveBin(harness: Harness): string {
  if (harness.bin) return harness.bin;
  const fallback = harness.kind === "claude-code" ? "claude" : "codex";
  const override = harness.kind === "claude-code"
    ? process.env.AGETOR_CLAUDE_BIN
    : process.env.AGETOR_CODEX_BIN;
  if (override) return override;
  return Bun.which(fallback, { PATH: process.env.PATH }) ?? fallback;
}

/**
 * Build the env block the harness contributes to a spawn: home-derived
 * vars (HOME + the CLI-specific config-dir) layered under the harness's
 * own `env` map. The caller (buildCommand / agent-status) merges this with
 * kind/effort env on top.
 */
export function harnessEnv(harness: Harness): Record<string, string> {
  const env: Record<string, string> = {};
  if (harness.home) {
    // claude-code uses CLAUDE_CONFIG_DIR (which it treats as the `.claude/`
    // equivalent — config, sessions, projects, and `.claude.json` all live
    // directly under it). We deliberately do NOT override HOME: on macOS,
    // claude's keychain reads ("Claude Code-credentials" via Security.framework)
    // resolve `$HOME/Library/Keychains/login.keychain-db` against the live
    // HOME, so re-homing the spawn lands on a non-existent keychain and the
    // CLI reports "Not logged in" even when a valid token is present.
    //
    // Codex goes through its own CODEX_HOME override and doesn't touch the
    // macOS keychain, so re-homing it is harmless — but CODEX_HOME is what
    // actually controls its login & history, so we set both as a belt-and-
    // braces measure.
    if (harness.kind === "claude-code") {
      env.CLAUDE_CONFIG_DIR = harness.home;
    } else {
      env.HOME = harness.home;
      env.CODEX_HOME = path.join(harness.home, ".codex");
    }
  }
  // User-provided env wins over the home-derived defaults.
  for (const [k, v] of Object.entries(harness.env ?? {})) env[k] = v;
  return env;
}

/**
 * A POSIX-valid environment variable name: a letter or underscore followed
 * by letters, digits, or underscores. Used to gate what the harness `env`
 * map may contain, both at write time (the harness POST/PATCH routes) and at
 * shell-emit time (`buildHarnessTerminalCommand` below). Anything outside
 * this set can't be a real `NAME=…` assignment and — left unquoted — would
 * let a crafted key (`X; rm -rf ~`) break out of the generated command.
 */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvKey(key: string): boolean {
  return ENV_KEY_RE.test(key);
}

/**
 * Build the command that launches a harness's agent in a new Terminal window.
 * The agent is started directly with its config applied as an inline env-var
 * prefix, so the user lands straight in the REPL (e.g. to run `/login`)
 * instead of a bare shell:
 *
 *   - default Claude Code      → `claude`
 *   - a config-dir alias       → `CLAUDE_CONFIG_DIR=… claude`
 *   - a codex alias            → `HOME=… CODEX_HOME=… codex`
 *
 * Pure and deterministic — no spawning — so the escaping is unit-testable in
 * isolation (see agents.test.ts). The caller wraps the result with
 * `toTerminalAppleScript` and hands it to `osascript`.
 *
 * Every interpolated value is POSIX single-quoted (`sq`), which neutralizes
 * `$`, backtick, spaces, and backslashes; the lone special case is `'`
 * itself, closed-escaped-reopened. Env *keys* are filtered through
 * `isValidEnvKey` rather than quoted — a non-identifier key can't be a valid
 * assignment anyway, and skipping it closes the injection vector even for
 * legacy DB rows written before the route-level validation existed.
 */
export function buildHarnessTerminalCommand(harness: Harness): string {
  const bin = resolveBin(harness);
  const launch = path.basename(bin);
  const env = harnessEnv(harness);
  const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

  // Inline `VAR=val … cmd` prefix: the agent launches with its config applied,
  // but the user's shell isn't permanently re-homed.
  const prefix: string[] = [];
  // Only an explicit `bin` override needs a PATH tweak so the bare agent name
  // resolves to it. The default and config-dir-only aliases already find the
  // agent on the inherited PATH, which keeps the command as clean as `claude`
  // / `CLAUDE_CONFIG_DIR=… claude` rather than dragging in an absolute path.
  if (harness.bin && path.isAbsolute(harness.bin)) {
    prefix.push(`PATH=${sq(path.dirname(harness.bin))}:$PATH`);
  }
  for (const [k, v] of Object.entries(env)) {
    if (!isValidEnvKey(k)) continue;
    prefix.push(`${k}=${sq(v)}`);
  }
  return [...prefix, launch].join(" ");
}

/**
 * Wrap a shell command in the AppleScript that opens it in a new Terminal.app
 * window and brings Terminal to the front. `do script` runs the command in a
 * fresh interactive shell (so the agent's REPL is fully interactive) and
 * leaves the window open when it exits. Backslash and double-quote are
 * escaped for the AppleScript double-quoted string literal.
 */
export function toTerminalAppleScript(shellCmd: string): string {
  const asEscape = (s: string) => s.replace(/(["\\])/g, "\\$1");
  return (
    `tell application "Terminal" to do script "${asEscape(shellCmd)}"\n` +
    `activate application "Terminal"`
  );
}

/**
 * Build the launch argv for a harness. For claude-code this is the
 * interactive REPL — no `--print`. The driver (tmux) drops these args after
 * `tmux new-session ... -- <argv>`. For codex this is `codex exec ...`,
 * still one-shot.
 *
 * Env handling: extra args for built-ins still come from
 * `AGETOR_CLAUDE_ARGS` / `AGETOR_CODEX_ARGS` (back-compat). Per-harness
 * `env` + `home` ride in the returned `env` block; the caller is
 * responsible for merging it onto `process.env` (codex) or `tmux -e` (claude).
 *
 * For claude-code, `prompt` is ignored — the prompt is delivered as keystrokes
 * via tmux, not as an argv element. For codex the prompt is the final argv.
 */
export function buildCommand(
  harness: Harness,
  prompt: string,
  opts: AgentRunOptions = {},
): AgentCommand {
  const bin = resolveBin(harness);
  const env: Record<string, string> = harnessEnv(harness);

  if (harness.kind === "claude-code") {
    const extra = (process.env.AGETOR_CLAUDE_ARGS ?? "").split(/\s+/).filter(Boolean);

    // Interactive launch — no --print. Model, permission-mode, session-id,
    // and resume flags all work identically in interactive mode; they set
    // the initial state of the session.
    const args: string[] = [bin];

    if (!opts.model) {
      throw new Error("model is required for claude-code");
    }
    args.push("--model", toClaudeModelArg(opts.model));

    // Pre-generated session id → claude writes its JSONL at a path we know
    // in advance (`~/.claude/projects/<encoded>/<sessionId>.jsonl`).
    // Mutually exclusive with --resume per claude's CLI contract — we only
    // emit one or the other.
    if (opts.resumeSessionId) {
      args.push("--resume", opts.resumeSessionId);
    } else if (opts.sessionId) {
      args.push("--session-id", opts.sessionId);
    }

    // Permission mode. Null → "auto" for back-compat.
    //
    // Most agetor mode ids translate 1:1 to claude's `--permission-mode`
    // values via `toClaudeModeString` (which canonicalizes `bypass` →
    // `bypassPermissions` and `ask` → `default`). Two cases bypass the
    // straight translation:
    //
    //   - `bypass` → emit `--dangerously-skip-permissions` instead of the
    //     `--permission-mode bypassPermissions` form. Both are valid, but
    //     the legacy flag is what users see in claude's own docs — keep
    //     parity with that.
    //
    //   - `ask` → emit nothing; claude lands in its built-in `default`
    //     mode, which is exactly the "ask before each action" posture we
    //     want for this id. Setting `--permission-mode default`
    //     explicitly works too, but omitting it matches the prior
    //     behavior so the launch transcript is unchanged.
    //
    // agetor installs no PreToolUse hook and no MCP server, so the mode
    // only drives these launch flags — claude's own permission engine and
    // its TUI prompts (surfaced through the tmux pane scraper) handle every
    // tool call. claude's TUI prompts are invisible in detached tmux, so
    // agetor's scraper-driven UI cards are the user's window into per-call
    // decisions.
    const mode = opts.mode ?? "auto";
    if (mode === "bypass") {
      args.push("--dangerously-skip-permissions");
    } else if (mode !== "ask") {
      args.push("--permission-mode", toClaudeModeString(mode));
    }

    args.push(...extra);

    // Initial prompt as the final argv element — claude's documented form is
    // `claude "query"` to start an interactive session with that prompt
    // already submitted. Prefix it with the `--` option terminator so a
    // prompt that STARTS WITH `-` (e.g. a markdown checklist item
    // "- [ ] do the thing", or any "--flag-like" instruction) is treated as a
    // positional and not misparsed by claude's CLI as an unknown option.
    // Without `--`, claude errors `unknown option '<prompt>'` and exits
    // before writing any JSONL — which the tmux driver only observes as a
    // dead session + empty pane + 30s boot timeout (the run just fails with
    // no visible cause). `--` is a no-op for prompts that don't lead with a
    // dash.
    if (prompt) args.push("--", prompt);

    // Effort is required unless the chosen model doesn't accept the flag
    // (Haiku 4.5 today). Unknown effort ids are dropped rather than passed
    // through — better than letting a typo silently become a no-op or
    // surface as a CLI error mid-run.
    if (opts.effort) {
      if (CLAUDE_EFFORT_VALUES.has(opts.effort)) {
        env.CLAUDE_CODE_EFFORT_LEVEL = opts.effort;
      }
    } else if (!modelDeclinesEffort("claude-code", opts.model)) {
      throw new Error(`effort is required for claude-code model ${opts.model}`);
    }

    return { cmd: args, env: Object.keys(env).length ? env : undefined };
  }

  // codex — hosted in tmux via codex-tmux.ts. The prompt is NOT an argv
  // element: it's delivered on stdin (the trailing `-`), so the driver can
  // pipe a prompt file in and no user text touches the shell wrapper.
  const extra = (process.env.AGETOR_CODEX_ARGS ?? "").split(/\s+/).filter(Boolean);

  const args: string[] = [bin, "exec"];

  if (!opts.model) {
    throw new Error("model is required for codex");
  }
  args.push("--model", opts.model);

  if (opts.effort) {
    args.push("-c", `model_reasoning_effort=${opts.effort}`);
  } else if (!modelDeclinesEffort("codex", opts.model)) {
    throw new Error(`effort is required for codex model ${opts.model}`);
  }

  // Structured streaming + deterministic capture: `--json` emits NDJSON events
  // on stdout (tailed by the driver); `--color never` guarantees clean JSON
  // even though codex runs under a tmux pty; `--skip-git-repo-check` lets a
  // task run in a non-git workdir (agetor has no sandbox philosophy).
  args.push("--json", "--color", "never", "--skip-git-repo-check");

  // Sandbox policy from the agetor mode. `auto` (hands-off) →
  // `workspace-write` so codex can edit files in the working dir without
  // approval prompts (codex exec is non-interactive — it can't prompt anyway).
  // `ask` → `read-only` (the most it can do without changing anything). We use
  // `--sandbox` rather than the deprecated `--full-auto`, which prints a
  // warning to stderr on every turn in codex 0.140+.
  const mode = opts.mode ?? "auto";
  args.push("--sandbox", mode === "auto" ? "workspace-write" : "read-only");

  args.push(...extra);

  // Multi-turn: parent flags MUST precede the `resume` subcommand (codex
  // rejects `--json`/`--color` placed after it). codex loads the prior
  // conversation from its own rollout via `thread_id`, so the new prompt is
  // just the user's next line.
  if (opts.resumeSessionId) {
    args.push("resume", opts.resumeSessionId);
  }
  // Read the prompt from stdin — `-` is codex's stdin sentinel.
  args.push("-");
  return { cmd: args, env: Object.keys(env).length ? env : undefined };
}

/**
 * Optional test hook: when `AGETOR_CLAUDE_DRIVER=fake` the claude branch
 * returns an in-process SpawnedAgent that emits canned events on a tick
 * rather than touching tmux. Keeps orchestrator integration tests fast and
 * isolated from a real CLI.
 */
type FakeDriverInstance = SpawnedAgent & { _record: string[] };
const fakeDrivers = new Map<string, FakeDriverInstance>();
export function __getFakeDriver(taskId: string): FakeDriverInstance | undefined {
  return fakeDrivers.get(taskId);
}

function makeFakeAgent(taskId: string, prompt: string, onChunk: ChunkHandler): SpawnedAgent {
  const record: string[] = [`spawn:${prompt}`];
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((res) => { resolveDone = res; });
  // Test hook: simulate a claude code API error mid-turn so orchestrator
  // tests can exercise the api-error → `blocked` column flip without having
  // to plumb a real synthetic-message JSONL through the driver. Mirrors what
  // claude-tmux.ts emits on an `isApiErrorMessage` line: the user-facing
  // text on the assistant stream + the sentinel api-error status chunk that
  // makeChunkHandler pattern-matches on. Resolves the turn with code 0
  // because that's what popEndOfTurn does — the orchestrator distinguishes
  // it from a real success via the handle.apiError flag, not exit code.
  if (process.env.AGETOR_FAKE_CLAUDE_API_ERROR === "1") {
    // Emit the chunks promptly (this is what flips the column to `blocked`
    // in the live path), but allow an optional resolve delay so
    // cancellation-precedence tests have a window to fire `cancelRun`
    // between the column flip and the done resolution. Without the delay
    // both events would land within the same tick and there'd be nowhere
    // to insert the cancel.
    const resolveDelayMs = Number(process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS ?? 5) || 5;
    setTimeout(() => {
      onChunk("assistant", "API Error: 529 Overloaded. This is a server-side issue, usually temporary.");
      onChunk("status", `${CLAUDE_API_ERROR_STATUS_PREFIX}HTTP 529 — turn aborted; blocked for manual retry`);
    }, 5);
    setTimeout(() => { resolveDone(0); }, resolveDelayMs);
  } else {
    setTimeout(() => onChunk("stdout", `fake response to: ${prompt}`), 5);
    setTimeout(() => { onChunk("status", "turn complete"); resolveDone(0); }, 20);
  }
  const inst: FakeDriverInstance = {
    _record: record,
    kill: () => { record.push("kill"); },
    writeInput: (line) => { record.push(`write:${line}`); return true; },
    done,
  };
  fakeDrivers.set(taskId, inst);
  return inst;
}

export interface SpawnAgentArgs {
  taskId: string;
  /** The run row this spawn belongs to. Used by the codex driver to key its
   *  per-run log/prompt files (so each turn — and its reattach — is isolated).
   *  Ignored by claude-code. */
  runId: string;
  harness: Harness;
  prompt: string;
  cwd: string;
  onChunk: ChunkHandler;
  /**
   * Fires with claude's session uuid. With `--session-id` we generate the
   * uuid up-front, so this fires synchronously before claude has even
   * written its first event — useful for persisting the id on the run row
   * immediately. Only invoked for claude-code; codex doesn't have a
   * comparable session id.
   */
  onSessionId?: (sessionId: string) => void;
  opts?: AgentRunOptions;
}

/**
 * Start a new agent run. For claude-code this creates the per-task tmux
 * session (or reuses one that survived a previous run). For codex this is
 * a fresh `Bun.spawn`.
 *
 * Returns a unified `SpawnedAgent` so the orchestrator's bookkeeping is the
 * same for both agents.
 */
export function spawnAgent(args: SpawnAgentArgs): SpawnedAgent {
  const { taskId, runId, harness, prompt, cwd, onChunk, onSessionId, opts = {} } = args;

  if (harness.kind === "claude-code") {
    if (process.env.AGETOR_CLAUDE_DRIVER === "fake") {
      // Build the command anyway so the fake records the prompt going by;
      // the fake's behaviour doesn't depend on the argv shape.
      buildCommand(harness, prompt, opts);
      return makeFakeAgent(taskId, prompt, onChunk);
    }
    // Pre-generate a session uuid when we're not resuming. The driver will
    // expect claude to write its JSONL at the deterministic path derived
    // from cwd + this uuid, replacing the previous mtime-poll race.
    const sessionId = opts.resumeSessionId ?? crypto.randomUUID();
    const built = buildCommand(harness, prompt, {
      ...opts,
      sessionId: opts.resumeSessionId ? null : sessionId,
    });
    onSessionId?.(sessionId);
    return spawnClaudeViaTmux({
      taskId,
      argv: built.cmd,
      env: built.env ?? {},
      cwd,
      onChunk,
      sessionId,
      configDir: harness.home,
      mode: opts.mode ?? null,
    });
  }

  // codex — hosted in a per-task tmux session via codex-tmux.ts (so a mid-turn
  // run survives an agetor restart and is reattachable), streaming structured
  // events by tailing codex's `--json` log.
  if (process.env.AGETOR_CODEX_DRIVER === "fake") {
    buildCommand(harness, prompt, opts);
    // Hand the orchestrator a thread id so it persists `codex_session_id` and
    // can route follow-ups through `codex exec resume` — mirrors what a real
    // `thread.started` event would deliver.
    onSessionId?.(`fake-codex-thread-${taskId}`);
    return makeFakeAgent(taskId, prompt, onChunk);
  }
  const built = buildCommand(harness, prompt, opts);
  return spawnCodexViaTmux({
    taskId,
    runId,
    argv: built.cmd,
    env: built.env ?? {},
    cwd,
    promptText: prompt,
    onChunk,
    onSessionId,
  });
}

