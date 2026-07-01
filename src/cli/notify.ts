import type { GlobalEvent } from "../shared/types.ts";

const BELL = String.fromCharCode(7);

/**
 * Map a global event to a desktop notification — only for the given task, and
 * only for state changes worth interrupting the user (terminal status + the
 * "needs you" block). Returns null otherwise.
 */
export function notifyFor(
  e: GlobalEvent,
  taskId: string,
): { title: string; body: string } | null {
  const short = taskId.slice(0, 8);
  if (e.kind === "run-status" && e.taskId === taskId) {
    if (e.status === "succeeded") return { title: "Agetor — succeeded", body: short };
    if (e.status === "failed") return { title: "Agetor — failed", body: short };
    if (e.status === "orphaned") return { title: "Agetor — orphaned", body: short };
    return null; // cancelled: the user did it
  }
  if (e.kind === "column" && e.taskId === taskId && e.column === "blocked") {
    return {
      title: "Agetor — needs you",
      body: e.reason === "api-error" ? `${short} (API error)` : `${short} is waiting on you`,
    };
  }
  return null;
}

/** Best-effort macOS desktop notification + a terminal bell. Never throws. */
export function osNotify(title: string, body: string): void {
  process.stdout.write(BELL);
  const esc = (s: string) => s.replace(/["\\]/g, "\\$&");
  try {
    Bun.spawn(
      ["osascript", "-e", `display notification "${esc(body)}" with title "${esc(title)}"`],
      { stdout: "ignore", stderr: "ignore" },
    );
  } catch {
    /* osascript missing / not macOS — the bell still fired */
  }
}
