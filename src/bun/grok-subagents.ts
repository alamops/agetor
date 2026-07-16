/* ────────────────────────────────────────────────────────────────────────── *
 * Grok subagent tracking.
 *
 * Structural analogue of `claude-subagents.ts`, but for grok's on-disk model:
 * a claude subagent is a sidecar file inside the PARENT session's own
 * directory (`<sessionId>/subagents/agent-<id>.jsonl`); a grok subagent is a
 * fully INDEPENDENT session, living at its own
 * `$GROK_HOME/sessions/<encoded-cwd>/<child_session_id>/updates.jsonl`, same
 * shape as the parent's own `updates.jsonl` (docs/plans/grok-subagent-rendering.md
 * §2-3, D1-D3, D6).
 *
 * Lifecycle: the parent's `updates.jsonl` carries two `_x.ai/session/update`
 * tags — `subagent_spawned` (subagent_id, child_session_id, subagent_type,
 * description, …) and `subagent_finished` (subagent_id, status, …) — forwarded
 * here by grok-tmux.ts's `dispatchGrokUpdateLine` through the injected
 * `grokSubagentLineHook` (see grok-tmux.ts; this module registers itself into
 * that hook the first time a manager attaches, never at module-eval time, so
 * the cyclic import between this file and grok-tmux.ts stays eval-safe).
 * Unlike claude's synchronous-subagent problem, grok's `subagent_finished` is
 * an authoritative terminal event — no tool_result-scan fallback needed (A3).
 *
 * A per-task `ManagerState` (attached via `attachGrokSubagentManager`, one per
 * task at a time — mirrors claude-subagents.ts's `watchers` map) owns a
 * `Map<subagentId, ChildTailerState>`: one poll+watch tailer per live child
 * session, each mapping lines through grok-tmux.ts's `mapGrokUpdateEvent`
 * with `includeText: true` (the child transcript has no stdout of its own —
 * unlike the parent, whose stdout log owns message/thought content — so text
 * must come from its `updates.jsonl` instead) and persisting/emitting each
 * chunk tagged with the subagent id.
 *
 * Defensive throughout (D6): every field read is tolerant, a malformed
 * spawn/finish line or a JSON.parse failure on a child line is a no-op (never
 * throws into the parent tailer or the poll timer), a missing
 * `child_session_id` yields a row with a placeholder `sourcePath` and no
 * child tail rather than crashing, and an unrecognized `subagent_finished`
 * status settles as `"failed"` (conservative, mirrors the death-watch's
 * fail-safe default). Gated behind `AGETOR_GROK_TRACK_SUBAGENTS` (default on).
 * ────────────────────────────────────────────────────────────────────────── */

import {
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  watch as fsWatch,
  type FSWatcher,
} from "node:fs";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { runs, subagents as subagentsDb } from "./db.ts";
import type { ChunkHandler } from "./claude-tmux.ts";
import {
  encodeGrokCwd,
  mapGrokUpdateEvent,
  scanForGrokUpdatesPath,
  setGrokSubagentLineHook,
  type GrokSubagentLineCtx,
} from "./grok-tmux.ts";
import type { RunEvent, Subagent, SubagentEvent, SubagentStatus } from "../shared/types.ts";

/** Off only when explicitly disabled — mirrors claude-subagents.ts's `ENABLED`.
 *  Read once at module load; a bad/undocumented grok schema change can be
 *  contained by flipping this without shipping a new build. */
const ENABLED = process.env.AGETOR_GROK_TRACK_SUBAGENTS !== "0";

/** Poll cadence for each child session tailer. Grok's `subagent_finished` is
 *  authoritative (no idle-detection needed like claude's `DONE_IDLE_MS`), so
 *  this only governs how quickly a running subagent's transcript feels live. */
const CHILD_POLL_MS = 200;

/* ────────────────────────────────────────────────────────────────────────── *
 * Injected sinks — same decoupling seams as claude-subagents.ts, wired by the
 * orchestrator at startup. Kept as injected dependencies (not direct
 * orchestrator.ts imports) to avoid a hard cycle and keep this module
 * DB-only-testable when nothing is registered.
 * ────────────────────────────────────────────────────────────────────────── */

let emitFn: ((e: RunEvent) => void) | null = null;
/** Returns the previously-registered sink — a test that installs a spy here
 *  must put the real one back (bun test shares one process across files). */
