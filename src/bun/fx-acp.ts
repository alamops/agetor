import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Subprocess } from "bun";
import type { RunEventStream } from "../shared/types.ts";
import { SESSION_DIED_STATUS_PREFIX } from "../shared/types.ts";
// `ChunkHandler` / `SpawnedAgent` are generic driver-infra types (not part of
// the fx-specific surface a sibling task is adding to shared/types.ts), so
// importing them from claude-tmux.ts — the same seam cursor-tmux.ts and
// gemini-tmux.ts already import from — is safe and keeps the three drivers'
// call sites structurally identical for the orchestrator wiring that lands
// later. Nothing fx-specific is imported from shared/types.ts.
import type { ChunkHandler, SpawnedAgent } from "./claude-tmux.ts";

/**
 * Driver for the `fx` agent kind — Vercel Labs' fx coding agent, driven via
 * `fx acp`, an Agent Client Protocol (ACP) server speaking newline-delimited
 * JSON-RPC 2.0 over stdio.
 *
 * ── Architecture, and how this differs from every other driver in this repo ──
 *
 * claude-tmux.ts / codex-tmux.ts / cursor-tmux.ts / gemini-tmux.ts all host
 * their CLI inside a *detached tmux session* and observe it indirectly: by
 * tailing a JSONL/NDJSON log file the CLI writes to disk, or (claude) by
 * scraping a rendered pane. That indirection exists for one reason — restart
 * survival: a bare child process dies with the agetor process, a detached
 * tmux session doesn't, so a turn can keep running (and be reattached to)
 * across an agetor restart.
 *
 * fx has no such story. `fx acp` is a stateful RPC *server* over stdio: the
 * moment its stdin pipe or its parent process disappears, its session is
 * gone — there is nothing to reattach to on the other end, because the only
 * channel back into it was the pipe itself. So this driver spawns `fx acp`
 * as a **plain `Bun.spawn` child process with piped stdio**, no tmux
 * involved at all, and treats every event as arriving *live* over the pipe
 * rather than being tailed from a file after the fact:
 *
 *   - There is deliberately **no `reattachFxSession`** export. A mid-turn
 *     agetor restart orphans the run *by design* — a bare child process does
 *     NOT die with its parent on POSIX (an unparented child is reparented to
 *     init and keeps running), but there is no surviving stdin/stdout handle
 *     left to drive it with once agetor exits, so reattaching would be a
 *     no-op anyway. To avoid leaking that orphaned `fx acp` process across a
 *     restart, every spawned child is tracked in a module-level `liveFxProcs`
 *     set (registered on spawn, unregistered on settlement) and a single
 *     `process.on("exit", …)` hook best-effort-kills whatever is still
 *     registered when agetor itself exits. Boot reconciliation's generic
 *     "no live session for a `running` row → flip to `orphaned`" path
 *     handles the DB-row side of this the same way it would handle any
 *     other agent kind whose session vanished — no fx-specific boot-time
 *     code is needed or provided here.
 *   - There is no on-disk NDJSON log this driver reads from (fx is told to
 *     write its OWN debug log via `--log-file`, for fx's own troubleshooting
 *     — this driver only ensures that log's parent directory exists so
 *     `fx acp` doesn't fail to open it; the driver never reads that file).
 *   - `line_uuid`-based de-duplication (`seenLineUuids`, matching the other
 *     three drivers) is still applied defensively, even though there's no
 *     reattach-replay path that strictly requires it here — it's what keeps
 *     a spurious duplicate `tool_call_update` from double-emitting a
 *     terminal tool_result within a single live run.
 *
 * ── Protocol facts encoded below ──
 *
 * Everything in this file's protocol layer was verified against a spike run
 * of the real `fx` v0.0.4 binary plus the canonical ACP `schema.json`, NOT
 * inferred from docs alone. Facts are flagged inline as SPIKE-VERIFIED
 * (observed against the live binary) or SCHEMA-DERIVED (shape asserted by
 * the ACP schema but not exercised end-to-end in the spike, e.g. anything
 * gated behind successful auth, which the spike environment did not have).
 *
 *   - Framing (SPIKE-VERIFIED): one UTF-8 JSON object per line on stdout;
 *     write requests/notifications as `JSON.stringify(msg) + "\n"` on
 *     stdin. stderr is diagnostic text, not protocol.
 *   - Handshake (SPIKE-VERIFIED): `initialize` (id 1) with
 *     `protocolVersion: 1` as a **number** — sending it as a string
 *     produces a `-32602` (Invalid params) error. An unauthenticated fx
 *     binary fails `initialize` itself with a `-32600` error whose message
 *     is the user-actionable "Fx needs access to Vercel AI Gateway. Run fx
 *     login…" text, and then answers every subsequent method with "Not
 *     initialized" — so a failed `initialize` is terminal for the turn,
 *     not just for that one call.
 *   - `session/new` (SPIKE-VERIFIED) → `{sessionId, modes?}`; `modes
 *     .availableModes` is used to best-effort map agetor's mode onto fx's
 *     `session/set_mode`, and failures there are swallowed — losing the
 *     mode nudge is not worth failing a turn over.
 *   - `session/resume` / `session/load` (SCHEMA-DERIVED for the fallback
 *     path — the spike's unauthenticated binary couldn't reach a second
 *     turn): resume is tried first; a method-not-found (`-32601`) or
 *     invalid-params (`-32602`) error falls back to `session/load`, during
 *     which every `session/update` notification is discarded (fx replays
 *     history the run's own persisted events already cover).
 *   - `session/prompt` (SPIKE-VERIFIED shape, SCHEMA-DERIVED stopReason
 *     enum beyond `end_turn`): the response is the ONLY turn-completion
 *     signal and arrives only once the whole turn is over, so unlike every
 *     other RPC call this driver makes, it is issued with **no timeout**.
 *   - `session/update` streaming (SPIKE-VERIFIED envelope shape,
 *     SCHEMA-DERIVED variant list): discriminated on
 *     `params.update.sessionUpdate`. This driver handles
 *     `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, and
 *     `tool_call_update` (terminal statuses only); every other variant is
 *     silently ignored as forward-compat (v1 scope).
 *   - `session/request_permission` (SCHEMA-DERIVED — never exercised
 *     against a real approval in the spike): an inbound *request* (has an
 *     `id`) that this driver must answer. Policy is fail-closed: permissive
 *     auto-answering applies ONLY to `auto`/`yolo` mode, which pick
 *     `allow_once`/`allow_always`/first-option (in that order — `allow_once`
 *     is preferred so an approval stays scoped to the turn instead of
 *     writing a durable rule into the user's fx config); every other mode id
 *     — `ask`, and any unknown/future id — takes the reject arm and picks
 *     `reject_once`/`reject_always` (else responds `cancelled`). Any other
 *     inbound request method gets a `-32601` error — fx shouldn't send one,
 *     since `initialize` advertised no fs/terminal capabilities, but this
 *     driver never trusts that silently.
 *   - Cancellation: `session/cancel` is a **notification**, not a request
 *     (no reply is expected) — after sending it we give the in-flight
 *     `session/prompt` a few seconds to resolve with `stopReason:
 *     "cancelled"` on its own, answer any still-pending inbound permission
 *     request as `cancelled` so fx isn't stuck waiting on us, then SIGTERM
 *     (SIGKILL after a grace period if it didn't exit).
 *   - Death: an unexpected process exit before the pending `session/prompt`
 *     resolves emits the shared `SESSION_DIED_STATUS_PREFIX` sentinel — the
 *     same one the tmux drivers use — so the orchestrator's existing
 *     pattern-match flips the card to `blocked` without any fx-specific
 *     orchestrator code.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * Small constants.
 * ────────────────────────────────────────────────────────────────────────── */

