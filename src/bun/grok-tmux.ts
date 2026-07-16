import {
  existsSync,
  mkdirSync,
  watch as fsWatch,
  type FSWatcher,
  openSync as fsOpenSync,
  readSync as fsReadSync,
  closeSync as fsCloseSync,
  statSync as fsStatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import os from "node:os";
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
 * Driver that hosts a single `grok --output-format streaming-json` turn
 * inside a per-task tmux session and exposes structured streaming from TWO
 * sources, mirrored from the now-open-sourced `xai-org/grok-build` contract
 * (verified against `crates/codegen/xai-grok-pager/src/headless.rs` and
 * `xai-grok-config/src/paths.rs`, see docs/plans/grok-build-oss-alignment.md
 * §2-3, decisions D1/D2/D8):
 *
 * 1. **stdout `streaming-json` log** (this file's original tailer) — assistant
 *    text/thinking deltas and the terminal `end`/`error` events. Per the
 *    source, this stream carries NO tool-call events at all (the serializer's
 *    catch-all drops every ACP update except message/thought chunks,
 *    `headless.rs:1507`) — that's what source #2 is for.
 * 2. **`updates.jsonl` session file** (new, D8) — the ACP-style tool-call /
 *    plan stream, written incrementally by grok to
 *    `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/updates.jsonl`. Unlike
 *    the stdout log (one file per RUN/turn), this file is per SESSION and
 *    spans every turn, so it's tailed from offset 0 on every spawn/reattach
 *    and deduplicated via the same task-scoped `seenLineUuids` set the
 *    stdout tailer uses — this is what makes a fresh turn's tail-from-zero
 *    behave identically to a restart's reattach-and-replay.
 *
 * Structurally mirrors `codex-tmux.ts` — see that file's header for the
 * restart-survival rationale (tmux hosts the one-shot process so a mid-turn
 * run survives an agetor restart; reattach only applies WHILE a turn is in
 * flight, since grok's tmux session — like codex's — lives only for the
 * duration of one turn).
 *
 * Two deviations from codex, both required by grok's CLI shape:
 *
 * 1. **Prompt delivery.** codex reads its prompt from stdin (the trailing `-`
 *    in its argv), so the wrapper redirects `< promptfile`. grok's `-p` takes
 *    the prompt as an ARGUMENT and headless mode never reads stdin
 *    (`docs/14-headless-mode.md:303`) — but the CLI also exposes a real
 *    `--prompt-file <PATH>` flag (`cli.rs:474-482`) that reads the prompt
 *    straight off disk. So the wrapper writes the prompt to a file (as
 *    before) and splices `--prompt-file <path>` into argv — no command
 *    substitution, no quoting hell. Per D2, `argv` passed into this driver
 *    therefore EXCLUDES `-p`/the prompt entirely; the driver appends
 *    `--prompt-file <promptPath>` (single-quoted via `sq()`, since the path
 *    is our own runId-derived string, never user content) right before the
 *    output redirect.
 *
 * 2. **Terminal event not signal-safe.** `main.rs:820-859` exits directly on
 *    a signal without emitting `end`/`error`, so even with the now-verified
 *    schema (D1) a turn can end with no terminal event the mapper sees. The
 *    shell wrapper's exit-code sidecar (`; echo $? > exitfile` — no `exec`,
 *    the shell must outlive grok) remains load-bearing for that case: a
 *    present sidecar means the process exited cleanly (settle with its code,
 *    no sentinel — a plain failure returns the card to `ready`); an absent
 *    one plus a vanished session is a genuine death (sentinel → `blocked`,
 *    lastCode defaulting to 1 — a false "blocked" is recoverable from the run
 *    panel, whereas a false "succeeded" would silently mask a failed turn).
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
/** Exit-code sidecar written by the shell wrapper (`; echo $? > exitfile`).
 *  Its EXISTENCE means the grok process ran to completion and exited — the
 *  death-watch reads it to distinguish an unrecognized-but-clean exit (a
 *  signal exit skips grok's terminal event entirely, per `main.rs:820-859`)
 *  from a genuine mid-turn session death. Derivable from runId for reattach. */
function grokExitPath(runId: string): string {
  return path.join(GROK_LOG_DIR, `${runId}.exit`);
}
/** Parse the sidecar. `null` = not written (process never reached its exit
 *  line). A present-but-garbled file reads as 1 (exited, code unknown). */
function readExitCode(runId: string): number | null {
  try {
    const raw = readFileSync(grokExitPath(runId), "utf8");
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) ? n : 1;
  } catch {
    return null;
  }
}
function ensureLogDir(): void {
  if (!existsSync(GROK_LOG_DIR)) mkdirSync(GROK_LOG_DIR, { recursive: true });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * stdout `streaming-json` event mapping (grok event → agetor RunEvent chunks).
 *
 * SOURCE-VERIFIED (D1), not speculative: field names and the terminal-event
 * pair below are read directly off `headless.rs` in xai-org/grok-build
 * (`:372` text, `:387` thought, `:446-458` end, `:472-478` error, plus the
 * auxiliary status events). The taxonomy is explicitly documented as
 * non-exhaustive, so an UNKNOWN `type` still falls through to a narrow
 * defensive fallback (text-bearing → generic `tool_use`, else dropped) —
 * see the bottom of `mapGrokEvent`.
 * ────────────────────────────────────────────────────────────────────────── */

interface GrokEvent {
  type?: string;
  event?: string;
  method?: string;
  id?: string;
  session_id?: string;
  /** The ONLY event carrying this (top-level, camelCase) is `end`. */
  sessionId?: string;
  /** Delta payload for `text`/`thought` events. */
  data?: string;
  /** `end` event fields. */
  stopReason?: string;
  requestId?: string;
  /** `auto_compact_started` progress (0-100-ish). */
  percentage?: number;
  /** `auto_continue_completed` usage. */
  total_tokens?: number;
  error?: { message?: string } | string;
  message?: unknown;
  /** Kept for the defensive fallback branch only — no known real event uses
   *  these, but an undocumented future one might. */
  text?: string;
  content?: unknown;
  [k: string]: unknown;
}

/** Result of mapping one event line. `done` terminates the turn (0 = success,
 *  1 = failure) when a recognized terminal event fires. `sessionId` is set
 *  only by `end` — the sole event that carries it (D1). */
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
 *  "text", text: "…" }` content blocks). Used only by the fallback branch and
 *  by `error`'s `message` field, which may be a bare string. */
function extractText(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const t = (v as Record<string, unknown>).text;
    if (typeof t === "string" && t.length > 0) return t;
  }
  return undefined;
}

/** Session id sniffing: any event carrying `session_id`/`sessionId` at the
 *  top level, or one level deep in any object-valued field. In practice only
 *  `end` carries it (D1), but this is kept general/harmless in case a future
 *  event nests it differently. This id is what `--resume` replays. */
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

/** Best-effort formatting of the `end` event's cost/usage fields. The plan's
 *  source excerpt cites "…spend" without enumerating exact field names, so
 *  this checks a handful of plausible ones (flat on the event, or nested
 *  under a `spend` object) and renders whichever are actually present.
 *  Absent entirely → the `status` chunk just carries the stop reason. */
function formatGrokSpend(evt: GrokEvent): string | undefined {
  const flatKeys = [
    "cost", "usdCost", "totalCost", "totalTokens", "total_tokens",
    "inputTokens", "outputTokens", "cachedTokens", "promptTokens", "completionTokens",
  ];
  const parts: string[] = [];
  const root = evt as Record<string, unknown>;
  for (const k of flatKeys) {
    const v = root[k];
    if (typeof v === "number" || typeof v === "string") parts.push(`${k}=${v}`);
  }
  const spend = root.spend;
  if (spend && typeof spend === "object" && !Array.isArray(spend)) {
    for (const [k, v] of Object.entries(spend as Record<string, unknown>)) {
      if (typeof v === "number" || typeof v === "string") parts.push(`${k}=${v}`);
    }
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/**
 * Map a single parsed grok `streaming-json` event to zero or one chunk.
 * `lineIndex` is the NDJSON line's 0-based position within the run's log.
 * `text`/`thought` events carry no id, so the file position is the key —
 * stable and deterministic across a reattach replay (the log is always
 * re-read from offset 0 and this counter restarts at 0 with it — it counts
 * file position, never wall-clock/random).
 *
 * `keyScope` (the run id in production) namespaces every key this mapper
 * produces. It is load-bearing: the dedup set is TASK-scoped (shared with the
 * per-session updates.jsonl tailer, which needs cross-run stability), while
 * the stdout log is per-RUN with lineIndex restarting at 0 — without the
 * scope, turn 2's `line:0` would collide with turn 1's persisted `line:0`
 * and the leading chunks of every follow-up turn would be silently dropped.
 *
 * The old id-folded `textKey` scheme is dead for every real event type but
 * is kept for the defensive fallback branch, where an unrecognized future
 * event might still carry an `id` worth keying on (scoped too — same-id
 * events in different runs must not cross-dedup).
 */
export function mapGrokEvent(
  evt: GrokEvent,
  onChunk: ChunkHandler,
  lineIndex: number,
  keyScope = "",
): GrokMapResult {
  const type = evt.type ?? evt.event ?? evt.method ?? "";
  const prefix = keyScope ? `${keyScope}:` : "";
  const lineKey = `${prefix}line:${lineIndex}`;

  switch (type) {
    case "text": {
      if (typeof evt.data === "string" && evt.data.length > 0) {
        onChunk("assistant", evt.data, lineKey);
      }
      return {};
    }

    case "thought": {
      if (typeof evt.data === "string" && evt.data.length > 0) {
        onChunk("thinking", evt.data, lineKey);
      }
      return {};
    }

    case "end": {
      // Terminal success, always last on the success path (headless.rs:446-458).
      const sessionId = findSessionId(evt);
      const stopReason = typeof evt.stopReason === "string" ? evt.stopReason : "unknown";
      const spend = formatGrokSpend(evt);
      onChunk("status", `turn ended: ${stopReason}${spend ? ` (${spend})` : ""}`, lineKey);
      return { done: 0, sessionId };
    }

    case "error": {
      // Terminal failure (headless.rs:472-478); never carries sessionId.
      const msg = extractText(evt.message) ?? errMessage(evt.error) ?? "grok turn failed";
      onChunk("stderr", msg, lineKey);
      return { done: 1 };
    }

    case "max_turns_reached":
      // NOT terminal — an `end` event always follows this one.
      onChunk("status", "max turns reached", lineKey);
      return {};

    case "auto_compact_started": {
      const pct = typeof evt.percentage === "number" ? ` (${evt.percentage}%)` : "";
      onChunk("status", `auto-compacting context${pct}`, lineKey);
      return {};
    }

    case "auto_compact_completed":
      onChunk("status", "auto-compact completed", lineKey);
      return {};

    case "auto_compact_failed": {
      const err = errMessage(evt.error) ?? extractText(evt.message) ?? "unknown error";
      onChunk("status", `auto-compact failed: ${err}`, lineKey);
      return {};
    }

    case "auto_compact_cancelled":
      onChunk("status", "auto-compact cancelled", lineKey);
      return {};

    case "auto_continue_completed": {
      const tokens = typeof evt.total_tokens === "number" ? ` (${evt.total_tokens} tokens)` : "";
      onChunk("status", `auto-continue completed${tokens}`, lineKey);
      return {};
    }

    case "image_compressed": {
      const msg = extractText(evt.message) ?? "image compressed";
      onChunk("status", msg, lineKey);
      return {};
    }

    default:
      break;
  }

  // Defensive fallback for an event type outside the known taxonomy above —
  // the source docs mark the list non-exhaustive. Deliberately narrow (no
  // substring heuristics on `type`/`event`/`method` anymore, now that the
  // real types are known exactly): a bare `data`/`text`/`content`/`message`
  // string renders as a generic tool_use so nothing goes dark; anything with
  // no recognizable text is silently dropped (pure protocol noise, e.g. an
  // undocumented ping/keepalive type).
  const key = typeof evt.id === "string" ? `${prefix}${type}:${evt.id}` : lineKey;
  const fallback = extractText(evt.data) ?? extractText(evt.text) ?? extractText(evt.content)
    ?? extractText(evt.message);
  if (fallback) {
    onChunk("tool_use", JSON.stringify({ name: type || "grok-event", text: fallback }), key);
  }
  return {};
}

/* ────────────────────────────────────────────────────────────────────────── *
 * `updates.jsonl` session-file path resolution (D8).
 *
 * Path shape: `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/updates.jsonl`
 * (`xai-grok-config/src/paths.rs`). The encoding is a TS port of the
 * SHORT-path case of `encode_cwd_dirname` (`:112-126`): percent-encode every
 * byte except `A-Za-z0-9-_.~` (Rust's `urlencoding::encode` semantics). JS
 * `encodeURIComponent` already does almost exactly that, except it leaves
 * `!'()*` un-escaped where the Rust crate does not — those five characters
 * are individually post-encoded. When the encoded form would exceed 255
 * bytes, the Rust side falls back to a
 * `${slugify(leaf,40)}-${blake3(cwd).hex[..16]}` long-path scheme that we
 * deliberately don't port (no blake3 dependency); `encodeGrokCwd` returns
 * `null` in that case and callers fall back to `scanForGrokUpdatesPath`,
 * which finds the file by session id alone regardless of how the cwd
 * segment was encoded.
 * ────────────────────────────────────────────────────────────────────────── */

