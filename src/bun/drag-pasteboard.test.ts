import { describe, test, expect, afterEach } from "bun:test";
import {
  parseFilenamesPlist,
  readDragPasteboardPaths,
  setDragPasteboardReaderForTests,
} from "./drag-pasteboard.ts";

// This file never touches the real drag pasteboard — `parseFilenamesPlist`
// is pure string parsing, and `readDragPasteboardPaths` is only exercised
// through the test-injection hook (or, once, against the real darwin
// implementation with its *shape* asserted, never its contents).

afterEach(() => {
  // Always restore, even if a test throws — cross-test leakage of an
  // injected reader would silently corrupt every test after it.
  setDragPasteboardReaderForTests(null);
});

describe("parseFilenamesPlist", () => {
  test("single path", () => {
    const xml = `<plist><array><string>/Users/alamo/notes.txt</string></array></plist>`;
    expect(parseFilenamesPlist(xml)).toEqual(["/Users/alamo/notes.txt"]);
  });

  test("multiple paths", () => {
    const xml =
      `<plist><array>`
      + `<string>/Users/alamo/a.txt</string>`
      + `<string>/Users/alamo/b.txt</string>`
      + `<string>/Users/alamo/dir</string>`
      + `</array></plist>`;
    expect(parseFilenamesPlist(xml)).toEqual([
      "/Users/alamo/a.txt",
      "/Users/alamo/b.txt",
      "/Users/alamo/dir",
    ]);
  });

  test("empty array yields []", () => {
    const xml = `<plist><array></array></plist>`;
    expect(parseFilenamesPlist(xml)).toEqual([]);
  });

  test("malformed XML yields []", () => {
    expect(parseFilenamesPlist("<plist><array><string>unterminated")).toEqual([]);
  });

  test("garbage input yields []", () => {
    expect(parseFilenamesPlist("not xml at all, just garbage {}[]")).toEqual([]);
  });

  test("empty string yields []", () => {
    expect(parseFilenamesPlist("")).toEqual([]);
  });

  test("no <array> tag yields []", () => {
    expect(parseFilenamesPlist("<plist><dict><key>foo</key></dict></plist>")).toEqual([]);
  });

  describe("XML entity decoding", () => {
    const wrap = (inner: string) => `<plist><array><string>${inner}</string></array></plist>`;

    test("&amp; decodes to &", () => {
      expect(parseFilenamesPlist(wrap("Fish &amp; Chips"))).toEqual(["Fish & Chips"]);
    });

    test("&lt; decodes to <", () => {
      expect(parseFilenamesPlist(wrap("a &lt; b"))).toEqual(["a < b"]);
    });

    test("&gt; decodes to >", () => {
      expect(parseFilenamesPlist(wrap("a &gt; b"))).toEqual(["a > b"]);
    });

    test("&quot; decodes to a double quote", () => {
      expect(parseFilenamesPlist(wrap("say &quot;hi&quot;"))).toEqual(['say "hi"']);
    });

    test("&#39; decodes to a single quote", () => {
      expect(parseFilenamesPlist(wrap("O&#39;Brien"))).toEqual(["O'Brien"]);
    });

    test("&apos; decodes to a single quote", () => {
      expect(parseFilenamesPlist(wrap("O&apos;Brien"))).toEqual(["O'Brien"]);
    });

    test("numeric decimal &#38; decodes to &", () => {
      expect(parseFilenamesPlist(wrap("Fish &#38; Chips"))).toEqual(["Fish & Chips"]);
    });

    test("hex &#x26; decodes to &", () => {
      expect(parseFilenamesPlist(wrap("Fish &#x26; Chips"))).toEqual(["Fish & Chips"]);
    });

    test("hex entity is case-insensitive (&#X26;)", () => {
      expect(parseFilenamesPlist(wrap("Fish &#X26; Chips"))).toEqual(["Fish & Chips"]);
    });

    // decodeXmlEntities runs &amp; last specifically so a literal, already
    // double-escaped "&amp;lt;" decodes to the literal text "&lt;" rather
    // than fully unescaping down to "<" (see the "must run last" comment in
    // drag-pasteboard.ts). Assert that ordering directly.
    test("amp-last ordering: doubly-escaped &amp;lt; stops at &lt; (does not double-decode to <)", () => {
      expect(parseFilenamesPlist(wrap("&amp;lt;"))).toEqual(["&lt;"]);
    });

    test("amp-last ordering: doubly-escaped &amp;amp; stops at &amp; (does not double-decode to &)", () => {
      expect(parseFilenamesPlist(wrap("&amp;amp;"))).toEqual(["&amp;"]);
    });
  });

  test("paths with spaces decode correctly", () => {
    const xml = `<plist><array><string>/Users/alamo/My Documents/report.pdf</string></array></plist>`;
    expect(parseFilenamesPlist(xml)).toEqual(["/Users/alamo/My Documents/report.pdf"]);
  });

  test("paths with unicode decode correctly", () => {
    const xml = `<plist><array><string>/Users/alamo/日本語/résumé.pdf</string></array></plist>`;
    expect(parseFilenamesPlist(xml)).toEqual(["/Users/alamo/日本語/résumé.pdf"]);
  });
});

describe("readDragPasteboardPaths", () => {
  test("returns the injected values when a test reader is set", () => {
    setDragPasteboardReaderForTests(() => ["/tmp/a.txt", "/tmp/b"]);
    expect(readDragPasteboardPaths()).toEqual(["/tmp/a.txt", "/tmp/b"]);
  });

  test("an injected reader returning [] yields []", () => {
    setDragPasteboardReaderForTests(() => []);
    expect(readDragPasteboardPaths()).toEqual([]);
  });

  // The override is read and returned *before* the try/catch that wraps the
  // real objc-runtime call (see the source: `if (readerOverride) return
  // readerOverride();` sits above the `try` block) — so unlike the real
  // implementation's best-effort degrade-to-[] behavior, an injected reader
  // that throws is NOT caught here. Written to match that actual semantics.
  test("propagates a throw from the injected reader (not caught, unlike the real implementation)", () => {
    setDragPasteboardReaderForTests(() => {
      throw new Error("injected boom");
    });
    expect(() => readDragPasteboardPaths()).toThrow("injected boom");
  });

  test("setDragPasteboardReaderForTests(null) restores the real implementation", () => {
    setDragPasteboardReaderForTests(() => ["/tmp/injected-only"]);
    expect(readDragPasteboardPaths()).toEqual(["/tmp/injected-only"]);

    setDragPasteboardReaderForTests(null);
    const real = readDragPasteboardPaths();
    // No longer the injected value — the real (darwin) reader is back in
    // control. Assert shape only; see the next test for content contract.
    expect(real).not.toEqual(["/tmp/injected-only"]);
  });

  test("the real reader on this darwin machine returns a string array without throwing", () => {
    // No injection here — exercises the actual objc-runtime path. The
    // pasteboard's live contents are outside our control (whatever, if
    // anything, was last dragged on this machine), so only the shape is
    // asserted, never specific contents.
    expect(() => {
      const result = readDragPasteboardPaths();
      expect(Array.isArray(result)).toBe(true);
      for (const p of result) expect(typeof p).toBe("string");
    }).not.toThrow();
  });
});
