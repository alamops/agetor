import type { Database } from "bun:sqlite";
import { makeTasks, type TaskDecorationDeps } from "./tasks.ts";
import { makeBacklog, makeDrafts } from "./backlog.ts";
import { makeProjects } from "./projects.ts";
import { makeClaudeSessionSeen, makeHarnessAutoEnabled, makePreferences, makeRetentionSweeps } from "./preferences.ts";
import { makeHarnessStore, makeHarnessUsage } from "./harnesses.ts";
import { makeSavedPrompts } from "./saved-prompts.ts";
import { makeAgentProfiles } from "./agent-profiles.ts";
import { makePipelines } from "./pipelines.ts";
import { makeRuns } from "./runs.ts";
import { makeCursorAsks, makeOpencodeStoppedChildren, makeOpencodeWatchTombstones, makeSubagents } from "./subagents.ts";
import { makeHiddenSessionIds } from "./hidden-sessions.ts";
import { makeRemote } from "./remote.ts";

/** Instantiate every SQL-owning module over one connection. `db.ts` calls this
 *  with the main-thread decorations; the worker's handler calls it with none
 *  (the main thread overlays them, see `db-async.ts`). */
export function buildDbModules(conn: Database, decorations?: TaskDecorationDeps) {
  const harnessStore = makeHarnessStore(conn);
  const harnessOrphanedCopies = harnessStore.harnessOrphanedCopies;
  const tasks = makeTasks(conn, { harnessOrphanedCopies, decorations });
  const runs = makeRuns(conn);
  const remote = makeRemote(conn);
  return {
    harnesses: harnessStore.harnesses,
    harnessSessionHandoffs: harnessStore.harnessSessionHandoffs,
    harnessOrphanedCopies,
    /** Holds `resetOrphanStampForTests`, the one non-table member of the store. */
    harnessStore: { resetOrphanStampForTests: harnessStore.resetOrphanStampForTests },
    harnessUsage: makeHarnessUsage(conn),
    tasks,
    backlog: makeBacklog(tasks),
    drafts: makeDrafts(tasks),
    projects: makeProjects(conn),
    preferences: makePreferences(conn),
    retentionSweeps: makeRetentionSweeps(conn),
    claudeSessionSeen: makeClaudeSessionSeen(conn),
    harnessAutoEnabled: makeHarnessAutoEnabled(conn),
    savedPrompts: makeSavedPrompts(conn),
    agentProfiles: makeAgentProfiles(conn),
    pipelines: makePipelines(conn),
    runs,
    subagents: makeSubagents(conn),
    opencodeStoppedChildren: makeOpencodeStoppedChildren(conn),
    opencodeWatchTombstones: makeOpencodeWatchTombstones(conn),
    cursorAsks: makeCursorAsks(conn),
    hiddenSessionIds: makeHiddenSessionIds(runs, tasks),
    remoteDevices: remote.remoteDevices,
    remoteAudit: remote.remoteAudit,
    remoteIdempotency: remote.remoteIdempotency,
  };
}

export type DbModules = ReturnType<typeof buildDbModules>;
export type DbModuleName = keyof DbModules;
