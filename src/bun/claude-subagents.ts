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
 * A `running` row settles via one of FOUR signals, in rough order of how
 * often each fires: (1) the subagent's own file reaching an assistant
 * `stop_reason:"end_turn"` line and then going idle for `DONE_IDLE_MS`
 * (`checkDone` below); (2) a `<task-notification>` for it landing in the MAIN
 * session JSONL — this covers BOTH workflow containers AND ordinary
 * async/background subagent rows (`scanLineForTaskNotification` below; live
 * dispatch of the same notification via claude-tmux's `fireBackgroundTaskSettled`
 * is one-shot and never re-dispatched on reattach, so once the tmux tailer is
 * gone this scan is the only restart-safe path left for an async agent); (3)
 * this module's own scan of the MAIN session JSONL for a `tool_result` block
 * whose `tool_use_id` matches a tracked subagent's `toolUseId`
 * (`scanLineForToolResult` below) — the fallback for a *synchronous*
 * top-level subagent whose own file never gets a terminal end_turn line (a
 * flush loss under concurrent subagents) and which gets no task-notification
 * either; (4) a terminal staleness backstop (`checkStale` below) that settles
 * a `running` row with no `sawEndOfTurn` and no newly-appended bytes for
 * `STALE_SUBAGENT_SETTLE_MS` — the last resort for a row whose transcript
 * lost its end_turn AND whose one-shot receipt (2)/(3) is gone or was never
 * written. All four funnel through `settleSubagentById` so the DB write /
 * lifecycle emit / hold-release bookkeeping only lives in one place.
 *
 * Signal (3) has a stub guard in front of it: an ASYNC agent's `tool_result`
 * is an *immediate* launch acknowledgement (`toolUseResult.status ===
 * "async_launched"`), not a real completion. `scanLineForToolResult` detects
 * that shape and, instead of settling, marks the row `isAsync` and retires
 * its `toolUseId` — a real `tool_result` never arrives for an async agent, so
 * leaving the id live would only risk a future mis-settle. From then on,
 * signals (2) and (4) are the only ones that can close the row.
 *
 * A settled row can never be resurrected by REPLAYED history. Every row
 * records a `replayFloor` — the source file's size at the moment its
 * `FileState` was created: for a rehydrated row (reattach/boot) that's the
 * file's size as of THAT attach; for a row that is BORN settled (a workflow
 * agent discovered under an already-settled container — see W7 below) it's
 * the file's size at the moment of discovery, not 0, precisely because such a
 * row already has "history" (its own never-before-tailed content) that must
 * not be mistaken for a live resume; a genuinely freshly-discovered RUNNING
 * file gets floor 0, since nothing about it has been read yet, let alone
 * settled. `tailFile`'s resume-detection (the "flip back to running" block)
 * only fires for a batch whose *starting* offset is at or beyond that floor;
 * bytes below the floor are replayed history — read again on every
 * attach/reattach from offset 0 — and must never flip a settled row back to
 * running, retire its `toolUseId`, or re-emit a `started` lifecycle, even
 * though those same bytes still flow through the mapper (persist/emit) and
 * still latch `sawEndOfTurn` like any other unseen line. A workflow agent row
 * additionally can never flip back while its CONTAINER is settled, regardless
 * of the floor — the cascade invariant ("nothing under a settled container
 * runs") holds at every tick, not just at discovery.
 *
 * A row settled via an AUTHORITATIVE receipt (a `<task-notification>` or a
 * journal `result` line — `receiptSettled` on the `FileState`) is even harder
 * to resurrect than an ordinary (`inferred`, e.g. `checkDone`/`checkStale`/a
 * real `tool_result`) settle: once receipt-settled, only a genuinely new `user`
 * line (a fresh prompt to a resumed agent) can flip it back to running —
 * trailing `assistant`/`attachment` lines flushed after the receipt cannot,
 * since the harness receipt is authoritative and claude never continues a
 * finished agent without a new user turn. An inferred settle of a fresh
 * in-session row stays flippable by ANY unseen line beyond the floor, by
 * design — `checkStale`'s self-correction (a falsely-stale row resuming)
 * depends on that looseness.
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
 * ── Background shells (`Bash(run_in_background:true)`) ────────────────────
 *
 * A `Bash` tool call with `run_in_background: true` is claude's own shell-
 * backgrounding primitive — structurally unrelated to the Agent/Task/Workflow
 * tools above. The model fires off a long-running command (a build, an e2e
 * suite) and keeps working while it runs. There is no sidecar transcript file
 * and no `subagents/` dir entry at all — just an immediate stub `tool_result`
 * in the MAIN session JSONL naming a `backgroundTaskId`, and a raw
 * stdout+stderr redirect file at a path claude reports in that stub's
 * human-readable text. Without tracking it, `discover()`'s glob never sees
 * it, `subagents.hasRunning` never counts it, and the task releases to
 * `review` while the shell is still running.
 *
 * We model it as one `subagents` row (`parentKind: "bg_session"`,
 * `agentType: "shell"`, id = `backgroundTaskId`), built from a two-line
 * correlation over the MAIN session JSONL — an assistant `tool_use` line
 * remembered in a small pending map (`scanLineForBgShellLaunch`), then
 * matched against the immediate stub `tool_result` that names the
 * `backgroundTaskId` (`scanLineForBgShellStub`), both called from
 * `scanMainSignals` — rather than from any sidecar file, since there isn't
 * one. The row's `sourcePath` is the shell's output file, best-effort
 * regex-parsed from the stub's text (explicitly NOT a stable contract — a
 * parse miss still creates the row, just with no tab content; see
 * `scanLineForBgShellStub`). Live output tailing (`tailBgShells`) reads that
 * file raw and persists/emits it as a `stdout` stream tagged with the row's
 * id — there is no JSONL mapper involved, unlike every other stream in this
 * file.
 *
 * Settle signals, all funnelling through `settleSubagentById` like every
 * other row kind: (1) the completion `<task-notification>` — its `<task-id>`
 * IS the `backgroundTaskId`, so the existing LIVE orchestrator dispatch
 * (`setBackgroundTaskSettledHandler`) and the restart-safe
 * `scanLineForTaskNotification` scan both settle this row with ZERO changes
 * to their own id-matching logic, only a new lookup against `bgShells`;
 * (2) a bounded ceiling (`checkBgShellCeiling`) — `(Bash timeout ?? a
 * default) + a margin` after launch, settling `completed` (inferred) if the
 * notification never arrives, so a lost receipt can never wedge the row
 * `running` forever; a ceiling-settled (never receipt-settled) row flips back
 * to `running` if its output file keeps growing afterwards — the same
 * bounce-rather-than-strand trade-off `checkStale` (W4) makes for file-backed
 * rows, applied here because the ceiling is itself only a guess. There is no
 * end-of-turn/staleness idle-detection for a bg shell (no transcript to go
 * idle by construction, so it is never entered into `files` and `checkStale`
 * never sees it) — the ceiling is its only backstop besides the notification
 * and the generic orphan paths, which cover it automatically (kind-agnostic).
 *
 * Gated behind `AGETOR_TRACK_BG_SHELLS`, nested under `ENABLED` exactly like
 * `WORKFLOWS_ENABLED` — see `BG_SHELLS_ENABLED`.
 *
 * This module is READ-ONLY w.r.t. the agent: it watches files and tails them.
 * It never spawns, signals, or tears down a tmux session — `detach()` only
 * closes fs watchers + the poll timer.
 *
 * The format is internal to claude and the docs warn it can change between
 * versions, so everything here is defensive (missing dir / meta / fields all
 * degrade gracefully) and gated behind AGETOR_TRACK_SUBAGENTS (default on),
 * with the workflow half additionally gated behind AGETOR_TRACK_WORKFLOWS and
 * the bg-shell half behind AGETOR_TRACK_BG_SHELLS (both default on, nested
 * under the former — see `WORKFLOWS_ENABLED` / `BG_SHELLS_ENABLED`).
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

/** Background-shell tracking (`Bash(run_in_background:true)` rows), off only
 *  when explicitly disabled — and implicitly off whenever subagent tracking as
 *  a whole is. Nested exactly like `WORKFLOWS_ENABLED`: a bg shell is a *kind*
 *  of background agent, so disabling the outer switch must disable this too.
 *  A bg shell writes no sidecar file `discover()`'s glob could ever find (it's
 *  a raw stdout/stderr redirect, not a JSONL transcript under `subagents/`),
 *  so `AGETOR_TRACK_BG_SHELLS=0` restores the pre-feature behavior exactly (no
 *  rows → no hold → no tab) — the rollback lever if a future claude CLI change
 *  breaks the on-disk assumptions in the module header's "Background shells"
 *  section. Read once at module load, mirroring `WORKFLOWS_ENABLED` (see that
 *  constant's doc for the cache-busting re-import idiom a test needs to flip
 *  this after the module has already loaded). */
const BG_SHELLS_ENABLED = ENABLED && process.env.AGETOR_TRACK_BG_SHELLS !== "0";

/** Directory (under `<sessionId>/subagents/`) claude writes workflow transcript
 *  dirs into — one `<wf_runId>/` subdir per launched workflow. Created lazily,
 *  so every read of it tolerates ENOENT. */
