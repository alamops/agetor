import type { TaskReference } from "../../shared/types.ts";
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
 *  can disappear when the thumbnail dismisses. We ignore such URLs so those
 *  drags fall through to the stable blob-upload path instead of referencing a
 *  path that may already be gone. */
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

/**
 * Handle drag/drop *and* clipboard paste.
 *
 * Finder drags/pastes carry the file's real path as a `file://` URL. When any
 * non-transient ones are present we resolve those to references on the server
 * (which stats each for directory-ness + existence) and use *only* those — a
 * dragged image file also shows up as an image blob, but we want its on-disk
 * path, not a copy. Transient temp-dir URLs (screenshot thumbnails) are
 * excluded so they fall through to the blob-upload path below.
 *
 * With no file URLs, each carried file is classified:
 *   - `file.path` present (future-proofing; always undefined in WKWebView) → use it.
 *   - `image/*` blob (macOS floating screenshot thumbnail, Cmd+V image paste)
 *     → upload via the injected `uploader` and use the path the server writes.
 *   - anything else → skipped.
 *
 * Everything is read off the DataTransfer synchronously before the first
 * `await`, since the object is invalidated once the event handler yields.
 *
 * `uploader` / `resolver` are parameterised for testability — production
 * callers omit them and pick up the real `api.*`.
 */
export async function captureDroppedOrPastedItems(
  source: DataTransfer | null,
  uploader: ScreenshotUploader = api.uploadScreenshot,
  resolver: RefResolver = api.resolveRefs,
): Promise<CaptureResult> {
  if (!source) return { items: [], skipped: 0 };
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
      return { items, skipped: Math.max(0, filePaths.length - refs.length) };
    } catch (e) {
      return { items: [], skipped: 0, error: (e as Error).message };
    }
  }

  if (!collected.length) {
    // Nothing usable — leave a breadcrumb so a test drag reveals what WebKit
    // actually exposed (helps if a future macOS strips file:// from drags).
    if (source.types?.length) {
      console.warn("[agetor] drop carried no file:// URLs; types =", Array.from(source.types));
    }
    return { items: [], skipped: 0 };
  }
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
