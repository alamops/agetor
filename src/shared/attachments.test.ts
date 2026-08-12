import { describe, expect, test } from "bun:test";
import {
  binaryPreviewKind,
  canonicalizeAttachmentText,
  contentTypeForPreviewPath,
  imageSourceMetaPath,
  isImagePath,
  isImageSourceMetaBreadcrumb,
  isPdfPath,
  MAX_BLOB_PREVIEW_BYTES,
  stripImagePlaceholders,
} from "./attachments.ts";

// Byte-exact captured shapes from a live repro (see attachments.ts header
// comment for the story). Newlines are real `\n` — callers CR-normalize
// before calling into this module, so the fixtures below do the same.
const IMG_PATH =
  "/Users/alamosaravali/.agetor/screenshots/screenshot-2026-07-29_15-38-35-8e708eec.png";

const LIVE_COPY =
  `[screenshot-2026-07-29_15-38-35-8e708eec.png] I got this\n\n`
  + `Referenced files/folders:\n`
  + `- ${IMG_PATH}`;

const JSONL_TWIN =
  `[Image #1][screenshot-2026-07-29_15-38-35-8e708eec.png] I got this\n\n`
  + `Referenced files/folders:\n`
  + `-`;

const EXPECTED_CANONICAL =
  `[screenshot-2026-07-29_15-38-35-8e708eec.png] I got this\n\n`
  + `Referenced files/folders:\n`
  + `-`;

describe("isImagePath", () => {
  test("matches every canonical extension, case-insensitively", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic"]) {
      expect(isImagePath(`/a/b/file.${ext}`)).toBe(true);
      expect(isImagePath(`/a/b/file.${ext.toUpperCase()}`)).toBe(true);
    }
  });

  test("bare filename with no directory still matches", () => {
    expect(isImagePath("screenshot.png")).toBe(true);
  });

  test(".jpeg specifically (the optional 'e' branch)", () => {
    expect(isImagePath("/a/photo.jpeg")).toBe(true);
    expect(isImagePath("/a/photo.JPEG")).toBe(true);
  });

  test("a directory path (trailing slash) is never an image, even with an image-like name", () => {
    expect(isImagePath("/a/b/foo.png/")).toBe(false);
    expect(isImagePath("/a/b/src/")).toBe(false);
  });

  test("a non-image extension does not match", () => {
    expect(isImagePath("/a/b/file.ts")).toBe(false);
    expect(isImagePath("/a/b/README.md")).toBe(false);
  });
});

describe("isPdfPath", () => {
  test("matches .pdf case-insensitively", () => {
    expect(isPdfPath("/a/b/report.pdf")).toBe(true);
    expect(isPdfPath("/a/b/report.PDF")).toBe(true);
    expect(isPdfPath("/a/b/report.Pdf")).toBe(true);
  });

  test("bare filename with no directory still matches", () => {
    expect(isPdfPath("report.pdf")).toBe(true);
  });

  test("a directory path (trailing slash) is never a pdf, even with a pdf-like name", () => {
    expect(isPdfPath("/a/b/foo.pdf/")).toBe(false);
  });

  test("a non-pdf extension does not match", () => {
    expect(isPdfPath("/a/b/file.png")).toBe(false);
    expect(isPdfPath("/a/b/README.md")).toBe(false);
  });

  test("extension-less path does not match", () => {
    expect(isPdfPath("/a/b/README")).toBe(false);
  });
});