const WORKFLOWS_SUBDIR = "workflows";

/** Per-agent completion receipts the workflow harness writes, one NDJSON line
 *  per lifecycle transition, inside each workflow transcript dir. */
const JOURNAL_FILE = "journal.jsonl";

/** Fix 9 — `<status>` values `scanLineForTaskNotification` recognises as
 *  terminal ("this agent/workflow is over, settle it"). Any OTHER non-empty
 *  status is treated conservatively as unrecognised (skip the settle, log
 *  once) rather than assumed terminal — see that function's doc. */
const TERMINAL_NOTIFICATION_STATUSES = new Set(["completed", "failed", "killed", "stopped"]);

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
/** W4 — terminal staleness backstop. A `running` file-backed row that has
 *  produced NO new bytes for this long, and never latched `sawEndOfTurn`, is
 *  settled `completed` by `checkStale` regardless of whether any of the other
 *  three settle signals ever fires — the last resort for a transcript that
 *  lost its terminal end_turn line (a known claude flush-loss class) AND
 *  whose one-shot notification/tool_result receipt is gone or was never
 *  written (root-caused as D3 in the plan doc — see the module header).
 *  Deliberately long: this is a backstop for a truly wedged row, not a
 *  substitute for `DONE_IDLE_MS`, so it must comfortably outlast any
 *  legitimate long-running tool call. Overridable via `AGETOR_SUBAGENT_STALE_MS`
 *  for tests and for an operator who hits a false-positive with an unusually
 *  slow agent — `Number(...)` on an unset/invalid value yields `NaN`, and
 *  `NaN || default` falls through to the default exactly like the falsy-string
 *  case, so any non-numeric override is silently ignored rather than crashing
 *  the watcher. Note `0` also cannot disable this backstop — `0 || default`
 *  falls through to the default exactly like `NaN`/unset, so there is no
 *  env-var kill switch for this specific check (use `AGETOR_TRACK_SUBAGENTS=0`
 *  to disable the whole module instead). Read once at module load, mirroring
 *  `WORKFLOWS_ENABLED` above — a test that needs a different threshold must
 *  set the env var and re-import this module under a cache-busting specifier
 *  (`./claude-subagents.ts?stale=<uuid>`), the same idiom `WORKFLOWS_ENABLED`'s
 *  own doc describes; setting `AGETOR_SUBAGENT_STALE_MS` after this module has
 *  already loaded has no effect on the constant below. */
const STALE_SUBAGENT_SETTLE_MS = Number(process.env.AGETOR_SUBAGENT_STALE_MS) || 10 * 60_000;

/** Ceiling default for a tracked background shell (see the module header's
 *  "Background shells" section) whose Bash `input.timeout` was absent (the
 *  model didn't set one) OR whose row was rehydrated — a restart loses the
 *  in-memory-only `BgShellState.timeoutMs` (not persisted; no column for it),
 *  so a reattached row always falls back to this default regardless of what
 *  the original launch specified. Same NaN/0-falls-through posture as
 *  `STALE_SUBAGENT_SETTLE_MS` above: `Number(...)` on an unset/invalid
 *  `AGETOR_BG_SHELL_STALE_MS` yields `NaN`, and `NaN || default` (like
 *  `0 || default`) falls through silently rather than crashing the watcher or
 *  disabling the ceiling — there is no env-var kill switch for the ceiling
 *  itself, only for the whole feature (`AGETOR_TRACK_BG_SHELLS=0`). Read once
 *  at module load, mirroring `STALE_SUBAGENT_SETTLE_MS`. */
const BG_SHELL_DEFAULT_TIMEOUT_MS = Number(process.env.AGETOR_BG_SHELL_STALE_MS) || 30 * 60_000;

/** Grace margin added on top of a bg shell's own ceiling (explicit Bash
 *  `timeout` or `BG_SHELL_DEFAULT_TIMEOUT_MS`) before `checkBgShellCeiling`
 *  infers completion. Gives the CLI's own timeout enforcement — and the
 *  completion notification it triggers — a head start to arrive first, so the
 *  common case never touches the ceiling at all; only a genuinely lost
 *  notification falls through to it. */
const BG_SHELL_TIMEOUT_MARGIN_MS = 2 * 60_000;

/** Cap on `bgShellPending` (the toolUseId -> {description,timeoutMs} map
 *  bridging a bg-shell launch line to its immediate stub, see
 *  `scanLineForBgShellLaunch`). Entries are pruned on consumption by the stub
 *  half, so this only matters if a stub is ever lost (a malformed line, a
 *  future claude CLI shape change) — without a cap, a long-lived session that
 *  keeps launching bg shells whose stubs never arrive would grow this map
 *  unboundedly. The oldest entry is evicted to make room, on the assumption
 *  that a launch still pending behind this many newer ones is never coming. */
const BG_SHELL_PENDING_MAX = 50;

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
   *  `scanLineForToolResult`. Not parsed by earlier builds, so a pre-fix row
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
  /** Source file size at the moment this `FileState` was created — 0 for a
   *  freshly-discovered file (all its bytes are new by definition), else the
   *  size at attach/rehydration time. `tailFile`'s flip-back block (status →
   *  `running`, `toolUseId` retirement, `started` re-emit) only runs for a
   *  batch whose *starting* offset is at/beyond this floor — see the module
   *  header. Never mutated after creation: as `fs.offset` advances past it on
   *  its own, later batches naturally satisfy the floor without this needing
   *  to move. */
  replayFloor: number;
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
  /** The parent `Agent` tool_use id — the correlation key `scanLineForToolResult`
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
  /** Fix 13 — mirrors `apiErrored`'s latch, but for the W4 staleness backstop
   *  (`checkStale`) instead of the api-error path. Set when THIS row was
   *  settled `completed` by `checkStale` (not `checkDone`, not a receipt, not
   *  a real `tool_result`), cleared the next time the row flips back to
   *  `running`. Distinguishes a stale-settled row from an ordinary
   *  end-of-turn-settled one in the "flip back to running" block: a
   *  stale-settled SYNCHRONOUS subagent's `toolUseId` is its only remaining
   *  fallback settle signal (the same reasoning `apiErrored` documents above),
   *  so retiring it on a later resume would strand the row `running` again if
   *  that resume also loses its terminal end_turn line. Defaults `false`;
   *  never rehydrated from the DB (not persisted) — unlike `apiErrored`,
   *  `checkStale`'s settle shares the ordinary `"completed"` status with every
   *  other settle path, so there is no way to reconstruct this latch from the
   *  DB row alone on reattach. */
  staleSettled: boolean;
  /** Fix 4 — set when this row was settled via an AUTHORITATIVE receipt (a
   *  `<task-notification>` in `scanLineForTaskNotification`, or a workflow
   *  journal `result` line in `tailJournals`) rather than an inferred signal
   *  (`checkDone`'s end-of-turn idle, `checkStale`'s staleness backstop, or a
   *  real `tool_result` in `scanLineForToolResult`). Threaded in via
   *  `settleSubagentById`'s `source` param → `settleSubagent` →
   *  `SubagentWatcherHandle.syncSettled`. Once set, `tailFile`'s flip-back
   *  block only resurrects the row for a genuinely new `user` line (a fresh
   *  prompt to a resumed agent) — a trailing `assistant`/`attachment` flush
   *  that lands after the receipt must NOT resurrect it, since the harness
   *  receipt is authoritative and claude never continues a finished agent
   *  without a new user turn (see the module header). Cleared on any flip
   *  back to running. Defaults `false`; never rehydrated from the DB (not
   *  persisted) — mirrors `isAsync`/`staleSettled`'s posture, and closing the
   *  live trailing-flush race only matters for rows this SAME watcher
   *  instance settled, since a rehydrated row is already protected by its
   *  `replayFloor`. */
  receiptSettled: boolean;
  /** Set once `scanLineForToolResult` recognises this row's `tool_result` as
   *  the immediate `async_launched` launch stub rather than a real
   *  completion (see the module header's stub-guard paragraph). Informational
   *  only — nothing branches on it besides the guard that sets it — but kept
   *  on the row (rather than discarded) so a future signal that needs to
   *  distinguish "known-async" from "unknown" has it available without
   *  re-deriving it from the transcript. Defaults `false`; never rehydrated
   *  from the DB (not persisted) — a reattach re-derives it the next time the
   *  stub line replays, which is harmless since the guard is idempotent. */
  isAsync: boolean;
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
   *  otherwise re-fire a duplicate lifecycle/settle signal on the next tick.
   *  `source` (fix 4) — when `"receipt"`, latches `FileState.receiptSettled`
   *  so `tailFile`'s flip-back narrows to user-line-only resurrection for this
   *  row; omitted/`"inferred"` leaves the row's existing flippability alone. */
  syncSettled(id: string, status: SubagentStatus, endedAt: number, source?: "receipt" | "inferred"): void;
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

