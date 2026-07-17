import {
  existsSync,
  mkdirSync,
  watch as fsWatch,
  type FSWatcher,
  openSync as fsOpenSync,
  readSync as fsReadSync,
  closeSync as fsCloseSync,
  statSync as fsStatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { dataDir } from "./db.ts";
import { resolveTmuxBin, tmuxSocketArgs } from "./tmux-resolution.ts";
import { SESSION_DIED_STATUS_PREFIX, KIMI_RETRYABLE_STATUS_PREFIX } from "../shared/types.ts";
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
 * Driver that hosts a single `kimi --print` turn inside a per-task tmux
 * session and exposes structured streaming by tailing the newline-delimited
 * JSON message log kimi writes (via `--output-format stream-json`).
 *
 * Architecturally this is codex-tmux's pattern (see that file's header for
 * the "why tmux at all" rationale — restart survival for a one-shot child
 * process) adapted to two places where kimi's headless surface differs from
 * codex's:
 *
 * 1. **No in-stream terminal event.** codex's `--json` log ends with a
 *    `turn.completed` / `turn.failed` event that the mapper turns into a
 *    `done` signal. Kimi's `--output-format stream-json` is doc-verified to
 *    emit only OpenAI-chat-shaped messages (assistant/tool/user) — there is
 *    no documented "turn finished" event on stdout. So `mapKimiEvent` is a
 *    pure content mapper with no `done` return; turn completion is decided
 *    entirely by the tmux session dying (kimi is one-shot per turn, so that
 *    is the *expected*, not exceptional, end state) combined with an
 *    **exit-code sidecar file** the shell wrapper writes after kimi exits.
 *    The wrapper is therefore `sh -c '<argv> < prompt > log 2>&1; echo $? >
 *    exit'` — deliberately WITHOUT `exec` (unlike codex's wrapper), because
 *    `exec` would replace the shell with kimi and the trailing `echo` would
 *    never run.
 * 2. **Session id known at spawn time, not discovered from the stream.**
 *    kimi's `--session <id>` flag resumes-or-creates, so agetor can
 *    pre-generate (or reuse a persisted) uuid and pass it straight through
 *    in `argv` (built by the caller, exactly like codex's `resume
 *    <thread_id>`). There is nothing to parse out of the log, so
 *    `onSessionId` fires synchronously right after the tmux session starts
 *    rather than being driven by a `thread.started`-shaped event.
 *
 * One practical consequence of (1): because completion is only ever detected
 * via the death watch (never short-circuited by an in-stream event the way
 * codex's `turn.completed` short-circuits it), every kimi turn pays the
 * death watch's built-in "log gone quiet" veto latency
 * (`DEATH_JSONL_QUIET_MS`) before it's declared finished — typically a few
 * seconds after kimi's own process has already exited. This is an accepted
 * trade-off for reusing the shared, well-tested death-watch primitives from
 * claude-tmux.ts rather than inventing a second detection path.
 *
 * ## wire.jsonl thinking tailer (best-effort)
 *
 * Kimi's reasoning is absent from the `stream-json` stdout stream by design
 * (it's an OpenAI-chat-shaped log — no `reasoning`/`thinking` field), but
 * both kimi products persist it to an internal `wire.jsonl` artifact per
 * session. A second, independent tailer inside this file (not a new module)
 * discovers and follows that file to surface `thinking` chunks in the run
 * panel:
 *
 * - **Layouts probed** (first existing candidate wins — see
 *   `discoverKimiWirePath`): `<home>/.kimi/sessions/<hash>/<sessionId>/wire.jsonl`
 *   (kimi-cli) and `<kimiCodeHome>/sessions/<slug>/<sessionId>/agents/main/wire.jsonl`
 *   (kimi-code). Rather than reimplementing either product's own hashing
 *   scheme for the session-root directory name, we scan one level and match
 *   on a child directory literally named `<sessionId>` — our own uuid,
 *   unique enough that a false match is not a concern.
 * - **Leaf shape** (identical in both products, verified against both
 *   repos' source): `{"type":"think","think":"<text>","encrypted":null|string}`,
 *   wrapped in one of two envelopes — `{"message":{"type":…,"payload":{…leaf…}}}`
 *   (kimi-cli) or `{"event":{"type":"content.part","part":{…leaf…}}}`
 *   (kimi-code). See `mapKimiWireEvent`, the pure/exported/unit-tested
 *   mapper. Thinking arrives as coalesced chunks, not per-token deltas.
 * - **Kill switch**: `AGETOR_KIMI_TRACK_THINKING=0` disables the tailer
 *   entirely for the run (checked once at tailer start) — precedent:
 *   `AGETOR_GROK_TRACK_SUBAGENTS`. Default ON.
 * - **Best-effort semantics throughout**: a malformed wire.jsonl line is
 *   silently ignored (never surfaced as stderr — unlike `mapKimiEvent`,
 *   which treats malformed stdout as a real error worth surfacing); a
 *   `wire.jsonl` that never appears within `WIRE_DISCOVERY_TIMEOUT_MS`
 *   silently stops being probed; a metadata header whose
 *   `protocol_version` major isn't "1" disables the tailer for the rest of
 *   the run rather than risk misparsing an incompatible leaf shape. Worst
 *   case in every failure mode: no `thinking` chunks render for that run —
 *   never an error surfaced to the user, never a delay to the primary
 *   stream. The tailer is multiplexed onto the same 150ms poll interval as
 *   the primary log (see `tickKimiWire`), self-throttling its own discovery
 *   probes to a slower cadence, and shares that timer's lifecycle —
 *   `disposeKimiState` tearing down `pollTimer` stops both.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * Paths (derivable from runId alone, so reattach can recompute them).
 * ────────────────────────────────────────────────────────────────────────── */

const KIMI_LOG_DIR = path.join(dataDir, "kimi-logs");

export function kimiLogPath(runId: string): string {
  return path.join(KIMI_LOG_DIR, `${runId}.jsonl`);
}
function kimiPromptPath(runId: string): string {
  return path.join(KIMI_LOG_DIR, `${runId}.prompt.txt`);
}
function kimiExitPath(runId: string): string {
  return path.join(KIMI_LOG_DIR, `${runId}.exit`);
}
function ensureLogDir(): void {
  if (!existsSync(KIMI_LOG_DIR)) mkdirSync(KIMI_LOG_DIR, { recursive: true });
}

/** Read the exit-code sidecar. Returns `null` when the file is missing or
 *  unparsable — the caller treats that as "process vanished without ever
 *  writing it" (a genuine death), never as success. */
function readKimiExitCode(runId: string): number | null {
  try {
    const raw = readFileSync(kimiExitPath(runId), "utf8").trim();
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Event mapping (kimi `stream-json` message → agetor RunEvent chunks).
 * ────────────────────────────────────────────────────────────────────────── */

interface KimiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
  [k: string]: unknown;
}
interface KimiContentPart {
  type?: string;
  text?: string;
  [k: string]: unknown;
}
interface KimiMessage {
  role?: string;
  content?: string | KimiContentPart[] | unknown;
  tool_calls?: KimiToolCall[];
  tool_call_id?: string;
  [k: string]: unknown;
}

/** Extract plain text from an OpenAI-chat-shaped `content` field, which may
 *  be a bare string or an array of typed parts (only text parts contribute;
 *  everything else is dropped defensively since the exact part shapes are
 *  doc-unverified). */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as KimiContentPart).text === "string") {
          return (part as KimiContentPart).text as string;
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
}

/**
 * Map a single raw JSONL line from kimi's `stream-json` output to zero or
 * more chunks. Pure and unit-testable: takes the raw line (not a pre-parsed
 * object) so malformed-JSON tolerance lives in one place. `lineNo` is the
 * caller's count of complete, non-blank lines seen so far in this run's log
 * — deterministic from file content alone (not wall-clock), which is what
 * makes `line_uuid` stable across a reattach replay from offset 0.
 *
 * line_uuid scheme: `kimi:<lineNo>` for the line's primary chunk (assistant
 * text, or a tool_result). A single assistant line can also carry multiple
 * `tool_calls`, each of which needs its own dedup key to avoid colliding on
 * the `(run_id, line_uuid)` unique index — those get `kimi:<lineNo>:tool:<id>`.
 */
export function mapKimiEvent(line: string, onChunk: ChunkHandler, lineNo: number): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: KimiMessage;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    // Not JSON — kimi shouldn't emit this under `--output-format stream-json`,
    // but surface it rather than drop it (mirrors codex-tmux.ts): a launch or
    // auth failure from the shell wrapper is exactly the kind of thing that
    // must reach the run panel instead of vanishing into the log. Keep the
    // `kimi:<lineNo>` dedup key so a reattach replay from offset 0 stays
    // idempotent instead of re-emitting the same stderr line.
    onChunk("stderr", trimmed, `kimi:${lineNo}`);
    return;
  }

  const base = `kimi:${lineNo}`;
  switch (msg.role) {
    case "user":
      // Prompt echo — kimi restates the input turn on stdin; nothing to render.
      return;

    case "assistant": {
      const text = extractText(msg.content);
      if (text) onChunk("assistant", text, base);

      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      calls.forEach((call, idx) => {
        // kimi's tool_calls schema is doc-unverified; emitters sometimes omit
        // `type` entirely. Only skip when it's present and explicitly not
        // "function" — don't require it to be present.
        if (!call || (call.type && call.type !== "function")) return;
        const fn = call.function ?? {};
        const id = typeof call.id === "string" && call.id ? call.id : `${lineNo}-${idx}`;
        let input: unknown = fn.arguments;
        if (typeof fn.arguments === "string") {
          try {
            input = JSON.parse(fn.arguments);
          } catch {
            input = fn.arguments; // pass through raw text if it isn't JSON
          }
        }
        onChunk(
          "tool_use",
          JSON.stringify({ id, name: fn.name ?? "unknown", input, serverSide: false }),
          `${base}:tool:${id}`,
        );
      });
      return;
    }

    case "tool": {
      const toolUseId = typeof msg.tool_call_id === "string" ? msg.tool_call_id : undefined;
      const content = extractText(msg.content);
      onChunk(
        "tool_result",
        JSON.stringify({ toolUseId, content, isError: false }),
        base,
      );
      return;
    }

    default:
      // Unknown/forward-compat role — silent, log-level only.
      console.error(`[kimi-tmux] unrecognized role on line ${lineNo}: ${String(msg.role)}`);
      return;
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Session state + tailer.
 * ────────────────────────────────────────────────────────────────────────── */

interface KimiSessionState {
  taskId: string;
  runId: string;
  sessionName: string;
  logPath: string;
  offset: number;
  /** Holds incomplete trailing UTF-8 byte sequences across reads so a
   *  multi-byte character split on a poll boundary isn't corrupted. */
  decoder: StringDecoder;
  partial: string;
  /** Count of complete, non-blank lines dispatched so far — the `lineNo`
   *  fed to `mapKimiEvent`. Deterministic from file content, so a reattach
   *  (offset reset to 0) reproduces the exact same numbering. */
  lineNo: number;
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

  /* ── wire.jsonl thinking tailer (best-effort — see file header) ────────── */

  /** kimi's `--session` uuid — the directory name the tailer looks for under
   *  both candidate session roots. Empty string when unknown (reattach
   *  without a persisted session id), which disables discovery outright. */
  sessionId: string;
  /** The cwd the turn is running in. Not currently used for discovery
   *  (session dirs are keyed by a content hash agetor doesn't reimplement —
   *  see the header), but carried on the state for future use and so
   *  callers have one place to pass it through. */
  cwd: string;
  /** Resolved HOME root used to build the kimi-cli candidate
   *  (`<home>/.kimi/sessions/<hash>/<sessionId>/wire.jsonl`). */
  home: string;
  /** Resolved KIMI_CODE_HOME root used to build the kimi-code candidate
   *  (`<kimiCodeHome>/sessions/<slug>/<sessionId>/agents/main/wire.jsonl`). */
  kimiCodeHome: string;
  /** Discovered wire.jsonl path, or null while still probing. */
  wirePath: string | null;
  wireOffset: number;
  wirePartial: string;
  wireLineNo: number;
  wireDecoder: StringDecoder;
  /** `Date.now()` deadline after which discovery gives up silently. */
  wireDiscoveryDeadline: number;
  /** Set true by the kill switch, a missing sessionId, discovery timeout, or
   *  a `mapKimiWireEvent` protocol-version mismatch. Once true the tailer
   *  does no further work for the rest of this run. */
  wireDisabled: boolean;
  /** Counts poll ticks while `wirePath` is still null, so discovery (a
   *  readdir per candidate root) runs on a slower cadence than the 150ms
   *  primary-log poll rather than on every tick. */
  wireDiscoveryTickCount: number;
}

const kimiSessions = new Map<string, KimiSessionState>(); // taskId -> state

const POLL_MS = 150;
const DEATH_POLL_MS = 400;
/** Grace after the tmux session disappears before we resolve, so the final
 *  appended bytes (and the exit-code sidecar, which the shell writes right
 *  after kimi exits but slightly before the session itself tears down) are
 *  flushed and read. */
const DEATH_GRACE_MS = 250;

/** How long the wire tailer keeps probing for wire.jsonl before giving up
 *  silently. kimi may take a beat to create the session dir + write the
 *  metadata header line; after this, thinking just doesn't render for the
 *  run — best-effort, never surfaced as an error. */
const WIRE_DISCOVERY_TIMEOUT_MS = 60_000;
/** Run discovery (readdir on both candidate roots) once every N primary
 *  poll ticks (~150ms each) instead of every tick, once wirePath is found
 *  this no longer applies (flushKimiWire runs every tick like the primary
 *  log). */
const WIRE_DISCOVERY_EVERY_N_TICKS = 7; // ≈1s at POLL_MS=150

function wireTrackingDisabled(): boolean {
  // Kill switch, precedent: AGETOR_GROK_TRACK_SUBAGENTS. Checked once at
  // tailer start (not re-read mid-run) — flipping the env var doesn't affect
  // an in-flight run.
  return process.env.AGETOR_KIMI_TRACK_THINKING === "0";
}

/** Resolve the HOME / KIMI_CODE_HOME roots the wire tailer probes under.
 *  Mirrors `harnessEnv()`'s per-harness home block in agents.ts: an aliased
 *  harness re-homes both vars to the same directory, so a spawn caller
 *  should pass `opts.env.HOME`/`opts.env.KIMI_CODE_HOME` straight through;
 *  a reattach caller (which doesn't have the merged spawn env available)
 *  passes the harness's resolved `home` field via `homeOverride` /
 *  `kimiCodeHomeOverride`. Falls back to the process's own os.homedir() and
 *  `<home>/.kimi-code`, which is only correct for the built-in (non-aliased)
 *  harness — an aliased harness reattaching without an override will simply
 *  look in the wrong place and time out silently (best-effort, no error). */
function resolveKimiHomeRoots(
  homeOverride: string | null | undefined,
  kimiCodeHomeOverride: string | null | undefined,
): { home: string; kimiCodeHome: string } {
  const home = homeOverride || os.homedir();
  const kimiCodeHome = kimiCodeHomeOverride || path.join(home, ".kimi-code");
  return { home, kimiCodeHome };
}

/** Probe both candidate session-root layouts for a directory literally named
 *  `state.sessionId` (our own uuid — unique enough that we don't need to
 *  reimplement either product's own hashing scheme to find it) and return
 *  the first existing `wire.jsonl` path, or null if neither is present yet.
 *  All fs errors (root doesn't exist, permission denied, …) are swallowed —
 *  this runs on a timer and errors here must never surface as noise. */
function discoverKimiWirePath(state: KimiSessionState): string | null {
  if (!state.sessionId) return null;

  // kimi-cli: <home>/.kimi/sessions/<hash-of-cwd>/<sessionId>/wire.jsonl
  try {
    const cliSessionsDir = path.join(state.home, ".kimi", "sessions");
    for (const entry of readdirSync(cliSessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(cliSessionsDir, entry.name, state.sessionId, "wire.jsonl");
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* root doesn't exist yet, or transient fs error — keep probing */ }

  // kimi-code: <kimiCodeHome>/sessions/<slug>/<sessionId>/agents/main/wire.jsonl
  try {
    const codeSessionsDir = path.join(state.kimiCodeHome, "sessions");
    for (const entry of readdirSync(codeSessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(codeSessionsDir, entry.name, state.sessionId, "agents", "main", "wire.jsonl");
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* root doesn't exist yet, or transient fs error — keep probing */ }

  return null;
}

/**
 * Pure mapper: extract a `thinking` chunk from one raw wire.jsonl line, if
 * present. Unlike {@link mapKimiEvent}, this is best-effort by design — the
 * wire log is an internal artifact, not a documented public contract, so a
 * malformed or unrecognized line is silently ignored rather than surfaced as
 * stderr noise. Handles exactly two envelope shapes (verified against both
 * products' source — see the file header):
 *
 *   - kimi-cli:  `{"message":{"type":"ContentPart"|"SubagentEvent","payload":{…leaf…}}}`
 *   - kimi-code: `{"event":{"type":"content.part","part":{…leaf…}}}`
 *
 * where the leaf is `{"type":"think","think":"<text>","encrypted":null|string}`.
 * `SubagentEvent`-wrapped messages are skipped in v1 (subagent thinking is
 * intentionally excluded — see plan §8.3). The metadata header line
 * (`{"type":"metadata","protocol_version":"1.10"}`) is recognized and
 * skipped; a major version other than "1" returns `{disable: true}` so the
 * caller stops tailing this run (the leaf shape is no longer trustworthy).
 *
 * Returns `{disable: true}` only for that one case; otherwise returns
 * `undefined` (nothing to disable, chunk already emitted via `onChunk` if
 * applicable).
 */
export function mapKimiWireEvent(
  line: string,
  onChunk: ChunkHandler,
  lineNo: number,
): { disable?: boolean } | void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return; // malformed — best-effort, no stderr noise (unlike mapKimiEvent)
  }
  if (!obj || typeof obj !== "object") return;
  const rec = obj as Record<string, unknown>;

  if (rec.type === "metadata") {
    const version = typeof rec.protocol_version === "string" ? rec.protocol_version : "";
    if (!version.startsWith("1.")) return { disable: true };
    return;
  }

  // kimi-cli shape.
  if (rec.message && typeof rec.message === "object") {
    const message = rec.message as Record<string, unknown>;
    if (message.type === "SubagentEvent") return; // v1: subagent thinking excluded
    emitKimiWireThink(message.payload, onChunk, lineNo);
    return;
  }

  // kimi-code shape.
  if (rec.event && typeof rec.event === "object") {
    const event = rec.event as Record<string, unknown>;
    if (event.type !== "content.part") return;
    emitKimiWireThink(event.part, onChunk, lineNo);
    return;
  }

  // Unrecognized shape — silent.
}

/** Shared leaf-extraction for both wire.jsonl envelope shapes: only a
 *  `{"type":"think","think":"<non-empty string>"}` leaf emits a chunk.
 *  Text/tool leaves and encrypted-only think leaves (no plaintext `think`
 *  field) are silently dropped. */
function emitKimiWireThink(leaf: unknown, onChunk: ChunkHandler, lineNo: number): void {
  if (!leaf || typeof leaf !== "object") return;
  const l = leaf as Record<string, unknown>;
  if (l.type !== "think") return;
  if (typeof l.think !== "string" || !l.think) return;
  onChunk("thinking", l.think, `kimiwire:${lineNo}`);
}

/** Read any bytes appended to the discovered wire.jsonl since
 *  `state.wireOffset`, split into complete lines, and dispatch each through
 *  {@link mapKimiWireEvent}. Mirrors `flushKimiLog`'s stat/read/offset/
 *  partial-utf8 skeleton, plus a truncation guard: kimi may rewrite/truncate
 *  the file (healing rewrites, session fork) — when the file has shrunk
 *  below our offset, reset to 0 and re-read from the start rather than
 *  erroring or stalling. The dedup keys (`kimiwire:<lineNo>`) make a
 *  replayed rewrite idempotent for identical content; content that
 *  genuinely diverged after a rewrite is accepted best-effort. */
function flushKimiWire(state: KimiSessionState): void {
  if (!state.wirePath) return;
  let fd: number;
  let size: number;
  try {
    size = fsStatSync(state.wirePath).size;
    if (size < state.wireOffset) {
      state.wireOffset = 0;
      state.wirePartial = "";
      state.wireLineNo = 0;
      state.wireDecoder = new StringDecoder("utf8");
    }
    if (size <= state.wireOffset) return;
    fd = fsOpenSync(state.wirePath, "r");
  } catch {
    return; // file vanished mid-tail, or transient stat error
  }
  try {
    const len = size - state.wireOffset;
    if (len <= 0) return;
    const buf = Buffer.allocUnsafe(len);
    const read = fsReadSync(fd, buf, 0, len, state.wireOffset);
    state.wireOffset += read;
    state.wirePartial += state.wireDecoder.write(buf.subarray(0, read));
  } finally {
    fsCloseSync(fd);
  }

  const lines = state.wirePartial.split("\n");
  state.wirePartial = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const lineNo = state.wireLineNo++;
    const onChunk: ChunkHandler = (stream, data, lineUuid) => {
      if (lineUuid) {
        if (state.seenLineUuids.has(lineUuid)) return;
        state.seenLineUuids.add(lineUuid);
      }
      state.onChunk(stream, data, lineUuid);
    };
    const result = mapKimiWireEvent(line, onChunk, lineNo);
    if (result?.disable) {
      state.wireDisabled = true;
      return;
    }
  }
}

/** Poll-tick entry point for the wire tailer: while undiscovered, probes for
 *  the wire.jsonl path on a slower cadence than the primary log poll (see
 *  `WIRE_DISCOVERY_EVERY_N_TICKS`); once found, flushes every tick like the
 *  primary log. No-ops once disabled (kill switch, missing sessionId,
 *  discovery timeout, or a protocol-version mismatch from
 *  `mapKimiWireEvent`). */
function tickKimiWire(state: KimiSessionState): void {
  if (state.wireDisabled) return;
  if (!state.wirePath) {
    if (Date.now() > state.wireDiscoveryDeadline) {
      state.wireDisabled = true;
      return;
    }
    state.wireDiscoveryTickCount++;
    if (state.wireDiscoveryTickCount % WIRE_DISCOVERY_EVERY_N_TICKS !== 0) return;
    const found = discoverKimiWirePath(state);
    if (!found) return;
    state.wirePath = found;
  }
  flushKimiWire(state);
}

function disposeKimiState(state: KimiSessionState): void {
  if (state.watcher) { try { state.watcher.close(); } catch { /* noop */ } state.watcher = null; }
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  if (state.deathTimer) { clearInterval(state.deathTimer); state.deathTimer = null; }
  // The wire tailer has no timers of its own — it's driven off the same
  // pollTimer as the primary log (see startKimiTailer) — so clearing
  // pollTimer above is sufficient to stop it too.
}

/** Read any bytes appended since `state.offset`, split into complete lines,
 *  and dispatch each through the mapper. Tolerates the file not existing yet
 *  (the shell redirect creates it within a few ms of spawn). */
function flushKimiLog(state: KimiSessionState): void {
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
    state.partial += state.decoder.write(buf.subarray(0, read));
  } finally {
    fsCloseSync(fd);
  }

  const lines = state.partial.split("\n");
  state.partial = lines.pop() ?? ""; // keep the trailing partial line
  for (const line of lines) {
    if (!line.trim()) continue;
    const lineNo = state.lineNo++;
    // Apply the seenLineUuids dedup (idempotent reattach replay) around every
    // chunk mapKimiEvent emits for this line.
    const onChunk: ChunkHandler = (stream, data, lineUuid) => {
      if (lineUuid) {
        if (state.seenLineUuids.has(lineUuid)) return;
        state.seenLineUuids.add(lineUuid);
      }
      state.onChunk(stream, data, lineUuid);
    };
    mapKimiEvent(line, onChunk, lineNo);
  }
}

/** Begin tailing the run's log + watching for session death. Shared by the
 *  spawn and reattach paths. Returns the `done` promise. */
function startKimiTailer(state: KimiSessionState): Promise<number> {
  const done = new Promise<number>((resolve) => {
    state.resolveDone = resolve;
  });
  kimiSessions.set(state.taskId, state);

  // Poll the log for appends. macOS FSEvents drops appends to a file written
  // by another process, so polling — not fs.watch — is the reliable backstop;
  // we add an fs.watch opportunistically once the file exists for low latency.
  // The wire-tailer tick is multiplexed onto the same interval (see
  // tickKimiWire) rather than getting its own timer — it self-throttles its
  // own discovery cadence internally.
  state.pollTimer = setInterval(() => { flushKimiLog(state); tickKimiWire(state); }, POLL_MS);
  const tryWatch = () => {
    if (state.watcher || !existsSync(state.logPath)) return;
    try {
      state.watcher = fsWatch(state.logPath, () => flushKimiLog(state));
    } catch { /* fall back to poll-only */ }
  };
  tryWatch();

  // Death watch: kimi is one-shot, so the tmux session dying is the NORMAL
  // end of every turn, not an exceptional condition — there is no in-stream
  // terminal event to short-circuit this the way codex's `turn.completed`
  // does. When the session is confirmed gone, the exit-code sidecar decides
  // the outcome: present → orderly finish (status from the code); absent →
  // the process vanished without ever writing it, which IS exceptional, so
  // emit the shared "session died" sentinel exactly like codex's crash path.
  let misses = 0;
  state.deathTimer = setInterval(() => {
    tryWatch();
    const liveness = sessionLiveness(state.sessionName);
    const outcome = deathTickOutcome({
      liveness,
      logFresh: liveness === "gone" && fileWrittenWithin(state.logPath, DEATH_JSONL_QUIET_MS),
      misses,
      threshold: DEATH_MISS_THRESHOLD,
    });
    if (outcome === "reset") { misses = 0; return; }
    if (outcome === "wait") { misses++; return; }
    // Session confirmed gone. Give the FS a beat to surface the final bytes
    // (log + exit sidecar), flush, then resolve.
    setTimeout(() => {
      flushKimiLog(state);
      tickKimiWire(state); // last chance to catch trailing thinking before dispose
      if (state.resolved) return; // e.g. a concurrent manual kill() already resolved
      const exitCode = readKimiExitCode(state.runId);
      if (exitCode === null) {
        // No sidecar — kimi's process (or the wrapping shell) vanished before
        // it could write `echo $? > exitfile`. That's a genuine death, not an
        // orderly finish.
        state.onChunk(
          "status",
          `${SESSION_DIED_STATUS_PREFIX}tmux session ${state.sessionName} ended unexpectedly — task blocked`,
        );
        resolveKimiDone(state, 1);
        return;
      }
      if (exitCode === 75) {
        // Moonshot's documented "retryable" exit code — surface it via the
        // shared sentinel prefix (matched by the orchestrator's chunk
        // handler, same pattern as SESSION_DIED_STATUS_PREFIX) so a
        // transient rate-limit/5xx/timeout can be auto-retried instead of
        // dumping the task back to `ready` as a generic failure.
        state.onChunk("status", `${KIMI_RETRYABLE_STATUS_PREFIX}kimi exited with code 75`);
      }
      resolveKimiDone(state, exitCode);
    }, DEATH_GRACE_MS);
    if (state.deathTimer) { clearInterval(state.deathTimer); state.deathTimer = null; }
  }, DEATH_POLL_MS);

  return done;
}

function resolveKimiDone(state: KimiSessionState, code: number): void {
  if (state.resolved) return;
  state.resolved = true;
  state.lastCode = code;
  disposeKimiState(state);
  kimiSessions.delete(state.taskId);
  // The run is terminal now: its events are persisted in run_events (the
  // panel replays from the DB, not the log) and reattach only applies to
  // running turns, so the per-run log/prompt/exit files are dead weight.
  // Prune them best-effort so dataDir/kimi-logs/ doesn't grow unbounded.
  try { unlinkSync(kimiPromptPath(state.runId)); } catch { /* already gone */ }
  try { unlinkSync(state.logPath); } catch { /* already gone */ }
  try { unlinkSync(kimiExitPath(state.runId)); } catch { /* already gone */ }
  state.resolveDone(code);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Spawn / reattach.
 * ────────────────────────────────────────────────────────────────────────── */

const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export interface KimiLaunchOptions {
  taskId: string;
  runId: string;
  /** kimi argv from `buildCommand` — `[bin, "--print", "--output-format",
   *  "stream-json", "--input-format", "stream-json", "--session", id, …]`.
   *  Built entirely by the caller (mirrors codex's `resume <thread_id>` argv
   *  ownership) — this driver never mutates it. */
  argv: string[];
  /** Env to forward into the kimi process (KIMI_CODE_HOME/HOME + harness env
   *  + the hygiene vars). */
  env: Record<string, string>;
  cwd: string;
  /** The prompt text — written as one `{"role":"user","content":…}` JSONL
   *  line and piped to kimi's stdin (`--input-format stream-json`). */
  promptText: string;
  onChunk: ChunkHandler;
  /**
   * kimi's session id. Unlike codex's thread id, this is known BEFORE the
   * turn even starts — the caller pre-generates a fresh uuid for a new task
   * (or reuses the persisted `kimi_session_id` for a follow-up) and bakes it
   * into `argv` via `--session <id>` itself. Passing it here just lets this
   * driver report it back through `onSessionId` synchronously. Falls back to
   * generating one locally (defensive only — a caller that omits this while
   * still expecting resumability is a caller bug, since the id it reports
   * then won't match whatever kimi actually used internally).
   */
  sessionId?: string;
  /** Fires once, synchronously, right after the tmux session starts — no
   *  stream event to wait for (contrast codex's `thread.started`-driven
   *  version). */
  onSessionId?: (id: string) => void;
}

/**
 * Spawn one kimi turn in a detached tmux session and start tailing its
 * `stream-json` log. Returns a `SpawnedAgent` whose `done` resolves when the
 * turn ends: 0 on a clean exit, the process's own exit code otherwise, or 1
 * when the session vanished without ever writing the exit-code sidecar.
 */
export function spawnKimiViaTmux(opts: KimiLaunchOptions): SpawnedAgent {
  ensureLogDir();
  const logPath = kimiLogPath(opts.runId);
  const promptPath = kimiPromptPath(opts.runId);
  const exitPath = kimiExitPath(opts.runId);
  writeFileSync(promptPath, JSON.stringify({ role: "user", content: opts.promptText }) + "\n");
  // Truncate/create the log up front so the tailer's first stat succeeds and
  // offsets start at 0 cleanly even if a stale file from a reused id lingers.
  writeFileSync(logPath, "");
  try { unlinkSync(exitPath); } catch { /* no stale sidecar to clear */ }

  const sessionName = sessionNameFor(opts.taskId);
  // Defensive: a zombie session under this name would make new-session fail.
  killSessionByName(sessionName);

  const tmux = resolveTmuxBin();
  // Deliberately NOT `exec` (unlike codex's wrapper): the exit-code sidecar
  // echo must run AFTER kimi exits, and `exec` would replace the shell
  // process with kimi, so the trailing `echo` would never execute.
  const inner = `${opts.argv.map(sq).join(" ")} < ${sq(promptPath)} > ${sq(logPath)} 2>&1; echo $? > ${sq(exitPath)}`;
  const envArgs: string[] = [];
  // Forward PATH so kimi's own shell-tool invocations resolve dev binaries,
  // plus the harness env (KIMI_CODE_HOME/HOME) that controls kimi's login/history.
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

  // The session id is known synchronously (see KimiLaunchOptions.sessionId
  // doc) — computed up front so it can seed both onSessionId and the wire
  // tailer's discovery target below.
  const sessionId = opts.sessionId ?? crypto.randomUUID();
  const { home, kimiCodeHome } = resolveKimiHomeRoots(opts.env.HOME, opts.env.KIMI_CODE_HOME);

  const state: KimiSessionState = {
    taskId: opts.taskId,
    runId: opts.runId,
    sessionName,
    logPath,
    offset: 0,
    decoder: new StringDecoder("utf8"),
    partial: "",
    lineNo: 0,
    watcher: null,
    pollTimer: null,
    deathTimer: null,
    seenLineUuids: new Set(),
    onChunk: opts.onChunk,
    onSessionId: opts.onSessionId,
    sessionIdSent: false,
    resolved: false,
    lastCode: null,
    resolveDone: () => { /* replaced in startKimiTailer */ },
    sessionId,
    cwd: opts.cwd,
    home,
    kimiCodeHome,
    wirePath: null,
    wireOffset: 0,
    wirePartial: "",
    wireLineNo: 0,
    wireDecoder: new StringDecoder("utf8"),
    wireDiscoveryDeadline: Date.now() + WIRE_DISCOVERY_TIMEOUT_MS,
    wireDisabled: wireTrackingDisabled(),
    wireDiscoveryTickCount: 0,
  };

  if (res.status !== 0) {
    // tmux failed to launch the session — surface stderr and resolve failed
    // synchronously so the run doesn't hang in `running`.
    const detail = (res.stderr || res.error?.message || "tmux new-session failed").trim();
    opts.onChunk("stderr", `failed to start kimi session: ${detail}`, undefined);
    const done = Promise.resolve(1);
    return { kill: () => { /* nothing to kill */ }, writeInput: () => false, done };
  }

  state.sessionIdSent = true;
  opts.onSessionId?.(sessionId);

  const done = startKimiTailer(state);
  return {
    kill: () => killKimiState(state),
    // kimi doesn't accept conversational input mid-turn; follow-ups are
    // delivered as fresh turns (new run rows, `--session` reused) by the
    // orchestrator — same story as codex.
    writeInput: () => false,
    done,
  };
}

/**
 * Interrupt a kimi turn: kill its tmux session and resolve `done` promptly.
 * We don't wait for the death-watch's quiet-log veto because we already know
 * the session is gone — a brief grace lets the final appended bytes (and a
 * possibly-just-written exit sidecar) flush first. This is a deliberate
 * stop, so it never emits the `SESSION_DIED_STATUS_PREFIX` sentinel — that's
 * reserved for the death watch's own unexpected-death path.
 */
function killKimiState(state: KimiSessionState): void {
  killSessionByName(state.sessionName);
  setTimeout(() => {
    flushKimiLog(state);
    tickKimiWire(state); // last chance to catch trailing thinking before dispose
    if (state.resolved) return;
    const exitCode = readKimiExitCode(state.runId);
    resolveKimiDone(state, exitCode ?? 1);
  }, DEATH_GRACE_MS);
}

export interface KimiReattachOptions {
  taskId: string;
  runId: string;
  sessionName: string;
  onChunk: ChunkHandler;
  /** Dedup keys already persisted for this task's runs, so re-reading the log
   *  from offset 0 doesn't double-emit events streamed before the restart. */
  seenLineUuids: Set<string>;
  /**
   * kimi's pre-generated `--session` uuid and the cwd the turn is running
   * in — both needed to *discover* the wire.jsonl path (see the file
   * header's wire-tailer section). Optional so pre-existing reattach call
   * sites (which predate the wire tailer) keep compiling unchanged;
   * omitting `sessionId` degrades gracefully to "no wire tailing on
   * reattach" (the tailer disables itself) rather than throwing.
   */
  sessionId?: string | null;
  cwd?: string | null;
  /**
   * HOME / KIMI_CODE_HOME overrides for the harness this run launched
   * under — mirrors `harnessEnv()`'s per-harness home block in agents.ts
   * (an aliased harness re-homes both vars to its own dedicated dir).
   * Optional; when omitted the tailer falls back to the process's own
   * os.homedir() / `<home>/.kimi-code` default, which is only correct for
   * the built-in (non-aliased) kimi harness — reattaching an aliased
   * harness without these will silently probe the wrong home and just
   * time out (best-effort, no error surfaced).
   */
  homeDir?: string | null;
  kimiCodeHome?: string | null;
}

/**
 * Reattach to a kimi turn whose tmux session survived an agetor restart.
 * Re-tails the run's log from offset 0 (deduping via `seenLineUuids`) and
 * resolves `done` when the turn finishes. Returns null when the session is
 * no longer alive (caller should orphan the run). Only meaningful while a
 * turn is in flight — kimi's session, like codex's, lives only for the
 * duration of one turn, so between turns there is nothing to reattach.
 *
 * The wire tailer also restarts from offset 0 on reattach — its dedup keys
 * (`kimiwire:<lineNo>`, wrapped in the same `seenLineUuids` set as the
 * primary log) make that idempotent for lines already streamed before the
 * restart.
 */
export function reattachKimiSession(opts: KimiReattachOptions): SpawnedAgent | null {
  if (!sessionExistsByName(opts.sessionName)) return null;
  const { home, kimiCodeHome } = resolveKimiHomeRoots(opts.homeDir, opts.kimiCodeHome);
  const state: KimiSessionState = {
    taskId: opts.taskId,
    runId: opts.runId,
    sessionName: opts.sessionName,
    logPath: kimiLogPath(opts.runId),
    offset: 0,
    decoder: new StringDecoder("utf8"),
    partial: "",
    lineNo: 0,
    watcher: null,
    pollTimer: null,
    deathTimer: null,
    seenLineUuids: opts.seenLineUuids,
    onChunk: opts.onChunk,
    onSessionId: undefined,
    sessionIdSent: true, // session id already persisted on the original run
    resolved: false,
    lastCode: null,
    resolveDone: () => { /* replaced in startKimiTailer */ },
    sessionId: opts.sessionId ?? "",
    cwd: opts.cwd ?? "",
    home,
    kimiCodeHome,
    wirePath: null,
    wireOffset: 0,
    wirePartial: "",
    wireLineNo: 0,
    wireDecoder: new StringDecoder("utf8"),
    wireDiscoveryDeadline: Date.now() + WIRE_DISCOVERY_TIMEOUT_MS,
    // No sessionId → discovery can never find the right dir; disable
    // outright rather than let it spin fruitlessly until the deadline.
    wireDisabled: wireTrackingDisabled() || !opts.sessionId,
    wireDiscoveryTickCount: 0,
  };
  const done = startKimiTailer(state);
  return {
    kill: () => killKimiState(state),
    writeInput: () => false,
    done,
  };
}

/** True when a live kimi tail is registered for this task. */
export function kimiSessionActive(taskId: string): boolean {
  return kimiSessions.has(taskId);
}

/**
 * Tear down a task's kimi session: kill the tmux session and dispose the
 * in-memory tailer. Best-effort and non-throwing — called from deleteTask /
 * archiveTask and on a cross-kind agent switch. Safe to call when no kimi
 * session exists (kills any stray session under the task's name too).
 */
export function dropKimiSession(taskId: string): void {
  const state = kimiSessions.get(taskId);
  if (state) {
    disposeKimiState(state);
    kimiSessions.delete(taskId);
  }
  killSessionByName(sessionNameFor(taskId));
}
