/* ────────────────────────────────────────────────────────────────────────── *
 * Background / sub-agent tracking.
 *
 * When a claude task spawns a sub-agent (the Agent/Task tool — Explore,
 * general-purpose, …, whether synchronous or run-in-background), claude writes
 * that agent's FULL transcript to its own sidechain file, a sibling of the main
 * session JSONL we already tail:
 *
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl            ← main stream
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/
 *         agent-<agentId>.jsonl      ← per-subagent transcript (isSidechain:true)
 *         agent-<agentId>.meta.json  ← { agentType, description, toolUseId, spawnDepth }
 *
 * The `<sessionId>/subagents/` dir is created lazily — it only exists once a
 * sub-agent has run. We watch it, tail each `agent-*.jsonl` with the SAME
 * mapper the main stream uses (`mapJsonlEventToChunks`), and persist/emit each
 * event tagged with the subagent's id so the run panel can render a read-only
 * per-subagent tab. The main session JSONL still shows the launching `Agent`
 * tool-use card; the tab is the drill-in.
 *
 * This module is READ-ONLY w.r.t. the agent: it watches files and tails them.
 * It never spawns, signals, or tears down a tmux session — `detach()` only
 * closes fs watchers + the poll timer.
 *
 * The format is internal to claude and the docs warn it can change between
 * versions, so everything here is defensive (missing dir / meta / fields all
 * degrade gracefully) and gated behind AGETOR_TRACK_SUBAGENTS (default on).
 * A parse error on one subagent file can never affect the main stream — it is
 * isolated to that file's tail.
 * ────────────────────────────────────────────────────────────────────────── */

import {
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
  readFileSync,
  watch as fsWatch,
  type FSWatcher,
} from "node:fs";
import path from "node:path";
import { runs, subagents as subagentsDb, tasks } from "./db.ts";
import { mapJsonlEventToChunks } from "./claude-tmux.ts";
import type { RunEvent, Subagent, SubagentEvent, SubagentStatus } from "../shared/types.ts";

/** Off only when explicitly disabled. The watcher is cheap when idle, but the
 *  flag lets us kill it entirely if a future claude layout change breaks the
 *  on-disk assumptions, without shipping a new build. */
const ENABLED = process.env.AGETOR_TRACK_SUBAGENTS !== "0";

/** Poll cadence while at least one subagent is still running — fast enough to
 *  feel live in the panel, cheap enough (a stat per file) to run per task. */
const FAST_POLL_MS = 600;
/** Cadence when nothing is running (or the dir doesn't exist yet). A board of
 *  completed-but-undeleted tasks shouldn't burn CPU; mirrors the main scraper's
 *  idle-throttle lesson. */
const SLOW_POLL_MS = 4000;
/** After a subagent's transcript shows an end_turn and then goes quiet for this
 *  long, treat it as finished. A later append (a resumed background agent)
 *  flips it back to running. */
const DONE_IDLE_MS = 1500;

/**
 * SSE sink, injected once by the orchestrator at startup (which owns the
 * subscriber fan-out via `emit`). Kept as an injected dependency rather than a
 * direct import to avoid a hard cycle and to leave the watcher unit-testable
 * (DB-only) when no emitter is registered.
 */
let emitFn: ((e: RunEvent) => void) | null = null;
export function setSubagentEmitter(fn: ((e: RunEvent) => void) | null): void {
  emitFn = fn;
}

interface SubagentMeta {
  agentType: string | null;
  description: string | null;
  spawnDepth: number;
}

/** Read & parse `agent-<id>.meta.json`. Tolerates absence / malformed JSON —
 *  the transcript is the source of truth; the sidecar is just a nicer label. */
function readMeta(subagentsDir: string, id: string): SubagentMeta {
  try {
    const raw = readFileSync(path.join(subagentsDir, `agent-${id}.meta.json`), "utf8");
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      agentType: typeof o.agentType === "string" ? o.agentType : null,
      description: typeof o.description === "string" ? o.description : null,
      spawnDepth: typeof o.spawnDepth === "number" ? o.spawnDepth : 1,
    };
  } catch {
    return { agentType: null, description: null, spawnDepth: 1 };
  }
}

/** Read bytes appended to a file since `offset`. Sync (like the main stream's
 *  `flushSync`) — keeps the per-tick body simple and ordered. */
function readAppendedSync(filePath: string, offset: number): { text: string; next: number } {
  let st;
  try { st = statSync(filePath); } catch { return { text: "", next: offset }; }
  if (st.size <= offset) return { text: "", next: offset };
  const len = st.size - offset;
  const buf = Buffer.alloc(len);
  let fd;
  try { fd = openSync(filePath, "r"); } catch { return { text: "", next: offset }; }
  try {
    readSync(fd, buf, 0, len, offset);
  } finally {
    closeSync(fd);
  }
  return { text: buf.toString("utf8"), next: st.size };
}

