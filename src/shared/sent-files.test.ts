import { describe, expect, test } from "bun:test";
import {
  formatByteSize,
  MAX_SENT_FILES,
  mergeSentFiles,
  parseSentFilesToolResult,
  parseSentFilesToolUse,
  sanitizeToolResultAttachments,
  SENT_FILES_DELIVERED_RE,
  SENT_FILES_TOOL_NAME,
  sentFileBasename,
  sentFilesSummaryLine,
  toolResultText,
} from "./sent-files.ts";
import type { SentFileEntry, ToolResultAttachment } from "./types.ts";

// Byte-exact captured shapes from real Claude Code 2.1.258-2.1.263
// transcripts + a live probe — see sent-files.ts header comment.
function successText(n: number, paths: string[]): string {
  const noun = n === 1 ? "file" : "files";
  const lines = paths.map((p) => `  ${p} → file_uuid: 1097286c-4e3d-4fe5-864a-abc123def456`);
  return `${n} ${noun} delivered to user.\n${lines.join("\n")}`;
}

const DIR_ERROR_WRAPPED =
  '<tool_use_error>Attachment "/abs/dir" is not a regular file.</tool_use_error>';

describe("parseSentFilesToolResult — success", () => {
  test("1 file", () => {
    const text = successText(1, ["/abs/a.png"]);
    const result = parseSentFilesToolResult(text, undefined, null);
    expect(result.delivered).toBe(true);
    expect(result.deliveredCount).toBe(1);
    expect(result.error).toBeNull();
    expect(result.attachments).toEqual([]);
  });

  test("2 files", () => {
    const text = successText(2, ["/abs/a.png", "/abs/b.md"]);
    const result = parseSentFilesToolResult(text, false, null);
    expect(result.delivered).toBe(true);
    expect(result.deliveredCount).toBe(2);
    expect(result.error).toBeNull();
  });

  test("10 files", () => {
    const paths = Array.from({ length: 10 }, (_, i) => `/abs/file${i}.txt`);
    const text = successText(10, paths);
    const result = parseSentFilesToolResult(text, undefined, null);
    expect(result.deliveredCount).toBe(10);
  });

  test("passes through the sanitized attachments array", () => {
    const attachments: ToolResultAttachment[] = [
      { path: "/abs/a.png", size: 238784, isImage: true, mediaType: "image/png" },
    ];
    const text = successText(1, ["/abs/a.png"]);
    const result = parseSentFilesToolResult(text, false, attachments);
    expect(result.attachments).toEqual(attachments);
  });

  test("content as an array of text blocks is flattened", () => {
    const content = [
      { type: "text", text: "1 file delivered to user." },
      { type: "text", text: "  /abs/a.png → file_uuid: abc" },
    ];
    const result = parseSentFilesToolResult(content, undefined, null);
    expect(result.delivered).toBe(true);
    expect(result.deliveredCount).toBe(1);
  });

  test("non-error unrecognized text still counts as delivered, with a null count", () => {
    const result = parseSentFilesToolResult("something unexpected happened", false, null);
    expect(result.delivered).toBe(true);
    expect(result.deliveredCount).toBeNull();
    expect(result.error).toBeNull();
  });

  test("no attachments argument defaults to an empty array", () => {
    const result = parseSentFilesToolResult(successText(1, ["/a.png"]), false);
    expect(result.attachments).toEqual([]);
  });
});

