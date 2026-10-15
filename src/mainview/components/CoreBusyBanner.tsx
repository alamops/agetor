import { Loader2 } from "lucide-react";
import { useSyncExternalStore } from "react";
import { getCoreBusy, subscribeCoreBusy } from "@/lib/core-busy";

/**
 * App-level strip shown while the core stops answering — a request has been
 * pending for over 3 s and a `/health` probe got no answer either (see
 * `lib/core-busy.ts`). Styled like `TmuxMissingBanner`, but with no dismiss
 * button and no action: it clears itself on the next successful probe, and
 * nothing the user could click would make the core answer sooner. The copy
 * stays neutral on purpose — a probe can occasionally be delayed by the
 * webview's own connection cap on a healthy core.
 */
export function CoreBusyBanner() {
  const busy = useSyncExternalStore(subscribeCoreBusy, getCoreBusy, getCoreBusy);
  if (!busy) return null;
  return (
    <div
      role="status"
      data-testid="core-busy-banner"
      className="flex items-center gap-3 border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-foreground"
    >
      <Loader2 className="size-3.5 shrink-0 animate-spin text-warning motion-reduce:animate-none" aria-hidden />
      <span className="min-w-0 flex-1 font-medium text-foreground">
        Agetor is busy — waiting for the core…
      </span>
    </div>
  );
}
