import {
  existsSync,
  mkdirSync,
  watch as fsWatch,
  type FSWatcher,
  openSync as fsOpenSync,
  readSync as fsReadSync,
  closeSync as fsCloseSync,
  statSync as fsStatSync,
  writeFileSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { dataDir } from "./db.ts";
import { resolveTmuxBin, tmuxSocketArgs } from "./tmux-resolution.ts";
import { createDeathProbe } from "./session-liveness.ts";
import { SESSION_DIED_STATUS_PREFIX } from "../shared/types.ts";
import {
  DEATH_JSONL_QUIET_MS,
  DEATH_MISS_THRESHOLD,
  deathTickOutcome,
  fileWrittenWithin,
  killSessionByName,
  panePidFor,
  sessionExistsByName,
  sessionLiveness,
  sessionNameFor,
  type ChunkHandler,
  type SpawnedAgent,
} from "./claude-tmux.ts";

/**
 * Driver that hosts a single `cursor-agent -p` turn inside a per-task tmux
 * session and exposes structured streaming by tailing the newline-delimited
 * JSON event log cursor-agent writes (via `--output-format stream-json`).
 *
 * Structural clone of `codex-tmux.ts` — see that file's header for the full
 * rationale on tmux-hosting a one-shot CLI turn (restart survival: a bare
 * child process dies with the agetor process, a detached tmux session
 * doesn't). The only lifecycle difference from codex is what carries
 * multi-turn continuity: cursor's `session_id` (captured from the first
 * event, any type — cursor stamps it on every line, unlike codex's dedicated
 * `thread.started` event) replayed via `--resume <session_id>` on the next
 * turn. Each follow-up is a fresh tmux session + a fresh run row; there is no
 * live REPL between turns.
 *
 * Capture mechanism differs from codex in one important way: cursor-agent's
 * stdin-prompt support is unverified (per the plan's Cursor CLI contract), so
 * the prompt is delivered as a positional argv element, never piped via
 * stdin and never string-interpolated into the `sh -c` command. See
 * `spawnCursorViaTmux` for the exact quoting-safe hosting pattern.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * Paths (derivable from runId alone, so reattach can recompute them).
 * ────────────────────────────────────────────────────────────────────────── */

const CURSOR_LOG_DIR = path.join(dataDir, "cursor-logs");

export function cursorLogPath(runId: string): string {
  return path.join(CURSOR_LOG_DIR, `${runId}.jsonl`);
}
function cursorPromptPath(runId: string): string {
  return path.join(CURSOR_LOG_DIR, `${runId}.prompt.txt`);
}
/** Exit-code sidecar written by the hosting shell's trailing `echo $? >
 *  <exitfile>` (see `spawnCursorViaTmux`). Its presence is what lets the
 *  death-watch tell an ordinary process exit (no `result` event, e.g. a
 *  turn that errored out before printing one) apart from a genuine session
 *  death (crash, external kill, tmux server gone) — only the latter should
 *  ever surface the `SESSION_DIED_STATUS_PREFIX` sentinel. */
function cursorExitPath(runId: string): string {
  return path.join(CURSOR_LOG_DIR, `${runId}.exit`);
}
function ensureLogDir(): void {
  if (!existsSync(CURSOR_LOG_DIR)) mkdirSync(CURSOR_LOG_DIR, { recursive: true });
}

/** Parse the exit-code sidecar for a run. Returns `null` when the file
 *  doesn't exist yet (turn still in flight) or its contents aren't a valid
 *  integer — both cases the caller must treat as "no verdict available",
 *  not as exit code 0. Exported so the parse logic is unit-testable without
 *  a real tmux session. */
export function readCursorExitCode(runId: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(cursorExitPath(runId), "utf8").trim();
  } catch {
    return null;
  }
  if (!/^-?\d+$/.test(raw)) return null;
  const code = Number.parseInt(raw, 10);
  return Number.isFinite(code) ? code : null;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Event mapping (cursor `stream-json` event → agetor RunEvent chunks).
 * ────────────────────────────────────────────────────────────────────────── */

interface CursorMessageBlock {
  type?: string;
  text?: string;
  [k: string]: unknown;
}
interface CursorEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  call_id?: string;
  tool_call?: unknown;
  message?: { content?: CursorMessageBlock[]; [k: string]: unknown };
  is_error?: boolean;
  result?: string;
  [k: string]: unknown;
}

