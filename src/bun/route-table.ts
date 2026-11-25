/**
 * The served routes object, as `Bun.serve` got it: policy walker applied, boot gate applied.
 *
 * `startApiServer` (server.ts) builds it once, registers it here, and hands the SAME object to `Bun.serve`. The remote
 * router (remote/router.ts, docs/specs/remote-readiness-spec.md "Remote router and route policy") calls these exact
 * wrapped handlers in-process, so a phone's request passes the boot gate, the caller resolution, the level check and the
 * CLI path gate unchanged. It never goes through `server.fetch`, which skips `routes:`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ServedHandler = (req: any, server?: any) => Response | Promise<Response> | undefined;
export type ServedRoutes = Record<string, ServedHandler | Record<string, ServedHandler>>;

let served: ServedRoutes | null = null;

export function setServedRoutes(routes: ServedRoutes): void {
  served = routes;
}

/** The registered routes. Throws before `startApiServer` has registered them (a caller bug, not a runtime state). */
export function servedRoutes(): ServedRoutes {
  if (!served) throw new Error("the API routes are not registered yet");
  return served;
}

export function servedRoutesIfAny(): ServedRoutes | null {
  return served;
}

/** Test seam: forget the registered routes. */
export function clearServedRoutes(): void {
  served = null;
}
