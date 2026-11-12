// The text a task's agent is launched with around its own prompt: the agent
// profile's instructions preamble, then — for a multi-repository task only —
// the `Repositories:` block (issue #291). Shared so every place that budgets a
// launch prompt (the orchestrator's start pre-check, the pipeline runner's
// step composition) measures the exact text `startTaskInner` sends, instead of
// re-assembling the pieces and drifting. Must stay free of runtime imports
// from either process (see refs.ts's header for the same rule).
// See docs/architecture/multi-repo-tasks.md.
import { composeLaunchPrompt } from "./agent-profile.ts";
import { formatRepositoriesPrompt, isMultiRepoTask } from "./multi-repo.ts";
import type { AgentProfileSnapshot, TaskRepository } from "./types.ts";

type PromptRepository = Pick<TaskRepository, "name" | "worktreePath" | "path" | "branch">;

/**
 * What the `Repositories:` block is built from: the task's multi decision
 * (`multiRepo`, as `isMultiRepoTask` reads it) and the entries to list — the
 * task's own, or the just-prepared ones carrying their materialized paths.
 */
export interface PromptRepositorySet {
  multiRepo?: boolean;
  repositories?: PromptRepository[] | null;
}

/**
 * The `Repositories:` block for a launch, or null when there is none. Only a
 * multi-repository task gets one — including a one-repository multi task left
 * by a removal, whose cwd is still the non-git workspace root — so a
 * single-repository launch prompt stays byte-identical to the pre-multi
 * format. The decision comes from the task, never from the entry count.
 */
export function repositoriesPromptBlock(set: PromptRepositorySet | null | undefined): string | null {
  if (!set) return null;
  const repos = set.repositories ?? [];
  if (repos.length === 0) return null;
  return isMultiRepoTask({ multiRepo: set.multiRepo, repositories: repos }) ? formatRepositoriesPrompt(repos) : null;
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
  set: PromptRepositorySet | null | undefined,
): string {
  const composed = composeLaunchPrompt(profile, text);
  const block = repositoriesPromptBlock(set);
  return block ? `${composed}\n\n${block}` : composed;
}