export function setGrokSubagentEmitter(
  fn: ((e: RunEvent) => void) | null,
): ((e: RunEvent) => void) | null {
  const prev = emitFn;
  emitFn = fn;
  return prev;
}

let settleFn: ((taskId: string) => void) | null = null;
/** Returns the previously-registered hook, same save/restore contract as
 *  `setGrokSubagentEmitter`. */
export function setGrokSubagentSettleHook(
  fn: ((taskId: string) => void) | null,
): ((taskId: string) => void) | null {
  const prev = settleFn;
  settleFn = fn;
  return prev;
}
function fireSettle(taskId: string): void {
  try {
    settleFn?.(taskId);
  } catch (e) {
    console.error(`[grok-subagents] settle hook threw for task ${taskId}:`, e);
  }
}

let parkedDiscoveryFn: ((taskId: string) => void) | null = null;
/** Returns the previously-registered hook, same save/restore contract as
 *  `setGrokSubagentEmitter`. */
export function setGrokParkedDiscoveryHandler(
  fn: ((taskId: string) => void) | null,
): ((taskId: string) => void) | null {
  const prev = parkedDiscoveryFn;
  parkedDiscoveryFn = fn;
  return prev;
}
function fireParkedDiscovery(taskId: string): void {
  try {
    parkedDiscoveryFn?.(taskId);
  } catch (e) {
    console.error(`[grok-subagents] parked-discovery hook threw for task ${taskId}:`, e);
  }
}

function emitLifecycle(subagent: Subagent, phase: "started" | "finished"): void {
  const payload: SubagentEvent = { phase, subagent };
  try {
    emitFn?.({
      runId: subagent.runId ?? subagent.id,
      taskId: subagent.taskId,
      stream: "subagent",
      data: JSON.stringify(payload),
      ts: Date.now(),
      subagentId: subagent.id,
    });
  } catch (e) {
    console.error(`[grok-subagents] lifecycle emit failed for subagent ${subagent.id}:`, e);
  }
}

/**
 * Orphan every still-`running` grok subagent row for a task and settle it —
 * the counterpart to a run's own orphan path. Called both externally (boot
 * reconciliation, teardown) and internally by `attachGrokSubagentManager`
 * whenever a task's manager is torn down (turn ended, task deleted, agent
 * switched) — the thing those subagents were reporting into is gone, so their
 * `running` status would otherwise hold the task hostage forever. Safe with
 * no rows to orphan, no manager attached, or mid-shutdown.
 */
export function orphanRunningGrokSubagents(taskId: string): void {
  let rows: Subagent[];
  try {
    rows = subagentsDb.orphanRunning(taskId, Date.now());
  } catch (e) {
    console.error(`[grok-subagents] orphanRunning failed for task ${taskId}:`, e);
    return;
  }
  if (rows.length === 0) return;
  for (const row of rows) {
    try {
      emitLifecycle(row, "finished");
    } catch (e) {
      console.error(`[grok-subagents] orphan lifecycle emit failed for subagent ${row.id}:`, e);
    }
  }
  fireSettle(taskId);
}

/** Idempotent settle: only flips a row that is currently `running`, mirroring
 *  `claude-subagents.ts`'s use of `subagentsDb.markSettledById` — but built on
 *  `get` + `setStatus` (both already accept the full `SubagentStatus` union)
 *  rather than `markSettledById` itself, whose exported TS signature is
 *  narrowed to `"completed" | "orphaned"` and can't express grok's `"failed"`/
 *  `"cancelled"` terminal states without widening db.ts (out of scope here). */
