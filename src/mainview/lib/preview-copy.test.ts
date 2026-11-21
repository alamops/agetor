// `previewFailureTitle` is the one source of the tooltip every failed-thumbnail
// surface shows. These pin the exact copy: amber "not found" wording only for a
// proven 404, the neutral wording (first line) for everything else, and the full
// path on the line below.
import { describe, expect, test } from "bun:test";
import {
  NEUTRAL_CHIP_CLASS,
  PREVIEW_DENIED_COPY,
  PREVIEW_TOO_LARGE_COPY,
  PREVIEW_UNAVAILABLE_COPY,
  previewFailureTitle,
} from "./preview-copy.ts";

const PATH = "/Users/me/Desktop/Screenshot 2026-11-18 at 2.40.41 PM.png";

describe("previewFailureTitle", () => {
  test("missing keeps the exact amber copy", () => {
    expect(previewFailureTitle("missing", PATH)).toBe(`Image not found: ${PATH}`);
  });

  test("denied names the macOS privacy block, says click to open, then the path", () => {
    const title = previewFailureTitle("denied", PATH);
    expect(title).toBe(`${PREVIEW_DENIED_COPY} Click to open.\n${PATH}`);
    expect(title.startsWith("Preview blocked by macOS privacy")).toBe(true);
  });

  test("too-large and error use their own first line, then the path", () => {
    expect(previewFailureTitle("too-large", PATH)).toBe(`${PREVIEW_TOO_LARGE_COPY} Click to open.\n${PATH}`);
    expect(previewFailureTitle("error", PATH)).toBe(`${PREVIEW_UNAVAILABLE_COPY} Click to open.\n${PATH}`);
  });

  test("only the missing title claims the file was not found", () => {
    for (const failure of ["denied", "too-large", "error"] as const) {
      expect(previewFailureTitle(failure, PATH)).not.toContain("not found");
      expect(previewFailureTitle(failure, PATH).endsWith(`\n${PATH}`)).toBe(true);
    }
  });

  test("the path is carried verbatim (U+202F is not normalized)", () => {
    expect(previewFailureTitle("denied", PATH)).toContain("2.40.41 PM.png");
  });
});

describe("NEUTRAL_CHIP_CLASS", () => {
  test("uses semantic tokens only, never the warning palette or a literal one", () => {
    expect(NEUTRAL_CHIP_CLASS).toContain("border-border/60");
    expect(NEUTRAL_CHIP_CLASS).not.toMatch(/warning|rose|amber|emerald|red-|yellow/);
  });
});
