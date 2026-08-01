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
 * A `running` row settles via one of THREE signals, in rough order of how
 * often each fires: (1) the subagent's own file reaching an assistant
 * `stop_reason:"end_turn"` line and then going idle for `DONE_IDLE_MS`
 * (`checkDone` below); (2) a `<task-notification>` for it landing in the MAIN
 * session JSONL (async/background + nested agents only — claude-tmux.ts's
 * `fireBackgroundTaskSettled` calls into `settleSubagentById`); (3) this
 * module's own scan of the MAIN session JSONL for a `tool_result` block whose
 * `tool_use_id` matches a tracked subagent's `toolUseId` (`scanMainForToolResults`
 * below) — the fallback for a *synchronous* top-level subagent whose own file
 * never gets a terminal end_turn line (a flush loss under concurrent
 * subagents) and which gets no task-notification either. All three funnel
 * through `settleSubagentById` so the DB write / lifecycle emit / hold-release
 * bookkeeping only lives in one place.
 *
 * ── Workflows (`/workflow`) ────────────────────────────────────────────────
 *
 * A Workflow is claude's multi-agent orchestration tool. It is ALWAYS launched
 * in the background (its tool_result is an immediate `async_launched` stub), so
 * without tracking it the parent turn ends and the card jumps to `review` while
 * the workflow is still churning. Its on-disk layout is a subdirectory of the
 * same `subagents/` dir above:
 *
 *   <sessionId>/subagents/workflows/<wf_runId>/
 *         agent-<agentId>.jsonl      ← per workflow-agent transcript (sidechain)
 *         agent-<agentId>.meta.json  ← { agentType: "workflow-subagent", spawnDepth, model }
 *         journal.jsonl              ← harness-written per-agent receipts
 *
 * We model a workflow as TWO kinds of `subagents` row:
 *   • one CONTAINER row (`parentKind: "workflow"`, id = the workflow's harness
 *     taskId, sourcePath = the transcript dir). It is `running` for the
 *     workflow's WHOLE lifetime — launch line → completion notification — which
 *     is what keeps the card held in `running` across the idle gaps *between*
 *     agent waves. Nothing tails it (a directory is not a transcript); it is
 *     deliberately never entered into the `files` map.
 *   • one AGENT row per `agent-*.jsonl` (`parentKind: "workflow_agent"`), tailed
 *     by the exact same machinery regular subagents use, so each renders as a
 *     read-only tab.
 *
 * Container settle signals: (1) the completion `<task-notification>` reaching
 * claude-tmux live (→ `settleSubagentById` via the orchestrator — that path
 * needs no code here, the row PK *is* the notification's `<task-id>`);
 * (2) this module's own main-JSONL scan matching that same notification — the
 * restart-safe backstop, since boot reconciliation arms only the watcher and no
 * tmux tailer; (3) the generic orphan paths. Agent rows settle on their own
 * end_turn idle, on a `journal.jsonl` `result` receipt (the harness receipt is
 * immune to the terminal-line flush loss that concurrent agents can hit — a
 * workflow runs up to ~10 at once), or by CASCADE when their container settles.
 *
 * This module is READ-ONLY w.r.t. the agent: it watches files and tails them.
 * It never spawns, signals, or tears down a tmux session — `detach()` only
 * closes fs watchers + the poll timer.
 *
 * The format is internal to claude and the docs warn it can change between
 * versions, so everything here is defensive (missing dir / meta / fields all
 * degrade gracefully) and gated behind AGETOR_TRACK_SUBAGENTS (default on),
 * with the workflow half additionally gated behind AGETOR_TRACK_WORKFLOWS
 * (default on, nested under the former — see `WORKFLOWS_ENABLED`).
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
import { formatApiErrorDetail, mapJsonlEventToChunks } from "./claude-tmux.ts";
import type { RunEvent, Subagent, SubagentEvent, SubagentStatus } from "../shared/types.ts";

/** Off only when explicitly disabled. The watcher is cheap when idle, but the
 *  flag lets us kill it entirely if a future claude layout change breaks the
 *  on-disk assumptions, without shipping a new build. */
const ENABLED = process.env.AGETOR_TRACK_SUBAGENTS !== "0";

/** Workflow tracking (container row + per-agent rows + journal receipts), off
 *  only when explicitly disabled — and implicitly off whenever subagent
 *  tracking as a whole is. Nested deliberately: a workflow is a *kind* of
 *  background agent, so disabling the outer switch must disable this too.
 *  Setting `AGETOR_TRACK_WORKFLOWS=0` restores the pre-feature behavior exactly
 *  (no rows → no hold → no tabs), which is the rollback lever if a future
 *  claude layout change breaks the on-disk assumptions above.
 *
 *  Read once at module load, mirroring `ENABLED`. A test that needs the flag
 *  off must set the env var and then re-import this module under a
 *  cache-busting specifier (`./claude-subagents.ts?gate=<uuid>`), the same
 *  idiom the AGETOR_TRACK_SUBAGENTS test already uses. */
const WORKFLOWS_ENABLED = ENABLED && process.env.AGETOR_TRACK_WORKFLOWS !== "0";

/** Directory (under `<sessionId>/subagents/`) claude writes workflow transcript
 *  dirs into — one `<wf_runId>/` subdir per launched workflow. Created lazily,
 *  so every read of it tolerates ENOENT. */
const WORKFLOWS_SUBDIR = "workflows";

/** Per-agent completion receipts the workflow harness writes, one NDJSON line
 *  per lifecycle transition, inside each workflow transcript dir. */
const JOURNAL_FILE = "journal.jsonl";

/** How far back from the end of the MAIN session JSONL a freshly-attached
 *  watcher starts scanning for workflow signals (see the clamp in
 *  `attachSubagentWatcher`). Sized to comfortably span the last few turns of a
 *  session — a workflow launch line is a few hundred bytes and what matters is
 *  catching one issued shortly before agetor stopped — while keeping the
 *  synchronous read at attach bounded no matter how long the session has run
 *  (real transcripts reach tens of MB, and boot reconciliation attaches
 *  several watchers in one window). */
const REPLAY_WINDOW_BYTES = 4 * 1024 * 1024;

/** Poll cadence while at least one subagent is still running — fast enough to
 *  feel live in the panel, cheap enough (a stat per file) to run per task. */
const FAST_POLL_MS = 600;
/** Cadence when nothing is running (or the dir doesn't exist yet). A board of
 *  completed-but-undeleted tasks shouldn't burn CPU; mirrors the main scraper's
 *  idle-throttle lesson. */
const SLOW_POLL_MS = 4000;
/** Deeper idle tier: once this watcher has discovered zero subagents for the
 *  task AND seen no discovery / dir-watcher event for `DEEP_IDLE_AFTER_MS`,
 *  back off further to this cadence. Covers the common case of a task whose
 *  agent never spawns a sub-agent at all — most tasks — which otherwise pays
 *  `SLOW_POLL_MS` (a `readdirSync`) forever. Any discovery or dir-watcher
 *  event drops the task back to `FAST_POLL_MS` via the normal `tick` path (a
 *  discovery makes `files.size > 0`, which permanently disqualifies this
 *  tier for the watcher's lifetime). */
const DEEP_IDLE_POLL_MS = 10_000;
/** How long with zero discovered subagents and no dir/discovery activity
 *  before backing off to `DEEP_IDLE_POLL_MS`. */
const DEEP_IDLE_AFTER_MS = 60_000;
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
/** Returns the previously-registered sink. `bun test` shares one process across
 *  every test file, so a test that installs a spy here must put the real one
 *  back — otherwise it silently un-wires the orchestrator for every file that
 *  runs after it. Production ignores the return value. */
export function setSubagentEmitter(
  fn: ((e: RunEvent) => void) | null,
): ((e: RunEvent) => void) | null {
  const prev = emitFn;
  emitFn = fn;
  return prev;
}

/**
 * Settle hook, injected once by the orchestrator at startup. Fired whenever a
 * subagent transitions to a terminal state so the orchestrator can re-check
 * its "still holding this task in `running`?" predicate without this module
 * importing orchestrator.ts (same cycle-avoidance rationale as `emitFn`
 * above). The predicate itself lives on the orchestrator side — this module
 * only signals "something changed for taskId," never decides what to do.
 */
let settleFn: ((taskId: string) => void) | null = null;
/** Returns the previously-registered hook, for the same save/restore reason as
 *  `setSubagentEmitter`: nulling this in a test's `afterEach` strands every
 *  later test file with no release path, so a held task never reaches `review`. */
export function setSubagentSettleHook(
  fn: ((taskId: string) => void) | null,
): ((taskId: string) => void) | null {
  const prev = settleFn;
  settleFn = fn;
  return prev;
}

/** Call the settle hook, never letting a throwing hook reach the poll timer
 *  (or any other caller in this file) — the hook runs orchestrator logic we
 *  don't control, and a bad release predicate must not take the tail down. */
function fireSettle(taskId: string): void {
  try {
    settleFn?.(taskId);
  } catch (e) {
    console.error(`[claude-subagents] settle hook threw for task ${taskId}:`, e);
  }
}

/**
 * Parked-discovery hook, injected once by the orchestrator at startup. Fired
 * whenever this module notices a subagent that is (newly, or once again)
 * `running` — a fresh `discover()` insert, or an existing row flipping back
 * to running after a resumed background agent starts writing again. This is
 * the *opposite* direction from `settleFn`: that one says "something finished,
 * maybe release the hold"; this one says "something just started/resumed,
 * maybe pull the card back". Same cycle-avoidance rationale as `emitFn` /
 * `settleFn` — the pull-back policy (only from `review`, never from
 * `done`/`blocked`/`ready`) lives on the orchestrator side. This module only
 * signals "a subagent is running for taskId," never decides what to do.
 */
let parkedDiscoveryFn: ((taskId: string) => void) | null = null;
/** Returns the previously-registered hook, for the same save/restore reason as
 *  `setSubagentEmitter`/`setSubagentSettleHook`: a test that installs a spy
 *  here must put the real one back in `afterEach`, or every later test file
 *  loses the pull-back wiring. */
export function setParkedDiscoveryHandler(
  fn: ((taskId: string) => void) | null,
): ((taskId: string) => void) | null {
  const prev = parkedDiscoveryFn;
  parkedDiscoveryFn = fn;
  return prev;
}

/** Call the parked-discovery hook, never letting a throwing hook reach the
 *  poll timer / dir watcher callback — mirrors `fireSettle`'s posture. */
function fireParkedDiscovery(taskId: string): void {
  try {
    parkedDiscoveryFn?.(taskId);
  } catch (e) {
    console.error(`[claude-subagents] parked-discovery hook threw for task ${taskId}:`, e);
  }
}

interface SubagentMeta {
  agentType: string | null;
  description: string | null;
  spawnDepth: number;
  /** The parent `Agent` tool_use id — the correlation key for
   *  `scanMainForToolResults`. Not parsed by earlier builds, so a pre-fix row
   *  has this NULL in the DB even though the sidecar itself carries it; the
   *  rehydration loop below re-reads the sidecar to backfill it. */
  toolUseId: string | null;
}

/** Read & parse `agent-<id>.meta.json`. Tolerates absence / malformed JSON —
 *  the transcript is the source of truth; the sidecar is just a nicer label
 *  (except `toolUseId`, which has no transcript equivalent — it's the only
 *  place the tool_result correlation key exists on disk). */
function readMeta(subagentsDir: string, id: string): SubagentMeta {
  try {
    const raw = readFileSync(path.join(subagentsDir, `agent-${id}.meta.json`), "utf8");
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      agentType: typeof o.agentType === "string" ? o.agentType : null,
      description: typeof o.description === "string" ? o.description : null,
      spawnDepth: typeof o.spawnDepth === "number" ? o.spawnDepth : 1,
      toolUseId: typeof o.toolUseId === "string" ? o.toolUseId : null,
    };
  } catch {
    return { agentType: null, description: null, spawnDepth: 1, toolUseId: null };
  }
}