/** Result of mapping one event line. `done` is set when the event terminates
 *  the turn (`result` → 0 on success, 1 on `is_error`). `sessionId` is set on
 *  the first event that carries one (typically `system/init`, but cursor
 *  stamps `session_id` on every event, so any line can supply it).
 *  `assistantTextEmitted` is set (to `true`) only by the `assistant` case
 *  when it actually streamed non-empty text — callers fold this into their
 *  per-run "did we already narrate this turn" state and pass it back in on
 *  the next call as `priorAssistantText` (see `mapCursorEvent`'s `result`
 *  case). */
export interface CursorMapResult {
  done?: number;
  sessionId?: string;
  assistantTextEmitted?: true;
}

/** Best-effort tool name for generic rendering — the `tool_call` envelope's
 *  inner `tool_call` payload shape is explicitly unstable (plan §2). We
 *  first look for a known string-valued name field (`name` / `tool` /
 *  `tool_name`, the shapes cursor-agent is documented to use), and only
 *  fall back to "first key of the object" when none is present — otherwise
 *  a payload shaped `{name: "shellToolCall", args: {...}}` would render the
 *  literal string "name" rather than the tool's actual name. */
function bestEffortToolName(toolCall: unknown): string {
  if (toolCall && typeof toolCall === "object" && !Array.isArray(toolCall)) {
    const obj = toolCall as Record<string, unknown>;
    for (const field of ["name", "tool", "tool_name"]) {
      const value = obj[field];
      if (typeof value === "string" && value.length > 0) return value;
    }
    const keys = Object.keys(obj);
    if (keys.length > 0) return keys[0]!;
  }
  return "tool_call";
}

/** Concatenate an assistant message's text content blocks. Cursor's assistant
 *  event carries the FULL message content (not deltas — see plan §2, we
 *  deliberately don't pass `--stream-partial-output`), so this is simply a
 *  join of every `type: "text"` block. */
