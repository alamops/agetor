import { GitBranch, GitFork } from "lucide-react";
import { abbreviateHome } from "@/lib/utils";
import { driftOf, driftTitle } from "@/lib/branch-drift";
import { repositoryCountLabel } from "@/lib/multi-repo-ui";
import type { Task } from "../../../shared/types.ts";
import { isMultiRepoTask } from "../../../shared/multi-repo.ts";
import { CardChip } from "./CardChip";

/** Last path segment of a working directory: the repo's name on the card. */
function repoNameOf(workdir: string): string {
  const trimmed = workdir.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || workdir;
}

/**
 * The repo and branch line: `repo · branch`, with the full path, branch and
 * base in the tooltip. Both texts truncate; the drift chip is the only fixed
 * element and wraps to its own line when the row is full. A multi-repository
 * task shows its repository count and names instead (the workspace root is not
 * a repository).
 */
export function TaskCardMeta({ task, homeDir }: { task: Task; homeDir: string }) {
  if (isMultiRepoTask(task)) {
    const repos = task.repositories ?? [];
    return (
      <div
        data-part="meta"
        className="flex min-w-0 items-center gap-1 font-mono text-[10px] text-muted-foreground"
        data-testid="task-card-repositories"
        title={repos.map((r) => `${r.name}: ${r.worktreePath ?? r.path}`).join("\n")}
      >
        <GitFork className="size-3 shrink-0" aria-hidden />
        <span className="shrink-0 font-medium">{repositoryCountLabel(repos.length)}</span>
        <span className="min-w-0 truncate">· {repos.map((r) => r.name).join(", ")}</span>
      </div>
    );
  }

  // Last-seen worktree checkout (server-recorded; no git spawn on the 2 s
  // poll) vs the branch agetor created. Drift is tolerated — just shown.
  const drift = driftOf(task.branch ?? null, task.checkoutBranch);
  const hasBranch = Boolean(task.branch || task.baseRef);
  const branch = task.checkoutBranch ?? task.branch ?? "(not yet created)";
  const tooltip = [
    abbreviateHome(task.workdir, homeDir),
    hasBranch ? branch : null,
    task.baseRef ? `base ${task.baseRef.slice(0, 7)}` : null,
  ].filter(Boolean).join("\n");
  return (
    <div data-part="meta" className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 font-mono text-[10px] text-muted-foreground" title={tooltip}>
      <span className="flex min-w-[10rem] flex-1 basis-0 items-center gap-1">
        <GitBranch className="size-3 shrink-0" aria-hidden />
        <span className="max-w-[45%] shrink-0 truncate">{repoNameOf(task.workdir)}</span>
        {hasBranch && (
          <>
            <span className="shrink-0" aria-hidden="true">·</span>
            <span className="min-w-0 flex-1 truncate">{branch}</span>
          </>
        )}
      </span>
      {drift.drifted && (
        <CardChip
          tone={task.branchSource === "existing" ? "warning" : "info"}
          className="shrink-0 font-sans"
          data-testid="task-card-branch-drift"
          title={driftTitle(task.branch)}
        >
          {task.branchSource === "existing" ? "not on PR head" : "drifted"}
        </CardChip>
      )}
    </div>
  );
}