describe("binaryPreviewKind", () => {
  test("every canonical image extension classifies as 'image', case-insensitively", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic"]) {
      expect(binaryPreviewKind(`/a/file.${ext}`)).toBe("image");
      expect(binaryPreviewKind(`/a/file.${ext.toUpperCase()}`)).toBe("image");
    }
  });

  test("pdf classifies as 'pdf', case-insensitively", () => {
    expect(binaryPreviewKind("/a/doc.pdf")).toBe("pdf");
    expect(binaryPreviewKind("/a/doc.PDF")).toBe("pdf");
  });

  test("a non-previewable binary extension classifies as null", () => {
    expect(binaryPreviewKind("/a/archive.zip")).toBeNull();
    expect(binaryPreviewKind("/a/data.bin")).toBeNull();
  });

  test("a textual extension classifies as null", () => {
    expect(binaryPreviewKind("/a/file.ts")).toBeNull();
  });

  test("an extension-less path classifies as null", () => {
    expect(binaryPreviewKind("/a/README")).toBeNull();
  });

  test("a directory path (trailing slash) classifies as null even with an image-like name", () => {
    expect(binaryPreviewKind("/a/foo.png/")).toBeNull();
  });
});

describe("contentTypeForPreviewPath", () => {
  test("png maps to image/png", () => {
    expect(contentTypeForPreviewPath("/a/shot.png")).toBe("image/png");
  });

  test("svg maps to image/svg+xml", () => {
    expect(contentTypeForPreviewPath("/a/icon.svg")).toBe("image/svg+xml");
  });

  test("pdf maps to application/pdf", () => {
    expect(contentTypeForPreviewPath("/a/report.pdf")).toBe("application/pdf");
  });

  test("every canonical image extension has a mapped content-type", () => {
    const expected: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      bmp: "image/bmp",
      ico: "image/x-icon",
      avif: "image/avif",
      heic: "image/heic",
    };
    for (const [ext, mime] of Object.entries(expected)) {
      expect(contentTypeForPreviewPath(`/a/file.${ext}`)).toBe(mime);
    }
  });

  test("case-insensitive on the extension", () => {
    expect(contentTypeForPreviewPath("/a/shot.PNG")).toBe("image/png");
    expect(contentTypeForPreviewPath("/a/report.PDF")).toBe("application/pdf");
  });

  test("an unrecognized extension maps to null", () => {
    expect(contentTypeForPreviewPath("/a/archive.zip")).toBeNull();
    expect(contentTypeForPreviewPath("/a/notes.txt")).toBeNull();
  });

  test("an extension-less path maps to null", () => {
    expect(contentTypeForPreviewPath("/a/README")).toBeNull();
  });
});

describe("MAX_BLOB_PREVIEW_BYTES", () => {
  test("is exported as the documented 20MB cap", () => {
    expect(MAX_BLOB_PREVIEW_BYTES).toBe(20_000_000);
  });
});

describe("IMAGE_PLACEHOLDER_RE / stripImagePlaceholders", () => {
  test("removes a single placeholder", () => {
    expect(stripImagePlaceholders("[Image #1] hello")).toBe(" hello");
  });

  test("removes multiple placeholders anywhere in the text, position-agnostic", () => {
    expect(stripImagePlaceholders("[Image #3][Image #4] two shots")).toBe(" two shots");
    expect(stripImagePlaceholders("before [Image #7] after")).toBe("before  after");
  });

  test("leaves text with no placeholder untouched", () => {
    expect(stripImagePlaceholders("no images here")).toBe("no images here");
  });

  test("repeated calls are stable (no lastIndex leakage from the shared global regex)", () => {
    const text = "[Image #1] hi";
    expect(stripImagePlaceholders(text)).toBe(" hi");
    expect(stripImagePlaceholders(text)).toBe(" hi");
    expect(stripImagePlaceholders("[Image #2] there")).toBe(" there");
    expect(stripImagePlaceholders(text)).toBe(" hi");
  });
});

describe("imageSourceMetaPath", () => {
  test("positive: exact synthetic shape returns the path", () => {
    const text = `[Image: source: ${IMG_PATH}]`;
    expect(imageSourceMetaPath(text)).toBe(IMG_PATH);
  });

  test("positive: tolerates surrounding whitespace", () => {
    const text = `  [Image: source: ${IMG_PATH}]  \n`;
    expect(imageSourceMetaPath(text)).toBe(IMG_PATH);
  });

  test("negative: ordinary text", () => {
    expect(imageSourceMetaPath("just a normal message")).toBeNull();
  });

  test("negative: a placeholder token is not the source-meta shape", () => {
    expect(imageSourceMetaPath("[Image #1]")).toBeNull();
  });

  test("negative: trailing content after the closing bracket", () => {
    expect(imageSourceMetaPath(`[Image: source: ${IMG_PATH}] trailing`)).toBeNull();
  });
});

