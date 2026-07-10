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
import { spawnSync } from "node:child_process";
import { dataDir } from "./db.ts";
import { resolveTmuxBin, tmuxSocketArgs } from "./tmux-resolution.ts";
import { SESSION_DIED_STATUS_PREFIX } from "../shared/types.ts";
import {
  DEATH_JSONL_QUIET_MS,
  DEATH_MISS_THRESHOLD,
  deathTickOutcome,
  fileWrittenWithin,
  killSessionByName,
  sessionExistsByName,
  sessionLiveness,
  sessionNameFor,
  type ChunkHandler,
  type SpawnedAgent,
} from "./claude-tmux.ts";

/**
 * Driver that hosts a single `grok -p … --output-format streaming-json` turn
 * inside a per-task tmux session and exposes structured streaming by tailing
 * the newline-delimited JSON event log the shell wrapper redirects grok's
 * stdout into. Mirrors `codex-tmux.ts` structurally — see that file's header
 * for the restart-survival rationale (tmux hosts the one-shot process so a
 * mid-turn run survives an agetor restart; reattach only applies WHILE a turn
 * is in flight, since grok's tmux session — like codex's — lives only for the
 * duration of one turn).
 *
 * Two deviations from codex, both required by grok's CLI shape (docs.x.ai,
 * 2026-07, verified in Phase 1 of the grok-build-agent-support plan):
 *
 * 1. **Prompt delivery.** codex reads its prompt from stdin (the trailing `-`
 *    in its argv), so the wrapper redirects `< promptfile`. grok's `-p` takes
 *    the prompt as an ARGUMENT, not stdin. Embedding arbitrary prompt text
 *    (quotes, newlines) directly into the shell-quoted argv is quoting hell,
 *    so instead the wrapper uses command substitution: `-p
 *    "$(cat <promptfile>)"`. The outer double quotes preserve the file's
 *    content (including embedded whitespace/newlines) as a single argument;
 *    `promptfile`'s path is our own runId-derived path (never user content),
 *    so single-quoting it via `sq()` is safe. Per D8, `argv` passed into this
 *    driver therefore EXCLUDES `-p`/the prompt entirely — the driver splices
 *    `-p "$(cat …)"` in right after the resolved bin.
 *
 * 2. **Event schema is unpublished** (A1 in the plan). `mapGrokEvent` is
 *    intentionally defensive — see its docstring. Because the terminal event
 *    (success/failure) may not be recognized, the death-watch's fail-safe
 *    default (SESSION_DIED_STATUS_PREFIX + `blocked`, lastCode defaulting to
 *    1) mirrors codex's exactly: a false "blocked" is recoverable from the run
 *    panel, whereas a false "succeeded" would silently mask a failed turn.
 *    Ship Experimental; refine once a real `streaming-json` log is captured.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * Paths (derivable from runId alone, so reattach can recompute them).
 * ────────────────────────────────────────────────────────────────────────── */

const GROK_LOG_DIR = path.join(dataDir, "grok-logs");

