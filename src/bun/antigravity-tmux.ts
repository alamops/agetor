import {
  existsSync,
  mkdirSync,
  watch as fsWatch,
  type FSWatcher,
  readSync as fsReadSync,
  closeSync as fsCloseSync,
  statSync as fsStatSync,
  writeFileSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { dataDir } from "./db-path.ts";
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
import { openReadNoFollow, readTextNoFollow } from "./no-follow.ts";

/**
 * Driver that hosts a single `agy -p` turn inside a per-task tmux
 * session and exposes structured streaming by tailing the newline-delimited
 * JSON event log agy writes (via `--output-format stream-json`).
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * Paths (derivable from runId alone, so reattach can recompute them).
 * ────────────────────────────────────────────────────────────────────────── */

const ANTIGRAVITY_LOG_DIR = path.join(dataDir, "antigravity-logs");

export function antigravityLogPath(runId: string): string {
  return path.join(ANTIGRAVITY_LOG_DIR, `${runId}.jsonl`);
}
export function antigravityPromptPath(runId: string): string {
  return path.join(ANTIGRAVITY_LOG_DIR, `${runId}.prompt.txt`);
}
export function antigravityExitPath(runId: string): string {
  return path.join(ANTIGRAVITY_LOG_DIR, `${runId}.exit`);
}
function ensureLogDir(): void {
  if (!existsSync(ANTIGRAVITY_LOG_DIR)) mkdirSync(ANTIGRAVITY_LOG_DIR, { recursive: true });
}

export function readAntigravityExitCode(runId: string): number | null {
  let raw: string;
  try {
    raw = readTextNoFollow(antigravityExitPath(runId)).trim();
  } catch {
    return null;
  }
  if (!/^-?\d+$/.test(raw)) return null;
  const code = Number.parseInt(raw, 10);
  return Number.isFinite(code) ? code : null;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Event mapping (antigravity `stream-json` event → agetor RunEvent chunks).
 * ────────────────────────────────────────────────────────────────────────── */

export interface AntigravityEvent {
  event?: string;
  conversation_id?: string;
  init?: {
    model?: string;
    cwd?: string;
    tools?: string[];
    permission_mode?: string;
  };
  step_update?: {
    conversation_id?: string;
    step_index?: number;
    state?: "ACTIVE" | "DONE" | string;
    step_type?: "user_input" | "agent_response" | "tool" | "system_message" | string;
    text_delta?: string;
    tool_name?: string;
    tool_info?: {
      name?: string;
      parameters?: unknown;
      output?: unknown;
      error?: { type?: string; message?: string } | string;
      [k: string]: unknown;
    };
    duration_seconds?: number;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      thinking_tokens?: number;
      cache_read_tokens?: number;
      total_tokens?: number;
    };
  };
  result?: {
    conversation_id?: string;
    status?: "SUCCESS" | "ERROR" | string;
    response?: string;
    duration_seconds?: number;
    num_turns?: number;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      thinking_tokens?: number;
      cache_read_tokens?: number;
      total_tokens?: number;
    };
    error?: { message?: string } | string;
  };
  error?: { message?: string } | string;
}

export interface AntigravityMapResult {
  done?: number;
  sessionId?: string;
  assistantTextEmitted?: true;
}

function errMessage(e: AntigravityEvent["error"] | AntigravityEvent["result"], fallback: string): string {
  if (!e) return fallback;
  if (typeof e === "string") return e;
  if ("error" in e && e.error) {
    const inner = e.error;
    if (typeof inner === "string") return inner;
    if (inner && typeof inner === "object" && "message" in inner && typeof inner.message === "string") {
      return inner.message;
    }
  }
  if ("message" in e && typeof e.message === "string") return e.message;
  return fallback;
}

/**
 * Folds `agy --output-format stream-json`'s token-level `agent_response`
 * `text_delta` updates back into one `assistant` chunk per step (mirroring
 * `FxTextCoalescer` in `fx-acp.ts` and `TurnText` in `cursor-acp.ts`).
 *
 * Forwarding each `ACTIVE` `text_delta` as its own `assistant` event persisted
 * hundreds of 10-character `run_events` rows that RunPanel rendered as separate
 * Markdown bubbles (breaking bold, inline code, lists, and paragraphs mid-word).
 * Buffering per `step_index` and flushing on `state === "DONE"`, a step change,
 * any non-`agent_response` event, or session settlement produces one intact
 * Markdown message per step with a deterministic `antigravity:step_<index>`
 * lineUuid that dedups cleanly on reattach replay.
 */
