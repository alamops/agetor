import type { AgentProfileSnapshot, ColumnId, Harness, Run, RunStatus, Task, TaskRepository } from "../../../shared/types.ts";
import { isMultiRepoTask } from "../../../shared/multi-repo.ts";
import { resolveClaudePlan, upsertClaudePlanFromExitPlanMode, upsertDetectedPlan } from "../../task-plans.ts";
import { defineOp, type OpCtx } from "./define.ts";

/** Conditions a guarded column move checks against the stored rows, inside the
 *  same transaction as the write. Every field that is set must hold. */
export interface ColumnMoveGuard {
  /** The task's current column is one of these. */
  columnIn?: ColumnId[];
  /** The task's current `run_id` is exactly this (null: no run). */
  runId?: string | null;
  /** The status of the task's current run (`run_id`) is this. */
  runStatus?: RunStatus;
  /** No `running` subagent row for the task. */
  noRunningSubagents?: boolean;
  /** The task is not archived. */
  notArchived?: boolean;
}

export interface ColumnMoveResult {
  /** The column before the move (null: no such task). */
  prev: ColumnId | null;
  /** Whether the guard held and the column was written. */
  applied: boolean;
}

function guardHolds(ctx: OpCtx, task: Task, guard: ColumnMoveGuard): boolean {
  if (guard.columnIn && !guard.columnIn.includes(task.column)) return false;
  if (guard.runId !== undefined && (task.runId ?? null) !== guard.runId) return false;
  if (guard.notArchived && task.archivedAt != null) return false;
  if (guard.runStatus !== undefined) {
    if (!task.runId) return false;
    if (ctx.modules.runs.get(task.runId)?.status !== guard.runStatus) return false;
  }
  if (guard.noRunningSubagents && ctx.modules.subagents.hasRunning(task.id)) return false;
  return true;
}

/** A task as one consistent read: the row, its agent resolved to a harness,
 *  and whether background agents hold it (see `orchestrator.taskSnapshot`). */
export interface TaskSnapshot {
  task: Task | null;
  harness: Harness | null;
  /** The #92 hold: `running`, its current run `succeeded`, and a subagent
   *  row still `running` (`isTaskHeldByBackgroundAgents` in orchestrator.ts). */
  held: boolean;
  /** Any subagent row of the task still `running`, whatever the column. */
  runningSubagents: boolean;
}

/** The answer of `orchestrator.backgroundHold`. */
export interface BackgroundHold {
  /** The #92 hold: `running`, current run `succeeded`, a subagent still `running`. */
  held: boolean;
  /** Set when a failed turn's background agents may hold the task; the caller
   *  holds it unless that run is live in its own `active` map. */
  failedRunId: string | null;
}

/** The hold predicate shared by `orchestrator.taskSnapshot` and
 *  `orchestrator.backgroundHold`, so the two never drift. */
function holdFacts(ctx: OpCtx, taskId: string, column: string, runId: string | null): { held: boolean; runningSubagents: boolean } {
  const runningSubagents = ctx.modules.subagents.hasRunning(taskId);
  const held = runningSubagents
    && column === "running"
    && runId != null
    && ctx.modules.runs.get(runId)?.status === "succeeded";
  return { held, runningSubagents };
}

/** One plan-history change (see `orchestrator.applyPlanChange`). */
export type PlanChange =
  | { kind: "exit-plan-mode"; toolCallId: string; runId: string; content: string; now: number }
  | { kind: "resolve-claude"; toolUseId: string; resultText: string; now: number }
  | { kind: "detected"; toolCallId: string; runId: string; name: string | null; content: string; now: number };

/** What a run start writes in one transaction (see `orchestrator.persistRunStart`). */
export interface RunStartWrite {
  taskId: string;
  taskPatch: Partial<Task>;
  /** A multi-repository prepare's entries (written with their checkouts). */
  repositories?: TaskRepository[];
  /** Entries whose live checkout read failed: their stored checkout is kept. */
  unknownCheckouts?: string[];
  /** The single-repository checkout to record (undefined: keep the stored one). */
  checkout?: string | null;
  run: Run;
}

