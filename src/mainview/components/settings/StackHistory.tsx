import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { formatHarnessSwapEvent } from "../../../shared/harness-stack.ts";
import type { HarnessSwapEvent } from "../../../shared/types.ts";

const PAGE = 50;

interface Props {
  stackId: string;
  stackLabel: string;
}

/**
 * The swap history of one stack, newest first, cursor-paged. It loads on
 * mount and on the refresh button only (no stream); the dialog mounts it only
 * while the History subpage is on screen, so a reopened dialog never shows a
 * previous fetch.
 */
export function StackHistory({ stackId, stackLabel }: Props) {
  const [events, setEvents] = useState<HarnessSwapEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Drops the answer of a request the user has since superseded (refresh,
  // another stack, unmount).
  const generation = useRef(0);

  const load = useCallback(() => {
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    api.getHarnessStackHistory(stackId, { limit: PAGE })
      .then((page) => {
        if (generation.current !== mine) return;
        setEvents(page.events);
        setCursor(page.nextCursor);
      })
      .catch((e) => {
        if (generation.current !== mine) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (generation.current === mine) setLoading(false);
      });
  }, [stackId]);

  useEffect(() => {
    load();
    return () => { generation.current++; };
  }, [load]);

  const loadMore = () => {
    if (!cursor || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    setError(null);
    api.getHarnessStackHistory(stackId, { limit: PAGE, before: cursor })
      .then((page) => {
        if (generation.current !== mine) return;
        setEvents((prev) => [...prev, ...page.events]);
        setCursor(page.nextCursor);
      })
      .catch((e) => {
        if (generation.current !== mine) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (generation.current === mine) setLoadingMore(false);
      });
  };

  return (
    <div className="space-y-3 pt-3 text-sm" data-testid="harness-stack-history">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate font-medium">Account switches in {stackLabel}</p>
        <Button size="sm" variant="outline" onClick={load} disabled={loading} aria-label="Refresh history">
          <RefreshCw className="mr-1 size-3.5" /> Refresh
        </Button>
      </div>

      {loading && events.length === 0 && !error && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading history…
        </p>
      )}

      {error && (
        <div role="alert" className="flex items-center gap-2 text-xs text-danger">
          <span className="min-w-0 flex-1">Couldn't load the history: {error}</span>
          <Button size="sm" variant="outline" onClick={events.length > 0 && cursor ? loadMore : load}>
            Retry
          </Button>
        </div>
      )}

      {!loading && !error && events.length === 0 && (
        <p className="text-xs text-muted-foreground">No account switches yet.</p>
      )}

      {events.length > 0 && (
        <ul className="divide-y divide-border/40 rounded-md border border-border/60">
          {events.map((e) => (
            <li key={e.id} className="space-y-0.5 px-3 py-2">
              <div className="flex items-baseline gap-2">
                <time
                  className="shrink-0 font-mono text-[11px] text-muted-foreground"
                  dateTime={new Date(e.at).toISOString()}
                >
                  {new Date(e.at).toLocaleString()}
                </time>
                <span className="min-w-0 flex-1">{formatHarnessSwapEvent(e)}</span>
              </div>
              {e.taskTitle && (
                <p className="truncate text-[11px] text-muted-foreground" title={e.taskTitle}>
                  Task: {e.taskTitle}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {cursor && (
        <Button size="sm" variant="outline" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}
