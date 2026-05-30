import path from "node:path";
import { MODEL_EFFORT_SUPPORT, type AgentKind, type Harness } from "../shared/types.ts";
import {
  spawnClaudeViaTmux,
  toClaudeModeString,
  type ChunkHandler,
  type SpawnedAgent,
} from "./claude-tmux.ts";

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
   * For claude-code: existing JSONL session uuid to resume via
   * `claude --resume <id>`. Lets a follow-up message attach to the prior
   * conversation (full tool history) instead of starting from scratch.
   * Ignored by codex.
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
    //     the legacy flag is what users see in claude's own docs and what
    //     the hook scope check (`installScopeForMode`) keys off — keep
    //     parity with that and the narrow PreToolUse matcher behavior
    //     described below.
    //
    //   - `ask` → emit nothing; claude lands in its built-in `default`
    //     mode, which is exactly the "ask before each action" posture we
    //     want for this id. Setting `--permission-mode default`
    //     explicitly works too, but omitting it matches the prior
    //     behavior so the launch transcript is unchanged.
    //
    // Hook scope context: `auto` and `bypass` install the narrow
    // PreToolUse matcher (`^(AskUserQuestion|ExitPlanMode)$`) so claude's
    // own permission engine + classifier handles every other tool call;
    // a `.*` matcher would short-circuit the classifier and force every
    // tool through agetor's UI. Other modes (`ask`, `plan`,
    // `acceptEdits`) install the full `.*` matcher so per-tool approval
    // cards render in agetor's UI — claude's own TUI prompts are
    // invisible in detached tmux, so agetor's UI is the user's only
    // window into per-call decisions. See `installScopeForMode` in
    // hook-installer.ts.
    const mode = opts.mode ?? "auto";
    if (mode === "bypass") {
      args.push("--dangerously-skip-permissions");
    } else if (mode !== "ask") {
      args.push("--permission-mode", toClaudeModeString(mode));
    }

    args.push(...extra);

    // Initial prompt as the final argv element — claude's documented form is
    // `claude "query"` to start an interactive session with that prompt
    // already submitted.
    if (prompt) args.push(prompt);

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

  // codex
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

  const mode = opts.mode ?? "auto";
  if (mode === "auto") args.push("--full-auto");

  args.push(...extra, prompt);
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
  setTimeout(() => onChunk("stdout", `fake response to: ${prompt}`), 5);
  setTimeout(() => { onChunk("status", "turn complete"); resolveDone(0); }, 20);
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
  const { taskId, harness, prompt, cwd, onChunk, onSessionId, opts = {} } = args;

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

  const built = buildCommand(harness, prompt, opts);

  // codex: classic one-shot Bun.spawn. stdin still piped so sendInput can
  // forward user-typed lines (some codex modes accept follow-up).
  const proc = Bun.spawn(built.cmd, {
    cwd,
    env: { ...process.env, ...(built.env ?? {}) },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const pump = async (
    stream: ReadableStream<Uint8Array> | null,
    label: "stdout" | "stderr",
  ) => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      onChunk(label, decoder.decode(value, { stream: true }));
    }
  };
  void pump(proc.stdout, "stdout");
  void pump(proc.stderr, "stderr");
  return {
    kill: () => proc.kill(),
    writeInput: (line) => {
      try {
        proc.stdin.write(line.endsWith("\n") ? line : line + "\n");
        return true;
      } catch { return false; }
    },
    done: proc.exited,
  };
}

