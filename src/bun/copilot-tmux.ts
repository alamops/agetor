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
} from "node:fs";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { dataDir } from "./db.ts";
import { resolveTmuxBin, tmuxSocketArgs, spawnTmuxNewSession } from "./tmux-resolution.ts";
import { createDeathProbe } from "./session-liveness.ts";
import { isPlainDirBelow, openReadNoFollow, readTextNoFollow } from "./no-follow.ts";
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
 * Driver that hosts a single `copilot --output-format json` turn (GitHub
 * Copilot CLI) inside a per-task tmux session and exposes structured
 * streaming by tailing the newline-delimited JSON event log Copilot writes
 * to stdout. Structurally a clone of `antigravity-tmux.ts` with three
 * differences (docs/plans/github-copilot-harness.md §3.1):
 *
 *   - the prompt rides on STDIN (`< promptfile`, codex-style), not argv;
 *   - the session id is SELF-ISSUED by agetor (`--session-id <uuid>` creates
 *     or resumes, gemini-style) so there is no id to discover;
 *   - the shell wrapper runs per-pane guards (classic `ghp_` token strip,
 *     `COPILOT_ALLOW_ALL` unset outside Auto) BEFORE exec'ing the binary,
 *     because the tmux server's environment may belong to another process.
 *
 * Settlement: a turn resolves on Copilot's terminal `result` event or on the
 * process exit (exit file), whichever the tailer sees first. Before it
 * resolves the driver waits (≤2 s) for the exit file, emits the usage
 * sentinel, emits the synthetic plan chunk in Plan mode and settles any
 * still-`running` subagent rows (`finalizeCopilotTurn`).
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * Constants.
 * ────────────────────────────────────────────────────────────────────────── */

/** Status line emitted once per run when Copilot reports it isn't logged in. */
export const COPILOT_LOGIN_STATUS_TEXT =
  "GitHub Copilot isn't logged in — run `copilot login` in a terminal (or set COPILOT_GITHUB_TOKEN in this harness's env)";

/** Name of the synthetic plan `tool_use` (`copilotPlanChunk`). */
export const COPILOT_PLAN_TOOL_NAME = "copilot_plan";

/** How long the settle step waits for the exit file after `result`. */
const EXIT_FILE_WAIT_MS = 2000;
const EXIT_FILE_POLL_MS = 50;

/* ────────────────────────────────────────────────────────────────────────── *
 * Paths (derivable from runId alone, so reattach can recompute them).
 * ────────────────────────────────────────────────────────────────────────── */

const COPILOT_LOG_DIR = path.join(dataDir, "copilot-logs");

export function copilotLogPath(runId: string): string {
  return path.join(COPILOT_LOG_DIR, `${runId}.jsonl`);
}
export function copilotPromptPath(runId: string): string {
  return path.join(COPILOT_LOG_DIR, `${runId}.prompt.txt`);
}
export function copilotExitPath(runId: string): string {
  return path.join(COPILOT_LOG_DIR, `${runId}.exit`);
}
/** Passed to Copilot as `--usage-output-file`. */
export function copilotUsagePath(runId: string): string {
  return path.join(COPILOT_LOG_DIR, `${runId}.usage.json`);
}
function ensureLogDir(): void {
  if (!existsSync(COPILOT_LOG_DIR)) mkdirSync(COPILOT_LOG_DIR, { recursive: true });
}