export class AntigravityTextCoalescer {
  private stepIndex: number | undefined;
  private firstLineIndex: number | undefined;
  private text = "";
  /** Counts previously flushed fragments per `step_index` so if an
   *  interleaved event (e.g. non-JSON chatter, tool, error) flushes a step
   *  early and the same `step_index` later emits more `text_delta`s, each
   *  fragment gets a distinct, replay-stable lineUuid instead of colliding
   *  with `seenLineUuids` and getting dropped. Uninterrupted steps always get
   *  count 0 (`antigravity:step_<index>`). */
  private emittedCountByStep = new Map<number, number>();

  pushDelta(
    delta: string,
    stepIndex: number | undefined,
    lineIndex: number,
    done: boolean,
    emit: ChunkHandler,
  ): boolean {
    let emitted = false;
    if (
      this.text.length > 0 &&
      stepIndex !== undefined &&
      this.stepIndex !== undefined &&
      stepIndex !== this.stepIndex
    ) {
      emitted = this.flush(emit) || emitted;
    }
    if (this.text.length === 0) {
      this.stepIndex = stepIndex;
      this.firstLineIndex = lineIndex;
    }
    if (delta) this.text += delta;
    if (done) {
      emitted = this.flush(emit) || emitted;
    }
    return emitted;
  }

  flush(emit: ChunkHandler): boolean {
    if (!this.text) {
      this.stepIndex = undefined;
      this.firstLineIndex = undefined;
      return false;
    }
    let uuid: string;
    if (this.stepIndex !== undefined) {
      const count = this.emittedCountByStep.get(this.stepIndex) ?? 0;
      this.emittedCountByStep.set(this.stepIndex, count + 1);
      uuid = count === 0 ? `antigravity:step_${this.stepIndex}` : `antigravity:step_${this.stepIndex}:${count}`;
    } else {
      uuid = `antigravity:${this.firstLineIndex ?? 0}`;
    }
    const data = this.text;
    this.text = "";
    this.stepIndex = undefined;
    this.firstLineIndex = undefined;
    emit("assistant", data, uuid);
    return true;
  }

  hasPending(): boolean {
    return this.text.length > 0;
  }
}

