// The one source of the words and the chip style every thumbnail surface uses
// when a preview can't be shown (`AttachmentChips`, `MdImage`, `SentFilesCard`,
// `BinaryFilePreview`). Amber ("not found") is kept for a proven 404 only: a
// 403 from `/files/preview` means the core couldn't read the file — on macOS,
// a privacy-protected folder like Desktop or Documents — which says nothing
// about whether it exists, and the original still opens through the OS
// (`/open-path`). Every non-404 failure therefore reads as neutral and stays
// clickable.
import type { AuthedBlobStatus } from "./authed-blob.ts";

/** Why a preview isn't showing: every settled failure of `AuthedBlobStatus`. */
export type PreviewFailure = Exclude<AuthedBlobStatus, "loading" | "ok">;

export const PREVIEW_DENIED_COPY =
  "Preview blocked by macOS privacy — Agetor can't read files in this folder for previews.";
export const PREVIEW_UNAVAILABLE_COPY = "Preview unavailable.";
export const PREVIEW_TOO_LARGE_COPY = "Too large to preview.";

/**
 * The tooltip for a chip or tile whose preview failed. The first line is the
 * short copy for the failure; a second line carries the full path (what a
 * healthy chip shows as its title). `missing` keeps the exact amber copy
 * `Image not found: <path>` the not-found chip has always carried.
 */
export function previewFailureTitle(failure: PreviewFailure, path: string): string {
  switch (failure) {
    case "missing":
      return `Image not found: ${path}`;
    case "denied":
      return `${PREVIEW_DENIED_COPY} Click to open.\n${path}`;
    case "too-large":
      return `${PREVIEW_TOO_LARGE_COPY} Click to open.\n${path}`;
    case "error":
      return `${PREVIEW_UNAVAILABLE_COPY} Click to open.\n${path}`;
  }
}

/** The neutral failure chip (matches the non-image attachment chip). Semantic
 *  tokens only, so it holds in both themes. */
export const NEUTRAL_CHIP_CLASS =
  "inline-flex max-w-full items-center gap-1 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted/60";