/**
 * In-memory twin of a tracked background shell row (`Bash(run_in_background:
 * true)` — see the module header's "Background shells" section). Deliberately
 * NOT a `FileState`: the shell's output file is a raw stdout/stderr redirect,
 * not a JSONL transcript, so none of the FileState machinery (uuid dedup,
 * end_turn detection, the `mapJsonlEventToChunks` mapper) applies to it —
 * mirrors `WorkflowState`'s "own map, never `files`" posture for the same
 * reason.
 */
interface BgShellState {
  /** = claude's `backgroundTaskId` — also the row PK, and the id BOTH the
   *  live orchestrator dispatch (`setBackgroundTaskSettledHandler` →
   *  `settleSubagentById`) and the restart-safe `<task-notification>` scan
   *  already key off unchanged. */
  id: string;
  runId: string;
  /** The launching Bash tool_use id. Kept for reference/debugging only —
   *  unlike `FileState.toolUseId`, nothing here correlates a SECOND
   *  `tool_result` against it: the completion notification (or the ceiling)
   *  is this row's settle signal, not a `scanLineForToolResult`-style scan.
   *  `null` only if a stub line ever arrives with no `tool_use_id` block
   *  (defensive — not expected on the verified live shape). */
  toolUseId: string | null;
  description: string | null;
  /** Bash `input.timeout` (ms) from the launch line, when the model set one.
   *  `null` after rehydration (not persisted — no column for it) or when the
   *  model never set one; either way `checkBgShellCeiling` falls back to
   *  `BG_SHELL_DEFAULT_TIMEOUT_MS`. */
  timeoutMs: number | null;
  /** Best-effort regex parse of the stub's human-readable content text.
   *  `null` on a parse miss — the row still exists and still holds the task,
   *  it just has no live tab content (see the module header — row creation
   *  must never depend on this parse succeeding). */
  outputPath: string | null;
  /** Byte cursor into `outputPath`. */
  offset: number;
  status: SubagentStatus;
  startedAt: number;
  endedAt: number | null;
  lastAppendAt: number;
  /** Output-file offset at the moment `checkBgShellCeiling` inferred
   *  completion — the flip-back floor: further growth of the output file past
   *  this point means the shell was actually still alive. `null` when the row
   *  has never been ceiling-settled (still running, or settled some other
   *  way) — there is nothing to compare against, so flip-back is skipped. */
  settleFloor: number | null;
  /** Set once an AUTHORITATIVE completion notification settles this row —
   *  mirrors `FileState.receiptSettled`'s "harder to resurrect" posture. A
   *  receipt-settled shell never flips back on output growth (the harness
   *  already said it's over); only a ceiling-settled (inferred) one does. */
  receiptSettled: boolean;
}

