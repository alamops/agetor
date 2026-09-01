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
 * Driver that hosts a single `codex exec` turn inside a per-task tmux session
 * and exposes structured streaming by tailing the newline-delimited JSON event
 * log codex writes (via `--json`).
 *
 * Why tmux at all when codex is one-shot? Restart survival. `codex exec` is a
 * child process; run it as a direct child of the agetor (Bun) process and it
 * dies when agetor quits. Hosting it in a *detached* tmux session lets a
 * mid-turn run survive an agetor restart and be reattached on boot — the same
 * property claude-code gets from its detached REPL.
 *
 * Crucial difference from claude: codex's tmux session lives only for the
 * duration of one turn (`codex exec` exits → the session ends). There is no
 * persistent REPL between turns. Multi-turn continuity is carried by codex's
 * own `thread_id` (captured from the `thread.started` event) and replayed via
 * `codex exec resume <thread_id>` on the next turn — each follow-up is a fresh
 * session + a fresh run row. So reattach only applies WHILE a turn is in
 * flight; between turns there is nothing to reattach (and nothing running).
 *
 * Capture mechanism: rather than scrape the tmux pane, we wrap the codex argv
 * in `sh -c 'exec <argv> < <prompt-file> > <log-file> 2>&1'`. codex's `--json`
 * stdout is redirected straight to a file we own, so the tail is a clean,
 * re-readable NDJSON stream (no pane decoration, no race), and the prompt is
 * delivered via stdin (the trailing `-` in the argv) so no user text ever
 * lands in the shell string. Validated against codex-cli 0.140.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * Paths (derivable from runId alone, so reattach can recompute them).
 * ────────────────────────────────────────────────────────────────────────── */

const CODEX_LOG_DIR = path.join(dataDir, "codex-logs");

export function codexLogPath(runId: string): string {
  return path.join(CODEX_LOG_DIR, `${runId}.jsonl`);
}
function codexPromptPath(runId: string): string {
  return path.join(CODEX_LOG_DIR, `${runId}.prompt.txt`);
}
function ensureLogDir(): void {
  if (!existsSync(CODEX_LOG_DIR)) mkdirSync(CODEX_LOG_DIR, { recursive: true });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Event mapping (codex `--json` event → agetor RunEvent chunks).
 * ────────────────────────────────────────────────────────────────────────── */

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  message?: string;
  [k: string]: unknown;
}
interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  message?: string;
  error?: { message?: string } | string;
  [k: string]: unknown;
}

/** Result of mapping one event line. `done` is set when the event terminates
 *  the turn (`turn.completed` → 0, `turn.failed`/`error` → 1). `threadId` is
 *  set on `thread.started`. */
export interface CodexMapResult {
  done?: number;
  threadId?: string;
}

function errMessage(e: CodexEvent["error"]): string {
  if (!e) return "codex turn failed";
  if (typeof e === "string") return e;
  return e.message ?? "codex turn failed";
}

/**
 * Map a single parsed codex `--json` event to zero or more chunks. `seq` is a
 * per-run monotonic counter (a `{ n }` box) used to build a stable, unique
 * `line_uuid` for events that carry no item id (`turn.*`, top-level `error`).
 * Deterministic across a reattach replay because it counts file position, not
 * wall-clock.
 *
 * line_uuid scheme: `${event.type}:${item.id}` for item events — the
 * `event.type` prefix keeps `item.started` and `item.completed` (which share
 * the same `item.id`) from colliding under the `(run_id, line_uuid)` unique
 * index. command_execution emits two chunks (tool_use + tool_result) from one
 * event, so each gets a distinct suffix.
 */