/** TypeScript port of the short-path case of `encode_cwd_dirname`
 *  (`xai-grok-config/src/paths.rs:112-126`). Returns `null` when the encoded
 *  form exceeds 255 bytes — the long-path/blake3 case this function
 *  deliberately does not implement (see the section header above). */
export function encodeGrokCwd(cwd: string): string | null {
  // encodeURIComponent leaves `A-Za-z0-9-_.!~*'()` unescaped — a superset of
  // Rust's urlencoding::encode, which additionally escapes `!'()* `. Those
  // five characters are percent-encoded by hand afterward.
  const encoded = encodeURIComponent(cwd).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  if (Buffer.byteLength(encoded, "utf8") > 255) return null;
  return encoded;
}

function resolveGrokHome(env: Record<string, string>): string {
  const home = env.GROK_HOME;
  return home && home.length > 0 ? home : path.join(os.homedir(), ".grok");
}

/** Primary (short-path) candidate for a session's `updates.jsonl`. `null`
 *  when `encodeGrokCwd` can't produce a ≤255-byte dirname. */
function grokUpdatesCandidatePath(grokHome: string, cwd: string, sessionId: string): string | null {
  const encoded = encodeGrokCwd(cwd);
  if (encoded === null) return null;
  return path.join(grokHome, "sessions", encoded, sessionId, "updates.jsonl");
}

