// Shared `react-markdown` `img` override that renders a markdown
// `![alt](src)` reference as a real inline image when `src` resolves to a
// local file, and degrades to a labeled chip otherwise (missing file,
// non-image extension, or a blank/unrecoverable src) — never the browser's
// broken-image glyph. One component backs every markdown surface in the
// webview (assistant/user bubbles, tagged segments, the plan-approval
// preview, PlanDialog, GitHub bodies — see `md-components.tsx`), per
// docs/plans/markdown-image-rendering.md D2.
//
// `MdImageScopeContext` exists because `react-markdown`'s `components.img`
// is invoked deep inside the render tree with no access to the surrounding
// task — `AssistantBlock` (RunPanel.tsx) has no task props to thread a
// `taskId`/roots pair through, and threading it via props would mean
// touching every intermediate component (`AssistantBlock`, `MessageSegments`,
// `TmuxPromptCard`, …) for one value. A context provided once around
// `RunEventList`'s body (and once in `PlanDialog`) reaches every consumer
// without prop drilling; `GitHubDialog` renders with the empty default scope
// since it has no task.
//
// Only inline elements (`span`/`img`/`button`) are ever returned for the
// image/chip content itself: the override renders inside a markdown `<p>`,
// and a block-level element there would both be invalid DOM nesting and
// defeat the `.agetor-md` owl-spacing rule (`index.css`, `> * + *`), which a
// wrapper `<div>` silently breaks.
//
// Candidates: a relative markdown ref (claude-code's ground truth, e.g.
// `docs/shot.png`) is resolved against the task's roots in order —
// worktree first, then workdir — so a task whose worktree was later torn
// down still finds the file via the source repo (D5). `MdImage` tries each
// absolute candidate as an `<img src>` in turn via `onError`, falling back
// to a warning chip only once every candidate has failed.
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type React from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { ImageOff } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";
import { iconForRef, refBasename } from "@/lib/file-icons";
import { classifyMdImageSrc } from "@/lib/md-image";
import { AttachmentNotFoundDialog, AttachmentOpenErrorDialog } from "./AttachmentDialogs";
import type { MdComponents } from "./md-components";

/** Task-scoped context `MdImage` reads to resolve a relative `src` and to
 *  pass `taskId` through to `api.openPath`/`api.openExternal`. */
export interface MdImageScope {
  taskId?: string;
  roots: readonly (string | null | undefined)[];
}

/** Default scope for a markdown surface with no task context (GitHub PR/
 *  issue/comment bodies) — relative refs there simply can't resolve and fall
 *  through to a `file` chip, matching A3 in the plan. */
export const EMPTY_MD_IMAGE_SCOPE: MdImageScope = Object.freeze({ roots: [] });

export const MdImageScopeContext = createContext<MdImageScope>(EMPTY_MD_IMAGE_SCOPE);

const IMAGE_CLASS =
  "max-h-96 max-w-full h-auto object-contain rounded-md border border-border/60 cursor-pointer align-middle";
const CAPTION_CLASS = "max-w-full truncate text-[10px] text-muted-foreground";
const FALLBACK_CHIP_CLASS =
  "inline-flex max-w-full items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] text-warning";
const FILE_CHIP_CLASS =
  "inline-flex max-w-full items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted/60";
const EMPTY_CHIP_CLASS =
  "inline-flex items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground";

/** Stop a click/keypress from doing anything the markdown container's own
 *  handlers would (e.g. `GitHubDialog` renders markdown inside clickable
 *  list rows — see `ghMdLink`'s comment in `GitHubDialog.tsx:132-135`),
 *  before running `run`. */
function stopAnd(
  e: MouseEvent | KeyboardEvent,
  run: () => void,
) {
  e.preventDefault();
  e.stopPropagation();
  run();
}

function isActivationKey(e: KeyboardEvent): boolean {
  return e.key === "Enter" || e.key === " ";
}

