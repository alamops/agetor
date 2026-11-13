import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";
import { GitBranch, SlidersHorizontal } from "lucide-react";
import { api, type BranchNamingConfig } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { IDENTIFIER_INPUT_PROPS } from "@/lib/identifier-input";
import { branchFieldState, type BranchFieldState } from "@/lib/branch-field";
import {
  projectDisplayName,
  projectRowLabels,
  projectSelectionLabel,
  selectionNames,
  type RepoSelection,
} from "@/lib/repo-selection";
import {
  DEFAULT_BRANCH_CONFIG,
  branchPattern,
  hasBranchTemplateTags,
  validateBranchName,
  type TaskType,
} from "../../../shared/types.ts";
import { BranchNamingDialog } from "@/components/settings/BranchNamingDialog";
import { BranchPicker } from "./BranchPicker";
import { SelectProjectsButton } from "./ProjectSelection";
import { SelectProjectsDialog } from "./SelectProjectsDialog";

/**
 * The shared worktree block: the full-width **Select Projects** control, one
 * inline `Branch · <project>` row (picker + Pull + Fetch) per selected
 * project, the "Isolate (worktree)" checkbox, and — while isolated — the
 * shared editable branch-name field with its settings gear and
 * `BranchNamingDialog`.
 *
 * One control serves one project and many: the old split (a single project
 * trigger plus a separate multi-repository dialog, with a different branch UI
 * per mode) is gone. Selection lives in `repos` (owned by
 * `useProjectSelection` in the forms); every per-project base ref rides that
 * same entry. With 2+ projects isolation is forced: the checkbox is checked
 * and disabled, and `effectiveIsolate` (not the raw toggle) drives the
 * branch-name field, `valid` and the create payload.
 *
 * The branch-name field follows the clean/dirty model documented in
 * `src/mainview/lib/branch-field.ts`. `src/mainview/lib/worktree-payload.ts`'s
 * `selectionPayload` is the single source of truth for turning the selection +
 * this state into the `workdir` / `isolation` / `baseRef` / `branch` /
 * `repositories` fields of a task-create payload — every consumer spreads its
 * result rather than re-deriving the mapping.
 */

/** Short unique token seeding the `<slug>`/`<token>` fallback in the
 *  preview. Always exactly 6 hex chars, mirroring the server's
 *  task-id-derived token, so the client-side validation can't reject a name
 *  the server would accept. */
const newBranchToken = () => crypto.randomUUID().replace(/-/g, "").slice(0, 6);

export interface WorktreeOptionsState {
  /** The raw user toggle. Read the checkbox's `checked` from
   *  {@link effectiveIsolate}, never this. */
  isolate: boolean;
  setIsolate: Dispatch<SetStateAction<boolean>>;
  /** True for a 2+ (deduped) project selection: isolation is required and the
   *  checkbox is disabled. */
  forceIsolate: boolean;
  /** `forceIsolate || isolate` — the one derived state that drives the
   *  checkbox, branch-name visibility, `valid` and the payload. Using one
   *  derivation (rather than an effect that flips the raw toggle) means no
   *  render can show a value the create path ignores. */
  effectiveIsolate: boolean;
  branchConfig: BranchNamingConfig;
  branchOverride: string;
  setBranchOverride: Dispatch<SetStateAction<string>>;
  branchDirty: boolean;
  setBranchDirty: Dispatch<SetStateAction<boolean>>;
  branchToken: string;
  branchSettingsOpen: boolean;
  setBranchSettingsOpen: Dispatch<SetStateAction<boolean>>;
  branchField: BranchFieldState;
  branchValidation: { ok: true } | { ok: false; reason: string };
  /** `!effectiveIsolate || branchValidation.ok` — the worktree half of
   *  `canSubmit`. */
  valid: boolean;
  /** Post-submit reset: re-derive the branch field from the (now empty)
   *  title and get a fresh unique token; drop any manual override. The project
   *  selection and its per-project refs deliberately survive. */
  resetAfterSubmit: () => void;
  /** Fresh-open reset: `resetAfterSubmit()` plus re-arming `isolate` to its
   *  default (`true`). Dialogs (`CreateTaskFromIssueDialog`,
   *  `ResolveConflictsDialog`) call this on open so an isolate toggle a user
   *  unchecked and then cancelled out of doesn't silently carry into the
   *  next issue/PR. `NewTaskForm` deliberately keeps `isolate` sticky across
   *  submits (a rapid-fire multi-task workflow) and uses `resetAfterSubmit`
   *  instead. */
  resetForOpen: () => void;
  onBranchConfigSaved: Dispatch<SetStateAction<BranchNamingConfig>>;
  /** Echoed back from the hook's own inputs — the component needs it for the
   *  branch-name field's settings gear and its `BranchNamingDialog`. */
  workdir: string;
  taskType: TaskType;
}

