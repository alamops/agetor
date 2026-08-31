import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Subprocess } from "bun";
import type { RunEventStream } from "../shared/types.ts";
import { FX_PROVIDER_STATUS_PREFIX, FX_USAGE_STATUS_PREFIX, SESSION_DIED_STATUS_PREFIX } from "../shared/types.ts";
import type { ChunkHandler, SpawnedAgent } from "./claude-tmux.ts";
import {
  answerFxPermission,
  registerFxPermission,
  type FxPermissionAnswer,
  type FxPermissionOption,
  type FxPermissionToolCall,
} from "./interactions.ts";

/**
 * Driver for the `fx` agent kind — Vercel Labs' fx coding agent, driven via
 * `fx acp`, an Agent Client Protocol (ACP) server speaking newline-delimited
 * JSON-RPC 2.0 over stdio (one JSON object per line each direction).
 *
 * ── Architecture ──
 *
 * claude-tmux.ts / codex-tmux.ts / cursor-tmux.ts / gemini-tmux.ts each host
 * their CLI inside a *detached tmux session* so a turn survives an agetor
 * restart, and observe it indirectly (tailing a log file, or scraping a
 * pane). `fx acp` is a stateful RPC *server* over stdio instead: the moment
 * its stdin pipe or parent process disappears, its session is gone — there
 * is nothing on the other end to reattach to. So this driver spawns `fx acp`
 * as a **plain `Bun.spawn` child with piped stdio**, no tmux, one process
 * per turn, driven live over the pipe rather than tailed from a file:
 *
 *   - No `reattachFxSession` export, by design — see above. Boot
 *     reconciliation flips a still-`running` row to `orphaned` the same way
 *     it would for any other agent kind whose session vanished.
 *   - No on-disk log this driver reads: `--log-file` is fx's OWN debug log
 *     (for fx's own troubleshooting); this driver only ensures its parent
 *     directory exists.
 *   - `seenLineUuids` dedup still applies, matching the other three
 *     drivers, even though there's no reattach-replay path requiring it.
 *   - **Reaping**: every spawned child is tracked in `liveFxProcs`.
 *     `process.on("exit", …)` covers normal exit and Electrobun's
 *     `Utils.quit()` path; `SIGINT`/`SIGTERM`/`SIGHUP` handlers are always
 *     installed and always reap — but ownership of the *exit* is decided at
 *     signal-delivery time, not at module-load time (see the `FX_REAP_SIGNALS`
 *     comment below for why that distinction matters: `headless.ts` imports
 *     this module — and so registers these handlers — before it installs its
 *     own). A handler only calls `process.exit` itself when
 *     `process.listenerCount(sig) === 1` at the moment the signal arrives,
 *     i.e. it's the sole listener; otherwise some other (app-level) handler
 *     owns the shutdown sequence, and that handler is expected to call the
 *     exported `reapLiveFxProcs()` itself before it exits.
 *
 * ── Settlement invariant for carded (ask/auto) permission requests ──
 *
 * Exactly one reply is ever written for a given request id — `respondRpc` (or
 * its `respondCancelled` wrapper) never fires twice for the same id. For a
 * carded request, the awaiting `respondPermissionRequest` call is the sole
 * writer, once `registerFxPermission`'s `answer` promise resolves.
 * `cancelFxTurn`'s drain loop and `settleFx`'s card sweep never call
 * `respondRpc` for a carded id — only `answerFxPermission(cardId, {cancelled:
 * true})`, which *unblocks* that awaiting call rather than racing it. The
 * awaiting call is guarded twice after its `await`: if `state.resolved` is
 * already true it skips replying entirely (the stdin pipe may be
 * closing/closed); if `state.cancelRequested` is true a `selected` answer is
 * downgraded to `cancelled` (ACP's cancellation contract). `answerFxPermission`
 * returns `false` on an already-resolved id, so a card answered at the exact
 * moment Stop tears it down degrades to a no-op on whichever side loses the
 * race. The zero-options (uncarded) branch keeps the same invariant by
 * ordering rather than by construction: it `emit`s its "no options" status
 * line BEFORE calling `respondCancelled`, so if `emit` throws (e.g. `onChunk`
 * → `appendEvent` hitting a FK error against a since-deleted run) the
 * in-branch reply never fires and `handleServerRequest`'s catch-all fallback
 * writes the sole reply instead.
 *
 * ── Protocol index (verified against fx v0.0.4, v0.0.6 and v0.0.7 + ACP's canonical schema.json) ──
 *
 *   - `initialize`                  SPIKE-VERIFIED             handshake; unauth fails here (see describeHandshakeFailure)
 *   - `session/new`                 SPIKE-VERIFIED             → {sessionId, modes?, configOptions?}; mode nudge is best-effort (see runFxTurn)
 *   - `session/resume`/`load`       SCHEMA-DERIVED             resume falls back to load on -32601/-32602/-32600 alike (see runFxTurn)
 *   - `session/prompt`              SPIKE-VERIFIED shape       sole completion signal, no timeout (see runFxTurn)
 *   - `session/update`              SPIKE-VERIFIED envelope    variant → chunk mapping (see mapFxUpdate)
 *   - `session/request_permission`  SCHEMA-DERIVED, UNVERIFIED-LIVE card flow  (see respondPermissionRequest)
 *   - `session/cancel`              SCHEMA-DERIVED             notification, no reply expected (see cancelFxTurn)
 *   - death                         —                          unexpected exit before settlement (see the `exited` watcher)
 *
 * ── Facts verified against fx 0.0.5/0.0.6/0.0.7 (spike + release notes + Zig source diff, 2026-08-31) ──
 *
 *   - **No sandbox since 0.0.5** — fx retired its command sandbox; approved
 *     tool calls run as ordinary host subprocesses. Agetor's permission mode
 *     (`session/set_mode` + this driver's `session/request_permission`
 *     policy, see `respondPermissionRequest`) is the ONLY gate fx has left —
 *     there is no `sandbox_denied` outcome to parse and never was one here.
 *     Still true at 0.0.7 — 0.0.7 even adds an fx-side test asserting legacy
 *     `sandbox` settings keys stay inert (spike + Zig source diff,
 *     2026-08-31).
 *   - **Credential re-checks on `session/prompt` AND `session/resume`
 *     (0.0.5+; re-check paths unchanged through 0.0.7 — `server.zig`/
 *     `jsonrpc.zig` are byte-identical 0.0.6→0.0.7)** — an unauthenticated/
 *     deauthorized binary no longer fails only at `initialize`; either call
 *     can return `-32600` mid-session with the same "fx needs access to
 *     Vercel AI Gateway…" text or a provider-specific variant (e.g. "fx
 *     needs a Codex subscription login for this model. Run fx login
 *     codex."). 0.0.7 recased these (and other) user-facing strings from
 *     "Fx" to lowercase "fx" — cosmetic only, no behavior change (spike +
 *     Zig source diff, 2026-08-31). `-32600` is JSON-RPC's generic "Invalid
 *     Request" code, not an auth-specific one — fx merely reuses it for
 *     credential failures — so `session/resume`'s `-32600` is treated
 *     exactly like its `-32601`/`-32602` siblings in `runFxTurn`: it falls
 *     through to the `session/load` fallback rather than failing the turn
 *     immediately. If `session/load` in turn also answers `-32600`, that's
 *     authoritative either way it reads: the same credential gate, hit again
 *     (load can't do any better than resume did), or a non-auth "Invalid
 *     Request" (e.g. fx rejecting resume as unsupported) for which
 *     `session/load` is precisely the graceful path — so that catch surfaces
 *     fx's message verbatim via `RpcError.rawMessage`, with no `fx acp:
 *     failed to resume session…` wrapper. `session/prompt`'s `-32600` catch
 *     is unaffected by any of this — mid-turn there's nothing to fall back
 *     to, so it still fails the turn immediately, also surfacing fx's
 *     message verbatim via `rawMessage`.
 *   - **`configOptions` on `session/new`/`session/resume`/`session/load`
 *     results (0.0.5+, additive)** — a `{id, name, category, type,
 *     currentValue, options}[]` array; an entry with `id: "provider"` names
 *     the active auth provider (`"gateway"` | `"codex"` | `"grok"`). This
 *     driver emits its `currentValue` once per turn as a
 *     `FX_PROVIDER_STATUS_PREFIX` status chunk (see `maybeEmitProvider` in
 *     `runFxTurn`) — RunPanel renders it as a small provider chip. Absence
 *     (0.0.4 binaries, or a response that omits the array) is tolerated
 *     silently; no chip that turn. `src/acp/server.zig` is byte-identical
 *     0.0.6→0.0.7 — the provider values are still exactly `"gateway"` |
 *     `"codex"` | `"grok"` (spike + Zig source diff, 2026-08-31). Trap:
 *     0.0.7's binary also compiles inline-menu TUI strings that look like
 *     mode/model configOptions entries — those are TUI-only, never on the
 *     wire; don't infer a protocol change from a `strings` scan alone.
 *   - **Exactly six `session/update` kinds are emitted, in 0.0.4, 0.0.6 and
 *     0.0.7**: `agent_message_chunk`, `user_message_chunk`, `tool_call`,
 *     `tool_call_update`, `available_commands_update`, `session_info_update`.
 *     Re-verified at 0.0.7 two ways — `src/acp/types.zig`'s writers have a
 *     0-line functional diff vs 0.0.6, and a binary `strings` scan still
 *     shows the same six with no `agent_thought_chunk`/`plan`/
 *     `usage_update` (spike + Zig source diff, 2026-08-31). `mapFxUpdate`'s
 *     `agent_thought_chunk`/`plan`/`usage_update` branches are ACP-spec-correct
 *     and stay (forward-compatible, unit-tested), but are DORMANT — fx has
 *     never been observed to send any of the three, so those three chunk
 *     kinds never reach a real run today.
 *   - **`agent_message_chunk` carries raw Markdown, not rendered text
 *     (0.0.7)** — 0.0.6 streamed ANSI-stripped, already-rendered text and
 *     discarded the markdown source; 0.0.7 flips that (`src/acp/prompt.zig`):
 *     the chunk now carries the raw Markdown source instead. fx's changelog
 *     also notes a resumed response no longer repeats text already
 *     delivered. Neither needs a driver change here — chunks were already
 *     forwarded verbatim and rendered as markdown downstream by the webview
 *     — but a transcript captured against 0.0.7 carries markdown source
 *     where an 0.0.6 transcript carried pre-rendered text (spike + Zig
 *     source diff, 2026-08-31).
 *   - **Project `.mcp.json` merges into ACP sessions (0.0.7)** —
 *     `session/new` AND `session/resume` now merge the workspace's
 *     project-level `.mcp.json` MCP servers into the session (trust-gated by
 *     fx's own approval flow / `allow_acp_mcp`; `sessions.zig` gained a new
 *     `invalid_params` error path, "MCP servers are unavailable in this
 *     runtime"). This driver still passes `mcpServers: []` on every
 *     `session/new`/`session/load` call below, but a task `workdir` that
 *     itself carries a `.mcp.json` can still introduce MCP tools into the
 *     session via that merge — their `tool_call`s render generically like
 *     any other tool call; no driver change needed (spike + Zig source diff,
 *     2026-08-31).
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

/** Agetor's permission mode, as agents.ts passes it through. Narrowed
 *  locally (not reused from shared/types.ts) so the policy switch in
 *  `respondPermissionRequest` is exhaustive over exactly `yolo`/`auto`/
 *  `ask` — `AgentRunOptions.mode` itself stays `string | null`, same as
 *  every other agent kind. */
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
  /** ACP request id → interactions-registry card id, for every currently
   *  OPEN `fx_permission` card (ask/auto mode only — yolo/unknown-mode
   *  requests never register a card, they answer synchronously and never
   *  appear here). `cancelFxTurn`'s drain loop and `settleFx`'s card sweep
   *  use this to resolve the registry entry (`answerFxPermission`) instead
   *  of `respondRpc`-ing directly — see the file header's "Settlement
   *  invariant" note. Entries are removed by `respondPermissionRequest`
   *  itself once its `await answer` resolves. */
  cardIdByRequestId: Map<number | string, string>;
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
  /** Resolves the moment `resolveDone` fires — the same promise returned to
   *  the caller as `SpawnedAgent.done`, kept on state as well so
   *  `waitUntilResolved` can race it instead of polling. */
  done: Promise<number>;
}

