import { Database } from "bun:sqlite";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { dataDir, pidFilePath, credsFilePath, resolveDbPath } from "./db-path.ts";
import { applyConnectionPragmas } from "./db-core/connection.ts";
import { buildDbModules } from "./db-core/modules.ts";
import type { TaskDecorationDeps } from "./db-core/tasks.ts";
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

// Data-dir and path resolution (including the NODE_ENV=test throwaway-dir
// guard) live in `db-path.ts`; the connection pragmas in `db-core/connection.ts`.
export { dataDir, pidFilePath, credsFilePath };

export const db = new Database(resolveDbPath());
applyConnectionPragmas(db);

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

const modules = buildDbModules(db, taskDecorations);

export const harnesses = modules.harnesses;
export const harnessSessionHandoffs = modules.harnessSessionHandoffs;
export const harnessOrphanedCopies = modules.harnessOrphanedCopies;
export const resetOrphanStampForTests = modules.harnessStore.resetOrphanStampForTests;
export const harnessUsage = modules.harnessUsage;

export const tasks = modules.tasks;
export const backlog = modules.backlog;
export const drafts = modules.drafts;
export const projects = modules.projects;
export const preferences = modules.preferences;
export const retentionSweeps = modules.retentionSweeps;
export const claudeSessionSeen = modules.claudeSessionSeen;
export const harnessAutoEnabled = modules.harnessAutoEnabled;
export const savedPrompts = modules.savedPrompts;
export const agentProfiles = modules.agentProfiles;
export const pipelines = modules.pipelines;
export const runs = modules.runs;
export const subagents = modules.subagents;
export const opencodeStoppedChildren = modules.opencodeStoppedChildren;
export const opencodeWatchTombstones = modules.opencodeWatchTombstones;

export const insertCursorAsk = modules.cursorAsks.insertCursorAsk;
export const resolveCursorAsk = modules.cursorAsks.resolveCursorAsk;
export const listOpenCursorAsks = modules.cursorAsks.listOpenCursorAsks;

export const hiddenClaudeSessionIds = modules.hiddenSessionIds.hiddenClaudeSessionIds;
export const hiddenOpencodeSessionIds = modules.hiddenSessionIds.hiddenOpencodeSessionIds;
