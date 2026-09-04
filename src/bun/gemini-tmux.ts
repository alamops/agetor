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
} from "node:fs";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { dataDir } from "./db.ts";
import { resolveTmuxBin, tmuxSocketArgs, spawnTmuxNewSession } from "./tmux-resolution.ts";
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
 * Driver that hosts a single `gemini` turn inside a per-task tmux session and
 * exposes structured streaming by tailing the newline-delimited JSON event
 * log gemini writes (via `--output-format stream-json`).
 *
 * Architecturally this is a near-clone of codex-tmux.ts: gemini's CLI is
 * one-shot per turn (`gemini -p ... --session-id|--resume ...` exits at end
 * of turn — there is no persistent REPL the way claude has), so the same
 * "host it in a *detached* tmux session so a mid-turn run survives an agetor
 * restart, reattach only while a turn is in flight" design applies.
 *
 * Two real differences from codex, both load-bearing:
 *
 *  1. Session id is self-issued, not discovered. Codex has to wait for its
 *     `thread.started` event to learn the thread id it must resume with
 *     next turn. Gemini's `--session-id <uuid>` lets agetor mint the uuid
 *     up front (mirrors claude's pattern — see `spawnAgent`'s gemini branch
 *     in agents.ts), so this driver never needs an `onSessionId` callback at
 *     all; verified empirically that `--resume <uuid>` on a later turn
 *     correctly recalls context established under `--session-id <uuid>` on
 *     an earlier one.
 *
 *  2. Prompt rides in argv, not stdin. Codex's argv ends in a bare `-`
 *     (its stdin sentinel) and the shell wrapper pipes the prompt in via a
 *     file redirect, so the prompt text never touches the tmux client
 *     command string. Gemini's `-p <prompt>` value IS an argv token (see
 *     `GEMINI_PROMPT_ARGV_MAX_BYTES` in agents.ts for the resulting size
 *     cap) — so unlike codex, there's no prompt file to write here at all;
 *     the shell wrapper below has no stdin redirect.
 *
 * Capture mechanism, same as codex: wrap the gemini argv in
 * `sh -c 'exec <argv> > <log-file> 2>&1'`. gemini's `stream-json` stdout is
 * redirected straight to a file we own, so the tail is a clean, re-readable
 * NDJSON stream (no pane decoration, no race). Validated against gemini-cli
 * 0.54.0 — confirmed the stream-json output is flushed incrementally (not
 * buffered to process exit), so live tailing observes events as they happen.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * Paths (derivable from runId alone, so reattach can recompute them).
 * ────────────────────────────────────────────────────────────────────────── */

const GEMINI_LOG_DIR = path.join(dataDir, "gemini-logs");