/**
 * True when the grok session directory exists on disk under any encoded-cwd
 * dirname. Used by the orchestrator's resume gate: a pre-seeded (`-s`) id is
 * persisted on the run row BEFORE grok runs, so a turn that dies before grok
 * ever creates the session (auth failure, immediate exit) leaves an id whose
 * `--resume` would hard-error ("session not found") on every retry. Checking
 * disk distinguishes "session established, resume it" from "never created,
 * mint a fresh one". env is the harness env (GROK_HOME resolution).
 */
export function grokSessionExistsOnDisk(env: Record<string, string>, cwd: string, sessionId: string): boolean {
  const grokHome = resolveGrokHome(env);
  const candidate = grokUpdatesCandidatePath(grokHome, cwd, sessionId);
  // The session dir may exist before updates.jsonl has its first line —
  // check the directory, not the file.
  if (candidate && existsSync(path.dirname(candidate))) return true;
  const sessionsDir = path.join(grokHome, "sessions");
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return false;
  }
  return entries.some((entry) => existsSync(path.join(sessionsDir, entry, sessionId)));
}

/** Fallback: scan `<grokHome>/sessions/<any-encoded-cwd>/<sessionId>/
 *  updates.jsonl`, one readdir level deep. Covers the blake3 long-path case
 *  and any future encoding drift — cheap enough to retry every poll tick
 *  until found. */