/** Read bytes appended to a file since `offset`. Sync (like the main stream's
 *  `flushSync`) — keeps the per-tick body simple and ordered. */
function readAppendedSync(filePath: string, offset: number): { text: string; next: number } {
  let st;
  try { st = statSync(filePath); } catch { return { text: "", next: offset }; }
  // Non-file (in practice: a directory) reads as "nothing appended" instead of
  // throwing EISDIR out of `readSync` — which, being outside this function's
  // catch, would abort the caller's whole tail/cycle pass. The only path that
  // can hand us a directory is a workflow CONTAINER row's `sourcePath`
  // (`transcriptDir`), which is deliberately kept out of the `files` map — so
  // this guard exists to make that hazard structurally impossible rather than
  // convention-dependent, including on a rollback to a build whose
  // `toSubagent` coerced container rows into ordinary subagent rows.
  if (!st.isFile()) return { text: "", next: offset };
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
  /** Which flavour of row this file backs — `"subagent"` for a classic
   *  in-session sub-agent, `"workflow_agent"` for one agent of a `/workflow`
   *  run (a file under `subagents/workflows/<wf_runId>/`). Rehydrated rows
   *  carry whatever the DB recorded, so an older `"bg_session"` row keeps its
   *  kind instead of silently being rewritten to `"subagent"`. Workflow
   *  CONTAINER rows never appear here — they're directories, not transcripts
   *  (see `WorkflowState`). */
  parentKind: Subagent["parentKind"];
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
  /** The parent `Agent` tool_use id — the correlation key `scanMainForToolResults`
   *  matches against `tool_result` blocks in the main session JSONL. Null until
   *  discovery (or rehydration backfill) finds one in the meta sidecar. */
  toolUseId: string | null;
  /** Set when `status` was flipped to `failed` via the api-error path (below),
   *  cleared the next time this row flips back to `running` (a resumed
   *  background agent appending after the abort). Distinguishes an
   *  api-errored row from an ordinary `completed` one in the "flip back to
   *  running" block, which otherwise retires `toolUseId` unconditionally —
   *  see that block for why an api-errored row must NOT lose it. */
  apiErrored: boolean;
  /** Latest mode-bearing (`system`/`permission-mode`) event seen for this
   *  subagent, passed to `mapJsonlEventToChunks` so it can suppress a
   *  same-mode repeat — same emit-on-change scheme as the main stream's
   *  `SessionState.permissionMode`. Always starts `null` (never rehydrated
   *  from the DB — nothing persists it), so reattach may re-emit one
   *  redundant chip for an already-known mode; that's a one-time echo, not
   *  the per-turn spam this exists to fix. */
  lastPermissionMode: string | null;
}

export interface SubagentWatcherHandle {
  detach(): void;
  /** Run a single discover → tail → done-check cycle synchronously, without
   *  touching the poll schedule. Production never calls this (the timer drives
   *  it); tests use it with an injected `now` to exercise the watcher
   *  deterministically instead of waiting on real timers. */
  pump(now?: number): void;
  /** Reflect an externally-driven settle (see `settleSubagentById`) into this
   *  watcher's in-memory `FileState`, if it's tracking `id` — a no-op
   *  otherwise. The DB write already happened before this is called; this
   *  just keeps the tailer's resume-detection (`tailFile`'s
   *  `fs.status !== "running"` check) and `checkDone`'s idle-detection from
   *  re-deriving a status the external settle already decided, which would
   *  otherwise re-fire a duplicate lifecycle/settle signal on the next tick. */
  syncSettled(id: string, status: SubagentStatus, endedAt: number): void;
}

/** One live watcher per task, tops — a second `attachSubagentWatcher` for the
 *  same taskId (e.g. a re-run of `reattachSession` racing a fresh spawn)
 *  would otherwise leave two timers tailing the same files with independent
 *  offsets, double-emitting everything. Keyed here instead of trusting every
 *  call site to remember to detach its previous handle first. */
const watchers = new Map<string, SubagentWatcherHandle>();