describe("canonicalizeAttachmentText — golden convergence", () => {
  test("live copy and JSONL twin of the same send converge to one canonical string", () => {
    expect(canonicalizeAttachmentText(LIVE_COPY)).toBe(EXPECTED_CANONICAL);
    expect(canonicalizeAttachmentText(JSONL_TWIN)).toBe(EXPECTED_CANONICAL);
  });
});

describe("canonicalizeAttachmentText — identity contract", () => {
  test("plain text with no refs block and no placeholders is returned exactly unchanged", () => {
    const text = "just a normal reply about the bug";
    expect(canonicalizeAttachmentText(text)).toBe(text);
  });

  test("well-formed refs block of only non-image refs is untouched", () => {
    const text =
      "do the thing\n\nReferenced files/folders:\n- /a/b.ts\n- /a/src/";
    expect(canonicalizeAttachmentText(text)).toBe(text);
  });

  test("a literal bracket pattern that is not a placeholder ([not an image]) is untouched", () => {
    const text = "[not an image] just prose";
    expect(canonicalizeAttachmentText(text)).toBe(text);
  });

  test("command-XML text with no matching bullets/placeholders passes through unchanged", () => {
    const text =
      "<command-message>implement</command-message><command-name>/implement</command-name><command-args>do it</command-args>";
    expect(canonicalizeAttachmentText(text)).toBe(text);
  });

  test("malformed refs block (non-bullet line mixed in) is left untouched", () => {
    const text =
      "hi\n\nReferenced files/folders:\n- /a.png\nnot a bullet line";
    expect(canonicalizeAttachmentText(text)).toBe(text);
  });

  test("heading not exact (extra text on the heading line) is left untouched", () => {
    const text = "hi\n\nReferenced files/folders: extra\n- /a.png";
    expect(canonicalizeAttachmentText(text)).toBe(text);
  });
});

describe("canonicalizeAttachmentText — mixed refs", () => {
  test("image bullet is normalized to a bare '-'; directory and code-file bullets are kept verbatim, heading kept", () => {
    const text =
      "look at this\n\n"
      + "Referenced files/folders:\n"
      + "- /shots/pic.png\n"
      + "- /src/utils/\n"
      + "- /src/index.ts";
    expect(canonicalizeAttachmentText(text)).toBe(
      "look at this\n\n"
      + "Referenced files/folders:\n"
      + "-\n"
      + "- /src/utils/\n"
      + "- /src/index.ts",
    );
  });
});

describe("canonicalizeAttachmentText — multiple images", () => {
  test("two image placeholders + two bare bullets converge with a live copy carrying two image bullets", () => {
    const liveTwoImages =
      "[shot-a.png][shot-b.png] check these out\n\n"
      + "Referenced files/folders:\n"
      + "- /shots/shot-a.png\n"
      + "- /shots/shot-b.png";
    const twinTwoImages =
      "[Image #3][shot-a.png][Image #4][shot-b.png] check these out\n\n"
      + "Referenced files/folders:\n"
      + "-\n"
      + "-";
    const expected =
      "[shot-a.png][shot-b.png] check these out\n\n"
      + "Referenced files/folders:\n"
      + "-\n"
      + "-";
    expect(canonicalizeAttachmentText(liveTwoImages)).toBe(expected);
    expect(canonicalizeAttachmentText(twinTwoImages)).toBe(expected);
  });
});

describe("canonicalizeAttachmentText — bare bullet variants", () => {
  test("bare '-' with no trailing space is already canonical (identity, no rebuild)", () => {
    const text = "hi\n\nReferenced files/folders:\n-";
    expect(canonicalizeAttachmentText(text)).toBe(text);
  });

  test("bare '- ' with trailing space normalizes to a plain '-'", () => {
    const text = "hi\n\nReferenced files/folders:\n- ";
    expect(canonicalizeAttachmentText(text)).toBe("hi\n\nReferenced files/folders:\n-");
  });
});