export function mapCodexEvent(
  evt: CodexEvent,
  onChunk: ChunkHandler,
  seq: { n: number },
): CodexMapResult {
  const type = evt.type ?? "";
  switch (type) {
    case "thread.started":
      return { threadId: typeof evt.thread_id === "string" ? evt.thread_id : undefined };

    case "turn.started":
      // Silent — the per-item events carry the substance; a "turn started"
      // banner would just be noise above the first assistant/tool chunk.
      return {};

    case "turn.completed":
      return { done: 0 };

    case "turn.failed":
      onChunk("stderr", errMessage(evt.error), `turn.failed:${seq.n++}`);
      return { done: 1 };

    case "error":
      // Top-level transport/model error (no item). A `turn.failed` usually
      // follows and carries the terminal `done`; surface the message here.
      onChunk("stderr", errMessage(evt.error ?? evt.message), `error:${seq.n++}`);
      return {};

    case "item.started":
      // Wait for `item.completed` to emit — codex restates the item with its
      // final text there, so emitting on started would double-render.
      return {};

    case "item.completed": {
      const item = evt.item ?? {};
      const id = typeof item.id === "string" ? item.id : `seq${seq.n++}`;
      const key = `item.completed:${id}`;
      const itype = item.type ?? "";
      switch (itype) {
        case "agent_message":
          if (item.text) onChunk("assistant", item.text, key);
          break;
        case "reasoning": {
          const text = item.text ?? (typeof item.summary === "string" ? item.summary : "");
          if (text) onChunk("thinking", text, key);
          break;
        }
        case "error":
          onChunk("stderr", item.message ?? item.text ?? "codex error", key);
          break;
        case "command_execution": {
          // Render as a tool_use (the command) + tool_result (its output), the
          // same shape claude's shell tool uses so RunPanel reuses its renderer.
          const command = (item.command ?? item.text ?? "") as unknown;
          onChunk("tool_use", JSON.stringify({
            id,
            name: "shell",
            input: { command },
            serverSide: false,
          }), `${key}:use`);
          const out = (item.aggregated_output ?? item.output ?? "") as unknown;
          const exit = item.exit_code;
          if (out || typeof exit === "number") {
            onChunk("tool_result", JSON.stringify({
              toolUseId: id,
              content: out,
              isError: typeof exit === "number" && exit !== 0,
            }), `${key}:result`);
          }
          break;
        }
        default: {
          // Forward-compat for item kinds we haven't special-cased
          // (file_change, mcp_tool_call, web_search, todo_list, …). Render as
          // a generic tool_use carrying the whole item so nothing goes dark,
          // and the existing tool renderer shows the details.
          if (item.text) {
            onChunk("assistant", item.text, key);
          } else {
            const { id: _id, type: _t, ...rest } = item;
            onChunk("tool_use", JSON.stringify({
              id,
              name: itype || "codex-item",
              input: rest,
              serverSide: false,
            }), key);
          }
          break;
        }
      }
      return {};
    }

    default:
      // Unknown top-level event types: silent forward-compat.
      return {};
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Session state + tailer.
 * ────────────────────────────────────────────────────────────────────────── */

interface CodexSessionState {
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
  onSessionId?: (id: string) => void;
  sessionIdSent: boolean;
  resolved: boolean;
  lastCode: number | null;
  resolveDone: (code: number) => void;
}

const codexSessions = new Map<string, CodexSessionState>(); // taskId -> state

const POLL_MS = 150;
const DEATH_POLL_MS = 400;
/** Grace after the tmux session disappears before we resolve, so the final
 *  appended bytes (turn.completed) are flushed and read. Poll + grace stay
 *  driver-local (codex is one-shot); the death-decision inputs
 *  `DEATH_MISS_THRESHOLD` + `DEATH_JSONL_QUIET_MS` are imported from claude-tmux
 *  so both watches share one `deathTickOutcome` contract and can't drift. */
const DEATH_GRACE_MS = 250;

function disposeCodexState(state: CodexSessionState): void {
  if (state.watcher) { try { state.watcher.close(); } catch { /* noop */ } state.watcher = null; }
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  if (state.deathTimer) { clearInterval(state.deathTimer); state.deathTimer = null; }
}

/** Read any bytes appended since `state.offset`, split into complete lines,
 *  and dispatch each through the mapper. Tolerates the file not existing yet
 *  (the shell redirect creates it within a few ms of spawn). */
function flushCodexLog(state: CodexSessionState): void {
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
    let evt: CodexEvent;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      // Not JSON — codex shouldn't emit this under `--json --color never`, but
      // surface it rather than drop it (could be a launch error from the shell
      // wrapper, e.g. "command not found").
      state.onChunk("stderr", trimmed, undefined);
      continue;
    }
    dispatchCodexEvent(state, evt);
  }
}