/** Timeout for every handshake RPC (`initialize`, `session/new`,
 *  `session/resume`, `session/load`) — NOT applied to `session/prompt`,
 *  which can legitimately run for a long time. */
const RPC_HANDSHAKE_TIMEOUT_MS = 30_000;
/** How long to let a cancelled turn's `session/prompt` response arrive on
 *  its own (with `stopReason: "cancelled"`) before we give up waiting and
 *  force-kill the process. */
const CANCEL_WAIT_MS = 3_000;
/** Grace between SIGTERM and SIGKILL when force-killing. */
const KILL_GRACE_MS = 2_000;
/** How many trailing stderr lines to keep for death diagnostics. */
const STDERR_RING_SIZE = 20;
/** Guard against a pathological unterminated line growing stdout's line
 *  buffer without bound — fx's own inbound cap is 8 MiB; ours is a looser
 *  backstop purely against a runaway/misbehaving process. Treated as death. */
const MAX_STDOUT_BUFFER_BYTES = 32 * 1024 * 1024;

/** Agetor's permission mode, as agents.ts will pass it through — kept local
 *  (not imported from shared/types.ts) per this task's boundary: the
 *  fx-specific mode/model option lists are landing there in a parallel task. */
export type FxMode = "yolo" | "auto" | "ask";

/* ────────────────────────────────────────────────────────────────────────── *
 * Log-dir plumbing — fx owns and writes its own `--log-file`; we only make
 * sure the directory exists so `fx acp` doesn't fail to open it.
 * ────────────────────────────────────────────────────────────────────────── */

