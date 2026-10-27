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
  appendFileSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { dataDir } from "./db.ts";
import { resolveTmuxBin, tmuxSocketArgs, tmuxClientEnv, spawnTmuxNewSession } from "./tmux-resolution.ts";
import { createDeathProbe } from "./session-liveness.ts";
import {
  FX_USAGE_STATUS_PREFIX,
  SESSION_DIED_STATUS_PREFIX,
  type FxUsagePayload,
  type RunEventStream,
} from "../shared/types.ts";
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
 * Driver that hosts a single `opencode run --format json` turn inside a
 * per-task tmux session and exposes structured streaming by tailing the
 * newline-delimited JSON OpenCode prints (`docs/plans/add-opencode-harness.md`
 * D-1, D-8–D-11; real CLI behavior in `docs/plans/add-opencode-harness-spikes.md`).
 *
 * Differences from the antigravity driver it was cloned from:
 *  - The prompt goes in on STDIN (`< prompt`): a positional prompt reaches
 *    the model wrapped in literal quotes (spike Q2), so it is never in argv.
 *  - There is no terminal event. The exit file (`echo $? > exit`) drives
 *    settle: 0 succeeded (unless an `error` was seen), 130 SIGINT, else failed.
 *  - The inner script starts with `trap 'true' INT` (spike A1/Q16): a v1
 *    client dies from SIGINT and would otherwise take `sh` with it, so no
 *    exit file would ever be written. The trap keeps `sh` alive to record 130.
 *  - Stop is `C-c`, not a kill (D-10): a Shared-mode turn runs inside
 *    OpenCode's background service, which only an interrupted client stops.
 *    Known v1 gap: v1 leaves a running bash-tool child behind on SIGINT
 *    (spike Q14); v2 kills it.
 *  - v1 resume of an unknown session id prints a non-JSON
 *    `Error: Session not found` and exits 1 (spike Q4/A5); the driver
 *    relaunches once with `freshArgv` (D-9).
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * Paths (derivable from runId alone, so reattach can recompute them).
 * ────────────────────────────────────────────────────────────────────────── */

const OPENCODE_LOG_DIR = path.join(dataDir, "opencode-logs");

export function opencodeLogPath(runId: string): string {
  return path.join(OPENCODE_LOG_DIR, `${runId}.jsonl`);
}
export function opencodePromptPath(runId: string): string {
  return path.join(OPENCODE_LOG_DIR, `${runId}.prompt`);
}
export function opencodeExitPath(runId: string): string {
  return path.join(OPENCODE_LOG_DIR, `${runId}.exit`);
}
function ensureLogDir(): void {
  if (!existsSync(OPENCODE_LOG_DIR)) mkdirSync(OPENCODE_LOG_DIR, { recursive: true });
}

export function readOpencodeExitCode(runId: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(opencodeExitPath(runId), "utf8").trim();
  } catch {
    return null;
  }
  if (!/^-?\d+$/.test(raw)) return null;
  const code = Number.parseInt(raw, 10);
  return Number.isFinite(code) ? code : null;
}

/** The tmux session name a task's OpenCode turns run in — the same
 *  `agetor-<id>` naming every other driver uses. */
