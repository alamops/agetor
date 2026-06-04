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
import { tasks } from "./db.ts";
import { ensureInstalledForCwd } from "./hook-installer.ts";
import {
  activeTmuxPromptsForTask,
  answerTmuxPrompt,
  findTmuxPromptByFingerprint,
  registerScrapedAskQuestions,
  registerTmuxPrompt,
  resolveScrapedAskQuestions,
  type AskQuestion,
  type TmuxPromptChoice,
} from "./interactions.ts";
import { resolveTmuxBin } from "./tmux-resolution.ts";
import { detectAskModal, parseModalPane, type NavKey } from "./claude-questions.ts";

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
   * Per-harness config-dir override (passed to claude as CLAUDE_CONFIG_DIR).
   * When set, claude writes its JSONL under `<configDir>/projects/…` — the
   * path itself replaces `~/.claude/`. NULL falls back to
   * `~/.claude/projects/…`. This is how multi-account harnesses keep their
   * login & history separate. Sourced from `Harness.home` at the call site.
   */
  configDir: string | null;
  /**
   * Agetor permission mode for this task (see AGENT_OPTIONS in
   * shared/types.ts). Drives `--permission-mode` / `--dangerously-skip-
   * permissions` on the claude launch argv. (agetor no longer installs any
   * PreToolUse hook or MCP server, so this no longer influences settings
   * installation — see `ensureInstalledForCwd` in hook-installer.ts.)
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
  /** Per-assistant-message id claude stamps so a turn split across multiple
   *  JSONL lines (text → tool_use → text … all with the same `message.id`)
   *  can be coalesced. `isEndTurnContinuation` matches against this to
   *  defer firing a staged end_turn while same-message lines are still
   *  arriving. */
  id?: string;
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
  /** Claude 2.1.x system events carry a `subtype` discriminator — observed
   *  values: `turn_duration` (durationMs + messageCount, emitted right after
   *  an assistant end_turn) and `away_summary` (recap text claude generated
   *  for resumption). Older events leave this null. */
  subtype?: string;
  uuid?: string;
  message?: AssistantMessage & UserMessage;
  permissionMode?: string;
  summary?: string;
  /** Origin tag claude stamps on *synthetic* `user` entries — messages it
   *  injects on the user's behalf rather than the human typing them. Genuine
   *  human prompts carry no `origin` at all, so this is effectively a marker
   *  for "not a real turn." The only kind observed so far is
   *  `task-notification` (background `run_in_background` Bash completions);
   *  if claude adds more synthetic kinds, extend the filter below. */
  origin?: { kind?: string };
  /** Claude sets this on `user` entries it injects itself (slash-command
   *  caveats, skill base-dir injections, "tool call was malformed" retries,
   *  Stop-hook notices, …) rather than the human typing them. Genuine human
   *  prompts and tool_result envelopes are `isMeta:null`, so this is a reliable
   *  "not a real turn" marker. We demote any isMeta entry to a status
   *  breadcrumb. `origin.kind` (above) is a narrower, nicer-summarized subset. */
  isMeta?: boolean;
  /** Claude 2.1.x `queue-operation` events carry `operation` (`enqueue` /
   *  `remove`) and, on enqueue, a string `content` payload. This is where
   *  background task-notifications now arrive — older versions delivered
   *  them as synthetic `user` entries with `origin.kind: "task-notification"`. */
  operation?: string;
  content?: string;
  /** `system{subtype:"turn_duration"}` carries the turn's wall-clock duration
   *  in milliseconds — surfaced as a status breadcrumb so the user sees how
   *  long the turn took. */
  durationMs?: number;
  /** Claude code stamps `isApiErrorMessage: true` (with `model: "<synthetic>"`
   *  and `stop_reason: "stop_sequence"`) on assistant lines it synthesises to
   *  surface an Anthropic API failure to the user (e.g. 529 Overloaded, 400
   *  validation errors). The text block carries the user-facing error string.
   *  These never get a real `end_turn`, so without special-casing them the
   *  run would sit in `running` forever. */
  isApiErrorMessage?: boolean;
  /** HTTP status of the underlying API failure (paired with isApiErrorMessage). */
  apiErrorStatus?: number;
}

/** Status-chunk prefix the orchestrator looks for to flip a claude task into
 *  the `blocked` column when the agent hit an API error mid-turn. The colon +
 *  space act as a separator so a future status starting with the word "api"
 *  can't accidentally match. Centralised so the producer (claude-tmux) and
 *  consumer (orchestrator) can't drift. */
export const CLAUDE_API_ERROR_STATUS_PREFIX = "api error: ";

/**
 * True for an assistant JSONL line that claims to end a turn. Used by
 * `dispatchLine` to decide whether to stage a pending end_turn. The claim
 * may be spurious — claude stamps `stop_reason: "end_turn"` on *every* split
 * line of a response (thinking, text, tool_use) even when the message is
 * still mid-flight calling tools. `isEndTurnContinuation` in `dispatchLine`
 * cancels the staged pending when the next line proves the turn isn't over.
 */
function isEndOfTurnEvent(evt: ParsedJsonlEvent): boolean {
  if (evt.type !== "assistant") return false;
  // API-error messages never carry stop_reason: "end_turn" (they're
  // synthetic — claude stamps stop_reason: "stop_sequence"), but they
  // terminate the turn just as definitively from the orchestrator's
  // perspective. Treat them as turn-ends here so the reattach replay path
  // also stages them; the live path is covered by mapParsedEventToChunks
  // returning endOfTurn:true on the same predicate.
  return evt.message?.stop_reason === "end_turn" || evt.isApiErrorMessage === true;
}

/**
 * True when `next` proves that a staged end_turn was spurious — i.e. the
 * turn is still in progress. Two cases:
 *
 * 1. Another split line of the *same* API-response message — claude stamped
 *    `end_turn` on every block of the response, not just the last one.
 *    Detected by matching `message.id` on both the staged and new lines.
 *
 * 2. A `user` line carrying `tool_result` blocks — the staged end_turn line
 *    contained a tool_use, and this is the result coming back. The turn
 *    cannot be over if a tool call is still being serviced.
 */
function isEndTurnContinuation(
  next: ParsedJsonlEvent,
  stagedMessageId: string | null,
): boolean {
  if (next.type === "assistant"
      && stagedMessageId !== null
      && next.message?.id === stagedMessageId) return true;
  if (next.type === "user") {
    const content = next.message?.content;
    if (Array.isArray(content) && content.some((b) => b?.type === "tool_result")) return true;
  }
  return false;
}

/** A user message whose tool_result is claude's interrupt/cancel marker (Esc on
 *  a modal, Ctrl+C). `dispatchLine` force-resolves the run on these — see the
 *  force-end at the bottom of `dispatchLine`. */
function isInterruptUserEvent(evt: ParsedJsonlEvent): boolean {
  return evt.type === "user"
    && Array.isArray(evt.message?.content)
    && isUserInterruptResult(evt.message!.content as ContentBlock[]);
}

/** claude's canonical user-interrupt / tool-rejection text, written as the
 *  tool_result when the user cancels an in-flight tool (Esc on a modal, Ctrl+C).
 *  Matched loosely so minor wording changes across versions still register. */
const USER_INTERRUPT_RE =
  /doesn't want to proceed with this tool use|Request interrupted by user|tool use was rejected/i;

/** Plain text of a tool_result block's `content` — a string, or an array of
 *  text blocks (claude uses both shapes). */
function toolResultText(content: unknown): string {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((x) => (x && typeof x === "object" && (x as { type?: string }).type === "text"
            ? (x as { text?: string }).text ?? ""
            : ""))
          .join("")
      : "";
}

/** True when any tool_result block in this user message is the user-interrupt
 *  marker rather than a real tool result — see `isEndTurnContinuation`. */
function isUserInterruptResult(content: ContentBlock[]): boolean {
  return content.some((b) => b?.type === "tool_result" && USER_INTERRUPT_RE.test(toolResultText(b.content)));
}

/** Human-friendly millisecond formatter for `turn_duration` breadcrumbs.
 *  Mirrors how the rest of the run panel writes durations (seconds for
 *  short turns; minutes+seconds beyond a minute). Kept inline rather than
 *  pulled from a shared util because this is the only consumer and the
 *  rules are trivial. */
function formatTurnDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  // Round to whole seconds first, then branch — otherwise 59_999ms
  // rounds-to-print as "60s" instead of rolling over to "1m".
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds - m * 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
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
      // Background-task completion notifications: claude re-injects the
      // `<task-notification>…</task-notification>` blob as a synthetic
      // user message (tagged `origin.kind: "task-notification"`) so the
      // model picks up the result on its next turn. It is NOT a human turn
      // — surface it as a dim status breadcrumb instead of a user bubble.
      // Deny-known-synthetic, allow-by-default: we only demote kinds we've
      // confirmed are non-human (today just `task-notification`). If another
      // synthetic kind starts leaking into the panel as a user bubble, add
      // it here rather than blanket-filtering every `origin`-bearing entry —
      // a future human prompt could plausibly gain an origin too.
      if (evt.origin?.kind === "task-notification") {
        const text = typeof content === "string" ? content : "";
        const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim();
        onChunk("status", summary ? `background task: ${summary}` : "background task completed", uuid);
        return { endOfTurn: false, lineUuid: uuid };
      }
      // Any other synthetic user entry: claude flags messages it injects on the
      // user's behalf with `isMeta: true` (slash-command caveats, skill base-dir
      // injections, malformed-tool-call retries, Stop-hook notices). These are
      // NOT human turns — demote to a dim status breadcrumb, never a YOU bubble.
      // Human prompts and tool_result envelopes are `isMeta:null`, so this is safe.
      if (evt.isMeta === true) {
        const hasContent =
          (typeof content === "string" && content.length > 0) ||
          (Array.isArray(content) && content.length > 0);
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join(" ")
              : "";
        // Strip a leading wrapper tag (`<local-command-caveat>`, `<task-notification>`,
        // …) so the breadcrumb reads as prose rather than raw markup.
        // Split on any newline form — tmux/claude can leak `\r`-only
        // separators into synthetic entries (same root cause as the
        // human-turn CR normalization above), and `split("\n")` alone
        // would leave the whole blob as one mashed line.
        const firstLine =
          text.replace(/^\s*<[^>]+>/, "").split(/\r\n?|\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
        const summary = firstLine.length > 140 ? firstLine.slice(0, 137) + "…" : firstLine;
        // Never let a synthetic entry vanish without a trace: if it had content
        // but yielded no text line (e.g. a non-text block), emit a generic label
        // instead of silently dropping it. Truly empty entries stay silent.
        const data = summary || (hasContent ? "synthetic message" : "");
        if (data) onChunk("status", data, uuid);
        return { endOfTurn: false, lineUuid: uuid };
      }
      // The human's interactive turn. We DO emit a "user" stream event
      // here — both for the run-panel rendering (so the bubble appears
      // alongside assistant text) and so a rebuild-from-JSONL contains
      // the user messages. Live `sendInput` ALSO emits "user" via the
      // orchestrator's onChunk, and `startTask` echoes the initial
      // prompt the same way; the run panel's dedup keys user events on
      // (runId, data) only (ignoring ts), so the live + JSONL paths
      // collapse into one bubble per message.
      //
      // Normalize CR-only / CRLF newlines to `\n` before emitting. tmux's
      // paste-buffer delivers our `\n`-separated prompt to claude's TUI as
      // `\r`, and claude transcribes those `\r` characters into the JSONL
      // verbatim. The live emit uses `\n`, so without this normalization
      // the live and JSONL `data` strings differ byte-for-byte and the
      // panel's dedup (keyed on `data.slice(0,200)`) misses → duplicate
      // bubble for every multi-line user message.
      if (typeof content === "string") {
        if (content) onChunk("user", content.replace(/\r\n?/g, "\n"), uuid);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "tool_result") {
            // A user-interrupt tool_result (you rejected a plan / Esc'd a
            // question / Ctrl+C) is claude's internal "STOP, the user rejected
            // this" text, which it marks `is_error: true`. From the user's POV
            // that's not an error — they chose it — and the verbose text is
            // noise. Show a short, neutral note instead of a red ERROR RESULT.
            const isInterrupt = USER_INTERRUPT_RE.test(toolResultText(block.content));
            const isError = (block.is_error ?? false)
              && !isInterrupt;
            onChunk("tool_result", JSON.stringify({
              toolUseId: block.tool_use_id ?? "",
              content: isInterrupt ? "Declined — Claude is waiting for your direction." : block.content,
              isError,
            }), uuid);
          } else if (block?.type === "text" && block.text) {
            onChunk("user", block.text.replace(/\r\n?/g, "\n"), uuid);
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
      // Synthetic API-error message — claude code injects these when the
      // Anthropic API call fails (529 Overloaded, 400 validation, etc.).
      // The text block above already surfaced the user-facing error string;
      // emit a sentinel `status` chunk the orchestrator can pattern-match on
      // to flip the task into the `blocked` column, and signal endOfTurn so
      // the run row resolves instead of sitting in `running` forever.
      //
      // Emitted with `uuid: undefined` (not the JSONL line uuid) on purpose:
      // the assistant text block above was just appended to run_events with
      // that uuid, and the partial unique index on `(run_id, line_uuid)`
      // would silently drop this status via INSERT OR IGNORE if we reused
      // it. The NULL key path inserts unconditionally, so the breadcrumb
      // also shows up on panel reload — not just live SSE.
      if (evt.isApiErrorMessage === true) {
        const detail = typeof evt.apiErrorStatus === "number"
          ? `HTTP ${evt.apiErrorStatus} — turn aborted; blocked for manual retry`
          : "turn aborted; blocked for manual retry";
        onChunk("status", `${CLAUDE_API_ERROR_STATUS_PREFIX}${detail}`);
        return { endOfTurn: true, lineUuid: uuid };
      }
      // Signal a candidate turn-end. `dispatchLine` stages this and confirms
      // it's real only when the *next* line is not a same-message continuation
      // or a tool_result — see `isEndTurnContinuation`. The "turn complete"
      // banner is emitted there, not here, so it never fires for spurious
      // mid-flight splits (claude stamps end_turn on every content block of
      // a response, not just the last one).
      if (msg.stop_reason === "end_turn") {
        return { endOfTurn: true, lineUuid: uuid };
      }
      return { endOfTurn: false, lineUuid: uuid };
    }

    case "system":
    case "permission-mode":
      if (evt.permissionMode) {
        onChunk("status", `permission-mode: ${evt.permissionMode}`, uuid);
      } else if (evt.subtype === "turn_duration" && typeof evt.durationMs === "number") {
        // Emitted right after the assistant end_turn. The end_turn itself
        // already produced a "turn complete" status; this just adds the
        // duration so the user can see at a glance whether the turn was
        // quick or long. The `away_summary` subtype that sometimes follows
        // stays silent — it's claude's own resumption context, not
        // user-relevant.
        onChunk("status", `turn duration: ${formatTurnDuration(evt.durationMs)}`, uuid);
      }
      return { endOfTurn: false, lineUuid: uuid };

    case "summary":
      // Context-compaction checkpoint claude inserts when older turns get
      // rolled up. Useful breadcrumb in the log.
      if (evt.summary) onChunk("status", `summary: ${evt.summary}`, uuid);
      return { endOfTurn: false, lineUuid: uuid };

    case "queue-operation": {
      // Claude 2.1.x delivers background-task completion notifications via
      // queue-operation events: `enqueue` carries the `<task-notification>`
      // payload, `remove` is the matching pop once claude has consumed it.
      // Older versions used a synthetic `user` event with
      // `origin.kind: "task-notification"` (the user branch above still
      // handles that for forward/backward compat). queue-operation lines
      // carry `uuid: null` so they bypass the seenLineUuids dedup
      // entirely — that's fine, each enqueue is broadcast once per
      // process and reattach hits a different file offset.
      if (evt.operation === "enqueue" && typeof evt.content === "string") {
        const summary = /<summary>([\s\S]*?)<\/summary>/.exec(evt.content)?.[1]?.trim();
        // Mirror the existing user/origin.kind handler's fallback: when a
        // task-notification payload arrives without a `<summary>` (older
        // claude builds, malformed content, future variants), emit a
        // generic "completed" breadcrumb rather than dropping the event
        // silently — something measurable happened, and the run panel
        // shouldn't go dark on it.
        if (summary) {
          onChunk("status", `background task: ${summary}`, uuid);
        } else if (evt.content.startsWith("<task-notification>")) {
          onChunk("status", "background task completed", uuid);
        }
      }
      return { endOfTurn: false, lineUuid: uuid };
    }

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
 * Dismiss a Claude REPL modal the scraper detected by sending keystrokes
 * into the task's tmux session.
 *
 * Numbered modals: claude's modal is rendered by Ink's select-input,
 * which navigates with arrow keys and confirms with Enter. **Digit
 * keypresses do not move the cursor or confirm a choice** — they're
 * silently dropped. Sending `"2"` + Enter therefore behaves like Enter
 * alone: confirms whatever the cursor was on. The fix: arrow-key from
 * the scraper-observed `cursorIndex` to the index of the target choice,
 * then Enter. Positive delta → `Down`; negative → `Up`. This matters
 * because the scraper catches a wider set of modals than permission
 * prompts — the model picker and `/login` open with the cursor on the
 * *current* value, not necessarily option 1.
 *
 * Y/N modals: pass `cursorIndex` as undefined — the function falls back
 * to sending the literal `y`/`n` keystroke, which claude's confirm
 * helper handles directly.
 *
 * Each arrow press is its own `send-keys` invocation with a small sleep
 * between them. A bursted `Down Down Enter` lands as one read on
 * claude's stdin and the trailing Enter can be consumed before the
 * second Down propagates through the Ink reducer — the same race the
 * original `digit + Enter` split was working around.
 *
 * NOT a chat message: we deliberately bypass the `load-buffer +
 * paste-buffer` flow `pastePrompt` uses, because that path delivers the
 * text into claude's input buffer to become the next prompt. The modal
 * wants direct keypresses, not a queued message.
 *
 * Returns true on apparent success (every tmux command exited 0).
 * Silently returns false when no session is registered, when the target
 * key isn't present in the supplied choices, or when the session is
 * disposed mid-body (a `dropSession` + respawn during the inter-
 * keystroke gap would otherwise leak the trailing Enter into the fresh
 * pane as a stray confirmation).
 *
 * Latency: serialized behind any in-flight tmux op for the same task
 * (paste-prompts included), so a click that lands while a `/model X`
 * settle window is still elapsing waits up to `slashCommandSettleMs`
 * (default 700ms) before the first keystroke goes out. The server route
 * at `server.ts:1420` awaits this Promise, so the modal-click HTTP
 * response inherits the wait.
 */
export async function dismissTmuxPrompt(
  taskId: string,
  key: string,
  ctx: { choices: TmuxPromptChoice[]; cursorIndex?: number },
): Promise<boolean> {
  const state = sessions.get(taskId);
  if (!state) return false;
  // Map the choice key to its 0-based position in the registered list.
  // We use the *list* (not `parseInt(key) - 1`) so leading-zero or
  // unexpected key shapes can never silently mis-navigate — and so a
  // future modal that uses non-digit keys with arrow navigation would
  // still work without changing this function.
  const targetIndex = ctx.choices.findIndex((c) => c.key === key);
  if (targetIndex < 0) return false;
  const useArrowNav = typeof ctx.cursorIndex === "number";
  const delta = useArrowNav ? targetIndex - ctx.cursorIndex! : 0;
  const arrow = delta >= 0 ? "Down" : "Up";
  const stepCount = Math.abs(delta);
  // Routed through `queueTmuxOp` so our navigation + Enter sequence can't
  // interleave with an in-flight `queuePaste` for the same session — a
  // racing user paste's `paste-buffer + Enter` between our arrow and our
  // Enter would land the paste text in the modal's input and confirm
  // garbage. Sharing the chain serializes us behind any pending paste
  // (and its settle window) before our keys go out.
  let ok = false;
  await queueTmuxOp(taskId, async (stillCurrent) => {
    if (useArrowNav) {
      // Numbered modal: arrow-key from cursorIndex to targetIndex.
      // delta === 0 → no arrow at all, the trailing Enter alone
      // confirms the current selection.
      for (let i = 0; i < stepCount; i++) {
        if (!tmux(["send-keys", "-t", state.sessionName, arrow]).ok) return;
        // Small gap between arrow presses — defensive splitting that
        // mirrors what the original `digit + Enter` path needed:
        // bursting two arrow events as a single read into Ink's stdin
        // has been observed (rarely) to coalesce into one cursor
        // advance. The gap also lets the per-keystroke `stillCurrent()`
        // re-gate fire if a `dropSession` lands mid-navigation.
        await Bun.sleep(30);
        if (!stillCurrent()) return;
      }
    } else {
      // y/n style: send the literal keystroke.
      if (!tmux(["send-keys", "-t", state.sessionName, key]).ok) return;
      await Bun.sleep(50);
      if (!stillCurrent()) return;
    }
    // Explicit re-gate before the trailing Enter — symmetric with the
    // per-arrow check inside the loop and the y/n path above. Future
    // edits that insert an `await` between the loop end and this Enter
    // would otherwise reopen the dispose-during-gap race.
    if (!stillCurrent()) return;
    ok = tmux(["send-keys", "-t", state.sessionName, "Enter"]).ok;
  }, state);
  return ok;
}

/**
 * Drive a planned keystroke sequence into the task's tmux session — used to
 * answer claude's native AskUserQuestion / ExitPlanMode modals once the
 * PreToolUse hook no longer intercepts them. The key list comes from
 * `planAskAnswers` (claude-questions.ts), which encodes the observed
 * navigate/toggle/advance/submit choreography of claude's Ink modal.
 *
 * Each key is its own `send-keys` with a small gap so Ink's stdin reducer
 * doesn't coalesce two events into one cursor move (the same race
 * `dismissTmuxPrompt` works around). The whole sequence is serialized behind
 * any in-flight paste via `queueTmuxOp`, so a racing user message can't slip
 * its `paste-buffer + Enter` between two of our keys and confirm garbage. The
 * per-key `stillCurrent()` re-gate aborts cleanly if the session is disposed
 * (Stop / delete / respawn) mid-sequence rather than leaking a trailing Enter
 * into a fresh pane.
 *
 * `NavKey`s map 1:1 onto tmux key names (`Down`/`Up`/`Left`/`Right`/`Enter`/
 * `Escape`/`Tab`). Returns true only when every send-keys exited 0.
 */
export async function sendModalKeys(taskId: string, keys: NavKey[]): Promise<boolean> {
  const state = sessions.get(taskId);
  if (!state) return false;
  if (keys.length === 0) return true;
  let ok = false;
  await queueTmuxOp(taskId, async (stillCurrent) => {
    for (const key of keys) {
      if (!tmux(["send-keys", "-t", state.sessionName, key]).ok) return;
      // Inter-key gap mirrors dismissTmuxPrompt: a bursted pair can read as a
      // single Ink event, and the gap lets the dispose re-gate fire.
      await Bun.sleep(35);
      if (!stillCurrent()) return;
    }
    ok = true;
  }, state);
  return ok;
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
   * One-shot listener fired by `dispatchLine` immediately after it updates
   * `permissionMode` from a JSONL `system` / `permission-mode` event.
   * Installed by `cycleToMode` so it can verify whether a Shift+Tab press
   * actually landed on the requested mode (claude's cycle is opaque — the
   * account may not have `auto` access, the press may have hit a one-time
   * opt-in modal, etc.). Cleared before invocation so a retry inside the
   * callback can install a fresh listener for the next press without
   * racing this fire.
   */
  onPermissionMode: ((mode: string) => void) | null;
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
  /**
   * The structured AskUserQuestion card registered for this session's live
   * native modal, or null when none is up. Detection AND content come from the
   * tmux pane: claude doesn't write the AskUserQuestion tool_use to the JSONL
   * until the modal is *answered*, so the JSONL is useless while it's open. The
   * card is resolved when the modal leaves the pane.
   */
  askCardId: string | null;
  /** True while the tab-walk collector is mid-flight reading a multi-question
   *  modal's tabs, so the scraper doesn't kick off a second collection. */
  askCollecting: boolean;
  /**
   * A turn-end (`stop_reason: "end_turn"`) that has been observed but not yet
   * confirmed as real. Claude stamps `end_turn` on *every* split line of a
   * response (thinking, text, tool_use blocks) even when the message is still
   * mid-flight. We stage the signal here and fire it — calling `popEndOfTurn`
   * and emitting "turn complete" — only when the *next* JSONL line is not a
   * same-message continuation or a `tool_result` (`isEndTurnContinuation`).
   * Null when no end_turn is pending.
   */
  pendingEndTurn: {
    /** `message.id` of the staged line — used to recognise same-response
     *  split continuations (another content block of the same API call). */
    messageId: string | null;
    /** JSONL `uuid` of the staged line — forwarded as the dedup key on the
     *  "turn complete" status event. */
    uuid: string | undefined;
    /** Whether to emit the "turn complete" banner when firing. False on the
     *  reattach / dedup path where the prior process already broadcast it. */
    emitBanner: boolean;
    /** `Date.now()` when the pending was staged. Lets the idle path in
     *  `flush` fire the pending after a short grace period when no further
     *  JSONL data arrives (e.g., the end_turn line is truly the last write). */
    stagedAt: number;
  } | null;
}

interface TurnSlot {
  /** Handler routes JSONL events to the run this slot represents. */
  onChunk: ChunkHandler;
  /** Resolves the SpawnedAgent.done promise on this turn's end_turn. */
  resolve: ((code: number) => void) | null;
  reject: ((err: Error) => void) | null;
}

const sessions = new Map<string, SessionState>(); // taskId → state

/**
 * Per-task FIFO of tmux operations (paste-prompt + modal-dismissal).
 *
 * Why this matters: PATCH /tasks/:id (model/effort change) and POST
 * /runs/:id/input arrive as independent HTTP requests on localhost and
 * can race to the orchestrator's tmux helpers. The webview can fire the
 * input the instant PATCH resolves, while `reconcileTaskSession` is still
 * pasting `/model X` into the pane. Without serialization the two
 * `load-buffer` + `paste-buffer` + Enter sequences land back-to-back in
 * tmux but reach claude's TUI while it's in a transient post-slash-command
 * state — the user's paste was confirmed to vanish silently for ~49s in
 * a real session (see "Turn Ended Bug" repro), then only re-appeared
 * after a manual retry.
 *
 * The fix: a per-task lock that holds the next operation until the
 * previous one's settle window has elapsed. Modal dismissals
 * (`dismissTmuxPrompt`) share the same chain so a click on a numbered
 * choice can't interleave its `"1"` + Enter keystrokes with an in-flight
 * paste from `queuePaste`. (The exact tmux payload is mode-dependent —
 * non-bracketed slash commands send `load-buffer + paste-buffer +
 * delete-buffer + send-keys Enter` synchronously, while bracketed user
 * pastes split the trailing Enter out with a small `bracketedEnterGapMs`
 * sleep in between. See `queuePaste`.)
 *
 * The map's value is the tail promise of the in-flight chain; new ops
 * append via `queueTmuxOp`. Entries self-evict on completion when no
 * follow-up has chained behind them, so the map doesn't grow unbounded
 * for long-lived sessions.
 */
const pasteChains = new Map<string, Promise<void>>(); // taskId → in-flight chain tail

/**
 * Build a SessionState. Caller supplies the path-/launch-specific fields and
 * any non-default initial state; the factory fills in the timer / scrape /
 * staging defaults consistently. Centralising this keeps the four
 * construction sites (`spawnClaudeViaTmux`, `reattachSession`,
 * `rebuildEventsFromJsonl`, `__forTest.installSession`) from drifting when a
 * new SessionState field is added — the previous reviews caught two cases
 * where the field list got out of sync.
 *
 * Does NOT touch the global `sessions` map — callers register themselves.
 */
interface MakeSessionStateOpts {
  taskId: string;
  sessionName: string;
  cwd: string;
  jsonlPath: string;
  offset?: number;
  turnQueue?: TurnSlot[];
  lastChunk?: ChunkHandler | null;
  seenLineUuids?: Set<string>;
  onEndOfTurn?: (() => void) | null;
  permissionMode?: string | null;
  bypassEnabled?: boolean;
}

function makeSessionState(o: MakeSessionStateOpts): SessionState {
  return {
    taskId: o.taskId,
    sessionName: o.sessionName,
    cwd: o.cwd,
    jsonlPath: o.jsonlPath,
    offset: o.offset ?? 0,
    turnQueue: o.turnQueue ?? [],
    lastChunk: o.lastChunk ?? null,
    seenLineUuids: o.seenLineUuids ?? new Set(),
    onEndOfTurn: o.onEndOfTurn ?? null,
    permissionMode: o.permissionMode ?? null,
    bypassEnabled: o.bypassEnabled ?? false,
    // Defaults shared by every site — timers, scrape state, staging buffers.
    watcher: null,
    pollTimer: null,
    onPermissionMode: null,
    scrapeTimer: null,
    scrapeLastFingerprint: null,
    lastJsonlAppendAt: 0,
    recentlyAnsweredFingerprints: new Map(),
    askCardId: null,
    askCollecting: false,
    pendingEndTurn: null,
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * JSONL discovery + tail.
 * ────────────────────────────────────────────────────────────────────────── */

/** Absolute filesystem path to the JSONL claude writes for this session.
 *  `configDir` is the per-harness CLAUDE_CONFIG_DIR — claude treats that
 *  path itself as the `.claude/` equivalent, so new writes land at
 *  `<configDir>/projects/<encoded>/<sid>.jsonl` (no `.claude/` segment).
 *  When NULL, the default `~/.claude/projects/…` layout applies.
 *
 *  Migration fallback: agetor used to set HOME=<harness home> instead of
 *  CLAUDE_CONFIG_DIR, which made claude write under
 *  `<harness home>/.claude/projects/…`. When we have a configDir but the
 *  new-layout file is missing, fall back to the legacy path so rebuild +
 *  reattach can still read pre-upgrade JSONLs. New writes always use the
 *  new layout. */
export function jsonlPathFor(cwd: string, sessionId: string, configDir: string | null): string {
  const encoded = encodeProjectPath(cwd);
  const fileName = `${sessionId}.jsonl`;
  if (configDir) {
    const fresh = path.join(configDir, "projects", encoded, fileName);
    if (existsSync(fresh)) return fresh;
    const legacy = path.join(configDir, ".claude", "projects", encoded, fileName);
    if (existsSync(legacy)) return legacy;
    return fresh;
  }
  return path.join(homedir(), ".claude", "projects", encoded, fileName);
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

/**
 * Tail-cursor position for a pre-existing JSONL — used by the resume path
 * in `spawnClaudeViaTmux` to park the cursor past everything claude already
 * wrote, so historical `end_turn` markers can't pop the new turn slot and
 * flip the freshly-created run to `succeeded` before claude has processed
 * the new prompt. Returns 0 when the file doesn't exist (fresh spawn) or
 * can't be stat'd (race), letting the tailer behave like a normal cold
 * start.
 */
function resumeJsonlOffset(jsonlPath: string): number {
  try {
    return fsStatSync(jsonlPath).size;
  } catch {
    return 0;
  }
}

/** How long a staged end_turn waits with no new JSONL data before we fire
 *  it anyway. Covers the edge case where the end_turn line is the very last
 *  write to the file (i.e., claude wrote nothing after it — no last-prompt,
 *  no mode event). Two poll cycles at the 400ms pollTimer interval. */
const END_TURN_IDLE_FIRE_MS = 800;

/** Advance the turn queue on end_turn — either pop the head slot and
 *  resolve its `done` promise (fresh-spawn / live-stream path), or fire the
 *  one-shot `onEndOfTurn` listener (reattach path, where there's no slot
 *  but the orchestrator still needs to know the run completed). */
function popEndOfTurn(state: SessionState): void {
  const slot = state.turnQueue[0];
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

/** Fire the staged `pendingEndTurn` — emit the "turn complete" banner (if
 *  appropriate) and advance the turn queue. Called from `dispatchLine` when
 *  the next line confirms the pending was a real turn-end, from `flushSync`
 *  when a new prompt is being queued (new prompt = previous turn is over), and
 *  from `flush` when no new data has arrived for long enough to rule out a
 *  same-message continuation. */
function firePendingEndTurn(state: SessionState): void {
  const pending = state.pendingEndTurn;
  if (!pending) return;
  state.pendingEndTurn = null;
  if (pending.emitBanner) {
    // Emit through whichever handler is active. The slot hasn't been popped
    // yet, so the active slot is still the right target.
    const onChunk = state.turnQueue[0]?.onChunk ?? state.lastChunk ?? (() => {});
    onChunk("status", "turn complete", pending.uuid);
  }
  popEndOfTurn(state);
}

/** Dispatch one parsed JSONL line through the active turn slot's handler,
 *  advancing the queue when the line ends a turn. Shared between the
 *  async `flush` (file watcher / poll) and the sync `flushSync` (called
 *  from `sendTurn` so we drain leftover content before queueing a new
 *  turn).
 *
 * Turn-end detection uses one-line staging to handle a claude streaming
 * quirk: claude stamps `stop_reason: "end_turn"` on *every* split line of a
 * response (thinking, text, tool_use blocks), not just the last. We stage the
 * end_turn signal here and confirm — firing `popEndOfTurn` + "turn complete"
 * — only when the NEXT line is not a same-message continuation or a
 * tool_result. This prevents both the "run flips to succeeded mid-turn" bug
 * and the spurious "TURN COMPLETE" divider spam it caused. */
/** Capture the trailing pane lines for this session (best-effort; "" on miss). */
function captureTail(state: SessionState): string {
  const cap = tmux(["capture-pane", "-p", "-t", state.sessionName]);
  if (!cap.ok) return "";
  const cl = cap.stdout.split("\n");
  return cl.slice(Math.max(0, cl.length - SCRAPE_TAIL_LINES)).join("\n");
}

/**
 * Read the live native AskUserQuestion modal off the tmux pane and register a
 * structured card for it.
 *
 * Why the pane and not the JSONL: claude does NOT write the AskUserQuestion
 * tool_use to the session JSONL until the modal is *answered*, so while it's
 * open the rendered pane is the only source of the question text + options. For
 * a single-question modal everything is on screen; for a multi-question
 * (tabbed) modal only the active tab's options are visible, so we briefly walk
 * the tabs (`→` per tab, capture+parse each, then `←` back to the first) and
 * register one card with every question.
 *
 * Fire-and-forget from the scraper, guarded by `askCollecting` (so a 1s tick
 * can't start a second walk) and `askCardId` (so we never double-register). The
 * card is resolved by the scraper when the modal leaves the pane.
 */
async function collectAndRegisterAskCard(state: SessionState, firstTail: string): Promise<void> {
  if (state.askCollecting || state.askCardId) return;
  const runId = tasks.get(state.taskId)?.runId;
  if (!runId) return;
  const first = parseModalPane(firstTail);
  if (!first) return;

  state.askCollecting = true;
  try {
    const collected = [first];
    const n = first.tabbed ? Math.max(1, first.tabHeaders.length) : 1;
    if (n > 1) {
      // Walk the tabs to read every question, then return to the first tab so
      // the answer-driving sequence (planAskAnswers) starts from a known state.
      await queueTmuxOp(state.taskId, async (stillCurrent) => {
        for (let i = 1; i < n; i++) {
          if (!tmux(["send-keys", "-t", state.sessionName, "Right"]).ok) return;
          await Bun.sleep(180);
          if (!stillCurrent()) return;
          const p = parseModalPane(captureTail(state));
          if (p) collected.push(p);
        }
        for (let i = 1; i < n; i++) {
          if (!tmux(["send-keys", "-t", state.sessionName, "Left"]).ok) return;
          await Bun.sleep(90);
          if (!stillCurrent()) return;
        }
      }, state);
    }

    // Don't register a PARTIAL read: if any walked tab failed to parse (a
    // capture-pane landed mid-repaint and parseModalPane returned null), the
    // question count would be wrong and `planAskAnswers` would mis-drive the
    // answer (submit early / wrong header alignment). Bail — `askCollecting`
    // clears in `finally` and the next scrape tick retries cleanly.
    if (collected.length !== n) return;
    // The modal may have been answered out from under us mid-walk.
    if (state.askCardId || detectAskModal(captureTail(state)) === null) return;

    const questions: AskQuestion[] = collected.map((p, i) => ({
      question: p.questionText,
      header: first.tabHeaders[i],
      multiSelect: p.multiSelect,
      options: p.options.map((o) => ({ label: o.label, description: o.description })),
    }));
    const card = registerScrapedAskQuestions({
      taskId: state.taskId,
      runId,
      questions,
      fingerprint: `ask-${runId}`,
    });
    state.askCardId = card.id;
  } finally {
    state.askCollecting = false;
  }
}

/**
 * Resolve the structured AskUserQuestion card for a task and clear the session
 * tracker. Called by the `/ask-questions` answer route after it drives (or
 * message-delivers) the answer. Resolving the interaction is unconditional (so
 * the UI always drops the card); clearing `state.askCardId` is what lets the
 * scraper re-collect if the modal is somehow still on the pane (e.g. a failed
 * drive) — without it the `!state.askCardId` gate would block re-registration
 * and strand the modal with no card.
 */
export function resolveAskCard(cardId: string, taskId: string): void {
  resolveScrapedAskQuestions(cardId);
  const state = sessions.get(taskId);
  if (state && state.askCardId === cardId) state.askCardId = null;
}

function dispatchLine(state: SessionState, line: string): void {
  let evt: ParsedJsonlEvent;
  try {
    evt = JSON.parse(line);
  } catch (e) {
    const handler = state.turnQueue[0]?.onChunk ?? state.lastChunk;
    handler?.("stderr", `jsonl parse error: ${(e as Error).message}`);
    return;
  }
  const uuid = typeof evt.uuid === "string" ? evt.uuid : undefined;

  // Mirror the latest mode-bearing JSONL event into SessionState.
  // IMPORTANT: this update MUST stay above the seenLineUuids early-return.
  // On reattach the dedup set is pre-seeded from run_events, so every
  // replayed line — including mode events the prior process recorded — would
  // otherwise be silently skipped and state.permissionMode would stay null.
  if ((evt.type === "system" || evt.type === "permission-mode")
    && typeof evt.permissionMode === "string") {
    state.permissionMode = evt.permissionMode;
    if (state.onPermissionMode) {
      const cb = state.onPermissionMode;
      state.onPermissionMode = null;
      cb(evt.permissionMode);
    }
  }

  // Staging step: the new line either confirms or cancels the pending end_turn.
  // This must run before the dedup check so replayed lines also drive staging.
  if (state.pendingEndTurn) {
    if (isEndTurnContinuation(evt, state.pendingEndTurn.messageId)) {
      // Same message still going, or tool_result for a tool_use in that
      // message → the staged end_turn was spurious. Discard it.
      state.pendingEndTurn = null;
    } else {
      // Something unrelated started → the previous turn truly ended. Fire.
      firePendingEndTurn(state);
    }
  }

  // Already-seen lines (reattach replay-from-offset-0) skip chunk emission
  // but still stage an end_turn so the run-row status transition can fire
  // when the next line confirms it. The banner is suppressed (emitBanner:
  // false) because the prior process already broadcast it.
  if (uuid && state.seenLineUuids.has(uuid)) {
    if (isEndOfTurnEvent(evt)) {
      state.pendingEndTurn = {
        messageId: evt.message?.id ?? null,
        uuid,
        emitBanner: false,
        stagedAt: Date.now(),
      };
    }
    return;
  }

  const slot = state.turnQueue[0];
  // Active turn → its handler. No active turn → fall back to the most
  // recently popped slot's handler so trailing metadata still reaches the
  // correct run. If neither exists it's safe to drop.
  const onChunk: ChunkHandler = slot?.onChunk ?? state.lastChunk ?? (() => {});
  const { endOfTurn } = mapParsedEventToChunks(evt, onChunk);
  if (uuid) state.seenLineUuids.add(uuid);
  if (endOfTurn) {
    // Stage: don't resolve the turn yet. The banner and slot-pop happen in
    // `firePendingEndTurn` once the next line confirms this isn't a mid-flight
    // split. If the file ends here, `flush` fires it after END_TURN_IDLE_FIRE_MS.
    state.pendingEndTurn = {
      messageId: evt.message?.id ?? null,
      uuid,
      emitBanner: true,
      stagedAt: Date.now(),
    };
  }

  // Interrupt force-end: a user-interrupt tool_result (Esc on a modal / Ctrl+C)
  // definitively ends the turn — claude stops and waits. Resolve the run NOW
  // regardless of staging. This is what unsticks "Agent is working" when a plan
  // is rejected: the ExitPlanMode tool_use may carry stop_reason "tool_use" (so
  // nothing was staged to fire), and even when it carried "end_turn" the
  // interrupt would otherwise cancel that staged end_turn as a "continuation".
  //
  // ASSUMPTION (verified live, claude 2.1.162): claude always stops after this
  // marker — its text is literally "STOP what you are doing and wait for the
  // user to tell you how to proceed". If a future claude version instead kept
  // talking, that continuation would land on the just-popped slot's `lastChunk`
  // with the run already resolved (premature "succeeded"). Re-validate this if
  // the rejection wording changes.
  if (isInterruptUserEvent(evt) && (state.turnQueue.length > 0 || state.onEndOfTurn)) {
    state.pendingEndTurn = null;
    onChunk("status", "turn complete", uuid);
    popEndOfTurn(state);
  }
}

/**
 * Re-emit a finished session's JSONL as a chunk stream, using the same
 * staging logic the live tailer uses. Drives `dispatchLine` against a
 * synthetic single-slot SessionState — the slot's handler is `onChunk`, so
 * every event (including "turn complete" banners that `firePendingEndTurn`
 * emits when a turn is confirmed) flows through to the caller in the same
 * shape the live SSE path produces. Fires any pending end_turn at EOF, since
 * no further line can ever arrive to confirm it.
 *
 * Used by the `/runs/:id/rebuild-events` endpoint. Must NOT touch the live
 * `sessions` map — the synthetic state is local and discarded on return.
 */
export function rebuildEventsFromJsonl(text: string, onChunk: ChunkHandler): void {
  // Single synthetic slot routes every chunk to the caller's onChunk.
  // Resolve/reject are no-ops — popEndOfTurn calls resolve?.(0) which is
  // fine; the slot exists purely to carry the handler.
  const state = makeSessionState({
    taskId: "__rebuild__",
    sessionName: "__rebuild__",
    cwd: "/",
    jsonlPath: "/__rebuild__",
    turnQueue: [{ onChunk, resolve: null, reject: null }],
    lastChunk: onChunk,
  });
  for (const line of text.split("\n")) {
    if (line.trim()) dispatchLine(state, line);
  }
  // EOF — no continuation can ever arrive. Fire any staged pending so the
  // last turn's "turn complete" banner makes it into the output.
  if (state.pendingEndTurn) firePendingEndTurn(state);
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
  // flushSync is called from sendTurn before pushing a new prompt slot.
  // A new human prompt is definitive proof the previous turn ended — fire any
  // staged end_turn now so it resolves on the correct (old) slot, not the one
  // we're about to push.
  if (state.pendingEndTurn) firePendingEndTurn(state);
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
  if (!chunk.text) {
    // No new data. Fire any staged end_turn that has been waiting long enough
    // for a continuation to arrive — if none came, the turn is over. The
    // threshold is two poll cycles so a same-batch continuation arriving in
    // the immediately next flush doesn't trigger a false fire.
    if (state.pendingEndTurn
        && Date.now() - state.pendingEndTurn.stagedAt >= END_TURN_IDLE_FIRE_MS) {
      firePendingEndTurn(state);
    }
    return;
  }
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
  /** 0-based index of the choice marked by the `❯`/`›` cursor at scrape
   *  time. Undefined when arrow navigation does not apply (y/N modals).
   *  Threaded through to `dismissTmuxPrompt` so it knows how far to
   *  navigate from the current selection — permission modals default to
   *  index 0 (option 1), but the model picker / auth re-prompts open
   *  with the cursor on the *current* value, anywhere in the list. */
  cursorIndex?: number;
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
  // Cursor MUST land inside tailRun for the modal to be dismissible —
  // otherwise the `❯` is on a printed list above the actual choice set
  // (we'd send arrow keys into a phantom selector). Bail rather than
  // register a half-known modal.
  const cursorIndex = tailRun.findIndex((n) => n.cursorHere);
  if (cursorIndex < 0) return null;
  const choices: TmuxPromptChoice[] = tailRun.map((n) => ({ key: n.key, label: n.label }));
  // Use the last ~12 lines for the displayed pane snippet so the user
  // sees the question text + the choices, not 40 lines of unrelated
  // context above.
  const paneText = lines.slice(-12).join("\n").trimEnd();
  // Cursor position is part of the fingerprint: if claude moves the
  // highlight while the modal is on screen (e.g., user arrows around
  // via a real tmux attach), we want to re-register so the dismissal
  // path picks up the new starting position. Without this the second-
  // tick stability check would silently match the old position and
  // navigate from a stale index.
  const fingerprint = sha1(
    `numbered:${choices.map((c) => `${c.key}|${c.label}`).join("/")}|@${cursorIndex}`,
  );
  return { paneText, choices, cursorIndex, fingerprint };
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

/**
 * One-time *startup consent* dialogs claude can draw before it ever reaches
 * the REPL. These are special because they block JSONL creation entirely:
 * the normal scraper only arms after the JSONL exists (`attachTailer`), so it
 * never sees a dialog that's preventing the JSONL from existing in the first
 * place. Left unhandled, the session sits at the dialog until the 30s boot
 * timeout fires and the run is killed — exactly the "claude session JSONL
 * never appeared … (empty — claude has not drawn any TUI output yet)" failure
 * a claude version bump (which re-shows the bypass acceptance) reliably
 * produces.
 *
 * Each entry here is tied to a choice the user has *already made*, so
 * auto-confirming the affirmative option at boot matches intent rather than
 * deciding anything on the user's behalf:
 *   - bypass-permissions: only shown when claude was launched with
 *     `--dangerously-skip-permissions`, which agetor only emits for the
 *     `bypass` mode the user explicitly selected.
 *   - trust-folder: shown the first time claude opens a directory; agetor
 *     owns the worktree and the user pointed the task's workdir at it.
 *
 * We deliberately scope auto-confirm to these two recognised consent screens
 * (matched by a marker string AND an affirmative choice label). Every other
 * modal — real per-tool permission prompts, the model picker, `/login` — is
 * left for the interactive scraper so the user decides.
 */
const STARTUP_CONSENT_DIALOGS: Array<{ name: string; marker: RegExp; affirmative: RegExp }> = [
  // `claude --dangerously-skip-permissions` first-run warning:
  //   WARNING: Claude Code running in Bypass Permissions mode
  //   ❯ 1. No, exit
  //     2. Yes, I accept
  { name: "bypass-permissions", marker: /bypass permissions mode/i, affirmative: /\baccept\b/i },
  // Workspace-trust prompt: claude shows this the first time it opens a
  // directory not already trusted in ~/.claude.json. It is NOT suppressed by
  // `--dangerously-skip-permissions` (workspace trust is a separate layer from
  // permissions), so agetor's fresh per-task worktrees reliably trigger it —
  // and it blocks claude from ever writing its JSONL until answered (otherwise
  // the run dies at the 30s boot timeout with the dialog on the pane). Observed
  // text (claude 2.1.x):
  //   Quick safety check: Is this a project you created or one you trust? …
  //   ❯ 1. Yes, I trust this folder
  //     2. No, exit
  // `affirmative` is anchored on "Yes …trust this folder", so it can only ever
  // land on the trust option — never a "No, …trust" variant (the original
  // safety concern). The marker also keeps the older "trust the files in this
  // folder" wording as a fallback in case an earlier build phrased it that way.
  {
    name: "trust-folder",
    marker: /Quick safety check|trust this folder|trust the files in this (folder|directory)/i,
    affirmative: /Yes\b.*\btrust this folder\b/i,
  },
];

export interface StartupDialogMatch {
  /** Which consent dialog matched (for the status breadcrumb + dedup key). */
  name: string;
  choices: TmuxPromptChoice[];
  /** 0-based index the `❯`/`›` cursor sits on right now. */
  cursorIndex: number;
  /** 0-based index of the affirmative ("accept" / "proceed") choice we want
   *  to land on before pressing Enter. */
  acceptIndex: number;
  /** Stable hash of the matched dialog — lets the boot poller confirm a given
   *  on-screen dialog exactly once while still acting on a *different*
   *  subsequent dialog (e.g. trust-folder appearing after bypass). */
  fingerprint: string;
}

/**
 * Pure: identify a known startup *consent* dialog on the pane and the index
 * of its affirmative choice. Returns null for anything that isn't one of
 * `STARTUP_CONSENT_DIALOGS` with a parseable numbered choice list and a
 * recognisable affirmative option — when in doubt we do nothing and let the
 * boot timeout surface the raw pane to the user instead of guessing.
 */
export function matchStartupConsentDialog(pane: string): StartupDialogMatch | null {
  const dialog = STARTUP_CONSENT_DIALOGS.find((d) => d.marker.test(pane));
  if (!dialog) return null;
  // Reuse the numbered-modal parser so the choice list / cursor handling
  // stays identical to the runtime scraper. It requires a cursor marker,
  // which every one of these dialogs draws.
  const modal = matchNumberedModal(pane);
  if (!modal || modal.cursorIndex === undefined) return null;
  const acceptIndex = modal.choices.findIndex((c) => dialog.affirmative.test(c.label));
  if (acceptIndex < 0) return null;
  return {
    name: dialog.name,
    choices: modal.choices,
    cursorIndex: modal.cursorIndex,
    acceptIndex,
    fingerprint: sha1(`startup:${dialog.name}:${modal.fingerprint}`),
  };
}

/**
 * Send the keystrokes that confirm a startup consent dialog: arrow from the
 * cursor's current position to the affirmative option, then Enter. Talks to
 * tmux directly (not via `queueTmuxOp`) because this runs during the boot
 * window — before any turn slot or paste chain exists for the session. Each
 * arrow is its own `send-keys` with a small gap, mirroring `dismissTmuxPrompt`
 * so a bursted `Down Enter` can't coalesce in Ink's stdin reducer and confirm
 * the wrong line.
 *
 * Returns true only when every keystroke (arrows + the final Enter) was
 * delivered. The caller latches the dialog's fingerprint on a `true` so a
 * transient `send-keys` failure leaves the fingerprint UN-latched and the next
 * poll tick retries — otherwise a half-sent confirm would silently strand the
 * dialog until the boot timeout.
 */
async function confirmStartupDialog(sessionName: string, m: StartupDialogMatch): Promise<boolean> {
  const delta = m.acceptIndex - m.cursorIndex;
  const arrow = delta >= 0 ? "Down" : "Up";
  for (let i = 0; i < Math.abs(delta); i++) {
    if (!tmux(["send-keys", "-t", sessionName, arrow]).ok) return false;
    await Bun.sleep(30);
  }
  return tmux(["send-keys", "-t", sessionName, "Enter"]).ok;
}

/** How often the boot-time consent poller re-checks the pane. Fast enough
 *  that a dialog blocking JSONL creation is cleared within a fraction of a
 *  second; cheap because it's one `capture-pane` per tick and only runs
 *  during the bounded boot window. */
const STARTUP_DIALOG_POLL_MS = 350;

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
      && activeTmuxPromptsForTask(state.taskId).length === 0
      // Keep polling while an AskUserQuestion card is live, so the
      // resolve-on-modal-gone backstop fires if the user answers it via a real
      // `tmux attach` (external dismissal) rather than the card.
      && state.askCardId === null) {
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

  // Native AskUserQuestion modal handling. Its options render as a numbered
  // checkbox list (`❯ 1. [✔] Cheese …`) that matchNumberedModal would otherwise
  // grab, producing a competing single-keystroke tmux_prompt card. So whenever
  // the modal is on the pane we (a) suppress the numbered matcher and (b) drive
  // the structured-card flow off the pane (collectAndRegisterAskCard). When the
  // modal leaves the pane (answered/cancelled) we drop the card. ExitPlanMode's
  // approval modal carries no AskUserQuestion signature, so it still flows
  // through the numbered matcher as intended.
  const askOnPane = detectAskModal(tail) !== null;
  if (askOnPane) {
    if (!claudeIsWriting && !state.askCardId && !state.askCollecting) {
      void collectAndRegisterAskCard(state, tail);
    }
  } else if (state.askCardId) {
    resolveScrapedAskQuestions(state.askCardId);
    state.askCardId = null;
  }

  const match = (claudeIsWriting || askOnPane)
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
    cursorIndex: match.cursorIndex,
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

  // Clean up any stale agetor settings before tmux starts so claude reads a
  // tidy `.claude/settings.local.json` on launch. agetor is non-invasive: it
  // installs no PreToolUse hook and no MCP server. This call only STRIPS a
  // stale agetor PreToolUse entry / `mcpServers.agetor` key a previous build
  // wrote (so claude doesn't error launching a deleted MCP launcher) and
  // self-heals permission rules in owned worktrees. Owned worktrees get a
  // self-heal-safe pass; user-repo cwds (isolation=none) get a merge pass
  // that preserves all existing user config.
  ensureInstalledForCwd(opts.cwd, opts.mode);

  // Build the tmux command. `-e KEY=VAL` injects env vars into the new
  // session (so the spawned claude inherits them); `--` separates the tmux
  // flags from the command to run.
  //
  // PATH is injected explicitly because the tmux *server* captures env at
  // its first launch and reuses it for every subsequent session — passing
  // it per-session via `-e` guarantees the spawned claude sees the
  // currently-rehydrated PATH even if the server's captured copy is stale
  // (e.g. agetor restarted with a different login-shell PATH but the
  // long-running bundled tmux server is still around).
  //
  // We no longer inject AGETOR_API_PORT/TOKEN/TASK_ID: with the PreToolUse hook
  // and the ask_user MCP both gone, nothing in the spawned claude reads them,
  // and AGETOR_API_TOKEN gates every orchestration route — no reason to expose
  // it to the agent's environment.
  const fullEnv: Record<string, string> = {
    ...opts.env,
    PATH: process.env.PATH ?? "",
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
  const jsonlPath = jsonlPathFor(opts.cwd, opts.sessionId, opts.configDir);

  // When the JSONL already exists at spawn time, we're resuming a prior
  // claude session (`--resume <id>` reopens the same file). The file holds
  // the full historical conversation including past `end_turn` markers — if
  // we tailed from offset 0 those historical `end_turn`s would pop the
  // turn slot we're about to push and resolve the new run's `done`
  // promise immediately, flipping the freshly-created run row to
  // `succeeded` before claude has even processed the new prompt. Park the
  // cursor at EOF so the tailer only sees what claude appends post-launch.
  const initialOffset = resumeJsonlOffset(jsonlPath);

  // Allocate the per-session state up front so flush() can find it.
  const state = makeSessionState({
    taskId: opts.taskId,
    sessionName,
    cwd: opts.cwd,
    jsonlPath,
    offset: initialOffset,
    // Canonical claude mode string (e.g. "plan", "bypassPermissions"),
    // not the agetor-internal id ("plan", "bypass"). Seeding here means
    // the plan-mode safety check in `/approvals` works from the very
    // first PreToolUse hook — before the JSONL has even been opened. The
    // JSONL's `system` event will overwrite this within a tick if claude
    // renegotiates, which is fine. On resume we deliberately keep
    // sourcing from `opts.mode` (what claude is launched with) rather
    // than the JSONL's last recorded mode — the user may have edited
    // task.mode since the prior session, in which case the launch flags
    // are the truth and the JSONL is stale.
    permissionMode: opts.mode ? toClaudeModeString(opts.mode) : null,
    // `bypass` is the only agetor mode that emits the launch flag
    // (--dangerously-skip-permissions) — that's what puts
    // `bypassPermissions` into the Shift+Tab cycle.
    bypassEnabled: opts.mode === "bypass",
  });
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
    // Concurrently watch for a one-time startup consent dialog (the
    // `--dangerously-skip-permissions` bypass warning, or the trust-folder
    // prompt) blocking claude from ever writing its JSONL. Auto-confirm it —
    // each maps to a choice the user already made (see STARTUP_CONSENT_DIALOGS).
    // Without this the dialog sits unanswered until BOOT_TIMEOUT_MS and the run
    // dies with an empty pane; this is the failure a claude version bump that
    // re-shows the bypass acceptance reliably triggers. The poller self-stops
    // the moment the JSONL appears, the session dies, or boot settles.
    let bootSettled = false;
    let lastConfirmedFingerprint: string | null = null;
    void (async () => {
      // Wrapped so a stray throw can never become an unhandled rejection on
      // the fire-and-forget IIFE (mirrors `startScraper`'s try/catch posture);
      // in practice none of the calls below throw.
      try {
        while (!bootSettled) {
          await Bun.sleep(STARTUP_DIALOG_POLL_MS);
          // Resume path: when the JSONL already exists at spawn (`--resume`),
          // this short-circuits on the first tick so the poller is a no-op —
          // a re-shown consent dialog on resume is out of scope (bypass
          // acceptance is global + persistent once accepted).
          if (bootSettled || existsSync(jsonlPath)) return;
          if (!tmux(["has-session", "-t", sessionName]).ok) return;
          const pane = tmux(["capture-pane", "-p", "-t", sessionName]).stdout;
          const m = matchStartupConsentDialog(pane);
          // Single-tick action is deliberate (unlike the runtime scraper's
          // two-tick stability gate): this only runs during the bounded boot
          // window and is gated on a marker string AND a parseable affirmative
          // choice, so a half-drawn frame can't trigger a stray confirm.
          // Confirm a given on-screen dialog at most once — the fingerprint is
          // latched ONLY after `confirmStartupDialog` reports every keystroke
          // landed, so a transient send-keys failure retries next tick instead
          // of stranding the dialog. A genuinely different follow-up dialog
          // (new fingerprint) is still acted on.
          if (m && m.fingerprint !== lastConfirmedFingerprint) {
            if (await confirmStartupDialog(sessionName, m)) {
              lastConfirmedFingerprint = m.fingerprint;
              opts.onChunk("status", `claude startup dialog auto-confirmed (${m.name})`);
            }
          }
        }
      } catch { /* never let the boot poller crash the spawn */ }
    })();

    const found = await waitForJsonlAt(jsonlPath, BOOT_TIMEOUT_MS);
    bootSettled = true;
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
      // Reject every queued turn so all dependent promises settle. Drop any
      // staged end_turn — without claude's JSONL we can't confirm it, and
      // letting it fire later would emit a "turn complete" for a turn that
      // never actually completed.
      const err = new Error("jsonl-discovery-timeout");
      state.pendingEndTurn = null;
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
  /** Per-harness CLAUDE_CONFIG_DIR (sourced from `Harness.home`). See
   *  `SpawnOptions.configDir` for the full semantics. */
  configDir: string | null;
  /** Per-run chunk handler that persists to run_events + broadcasts on SSE.
   *  Built by the orchestrator the same way it does for fresh runs. */
  onChunk: ChunkHandler;
  /** Dedup set seeded from `runs.seenLineUuidsForTask(taskId)` — every uuid
   *  the previous process persisted across *every* run of this task. The
   *  dispatcher skips any line whose uuid is already in this set, so the
   *  replay from offset 0 doesn't double-emit events and doesn't fire
   *  `onEndOfTurn` on end_turn lines belonging to long-completed prior
   *  turns. */
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
  const jsonlPath = jsonlPathFor(opts.cwd, opts.sessionId, opts.configDir);
  if (!existsSync(jsonlPath)) return null;

  let resolveDone: ((code: number) => void) | null = null;
  let rejectDone: ((err: Error) => void) | null = null;
  const done = new Promise<number>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  // Replaying the JSONL from offset 0 re-runs every historical
  // `system` / `permission-mode` line through `dispatchLine`. The
  // permissionMode update there sits above the seenLineUuids dedup
  // check, so even when the line's uuid is already in the dedup set
  // (pre-seeded from run_events on reattach) the field still gets
  // overwritten with whatever mode claude is currently in.
  //
  // The launch flag isn't persisted across agetor restarts, so we can't
  // tell whether bypassPermissions is in the cycle on this reattach.
  // Conservatively assume not (bypassEnabled defaults to false) — cycling
  // to bypass after a restart needs a respawn (claude requires the flag
  // at launch anyway).
  const state = makeSessionState({
    taskId: opts.taskId,
    sessionName,
    cwd: opts.cwd,
    jsonlPath,
    // Trailing metadata that lands before the first new turn slot still
    // wants to flow to run_events — route it through the reattach handler
    // by seeding lastChunk, same pattern as spawnClaudeViaTmux.
    lastChunk: opts.onChunk,
    seenLineUuids: opts.seenLineUuids,
    onEndOfTurn: () => resolveDone?.(0),
  });
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
      // Drop any staged end_turn so a late-arriving JSONL line can't fire it
      // post-cancel and emit a spurious "turn complete" banner.
      tmux(["send-keys", "-t", s.sessionName, "C-c"]);
      const err = new Error("cancelled");
      s.pendingEndTurn = null;
      for (const slot of s.turnQueue.splice(0)) slot.reject?.(err);
      s.onEndOfTurn = null;
      rejectDone?.(err);
    },
    writeInput: (line) => {
      const s = sessions.get(opts.taskId);
      if (!s) return false;
      void queuePaste(opts.taskId, s.sessionName, line, 0, s, { bracketed: true });
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
  void queuePaste(taskId, state.sessionName, prompt, 0, state, { bracketed: true });
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
  // Settle delay after slash commands: claude's TUI takes ~hundreds of ms
  // to process `/model` / `/effort` and return to a ready input prompt.
  // Without the wait, a follow-up user paste (e.g. the next `sendTurn`
  // racing on localhost) lands during the transient state and gets
  // silently dropped — see the `Turn Ended Bug` repro where a
  // `/code-review` paste sat invisible for 49s after a model change.
  void queuePaste(taskId, state.sessionName, line, slashCommandSettleMs, state);
  return true;
}

/** Reasons `cycleToMode` can fail. Modeled as a literal union (rather than
 *  free-form strings) so a typo in either the producer or the consumer
 *  branches surfaces at compile time — the failure path's user-facing
 *  message depends on string equality, and a silent typo would route the
 *  user to a generic fallback that doesn't match the actual problem. */
export type CycleFailureReason =
  | "no live session"
  | "current mode unknown"
  | "mode not in cycle"
  | "verification timed out"
  | "verification mismatch";

export type CycleResult =
  | { ok: true; presses: number; via: "noop" | "slash-plan" | "shift-tab" }
  | { ok: false; reason: CycleFailureReason; target?: string; attempts?: number; lastObserved?: string | null };

/** How many times `cycleToMode` will resend Shift+Tab presses before giving
 *  up. Each press is verified against the next JSONL `permission-mode`
 *  event; a mismatch (account isn't auto-eligible, cycle width assumed
 *  wrong) triggers another attempt from the newly-observed mode. */
const MAX_VERIFY_ATTEMPTS = 3;

/** How long to wait for a `permission-mode` JSONL event after sending the
 *  Shift+Tab presses before declaring the press "lost" (most likely
 *  swallowed by claude's one-time auto opt-in modal). 1.5s comfortably
 *  exceeds the ~100ms claude takes to emit the event in practice. */
let modeVerifyTimeoutMs = 1500;

/**
 * Switch a live claude session's permission mode to `targetAgetorMode` by
 * sending the right number of `Shift+Tab` keystrokes (claude's only
 * mid-session mode-switch mechanism — there's no `/permission-mode` slash
 * command despite what the prior code assumed). For the `plan` target we
 * prefer the `/plan` slash command instead: it's deterministic, doesn't
 * depend on knowing the current mode, and works from anywhere.
 *
 * After each batch of presses we wait for the next JSONL `permission-mode`
 * event and compare it to the target. A mismatch — account isn't
 * auto-eligible (cycle is 3-wide instead of 4), assumed press count was
 * off, etc. — triggers another attempt from the newly-observed mode, up
 * to `MAX_VERIFY_ATTEMPTS` times. If the event never arrives within
 * `modeVerifyTimeoutMs` (most likely cause: claude's one-time auto
 * opt-in modal swallowed the keystrokes), we bail with `verification
 * timed out` so the orchestrator can warn the user rather than report
 * a successful mode change that didn't happen.
 *
 * Returns:
 *   - `{ ok: true, via: "noop" }` when the session is already at the target.
 *   - `{ ok: true, via: "slash-plan" }` when we sent `/plan`.
 *   - `{ ok: true, via: "shift-tab", presses: N }` when N tabs got claude
 *     to the target (verified by the JSONL event).
 *   - `{ ok: false, reason: "no live session" }` for an unknown task.
 *   - `{ ok: false, reason: "current mode unknown" }` before claude's first
 *     `system` event has arrived.
 *   - `{ ok: false, reason: "mode not in cycle", target }` when the target
 *     isn't reachable (e.g. `bypassPermissions` without the launch flag —
 *     a respawn is required).
 *   - `{ ok: false, reason: "verification timed out", attempts, lastObserved }`
 *     when no `permission-mode` event followed our keystrokes.
 *   - `{ ok: false, reason: "verification mismatch", attempts, lastObserved }`
 *     when every attempt landed somewhere other than the target.
 */
export async function cycleToMode(taskId: string, targetAgetorMode: string): Promise<CycleResult> {
  const state = sessions.get(taskId);
  if (!state) return { ok: false, reason: "no live session" };
  const target = toClaudeModeString(targetAgetorMode);

  // `/plan` works from any state, no cycle math needed. Prefer it.
  // Fire-and-forget — `queuePaste`'s tmux load-buffer / paste-buffer /
  // send-keys helpers swallow errors, and verifying via the JSONL would
  // require the same listener machinery the Shift+Tab path uses; for
  // `plan` the slash command is reliable enough that the added complexity
  // doesn't pay for itself. Uses the slash-command settle window so a
  // racing user paste lands after claude has processed the mode switch.
  if (target === CLAUDE_MODE_PLAN) {
    void queuePaste(taskId, state.sessionName, "/plan", slashCommandSettleMs, state);
    return { ok: true, presses: 0, via: "slash-plan" };
  }

  if (!state.permissionMode) return { ok: false, reason: "current mode unknown" };
  if (state.permissionMode === target) return { ok: true, presses: 0, via: "noop" };

  const cycle = cycleOrderFor(state.bypassEnabled);
  if (cycleDistance(cycle, state.permissionMode, target) === null) {
    return { ok: false, reason: "mode not in cycle", target };
  }

  let totalPresses = 0;
  let attempts = 0;
  while (attempts < MAX_VERIFY_ATTEMPTS) {
    const current = state.permissionMode;
    if (current === target) {
      return { ok: true, presses: totalPresses, via: "shift-tab" };
    }
    // `current` is non-null on every iteration: the pre-loop guard
    // returned early when permissionMode was null, and `dispatchLine`
    // only ever writes strings to the field. The explicit check keeps
    // TS narrowing happy for the cycleDistance call below.
    const presses = current ? cycleDistance(cycle, current, target) : null;
    if (presses === null) {
      // Target was validated as in-cycle before the loop, so reaching
      // here means claude moved to a mode we don't recognise between
      // attempts (e.g. claude introduced a new mode). Bail rather than
      // spin.
      return {
        ok: false,
        reason: "verification mismatch",
        attempts,
        lastObserved: current,
      };
    }
    totalPresses += presses;
    attempts += 1;

    // Install the listener BEFORE sending keys so a fast `permission-mode`
    // event can't beat us. The Promise executor runs synchronously, so the
    // assignment is in place before `tmux send-keys` returns.
    //
    // Identity guard: hold our listener in a local and only clear the
    // session slot when it still points at *this* call's listener. Without
    // it, two overlapping `cycleToMode` calls (e.g. a user double-PATCH on
    // the same task) would have the earlier call's setTimeout-driven
    // cleanup null out the later call's listener, falsely reporting
    // `verification timed out` for both.
    const observed = await new Promise<string | null>((resolve) => {
      let myListener: ((mode: string) => void) | null = null;
      const timer = setTimeout(() => {
        if (state.onPermissionMode === myListener) state.onPermissionMode = null;
        resolve(null);
      }, modeVerifyTimeoutMs);
      myListener = (mode) => {
        clearTimeout(timer);
        resolve(mode);
      };
      state.onPermissionMode = myListener;
      // One tmux invocation with N keys — cleaner than N sync spawns, and
      // tmux delivers them as a single stream so claude's TUI doesn't get
      // a chance to debounce them apart on slow terminals.
      const keys = Array<string>(presses).fill("S-Tab");
      tmux(["send-keys", "-t", state.sessionName, ...keys]);
    });

    if (observed === null) {
      return {
        ok: false,
        reason: "verification timed out",
        attempts,
        lastObserved: state.permissionMode,
      };
    }
    if (observed === target) {
      return { ok: true, presses: totalPresses, via: "shift-tab" };
    }
    // Mismatch — loop and retry from the newly-observed mode. `dispatchLine`
    // has already updated `state.permissionMode` to `observed`.
  }

  return {
    ok: false,
    reason: "verification mismatch",
    attempts,
    lastObserved: state.permissionMode,
  };
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
  state.onPermissionMode = null;
  state.pendingEndTurn = null;
  const err = new Error("session killed");
  for (const slot of state.turnQueue.splice(0)) slot.reject?.(err);
  // Drop the chain map entry — the identity gate inside `queueTmuxOp`
  // will already skip any in-flight thunks that captured the now-disposed
  // `state` (they won't run their bodies), so this delete is just
  // hygiene to release the map slot eagerly instead of waiting for the
  // chain's self-evict `.finally` to fire.
  pasteChains.delete(state.taskId);
}

function makeAgent(taskId: string, done: Promise<number>): SpawnedAgent {
  return {
    kill: () => {
      // Interrupt every queued turn for this task. Ctrl+C aborts whatever
      // claude is doing in the TUI and clears its queued-input buffer
      // (anything we'd pasted while it was thinking). Reject the full
      // queue so each run's done settles with "cancelled". Drop any staged
      // end_turn so a late-arriving JSONL line can't fire it post-cancel
      // and emit a spurious "turn complete" banner on the cancelled run.
      const state = sessions.get(taskId);
      if (!state) return;
      tmux(["send-keys", "-t", state.sessionName, "C-c"]);
      const err = new Error("cancelled");
      state.pendingEndTurn = null;
      for (const slot of state.turnQueue.splice(0)) slot.reject?.(err);
    },
    writeInput: (line) => {
      const state = sessions.get(taskId);
      if (!state) return false;
      void queuePaste(taskId, state.sessionName, line, 0, state, { bracketed: true });
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
    const state = makeSessionState({
      taskId,
      sessionName: `agetor-test-${taskId}`,
      cwd: "/tmp",
      jsonlPath,
    });
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
  firePendingEndTurn,
  matchNumberedModal,
  matchYesNoModal,
  matchStartupConsentDialog,
  resumeJsonlOffset,
  /** Override the JSONL verification timeout used by `cycleToMode`. Tests
   *  shrink it to keep "timeout" cases fast. Returns the previous value
   *  so the test can restore it in `afterEach`. */
  setModeVerifyTimeoutMs(ms: number): number {
    const prev = modeVerifyTimeoutMs;
    modeVerifyTimeoutMs = ms;
    return prev;
  },
  /** Read-only accessor for the current verify timeout. */
  getModeVerifyTimeoutMs(): number { return modeVerifyTimeoutMs; },
  /** Max attempts cycleToMode will make before reporting `verification
   *  mismatch`. Exposed so tests can assert against the constant rather
   *  than hardcoding "3". */
  MAX_VERIFY_ATTEMPTS,
  /** Override the slash-command settle window. Tests shrink it to ~0
   *  to avoid sleeping on every paste-queue assertion. Returns the
   *  previous value so the test can restore it in `afterEach`. */
  setSlashCommandSettleMs(ms: number): number {
    const prev = slashCommandSettleMs;
    slashCommandSettleMs = ms;
    return prev;
  },
  getSlashCommandSettleMs(): number { return slashCommandSettleMs; },
  /** Override the bracketed-paste → Enter gap. Tests shrink it to ~0 to
   *  avoid sleeping on every paste-queue assertion. Returns the previous
   *  value so the test can restore it in `afterEach`. */
  setBracketedEnterGapMs(ms: number): number {
    const prev = bracketedEnterGapMs;
    bracketedEnterGapMs = ms;
    return prev;
  },
  getBracketedEnterGapMs(): number { return bracketedEnterGapMs; },
  /** Override the image-attach settle window — the per-image delay used
   *  when the paste contains image file paths. Tests shrink it to ~0 to
   *  avoid sleeping per image-path assertion. Returns the previous value
   *  for restore. */
  setImageAttachSettleMs(ms: number): number {
    const prev = imageAttachSettleMs;
    imageAttachSettleMs = ms;
    return prev;
  },
  getImageAttachSettleMs(): number { return imageAttachSettleMs; },
  /** Image-path detection used by `queuePaste` to decide whether to
   *  take the long (image-attach) gap. Re-exported for unit tests so the
   *  rule can be asserted without reaching into the regex literal. */
  pasteContainsImagePath,
  /** Count the image paths the regex finds. Used internally to scale the
   *  settle window by image count; exposed so tests can pin the heuristic. */
  countImagePaths,
  /** Direct access to the paste queue for assertions. Read-only — tests
   *  inspect ordering by observing tmux side effects, not by mutating
   *  the chain. */
  pasteChains,
  queuePaste,
  queueTmuxOp,
};

/**
 * Match a file path whose basename ends in a common image extension. The
 * pattern requires a word character immediately before the `.ext` so a
 * bare `.png` token in prose ("save as .png next") or accidental ones
 * like `..png` / `,.png` don't trigger the image-attach slow path. The
 * extension list is kept in sync with `IMAGE` in
 * `src/mainview/lib/file-icons.tsx` — when adding a new extension there,
 * add it here too.
 */
const IMAGE_PATH_RE =
  /[\w.\-/]*\w\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|heic)\b/gi;

/** True iff `text` carries at least one image-file path. Exported via
 *  `__forTest` so the unit suite can assert the detection rule without
 *  reaching into the regex literal. */
export function pasteContainsImagePath(text: string): boolean {
  // Reset state on the global regex before .test() — without it, .test()
  // resumes from lastIndex and a repeat call on the same string returns
  // alternating true/false.
  IMAGE_PATH_RE.lastIndex = 0;
  return IMAGE_PATH_RE.test(text);
}

/** Number of image-file paths in `text`. Used to scale the settle window
 *  so multi-image pastes get proportional time for claude's bracketed-
 *  paste handler to read, encode, and attach each one. */
export function countImagePaths(text: string): number {
  return text.match(IMAGE_PATH_RE)?.length ?? 0;
}

/**
 * Per-image settle window. Claude's TUI reads the image synchronously on
 * its input thread when it sees a path in a bracketed paste — it replaces
 * the path with an `[Image #N]` placeholder, reads the file, and base64-
 * encodes it. A `send-keys Enter` that arrives mid-flight is consumed by
 * the attachment flow instead of submitting the message, leaving the
 * text + placeholder sitting in the input forever. 600 ms comfortably
 * exceeds the time observed for ~MB-sized screenshots; the cost is paid
 * only when the heuristic fires, and is scaled by the number of image
 * paths in the paste (Retina screenshots are routinely 3-5 MB and four
 * of them in one message would exceed a single 600 ms budget).
 *
 * The scaled total is capped at `IMAGE_ATTACH_SETTLE_MAX_MS` so a paste
 * that accidentally trips the detector many times (e.g. a doc dump that
 * mentions many `.png` files) doesn't stall the queue for seconds.
 *
 * Tests shrink the per-image value to ~0 to keep the queue suite fast.
 */
let imageAttachSettleMs = 600;

/** Absolute upper bound on the scaled settle window. Picked at 3 s —
 *  beyond the slowest observed multi-image attach in practice while still
 *  bounding the worst-case stall a paste can introduce. */
const IMAGE_ATTACH_SETTLE_MAX_MS = 3_000;

/**
 * Send `text` as a single user turn to the named tmux session. We pipe via
 * `load-buffer -` to avoid shell-quoting issues (the prompt may contain
 * newlines, dollar signs, quotes, …), paste it into the active window, then
 * press Enter to submit.
 *
 * Stays synchronous — the caller (`queuePaste`) is responsible for any
 * post-paste delays (the base bracketed gap or the longer image-attach
 * gap) and for re-gating the trailing Enter on session identity. Keeping
 * this function sync preserves the "no awaits between tmux calls"
 * invariant the `queueTmuxOp` chain depends on; the gap + Enter split for
 * the bracketed case happens in `queuePaste`.
 *
 * `skipEnter` defers the trailing Enter to the caller so it can insert a
 * gap before the `send-keys Enter`. See `queuePaste`'s bracketed branch
 * for the rationale (and the image-attach scaling layered on top of it).
 *
 * Callers go through `queuePaste` so back-to-back pastes for the same
 * task can't interleave at the tmux layer. See `queuePaste` for why.
 */
function pastePromptSync(
  sessionName: string,
  text: string,
  opts: { bracketed?: boolean; skipEnter?: boolean } = {},
): void {
  // load-buffer reads from stdin; -b names a tmux buffer we can target.
  const buf = `agetor-${sessionName}`;
  const load = tmux(["load-buffer", "-b", buf, "-"], { stdinText: text });
  if (!load.ok) return;
  // `-p` wraps the paste in bracketed-paste codes (ESC[200~ … ESC[201~) when
  // the app has requested bracketed-paste mode (claude's Ink TUI does). Long
  // prompts otherwise arrive across multiple terminal reads, claude's paste
  // heuristic fires per chunk (multiple `[Pasted text +N lines]` blocks) and
  // the trailing Enter gets absorbed instead of submitting. Gated on
  // `bracketed` so single-line slash commands (`/model`, `/effort`, `/plan`)
  // still arrive as plain typed input — bracketed-paste readline handlers
  // typically insert pasted text verbatim instead of dispatching it as a
  // command, which would silently break the mode/model switchers.
  const pasteFlags = opts.bracketed ? ["-p"] : [];
  tmux(["paste-buffer", ...pasteFlags, "-b", buf, "-t", sessionName]);
  tmux(["delete-buffer", "-b", buf]);
  // `skipEnter` defers the trailing Enter to the caller so it can sleep
  // between the bracketed paste and the Enter — see `queuePaste`. Without
  // that gap, a follow-up turn pasted mid-stream gets rendered as `[Pasted
  // text +N lines]` in claude's TUI but the immediately-following `\r` is
  // absorbed as part of the same paste event, so the queued bubble sits
  // unsubmitted until the user (or a later Enter) commits it.
  if (!opts.skipEnter) tmux(["send-keys", "-t", sessionName, "Enter"]);
}

/**
 * Settle window after a slash-command paste before releasing the chain.
 *
 * Picked conservatively at 700ms — comfortably above the ~hundreds of ms
 * claude's TUI takes to consume a `/model` / `/effort` / `/plan` line
 * and repaint a ready prompt on an idle session. The original repro
 * ("Turn Ended Bug") showed 0ms is wrong; the exact upper bound hasn't
 * been measured under load, so the choice favors "definitely safe" over
 * "minimum perceptible latency." The cost is one delay per slash command,
 * applied before the *next* operation — never before the slash itself.
 *
 * Important caveat about what this delay actually buys: the timer starts
 * when `pastePromptSync` returns (i.e. when tmux's `send-keys Enter`
 * exits), NOT when claude has finished processing the slash command. On
 * an idle REPL these are close enough that 700ms covers consumption +
 * repaint. When claude is mid-turn, the slash command queues inside
 * claude's input buffer; the timer expires while claude is still on the
 * prior turn, but order is preserved by claude's own FIFO buffer — so
 * the next paste lands behind the slash command anyway. The fragile case
 * the lock plugs is the idle-REPL transient state, which the original
 * bug exposed.
 *
 * Tests shrink the value to keep the queue suite fast.
 */
let slashCommandSettleMs = 700;

/**
 * Gap between the bracketed-paste body (`paste-buffer -p`) and the trailing
 * `send-keys Enter` for follow-up turns. Without a gap, claude's Ink TUI
 * sees the `ESC[201~` end marker and the immediately-following `\r` as part
 * of the same input read; the `\r` is absorbed as part of the paste event
 * and the `[Pasted text +N lines]` bubble sits unsubmitted until something
 * else commits it. 80ms comfortably exceeds the few-ms claude's reader
 * takes to process the end marker on an idle session; the cost is one
 * delay per follow-up paste, observable only as a brief queueing window.
 *
 * Only applied in bracketed mode — non-bracketed pastes (slash commands)
 * stream as plain keystrokes and don't have the paste-event coalescing
 * window. Tests shrink the value to keep the queue suite fast.
 *
 * Failure mode is asymmetric: too low silently regresses to the "paste
 * shown, never submitted" bug with no log signal (the queued bubble
 * just sits in the TUI input until something else commits it), while
 * too high only adds perceived latency to follow-up turns. Prefer
 * raising over lowering when in doubt. A real-world ceiling under load
 * (e.g. claude paused on a tool call, reader latency higher) has not
 * been measured — if you observe the regression returning, bump this
 * first before assuming a structural fix is needed.
 */
let bracketedEnterGapMs = 80;

/**
 * Append a tmux operation to the per-task chain. The `fn` thunk runs
 * after every prior op for the same task has settled. Errors thrown by
 * `fn` are logged but never rejected onto the returned promise — one
 * transient tmux failure shouldn't poison every subsequent op for the
 * session. The returned promise resolves once `fn` (including any internal
 * delays it awaits) has settled, which is when the *next* chained op
 * becomes eligible to run. Callers fire-and-forget unless they need to
 * synchronize with the op's completion (e.g. `dismissTmuxPrompt`, which
 * needs to read the result of the final `send-keys Enter`).
 *
 * Used directly for ops that aren't a simple `paste-buffer + Enter`
 * (modal dismissals send individual `send-keys` with their own internal
 * gap). `queuePaste` is the convenience wrapper for the common case.
 *
 * `expectedState`, when provided, is captured at scheduling time and
 * compared against `sessions.get(taskId)` right before `fn` runs (the
 * one-shot entry gate) AND surfaced to `fn` as the `stillCurrent()`
 * predicate so thunks with internal awaits can re-check between tmux
 * calls. This closes the narrow race where `sessionNameFor(taskId)` is
 * deterministic, so a re-spawn for the same task reuses the same tmux
 * session name and a previously-queued op would otherwise send
 * keystrokes into the *new* session — including the case where
 * `dropSession` lands DURING `fn`'s `Bun.sleep` gap, leaving the
 * trailing tmux call to leak into the respawned pane.
 *
 * ⚠️ Production callers MUST pass `expectedState`. The parameter is
 * optional only because the unit test suite (`claude-tmux-queue.test.ts`)
 * needs to drive the chain without installing a full SessionState for
 * every ordering assertion; omitting it disables the gate entirely. If
 * you're wiring up a new tmux op from any non-test code, pass the
 * `SessionState` you got from `sessions.get(taskId)` — that's what
 * makes the gate fire. The `expectedState`-less form behaves as if the
 * gate is permanently open.
 *
 * `fn` receives a `stillCurrent()` predicate it can call before any
 * post-await tmux work. When `expectedState` is omitted the predicate
 * is always `true` (consistent with no-gate behavior).
 */
function queueTmuxOp(
  taskId: string,
  fn: (stillCurrent: () => boolean) => void | Promise<void>,
  expectedState?: SessionState,
): Promise<void> {
  const stillCurrent = (): boolean =>
    expectedState === undefined || sessions.get(taskId) === expectedState;
  const prev = pasteChains.get(taskId) ?? Promise.resolve();
  const next = prev.then(async () => {
    // Identity-gate at body entry. `sessions.get(taskId) !== expectedState`
    // means the session this op was queued against is gone — either
    // disposed without a respawn (sessions.get returns undefined) or
    // disposed and respawned as a fresh SessionState reusing the
    // taskId. In both cases the right behavior is to drop the op.
    // `fn` itself can re-check via the same predicate between awaits.
    if (!stillCurrent()) return;
    await fn(stillCurrent);
  }).catch((e) => {
    console.error(`tmux op chain error for task ${taskId}:`, e);
  });
  pasteChains.set(taskId, next);
  // Self-evict when this is still the tail — keeps the map from
  // accumulating entries for tasks that have gone idle. If something
  // chained after us, the newer entry now owns the slot and we leave
  // it alone. Identity check guards against the racy ordering where
  // a follow-up op's `set(taskId, newer)` runs before our finally fires.
  void next.finally(() => {
    if (pasteChains.get(taskId) === next) pasteChains.delete(taskId);
  });
  return next;
}

/**
 * Convenience wrapper over `queueTmuxOp` for the common case: paste
 * `text` into `sessionName` and (optionally) hold the chain for
 * `settleMs` afterwards so claude's TUI has time to finish processing
 * the line before the next op runs.
 *
 * The returned promise resolves AFTER the paste AND the settle delay —
 * i.e. when the next chained op becomes eligible, NOT when tmux has
 * received the paste. Callers awaiting "did tmux get the keystrokes"
 * should not infer that from this promise; the only thing the promise
 * guarantees is chain ordering.
 *
 * Pass `expectedState` to gate the paste on the session still being
 * the one this paste was scheduled against — see `queueTmuxOp` for the
 * race this closes.
 *
 * When `opts.bracketed` is true, the trailing `Enter` is split out of
 * the synchronous paste body and sent after a small internal gap
 * (`bracketedEnterGapMs`) so claude's Ink TUI commits the `ESC[200~ …
 * ESC[201~` paste event before the `\r` arrives — without that gap the
 * Enter is absorbed as part of the paste event and the queued bubble
 * sits unsubmitted. The deferred Enter is re-gated through
 * `stillCurrent()` so a `dropSession` landing during the gap can't
 * leak the keystroke into a respawned pane.
 */
function queuePaste(
  taskId: string,
  sessionName: string,
  text: string,
  settleMs: number,
  expectedState?: SessionState,
  opts: { bracketed?: boolean } = {},
): Promise<void> {
  // Non-bracketed path: load-buffer + paste-buffer + delete-buffer +
  // send-keys Enter all happen synchronously inside pastePromptSync, so
  // the only await is the optional settle — no tmux calls land after the
  // sleep, and a dispose during the sleep can't leak keystrokes.
  //
  // Bracketed path: we split the trailing Enter out and insert a gap so
  // claude's Ink TUI has time to consume `ESC[201~` and commit the paste
  // before the `\r` arrives. Without the gap the Enter is absorbed as
  // part of the paste event and the queued bubble sits unsubmitted
  // (especially when the previous turn is still streaming or has a
  // background tool in flight — see the "[Pasted text #N +M lines] never
  // submits" repro).
  //
  // Image-bearing pastes need a LONGER gap than the base 80 ms: claude's
  // bracketed-paste handler reads + base64-encodes each image file when
  // it sees an image path in the paste, and the trailing Enter sent
  // before that finishes is consumed by the attach flow instead of
  // submitting the message — the "[Image #N] stuck in input" repro. So
  // when image paths are detected we scale the gap by image count (up to
  // `IMAGE_ATTACH_SETTLE_MAX_MS`); otherwise the base
  // `bracketedEnterGapMs` applies. Exactly one Enter either way — a
  // second Enter would risk a stray empty submit / pane interrupt on an
  // idle prompt.
  //
  // The deferred Enter is re-gated through `stillCurrent()` so a
  // `dropSession` landing in the gap can't leak the Enter into a
  // respawned pane.
  return queueTmuxOp(taskId, async (stillCurrent) => {
    if (opts.bracketed) {
      pastePromptSync(sessionName, text, { ...opts, skipEnter: true });
      const imageCount = countImagePaths(text);
      const gap = imageCount > 0
        ? Math.min(imageAttachSettleMs * imageCount, IMAGE_ATTACH_SETTLE_MAX_MS)
        : bracketedEnterGapMs;
      if (gap > 0) await Bun.sleep(gap);
      if (!stillCurrent()) return;
      tmux(["send-keys", "-t", sessionName, "Enter"]);
    } else {
      pastePromptSync(sessionName, text, opts);
    }
    if (settleMs > 0) await Bun.sleep(settleMs);
  }, expectedState);
}
