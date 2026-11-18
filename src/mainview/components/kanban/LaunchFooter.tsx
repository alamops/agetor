import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { isMacPlatform } from "@/lib/platform";

export interface LaunchFooterAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  testId: string;
  busy?: boolean;
}

/**
 * The action row of every launch surface: the primary **Run task** (with its
 * shortcut hint), an optional secondary action (Add to backlog / Cancel), the
 * reason Run is blocked as visible text, and the last error.
 *
 * The reason is plain text on purpose: `Button` drops pointer events when
 * disabled (`disabled:pointer-events-none`), so a `title` tooltip on a disabled
 * Run never shows. `aria-describedby` ties the button to it. The shortcut hint is
 * `aria-hidden` and the key is in `aria-keyshortcuts`, so Run's accessible name
 * stays exactly "Run task".
 */
export function LaunchFooter({
  primary,
  secondary,
  cancel,
  reason,
  error,
  className,
}: {
  primary: LaunchFooterAction;
  /** The "queue it anyway" action (Add to backlog), outline. */
  secondary?: LaunchFooterAction;
  /** A dismissive action (Cancel), ghost. */
  cancel?: LaunchFooterAction;
  reason?: string | null;
  error?: string | null;
  className?: string;
}) {
  const mac = isMacPlatform();
  const reasonId = "launch-run-blocked-reason";
  const showReason = !!reason && !!primary.disabled;
  return (
    <div className={cn("space-y-2", className)}>
      {showReason ? (
        <p id={reasonId} data-testid="launch-run-blocked-reason" aria-live="polite" className="text-2xs text-muted-foreground">
          {reason}
        </p>
      ) : null}
      {error ? (
        <p role="alert" data-testid="launch-error" className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        {cancel ? (
          <Button type="button" variant="ghost" data-testid={cancel.testId} onClick={cancel.onClick} disabled={cancel.disabled}>
            {cancel.label}
          </Button>
        ) : null}
        {secondary ? (
          <Button
            type="button"
            variant="outline"
            data-testid={secondary.testId}
            onClick={secondary.onClick}
            disabled={secondary.disabled}
            className="flex-1 sm:flex-none"
          >
            {secondary.label}
          </Button>
        ) : null}
        <Button
          type="button"
          data-testid={primary.testId}
          onClick={primary.onClick}
          disabled={primary.disabled || primary.busy}
          aria-keyshortcuts={mac ? "Meta+Enter" : "Control+Enter"}
          aria-describedby={showReason ? reasonId : undefined}
          className="flex-1 sm:flex-none"
        >
          {primary.busy ? (
            <>
              <Loader2 aria-hidden className="size-4 animate-spin" />
              Running…
            </>
          ) : (
            <>
              {primary.label}
              <Kbd aria-hidden className="ml-0.5 border-primary-foreground/40">{mac ? "⌘↵" : "Ctrl ↵"}</Kbd>
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