export function opencodeSessionNameFor(taskId: string): string {
  return sessionNameFor(taskId);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Event mapping (`opencode run --format json` line → agetor RunEvent chunks).
 * Pure; reads both OpenCode lines (field paths: spike §2a).
 * ────────────────────────────────────────────────────────────────────────── */

export interface OpencodeSubagentNotice {
  childSessionId: string;
  description: string | null;
  agentType: string | null;
  toolUseId: string;
  background: boolean;
}

export interface OpencodeLineResult {
  failed: boolean;
  lastError: string | null;
  sessionId: string | null;
  resumeNotFound: boolean;
}

export interface OpencodeChunk {
  stream: RunEventStream;
  data: string;
  lineUuid?: string;
}

/** Running token/cost totals for one run (one turn). */
export interface OpencodeUsageTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** Mutable per-turn state the mapper accumulates across lines. */
export interface OpencodeMapCtx {
  major: 1 | 2;
  sessionId: string | null;
  usage: OpencodeUsageTotals;
  stepStarts: number;
  stepFinishes: number;
  failed: boolean;
  lastError: string | null;
  resumeNotFound: boolean;
  /** Set right after a non-JSON `Error: Unexpected error` line: v1 prints
   *  the real reason on the next non-blank line (live W4 smoke). */
  awaitingErrorDetail: boolean;
}

export function createOpencodeMapCtx(major: 1 | 2): OpencodeMapCtx {
  return {
    major,
    sessionId: null,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    stepStarts: 0,
    stepFinishes: 0,
    failed: false,
    lastError: null,
    resumeNotFound: false,
    awaitingErrorDetail: false,
  };
}

export interface OpencodeMapResult {
  chunks: OpencodeChunk[];
  sessionId?: string;
  subagent?: OpencodeSubagentNotice;
  failed?: boolean;
  resumeNotFound?: boolean;
}

/** Line type the driver itself appends to the log before the D-9 fresh
 *  relaunch. Both attempts share one log (appended, never truncated), so a
 *  reattach replay from offset 0 keeps every line index — and so every
 *  `opencode:error:<lineIndex>` uuid — stable; the marker resets the
 *  per-attempt failure state so attempt 1's error can't fail attempt 2. */
export const OPENCODE_ATTEMPT_MARKER_TYPE = "agetor_attempt";

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** OpenCode's own failure line once ANSI is stripped (spike §2b). */
const ERROR_LINE_RE = /^Error:\s*(.+)$/;
/** v1's generic wrapper for an unhandled failure; the cause follows on the
 *  next non-blank stderr line, e.g. `Error: Unexpected error` then `Database
 *  is not empty and has no session table` (a v2-created `opencode.db` in the
 *  same data dir — live W4 smoke). */
const GENERIC_ERROR_MSG_RE = /^Unexpected error\.?$/i;
/** v1 resume of an unknown id (spike §2b, A5). No id in the text. */
const RESUME_NOT_FOUND_RE = /^Error:\s*Session not found\s*$/;
/** Same message once it arrived as a JSON `error` event's text. */
const RESUME_NOT_FOUND_MSG_RE = /^Session not found\s*$/;

type Rec = Record<string, unknown>;
function isRec(v: unknown): v is Rec {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** `5h 3m` / `42s` for a `retryAfterMs` hint (v2 `provider.free-limit`). */
export function formatRetryAfter(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

/** The text of an `error` event: v2 `{type, message, retryAfterMs?}`, v1
 *  `{name, data:{message}}` (spike §2a, A4f). */
export function opencodeErrorMessage(err: unknown): string {
  if (typeof err === "string") return err || "OpenCode error";
  if (!isRec(err)) return "OpenCode error";
  const data = isRec(err.data) ? err.data : null;
  const msg = str(err.message) ?? (data ? str(data.message) : null) ?? str(err.name) ?? str(err.type) ?? "OpenCode error";
  const retry = num(err.retryAfterMs);
  return retry > 0 ? `${msg} (retry after ${formatRetryAfter(retry)})` : msg;
}

/**
 * `todowrite` input → the `TodoWrite` shape the TODO tracker reads
 * (`src/shared/todo-progress.ts`): `{content, status}` only — v1's
 * `priority` is dropped, and `cancelled` reads as `completed` so a plan
 * with a dropped item still finishes (plan Q12, spike A4e).
 */
export function normalizeOpencodeTodos(input: unknown): { todos: Array<{ content: string; status: string }> } {
  const raw = isRec(input) && Array.isArray(input.todos) ? input.todos : [];
  const todos: Array<{ content: string; status: string }> = [];
  for (const t of raw) {
    if (!isRec(t) || t.content == null) continue;
    const status = typeof t.status === "string" ? (t.status === "cancelled" ? "completed" : t.status) : "pending";
    todos.push({ content: String(t.content), status });
  }
  return { todos };
}

/** Tool name + input as agetor renders them: OpenCode's `todowrite` is
 *  surfaced as `TodoWrite` so the TODO tracker and board badge light up. */
export function normalizeOpencodeTool(tool: string, input: unknown): { name: string; input: unknown } {
  if (tool === "todowrite") return { name: "TodoWrite", input: normalizeOpencodeTodos(input) };
  return { name: tool, input: input ?? {} };
}

const V2_SUBAGENT_TEXT_RE = /sessionID[=:]\s*"?(ses_[A-Za-z0-9]+)/;
const V1_SUBAGENT_TEXT_RE = /<task id="(ses_[A-Za-z0-9]+)"/;

/**
 * A `subagent` (v2) / `task` (v1) tool call that names a child session
 * (spike Q12, A4d). The child id is read from the structured metadata
 * first — v2 run `state.metadata.metadata.sessionID`, v2 export
 * `state.metadata.sessionID`, v1 `state.metadata.sessionId` — then from
 * the output/error text. `null` for any other tool or when no id is found.
 */
export function detectOpencodeSubagent(
  tool: string,
  input: unknown,
  state: Rec,
  toolUseId: string,
  extraText: string = "",
): OpencodeSubagentNotice | null {
  if (tool !== "subagent" && tool !== "task") return null;
  const md = isRec(state.metadata) ? state.metadata : {};
  const inner = isRec(md.metadata) ? md.metadata : {};
  let child = str(inner.sessionID) ?? str(md.sessionID) ?? str(md.sessionId);
  if (!child) {
    const errText = typeof state.error === "string" ? state.error : isRec(state.error) ? str(state.error.message) ?? "" : "";
    const text = `${typeof state.output === "string" ? state.output : ""}\n${errText}\n${extraText}`;
    child = V2_SUBAGENT_TEXT_RE.exec(text)?.[1] ?? V1_SUBAGENT_TEXT_RE.exec(text)?.[1] ?? null;
  }
  if (!child) return null;
  const inp = isRec(input) ? input : {};
  return {
    childSessionId: child,
    description: str(inp.description),
    agentType: str(inp.agent) ?? str(inp.subagent_type),
    toolUseId,
    background: inp.background === true || inner.status === "running" || md.background === true,
  };
}

/**
 * The shared part → chunk rules (D-8, spike §2a), used by the live mapper
 * below and by the v1 export adapter (`opencode-export.ts` — v1 export
 * parts have the run shape; v2 export content needs its own adapter, A7).
 * Handles `text`, `reasoning` and terminal `tool` parts; step parts and
 * unknown types produce nothing.
 */
export function mapOpencodePart(part: unknown): { chunks: OpencodeChunk[]; subagent?: OpencodeSubagentNotice } {
  if (!isRec(part)) return { chunks: [] };
  const id = str(part.id);
  switch (part.type) {
    case "text": {
      const text = typeof part.text === "string" ? part.text : "";
      if (!id || text === "") return { chunks: [] };
      return { chunks: [{ stream: "assistant", data: text, lineUuid: `opencode:text:${id}` }] };
    }
    case "reasoning": {
      const text = typeof part.text === "string" ? part.text : "";
      if (!id || text === "") return { chunks: [] };
      return { chunks: [{ stream: "thinking", data: text, lineUuid: `opencode:reasoning:${id}` }] };
    }
    case "tool": {
      const state = isRec(part.state) ? part.state : null;
      if (!state) return { chunks: [] };
      const status = state.status;
      if (status !== "completed" && status !== "error") return { chunks: [] };
      // v2: `partID` = prt_…, `id` = provider call id. v1: `id` = prt_…,
      // `callID` = call id (spike Q3a, A4a).
      const partKey = str(part.partID) ?? id;
      const toolUseId = str(part.callID) ?? id;
      if (!partKey || !toolUseId) return { chunks: [] };
      const tool = str(part.tool) ?? "tool";
      const mapped = normalizeOpencodeTool(tool, state.input);
      const rawTitle = str(state.title);
      const title = rawTitle && rawTitle !== tool && rawTitle !== mapped.name ? rawTitle : undefined;
      const output = typeof state.output === "string" ? state.output : null;
      const err = typeof state.error === "string" ? state.error : isRec(state.error) ? str(state.error.message) : null;
      const content = output ?? err ?? "";
      const chunks: OpencodeChunk[] = [
        {
          stream: "tool_use",
          data: JSON.stringify({ id: toolUseId, name: mapped.name, input: mapped.input, serverSide: false, title }),
          lineUuid: `opencode:tool:${partKey}:use`,
        },
        {
          stream: "tool_result",
          data: JSON.stringify({ toolUseId, content, isError: status === "error" }),
          lineUuid: `opencode:tool:${partKey}:result`,
        },
      ];
      const subagent = detectOpencodeSubagent(tool, state.input, state, toolUseId) ?? undefined;
      return subagent ? { chunks, subagent } : { chunks };
    }
    default:
      return { chunks: [] };
  }
}

/** The usage chip's sentinel body for running totals. */
export function opencodeUsagePayload(u: OpencodeUsageTotals): FxUsagePayload {
  return {
    turn: {
      inputTokens: u.input,
      outputTokens: u.output,
      reasoningTokens: u.reasoning,
      cacheReadTokens: u.cacheRead,
      cacheWriteTokens: u.cacheWrite,
    },
    cost: { amount: u.cost, currency: "USD" },
  };
}

function addTokens(u: OpencodeUsageTotals, tokens: unknown, cost: unknown): void {
  if (isRec(tokens)) {
    u.input += num(tokens.input);
    u.output += num(tokens.output);
    u.reasoning += num(tokens.reasoning);
    const cache = isRec(tokens.cache) ? tokens.cache : {};
    u.cacheRead += num(cache.read);
    u.cacheWrite += num(cache.write);
  }
  u.cost += num(cost);
}
export { addTokens as addOpencodeTokens };

/**
 * Map one raw log line (D-8 table, amended by A4). Non-JSON lines are
 * skipped, except an ANSI-stripped `Error: …` line, which is OpenCode's
 * failure message (v1 pre-session errors and v1 resume-not-found, A4g).
 */
export function mapOpencodeEvent(line: string, ctx: OpencodeMapCtx, lineIndex: number): OpencodeMapResult {
  const trimmed = line.trim();
  if (!trimmed) return { chunks: [] };
  let evt: unknown;
  try {
    evt = JSON.parse(trimmed);
  } catch {
    evt = undefined;
  }
  if (!isRec(evt)) {
    const stripped = stripAnsi(trimmed).trim();
    const m = ERROR_LINE_RE.exec(stripped);
    if (!m) {
      if (!ctx.awaitingErrorDetail || !stripped) return { chunks: [] };
      ctx.awaitingErrorDetail = false;
      ctx.lastError = `${ctx.lastError ?? "Unexpected error"}: ${stripped}`;
      return { chunks: [{ stream: "status", data: `opencode: ${stripped}`, lineUuid: `opencode:error:${lineIndex}` }] };
    }
    const msg = m[1]!.trim();
    ctx.failed = true;
    ctx.lastError = msg;
    ctx.awaitingErrorDetail = GENERIC_ERROR_MSG_RE.test(msg);
    const res: OpencodeMapResult = {
      chunks: [{ stream: "status", data: `opencode: ${msg}`, lineUuid: `opencode:error:${lineIndex}` }],
      failed: true,
    };
    if (RESUME_NOT_FOUND_RE.test(stripped) && !ctx.sessionId) {
      ctx.resumeNotFound = true;
      res.resumeNotFound = true;
    }
    return res;
  }

  ctx.awaitingErrorDetail = false;
  const type = evt.type;
  if (type === OPENCODE_ATTEMPT_MARKER_TYPE) {
    ctx.failed = false;
    ctx.lastError = null;
    ctx.resumeNotFound = false;
    return { chunks: [] };
  }

  const res: OpencodeMapResult = { chunks: [] };
  const sid = str(evt.sessionID);
  if (sid && !ctx.sessionId) {
    ctx.sessionId = sid;
    res.sessionId = sid;
  }

  switch (type) {
    case "step_start":
      ctx.stepStarts++;
      return res;
    case "text":
    case "reasoning":
    case "tool_use": {
      const mapped = mapOpencodePart(evt.part);
      res.chunks = mapped.chunks;
      if (mapped.subagent) res.subagent = mapped.subagent;
      return res;
    }
    case "step_finish": {
      ctx.stepFinishes++;
      const part = isRec(evt.part) ? evt.part : {};
      addTokens(ctx.usage, part.tokens, part.cost);
      const key = str(part.id) ?? String(lineIndex);
      res.chunks = [{
        stream: "status",
        data: FX_USAGE_STATUS_PREFIX + JSON.stringify(opencodeUsagePayload(ctx.usage)),
        lineUuid: `opencode:usage:${key}`,
      }];
      return res;
    }
    case "error": {
      const msg = opencodeErrorMessage(evt.error);
      ctx.failed = true;
      ctx.lastError = msg;
      res.failed = true;
      res.chunks = [{ stream: "status", data: `opencode: ${msg}`, lineUuid: `opencode:error:${lineIndex}` }];
      if (RESUME_NOT_FOUND_MSG_RE.test(msg) && !ctx.sessionId) {
        ctx.resumeNotFound = true;
        res.resumeNotFound = true;
      }
      return res;
    }
    default:
      return res;
  }
}

/** One processor per turn; used by the real tailer AND the fake driver so
 *  both go through `mapOpencodeEvent`. Dedupes by line uuid (reattach replay
 *  from offset 0), reports the session id once, each child session once. */
export function createOpencodeLineProcessor(opts: {
  onChunk: ChunkHandler;
  onSessionId?: (id: string) => void;
  onSubagent?: (n: OpencodeSubagentNotice) => void;
  seenLineUuids?: Set<string>;
  major: 1 | 2;
}): {
  feed(line: string): void;
  result(): OpencodeLineResult;
  /** Step counts and running usage — the driver's v2 usage reconciliation reads them. */
  stats(): { stepStarts: number; stepFinishes: number; usage: OpencodeUsageTotals };
} {
  const ctx = createOpencodeMapCtx(opts.major);
  const seen = opts.seenLineUuids ?? new Set<string>();
  const notified = new Set<string>();
  let lineIndex = 0;
  let sessionSent = false;
  return {
    feed(line: string): void {
      if (!line.trim()) return;
      const res = mapOpencodeEvent(line, ctx, lineIndex++);
      for (const c of res.chunks) {
        if (c.lineUuid) {
          if (seen.has(c.lineUuid)) continue;
          seen.add(c.lineUuid);
        }
        opts.onChunk(c.stream, c.data, c.lineUuid);
      }
      if (res.sessionId && !sessionSent) {
        sessionSent = true;
        try { opts.onSessionId?.(res.sessionId); } catch { /* noop */ }
      }
      if (res.subagent && !notified.has(res.subagent.childSessionId)) {
        notified.add(res.subagent.childSessionId);
        try { opts.onSubagent?.(res.subagent); } catch (e) {
          console.error("[opencode-tmux] onSubagent failed:", e);
        }
      }
    },
    result(): OpencodeLineResult {
      return { failed: ctx.failed, lastError: ctx.lastError, sessionId: ctx.sessionId, resumeNotFound: ctx.resumeNotFound };
    },
    stats() {
      return { stepStarts: ctx.stepStarts, stepFinishes: ctx.stepFinishes, usage: { ...ctx.usage } };
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Session state + tailer.
 * ────────────────────────────────────────────────────────────────────────── */

export interface OpencodeLaunchOptions {
  taskId: string;
  runId: string;
  argv: string[];
  /** same argv without -s, plus --title; used once for the v1 resume-not-found retry (D-9/A5) */
  freshArgv?: string[] | null;
  env: Record<string, string>;
  cwd: string;
  promptText: string;
  major: 1 | 2;
  onChunk: ChunkHandler;
  onSessionId?: (id: string) => void;
  onSubagent?: (n: OpencodeSubagentNotice) => void;
  /** awaited before `done` resolves (D-11 turn-end subagent refresh) */
  beforeSettle?: (info: { code: number; sessionId: string | null }) => Promise<void>;
}

interface LaunchInfo {
  argv: string[];
  freshArgv: string[] | null;
  env: Record<string, string>;
  cwd: string;
}

interface OpencodeSessionState {
  taskId: string;
  runId: string;
  sessionName: string;
  logPath: string;
  offset: number;
  decoder: StringDecoder;
  partial: string;
  proc: ReturnType<typeof createOpencodeLineProcessor>;
  seen: Set<string>;
  onChunk: ChunkHandler;
  major: 1 | 2;
  /** null on reattach: no argv, so no fresh retry and no usage reconcile. */
  launch: LaunchInfo | null;
  retried: boolean;
  /** Set by Stop/interrupt/drop: a dead pane then reads as cancelled, not died. */
  cancelled: boolean;
  dropped: boolean;
  settling: boolean;
  resolved: boolean;
  watcher: FSWatcher | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  deathTimer: ReturnType<typeof setInterval> | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  beforeSettle?: OpencodeLaunchOptions["beforeSettle"];
  resolveDone: (code: number) => void;
}

const opencodeSessions = new Map<string, OpencodeSessionState>(); // taskId -> state

const POLL_MS = 150;
const DEATH_POLL_MS = 400;
const DEATH_GRACE_MS = 250;
const DROP_POLL_MS = 100;
/** Stop sends `C-c`; a client that still hasn't exited after this long is
 *  killed outright so Stop can never leave a run `running`. */
let stopEscalateMs = 10_000;
/** Upper bound on `beforeSettle` (the subagent export refresh) — a wedged
 *  export can delay settle, never hang it. */
let beforeSettleTimeoutMs = 120_000;
/** Bound on the v2 missing-`step_finish` usage reconciliation export. */
const RECONCILE_EXPORT_TIMEOUT_MS = 10_000;

/** One-shot tmux command on agetor's socket. Never throws. */
async function tmuxRun(args: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn([resolveTmuxBin(), ...tmuxSocketArgs(), ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: tmuxClientEnv(),
    });
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/** `C-c` into the session's pane. The target is `=<name>:` — tmux 3.6a
 *  rejects a bare `=<name>` pane target ("can't find pane") but accepts the
 *  exact-match session with an explicit (current) window. */
function sendCtrlC(sessionName: string): Promise<boolean> {
  return tmuxRun(["send-keys", "-t", `=${sessionName}:`, "C-c"]);
}

function emitOwn(state: OpencodeSessionState, stream: RunEventStream, data: string, lineUuid?: string): void {
  if (lineUuid) {
    if (state.seen.has(lineUuid)) return;
    state.seen.add(lineUuid);
  }
  state.onChunk(stream, data, lineUuid);
}

function stopWatchers(state: OpencodeSessionState): void {
  if (state.watcher) { try { state.watcher.close(); } catch { /* noop */ } state.watcher = null; }
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  if (state.deathTimer) { clearInterval(state.deathTimer); state.deathTimer = null; }
}

function clearStopTimer(state: OpencodeSessionState): void {
  if (state.stopTimer) { clearTimeout(state.stopTimer); state.stopTimer = null; }
}

function flushOpencodeLog(state: OpencodeSessionState, final = false): void {
  let fd: number | null = null;
  try {
    const st = fsStatSync(state.logPath);
    if (st.size > state.offset) fd = fsOpenSync(state.logPath, "r");
  } catch {
    fd = null;
  }
  let text = "";
  if (fd !== null) {
    try {
      const buf = Buffer.alloc(64 * 1024);
      let bytesRead: number;
      while ((bytesRead = fsReadSync(fd, buf, 0, buf.length, state.offset)) > 0) {
        state.offset += bytesRead;
        text += state.decoder.write(buf.subarray(0, bytesRead));
      }
    } catch {
      /* partial read — next flush resumes from the offset */
    } finally {
      try { fsCloseSync(fd); } catch { /* noop */ }
    }
  }
  const combined = state.partial + text;
  const lines = combined.split("\n");
  state.partial = lines.pop() ?? "";
  // At settle the process is gone: a last line without "\n" is complete.
  if (final && state.partial) {
    lines.push(state.partial);
    state.partial = "";
  }
  for (const line of lines) state.proc.feed(line);
}

function startWatchers(state: OpencodeSessionState): void {
  try {
    state.watcher = fsWatch(state.logPath, () => flushOpencodeLog(state));
  } catch {
    // transient watch error — the poll covers it
  }

  state.pollTimer = setInterval(() => {
    if (state.settling || state.resolved) return;
    flushOpencodeLog(state);
    const code = readOpencodeExitCode(state.runId);
    if (code !== null) void settle(state, code);
  }, POLL_MS);

  const probe = createDeathProbe({
    sessionName: state.sessionName,
    authoritative: sessionLiveness,
    resolvePid: panePidFor,
  });
  let misses = 0;
  let tickInFlight = false;
  state.deathTimer = setInterval(() => {
    if (tickInFlight || state.settling || state.resolved) return;
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
        if (state.deathTimer) { clearInterval(state.deathTimer); state.deathTimer = null; }
        setTimeout(() => {
          if (state.settling || state.resolved) return;
          const code = readOpencodeExitCode(state.runId);
          if (code !== null) { void settle(state, code); return; }
          // No exit file: the shell itself was killed. A Stop/drop in flight
          // reads as cancelled (A1); anything else is an unexpected death.
          if (state.cancelled) { void settle(state, 130); return; }
          emitOwn(
            state,
            "status",
            `${SESSION_DIED_STATUS_PREFIX}tmux session ${state.sessionName} ended unexpectedly — task blocked`,
          );
          void settle(state, 1);
        }, DEATH_GRACE_MS);
      } catch {
        /* never crash the watch */
      } finally {
        tickInFlight = false;
      }
    })();
  }, DEATH_POLL_MS);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The inner `sh -c` script (A1). The log is appended (`>>`) because the
 *  D-9 relaunch writes into the same log — the driver truncates it once
 *  before the first attempt. */
export function opencodeInnerScript(runId: string): string {
  return `trap 'true' INT; "$@" < ${shellQuote(opencodePromptPath(runId))} >> ${shellQuote(opencodeLogPath(runId))} 2>&1; echo $? > ${shellQuote(opencodeExitPath(runId))}`;
}

async function launchTmux(
  state: OpencodeSessionState,
  launch: LaunchInfo,
  argv: string[],
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const tmux = resolveTmuxBin();
  const envArgs: string[] = [];
  if (process.env.PATH) envArgs.push("-e", `PATH=${process.env.PATH}`);
  for (const [k, v] of Object.entries(launch.env)) envArgs.push("-e", `${k}=${v}`);
  const args = [
    ...tmuxSocketArgs(),
    "new-session", "-d", "-s", state.sessionName,
    "-x", "200", "-y", "50",
    "-c", launch.cwd,
    ...envArgs,
    "--", "sh", "-c", opencodeInnerScript(state.runId), "sh", ...argv,
  ];
  const res = await spawnTmuxNewSession(tmux, args);
  if (res.status === 0) return { ok: true };
  return { ok: false, detail: (res.stderr || "tmux new-session failed").trim() };
}

function resumeIdFrom(argv: string[]): string {
  const i = argv.indexOf("-s");
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : "";
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); console.error("[opencode-tmux] settle hook failed:", e); resolve(undefined); },
    );
  });
}

