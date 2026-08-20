import { test, expect } from "bun:test";
import {
  captureDroppedOrPastedItems,
  type AttachmentUploader,
  type DragRefsFetcher,
  type RefResolver,
  type ScreenshotUploader,
} from "./capture-refs.ts";
import type { TaskReference } from "../../shared/types.ts";

/* ────────────────────────────────────────────────────────────────────────── *
 * Test plumbing: a stub `DataTransfer` that quacks loud enough for the
 * helper. We can't `new DataTransfer()` in the bun runtime — it's a
 * browser-only constructor — so we build a literal that matches the shape
 * the helper actually reads (`items` or `files`, both as `[].length`-able
 * iterables).
 * ────────────────────────────────────────────────────────────────────────── */

interface FakeItem {
  kind: "file" | "string";
  file: File | null;
  isDirectory?: boolean;
}

function makeTransfer(items: FakeItem[], types: string[] = []): DataTransfer {
  return {
    items: items.map((it) => ({
      kind: it.kind,
      getAsFile: () => it.file,
      webkitGetAsEntry: () => (it.isDirectory ? { isDirectory: true } : { isDirectory: false }),
    })) as unknown as DataTransferItemList,
    files: items
      .filter((it) => it.kind === "file" && it.file)
      .map((it) => it.file!) as unknown as FileList,
    types,
  } as unknown as DataTransfer;
}

/** A DataTransfer that only exposes `.files` — no `.items` array. Some
 *  plain-browser drag sources land here (and older `ClipboardData` shapes). */
function makeFilesOnlyTransfer(files: File[]): DataTransfer {
  return {
    items: { length: 0 } as unknown as DataTransferItemList,
    files: files as unknown as FileList,
    types: [],
  } as unknown as DataTransfer;
}

/** A DataTransfer whose items lack `webkitGetAsEntry` entirely — covers the
 *  optional-chain fallback in `collectFiles`. */
function makeNoEntryTransfer(files: File[]): DataTransfer {
  return {
    items: files.map((f) => ({
      kind: "file",
      getAsFile: () => f,
      // intentionally omit webkitGetAsEntry
    })) as unknown as DataTransferItemList,
    files: files as unknown as FileList,
    types: [],
  } as unknown as DataTransfer;
}

/** A DataTransfer that carries `getData`-readable string types (e.g. a
 *  `text/uri-list` of file:// URLs, the way WebKit exposes Finder drags),
 *  plus optional file items (an image file drag carries both a URL and a
 *  blob). */
function makeUriListTransfer(
  data: Record<string, string>,
  fileItems: FakeItem[] = [],
): DataTransfer {
  return {
    items: fileItems.map((it) => ({
      kind: it.kind,
      getAsFile: () => it.file,
      webkitGetAsEntry: () => ({ isDirectory: !!it.isDirectory }),
    })) as unknown as DataTransferItemList,
    files: fileItems
      .filter((it) => it.kind === "file" && it.file)
      .map((it) => it.file!) as unknown as FileList,
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? "",
  } as unknown as DataTransfer;
}

/** A drop that carried files (WebKit sets `"Files"` on `.types`) but exposes
 *  zero `File` entries — the folder-only-drop shape, and the shape that
 *  proves rung 2 is consulted purely off the pre-await `types` snapshot,
 *  independent of whatever `getData` returns. */
function makeFolderOnlyTransfer(types: string[] = ["Files"]): DataTransfer {
  return {
    items: { length: 0 } as unknown as DataTransferItemList,
    files: { length: 0 } as unknown as FileList,
    types,
    getData: () => "",
  } as unknown as DataTransfer;
}

function pathfulFile(name: string, path: string): File {
  const f = new File(["x"], name, { type: "image/png" });
  // The WKWebView `path` quirk — attach a non-standard property.
  (f as File & { path?: string }).path = path;
  return f;
}

function blobImage(name: string, type = "image/png"): File {
  return new File(["x"], name, { type });
}

function textFile(name: string, content = "hi"): File {
  return new File([content], name, { type: "text/plain" });
}

/** Default no-op dragRefs — used by tests that aren't exercising rung 2, to
 *  keep them from falling through to the real `api.dragRefs` (a live fetch)
 *  whenever `collected.length > 0` triggers it. */