describe("parseSentFilesToolResult — error", () => {
  test("directory-rejection error strips the <tool_use_error> wrapper", () => {
    const result = parseSentFilesToolResult(DIR_ERROR_WRAPPED, true, null);
    expect(result.delivered).toBe(false);
    expect(result.deliveredCount).toBeNull();
    expect(result.error).toBe('Attachment "/abs/dir" is not a regular file.');
    expect(result.attachments).toEqual([]);
  });

  test("Error:-prefixed text strips the prefix", () => {
    const result = parseSentFilesToolResult("Error: Attachment \"/abs/dir\" is not a regular file.", true, null);
    expect(result.error).toBe('Attachment "/abs/dir" is not a regular file.');
  });

  test("empty error text falls back to a generic message", () => {
    const result = parseSentFilesToolResult("", true, null);
    expect(result.error).toBe("Send failed.");
  });

  test("array-of-text-block error content is flattened before unwrapping", () => {
    const content = [{ type: "text", text: DIR_ERROR_WRAPPED }];
    const result = parseSentFilesToolResult(content, true, null);
    expect(result.error).toBe('Attachment "/abs/dir" is not a regular file.');
  });
});

describe("SENT_FILES_DELIVERED_RE", () => {
  test("matches singular and plural forms", () => {
    expect(SENT_FILES_DELIVERED_RE.exec("1 file delivered to user.")?.[1]).toBe("1");
    expect(SENT_FILES_DELIVERED_RE.exec("2 files delivered to user.")?.[1]).toBe("2");
    expect(SENT_FILES_DELIVERED_RE.exec("not a delivery message")).toBeNull();
  });
});

describe("toolResultText", () => {
  test("passes a string through unchanged", () => {
    expect(toolResultText("hello")).toBe("hello");
  });

  test("joins text blocks in an array, dropping non-text blocks", () => {
    const content = [
      { type: "text", text: "a" },
      { type: "image", text: "ignored" },
      { type: "text", text: "b" },
    ];
    expect(toolResultText(content)).toBe("a\nb");
  });

  test("returns empty string for unrecognized shapes", () => {
    expect(toolResultText(42)).toBe("");
    expect(toolResultText(null)).toBe("");
    expect(toolResultText(undefined)).toBe("");
    expect(toolResultText({})).toBe("");
  });
});

describe("parseSentFilesToolUse", () => {
  test("parses a full, well-formed call", () => {
    const req = parseSentFilesToolUse(SENT_FILES_TOOL_NAME, {
      files: ["/abs/a.png", "/abs/b.md"],
      caption: "  here you go  ",
      status: "proactive",
      display: "attach",
    });
    expect(req).toEqual({
      files: ["/abs/a.png", "/abs/b.md"],
      caption: "here you go",
      status: "proactive",
      display: "attach",
    });
  });

  test("optional caption/status/display default to null when absent", () => {
    const req = parseSentFilesToolUse(SENT_FILES_TOOL_NAME, { files: ["/abs/a.png"] });
    expect(req).toEqual({ files: ["/abs/a.png"], caption: null, status: null, display: null });
  });

  test("drops non-string and empty entries from files", () => {
    const req = parseSentFilesToolUse(SENT_FILES_TOOL_NAME, {
      files: ["/abs/a.png", "", "   ", 42, null, "/abs/b.md"],
    });
    expect(req?.files).toEqual(["/abs/a.png", "/abs/b.md"]);
  });

  test("rejects the wrong tool name", () => {
    expect(parseSentFilesToolUse("SomeOtherTool", { files: ["/abs/a.png"] })).toBeNull();
  });

  test("rejects a missing files field", () => {
    expect(parseSentFilesToolUse(SENT_FILES_TOOL_NAME, { caption: "hi" })).toBeNull();
  });

  test("rejects an all-empty files array", () => {
    expect(parseSentFilesToolUse(SENT_FILES_TOOL_NAME, { files: ["", "   ", 1] })).toBeNull();
  });

  test("rejects non-object input", () => {
    expect(parseSentFilesToolUse(SENT_FILES_TOOL_NAME, null)).toBeNull();
    expect(parseSentFilesToolUse(SENT_FILES_TOOL_NAME, "not an object")).toBeNull();
    expect(parseSentFilesToolUse(SENT_FILES_TOOL_NAME, ["/abs/a.png"])).toBeNull();
    expect(parseSentFilesToolUse(SENT_FILES_TOOL_NAME, undefined)).toBeNull();
  });

  test("normalizes an unknown status/display to null", () => {
    const req = parseSentFilesToolUse(SENT_FILES_TOOL_NAME, {
      files: ["/abs/a.png"],
      status: "urgent",
      display: "modal",
    });
    expect(req?.status).toBeNull();
    expect(req?.display).toBeNull();
  });

  test("normalizes a blank caption to null", () => {
    const req = parseSentFilesToolUse(SENT_FILES_TOOL_NAME, { files: ["/abs/a.png"], caption: "   " });
    expect(req?.caption).toBeNull();
  });
});

