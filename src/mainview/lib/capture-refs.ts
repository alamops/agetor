import type { TaskReference } from "../../shared/types.ts";
import { isImagePath } from "../../shared/attachments.ts";
import { api } from "./api";
import { refBasename } from "./path";

// `File` in a browser/WKWebView does NOT carry an absolute path (the `.path`
// property is an Electron-only Chromium extension and is always undefined
// here). The way we recover a dragged file's real path is the `file://` URL
// WebKit places on the drag's `text/uri-list`; clipboard image blobs (and
// macOS floating-thumbnail screenshots) carry no URL and fall back to upload.
// The `path?` field stays declared as a cheap fast-path in case a future
// runtime ever populates it — it's harmless when absent.
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
  /** Folder entries that couldn't be turned into a reference (never uploaded,
   *  never byte-copied) — always present, 0 when none were seen. */
  skippedFolders: number;
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

/** Percent-decode, swallowing the `URIError` a malformed `%` sequence throws
 *  so one bad entry can't abort decoding of its siblings. */
function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** Turn a `file://` URL into an absolute filesystem path. Returns null for
 *  any non-file URL or undecodable input. Percent-decoding handles
 *  spaces/unicode in paths. */
function fileUrlToPath(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "file:") return null;
    // Ignore the (usually empty / "localhost") host; the path is what we want.
    return safeDecode(u.pathname);
  } catch {
    const m = url.match(/^file:\/\/[^/]*(\/[^\r\n]*)$/i);
    return m ? safeDecode(m[1]!) : null;
  }
}

/** macOS temp locations that back transient drag sources — most notably the
 *  Cmd+Shift+4 floating screenshot thumbnail, whose `file://` URL (when it
 *  exposes one) points at a file under `/var/folders/.../TemporaryItems/` that
 *  can disappear when the thumbnail dismisses. We ignore such URLs/paths so
 *  those drags fall through to the stable blob-upload path instead of
 *  referencing a path that may already be gone — this check is applied both
 *  to `file://` URLs (below) and to paths recovered from the drag pasteboard
 *  (`dragRefs`, in the drop flow). */
function isTransientPath(p: string): boolean {
  return /^\/(private\/)?(var\/folders|tmp)(\/|$)/i.test(p) || /\/TemporaryItems\//.test(p);
}

/** Pull absolute paths out of a drop/paste's `file://` URLs. WebKit exposes
 *  files dragged from Finder as a `text/uri-list` (and sometimes other
 *  url-ish types) carrying `file://…` lines. Must be called synchronously
 *  before any `await` — the DataTransfer is invalidated once the event
 *  handler yields. */