const noDrag: DragRefsFetcher = async () => [];

/* ────────────────────────────────────────────────────────────────────────── */

test("returns empty when source is null", async () => {
  const r = await captureDroppedOrPastedItems(null);
  expect(r).toEqual({ items: [], skipped: 0, skippedFolders: 0 });
});

test("pathful file lands as a ref without invoking the uploader", async () => {
  let uploads = 0;
  const uploader: ScreenshotUploader = async () => {
    uploads++;
    return { path: "/never/used", basename: "never" };
  };
  const dt = makeTransfer([
    { kind: "file", file: pathfulFile("foo.png", "/Users/x/foo.png") },
  ]);
  const r = await captureDroppedOrPastedItems(dt, { uploader, dragRefs: noDrag });
  expect(uploads).toBe(0);
  expect(r.items).toHaveLength(1);
  expect(r.items[0]!.ref).toEqual({ path: "/Users/x/foo.png", isDirectory: false });
  expect(r.items[0]!.basename).toBe("foo.png");
  expect(r.skipped).toBe(0);
  expect(r.skippedFolders).toBe(0);
  expect(r.error).toBeUndefined();
});

test("folder drop preserves isDirectory: true (regression guard)", async () => {
  const dt = makeTransfer([
    { kind: "file", file: pathfulFile("src", "/Users/x/src"), isDirectory: true },
  ]);
  const r = await captureDroppedOrPastedItems(dt, { dragRefs: noDrag });
  expect(r.items).toHaveLength(1);
  expect(r.items[0]!.ref.isDirectory).toBe(true);
  expect(r.items[0]!.ref.path).toBe("/Users/x/src");
});

test("path-less image blob is uploaded and the returned path is used", async () => {
  const uploader: ScreenshotUploader = async (blob) => {
    expect(blob).toBeInstanceOf(File);
    return { path: "/Users/x/.agetor/screenshots/uuid.png", basename: "uuid.png" };
  };
  const dt = makeTransfer([{ kind: "file", file: blobImage("clipboard.png") }]);
  const r = await captureDroppedOrPastedItems(dt, { uploader, dragRefs: noDrag });
  expect(r.items).toHaveLength(1);
  expect(r.items[0]!.ref).toEqual({
    path: "/Users/x/.agetor/screenshots/uuid.png",
    isDirectory: false,
  });
  expect(r.items[0]!.basename).toBe("uuid.png");
});

test("upload failure surfaces as error, not silent drop", async () => {
  const uploader: ScreenshotUploader = async () => {
    throw new Error("413 image exceeds 25 MB");
  };
  const dt = makeTransfer([{ kind: "file", file: blobImage("huge.png") }]);
  const r = await captureDroppedOrPastedItems(dt, { uploader, dragRefs: noDrag });
  expect(r.items).toHaveLength(0);
  expect(r.error).toMatch(/413/);
});

test("non-image blob without a path goes through attachmentUploader (byte-copy fallback)", async () => {
  let attachCalls = 0;
  const attachmentUploader: AttachmentUploader = async (blob, name) => {
    attachCalls++;
    expect(blob).toBeInstanceOf(File);
    expect(name).toBe("notes.txt");
    return { path: "/Users/x/.agetor/attachments/notes.txt", basename: "notes.txt" };
  };
  const dt = makeTransfer([{ kind: "file", file: textFile("notes.txt") }]);
  const r = await captureDroppedOrPastedItems(dt, { attachmentUploader, dragRefs: noDrag });
  expect(attachCalls).toBe(1);
  expect(r.items).toHaveLength(1);
  expect(r.items[0]!.ref).toEqual({
    path: "/Users/x/.agetor/attachments/notes.txt",
    isDirectory: false,
  });
  expect(r.items[0]!.basename).toBe("notes.txt");
  expect(r.skipped).toBe(0);
  expect(r.skippedFolders).toBe(0);
});

test("falls back to source.files when source.items is empty", async () => {
  const f = pathfulFile("only-files.png", "/abs/only-files.png");
  const dt = makeFilesOnlyTransfer([f]);
  const r = await captureDroppedOrPastedItems(dt, { dragRefs: noDrag });
  expect(r.items).toHaveLength(1);
  expect(r.items[0]!.ref).toEqual({ path: "/abs/only-files.png", isDirectory: false });
});