/**
 * Owns the state/effects/derivations behind the worktree block: the isolate
 * toggle (plus the forced state for 2+ projects), the per-project branch-naming
 * config fetch, and the clean/dirty branch-name field. The selection and every
 * base ref are owned by `useProjectSelection` — this hook never sees them.
 */
export function useWorktreeOptions({
  workdir,
  title,
  taskType,
  enabled = true,
  forceIsolate = false,
}: {
  workdir: string;
  title: string;
  taskType: TaskType;
  enabled?: boolean;
  forceIsolate?: boolean;
}): WorktreeOptionsState {
  const [isolate, setIsolate] = useState(true);
  // Branch nomenclature for the first selected project (loaded from the
  // server; falls back to the built-in defaults — the server anchors a
  // multi-repository task's shared name on its first kept repository, so the
  // preview matches what will actually be created). While clean
  // (`!branchDirty`), the field DERIVES its display from the tag-visible
  // PATTERN (e.g. `feature/<slug>`) rendered live against the current
  // title/type/config — realtime by construction, no seeding effect required.
  // Once the user edits it (`branchDirty`), `branchOverride` holds their
  // literal text, sent to the server verbatim — tags and all, the server
  // resolves them authoritatively at create time. `branchToken` seeds the
  // client-side preview/validation fallback.
  const [branchConfig, setBranchConfig] = useState<BranchNamingConfig>(DEFAULT_BRANCH_CONFIG);
  const [branchOverride, setBranchOverride] = useState("");
  const [branchDirty, setBranchDirty] = useState(false);
  const [branchToken, setBranchToken] = useState(newBranchToken);
  const [branchSettingsOpen, setBranchSettingsOpen] = useState(false);

  // Keep the raw toggle sticky at true once isolation is forced, so collapsing
  // back to one project leaves it checked (the owner's decision) rather than
  // silently unchecking the task's layout. One contained effect — every
  // read path above still uses the derived `effectiveIsolate`.
  useEffect(() => {
    if (forceIsolate) setIsolate(true);
  }, [forceIsolate]);

  const effectiveIsolate = forceIsolate || isolate;

  // Load the selected project's branch nomenclature. Empty workdir → defaults.
  // `enabled` (default true) lets a caller mounted unconditionally but not
  // yet open — e.g. `CreateTaskFromIssueDialog`, which `IssueActions` renders
  // regardless of dialog visibility — skip the fetch entirely until it does.
  useEffect(() => {
    const dir = workdir.trim();
    if (!enabled || !dir) { setBranchConfig(DEFAULT_BRANCH_CONFIG); return; }
    let cancelled = false;
    api.getProjectBranchConfig(dir)
      .then((c) => { if (!cancelled) setBranchConfig(c); })
      .catch(() => { if (!cancelled) setBranchConfig(DEFAULT_BRANCH_CONFIG); });
    return () => { cancelled = true; };
  }, [workdir, enabled]);

  // The tag-visible pattern for the current config + type, e.g. `feature/<slug>`.
  // Deliberately stable while the title is typed — only config/taskType move
  // it — so the field never rewrites itself into a jarring live value.
  const computedPattern = useMemo(
    () => branchPattern(branchConfig, taskType),
    [branchConfig, taskType],
  );

  // Last path segment of the workdir, used as `<project_name>` in the live
  // preview — mirrors the server's own resolution so the preview matches what
  // will actually be created.
  const projectName = useMemo(() => {
    const parts = workdir.trim().split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "";
  }, [workdir]);

  // Derived clean/dirty projection of the branch field — see
  // `src/mainview/lib/branch-field.ts`. Clean: `displayValue`/`resolved`
  // live-render the pattern each render (realtime as title/type/config
  // change), and `submitValue` is the raw un-rendered pattern so the server
  // stays the authoritative resolver. Dirty: the user's literal text wins.
  const branchField = useMemo(
    () => branchFieldState({
      dirty: branchDirty,
      override: branchOverride,
      pattern: computedPattern,
      title,
      projectName,
      taskType,
      token: branchToken,
    }),
    [branchDirty, branchOverride, computedPattern, title, projectName, taskType, branchToken],
  );

  // Validation gates on the RESOLVED name (a template like `feature/<slug>` is
  // always git-legal since `<`/`>` are allowed in ref names, but we want the
  // error — and canSubmit — to reflect what will actually be created).
  const branchValidation = useMemo(
    () => validateBranchName(branchField.resolved.trim()),
    [branchField.resolved],
  );

  const valid = !effectiveIsolate || branchValidation.ok;

  const resetAfterSubmit = () => {
    // Reset the branch field so the next task re-derives from its (now empty)
    // title and gets a fresh unique token; drop any manual override. The
    // project selection and every per-project ref stay for the next task.
    setBranchDirty(false);
    setBranchToken(newBranchToken());
  };

  const resetForOpen = () => {
    resetAfterSubmit();
    setIsolate(true);
  };

  return {
    isolate,
    setIsolate,
    forceIsolate,
    effectiveIsolate,
    branchConfig,
    branchOverride,
    setBranchOverride,
    branchDirty,
    setBranchDirty,
    branchToken,
    branchSettingsOpen,
    setBranchSettingsOpen,
    branchField,
    branchValidation,
    valid,
    resetAfterSubmit,
    resetForOpen,
    onBranchConfigSaved: setBranchConfig,
    workdir,
    taskType,
  };
}

