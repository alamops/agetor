import { describe, expect, test } from "bun:test";
import type { Element } from "hast";
import { classifyMdImageSrc, fileUrlToPath, mdUrlTransform } from "./md-image";

function el(tagName: string): Element {
  return { type: "element", tagName, properties: {}, children: [] };
}

describe("classifyMdImageSrc", () => {
  test("an https URL passes through as remote, trimmed", () => {
    expect(classifyMdImageSrc("  https://x/a.png  ", [])).toEqual({
      kind: "remote",
      url: "https://x/a.png",
    });
  });

  test("an uppercase HTTP scheme is still remote (case-insensitive scheme match)", () => {
    expect(classifyMdImageSrc("HTTP://x/a.png", [])).toEqual({
      kind: "remote",
      url: "HTTP://x/a.png",
    });
  });

  test("an absolute image path is local with one candidate equal to the path", () => {
    expect(classifyMdImageSrc("/tmp/a.png", [])).toEqual({
      kind: "local",
      path: "/tmp/a.png",
      candidates: ["/tmp/a.png"],
    });
  });

  test("an absolute non-image path is file", () => {
    expect(classifyMdImageSrc("/tmp/r.pdf", [])).toEqual({
      kind: "file",
      path: "/tmp/r.pdf",
      candidates: ["/tmp/r.pdf"],
    });
  });

  test("an absolute directory ref (trailing slash) is file, not local", () => {
    expect(classifyMdImageSrc("/tmp/dir/", [])).toEqual({
      kind: "file",
      path: "/tmp/dir/",
      candidates: ["/tmp/dir/"],
    });
  });

  test("extension matching is case-insensitive", () => {
    expect(classifyMdImageSrc("/tmp/a.PNG", [])).toEqual({
      kind: "local",
      path: "/tmp/a.PNG",
      candidates: ["/tmp/a.PNG"],
    });
  });

  test("a relative path resolves against the first usable root, skipping a null one", () => {
    expect(classifyMdImageSrc("docs/x.png", [null, "/w"])).toEqual({
      kind: "local",
      path: "/w/docs/x.png",
      candidates: ["/w/docs/x.png"],
    });
  });

  test("a relative path resolves against every usable root, in order", () => {
    expect(classifyMdImageSrc("docs/x.png", ["/wt", "/w"])).toEqual({
      kind: "local",
      path: "/wt/docs/x.png",
      candidates: ["/wt/docs/x.png", "/w/docs/x.png"],
    });
  });

  test("duplicate roots collapse to a single candidate", () => {
    expect(classifyMdImageSrc("docs/x.png", ["/w", "/w"])).toEqual({
      kind: "local",
      path: "/w/docs/x.png",
      candidates: ["/w/docs/x.png"],
    });
  });

  test("a leading @ mention prefix is stripped before resolving", () => {
    expect(classifyMdImageSrc("@x.png", ["/w"])).toEqual({
      kind: "local",
      path: "/w/x.png",
      candidates: ["/w/x.png"],
    });
  });

  test("a leading ./ prefix is stripped before resolving", () => {
    expect(classifyMdImageSrc("./x.png", ["/w"])).toEqual({
      kind: "local",
      path: "/w/x.png",
      candidates: ["/w/x.png"],
    });
  });

  test("a leading .. segment climbs out of a subdirectory root", () => {
    expect(classifyMdImageSrc("../x.png", ["/w/sub"])).toEqual({
      kind: "local",
      path: "/w/x.png",
      candidates: ["/w/x.png"],
    });
  });

  test(".. never climbs above the leading / of an absolute path", () => {
    expect(classifyMdImageSrc("/a/../../b.png", [])).toEqual({
      kind: "local",
      path: "/b.png",
      candidates: ["/b.png"],
    });
  });

  test("no usable roots ([]) leaves candidates empty and displays the stripped relative text", () => {
    expect(classifyMdImageSrc("docs/x.png", [])).toEqual({
      kind: "local",
      path: "docs/x.png",
      candidates: [],
    });
  });

  test("no usable roots ([null, undefined, \"\"]) leaves candidates empty and displays the stripped relative text", () => {
    expect(classifyMdImageSrc("docs/x.png", [null, undefined, ""])).toEqual({
      kind: "local",
      path: "docs/x.png",
      candidates: [],
    });
  });

  test("an empty string src is empty", () => {
    expect(classifyMdImageSrc("", [])).toEqual({ kind: "empty" });
  });

  test("a whitespace-only src is empty", () => {
    expect(classifyMdImageSrc("   ", [])).toEqual({ kind: "empty" });
  });

  test("a null src is empty", () => {
    expect(classifyMdImageSrc(null, [])).toEqual({ kind: "empty" });
  });

  test("an undefined src is empty", () => {
    expect(classifyMdImageSrc(undefined, [])).toEqual({ kind: "empty" });
  });

  test("a percent-encoded file:// URL unwraps and decodes to a local path", () => {
    expect(classifyMdImageSrc("file:///tmp/a%20b.png", [])).toEqual({
      kind: "local",
      path: "/tmp/a b.png",
      candidates: ["/tmp/a b.png"],
    });
  });

  test("file://localhost is treated the same as an empty host", () => {
    expect(classifyMdImageSrc("file://localhost/tmp/a.png", [])).toEqual({
      kind: "local",
      path: "/tmp/a.png",
      candidates: ["/tmp/a.png"],
    });
  });

  test("a foreign file:// host is rejected as empty", () => {
    expect(classifyMdImageSrc("file://evil/tmp/a.png", [])).toEqual({ kind: "empty" });
  });

  test("malformed percent-encoding in a file:// URL is rejected as empty, not thrown", () => {
    expect(classifyMdImageSrc("file:///tmp/%E0.png", [])).toEqual({ kind: "empty" });
  });

  test("a file:// URL's query string and hash fragment are both stripped from the resolved path", () => {
    expect(classifyMdImageSrc("file:///tmp/a.png?x=1#y", [])).toEqual({
      kind: "local",
      path: "/tmp/a.png",
      candidates: ["/tmp/a.png"],
    });
  });

  test("surrounding whitespace is trimmed before classification", () => {
    expect(classifyMdImageSrc("  /tmp/a.png  ", [])).toEqual({
      kind: "local",
      path: "/tmp/a.png",
      candidates: ["/tmp/a.png"],
    });
  });

  // Not a `remote` (no https? scheme) and not `^file:` either, so this falls
  // through to the relative branch: it's neither stripped of an `@`/`./`
  // prefix (it has none) nor found under any root, so with no roots it
  // reports as `file` (no image extension) with the whole string as the
  // display path and zero candidates. react-markdown's own default
  // `urlTransform` would already have blanked a real `data:` src to `""`
  // before it ever reaches this classifier (see the `mdUrlTransform` tests
  // below) — this pins what `classifyMdImageSrc` does if one reaches it
  // anyway (e.g. a future caller that skips `mdUrlTransform`).
  test("a data: URI is not recognized as remote/file: and falls through to the relative branch", () => {
    expect(classifyMdImageSrc("data:image/png;base64,AAAA", [])).toEqual({
      kind: "file",
      path: "data:image/png;base64,AAAA",
      candidates: [],
    });
  });
});