function toBgShellShape(b: BgShellState, taskId: string): Subagent {
  return {
    id: b.id,
    taskId,
    runId: b.runId,
    parentKind: "bg_session",
    agentType: "shell",
    description: b.description,
    spawnDepth: 1,
    sourcePath: b.outputPath ?? "",
    toolUseId: b.toolUseId,
    status: b.status,
    startedAt: b.startedAt,
    endedAt: b.endedAt,
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
  // Background shells (`Bash(run_in_background:true)`) this watcher knows
  // about, keyed by `backgroundTaskId` (= row PK). Like `workflows`, NEVER
  // merged into `files` — a bg shell's output file is raw text, not a JSONL
  // transcript, so none of `FileState`'s machinery applies (see
  // `BgShellState`, and the module header's "Background shells" section).
  const bgShells = new Map<string, BgShellState>();
  // Pending bg-shell launches, `toolUseId -> {description, timeoutMs}` —
  // bridges the assistant launch line to the immediate stub that follows it
  // (see `scanLineForBgShellLaunch`/`scanLineForBgShellStub`). Consumed
  // (deleted) by the stub half; also capped at `BG_SHELL_PENDING_MAX` so a
  // session whose stub is ever lost can't grow this unboundedly.
  const bgShellPending = new Map<string, { description: string | null; timeoutMs: number | null }>();
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
  // Captured once, not per row: this is the staleness clock's start time
  // (W4) — every rehydrated row is "last heard from" as of THIS attach, not
  // the epoch (`lastAppendAt: 0` would otherwise make every reattached row
  // instantly eligible for `checkStale` on the very next pass).
  const attachedAt = Date.now();
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
      if (row.parentKind === "bg_session") {
        // Route to `bgShells`, never `files` — a bg shell's output file is
        // raw text, not a JSONL transcript, so it must never be handed to
        // `tailFile`'s mapper-driven machinery (see `BgShellState`).
        if (BG_SHELLS_ENABLED) {
          // Offset starts at the file's CURRENT size (not 0, unlike every
          // `FileState` rehydration above): persisted `run_events` already
          // cover this row's history via the normal SSE-replay path, and a
          // raw-text tail has no per-line dedup key the way a JSONL tail
          // does — re-tailing from 0 would re-persist (and re-emit, since
          // `runs.appendEvent`'s dedup only applies to a provided
          // `line_uuid`, and a replayed batch would get a DIFFERENT
          // `bgshell:<id>:<offset>` key than its first pass) the entire
          // output as a duplicate stream. `0` on a stat failure (file
          // genuinely gone, or a transient FS error) degrades to "nothing
          // more to tail" rather than crashing rehydration.
          let offset = 0;
          if (row.sourcePath) {
            try { offset = statSync(row.sourcePath).size; } catch { /* offset stays 0 */ }
          }
          bgShells.set(row.id, {
            id: row.id,
            runId: row.runId ?? resolveRunId(taskId) ?? row.id,
            toolUseId: row.toolUseId ?? null,
            description: row.description,
            // Not persisted — a restart loses the specific Bash `timeout`;
            // `checkBgShellCeiling` falls back to `BG_SHELL_DEFAULT_TIMEOUT_MS`.
            timeoutMs: null,
            outputPath: row.sourcePath || null,
            offset,
            status: row.status,
            startedAt: row.startedAt,
            endedAt: row.endedAt,
            lastAppendAt: attachedAt,
            // Never rehydrated (not persisted), mirroring `receiptSettled`
            // below — a restart re-derives whichever matters the next time
            // this row's settle-relevant signal replays.
            settleFloor: null,
            receiptSettled: false,
          });
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
      // Replay floor (W1): the source file's size RIGHT NOW, before this
      // watcher ever reads a byte of it. Every attach re-tails from offset 0
      // (see `offset: 0` below), so without a floor the very first batch —
      // pure replay of history the row already settled from — would look
      // like "new bytes" to the flip-back block and resurrect a completed
      // row on every restart.
      //
      // Fix 7 — the floor's error fallback must distinguish "no file" from
      // "file exists but couldn't be stat'd": a file that's genuinely gone
      // (deleted transcript, race with cleanup) has no history to distrust,
      // so floor 0 (== "treat as freshly-discovered") is the safe default.
      // But a file that EXISTS and merely failed to `statSync` (permissions,
      // a transient FS error, an exotic mount) is the opposite case — there
      // IS history on disk, we just can't measure it right now — and 0 would
      // wrongly tell the flip-back block "everything in this file is new",
      // resurrecting a settled row (or worse, mis-treating its full replayed
      // content as a genuine resume) the moment it becomes readable again.
      // `Number.MAX_SAFE_INTEGER` makes every batch from this row read as
      // replay until a later `statSync` succeeds and the real size is used.
      let replayFloor = 0;
      if (existsSync(row.sourcePath)) {
        try {
          replayFloor = statSync(row.sourcePath).size;
        } catch {
          replayFloor = Number.MAX_SAFE_INTEGER;
        }
      }
      files.set(row.id, {
        subagentId: row.id,
        parentKind: row.parentKind,
        runId: row.runId ?? resolveRunId(taskId) ?? row.id,
        offset: 0,
        replayFloor,
        seen: runs.seenLineUuidsForSubagent(row.id),
        sawEndOfTurn: false,
        lastAppendAt: attachedAt,
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
        // `staleSettled`/`receiptSettled` are never rehydrated (see their
        // doc on `FileState`) — a restart re-derives whichever of them
        // matters the next time this row's settle-relevant signal replays.
        staleSettled: false,
        receiptSettled: false,
        isAsync: false,
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
        // A freshly-discovered file is all-new by definition — nothing about
        // it has been read yet, let alone settled, so there is no history to
        // distrust. See `FileState.replayFloor` / the module header.
        replayFloor: 0,
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
        staleSettled: false,
        receiptSettled: false,
        isAsync: false,
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
   *  discovery never waits on it.
   *
   *  Fix 10 — both sides are `path.resolve`d before comparison, mirroring
   *  `isInsideDir`'s posture: a container's `dir` comes from claude's own
   *  `transcriptDir` string while an agent's dir is built here with
   *  `path.join`, and those can disagree on a symlinked or non-normalised
   *  root (`/tmp` vs `/private/tmp` on macOS) even though they name the same
   *  directory — a naive `===` would then miss the match. */
  function workflowForDir(dir: string): WorkflowState | null {
    const resolved = path.resolve(dir);
    for (const w of workflows.values()) if (path.resolve(w.dir) === resolved) return w;
    return null;
  }

  /** The CONTAINER's current status for the workflow whose transcript dir is
   *  `dir` — preferring the in-memory `workflows` entry, falling back to the
   *  DB row when this watcher never saw (or has since forgotten) that
   *  container. The fallback matters because agent-file discovery and
   *  container-launch-line discovery are two independent scans of two
   *  different streams (a directory listing vs the main JSONL) — an agent
   *  file can become readdir-visible before this watcher's own main-JSONL
   *  scan has reached the launch line that would have populated `workflows`.
   *  `null` when neither source knows the container at all (still launching,
   *  or a layout this watcher has no visibility into). Used by the W7
   *  settle-on-discovery check in `discoverWorkflowAgents` and by `tailFile`'s
   *  flip-back guard (fix 1). Same path-normalization posture as
   *  `workflowForDir` (fix 10) — `path.resolve` both sides of the DB fallback
   *  comparison too. */
  function containerStatusForDir(dir: string): SubagentStatus | null {
    const w = workflowForDir(dir);
    if (w) return w.status;
    try {
      const resolved = path.resolve(dir);
      const row = subagentsDb
        .listForTask(taskId)
        .find((r) => r.parentKind === "workflow" && path.resolve(r.sourcePath) === resolved);
      return row?.status ?? null;
    } catch {
      return null;
    }
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
      // Fix 10 — resolve the container's status ONCE per dir, before the
      // per-file loop, not once per discovered file. A workflow can spawn
      // many agents into the same dir in one pass; the container's status
      // cannot change mid-loop (nothing in this loop settles anything), so
      // recomputing it per file was pure waste.
      const containerStatus = containerStatusForDir(dir);
      const bornSettled = containerStatus !== null && containerStatus !== "running";
      // Fix 11 — rewind this dir's journal cursor AT MOST ONCE per pass, only
      // if the pass actually discovered ≥1 new agent file here — not once per
      // file (see the W6 comment below for why a rewind is needed at all).
      let discoveredAny = false;
      for (const name of names) {
        const m = /^agent-(.+)\.jsonl$/.exec(name);
        if (!m) continue;
        const id = m[1]!;
        if (files.has(id)) continue;
        const runId = resolveRunId(taskId);
        if (!runId) continue; // same defensive skip as `discover()`
        const meta = readMeta(dir, id);
        const now = Date.now();
        const filePath = path.join(dir, name);
        // W7 — settle-on-discovery under an already-settled container.
        // `cascadeWorkflowAgents` only sweeps rows that exist in the DB at the
        // moment the container itself settles; an agent file that only
        // becomes readdir-visible AFTER that (a straggling flush, a slow
        // `readdir` race) is never touched by the cascade. Inserting such a
        // row `running` would resurrect a hold the container's settle already
        // released — so a container found settled at discovery time makes
        // this row `completed` from birth instead, never `running`.
        //
        // Fix 1 — a born-settled row's `replayFloor` must be the file's size
        // AT DISCOVERY, not 0. This row already has content on disk (it was
        // written before we ever looked at it) that fix 2 below will drain
        // exactly once; without a floor pinned here, that very drain would
        // look like "new bytes" to `tailFile`'s flip-back block on the SAME
        // cycle and immediately flip the row back to `running` — resurrecting
        // it before it ever renders as settled. Guarded: a file that vanished
        // between the `readdir` above and this `statSync` reads as floor 0
        // (equivalent to "freshly discovered"), not a crash of the pass.
        let replayFloor = 0;
        if (bornSettled) {
          try { replayFloor = statSync(filePath).size; } catch { /* floor stays 0 */ }
        }
        const fs: FileState = {
          subagentId: id,
          parentKind: "workflow_agent",
          runId,
          offset: 0,
          replayFloor,
          seen: new Set(),
          sawEndOfTurn: false,
          lastAppendAt: now,
          status: bornSettled ? "completed" : "running",
          sourcePath: filePath,
          agentType: meta.agentType,
          // A workflow agent's meta sidecar carries no `description`, so fall
          // back to the workflow's own name (or, before/without its launch
          // line, the transcript dir) — an unlabelled tab is worse than a
          // coarse one.
          description: meta.description ?? workflowForDir(dir)?.description ?? dirName,
          spawnDepth: meta.spawnDepth,
          startedAt: now,
          endedAt: bornSettled ? now : null,
          // No `toolUseId` in a workflow-agent sidecar: these agents are
          // spawned by the workflow harness, not by a parent `Agent` tool_use,
          // so there is no tool_result to correlate against. Leaving it null
          // also keeps them out of `scanMainSignals`'s pending set.
          toolUseId: null,
          apiErrored: false,
          staleSettled: false,
          receiptSettled: false,
          isAsync: false,
          lastPermissionMode: null,
        };
        files.set(id, fs);
        lastChangeAt = Date.now();
        discoveredAny = true;
        subagentsDb.insertIfAbsent(toSubagentShape(fs, taskId));
        if (bornSettled) {
          emitLifecycle(fs, "finished");
        } else {
          emitLifecycle(fs, "started");
          // Only a genuinely-running discovery should be able to pull a
          // parked task back — a row born settled has no hold implications
          // (W7's whole point).
          fireParkedDiscovery(taskId);
        }
      }
      // W6 — journal cursor rewind. A `result` receipt naming an agent
      // discovered in THIS pass may already have been consumed by
      // `tailJournals` before that row existed — the same readdir-visibility
      // race `discover()`'s `mainOffset = 0` rewind covers for the main-JSONL
      // scan, mirrored here for the per-workflow journal cursor.
      // `settleSubagentById` is idempotent, so replaying an already-applied
      // receipt costs nothing — fix 11 only trims the rewind to once per
      // pass-with-a-discovery instead of once per file.
      if (discoveredAny) wfJournals.set(dir, 0);
    }
  }

  /**
   * Tail each known workflow dir's `journal.jsonl` — the harness's own
   * per-agent completion receipts (`{"type":"result","key","agentId","result"}`).
   * This is the flush-loss backstop: a workflow runs many agents concurrently
   * and an agent's own transcript can lose its terminal `end_turn` line under
   * that load, which would strand its row `running` forever (the same failure
   * class `scanLineForToolResult` exists to cover for synchronous subagents,
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
            // Fix 4 — this is the harness's own authoritative completion
            // receipt, so it settles with `source: "receipt"`.
            settleSubagentById(o.agentId, "completed", "receipt");
          } catch { /* one malformed receipt must not abort the rest */ }
        }
      } catch (e) {
        console.error(`[claude-subagents] journal tail failed for ${dir}:`, e);
      }
    }
  }

  /**
   * Live output tailing for `running` background shells — the counterpart to
   * `tailFile` for a raw stdout/stderr redirect instead of a JSONL transcript
   * (see the module header's "Background shells" section). No mapper, no
   * line-level parsing, no per-line dedup: `readAppendedSync` hands back
   * whatever new bytes exist and they're persisted/emitted verbatim as ONE
   * `stdout` event per batch — mirrors `tailFile`'s persist/emit idiom
   * exactly (`runs.appendEvent` + the matching `emitFn` call, both taskId-
   * tagged).
   *
   * `line_uuid = "bgshell:<id>:<batchStartOffset>"` — the batch's starting
   * offset is a stable, monotonically-increasing key per shell, so a
   * duplicate emit of the same batch (should this ever run twice for the
   * same bytes) is deduped by the `(run_id, line_uuid)` partial unique index
   * exactly like every other persisted stream.
   *
   * Skips a shell with no known `outputPath` (the best-effort parse in
   * `scanLineForBgShellStub` missed) — its row still holds the task, it just
   * has no live tab content. `readAppendedSync` itself never throws (ENOENT/
   * stat errors degrade to "nothing appended"), so this needs no try/catch of
   * its own.
   */
  function tailBgShells(): void {
    for (const b of bgShells.values()) {
      if (b.status !== "running" || !b.outputPath) continue;
      const batchStart = b.offset;
      const { text, next } = readAppendedSync(b.outputPath, b.offset);
      if (!text) continue;
      b.offset = next;
      b.lastAppendAt = Date.now();
      runs.appendEvent(b.runId, "stdout", text, `bgshell:${b.id}:${batchStart}`, b.id);
      emitFn?.({ runId: b.runId, taskId, stream: "stdout", data: text, ts: Date.now(), subagentId: b.id });
    }
  }

  /** Tail one subagent file: dispatch newly-appended lines through the shared
   *  mapper, persisting + emitting each chunk tagged with the subagent id. */
  function tailFile(fs: FileState): void {
    // Captured BEFORE the read advances `fs.offset` — this is the replay-floor
    // check's input (W1). A batch that STARTS below `fs.replayFloor` is, in
    // full or in part, replayed history (every attach re-tails from offset 0),
    // so the flip-back block below must not treat it as evidence of a genuine
    // resume. A batch that straddles the floor (starts below, ends at/beyond
    // it) is conservatively treated as replay for THIS batch — the very next
    // batch (if the agent is actually still writing) starts at/beyond the
    // floor and flips then, at most one poll interval later. That's a
    // deliberate trade: a false "still replay" for one extra tick is cheap: a
    // false "genuine resume" would resurrect a settled row and retire its
    // `toolUseId`, so no floor check is what we're guarding against.
    const batchStart = fs.offset;
    const { text, next } = readAppendedSync(fs.sourcePath, fs.offset);
    if (!text) return;
    const lines = text.split("\n");
    const tail = lines.pop() ?? ""; // partial trailing line — re-read next tick
    fs.offset = next - Buffer.byteLength(tail, "utf8");
    // Fix 1 (general guard) — a workflow agent whose CONTAINER is settled must
    // never flip back to `running`, independent of `replayFloor`. The floor
    // covers the discovery-time case (a row born under an already-settled
    // container, fix 1's other half in `discoverWorkflowAgents`); this covers
    // every OTHER tick — e.g. the container settles WHILE this row's own file
    // is still trickling a trailing flush, or settles between two batches of
    // an otherwise-legitimate-looking resume. Computed once per call (not per
    // line): `fs.parentKind`/`fs.sourcePath` never change across this batch,
    // and the container's status cannot change mid-batch either (nothing in
    // this function settles a container). Cheap — a plain map lookup, falling
    // back to one DB scan only when this watcher never saw the launch line.
    const containerSettled =
      fs.parentKind === "workflow_agent" &&
      (() => {
        const status = containerStatusForDir(path.dirname(fs.sourcePath));
        return status !== null && status !== "running";
      })();
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
      // Fix 4 — this line's `type`, peeked for the receipt-settled flip-back
      // guard below: only a genuine new `user` line (a fresh prompt to a
      // resumed agent) may resurrect a `receiptSettled` row.
      let lineType: string | undefined;
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
        lineType = typeof o.type === "string" ? o.type : undefined;
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
        // Also mirror `user` lines' `permissionMode`, not just the dedicated
        // `system`/`permission-mode` marker lines: `mapParsedEventToChunks`'s
        // `case "user"` (claude-tmux.ts) emits the SAME `permission-mode: X`
        // status chunk off a `user` line's `permissionMode` as a fallback
        // signal, gated on `lastPermissionMode`. A subagent JSONL with no
        // marker lines at all (the common case) would otherwise never advance
        // `fs.lastPermissionMode`, so every `user`/`tool_result` line's
        // `permissionMode` compares against a stale (often `null`) value and
        // re-emits an unchanged-mode chip on every single line. Mirroring
        // `user` lines here keeps this dedup in lockstep with the mapper's.
        if ((o.type === "system" || o.type === "permission-mode" || o.type === "user")
          && typeof o.permissionMode === "string") {
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
      //
      // Gated on `batchStart >= fs.replayFloor` (W1): a batch that STARTS
      // below the floor is replayed history — every attach re-tails this
      // file from offset 0 — not evidence the agent is genuinely alive again.
      // Without this gate, EVERY attach flips EVERY settled row back to
      // running on its very first batch, because a transcript's
      // mapper-silent lines (types the mapper doesn't persist, e.g.
      // `attachment`) are never recorded in `fs.seen`/`run_events.line_uuid`
      // and so always look "unseen" on replay — measured 10-17 such lines per
      // real transcript, present in both stuck AND normally-completed
      // sessions alike. This was the actual mechanism behind rows getting
      // stuck `running` forever (root-caused in the plan doc as D2). A batch
      // below the floor still falls through to the mapper call below
      // unchanged — it still persists/emits its chunks and still latches
      // `sawEndOfTurn` — only the status flip / `toolUseId` retirement /
      // `started` re-emit are skipped. A batch that straddles the floor
      // (starts below it, ends beyond it) is conservatively treated as replay
      // for THIS batch; if the agent really is still writing, its very next
      // batch starts at/beyond the floor and flips then — at most one poll
      // interval later, versus a settled row resurrected forever.
      //
      // Fix 4 — a `receiptSettled` row narrows this further: an authoritative
      // receipt (a `<task-notification>` or journal `result` line) already
      // said the agent is over, so only a genuinely NEW `user` line (a fresh
      // prompt to a resumed agent) may resurrect it. A trailing
      // `assistant`/`attachment` flush landing just after the receipt — the
      // live race this fix closes — must not resurrect the row: claude never
      // continues a finished agent without a new user turn, so the harness
      // receipt outranks a stray beyond-floor line that isn't one.
      const blockedByReceiptSettle = fs.receiptSettled && lineType !== "user";
      if (
        fs.status !== "running" &&
        batchStart >= fs.replayFloor &&
        !containerSettled &&
        !blockedByReceiptSettle
      ) {
        fs.status = "running";
        fs.endedAt = null;
        fs.sawEndOfTurn = false;
        // Retire the tool_result correlation key: the parent's receipt for
        // the ORIGINAL Agent tool_use predates this resume, so from here on
        // it can only mis-settle the agent. Thanks to the replay-floor gate
        // above, this branch by construction only ever runs for a batch
        // AT/BEYOND the floor — bytes this watcher has never read before, a
        // genuine resume — so (unlike before W1) there is no "transient
        // post-restart re-settle via replay" case left to worry about here;
        // the floor already ruled that out before this line runs.
        //
        // EXCEPT when the row being flipped was settled `failed` via an
        // API error (`fs.apiErrored`) OR `completed` via the staleness
        // backstop (`fs.staleSettled`, fix 13): for a SYNCHRONOUS subagent,
        // `toolUseId` is the ONLY remaining fallback settle signal
        // (`scanLineForToolResult`) — the agent's own transcript may never
        // produce another terminal end_turn (that is the exact hang class
        // this feature exists to fix) and there is no task-notification for
        // a synchronous agent either. Retiring the id here would stop that
        // fallback from ever firing again, stranding the row `running`
        // forever after this trailing append — reintroducing the bug.
        // Keeping it means trailing garbage appended after the abort can
        // still be reconciled via the tool_result scan. The asymmetry with
        // the `completed`-via-`checkDone`-row case above is deliberate: an
        // ordinarily-completed row's stale tool_result genuinely predates the
        // resume and retiring it there only prevents a MIS-settle, never a
        // stuck one — so that case still retires unconditionally.
        if (!fs.apiErrored && !fs.staleSettled) fs.toolUseId = null;
        fs.apiErrored = false;
        fs.staleSettled = false;
        fs.receiptSettled = false;
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
      //
      // Fix 12 — additionally gated on `batchStart >= fs.replayFloor`, the
      // same floor `tailFile`'s flip-back block uses: a genuine NEW api-error
      // always arrives in a batch beyond the floor, so this can never exclude
      // a real live error. It closes the symmetric edge the dedup comment
      // above doesn't cover — a mapper-silent/uuid-less error-shaped line (no
      // durable dedup key) replayed below the floor on a born-settled or
      // rehydrated row must not be mistaken for a fresh failure.
      if (apiErrorInfo !== null && batchStart >= fs.replayFloor) {
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
   * W4 — terminal staleness backstop. Flips a `running` row `completed` when
   * it has NEVER seen its transcript's terminal end_turn line (the
   * `checkDone` path never applies to it) AND has produced no new bytes for
   * `STALE_SUBAGENT_SETTLE_MS`. This is the settle-of-last-resort for a row
   * whose transcript lost its end_turn to the known claude flush-loss class
   * AND whose one-shot receipt (an async task-notification, or a synchronous
   * tool_result) is gone from disk or was never written at all — with no
   * bytes left to arrive and no receipt left to consume, nothing else in this
   * module can ever close the row otherwise, and it would hold its task's
   * card in `running` forever.
   *
   * Deliberately restricted to FILE-BACKED rows (`files`, not `workflows`):
   * a workflow CONTAINER is directory-backed — it has no transcript of its
   * own to go quiet, and its lifetime legitimately spans long idle gaps
   * BETWEEN agent waves — so it is settled only by its completion
   * notification or the generic orphan paths, never by staleness.
   *
   * Same DB-write-before-`fireSettle` ordering as `checkDone`, for the same
   * reason: the orchestrator's release predicate reads `subagentsDb.hasRunning`
   * and must see the write.
   *
   * If the agent WAS actually still alive and later appends again, W1's
   * beyond-floor flip-back in `tailFile` returns the row to `running` — a
   * brief card bounce (running → review → running) rather than the
   * pre-fix failure mode of a card stuck `running` forever. A conservative
   * default (10 minutes) keeps that bounce rare; `AGETOR_SUBAGENT_STALE_MS`
   * exists for the operator/test who needs a different threshold.
   */
  function checkStale(now: number): void {
    for (const fs of files.values()) {
      if (
        fs.status === "running" &&
        !fs.sawEndOfTurn &&
        now - fs.lastAppendAt > STALE_SUBAGENT_SETTLE_MS
      ) {
        fs.status = "completed";
        fs.endedAt = now;
        // Fix 13 — latch, mirroring `apiErrored`: lets `tailFile`'s flip-back
        // keep this row's `toolUseId` alive on a later resume, since a
        // stale-settled synchronous subagent has no other fallback settle
        // signal left (see `FileState.staleSettled`'s doc).
        fs.staleSettled = true;
        subagentsDb.setStatus(fs.subagentId, "completed", now);
        emitLifecycle(fs, "finished");
        fireSettle(taskId);
      }
    }
  }

  /**
   * Bounded ceiling for a tracked background shell (see the module header's
   * "Background shells" section) — the "the hold is bounded" half of the
   * feature. A `running` bg shell has no transcript to go idle by
   * construction (it is never entered into `files`, so `checkStale` never
   * sees it), so without this a lost completion notification would hold its
   * task in `running` forever.
   *
   * Forward direction: once `now - startedAt` exceeds the shell's own Bash
   * `timeout` (or `BG_SHELL_DEFAULT_TIMEOUT_MS` when absent/rehydrated) plus
   * `BG_SHELL_TIMEOUT_MARGIN_MS`, settle `completed` (inferred, NOT receipt —
   * see `BgShellState.receiptSettled`) and record `settleFloor` (the output
   * offset at settle time) for the flip-back half below.
   *
   * Flip-back direction: mirrors `checkStale`'s "bounce rather than strand"
   * trade-off (W4, see the module header) — a ceiling settle is only a
   * GUESS, so evidence it was wrong (the output file growing past
   * `settleFloor`, meaning the shell was actually still alive) resumes the
   * hold. Skipped entirely for a `receiptSettled` row: the harness already
   * said that one is over, and a trailing flush to its output file after the
   * fact must not resurrect it — same posture as `tailFile`'s
   * `blockedByReceiptSettle` guard for file-backed rows.
   */
  function checkBgShellCeiling(now: number): void {
    for (const b of bgShells.values()) {
      if (b.status === "running") {
        const ceiling = (b.timeoutMs ?? BG_SHELL_DEFAULT_TIMEOUT_MS) + BG_SHELL_TIMEOUT_MARGIN_MS;
        if (now - b.startedAt > ceiling) {
          b.status = "completed";
          b.endedAt = now;
          b.settleFloor = b.offset;
          subagentsDb.setStatus(b.id, "completed", now);
          emitLifecycleForRow(toBgShellShape(b, taskId), "finished");
          fireSettle(taskId);
        }
        continue;
      }
      // Flip-back candidates only: a row with no `settleFloor` was either
      // never ceiling-settled or was settled some other way (receipt,
      // orphan) that never set one — nothing to compare against either way.
      if (b.receiptSettled || b.settleFloor === null || !b.outputPath) continue;
      let size: number;
      try {
        size = statSync(b.outputPath).size;
      } catch {
        continue; // file gone/unreadable this tick — try again next cycle
      }
      if (size > b.settleFloor) {
        b.status = "running";
        b.endedAt = null;
        b.settleFloor = null;
        subagentsDb.setStatus(b.id, "running", null);
        emitLifecycleForRow(toBgShellShape(b, taskId), "started");
        fireParkedDiscovery(taskId);
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
   *
   * W2 — async-stub guard. When `Agent(run_in_background: true)` launches a
   * subagent, claude writes an IMMEDIATE `tool_result` for the launching
   * `tool_use` whose `toolUseResult` is `{ isAsync:true,
   * status:"async_launched", agentId, … }` — not a completion, just an
   * acknowledgement that the background agent started. Ground truth verified
   * live: `{"type":"user","message":{...content:[{type:"tool_result",
   * tool_use_id,...}]},"toolUseResult":{"isAsync":true,
   * "status":"async_launched","agentId":"...",...}}`. This function has no
   * stub guard prior to W2 — every `running` row whose `toolUseId` happens to
   * match is settled `completed` on this stub alone, while the agent is still
   * working (the false-settle root-caused as D1 in the plan doc). The guard
   * below keys on the STRUCTURAL `toolUseResult.status === "async_launched"`
   * marker, never the human-readable text (which is not a stable contract) —
   * and on a match, does NOT settle: it marks the row `isAsync` and retires
   * its `toolUseId` instead, since a REAL `tool_result` will never arrive for
   * an async agent (retiring prevents the stub — or a resend of it on replay
   * — from ever being mis-read as a completion again). From there the row's
   * only remaining settle paths are the task-notification backstop (W3) and
   * the staleness backstop (W4).
   *
   * Fix 5 — the stub guard is now CORRELATED per candidate, not just derived
   * once for the whole line: a `toolUseResult.status === "async_launched"`
   * line is only treated as the launch stub for a given candidate `fs` when
   * `toolUseResult.agentId` is either absent OR equals `fs.subagentId` — the
   * stub's `agentId` field IS the subagent row's own id (verified live), so
   * this is the correlation key, not just the shape. A candidate that doesn't
   * match (a coincidental substring hit for a DIFFERENT agent's stub sharing
   * this batch) falls through to normal settle handling instead of being
   * wrongly marked async.
   */
  function scanLineForToolResult(line: string, pending: FileState[]): void {
    // Cheap prefilter before any JSON.parse: the launching `tool_use` line
    // and a `<tool-use-id>` notification tag also contain this id string,
    // so a substring hit is NOT sufficient on its own — it only narrows
    // which lines are worth the strict parse below.
    //
    // Fix 6 — `fs.toolUseId != null` is required BEFORE the substring check.
    // `pending` is built once per `scanMainSignals` call and shared across
    // every line in the batch; a candidate's `toolUseId` can be retired to
    // `null` mid-scan (the async-stub branch below does exactly that), and
    // without this guard `line.includes(fs.toolUseId!)` would coerce `null`
    // to the string `"null"` and match every later line that happens to
    // contain that four-character substring — a false-positive candidate on
    // every subsequent line of the batch.
    const candidates = pending.filter((fs) => fs.toolUseId != null && line.includes(fs.toolUseId));
    if (candidates.length === 0) return;

    let parsed: { type?: unknown; message?: { content?: unknown }; toolUseResult?: unknown };
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // one bad line must not abort the scan of the rest
    }
    if (parsed.type !== "user") return;
    const content = parsed.message?.content;
    if (!Array.isArray(content)) return;
    const tr = parsed.toolUseResult;
    const trObj = tr && typeof tr === "object" ? (tr as Record<string, unknown>) : null;
    const stubStatus = trObj?.status === "async_launched";
    const stubAgentId = typeof trObj?.agentId === "string" ? trObj.agentId : undefined;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: unknown; tool_use_id?: unknown };
      if (b.type !== "tool_result") continue;
      for (const fs of candidates) {
        if (b.tool_use_id !== fs.toolUseId) continue;
        // Fix 5 — correlate the stub to THIS candidate specifically.
        const isStubForThisCandidate = stubStatus && (stubAgentId === undefined || stubAgentId === fs.subagentId);
        if (isStubForThisCandidate) {
          fs.isAsync = true;
          fs.toolUseId = null;
        } else {
          settleSubagentById(fs.subagentId, "completed");
        }
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
   * COMPLETION notification detection — the restart-safe backstop, generalized
   * (W3) beyond just workflow containers. A live session settles a container
   * through claude-tmux's `<task-notification>` handler (`settleSubagentById`
   * by `<task-id>`, which IS the container PK, so that path needed no
   * changes); but after boot reconciliation only this watcher is armed — no
   * tmux tailer — so the same notification has to be recognised here too.
   * Both on-disk shapes (the `queue-operation` enqueue line and the synthetic
   * `user` message) embed the tag verbatim, so one regex covers both.
   *
   * Superseded rationale: earlier, a `<task-id>` naming a regular (non-
   * workflow) background subagent was deliberately left to "the existing
   * paths" — the reasoning being that claude-tmux's own live dispatch
   * (`fireBackgroundTaskSettled`) would catch it. That reasoning doesn't
   * survive a restart: claude-tmux's dispatch is one-shot and dedup'd, never
   * re-issued on reattach, so once the tmux tailer that originally would have
   * seen it is gone, NOTHING settles that row's live notification ever again
   * — this scan is the only restart-safe path left for an async agent. It is
   * now safe to widen the match to `files` (ordinary tracked rows) as well as
   * `workflows` (containers): with W1's replay floor in place, a settle this
   * scan performs can no longer be undone by a later replay resurrecting the
   * row, which is what made the old narrower scope a deliberate, necessary
   * caution rather than an oversight.
   *
   * Only ids this watcher already tracks as `running` — container OR regular
   * row — are settled; an unrelated id is left alone.
   *
   * BOTH tags are required in the prefilter, not just `<task-id>`: settling a
   * row here is otherwise irreversible in the same tick (a later launch line
   * for a known container id early-returns in `registerWorkflowContainer`),
   * so a line that merely mentions a task id — an assistant message quoting a
   * notification back, a future launch blurb embedding the tag — must not be
   * enough to release the hold. Requiring the enclosing `<task-notification>`
   * marker, which both real on-disk shapes carry verbatim, keeps the match
   * anchored to an actual notification payload.
   *
   * Fix 9 — the notification's `<status>` is now parsed when present:
   * `completed`, `failed`, `killed` and `stopped` all mean "this agent/
   * workflow is over" and settle as before (plan assumption A4, extended to
   * regular rows by the same logic); an UNKNOWN status value is treated
   * conservatively — skip the settle and log once, rather than guess, since a
   * future claude release could introduce a non-terminal status this code
   * doesn't know about yet; an ABSENT `<status>` tag still settles
   * unconditionally, preserving back-compat with on-disk shapes (and older
   * fixture lines) that never carried one.
   *
   * Settles performed here pass `source: "receipt"` (fix 4) to
   * `settleSubagentById` — this scan only ever fires on an actual
   * `<task-notification>` payload, the harness's own authoritative
   * completion receipt, so a row it settles should resist resurrection by a
   * trailing non-`user` line the way an inferred (`checkDone`/`checkStale`/
   * real-`tool_result`) settle does not.
   */
  function scanLineForTaskNotification(line: string): void {
    if (!line.includes("<task-notification>") || !line.includes("<task-id>")) return;
    // Match each whole `<task-notification>…</task-notification>` block, not
    // just each `<task-id>` tag: fix 9 needs each notification's OWN
    // `<status>`, and a batched enqueue line can carry more than one
    // notification. `matchAll` with a non-greedy body (`[\s\S]*?`) covers
    // multiple blocks on one line without the first block's match swallowing
    // the rest.
    for (const nm of line.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const body = nm[1]!;
      const idMatch = /<task-id>([^<]+)<\/task-id>/.exec(body);
      if (!idMatch) continue;
      const id = idMatch[1]!.trim();

      const statusMatch = /<status>([^<]+)<\/status>/.exec(body);
      const statusRaw = statusMatch ? statusMatch[1]!.trim() : null;
      if (statusRaw !== null && !TERMINAL_NOTIFICATION_STATUSES.has(statusRaw)) {
        console.error(
          `[claude-subagents] task-notification for id ${id} has unrecognised <status>"${statusRaw}"> — skipping settle`,
        );
        continue;
      }

      const w = workflows.get(id);
      if (w) {
        if (w.status === "running") settleSubagentById(id, "completed", "receipt");
        continue;
      }
      // Not a container id this watcher knows — check whether it names an
      // ordinary tracked subagent/workflow-agent row instead (the W3
      // widening). `files.get` is a plain map lookup, so trying it
      // unconditionally for every id costs nothing on the common case where
      // the id matches neither.
      const fs = files.get(id);
      if (fs && fs.status === "running") {
        settleSubagentById(id, "completed", "receipt");
        continue;
      }
      // Nor a `files` row — check `bgShells` (a bg shell's `backgroundTaskId`
      // IS the notification's `<task-id>`, see the module header's
      // "Background shells" section). Same idempotent-and-`running`-only
      // posture as the two lookups above.
      const b = bgShells.get(id);
      if (b && b.status === "running") settleSubagentById(id, "completed", "receipt");
    }
  }

  /**
   * Background-shell LAUNCH detection, half 1 of 2: an assistant `tool_use`
   * block for `Bash` with `input.run_in_background === true`. Its own line
   * carries only the tool_use id + description/timeout — the id that
   * actually PKs the row (`backgroundTaskId`) doesn't exist yet; claude mints
   * it on the immediate stub `tool_result` that follows in a LATER main-JSONL
   * line (`scanLineForBgShellStub`). So this half only remembers
   * `{description, timeoutMs}` under the tool_use id, in `bgShellPending`, for
   * the stub half to pick up once it arrives.
   *
   * Verified live shape (see the plan doc):
   *   {"type":"assistant","message":{"content":[{"type":"tool_use",
   *    "id":…,"name":"Bash","input":{"command":…,"description":…,
   *    "timeout":600000,"run_in_background":true}}]}}
   */
  function scanLineForBgShellLaunch(line: string): void {
    // Cheap prefilter before any JSON.parse — the overwhelming majority of
    // main-JSONL lines don't mention this substring at all.
    if (!line.includes("run_in_background")) return;
    let parsed: { type?: unknown; message?: { content?: unknown } };
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // one bad line must not abort the scan of the rest
    }
    if (parsed.type !== "assistant") return;
    const content = parsed.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
      if (b.type !== "tool_use" || b.name !== "Bash" || typeof b.id !== "string") continue;
      const input = b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : null;
      if (!input || input.run_in_background !== true) continue;
      // Prune the oldest entry before inserting a new one once at the cap —
      // see `BG_SHELL_PENDING_MAX`'s doc.
      if (!bgShellPending.has(b.id) && bgShellPending.size >= BG_SHELL_PENDING_MAX) {
        const oldest = bgShellPending.keys().next().value;
        if (oldest !== undefined) bgShellPending.delete(oldest);
      }
      bgShellPending.set(b.id, {
        description: typeof input.description === "string" ? input.description : null,
        timeoutMs: typeof input.timeout === "number" ? input.timeout : null,
      });
    }
  }

  /**
   * Background-shell LAUNCH detection, half 2 of 2: the immediate stub
   * `tool_result` claude writes the moment a `Bash(run_in_background:true)`
   * call is accepted. Verified live shape (see the plan doc):
   *   {"type":"user","message":{"content":[{"type":"tool_result",
   *    "tool_use_id":…,"content":"Command running in background with ID:
   *    <id>. Output is being written to: <path>. You will be notified when
   *    it completes.","is_error":false}]},"toolUseResult":{"stdout":"",
   *    "stderr":"","interrupted":false,"backgroundTaskId":"<id>"}}
   * `backgroundTaskId` IS the row PK — the same id both the LIVE orchestrator
   * dispatch (`setBackgroundTaskSettledHandler`) and
   * `scanLineForTaskNotification`'s widened lookup above key off unchanged,
   * so creating the row under that id is all that's needed to wire up both
   * settle paths with zero further changes to either.
   *
   * Row creation must NEVER depend on the human-readable output-path parse
   * below — that text is explicitly not a stable contract (see the module
   * header). A regex miss still creates the row with `outputPath: null`,
   * which only costs the live tab its content, never the hold.
   *
   * Replay safety: a replayed stub for an id already in `bgShells`
   * (rehydrated from the DB, or created earlier this same process) early-
   * returns — mirrors `registerWorkflowContainer`'s idempotence posture. A
   * settled row must never be resurrected by its own replayed launch stub.
   */
  function scanLineForBgShellStub(line: string): void {
    if (!line.includes("backgroundTaskId")) return;
    let parsed: { type?: unknown; message?: { content?: unknown }; toolUseResult?: unknown };
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (parsed.type !== "user") return;
    const tr = parsed.toolUseResult;
    const trObj = tr && typeof tr === "object" ? (tr as Record<string, unknown>) : null;
    const id = typeof trObj?.backgroundTaskId === "string" ? trObj.backgroundTaskId : null;
    if (!id) return;
    if (bgShells.has(id)) return; // replay of an already-known id — see doc above

    const content = parsed.message?.content;
    if (!Array.isArray(content)) return;
    let toolUseId: string | null = null;
    let contentText: string | null = null;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const cb = block as { type?: unknown; tool_use_id?: unknown; content?: unknown };
      if (cb.type !== "tool_result") continue;
      toolUseId = typeof cb.tool_use_id === "string" ? cb.tool_use_id : null;
      contentText = typeof cb.content === "string" ? cb.content : null;
      break;
    }

    const pending = toolUseId ? bgShellPending.get(toolUseId) : undefined;
    if (toolUseId) bgShellPending.delete(toolUseId);

    // Best-effort output-path parse — see the doc above for why a miss must
    // never block row creation.
    const pathMatch = contentText ? /Output is being written to:\s*(\S+\.output)/.exec(contentText) : null;
    const outputPath = pathMatch ? pathMatch[1]! : null;

    const runId = resolveRunId(taskId);
    // Same defensive skip `discover()`/`registerWorkflowContainer` make — no
    // run to attach events to. In practice a live session always has one.
    if (!runId) return;

    const now = Date.now();
    const b: BgShellState = {
      id,
      runId,
      toolUseId,
      description: pending?.description ?? null,
      timeoutMs: pending?.timeoutMs ?? null,
      outputPath,
      offset: 0,
      status: "running",
      startedAt: now,
      endedAt: null,
      lastAppendAt: now,
      settleFloor: null,
      receiptSettled: false,
    };
    bgShells.set(id, b);
    lastChangeAt = Date.now();
    subagentsDb.insertIfAbsent(toBgShellShape(b, taskId));
    emitLifecycleForRow(toBgShellShape(b, taskId), "started");
    fireParkedDiscovery(taskId);
  }

  /**
   * Single pass over the bytes appended to the MAIN session JSONL since the
   * last pass, feeding every signal this watcher derives from it: tool_result
   * correlation settles (above); when workflows are tracked, workflow launch
   * detection; when bg shells are tracked, the two-line bg-shell launch
   * correlation (`scanLineForBgShellLaunch` + `scanLineForBgShellStub`); and
   * the generalized task-notification backstop (W3,
   * `scanLineForTaskNotification`), which now settles workflow containers,
   * ordinary rows, AND bg shells.
   *
   * One shared `mainOffset` cursor, one read, one split. The early return is
   * deliberately narrow: bailing on `pending.length === 0` (as this did when
   * tool_results were its only signal) would starve workflow/bg-shell/
   * notification detection on exactly the common case — a task with no
   * `toolUseId`-bearing subagent rows at all (which, post-W2, includes every
   * async subagent as soon as its launch stub is scanned). So it only
   * short-circuits when there is nothing of ANY tracked kind to look for.
   *
   * NOTE — `scanLineForTaskNotification` runs whenever EITHER `WORKFLOWS_ENABLED`
   * or bg shells are actively tracked (`BG_SHELLS_ENABLED && bgShells.size >
   * 0` — no point scanning for a notification naming a row this watcher
   * hasn't created yet), even though it also backstops plain (non-workflow)
   * async subagents whenever workflows are on. That's a deliberate
   * scope-preserving choice, not an oversight: `WORKFLOWS_ENABLED` defaults
   * on, so this covers the overwhelming majority of installs unchanged; an
   * operator who explicitly sets `AGETOR_TRACK_WORKFLOWS=0` (with bg shells
   * also off, or none yet discovered) also loses the async-notification
   * backstop for ordinary subagents (they still have the end_turn-idle and
   * staleness backstops) — a narrower rollback lever was judged preferable to
   * adding a second independent env var for one scan.
   *
   * COST NOTE — tracking workflows OR bg shells means this watcher scans the
   * main transcript on every cycle, where before (neither tracked) it usually
   * skipped the read entirely. Two things keep that bounded: the first read
   * after attach starts at most `REPLAY_WINDOW_BYTES` from the end (see the
   * clamp in `attachSubagentWatcher`), and every read after it is incremental
   * — the cursor only ever moves forward, so steady state is one `statSync`
   * plus the handful of bytes the turn actually appended. The old "a task
   * with no background agents never pays for this scan at all" property
   * survives only with both `AGETOR_TRACK_WORKFLOWS=0` and
   * `AGETOR_TRACK_BG_SHELLS=0`.
   */
  function scanMainSignals(): void {
    const pending = [...files.values()].filter((fs) => fs.status === "running" && fs.toolUseId);
    if (pending.length === 0 && !WORKFLOWS_ENABLED && !BG_SHELLS_ENABLED) return;

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
        // holding the card. Same ordering argument applies to the bg-shell
        // pair below.
        scanLineForWorkflowLaunch(line);
      }
      if (BG_SHELLS_ENABLED) {
        scanLineForBgShellLaunch(line);
        scanLineForBgShellStub(line);
      }
      if (WORKFLOWS_ENABLED || (BG_SHELLS_ENABLED && bgShells.size > 0)) {
        scanLineForTaskNotification(line);
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
      // Steady-state: only re-stat/re-read `running` files (plus a couple of
      // narrow exceptions below). Completed ones keep no per-tick cost beyond
      // fix 3's cheap `statSync` backstop; a resume also re-opens them via the
      // dir watcher's append notification (see `armDirWatcher`, which tails
      // ALL files) where available. The first cycle is the exception — it
      // tails everything to drain a reattach backlog — as is a settled
      // workflow agent whose workflow is still live (`tailPastSettle`), which
      // the non-recursive dir watcher cannot cover.
      const tailAll = firstCycle;
      firstCycle = false;
      for (const fs of files.values()) {
        // Fix 2 — `fs.offset === 0` drains a row that has NEVER been read,
        // even though it isn't `running` — the born-settled (W7) case: its
        // content sits below `replayFloor` (fix 1), so draining it here can
        // never flip it back, but without this it would never be tailed at
        // all (steady-state only re-tails `running` rows) and its transcript
        // tab would render permanently empty.
        if (tailAll || fs.status === "running" || tailPastSettle(fs) || fs.offset === 0) {
          tailFile(fs);
          continue;
        }
        // Fix 3 — poll backstop for post-settle resume detection. Before
        // this, a settled regular row's later growth was only ever seen via
        // the `fs.watch` dir watcher (steady-state polling above only
        // re-tails `running`/never-read/`tailPastSettle` rows), which makes
        // resume detection watcher-only: non-deterministic under manual
        // `pump()`-driven tests, and silently unavailable on filesystems
        // where `fs.watch` isn't supported (the dir watcher's own `armDirWatcher`
        // already tolerates that — "the poll backstop covers it" — but until
        // now there wasn't one for this specific case). A `statSync` per
        // non-running row is microsecond-cheap, so doing it every cycle for
        // every settled row is not a meaningful cost even on a task with many
        // subagents. Guarded: a file that vanished (or is momentarily
        // unreadable) is skipped, not treated as an error — the dir watcher
        // or a later tick picks it up if it reappears.
        try {
          if (statSync(fs.sourcePath).size > fs.offset) tailFile(fs);
        } catch { /* file gone/unreadable this tick — try again next cycle */ }
      }
      tailJournals();
      if (BG_SHELLS_ENABLED) tailBgShells();
      scanMainSignals();
      checkDone(now);
      checkStale(now);
      if (BG_SHELLS_ENABLED) checkBgShellCeiling(now);
    } catch { /* swallow — never crash the timer */ }
  }

  function tick(): void {
    if (detached) return;
    const now = Date.now();
    cycle(now);
    // A live workflow CONTAINER counts as "running" for cadence purposes even
    // when no agent file is open right now: between waves it is the only thing
    // holding the card, and the next wave's files should be picked up on the
    // fast tier, not four seconds late. A `running` bg shell is the same case
    // between its launch and its settle — there is no file to open at all.
    const anyRunning =
      [...files.values()].some((f) => f.status === "running") ||
      [...workflows.values()].some((w) => w.status === "running") ||
      [...bgShells.values()].some((b) => b.status === "running");
    let delay: number;
    if (anyRunning) {
      delay = FAST_POLL_MS;
    } else if (files.size === 0 && workflows.size === 0 && wfJournals.size === 0 && bgShells.size === 0
               && now - lastChangeAt >= DEEP_IDLE_AFTER_MS) {
      // Never discovered a subagent, a workflow, OR a bg shell and nothing's
      // happened for a while — back off further than the ordinary idle
      // cadence.
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
    syncSettled(id: string, status: SubagentStatus, endedAt: number, source?: "receipt" | "inferred"): void {
      const fs = files.get(id);
      if (fs) {
        fs.status = status;
        fs.endedAt = endedAt;
        // Fix 4 — latch `receiptSettled` for an authoritative settle so
        // `tailFile`'s flip-back narrows to user-line-only resurrection.
        if (source === "receipt") fs.receiptSettled = true;
        return;
      }
      // Workflow containers live in their own map (they back no file), but
      // need the same in-memory sync so the completion scan doesn't re-settle
      // a container on every subsequent replay of the notification line, and
      // so the cadence check above drops back off the fast tier.
      const w = workflows.get(id);
      if (w) {
        w.status = status;
        w.endedAt = endedAt;
        return;
      }
      // Background shells live in their own map too (no file to back them —
      // see `BgShellState`). This is what the LIVE orchestrator dispatch
      // (`setBackgroundTaskSettledHandler` → `settleSubagentById`) flows
      // through, and latching `receiptSettled` here is what keeps
      // `checkBgShellCeiling`'s flip-back from resurrecting a row the
      // harness already said is over — mirrors the `files` branch above.
      const b = bgShells.get(id);
      if (!b) return;
      b.status = status;
      b.endedAt = endedAt;
      if (source === "receipt") b.receiptSettled = true;
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
 *
 * `source` (fix 4) — `"receipt"` for a settle driven by an authoritative
 * completion receipt (a `<task-notification>`, live via claude-tmux's
 * `setBackgroundTaskSettledHandler` wiring in orchestrator.ts, or restart-safe
 * via `scanLineForTaskNotification`/`tailJournals`'s journal `result` line);
 * `"inferred"` (the default) for everything else — `checkDone`'s end-of-turn
 * idle, `checkStale`'s staleness backstop, a real `tool_result` in
 * `scanLineForToolResult`, and orphaning. See `FileState.receiptSettled`'s doc
 * for what the distinction buys.
 */
export function settleSubagentById(
  id: string,
  status: "completed" | "orphaned",
  source: "receipt" | "inferred" = "inferred",
): boolean {
  return settleSubagent(id, status, 0, source);
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
 *  half-settled workflow.
 *
 *  `source` (fix 4) — threaded through to `syncSettled` so it can latch
 *  `FileState.receiptSettled`; the cascade call below deliberately does NOT
 *  propagate the parent container's source and defaults to `"inferred"` for
 *  cascaded agent rows — cascading is itself already an unconditional,
 *  invariant-driven settle (the container guard in `tailFile` independently
 *  blocks a cascaded row from flipping back for as long as its container
 *  stays settled), so it doesn't need the extra receipt latch to be safe. */
function settleSubagent(
  id: string,
  status: "completed" | "orphaned",
  depth: number,
  source: "receipt" | "inferred" = "inferred",
): boolean {
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
  watchers.get(taskId)?.syncSettled(id, status, row?.endedAt ?? now, source);
  // Cascade BEFORE the hook (and the hook only at depth 0), so the
  // orchestrator's release predicate (`subagents.hasRunning`) runs exactly once
  // per settle event, against a workflow that is settled in full.
  if (row?.parentKind === "workflow" && depth < 1) cascadeWorkflowAgents(taskId, row, depth);
  if (depth === 0) fireSettle(taskId);
  return true;
}