function settleGrokSubagent(
  id: string,
  status: SubagentStatus,
): { changed: boolean; row: Subagent | null } {
  let row: Subagent | null;
  try {
    row = subagentsDb.get(id);
  } catch (e) {
    console.error(`[grok-subagents] get failed for subagent ${id}:`, e);
    return { changed: false, row: null };
  }
  if (!row || row.status !== "running") return { changed: false, row };
  const now = Date.now();
  try {
    subagentsDb.setStatus(id, status, now);
  } catch (e) {
    console.error(`[grok-subagents] setStatus failed for subagent ${id}:`, e);
    return { changed: false, row };
  }
  return { changed: true, row: { ...row, status, endedAt: now } };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Child transcript tailer — one per live subagent.
 * ────────────────────────────────────────────────────────────────────────── */

interface ChildTailerState {
  subagentId: string;
  runId: string;
  childSessionId: string | null;
  /** Resolved once found; sticky thereafter (grok writes to the same file for
   *  the rest of the subagent's session). Null until resolved (or forever, if
   *  every path guess misses — graceful degrade, row stays but never tails). */
  path: string | null;
  offset: number;
  decoder: StringDecoder;
  partial: string;
  lineNo: number;
  seen: Set<string>;
  pollTimer: ReturnType<typeof setInterval> | null;
  watcher: FSWatcher | null;
}

function stopChildTailer(child: ChildTailerState): void {
  if (child.watcher) { try { child.watcher.close(); } catch { /* noop */ } child.watcher = null; }
  if (child.pollTimer) { clearInterval(child.pollTimer); child.pollTimer = null; }
}

/** Best-effort resolution of a child session's `updates.jsonl`: the computed
 *  short-path encoding first, falling through to the directory scan (covers
 *  the >255-byte blake3 long-path case and any encoder drift) — same
 *  fall-through shape as `flushGrokUpdates` in grok-tmux.ts. */
function resolveChildPath(grokHome: string, cwd: string, childSessionId: string): string | null {
  const encoded = encodeGrokCwd(cwd);
  if (encoded) {
    const candidate = path.join(grokHome, "sessions", encoded, childSessionId, "updates.jsonl");
    if (existsSync(candidate)) return candidate;
  }
  return scanForGrokUpdatesPath(grokHome, childSessionId);
}

/** Unwrap one `updates.jsonl` line's envelope (same shape as grok-tmux.ts's
 *  `dispatchGrokUpdateLine`: `{"method":"session/update","params":{"update":…}}`,
 *  or a legacy params-shaped root with no `method`) and map it through the
 *  shared `mapGrokUpdateEvent` with `includeText: true`. `_x.ai/session/update`
 *  lines inside a CHILD transcript (nested subagent spawns) are ignored — v1
 *  ships `spawnDepth: 1` for every row (A4); a future nested-subagent pass
 *  would hook in here. */
function dispatchChildUpdateLine(
  parsed: unknown,
  lineIndex: number,
  dedupChunk: ChunkHandler,
  keyScope: string,
): void {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const root = parsed as Record<string, unknown>;
  const method = typeof root.method === "string" ? root.method : undefined;
  if (method !== undefined && method !== "session/update") return;
  const paramsSource = method === "session/update" ? root.params : root;
  if (!paramsSource || typeof paramsSource !== "object") return;
  const update = (paramsSource as Record<string, unknown>).update;
  if (!update || typeof update !== "object") return;
  mapGrokUpdateEvent(update as Record<string, unknown>, lineIndex, dedupChunk, {
    includeText: true,
    keyScope,
  });
}

function flushChildTailer(state: ManagerState, child: ChildTailerState, ctx: GrokSubagentLineCtx): void {
  if (state.disposed) return;
  if (!child.path) {
    if (!child.childSessionId) return; // D6: nothing to resolve a path from
    const resolved = resolveChildPath(ctx.grokHome, ctx.cwd, child.childSessionId);
    if (!resolved) return; // file not written yet (or every guess missed) — retry next tick
    child.path = resolved;
  }

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(child.path);
    if (st.size <= child.offset) return;
  } catch {
    return; // transient stat error, or file vanished
  }

  let fd: number;
  try {
    fd = openSync(child.path, "r");
  } catch {
    return;
  }
  let buf: Buffer;
  try {
    const len = st.size - child.offset;
    buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, child.offset);
    child.offset += len;
  } finally {
    closeSync(fd);
  }
  child.partial += child.decoder.write(buf);

  const lines = child.partial.split("\n");
  child.partial = lines.pop() ?? "";
  if (lines.length === 0) return;

  const dedupChunk: ChunkHandler = (stream, data, lineUuid) => {
    if (lineUuid) {
      if (child.seen.has(lineUuid)) return;
      child.seen.add(lineUuid);
    }
    try {
      runs.appendEvent(child.runId, stream, data, lineUuid ?? null, child.subagentId);
    } catch (e) {
      console.error(`[grok-subagents] appendEvent failed for subagent ${child.subagentId}:`, e);
    }
    try {
      emitFn?.({
        runId: child.runId,
        taskId: state.taskId,
        stream,
        data,
        ts: Date.now(),
        subagentId: child.subagentId,
      });
    } catch (e) {
      console.error(`[grok-subagents] chunk emit failed for subagent ${child.subagentId}:`, e);
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      child.lineNo++;
      continue; // grok's own file — skip silently, no stderr noise
    }
    try {
      dispatchChildUpdateLine(parsed, child.lineNo, dedupChunk, child.childSessionId ?? child.subagentId);
    } catch (e) {
      // A bad line must never take the tailer (or the parent's line hook
      // caller) down with it.
      console.error(`[grok-subagents] child line dispatch threw for subagent ${child.subagentId}:`, e);
    }
    child.lineNo++;
  }
}

