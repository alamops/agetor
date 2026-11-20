import { Database } from "bun:sqlite";
import { homedir, tmpdir } from "node:os";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { coreCredsPath } from "./core-creds.ts";
import { makeTasks, type TaskDecorationDeps } from "./db-core/tasks.ts";
import { makeBacklog, makeDrafts } from "./db-core/backlog.ts";
import { makeProjects } from "./db-core/projects.ts";
import { makeClaudeSessionSeen, makeHarnessAutoEnabled, makePreferences, makeRetentionSweeps } from "./db-core/preferences.ts";
import { makeHarnessStore, makeHarnessUsage } from "./db-core/harnesses.ts";
import { makeSavedPrompts } from "./db-core/saved-prompts.ts";
import { makeAgentProfiles } from "./db-core/agent-profiles.ts";
import { makePipelines } from "./db-core/pipelines.ts";
import { makeRuns } from "./db-core/runs.ts";
import { makeCursorAsks, makeOpencodeStoppedChildren, makeOpencodeWatchTombstones, makeSubagents } from "./db-core/subagents.ts";
import { makeHiddenSessionIds } from "./db-core/hidden-sessions.ts";
// Interactions live in-memory in `interactions.ts`. The import creates a
// cycle: db.ts → interactions.ts → db.ts (for `tasks`). It is safe ONLY
// because both modules access each other's exports exclusively from
// function bodies that run after module init — never at top level. Do
// NOT add a top-level call site in either direction (e.g. a `const x =
// tasks.get(...)` at module scope in interactions.ts) — under ESM live
// bindings the unresolved cycle becomes an undefined-binding crash at
// import time. Keep both sides lazy.
import { countPendingForTask, pendingCountsByTask } from "./interactions.ts";
// Same lazy-cycle contract as interactions.ts above: terminals.ts imports
// `tasks` from this module, and we call `countTerminals` only from the
// decoration thunks below (function bodies), never at top level. Do not hoist
// this call site.
import { countTerminals, terminalCountsByTask } from "./terminals.ts";

// Hard guard against test fixtures silently leaking into the user's real
// SQLite db. `bun test` runs every *.test.ts file in one process, so the
// first import of db.ts wins — any test file that sets AGETOR_DATA_DIR in
// `beforeAll` (instead of at top level) loses the race and writes to
// ~/.agetor/agetor.sqlite. We discovered this the painful way: 10 fixture
// tasks + dozens of phantom projects polluted the production kanban.
// Under NODE_ENV=test, if no AGETOR_DATA_DIR was set we auto-allocate a
// throwaway dir — guarantees we never touch ~/.agetor under tests even if
// some test file forgot the top-level setup. Logged so the gap is visible
// in CI output.
if (process.env.NODE_ENV === "test" && !process.env.AGETOR_DATA_DIR) {
  process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-test-auto-"));
  console.warn(
    `[agetor:db] NODE_ENV=test with no AGETOR_DATA_DIR — auto-allocated `
    + `${process.env.AGETOR_DATA_DIR}. Set it at the TOP of the test file `
    + `(not in beforeAll) to silence this warning.`,
  );
}
const DATA_DIR = process.env.AGETOR_DATA_DIR
  ?? path.join(homedir(), ".agetor");
mkdirSync(DATA_DIR, { recursive: true });

export const dataDir = DATA_DIR;

/** Pidfile path. Written at boot by `index.ts`, read by `wipe-dev.ts` for
 *  liveness checks. Single source of truth so a future rename doesn't
 *  leave silent stragglers. */
export const pidFilePath = path.join(DATA_DIR, "agetor.pid");

/** Core credentials file (port + per-launch API token + owner pid/kind),
 *  written after the API server binds and read by the CLI/daemon to discover
 *  and authenticate to the running core. See `core-creds.ts`. */
export const credsFilePath = coreCredsPath(DATA_DIR);

export const db = new Database(path.join(DATA_DIR, "agetor.sqlite"));
db.exec("PRAGMA journal_mode = WAL;");
// WAL + NORMAL is SQLite's documented sweet spot for a local single-writer
// app. WAL already makes every transaction atomic and the database consistent
// across an app crash AND a power loss; NORMAL merely stops forcing an fsync
// at every commit (FULL — the default — does). That fsync was being paid on
// every streamed `run_events` row and every unread-watermark bump: dozens of
// disk flushes a minute while an agent works, buying durability for the last
// few milliseconds of a log that is re-derivable from the agent's own JSONL.
// A battery/CPU win with no correctness cost — the only thing NORMAL gives
// up is that a kernel panic mid-stream may roll back the final commit(s).
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA foreign_keys = ON;");

