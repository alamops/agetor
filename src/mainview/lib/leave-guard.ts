/**
 * Unsaved work an app-level navigation would silently drop. A component
 * whose state dies when `App.tsx`'s `view` switches (an edited import
 * preview on the Pipelines page) registers a check for as long as it is
 * mounted; `navigate` asks with the wording of a check that reports
 * something to lose before switching. Module-level on purpose: the guarded
 * component and `navigate` are far apart in the tree.
 *
 * A registry of checks, not of stored values: each check is read at
 * navigation time, so a guard is never stale (an effect that hasn't run
 * yet) and unregistering or changing one never affects another. Any check
 * that reports a guard blocks; the most recently registered one's wording
 * is shown.
 */
export interface LeaveGuard {
  title: string;
  description?: string;
  /** Called once the user chose to leave, before the view switches — e.g.
   *  close the guarded dialog at once instead of letting it ride the old
   *  view's exit animation. */
  discard?: () => void;
}

/** Reports what leaving now would lose, or null when nothing would. */
export type LeaveGuardCheck = () => LeaveGuard | null;

// Registration order; a Set keeps one entry per check even if registered twice.
const checks = new Set<LeaveGuardCheck>();

/** Register `check`; the returned function unregisters exactly it. */
export function registerLeaveGuard(check: LeaveGuardCheck): () => void {
  checks.add(check);
  return () => {
    checks.delete(check);
  };
}

/** The guard of the most recently registered check that reports one, or
 *  null when nothing would be lost. */
export function activeLeaveGuard(): LeaveGuard | null {
  const list = [...checks];
  for (let i = list.length - 1; i >= 0; i--) {
    const guard = list[i]!();
    if (guard) return guard;
  }
  return null;
}
