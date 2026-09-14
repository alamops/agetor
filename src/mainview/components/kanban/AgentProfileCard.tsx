import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { agentProfileSummary } from "../../../shared/agent-profile.ts";
import type { AgentKind, AgentProfile, AgentProfileSnapshot, Harness } from "../../../shared/types.ts";
import { AgentIcon } from "./AgentIcon";

/** Resolves the display kind + label for either shape this card accepts: a
 *  live {@link AgentProfile} (harness id only — needs `harnesses` to resolve
 *  kind/label) or a frozen {@link AgentProfileSnapshot} (already carries its
 *  own `harnessKind`/`harnessLabel`, so display never depends on a harness
 *  row that may since have been deleted — see plan D14). */
function resolveHarnessDisplay(
  profile: AgentProfile | AgentProfileSnapshot,
  harnesses?: Harness[],
): { kind: AgentKind; label: string } {
  if ("harnessKind" in profile) {
    return { kind: profile.harnessKind, label: profile.harnessLabel };
  }
  const harness = harnesses?.find((h) => h.id === profile.harness);
  return { kind: harness?.kind ?? "claude-code", label: harness?.label ?? profile.harness };
}

interface AgentProfileCardProps {
  profile: AgentProfile | AgentProfileSnapshot;
  /** Live harness rows, used to resolve kind/label for a live `AgentProfile`
   *  (a snapshot already carries its own — see {@link resolveHarnessDisplay}).
   *  Omit when only rendering snapshots. */
  harnesses?: Harness[];
  /** `row` — Settings list / picker option: icon + name + summary +
   *  instructions preview + skill chips. `selected` — same content inside a
   *  bordered card, the launch form's "one selection" replacement for the
   *  manual harness/model/effort block. `chip` — compact inline badge (icon +
   *  name) for a trigger button or a task-details header. */
  variant: "row" | "selected" | "chip";
  /** Appends a `text-warning` "(deleted)" marker — the profile this task (or
   *  picker value) named no longer exists; the caller is rendering a
   *  snapshot or a stale id instead. */
  deleted?: boolean;
  className?: string;
}

/**
 * Shared rendering for an {@link AgentProfile} / {@link AgentProfileSnapshot}
 * — one component behind the picker's option rows, the Settings Agents list,
 * the launch form's "selected" replacement, and the task-details/board chip
 * (plan D10: "one rendering, four surfaces"). Semantic tokens only, per
 * CLAUDE.md's UI conventions.
 */
export function AgentProfileCard({ profile, harnesses, variant, deleted, className }: AgentProfileCardProps) {
  const { kind, label } = resolveHarnessDisplay(profile, harnesses);
  const summary = agentProfileSummary({
    harnessLabel: label,
    model: profile.model,
    effort: profile.effort,
    mode: profile.mode,
  });

  const deletedMarker = deleted && (
    <span className="text-warning" data-testid="agent-profile-card-deleted">
      (deleted)
    </span>
  );

  if (variant === "chip") {
    return (
      <Badge
        variant="secondary"
        data-testid="agent-profile-card"
        data-profile-id={profile.id}
        title={summary}
        className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5 font-normal", className)}
      >
        <AgentIcon kind={kind} className="shrink-0" />
        <span className="min-w-0 truncate">{profile.name}</span>
        {deletedMarker}
      </Badge>
    );
  }

  const instructions = profile.instructions.trim();
  const shownSkills = profile.skills.slice(0, 4);
  const overflow = profile.skills.length - shownSkills.length;

  const body = (
    <div className="flex min-w-0 items-start gap-2">
      <AgentIcon kind={kind} className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium">{profile.name}</span>
          {deletedMarker}
        </div>
        <div className="truncate text-xs text-muted-foreground">{summary}</div>
        {instructions.length > 0 && (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{instructions}</p>
        )}
        {profile.skills.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {shownSkills.map((skill) => (
              <Badge key={skill} variant="outline" className="rounded-md px-1.5 py-0 font-mono text-[10px]">
                /{skill}
              </Badge>
            ))}
            {overflow > 0 && (
              <Badge variant="outline" className="rounded-md px-1.5 py-0 text-[10px]">
                +{overflow}
              </Badge>
            )}
          </div>
        )}
      </div>
    </div>
  );

  if (variant === "selected") {
    return (
      <div
        data-testid="agent-profile-card"
        data-profile-id={profile.id}
        className={cn("rounded-md border border-border bg-card p-2.5", className)}
      >
        {body}
      </div>
    );
  }

  return (
    <div data-testid="agent-profile-card" data-profile-id={profile.id} className={cn("min-w-0", className)}>
      {body}
    </div>
  );
}