export function grokLogPath(runId: string): string {
  return path.join(GROK_LOG_DIR, `${runId}.jsonl`);
}
function grokPromptPath(runId: string): string {
  return path.join(GROK_LOG_DIR, `${runId}.prompt.txt`);
}
function ensureLogDir(): void {
  if (!existsSync(GROK_LOG_DIR)) mkdirSync(GROK_LOG_DIR, { recursive: true });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Event mapping (grok `streaming-json` event → agetor RunEvent chunks).
 *
 * DEFENSIVE BY DESIGN (D2): the exact `streaming-json` event taxonomy is not
 * published verbatim as of 2026-07. Rather than hard-code field names that
 * may not exist, this mapper matches on *plausible* shapes — substrings in a
 * `type`/`event`/`method` field, and a handful of likely payload field names
 * (`text`, `content`, `message`, ACP-style `session/update` → `update.
 * sessionUpdate` / `update.content.text`). Anything that doesn't match a
 * known heuristic but still carries human-meaningful text falls through to a
 * generic `tool_use` chunk (codex's forward-compat pattern) so nothing goes
 * dark; anything with neither a recognized shape nor text is silently
 * dropped (forward-compat for pure protocol noise, e.g. pings).
 * ────────────────────────────────────────────────────────────────────────── */

interface GrokEvent {
  type?: string;
  event?: string;
  method?: string;
  id?: string;
  session_id?: string;
  sessionId?: string;
  text?: string;
  content?: unknown;
  message?: unknown;
  error?: { message?: string } | string;
  update?: { sessionUpdate?: string; content?: unknown; text?: string; [k: string]: unknown };
  [k: string]: unknown;
}

/** Result of mapping one event line. `done` terminates the turn (0 = success,
 *  1 = failure) when a recognized terminal event fires. `sessionId` is set
 *  once per turn, on the first event carrying it (mirrors codex's
 *  `thread.started`). */
export interface GrokMapResult {
  done?: number;
  sessionId?: string;
}

function errMessage(e: GrokEvent["error"]): string | undefined {
  if (!e) return undefined;
  if (typeof e === "string") return e;
  return e.message;
}

/** Pull a human-readable string out of a plausibly-text-shaped value: a bare
 *  string, or an object with a `.text` field (covers ACP-style `{ type:
 *  "text", text: "…" }` content blocks). */
function extractText(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const t = (v as Record<string, unknown>).text;
    if (typeof t === "string" && t.length > 0) return t;
  }
  return undefined;
}

/** Session id sniffing (D3 note in the plan): any event carrying `session_id`
 *  / `sessionId` at the top level, or one level deep in any object-valued
 *  field (covers a `params`/`update`/`item`-style wrapper). This id is what
 *  `--resume` replays. */
function findSessionId(evt: GrokEvent): string | undefined {
  if (typeof evt.session_id === "string") return evt.session_id;
  if (typeof evt.sessionId === "string") return evt.sessionId;
  for (const v of Object.values(evt)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (typeof o.session_id === "string") return o.session_id;
      if (typeof o.sessionId === "string") return o.sessionId;
    }
  }
  return undefined;
}

/**
 * Map a single parsed grok `streaming-json` event to zero or one chunk.
 * `lineIndex` is the NDJSON line's 0-based position within the run's log —
 * used (per D3) to build a stable fallback `line_uuid` for events without a
 * natural id. Deterministic across a reattach replay because the log is
 * always re-read from offset 0 and this counter restarts at 0 with it — it
 * counts file position, never wall-clock/random.
 *
 * line_uuid scheme: `${type}:${id}` when the event carries its own id;
 * otherwise `line:${lineIndex}`.
 */
