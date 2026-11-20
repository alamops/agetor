// The async database facade production code imports (docs/plans/non-blocking-core.md,
// T8). It exports the same module names as `db.ts`, with every method returning a
// Promise of what the synchronous method returned, so a caller switches by changing
// the import path and adding `await`:
//
//   import { tasks, runs } from "./db-async.ts";
//   const task = await tasks.get(id);                  // Promise<Task | null>
//
// The method set is not written out here: `AsyncModule<T>` is mapped from each
// db-core factory's return type, and a Proxy forwards `module.method(...args)` to
// `db-rpc.ts` by name, so it cannot drift from db-core.
//
// Task badge counts. The worker has no view of the main thread's in-memory
// registries, so it reports `pendingInteractionCount` and `openTerminalCount` as
// zero. Every Task (or Task[]) result of `tasks`, `backlog` and `drafts` is
// overlaid with the real counts from the decorations registered through
// `setTaskDecorations`, using the same pure functions `tasks.list()` uses
// (`db-core/task-decoration.ts`). The overlay recomputes from the registries, so
// it is idempotent: a result that is already decorated (in-process mode) comes out
// the same. With no decorations registered nothing is overlaid.
//
// This module must not import `db.ts`, `interactions.ts` or `terminals.ts`
// (db.ts imports them, and importing it opens a second connection): boot wires the
// registries in with `setTaskDecorations`.

import type { Task } from "../shared/types.ts";
import type { DbModules } from "./db-core/modules.ts";
import type { TaskDecorationDeps } from "./db-core/tasks.ts";
import { decorateTask, decorateTaskList, decorateTaskWithSteps } from "./db-core/task-decoration.ts";
import { getDbRpc, type DbRpc } from "./db-rpc.ts";

export {
  call,
  closeDb,
  createDbRpc,
  currentRev,
  dbReady,
  DbRestartingError,
  DbUnavailableError,
  onRevChanged,
  op,
  type DbMode,
  type DbRpc,
  type DbRpcOptions,
} from "./db-rpc.ts";

// What db.ts re-exports, so callers switch imports by changing only the path.
export type { AgentProfileInsertInput, AgentProfilePatch } from "./db-core/agent-profiles.ts";
export { AgentProfileNameError, HarnessBuiltinError, HarnessInUseError, IMPORTED_CLAUDE_HELD_ELSEWHERE, IMPORTED_OPENCODE_HELD_ELSEWHERE, ImportedClaudeSessionTaken, ImportedOpencodeSessionTaken, PipelineNameError } from "./db-core/errors.ts";
export type { HarnessInsertInput, HarnessOrphanedCopy, HarnessPatch, HarnessSessionHandoff } from "./db-core/harnesses.ts";
export { SESSION_ID_COLUMNS, TOOL_RESULT_TRIM_SQL, clampWindowByBytes, isHiddenContinuationUserText, resolveAnchoredMinId } from "./db-core/runs.ts";
export type { AppendedEvent, ForwardResumeResult, SessionIdColumn, TaskEventRow } from "./db-core/runs.ts";
export type { SavedPromptInsertInput, SavedPromptPatch } from "./db-core/saved-prompts.ts";
export { OPENCODE_CHILD_SOURCE_PREFIX } from "./db-core/subagents.ts";
export type { CursorAskOutcome, OpencodeWatchTombstone, StoredCursorAsk } from "./db-core/subagents.ts";
export { parsePipelineRunState } from "./db-core/task-parsers.ts";
export { dataDir, pidFilePath, credsFilePath } from "./db-path.ts";

