import {
  existsSync,
  watch as fsWatch,
  type FSWatcher,
  openSync as fsOpenSync,
  readSync as fsReadSync,
  closeSync as fsCloseSync,
  statSync as fsStatSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { API_TOKEN, getApiPort } from "./api-config.ts";
import { tasks } from "./db.ts";
import { ensureInstalledForCwd } from "./hook-installer.ts";
import {
  ASK_QUESTIONS_REPLY_PREFIX,
  PLAN_APPROVED_REPLY_PREFIX,
  PLAN_REJECTED_REPLY_PREFIX,
  activeTmuxPromptsForTask,
  answerTmuxPrompt,
  findTmuxPromptByFingerprint,
  registerTmuxPrompt,
  type TmuxPromptChoice,
} from "./interactions.ts";
import { resolveTmuxBin } from "./tmux-resolution.ts";

/**
 * Driver that hosts Claude Code's interactive REPL inside a per-task tmux
 * session and exposes structured streaming by tailing the per-session JSONL
 * file Claude writes under `~/.claude/projects/`. Picked over screen-scraping
 * the TUI because the JSONL is a stable, documented format whereas the
 * Ink-rendered terminal frames change with every claude release.
 *
 * Lifetime:
 *   - One tmux session per task (named `agetor-<taskId-prefix>`).
 *   - Each call to `spawnClaudeViaTmux` (the first prompt) creates the session.
 *   - `sendTurn` reuses the session to send a follow-up prompt.
 *   - `killTaskSession` ends the session entirely; called on delete + reconcile.
 *
 * Stopping a turn is *not* the same as killing the session — Stop sends Ctrl+C
 * via `tmux send-keys` so claude aborts the current turn but stays alive,
 * ready for the next prompt.
 */

import type { RunEventStream } from "../shared/types.ts";

/**
 * Stream chunk callback. `lineUuid` is the JSONL line's `uuid` field (claude
 * stamps one per event) when the chunk originates from a JSONL line; it stays
 * undefined for chunks the agetor side synthesises (status banners, stderr,
 * `sendInput` user echoes). The orchestrator's chunk handler forwards it to
 * `runs.appendEvent` as the per-row dedup key — that's what makes re-reading
 * JSONL from offset 0 on reattach idempotent.
 */
export type ChunkHandler = (stream: RunEventStream, data: string, lineUuid?: string) => void;

export interface SpawnedAgent {
  /** Interrupt the in-progress turn. Does not destroy the session. */
  kill: () => void;
  /** Send a new user prompt. Returns false when the session no longer exists. */
  writeInput: (line: string) => boolean;
  /**
   * Resolves with 0 on the next `stop_reason: "end_turn"` after this turn
   * was sent. Rejects with an Error when the session dies before completing,
   * or when JSONL discovery fails on the initial spawn.
   */
  done: Promise<number>;
}

export interface ClaudeLaunchOptions {
  taskId: string;
  /**
   * Full argv passed to tmux after `--`, e.g. `["claude", "--session-id",
   * "<uuid>", "--model", "<m>", "<prompt>"]`. The initial prompt rides as
   * the final argv element (claude's documented `claude "query"` form), so
   * the driver doesn't have to paste it via tmux after spawn.
   */
  argv: string[];
  /** Env vars to forward into the claude process (via tmux `-e`). */
  env: Record<string, string>;
  cwd: string;
  onChunk: ChunkHandler;
  /**
   * Claude session uuid this run will use. Either a freshly minted uuid
   * (passed to claude via `--session-id <uuid>` and embedded in argv) or
   * the id of a prior session being resumed via `--resume <id>`. Either
   * way the JSONL path is deterministic: we know it before claude runs.
   */
  sessionId: string;
  /**
   * Per-harness HOME override. When set, claude writes its JSONL under
   * `<home>/.claude/projects/…` instead of the system homedir — this is
   * how multi-account harnesses keep their login & history separate.
   * NULL falls back to `homedir()`.
   */
  home: string | null;
  /**
   * Agetor permission mode for this task (see AGENT_OPTIONS in
   * shared/types.ts). Forwarded to `ensureInstalledForCwd` to pick the
   * install scope:
   *   - `auto` and `bypass` → narrow PreToolUse matcher that only catches
   *     AskUserQuestion + ExitPlanMode. For `auto` this is critical: with
   *     a narrow matcher, claude's own permission engine (including its
   *     AI auto-mode classifier) handles every other tool call, since
   *     PreToolUse hooks are terminal when they match. A `.*` matcher
   *     here would short-circuit the classifier and re-introduce the
   *     "every tool needs a card" problem.
   *   - Other modes (`ask`, `plan`, `acceptEdits`) get the full `.*`
   *     matcher so agetor's UI cards render for every tool call.
   * See `installScopeForMode` in hook-installer.ts.
   */
  mode: string | null;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Pure helpers (exported for tests).
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Canonical permission-mode strings claude reports in its JSONL `system` /
 * `permission-mode` events (and accepts at `--permission-mode`). Agetor's own
 * mode ids (see AGENT_OPTIONS in shared/types.ts) overlap on `auto`,
 * `acceptEdits`, `plan` but use shorthand for the other two: `bypass` →
 * `bypassPermissions`, `ask` → `default`. Translate via `toClaudeModeString`.
 */
export const CLAUDE_MODE_DEFAULT = "default";
export const CLAUDE_MODE_ACCEPT_EDITS = "acceptEdits";
export const CLAUDE_MODE_PLAN = "plan";
export const CLAUDE_MODE_BYPASS = "bypassPermissions";
export const CLAUDE_MODE_AUTO = "auto";

/** Translate an agetor mode id (from AGENT_OPTIONS) to claude's canonical
 *  permission-mode string. Unknown ids fall through verbatim so future agetor
 *  ids that happen to match claude's strings (e.g. `dontAsk`) just work. */
export function toClaudeModeString(agetorMode: string): string {
  switch (agetorMode) {
    case "bypass": return CLAUDE_MODE_BYPASS;
    case "ask": return CLAUDE_MODE_DEFAULT;
    default: return agetorMode;
  }
}

/**
 * The Shift+Tab cycle order claude implements. The 3 base modes are always
 * present; `bypassPermissions` only appears when claude was launched with one
 * of `--permission-mode bypassPermissions`, `--dangerously-skip-permissions`,
 * or `--allow-dangerously-skip-permissions`. `auto` appears when the account
 * is eligible — we can't probe that programmatically, so we optimistically
 * include it; if the user's account isn't eligible the press will land
 * somewhere unexpected (and the JSONL event tells us where).
 *
 * Order documented at https://code.claude.com/docs/en/permission-modes —
 * optional modes slot in after `plan`, bypass first then auto.
 */
export function cycleOrderFor(bypassEnabled: boolean): string[] {
  const cycle = [CLAUDE_MODE_DEFAULT, CLAUDE_MODE_ACCEPT_EDITS, CLAUDE_MODE_PLAN];
  if (bypassEnabled) cycle.push(CLAUDE_MODE_BYPASS);
  cycle.push(CLAUDE_MODE_AUTO);
  return cycle;
}

/**
 * Compute the number of Shift+Tab presses to step from `current` to `target`
 * within `cycle`. Returns null when either mode isn't in the cycle (caller
 * should treat as "unreachable — needs a respawn"). Returns 0 when already
 * at the target — caller can skip the keystrokes.
 */
export function cycleDistance(cycle: string[], current: string, target: string): number | null {
  const curIdx = cycle.indexOf(current);
  const tgtIdx = cycle.indexOf(target);
  if (curIdx < 0 || tgtIdx < 0) return null;
  return (tgtIdx - curIdx + cycle.length) % cycle.length;
}

/**
 * Encode an absolute filesystem path the way Claude Code does for its project
 * directory name under `~/.claude/projects/`. Every `/` AND `.` becomes `-` —
 * so `/Users/me/.agetor/x` collapses to `-Users-me--agetor-x` (note the
 * double dash where `/.` appeared). Missed the dot rule originally and JSONL
 * discovery silently looked at the wrong directory for any path containing
 * a dot segment.
 *
 *   /Users/foo/bar             → -Users-foo-bar
 *   /Users/foo/.agetor/x       → -Users-foo--agetor-x
 *   /                          → -
 */
export function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** Tmux-safe session name derived from a task id. */
export function sessionNameFor(taskId: string): string {
  return `agetor-${taskId.slice(0, 12)}`;
}

/**
 * Detect tool_result content that's actually one of agetor's own intercept
 * replies (AskUserQuestion / ExitPlanMode). Claude writes those results with
 * `is_error: true` in JSONL because the PreToolUse hook returned `decision:
 * "deny"` — but from the user's POV those are successful answers, not errors.
 *
 * Sentinel prefixes are imported from `interactions.ts` so the formatter and
 * the detector cannot drift out of sync.
 */
export function isAgetorInterceptReply(content: unknown): boolean {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text"
            ? (b as { text?: string }).text ?? ""
            : ""))
          .join("")
      : "";
  return text.startsWith(ASK_QUESTIONS_REPLY_PREFIX)
    || text.startsWith(PLAN_APPROVED_REPLY_PREFIX)
    || text.startsWith(PLAN_REJECTED_REPLY_PREFIX);
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  data?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  source?: { type?: string; media_type?: string; data?: string; url?: string };
}

