import { test, expect } from "bun:test";
import {
  captureDroppedOrPastedItems,
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

function makeTransfer(items: FakeItem[]): DataTransfer {
  return {
    items: items.map((it) => ({
      kind: it.kind,
      getAsFile: () => it.file,
      webkitGetAsEntry: () => (it.isDirectory ? { isDirectory: true } : { isDirectory: false }),
    })) as unknown as DataTransferItemList,
    files: items
      .filter((it) => it.kind === "file" && it.file)
      .map((it) => it.file!) as unknown as FileList,
    types: [],
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

function pathfulFile(name: string, path: string): File {
  const f = new File(["x"], name, { type: "image/png" });
  // The WKWebView `path` quirk — attach a non-standard property.
  (f as File & { path?: string }).path = path;
  return f;
}

function blobImage(name: string, type = "image/png"): File {
  return new File(["x"], name, { type });
}

/* ────────────────────────────────────────────────────────────────────────── */

test("returns empty when source is null", async () => {
  const noopUploader: ScreenshotUploader = async () => ({ path: "", basename: "" });
  const r = await captureDroppedOrPastedItems(null, noopUploader);
  expect(r).toEqual({ items: [], skipped: 0 });
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
  const r = await captureDroppedOrPastedItems(dt, uploader);
  expect(uploads).toBe(0);
  expect(r.items).toHaveLength(1);
  expect(r.items[0]!.ref).toEqual({ path: "/Users/x/foo.png", isDirectory: false });
  expect(r.items[0]!.basename).toBe("foo.png");
  expect(r.skipped).toBe(0);
  expect(r.error).toBeUndefined();
});

test("folder drop preserves isDirectory: true (regression guard)", async () => {
  const noopUploader: ScreenshotUploader = async () => ({ path: "", basename: "" });
  const dt = makeTransfer([
    { kind: "file", file: pathfulFile("src", "/Users/x/src"), isDirectory: true },
  ]);
  const r = await captureDroppedOrPastedItems(dt, noopUploader);
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
  const r = await captureDroppedOrPastedItems(dt, uploader);
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
  const r = await captureDroppedOrPastedItems(dt, uploader);
  expect(r.items).toHaveLength(0);
  expect(r.error).toMatch(/413/);
});

test("non-image blob without a path is skipped (and uploader is not called)", async () => {
  let uploads = 0;
  const uploader: ScreenshotUploader = async () => { uploads++; return { path: "", basename: "" }; };
  const dt = makeTransfer([
    { kind: "file", file: new File(["x"], "notes.txt", { type: "text/plain" }) },
  ]);
  const r = await captureDroppedOrPastedItems(dt, uploader);
  expect(uploads).toBe(0);
  expect(r.items).toHaveLength(0);
  expect(r.skipped).toBe(1);
});

test("falls back to source.files when source.items is empty", async () => {
  const noopUploader: ScreenshotUploader = async () => ({ path: "", basename: "" });
  const f = pathfulFile("only-files.png", "/abs/only-files.png");
  const dt = makeFilesOnlyTransfer([f]);
  const r = await captureDroppedOrPastedItems(dt, noopUploader);
  expect(r.items).toHaveLength(1);
  expect(r.items[0]!.ref).toEqual({ path: "/abs/only-files.png", isDirectory: false });
});

test("missing webkitGetAsEntry doesn't blow up; isDirectory defaults to false", async () => {
  const noopUploader: ScreenshotUploader = async () => ({ path: "", basename: "" });
  const f = pathfulFile("no-entry.png", "/abs/no-entry.png");
  const dt = makeNoEntryTransfer([f]);
  const r = await captureDroppedOrPastedItems(dt, noopUploader);
  expect(r.items).toHaveLength(1);
  expect(r.items[0]!.ref.isDirectory).toBe(false);
});

test("file:// URLs in a drop resolve to refs via the resolver", async () => {
  const noopUploader: ScreenshotUploader = async () => ({ path: "", basename: "" });
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
  const r = await captureDroppedOrPastedItems(dt, noopUploader, resolver);
  expect(asked).toEqual(["/Users/x/notes.txt", "/Users/x/src"]);
  expect(r.items.map((i) => i.ref.path)).toEqual(["/Users/x/notes.txt", "/Users/x/src"]);
  expect(r.items[1]!.ref.isDirectory).toBe(true);
  expect(r.items[0]!.basename).toBe("notes.txt");
  expect(r.skipped).toBe(0);
});

test("file URL is percent-decoded before resolving", async () => {
  const noopUploader: ScreenshotUploader = async () => ({ path: "", basename: "" });
  let asked: string[] = [];
  const resolver: RefResolver = async (paths) => {
    asked = paths;
    return paths.map((p) => ({ path: p, isDirectory: false }));
  };
  const dt = makeUriListTransfer({
    "text/uri-list": "file:///Users/x/My%20Docs/a%2Bb.txt",
  });
  await captureDroppedOrPastedItems(dt, noopUploader, resolver);
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
  const r = await captureDroppedOrPastedItems(dt, uploader, resolver);
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
  const r = await captureDroppedOrPastedItems(dt, uploader, resolver);
  expect(asked).toBeNull(); // resolver never called — transient URL filtered out
  expect(r.items).toHaveLength(1);
  expect(r.items[0]!.ref.path).toBe("/Users/x/.agetor/screenshots/shot.png");
});

test("uri-list comment lines and non-file URLs are ignored", async () => {
  const noopUploader: ScreenshotUploader = async () => ({ path: "", basename: "" });
  let asked: string[] = [];
  const resolver: RefResolver = async (paths) => { asked = paths; return paths.map((p) => ({ path: p, isDirectory: false })); };
  const dt = makeUriListTransfer({
    "text/uri-list": "# comment\nhttps://example.com/x\nfile:///Users/x/keep.txt",
  });
  await captureDroppedOrPastedItems(dt, noopUploader, resolver);
  expect(asked).toEqual(["/Users/x/keep.txt"]);
});

test("resolver throwing surfaces as error, not a silent drop", async () => {
  const noopUploader: ScreenshotUploader = async () => ({ path: "", basename: "" });
  const resolver: RefResolver = async () => { throw new Error("boom"); };
  const dt = makeUriListTransfer({ "text/uri-list": "file:///Users/x/a.txt" });
  const r = await captureDroppedOrPastedItems(dt, noopUploader, resolver);
  expect(r.items).toHaveLength(0);
  expect(r.error).toBe("boom");
});

test("resolver dropping a missing path is reflected in skipped", async () => {
  const noopUploader: ScreenshotUploader = async () => ({ path: "", basename: "" });
  // Two URLs in, one ref out (the other no longer exists on disk).
  const resolver: RefResolver = async () => [{ path: "/Users/x/a.txt", isDirectory: false } as TaskReference];
  const dt = makeUriListTransfer({
    "text/uri-list": "file:///Users/x/a.txt\nfile:///Users/x/gone.txt",
  });
  const r = await captureDroppedOrPastedItems(dt, noopUploader, resolver);
  expect(r.items).toHaveLength(1);
  expect(r.skipped).toBe(1);
});

test("mixed payload: pathful, blob, and skipped — all classified correctly", async () => {
  const uploader: ScreenshotUploader = async () => ({ path: "/tmp/screenshot.png", basename: "screenshot.png" });
  const dt = makeTransfer([
    { kind: "file", file: pathfulFile("a.png", "/abs/a.png") },
    { kind: "file", file: blobImage("paste.png") },
    { kind: "file", file: new File(["x"], "ignore.bin", { type: "application/octet-stream" }) },
    { kind: "file", file: pathfulFile("dir", "/abs/dir"), isDirectory: true },
  ]);
  const r = await captureDroppedOrPastedItems(dt, uploader);
  expect(r.items).toHaveLength(3);
  expect(r.skipped).toBe(1);
  // Order is preserved from the input.
  expect(r.items.map((i) => i.ref.path)).toEqual([
    "/abs/a.png",
    "/tmp/screenshot.png",
    "/abs/dir",
  ]);
  expect(r.items[2]!.ref.isDirectory).toBe(true);
});
