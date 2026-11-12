import { useEffect, useState } from "react";
import type { AgetorClient } from "../api-client.ts";
import type { HarnessLimitState, HarnessStack } from "../../shared/types.ts";

/**
 * Poll the harness-account stacks for the TUI's active-account line. Stacks
 * change rarely (a Settings/CLI edit), so this poll is much slower than
 * {@link useTasks}. The route is a plain DB read — never `/harnesses`, whose
 * probe fan-out this line must not trigger.
 *
 * Optional by design: older daemons have no stacks route and a partial test
 * client may not implement it, in which case the line simply stays off.
 */
export function useHarnessStacks(
  client: AgetorClient,
  intervalMs = 10_000,
): { stacks: HarnessStack[]; limitStates: HarnessLimitState[] } {
  const [data, setData] = useState<{ stacks: HarnessStack[]; limitStates: HarnessLimitState[] }>({ stacks: [], limitStates: [] });
  useEffect(() => {
    let alive = true;
    // Single-flight: a slow route must not stack overlapping polls (the
    // interval would otherwise fire again while the first request is still
    // in flight, piling up responses that can land out of order).
    let inFlight = false;
    const list = (client as { listHarnessStacks?: AgetorClient["listHarnessStacks"] }).listHarnessStacks;
    if (typeof list !== "function") return;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const payload = await list.call(client);
        if (alive) setData({ stacks: payload?.stacks ?? [], limitStates: payload?.limitStates ?? [] });
      } catch {
        /* transient — keep the last good list */
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const id = setInterval(() => void poll(), intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [client, intervalMs]);
  return data;
}
