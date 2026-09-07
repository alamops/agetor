// "Files sent to you" card — replaces the generic `ToolUseBlock` for a
// `SendUserFile` tool_use, the way `PlanCard`/`TodoProgressCard` substitute
// for their own tool families. Self-contained: derivation is the pure
// `src/mainview/lib/sent-files-view.ts` module (unit-tested directly, no
// jsdom in this repo), rendering lives here. Historical transcripts render
// too — everything needed comes from the persisted tool_use `input` (plus,
// when it has already arrived, the tool_result), never from reprocessing.
//
// Mirrors `AttachmentChips.tsx`'s idiom for the two ways a click can fail:
// a definite 404 (`AttachmentNotFoundDialog`, and the tile is remembered as
// missing so a repeat click skips the round trip) vs. any other failure
// (`AttachmentOpenErrorDialog` — the OS declined, headless 501, a network
// error — none of which mean the file is actually gone).
import { useEffect, useMemo, useState } from "react";
import { FileImage, FileWarning, ImageOff, MoreHorizontal, Paperclip } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { iconForRef } from "@/lib/file-icons";
import { cn } from "@/lib/utils";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { CHECKERBOARD_STYLE } from "./BinaryFilePreview";
import { AttachmentNotFoundDialog, AttachmentOpenErrorDialog } from "./AttachmentDialogs";
import {
  buildSentFileTiles,
  sentFilesStatus,
  type PathStats,
  type SentFileTile,
} from "@/lib/sent-files-view";
import {
  formatByteSize,
  parseSentFilesToolResult,
  parseSentFilesToolUse,
} from "../../../shared/sent-files.ts";
import type { ToolResultAttachment } from "../../../shared/types.ts";

/** Structural subset of a parsed `tool_use` event — RunPanel's own
 *  `ParsedToolUse` type is module-private, so this card declares just the
 *  fields it needs. */
interface SentFilesToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** Structural subset of the matching `tool_result` event, once it has
 *  arrived (`undefined`/`null` while the send is still in flight). */
interface SentFilesToolResultData {
  toolUseId: string;
  content: unknown;
  isError?: boolean;
  attachments?: ToolResultAttachment[];
}

