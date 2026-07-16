import path from "node:path";
import { DEFAULT_EFFORT, MODEL_EFFORT_SUPPORT, SESSION_DIED_STATUS_PREFIX, type AgentKind, type Harness } from "../shared/types.ts";
import {
  CLAUDE_API_ERROR_STATUS_PREFIX,
  spawnClaudeViaTmux,
  toClaudeModeString,
  type ChunkHandler,
  type SpawnedAgent,
} from "./claude-tmux.ts";
import { spawnCodexViaTmux } from "./codex-tmux.ts";
import { spawnGrokViaTmux } from "./grok-tmux.ts";
import { gitWritableRootsSync } from "./worktree.ts";

export type { SpawnedAgent };

export interface AgentCommand {
  cmd: string[];
  env?: Record<string, string>;
  /**
   * Set only by the claude-code branch of `buildCommand`, when the prompt is
   * too large to ride in `tmux new-session`'s argv (see
   * `CLAUDE_PROMPT_ARGV_MAX_BYTES`). `spawnAgent` forwards this to
   * `spawnClaudeViaTmux` as `ClaudeLaunchOptions.deferredPrompt`, which
   * delivers it post-launch via the same load-buffer/paste-buffer machinery
   * live-session follow-ups use, gated on the composer being idle. Always
   * undefined for codex — its prompt already rides on stdin, never argv, so
   * it has no size-driven argv problem.
   */
  deferredPrompt?: string;
}

/**
 * Prompts up to this size stay embedded in the claude-code launch argv
 * (today's behavior, byte-identical). Above it, `buildCommand` omits the
 * prompt from argv entirely and returns it as `AgentCommand.deferredPrompt`
 * instead, so `spawnAgent` can route it through `spawnClaudeViaTmux`'s
 * post-launch paste path.
 *
 * Why: tmux serializes the WHOLE client command — `new-session` flags, every
 * `-e KEY=VAL` env pair, and the trailing argv — as a single message over its
 * control socket, and tmux 3.6a rejects anything past its ~16KB imsg cap with
 * a literal `command too long` (empirically measured: 14KB ok, 16KB fails).
 * Budgeting 4KB to the prompt alone leaves generous headroom in that same
 * message for the env block and flags, which ride alongside it regardless of
 * prompt size.
 */
