import { ArrowLeftRight } from "lucide-react";
import type { Ref } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatResetClock } from "@/lib/stack-badge";
import type { HarnessBarButton } from "@/lib/harness-bar";
import { BarMeter } from "./BarMeter";
import { StatusDot } from "./StatusDot";

interface Props {
  button: HarnessBarButton;
  /** What the collapse ladder hides at the current step (`stepHides`). */
  hide: { harnessText: boolean; until: boolean };
  open: boolean;
  /** The panel's id, for `aria-controls`. */
  panelId: string;
  onToggle: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
  /** Render the measurement copy: everything at step 0, tagged with
   *  `data-fit-part`, and no testid, accessible name, id or handler. Used only
   *  inside the app bar's inert ghost. */
  measure?: boolean;
  /** Clock for "until HH:MM" (the bar's own clock); defaults to the wall clock. */
  now?: number;
}

function dotLabel(button: HarnessBarButton): string {
  switch (button.dot) {
    case "none":
      return "No harnesses enabled";
    case "danger":
      return "An account is unavailable";
    case "warning":
      return "An account needs attention";
    case "success":
      return "Every account is ready";
    case "muted":
      return "No account is active";
  }
}

const BASE_CLASS =
  "inline-flex h-[32px] min-w-0 items-center gap-2 rounded-md border border-transparent px-2 text-xs font-medium";

/**
 * The app bar's single Harnesses entry point: worst-state dot, name, the
 * enabled count, one usage meter with its %, a failover badge and, when
 * nothing can run, "until HH:MM". The per-account detail lives in the panel
 * it opens. The model is `buildHarnessBarModel(...).button`; this component
 * only draws it. Contract: docs/architecture/app-bar.md.
 */
export function HarnessesButton({ button, hide, open, panelId, onToggle, buttonRef, measure = false, now }: Props) {
  const clock = now ?? Date.now();
  const fit = (part: "harness-text" | "until") => (measure ? { "data-fit-part": part } : {});
  const id = (testId: string) => (measure ? {} : { "data-testid": testId });
  const showName = measure || !hide.harnessText;
  const showUntil = button.until !== null && (measure || !hide.until);

  const content = (
    <>
      <StatusDot
        tone={button.dot}
        label={measure ? undefined : dotLabel(button)}
        data-testid={measure ? undefined : "harnesses-button-dot"}
      />
      {showName && (
        <span className="min-w-0 truncate" {...fit("harness-text")}>
          Harnesses
        </span>
      )}
      {showName && (
        <span className="shrink-0 tabular-nums text-muted-foreground" {...id("harnesses-button-count")} {...fit("harness-text")}>
          {button.enabledCount}
        </span>
      )}
      {button.meter && (
        <BarMeter
          usedPercent={button.meter.usedPercent}
          stale={button.meter.stale}
          data-testid={measure ? undefined : "harnesses-button-meter"}
        />
      )}
      {button.meter && showName && (
        <span
          className={cn("shrink-0 tabular-nums text-muted-foreground", button.meter.stale && "opacity-70")}
          {...fit("harness-text")}
        >
          {Math.round(button.meter.usedPercent)}%
        </span>
      )}
      {button.badgeCount > 0 && (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[11px] leading-none text-warning"
          {...id("harnesses-button-badge")}
        >
          <ArrowLeftRight className="size-3" aria-hidden="true" />
          {button.badgeCount}
        </span>
      )}
      {showUntil && button.until !== null && (
        <span className="shrink-0 whitespace-nowrap text-warning" {...id("harnesses-button-until")} {...fit("until")}>
          until {formatResetClock(button.until, clock)}
        </span>
      )}
    </>
  );

  if (measure) {
    return <span className={cn(BASE_CLASS, "whitespace-nowrap")}>{content}</span>;
  }
  return (
    <Tooltip label={button.summaryText} className="min-w-0">
      <button
        ref={buttonRef}
        type="button"
        aria-label="Harnesses"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="harnesses-button"
        onClick={onToggle}
        className={cn(
          BASE_CLASS,
          "electrobun-webkit-app-region-no-drag whitespace-nowrap text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          open && "bg-accent",
        )}
      >
        {content}
      </button>
    </Tooltip>
  );
}