export interface SentFilesCardProps {
  call: SentFilesToolCall;
  result?: SentFilesToolResultData | null;
  /** Threaded through to `api.openPath`/`api.revealPath` so a relative path
   *  (allowed by the tool, never observed in practice) can resolve against
   *  the task's cwd server-side. */
  taskId?: string;
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

function subLineFor(tile: SentFileTile, isNotFound: boolean): string {
  if (isNotFound) return "missing";
  if (tile.kind === "folder") return "folder";
  if (tile.size !== null) return formatByteSize(tile.size);
  return " ";
}

function Tile({
  tile,
  isNotFound,
  isPreviewFailed,
  onPreviewFail,
  onClick,
  onOpenMenu,
}: {
  tile: SentFileTile;
  /** A confirmed-gone path (a 404 from openPath/revealPath, or a resolveRefs
   *  stat that came back without this path) — gates the click to the
   *  not-found dialog and drives the dimmed "missing" treatment. */
  isNotFound: boolean;
  /** The tile's own thumbnail failed to load, independent of whether the
   *  file itself still exists. Swaps the glyph for `ImageOff` but never
   *  gates the click or shows "missing" — a broken preview request is not
   *  proof the underlying file is gone. */
  isPreviewFailed: boolean;
  onPreviewFail: (path: string) => void;
  onClick: () => void;
  onOpenMenu: (path: string, x: number, y: number) => void;
}) {
  let preview: React.ReactNode;
  if (isNotFound) {
    const Icon = tile.kind === "image" ? ImageOff : FileWarning;
    preview = <Icon className="size-8 text-warning" aria-hidden />;
  } else if (tile.previewable) {
    preview = isPreviewFailed ? (
      <ImageOff className="size-8 text-muted-foreground" aria-hidden />
    ) : (
      <img
        src={api.filePreviewUrl(tile.path)}
        alt={tile.name}
        loading="lazy"
        decoding="async"
        className="size-full object-contain"
        style={CHECKERBOARD_STYLE}
        onError={() => onPreviewFail(tile.path)}
      />
    );
  } else if (tile.kind === "image") {
    // `kind === "image"` but the path's own extension isn't a canonical
    // image one (an attachment/mediaType said "image" for e.g. an
    // extensionless temp path) — `/files/preview` 400s on any path
    // `isImagePath` rejects, so don't even attempt the thumbnail request.
    preview = <FileImage className="size-8 text-muted-foreground" aria-hidden />;
  } else {
    const Icon = iconForRef({ path: tile.path, isDirectory: tile.kind === "folder" });
    preview = <Icon className="size-8 text-muted-foreground" aria-hidden />;
  }

  return (
    <div className="relative group">
      <button
        type="button"
        data-testid="sent-file-tile"
        data-path={tile.path}
        data-kind={tile.kind}
        title={tile.path}
        aria-label={`Open ${tile.name}`}
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onOpenMenu(tile.path, e.clientX, e.clientY);
        }}
        className={cn(
          "flex w-full flex-col items-center gap-1 rounded-md border border-border/60 bg-muted/20 p-1.5 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          isNotFound && "opacity-70",
        )}
      >
        <div className="size-20 flex items-center justify-center overflow-hidden rounded">
          {preview}
        </div>
        <span className="w-full truncate text-center text-xs">{tile.name}</span>
        <span className="text-[10px] text-muted-foreground">{subLineFor(tile, isNotFound)}</span>
      </button>
      <button
        type="button"
        data-testid="sent-file-tile-menu"
        aria-label="File actions"
        onClick={(e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          onOpenMenu(tile.path, rect.left, rect.bottom);
        }}
        className="absolute right-1 top-1 rounded bg-card/80 p-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100"
      >
        <MoreHorizontal className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

export function SentFilesCard({ call, result, taskId }: SentFilesCardProps) {
  const req = useMemo(
    () => parseSentFilesToolUse(call.name, call.input),
    [call.id, call.name, call.input],
  );

  const res = useMemo(
    () =>
      result
        ? parseSentFilesToolResult(result.content, result.isError, result.attachments)
        : null,
    [result?.toolUseId, result?.content, result?.isError, result?.attachments],
  );

  // Stable primitive derived from `req` for the stat-fetch effect below.
  // `req` itself is a fresh object every time RunPanel's blocks-memo
  // recomputes (every streamed chunk re-parses the persisted tool_use JSON),
  // so keying the effect on `req`'s identity would re-issue `/refs/resolve`
  // on every chunk even when the file list never changed. `call.name` is
  // constant for a mounted card, so joining `req.files` alone is enough to
  // detect an actual change in the path set.
  const filesKey = req ? req.files.join("\n") : "";

  const [stats, setStats] = useState<PathStats | null>(null);
  // A path a click has proven is gone (a 404 from openPath/revealPath, or a
  // `/refs/resolve` stat that came back without it) — gates the click to the
  // not-found dialog and drives the dimmed "missing" sub-line. Cleared only
  // when a later stat reports the path present again or an open/reveal
  // succeeds — never merely by dismissing the not-found dialog (the file
  // hasn't necessarily reappeared just because the dialog closed).
  const [notFound, setNotFound] = useState<ReadonlySet<string>>(new Set());
  // A path whose `<img>` thumbnail failed to load — independent of whether
  // the file itself still exists (a corrupt/unsupported image, a transient
  // `/files/preview` hiccup, …). Only swaps the tile's glyph to `ImageOff`;
  // never gates the click and never renders the "missing" sub-line.
  const [previewFailed, setPreviewFailed] = useState<ReadonlySet<string>>(new Set());
  const [notFoundPath, setNotFoundPath] = useState<string | null>(null);
  const [openError, setOpenError] = useState<{ path: string; message: string } | null>(null);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!req) return;
    const absPaths = Array.from(new Set(req.files.filter((p) => p.startsWith("/"))));
    if (absPaths.length === 0) return;
    let cancelled = false;
    void api
      .resolveRefs(absPaths)
      .then((refs) => {
        if (cancelled) return;
        setStats(new Map(refs.map((r) => [r.path, { isDirectory: r.isDirectory }])));
      })
      .catch(() => {
        // Resolution failed (network hiccup, headless quirk) — leave stats
        // as-is. Unknown must never be treated as "missing".
      });
    return () => {
      cancelled = true;
    };
    // Re-stat once the send is confirmed delivered too — a temp file can
    // land on disk between the tool_use and its tool_result.
  }, [filesKey, res?.delivered]);

  // Once a fresh stat confirms a previously-notFound path is actually
  // present again, drop it from `notFound` — the dialog-close path
  // deliberately does NOT do this (see `notFound`'s own comment above).
  useEffect(() => {
    if (!stats || stats.size === 0) return;
    setNotFound((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set(prev);
      for (const path of prev) {
        if (stats.has(path)) {
          next.delete(path);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [stats]);

  if (!req) return null;

  const tiles = buildSentFileTiles(req, res, stats);
  const status = sentFilesStatus(req, res);

  const markNotFound = (path: string) => {
    setNotFound((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
  };

  const clearNotFound = (path: string) => {
    setNotFound((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  };

  const markPreviewFailed = (path: string) => {
    setPreviewFailed((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
  };

  const handleOpenOrReveal = async (path: string, action: "open" | "reveal") => {
    try {
      const ok =
        action === "open"
          ? (await api.openPath({ path, taskId })).opened
          : (await api.revealPath({ path, taskId })).revealed;
      if (ok) {
        // The path resolved and the OS accepted it — it's definitely not
        // gone, even if it was previously marked `notFound` (the file may
        // have reappeared, or the first check raced a slow mount).
        clearNotFound(path);
      } else {
        setOpenError({
          path,
          message:
            action === "open"
              ? "The OS declined to open this file."
              : "The OS declined to reveal this file.",
        });
      }
    } catch (e) {
      // A 404 means the path genuinely no longer exists — anything else
      // (headless 501, a relative path with no resolvable cwd, a network
      // failure) says nothing about whether the file exists.
      if (e instanceof ApiError && e.status === 404) {
        markNotFound(path);
        setNotFoundPath(path);
      } else {
        const message = e instanceof Error ? e.message : String(e);
        setOpenError({ path, message });
      }
    }
  };

  const handleTileClick = (tile: SentFileTile) => {
    if (notFound.has(tile.path) || tile.exists === false) {
      setNotFoundPath(tile.path);
      return;
    }
    void handleOpenOrReveal(tile.path, "open");
  };

  const openMenu = (path: string, x: number, y: number) => setMenu({ path, x, y });

  const menuItems: ContextMenuItem[] = menu
    ? [
        {
          id: "open",
          label: "Open",
          onSelect: () => {
            void handleOpenOrReveal(menu.path, "open");
          },
        },
        {
          id: "reveal",
          label: "Reveal in Finder",
          onSelect: () => {
            void handleOpenOrReveal(menu.path, "reveal");
          },
        },
        {
          id: "copy",
          label: "Copy path",
          onSelect: () => {
            // `writeText` returns a promise that rejects on a denied
            // clipboard permission — a bare try/catch around the call
            // doesn't catch that rejection, so chain `.catch` explicitly.
            void navigator.clipboard?.writeText(menu.path).catch(() => {
              // Best-effort — no destination to report a clipboard failure to.
            });
          },
        },
      ]
    : [];

  return (
    <div
      data-testid="sent-files-card"
      data-tool-use-id={call.id}
      className={cn(
        "rounded-md border border-border/60 bg-card p-3",
        status.tone === "error" && "border-danger/60",
        status.tone === "warning" && "border-warning/60",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium">Files sent to you</span>
        <span className="text-xs text-muted-foreground">
          {tiles.length} {tiles.length === 1 ? "file" : "files"}
        </span>
        {req.display === "attach" && <Pill>attachment</Pill>}
        {req.status === "proactive" && <Pill>proactive</Pill>}
      </div>

      {req.caption && <p className="mt-1 whitespace-pre-wrap break-words text-sm">{req.caption}</p>}

      <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-2">
        {tiles.map((tile) => (
          <Tile
            key={tile.path}
            tile={tile}
            isNotFound={notFound.has(tile.path) || tile.exists === false}
            isPreviewFailed={previewFailed.has(tile.path)}
            onPreviewFail={markPreviewFailed}
            onClick={() => handleTileClick(tile)}
            onOpenMenu={openMenu}
          />
        ))}
      </div>

      <div
        data-testid="sent-files-status"
        className={cn(
          "mt-2 text-xs",
          status.tone === "success" && "text-success",
          status.tone === "pending" && "text-muted-foreground",
          status.tone === "error" && "text-danger",
          status.tone === "warning" && "text-warning",
        )}
      >
        {status.text}
      </div>

      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems}
        onClose={() => setMenu(null)}
        label="File actions"
        testId="sent-file-menu"
      />

      <AttachmentNotFoundDialog
        path={notFoundPath}
        // Deliberately does NOT clear `notFound` here — see that state's own
        // comment above. Dismissing the dialog (Escape, backdrop, or the
        // Close button) only closes it; the path stays remembered as gone
        // until a fresh stat or a successful open proves otherwise.
        onClose={() => setNotFoundPath(null)}
      />
      <AttachmentOpenErrorDialog
        path={openError?.path ?? null}
        message={openError?.message ?? null}
        onClose={() => setOpenError(null)}
      />
    </div>
  );
}
