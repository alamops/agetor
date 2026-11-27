/**
 * Whether approving a plan switches the task from Plan to Auto (force) before the approval goes out.
 *
 * Plan mode is read-only, so an approved plan could never be implemented in it: a Plan-mode task that no agent profile owns is switched
 * to Auto. A profile-bound task keeps Plan, because its mode belongs to the profile (PATCH 409s it).
 *
 * One definition for both sides of the rule: the approve route in `server.ts` acts on it, and the phone router (`remote/router.ts`)
 * classifies the call by it, because a flip raises the task's autonomy and so needs the operate level, a signature and the unlock window.
 * A copy in either place would let the two drift.
 */
export function planApprovalFlipsToAuto(task: { mode?: string | null; agentProfileId?: string | null }): boolean {
  return task.mode === "plan" && task.agentProfileId === null;
}
