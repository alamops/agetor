// Clickable handoff artifacts (`docs/plans/formatted-handoff.md` D6/D7/D20):
// chips on the transcript card, a full list in the modal. A path opens in the
// OS default app (Reveal in Finder / Copy path on right-click), a URL in the
// browser, and free text — modal only — gets a Copy button.
//
// Existence comes from ONE cached, batched `/refs/resolve` per artifact set
// (`useArtifactStats`); a chip is dimmed as missing only when that stat (or a
// 404 on every candidate) proves it — unknown is never missing. Opening mirrors
// `SentFilesCard`/`AttachmentChips`: a 404 on every candidate shows
// `AttachmentNotFoundDialog`, any other failure (headless 501, the OS
// declining, a network error) `AttachmentOpenErrorDialog`. Both dialogs are
// portaled to `document.body` like `MdImage`'s: a chip renders inside the
// transcript (or the handoff modal), and a non-portaled `fixed` dialog under
// RunPanel's transformed `<aside>` would position against the aside.
import { useCallback, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, FileWarning, Link as LinkIcon, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { iconForRef } from "@/lib/file-icons";
import { cn } from "@/lib/utils";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { AttachmentNotFoundDialog, AttachmentOpenErrorDialog } from "@/components/kanban/AttachmentDialogs";
import type { HandoffArtifact } from "@/lib/handoff-artifacts";
import {
  artifactCandidatePaths,
  artifactOpenOrder,
  artifactPrimaryPath,
  pathArtifactStatus,
  type ArtifactStatsMap,
} from "@/lib/handoff-artifact-status";
import { useArtifactStats } from "@/lib/use-artifact-stats";
import { useHandoffView } from "./handoff-context";

type PathArtifact = Extract<HandoffArtifact, { kind: "path" }>;
type UrlArtifact = Extract<HandoffArtifact, { kind: "url" }>;
type LinkArtifact = PathArtifact | UrlArtifact;

/** The visible label of a path or URL artifact: the path as the agent wrote
 *  it plus its line anchor (shown, never used to open — D20), or the URL. */
export function artifactLabel(a: LinkArtifact): string {
  return a.kind === "path" ? (a.line ? `${a.display}:${a.line}` : a.display) : a.url;
}

/** Copy `text` to the clipboard; a refusal (denied permission) toasts. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast.error("Couldn't copy to clipboard");
    return false;
  }
}

/** Open / reveal / copy for a set of artifacts, plus the two failure dialogs
 *  and the context menu they share. */
function useArtifactActions(taskId: string | undefined, stats: ArtifactStatsMap) {
  // Artifacts (by `raw`) a click proved gone: every candidate answered 404.
  // Cleared when a later open of the same artifact succeeds.
  const [clickedMissing, setClickedMissing] = useState<ReadonlySet<string>>(new Set());
  const [notFoundPath, setNotFoundPath] = useState<string | null>(null);
  const [openError, setOpenError] = useState<{ path: string; message: string } | null>(null);
  const [menu, setMenu] = useState<{ artifact: LinkArtifact; x: number; y: number } | null>(null);

  const isMissing = useCallback(
    (a: PathArtifact) => clickedMissing.has(a.raw) || pathArtifactStatus(a, stats).missing,
    [clickedMissing, stats],
  );

  const runPath = useCallback(
    async (a: PathArtifact, action: "open" | "reveal") => {
      const order = artifactOpenOrder(a, stats);
      for (const path of order) {
        try {
          const ok =
            action === "open"
              ? (await api.openPath({ path, taskId })).opened
              : (await api.revealPath({ path, taskId })).revealed;
          setClickedMissing((prev) => {
            if (!prev.has(a.raw)) return prev;
            const next = new Set(prev);
            next.delete(a.raw);
            return next;
          });
          if (!ok) {
            setOpenError({
              path,
              message: action === "open" ? "The OS declined to open this file." : "The OS declined to reveal this file.",
            });
          }
          return;
        } catch (e) {
          // Only a 404 says "not at this candidate" — try the next root. Any
          // other failure is environmental and says nothing about existence.
          if (e instanceof ApiError && e.status === 404) continue;
          setOpenError({ path, message: e instanceof Error ? e.message : String(e) });
          return;
        }
      }
      setClickedMissing((prev) => (prev.has(a.raw) ? prev : new Set(prev).add(a.raw)));
      setNotFoundPath(artifactPrimaryPath(a, stats));
    },
    [stats, taskId],
  );

  const openUrl = useCallback(async (a: UrlArtifact) => {
    try {
      const r = await api.openExternal(a.url);
      if (!r.opened) setOpenError({ path: a.url, message: "The OS declined to open this link." });
    } catch (e) {
      setOpenError({ path: a.url, message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const activate = useCallback(
    (a: LinkArtifact) => {
      if (a.kind === "url") {
        void openUrl(a);
        return;
      }
      if (isMissing(a)) {
        setNotFoundPath(artifactPrimaryPath(a, stats));
        return;
      }
      void runPath(a, "open");
    },
    [isMissing, openUrl, runPath, stats],
  );

  const openMenu = useCallback((artifact: LinkArtifact, x: number, y: number) => setMenu({ artifact, x, y }), []);

  const menuItems: ContextMenuItem[] = useMemo(() => {
    if (menu === null) return [];
    const a = menu.artifact;
    if (a.kind === "url") {
      return [
        { id: "open-link", label: "Open link", onSelect: () => void openUrl(a) },
        { id: "copy-link", label: "Copy link", onSelect: () => void copyText(a.url) },
      ];
    }
    return [
      { id: "open", label: "Open", onSelect: () => activate(a) },
      { id: "reveal", label: "Reveal in Finder", onSelect: () => void runPath(a, "reveal") },
      { id: "copy", label: "Copy path", onSelect: () => void copyText(artifactPrimaryPath(a, stats)) },
    ];
  }, [menu, activate, openUrl, runPath, stats]);

  const overlays = (
    <>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems}
        onClose={() => setMenu(null)}
        label="Artifact actions"
        testId="handoff-artifact-menu"
      />
      {(notFoundPath !== null || openError !== null) &&
        createPortal(
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

  return { isMissing, activate, openMenu, overlays };
}

function onContextMenuFor(open: (x: number, y: number) => void) {
  return (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    open(e.clientX, e.clientY);
  };
}

export interface HandoffArtifactChipsProps {
  /** `card`: the chips the transcript card shows (pass `cardArtifacts`'
   *  `chips`; text entries are skipped). `list`: every artifact, for the
   *  modal. */
  variant: "card" | "list";
  artifacts: readonly HandoffArtifact[];
  /** Card only: entries not shown as chips — renders the `+N` button. */
  hiddenCount?: number;
  /** Card only: the `+N` button's action (opens the modal). */
  onMore?: () => void;
}

export function HandoffArtifactChips({ variant, artifacts, hiddenCount = 0, onMore }: HandoffArtifactChipsProps) {
  const { taskId } = useHandoffView();
  const candidatePaths = useMemo(() => artifactCandidatePaths(artifacts), [artifacts]);
  const { known, stats } = useArtifactStats(candidatePaths);
  const statsMap: ArtifactStatsMap = known ? stats : null;
  const { isMissing, activate, openMenu, overlays } = useArtifactActions(taskId, statsMap);

  if (variant === "card") {
    const chips = artifacts.filter((a): a is LinkArtifact => a.kind !== "text");
    if (chips.length === 0 && hiddenCount <= 0) return null;
    return (
      <>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {chips.map((a, i) => {
            const missing = a.kind === "path" && isMissing(a);
            const label = artifactLabel(a);
            const Icon =
              a.kind === "url"
                ? LinkIcon
                : missing
                  ? FileWarning
                  : iconForRef({ path: a.display, isDirectory: pathArtifactStatus(a, statsMap).isDirectory });
            const title = a.note ? `${label} — ${a.note}` : missing ? `Not found: ${label}` : label;
            return (
              <button
                key={`${a.raw}-${i}`}
                type="button"
                data-testid="handoff-card-artifact"
                data-artifact-kind={a.kind}
                data-missing={missing ? "true" : undefined}
                title={title}
                onClick={() => activate(a)}
                onContextMenu={onContextMenuFor((x, y) => openMenu(a, x, y))}
                className={cn(
                  "inline-flex max-w-[16rem] items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px]",
                  missing
                    ? "border-warning/40 bg-warning/10 text-warning opacity-70"
                    : "border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted/60",
                )}
              >
                <Icon className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{label}</span>
              </button>
            );
          })}
          {hiddenCount > 0 && (
            <button
              type="button"
              data-testid="handoff-card-more"
              aria-label={`Show ${hiddenCount} more ${hiddenCount === 1 ? "artifact" : "artifacts"}`}
              title="Open the handoff to see every artifact"
              onClick={onMore}
              className="inline-flex items-center rounded border border-border/60 bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted/60"
            >
              +{hiddenCount}
            </button>
          )}
        </div>
        {overlays}
      </>
    );
  }

  if (artifacts.length === 0) return null;
  return (
    <>
      <ul className="space-y-1">
        {artifacts.map((a, i) => {
          if (a.kind === "text") return <TextArtifactRow key={`${a.raw}-${i}`} text={a.text} />;
          const missing = a.kind === "path" && isMissing(a);
          const label = artifactLabel(a);
          const Icon =
            a.kind === "url"
              ? LinkIcon
              : missing
                ? FileWarning
                : iconForRef({ path: a.display, isDirectory: pathArtifactStatus(a, statsMap).isDirectory });
          return (
            <li key={`${a.raw}-${i}`} className="group flex min-w-0 items-center gap-1">
              <button
                type="button"
                data-testid="handoff-dialog-artifact"
                data-artifact-kind={a.kind}
                data-missing={missing ? "true" : undefined}
                title={a.kind === "path" ? artifactPrimaryPath(a, statsMap) : a.url}
                onClick={() => activate(a)}
                onContextMenu={onContextMenuFor((x, y) => openMenu(a, x, y))}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-muted/50",
                  missing && "text-warning opacity-70",
                )}
              >
                <Icon className={cn("size-3.5 shrink-0", !missing && "text-muted-foreground")} aria-hidden />
                <span className="min-w-0 truncate font-mono">{label}</span>
                {missing && <span className="shrink-0 text-[10px] uppercase tracking-wide">missing</span>}
                {a.note && <span className="min-w-0 truncate text-muted-foreground">{a.note}</span>}
              </button>
              <button
                type="button"
                aria-label="Artifact actions"
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  openMenu(a, rect.left, rect.bottom);
                }}
                className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-muted/50 hover:text-foreground focus:opacity-100 group-hover:opacity-100"
              >
                <MoreHorizontal className="size-3.5" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
      {overlays}
    </>
  );
}

/** A free-text artifact (a commit sentence, a knowledge id…): plain text
 *  with a Copy button — there is nothing to open (D20). */
function TextArtifactRow({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <li
      data-testid="handoff-dialog-artifact-text"
      className="flex min-w-0 items-start gap-2 rounded px-1.5 py-1 text-xs"
    >
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{text}</span>
      <button
        type="button"
        data-testid="handoff-dialog-artifact-copy"
        aria-label={copied ? "Copied" : "Copy"}
        title={copied ? "Copied" : "Copy"}
        onClick={async () => {
          if (await copyText(text)) {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }
        }}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded border border-border/60 text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      </button>
    </li>
  );
}