interface AssistantMessage {
  content?: ContentBlock[];
  stop_reason?: string;
}

interface UserMessage {
  /** Either the user's literal text (interactive turn) or an array of
   *  content blocks (tool_result blocks live here in claude's JSONL). */
  content?: string | ContentBlock[];
}

/**
 * Translate one JSONL line into zero or more typed chunk callbacks, and
 * signal whether the line ended the current turn. Pure — no IO. Tested
 * directly.
 *
 * Top-level event types (claude code JSONL):
 *   user                          — user prompt or tool_result wrapper
 *   assistant                     — claude response (content blocks below)
 *   system                        — initial session context (permission mode)
 *   permission-mode               — per-session permission-mode change
 *   summary                       — compaction checkpoint (older turns rolled up)
 *   result                        — session completion (-p mode marker)
 *   attachment                    — hook output appended to context (e.g. SessionStart)
 *   last-prompt / ai-title /
 *     file-history-snapshot /
 *     agent-name                  — claude's own bookkeeping (silent)
 *
 * Assistant content-block types we recognise:
 *   text                  → `assistant` (markdown)
 *   thinking              → `thinking`
 *   redacted_thinking     → `thinking` (placeholder)
 *   tool_use              → `tool_use`  (data = { id, name, input })
 *   server_tool_use       → `tool_use`  (server-side tool, same shape)
 *   web_search_tool_result→ `tool_result` (rare; rendered like a tool result)
 *   image                 → `assistant` (placeholder text — UI doesn't inline)
 *
 * User content-block types we recognise:
 *   tool_result           → `tool_result` (data = { toolUseId, content, isError })
 *   image                 → silent (not currently surfaced)
 *   text                  → silent (echoed via send-input status)
 *
 * Unknown event / block types are silently ignored — when claude code adds
 * a new kind we keep working; the user just doesn't see the new variant
 * until we add a renderer for it.
 */
interface ParsedJsonlEvent {
  type?: string;
  uuid?: string;
  message?: AssistantMessage & UserMessage;
  permissionMode?: string;
  summary?: string;
}

export function mapJsonlEventToChunks(
  line: string,
  onChunk: ChunkHandler,
): { endOfTurn: boolean; lineUuid?: string } {
  let evt: ParsedJsonlEvent;
  try {
    evt = JSON.parse(line);
  } catch (e) {
    onChunk("stderr", `jsonl parse error: ${(e as Error).message}`);
    return { endOfTurn: false };
  }
  return mapParsedEventToChunks(evt, onChunk);
}

/** String-variant entry point delegates to this once the JSON has been
 *  parsed. `dispatchLine` parses up front (to peek the uuid for dedup) and
 *  calls this directly — saves a second JSON.parse per JSONL line. */
