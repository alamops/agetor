import { describe, expect, test } from "bun:test";
import { computeAtHighlights, isListedPath, type HighlightSegment } from "./at-highlight.ts";

/** Every test's segments must reconstruct the original text exactly — this
 *  invariant is checked alongside the segment shape in most cases below. */
function joined(segments: HighlightSegment[]): string {
  return segments.map((s) => s.text).join("");
}

describe("computeAtHighlights", () => {
  test("empty text returns []", () => {
    expect(computeAtHighlights("", () => true)).toEqual([]);
  });

  test("no tokens: whole text is one plain segment", () => {
    const text = "just some prose with no at signs at all";
    const segments = computeAtHighlights(text, () => true);
    expect(segments).toEqual([{ text, mark: false }]);
    expect(joined(segments)).toBe(text);
  });

  test("one valid token: marked segment carries the raw @-text", () => {
    const text = "see @README.md now";
    const segments = computeAtHighlights(text, (p) => p === "README.md");
    expect(segments).toEqual([
      { text: "see ", mark: false },
      { text: "@README.md", mark: true },
      { text: " now", mark: false },
    ]);
    expect(joined(segments)).toBe(text);
  });

  test("one invalid token: stays plain, folded into surrounding text", () => {
    const text = "see @nope.md now";
    const segments = computeAtHighlights(text, () => false);
    expect(segments).toEqual([{ text, mark: false }]);
    expect(joined(segments)).toBe(text);
  });

  test("mixed valid and invalid tokens", () => {
    const text = "@README.md and @nope.md and @src/";
    const segments = computeAtHighlights(text, (p) => p === "README.md" || p === "src/");
    expect(segments).toEqual([
      { text: "@README.md", mark: true },
      { text: " and @nope.md and ", mark: false },
      { text: "@src/", mark: true },
    ]);
    expect(joined(segments)).toBe(text);
  });

  test("adjacent tokens separated by a single space both validate", () => {
    const text = "@a.md @b.md";
    const segments = computeAtHighlights(text, () => true);
    expect(segments).toEqual([
      { text: "@a.md", mark: true },
      { text: " ", mark: false },
      { text: "@b.md", mark: true },
    ]);
    expect(joined(segments)).toBe(text);
  });

  test("adjacent tokens separated by a single space, both invalid, merge into one plain run", () => {
    const text = "@a.md @b.md";
    const segments = computeAtHighlights(text, () => false);
    expect(segments).toEqual([{ text, mark: false }]);
    expect(joined(segments)).toBe(text);
  });

  test("quoted token with a space in the path", () => {
    const text = 'open @"docs/my file.md" please';
    const segments = computeAtHighlights(text, (p) => p === "docs/my file.md");
    expect(segments).toEqual([
      { text: "open ", mark: false },
      { text: '@"docs/my file.md"', mark: true },
      { text: " please", mark: false },
    ]);
    expect(joined(segments)).toBe(text);
  });

  test("directory token (trailing slash) is passed isDirectory: true", () => {
    const text = "look in @src/bun/ for it";
    const calls: Array<{ path: string; isDirectory: boolean }> = [];
    const segments = computeAtHighlights(text, (path, isDirectory) => {
      calls.push({ path, isDirectory });
      return path === "src/bun/";
    });
    expect(calls).toEqual([{ path: "src/bun/", isDirectory: true }]);
    expect(segments).toEqual([
      { text: "look in ", mark: false },
      { text: "@src/bun/", mark: true },
      { text: " for it", mark: false },
    ]);
  });

  test("bare-dir rule: a token typed without a trailing slash highlights via isListedPath when the directory is listed", () => {
    const validPaths = new Set(["src/bun/"]);
    const text = "see @src/bun for details";
    const segments = computeAtHighlights(text, (p, isDirectory) => isListedPath(validPaths, p, isDirectory));
    expect(segments).toEqual([
      { text: "see ", mark: false },
      { text: "@src/bun", mark: true },
      { text: " for details", mark: false },
    ]);
    expect(joined(segments)).toBe(text);
  });

  test("CRLF text is preserved verbatim across segments", () => {
    const text = "line1\r\n@a.md\r\nline2";
    const segments = computeAtHighlights(text, (p) => p === "a.md");
    expect(joined(segments)).toBe(text);
    expect(segments).toEqual([
      { text: "line1\r\n", mark: false },
      { text: "@a.md", mark: true },
      { text: "\r\nline2", mark: false },
    ]);
  });
});

describe("isListedPath", () => {
  test("exact match", () => {
    expect(isListedPath(new Set(["src/bun/db.ts"]), "src/bun/db.ts", false)).toBe(true);
  });

  test("directory token matches its own trailing-slash entry", () => {
    expect(isListedPath(new Set(["src/bun/"]), "src/bun/", true)).toBe(true);
  });

  test("no match", () => {
    expect(isListedPath(new Set(["src/bun/db.ts"]), "src/other.ts", false)).toBe(false);
  });

  test("bare directory path (no trailing slash, isDirectory: false) matches the listed directory's trailing-slash form", () => {
    expect(isListedPath(new Set(["src/bun/"]), "src/bun", false)).toBe(true);
  });

  test("bare directory rule does not apply when the token itself was typed as a directory (isDirectory: true) and only the file exists", () => {
    // Appending a second trailing slash would never hit — a directory token
    // must match validPaths on its own.
    expect(isListedPath(new Set(["src/bun"]), "src/bun/", true)).toBe(false);
  });
});
