/**
 * Holds the app's quit while agent launches are still in progress
 * (docs/plans/always-on-host.md). Quitting lets every tmux-hosted session keep
 * running — under the background core when it is on, or until the next launch
 * reattaches them — but a launch THIS process is still in the middle of dies
 * with it: a claude session waiting for its > 4 KB first prompt to be pasted,
 * or for its startup dialog to be confirmed, never writes its JSONL, and the
 * next owner's restore orphans it. It is the mirror of a headless core's
 * `handOffPort` wait.
 *
 * `before-quit` is synchronous (Electrobun reads `event.response` as soon as
 * the handler returns), so a held quit is vetoed and re-issued once the
 * launches settle or the bound runs out: `requeueQuit` arms the force-quit
 * flag (keeping `completely`) and calls `Utils.quit()` again, and that second
 * `before-quit` finds the gate released and lets the quit through. A quit asked
 * for while the gate is waiting (a second Cmd+Q, the "Quit Agetor Completely"
 * menu item) is absorbed — only its `completely` is kept.
 *
 * Every effect is injected so the state machine runs under fakes.
 */

export interface QuitLaunchGateDeps {
  /** In-flight launches (`launchesInFlight` in orchestrator.ts). */
  launchesInFlight(): number;
  /** Bounded wait for them (`waitForLaunchesToSettle`); never rejects. */
  waitForLaunchesToSettle(timeoutMs: number): Promise<boolean>;
  /** Stop taking new work before the wait (`freezeLaunches`). */
  freezeLaunches(): void;
  /** Re-issue the quit so the next `before-quit` allows it. */
  requeueQuit(opts: { completely: boolean }): void;
  timeoutMs: number;
  log?: (msg: string) => void;
}

export interface QuitLaunchGate {
  /** True while a held quit waits for launches to settle. */
  isWaiting(): boolean;
  /**
   * Call right before `before-quit` would allow a quit. `true` = veto this
   * quit: the gate re-issues it once launches settle (or absorbs it into the
   * one already waiting). `false` = nothing to wait for, let it through.
   */
  holdQuit(completely: boolean): boolean;
}

export function createQuitLaunchGate(deps: QuitLaunchGateDeps): QuitLaunchGate {
  let state: "idle" | "waiting" | "released" = "idle";
  let completelyWanted = false;

  return {
    isWaiting: () => state === "waiting",
    holdQuit(completely: boolean): boolean {
      if (state === "waiting") {
        completelyWanted = completelyWanted || completely;
        return true;
      }
      if (state === "released") {
        // The re-issued quit: let it through. Back to idle so a quit that
        // somehow survives this one is checked afresh.
        state = "idle";
        return false;
      }
      deps.freezeLaunches();
      const pending = deps.launchesInFlight();
      if (pending === 0) return false;
      state = "waiting";
      completelyWanted = completely;
      deps.log?.(`[agetor] quit held — waiting for ${pending} agent launch(es) to settle`);
      void deps
        .waitForLaunchesToSettle(deps.timeoutMs)
        .catch(() => false)
        .then((settled) => {
          if (!settled) {
            deps.log?.(
              `[agetor] ${deps.launchesInFlight()} launch(es) still pending after ${deps.timeoutMs / 1000}s — quitting anyway`,
            );
          }
          state = "released";
          try {
            deps.requeueQuit({ completely: completelyWanted });
          } catch (err) {
            // Nothing re-issues the quit now: go back to idle so the user's
            // next Cmd+Q is not swallowed by a gate that will never fire.
            state = "idle";
            deps.log?.(`[agetor] re-issuing the held quit failed: ${String(err)}`);
          }
        });
      return true;
    },
  };
}

export interface BeforeQuitDeps {
  /** quit-guard.ts's one-shot force-quit flag (the confirm dialog's POST). */
  consumeForceQuit(): { completely: boolean } | null;
  /** quit-guard.ts's one-shot "Quit Agetor Completely" menu flag. */
  consumeQuitCompletely(): boolean;
  gate: QuitLaunchGate;
  /** A live login-item supervisor is around to read a stop request. */
  hasSupervisor: boolean;
  /** Tasks with a running run. Read only for an unforced quit; a failure
   *  should answer `[]` (a missed warning beats trapping the user). */
  runningTaskIds(): string[];
}

export type BeforeQuitDecision =
  /** Vetoed: absorbed into, or held by, the launch gate. */
  | { kind: "veto" }
  /** Running tasks and no confirm yet: ask the webview, veto this quit. */
  | { kind: "confirm"; completely: boolean; runningTaskIds: string[] }
  /** Let it through. `stopSupervisor` = also keep the background core down. */
  | { kind: "allow"; completely: boolean; stopSupervisor: boolean };

/**
 * The app's `before-quit` decision, effect-free apart from the injected
 * one-shots and gate, so index.ts's handler only applies the result. Both
 * one-shots are consumed first (an absorbed quit spends them); a waiting gate
 * absorbs the quit before running tasks are even looked at (no second confirm
 * dialog); and a quit about to be allowed asks the gate first, so a held quit
 * keeps the creds file and the supervisor untouched until it really happens.
 */
export function decideBeforeQuit(deps: BeforeQuitDeps): BeforeQuitDecision {
  const forced = deps.consumeForceQuit();
  const completely = deps.consumeQuitCompletely() || forced?.completely === true;
  if (deps.gate.isWaiting()) {
    deps.gate.holdQuit(completely);
    return { kind: "veto" };
  }
  if (!forced) {
    const running = deps.runningTaskIds();
    if (running.length > 0) return { kind: "confirm", completely, runningTaskIds: running };
  }
  if (deps.gate.holdQuit(completely)) return { kind: "veto" };
  return { kind: "allow", completely, stopSupervisor: completely && deps.hasSupervisor };
}
