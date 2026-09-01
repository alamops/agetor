import path from "node:path";import { cursorModelArg, FX_PROVIDER_STATUS_PREFIX, MODEL_EFFORT_SUPPORT, SESSION_DIED_STATUS_PREFIX, type AgentKind, type Harness } from "../shared/types.ts";
import { GEMINI_PROMPT_ARGV_MAX_BYTES } from "../shared/prompt-limits.ts";
import { settleSubagentById } from "./claude-subagents.ts";
import {
  CLAUDE_API_ERROR_STATUS_PREFIX,
  CLAUDE_UNKNOWN_COMMAND_STATUS_PREFIX,
  spawnClaudeViaTmux,
  toClaudeModeString,
  type ChunkHandler,
  type SpawnedAgent,
} from "./claude-tmux.ts";
import { spawnCodexViaTmux } from "./codex-tmux.ts";
import { spawnCursorViaTmux } from "./cursor-tmux.ts";import { dataDir, subagents as subagentsDb } from "./db.ts";
import { spawnFxViaAcp, type FxMode } from "./fx-acp.ts";
import { spawnGeminiViaTmux } from "./gemini-tmux.ts";
import { answerFxPermission, registerFxPermission } from "./interactions.ts";
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

/**
 * Same tmux-imsg-cap constraint as {@link CLAUDE_PROMPT_ARGV_MAX_BYTES}
 * (gemini is also hosted in a detached tmux session — see gemini-tmux.ts),
 * but gemini has no deferred-paste fallback: unlike claude's persistent REPL,
 * gemini's tmux session is one-shot (dies at end of turn), so there's no
 * live composer to paste an oversized prompt into after launch the way
 * `deferredPrompt` does for claude. `buildCommand` throws above this budget
 * instead of silently mis-delivering a truncated prompt.
 *
 * Gemini's `--help` notes `-p`'s value is "Appended to input on stdin (if
 * any)", which suggests a stdin-based large-prompt path might exist (mirror
 * codex's stdin delivery, avoiding the argv cap entirely) — but this was
 * unverified as of this cap's introduction (the live API was returning 503s
 * during the spike that would have confirmed it). Follow up and remove this
 * cap in favor of stdin delivery once confirmed; until then, fail loudly
 * rather than guess at unverified CLI behavior.
 *
 * Lives in `src/shared/prompt-limits.ts` (the webview/CLI need it too, to
 * pre-check an issue-task prompt before ever calling createTask) and is
 * re-exported here so existing importers of `./agents.ts` keep resolving.
 */
export { GEMINI_PROMPT_ARGV_MAX_BYTES } from "../shared/prompt-limits.ts";

export interface AgentRunOptions {
  /** Friendly mode id; see AGENT_OPTIONS in shared/types.ts. */
  mode?: string | null;
  /** Friendly model id; see AGENT_OPTIONS in shared/types.ts. */
  model?: string | null;
  /** Friendly reasoning-effort id (codex: minimal|low|medium|high). */
  effort?: string | null;
  /** Fast model variant toggle. Currently consumed by cursor only. */
  fast?: boolean | null;
  /** Cursor Max Mode / large-context toggle. Currently consumed by cursor only. */
  maxMode?: boolean | null;
  /**
   * Existing session id to resume a prior conversation on a follow-up turn.
   * For claude-code: the JSONL session uuid, resumed via `claude --resume
   * <id>`. For codex: the `thread_id`, resumed via `codex exec resume <id>`.
   * For fx: fx's own ACP session id (DISCOVERED from `session/new`'s
   * response on the first turn, not pre-generated — see `onSessionId` on
   * `SpawnAgentArgs`), resumed via the ACP `session/resume` request (falling
   * back to `session/load` on a resume error — see fx-acp.ts). Either way
   * the new prompt attaches to the full prior conversation instead of
   * starting fresh.
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
   * The run row id, threaded into `buildCommand` ONLY for fx: fx's argv
   * embeds a deterministic `--log-file <dataDir>/fx-logs/<runId>.log` path
   * (fx owns and writes that log itself — see fx-acp.ts's header — this just
   * gives it somewhere to open). Every other kind ignores this field; codex
   * and cursor instead take a `runId` directly as a `spawnAgent`/tmux-driver
   * argument for the same per-turn log/prompt-file purpose, since their
   * per-kind command-building functions (`buildCodexCommand`) already have a
   * dedicated seam for cwd/run-scoped values. fx's is simpler (no fs calls
   * needed to resolve it) so it rides directly in `AgentRunOptions` instead
   * of getting its own `buildFxCommand` wrapper.
   */
  runId?: string | null;
}

// Map friendly model ids to the exact strings the claude-code CLI expects.
// Unknown ids are passed through verbatim (so a user can type a model the
// curated list doesn't know about yet). Codex accepts the friendly ids as-is
// so it doesn't need a translation table.
const CLAUDE_MODEL_FLAG: Record<string, string> = {
  "mythos-5.1": "claude-mythos-5-1",
  "fable-5.1": "claude-fable-5-1",
  "mythos-5": "claude-mythos-5",
  "fable-5": "claude-fable-5",
  "opus-5": "claude-opus-5",
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
 * Inverse of `toClaudeModelArg`/`CLAUDE_MODEL_FLAG`: given a `/model <arg>`
 * argument as claude itself would echo it back (or as agetor's own dropdown
 * mirror sent it — see `reconcileTaskSession`), resolve it to the agetor
 * model id whose flag matches exactly. Falls back to the arg itself when it
 * already looks like a raw claude model id (`claude-…`), so a future
 * curated id "just works" before `CLAUDE_MODEL_FLAG` catches up.
 *
 * Deliberately does NOT resolve claude's own aliases (`sonnet`, `opus`,
 * `default`, …) — those map many-to-one onto a model family and can't be
 * inverted losslessly from the arg alone. Callers that need to resolve an
 * alias must fall back to the `<local-command-stdout>` display name instead
 * (see `claudeModelIdFromDisplayName` in `claude-local-setting.ts`).
 */