export function mapGrokEvent(
  evt: GrokEvent,
  onChunk: ChunkHandler,
  lineIndex: number,
): GrokMapResult {
  const sessionId = findSessionId(evt);
  const typeRaw = evt.type ?? evt.event ?? evt.method ?? "";
  const type = typeRaw.toLowerCase();
  const key = typeof evt.id === "string" ? `${typeRaw}:${evt.id}` : `line:${lineIndex}`;
  // Text-bearing chunks fold the line index into the key: streaming formats
  // typically reuse one message id across delta events, and a bare
  // `${type}:${id}` key would collapse every delta after the first — the
  // seenLineUuids dedup runs on live runs too, not just reattach replays.
  // Still deterministic across reattach (log re-read from offset 0 restarts
  // lineIndex). Tool events keep the bare key: a repeated type+id there is
  // more likely a state update than a delta, and duplicates render noisily.
  const textKey = typeof evt.id === "string" ? `${key}:${lineIndex}` : key;

  // Error / failed events → stderr, terminal.
  if (type.includes("error") || type.includes("fail")) {
    const msg = errMessage(evt.error) ?? extractText(evt.message) ?? extractText(evt.text)
      ?? "grok turn failed";
    onChunk("stderr", msg, key);
    return { done: 1, sessionId };
  }

  // Reasoning / thinking events.
  if (type.includes("reason") || type.includes("think")) {
    const text = extractText(evt.text) ?? extractText(evt.content) ?? extractText(evt.message);
    if (text) onChunk("thinking", text, textKey);
    return { sessionId };
  }

  // ACP-style `session/update` payloads: { update: { sessionUpdate: "…", … } }.
  const update = evt.update;
  if (update?.sessionUpdate) {
    const su = update.sessionUpdate.toLowerCase();
    if (su.includes("message") || su.includes("text")) {
      const text = extractText(update.content) ?? extractText(update.text);
      if (text) onChunk("assistant", text, textKey);
      return { sessionId };
    }
    if (su.includes("tool") || su.includes("command") || su.includes("plan")) {
      onChunk("tool_use", JSON.stringify(update), key);
      return { sessionId };
    }
  }

  // Plain assistant text / message events.
  if (type.includes("message") || type.includes("text") || type.includes("assistant")) {
    const text = extractText(evt.text) ?? extractText(evt.content) ?? extractText(evt.message);
    if (text) onChunk("assistant", text, textKey);
    return { sessionId };
  }

  // Tool / command execution events → tool_use (+ tool_result when an
  // output/result field is present).
  if (type.includes("tool") || type.includes("command") || type.includes("exec")) {
    const { type: _t, event: _e, method: _m, ...rest } = evt;
    onChunk("tool_use", JSON.stringify({ name: typeRaw || "grok-tool", input: rest }), `${key}:use`);
    const out = (evt as { output?: unknown; result?: unknown }).output
      ?? (evt as { output?: unknown; result?: unknown }).result;
    if (out !== undefined) {
      onChunk("tool_result", JSON.stringify({ content: out }), `${key}:result`);
    }
    return { sessionId };
  }

  // Plausible terminal/completion events with no error signal → success.
  if (type.includes("complete") || type.includes("done") || type.includes("finish") || type === "result") {
    return { done: 0, sessionId };
  }

  // Forward-compat fallback: an unrecognized event that still carries
  // human-meaningful text renders as a generic tool_use so nothing goes
  // dark (mirrors codex's default-item-kind handling). Pure protocol noise
  // (no text anywhere) is silently dropped.
  const fallback = extractText(evt.text) ?? extractText(evt.content) ?? extractText(evt.message);
  if (fallback) {
    onChunk("tool_use", JSON.stringify({ name: typeRaw || "grok-event", text: fallback }), key);
  }
  return { sessionId };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Session state + tailer.
 * ────────────────────────────────────────────────────────────────────────── */

interface GrokSessionState {
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
  /** D3: 0-based NDJSON line index, incremented once per successfully parsed
   *  event. Restarts at 0 on reattach since the log is always re-read from
   *  offset 0 — stable because the log is append-only. */
  lineNo: number;
  onChunk: ChunkHandler;
  onSessionId?: (id: string) => void;
  sessionIdSent: boolean;
  resolved: boolean;
  lastCode: number | null;
  resolveDone: (code: number) => void;
}

const grokSessions = new Map<string, GrokSessionState>(); // taskId -> state

const POLL_MS = 150;
const DEATH_POLL_MS = 400;
/** Grace after the tmux session disappears before we resolve, so the final
 *  appended bytes are flushed and read. Poll + grace stay driver-local (grok
 *  is one-shot, same as codex); the death-decision inputs
 *  `DEATH_MISS_THRESHOLD` + `DEATH_JSONL_QUIET_MS` are imported from
 *  claude-tmux so both watches share one `deathTickOutcome` contract. */
const DEATH_GRACE_MS = 250;

function disposeGrokState(state: GrokSessionState): void {
  if (state.watcher) { try { state.watcher.close(); } catch { /* noop */ } state.watcher = null; }
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  if (state.deathTimer) { clearInterval(state.deathTimer); state.deathTimer = null; }
}

/** Read any bytes appended since `state.offset`, split into complete lines,
 *  and dispatch each through the mapper. Tolerates the file not existing yet
 *  (the shell redirect creates it within a few ms of spawn). */
function flushGrokLog(state: GrokSessionState): void {
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
    let evt: GrokEvent;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      // Not JSON — surface it rather than drop it (could be a launch error
      // from the shell wrapper, e.g. "command not found", or stray CLI
      // banner text). No line_uuid: nothing to dedup a free-text line on.
      state.onChunk("stderr", trimmed, undefined);
      continue;
    }
    dispatchGrokEvent(state, evt);
  }
}