const applied = migrate(db, migrations);
if (applied.length) console.log(`[agetor] applied migrations: ${applied.join(", ")}`);

// Names that moved to `db-core/` and are still imported from here.
export type { AgentProfileInsertInput, AgentProfilePatch } from "./db-core/agent-profiles.ts";
export { AgentProfileNameError, HarnessBuiltinError, HarnessInUseError, IMPORTED_CLAUDE_HELD_ELSEWHERE, IMPORTED_OPENCODE_HELD_ELSEWHERE, ImportedClaudeSessionTaken, ImportedOpencodeSessionTaken, PipelineNameError } from "./db-core/errors.ts";
export type { HarnessInsertInput, HarnessOrphanedCopy, HarnessPatch, HarnessSessionHandoff } from "./db-core/harnesses.ts";
export { SESSION_ID_COLUMNS, TOOL_RESULT_TRIM_SQL, clampWindowByBytes, isHiddenContinuationUserText, resolveAnchoredMinId } from "./db-core/runs.ts";
export type { AppendedEvent, ForwardResumeResult, SessionIdColumn, TaskEventRow } from "./db-core/runs.ts";
export type { SavedPromptInsertInput, SavedPromptPatch } from "./db-core/saved-prompts.ts";
export { OPENCODE_CHILD_SOURCE_PREFIX } from "./db-core/subagents.ts";
export type { CursorAskOutcome, OpencodeWatchTombstone, StoredCursorAsk } from "./db-core/subagents.ts";
export { parsePipelineRunState } from "./db-core/task-parsers.ts";

// Every SQL-owning module lives in `db-core/` as a factory over a connection,
// so the same query code can run on another connection (a worker thread). This
// file instantiates each one on the main-thread connection and keeps the
// historical export names. Only the in-memory badge counts `tasks` folds into
// a `Task` come from main-thread registries, passed in lazily (the cycle
// contract above): a thunk, never the imported binding itself.
const taskDecorations: TaskDecorationDeps = {
  countPendingForTask: (taskId) => countPendingForTask(taskId),
  countTerminals: (taskId) => countTerminals(taskId),
  pendingCountsByTask: () => pendingCountsByTask(),
  terminalCountsByTask: () => terminalCountsByTask(),
};

const harnessStore = makeHarnessStore(db);
export const harnesses = harnessStore.harnesses;
export const harnessSessionHandoffs = harnessStore.harnessSessionHandoffs;
export const harnessOrphanedCopies = harnessStore.harnessOrphanedCopies;
export const resetOrphanStampForTests = harnessStore.resetOrphanStampForTests;
export const harnessUsage = makeHarnessUsage(db);

export const tasks = makeTasks(db, { harnessOrphanedCopies, decorations: taskDecorations });
export const backlog = makeBacklog(tasks);
export const drafts = makeDrafts(tasks);
export const projects = makeProjects(db);
export const preferences = makePreferences(db);
export const retentionSweeps = makeRetentionSweeps(db);
export const claudeSessionSeen = makeClaudeSessionSeen(db);
export const harnessAutoEnabled = makeHarnessAutoEnabled(db);
export const savedPrompts = makeSavedPrompts(db);
export const agentProfiles = makeAgentProfiles(db);
export const pipelines = makePipelines(db);
export const runs = makeRuns(db);
export const subagents = makeSubagents(db);
export const opencodeStoppedChildren = makeOpencodeStoppedChildren(db);
export const opencodeWatchTombstones = makeOpencodeWatchTombstones(db);

const cursorAsks = makeCursorAsks(db);
export const insertCursorAsk = cursorAsks.insertCursorAsk;
export const resolveCursorAsk = cursorAsks.resolveCursorAsk;
export const listOpenCursorAsks = cursorAsks.listOpenCursorAsks;

const hiddenSessionIds = makeHiddenSessionIds(runs, tasks);
export const hiddenClaudeSessionIds = hiddenSessionIds.hiddenClaudeSessionIds;
export const hiddenOpencodeSessionIds = hiddenSessionIds.hiddenOpencodeSessionIds;
