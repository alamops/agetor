import { AlertTriangle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { EnvPayload } from "@/lib/api";

interface Props {
  /** Snapshot from `GET /env`. Null while in-flight; once loaded we look
   *  at `snapshot.resolved.claude` to decide whether to nag. */
  env: EnvPayload | null;
  onOpenSettings: () => void;
}

/**
 * First-run nudge for packaged-DMG users whose login-shell PATH probe
 * couldn't reach their `claude` install. The same diagnostic is in
 * Console.app (the boot log) and in Settings → Environment, but most
 * users won't think to dig through either — so we surface it inline.
 *
 * Only shows when:
 *   - The env snapshot has loaded AND
 *   - `resolved.claude` is null (binary not found anywhere we looked).
 *
 * **Scope is claude-only on purpose.** tmux has its own banner
 * (`TmuxMissingBanner`), and codex is currently paused as a harness
 * kind (see `src/bun/index.ts` near "codex is paused"), so a missing
 * codex binary isn't a problem worth nagging about. When codex is
 * unpaused, broaden the trigger to include any *enabled* harness whose
 * binary is null — passing the harness list in alongside `env` is the
 * minimal change.
 *
 * Dismissible per-session, re-arms on every false→true edge so a user
 * who closes it and then breaks their install again gets nudged once
 * more. The same pattern TmuxMissingBanner uses.
 */
export function EnvMissingBanner({ env, onOpenSettings }: Props) {
  const show = env?.snapshot != null && env.snapshot.resolved.claude === null;
  const [dismissed, setDismissed] = useState(false);
  const prevShow = useRef(show);
  useEffect(() => {
    if (show && !prevShow.current) setDismissed(false);
    prevShow.current = show;
  }, [show]);
  if (!show || dismissed) return null;
  const aliasHint = env?.snapshot?.claudeAliasHint ?? false;
  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200",
      )}
    >
      <AlertTriangle className="size-3.5 shrink-0 text-amber-400" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-amber-100">
          claude not found on PATH.
        </span>{" "}
        <span className="text-amber-200/80">
          {aliasHint
            ? "It looks like a shell alias/function — install the real binary, or add its dir in Settings → Environment."
            : "Add the install directory in Settings → Environment so Agetor can launch it."}
        </span>
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={onOpenSettings}
        className="h-7 border-amber-400/40 bg-amber-500/10 text-amber-100 hover:bg-amber-500/20"
      >
        Fix
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