describe("fileUrlToPath", () => {
  test("a triple-slash file URL unwraps to an absolute path", () => {
    expect(fileUrlToPath("file:///tmp/a.png")).toBe("/tmp/a.png");
  });

  test("a localhost host is accepted the same as an empty host", () => {
    expect(fileUrlToPath("file://localhost/tmp/a.png")).toBe("/tmp/a.png");
  });

  test("a non-localhost host is rejected", () => {
    expect(fileUrlToPath("file://evil/tmp/a.png")).toBeNull();
  });

  test("percent-encoded characters are decoded", () => {
    expect(fileUrlToPath("file:///tmp/a%20b.png")).toBe("/tmp/a b.png");
  });

  test("malformed percent-encoding returns null instead of throwing", () => {
    expect(fileUrlToPath("file:///tmp/%E0.png")).toBeNull();
  });

  test("a query string and hash fragment are both stripped", () => {
    expect(fileUrlToPath("file:///tmp/a.png?x=1#y")).toBe("/tmp/a.png");
  });

  test("surrounding whitespace is trimmed", () => {
    expect(fileUrlToPath("  file:///tmp/a.png  ")).toBe("/tmp/a.png");
  });

  test("a non-file: input returns null", () => {
    expect(fileUrlToPath("https://x/a.png")).toBeNull();
  });

  test("a host with no path component returns null rather than fabricating one", () => {
    expect(fileUrlToPath("file://localhost")).toBeNull();
  });
});

describe("mdUrlTransform", () => {
  test("a file:// value on img/src unwraps to the local path", () => {
    expect(mdUrlTransform("file:///tmp/a.png", "src", el("img"))).toBe("/tmp/a.png");
  });

  test("the same file:// value on a/href is blanked (default react-markdown behavior, unchanged)", () => {
    expect(mdUrlTransform("file:///tmp/a.png", "href", el("a"))).toBe("");
  });

  test("an https URL passes through unchanged", () => {
    expect(mdUrlTransform("https://x/a.png", "src", el("img"))).toBe("https://x/a.png");
  });

  test("an absolute local path passes through unchanged", () => {
    expect(mdUrlTransform("/tmp/a.png", "src", el("img"))).toBe("/tmp/a.png");
  });

  test("a relative path passes through unchanged", () => {
    expect(mdUrlTransform("docs/x.png", "src", el("img"))).toBe("docs/x.png");
  });

  test("a data: URI is blanked", () => {
    expect(mdUrlTransform("data:image/png;base64,AAAA", "src", el("img"))).toBe("");
  });

  test("a Windows-style path is blanked", () => {
    expect(mdUrlTransform("C:\\a.png", "src", el("img"))).toBe("");
  });

  test("javascript: on a/href is blanked", () => {
    expect(mdUrlTransform("javascript:alert(1)", "href", el("a"))).toBe("");
  });

  test("mailto: on a/href passes through unchanged", () => {
    expect(mdUrlTransform("mailto:x@y", "href", el("a"))).toBe("mailto:x@y");
  });
});