export function geminiLogPath(runId: string): string {
  return path.join(GEMINI_LOG_DIR, `${runId}.jsonl`);
}
function ensureLogDir(): void {
  if (!existsSync(GEMINI_LOG_DIR)) mkdirSync(GEMINI_LOG_DIR, { recursive: true });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Event mapping (gemini `stream-json` event → agetor RunEvent chunks).
 *
 * Event shapes below are the VERIFIED real output of `gemini --output-format
 * stream-json` (CLI 0.54.0), captured against the live API — not inferred
 * from docs. See gemini-tmux.test.ts for fixtures taken directly from that
 * spike.
 * ────────────────────────────────────────────────────────────────────────── */

interface GeminiEvent {
  type?: string;
  timestamp?: string;
  session_id?: string;
  model?: string;
  role?: "user" | "assistant" | string;
  content?: string;
  delta?: boolean;
  tool_name?: string;
  tool_id?: string;
  parameters?: unknown;
  status?: string;
  stats?: { tool_calls?: number; [k: string]: unknown };
  error?: { message?: string } | string;
  [k: string]: unknown;
}

/** Result of mapping one event line. `done` is set when the event terminates
 *  the turn — gemini's `result` event is the ONLY terminal event (no
 *  separate completed/failed event types the way codex has); `status`
 *  distinguishes success from failure. */
export interface GeminiMapResult {
  done?: number;
}

function errMessage(e: GeminiEvent["error"], fallback: string): string {
  if (!e) return fallback;
  if (typeof e === "string") return e;
  return e.message ?? fallback;
}

/**
 * Map a single parsed gemini `stream-json` event to zero or more chunks.
 * `seq` is a per-run monotonic counter (a `{ n }` box) used to build a
 * stable, unique `line_uuid` for events that carry no natural id (`result`,
 * top-level `error`). Deterministic across a reattach replay because it
 * counts file position, not wall-clock.
 *
 * line_uuid scheme: `${type}:${tool_id}` for tool events (distinct suffixes
 * for tool_use vs tool_result even though both key off the same `tool_id`,
 * mirroring codex's item.started/item.completed collision-avoidance);
 * `message:${seq.n++}` for streamed assistant text (gemini emits multiple
 * `delta:true` message chunks per turn, each needing its own key); `${type}:
 * ${seq.n++}` for id-less events (`result`, `error`).
 */
export function mapGeminiEvent(
  evt: GeminiEvent,
  onChunk: ChunkHandler,
  seq: { n: number },
): GeminiMapResult {
  const type = evt.type ?? "";
  switch (type) {
    case "init":
      // Session metadata banner — silent. Unlike codex's `thread.started`,
      // this carries no NEW information: agetor already knows the session
      // id (it self-issued it), so there's nothing to capture here.
      return {};

    case "message": {
      // The user's own outbound message is echoed back verbatim as a
      // role:"user" event — silent, since the orchestrator already records
      // the user's message as its own event before spawning; re-emitting it
      // here would duplicate it in the stream.
      if (evt.role !== "assistant") return {};
      if (evt.content) onChunk("assistant", evt.content, `message:${seq.n++}`);
      return {};
    }

    case "tool_use": {
      const id = typeof evt.tool_id === "string" ? evt.tool_id : `seq${seq.n++}`;
      onChunk("tool_use", JSON.stringify({
        id,
        name: evt.tool_name ?? "tool",
        input: evt.parameters ?? {},
        serverSide: false,
      }), `tool_use:${id}`);
      return {};
    }

    case "tool_result": {
      const id = typeof evt.tool_id === "string" ? evt.tool_id : `seq${seq.n++}`;
      const isError = evt.status !== "success";
      onChunk("tool_result", JSON.stringify({
        toolUseId: id,
        content: evt.output ?? evt.result ?? "",
        isError,
      }), `tool_result:${id}`);
      return {};
    }

    case "result": {
      const ok = evt.status === "success";
      if (!ok) {
        onChunk("stderr", errMessage(evt.error, `gemini turn failed (status: ${evt.status ?? "unknown"})`), `result:${seq.n++}`);
      }
      return { done: ok ? 0 : 1 };
    }

    case "error":
      // Top-level transport/model error (no item). A `result` with a
      // non-success status usually follows and carries the terminal `done`;
      // surface the message here regardless (forward-compat with a bare
      // top-level error that isn't followed by `result`).
      onChunk("stderr", errMessage(evt.error, "gemini error"), `error:${seq.n++}`);
      return {};

    default:
      // Unknown event types: silent forward-compat.
      return {};
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Session state + tailer.
 * ────────────────────────────────────────────────────────────────────────── */

interface GeminiSessionState {
  taskId: string;
  runId: string;
  sessionName: string;
  logPath: string;
  offset: number;
  /** Holds incomplete trailing UTF-8 byte sequences across reads so a
   *  multi-byte character split on a poll boundary isn't corrupted. */
  decoder: StringDecoder;
  partial: string;
  watcher: FSWatcher | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  deathTimer: ReturnType<typeof setInterval> | null;
  seenLineUuids: Set<string>;
  seq: { n: number };
  onChunk: ChunkHandler;
  resolved: boolean;
  lastCode: number | null;
  resolveDone: (code: number) => void;
}

const geminiSessions = new Map<string, GeminiSessionState>(); // taskId -> state

const POLL_MS = 150;
const DEATH_POLL_MS = 400;
/** Grace after the tmux session disappears before we resolve, so the final
 *  appended bytes (the `result` event) are flushed and read. Poll + grace
 *  stay driver-local (gemini is one-shot, like codex); the death-decision
 *  inputs `DEATH_MISS_THRESHOLD` + `DEATH_JSONL_QUIET_MS` are imported from
 *  claude-tmux so all three watches share one `deathTickOutcome` contract
 *  and can't drift. */
const DEATH_GRACE_MS = 250;

function disposeGeminiState(state: GeminiSessionState): void {
  if (state.watcher) { try { state.watcher.close(); } catch { /* noop */ } state.watcher = null; }
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  if (state.deathTimer) { clearInterval(state.deathTimer); state.deathTimer = null; }
}

/** Read any bytes appended since `state.offset`, split into complete lines,
 *  and dispatch each through the mapper. Tolerates the file not existing yet
 *  (the shell redirect creates it within a few ms of spawn). */
function flushGeminiLog(state: GeminiSessionState): void {
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
    let evt: GeminiEvent;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      // Not JSON — gemini emits plenty of human-readable stderr text
      // (YOLO-mode banners, ripgrep-fallback notices, trust warnings, retry
      // backoff logs) onto the SAME stream we redirect into this file.
      // Surface it as a raw stderr chunk rather than drop it — verified in
      // the spike this is common, not exceptional, output.
      state.onChunk("stderr", trimmed, undefined);
      continue;
    }
    dispatchGeminiEvent(state, evt);
  }
}

function dispatchGeminiEvent(state: GeminiSessionState, evt: GeminiEvent): void {
  // Wrap onChunk to apply the seenLineUuids dedup (idempotent reattach replay).
  const onChunk: ChunkHandler = (stream, data, lineUuid) => {
    if (lineUuid) {
      if (state.seenLineUuids.has(lineUuid)) return;
      state.seenLineUuids.add(lineUuid);
    }
    state.onChunk(stream, data, lineUuid);
  };
  const result = mapGeminiEvent(evt, onChunk, state.seq);
  if (typeof result.done === "number") {
    state.lastCode = result.done;
    resolveGeminiDone(state, result.done);
  }
}

function resolveGeminiDone(state: GeminiSessionState, code: number): void {
  if (state.resolved) return;
  state.resolved = true;
  disposeGeminiState(state);
  geminiSessions.delete(state.taskId);
  // The run is terminal now: its events are persisted in run_events (the panel
  // replays from the DB, not the log) and reattach only applies to running
  // turns, so the per-run log file is dead weight. Prune it best-effort so
  // dataDir/gemini-logs/ doesn't grow unbounded. Timers are already cleared
  // above, so nothing will try to read it after this.
  try { unlinkSync(state.logPath); } catch { /* already gone */ }
  state.resolveDone(code);
}

/** Begin tailing the run's log + watching for session death. Shared by the
 *  spawn and reattach paths. Returns the `done` promise. */
function startGeminiTailer(state: GeminiSessionState): Promise<number> {
  const done = new Promise<number>((resolve) => {
    state.resolveDone = resolve;
  });
  geminiSessions.set(state.taskId, state);

  // Poll the log for appends. macOS FSEvents drops appends to a file written
  // by another process, so polling — not fs.watch — is the reliable backstop;
  // we add an fs.watch opportunistically once the file exists for low latency.
  state.pollTimer = setInterval(() => flushGeminiLog(state), POLL_MS);
  const tryWatch = () => {
    if (state.watcher || !existsSync(state.logPath)) return;
    try {
      state.watcher = fsWatch(state.logPath, () => flushGeminiLog(state));
    } catch { /* fall back to poll-only */ }
  };
  tryWatch();

  // Death watch: when the tmux session disappears, the gemini process has
  // exited. Flush whatever's left, then resolve. A `result` event normally
  // resolves us first (via the mapper); this catches an early failure that
  // exits before ever emitting JSON at all — verified in the spike this
  // happens for real (the untrusted-directory rejection, exit 55, produced
  // zero stdout JSON lines, only stderr text). Only a definitive `gone` probe
  // (server up, this session absent) counts toward death — an `unreachable`
  // tmux hiccup on the shared socket resets the counter, and a gemini log
  // written a beat ago vetoes it — so a live one-shot run is never wrongly
  // torn down (mirrors codex-tmux's death watch; see `sessionLiveness`).
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
        // resolve with whatever terminal code we saw (default: failed — a gemini
        // process that vanished without a `result` event did not succeed).
        setTimeout(() => {
          flushGeminiLog(state);
          // If the final flush surfaced a terminal `result` event,
          // resolveGeminiDone already fired — this was an orderly finish, not a
          // death, so don't emit the "session ended" sentinel.
          if (!state.resolved) {
            // Emit the shared sentinel so the orchestrator flips the card to
            // `blocked` (via makeChunkHandler) and the user sees WHY the run
            // stopped in the stream, instead of a silent drop to `ready`.
            state.onChunk(
              "status",
              `${SESSION_DIED_STATUS_PREFIX}tmux session ${state.sessionName} ended unexpectedly — task blocked`,
            );
          }
          resolveGeminiDone(state, state.lastCode ?? 1);
        }, DEATH_GRACE_MS);
        if (state.deathTimer) { clearInterval(state.deathTimer); state.deathTimer = null; }
      } catch {
        /* never crash the watch */
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

const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

// `spawnTmuxNewSession` (launches gemini's detached hosting session) lives in
// tmux-resolution.ts — shared verbatim with codex-tmux.ts/cursor-tmux.ts.

export interface GeminiLaunchOptions {
  taskId: string;
  runId: string;
  /** gemini argv from `buildCommand` — `[bin, "-m", …flags, "-p", prompt]`.
   *  The prompt rides in argv (not stdin) — see agents.ts for why. */
  argv: string[];
  /** Env to forward into the gemini process (GEMINI_CLI_HOME + harness env). */
  env: Record<string, string>;
  cwd: string;
  onChunk: ChunkHandler;
}

/**
 * Spawn one gemini turn in a detached tmux session and start tailing its
 * `stream-json` log. Returns a `SpawnedAgent` whose `done` resolves when the
 * turn ends (0 on a `result` event with `status: "success"`, 1 otherwise).
 */
export async function spawnGeminiViaTmux(opts: GeminiLaunchOptions): Promise<SpawnedAgent> {
  ensureLogDir();
  const logPath = geminiLogPath(opts.runId);
  // Truncate/create the log up front so the tailer's first stat succeeds and
  // offsets start at 0 cleanly even if a stale file from a reused id lingers.
  writeFileSync(logPath, "");

  const sessionName = sessionNameFor(opts.taskId);
  // Defensive: a zombie session under this name would make new-session fail.
  await killSessionByName(sessionName);

  const tmux = resolveTmuxBin();
  // No stdin redirect — unlike codex, gemini's prompt is already an argv
  // token (`-p <prompt>`) baked into `opts.argv` by buildCommand.
  const inner = `exec ${opts.argv.map(sq).join(" ")} > ${sq(logPath)} 2>&1`;
  const envArgs: string[] = [];
  // Forward PATH so gemini's own shell-tool invocations resolve dev binaries,
  // plus the harness env (GEMINI_CLI_HOME) that controls gemini's login/history.
  if (process.env.PATH) { envArgs.push("-e", `PATH=${process.env.PATH}`); }
  for (const [k, v] of Object.entries(opts.env)) envArgs.push("-e", `${k}=${v}`);

  const args = [
    ...tmuxSocketArgs(),
    "new-session", "-d", "-s", sessionName,
    "-x", "200", "-y", "50",
    "-c", opts.cwd,
    ...envArgs,
    "--", "sh", "-c", inner,
  ];
  const res = await spawnTmuxNewSession(tmux, args);

  const state: GeminiSessionState = {
    taskId: opts.taskId,
    runId: opts.runId,
    sessionName,
    logPath,
    offset: 0,
    decoder: new StringDecoder("utf8"),
    partial: "",
    watcher: null,
    pollTimer: null,
    deathTimer: null,
    seenLineUuids: new Set(),
    seq: { n: 0 },
    onChunk: opts.onChunk,
    resolved: false,
    lastCode: null,
    resolveDone: () => { /* replaced in startGeminiTailer */ },
  };

  if (res.status !== 0) {
    // tmux failed to launch the session — surface stderr and resolve failed
    // synchronously so the run doesn't hang in `running`.
    const detail = (res.stderr || "tmux new-session failed").trim();
    opts.onChunk("stderr", `failed to start gemini session: ${detail}`, undefined);
    const done = Promise.resolve(1);
    return { kill: () => { /* nothing to kill */ }, writeInput: () => false, done };
  }

  const done = startGeminiTailer(state);
  return {
    kill: () => killGeminiState(state),
    // gemini doesn't accept conversational input mid-turn; follow-ups are
    // delivered as fresh `--resume` turns (new run rows) by the orchestrator.
    writeInput: () => false,
    done,
  };
}

/**
 * Interrupt a gemini turn: kill its tmux session and resolve `done` promptly.
 * We don't wait for the death-poll because we know the session is gone — a
 * brief grace lets the final appended bytes flush first. The orchestrator
 * decides cancelled-vs-failed from its own `handle.cancelled` flag, so the
 * resolution code here is immaterial to the recorded status.
 */
function killGeminiState(state: GeminiSessionState): void {
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
      flushGeminiLog(state);
      resolveGeminiDone(state, state.lastCode ?? 1);
    }, DEATH_GRACE_MS);
  })();
}