/**
 * v2 often drops a turn's final `step_finish` (spike Q3b: 7 of 10 runs), so
 * the chip would under-count the last step. When a v2 turn exits 0 with
 * fewer `step_finish` than `step_start` lines, re-read the turn's usage from
 * `session export` (sum over the assistant messages after the last user
 * message, A4c) and emit it as the run's final usage sentinel. Done here in
 * the driver — it already knows the bin, env, cwd, server mode and session
 * id of the turn it launched; a reattached turn (no launch record) skips it.
 */
async function reconcileUsage(state: OpencodeSessionState, argv: string[]): Promise<void> {
  const launch = state.launch;
  const sessionId = state.proc.result().sessionId;
  if (!launch || !sessionId || state.major !== 2) return;
  const stats = state.proc.stats();
  if (stats.stepFinishes >= stats.stepStarts) return;
  const { runOpencodeExport, exportTurnUsage } = await import("./opencode-export.ts");
  const exp = await runOpencodeExport({
    sessionId,
    bin: argv[0] ?? "opencode",
    env: launch.env,
    cwd: launch.cwd,
    major: 2,
    standalone: argv.includes("--standalone"),
    timeoutMs: RECONCILE_EXPORT_TIMEOUT_MS,
  });
  if (!exp) return;
  const usage = exportTurnUsage(exp);
  if (!usage) return;
  const s = stats.usage;
  if (usage.input === s.input && usage.output === s.output && usage.reasoning === s.reasoning
    && usage.cacheRead === s.cacheRead && usage.cacheWrite === s.cacheWrite && usage.cost === s.cost) return;
  emitOwn(state, "status", FX_USAGE_STATUS_PREFIX + JSON.stringify(opencodeUsagePayload(usage)), "opencode:usage:reconciled");
}