export function claudeModelIdFromArg(arg: string): string | null {
  for (const [id, flag] of Object.entries(CLAUDE_MODEL_FLAG)) {
    if (flag === arg) return id;
  }
  return /^claude-/.test(arg) ? arg : null;
}

/**
 * Map an agetor claude-code model id to the model-FAMILY label the 2.1.246
 * `/model` picker's UI actually offers as a selectable row (`Opus`, `Sonnet`,
 * `Fable`, `Haiku`) — smoke-tested on claude 2.1.246
 * (docs/plans/model-effort-local-command-turns.md §10, owner decision 2).
 * The picker is coarser than `CLAUDE_MODEL_FLAG`: it offers one row per
 * family, always resolving to that family's CURRENT release, not every
 * versioned id agetor tracks. An id whose family row would therefore land on
 * a DIFFERENT specific version than the one just requested — `opus-4.8`,
 * `opus-4.7`, `opus-4.6`, `sonnet-4.6` (all superseded within their family by
 * a newer pinned id) — is deliberately mapped to `null` rather than the
 * nearest family, so the live-session mirror is skipped instead of silently
 * switching the session to a different version than the task row now holds.
 * Fable follows the same current-release convention as Opus: `fable-5.1`
 * owns the "Fable" row since the installed claude CLI (2.1.257) ships the
 * `claude-fable-5-1` model id, so the now-superseded `fable-5` maps to `null`
 * (next-run-only, same as any other superseded pinned id). `mythos-5` and
 * `mythos-5.1` both have no picker row at all — claude's picker has no
 * Mythos row of any kind. An unknown/future raw id also returns `null`
 * rather than guess. Sole caller: `reconcileTaskSession`'s model mirror
 * (`orchestrator.ts`), which feeds the result to `mirrorModelViaPicker`
 * (`claude-tmux.ts`).
 */
