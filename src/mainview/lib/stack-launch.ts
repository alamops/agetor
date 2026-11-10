import type { AgentStatus, Harness, HarnessStack } from "../../shared/types.ts";

/**
 * True when `harnessId` belongs to a stack that can fail over (two or more
 * accounts) and at least one OTHER member looks usable right now: it exists,
 * is enabled, its CLI is available and it is not positively logged out.
 *
 * The core's `startTask` never refuses such a launch: `prepareTaskHarness`
 * moves a task off a disabled, removed or logged-out member, and a failed
 * fresh pre-flight gets one forced move to a usable backup
 * (docs/architecture/harness-stacks.md "Manual paths"). So a launch surface
 * must not block Create & start on the current account's own status when this
 * returns true — the core picks the account. Advisory only: the core stays
 * authoritative, and an unknown login (`loggedIn: null`) counts as usable,
 * the same fail-open rule the core applies.
 */
export function stackBackupCanServe(
  harnessId: string,
  stacks: readonly HarnessStack[],
  harnesses: readonly Harness[],
  agents: readonly AgentStatus[],
): boolean {
  const stack = stacks.find((s) => s.members.some((m) => m.harnessId === harnessId));
  if (!stack || stack.members.length < 2) return false;
  return stack.members.some((member) => {
    if (member.harnessId === harnessId) return false;
    const harness = harnesses.find((h) => h.id === member.harnessId);
    if (!harness || !harness.enabled) return false;
    const status = agents.find((a) => a.harnessId === member.harnessId);
    return !!status && status.available && status.loggedIn !== false;
  });
}