function dispatchCodexEvent(state: CodexSessionState, evt: CodexEvent): void {
  // Wrap onChunk to apply the seenLineUuids dedup (idempotent reattach replay).
  const onChunk: ChunkHandler = (stream, data, lineUuid) => {
    if (lineUuid) {
      if (state.seenLineUuids.has(lineUuid)) return;
      state.seenLineUuids.add(lineUuid);
    }
    state.onChunk(stream, data, lineUuid);
  };
  const result = mapCodexEvent(evt, onChunk, state.seq);
  if (result.threadId && !state.sessionIdSent) {
    state.sessionIdSent = true;
    state.onSessionId?.(result.threadId);
  }
  if (typeof result.done === "number") {
    state.lastCode = result.done;
    resolveCodexDone(state, result.done);
  }
}

function resolveCodexDone(state: CodexSessionState, code: number): void {
  if (state.resolved) return;
  state.resolved = true;
  disposeCodexState(state);
  codexSessions.delete(state.taskId);
  // The run is terminal now: its events are persisted in run_events (the panel
  // replays from the DB, not the log) and reattach only applies to running
  // turns, so the per-run log + prompt files are dead weight. Prune them
  // best-effort so dataDir/codex-logs/ doesn't grow unbounded. Timers are
  // already cleared above, so nothing will try to read them after this.
  try { unlinkSync(codexPromptPath(state.runId)); } catch { /* already gone */ }
  try { unlinkSync(state.logPath); } catch { /* already gone */ }
  state.resolveDone(code);
}

/** Begin tailing the run's log + watching for session death. Shared by the
 *  spawn and reattach paths. Returns the `done` promise. */
function startCodexTailer(state: CodexSessionState): Promise<number> {
  const done = new Promise<number>((resolve) => {
    state.resolveDone = resolve;
  });
  codexSessions.set(state.taskId, state);

  // Poll the log for appends. macOS FSEvents drops appends to a file written
  // by another process, so polling — not fs.watch — is the reliable backstop;
  // we add an fs.watch opportunistically once the file exists for low latency.
  state.pollTimer = setInterval(() => flushCodexLog(state), POLL_MS);
  const tryWatch = () => {
    if (state.watcher || !existsSync(state.logPath)) return;
    try {
      state.watcher = fsWatch(state.logPath, () => flushCodexLog(state));
    } catch { /* fall back to poll-only */ }
  };
  tryWatch();

  // Death watch: when the tmux session disappears the `codex exec` process has
  // exited. Flush whatever's left, then resolve. turn.completed/turn.failed
  // normally resolve us first (via the mapper); this catches a crash that
  // exits without a terminal event. Only a definitive `gone` probe (server up,
  // this session absent) counts toward death — an `unreachable` tmux hiccup on
  // the shared socket resets the counter, and a codex log written a beat ago
  // vetoes it — so a live one-shot run is never wrongly torn down (mirrors
  // claude-tmux's death watch; see `sessionLiveness`).
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
        // resolve with whatever terminal code we saw (default: failed — a codex
        // exec that vanished without `turn.completed` did not succeed).
        setTimeout(() => {
          flushCodexLog(state);
          // If the final flush surfaced a terminal event (turn.completed/failed),
          // resolveCodexDone already fired — this was an orderly finish, not a
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
          resolveCodexDone(state, state.lastCode ?? 1);
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

const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * Launch `tmux new-session` for codex's detached hosting session. Async
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

export interface CodexLaunchOptions {
  taskId: string;
  runId: string;
  /** codex argv from `buildCommand` — `[bin, "exec", …flags, ("resume" sid)?, "-"]`.
   *  The trailing `-` makes codex read the prompt from stdin. */
  argv: string[];
  /** Env to forward into the codex process (CODEX_HOME/HOME + harness env). */
  env: Record<string, string>;
  cwd: string;
  /** The prompt text — written to a file and piped to codex's stdin. */
  promptText: string;
  onChunk: ChunkHandler;
  /** Fires once with codex's thread_id (from `thread.started`). */
  onSessionId?: (id: string) => void;
}

/**
 * Spawn one codex turn in a detached tmux session and start tailing its
 * `--json` log. Returns a `SpawnedAgent` whose `done` resolves when the turn
 * ends (0 on `turn.completed`, 1 on failure/crash).
 */
export async function spawnCodexViaTmux(opts: CodexLaunchOptions): Promise<SpawnedAgent> {
  ensureLogDir();
  const logPath = codexLogPath(opts.runId);
  const promptPath = codexPromptPath(opts.runId);
  writeFileSync(promptPath, opts.promptText);
  // Truncate/create the log up front so the tailer's first stat succeeds and
  // offsets start at 0 cleanly even if a stale file from a reused id lingers.
  writeFileSync(logPath, "");

  const sessionName = sessionNameFor(opts.taskId);
  // Defensive: a zombie session under this name would make new-session fail.
  await killSessionByName(sessionName);

  const tmux = resolveTmuxBin();
  const inner = `exec ${opts.argv.map(sq).join(" ")} < ${sq(promptPath)} > ${sq(logPath)} 2>&1`;
  const envArgs: string[] = [];
  // Forward PATH so codex's own shell-tool invocations resolve dev binaries,
  // plus the harness env (CODEX_HOME/HOME) that controls codex's login/history.
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

  const state: CodexSessionState = {
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
    onSessionId: opts.onSessionId,
    sessionIdSent: false,
    resolved: false,
    lastCode: null,
    resolveDone: () => { /* replaced in startCodexTailer */ },
  };

  if (res.status !== 0) {
    // tmux failed to launch the session — surface stderr and resolve failed
    // synchronously so the run doesn't hang in `running`.
    const detail = (res.stderr || "tmux new-session failed").trim();
    opts.onChunk("stderr", `failed to start codex session: ${detail}`, undefined);
    const done = Promise.resolve(1);
    return { kill: () => { /* nothing to kill */ }, writeInput: () => false, done };
  }

  const done = startCodexTailer(state);
  return {
    kill: () => killCodexState(state),
    // codex exec doesn't accept conversational input mid-turn; follow-ups are
    // delivered as fresh `resume` turns (new run rows) by the orchestrator.
    writeInput: () => false,
    done,
  };
}

/**
 * Interrupt a codex turn: kill its tmux session and resolve `done` promptly.
 * We don't wait for the death-poll because we know the session is gone — a
 * brief grace lets the final appended bytes flush first. The orchestrator
 * decides cancelled-vs-failed from its own `handle.cancelled` flag, so the
 * resolution code here is immaterial to the recorded status.
 */
function killCodexState(state: CodexSessionState): void {
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
      flushCodexLog(state);
      resolveCodexDone(state, state.lastCode ?? 1);
    }, DEATH_GRACE_MS);
  })();
}

