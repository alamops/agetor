import { useCallback, useEffect, useReducer, useRef } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { formatHarnessSwapEvent } from "../../../shared/harness-stack.ts";
import type { HarnessSwapEvent, HarnessSwapHistoryPage } from "../../../shared/types.ts";

const PAGE = 50;

interface Props {
  stackId: string;
  stackLabel: string;
}

export interface HistoryState {
  events: HarnessSwapEvent[];
  cursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  /** Which action produced the error, so Retry repeats that one. */
  failedAction: "load" | "more";
  /** The request generation answers must carry to land: a refresh starts a
   *  new one, which drops the answer of anything it superseded. */
  generation: number;
}

export type HistoryAction =
  | { type: "load"; generation: number }
  | { type: "more"; generation: number }
  | { type: "page"; generation: number; page: Pick<HarnessSwapHistoryPage, "events" | "nextCursor">; append: boolean }
  | { type: "failed"; generation: number; action: "load" | "more"; message: string };

export const INITIAL_HISTORY_STATE: HistoryState = {
  events: [],
  cursor: null,
  loading: true,
  loadingMore: false,
  error: null,
  failedAction: "load",
  generation: 0,
};

/**
 * The history pager's state machine. A refresh (`load`) supersedes a "Load
 * more" still in flight: its answer is dropped by the generation check, so the
 * refresh must clear `loadingMore` itself, or the button would stay on
 * "Loading…" for good.
 */
export function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case "load":
      return { ...state, generation: action.generation, loading: true, loadingMore: false, error: null };
    case "more":
      if (action.generation !== state.generation) return state;
      return { ...state, loadingMore: true, error: null };
    case "page":
      if (action.generation !== state.generation) return state;
      return {
        ...state,
        events: action.append ? [...state.events, ...action.page.events] : action.page.events,
        cursor: action.page.nextCursor,
        loading: action.append ? state.loading : false,
        loadingMore: action.append ? false : state.loadingMore,
      };
    case "failed":
      if (action.generation !== state.generation) return state;
      return {
        ...state,
        error: action.message,
        failedAction: action.action,
        loading: action.action === "load" ? false : state.loading,
        loadingMore: action.action === "more" ? false : state.loadingMore,
      };
  }
}

/**
 * The swap history of one stack, newest first, cursor-paged. It loads on
 * mount and on the refresh button only (no stream); the dialog mounts it only
 * while the History subpage is on screen, so a reopened dialog never shows a
 * previous fetch.
 */
export function StackHistory({ stackId, stackLabel }: Props) {
  const [state, dispatch] = useReducer(historyReducer, INITIAL_HISTORY_STATE);
  const { events, cursor, loading, loadingMore, error, failedAction } = state;
  // Drops the answer of a request the user has since superseded (refresh,
  // another stack, unmount); the reducer checks the same number.
  const generation = useRef(0);

  const load = useCallback(() => {
    const mine = ++generation.current;
    dispatch({ type: "load", generation: mine });
    api.getHarnessStackHistory(stackId, { limit: PAGE })
      .then((page) => {
        if (generation.current !== mine) return;
        dispatch({ type: "page", generation: mine, page, append: false });
      })
      .catch((e) => {
        if (generation.current !== mine) return;
        dispatch({ type: "failed", generation: mine, action: "load", message: e instanceof Error ? e.message : String(e) });
      });
  }, [stackId]);

  useEffect(() => {
    load();
    return () => { generation.current++; };
  }, [load]);

  // A page requested during a refresh would be appended to the refreshed
  // list from the old cursor, so "Load more" waits for the refresh.
  const loadMore = () => {
    if (!cursor || loadingMore || loading) return;
    const mine = generation.current;
    dispatch({ type: "more", generation: mine });
    api.getHarnessStackHistory(stackId, { limit: PAGE, before: cursor })
      .then((page) => {
        if (generation.current !== mine) return;
        dispatch({ type: "page", generation: mine, page, append: true });
      })
      .catch((e) => {
        if (generation.current !== mine) return;
        dispatch({ type: "failed", generation: mine, action: "more", message: e instanceof Error ? e.message : String(e) });
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
          <Button size="sm" variant="outline" onClick={failedAction === "more" && cursor ? loadMore : load}>
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
        <Button size="sm" variant="outline" onClick={loadMore} disabled={loadingMore || loading}>
          {loadingMore ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}