/** Detach whatever watcher is currently registered for a task, if any — a
 *  no-op when there isn't one (no live watcher, or it already detached
 *  itself). Exported so a caller can release a task's watcher without
 *  starting a replacement (e.g. session teardown). */
export function detachWatcherFor(taskId: string): void {
  watchers.get(taskId)?.detach();
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
    parentKind: fs.parentKind,
    agentType: fs.agentType,
    description: fs.description,
    spawnDepth: fs.spawnDepth,
    sourcePath: fs.sourcePath,
    toolUseId: fs.toolUseId,
    status: fs.status,
    startedAt: fs.startedAt,
    endedAt: fs.endedAt,
  };
}

/**
 * In-memory twin of a workflow CONTAINER row. Deliberately NOT a `FileState`:
 * nothing about a container is tailed — its `dir` is a directory, and handing
 * it to `readAppendedSync` would throw EISDIR out of the tail and abort the
 * whole cycle. It exists so the watcher can (a) keep the poll on the fast tier
 * while a workflow is live, (b) recognise the completion notification's
 * `<task-id>` as one of *its* workflows rather than settling arbitrary ids,
 * and (c) label freshly-discovered agent rows with the workflow's name.
 */
interface WorkflowState {
  /** Container row PK — claude's harness taskId for the workflow, which is
   *  also the `<task-id>` its completion notification carries. */
  id: string;
  /** `toolUseResult.transcriptDir` — the container row's `sourcePath`, and the
   *  directory prefix the cascade matches agent rows against. */
  dir: string;
  description: string | null;
  runId: string;
  status: SubagentStatus;
  startedAt: number;
  endedAt: number | null;
  /** The launching Workflow `tool_use` id. Metadata only — see
   *  `registerWorkflowContainer` for why it can never settle this row. */
  toolUseId: string | null;
}

/**
 * Is `filePath` inside `dir`? Both sides are `path.resolve`d first because they
 * come from different producers — a container's dir is claude's own
 * `transcriptDir` string, while agent paths are built here with `path.join` —
 * and those can disagree on symlinked or non-normalised roots (`/tmp` vs
 * `/private/tmp` on macOS, `~` symlinked homes, a trailing `.`). The explicit
 * separator suffix keeps a sibling dir whose name merely starts the same
 * (`…/wf_1` vs `…/wf_12`) from matching.
 */
function isInsideDir(filePath: string, dir: string): boolean {
  const resolved = path.resolve(dir);
  const prefix = resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
  return path.resolve(filePath).startsWith(prefix);
}

function toWorkflowShape(w: WorkflowState, taskId: string): Subagent {
  return {
    id: w.id,
    taskId,
    runId: w.runId,
    parentKind: "workflow",
    agentType: "workflow",
    description: w.description,
    spawnDepth: 1,
    sourcePath: w.dir,
    toolUseId: w.toolUseId,
    status: w.status,
    startedAt: w.startedAt,
    endedAt: w.endedAt,
  };
}

/** Same lifecycle-event shape `emitLifecycle` builds from a live `FileState`,
 *  but built straight off a DB row instead — needed for callers (like
 *  `orphanRunningSubagents` below) that fire for a task with no attached
 *  watcher, so there's no `FileState` closure to draw from. Defaults to
 *  `"finished"` because every pre-existing caller settles; workflow CONTAINER
 *  registration passes `"started"` (it has a DB row but, being
 *  directory-backed, no `FileState` to hand `emitLifecycle`). */
function emitLifecycleForRow(sub: Subagent, phase: "started" | "finished" = "finished"): void {
  const payload: SubagentEvent = { phase, subagent: sub };
  emitFn?.({
    runId: sub.runId ?? sub.id,
    taskId: sub.taskId,
    stream: "subagent",
    data: JSON.stringify(payload),
    ts: Date.now(),
    subagentId: sub.id,
  });
}

/**
 * Orphan every still-`running` subagent row for a task and settle it — the
 * counterpart to a run's own orphan path (boot reconciliation, a dead tmux
 * session, …). Called when the thing those subagents were reporting into no
 * longer exists to hear from them, so their "running" status would otherwise
 * hold the task hostage forever. Safe to call with no watcher attached, no
 * rows to orphan, or mid-shutdown — this never touches tmux and never throws.
 */
export function orphanRunningSubagents(taskId: string): void {
  let rows: Subagent[];
  try {
    rows = subagentsDb.orphanRunning(taskId, Date.now());
  } catch (e) {
    console.error(`[claude-subagents] orphanRunning failed for task ${taskId}:`, e);
    return;
  }
  if (rows.length === 0) return;
  const watcher = watchers.get(taskId);
  for (const row of rows) {
    try {
      emitLifecycleForRow(row);
    } catch (e) {
      console.error(`[claude-subagents] orphan lifecycle emit failed for subagent ${row.id}:`, e);
    }
    // Mirror the DB flip into the watcher's in-memory state. Not every orphan
    // path detaches the watcher afterwards — `stopHeldTask` orphans a task
    // whose session stays alive — so without this the watcher would keep
    // believing those rows are `running`: a settled workflow container would
    // pin the poll on `FAST_POLL_MS` forever, and `checkDone`/`tailFile` would
    // keep re-deriving state for rows the DB has already retired.
    try {
      watcher?.syncSettled(row.id, "orphaned", row.endedAt ?? Date.now());
    } catch (e) {
      console.error(`[claude-subagents] orphan sync failed for subagent ${row.id}:`, e);
    }
  }
  fireSettle(taskId);
}

/**
 * Run one synchronous watcher cycle for a task, right now, outside the poll
 * schedule — the deterministic fix for a hold-check race.
 *
 * The orchestrator decides whether a finished run must be HELD in `running`
 * by asking `subagents.hasRunning(taskId)` shortly (~`END_TURN_IDLE_FIRE_MS`)
 * after the turn's end_turn. But the signals that create those rows are
 * watcher-side and poll-driven: a task that has not yet discovered any
 * background agent polls at `SLOW_POLL_MS` (or `DEEP_IDLE_POLL_MS`), so a
 * workflow (or an async subagent) launched in the closing moments of a turn is
 * very likely NOT yet in the DB when that predicate runs. The card would then
 * flip to `review` and only be dragged back by `pullBackParkedTask` on the
 * next poll — a visible bounce plus a spurious status breadcrumb, on nearly
 * every workflow launch.
 *
 * Pumping here closes the window: the launch line is already in the main JSONL
 * by the time the turn ends, so one cycle registers the container/subagent rows
 * before the predicate reads them. A no-op when the task has no watcher (codex,
 * grok, tracking disabled) — never an error the caller has to handle.
 */