export const CLAUDE_PROMPT_ARGV_MAX_BYTES = 4096;

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
   * of starting fresh. Not used by grok — see `grokSession` below, which
   * bundles id+resume together instead of splitting across this field and
   * `sessionId`.
   */
  resumeSessionId?: string | null;
  /**
   * For claude-code: pre-generated UUID passed via `--session-id <uuid>` so
   * claude writes its JSONL transcript to a path we know in advance. With
   * this set we can `fs.watch` the exact filename instead of racing an
   * mtime-based directory poll, and the run row's `claude_session_id` is
   * known synchronously at spawn (no `onSessionId` round-trip). Mutually
   * exclusive with `resumeSessionId` — claude rejects both together.
   * Ignored by codex and by grok (see `grokSession` below).
   */
  sessionId?: string | null;
  /**
   * Git directories that live OUTSIDE the codex run's cwd — the source repo's
   * `.git` common dir when a task runs in a linked worktree (or a repo-subdir
   * workdir). When this is non-empty, a `git commit`'s objects/refs must reach
   * a dir the cwd-scoped `workspace-write` sandbox doesn't cover, so the codex
   * `auto` run is escalated to `--sandbox danger-full-access` (see
   * `buildCommand`). Resolved by `gitWritableRootsSync(cwd)` and only set on the
   * codex spawn path; ignored by claude-code and by codex's read-only ("ask")
   * sandbox (which can't write anything regardless).
   */
  codexExternalGitDirs?: string[];
  /**
   * Grok-only session decision (D4/D5, `docs/plans/grok-build-oss-alignment.md`).
   * The orchestrator's `resolveGrokSession` decides an id AND whether to
   * resume it as one inseparable unit (a mode change since the session was
   * created forces a fresh id rather than a resume — see D5), so this field
   * bundles both rather than reusing the claude-code-style split across
   * `sessionId`/`resumeSessionId`, which would let a caller send a mismatched
   * pair (e.g. an id with no resume flag, or vice versa) undetected.
   *
   *   - `resume: false` → NEW session: `-s <id>` PLUS the mode's `--sandbox`
   *     flag (`read-only` for `ask`, `off` for `auto`).
   *   - `resume: true`  → RESUME: `--resume <id>` and NO `--sandbox` flag at
   *     all — grok hard-errors (exit 1) if an explicit `--sandbox` differs
   *     from the session's stored profile, so omitting it lets the CLI
   *     silently inherit whatever profile the session started with.
   *
   * Required for a grok spawn — `buildCommand` throws if `harness.kind ===
   * "grok"` and this is missing. Ignored by claude-code and codex.
   */
  grokSession?: { id: string; resume: boolean } | null;
  /**
   * Task-scoped dedup set for grok's `updates.jsonl` tailer — the SAME `Set`
   * instance `runs.seenLineUuidsForTask(taskId)` (db.ts) produces for
   * reattach. `GrokLaunchOptions.seenLineUuids` (grok-tmux.ts) is a
   * *required* field: `updates.jsonl` is a per-SESSION file spanning every
   * turn and is always tailed from offset 0, so without a task-scoped set a
   * fresh turn would re-emit every earlier turn's already-persisted
   * tool_call/plan lines as new chunks under the new run id. Only meaningful
   * for `harness.kind === "grok"`; ignored by claude-code and codex. Rides
   * on `AgentRunOptions` rather than `SpawnAgentArgs` directly because both
   * `buildCommand`-adjacent grok state (`grokSession`) and this dedup set are
   * decided together by the orchestrator's grok call sites and threaded
   * through the same `opts` object.
   */
  seenLineUuids?: Set<string>;
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
  "sonnet-5": "claude-sonnet-5",
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

  // Explicit per-kind dispatch (D10) — a fourth kind added later without a
  // matching branch here throws instead of silently resolving to whichever
  // kind happened to sit in an `else`.
  if (harness.kind === "claude-code") {
    if (process.env.AGETOR_CLAUDE_BIN) return process.env.AGETOR_CLAUDE_BIN;
    return Bun.which("claude", { PATH: process.env.PATH }) ?? "claude";
  }
  if (harness.kind === "codex") {
    if (process.env.AGETOR_CODEX_BIN) return process.env.AGETOR_CODEX_BIN;
    return Bun.which("codex", { PATH: process.env.PATH }) ?? "codex";
  }
  if (harness.kind === "grok") {
    if (process.env.AGETOR_GROK_BIN) return process.env.AGETOR_GROK_BIN;
    return Bun.which("grok", { PATH: process.env.PATH }) ?? "grok";
  }
  const exhaustive: never = harness.kind;
  throw new Error(`resolveBin: unknown harness kind: ${exhaustive}`);
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
    //
    // grok doesn't use the macOS keychain either (see the `Harness.home`
    // docstring in shared/types.ts), so re-homing it is safe; it gets its own
    // GROK_HOME var (mirroring CODEX_HOME) rather than HOME — grok has no
    // documented HOME-relative config path the way codex's CLI does.
    if (harness.kind === "claude-code") {
      env.CLAUDE_CONFIG_DIR = harness.home;
    } else if (harness.kind === "codex") {
      env.HOME = harness.home;
      env.CODEX_HOME = path.join(harness.home, ".codex");
    } else if (harness.kind === "grok") {
      env.GROK_HOME = harness.home;
    } else {
      const exhaustive: never = harness.kind;
      throw new Error(`harnessEnv: unknown harness kind: ${exhaustive}`);
    }
  }

  // D1 (docs/plans/grok-privacy-defaults.md): grok's always-on trace-upload
  // pipeline ships per-turn session artifacts (incl. session logs; a tracked
  // `.env` FILE is not skip-listed) to a GCS bucket, and xAI can flip
  // telemetry on REMOTELY per account via server-pushed settings — so
  // disabling it once in the harness's `env` config isn't durable. Grok's own
  // flag resolver ranks precedence `requirement > cli > env > config >
  // managed > remote > default` (xai-grok-config-types/src/flags.rs), so an
  // env var beats both the user's saved config AND a future remote push. The
  // sandbox can't help either — in-process HTTP is deliberately exempt from
  // `restrict_network` — so env is the only reliable per-spawn control.
  // `GROK_STORAGE_MODE=local` additionally blocks the session writeback sync
  // a server flag can silently re-enable. Set BEFORE the harness's own `env`
  // map below so an explicit user override (someone who consciously wants
  // xAI telemetry back on) still wins.
  if (harness.kind === "grok") {
    env.GROK_TELEMETRY_ENABLED = "0";
    env.GROK_TELEMETRY_TRACE_UPLOAD = "0";
    env.GROK_STORAGE_MODE = "local";
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
    //
    // Above CLAUDE_PROMPT_ARGV_MAX_BYTES, embedding the prompt here blows
    // tmux's client-command cap and `tmux new-session` fails outright with
    // `command too long` before claude ever starts — worse than the
    // unknown-option case above, since there's no session at all to inspect.
    // Skip the argv entirely and hand the raw prompt back as
    // `deferredPrompt`; `spawnAgent` forwards it to `spawnClaudeViaTmux`,
    // which pastes it in once claude's composer is up.
    let deferredPrompt: string | undefined;
    if (prompt) {
      if (Buffer.byteLength(prompt, "utf8") > CLAUDE_PROMPT_ARGV_MAX_BYTES) {
        deferredPrompt = prompt;
      } else {
        args.push("--", prompt);
      }
    }

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

    return { cmd: args, env: Object.keys(env).length ? env : undefined, deferredPrompt };
  }

  // codex — hosted in tmux via codex-tmux.ts. The prompt is NOT an argv
  // element: it's delivered on stdin (the trailing `-`), so the driver can
  // pipe a prompt file in and no user text touches the shell wrapper.
  if (harness.kind === "codex") {
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
  // Sandbox policy. `ask` → `read-only` (can't change anything). `auto` →
  // `workspace-write` (edit the cwd without approval prompts) for the common
  // case, BUT escalated to `danger-full-access` when the task's git writes have
  // to land OUTSIDE the cwd: a linked worktree's `.git` is a file pointing at
  // the source repo's shared `.git`, where a commit's objects/refs go, and
  // `workspace-write` only makes the cwd writable — so `git commit` is blocked.
  // Granting the external dir via `sandbox_workspace_write.writable_roots` is
  // unreliable (codex keeps `.git` read-only under some workspace policies), so
  // for those runs we drop the sandbox entirely. That's consistent with
  // agetor's no-sandbox philosophy (CLAUDE.md: "Agents run with the user's full
  // shell privileges … There is no sandbox") and with claude-code's `auto` mode
  // (`--dangerously-skip-permissions`). `approval_policy=never` pairs with full
  // access so a headless `codex exec` never stalls on an approval it can't show
  // — the empirically-validated combo for full filesystem access. Parent flags
  // must precede the `resume` subcommand, so emit here.
  const needsExternalGitWrites = (opts.codexExternalGitDirs?.length ?? 0) > 0;
  if (mode !== "auto") {
    args.push("--sandbox", "read-only");
  } else if (needsExternalGitWrites) {
    args.push("--sandbox", "danger-full-access", "-c", "approval_policy=never");
  } else {
    args.push("--sandbox", "workspace-write");
  }

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

  // grok — hosted in tmux via grok-tmux.ts. This argv EXCLUDES `-p`,
  // `--prompt-file`, and the prompt itself: grok's `-p` takes an argument
  // (not stdin like codex's trailing `-`), so embedding raw prompt text into
  // shell-quoted argv is quoting hell. `spawnGrokViaTmux` instead writes the
  // prompt to a per-run file and splices `--prompt-file <path>` in right
  // before the output redirect — see grok-tmux.ts's `GrokLaunchOptions.argv`
  // doc comment and its file header.
  if (harness.kind === "grok") {
    const extra = (process.env.AGETOR_GROK_ARGS ?? "").split(/\s+/).filter(Boolean);

    const args: string[] = [bin, "--output-format", "streaming-json"];

    if (!opts.model) {
      throw new Error("model is required for grok");
    }
    // Unknown model ids pass through verbatim (repo convention) — grok's `-m`
    // takes friendly ids as-is, same as codex's `--model`.
    args.push("-m", opts.model);

    // Mode → permission-mode (D3, docs/plans/grok-build-oss-alignment.md).
    // `auto` — and null/unknown ids, mirroring the claude-code/codex
    // `mode ?? "auto"` convention — gets `--permission-mode bypassPermissions`
    // (full auto, agetor's no-sandbox-escalation-needed philosophy — see the
    // sandbox block below). `ask` gets NO permission-mode flag at all: source
    // review of `xai-grok-shell/src/util/config/permissions.rs:225-239`
    // confirms `--permission-mode dontAsk` parses but is wired to nothing —
    // only `bypassPermissions`/`always-approve`/`auto` are recognized — so
    // emitting it was dead weight. `ask`'s read-only sandbox (below) already
    // guarantees there's nothing mutating for grok to need approval on, and
    // headless grok's default mode auto-cancels any prompt it can't surface
    // (reported back to the model, never a hang), so dropping the flag changes
    // no runtime behavior.
    const mode = opts.mode ?? "auto";
    if (mode !== "ask") {
      args.push("--permission-mode", "bypassPermissions");
    }

    args.push(...extra);

    // Session flags (D4/D5) — see `AgentRunOptions.grokSession`'s doc comment
    // for the full contract. grok's `-s` is new-session-only and `--resume`
    // is resume-only — mutually exclusive. A NEW session ALSO gets the
    // mode's `--sandbox` flag; a RESUMED session gets NO `--sandbox` flag at
    // all, because the CLI hard-errors (exit 1) if an explicit `--sandbox`
    // differs from the session's stored profile (`cli.rs:853-867` —
    // `(None, saved) => Apply(saved)`, so omitting the flag structurally
    // cannot conflict). Detecting "did the mode change since this session was
    // created" is the *caller's* job (orchestrator's `resolveGrokSession`,
    // D5) — by the time `grokSession` reaches here, `resume` has already
    // been decided.
    if (!opts.grokSession) {
      throw new Error("grokSession is required for grok");
    }
    if (opts.grokSession.resume) {
      args.push("--resume", opts.grokSession.id);
    } else {
      args.push("-s", opts.grokSession.id);
      args.push("--sandbox", mode === "ask" ? "read-only" : "off");
    }

    // Effort (D6): grok-build's MODEL_EFFORT_SUPPORT entry is non-empty
    // (`low`..`max`, source-confirmed `Effort::VALID_VALUES`). Unknown ids
    // pass through verbatim (same convention as `-m` above); `buildCommand`
    // does not itself validate against the canonical set. A null effort
    // falls back to DEFAULT_EFFORT rather than throwing: grok task rows
    // created while MODEL_EFFORT_SUPPORT.grok was empty were persisted with
    // effort = null, and there's no migration backfilling them — throwing
    // would brick those tasks' next start.
    if (!modelDeclinesEffort("grok", opts.model)) {
      const effort = opts.effort ?? DEFAULT_EFFORT.grok;
      if (effort) args.push("--effort", effort);
    }

    return { cmd: args, env: Object.keys(env).length ? env : undefined };
  }

  const exhaustive: never = harness.kind;
  throw new Error(`buildCommand: unknown harness kind: ${exhaustive}`);
}