describe("sanitizeToolResultAttachments", () => {
  test("maps claude's real item shape, dropping fields we don't keep", () => {
    const raw = [
      {
        path: "/abs/a.png",
        size: 238784,
        isImage: true,
        media_type: "image/png",
        pathValidated: true,
        file_uuid: "1097286c-4e3d-4fe5-864a-abc123def456",
      },
    ];
    expect(sanitizeToolResultAttachments(raw)).toEqual([
      { path: "/abs/a.png", size: 238784, isImage: true, mediaType: "image/png" },
    ]);
  });

  test("accepts a camelCase mediaType fallback", () => {
    const raw = [{ path: "/abs/a.png", mediaType: "image/png" }];
    expect(sanitizeToolResultAttachments(raw)).toEqual([
      { path: "/abs/a.png", size: null, isImage: null, mediaType: "image/png" },
    ]);
  });

  test("drops malformed items but keeps the well-formed ones", () => {
    const raw = [
      { path: "/abs/a.png", size: 100, isImage: false, media_type: "text/markdown" },
      { path: "" }, // empty path
      { size: 5 }, // no path at all
      "not an object",
      null,
      { path: "/abs/b.md", size: -5, isImage: "yes", media_type: 42 },
    ];
    expect(sanitizeToolResultAttachments(raw)).toEqual([
      { path: "/abs/a.png", size: 100, isImage: false, mediaType: "text/markdown" },
      { path: "/abs/b.md", size: null, isImage: null, mediaType: null },
    ]);
  });

  test("an empty array input yields an empty array", () => {
    expect(sanitizeToolResultAttachments([])).toEqual([]);
  });

  test("a non-array input yields null", () => {
    expect(sanitizeToolResultAttachments(null)).toBeNull();
    expect(sanitizeToolResultAttachments(undefined)).toBeNull();
    expect(sanitizeToolResultAttachments("nope")).toBeNull();
    expect(sanitizeToolResultAttachments({ attachments: [] })).toBeNull();
  });
});

function entry(path: string, sentAt: number, runId = "run-1"): SentFileEntry {
  return { path, size: null, mediaType: null, isImage: null, sentAt, runId };
}

describe("mergeSentFiles", () => {
  test("an incoming entry replaces an existing one with the same path", () => {
    const existing = [entry("/a.png", 100, "run-1")];
    const incoming = [entry("/a.png", 50, "run-2")]; // older sentAt, still wins as "incoming"
    const merged = mergeSentFiles(existing, incoming);
    expect(merged).toEqual([entry("/a.png", 50, "run-2")]);
  });

  test("among duplicate incoming entries for the same path, the latest sentAt wins", () => {
    const merged = mergeSentFiles([], [
      entry("/a.png", 10, "run-1"),
      entry("/a.png", 30, "run-2"),
      entry("/a.png", 20, "run-3"),
    ]);
    expect(merged).toEqual([entry("/a.png", 30, "run-2")]);
  });

  test("orders the merged result by sentAt ascending, tie-broken by path", () => {
    const merged = mergeSentFiles(
      [entry("/z.png", 5), entry("/a.png", 5)],
      [entry("/m.png", 1)],
    );
    expect(merged.map((e) => e.path)).toEqual(["/m.png", "/a.png", "/z.png"]);
  });

  test("distinct paths accumulate rather than collide", () => {
    const merged = mergeSentFiles([entry("/a.png", 1)], [entry("/b.png", 2)]);
    expect(merged.map((e) => e.path)).toEqual(["/a.png", "/b.png"]);
  });

  test("caps the result to the most recent MAX_SENT_FILES entries", () => {
    const existing = Array.from({ length: MAX_SENT_FILES }, (_, i) => entry(`/f${i}.txt`, i));
    const merged = mergeSentFiles(existing, [entry("/new.txt", MAX_SENT_FILES)]);
    expect(merged.length).toBe(MAX_SENT_FILES);
    // The oldest entry (sentAt 0) fell off; the newest survives at the end.
    expect(merged.some((e) => e.path === "/f0.txt")).toBe(false);
    expect(merged[merged.length - 1]).toEqual(entry("/new.txt", MAX_SENT_FILES));
  });
});