export interface GeminiReattachOptions {
  taskId: string;
  runId: string;
  sessionName: string;
  onChunk: ChunkHandler;
  /** Dedup keys already persisted for this task's runs, so re-reading the log
   *  from offset 0 doesn't double-emit events streamed before the restart. */
  seenLineUuids: Set<string>;
}

/**
 * Reattach to a gemini turn whose tmux session survived an agetor restart.
 * Re-tails the run's log from offset 0 (deduping via `seenLineUuids`) and
 * resolves `done` when the turn finishes. Returns null when the session is no
 * longer alive (caller should orphan the run).
 */
export async function reattachGeminiSession(opts: GeminiReattachOptions): Promise<SpawnedAgent | null> {
  if (!(await sessionExistsByName(opts.sessionName))) return null;
  const state: GeminiSessionState = {
    taskId: opts.taskId,
    runId: opts.runId,
    sessionName: opts.sessionName,
    logPath: geminiLogPath(opts.runId),
    offset: 0,
    decoder: new StringDecoder("utf8"),
    partial: "",
    watcher: null,
    pollTimer: null,
    deathTimer: null,
    seenLineUuids: opts.seenLineUuids,
    seq: { n: 0 },
    onChunk: opts.onChunk,
    resolved: false,
    lastCode: null,
    resolveDone: () => { /* replaced in startGeminiTailer */ },
  };
  const done = startGeminiTailer(state);
  return {
    kill: () => killGeminiState(state),
    writeInput: () => false,
    done,
  };
}

/** True when a live gemini tail is registered for this task. */
export function geminiSessionActive(taskId: string): boolean {
  return geminiSessions.has(taskId);
}

/**
 * Tear down a task's gemini session: kill the tmux session and dispose the
 * in-memory tailer. Best-effort and non-throwing — called from deleteTask /
 * archiveTask and on a cross-kind agent switch. Safe to call when no gemini
 * session exists (kills any stray session under the task's name too).
 */
export async function dropGeminiSession(taskId: string): Promise<void> {
  const state = geminiSessions.get(taskId);
  if (state) {
    disposeGeminiState(state);
    geminiSessions.delete(taskId);
  }
  await killSessionByName(sessionNameFor(taskId));
}
