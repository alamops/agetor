// Renders the paths parsed from a user message's trailing "Referenced
// files/folders:" block as clickable chips below the message bubble — a real
// thumbnail for an image path, an icon chip (matching the existing
// command-branch idiom in RunPanel.tsx) for everything else.
//
// Kept dumb on purpose: the only state here is "which paths have proven to be
// missing" (so a broken thumbnail doesn't re-fetch on every render) and
// "which path's not-found dialog is open." All path-shape logic
// (`isImagePath`, basename, icon-by-extension) already lives in
// `src/shared/attachments.ts` / `src/mainview/lib/file-icons.tsx`.
import { useState } from "react";
import { ImageOff } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { iconForRef, refBasename } from "@/lib/file-icons";
import { isImagePath } from "../../../shared/attachments.ts";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const NOT_FOUND_TITLE_ID = "attachment-not-found-title";
const OPEN_ERROR_TITLE_ID = "attachment-open-error-title";

export function AttachmentChips({
  references,
  taskId,
}: {
  references: string[];
  /** Task whose worktree/workdir a relative path should resolve against —
   *  threaded through to `api.openPath` so a relative ref can resolve
   *  server-side instead of always requiring an absolute path. */
  taskId?: string;
}) {
  // Paths whose thumbnail failed to load, or whose openPath call 404'd (path
  // genuinely gone) — once known missing we skip re-hitting the server on a
  // repeat click and go straight to the not-found dialog. Cleared when that
  // dialog is dismissed so a later click retries rather than staying amber
  // forever (e.g. the file reappeared, or the first check raced a slow
  // mount).
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  const [notFoundPath, setNotFoundPath] = useState<string | null>(null);
  // Distinct from `notFoundPath`: any *other* openPath failure (headless
  // 501, a relative path with no resolvable cwd, an OS refusal via
  // `{opened:false}`, or a network error) — none of these mean the path is
  // gone, so the thumbnail must survive and stay clickable.
  const [openError, setOpenError] = useState<{ path: string; message: string } | null>(null);

  if (references.length === 0) return null;

  const markMissing = (path: string) => {
    setMissing((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
  };

  const handleClick = async (path: string) => {
    if (missing.has(path)) {
      setNotFoundPath(path);
      return;
    }
    try {
      const result = await api.openPath({ path, taskId });
      if (!result.opened) {
        // The server found the path but the OS declined to open it — not a
        // "missing" state, so the thumbnail must stay intact.
        setOpenError({ path, message: "The OS declined to open this file." });
      }
    } catch (e) {
      // A 404 from /open-path means the path genuinely doesn't exist
      // anymore — that's the only case worth remembering as "missing".
      // Anything else (501 headless, 400 relative-path-with-no-cwd, a
      // network failure) is a transient/environmental failure that says
      // nothing about whether the file exists, so don't poison the
      // thumbnail over it.
      if (e instanceof ApiError && e.status === 404) {
        markMissing(path);
        setNotFoundPath(path);
      } else {
        const message = e instanceof Error ? e.message : String(e);
        setOpenError({ path, message });
      }
    }
  };

  return (
    <>
      <div className="mt-1 flex flex-wrap gap-1">
        {references.map((path, index) => {
          const isDir = path.endsWith("/");
          if (!isDir && isImagePath(path)) {
            return (
              <ImageChip
                key={`${path}-${index}`}
                path={path}
                isMissing={missing.has(path)}
                onMissing={() => markMissing(path)}
                onClick={() => void handleClick(path)}
              />
            );
          }
          const Icon = iconForRef({ path, isDirectory: isDir });
          return (
            <button
              key={`${path}-${index}`}
              type="button"
              title={path}
              onClick={() => void handleClick(path)}
              className="inline-flex max-w-full items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted/60"
            >
              <Icon className="size-3 shrink-0" />
              <span className="truncate">{refBasename(path)}</span>
            </button>
          );
        })}
      </div>

      <Dialog
        open={notFoundPath !== null}
        onClose={() => {
          setNotFoundPath(null);
          // Retry on a later click/render instead of staying permanently
          // amber — the underlying file may have reappeared since.
          setMissing((prev) => {
            if (notFoundPath === null || !prev.has(notFoundPath)) return prev;
            const next = new Set(prev);
            next.delete(notFoundPath);
            return next;
          });
        }}
        labelledBy={NOT_FOUND_TITLE_ID}
        className="max-w-md"
      >
        <h2 id={NOT_FOUND_TITLE_ID} className="text-sm font-semibold">
          Attachment not found
        </h2>
        <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
          {notFoundPath}
        </p>
        <div className="mt-4 flex justify-end">
          <Button size="sm" variant="outline" onClick={() => setNotFoundPath(null)}>
            Close
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={openError !== null}
        onClose={() => setOpenError(null)}
        labelledBy={OPEN_ERROR_TITLE_ID}
        className="max-w-md"
      >
        <h2 id={OPEN_ERROR_TITLE_ID} className="text-sm font-semibold">
          Couldn't open attachment
        </h2>
        <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
          {openError?.path}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">{openError?.message}</p>
        <div className="mt-4 flex justify-end">
          <Button size="sm" variant="outline" onClick={() => setOpenError(null)}>
            Close
          </Button>
        </div>
      </Dialog>
    </>
  );
}

function ImageChip({
  path,
  isMissing,
  onMissing,
  onClick,
}: {
  path: string;
  isMissing: boolean;
  onMissing: () => void;
  onClick: () => void;
}) {
  const base = refBasename(path);

  if (isMissing) {
    return (
      <button
        type="button"
        title={`Image not found: ${path}`}
        onClick={onClick}
        className="inline-flex max-w-full items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-500"
      >
        <ImageOff className="size-3 shrink-0" />
        <span className="truncate">{base}</span>
      </button>
    );
  }

  return (
    <button type="button" title={path} onClick={onClick} className="group">
      <img
        src={api.filePreviewUrl(path)}
        alt={base}
        onError={onMissing}
        loading="lazy"
        decoding="async"
        className="h-16 max-w-40 rounded-md border border-border/60 object-cover transition group-hover:ring-2 group-hover:ring-primary/40"
      />
    </button>
  );
}