/**
 * Build the codex argv for a specific `cwd`, resolving the cwd-dependent
 * `codexExternalGitDirs` (the source repo's `.git` for a linked worktree) so
 * `buildCommand` can decide whether to escalate the sandbox to full access. This
 * is the seam `spawnAgent` uses — kept separate from the pure `buildCommand` so
 * the cwd→sandbox wiring is unit-testable without standing up tmux.
 */
export function buildCodexCommand(
  harness: Harness,
  prompt: string,
  opts: AgentRunOptions,
  cwd: string,
): AgentCommand {
  return buildCommand(harness, prompt, {
    ...opts,
    codexExternalGitDirs: gitWritableRootsSync(cwd),
  });
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
  } else if (process.env.AGETOR_FAKE_CLAUDE_SESSION_DIED === "1") {
    // Test hook: simulate the tmux session dying mid-turn. Mirrors what the
    // real drivers emit from their death watch — the `SESSION_DIED_STATUS_PREFIX`
    // sentinel status chunk that makeChunkHandler pattern-matches to flip the
    // column to `blocked`, then resolves the turn with code 0 (the handle
    // `sessionDied` flag, not the exit code, drives the failed/blocked outcome).
    // Optional resolve delay lets cancellation-precedence tests fire cancelRun
    // between the column flip and the done resolution.
    const resolveDelayMs = Number(process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS ?? 5) || 5;
    setTimeout(() => {
      onChunk("status", `${SESSION_DIED_STATUS_PREFIX}tmux session agetor-fake ended unexpectedly — task blocked`);
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
      deferredPrompt: built.deferredPrompt,
    });
  }

  // codex — hosted in a per-task tmux session via codex-tmux.ts (so a mid-turn
  // run survives an agetor restart and is reattachable), streaming structured
  // events by tailing codex's `--json` log.
  if (harness.kind === "codex") {
    if (process.env.AGETOR_CODEX_DRIVER === "fake") {
      buildCommand(harness, prompt, opts);
      // Hand the orchestrator a thread id so it persists `codex_session_id` and
      // can route follow-ups through `codex exec resume` — mirrors what a real
      // `thread.started` event would deliver.
      onSessionId?.(`fake-codex-thread-${taskId}`);
      return makeFakeAgent(taskId, prompt, onChunk);
    }
    // Resolve git dirs outside the cwd (the source repo's `.git` for a linked
    // worktree) so a codex `auto` run that has to write there escalates its
    // sandbox to full access. Computed here — the single choke point every codex
    // spawn path funnels through — rather than at each orchestrator call site.
    // No-op for an ordinary checkout or a non-git cwd, so the argv is unchanged
    // there. `buildCodexCommand` is the testable seam for this wiring.
    const built = buildCodexCommand(harness, prompt, opts, cwd);
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

  // grok — hosted in a per-task tmux session via grok-tmux.ts, same
  // restart-survival rationale as codex. No cwd-based sandbox escalation is
  // needed (D4: `auto` already runs with no sandbox at all), so unlike codex
  // this dispatches straight to `buildCommand` with no cwd-dependent seam.
  if (harness.kind === "grok") {
    // Resolved session id for THIS turn (D4/D5): the orchestrator's
    // `opts.grokSession` is expected to always be set (its `.id` is either a
    // freshly-minted uuid for a new session or the id being resumed — see
    // `AgentRunOptions.grokSession`'s doc comment). The `crypto.randomUUID()`
    // fallback only guards a caller that hasn't been updated to pass it yet,
    // mirroring the claude-code branch's own generate-if-absent pattern
    // above; a fallback-generated id is treated as a fresh (non-resumed) one.
    const sessionId = opts.grokSession?.id ?? crypto.randomUUID();
    // GrokLaunchOptions.seenLineUuids is required; fall back to a fresh Set
    // (no cross-turn dedup) rather than throwing if the caller omitted it —
    // see AgentRunOptions.seenLineUuids's doc comment.
    const dedup = opts.seenLineUuids ?? new Set<string>();
    const grokSession = opts.grokSession ?? { id: sessionId, resume: false };
    if (process.env.AGETOR_GROK_DRIVER === "fake") {
      buildCommand(harness, prompt, { ...opts, grokSession });
      // Echo the PROVIDED session id (D4: the orchestrator generates and
      // pre-seeds it now) as confirmation/repair — same role a real `end`
      // event's sessionId plays — rather than synthesizing our own
      // `fake-grok-session-<taskId>` id as before.
      onSessionId?.(sessionId);
      return makeFakeAgent(taskId, prompt, onChunk);
    }
    const built = buildCommand(harness, prompt, { ...opts, grokSession });
    return spawnGrokViaTmux({
      taskId,
      runId,
      argv: built.cmd,
      env: built.env ?? {},
      cwd,
      promptText: prompt,
      onChunk,
      onSessionId,
      sessionId,
      seenLineUuids: dedup,
    });
  }

  const exhaustive: never = harness.kind;
  throw new Error(`spawnAgent: unknown harness kind: ${exhaustive}`);
}

