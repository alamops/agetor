/**
 * The pending-interaction builders behind `GET /tasks/:id/interactions/pending` and `GET /interactions/pending`.
 * One module, so the per-task route and the cross-task inbox cannot disagree about what a card is
 * (docs/specs/remote-readiness-spec.md "One needs-you query").
 */

import type { InboxCard, InboxGate, PendingInbox } from "../shared/interactions-inbox.ts";
import { pendingHumanSteps } from "../shared/pipeline.ts";
import { tasks } from "./db-async.ts";
import { listPendingForTask, pendingCountsByTask, type AnyRequest } from "./interactions.ts";

/**
 * The pending cards for one task. A pipeline PARENT never has interactions registered against its own (hidden,
 * agent-less) id: they live on its step tasks, whose counts the board already folds into the parent's. Union the steps'
 * requests here too, so the id the board shows as "waiting on you" is the id whose list carries the cards to answer.
 * (Moved verbatim out of server.ts; the per-task route's output is unchanged.)
 */
export async function pendingCardsForTask(id: string): Promise<AnyRequest[]> {
  let pending = listPendingForTask(id);
  const task = await tasks.get(id);
  if (task?.pipelineId) {
    for (const step of await tasks.stepsForParent(id)) pending = pending.concat(listPendingForTask(step.id));
    pending.sort((a, b) => a.createdAt - b.createdAt);
  }
  return pending;
}

/**
 * Every pending card across tasks, each tagged with the board card it belongs to, oldest first. A step's card names its
 * parent on the request itself (stamped when it registered); a card registered before its parent was noted falls back to the
 * step's own row, so the fold never depends on registration order.
 */
export async function pendingCardsAcrossTasks(): Promise<Array<InboxCard<AnyRequest>>> {
  const out: Array<InboxCard<AnyRequest>> = [];
  for (const taskId of pendingCountsByTask().keys()) {
    let rowParent: string | null | undefined;
    for (const req of listPendingForTask(taskId)) {
      let parent = req.pipelineParentId;
      if (!parent) {
        if (rowParent === undefined) rowParent = (await tasks.get(taskId))?.pipelineParentId ?? null;
        parent = rowParent ?? undefined;
      }
      out.push({ ...req, parentTaskId: parent ?? req.taskId });
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** Every pipeline gate waiting for a human, across the non-archived pipeline parents, oldest first. */
export async function pendingGatesAcrossTasks(): Promise<InboxGate[]> {
  const gates: InboxGate[] = [];
  for (const task of await tasks.list({ archived: "exclude" })) {
    for (const g of pendingHumanSteps(task.pipelineRun)) {
      gates.push({ taskId: task.id, taskTitle: task.title, stepId: g.stepId, seq: g.seq, startedAt: g.startedAt, arrivals: g.arrivals });
    }
  }
  return gates.sort((a, b) => a.startedAt - b.startedAt || a.seq - b.seq);
}

export async function buildPendingInbox(): Promise<PendingInbox<AnyRequest>> {
  return { cards: await pendingCardsAcrossTasks(), gates: await pendingGatesAcrossTasks() };
}