const isolateTitle =
  "Runs the agent on a dedicated branch off the chosen base, so parallel tasks "
  + "on the same repo don't collide. No-op when the workdir isn't a git repo.";

const forcedIsolateTitle =
  "Two or more projects always use worktree isolation: each project gets its own worktree and branch.";

const baseRefTitle =
  "Base ref the worktree branches from. Pick the current branch row to use what's checked out at task start.";

const baseRefOffTitle =
  "Isolation is off — the value is recorded but the agent will run directly in the project workdir.";

type Props =
  | {
      state: WorktreeOptionsState;
      /** The selected projects (its first entry is the primary). */
      repos: RepoSelection[];
      onReposChange: Dispatch<SetStateAction<RepoSelection[]>>;
      /** A user-picked base ref for one project. */
      onBaseRefChange: (path: string, baseRef: string) => void;
      /** `BranchPicker`'s automatic "preselect the current branch" seed. */
      onBaseRefAuto: (path: string, baseRef: string) => void;
      /** A project that must stay selected (the issue dialog's own repo). */
      lockedPath?: string | null;
    }
  | { locked: { branch: string; projectPath?: string } };

/**
 * Renders the worktree block. Live variant (`{ state, repos, … }`): Select
 * Projects → one Branch row per project → Isolate → (while isolated) the
 * branch-name field + `BranchNamingDialog`. Locked variant (`{ locked }`): the
 * PR-conflicts modal, where the PR's head branch is checked out as-is in its
 * own worktree — a disabled Select Projects control showing the PR's repo, a
 * read-only branch row, and a checked/disabled isolate checkbox.
 */
export function WorktreeOptions(props: Props) {
  if ("locked" in props) {
    const { branch, projectPath } = props.locked;
    return (
      <div data-testid="worktree-options-locked" className="space-y-3">
        <SelectProjectsButton
          label={projectPath ? projectDisplayName(projectPath) : "Project"}
          onClick={() => {}}
          locked
        />

        <div className="min-w-0 space-y-1">
          <label className="text-muted-foreground">Branch</label>
          <Input
            data-testid="locked-branch"
            readOnly
            value={branch}
            className="font-mono text-[11px]"
          />
          <p className="text-[10px] text-muted-foreground">PR head branch — checked out as-is.</p>
        </div>

        <label
          className="flex cursor-default items-center gap-1.5 opacity-80"
          title="Always isolated — the PR's head branch is checked out in its own worktree, so your checkout stays clean."
        >
          <input type="checkbox" checked disabled data-testid="isolate-toggle" />
          <GitBranch className="size-3" />
          <span>Isolate (worktree)</span>
        </label>
      </div>
    );
  }

  return <LiveWorktreeOptions {...props} />;
}

