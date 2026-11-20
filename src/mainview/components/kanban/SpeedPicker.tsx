import { SegmentedControl } from "@/components/ui/segmented-control";
import { SPEED_OPTIONS, speedLabel } from "../../../shared/speed.ts";
import type { Speed } from "../../../shared/types.ts";

/** Whether `<SpeedPicker>` renders anything for this options/value pair —
 *  for a consumer that wraps it in its own label row (a `<dt>`, a field
 *  label) and must hide that row too when the picker renders `null`. */
export function showsSpeedPicker(options: readonly Speed[], value: Speed): boolean {
  return !(options.length <= 1 && value === "off");
}

/**
 * Speed tier picker (`off | fast | ultrafast`) — a segmented radiogroup
 * shared by every launch surface (`launch-speed`) and RunPanel's task details
 * (`task-speed`). It replaced the cursor-only Fast switches.
 *
 * `options` is what the kind/model/effort offers (`supportedSpeeds`), always
 * starting with `"off"`. Renders `null` when there's nothing to pick (a lone
 * `"off"`) and nothing stored to show. A stored `value` the current options
 * don't include renders as one extra disabled, pressed segment ("Fast (not
 * offered)") so the tier stays visible instead of silently disappearing —
 * the same idea as the model picker's unlisted-selected row. The root
 * carries `data-value` and each segment `aria-checked` (radio), which is what
 * tests assert on. No label of its own: consumers render theirs (a `<dt>` in task
 * details, a field label elsewhere), gated on {@link showsSpeedPicker}.
 *
 * `fastHint` / `note` are optional lines rendered under the group; without
 * either the DOM is unchanged.
 */
export function SpeedPicker({
  options,
  value,
  onChange,
  disabled,
  testId,
  fastHint,
  note,
}: {
  options: readonly Speed[];
  value: Speed;
  onChange(s: Speed): void;
  disabled?: boolean;
  testId: string;
  /** The CLI's own cost text for Fast, shown under the control while Fast is
   *  selected (`speedNoticeFor`). */
  fastHint?: string;
  /** A short note shown under the control (e.g. "applies on the next run"). */
  note?: string;
}) {
  if (!showsSpeedPicker(options, value)) return null;
  const offered = options.includes(value);
  const hintFor = (id: Speed) => SPEED_OPTIONS.find((o) => o.id === id)?.hint;
  const items = options.map((id) => ({
    value: id,
    label: speedLabel(id),
    title: hintFor(id),
    testId: `${testId}-${id}`,
  }));
  // A stored tier the current options don't include renders as one extra
  // disabled, selected segment so it stays visible instead of silently vanishing.
  if (!offered) {
    items.push({
      value,
      label: `${speedLabel(value)} (not offered)`,
      title: `${speedLabel(value)} isn't offered for this model — pick another tier to change it.`,
      testId: `${testId}-${value}`,
    });
  }
  const group = (
    <div data-testid={testId} data-value={value}>
      <SegmentedControl
        aria-label="Speed"
        value={value}
        onChange={(v) => {
          if (v !== value) onChange(v as Speed);
        }}
        disabled={disabled}
        items={offered ? items : items.map((it) => (it.value === value ? { ...it, disabled: true } : it))}
      />
    </div>
  );
  // No hint and no note: the control's DOM is exactly the segmented group.
  if (!fastHint && !note) return group;
  return (
    <>
      {group}
      {fastHint && value === "fast" && (
        <p data-testid={`${testId}-hint`} className="mt-1 text-2xs text-muted-foreground">{fastHint}</p>
      )}
      {note && (
        <p data-testid={`${testId}-note`} className="mt-1 text-2xs text-muted-foreground">{note}</p>
      )}
    </>
  );
}