export function pumpWatcherForHoldCheck(taskId: string): void {
  if (!ENABLED) return;
  const handle = watchers.get(taskId);
  if (!handle) return;
  try {
    handle.pump();
  } catch (e) {
    // `pump` → `cycle` already swallows its own failures; this is the
    // belt-and-braces guard so a future throw can never reach run settlement.
    console.error(`[claude-subagents] hold-check pump failed for task ${taskId}:`, e);
  }
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
  /** Fired the moment a subagent's own transcript emits an API-error line
   *  (`isApiErrorMessage: true`), right after this module has already
   *  settled that subagent's row `failed`. This module has no visibility
   *  into the parent claude-tmux `SessionState` (see the module header —
   *  read-only w.r.t. the agent), so it cannot itself abort the main turn;
   *  claude-tmux wires this to `signalSubagentApiError` to do that part.
   *  `runId` (the subagent's OWN parent run — `FileState.runId`, captured at
   *  discovery time and stable thereafter) lets the claude-tmux side detect
   *  a stale async subagent from an OLDER run erroring while a NEWER run is
   *  in flight on the same session, and no-op instead of wrongly aborting
   *  the new run. */
  onApiError?: (info: { subagentId: string; detail: string; runId: string }) => void;
}): SubagentWatcherHandle {
  const { taskId } = opts;
  // Make double-attach for the same task structurally impossible: whatever
  // was watching this task before (a stale reattach, a leftover from a prior
  // spawn) gets torn down before we build the new one.
  detachWatcherFor(taskId);

  if (!ENABLED) return { detach() { /* disabled */ }, pump() { /* disabled */ }, syncSettled() { /* disabled */ } };

  const sessionId = path.basename(opts.jsonlPath, ".jsonl");
  const subagentsDir = path.join(path.dirname(opts.jsonlPath), sessionId, "subagents");
  const workflowsDir = path.join(subagentsDir, WORKFLOWS_SUBDIR);
  const files = new Map<string, FileState>();
  // Workflow CONTAINER rows this watcher knows about, keyed by container id
  // (= claude's workflow taskId). Populated by the main-JSONL launch scan and
  // by rehydration; NEVER merged into `files` (see `WorkflowState`).
  const workflows = new Map<string, WorkflowState>();
  // Workflow transcript dir -> byte cursor into its `journal.jsonl`. Keyed by
  // dir rather than by container id because an agent dir can become visible
  // before (or without) the launch line that names its container — the journal
  // receipts are useful either way.
  const wfJournals = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirWatcher: FSWatcher | null = null;
  let detached = false;
  // The first cycle tails EVERY known file (including ones the DB says are
  // already `completed`) so a reattach picks up any bytes appended while agetor
  // was down — e.g. a background agent resumed during the gap. Steady-state
  // polling then only re-reads `running` files; resumes of a finished agent
  // after that are caught by the dir watcher's append notification.
  let firstCycle = true;
  // Byte cursor into the MAIN session JSONL for `scanMainSignals` below —
  // independent of any per-subagent `FileState.offset`. Starts at 0 so a fresh
  // watcher (boot reattach, held-task repair) sees the full history on its
  // first scan, the same "offset 0 on attach" idiom the per-subagent
  // rehydration above relies on — but see the replay-window clamp after the
  // rehydration loop, which bounds that first read when the only reason to
  // scan is workflow signals.
  let mainOffset = 0;
  // `Date.now()` of the last discovery or dir-watcher event — the idle clock
  // for the deep-idle tier (`DEEP_IDLE_POLL_MS`). Only consulted while
  // `files.size === 0` (see `tick`): once any subagent is ever discovered,
  // `files.size` never goes back to 0 for this watcher's lifetime, so the
  // deep-idle tier is permanently disqualified from then on — exactly the
  // "zero subagents ever discovered for the task" gate the plan calls for.
  let lastChangeAt = Date.now();

  // Reattach: rehydrate subagents this task already had so we resume their
  // tails from offset 0 (the DB-seeded `seen` set suppresses re-emission of
  // already-persisted lines). A row left `running` whose transcript is actually
  // finished gets reconciled by the normal done-check on the next tick.
  // Never let a bad row (or a DB hiccup) crash the caller — this loop runs
  // synchronously inside `reattachSession`/the spawn IIFE, outside any tick's
  // try/catch, so it's the one place in this file that must guard itself
  // rather than rely on `cycle()`'s wrapper.
  try {
    for (const row of subagentsDb.listForTask(taskId)) {
      if (row.parentKind === "workflow") {
        // Container rows are directory-backed: they must never enter `files`
        // (nothing to tail) and must never be resurrected here — a row the DB
        // says is `completed`/`orphaned` is rehydrated with THAT status, so
        // neither a replayed launch line nor the cadence check can flip it
        // back to running, and no "started" lifecycle is re-emitted for it.
        if (WORKFLOWS_ENABLED) {
          workflows.set(row.id, {
            id: row.id,
            dir: row.sourcePath,
            description: row.description,
            runId: row.runId ?? resolveRunId(taskId) ?? row.id,
            status: row.status,
            startedAt: row.startedAt,
            endedAt: row.endedAt,
            toolUseId: row.toolUseId ?? null,
          });
          // Journal cursor starts at 0 like every other reattach cursor — the
          // receipts it replays all funnel through `settleSubagentById`, which
          // no-ops on already-settled rows.
          if (row.sourcePath && !wfJournals.has(row.sourcePath)) wfJournals.set(row.sourcePath, 0);
        }
        continue;
      }
      // Pre-fix rows (and any row whose sidecar wasn't parsed for toolUseId
      // yet) have this NULL in the DB even though the sidecar itself carries
      // it — re-read it here so the tool_result scan below can find these
      // rows too. This is what repairs already-stuck prod rows on restart.
      let toolUseId = row.toolUseId ?? null;
      if (!toolUseId) {
        const meta = readMeta(subagentsDir, row.id);
        if (meta.toolUseId) {
          toolUseId = meta.toolUseId;
          subagentsDb.setToolUseId(row.id, meta.toolUseId);
        }
      }
      files.set(row.id, {
        subagentId: row.id,
        parentKind: row.parentKind,
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
        toolUseId,
        // `"failed"` has exactly one writer in this codebase — the api-error
        // settle block below — so a rehydrated row already in that status
        // was necessarily api-errored pre-restart. Reconstructing the latch
        // here (not just at the live settle site) is what keeps the finding
        // #5 fix correct across a restart: an agetor restart right after an
        // api-error, followed by the same background agent resuming, must
        // still preserve `toolUseId` in the flip-back block below.
        apiErrored: row.status === "failed",
        lastPermissionMode: null,
      });
    }
  } catch (e) {
    // degrade gracefully — a bad rehydration row must not crash reattach —
    // but still log so a silently-empty subagent list is diagnosable.
    console.error(`[claude-subagents] rehydration failed for task ${taskId}:`, e);
  }

  // Replay-window clamp. Before workflows, the main scan only ran at all when
  // some row was waiting on a `tool_result`, so the offset-0 full read was
  // paid rarely and deliberately. Workflow signals removed that gate — every
  // attach would otherwise read the WHOLE main transcript synchronously, and
  // these files reach tens of megabytes on a long-lived session while boot
  // reconciliation attaches several watchers back-to-back.
  //
  // So: when nothing needs the full history (no `running` row waiting on a
  // tool_result correlation), start the workflow scan `REPLAY_WINDOW_BYTES`
  // from the end instead of at 0. The tool_result path is untouched — it still
  // gets its full replay when it needs one, and `discover()` still rewinds to
  // 0 outright when a new correlation key shows up.
  //
  // Accepted edges: (1) the first line read is very likely a partial one; it
  // fails `JSON.parse` and is skipped, which is exactly what a truncated line
  // deserves. (2) A workflow whose launch line sits further back than the
  // window is not re-registered by this scan — but if it was ever seen live
  // its row is already in the DB and rehydrated above (including its journal
  // cursor), and a workflow that was never seen at all belongs to a session
  // whose runs boot reconciliation orphans anyway. The window only needs to
  // cover "launched shortly before agetor went down", not all history.
  if (WORKFLOWS_ENABLED) {
    const needsFullReplay = [...files.values()].some((fs) => fs.status === "running" && fs.toolUseId);
    if (!needsFullReplay) {
      try {
        const size = statSync(opts.jsonlPath).size;
        if (size > REPLAY_WINDOW_BYTES) mainOffset = size - REPLAY_WINDOW_BYTES;
      } catch { /* no main JSONL yet — offset 0 is already right */ }
    }
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

  /** Call the per-attach `onApiError` hook, never letting a throwing hook
   *  reach `tailFile`/`cycle` — mirrors `fireSettle`/`fireParkedDiscovery`'s
   *  posture exactly: this hook runs orchestrator logic (claude-tmux's
   *  `signalSubagentApiError`, which does DB-adjacent session-state work) we
   *  don't control, and a bad handler must not take the tail (or the poll
   *  timer driving it) down. */
  function fireApiError(info: { subagentId: string; detail: string; runId: string }): void {
    try {
      opts.onApiError?.(info);
    } catch (e) {
      console.error(`[claude-subagents] api-error hook threw for subagent ${info.subagentId}:`, e);
    }
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
        parentKind: "subagent",
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
        toolUseId: meta.toolUseId,
        apiErrored: false,
        lastPermissionMode: null,
      };
      files.set(id, fs);
      lastChangeAt = Date.now();
      subagentsDb.insertIfAbsent(toSubagentShape(fs, taskId));
      // A new correlation key may have a tool_result the scan already read
      // past (its lines were consumed while only siblings were pending) —
      // rewind for one full rescan rather than strand the row until reboot.
      if (fs.toolUseId) mainOffset = 0;
      emitLifecycle(fs, "started");
      fireParkedDiscovery(taskId);
    }
  }

  /** The workflow whose transcript dir is `dir`, if this watcher has seen its
   *  launch line (or rehydrated its row). Used only for labelling — agent
   *  discovery never waits on it. */
  function workflowForDir(dir: string): WorkflowState | null {
    for (const w of workflows.values()) if (w.dir === dir) return w;
    return null;
  }

  /**
   * Should this file keep being tailed even though its row is no longer
   * `running`? Only for a workflow agent whose CONTAINER is still running.
   *
   * Steady-state tailing is restricted to `running` files, and the dir watcher
   * that would otherwise catch a late append is armed on `subagents/` and is
   * NOT recursive — so it never fires for writes inside
   * `subagents/workflows/<wf>/`. A workflow agent can be settled EARLY relative
   * to its transcript (its `journal.jsonl` receipt lands before the last lines
   * flush — which is the whole point of the receipt), and without this its tab
   * would be permanently truncated: the missing lines are never read again.
   *
   * Cheap: a settled agent's file has stopped growing, so this is a `statSync`
   * that reads nothing, and it stops entirely once the container settles.
   */
  function tailPastSettle(fs: FileState): boolean {
    if (fs.parentKind !== "workflow_agent") return false;
    for (const w of workflows.values()) {
      if (w.status === "running" && isInsideDir(fs.sourcePath, w.dir)) return true;
    }
    return false;
  }

  /**
   * Register (or re-learn) a workflow CONTAINER row from a launch line. This
   * is the row that carries the hold: `running` from launch until the
   * completion notification, so `subagents.hasRunning` stays true across the
   * quiet gaps between agent waves and the card never bounces
   * `running → review → running` mid-workflow.
   *
   * Idempotent in both directions: an id we already track in memory is left
   * alone, and an id whose row already exists in the DB is rehydrated with the
   * status the DB has — so replaying the main JSONL from offset 0 on every
   * reattach can never resurrect a settled workflow. `insertIfAbsent` is the
   * only write.
   */
  function registerWorkflowContainer(
    id: string,
    dir: string,
    description: string | null,
    toolUseId: string | null,
  ): void {
    if (workflows.has(id)) return;
    if (!wfJournals.has(dir)) wfJournals.set(dir, 0);

    const existing = subagentsDb.get(id);
    // An id that already belongs to a row of a DIFFERENT kind is left entirely
    // alone: adopting it here would let the workflow completion notification
    // settle someone else's agent. (Harness ids collide only if claude's own
    // notification routing would already be broken — this is pure paranoia.)
    if (existing && existing.parentKind !== "workflow") return;
    if (existing) {
      workflows.set(id, {
        id,
        dir: existing.sourcePath || dir,
        description: existing.description,
        runId: existing.runId ?? resolveRunId(taskId) ?? id,
        status: existing.status,
        startedAt: existing.startedAt,
        endedAt: existing.endedAt,
        toolUseId: existing.toolUseId ?? toolUseId,
      });
      lastChangeAt = Date.now();
      return;
    }

    const runId = resolveRunId(taskId);
    // No run to attach to — same defensive skip `discover()` makes; a later
    // tick re-sees the same launch line only if the offset was rewound, so
    // rather than rely on that, leave the id untracked and let the next
    // reattach (offset 0) pick it up. In practice a live session always has a
    // run by the time a workflow launches.
    if (!runId) return;
    const startedAt = Date.now();
    const w: WorkflowState = {
      id,
      dir,
      description,
      runId,
      status: "running",
      startedAt,
      endedAt: null,
      // Recorded for provenance only. The container is deliberately NOT in the
      // `files` map, and `scanMainForToolResultLine` only ever considers
      // `files` entries — so the immediate `async_launched` tool_result that
      // carries this id can never false-settle the container the way it would
      // if containers were tracked like file-backed agents.
      toolUseId,
    };
    workflows.set(id, w);
    lastChangeAt = Date.now();
    subagentsDb.insertIfAbsent(toWorkflowShape(w, taskId));
    emitLifecycleForRow(toWorkflowShape(w, taskId), "started");
    // A workflow launched on a follow-up turn must pull a parked (`review`)
    // card back to `running`, exactly like a freshly-discovered subagent.
    fireParkedDiscovery(taskId);
  }

  /** Pick up workflow transcript dirs and the `agent-*.jsonl` files inside
   *  them. Called from the same sites as `discover()`; tolerates the whole
   *  `workflows/` tree being absent (the common case — most tasks never launch
   *  a workflow). Each agent file becomes an ordinary tailed `FileState`, so
   *  its events land subagentId-tagged and it settles through the existing
   *  end_turn-idle path with no special casing downstream. */
  function discoverWorkflowAgents(): void {
    if (!WORKFLOWS_ENABLED) return;
    let dirs: string[];
    try { dirs = readdirSync(workflowsDir); } catch { return; }
    for (const dirName of dirs) {
      const dir = path.join(workflowsDir, dirName);
      let names: string[];
      // Also the is-it-a-directory probe: a stray file in `workflows/` throws
      // ENOTDIR here and is skipped, no `statSync` round-trip needed.
      try { names = readdirSync(dir); } catch { continue; }
      if (!wfJournals.has(dir)) {
        wfJournals.set(dir, 0);
        lastChangeAt = Date.now();
      }
      for (const name of names) {
        const m = /^agent-(.+)\.jsonl$/.exec(name);
        if (!m) continue;
        const id = m[1]!;
        if (files.has(id)) continue;
        const runId = resolveRunId(taskId);
        if (!runId) continue; // same defensive skip as `discover()`
        const meta = readMeta(dir, id);
        const startedAt = Date.now();
        const fs: FileState = {
          subagentId: id,
          parentKind: "workflow_agent",
          runId,
          offset: 0,
          seen: new Set(),
          sawEndOfTurn: false,
          lastAppendAt: startedAt,
          status: "running",
          sourcePath: path.join(dir, name),
          agentType: meta.agentType,
          // A workflow agent's meta sidecar carries no `description`, so fall
          // back to the workflow's own name (or, before/without its launch
          // line, the transcript dir) — an unlabelled tab is worse than a
          // coarse one.
          description: meta.description ?? workflowForDir(dir)?.description ?? dirName,
          spawnDepth: meta.spawnDepth,
          startedAt,
          endedAt: null,
          // No `toolUseId` in a workflow-agent sidecar: these agents are
          // spawned by the workflow harness, not by a parent `Agent` tool_use,
          // so there is no tool_result to correlate against. Leaving it null
          // also keeps them out of `scanMainSignals`'s pending set.
          toolUseId: null,
          apiErrored: false,
          lastPermissionMode: null,
        };
        files.set(id, fs);
        lastChangeAt = Date.now();
        subagentsDb.insertIfAbsent(toSubagentShape(fs, taskId));
        emitLifecycle(fs, "started");
        fireParkedDiscovery(taskId);
      }
    }
  }

  /**
   * Tail each known workflow dir's `journal.jsonl` — the harness's own
   * per-agent completion receipts (`{"type":"result","key","agentId","result"}`).
   * This is the flush-loss backstop: a workflow runs many agents concurrently
   * and an agent's own transcript can lose its terminal `end_turn` line under
   * that load, which would strand its row `running` forever (the same failure
   * class `scanMainForToolResults` exists to cover for synchronous subagents,
   * except a workflow agent has no tool_use id to correlate on).
   * `settleSubagentById` is idempotent, so a receipt for a row the idle path
   * already completed is a free no-op.
   */
  function tailJournals(): void {
    if (!WORKFLOWS_ENABLED) return;
    for (const [dir, offset] of wfJournals) {
      try {
        const { text, next } = readAppendedSync(path.join(dir, JOURNAL_FILE), offset);
        if (!text) continue;
        const lines = text.split("\n");
        const tail = lines.pop() ?? ""; // partial trailing line — re-read next tick
        wfJournals.set(dir, next - Buffer.byteLength(tail, "utf8"));
        for (const line of lines) {
          // Cheap prefilter: `started` receipts outnumber `result` ones and
          // carry nothing we act on.
          if (!line || !line.includes("result")) continue;
          try {
            const o = JSON.parse(line) as { type?: unknown; agentId?: unknown };
            if (o.type !== "result" || typeof o.agentId !== "string") continue;
            settleSubagentById(o.agentId, "completed");
          } catch { /* one malformed receipt must not abort the rest */ }
        }
      } catch (e) {
        console.error(`[claude-subagents] journal tail failed for ${dir}:`, e);
      }
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
      // Detected here (parsed-flag peek), NOT by string-matching the
      // rendered `CLAUDE_API_ERROR_STATUS_PREFIX` status chunk after the
      // mapper runs: the mapper's `isMeta` path forwards transcript text
      // verbatim on the `status` stream, so a transcript-controlled string
      // could otherwise spoof the sentinel, and a future wording change to
      // `formatApiErrorDetail` would silently break detection. Reading
      // `isApiErrorMessage`/`apiErrorStatus` straight off the JSONL line
      // sidesteps both.
      let apiErrorInfo: { detail: string } | null = null;
      // Peeked but not yet applied to `fs.lastPermissionMode` — see below for
      // why the apply is deferred past the dedup-skip continue.
      let linePermissionMode: string | undefined;
      try {
        const o = JSON.parse(line) as {
          uuid?: unknown;
          type?: unknown;
          message?: { stop_reason?: unknown };
          isApiErrorMessage?: unknown;
          apiErrorStatus?: unknown;
          permissionMode?: unknown;
        };
        uuid = typeof o.uuid === "string" ? o.uuid : undefined;
        endTurnHint = o.type === "assistant" && o.message?.stop_reason === "end_turn";
        // Gate the WHOLE api-error settle on `uuid` being a string: a
        // uuid-less line has no durable dedup key (`fs.seen` and
        // `run_events.line_uuid` both key off it), so a replayed uuid-less
        // line on a boot reattach would look brand-new every time and could
        // re-fire the settle (and `onApiError` → an abort of whatever run
        // happens to be in flight at that point) on every restart. Real
        // claude JSONL lines always carry a uuid in practice, so this only
        // ever excludes a malformed/synthetic line — never a genuine error.
        if (uuid !== undefined && o.isApiErrorMessage === true) {
          apiErrorInfo = {
            detail: formatApiErrorDetail(typeof o.apiErrorStatus === "number" ? o.apiErrorStatus : undefined),
          };
        }
        if ((o.type === "system" || o.type === "permission-mode") && typeof o.permissionMode === "string") {
          linePermissionMode = o.permissionMode;
        }
      } catch { /* fall through; mapper will surface the parse error */ }

      // Mirror the mode into `fs.lastPermissionMode` BEFORE the dedup-skip
      // continue below. Defensive ordering rather than a currently-exercised
      // path: real permission-mode JSONL lines carry no uuid, so they never
      // hit the `fs.seen` continue in the first place — they re-emit once
      // per reattach (the offset-0 replay has no dedup key for them), and
      // the UI's render-time collapse (`collapseRepeatedModeStatus`) is what
      // masks that residual repeat today. Keeping the mirror above the
      // continue means that if claude ever ships a uuid-bearing variant of
      // this line, it still rehydrates `fs.lastPermissionMode` correctly on
      // replay without re-emitting a chip, with no code change needed here.
      // `prevPermissionMode` is captured first so the mapper call below (for
      // lines that ARE new) compares against what we knew before this line,
      // not this line's own value.
      const prevPermissionMode = fs.lastPermissionMode;
      if (linePermissionMode !== undefined) fs.lastPermissionMode = linePermissionMode;

      if (uuid && fs.seen.has(uuid)) {
        if (endTurnHint) fs.sawEndOfTurn = true;
        continue;
      }
      // A previously-finished subagent that started writing again (resumed
      // background agent) flips back to running before we emit its new turn.
      // Reset the end-of-turn latch so the new turn must produce its OWN
      // end_turn before `checkDone` can complete it again — otherwise the stale
      // `sawEndOfTurn` from the prior turn would mark it done mid-resume.
      if (fs.status !== "running") {
        fs.status = "running";
        fs.endedAt = null;
        fs.sawEndOfTurn = false;
        // Retire the tool_result correlation key: the parent's receipt for
        // the ORIGINAL Agent tool_use predates this resume, so from here on
        // it can only mis-settle the agent (a reattach replays the main
        // JSONL from offset 0 and would re-serve it). In-memory only — the
        // DB keeps the id, and a post-restart replay can still transiently
        // re-settle a resumed agent, but the next append flips it right
        // back (dir watcher) and its real completion arrives via
        // task-notification / its own end_turn.
        //
        // EXCEPT when the row being flipped was settled `failed` via an
        // API error (`fs.apiErrored`): for a SYNCHRONOUS subagent,
        // `toolUseId` is the ONLY remaining fallback settle signal
        // (`scanMainForToolResults`) — the agent's own transcript may never
        // produce another terminal end_turn (that is the exact hang class
        // this feature exists to fix) and there is no task-notification for
        // a synchronous agent either. Retiring the id here would stop that
        // fallback from ever firing again, stranding the row `running`
        // forever after this trailing append — reintroducing the bug.
        // Keeping it means trailing garbage appended after the abort can
        // still be reconciled via the tool_result scan. The asymmetry with
        // the `completed`-row case above is deliberate: a completed row's
        // stale tool_result genuinely predates the resume and retiring it
        // there only prevents a MIS-settle, never a stuck one — so that
        // case still retires unconditionally.
        if (!fs.apiErrored) fs.toolUseId = null;
        fs.apiErrored = false;
        subagentsDb.setStatus(fs.subagentId, "running", null);
        emitLifecycle(fs, "started");
        fireParkedDiscovery(taskId);
      }
      const { endOfTurn } = mapJsonlEventToChunks(
        line,
        (stream, data, lineUuid) => {
          runs.appendEvent(fs.runId, stream, data, lineUuid ?? null, fs.subagentId);
          emitFn?.({ runId: fs.runId, taskId, stream, data, ts: Date.now(), subagentId: fs.subagentId });
        },
        // Ask the mapper to carry this line's uuid on its own api-error
        // `status` chunk too (unlike the MAIN stream's `dispatchLine`,
        // which never opts in — see `mapParsedEventToChunks`'s doc): gives
        // the row a durable `line_uuid` even in the edge case where the
        // line has no text content block to carry it instead, so reattach
        // seeding (`seenLineUuidsForSubagent`, below) reliably covers this
        // line. A harmless no-op write when a text block IS present (the
        // common case) — INSERT OR IGNORE just keeps that first row.
        true,
        prevPermissionMode,
      );
      if (uuid) fs.seen.add(uuid);
      if (endOfTurn) fs.sawEndOfTurn = true;
      fs.lastAppendAt = Date.now();
      // A reattach replay never reaches here for a HISTORICAL error line:
      // `fs.seen` is seeded from `run_events.line_uuid` on rehydrate, so the
      // dedup check above (`if (uuid && fs.seen.has(uuid))`) skips the line
      // — and this whole per-line block — before we ever get here again.
      if (apiErrorInfo !== null) {
        // Settle immediately — do NOT wait for `DONE_IDLE_MS`. Mirrors
        // `checkDone`'s completed block, but `failed` instead of
        // `completed`; DB write must land before `fireSettle` for the same
        // reason noted there (the orchestrator's release predicate reads
        // `subagentsDb.hasRunning`).
        fs.status = "failed";
        fs.endedAt = fs.lastAppendAt;
        fs.apiErrored = true;
        subagentsDb.setStatus(fs.subagentId, "failed", fs.endedAt);
        emitLifecycle(fs, "finished");
        fireSettle(taskId);
        fireApiError({ subagentId: fs.subagentId, detail: apiErrorInfo.detail, runId: fs.runId });
      }
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
        // The DB write above must land before the orchestrator's release
        // predicate (which reads subagentsDb.hasRunning) can see it as done.
        fireSettle(taskId);
      }
    }
  }

  /**
   * Third settle signal (see module header): match one MAIN-session-JSONL line
   * against the `tool_result` blocks whose `tool_use_id` equals a tracked
   * `running` subagent's `toolUseId` — the fallback for a synchronous
   * top-level subagent whose own transcript never gets a terminal end_turn
   * line and gets no task-notification either (see claude-tmux.ts's
   * `fireBackgroundTaskSettled` for that other path). A subagent discovered
   * AFTER the offset has already advanced past its tool_result (a
   * readdir-visibility race while a sibling kept the scan running) is covered
   * by `discover()` rewinding `mainOffset` to 0 for one full rescan — settles
   * are idempotent, so re-reading old lines is harmless.
   */
  function scanLineForToolResult(line: string, pending: FileState[]): void {
    // Cheap prefilter before any JSON.parse: the launching `tool_use` line
    // and a `<tool-use-id>` notification tag also contain this id string,
    // so a substring hit is NOT sufficient on its own — it only narrows
    // which lines are worth the strict parse below.
    const candidates = pending.filter((fs) => line.includes(fs.toolUseId!));
    if (candidates.length === 0) return;

    let parsed: { type?: unknown; message?: { content?: unknown } };
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // one bad line must not abort the scan of the rest
    }
    if (parsed.type !== "user") return;
    const content = parsed.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: unknown; tool_use_id?: unknown };
      if (b.type !== "tool_result") continue;
      for (const fs of candidates) {
        if (b.tool_use_id === fs.toolUseId) settleSubagentById(fs.subagentId, "completed");
      }
    }
  }

  /**
   * Workflow LAUNCH detection: a `user` line whose `toolUseResult` is the
   * `/workflow` tool's immediate `async_launched` stub. Everything the
   * container row needs is in that payload — `taskId` (the row PK, and the id
   * the completion notification will carry), `transcriptDir` (where its agents
   * write), and a human label (`workflowName`, falling back to `summary`).
   */
  function scanLineForWorkflowLaunch(line: string): void {
    // Two cheap substring prefilters before the parse — the overwhelming
    // majority of main-JSONL lines have neither.
    if (!line.includes("local_workflow") || !line.includes("async_launched")) return;
    let parsed: {
      type?: unknown;
      message?: { content?: unknown };
      toolUseResult?: unknown;
    };
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const r = parsed.toolUseResult;
    if (!r || typeof r !== "object") return;
    const res = r as Record<string, unknown>;
    if (res.taskType !== "local_workflow" || res.status !== "async_launched") return;
    const id = typeof res.taskId === "string" ? res.taskId : null;
    const dir = typeof res.transcriptDir === "string" ? res.transcriptDir : null;
    // Without both of these there is nothing to hold or to watch — a layout
    // change that drops either degrades to today's (untracked) behavior
    // rather than creating a half-formed row.
    if (!id || !dir) return;
    const description =
      (typeof res.workflowName === "string" ? res.workflowName : null) ??
      (typeof res.summary === "string" ? res.summary : null);

    // The enclosing `tool_result` block's id — the launching Workflow tool_use.
    let toolUseId: string | null = null;
    const content = parsed.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: unknown; tool_use_id?: unknown };
        if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
          toolUseId = b.tool_use_id;
          break;
        }
      }
    }
    registerWorkflowContainer(id, dir, description, toolUseId);
  }

  /**
   * Workflow COMPLETION detection — the restart-safe backstop. A live session
   * settles the container through claude-tmux's `<task-notification>` handler
   * (`settleSubagentById` by `<task-id>`, which IS the container PK, so that
   * path needed no changes); but after boot reconciliation only this watcher
   * is armed — no tmux tailer — so the same notification has to be recognised
   * here too. Both on-disk shapes (the `queue-operation` enqueue line and the
   * synthetic `user` message) embed the tag verbatim, so one regex covers both.
   *
   * Only ids this watcher knows as its OWN running containers are settled:
   * a `<task-id>` naming a regular background subagent is left to the existing
   * paths, exactly as before this feature.
   *
   * BOTH tags are required in the prefilter, not just `<task-id>`: settling a
   * container is irreversible here (a later launch line for a known id
   * early-returns in `registerWorkflowContainer`), so a line that merely
   * mentions a task id — an assistant message quoting a notification back, a
   * future launch blurb embedding the tag — must not be enough to release the
   * hold. Requiring the enclosing `<task-notification>` marker, which both real
   * on-disk shapes carry verbatim, keeps the match anchored to an actual
   * notification payload.
   *
   * The notification's `<status>` is deliberately ignored — completed, failed,
   * killed and stopped all mean "this workflow is over", and the hold must
   * release in every one of those cases (plan assumption A4).
   */
  function scanLineForWorkflowNotification(line: string): void {
    if (!line.includes("<task-notification>") || !line.includes("<task-id>")) return;
    // `matchAll`, not a single `exec`: one physical line can carry more than
    // one notification (a batched enqueue), and stopping at the first would
    // silently drop the rest — leaving a finished workflow holding the card.
    for (const m of line.matchAll(/<task-id>([^<]+)<\/task-id>/g)) {
      const id = m[1]!.trim();
      const w = workflows.get(id);
      if (!w || w.status !== "running") continue;
      settleSubagentById(id, "completed");
    }
  }

  /**
   * Single pass over the bytes appended to the MAIN session JSONL since the
   * last pass, feeding every signal this watcher derives from it: tool_result
   * correlation settles (above) and — when workflows are tracked — workflow
   * launch + completion detection.
   *
   * One shared `mainOffset` cursor, one read, one split. The early return is
   * deliberately narrow: bailing on `pending.length === 0` (as this did when
   * tool_results were its only signal) would starve workflow detection on
   * exactly the common case — a task with no `toolUseId`-bearing subagent rows
   * at all. So it only short-circuits when there is nothing of EITHER kind to
   * look for.
   *
   * COST NOTE — that widening means a workflow-tracking watcher scans the main
   * transcript on every cycle, where before it usually skipped the read
   * entirely. Two things keep that bounded: the first read after attach starts
   * at most `REPLAY_WINDOW_BYTES` from the end (see the clamp in
   * `attachSubagentWatcher`), and every read after it is incremental — the
   * cursor only ever moves forward, so steady state is one `statSync` plus the
   * handful of bytes the turn actually appended. The old "a task with no
   * background agents never pays for this scan at all" property survives only
   * with `AGETOR_TRACK_WORKFLOWS=0`.
   */
  function scanMainSignals(): void {
    const pending = [...files.values()].filter((fs) => fs.status === "running" && fs.toolUseId);
    if (pending.length === 0 && !WORKFLOWS_ENABLED) return;

    const { text, next } = readAppendedSync(opts.jsonlPath, mainOffset);
    if (!text) return;
    const lines = text.split("\n");
    const tail = lines.pop() ?? ""; // partial trailing line — re-read next tick
    mainOffset = next - Buffer.byteLength(tail, "utf8");

    for (const line of lines) {
      if (!line) continue;
      if (pending.length > 0) scanLineForToolResult(line, pending);
      if (WORKFLOWS_ENABLED) {
        // Launch before completion: on a replay-from-0 both lines are in this
        // same batch, and in file order the launch always precedes its
        // notification — so a workflow that started and finished while agetor
        // was down is registered and then settled within one pass, never left
        // holding the card.
        scanLineForWorkflowLaunch(line);
        scanLineForWorkflowNotification(line);
      }
    }
  }

  function armDirWatcher(): void {
    if (dirWatcher || !existsSync(subagentsDir)) return;
    try {
      dirWatcher = fsWatch(subagentsDir, { persistent: false }, () => {
        if (detached) return;
        // Any dir-watcher event is a life signal for the deep-idle tier,
        // independent of whether it turns out to be a new subagent file.
        lastChangeAt = Date.now();
        try {
          discover();
          discoverWorkflowAgents();
          for (const fs of files.values()) tailFile(fs);
        } catch { /* never crash the watcher */ }
      });
    } catch { /* fs.watch unsupported on this FS — the poll backstop covers it */ }
  }

  /** One discover → tail → done-check pass, with no scheduling side effects. */
  function cycle(now: number): void {
    if (detached) return;
    try {
      armDirWatcher();
      discover();
      discoverWorkflowAgents();
      // Steady-state: only re-stat/re-read `running` files. Completed ones keep
      // no per-tick cost; a resume (rare) re-opens them via the dir watcher's
      // append notification (see `armDirWatcher`, which tails ALL files). The
      // first cycle is the exception — it tails everything to drain a reattach
      // backlog — as is a settled workflow agent whose workflow is still live
      // (`tailPastSettle`), which the non-recursive dir watcher cannot cover.
      const tailAll = firstCycle;
      firstCycle = false;
      for (const fs of files.values()) {
        if (tailAll || fs.status === "running" || tailPastSettle(fs)) tailFile(fs);
      }
      tailJournals();
      scanMainSignals();
      checkDone(now);
    } catch { /* swallow — never crash the timer */ }
  }

  function tick(): void {
    if (detached) return;
    const now = Date.now();
    cycle(now);
    // A live workflow CONTAINER counts as "running" for cadence purposes even
    // when no agent file is open right now: between waves it is the only thing
    // holding the card, and the next wave's files should be picked up on the
    // fast tier, not four seconds late.
    const anyRunning =
      [...files.values()].some((f) => f.status === "running") ||
      [...workflows.values()].some((w) => w.status === "running");
    let delay: number;
    if (anyRunning) {
      delay = FAST_POLL_MS;
    } else if (files.size === 0 && workflows.size === 0 && wfJournals.size === 0
               && now - lastChangeAt >= DEEP_IDLE_AFTER_MS) {
      // Never discovered a subagent OR a workflow and nothing's happened for
      // a while — back off further than the ordinary idle cadence.
      delay = DEEP_IDLE_POLL_MS;
    } else {
      delay = SLOW_POLL_MS;
    }
    timer = setTimeout(tick, delay);
  }

  // Kick off on the next tick (give the spawn path a beat to settle). Tests
  // pass `manual` and drive `pump()` themselves.
  if (!opts.manual) timer = setTimeout(tick, FAST_POLL_MS);

  const handle: SubagentWatcherHandle = {
    detach(): void {
      detached = true;
      if (timer) clearTimeout(timer);
      timer = null;
      dirWatcher?.close();
      dirWatcher = null;
      // Only remove ourselves if we're still the registered handle — a newer
      // attach for this taskId may already have replaced (and detached) us,
      // and deleting unconditionally would drop that newer entry instead.
      if (watchers.get(taskId) === handle) watchers.delete(taskId);
      // NB: intentionally does NOT touch tmux. Tearing down the watcher must
      // never stop the agent — other tasks (and the user's own session) share
      // the tmux server.
    },
    pump(now?: number): void {
      cycle(now ?? Date.now());
    },
    syncSettled(id: string, status: SubagentStatus, endedAt: number): void {
      const fs = files.get(id);
      if (fs) {
        fs.status = status;
        fs.endedAt = endedAt;
        return;
      }
      // Workflow containers live in their own map (they back no file), but
      // need the same in-memory sync so the completion scan doesn't re-settle
      // a container on every subsequent replay of the notification line, and
      // so the cadence check above drops back off the fast tier.
      const w = workflows.get(id);
      if (!w) return;
      w.status = status;
      w.endedAt = endedAt;
    },
  };
  watchers.set(taskId, handle);
  return handle;
}