function mapParsedEventToChunks(
  evt: ParsedJsonlEvent,
  onChunk: ChunkHandler,
): { endOfTurn: boolean; lineUuid?: string } {
  // Claude stamps a uuid on every event line. Forward it as the third arg
  // to onChunk so the orchestrator can persist it as the run_events row's
  // dedup key — that's what makes a re-read of the JSONL on reattach (after
  // agetor restarts and finds the tmux session still alive) idempotent.
  const uuid = typeof evt.uuid === "string" ? evt.uuid : undefined;

  switch (evt.type) {
    case "user": {
      const content = evt.message?.content;
      // The human's interactive turn. We DO emit a "user" stream event
      // here — both for the run-panel rendering (so the bubble appears
      // alongside assistant text) and so a rebuild-from-JSONL contains
      // the user messages. Live `sendInput` ALSO emits "user" via the
      // orchestrator's onChunk, and `startTask` echoes the initial
      // prompt the same way; the run panel's dedup keys user events on
      // (runId, data) only (ignoring ts), so the live + JSONL paths
      // collapse into one bubble per message.
      if (typeof content === "string") {
        if (content) onChunk("user", content, uuid);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "tool_result") {
            // Override is_error for agetor's own intercept replies — claude
            // marks them `is_error: true` because the hook said `deny`, but
            // they carry the user's successful answer.
            const isError = (block.is_error ?? false) && !isAgetorInterceptReply(block.content);
            onChunk("tool_result", JSON.stringify({
              toolUseId: block.tool_use_id ?? "",
              content: block.content,
              isError,
            }), uuid);
          } else if (block?.type === "text" && block.text) {
            onChunk("user", block.text, uuid);
          }
          // Image / unknown blocks intentionally silent.
        }
      }
      return { endOfTurn: false, lineUuid: uuid };
    }

    case "assistant": {
      const msg = evt.message ?? {};
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const block of blocks) {
        switch (block.type) {
          case "text":
            if (block.text) onChunk("assistant", block.text, uuid);
            break;
          case "thinking":
            if (block.thinking) onChunk("thinking", block.thinking, uuid);
            break;
          case "redacted_thinking":
            // Anthropic returns these when extended thinking was redacted
            // server-side — the content is opaque but the *fact* of it is
            // useful so the user knows reasoning happened.
            onChunk("thinking", "[redacted thinking]", uuid);
            break;
          case "tool_use":
          case "server_tool_use":
            onChunk("tool_use", JSON.stringify({
              id: block.id ?? "",
              name: block.name ?? "?",
              input: block.input ?? {},
              serverSide: block.type === "server_tool_use",
            }), uuid);
            break;
          case "web_search_tool_result":
            onChunk("tool_result", JSON.stringify({
              toolUseId: block.tool_use_id ?? "",
              content: block.content,
              isError: false,
            }), uuid);
            break;
          case "image":
            // Claude can return inline images in newer SDK builds; we
            // don't have a renderer for those yet, so log a placeholder
            // instead of dropping silently — the user can at least tell
            // *something* came back.
            onChunk("assistant", "[image]", uuid);
            break;
          default:
            // Forward-compat: unknown block types are left silent so we
            // don't spew noise when claude adds new variants. Add cases
            // here as we grow renderers.
            break;
        }
      }
      if (msg.stop_reason === "end_turn") {
        onChunk("status", "turn complete", uuid);
        return { endOfTurn: true, lineUuid: uuid };
      }
      return { endOfTurn: false, lineUuid: uuid };
    }

    case "system":
    case "permission-mode":
      if (evt.permissionMode) {
        onChunk("status", `permission-mode: ${evt.permissionMode}`, uuid);
      }
      return { endOfTurn: false, lineUuid: uuid };

    case "summary":
      // Context-compaction checkpoint claude inserts when older turns get
      // rolled up. Useful breadcrumb in the log.
      if (evt.summary) onChunk("status", `summary: ${evt.summary}`, uuid);
      return { endOfTurn: false, lineUuid: uuid };

    default:
      // attachment, last-prompt, ai-title, agent-name, file-history-snapshot,
      // result, and any future bookkeeping types: intentionally silent.
      return { endOfTurn: false, lineUuid: uuid };
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Tmux process helpers.
 * ────────────────────────────────────────────────────────────────────────── */

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run a one-shot tmux command. Never throws — callers check `ok`. */
function tmux(args: string[], opts: { stdinText?: string } = {}): RunResult {
  try {
    const proc = Bun.spawnSync([resolveTmuxBin(), ...args], {
      stdin: opts.stdinText !== undefined
        ? new TextEncoder().encode(opts.stdinText)
        : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      ok: proc.exitCode === 0,
      stdout: new TextDecoder().decode(proc.stdout).trim(),
      stderr: new TextDecoder().decode(proc.stderr).trim(),
    };
  } catch (e) {
    return { ok: false, stdout: "", stderr: (e as Error).message };
  }
}

/** True when `tmux has-session -t <name>` returns 0. */
export function sessionExists(taskId: string): boolean {
  return tmux(["has-session", "-t", sessionNameFor(taskId)]).ok;
}

/** Name-keyed variant for callers that hold a persisted session name (e.g.
 *  `runs.tmux_session`) and don't want to recompute it from a task id. */
export function sessionExistsByName(name: string): boolean {
  return tmux(["has-session", "-t", name]).ok;
}

/** All currently-running `agetor-*` tmux sessions. Used by reconcileOrphans. */
export function listAgetorSessions(): string[] {
  const res = tmux(["list-sessions", "-F", "#{session_name}"]);
  if (!res.ok) return [];
  return res.stdout.split("\n").filter((n) => n.startsWith("agetor-"));
}

/** Kill any tmux session for the given task. Idempotent / silent on miss. */
export function killTaskSession(taskId: string): void {
  tmux(["kill-session", "-t", sessionNameFor(taskId)]);
}

/** Kill an arbitrary session name. Used by reconcileOrphans. */
export function killSessionByName(name: string): void {
  tmux(["kill-session", "-t", name]);
}

/**
 * Current permission-mode for this task's claude session, as last reported
 * by a JSONL `permission-mode` event (or, on first launch, the value the
 * orchestrator passed to `spawnClaudeViaTmux`). Returns null when no
 * session is registered for this task (idle, between runs, or unknown
 * task). Read by the `/approvals` route so plan mode can never silently
 * short-circuit a tool call via the saved-rule fast-path.
 */
export function getCurrentPermissionMode(taskId: string): string | null {
  return sessions.get(taskId)?.permissionMode ?? null;
}

/**
 * Send a literal keystroke (or short sequence) to a task's tmux session
 * followed by Enter. Used by the `/tmux-prompts/:id/answer` route to
 * dismiss a Claude REPL modal the scraper detected — typing `"1"` then
 * Enter into the pane is how the user would manually pick choice 1.
 *
 * NOT a chat message: we deliberately bypass the `load-buffer +
 * paste-buffer` flow `pastePrompt` uses, because that path delivers the
 * text into claude's input buffer to become the next prompt. The modal
 * wants a direct keypress, not a queued message.
 *
 * Returns true on apparent success (tmux command exited 0). Silently
 * returns false when no session is registered.
 */
export function dismissTmuxPrompt(taskId: string, key: string): boolean {
  const state = sessions.get(taskId);
  if (!state) return false;
  // send-keys interprets every positional arg as a tmux key spec — pass
  // the literal first, then "Enter" as a separate token so claude sees
  // an actual carriage return.
  const res = tmux(["send-keys", "-t", state.sessionName, key, "Enter"]);
  return res.ok;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Per-task session state.
 * ────────────────────────────────────────────────────────────────────────── */

interface SessionState {
  taskId: string;
  sessionName: string;
  cwd: string;
  /** Absolute path to the JSONL we tail for structured output. */
  jsonlPath: string;
  /** Byte offset cursor into jsonlPath; advanced as we read. */
  offset: number;
  /** Active fs.watch handle on jsonlPath. */
  watcher: FSWatcher | null;
  /** Periodic poll timer that flushes appended JSONL bytes — backstop for
   *  fs.watch on macOS, which silently drops notifications on slow append
   *  streams. Without this, after the first event we'd never see the rest. */
  pollTimer: ReturnType<typeof setInterval> | null;
  /** FIFO of turns waiting for end_turn. The head is the active turn —
   *  events flowing through the JSONL belong to it until end_turn fires,
   *  at which point we shift it off and the next turn becomes active.
   *  Lets the user pipeline follow-up messages while claude is still
   *  mid-response: each new send pastes the prompt into tmux (claude
   *  queues it in its TUI input buffer) and pushes a slot here. */
  turnQueue: TurnSlot[];
  /** Most recently popped slot's chunk handler. Between turns claude
   *  sometimes appends a trailing `system` / `permission-mode` / `summary`
   *  event that logically belongs to the turn that just ended; without a
   *  hangover handler those events would land on a `() => {}` no-op and
   *  vanish. Cleared when a new slot enters the queue. */
  lastChunk: ChunkHandler | null;
  /** Set of JSONL line uuids we've already dispatched on this session. Empty
   *  for fresh `spawnClaudeViaTmux` sessions; pre-seeded from `run_events`
   *  on reattach so a re-read from offset 0 doesn't double-emit events that
   *  already landed in the DB during the previous agetor process. */
  seenLineUuids: Set<string>;
  /** Fires when a JSONL line ends a turn and the turnQueue is empty (no
   *  awaiter to pop). Reattached runs install this so the orchestrator can
   *  flip the run row to `succeeded` even though no in-process promise is
   *  waiting on `done`. Cleared after the first fire. Untouched on freshly-
   *  spawned sessions (those resolve via the turn slot's promise instead). */
  onEndOfTurn: (() => void) | null;
  /**
   * Most recently observed claude permission mode — canonical string from
   * the JSONL `system` / `permission-mode` events (`default` / `acceptEdits`
   * / `plan` / `bypassPermissions` / `auto` / `dontAsk`). Seeded from the
   * launch `mode` (via `toClaudeModeString`) at spawn so the plan-mode
   * safety net in `/approvals` is in force the instant the session is
   * registered; null on reattach until the JSONL replay's first
   * `system` / `permission-mode` event re-hydrates the field.
   *
   * Two consumers read this:
   *   - `cycleToMode` — computes how many Shift+Tab presses are needed
   *     to land on the target mode.
   *   - The `/approvals` route — when the value is `plan`, mutating
   *     tools skip the saved-rule fast-path and surface as approval
   *     interactions (so the user can never miss claude's plan-mode
   *     safety dialog because it bypasses our PreToolUse hook).
   */
  permissionMode: string | null;
  /**
   * Whether `bypassPermissions` is in this session's Shift+Tab cycle. True
   * iff the session was launched with `--dangerously-skip-permissions` (the
   * agetor `bypass` mode emits exactly that). Reattached sessions default
   * to false — we don't persist the launch flag across agetor restarts, so
   * mid-cycle to bypass after a restart isn't supported (would need a
   * respawn anyway, since claude requires the enabling flag at launch).
   */
  bypassEnabled: boolean;
  /** Periodic scrape of the visible tmux pane — looks for `Do you want
   *  to … 1.Yes 2.Yes,allow 3.No` style modals that bypass the hook
   *  system (plan-mode dialogs, `acceptEdits` + Bash, `/login`, etc.).
   *  Lazily armed when a turn enters the queue; torn down with the
   *  pollTimer. */
  scrapeTimer: ReturnType<typeof setInterval> | null;
  /** Last fingerprint the scraper saw; an entry must match the previous
   *  scrape (i.e. two consecutive ticks) before we register a real
   *  TmuxPromptRequest. Suppresses false positives where a numbered list
   *  flickers past during normal output. Reset whenever the pane no
   *  longer matches any signature. */
  scrapeLastFingerprint: string | null;
  /** `Date.now()` stamp of the most recent successful JSONL append the
   *  flusher dispatched. The scraper consults it to (a) suppress
   *  matches that happened while claude was actively writing (the
   *  "prompt" is probably transient list output, not a stable modal)
   *  and (b) cheaply detect a truly idle session so the 1s scrape
   *  tick can self-throttle. 0 means "no append observed yet". */
  lastJsonlAppendAt: number;
  /** Fingerprint → `Date.now()` of when it was answered. The route
   *  handler stamps an entry here right after `dismissTmuxPrompt`; the
   *  scraper skips re-registering a fingerprint that's still inside
   *  the TTL window. Without this, the next tick's two-tick-stability
   *  fires *after* the user clicked (the same fingerprint was on the
   *  pane the previous tick AND now), the entry is gone from the
   *  pending map, and we'd register a ghost duplicate before
   *  tmux/claude actually repainted. */
  recentlyAnsweredFingerprints: Map<string, number>;
}

interface TurnSlot {
  /** Handler routes JSONL events to the run this slot represents. */
  onChunk: ChunkHandler;
  /** Resolves the SpawnedAgent.done promise on this turn's end_turn. */
  resolve: ((code: number) => void) | null;
  reject: ((err: Error) => void) | null;
}

const sessions = new Map<string, SessionState>(); // taskId → state

/* ────────────────────────────────────────────────────────────────────────── *
 * JSONL discovery + tail.
 * ────────────────────────────────────────────────────────────────────────── */

/** Absolute filesystem path to the JSONL claude writes for this session.
 *  `home` overrides the system homedir — used so multi-account harnesses
 *  (which set HOME=<alias home> on the spawned claude) read their JSONL
 *  from the matching alias dir instead of the agetor process's HOME. */
export function jsonlPathFor(cwd: string, sessionId: string, home: string | null): string {
  return path.join(
    home ?? homedir(),
    ".claude",
    "projects",
    encodeProjectPath(cwd),
    `${sessionId}.jsonl`,
  );
}

/**
 * Wait until the JSONL at `target` exists. We pre-generate the session uuid
 * and hand it to claude via `--session-id`, so we know the exact filename
 * before claude has even booted — no mtime races, no freshest-file picking.
 *
 * Two-pronged wake-up: `fs.watch` on the parent directory fires whenever a
 * file is created (instant), and a low-frequency polling fallback catches
 * fs.watch misses on network-mounted homes / sandboxed FS layers where the
 * `rename` notification can be unreliable.
 */
async function waitForJsonlAt(
  target: string,
  timeoutMs: number,
): Promise<boolean> {
  if (existsSync(target)) return true;
  const parent = path.dirname(target);
  // Claude lazily creates the parent dir on first event. fs.watch refuses
  // to attach to a non-existent path, so spin until the dir is there.
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(parent)) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (existsSync(target)) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (v: boolean) => {
      if (settled) return;
      settled = true;
      try { watcher.close(); } catch { /* already closed */ }
      clearInterval(pollTimer);
      clearTimeout(deadlineTimer);
      resolve(v);
    };
    const watcher = fsWatch(parent, { persistent: false }, () => {
      if (existsSync(target)) settle(true);
    });
    const pollTimer = setInterval(() => {
      if (existsSync(target)) settle(true);
    }, 250);
    const deadlineTimer = setTimeout(() => settle(false), timeoutMs);
  });
}

