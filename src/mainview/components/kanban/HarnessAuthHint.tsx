import type { AgentStatus } from "../../../shared/types.ts";

/**
 * Non-blocking "not logged in" warning box for a selected harness. Renders
 * nothing unless the harness is available but positively reported logged
 * out (`loggedIn === false` — `null` means unknown/not probed and must
 * never surface here, see `HarnessStatus.loggedIn`'s doc comment).
 *
 * This is a heads-up, not a disable — callers must not gate submit/create
 * on it. The real enforcement is the server's `startTask` pre-flight, which
 * returns an actionable error if the turn actually needs credentials.
 */
export function HarnessAuthHint({ status }: { status: AgentStatus | undefined }) {
  if (!status?.available || status.loggedIn !== false) return null;
  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-[11px] text-warning">
      <div className="font-medium">Not logged in</div>
      {status.authHelp && <div className="mt-1 opacity-80">{status.authHelp}</div>}
    </div>
  );
}