export function claudeModelPickerFamily(id: string): "Opus" | "Sonnet" | "Fable" | "Haiku" | null {
  switch (id) {
    case "opus-5":
      return "Opus";
    case "sonnet-5":
      return "Sonnet";
    case "fable-5.1":
      return "Fable";
    case "haiku-4.5":
      return "Haiku";
    default:
      return null;
  }
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
  let fallback: string;
  let override: string | undefined;
  switch (harness.kind) {
    case "claude-code":
      fallback = "claude";
      override = process.env.AGETOR_CLAUDE_BIN;
      break;
    case "codex":
      fallback = "codex";
      override = process.env.AGETOR_CODEX_BIN;
      break;
    case "cursor":
      fallback = "cursor-agent";
      override = process.env.AGETOR_CURSOR_BIN;
      break;
    case "gemini":
      fallback = "gemini";
      override = process.env.AGETOR_GEMINI_BIN;
      break;
    case "fx":
      fallback = "fx";
      override = process.env.AGETOR_FX_BIN;
      break;
  }
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
    //
    // Cursor has no documented dedicated config-dir env var, so isolating an
    // additional account means a true HOME override (like codex's HOME half,
    // but with no CODEX_HOME-equivalent to also set — cursor-agent reads its
    // login/config straight out of $HOME).
    if (harness.kind === "claude-code") {
      env.CLAUDE_CONFIG_DIR = harness.home;
    } else if (harness.kind === "codex") {
      env.HOME = harness.home;
      env.CODEX_HOME = path.join(harness.home, ".codex");
    } else if (harness.kind === "cursor") {
      env.HOME = harness.home;
    } else if (harness.kind === "fx") {
      // fx has no dedicated config-dir env var (verified against binary
      // v0.0.4 — no FX_HOME or FX_CONFIG_DIR in its strings); its state
      // lives hardcoded at `~/.fx/*`, so isolating an additional account's
      // login/config means a true HOME override, same approach as cursor's
      // branch above.
      env.HOME = harness.home;
    } else {
      // gemini: GEMINI_CLI_HOME is a dedicated home-override env var (verified
      // in the bundled CLI source — `homedir()` returns
      // `process.env.GEMINI_CLI_HOME || os.homedir()`, and every gemini state
      // dir hangs off that), so unlike codex there's no need to also touch
      // the real HOME.
      env.GEMINI_CLI_HOME = harness.home;
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
    } else {
      // `ask` must be EXPLICIT: omitting the flag inherits the user-level
      // `defaultMode` (e.g. `auto` in ~/.claude/settings.json), silently
      // running the task in a looser mode than the one stored on it.
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

  if (harness.kind === "cursor") {
    // cursor — hosted in tmux via cursor-tmux.ts, one-shot turn per
    // invocation exactly like codex. The prompt is NOT an argv element here:
    // cursor-tmux.ts's spawnCursorViaTmux appends it as the final positional
    // argv element at spawn time via its own injection-safe quoting pattern
    // (stdin-prompt support is unverified for cursor-agent, unlike codex).
    const extra = (process.env.AGETOR_CURSOR_ARGS ?? "").split(/\s+/).filter(Boolean);

    const args: string[] = [bin, "-p", "--output-format", "stream-json"];

    if (!opts.model) {
      throw new Error("model is required for cursor");
    }
    // Cursor exposes thinking level and Fast as model variants. Curated base
    // model ids are composed here; unknown/discovered ids pass through.
    args.push("--model", cursorModelArg(opts.model, opts.effort ?? null, opts.fast === true, opts.maxMode === true));

    // Mode → auto-execute posture. `auto` (also the null default, per house
    // convention) runs with --force --sandbox disabled so cursor executes
    // edits/commands without approval prompts — same "no sandbox"
    // philosophy as claude's --dangerously-skip-permissions and codex's
    // danger-full-access escalation. `ask` emits neither flag: cursor-agent
    // -p cannot execute unapproved actions headlessly, so this is a
    // propose-only run. No gitWritableRootsSync escalation is needed here
    // (plan §3.4) — auto never runs sandboxed for cursor in the first place.
    const mode = opts.mode ?? "auto";
    if (mode === "auto") {
      args.push("--force", "--sandbox", "disabled");
    }

    args.push(...extra);

    // Multi-turn continuity: cursor's --resume is a FLAG (unlike codex's
    // `resume <thread_id>` subcommand), so there's no subcommand-ordering
    // constraint — it can sit anywhere in the argv. Kept here, after the
    // mode flags, for visual parity with codex's flags-then-resume shape.
    if (opts.resumeSessionId) {
      args.push("--resume", opts.resumeSessionId);
    }

    return { cmd: args, env: Object.keys(env).length ? env : undefined };
  }

  if (harness.kind === "gemini") {
    const extra = (process.env.AGETOR_GEMINI_ARGS ?? "").split(/\s+/).filter(Boolean);
    const args: string[] = [bin];

    if (!opts.model) {
      throw new Error("model is required for gemini");
    }
    args.push("-m", opts.model);

    // Structured streaming: `--output-format stream-json` emits NDJSON
    // events on stdout (tailed by the driver, same shape claude/codex use).
    args.push("--output-format", "stream-json");

    // Session flow mirrors claude's pre-generated-uuid pattern (see
    // AgentRunOptions.sessionId doc): agetor self-issues the uuid via
    // `--session-id` on the first turn; every follow-up passes the SAME
    // uuid back via `--resume` — verified empirically (`--resume <uuid> -p
    // "..."` correctly recalled context established under `--session-id
    // <uuid>` on a prior turn). Mutually exclusive, like claude.
    if (opts.resumeSessionId) {
      args.push("--resume", opts.resumeSessionId);
    } else if (opts.sessionId) {
      args.push("--session-id", opts.sessionId);
    }

    // Approval posture. `auto` → `--yolo` (verified: auto-approves every
    // tool call). `ask` → `--approval-mode plan` (verified real read-only
    // mode — closer to claude's native `plan` than codex's read-only-sandbox
    // stand-in, since gemini has no sandbox at all). `--skip-trust` is
    // mandatory for BOTH: gemini's headless mode refuses to run tool calls
    // in an untrusted directory (exit 55) even under `--yolo` — verified —
    // and every agetor task runs in a fresh worktree path that's inherently
    // untrusted on first run.
    const mode = opts.mode ?? "auto";
    if (mode === "auto") {
      args.push("--yolo");
    } else {
      args.push("--approval-mode", "plan");
    }
    args.push("--skip-trust");

    args.push(...extra);

    // Gemini has no per-invocation effort/thinking-budget flag at all
    // (verified via `gemini --help`) — unlike claude/codex this isn't
    // model-specific, so `opts.effort` is intentionally ignored here rather
    // than routed through `modelDeclinesEffort` (which would throw for any
    // gemini model id absent from `MODEL_EFFORT_SUPPORT.gemini`, e.g. a
    // user-typed future model — see `DEFAULT_EFFORT.gemini` comment in
    // shared/types.ts).

    // Prompt rides in argv (`-p <prompt>`) — no confirmed stdin-only
    // delivery path exists yet (see GEMINI_PROMPT_ARGV_MAX_BYTES). Gemini's
    // one-shot tmux launch has no deferred-paste fallback the way claude's
    // persistent REPL does, so fail loudly above the safe budget instead of
    // silently mis-delivering a truncated prompt.
    if (!prompt) {
      throw new Error("prompt is required for gemini");
    }
    if (Buffer.byteLength(prompt, "utf8") > GEMINI_PROMPT_ARGV_MAX_BYTES) {
      throw new Error(
        `prompt exceeds ${GEMINI_PROMPT_ARGV_MAX_BYTES} bytes — gemini's one-shot tmux launch has no `
          + `deferred-paste fallback for an oversized prompt (see GEMINI_PROMPT_ARGV_MAX_BYTES)`,
      );
    }
    args.push("-p", prompt);

    return { cmd: args, env: Object.keys(env).length ? env : undefined };
  }

  if (harness.kind === "fx") {
    // fx — driven over ACP/stdio via fx-acp.ts, no tmux involved at all (see
    // that file's header). The prompt is NOT an argv element: it rides over
    // the `session/prompt` JSON-RPC call the driver issues after the
    // handshake, so unlike claude/gemini there's no tmux-imsg-cap-style
    // argv-size budget to enforce here.
    const extra = (process.env.AGETOR_FX_ARGS ?? "").split(/\s+/).filter(Boolean);

    if (!opts.model) {
      throw new Error("model is required for fx");
    }
    if (!opts.runId) {
      throw new Error("runId is required for fx (used to build the --log-file path)");
    }

    // fx owns and writes its own `--log-file` for its own troubleshooting —
    // agetor never reads it (fx-acp.ts's `ensureLogDirForArgv` only makes
    // sure the parent dir exists so `fx acp` doesn't fail to open it). This
    // is the seam `FxLaunchOptions.argv` documents: buildCommand emits the
    // full argv, `--log-file` already filled in; the driver appends nothing.
    const logFile = path.join(dataDir, "fx-logs", `${opts.runId}.log`);

    const args: string[] = [bin, "acp", "--model", opts.model, "--log-file", logFile, ...extra];

    // Permission posture rides as an env var, not an argv flag — mirrors the
    // FX_PERMISSION_MODE contract FxLaunchOptions.env documents. `auto`
    // (also the null default, per house convention) and `ask` map straight
    // through since fx's own mode ids already match agetor's; any other
    // (future/unknown) mode id passes through verbatim, same convention as
    // every other kind's unknown-model/mode passthrough in this file.
    const mode = opts.mode ?? "auto";
    env.FX_PERMISSION_MODE = mode;

    // fx has no per-invocation effort/reasoning flag — its models route
    // through the Vercel AI Gateway verbatim, with no CLI-level effort knob
    // (mirrors gemini's silent-ignore of opts.effort above, not codex's
    // required-effort throw).

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

/**
 * Alternate trigger for the `AGETOR_FAKE_CLAUDE_TODOS` scenario (see
 * `makeFakeAgent` below): a substring in the *prompt* rather than an env var.
 * Env-var scenario selection is fixed for the whole process — every task the
 * fake driver spawns for gets the same behavior — which is fine for unit
 * tests (`beforeAll` sets the var per file) but doesn't compose with the e2e
 * suite's worker-scoped backend fixture (`e2e/fixtures.ts`), which spawns one
 * `headless.ts` per worker with a fixed env block shared by every test/task
 * in that worker. A spec can't get its own env var into that already-running
 * process, but it CAN put anything it wants in `task.prompt` at task-create
 * time — so this marker is the e2e-reachable equivalent of the env gate,
 * exported so `e2e/todo-progress.spec.ts` can reference the exact string
 * instead of duplicating it.
 */
export const FAKE_CLAUDE_TODOS_PROMPT_MARKER = "__agetor_fake_claude_todos__";

/** * Prompt-marker trigger for the `fx_permission` card scenario (see
 * `makeFakeAgent` below), same rationale as `FAKE_CLAUDE_TODOS_PROMPT_MARKER`
 * above: the e2e suite's worker-scoped backend fixture spawns one
 * `headless.ts` per worker with a single fixed env block shared by every
 * test/task in that worker, so a spec can't get its own env var into that
 * already-running process — but it CAN put anything it wants in
 * `task.prompt` at task-create time. Exported so an fx-permission e2e spec
 * can reference the exact string instead of duplicating it.
 */
export const FAKE_FX_PERMISSION_PROMPT_MARKER = "__agetor_fake_fx_permission__";
/**
 * Same prompt-marker trick as {@link FAKE_CLAUDE_TODOS_PROMPT_MARKER}, for the
 * "Claude Code Monitor" scenario (see
 * `docs/plans/claude-code-monitors-hold-running.md`): drives the real "held
 * in `running` by a live monitor, released when it ends" flow through
 * `orchestrator.ts`'s DB-derived hold predicate (`subagents.hasRunning`)
 * without a real Claude CLI. The real driver discovers a monitor's two-line
 * launch (`tool_use` name `"Monitor"` + its `tool_result` stub, both tailed
 * from the session JSONL by `claude-subagents.ts`'s
 * `scanLineForMonitorLaunch`/`scanLineForMonitorStub`) and its terminal event
 * the same way — but this fake driver emits chunks only, writes no JSONL, and
 * attaches no `claude-subagents.ts` watcher, so the scenario below inserts
 * and later settles the `subagents` row itself, directly, matching the shape
 * the real scan would produce.
 *
 * Optional `:<ms>` suffix sets how long the monitor stays "running" before it
 * settles — e.g. `__agetor_fake_claude_monitor__:1500` settles 1.5s after
 * arming. Defaults to {@link FAKE_CLAUDE_MONITOR_DEFAULT_SETTLE_MS} (4000);
 * clamped to a floor of {@link FAKE_CLAUDE_MONITOR_MIN_SETTLE_MS} (50) so a
 * caller can't race the settle ahead of the +12ms turn-resolution chunk.
 *
 * Exported (like the TODOS marker) so `e2e/monitor-hold.spec.ts` can drive
 * this scenario from a task's prompt — the e2e worker-shared backend fixture
 * (`e2e/fixtures.ts`) can't set per-test env vars, only per-test prompt text.
 * Per that same constraint, e2e specs can't `import` from `src/bun/*` and
 * must keep a **literal copy** of this exact string.
 */
export const FAKE_CLAUDE_MONITOR_PROMPT_MARKER = "__agetor_fake_claude_monitor__";
/** No regex-special characters appear in {@link FAKE_CLAUDE_MONITOR_PROMPT_MARKER}
 *  (letters/underscores only), so it's safe to splice directly into a pattern
 *  without escaping. */
const FAKE_CLAUDE_MONITOR_SETTLE_MS_RE = new RegExp(`${FAKE_CLAUDE_MONITOR_PROMPT_MARKER}:(\\d+)`);
const FAKE_CLAUDE_MONITOR_DEFAULT_SETTLE_MS = 4000;
const FAKE_CLAUDE_MONITOR_MIN_SETTLE_MS = 50;
function makeFakeAgent(
  taskId: string,
  prompt: string,
  onChunk: ChunkHandler,
  fakeOpts: { runId?: string; mode?: string; kind?: AgentKind } = {},
): SpawnedAgent {  const record: string[] = [`spawn:${prompt}`];
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((res) => { resolveDone = res; });
  // Every setTimeout this fake schedules is tracked here so `kill()` can
  // clear them all — otherwise a chunk fires after the run/task row it
  // targets has been deleted (e.g. a test that deletes a task immediately
  // after starting it), and `runs.appendEvent` throws an unhandled
  // `SQLITE_CONSTRAINT_FOREIGNKEY` against the cascade-deleted row.
  const timers: ReturnType<typeof setTimeout>[] = [];
  const after = (ms: number, fn: () => void) => { timers.push(setTimeout(fn, ms)); };
  // Set only by the AGETOR_FAKE_FX_PERMISSION scenario below — `kill()`
  // needs it to settle a still-open card the same way `dropFxSession` →
  // `settleFx` does in the real driver (see interactions.ts's "Settlement
  // single-source-of-truth"), so Stop/delete during the fake card doesn't
  // leave a phantom registry entry.
  let fxPermissionCardId: string | undefined;
  // Set by `kill()` before it settles `done` itself. The fx-permission
  // scenario's `answer.then` callback below checks this so it never emits
  // chunks or re-resolves `done` after `kill()` has already torn everything
  // down (a still-pending `answer` promise can resolve asynchronously after
  // `kill()` returns, since `answerFxPermission` there just settles the
  // registry entry — it doesn't synchronously flush this driver's `.then`).
  let killed = false;
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
    after(5, () => {
      onChunk("assistant", "API Error: 529 Overloaded. This is a server-side issue, usually temporary.");
      onChunk("status", `${CLAUDE_API_ERROR_STATUS_PREFIX}HTTP 529 — turn aborted; blocked for manual retry`);
    });
    after(resolveDelayMs, () => { resolveDone(0); });
  } else if (process.env.AGETOR_FAKE_CLAUDE_SESSION_DIED === "1") {
    // Test hook: simulate the tmux session dying mid-turn. Mirrors what the
    // real drivers emit from their death watch — the `SESSION_DIED_STATUS_PREFIX`
    // sentinel status chunk that makeChunkHandler pattern-matches to flip the
    // column to `blocked`, then resolves the turn with code 0 (the handle
    // `sessionDied` flag, not the exit code, drives the failed/blocked outcome).
    // Optional resolve delay lets cancellation-precedence tests fire cancelRun
    // between the column flip and the done resolution.
    const resolveDelayMs = Number(process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS ?? 5) || 5;
    after(5, () => {
      onChunk("status", `${SESSION_DIED_STATUS_PREFIX}tmux session agetor-fake ended unexpectedly — task blocked`);
    });
    after(resolveDelayMs, () => { resolveDone(0); });
  } else if (process.env.AGETOR_FAKE_CLAUDE_UNKNOWN_COMMAND === "1") {
    // Test hook: simulate claude's TUI rejecting the message as an unknown
    // slash command. Mirrors what `signalUnknownCommand` (claude-tmux.ts)
    // emits from the pane scraper — the `CLAUDE_UNKNOWN_COMMAND_STATUS_PREFIX`
    // sentinel status chunk that makeChunkHandler pattern-matches to flip the
    // column to `blocked`, then resolves the turn with code 0 (the handle
    // `unknownCommand` flag, not the exit code, drives the failed/blocked
    // outcome). Optional resolve delay lets cancellation-precedence tests
    // fire cancelRun between the column flip and the done resolution.
    const resolveDelayMs = Number(process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS ?? 5) || 5;
    after(5, () => {
      onChunk(
        "status",
        `${CLAUDE_UNKNOWN_COMMAND_STATUS_PREFIX}/fake-command — claude treated the message as a `
          + `slash command; it was not delivered. Edit the message so it doesn't start with "/" and resend.`,
      );
    });
    after(resolveDelayMs, () => { resolveDone(0); });
  } else if (
    process.env.AGETOR_FAKE_CLAUDE_TODOS === "1"
    || prompt.includes(FAKE_CLAUDE_TODOS_PROMPT_MARKER)
  ) {
    // Test hook: simulate a Task-tools (`TaskCreate`/`TaskUpdate`) session so
    // orchestrator/RunPanel/board-badge tests can drive the todo tracker
    // (src/shared/todo-progress.ts) end to end without a real claude CLI.
    // Chunk shapes match exactly what claude-tmux.ts's real mapper produces:
    // a `tool_use` chunk's `data` is `{id, name, input, serverSide}`, and its
    // matching `tool_result` chunk's `data` is `{toolUseId, content,
    // isError}` — `deriveTodoProgress` joins the two on `toolUseId ===
    // TaskCreate's id` to resolve the "Task #N created successfully: …" task
    // number (see that module's header comment). Two creates + one update to
    // `in_progress` on the first task is enough to exercise every code path
    // the derivation covers (multi-item accumulation, result-text task-number
    // resolution, status mutation) while still landing on a stable, easily
    // asserted end state: 2 tasks, 0 done, task #1 in progress.
    //
    // Only turn 1 (a fresh spawn, never a `--resume`) runs this scenario —
    // real claude only *creates* tasks once per plan; a follow-up turn on
    // the same session reuses the default echo behavior below, same as every
    // other canned scenario in this driver.
    after(5, () => {
      onChunk(
        "tool_use",
        JSON.stringify({
          id: "fake-todo-create-1",
          name: "TaskCreate",
          input: { subject: "Phase 1 — Investigate", description: "Look into the root cause.", activeForm: "Investigating" },
          serverSide: false,
        }),
        "fake-todo-create-1-tu",
      );
    });
    after(8, () => {
      onChunk(
        "tool_result",
        JSON.stringify({
          toolUseId: "fake-todo-create-1",
          content: "Task #1 created successfully: Phase 1 — Investigate",
          isError: false,
        }),
        "fake-todo-create-1-tr",
      );
    });
    after(11, () => {
      onChunk(
        "tool_use",
        JSON.stringify({
          id: "fake-todo-create-2",
          name: "TaskCreate",
          input: { subject: "Phase 2 — Implement", description: "Ship the fix.", activeForm: "Implementing" },
          serverSide: false,
        }),
        "fake-todo-create-2-tu",
      );
    });
    after(14, () => {
      onChunk(
        "tool_result",
        JSON.stringify({
          toolUseId: "fake-todo-create-2",
          content: "Task #2 created successfully: Phase 2 — Implement",
          isError: false,
        }),
        "fake-todo-create-2-tr",
      );
    });
    after(17, () => {
      onChunk(
        "tool_use",
        JSON.stringify({
          id: "fake-todo-update-1",
          name: "TaskUpdate",
          input: { taskId: "1", status: "in_progress" },
          serverSide: false,
        }),
        "fake-todo-update-1-tu",
      );
    });
    after(20, () => {
      onChunk(
        "tool_result",
        JSON.stringify({ toolUseId: "fake-todo-update-1", content: "Task #1 updated", isError: false }),
        "fake-todo-update-1-tr",
      );
    });
    after(23, () => onChunk("assistant", "Starting Phase 1 — Investigate now."));
    after(26, () => { onChunk("status", "turn complete"); resolveDone(0); });  } else if (prompt.includes(FAKE_CLAUDE_MONITOR_PROMPT_MARKER)) {
    // Test hook: simulate arming a Claude Code `Monitor` and later ending it
    // — see FAKE_CLAUDE_MONITOR_PROMPT_MARKER's doc comment above for why
    // this scenario inserts/settles the `subagents` row itself instead of
    // relying on claude-subagents.ts's JSONL-tailing discovery. Chunk shapes
    // match exactly what claude-tmux.ts's real mapper produces for a Monitor
    // launch: a `tool_use` chunk's `data` is `{id, name, input, serverSide}`,
    // its matching `tool_result` chunk's `data` is `{toolUseId, content,
    // isError}` with `content` echoing the real "Monitor started (task <id>,
    // timeout <ms>ms)…" stub text `scanLineForMonitorStub` parses `taskId`
    // out of.
    //
    // Only turn 1 (a fresh spawn, never a `--resume`) runs this scenario,
    // same convention as every other canned scenario in this driver.
    const settleMsMatch = prompt.match(FAKE_CLAUDE_MONITOR_SETTLE_MS_RE);
    const parsedSettleMs = settleMsMatch ? Number(settleMsMatch[1]) : NaN;
    const settleMs = Number.isFinite(parsedSettleMs)
      ? Math.max(FAKE_CLAUDE_MONITOR_MIN_SETTLE_MS, parsedSettleMs)
      : FAKE_CLAUDE_MONITOR_DEFAULT_SETTLE_MS;
    // Keyed on the RUN, not the task: `subagentsDb.insertIfAbsent` is
    // INSERT OR IGNORE, so a task-keyed id would collide with the already-
    // `completed` row from a previous run (an e2e retry, Stop→Start, a re-run
    // of the marker prompt) and silently degrade to a plain fake turn with no
    // hold. Same reasoning as `fakePlanCallCounter` in the cursor fake.
    const monitorId = `fake-monitor-${fakeOpts.runId ?? taskId}`;
    after(5, () => {
      onChunk(
        "tool_use",
        JSON.stringify({
          id: "fake-monitor-1",
          name: "Monitor",
          input: { command: "tail -f build.log", description: "Fake monitor", timeout_ms: 60000, persistent: false },
          serverSide: false,
        }),
        "fake-monitor-1-tu",
      );
    });
    after(8, () => {
      onChunk(
        "tool_result",
        JSON.stringify({
          toolUseId: "fake-monitor-1",
          content: `Monitor started (task ${monitorId}, timeout 60000ms). You will be notified on each event.`,
          isError: false,
        }),
        "fake-monitor-1-tr",
      );
      // The real discovery path (claude-subagents.ts) would insert this row
      // off the same two lines just emitted above; this fake driver writes
      // no JSONL for that watcher to tail, so it inserts directly.
      subagentsDb.insertIfAbsent({
        id: monitorId,
        taskId,
        runId: fakeOpts.runId ?? null,
        parentKind: "monitor",
        agentType: "monitor",
        description: "Fake monitor",
        spawnDepth: 1,
        sourcePath: "",
        toolUseId: "fake-monitor-1",
        status: "running",
        startedAt: Date.now(),
        endedAt: null,
      });
      record.push(`monitor:armed:${monitorId}`);
    });
    after(12, () => {
      onChunk("assistant", "Armed a monitor; waiting for events.");
      onChunk("status", "turn complete");
      resolveDone(0);
    });
    after(settleMs, () => {
      // Mirrors the live path's receipt settle
      // (`setBackgroundTaskSettledHandler` → `settleSubagentById(id,
      // "completed", "receipt")`) that fires when a `<task-notification>`
      // carries the monitor's terminal event — this is what flips
      // `subagents.hasRunning(taskId)` false and releases the orchestrator's
      // hold, moving the card from `running` to `review`.
      settleSubagentById(monitorId, "completed", "receipt");
      record.push(`monitor:settled:${monitorId}`);
    });
  } else if (
    process.env.AGETOR_FAKE_FX_PERMISSION === "1"
    || prompt.includes(FAKE_FX_PERMISSION_PROMPT_MARKER)
  ) {
    // Test hook: simulate fx's ACP `session/request_permission` round-trip
    // so Playwright/e2e specs can drive the `fx_permission` card
    // (RunPanel's FxPermissionCard) end to end without the real ACP driver.
    // Mirrors fx-acp.ts's real handler almost exactly: register the card via
    // `registerFxPermission` and await its `answer` promise instead of
    // scheduling a fixed-delay end-of-turn timer — this scenario's turn only
    // resolves once the card is answered (by the user via the HTTP route, or
    // by `kill()` below on Stop/delete), same registry-awaiter discipline as
    // the real driver.
    //
    // Mirrors the real driver's `maybeEmitProvider` (fx-acp.ts): the
    // `configOptions` provider id rides a `FX_PROVIDER_STATUS_PREFIX` status
    // chunk once per turn, emitted before any turn content, so the run-row
    // provider chip is e2e-visible under this fake too.
    if (fakeOpts.kind === "fx") onChunk("status", `${FX_PROVIDER_STATUS_PREFIX}gateway`);
    after(5, () => onChunk("assistant", "requesting permission…"));
    if (fakeOpts.mode === "yolo") {
      // Mirror the real driver: `yolo` auto-allows client-side and answers
      // synchronously without ever reaching `session/request_permission`'s
      // registry round-trip, so this fake must not register a card for it
      // either — a yolo task should never surface an `fx_permission` card.
      after(8, () => {
        onChunk("status", "fake fx permission auto-allowed (yolo)");
        onChunk("status", "turn complete");
        resolveDone(0);
      });
    } else {
      try {
        const { id, answer } = registerFxPermission({
          taskId,
          runId: fakeOpts.runId ?? "fake-run",
          toolCall: {
            toolCallId: "fake-fx-permission-1",
            title: "Write file",
            kind: "edit",
            rawInput: { path: "/tmp/example.txt" },
          },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
          mode: fakeOpts.mode === "ask" ? "ask" : "auto",
        });
        fxPermissionCardId = id;
        answer
          .then((a) => {
            // `kill()` may have already cleared the timers and settled
            // `done` (and answered this same card `cancelled` itself)
            // before this promise resolves — skip emitting/resolving a
            // second time so we never double-resolve `resolveDone` or emit
            // chunks against a run `kill()` already tore down.
            if (killed) return;
            onChunk("status", `fake fx permission resolved: ${"optionId" in a ? a.optionId : "cancelled"}`);
            onChunk("status", "turn complete");
            resolveDone(0);
          })
          .catch(() => {});
      } catch (err) {
        onChunk(
          "status",
          `fake fx permission registration failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        resolveDone(1);
      }
    }  } else {
    // Generic fallback, shared with claude's fake driver — only fx turns get
    // the provider sentinel (mirrors `maybeEmitProvider` in fx-acp.ts; see
    // the fx-permission scenario above for the same comment in full).
    if (fakeOpts.kind === "fx") onChunk("status", `${FX_PROVIDER_STATUS_PREFIX}gateway`);
    after(5, () => onChunk("stdout", `fake response to: ${prompt}`));
    after(20, () => { onChunk("status", "turn complete"); resolveDone(0); });
  }
  const inst: FakeDriverInstance = {
    _record: record,
    kill: () => {
      record.push("kill");
      // Set before anything else so the fx-permission scenario's still-
      // pending `answer.then` callback (if any) sees it and skips emitting
      // chunks / re-resolving `done` once that promise settles.
      killed = true;
      // Clear every pending timer so no further chunks/resolutions fire from
      // them, but still settle `done` immediately (with the same code the
      // timer chain would have used) so a kill never leaves a caller awaiting
      // `done` forever. If the timers already fired, both of these are no-ops
      // (clearTimeout on an elapsed timer, resolveDone on an already-settled
      // promise).
      for (const t of timers) clearTimeout(t);
      // Mirror the real fx driver's settlement discipline: a still-open
      // fx_permission card must be resolved on teardown, not left dangling
      // in the registry. `answerFxPermission` is idempotent (returns false
      // if the card was already answered/cancelled), so this is safe to call
      // unconditionally whenever this fake spawned one.
      if (fxPermissionCardId !== undefined) {
        answerFxPermission(fxPermissionCardId, { cancelled: true });
      }
      resolveDone(0);
    },
    writeInput: (line) => { record.push(`write:${line}`); return true; },
    done,
  };
  fakeDrivers.set(taskId, inst);
  return inst;
}

/**
 * Test hook: when `AGETOR_FAKE_CURSOR_PLAN=1`, the cursor fake driver emits a
 * `createPlanToolCall` tool_use/tool_result pair instead of the generic fake
 * response, so orchestrator tests can drive `attachDoneHandler`'s cursor plan
 * detection (`orchestrator.ts:detectCursorPlan`) end to end without a real
 * `cursor-agent` CLI. Chunk shapes match exactly what `mapCursorEvent`
 * produces (`cursor-tmux.ts`): the `tool_use` chunk's `data` is
 * `{id, name, input, serverSide}` with `input` = the raw `tool_call` payload
 * (so `input.createPlanToolCall.args.plan` round-trips the same way a real
 * run's does), and the `tool_result` chunk is `{toolUseId, content, isError}`.
 * The call_id deliberately embeds a newline — real Cursor call_ids do this
 * (plan §2) — so detection/persistence code that only exercises this path in
 * tests still gets coverage for the newline-safety requirement.
 *
 * `fakePlanCallCounter` makes the call_id unique per spawn (i.e. per turn):
 * without it, a `--resume` turn issued right after approving a plan would
 * emit the exact same call_id as the first turn, and `upsertDetectedPlan`'s
 * dedup-by-toolCallId would treat the second plan as a no-op re-detection of
 * the first instead of a genuinely new plan — which is exactly the
 * supersede transition tests need to exercise.
 */
let fakePlanCallCounter = 0;
function makeFakeCursorPlanAgent(taskId: string, prompt: string, onChunk: ChunkHandler): SpawnedAgent {
  const record: string[] = [`spawn:${prompt}`];
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((res) => { resolveDone = res; });
  const timers: ReturnType<typeof setTimeout>[] = [];
  const after = (ms: number, fn: () => void) => { timers.push(setTimeout(fn, ms)); };

  const n = ++fakePlanCallCounter;
  const callId = `call-fake-plan-${n}\nfc_fake_${n}`;
  const planArgs = {
    plan: "# Fake Plan\n\n- step one\n- step two",
    name: "Fake Plan",
    todos: [] as unknown[],
    overview: "",
    isProject: false,
    phases: [] as unknown[],
  };
  after(5, () => {
    onChunk(
      "tool_use",
      JSON.stringify({
        id: callId,
        name: "createPlanToolCall",
        input: { createPlanToolCall: { args: planArgs } },
        serverSide: false,
      }),
      `tool_call:${callId}:started`,
    );
  });
  after(10, () => {
    // `mapCursorEvent`'s `completed` branch forwards the WHOLE `tool_call`
    // envelope as `content` (cursor-tmux.ts's `evt.tool_call ?? {}`), not
    // just its result payload — match that shape here so a test asserting
    // on `tool_result.content` sees exactly what a real run would produce.
    onChunk(
      "tool_result",
      JSON.stringify({
        toolUseId: callId,
        content: { createPlanToolCall: { args: planArgs, result: { success: {}, planUri: "" } } },
        isError: false,
      }),
      `tool_call:${callId}:completed`,
    );
  });
  after(20, () => { onChunk("status", "turn complete"); resolveDone(0); });

  const inst: FakeDriverInstance = {
    _record: record,
    kill: () => {
      record.push("kill");
      for (const t of timers) clearTimeout(t);
      resolveDone(0);
    },
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
   * Fires with the agent's session uuid. For claude-code and gemini, both of
   * which take a self-issued `--session-id`, this fires synchronously before
   * the CLI has even written its first event — useful for persisting the id
   * on the run row immediately. For codex and fx it fires later, once the
   * driver DISCOVERS the id from the process itself — codex from the
   * `thread.started` event, fx from the ACP `session/new` response's
   * `sessionId` (both have no pre-generation flag/mechanism). Not invoked at
   * all pre-gemini for codex-shaped "no comparable session id" cases — every
   * kind now has one.
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
      buildCommand(harness, prompt, opts);      return makeFakeAgent(taskId, prompt, onChunk, { runId, mode: opts.mode ?? "auto" });    }
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

  if (harness.kind === "cursor") {
    // cursor — hosted in a per-task tmux session via cursor-tmux.ts (so a
    // mid-turn run survives an agetor restart and is reattachable), streaming
    // structured events by tailing cursor-agent's `--output-format
    // stream-json` NDJSON log. Same one-shot-turn-in-tmux shape as codex.
    if (process.env.AGETOR_CURSOR_DRIVER === "fake") {
      buildCommand(harness, prompt, opts);
      // Hand the orchestrator a session id so it persists `cursor_session_id`
      // and can route follow-ups through `--resume` — mirrors what a real
      // `system/init` event would deliver.
      onSessionId?.(`fake-cursor-session-${taskId}`);
      // Test hook, additive: without the env var this is unreachable and
      // behavior is unchanged (see `makeFakeCursorPlanAgent`'s header).
      if (process.env.AGETOR_FAKE_CURSOR_PLAN === "1") {
        return makeFakeCursorPlanAgent(taskId, prompt, onChunk);
      }      return makeFakeAgent(taskId, prompt, onChunk, { runId, mode: opts.mode ?? "auto" });    }
    const built = buildCommand(harness, prompt, opts);
    return spawnCursorViaTmux({
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

  if (harness.kind === "gemini") {
    if (process.env.AGETOR_GEMINI_DRIVER === "fake") {
      buildCommand(harness, prompt, opts);
      // Unlike claude's fake path (which skips onSessionId entirely — see
      // above), gemini's real spawn always calls onSessionId synchronously,
      // so the fake preserves that observable contract with a predictable
      // value tests can assert on (mirrors codex's fake `thread.started`
      // stand-in, `fake-codex-thread-${taskId}`).
      const sessionId = opts.resumeSessionId ?? `fake-gemini-session-${taskId}`;
      onSessionId?.(sessionId);      return makeFakeAgent(taskId, prompt, onChunk, { runId, mode: opts.mode ?? "auto" });    }
    // Pre-generate a session uuid when we're not resuming — mirrors claude's
    // pattern (`--session-id` up front) rather than codex's discover-later
    // pattern, even though the tmux HOSTING strategy below (one-shot per
    // turn, detached session, reattach-while-in-flight) mirrors codex.
    const sessionId = opts.resumeSessionId ?? crypto.randomUUID();
    const built = buildCommand(harness, prompt, {
      ...opts,
      sessionId: opts.resumeSessionId ? null : sessionId,
    });
    onSessionId?.(sessionId);
    return spawnGeminiViaTmux({
      taskId,
      runId,
      argv: built.cmd,
      env: built.env ?? {},
      cwd,
      onChunk,
    });
  }

  if (harness.kind === "fx") {
    // fx — driven over ACP/stdio via fx-acp.ts, a plain `Bun.spawn` child
    // process with no tmux involved (see that file's header for why: an ACP
    // stdio server has nothing to reattach to across an agetor restart, so a
    // mid-turn death orphans the run by design).
    if (process.env.AGETOR_FX_DRIVER === "fake") {
      // Build the command anyway so the fake records the prompt going by and
      // exercises the same validation (missing model/runId) the real path
      // does; the fake's behaviour doesn't depend on the argv shape.
      buildCommand(harness, prompt, { ...opts, runId });
      // fx's ACP session id is DISCOVERED from `session/new`'s response, not
      // pre-generated — mirrors codex's `thread.started`-discovery timing
      // (see the `onSessionId` doc on `SpawnAgentArgs`), not claude/gemini's
      // pre-generated-uuid pattern.
      onSessionId?.(`fake-fx-session-${taskId}`);
      return makeFakeAgent(taskId, prompt, onChunk, { runId, mode: opts.mode ?? "auto", kind: "fx" });
    }
    const built = buildCommand(harness, prompt, { ...opts, runId });
    return spawnFxViaAcp({
      taskId,
      runId,
      argv: built.cmd,
      env: built.env ?? {},
      cwd,
      promptText: prompt,
      mode: (opts.mode ?? "auto") as FxMode,
      resumeSessionId: opts.resumeSessionId ?? undefined,
      onChunk,
      onSessionId,
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
    onSessionId?.(`fake-codex-thread-${taskId}`);    return makeFakeAgent(taskId, prompt, onChunk, { runId, mode: opts.mode ?? "auto" });  }
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