describe("canonicalizeAttachmentText — never collapses to empty (heading always kept)", () => {
  test("all-image refs block keeps the heading, normalizing the bullet instead of dropping it", () => {
    const text =
      "just this image\n\n"
      + "Referenced files/folders:\n"
      + "- /shots/a.png";
    expect(canonicalizeAttachmentText(text)).toBe(
      "just this image\n\nReferenced files/folders:\n-",
    );
  });

  test("refs-only send (no preceding text) canonicalizes to the heading + bare bullet, never empty", () => {
    const text = "Referenced files/folders:\n- /shots/a.png";
    const result = canonicalizeAttachmentText(text);
    expect(result).toBe("Referenced files/folders:\n-");
    expect(result).not.toBe("");
  });

  test("two refs-only sends with DIFFERENT bullet counts get different canonical forms (no dedup collision)", () => {
    const oneRef = canonicalizeAttachmentText("Referenced files/folders:\n- /shots/a.png");
    const twoRefs = canonicalizeAttachmentText(
      "Referenced files/folders:\n- /shots/a.png\n- /shots/b.png",
    );
    expect(oneRef).not.toBe("");
    expect(twoRefs).not.toBe("");
    expect(oneRef).not.toBe(twoRefs);
  });
});

describe("canonicalizeAttachmentText — placeholder stripping outside any refs block", () => {
  test("a placeholder with no refs block at all is still stripped", () => {
    expect(canonicalizeAttachmentText("[Image #1] hello")).toBe(" hello");
  });
});

describe("canonicalizeAttachmentText — newline tolerance in the trailing refs block", () => {
  test("a stray \\r before the image bullet doesn't break recognition of the refs block", () => {
    const text = "hi\n\nReferenced files/folders:\r\n- /shots/a.png";
    expect(canonicalizeAttachmentText(text)).toBe("hi\n\nReferenced files/folders:\n-");
  });

  test("a bare-\\r-joined refs block (no real \\n at all in the last paragraph) still normalizes", () => {
    const text = "hi\n\nReferenced files/folders:\r- /shots/a.png";
    expect(canonicalizeAttachmentText(text)).toBe("hi\n\nReferenced files/folders:\n-");
  });
});

describe("isImageSourceMetaBreadcrumb", () => {
  test("positive: exact synthetic shape", () => {
    expect(isImageSourceMetaBreadcrumb(`[Image: source: ${IMG_PATH}]`)).toBe(true);
  });

  test("positive: truncated with a trailing ellipsis, no closing bracket", () => {
    const longPath = `/Users/alamosaravali/really/long/path/${"segment/".repeat(20)}shot.png`;
    const truncated = `[Image: source: ${longPath}`.slice(0, 137) + "…";
    expect(isImageSourceMetaBreadcrumb(truncated)).toBe(true);
  });

  test("positive: truncated with no ellipsis and no closing bracket", () => {
    const longPath = `/Users/alamosaravali/really/long/path/${"segment/".repeat(20)}shot.png`;
    const truncated = `[Image: source: ${longPath}`.slice(0, 137);
    expect(isImageSourceMetaBreadcrumb(truncated)).toBe(true);
  });

  test("positive: tolerates surrounding whitespace", () => {
    expect(isImageSourceMetaBreadcrumb(`  [Image: source: ${IMG_PATH}]  \n`)).toBe(true);
  });

  test("negative: plain status text", () => {
    expect(isImageSourceMetaBreadcrumb("Agent is working…")).toBe(false);
  });

  test("negative: an [Image #N] placeholder is not the source-meta breadcrumb shape", () => {
    expect(isImageSourceMetaBreadcrumb("[Image #1]")).toBe(false);
  });

  test("negative: empty string", () => {
    expect(isImageSourceMetaBreadcrumb("")).toBe(false);
  });
});
