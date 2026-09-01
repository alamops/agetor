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
import { attachSubagentWatcher, detachWatcherFor, orphanRunningSubagents, type SubagentWatcherHandle } from "./claude-subagents.ts";
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
import { resolveTmuxBin, tmuxSocketArgs } from "./tmux-resolution.ts";
import { createDeathProbe } from "./session-liveness.ts";
import { detectAskModal, parseModalPane, type AskModalKind, type NavKey, type ParsedQuestionPane } from "./claude-questions.ts";

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
import { PERMISSION_MODE_STATUS_PREFIX, SESSION_DIED_STATUS_PREFIX } from "../shared/types.ts";
import { imageSourceMetaPath } from "../shared/attachments.ts";

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
  /**
   * Terminal outcome of the PASTE that delivered this turn's prompt into
   * claude's composer — `{ ok: true }` once the text (and, on the bracketed
   * path, its trailing Enter) actually went out, else the failing
   * `PasteOutcome` (a tmux error, or one of `queuePaste`'s modal-guard
   * withholds). NEVER rejects, and always settles exactly once, including
   * when the queued tmux op is dropped without running (see
   * `PASTE_DROPPED_OUTCOME`).
   *
   * Distinct from `done`, which reports what CLAUDE did with the turn: this
   * reports whether the turn's text ever reached claude at all. A caller that
   * needs to know "did my message land" — to decide whether to keep an
   * optimistic user bubble, re-stash the text, or word a status line — should
   * await this rather than inferring it from `done`'s rejection.
   *
   * Optional because only the paths that actually paste populate it: today
   * `sendTurn` (via `makeAgent`'s third argument). `spawnClaudeViaTmux`,
   * `reattachSession` and `rejectedAgent` leave it undefined — the first
   * usually embeds its prompt in argv rather than pasting, and the other two
   * never paste at all.
   */
  pasteOutcome?: Promise<PasteOutcome>;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Orchestrator injection seams.
 *
 * The orchestrator (server-side, imports this module) needs to reach INTO a
 * live tmux-driven session at a few points this module can't decide on its
 * own: which task a stray content line belongs to, whether a task is being
 * held open for background agents, and when a background task/agent settles.
 * Rather than import orchestrator.ts here (a cycle — orchestrator already
 * imports claude-tmux for spawn/sendTurn/etc.), each seam is a module-level
 * setter the orchestrator calls once at startup, mirroring the `emitFn` /
 * `settleFn` pattern in claude-subagents.ts. All three default to null
 * (no-op), so this file's behavior is byte-for-byte unchanged until
 * something wires them up.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Everything `dispatchLine` needs to adopt a stray content line into a fresh
 * run — see `setContinuationRunFactory` below. `onChunk` matches
 * `ChunkHandler` exactly (the same sink shape every turn slot already uses);
 * `onAdopted` hands back a live control handle shaped exactly like
 * `SpawnedAgent` (kill / writeInput / done) so the caller can Stop or fold a
 * follow-up into the continuation run the same way it already does for a
 * normal turn.
 */
export type ContinuationHooks = {
  onChunk: ChunkHandler;
  onAdopted: (handle: SpawnedAgent) => void;
};

/**
 * Factory the orchestrator installs to adopt a "stray" line — one that
 * arrives on a session with no turn in flight and nothing queued to receive
 * it, either genuine content OR the task-notification line itself (see
 * `maybeAdoptContinuation`, called from `dispatchLine`). This is exactly
 * what happens after claude auto-resumes following a background-task
 * notification: the prior run already resolved on its own `end_turn`, so
 * without this seam the resumed conversation would silently dispatch
 * through the stale `state.lastChunk` under the already-succeeded run.
 * Returns `null` for a task the orchestrator doesn't want to (or can't)
 * open a new run for — e.g. the task row is gone or archived — in which
 * case `dispatchLine` falls back to today's `lastChunk` routing.
 *
 * Save/restore this like `claude-subagents.ts`'s `setSubagentEmitter`: a
 * test that installs a fake here and doesn't put the real one back strands
 * every later test file that dispatches a JSONL line while idle.
 */
let continuationRunFactory: ((taskId: string) => ContinuationHooks | null) | null = null;
export function setContinuationRunFactory(
  fn: ((taskId: string) => ContinuationHooks | null) | null,
): ((taskId: string) => ContinuationHooks | null) | null {
  const prev = continuationRunFactory;
  continuationRunFactory = fn;
  return prev;
}

/**
 * Predicate the orchestrator installs to answer "is this task being held
 * open for background agents right now?" (the #92 hold: the main run
 * already resolved but the kanban card stays in `running` while subagents
 * finish). `startDeathWatch` keeps polling `tmux has-session` while this is
 * true even though `turnInFlight` is false — otherwise a session dying
 * mid-hold would never be detected until the next boot's reconciliation.
 * Returns `false` (via the `?.` at call sites) when unset, so death-watch
 * gating is byte-for-byte unchanged until this is wired.
 */
let heldSessionProbe: ((taskId: string) => boolean) | null = null;
export function setHeldSessionProbe(
  fn: ((taskId: string) => boolean) | null,
): ((taskId: string) => boolean) | null {
  const prev = heldSessionProbe;
  heldSessionProbe = fn;
  return prev;
}

/** Call `heldSessionProbe`, never letting a throwing probe reach the death
 *  watch — mirrors `fireBackgroundTaskSettled` just below: the probe runs
 *  orchestrator DB reads we don't control (SQLite can transiently throw,
 *  e.g. "database is busy"), and a bad read must not crash the poll tick.
 *  Treats a throw as "not held", the same as the unset (`null`) case. */
function heldProbeSafe(taskId: string): boolean {
  try {
    return heldSessionProbe?.(taskId) ?? false;
  } catch (e) {
    console.error(`[claude-tmux] heldSessionProbe threw for task ${taskId}:`, e);
    return false;
  }
}

/**
 * Predicate the orchestrator injects to answer "what run id is currently
 * in flight (i.e. tracked in the orchestrator's own `active` map) for this
 * task?" — `null` when none. `signalSubagentApiError` uses this to guard
 * against a STALE async subagent (spawned by an OLDER run) erroring while a
 * NEWER run is in flight on the same tmux session: `TurnSlot` carries no
 * run id of its own (it's just `{ onChunk, resolve, reject }`), so there is
 * no way to answer "which run does the live turn belong to" from
 * `SessionState` alone — the orchestrator's `active` map (keyed by run id)
 * is the only place that association lives. Mirrors `heldSessionProbe`
 * exactly: installed as a *module-level* side effect of importing
 * `orchestrator.ts` (not lazily on first use), `null` until then. In
 * production that import always happens (`index.ts` pulls it in at boot), so
 * "unset" is not a reachable production state — it only shows up when a unit
 * test drives `signalSubagentApiError` directly without ever importing
 * `orchestrator.ts`. Because `bun test` shares one module cache across every
 * file in a run, importing `orchestrator.ts` from *any* test file installs
 * this probe for the rest of the process — so a test that wants "no probe"
 * semantics can only get that reliably when run in isolation. Tests that
 * exercise this gate should install an explicit matching (or mismatching)
 * probe via `setActiveRunProbe` and restore the previous value afterward,
 * rather than assuming the ambient value is `null`. */
let activeRunProbe: ((taskId: string) => string | null) | null = null;
export function setActiveRunProbe(
  fn: ((taskId: string) => string | null) | null,
): ((taskId: string) => string | null) | null {
  const prev = activeRunProbe;
  activeRunProbe = fn;
  return prev;
}

/** Call `activeRunProbe`, never letting a throwing probe reach the tailer's
 *  api-error callback — same rationale as `heldProbeSafe`. Only meaningful
 *  to call once the caller has confirmed `activeRunProbe` is non-null (a
 *  throw mid-call still degrades to "no active run", not "unset"). */
function activeRunProbeSafe(taskId: string): string | null {
  try {
    return activeRunProbe?.(taskId) ?? null;
  } catch (e) {
    console.error(`[claude-tmux] activeRunProbe threw for task ${taskId}:`, e);
    return null;
  }
}

/**
 * Handler the orchestrator installs to learn that a background task/agent
 * named in a task-notification JSONL line has settled — or, for a Monitor,
 * merely reported an ordinary event — so it can flip the matching
 * `subagents` row and re-check the hold predicate above. Fired from
 * `dispatchLine` whenever a task-notification's `<task-id>` can be parsed
 * out of the line — tolerant by design: when no id is found the call is
 * simply skipped, since session death and boot reconciliation are
 * independent settle signals that don't depend on this one firing. The
 * third argument is the notification's raw payload: a background shell or
 * Task-tool agent's `<task-id>` is only ever seen once, on completion, but a
 * Monitor reuses the exact same envelope for every intermediate event and
 * again for its terminal one — the callee needs the body to tell the two
 * apart instead of treating every naming of the id as a completion receipt.
 */
let backgroundTaskSettledFn:
  | ((taskId: string, agentId: string, body: string, lineTimestampMs?: number | null) => void)
  | null = null;
export function setBackgroundTaskSettledHandler(
  fn: ((taskId: string, agentId: string, body: string, lineTimestampMs?: number | null) => void) | null,
): ((taskId: string, agentId: string, body: string, lineTimestampMs?: number | null) => void) | null {
  const prev = backgroundTaskSettledFn;
  backgroundTaskSettledFn = fn;
  return prev;
}

/** Call the background-task-settled hook, never letting a throwing hook
 *  reach the tailer — mirrors `fireSettle` in claude-subagents.ts; the hook
 *  runs orchestrator logic we don't control, and a bad handler must not
 *  take the JSONL tail down. */
function fireBackgroundTaskSettled(
  taskId: string,
  agentId: string,
  body: string,
  lineTimestampMs: number | null = null,
): void {
  try {
    backgroundTaskSettledFn?.(taskId, agentId, body, lineTimestampMs);
  } catch (e) {
    console.error(`[claude-tmux] background-task-settled hook threw for task ${taskId}:`, e);
  }
}

/**
 * Payload `fireLocalSettingChanged` hands the orchestrator when claude
 * itself resolves a `/model` or `/effort` local command (docs/plans/
 * model-effort-local-command-turns.md §10). `args` is the raw
 * `<command-args>` text off that command's own `<command-name>` line
 * (`""` for a bare `/model`/`/effort` with no argument); `stdout` is the
 * raw inner text of the matching `<local-command-stdout>` line, ANSI
 * escapes left as-is — the orchestrator's `parseClaudeLocalSetting` is
 * what strips/interprets both.
 *
 * `viaMirror` answers "did AGETOR drive this outcome?" — true iff
 * `mirrorModelViaPicker` sent the picker's session-only confirm for this task
 * within the last `MODEL_MIRROR_ATTRIBUTION_MS` (see
 * `SessionState.lastModelMirrorAt`). It is only MEANINGFUL for
 * `setting: "model"`, and only for a `Kept model as <X>` outcome — the one
 * shape that is either "the user declined agetor's own switch confirm"
 * (sync the row back) or "the user opened a bare `/model` and pressed Esc"
 * (leave the row's deliberate next-run choice alone). Computed uniformly at
 * the seam for both settings anyway, so the payload stays a plain snapshot
 * rather than a conditional one; the effort branch simply never reads it.
 */
export interface LocalSettingInfo {
  setting: "model" | "effort";
  args: string;
  stdout: string;
  viaMirror: boolean;
}

/**
 * How long after `mirrorModelViaPicker`'s session-only confirm keystroke a
 * `/model` outcome is still attributed to agetor's own mirror
 * (`LocalSettingInfo.viaMirror`).
 *
 * Sized off the mirror's own choreography, not guessed: the confirm key is
 * sent, `autoConfirmSlashModal` then polls for `Switch model?` for up to
 * `SLASH_CONFIRM_WINDOW_MS`, the user answers it (or agetor auto-confirms),
 * and only then does claude write the `<local-command-stdout>` line the JSONL
 * tailer has to notice and dispatch. 15 s covers that chain with room for a
 * slow write/tail without being so wide that an unrelated bare `/model` +
 * Esc a minute later could still be credited to the mirror. Erring long is
 * the cheaper mistake in only one direction — a mis-attributed sync writes
 * the model claude actually kept, whereas a mis-attributed SKIP would leave
 * the row disagreeing with a switch the user really did decline — but both
 * are corrected by the next real outcome, so the window stays tight.
 */
const MODEL_MIRROR_ATTRIBUTION_MS = 15_000;

/**
 * Handler the orchestrator installs to learn that claude itself just
 * resolved a `/model` or `/effort` local command — fired from
 * `dispatchLine` on that command's own `<local-command-stdout>` line,
 * regardless of which path drove it (a typed `/model x` / `/effort x`, a
 * picker/slider/confirm card answer, the orchestrator's own dropdown
 * mirror via `sendSlashCommand`, or a terminal-side change the user made
 * directly) — so `task.model`/`task.effort` can be kept in sync with
 * claude's own record of the outcome rather than trusting whichever
 * agetor-side action triggered it. Mirrors `backgroundTaskSettledFn`
 * exactly.
 */
let localSettingChangedFn: ((taskId: string, info: LocalSettingInfo) => void) | null = null;
export function setLocalSettingChangedHandler(
  fn: ((taskId: string, info: LocalSettingInfo) => void) | null,
): ((taskId: string, info: LocalSettingInfo) => void) | null {
  const prev = localSettingChangedFn;
  localSettingChangedFn = fn;
  return prev;
}

/** Call the local-setting-changed hook, never letting a throwing hook
 *  reach the tailer — mirrors `fireBackgroundTaskSettled` immediately
 *  above; the hook runs orchestrator logic (a DB write) we don't control,
 *  and a bad handler must not take the JSONL tail down. */
function fireLocalSettingChanged(taskId: string, info: LocalSettingInfo): void {
  try {
    localSettingChangedFn?.(taskId, info);
  } catch (e) {
    console.error(`[claude-tmux] local-setting-changed hook threw for task ${taskId}:`, e);
  }
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
  /**
   * Set by `agents.ts` (`buildCommand` → `spawnAgent`) when the prompt was
   * too large to embed in `argv` (over `CLAUDE_PROMPT_ARGV_MAX_BYTES` — tmux's
   * ~16KB client-command cap). When present, `argv` carries no prompt at all
   * and this raw text is delivered post-launch by pasting it into the tmux
   * pane once claude's composer is idle, via the same load-buffer/paste-
   * buffer machinery `sendTurn` uses for live-session follow-ups.
   */
  deferredPrompt?: string;
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
 * Build the env every spawned claude session runs with: the caller-supplied
 * env (model / effort / CLAUDE_CONFIG_DIR vars from `buildCommand`) with two
 * agetor pins layered on top.
 *
 *   - **PATH** is re-injected from the current process because the tmux
 *     *server* captures env at its first launch and reuses it for every
 *     subsequent session — passing it per-session via `-e` guarantees the
 *     spawned claude sees the freshly-rehydrated PATH even if the long-running
 *     bundled tmux server captured a stale copy (e.g. agetor restarted with a
 *     different login-shell PATH).
 *   - **CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1** forces claude's classic
 *     (inline) renderer regardless of the user's saved `tui` setting. Claude
 *     Code v2.1.89+ added an opt-in "Fullscreen rendering" mode (`/tui
 *     fullscreen` / `CLAUDE_CODE_NO_FLICKER=1`) that draws the TUI on the
 *     terminal's ALTERNATE screen buffer. The spawned claude reads the user's
 *     global `~/.claude/settings.json`, so a user who enabled fullscreen in
 *     their own everyday claude usage would flip agetor's sessions into it too
 *     — which breaks the pane scraper (`scrapeTimer` → `capture-pane`) we rely
 *     on to catch the permission / AskUserQuestion modals the hook system
 *     bypasses: the alt screen has NO scrollback, so the AskUserQuestion
 *     collector's `capture-pane -p -S -200` comes back truncated, and the modal
 *     geometry the fingerprinting is tuned to changes. agetor never shows the
 *     tmux pane (its own UI renders the JSONL stream), so fullscreen's
 *     flicker / memory / mouse wins are irrelevant here. Per the docs this var
 *     takes precedence over `CLAUDE_CODE_NO_FLICKER` and the `tui` setting.
 *     Docs: https://code.claude.com/docs/en/fullscreen
 *
 * Both pins come AFTER the caller spread on purpose: agetor's classic-renderer
 * guarantee must not be silently overridable by a harness-level env that set
 * `CLAUDE_CODE_NO_FLICKER`.
 */
export function buildClaudeSessionEnv(callerEnv: Record<string, string>): Record<string, string> {
  return {
    ...callerEnv,
    PATH: process.env.PATH ?? "",
    CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
  };
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
  /** ISO-8601 write time claude stamps on every line — forwarded (as epoch ms)
   *  to the background-task-notification handler so claude-subagents can
   *  derive the same time-bucketed dedup key for a Monitor event that its
   *  own restart-safe scan of this line derives; without it the live and
   *  scan paths would persist the same event under two keys. */
  timestamp?: string;
  type?: string;
  /** Claude 2.1.x system events carry a `subtype` discriminator — observed
   *  values: `turn_duration` (durationMs + messageCount, emitted right after
   *  an assistant end_turn) and `away_summary` (recap text claude generated
   *  for resumption). Older events leave this null. */
  subtype?: string;
  uuid?: string;
  message?: AssistantMessage & UserMessage;
  /** The active permission mode. Carried on the dedicated `system`/
   *  `permission-mode` marker lines (emitted at the start of every turn, and
   *  on every actual change) AND, as a fallback signal, on every `type:
   *  "user"` line — see `mapParsedEventToChunks`'s `case "user"` and
   *  `dispatchLine`'s SessionState mirror, both of which read this field. */
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

/** Human-readable detail appended after `CLAUDE_API_ERROR_STATUS_PREFIX`.
 *  Single source of truth for both the mapper's own emit site (main-stream
 *  api errors, below) and `claude-subagents.ts`'s tailer peek (subagent api
 *  errors) — factored out so the two can't drift in wording, and so
 *  detection never has to string-match this rendered text (see
 *  `signalSubagentApiError` / the subagent tailer's peek, which key off the
 *  raw `isApiErrorMessage`/`apiErrorStatus` JSONL fields instead). */
export function formatApiErrorDetail(status: number | undefined): string {
  return typeof status === "number"
    ? `HTTP ${status} — turn aborted; blocked for manual retry`
    : "turn aborted; blocked for manual retry";
}

/** Status-chunk prefix for the "claude's TUI rejected the message as an
 *  unknown slash command" sentinel — mirrors `CLAUDE_API_ERROR_STATUS_PREFIX`
 *  exactly (producer here, consumer in orchestrator.ts's `makeChunkHandler`).
 *  See `signalUnknownCommand` for the emit site and `matchUnknownCommand` /
 *  `slashTokenOf` for detection. */
export const CLAUDE_UNKNOWN_COMMAND_STATUS_PREFIX = "unknown command: ";

/** Returns the first whitespace-delimited token of `prompt`'s first line iff
 *  that line starts with `/` (e.g. `"/skill-creator do the thing"` →
 *  `"/skill-creator"`), else null. Used to arm/disarm
 *  `SessionState.pendingSlashToken` at every prompt-delivery point — a prompt
 *  starting with `/` is the one case claude's Ink TUI may swallow as a slash
 *  command instead of delivering it as a message. */
function slashTokenOf(prompt: string): string | null {
  const firstLine = prompt.split("\n", 1)[0] ?? "";
  if (!firstLine.startsWith("/")) return null;
  return firstLine.match(/^(\S+)/)?.[1] ?? null;
}

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
 * True for a JSONL line that is a local slash command's OWN terminal
 * output — `<local-command-stdout>…</local-command-stdout>` — the only
 * signal a `/model`/`/effort` turn ever produces. Claude never follows one
 * with an `assistant`/`stop_reason:"end_turn"` line (verified: claude
 * 2.1.245 spike, 0 end_turn lines across three captured transcripts of
 * `/model <id>`, bare `/model`, and `/effort <id>`). Used by `dispatchLine`
 * to stage a settle for the turn — see that call site for the `TurnSlot.
 * slashCommand` gate that keeps this from firing on the wrong turn.
 *
 * Two shapes, matching the two JSONL forms claude 2.1.245 emits for a local
 * command:
 *
 *   1. `type:"user"`, `isMeta` NOT `true`, string `message.content` whose
 *      TRIMMED text starts with `<local-command-stdout>` — the common case
 *      (every command after the session's first).
 *   2. `type:"system"`, `subtype:"local_command"`, string top-level
 *      `content` CONTAINING `<local-command-stdout>` — the first-command-
 *      in-a-fresh-session variant, where claude hasn't yet switched to the
 *      `user`-wrapped shape and instead emits a flat envelope with no
 *      `message` wrapper.
 *
 * False for: the `isMeta:true` `<local-command-caveat>` breadcrumb claude
 * injects just before running the command (a note, not the result — see
 * `mapParsedEventToChunks`'s isMeta branch, which silences it entirely); the
 * `<command-name>…</command-name>` line the command itself lands on; any
 * `tool_result` array; and every `assistant` line.
 */
function isLocalCommandStdoutEvent(evt: ParsedJsonlEvent): boolean {
  if (evt.type === "user" && evt.isMeta !== true) {
    const content = evt.message?.content;
    return typeof content === "string" && content.trimStart().startsWith("<local-command-stdout>");
  }
  if (evt.type === "system" && evt.subtype === "local_command") {
    return typeof evt.content === "string" && evt.content.includes("<local-command-stdout>");
  }
  return false;
}

/**
 * Extract the raw inner text of a `<local-command-stdout>…</local-command-
 * stdout>` line — ANSI bold/color escapes left as-is (the orchestrator's
 * `parseClaudeLocalSetting`, docs/plans/model-effort-local-command-turns.md
 * §10, is the one that strips them, not this driver). Same two shapes
 * `isLocalCommandStdoutEvent` recognises. Returns "" when `evt` doesn't
 * actually carry the tag — this is only ever called after
 * `isLocalCommandStdoutEvent(evt)` has already confirmed it does, so "" is
 * unreachable in practice, but the function stays total rather than
 * assuming the two shape-checks can never drift apart.
 */
function extractLocalCommandStdout(evt: ParsedJsonlEvent): string {
  let content: unknown;
  if (evt.type === "user" && evt.isMeta !== true) {
    content = evt.message?.content;
  } else if (evt.type === "system" && evt.subtype === "local_command") {
    content = evt.content;
  } else {
    return "";
  }
  if (typeof content !== "string") return "";
  return /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(content)?.[1] ?? "";
}

/**
 * Extract BOTH the command token (e.g. `"/effort"`) AND its raw
 * `<command-args>…</command-args>` payload from a JSONL line carrying
 * `<command-name>/effort</command-name>\n<command-message>effort</command-
 * message>\n<command-args>high</command-args>` — `args` is `""` when the
 * `<command-args>` tag itself is empty (a bare `/model` with no argument),
 * or when the line carries no `<command-args>` tag at all. Returns `null`
 * when `evt` isn't one of the two shapes claude uses to land a local
 * command's name. Claude ALWAYS writes this line immediately before that
 * command's own `<local-command-stdout>` line (verified: claude 2.1.245
 * spike, both the `user`-wrapped and fresh-session
 * `system`/`subtype:"local_command"` shapes) — this is what lets
 * `dispatchLine` confirm a stdout line actually belongs to the head slot's
 * own command rather than a foreign one (see `SessionState.
 * lastLocalCommandName` / `lastLocalCommandArgs` and this function's call
 * site), and what feeds `args` into `LocalSettingInfo` for the
 * local-setting-sync seam.
 *
 * Same two shapes `isLocalCommandStdoutEvent` recognises:
 *
 *   1. `type:"user"`, `isMeta` NOT `true`, string `message.content` whose
 *      TRIMMED text starts with `<command-name>`.
 *   2. `type:"system"`, `subtype:"local_command"`, string top-level
 *      `content` whose TRIMMED text starts with `<command-name>`.
 *
 * Null for: the stdout line itself, the `isMeta:true` caveat, every
 * `assistant` line, and any other shape.
 */
function parseLocalCommandLine(evt: ParsedJsonlEvent): { name: string; args: string } | null {
  let content: unknown;
  if (evt.type === "user" && evt.isMeta !== true) {
    content = evt.message?.content;
  } else if (evt.type === "system" && evt.subtype === "local_command") {
    content = evt.content;
  } else {
    return null;
  }
  if (typeof content !== "string") return null;
  const trimmed = content.trimStart();
  const name = /^<command-name>([^<]*)<\/command-name>/.exec(trimmed)?.[1];
  if (name === undefined) return null;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(trimmed)?.[1] ?? "";
  return { name, args };
}

/** Test-only convenience wrapper over `parseLocalCommandLine` — no runtime
 *  call site needs just the token without the args (`dispatchLine` calls
 *  `parseLocalCommandLine` directly since it needs `args` too, for
 *  `lastLocalCommandArgs` / `LocalSettingInfo`). Kept around, and exposed via
 *  `__forTest`, purely so existing tests that only care about the token can
 *  assert against it without also matching on args. */
function localCommandNameOf(evt: ParsedJsonlEvent): string | null {
  return parseLocalCommandLine(evt)?.name ?? null;
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

/**
 * Extract the raw `<task-notification>…</task-notification>` XML payload from
 * `evt`, or `null` when `evt` isn't one of the two shapes claude uses to
 * report a background command/agent's completion. Mirrors the detection in
 * `mapParsedEventToChunks`'s `user` and `queue-operation` cases exactly, so
 * the settle signal (`fireBackgroundTaskSettled`) and the status breadcrumb
 * the user sees always agree on what counts as a notification. A third shape
 * (`type: "attachment"`, `attachment.commandMode: "task-notification"`) has
 * been observed carrying the same payload as a `queue-operation`/`user`
 * companion line for the same event — deliberately not handled here since
 * the other two already fire the settle signal for it and a duplicate would
 * just be a harmless extra (idempotent) call.
 */
function taskNotificationContent(evt: ParsedJsonlEvent): string | null {
  if (evt.type === "user" && evt.origin?.kind === "task-notification") {
    const content = evt.message?.content;
    return typeof content === "string" ? content : null;
  }
  if (evt.type === "queue-operation" && evt.operation === "enqueue" && typeof evt.content === "string") {
    return evt.content;
  }
  return null;
}

/**
 * Pull the `<task-id>` out of a task-notification payload. This id is
 * identical to the finishing subagent's on-disk id — claude-subagents.ts
 * tails `<sessionId>/subagents/agent-<agentId>.jsonl`, and empirically (see
 * real transcripts under `~/.claude/projects/`) `<task-id>` in the
 * notification and `<agentId>` in that filename are the same token for a
 * background AGENT (Task-tool) completion. For a background *shell command*
 * notification there's no matching subagent row; for a Monitor the id names
 * a task that's still alive — a Monitor reuses this exact tag on every
 * ordinary event, not just its terminal one, so naming the id is no longer
 * proof of completion by itself. `setBackgroundTaskSettledHandler`'s callee
 * (`claude-subagents.ts`'s `handleBackgroundTaskNotification`) is expected
 * to no-op on an id it doesn't recognise, and to consult the raw body (the
 * hook's third argument) to tell a Monitor's event apart from its terminal
 * receipt. Returns `null` when no `<task-id>` tag is present so callers
 * degrade gracefully.
 */
function extractTaskNotificationAgentId(content: string): string | null {
  const m = /<task-id>([^<]+)<\/task-id>/.exec(content);
  return m ? m[1]!.trim() : null;
}

/**
 * Deterministic stand-in uuid for a JSONL line that carries `uuid: null` —
 * today this is only `queue-operation` notification lines (claude 2.1.x's
 * PRIMARY shape for reporting a background command/agent's completion; see
 * `taskNotificationContent`'s doc comment). A falsy real uuid never satisfies
 * `dispatchLine`'s `uuid && state.seenLineUuids.has(uuid)` replay guard (nor
 * `maybeAdoptContinuation`'s copy of it), so without a synthetic key a
 * reattach replay (boot re-reads the JSONL from offset 0) looks exactly like
 * a brand-new line: `maybeAdoptContinuation` re-adopts a phantom continuation
 * run, and the status breadcrumb double-persists into `run_events` (its
 * `uuid: undefined` third `onChunk` arg defeats both the in-memory dedup and
 * the DB's `(run_id, line_uuid)` partial unique index).
 *
 * Hashing `content` (the notification's own XML payload, which is stable
 * across re-reads of the same physical line) gives every caller — the
 * seenLineUuids dedup check, `maybeAdoptContinuation`'s replay guard, and the
 * breadcrumb chunk's persisted `line_uuid` — the identical key for the
 * identical line, including across process restarts. MUST stay a pure
 * function of `content` — no `Date.now()`/`Math.random()` — or reattach's
 * offset-0 replay would mint a different key than the first pass and the
 * whole point of this helper falls apart.
 *
 * Hand-rolled FNV-1a (32-bit) rather than `Bun.hash` — FNV-1a's algorithm is
 * a tiny, permanently-fixed public spec, so a synthetic uuid computed by one
 * agetor version matches one computed by the next; `Bun.hash`'s algorithm
 * carries no such stability guarantee across Bun releases. Prefixed for
 * greppability in `run_events.line_uuid`.
 */
function syntheticNotificationUuid(content: string): string {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV-1a 32-bit prime
  }
  return `qnotif:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * True when `evt`, once mapped, would emit genuine conversational content —
 * a `user` / `assistant` / `thinking` / `tool_use` / `tool_result` chunk —
 * rather than a bare status/heartbeat breadcrumb. One of two adoption
 * triggers `maybeAdoptContinuation` checks (the other is
 * `taskNotificationContent`, handled separately since a task-notification is
 * itself eligible to adopt — just with a watchdog attached, since it's only
 * proof claude noticed the background work, not proof it will keep
 * talking). A plain status-only line that is NEITHER of those two shapes (a
 * mode banner, a turn-duration footer, an unrelated `isMeta` breadcrumb)
 * must NOT open a new run on its own.
 *
 * **Local-command twins are never continuation content** (smoke evidence,
 * claude 2.1.246): flipping the effort dropdown on an IDLE task makes the
 * orchestrator mirror `/effort max` through `sendSlashCommand`, which pushes
 * NO turn slot — so claude's two JSONL twins for it (`<command-name>/effort…`
 * and `<local-command-stdout>…`) arrive on a session with an empty
 * `turnQueue` and, under the old "any non-meta `user` line is content" rule,
 * were adopted as an `origin: "continuation"` run. Nothing can ever settle
 * such a run: the local-command settle in `dispatchLine` requires a head slot
 * whose OWN prompt named the same command (`TurnSlot.slashCommand`), and the
 * adopted slot's `slashCommand` is `null` by construction. The observed run
 * sat `running` for 6 minutes with claude parked at a bare `❯`.
 *
 * A `/model`/`/effort` twin is claude ANSWERING a local command, not claude
 * continuing work — so both shapes are excluded here and route instead to
 * `state.lastChunk` (the previous run's handler), where they render as the
 * command / command-output bubbles `lib/command-message.ts` already knows how
 * to draw. The `isMeta` `<local-command-caveat>` breadcrumb is already
 * excluded by the `isMeta` check just above.
 */
function isContinuationContentEvent(evt: ParsedJsonlEvent): boolean {
  if (evt.type === "assistant") return true;
  if (evt.type === "user") {
    // Same filter mapParsedEventToChunks applies before emitting a `user`
    // chunk — synthetic entries claude injects itself never count as new
    // content on their own.
    if (evt.origin?.kind === "task-notification") return false;
    if (evt.isMeta === true) return false;
    // The two local-command twins — see this function's doc.
    if (parseLocalCommandLine(evt) !== null) return false;
    if (isLocalCommandStdoutEvent(evt)) return false;
    return true;
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

/**
 * @param includeUuidForApiError See `mapParsedEventToChunks`'s param of the
 * same name. Defaults `false` (unchanged behavior for every existing
 * caller/test that doesn't pass it). `claude-subagents.ts`'s tailer — the
 * ONLY external caller of this raw-line entry point (`dispatchLine`, the
 * main stream, parses up front and calls `mapParsedEventToChunks` directly)
 * — passes `true`.
 * @param lastPermissionMode See `mapParsedEventToChunks`'s param of the same
 * name. Threaded straight through so the subagent tailer gets the same
 * emit-on-change suppression as the main stream.
 */
export function mapJsonlEventToChunks(
  line: string,
  onChunk: ChunkHandler,
  includeUuidForApiError = false,
  lastPermissionMode?: string | null,
): { endOfTurn: boolean; lineUuid?: string } {
  let evt: ParsedJsonlEvent;
  try {
    evt = JSON.parse(line);
  } catch (e) {
    onChunk("stderr", `jsonl parse error: ${(e as Error).message}`);
    return { endOfTurn: false };
  }
  return mapParsedEventToChunks(evt, onChunk, includeUuidForApiError, lastPermissionMode);
}

/** String-variant entry point delegates to this once the JSON has been
 *  parsed. `dispatchLine` parses up front (to peek the uuid for dedup) and
 *  calls this directly — saves a second JSON.parse per JSONL line.
 *
 * @param includeUuidForApiError Whether the `isApiErrorMessage` sentinel
 * `status` chunk should carry the line's own uuid as its `line_uuid` dedup
 * key. `dispatchLine`'s direct call (main stream) never passes this, so it
 * defaults `false`: a main-stream api-error line's assistant TEXT block is
 * emitted first with that SAME uuid, so reusing it here would collide on
 * the `(run_id, IFNULL(subagent_id,''), line_uuid)` partial unique index
 * and the status row would be silently dropped via INSERT OR IGNORE (see
 * the dedicated test in claude-tmux.test.ts). `mapJsonlEventToChunks`
 * passes `true` for its one real caller, the subagent tailer: a subagent's
 * own api-error line needs a durable `line_uuid` so reattach seeding
 * (`seenLineUuidsForSubagent`) reliably recognizes a replayed api-error
 * line even in the edge case where the line carries no text content block
 * (so no assistant chunk exists to carry the uuid instead) — without that,
 * a replayed error line on a boot reattach could re-fire
 * `signalSubagentApiError` against whatever run happens to be in flight at
 * that point. When a text block IS present (the common case), the
 * duplicate write is a harmless no-op — INSERT OR IGNORE silently keeps
 * the first (assistant) row, which already carries the same uuid.
 * @param lastPermissionMode The mode `SessionState.permissionMode` held
 * BEFORE this event (undefined = caller has no tracking — e.g. a test that
 * predates this param, or a one-off call site that doesn't care — always
 * emit, matching pre-existing behavior). Claude journals a mode-bearing
 * event at every turn start, not just on an actual mode change, so without
 * this the `system`/`permission-mode` case below would emit an identical
 * `permission-mode: <mode>` status chip after every single turn. Passing
 * the previous value lets that case suppress the chunk when nothing
 * actually changed.
 */
function mapParsedEventToChunks(
  evt: ParsedJsonlEvent,
  onChunk: ChunkHandler,
  includeUuidForApiError = false,
  lastPermissionMode?: string | null,
): { endOfTurn: boolean; lineUuid?: string } {
  // Claude stamps a uuid on every event line. Forward it as the third arg
  // to onChunk so the orchestrator can persist it as the run_events row's
  // dedup key — that's what makes a re-read of the JSONL on reattach (after
  // agetor restarts and finds the tmux session still alive) idempotent.
  const uuid = typeof evt.uuid === "string" ? evt.uuid : undefined;

  switch (evt.type) {
    case "user": {
      // Fallback mode-change signal: every `user` line also carries a
      // top-level `permissionMode` (not just the dedicated `system`/
      // `permission-mode` marker lines above) — this catches a mode change
      // for a caller that only sees `user` lines, or as a backstop if a
      // marker line is ever missed. Same emit-on-change dedup via
      // `lastPermissionMode`, so a marker line and a `user` line reporting
      // the same value in the same turn don't double-emit.
      //
      // Uses a DERIVED uuid, not the raw line `uuid`, as the dedup key: this
      // same line almost always ALSO emits a `user`/`tool_result`/status
      // chunk below with the raw uuid, and reusing it here would collide on
      // the `(run_id, IFNULL(subagent_id,''), line_uuid)` partial unique
      // index — the second insert would be silently dropped via INSERT OR
      // IGNORE (the exact hazard `includeUuidForApiError`'s doc above
      // explains for the api-error case). A stable per-line derivation keeps
      // reattach's offset-0 replay from re-emitting the same chip twice.
      if (evt.permissionMode && evt.permissionMode !== lastPermissionMode) {
        onChunk(
          "status",
          `${PERMISSION_MODE_STATUS_PREFIX}${evt.permissionMode}`,
          uuid ? `${uuid}:permission-mode` : undefined,
        );
      }
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
        // Image attachment marker: claude injects a dedicated isMeta entry
        // whose sole content is `[Image: source: <path>]`, twinning the
        // thumbnail chip already rendered on the user's own message bubble.
        // Surfacing it as a status breadcrumb too would just be a redundant
        // uppercase caption, so suppress it entirely — same silent-drop
        // treatment as a truly-empty synthetic entry below.
        if (imageSourceMetaPath(text) !== null) {
          return { endOfTurn: false, lineUuid: uuid };
        }
        // Local-command caveat: claude injects this isMeta entry right
        // before running a `/model`/`/effort`/… local command —
        // `<local-command-caveat>Caveat: The messages below were generated
        // by the user while running local commands. DO NOT respond to
        // these messages…</local-command-caveat>`. It's claude's note to
        // itself, not user-relevant — silence it entirely, same treatment
        // as the image marker just above, rather than stripping the tag and
        // surfacing the caveat prose as a status breadcrumb.
        if (text.trimStart().startsWith("<local-command-caveat>")) {
          return { endOfTurn: false, lineUuid: uuid };
        }
        // Strip a leading wrapper tag (`<task-notification>`, …) so the
        // breadcrumb reads as prose rather than raw markup.
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
      // Emitted with `uuid: undefined` on the MAIN stream (the default here
      // — see `includeUuidForApiError`'s doc) on purpose: the assistant text
      // block above was just appended to run_events with that SAME uuid (a
      // typical api-error line has both), and the `(run_id,
      // IFNULL(subagent_id,''), line_uuid)` partial unique index would
      // silently drop this status row via INSERT OR IGNORE if we reused it
      // — verified against `claude-tmux.test.ts`'s
      // "synthetic isApiErrorMessage line" test, which asserts exactly this.
      // The NULL key path inserts unconditionally, so the breadcrumb still
      // shows up on panel reload, just under a different (non-deduped) row.
      if (evt.isApiErrorMessage === true) {
        const detail = formatApiErrorDetail(evt.apiErrorStatus);
        onChunk(
          "status",
          `${CLAUDE_API_ERROR_STATUS_PREFIX}${detail}`,
          includeUuidForApiError ? uuid : undefined,
        );
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
      // Claude journals a mode-bearing event at the start of every turn, not
      // just when the mode actually changes — emit the chip only when it
      // differs from what the caller already knows, so identical
      // "permission-mode: auto" chips don't spam the stream after every turn.
      if (evt.permissionMode && evt.permissionMode !== lastPermissionMode) {
        onChunk("status", `${PERMISSION_MODE_STATUS_PREFIX}${evt.permissionMode}`, uuid);
      }
      // Local-command twin: the FIRST local command run in a fresh session
      // arrives as `type:"system", subtype:"local_command"` with a FLAT
      // top-level `content` (no `message` wrapper) — every later command in
      // the same session uses the `user`-shaped envelope the `case "user"`
      // branch above already renders. Render this flat variant as a `user`
      // chunk too (CR-normalised like the human-turn path — tmux can leak
      // `\r`-only line endings into these lines the same way it does for
      // real prompts) so the webview's command-message parser produces the
      // identical command/command-output bubbles regardless of which shape
      // claude happened to use. See `isLocalCommandStdoutEvent` for the
      // matching settle-detection half of this.
      if (evt.type === "system" && evt.subtype === "local_command"
        && typeof evt.content === "string" && evt.content.length > 0) {
        onChunk("user", evt.content.replace(/\r\n?/g, "\n"), uuid);
      }
      // Independent `if` (not `else if`): a mode-bearing event and a
      // turn-duration event are conceptually unrelated fields on the same
      // envelope. Coupling them would mean a future claude build that
      // stamps `permissionMode` onto a `subtype:"turn_duration"` line
      // silently swaps the mode-change chip for the duration chip instead
      // of emitting both.
      if (evt.subtype === "turn_duration" && typeof evt.durationMs === "number") {
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
      // carry `uuid: null` by design — reattach re-reads the JSONL from
      // offset 0, so a real uuid-less broadcast WOULD be re-dispatched on
      // restart. Stand in a deterministic hash of the content
      // (`syntheticNotificationUuid`) so the breadcrumb's persisted
      // `line_uuid` still dedups a replay, mirroring the same substitution
      // `dispatchLine` makes for `seenLineUuids`/`maybeAdoptContinuation`.
      if (evt.operation === "enqueue" && typeof evt.content === "string") {
        const notifUuid = uuid ?? syntheticNotificationUuid(evt.content);
        const summary = /<summary>([\s\S]*?)<\/summary>/.exec(evt.content)?.[1]?.trim();
        // Mirror the existing user/origin.kind handler's fallback: when a
        // task-notification payload arrives without a `<summary>` (older
        // claude builds, malformed content, future variants), emit a
        // generic "completed" breadcrumb rather than dropping the event
        // silently — something measurable happened, and the run panel
        // shouldn't go dark on it.
        if (summary) {
          onChunk("status", `background task: ${summary}`, notifUuid);
        } else if (evt.content.startsWith("<task-notification>")) {
          onChunk("status", "background task completed", notifUuid);
        }
        return { endOfTurn: false, lineUuid: notifUuid };
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

/** Run a one-shot tmux command. Never throws — callers check `ok`. Always
 *  threads `tmuxSocketArgs()` in right after the binary — see
 *  `tmuxSocketName()` in tmux-resolution.ts for why every invocation (this is
 *  the single choke point all of them share) must carry the socket args.
 *
 *  Async (`Bun.spawn` + `await proc.exited`) so a tmux round-trip never
 *  blocks the event loop that also serves the HTTP API — this used to be
 *  `Bun.spawnSync`, which stalled every concurrent request for the duration
 *  of the fork+exec (see docs/plans/fix-task-details-load-delay.md). No
 *  timeout: a wedged tmux client now hangs only the awaiting op, not the
 *  whole process, and adding one was explicitly declined for this change. */
async function tmux(args: string[], opts: { stdinText?: string } = {}): Promise<RunResult> {
  try {
    const proc = Bun.spawn([resolveTmuxBin(), ...tmuxSocketArgs(), ...args], {
      stdin: opts.stdinText !== undefined
        ? new TextEncoder().encode(opts.stdinText)
        : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return {
      ok: exitCode === 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (e) {
    return { ok: false, stdout: "", stderr: (e as Error).message };
  }
}

/** True when `tmux has-session -t =<name>` returns 0. The `=` prefix forces
 *  an exact match — without it, a probe for an absent name PREFIX-MATCHES
 *  and can report a live, unrelated session as "exists" (empirically proven
 *  on this task's sibling `agetor-<id>` names). */
export async function sessionExists(taskId: string): Promise<boolean> {
  return (await tmux(["has-session", "-t", "=" + sessionNameFor(taskId)])).ok;
}

/**
 * True when we hold in-memory `SessionState` driving this task's session.
 * Distinct from `sessionExists` (a tmux check): since boot reconciliation no
 * longer sweeps idle sessions, a tmux session can outlive our process — so
 * `sessionExists` can be true with no `SessionState` to paste into. The
 * follow-up router (`sendClaudeTurn`) gates the paste path on BOTH.
 */
export function hasSessionState(taskId: string): boolean {
  return sessions.has(taskId);
}

/**
 * Idle metadata for the reaper (T4, orchestrator.ts imports this by exact
 * name/signature). Returns `null` when we hold no in-memory `SessionState`
 * for the task — the reaper falls back to `task.updatedAt` in that case (a
 * post-restart done/review task has no live driver state to ask). Otherwise
 * returns how long it's been since the session last showed life — see the
 * `lastActivityAt` field doc on `SessionState` for the full list of triggers.
 */
export function sessionIdleInfo(taskId: string): { idleMs: number } | null {
  const state = sessions.get(taskId);
  if (!state) return null;
  return { idleMs: Date.now() - state.lastActivityAt };
}

/**
 * The reasoning-effort id the LIVE claude process for `taskId` was launched
 * with — the `CLAUDE_CODE_EFFORT_LEVEL` its spawn env carried (see
 * `SessionState.launchEffort`). `null` when there is no live session, when the
 * session was reattached rather than spawned by this process (no launch env to
 * read), or when the launch carried no effort at all.
 *
 * The orchestrator's breadcrumb needs this to say something honest when
 * `task.effort` and the live session disagree: the env var is fixed for the
 * lifetime of the process, so a task row that has since been changed —
 * whether from the dropdown or synced back from claude's own `/effort` — is
 * describing the NEXT spawn, not the one currently running ("this session is
 * pinned to <launchEffort> by CLAUDE_CODE_EFFORT_LEVEL").
 *
 * Deliberately reports the LAUNCH value, never the live one. Claude's
 * in-session `/effort` does change what claude actually uses, but it cannot
 * change the env var, and it is precisely that split the breadcrumb exists to
 * explain — so this must not be updated when a `/effort` outcome syncs.
 */
export function getSessionLaunchEffort(taskId: string): string | null {
  return sessions.get(taskId)?.launchEffort ?? null;
}

/** Name-keyed variant for callers that hold a persisted session name (e.g.
 *  `runs.tmux_session`) and don't want to recompute it from a task id.
 *  Exact-match `=` prefix — see `sessionExists`. */
export async function sessionExistsByName(name: string): Promise<boolean> {
  return (await tmux(["has-session", "-t", "=" + name])).ok;
}

/**
 * Pure parser for one `#{session_attached}:#{session_activity}` line as
 * produced by `probeSessionActivity`'s `list-sessions -F` call. Exported so
 * the tmux-version quirk below is unit-testable without a real tmux binary.
 *
 * Both fields must be non-empty, all-digit strings BEFORE we hand them to
 * `Number()` — `Number("")` is `0`, which is a finite number, so a naive
 * `Number.isFinite` guard silently accepts an empty field as "zero" instead
 * of rejecting it as malformed. That footgun is exactly what let a tmux 3.6a
 * quirk (see `probeSessionActivity`'s doc comment) turn "session not found"
 * into "activity at epoch 0" instead of `null`.
 */
export function parseSessionActivityLine(line: string): { attached: boolean; activityAt: number } | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  const parts = trimmed.split(":");
  if (parts.length !== 2) return null;
  const attachedRaw = parts[0] ?? "";
  const activityRaw = parts[1] ?? "";
  const digitsOnly = /^[0-9]+$/;
  if (!digitsOnly.test(attachedRaw) || !digitsOnly.test(activityRaw)) return null;
  const attachedNum = Number(attachedRaw);
  const activitySec = Number(activityRaw);
  // tmux reports session_activity in epoch SECONDS; callers (idle-clock math
  // against `Date.now()`) expect milliseconds.
  return { attached: attachedNum > 0, activityAt: activitySec * 1000 };
}

/**
 * Keyed, single-round-trip liveness + activity probe for a task's tmux
 * session, with no dependency on in-memory `SessionState`. This is what the
 * reaper falls back to for a task it holds no `SessionState` for (e.g. after
 * a restart, before boot reconciliation reattaches it) instead of a bare
 * `has-session` check that can't tell whether the session is still doing
 * anything. Pulls both `#{session_attached}` (nonzero while a real `tmux
 * attach` is live) and `#{session_activity}` (tmux's own last-activity
 * timestamp for the session — updated on any pane output, independent of
 * whether we're the ones tailing it) in a single round-trip, with no
 * dependency on `SessionState`.
 *
 * Uses `list-sessions -F '#{session_attached}:#{session_activity}' -f
 * '#{==:#{session_name},<name>}'` rather than `display-message -p -t
 * '=<name>'`. We used to use `display-message`, but on tmux 3.6a it does NOT
 * resolve an `=`-prefixed exact-match TARGET the way `has-session` and
 * `kill-session` do: instead of failing for a nonexistent session, it prints
 * the requested format with every variable expanded to empty (stdout `:`)
 * and exits 0 — identically for a live session and a dead one. Parsed the
 * old way (`Number("") === 0` sailing through `Number.isFinite`), that
 * turned into `{attached: false, activityAt: 0}` for EVERY task, live or
 * dead — "idle since epoch 1970" — which made the idle-session reaper
 * re-reap every candidate task on every sweep. `list-sessions -f
 * '#{==:...}'` uses a session FILTER, not a resolved target, so it isn't
 * subject to that `=`-target quirk: verified on tmux 3.6a to return e.g.
 * `0:1785511908` for a live session and empty stdout (exit 0, server up)
 * for a dead one.
 *
 * `-f '#{==:#{session_name},<name>}'` is an exact-match filter, matching the
 * `-t '=<name>'` exact-match target used by every other tmux() call in this
 * file — see `sessionExists`'s comment for why an unanchored name
 * prefix-matches a sibling `agetor-<id>` session and would misreport a live,
 * unrelated session as this task's. Since the name is unique, the filter
 * should never yield more than one line; if it somehow does, we treat that
 * as ambiguous and return null rather than guess which line is "ours."
 *
 * Returns null when the command fails (no tmux server), stdout is empty or
 * whitespace-only (session doesn't exist), or the output doesn't parse —
 * the caller treats that as "can't tell," not "definitely dead."
 */
let probeFailureWarned = false;
export async function probeSessionActivity(taskId: string): Promise<{ attached: boolean; activityAt: number } | null> {
  const r = await tmux([
    "list-sessions", "-F", "#{session_attached}:#{session_activity}",
    "-f", "#{==:#{session_name}," + sessionNameFor(taskId) + "}",
  ]);
  if (!r.ok) {
    // A missing server is the routine failure (nothing running → nothing to
    // probe) — stay silent for that. Anything else gets one warn per
    // process: `-f` + the `#{==:}` comparison are a newer tmux surface than
    // the has-session/kill-session calls elsewhere in this file, and a tmux
    // build that rejects them would otherwise silently disable reaping for
    // every session with no in-memory SessionState — the same *class* of
    // invisible misread the display-message quirk this function replaced.
    if (!probeFailureWarned && !/no server running|error connecting/i.test(r.stderr)) {
      probeFailureWarned = true;
      console.warn(`[agetor] probeSessionActivity: tmux list-sessions failed: ${r.stderr.trim()}`);
    }
    return null;
  }
  const trimmed = r.stdout.trim();
  if (trimmed === "") return null;
  const lines = trimmed.split("\n");
  if (lines.length !== 1) return null;
  return parseSessionActivityLine(lines[0] ?? "");
}

/** Tri-state liveness of a tmux session — the safe signal for the death watch. */
export type SessionLiveness = "alive" | "gone" | "unreachable";

/**
 * Classify a tmux session's liveness from a single `has-session` probe,
 * distinguishing the two states a bare `.ok` boolean fatally conflates:
 *
 *   - `alive`       — the session answered; it's up.
 *   - `gone`        — an UNAMBIGUOUS death: the server answered but this session
 *                     is absent ("session not found"), or the whole server is
 *                     down ("no server running" / "lost server"). While a turn
 *                     is in flight our own session keeps the shared server
 *                     alive, so a no-server report means our session died too;
 *                     these strings are never emitted spuriously.
 *   - `unreachable` — anything else: a busy-server EAGAIN ("resource temporarily
 *                     unavailable"), an ambiguous bare "error connecting …", an
 *                     empty message, or an unrecognized error. INCONCLUSIVE —
 *                     must never be treated as a death.
 *
 * The death watch used to fire on any non-zero `has-session` exit after two
 * ~400ms misses, which abandoned live, working sessions whenever the shared
 * tmux server hiccuped under load (a heavy git op flooding a pane, many
 * concurrent agetor sessions). We don't have the incident's exact transient
 * string, so the bias is deliberately conservative: ONLY known-unambiguous
 * death strings are `gone`; every ambiguous or unrecognized error is
 * `unreachable` and cannot trip a death. That guarantees a transient probe
 * failure never abandons a live session (the original bug), while still
 * detecting a genuinely-dead session or server the moment tmux says so (instead
 * of waiting for boot `reconcileOrphans`).
 */
export async function sessionLiveness(name: string): Promise<SessionLiveness> {
  // Exact-match `=` prefix — see `sessionExists`. tmux's error string becomes
  // e.g. "can't find session: =x", which still contains "find session" below,
  // so the classification is unaffected by the prefix.
  const r = await tmux(["has-session", "-t", "=" + name]);
  if (r.ok) return "alive";
  const err = `${r.stderr} ${r.stdout}`.toLowerCase();
  // Only UNAMBIGUOUS death strings count as `gone`:
  //  - server answered, this session absent: "can't find session" /
  //    "session not found" / "no such session".
  //  - server itself dead: "no server running" / "lost server". During an
  //    in-flight turn our own session keeps the shared server alive, so a server
  //    reporting no-server has died and taken our session with it. These strings
  //    are never emitted spuriously — a busy-but-alive server still accepts the
  //    connection, so it can't say "no server running".
  if (
    err.includes("find session") ||
    err.includes("session not found") ||
    err.includes("no such session") ||
    err.includes("no server running") ||
    err.includes("lost server")
  ) {
    return "gone";
  }
  // Everything else is INCONCLUSIVE → `unreachable`, never a death: a busy-server
  // EAGAIN ("resource temporarily unavailable"), a bare "error connecting …"
  // (ambiguous — transient EAGAIN vs. a vanished socket), an empty message from
  // a torn-down client, or any error string we don't recognize. Biasing the
  // unknown case to `unreachable` is what guarantees a transient probe failure
  // can never abandon a live session — the original bug, whose exact transient
  // string we can't assume. A genuinely-dead session/server that only ever
  // emits an unrecognized error degrades to boot `reconcileOrphans`.
  return "unreachable";
}

/**
 * The pid of the process running in `name`'s (first) pane — for a claude
 * session that is the `claude` REPL itself (tmux execs the launch argv
 * directly, no shell in between); for the one-shot codex/cursor/gemini
 * sessions it's the `sh -c 'exec …'` pane whose `exec` replaced it with the
 * agent binary (same pid). `null` when the session has no pane, the server
 * is unreachable, or the answer doesn't parse as a pid.
 *
 * Read via `list-panes -a` + an exact `session_name` match in JS rather than
 * `display-message -p -t =<name>`: tmux 3.6a silently expands every format
 * variable to EMPTY (exit 0) for `=`-prefixed targets on that command, so a
 * target-addressed read can't be trusted, whereas a listing filtered
 * client-side can. Only the first pane of the session is considered — agetor
 * creates exactly one, and a user who splits the window from a manual
 * `tmux attach` leaves the original agent pane at index 0, listed first.
 *
 * This is the one-off cost that lets the death watch check liveness with a
 * `kill(pid, 0)` syscall per tick instead of forking a tmux client — see
 * `createDeathProbe` in session-liveness.ts.
 */
export async function panePidFor(name: string): Promise<number | null> {
  const r = await tmux(["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"]);
  if (!r.ok) return null;
  for (const line of r.stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0 || line.slice(0, tab) !== name) continue;
    const pid = line.slice(tab + 1).trim();
    // Strict all-digit check BEFORE Number(): `Number("")` is 0, which
    // `Number.isFinite` happily accepts (the tmux 3.6a empty-format trap).
    if (!/^[0-9]+$/.test(pid)) return null;
    const n = Number(pid);
    return n > 0 ? n : null;
  }
  return null;
}

/** True when `path` was written within `windowMs` — used as a death-watch veto:
 *  a log file the agent touched a beat ago proves it's alive even if a single
 *  `has-session` probe raced a kill/recreate. Silent (false) on a missing file. */
export function fileWrittenWithin(path: string, windowMs: number): boolean {
  try {
    return Date.now() - fsStatSync(path).mtimeMs < windowMs;
  } catch {
    return false;
  }
}

/** What a single death-watch poll should do given this tick's signals.
 *   - `reset` — the session is alive/unreachable, or its log was just written
 *               (provably alive): zero the miss counter.
 *   - `wait`  — a `gone` probe with a stale log, but not yet enough consecutive
 *               ones: increment and keep watching.
 *   - `fire`  — `threshold` consecutive `gone`+stale probes: declare death. */
export type DeathTickOutcome = "reset" | "wait" | "fire";

/**
 * Pure per-tick decision for the death watch, factored out so the destructive
 * branch is unit-testable without real timers or a live tmux server. `misses`
 * is the run of consecutive death-signalling ticks BEFORE this one.
 *
 * Only a definitive `gone` counts toward death; `alive`/`unreachable` (a busy-
 * server EAGAIN) and a freshly-written log both reset — either proves the
 * session isn't actually dead, so a transient probe failure can never abandon a
 * live session.
 */
export function deathTickOutcome(
  args: { liveness: SessionLiveness; logFresh: boolean; misses: number; threshold: number },
): DeathTickOutcome {
  if (args.liveness !== "gone") return "reset";
  if (args.logFresh) return "reset";
  return args.misses + 1 < args.threshold ? "wait" : "fire";
}

/** Kill any tmux session for the given task. Idempotent / silent on miss.
 *  Exact-match `=` prefix — see `sessionExists`; without it a kill for an
 *  absent exact name can prefix-match and kill an unrelated live session. */
export async function killTaskSession(taskId: string): Promise<void> {
  await tmux(["kill-session", "-t", "=" + sessionNameFor(taskId)]);
}

/** Kill an arbitrary session name. Used by reconcileOrphans. Exact-match `=`
 *  prefix — see `sessionExists`. */
export async function killSessionByName(name: string): Promise<void> {
  await tmux(["kill-session", "-t", "=" + name]);
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
 * `ctx.confirmKey`: on the arrow-nav path, the trailing keystroke is
 * `ctx.confirmKey ?? "Enter"` instead of a hardcoded Enter. This exists for
 * claude 2.1.245's bare `/model` picker, whose footer reads `Enter to set as
 * default · s to use this session only · Esc to cancel` — plain Enter there
 * writes the pick as the user's *global* default for all future claude
 * sessions, a side effect a card click through agetor must never cause on
 * the user's behalf. `matchNumberedModal` sets `confirmKey: "s"` whenever
 * that footer text is present (see `SESSION_ONLY_CONFIRM_RE`), which scopes
 * the change to the live session instead; `task.model` still syncs from
 * claude's own `<local-command-stdout>` line regardless of which key
 * confirmed the picker. The y/N path never carries a `confirmKey` (that
 * shape has no arrow nav or footer to match) and is unaffected.
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
 * (default 700ms) before the first keystroke goes out. A click queued
 * behind a paste that's polling `queuePaste`'s modal guard
 * (docs/plans/model-effort-local-command-turns.md §10) waits out that
 * guard too — up to `PASTE_MODAL_GRACE_MS` (default 1500ms) — before
 * either the guarded paste lands or is withheld and this click's op
 * becomes current. The server route at `server.ts:1420` awaits this
 * Promise, so the modal-click HTTP response inherits the wait.
 */
export async function dismissTmuxPrompt(
  taskId: string,
  key: string,
  ctx: {
    choices: TmuxPromptChoice[];
    cursorIndex?: number;
    /**
     * Which arrow pair drives the cursor — `"vertical"` (Down/Up, the
     * default when omitted) for a numbered/yes-no modal, `"horizontal"`
     * (Right/Left) for a slider-style widget — claude 2.1.245's bare
     * `/effort` slider, which reads "←/→ to adjust · Enter to confirm"
     * (`matchSliderModal`, registered with `nav: "horizontal"`). Every other
     * matcher today registers a vertical-nav (or nav-less y/N) prompt.
     */
    nav?: "vertical" | "horizontal";
    /**
     * Key that confirms the highlighted choice on the arrow-nav path,
     * in place of Enter — see the function doc above and
     * `ScrapeMatch.confirmKey`. `undefined` ⇒ Enter (every modal but the
     * bare `/model` picker today). Never consulted on the y/N literal-
     * keystroke path.
     */
    confirmKey?: string;
  },
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
  // `ctx.nav === "horizontal"` is the slider's own cursor axis — claude's
  // Ink slider only responds to Left/Right, not Up/Down. Every other
  // matcher leaves `nav` undefined/"vertical" and keeps the original
  // Down/Up pair.
  const arrow = ctx.nav === "horizontal" ? (delta >= 0 ? "Right" : "Left") : (delta >= 0 ? "Down" : "Up");
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
      if (!(await walkCursor(state, arrow, stepCount, stillCurrent))) return;
    } else {
      // y/n style: send the literal keystroke.
      bumpKeystroke(state);
      if (!(await tmux(["send-keys", "-t", state.sessionName, key])).ok) return;
      await Bun.sleep(50);
      if (!stillCurrent()) return;
    }
    // Explicit re-gate before the trailing confirm keystroke — symmetric
    // with the per-arrow check inside the loop and the y/n path above.
    // Future edits that insert an `await` between the loop end and this
    // keystroke would otherwise reopen the dispose-during-gap race.
    if (!stillCurrent()) return;
    // Arrow-nav path only: `ctx.confirmKey` (e.g. "s" for the bare /model
    // picker's "use this session only") stands in for Enter so a card click
    // through agetor can't mutate the user's global claude config — see the
    // function doc above. The y/n path above already sent its own literal
    // keystroke and always confirms with a plain Enter here.
    const finalKey = useArrowNav ? (ctx.confirmKey ?? "Enter") : "Enter";
    bumpKeystroke(state);
    ok = (await tmux(["send-keys", "-t", state.sessionName, finalKey])).ok;
  }, state);
  return ok;
}

/**
 * Walk claude's modal cursor `steps` positions in the `arrow` direction, one
 * `send-keys` per press. Factored out of `dismissTmuxPrompt` (its original
 * home) so `mirrorModelViaPicker` drives the `/model` picker's cursor through
 * the exact same choreography rather than a second hand-rolled copy of it.
 *
 * MUST be called from inside a `queueTmuxOp` body — it takes that op's own
 * `stillCurrent` predicate and re-checks it after every gap, so a
 * `dropSession` landing mid-navigation aborts instead of leaking the
 * remaining arrows (and, worse, the caller's trailing confirm key) into a
 * respawned pane.
 *
 * The 30 ms inter-press gap is defensive splitting: bursting two arrow events
 * as a single read into Ink's stdin has been observed (rarely) to coalesce
 * into one cursor advance. It also gives the `stillCurrent()` re-gate
 * something to fire between.
 *
 * Returns false when a `send-keys` failed or the session stopped being
 * current — in both cases the caller must NOT send its confirm keystroke,
 * since the cursor is not where it thinks it is. `steps === 0` is a no-op
 * that returns true (the cursor already sits on the target).
 */
async function walkCursor(
  state: SessionState,
  arrow: string,
  steps: number,
  stillCurrent: () => boolean,
): Promise<boolean> {
  for (let i = 0; i < steps; i++) {
    bumpKeystroke(state);
    if (!(await tmux(["send-keys", "-t", state.sessionName, arrow])).ok) return false;
    await Bun.sleep(30);
    if (!stillCurrent()) return false;
  }
  return true;
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
      bumpKeystroke(state);
      if (!(await tmux(["send-keys", "-t", state.sessionName, key])).ok) return;
      // Inter-key gap mirrors dismissTmuxPrompt: a bursted pair can read as a
      // single Ink event, and the gap lets the dispose re-gate fire.
      await Bun.sleep(35);
      if (!stillCurrent()) return;
    }
    ok = true;
  }, state);
  return ok;
}

/**
 * Gap between the review-screen tab transition and the first poll for the
 * "Ready to submit your answers?" screen to render. This is Ink's heaviest
 * repaint on the whole AskUserQuestion modal — the full review summary,
 * every question + answer — and the flat 35ms `sendModalKeys` gap that
 * suffices for every other keystroke was intermittently too short for it:
 * the confirm Enter would arrive mid-repaint and get swallowed, producing a
 * false `ok:true` with the modal still stranded on the pane. 80ms per poll,
 * up to `ASK_REVIEW_POLL_ATTEMPTS` (~800ms total), gives the repaint room
 * without blocking the common case, where the screen is usually already up
 * by the first or second poll. Prefer raising over lowering if the race
 * resurfaces — the cost of raising is a few hundred ms of added drive
 * latency; the cost of lowering is a return of the swallowed-Enter bug this
 * whole driver exists to fix.
 */
const ASK_REVIEW_POLL_MS = 80;
/** Poll budget for `ASK_REVIEW_POLL_MS` — bounds how long `driveAskAnswers`
 *  waits for the review screen before giving up on the confirm-gate and
 *  falling through to verification without ever sending a blind Enter. */
const ASK_REVIEW_POLL_ATTEMPTS = 10;

/**
 * Poll gap for the post-confirm verification phase (`detectAskModal` →
 * `null` = the modal actually closed). Looser than the review-wait gap
 * because there's no repaint to catch mid-frame here — this loop is purely
 * confirming the confirm landed, and a lone "review" sighting is the signal
 * to resend, not a race to win. `ASK_VERIFY_POLL_ATTEMPTS` (~1s total at
 * this gap) comfortably covers ordinary repaint + teardown latency; a
 * mis-drive that never resolves times out to `false` rather than hanging
 * the answer route.
 */
const ASK_VERIFY_POLL_MS = 120;
const ASK_VERIFY_POLL_ATTEMPTS = 8;
/** Cap on resending the confirm Enter when verification still sees
 *  "review" — i.e. the earlier send (from the review-wait phase or a prior
 *  resend) was swallowed. A stray extra Enter lands on the empty REPL
 *  prompt once the modal genuinely closes, which is a no-op, so this is
 *  purely a loop-termination bound, not a correctness one. */
const ASK_VERIFY_MAX_RESENDS = 2;

/** Outcome of one poll in `driveAskAnswers`'s confirm/verify phases. */
type AskDriveStep = "done" | "send-enter" | "wait" | "fail";

/**
 * Pure per-poll decision for `driveAskAnswers`, factored out of the
 * tmux-driving loop so the swallowed-confirm retry logic is unit-testable
 * without a live tmux pane (mirrors `decideScrapeTick`'s split). The same
 * decision table drives both of `driveAskAnswers`'s phases:
 *
 *  - waiting for the review screen to render before sending the confirm
 *    (`confirmSent: false`) — a `"review"` sighting fires the confirm
 *    immediately (not bounded by `resends`, since this is the first send,
 *    not a resend); a lingering `"question"` (still navigating the tab bar)
 *    or an already-vanished modal both fall through without a blind Enter;
 *  - verifying the modal actually closed after the confirm (`confirmSent:
 *    true`, or no confirm phase at all for a singleFlat plan) — a
 *    `"review"` sighting here means the just-sent confirm was swallowed by
 *    Ink's repaint and must be resent, bounded by `ASK_VERIFY_MAX_RESENDS`
 *    so a genuinely stuck review screen fails instead of looping forever.
 *    (A singleFlat plan never renders a review screen, so `confirmSent`
 *    stays false there; if one ever appeared anyway, the step would send —
 *    not resend — the confirm, which is the robust choice.)
 *
 * `kind === null` (the modal has left the pane) is `"done"` regardless of
 * phase or resend count — the only success case. `"question"` is always
 * `"wait"`: mid-drive it's normal progress toward the review screen, and
 * during verification it's treated as a teardown transient rather than a
 * fresh mis-drive (a genuine mis-drive times out via the caller's attempt
 * budget, which this function doesn't own).
 */
function decideAskDriveStep(
  kind: AskModalKind | null,
  confirmSent: boolean,
  resends: number,
): AskDriveStep {
  if (kind === null) return "done";
  if (kind === "review") {
    if (!confirmSent) return "send-enter";
    return resends < ASK_VERIFY_MAX_RESENDS ? "send-enter" : "fail";
  }
  return "wait";
}

/**
 * Drive a `planAskAnswers` `mode: "drive"` plan into the task's tmux
 * session, verified-and-retried rather than trusting `send-keys` exit codes.
 *
 * This supersedes the blind trailing Enter `sendModalKeys` used to send for
 * plans that end on the "Ready to submit your answers?" review screen: that
 * Enter arrived a flat 35ms after the tab-transition key while Ink was still
 * repainting the heaviest screen in the whole modal, and was intermittently
 * swallowed. `driveAskAnswers` instead:
 *
 *  1. Sends every key up to (but not including) a review-confirming trailing
 *     Enter exactly like `sendModalKeys` — same 35ms gap, same per-key
 *     `stillCurrent()` re-gate. (`plan.confirmsReview` is false for the
 *     singleFlat shape, which has no review screen and no confirm to gate —
 *     the full key list is sent here and phase 2 below just verifies.)
 *  2. When `confirmsReview`, polls the pane (`ASK_REVIEW_POLL_MS` /
 *     `ASK_REVIEW_POLL_ATTEMPTS`) until the review screen is actually
 *     rendered, then sends the confirm Enter. A mis-drive that never reaches
 *     the review screen within the window is not force-confirmed with a
 *     blind Enter — it falls through to verification, which will time out.
 *  3. Always verifies (including singleFlat): polls
 *     (`ASK_VERIFY_POLL_MS` / `ASK_VERIFY_POLL_ATTEMPTS`) until the modal is
 *     gone, resending the confirm on a `"review"` sighting (bounded by
 *     `ASK_VERIFY_MAX_RESENDS`) and waiting out a `"question"` sighting.
 *
 * The whole sequence runs inside one `queueTmuxOp` callback (same
 * serialization-behind-any-in-flight-paste rationale as `sendModalKeys`), so
 * the confirm-wait and verify polls can't interleave with a racing user
 * paste either. `sendModalKeys` is unchanged and still used for the
 * `Escape` dismissal paths, which have no review screen to wait for.
 */
export async function driveAskAnswers(
  taskId: string,
  plan: { keys: NavKey[]; confirmsReview: boolean },
): Promise<boolean> {
  const state = sessions.get(taskId);
  if (!state) return false;
  const { keys, confirmsReview } = plan;
  if (keys.length === 0) return true;
  // The trailing key IS the confirm Enter when confirmsReview — split it off
  // so it can be gated on the review screen actually rendering (step 2)
  // instead of fired blind after the flat inter-key gap (step 1).
  const body = confirmsReview ? keys.slice(0, -1) : keys;

  let ok = false;
  await queueTmuxOp(taskId, async (stillCurrent) => {
    for (const key of body) {
      bumpKeystroke(state);
      if (!(await tmux(["send-keys", "-t", state.sessionName, key])).ok) return;
      // Inter-key gap mirrors sendModalKeys: a bursted pair can read as a
      // single Ink event, and the gap lets the dispose re-gate fire.
      await Bun.sleep(35);
      if (!stillCurrent()) return;
    }

    let confirmSent = false;
    if (confirmsReview) {
      for (let attempt = 0; attempt < ASK_REVIEW_POLL_ATTEMPTS && !confirmSent; attempt++) {
        await Bun.sleep(ASK_REVIEW_POLL_MS);
        if (!stillCurrent()) return;
        const step = decideAskDriveStep(detectAskModal(await captureTail(state)), confirmSent, 0);
        if (step === "done") { ok = true; return; }
        if (step === "send-enter") {
          bumpKeystroke(state);
          if (!(await tmux(["send-keys", "-t", state.sessionName, "Enter"])).ok) return;
          confirmSent = true;
        }
        // "wait" — review screen not up yet; keep polling. ("fail" cannot
        // occur here — decideAskDriveStep only returns it once confirmSent.)
      }
      // Attempts exhausted without a "review" sighting: don't send a blind
      // Enter (see doc comment). Fall through to verification below, which
      // times out to false if the modal genuinely never resolves.
    }

    let resends = 0;
    for (let attempt = 0; attempt < ASK_VERIFY_POLL_ATTEMPTS; attempt++) {
      await Bun.sleep(ASK_VERIFY_POLL_MS);
      if (!stillCurrent()) return;
      const step = decideAskDriveStep(detectAskModal(await captureTail(state)), confirmSent, resends);
      if (step === "done") { ok = true; return; }
      if (step === "fail") return;
      if (step === "send-enter") {
        bumpKeystroke(state);
        if (!(await tmux(["send-keys", "-t", state.sessionName, "Enter"])).ok) return;
        confirmSent = true;
        resends++;
      }
      // "wait" — keep polling; a persistent "question" sighting times out
      // here rather than being force-resolved.
    }
    // Verify budget exhausted without ever seeing the modal close.
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
   *  streams. Without this, after the first event we'd never see the rest.
   *  Self-rescheduling `setTimeout` (see `armPollTimer`) rather than a fixed
   *  `setInterval` — the cadence backs off from `POLL_FAST_MS` to
   *  `POLL_SLOW_MS` once `lastActivityAt` has been quiet for
   *  `POLL_IDLE_AFTER_MS`, and snaps back on the next activity. */
  pollTimer: ReturnType<typeof setTimeout> | null;
  /** `Date.now()` stamp of the last time this session "showed life": JSONL
   *  bytes appended (`flush`), a scraped tmux pane change (`scrapeOnce`), a
   *  turn starting (`sendTurn` / the deferred-prompt paste in
   *  `spawnClaudeViaTmux`), a turn settling (`popEndOfTurn`), or a folded-in
   *  follow-up paste (`pasteFollowUp`). Initialized to the construction time
   *  in `makeSessionState`, so a freshly spawned or reattached session starts
   *  its idle clock at "now" rather than epoch 0. Two consumers: the exported
   *  `sessionIdleInfo` (the reaper's idle signal, T4/orchestrator.ts) and the
   *  `pollTimer`'s own self-throttle just above. */
  lastActivityAt: number;
  /**
   * `Date.now()` stamp of the last time AGETOR ITSELF drove keystrokes into
   * this session's pane — the single write site is `bumpKeystroke`, called
   * from every place this module pastes text or sends keys (see that
   * function's doc for the enumerated list). Initialized to the construction
   * time in `makeSessionState`, exactly like `lastActivityAt`.
   *
   * Deliberately NOT the same clock as `lastActivityAt`, which also counts
   * claude's own life signs (JSONL appends, pane diffs). The idle-settle net
   * in `scrapeOnce` needs "have WE touched this pane recently?", not "has
   * anything at all changed?": the whole point of that net is to close out a
   * turn on a pane where nothing is happening, and a pane that repaints on
   * its own (claude 2.1.246's status-bar hint flickers ~1 Hz — see
   * `EFFORT_HINT_SUFFIX_RE` / `normalizePaneForActivity`) would otherwise
   * keep `lastActivityAt` pinned at "now" forever and hold the gate shut. The
   * hazard that gate exists to defend against — settling a turn whose prompt
   * we only just delivered — is entirely a function of OUR keystrokes, which
   * is exactly what this field measures.
   *
   * `lastActivityAt` is left alone (still the reaper's idle clock, still
   * bumped by pane diffs and JSONL appends); `bumpKeystroke` is additive.
   */
  lastKeystrokeAt: number;
  /** Last full tmux pane capture `scrapeOnce` took (the same trimmed tail
   *  text used for modal matching), kept purely to detect "the pane changed
   *  since last capture" as an activity signal independent of JSONL writes —
   *  covers a native AskUserQuestion modal or a user driving the session via
   *  `tmux attach`, neither of which necessarily appends to the JSONL. Null
   *  until the first capture (so the very first tick never counts as a
   *  "change"). */
  scrapeLastPaneText: string | null;
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
   * The mode value of the last mode-bearing JSONL line `dispatchLine`
   * processed (or the launch/reattach seed) — the baseline handed to
   * `mapParsedEventToChunks` as `lastPermissionMode` for chip-suppression
   * purposes. Unlike `permissionMode`, this field is NEVER written from a
   * pane scrape (`cycleToModeInner`'s Shift+Tab verification writes only
   * `permissionMode`) — so when the user switches modes via the UI, this
   * field still lags the live mode until claude journals the corresponding
   * JSONL line at the next turn start, and the confirmation chip for that
   * genuinely user-initiated change is not wrongly suppressed as a "no-op"
   * repeat.
   */
  lastAnnouncedPermissionMode: string | null;
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
  /** Periodic poll of `tmux has-session` while a turn is in flight. Fires
   *  when the session dies unexpectedly mid-run (crash / external kill /
   *  tmux server gone) so we can settle the run and flip the card to
   *  `blocked` LIVE, instead of leaving it stranded in `running` until the
   *  next boot's `reconcileOrphans`. Armed in `attachTailer`, cleared by
   *  `disposeSessionState` and by `signalSessionDeath` itself (one-shot —
   *  a dead session never revives). */
  deathTimer: ReturnType<typeof setInterval> | null;
  /** Last fingerprint the scraper saw; an entry must match the previous
   *  scrape (i.e. two consecutive ticks) before we register a real
   *  TmuxPromptRequest. Suppresses false positives where a numbered list
   *  flickers past during normal output. Reset whenever the pane no
   *  longer matches any signature. */
  scrapeLastFingerprint: string | null;
  /** Consecutive scrape ticks the CURRENT unparsable-fallback fingerprint has
   *  held. `matchUnparsableModal` registers only at `UNPARSABLE_STABILITY_TICKS`
   *  — a stricter gate than the generic two-tick one, because a footer/watchdog
   *  sighting IS the whole trigger (no parsed choice set behind it), so a 1–2
   *  tick blip from an animating modal or a spinner blink must never card. */
  scrapeUnparsableStreak: number;
  /** Consecutive scrape ticks the idle-settle condition (turn in flight,
   *  quiet past `STUCK_TURN_FALLBACK_MS`, pane idle at the input box, no
   *  ask card, no live tmux prompt for the task) has held. Mirrors
   *  `scrapeUnparsableStreak`'s stability gate exactly — held to
   *  `UNPARSABLE_STABILITY_TICKS` before `signalIdleSettle` fires, so a
   *  single transient idle-looking frame can't settle a run that's actually
   *  still busy. Reset to 0 on every tick the condition doesn't hold
   *  (`scrapeOnce`), and wherever `scrapeUnparsableStreak` itself is reset
   *  (`markTmuxPromptAnswered`, `disposeSessionState`) — an answered prompt
   *  or a torn-down session both mean whatever streak was accruing no
   *  longer applies. */
  scrapeIdleSettleStreak: number;
  /** `Date.now()` stamp of the most recent successful JSONL append the
   *  flusher dispatched. The scraper consults it to (a) suppress
   *  matches that happened while claude was actively writing (the
   *  "prompt" is probably transient list output, not a stable modal)
   *  and (b) cheaply detect a truly idle session so the 1s scrape
   *  tick can self-throttle. 0 means "no append observed yet". */
  lastJsonlAppendAt: number;
  /** `Date.now()` of the last pane capture taken while the session was
   *  JSONL-idle (no turn in flight, no recent append). A native modal —
   *  AskUserQuestion or a permission dialog — can appear before any (or any
   *  RECENT) JSONL write lands: a permission dialog writes nothing to the
   *  JSONL until answered, and even though claude DOES write the pending
   *  AskUserQuestion tool_use pre-answer (see `readPendingAskQuestionsFromJsonl`),
   *  it can flush lazily. So the idle path can't stop scraping entirely or it
   *  would never see a question raised after the turn already resolved to
   *  `review`. Instead it throttles to one capture every
   *  `SCRAPE_IDLE_POLL_MS`, stamping the time here. 0 means "no idle capture
   *  taken yet". */
  lastIdleScrapeAt: number;
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
   * native modal, or null when none is up. Detection comes from the tmux pane
   * (`detectAskModal`); CONTENT preferentially comes from the pending
   * AskUserQuestion tool_use claude already wrote to the JSONL (see
   * `readPendingAskQuestionsFromJsonl`), falling back to a pane scrape
   * (`collectAskQuestionsFromPane`) for the window before that flushes. The
   * card is resolved when the modal leaves the pane.
   */
  askCardId: string | null;
  /** True while the tab-walk collector is mid-flight reading a multi-question
   *  modal's tabs, so the scraper doesn't kick off a second collection. */
  askCollecting: boolean;
  /** Wall-clock ms when the AskUserQuestion modal was first seen on the pane.
   *  Gives claude a grace window to flush the tool_use (which carries the full
   *  question incl. previews + long descriptions) before we degrade to the
   *  lossy pane scrape. Null when no modal is open. */
  askFirstSeenAt: number | null;
  /** Consecutive "grew the pane but the parse is still incomplete" failures
   *  for the CURRENT modal (see `collectAskQuestionsFromPane`). Once this
   *  hits `MAX_ASK_GROW_ATTEMPTS`, `collectAskQuestionsFromPane` gives up
   *  without resizing the pane again — otherwise a truncated modal that can
   *  never parse complete (some pane geometry / content combo we haven't
   *  seen) would resize the user's live tmux window forever, once per scrape
   *  tick. Reset to 0 alongside `askFirstSeenAt` — the modal leaving the pane
   *  (or a new one replacing it) earns a fresh budget. */
  askGrowAttempts: number;
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
  /** True while we're folding follow-up messages into the active run (set by
   *  `pasteFollowUp`). While set, an intermediate `end_turn` boundary does NOT
   *  pop the turn slot — claude is just moving on to a folded message, so the
   *  run stays "running" (the task doesn't bounce to `review` between folded
   *  turns). Only the idle-fire in `flush` resolves the run, once claude has
   *  been quiet for `END_TURN_IDLE_FIRE_MS`. Cleared in `popEndOfTurn` when the
   *  slot finally pops (the whole busy period is over). */
  holdUntilIdle: boolean;
  /** First whitespace-delimited token of the current turn's prompt, iff its
   *  FIRST line starts with `/` (e.g. `/skill-creator`) — null otherwise. Set
   *  by every prompt-delivery point (`sendTurn`, `pasteFollowUp`, the
   *  deferred-prompt paste and argv-prompt spawn path in
   *  `spawnClaudeViaTmux`), which lets `scrapeOnce` arm a token-matched
   *  lookout for claude's TUI rejecting the message with `Unknown command:
   *  /<token>` — no JSONL is ever written for that case, so nothing else
   *  would ever unstick the run. Cleared (a) on the next real JSONL line
   *  (`dispatchLine` — the message was delivered/ran for real), (b) when a
   *  turn resolves normally (`popEndOfTurn`), (c) on session death
   *  (`signalSessionDeath`), and (d) by `signalUnknownCommand` itself, which
   *  doubles as its one-shot re-entry guard (`scrapeOnce` only calls it while
   *  this is non-null). */
  pendingSlashToken: string | null;
  /**
   * Command token (e.g. `"/effort"`) of the MOST RECENT `<command-name>…
   * </command-name>` line `dispatchLine` has seen this session, via
   * `parseLocalCommandLine` — independent of any turn slot, so it tracks a
   * local command run by ANY path (the task's own prompt, a folded
   * `pasteFollowUp`, or the dropdown mirror's `sendSlashCommand`, none of
   * which own the head slot the same way).
   *
   * This is the identity half of the local-command settle gate: a
   * `<local-command-stdout>` line only stages a pending end_turn for the
   * HEAD SLOT when `slot.slashCommand === state.lastLocalCommandName` (see
   * `dispatchLine`'s `isLocalCommandStdoutEvent` call site) — i.e. the
   * command that just printed its stdout is the SAME command the head
   * slot's own prompt sent, not merely "some command ran while a
   * slash-prefixed prompt's turn happened to be in flight." Without this,
   * a foreign `/effort x` mirrored in while a `/implement …` (or any other
   * slash-prefixed) prompt's turn is running would settle that turn early
   * (staged `pendingEndTurn.messageId: null` defeats `isEndTurnContinuation`
   * on the very next assistant line, resolving the run `succeeded`
   * mid-work).
   *
   * Cleared to `null` the moment a stage actually fires off it (so a LATER
   * unrelated command can't match a stale name), and in `popEndOfTurn` /
   * `disposeSessionState` alongside the other slash-command staging fields.
   * Null when no command-name line has been observed yet.
   */
  lastLocalCommandName: string | null;
  /**
   * The `<command-args>…</command-args>` payload from the SAME
   * `<command-name>…</command-name>` line that set `lastLocalCommandName`
   * (via `parseLocalCommandLine` — empty string when the tag itself is
   * empty, e.g. a bare `/model` with no argument). Kept in lockstep with
   * `lastLocalCommandName`: set together, cleared together (`popEndOfTurn`,
   * the local-command settle stage, `disposeSessionState`). Forwarded as
   * `LocalSettingInfo.args` when `dispatchLine` fires the local-setting-
   * changed seam on that command's own `<local-command-stdout>` line — see
   * `fireLocalSettingChanged`. Null when no command-name line has been
   * observed yet (distinct from "" — an observed-but-argless command).
   */
  lastLocalCommandArgs: string | null;
  /** Watches `<sessionId>/subagents/` for background/sub agents this session
   *  spawns, tailing each into the task's event stream (tagged by subagent id)
   *  for the run panel's read-only tabs. Armed in `attachTailer`, released in
   *  `disposeSessionState`. Read-only — never touches tmux. Null until armed
   *  (and when AGETOR_TRACK_SUBAGENTS=0, `attachSubagentWatcher` returns a
   *  no-op handle). */
  subagentWatcher: SubagentWatcherHandle | null;
  /**
   * Armed by `maybeAdoptContinuation` ONLY when a continuation run was
   * adopted off a task-notification line rather than genuine content — i.e.
   * we don't yet know claude will actually keep talking after the
   * background task settles, just that it noticed. `slot` is the adopted
   * turn this watchdog is guarding, checked by identity at fire time so a
   * stale timer callback (the turn already resolved a beat earlier through
   * some other path) can't double-settle it. Reset (timer replaced, same
   * slot) when another task-notification line arrives while still armed —
   * a fresh wake signal earns a fresh window. Cleared — timer cancelled,
   * field nulled — the moment real content reaches the adopted turn
   * (`dispatchLine`), when that turn resolves through the normal end-turn
   * machinery (`popEndOfTurn`), on an unexpected session death
   * (`signalSessionDeath`), and on teardown (`disposeSessionState`), mirroring
   * how `deathTimer` / `scrapeTimer` / `pollTimer` are handled in those same
   * places. Content-triggered adoption arms nothing — real content already
   * arrived, so there's nothing to wait for. Null when not armed. */
  continuationWatchdog: { timer: ReturnType<typeof setTimeout>; slot: TurnSlot } | null;
  /** True while `collectAskQuestionsFromPane` has grown the detached pane and
   *  `window-size` is legitimately `manual` for this session — set right before
   *  the grow, cleared by the SAME `finally` (nested inside it) that restores
   *  the pane, so a throwing `restore` still clears the flag. Brackets the
   *  ONLY period a stuck `manual` pin is expected; `healWindowSize` checks
   *  this so it never races the scraper's own restore (which would fight over
   *  window-size mid-grow and could strand the pane at the wrong size). */
  paneGrowInFlight: boolean;
  /**
   * True when a PRIOR `queuePaste` on this session withheld its trailing
   * Enter (the pre-Enter TOCTOU re-check — see `queuePaste`'s doc) while the
   * pasted text was already sitting in claude's composer, unsubmitted. Set
   * on that withhold; the NEXT `queuePaste` call checks this flag before
   * pasting again so the new message doesn't land concatenated after the
   * stranded one (docs/plans/model-effort-local-command-turns.md §10 review
   * finding #2). Cleared when: the composer is confirmed clear (idle pane,
   * bare prompt row) before the next paste; a live Escape-Escape clear
   * succeeds; or any paste's own Enter goes out successfully (submitting
   * whatever was in the composer, including a message this flag was set
   * for). Never set by anything else — a paste that fails at the PRE-paste
   * guard (before any text reached the composer) has nothing to flag.
   */
  composerHoldsText: boolean;
  /**
   * True for the duration of `mirrorModelViaPicker`'s driving `queueTmuxOp`
   * callback (finding #3, wave-5 re-review) — set true right before that op
   * starts polling for the bare `/model` picker, cleared in a `finally` so
   * every exit path restores it. While true, `scrapeOnce` skips registering
   * a NEW `tmux_prompt` card (both the generic and unparsable matcher paths
   * converge on one registration call — see that call site) but still runs
   * its `__external__` auto-cancel sweep for anything already registered.
   * Mirrors `askCollecting`'s "a known driver owns the pane right now" idea:
   * the picker's footer (`Enter to set as default · s to use this session
   * only · Esc to cancel`) makes it `highConfidence` in `matchNumberedModal`,
   * so without this it would card on the very first scrape tick after
   * agetor opened it — and a concurrent card click racing this function's
   * own keystrokes would enqueue `dismissTmuxPrompt` behind the mirror's own
   * op on the same per-task chain, risking a wrong-row confirm. False by
   * default; reset to false on dispose (defensive — the op's own `finally`
   * should already have cleared it by the time a session tears down, but a
   * session death mid-drive shouldn't leave a stale suppression behind).
   */
  drivingPrompt: boolean;
  /**
   * `Date.now()` at the moment `mirrorModelViaPicker` last sent the picker's
   * session-only confirm key (`s`) into this session — i.e. the last time
   * AGETOR ITSELF drove a `/model` outcome. `0` when it never has.
   *
   * Read at exactly one place: the local-setting-sync seam in `dispatchLine`,
   * which turns it into `LocalSettingInfo.viaMirror`
   * (`Date.now() - lastModelMirrorAt < MODEL_MIRROR_ATTRIBUTION_MS`). That
   * boolean is what lets the orchestrator tell claude's `Kept model as <X>`
   * outcome apart in the only two ways it can arise:
   *   - agetor's own mirror popped `Switch model?` and the user DECLINED it
   *     (`viaMirror` true) — the row was already written optimistically and
   *     genuinely needs correcting back to what the session kept;
   *   - the user opened a bare `/model` themselves and pressed Esc
   *     (`viaMirror` false) — claude reports the model it kept, which says
   *     NOTHING about the next-run model the user deliberately picked in the
   *     dropdown. Syncing there silently discarded that choice (live smoke:
   *     a row set to a model the 2.1.246 picker can't select, then reverted
   *     to `Sonnet 5` by a bare `/model` + Esc).
   *
   * Stamped ONLY on the `s` keystroke actually landing — not on the opening
   * `/model` paste, and not on the `target not offered` Escape exit. That
   * Escape produces the very same `Kept model as` line a user's own Esc does,
   * and it means the row's target model wasn't on offer, so it must NOT be
   * allowed to overwrite the row either.
   *
   * Reset to 0 on dispose, like every other per-session clock — a respawned
   * session must not inherit a previous process's attribution window.
   */
  lastModelMirrorAt: number;
  /**
   * The reasoning-effort id this session's claude process was LAUNCHED with —
   * i.e. whatever `CLAUDE_CODE_EFFORT_LEVEL` the spawn env carried
   * (`agents.ts`'s `buildCommand` writes that var and drops unknown ids), or
   * `null` when the env carried none (a model that declines effort) or when
   * there was no launch env to read at all (`reattachSession`,
   * `rebuildEventsFromJsonl`, the test helper).
   *
   * Read-only bookkeeping, surfaced through `getSessionLaunchEffort` for the
   * orchestrator's breadcrumb — "this session is pinned to <launchEffort> by
   * CLAUDE_CODE_EFFORT_LEVEL". Deliberately NOT updated when claude's own
   * `/effort` changes the LIVE effort mid-session: the env var is what the
   * process started with and cannot be re-set without a respawn, which is
   * exactly the fact the breadcrumb needs to state. Cleared on dispose.
   */
  launchEffort: string | null;
}

interface TurnSlot {
  /** Handler routes JSONL events to the run this slot represents. */
  onChunk: ChunkHandler;
  /** Resolves the SpawnedAgent.done promise on this turn's end_turn. */
  resolve: ((code: number) => void) | null;
  reject: ((err: Error) => void) | null;
  /**
   * First whitespace-delimited token of THIS turn's own opening prompt, iff
   * its first line starts with `/` (via `slashTokenOf`) — null otherwise.
   * Set at the turn's own push site: the initial spawn prompt
   * (`spawnClaudeViaTmux`'s `initialSlot`) and `sendTurn`'s fresh slot. Left
   * `null` for a slot that was never pushed FOR a human-typed prompt of its
   * own — the adopted-continuation slot (`maybeAdoptContinuation`, which
   * fires off claude's own follow-up content/notifications, not a prompt we
   * sent) and the reattach/test helper slot.
   *
   * Read by `dispatchLine` to gate the local-command settle: a
   * `<local-command-stdout>` line only ends the CURRENT head slot's turn
   * when BOTH that slot's own prompt was a slash command AND it NAMES THE
   * SAME command as the most recent `<command-name>` line
   * (`SessionState.lastLocalCommandName`) — see `isLocalCommandStdoutEvent`'s
   * call site for the full two-part check. The name comparison is the part
   * that actually matters: this field alone tells you the CURRENT turn's own
   * prompt was slash-prefixed, but not that IT is the command whose stdout
   * just printed — a task whose own prompt is `/implement …` still has this
   * field set to `/implement`, and without the name check a foreign `/effort
   * x` folded in via `pasteFollowUp` (which carries the ORIGINAL turn's slot)
   * or mirrored in via `sendSlashCommand` (which pushes no slot at all) could
   * be mistaken for that turn's own settle signal.
   */
  slashCommand: string | null;
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
 * delete-buffer + send-keys Enter` back-to-back with no deliberate gap
 * (each still its own awaited `tmux()` round-trip — see `pastePrompt`),
 * while bracketed user pastes split the trailing Enter out with a small
 * `bracketedEnterGapMs` sleep in between. See `queuePaste`.)
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
  /** Defaults to `permissionMode` (or its own default of `null`) when
   *  omitted — the common case where the caller has no reason for the two
   *  fields to start out of sync. See `SessionState.lastAnnouncedPermissionMode`
   *  for what it means to pass something different (used by `reattachSession`
   *  to seed the suppression baseline without also seeding `permissionMode`). */
  lastAnnouncedPermissionMode?: string | null;
  bypassEnabled?: boolean;
  /** See `SessionState.launchEffort`. Only `spawnClaudeViaTmux` has a launch
   *  env to read this off; every other construction site leaves it null. */
  launchEffort?: string | null;
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
    lastAnnouncedPermissionMode: o.lastAnnouncedPermissionMode ?? o.permissionMode ?? null,
    bypassEnabled: o.bypassEnabled ?? false,
    launchEffort: o.launchEffort ?? null,
    // Defaults shared by every site — timers, scrape state, staging buffers.
    watcher: null,
    pollTimer: null,
    scrapeTimer: null,
    deathTimer: null,
    // "Initialize at spawn/reattach" — every construction site (fresh spawn,
    // reattach, rebuild, the test helper) routes through here, so stamping
    // "now" here covers all of them uniformly.
    lastActivityAt: Date.now(),
    // Same "start the clock at construction" rule as `lastActivityAt` above:
    // a session that has existed for less than STUCK_TURN_FALLBACK_MS is
    // structurally ineligible for the idle-settle net, spawn prompt or not.
    lastKeystrokeAt: Date.now(),
    scrapeLastPaneText: null,
    scrapeLastFingerprint: null,
    scrapeUnparsableStreak: 0,
    scrapeIdleSettleStreak: 0,
    lastJsonlAppendAt: 0,
    lastIdleScrapeAt: 0,
    recentlyAnsweredFingerprints: new Map(),
    askCardId: null,
    askCollecting: false,
    askFirstSeenAt: null,
    askGrowAttempts: 0,
    pendingEndTurn: null,
    holdUntilIdle: false,
    pendingSlashToken: null,
    lastLocalCommandName: null,
    lastLocalCommandArgs: null,
    subagentWatcher: null,
    continuationWatchdog: null,
    paneGrowInFlight: false,
    composerHoldsText: false,
    drivingPrompt: false,
    // Never mirrored yet. `0` is deliberately a real timestamp value rather
    // than `null`: `Date.now() - 0` is ~56 years, so the attribution window
    // reads false without a special case at the seam.
    lastModelMirrorAt: 0,
  };
}

/** Stamp `lastActivityAt` to "now" — the single write site for the idle
 *  clock, called from every place a session "shows life" (see the field's
 *  doc comment on `SessionState`). Kept as a named helper (rather than
 *  inlining `Date.now()` at each call site) so the exact set of triggers is
 *  grep-able and can't silently drift out of sync with the doc comment. */
function bumpActivity(state: SessionState): void {
  state.lastActivityAt = Date.now();
}

/**
 * Stamp `lastKeystrokeAt` to "now" — the single write site for the
 * "agetor last touched this pane" clock (see the field's doc on
 * `SessionState` for why it is separate from `lastActivityAt`). Call this
 * IMMEDIATELY BEFORE any tmux call that delivers keystrokes or a paste to the
 * session's pane, so the stamp is set even when that call then fails: a
 * `send-keys` that reports `.ok === false` may still have delivered bytes,
 * and the conservative reading (we touched the pane) is the one that keeps
 * the idle-settle net from closing a turn we may just have started.
 *
 * The full set of call sites (keep this list in sync — it is what makes the
 * clock's meaning greppable):
 *   - `queuePaste`, at ENQUEUE (finding #1, wave-5 re-review — before it ever
 *     calls `queueTmuxOp`, since queuing a paste on a long-idle session is
 *     already the intent to type, and the queued op can sit behind other work
 *     on the per-task chain for multiple scrape ticks before it actually
 *     runs), and again right before each `pastePrompt` dispatch, before
 *     the deferred bracketed Enter, and before the composer-clear keystrokes;
 *   - `walkCursor` (the shared arrow-nav loop behind `dismissTmuxPrompt` and
 *     `mirrorModelViaPicker`) and `dismissTmuxPrompt`'s own literal-key and
 *     confirm keystrokes;
 *   - `sendModalKeys` and `driveAskAnswers` (native modal driving), and the
 *     ask-collector's pane navigation (`tmuxPaneIo.send`);
 *   - `cycleToModeInner`'s Shift+Tab (`BTab`) batch;
 *   - `autoConfirmSlashModal`'s Enter and `mirrorModelViaPicker`'s
 *     `s` / `Escape`;
 *   - `confirmStartupDialog`'s arrows + Enter (finding #6, wave-5 re-review —
 *     looked up via `sessions.get(taskId)` since that function is handed only
 *     a session NAME, not a `SessionState`; a prior version of this doc
 *     claimed there was "no SessionState yet" at that point, which is false —
 *     `spawnClaudeViaTmux` calls `sessions.set` before it ever arms the boot
 *     poller that reaches `confirmStartupDialog`, so the state exists and a
 *     miss there would leave the boot-time idle-settle net blind to agetor's
 *     own auto-confirm keystrokes);
 *   - the Ctrl+C interrupts (`makeAgent().kill`, `interruptTaskSession`,
 *     `reattachSession`'s kill handle).
 */
function bumpKeystroke(state: SessionState): void {
  state.lastKeystrokeAt = Date.now();
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
  // A turn settling is itself a life signal — reset the idle clock even
  // though `flush`'s JSONL-append bump already fired for the line that
  // triggered this (the reattach path fires `onEndOfTurn` with no fresh
  // append behind it, so this can't be dropped as redundant).
  bumpActivity(state);
  // The busy period (the active turn plus any folded follow-ups) is ending —
  // clear the hold so the next genuinely-sequential turn resolves normally.
  state.holdUntilIdle = false;
  // The turn resolved normally (real end_turn) — whatever was armed for the
  // unknown-command lookout no longer applies to it.
  state.pendingSlashToken = null;
  // Same reasoning: the local-command identity gate (`lastLocalCommandName`)
  // is scoped to the turn that just settled — a fresh command name has to be
  // observed again before another local-command settle can stage.
  state.lastLocalCommandName = null;
  state.lastLocalCommandArgs = null;
  // A turn resolving through the normal end-turn machinery means any
  // notification-triggered continuation watchdog has nothing left to guard
  // against — cancel it. Safe unconditionally: the watchdog is only ever
  // armed for the current queue head (see `maybeAdoptContinuation`), which
  // is exactly the slot this call is about to pop below.
  clearContinuationWatchdog(state);
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
async function captureTail(state: SessionState): Promise<string> {
  const cap = await tmux(["capture-pane", "-p", "-t", state.sessionName]);
  if (!cap.ok) return "";
  const cl = cap.stdout.split("\n");
  return cl.slice(Math.max(0, cl.length - SCRAPE_TAIL_LINES)).join("\n");
}

/**
 * Read the live native AskUserQuestion modal off the tmux pane and register a
 * structured card for it.
 *
 * The JSONL tool_use (read via `readPendingAskQuestionsFromJsonl`) is the
 * preferred source — claude DOES write the pending AskUserQuestion tool_use
 * to the session JSONL before the modal is answered, and it carries the full
 * question/options/previews the TUI may wrap or collapse on screen. But
 * claude can flush it lazily, so this pane-scrape path is the fallback for
 * while it's briefly absent from disk. For a single-question modal everything
 * is on screen; for a multi-question (tabbed) modal only the active tab's
 * options are visible, so we briefly walk the tabs (`→` per tab, capture+parse
 * each, then `←` back to the first) and register one card with every question.
 * A tall modal can also push the header/question/first option off the top of
 * the visible pane — `collectAndRegisterAskCard` guards against trusting that
 * kind of partial read (see `ParsedQuestionPane.complete`).
 *
 * Fire-and-forget from the scraper, guarded by `askCollecting` (so a 1s tick
 * can't start a second walk) and `askCardId` (so we never double-register). The
 * card is resolved by the scraper when the modal leaves the pane.
 */
/** Map an AskUserQuestion tool_use `input` (the `{questions:[…]}` object claude
 *  writes to the JSONL) to our AskQuestion[], including each option's multi-line
 *  `preview`. Returns null when the shape isn't what we expect. */
function mapJsonlAskInput(input: unknown): AskQuestion[] | null {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs) || qs.length === 0) return null;
  const out: AskQuestion[] = [];
  for (const q of qs as Array<Record<string, unknown>>) {
    if (!q || typeof q.question !== "string" || !Array.isArray(q.options)) return null;
    out.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : undefined,
      multiSelect: q.multiSelect === true,
      options: (q.options as Array<Record<string, unknown>>).map((o) => ({
        label: String(o?.label ?? ""),
        description: typeof o?.description === "string" ? o.description : undefined,
        preview: typeof o?.preview === "string" ? o.preview : undefined,
      })),
    });
  }
  return out;
}

/** Read the structured questions for the CURRENTLY-OPEN AskUserQuestion straight
 *  from the session JSONL: the last `AskUserQuestion` tool_use whose
 *  tool_use_id has no matching tool_result yet (still awaiting the user). When
 *  present this beats scraping the pane — it carries full descriptions and the
 *  multi-line `preview` blocks the TUI collapses to "✂ N lines hidden". Returns
 *  null when the tool_use isn't on disk yet (claude can flush it lazily), so the
 *  caller falls back to the pane parser. */
/** Read the trailing `maxBytes` of a file as UTF-8 text, dropping the (partial)
 *  first line when we didn't start at byte 0. Returns null on any error. Lets us
 *  scan just the recent JSONL instead of loading a multi-MB session file into
 *  memory on every grace tick (a sync read that would otherwise block the loop). */
function readFileTail(filePath: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    const size = fsStatSync(filePath).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return "";
    fd = fsOpenSync(filePath, "r");
    const buf = Buffer.alloc(len);
    fsReadSync(fd, buf, 0, len, start);
    const text = buf.toString("utf8");
    if (start === 0) return text;
    const nl = text.indexOf("\n");
    return nl >= 0 ? text.slice(nl + 1) : "";
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fsCloseSync(fd); } catch { /* already gone */ } }
  }
}

function readPendingAskQuestionsFromJsonl(jsonlPath: string): AskQuestion[] | null {
  // The pending tool_use (and its result, if answered) are always the most
  // recent lines, so the tail is enough — no need to read the whole session.
  const text = readFileTail(jsonlPath, 256 * 1024);
  if (text === null) return null;
  const answered = new Set<string>();
  let last: { id: string; questions: AskQuestion[] } | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes("AskUserQuestion") && !line.includes("tool_result")) continue;
    let j: { message?: { content?: unknown } };
    try { j = JSON.parse(line); } catch { continue; }
    const blocks = Array.isArray(j?.message?.content)
      ? (j.message!.content as Array<Record<string, unknown>>) : [];
    for (const b of blocks) {
      if (b?.type === "tool_result" && typeof b.tool_use_id === "string") answered.add(b.tool_use_id);
      if (b?.type === "tool_use" && b.name === "AskUserQuestion" && typeof b.id === "string") {
        const qs = mapJsonlAskInput(b.input);
        if (qs) last = { id: b.id, questions: qs };
      }
    }
  }
  return last && !answered.has(last.id) ? last.questions : null;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Per-option preview capture (pane geometry)
 *
 * claude renders an AskUserQuestion option's `preview` in a box-drawn panel to
 * the RIGHT of the option list — but only for the FOCUSED option, and the TUI
 * collapses anything taller than the available rows to "✂ N lines hidden". So to
 * surface real per-option previews live (the JSONL tool_use only lands on
 * answer), we (a) GROW the detached pane so the panel isn't truncated — verified
 * de-truncating against real 2.1.170 captures — then (b) navigate each option,
 * scraping its panel. The user views the webview card, never the pane, so the
 * resize is invisible; it is always restored afterwards.
 * ────────────────────────────────────────────────────────────────────────── */
const PREVIEW_PANE_MIN_COLS = 120; // wider never adds label wraps; widens the box for wide previews
const PREVIEW_PANE_ROWS = 100;     // covers ~any realistic preview; restored after
const PREVIEW_REFLOW_MS = 450;     // let claude's Ink TUI redraw after a resize
const OPTION_NAV_MS = 160;         // settle after each Up/Down before capturing

/** The slice of tmux that `collectAskQuestionsFromPane` drives, behind an
 *  interface so the navigation / grow / restore orchestration is unit-testable
 *  with a fake pane (the real one shells out to tmux). */
interface PaneIo {
  /** Full pane capture (NOT the scrape tail). */
  capture(): Promise<string>;
  /** Send one nav key; false when tmux errored (session gone). */
  send(key: NavKey): Promise<boolean>;
  /** Current `<w>x<h>`, or null. */
  size(): Promise<{ w: number; h: number } | null>;
  resize(w: number, h: number): Promise<void>;
  restore(w: number, h: number): Promise<void>;
  sleep(ms: number): Promise<void>;
}

function tmuxPaneIo(state: SessionState): PaneIo {
  return {
    capture: () => captureFullPane(state),
    send: async (key) => {
      // Ask-collector cursor navigation is still agetor typing into the live
      // pane — same idle-settle clock as every other keystroke path.
      bumpKeystroke(state);
      return (await tmux(["send-keys", "-t", state.sessionName, key])).ok;
    },
    size: () => paneSize(state),
    resize: (w, h) => resizePane(state, w, h),
    restore: (w, h) => restorePaneSize(state, w, h),
    sleep: (ms) => Bun.sleep(ms),
  };
}

/** Whether a captured pane shows the right-hand preview panel — a ≥2-space
 *  gutter then a box border/vertical that closes near end-of-line. Detects even
 *  a tall panel whose ┌ top border is above the 40-line scrape tail (its
 *  `│ … │` content rows still match), so we don't skip a tall-preview question.
 *  Used only for the GROW decision — a false positive (e.g. a boxed scrollback
 *  row in the tail) costs nothing but a needless, restored resize, never a wrong
 *  card; the per-option walk keys on the *parsed* focused preview instead. */
function paneHasPreviewPanel(text: string): boolean {
  return text.split("\n").some((l) => /\s{2,}[┌│├][^\n]*[┐│┤]\s*$/u.test(l));
}

/** Current `<w>x<h>` of the session's window, or null. */
async function paneSize(state: SessionState): Promise<{ w: number; h: number } | null> {
  const r = await tmux(["display-message", "-p", "-t", state.sessionName, "#{window_width}x#{window_height}"]);
  if (!r.ok) return null;
  const m = r.stdout.trim().match(/^(\d+)x(\d+)$/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/** Force a detached window to a fixed size (`window-size manual` is required for
 *  `resize-window` to stick on a session no client is attached to). Chained as a
 *  SINGLE tmux invocation (`;` as its own argv element — no shell involved, so
 *  it's a literal semicolon, not a shell-escaped `\;`) so the two commands reach
 *  the tmux server atomically: if agetor dies mid-call there's no window where
 *  `window-size` is `manual` but the resize hasn't landed yet. */
async function resizePane(state: SessionState, w: number, h: number): Promise<void> {
  await tmux([
    "set-window-option", "-t", "=" + state.sessionName, "window-size", "manual", ";",
    "resize-window", "-t", "=" + state.sessionName, "-x", String(w), "-y", String(h),
  ]);
}

/** Restore the original size and hand sizing back to tmux. Chained as a single
 *  invocation for the same reason as `resizePane`: two separate tmux calls
 *  left a window where a crash between them stranded the session pinned
 *  `window-size manual` (potentially at the small grown-then-half-restored
 *  size) — a client attaching later gets confined to that fixed size instead of
 *  renegotiating to its own, which is exactly the "minimized" rendering bug.
 *  Chaining closes that window going forward.
 *
 *  BUT tmux aborts a `;`-chain at the first failing command (empirically
 *  verified) — if `resize-window` fails (bad dims, session gone mid-chain,
 *  etc.) the trailing `set-window-option … latest` never runs, and the
 *  session is left pinned `manual`: the exact bug this file fixes, just
 *  triggered by a failed command instead of a crash. The old two-invocation
 *  form ran the unpin unconditionally, so a failed resize alone couldn't
 *  strand the pin. Restore that guarantee: if the chain didn't report ok,
 *  issue a standalone unpin as a fallback. `-u` (unset) reverts to the
 *  inherited value rather than forcing `latest` — see the comment on
 *  `healWindowSize` for why that heal path, unlike this one, deliberately
 *  forces `latest` instead. */
async function restorePaneSize(state: SessionState, w: number, h: number): Promise<void> {
  const r = await tmux([
    "resize-window", "-t", "=" + state.sessionName, "-x", String(w), "-y", String(h), ";",
    "set-window-option", "-u", "-t", "=" + state.sessionName, "window-size",
  ]);
  if (!r.ok) {
    console.warn(
      `[claude-tmux] restorePaneSize chain failed for session ${state.sessionName} — ` +
        `falling back to a standalone unpin: ${r.stderr}`,
    );
    await tmux(["set-window-option", "-u", "-t", "=" + state.sessionName, "window-size"]);
  }
}

/**
 * Heal a session's `window-size` back to `latest` if a prior crash left it
 * stuck `manual` (chaining above closes the race going forward, but a pin
 * from before this fix — or from any other interruption — can still be
 * sitting on a session that outlived an agetor restart). A `manual` pin
 * confines every future attach to whatever size it was left at instead of
 * letting the attaching client's own size win, which is exactly the
 * "minimized" rendering bug. Best-effort and never throws — called right
 * before an attach (where failing shouldn't block the user from getting a
 * terminal) and on reattach (where there's no one to report a failure to).
 *
 * Forces the explicit `latest` value rather than `-u` (unset): unlike
 * `restorePaneSize`'s revert-to-inherited, a stuck-`manual` session's
 * inherited/global `window-size` setting is exactly what could be `manual`
 * on the user's tmux (deliberate override) — reverting to it would re-expose
 * the bug this function exists to heal. This is the one place in the file
 * that deliberately overrides a user global; don't "simplify" it to `-u`.
 *
 * No-ops when the session doesn't exist, or when a pane-grow is legitimately
 * in flight for it (`paneGrowInFlight`) — healing mid-grow would fight the
 * scraper's own resize/restore. A taskId with no in-memory `SessionState`
 * (boot before reattach, or a session that survived a crash with no state
 * rebuilt yet) can't have a grow in flight — there's no code path that could
 * be running one without state — so it's safe to heal in that case too.
 *
 * `opts.assumeAlive` skips the internal `sessionExists` probe when the
 * caller already knows the session is live (a duplicate round-trip
 * otherwise): the `open-tmux` route just checked existence itself, and
 * `reattachSession` only runs for sessions `reconcileOrphans` already
 * verified alive.
 */
export async function healWindowSize(taskId: string, opts: { assumeAlive?: boolean } = {}): Promise<void> {
  const state = sessions.get(taskId);
  if (state?.paneGrowInFlight) return;
  if (!opts.assumeAlive && !(await sessionExists(taskId))) return;
  await tmux(["set-window-option", "-t", "=" + sessionNameFor(taskId), "window-size", "latest"]);
}

/** Full pane capture (NOT the 40-line tail) — a grown preview panel can be much
 *  taller than the scrape tail. Sliced to the modal region by the caller. */
async function captureFullPane(state: SessionState): Promise<string> {
  const cap = await tmux(["capture-pane", "-p", "-t", state.sessionName]);
  return cap.ok ? cap.stdout : "";
}

/** Trim a full pane capture to just the current modal (header→footer), so a
 *  numbered list in the scrollback above can't be mis-read as options. The modal
 *  always sits at the bottom; the footer ("Esc to cancel") marks its end and the
 *  `☐`/`☒` header (or tab bar) marks its top. */
function sliceModalRegion(fullText: string): string {
  const lines = fullText.split("\n");
  let footer = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/Esc to cancel/.test(lines[i]!)) { footer = i; break; }
  }
  if (footer < 0) return fullText;
  let top = Math.max(0, footer - 80); // bounded fallback if no header is found
  for (let i = footer; i >= top; i--) {
    if (/[☐☒]/.test(lines[i]!)) { top = Math.max(0, i - 1); break; }
  }
  return lines.slice(top, footer + 1).join("\n");
}

/** Fill every option's `preview` for the CURRENT tab by walking the option
 *  cursor (one Down at a time) and scraping the focused option's panel at each
 *  stop, then restoring the cursor to option 0. `base` is the already-parsed
 *  (grown) frame for this tab — its focused option's preview is already set.
 *  Assumes the cursor starts on option 0 (true at modal open and after a tab
 *  switch). The pane must already be grown by the caller. */
async function captureTabWithPreviews(
  io: PaneIo,
  stillCurrent: () => boolean,
  base: ParsedQuestionPane,
): Promise<ParsedQuestionPane> {
  const previews: Array<string | undefined> = base.options.map((o) => o.preview);
  let downs = 0;
  for (let j = 1; j < base.options.length; j++) {
    if (!(await io.send("Down"))) break;
    downs++;
    await io.sleep(OPTION_NAV_MS);
    if (!stillCurrent()) break;
    const p = parseModalPane(sliceModalRegion(await io.capture()));
    // Only trust a capture whose cursor AND option count match — a mid-repaint
    // frame can't then misassign a preview to the wrong option.
    if (p && p.cursorIndex === j && p.options.length === base.options.length) {
      previews[j] = p.options[j]?.preview;
    }
  }
  // Restore the cursor to option 0 (exact Up count — no over-pressing, which
  // could wrap) so the later answer-drive starts where planAskAnswers expects.
  for (let k = 0; k < downs; k++) {
    if (!(await io.send("Up"))) break;
    await io.sleep(OPTION_NAV_MS);
    if (!stillCurrent()) break;
  }
  base.options.forEach((o, j) => { o.preview = previews[j]; });
  return base;
}

/** Cap on consecutive "grew the pane, still couldn't parse it complete"
 *  failures (see `SessionState.askGrowAttempts`) before
 *  `collectAskQuestionsFromPane` gives up on the current modal rather than
 *  resizing the pane again next tick. Small on purpose — a modal that's
 *  going to parse complete after a grow almost always does so on the first
 *  try; a handful of retries rules out a one-off mid-repaint capture without
 *  looping on something structurally unparseable. */
const MAX_ASK_GROW_ATTEMPTS = 3;

/** Pane fallback for when the JSONL tool_use isn't on disk yet: scrape the
 *  visible modal. A flat no-preview COMPLETE question registers immediately
 *  (fast path, no added latency) — `complete` (see `ParsedQuestionPane`) rules
 *  out the tall-modal truncation bug: a header/question/option-1 pushed off
 *  the top of a short pane must never register straight off `firstTail`.
 *  Otherwise — a tabbed modal, a flat one already showing a preview panel, or
 *  an incomplete flat capture — we grow the detached pane once (so previews
 *  aren't collapsed to "✂ N lines hidden" AND a truncated top has room to
 *  render in full) and walk it: every tab, and within each tab whose focused
 *  option has a preview, every option. A tabbed modal always grows because any
 *  of its questions may carry previews we can only detect by visiting the tab.
 *  The pane is detached (user sees the webview) and always restored.
 *  `io` is injectable so the orchestration is unit-testable without tmux. */
async function collectAskQuestionsFromPane(
  state: SessionState,
  firstTail: string,
  io: PaneIo = tmuxPaneIo(state),
): Promise<AskQuestion[] | null> {
  const first = parseModalPane(firstTail);
  if (!first) return null;
  const headers = first.tabHeaders;
  const n = first.tabbed ? Math.max(1, headers.length) : 1;

  const toAsk = (p: ParsedQuestionPane, header: string | undefined): AskQuestion => ({
    question: p.questionText,
    header,
    multiSelect: p.multiSelect,
    options: p.options.map((o) => ({ label: o.label, description: o.description, preview: o.preview })),
  });

  // Fast path: a single flat, COMPLETE question with no preview panel —
  // nothing to walk, nothing missing from the top of the capture.
  if (n === 1 && !paneHasPreviewPanel(firstTail) && first.complete) return [toAsk(first, headers[0])];

  // Give-up latch: once we've grown the pane this many times for the CURRENT
  // modal and still can't get a complete parse, stop trying. Without this, a
  // modal that can never parse complete keeps resizing (and restoring) the
  // user's live tmux window forever — once per scrape tick — since every
  // failed attempt below returns null without recording that it happened,
  // and `askCollecting` clears in the `finally` so `scrapeOnce` just re-enters
  // next tick. `scrapeOnce` checks `state.askGrowAttempts` to unsuppress the
  // generic modal matcher once we're here, so the run doesn't strand with no
  // card at all — see the comment on the final `!p.complete` check below.
  if (state.askGrowAttempts >= MAX_ASK_GROW_ATTEMPTS) return null;

  let grew = false;
  let sizeUnavailable = false;
  const collected: Array<ParsedQuestionPane | null> = [];
  await queueTmuxOp(state.taskId, async (stillCurrent) => {
    const orig = await io.size();
    if (orig) grew = true;
    else sizeUnavailable = true;
    // Brackets the ONLY window where `window-size manual` is expected on this
    // session. ONE `finally` below owns both the restore and the clear (the
    // clear nested inside it) so a throwing `io.restore` — the injected
    // `PaneIo` can throw even though the production tmux-backed one can't —
    // still clears the flag instead of stranding it true forever, which
    // would permanently disable `healWindowSize` for this session.
    if (orig) state.paneGrowInFlight = true;
    try {
      if (orig) {
        await io.resize(Math.max(orig.w, PREVIEW_PANE_MIN_COLS), PREVIEW_PANE_ROWS);
        await io.sleep(PREVIEW_REFLOW_MS);
        if (!stillCurrent()) return; // finally below restores + clears
      }
      for (let t = 0; t < n; t++) {
        if (t > 0) {
          if (!(await io.send("Right"))) return; // entering a tab resets the cursor to option 0
          await io.sleep(180);
          if (!stillCurrent()) return;
        }
        const base = parseModalPane(sliceModalRegion(await io.capture()));
        if (!base) { collected.push(null); return; }
        if (t === 0 && orig) {
          // Guard the post-resize transient: a mid-reflow capture can drop an
          // option and mis-drive the answer. Require two consecutive captures to
          // agree on the option count before trusting this tab.
          await io.sleep(OPTION_NAV_MS);
          const recheck = parseModalPane(sliceModalRegion(await io.capture()));
          if (!recheck || recheck.options.length !== base.options.length) { collected.push(null); return; }
        }
        // Walk options only when THIS tab's focused option actually has a panel
        // (keys on the parsed preview, not a loose pane regex). A tab whose
        // option 0 has no preview but a later option does is the one known gap —
        // closing it would mean navigating every no-preview question.
        const focused = base.options[base.cursorIndex];
        const tabHasPreview = !!focused && (focused.preview != null || focused.previewTruncated === true);
        collected.push(tabHasPreview ? await captureTabWithPreviews(io, stillCurrent, base) : base);
      }
      // Back to the first tab so the answer-driving sequence starts known.
      for (let t = 1; t < n; t++) {
        if (!(await io.send("Left"))) break;
        await io.sleep(90);
        if (!stillCurrent()) break;
      }
    } finally {
      if (orig) {
        try {
          await io.restore(orig.w, orig.h);
        } finally {
          state.paneGrowInFlight = false;
        }
      }
    }
  }, state);

  // Don't register a PARTIAL read: a tab that failed to parse (capture landed
  // mid-repaint) would give the wrong question count and mis-drive the answer.
  // Same rule for a tab that parsed but is still `!complete` — even after
  // growing the pane, its first real option isn't numbered "1", meaning
  // SOMETHING above it (header/question/option 1's own row) is still missing.
  // Absolute rule: never register a card whose first option isn't #1. This
  // used to claim the generic "claude is waiting at a prompt" handling was
  // already the fallback here — it wasn't: `scrapeOnce` unconditionally
  // suppresses the generic matcher whenever an AskUserQuestion modal is on
  // the pane, so returning null here (with nothing else changed) left NO
  // card registered at all. Counting the failure below is what actually
  // produces that fallback: once `askGrowAttempts` crosses
  // `MAX_ASK_GROW_ATTEMPTS`, `scrapeOnce` stops suppressing the generic
  // matcher and an ordinary `tmux_prompt` card takes over.
  if (collected.length !== n || collected.some((p) => p == null || !p.complete)) {
    // Count the failure when the pane actually got GROWN, and also when the
    // pane size was UNAVAILABLE (`io.size()` returned null) — a no-grow retry
    // at the same size can never improve the capture, so it must burn latch
    // budget too or the give-up (and the generic-card fallback it unlocks)
    // would be unreachable for exactly that stuck shape. The only uncounted
    // exit is an op that never ran (superseded by a newer queued op).
    if (grew || sizeUnavailable) state.askGrowAttempts += 1;
    return null;
  }
  return collected.map((p, i) => toAsk(p!, headers[i]));
}

/** Grace window during which we keep waiting for claude to flush its
 *  AskUserQuestion tool_use to the JSONL (full data incl. previews) before
 *  degrading to the lossy pane scrape. Only applied to a *lossy* pane (see
 *  `shouldWaitForAskJsonl`), so simple questions never incur it. */
const ASK_JSONL_GRACE_MS = 2000;

/** True when the visible pane can't represent the question — it shows claude's
 *  "✂ N lines hidden" collapse markers, meaning an option's preview / long
 *  description is off-screen. */
function paneCollapsesContent(paneTail: string): boolean {
  return /✂|\blines hidden\b/.test(paneTail);
}

/** True when the pane parses but is missing its top (header/question/option 1
 *  scrolled off a short pane — see `ParsedQuestionPane.complete`). A pane that
 *  doesn't even parse as a question modal (e.g. it's mid-repaint, or — as in
 *  some unit tests — a bare snippet with no footer) is deliberately NOT
 *  treated as lossy here: `shouldWaitForAskJsonl` is only ever called once
 *  `detectAskModal` has already confirmed a question modal is on the pane, so
 *  a null parse in production would mean something else is wrong that a JSONL
 *  wait can't fix either — same behavior as before this check existed. */
function paneTruncatesTop(paneTail: string): boolean {
  const parsed = parseModalPane(paneTail);
  return parsed !== null && !parsed.complete;
}

/** Decide whether to keep waiting for the JSONL tool_use rather than register
 *  from the pane: only when there's no JSONL yet, the pane is lossy (it either
 *  collapses content to "✂ N lines hidden", OR its top — header/question/
 *  option 1 — scrolled off the captured pane), and we're still inside the
 *  grace window. A simple, complete pane registers immediately, so we never
 *  stall a question the pane can already render in full. Pure, so the timing
 *  logic is unit-testable without tmux. */
function shouldWaitForAskJsonl(hasJsonl: boolean, paneTail: string, firstSeenAt: number | null, now: number): boolean {
  if (hasJsonl || firstSeenAt === null) return false;
  return (paneCollapsesContent(paneTail) || paneTruncatesTop(paneTail)) && now - firstSeenAt < ASK_JSONL_GRACE_MS;
}

async function collectAndRegisterAskCard(state: SessionState, firstTail: string): Promise<void> {
  if (state.askCollecting || state.askCardId) return;
  const runId = tasks.get(state.taskId)?.runId;
  if (!runId) return;
  state.askCollecting = true;
  try {
    // Prefer the JSONL tool_use — it carries the full question incl. multi-line
    // previews and the long descriptions the pane collapses to "✂ N lines
    // hidden". When the pane is lossy and the tool_use isn't on disk yet, stall
    // within a short grace window (return → next scrape tick retries) rather
    // than registering a degraded scrape. A simple pane, or the grace expiring,
    // registers immediately so a never-flushed tool_use can't strand the card.
    const fromJsonl = readPendingAskQuestionsFromJsonl(state.jsonlPath);
    if (shouldWaitForAskJsonl(fromJsonl !== null, firstTail, state.askFirstSeenAt, Date.now())) return;
    const questions = fromJsonl ?? await collectAskQuestionsFromPane(state, firstTail);
    if (!questions) return;
    // The modal may have been answered out from under us mid-collect.
    if (state.askCardId || detectAskModal(await captureTail(state)) === null) return;
    const card = registerScrapedAskQuestions({
      taskId: state.taskId,
      runId,
      questions,
      fingerprint: `ask-${runId}`,
    });
    state.askCardId = card.id;
    // A generic `tmux_prompt` fallback card may already be live for this same
    // modal — the give-up latch unsuppresses the generic matcher, and a
    // late-flushing JSONL tool_use can still land afterwards (this path).
    // scrapeOnce's per-tick auto-cancel would reap it on the next tick anyway
    // (registering the ask card re-suppresses the matcher, so the prompt's
    // fingerprint stops matching), but resolving it here avoids showing two
    // cards for one modal for even a tick.
    for (const pending of activeTmuxPromptsForTask(state.taskId)) {
      answerTmuxPrompt(pending.id, { key: "__external__" });
    }
    if (process.env.AGETOR_DEBUG) {
      (state.turnQueue[0]?.onChunk ?? state.lastChunk)?.(
        "status", `question card ready (${fromJsonl ? "jsonl" : "pane"})`,
      );
    }
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

/**
 * Default wait after a notification-triggered continuation adoption (see
 * `maybeAdoptContinuation`) before the watchdog gives up on ever seeing real
 * content and settles the run as succeeded (`fireContinuationWatchdog`).
 * Unlike `END_TURN_IDLE_FIRE_MS` — short enough that the 400ms `pollTimer`
 * can just check elapsed time opportunistically on every tick — ten minutes
 * is too long to poll for cheaply and too long for a unit test to wait out,
 * so this is a real `setTimeout` (armed in `armContinuationWatchdog`) with a
 * dedicated override seam, mirroring `setContinuationRunFactory` above
 * rather than a bare unexported constant.
 */
export const CONTINUATION_WATCHDOG_MS = 10 * 60_000;
let continuationWatchdogMs: number = CONTINUATION_WATCHDOG_MS;
/** Test seam for `CONTINUATION_WATCHDOG_MS`. Pass `null` to restore the
 *  default. Returns the previous value — save/restore like
 *  `setContinuationRunFactory` so one test's override can't leak into the
 *  next file's run. */
export function setContinuationWatchdogMs(ms: number | null): number {
  const prev = continuationWatchdogMs;
  continuationWatchdogMs = ms ?? CONTINUATION_WATCHDOG_MS;
  return prev;
}

/** Arm (or re-arm) the continuation watchdog for `slot` — the turn slot a
 *  notification-triggered adoption just pushed. Cancels any existing timer
 *  first so a re-arm (a second task-notification line while the first
 *  window is still ticking — see `maybeAdoptContinuation`) restarts the full
 *  window instead of stacking timers. */
function armContinuationWatchdog(state: SessionState, slot: TurnSlot): void {
  if (state.continuationWatchdog) clearTimeout(state.continuationWatchdog.timer);
  const timer = setTimeout(() => fireContinuationWatchdog(state), continuationWatchdogMs);
  state.continuationWatchdog = { timer, slot };
}

/** Cancel the continuation watchdog, if armed. Idempotent — safe to call
 *  from every path that might settle the adopted turn, whether or not a
 *  watchdog actually happens to be ticking. */
function clearContinuationWatchdog(state: SessionState): void {
  if (!state.continuationWatchdog) return;
  clearTimeout(state.continuationWatchdog.timer);
  state.continuationWatchdog = null;
}

/**
 * Fires `continuationWatchdogMs` after a notification-triggered adoption
 * with no real content ever landing on the adopted turn. Settles the run as
 * succeeded through the exact same machinery the `flush` idle-fire uses for
 * a genuine end_turn (`firePendingEndTurn` → `popEndOfTurn`) rather than a
 * parallel resolve path, so the slot pops and `done` resolves with 0 just
 * like a normal turn completion. If background subagents are still running,
 * the orchestrator's hold gate (unrelated to this file) keeps the card in
 * `running` regardless — this only resolves the RUN, not the task/column.
 *
 * `state.continuationWatchdog` is cleared everywhere content could prove the
 * watch unnecessary (content dispatch, normal end-turn, session death,
 * teardown), so by the time this timer callback actually runs, a non-null
 * `armed` here means content genuinely never arrived. The `turnQueue[0]`
 * identity check below is an extra belt-and-suspenders guard against a
 * timer callback that was already queued on the event loop when one of
 * those clears ran a beat too late to cancel it.
 */
function fireContinuationWatchdog(state: SessionState): void {
  const armed = state.continuationWatchdog;
  state.continuationWatchdog = null; // one-shot regardless of outcome below
  if (!armed) return;
  if (state.turnQueue[0] !== armed.slot) return;
  armed.slot.onChunk("status", "no continuation followed the background task; settling");
  state.pendingEndTurn = { messageId: null, uuid: undefined, emitBanner: false, stagedAt: Date.now() };
  firePendingEndTurn(state);
}

/**
 * Adopt a fresh continuation run for `evt` when it's the first provably-NEW
 * line to arrive on a session with no turn in flight and nothing queued —
 * the shape a post-end_turn background-task auto-resume produces. Two
 * triggers:
 *
 *   - genuine content (`isContinuationContentEvent`) — claude is already
 *     talking again; adopt immediately, no watchdog needed.
 *   - a task-notification line (`taskNotificationContent`) — claude merely
 *     NOTICED the background work finished, not proof it will keep talking.
 *     Adopt anyway (so Stop/heartbeat/`running` are live for the whole
 *     extended-thinking window that can precede the first content line) but
 *     arm `CONTINUATION_WATCHDOG_MS` in case it never actually continues.
 *
 * Called from `dispatchLine` BEFORE the background-task settle block (which
 * can release a task-notification's hold via `maybeReleaseHeldTask`) so a
 * settle can never flip the card to `review` a beat before adoption pulls
 * it back to `running` — see the settle block's comment for the ordering
 * rationale.
 *
 * Because this now runs ABOVE the `seenLineUuids` dedup return, it carries
 * its own replay guard reproducing that exact condition: a line only
 * reaches adoption when NOT (`uuid && state.seenLineUuids.has(uuid)`). This
 * guard is what makes queue-operation notification replay-safe: `uuid` here
 * is `dispatchLine`'s already-resolved key — the JSONL line's real uuid when
 * it has one, else `syntheticNotificationUuid(notifContent)` — never the raw
 * (possibly-null) `evt.uuid`, so a replayed uuid-less notification IS
 * excluded by this guard just like any other already-seen line.
 *
 * `notifContent` is passed in by the caller (`dispatchLine` computes
 * `taskNotificationContent(evt)` once and reuses it for the settle block and
 * the synthetic-uuid derivation too) rather than recomputed here.
 */
function maybeAdoptContinuation(
  state: SessionState,
  evt: ParsedJsonlEvent,
  uuid: string | undefined,
  notifContent: string | null,
): void {
  if (uuid && state.seenLineUuids.has(uuid)) return;

  // A second (or later) task-notification while a notification-adopted turn
  // is still waiting for real content is itself a fresh "claude noticed
  // something" signal — reset the watchdog's clock instead of letting the
  // window from the FIRST notification run out underneath a session that's
  // still clearly alive. Does not re-adopt (the turn is already in flight —
  // the eligibility guard below would reject it anyway).
  if (notifContent && state.continuationWatchdog) {
    armContinuationWatchdog(state, state.continuationWatchdog.slot);
    return;
  }

  if (
    !continuationRunFactory
    || turnInFlight(state)
    || state.turnQueue.length !== 0
    || state.onEndOfTurn
  ) {
    return;
  }
  const isNotification = notifContent !== null;
  if (!isContinuationContentEvent(evt) && !isNotification) return;

  const hooks = continuationRunFactory(state.taskId);
  // A null factory result (unknown/archived task) intentionally falls
  // through to the pre-existing `lastChunk` routing in `dispatchLine` —
  // unchanged.
  if (!hooks) return;

  // slashCommand: null — this slot was never pushed for a prompt WE sent
  // (it's adopted off claude's own follow-up content or a task-notification
  // it noticed on its own), so it can never gate the local-command settle.
  const adopted: TurnSlot = { onChunk: hooks.onChunk, resolve: null, reject: null, slashCommand: null };
  const done = new Promise<number>((resolve, reject) => {
    adopted.resolve = resolve;
    adopted.reject = reject;
  });
  state.turnQueue.push(adopted);
  // Register the run with the orchestrator BEFORE the triggering line
  // dispatches below — the caller must be able to observe "running" before
  // the first chunk arrives, not after.
  hooks.onAdopted(makeAgent(state.taskId, done));

  // Content-triggered adoption needs no watchdog — real content already
  // arrived, so there's nothing to wait for. Notification-triggered
  // adoption is a bet that claude will keep talking; arm the watchdog so a
  // continuation that never actually happens still settles instead of
  // holding the card in `running` forever.
  if (isNotification) armContinuationWatchdog(state, adopted);
}

function dispatchLine(state: SessionState, line: string): void {
  // Any JSONL line reaching us at all is proof claude accepted the
  // last-pasted message as a real turn (an unknown-slash-command rejection
  // never writes one) — disarm the lookout so a later, unrelated pane match
  // can't misfire against a stale token.
  state.pendingSlashToken = null;
  let evt: ParsedJsonlEvent;
  try {
    evt = JSON.parse(line);
  } catch (e) {
    const handler = state.turnQueue[0]?.onChunk ?? state.lastChunk;
    handler?.("stderr", `jsonl parse error: ${(e as Error).message}`);
    return;
  }
  const rawUuid = typeof evt.uuid === "string" ? evt.uuid : undefined;
  // queue-operation notification lines carry `uuid: null` by design (claude
  // 2.1.x's PRIMARY shape for a background command/agent completion — see
  // `taskNotificationContent`). A falsy uuid never satisfies the
  // seenLineUuids replay guard below (nor `maybeAdoptContinuation`'s copy of
  // it), so a boot reattach replaying the JSONL from offset 0 would
  // re-dispatch the SAME notification as if it were brand new: a second,
  // phantom continuation run gets adopted, and the breadcrumb double-persists
  // into run_events (its uuid:undefined third onChunk arg defeats both the
  // in-memory dedup and the DB's `(run_id, line_uuid)` partial unique index).
  // Deriving a deterministic stand-in from the notification's own content
  // closes both holes with one key, computed once here and threaded through:
  // this dedup check, `maybeAdoptContinuation`'s replay guard, and (via
  // `mapParsedEventToChunks`, which independently derives the identical value
  // from `evt.content`) the persisted `run_events.line_uuid`.
  const notifContent = taskNotificationContent(evt);
  const uuid = rawUuid ?? (notifContent ? syntheticNotificationUuid(notifContent) : undefined);

  // Mirror the latest mode-bearing JSONL event into SessionState. `user`
  // lines are a fallback signal for `lastAnnouncedPermissionMode` only —
  // claude stamps `permissionMode` on every `user` line too, not just the
  // dedicated `system`/`permission-mode` marker lines — but they do NOT
  // write `state.permissionMode` itself (see the split below). IMPORTANT:
  // this update MUST stay above the seenLineUuids early-return. On reattach
  // the dedup set is pre-seeded from run_events, so every replayed line —
  // including mode events the prior process recorded — would otherwise be
  // silently skipped and both fields would stay null.
  //
  // Captured BEFORE the mirror writes the new value so the mapper call below
  // can compare "what the event says" against "what we last announced" and
  // suppress a same-mode repeat (see `mapParsedEventToChunks`'s
  // `lastPermissionMode` param). Deliberately read from
  // `lastAnnouncedPermissionMode`, NOT `permissionMode`: `permissionMode` can
  // also be written by `cycleToModeInner`'s pane-scrape verification when the
  // USER switches modes via Shift+Tab, which happens before claude journals
  // the corresponding JSONL line. Using `permissionMode` here would make that
  // pane-scrape write look like "already announced" and suppress the
  // legitimate confirmation chip once the JSONL line does arrive.
  // `lastAnnouncedPermissionMode` is written only from JSONL lines (below and
  // at the launch/reattach seed), so it always tracks what was actually
  // announced.
  const prevAnnouncedPermissionMode = state.lastAnnouncedPermissionMode;
  if (typeof evt.permissionMode === "string") {
    if (evt.type === "system" || evt.type === "permission-mode") {
      // Only the dedicated marker lines may write `state.permissionMode` —
      // it's load-bearing for `cycleToModeInner`'s Shift+Tab cycle counting,
      // and can also be written by pane-scrape verification BEFORE claude
      // journals the corresponding JSONL line (see that function). A `user`
      // line reporting the OLD mode can lag behind a pane-verified mode
      // change (JSONL writes aren't synchronous with the pane), so letting a
      // `user` line write `state.permissionMode` here would let it clobber a
      // fresher pane-verified value back to the stale one.
      state.permissionMode = evt.permissionMode;
      state.lastAnnouncedPermissionMode = evt.permissionMode;
    } else if (evt.type === "user") {
      // Fallback signal only: advance the announce-tracker (so the chip dedup
      // above stays correct) but never `state.permissionMode` itself.
      state.lastAnnouncedPermissionMode = evt.permissionMode;
    }
  }

  // Staging step: the new line either confirms or cancels the pending end_turn.
  // This must run before the dedup check so replayed lines also drive staging.
  if (state.pendingEndTurn) {
    if (isEndTurnContinuation(evt, state.pendingEndTurn.messageId)) {
      // Same message still going, or tool_result for a tool_use in that
      // message → the staged end_turn was spurious. Discard it.
      state.pendingEndTurn = null;
    } else if (state.holdUntilIdle) {
      // We're folding follow-ups into the active run: a new turn starting here
      // is claude beginning to answer a folded message, not the end of the
      // busy period. Keep the staged end_turn (and the slot) alive so the run
      // stays "running" — the task must not bounce to `review` between folded
      // turns. Resolution is deferred to the idle-fire in `flush`, which pops
      // the slot only once claude has been quiet for END_TURN_IDLE_FIRE_MS.
      // (Keeping the pending staged rather than discarding it means a trailing
      // metadata event after the *final* end_turn can't strand the run — the
      // idle-fire still has a pending to resolve.)
    } else {
      // Something unrelated started → the previous turn truly ended. Fire.
      firePendingEndTurn(state);
    }
  }

  // Continuation adoption: this line is provably NEW (`maybeAdoptContinuation`
  // reproduces the dedup guard itself, since it runs above the early-return
  // below). Runs BEFORE the background-task settle block on purpose: the
  // settle block can release a held task via `maybeReleaseHeldTask`, and if
  // this is a task-notification line that both settles the last background
  // agent AND is itself the continuation trigger, adopting first means the
  // orchestrator's release check sees `task.runId` already pointing at a
  // running continuation run and bails — no `review` flicker before the
  // card snaps back to `running`. See `maybeAdoptContinuation` for the full
  // eligibility rules (content OR task-notification, plus the watchdog it
  // arms for the notification case).
  maybeAdoptContinuation(state, evt, uuid, notifContent);

  // Background-task/agent settle signal. Deliberately runs BEFORE the dedup
  // early-return below (unlike `maybeAdoptContinuation` just above, which
  // must NOT fire on replayed lines): a reattach replay (offset-0 re-read
  // after an agetor restart) may be the only chance to learn that a
  // background agent settled while the process was down, and the consumer
  // (`subagents.markSettledById`) is idempotent, so re-firing for an
  // already-seen line is harmless.
  //
  // Skipped for the synthetic `__rebuild__` state (see `rebuildEventsFromJsonl`):
  // that helper's contract is a read-only re-emission of a finished session's
  // JSONL for a UI replay, not a second live tailer. `markSettledById` keys
  // on agentId alone with no taskId scoping, so firing here would settle a
  // REAL subagent/background-task row from a request that never touched a
  // live session — e.g. a rebuild racing a genuine resume could release a
  // hold the live tailer still needs. Mirrors how `maybeAdoptContinuation`
  // just above is naturally inert for `__rebuild__` (its factory looks the
  // taskId up and finds no such task; and `rebuildEventsFromJsonl` seeds a
  // permanently non-empty `turnQueue`, which fails the empty-queue
  // eligibility check on its own), just made explicit here since this block
  // runs unconditionally rather than through a factory.
  if (state.taskId !== "__rebuild__") {
    if (notifContent) {
      const agentId = extractTaskNotificationAgentId(notifContent);
      if (agentId) {
        const lineTs = typeof evt.timestamp === "string" ? Date.parse(evt.timestamp) : NaN;
        fireBackgroundTaskSettled(state.taskId, agentId, notifContent, Number.isFinite(lineTs) ? lineTs : null);
      }
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

  // Mirror the most recent `<command-name>…</command-name>` line's own
  // command token AND raw args into `state.lastLocalCommandName` /
  // `lastLocalCommandArgs` — the identity half of the local-command settle
  // gate below, plus the payload the local-setting-sync seam (just below)
  // forwards to the orchestrator. Unconditional (not gated on the head slot
  // at all): a foreign local command mirrored in via `sendSlashCommand`
  // (which pushes no slot) or folded into an in-flight turn via
  // `pasteFollowUp` (which carries that turn's ORIGINAL slot) must still
  // update this, since it's exactly the case the gate exists to catch. A
  // stdout line itself never matches `parseLocalCommandLine`'s shape, so
  // this is a no-op on the very line the seam below reads these fields for
  // — they retain whatever the command's own preceding `<command-name>`
  // line set.
  const localCommandLine = parseLocalCommandLine(evt);
  if (localCommandLine !== null) {
    state.lastLocalCommandName = localCommandLine.name;
    state.lastLocalCommandArgs = localCommandLine.args;
  }

  // Local-setting sync seam — independent of the settle-staging branch
  // further down (which additionally gates on `slot.slashCommand`): fires
  // for a `/model`/`/effort` command's own `<local-command-stdout>` line
  // regardless of turn-slot identity, because the paths that most need this
  // signal are exactly the ones with no matching (or no) slot — the
  // dropdown mirror (`sendSlashCommand`) pushes no slot at all, and a
  // command folded into an in-flight turn via `pasteFollowUp` carries a
  // FOREIGN slot. Gating this on `slot.slashCommand` the way the settle
  // branch does would silently drop those. Never fires for any other local
  // command (`/cost`, …) — only `/model` and `/effort` carry a task setting
  // to sync. Skipped on the synthetic `__rebuild__` replay state for the
  // same reason `fireBackgroundTaskSettled` is gated above: a read-only
  // JSONL replay for the UI must not re-apply a setting change that already
  // landed when the run was live (and a REAL reattach's seen-uuid replay
  // never reaches this point at all — see the early return above).
  if (
    state.taskId !== "__rebuild__"
    && isLocalCommandStdoutEvent(evt)
    && (state.lastLocalCommandName === "/model" || state.lastLocalCommandName === "/effort")
  ) {
    fireLocalSettingChanged(state.taskId, {
      setting: state.lastLocalCommandName === "/model" ? "model" : "effort",
      args: state.lastLocalCommandArgs ?? "",
      stdout: extractLocalCommandStdout(evt),
      // Snapshot "agetor's own model mirror drove this" AT DISPATCH TIME —
      // the closest moment to claude's own report we have. Only the
      // orchestrator's `Kept model as` branch reads it; see
      // `SessionState.lastModelMirrorAt` for why a user-driven bare `/model`
      // + Esc must never sync the row.
      viaMirror: Date.now() - state.lastModelMirrorAt < MODEL_MIRROR_ATTRIBUTION_MS,
    });
  }

  const slot = state.turnQueue[0];
  // A real content line reaching the adopted (still-active) turn means
  // claude genuinely continued — the notification-triggered watchdog, if
  // any, no longer needs to fire. Gated on slot identity: the watchdog is
  // only ever armed for the current queue head (adoption always pushes to
  // an empty queue), so this is really just "is a watchdog armed at all",
  // spelled out defensively rather than assumed.
  if (state.continuationWatchdog && state.continuationWatchdog.slot === slot && isContinuationContentEvent(evt)) {
    clearContinuationWatchdog(state);
  }
  // Active turn → its handler. No active turn → fall back to the most
  // recently popped slot's handler so trailing metadata still reaches the
  // correct run. If neither exists it's safe to drop.
  const onChunk: ChunkHandler = slot?.onChunk ?? state.lastChunk ?? (() => {});
  const { endOfTurn } = mapParsedEventToChunks(evt, onChunk, false, prevAnnouncedPermissionMode);
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
  } else if (
    slot?.slashCommand
    && slot.slashCommand === state.lastLocalCommandName
    && isLocalCommandStdoutEvent(evt)
  ) {
    // Local-command settle: a local command's `<local-command-stdout>` line
    // is its OWN terminal signal — no assistant/end_turn line ever follows
    // one (see `isLocalCommandStdoutEvent`'s doc). Gated on TWO independent
    // identity checks, not merely "a slash command appeared somewhere":
    //   1. the HEAD SLOT's OWN prompt (`TurnSlot.slashCommand`, set at the
    //      turn's push site via `slashTokenOf`) must itself be a slash
    //      command — a turn whose own prompt wasn't one (`slashCommand:
    //      null`) can never settle here at all.
    //   2. that slot's `slashCommand` must equal `state.lastLocalCommandName`
    //      — the command token parsed off the MOST RECENT `<command-name>…
    //      </command-name>` line this session has seen (`parseLocalCommandLine`,
    //      mirrored a few lines up in this function). This is what actually
    //      rules out the wrong-turn case check (1) alone can't: a task whose
    //      OWN prompt began with `/` (e.g. `/implement …`, `/code-review`) is
    //      a real in-flight turn with `slot.slashCommand` set, and a FOREIGN
    //      local command injected mid-turn — the config-mirror
    //      `sendSlashCommand` (pushes no slot) or a folded `/effort x` via
    //      `pasteFollowUp` (carries the ORIGINAL turn's slot) — must not be
    //      able to settle it early just because that slot's own prompt
    //      happened to start with a slash too. Requiring the NAMES to match
    //      closes that hole: `/implement` !== `/effort` fails check 2 and
    //      nothing stages, while a genuine `/effort x` turn (slot.slashCommand
    //      === "/effort") whose own command-name line just confirmed
    //      "/effort" satisfies both.
    // Reuses the existing confirm-or-idle-fire machinery unchanged: the next
    // line fires this staged pending unless `isEndTurnContinuation` says
    // otherwise (moot in practice — a local command's stdout is never a
    // same-message continuation target), and `flush`'s idle-fire after
    // END_TURN_IDLE_FIRE_MS closes it out when the stdout line is the last
    // thing written. No "turn complete" banner — there's nothing to divide
    // from; the user just watched the command's own output print inline
    // (contrast `signalIdleSettle`, which DOES emit one, since that settle is
    // agetor's own judgment call, not visible in claude's output).
    state.pendingEndTurn = {
      messageId: null,
      uuid,
      emitBanner: false,
      stagedAt: Date.now(),
    };
    // This command has now been accounted for — clear so a LATER, unrelated
    // local command in the same session can't match against a stale name.
    state.lastLocalCommandName = null;
    state.lastLocalCommandArgs = null;
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
    // slashCommand: null — a read-only replay of a finished session's JSONL
    // has no "current prompt" of its own to gate a settle on.
    turnQueue: [{ onChunk, resolve: null, reject: null, slashCommand: null }],
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
 *
 * DELIBERATELY KEPT SYNC (docs/plans/fix-task-details-load-delay.md T1) — this
 * is the one sync fs read this file's async conversion left in place, and it's
 * a correctness requirement, not an oversight. `flush()`'s own race guard
 * (`if (state.offset !== startOffset) return;`, see its comment) only works
 * because a call to THIS function is atomic with respect to the event loop:
 * it runs `fsStatSync`/`fsOpenSync`/`fsReadSync`/`fsCloseSync` back-to-back
 * with no `await` in between, so no other flush of the same `state.offset`
 * can interleave mid-read. Rewriting it on top of `fs/promises` (mirroring
 * `readAppended`) would reopen exactly the double-dispatch race `flush`'s
 * guard exists to close — two overlapping reads of the same byte range, each
 * independently advancing `state.offset` and re-dispatching lines, with a
 * trailing `end_turn` capable of popping the wrong turn slot. Closing that
 * race for real needs a shared in-flight guard both `flush` and this function
 * check *before* their first read (not just after, the way `flush` does now)
 * — restructuring beyond a same-file, same-task conversion, so it's left for
 * a follow-up rather than risked here.
 *
 * The blocking cost this leaves behind is bounded, not unbounded: unlike the
 * tmux spawns this task converts (one full process fork+exec per call) or the
 * SSE replay query (sorts a task's ENTIRE event history), `flushSync` only
 * reads the bytes appended to the JSONL since `state.offset` — normally a
 * single turn's worth of new lines, a few KB at most — via a plain sync
 * stat+read, not a subprocess. That's exactly the class of "µs-scale syscall"
 * the file's own `fileWrittenWithin` comment calls out as fine to leave sync.
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
  // JSONL bytes appended is the primary "session is alive" signal — feeds
  // the reaper's idle clock (`sessionIdleInfo`) and the pollTimer's own
  // idle backoff below.
  bumpActivity(state);
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
  /** Which arrow-key pair `dismissTmuxPrompt` presses to walk the cursor
   *  from `cursorIndex` to the chosen index. `undefined` ⇒ `"vertical"`
   *  (`Down`/`Up` — every numbered/yes-no modal). `"horizontal"` ⇒
   *  `Right`/`Left` — claude 2.1.245's `/effort` slider, which reads
   *  "←/→ to adjust · Enter to confirm" (`matchSliderModal`). Threaded
   *  through `registerTmuxPrompt` → `TmuxPromptRequest.nav` (interactions.ts)
   *  → the server route → `dismissTmuxPrompt`'s `ctx.nav`. */
  nav?: "vertical" | "horizontal";
  /** Stable hash that survives across consecutive scrapes as long as the
   *  modal stays on screen unchanged. */
  fingerprint: string;
  /** True when the match is bounded by a real modal footer (`Esc to cancel …`),
   *  which printed numbered output never has. Lets `scrapeOnce` register on the
   *  first sighting and skip the two-tick stability gate, so tool-use permission
   *  prompts appear promptly. */
  highConfidence?: boolean;
  /** True when this is the last-resort fallback match (`matchUnparsableModal`) —
   *  a modal-shaped or stuck-turn pane no real matcher parsed. `choices` is
   *  always empty; the UI renders a "read it in the terminal" card instead of
   *  choice buttons. Deliberately never paired with `highConfidence` — see
   *  `matchUnparsableModal`. */
  unparsable?: boolean;
  /** Key that confirms the highlighted choice when it isn't Enter.
   *  `undefined` ⇒ Enter, the default for every modal. Set by
   *  `matchNumberedModal` when the footer itself advertises an alternate
   *  confirm keystroke — today only claude 2.1.245's bare `/model` picker,
   *  whose footer reads `Enter to set as default · s to use this session
   *  only · Esc to cancel` (docs/plans/model-effort-local-command-turns.md
   *  §2, §8 Q6). Evidence-gated and generic: any future modal whose footer
   *  matches `SESSION_ONLY_CONFIRM_RE` gets the same treatment, with no
   *  `/model`-specific branch anywhere in the matcher or the dismissal path.
   *  Threaded through `registerTmuxPrompt` → `TmuxPromptRequest.confirmKey`
   *  (interactions.ts) → the server route → `dismissTmuxPrompt`'s
   *  `ctx.confirmKey`, which sends it in place of Enter on the arrow-nav
   *  path. */
  confirmKey?: string;
}

/**
 * Matches a modal footer that offers a session-only confirm alongside the
 * default Enter — verbatim from claude 2.1.245's bare `/model` picker
 * (docs/plans/model-effort-local-command-turns.md §2, §8 Q6):
 * `Enter to set as default · s to use this session only · Esc to cancel`.
 * A card click through agetor answers a modal on the user's behalf while
 * they're not watching the TUI; confirming with plain Enter there would
 * rewrite the user's *global* claude default model, a side effect the user
 * never asked for by clicking a card. `s` scopes the change to the live
 * session instead — `task.model` still syncs from claude's own
 * `<local-command-stdout>` line regardless of which key confirmed the
 * picker (`applyClaudeLocalSetting`), so agetor's own bookkeeping doesn't
 * depend on this choice.
 *
 * Deliberately generic (matches the footer text, not "is this the /model
 * picker") so a future claude version that offers the same session-only
 * escape hatch on some other modal is covered without a new branch.
 */
const SESSION_ONLY_CONFIRM_RE = /\bs to use this session only\b/;

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
  const numbered: Array<{ key: string; label: string; cursorHere: boolean; lineIndex: number }> = [];
  lines.forEach((raw, idx) => {
    const m = raw.match(/^\s*([›❯])?\s*(\d+)\.\s+(.+?)\s*$/);
    if (!m) return;
    numbered.push({
      cursorHere: !!m[1],
      key: m[2]!,
      label: m[3]!.trim(),
      lineIndex: idx,
    });
  });
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
  // claude's choice modals are always 1-indexed. A tool-use permission prompt
  // wraps the tool's description across lines, e.g.
  //   … keep fetching while remaining >
  //   0. Use the offset arg to paginate.
  // The phantom "0." row is numerically contiguous with the real "1." option,
  // so the trailing-run walk above swallows it as choice 0 (and shifts the
  // cursor index by one). Anchor the run to the real "1." option: drop any
  // leading rows that precede it. No "1." at all means this isn't a claude
  // choice modal.
  const oneAt = tailRun.findIndex((n) => n.key === "1");
  if (oneAt < 0) return null;
  if (oneAt > 0) tailRun.splice(0, oneAt);
  if (tailRun.length < 2) return null;
  // Cursor MUST land inside tailRun for the modal to be dismissible —
  // otherwise the `❯` is on a printed list above the actual choice set
  // (we'd send arrow keys into a phantom selector). Bail rather than
  // register a half-known modal.
  const cursorIndex = tailRun.findIndex((n) => n.cursorHere);
  if (cursorIndex < 0) return null;
  // Fold wrapped continuation rows into each option's label. claude wraps a
  // long choice (e.g. "… don't ask again … commands in <worktree path>") across
  // pane rows; only the first row carries the "N." prefix, so without this the
  // label truncates mid-sentence and the user can't see, say, which directory a
  // "don't ask again" scope applies to. An option owns the rows between it and
  // the next option, stopping at a blank line or the footer.
  //
  // A continuation row must be indented PAST its option's own indent: claude
  // aligns wrapped text under the option label (past the "N." marker), so a
  // genuine wrap is always more indented. This keeps a same-indent standalone
  // hint line under the LAST option (which, unlike middle options, isn't capped
  // by a following numbered row) from being absorbed into its label.
  const indentOf = (l: string): number => (l.match(/^[ \t]*/)?.[0].length ?? 0);
  const choices: TmuxPromptChoice[] = tailRun.map((n, i) => {
    const end = i + 1 < tailRun.length ? tailRun[i + 1]!.lineIndex : lines.length;
    const optIndent = indentOf(lines[n.lineIndex]!);
    const extra: string[] = [];
    for (let j = n.lineIndex + 1; j < end; j++) {
      const l = lines[j]!;
      if (l.trim().length === 0) break;            // blank line ends the option
      if (/Esc to cancel/.test(l)) break;          // footer ends the option
      if (/^\s*([›❯])?\s*\d+\.\s+/.test(l)) break;  // next numbered row (defensive)
      if (indentOf(l) <= optIndent) break;         // not a wrap — a sibling line
      extra.push(l.trim());
    }
    return { key: n.key, label: extra.length ? `${n.label} ${extra.join(" ")}` : n.label };
  });
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
  // A trailing `Esc to cancel …` footer marks a fully-drawn interactive modal
  // (the tool-use permission prompt, edit/plan dialogs, …). Streamed numbered
  // *output* never carries it, so its presence lets the scraper register on the
  // first sighting instead of waiting out the two-tick stability gate — this is
  // what makes tool-use asks surface promptly rather than ~2s late. (The
  // AskUserQuestion modal also has this footer but is routed away from here by
  // `detectAskModal` before we're ever called.)
  //
  // Test the last couple of NON-BLANK lines, not a fixed `slice(-N)` of raw
  // lines: `tmux capture-pane` can emit trailing blank rows (this is exactly
  // why `parseAskModal` strips them), which would otherwise push the footer out
  // of a raw-line window and silently disable the fast path. A real modal's
  // footer is always the last non-blank line; restricting to the last two keeps
  // a stray "Esc to cancel" buried mid-output from falsely qualifying.
  const nonBlank = lines.filter((l) => l.trim().length > 0);
  const highConfidence = nonBlank.slice(-2).some((l) => /Esc to cancel/.test(l));
  // Session-only confirm affordance (see `SESSION_ONLY_CONFIRM_RE`): a wider
  // window than the high-confidence check above (3 lines, not 2) since this
  // isn't anchored to being the very last row, only near the bottom of the
  // modal. Evidence-gated on the footer text alone — no check for "is this
  // the /model picker" anywhere here, so any future modal with the same
  // session-only escape hatch is covered automatically. Deliberately not
  // folded into `fingerprint`: it describes the footer's affordance, not the
  // choice set, so it must not bust the stability gate on its own.
  const confirmKey = nonBlank.slice(-3).some((l) => SESSION_ONLY_CONFIRM_RE.test(l)) ? "s" : undefined;
  return { paneText, choices, cursorIndex, fingerprint, highConfidence, confirmKey };
}

/** Decide whether a scrape match has cleared the stability gate this tick.
 *  A high-confidence match (bounded by a real `Esc to cancel …` modal footer,
 *  which streamed numbered output never carries) registers on first sighting,
 *  so tool-use permission prompts surface promptly instead of ~2s late. Every
 *  other match must be seen on two consecutive scrapes — the previous tick's
 *  fingerprint must equal this one — which rejects single-tick blips from a
 *  numbered list the agent is printing. Pure so the gate is unit-testable
 *  without a live tmux session. */
function clearedStabilityGate(match: ScrapeMatch, prevFingerprint: string | null): boolean {
  return !!match.highConfidence || prevFingerprint === match.fingerprint;
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

/** Track-line shape of claude 2.1.245's bare `/effort` slider — a run of
 *  `─`/`┆` characters with exactly one `▲` cursor marker, captured verbatim:
 *  `──────────────────────────────▲────────────┆──────────────────`
 *  (docs/plans/model-effort-local-command-turns.md §2). The character class
 *  on either side of the `▲` excludes `▲` itself, so a second marker on the
 *  same line fails the whole-line match — "exactly one `▲`" falls out of the
 *  regex shape rather than needing a separate count check. */
const SLIDER_TRACK_RE = /^\s*[─┆]*▲[─┆]*\s*$/;

/** Minimum number of `─`/`┆` track characters a `SLIDER_TRACK_RE` match must
 *  carry to count as a real slider track, rather than a lone `▲` glyph on its
 *  own line — the regex's `*` quantifiers happily match zero of either
 *  character, so without this a bare `▲` (a stray render artifact, or a
 *  future claude widget using the same cursor glyph) would satisfy signal
 *  (a) below on its own. The real captured track runs ~60 characters wide
 *  (docs/plans/model-effort-local-command-turns.md §2); 10 is comfortably
 *  below that while still ruling out a near-empty line. */
const SLIDER_TRACK_MIN_CHARS = 10;

/** Footer claude's slider draws below the label row — captured verbatim as
 *  `←/→ to adjust · Enter to confirm · Esc to cancel` (plan §2). One of the
 *  slider matcher's four required, independent signals (plan §3.4/§7). */
const SLIDER_FOOTER_RE = /←\/→ to adjust/;

/** Bound on how many non-blank lines below the track `matchSliderModal`
 *  will look for the label row (docs/plans/model-effort-local-command-
 *  turns.md §10 review finding #5). The captured layout has the label row
 *  immediately below the track (distance 1); 2 is slack, not tight. */
const LABEL_ROW_SEARCH_NONBLANK = 2;

/** Bound on how many non-blank lines below the LABEL ROW `matchSliderModal`
 *  will look for the footer (signal c, finding #5) — an ADDITIONAL
 *  requirement layered on top of (not a replacement for) the "last 3
 *  non-blank lines of the whole tail" check (signal d): anchoring to the
 *  label row is what keeps the footer tied to THIS slider's own widget
 *  rather than any `←/→ to adjust` text elsewhere in the pane; the
 *  whole-tail check is what confirms the widget is still live at the
 *  bottom of the pane, not stale scrollback. See `matchSliderModal`'s doc
 *  for the two distinct echo shapes each half defeats. Captured layout:
 *  labels / `xhigh + workflows` sub-row / blank / footer — the blank row
 *  doesn't count toward `nonBlankSeen`, so the footer is only the 2ND
 *  non-blank line below the label row (finding #11d, §10 re-review: this
 *  used to claim "3 non-blank lines … lands exactly on the footer", which
 *  double-counted the blank row), one line of slack short of this bound. */
const FOOTER_SEARCH_NONBLANK = 3;

/**
 * Recognise claude 2.1.245's bare `/effort` slider widget — captured
 * verbatim (docs/plans/model-effort-local-command-turns.md §2):
 *
 *   Effort
 *
 *                              Faster                                                 Smarter
 *                              ──────────────────────────────▲────────────┆──────────────────
 *                              low     medium     high     xhigh      max       ultracode
 *                                                                           xhigh + workflows
 *
 *    ←/→ to adjust · Enter to confirm · Esc to cancel
 *
 * (cursor on `xhigh` at `▲` column 59; a second capture with the `▲` at
 * column 49 lands on `high`). Unlike `matchNumberedModal`, there is no
 * numbered text on screen at all — the effort levels are read off the label
 * row beneath the track and keyed `"1".."N"` positionally so the existing
 * generic tmux_prompt card can render them as ordinary buttons; clicking one
 * drives `dismissTmuxPrompt` through its horizontal nav (`nav: "horizontal"`
 * below) instead of the default vertical Down/Up.
 *
 * Four independent signals, ALL required — mirrors the discipline of
 * `matchUnparsableModal`'s footer/watchdog arms, where a single loose signal
 * would risk matching ordinary transcript output (docs/plans/model-effort-
 * local-command-turns.md §10 review finding #5, corrected after an initial
 * pass dropped signal (d) and regressed the echo case below):
 *   (a) a track line matching `SLIDER_TRACK_RE` (exactly one `▲`) that ALSO
 *       carries at least `SLIDER_TRACK_MIN_CHARS` track characters — rules
 *       out a lone `▲` glyph on its own line, which the regex alone would
 *       accept — searched from the bottom of the tail so a stale frame
 *       further up a long pane can't win over a live one (same tail-anchored
 *       posture every other matcher here takes);
 *   (b) a label row of at least two tokens matching `[a-z][a-z0-9+]*`,
 *       separated by at least two spaces, found within the next
 *       `LABEL_ROW_SEARCH_NONBLANK` (2) NON-BLANK lines below the track —
 *       the sub-label row under the last entry (`xhigh + workflows`) sits on
 *       a DIFFERENT, later line and is never consulted;
 *   (c) a footer matching `SLIDER_FOOTER_RE` within `FOOTER_SEARCH_NONBLANK`
 *       (3) non-blank lines BELOW THE LABEL ROW found in (b) — anchored to
 *       THIS slider's own label row, not just anywhere in the pane;
 *   (d) that SAME footer line (the exact one (c) found, tracked by line
 *       index) is ALSO one of the last 3 non-blank lines of the WHOLE
 *       tail — i.e. the widget is genuinely sitting at the bottom of the
 *       pane right now, not stale scrollback.
 * The captured layout is track / labels / `xhigh + workflows` sub-row /
 * blank / footer, so (b), (c), and (d) all hold with slack against the
 * measured evidence for a real, live slider.
 *
 * (c) and (d) are deliberately independent checks, not one merged "footer
 * near the bottom" test, because each defeats a DIFFERENT stale-echo shape:
 *   - An OLD slider echo (complete with its own label + footer) sitting in
 *     scrollback, followed by more transcript and then an idle input box:
 *     (c) alone would still match — the echo's own footer is right there,
 *     within `FOOTER_SEARCH_NONBLANK` lines of the echo's own label row.
 *     (d) is what rejects it: that footer is buried under whatever now
 *     follows it, so it is NOT among the tail's last 3 non-blank lines.
 *   - An OLD echo sitting ABOVE a LIVE slider whose track has since
 *     scrolled off the top of the captured tail (so only the live label +
 *     footer are still visible, no `▲` track for them): the bottom-up track
 *     search in (a) falls back to the echo's stale track line (the only one
 *     left in view), and the live footer legitimately IS in the tail's last
 *     3 non-blank lines — so (d) alone would wrongly pass. (c) is what
 *     rejects it: the live footer sits far below the STALE label row (b)
 *     found for the stale track, well outside `FOOTER_SEARCH_NONBLANK`
 *     lines — so this returns null and correctly falls through to
 *     `matchUnparsableModal` instead of fabricating a card for a widget
 *     whose actual track is no longer visible to drive against.
 *
 * `cursorIndex` is the label whose horizontal centre column is nearest the
 * `▲` column (ties broken toward the lower index via strict `<`) — the `▲`
 * sits between labels far more often than exactly under one, so "nearest"
 * is what makes the mapping stable across every discrete slider position.
 * `highConfidence: true`: unlike `matchNumberedModal`'s footer fast-path
 * (extra confidence layered on an already-parsed choice set), the footer
 * here (signals c/d together) is a REQUIRED condition for a match to exist
 * at all, so a first sighting is already as trustworthy as a stable one —
 * same reasoning `matchUnparsableModal`'s doc gives for why IT is never
 * `highConfidence`, applied in the opposite direction. `nav: "horizontal"`
 * is what tells `dismissTmuxPrompt` to send `Right`/`Left` instead of
 * `Down`/`Up`.
 */
function matchSliderModal(tail: string): ScrapeMatch | null {
  const lines = tail.split("\n");

  // (a) Track line. A candidate must ALSO clear SLIDER_TRACK_MIN_CHARS — a
  // lone `▲` satisfies SLIDER_TRACK_RE on its own but isn't a real track —
  // so a too-short line is skipped rather than accepted, letting the
  // bottom-up search keep looking further up the pane for a genuine one.
  let trackIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!SLIDER_TRACK_RE.test(line)) continue;
    const trackChars = (line.match(/[─┆]/g) ?? []).length;
    if (trackChars < SLIDER_TRACK_MIN_CHARS) continue;
    trackIdx = i;
    break;
  }
  if (trackIdx < 0) return null;
  const arrowCol = lines[trackIdx]!.indexOf("▲");
  if (arrowCol < 0) return null; // unreachable — SLIDER_TRACK_RE guarantees one

  // (b) Label row — search up to LABEL_ROW_SEARCH_NONBLANK non-blank lines
  // below the track for one shaped like a label row, rather than assuming
  // the very next non-blank line is it. The captured layout has it
  // immediately below (distance 1), so this bound is slack, not tight.
  let labelIdx = -1;
  let tokens: string[] = [];
  {
    let nonBlankSeen = 0;
    for (let i = trackIdx + 1; i < lines.length && nonBlankSeen < LABEL_ROW_SEARCH_NONBLANK; i++) {
      if (lines[i]!.trim().length === 0) continue;
      nonBlankSeen++;
      const candidateTokens = lines[i]!.split(/\s{2,}/).map((s) => s.trim()).filter((s) => s.length > 0);
      if (candidateTokens.length >= 2 && candidateTokens.every((t) => /^[a-z][a-z0-9+]*$/.test(t))) {
        labelIdx = i;
        tokens = candidateTokens;
        break;
      }
    }
  }
  if (labelIdx < 0) return null;
  const labelLine = lines[labelIdx]!;
  // Column of each label's start on the label line, walked left-to-right so
  // the search-from cursor always advances past the token just found.
  const labels: Array<{ label: string; start: number }> = [];
  let searchFrom = 0;
  for (const t of tokens) {
    const idx = labelLine.indexOf(t, searchFrom);
    if (idx < 0) return null; // unreachable — every token came from this line
    labels.push({ label: t, start: idx });
    searchFrom = idx + t.length;
  }

  // (c) Footer within FOOTER_SEARCH_NONBLANK non-blank lines BELOW THE LABEL
  // ROW (finding #5) — anchoring to the label row is what keeps this signal
  // about THIS slider's own footer, not any `←/→ to adjust` text that
  // happens to sit near it. Tracked by absolute line index (not just found-
  // or-not) because (d) below needs to check THIS specific line, not merely
  // that some line in the window matched.
  let footerIdx = -1;
  {
    let nonBlankSeen = 0;
    for (let i = labelIdx + 1; i < lines.length && nonBlankSeen < FOOTER_SEARCH_NONBLANK; i++) {
      if (lines[i]!.trim().length === 0) continue;
      nonBlankSeen++;
      if (SLIDER_FOOTER_RE.test(lines[i]!)) { footerIdx = i; break; }
    }
  }
  if (footerIdx < 0) return null;

  // (d) That SAME footer line must ALSO be one of the last 3 non-blank lines
  // of the WHOLE tail — i.e. the widget is genuinely at the bottom of the
  // pane right now, not stale scrollback. (c) alone would still match an old
  // slider echo sitting above an idle input box (its own footer is right
  // there, within 3 non-blank lines of its own label row); (d) is what
  // rejects that, since the echo's footer is buried under whatever now
  // follows it (an idle box, more transcript, …) and is therefore NOT among
  // the tail's last 3 non-blank lines. Conversely, (c) is what protects
  // against the opposite case — an old echo sitting ABOVE a live slider
  // whose track has since scrolled off the top of the captured tail: the
  // live footer legitimately IS in the last 3 non-blank lines, but it is not
  // within `FOOTER_SEARCH_NONBLANK` lines of the ECHO's label row, so (c)
  // returns null before (d) is ever reached — correctly falling through to
  // `matchUnparsableModal` rather than fabricating a card for a widget whose
  // track we can no longer see.
  const nonBlankIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().length > 0) nonBlankIdxs.push(i);
  }
  const last3Idxs = new Set(nonBlankIdxs.slice(-3));
  if (!last3Idxs.has(footerIdx)) return null;

  // Nearest-centre cursor mapping. Strict `<` keeps a tie on the lower index.
  let cursorIndex = 0;
  let bestDist = Infinity;
  labels.forEach((l, i) => {
    const center = l.start + l.label.length / 2;
    const dist = Math.abs(center - arrowCol);
    if (dist < bestDist) {
      bestDist = dist;
      cursorIndex = i;
    }
  });

  const choices: TmuxPromptChoice[] = labels.map((l, i) => ({ key: String(i + 1), label: l.label }));
  const paneText = lines.slice(-12).join("\n").trimEnd();
  const fingerprint = sha1(`slider:${labels.map((l) => l.label).join("/")}|@${cursorIndex}`);
  return { paneText, choices, cursorIndex, fingerprint, highConfidence: true, nav: "horizontal" };
}

/**
 * Footer phrasings claude's Ink modals draw. Every entry is evidence-backed —
 * a false hit here gates the user's composer, so this allow-list only carries
 * footers observed on a real pane: `esc to cancel` / `enter to confirm` from
 * the tool-permission and trust-folder fixtures in claude-tmux-scraper.test.ts,
 * `enter to continue` from the 2.1.234 auto-mode wizard footer
 * (`←/→ to change usage · Enter to continue · Esc to cancel`). Do not add a
 * phrasing without a captured pane to back it (plan §8); the stuck-turn
 * watchdog below is the version-proof net for whatever this list misses.
 */
const MODAL_FOOTER_RE = /esc to cancel|enter to confirm|enter to continue/i;

/** How long a turn can sit silent (no JSONL growth, no working spinner) before
 *  `matchUnparsableModal`'s watchdog arm treats it as stuck rather than just
 *  slow. A judgment call (plan §8), not empirically tuned — long enough that
 *  a genuinely slow tool call (a big `Bash` run, a large read) doesn't false-
 *  trip, short enough that a silently wedged TUI doesn't strand the task. */
const STUCK_TURN_FALLBACK_MS = 60_000;

/** Pure decision for the watchdog arm of `matchUnparsableModal` — exposed via
 *  `__forTest` so the in-flight/quiet/working/ask/idle truth table is unit-
 *  testable without a live tmux pane. True only when ALL of: a turn is
 *  actually in flight (there's a "running" run to protect), the session has
 *  written JSONL before (a `0` timestamp means we've never seen a turn
 *  start — nothing to be stuck on), it's been quiet past the threshold, the
 *  pane shows claude working (see `paneShowsClaudeWorking`) is FALSE (a
 *  long-running tool call, a background-agent wait, or a live shell is busy,
 *  not stuck — that chrome repaints even when no JSONL line has landed yet),
 *  no AskUserQuestion card/collection is already live (that path owns the
 *  pane and has its own give-up ladder, see `askFallbackAllowed`), and the
 *  pane is NOT idle at claude's input box (`paneShowsIdleInputBox`) — an idle
 *  input box is proof the turn is over, not a stuck/unparsable modal, so
 *  carding it would be wrong; `scrapeOnce`'s separate idle-settle net
 *  (`signalIdleSettle`) closes that case out instead. Signature kept honest
 *  about every input it's actually gated on, same posture as `paneWorking`. */
function stuckTurnFallbackArmed(p: {
  turnInFlight: boolean;
  lastJsonlAppendAt: number;
  now: number;
  paneWorking: boolean;
  askCardLive: boolean;
  paneIdle: boolean;
}): boolean {
  return p.turnInFlight
    && p.lastJsonlAppendAt !== 0
    && p.now - p.lastJsonlAppendAt > STUCK_TURN_FALLBACK_MS
    && !p.paneWorking
    && !p.askCardLive
    && !p.paneIdle;
}

/**
 * Last-resort fallback for a pane no other matcher parsed: strictly after
 * `matchNumberedModal`, `matchYesNoModal`, AND `matchSliderModal` have all
 * had a chance (both chain sites — the runtime scraper and the boot poller —
 * try this only once none of the three real matchers hit). What's left by
 * then is an unnumbered arrow-key widget, a free-text/device-code prompt, a
 * single-option modal (`matchNumberedModal` requires ≥2), a slider-shaped
 * pane missing one of `matchSliderModal`'s four required signals, a prose
 * confirmation, or a genuinely wedged turn. Registers a `tmux_prompt` with
 * empty `choices` — there's no keystroke this scraper can plan, so the UI's
 * job is just "tell the user to go answer it in the attached terminal", not
 * drive an answer back.
 *
 * Fires under either of two independent arms, both gated at the call site on
 * `!paneShowsClaudeWorking(tail)` (a real prompt/wizard replaces the working
 * chrome, so this can't hide a genuine one — see `paneShowsClaudeWorking`):
 *   (1) Footer arm — the last 3 NON-BLANK tail lines contain a recognised
 *       modal footer (`MODAL_FOOTER_RE`) AND none of those same lines is a
 *       usage-limit auto-continue notice (`MODAL_NOTICE_RE`) — claude resumes
 *       those on its own, nothing for the user to answer. Non-blank, not a
 *       fixed raw-line slice, because `tmux capture-pane` pads trailing blank
 *       rows (same reasoning as `matchNumberedModal`'s high-confidence check).
 *   (2) Watchdog arm — `watchdogArmed` (the caller pre-computes this via
 *       `stuckTurnFallbackArmed`, since it needs session state this pure
 *       matcher doesn't have).
 *
 * Deliberately never `highConfidence` (see `ScrapeMatch.unparsable`): unlike
 * `matchNumberedModal`'s footer fast-path, footer presence here IS the
 * trigger itself, not extra confidence layered on top of an already-parsed
 * choice set — so a single-tick sighting must not register a card. The caller
 * (`scrapeOnce`) holds this to `UNPARSABLE_STABILITY_TICKS` (3) consecutive
 * equal-fingerprint sightings, stricter than the generic two-tick gate —
 * skipping it would let a mid-repaint transient (a real modal's frame still
 * animating in, a paste in flight) flash a fallback card the user never
 * needed.
 *
 * The fingerprint is sha1 of the SAME trailing lines used for `paneText`
 * (not the full scrape tail), with blank lines and volatile chrome
 * (`VOLATILE_PANE_LINE_RE` — the spinner/token-count line, the rotating
 * "Tip:" banner) stripped first. This has to be stable tick-to-tick while
 * the same modal sits on screen, or the `__external__` auto-cancel sweep
 * (which resolves any registered prompt whose fingerprint no longer matches
 * the live pane) would kill its own card on every tick. The blank/volatile
 * filter runs BEFORE the trailing-window slice — a raw `slice(-12)` window
 * saturated by the modal would let a fluctuating trailing blank row or a
 * transient spinner line evict real content from the front and jitter the
 * hash, so the two-tick gate could never converge on exactly the tall
 * modals this matcher exists for.
 */
function matchUnparsableModal(tail: string, watchdogArmed: boolean): ScrapeMatch | null {
  const lines = tail.split("\n");
  const nonBlank = lines.filter((l) => l.trim().length > 0);
  const last3 = nonBlank.slice(-3);
  // The card's own window: the last 12 meaningful lines (blank + volatile
  // chrome stripped FIRST — see the fingerprint note above). Computed before
  // the arm logic because the notice veto below scans this same window.
  const paneLines = lines
    .map((l) => l.trimEnd())
    // Same treatment `normalizePaneForActivity` gives the status-bar row: the
    // right-hand `● high · /effort` hint flickers on 2.1.246, and a bar row
    // inside this window would otherwise jitter the fingerprint — which the
    // `__external__` sweep reads as "the prompt went away" and resolves the
    // card, only to re-register it on the next tick.
    .map(stripVolatileStatusBarHint)
    .filter((l) => l.length > 0 && !VOLATILE_PANE_LINE_RE.test(l))
    .slice(-12);
  // Usage-limit auto-continue notice (`continuing automatically/shortly · esc
  // to cancel`): claude resumes on its own, so there's nothing to card — veto
  // BOTH arms here, before the footer/watchdog split. A mid-turn limit pause
  // keeps the turn in flight and the pane quiet, so a footer-only veto would
  // still let the stuck-turn watchdog arm surface the notice as a card. The
  // veto scans the SAME 12-line window the card is built from, not just the
  // last 3 lines: claude draws notice-class lines in the hint slot ABOVE the
  // input box (observed 5 non-blank lines from the bottom for the weekly-limit
  // hint), which is outside the footer window but squarely inside the card's.
  // A genuinely wedged TUI never carries a `continuing …` line.
  if (paneLines.some((l) => MODAL_NOTICE_RE.test(l))) return null;
  const footerFires = last3.some((l) => MODAL_FOOTER_RE.test(l));
  if (!footerFires && !watchdogArmed) return null;

  const paneText = paneLines.join("\n");
  const fingerprint = sha1(`unparsable:${paneText}`);
  return { paneText, choices: [], cursorIndex: 0, fingerprint, unparsable: true };
}

/**
 * The matcher-chain union shared by BOTH call sites that need to turn a raw
 * pane tail into a `ScrapeMatch`: the runtime scraper (`scrapeOnce`) and the
 * boot poller's generic-modal branch — factored out (docs/plans/model-
 * effort-local-command-turns.md §10 review finding #9) so the two can't
 * silently drift apart, and so the precedence itself
 * (numbered > yes-no > slider > unparsable, gated on `paneWorking`) is
 * unit-testable without a live tmux pane.
 *
 * `watchdogArmed` is the caller's own `stuckTurnFallbackArmed` decision at
 * runtime; the boot poller always passes `false` — no turn is in flight yet
 * during boot, so only `matchUnparsableModal`'s FOOTER arm can ever fire
 * there, never its watchdog arm.
 */
function pickScrapeMatch(tail: string, opts: { paneWorking: boolean; watchdogArmed: boolean }): ScrapeMatch | null {
  return matchNumberedModal(tail) ?? matchYesNoModal(tail) ?? matchSliderModal(tail)
    ?? (opts.paneWorking ? null : matchUnparsableModal(tail, opts.watchdogArmed));
}

/**
 * Recognise claude 2.1.245's mid-conversation confirm modal for `/model` /
 * `/effort` — captured verbatim (docs/plans/model-effort-local-command-
 * turns.md §2), and pops only when the value actually changes AND an
 * assistant turn has run since the last switch:
 *
 *   Change effort level?
 *   Your next response will be slower and use more tokens
 *
 *   This conversation is cached for the current effort level. Switching to
 *   low means the full history gets re-read on your next message.
 *
 *   ❯ 1. Yes, switch to low
 *     2. No, go back
 *
 *   Switch model?
 *   Your next response will be slower and use more tokens
 *
 *   This conversation is cached for the current model. Switching to Opus 5
 *   means the full history gets re-read on your next message.
 *
 *   ❯ 1. Yes, switch to Opus 5
 *     2. No, go back
 *
 * Built ON `matchNumberedModal` (same footer-less numbered shape) rather
 * than re-parsing the pane from scratch, so any future tightening of that
 * matcher's choice/cursor extraction is inherited automatically. This is
 * `sendSlashCommand`'s auto-accept step, NOT the runtime/boot scrape chains —
 * `matchNumberedModal` itself still parses this pane there too, so the
 * confirm still shows up as an ordinary numbered `tmux_prompt` card for a
 * user-typed `/model`/`/effort` (plan §3.5/§7: "user-typed keeps relaying the
 * confirm as a normal numbered card").
 *
 * Requires ALL of, so this can never fire on an unrelated numbered modal (a
 * permission prompt's option 1 never reads "Yes, switch to ", and neither
 * header string appears anywhere else in claude's UI — plan §7):
 *   - `matchNumberedModal(tail)` matches at all;
 *   - exactly 2 choices;
 *   - the cursor is on choice 0 ("Yes, switch to …" is always claude's
 *     pre-selected default here);
 *   - choice 0's label starts with `Yes, switch to `;
 *   - a header line among the tail's trimmed non-blank lines equal to
 *     exactly `Switch model?` (kind `"model"`) or `Change effort level?`
 *     (kind `"effort"`) — anchored `^…\?$`, not a substring test.
 */
function matchSlashConfirmModal(tail: string, kind: "model" | "effort"): ScrapeMatch | null {
  const m = matchNumberedModal(tail);
  if (!m) return null;
  if (m.cursorIndex !== 0) return null;
  if (m.choices.length !== 2) return null;
  if (!/^Yes, switch to /.test(m.choices[0]!.label)) return null;
  const headerRe = kind === "model" ? /^Switch model\?$/ : /^Change effort level\?$/;
  const nonBlank = tail.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (!nonBlank.some((l) => headerRe.test(l))) return null;
  return m;
}

/**
 * Pure predicate: does this pane tail show a modal the scraper would
 * register a card for? Mirrors the matcher union `scrapeOnce` tries — same
 * order, same `paneWorking` gate on the footer arm — but is deliberately NOT
 * a full replica of `scrapeOnce`'s gate (docs/plans/model-effort-local-
 * command-turns.md §10):
 *
 *   - `matchNumberedModal(tail) ?? matchYesNoModal(tail) ?? matchSliderModal(tail)`
 *     non-null — a numbered / yes-no / slider modal is on screen.
 *   - `detectAskModal(tail) === "question"` — a live AskUserQuestion
 *     question screen (the OTHER kind, `"review"`, is deliberately excluded
 *     here, mirroring `scrapeOnce`'s own `askOnPane` gate: a review screen's
 *     `❯ 1. Submit answers` / `2. Cancel` already satisfies the numbered-modal
 *     arm above, so this function would already have returned `true` for it
 *     via that arm regardless).
 *   - the FOOTER arm of `matchUnparsableModal(tail, false)` (watchdogArmed
 *     forced `false` — this function has no `SessionState` to compute
 *     `stuckTurnFallbackArmed` from, and doesn't need one: the watchdog arm
 *     exists to catch a turn that's been silently stuck for 60s+, a
 *     different question from "is a modal drawn on the pane right now"),
 *     but ONLY when `!paneShowsClaudeWorking(tail)` — mirroring `scrapeOnce`'s
 *     own `paneWorking ? null : matchUnparsableModal(...)` gate on that same
 *     arm. Without it, a long-running tool call's own footer-ish output
 *     (`esc to cancel`, a busy spinner's chrome) could false-fire the guard
 *     while claude is plainly still working, not blocked on a modal.
 *
 * Two things this function deliberately does NOT replicate from
 * `scrapeOnce`'s full gate, and why that's fine for THIS caller:
 *   - `scrapeOnce`'s top-level `claudeIsWriting || (askOnPane &&
 *     !askUnrecoverable) ? null : …` short-circuit, which suppresses ALL
 *     matchers (including numbered/yes-no/slider) while claude is actively
 *     streaming assistant text. A real modal replaces that streaming chrome
 *     entirely, so the matchers above wouldn't spuriously hit mid-stream
 *     anyway — the short-circuit exists to avoid a stale sighting further up
 *     the same tail, not to change whether a modal on THIS tick is real.
 *   - `matchUnparsableModal`'s `UNPARSABLE_STABILITY_TICKS` (3 consecutive
 *     equal-fingerprint sightings) requirement before `scrapeOnce` ever
 *     registers a card off it. This function has no per-call state to track
 *     ticks across, and doesn't need one: `scrapeOnce` holds that bar
 *     because carding a transient repaint would drive a WRONG keystroke into
 *     a modal that isn't really there. `queuePaste`'s modal guard only ever
 *     WITHHOLDS on a hit — no keystroke goes anywhere — and a false-positive
 *     withhold self-heals the moment the caller resends (or the guard's own
 *     next poll tick sees the pane clear); an under-strict, single-tick
 *     over-fire here costs a retry, not a wrong action.
 *
 * Used by `queuePaste`'s modal guard (see `capturePastePane` /
 * `PASTE_MODAL_GRACE_MS`) to decide whether a pending paste would land IN a
 * live modal instead of claude's composer — pasting text into a modal
 * confirms whatever the cursor happens to be on (or is silently swallowed),
 * neither of which is "deliver this as the next chat message." Naming
 * mirrors `paneShowsClaudeWorking` / `paneShowsIdleInputBox`: a pane-state
 * question, not an action.
 *
 * Built directly on the shared `pickScrapeMatch` chain (docs/plans/model-
 * effort-local-command-turns.md §10 re-review finding #10) rather than
 * re-listing `matchNumberedModal ?? matchYesNoModal ?? matchSliderModal` and
 * the `paneWorking`-gated `matchUnparsableModal` fallback by hand — this
 * function had drifted into a THIRD hand-copy of that same chain (alongside
 * `scrapeOnce` and the boot poller), which is exactly the kind of duplication
 * that lets one copy silently fall behind when the chain's precedence or
 * gating changes. The `detectAskModal(tail) === "question"` check stays
 * separate — it's not part of `pickScrapeMatch` (see the doc above for why
 * the `"review"` kind is deliberately excluded here).
 */
function paneShowsBlockingPrompt(tail: string): boolean {
  if (detectAskModal(tail) === "question") return true;
  return pickScrapeMatch(tail, { paneWorking: paneShowsClaudeWorking(tail), watchdogArmed: false }) !== null;
}

/**
 * Recognise claude's Ink TUI rejecting a pasted message as an unknown slash
 * command, e.g.:
 *
 *   ● Unknown command: /skill-creator
 *
 * No JSONL line is ever written for this — the message was never delivered
 * as a turn — so this pane scrape is the only signal. Scans only the last
 * ~12 NON-BLANK lines of the tail (a stale sighting further up the pane
 * shouldn't false-fire on a later, unrelated turn) and requires an exact
 * word-boundary match on `token`: `"Unknown command: /skill-creator"` must
 * NOT match an armed token of `"/skill"` (a prefix), so the token is
 * followed by whitespace or end-of-line.
 *
 * Known non-matches, accepted because claude's error line is short and
 * always "● "-prefixed: a leading glyph other than "●", trailing
 * punctuation right after the token, and a command name tmux hard-wrapped
 * across physical lines (`capture-pane` without `-J`).
 */
function matchUnknownCommand(tail: string[], token: string): boolean {
  const nonBlank = tail.filter((l) => l.trim().length > 0).slice(-12);
  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^Unknown command: ${escapedToken}(?:\\s|$)`);
  return nonBlank.some((raw) => {
    // Strip leading whitespace and an optional "●" bullet + following
    // whitespace — claude prefixes its own status lines with "● ".
    const stripped = raw.replace(/^\s*(?:●\s*)?/, "");
    return re.test(stripped);
  });
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
 *
 * `taskId` is used ONLY to bump `lastKeystrokeAt` on this session's
 * `SessionState` (finding #6, wave-5 re-review) — the caller's boot-poller
 * IIFE already has `opts.taskId` in scope by construction (`spawnClaudeViaTmux`
 * calls `sessions.set(opts.taskId, state)` before it ever arms the boot
 * poller that reaches this function — see `bumpKeystroke`'s doc, which this
 * corrects: there IS a `SessionState` to stamp by the time this runs, unlike
 * that doc's old claim). Looked up fresh (`sessions.get`) rather than passed
 * as a `SessionState` directly so a respawn mid-dialog (unlikely inside the
 * bounded boot window, but not impossible) can't stamp a torn-down state.
 */
async function confirmStartupDialog(taskId: string, sessionName: string, m: StartupDialogMatch): Promise<boolean> {
  const bumpIfLive = (): void => {
    const state = sessions.get(taskId);
    if (state) bumpKeystroke(state);
  };
  const delta = m.acceptIndex - m.cursorIndex;
  const arrow = delta >= 0 ? "Down" : "Up";
  for (let i = 0; i < Math.abs(delta); i++) {
    bumpIfLive();
    if (!(await tmux(["send-keys", "-t", sessionName, arrow])).ok) return false;
    await Bun.sleep(30);
  }
  bumpIfLive();
  return (await tmux(["send-keys", "-t", sessionName, "Enter"])).ok;
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

/** Consecutive equal-fingerprint scrape ticks an unparsable fallback match
 *  must hold before it registers a card (vs. the 2-tick gate parseable modals
 *  use). See `SessionState.scrapeUnparsableStreak`. */
const UNPARSABLE_STABILITY_TICKS = 3;

/** Pure streak step for the unparsable fallback's stability gate: the streak
 *  grows only while this tick's fingerprint equals the previous tick's;
 *  any change restarts it at 1 (this sighting counts). The caller resets it
 *  to 0 on every tick with no unparsable match (a null match, a parseable
 *  match, an answered prompt, session teardown). Exposed via `__forTest` so
 *  the A,A,A / A,B,A / A,A,∅,A,A sequences are unit-testable without a tmux
 *  pane. */
function nextUnparsableStreak(prevStreak: number, sameFingerprintAsLastTick: boolean): number {
  return sameFingerprintAsLastTick ? prevStreak + 1 : 1;
}

/** Whether an unparsable streak has held long enough to register a card. */
function unparsableStreakCleared(streak: number): boolean {
  return streak >= UNPARSABLE_STABILITY_TICKS;
}

/**
 * Pure per-tick step for `scrapeOnce`'s idle-settle streak (mirrors
 * `nextUnparsableStreak`/`unparsableStreakCleared`'s split, combined into one
 * function since the caller needs both the next streak value AND whether to
 * fire on this tick). `eligible` is the caller's own `idleSettleEligible`
 * decision for THIS tick; `streak` is `state.scrapeIdleSettleStreak` going
 * in. Not eligible ⇒ reset to 0, never fire. Eligible ⇒ increment; firing
 * (and resetting back to 0) once the streak reaches
 * `UNPARSABLE_STABILITY_TICKS` — the same stability bar the unparsable
 * fallback itself uses, so a single transient idle-looking frame can't
 * settle a run that's actually still busy.
 *
 * docs/plans/model-effort-local-command-turns.md §10 review finding #1: the
 * caller's `eligible` computation additionally requires
 * `now - state.lastKeystrokeAt > STUCK_TURN_FALLBACK_MS` — every path that
 * delivers text or keys to the pane calls `bumpKeystroke` (see its doc for
 * the enumerated list), so a just-sent, not-yet-delivered prompt is
 * structurally ineligible to settle, while a genuinely static stuck pane
 * still qualifies. This matters because `decideScrapeTick` runs every ~1s
 * while a turn is in flight, an image-bearing paste's own bracketed gap can
 * sleep up to `IMAGE_ATTACH_SETTLE_MAX_MS` (3s) before its Enter goes out,
 * and a queued dropdown-mirror op (`sendSlashCommand`'s auto-confirm poll)
 * can hold the chain another 0.7-2.7s (`slashCommandSettleMs` + up to
 * `SLASH_CONFIRM_WINDOW_MS`) — comfortably enough elapsed real time to
 * accumulate 3 "eligible" ticks well before the pane has genuinely gone
 * stale, on a session that was otherwise idle past `STUCK_TURN_FALLBACK_MS`
 * a turn or two ago.
 *
 * The clock used to be `lastActivityAt`, and that was WRONG in the one case
 * this net exists for (smoke, claude 2.1.246): `lastActivityAt` is also
 * bumped by `scrapeOnce`'s own pane diff, and claude's idle status bar
 * flickers its right-hand hint (`● high · /effort`) roughly once a second, so
 * the diff re-stamped the clock on every other tick and the 60s term was
 * NEVER satisfied on a genuinely idle pane. A run stranded by an unsettleable
 * local-command adoption sat `running` for 6 minutes with `paneShowsIdleInputBox`
 * true the whole time and `signalIdleSettle` never firing. `lastKeystrokeAt`
 * measures only what AGETOR did, which is the actual hazard (settling a turn
 * whose prompt we just delivered) — claude repainting its own chrome is not.
 * `normalizePaneForActivity` additionally strips that status bar's own
 * flickering hint segment (`EFFORT_HINT_SUFFIX_RE`) out of the activity
 * diff — while keeping the rest of the bar row, mode name included — so
 * `lastActivityAt` stops being pinned on the hint alone, but the settle gate
 * no longer depends on that either way.
 */
function idleSettleTick(p: { eligible: boolean; streak: number }): { streak: number; fire: boolean } {
  if (!p.eligible) return { streak: 0, fire: false };
  const streak = p.streak + 1;
  if (streak >= UNPARSABLE_STABILITY_TICKS) return { streak: 0, fire: true };
  return { streak, fire: false };
}

/** A scrape tick is skipped when the JSONL has been written to this
 *  recently — claude is mid-stream, so whatever's on the pane is
 *  likely transient output (a numbered list being printed) and not a
 *  stable modal awaiting input. */
const JSONL_RECENT_WRITE_MS = 500;

/** Beyond this idle window with no active turn, the scraper drops to a
 *  reduced cadence (`SCRAPE_IDLE_POLL_MS`) instead of every tick. It can't
 *  stop entirely: a native modal — an AskUserQuestion or a permission
 *  dialog raised by a background workflow after the turn already resolved
 *  to `review` — appears with NO JSONL write, so `lastJsonlAppendAt` would
 *  stay frozen and a hard stop would never see the question (the user would
 *  have to answer it in tmux). The throttle keeps idle sessions cheap while
 *  still catching a late modal within a couple of seconds. */
const SCRAPE_IDLE_AFTER_MS = 5_000;

/** While JSONL-idle but recently so, capture the pane at most this often (vs
 *  every `SCRAPE_INTERVAL_MS`). This is the common "task just resolved to
 *  `review` and a question is about to pop" window — keep it snappy. */
const SCRAPE_IDLE_POLL_MS = 2_000;

/** Once a session has been JSONL-quiet this long, drop to the much slower
 *  deep-idle cadence below. The previous code stopped scraping idle sessions
 *  entirely ("idle costs nothing"); we can't (a modal writes no JSONL), but a
 *  session that's been silent for minutes is almost certainly parked at the
 *  REPL with nothing pending, so polling it every 2s forever is wasteful when
 *  the board holds many completed-but-undeleted tasks (each keeps its tmux
 *  session for follow-ups). The deep tier keeps long-dead sessions ~cheap
 *  while still eventually catching a very-late modal. */
const SCRAPE_DEEP_IDLE_AFTER_MS = 60_000;

/** Pane-capture cadence for a deeply-idle session (quiet > `SCRAPE_DEEP_IDLE_
 *  AFTER_MS`). 5× cheaper than the near-idle rate. */
const SCRAPE_DEEP_IDLE_POLL_MS = 10_000;

/** Pure decision for `scrapeOnce`: whether an AskUserQuestion "question"
 *  modal on the pane should stop suppressing the generic modal matcher
 *  (`matchNumberedModal`/`matchYesNoModal`) and let it register an ordinary
 *  `tmux_prompt` fallback card instead. True only once
 *  `collectAskQuestionsFromPane` has given up growing the pane for this
 *  modal (`askGrowAttempts >= MAX_ASK_GROW_ATTEMPTS` — see that function)
 *  AND no structured ask card is already registered for it — a live
 *  `askCardId` means SOMETHING did manage to build a real card (typically
 *  the JSONL path, on a later tick after the pane path gave up), and the
 *  generic matcher must never compete with a real one. Factored out (rather
 *  than inlined in `scrapeOnce`) so the give-up→fallback transition is
 *  unit-testable without tmux. */
function askFallbackAllowed(askGrowAttempts: number, hasAskCard: boolean): boolean {
  return askGrowAttempts >= MAX_ASK_GROW_ATTEMPTS && !hasAskCard;
}

/** Pure idle-throttle decision for `scrapeOnce`, factored out so the cadence
 *  logic is unit-testable without tmux. A session is "JSONL-idle" when no turn
 *  is in flight, nothing has appended to its JSONL for `SCRAPE_IDLE_AFTER_MS`,
 *  no prompt is already pending, and no ask-card is live. When idle we still
 *  scrape — a native modal (AskUserQuestion / permission dialog) can appear
 *  with NO JSONL write, so a hard stop would never see a question raised after
 *  the turn resolved to `review`. We throttle, fast right after going idle and
 *  backing off once the session has been quiet a while (`SCRAPE_DEEP_IDLE_*`),
 *  using `now - lastJsonlAppendAt` as the idle-depth clock — no extra state.
 *  `run` says whether to capture the pane this tick; `stampIdle` says whether
 *  the caller should record this as the latest idle capture. */
function decideScrapeTick(p: {
  turnInFlight: boolean;
  lastJsonlAppendAt: number;
  activePromptCount: number;
  askCardLive: boolean;
  lastIdleScrapeAt: number;
  now: number;
}): { run: boolean; stampIdle: boolean } {
  const idleFor = p.now - p.lastJsonlAppendAt;
  const idle = !p.turnInFlight
    && p.lastJsonlAppendAt !== 0
    && idleFor > SCRAPE_IDLE_AFTER_MS
    && p.activePromptCount === 0
    && !p.askCardLive;
  if (!idle) return { run: true, stampIdle: false };
  const pollInterval = idleFor > SCRAPE_DEEP_IDLE_AFTER_MS
    ? SCRAPE_DEEP_IDLE_POLL_MS
    : SCRAPE_IDLE_POLL_MS;
  if (p.now - p.lastIdleScrapeAt < pollInterval) return { run: false, stampIdle: false };
  return { run: true, stampIdle: true };
}

/** Shared line-shape fragments for claude's 2.1.239 pane chrome, kept in one
 *  place so `WORKING_LINE_RE` and `VOLATILE_PANE_LINE_RE` can't drift on the
 *  literals they share (this supersedes the old standalone `SPINNER_RE`, whose
 *  sole `esc to interrupt` phrase now lives in `ESC_TO_INTERRUPT`). Spinner
 *  glyphs are matched only at line start — the `·` glyph doubles as a mid-line
 *  separator/bullet in claude's prose, so anchoring is what stops a stray
 *  `foo · bar…` from reading as a spinner. */
const ESC_TO_INTERRUPT = "esc to interrupt";
/** Compiled once at module scope (docs/plans/model-effort-local-command-
 *  turns.md §10 review finding #7) — `paneShowsIdleInputBox` and
 *  `paneShowsComposerText` both run on every scrape/paste-guard tick, so a
 *  fresh `new RegExp(ESC_TO_INTERRUPT, "i")` per call was needless per-tick
 *  allocation on a hot path. Behaviourally identical to constructing it
 *  inline. */
const ESC_TO_INTERRUPT_RE = new RegExp(ESC_TO_INTERRUPT, "i");
/** The rotating spinner glyph set claude draws at the start of its working /
 *  elapsed / background-agent lines (`✻→✽→✶→✳→✢→·`, with two rarer starbursts
 *  seen in older captures). */
const SPINNER_GLYPH = "[✻✽✶✳✢·⚹✴]";
/** Present-participle spinner, e.g. `✽ Frosting… (2m 52s · ↓ 12.1k tokens)` /
 *  `· Prestidigitating… (1h 21m…)` / `✻ Determining…` — a leading glyph, ONE
 *  word, a trailing `…`, then either the `(elapsed · tokens)` parenthetical or
 *  end of line. The tail anchor keeps a prose bullet that merely starts with
 *  `· Loading… more text` out. Animated (the glyph cycles), so it's volatile
 *  as well as busy. */
const SPINNER_ACTIVE_LINE = `^\\s*${SPINNER_GLYPH}\\s+\\S+…(?:\\s*\\(|\\s*$)`;
/**
 * The COMPLETED-turn marker claude appends to a finished turn's elapsed
 * spinner line. Smoke evidence (claude 2.1.246, live pane on an IDLE session
 * three minutes after the turn ended, sitting 5 non-blank rows from the
 * bottom — i.e. always inside `WORKING_CHROME_WINDOW_LINES`):
 *
 *   ✻ Churned for 1s · done 5:35 PM
 *
 * The LIVE forms carry no such suffix — `✻ Cooked for 2m 18s` (bare elapsed)
 * and `✽ Frosting… (2m 52s · ↓ 12.1k tokens)` (ticking parenthetical) — so
 * `· done` is the one token that tells a FINISHED summary apart from a
 * still-running one.
 *
 * Two different questions ride on this line, which is why the marker is its
 * own constant rather than a tweak to `SPINNER_ELAPSED_LINE` itself:
 *
 *   - **"is claude WORKING?" → no.** `WORKING_LINE_RE` therefore consumes
 *     `SPINNER_ELAPSED_WORKING_LINE` (the same shape with this marker negated)
 *     instead. Without that negation every idle pane that has EVER finished a
 *     turn reads as working, which was the live bug: `mirrorModelViaPicker`
 *     bailed `turn in flight` on every such session (so the dropdown's model
 *     mirror could never run), the idle-settle net and the unparsable footer
 *     arm — both gated on `!paneWorking` — stayed suppressed, and
 *     `paneShowsComposerText` (which early-returns on working chrome) was
 *     pinned false, so a composer-dirty withhold could never clear.
 *   - **"is this line VOLATILE?" → yes, still.** `VOLATILE_PANE_LINE_RE` keeps
 *     matching it via the un-negated `SPINNER_ELAPSED_LINE`. Both of that
 *     regex's consumers — `matchUnparsableModal`'s fingerprint/`paneText`
 *     window and `normalizePaneForActivity`'s activity diff — already strip
 *     the ticking form, and letting the done form back in would make the tick
 *     where `✻ Churned for 1s` becomes `✻ Churned for 1s · done 5:35 PM` read
 *     as a pane change: a fingerprint jitter under a live modal (the
 *     `__external__` sweep would cancel its own card and re-register it), and
 *     a reaper idle-clock reset on a session that just went quiet.
 *
 * Only the elapsed arm is negated. `TOKEN_COUNTER_LINE` is deliberately left
 * alone: no captured done-line carries a token counter, and this codebase
 * only widens pane regexes against a captured pane.
 */
const TURN_DONE_SUMMARY_RE = /·\s*done\b/;
/** Shared body of the elapsed spinner summary, e.g. `✻ Cooked for 2m 18s`,
 *  `✻ Brewed for 9s`, `✻ Cogitated for 5s` — no ellipsis. Spliced into BOTH
 *  variants below so the shape itself can't drift between them. The
 *  `\d+[smh]` unit anchor keeps prose like `· foo for 3 reasons` out. */
const SPINNER_ELAPSED_BODY = `${SPINNER_GLYPH}\\s+\\S+\\s+for\\s+\\d+[smh]`;
/** Elapsed spinner summary in ANY state — still ticking OR carrying the
 *  completed-turn `· done <time>` suffix. This is the VOLATILE-chrome form
 *  (`VOLATILE_PANE_LINE_RE`); see `TURN_DONE_SUMMARY_RE` for why the done form
 *  must stay volatile even though it is no longer "working". */
const SPINNER_ELAPSED_LINE = `^\\s*${SPINNER_ELAPSED_BODY}`;
/** Elapsed spinner summary that is still RUNNING — the same shape MINUS the
 *  completed-turn form (`TURN_DONE_SUMMARY_RE`, negated as a line-wide
 *  lookahead). Genuinely "busy" while a turn is in flight (a long non-shell
 *  tool call whose only pane signal is the elapsed timer), which is why
 *  `WORKING_LINE_RE` — and only `WORKING_LINE_RE` — uses this variant. */
const SPINNER_ELAPSED_WORKING_LINE = `^(?!.*${TURN_DONE_SUMMARY_RE.source})\\s*${SPINNER_ELAPSED_BODY}`;
/** Ticking token counter that rides the spinner line and the background-agent
 *  roster, e.g. `… · ↓ 12.1k tokens`, `general-purpose  10s · ↓ 46.2k tokens`.
 *  Anchored to the `·`-separator + arrow so a bare `↓ 5 tokens` in prose can't
 *  match. */
const TOKEN_COUNTER_LINE = "·\\s*(?:↓|↑)\\s*[0-9.]+k?\\s*tokens";

/** Lines that prove claude is actively working on the pane in Claude Code
 *  2.1.239. Evidence (captured live): the present-participle spinner
 *  (`SPINNER_ACTIVE_LINE`) and its elapsed summary (`SPINNER_ELAPSED_LINE`);
 *  the ticking token counter (`TOKEN_COUNTER_LINE`); the status-bar
 *  `esc to interrupt`; a background-agent wait `✻ Waiting for 1 background
 *  agent to finish`; a live shell `✻ Brewed for 9s · 1 shell still
 *  running` / status-bar `· 1 shell ·`; and a live Monitor `✻ Cooked for
 *  4m 32s · 2 monitors still running` / status-bar `⏵⏵ auto mode on · 1
 *  monitor · esc to interrupt · ← 4 agents · ↓ to manage` (that second
 *  capture already matches on `esc to interrupt` alone, but the `· 1
 *  monitor ·` status-bar item gets its own arm for the same reason shells
 *  do — the elapsed-summary form doesn't always coincide with an active
 *  turn's interrupt chrome). Unlike 1 Hz-blinking `esc to interrupt` alone,
 *  this union stays true across a working turn's quiet-JSONL windows
 *  (background agents, long tool calls) — exactly when the old watchdog
 *  false-fired. Every arm is anchored to the chrome shape it came from
 *  (leading glyph, `·`-separated status-bar item, `still running`) so
 *  look-alike transcript prose — `· 3 shell scripts were updated`, `Waiting
 *  for 2 background agents to report back.` — can't read as working.
 *  Deliberately excludes "N agents" (`← 4 agents` above) — that counter is
 *  other local Claude sessions, not this task's background work (plan
 *  `docs/plans/claude-code-monitors-hold-running.md` §8 Q1). Add a form
 *  only with a captured pane to back it.
 *
 *  The elapsed arm is `SPINNER_ELAPSED_WORKING_LINE`, NOT the plain
 *  `SPINNER_ELAPSED_LINE` that `VOLATILE_PANE_LINE_RE` uses: a FINISHED
 *  turn's summary row (`✻ Churned for 1s · done 5:35 PM`) keeps the elapsed
 *  shape forever on an idle pane, so without the negation this whole
 *  predicate reads `true` on every session that ever completed a turn — see
 *  `TURN_DONE_SUMMARY_RE` for the live evidence and the four consumers that
 *  broke. */
const WORKING_LINE_RE = new RegExp(
  [
    ESC_TO_INTERRUPT,
    SPINNER_ACTIVE_LINE,
    SPINNER_ELAPSED_WORKING_LINE,
    TOKEN_COUNTER_LINE,
    `^\\s*${SPINNER_GLYPH}\\s+Waiting for \\d+ background agent`,
    "\\d+\\s+shells?\\s+still\\s+running",
    "·\\s*\\d+\\s+shells?\\s*(?:·|$)",
    `^\\s*${SPINNER_GLYPH}[^\\n]*·\\s*\\d+\\s+monitors?\\s+still\\s+running`,
    "·\\s*\\d+\\s+monitors?\\s*(?:·|$)",
  ].join("|"),
  "i",
);

/** How many trailing NON-BLANK pane lines `paneShowsClaudeWorking` inspects.
 *  Working chrome lives in the bottom widget area — spinner/elapsed line, the
 *  hint line, the `Tip:` banner, the input box (3 rows), the status bar, the
 *  `✔ Update installed` notice and the background-agent roster (`⏺ main` +
 *  one `◯` row per agent) — which in the deepest live capture ran 13 non-blank
 *  rows (4 agents). 16 covers that with slack while keeping the scrollback
 *  transcript above it out of the decision: a tool result that echoes claude
 *  chrome (an agent inspecting tmux panes — agetor dogfooding), or prose that
 *  resembles a spinner line, must not be able to hide a genuine prompt that
 *  renders below it. */
const WORKING_CHROME_WINDOW_LINES = 16;

/** Usage-limit AUTO-CONTINUE notices, which carry a `MODAL_FOOTER_RE` phrase
 *  (`… · esc to cancel`) but need no user action — claude resumes on its own.
 *  Evidence (2.1.239 binary): `Usage limit reached · continuing automatically
 *  at 8am · esc to cancel`, `… continuing shortly · esc to cancel`, `…
 *  continuing automatically when it resets · esc to cancel`.
 *  `matchUnparsableModal` vetoes on these on BOTH arms, over the card's own
 *  12-line window, so they never surface a card — a mid-turn limit pause keeps
 *  the turn in flight and the pane quiet, which would otherwise arm the
 *  stuck-turn watchdog. `Usage limit has reset · press enter to continue` is
 *  deliberately NOT here — it is genuinely actionable. Note that when it
 *  renders in the hint slot above the input box it sits outside the footer
 *  arm's last-3-line window, so it reaches the user via the watchdog arm
 *  (turn still in flight, pane quiet, no working chrome) rather than
 *  instantly — acceptable for a "go press Enter in the terminal" card. */
const MODAL_NOTICE_RE = /continuing automatically|continuing shortly/i;

/** Bottom-of-pane status-bar text when claude is idle at its input box.
 *  Evidence (2.1.245, five captured variants — the trailing `· ← 1 agent`
 *  suffix is optional, present only when a background agent is running, so
 *  it is NOT anchored here):
 *    `⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent`
 *    `⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent`
 *    `⏸ manual mode on · ? for shortcuts · ← 1 agent` (no shift+tab hint)
 *    `⏵⏵ accept edits on (shift+tab to cycle) · ← 1 agent`
 *    `⏸ plan mode on (shift+tab to cycle) · ← 1 agent`
 *  Anchored on the leading mode glyph (`⏵⏵`/`⏸`) plus either cycle hint —
 *  narrower than `readPaneMode`'s per-mode regexes (which must tell the five
 *  modes APART) because this only has to answer "is the bottom line a status
 *  bar at all", not which mode it names. A working pane's OWN status bar can
 *  carry the SAME `(shift+tab to cycle)` phrase with an `esc to interrupt`
 *  segment spliced in — this regex alone can't tell the two apart, which is
 *  why `paneShowsIdleInputBox` additionally rejects any matched bar
 *  containing `esc to interrupt` (see that function's doc).
 *
 *  Declared ABOVE `VOLATILE_PANE_LINE_RE` (it used to sit below
 *  `paneShowsClaudeWorking`) purely so that regex can splice this one's
 *  `.source` in as an alternative at module-evaluation time — a `const`
 *  referenced before its initializer runs would throw on TDZ. */
const STATUS_BAR_RE = /^\s*(?:⏵⏵|⏸)\s.*(?:\(shift\+tab to cycle\)|\? for shortcuts)/;

/**
 * Pane chrome that repaints on a fixed cadence independent of anything
 * meaningful — the animated spinner line and its token counter (shared with
 * `WORKING_LINE_RE`) and the rotating `Tip:` banner. Matched AFTER trailing
 * whitespace is trimmed. Has TWO consumers, both stripping whole LINES that
 * match before doing further work on what's left — `matchUnparsableModal`'s
 * `paneLines` (the window its `paneText`/fingerprint are built from) and
 * `normalizePaneForActivity` (the "did the pane meaningfully change" diff
 * `scrapeOnce` uses to drive `lastActivityAt`) — so an edit here changes the
 * unparsable card's displayed text AND the reaper's activity signal
 * together; keep both in mind when touching this regex. Filtering these
 * before fingerprinting/diffing is what keeps the stability gate and the
 * `__external__` sweep from jittering on the animated `✻→✽→✶` glyph and the
 * ticking `↓ N tokens` counter.
 *
 * Uses the UN-negated `SPINNER_ELAPSED_LINE`, so a COMPLETED turn's summary
 * row (`✻ Churned for 1s · done 5:35 PM`) is still stripped here even though
 * `WORKING_LINE_RE` no longer treats it as working — the tick where the
 * ticking form gains its `· done <time>` suffix is a chrome repaint, not a
 * meaningful pane change, and letting it through would jitter the unparsable
 * card's fingerprint and reset the reaper's idle clock. See
 * `TURN_DONE_SUMMARY_RE` for the full split.
 *
 * Does NOT include claude's own bottom status bar (`STATUS_BAR_RE`) — see
 * `EFFORT_HINT_SUFFIX_RE` below for why an entire-line arm for it was wrong,
 * and `normalizePaneForActivity` for the narrower fix (finding #8, wave-5
 * re-review). `STATUS_BAR_RE` itself is unchanged and still lives just above
 * this constant only for the TDZ ordering reason in its own doc, not because
 * this regex still splices it in.
 */
const VOLATILE_PANE_LINE_RE = new RegExp(
  [
    ESC_TO_INTERRUPT,
    SPINNER_ACTIVE_LINE,
    SPINNER_ELAPSED_LINE,
    TOKEN_COUNTER_LINE,
    "^\\s*Tip:",
  ].join("|"),
  "i",
);

/**
 * The flickering RIGHT-HAND hint segment claude 2.1.246 splices onto the
 * bottom status bar while idle — smoke evidence: one capture read
 * `⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent            ● high · /effort`
 * at 15:56:06.5 and the IDENTICAL row without the trailing `● high · /effort`
 * segment at 15:56:05. The two captures differ ONLY in that trailing
 * segment — same mode glyph, same cycle hint, same agent count — which is
 * why stripping the WHOLE status-bar row (the old `VOLATILE_PANE_LINE_RE`
 * arm this replaces) was the wrong fix: it also erased the mode name itself
 * from both consumers listed on `VOLATILE_PANE_LINE_RE`'s doc, hiding a
 * genuine terminal-side mode flip (bypass → auto, say) from
 * `normalizePaneForActivity`'s activity diff and from the unparsable card's
 * displayed `paneText`. This regex targets only the self-flickering
 * suffix — a leading run of whitespace, the `●`/`◉` glyph, one word, ` · `,
 * then `/effort`, anchored to end-of-line — so `normalizePaneForActivity`
 * can strip just that segment off a matched `STATUS_BAR_RE` row and keep the
 * rest of the line (mode glyph, mode name, cycle hint, agent count) intact
 * for the activity diff. Exported via `__forTest` alongside the helper that
 * applies it.
 */
const EFFORT_HINT_SUFFIX_RE = /\s+[●◉]\s+\S+\s+·\s+\/effort\s*$/;

/** True when the live pane shows claude actively working (see
 *  `WORKING_LINE_RE`), checked over the last `WORKING_CHROME_WINDOW_LINES`
 *  non-blank lines of the scrape tail — the bottom widget area, NOT the
 *  scrollback transcript above it. Gates BOTH arms of `matchUnparsableModal`:
 *  a real prompt/wizard REPLACES the working chrome (verified against live
 *  2.1.239 panes), so suppressing the fallback whenever working chrome is
 *  present cannot hide a genuine prompt, but it does kill the false card on
 *  normal long-quiet-JSONL turns. Bounding the window is what keeps that
 *  safety claim honest: the transcript can legitimately contain chrome-shaped
 *  text (a tool result echoing a pane, prose resembling a spinner line) above
 *  a real modal. Pure/exported so the truth table is unit-testable without a
 *  live tmux pane. */
function paneShowsClaudeWorking(tail: string): boolean {
  const nonBlank = tail.split("\n").filter((l) => l.trim().length > 0);
  return nonBlank.slice(-WORKING_CHROME_WINDOW_LINES).some((l) => WORKING_LINE_RE.test(l));
}

/** How many trailing NON-BLANK pane lines ABOVE the status bar
 *  `paneShowsIdleInputBox` searches for a bare `❯` prompt row. The idle
 *  bottom-of-pane chrome is not always the tight `{ top border, bare "❯ "
 *  prompt, bottom border, status bar }` 4-row stack it looks like at first
 *  capture — `WORKING_CHROME_WINDOW_LINES`'s own doc measures up to 13
 *  non-blank widget rows co-rendering in that same area (`Tip: …` banner,
 *  `✔ Update installed` notice, the `⏺ main` + per-agent `◯` background-agent
 *  roster), any of which can sit BETWEEN the input box and the status bar and
 *  push the bare prompt row out of a 4-line window. 8 comfortably covers the
 *  observed widget stack with slack, while staying far short of the ordinary
 *  transcript above it, where a stray bare `❯` in scrollback could otherwise
 *  be mistaken for the live prompt. */
const IDLE_PROMPT_SEARCH_LINES = 8;

/**
 * The single LIVE prompt row within the idle chrome window — the
 * BOTTOM-MOST line matching a leading `❯` among the up-to-
 * `IDLE_PROMPT_SEARCH_LINES` non-blank pane lines directly above the
 * anchored status bar. Anchoring: the status bar must be the LAST or
 * second-to-last non-blank pane line (checking the last TWO, not just the
 * last, is slack for a trailing artifact row `tmux capture-pane` can leave
 * behind the true bottom line) and must NOT itself carry `esc to interrupt`
 * (that phrase, spliced into an otherwise-identical `(shift+tab to cycle)`
 * bar, is how a WORKING pane's own status bar is told apart from an idle
 * one). Returns `null` when no such bar is anchored there at all — most
 * likely a modal replacing it, or a stale status-bar-shaped line sitting in
 * scrollback above one.
 *
 * Bottom-most, not "any row" (docs/plans/model-effort-local-command-
 * turns.md §10 re-review finding #1): claude ECHOES the user's last
 * submitted line in the transcript with the SAME `❯` glyph — e.g.
 * `❯ /model sonnet` rendered above its own `⎿  Set model to …` result line.
 * That echo can sit inside the `IDLE_PROMPT_SEARCH_LINES` search window
 * above an otherwise EMPTY live composer, so "does any row in the window
 * match a `❯`-prefixed line" was true on an idle pane with nothing typed —
 * the exact false positive that made `paneShowsComposerText` fire forever
 * after a `pre-enter` withhold's clear (the echo never goes away) and sent
 * a stray `Escape Escape` into an empty box on the next retry. The live
 * composer always renders as the row IMMEDIATELY above the status bar (only
 * border/hint chrome between them, never ordinary transcript), so taking the
 * LAST matching row — closest to the bar — picks the real composer over any
 * stale echo further up.
 */
function livePromptRow(tail: string): string | null {
  const nonBlank = tail.split("\n").filter((l) => l.trim().length > 0);
  if (nonBlank.length === 0) return null;
  const lastTwo = nonBlank.slice(-2);
  const barRelIndex = lastTwo.findIndex((l) => STATUS_BAR_RE.test(l));
  if (barRelIndex === -1) return null;
  if (ESC_TO_INTERRUPT_RE.test(lastTwo[barRelIndex]!)) return null;
  const barAbsIndex = nonBlank.length - lastTwo.length + barRelIndex;
  const above = nonBlank.slice(Math.max(0, barAbsIndex - IDLE_PROMPT_SEARCH_LINES), barAbsIndex);
  for (let i = above.length - 1; i >= 0; i--) {
    if (/^\s*❯/.test(above[i]!)) return above[i]!;
  }
  return null;
}

/** True when the pane shows claude idle at its input box: `livePromptRow`
 *  finds a live prompt row and that row is BARE — `❯` and nothing else typed
 *  (`/^\s*❯\s*$/`). `paneShowsComposerText` immediately below is this
 *  predicate's complement on the SAME row (finding #1, §10 re-review):
 *  exactly one of the two is true whenever `livePromptRow` finds a row at
 *  all, bare vs. non-bare.
 *
 *  NOTE: unlike `paneShowsComposerText`, this does not separately check
 *  `!paneShowsClaudeWorking(tail)` — the status bar's own `esc to interrupt`
 *  rejection (inside `livePromptRow`) is normally enough, and this gate can
 *  legitimately read `true` on the blink-OFF tick of that phrase on an
 *  otherwise-busy pane. That's fine: `paneShowsClaudeWorking` (the spinner
 *  line) is what actually protects the settle path from a still-busy turn —
 *  `scrapeOnce`'s idle-settle eligibility already requires `!paneWorking`
 *  independent of this function.
 *
 *  Gates the stuck-turn watchdog (`stuckTurnFallbackArmed`'s `paneIdle`
 *  param) — claude idle at the input box is proof a turn ended without ever
 *  writing an `end_turn` line, not a stuck/unparsable modal; see
 *  `signalIdleSettle` for how that gets settled instead of carded. */
function paneShowsIdleInputBox(tail: string): boolean {
  const row = livePromptRow(tail);
  return row !== null && /^\s*❯\s*$/.test(row);
}

/**
 * True when the pane shows claude idle at its input box (same `livePromptRow`
 * anchoring as `paneShowsIdleInputBox`) but with UNSENT TEXT already sitting
 * in the box — the live row is non-bare (`/^\s*❯\s+\S/`, at least one
 * non-whitespace character after the `❯`) rather than the bare `❯` that
 * function requires. The multi-line paste placeholder (`❯ [Pasted text #1
 * +12 lines]`) is non-bare too — correctly treated as composer text.
 *
 * Also requires `!paneShowsClaudeWorking(tail)` explicitly (rather than
 * relying only on the status-bar's own `esc to interrupt` rejection, as
 * `paneShowsIdleInputBox` does) since this is called directly by
 * `queuePaste`'s composer-clear check with no separate `paneWorking`
 * variable already computed at the call site.
 *
 * Used by `queuePaste` (docs/plans/model-effort-local-command-turns.md §10
 * review finding #2) to detect that a PRIOR withheld paste's text is still
 * sitting in the composer before pasting a NEW message — pasting on top of
 * it would concatenate rather than replace.
 */
function paneShowsComposerText(tail: string): boolean {
  if (paneShowsClaudeWorking(tail)) return false;
  const row = livePromptRow(tail);
  return row !== null && /^\s*❯\s+\S/.test(row);
}

/**
 * Keystrokes `queuePaste`'s composer-clear check sends to clear claude's
 * input box of a stranded, unsent message before pasting a new one over it.
 * Both keys in ONE `send-keys` call — live-verified (claude 2.1.245, this
 * session's spike, docs/plans/model-effort-local-command-turns.md §10):
 * with text in the box while IDLE, `Escape Escape` sent together clears it;
 * a SINGLE Escape only shows the hint `Esc again to clear`, and a SECOND,
 * separately-sent Escape ~1s later does NOT clear (claude only recognises
 * the double-tap within one input read). `C-u` never clears the box
 * (idle or mid-turn). `C-c` does clear it, but arms claude's own
 * `Press Ctrl-C again to exit` — a second one would quit claude — so it is
 * never used for this. There is deliberately no mid-turn clear path: Esc and
 * C-c both interrupt a live turn, so the composer-dirty branch below
 * withholds instead of ever sending these keys while claude is working.
 */
const COMPOSER_CLEAR_KEYS = ["Escape", "Escape"];

/** Settle time after `COMPOSER_CLEAR_KEYS` before re-checking whether the
 *  composer actually cleared. Short — this is a local Ink re-render, not a
 *  network round-trip. */
const COMPOSER_CLEAR_SETTLE_MS = 300;

/**
 * Strip claude's self-flickering `● <effort> · /effort` status-bar hint
 * (`EFFORT_HINT_SUFFIX_RE`) off a matched `STATUS_BAR_RE` row, leaving the
 * rest of the bar (mode glyph, mode name, cycle hint, agent count) intact —
 * a no-op on any line that isn't a recognized status bar (finding #8,
 * wave-5 re-review). Factored out of `normalizePaneForActivity` so the
 * "only this segment is volatile, not the whole row" rule is unit-testable
 * directly against a bare status-bar string, without a live tmux pane.
 */
function stripVolatileStatusBarHint(line: string): string {
  return STATUS_BAR_RE.test(line) ? line.replace(EFFORT_HINT_SUFFIX_RE, "") : line;
}

/**
 * Normalize a captured pane tail into the form used for the "did the pane
 * meaningfully change" activity signal in `scrapeOnce`. Mirrors the
 * normalization the modal matchers (`matchNumberedModal`, `detectAskModal`)
 * already apply when fingerprinting a pane — right-trim each line, since
 * `tmux capture-pane` pads rows with trailing spaces that vary run to run —
 * strips claude's OWN self-flickering status-bar hint segment
 * (`stripVolatileStatusBarHint`, finding #8, wave-5 re-review — narrower than
 * dropping the whole bar row, which used to hide a genuine mode flip from
 * this same activity diff), and additionally drops lines that are pure
 * volatile chrome otherwise (see `VOLATILE_PANE_LINE_RE`). Without this, a
 * session idling at the REPL can keep resetting the reaper's 30-minute idle
 * clock (`lastActivityAt`) forever purely from chrome redraws that never
 * touch real transcript content, neutering the reaper. Only affects the
 * activity-diff comparison — modal matching still runs against the raw,
 * unnormalized tail. */
function normalizePaneForActivity(tail: string): string {
  return tail
    .split("\n")
    .map((line) => line.trimEnd())
    .map(stripVolatileStatusBarHint)
    .filter((line) => !VOLATILE_PANE_LINE_RE.test(line))
    .join("\n");
}

/** Run a single scrape tick. Idempotent: registers at most one new
 *  TmuxPromptRequest per call, auto-cancels any pending one whose
 *  fingerprint no longer matches the pane. */
async function scrapeOnce(state: SessionState): Promise<void> {
  const now = Date.now();
  // Computed once and reused for every read below (`decideScrapeTick`'s
  // `activePromptCount`, the idle-settle gate, and the `__external__` sweep)
  // instead of re-querying the registry three times per tick (docs/plans/
  // model-effort-local-command-turns.md §10 review finding #7). Safe to share
  // across all three: nothing between here and the sweep mutates the tmux-
  // prompt registry (the ask-card handling below touches `state.askCardId`,
  // a separate subsystem) — the first mutation of it in this function is the
  // sweep itself.
  const pendingPrompts = activeTmuxPromptsForTask(state.taskId);
  const tick = decideScrapeTick({
    turnInFlight: state.turnQueue.length > 0,
    lastJsonlAppendAt: state.lastJsonlAppendAt,
    activePromptCount: pendingPrompts.length,
    // Keep polling at full rate while an AskUserQuestion card is live, so the
    // resolve-on-modal-gone backstop fires if the user answers it via a real
    // `tmux attach` (external dismissal) rather than the card.
    askCardLive: state.askCardId !== null,
    lastIdleScrapeAt: state.lastIdleScrapeAt,
    now,
  });
  if (tick.stampIdle) state.lastIdleScrapeAt = now;
  if (!tick.run) return;

  const cap = await tmux(["capture-pane", "-p", "-t", state.sessionName]);
  if (!cap.ok) {
    // Session vanished — let `disposeSessionState` clean us up the next
    // time the orchestrator notices. Don't churn here.
    return;
  }
  const lines = cap.stdout.split("\n");
  const tailLines = lines.slice(Math.max(0, lines.length - SCRAPE_TAIL_LINES));
  const tail = tailLines.join("\n");

  // The pane changing is a life signal independent of the JSONL — a native
  // AskUserQuestion modal, or the user driving the session directly via
  // `tmux attach`, can both change what's on screen without ever writing to
  // the JSONL. Compare the NORMALIZED tail (see `normalizePaneForActivity`),
  // not the raw capture — volatile chrome (the "esc to interrupt" spinner's
  // elapsed-time/token counter, a rotating "Tip: …" line, trailing
  // whitespace) would otherwise diff on nearly every tick and pin
  // `lastActivityAt` at "now" forever, neutering the reaper's idle clock.
  // Skip the very first capture (nothing to compare against yet).
  const normalizedTail = normalizePaneForActivity(tail);
  if (state.scrapeLastPaneText !== null && state.scrapeLastPaneText !== normalizedTail) {
    bumpActivity(state);
  }
  state.scrapeLastPaneText = normalizedTail;

  // Armed, token-matched lookout for claude's TUI rejecting the last-pasted
  // message as an unknown slash command. Cheap and early-guarded — only
  // evaluated while a token is armed AND a turn is genuinely in flight — so
  // this never runs for the (overwhelmingly common) non-slash-prompt case.
  // No JSONL line is ever written when this fires, so this scrape is the
  // only place that can catch it. Runs before the modal-detection block
  // below; ordering doesn't otherwise matter (an unknown-command error never
  // coexists with a modal) since `signalUnknownCommand` is one-shot (it
  // clears `pendingSlashToken`, so a re-check later in the same tick — there
  // isn't one — or the next tick can't double-fire).
  if (state.pendingSlashToken !== null
    && turnInFlight(state)
    && matchUnknownCommand(tailLines, state.pendingSlashToken)) {
    signalUnknownCommand(state);
  }

  // JSONL-recency gate: claude is actively writing. The pane content
  // is mid-render, not a stable modal — defer matching until things
  // settle. We still run the auto-cancel sweep below so a previously
  // registered prompt that just disappeared can clear out.
  const claudeIsWriting = state.lastJsonlAppendAt !== 0
    && now - state.lastJsonlAppendAt < JSONL_RECENT_WRITE_MS;

  // Native AskUserQuestion modal handling. Its options render as a numbered
  // checkbox list (`❯ 1. [✔] Cheese …`) that matchNumberedModal would otherwise
  // grab, producing a competing single-keystroke tmux_prompt card. So whenever
  // the *question* screen is on the pane we (a) suppress the numbered matcher
  // and (b) drive the structured-card flow off the pane
  // (collectAndRegisterAskCard). When it leaves the pane (answered/cancelled)
  // we drop the card. ExitPlanMode's approval modal carries no AskUserQuestion
  // signature, so it still flows through the numbered matcher as intended.
  //
  // The *review* screen ("Ready to submit your answers?") is deliberately
  // NOT included in this suppression, even though `detectAskModal` reports it
  // too. `driveAskAnswers` (claude-tmux.ts) verifies its own confirm Enter
  // and self-heals a swallowed one, but two cases still land a review screen
  // that nothing is driving: the drive's bounded resends genuinely exhausted
  // (a real failure, not just a slow repaint), or the user attached to tmux
  // directly and navigated to review by hand. `parseModalPane` can't parse
  // the review screen (no question/footer signature), and the JSONL-preferred
  // path is never consulted here either — it's gated on `askOnPane` (kind ===
  // "question"), which is false for "review" — so with the old blanket
  // suppression a stranded review screen matched nothing on every tick,
  // forever — the bug this whole change fixes. Letting `askOnPane` go false for "review"
  // lets it fall through to `matchNumberedModal`, which DOES match it
  // (`❯ 1. Submit answers` / `2. Cancel` — ≥2 numbered choices, cursor
  // marker, "1." anchor) and, after the usual two-tick stability gate,
  // registers an ordinary clickable tmux_prompt card. If an ask card is
  // still registered when that happens (the driver hadn't dropped it yet,
  // or the user reached review by hand), the `else` branch below resolves it
  // as externally-answered — the same semantics external dismissal already
  // has for the question screen.
  const askKind = detectAskModal(tail);
  const askOnPane = askKind === "question";
  if (askOnPane) {
    if (state.askFirstSeenAt === null) state.askFirstSeenAt = now;
    if (!claudeIsWriting && !state.askCardId && !state.askCollecting) {
      void collectAndRegisterAskCard(state, tail);
    }
  } else {
    if (state.askCardId) {
      resolveScrapedAskQuestions(state.askCardId);
      state.askCardId = null;
    }
    state.askFirstSeenAt = null;
    state.askGrowAttempts = 0;
  }

  // `collectAskQuestionsFromPane` gives up (see `MAX_ASK_GROW_ATTEMPTS`) once
  // this modal has repeatedly grown-and-still-not-parsed-complete — at that
  // point NOTHING will ever register a structured ask card for it (JSONL
  // never yielded one either, or `collectAndRegisterAskCard` above would have
  // already set `askCardId`). Rather than strand the run showing "Agent is
  // working…" forever, `askFallbackAllowed` stops suppressing the generic
  // matcher so `matchNumberedModal` can register an ordinary `tmux_prompt`
  // card off the same numbered options it always keys on — never a
  // wrong-index risk, just a less structured card.
  const askUnrecoverable = askOnPane && askFallbackAllowed(state.askGrowAttempts, state.askCardId !== null);

  // Computed once and passed through even into the branch that skips the
  // unparsable matcher entirely (see below) — `stuckTurnFallbackArmed`'s
  // signature stays honest about what it was actually gated on, rather than
  // silently hardcoding `false` at the call site.
  const paneWorking = paneShowsClaudeWorking(tail);
  // Claude idle at its own input box (see `paneShowsIdleInputBox`) is proof a
  // turn is over even when no `end_turn` JSONL line ever confirmed it — used
  // below to keep the watchdog arm from carding an idle pane, and to drive
  // the idle-settle net that closes such a turn out instead.
  const paneIdle = paneShowsIdleInputBox(tail);
  const match = (claudeIsWriting || (askOnPane && !askUnrecoverable))
    ? null
    : pickScrapeMatch(tail, {
        paneWorking,
        watchdogArmed: stuckTurnFallbackArmed({
          turnInFlight: turnInFlight(state),
          lastJsonlAppendAt: state.lastJsonlAppendAt,
          now,
          paneWorking,
          askCardLive: state.askCardId !== null,
          paneIdle,
        }),
      });

  // Idle-settle net: the SAME conditions that would arm the stuck-turn
  // watchdog above, but with the pane genuinely idle at the input box
  // (`paneIdle`) instead of showing a stuck/unparsable modal, and with no
  // tmux_prompt already registered for this task (a real prompt still needs
  // an answer, not a settle out from under the user). Recomputed with
  // `paneIdle: false` so this reads the "other" watchdog conditions
  // (in-flight, quiet past `STUCK_TURN_FALLBACK_MS`, not working, no ask
  // card) independent of the idle gate — `paneIdle` above already carries
  // the real idle signal for this branch. Additionally requires AGETOR'S OWN
  // last keystroke into this pane (`lastKeystrokeAt`, not the general-purpose
  // `lastActivityAt`) to be quiet past `STUCK_TURN_FALLBACK_MS` — see
  // `idleSettleTick`'s doc for why a just-sent, not-yet-delivered prompt must
  // be structurally ineligible here, and why the clock had to stop being
  // `lastActivityAt`. Held to the same
  // `UNPARSABLE_STABILITY_TICKS` stability bar `matchUnparsableModal` uses
  // (via `idleSettleTick`), so a single transient idle-looking frame can't
  // settle a run that's actually still busy. This is the version-proof net
  // for any turn that never gets an `end_turn` line — see `signalIdleSettle`.
  const idleSettleEligible = paneIdle
    && now - state.lastKeystrokeAt > STUCK_TURN_FALLBACK_MS
    && pendingPrompts.length === 0
    && stuckTurnFallbackArmed({
      turnInFlight: turnInFlight(state),
      lastJsonlAppendAt: state.lastJsonlAppendAt,
      now,
      paneWorking,
      askCardLive: state.askCardId !== null,
      paneIdle: false,
    });
  const idleTick = idleSettleTick({ eligible: idleSettleEligible, streak: state.scrapeIdleSettleStreak });
  state.scrapeIdleSettleStreak = idleTick.streak;
  if (idleTick.fire) signalIdleSettle(state);

  // Auto-cancel: any registered prompt for this task whose fingerprint
  // is NOT what we see now has been dismissed (either externally via
  // `tmux attach`, or the dialog was transient). Resolve those entries
  // so the UI stops showing them.
  const stillPresent = new Set<string>(match ? [match.fingerprint] : []);
  for (const pending of pendingPrompts) {
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
    state.scrapeUnparsableStreak = 0;
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

  // Stability gate (see `clearedStabilityGate`): a high-confidence match
  // registers on first sighting; everything else waits for the same
  // fingerprint on two consecutive scrapes. Record the fingerprint either way
  // so the next tick can satisfy the two-tick rule. Note: while the session is
  // JSONL-idle the capturing ticks are spaced by the idle cadence
  // (`SCRAPE_IDLE_POLL_MS`+), not 1s, so a numbered/yes-no modal raised after
  // the turn resolved to `review` registers in ~two idle ticks rather than ~2s;
  // the AskUserQuestion path above and any high-confidence match skip the gate
  // and surface on the first idle capture.
  //
  // The unparsable fallback (`match.unparsable`) uses its OWN stricter gate —
  // `UNPARSABLE_STABILITY_TICKS` (3) consecutive equal-fingerprint sightings,
  // tracked in `scrapeUnparsableStreak` — instead of the generic two-tick one:
  // for that matcher, footer/watchdog presence IS the whole trigger (there's
  // no already-parsed choice set behind it), so a 1–2 tick blip must not card.
  const sameAsLast = state.scrapeLastFingerprint === match.fingerprint;
  if (match.unparsable) {
    state.scrapeUnparsableStreak = nextUnparsableStreak(state.scrapeUnparsableStreak, sameAsLast);
    state.scrapeLastFingerprint = match.fingerprint;
    if (!unparsableStreakCleared(state.scrapeUnparsableStreak)) return;
  } else {
    state.scrapeUnparsableStreak = 0;
    const cleared = clearedStabilityGate(match, state.scrapeLastFingerprint);
    state.scrapeLastFingerprint = match.fingerprint;
    if (!cleared) return;
  }

  // Agetor itself is driving this exact modal (`mirrorModelViaPicker`'s
  // queued op owns walking the picker and confirming it — see
  // `SessionState.drivingPrompt`) — never register a competing card for a
  // picker agetor opened itself. This is the single point BOTH the
  // unparsable path and the generic-stability path above converge on before
  // ever reaching `registerTmuxPrompt`, so one check here covers both rather
  // than duplicating it in each branch. Same idea as the `askCollecting`
  // guard higher up in this function (suppress registration while a KNOWN
  // driver owns the pane), just placed at this convergence point instead.
  // The `__external__` auto-cancel sweep above is untouched — a picker that
  // disappears out from under the mirror (session death, external
  // dismissal) still auto-cancels normally.
  if (state.drivingPrompt) return;

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
    nav: match.nav,
    fingerprint: match.fingerprint,
    unparsable: match.unparsable,
    confirmKey: match.confirmKey,
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
  state.scrapeUnparsableStreak = 0;
  // Same defensive re-stabilise for the idle-settle streak — an answered
  // prompt means whatever idle-looking run was accruing no longer applies.
  state.scrapeIdleSettleStreak = 0;
}

/** Install or refresh the scraper interval for a session. Called from
 *  `attachTailer`; torn down by `disposeSessionState`. */
function startScraper(state: SessionState): void {
  if (state.scrapeTimer) return;
  state.scrapeTimer = setInterval(() => {
    void scrapeOnce(state).catch(() => { /* swallow — never crash the timer */ });
  }, SCRAPE_INTERVAL_MS);
}

/** How often the death watch ticks. A tick is a `kill(pid, 0)` syscall on the
 *  pane's process — the `tmux has-session` fork only runs to confirm a dead
 *  pid or on the periodic re-validation (`createDeathProbe`). */
const DEATH_POLL_MS = 400;
/** Grace after the session disappears before we settle, so any final JSONL
 *  bytes (a real end_turn that landed just before the session died) are
 *  flushed and read first — matches codex-tmux's DEATH_GRACE_MS. */
const DEATH_GRACE_MS = 250;
/** Consecutive definitive `gone` probes required before declaring death —
 *  debounces a transient tmux failure. Now that only a `gone` (server up,
 *  session absent) probe counts — an `unreachable` server hiccup resets the
 *  counter — this is ~1.6s of the session being provably absent. Exported so
 *  codex-tmux's death watch shares the exact `deathTickOutcome` contract rather
 *  than a hand-copied "mirror" that could silently drift. */
export const DEATH_MISS_THRESHOLD = 4;
/** A log file written within this window vetoes a death: the agent is provably
 *  alive, so a lone `gone` probe that raced a kill/recreate can't settle it.
 *  Exported and shared with codex-tmux (see `DEATH_MISS_THRESHOLD`). */
export const DEATH_JSONL_QUIET_MS = 3_000;

/**
 * Settle an in-flight turn (or a held task — see below) because its tmux
 * session died unexpectedly.
 *
 * While a turn is genuinely in flight, emits the shared
 * `SESSION_DIED_STATUS_PREFIX` sentinel (which the orchestrator's chunk
 * handler pattern-matches to flip the card to `blocked` and mark the run's
 * handle), then resolves the active turn so the done handler runs — exactly
 * mirroring the claude API-error path, where the outcome is driven by the
 * handle flag, not the exit code.
 *
 * When there's no turn in flight and death fired only because the task is
 * held open for background agents, the sentinel would lie: there's no
 * active handle for the orchestrator to flip to `blocked`, so a held task
 * actually releases to `review` instead. That case emits a plain status
 * chunk WITHOUT the sentinel prefix — see the held branch below.
 *
 * No-ops when no turn is in flight AND the task isn't held for background
 * agents (`heldProbeSafe`): if the final flush already popped the slot
 * (the turn genuinely completed a beat before the session vanished) and
 * nothing is holding the card open, there's nothing to settle — an idle
 * session dying between turns is out of scope (the card isn't "running"; a
 * re-run self-heals via spawn's pre-kill). When the task IS held, the main
 * run already resolved so there's no slot/onEndOfTurn to settle below (both
 * branches are skipped harmlessly) — this call still emits the held-death
 * status (via `state.lastChunk`, the succeeded run's handler) and,
 * unconditionally at the bottom, orphans any still-`running` subagent rows,
 * which is what lets the orchestrator's settle hook release the hold.
 */
function signalSessionDeath(state: SessionState): void {
  const inFlight = turnInFlight(state);
  if (!inFlight && !heldProbeSafe(state.taskId)) return;
  // The turn (if any) is being settled by a different sentinel below — an
  // armed slash token has nothing left to watch for.
  state.pendingSlashToken = null;
  const slot = state.turnQueue[0];
  const onChunk = slot?.onChunk ?? state.lastChunk ?? (() => {});
  onChunk(
    "status",
    inFlight
      ? `${SESSION_DIED_STATUS_PREFIX}tmux session ${state.sessionName} ended unexpectedly — task blocked`
      // Held-probe-driven death, no active turn: the main run already
      // resolved, so there's no handle for the orchestrator to flip to
      // `blocked` — the task actually releases to `review`. Say so honestly
      // instead of reusing the sentinel, which the orchestrator would
      // otherwise pattern-match into a "blocked" breadcrumb that never
      // happens for this path.
      : `tmux session ${state.sessionName} ended while background agents were running — releasing task`,
  );
  if (slot && slot.resolve) {
    state.turnQueue.shift();
    state.lastChunk = slot.onChunk;
    const resolve = slot.resolve;
    slot.resolve = null;
    slot.reject = null;
    resolve(0);
  } else if (state.onEndOfTurn) {
    const handler = state.onEndOfTurn;
    state.onEndOfTurn = null;
    handler();
  }
  // The session is a corpse — stop tailing it. Leave the sessions map entry +
  // the (now-empty) turnQueue intact; a subsequent re-run replaces this state
  // via spawnClaudeViaTmux's pre-kill. Deliberately do NOT reject remaining
  // slots (the only in-flight one was just resolved) — a spurious "session
  // killed" rejection would double-settle the run.
  state.watcher?.close();
  state.watcher = null;
  if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
  if (state.scrapeTimer) { clearInterval(state.scrapeTimer); state.scrapeTimer = null; }
  // The session is gone, so a notification-triggered watchdog waiting on it
  // will never see content or a normal end-turn either way — cancel rather
  // than let it fire redundantly (harmlessly, since `fireContinuationWatchdog`
  // would just find an empty/mismatched queue head — but there's nothing to
  // gain by leaving it ticking on a dead session).
  clearContinuationWatchdog(state);
  state.subagentWatcher?.detach();
  state.subagentWatcher = null;
  // The tmux session is provably gone, so nothing will ever write another
  // subagent transcript line for this task — a still-`running` subagent row
  // would otherwise hold the task in `running` forever waiting on an agent
  // that no longer exists. Release it the same way the run itself is
  // released above.
  orphanRunningSubagents(state.taskId);
}

/**
 * Settle an in-flight turn because a BACKGROUND agent's own transcript
 * emitted an API-error line (`isApiErrorMessage: true` — 529 Overloaded,
 * 400, any status; see `mapJsonlEventToChunks`). `claude-subagents.ts`'s
 * tailer has already settled that subagent's own row `failed` by the time
 * this fires (see `attachSubagentWatcher`'s `onApiError` — wired below in
 * `attachTailer`); this module-side half propagates that failure to the
 * PARENT turn, which the subagent tailer cannot do itself — it is read-only
 * w.r.t. the agent and has no `SessionState` to act on.
 *
 * Reuses `CLAUDE_API_ERROR_STATUS_PREFIX`, the same sentinel the main
 * stream's own API errors emit, so the orchestrator's chunk handler needs
 * zero changes: prefix match → `handle.apiError = true` +
 * `updateColumn(taskId, runId, "blocked", "api-error")`; the done handler
 * folds that into run `failed` — identical to a main-stream API error.
 *
 * Mirrors `signalSessionDeath`'s in-flight settle mechanics exactly (emit
 * the sentinel via the head slot's `onChunk`, resolve the slot / fire
 * `onEndOfTurn`) but performs NONE of its teardown: the tmux session is
 * provably alive — a background agent errored, not the session itself — so
 * the JSONL watcher, poll/scrape timers, and the subagent watcher all stay
 * attached, and `orphanRunningSubagents` is deliberately NOT called. Other
 * background agents may legitimately still be running and must keep being
 * tailed (#92 semantics: only the errored subagent's own row settles).
 *
 * Won't-fix, by design: after this settle, a GENUINELY recovering main
 * agent's next assistant line can trigger `maybeAdoptContinuation`,
 * resurrecting the card from `blocked` to a fresh continuation run. That's
 * intentional self-healing, not a bug — the aborted run stays `failed`; a
 * real recovery lands as its own adopted run. The truly-stuck case (no more
 * assistant lines ever arrive) simply stays `blocked`, which is the whole
 * point of this feature.
 */
function signalSubagentApiError(
  state: SessionState,
  info: { subagentId: string; detail: string; runId: string },
): void {
  if (!turnInFlight(state)) {
    // No active turn to abort — the tailer already settled the subagent's
    // own row and already called `fireSettle`, which is what lets a held
    // task (main run already succeeded, only background agents keep it
    // open) release to `review` on its own. There is no main-turn handle
    // here to flip to `blocked`. If the task IS held, still leave a
    // breadcrumb on the main stream so the failure isn't silent — mirrors
    // `signalSessionDeath`'s held branch ("say so honestly instead of
    // reusing the sentinel": there's no handle for the orchestrator to flip
    // to `blocked`, so a sentinel here would just lie). Neither in flight
    // nor held: truly nothing to do.
    if (heldProbeSafe(state.taskId)) {
      const onChunk = state.lastChunk ?? (() => {});
      onChunk(
        "status",
        `background agent hit an API error (${info.detail}) — it stopped; task releases when `
          + `remaining agents finish`,
      );
    }
    return;
  }
  // Run association: a STALE async subagent spawned by an OLDER run can
  // error while a NEWER run is in flight on this same session — settling
  // here would wrongly abort the new run over an old failure. `TurnSlot`
  // carries no run id (verified: `interface TurnSlot` above is just
  // `{ onChunk, resolve, reject }`), so this can't be checked locally;
  // resolved via the same orchestrator-injected-probe seam as
  // `heldSessionProbe` (`setActiveRunProbe`, wired in orchestrator.ts next
  // to `setHeldSessionProbe`). Unset `activeRunProbe` (unit tests that
  // drive this function directly, with no orchestrator wiring) allows
  // through unconditionally — same posture as every other probe in this
  // file when unregistered.
  if (activeRunProbe !== null && info.runId !== activeRunProbeSafe(state.taskId)) return;
  // The turn is being settled by a different sentinel below — an armed
  // slash token / staged end_turn / hold-until-idle latch all have nothing
  // left to watch for. Mirrors `signalUnknownCommand`'s "queue popped ⇒
  // nothing staged" invariant: without clearing `pendingEndTurn`, a stale
  // staged end_turn from BEFORE this abort could pop the user's *retry*
  // slot via the poll's empty-text flush and instantly mis-resolve the new
  // run as succeeded. `holdUntilIdle` likewise has no folded turn left to
  // wait out once the slot underneath it is gone.
  state.pendingSlashToken = null;
  state.pendingEndTurn = null;
  state.holdUntilIdle = false;
  const slot = state.turnQueue[0];
  const onChunk = slot?.onChunk ?? state.lastChunk ?? (() => {});
  onChunk(
    "status",
    `${CLAUDE_API_ERROR_STATUS_PREFIX}background agent aborted: ${info.detail}`,
  );
  if (slot && slot.resolve) {
    state.turnQueue.shift();
    state.lastChunk = slot.onChunk;
    const resolve = slot.resolve;
    slot.resolve = null;
    slot.reject = null;
    resolve(0);
  } else if (state.onEndOfTurn) {
    const handler = state.onEndOfTurn;
    state.onEndOfTurn = null;
    handler();
  }
  // Nothing will end this turn naturally now — cancel any watchdog waiting
  // on it so it can't fire redundantly against an already-settled slot.
  clearContinuationWatchdog(state);
}

/**
 * Settle an in-flight turn because claude's Ink TUI rejected the last-pasted
 * message as an unknown slash command (`Unknown command: /<token>`). No
 * JSONL line is ever written for this — the message was never delivered as
 * a turn — so `scrapeOnce`'s pane scrape is the only signal, gated on
 * `state.pendingSlashToken` being armed (see `slashTokenOf`) and a turn
 * genuinely being in flight (checked by the caller).
 *
 * Mirrors `signalSessionDeath`'s settle mechanics exactly — emit the
 * sentinel `status` chunk via the head slot's `onChunk` (or `onEndOfTurn` on
 * the reattach path), resolve the slot with code 0 — but, UNLIKE session
 * death, the tmux session and claude process stay alive and reusable: we do
 * NOT stop the scrape/death/poll timers or the JSONL watcher. The next turn
 * on this task routes through `sendTurn` exactly as if nothing happened.
 *
 * One-shot: clearing `state.pendingSlashToken` up front is both the disarm
 * and the re-entry guard — a second call (or a stale timer callback) with
 * nothing armed is a no-op.
 */
function signalUnknownCommand(state: SessionState): void {
  const token = state.pendingSlashToken;
  if (!token) return;
  state.pendingSlashToken = null;
  state.pendingEndTurn = null;
  state.holdUntilIdle = false;
  const slot = state.turnQueue[0];
  const onChunk = slot?.onChunk ?? state.lastChunk ?? (() => {});
  onChunk(
    "status",
    `${CLAUDE_UNKNOWN_COMMAND_STATUS_PREFIX}${token} — claude treated the message as a slash `
      + `command; it was not delivered. Edit the message so it doesn't start with "/" and resend.`,
  );
  if (slot && slot.resolve) {
    state.turnQueue.shift();
    state.lastChunk = slot.onChunk;
    const resolve = slot.resolve;
    slot.resolve = null;
    slot.reject = null;
    resolve(0);
  } else if (state.onEndOfTurn) {
    // Symmetry with `signalSessionDeath`; in production this branch can't
    // fire on a genuinely reattached run — `pendingSlashToken` is in-memory
    // and never re-armed after a restart (plan limitation L2) — so it's
    // reachable only from synthetic test states.
    const handler = state.onEndOfTurn;
    state.onEndOfTurn = null;
    handler();
  }
}

/** Explanatory status text `signalIdleSettle` emits immediately before its
 *  "turn complete" banner. Without this, an idle-settle is byte-for-byte
 *  indistinguishable in the transcript from a real end_turn — the user has
 *  no way to tell agetor made a judgment call here rather than claude
 *  actually finishing normally. Deliberately NOT sharing a prefix with any
 *  other status sentinel (`CLAUDE_UNKNOWN_COMMAND_STATUS_PREFIX`,
 *  `SESSION_DIED_STATUS_PREFIX`, `CLAUDE_API_ERROR_STATUS_PREFIX`) — this is
 *  informational only, never something the orchestrator's chunk handler
 *  pattern-matches on to change the task's column. */
const IDLE_SETTLE_STATUS_TEXT =
  `agetor closed this turn — claude sat idle at the input box for ${Math.round(STUCK_TURN_FALLBACK_MS / 1000)}s with no end_turn`;

/**
 * Settle an in-flight turn because the watchdog observed claude idle at its
 * own input box (`paneShowsIdleInputBox`) for `STUCK_TURN_FALLBACK_MS`, with
 * `scrapeIdleSettleStreak` stable for `UNPARSABLE_STABILITY_TICKS` — proof
 * the turn is over even though no `end_turn` JSONL line ever confirmed it.
 * This is the version-proof net: any future case where claude stops emitting
 * an `end_turn` for a turn that's genuinely finished (not just today's local
 * commands, which `dispatchLine` already settles directly off their own
 * `<local-command-stdout>` line — see that call site) gets closed out here
 * instead of stranding the run `running` forever behind the old "card an
 * idle pane" behavior.
 *
 * Mirrors `signalUnknownCommand`'s settle mechanics but simpler: clear the
 * staging fields, emit `IDLE_SETTLE_STATUS_TEXT` followed by "turn complete"
 * through the live handler — UNLIKE the local-command stdout settle, this
 * one DOES earn the banner, since the run is being closed by agetor's own
 * judgment call rather than by something the user already watched claude
 * print, and the extra status line is what tells the two apart in the
 * transcript — then `popEndOfTurn`, which itself clears `holdUntilIdle` /
 * `pendingSlashToken` / the continuation watchdog and advances the queue
 * (resolves the `SpawnedAgent.done` promise, or fires the reattach
 * `onEndOfTurn` callback).
 *
 * Called from `scrapeOnce`'s idle-settle net once `scrapeIdleSettleStreak`
 * reaches `UNPARSABLE_STABILITY_TICKS` — see that call site for the full
 * gating (turn in flight, quiet past `STUCK_TURN_FALLBACK_MS`, pane
 * genuinely idle at the input box, no ask card, no live tmux prompt for the
 * task).
 */
function signalIdleSettle(state: SessionState): void {
  state.pendingEndTurn = null;
  state.holdUntilIdle = false;
  state.pendingSlashToken = null;
  clearContinuationWatchdog(state);
  const slot = state.turnQueue[0];
  const onChunk = slot?.onChunk ?? state.lastChunk ?? (() => {});
  onChunk("status", IDLE_SETTLE_STATUS_TEXT);
  onChunk("status", "turn complete");
  popEndOfTurn(state);
}

/** Whether a turn is currently in flight on this session — a live head slot
 *  (fresh-spawn / live-stream path) or a pending reattach `onEndOfTurn`. Only
 *  then is there a "running" run to protect from a dead session. */
function turnInFlight(state: SessionState): boolean {
  const slot = state.turnQueue[0];
  return !!(slot && slot.resolve) || !!state.onEndOfTurn;
}

/** Arm the mid-run death watch. Unlike codex (one-shot sessions), a claude
 *  session is long-lived and idle between turns, so we gate the actual
 *  `tmux has-session` subprocess on a turn being in flight — an idle session
 *  dying isn't a "running task" problem (and `signalSessionDeath` would no-op
 *  anyway) UNLESS the task is being held open for background agents
 *  (`heldSessionProbe`, the #92 hold: the main run already resolved but the
 *  kanban card stays `running` while subagents finish). Without probing
 *  during a hold, a session dying mid-hold would go undetected until the
 *  next boot's reconciliation — the poll would hit `!turnInFlight` on every
 *  tick and reset `misses` to 0 forever. While a turn IS in flight (or the
 *  task is held), when the session vanishes we one-shot stop the poll, give
 *  the FS a grace beat to surface any final bytes, flush, then settle via
 *  `signalSessionDeath`. Torn down by `disposeSessionState` (intentional
 *  teardown clears it before the kill, so a Stop/delete can't be mistaken
 *  for an unexpected death). */
function startDeathWatch(state: SessionState): void {
  if (state.deathTimer) return;
  // Only a definitive `gone` probe (tmux server answered, this session absent)
  // counts toward death; an `unreachable` server hiccup on the shared socket
  // resets the counter (see `sessionLiveness`). Require DEATH_MISS_THRESHOLD
  // consecutive `gone` probes, and veto on recent JSONL writes, so a live task
  // is never wrongly blocked. Reset on any tick where the session is alive/
  // unreachable, the JSONL was just written, or no turn is running (and the
  // task isn't held open for background agents).
  // Fork-free liveness: a `kill(pid, 0)` on the pane's process per tick, with
  // the `has-session` fork reserved for confirming a dead pid and for the
  // periodic re-validation that bounds pid reuse (see `createDeathProbe`).
  // One probe per watch — it lives exactly as long as this interval does.
  const probe = createDeathProbe({
    sessionName: state.sessionName,
    authoritative: sessionLiveness,
    resolvePid: panePidFor,
  });
  let misses = 0;
  // Guards a tick against overlapping the previous one now that the
  // authoritative probe is awaited (no timeout — an owner decision, see
  // docs/plans/fix-task-details-load-delay.md §8): without it, a stalled
  // tmux round-trip could let a second 400ms tick start concurrently and
  // double-count a `wait` outcome. Mirrors codex/cursor/gemini-tmux's own
  // death watch, which converted to this same shape for the same reason.
  // The decision logic itself is unchanged.
  let tickInFlight = false;
  state.deathTimer = setInterval(() => {
    if (tickInFlight) return;
    if (!turnInFlight(state) && !heldProbeSafe(state.taskId)) { misses = 0; return; } // idle & not held — skip the poll
    tickInFlight = true;
    void (async () => {
      try {
        // Compute the log-recency veto lazily — it only matters for a `gone`
        // probe, and `gone` is the rare tick, so we skip a statSync on every
        // `alive` poll.
        const liveness = await probe.probe();
        const outcome = deathTickOutcome({
          liveness,
          logFresh: liveness === "gone" && fileWrittenWithin(state.jsonlPath, DEATH_JSONL_QUIET_MS),
          misses,
          threshold: DEATH_MISS_THRESHOLD,
        });
        if (outcome === "reset") { misses = 0; return; }
        if (outcome === "wait") { misses++; return; }
        if (state.deathTimer) { clearInterval(state.deathTimer); state.deathTimer = null; }
        setTimeout(() => {
          flushSync(state);
          signalSessionDeath(state);
        }, DEATH_GRACE_MS);
      } finally {
        tickInFlight = false;
      }
    })();
  }, DEATH_POLL_MS);
}

/** Backstop poll cadence while the session has shown life within the last
 *  `POLL_IDLE_AFTER_MS` — matches the original fixed `setInterval` rate. */
const POLL_FAST_MS = 400;
/** Backstop poll cadence once `lastActivityAt` has been quiet for
 *  `POLL_IDLE_AFTER_MS` or longer. fs.watch stays the primary signal (its own
 *  callback flushes immediately, independent of this timer) — this only
 *  changes how often the cheap "did fs.watch miss anything" stat-and-read
 *  backstop runs for a session nobody is doing anything with. Never fully
 *  stops (see the scraper's own idle-throttle comment for why a hard stop
 *  would be wrong here too: a native AskUserQuestion modal writes no JSONL,
 *  so something must keep noticing when the session goes busy again). */
const POLL_SLOW_MS = 5_000;
/** How long the session must be quiet before the backstop poll backs off
 *  from `POLL_FAST_MS` to `POLL_SLOW_MS`. */
const POLL_IDLE_AFTER_MS = 30_000;

/**
 * Arm (or re-arm) the JSONL backstop poll. Self-rescheduling `setTimeout`
 * rather than a fixed `setInterval`: each tick decides the NEXT tick's delay
 * from how long the session has been quiet, so the cadence backs off to
 * `POLL_SLOW_MS` on its own once idle, and — because `rearmPollTimerFast`
 * below cancels and reschedules on any fresh activity — snaps back to
 * `POLL_FAST_MS` immediately rather than waiting out a stale long wait.
 * Chained after `flush` settles (not fire-and-forget) so a slow flush can't
 * pile up overlapping poll ticks against the same session.
 */
function armPollTimer(state: SessionState, delayMs: number = POLL_FAST_MS): void {
  // Capture the handle by identity rather than relying on `state.pollTimer`'s
  // truthiness: `rearmPollTimerFast` (fs.watch callback) can fire *while*
  // this tick's `flush` is still awaiting, clear+replace `state.pollTimer`
  // with a brand-new chain, and then this tick's `.finally` would see a
  // truthy-but-different pollTimer and reschedule anyway — spawning a second
  // independent self-rescheduling chain that multiplies every time that
  // race repeats. Comparing against the exact handle this closure owns means
  // only the chain `state.pollTimer` still actually points at may continue.
  const handle: ReturnType<typeof setTimeout> = setTimeout(() => {
    // `disposeSessionState` / `signalSessionDeath` null `pollTimer`
    // synchronously on teardown; a superseding `armPollTimer` call (via
    // `rearmPollTimerFast`) overwrites it with a different handle. Either
    // way, if `state.pollTimer` isn't this handle anymore, this chain is
    // stale — don't run its flush.
    if (state.pollTimer !== handle) return;
    void flush(state).finally(() => {
      if (state.pollTimer !== handle) return;
      const idleMs = Date.now() - state.lastActivityAt;
      armPollTimer(state, idleMs >= POLL_IDLE_AFTER_MS ? POLL_SLOW_MS : POLL_FAST_MS);
    });
  }, delayMs);
  state.pollTimer = handle;
}

/** Cancel whatever poll tick is pending and re-arm at `POLL_FAST_MS`
 *  immediately. Called from every place that counts as "fresh activity" for
 *  the poll cadence specifically (fs.watch events, a turn starting, a folded
 *  follow-up paste) so a session that's been backed off to `POLL_SLOW_MS`
 *  doesn't wait out a stale long tick before resuming full-rate backstop
 *  polling. No-op when no poll timer is armed yet (pre-`attachTailer`, or an
 *  already-disposed session) — nothing to snap back to. */
function rearmPollTimerFast(state: SessionState): void {
  if (!state.pollTimer) return;
  clearTimeout(state.pollTimer);
  armPollTimer(state, POLL_FAST_MS);
}

function attachTailer(state: SessionState): void {
  // Drain whatever's already in the file (claude may have written events
  // before our watcher attached).
  void flush(state);
  state.watcher = fsWatch(state.jsonlPath, { persistent: false }, () => {
    void flush(state);
    rearmPollTimerFast(state);
  });
  // Backstop poll. macOS fs.watch (FSEvents/kqueue) coalesces rapid appends
  // and drops notifications on slow append-only streams — we saw a real run
  // where the first event came through fine and then 16 more events silently
  // accumulated in the JSONL without firing the watcher. A 400ms tick is
  // cheap (one stat + read-if-grew) and bulletproof; it backs off to
  // `POLL_SLOW_MS` after `POLL_IDLE_AFTER_MS` of quiet (see `armPollTimer`).
  armPollTimer(state);
  startScraper(state);
  startDeathWatch(state);
  // Track any background/sub agents this session spawns. Idempotent re-arm:
  // dispose a prior handle first so a re-attach (reconcileOrphans defensive
  // overwrite) can't leave two watchers polling the same dir.
  state.subagentWatcher?.detach();
  state.subagentWatcher = attachSubagentWatcher({
    taskId: state.taskId,
    jsonlPath: state.jsonlPath,
    onApiError: (info) => signalSubagentApiError(state, info),
  });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Public entry points.
 * ────────────────────────────────────────────────────────────────────────── */

/** How often `spawnClaudeViaTmux`'s deferred-paste loop polls `readPaneMode`
 *  while waiting for a large prompt's target session to reach an idle
 *  composer. Same cadence as the startup-dialog poller (STARTUP_DIALOG_POLL_MS)
 *  — frequent enough to paste promptly once claude draws, cheap enough to run
 *  for the duration of the timeout below. */
const DEFERRED_PROMPT_POLL_MS = 400;
/** Bound on how long the deferred-paste loop waits for a confirmed-idle
 *  composer before pasting best-effort anyway. Generous — matches
 *  BOOT_TIMEOUT_MS below — because the same startup work (auth probe,
 *  plugin/skill scan, model warmup) that can delay the JSONL also delays the
 *  composer. Deliberately the same literal as `BOOT_TIMEOUT_MS`: both bound
 *  the same claude startup work, so keeping them numerically co-sized reads
 *  naturally, but they're independent constants — there's no shared source
 *  and no requirement to change one when the other changes. */
const DEFERRED_PROMPT_TIMEOUT_MS = 30_000;

/**
 * Start a new claude tmux session for the task. Two delivery modes for the
 * initial prompt, chosen by `agents.ts` before this is called:
 *
 *   - Common case: the prompt rides inside `opts.argv` (claude's documented
 *     `claude "query"` form), so we don't paste anything via tmux for the
 *     first turn — claude submits it itself on startup.
 *   - Large prompt (`opts.deferredPrompt` set, `opts.argv` carries none):
 *     `argv` boots a bare claude with no initial query, and once the
 *     composer is confirmed idle (or a bounded timeout elapses) the prompt
 *     is pasted in via the same load-buffer/paste-buffer machinery
 *     live-session follow-ups use — see the deferred-paste block below.
 *
 * Assumes `sessionExists(taskId)` is false; the caller (orchestrator) is
 * responsible for routing follow-up turns through `sendTurn`.
 */
export async function spawnClaudeViaTmux(opts: ClaudeLaunchOptions): Promise<SpawnedAgent> {
  const sessionName = sessionNameFor(opts.taskId);

  // Defensively clear any stale same-named session before (re)creating it, so
  // `tmux new-session` can't fail with "duplicate session". This matters now
  // that boot reconciliation no longer sweeps un-reattached sessions (see
  // `reconcileOrphans`): an idle claude session survives a restart, so a fresh
  // run of the same task must reset it. Own-scoped (only this task's name) and
  // idempotent/silent on miss — mirrors codex's spawn pre-kill.
  await killTaskSession(opts.taskId);

  // Clean up any stale agetor settings before tmux starts so claude reads a
  // tidy `.claude/settings.local.json` on launch. agetor is non-invasive: it
  // installs no PreToolUse hook and no MCP server. This call only STRIPS a
  // stale agetor PreToolUse entry / `mcpServers.agetor` key a previous build
  // wrote (so claude doesn't error launching a deleted MCP launcher) and
  // self-heals permission rules in owned worktrees. Owned worktrees get a
  // self-heal-safe pass; user-repo cwds (isolation=none) get a merge pass
  // that preserves all existing user config.
  await ensureInstalledForCwd(opts.cwd, opts.mode);

  // Build the tmux command. `-e KEY=VAL` injects env vars into the new
  // session (so the spawned claude inherits them); `--` separates the tmux
  // flags from the command to run. `buildClaudeSessionEnv` layers agetor's
  // forced pins (PATH re-injection, classic-renderer) over the caller env —
  // see that helper for the full rationale.
  //
  // We no longer inject AGETOR_API_PORT/TOKEN/TASK_ID: with the PreToolUse hook
  // and the ask_user MCP both gone, nothing in the spawned claude reads them,
  // and AGETOR_API_TOKEN gates every orchestration route — no reason to expose
  // it to the agent's environment.
  const fullEnv = buildClaudeSessionEnv(opts.env);
  const tmuxArgs: string[] = ["new-session", "-d", "-s", sessionName, "-c", opts.cwd];
  for (const [k, v] of Object.entries(fullEnv)) tmuxArgs.push("-e", `${k}=${v}`);
  tmuxArgs.push("--", ...opts.argv);

  const launch = await tmux(tmuxArgs);
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
    // The effort this process is actually pinned to. `ClaudeLaunchOptions` has
    // no `effort` field — `agents.ts`'s `buildCommand` translates the task's
    // effort id into the `CLAUDE_CODE_EFFORT_LEVEL` env var (dropping ids
    // claude doesn't know), and that env is what reaches us as `opts.env` and
    // then `fullEnv`. Reading it back off the env we are about to launch WITH
    // is therefore the one source that can't disagree with the process: no
    // second translation, no chance of recording an id that got filtered out.
    // Absent for a model that declines effort → null.
    launchEffort: fullEnv.CLAUDE_CODE_EFFORT_LEVEL ?? null,
  });
  // Dispose any prior state for this task before overwriting the map entry, so
  // a re-run (the previous session persisted, then the user hit Run again)
  // doesn't leak the old state's watcher + poll/scrape/death timers. Mirrors
  // reattachSession's defensive pre-dispose. Safe on a fresh task (no-op on
  // undefined); on a re-run the old turn is already terminal so no queued slot
  // is rejected. `orphanSubagents: true` — `killTaskSession` above already
  // killed the prior session, so any of its rows still `status='running'`
  // are provably never going to hear from their agent again.
  disposeSessionState(sessions.get(opts.taskId), true);
  sessions.set(opts.taskId, state);

  // Keep a handle on the pushed slot (mirrors `sendTurn`'s idiom below) so
  // the deferred-paste loop can (a) recognise cancellation — `kill()`
  // splices `turnQueue` without touching `sessions`, so slot-presence is the
  // only reliable "has this launch been cancelled?" signal — and (b) settle
  // this exact slot on a paste failure instead of leaving the run `running`
  // forever.
  // slashCommand seeded null here and filled in a few lines down (both the
  // embedded-argv and deferred-paste branches below), once we actually know
  // the initial prompt text — see `TurnSlot.slashCommand`'s doc. Safe: this
  // is plain synchronous object mutation, so it's settled before any JSONL
  // line for this turn could possibly reach `dispatchLine`.
  const initialSlot: TurnSlot = { onChunk: opts.onChunk, resolve: null, reject: null, slashCommand: null };
  const done = new Promise<number>((resolve, reject) => {
    initialSlot.resolve = resolve;
    initialSlot.reject = reject;
  });
  state.turnQueue.push(initialSlot);
  // Brand-new session has no prior turn to inherit metadata from, but
  // seed `lastChunk` so any metadata claude writes before its first
  // user/assistant entries (e.g. permission-mode banner) still lands on
  // the opening run's stream.
  state.lastChunk = opts.onChunk;

  // Argv-prompt spawn path: the small-prompt case already embedded the
  // opening message as the final `-- <prompt>` pair in `opts.argv`, baked
  // into the `tmux new-session` command dispatched above — there is no
  // separate paste call after this point to arm at, so arm right here, as
  // soon as the SessionState exists. (Mirrors `sendTurn`/`pasteFollowUp`;
  // the large-prompt `deferredPrompt` case arms itself right where it's
  // actually pasted, further down.) A no-op (armed to null) when
  // `deferredPrompt` is set — that branch below owns arming for its prompt.
  if (!opts.deferredPrompt) {
    const argv = opts.argv;
    const embeddedPrompt = argv.length >= 2 && argv[argv.length - 2] === "--"
      ? argv[argv.length - 1]
      : undefined;
    const embeddedSlashCommand = embeddedPrompt ? slashTokenOf(embeddedPrompt) : null;
    state.pendingSlashToken = embeddedSlashCommand;
    // Same derivation feeds the turn slot itself — see `TurnSlot.slashCommand`.
    initialSlot.slashCommand = embeddedSlashCommand;
  }

  // Large-prompt delivery: `buildCommand` (agents.ts) omits any prompt over
  // CLAUDE_PROMPT_ARGV_MAX_BYTES from argv — embedding it would blow tmux's
  // client-command cap and fail `new-session` outright — and hands it back
  // as `deferredPrompt` instead. Paste it in once claude's composer is
  // confirmed idle (`readPaneMode` returns non-null). Known startup consent
  // dialogs (the bypass-permissions warning, trust-folder prompt) are handled
  // for free: the boot poller below auto-confirms those, and the composer
  // can't be idle while one is still painted over it. A *generic* startup
  // question (something only the user can answer — see the boot poller's
  // "other interactive question" branch) is different: it surfaces as a
  // `tmux_prompt` card, and pasting over it would corrupt whatever partial
  // answer is on screen. So each readiness window that times out re-checks
  // `activeTmuxPromptsForTask` and, if one is still pending, re-arms instead
  // of pasting — mirroring the boot JSONL-wait's re-arm loop a few dozen
  // lines down. Fire-and-forget, wrapped in try/catch so a throw here can
  // never become an unhandled rejection (mirrors the boot-dialog poller's
  // posture a few lines down) — this must never affect the JSONL boot wait
  // itself.
  if (opts.deferredPrompt) {
    const deferredPrompt = opts.deferredPrompt;
    opts.onChunk(
      "status",
      "prompt too large for launch argv — delivering via paste once claude is ready",
    );
    void (async () => {
      try {
        // `kill()` (a cancel, or any other path that settles/removes the
        // initial slot) splices it out of `turnQueue` without touching
        // `sessions` or the tmux session itself, so neither of the liveness/
        // identity checks below would ever catch a cancel on their own —
        // slot-presence is the signal. Checked on every poll tick, on every
        // re-arm, and immediately before the final paste attempt.
        const slotLive = () => state.turnQueue.includes(initialSlot);
        let ready = false;
        windows: for (;;) {
          const deadline = Date.now() + DEFERRED_PROMPT_TIMEOUT_MS;
          while (Date.now() < deadline) {
            if (!(await tmux(["has-session", "-t", "=" + sessionName])).ok) return; // session died — nothing to paste into
            if (sessions.get(opts.taskId) !== state) return; // superseded by a newer spawn/reattach
            if (!slotLive()) return; // cancelled (or otherwise settled) — never paste over it
            if ((await readPaneMode(state)) !== null) { ready = true; break windows; }
            await Bun.sleep(DEFERRED_PROMPT_POLL_MS);
          }
          // Window timed out. Don't paste over an unanswered startup
          // question — re-arm a fresh window instead, as long as there's
          // still something to wait for.
          if (activeTmuxPromptsForTask(opts.taskId).length === 0) break;
          if (!(await tmux(["has-session", "-t", "=" + sessionName])).ok) return;
          if (sessions.get(opts.taskId) !== state) return;
          if (!slotLive()) return;
        }
        // Re-check liveness/identity before the final attempt — the loop can
        // exit via the timeout with the session still alive, and a dropped
        // prompt is worse than a best-effort paste into whatever's on screen.
        if (!(await tmux(["has-session", "-t", "=" + sessionName])).ok) return;
        if (sessions.get(opts.taskId) !== state) return;
        if (!slotLive()) return; // cancelled during the final liveness check
        if (!ready) {
          opts.onChunk("status", "claude readiness never confirmed — delivering prompt anyway");
        }
        // Arm the unknown-command lookout right at the actual delivery point
        // — mirrors `sendTurn`/`pasteFollowUp`. (The small-prompt argv case
        // arms right after SessionState is created instead, since its
        // "paste" already happened via the launch argv before this function
        // even returned.)
        const deferredSlashCommand = slashTokenOf(deferredPrompt);
        state.pendingSlashToken = deferredSlashCommand;
        // Same derivation feeds the turn slot itself — see `TurnSlot.slashCommand`.
        // Safe to set here, still ahead of the actual paste below: nothing
        // can dispatch a JSONL line for this turn before the prompt is
        // physically delivered into the pane.
        initialSlot.slashCommand = deferredSlashCommand;
        // Prompt paste is a life signal — matters here specifically because
        // boot (and the readiness wait above) can take up to
        // DEFERRED_PROMPT_TIMEOUT_MS, well past the construction-time stamp
        // `makeSessionState` set. `attachTailer` (and its pollTimer) hasn't
        // run yet at this point — `rearmPollTimerFast` would no-op — so only
        // the idle-clock bump applies here.
        bumpActivity(state);
        void queuePaste(opts.taskId, sessionName, deferredPrompt, 0, state, {
          bracketed: true,
          // The boot poller above already owns deciding when the pane is
          // safe to paste into: it only reaches this call once
          // `readPaneMode` confirmed an idle composer (or the readiness
          // window timed out with no answerable prompt left), re-arming
          // instead of pasting whenever `activeTmuxPromptsForTask` still has
          // something pending. BUT that give-up branch — the readiness
          // window timing out with `activeTmuxPromptsForTask` already empty
          // — reaches this paste with NO card registered for whatever is
          // actually on the pane: precisely the un-carded, footer-armed case
          // `paneShowsBlockingPrompt`'s guard exists to catch (finding #6,
          // docs/plans/model-effort-local-command-turns.md §10). So this
          // does NOT fully `skipModalGuard`: the CHECK must still run once,
          // even though a WAIT would be pointless — this poller already
          // spent up to `DEFERRED_PROMPT_TIMEOUT_MS` deciding the pane was
          // safe, so a fresh multi-second grace window here would just
          // delay a prompt that's already known to be ready (or already
          // given up waiting).
          modalGuardGraceMs: 0,
          onPasteFailure: () => {
            // Mirror `sendTurn`'s onPasteFailure idiom exactly: guard against
            // the (theoretical) race where the slot already popped normally
            // between the paste call and this failure callback, remove it
            // from the queue if still present, then reject `done` so the run
            // settles instead of hanging in `running` forever.
            if (!initialSlot.reject) return;
            const idx = state.turnQueue.indexOf(initialSlot);
            if (idx !== -1) state.turnQueue.splice(idx, 1);
            const reject = initialSlot.reject;
            initialSlot.resolve = null;
            initialSlot.reject = null;
            reject(new Error("paste failed"));
          },
        });
      } catch { /* never let the deferred-paste poller crash the spawn */ }
    })();
  }

  // Bounded wait for claude to create the JSONL. This is just claude's
  // bootup (auth probe, plugin/skill scan, model warmup, MCP initialize on
  // configured servers). Generous because on big projects the local
  // skill scan can take 15s+; the fs.watch trigger means we attach as
  // soon as it appears regardless.
  const BOOT_TIMEOUT_MS = 30_000;
  (async () => {
    // Concurrently watch the boot pane for a dialog blocking claude from ever
    // writing its JSONL. Two classes are handled:
    //
    //   (1) Known consent dialogs (the `--dangerously-skip-permissions` bypass
    //       warning, or the trust-folder prompt). Auto-confirm — each maps to
    //       a choice the user already made (see STARTUP_CONSENT_DIALOGS).
    //   (2) Any OTHER interactive question claude poses before its JSONL exists
    //       — e.g. the "Claude in Chrome extension detected" trust prompt a
    //       version bump can introduce. We can't answer these for the user, so
    //       we surface them as a normal interactive tmux_prompt card and let
    //       the user decide; the boot wait below keeps the run alive while such
    //       a prompt is outstanding instead of letting it die at the timeout.
    //
    // Without this a blocking dialog sits unanswered until BOOT_TIMEOUT_MS and
    // the run dies with the dialog stranded on the pane. The poller self-stops
    // the moment the JSONL appears, the session dies, or boot settles.
    let bootSettled = false;
    let lastConfirmedFingerprint: string | null = null;
    let lastGenericFingerprint: string | null = null;
    // Set by the poller whenever a startup question is on the pane during the
    // current boot-wait window; read (and reset) by the wait loop so a window
    // in which the user was being asked something never counts toward the
    // timeout. Shared scope with the wait loop below.
    let sawStartupPromptThisWindow = false;
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
          if (!(await tmux(["has-session", "-t", "=" + sessionName])).ok) return;
          const pane = (await tmux(["capture-pane", "-p", "-t", sessionName])).stdout;
          // A startup prompt we already surfaced and is still awaiting the
          // user keeps the boot window from expiring under them.
          if (activeTmuxPromptsForTask(opts.taskId).length > 0) {
            sawStartupPromptThisWindow = true;
          }
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
          if (m) {
            // A consent dialog is on the pane — never also treat it as a
            // generic question (its repaint frames must not leak into an
            // interactive card while we auto-confirm it).
            lastGenericFingerprint = null;
            if (m.fingerprint !== lastConfirmedFingerprint) {
              if (await confirmStartupDialog(opts.taskId, sessionName, m)) {
                lastConfirmedFingerprint = m.fingerprint;
                opts.onChunk("status", `claude startup dialog auto-confirmed (${m.name})`);
              }
            }
            continue;
          }

          // Not a known consent dialog. If claude is showing some other
          // numbered / yes-no question, surface it interactively so the user
          // can answer and unblock boot. Mirror the runtime scraper's tail
          // slice, two-tick stability gate, and external-dismissal sweep.
          const paneLines = pane.split("\n");
          const tail = paneLines.slice(Math.max(0, paneLines.length - SCRAPE_TAIL_LINES)).join("\n");
          // Footer arm only — no turn is in flight during boot, so the
          // stuck-turn watchdog arm doesn't apply here (see
          // `matchUnparsableModal`). This is the fix for the screenshotted
          // 2.1.234 auto-mode wizard, which appears pre-JSONL. Same working-
          // chrome gate as the runtime scraper (`paneShowsClaudeWorking`) — a
          // real startup wizard has no working chrome, so it still surfaces;
          // the `MODAL_NOTICE_RE` auto-continue veto lives inside
          // `matchUnparsableModal` itself, so it already applies here too.
          // `pickScrapeMatch` (finding #9) is the SAME chain the runtime
          // scraper uses, with `watchdogArmed: false` — see its own doc.
          const generic = pickScrapeMatch(tail, { paneWorking: paneShowsClaudeWorking(tail), watchdogArmed: false });
          if (!generic) { lastGenericFingerprint = null; continue; }
          // External dismissal: a previously surfaced startup prompt whose
          // content no longer matches the pane (user answered it from a real
          // `tmux attach`) — resolve it so the card clears.
          for (const pending of activeTmuxPromptsForTask(opts.taskId)) {
            if (pending.fingerprint !== generic.fingerprint) {
              answerTmuxPrompt(pending.id, { key: "__external__" });
            }
          }
          if (lastGenericFingerprint !== generic.fingerprint) {
            lastGenericFingerprint = generic.fingerprint;
            continue; // require two consecutive identical scrapes
          }
          if (findTmuxPromptByFingerprint(opts.taskId, generic.fingerprint)) {
            sawStartupPromptThisWindow = true;
            continue; // already on a card
          }
          // Just answered this exact dialog? It can linger on the pane for a
          // tick while tmux/claude repaint — re-carding it would flash a ghost
          // duplicate. The answer route stamps `recentlyAnsweredFingerprints`
          // on this same SessionState via `markTmuxPromptAnswered`; honour it
          // here exactly as the runtime scraper (`scrapeOnce`) does.
          if (state.recentlyAnsweredFingerprints.has(generic.fingerprint)) continue;
          // Need an active run to attach the interaction to. The orchestrator
          // sets task.runId before spawning, so this is populated by boot time.
          const runId = tasks.get(opts.taskId)?.runId;
          if (!runId) continue;
          registerTmuxPrompt({
            taskId: opts.taskId,
            runId,
            paneText: generic.paneText,
            choices: generic.choices,
            cursorIndex: generic.cursorIndex,
            nav: generic.nav,
            fingerprint: generic.fingerprint,
            unparsable: generic.unparsable,
            confirmKey: generic.confirmKey,
          });
          sawStartupPromptThisWindow = true;
          opts.onChunk("status", "claude is asking a question on startup — answer it to continue");
        }
      } catch { /* never let the boot poller crash the spawn */ }
    })();

    // Wait for the JSONL, re-arming for another full window whenever a startup
    // question was on the pane during the just-elapsed one. This is what keeps
    // a run that's legitimately waiting on the user from dying at the timeout,
    // and gives claude a fresh window to write its JSONL after the answer
    // lands — without it, a question answered late in the window would race
    // the deadline. A genuinely hung boot (no question ever shown) still fails
    // at BOOT_TIMEOUT_MS because the flag stays false. We only re-arm while the
    // tmux session is still alive: a Stop/delete mid-boot kills the session and
    // resolves any pending prompt, so without this guard a window that *had*
    // seen a prompt would arm one more full BOOT_TIMEOUT_MS before the cleanup
    // branch runs.
    let found = false;
    for (;;) {
      sawStartupPromptThisWindow = false;
      found = await waitForJsonlAt(jsonlPath, BOOT_TIMEOUT_MS);
      if (found) break;
      const blockedOnUser =
        sawStartupPromptThisWindow || activeTmuxPromptsForTask(opts.taskId).length > 0;
      if (blockedOnUser && (await tmux(["has-session", "-t", "=" + sessionName])).ok) continue;
      break;
    }
    bootSettled = true;
    if (!found) {
      const stillAlive = (await tmux(["has-session", "-t", "=" + sessionName])).ok;
      // Capture whatever claude actually printed inside the pane so the user
      // sees the real cause (unknown flag, MCP initialize hung, auth prompt
      // waiting, …) rather than just "no JSONL".
      const paneRaw = stillAlive
        ? (await tmux(["capture-pane", "-p", "-t", sessionName, "-S", "-200"])).stdout
        : "";
      const pane = paneRaw.trim() || "(empty — claude has not drawn any TUI output yet)";
      const detail = stillAlive
        ? `claude is up but hasn't written its JSONL yet after ${(BOOT_TIMEOUT_MS / 1000) | 0}s — pane content below`
        : "claude exited before writing its JSONL — check `tmux` / `claude` are installed and you can run `claude` interactively in this cwd";
      opts.onChunk("stderr", `claude session JSONL never appeared: ${detail}`);
      opts.onChunk("stderr", `expected at: ${jsonlPath}`);
      opts.onChunk("stderr", `--- tmux pane ---\n${pane}\n--- end pane ---`);
      await killTaskSession(opts.taskId);
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
  /** The task's agetor mode at reattach time (`task.mode`), used to seed
   *  `SessionState.lastAnnouncedPermissionMode` so the offset-0 JSONL replay
   *  doesn't re-emit a "permission-mode: <mode>" chip for a mode-bearing line
   *  the prior process already announced (those lines carry no uuid, so the
   *  usual seenLineUuids dedup can't catch them). Optional/nullable because
   *  a task can have `mode: null` (defaults to `auto`/`workspace-write`
   *  elsewhere) or reattach can be invoked without task context in tests. */
  mode?: string | null;
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
export async function reattachSession(opts: ReattachOptions): Promise<SpawnedAgent | null> {
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
    // Seed the chip-suppression baseline from the task's mode so the
    // offset-0 JSONL replay doesn't re-announce a mode the prior process
    // already announced (permission-mode lines carry no uuid, so
    // seenLineUuids can't dedup them). Deliberately NOT passed as
    // `permissionMode` — that field feeds `cycleToModeInner`'s "current mode
    // unknown" guard and Shift+Tab cycle math, and seeding it here (rather
    // than leaving it null until the JSONL replay re-hydrates it) would
    // change that guard's semantics on a reattach where the true live mode
    // might differ from the task's last-saved mode.
    lastAnnouncedPermissionMode: opts.mode ? toClaudeModeString(opts.mode) : null,
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
  // A crashed previous process is exactly when a stuck `window-size manual`
  // pin (see `healWindowSize`) would have been left behind — heal it now so
  // a subsequent attach isn't confined to whatever size the pin left.
  // `assumeAlive`: `reattachSession` only runs for sessions `reconcileOrphans`
  // already verified alive, so the internal `sessionExists` probe would be a
  // duplicate round-trip.
  await healWindowSize(opts.taskId, { assumeAlive: true });

  return {
    kill: () => {
      const s = sessions.get(opts.taskId);
      if (!s) return;
      // Stop-the-turn semantics match `makeAgent`: send Ctrl+C, reject any
      // queued slots (none here, but future-proof), reject the reattach
      // done promise so the orchestrator's done-handler records `cancelled`.
      // Drop any staged end_turn so a late-arriving JSONL line can't fire it
      // post-cancel and emit a spurious "turn complete" banner.
      bumpKeystroke(s);
      // Fire-and-forget: `kill` is a sync SpawnedAgent method (shared contract
      // across every driver) and tmux() never throws, so there's nothing to
      // await here — mirrors `makeAgent`'s kill below.
      void tmux(["send-keys", "-t", s.sessionName, "C-c"]);
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
 *
 * `opts.onPasteFailure`, when provided, is invoked with the SAME failing
 * `PasteOutcome` AFTER this function's own internal `onPasteFailure` logic
 * below has already rejected the turn slot — when there was still a slot to
 * reject (docs/plans/model-effort-local-command-turns.md §10 review finding
 * #4) — so a caller that also wants to react to the specific failure (e.g.
 * surface a phase-aware status, or re-stash the prompt) sees the slot
 * already settled, never a race against it. It ALSO fires unconditionally
 * even on the (theoretical) already-popped-slot race, since it's the
 * orchestrator's own phase-aware handling that matters there, not this
 * function's bookkeeping (finding #6, §10 re-review).
 *
 * The returned `SpawnedAgent` carries `pasteOutcome` — a never-rejecting
 * promise for whether the prompt actually reached claude's composer (see the
 * field's doc on `SpawnedAgent`). It is the awaitable twin of the
 * `onPasteFailure` callback: same outcomes, plus the success case, and it
 * always settles even when the queued tmux op is dropped without running.
 */
export async function sendTurn(
  taskId: string,
  prompt: string,
  onChunk: ChunkHandler,
  opts?: { onPasteFailure?: (outcome: Extract<PasteOutcome, { ok: false }>) => void },
): Promise<SpawnedAgent> {
  const state = sessions.get(taskId);
  if (!state) {
    const err = new Error(`no live session for task ${taskId}`);
    onChunk("stderr", err.message);
    return rejectedAgent(taskId, err);
  }
  // A turn starting is a life signal — reset the idle clock and snap the
  // backstop poll back to full rate immediately (relevant when this session
  // had backed off to POLL_SLOW_MS while idle).
  bumpActivity(state);
  rearmPollTimerFast(state);
  // Drain any unprocessed JSONL content under whatever turn is currently
  // active BEFORE pushing the new slot — otherwise a trailing end_turn
  // already in the file would be dispatched against the new slot and
  // pop it immediately. After flushSync, the queue head reflects the
  // truly in-flight turn (or is empty if the previous turn just ended).
  flushSync(state);
  // Arm (or disarm) the unknown-command lookout for THIS turn's prompt —
  // must happen after flushSync (which may itself clear a stale token left
  // over from the previous turn) so the new value sticks.
  state.pendingSlashToken = slashTokenOf(prompt);
  // Keep a handle on the pushed slot (rather than only closing over
  // resolve/reject) so a paste failure below can settle *this specific*
  // slot in-process instead of leaving the run stuck `running` until the
  // next boot-reconcile. `sendTurn` is only ever called on an idle session
  // (a turn already in flight folds through `pasteFollowUp` instead, which
  // pushes no slot), so `turnQueue` is empty before this push and the slot
  // we just pushed is unambiguously the one at the head.
  // slashCommand reuses the exact value just computed for pendingSlashToken
  // above (`slashTokenOf(prompt)`, same input) — see `TurnSlot.slashCommand`.
  const slot: TurnSlot = { onChunk, resolve: null, reject: null, slashCommand: state.pendingSlashToken };
  const done = new Promise<number>((resolve, reject) => {
    slot.resolve = resolve;
    slot.reject = reject;
  });
  state.turnQueue.push(slot);
  // Claude's TUI input buffer accepts keystrokes even mid-response —
  // anything we paste while the agent is thinking gets queued there and
  // replayed as a new user turn once the current one finishes. Our
  // `turnQueue` mirrors that: subsequent end_turn events pop slots in
  // FIFO order.
  //
  // `pasteOutcome` (exposed on the returned `SpawnedAgent`) is settled from
  // `queuePaste`'s `onPasteOutcome` hook, which fires exactly once per paste —
  // success, failure, or "the op was dropped" — so the promise can never hang
  // and never rejects.
  let settlePasteOutcome!: (outcome: PasteOutcome) => void;
  const pasteOutcome = new Promise<PasteOutcome>((resolve) => { settlePasteOutcome = resolve; });
  void queuePaste(taskId, state.sessionName, prompt, 0, state, {
    bracketed: true,
    onPasteOutcome: (outcome) => settlePasteOutcome(outcome),
    onPasteFailure: (outcome) => {
      // Guard against a (theoretical) race where the slot already popped
      // normally between the push above and this failure callback firing —
      // `popEndOfTurn` nulls both `resolve`/`reject` before invoking them,
      // so a non-null `reject` here means the slot is still genuinely
      // pending. Remove it from the queue (if still present) so a later
      // end_turn doesn't try to pop an already-settled slot, then reject
      // `done` so the orchestrator's run settles instead of hanging. This
      // slot-settling half is skipped once the slot already popped — but
      // the caller's own `onPasteFailure` below must still fire regardless
      // (finding #6, §10 re-review): a real paste failure needs the
      // orchestrator's phase-aware handling (backlog re-stash, status text)
      // even on that rare already-popped race, not just when this function's
      // own bookkeeping had something left to do.
      if (slot.reject) {
        const idx = state.turnQueue.indexOf(slot);
        if (idx !== -1) state.turnQueue.splice(idx, 1);
        const reject = slot.reject;
        slot.resolve = null;
        slot.reject = null;
        reject(new Error("paste failed"));
      }
      // Contract (finding #4, docs/plans/model-effort-local-command-turns.md
      // §10 review): invoke the caller's own onPasteFailure AFTER the slot
      // rejection above, with the SAME outcome object.
      opts?.onPasteFailure?.(outcome);
    },
  });
  return makeAgent(taskId, done, pasteOutcome);
}

/**
 * Paste a follow-up user message into a live session's tmux input buffer
 * WITHOUT pushing a turnQueue slot. Used when the user sends a message while
 * a turn is already in flight: claude's TUI queues the keystrokes and replays
 * them as part of the current (often coalesced) response, so we fold the
 * message into the active run instead of opening a new turn slot.
 *
 * Why no new slot (unlike `sendTurn`): claude can coalesce several queued
 * messages into fewer `end_turn` events than messages. One slot per message
 * would then strand the surplus slots in `turnQueue` forever (their runs stuck
 * `running`). With no extra slot there is nothing to strand — the single
 * active slot carries the whole busy period.
 *
 * Sets `state.holdUntilIdle` so the run doesn't resolve on the *intermediate*
 * end_turn between the current response and the folded message — otherwise the
 * task would bounce to `review` while claude is still working on the follow-up.
 * The slot resolves only when claude goes quiet (the idle-fire in `flush`),
 * i.e. "the end is the end."
 *
 * Why no `flushSync` (unlike `sendTurn`): `sendTurn` drains leftover JSONL
 * before pushing its new slot so a stale end_turn can't pop the fresh slot.
 * Here there is no new slot to protect, and running `flushSync` would instead
 * fire a staged `pendingEndTurn` and pop the live slot mid-turn — resolving
 * the active run early. So we set the hold, paste, and nothing else.
 *
 * **Return shape.** `false` when no live session exists (caller falls back to
 * spawning) — deliberately the same falsy value this function has always
 * returned for that case, so every existing `if (pasteFollowUp(…))` /
 * `const delivered = pasteFollowUp(…); if (delivered)` call site keeps
 * working unchanged. On the happy path it now returns an OBJECT rather than
 * `true`:
 *
 *   `{ delivered: true; pasteOutcome: Promise<PasteOutcome> }`
 *
 * `delivered: true` means only what the old `true` meant — a live session
 * exists and the paste has been ENQUEUED — while `pasteOutcome` is the
 * never-rejecting promise for whether those keystrokes actually reached
 * claude's composer (same contract as `SpawnedAgent.pasteOutcome`; settles
 * exactly once, including when the queued op is dropped without running).
 * The two are deliberately separate: enqueueing is synchronous and the
 * caller's optimistic "user" bubble depends on it, but the real delivery
 * verdict only exists a tick or more later.
 *
 * @param opts.onPasteFailure Forwarded verbatim to the underlying
 * `queuePaste` — fires when the paste (including a withheld one, from
 * `queuePaste`'s modal guard) doesn't land. Unlike `sendTurn`, this path
 * pushes no turn slot to settle, so the orchestrator's callback has nothing
 * to reject; it re-stashes `prompt` back into the task's backlog instead, so
 * a message folded in while a live claude modal is up isn't silently lost.
 * The callback and `pasteOutcome` describe the same event — use whichever
 * shape fits the call site; both fire for every failure.
 */
export async function pasteFollowUp(
  taskId: string,
  prompt: string,
  opts?: { onPasteFailure?: (outcome: Extract<PasteOutcome, { ok: false }>) => void },
): Promise<{ delivered: true; pasteOutcome: Promise<PasteOutcome> } | false> {
  const state = sessions.get(taskId);
  if (!state) return false;
  // A folded-in follow-up paste is a life signal — reset the idle clock and
  // snap the backstop poll back to full rate immediately.
  bumpActivity(state);
  rearmPollTimerFast(state);
  state.holdUntilIdle = true;
  // Arm (or disarm) the unknown-command lookout for the folded-in prompt —
  // same rule as `sendTurn`: only a first line starting with "/" arms it.
  // Best-effort here: the in-flight turn's own JSONL lines clear the token
  // (`dispatchLine`), so a folded slash command is only caught when the turn
  // has already gone JSONL-quiet before claude replays it (plan limitation
  // L1 in docs/plans/catch-unknown-command-error.md).
  state.pendingSlashToken = slashTokenOf(prompt);
  let settlePasteOutcome!: (outcome: PasteOutcome) => void;
  const pasteOutcome = new Promise<PasteOutcome>((resolve) => { settlePasteOutcome = resolve; });
  void queuePaste(taskId, state.sessionName, prompt, 0, state, {
    bracketed: true,
    onPasteOutcome: (outcome) => settlePasteOutcome(outcome),
    onPasteFailure: opts?.onPasteFailure,
  });
  return { delivered: true, pasteOutcome };
}

/** How often `sendSlashCommand`'s auto-confirm step re-captures the pane
 *  while waiting for claude's "Switch model?" / "Change effort level?"
 *  confirm (2.1.245) to render. Mirrors `modePollIntervalMs`'s role for
 *  `cycleToMode` — short enough that the common inline (no-confirm) path,
 *  which spends the WHOLE window polling a pane that never shows the modal,
 *  stays cheap. */
const SLASH_CONFIRM_POLL_MS = 200;

/** Total window `sendSlashCommand`'s auto-confirm step waits for the confirm
 *  modal before giving up as a no-op. Claude only pops this confirm when the
 *  value actually changed AND an assistant turn ran since the last switch
 *  (plan §2) — the inline path with no confirm at all is the common case, so
 *  most calls spend this entire window polling nothing. Long enough to
 *  outlast claude's render latency for the confirm without stalling the next
 *  queued tmux op for long. */
const SLASH_CONFIRM_WINDOW_MS = 2_000;

/** Consecutive `paneShowsIdleInputBox` sightings that convince
 *  `sendSlashCommand`'s auto-confirm poll no confirm modal is coming, so it
 *  breaks out early rather than spending the rest of `SLASH_CONFIRM_WINDOW_MS`.
 *  2 (not 1) so a single transient idle-looking frame mid-repaint can't
 *  short-circuit the poll before a confirm that's still about to render. */
const SLASH_CONFIRM_IDLE_BREAK_TICKS = 2;

/**
 * Test seam: how `sendSlashCommand`'s auto-confirm step reads the live pane.
 * Production captures the tmux pane tail (mirrors `captureModePane`'s role
 * for `cycleToMode`); the unit suite swaps in a synthetic pane so it can
 * drive the confirm-detection step without a real claude session.
 */
let captureConfirmPane: (state: SessionState) => Promise<string> = captureTail;

/**
 * Test seam: how `queuePaste`'s modal guard reads the live pane before
 * pasting. Production captures the tmux pane tail; the unit suite swaps in
 * a synthetic pane so it can drive the guard without a real tmux session.
 * Mirrors `captureConfirmPane` immediately above exactly — a SEPARATE seam,
 * deliberately: overriding one must never silently redirect the other.
 */
let capturePastePane: (state: SessionState) => Promise<string> = captureTail;

/**
 * How often `queuePaste`'s modal guard re-captures the pane while a
 * blocking claude modal (`paneShowsBlockingPrompt`) is showing. Mirrors
 * `SLASH_CONFIRM_POLL_MS`'s role for `sendSlashCommand`'s confirm poll. Also
 * `stillBlocking`'s own confirmation-sleep duration. `let`, not `const` — see
 * `__forTest.setPasteModalPollMs`; tests shrink it so guard tests don't pay
 * the full poll cadence.
 */
let PASTE_MODAL_POLL_MS = 250;

/**
 * Total window `queuePaste`'s modal guard waits for a blocking modal to
 * clear before withholding the paste (docs/plans/model-effort-local-
 * command-turns.md §10). Short on purpose: this grace only needs to cover
 * a REPAINT — e.g. the brief window right after `sendSlashCommand`'s
 * auto-confirm step sends its own Enter, before the pane repaints back to
 * an idle composer — not a genuine wait for the user to answer a card. It
 * MUST stay short because `dismissTmuxPrompt` (the card click that actually
 * clears a modal) is serialized on the SAME per-task `queueTmuxOp` chain
 * this guard runs inside: while the guard is polling, a queued dismiss
 * click sits behind it, so a long grace here would make answering the very
 * modal this guard is waiting on feel stuck. `let`, not `const` — see
 * `__forTest.setPasteModalGraceMs`.
 */
let PASTE_MODAL_GRACE_MS = 1_500;

/**
 * Double-sample confirmation used by `queuePaste`'s modal guard before it
 * ever acts on a blocking-pane sighting (docs/plans/model-effort-local-
 * command-turns.md §10 review finding #3): samples `paneShowsBlockingPrompt`
 * once, sleeps `PASTE_MODAL_POLL_MS`, then samples again — resolves `true`
 * only when BOTH samples hit. A single frame can be a mid-repaint transient
 * (an auto-confirm's own Enter still settling back to an idle composer, a
 * modal about to clear) rather than a persistent block; acting on one sample
 * risks withholding — or, at the pre-Enter site, flagging
 * `composerHoldsText` for — a paste that was actually about to be safe.
 *
 * Used at both single-shot guard decisions in `queuePaste`: the pre-paste
 * deadline decision (including the `modalGuardGraceMs: 0` boot-time path,
 * which previously withheld off a bare single sample — "one extra sample,
 * not zero" is exactly what this closes) and the pre-Enter TOCTOU re-check
 * (previously a single synchronous check). NOT used inside the pre-paste
 * polling loop's own `while` condition — that loop already re-samples the
 * pane every `PASTE_MODAL_POLL_MS` tick on its own; this function is only for
 * the "am I about to act on this" moment.
 */
async function stillBlocking(state: SessionState): Promise<boolean> {
  if (!paneShowsBlockingPrompt(await capturePastePane(state))) return false;
  await Bun.sleep(PASTE_MODAL_POLL_MS);
  return paneShowsBlockingPrompt(await capturePastePane(state));
}

/**
 * @internal — no production caller since wave 5 (the dropdown mirror for
 * `/model` uses `mirrorModelViaPicker`, which drives the bare picker and
 * confirms with `s` instead of typing `/model <id>`; `/effort` is never
 * mirrored onto a live session at all — the orchestrator only writes it into
 * the LAUNCH env, `CLAUDE_CODE_EFFORT_LEVEL`, so there's no live-session
 * mirror to send it through). Kept for the test suite, which still drives it
 * directly to exercise the paste-queue + auto-confirm plumbing this shares
 * with `mirrorModelViaPicker` (`autoConfirmSlashModal`). `opts.autoConfirm:
 * "effort"` in particular has no production producer at all today — no code
 * path ever calls `sendSlashCommand(..., { autoConfirm: "effort" })` outside
 * tests — but the branch is left in rather than special-cased away, since a
 * future live-session effort mirror would need exactly this plumbing.
 *
 * Send a slash-command (or any literal keystroke line) to the task's tmux
 * session. The line is pasted via load-buffer + paste-buffer + Enter just like
 * a user prompt, so multi-word commands and embedded spaces survive intact.
 * Returns false when no live session exists for the task — caller decides
 * whether to spawn fresh or surface an error.
 *
 * Historically used by the orchestrator to mirror inline config edits onto a
 * live claude session: `/model <id>`, `/effort <id>`. (Permission-mode
 * changes don't have a slash command — see `cycleToMode`.) Keeping the
 * session alive preserves the conversation context across config changes.
 *
 * @param opts `autoConfirm` names which config dimension this mirror is for
 * (`"model"` / `"effort"`) so a follow-up auto-accepts claude's "Switch
 * model?" / "Change effort level?" confirm on 2.1.245 — the user already
 * chose via the Task Details dropdown, so that confirm shouldn't need a
 * second click. Left `undefined` for a user-typed `/model x` / `/effort x`:
 * claude asked, so the user answers via the ordinary numbered `tmux_prompt`
 * card `matchNumberedModal` still registers for it in the scrape chains.
 *
 * `opts.onPasteFailure` is forwarded verbatim to the underlying `queuePaste`
 * (finding #4, docs/plans/model-effort-local-command-turns.md §10) — fires
 * when the mirror paste is withheld by `queuePaste`'s modal guard (or fails
 * outright). This function pushes no turn slot, so there's nothing here to
 * settle; the orchestrator's callback is what surfaces a
 * "… not applied — claude is waiting on a prompt" status on the task's
 * latest run. `queuePaste`'s own status emit (through
 * `expectedState.turnQueue[0]?.onChunk ?? expectedState.lastChunk`) still
 * fires independently of this — it's a no-op when no handler is listening,
 * so the orchestrator's callback is simply the visible one in practice.
 *
 * When `opts.autoConfirm` is set, a follow-up op is enqueued through the
 * SAME per-task tmux-op chain (`queueTmuxOp` reads `pasteChains.get(taskId)`,
 * which the `queuePaste` call just above set — calling `queueTmuxOp` again
 * synchronously, with no `await` in between, chains this step directly
 * behind the paste AND its `slashCommandSettleMs` settle window without this
 * function needing to await anything itself). That step polls the pane
 * every `SLASH_CONFIRM_POLL_MS` for up to `SLASH_CONFIRM_WINDOW_MS`; on the
 * first `matchSlashConfirmModal(tail, kind)` hit it sends Enter and, only
 * once that send-keys actually succeeds, stamps the fingerprint answered
 * (`markTmuxPromptAnswered` — so a `tmux_prompt` the scraper may have raced
 * into existence for it is not ghost-registered on the next tick — finding
 * #6, docs/plans/model-effort-local-command-turns.md §10 review: stamping
 * BEFORE a send-keys that might still fail would mark the confirm answered
 * when it demonstrably wasn't, leaving nothing to re-card it) and resolves
 * any already-registered prompt for that exact fingerprint immediately
 * (`answerTmuxPrompt(..., { key: "__external__" })`) rather than waiting for
 * the next scrape's auto-cancel sweep to notice it's gone. Anything else on
 * the pane — the inline
 * no-confirm path is the COMMON case on 2.1.245 — is a no-op: Enter is
 * NEVER sent on unmatched pane content, and the window just elapses.
 *
 * Early exit: the inline no-confirm path settles onto claude's idle input
 * box (`paneShowsIdleInputBox`) within a few hundred ms, so once that's been
 * true on `SLASH_CONFIRM_IDLE_BREAK_TICKS` CONSECUTIVE polls the loop gives
 * up right away instead of burning the rest of `SLASH_CONFIRM_WINDOW_MS` —
 * every dropdown-initiated model/effort change would otherwise hold this
 * per-task tmux op chain (and anything queued behind it) for the full
 * window on the overwhelmingly common no-confirm path. Two consecutive
 * ticks (not one) guards against a single transient idle-looking frame
 * mid-repaint; Enter is still never sent on this path.
 */
export async function sendSlashCommand(
  taskId: string,
  line: string,
  opts?: {
    autoConfirm?: "model" | "effort";
    onPasteFailure?: (outcome: Extract<PasteOutcome, { ok: false }>) => void;
  },
): Promise<boolean> {
  const state = sessions.get(taskId);
  if (!state) return false;
  // Settle delay after slash commands: claude's TUI takes ~hundreds of ms
  // to process `/model` / `/effort` and return to a ready input prompt.
  // Without the wait, a follow-up user paste (e.g. the next `sendTurn`
  // racing on localhost) lands during the transient state and gets
  // silently dropped — see the `Turn Ended Bug` repro where a
  // `/code-review` paste sat invisible for 49s after a model change.
  void queuePaste(taskId, state.sessionName, line, slashCommandSettleMs, state, {
    onPasteFailure: opts?.onPasteFailure,
  });
  if (opts?.autoConfirm) {
    const kind = opts.autoConfirm;
    void queueTmuxOp(taskId, async (stillCurrent) => {
      await autoConfirmSlashModal(taskId, state, kind, stillCurrent);
    }, state);
  }
  return true;
}

/**
 * Poll the pane for claude's mid-conversation `Switch model?` /
 * `Change effort level?` confirm and accept it with Enter — the confirm half
 * of `sendSlashCommand({ autoConfirm })`, factored out so
 * `mirrorModelViaPicker` runs the IDENTICAL code path rather than a second
 * copy of it (both are "agetor changed a setting on the user's behalf, so the
 * user shouldn't have to click a second time to say yes"). See
 * `sendSlashCommand`'s doc for the full rationale; the mechanics are:
 *
 *   - poll `captureConfirmPane` every `SLASH_CONFIRM_POLL_MS` for up to
 *     `SLASH_CONFIRM_WINDOW_MS`;
 *   - on the first `matchSlashConfirmModal(tail, kind)` hit send Enter, and
 *     ONLY once that send-keys succeeded stamp the fingerprint answered and
 *     resolve any card the scraper raced into existence for it;
 *   - bail immediately on a DIFFERENT blocking modal (never press Enter into
 *     one), and bail after `SLASH_CONFIRM_IDLE_BREAK_TICKS` consecutive
 *     idle-input-box sightings (the common inline no-confirm path);
 *   - Enter is NEVER sent on unmatched pane content.
 *
 * MUST be called from inside a `queueTmuxOp` body, whose `stillCurrent`
 * predicate it re-checks before every pane read and before the Enter.
 * Returns true iff the confirm was found AND its Enter landed.
 */
async function autoConfirmSlashModal(
  taskId: string,
  state: SessionState,
  kind: "model" | "effort",
  stillCurrent: () => boolean,
): Promise<boolean> {
  const attempts = Math.ceil(SLASH_CONFIRM_WINDOW_MS / SLASH_CONFIRM_POLL_MS);
  let idleStreak = 0;
  for (let i = 0; i < attempts; i++) {
    if (!stillCurrent()) return false;
    const tail = await captureConfirmPane(state);
    const match = matchSlashConfirmModal(tail, kind);
    if (match) {
      if (!stillCurrent()) return false;
      bumpKeystroke(state);
      if (!(await tmux(["send-keys", "-t", state.sessionName, "Enter"])).ok) return false;
      // Stamp answered only AFTER the Enter actually landed (finding #6):
      // a failed send-keys means the confirm is still genuinely on the
      // pane, so it must stay eligible for the scraper's own matcher
      // chain to card normally rather than being silently suppressed.
      clearRegisteredPrompt(taskId, match.fingerprint);
      return true;
    }
    // A DIFFERENT blocking modal than the confirm we're polling for — a
    // permission prompt that popped mid-turn, an AskUserQuestion, or the
    // WRONG-kind confirm (`matchSlashConfirmModal` above already ruled
    // out the matching kind, but a numbered modal with some other header
    // still satisfies `paneShowsBlockingPrompt`). Never our confirm, and
    // never safe to press Enter into — that would confirm whatever
    // that OTHER modal's cursor happens to be on. Leave it for the
    // scraper's own matcher chain to card in the usual way; bail out of
    // this poll now instead of spending the rest of the window on a pane
    // this step isn't going to act on.
    if (paneShowsBlockingPrompt(tail)) return false;
    // Not the confirm (most commonly: the inline no-confirm path already
    // went through) — keep polling. Never send Enter on anything else.
    // Early exit: two consecutive idle-input-box sightings mean claude
    // already settled with no confirm modal — give up now rather than
    // spending the rest of SLASH_CONFIRM_WINDOW_MS polling nothing (see
    // this function's doc for why that matters for the tmux op chain).
    idleStreak = paneShowsIdleInputBox(tail) ? idleStreak + 1 : 0;
    if (idleStreak >= SLASH_CONFIRM_IDLE_BREAK_TICKS) return false;
    if (i < attempts - 1) await Bun.sleep(SLASH_CONFIRM_POLL_MS);
  }
  // Window elapsed with no confirm modal — the common case. No-op.
  return false;
}

/**
 * The model FAMILY word a bare-`/model` picker row names, or null when the
 * row's label has no leading word at all.
 *
 * Captured picker rows (claude 2.1.246, smoke; the column gap is a run of
 * spaces, and `✔` marks the row that is currently in effect):
 *
 *   1. Default (recommended)  Opus 5 with 1M context, best for complex work
 *   2. Opus (1M context)      Opus 5 with 1M context …
 *   3. Fable                  Fable 5 …
 *   4. Sonnet ✔               Sonnet 5 …
 *   5. Haiku                  Haiku 4.5 …
 *
 * So the parse is: take everything before the FIRST run of ≥2 spaces (that
 * column gap is what separates the name from the description — a single space
 * can't be used, several names contain one), strip `✔`, then take the leading
 * word. The leading-word step is load-bearing, not cosmetic: row 2's name is
 * `Opus (1M context)`, and a caller asking for the `Opus` family must match it
 * (an exact whole-name comparison would miss, and the feature would report
 * "target not offered" for the single most common target).
 *
 * Taking only the leading word is also what keeps the DESCRIPTION out of the
 * decision — row 1's description says "Opus 5 …" while its name is `Default`,
 * and picking it would write a *floating* default rather than the family the
 * caller asked for.
 */
function pickerRowFamily(label: string): string | null {
  const name = (label.split(/\s{2,}/)[0] ?? "").replace(/✔/g, "").trim();
  return /^[A-Za-z][A-Za-z0-9.+-]*/.exec(name)?.[0] ?? null;
}

/**
 * Index of the bare-`/model` picker row whose family word (see
 * `pickerRowFamily`) equals `family`, case-insensitively — or `-1` when no
 * row does.
 *
 * `Default` is never a match, from BOTH directions: a row whose own family
 * word is `Default` is skipped, and a caller passing `"default"` gets `-1`.
 * Claude's `Default (recommended)` row pins the account's floating default
 * rather than a concrete family, so answering the picker with it would leave
 * `task.model` describing something that can silently change under the task
 * later — exactly the drift this whole mirror exists to remove.
 *
 * Pure (no pane, no tmux) so the mapping is unit-testable directly. Returns
 * the FIRST match if claude ever ships two rows for one family; today's
 * picker has exactly one row per family.
 */
function pickerChoiceIndexForFamily(choices: TmuxPromptChoice[], family: string): number {
  const want = family.trim().toLowerCase();
  if (want.length === 0 || want === "default") return -1;
  return choices.findIndex((c) => {
    const rowFamily = pickerRowFamily(c.label)?.toLowerCase();
    return rowFamily !== undefined && rowFamily !== "default" && rowFamily === want;
  });
}

/** Why `mirrorModelViaPicker` couldn't complete. A literal union (like
 *  `CycleFailureReason`) so producer and consumer can't drift on a typo —
 *  the orchestrator's breadcrumb wording is chosen by string equality. */
export type MirrorModelFailureReason =
  | "no live session"
  | "turn in flight"
  | "paste withheld"
  | "picker not shown"
  | "target not offered"
  | "keystroke failed";

export type MirrorModelResult =
  | { ok: true; chosen: string }
  | { ok: false; reason: MirrorModelFailureReason };

/**
 * Mirror a model change onto a live claude session by DRIVING THE BARE
 * `/model` PICKER and confirming it with `s` ("use this session only") —
 * never by typing `/model <id>`.
 *
 * **Why not `/model <id>`.** Smoke-verified on claude 2.1.246: typing
 * `/model claude-sonnet-5` (what the dropdown mirror used to send) is a
 * GLOBAL write — `~/.claude/settings.json`'s `model` key changes, so every
 * future claude the user starts ANYWHERE inherits agetor's pick. A task-level
 * dropdown must not have machine-level side effects. The bare picker's footer
 * offers `Enter to set as default · s to use this session only · Esc to
 * cancel`; `s` scopes the change to the live session, which is exactly the
 * blast radius a per-task setting should have. (This is the same reasoning,
 * and the same key, that `matchNumberedModal`'s `confirmKey` already applies
 * when a HUMAN answers the picker through a card — see
 * `SESSION_ONLY_CONFIRM_RE`. `task.model` still syncs from claude's own
 * `<local-command-stdout>` either way, so agetor's bookkeeping doesn't depend
 * on which key confirmed.)
 *
 * **The 2.1.246 picker** (smoke capture) — 5 rows, `✔` on the row in effect,
 * a `≥2`-space column gap between each row's name and its description:
 *
 *   ❯ 1. Default (recommended)  Opus 5 with 1M context, best for complex work
 *     2. Opus (1M context)      Opus 5 with 1M context …
 *     3. Fable                  Fable 5 …
 *     4. Sonnet ✔               Sonnet 5 …
 *     5. Haiku                  Haiku 4.5 …
 *   Enter to set as default · s to use this session only · Esc to cancel
 *
 * It registered as a card in 1.05 s in that capture, comfortably inside
 * `SLASH_CONFIRM_WINDOW_MS`. Pressing `s` on a row other than the current one
 * then pops `Switch model?` (`❯ 1. Yes, switch to Opus 5 (1M context)` /
 * `2. No, go back`), which this function accepts through the SAME
 * `autoConfirmSlashModal` path `sendSlashCommand({ autoConfirm: "model" })`
 * uses — the user already chose in the dropdown, so a second click would be
 * noise. `targetFamily` is one of `Opus` / `Sonnet` / `Fable` / `Haiku`; the
 * orchestrator owns mapping an agetor model id onto that word.
 *
 * **Sequencing.** The bare `/model` paste goes through `queuePaste` (so it
 * inherits the modal guard — a picker must never be opened by pasting INTO
 * some other live modal) with the usual `slashCommandSettleMs`. Everything
 * after it — poll, arrow-walk, `s`, confirm — runs in ONE `queueTmuxOp`
 * enqueued SYNCHRONOUSLY right behind that paste, with no `await` in between,
 * so nothing else on the task's tmux chain can interleave between opening the
 * picker and answering it. Every keystroke is gated on `stillCurrent()`.
 *
 * **Never open the picker on a busy session** (finding #2, wave-5
 * re-review). Checked twice: once at entry, before the `/model` paste is
 * even enqueued, and again as the FIRST thing the driving `queueTmuxOp`
 * callback does once it actually runs — the entry check ran before that
 * paste was even queued, and claude can transition into working chrome
 * (a background agent picking up, a long tool call) in the gap between
 * enqueue and this op's turn on the per-task chain. Both checks are the same
 * test: `turnInFlight(state)` (a live JSONL turn slot) OR
 * `paneShowsClaudeWorking(capturePastePane(state))` (working chrome with no
 * turn slot at all — background-agent activity). Either hit returns
 * `{ ok: false, reason: "turn in flight" }` WITHOUT pasting anything (the
 * entry check) or without driving any further keystrokes (the re-check,
 * which runs after the `/model` paste already went out on the chain — see
 * "Sequencing" above). This matters because claude's TUI QUEUES a bare
 * slash command typed mid-turn instead of opening the picker immediately —
 * it can replay as a picker minutes later, long after this function's own
 * poll window has given up, with nothing left to drive it.
 *
 * **Failure modes**, all of which leave the session in a state the user or
 * the scraper can take over from:
 *   - `no live session` — nothing to drive (also returned when the queued op
 *     was dropped because the session was replaced mid-flight).
 *   - `turn in flight` — a turn was in flight (or the pane showed claude
 *     working) at entry, or again by the time the driving op ran; see above.
 *     NO keystroke is sent.
 *   - `paste withheld` — `queuePaste`'s modal guard refused to open the
 *     picker; `opts.onPasteFailure` fires with the real outcome first. NO
 *     keystroke is sent.
 *   - `picker not shown` — the poll window elapsed with no picker on the
 *     pane. NO keystroke is sent; whatever IS on the pane is left for the
 *     scraper's own matcher chain to card.
 *   - `target not offered` — the picker is up but has no row for
 *     `targetFamily` (claude renamed or dropped it). The picker is CLOSED
 *     with `Escape` rather than left hanging, and never confirmed on a
 *     wrong row; the fingerprint is stamped answered only if that Escape's
 *     `send-keys` actually landed (finding #4, wave-5 re-review) — a failed
 *     send-keys leaves the picker genuinely on the pane, so it must stay
 *     eligible for the scraper's own matcher chain to card, mirroring the
 *     same rule `autoConfirmSlashModal` applies to its own Enter.
 *   - `keystroke failed` — a `send-keys` returned non-zero part-way through.
 *
 * **Suppresses the scraper while driving** (finding #3, wave-5 re-review):
 * `SessionState.drivingPrompt` is set for the duration of the driving
 * `queueTmuxOp` callback (try/finally, so it clears on every exit path) —
 * `scrapeOnce` skips registering a NEW `tmux_prompt` card while it's true,
 * the same idea as the existing `askCollecting` guard. The picker's footer
 * (`Enter to set as default · s to use this session only · Esc to cancel`)
 * makes it `highConfidence` in `matchNumberedModal` — it would otherwise card
 * on the very first scrape tick, and a concurrent card click racing this
 * function's own keystrokes would enqueue `dismissTmuxPrompt` behind this
 * op on the same per-task chain, potentially confirming the wrong row.
 *
 * **Stamps the mirror attribution window.** The moment the session-only
 * confirm key lands, `SessionState.lastModelMirrorAt` is set to now — the
 * only write site for that clock. It is what lets the orchestrator treat a
 * following `Kept model as <X>` (the user declining the `Switch model?` this
 * function just provoked) as a row correction, while a `Kept model as <X>`
 * from a bare user-typed `/model` + Esc leaves the row's next-run choice
 * alone. Neither the opening paste nor the `target not offered` Escape exit
 * stamps it — see the field's doc.
 */
export async function mirrorModelViaPicker(
  taskId: string,
  targetFamily: string,
  opts?: { onPasteFailure?: (outcome: Extract<PasteOutcome, { ok: false }>) => void },
): Promise<MirrorModelResult> {
  const state = sessions.get(taskId);
  if (!state) return { ok: false, reason: "no live session" };

  // Never open the picker on a busy session (finding #2, wave-5 re-review) —
  // see this function's doc. Checked again as the first thing the driving op
  // does below.
  if (turnInFlight(state) || paneShowsClaudeWorking(await capturePastePane(state))) {
    return { ok: false, reason: "turn in flight" };
  }

  // Open the picker. Guarded (no `skipModalGuard`) — pasting `/model` into a
  // live modal would confirm whatever its cursor is on instead of opening
  // anything. `onPasteFailure` runs synchronously inside the queued paste op,
  // and every reader below runs strictly after that op, so the outcome is
  // always recorded before it is read.
  //
  // Recorded into an ARRAY rather than a `let … | null` purely for
  // TypeScript's benefit: a `let` whose only assignment lives inside a
  // callback stays narrowed to its `null` initializer at the read site, which
  // turns `failure.op` into a property access on `never`.
  const pasteFailures: Array<Extract<PasteOutcome, { ok: false }>> = [];
  void queuePaste(taskId, state.sessionName, "/model", slashCommandSettleMs, state, {
    onPasteFailure: (outcome) => {
      pasteFailures.push(outcome);
      opts?.onPasteFailure?.(outcome);
    },
  });

  // Default reason covers the case where `queueTmuxOp`'s identity gate drops
  // the body entirely (the session was disposed/respawned between enqueue and
  // run) — nothing was driven, and "no live session" is the honest report.
  let result: MirrorModelResult = { ok: false, reason: "no live session" };
  await queueTmuxOp(taskId, async (stillCurrent) => {
    if (pasteFailures.length > 0) return;

    // Re-check busy-ness (finding #2, wave-5 re-review): the entry check
    // above ran before the "/model" paste was even enqueued; claude can have
    // transitioned into working chrome on its own (a background agent
    // picking up, a long tool call) by the time THIS op actually gets its
    // turn on the per-task chain — strictly after that paste's own op. Bail
    // without driving any further keystrokes into a pane that may now be
    // busy — including one where the bare `/model` we just pasted got
    // swallowed into claude's queued-input buffer instead of opening the
    // picker immediately.
    if (turnInFlight(state) || paneShowsClaudeWorking(await capturePastePane(state))) {
      result = { ok: false, reason: "turn in flight" };
      return;
    }

    // Suppress the scraper's own card registration for the duration of this
    // op (finding #3, wave-5 re-review) — see this function's doc. Cleared
    // in `finally` so every exit path (including a thrown error) restores it.
    state.drivingPrompt = true;
    try {
      // Poll for the picker. Identified structurally, NOT by matching row
      // text: a numbered modal whose footer advertises the session-only
      // confirm (`ScrapeMatch.confirmKey === "s"`, set by `matchNumberedModal`
      // off `SESSION_ONLY_CONFIRM_RE`) is exactly claude's picker and nothing
      // else in its UI today. Reusing that signal means this driver and the
      // card path agree on what a picker is by construction.
      const attempts = Math.ceil(SLASH_CONFIRM_WINDOW_MS / SLASH_CONFIRM_POLL_MS);
      let picker: ScrapeMatch | null = null;
      for (let i = 0; i < attempts; i++) {
        if (!stillCurrent()) return;
        const m = matchNumberedModal(await captureConfirmPane(state));
        if (m && m.confirmKey === "s" && typeof m.cursorIndex === "number") {
          picker = m;
          break;
        }
        if (i < attempts - 1) await Bun.sleep(SLASH_CONFIRM_POLL_MS);
      }
      if (picker === null) {
        // Never send a keystroke into a pane we couldn't identify.
        result = { ok: false, reason: "picker not shown" };
        return;
      }

      const targetIndex = pickerChoiceIndexForFamily(picker.choices, targetFamily);
      if (targetIndex < 0) {
        // The picker IS up, so leaving it would strand claude on a modal the
        // user never opened. Close it with Escape (the footer's own cancel
        // affordance).
        if (!stillCurrent()) {
          result = { ok: false, reason: "no live session" };
          return;
        }
        bumpKeystroke(state);
        const escape = await tmux(["send-keys", "-t", state.sessionName, "Escape"]);
        // Stamp the fingerprint answered ONLY when the Escape actually
        // landed (finding #4, wave-5 re-review) — mirrors the symmetry
        // `autoConfirmSlashModal` already applies to its own Enter: a failed
        // send-keys means the picker is genuinely STILL on the pane, so it
        // must stay eligible for the scraper's own matcher chain to card
        // normally (once `drivingPrompt` clears below) rather than being
        // silently suppressed with nothing left to drive it.
        if (escape.ok) clearRegisteredPrompt(taskId, picker.fingerprint);
        result = { ok: false, reason: "target not offered" };
        return;
      }

      // Walk the cursor onto the target row, then confirm session-only. Same
      // choreography (and the same 30 ms inter-press gaps + `stillCurrent()`
      // re-gates) a card click takes through `dismissTmuxPrompt`.
      const delta = targetIndex - picker.cursorIndex!;
      const arrow = delta >= 0 ? "Down" : "Up";
      if (!(await walkCursor(state, arrow, Math.abs(delta), stillCurrent))) {
        result = { ok: false, reason: "keystroke failed" };
        return;
      }
      if (!stillCurrent()) return;
      // `picker.confirmKey` is "s" by the poll's own predicate; read it off
      // the match rather than hardcoding, so a future footer wording change
      // flows through `SESSION_ONLY_CONFIRM_RE` in one place.
      bumpKeystroke(state);
      if (!(await tmux(["send-keys", "-t", state.sessionName, picker.confirmKey!])).ok) {
        result = { ok: false, reason: "keystroke failed" };
        return;
      }
      // Attribution stamp — the ONLY write site for `lastModelMirrorAt`, and
      // deliberately here rather than at the opening `/model` paste or on the
      // `target not offered` Escape exit: this is the single point at which
      // agetor has committed to a model CHANGE, so it is the only outcome
      // whose `Kept model as …` (the user declining the resulting
      // `Switch model?`) should be allowed to write back to the task row. See
      // `SessionState.lastModelMirrorAt`.
      state.lastModelMirrorAt = Date.now();
      // Only AFTER the key landed (same rule as `autoConfirmSlashModal`): a
      // failed send-keys leaves the picker genuinely on the pane and it must
      // stay eligible for the scraper to card.
      clearRegisteredPrompt(taskId, picker.fingerprint);

      // `s` on a DIFFERENT family pops `Switch model?`. Accept it through the
      // shared path — a no-op (and a cheap one, thanks to its idle-break)
      // when claude applied the change inline instead.
      await autoConfirmSlashModal(taskId, state, "model", stillCurrent);

      result = { ok: true, chosen: pickerRowFamily(picker.choices[targetIndex]!.label) ?? targetFamily };
    } finally {
      state.drivingPrompt = false;
    }
  }, state);

  // A failed opening paste wins over whatever the op recorded: it returned
  // immediately and never touched the pane. `modal-guard` is the deliberate
  // withhold (a live modal was up); anything else is a tmux call that didn't
  // land — including `PASTE_DROPPED_OUTCOME`, where the queued op never ran
  // because the session was replaced. Either way no keystroke went out, which
  // is what `keystroke failed` says.
  const failure = pasteFailures[0];
  if (failure) {
    return { ok: false, reason: failure.op === "modal-guard" ? "paste withheld" : "keystroke failed" };
  }
  return result;
}

/**
 * Mark `fingerprint` as just-answered for `taskId` AND resolve any card the
 * scraper already registered for it. Two halves that must always happen
 * together once agetor itself has answered a modal:
 *
 *   - `markTmuxPromptAnswered` stops the NEXT scrape tick from re-registering
 *     a ghost duplicate while tmux/claude are still repainting;
 *   - `answerTmuxPrompt(…, "__external__")` clears a card that was ALREADY
 *     registered, instead of leaving the user looking at (and able to click)
 *     a modal that is no longer on the pane.
 *
 * Extracted from `autoConfirmSlashModal`'s success branch so
 * `mirrorModelViaPicker` gets identical treatment on both of its
 * modal-dismissing exits — the confirmed pick and the `Escape` on an
 * unavailable family.
 */
function clearRegisteredPrompt(taskId: string, fingerprint: string): void {
  markTmuxPromptAnswered(taskId, fingerprint);
  for (const pending of activeTmuxPromptsForTask(taskId)) {
    if (pending.fingerprint === fingerprint) {
      answerTmuxPrompt(pending.id, { key: "__external__" });
    }
  }
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
  | "verification mismatch"
  | "paste withheld";

export type CycleResult =
  | { ok: true; presses: number; via: "noop" | "slash-plan" | "shift-tab" }
  | { ok: false; reason: CycleFailureReason; target?: string; attempts?: number; lastObserved?: string | null };

/** How many times `cycleToMode` will resend Shift+Tab presses before giving
 *  up. Each press is verified by scraping the tmux status bar; a mismatch
 *  (account isn't auto-eligible, cycle width assumed wrong) triggers another
 *  attempt from the newly-observed mode. */
const MAX_VERIFY_ATTEMPTS = 3;

/** How long to wait for the tmux status bar to reflect the new permission
 *  mode after sending the Shift+Tab presses before declaring the press
 *  "lost" (most likely swallowed by claude's one-time auto opt-in modal,
 *  which paints over the bar). The bar updates within ~100ms in practice. */
let modeVerifyTimeoutMs = 1500;

/** How often `cycleToMode` re-captures the tmux pane while waiting for the
 *  status bar to settle on the new mode. */
let modePollIntervalMs = 100;

/**
 * Test seam: how `cycleToMode` reads the live permission mode. Production
 * captures the tmux pane; the unit suite swaps in a synthetic pane so it can
 * drive the verifier without a real claude session (the `/bin/echo` tmux stub
 * the tests use can't paint a status bar).
 */
let captureModePane: (state: SessionState) => Promise<string> = captureTail;

/**
 * Parse claude's current permission mode out of the tmux status bar. The bar
 * renders one of these near the bottom of the pane (empirically, claude
 * v2.1.170):
 *
 *   ⏸ plan mode on (shift+tab to cycle)
 *   ⏵⏵ accept edits on (shift+tab to cycle)
 *   ⏵⏵ auto mode on (shift+tab to cycle)
 *   ⏵⏵ bypass permissions on (shift+tab to cycle)
 *   ? for shortcuts                              ← default mode (no banner)
 *
 * Returns the canonical claude mode string, or null when the bar shows none
 * of these (mid-render, or the auto opt-in / a permission modal is painted
 * over it — the caller treats null as "couldn't confirm"). Unlike the JSONL
 * `permission-mode` event, the bar reflects an *idle* Shift+Tab immediately;
 * claude doesn't journal an idle mode switch until the next turn starts.
 *
 * We only read the *trailing* non-empty line of the captured tail and, for
 * the four explicit modes, require the banner's `(shift+tab to cycle)` hint.
 * `captureModePane` returns the whole visible-pane tail, so a bare phrase like
 * "auto mode on" sitting in assistant/user output above the bar would
 * otherwise be mis-read as the live mode.
 */
async function readPaneMode(state: SessionState): Promise<string | null> {
  const lines = (await captureModePane(state)).split("\n");
  let bar = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() !== "") { bar = lines[i]!; break; }
  }
  if (/shift\+tab to cycle/i.test(bar)) {
    if (/accept edits on/i.test(bar)) return CLAUDE_MODE_ACCEPT_EDITS;
    if (/plan mode on/i.test(bar)) return CLAUDE_MODE_PLAN;
    if (/auto mode on/i.test(bar)) return CLAUDE_MODE_AUTO;
    if (/bypass permissions on/i.test(bar)) return CLAUDE_MODE_BYPASS;
  }
  // No mode banner. Default mode shows the "? for shortcuts" hint on the
  // trailing line instead; require that positive marker rather than inferring
  // default from mere absence, so a half-painted frame doesn't read as a
  // spurious switch.
  if (/\? for shortcuts/i.test(bar)) return CLAUDE_MODE_DEFAULT;
  return null;
}

/**
 * Poll the tmux status bar after a batch of Shift+Tab presses until it
 * confirms where claude landed, starting from mode `from`.
 *
 *   - Returns `target` as soon as the bar shows it — the target is the *last*
 *     mode in the forward press sweep, so once it appears the batch is done.
 *   - Otherwise waits for the bar to settle on a *different* mode than `from`
 *     (two consecutive equal reads), which it returns as the observed landing
 *     so the caller can retry from there. The two-read settle guard keeps an
 *     intermediate frame — claude repaints the bar through each mode as it
 *     consumes the rapid key batch — from being mistaken for the final
 *     landing.
 *   - Returns null when nothing recognisable appears before
 *     `modeVerifyTimeoutMs` (e.g. the auto opt-in modal is covering the bar).
 */
async function waitForPaneMode(state: SessionState, from: string, target: string): Promise<string | null> {
  const deadline = Date.now() + modeVerifyTimeoutMs;
  let prev: string | null = null;
  for (;;) {
    const mode = await readPaneMode(state);
    if (mode === target) return mode;
    // Settled on a moved, non-target mode → that's the landing.
    if (mode !== null && mode !== from && mode === prev) return mode;
    prev = mode;
    if (Date.now() >= deadline) {
      // Out of time. Prefer a moved, recognised mode over `from`/null so a
      // genuine (if unsettled) landing still drives a retry.
      return mode !== null && mode !== from ? mode : null;
    }
    await new Promise((r) => setTimeout(r, modePollIntervalMs));
  }
}

/**
 * Switch a live claude session's permission mode to `targetAgetorMode` by
 * sending the right number of `Shift+Tab` (tmux `BTab`) keystrokes — claude's
 * only mid-session mode-switch mechanism (there's no `/permission-mode` slash
 * command despite what the prior code assumed). For the `plan` target we
 * prefer the `/plan` slash command instead: it's deterministic, doesn't
 * depend on knowing the current mode, and works from anywhere.
 *
 * After each batch of presses we scrape the tmux status bar (see
 * `readPaneMode`) and compare it to the target. A mismatch — account isn't
 * auto-eligible (cycle is 3-wide instead of 4), assumed press count was
 * off, etc. — triggers another attempt from the newly-observed mode, up
 * to `MAX_VERIFY_ATTEMPTS` times. We scrape the bar rather than wait for a
 * JSONL `permission-mode` event because claude only journals that event at
 * the *next turn start*; an idle Shift+Tab updates the bar immediately but
 * writes nothing to the JSONL. If the bar never shows a recognised mode
 * within `modeVerifyTimeoutMs` (most likely cause: claude's one-time auto
 * opt-in modal is painted over it), we bail with `verification timed out` so
 * the orchestrator can warn the user rather than report a successful mode
 * change that didn't happen.
 *
 * Returns:
 *   - `{ ok: true, via: "noop" }` when the session is already at the target.
 *   - `{ ok: true, via: "slash-plan" }` when we sent `/plan`.
 *   - `{ ok: true, via: "shift-tab", presses: N }` when N tabs got claude
 *     to the target (verified by scraping the status bar).
 *   - `{ ok: false, reason: "no live session" }` for an unknown task.
 *   - `{ ok: false, reason: "current mode unknown" }` before claude's first
 *     `system` event has arrived.
 *   - `{ ok: false, reason: "mode not in cycle", target }` when the target
 *     isn't reachable (e.g. `bypassPermissions` without the launch flag —
 *     a respawn is required).
 *   - `{ ok: false, reason: "verification timed out", attempts, lastObserved }`
 *     when the status bar never confirmed the new mode after our keystrokes.
 *   - `{ ok: false, reason: "verification mismatch", attempts, lastObserved }`
 *     when every attempt landed somewhere other than the target.
 *   - `{ ok: false, reason: "paste withheld" }` when the `/plan` paste itself
 *     was withheld by `queuePaste`'s modal guard (a live claude modal was
 *     already up) or otherwise failed to land — see the `/plan` branch below.
 */
async function cycleToModeInner(taskId: string, targetAgetorMode: string): Promise<CycleResult> {
  const state = sessions.get(taskId);
  if (!state) return { ok: false, reason: "no live session" };
  const target = toClaudeModeString(targetAgetorMode);

  // `/plan` works from any state, no cycle math needed. Prefer it.
  // Verifying the mode actually changed via the JSONL would require the
  // same listener machinery the Shift+Tab path uses; for `plan` the slash
  // command is reliable enough on its own that the added complexity doesn't
  // pay for itself. Uses the slash-command settle window so a racing user
  // paste lands after claude has processed the mode switch.
  //
  // NOT fire-and-forget, though (finding #3, docs/plans/model-effort-local-
  // command-turns.md §10): `queuePaste`'s modal guard can WITHHOLD this
  // paste outright when a live claude modal is already up on the pane, and
  // that outcome must be visible to the caller — `reconcileTaskSession`
  // calls `ensureInstalledForCwd(cwd, "plan")` right after a successful
  // cycle, which is the exact deadlock this guard exists to prevent if a
  // withheld `/plan` still reported `{ ok: true, via: "slash-plan" }` as
  // though it landed. `onPasteFailure` runs synchronously inside
  // `queuePaste`'s queued op, before its returned promise settles, so by
  // the time this `await` resolves `pasteFailed` already reflects whatever
  // happened (a genuine tmux failure gets the same treatment — any
  // `onPasteFailure` call here means `/plan` did not reach claude).
  if (target === CLAUDE_MODE_PLAN) {
    let pasteFailed = false;
    await queuePaste(taskId, state.sessionName, "/plan", slashCommandSettleMs, state, {
      onPasteFailure: () => { pasteFailed = true; },
    });
    if (pasteFailed) return { ok: false, reason: "paste withheld" };
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

    // One tmux invocation with N keys — cleaner than N sync spawns, and
    // tmux delivers them as a single stream so claude's TUI doesn't get a
    // chance to debounce them apart on slow terminals.
    //
    // `BTab` is tmux's name for the back-tab / Shift+Tab sequence (`\e[Z`),
    // which is what claude listens for to cycle modes. The obvious-looking
    // `S-Tab` is NOT recognised by tmux as a modified key — it degrades to a
    // plain `Tab`, which never cycles the mode (this was the original bug:
    // every "mode change" silently no-op'd).
    const keys = Array<string>(presses).fill("BTab");
    bumpKeystroke(state);
    await tmux(["send-keys", "-t", state.sessionName, ...keys]);

    // Verify by scraping the status bar, NOT the JSONL: claude only journals
    // `permission-mode` at the next turn start, so an idle Shift+Tab emits no
    // event and a JSONL wait would always time out. The bar, by contrast,
    // flips within a frame.
    const observed = await waitForPaneMode(state, current, target);

    if (observed === null) {
      return {
        ok: false,
        reason: "verification timed out",
        attempts,
        lastObserved: state.permissionMode,
      };
    }
    // Keep `state.permissionMode` in sync with what the bar now shows so the
    // next loop iteration recomputes from the live mode (and so a later turn's
    // guards / `getPermissionMode` don't read a stale value until the JSONL
    // catches up at the next turn).
    state.permissionMode = observed;
    if (observed === target) {
      return { ok: true, presses: totalPresses, via: "shift-tab" };
    }
    // Mismatch — loop and retry from the newly-observed mode.
  }

  return {
    ok: false,
    reason: "verification mismatch",
    attempts,
    lastObserved: state.permissionMode,
  };
}

/**
 * Per-task serialization for `cycleToMode`. claude runs one tmux session per
 * task, and `BTab` batches from two overlapping calls (a rapid double
 * mode-PATCH — `reconcileTaskSession` is fire-and-forget, so they aren't
 * naturally serialized) would interleave on the same session and land it on
 * an unpredictable mode. Chaining makes the second call run from the first's
 * settled state, so the final mode reflects the latest request.
 */
const cycleInFlight = new Map<string, Promise<CycleResult>>();

export function cycleToMode(taskId: string, targetAgetorMode: string): Promise<CycleResult> {
  const prev = cycleInFlight.get(taskId);
  const run = (prev ? prev.catch(() => undefined) : Promise.resolve()).then(
    () => cycleToModeInner(taskId, targetAgetorMode),
  );
  cycleInFlight.set(taskId, run);
  void run.catch(() => undefined).finally(() => {
    // Only clear the slot if it still points at this run — a newer call may
    // have already chained on and replaced it.
    if (cycleInFlight.get(taskId) === run) cycleInFlight.delete(taskId);
  });
  return run;
}

/**
 * Tear down per-task state for `taskId` and kill the tmux session. Used by
 * deleteTask and reconcileOrphans.
 */
export async function dropSession(taskId: string): Promise<void> {
  const state = sessions.get(taskId);
  if (state) {
    // `orphanSubagents: true` — this task's session is being torn down for
    // good (delete/archive/agent-switch, `killTaskSession` right below), so
    // any `running` subagent rows are never getting another transcript line.
    disposeSessionState(state, true);
    sessions.delete(taskId);
  } else {
    // A task held in `running` across a restart has a watcher armed by the boot
    // pass but no SessionState (its run already succeeded, so nothing
    // reattached). Without this the boot-armed watcher outlives the task it
    // belongs to, polling a directory that delete/archive is about to remove.
    detachWatcherFor(taskId);
    orphanRunningSubagents(taskId);
  }
  await killTaskSession(taskId);
}

/**
 * Send Ctrl+C to a task's tmux session addressed purely by its deterministic
 * name — no in-memory `SessionState` required. Stop on a task whose turn has
 * already resolved (held in `running` while its background agents finish) has
 * no `active` run handle to route the interrupt through, and after a restart it
 * has no `SessionState` either. Returns false when the session is already gone.
 */
export async function interruptTaskSession(taskId: string): Promise<boolean> {
  const name = sessionNameFor(taskId);
  if (!(await sessionExistsByName(name))) return false;
  // Best-effort: this path deliberately works from the session NAME alone
  // (there may be no in-memory state after a restart), but when there IS a
  // live state, stamp the keystroke clock like every other send-keys site.
  const state = sessions.get(taskId);
  if (state) bumpKeystroke(state);
  await tmux(["send-keys", "-t", name, "C-c"]);
  return true;
}

/** Close any watcher / interval timer held by a SessionState and reject any
 *  queued turn slots so dependent promises settle. Used both by
 *  `dropSession` (intentional teardown) and by `reattachSession` (defensive
 *  cleanup before overwriting an entry in the sessions map). Safe to call
 *  with `undefined` so the caller can pass `sessions.get(taskId)` directly.
 *
 *  `orphanSubagents` gates whether this dispose also flips the task's
 *  `running` subagent rows to `orphaned`. Only pass `true` when the
 *  underlying tmux session is provably dead by this point — `dropSession`
 *  (kills the session right after) and `spawnClaudeViaTmux`'s pre-kill
 *  (already killed the session before disposing the old state). Leave it
 *  `false` for `reattachSession`'s defensive re-dispose: a non-null prior
 *  state there means the SAME tmux session is about to be reattached again,
 *  which may still be alive and still writing subagent transcripts —
 *  orphaning there would drop tracking for an agent that's still running. */
function disposeSessionState(state: SessionState | undefined, orphanSubagents = false): void {
  if (!state) return;
  state.watcher?.close();
  state.watcher = null;
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.pollTimer = null;
  if (state.scrapeTimer) clearInterval(state.scrapeTimer);
  state.scrapeTimer = null;
  if (state.deathTimer) clearInterval(state.deathTimer);
  state.deathTimer = null;
  clearContinuationWatchdog(state);
  state.scrapeLastFingerprint = null;
  state.scrapeUnparsableStreak = 0;
  state.scrapeIdleSettleStreak = 0;
  // Release the subagent watcher's fs.watch + poll timer. Read-only teardown:
  // this stops us TAILING the subagent files, never the agent itself.
  state.subagentWatcher?.detach();
  state.subagentWatcher = null;
  if (orphanSubagents) orphanRunningSubagents(state.taskId);
  state.onEndOfTurn = null;
  state.pendingEndTurn = null;
  state.lastLocalCommandName = null;
  state.lastLocalCommandArgs = null;
  state.composerHoldsText = false;
  // Defensive — `mirrorModelViaPicker`'s own `finally` should already have
  // cleared this by the time a session tears down; a session death mid-drive
  // shouldn't leave a stale suppression behind on a respawned state either
  // (this is a fresh object being disposed, not the new one, but the reset
  // keeps the invariant "every SessionState starts non-driving" honest even
  // if some future caller ever inspects a disposed-but-still-referenced one).
  state.drivingPrompt = false;
  // A respawned session must not inherit the previous process's mirror
  // attribution window — a `Kept model as` line from the NEW session would
  // otherwise be credited to a mirror that drove the OLD one.
  state.lastModelMirrorAt = 0;
  // The launch pin belongs to the process this state was tracking; that
  // process is gone. Clearing it means a stale read can never claim a
  // torn-down session was pinned to something (`getSessionLaunchEffort`
  // already returns null for a task with no state at all, so this only
  // matters for the window where a caller still holds the object).
  state.launchEffort = null;
  const err = new Error("session killed");
  // Null `resolve`/`reject` after rejecting each slot (finding #6, §10
  // re-review) — mirrors `popEndOfTurn`'s own settle convention and is what
  // makes `sendTurn`'s onPasteFailure guard comment ("a non-null `reject`
  // here means the slot is still genuinely pending") actually true: without
  // this, a slot this function just rejected still LOOKS pending to that
  // guard if a paste failure for it fires afterwards.
  for (const slot of state.turnQueue.splice(0)) {
    const reject = slot.reject;
    slot.resolve = null;
    slot.reject = null;
    reject?.(err);
  }
  // Drop the chain map entry — the identity gate inside `queueTmuxOp`
  // will already skip any in-flight thunks that captured the now-disposed
  // `state` (they won't run their bodies), so this delete is just
  // hygiene to release the map slot eagerly instead of waiting for the
  // chain's self-evict `.finally` to fire.
  pasteChains.delete(state.taskId);
}

function makeAgent(
  taskId: string,
  done: Promise<number>,
  /** Optional third handle — see `SpawnedAgent.pasteOutcome`. Only `sendTurn`
   *  passes one; every other construction site has no paste to report on. */
  pasteOutcome?: Promise<PasteOutcome>,
): SpawnedAgent {
  return {
    pasteOutcome,
    kill: () => {
      // Interrupt every queued turn for this task. Ctrl+C aborts whatever
      // claude is doing in the TUI and clears its queued-input buffer
      // (anything we'd pasted while it was thinking). Reject the full
      // queue so each run's done settles with "cancelled". Drop any staged
      // end_turn so a late-arriving JSONL line can't fire it post-cancel
      // and emit a spurious "turn complete" banner on the cancelled run.
      const state = sessions.get(taskId);
      if (!state) return;
      bumpKeystroke(state);
      // Fire-and-forget — see reattachSession's kill closure for why.
      void tmux(["send-keys", "-t", state.sessionName, "C-c"]);
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
      // slashCommand: null — this generic test helper drives non-slash-turn
      // scenarios; a dedicated local-command test constructs its own slot
      // (or extends this) rather than overloading this shared helper.
      state.turnQueue.push({ onChunk, resolve, reject, slashCommand: null });
    });
  },
  flushSync,
  flush,
  dispatchLine,
  firePendingEndTurn,
  /** Death-watch settlement — exposed so the death test can drive it against a
   *  synthetic session without a real tmux server. */
  signalSessionDeath,
  /** Background-agent API-error settlement — exposed so the subagent
   *  API-error test can drive it against a synthetic session without a real
   *  tmux server or a live `attachSubagentWatcher`. */
  signalSubagentApiError,
  /** Unknown-slash-command settlement — exposed so the matcher/signal test
   *  can drive it against a synthetic session without a real tmux server. */
  signalUnknownCommand,
  matchUnknownCommand,
  slashTokenOf,
  turnInFlight,
  matchNumberedModal,
  matchYesNoModal,
  matchStartupConsentDialog,
  clearedStabilityGate,
  /** Footer regex behind `matchNumberedModal`'s `confirmKey: "s"` — exposed
   *  so the scraper test suite can assert the pattern directly (positive/
   *  negative) as well as through the matcher. */
  SESSION_ONLY_CONFIRM_RE,
  /** The bare `/effort` slider matcher plus its tuning regexes/constant —
   *  exposed so the scraper test suite can pin the nearest-centre cursor
   *  mapping and the four-signal (track / label / footer-near-label /
   *  footer-at-bottom-of-pane) requirement without a live tmux pane. */
  matchSliderModal,
  SLIDER_TRACK_RE,
  SLIDER_TRACK_MIN_CHARS,
  SLIDER_FOOTER_RE,
  /** Fallback matcher for prompts no real matcher parsed, plus its pure
   *  watchdog-arm decision and tuning constants — exposed so the scraper
   *  test suite can assert footer/watchdog firing and non-firing without a
   *  live tmux pane. */
  matchUnparsableModal,
  stuckTurnFallbackArmed,
  MODAL_FOOTER_RE,
  STUCK_TURN_FALLBACK_MS,
  /** `/model` / `/effort` mid-conversation confirm-modal matcher used by
   *  `sendSlashCommand`'s auto-confirm step — exposed so a test can assert
   *  it fires only for the matching kind, never the other, and never on the
   *  model picker or a numbered modal whose cursor sits on "No". */
  matchSlashConfirmModal,
  /** Working-chrome detection (2.1.239) that gates both fallback arms, the
   *  auto-continue notice veto, and the unparsable stability streak length —
   *  exposed so the truth table is unit-testable without a live tmux pane. */
  WORKING_LINE_RE,
  /** The completed-turn `· done <time>` marker that keeps a finished turn's
   *  elapsed summary row out of `WORKING_LINE_RE` while leaving it inside
   *  `VOLATILE_PANE_LINE_RE` — exposed so the asymmetry (idle pane, but still
   *  volatile chrome) can be asserted directly. */
  TURN_DONE_SUMMARY_RE,
  MODAL_NOTICE_RE,
  paneShowsClaudeWorking,
  WORKING_CHROME_WINDOW_LINES,
  UNPARSABLE_STABILITY_TICKS,
  nextUnparsableStreak,
  unparsableStreakCleared,
  /** Pure idle-throttle decision used by `scrapeOnce` — exposed so the
   *  regression test can assert a JSONL-idle session keeps scraping (at the
   *  throttled cadence) instead of stopping forever, which would strand a
   *  modal raised after the turn resolved to `review`. */
  decideScrapeTick,
  SCRAPE_IDLE_AFTER_MS,
  SCRAPE_IDLE_POLL_MS,
  SCRAPE_DEEP_IDLE_AFTER_MS,
  SCRAPE_DEEP_IDLE_POLL_MS,
  /** Pure per-poll decision used by `driveAskAnswers`'s confirm/verify
   *  phases — exposed so the swallowed-confirm retry logic (resend on a
   *  "review" sighting, wait out a "question" sighting, bounded resends)
   *  can be asserted without a live tmux pane. */
  decideAskDriveStep,
  ASK_REVIEW_POLL_MS,
  ASK_REVIEW_POLL_ATTEMPTS,
  ASK_VERIFY_POLL_MS,
  ASK_VERIFY_POLL_ATTEMPTS,
  ASK_VERIFY_MAX_RESENDS,
  readPendingAskQuestionsFromJsonl,
  shouldWaitForAskJsonl,
  resumeJsonlOffset,
  /** Drive the pane-scrape AskUserQuestion collector against a fake `PaneIo`
   *  (no tmux), to assert per-option preview capture + cursor restoration for
   *  the flat and tabbed/multiSelect layouts. */
  collectAskQuestionsFromPane,
  /** Cap on consecutive grow-but-still-incomplete failures before
   *  `collectAskQuestionsFromPane` gives up on the current modal. Exposed so
   *  tests can assert against the constant rather than hardcoding it. */
  MAX_ASK_GROW_ATTEMPTS,
  /** Pure decision used by `scrapeOnce` to unsuppress the generic modal
   *  matcher once the ask-collector's grow latch has given up. Exposed so the
   *  give-up→fallback transition is unit-testable without tmux. */
  askFallbackAllowed,
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
  /** Override the pane-poll interval used by `cycleToMode`. Tests shrink it
   *  so the verify loop spins fast. Returns the previous value. */
  setModePollIntervalMs(ms: number): number {
    const prev = modePollIntervalMs;
    modePollIntervalMs = ms;
    return prev;
  },
  /** Override how `cycleToMode` reads the live mode (production scrapes the
   *  tmux pane). Tests inject a synthetic status bar — pass a function that
   *  returns the pane text claude would show. Returns the previous reader so
   *  the test can restore it. */
  setCaptureModePane(
    fn: (state: SessionState) => Promise<string>,
  ): (state: SessionState) => Promise<string> {
    const prev = captureModePane;
    captureModePane = fn;
    return prev;
  },
  readPaneMode,
  /** Override how `sendSlashCommand`'s auto-confirm step reads the live pane
   *  (production captures the tmux pane tail). Tests inject a synthetic
   *  confirm-modal pane so the confirm-poll step can be driven without a
   *  real tmux session. Returns the previous reader so the test can restore
   *  it in `afterEach` (mirrors `setCaptureModePane`). */
  setCaptureConfirmPane(
    fn: (state: SessionState) => Promise<string>,
  ): (state: SessionState) => Promise<string> {
    const prev = captureConfirmPane;
    captureConfirmPane = fn;
    return prev;
  },
  /** Tuning constants for `sendSlashCommand`'s auto-confirm poll — exposed
   *  so tests can compute expected attempt counts / windows rather than
   *  hardcoding them. */
  SLASH_CONFIRM_POLL_MS,
  SLASH_CONFIRM_WINDOW_MS,
  SLASH_CONFIRM_IDLE_BREAK_TICKS,
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
  /** The gap the last bracketed `queuePaste` actually chose (base gap vs
   *  scaled image settle). Lets tests pin the detector's path decision
   *  deterministically instead of upper-bounding wall-clock elapsed. */
  getLastBracketedGapMs(): number | null { return lastBracketedGapMs; },
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
  /** Fire the continuation watchdog's settle logic directly — mirrors
   *  `signalSessionDeath` above: real-timer tests would need to wait out
   *  `CONTINUATION_WATCHDOG_MS` (or the `setContinuationWatchdogMs`
   *  override), so exposing the destructive branch itself lets a test
   *  drive "watchdog fires" deterministically without touching the timer. */
  fireContinuationWatchdog,
  /** Read-only accessor for the armed watchdog (timer + guarded slot), or
   *  null when not armed. Exposed so a test can assert arm/reset/clear
   *  transitions without reaching into module-private state another way. */
  getContinuationWatchdog(state: SessionState) { return state.continuationWatchdog; },
  /** Deterministic stand-in uuid for a uuid-less notification line (see its
   *  doc comment above). Exposed so tests can compute the expected key for a
   *  given payload rather than hardcoding a hash literal. */
  syntheticNotificationUuid,
  /** Local-command turn settle — the pure stdout-line detector
   *  (`isLocalCommandStdoutEvent`), the idle-input-box pane detector
   *  (`paneShowsIdleInputBox`) plus its tuning regex/window constant, and the
   *  idle-settle signal (`signalIdleSettle`) itself — exposed so the
   *  local-command and idle-settle-net truth tables are unit-testable
   *  without a live tmux pane or a real claude JSONL stream. */
  isLocalCommandStdoutEvent,
  /** Test-only convenience over `parseLocalCommandLine` (see its own doc) —
   *  production's identity half of the local-command settle gate (paired
   *  with `isLocalCommandStdoutEvent` and `SessionState.lastLocalCommandName`)
   *  calls `parseLocalCommandLine` directly, below. Exposed so tests that
   *  only care about the token (not `args`) can assert against it without a
   *  live tmux pane. */
  localCommandNameOf,
  /** Extracts BOTH the command token and its raw `<command-args>` payload
   *  from a `<command-name>…</command-name>` line (`localCommandNameOf` is
   *  a thin wrapper over this). Exposed so the args half of the identity
   *  gate — and `LocalSettingInfo.args` — is unit-testable directly. */
  parseLocalCommandLine,
  paneShowsIdleInputBox,
  STATUS_BAR_RE,
  IDLE_PROMPT_SEARCH_LINES,
  /** The flickering right-hand `● <effort> · /effort` status-bar hint regex,
   *  plus the pure helper that strips it off a matched `STATUS_BAR_RE` row —
   *  exposed so the "narrower than the whole line" truth table (finding #8,
   *  wave-5 re-review) is unit-testable directly against bare strings,
   *  without a live tmux pane. */
  EFFORT_HINT_SUFFIX_RE,
  stripVolatileStatusBarHint,
  signalIdleSettle,
  /** Explanatory status text emitted immediately before the "turn complete"
   *  banner when `signalIdleSettle` closes out a turn — exposed so tests can
   *  assert on it rather than hardcoding the wording, and so it can be
   *  checked against the other status-prefix sentinels. */
  IDLE_SETTLE_STATUS_TEXT,
  /** Pure predicate behind `queuePaste`'s modal guard — exactly the set of
   *  panes the scraper would card (numbered / yes-no / slider modal, a live
   *  AskUserQuestion question screen, or the footer arm of
   *  `matchUnparsableModal`). Exposed so its truth table is unit-testable
   *  without a live tmux pane. */
  paneShowsBlockingPrompt,
  /** Tuning constants for `queuePaste`'s modal guard — exposed so tests can
   *  compute expected poll counts / windows rather than hardcoding them.
   *  Getters, not plain property shorthand (finding #9, §10 re-review): both
   *  values are backed by module-scope `let`s that `setPasteModalPollMs` /
   *  `setPasteModalGraceMs` mutate, so a shorthand `PASTE_MODAL_POLL_MS,`
   *  would have captured the value ONCE at module-load time and never
   *  reflected a later `set…Ms` call through this same `__forTest` object —
   *  a getter reads the live variable on every access instead. */
  get PASTE_MODAL_POLL_MS(): number { return PASTE_MODAL_POLL_MS; },
  get PASTE_MODAL_GRACE_MS(): number { return PASTE_MODAL_GRACE_MS; },
  /** Override `queuePaste`'s modal guard grace window (default
   *  `PASTE_MODAL_GRACE_MS`) — same shape as `setBracketedEnterGapMs`.
   *  Tests shrink it so a persistently-blocked-pane guard test doesn't have
   *  to pay the full production grace. Returns the previous value so the
   *  test can restore it in `afterEach`. */
  setPasteModalGraceMs(ms: number): number {
    const prev = PASTE_MODAL_GRACE_MS;
    PASTE_MODAL_GRACE_MS = ms;
    return prev;
  },
  /** Override `queuePaste`'s modal guard poll interval (default
   *  `PASTE_MODAL_POLL_MS`) — also `stillBlocking`'s own confirmation-sleep
   *  duration. Same shape as `setBracketedEnterGapMs`. Tests shrink it
   *  (e.g. to ~20ms) so guard tests don't pay the full poll cadence.
   *  Returns the previous value. */
  setPasteModalPollMs(ms: number): number {
    const prev = PASTE_MODAL_POLL_MS;
    PASTE_MODAL_POLL_MS = ms;
    return prev;
  },
  /** Double-sample confirmation behind the modal guard's pre-paste-deadline
   *  and pre-Enter decisions — exposed so a test can assert directly that a
   *  single transient sighting is never enough on its own. */
  stillBlocking,
  /** Override how `queuePaste`'s modal guard reads the live pane before
   *  pasting (production captures the tmux pane tail). Tests inject a
   *  synthetic modal (or idle) pane so the guard can be driven without a
   *  real tmux session. Returns the previous reader so the test can restore
   *  it in `afterEach` (mirrors `setCaptureConfirmPane`). */
  setCapturePastePane(
    fn: (state: SessionState) => Promise<string>,
  ): (state: SessionState) => Promise<string> {
    const prev = capturePastePane;
    capturePastePane = fn;
    return prev;
  },
  /** Composer-clear check behind `queuePaste`'s composer-dirty branch: the
   *  pure pane predicate (`paneShowsComposerText`) plus the keystrokes/settle
   *  it sends to clear a stranded message before pasting a new one — exposed
   *  so both are unit-testable without a live tmux pane/session. */
  paneShowsComposerText,
  COMPOSER_CLEAR_KEYS,
  COMPOSER_CLEAR_SETTLE_MS,
  /** Pure per-tick step for `scrapeOnce`'s idle-settle streak — exposed so
   *  the eligible/streak/fire truth table (including the `lastActivityAt`
   *  recency requirement layered on at the call site) is unit-testable
   *  without a live tmux pane. */
  idleSettleTick,
  /** The matcher-chain union shared by `scrapeOnce` and the boot poller —
   *  exposed so the numbered > yes-no > slider > unparsable precedence (and
   *  the `paneWorking` gate on the last arm) is unit-testable directly,
   *  without duplicating it against each call site separately. */
  pickScrapeMatch,
  /** Compiled-once `esc to interrupt` matcher shared by `paneShowsIdleInputBox`
   *  and `paneShowsComposerText` — exposed for tests that want to assert
   *  against the regex itself rather than the string literal. */
  ESC_TO_INTERRUPT_RE,
  /** Orchestrator injection seam for claude's own `/model`/`/effort`
   *  outcome — re-exported (it's already a top-level `export`) so tests
   *  can install/restore it via the same `__forTest` surface as every other
   *  seam in this file. */
  setLocalSettingChangedHandler,
  /** Picker-driven model mirror — re-exported (already a top-level `export`)
   *  so tests reach it through the same surface as the helpers below. Drive
   *  it with `setCaptureConfirmPane` to feed it a synthetic picker/confirm
   *  pane, exactly as the `sendSlashCommand` auto-confirm tests do. */
  mirrorModelViaPicker,
  /** The pure half of that mirror: which picker row a family word selects,
   *  and the row-name parse behind it. Exposed so the `Opus (1M context)` /
   *  `Sonnet ✔` / `Default (recommended)` truth table — including the
   *  never-pick-Default rule from both directions — is unit-testable without
   *  a live tmux pane. */
  pickerChoiceIndexForFamily,
  pickerRowFamily,
  /** The mirror-attribution window that becomes `LocalSettingInfo.viaMirror`
   *  — exposed so a test can assert the boundary (a `Kept model as` inside
   *  the window is agetor's own declined `Switch model?`; one outside it is
   *  the user's own bare `/model` + Esc) without hardcoding 15 s. */
  MODEL_MIRROR_ATTRIBUTION_MS,
  /** The "agetor last touched this pane" clock: its single write site, so a
   *  test can age or refresh it deterministically instead of sleeping out
   *  `STUCK_TURN_FALLBACK_MS`, and the launch-effort accessor the
   *  orchestrator's breadcrumb reads. */
  bumpKeystroke,
  getSessionLaunchEffort,
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
 * Async (renamed from `pastePromptSync` — docs/plans/fix-task-details-load-
 * delay.md T1: `tmux()` itself moved off `Bun.spawnSync`, so nothing in this
 * file is truly "Sync" anymore). Its four tmux calls (load-buffer,
 * paste-buffer, delete-buffer, send-keys Enter) each now yield to the event
 * loop across the `await`.
 *
 * The load-bearing invariant is no longer "no awaits between tmux calls"
 * (that guarantee is gone by construction) — it's that this whole
 * micro-sequence is only ever invoked from inside a `queueTmuxOp`/`queuePaste`
 * body on the PER-TASK chain (`pasteChains`), so two calls for the *same*
 * task can never interleave their four steps with each other. Cross-task
 * interleaving is safe by construction too: each call targets a distinct
 * tmux session (`-t sessionName`) and a distinct, session-scoped buffer name
 * (`agetor-${sessionName}`), so even fully-concurrent awaits for different
 * tasks can never step on each other's buffer or pane. A session dying
 * mid-sequence (between, say, load-buffer and paste-buffer) is no longer
 * structurally impossible the way a single synchronous call made it — but it
 * doesn't need to be: the next tmux call in the sequence just comes back
 * `ok: false` (session gone), which this function already turns into a
 * `TmuxPasteFailure` the caller (`queuePaste`) already knows how to handle
 * (re-stash to the backlog, surface a status line) exactly as it does for
 * any other tmux failure.
 *
 * `skipEnter` defers the trailing Enter to the caller so it can insert a
 * gap before the `send-keys Enter`. See `queuePaste`'s bracketed branch
 * for the rationale (and the image-attach scaling layered on top of it).
 *
 * Callers go through `queuePaste` so back-to-back pastes for the same
 * task can't interleave at the tmux layer. See `queuePaste` for why.
 *
 * Returns a `{ ok: true } | TmuxPasteFailure` (the subset of `PasteOutcome`
 * an actual tmux call can produce — see `TmuxPasteFailure`'s doc) so a
 * persistent tmux failure (socket gone, server wedged, …) is visible to the
 * caller instead of silently swallowed — see `queuePaste`'s handling of a
 * non-`ok` result.
 */
async function pastePrompt(
  sessionName: string,
  text: string,
  opts: { bracketed?: boolean; skipEnter?: boolean } = {},
): Promise<{ ok: true } | TmuxPasteFailure> {
  // load-buffer reads from stdin; -b names a tmux buffer we can target.
  const buf = `agetor-${sessionName}`;
  const load = await tmux(["load-buffer", "-b", buf, "-"], { stdinText: text });
  if (!load.ok) return { ok: false, op: "load-buffer", stderr: load.stderr };
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
  const paste = await tmux(["paste-buffer", ...pasteFlags, "-b", buf, "-t", sessionName]);
  await tmux(["delete-buffer", "-b", buf]);
  if (!paste.ok) return { ok: false, op: "paste-buffer", stderr: paste.stderr };
  // `skipEnter` defers the trailing Enter to the caller so it can sleep
  // between the bracketed paste and the Enter — see `queuePaste`. Without
  // that gap, a follow-up turn pasted mid-stream gets rendered as `[Pasted
  // text +N lines]` in claude's TUI but the immediately-following `\r` is
  // absorbed as part of the same paste event, so the queued bubble sits
  // unsubmitted until the user (or a later Enter) commits it.
  if (!opts.skipEnter) {
    const enter = await tmux(["send-keys", "-t", sessionName, "Enter"]);
    if (!enter.ok) return { ok: false, op: "send-keys", stderr: enter.stderr };
  }
  return { ok: true };
}

/** Result of `pastePrompt` / the deferred bracketed-paste Enter in
 *  `queuePaste`, PLUS the guard's own synthesized withhold. `ok: false` for
 *  `op: "load-buffer" | "paste-buffer" | "send-keys"` means the tmux
 *  subprocess for `op` exited non-zero — a real signal that the paste didn't
 *  land (dead server, socket gone, session vanished mid-op), not just
 *  "nothing happened yet". `op: "modal-guard"` is different in kind: it's
 *  synthesized by `queuePaste` itself (never by `pastePrompt`, and never
 *  the result of an actual tmux call) when the paste — or its deferred
 *  bracketed Enter — is withheld because a live claude modal is still on the
 *  pane after the guard's grace window; see the guard blocks in `queuePaste`.
 *  Modeled as one union member per `op` (rather than a single failure member
 *  with a union-typed `op` field) specifically so `TmuxPasteFailure` below
 *  can `Exclude` the synthesized member and leave real narrowing behind —
 *  see its own doc. The `modal-guard` member alone carries `phase` (finding
 *  #2, docs/plans/model-effort-local-command-turns.md §10 review) — WHICH of
 *  `queuePaste`'s three withhold sites produced it: `"pre-paste"` (the
 *  before-any-tmux-call guard), `"pre-enter"` (the TOCTOU re-check right
 *  before the bracketed Enter — the text already landed in claude's
 *  composer), or `"composer-dirty"` (a NEW paste's own composer-clear check
 *  found the box still holding an earlier withheld message). Callers use
 *  `phase` to tailor what they tell the user — e.g. `"pre-enter"` and
 *  `"composer-dirty"` both mean the message is already sitting in claude's
 *  input box, so re-sending it would duplicate rather than deliver it. */
export type PasteOutcome =
  | { ok: true }
  | { ok: false; op: "load-buffer"; stderr: string }
  | { ok: false; op: "paste-buffer"; stderr: string }
  | { ok: false; op: "send-keys"; stderr: string }
  | { ok: false; op: "modal-guard"; phase: "pre-paste" | "pre-enter" | "composer-dirty"; stderr: string };

/**
 * The subset of `PasteOutcome` failures that actually came from a tmux
 * subprocess call (`pastePrompt`'s three failure ops, or the manually
 * constructed `"send-keys"` outcome for the deferred bracketed Enter) — i.e.
 * every `PasteOutcome` failure except the guard's own synthesized
 * `"modal-guard"`. Used as `pastePrompt`'s return type, so its declared
 * type itself proves (no cast needed) that it can never produce
 * `modal-guard`, and to narrow `reportPasteFailure`'s parameter (finding
 * #11, docs/plans/model-effort-local-command-turns.md §10) so its
 * `"tmux <op> — …"` template can never render an op that was never a tmux
 * call. The guard's own withhold emits its own status message inline at
 * both call sites in `queuePaste` and deliberately never goes through
 * `reportPasteFailure`.
 */
type TmuxPasteFailure = Exclude<Extract<PasteOutcome, { ok: false }>, { op: "modal-guard" }>;

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
 * when `pastePrompt` returns (i.e. when tmux's `send-keys Enter`
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

/** Gap (ms) chosen by the most recent `queuePaste` bracketed branch —
 *  the base `bracketedEnterGapMs` or the scaled image-attach settle.
 *  Recorded so tests can assert WHICH path the image detector picked
 *  without an upper-bound wall-clock assertion (those flake under
 *  scheduler load). Never read by production code. */
let lastBracketedGapMs: number | null = null;

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
 *
 * **Modal guard** (docs/plans/model-effort-local-command-turns.md §10):
 * right before either paste path runs, when `expectedState` is set and
 * `opts.skipModalGuard` isn't, the queued op polls `capturePastePane`
 * (`PASTE_MODAL_POLL_MS`, up to `opts.modalGuardGraceMs ??
 * PASTE_MODAL_GRACE_MS`) until `paneShowsBlockingPrompt` reports the pane
 * clear. This is what stops a paste from ever typing Enter into a live
 * claude modal — the confirm the user hasn't answered yet would swallow the
 * pasted text and/or confirm whatever the cursor happens to be on, neither
 * of which is "deliver this as the next chat message." If the modal is
 * STILL there once the grace window elapses, `stillBlocking` (a double
 * sample — finding #3, §10 review) confirms it isn't just a mid-repaint
 * transient before the paste is WITHHELD (no `pastePrompt` call at
 * all): a `status` chunk + console log surface it, and `opts.onPasteFailure`
 * fires with `{ ok: false, op: "modal-guard", phase: "pre-paste" }` exactly
 * like any other paste failure, so a caller with a turn slot (`sendTurn`)
 * settles it as failed instead of leaving the run stuck `running`.
 *
 * **Composer-clear check** (finding #2, §10 review; re-reviewed §10 again):
 * right after the pre-paste guard clears and before either paste path runs,
 * when `expectedState.composerHoldsText` is set (a PRIOR paste on this
 * session withheld its Enter with text already sitting in claude's
 * composer — see the pre-Enter re-check below, and the trailing-Enter
 * failure branches in both paste paths, which set the same flag), this
 * either clears that leftover text (`COMPOSER_CLEAR_KEYS`, idle pane only,
 * checked for `.ok` like any other tmux call) or withholds the NEW paste
 * with `phase: "composer-dirty"` — pasting on top of unsent text would
 * concatenate rather than replace it. No safe clear exists while claude is
 * working (Escape/Ctrl-C would interrupt the turn), so a working pane
 * withholds immediately instead of attempting one. The clear is verified
 * POSITIVELY afterwards — `paneShowsIdleInputBox` must report a confirmed
 * bare row (and `paneShowsBlockingPrompt` must NOT be showing) — rather than
 * merely `!paneShowsComposerText`, which can't tell "cleared to bare" apart
 * from "a NEW modal replaced the composer entirely" (a modal fails
 * `paneShowsComposerText` too). The "already bare" branch requires that same
 * positive `paneShowsIdleInputBox` read rather than the negation, for the
 * identical reason; a pane that satisfies neither predicate (no live prompt
 * row at all) withholds rather than guessing.
 *
 * WHEN the composer-clear block above actually attempted a clear (sent
 * `COMPOSER_CLEAR_KEYS` and slept `COMPOSER_CLEAR_SETTLE_MS` — not the
 * already-bare branch, which inserts no delay) — a further one-shot,
 * double-sampled (`stillBlocking`) re-check of `paneShowsBlockingPrompt` runs
 * right before dispatch, covering BOTH paste paths, since the non-bracketed
 * one sends paste+Enter synchronously with no pre-Enter net of its own
 * (unlike the bracketed path's own re-check below).
 *
 * The modal guard re-runs a THIRD time — one-shot, double-sampled via
 * `stillBlocking`, no polling loop — right before the deferred bracketed
 * Enter (when `opts.bracketed`), still gated on `expectedState &&
 * !opts.skipModalGuard`. A TOCTOU window opens between the pre-paste guard
 * clearing and the Enter actually going out: the `bracketedEnterGapMs` /
 * image-attach sleep and the `stillCurrent()` re-gate both land in between,
 * and either can outlast a NEW blocking modal appearing (a permission
 * prompt claude's own tool call raises mid-paste, for instance) that the
 * pre-paste guard never saw. By this point the text is ALREADY sitting in
 * claude's input buffer — the paste itself already landed — so a hit here
 * withholds only the Enter, with `{ ok: false, op: "modal-guard", phase:
 * "pre-enter" }` and a status message that says so explicitly (the message
 * is already in the input box; it'll be cleared before the next send)
 * rather than repeating the pre-paste wording, and it sets
 * `expectedState.composerHoldsText = true` so the composer-clear check
 * above knows to clean up before the next paste. A genuine tmux `send-keys`
 * failure on that same trailing Enter (bracketed or not) sets the identical
 * flag (finding #7, §10 re-review) — the preceding `paste-buffer` already
 * landed the text, so the composer holds it regardless of WHY the Enter
 * itself didn't go out. Any paste whose Enter actually goes out successfully
 * clears the flag — submitting the composer, including a message the flag
 * may have been set for.
 *
 * **Dropped ops** (finding #5, wave-5 re-review): a queued paste can also
 * never run its body at all — `queueTmuxOp`'s own identity gate drops it
 * when `dropSession` tears down (or a respawn replaces) the `SessionState`
 * this paste was scheduled against before the chain reaches it. That case is
 * NOT silent: the returned promise's own backstop (see `PASTE_DROPPED_OUTCOME`
 * below) fires `opts.onPasteOutcome`/`opts.onPasteFailure` with a
 * `stderr` that says exactly what happened, so a dropped op now behaves like
 * any other paste failure — a caller that pushed a turn slot for this paste
 * (`sendTurn`) settles it instead of leaving the run stuck `running`, and the
 * orchestrator's `onPasteFailure` handling re-stashes the message rather than
 * losing it when `dropSession` lands mid-paste.
 */
function queuePaste(
  taskId: string,
  sessionName: string,
  text: string,
  settleMs: number,
  expectedState?: SessionState,
  opts: {
    bracketed?: boolean;
    /** Called with the failing outcome when the paste (or its deferred
     *  bracketed Enter) doesn't land — i.e. any `PasteOutcome` with
     *  `ok: false`. Lets a caller that pushed a turn slot for this paste
     *  (currently only `sendTurn`) settle that slot instead of leaving the
     *  run stuck `running` forever. `reportPasteFailure` (the visible-chunk
     *  + log side of this) always runs regardless of whether this is set. */
    onPasteFailure?: (outcome: Extract<PasteOutcome, { ok: false }>) => void;
    /**
     * Called EXACTLY ONCE with this paste's terminal outcome — `{ ok: true }`
     * when the text (and, on the bracketed path, its trailing Enter) actually
     * went out, or the same failing outcome `onPasteFailure` receives. This is
     * the superset hook: every `onPasteFailure` call is preceded by an
     * `onPasteOutcome` call carrying the identical object, and the success
     * case has no `onPasteFailure` equivalent at all.
     *
     * "Exactly once" is guaranteed even for the paths that never reach either
     * paste branch — a `!stillCurrent()` abort mid-op, or `queueTmuxOp`'s own
     * identity gate dropping the body before it runs. Those resolve with a
     * synthesized `{ op: "send-keys" }` failure (see `PASTE_DROPPED_OUTCOME`)
     * once the queued op's promise settles, so a caller awaiting a promise
     * built on this hook can never hang.
     *
     * `sendTurn` / `pasteFollowUp` use it to expose `pasteOutcome` on their
     * return value; nothing else needs it (the failure-only hook above is
     * enough when you only care about the bad path).
     */
    onPasteOutcome?: (outcome: PasteOutcome) => void;
    /**
     * Override the modal guard's grace window (default `PASTE_MODAL_GRACE_MS`)
     * for this paste only. Pass `0` to still RUN the guard check — unlike
     * `skipModalGuard`, which skips it outright — with the deadline already
     * elapsed, so the ONLY delay left is `stillBlocking`'s own one-poll
     * double-sample confirmation (finding #11b, §10 re-review: this used to
     * say "never actually wait", which stopped being true once that
     * double-sample was added — a zero grace still costs one
     * `PASTE_MODAL_POLL_MS` sleep, just never a real waiting-for-the-user
     * grace window): see the boot-time deferred-prompt paste in
     * `spawnClaudeViaTmux`, the one caller that needs exactly this (finding
     * #6, docs/plans/model-effort-local-command-turns.md §10).
     */
    modalGuardGraceMs?: number;
    /**
     * Skip the modal guard for this paste ENTIRELY — no pane check runs at
     * all, not even a zero-wait one (contrast `modalGuardGraceMs: 0`, which
     * still checks, just never waits). No production caller sets this
     * today: the boot-time deferred-prompt paste looked like a candidate —
     * that poller already confirms `readPaneMode(state) !== null` (composer
     * idle) before arming its own paste, and separately re-arms a fresh
     * window rather than pasting over an unanswered startup dialog — but its
     * own give-up branch can still reach the paste with NO card registered
     * for whatever's on the pane, which is precisely the un-carded,
     * footer-armed case this guard exists to catch. So it uses
     * `modalGuardGraceMs: 0` instead of this flag: the check must still run
     * once, even though a wait would be pointless. `skipModalGuard` remains
     * an explicit, fully-skipping opt-out for tests and any future caller
     * that genuinely owns pane safety some other way.
     */
    skipModalGuard?: boolean;
  } = {},
): Promise<void> {
  // Bump the keystroke clock at ENQUEUE, before this paste ever reaches
  // `queueTmuxOp` (finding #1, wave-5 re-review). Queuing a paste IS the
  // intent to type — without this, a `sendTurn` whose paste sits queued
  // behind other per-task tmux ops on a long-idle session could still be
  // idle-settled by `scrapeOnce` (which gates on `lastKeystrokeAt`, not
  // "is something queued") before the paste is ever dispatched, closing the
  // turn out from under a message that hasn't been delivered yet. The bump
  // inside the queued op itself (right before each dispatch, below) stays —
  // it is NOT redundant: it re-covers the case where dequeue itself was
  // delayed well past this enqueue-time stamp.
  if (expectedState) bumpKeystroke(expectedState);
  // Non-bracketed path: load-buffer + paste-buffer + delete-buffer +
  // send-keys Enter each now await their own tmux() round-trip inside
  // `pastePrompt` (it stopped being truly "synchronous" the moment `tmux()`
  // itself moved off `Bun.spawnSync` — see `pastePrompt`'s doc for how
  // atomicity survives that: the per-task chain plus per-session buffer
  // names, not an uninterruptible call). The settle sleep after it returns is
  // just one more await in the same already-async op body.
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
  //
  // Every tmux op below is checked for `.ok`. A `false` result is a real
  // signal (dead tmux server, socket gone, session vanished mid-op) — not
  // "nothing happened yet" — so on failure we surface it via
  // `reportPasteFailure` (a visible `status` chunk + a console log) and
  // bail out of this op without sleeping the settle window. A transient
  // failure that still succeeds on `.ok` behaves exactly as before this
  // change; only genuine `.ok === false` results take the new path.
  //
  // `report` is the single notification funnel for this paste's terminal
  // outcome: it fires `opts.onPasteOutcome` (always) and `opts.onPasteFailure`
  // (failures only), and is idempotent — first call wins — so the
  // "op was dropped" backstop attached to the returned promise below can be
  // unconditional without ever double-reporting a paste that already
  // succeeded or already failed for a real reason.
  let outcomeReported = false;
  const report = (outcome: PasteOutcome): void => {
    if (outcomeReported) return;
    outcomeReported = true;
    opts.onPasteOutcome?.(outcome);
    if (!outcome.ok) opts.onPasteFailure?.(outcome);
  };
  const chain = queueTmuxOp(taskId, async (stillCurrent) => {
    // Modal guard — see this function's doc. Runs BEFORE either paste path,
    // and only when there's a real SessionState to gate on (the identity
    // check `queueTmuxOp` already relies on) and the caller hasn't opted
    // out. Loop rather than a single check: an auto-confirm's Enter (or any
    // other keystroke) can leave the pane mid-repaint for a tick or two —
    // the grace window covers that without waiting anywhere near long
    // enough to feel like the paste silently vanished.
    if (expectedState && !opts.skipModalGuard) {
      const graceMs = opts.modalGuardGraceMs ?? PASTE_MODAL_GRACE_MS;
      const guardDeadline = Date.now() + graceMs;
      while (paneShowsBlockingPrompt(await capturePastePane(expectedState))) {
        if (!stillCurrent()) return;
        if (Date.now() >= guardDeadline) {
          // Double-sample before withholding (finding #3, docs/plans/model-
          // effort-local-command-turns.md §10 review) — also what turns the
          // `modalGuardGraceMs: 0` boot-time path into "one extra sample, not
          // zero": a single frame can be a mid-repaint transient.
          const blocked = await stillBlocking(expectedState);
          if (!stillCurrent()) return;
          if (!blocked) break;
          const outcome: Extract<PasteOutcome, { ok: false }> =
            { ok: false, op: "modal-guard", phase: "pre-paste", stderr: "claude modal on pane" };
          const onChunk = expectedState.turnQueue[0]?.onChunk ?? expectedState.lastChunk;
          const message =
            "paste withheld: claude is waiting on a prompt — answer it in the card or the terminal and resend";
          onChunk?.("status", message);
          console.error(`[claude-tmux] ${message} (task ${taskId})`);
          report(outcome);
          return;
        }
        await Bun.sleep(PASTE_MODAL_POLL_MS);
        if (!stillCurrent()) return;
      }
    }
    // Composer-clear check (finding #2, docs/plans/model-effort-local-
    // command-turns.md §10 review): a PRIOR paste on this session withheld
    // its Enter (the pre-Enter TOCTOU re-check below) with the text already
    // sitting, unsent, in claude's composer — `expectedState.composerHoldsText`
    // records that. Pasting a NEW message now would land concatenated after
    // that leftover text instead of replacing it, so — only when the guard
    // itself is active — either clear the composer first or withhold.
    //
    // `insertedComposerClearDelay` tracks whether the branch below actually
    // sent `COMPOSER_CLEAR_KEYS` and slept `COMPOSER_CLEAR_SETTLE_MS` — the
    // ONLY sub-branch that opens a real TOCTOU window before either paste
    // path. It gates the pre-paste re-check right below this block: a
    // composer that was already bare (no keystrokes, no sleep) is no more
    // stale than what the top-of-function guard already confirmed a moment
    // earlier, so re-checking there would just be an extra pane read with
    // nothing to catch.
    let insertedComposerClearDelay = false;
    if (expectedState && !opts.skipModalGuard && expectedState.composerHoldsText) {
      const tail = await capturePastePane(expectedState);
      if (!stillCurrent()) return;
      if (paneShowsClaudeWorking(tail)) {
        // No safe mid-turn clear — Escape/Ctrl-C would interrupt the live
        // turn (see COMPOSER_CLEAR_KEYS's doc) — so withhold until idle.
        const outcome: Extract<PasteOutcome, { ok: false }> =
          { ok: false, op: "modal-guard", phase: "composer-dirty", stderr: "claude composer holds unsent text" };
        const onChunk = expectedState.turnQueue[0]?.onChunk ?? expectedState.lastChunk;
        const message =
          "paste withheld: claude's input box still holds your earlier message — it will be cleared once claude is idle; resend after that";
        onChunk?.("status", message);
        console.error(`[claude-tmux] ${message} (task ${taskId})`);
        report(outcome);
        return;
      }
      if (paneShowsComposerText(tail)) {
        // (finding #8, §10 re-review) `send-keys` can itself fail (dead
        // server, socket gone, session vanished mid-op) exactly like any
        // other tmux call — check `.ok` rather than assuming the clear
        // keystrokes landed just because a pane re-capture follows.
        bumpKeystroke(expectedState);
        // No `stillCurrent()` gate immediately after this await, for the same
        // reason as the `pastePrompt` call below: a real send-keys failure
        // here must still be reported (invariant #3), not swallowed behind a
        // stale-session check. `stillCurrent()` gates the settle sleep right
        // after instead, before any further action is taken on success.
        const clearResult = await tmux(["send-keys", "-t", sessionName, ...COMPOSER_CLEAR_KEYS]);
        if (!clearResult.ok) {
          const outcome: Extract<PasteOutcome, { ok: false }> =
            { ok: false, op: "modal-guard", phase: "composer-dirty", stderr: clearResult.stderr || "composer-clear send-keys failed" };
          const onChunk = expectedState.turnQueue[0]?.onChunk ?? expectedState.lastChunk;
          const message =
            "paste withheld: claude's input box still holds your earlier message — it will be cleared once claude is idle; resend after that";
          onChunk?.("status", message);
          console.error(`[claude-tmux] ${message} (task ${taskId})`);
          report(outcome);
          return;
        }
        insertedComposerClearDelay = true;
        await Bun.sleep(COMPOSER_CLEAR_SETTLE_MS);
        if (!stillCurrent()) return;
        // Confirm the clear POSITIVELY (finding #2, §10 re-review) — a
        // negative check (`!paneShowsComposerText`) can't distinguish
        // "cleared to a bare prompt" from "a NEW blocking modal replaced the
        // composer entirely" (which also fails `paneShowsComposerText`,
        // since that predicate requires `!paneShowsClaudeWorking` and a
        // genuine `❯`-row, neither of which a modal provides). Require both
        // "no blocking prompt" AND a confirmed bare row before trusting it.
        const after = await capturePastePane(expectedState);
        if (!stillCurrent()) return;
        if (paneShowsBlockingPrompt(after) || !paneShowsIdleInputBox(after)) {
          const outcome: Extract<PasteOutcome, { ok: false }> =
            { ok: false, op: "modal-guard", phase: "composer-dirty", stderr: "composer clear did not take" };
          const onChunk = expectedState.turnQueue[0]?.onChunk ?? expectedState.lastChunk;
          const message =
            "paste withheld: claude's input box still holds your earlier message — it will be cleared once claude is idle; resend after that";
          onChunk?.("status", message);
          console.error(`[claude-tmux] ${message} (task ${taskId})`);
          report(outcome);
          return;
        }
        expectedState.composerHoldsText = false;
      } else if (paneShowsIdleInputBox(tail)) {
        // Prompt line already bare — the user submitted or cleared it some
        // other way (typed Enter themselves, a modal that consumed it, …).
        // Nothing left to clear. Requires the POSITIVE `paneShowsIdleInputBox`
        // read (finding #2, §10 re-review), not merely `!paneShowsComposerText`
        // — an ambiguous pane (no anchored status bar at all, e.g. a modal)
        // must not be waved through as "already bare".
        expectedState.composerHoldsText = false;
      } else {
        // Neither a confirmed dirty composer nor a confirmed idle one —
        // `livePromptRow` found no anchored live prompt row at all (most
        // likely a blocking modal that appeared since the pre-paste guard
        // above ran). Withhold rather than paste blind.
        const outcome: Extract<PasteOutcome, { ok: false }> =
          { ok: false, op: "modal-guard", phase: "composer-dirty", stderr: "claude pane state unclear" };
        const onChunk = expectedState.turnQueue[0]?.onChunk ?? expectedState.lastChunk;
        const message =
          "paste withheld: claude's input box still holds your earlier message — it will be cleared once claude is idle; resend after that";
        onChunk?.("status", message);
        console.error(`[claude-tmux] ${message} (task ${taskId})`);
        report(outcome);
        return;
      }
    }
    // Pre-paste re-check (finding #2, §10 re-review): ONLY when the
    // composer-clear block above actually inserted its own keystrokes +
    // COMPOSER_CLEAR_SETTLE_MS (300 ms) — see `insertedComposerClearDelay` —
    // is there a real TOCTOU window before either paste path below that
    // neither the top-of-function guard nor the composer-clear check itself
    // ever saw (e.g. a permission prompt that appeared during that sleep).
    // Re-run the same double-sampled check right before dispatch so BOTH
    // paste paths get this net — the non-bracketed path sends paste+Enter
    // synchronously with no separate pre-Enter check of its own, unlike the
    // bracketed path below.
    if (insertedComposerClearDelay && expectedState && !opts.skipModalGuard) {
      const blocked = await stillBlocking(expectedState);
      if (!stillCurrent()) return;
      if (blocked) {
        const outcome: Extract<PasteOutcome, { ok: false }> =
          { ok: false, op: "modal-guard", phase: "pre-paste", stderr: "claude modal on pane" };
        const onChunk = expectedState.turnQueue[0]?.onChunk ?? expectedState.lastChunk;
        const message =
          "paste withheld: claude is waiting on a prompt — answer it in the card or the terminal and resend";
        onChunk?.("status", message);
        console.error(`[claude-tmux] ${message} (task ${taskId})`);
        report(outcome);
        return;
      }
    }
    if (opts.bracketed) {
      if (expectedState) bumpKeystroke(expectedState);
      // No `stillCurrent()` gate right after this await (unlike the pane-read
      // awaits above): `pastePrompt` already ran its tmux calls against
      // whatever session was live when they fired, and that outcome — success
      // or a real tmux failure — is the truth to report either way (invariant
      // #3: mid-sequence session death surfaces as a non-ok result, not a
      // suppressed one). `stillCurrent()` still gates every action taken
      // AFTER this point, below.
      const result = await pastePrompt(sessionName, text, { bracketed: true, skipEnter: true });
      if (!result.ok) {
        reportPasteFailure(taskId, expectedState, result);
        report(result);
        return;
      }
      const imageCount = countImagePaths(text);
      const gap = imageCount > 0
        ? Math.min(imageAttachSettleMs * imageCount, IMAGE_ATTACH_SETTLE_MAX_MS)
        : bracketedEnterGapMs;
      lastBracketedGapMs = gap;
      if (gap > 0) await Bun.sleep(gap);
      if (!stillCurrent()) return;
      // TOCTOU re-check (finding #5, docs/plans/model-effort-local-command-
      // turns.md §10): the gap we just slept through — and stillCurrent()'s
      // own re-gate above — is exactly enough time for a NEW blocking modal
      // to appear that the pre-paste guard above never saw (e.g. a
      // permission prompt claude's own tool call raises mid-paste). The
      // pasted text is ALREADY in claude's input buffer at this point (the
      // paste itself already landed) — only the Enter is at risk of
      // confirming the wrong thing — so withhold just the Enter and say so.
      if (expectedState && !opts.skipModalGuard) {
        // Double-sample here too (finding #3) — this was previously a single
        // synchronous check; a mid-repaint transient shouldn't strand the
        // already-landed paste text unsent any more than the pre-paste guard
        // should.
        const blocked = await stillBlocking(expectedState);
        if (!stillCurrent()) return;
        if (blocked) {
          // The text is ALREADY sitting in claude's composer at this point
          // (the paste itself already landed) — flag it so the NEXT queued
          // paste clears it first instead of concatenating after it
          // (finding #2).
          expectedState.composerHoldsText = true;
          const outcome: Extract<PasteOutcome, { ok: false }> =
            { ok: false, op: "modal-guard", phase: "pre-enter", stderr: "claude modal on pane" };
          const onChunk = expectedState.turnQueue[0]?.onChunk ?? expectedState.lastChunk;
          const message =
            "paste withheld before Enter: claude opened a prompt — your message is still in claude's input box; it will be cleared before your next send";
          onChunk?.("status", message);
          console.error(`[claude-tmux] ${message} (task ${taskId})`);
          report(outcome);
          return;
        }
      }
      if (expectedState) bumpKeystroke(expectedState);
      const enter = await tmux(["send-keys", "-t", sessionName, "Enter"]);
      if (!enter.ok) {
        const outcome: TmuxPasteFailure =
          { ok: false, op: "send-keys", stderr: enter.stderr };
        reportPasteFailure(taskId, expectedState, outcome);
        // (finding #7, §10 re-review) The paste-buffer call above already
        // succeeded — the text IS sitting in claude's composer even though
        // the trailing Enter itself failed at the tmux level — so flag it
        // exactly like the modal-guard `pre-enter` withhold does, or the
        // next paste on this session would concatenate on top of it instead
        // of clearing it first.
        if (expectedState) expectedState.composerHoldsText = true;
        report(outcome);
        return;
      }
      // Successful Enter — the composer is submitted; any earlier withheld
      // text (which may be THIS message itself) is no longer sitting there.
      if (expectedState) expectedState.composerHoldsText = false;
      // Terminal success for the bracketed path: the paste-buffer AND its
      // trailing Enter both went out, so the message is genuinely delivered.
      report({ ok: true });
    } else {
      if (expectedState) bumpKeystroke(expectedState);
      const result = await pastePrompt(sessionName, text, { bracketed: opts.bracketed });
      if (!result.ok) {
        reportPasteFailure(taskId, expectedState, result);
        // (finding #7, §10 re-review) `pastePrompt` without `skipEnter`
        // runs load-buffer + paste-buffer + send-keys Enter in sequence —
        // an `op: "send-keys"` failure here means the paste itself already
        // landed and only the Enter didn't, so the composer holds this text
        // exactly like the bracketed path's Enter-failure branch above.
        if (expectedState && result.op === "send-keys") expectedState.composerHoldsText = true;
        report(result);
        return;
      }
      if (expectedState) expectedState.composerHoldsText = false;
      // Terminal success for the non-bracketed path: `pastePrompt`
      // without `skipEnter` runs load-buffer + paste-buffer + Enter in
      // sequence, so an `ok` result means all three landed.
      report({ ok: true });
    }
    if (settleMs > 0) await Bun.sleep(settleMs);
  }, expectedState);
  // Terminal-outcome backstop: every `return` inside the op body above either
  // reported already or bailed on `!stillCurrent()` — and `queueTmuxOp` can
  // also drop the body outright at its own identity gate, before a single
  // line of it runs. Both mean the keystrokes never went out. `report` is
  // idempotent, so firing it unconditionally once the chain settles turns
  // "exactly once" into a guarantee (see `opts.onPasteOutcome`) without ever
  // overriding a real outcome that already went through.
  void chain.then(() => report(PASTE_DROPPED_OUTCOME));
  return chain;
}

/**
 * Terminal outcome for a paste whose queued tmux op never ran (or aborted
 * part-way) because the session it was scheduled against stopped being the
 * current one — `queueTmuxOp`'s identity gate, or one of the in-op
 * `stillCurrent()` re-gates; both mean a `dropSession` / respawn landed
 * first, and no keystrokes reached the pane.
 *
 * Deliberately modeled as the EXISTING `op: "send-keys"` failure rather than
 * a new `PasteOutcome` member: consumers (`reportPasteFailure`'s
 * `"tmux <op> — …"` template, the orchestrator's `handlePasteWithheld`, which
 * branches on `op === "modal-guard"` and then on `phase`) already narrow over
 * today's union, and widening it would silently change every one of those
 * branches. `"send-keys"` is also the honest reading — the keystrokes are
 * exactly what didn't happen. The `stderr` text is what distinguishes this
 * from a real tmux failure in a log or a status chunk.
 */
const PASTE_DROPPED_OUTCOME: TmuxPasteFailure = {
  ok: false,
  op: "send-keys",
  stderr: "paste dropped: the session was disposed or respawned before the queued paste ran",
};

/**
 * Surface a persistent paste failure so a run never sits `running` forever
 * with no signal of what happened. Emits a `status` chunk (mirroring the
 * `SESSION_DIED_STATUS_PREFIX` / `CLAUDE_API_ERROR_STATUS_PREFIX` convention
 * of routing failures through the normal chunk stream rather than a separate
 * channel) on whichever handler is currently active for the session — the
 * head turn slot if one exists, else the hangover `lastChunk` — and logs to
 * the console for operator visibility (matches `queueTmuxOp`'s existing
 * `console.error` convention).
 *
 * Deliberately does NOT invent a new sentinel prefix the orchestrator would
 * pattern-match into a column move: this path can fire on a plain slash
 * command or a folded follow-up where there's no turn slot to settle, so
 * moving the whole task would be too broad a blast radius. Settling the
 * *run* (when a slot exists) is the caller's job via `onPasteFailure` — see
 * `sendTurn`.
 *
 * `outcome` is typed as `TmuxPasteFailure` (finding #11, docs/plans/model-
 * effort-local-command-turns.md §10) — never the guard's own synthesized
 * `"modal-guard"` — so the `"tmux <op> — …"` template below can never render
 * an op that was never an actual tmux call. The guard withholds via its own
 * inline status message at both call sites in `queuePaste`, never through
 * this function.
 */
function reportPasteFailure(
  taskId: string,
  state: SessionState | undefined,
  outcome: TmuxPasteFailure,
): void {
  const onChunk = state?.turnQueue[0]?.onChunk ?? state?.lastChunk;
  const detail = outcome.stderr || "(no stderr)";
  const message = `paste failed: tmux ${outcome.op} — ${detail}`;
  onChunk?.("status", message);
  console.error(`[claude-tmux] ${message} (task ${taskId})`);
}