/** Dispatch one parsed JSONL line through the active turn slot's handler,
 *  advancing the queue when the line ends a turn. Shared between the
 *  async `flush` (file watcher / poll) and the sync `flushSync` (called
 *  from `sendTurn` so we drain leftover content before queueing a new
 *  turn). */
function dispatchLine(state: SessionState, line: string): void {
  // Parse once, then route. The parsed event carries `uuid` (claude stamps
  // one per JSONL line); we use it as the dedup key — if we've already
  // dispatched this line in a previous process (and it's still in
  // run_events), skip the whole line so SSE-broadcast and run_events stay
  // idempotent across an agetor restart.
  let evt: ParsedJsonlEvent;
  try {
    evt = JSON.parse(line);
  } catch (e) {
    // Surface the parse error through whichever handler would have received
    // a normal chunk — same routing as mapJsonlEventToChunks's own catch.
    const handler = state.turnQueue[0]?.onChunk ?? state.lastChunk;
    handler?.("stderr", `jsonl parse error: ${(e as Error).message}`);
    return;
  }
  const uuid = typeof evt.uuid === "string" ? evt.uuid : undefined;

  // Mirror the latest mode-bearing JSONL event into SessionState. Two
  // consumers depend on this being current: `cycleToMode` (Shift+Tab
  // press math against the live mode) and the `/approvals` route's
  // plan-mode safety net (skip the saved-rule fast-path when claude is
  // in `plan`, regardless of what the saved rule says).
  //
  // IMPORTANT: this update MUST stay above the seenLineUuids early-
  // return below. On reattach the dedup set is pre-seeded from
  // run_events, so every replayed line — including the mode event the
  // prior process recorded — would otherwise be silently skipped and
  // state.permissionMode would stay null. The mode is session metadata,
  // not a per-line chunk the user sees twice, so re-applying it on a
  // dedup hit is cheap and idempotent. Both event types carry the mode
  // string (claude emits `system` at session start with the launch mode,
  // then `permission-mode` for every mid-session change).
  if ((evt.type === "system" || evt.type === "permission-mode")
    && typeof evt.permissionMode === "string") {
    state.permissionMode = evt.permissionMode;
  }

  if (uuid && state.seenLineUuids.has(uuid)) return;

  const slot = state.turnQueue[0];
  // Active turn → its handler. No active turn → fall back to the most
  // recently popped slot's handler so trailing metadata (permission-mode,
  // summary, etc.) still threads onto the turn it belongs to instead of
  // disappearing. If neither exists (session just opened, nothing emitted
  // yet) it's safe to drop.
  const onChunk: ChunkHandler = slot?.onChunk ?? state.lastChunk ?? (() => {});
  const { endOfTurn } = mapParsedEventToChunks(evt, onChunk);
  if (uuid) state.seenLineUuids.add(uuid);
  if (endOfTurn) {
    if (slot) {
      state.turnQueue.shift();
      state.lastChunk = slot.onChunk;
      const resolve = slot.resolve;
      slot.resolve = null;
      slot.reject = null;
      resolve?.(0);
    } else if (state.onEndOfTurn) {
      // Reattached run: no in-process promise to resolve, but the orchestrator
      // still needs to flip the run row to `succeeded`. Fire-once: clear
      // before calling so a follow-up turn on the same session (which would
      // never happen without a new slot being pushed first) can't re-trigger.
      const handler = state.onEndOfTurn;
      state.onEndOfTurn = null;
      handler();
    }
  }
}

/**
 * Synchronous read+dispatch of any JSONL content past the cursor. Mirrors
 * `flush` but uses sync fs calls so it can run inside a sync code path
 * without yielding to the event loop. Used by `sendTurn` before pushing a
 * new turn slot — guarantees that any trailing end_turn from the current
 * turn lands on the *current* slot, not on the one we're about to queue.
 */
function flushSync(state: SessionState): void {
  let st;
  try { st = fsStatSync(state.jsonlPath); } catch { return; }
  if (st.size <= state.offset) return;
  const len = st.size - state.offset;
  const buf = Buffer.alloc(len);
  let fd;
  try { fd = fsOpenSync(state.jsonlPath, "r"); } catch { return; }
  try {
    fsReadSync(fd, buf, 0, len, state.offset);
  } finally {
    fsCloseSync(fd);
  }
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  const tail = lines.pop() ?? "";
  state.offset = st.size - Buffer.byteLength(tail, "utf8");
  for (const line of lines) {
    if (!line) continue;
    dispatchLine(state, line);
  }
}

/** Read the file from `offset` to EOF, advancing the cursor. */
async function readAppended(filePath: string, offset: number): Promise<{ text: string; next: number }> {
  const handle = await open(filePath, "r");
  try {
    const st = await handle.stat();
    if (st.size <= offset) return { text: "", next: offset };
    const len = st.size - offset;
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, offset);
    return { text: buf.toString("utf8"), next: st.size };
  } finally {
    await handle.close();
  }
}

/**
 * Process whatever has been appended to the JSONL since the last cursor.
 * Splits on `\n`, parses each complete line, dispatches via the mapper, and
 * resolves the in-flight turn promise on end_turn. Trailing partial lines
 * are left in the file for the next tick (we re-read from the saved offset).
 */