function finishResolve(state: OpencodeSessionState, code: number): void {
  if (state.resolved) return;
  state.resolved = true;
  stopWatchers(state);
  clearStopTimer(state);
  if (opencodeSessions.get(state.taskId) === state) opencodeSessions.delete(state.taskId);
  state.resolveDone(code);
}

/** Settle on an exit code: the D-9 retry, the final code, usage
 *  reconciliation and `beforeSettle`, then resolve `done`. Idempotent. */
async function settle(state: OpencodeSessionState, exitCode: number): Promise<void> {
  if (state.settling || state.resolved) return;
  state.settling = true;
  stopWatchers(state);
  flushOpencodeLog(state, true);
  const r = state.proc.result();
  const launch = state.launch;

  if (
    exitCode !== 0 && r.resumeNotFound && !state.retried && !state.cancelled && !state.dropped
    && launch?.freshArgv && launch.freshArgv.length > 0
  ) {
    state.retried = true;
    const id8 = resumeIdFrom(launch.argv).slice(0, 8);
    emitOwn(state, "status", `couldn't resume OpenCode session ${id8}… — starting a fresh session`, "opencode:fresh-retry");
    try { appendFileSync(state.logPath, JSON.stringify({ type: OPENCODE_ATTEMPT_MARKER_TYPE, attempt: 2 }) + "\n"); } catch { /* noop */ }
    try { unlinkSync(opencodeExitPath(state.runId)); } catch { /* noop */ }
    await killSessionByName(state.sessionName);
    if (state.resolved) return;
    const res = await launchTmux(state, launch, launch.freshArgv);
    if (state.resolved) return;
    if (res.ok) {
      state.settling = false;
      startWatchers(state);
      return;
    }
    emitOwn(state, "stderr", `failed to start opencode session: ${res.detail}`);
    exitCode = 1;
  }

  let code = exitCode;
  if (code === 0 && r.failed) code = 1;
  if (code !== 0 && !state.cancelled && !state.dropped && !r.lastError) {
    // e.g. an unknown flag: OpenCode prints its help and exits 1 with no
    // `Error:` line (spike Q5) — say why the run failed.
    emitOwn(state, "status", `opencode: exited with code ${code}`, `opencode:exit:${state.retried ? 2 : 1}`);
  }

  if (code === 0 && !state.dropped) {
    const argv = state.retried && launch?.freshArgv ? launch.freshArgv : launch?.argv ?? [];
    await withTimeout(reconcileUsage(state, argv), RECONCILE_EXPORT_TIMEOUT_MS + 2_000);
  }
  if (state.beforeSettle && !state.dropped && !state.resolved) {
    const hook = state.beforeSettle;
    const sessionId = state.proc.result().sessionId;
    await withTimeout(Promise.resolve().then(() => hook({ code, sessionId })), beforeSettleTimeoutMs);
  }
  finishResolve(state, code);
}