/**
 * Settle a single subagent from OUTSIDE the watcher's own idle-detection —
 * the entry point for an externally-detected completion: a parent
 * task-notification naming the finishing agent (`setBackgroundTaskSettledHandler`
 * on the claude-tmux side), or boot reconciliation finding its session gone.
 * Runs the exact same bookkeeping a naturally-detected completion runs in
 * `checkDone` (DB write → lifecycle emit → in-memory sync → settle hook), so a
 * held task releases identically regardless of which path noticed the
 * completion first. Idempotent via `subagentsDb.markSettledById` — a
 * duplicate/late signal (e.g. this races the watcher's own `checkDone`) is a
 * harmless no-op that returns `false` without emitting a second lifecycle
 * event or firing the settle hook again.
 */
export function settleSubagentById(id: string, status: "completed" | "orphaned"): boolean {
  return settleSubagent(id, status, 0);
}

/**
 * Cascade: a workflow CONTAINER that just settled cannot still have live
 * agents under it, so every still-`running` `workflow_agent` row written into
 * its transcript dir settles with it. Without this, an agent whose transcript
 * lost its terminal end_turn line AND whose journal receipt never landed
 * (harness killed mid-flight, `<status>killed</status>`) would keep
 * `hasRunning` true and hold the card forever, even though the workflow it
 * belonged to is provably over.
 *
 * Runs for every path that settles a container — the watcher's own completion
 * scan, claude-tmux's live `<task-notification>` handler, boot reconciliation
 * — because they all funnel through `settleSubagent`. Orphaning is the one
 * exception that needs nothing here: `subagents.orphanRunning` already flips
 * every running row for the task in a single kind-agnostic UPDATE.
 *
 * Matching is by `sourcePath` containment (container dir → agent files inside
 * it) via `isInsideDir`, which normalises both sides and requires a separator
 * boundary — see that helper for why.
 *
 * Each cascaded row gets its own DB write, lifecycle emit and watcher sync,
 * but NOT its own settle-hook fire: the caller fires once, after this returns,
 * so the orchestrator's release predicate runs a single time against a
 * fully-settled workflow instead of N+1 times with siblings still running.
 */