async function flush(state: SessionState): Promise<void> {
  // Capture the offset BEFORE awaiting so we can detect a sync flush that
  // raced ahead of us. Without this guard, `flushSync` (called from
  // `sendTurn`) could read bytes [O..N), advance state.offset to N, and
  // push a new turn slot — while a watcher-triggered `flush` was sitting
  // on `await open(...)` with the same starting offset O. When the async
  // flush resumed it would re-read [O..N), dispatch every line a second
  // time, and a trailing `end_turn` would pop the brand-new slot,
  // flipping the new run to `succeeded` before claude had responded.
  const startOffset = state.offset;
  let chunk: { text: string; next: number };
  try {
    chunk = await readAppended(state.jsonlPath, startOffset);
  } catch (e) {
    state.turnQueue[0]?.onChunk("stderr", `jsonl read error: ${(e as Error).message}`);
    return;
  }
  if (!chunk.text) return;
  // A sync flush already consumed (some of) what we just read. The bytes
  // we'd dispatch are duplicates → drop them. The next watcher / poll
  // tick will pick up anything appended after the sync flush from the
  // (advanced) state.offset.
  if (state.offset !== startOffset) return;
  const lines = chunk.text.split("\n");
  // The last element is whatever follows the final \n in the chunk — may be
  // empty (clean newline boundary) or a partial line we'll see again next tick.
  const tail = lines.pop() ?? "";
  // Advance the cursor to *just before* the partial tail so we re-read it
  // once it's complete.
  state.offset = chunk.next - Buffer.byteLength(tail, "utf8");
  // Mark claude as actively writing — the scraper consults this to
  // suppress false positives from numbered output that streams in mid-
  // turn (and that one-tick-stable list-printing wouldn't normally
  // beat the two-tick stability requirement).
  state.lastJsonlAppendAt = Date.now();
  for (const line of lines) {
    if (!line) continue;
    dispatchLine(state, line);
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Tmux pane scraper — catches REPL modals the PreToolUse hook never sees.
 *
 * The hook system is a closed loop with claude's permission engine: only
 * tool calls fire PreToolUse, and within that, only paths claude routes to
 * the hook. Plan-mode safety dialogs, `/login`, the model picker, auth
 * re-prompts, and `acceptEdits` + Bash all paint a modal in the TUI that
 * the hook never sees. Without this scraper, the kanban shows
 * "Agent is working…" while claude is actually paused on a 3-choice
 * dialog inside tmux, invisible to anyone who hasn't `tmux attach`-ed.
 *
 * The scraper runs every ~1s, capture-panes the visible window, and tries
 * a small set of regex matchers against the tail. On a match it hashes
 * the matched block and waits one more tick before registering — a
 * single-tick blip never wins, which suppresses false positives from
 * normal numbered-list output. Once registered, the prompt rides the
 * standard interaction broadcast → SSE → run-panel path; answering ships
 * the choice's `key` back via `tmux send-keys` (see `dismissTmuxPrompt`).
 * ────────────────────────────────────────────────────────────────────────── */

/** How often the scraper polls the tmux pane. Aligned with the SSE poll
 *  budget — slower than this lets dialogs sit unannounced for too long;
 *  faster wastes CPU on `tmux capture-pane` syscalls during normal work. */
const SCRAPE_INTERVAL_MS = 1000;

/** Number of trailing pane lines we look at. Modal dialogs always anchor
 *  to the bottom of the pane; ignoring the rest avoids matching old
 *  output that scrolled past. */
const SCRAPE_TAIL_LINES = 40;

interface ScrapeMatch {
  /** Verbatim text the user will see in the UI card. */
  paneText: string;
  /** Buttons to render — `key` is what we send to tmux on click. */
  choices: TmuxPromptChoice[];
  /** Stable hash that survives across consecutive scrapes as long as the
   *  modal stays on screen unchanged. */
  fingerprint: string;
}

/** Recognise claude's standard numbered-choice modal:
 *
 *   Do you want to proceed?
 *   ❯ 1. Yes
 *     2. Yes, allow always
 *     3. No
 *
 * Different claude versions use `❯` or `›` as the cursor on the
 * selected line. We deliberately do NOT accept `>` — markdown
 * blockquotes (`> 1. some text`), CLI usage examples, and shell-prompt
 * captures all start with `>` and would otherwise misfire the matcher.
 * Choices are captured verbatim from the pane so the UI label matches
 * what was on screen. The `key` is the literal digit — typing it +
 * Enter dismisses the modal exactly the way the user would. */
function matchNumberedModal(tail: string): ScrapeMatch | null {
  const lines = tail.split("\n");
  const numbered: Array<{ key: string; label: string; cursorHere: boolean }> = [];
  for (const raw of lines) {
    const m = raw.match(/^\s*([›❯])?\s*(\d+)\.\s+(.+?)\s*$/);
    if (!m) continue;
    numbered.push({
      cursorHere: !!m[1],
      key: m[2]!,
      label: m[3]!.trim(),
    });
  }
  if (numbered.length < 2) return null;
  // Need at least one cursor marker on the numbered block — otherwise
  // we're probably looking at a printed list, not an interactive modal.
  if (!numbered.some((n) => n.cursorHere)) return null;
  // Take the contiguous trailing run of numbered lines (a list further
  // up the pane shouldn't poison the choice set).
  const tailRun: typeof numbered = [];
  for (let i = numbered.length - 1; i >= 0; i--) {
    tailRun.unshift(numbered[i]!);
    if (i > 0 && Number(numbered[i - 1]!.key) + 1 !== Number(numbered[i]!.key)) break;
  }
  if (tailRun.length < 2) return null;
  const choices: TmuxPromptChoice[] = tailRun.map((n) => ({ key: n.key, label: n.label }));
  // Use the last ~12 lines for the displayed pane snippet so the user
  // sees the question text + the choices, not 40 lines of unrelated
  // context above.
  const paneText = lines.slice(-12).join("\n").trimEnd();
  const fingerprint = sha1(`numbered:${choices.map((c) => `${c.key}|${c.label}`).join("/")}`);
  return { paneText, choices, fingerprint };
}

/** Recognise `(y/N)` / `(Y/n)` / `[y/n]` confirmation prompts on the
 *  last non-empty line. Lower priority than the numbered matcher — only
 *  fires when no numbered choices were found. */
function matchYesNoModal(tail: string): ScrapeMatch | null {
  const lines = tail.split("\n").filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1] ?? "";
  // Match patterns like `… (y/N)`, `… [Y/n]`, with optional trailing
  // whitespace or a `?`. Case-insensitive to forgive minor variants.
  if (!/[(\[][yYnN]\/[yYnN][)\]]\s*[?:]?\s*$/.test(last)) return null;
  // Default capital indicates the default answer if the user just hits
  // Enter — we surface both as explicit buttons regardless so the user
  // always picks consciously.
  const choices: TmuxPromptChoice[] = [
    { key: "y", label: "Yes" },
    { key: "n", label: "No" },
  ];
  const paneText = lines.slice(-6).join("\n").trimEnd();
  const fingerprint = sha1(`y-n:${last}`);
  return { paneText, choices, fingerprint };
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

/** TTL on the "just answered this fingerprint" suppression. Has to
 *  comfortably exceed the worst-case lag between sending Enter into
 *  tmux and claude repainting the pane without the modal. 3s is
 *  generous on a busy machine but cheap to wait through.  */
const RECENTLY_ANSWERED_TTL_MS = 3_000;

/** A scrape tick is skipped when the JSONL has been written to this
 *  recently — claude is mid-stream, so whatever's on the pane is
 *  likely transient output (a numbered list being printed) and not a
 *  stable modal awaiting input. */
const JSONL_RECENT_WRITE_MS = 500;

/** Beyond this idle window with no active turn, the scraper stops
 *  tick'ing entirely — there's no plausible scenario where a brand-
 *  new modal appears on a session that hasn't seen output in a long
 *  time. Idle sessions cost nothing this way. */
const SCRAPE_IDLE_AFTER_MS = 5_000;

/** Run a single scrape tick. Idempotent: registers at most one new
 *  TmuxPromptRequest per call, auto-cancels any pending one whose
 *  fingerprint no longer matches the pane. */
function scrapeOnce(state: SessionState): void {
  const now = Date.now();
  // Idle gate: skip the syscall entirely when nothing is plausibly
  // happening. A session with no turn in flight that hasn't appended
  // to its JSONL in 5s is at the REPL prompt; the user isn't waiting
  // on a modal we missed.
  if (state.turnQueue.length === 0
      && state.lastJsonlAppendAt !== 0
      && now - state.lastJsonlAppendAt > SCRAPE_IDLE_AFTER_MS
      && activeTmuxPromptsForTask(state.taskId).length === 0) {
    return;
  }

  const cap = tmux(["capture-pane", "-p", "-t", state.sessionName]);
  if (!cap.ok) {
    // Session vanished — let `disposeSessionState` clean us up the next
    // time the orchestrator notices. Don't churn here.
    return;
  }
  const lines = cap.stdout.split("\n");
  const tail = lines.slice(Math.max(0, lines.length - SCRAPE_TAIL_LINES)).join("\n");

  // JSONL-recency gate: claude is actively writing. The pane content
  // is mid-render, not a stable modal — defer matching until things
  // settle. We still run the auto-cancel sweep below so a previously
  // registered prompt that just disappeared can clear out.
  const claudeIsWriting = state.lastJsonlAppendAt !== 0
    && now - state.lastJsonlAppendAt < JSONL_RECENT_WRITE_MS;

  const match = claudeIsWriting
    ? null
    : (matchNumberedModal(tail) ?? matchYesNoModal(tail));

  // Auto-cancel: any registered prompt for this task whose fingerprint
  // is NOT what we see now has been dismissed (either externally via
  // `tmux attach`, or the dialog was transient). Resolve those entries
  // so the UI stops showing them.
  const stillPresent = new Set<string>(match ? [match.fingerprint] : []);
  for (const pending of activeTmuxPromptsForTask(state.taskId)) {
    if (!stillPresent.has(pending.fingerprint)) {
      answerTmuxPrompt(pending.id, { key: "__external__" });
    }
  }

  // Garbage-collect the recently-answered map. Cheap (typically 0–1
  // entries) and keeps stale fingerprints from leaking memory if a
  // session lives long enough to churn through hundreds of prompts.
  for (const [fp, ts] of state.recentlyAnsweredFingerprints) {
    if (now - ts > RECENTLY_ANSWERED_TTL_MS) {
      state.recentlyAnsweredFingerprints.delete(fp);
    }
  }

  if (!match) {
    state.scrapeLastFingerprint = null;
    return;
  }

  // Re-registration suppression: if the user *just* answered this
  // exact fingerprint, the modal may still be on the pane for one
  // more tick while tmux/claude finish repainting. Skip — without
  // this, the two-tick stability requirement (the previous tick
  // saw the same fingerprint) would register a ghost duplicate.
  if (state.recentlyAnsweredFingerprints.has(match.fingerprint)) {
    return;
  }

  // Two-tick stability — require the same match on two consecutive
  // scrapes before registering. Single-tick blips (a numbered list the
  // agent is printing) never make it through.
  if (state.scrapeLastFingerprint !== match.fingerprint) {
    state.scrapeLastFingerprint = match.fingerprint;
    return;
  }

  // Already registered? Nothing to do — the previous tick's broadcast
  // is what the UI is showing.
  if (findTmuxPromptByFingerprint(state.taskId, match.fingerprint)) return;

  // Look up the active run id for this task. We need it on the
  // interaction so the run panel can scope correctly; without one the
  // prompt would float unattached. Idle tasks (no run) skip — there's
  // nothing for the user to react to without an active session anyway.
  const runId = tasks.get(state.taskId)?.runId;
  if (!runId) return;

  registerTmuxPrompt({
    taskId: state.taskId,
    runId,
    paneText: match.paneText,
    choices: match.choices,
    fingerprint: match.fingerprint,
  });
}

/**
 * Stamp a fingerprint as "just answered" so the next scrape tick
 * doesn't immediately re-register a ghost copy while tmux/claude
 * finish repainting. Called by the `/tmux-prompts/:id/answer` route
 * right after `dismissTmuxPrompt`.
 *
 * No-op when there's no session for the task — same idempotent
 * behaviour as `dismissTmuxPrompt` on a torn-down session.
 */
export function markTmuxPromptAnswered(taskId: string, fingerprint: string): void {
  const state = sessions.get(taskId);
  if (!state) return;
  state.recentlyAnsweredFingerprints.set(fingerprint, Date.now());
  // Clear the stability cursor so the next match has to re-stabilise
  // before it can register again — this defends against the case where
  // the same fingerprint genuinely re-appears later (the user answered,
  // claude immediately printed an identical-looking dialog), without
  // racing the registration.
  state.scrapeLastFingerprint = null;
}

/** Install or refresh the scraper interval for a session. Called from
 *  `attachTailer`; torn down by `disposeSessionState`. */
function startScraper(state: SessionState): void {
  if (state.scrapeTimer) return;
  state.scrapeTimer = setInterval(() => {
    try { scrapeOnce(state); } catch { /* swallow — never crash the timer */ }
  }, SCRAPE_INTERVAL_MS);
}

function attachTailer(state: SessionState): void {
  // Drain whatever's already in the file (claude may have written events
  // before our watcher attached).
  void flush(state);
  state.watcher = fsWatch(state.jsonlPath, { persistent: false }, () => {
    void flush(state);
  });
  // Backstop poll. macOS fs.watch (FSEvents/kqueue) coalesces rapid appends
  // and drops notifications on slow append-only streams — we saw a real run
  // where the first event came through fine and then 16 more events silently
  // accumulated in the JSONL without firing the watcher. A 400ms tick is
  // cheap (one stat + read-if-grew) and bulletproof.
  state.pollTimer = setInterval(() => { void flush(state); }, 400);
  startScraper(state);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Public entry points.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Start a new claude tmux session for the task. The initial prompt rides
 * inside `opts.argv` (claude's documented `claude "query"` form), so we
 * don't paste anything via tmux for the first turn — claude submits it
 * itself on startup. Assumes `sessionExists(taskId)` is false; the caller
 * (orchestrator) is responsible for routing follow-up turns through
 * `sendTurn`.
 */
export function spawnClaudeViaTmux(opts: ClaudeLaunchOptions): SpawnedAgent {
  const sessionName = sessionNameFor(opts.taskId);

  // Install the PreToolUse hook + ask_user MCP server before tmux starts
  // so claude picks them up from `.claude/settings.local.json` on launch.
  // Owned worktrees get an overwrite install; user-repo cwds (isolation=
  // none) get a merge install that preserves any existing user hooks /
  // mcpServers.
  //
  // Scope depends on `opts.mode`:
  //  - `auto` and `bypass` → narrow matcher (only AskUserQuestion +
  //    ExitPlanMode). In `auto` this is what lets claude's own auto-mode
  //    classifier handle every other tool call — PreToolUse hooks are
  //    terminal when they match, so a `.*` matcher would short-circuit
  //    the classifier and force every tool through agetor's UI.
  //  - `ask` / `plan` / `acceptEdits` / default → full `.*` matcher;
  //    per-tool cards render in the run panel.
  ensureInstalledForCwd(opts.cwd, opts.mode);

  // Build the tmux command. `-e KEY=VAL` injects env vars into the new
  // session (so the spawned claude inherits them); `--` separates the tmux
  // flags from the command to run.
  //
  // We unconditionally inject our localhost API coordinates so the hook
  // script + MCP server can reach back. These are no-ops on isolation=none
  // tasks (no settings.local.json registers them), but they don't hurt.
  //
  // PATH is injected explicitly because the tmux *server* captures env at
  // its first launch and reuses it for every subsequent session — passing
  // it per-session via `-e` guarantees the spawned claude sees the
  // currently-rehydrated PATH even if the server's captured copy is stale
  // (e.g. agetor restarted with a different login-shell PATH but the
  // long-running bundled tmux server is still around).
  const fullEnv: Record<string, string> = {
    ...opts.env,
    PATH: process.env.PATH ?? "",
    AGETOR_API_PORT: String(getApiPort()),
    AGETOR_API_TOKEN: API_TOKEN,
    AGETOR_TASK_ID: opts.taskId,
  };
  const tmuxArgs: string[] = ["new-session", "-d", "-s", sessionName, "-c", opts.cwd];
  for (const [k, v] of Object.entries(fullEnv)) tmuxArgs.push("-e", `${k}=${v}`);
  tmuxArgs.push("--", ...opts.argv);

  const launch = tmux(tmuxArgs);
  if (!launch.ok) {
    const err = new Error(`tmux new-session failed: ${launch.stderr || launch.stdout}`);
    opts.onChunk("stderr", err.message);
    return rejectedAgent(opts.taskId, err);
  }

  // The JSONL path is deterministic from cwd + session uuid (we passed
  // `--session-id <uuid>` for new sessions, and `--resume <id>` reopens an
  // existing file at the same path). No mtime poll, no freshest-file pick.
  const jsonlPath = jsonlPathFor(opts.cwd, opts.sessionId, opts.home);

  // Allocate the per-session state up front so flush() can find it.
  const state: SessionState = {
    taskId: opts.taskId,
    sessionName,
    cwd: opts.cwd,
    jsonlPath,
    offset: 0,
    watcher: null,
    pollTimer: null,
    turnQueue: [],
    lastChunk: null,
    seenLineUuids: new Set(),
    onEndOfTurn: null,
    // Canonical claude mode string (e.g. "plan", "bypassPermissions"),
    // not the agetor-internal id ("plan", "bypass"). Seeding here means
    // the plan-mode safety check in `/approvals` works from the very
    // first PreToolUse hook — before the JSONL has even been opened.
    // The JSONL's `system` event will overwrite this within a tick if
    // claude renegotiates, which is fine.
    permissionMode: opts.mode ? toClaudeModeString(opts.mode) : null,
    // `bypass` is the only agetor mode that emits the launch flag
    // (--dangerously-skip-permissions) — that's what puts
    // `bypassPermissions` into the Shift+Tab cycle.
    bypassEnabled: opts.mode === "bypass",
    scrapeTimer: null,
    scrapeLastFingerprint: null,
    lastJsonlAppendAt: 0,
    recentlyAnsweredFingerprints: new Map(),
  };
  sessions.set(opts.taskId, state);

  const done = new Promise<number>((resolve, reject) => {
    state.turnQueue.push({ onChunk: opts.onChunk, resolve, reject });
  });
  // Brand-new session has no prior turn to inherit metadata from, but
  // seed `lastChunk` so any metadata claude writes before its first
  // user/assistant entries (e.g. permission-mode banner) still lands on
  // the opening run's stream.
  state.lastChunk = opts.onChunk;

  // Bounded wait for claude to create the JSONL. This is just claude's
  // bootup (auth probe, plugin/skill scan, model warmup, MCP initialize on
  // configured servers). Generous because on big projects the local
  // skill scan can take 15s+; the fs.watch trigger means we attach as
  // soon as it appears regardless.
  const BOOT_TIMEOUT_MS = 30_000;
  (async () => {
    const found = await waitForJsonlAt(jsonlPath, BOOT_TIMEOUT_MS);
    if (!found) {
      const stillAlive = tmux(["has-session", "-t", sessionName]).ok;
      // Capture whatever claude actually printed inside the pane so the user
      // sees the real cause (unknown flag, MCP initialize hung, auth prompt
      // waiting, …) rather than just "no JSONL".
      const paneRaw = stillAlive
        ? tmux(["capture-pane", "-p", "-t", sessionName, "-S", "-200"]).stdout
        : "";
      const pane = paneRaw.trim() || "(empty — claude has not drawn any TUI output yet)";
      const detail = stillAlive
        ? `claude is up but hasn't written its JSONL yet after ${(BOOT_TIMEOUT_MS / 1000) | 0}s — pane content below`
        : "claude exited before writing its JSONL — check `tmux` / `claude` are installed and you can run `claude` interactively in this cwd";
      opts.onChunk("stderr", `claude session JSONL never appeared: ${detail}`);
      opts.onChunk("stderr", `expected at: ${jsonlPath}`);
      opts.onChunk("stderr", `--- tmux pane ---\n${pane}\n--- end pane ---`);
      killTaskSession(opts.taskId);
      sessions.delete(opts.taskId);
      // Reject every queued turn so all dependent promises settle.
      const err = new Error("jsonl-discovery-timeout");
      for (const slot of state.turnQueue.splice(0)) slot.reject?.(err);
      return;
    }
    attachTailer(state);
    opts.onChunk("status", `claude session ${sessionName} ready (jsonl: ${jsonlPath})`);
  })();

  return makeAgent(opts.taskId, done);
}

export interface ReattachOptions {
  taskId: string;
  cwd: string;
  sessionId: string;
  home: string | null;
  /** Per-run chunk handler that persists to run_events + broadcasts on SSE.
   *  Built by the orchestrator the same way it does for fresh runs. */
  onChunk: ChunkHandler;
  /** Dedup set seeded from `runs.seenLineUuids(runId)`. The dispatcher skips
   *  any line whose uuid is already in this set, preventing double-emission
   *  of events that the previous process already streamed and persisted. */
  seenLineUuids: Set<string>;
}

/**
 * Reattach to a tmux session that survived an agetor restart. Rebuilds the
 * in-memory `SessionState`, installs the file watcher + poll backstop, and
 * replays the JSONL from offset 0 — the dedup set filters out anything we
 * already streamed in the prior process. The returned SpawnedAgent's `done`
 * promise resolves on the next end-of-turn (so the orchestrator can route
 * it through the same `attachDoneHandler` as a fresh run).
 *
 * Returns `null` when the JSONL doesn't exist (caller should treat the run
 * as orphaned and kill the tmux session — without the JSONL we'd have no
 * structured visibility into the session anyway).
 */
export function reattachSession(opts: ReattachOptions): SpawnedAgent | null {
  const sessionName = sessionNameFor(opts.taskId);
  const jsonlPath = jsonlPathFor(opts.cwd, opts.sessionId, opts.home);
  if (!existsSync(jsonlPath)) return null;

  let resolveDone: ((code: number) => void) | null = null;
  let rejectDone: ((err: Error) => void) | null = null;
  const done = new Promise<number>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  const state: SessionState = {
    taskId: opts.taskId,
    sessionName,
    cwd: opts.cwd,
    jsonlPath,
    offset: 0,
    watcher: null,
    pollTimer: null,
    turnQueue: [],
    // Trailing metadata that lands before the first new turn slot still
    // wants to flow to run_events — route it through the reattach handler
    // by seeding lastChunk, same pattern as spawnClaudeViaTmux.
    lastChunk: opts.onChunk,
    seenLineUuids: opts.seenLineUuids,
    onEndOfTurn: () => resolveDone?.(0),
    // Replaying the JSONL from offset 0 re-runs every historical
    // `system` / `permission-mode` line through `dispatchLine`. The
    // permissionMode update there sits above the seenLineUuids dedup
    // check, so even when the line's uuid is already in the dedup set
    // (pre-seeded from run_events on reattach) the field still gets
    // overwritten with whatever mode claude is currently in.
    permissionMode: null,
    // The launch flag isn't persisted across agetor restarts, so we can't
    // tell whether bypassPermissions is in the cycle on this reattach.
    // Conservatively assume not — cycling to bypass after a restart needs
    // a respawn (claude requires the flag at launch anyway).
    bypassEnabled: false,
    scrapeTimer: null,
    scrapeLastFingerprint: null,
    lastJsonlAppendAt: 0,
    recentlyAnsweredFingerprints: new Map(),
  };
  // Belt to reconcileOrphans's sort-and-dedup suspender: if some prior
  // reattach (or other code path) already left a SessionState in the map
  // for this taskId, dispose its watcher + pollTimer before we overwrite
  // it. Without this, an overwritten state's interval keeps firing on a
  // stale closure — every JSONL append would be dispatched twice (once
  // per state's onChunk), spraying duplicate events into the wrong run.
  disposeSessionState(sessions.get(opts.taskId));
  sessions.set(opts.taskId, state);
  attachTailer(state);

  return {
    kill: () => {
      const s = sessions.get(opts.taskId);
      if (!s) return;
      // Stop-the-turn semantics match `makeAgent`: send Ctrl+C, reject any
      // queued slots (none here, but future-proof), reject the reattach
      // done promise so the orchestrator's done-handler records `cancelled`.
      tmux(["send-keys", "-t", s.sessionName, "C-c"]);
      const err = new Error("cancelled");
      for (const slot of s.turnQueue.splice(0)) slot.reject?.(err);
      s.onEndOfTurn = null;
      rejectDone?.(err);
    },
    writeInput: (line) => {
      const s = sessions.get(opts.taskId);
      if (!s) return false;
      pastePrompt(s.sessionName, line);
      return true;
    },
    done,
  };
}

/**
 * Send a follow-up prompt to an existing claude tmux session. Returns a
 * fresh SpawnedAgent whose `done` resolves on the NEXT end_turn after this
 * paste. Caller must ensure `sessionExists(taskId)` is true.
 */
export function sendTurn(taskId: string, prompt: string, onChunk: ChunkHandler): SpawnedAgent {
  const state = sessions.get(taskId);
  if (!state) {
    const err = new Error(`no live session for task ${taskId}`);
    onChunk("stderr", err.message);
    return rejectedAgent(taskId, err);
  }
  // Drain any unprocessed JSONL content under whatever turn is currently
  // active BEFORE pushing the new slot — otherwise a trailing end_turn
  // already in the file would be dispatched against the new slot and
  // pop it immediately. After flushSync, the queue head reflects the
  // truly in-flight turn (or is empty if the previous turn just ended).
  flushSync(state);
  const done = new Promise<number>((resolve, reject) => {
    state.turnQueue.push({ onChunk, resolve, reject });
  });
  // Claude's TUI input buffer accepts keystrokes even mid-response —
  // anything we paste while the agent is thinking gets queued there and
  // replayed as a new user turn once the current one finishes. Our
  // `turnQueue` mirrors that: subsequent end_turn events pop slots in
  // FIFO order.
  pastePrompt(state.sessionName, prompt);
  return makeAgent(taskId, done);
}

/**
 * Send a slash-command (or any literal keystroke line) to the task's tmux
 * session. The line is pasted via load-buffer + paste-buffer + Enter just like
 * a user prompt, so multi-word commands and embedded spaces survive intact.
 * Returns false when no live session exists for the task — caller decides
 * whether to spawn fresh or surface an error.
 *
 * Used by the orchestrator to mirror inline config edits onto a live claude
 * session: `/model <id>`, `/effort <id>`. (Permission-mode changes don't have
 * a slash command — see `cycleToMode`.) Keeping the session alive preserves
 * the conversation context across config changes.
 */
export function sendSlashCommand(taskId: string, line: string): boolean {
  const state = sessions.get(taskId);
  if (!state) return false;
  pastePrompt(state.sessionName, line);
  return true;
}

export type CycleResult =
  | { ok: true; presses: number; via: "noop" | "slash-plan" | "shift-tab" }
  | { ok: false; reason: string };

/**
 * Switch a live claude session's permission mode to `targetAgetorMode` by
 * sending the right number of `Shift+Tab` keystrokes (claude's only
 * mid-session mode-switch mechanism — there's no `/permission-mode` slash
 * command despite what the prior code assumed). For the `plan` target we
 * prefer the `/plan` slash command instead: it's deterministic, doesn't
 * depend on knowing the current mode, and works from anywhere.
 *
 * Returns:
 *   - `{ ok: true, via: "noop" }` when the session is already at the target.
 *   - `{ ok: true, via: "slash-plan" }` when we sent `/plan`.
 *   - `{ ok: true, via: "shift-tab", presses: N }` when we sent N tabs.
 *   - `{ ok: false, reason: "no live session" }` for an unknown task.
 *   - `{ ok: false, reason: "current mode unknown" }` before claude's first
 *     `system` event has arrived (rare — typically only at the very start of
 *     a session before its first JSONL entry).
 *   - `{ ok: false, reason: "unreachable in current cycle" }` when the
 *     target isn't in this session's cycle. The most common case is asking
 *     for `bypassPermissions` on a session that wasn't launched with the
 *     enabling flag — a respawn is required.
 *
 * Caveat — first cycle to `auto`: claude shows a one-time opt-in modal the
 * first time you cycle to auto on a given account. Our keystrokes pass
 * through but the cycle pauses on the modal until the user (or some other
 * keystroke) dismisses it. After the first acceptance, subsequent cycles
 * work without intervention.
 */
export function cycleToMode(taskId: string, targetAgetorMode: string): CycleResult {
  const state = sessions.get(taskId);
  if (!state) return { ok: false, reason: "no live session" };
  const target = toClaudeModeString(targetAgetorMode);

  // `/plan` works from any state, no cycle math needed. Prefer it.
  // No optimistic state update here — `pastePrompt` is fire-and-forget
  // (its tmux load-buffer / paste-buffer / send-keys helpers swallow
  // errors), so claiming success before claude has acknowledged would
  // lie when the paste fails. The JSONL `permission-mode` event that
  // follows `/plan` is the authoritative source.
  if (target === CLAUDE_MODE_PLAN) {
    pastePrompt(state.sessionName, "/plan");
    return { ok: true, presses: 0, via: "slash-plan" };
  }

  const current = state.permissionMode;
  if (!current) return { ok: false, reason: "current mode unknown" };
  if (current === target) return { ok: true, presses: 0, via: "noop" };

  const cycle = cycleOrderFor(state.bypassEnabled);
  const presses = cycleDistance(cycle, current, target);
  if (presses === null) {
    return { ok: false, reason: `mode '${target}' not in this session's cycle` };
  }
  if (presses > 0) {
    // One tmux invocation with N keys — cleaner than N sync spawns, and
    // tmux delivers them as a single stream so claude's TUI doesn't get
    // a chance to debounce them apart on slow terminals.
    const keys = Array<string>(presses).fill("S-Tab");
    tmux(["send-keys", "-t", state.sessionName, ...keys]);
  }
  // Optimistic local update. The JSONL `permission-mode` event will arrive
  // shortly after and overwrite this with claude's authoritative value —
  // if a press landed somewhere unexpected (e.g. account isn't auto-eligible)
  // the event corrects state.
  state.permissionMode = target;
  return { ok: true, presses, via: "shift-tab" };
}

/**
 * Tear down per-task state for `taskId` and kill the tmux session. Used by
 * deleteTask and reconcileOrphans.
 */
export function dropSession(taskId: string): void {
  const state = sessions.get(taskId);
  if (state) {
    disposeSessionState(state);
    sessions.delete(taskId);
  }
  killTaskSession(taskId);
}

/** Close any watcher / interval timer held by a SessionState and reject any
 *  queued turn slots so dependent promises settle. Used both by
 *  `dropSession` (intentional teardown) and by `reattachSession` (defensive
 *  cleanup before overwriting an entry in the sessions map). Safe to call
 *  with `undefined` so the caller can pass `sessions.get(taskId)` directly. */
function disposeSessionState(state: SessionState | undefined): void {
  if (!state) return;
  state.watcher?.close();
  state.watcher = null;
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
  if (state.scrapeTimer) clearInterval(state.scrapeTimer);
  state.scrapeTimer = null;
  state.scrapeLastFingerprint = null;
  state.onEndOfTurn = null;
  const err = new Error("session killed");
  for (const slot of state.turnQueue.splice(0)) slot.reject?.(err);
}

function makeAgent(taskId: string, done: Promise<number>): SpawnedAgent {
  return {
    kill: () => {
      // Interrupt every queued turn for this task. Ctrl+C aborts whatever
      // claude is doing in the TUI and clears its queued-input buffer
      // (anything we'd pasted while it was thinking). Reject the full
      // queue so each run's done settles with "cancelled".
      const state = sessions.get(taskId);
      if (!state) return;
      tmux(["send-keys", "-t", state.sessionName, "C-c"]);
      const err = new Error("cancelled");
      for (const slot of state.turnQueue.splice(0)) slot.reject?.(err);
    },
    writeInput: (line) => {
      const state = sessions.get(taskId);
      if (!state) return false;
      pastePrompt(state.sessionName, line);
      return true;
    },
    done,
  };
}

function rejectedAgent(_taskId: string, err: Error): SpawnedAgent {
  return {
    kill: () => { /* nothing to kill */ },
    writeInput: () => false,
    done: Promise.reject(err),
  };
}

// Test-only helpers — let claude-tmux.test.ts drive the turn-queue
// dispatch logic against a real temp JSONL file without going through
// tmux. Not part of the public surface.
export const __forTest = {
  /** Register a synthetic session keyed on taskId, returning the queue
   *  + offset surface for assertions. */
  installSession(taskId: string, jsonlPath: string): SessionState {
    const state: SessionState = {
      taskId,
      sessionName: `agetor-test-${taskId}`,
      cwd: "/tmp",
      jsonlPath,
      offset: 0,
      watcher: null,
      pollTimer: null,
      turnQueue: [],
      lastChunk: null,
      seenLineUuids: new Set(),
      onEndOfTurn: null,
      permissionMode: null,
      bypassEnabled: false,
      scrapeTimer: null,
      scrapeLastFingerprint: null,
      lastJsonlAppendAt: 0,
      recentlyAnsweredFingerprints: new Map(),
    };
    sessions.set(taskId, state);
    return state;
  },
  uninstallSession(taskId: string) { sessions.delete(taskId); },
  pushTurnSlot(state: SessionState, onChunk: ChunkHandler): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      state.turnQueue.push({ onChunk, resolve, reject });
    });
  },
  flushSync,
  flush,
  dispatchLine,
  matchNumberedModal,
  matchYesNoModal,
};

/**
 * Send `text` as a single user turn to the named tmux session. We pipe via
 * `load-buffer -` to avoid shell-quoting issues (the prompt may contain
 * newlines, dollar signs, quotes, …), paste it into the active window, then
 * press Enter to submit.
 */
function pastePrompt(sessionName: string, text: string): void {
  // load-buffer reads from stdin; -b names a tmux buffer we can target.
  const buf = `agetor-${sessionName}`;
  const load = tmux(["load-buffer", "-b", buf, "-"], { stdinText: text });
  if (!load.ok) return;
  tmux(["paste-buffer", "-b", buf, "-t", sessionName]);
  tmux(["delete-buffer", "-b", buf]);
  tmux(["send-keys", "-t", sessionName, "Enter"]);
}