function startChildTailer(state: ManagerState, child: ChildTailerState, ctx: GrokSubagentLineCtx): void {
  const tick = () => {
    try {
      flushChildTailer(state, child, ctx);
    } catch (e) {
      console.error(`[grok-subagents] child tailer tick threw for subagent ${child.subagentId}:`, e);
    }
    if (!child.watcher && child.path && existsSync(child.path)) {
      try {
        child.watcher = fsWatch(child.path, () => {
          try { flushChildTailer(state, child, ctx); } catch { /* next poll tick recovers */ }
        });
      } catch { /* fall back to poll-only */ }
    }
  };
  child.pollTimer = setInterval(tick, CHILD_POLL_MS);
  tick();
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Manager: one per task, owns every live child tailer for that task's
 * currently in-flight turn.
 * ────────────────────────────────────────────────────────────────────────── */

interface ManagerState {
  taskId: string;
  children: Map<string, ChildTailerState>; // keyed by subagent_id
  disposed: boolean;
}

const managers = new Map<string, ManagerState>(); // taskId -> state

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function handleSpawn(state: ManagerState, u: Record<string, unknown>, ctx: GrokSubagentLineCtx): void {
  const subagentId = str(u.subagent_id);
  if (!subagentId) return; // D6: missing subagent_id — nothing stable to key on
  if (state.children.has(subagentId)) return; // idempotent: duplicate/replayed spawn line

  // Reattach replays the parent updates.jsonl from offset 0, so a spawn line
  // for a subagent that ALREADY finished before the restart re-dispatches
  // here. insertIfAbsent/settle are DB-idempotent, but the emit is not — a
  // "started" lifecycle event would flip a completed subagent back to running
  // on the live stream (the later "finished" replay then no-ops, since the row
  // is already terminal). Skip resurrecting an existing terminal row entirely:
  // don't emit "started", don't tail. Only a row still `running` at crash time
  // (or a genuinely new one) falls through to re-emit and re-tail.
  const existing = subagentsDb.get(subagentId);
  if (existing && existing.status !== "running") return;

  const childSessionId = str(u.child_session_id) ?? null;
  const startedAt = Date.now();
  const resolvedPath = childSessionId ? resolveChildPath(ctx.grokHome, ctx.cwd, childSessionId) : null;

  const subagent: Subagent = {
    id: subagentId,
    taskId: ctx.taskId,
    runId: ctx.runId,
    parentKind: "subagent",
    agentType: str(u.subagent_type) ?? null,
    description: str(u.description) ?? null,
    spawnDepth: 1, // A4: grok's `resumed_from` is lineage, not nesting depth — v1 ships flat
    // Advisory only for grok (unlike claude, whose sourcePath is the tailer's
    // input). The child updates.jsonl almost never exists at spawn time, so
    // this is usually the placeholder; the tailer re-resolves the real path in
    // memory each tick (`flushChildTailer`) and never depends on this column,
    // so it's left un-updated rather than adding a DB writer for a cosmetic value.
    sourcePath: resolvedPath ?? `<unresolved:${childSessionId ?? "no-child-session-id"}>`,
    status: "running",
    startedAt,
    endedAt: null,
  };

  try {
    subagentsDb.insertIfAbsent(subagent);
  } catch (e) {
    console.error(`[grok-subagents] insertIfAbsent failed for subagent ${subagentId}:`, e);
    return;
  }

  const child: ChildTailerState = {
    subagentId,
    runId: ctx.runId,
    childSessionId,
    path: resolvedPath,
    offset: 0,
    decoder: new StringDecoder("utf8"),
    partial: "",
    lineNo: 0,
    seen: runs.seenLineUuidsForSubagent(subagentId),
    pollTimer: null,
    watcher: null,
  };
  state.children.set(subagentId, child);

  emitLifecycle(subagent, "started");
  fireParkedDiscovery(ctx.taskId);

  // D6: no child_session_id at all — keep the row (placeholder sourcePath),
  // just never start a tail for it. `subagent_finished` still settles it.
  if (childSessionId) startChildTailer(state, child, ctx);
}

function handleFinish(state: ManagerState, u: Record<string, unknown>): void {
  const subagentId = str(u.subagent_id);
  if (!subagentId) return;

  const rawStatus = str(u.status);
  const status: SubagentStatus =
    rawStatus === "completed" ? "completed"
    : rawStatus === "cancelled" ? "cancelled"
    : "failed"; // D6: unknown/missing status (or explicit "failed") settles conservatively

  const settled = settleGrokSubagent(subagentId, status);
  if (settled.changed && settled.row) {
    emitLifecycle(settled.row, "finished");
    fireSettle(state.taskId);
  }

  const child = state.children.get(subagentId);
  if (child) {
    stopChildTailer(child);
    state.children.delete(subagentId);
  }
}

/** The single process-wide line hook registered into grok-tmux.ts (see
 *  `ensureLineHookRegistered`) — routes a `subagent_spawned`/`subagent_finished`
 *  update to whichever task's manager is currently attached, a no-op if none
 *  is (task's manager already disposed, or was never enabled). */
function routeSubagentLine(update: Record<string, unknown>, ctx: GrokSubagentLineCtx): void {
  const state = managers.get(ctx.taskId);
  if (!state || state.disposed) return;
  const tag = typeof update.sessionUpdate === "string" ? update.sessionUpdate : undefined;
  if (tag === "subagent_spawned") handleSpawn(state, update, ctx);
  else if (tag === "subagent_finished") handleFinish(state, update);
}

let hookRegistered = false;
/** Registers `routeSubagentLine` into grok-tmux.ts's injected hook slot, once,
 *  the first time a manager attaches — deliberately NOT at this module's
 *  top-level/eval time. grok-tmux.ts statically imports `attachGrokSubagentManager`
 *  from this file (so it can instantiate/store/dispose a manager per session),
 *  and this file statically imports several helpers back from grok-tmux.ts —
 *  a real cyclic import, same shape as the existing claude-tmux.ts ↔
 *  claude-subagents.ts cycle. Deferring the actual `setGrokSubagentLineHook`
 *  CALL to first-attach (a runtime event, well after both modules have
 *  finished evaluating) rather than firing it during either module's
 *  top-level evaluation is what keeps the cycle eval-safe. */
function ensureLineHookRegistered(): void {
  if (hookRegistered) return;
  hookRegistered = true;
  setGrokSubagentLineHook(routeSubagentLine);
}

export interface GrokSubagentManagerHandle {
  dispose(): void;
}

function detachGrokSubagentManager(taskId: string): void {
  const state = managers.get(taskId);
  if (!state) return;
  state.disposed = true;
  for (const child of state.children.values()) stopChildTailer(child);
  managers.delete(taskId);
  orphanRunningGrokSubagents(taskId);
}

/**
 * Attach a fresh per-task subagent manager — called by grok-tmux.ts from
 * `spawnGrokViaTmux`/`reattachGrokSession`, once the turn's tmux session is
 * confirmed up. One live manager per task, tops (mirrors claude-subagents.ts's
 * `watchers` map): attaching for a task that already has one tears the old
 * one down first (stops its child tailers, orphans anything still `running`)
 * rather than stacking two managers with independent state on the same task.
 * Returns a no-op handle when tracking is disabled via
 * `AGETOR_GROK_TRACK_SUBAGENTS=0` — callers don't need to check the flag
 * themselves.
 */
export function attachGrokSubagentManager(ctx: GrokSubagentLineCtx): GrokSubagentManagerHandle {
  ensureLineHookRegistered();
  detachGrokSubagentManager(ctx.taskId);
  if (!ENABLED) return { dispose() { /* disabled */ } };

  const state: ManagerState = {
    taskId: ctx.taskId,
    children: new Map(),
    disposed: false,
  };
  managers.set(ctx.taskId, state);

  return {
    dispose(): void {
      detachGrokSubagentManager(ctx.taskId);
    },
  };
}
