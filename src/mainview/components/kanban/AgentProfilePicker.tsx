import { useMemo } from "react";
import { Bot, X } from "lucide-react";
import { Picker, type PickerItem } from "@/components/ui/picker";
import { cn } from "@/lib/utils";
import type { AgentProfile, Harness } from "../../../shared/types.ts";
import { AgentProfileCard } from "./AgentProfileCard";

interface AgentProfilePickerProps {
  /** Selected profile id, or `null` for "No agent — pick harness manually". */
  value: string | null;
  onChange: (id: string | null) => void;
  profiles: AgentProfile[];
  /** Live harness rows — resolves each profile's icon/label in the popover
   *  rows and the trigger's selected-chip display. */
  harnesses: Harness[];
  /** Renders a "Manage agents…" footer row that calls back instead of
   *  picking anything; omit to hide the footer entirely. */
  onManage?: () => void;
  disabled?: boolean;
  className?: string;
  /** `id` of the trigger, so a `<label htmlFor>` names the control. */
  id?: string;
  labelId?: string;
  "aria-describedby"?: string;
}

const NONE = "";

/**
 * Controlled agent-profile picker, built on the launch surfaces' one `Picker`:
 * a trigger (the selected profile's chip, or the "No agent" placeholder) plus a
 * searchable listbox of every profile. Picking one is the launch form's "one
 * selection": the caller hides its manual harness/mode/model/effort block once
 * `value` is non-null (plan D5). A profile can be cleared from the popover's
 * "No agent" row or the trigger-adjacent `×` control.
 *
 * The part test ids (`agent-profile-picker-trigger|popover|search|none|row|
 * clear|manage`) are unchanged from the hand-rolled version this replaced.
 */
export function AgentProfilePicker({
  value,
  onChange,
  profiles,
  harnesses,
  onManage,
  disabled,
  className,
  id,
  labelId,
  "aria-describedby": describedBy,
}: AgentProfilePickerProps) {
  const selectedProfile = value ? (profiles.find((p) => p.id === value) ?? null) : null;
  const items = useMemo<PickerItem[]>(
    () => [
      { value: NONE, label: "No agent — pick harness manually", testId: "agent-profile-picker-none", searchText: "none no agent manual" },
      ...profiles.map((p) => ({
        value: p.id,
        label: p.name,
        testId: "agent-profile-picker-row",
        dataAttrs: { "data-profile-id": p.id },
        searchText: [p.harness, p.model, p.effort ?? "", p.mode ?? "", p.instructions].join(" "),
      })),
    ],
    [profiles],
  );
  const byId = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);

  return (
    <div data-testid="agent-profile-picker" className={cn("flex items-center gap-1", className)}>
      <Picker
        className="min-w-0 flex-1"
        partsTestId="agent-profile-picker"
        id={id}
        aria-describedby={describedBy}
        aria-label="Agent"
        labelId={labelId}
        value={value ?? NONE}
        onChange={(v) => onChange(v === NONE ? null : v)}
        items={items}
        searchable
        emptyLabel="No matches."
        trailing={profiles.length === 0 ? "No agents yet." : undefined}
        disabled={disabled}
        triggerClassName="h-auto min-h-9 py-1.5"
        renderValue={() =>
          selectedProfile ? (
            <AgentProfileCard
              profile={selectedProfile}
              harnesses={harnesses}
              variant="chip"
              className="min-w-0 border-0 bg-transparent px-0 py-0"
            />
          ) : value ? (
            <span className="flex min-w-0 items-center gap-1.5 text-warning">
              <Bot className="size-4 shrink-0" aria-hidden />
              <span className="truncate">Selected agent is no longer available</span>
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <Bot className="size-4 shrink-0" aria-hidden />
              <span className="truncate">No agent — pick harness manually</span>
            </span>
          )
        }
        renderItem={(item) => {
          const p = byId.get(item.value);
          return p ? (
            <AgentProfileCard profile={p} harnesses={harnesses} variant="row" className="min-w-0 flex-1" />
          ) : (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Bot className="size-4 shrink-0" aria-hidden />
              No agent — pick harness manually
            </span>
          );
        }}
        footer={
          onManage
            ? (close) => (
                <button
                  type="button"
                  data-testid="agent-profile-picker-manage"
                  onClick={() => {
                    close();
                    onManage();
                  }}
                  className="h-8 w-full rounded-sm px-2.5 text-left text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                >
                  Manage agents…
                </button>
              )
            : undefined
        }
      />
      {value && (
        <button
          type="button"
          data-testid="agent-profile-picker-clear"
          onClick={() => onChange(null)}
          disabled={disabled}
          title="Clear agent"
          aria-label="Clear agent"
          className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent/40 hover:text-foreground disabled:opacity-50"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