const fxSessions = new Map<string, FxSessionState>(); // taskId -> state

/** Every currently-spawned `fx acp` child, tracked so a mid-turn agetor exit
 *  doesn't leak an orphaned process (see the file header's "Architecture"
 *  section — a bare child does NOT die with its parent on POSIX). Registered
 *  in `spawnFxViaAcp`, unregistered in `settleFx`. */
const liveFxProcs = new Set<Subprocess<"pipe", "pipe", "pipe">>();

export function reapLiveFxProcs(): void {
  for (const proc of liveFxProcs) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

process.on("exit", reapLiveFxProcs);

// Belt-and-suspenders for the signals `exit` doesn't cover: Node/Bun's
// default handler for SIGINT/SIGTERM/SIGHUP terminates the process WITHOUT
// running "exit" listeners, so a bare Ctrl-C on `bun run dev` (SIGINT) or a
// plain `kill`/service-manager stop (SIGTERM/SIGHUP) would otherwise leak a
// still-running `fx acp` child with write access to the task's worktree.
//
// Ownership of the *exit* is decided at SIGNAL-DELIVERY time, not at
// module-load time. Module import order runs this file's top-level code (and
// so registers these handlers) before an app-level shutdown owner gets a
// chance to register its own — e.g. `headless.ts` imports
// orchestrator → agents → fx-acp before `runDaemon()` installs its own
// SIGINT/SIGTERM handlers, so checking `listenerCount(sig) === 0` at module
// load always found this the sole listener and always exited here first,
// pre-empting `headless.ts`'s `shutdown()` (which removes the core creds file
// and logs a "shutting down" line) from ever running. Instead: install
// unconditionally, always reap, and only call `process.exit` when — AT THE
// MOMENT THE SIGNAL FIRES — `process.listenerCount(sig) === 1`, i.e. this is
// still the only listener. When another handler is also registered for the
// signal, that handler owns the shutdown sequence; it is expected to call the
// exported `reapLiveFxProcs()` itself before it exits (see `headless.ts`'s
// `shutdown()`). This repo has no OTHER app-level quit handler today besides
// `headless.ts` (Electrobun's confirm-on-quit path calls `Utils.quit()`,
// which DOES fire "exit" and is covered by the hook above), but any future
// one is likewise free to become the sole owner of a signal's shutdown
// sequence without racing this one.
const FX_REAP_SIGNALS: Array<[NodeJS.Signals, number]> = [
  ["SIGINT", 2],
  ["SIGTERM", 15],
  ["SIGHUP", 1],
];
for (const [sig, num] of FX_REAP_SIGNALS) {
  process.on(sig, () => {
    reapLiveFxProcs();
    if (process.listenerCount(sig) === 1) process.exit(128 + num);
  });
}

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

/** Shorthand for the `outcome: "cancelled"` reply every reject-fast path in
 *  the permission flow sends — the shared terminal answer for a moot,
 *  unanswerable, or already-settled request. */
function respondCancelled(state: FxSessionState, id: number | string): void {
  respondRpc(state, id, { outcome: { outcome: "cancelled" } });
}

/** Try each kind in `preferredKinds`, in order, and answer `selected` with
 *  the first option whose `kind` matches; if none match, answer `cancelled`
 *  — unless `fallbackToFirstOption` is set, in which case any offered
 *  option (regardless of kind) is taken rather than cancelling outright.
 *  Shared by the yolo (`allow_once` → `allow_always` → any option) and
 *  fail-closed (`reject_once` → `reject_always` → cancelled, deliberately
 *  no first-option fallback — an unrecognized request must never silently
 *  become an allow) synchronous-answer arms of the permission policy. */
function answerByKind(
  state: FxSessionState,
  id: number | string,
  options: Array<{ optionId: string; kind?: string }>,
  preferredKinds: string[],
  fallbackToFirstOption = false,
): void {
  let chosen: { optionId: string; kind?: string } | undefined;
  for (const kind of preferredKinds) {
    chosen = options.find((o) => o.kind === kind);
    if (chosen) break;
  }
  if (!chosen && fallbackToFirstOption) chosen = options[0];
  if (chosen) {
    respondRpc(state, id, { outcome: { outcome: "selected", optionId: chosen.optionId } });
  } else {
    respondCancelled(state, id);
  }
}

/** Thrown only by `withTimeout`'s own timer — never by fx. Distinguishing it
 *  by class (not by matching the message text) is what lets `isTimeoutError`
 *  tell "we gave up waiting" apart from an fx-supplied error whose message
 *  happens to start with the same words (see `isTimeoutError`). */
class RpcTimeoutError extends Error {}

/** Rejection shape for a real JSON-RPC error reply from fx (as opposed to
 *  `RpcTimeoutError`, which is ours). `code` is the JSON-RPC error code —
 *  callers use it to distinguish a credential re-check failure (`-32600`,
 *  see the header's "Facts verified against fx 0.0.5/0.0.6/0.0.7" section)
 *  from every other protocol error, without re-parsing `message`. The message
 *  text itself is UNCHANGED from before this class existed
 *  (`"<fx message> (code <n>)"`) so every existing message-based assertion
 *  still holds — `code` is purely additive. `rawMessage` is fx's error
 *  message BYTE-FOR-BYTE, with no `(code <n>)` suffix appended — callers
 *  that need to surface fx's own text verbatim (the `session/load` and
 *  `session/prompt` `-32600` catches in `runFxTurn`) read `rawMessage`
 *  instead of `message`. Falls back to the composed `message` on the rare
 *  reply that omits `error.message` entirely. */
class RpcError extends Error {
  code: number | undefined;
  rawMessage: string;
  constructor(message: string, code: number | undefined, rawMessage?: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.rawMessage = rawMessage ?? message;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new RpcTimeoutError(`timed out waiting for ${label} (${ms}ms)`)), ms);
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
      const rawMessage = msg.error.message ?? "fx acp error";
      pending.reject(
        new RpcError(`${rawMessage} (code ${msg.error.code ?? "?"})`, msg.error.code, rawMessage),
      );
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
    // `void`d because ask/auto mode now `await`s a card answer that may take
    // arbitrarily long (a human, not a promise that resolves this tick) —
    // handleServerRequest itself must stay synchronous so the stdout pump
    // (single-threaded line dispatch loop) never stalls behind an open card
    // while later lines (including a RACING session/cancel notification's
    // effects) keep arriving. A carded (ask/auto) request's id lands in
    // `cardIdByRequestId` synchronously, inside respondPermissionRequest,
    // before its `await answer` — that's the only bookkeeping a later
    // cancelFxTurn/settleFx sweep needs; a non-carded (yolo/unknown) request
    // answers synchronously with no await in between, so it's never still
    // pending by the time a sweep could run.
    //
    // Fail closed: `registerFxPermission`'s synchronous broadcast to SSE
    // listeners can throw through an arbitrary listener callback, and a
    // thrown rejection here must never strand fx awaiting a reply that will
    // now never come. Answer `cancelled` and drop the request's bookkeeping
    // so a later cancelFxTurn/settleFx sweep doesn't try to resolve an id
    // that's already dead.
    void respondPermissionRequest(
      state,
      id,
      params as
        | {
            options?: Array<{ optionId: string; name?: string; kind?: string }>;
            toolCall?: { toolCallId?: string; title?: string; kind?: string; rawInput?: unknown };
          }
        | undefined,
    ).catch((err) => {
      emit(state, "status", `fx acp: permission handling failed: ${errMessage(err)}`);
      respondCancelled(state, id);
      state.cardIdByRequestId.delete(id);
    });
    return;
  }
  // fx advertised no fs/terminal capabilities at `initialize` — it
  // shouldn't ask for them, but don't silently ignore it if it does.
  emit(state, "status", `fx acp: unsupported request from agent: ${method}`);
  respondRpcError(state, id, -32601, "Method not found");
}

