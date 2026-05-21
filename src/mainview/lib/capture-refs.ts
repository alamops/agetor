import type { TaskReference } from "../../shared/types.ts";
import { api } from "./api";
import { refBasename } from "./path";

// `File` in WKWebView (Electrobun) carries a non-standard `path` property that
// holds the absolute filesystem path. We rely on it for the picker AND drop
// paths — without it we can't build a `TaskReference`. Plain-browser drops
// (and clipboard image blobs) fall back to the upload path.
export type ElectroFile = File & { path?: string };

export interface CapturedItem {
  /** Goes in the references chip list. */
  ref: TaskReference;
  /** Used by callers to insert a `[basename]` marker at the textarea cursor. */
  basename: string;
}

export interface CaptureResult {
  items: CapturedItem[];
  /** Non-image, no-path items that couldn't be turned into a reference. */
  skipped: number;
  /** Set when the upload endpoint rejected one or more blobs. */
  error?: string;
}

interface CollectedFile {
  file: ElectroFile;
  /** Set when the source was a `DataTransferItem` whose
   *  `webkitGetAsEntry()` exposes `isDirectory: true`. Clipboard pastes
   *  and plain `.files` lists can never carry directories, so they're
   *  always false in that branch. */
  isDirectory: boolean;
}

/** Pull `File`s out of either a drop (`DataTransfer`) or a paste
 *  (`ClipboardEvent.clipboardData`). Preserves directory-ness for the
 *  drop path — losing it would silently strip the trailing `/` from
 *  folder refs in the prompt body. */
function collectFiles(source: DataTransfer): CollectedFile[] {
  const out: CollectedFile[] = [];
  if (source.items?.length) {
    for (const it of Array.from(source.items)) {
      if (it.kind !== "file") continue;
      const f = it.getAsFile() as ElectroFile | null;
      if (!f) continue;
      const entry = it.webkitGetAsEntry?.();
      out.push({ file: f, isDirectory: entry?.isDirectory ?? false });
    }
  } else if (source.files?.length) {
    for (const f of Array.from(source.files) as ElectroFile[]) {
      out.push({ file: f, isDirectory: false });
    }
  }
  return out;
}

export type ScreenshotUploader = (blob: Blob) => Promise<{ path: string; basename: string }>;

/**
 * Handle drag/drop *and* clipboard paste. For each carried file:
 *   - If the WKWebView quirk gives us `file.path`, use it as-is.
 *   - Otherwise, if the file is an `image/*` blob (the macOS floating
 *     screenshot thumbnail and Cmd+V image paste both arrive this way),
 *     upload it via the injected `uploader` and use the absolute path the
 *     server writes it to.
 *   - Anything else (e.g. text/html drags, non-image blob) is skipped.
 *
 * Uploads run in parallel; the function awaits all of them before
 * returning so callers can apply state updates once.
 *
 * `uploader` is parameterised for testability — production callers omit it
 * and pick up the real `api.uploadScreenshot`.
 */
export async function captureDroppedOrPastedItems(
  source: DataTransfer | null,
  uploader: ScreenshotUploader = api.uploadScreenshot,
): Promise<CaptureResult> {
  if (!source) return { items: [], skipped: 0 };
  const collected = collectFiles(source);
  if (!collected.length) return { items: [], skipped: 0 };
  const pending: Array<Promise<CapturedItem | { skipped: true } | { error: string }>> = [];
  for (const { file: f, isDirectory } of collected) {
    if (f.path) {
      pending.push(Promise.resolve({
        ref: { path: f.path, isDirectory },
        basename: refBasename(f.path),
      }));
      continue;
    }
    if (f.type && f.type.startsWith("image/")) {
      pending.push(
        uploader(f)
          .then((r) => ({ ref: { path: r.path, isDirectory: false }, basename: r.basename }))
          .catch((e: Error) => ({ error: e.message })),
      );
      continue;
    }
    pending.push(Promise.resolve({ skipped: true }));
  }
  const settled = await Promise.all(pending);
  const items: CapturedItem[] = [];
  let skipped = 0;
  let error: string | undefined;
  for (const r of settled) {
    if ("ref" in r) items.push(r);
    else if ("error" in r) error = r.error;
    else skipped++;
  }
  return { items, skipped, ...(error ? { error } : {}) };
}