/** `setRepositories` plus the live checkout of every materialized entry
 *  (`recordPreparedRepositoryCheckouts` in orchestrator.ts, same rules). */
function writeRepositories(ctx: OpCtx, taskId: string, repos: TaskRepository[], unknown: readonly string[]): void {
  ctx.modules.tasks.setRepositories(taskId, repos);
  for (const repo of repos) {
    if (!repo.worktreePath) continue;
    if (unknown.includes(repo.name)) continue;
    ctx.modules.tasks.setRepositoryCheckout(taskId, repo.name, repo.checkoutBranch ?? null);
  }
}

/** A run row left `running` by a previous process, as boot reconcile reads it. */
export interface StaleRunningRun {
  id: string;
  task_id: string;
  tmux_session: string | null;
  claude_session_id: string | null;
  codex_session_id: string | null;
  cursor_session_id: string | null;
  gemini_session_id: string | null;
  fx_session_id: string | null;
  antigravity_session_id: string | null;
  opencode_session_id: string | null;
  copilot_session_id: string | null;
  agent: string;
  started_at: number;
}

export const orchestratorOps = {
  /**
   * Move a task's column and return the column it had, read in the same
   * transaction (the `prev` of the global `column` event). With a guard, the
   * move happens only while every condition still holds on the stored rows,
   * so a decision made from an earlier read can't land on a task that has
   * moved on meanwhile (a new run started, the user moved the card).
   */
  "orchestrator.setColumn": defineOp({
    tx: true,
    run: (ctx, taskId: string, next: ColumnId, guard: ColumnMoveGuard | null): ColumnMoveResult => {
      const task = ctx.modules.tasks.get(taskId);
      if (!task) return { prev: null, applied: false };
      if (guard && !guardHolds(ctx, task, guard)) return { prev: task.column, applied: false };
      ctx.modules.tasks.update(taskId, { column: next });
      return { prev: task.column, applied: true };
    },
  }),

  /**
   * A run start's persisted half, all or nothing: point the task at the new
   * run (column, branch, worktree), record a multi-repository prepare's
   * entries and checkouts, record the single checkout, and insert the run.
   * Returns the column the task had before (null: no such task).
   */
  "orchestrator.persistRunStart": defineOp({
    tx: true,
    run: (ctx, w: RunStartWrite): ColumnId | null => {
      const prev = ctx.modules.tasks.get(w.taskId)?.column ?? null;
      ctx.modules.tasks.update(w.taskId, w.taskPatch);
      if (w.repositories) writeRepositories(ctx, w.taskId, w.repositories, w.unknownCheckouts ?? []);
      if (w.checkout !== undefined) ctx.modules.tasks.setCheckoutBranch(w.taskId, w.checkout);
      ctx.modules.runs.insert(w.run);
      return prev;
    },
  }),

  /** Record a multi-repository prepare's entries and their live checkouts in
   *  one transaction. */
  "orchestrator.recordRepositories": defineOp({
    tx: true,
    run: (ctx, taskId: string, repos: TaskRepository[], unknown: string[]): void => {
      writeRepositories(ctx, taskId, repos, unknown);
    },
  }),

  /**
   * Insert a successor run and point the task at it (`running`), in one
   * transaction: a harness swap's continuation. Returns the column the task
   * had before.
   */
  "orchestrator.insertRunAndPoint": defineOp({
    tx: true,
    run: (ctx, run: Run): ColumnId | null => {
      const prev = ctx.modules.tasks.get(run.taskId)?.column ?? null;
      ctx.modules.runs.insert(run);
      ctx.modules.tasks.update(run.taskId, { column: "running", runId: run.id });
      return prev;
    },
  }),

  /**
   * The pipeline stamp of a global event about `taskId`: its parent (the
   * emitter's `knownParentId`, else the task's own `pipeline_parent_id`) and
   * that parent's title. Null for an ordinary task (a pipeline parent
   * included: only a step row carries a parent id).
   */
  "orchestrator.pipelineStamp": defineOp({
    tx: false,
    run: ({ conn }, taskId: string, knownParentId: string | null): { parentId: string; parentTitle: string | null } | null => {
      const parentId = knownParentId
        ?? conn.query<{ p: string | null }, [string]>(`SELECT pipeline_parent_id AS p FROM tasks WHERE id = ?`).get(taskId)?.p
        ?? null;
      if (!parentId) return null;
      const title = conn.query<{ title: string }, [string]>(`SELECT title FROM tasks WHERE id = ?`).get(parentId)?.title;
      return { parentId, parentTitle: title ? title : null };
    },
  }),

  /**
   * A task, its harness and its background-agent hold, read in one hop. The
   * send paths decide busy/idle from this and the in-memory run state with
   * nothing awaited in between, so the decision sees one consistent view.
   */
  "orchestrator.taskSnapshot": defineOp({
    tx: false,
    run: (ctx, taskId: string): TaskSnapshot => {
      const task = ctx.modules.tasks.get(taskId);
      if (!task) return { task: null, harness: null, held: false, runningSubagents: false };
      const harness = ctx.modules.harnesses.getByIdOrKind(task.agent);
      const { held, runningSubagents } = holdFacts(ctx, task.id, task.column, task.runId ?? null);
      return { task, harness, held, runningSubagents };
    },
  }),

  /**
   * The held-session probe's whole question, with a tiny reply: whether
   * background agents hold the task (the #92 hold) and, for the failed-turn
   * case, the run id of a `blocked` card whose current run `failed` while a
   * subagent still runs and no run is `running` (the caller finishes that case
   * against its in-memory `active` map). Reads two columns, never a Task row:
   * the death watch asks this on every tick of every idle session.
   */
  "orchestrator.backgroundHold": defineOp({
    tx: false,
    run: (ctx, taskId: string): BackgroundHold => {
      const row = ctx.conn.query<{ column: string; run_id: string | null }, [string]>(
        `SELECT "column" AS "column", run_id FROM tasks WHERE id = ?`,
      ).get(taskId);
      if (!row) return { held: false, failedRunId: null };
      const { held, runningSubagents } = holdFacts(ctx, taskId, row.column, row.run_id);
      if (held) return { held: true, failedRunId: null };
      if (row.column !== "blocked" || row.run_id == null || !runningSubagents) return { held: false, failedRunId: null };
      if (ctx.modules.runs.get(row.run_id)?.status !== "failed") return { held: false, failedRunId: null };
      if (ctx.modules.runs.hasRunning(taskId)) return { held: false, failedRunId: null };
      return { held: false, failedRunId: row.run_id };
    },
  }),

  /**
   * The first-start copy-down of a bound profile onto its task row, as a
   * guarded write: applies only while the task is still bound to
   * `profile.id` (a Detach that landed after the caller decided must not be
   * undone). Returns the updated task, or null when the guard failed (the
   * task is gone or no longer bound to that profile) and nothing was written.
   */
  "orchestrator.copyDownProfile": defineOp({
    tx: true,
    run: (
      ctx,
      taskId: string,
      fields: { agent: string; model: string | null; effort: string | null; mode: string | null; speed: Task["speed"]; maxMode: boolean; opencodeServer: Task["opencodeServer"] },
      profile: AgentProfileSnapshot,
    ): Task | null => {
      const current = ctx.modules.tasks.get(taskId);
      if (!current || (current.agentProfileId ?? null) !== profile.id) return null;
      ctx.modules.tasks.update(taskId, fields as Partial<Task>);
      return ctx.modules.tasks.setAgentProfile(taskId, profile.id, profile);
    },
  }),

  /** Several tasks by id in one hop, in the order asked (null: no such task).
   *  For loops over many tasks (boot reconcile, sweeps) instead of one read
   *  per row. The badge counts are the main thread's: the `db-async.ts` facade
   *  overlays them onto a Task an op returns, as it does for a module call. */
  "orchestrator.getTasks": defineOp({
    tx: false,
    run: (ctx, ids: string[]): (Task | null)[] => ids.map((id) => ctx.modules.tasks.get(id)),
  }),

  /** Several harness ids (or legacy bare kinds) resolved in one hop, in the
   *  order asked: `harnesses.getByIdOrKind` for each. */
  "orchestrator.resolveHarnesses": defineOp({
    tx: false,
    run: (ctx, ids: string[]): (Harness | null)[] => ids.map((id) => ctx.modules.harnesses.getByIdOrKind(id)),
  }),

  /**
   * Put a batch of follow-ups in a task's backlog tray, in the given ADD order
   * (`backlog.add` prepends), skipping only a text the tray held before this
   * batch (two identical texts inside the batch are two sends and both kept).
   * Nothing is kept for a task that is gone or archived. The check and the
   * writes are one transaction, so two stashes can't both miss a text.
   * Returns how many were added.
   */
  "orchestrator.stashBatch": defineOp({
    tx: true,
    run: (ctx, taskId: string, textsInAddOrder: string[]): number => {
      const task = ctx.modules.tasks.get(taskId);
      if (!task || task.archivedAt != null || textsInAddOrder.length === 0) return 0;
      const before = new Set(task.backlog.map((item) => item.text));
      let added = 0;
      for (const text of textsInAddOrder) {
        if (before.has(text)) continue;
        ctx.modules.backlog.add(taskId, { text });
        added++;
      }
      return added;
    },
  }),

  /**
   * Put one withheld message back in a task's backlog tray unless the tray
   * already holds that exact text. `"skipped"` for a task that is gone or
   * archived (nothing is kept), else `"saved"` (added, or already there). One
   * transaction, so a repeated withhold can't add it twice.
   */
  "orchestrator.restashText": defineOp({
    tx: true,
    run: (ctx, taskId: string, text: string): "saved" | "skipped" => {
      const task = ctx.modules.tasks.get(taskId);
      if (!task || task.archivedAt != null) return "skipped";
      if (!task.backlog.some((item) => item.text === text)) ctx.modules.backlog.add(taskId, { text });
      return "saved";
    },
  }),

  /**
   * Write a task's fx recovery state only while the stored one is still
   * `expectedJson` (`JSON.stringify` of what the caller decided from, `"null"`
   * for none): a compare-and-set, so an auto-resume firing and a Cancel can't
   * both act on the same schedule. False when the row moved on (or is gone).
   */
  "orchestrator.fxRecoveryCas": defineOp({
    tx: true,
    run: (ctx, taskId: string, expectedJson: string, next: Task["fxRecovery"]): boolean => {
      const task = ctx.modules.tasks.get(taskId);
      if (!task) return false;
      if (JSON.stringify(task.fxRecovery ?? null) !== expectedJson) return false;
      ctx.modules.tasks.setFxRecovery(taskId, next ?? null);
      return true;
    },
  }),

  /**
   * Apply one plan-history change to a task's `plans`, reading and writing in
   * one transaction so a concurrent edit (a PATCH, another chunk) is never
   * overwritten with a stale array. The transforms are the pure ones in
   * `task-plans.ts`. Returns whether the row changed.
   */
  "orchestrator.applyPlanChange": defineOp({
    tx: true,
    run: (ctx, taskId: string, change: PlanChange): boolean => {
      const task = ctx.modules.tasks.get(taskId);
      if (!task) return false;
      const next = change.kind === "exit-plan-mode"
        ? upsertClaudePlanFromExitPlanMode(task.plans, {
          toolCallId: change.toolCallId,
          runId: change.runId,
          content: change.content,
          now: change.now,
        })
        : change.kind === "resolve-claude"
          ? resolveClaudePlan(task.plans, change.toolUseId, change.resultText, change.now)
          : upsertDetectedPlan(task.plans, {
            toolCallId: change.toolCallId,
            runId: change.runId,
            name: change.name,
            content: change.content,
            now: change.now,
          });
      if (next === task.plans) return false;
      ctx.modules.tasks.update(taskId, { plans: next });
      return true;
    },
  }),

  /** Write a task's todo summary only when it differs from the stored one
   *  (by value), in one transaction. Returns whether the row changed. */
  "orchestrator.setTodoProgress": defineOp({
    tx: true,
    run: (ctx, taskId: string, summary: Task["todoProgress"]): boolean => {
      const task = ctx.modules.tasks.get(taskId);
      if (!task) return false;
      const current = task.todoProgress ?? null;
      const next = summary ?? null;
      const changed = next === null
        ? current !== null
        : current === null || current.completed !== next.completed || current.total !== next.total;
      if (changed) ctx.modules.tasks.update(taskId, { todoProgress: next });
      return changed;
    },
  }),

  /** Every run left `running`, newest first (boot reconcile). */
  "orchestrator.runningRuns": defineOp({
    tx: false,
    run: ({ conn }): StaleRunningRun[] =>
      conn.query<StaleRunningRun, []>(
        `SELECT id, task_id, tmux_session, claude_session_id, codex_session_id, cursor_session_id, gemini_session_id, fx_session_id, antigravity_session_id, opencode_session_id, copilot_session_id, agent, started_at FROM runs WHERE status = 'running' ORDER BY started_at DESC, id DESC`,
      ).all(),
  }),

  /**
   * Boot reconcile's orphan write, all or nothing: each run `orphaned` with
   * its status line, its task back to `ready` when it still sits in
   * `running`, and a copilot run's still-running subagent rows settled.
   */
  "orchestrator.orphanRuns": defineOp({
    tx: true,
    run: (ctx, rows: { id: string; task_id: string; copilot: boolean }[], now: number): void => {
      for (const row of rows) {
        ctx.conn.run(`UPDATE runs SET status = 'orphaned', ended_at = ?, exit_code = -1 WHERE id = ?`, [now, row.id]);
        ctx.conn.run(
          `INSERT INTO run_events (run_id, stream, data, ts) VALUES (?, ?, ?, ?)`,
          [row.id, "status", "orphaned — agetor restarted while this run was active", now],
        );
        ctx.conn.run(`UPDATE tasks SET "column" = 'ready', run_id = NULL WHERE id = ? AND "column" = 'running'`, [row.task_id]);
        if (row.copilot) ctx.modules.subagents.settleRunningForRun(row.id, "orphaned", now);
      }
    },
  }),

  /** The newest run of a task, ties broken by id (fx pause lookup). */
  "orchestrator.latestRunById": defineOp({
    tx: false,
    run: ({ conn }, taskId: string): { id: string; status: string; agent: string } | null =>
      conn.query<{ id: string; status: string; agent: string }, [string]>(
        `SELECT id, status, agent FROM runs WHERE task_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`,
      ).get(taskId),
  }),

  /** The agent of the task's newest copilot session recorded on a harness
   *  other than `harnessId`, or null. */
  "orchestrator.copilotSessionAgentElsewhere": defineOp({
    tx: false,
    run: ({ conn }, taskId: string, harnessId: string): string | null =>
      conn.query<{ agent: string }, [string, string]>(
        `SELECT agent FROM runs
         WHERE task_id = ? AND agent != ? AND copilot_session_id IS NOT NULL
         ORDER BY started_at DESC, rowid DESC
         LIMIT 1`,
      ).get(taskId, harnessId)?.agent ?? null,
  }),

  /**
   * Drop a repository from a task (and from every step of a pipeline parent),
   * clearing the issue repository path where it named it, in one transaction.
   */
  "orchestrator.removeRepository": defineOp({
    tx: true,
    run: (ctx, taskId: string, name: string, entryPath: string): void => {
      const task = ctx.modules.tasks.get(taskId);
      if (!task) return;
      const remaining = (task.repositories ?? []).filter((r) => r.name !== name);
      ctx.modules.tasks.setRepositories(taskId, remaining);
      if (task.issueRepoPath != null && task.issueRepoPath === entryPath) {
        ctx.modules.tasks.clearIssueRepoPath(taskId, entryPath);
      }
      if (task.pipelineId == null) return;
      for (const step of ctx.modules.tasks.stepsForParent(taskId)) {
        const stepRepos = step.repositories ?? [];
        if (!isMultiRepoTask(step) || !stepRepos.some((r) => r.name === name)) continue;
        ctx.modules.tasks.setRepositories(step.id, stepRepos.filter((r) => r.name !== name));
        if (step.issueRepoPath != null && step.issueRepoPath === entryPath) {
          ctx.modules.tasks.clearIssueRepoPath(step.id, entryPath);
        }
      }
    },
  }),
};