test("missing webkitGetAsEntry doesn't blow up; isDirectory defaults to false", async () => {
  const f = pathfulFile("no-entry.png", "/abs/no-entry.png");
  const dt = makeNoEntryTransfer([f]);
  const r = await captureDroppedOrPastedItems(dt, { dragRefs: noDrag });
  expect(r.items).toHaveLength(1);
  expect(r.items[0]!.ref.isDirectory).toBe(false);
});

test("file:// URLs in a drop resolve to refs via the resolver", async () => {
  let asked: string[] = [];
  const resolver: RefResolver = async (paths) => {
    asked = paths;
    return [
      { path: "/Users/x/notes.txt", isDirectory: false },
      { path: "/Users/x/src", isDirectory: true },
    ];
  };
  const dt = makeUriListTransfer({
    "text/uri-list": "file:///Users/x/notes.txt\nfile:///Users/x/src",
  });
  const r = await captureDroppedOrPastedItems(dt, { resolver });
  expect(asked).toEqual(["/Users/x/notes.txt", "/Users/x/src"]);
  expect(r.items.map((i) => i.ref.path)).toEqual(["/Users/x/notes.txt", "/Users/x/src"]);
  expect(r.items[1]!.ref.isDirectory).toBe(true);
  expect(r.items[0]!.basename).toBe("notes.txt");
  expect(r.skipped).toBe(0);
  expect(r.skippedFolders).toBe(0);
});

test("file URL is percent-decoded before resolving", async () => {
  let asked: string[] = [];
  const resolver: RefResolver = async (paths) => {
    asked = paths;
    return paths.map((p) => ({ path: p, isDirectory: false }));
  };
  const dt = makeUriListTransfer({
    "text/uri-list": "file:///Users/x/My%20Docs/a%2Bb.txt",
  });
  await captureDroppedOrPastedItems(dt, { resolver });
  expect(asked).toEqual(["/Users/x/My Docs/a+b.txt"]);
});

test("a dragged image file uses its path (URL), not an upload", async () => {
  let uploads = 0;
  const uploader: ScreenshotUploader = async () => { uploads++; return { path: "/never", basename: "never" }; };
  const resolver: RefResolver = async (paths) => paths.map((p) => ({ path: p, isDirectory: false }));
  // Finder image-file drag: a uri-list URL AND an image blob both present.
  const dt = makeUriListTransfer(
    { "text/uri-list": "file:///Users/x/photo.png" },
    [{ kind: "file", file: blobImage("photo.png") }],
  );
  const r = await captureDroppedOrPastedItems(dt, { uploader, resolver });
  expect(uploads).toBe(0);
  expect(r.items).toHaveLength(1);
  expect(r.items[0]!.ref.path).toBe("/Users/x/photo.png");
});

test("transient temp-dir URL is ignored; image blob is uploaded instead", async () => {
  // A macOS screenshot-thumbnail drag may carry a file:// URL into a temp
  // dir *and* the image blob. We must not reference the temp path (it can
  // vanish) — the blob upload should win.
  let asked: string[] | null = null;
  const resolver: RefResolver = async (paths) => { asked = paths; return paths.map((p) => ({ path: p, isDirectory: false })); };
  const uploader: ScreenshotUploader = async () => ({ path: "/Users/x/.agetor/screenshots/shot.png", basename: "shot.png" });
  const dt = makeUriListTransfer(
    { "text/uri-list": "file:///var/folders/aa/bb/T/TemporaryItems/NSIRD_x/Screenshot.png" },
    [{ kind: "file", file: blobImage("Screenshot.png") }],
  );
  const r = await captureDroppedOrPastedItems(dt, { uploader, resolver, dragRefs: noDrag });
  expect(asked).toBeNull(); // resolver never called — transient URL filtered out
  expect(r.items).toHaveLength(1);
  expect(r.items[0]!.ref.path).toBe("/Users/x/.agetor/screenshots/shot.png");
});

test("uri-list comment lines and non-file URLs are ignored", async () => {
  let asked: string[] = [];
  const resolver: RefResolver = async (paths) => { asked = paths; return paths.map((p) => ({ path: p, isDirectory: false })); };
  const dt = makeUriListTransfer({
    "text/uri-list": "# comment\nhttps://example.com/x\nfile:///Users/x/keep.txt",
  });
  await captureDroppedOrPastedItems(dt, { resolver });
  expect(asked).toEqual(["/Users/x/keep.txt"]);
});