export const MdImage: NonNullable<MdComponents["img"]> = ({ src, alt, title, node: _node }) => {
  const { taskId, roots } = useContext(MdImageScopeContext);
  const source = useMemo(() => classifyMdImageSrc(src, roots), [src, roots]);

  const [candidateIndex, setCandidateIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  const [notFoundPath, setNotFoundPath] = useState<string | null>(null);
  const [openError, setOpenError] = useState<{ path: string; message: string } | null>(null);

  // A new `src` means a fresh classification — the previous candidate index
  // / failed flag belonged to the old one.
  useEffect(() => {
    setCandidateIndex(0);
    setFailed(false);
  }, [src]);

  const openLocalPath = async (path: string) => {
    try {
      const result = await api.openPath({ path, taskId });
      if (!result.opened) {
        setOpenError({ path, message: "The OS declined to open this file." });
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setNotFoundPath(path);
      } else {
        const message = e instanceof Error ? e.message : String(e);
        setOpenError({ path, message });
      }
    }
  };

  const openRemote = (url: string) => {
    void api.openExternal(url).catch((err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Could not open link");
    });
  };

  let content: React.ReactNode;

  if (source.kind === "empty") {
    content = (
      <span data-testid="md-image-empty" className={EMPTY_CHIP_CLASS}>
        <ImageOff className="size-3" aria-hidden />
        {alt || "image"}
      </span>
    );
  } else if (source.kind === "remote") {
    if (failed) {
      const label = alt || source.url;
      content = (
        <button
          type="button"
          data-testid="md-image-fallback"
          title={`Image not found: ${source.url}`}
          onClick={(e) => stopAnd(e, () => openRemote(source.url))}
          className={FALLBACK_CHIP_CLASS}
        >
          <ImageOff className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
        </button>
      );
    } else {
      content = (
        <span className="inline-flex max-w-full flex-col items-start gap-0.5 align-middle">
          <img
            data-testid="md-image"
            data-md-src={src}
            src={source.url}
            alt={alt ?? ""}
            title={title ?? source.url}
            loading="lazy"
            decoding="async"
            role="button"
            tabIndex={0}
            onClick={(e) => stopAnd(e, () => openRemote(source.url))}
            onKeyDown={(e) => {
              if (isActivationKey(e)) stopAnd(e, () => openRemote(source.url));
            }}
            onError={() => setFailed(true)}
            className={IMAGE_CLASS}
          />
          {alt && (
            <span data-testid="md-image-caption" className={CAPTION_CLASS}>
              {alt}
            </span>
          )}
        </span>
      );
    }
  } else if (source.kind === "file") {
    const Icon = iconForRef({ path: source.path, isDirectory: source.path.endsWith("/") });
    content = (
      <button
        type="button"
        data-testid="md-image-file"
        title={source.path}
        onClick={(e) =>
          stopAnd(e, () => void openLocalPath(source.candidates[0] ?? source.path))
        }
        className={FILE_CHIP_CLASS}
      >
        <Icon className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{refBasename(source.path)}</span>
      </button>
    );
  } else {
    // source.kind === "local"
    if (source.candidates.length === 0 || failed) {
      const path = source.path;
      content = (
        <button
          type="button"
          data-testid="md-image-fallback"
          title={`Image not found: ${path}`}
          onClick={(e) =>
            stopAnd(e, () => void openLocalPath(source.candidates[0] ?? path))
          }
          className={FALLBACK_CHIP_CLASS}
        >
          <ImageOff className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{refBasename(path)}</span>
        </button>
      );
    } else {
      const currentPath =
        source.candidates[candidateIndex] ?? source.candidates[0] ?? source.path;
      content = (
        <span className="inline-flex max-w-full flex-col items-start gap-0.5 align-middle">
          <img
            data-testid="md-image"
            data-md-src={src}
            data-path={currentPath}
            src={api.filePreviewUrl(currentPath)}
            alt={alt ?? ""}
            title={title ?? currentPath}
            loading="lazy"
            decoding="async"
            role="button"
            tabIndex={0}
            onClick={(e) => stopAnd(e, () => void openLocalPath(currentPath))}
            onKeyDown={(e) => {
              if (isActivationKey(e)) stopAnd(e, () => void openLocalPath(currentPath));
            }}
            onError={() => {
              setCandidateIndex((i) => {
                const next = i + 1;
                if (next < source.candidates.length) return next;
                setFailed(true);
                return i;
              });
            }}
            className={IMAGE_CLASS}
          />
          {alt && (
            <span data-testid="md-image-caption" className={CAPTION_CLASS}>
              {alt}
            </span>
          )}
        </span>
      );
    }
  }

  // The two dialogs are portaled to `document.body`: this component renders
  // inside a markdown `<p>`, and `Dialog` mounts a block-level `fixed`
  // backdrop when open — nesting that in a `<p>` is invalid HTML (React
  // warns in dev), and a non-portaled `fixed` element under the RunPanel
  // `<aside>`'s `translate-x` transform would be positioned relative to the
  // aside, not the viewport (same reason `ui/context-menu.tsx` portals).
  // While closed they render nothing, so the portal is inert.
  return (
    <>
      {content}
      {createPortal(
        <>
          <AttachmentNotFoundDialog path={notFoundPath} onClose={() => setNotFoundPath(null)} />
          <AttachmentOpenErrorDialog
            path={openError?.path ?? null}
            message={openError?.message ?? null}
            onClose={() => setOpenError(null)}
          />
        </>,
        document.body,
      )}
    </>
  );
};
