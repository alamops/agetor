import { AlertTriangle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TMUX_MISSING_REASON, type AgentStatus } from "../../../shared/types.ts";

interface Props {
  /** True when at least one claude-code harness reports tmux as missing. */
  show: boolean;
  onResolve: () => void;
}

/**
 * Slim warning strip above the kanban board. Surfaces the missing-tmux state
 * so users notice it before they sink time into a prompt that won't run.
 * Dismissible per-session — the next reload re-shows it if still unresolved,
 * so the user can't permanently hide a real problem.
 */
export function TmuxMissingBanner({ show, onResolve }: Props) {
  const [dismissed, setDismissed] = useState(false);
  // Re-arm the banner on each false → true transition. Without this,
  // dismissing once would hide it for the rest of the session even if tmux
  // disappears again (system update, brew prune, settings flipped back).
  // Reading `show` directly inside an effect would re-arm on every render
  // while show stays true, defeating the dismiss button — so we track the
  // previous value to fire only on the edge.
  const prevShow = useRef(show);
  useEffect(() => {
    if (show && !prevShow.current) setDismissed(false);
    prevShow.current = show;
  }, [show]);
  if (!show || dismissed) return null;
  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200",
      )}
    >
      <AlertTriangle className="size-3.5 shrink-0 text-amber-400" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-amber-100">tmux not installed.</span>{" "}
        <span className="text-amber-200/80">
          Claude Code tasks need tmux to run.
        </span>
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={onResolve}
        className="h-7 border-amber-400/40 bg-amber-500/10 text-amber-100 hover:bg-amber-500/20"
      >
        Resolve
      </Button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="rounded p-0.5 text-amber-300/70 hover:bg-amber-500/10 hover:text-amber-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** Detects if any claude-code harness is reporting a tmux-missing failure. */
export function isTmuxMissing(agents: AgentStatus[]): boolean {
  return agents.some(
    (a) => a.kind === "claude-code" && !a.available && a.reason === TMUX_MISSING_REASON,
  );
}

/** True when a start-task error message embeds the tmux-missing reason
 *  emitted by the server (the orchestrator wraps the reason in a sentence
 *  like "Claude Code is not available — <reason>. Install it with: …", so
 *  we substring-match the unique reason constant). The constant is specific
 *  enough that unrelated errors that happen to mention "tmux" — e.g. "tmux
 *  session for task X not found" — won't false-positive. */
export function errorIsTmuxMissing(msg: string): boolean {
  return msg.includes(TMUX_MISSING_REASON);
}
