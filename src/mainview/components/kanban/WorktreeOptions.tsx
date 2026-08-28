import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";
import { GitBranch, SlidersHorizontal } from "lucide-react";
import { api, type BranchNamingConfig } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { branchFieldState, type BranchFieldState } from "@/lib/branch-field";
import { worktreePayload, type WorktreePayload } from "@/lib/worktree-payload";
import {
  DEFAULT_BRANCH_CONFIG,
  branchPattern,
  hasBranchTemplateTags,
  validateBranchName,
  type TaskType,
} from "../../../shared/types.ts";
import { BranchNamingDialog } from "@/components/settings/BranchNamingDialog";
import { BranchPicker } from "./BranchPicker";

/**
 * The shared worktree row: the Branch (base ref) picker, the "Isolate
 * (worktree)" checkbox, and — while isolated — the editable branch-name
 * field with its settings gear and `BranchNamingDialog`. Lifted verbatim out
 * of `NewTaskForm.tsx` (its original home) so it can be reused by
 * `CreateTaskFromIssueDialog` (same live behavior) and by
 * `ResolveConflictsDialog` (a read-only `locked` variant — a PR's head
 * branch is always checked out as-is, in its own worktree). `NewTaskForm`
 * itself migrates onto this module in a later change; until then this file
 * must not drift from its behavior.
 *
 * The branch-name field follows the clean/dirty model documented in
 * `src/mainview/lib/branch-field.ts`: while clean, it live-renders this
 * project's branch-naming pattern against the current title/type/config on
 * every render; once the user edits it, their literal text wins and is sent
 * to the server verbatim. `src/mainview/lib/worktree-payload.ts`'s
 * `worktreePayload` is the single source of truth for turning this state
 * into the `isolation` / `baseRef` / `branch` fields of a task-create
 * payload — every consumer of this component reads that mapping from
 * `WorktreeOptionsState.payload()` rather than re-deriving it.
 */

/** Short unique token seeding the `<slug>`/`<token>` fallback in the
 *  preview. Always exactly 6 hex chars, mirroring the server's
 *  task-id-derived token, so the client-side validation can't reject a name
 *  the server would accept. */
const newBranchToken = () => crypto.randomUUID().replace(/-/g, "").slice(0, 6);

export interface WorktreeOptionsState {
  isolate: boolean;
  setIsolate: Dispatch<SetStateAction<boolean>>;
  baseRef: string;
  setBaseRef: Dispatch<SetStateAction<string>>;
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
  /** `!isolate || branchValidation.ok` — the worktree half of `canSubmit`. */
  valid: boolean;
  /** The `isolation`/`baseRef`/`branch` fields of a task-create payload. */
  payload: () => WorktreePayload;
  /** ProjectPicker's onChange handler calls this: the previously-picked base
   *  ref likely doesn't exist on the newly-picked project, so drop back to
   *  HEAD. */
  resetBaseRef: () => void;
  /** Post-submit reset: re-derive the branch field from the (now empty)
   *  title and get a fresh unique token; drop any manual override. */
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
  /** Echoed back from the hook's own inputs — the component needs both for
   *  the branch-name field's settings gear and its `BranchNamingDialog`. */
  workdir: string;
  taskType: TaskType;
}

/**
 * Owns all state/effects/derivations behind the worktree row: the isolate
 * toggle, the base-ref picker's value, the per-project branch-naming config
 * fetch, and the clean/dirty branch-name field. Mirrors `TaskLaunchPickers`'s
 * `useTaskLaunch` house style — state hook + component + helper in one file.
 */
export function useWorktreeOptions({ workdir, title, taskType, enabled = true }: { workdir: string; title: string; taskType: TaskType; enabled?: boolean }): WorktreeOptionsState {
  const [isolate, setIsolate] = useState(true);
  const [baseRef, setBaseRef] = useState("");
  // Branch nomenclature for the selected project (loaded from the server;
  // falls back to the built-in defaults). While clean (`!branchDirty`), the
  // field DERIVES its display from the tag-visible PATTERN (e.g.
  // `feature/<slug>`) rendered live against the current title/type/config —
  // realtime by construction, no seeding effect required. Once the user edits
  // it (`branchDirty`), `branchOverride` holds their literal text, sent to the
  // server verbatim — tags and all, the server resolves them authoritatively
  // at create time. `branchToken` seeds the client-side preview/validation
  // fallback (used when `<slug>` would otherwise render empty).
  const [branchConfig, setBranchConfig] = useState<BranchNamingConfig>(DEFAULT_BRANCH_CONFIG);
  const [branchOverride, setBranchOverride] = useState("");
  const [branchDirty, setBranchDirty] = useState(false);
  const [branchToken, setBranchToken] = useState(newBranchToken);
  const [branchSettingsOpen, setBranchSettingsOpen] = useState(false);

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

  const valid = !isolate || branchValidation.ok;

  const payload = () => worktreePayload({ isolate, baseRef, branchSubmitValue: branchField.submitValue });

  const resetBaseRef = () => setBaseRef("");

  const resetAfterSubmit = () => {
    setBaseRef("");
    // Reset the branch field so the next task re-derives from its (now empty)
    // title and gets a fresh unique token; drop any manual override.
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
    baseRef,
    setBaseRef,
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
    payload,
    resetBaseRef,
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

type Props = { state: WorktreeOptionsState } | { locked: { branch: string } };

/**
 * Renders the worktree row. Live variant (`{ state }`): the Branch picker,
 * the isolate checkbox, and — while isolated — the editable branch-name
 * field + `BranchNamingDialog`, byte-identical to `NewTaskForm`'s original
 * JSX. Locked variant (`{ locked: { branch } }`): a read-only row for
 * `existingBranch` tasks (the PR-conflicts modal), where the PR's head
 * branch is always checked out as-is in its own worktree — no base-ref
 * picker, no editable name, no dialog.
 */
export function WorktreeOptions(props: Props) {
  if ("locked" in props) {
    const { branch } = props.locked;
    return (
      <div data-testid="worktree-options-locked" className="space-y-3">
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

  const { state } = props;
  const {
    isolate,
    setIsolate,
    baseRef,
    setBaseRef,
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

  return (
    <div data-testid="worktree-options" className="space-y-3">
      <BranchPicker
        label="Branch"
        workdir={workdir}
        value={baseRef}
        onChange={setBaseRef}
        placement="bottom"
        title={
          isolate
            ? "Base ref the worktree branches from. Pick the current branch row to use what's checked out at task start."
            : "Isolation is off — the value is recorded but the agent will run directly in the project workdir."
        }
      />

      <label
        className="flex cursor-pointer items-center gap-1.5"
        title={isolateTitle}
      >
        <input
          type="checkbox"
          checked={isolate}
          onChange={(e) => setIsolate(e.target.checked)}
          data-testid="isolate-toggle"
        />
        <GitBranch className="size-3" />
        <span>Isolate (worktree)</span>
      </label>

      {isolate && (
        <div className="space-y-1">
          <label className="text-muted-foreground">Branch name</label>
          <div className="relative">
            <Input
              data-testid="branch-name-input"
              value={branchField.displayValue}
              onChange={(e) => { setBranchOverride(e.target.value); setBranchDirty(true); }}
              spellCheck={false}
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