function dispatchGrokEvent(state: GrokSessionState, evt: GrokEvent): void {
  // Wrap onChunk to apply the seenLineUuids dedup (idempotent reattach replay).
  const onChunk: ChunkHandler = (stream, data, lineUuid) => {
    if (lineUuid) {
      if (state.seenLineUuids.has(lineUuid)) return;
      state.seenLineUuids.add(lineUuid);
    }
    state.onChunk(stream, data, lineUuid);
  };
  const result = mapGrokEvent(evt, onChunk, state.lineNo);
  state.lineNo++;
  if (result.sessionId && !state.sessionIdSent) {
    state.sessionIdSent = true;
    state.onSessionId?.(result.sessionId);
  }
  if (typeof result.done === "number") {
    state.lastCode = result.done;
    resolveGrokDone(state, result.done);
  }
}

function resolveGrokDone(state: GrokSessionState, code: number): void {
  if (state.resolved) return;
  state.resolved = true;
  disposeGrokState(state);
  grokSessions.delete(state.taskId);
  // Kill the tmux session on resolve. On the normal path the one-shot grok
  // process is already exiting (no-op), but the speculative mapper (D2) can
  // recognize a terminal event early — without this, the run would be marked
  // terminal while the real grok process kept working detached, and since
  // reconcileOrphans only reattaches status='running' rows, that session
  // would leak with no cleanup path. Own-scoped (this task's session name),
  // so it can't touch a sibling instance's sessions.
  killSessionByName(state.sessionName);
  // The run is terminal now: its events are persisted in run_events (the panel
  // replays from the DB, not the log) and reattach only applies to running
  // turns, so the per-run log + prompt files are dead weight. Prune them
  // best-effort so dataDir/grok-logs/ doesn't grow unbounded. Timers are
  // already cleared above, so nothing will try to read them after this.
  try { unlinkSync(grokPromptPath(state.runId)); } catch { /* already gone */ }
  try { unlinkSync(state.logPath); } catch { /* already gone */ }
  state.resolveDone(code);
}

/** Begin tailing the run's log + watching for session death. Shared by the
 *  spawn and reattach paths. Returns the `done` promise. */