function cascadeWorkflowAgents(taskId: string, container: Subagent, depth: number): void {
  if (!container.sourcePath) return;
  try {
    for (const row of subagentsDb.listForTask(taskId)) {
      if (row.status !== "running") continue;
      if (row.parentKind !== "workflow_agent") continue;
      if (!isInsideDir(row.sourcePath, container.sourcePath)) continue;
      settleSubagent(row.id, "completed", depth + 1);
    }
  } catch (e) {
    console.error(`[claude-subagents] workflow cascade failed for container ${container.id}:`, e);
  }
}

/** Shared body of `settleSubagentById`, carrying the cascade recursion depth.
 *  Agent rows are never containers, so the cascade is structurally one level
 *  deep — the depth guard is belt-and-braces against a future kind (or a
 *  corrupt row) that could make the graph cyclic.
 *
 *  `depth` also decides who fires the settle hook: only the OUTERMOST call
 *  (depth 0) does, after any cascade beneath it has finished, so a workflow
 *  releasing N agents costs the orchestrator one release check instead of
 *  N + 1 — and every one of those checks sees the final state rather than a
 *  half-settled workflow. */
function settleSubagent(id: string, status: "completed" | "orphaned", depth: number): boolean {
  let result: { changed: boolean; taskId: string | null };
  try {
    result = subagentsDb.markSettledById(id, status);
  } catch (e) {
    console.error(`[claude-subagents] markSettledById failed for subagent ${id}:`, e);
    return false;
  }
  if (!result.changed || !result.taskId) return false;
  const taskId = result.taskId;
  const now = Date.now();
  const row = subagentsDb.get(id);
  if (row) {
    try {
      emitLifecycleForRow(row);
    } catch (e) {
      console.error(`[claude-subagents] settle lifecycle emit failed for subagent ${id}:`, e);
    }
  }
  watchers.get(taskId)?.syncSettled(id, status, row?.endedAt ?? now);
  // Cascade BEFORE the hook (and the hook only at depth 0), so the
  // orchestrator's release predicate (`subagents.hasRunning`) runs exactly once
  // per settle event, against a workflow that is settled in full.
  if (row?.parentKind === "workflow" && depth < 1) cascadeWorkflowAgents(taskId, row, depth);
  if (depth === 0) fireSettle(taskId);
  return true;
}