function extractFilePaths(source: DataTransfer): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const ingest = (raw: string) => {
    for (const line of raw.split(/[\r\n]+/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue; // uri-list comments
      if (!/^file:\/\//i.test(s)) continue;
      const p = fileUrlToPath(s);
      if (p && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  };
  const candidates = new Set<string>(["text/uri-list", "public.file-url", "text/plain"]);
  for (const t of Array.from(source.types ?? [])) {
    if (/uri|url|file/i.test(t)) candidates.add(t);
  }
  for (const t of candidates) {
    try {
      const raw = source.getData?.(t) ?? "";
      if (raw) ingest(raw);
    } catch {
      /* getData throws outside the drop/paste event window — ignore */
    }
  }
  return out;
}

export type ScreenshotUploader = (blob: Blob) => Promise<{ path: string; basename: string }>;

/** Resolve absolute paths into references (server stats each). Injectable for
 *  tests; production callers pick up the real `api.resolveRefs`. */
export type RefResolver = (paths: string[]) => Promise<TaskReference[]>;

/** Recover the current drag's real paths off the macOS drag pasteboard
 *  (drop only — see `captureDroppedOrPastedItems`). Injectable for tests;
 *  production callers pick up the real `api.dragRefs`. */
export type DragRefsFetcher = () => Promise<TaskReference[]>;

/** Byte-copy a path-less blob to disk and get back its on-disk path.
 *  Injectable for tests; production callers pick up the real
 *  `api.uploadAttachment`. */
export type AttachmentUploader = (blob: Blob, name: string) => Promise<{ path: string; basename: string }>;

export interface CaptureOptions {
  /** `"drop"` (default) enables the drag-pasteboard recovery step below;
   *  `"paste"` never consults it — see the flow comment for why. */
  kind?: "drop" | "paste";
  uploader?: ScreenshotUploader;
  resolver?: RefResolver;
  dragRefs?: DragRefsFetcher;
  attachmentUploader?: AttachmentUploader;
}

/**
 * Handle drag/drop *and* clipboard paste.
 *
 * WKWebView exposes no reliable way to recover a dropped/pasted item's real
 * path or bytes up front, so items are resolved through a recovery ladder,
 * each rung falling through to the next when it comes up empty:
 *
 *   1. `file://` URLs (`extractFilePaths`, both drop and paste). Finder
 *      drags/pastes carry the file's real path this way. When any
 *      non-transient ones are present we resolve those to references on the
 *      server (which stats each for directory-ness + existence) and use
 *      *only* those — a dragged image file also shows up as an image blob,
 *      but we want its on-disk path, not a copy. Transient temp-dir URLs
 *      (screenshot thumbnails) are excluded so they fall through to rung 3.
 *
 *   2. The macOS drag pasteboard (`opts.dragRefs`), **drop only**. WKWebView
 *      exposes no `file://` URLs on an ordinary Finder drop (rung 1 above
 *      returns `[]` in practice for anything but a paste), so this is the
 *      real recovery path for non-image files and folders dragged from
 *      Finder: the server reads the drag pasteboard the drop just ended and
 *      stats each path. **Never consulted on paste** — the clipboard has no
 *      concept of "the drag that just happened"; the drag pasteboard could
 *      hold an unrelated *earlier* drag's paths (or be stale/empty), and
 *      querying it on paste would attach the wrong files. Non-transient,
 *      non-image-file refs are kept; when the DataTransfer also collected
 *      `File` objects, a ref is only trusted if its basename matches one of
 *      them (guards a stale pasteboard) — except a folder-only drop can
 *      collect zero `File`s in WebKit even though it's a real drop, so with
 *      nothing to cross-check against, the refs are trusted unvalidated.
 *      Matched files are consumed here and skip rung 3/4 below.
 *
 *   3. Each remaining carried file is classified:
 *      - `file.path` present (future-proofing; always undefined in
 *        WKWebView) → use it directly.
 *      - `image/*` blob (macOS floating screenshot thumbnail, Cmd+V image
 *        paste, or an image left over after rung 2) → upload via the
 *        injected `uploader` and use the path the server writes.
 *      - any other non-directory blob → byte-copy fallback: upload via the
 *        injected `attachmentUploader` and use the path the server writes.
 *        This is what lets a path-less non-image paste (or a drop whose
 *        pasteboard lookup failed) still attach instead of being skipped.
 *
 *   4. A directory entry that survives to this point (rung 2 didn't apply —
 *      paste, or a drop whose pasteboard step found nothing to match it)
 *      can't be uploaded or byte-copied as a single blob, so it's counted in
 *      `skippedFolders` and dropped. Anything else uncategorizable is
 *      counted in `skipped`, as before.
 *
 * Everything read directly off the DataTransfer (`collectFiles`,
 * `extractFilePaths`) happens synchronously before the first `await`, since
 * the object is invalidated once the event handler yields; the pasteboard
 * lookup and any uploads happen after, on the already-collected data.
 *
 * `uploader` / `resolver` / `dragRefs` / `attachmentUploader` are
 * parameterised for testability — production callers omit them and pick up
 * the real `api.*`. A `dragRefs` failure (network error, no active drag on
 * the server side, etc.) is swallowed and treated as "nothing recovered" —
 * it must degrade to the pre-existing behavior, not surface as a hard error.
 */
export async function captureDroppedOrPastedItems(
  source: DataTransfer | null,
  opts: CaptureOptions = {},
): Promise<CaptureResult> {
  const kind = opts.kind ?? "drop";
  const uploader = opts.uploader ?? api.uploadScreenshot;
  const resolver = opts.resolver ?? api.resolveRefs;
  const dragRefsFn = opts.dragRefs ?? api.dragRefs;
  const attachmentUploaderFn = opts.attachmentUploader ?? api.uploadAttachment;

  if (!source) return { items: [], skipped: 0, skippedFolders: 0 };
  // Read everything synchronously up front — the DataTransfer dies on yield.
  const collected = collectFiles(source);
  // Drop transient (temp-dir) URLs so a screenshot-thumbnail drag falls
  // through to the blob-upload path below rather than referencing a file
  // that may vanish — see `isTransientPath`.
  const filePaths = extractFilePaths(source).filter((p) => !isTransientPath(p));

  if (filePaths.length) {
    try {
      const refs = await resolver(filePaths);
      const items = refs.map((ref) => ({ ref, basename: refBasename(ref.path) }));
      return { items, skipped: Math.max(0, filePaths.length - refs.length), skippedFolders: 0 };
    } catch (e) {
      return { items: [], skipped: 0, skippedFolders: 0, error: (e as Error).message };
    }
  }

  // Rung 2: the drag pasteboard, drop only — see the flow comment above for
  // why paste must never consult it.
  const draggedItems: CapturedItem[] = [];
  const consumed = new Set<number>();
  const carriedFiles = collected.length > 0 || Array.from(source.types ?? []).includes("Files");
  if (kind === "drop" && carriedFiles) {
    try {
      const dragged = await dragRefsFn();
      const filtered = dragged.filter(
        (ref) => !isTransientPath(ref.path) && !(!ref.isDirectory && isImagePath(ref.path)),
      );
      if (collected.length > 0) {
        for (const ref of filtered) {
          const base = refBasename(ref.path);
          const idx = collected.findIndex((c, i) => !consumed.has(i) && c.file.name === base);
          if (idx !== -1) {
            consumed.add(idx);
            draggedItems.push({ ref, basename: base });
          }
        }
      } else {
        // Folder-only drop: WebKit can collect zero `File`s even though the
        // drop is real, so there's nothing to cross-check against — trust
        // the pasteboard's refs unvalidated.
        for (const ref of filtered) {
          draggedItems.push({ ref, basename: refBasename(ref.path) });
        }
      }
    } catch {
      // Pasteboard lookup failed — degrade to rung 3 with nothing consumed,
      // not a hard error.
    }
  }

  if (!collected.length) {
    if (draggedItems.length) {
      return { items: draggedItems, skipped: 0, skippedFolders: 0 };
    }
    // Nothing usable — leave a breadcrumb so a test drag reveals what WebKit
    // actually exposed (helps if a future macOS strips file:// from drags).
    if (source.types?.length) {
      console.warn("[agetor] drop carried no file:// URLs; types =", Array.from(source.types));
    }
    return { items: [], skipped: 0, skippedFolders: 0 };
  }

  type PendingResult = CapturedItem | { skipped: true } | { folder: true } | { error: string };
  const pending: Array<Promise<PendingResult>> = [];
  for (let i = 0; i < collected.length; i++) {
    if (consumed.has(i)) continue;
    const { file: f, isDirectory } = collected[i]!;
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
    if (!isDirectory) {
      pending.push(
        attachmentUploaderFn(f, f.name || "attachment")
          .then((r) => ({ ref: { path: r.path, isDirectory: false }, basename: r.basename }))
          .catch((e: Error) => ({ error: e.message })),
      );
      continue;
    }
    if (isDirectory) {
      pending.push(Promise.resolve({ folder: true }));
      continue;
    }
    pending.push(Promise.resolve({ skipped: true }));
  }
  const settled = await Promise.all(pending);
  const items: CapturedItem[] = [...draggedItems];
  let skipped = 0;
  let skippedFolders = 0;
  let error: string | undefined;
  for (const r of settled) {
    if ("ref" in r) items.push(r);
    else if ("error" in r) error = r.error;
    else if ("folder" in r) skippedFolders++;
    else skipped++;
  }
  return { items, skipped, skippedFolders, ...(error ? { error } : {}) };
}