export interface CodexReattachOptions {
  taskId: string;
  runId: string;
  sessionName: string;
  onChunk: ChunkHandler;
  /** Dedup keys already persisted for this task's runs, so re-reading the log
   *  from offset 0 doesn't double-emit events streamed before the restart. */
  seenLineUuids: Set<string>;
}

/**
 * Reattach to a codex turn whose tmux session survived an agetor restart.
 * Re-tails the run's log from offset 0 (deduping via `seenLineUuids`) and
 * resolves `done` when the turn finishes. Returns null when the session is no
 * longer alive (caller should orphan the run).
 */
export async function reattachCodexSession(opts: CodexReattachOptions): Promise<SpawnedAgent | null> {
  if (!(await sessionExistsByName(opts.sessionName))) return null;
  const state: CodexSessionState = {
    taskId: opts.taskId,
    runId: opts.runId,
    sessionName: opts.sessionName,
    logPath: codexLogPath(opts.runId),
    offset: 0,
    decoder: new StringDecoder("utf8"),
    partial: "",
    watcher: null,
    pollTimer: null,
    deathTimer: null,
    seenLineUuids: opts.seenLineUuids,
    seq: { n: 0 },
    onChunk: opts.onChunk,
    onSessionId: undefined,
    sessionIdSent: true, // thread id already persisted on the original run
    resolved: false,
    lastCode: null,
    resolveDone: () => { /* replaced in startCodexTailer */ },
  };
  const done = startCodexTailer(state);
  return {
    kill: () => killCodexState(state),
    writeInput: () => false,
    done,
  };
}

/** True when a live codex tail is registered for this task. */
export function codexSessionActive(taskId: string): boolean {
  return codexSessions.has(taskId);
}

/**
 * Tear down a task's codex session: kill the tmux session and dispose the
 * in-memory tailer. Best-effort and non-throwing — called from deleteTask /
 * archiveTask and on a cross-kind agent switch. Safe to call when no codex
 * session exists (kills any stray session under the task's name too).
 */
export async function dropCodexSession(taskId: string): Promise<void> {
  const state = codexSessions.get(taskId);
  if (state) {
    disposeCodexState(state);
    codexSessions.delete(taskId);
  }
  await killSessionByName(sessionNameFor(taskId));
}
