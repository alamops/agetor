/** The text-like fields of the agent-profile form — everything except the
 *  harness/mode/model/effort/fast/maxMode block, which `useTaskLaunch` owns
 *  and seeds asynchronously (so it is tracked by interaction, not by value —
 *  see `AgentProfileFormBody`). */
export interface AgentProfileTextDraft {
  name: string;
  instructions: string;
  skills: string[];
}

/** Whether the form's text fields differ from the values it opened with.
 *  Name and instructions compare exactly (no trimming — a stray space is an
 *  edit); skills compare element-wise in order. */
export function agentProfileTextDirty(draft: AgentProfileTextDraft, baseline: AgentProfileTextDraft): boolean {
  if (draft.name !== baseline.name) return true;
  if (draft.instructions !== baseline.instructions) return true;
  if (draft.skills.length !== baseline.skills.length) return true;
  return draft.skills.some((skill, i) => skill !== baseline.skills[i]);
}

export { duplicateAgentName } from "../../shared/duplicate-name.ts";