function makeState(a: {
  taskId: string;
  runId: string;
  sessionName: string;
  major: 1 | 2;
  onChunk: ChunkHandler;
  onSessionId?: (id: string) => void;
  onSubagent?: (n: OpencodeSubagentNotice) => void;
  seen: Set<string>;
  launch: LaunchInfo | null;
  beforeSettle?: OpencodeLaunchOptions["beforeSettle"];
}): OpencodeSessionState {
  return {
    taskId: a.taskId,
    runId: a.runId,
    sessionName: a.sessionName,
    logPath: opencodeLogPath(a.runId),
    offset: 0,
    decoder: new StringDecoder("utf8"),
    partial: "",
    proc: createOpencodeLineProcessor({
      onChunk: a.onChunk,
      onSessionId: a.onSessionId,
      onSubagent: a.onSubagent,
      seenLineUuids: a.seen,
      major: a.major,
    }),
    seen: a.seen,
    onChunk: a.onChunk,
    major: a.major,
    launch: a.launch,
    retried: false,
    cancelled: false,
    dropped: false,
    settling: false,
    resolved: false,
    watcher: null,
    pollTimer: null,
    deathTimer: null,
    stopTimer: null,
    beforeSettle: a.beforeSettle,
    resolveDone: () => { /* replaced in startTailer */ },
  };
}

