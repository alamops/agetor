// How the two Terminal.app routes (`POST /tasks/:id/open-tmux` and
// `POST /harnesses/:id/open-terminal`) wait on the osascript child they spawn.
//
// Pure of spawning: `server.ts` keeps the raw `/usr/bin/osascript` spawn (and
// its pinned `spawn-exempt(osascript)` marker); this module only decides what
// the HTTP response says, so the timing contract is unit-testable with a fake
// child (src/bun/terminal-launch.test.ts).
//
// The contract (issue #298 review, M1):
//   - exit 0 within the ceiling → the window is open: `ok`.
//   - non-zero within the ceiling → Automation denied or a broken script:
//     `failed`, with osascript's stderr, so the route can answer 502.
//   - still running at the ceiling → `pending`. The child is NEVER killed.
//     The usual reason osascript outlives a few seconds is macOS's one-time
//     "Agetor wants to control Terminal" consent prompt: the `do script`
//     Apple Event waits there (up to the ~2 min AppleEvent timeout) until the
//     user answers, and a cold Terminal.app launch on a loaded machine can be
//     slow too. Killing the child at the ceiling turned a slow success into a
//     window that never opens while the route still answered `ok`. A late
//     non-zero exit is logged instead, so a denial after the ceiling still
//     leaves a breadcrumb.

/** How long a route waits for osascript before answering `pending`. */
export const TERMINAL_LAUNCH_WAIT_MS = 5000;

/** The subset of a `Bun.spawn` child this module reads. */
export interface TerminalLaunchChild {
  exited: Promise<number>;
  /** `stderr: "pipe"` on the spawn; read only after the child exits. */
  stderr: ReadableStream<Uint8Array>;
}

export type TerminalLaunchOutcome =
  | { kind: "ok" }
  | { kind: "pending" }
  | { kind: "failed"; code: number; detail: string };

async function readDetail(child: TerminalLaunchChild): Promise<string> {
  try {
    return (await new Response(child.stderr).text()).trim();
  } catch {
    return "";
  }
}

/**
 * Wait up to `waitMs` for `child` to exit and classify the result. On
 * `pending` a background watcher logs a later non-zero exit through `warn`
 * (prefixed with `label`); it never rejects and never kills the child.
 */
export async function awaitTerminalLaunch(
  child: TerminalLaunchChild,
  opts: { label: string; waitMs?: number; warn?: (message: string) => void },
): Promise<TerminalLaunchOutcome> {
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  const waitMs = opts.waitMs ?? TERMINAL_LAUNCH_WAIT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exit = await Promise.race([
    child.exited,
    new Promise<"pending">((resolve) => {
      timer = setTimeout(() => resolve("pending"), waitMs);
    }),
  ]);
  clearTimeout(timer);
  if (exit === "pending") {
    void child.exited
      .then(async (code) => {
        if (code === 0) return;
        const detail = await readDetail(child);
        warn(`[agetor] osascript exited ${code} after ${waitMs}ms while ${opts.label}${detail ? `: ${detail}` : ""}`);
      })
      .catch(() => { /* a child that never reports an exit has nothing to log */ });
    return { kind: "pending" };
  }
  if (exit !== 0) {
    const detail = await readDetail(child);
    warn(`[agetor] osascript exited ${exit} while ${opts.label}${detail ? `: ${detail}` : ""}`);
    return { kind: "failed", code: exit, detail };
  }
  return { kind: "ok" };
}

/** The 502 body text both routes send for a `failed` launch. */
export function terminalLaunchErrorMessage(outcome: { code: number; detail: string }): string {
  return (
    `Couldn't open Terminal (osascript exited ${outcome.code}).` +
    (outcome.detail ? ` ${outcome.detail}` : "") +
    " Check System Settings → Privacy & Security → Automation."
  );
}
