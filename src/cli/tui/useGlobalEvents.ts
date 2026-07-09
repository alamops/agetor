import { useEffect, useRef, useState } from "react";
import { streamSse } from "../sse.ts";
import type { GlobalEvent } from "../../shared/types.ts";

export interface Toast {
  text: string;
  color: string;
}

const TOAST_MS = 4000;

/**
 * Subscribe to the global event stream (`GET /events`) and surface the latest
 * noteworthy transition as a transient toast — the dashboard equivalent of the
 * app's success/fail/needs-you notifications. Auto-clears after a few seconds.
 */
export function useGlobalEvents(dataDir?: string): Toast | null {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handle = streamSse<GlobalEvent>(
      "/events",
      (e) => {
        const t = toastFor(e);
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

export function toastFor(e: GlobalEvent): Toast | null {
  const short = (id: string) => id.slice(0, 8);
  if (e.kind === "run-status") {
    if (e.status === "succeeded") return { text: `✓ ${short(e.taskId)} succeeded`, color: "green" };
    if (e.status === "failed") return { text: `✗ ${short(e.taskId)} failed`, color: "red" };
    if (e.status === "orphaned") return { text: `… ${short(e.taskId)} orphaned`, color: "yellow" };
    return null; // cancelled — no toast (the user did it)
  }
  if (e.kind === "column" && e.column === "blocked") {
    const why = e.reason === "api-error" ? " (API error)" : "";
    return { text: `! ${short(e.taskId)} needs you${why}`, color: "yellow" };
  }
  return null;
}