function startTailer(state: OpencodeSessionState): Promise<number> {
  return new Promise<number>((resolve) => {
    state.resolveDone = resolve;
    opencodeSessions.set(state.taskId, state);
    flushOpencodeLog(state);
    const code = readOpencodeExitCode(state.runId);
    if (code !== null) { void settle(state, code); return; }
    startWatchers(state);
  });
}

/** Stop: `C-c` the client (D-10). The orchestrator records `cancelled` from
 *  its own handle flag; the code `done` resolves with is the client's exit
 *  (130). If the client is still up after `stopEscalateMs`, kill the session. */
function stopState(state: OpencodeSessionState): void {
  if (state.resolved) return;
  state.cancelled = true;
  void sendCtrlC(state.sessionName);
  if (state.stopTimer) return;
  state.stopTimer = setTimeout(() => {
    state.stopTimer = null;
    if (state.resolved || state.settling) return;
    void (async () => {
      await killSessionByName(state.sessionName);
      flushOpencodeLog(state, true);
      void settle(state, readOpencodeExitCode(state.runId) ?? 130);
    })();
  }, stopEscalateMs);
}

function agentFor(state: OpencodeSessionState, done: Promise<number>): SpawnedAgent {
  return {
    kill: () => stopState(state),
    // `opencode run` takes no input mid-turn; follow-ups are fresh `-s`
    // turns (new run rows) queued by the orchestrator.
    writeInput: () => false,
    done,
  };
}