interface FileState {
  subagentId: string;
  /** Parent run the events attach to — captured at discovery, then stable. */
  runId: string;
  /** Byte cursor into the subagent JSONL. */
  offset: number;
  /** Line uuids already dispatched (dedup; seeded from DB on reattach). */
  seen: Set<string>;
  /** Whether we've observed an assistant end_turn — gate for done-detection. */
  sawEndOfTurn: boolean;
  /** `Date.now()` of the last byte we read — the idle clock for done-detection. */
  lastAppendAt: number;
  status: SubagentStatus;
  sourcePath: string;
  agentType: string | null;
  description: string | null;
  spawnDepth: number;
  startedAt: number;
  endedAt: number | null;
}

export interface SubagentWatcherHandle {
  detach(): void;
  /** Run a single discover → tail → done-check cycle synchronously, without
   *  touching the poll schedule. Production never calls this (the timer drives
   *  it); tests use it with an injected `now` to exercise the watcher
   *  deterministically instead of waiting on real timers. */
  pump(now?: number): void;
}

/** The run a newly-discovered subagent should attach its events to: the task's
 *  current run if one is live, else its most recent run. `task.runId` survives
 *  the resolve-to-`review` transition, so this is reliably set while the
 *  session is alive — but fall back defensively. */
function resolveRunId(taskId: string): string | null {
  const t = tasks.get(taskId);
  if (t?.runId) return t.runId;
  return runs.listForTask(taskId)[0]?.id ?? null;
}

function toSubagentShape(fs: FileState, taskId: string): Subagent {
  return {
    id: fs.subagentId,
    taskId,
    runId: fs.runId,
    parentKind: "subagent",
    agentType: fs.agentType,
    description: fs.description,
    spawnDepth: fs.spawnDepth,
    sourcePath: fs.sourcePath,
    status: fs.status,
    startedAt: fs.startedAt,
    endedAt: fs.endedAt,
  };
}

/**
 * Start watching `<sessionId>/subagents/` for the given task. The directory is
 * derived from the main session's `jsonlPath` so it tracks whatever layout
 * (fresh vs legacy configDir) that path resolved to. Returns a handle whose
 * `detach()` releases all timers/watchers — and nothing else.
 */