function assistantText(message: CursorEvent["message"]): string {
  const blocks = Array.isArray(message?.content) ? message!.content! : [];
  return blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/**
 * Map a single parsed cursor `stream-json` event to zero or more chunks.
 * `lineIndex` is the 0-based index of this NDJSON line within the per-run
 * log — used (rather than a monotonic in-memory counter) so the derived
 * `line_uuid` is stable across a reattach replay that re-reads the log from
 * offset 0 (plan §3.6/§4 T3 point 4).
 *
 * `priorAssistantText` is whether an earlier line in THIS turn already
 * streamed assistant text (threaded in by the caller the same way
 * `lineIndex` is — `mapCursorEvent` itself is stateless/pure, so it can't
 * remember prior calls on its own). It's only consulted by the `result`
 * case: cursor's `assistant` event and `result` event both carry the same
 * final answer on a normal turn, so the `result` text is suppressed when
 * `priorAssistantText` is true, and only rendered as a fallback for the
 * pure-tool-call turns whose narration shows up nowhere else. Defaults to
 * `false` so callers that don't care (most tests) don't have to pass it.
 *
 * line_uuid scheme:
 *   - `tool_call:<call_id>:<subtype>` for `tool_call` events — the subtype
 *     suffix keeps `started` and `completed` (same call_id) from colliding
 *     under the `(run_id, line_uuid)` unique index.
 *   - `cursor:<lineIndex>` for everything else.
 */
export function mapCursorEvent(
  evt: CursorEvent,
  onChunk: ChunkHandler,
  lineIndex: number,
  priorAssistantText: boolean = false,
): CursorMapResult {
  const type = evt.type ?? "";
  const sessionId = typeof evt.session_id === "string" ? evt.session_id : undefined;

  switch (type) {
    case "system": {
      // `subtype: "init"` carries the session_id (the analog of codex's
      // thread.started) — no visible chunk, mirroring codex's silent
      // handling of its own session-establishing event.
      return { sessionId };
    }

    case "user":
      // Our own prompt echoed back by cursor-agent — not new content.
      // Mirrors codex's treatment of synthetic/echoed input (silent).
      return { sessionId };

    case "assistant": {
      const text = assistantText(evt.message);
      if (text) {
        onChunk("assistant", text, `cursor:${lineIndex}`);
        return { sessionId, assistantTextEmitted: true };
      }
      return { sessionId };
    }

    case "tool_call": {
      const callId = typeof evt.call_id === "string" ? evt.call_id : `line${lineIndex}`;
      const subtype = evt.subtype ?? "";
      const key = `tool_call:${callId}:${subtype}`;
      const name = bestEffortToolName(evt.tool_call);
      if (subtype === "started") {
        onChunk("tool_use", JSON.stringify({
          id: callId,
          name,
          input: evt.tool_call ?? {},
          serverSide: false,
        }), key);
      } else if (subtype === "completed") {
        onChunk("tool_result", JSON.stringify({
          toolUseId: callId,
          content: evt.tool_call ?? {},
          isError: false,
        }), key);
      } else {
        // Unknown subtype: forward-compat generic rendering rather than
        // silently dropping it.
        onChunk("tool_use", JSON.stringify({
          id: callId,
          name,
          input: evt.tool_call ?? {},
          serverSide: false,
        }), key);
      }
      return { sessionId };
    }

    case "result": {
      const isError = evt.is_error === true;
      // `result` is the authoritative final text — only emit it as an
      // assistant chunk when the turn produced no assistant text of its own
      // (some turns are pure tool-call sequences whose narration only shows
      // up here). Guarded by `priorAssistantText` — cursor's `assistant`
      // event and `result` event carry the SAME final answer on a normal
      // turn, so emitting both would double-render it.
      if (!priorAssistantText && typeof evt.result === "string" && evt.result.length > 0) {
        onChunk("assistant", evt.result, `cursor:${lineIndex}`);
      }
      return { sessionId, done: isError ? 1 : 0 };
    }

    default:
      // Unknown top-level event types: silent forward-compat, mirroring
      // codex's default case.
      return { sessionId };
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Session state + tailer.
 * ────────────────────────────────────────────────────────────────────────── */

interface CursorSessionState {
  taskId: string;
  runId: string;
  sessionName: string;
  logPath: string;
  offset: number;
  /** Holds incomplete trailing UTF-8 byte sequences across reads so a
   *  multi-byte character split on a poll boundary isn't corrupted. */
  decoder: StringDecoder;
  partial: string;
  /** 0-based index of the next NDJSON line to be read from this log —
   *  threaded into `mapCursorEvent` so `line_uuid` is stable across a
   *  reattach replay from offset 0 (same physical line → same index). */
  nextLineIndex: number;
  /** Whether an `assistant` event has already streamed non-empty text this
   *  turn — threaded into `mapCursorEvent`'s `priorAssistantText` param so
   *  the `result` case can suppress the duplicate final-answer text (Fix 1).
   *  Per-run/one-shot state: a new run gets a fresh `CursorSessionState`, so
   *  there's no mid-run reset to worry about — even a reattach replay from
   *  offset 0 recomputes this correctly as it re-walks the log in order. */
  assistantTextEmitted: boolean;
  watcher: FSWatcher | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  deathTimer: ReturnType<typeof setInterval> | null;
  seenLineUuids: Set<string>;
  onChunk: ChunkHandler;
  onSessionId?: (id: string) => void;
  sessionIdSent: boolean;
  resolved: boolean;
  lastCode: number | null;
  resolveDone: (code: number) => void;
}

const cursorSessions = new Map<string, CursorSessionState>(); // taskId -> state

const POLL_MS = 150;
const DEATH_POLL_MS = 400;
/** Grace after the tmux session disappears before we resolve, so the final
 *  appended bytes (the `result` event) are flushed and read. Poll + grace
 *  stay driver-local (cursor is one-shot); the death-decision inputs
 *  `DEATH_MISS_THRESHOLD` + `DEATH_JSONL_QUIET_MS` are imported from
 *  claude-tmux so both watches share one `deathTickOutcome` contract and
 *  can't drift. */
const DEATH_GRACE_MS = 250;

function disposeCursorState(state: CursorSessionState): void {
  if (state.watcher) { try { state.watcher.close(); } catch { /* noop */ } state.watcher = null; }
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  if (state.deathTimer) { clearInterval(state.deathTimer); state.deathTimer = null; }
}

/** Read any bytes appended since `state.offset`, split into complete lines,
 *  and dispatch each through the mapper. Tolerates the file not existing yet
 *  (the shell redirect creates it within a few ms of spawn). */
function flushCursorLog(state: CursorSessionState): void {
  let fd: number;
  try {
    const st = fsStatSync(state.logPath);
    if (st.size <= state.offset) return;
    fd = fsOpenSync(state.logPath, "r");
  } catch {
    return; // file not created yet, or transient stat error
  }
  try {
    const len = fsStatSync(state.logPath).size - state.offset;
    if (len <= 0) return;
    const buf = Buffer.allocUnsafe(len);
    const read = fsReadSync(fd, buf, 0, len, state.offset);
    state.offset += read;
    // Decode through the StringDecoder so a multi-byte char split across this
    // read boundary is held back (not turned into replacement chars).
    state.partial += state.decoder.write(buf.subarray(0, read));
  } finally {
    fsCloseSync(fd);
  }

  const lines = state.partial.split("\n");
  state.partial = lines.pop() ?? ""; // keep the trailing partial line
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: CursorEvent;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      // Not JSON — cursor-agent shouldn't emit this under
      // `--output-format stream-json`, but surface it rather than drop it
      // (could be a launch error from the shell wrapper, e.g. "command not
      // found").
      state.onChunk("stderr", trimmed, undefined);
      state.nextLineIndex++;
      continue;
    }
    dispatchCursorEvent(state, evt);
    state.nextLineIndex++;
  }
}

function dispatchCursorEvent(state: CursorSessionState, evt: CursorEvent): void {
  // Wrap onChunk to apply the seenLineUuids dedup (idempotent reattach replay).
  const onChunk: ChunkHandler = (stream, data, lineUuid) => {
    if (lineUuid) {
      if (state.seenLineUuids.has(lineUuid)) return;
      state.seenLineUuids.add(lineUuid);
    }
    state.onChunk(stream, data, lineUuid);
  };
  const result = mapCursorEvent(evt, onChunk, state.nextLineIndex, state.assistantTextEmitted);
  if (result.assistantTextEmitted) state.assistantTextEmitted = true;
  if (result.sessionId && !state.sessionIdSent) {
    state.sessionIdSent = true;
    state.onSessionId?.(result.sessionId);
  }
  if (typeof result.done === "number") {
    state.lastCode = result.done;
    resolveCursorDone(state, result.done);
  }
}

function resolveCursorDone(state: CursorSessionState, code: number): void {
  if (state.resolved) return;
  state.resolved = true;
  disposeCursorState(state);
  cursorSessions.delete(state.taskId);
  // The run is terminal now: its events are persisted in run_events (the
  // panel replays from the DB, not the log) and reattach only applies to
  // running turns, so the per-run log + prompt files are dead weight. Prune
  // them best-effort so dataDir/cursor-logs/ doesn't grow unbounded. Timers
  // are already cleared above, so nothing will try to read them after this.
  try { unlinkSync(cursorPromptPath(state.runId)); } catch { /* already gone */ }
  try { unlinkSync(cursorExitPath(state.runId)); } catch { /* already gone */ }
  try { unlinkSync(state.logPath); } catch { /* already gone */ }
  state.resolveDone(code);
}

/** Begin tailing the run's log + watching for session death. Shared by the
 *  spawn and reattach paths. Returns the `done` promise. */
function startCursorTailer(state: CursorSessionState): Promise<number> {
  const done = new Promise<number>((resolve) => {
    state.resolveDone = resolve;
  });
  cursorSessions.set(state.taskId, state);

  // Poll the log for appends. macOS FSEvents drops appends to a file written
  // by another process, so polling — not fs.watch — is the reliable backstop;
  // we add an fs.watch opportunistically once the file exists for low latency.
  state.pollTimer = setInterval(() => flushCursorLog(state), POLL_MS);
  const tryWatch = () => {
    if (state.watcher || !existsSync(state.logPath)) return;
    try {
      state.watcher = fsWatch(state.logPath, () => flushCursorLog(state));
    } catch { /* fall back to poll-only */ }
  };
  tryWatch();

  // Death watch: when the tmux session disappears the `cursor-agent`
  // process has exited. Flush whatever's left, then resolve. A `result`
  // event normally resolves us first (via the mapper); this catches a crash
  // OR the documented "stream ends without a result event on failure" case
  // (plan §2) — either way the one-shot session always counts as in-flight
  // for the death watch (mirrors codex). Only a definitive `gone` probe
  // (server up, this session absent) counts toward death — an
  // `unreachable` tmux hiccup on the shared socket resets the counter, and a
  // cursor log written a beat ago vetoes it — so a live one-shot run is
  // never wrongly torn down (see `sessionLiveness` in claude-tmux.ts).
  // Fork-free liveness — see `createDeathProbe`: a `kill(pid, 0)` on the
  // pane's process per tick; the `has-session` fork only confirms a dead pid
  // or re-validates periodically.
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
  // double-count a `wait` outcome. The decision logic itself is unchanged.
  let tickInFlight = false;
  state.deathTimer = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    void (async () => {
      try {
        tryWatch();
        // Compute the log-recency veto lazily — only a `gone` probe uses it.
        const liveness = await probe.probe();
        const outcome = deathTickOutcome({
          liveness,
          logFresh: liveness === "gone" && fileWrittenWithin(state.logPath, DEATH_JSONL_QUIET_MS),
          misses,
          threshold: DEATH_MISS_THRESHOLD,
        });
        if (outcome === "reset") { misses = 0; return; }
        if (outcome === "wait") { misses++; return; }
        // Session gone. Give the FS a beat to surface the final bytes, flush, then
        // decide clean-exit vs death before resolving.
        setTimeout(() => {
          flushCursorLog(state);
          // If the final flush surfaced a terminal event (`result`),
          // resolveCursorDone already fired — this was an orderly finish, not a
          // death, so don't emit the "session ended" sentinel.
          if (!state.resolved) {
            // Check the exit-code sidecar FIRST: its presence means the hosting
            // shell ran to completion and wrote `echo $?` before the tmux
            // session went away — a clean process exit, just one that happened
            // not to end in a `result` event (e.g. cursor-agent errored out
            // before printing one). That's an ordinary failed/succeeded run,
            // not a death, so it must NOT get the session-died sentinel (which
            // the orchestrator maps to `blocked`, not the normal
            // running->ready/review flow).
            const exitCode = readCursorExitCode(state.runId);
            if (exitCode !== null) {
              if (exitCode !== 0) {
                state.onChunk("stderr", `cursor-agent exited with code ${exitCode}`);
              }
              resolveCursorDone(state, exitCode);
              return;
            }
            // No exitfile: the session vanished before the shell could write
            // one — a genuine crash / external kill / tmux server death. Emit
            // the shared sentinel so the orchestrator flips the card to
            // `blocked` (via makeChunkHandler) and the user sees WHY the run
            // stopped in the stream, instead of a silent drop to `ready`.
            state.onChunk(
              "status",
              `${SESSION_DIED_STATUS_PREFIX}tmux session ${state.sessionName} ended unexpectedly — task blocked`,
            );
          }
          resolveCursorDone(state, state.lastCode ?? 1);
        }, DEATH_GRACE_MS);
        if (state.deathTimer) { clearInterval(state.deathTimer); state.deathTimer = null; }
      } finally {
        tickInFlight = false;
      }
    })();
  }, DEATH_POLL_MS);

  return done;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Spawn / reattach.
 * ────────────────────────────────────────────────────────────────────────── */