async function respondPermissionRequest(
  state: FxSessionState,
  id: number | string,
  params:
    | {
        options?: Array<{ optionId: string; name?: string; kind?: string }>;
        toolCall?: { toolCallId?: string; title?: string; kind?: string; rawInput?: unknown };
      }
    | undefined,
): Promise<void> {
  // A request that arrives once cancellation is underway (or after the turn
  // already settled) must not be policy-answered — in auto/yolo mode the
  // permissive arm would authorize fx to START a new tool action in the
  // middle of a user-initiated Stop. ACP's cancellation contract is that the
  // client answers such requests with outcome "cancelled". Checked BEFORE
  // ever registering a card — no card should exist for a request that's
  // already moot.
  if (state.cancelRequested || state.resolved) {
    respondCancelled(state, id);
    return;
  }

  const options = Array.isArray(params?.options) ? params!.options! : [];

  if (state.mode === "yolo") {
    // Prefer allow_once over allow_always so an approval stays scoped to
    // this turn instead of writing a durable rule into the user's fx
    // config; falls back to any offered option rather than cancelling —
    // yolo never surfaces a card.
    answerByKind(state, id, options, ["allow_once", "allow_always"], true);
    return;
  }

  if (state.mode !== "auto" && state.mode !== "ask") {
    // Fail-closed: any unknown/future mode id takes the reject arm and
    // never surfaces a card, with no first-option fallback.
    answerByKind(state, id, options, ["reject_once", "reject_always"]);
    return;
  }

  // ask AND auto both card — auto does not auto-allow. Register an
  // fx_permission card and await its answer instead of answering
  // synchronously. `toolCall`/`options` are sanitized down to exactly the
  // fields the card needs; only `toolCallId` is guaranteed on the wire per
  // ACP's schema, so every other field is optional-checked.
  const rawToolCall = params?.toolCall;
  const toolCall: FxPermissionToolCall = {
    toolCallId: typeof rawToolCall?.toolCallId === "string" ? rawToolCall.toolCallId : "unknown",
    title: typeof rawToolCall?.title === "string" ? rawToolCall.title : undefined,
    kind: typeof rawToolCall?.kind === "string" ? rawToolCall.kind : undefined,
    rawInput: rawToolCall && "rawInput" in rawToolCall ? rawToolCall.rawInput : undefined,
  };
  const cardOptions: FxPermissionOption[] = options.map((o) => ({
    optionId: o.optionId,
    name: typeof o.name === "string" && o.name.length > 0 ? o.name : o.optionId,
    kind: o.kind,
  }));

  // ACP's schema only guarantees `toolCallId` on this request — `options`
  // may be absent or empty, and this file never trusts that silently. An
  // unanswerable card (nothing for the user to click) must never register;
  // answer cancelled up front instead, and say so out loud so a silent
  // cancel is diagnosable rather than looking like the card vanished.
  if (cardOptions.length === 0) {
    // Emit BEFORE replying: if `emit` throws (`onChunk` → `appendEvent` can,
    // e.g. a FK error against a since-deleted run), the reply below must
    // never have gone out yet, so `handleServerRequest`'s catch-all fallback
    // is the only thing that replies — see the file header's "Settlement
    // invariant" note. Reversing this order would let both this call and the
    // catch-all's `respondCancelled` write a reply for the same id.
    emit(state, "status", "fx acp: permission request had no options — auto-cancelled");
    respondCancelled(state, id);
    return;
  }

  const { id: cardId, answer } = registerFxPermission({
    taskId: state.taskId,
    runId: state.runId,
    toolCall,
    options: cardOptions,
    mode: state.mode,
  });
  state.cardIdByRequestId.set(id, cardId);

  let answer_: FxPermissionAnswer;
  try {
    answer_ = await answer;
  } finally {
    // Whatever the outcome, this id no longer has an open card once the
    // promise settles — remove it BEFORE the state.resolved check below so
    // a concurrent cancelFxTurn/settleFx sweep racing this same tick never
    // sees (and tries to re-resolve) an id whose card has already resolved.
    state.cardIdByRequestId.delete(id);
  }

  // The turn may have settled (death, cancel-timeout force-kill, or a
  // same-tick turn-end) WHILE this card was open — the stdin pipe backing
  // `respondRpc` may already be closing/closed by the time the await above
  // returns, so a resolution arriving after settlement must not attempt a
  // reply at all (see header: Settlement invariant).
  if (state.resolved) {
    return;
  }

  // A selected answer landing during cancellation must NOT become outcome
  // "selected" — ACP's contract is that every pending request answers
  // cancelled once session/cancel is sent, and a card answer racing that
  // (e.g. the HTTP answer route resolving just before cancelFxTurn's drain
  // loop reaches this id) must still lose to the cancellation.
  if (state.cancelRequested) {
    respondCancelled(state, id);
    return;
  }

  if ("cancelled" in answer_ && answer_.cancelled) {
    respondCancelled(state, id);
  } else if ("optionId" in answer_ && cardOptions.some((o) => o.optionId === answer_.optionId)) {
    // Belt-and-suspenders — the HTTP answer route validates the optionId
    // against the same request before ever calling `answerFxPermission`,
    // but a second check here costs nothing and means this driver never
    // trusts a value it didn't itself offer.
    respondRpc(state, id, { outcome: { outcome: "selected", optionId: answer_.optionId } });
  } else {
    respondCancelled(state, id);
  }
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

/** A chunk `mapFxUpdate` wants emitted — the pure equivalent of an `emit()`
 *  call, minus the dedup/settled-turn gating `emit` itself applies. */
interface FxChunk {
  stream: RunEventStream;
  data: string;
  lineUuid?: string;
}

/**
 * Pure `session/update` → chunk(s) mapper — mirrors `mapCodexEvent` /
 * `mapCursorEvent` / `mapGeminiEvent` being exported, side-effect-free
 * functions the fake-server driver tests don't need to spawn a child to
 * exercise. `ctx.nextSeq` stands in for the stateful `state.seq++` the
 * inline version used; callers pass `() => state.seq++` to keep the
 * sequence shared across a whole run.
 */
export function mapFxUpdate(update: Record<string, unknown>, ctx: { runId: string; nextSeq: () => number }): FxChunk[] {
  const kind = update.sessionUpdate;
  switch (kind) {
    case "agent_message_chunk": {
      const text = extractText(update.content);
      return text ? [{ stream: "assistant", data: text, lineUuid: `fx:${ctx.runId}:${ctx.nextSeq()}` }] : [];
    }

    case "agent_thought_chunk": {
      const text = extractText(update.content);
      return text ? [{ stream: "thinking", data: text, lineUuid: `fx:${ctx.runId}:${ctx.nextSeq()}` }] : [];
    }

    case "tool_call": {
      const id =
        typeof update.toolCallId === "string"
          ? update.toolCallId
          : // No real id to correlate a later tool_call_update against —
            // still worth emitting (a seq-based id renders fine on its
            // own), it just can never pair with a result (see the
            // tool_call_update branch).
            `seq${ctx.nextSeq()}`;
      return [
        {
          stream: "tool_use",
          data: JSON.stringify({ id, name: toolCallName(update), input: toolCallInput(update), serverSide: false }),
          lineUuid: `fx:tool:${id}:use`,
        },
      ];
    }

    case "tool_call_update": {
      const status = update.status;
      if (status !== "completed" && status !== "failed") return []; // pending/in_progress — ignore
      // Without a real toolCallId there is nothing to pair this result with
      // the tool_use it completes — minting an independent seq-based id here
      // would never match the use event's id (different seq counter state),
      // so drop the event rather than emit an unpairable orphan.
      if (typeof update.toolCallId !== "string") return [];
      const id = update.toolCallId;
      return [
        {
          stream: "tool_result",
          data: JSON.stringify({ toolUseId: id, content: toolResultContent(update), isError: status === "failed" }),
          lineUuid: `fx:tool:${id}:result`,
        },
      ];
    }

    case "plan": {
      // Full snapshot semantics (ACP: "client replaces the entire plan with
      // each update") — mirrors legacy TodoWrite exactly, so this rides the
      // existing TODO tracker (shared/todo-progress.ts) with zero new UI.
      // A non-array `entries` is malformed — ignore the whole update rather
      // than emit a bogus empty list (which would read as an explicit
      // clear, a different thing). An actual empty array IS a valid
      // explicit clear and must still emit.
      const rawEntries = (update as { entries?: unknown }).entries;
      if (!Array.isArray(rawEntries)) return [];
      const todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> = [];
      for (const raw of rawEntries) {
        // Individual malformed entries are dropped, not fatal to the rest
        // of the snapshot — mirrors coerceTodoItem's per-item tolerance in
        // shared/todo-progress.ts (which also re-coerces this same payload
        // downstream, so this is belt-and-suspenders, not the only guard).
        if (raw == null || typeof raw !== "object") continue;
        const r = raw as Record<string, unknown>;
        if (typeof r.content !== "string" || r.content.trim() === "") continue;
        const status =
          r.status === "pending" || r.status === "in_progress" || r.status === "completed" ? r.status : "pending";
        // `priority` is intentionally dropped — the TODO tracker has no
        // priority concept (recorded as a known reduction in the plan doc).
        todos.push({ content: r.content, status });
      }
      return [
        {
          stream: "tool_use",
          data: JSON.stringify({ id: "fx-plan", name: "TodoWrite", input: { todos }, serverSide: false }),
          lineUuid: `fx:${ctx.runId}:${ctx.nextSeq()}`,
        },
      ];
    }

    case "usage_update": {
      const used = (update as { used?: unknown }).used;
      const size = (update as { size?: unknown }).size;
      // Missing/non-numeric used|size is malformed — ignore silently rather
      // than emit a chip with holes in it.
      if (typeof used !== "number" || typeof size !== "number") return [];
      const rawCost = (update as { cost?: unknown }).cost;
      let cost: { amount: number; currency: string } | undefined;
      if (rawCost != null && typeof rawCost === "object") {
        const c = rawCost as Record<string, unknown>;
        if (typeof c.amount === "number" && typeof c.currency === "string") {
          cost = { amount: c.amount, currency: c.currency };
        }
        // A malformed cost object is dropped on its own — used/size still
        // emit rather than losing the whole update over an optional field.
      }
      return [
        {
          stream: "status",
          data: FX_USAGE_STATUS_PREFIX + JSON.stringify({ used, size, ...(cost ? { cost } : {}) }),
          lineUuid: `fx:${ctx.runId}:${ctx.nextSeq()}`,
        },
      ];
    }

    default:
      // current_mode_update, available_commands_update, user_message_chunk,
      // session_info_update, config_option_update, and any future variant —
      // silent forward-compat (v1 scope).
      return [];
  }
}

/** `dispatchSessionUpdate` is the stateful adapter around the pure
 *  `mapFxUpdate`: it supplies `ctx` from the session's own runId/seq
 *  counter and routes every resulting chunk through `emit` (dedup +
 *  settled-turn gating), same as before the extraction. */
function dispatchSessionUpdate(state: FxSessionState, update: Record<string, unknown>): void {
  for (const c of mapFxUpdate(update, { runId: state.runId, nextSeq: () => state.seq++ })) {
    emit(state, c.stream, c.data, c.lineUuid);
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
  // Sweep any still-open fx_permission card so it never outlives the
  // driver — process death mid-card (the most common way settleFx runs
  // without ever going through cancelFxTurn's drain loop) would otherwise
  // leak a registry entry the UI keeps showing a card for forever (see
  // header: Settlement invariant).
  for (const cardId of state.cardIdByRequestId.values()) {
    answerFxPermission(cardId, { cancelled: true });
  }
  state.cardIdByRequestId.clear();
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

/** Wait for the turn to settle, or `timeoutMs` to elapse — whichever comes
 *  first. Races `state.done` (resolved the instant `settleFx` runs, via
 *  `resolveDone`) against a timer, rather than polling `state.resolved` on
 *  an interval. The timer handle is hoisted so it can be cleared once the
 *  race settles — otherwise a turn that resolves before `timeoutMs` elapses
 *  leaves a live timer behind for the remainder of the timeout window. */
async function waitUntilResolved(state: FxSessionState, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([state.done, timeout]);
  clearTimeout(timer!);
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
  // Drain every still-open carded (ask/auto) permission request through the
  // registry (see header: Settlement invariant) — a non-carded (yolo/
  // unknown) request answers synchronously with no await in between, so it
  // can never still be pending by the time this runs; `cardIdByRequestId`
  // alone is a complete picture. Snapshot to an array first since the map
  // isn't mutated inline here — that happens in respondPermissionRequest
  // once its await resolves.
  for (const cardId of Array.from(state.cardIdByRequestId.values())) {
    answerFxPermission(cardId, { cancelled: true });
  }

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

/** Pull the active provider id out of a `session/new`/`session/resume`/
 *  `session/load` result's `configOptions` array (0.0.5+, additive — see
 *  the file header's "Facts verified against fx 0.0.5/0.0.6/0.0.7" section).
 *  Pure and exported for the same reason `mapFxUpdate` is: unit-testable
 *  against a raw result object without spawning a child. Tolerates a
 *  missing/non-array `configOptions` (0.0.4 binaries, or a response that
 *  omits it) and any entry shape ACP's schema doesn't guarantee — returns
 *  `null` rather than throwing. */
export function extractFxProviderValue(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const configOptions = (result as { configOptions?: unknown }).configOptions;
  if (!Array.isArray(configOptions)) return null;
  for (const entry of configOptions) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    const currentValue = (entry as { currentValue?: unknown }).currentValue;
    // Bounded: this string rides straight into a run-row chip with no
    // truncation of its own — an absurdly long value (bug, or a hostile/
    // misbehaving fx binary) would blow out the chip's layout, so anything
    // over 64 chars is treated the same as absent.
    if (
      id === "provider" &&
      typeof currentValue === "string" &&
      currentValue.length > 0 &&
      currentValue.length <= 64
    ) {
      return currentValue;
    }
  }
  return null;
}

async function runFxTurn(
  state: FxSessionState,
  opts: { cwd: string; promptText: string; resumeSessionId?: string },
): Promise<void> {
  // Emits the `FX_PROVIDER_STATUS_PREFIX` status chunk at most once per
  // turn, from whichever of session/new|resume|load's results carries a
  // `configOptions` provider entry first — see the file header's "Facts
  // verified against fx 0.0.5/0.0.6/0.0.7" section.
  let providerEmitted = false;
  function maybeEmitProvider(result: unknown): void {
    if (providerEmitted) return;
    const value = extractFxProviderValue(result);
    if (value) {
      emit(state, "status", FX_PROVIDER_STATUS_PREFIX + value, `fx:${state.runId}:${state.seq++}`);
      providerEmitted = true;
    }
  }

  // 1. initialize
  try {
    await withTimeout(
      sendRpc(state, "initialize", {
        // Must be the NUMBER 1, not the string "1" — fx replies -32602
        // (Invalid params) to a stringified protocolVersion (SPIKE-VERIFIED).
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
      const resumeResult = await withTimeout(
        sendRpc(state, "session/resume", { sessionId: opts.resumeSessionId }),
        RPC_HANDSHAKE_TIMEOUT_MS,
        "session/resume",
      );
      maybeEmitProvider(resumeResult);
      resumed = true;
    } catch (err) {
      if (isTimeoutError(err)) {
        failTurn(state, describeHandshakeFailure(err, "session/resume", RPC_HANDSHAKE_TIMEOUT_MS));
        return;
      }
      // Method-not-found / invalid-params / -32600 (or any other resume
      // error) — fall back to session/load below. `-32600` is JSON-RPC's
      // generic "Invalid Request" code, not an auth-specific one — fx
      // merely reuses it for credential failures (0.0.5+, see the file
      // header) — so it gets no special early-exit here: whether this
      // -32600 was the credential gate or fx rejecting resume as
      // unsupported, `session/load`'s own outcome (below) is what decides
      // the turn.
    }
    if (state.resolved) return;
    if (!resumed) {
      // fx replays the session's prior `session/update` history while
      // `session/load` is pending (SCHEMA-DERIVED — unexercised in the
      // spike) — the run's own persisted events already cover that
      // history, so it's discarded here rather than double-emitted.
      state.suppressUpdates = true;
      try {
        const loadResult = await withTimeout(
          sendRpc(state, "session/load", { sessionId: opts.resumeSessionId, cwd: opts.cwd, mcpServers: [] }),
          RPC_HANDSHAKE_TIMEOUT_MS,
          "session/load",
        );
        maybeEmitProvider(loadResult);
      } catch (err) {
        state.suppressUpdates = false;
        if (isTimeoutError(err)) {
          failTurn(state, describeHandshakeFailure(err, "session/load", RPC_HANDSHAKE_TIMEOUT_MS));
        } else if (err instanceof RpcError && err.code === -32600) {
          // Credential re-check failed here too (0.0.5+, see the file
          // header) — authoritative either way it reads: the same gate
          // resume just hit (load can't do better), or a non-auth "Invalid
          // Request" for which `session/load` was precisely the graceful
          // path to try. Surface fx's text verbatim, no wrapper.
          failTurn(state, err.rawMessage);
        } else {
          failTurn(state, `fx acp: failed to resume session ${opts.resumeSessionId}: ${errMessage(err)}`);
        }
        return;
      }
      state.suppressUpdates = false;
    }
    if (state.resolved) return;
  } else {
    let sessionResult:
      | { sessionId?: string; modes?: { availableModes?: Array<{ id?: string }> }; configOptions?: unknown }
      | undefined;
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
    maybeEmitProvider(sessionResult);

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
    if (err instanceof RpcError && err.code === -32600) {
      // Credential re-check failed mid-prompt (0.0.5+, see the file
      // header) — fx's text is user-actionable on its own; surface it
      // verbatim (via rawMessage, with no "(code -32600)" suffix) instead
      // of wrapping it in our own "session/prompt failed:" prefix.
      failTurn(state, err.rawMessage);
    } else {
      failTurn(state, `fx acp: session/prompt failed: ${errMessage(err)}`);
    }
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
  return err instanceof RpcTimeoutError;
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
 * the orchestrator/agents.ts wiring is mechanical.
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

  // Built before `state` so both `resolveDone` and `done` can be assigned
  // as plain fields on the state object at construction time (the executor
  // runs synchronously, so `resolveDone` is already the real resolver by
  // the time the object literal below evaluates it) — `waitUntilResolved`
  // needs `state.done` to race against, not just a resolver to call.
  let resolveDone: (code: number) => void = () => { /* replaced synchronously below */ };
  const done = new Promise<number>((resolve) => { resolveDone = resolve; });

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
    cardIdByRequestId: new Map(),
    seq: 0,
    seenLineUuids: new Set(),
    resolved: false,
    killRequested: false,
    cancelRequested: false,
    resolveDone,
    done,
  };
  fxSessions.set(opts.taskId, state);

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