export function mapAntigravityEvent(
  evt: AntigravityEvent,
  onChunk: ChunkHandler,
  lineIndex: number,
  priorAssistantText: boolean = false,
  coalescer?: AntigravityTextCoalescer,
): AntigravityMapResult {
  const event = evt.event ?? "";
  const sessionId = typeof evt.conversation_id === "string" ? evt.conversation_id : undefined;

  switch (event) {
    case "init": {
      return { sessionId };
    }

    case "step_update": {
      const step = evt.step_update;
      if (!step) return { sessionId };
      const stepType = step.step_type ?? "";

      if (stepType === "agent_response") {
        const delta = step.text_delta ?? "";
        const isTerminalState = step.state === "DONE" || step.state === "ERROR" || step.state === "FAILED" || step.state === "CANCELLED";
        if (coalescer) {
          const emitted = coalescer.pushDelta(delta, step.step_index, lineIndex, isTerminalState, onChunk);
          return emitted ? { sessionId, assistantTextEmitted: true } : { sessionId };
        }
        if (delta) {
          const uuid = step.step_index !== undefined ? `antigravity:step_${step.step_index}` : `antigravity:${lineIndex}`;
          onChunk("assistant", delta, uuid);
          return { sessionId, assistantTextEmitted: true };
        }
        return { sessionId };
      }

      if (stepType === "tool") {
        const flushed = coalescer?.flush(onChunk) ?? false;
        const id = `step_${step.step_index ?? lineIndex}`;
        if (step.state === "ACTIVE") {
          const toolName = step.tool_name ?? step.tool_info?.name ?? "tool";
          onChunk("tool_use", JSON.stringify({
            id,
            name: toolName,
            input: step.tool_info?.parameters ?? {},
            serverSide: false,
          }), `tool_use:${id}`);
        } else if (step.state === "DONE") {
          const output = step.tool_info?.output;
          const toolErr = step.tool_info?.error;
          const isError = Boolean(toolErr);
          const content =
            output !== undefined
              ? (typeof output === "string" ? output : JSON.stringify(output))
              : toolErr
                ? errMessage(toolErr, "tool failed")
                : "";
          onChunk("tool_result", JSON.stringify({
            toolUseId: id,
            content,
            isError,
          }), `tool_result:${id}`);
        } else if (step.state === "ERROR" || step.state === "FAILED" || step.state === "CANCELLED") {
          const toolErr = step.tool_info?.error;
          const output = step.tool_info?.output;
          const fallback =
            output !== undefined
              ? (typeof output === "string" ? output : JSON.stringify(output))
              : `tool ${step.state.toLowerCase()}`;
          onChunk("tool_result", JSON.stringify({
            toolUseId: id,
            content: errMessage(toolErr, fallback),
            isError: true,
          }), `tool_result:${id}`);
        }
        return flushed ? { sessionId, assistantTextEmitted: true } : { sessionId };
      }

      return { sessionId };
    }

    case "result": {
      const flushed = coalescer?.flush(onChunk) ?? false;
      const emittedBeforeResult = priorAssistantText || flushed;
      const res = evt.result;
      const ok = res?.status === "SUCCESS";
      if (!ok) {
        onChunk(
          "stderr",
          errMessage(res?.error ?? res, `antigravity turn failed (status: ${res?.status ?? "unknown"})`),
          `antigravity:result:${lineIndex}`,
        );
      } else if (!emittedBeforeResult && res?.response) {
        onChunk("assistant", res.response, `antigravity:result:${lineIndex}`);
      }
      return {
        done: ok ? 0 : 1,
        sessionId: res?.conversation_id ?? sessionId,
        assistantTextEmitted: flushed || (ok && Boolean(res?.response)) ? true : undefined,
      };
    }

    case "error": {
      const flushed = coalescer?.flush(onChunk) ?? false;
      onChunk("stderr", errMessage(evt.error, "antigravity error"), `antigravity:error:${lineIndex}`);
      return flushed ? { sessionId, assistantTextEmitted: true } : { sessionId };
    }

    default:
      return { sessionId };
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Session state + tailer.
 * ────────────────────────────────────────────────────────────────────────── */

interface AntigravitySessionState {
  taskId: string;
  runId: string;
  sessionName: string;
  logPath: string;
  offset: number;
  decoder: StringDecoder;
  partial: string;
  nextLineIndex: number;
  assistantTextEmitted: boolean;
  coalescer: AntigravityTextCoalescer;
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

const antigravitySessions = new Map<string, AntigravitySessionState>(); // taskId -> state

const POLL_MS = 150;
const DEATH_POLL_MS = 400;
const DEATH_GRACE_MS = 250;

function disposeAntigravityState(state: AntigravitySessionState): void {
  if (state.watcher) { try { state.watcher.close(); } catch { /* noop */ } state.watcher = null; }
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  if (state.deathTimer) { clearInterval(state.deathTimer); state.deathTimer = null; }
}

function processAntigravityLine(state: AntigravitySessionState, rawLine: string): void {
  const trimmed = rawLine.trim();
  if (!trimmed) return;
  const lineIndex = state.nextLineIndex++;
  const emit: ChunkHandler = (stream, data, lineUuid) => onChunkDedup(state, stream, data, lineUuid);
  let parsed: AntigravityEvent;
  try {
    parsed = JSON.parse(trimmed) as AntigravityEvent;
  } catch {
    // Plain text banner or non-JSON chatter — flush any buffered assistant text
    // first so wire order stays intact.
    if (state.coalescer.flush(emit)) state.assistantTextEmitted = true;
    onChunkDedup(state, "stdout", trimmed, `antigravity:${lineIndex}`);
    return;
  }

  const res = mapAntigravityEvent(
    parsed,
    emit,
    lineIndex,
    state.assistantTextEmitted,
    state.coalescer,
  );
  if (res.assistantTextEmitted) state.assistantTextEmitted = true;
  if (res.sessionId && !state.sessionIdSent && state.onSessionId) {
    state.sessionIdSent = true;
    try { state.onSessionId(res.sessionId); } catch { /* noop */ }
  }
  if (res.done !== undefined && state.lastCode === null) {
    state.lastCode = res.done;
  }
}

function flushAntigravityLog(state: AntigravitySessionState, eof = false): void {
  let fd: number | undefined;
  try {
    const st = fsStatSync(state.logPath);
    if (st.size > state.offset) {
      fd = openReadNoFollow(state.logPath);
    }
  } catch {
    if (!eof) return;
  }
  try {
    let text = "";
    if (fd !== undefined) {
      const buf = Buffer.alloc(64 * 1024);
      let bytesRead: number;
      while ((bytesRead = fsReadSync(fd, buf, 0, buf.length, state.offset)) > 0) {
        state.offset += bytesRead;
        text += state.decoder.write(buf.subarray(0, bytesRead));
      }
    }
    if (eof) {
      text += state.decoder.end();
    }
    if (text) {
      const combined = state.partial + text;
      const lines = combined.split("\n");
      state.partial = lines.pop() ?? "";
      for (const line of lines) processAntigravityLine(state, line);
    }
    if (eof && state.partial.trim()) {
      const tail = state.partial;
      state.partial = "";
      processAntigravityLine(state, tail);
    }
  } finally {
    if (fd !== undefined) {
      try { fsCloseSync(fd); } catch { /* noop */ }
    }
  }
}

function onChunkDedup(
  state: AntigravitySessionState,
  stream: Parameters<ChunkHandler>[0],
  data: string,
  lineUuid?: string,
): void {
  if (lineUuid) {
    if (state.seenLineUuids.has(lineUuid)) return;
    state.seenLineUuids.add(lineUuid);
  }
  state.onChunk(stream, data, lineUuid);
}

function resolveSession(state: AntigravitySessionState, code: number): void {
  if (state.resolved) return;
  state.resolved = true;
  const emit: ChunkHandler = (stream, data, lineUuid) => onChunkDedup(state, stream, data, lineUuid);
  if (state.coalescer.flush(emit)) state.assistantTextEmitted = true;
  disposeAntigravityState(state);
  antigravitySessions.delete(state.taskId);
  state.resolveDone(code);
}

function startAntigravityTailer(state: AntigravitySessionState): Promise<number> {
  return new Promise<number>((resolve) => {
    state.resolveDone = resolve;
    antigravitySessions.set(state.taskId, state);

    flushAntigravityLog(state);
    if (state.lastCode !== null) {
      resolveSession(state, state.lastCode);
      return;
    }

    try {
      state.watcher = fsWatch(state.logPath, () => flushAntigravityLog(state));
    } catch {
      // transient watch error, poll covers it
    }

    state.pollTimer = setInterval(() => {
      flushAntigravityLog(state);
      if (state.lastCode !== null) {
        resolveSession(state, state.lastCode);
      }
    }, POLL_MS);

    const probe = createDeathProbe({
      sessionName: state.sessionName,
      authoritative: sessionLiveness,
      resolvePid: panePidFor,
    });
    let misses = 0;
    let tickInFlight = false;
    state.deathTimer = setInterval(() => {
      if (tickInFlight || state.resolved) return;
      tickInFlight = true;
      void (async () => {
        try {
          const liveness = await probe.probe();
          const outcome = deathTickOutcome({
            liveness,
            logFresh: liveness === "gone" && fileWrittenWithin(state.logPath, DEATH_JSONL_QUIET_MS),
            misses,
            threshold: DEATH_MISS_THRESHOLD,
          });
          if (outcome === "reset") { misses = 0; return; }
          if (outcome === "wait") { misses++; return; }
          setTimeout(() => {
            flushAntigravityLog(state, true);
            if (state.lastCode !== null) {
              resolveSession(state, state.lastCode);
              return;
            }
            const exitCode = readAntigravityExitCode(state.runId);
            if (exitCode !== null) {
              resolveSession(state, exitCode === 0 ? 0 : 1);
              return;
            }
            if (!state.resolved) {
              state.onChunk("status", `${SESSION_DIED_STATUS_PREFIX}antigravity session vanished mid-turn`);
            }
            resolveSession(state, 1);
          }, DEATH_GRACE_MS);
          if (state.deathTimer) { clearInterval(state.deathTimer); state.deathTimer = null; }
        } catch {
          // ignore
        } finally {
          tickInFlight = false;
        }
      })();
    }, DEATH_POLL_MS);
  });
}

function sq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface AntigravityLaunchOptions {
  taskId: string;
  runId: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  promptText: string;
  onChunk: ChunkHandler;
  onSessionId?: (id: string) => void;
}

export async function spawnAntigravityViaTmux(opts: AntigravityLaunchOptions): Promise<SpawnedAgent> {
  ensureLogDir();
  const logPath = antigravityLogPath(opts.runId);
  const promptPath = antigravityPromptPath(opts.runId);
  const exitPath = antigravityExitPath(opts.runId);
  writeFileSync(promptPath, opts.promptText);
  writeFileSync(logPath, "");
  try { unlinkSync(exitPath); } catch { /* noop */ }

  const sessionName = sessionNameFor(opts.taskId);
  await killSessionByName(sessionName);

  const tmux = resolveTmuxBin();
  const inner = `"$@" "$(cat ${sq(promptPath)})" > ${sq(logPath)} 2>&1; echo $? > ${sq(exitPath)}`;
  const envArgs: string[] = [];
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

  const state: AntigravitySessionState = {
    taskId: opts.taskId,
    runId: opts.runId,
    sessionName,
    logPath,
    offset: 0,
    decoder: new StringDecoder("utf8"),
    partial: "",
    nextLineIndex: 0,
    assistantTextEmitted: false,
    coalescer: new AntigravityTextCoalescer(),
    watcher: null,
    pollTimer: null,
    deathTimer: null,
    seenLineUuids: new Set(),
    onChunk: opts.onChunk,
    onSessionId: opts.onSessionId,
    sessionIdSent: false,
    resolved: false,
    lastCode: null,
    resolveDone: () => {},
  };

  if (res.status !== 0) {
    // tmux failed to launch the session — surface stderr and resolve failed
    // synchronously so the run doesn't hang until the death probe fires.
    const detail = (res.stderr || "tmux new-session failed").trim();
    opts.onChunk("stderr", `failed to start antigravity session: ${detail}`, undefined);
    const done = Promise.resolve(1);
    return { kill: () => { /* nothing to kill */ }, writeInput: () => false, done };
  }

  const done = startAntigravityTailer(state);
  return {
    kill: () => killAntigravityState(state),
    writeInput: () => false,
    done,
  };
}

async function killAntigravityState(state: AntigravitySessionState): Promise<void> {
  await killSessionByName(state.sessionName);
  resolveSession(state, 1);
}

export interface AntigravityReattachOptions {
  taskId: string;
  runId: string;
  sessionName: string;
  onChunk: ChunkHandler;
  seenLineUuids: Set<string>;
}

export async function reattachAntigravitySession(opts: AntigravityReattachOptions): Promise<SpawnedAgent | null> {
  if (!(await sessionExistsByName(opts.sessionName))) return null;
  const state: AntigravitySessionState = {
    taskId: opts.taskId,
    runId: opts.runId,
    sessionName: opts.sessionName,
    logPath: antigravityLogPath(opts.runId),
    offset: 0,
    decoder: new StringDecoder("utf8"),
    partial: "",
    nextLineIndex: 0,
    assistantTextEmitted: false,
    coalescer: new AntigravityTextCoalescer(),
    watcher: null,
    pollTimer: null,
    deathTimer: null,
    seenLineUuids: opts.seenLineUuids,
    onChunk: opts.onChunk,
    onSessionId: undefined,
    sessionIdSent: true,
    resolved: false,
    lastCode: null,
    resolveDone: () => {},
  };
  const done = startAntigravityTailer(state);
  return {
    kill: () => killAntigravityState(state),
    writeInput: () => false,
    done,
  };
}

export function antigravitySessionActive(taskId: string): boolean {
  return antigravitySessions.has(taskId);
}

export async function dropAntigravitySession(taskId: string): Promise<void> {
  const state = antigravitySessions.get(taskId);
  if (state) {
    await killAntigravityState(state);
  } else {
    await killSessionByName(sessionNameFor(taskId));
  }
}
