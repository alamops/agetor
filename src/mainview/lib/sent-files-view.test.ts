import { describe, expect, test } from "bun:test";
import { buildSentFileTiles, sentFilesStatus, type PathStats } from "./sent-files-view.ts";
import type { SentFilesRequest, SentFilesResult } from "../../shared/sent-files.ts";

function req(files: string[], overrides: Partial<SentFilesRequest> = {}): SentFilesRequest {
  return { files, caption: null, status: null, display: null, ...overrides };
}

function result(overrides: Partial<SentFilesResult> = {}): SentFilesResult {
  return { delivered: true, deliveredCount: null, error: null, attachments: [], ...overrides };
}

describe("buildSentFileTiles", () => {
  test("image kind: from isImagePath when no attachment/stat says otherwise", () => {
    const tiles = buildSentFileTiles(req(["/tmp/chart.png"]), null, null);
    expect(tiles).toEqual([
      { path: "/tmp/chart.png", name: "chart.png", kind: "image", exists: null, size: null, mediaType: null },
    ]);
  });

  test("image kind: attachment isImage:true overrides a non-image extension", () => {
    const r = result({ attachments: [{ path: "/tmp/blob", size: null, isImage: true, mediaType: null }] });
    const tiles = buildSentFileTiles(req(["/tmp/blob"]), r, null);
    expect(tiles[0]?.kind).toBe("image");
  });

  test("image kind: mediaType starting with image/ overrides a non-image extension", () => {
    const r = result({
      attachments: [{ path: "/tmp/blob", size: null, isImage: null, mediaType: "image/webp" }],
    });
    const tiles = buildSentFileTiles(req(["/tmp/blob"]), r, null);
    expect(tiles[0]?.kind).toBe("image");
  });

  test("file kind: plain non-image path with no attachment/stat evidence", () => {
    const tiles = buildSentFileTiles(req(["/tmp/report.md"]), null, null);
    expect(tiles[0]?.kind).toBe("file");
  });

  test("file kind: attachment explicitly says isImage:false, extension doesn't look like an image", () => {
    const r = result({
      attachments: [{ path: "/tmp/report.md", size: 10, isImage: false, mediaType: "text/markdown" }],
    });
    const tiles = buildSentFileTiles(req(["/tmp/report.md"]), r, null);
    expect(tiles[0]?.kind).toBe("file");
  });

  test("folder kind: stat says isDirectory", () => {
    const stats: PathStats = new Map([["/tmp/agetor-sent", { isDirectory: true }]]);
    const tiles = buildSentFileTiles(req(["/tmp/agetor-sent"]), null, stats);
    expect(tiles[0]?.kind).toBe("folder");
  });

  test("folder beats image: a directory stat wins even when the path looks like an image / attachment says isImage", () => {
    const r = result({
      attachments: [{ path: "/tmp/pictures.png", size: null, isImage: true, mediaType: "image/png" }],
    });
    const stats: PathStats = new Map([["/tmp/pictures.png", { isDirectory: true }]]);
    const tiles = buildSentFileTiles(req(["/tmp/pictures.png"]), r, stats);
    expect(tiles[0]?.kind).toBe("folder");
  });

  test("exists: null while stats is null (pending)", () => {
    const tiles = buildSentFileTiles(req(["/tmp/a.png"]), null, null);
    expect(tiles[0]?.exists).toBeNull();
  });

  test("exists: null for a relative path even once stats has answered", () => {
    const stats: PathStats = new Map([["a.png", { isDirectory: false }]]);
    const tiles = buildSentFileTiles(req(["a.png"]), null, stats);
    expect(tiles[0]?.exists).toBeNull();
  });

  test("exists: true when stats has the absolute path", () => {
    const stats: PathStats = new Map([["/tmp/a.png", { isDirectory: false }]]);
    const tiles = buildSentFileTiles(req(["/tmp/a.png"]), null, stats);
    expect(tiles[0]?.exists).toBe(true);
  });

  test("exists: false when stats answered but doesn't have the path", () => {
    const stats: PathStats = new Map();
    const tiles = buildSentFileTiles(req(["/tmp/gone.png"]), null, stats);
    expect(tiles[0]?.exists).toBe(false);
  });

  test("dedupes by exact path, keeping order and the first occurrence", () => {
    const tiles = buildSentFileTiles(req(["/tmp/a.png", "/tmp/b.md", "/tmp/a.png"]), null, null);
    expect(tiles.map((t) => t.path)).toEqual(["/tmp/a.png", "/tmp/b.md"]);
  });

  test("size lookup: matched attachment by exact path", () => {
    const r = result({
      attachments: [
        { path: "/tmp/a.png", size: 1234, isImage: true, mediaType: "image/png" },
        { path: "/tmp/b.md", size: null, isImage: false, mediaType: "text/markdown" },
      ],
    });
    const tiles = buildSentFileTiles(req(["/tmp/a.png", "/tmp/b.md", "/tmp/c.txt"]), r, null);
    expect(tiles[0]?.size).toBe(1234);
    expect(tiles[0]?.mediaType).toBe("image/png");
    expect(tiles[1]?.size).toBeNull();
    expect(tiles[2]?.size).toBeNull();
  });

  test("name is the basename, trailing slash stripped for a directory ref", () => {
    const tiles = buildSentFileTiles(req(["/tmp/agetor-sent/"]), null, null);
    expect(tiles[0]?.name).toBe("agetor-sent");
  });
});

describe("sentFilesStatus", () => {
  test("pending: no result yet, plural", () => {
    expect(sentFilesStatus(req(["/tmp/a.png", "/tmp/b.md"]), null)).toEqual({
      tone: "pending",
      text: "Sending 2 files…",
    });
  });

  test("pending: no result yet, singular", () => {
    expect(sentFilesStatus(req(["/tmp/a.png"]), null)).toEqual({
      tone: "pending",
      text: "Sending 1 file…",
    });
  });

  test("error: surfaces the tool's error text verbatim", () => {
    const r = result({ delivered: false, error: "Attachment is not a regular file." });
    expect(sentFilesStatus(req(["/tmp/dir"]), r)).toEqual({
      tone: "error",
      text: "Attachment is not a regular file.",
    });
  });

  test("success: deliveredCount known, plural", () => {
    const r = result({ deliveredCount: 2 });
    expect(sentFilesStatus(req(["/tmp/a.png", "/tmp/b.md"]), r)).toEqual({
      tone: "success",
      text: "2 files delivered",
    });
  });

  test("success: deliveredCount known, singular", () => {
    const r = result({ deliveredCount: 1 });
    expect(sentFilesStatus(req(["/tmp/a.png"]), r)).toEqual({
      tone: "success",
      text: "1 file delivered",
    });
  });

  test("success: deliveredCount unknown falls back to files.length", () => {
    const r = result({ deliveredCount: null });
    expect(sentFilesStatus(req(["/tmp/a.png", "/tmp/b.md", "/tmp/c.txt"]), r)).toEqual({
      tone: "success",
      text: "3 files delivered",
    });
  });
});