test("resolver throwing surfaces as error, not a silent drop", async () => {
  const resolver: RefResolver = async () => { throw new Error("boom"); };
  const dt = makeUriListTransfer({ "text/uri-list": "file:///Users/x/a.txt" });
  const r = await captureDroppedOrPastedItems(dt, { resolver });
  expect(r.items).toHaveLength(0);
  expect(r.error).toBe("boom");
  expect(r.skippedFolders).toBe(0);
});

test("resolver dropping a missing path is reflected in skipped", async () => {
  // Two URLs in, one ref out (the other no longer exists on disk).
  const resolver: RefResolver = async () => [{ path: "/Users/x/a.txt", isDirectory: false } as TaskReference];
  const dt = makeUriListTransfer({
    "text/uri-list": "file:///Users/x/a.txt\nfile:///Users/x/gone.txt",
  });
  const r = await captureDroppedOrPastedItems(dt, { resolver });
  expect(r.items).toHaveLength(1);
  expect(r.skipped).toBe(1);
  expect(r.skippedFolders).toBe(0);
});

test("mixed payload: pathful, screenshot upload, byte-copy upload, and directory — all classified correctly", async () => {
  const uploader: ScreenshotUploader = async () => ({ path: "/tmp/screenshot.png", basename: "screenshot.png" });
  let attachCalls = 0;
  const attachmentUploader: AttachmentUploader = async (blob, name) => {
    attachCalls++;
    return { path: `/tmp/attachments/${name}`, basename: name };
  };
  const dt = makeTransfer([
    { kind: "file", file: pathfulFile("a.png", "/abs/a.png") },
    { kind: "file", file: blobImage("paste.png") },
    { kind: "file", file: new File(["x"], "ignore.bin", { type: "application/octet-stream" }) },
    { kind: "file", file: pathfulFile("dir", "/abs/dir"), isDirectory: true },
  ]);
  const r = await captureDroppedOrPastedItems(dt, { uploader, attachmentUploader, dragRefs: noDrag });
  expect(attachCalls).toBe(1);
  expect(r.items).toHaveLength(4);
  expect(r.skipped).toBe(0);
  expect(r.skippedFolders).toBe(0);
  // Order is preserved from the input.
  expect(r.items.map((i) => i.ref.path)).toEqual([
    "/abs/a.png",
    "/tmp/screenshot.png",
    "/tmp/attachments/ignore.bin",
    "/abs/dir",
  ]);
  expect(r.items[3]!.ref.isDirectory).toBe(true);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * New coverage: rung 2 (drag pasteboard, drop-only) + rung-3 byte-copy +
 * skippedFolders + kind:"paste" isolation.
 * ────────────────────────────────────────────────────────────────────────── */

test("drop with no file:// URLs consults dragRefs and attaches matching file refs by original path", async () => {
  let dragCalls = 0;
  const dragRefs: DragRefsFetcher = async () => {
    dragCalls++;
    return [{ path: "/Users/x/notes.txt", isDirectory: false }];
  };
  let attachCalls = 0;
  const attachmentUploader: AttachmentUploader = async () => { attachCalls++; return { path: "/never", basename: "never" }; };
  const dt = makeTransfer([{ kind: "file", file: textFile("notes.txt") }]);
  const r = await captureDroppedOrPastedItems(dt, { dragRefs, attachmentUploader });
  expect(dragCalls).toBe(1);
  expect(attachCalls).toBe(0); // consumed at rung 2, never reaches the rung-3 upload loop
  expect(r.items).toHaveLength(1);
  expect(r.items[0]!.ref).toEqual({ path: "/Users/x/notes.txt", isDirectory: false });
  expect(r.items[0]!.basename).toBe("notes.txt");
  expect(r.skippedFolders).toBe(0);
});

test("dragRefs is not consulted once rung-1 file:// URLs have already resolved", async () => {
  let dragCalls = 0;
  const dragRefs: DragRefsFetcher = async () => { dragCalls++; return []; };
  const resolver: RefResolver = async (paths) => paths.map((p) => ({ path: p, isDirectory: false }));
  const dt = makeUriListTransfer(
    { "text/uri-list": "file:///Users/x/notes.txt" },
    [{ kind: "file", file: textFile("notes.txt") }],
  );
  const r = await captureDroppedOrPastedItems(dt, { resolver, dragRefs });
  expect(dragCalls).toBe(0);
  expect(r.items.map((i) => i.ref.path)).toEqual(["/Users/x/notes.txt"]);
});

test("stale-pasteboard guard: a dragRefs file ref whose basename doesn't match any collected File is not attached", async () => {
  const dragRefs: DragRefsFetcher = async () => [{ path: "/Users/x/other.txt", isDirectory: false }];
  let attachCalls = 0;
  const attachmentUploader: AttachmentUploader = async (blob, name) => {
    attachCalls++;
    return { path: "/Users/x/.agetor/attachments/real.txt", basename: name };
  };
  const dt = makeTransfer([{ kind: "file", file: textFile("real.txt") }]);
  const r = await captureDroppedOrPastedItems(dt, { dragRefs, attachmentUploader });
  // The unmatched ref is dropped; the actually-collected file falls through
  // to the byte-copy upload rung instead of being silently lost.
  expect(attachCalls).toBe(1);
  expect(r.items).toHaveLength(1);
  expect(r.items[0]!.ref.path).toBe("/Users/x/.agetor/attachments/real.txt");
  expect(r.items.some((i) => i.ref.path === "/Users/x/other.txt")).toBe(false);
});

test("directory refs are always accepted: mixed drop attaches both a matched file ref and an unmatched directory ref", async () => {
  const dragRefs: DragRefsFetcher = async () => [
    { path: "/Users/x/notes.txt", isDirectory: false },
    { path: "/Users/x/myproj", isDirectory: true },
  ];
  let attachCalls = 0;
  const attachmentUploader: AttachmentUploader = async () => { attachCalls++; return { path: "/never", basename: "never" }; };
  const dt = makeTransfer([{ kind: "file", file: textFile("notes.txt") }]);
  const r = await captureDroppedOrPastedItems(dt, { dragRefs, attachmentUploader });
  expect(attachCalls).toBe(0); // notes.txt consumed at rung 2, not uploaded
  expect(r.items).toHaveLength(2);
  expect(r.items.map((i) => i.ref.path).sort()).toEqual([
    "/Users/x/myproj",
    "/Users/x/notes.txt",
  ]);
  const dir = r.items.find((i) => i.ref.path === "/Users/x/myproj")!;
  expect(dir.ref.isDirectory).toBe(true);
});

test("folder-only drop: only the directory ref is attached, a bare file ref is rejected (nothing to cross-check)", async () => {
  let dragCalls = 0;
  const dragRefs: DragRefsFetcher = async () => {
    dragCalls++;
    return [
      { path: "/Users/x/dir", isDirectory: true },
      { path: "/Users/x/loose.txt", isDirectory: false },
    ];
  };
  const dt = makeFolderOnlyTransfer(["Files"]);
  const r = await captureDroppedOrPastedItems(dt, { dragRefs });
  expect(dragCalls).toBe(1);
  expect(r.items).toHaveLength(1);
  expect(r.items[0]!.ref).toEqual({ path: "/Users/x/dir", isDirectory: true });
  expect(r.skippedFolders).toBe(0);
});

test("drop with empty file entries but types carrying \"Files\" still consults dragRefs", async () => {
  let dragCalls = 0;
  const dragRefs: DragRefsFetcher = async () => { dragCalls++; return []; };
  const dt = makeFolderOnlyTransfer(["Files"]);
  await captureDroppedOrPastedItems(dt, { dragRefs });
  expect(dragCalls).toBe(1);
});

test("transient dragRefs paths are filtered out; the matching collected file falls through to attachmentUploader", async () => {
  const dragRefs: DragRefsFetcher = async () => [
    { path: "/var/folders/aa/bb/T/TemporaryItems/x.txt", isDirectory: false },
  ];
  let attachCalls = 0;
  const attachmentUploader: AttachmentUploader = async (blob, name) => {
    attachCalls++;
    return { path: "/Users/x/.agetor/attachments/x.txt", basename: name };
  };
  const dt = makeTransfer([{ kind: "file", file: textFile("x.txt") }]);
  const r = await captureDroppedOrPastedItems(dt, { dragRefs, attachmentUploader });
  expect(attachCalls).toBe(1);
  expect(r.items).toHaveLength(1);
  expect(r.items[0]!.ref.path).toBe("/Users/x/.agetor/attachments/x.txt");
});

test("image behavior unchanged: pasteboard png ref is excluded (blob uploaded via uploader); svg ref is attached by path", async () => {
  const dragRefs: DragRefsFetcher = async () => [
    { path: "/Users/x/photo.png", isDirectory: false },
    { path: "/Users/x/icon.svg", isDirectory: false },
  ];
  let uploadCalls = 0;
  const uploader: ScreenshotUploader = async () => {
    uploadCalls++;
    return { path: "/Users/x/.agetor/screenshots/photo-uuid.png", basename: "photo-uuid.png" };
  };
  const dt = makeTransfer([
    { kind: "file", file: blobImage("photo.png") },
    { kind: "file", file: new File(["<svg/>"], "icon.svg", { type: "image/svg+xml" }) },
  ]);
  const r = await captureDroppedOrPastedItems(dt, { dragRefs, uploader });
  expect(uploadCalls).toBe(1);
  expect(r.items).toHaveLength(2);
  expect(r.items.map((i) => i.ref.path).sort()).toEqual([
    "/Users/x/.agetor/screenshots/photo-uuid.png",
    "/Users/x/icon.svg",
  ]);
});

test('kind: "paste" never consults dragRefs, even when the clipboard carries files', async () => {
  let dragCalls = 0;
  const dragRefs: DragRefsFetcher = async () => { dragCalls++; throw new Error("should not be called"); };
  let attachCalls = 0;
  const attachmentUploader: AttachmentUploader = async (blob, name) => {
    attachCalls++;
    return { path: "/Users/x/.agetor/attachments/clip.txt", basename: name };
  };
  const dt = makeTransfer([{ kind: "file", file: textFile("clip.txt") }]);
  const r = await captureDroppedOrPastedItems(dt, { kind: "paste", dragRefs, attachmentUploader });
  expect(dragCalls).toBe(0);
  expect(attachCalls).toBe(1);
  expect(r.items).toHaveLength(1);
  expect(r.items[0]!.ref.path).toBe("/Users/x/.agetor/attachments/clip.txt");
});

test("attachmentUploader rejection sets the error slot without throwing", async () => {
  const attachmentUploader: AttachmentUploader = async () => { throw new Error("disk full"); };
  const dt = makeTransfer([{ kind: "file", file: textFile("notes.txt") }]);
  const r = await captureDroppedOrPastedItems(dt, { attachmentUploader, dragRefs: noDrag });
  expect(r.items).toHaveLength(0);
  expect(r.error).toBe("disk full");
});

test("zero-byte typeless File (WebKit directory shape) is counted in skippedFolders, not uploaded", async () => {
  let attachCalls = 0;
  const attachmentUploader: AttachmentUploader = async () => { attachCalls++; return { path: "/never", basename: "never" }; };
  const dt = makeTransfer([{ kind: "file", file: new File([], "mystery") }]);
  const r = await captureDroppedOrPastedItems(dt, { attachmentUploader, dragRefs: noDrag });
  expect(attachCalls).toBe(0);
  expect(r.items).toHaveLength(0);
  expect(r.skippedFolders).toBe(1);
});

test("dragRefs throwing degrades silently to the rung-3 upload path (no error surfaced from that rung)", async () => {
  const dragRefs: DragRefsFetcher = async () => { throw new Error("pasteboard read failed"); };
  let attachCalls = 0;
  const attachmentUploader: AttachmentUploader = async (blob, name) => {
    attachCalls++;
    return { path: "/Users/x/.agetor/attachments/notes.txt", basename: name };
  };
  const dt = makeTransfer([{ kind: "file", file: textFile("notes.txt") }]);
  const r = await captureDroppedOrPastedItems(dt, { dragRefs, attachmentUploader });
  expect(r.error).toBeUndefined();
  expect(attachCalls).toBe(1);
  expect(r.items).toHaveLength(1);
  expect(r.skippedFolders).toBe(0);
});