export function readCopilotExitCode(runId: string): number | null {
  let raw: string;
  try {
    raw = readTextNoFollow(copilotExitPath(runId)).trim();
  } catch {
    return null;
  }
  if (!/^-?\d+$/.test(raw)) return null;
  const code = Number.parseInt(raw, 10);
  return Number.isFinite(code) ? code : null;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Shell wrapper (pure — unit-tested without tmux).
 * ────────────────────────────────────────────────────────────────────────── */

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function sq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface CopilotShellCommandInput {
  /** The full Copilot argv (binary first). */
  argv: string[];
  promptPath: string;
  logPath: string;
  exitPath: string;
  /**
   * Env var names (`GH_TOKEN`/`GITHUB_TOKEN` minus any the harness env sets)
   * whose value is dropped from the pane when it is a CLASSIC personal access
   * token (`ghp_…`) — Copilot refuses those and they would override the
   * user's keychain login. Evaluated by the pane's own shell, i.e. against
   * the pane's real env, not agetor's. Names must be POSIX identifiers.
   */
  stripClassicTokens: readonly string[];
  /**
   * `unset COPILOT_ALLOW_ALL` in the pane before exec. True for every
   * non-Auto turn whose harness env does not set it: without it an ambient
   * `COPILOT_ALLOW_ALL=true` in the tmux server's env would silently turn
   * Read-only into allow-all. `spawnCopilotViaTmux` computes it with
   * `shouldUnsetAllowAll` (any mode but `auto`, and `COPILOT_ALLOW_ALL` is
   * not in `opts.env`).
   */
  unsetAllowAll: boolean;
}

/**
 * Whether the pane must `unset COPILOT_ALLOW_ALL` before exec'ing copilot.
 * Fail closed: every mode except `auto` gets the guard — not just
 * `plan`/`ask` — because `buildCommand` grants allow-all only for `auto`.
 * A cross-kind `PATCH /tasks/:id` resets the mode (`reconcileTaskSession`),
 * so a foreign mode id (fx's `yolo`) normally never reaches a copilot spawn;
 * this is defense in depth against a write path that bypasses that PATCH, or
 * a Start racing its async reset. A value the harness env sets explicitly
 * always wins.
 */
export function shouldUnsetAllowAll(mode: string | null | undefined, env: Readonly<Record<string, string>>): boolean {
  return mode !== "auto" && !Object.hasOwn(env, "COPILOT_ALLOW_ALL");
}

/**
 * The argv tail handed to `tmux new-session … --`:
 *   `["sh", "-c", <script>, "sh", ...argv]`
 * where `<script>` is
 *   `<guards> "$@" < <prompt> > <log> 2>&1; echo $? > <exit>`
 * argv elements travel as positional parameters (never interpolated into the
 * script); the three paths are single-quoted; the guard variable names are
 * validated identifiers (anything else throws).
 */
export function buildCopilotShellCommand(input: CopilotShellCommandInput): string[] {
  if (input.argv.length === 0) throw new Error("copilot argv is empty");
  const guards: string[] = [];
  for (const name of input.stripClassicTokens) {
    if (!ENV_NAME_RE.test(name)) throw new Error(`invalid env var name for token guard: ${name}`);
    guards.push(`case "\${${name}-}" in ghp_*) unset ${name};; esac;`);
  }
  if (input.unsetAllowAll) guards.push("unset COPILOT_ALLOW_ALL;");
  const script =
    (guards.length > 0 ? guards.join(" ") + " " : "") +
    `"$@" < ${sq(input.promptPath)} > ${sq(input.logPath)} 2>&1; echo $? > ${sq(input.exitPath)}`;
  return ["sh", "-c", script, "sh", ...input.argv];
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Usage file + plan helpers (pure / fs-only).
 * ────────────────────────────────────────────────────────────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

const USAGE_TURN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;

/**
 * Parse the JSON Copilot writes to `--usage-output-file` into the shared
 * usage-sentinel body. Shape (spike, 1.0.104):
 *   `{ modelMetrics: { <model>: { usage: { inputTokens, outputTokens,
 *      cacheReadTokens, cacheWriteTokens, reasoningTokens? }, totalNanoAiu? } },
 *      totalNanoAiu?, aiCreditsStatus?, codeChanges }`
 * Token fields are summed across `modelMetrics` (a turn can span models);
 * a field no model reported is omitted. The `totalNanoAiu` credit figures are
 * deliberately NOT surfaced: the nano-AIU → AI-credits conversion could not be
 * verified against Copilot's own credit display (plan §3.4 / §8 A4), and a
 * wrong number on a billing chip is worse than none. Returns `null` for
 * unparsable text or when no token field is present.
 */
export function parseCopilotUsageFile(text: string): FxUsagePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const sums: Partial<Record<(typeof USAGE_TURN_FIELDS)[number], number>> = {};
  const metrics = parsed.modelMetrics;
  if (isRecord(metrics)) {
    for (const entry of Object.values(metrics)) {
      if (!isRecord(entry)) continue;
      const usage = entry.usage;
      if (isRecord(usage)) {
        for (const field of USAGE_TURN_FIELDS) {
          const n = finiteNumber(usage[field]);
          if (n !== undefined) sums[field] = (sums[field] ?? 0) + n;
        }
      }
    }
  }

  const turn: NonNullable<FxUsagePayload["turn"]> = {};
  for (const field of USAGE_TURN_FIELDS) {
    const n = sums[field];
    if (n !== undefined) turn[field] = n;
  }
  return Object.keys(turn).length > 0 ? { turn } : null;
}

/** The `status` chunk body for a usage payload (`FX_USAGE_STATUS_PREFIX` + JSON). */
export function copilotUsageSentinel(payload: FxUsagePayload): string {
  return FX_USAGE_STATUS_PREFIX + JSON.stringify(payload);
}

/** Read + parse the run's usage file; `null` when missing or unusable. */
export function readCopilotUsagePayload(runId: string): FxUsagePayload | null {
  let text: string;
  try {
    text = readTextNoFollow(copilotUsagePath(runId));
  } catch {
    return null;
  }
  return parseCopilotUsageFile(text);
}

/**
 * `plan.md` Copilot writes in Plan mode:
 * `$COPILOT_HOME/session-state/<sessionId>/plan.md`. Returned only when its
 * mtime is at/after `sinceMs` (this turn wrote it — a stale file from an
 * earlier turn must not resurrect an old plan) and the content is non-blank.
 */
export function readCopilotPlanFile(
  copilotHome: string,
  sessionId: string,
  sinceMs: number,
): string | null {
  if (!sessionId || sessionId.includes("/") || sessionId.includes("\\") || sessionId.includes("..")) {
    return null;
  }
  const file = path.join(copilotHome, "session-state", sessionId, "plan.md");
  try {
    // The session folder and `plan.md` are the agent's to rewrite: refuse a
    // folder chain below the Copilot home that holds a symlink, and open the
    // file itself no-follow, so a link into a protected folder is never read
    // under Agetor's identity (D26).
    if (!isPlainDirBelow(copilotHome, path.dirname(file))) return null;
    const st = fsStatSync(file);
    if (!st.isFile() || st.mtimeMs < sinceMs) return null;
    const content = readTextNoFollow(file);
    return content.trim().length > 0 ? content : null;
  } catch {
    return null;
  }
}

/**
 * The synthetic `tool_use` that carries a Plan-mode turn's plan: Copilot has
 * no plan tool call to anchor a card to, so the driver invents one that the
 * orchestrator's `detectCopilotPlan` (and RunPanel's `PlanCard`
 * substitution) can recognise by `name`.
 */
export function copilotPlanChunk(
  runId: string,
  content: string,
): { stream: "tool_use"; data: string; lineUuid: string } {
  return {
    stream: "tool_use",
    data: JSON.stringify({
      id: `copilot-plan:${runId}`,
      name: COPILOT_PLAN_TOOL_NAME,
      input: { plan: content },
      serverSide: false,
    }),
    lineUuid: `copilot:plan:${runId}`,
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Event mapping (Copilot `--output-format json` line → agetor RunEvent chunks).
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Envelope of one Copilot event line (investigation §2):
 * `{type, data, id, timestamp, parentId, ephemeral?}`. `id` is a uuid and the
 * basis of the line uuid (`copilot:<id>`).
 */
export interface CopilotEvent {
  type?: string;
  data?: Record<string, unknown>;
  id?: string;
  timestamp?: string | number;
  parentId?: string | null;
  ephemeral?: boolean;
}

export interface CopilotChunk {
  stream: RunEventStream;
  data: string;
  lineUuid?: string;
}

/**
 * Where Copilot subagent activity goes. The orchestrator implements it
 * (`makeCopilotSubagentSink`): `started` inserts a `subagents` row,
 * `event` appends a run event attributed to that subagent, `settled` /
 * `settleAll` close rows. Called synchronously from the mapper; every method
 * must be idempotent (reattach replays from offset 0).
 */
export interface CopilotSubagentSink {
  started(info: {
    toolCallId: string;
    name: string;
    description: string;
    agentType?: string;
  }): void;
  event(parentToolCallId: string, stream: RunEventStream, data: string, lineUuid: string): void;
  settled(toolCallId: string, status: "completed" | "failed"): void;
  settleAll(status: "completed" | "failed" | "orphaned"): void;
}

export interface CopilotMapCtx {
  runId: string;
  /** The model id the task asked for (`"auto"` enables the auto-picked line). */
  model: string | null;
  /** The agetor mode id (`auto` / `plan` / `ask`). */
  mode: string | null;
  turnStartedAt: number;
  /** Receives events whose `data.parentToolCallId` is set; absent → dropped. */
  sink?: CopilotSubagentSink;
  /** An `abort` event was seen this turn. */
  aborted: boolean;
  /** Latest `exit_plan_mode.requested` `planContent`. */
  planContent: string | null;
  autoReported: boolean;
  loginReported: boolean;
  /** Distinct retry/effort notice texts already surfaced. */
  noticesSeen: Set<string>;
  /** Parent keys ("" = main stream) with an `assistant.reasoning` since the last message. */
  reasoningSeen: Set<string>;
}

export function createCopilotMapCtx(init: {
  runId: string;
  model: string | null;
  mode: string | null;
  turnStartedAt: number;
  sink?: CopilotSubagentSink;
}): CopilotMapCtx {
  return {
    runId: init.runId,
    model: init.model,
    mode: init.mode,
    turnStartedAt: init.turnStartedAt,
    sink: init.sink,
    aborted: false,
    planContent: null,
    autoReported: false,
    loginReported: false,
    noticesSeen: new Set(),
    reasoningSeen: new Set(),
  };
}

export interface CopilotMapResult {
  /** Main-stream chunks to emit, in order. Subagent chunks went to `ctx.sink`. */
  chunks: CopilotChunk[];
  /** Set on `result`: the turn's exit code (non-zero after an unrequested abort). */
  done?: number;
  /** Set on `result`: Copilot's own session id. */
  sessionId?: string;
}

/** Ephemeral event types the mapper still acts on. */
const EPHEMERAL_HANDLED = new Set(["session.info", "assistant.turn_retry", "exit_plan_mode.requested"]);

const NO_AUTH_RE = /No authentication information found/;
const RETRY_RE = /retry/i;
const EFFORT_NOTICE_RE = /reasoning|effort/i;

function firstString(rec: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = str(rec[k]);
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

function toolResultContent(data: Record<string, unknown>): string {
  const success = data.success !== false;
  const result = data.result;
  const error = data.error;
  const errText = isRecord(error) ? str(error.message) : str(error);
  const resultText = isRecord(result)
    ? (typeof result.content === "string"
        ? result.content
        : typeof result.detailedContent === "string"
          ? result.detailedContent
          : result.content !== undefined
            ? JSON.stringify(result.content)
            : "")
    : typeof result === "string"
      ? result
      : "";
  if (!success) return errText ?? (resultText || "tool failed");
  return resultText;
}

/**
 * Map one raw log line. Pure apart from `ctx` mutation and the `ctx.sink`
 * calls for subagent events. `lineIndex` is the 0-based index among
 * non-empty log lines (stable across an offset-0 reattach replay).
 *
 * Rows (plan §3.1): assistant.message → `assistant` (+ `thinking` fallback
 * from `reasoningText` when no `assistant.reasoning` preceded it);
 * assistant.reasoning → `thinking`; tool.execution_start/complete →
 * `tool_use`/`tool_result` (MCP tools named `<server> · <tool>`); any event
 * with `data.parentToolCallId` → `ctx.sink.event` instead of the main stream;
 * subagent.* → sink; session.error/warning, retry notices, compaction →
 * `status`; exit_plan_mode.requested → stash; abort → flag + status;
 * result → `done`. `user.message`, ephemeral deltas and unknown types are
 * ignored. A non-JSON line → `stderr` (+ the login status once per run on
 * Copilot's "No authentication information found").
 */
export function mapCopilotEvent(line: string, lineIndex: number, ctx: CopilotMapCtx): CopilotMapResult {
  const chunks: CopilotChunk[] = [];
  const text = line.trim();
  if (!text) return { chunks };

  const noteLogin = (haystack: string): void => {
    if (!ctx.loginReported && NO_AUTH_RE.test(haystack)) {
      ctx.loginReported = true;
      chunks.push({ stream: "status", data: COPILOT_LOGIN_STATUS_TEXT, lineUuid: `copilot:login:${ctx.runId}` });
    }
  };

  let evt: unknown;
  try {
    evt = JSON.parse(text);
  } catch {
    evt = undefined;
  }
  if (!isRecord(evt) || typeof evt.type !== "string") {
    chunks.push({ stream: "stderr", data: text, lineUuid: `copilot:raw:${ctx.runId}:${lineIndex}` });
    noteLogin(text);
    return { chunks };
  }

  const type = evt.type;
  const data = isRecord(evt.data) ? evt.data : {};
  // The line-index fallbacks carry the run id: boot reattach seeds the
  // TASK-wide seen-uuid set, so a bare `line:<n>` would collide with the same
  // index of an earlier run of the task and be dropped as already seen.
  const eventId = typeof evt.id === "string" && evt.id ? evt.id : `line:${ctx.runId}:${lineIndex}`;
  const uuid = `copilot:${eventId}`;
  if (evt.ephemeral === true && !EPHEMERAL_HANDLED.has(type)) return { chunks };

  const parent = str(data.parentToolCallId) ?? str(evt.parentToolCallId);
  const out = (stream: RunEventStream, payload: string, lineUuid: string): void => {
    if (parent) ctx.sink?.event(parent, stream, payload, lineUuid);
    else chunks.push({ stream, data: payload, lineUuid });
  };
  /** Status lines belong to the main stream only. */
  const status = (message: string, lineUuid: string): void => {
    if (!parent) chunks.push({ stream: "status", data: message, lineUuid });
  };

  switch (type) {
    case "assistant.reasoning": {
      const content = typeof data.content === "string" ? data.content : "";
      ctx.reasoningSeen.add(parent ?? "");
      if (content.trim()) out("thinking", content, uuid);
      return { chunks };
    }

    case "assistant.message": {
      const key = parent ?? "";
      const sawReasoning = ctx.reasoningSeen.delete(key);
      const model = str(data.model);
      if (!parent && model && ctx.model === "auto" && !ctx.autoReported) {
        ctx.autoReported = true;
        status(`GitHub Copilot auto picked ${model}`, `${uuid}:model`);
      }
      const reasoningText = typeof data.reasoningText === "string" ? data.reasoningText : "";
      if (!sawReasoning && reasoningText.trim()) out("thinking", reasoningText, `${uuid}:thinking`);
      const content = typeof data.content === "string" ? data.content : "";
      if (content.trim()) out("assistant", content, uuid);
      return { chunks };
    }

    case "tool.execution_start": {
      const toolCallId = str(data.toolCallId);
      if (!toolCallId) return { chunks };
      const toolName = str(data.toolName) ?? "tool";
      const server = str(data.mcpServerName);
      const mcpTool = str(data.mcpToolName);
      const name = server ? `${server} · ${mcpTool ?? toolName}` : toolName;
      out(
        "tool_use",
        JSON.stringify({
          id: toolCallId,
          name,
          input: data.arguments ?? {},
          serverSide: false,
        }),
        uuid,
      );
      return { chunks };
    }

    case "tool.execution_complete": {
      const toolCallId = str(data.toolCallId);
      if (!toolCallId) return { chunks };
      out(
        "tool_result",
        JSON.stringify({
          toolUseId: toolCallId,
          content: toolResultContent(data),
          isError: data.success === false,
        }),
        uuid,
      );
      return { chunks };
    }

    case "subagent.started": {
      const toolCallId = str(data.toolCallId);
      if (!toolCallId) return { chunks };
      const name = str(data.agentDisplayName) ?? str(data.agentName) ?? "subagent";
      ctx.sink?.started({
        toolCallId,
        name,
        description: typeof data.agentDescription === "string" ? data.agentDescription : "",
        agentType: str(data.agentType),
      });
      return { chunks };
    }

    case "subagent.completed": {
      const toolCallId = str(data.toolCallId);
      // A cancelled subagent reads as "failed": the sink has no cancelled state.
      if (toolCallId) ctx.sink?.settled(toolCallId, data.cancelled === true ? "failed" : "completed");
      return { chunks };
    }

    case "subagent.failed": {
      const toolCallId = str(data.toolCallId);
      if (toolCallId) ctx.sink?.settled(toolCallId, "failed");
      return { chunks };
    }

    case "session.error": {
      const message = firstString(data, ["message"]) ?? "session error";
      const remediation = firstString(data, ["remediation"]);
      status(`⚠ GitHub Copilot: ${message}${remediation ? ` — ${remediation}` : ""}`, uuid);
      noteLogin(`${message} ${remediation ?? ""}`);
      return { chunks };
    }

    case "session.warning": {
      const message = firstString(data, ["message"]);
      if (message) status(`⚠ ${message}`, uuid);
      return { chunks };
    }

    case "assistant.turn_retry":
    case "session.info": {
      // A turn_retry carries only a machine `reason` (e.g. "api_error");
      // the paired session.info{infoType:"model_retry"} has the prose.
      const reason = type === "assistant.turn_retry" ? firstString(data, ["reason"]) : undefined;
      const message =
        firstString(data, ["message", "error", "errorMessage"]) ??
        (type === "assistant.turn_retry" ? (reason ? `retrying request (${reason})…` : "retrying request…") : undefined);
      if (!message) return { chunks };
      // session.info is general-purpose: only retry notices and
      // effort/reasoning reports (plan §8 A7) are worth a status line.
      const isRetry = type === "assistant.turn_retry" || RETRY_RE.test(message);
      if (!isRetry && !EFFORT_NOTICE_RE.test(message)) return { chunks };
      const textLine = isRetry ? `↻ GitHub Copilot: ${message}` : `ℹ GitHub Copilot: ${message}`;
      if (ctx.noticesSeen.has(textLine)) return { chunks };
      ctx.noticesSeen.add(textLine);
      status(textLine, uuid);
      return { chunks };
    }

    case "session.compaction_start":
      status("context compacting…", uuid);
      return { chunks };

    case "session.compaction_complete":
      status("context compacted", uuid);
      return { chunks };

    case "exit_plan_mode.requested": {
      const planContent = typeof data.planContent === "string" ? data.planContent : "";
      if (planContent.trim()) ctx.planContent = planContent;
      return { chunks };
    }

    case "abort": {
      ctx.aborted = true;
      status("turn aborted", uuid);
      return { chunks };
    }

    case "result": {
      // Real 1.0.104 output carries `exitCode`/`sessionId` at the top level
      // of the event (no `data`, no `id`); `data` is a defensive fallback.
      const exitCode = finiteNumber(evt.exitCode) ?? finiteNumber(data.exitCode) ?? 0;
      // Copilot answers SIGINT/SIGTERM with abort + result.exitCode 0 + rc 0.
      // agetor's own Stop resolves via kill(); an abort that reaches here
      // came from elsewhere, so it must not read as success.
      const done = ctx.aborted && exitCode === 0 ? 1 : exitCode;
      return { chunks, done, sessionId: str(evt.sessionId) ?? str(data.sessionId) };
    }

    default:
      return { chunks };
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Turn finalisation (shared by the real driver and the fake player).
 * ────────────────────────────────────────────────────────────────────────── */

export interface CopilotFinalizeInput {
  runId: string;
  code: number;
  mode: string | null;
  sessionId: string;
  copilotHome: string;
  turnStartedAt: number;
  ctx: CopilotMapCtx;
  /** Raw text of the usage file, or null when there is none. */
  usageText: string | null;
  emit: ChunkHandler;
  sink?: CopilotSubagentSink;
}

/**
 * The settle-order tail of a turn (plan §3.1), run just BEFORE the turn's
 * `done` promise resolves:
 *   1. the usage sentinel (`copilot:usage:<runId>`), when the usage file
 *      parsed to something;
 *   2. in Plan mode on a successful turn, the plan chunk — the
 *      `exit_plan_mode.requested` `planContent` first, else a `plan.md`
 *      written this turn;
 *   3. `sink.settleAll` (`completed` on code 0, else `orphaned`) so no stray
 *      `running` subagent row holds the task in `running`.
 * Each step is isolated: a throwing emitter/sink never blocks the next one.
 */
export function finalizeCopilotTurn(input: CopilotFinalizeInput): void {
  try {
    const payload = input.usageText === null ? null : parseCopilotUsageFile(input.usageText);
    if (payload) {
      input.emit("status", copilotUsageSentinel(payload), `copilot:usage:${input.runId}`);
    }
  } catch {
    /* usage is best-effort */
  }
  try {
    if (input.mode === "plan" && input.code === 0) {
      const content =
        (input.ctx.planContent && input.ctx.planContent.trim() ? input.ctx.planContent : null) ??
        readCopilotPlanFile(input.copilotHome, input.sessionId, input.turnStartedAt);
      if (content) {
        const chunk = copilotPlanChunk(input.runId, content);
        input.emit(chunk.stream, chunk.data, chunk.lineUuid);
      }
    }
  } catch {
    /* plan detection is best-effort */
  }
  try {
    input.sink?.settleAll(input.code === 0 ? "completed" : "orphaned");
  } catch {
    /* sink failures must not strand the run */
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Session state + tailer.
 * ────────────────────────────────────────────────────────────────────────── */

interface CopilotSessionState {
  taskId: string;
  runId: string;
  sessionName: string;
  logPath: string;
  offset: number;
  decoder: StringDecoder;
  partial: string;
  nextLineIndex: number;
  watcher: FSWatcher | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  deathTimer: ReturnType<typeof setInterval> | null;
  seenLineUuids: Set<string>;
  onChunk: ChunkHandler;
  ctx: CopilotMapCtx;
  sink?: CopilotSubagentSink;
  sessionId: string;
  copilotHome: string;
  mode: string | null;
  turnStartedAt: number;
  resolved: boolean;
  finishing: boolean;
  killed: boolean;
  lastCode: number | null;
  resolveDone: (code: number) => void;
}

const copilotSessions = new Map<string, CopilotSessionState>(); // taskId -> state

const POLL_MS = 150;
const DEATH_POLL_MS = 400;
const DEATH_GRACE_MS = 250;

function disposeCopilotState(state: CopilotSessionState): void {
  if (state.watcher) { try { state.watcher.close(); } catch { /* noop */ } state.watcher = null; }
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  if (state.deathTimer) { clearInterval(state.deathTimer); state.deathTimer = null; }
}

function onChunkDedup(
  state: CopilotSessionState,
  stream: RunEventStream,
  data: string,
  lineUuid?: string,
): void {
  if (lineUuid) {
    if (state.seenLineUuids.has(lineUuid)) return;
    state.seenLineUuids.add(lineUuid);
  }
  state.onChunk(stream, data, lineUuid);
}

/**
 * Wrap the orchestrator's sink so replayed subagent events (reattach reads
 * the log from offset 0) are dropped by the same seeded uuid set the main
 * stream uses. `started`/`settled`/`settleAll` pass through: the sink's
 * implementation is idempotent by contract.
 */
function dedupSink(
  sink: CopilotSubagentSink | undefined,
  seen: Set<string>,
): CopilotSubagentSink | undefined {
  if (!sink) return undefined;
  return {
    started: (info) => sink.started(info),
    event: (parent, stream, data, lineUuid) => {
      if (seen.has(lineUuid)) return;
      seen.add(lineUuid);
      sink.event(parent, stream, data, lineUuid);
    },
    settled: (id, status) => sink.settled(id, status),
    settleAll: (status) => sink.settleAll(status),
  };
}

function flushCopilotLog(state: CopilotSessionState): void {
  let fd: number;
  try {
    const st = fsStatSync(state.logPath);
    if (st.size <= state.offset) return;
    fd = openReadNoFollow(state.logPath);
  } catch {
    return;
  }
  try {
    const buf = Buffer.alloc(64 * 1024);
    let bytesRead: number;
    let text = "";
    while ((bytesRead = fsReadSync(fd, buf, 0, buf.length, state.offset)) > 0) {
      state.offset += bytesRead;
      text += state.decoder.write(buf.subarray(0, bytesRead));
    }
    if (!text) return;
    const combined = state.partial + text;
    const lines = combined.split("\n");
    state.partial = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const lineIndex = state.nextLineIndex++;
      const res = mapCopilotEvent(trimmed, lineIndex, state.ctx);
      for (const chunk of res.chunks) onChunkDedup(state, chunk.stream, chunk.data, chunk.lineUuid);
      if (res.done !== undefined && state.lastCode === null) state.lastCode = res.done;
    }
  } finally {
    try { fsCloseSync(fd); } catch { /* noop */ }
  }
}

function resolveSession(state: CopilotSessionState, code: number): void {
  if (state.resolved) return;
  state.resolved = true;
  disposeCopilotState(state);
  if (copilotSessions.get(state.taskId) === state) copilotSessions.delete(state.taskId);
  state.resolveDone(code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Settle the turn: wait (≤2 s) for the exit file when the run ended via
 * `result`, drain trailing log lines, derive the exit code, run
 * `finalizeCopilotTurn`, then resolve. Idempotent; a concurrent `kill()`
 * wins (it resolves first and this bails).
 */
async function finishCopilotTurn(state: CopilotSessionState, opts: { waitForExit: boolean }): Promise<void> {
  if (state.resolved || state.finishing) return;
  state.finishing = true;
  disposeCopilotState(state);
  try {
    let exit = readCopilotExitCode(state.runId);
    if (opts.waitForExit) {
      const deadline = Date.now() + EXIT_FILE_WAIT_MS;
      while (exit === null && Date.now() < deadline && !state.resolved) {
        await sleep(EXIT_FILE_POLL_MS);
        exit = readCopilotExitCode(state.runId);
      }
    }
    if (state.resolved) return;
    flushCopilotLog(state);
    let code = state.lastCode ?? (exit === null || exit !== 0 ? 1 : 0);
    if (exit !== null && exit !== 0 && code === 0) code = 1;

    let usageText: string | null = null;
    try { usageText = readTextNoFollow(copilotUsagePath(state.runId)); } catch { /* none */ }
    finalizeCopilotTurn({
      runId: state.runId,
      code,
      mode: state.mode,
      sessionId: state.sessionId,
      copilotHome: state.copilotHome,
      turnStartedAt: state.turnStartedAt,
      ctx: state.ctx,
      usageText,
      emit: (stream, data, lineUuid) => onChunkDedup(state, stream, data, lineUuid),
      sink: state.sink,
    });
    resolveSession(state, code);
  } catch {
    resolveSession(state, 1);
  }
}

function startCopilotTailer(state: CopilotSessionState): Promise<number> {
  return new Promise<number>((resolve) => {
    state.resolveDone = resolve;
    copilotSessions.set(state.taskId, state);

    const check = (): void => {
      flushCopilotLog(state);
      if (state.lastCode !== null) {
        void finishCopilotTurn(state, { waitForExit: true });
      } else if (readCopilotExitCode(state.runId) !== null) {
        void finishCopilotTurn(state, { waitForExit: false });
      }
    };

    check();
    if (state.finishing || state.resolved) return;

    try {
      state.watcher = fsWatch(state.logPath, () => flushCopilotLog(state));
    } catch {
      // transient watch error, poll covers it
    }

    state.pollTimer = setInterval(check, POLL_MS);

    const probe = createDeathProbe({
      sessionName: state.sessionName,
      authoritative: sessionLiveness,
      resolvePid: panePidFor,
    });
    let misses = 0;
    let tickInFlight = false;
    state.deathTimer = setInterval(() => {
      if (tickInFlight || state.resolved || state.finishing || state.killed) return;
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
            if (state.resolved || state.finishing || state.killed) return;
            flushCopilotLog(state);
            if (state.lastCode === null && readCopilotExitCode(state.runId) === null) {
              state.onChunk("status", `${SESSION_DIED_STATUS_PREFIX}GitHub Copilot session vanished mid-turn`);
            }
            void finishCopilotTurn(state, { waitForExit: false });
          }, DEATH_GRACE_MS);
        } catch {
          // ignore
        } finally {
          tickInFlight = false;
        }
      })();
    }, DEATH_POLL_MS);
  });
}

async function killCopilotState(state: CopilotSessionState): Promise<void> {
  state.killed = true;
  // Stop the tailer and death watch first: once the session starts vanishing a
  // pending tick would otherwise read it as a mid-turn death (a `session ended`
  // sentinel that blocks the card) or settle the turn with the exit file.
  disposeCopilotState(state);
  try {
    await killSessionByName(state.sessionName);
  } finally {
    try { state.sink?.settleAll("orphaned"); } catch { /* noop */ }
    resolveSession(state, 1);
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Lifecycle.
 * ────────────────────────────────────────────────────────────────────────── */

export interface CopilotLaunchOptions {
  taskId: string;
  runId: string;
  /** Full Copilot argv, binary first (built by `buildCommand`). */
  argv: string[];
  /** Env layered onto the pane (`-e K=V`): COPILOT_HOME pin, harness env, … */
  env: Record<string, string>;
  cwd: string;
  /** Delivered on stdin. */
  promptText: string;
  onChunk: ChunkHandler;
  /** The self-issued `--session-id`; also the plan-file lookup key. */
  sessionId: string;
  /** Resolved `$COPILOT_HOME` (`copilotHome()`), for the plan reader. */
  copilotHome: string;
  /** Agetor mode id (`auto` / `plan` / `ask`). Plan → plan chunk; anything but auto → COPILOT_ALLOW_ALL unset. */
  mode: string | null;
  /** The task's model id (`auto` enables the "auto picked" status line). */
  model: string | null;
  /** See `CopilotShellCommandInput.stripClassicTokens`. */
  stripClassicTokens: readonly string[];
  onSubagent?: CopilotSubagentSink;
  /** Parity with other drivers: called once, right after launch, with `sessionId`. */
  onSessionId?: (id: string) => void;
  seenLineUuids?: Set<string>;
}

export async function spawnCopilotViaTmux(opts: CopilotLaunchOptions): Promise<SpawnedAgent> {
  // Captured BEFORE the launch so a plan.md a fast turn writes immediately is
  // never older than the gate in `readCopilotPlanFile`.
  const turnStartedAt = Date.now();
  ensureLogDir();
  const logPath = copilotLogPath(opts.runId);
  const promptPath = copilotPromptPath(opts.runId);
  const exitPath = copilotExitPath(opts.runId);
  writeFileSync(promptPath, opts.promptText, { mode: 0o600 });
  writeFileSync(logPath, "");
  try { unlinkSync(exitPath); } catch { /* noop */ }
  try { unlinkSync(copilotUsagePath(opts.runId)); } catch { /* noop */ }

  const sessionName = sessionNameFor(opts.taskId);
  await killSessionByName(sessionName);

  const tmux = resolveTmuxBin();
  const shell = buildCopilotShellCommand({
    argv: opts.argv,
    promptPath,
    logPath,
    exitPath,
    stripClassicTokens: opts.stripClassicTokens,
    unsetAllowAll: shouldUnsetAllowAll(opts.mode, opts.env),
  });
  const envArgs: string[] = [];
  if (process.env.PATH) { envArgs.push("-e", `PATH=${process.env.PATH}`); }
  for (const [k, v] of Object.entries(opts.env)) envArgs.push("-e", `${k}=${v}`);

  const args = [
    ...tmuxSocketArgs(),
    "new-session", "-d", "-s", sessionName,
    "-x", "200", "-y", "50",
    "-c", opts.cwd,
    ...envArgs,
    "--", ...shell,
  ];
  const res = await spawnTmuxNewSession(tmux, args);
  if (res.status !== 0) {
    // Never a silent hang: the caller (`spawnAgentOrFail`) records the run
    // failed and returns the task to `ready` on a throw.
    const detail = (res.stderr || "tmux new-session failed").trim();
    throw new Error(`failed to start GitHub Copilot session: ${detail}`);
  }

  const seen = opts.seenLineUuids ?? new Set<string>();
  const sink = dedupSink(opts.onSubagent, seen);
  const state: CopilotSessionState = {
    taskId: opts.taskId,
    runId: opts.runId,
    sessionName,
    logPath,
    offset: 0,
    decoder: new StringDecoder("utf8"),
    partial: "",
    nextLineIndex: 0,
    watcher: null,
    pollTimer: null,
    deathTimer: null,
    seenLineUuids: seen,
    onChunk: opts.onChunk,
    ctx: createCopilotMapCtx({
      runId: opts.runId,
      model: opts.model,
      mode: opts.mode,
      turnStartedAt,
      sink,
    }),
    sink,
    sessionId: opts.sessionId,
    copilotHome: opts.copilotHome,
    mode: opts.mode,
    turnStartedAt,
    resolved: false,
    finishing: false,
    killed: false,
    lastCode: null,
    resolveDone: () => {},
  };

  if (opts.onSessionId) {
    try { opts.onSessionId(opts.sessionId); } catch { /* noop */ }
  }
  const done = startCopilotTailer(state);
  return {
    kill: () => killCopilotState(state),
    writeInput: () => false,
    done,
  };
}

export interface CopilotReattachOptions {
  taskId: string;
  runId: string;
  sessionName: string;
  onChunk: ChunkHandler;
  /** Seeded from `run_events.line_uuid`; the offset-0 replay dedupes against it. */
  seenLineUuids: Set<string>;
  sessionId: string;
  copilotHome: string;
  mode: string | null;
  model: string | null;
  onSubagent?: CopilotSubagentSink;
  /** Plan-file mtime gate; defaults to the run's prompt file mtime. */
  turnStartedAt?: number;
}

export async function reattachCopilotSession(opts: CopilotReattachOptions): Promise<SpawnedAgent | null> {
  if (!(await sessionExistsByName(opts.sessionName))) return null;
  let turnStartedAt = opts.turnStartedAt;
  if (turnStartedAt === undefined) {
    try { turnStartedAt = fsStatSync(copilotPromptPath(opts.runId)).mtimeMs; } catch { turnStartedAt = Date.now(); }
  }
  const sink = dedupSink(opts.onSubagent, opts.seenLineUuids);
  const state: CopilotSessionState = {
    taskId: opts.taskId,
    runId: opts.runId,
    sessionName: opts.sessionName,
    logPath: copilotLogPath(opts.runId),
    offset: 0,
    decoder: new StringDecoder("utf8"),
    partial: "",
    nextLineIndex: 0,
    watcher: null,
    pollTimer: null,
    deathTimer: null,
    seenLineUuids: opts.seenLineUuids,
    onChunk: opts.onChunk,
    ctx: createCopilotMapCtx({
      runId: opts.runId,
      model: opts.model,
      mode: opts.mode,
      turnStartedAt,
      sink,
    }),
    sink,
    sessionId: opts.sessionId,
    copilotHome: opts.copilotHome,
    mode: opts.mode,
    turnStartedAt,
    resolved: false,
    finishing: false,
    killed: false,
    lastCode: null,
    resolveDone: () => {},
  };
  const done = startCopilotTailer(state);
  return {
    kill: () => killCopilotState(state),
    writeInput: () => false,
    done,
  };
}

export function copilotSessionActive(taskId: string): boolean {
  return copilotSessions.has(taskId);
}

export async function dropCopilotSession(taskId: string): Promise<void> {
  const state = copilotSessions.get(taskId);
  if (state) {
    await killCopilotState(state);
  } else {
    await killSessionByName(sessionNameFor(taskId));
  }
}
