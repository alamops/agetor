import { useEffect, useRef, useState } from "react";
import { streamSse } from "../sse.ts";
import type { GlobalEvent } from "../../shared/types.ts";
import { eventPipelineParentId } from "../notify.ts";

export interface Toast {
  text: string;
  color: string;
}

const TOAST_MS = 4000;

/**
 * Subscribe to the global event stream (`GET /events`) and surface the latest
 * noteworthy transition as a transient toast — the dashboard equivalent of the
 * app's success/fail/needs-you notifications. Auto-clears after a few seconds.
 *
 * `hiddenTaskIds` — a pipeline's hidden step tasks (`pipelineParentId` set),
 * same set the dashboard already filters out of its board (D11,
 * `docs/plans/pipelines.md`) — is threaded through to {@link toastFor} so a
 * step task's own run-status/blocked events never surface a toast naming a
 * task id the user can't find on the board; the pipeline parent's own
 * `column`/`pipeline`-run events cover the same information at the level the
 * user actually sees.
 */
export function useGlobalEvents(dataDir?: string, hiddenTaskIds?: ReadonlySet<string>): Toast | null {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read via a ref inside the subscription callback so a `tasks` poll tick
  // (which recomputes the caller's Set) never has to tear down and
  // re-establish the SSE connection.
  const hiddenRef = useRef(hiddenTaskIds);
  hiddenRef.current = hiddenTaskIds;

  useEffect(() => {
    const handle = streamSse<GlobalEvent>(
      "/events",
      (e) => {
        const t = toastFor(e, hiddenRef.current);
        if (!t) return;
        setToast(t);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setToast(null), TOAST_MS);
      },
      { dataDir },
    );
    return () => {
      handle.close();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [dataDir]);

  return toast;
}

export function toastFor(e: GlobalEvent, hiddenTaskIds?: ReadonlySet<string>): Toast | null {
  const short = (id: string) => id.slice(0, 8);
  // Hidden pipeline step task — the parent's own events cover it. The
  // event's own `pipelineParentId` stamp is consulted FIRST so a step that
  // settles before the dashboard ever polled its row is still hidden; the
  // `hiddenTaskIds` lookup is the fallback for an older core.
  const hidden = (taskId: string) => eventPipelineParentId(e) !== null || hiddenTaskIds?.has(taskId) === true;
  if (e.kind === "run-status") {
    if (hidden(e.taskId)) return null;
    if (e.status === "succeeded") return { text: `✓ ${short(e.taskId)} succeeded`, color: "green" };
    if (e.status === "failed") return { text: `✗ ${short(e.taskId)} failed`, color: "red" };
    if (e.status === "orphaned") return { text: `… ${short(e.taskId)} orphaned`, color: "yellow" };
    return null; // cancelled — no toast (the user did it)
  }
  if (e.kind === "column" && e.column === "blocked") {
    if (hidden(e.taskId)) return null;
    const why = e.reason === "api-error" ? " (API error)" : "";
    return { text: `! ${short(e.taskId)} needs you${why}`, color: "yellow" };
  }
  return null;
}
