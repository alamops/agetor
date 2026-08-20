// Electrobun's WKWebView exposes no `file://` URLs on a drop — unlike
// Chromium/Electron, WebKit's drag pasteboard hands the page a bare filename
// or an in-memory image, never a resolvable path (see the comment on
// `ElectroFile` in `src/mainview/lib/capture-refs.ts`). For non-image files
// and folders there is no bytes-only fallback either (you can't "upload" a
// directory), so recovering the dropped item's absolute path requires
// reaching past the webview entirely: macOS keeps the paths of whatever was
// just dragged on a well-known system pasteboard named "Apple CFPasteboard
// drag" (`NSPasteboardNameDrag`), independent of the webview's own drag
// handling. A drop event fires the instant the OS-level drag ends, so by the
// time the webview asks us to resolve paths, this pasteboard is guaranteed
// to still hold *that* drag's contents — nothing else could have started a
// new one in between on a single-user desktop session.
//
// There's no npm/Bun package for this, and shelling out to `osascript` can't
// read a pasteboard by name (only `NSPasteboard.general`). So we talk to the
// Objective-C runtime directly via `bun:ffi`, calling `objc_msgSend` against
// `NSPasteboard`/`NSString` the same way a compiled Cocoa helper would. This
// was spike-verified (see docs/spikes or the scratchpad spike this module
// was adapted from): `NSFilenamesPboardType` yields real POSIX paths, while
// the modern `public.file-url` UTI only yields file-id URLs
// (`file:///.file/id=…`) that don't resolve to a stable path — so we
// deliberately read the legacy type.
import { dlopen, FFIType, CString, ptr, type Pointer } from "bun:ffi";

const NS_PASTEBOARD_NAME_DRAG = "Apple CFPasteboard drag";
const NS_FILENAMES_PBOARD_TYPE = "NSFilenamesPboardType";

// objc_msgSend is C-variadic; bun:ffi has no variadic support, so — like the
// spike — we dlopen the same symbol multiple times under distinct fixed
// signatures and pick whichever matches the call we're making.
interface ObjcHandles {
  getClass: (name: Buffer) => Pointer | null;
  registerName: (name: Buffer) => Pointer | null;
  // (receiver, selector) -> ptr
  send0: (receiver: Pointer | null, sel: Pointer | null) => Pointer | null;
  // (receiver, selector, ptr-arg) -> ptr
  send1: (receiver: Pointer | null, sel: Pointer | null, arg: Pointer | null) => Pointer | null;
}

let handles: ObjcHandles | null = null;

function getHandles(): ObjcHandles {
  if (handles) return handles;

  // Load AppKit so the NSPasteboard/NSString classes are registered with the
  // objc runtime. dlopen needs at least one known C symbol to resolve.
  const appkit = dlopen("/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit", {
    NSApplicationLoad: { args: [], returns: FFIType.bool },
  });
  appkit.symbols.NSApplicationLoad();

  const objcBase = dlopen("/usr/lib/libobjc.A.dylib", {
    objc_getClass: { args: [FFIType.cstring], returns: FFIType.ptr },
    sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
  });
  const send0 = dlopen("/usr/lib/libobjc.A.dylib", {
    objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  }).symbols.objc_msgSend;
  const send1 = dlopen("/usr/lib/libobjc.A.dylib", {
    objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  }).symbols.objc_msgSend;

  handles = {
    getClass: objcBase.symbols.objc_getClass as ObjcHandles["getClass"],
    registerName: objcBase.symbols.sel_registerName as ObjcHandles["registerName"],
    send0: send0 as ObjcHandles["send0"],
    send1: send1 as ObjcHandles["send1"],
  };
  return handles;
}

function cls(h: ObjcHandles, name: string): Pointer | null {
  return h.getClass(Buffer.from(name + "\0"));
}

function sel(h: ObjcHandles, name: string): Pointer | null {
  return h.registerName(Buffer.from(name + "\0"));
}

function nsstr(h: ObjcHandles, s: string): Pointer | null {
  return h.send1(cls(h, "NSString"), sel(h, "stringWithUTF8String:"), ptr(Buffer.from(s + "\0")));
}

// objc autoreleased returns (NSString* etc.) are owned by the runtime's
// autorelease pool, not by us — no retain/release bookkeeping is needed for
// the handful of short-lived objects this module touches.
function jsstr(h: ObjcHandles, nsstring: Pointer | null): string | null {
  if (!nsstring) return null;
  const utf8 = h.send0(nsstring, sel(h, "UTF8String"));
  if (!utf8) return null;
  return new CString(utf8).toString();
}

/**
 * Extract the absolute paths from the plist XML that
 * `stringForType:NSFilenamesPboardType` returns: a `<plist>` wrapping an
 * `<array>` of `<string>` POSIX paths. Pure string/regex parsing — the shape
 * is a small, fixed Apple format, not general XML, so no parser dependency
 * is warranted. Returns `[]` for anything malformed or empty rather than
 * throwing, since a pasteboard's contents are outside our control.
 */
export function parseFilenamesPlist(xml: string): string[] {
  if (!xml) return [];
  const arrayMatch = xml.match(/<array>([\s\S]*?)<\/array>/);
  if (!arrayMatch) return [];
  const body = arrayMatch[1] ?? "";
  const paths: string[] = [];
  const stringRe = /<string>([\s\S]*?)<\/string>/g;
  let m: RegExpExecArray | null;
  while ((m = stringRe.exec(body)) !== null) {
    const decoded = decodeXmlEntities(m[1] ?? "");
    if (decoded) paths.push(decoded);
  }
  return paths;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&"); // must run last, or a literal "&amp;lt;" would double-decode
}

let readerOverride: (() => string[]) | null = null;

/**
 * Test-injection hook: when set, `readDragPasteboardPaths` delegates to
 * `fn` instead of touching the objc runtime. Pass `null` to restore the
 * real implementation.
 */
export function setDragPasteboardReaderForTests(fn: (() => string[]) | null): void {
  readerOverride = fn;
}

/**
 * Returns the absolute POSIX paths currently sitting on macOS's drag
 * pasteboard — i.e. the paths of whatever the user just dragged. Empty on
 * any non-darwin platform, on any FFI/objc failure, or when the pasteboard
 * holds no filenames (e.g. the drag wasn't file-backed at all, or it's
 * already been consumed).
 */
export function readDragPasteboardPaths(): string[] {
  if (readerOverride) return readerOverride();
  if (process.platform !== "darwin") return [];
  try {
    const h = getHandles();
    const pb = h.send1(cls(h, "NSPasteboard"), sel(h, "pasteboardWithName:"), nsstr(h, NS_PASTEBOARD_NAME_DRAG));
    if (!pb) return [];
    const value = h.send1(pb, sel(h, "stringForType:"), nsstr(h, NS_FILENAMES_PBOARD_TYPE));
    const xml = jsstr(h, value);
    if (!xml) return [];
    return parseFilenamesPlist(xml);
  } catch {
    // A pasteboard read is inherently best-effort (wrong OS version, objc
    // runtime hiccup, pasteboard mid-mutation) — degrade to no paths rather
    // than let this take down the request that asked for them.
    return [];
  }
}
