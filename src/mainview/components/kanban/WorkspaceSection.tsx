import { type Dispatch, type SetStateAction, useMemo } from "react";
import { LaunchSection, MoreOptions } from "./LaunchSection";
import { WorktreeOptions, type WorktreeOptionsState } from "./WorktreeOptions";
import { projectDisplayName, projectRowLabels, type RepoSelection } from "@/lib/repo-selection";
import { workspaceSummary } from "@/lib/launch-summary";
import type { LaunchSurface } from "@/lib/panel-collapse";

/**
 * The Workspace section of a launch form: Projects, the per-project Branch rows,
 * Isolate, and — behind More options — the Branch name. Collapses to
 * `agetor · current branch · isolated · fix/7c5261`. An invalid branch name
 * behind the closed disclosure turns the row danger-toned ("Branch name is
 * invalid"), and an edited one is announced ("Branch name edited"). Shared by the
 * New Task panel and both Git dialogs (the PR dialog uses the `locked` variant).
 */
type WorkspaceSectionProps = { surface: LaunchSurface } & (
  | {
      state: WorktreeOptionsState;
      repos: RepoSelection[];
      onReposChange: Dispatch<SetStateAction<RepoSelection[]>>;
      lockedPath?: string | null;
      locked?: undefined;
    }
  | {
      /** The PR dialog: its head branch is checked out as-is in its own worktree. */
      locked: { branch: string; projectPath?: string };
      state?: undefined;
      repos?: undefined;
      onReposChange?: undefined;
      lockedPath?: undefined;
    }
);

export function WorkspaceSection(props: WorkspaceSectionProps) {
  const { surface } = props;
  if (props.locked) {
    const locked = props.locked;
    const summary = workspaceSummary({
      projectLabels: locked.projectPath ? [projectDisplayName(locked.projectPath)] : [],
      baseRefs: [locked.branch],
      isolate: true,
      branch: "",
    });
    return (
      <LaunchSection id="workspace" surface={surface} title="Workspace" summary={summary}>
        <WorktreeOptions locked={locked} />
      </LaunchSection>
    );
  }
  return <LiveWorkspaceSection {...props} />;
}

function LiveWorkspaceSection({
  surface,
  state,
  repos,
  onReposChange,
  lockedPath,
}: Extract<WorkspaceSectionProps, { state: WorktreeOptionsState }>) {
  const labels = useMemo(() => projectRowLabels(repos.map((r) => r.path)), [repos]);
  const invalid = state.effectiveIsolate && !state.branchValidation.ok;

  const summary = workspaceSummary({
    projectLabels: labels,
    baseRefs: repos.map((r) => r.baseRef),
    isolate: state.effectiveIsolate,
    branch: state.branchField.displayValue,
  });
  const notes = invalid ? ["Branch name is invalid"] : state.effectiveIsolate && state.branchDirty ? ["Branch name edited"] : [];

  return (
    <LaunchSection
      id="workspace"
      surface={surface}
      title="Workspace"
      summary={invalid ? "Branch name is invalid" : summary}
      tone={invalid ? "danger" : "default"}
    >
      <WorktreeOptions
        state={state}
        repos={repos}
        onReposChange={onReposChange}
        lockedPath={lockedPath}
        renderBranchName={(node) => (
          <MoreOptions surface={surface} section="workspace" notes={notes} tone={invalid ? "danger" : "default"}>
            {node}
          </MoreOptions>
        )}
      />
    </LaunchSection>
  );
}
