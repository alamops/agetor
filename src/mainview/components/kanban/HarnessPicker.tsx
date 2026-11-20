import { useMemo } from "react";
import { Picker, type PickerItem } from "@/components/ui/picker";
import { cn } from "@/lib/utils";
import { harnessTooltip } from "@/lib/launch-copy";
import type { StatusTone } from "@/lib/launch-state";
import type { AgentStatus, Harness, HarnessStack } from "../../../shared/types.ts";
import { AgentIcon } from "./AgentIcon";
import { StackPositionChip } from "./StackBadge";

const TONE_CLASS: Record<StatusTone, string> = {
  ok: "bg-success-solid",
  warn: "bg-warning-solid",
  error: "bg-danger-solid",
  unknown: "bg-muted-foreground/40",
};

const TONE_LABEL: Record<StatusTone, string> = {
  ok: "Available",
  warn: "Not logged in",
  error: "Unavailable",
  unknown: "Checking status…",
};

/** The three-state (plus "checking") dot of a harness row. */
export function StatusDot({ tone, className }: { tone: StatusTone; className?: string }) {
  return (
    <span
      role="img"
      aria-label={TONE_LABEL[tone]}
      title={TONE_LABEL[tone]}
      data-testid="launch-harness-status"
      data-tone={tone}
      className={cn("inline-block size-2 shrink-0 rounded-full", TONE_CLASS[tone], className)}
    />
  );
}

/**
 * The harness picker: a searchable listbox of every enabled harness, one row per
 * harness with its icon, FULL label, account position chip, status dot and the
 * account email on a second line. The row's tooltip is `harnessTooltip` (email,
 * today's tokens, reason, auth help, path, version). Replaces the 2-column
 * button grid whose labels truncated.
 */
export function HarnessPicker({
  value,
  onChange,
  harnesses,
  agents,
  stacks,
  disabled,
  id,
  labelId,
  "aria-describedby": describedBy,
  statusTone,
}: {
  value: string;
  onChange: (harnessId: string) => void;
  harnesses: Harness[];
  agents: AgentStatus[];
  stacks: HarnessStack[];
  disabled?: boolean;
  id?: string;
  labelId?: string;
  "aria-describedby"?: string;
  statusTone: (harnessId: string) => StatusTone;
}) {
  const byId = useMemo(() => new Map(harnesses.map((h) => [h.id, h])), [harnesses]);
  const items = useMemo<PickerItem[]>(
    () =>
      harnesses.map((h) => {
        const status = agents.find((s) => s.harnessId === h.id);
        return {
          value: h.id,
          label: h.label,
          title: harnessTooltip(status, h.id),
          searchText: `${h.id} ${status?.account?.email ?? ""}`,
        };
      }),
    [harnesses, agents],
  );

  const row = (harnessId: string, withEmail: boolean) => {
    const h = byId.get(harnessId);
    if (!h) return <span className="truncate">{harnessId}</span>;
    const email = agents.find((s) => s.harnessId === h.id)?.account?.email;
    return (
      <span className="flex min-w-0 items-center gap-2">
        <AgentIcon kind={h.kind} className="shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{h.label}</span>
            <StackPositionChip stacks={stacks} harnessId={h.id} />
          </span>
          {withEmail && email ? <span className="block truncate text-2xs text-muted-foreground">{email}</span> : null}
        </span>
        <StatusDot tone={statusTone(h.id)} />
      </span>
    );
  };

  return (
    <Picker
      testId="launch-harness-picker"
      id={id}
      aria-describedby={describedBy}
      aria-label="Harness"
      labelId={labelId}
      value={value}
      onChange={onChange}
      items={items}
      searchable={harnesses.length > 6}
      disabled={disabled}
      title={harnessTooltip(agents.find((s) => s.harnessId === value), value)}
      renderValue={(item) => (item ? row(item.value, false) : <span className="truncate">{value}</span>)}
      renderItem={(item) => row(item.value, true)}
    />
  );
}
