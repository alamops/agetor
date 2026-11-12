// The text a task's agent is launched with around its own prompt: the agent
// profile's instructions preamble, then — for a multi-repository task only —
// the `Repositories:` block (issue #291). Shared so every place that budgets a
// launch prompt (the orchestrator's start pre-check, the pipeline runner's
// step composition) measures the exact text `startTaskInner` sends, instead of
// re-assembling the pieces and drifting. Must stay free of runtime imports
// from either process (see refs.ts's header for the same rule).
// See docs/architecture/multi-repo-tasks.md.
import { composeLaunchPrompt } from "./agent-profile.ts";
import { formatRepositoriesPrompt } from "./multi-repo.ts";
import type { AgentProfileSnapshot, TaskRepository } from "./types.ts";

type PromptRepository = Pick<TaskRepository, "name" | "worktreePath" | "path" | "branch">;

/**
 * The `Repositories:` block for a launch, or null when there is none. Only a
 * set of two or more repositories gets one, so a single-repository launch
 * prompt stays byte-identical to the pre-multi format.
 */
export function repositoriesPromptBlock(repos: PromptRepository[] | null | undefined): string | null {
  return repos && repos.length > 1 ? formatRepositoriesPrompt(repos) : null;
}

/**
 * `text` wrapped the way a run launches it, before the references block:
 * the profile preamble (`composeLaunchPrompt`, a passthrough for a null or
 * empty profile), then a blank line and the `Repositories:` block when the
 * task has one.
 */
export function composeRunPrompt(
  profile: Pick<AgentProfileSnapshot, "instructions" | "skills"> | null,
  text: string,
  repos: PromptRepository[] | null | undefined,
): string {
  const composed = composeLaunchPrompt(profile, text);
  const block = repositoriesPromptBlock(repos);
  return block ? `${composed}\n\n${block}` : composed;
}
