/**
 * Bind first, serve after the boot restore (docs/plans/always-on-host.md).
 *
 * The desktop app and the headless core both restore state at boot
 * (`reconcileOrphans`, `reconcilePipelineRuns`, `rearmFxAutoResumes`), and that
 * restore acts on the shared DB and the shared tmux socket. It must only ever
 * run in the process that OWNS the API port: when the app opens while a
 * background core is live, a restore that ran before the handoff would act on
 * runs the core is still driving (kill a just-spawned claude session whose
 * JSONL isn't on disk yet, orphan in-flight one-shot turns, launch the same
 * pipeline step twice). So both entry points bind the port first — the bind is
 * the ownership claim, and the handoff from a live core happens there — and
 * only then restore.
 *
 * The "nothing reads `/tasks` or `/runs` while a run from a previous process is
 * still being reattached" invariant still holds: every route waits on the
 * `ready` promise before its handler runs. The exempt routes are the ones
 * ownership itself depends on — `/health` and `/info` are what `probeLiveCore`
 * calls (a probe that waited out the restore would read the core as dead and
 * invite a second one), and a headless core also exempts `/daemon/shutdown` so
 * the app can take the port from a core that is still booting (the core exits
 * mid-restore, which is crash-equivalent: the next owner's restore redoes it).
 */

type Handler = (req: never, server: never) => unknown;

/** Routes every core answers before its boot restore is done. */
export const BOOT_GATE_EXEMPT_ALWAYS: readonly string[] = ["/health", "/info"];
/** Extra routes a headless core answers before its boot restore is done. */
export const BOOT_GATE_EXEMPT_HEADLESS: readonly string[] = ["/daemon/shutdown"];

/**
 * Wraps every handler of a Bun `routes` object (function-valued or per-method)
 * so it runs only once `ready` has resolved. Static `Response` values and the
 * exempt paths are left untouched. Once `ready` has resolved a wrapped handler
 * calls straight through, so a booted server pays no extra microtask.
 *
 * `ready` must resolve, not reject: a failed restore ends the process (both
 * entry points exit on it), so a rejection would only strand requests.
 */
export function gateRoutesUntilReady<T>(
  routes: T,
  ready: Promise<void> | undefined,
  exempt: readonly string[],
): T {
  if (!ready) return routes;
  let isReady = false;
  void ready.then(() => {
    isReady = true;
  });
  const exemptSet = new Set(exempt);
  const gate = (handler: Handler): Handler =>
    ((req: never, server: never) =>
      isReady ? handler(req, server) : ready.then(() => handler(req, server))) as Handler;

  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(routes as Record<string, unknown>)) {
    if (exemptSet.has(path) || value instanceof Response) {
      out[path] = value;
    } else if (typeof value === "function") {
      out[path] = gate(value as Handler);
    } else if (value && typeof value === "object") {
      const methods: Record<string, unknown> = {};
      for (const [method, h] of Object.entries(value as Record<string, unknown>)) {
        methods[method] = typeof h === "function" ? gate(h as Handler) : h;
      }
      out[path] = methods;
    } else {
      out[path] = value;
    }
  }
  return out as T;
}

/** A promise plus its resolver, for the entry points' "restore done" signal. */
export function bootReadySignal(): { ready: Promise<void>; markReady: () => void } {
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  return { ready, markReady };
}