export function attachSubagentWatcher(opts: {
  taskId: string;
  jsonlPath: string;
  /** Test-only: suppress the self-scheduling poll timer so a test drives the
   *  watcher via `pump()` instead of real timers. */
  manual?: boolean;
}): SubagentWatcherHandle {
  if (!ENABLED) return { detach() { /* disabled */ }, pump() { /* disabled */ } };

  const { taskId } = opts;
  const sessionId = path.basename(opts.jsonlPath, ".jsonl");
  const subagentsDir = path.join(path.dirname(opts.jsonlPath), sessionId, "subagents");
  const files = new Map<string, FileState>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirWatcher: FSWatcher | null = null;
  let detached = false;

  // Reattach: rehydrate subagents this task already had so we resume their
  // tails from offset 0 (the DB-seeded `seen` set suppresses re-emission of
  // already-persisted lines). A row left `running` whose transcript is actually
  // finished gets reconciled by the normal done-check on the next tick.
  for (const row of subagentsDb.listForTask(taskId)) {
    files.set(row.id, {
      subagentId: row.id,
      runId: row.runId ?? resolveRunId(taskId) ?? row.id,
      offset: 0,
      seen: runs.seenLineUuidsForSubagent(row.id),
      sawEndOfTurn: false,
      lastAppendAt: 0,
      status: row.status,
      sourcePath: row.sourcePath,
      agentType: row.agentType,
      description: row.description,
      spawnDepth: row.spawnDepth,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
    });
  }

  function emitLifecycle(fs: FileState, phase: "started" | "finished"): void {
    const payload: SubagentEvent = { phase, subagent: toSubagentShape(fs, taskId) };
    emitFn?.({
      runId: fs.runId,
      taskId,
      stream: "subagent",
      data: JSON.stringify(payload),
      ts: Date.now(),
      subagentId: fs.subagentId,
    });
  }

  /** Pick up newly-created `agent-*.jsonl` files. */
  function discover(): void {
    let entries: string[];
    try { entries = readdirSync(subagentsDir); } catch { return; }
    for (const name of entries) {
      const m = /^agent-(.+)\.jsonl$/.exec(name);
      if (!m) continue;
      const id = m[1]!;
      if (files.has(id)) continue;
      const runId = resolveRunId(taskId);
      // Without a run to attach to we can't persist (run_events.run_id is NOT
      // NULL). In practice a live session always has a run; skip defensively
      // and retry on a later tick if that ever isn't true.
      if (!runId) continue;
      const meta = readMeta(subagentsDir, id);
      const startedAt = Date.now();
      const fs: FileState = {
        subagentId: id,
        runId,
        offset: 0,
        seen: new Set(),
        sawEndOfTurn: false,
        lastAppendAt: startedAt,
        status: "running",
        sourcePath: path.join(subagentsDir, name),
        agentType: meta.agentType,
        description: meta.description,
        spawnDepth: meta.spawnDepth,
        startedAt,
        endedAt: null,
      };
      files.set(id, fs);
      subagentsDb.insertIfAbsent(toSubagentShape(fs, taskId));
      emitLifecycle(fs, "started");
    }
  }

  /** Tail one subagent file: dispatch newly-appended lines through the shared
   *  mapper, persisting + emitting each chunk tagged with the subagent id. */
  function tailFile(fs: FileState): void {
    const { text, next } = readAppendedSync(fs.sourcePath, fs.offset);
    if (!text) return;
    const lines = text.split("\n");
    const tail = lines.pop() ?? ""; // partial trailing line — re-read next tick
    fs.offset = next - Buffer.byteLength(tail, "utf8");
    for (const line of lines) {
      if (!line) continue;
      // Line-level dedup (the mapper can fire onChunk several times per line —
      // one per content block — all sharing the line uuid, so we must gate on
      // the line, not per onChunk call). Peek the uuid + end_turn first.
      let uuid: string | undefined;
      let endTurnHint = false;
      try {
        const o = JSON.parse(line) as { uuid?: unknown; type?: unknown; message?: { stop_reason?: unknown } };
        uuid = typeof o.uuid === "string" ? o.uuid : undefined;
        endTurnHint = o.type === "assistant" && o.message?.stop_reason === "end_turn";
      } catch { /* fall through; mapper will surface the parse error */ }

      if (uuid && fs.seen.has(uuid)) {
        if (endTurnHint) fs.sawEndOfTurn = true;
        continue;
      }
      // A previously-finished subagent that started writing again (resumed
      // background agent) flips back to running before we emit its new turn.
      if (fs.status !== "running") {
        fs.status = "running";
        fs.endedAt = null;
        subagentsDb.setStatus(fs.subagentId, "running", null);
        emitLifecycle(fs, "started");
      }
      const { endOfTurn } = mapJsonlEventToChunks(line, (stream, data, lineUuid) => {
        runs.appendEvent(fs.runId, stream, data, lineUuid ?? null, fs.subagentId);
        emitFn?.({ runId: fs.runId, taskId, stream, data, ts: Date.now(), subagentId: fs.subagentId });
      });
      if (uuid) fs.seen.add(uuid);
      if (endOfTurn) fs.sawEndOfTurn = true;
      fs.lastAppendAt = Date.now();
    }
  }

  /** Flip subagents to `completed` once their transcript ends + goes quiet. */
  function checkDone(now: number): void {
    for (const fs of files.values()) {
      if (fs.status === "running" && fs.sawEndOfTurn && now - fs.lastAppendAt > DONE_IDLE_MS) {
        fs.status = "completed";
        fs.endedAt = now;
        subagentsDb.setStatus(fs.subagentId, "completed", now);
        emitLifecycle(fs, "finished");
      }
    }
  }

  function armDirWatcher(): void {
    if (dirWatcher || !existsSync(subagentsDir)) return;
    try {
      dirWatcher = fsWatch(subagentsDir, { persistent: false }, () => {
        if (detached) return;
        try { discover(); for (const fs of files.values()) tailFile(fs); } catch { /* never crash the watcher */ }
      });
    } catch { /* fs.watch unsupported on this FS — the poll backstop covers it */ }
  }

  /** One discover → tail → done-check pass, with no scheduling side effects. */
  function cycle(now: number): void {
    if (detached) return;
    try {
      armDirWatcher();
      discover();
      for (const fs of files.values()) tailFile(fs);
      checkDone(now);
    } catch { /* swallow — never crash the timer */ }
  }

  function tick(): void {
    if (detached) return;
    cycle(Date.now());
    const anyRunning = [...files.values()].some((f) => f.status === "running");
    timer = setTimeout(tick, anyRunning ? FAST_POLL_MS : SLOW_POLL_MS);
  }

  // Kick off on the next tick (give the spawn path a beat to settle). Tests
  // pass `manual` and drive `pump()` themselves.
  if (!opts.manual) timer = setTimeout(tick, FAST_POLL_MS);

  return {
    detach(): void {
      detached = true;
      if (timer) clearTimeout(timer);
      timer = null;
      dirWatcher?.close();
      dirWatcher = null;
      // NB: intentionally does NOT touch tmux. Tearing down the watcher must
      // never stop the agent — other tasks (and the user's own session) share
      // the tmux server.
    },
    pump(now?: number): void {
      cycle(now ?? Date.now());
    },
  };
}
