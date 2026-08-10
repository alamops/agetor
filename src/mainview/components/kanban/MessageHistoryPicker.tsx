import { useEffect, useRef, useState } from "react";
import { History } from "lucide-react";
import { api, type SentMessageItem } from "@/lib/api";
import { parseUserMessage, splitReferences } from "@/lib/command-message";
import { canonicalizeAttachmentText } from "../../../shared/attachments.ts";
import { cn } from "@/lib/utils";

/** Server-side fetch clamp is 200 (see `api.fetchMessageHistory`); the list
 *  itself displays only the most recent `DISPLAY_LIMIT` after cleaning, since
 *  dedup/empty/command-output filtering can otherwise silently under-fill a
 *  server-LIMIT-50 fetch. */
const DISPLAY_LIMIT = 50;
const FETCH_LIMIT = 200;

interface Props {
  taskId: string;
  disabled?: boolean;
  onPick: (text: string) => void;
  className?: string;
}

interface CleanedItem {
  key: string;
  text: string;
  ts: number;
  taskTitle: string;
  project: string;
  agent: string;
}

/** Reduce a raw sent-message payload to display text: normalize CR newlines,
 *  canonicalize the image-attachment twin shapes (shared with
 *  `eventDedupKey` in `lib/event-dedup.ts`) BEFORE parsing so an
 *  image-attached send's live copy and its JSONL twin — which otherwise
 *  diverge via a `[Image #N]` prefix and a blanked reference-bullet path —
 *  reduce to identical text and collapse under the caller's dedup-by-text
 *  loop, then unwrap a slash-command XML expansion back to its plain
 *  "/cmd args" echo (same shape `parseUserMessage`/`canonicalizeUserText`
 *  use elsewhere for the run stream), then strip a trailing "Referenced
 *  files" block via the shared splitter so its heading text never gets
 *  re-typed here. */
function cleanMessageText(raw: string): string {
  const text = canonicalizeAttachmentText(raw.replace(/\r\n?/g, "\n"));
  const parsed = parseUserMessage(text);
  let display: string;
  if (parsed?.kind === "command") {
    display = parsed.command.args
      ? `${parsed.command.name} ${parsed.command.args}`
      : parsed.command.name;
    return display.trim();
  }
  if (parsed?.kind === "command-output") {
    // Local-command stdout is not a user-authored message — drop it (the
    // caller's `if (!text) continue` filter relies on the empty string).
    return "";
  }
  const { args } = splitReferences(text);
  return args.trim();
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Small popover, triggered by a `History` icon button, listing past sent
 * messages across all tasks and harnesses (server-provided, coarsely
 * deduped) so the user can re-insert one into the composer instead of
 * retyping it.
 *
 * Client-side cleaning collapses the remaining duplicate shapes the server
 * can't see cheaply: a slash-command send shows up twice in claude-code's
 * transcript — once as the live plain-text echo, once as claude's JSONL XML
 * expansion of the same send (see `command-message.ts`'s header comment) —
 * and either shape may carry a trailing "Referenced files" block that
 * shouldn't be replayed verbatim. Both are normalized here, then deduped by
 * cleaned text (first occurrence wins — items arrive newest-first).
 */
export function MessageHistoryPicker({ taskId, disabled, onPick, className }: Props) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<CleanedItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Reset when the caller swaps which task this picker is scoped to — the
  // run panel doesn't remount across a task switch, so stale items/open
  // state would otherwise leak across tasks.
  useEffect(() => {
    setOpen(false);
    setItems(null);
    setError(null);
  }, [taskId]);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Refetch on every open — no items-cache guard. A previous version bailed
  // once `items !== null`, which fetched the list once per task selection
  // and never refreshed, so messages sent after the first open never showed
  // up. Previous items are left in place while the refetch is in flight (no
  // clearing here) purely to avoid a loading flicker; fresh data replaces
  // them once the fetch lands.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Reset at effect start (not just in `.finally`) so a fetch cancelled
    // mid-flight (e.g. the popover closes and reopens before the previous
    // fetch resolves) can never leave `loading` stuck true — the next open
    // always gets its own fresh `true`→settle cycle regardless of how the
    // prior one ended.
    setLoading(true);
    setError(null);
    api.fetchMessageHistory(taskId, FETCH_LIMIT)
      .then((res: { messages: SentMessageItem[] }) => {
        if (cancelled) return;
        const seen = new Set<string>();
        const cleaned: CleanedItem[] = [];
        for (const m of res.messages) {
          const text = cleanMessageText(m.text);
          if (!text) continue;
          if (seen.has(text)) continue;
          seen.add(text);
          cleaned.push({ key: String(m.id), text, ts: m.ts, taskTitle: m.taskTitle, project: m.project, agent: m.agent });
        }
        // Cap AFTER cleaning/dedup — the server's own LIMIT (FETCH_LIMIT) is
        // taken before dedup/empty/command-output filtering can drop rows,
        // so capping the raw response at DISPLAY_LIMIT would silently
        // under-fill the list.
        setItems(cleaned.slice(0, DISPLAY_LIMIT));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load message history.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, taskId]);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title="Insert a past message"
        aria-label="Insert a past message"
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "inline-flex items-center justify-center rounded-md p-1 text-muted-foreground",
          "hover:bg-accent hover:text-foreground disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
          open && "bg-accent text-foreground",
        )}
      >
        <History className="size-3.5" />
      </button>

      {open && (
        <div
          // Marker for RunPanel's global Escape handler so it yields to this
          // popover instead of closing the whole panel underneath it.
          data-popover-open=""
          // This repo defines no `bg-popover`/`text-popover-foreground`
          // tokens (see tailwind.config.js / index.css) — those classes emit
          // no CSS and rendered the dropdown transparent. `bg-card` /
          // `text-card-foreground` is the actual popover convention used
          // elsewhere (see search-select.tsx).
          className="absolute bottom-full right-0 z-50 mb-1 w-80 max-h-64 overflow-y-auto rounded-md border border-border bg-card text-card-foreground shadow-xl"
        >
          {loading && (
            <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
          )}
          {!loading && error && (
            <p className="px-3 py-2 text-xs text-destructive">{error}</p>
          )}
          {!loading && !error && items !== null && items.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No past messages yet.
            </p>
          )}
          {!loading && !error && items !== null && items.length > 0 && (
            <ul className="py-1" role="listbox">
              {items.map((item) => (
                <li key={item.key} role="option" aria-selected={false}>
                  <button
                    type="button"
                    onClick={() => {
                      onPick(item.text);
                      setOpen(false);
                    }}
                    className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left hover:bg-accent"
                  >
                    <span className="line-clamp-2 text-xs text-foreground">{item.text}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {item.project} · {item.taskTitle} · {item.agent} · {formatTime(item.ts)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