/** Spawn one OpenCode turn in a detached tmux session and tail its log. */
export async function spawnOpencodeViaTmux(opts: OpencodeLaunchOptions): Promise<SpawnedAgent> {
  ensureLogDir();
  const logPath = opencodeLogPath(opts.runId);
  writeFileSync(opencodePromptPath(opts.runId), opts.promptText);
  writeFileSync(logPath, "");
  try { unlinkSync(opencodeExitPath(opts.runId)); } catch { /* noop */ }

  const sessionName = opencodeSessionNameFor(opts.taskId);
  await killSessionByName(sessionName);

  const launch: LaunchInfo = {
    argv: opts.argv,
    freshArgv: opts.freshArgv ?? null,
    env: opts.env,
    cwd: opts.cwd,
  };
  const state = makeState({
    taskId: opts.taskId,
    runId: opts.runId,
    sessionName,
    major: opts.major,
    onChunk: opts.onChunk,
    onSessionId: opts.onSessionId,
    onSubagent: opts.onSubagent,
    seen: new Set(),
    launch,
    beforeSettle: opts.beforeSettle,
  });

  const res = await launchTmux(state, launch, opts.argv);
  if (!res.ok) {
    // tmux couldn't launch the session — surface why and resolve failed now
    // so the run doesn't hang in `running` until the death watch fires.
    opts.onChunk("stderr", `failed to start opencode session: ${res.detail}`, undefined);
    return { kill: () => { /* nothing to kill */ }, writeInput: () => false, done: Promise.resolve(1) };
  }
  const done = startTailer(state);
  return agentFor(state, done);
}