function scanForGrokUpdatesPath(grokHome: string, sessionId: string): string | null {
  const sessionsDir = path.join(grokHome, "sessions");
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = path.join(sessionsDir, entry, sessionId, "updates.jsonl");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * `updates.jsonl` line mapping (tool_call / tool_call_update / plan → chunks).
 * ────────────────────────────────────────────────────────────────────────── */

/** Wraps a raw `ChunkHandler` with the task-scoped `seenLineUuids` dedup —
 *  shared by the stdout dispatcher and the updates.jsonl dispatcher so both
 *  tailers draw from the same set (this is what makes a fresh spawn's
 *  tail-from-offset-0 behave identically to a restart's reattach replay). */
function makeDedupChunkHandler(onChunk: ChunkHandler, seen: Set<string>): ChunkHandler {
  return (stream, data, lineUuid) => {
    if (lineUuid) {
      if (seen.has(lineUuid)) return;
      seen.add(lineUuid);
    }
    onChunk(stream, data, lineUuid);
  };
}

/**
 * Map one parsed `updates.jsonl` line. Line shape:
 * `{"timestamp":<unix-s>,"method":"session/update","params":{"sessionId":…,
 * "update":{"sessionUpdate":"<tag>",…}}}`. Legacy lines may omit `method`
 * entirely, in which case the parsed root itself is params-shaped (no
 * wrapper). `method:"_x.ai/session/update"` lines (subagent lifecycle/rewind
 * markers, A3 in the plan) are skipped entirely, as is any `sessionUpdate`
 * tag outside the three handled below — the stdout stream owns
 * message/thought content, so silence on those tags here is correct, not a
 * gap. `lineIndex` is this tailer's own 0-based counter (independent of the
 * stdout tailer's).
 */
function dispatchGrokUpdateLine(parsed: unknown, lineIndex: number, dedupChunk: ChunkHandler): void {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const root = parsed as Record<string, unknown>;
  const method = typeof root.method === "string" ? root.method : undefined;
  if (method !== undefined && method !== "session/update") return; // e.g. "_x.ai/session/update"
  const paramsSource = method === "session/update" ? root.params : root; // legacy: params-shaped root
  if (!paramsSource || typeof paramsSource !== "object") return;
  const update = (paramsSource as Record<string, unknown>).update;
  if (!update || typeof update !== "object") return;
  const u = update as Record<string, unknown>;
  const tag = typeof u.sessionUpdate === "string" ? u.sessionUpdate : undefined;
  if (!tag) return;

  const toolCallId = typeof u.toolCallId === "string" ? u.toolCallId : undefined;

  switch (tag) {
    case "tool_call": {
      if (!toolCallId) return; // malformed — nothing stable to key on
      dedupChunk(
        "tool_use",
        JSON.stringify({ name: u.title, kind: u.kind, input: u.rawInput }),
        `tc:${toolCallId}`,
      );
      if (u.rawOutput !== undefined) {
        dedupChunk("tool_result", JSON.stringify({ content: u.rawOutput }), `tcr:${toolCallId}`);
      }
      return;
    }

    case "tool_call_update": {
      const status = typeof u.status === "string" ? u.status : undefined;
      if (status !== "completed" && status !== "failed") return; // partial/in_progress → noise
      if (!toolCallId) return;
      dedupChunk(
        "tool_result",
        JSON.stringify({ content: u.rawOutput ?? u.content, isError: status === "failed" }),
        `tcu:${toolCallId}:${status}`,
      );
      return;
    }

    case "plan": {
      dedupChunk(
        "tool_use",
        JSON.stringify({ name: "plan", input: u.entries }),
        `plan:${lineIndex}`,
      );
      return;
    }

    default:
      // user_message_chunk / agent_message_chunk / agent_thought_chunk /
      // available_commands_update / current_mode_update / anything else the
      // stdout stream already owns, or a future tag we don't recognize yet.
      return;
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Session state + tailers.
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
  /** 0-based NDJSON line index for the stdout log, incremented once per
   *  successfully parsed event. Restarts at 0 on reattach since the log is
   *  always re-read from offset 0 — stable because the log is append-only. */
  lineNo: number;
  onChunk: ChunkHandler;
  onSessionId?: (id: string) => void;
  sessionIdSent: boolean;
  resolved: boolean;
  lastCode: number | null;
  resolveDone: (code: number) => void;

  /** D8: updates.jsonl tailer state. */
  cwd: string;
  grokHome: string;
  /** Pre-seeded (D4) session id, used to resolve the updates.jsonl path.
   *  `null` on a reattach whose run row never captured `grok_session_id` —
   *  the tailer simply never resolves a path in that case (graceful
   *  degrade: stdout content still streams normally). */
  sessionId: string | null;
  /** Resolved once the file is found; sticky thereafter (grok writes to the
   *  same file for the rest of the session). */
  updatesPath: string | null;
  updatesOffset: number;
  updatesDecoder: StringDecoder;
  updatesPartial: string;
  updatesWatcher: FSWatcher | null;
  updatesPollTimer: ReturnType<typeof setInterval> | null;
  updatesLineNo: number;
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
  if (state.updatesWatcher) { try { state.updatesWatcher.close(); } catch { /* noop */ } state.updatesWatcher = null; }
  if (state.updatesPollTimer) { clearInterval(state.updatesPollTimer); state.updatesPollTimer = null; }
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
  const onChunk = makeDedupChunkHandler(state.onChunk, state.seenLineUuids);
  // keyScope = runId: the stdout log is per-run (lineNo restarts at 0 each
  // turn) but the dedup set is task-scoped — see mapGrokEvent's docstring.
  const result = mapGrokEvent(evt, onChunk, state.lineNo, state.runId);
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

/** Read any bytes appended to the session's `updates.jsonl` since
 *  `state.updatesOffset`, split into complete lines, and dispatch each
 *  through `dispatchGrokUpdateLine`. Resolves `state.updatesPath` lazily (the
 *  file may not exist for a few seconds after the turn starts, or at all if
 *  `sessionId` is unknown or every path guess fails) — once resolved it's
 *  sticky for the rest of this state's lifetime. Malformed JSON lines are
 *  skipped silently: this is grok's own file, not ours, so we don't spam
 *  stderr over it. */
function flushGrokUpdates(state: GrokSessionState): void {
  if (!state.updatesPath) {
    if (!state.sessionId) return; // nothing to resolve a path from
    // Try the computed short-path encoding first, but fall THROUGH to the
    // directory scan whenever the computed path doesn't exist yet — the scan
    // is the safety net for both the >255-byte blake3 case (candidate null)
    // AND any drift between our encodeGrokCwd port and grok's actual
    // encoder (candidate non-null but wrong). A `??` alone would make the
    // scan unreachable in that second case.
    let candidate = grokUpdatesCandidatePath(state.grokHome, state.cwd, state.sessionId);
    if (!candidate || !existsSync(candidate)) {
      candidate = scanForGrokUpdatesPath(state.grokHome, state.sessionId);
    }
    if (!candidate || !existsSync(candidate)) return; // retry next poll tick
    state.updatesPath = candidate;
  }

  let fd: number;
  try {
    const st = fsStatSync(state.updatesPath);
    if (st.size <= state.updatesOffset) return;
    fd = fsOpenSync(state.updatesPath, "r");
  } catch {
    return;
  }
  try {
    const len = fsStatSync(state.updatesPath).size - state.updatesOffset;
    if (len <= 0) return;
    const buf = Buffer.allocUnsafe(len);
    const read = fsReadSync(fd, buf, 0, len, state.updatesOffset);
    state.updatesOffset += read;
    state.updatesPartial += state.updatesDecoder.write(buf.subarray(0, read));
  } finally {
    fsCloseSync(fd);
  }

  const lines = state.updatesPartial.split("\n");
  state.updatesPartial = lines.pop() ?? "";
  const dedupChunk = makeDedupChunkHandler(state.onChunk, state.seenLineUuids);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      state.updatesLineNo++;
      continue; // grok's own file — skip silently, no stderr noise
    }
    dispatchGrokUpdateLine(parsed, state.updatesLineNo, dedupChunk);
    state.updatesLineNo++;
  }
}

function resolveGrokDone(state: GrokSessionState, code: number): void {
  if (state.resolved) return;
  state.resolved = true;
  disposeGrokState(state);
  grokSessions.delete(state.taskId);
  // Kill the tmux session on resolve. On the normal path the one-shot grok
  // process is already exiting (no-op), but the mapper can recognize a
  // terminal event early — without this, the run would be marked terminal
  // while the real grok process kept working detached, and since
  // reconcileOrphans only reattaches status='running' rows, that session
  // would leak with no cleanup path. Own-scoped (this task's session name),
  // so it can't touch a sibling instance's sessions.
  killSessionByName(state.sessionName);
  // The run is terminal now: its events are persisted in run_events (the panel
  // replays from the DB, not the log) and reattach only applies to running
  // turns, so the per-run log + prompt files are dead weight. Prune them
  // best-effort so dataDir/grok-logs/ doesn't grow unbounded. Timers are
  // already cleared above, so nothing will try to read them after this.
  // updates.jsonl is NOT pruned — it's grok's own per-session file, not ours.
  try { unlinkSync(grokPromptPath(state.runId)); } catch { /* already gone */ }
  try { unlinkSync(state.logPath); } catch { /* already gone */ }
  try { unlinkSync(grokExitPath(state.runId)); } catch { /* already gone */ }
  state.resolveDone(code);
}

/** Begin tailing the run's stdout log + the session's updates.jsonl, and
 *  watching for session death. Shared by the spawn and reattach paths.
 *  Returns the `done` promise. */
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

  // Second tailer (D8): updates.jsonl. Same poll+watch shape; path resolution
  // is lazy inside flushGrokUpdates (the file may not exist yet, or ever, if
  // sessionId is unknown / every path guess misses — graceful degrade).
  const tryWatchUpdates = () => {
    if (state.updatesWatcher || !state.updatesPath || !existsSync(state.updatesPath)) return;
    try {
      state.updatesWatcher = fsWatch(state.updatesPath, () => flushGrokUpdates(state));
    } catch { /* fall back to poll-only */ }
  };
  state.updatesPollTimer = setInterval(() => {
    flushGrokUpdates(state);
    tryWatchUpdates();
  }, POLL_MS);
  flushGrokUpdates(state);
  tryWatchUpdates();

  // Death watch: when the tmux session disappears the `grok` process has
  // exited. Flush whatever's left, then resolve. A recognized terminal event
  // (mapper `done`) normally resolves us first; this catches a crash, or a
  // signal exit that skips grok's own terminal event (main.rs:820-859). Only
  // a definitive `gone` probe (server up, this session absent) counts toward
  // death — an `unreachable` tmux hiccup on the shared socket resets the
  // counter, and a grok log written a beat ago vetoes it — so a live
  // one-shot run is never wrongly torn down (mirrors claude-tmux's death
  // watch; see `sessionLiveness`).
  let misses = 0;
  state.deathTimer = setInterval(() => {
    tryWatch();
    tryWatchUpdates();
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
      flushGrokUpdates(state);
      // If the final flush surfaced a terminal event, resolveGrokDone already
      // fired — this was an orderly finish, not a death, so don't emit the
      // "session ended" sentinel.
      if (!state.resolved) {
        // Exit-code sidecar (see the wrapper in spawnGrokViaTmux): a signal
        // exit skips grok's own terminal event (main.rs:820-859), so an
        // ordinary turn — success OR failure — may end without a terminal
        // event the mapper recognizes. The sidecar file distinguishes
        // "process exited cleanly with code N" (settle with N, no sentinel —
        // a non-zero N returns the card to `ready`, not `blocked`) from
        // "session vanished without the process reaching its exit line"
        // (genuine death → sentinel → blocked).
        const exitCode = readExitCode(state.runId);
        if (exitCode !== null) {
          if (exitCode !== 0) {
            state.onChunk("stderr", `grok exited with code ${exitCode}`);
          }
          resolveGrokDone(state, exitCode);
          return;
        }
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
  /** Grok argv from `buildCommand`, EXCLUDING `-p`/`--prompt-file`/the prompt
   *  itself — `[bin, "--output-format", "streaming-json", ("-m", model)?,
   *  …mode flags, ("--resume", sessionId)?]`. The driver appends
   *  `--prompt-file <promptPath>` right before the output redirect (see the
   *  file header — grok's `-p` takes an argument, not stdin, but
   *  `--prompt-file` reads straight off disk so no prompt text ever touches
   *  the shell string). */
  argv: string[];
  /** Env to forward into the grok process (GROK_HOME/HOME + harness env). */
  env: Record<string, string>;
  cwd: string;
  /** The prompt text — written to a file and delivered via `--prompt-file`. */
  promptText: string;
  onChunk: ChunkHandler;
  /** Fires once with grok's session id from the `end` event, as
   *  confirmation/repair of the pre-seeded id below (D4) — not the primary
   *  persistence path anymore. */
  onSessionId?: (id: string) => void;
  /** Session id for this turn (D4): a fresh `crypto.randomUUID()` for a new
   *  session (passed to grok via `-s`), or the prior turn's id for a
   *  follow-up (passed via `--resume`) — the orchestrator always knows this
   *  before spawning now, which is what lets the updates.jsonl tailer (D8)
   *  resolve its path immediately instead of waiting on a sniffed id. */
  sessionId: string;
  /** Task-scoped dedup set — the SAME instance `runs.seenLineUuidsForTask
   *  (taskId)` produces for reattach (see orchestrator.ts's grok reattach
   *  call). Required here too, not just on reattach: `updates.jsonl` is a
   *  per-SESSION file spanning every turn, always tailed from offset 0, so
   *  without a task-scoped set a fresh turn would re-emit every earlier
   *  turn's already-persisted tool_call/plan lines as new chunks under the
   *  new run id. Passing the same set into every spawn (not just reattach)
   *  is what makes a fresh tail-from-zero behave identically to a restart's
   *  reattach-and-replay. */
  seenLineUuids: Set<string>;
}

/**
 * Spawn one grok turn in a detached tmux session and start tailing its
 * `streaming-json` log plus its session's `updates.jsonl`. Returns a
 * `SpawnedAgent` whose `done` resolves when the turn ends (0 on a recognized
 * success event, 1 on failure/crash/unknown death).
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
  // A stale sidecar from a reused run id would make the death-watch read a
  // previous turn's exit code — clear it before launch (log is truncated
  // above for the same reason).
  try { unlinkSync(grokExitPath(opts.runId)); } catch { /* none */ }
  // `--prompt-file <path>` (cli.rs:474-482) reads the prompt straight off
  // disk — no command substitution, unlike the pre-OSS `-p "$(cat …)"`
  // design. `promptPath` is our own runId-derived path (never user content),
  // single-quoted via sq() defensively.
  //
  // No `exec` — the shell must outlive grok to write the exit-code sidecar
  // (`; echo $? > exitfile`). Even with the now-verified terminal event
  // schema (D1), a signal exit skips it entirely (main.rs:820-859); the
  // sidecar lets the death-watch tell "process exited cleanly with code N"
  // (settle with N — a plain failure returns the card to `ready`) apart from
  // a genuine mid-turn session death (sentinel → `blocked`). Costs one extra
  // sh process per turn.
  const inner = `${sq(bin)} ${rest.map(sq).join(" ")} --prompt-file ${sq(promptPath)} > ${sq(logPath)} 2>&1; echo $? > ${sq(grokExitPath(opts.runId))}`;
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
    seenLineUuids: opts.seenLineUuids,
    lineNo: 0,
    onChunk: opts.onChunk,
    onSessionId: opts.onSessionId,
    sessionIdSent: false,
    resolved: false,
    lastCode: null,
    resolveDone: () => { /* replaced in startGrokTailer */ },
    cwd: opts.cwd,
    grokHome: resolveGrokHome(opts.env),
    sessionId: opts.sessionId,
    updatesPath: null,
    updatesOffset: 0,
    updatesDecoder: new StringDecoder("utf8"),
    updatesPartial: "",
    updatesWatcher: null,
    updatesPollTimer: null,
    updatesLineNo: 0,
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
    try { unlinkSync(grokExitPath(opts.runId)); } catch { /* best-effort */ }
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
    flushGrokUpdates(state);
    resolveGrokDone(state, state.lastCode ?? 1);
  }, DEATH_GRACE_MS);
}

