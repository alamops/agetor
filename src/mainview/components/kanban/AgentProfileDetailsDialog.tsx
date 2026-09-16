import { createPortal } from "react-dom";
import { Bot, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AgentIcon } from "./AgentIcon";
import type { TaskProfileDisplay } from "@/lib/agent-profiles";
import type { AgentKind, Harness, Task } from "../../../shared/types.ts";

const TITLE_ID = "agent-profile-details-title";

/**
 * Task-details "Agent" row modal — plan D2 (`docs/plans/task-details-agent-row.md`).
 * Shows the task's own frozen record of the agent profile it launched (or
 * will launch) with, never a live-refetched profile: name, harness, model,
 * effort, mode, cursor fast/max-mode, skills, and the full instructions.
 *
 * Data source, in order: `task.agentProfile` (the {@link AgentProfileSnapshot}
 * every current write path stamps onto the task alongside `agentProfileId` —
 * see `resolveTaskProfileDisplay`'s own doc comment) is the primary source
 * for every field this dialog renders. `display` (the same
 * `TaskProfileDisplay` the Agent row's chip and the header chip already
 * compute via `resolveTaskProfileDisplay`) is consulted only as a fallback
 * for name/harness kind/harness label, and only in the legacy/malformed case
 * of an `agentProfileId` with no snapshot — every current write path writes
 * both together, so that case is not expected to occur in practice. `display`
 * never carries model/effort/mode/skills/instructions (it only exposes a
 * joined `summary` string), so that fallback path renders "—"/"none" for
 * those fields rather than guessing.
 *
 * Portaled to `document.body`, mirroring `MdImage.tsx`'s pattern for its two
 * attachment-failure dialogs (`AttachmentNotFoundDialog` /
 * `AttachmentOpenErrorDialog`, portaled at their `MdImage` call site): this
 * dialog is opened from content inside `RunPanel`'s `<aside>`, and a CSS
 * transform on an ancestor — the aside's `translate-x` open/close
 * transition — rebases a non-portaled `fixed` descendant to that ancestor
 * instead of the viewport, so `Dialog`'s own `fixed inset-0` backdrop would
 * end up centered within the (wide) aside rather than the full viewport.
 * This is the same rule CLAUDE.md's task-context-menu section (item 9) and
 * markdown-image-rendering section (item 14) both call out. `PlanDialog` is
 * the one dialog opened from inside the aside that renders in place rather
 * than portaling — not a pattern to follow here, since it predates both of
 * those write-ups.
 */
export function AgentProfileDetailsDialog({
  open,
  onClose,
  task,
  display,
  deleted,
  hasRun,
  harnesses,
  onOpenSettingsAgents,
}: {
  open: boolean;
  onClose: () => void;
  task: Task;
  display: TaskProfileDisplay | null;
  deleted: boolean;
  hasRun: boolean;
  harnesses: Harness[];
  onOpenSettingsAgents: () => void;
}) {
  const snapshot = task.agentProfile ?? null;
  const name = snapshot?.name ?? display?.name ?? "Agent";
  const harnessKind: AgentKind = snapshot?.harnessKind ?? display?.harnessKind ?? "claude-code";
  const harnessLabel = snapshot?.harnessLabel ?? display?.harnessLabel ?? "";
  const harnessId = snapshot?.harness ?? task.agent;
  const harnessRow = harnesses.find((h) => h.id === harnessId);
  const harnessDisabled = harnessRow?.enabled === false;
  const model = snapshot?.model ?? null;
  const effort = snapshot?.effort ?? null;
  const mode = snapshot?.mode ?? null;
  const fast = snapshot?.fast ?? false;
  const maxMode = snapshot?.maxMode ?? false;
  const instructions = (snapshot?.instructions ?? "").trim();
  const skills = snapshot?.skills ?? [];
  // Status copy (finding F1-3): the orchestrator's `effectiveAgentProfile`
  // freezes a task's profile as soon as EITHER the profile OR its harness no
  // longer resolves — not only once the task has run — so `deleted` takes
  // priority over the run-count-based copy below even at zero runs.
  const statusText = deleted
    ? "Frozen — the agent it was created from no longer exists."
    : hasRun
      ? "Frozen since the task's first run — edits to the agent no longer affect it."
      : "Follows the live agent until the task's first run.";

  if (!open) return null;

  return createPortal(
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy={TITLE_ID}
      className="flex max-h-[85vh] w-full max-w-lg flex-col p-0"
    >
      <div data-testid="agent-profile-details-dialog" className="flex min-h-0 flex-1 flex-col">
        <header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
          <div className="min-w-0">
            <div id={TITLE_ID} className="flex items-center gap-2 text-sm font-semibold">
              <Bot className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{name}</span>
              {deleted && (
                <span className="text-xs font-normal text-warning" data-testid="agent-profile-details-deleted">
                  (deleted)
                </span>
              )}
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground" data-testid="agent-profile-details-status">
              {statusText}
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <dl className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">Harness</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
              <AgentIcon kind={harnessKind} className="size-3.5 shrink-0" />
              <span>{harnessLabel || harnessId}</span>
              <span className="font-mono text-[10px] text-muted-foreground">({harnessId})</span>
              {harnessDisabled && <span className="text-warning">(harness disabled)</span>}
            </dd>

            <dt className="text-muted-foreground">Model</dt>
            <dd className="min-w-0">{model ?? "—"}</dd>

            <dt className="text-muted-foreground">Effort</dt>
            <dd className="min-w-0">{effort ?? "—"}</dd>

            <dt className="text-muted-foreground">Mode</dt>
            <dd className="min-w-0">{mode ?? "default"}</dd>

            {harnessKind === "cursor" && (
              <>
                <dt className="text-muted-foreground">Fast</dt>
                <dd className="min-w-0">{fast ? "on" : "off"}</dd>

                <dt className="text-muted-foreground">Max mode</dt>
                <dd className="min-w-0">{maxMode ? "on" : "off"}</dd>
              </>
            )}

            <dt className="text-muted-foreground">Skills</dt>
            <dd className="min-w-0">
              {skills.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {skills.map((skill) => (
                    <Badge key={skill} variant="outline" className="rounded-md px-1.5 py-0 font-mono text-[10px]">
                      /{skill}
                    </Badge>
                  ))}
                </div>
              ) : (
                <span className="text-muted-foreground">none</span>
              )}
            </dd>
          </dl>

          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Instructions</div>
            {instructions.length > 0 ? (
              <p className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap text-xs leading-snug">
                {instructions}
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">none</p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 p-3">
          {!deleted && (
            <Button
              size="sm"
              variant="outline"
              data-testid="agent-profile-details-edit"
              onClick={() => {
                onOpenSettingsAgents();
                onClose();
              }}
            >
              Edit in Settings
            </Button>
          )}
          <Button size="sm" data-testid="agent-profile-details-close" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>,
    document.body,
  );
}
