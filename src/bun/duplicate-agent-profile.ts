import type { AgentProfile, Task } from "../shared/types.ts";
import { agentProfiles, tasks, type AgentProfileInsertInput } from "./db.ts";
import { createTask } from "./orchestrator.ts";

export interface DuplicateAgentProfileResult {
  profile: AgentProfile;
  copiedTasks: Task[];
  taskCopyErrors: { sourceTaskId: string; error: string }[];
}

/** Insert a copy of profile `sourceId` from an already-validated payload and,
 *  when `copyTasks`, re-create the source's live (non-archived, non-pipeline)
 *  tasks bound to the new profile. A task that fails to copy is reported in
 *  `taskCopyErrors`; the profile and earlier copies are kept.
 *  `AgentProfileNameError` propagates. See docs/plans/duplicate-agent-leftovers.md. */
export async function duplicateAgentProfile(
  sourceId: string,
  payload: AgentProfileInsertInput,
  copyTasks: boolean,
): Promise<DuplicateAgentProfileResult | { notFound: true }> {
  const source = agentProfiles.get(sourceId);
  if (!source) return { notFound: true };

  const profile = agentProfiles.insert(payload);
  const copiedTasks: Task[] = [];
  const taskCopyErrors: { sourceTaskId: string; error: string }[] = [];
  if (!copyTasks) return { profile, copiedTasks, taskCopyErrors };

  const eligible = tasks
    .list()
    .filter((t) => t.agentProfileId === source.id && !t.archivedAt && !t.pipelineId && !t.pipelineParentId)
    .sort((a, b) => a.createdAt - b.createdAt);

  for (const t of eligible) {
    // A task checked out on a branch that already exists (a PR head, for
    // example) does not start from `baseRef`. Copying it without that branch
    // would cut a fresh `agetor/…` branch from the pinned sha instead.
    // `createTask` also refuses a second checkout of the same branch, so
    // leave the original in place and say so.
    if (t.branchSource === "existing") {
      taskCopyErrors.push({
        sourceTaskId: t.id,
        error: "task works on an existing branch — not copied",
      });
      continue;
    }
    try {
      const res = await createTask({
        title: t.title,
        prompt: t.prompt,
        workdir: t.workdir,
        isolation: t.isolation,
        ...(t.baseRef ? { baseRef: t.baseRef } : {}),
        references: t.references,
        taskType: t.taskType,
        agentProfileId: profile.id,
      });
      if ("error" in res) taskCopyErrors.push({ sourceTaskId: t.id, error: res.error });
      else copiedTasks.push(res.task);
    } catch (e) {
      taskCopyErrors.push({ sourceTaskId: t.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { profile, copiedTasks, taskCopyErrors };
}