function ensureLogDirForArgv(argv: string[]): void {
  const idx = argv.indexOf("--log-file");
  if (idx === -1 || idx + 1 >= argv.length) return;
  const logFile = argv[idx + 1]!;
  const dir = path.dirname(logFile);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * JSON-RPC message shapes (loose — fx's actual payloads are the source of
 * truth; these are just enough structure to dispatch safely).
 * ────────────────────────────────────────────────────────────────────────── */

interface AcpEnvelope {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingRpc {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Session state.
 * ────────────────────────────────────────────────────────────────────────── */

interface FxSessionState {
  taskId: string;
  runId: string;
  proc: Subprocess<"pipe", "pipe", "pipe">;
  mode: FxMode;
  onChunk: ChunkHandler;
  onSessionId?: (id: string) => void;

  nextRpcId: number;
  pending: Map<number, PendingRpc>;
  stdoutBuf: string;
  stderrRing: string[];

  sessionId: string | null;
  /** Set while a `session/load` fallback is awaiting its response, so the
   *  replayed `session/update` history it carries is discarded (the run's
   *  own persisted events already cover it). */
  suppressUpdates: boolean;
  /** Ids of inbound `session/request_permission` requests we haven't
   *  answered yet — drained (answered `cancelled`) on cancel. */
  pendingPermissionIds: Set<number | string>;
  seq: number;
  seenLineUuids: Set<string>;

  resolved: boolean;
  killRequested: boolean;
  /** Set the moment a cancel is requested — from then on, any inbound
   *  `session/request_permission` (including one racing the cancel drain or
   *  arriving during the post-cancel grace window) is answered `cancelled`
   *  instead of going through the normal allow/reject policy, per ACP's
   *  cancellation contract. */
  cancelRequested: boolean;
  resolveDone: (code: number) => void;
}

const fxSessions = new Map<string, FxSessionState>(); // taskId -> state

/** Every currently-spawned `fx acp` child, tracked so a mid-turn agetor exit
 *  doesn't leak an orphaned process (see the file header's "Architecture"
 *  section — a bare child does NOT die with its parent on POSIX). Registered
 *  in `spawnFxViaAcp`, unregistered in `settleFx`. */
const liveFxProcs = new Set<Subprocess<"pipe", "pipe", "pipe">>();

process.on("exit", () => {
  for (const proc of liveFxProcs) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Wire I/O.
 * ────────────────────────────────────────────────────────────────────────── */

function writeMessage(state: FxSessionState, msg: Record<string, unknown>): void {
  try {
    state.proc.stdin.write(`${JSON.stringify(msg)}\n`);
    state.proc.stdin.flush();
  } catch {
    // Pipe already closed — the process is dead or dying. The `exited`
    // watcher (installed in spawnFxViaAcp) settles the turn; nothing to do
    // here beyond not throwing out of a fire-and-forget write.
  }
}

function sendRpc(state: FxSessionState, method: string, params: unknown): Promise<unknown> {
  const id = state.nextRpcId++;
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject });
    writeMessage(state, { jsonrpc: "2.0", id, method, params });
  });
}

function sendNotification(state: FxSessionState, method: string, params?: unknown): void {
  writeMessage(state, { jsonrpc: "2.0", method, params });
}

function respondRpc(state: FxSessionState, id: number | string, result: unknown): void {
  writeMessage(state, { jsonrpc: "2.0", id, result });
}

function respondRpcError(state: FxSessionState, id: number | string, code: number, message: string): void {
  writeMessage(state, { jsonrpc: "2.0", id, error: { code, message } });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label} (${ms}ms)`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

/** Emit a chunk through the run's `line_uuid` dedup gate, mirroring the other
 *  drivers' `seenLineUuids` pattern (see cursor-tmux.ts / gemini-tmux.ts). */
function emit(state: FxSessionState, stream: RunEventStream, data: string, lineUuid?: string): void {
  // A settled turn emits nothing: pumpStdout keeps dispatching whatever
  // lines remain in the pipe until SIGTERM actually closes the stream, and
  // those trailing updates would otherwise append events to a run the
  // orchestrator has already finalized (or, post-delete, to a missing row).
  if (state.resolved) return;
  if (lineUuid) {
    if (state.seenLineUuids.has(lineUuid)) return;
    state.seenLineUuids.add(lineUuid);
  }
  state.onChunk(stream, data, lineUuid);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Inbound line dispatch.
 * ────────────────────────────────────────────────────────────────────────── */

function handleLine(state: FxSessionState, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: AcpEnvelope;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    emit(state, "status", `fx acp: malformed line from stdout: ${trimmed.slice(0, 200)}`);
    return;
  }

  const hasId = msg.id !== undefined;
  const isReply = hasId && ("result" in msg || "error" in msg);
  if (isReply) {
    const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
    const pending = state.pending.get(id);
    if (!pending) return; // stale/unknown id — ignore
    state.pending.delete(id);
    if (msg.error) {
      pending.reject(new Error(`${msg.error.message ?? "fx acp error"} (code ${msg.error.code ?? "?"})`));
    } else {
      pending.resolve(msg.result);
    }
    return;
  }

  if (typeof msg.method === "string" && hasId) {
    handleServerRequest(state, msg.method, msg.id!, msg.params);
    return;
  }

  if (typeof msg.method === "string") {
    handleServerNotification(state, msg.method, msg.params);
    return;
  }

  // Neither a reply, a request, nor a notification — forward-compat ignore.
}

function handleServerRequest(state: FxSessionState, method: string, id: number | string, params: unknown): void {
  if (method === "session/request_permission") {
    // Registered before dispatch, unregistered only once the response is
    // actually written (in respondPermissionRequest) — this is what makes
    // cancelFxTurn's "answer pending permissions with outcome cancelled"
    // drain loop real instead of a no-op over an always-empty set.
    state.pendingPermissionIds.add(id);
    respondPermissionRequest(state, id, params as { options?: Array<{ optionId: string; kind?: string }> } | undefined);
    return;
  }
  // fx advertised no fs/terminal capabilities at `initialize` — it
  // shouldn't ask for them, but don't silently ignore it if it does.
  emit(state, "status", `fx acp: unsupported request from agent: ${method}`);
  respondRpcError(state, id, -32601, "Method not found");
}

function respondPermissionRequest(
  state: FxSessionState,
  id: number | string,
  params: { options?: Array<{ optionId: string; kind?: string }> } | undefined,
): void {
  // A request that arrives once cancellation is underway (or after the turn
  // already settled) must not be policy-answered — in auto/yolo mode the
  // permissive arm would authorize fx to START a new tool action in the
  // middle of a user-initiated Stop. ACP's cancellation contract is that the
  // client answers such requests with outcome "cancelled".
  if (state.cancelRequested || state.resolved) {
    respondRpc(state, id, { outcome: { outcome: "cancelled" } });
    state.pendingPermissionIds.delete(id);
    return;
  }

  const options = Array.isArray(params?.options) ? params!.options! : [];
  const pick = (kinds: string[]) => options.find((o) => kinds.includes(o.kind ?? ""));

  // Fail-closed: permissive auto-answering applies ONLY to auto/yolo. Every
  // other mode id — "ask", and any unknown/future id — takes the reject arm.
  let chosen: { optionId: string; kind?: string } | undefined;
  if (state.mode === "yolo" || state.mode === "auto") {
    // Prefer allow_once over allow_always so an approval stays scoped to
    // this turn instead of writing a durable rule into the user's fx config.
    chosen = pick(["allow_once"]) ?? pick(["allow_always"]) ?? options[0];
  } else {
    chosen = pick(["reject_once"]) ?? pick(["reject_always"]);
  }

  if (!chosen) {
    respondRpc(state, id, { outcome: { outcome: "cancelled" } });
    state.pendingPermissionIds.delete(id);
    return;
  }
  respondRpc(state, id, { outcome: { outcome: "selected", optionId: chosen.optionId } });
  state.pendingPermissionIds.delete(id);
}

function handleServerNotification(state: FxSessionState, method: string, params: unknown): void {
  if (method !== "session/update") return; // forward-compat ignore
  if (state.suppressUpdates) return; // discarding replay during session/load fallback
  const update = (params as { update?: Record<string, unknown> } | undefined)?.update;
  if (update) dispatchSessionUpdate(state, update);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * session/update → chunk mapping.
 * ────────────────────────────────────────────────────────────────────────── */

interface AcpContentBlock {
  type?: string;
  text?: string;
  [k: string]: unknown;
}

/** Concatenate text content blocks. Accepts either a single block object (the
 *  schema's documented shape for chunk updates) or an array of blocks
 *  defensively, and ignores any non-text block rather than erroring. */
function extractText(content: unknown): string {
  if (!content) return "";
  const blocks: AcpContentBlock[] = Array.isArray(content) ? content : [content as AcpContentBlock];
  return blocks
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

function toolCallName(update: Record<string, unknown>): string {
  const title = typeof update.title === "string" && update.title.length > 0 ? update.title : null;
  const kind = typeof update.kind === "string" && update.kind.length > 0 ? update.kind : null;
  if (title && kind) return `${title} (${kind})`;
  return title ?? kind ?? "tool_call";
}

/** Generic, forward-compat payload for a tool_use chunk — mirrors cursor's
 *  approach of forwarding the inner payload as-is rather than picking apart
 *  a shape that's explicitly unstable across fx versions. Prefers
 *  `rawInput` when present (the closest fx gets to a stable "what were the
 *  args" field); falls back to the whole update otherwise. */
function toolCallInput(update: Record<string, unknown>): unknown {
  if ("rawInput" in update) return update.rawInput;
  return update;
}

/** Same idea for the terminal tool_result payload — prefers `rawOutput`,
 *  then `content`, then the whole update. */
function toolResultContent(update: Record<string, unknown>): unknown {
  if ("rawOutput" in update) return update.rawOutput;
  if ("content" in update) return update.content;
  return update;
}

function dispatchSessionUpdate(state: FxSessionState, update: Record<string, unknown>): void {
  const kind = update.sessionUpdate;
  switch (kind) {
    case "agent_message_chunk": {
      const text = extractText(update.content);
      if (text) emit(state, "assistant", text, `fx:${state.runId}:${state.seq++}`);
      return;
    }

    case "agent_thought_chunk": {
      const text = extractText(update.content);
      if (text) emit(state, "thinking", text, `fx:${state.runId}:${state.seq++}`);
      return;
    }

    case "tool_call": {
      // No real id to correlate a later tool_call_update against — still
      // worth emitting (a seq-based id renders fine on its own), it just
      // can never pair with a result (see the tool_call_update branch).
      const id = typeof update.toolCallId === "string" ? update.toolCallId : `seq${state.seq++}`;
      emit(
        state,
        "tool_use",
        JSON.stringify({ id, name: toolCallName(update), input: toolCallInput(update), serverSide: false }),
        `fx:tool:${id}:use`,
      );
      return;
    }

    case "tool_call_update": {
      const status = update.status;
      if (status !== "completed" && status !== "failed") return; // pending/in_progress — ignore
      // Without a real toolCallId there is nothing to pair this result with
      // the tool_use it completes — minting an independent seq-based id here
      // would never match the use event's id (different seq counter state),
      // so drop the event rather than emit an unpairable orphan.
      if (typeof update.toolCallId !== "string") return;
      const id = update.toolCallId;
      emit(
        state,
        "tool_result",
        JSON.stringify({ toolUseId: id, content: toolResultContent(update), isError: status === "failed" }),
        `fx:tool:${id}:result`,
      );
      return;
    }

    default:
      // plan, usage_update, current_mode_update, available_commands_update,
      // user_message_chunk, session_info_update, config_option_update, and
      // any future variant — silent forward-compat (v1 scope).
      return;
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * stdout/stderr pumps.
 * ────────────────────────────────────────────────────────────────────────── */

async function pumpStdout(state: FxSessionState): Promise<void> {
  const stream = state.proc.stdout;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      state.stdoutBuf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = state.stdoutBuf.indexOf("\n")) >= 0) {
        const line = state.stdoutBuf.slice(0, nl);
        state.stdoutBuf = state.stdoutBuf.slice(nl + 1);
        handleLine(state, line);
      }
      // `stdoutBuf.length` is UTF-16 code units, not bytes — comparing it
      // directly against a byte-denominated cap under-triggers for
      // multi-byte UTF-8 text. A UTF-8 char is at most 4 bytes → at most ~3x
      // the UTF-16 units it can produce (surrogate pairs are 2 units for up
      // to 4 bytes), so `length` is always >= `byteLength / 3`; that makes
      // `length * 3 >= MAX` a cheap, always-safe pre-check before paying for
      // the exact `Buffer.byteLength` computation.
      if (
        state.stdoutBuf.length * 3 >= MAX_STDOUT_BUFFER_BYTES &&
        Buffer.byteLength(state.stdoutBuf, "utf8") > MAX_STDOUT_BUFFER_BYTES
      ) {
        failTurn(state, `${SESSION_DIED_STATUS_PREFIX}fx stdout exceeded ${MAX_STDOUT_BUFFER_BYTES} bytes without a newline`);
        return;
      }
    }
  } catch {
    // Stream closed — normal on process exit; the `exited` watcher handles
    // settlement.
  }
}

async function pumpStderr(state: FxSessionState): Promise<void> {
  const stream = state.proc.stderr;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const raw of text.split("\n")) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        state.stderrRing.push(trimmed);
        if (state.stderrRing.length > STDERR_RING_SIZE) state.stderrRing.shift();
      }
    }
  } catch {
    // noop — stderr closing is normal on exit.
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Turn settlement.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Settle the turn, exactly once. This is also where the child process gets
 * torn down on the SUCCESS path: fx's "one session per connection" model
 * (see file header) means each `spawnFxViaAcp` call is a one-shot process
 * for exactly one turn — nothing reuses this connection afterwards (a
 * follow-up turn spawns an entirely new process with `resumeSessionId`
 * set), so leaving the process alive past settlement would leak it. The
 * failure paths already call `killProc` themselves before reaching here
 * (so the process is dead before the failure status chunk is even
 * observable); calling it again here is a no-op there via `killRequested`.
 */
function settleFx(state: FxSessionState, code: number): void {
  if (state.resolved) return;
  state.resolved = true;
  // Identity-checked: a cross-kind agent switch or a fresh turn on the same
  // task can already have replaced this taskId's map entry with a newer
  // state by the time this (older) state settles — an unconditional delete
  // would unregister the wrong (still-live) session.
  if (fxSessions.get(state.taskId) === state) fxSessions.delete(state.taskId);
  liveFxProcs.delete(state.proc);
  killProc(state);
  for (const pending of state.pending.values()) pending.reject(new Error("fx session settled"));
  state.pending.clear();
  state.resolveDone(code);
}

/** Emit a status chunk then settle failed, but only once — every failure
 *  path in this file funnels through here so a timeout/death/protocol-error
 *  race can't double-fire. `settleFx` itself terminates the process. */
function failTurn(state: FxSessionState, message: string): void {
  if (state.resolved) return;
  emit(state, "status", message);
  settleFx(state, 1);
}

function killProc(state: FxSessionState): void {
  if (state.killRequested) return;
  state.killRequested = true;
  try { state.proc.kill("SIGTERM"); } catch { /* already gone */ }
  const timer = setTimeout(() => {
    try { state.proc.kill("SIGKILL"); } catch { /* already gone */ }
  }, KILL_GRACE_MS);
  state.proc.exited.then(() => clearTimeout(timer)).catch(() => clearTimeout(timer));
}

async function waitUntilResolved(state: FxSessionState, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!state.resolved && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Interrupt an in-flight fx turn: notify fx via `session/cancel`, answer any
 * pending inbound permission request as `cancelled` so fx isn't stuck
 * waiting on us, give the pending `session/prompt` a few seconds to resolve
 * with `stopReason: "cancelled"` on its own, then force-kill if it hasn't.
 */
async function cancelFxTurn(state: FxSessionState): Promise<void> {
  if (state.resolved) return;
  state.cancelRequested = true;
  if (state.sessionId) sendNotification(state, "session/cancel", { sessionId: state.sessionId });
  for (const id of state.pendingPermissionIds) {
    respondRpc(state, id, { outcome: { outcome: "cancelled" } });
  }
  state.pendingPermissionIds.clear();

  await waitUntilResolved(state, CANCEL_WAIT_MS);
  if (!state.resolved) {
    killProc(state);
    // The orchestrator derives cancelled-vs-failed from its own
    // `handle.cancelled` flag (see cursor-tmux.ts's identical comment on
    // `killCursorState`) — the code passed here is immaterial to the
    // recorded run status.
    settleFx(state, 1);
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * The ACP conversation itself: handshake → (new | resume | load) → prompt.
 * ────────────────────────────────────────────────────────────────────────── */

function acpModeIdFor(mode: FxMode): string | null {
  if (mode === "auto") return "code";
  if (mode === "ask") return "ask";
  return null; // yolo — no session/set_mode call
}

async function runFxTurn(
  state: FxSessionState,
  opts: { cwd: string; promptText: string; resumeSessionId?: string },
): Promise<void> {
  // 1. initialize
  try {
    await withTimeout(
      sendRpc(state, "initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "agetor", version: "0" },
      }),
      RPC_HANDSHAKE_TIMEOUT_MS,
      "initialize",
    );
  } catch (err) {
    failTurn(state, describeHandshakeFailure(err, "initialize", RPC_HANDSHAKE_TIMEOUT_MS));
    return;
  }
  if (state.resolved) return;

  // 2. session/new | session/resume (+ session/load fallback)
  if (opts.resumeSessionId) {
    state.sessionId = opts.resumeSessionId;
    let resumed = false;
    try {
      await withTimeout(
        sendRpc(state, "session/resume", { sessionId: opts.resumeSessionId }),
        RPC_HANDSHAKE_TIMEOUT_MS,
        "session/resume",
      );
      resumed = true;
    } catch (err) {
      if (isTimeoutError(err)) {
        failTurn(state, describeHandshakeFailure(err, "session/resume", RPC_HANDSHAKE_TIMEOUT_MS));
        return;
      }
      // Method-not-found / invalid-params (or any other resume error) —
      // fall back to session/load below.
    }
    if (state.resolved) return;
    if (!resumed) {
      state.suppressUpdates = true;
      try {
        await withTimeout(
          sendRpc(state, "session/load", { sessionId: opts.resumeSessionId, cwd: opts.cwd, mcpServers: [] }),
          RPC_HANDSHAKE_TIMEOUT_MS,
          "session/load",
        );
      } catch (err) {
        state.suppressUpdates = false;
        if (isTimeoutError(err)) {
          failTurn(state, describeHandshakeFailure(err, "session/load", RPC_HANDSHAKE_TIMEOUT_MS));
        } else {
          failTurn(state, `fx acp: failed to resume session ${opts.resumeSessionId}: ${errMessage(err)}`);
        }
        return;
      }
      state.suppressUpdates = false;
    }
    if (state.resolved) return;
  } else {
    let sessionResult: { sessionId?: string; modes?: { availableModes?: Array<{ id?: string }> } } | undefined;
    try {
      sessionResult = (await withTimeout(
        sendRpc(state, "session/new", { cwd: opts.cwd, mcpServers: [] }),
        RPC_HANDSHAKE_TIMEOUT_MS,
        "session/new",
      )) as typeof sessionResult;
    } catch (err) {
      failTurn(state, describeHandshakeFailure(err, "session/new", RPC_HANDSHAKE_TIMEOUT_MS));
      return;
    }
    if (state.resolved) return;

    const sessionId = typeof sessionResult?.sessionId === "string" ? sessionResult.sessionId : null;
    if (!sessionId) {
      failTurn(state, "fx acp: session/new response had no sessionId");
      return;
    }
    state.sessionId = sessionId;
    state.onSessionId?.(sessionId);

    // Best-effort mode nudge — never blocks or fails the turn.
    const desiredModeId = acpModeIdFor(state.mode);
    const availableModes = sessionResult?.modes?.availableModes ?? [];
    if (desiredModeId && availableModes.some((m) => m?.id === desiredModeId)) {
      sendRpc(state, "session/set_mode", { sessionId, modeId: desiredModeId }).catch(() => { /* best-effort */ });
    }
  }

  // 3. session/prompt — the ONLY turn-completion signal; no timeout.
  let promptResult: { stopReason?: string } | undefined;
  try {
    promptResult = (await sendRpc(state, "session/prompt", {
      sessionId: state.sessionId,
      prompt: [{ type: "text", text: opts.promptText }],
    })) as typeof promptResult;
  } catch (err) {
    if (state.resolved) return; // already settled via cancel/death
    failTurn(state, `fx acp: session/prompt failed: ${errMessage(err)}`);
    return;
  }
  if (state.resolved) return; // cancel/death already settled us

  const stopReason = promptResult?.stopReason ?? "unknown";
  switch (stopReason) {
    case "end_turn":
      settleFx(state, 0);
      return;
    case "cancelled":
      // See the comment in cancelFxTurn: the orchestrator's own
      // `handle.cancelled` flag is authoritative for cancelled-vs-failed.
      settleFx(state, 1);
      return;
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
      emit(state, "status", `fx turn ended: ${stopReason}`);
      settleFx(state, 1);
      return;
    default:
      emit(state, "status", `fx turn ended with unexpected stopReason: ${stopReason}`);
      settleFx(state, 1);
  }
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && /^timed out waiting for/.test(err.message);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeHandshakeFailure(err: unknown, step: string, timeoutMs: number): string {
  if (isTimeoutError(err)) {
    return `${SESSION_DIED_STATUS_PREFIX}fx did not respond to ${step} within ${timeoutMs}ms`;
  }
  // A real ACP error response (e.g. the unauthenticated-binary case) is
  // user-actionable on its own — surface its message verbatim rather than
  // wrapping it, so e.g. "Fx needs access to Vercel AI Gateway…" reads
  // cleanly in the run panel.
  return errMessage(err);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Public surface — mirrors cursor-tmux.ts / gemini-tmux.ts's export shape so
 * the orchestrator/agents.ts wiring that lands in a later task is mechanical.
 * ────────────────────────────────────────────────────────────────────────── */

export interface FxLaunchOptions {
  taskId: string;
  runId: string;
  /** fx argv from `buildCommand` — `[fxBin, "acp", "--model", id,
   *  "--log-file", <dataDir>/fx-logs/<runId>.log]`. This driver does not
   *  append anything to it; the prompt rides over the ACP `session/prompt`
   *  call, not argv. */
  argv: string[];
  /** Env to forward into the fx process (`FX_PERMISSION_MODE` + any harness
   *  env, e.g. a HOME override). Merged on top of `process.env` so PATH and
   *  friends still resolve. */
  env: Record<string, string>;
  cwd: string;
  /** The prompt text, delivered via `session/prompt`'s `prompt` array. */
  promptText: string;
  /** Agetor's permission mode — drives both the `session/set_mode` nudge and
   *  this driver's `session/request_permission` auto-answer policy. */
  mode: FxMode;
  /** Set on a follow-up turn to resume (or, on failure, load) a prior ACP
   *  session instead of opening a new one via `session/new`. */
  resumeSessionId?: string;
  onChunk: ChunkHandler;
  /** Fires once with fx's `sessionId`, immediately after `session/new`
   *  resolves on the first turn (persisted as `runs.fx_session_id`). Not
   *  called again on a resumed turn — the session id is already known. */
  onSessionId?: (id: string) => void;
}

/**
 * Spawn one fx `acp` turn as a plain child process (no tmux — see the file
 * header for why) and drive it over stdio. Returns a `SpawnedAgent` whose
 * `done` resolves when the turn ends: 0 on `stopReason: "end_turn"`, 1 on
 * every other outcome (cancelled, refusal, max_tokens, max_turn_requests,
 * protocol error, or process death).
 */
export function spawnFxViaAcp(opts: FxLaunchOptions): SpawnedAgent {
  ensureLogDirForArgv(opts.argv);
  const env = { ...process.env, ...opts.env };
  const [bin, ...rest] = opts.argv;
  if (!bin) {
    const done = Promise.resolve(1);
    opts.onChunk("stderr", "fx acp: empty argv — nothing to spawn", undefined);
    return { kill: () => { /* nothing to kill */ }, writeInput: () => false, done };
  }

  const proc = Bun.spawn([bin, ...rest], {
    cwd: opts.cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  liveFxProcs.add(proc);

  const state: FxSessionState = {
    taskId: opts.taskId,
    runId: opts.runId,
    proc,
    mode: opts.mode,
    onChunk: opts.onChunk,
    onSessionId: opts.onSessionId,
    nextRpcId: 1,
    pending: new Map(),
    stdoutBuf: "",
    stderrRing: [],
    sessionId: opts.resumeSessionId ?? null,
    suppressUpdates: false,
    pendingPermissionIds: new Set(),
    seq: 0,
    seenLineUuids: new Set(),
    resolved: false,
    killRequested: false,
    cancelRequested: false,
    resolveDone: () => { /* replaced below */ },
  };
  fxSessions.set(opts.taskId, state);

  const done = new Promise<number>((resolve) => { state.resolveDone = resolve; });

  const stdoutPump = pumpStdout(state);
  void pumpStderr(state);

  // Death watch: an unexpected process exit before we've settled the turn
  // (initialize/session/new/prompt never got their response) is a genuine
  // death, not an orderly finish — surface the shared sentinel + last stderr
  // for context. We wait for the stdout pump to drain first: `proc.exited`
  // can resolve before the pump has finished reading and dispatching
  // whatever fx already flushed to the pipe (e.g. the terminal
  // `session/prompt` response, or a protocol-error reply) — racing ahead of
  // that would clobber an actionable result/error with a generic
  // "session died" status.
  state.proc.exited.then(async (code) => {
    await stdoutPump.catch(() => { /* pump's own catch already handled/logged failure */ });
    if (state.resolved) return;
    const tail = state.stderrRing.length > 0 ? `\n${state.stderrRing.join("\n")}` : "";
    failTurn(state, `${SESSION_DIED_STATUS_PREFIX}fx process exited unexpectedly (code ${code})${tail}`);
  }).catch(() => { /* proc.exited doesn't reject in practice, but stay defensive */ });

  void runFxTurn(state, {
    cwd: opts.cwd,
    promptText: opts.promptText,
    resumeSessionId: opts.resumeSessionId,
  }).catch((err) => {
    failTurn(state, `fx acp: unexpected driver error: ${errMessage(err)}`);
  });

  return {
    kill: () => { void cancelFxTurn(state); },
    // fx's ACP session has no mid-turn keystroke channel — a follow-up sent
    // while a turn is in flight folds into the orchestrator's queue and is
    // delivered as a fresh turn (new process, `--resume`-equivalent via
    // `session/resume`/`session/load`), same as cursor/gemini.
    writeInput: () => false,
    done,
  };
}

/** True when a live fx turn is registered for this task. */
export function fxSessionActive(taskId: string): boolean {
  return fxSessions.has(taskId);
}

/**
 * Tear down a task's fx session: kill the child process (if any) and dispose
 * in-memory state. Best-effort and non-throwing — called from deleteTask /
 * archiveTask and on a cross-kind agent switch. Safe to call when no fx
 * session exists for this task.
 */
export function dropFxSession(taskId: string): void {
  const state = fxSessions.get(taskId);
  if (!state) return;
  killProc(state);
  if (!state.resolved) settleFx(state, 1);
}

// Intentionally no `reattachFxSession` export — see the file header's
// "Architecture" section for why a mid-turn agetor restart orphans an fx run
// by design rather than reattaching to it.