export interface OpencodeReattachOptions {
  taskId: string;
  runId: string;
  sessionName: string;
  onChunk: ChunkHandler;
  seenLineUuids: Set<string>;
  major: 1 | 2;
  onSubagent?: (n: OpencodeSubagentNotice) => void;
  beforeSettle?: OpencodeLaunchOptions["beforeSettle"];
}

/**
 * Reattach to an OpenCode turn whose tmux session survived an agetor
 * restart: re-tail the log from offset 0 (deduped via `seenLineUuids`) and
 * resolve when the exit file appears. Null when the session is gone.
 */
export async function reattachOpencodeSession(opts: OpencodeReattachOptions): Promise<SpawnedAgent | null> {
  if (!(await sessionExistsByName(opts.sessionName))) return null;
  const state = makeState({
    taskId: opts.taskId,
    runId: opts.runId,
    sessionName: opts.sessionName,
    major: opts.major,
    onChunk: opts.onChunk,
    onSubagent: opts.onSubagent,
    seen: opts.seenLineUuids,
    launch: null,
    beforeSettle: opts.beforeSettle,
  });
  const done = startTailer(state);
  return agentFor(state, done);
}

/** True when a live OpenCode tail is registered for this task. */
export function opencodeSessionActive(taskId: string): boolean {
  return opencodeSessions.has(taskId);
}

/**
 * Tear down a task's OpenCode session (delete / archive / agent switch,
 * D-10): ALWAYS `C-c` first, so a Shared-mode turn inside OpenCode's
 * background service is interrupted rather than left running, then poll
 * `has-session` for up to `graceMs` and kill the session. A live tail is
 * resolved as cancelled without running `beforeSettle`. Never throws.
 */
export async function dropOpencodeSession(taskId: string, opts: { graceMs?: number } = {}): Promise<void> {
  const graceMs = opts.graceMs ?? 5_000;
  const name = opencodeSessionNameFor(taskId);
  const state = opencodeSessions.get(taskId);
  if (state) {
    state.cancelled = true;
    state.dropped = true;
    clearStopTimer(state);
  }
  try {
    if (await sessionExistsByName(name)) {
      await sendCtrlC(name);
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline) {
        if (!(await sessionExistsByName(name))) break;
        await new Promise((r) => setTimeout(r, DROP_POLL_MS));
      }
    }
    await killSessionByName(name);
  } catch {
    /* best-effort */
  }
  if (state && !state.resolved) {
    flushOpencodeLog(state, true);
    finishResolve(state, readOpencodeExitCode(state.runId) ?? 130);
  }
}

/** Stop without a handle (e.g. after a restart): `C-c` only. False when the
 *  session is already gone. */
export async function interruptOpencodeTurn(taskId: string): Promise<boolean> {
  const name = opencodeSessionNameFor(taskId);
  if (!(await sessionExistsByName(name))) return false;
  const state = opencodeSessions.get(taskId);
  if (state) state.cancelled = true;
  return sendCtrlC(name);
}

export const __forTest = {
  setStopEscalateMs(ms: number | null): number {
    const prev = stopEscalateMs;
    stopEscalateMs = ms ?? 10_000;
    return prev;
  },
  setBeforeSettleTimeoutMs(ms: number | null): number {
    const prev = beforeSettleTimeoutMs;
    beforeSettleTimeoutMs = ms ?? 120_000;
    return prev;
  },
};