function LiveWorktreeOptions({
  state,
  repos,
  onReposChange,
  onBaseRefChange,
  onBaseRefAuto,
  lockedPath,
}: Extract<Props, { state: WorktreeOptionsState }>) {
  const [selectOpen, setSelectOpen] = useState(false);
  const {
    setIsolate,
    forceIsolate,
    effectiveIsolate,
    workdir,
    taskType,
    branchOverride,
    setBranchOverride,
    branchDirty,
    setBranchDirty,
    branchSettingsOpen,
    setBranchSettingsOpen,
    branchField,
    branchValidation,
    onBranchConfigSaved,
  } = state;

  // Workspace names, in order — the same slugs the server uses. They key the
  // rows' test ids (stable, sanitized, unique) but are NOT user-facing: the
  // label is the project's own name, with the full path appended when two
  // selected projects share a basename (grill decision 11), so the user can
  // tell which repository a row belongs to.
  const names = useMemo(() => selectionNames(repos), [repos]);
  const labels = useMemo(() => projectRowLabels(repos.map((repo) => repo.path)), [repos]);

  return (
    <div data-testid="worktree-options" className="space-y-3">
      <SelectProjectsButton label={projectSelectionLabel(repos)} onClick={() => setSelectOpen(true)} />
      <SelectProjectsDialog
        open={selectOpen}
        onClose={() => setSelectOpen(false)}
        value={repos}
        onSave={onReposChange}
        lockedPath={lockedPath}
      />

      {repos.length === 0 ? (
        <p data-testid="select-projects-empty" className="text-[11px] text-muted-foreground">
          Select a project to choose its branch and worktree options.
        </p>
      ) : (
        <div className="space-y-2">
          {repos.map((repo, i) => (
            <div key={repo.path} data-testid={`branch-row-${names[i]}`}>
              <BranchPicker
                label={`Branch · ${labels[i]}`}
                workdir={repo.path}
                value={repo.baseRef ?? ""}
                onChange={(next) => onBaseRefChange(repo.path, next)}
                onAutoSelect={(next) => onBaseRefAuto(repo.path, next)}
                placement="bottom"
                title={effectiveIsolate ? baseRefTitle : baseRefOffTitle}
              />
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1">
        <label
          className={cn("flex items-center gap-1.5", forceIsolate ? "cursor-default" : "cursor-pointer")}
          title={forceIsolate ? forcedIsolateTitle : isolateTitle}
        >
          <input
            type="checkbox"
            checked={effectiveIsolate}
            disabled={forceIsolate}
            onChange={(e) => setIsolate(e.target.checked)}
            data-testid="isolate-toggle"
          />
          <GitBranch className="size-3" />
          <span>Isolate (worktree)</span>
        </label>
        {forceIsolate ? (
          <p className="pl-5 text-[10px] text-muted-foreground">
            Always on when more than one project is selected.
          </p>
        ) : null}
      </div>

      {effectiveIsolate && (
        <div className="space-y-1">
          <label className="text-muted-foreground">Branch name</label>
          <div className="relative">
            <Input
              data-testid="branch-name-input"
              {...IDENTIFIER_INPUT_PROPS}
              value={branchField.displayValue}
              onChange={(e) => { setBranchOverride(e.target.value); setBranchDirty(true); }}
              placeholder="feature/my-task"
              className={cn(
                "pr-9 font-mono text-[11px]",
                !branchValidation.ok && "border-destructive focus-visible:ring-destructive",
              )}
              title="Git branch the worktree will use. Live-resolved from this project's nomenclature (title, type, project name); edit to override, or use the settings button to change the pattern."
            />
            <button
              type="button"
              onClick={() => setBranchSettingsOpen(true)}
              disabled={!workdir.trim()}
              title="Branch naming settings for this project"
              aria-label="Configure branch naming"
              className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            >
              <SlidersHorizontal className="size-3.5" />
            </button>
          </div>
          {!branchValidation.ok ? (
            <p className="text-[10px] text-destructive">{branchValidation.reason}</p>
          ) : branchDirty && hasBranchTemplateTags(branchOverride) ? (
            <p
              className="text-[10px] font-mono text-muted-foreground truncate"
              title={branchField.resolved}
            >
              → {branchField.resolved}
            </p>
          ) : null}
          {branchDirty && (
            <button
              type="button"
              onClick={() => setBranchDirty(false)}
              className="text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Reset to pattern
            </button>
          )}
          {repos.length > 1 ? (
            <p className="text-[10px] text-muted-foreground">
              This name is used in every project, with a `-N` fallback where it is already taken.
            </p>
          ) : null}
        </div>
      )}

      <BranchNamingDialog
        open={branchSettingsOpen}
        projectPath={workdir.trim()}
        activeTaskType={taskType}
        onClose={() => setBranchSettingsOpen(false)}
        onSaved={onBranchConfigSaved}
      />
    </div>
  );
}
