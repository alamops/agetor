import { Button } from "@/components/ui/button";
import { SPEED_OPTIONS, speedLabel } from "../../../shared/speed.ts";
import type { Speed } from "../../../shared/types.ts";

/** Whether `<SpeedPicker>` renders anything for this options/value pair —
 *  for a consumer that wraps it in its own label row (a `<dt>`, a field
 *  label) and must hide that row too when the picker renders `null`. */
export function showsSpeedPicker(options: readonly Speed[], value: Speed): boolean {
  return !(options.length <= 1 && value === "off");
}

/**
 * Speed tier picker (`off | fast | ultrafast`) — a segmented button group
 * shared by the launch dialogs (`launch-speed`), the New Task form
 * (`new-task-speed`) and RunPanel's task details (`task-speed`). It replaced
 * the cursor-only Fast switches.
 *
 * `options` is what the kind/model/effort offers (`supportedSpeeds`), always
 * starting with `"off"`. Renders `null` when there's nothing to pick (a lone
 * `"off"`) and nothing stored to show. A stored `value` the current options
 * don't include renders as one extra disabled, pressed segment ("Fast (not
 * offered)") so the tier stays visible instead of silently disappearing —
 * the same idea as the model picker's unlisted-selected row. The root
 * carries `data-value` and each segment `aria-pressed`, which is what tests
 * assert on. No label of its own: consumers render theirs (a `<dt>` in task
 * details, a field label elsewhere), gated on {@link showsSpeedPicker}.
 */
export function SpeedPicker({
  options,
  value,
  onChange,
  disabled,
  testId,
}: {
  options: readonly Speed[];
  value: Speed;
  onChange(s: Speed): void;
  disabled?: boolean;
  testId: string;
}) {
  if (!showsSpeedPicker(options, value)) return null;
  const offered = options.includes(value);
  const hintFor = (id: Speed) => SPEED_OPTIONS.find((o) => o.id === id)?.hint;
  return (
    <div
      data-testid={testId}
      data-value={value}
      role="group"
      aria-label="Speed"
      className="flex gap-1"
    >
      {options.map((id) => (
        <Button
          key={id}
          type="button"
          size="sm"
          variant={value === id ? "default" : "outline"}
          data-testid={`${testId}-${id}`}
          aria-pressed={value === id}
          title={hintFor(id)}
          disabled={disabled}
          onClick={() => {
            if (id !== value) onChange(id);
          }}
          className="min-w-0 flex-1 px-2"
        >
          <span className="truncate">{speedLabel(id)}</span>
        </Button>
      ))}
      {!offered && (
        <Button
          type="button"
          size="sm"
          variant="default"
          data-testid={`${testId}-${value}`}
          aria-pressed
          title={`${speedLabel(value)} isn't offered for this model — pick another tier to change it.`}
          disabled
          className="min-w-0 flex-1 px-2"
        >
          <span className="truncate">{speedLabel(value)} (not offered)</span>
        </Button>
      )}
    </div>
  );
}