function startGrokTailer(state: GrokSessionState): Promise<number> {
  const done = new Promise<number>((resolve) => {
    state.resolveDone = resolve;
  });
  grokSessions.set(state.taskId, state);

  // Poll the log for appends. macOS FSEvents drops appends to a file written
  // by another process, so polling — not fs.watch — is the reliable backstop;
  // we add an fs.watch opportunistically once the file exists for low latency.
  state.pollTimer = setInterval(() => flushGrokLog(state), POLL_MS);
  const tryWatch = () => {
    if (state.watcher || !existsSync(state.logPath)) return;
    try {
      state.watcher = fsWatch(state.logPath, () => flushGrokLog(state));
    } catch { /* fall back to poll-only */ }
  };
  tryWatch();

  // Death watch: when the tmux session disappears the `grok` process has
  // exited. Flush whatever's left, then resolve. A recognized terminal event
  // (mapper `done`) normally resolves us first; this catches a crash — or,
  // given the speculative mapper (D2), an ordinary completion whose terminal
  // event we failed to recognize. Only a definitive `gone` probe (server up,
  // this session absent) counts toward death — an `unreachable` tmux hiccup on
  // the shared socket resets the counter, and a grok log written a beat ago
  // vetoes it — so a live one-shot run is never wrongly torn down (mirrors
  // claude-tmux's death watch; see `sessionLiveness`).
  let misses = 0;
  state.deathTimer = setInterval(() => {
    tryWatch();
    // Compute the log-recency veto lazily — only a `gone` probe uses it.
    const liveness = sessionLiveness(state.sessionName);
    const outcome = deathTickOutcome({
      liveness,
      logFresh: liveness === "gone" && fileWrittenWithin(state.logPath, DEATH_JSONL_QUIET_MS),
      misses,
      threshold: DEATH_MISS_THRESHOLD,
    });
    if (outcome === "reset") { misses = 0; return; }
    if (outcome === "wait") { misses++; return; }
    // Session gone. Give the FS a beat to surface the final bytes, flush, then
    // resolve with whatever terminal code we saw (default: failed — a grok
    // run that vanished without a recognized terminal event did not
    // demonstrably succeed; see the file header for why the fail-safe default
    // is deliberate).
    setTimeout(() => {
      flushGrokLog(state);
      // If the final flush surfaced a terminal event, resolveGrokDone already
      // fired — this was an orderly finish, not a death, so don't emit the
      // "session ended" sentinel.
      if (!state.resolved) {
        // Emit the shared sentinel so the orchestrator flips the card to
        // `blocked` (via makeChunkHandler) and the user sees WHY the run
        // stopped in the stream, instead of a silent drop to `ready`.
        state.onChunk(
          "status",
          `${SESSION_DIED_STATUS_PREFIX}tmux session ${state.sessionName} ended unexpectedly — task blocked`,
        );
      }
      resolveGrokDone(state, state.lastCode ?? 1);
    }, DEATH_GRACE_MS);
    if (state.deathTimer) { clearInterval(state.deathTimer); state.deathTimer = null; }
  }, DEATH_POLL_MS);

  return done;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Spawn / reattach.
 * ────────────────────────────────────────────────────────────────────────── */

const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export interface GrokLaunchOptions {
  taskId: string;
  runId: string;
  /** Grok argv from `buildCommand`, EXCLUDING `-p`/the prompt itself —
   *  `[bin, "--output-format", "streaming-json", ("-m", model)?, …mode flags,
   *  ("--resume", sessionId)?]`. The driver splices `-p "$(cat <promptfile>)"`
   *  in right after the resolved bin (see the file header — grok's `-p` takes
   *  an argument, not stdin, so the prompt can't be delivered the way codex's
   *  trailing `-` is). */
  argv: string[];
  /** Env to forward into the grok process (GROK_HOME/HOME + harness env). */
  env: Record<string, string>;
  cwd: string;
  /** The prompt text — written to a file and spliced into `-p` via command
   *  substitution so no user text ever lands directly in the shell string. */
  promptText: string;
  onChunk: ChunkHandler;
  /** Fires once with grok's session id (sniffed per `findSessionId`). */
  onSessionId?: (id: string) => void;
}

/**
 * Spawn one grok turn in a detached tmux session and start tailing its
 * `streaming-json` log. Returns a `SpawnedAgent` whose `done` resolves when
 * the turn ends (0 on a recognized success event, 1 on failure/crash/unknown
 * death).
 */
export function spawnGrokViaTmux(opts: GrokLaunchOptions): SpawnedAgent {
  ensureLogDir();
  const logPath = grokLogPath(opts.runId);
  const promptPath = grokPromptPath(opts.runId);
  writeFileSync(promptPath, opts.promptText);
  // Truncate/create the log up front so the tailer's first stat succeeds and
  // offsets start at 0 cleanly even if a stale file from a reused id lingers.
  writeFileSync(logPath, "");

  const sessionName = sessionNameFor(opts.taskId);
  // Defensive: a zombie session under this name would make new-session fail.
  killSessionByName(sessionName);

  const tmux = resolveTmuxBin();
  const [bin, ...rest] = opts.argv;
  if (!bin) throw new Error("spawnGrokViaTmux requires a non-empty argv");
  // `-p "$(cat …)"`: the outer double quotes preserve the substituted file
  // content (whitespace/newlines included) as a single argv entry to grok;
  // the promptPath itself is single-quoted via sq() since it's our own
  // runId-derived path, never user content.
  const inner = `exec ${sq(bin)} -p "$(cat ${sq(promptPath)})" ${rest.map(sq).join(" ")} > ${sq(logPath)} 2>&1`;
  const envArgs: string[] = [];
  // Forward PATH so grok's own tool invocations resolve dev binaries, plus
  // the harness env (GROK_HOME/HOME) that controls grok's login/history.
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
  const res = spawnSync(tmux, args, { encoding: "utf8" });

  const state: GrokSessionState = {
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
    lineNo: 0,
    onChunk: opts.onChunk,
    onSessionId: opts.onSessionId,
    sessionIdSent: false,
    resolved: false,
    lastCode: null,
    resolveDone: () => { /* replaced in startGrokTailer */ },
  };

  if (res.status !== 0) {
    // tmux failed to launch the session — surface stderr and resolve failed
    // synchronously so the run doesn't hang in `running`.
    const detail = (res.stderr || res.error?.message || "tmux new-session failed").trim();
    opts.onChunk("stderr", `failed to start grok session: ${detail}`, undefined);
    // Nothing will ever tail these — prune the files written above so a
    // launch failure doesn't leave the prompt text on disk indefinitely.
    try { unlinkSync(promptPath); } catch { /* best-effort */ }
    try { unlinkSync(logPath); } catch { /* best-effort */ }
    const done = Promise.resolve(1);
    return { kill: () => { /* nothing to kill */ }, writeInput: () => false, done };
  }

  const done = startGrokTailer(state);
  return {
    kill: () => killGrokState(state),
    // grok doesn't accept conversational input mid-turn (one-shot exec);
    // follow-ups are delivered as fresh `--resume` turns (new run rows) by
    // the orchestrator.
    writeInput: () => false,
    done,
  };
}

/**
 * Interrupt a grok turn: kill its tmux session and resolve `done` promptly.
 * We don't wait for the death-poll because we know the session is gone — a
 * brief grace lets the final appended bytes flush first. The orchestrator
 * decides cancelled-vs-failed from its own `handle.cancelled` flag, so the
 * resolution code here is immaterial to the recorded status.
 */
function killGrokState(state: GrokSessionState): void {
  killSessionByName(state.sessionName);
  setTimeout(() => {
    flushGrokLog(state);
    resolveGrokDone(state, state.lastCode ?? 1);
  }, DEATH_GRACE_MS);
}

export interface GrokReattachOptions {
  taskId: string;
  runId: string;
  sessionName: string;
  onChunk: ChunkHandler;
  /** Dedup keys already persisted for this task's runs, so re-reading the log
   *  from offset 0 doesn't double-emit events streamed before the restart. */
  seenLineUuids: Set<string>;
}

/**
 * Reattach to a grok turn whose tmux session survived an agetor restart.
 * Re-tails the run's log from offset 0 (deduping via `seenLineUuids`) and
 * resolves `done` when the turn finishes. Returns null when the session is no
 * longer alive (caller should orphan the run).
 */
export function reattachGrokSession(opts: GrokReattachOptions): SpawnedAgent | null {
  if (!sessionExistsByName(opts.sessionName)) return null;
  const state: GrokSessionState = {
    taskId: opts.taskId,
    runId: opts.runId,
    sessionName: opts.sessionName,
    logPath: grokLogPath(opts.runId),
    offset: 0,
    decoder: new StringDecoder("utf8"),
    partial: "",
    watcher: null,
    pollTimer: null,
    deathTimer: null,
    seenLineUuids: opts.seenLineUuids,
    lineNo: 0,
    onChunk: opts.onChunk,
    onSessionId: undefined,
    sessionIdSent: true, // session id already persisted on the original run
    resolved: false,
    lastCode: null,
    resolveDone: () => { /* replaced in startGrokTailer */ },
  };
  const done = startGrokTailer(state);
  return {
    kill: () => killGrokState(state),
    writeInput: () => false,
    done,
  };
}

/** True when a live grok tail is registered for this task. */
export function grokSessionActive(taskId: string): boolean {
  return grokSessions.has(taskId);
}

/**
 * Tear down a task's grok session: kill the tmux session and dispose the
 * in-memory tailer. Best-effort and non-throwing — called from deleteTask /
 * archiveTask and on a cross-kind agent switch. Safe to call when no grok
 * session exists (kills any stray session under the task's name too).
 */
export function dropGrokSession(taskId: string): void {
  const state = grokSessions.get(taskId);
  if (state) {
    disposeGrokState(state);
    grokSessions.delete(taskId);
  }
  killSessionByName(sessionNameFor(taskId));
}