export interface GrokReattachOptions {
  taskId: string;
  runId: string;
  sessionName: string;
  onChunk: ChunkHandler;
  /** Dedup keys already persisted for this task's runs, so re-reading either
   *  log from offset 0 doesn't double-emit events streamed before the
   *  restart. */
  seenLineUuids: Set<string>;
  /** Session id for the updates.jsonl tailer (D8), mirroring
   *  `GrokLaunchOptions.sessionId`. `null` when the run row never captured
   *  `grok_session_id` (e.g. a pre-D4 run) — the tailer then simply never
   *  resolves a path; stdout content still streams normally (graceful
   *  degrade, tool-call rendering just absent). */
  sessionId: string | null;
  /** Needed to resolve the updates.jsonl path's cwd-encoded directory
   *  segment, mirroring `GrokLaunchOptions.cwd`. */
  cwd: string;
  /** Needed to resolve GROK_HOME for the updates.jsonl path, mirroring
   *  `GrokLaunchOptions.env`. Optional — falls back to `~/.grok` when
   *  omitted, so an orchestrator caller that doesn't thread the harness env
   *  through degrades gracefully rather than throwing. */
  env?: Record<string, string>;
}

/**
 * Reattach to a grok turn whose tmux session survived an agetor restart.
 * Re-tails the run's stdout log AND the session's updates.jsonl, both from
 * offset 0 (deduping via `seenLineUuids`), and resolves `done` when the turn
 * finishes. Returns null when the session is no longer alive (caller should
 * orphan the run).
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
    cwd: opts.cwd,
    grokHome: resolveGrokHome(opts.env ?? {}),
    sessionId: opts.sessionId,
    updatesPath: null,
    updatesOffset: 0,
    updatesDecoder: new StringDecoder("utf8"),
    updatesPartial: "",
    updatesWatcher: null,
    updatesPollTimer: null,
    updatesLineNo: 0,
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