/** Single-quote a string for safe embedding in a POSIX shell command:
 *  close the quote, emit an escaped literal quote, reopen. Reused (rather
 *  than reimplemented) from codex-tmux's convention so both drivers quote
 *  identically. */
const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * Launch `tmux new-session` for cursor's detached hosting session. Async
 * (`Bun.spawn` + `await proc.exited`) so this fork+exec never blocks the
 * event loop that also serves the HTTP API — this used to be
 * `node:child_process`'s `spawnSync`, which stalled every concurrent request
 * for the duration of tmux's fork+exec (see
 * docs/plans/fix-task-details-load-delay.md). No timeout, mirroring
 * claude-tmux.ts's `tmux()` helper — an owner decision to keep behavior
 * unchanged beyond removing the block. Never throws; a spawn failure (e.g.
 * tmux not on PATH) folds into `stderr` the same way a non-zero exit does,
 * so callers only need one failure branch.
 */
async function spawnTmuxNewSession(
  tmux: string,
  args: string[],
): Promise<{ status: number | null; stderr: string }> {
  try {
    const proc = Bun.spawn([tmux, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const status = await proc.exited;
    return { status, stderr: stderr.trim() };
  } catch (e) {
    return { status: null, stderr: (e as Error).message };
  }
}

export interface CursorLaunchOptions {
  taskId: string;
  runId: string;
  /** cursor-agent argv from `buildCommand` — `[bin, "-p", "--output-format",
   *  "stream-json", …flags, ("--resume" sid)?]`. The prompt is NOT included
   *  here — it rides as a separate `promptText` field and is appended as the
   *  final positional argv element by `spawnCursorViaTmux` itself, via the
   *  quoting-safe `sh -c … "$@" "$(cat <promptfile>)"` pattern (never
   *  string-interpolated). */
  argv: string[];
  /** Env to forward into the cursor-agent process (HOME override + harness
   *  env). */
  env: Record<string, string>;
  cwd: string;
  /** The prompt text — written to a file and passed as a positional argv
   *  element (stdin support is unverified for cursor-agent, unlike codex). */
  promptText: string;
  onChunk: ChunkHandler;
  /** Fires once with cursor-agent's session_id (from the first event that
   *  carries one). */
  onSessionId?: (id: string) => void;
}

/**
 * Spawn one cursor-agent turn in a detached tmux session and start tailing
 * its `stream-json` log. Returns a `SpawnedAgent` whose `done` resolves when
 * the turn ends (0 on a successful `result`, 1 on `is_error`/failure/crash).
 *
 * Hosting command template (the injection-safe pattern mandated by plan
 * §3.7 / §4 T3 point 2): the prompt is written to a file we own, then read
 * back and substituted via `"$(cat <promptfile>)"` INSIDE the `sh -c` script
 * — never by interpolating the prompt text itself into the script string.
 * The cursor-agent argv elements are passed as `sh`'s positional parameters
 * (`"$@"`) so their content never goes through shell parsing either:
 *
 *   sh -c '"$@" "$(cat <promptfile>)" > <logfile> 2>&1; echo $? > <exitfile>' sh <argv...>
 *
 * No `exec`: dropping it is what lets the trailing `echo $? > <exitfile>`
 * run in the same shell AFTER cursor-agent exits, recording its exit code to
 * a sidecar file (Fix 2 / plan §5 TT2). The death-watch (`startCursorTailer`)
 * checks that sidecar before deciding a vanished tmux session is a genuine
 * death — its presence means the process ran to completion (even if it
 * didn't emit a `result` event), so the run settles as an ordinary
 * succeeded/failed run instead of tripping the `SESSION_DIED_STATUS_PREFIX`
 * sentinel. Removing `exec` does not change the prompt/argv quoting
 * properties below — `"$@"` and `"$(cat …)"` are unaffected either way.
 *
 * `$(cat file)` strips a trailing newline from the prompt — acceptable (see
 * plan). Every path substituted directly into the script string
 * (`<promptfile>`, `<logfile>`, `<exitfile>`) is single-quote-escaped via
 * `sq` the same way codex-tmux escapes its paths; those paths are
 * agetor-generated (derived from `runId`), never user text.
 */
export async function spawnCursorViaTmux(opts: CursorLaunchOptions): Promise<SpawnedAgent> {
  ensureLogDir();
  const logPath = cursorLogPath(opts.runId);
  const promptPath = cursorPromptPath(opts.runId);
  const exitPath = cursorExitPath(opts.runId);
  writeFileSync(promptPath, opts.promptText);
  // Truncate/create the log up front so the tailer's first stat succeeds and
  // offsets start at 0 cleanly even if a stale file from a reused id lingers.
  writeFileSync(logPath, "");
  // Clear any stale exit-code sidecar from a reused runId so a leftover file
  // can't be mistaken for this run's verdict before the shell writes its own.
  try { unlinkSync(exitPath); } catch { /* already gone */ }

  const sessionName = sessionNameFor(opts.taskId);
  // Defensive: a zombie session under this name would make new-session fail.
  await killSessionByName(sessionName);

  const tmux = resolveTmuxBin();
  // The prompt never enters shell text: `"$(cat <promptfile>)"` is expanded
  // by `sh`, not string-substituted by us, and every cursor-agent argv
  // element arrives via `"$@"` (positional params), bypassing shell parsing
  // entirely. A prompt containing single quotes, double quotes, `$()`,
  // backticks, or newlines is therefore delivered byte-for-byte (module the
  // trailing-newline strip `$(cat)` always performs). No `exec`: the shell
  // must stay alive after cursor-agent exits so it can record `$?` to the
  // exit-code sidecar (Fix 2) — see the hosting-command doc comment above.
  const inner = `"$@" "$(cat ${sq(promptPath)})" > ${sq(logPath)} 2>&1; echo $? > ${sq(exitPath)}`;
  const envArgs: string[] = [];
  // Forward PATH so cursor-agent's own tool invocations resolve dev binaries,
  // plus the harness env (HOME override) that controls cursor-agent's
  // login/history.
  if (process.env.PATH) { envArgs.push("-e", `PATH=${process.env.PATH}`); }
  for (const [k, v] of Object.entries(opts.env)) envArgs.push("-e", `${k}=${v}`);

  const args = [
    ...tmuxSocketArgs(),
    "new-session", "-d", "-s", sessionName,
    "-x", "200", "-y", "50",
    "-c", opts.cwd,
    ...envArgs,
    "--", "sh", "-c", inner, "sh", ...opts.argv,
  ];
  const res = await spawnTmuxNewSession(tmux, args);

  const state: CursorSessionState = {
    taskId: opts.taskId,
    runId: opts.runId,
    sessionName,
    logPath,
    offset: 0,
    decoder: new StringDecoder("utf8"),
    partial: "",
    nextLineIndex: 0,
    assistantTextEmitted: false,
    watcher: null,
    pollTimer: null,
    deathTimer: null,
    seenLineUuids: new Set(),
    onChunk: opts.onChunk,
    onSessionId: opts.onSessionId,
    sessionIdSent: false,
    resolved: false,
    lastCode: null,
    resolveDone: () => { /* replaced in startCursorTailer */ },
  };

  if (res.status !== 0) {
    // tmux failed to launch the session — surface stderr and resolve failed
    // synchronously so the run doesn't hang in `running`.
    const detail = (res.stderr || "tmux new-session failed").trim();
    opts.onChunk("stderr", `failed to start cursor session: ${detail}`, undefined);
    const done = Promise.resolve(1);
    return { kill: () => { /* nothing to kill */ }, writeInput: () => false, done };
  }

  const done = startCursorTailer(state);
  return {
    kill: () => killCursorState(state),
    // cursor-agent -p doesn't accept conversational input mid-turn;
    // follow-ups are delivered as fresh `--resume` turns (new run rows) by
    // the orchestrator.
    writeInput: () => false,
    done,
  };
}

/**
 * Interrupt a cursor turn: kill its tmux session and resolve `done` promptly.
 * We don't wait for the death-poll because we know the session is gone — a
 * brief grace lets the final appended bytes flush first. The orchestrator
 * decides cancelled-vs-failed from its own `handle.cancelled` flag, so the
 * resolution code here is immaterial to the recorded status.
 */
function killCursorState(state: CursorSessionState): void {
  // `kill` is a synchronous `SpawnedAgent` field (shared contract in
  // claude-tmux.ts), so the now-async tmux kill is fired-and-forgotten here
  // rather than awaited — never left unhandled: a rejection still falls
  // through to schedule the flush + resolve so the run can't hang.
  void (async () => {
    try {
      await killSessionByName(state.sessionName);
    } catch {
      // best-effort — killSessionByName is expected to never throw (its
      // underlying tmux() swallows spawn errors into an ok:false result),
      // but this path must never leave the run stuck in `running` even if
      // that changes.
    }
    setTimeout(() => {
      flushCursorLog(state);
      resolveCursorDone(state, state.lastCode ?? 1);
    }, DEATH_GRACE_MS);
  })();
}

export interface CursorReattachOptions {
  taskId: string;
  runId: string;
  sessionName: string;
  onChunk: ChunkHandler;
  /** Dedup keys already persisted for this task's runs, so re-reading the log
   *  from offset 0 doesn't double-emit events streamed before the restart. */
  seenLineUuids: Set<string>;
}

/**
 * Reattach to a cursor turn whose tmux session survived an agetor restart.
 * Re-tails the run's log from offset 0 (deduping via `seenLineUuids`) and
 * resolves `done` when the turn finishes. Returns null when the session is
 * no longer alive (caller should orphan the run).
 */
export async function reattachCursorSession(opts: CursorReattachOptions): Promise<SpawnedAgent | null> {
  if (!(await sessionExistsByName(opts.sessionName))) return null;
  const state: CursorSessionState = {
    taskId: opts.taskId,
    runId: opts.runId,
    sessionName: opts.sessionName,
    logPath: cursorLogPath(opts.runId),
    offset: 0,
    decoder: new StringDecoder("utf8"),
    partial: "",
    nextLineIndex: 0,
    assistantTextEmitted: false, // recomputed correctly as the replay from offset 0 re-walks the log in order
    watcher: null,
    pollTimer: null,
    deathTimer: null,
    seenLineUuids: opts.seenLineUuids,
    onChunk: opts.onChunk,
    onSessionId: undefined,
    sessionIdSent: true, // session id already persisted on the original run
    resolved: false,
    lastCode: null,
    resolveDone: () => { /* replaced in startCursorTailer */ },
  };
  const done = startCursorTailer(state);
  return {
    kill: () => killCursorState(state),
    writeInput: () => false,
    done,
  };
}

/** True when a live cursor tail is registered for this task. */
export function cursorSessionActive(taskId: string): boolean {
  return cursorSessions.has(taskId);
}

/**
 * Tear down a task's cursor session: kill the tmux session and dispose the
 * in-memory tailer. Best-effort and non-throwing — called from deleteTask /
 * archiveTask and on a cross-kind agent switch. Safe to call when no cursor
 * session exists (kills any stray session under the task's name too).
 */
export async function dropCursorSession(taskId: string): Promise<void> {
  const state = cursorSessions.get(taskId);
  if (state) {
    disposeCursorState(state);
    cursorSessions.delete(taskId);
  }
  await killSessionByName(sessionNameFor(taskId));
}
