/** The text-like fields of the agent-profile form — everything except the
 *  harness/mode/model/effort/speed/maxMode/opencodeServer block, which `useTaskLaunch` owns
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

/**
 * The launch-block setters a user pick goes through, each paired with the
 * value it changes. A call counts as a form interaction only when it would
 * change that value — `useTaskLaunch`'s own seed/reset effects call the
 * hook's internal setters, never these wrapped ones, so an untouched form
 * stays clean.
 */
export const LAUNCH_INTERACTION_SETTERS = {
  switchAgent: "agent",
  setMode: "mode",
  setModel: "model",
  setEffort: "effort",
  setSpeed: "speed",
  setMaxMode: "maxMode",
  setOpencodeServer: "opencodeServer",
} as const;

type LaunchSetterName = keyof typeof LAUNCH_INTERACTION_SETTERS;
type LaunchValueName = (typeof LAUNCH_INTERACTION_SETTERS)[LaunchSetterName];

/** The slice of a `TaskLaunch` the interaction tracker reads and wraps. */
export type LaunchInteractionTarget = {
  [K in LaunchValueName]: unknown;
} & {
  [K in LaunchSetterName]: (value: never) => void;
};

/**
 * A copy of `launch` whose {@link LAUNCH_INTERACTION_SETTERS} call
 * `onTouch()` before forwarding whenever the new value differs from the
 * current one (`Object.is`). Every other field passes through untouched.
 * This is the agent-profile form's dirtiness rule for its launch block —
 * an interaction flag, never a value diff (see `AgentProfileFormBody`).
 */
export function trackLaunchInteractions<L extends LaunchInteractionTarget>(launch: L, onTouch: () => void): L {
  const tracked: L = { ...launch };
  for (const setter of Object.keys(LAUNCH_INTERACTION_SETTERS) as LaunchSetterName[]) {
    const field = LAUNCH_INTERACTION_SETTERS[setter];
    const forward = launch[setter] as (value: unknown) => void;
    (tracked as Record<LaunchSetterName, (value: unknown) => void>)[setter] = (value: unknown) => {
      if (!Object.is(value, launch[field])) onTouch();
      forward(value);
    };
  }
  return tracked;
}

export { duplicateAgentName } from "../../shared/duplicate-name.ts";
