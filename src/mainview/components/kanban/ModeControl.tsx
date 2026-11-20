import { useMemo } from "react";
import { ClipboardList, Code2 } from "lucide-react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Picker, type PickerItem } from "@/components/ui/picker";
import { CODE_MODE_TOOLTIP, planModeTooltip } from "@/lib/launch-copy";
import { modeForPrimary } from "@/lib/launch-state";
import type { AgentKind, AgentOption } from "../../../shared/types.ts";

/**
 * Code | Plan: the one decision a launch always makes about autonomy, as a
 * two-radio group. Clicking Code while a code variant (auto / accept edits / ask)
 * is active does nothing, so an explicit variant choice survives. The change
 * goes through `onModeChange` — the hook's tracked `setMode` — never a private setter.
 */
export function ModeControl({
  kind,
  mode,
  primary,
  onModeChange,
  disabled,
  "aria-labelledby": labelledBy,
}: {
  kind: AgentKind;
  mode: string;
  primary: "code" | "plan";
  onModeChange: (mode: string) => void;
  disabled?: boolean;
  "aria-labelledby"?: string;
}) {
  return (
    <div data-testid="launch-mode" data-value={primary} data-mode={mode} data-kind={kind}>
      <SegmentedControl
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : "Mode"}
        value={primary}
        disabled={disabled}
        onChange={(v) => {
          const next = modeForPrimary(kind, mode, v as "code" | "plan");
          if (next !== null) onModeChange(next);
        }}
        items={[
          { value: "code", label: "Code", title: CODE_MODE_TOOLTIP, testId: "launch-mode-code", icon: <Code2 className="size-3.5" /> },
          { value: "plan", label: "Plan", title: planModeTooltip(kind), testId: "launch-mode-plan", icon: <ClipboardList className="size-3.5" /> },
        ]}
      />
    </div>
  );
}

/** The exact code variant (Auto / Accept edits / Ask …), each with its hint.
 *  Only rendered when the kind offers more than one. */
export function ModeVariantPicker({
  mode,
  variants,
  onModeChange,
  disabled,
  id,
  labelId,
  "aria-describedby": describedBy,
}: {
  mode: string;
  variants: AgentOption[];
  onModeChange: (mode: string) => void;
  disabled?: boolean;
  id?: string;
  labelId?: string;
  "aria-describedby"?: string;
}) {
  const items = useMemo<PickerItem[]>(
    () => variants.map((v) => ({ value: v.id, label: v.label, hint: v.hint })),
    [variants],
  );
  return (
    <Picker
      testId="launch-mode-variant-picker"
      id={id}
      aria-describedby={describedBy}
      aria-label="Approvals"
      labelId={labelId}
      value={variants.some((v) => v.id === mode) ? mode : null}
      onChange={onModeChange}
      items={items}
      disabled={disabled}
      placeholder="Plan"
    />
  );
}