describe("sentFileBasename", () => {
  test("returns the last path segment", () => {
    expect(sentFileBasename("/abs/dir/file.png")).toBe("file.png");
  });

  test("strips a single trailing slash before taking the segment", () => {
    expect(sentFileBasename("/abs/dir/")).toBe("dir");
  });

  test("strips multiple trailing slashes", () => {
    expect(sentFileBasename("/abs/dir///")).toBe("dir");
  });

  test("returns the input unchanged when there is no slash at all", () => {
    expect(sentFileBasename("file.png")).toBe("file.png");
  });
});

describe("formatByteSize", () => {
  test("renders whole bytes below 1 KB", () => {
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(1023)).toBe("1023 B");
  });

  test("renders one decimal place from KB up", () => {
    expect(formatByteSize(1228)).toBe("1.2 KB");
    expect(formatByteSize(3_565_158)).toBe("3.4 MB");
    expect(formatByteSize(1024 ** 3)).toBe("1.0 GB");
  });

  test("rolls over to the next unit at the 1024 boundary", () => {
    expect(formatByteSize(1024)).toBe("1.0 KB");
    expect(formatByteSize(1024 ** 2)).toBe("1.0 MB");
  });

  test("clamps negative/non-finite input rather than throwing", () => {
    expect(formatByteSize(-5)).toBe("0 B");
    expect(formatByteSize(NaN)).toBe("0 B");
  });
});

describe("sentFilesSummaryLine", () => {
  const req = { files: ["/abs/a.png", "/abs/b.md"], caption: null, status: null, display: null };

  test("pending (no tool_result yet)", () => {
    expect(sentFilesSummaryLine(req, null)).toBe("sending 2 files: a.png, b.md");
  });

  test("singular pending form", () => {
    const single = { files: ["/abs/a.png"], caption: null, status: null, display: null };
    expect(sentFilesSummaryLine(single, null)).toBe("sending 1 file: a.png");
  });

  test("delivered, with sizes from matching attachments", () => {
    const result = {
      delivered: true,
      deliveredCount: 2,
      error: null,
      attachments: [
        { path: "/abs/a.png", size: 238784, isImage: true, mediaType: "image/png" },
      ],
    };
    expect(sentFilesSummaryLine(req, result)).toBe("sent 2 files: a.png (233.2 KB), b.md");
  });

  test("delivered singular form", () => {
    const single = { files: ["/abs/a.png"], caption: null, status: null, display: null };
    const result = { delivered: true, deliveredCount: 1, error: null, attachments: [] };
    expect(sentFilesSummaryLine(single, result)).toBe("sent 1 file: a.png");
  });

  test("error form includes the basenames and the error text", () => {
    const result = { delivered: false, deliveredCount: null, error: "not a regular file", attachments: [] };
    expect(sentFilesSummaryLine(req, result)).toBe("send failed (a.png, b.md): not a regular file");
  });
});