/** A db-core module with every method returning a Promise. Non-function members are dropped. */
export type AsyncModule<T> = {
  [K in keyof T as T[K] extends (...args: any[]) => unknown ? K : never]:
    T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

/** Mutable holder for the registered task decorations (null until wired). */
export interface TaskDecorationHolder {
  current: TaskDecorationDeps | null;
}

function isTaskLike(v: unknown): v is Task {
  return typeof v === "object" && v !== null
    && typeof (v as Task).id === "string"
    && typeof (v as Task).pendingInteractionCount === "number"
    && typeof (v as Task).openTerminalCount === "number";
}

async function overlayTaskResult(
  rpc: DbRpc,
  decor: TaskDecorationDeps,
  module: string,
  method: string,
  result: unknown,
): Promise<unknown> {
  if (Array.isArray(result)) {
    if (!result.every(isTaskLike)) return result;
    return module === "tasks" && method === "list"
      ? decorateTaskList(result, decor)
      : result.map((t) => decorateTask(t, decor));
  }
  if (!isTaskLike(result)) return result;
  if (module === "tasks" && method === "get" && result.pipelineId) {
    const steps = (await rpc.call("tasks", "stepsForParent", [result.id])) as Task[];
    return decorateTaskWithSteps(result, steps, decor);
  }
  return decorateTask(result, decor);
}

const TASK_RESULT_MODULES = new Set(["tasks", "backlog", "drafts"]);

function makeAsyncModule<K extends keyof DbModules>(
  getRpc: () => DbRpc,
  holder: TaskDecorationHolder,
  module: K,
): AsyncModule<DbModules[K]> {
  const methods = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  return new Proxy({} as AsyncModule<DbModules[K]>, {
    get(_target, prop) {
      // Never look like a thenable: `await facade.tasks` must not call a method.
      if (typeof prop !== "string" || prop === "then") return undefined;
      let fn = methods.get(prop);
      if (!fn) {
        fn = async (...args: unknown[]) => {
          const rpc = getRpc();
          const result = await rpc.call(module, prop, args);
          const decor = holder.current;
          return decor && TASK_RESULT_MODULES.has(module)
            ? overlayTaskResult(rpc, decor, module, prop, result)
            : result;
        };
        methods.set(prop, fn);
      }
      return fn;
    },
  });
}

/** Build a facade over a client. The default exports below use the process-wide
 *  client; tests build one over a client of each mode. */
export function createDbAsync(getRpc: () => DbRpc, holder: TaskDecorationHolder = { current: null }) {
  const m = <K extends keyof DbModules>(name: K) => makeAsyncModule(getRpc, holder, name);
  const cursorAsks = m("cursorAsks");
  const hiddenSessionIds = m("hiddenSessionIds");
  return {
    holder,
    harnesses: m("harnesses"),
    harnessSessionHandoffs: m("harnessSessionHandoffs"),
    harnessOrphanedCopies: m("harnessOrphanedCopies"),
    harnessUsage: m("harnessUsage"),
    resetOrphanStampForTests: m("harnessStore").resetOrphanStampForTests,
    tasks: m("tasks"),
    backlog: m("backlog"),
    drafts: m("drafts"),
    projects: m("projects"),
    preferences: m("preferences"),
    retentionSweeps: m("retentionSweeps"),
    claudeSessionSeen: m("claudeSessionSeen"),
    harnessAutoEnabled: m("harnessAutoEnabled"),
    savedPrompts: m("savedPrompts"),
    agentProfiles: m("agentProfiles"),
    pipelines: m("pipelines"),
    runs: m("runs"),
    subagents: m("subagents"),
    opencodeStoppedChildren: m("opencodeStoppedChildren"),
    opencodeWatchTombstones: m("opencodeWatchTombstones"),
    insertCursorAsk: cursorAsks.insertCursorAsk,
    resolveCursorAsk: cursorAsks.resolveCursorAsk,
    listOpenCursorAsks: cursorAsks.listOpenCursorAsks,
    hiddenClaudeSessionIds: hiddenSessionIds.hiddenClaudeSessionIds,
    hiddenOpencodeSessionIds: hiddenSessionIds.hiddenOpencodeSessionIds,
  };
}

export type DbAsync = ReturnType<typeof createDbAsync>;

const decorationHolder: TaskDecorationHolder = { current: null };
const facade = createDbAsync(getDbRpc, decorationHolder);

/** Register the main-thread registries whose counts are overlaid onto every Task
 *  this facade returns (pass `null` to stop overlaying). Boot calls this once,
 *  with thunks over `interactions.ts` and `terminals.ts`. */
export function setTaskDecorations(deps: TaskDecorationDeps | null): void {
  decorationHolder.current = deps;
}

export const {
  harnesses,
  harnessSessionHandoffs,
  harnessOrphanedCopies,
  harnessUsage,
  resetOrphanStampForTests,
  tasks,
  backlog,
  drafts,
  projects,
  preferences,
  retentionSweeps,
  claudeSessionSeen,
  harnessAutoEnabled,
  savedPrompts,
  agentProfiles,
  pipelines,
  runs,
  subagents,
  opencodeStoppedChildren,
  opencodeWatchTombstones,
  insertCursorAsk,
  resolveCursorAsk,
  listOpenCursorAsks,
  hiddenClaudeSessionIds,
  hiddenOpencodeSessionIds,
} = facade;
