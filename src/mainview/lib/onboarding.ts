import type { ColumnId, HarnessStatus, Task } from "../../shared/types.ts";

/**
 * Preference key (see `preferences` table / `GET|PUT /preferences/:key`)
 * that persists whether the user has dismissed first-run onboarding.
 * `"true"` = dismissed, `"false"` = explicitly replayed, absent = never
 * evaluated. Server-side, cross-session, no migration needed (string KV).
 */
export const ONBOARDING_DISMISSED_PREF = "onboardingDismissed";

export type OnboardingStepId = "harness" | "project" | "task" | "run";

export interface OnboardingStep {
  id: OnboardingStepId;
  done: boolean;
}

/** Task columns that count as "the run step is done" — anything that has left backlog/ready. */
const RUN_DONE_COLUMNS: ReadonlySet<ColumnId> = new Set(["running", "review", "done", "blocked"]);

/**
 * Pure derivation of the 4 onboarding steps from live app state. Always
 * returns all 4 steps in the fixed order harness, project, task, run —
 * callers render them positionally, so the order is load-bearing.
 */
export function deriveOnboardingSteps(input: {
  statuses: HarnessStatus[];
  enabledHarnessIds: Set<string> | null;
  projectCount: number;
  tasks: Pick<Task, "column">[];
}): OnboardingStep[] {
  const { statuses, enabledHarnessIds, projectCount, tasks } = input;

  const harnessDone = statuses.some(
    (status) =>
      status.available === true &&
      (enabledHarnessIds === null || enabledHarnessIds.has(status.harnessId)),
  );
  const projectDone = projectCount > 0;
  const taskDone = tasks.length > 0;
  const runDone = tasks.some((task) => RUN_DONE_COLUMNS.has(task.column));

  return [
    { id: "harness", done: harnessDone },
    { id: "project", done: projectDone },
    { id: "task", done: taskDone },
    { id: "run", done: runDone },
  ];
}

export interface OnboardingVisibility {
  showWelcome: boolean;
  showChecklist: boolean;
  autoDismiss: boolean;
}

/**
 * Pure derivation of what onboarding UI (if any) should be visible.
 *
 * Everything is false until `loaded` is true (prefs haven't been fetched
 * yet — don't flash onboarding before we know the real dismissal state).
 *
 * `autoDismiss` is the existing-user upgrade path: when the pref has never
 * been set AND every step already derives as done, the caller should write
 * the pref once (so onboarding never appears for users who already have a
 * fully set-up board) — this function only signals that it should happen,
 * it doesn't perform the write itself (pure module, no side effects).
 *
 * `showWelcome` only ever appears for a truly fresh user: the checklist is
 * visible, there are zero tasks, the welcome dialog hasn't been acknowledged
 * this session, and the pref has never been set at all. A replay (pref
 * explicitly `"false"`) shows the checklist but skips the welcome dialog —
 * the user has already seen the intro once.
 *
 * Replay forces the checklist visible even when every step already derives
 * as done — the whole point of replaying is to look at it again, so "all
 * done" must not make it a no-op. Dismissing again (pref back to `"true"`)
 * hides it as usual.
 */
export function resolveOnboardingVisibility(input: {
  dismissedPref: string | undefined;
  loaded: boolean;
  steps: OnboardingStep[];
  taskCount: number;
  welcomeAcknowledged: boolean;
}): OnboardingVisibility {
  const { dismissedPref, loaded, steps, taskCount, welcomeAcknowledged } = input;

  if (!loaded) {
    return { showWelcome: false, showChecklist: false, autoDismiss: false };
  }

  const dismissed = dismissedPref === "true";
  const replaying = dismissedPref === "false";
  const allDone = steps.every((step) => step.done);
  const prefUnset = dismissedPref === undefined;

  const autoDismiss = prefUnset && allDone;
  const showChecklist = loaded && (replaying || (!dismissed && !allDone));
  const showWelcome = showChecklist && taskCount === 0 && !welcomeAcknowledged && prefUnset;

  return { showWelcome, showChecklist, autoDismiss };
}
