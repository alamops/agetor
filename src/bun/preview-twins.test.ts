// Unit tests for the preview-twin module (docs/plans/picked-image-preview-tcc.md,
// U2). It takes `dataDir` as an argument, so these never import db.ts.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  __forTest,
  PREVIEW_TWIN_CACHE_MAX_BYTES,
  PREVIEW_TWIN_DIR,
  PREVIEW_TWIN_MAX_BYTES,
  previewTwinPath,
  requestPreviewTwinSweep,
  sweepPreviewTwins,
  writePreviewTwin,
  writePreviewTwinsForRefs,
} from "./preview-twins.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const ROOT = mkdtempSync(path.join(tmpdir(), "agetor-preview-twins-"));
afterAll(() => {
  rmTestDataDir(ROOT);
});

let n = 0;
/** A fresh data dir + a fresh source dir per test. */
function fixture() {
  const base = path.join(ROOT, `t${++n}`);
  const dataDir = path.join(base, "data");
  const src = path.join(base, "src");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(src, { recursive: true });
  return { dataDir, src, previews: path.join(dataDir, PREVIEW_TWIN_DIR) };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

beforeEach(() => __forTest.reset());
afterEach(async () => {
  await __forTest.idle();
});

describe("previewTwinPath", () => {
  test("is deterministic and keeps the lowercased extension", () => {
    const a = previewTwinPath("/d", "/Users/me/Desktop/Shot.PNG");
    expect(a).toBe(previewTwinPath("/d", "/Users/me/Desktop/Shot.PNG"));
    expect(a).toMatch(/^\/d\/previews\/[0-9a-f]{64}\.png$/);
  });

  test("U+202F and a plain space give different twins (nothing is normalized)", () => {
    const withNarrow = previewTwinPath("/d", "/x/Screenshot 2.40.41 PM.png");
    const withSpace = previewTwinPath("/d", "/x/Screenshot 2.40.41 PM.png");
    expect(withNarrow).not.toBeNull();
    expect(withNarrow).not.toBe(withSpace);
  });

  test("is null for non-images, directories and extensionless paths", () => {
    expect(previewTwinPath("/d", "/x/note.txt")).toBeNull();
    expect(previewTwinPath("/d", "/x/folder.png/")).toBeNull();
    expect(previewTwinPath("/d", "/x/noext")).toBeNull();
  });
});

describe("writePreviewTwin", () => {
  test("copies the bytes exactly with mode 0600 and leaves no temp file", async () => {
    const { dataDir, src, previews } = fixture();
    const orig = path.join(src, "shot.png");
    writeFileSync(orig, PNG);
    const r = await writePreviewTwin(dataDir, orig);
    expect(r.kind).toBe("written");
    if (r.kind !== "written") return;
    expect(r.twinPath).toBe(previewTwinPath(dataDir, orig)!);
    expect(r.bytes).toBe(PNG.length);
    expect(readFileSync(r.twinPath).equals(PNG)).toBe(true);
    expect(statSync(r.twinPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(previews).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("a re-write refreshes the mtime", async () => {
    const { dataDir, src } = fixture();
    const orig = path.join(src, "shot.png");
    writeFileSync(orig, PNG);
    const first = await writePreviewTwin(dataDir, orig);
    if (first.kind !== "written") throw new Error("expected a twin");
    const old = new Date(Date.now() - 3600_000);
    utimesSync(first.twinPath, old, old);
    await writePreviewTwin(dataDir, orig);
    expect(statSync(first.twinPath).mtimeMs).toBeGreaterThan(old.getTime() + 1000);
  });

  test("a non-image is not-image and creates nothing", async () => {
    const { dataDir, src, previews } = fixture();
    const orig = path.join(src, "note.txt");
    writeFileSync(orig, "hi");
    expect(await writePreviewTwin(dataDir, orig)).toEqual({ kind: "skipped", reason: "not-image" });
    expect(existsSync(previews)).toBe(false);
  });

  test("a missing file is `missing`", async () => {
    const { dataDir, src } = fixture();
    expect(await writePreviewTwin(dataDir, path.join(src, "gone.png"))).toEqual({ kind: "skipped", reason: "missing" });
  });

  test("a file over the cap is `too-large` (sparse file)", async () => {
    const { dataDir, src } = fixture();
    const orig = path.join(src, "big.png");
    writeFileSync(orig, "");
    truncateSync(orig, PREVIEW_TWIN_MAX_BYTES + 1);
    expect(await writePreviewTwin(dataDir, orig)).toEqual({ kind: "skipped", reason: "too-large" });
    expect(existsSync(previewTwinPath(dataDir, orig)!)).toBe(false);
  });

  test("a symlink at the final component is `symlink`; its target is untouched", async () => {
    const { dataDir, src } = fixture();
    const target = path.join(src, "secret.png");
    writeFileSync(target, PNG);
    const link = path.join(src, "link.png");
    symlinkSync(target, link);
    expect(await writePreviewTwin(dataDir, link)).toEqual({ kind: "skipped", reason: "symlink" });
    expect(existsSync(previewTwinPath(dataDir, link)!)).toBe(false);
    expect(readFileSync(target).equals(PNG)).toBe(true);
  });

  test("a FIFO is `not-regular` and does not hang", async () => {
    const { dataDir, src } = fixture();
    const fifo = path.join(src, "pipe.png");
    expect(spawnSync("/usr/bin/mkfifo", [fifo]).status).toBe(0);
    const r = await Promise.race([
      writePreviewTwin(dataDir, fifo),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2000)),
    ]);
    expect(r).toEqual({ kind: "skipped", reason: "not-regular" });
  });

  test.skipIf(isRoot)("an unreadable file is `unreadable`", async () => {
    const { dataDir, src } = fixture();
    const orig = path.join(src, "locked.png");
    writeFileSync(orig, PNG);
    chmodSync(orig, 0o000);
    try {
      expect(await writePreviewTwin(dataDir, orig)).toEqual({ kind: "skipped", reason: "unreadable" });
    } finally {
      chmodSync(orig, 0o600);
    }
  });

  test("`previews` as a symlink to another directory is `unsafe-dir`; nothing is written there", async () => {
    const { dataDir, src, previews } = fixture();
    const elsewhere = path.join(src, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, previews);
    const orig = path.join(src, "shot.png");
    writeFileSync(orig, PNG);
    expect(await writePreviewTwin(dataDir, orig)).toEqual({ kind: "skipped", reason: "unsafe-dir" });
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test("a symlink planted at the final twin path is replaced, and its target is unchanged", async () => {
    const { dataDir, src, previews } = fixture();
    const orig = path.join(src, "shot.png");
    writeFileSync(orig, PNG);
    const twin = previewTwinPath(dataDir, orig)!;
    const victim = path.join(src, "victim.txt");
    writeFileSync(victim, "do not touch");
    mkdirSync(previews, { recursive: true });
    symlinkSync(victim, twin);
    const r = await writePreviewTwin(dataDir, orig);
    expect(r.kind).toBe("written");
    expect(readFileSync(victim, "utf8")).toBe("do not touch");
    expect(readFileSync(twin).equals(PNG)).toBe(true); // a regular file now
  });

  test("writePreviewTwinsForRefs twins images only, skips directories and the accept filter", async () => {
    const { dataDir, src } = fixture();
    const a = path.join(src, "a.png");
    const b = path.join(src, "b.heic");
    const c = path.join(src, "c.txt");
    const dir = path.join(src, "folder.png");
    for (const f of [a, b, c]) writeFileSync(f, PNG);
    mkdirSync(dir);
    await writePreviewTwinsForRefs(
      dataDir,
      [
        { path: a, isDirectory: false },
        { path: b, isDirectory: false },
        { path: c, isDirectory: false },
        { path: dir, isDirectory: true },
      ],
      (ref) => !ref.path.endsWith(".png"),
    );
    expect(existsSync(previewTwinPath(dataDir, a)!)).toBe(false); // filtered out
    expect(existsSync(previewTwinPath(dataDir, b)!)).toBe(true);
    expect(previewTwinPath(dataDir, c)).toBeNull();
    expect(previewTwinPath(dataDir, dir)).not.toBeNull(); // looks like a png by name
    expect(existsSync(previewTwinPath(dataDir, dir)!)).toBe(false); // but a directory is never twinned
  });
});

describe("sweepPreviewTwins", () => {
  function seed(previews: string, name: string, size: number, ageMs: number): string {
    mkdirSync(previews, { recursive: true });
    const file = path.join(previews, name);
    writeFileSync(file, Buffer.alloc(size, 1));
    const t = new Date(Date.now() - ageMs);
    utimesSync(file, t, t);
    return file;
  }

  test("evicts the oldest write first, down to at most the cap", async () => {
    const { dataDir, previews } = fixture();
    const oldest = seed(previews, `${"a".repeat(64)}.png`, 100, 3000);
    const middle = seed(previews, `${"b".repeat(64)}.png`, 100, 2000);
    const newest = seed(previews, `${"c".repeat(64)}.png`, 100, 1000);
    const r = await sweepPreviewTwins(dataDir, 250);
    expect(r).toEqual({ kept: 2, evicted: 1, removedOther: 0 });
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(newest)).toBe(true);
    const r2 = await sweepPreviewTwins(dataDir, 100);
    expect(r2.evicted).toBe(1);
    expect(existsSync(middle)).toBe(false);
    expect(existsSync(newest)).toBe(true);
  });

  test("under the cap nothing is evicted", async () => {
    const { dataDir, previews } = fixture();
    seed(previews, `${"a".repeat(64)}.png`, 100, 1000);
    expect(await sweepPreviewTwins(dataDir, PREVIEW_TWIN_CACHE_MAX_BYTES)).toEqual({
      kept: 1,
      evicted: 0,
      removedOther: 0,
    });
  });

  test("unlinks a planted symlink without touching its target", async () => {
    const { dataDir, src, previews } = fixture();
    const target = path.join(src, "precious.png");
    writeFileSync(target, PNG);
    mkdirSync(previews, { recursive: true });
    const link = path.join(previews, `${"d".repeat(64)}.png`);
    symlinkSync(target, link);
    const r = await sweepPreviewTwins(dataDir, PREVIEW_TWIN_CACHE_MAX_BYTES);
    expect(r.removedOther).toBe(1);
    expect(() => statSync(link)).toThrow();
    expect(readFileSync(target).equals(PNG)).toBe(true);
  });

  test("removes a stale .tmp file and keeps a fresh one", async () => {
    const { dataDir, previews } = fixture();
    const stale = seed(previews, `.${"e".repeat(64)}.1234abcd.tmp`, 10, 2 * 3600_000);
    const fresh = seed(previews, `.${"f".repeat(64)}.5678abcd.tmp`, 10, 1000);
    const r = await sweepPreviewTwins(dataDir, 0);
    expect(r.removedOther).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true); // an in-flight write is never swept
  });

  test("does nothing when `previews` is a symlink", async () => {
    const { dataDir, src, previews } = fixture();
    const elsewhere = path.join(src, "elsewhere");
    mkdirSync(elsewhere);
    const bystander = path.join(elsewhere, `${"a".repeat(64)}.png`);
    writeFileSync(bystander, PNG);
    symlinkSync(elsewhere, previews);
    expect(await sweepPreviewTwins(dataDir, 0)).toEqual({ kept: 0, evicted: 0, removedOther: 0 });
    expect(existsSync(bystander)).toBe(true);
  });

  test("a missing `previews` directory is a no-op", async () => {
    const { dataDir } = fixture();
    expect(await sweepPreviewTwins(dataDir)).toEqual({ kept: 0, evicted: 0, removedOther: 0 });
  });
});

describe("requestPreviewTwinSweep", () => {
  test("five rapid requests run at most two passes", async () => {
    const { dataDir, previews } = fixture();
    mkdirSync(previews, { recursive: true });
    for (let i = 0; i < 5; i++) requestPreviewTwinSweep(dataDir);
    await __forTest.idle();
    expect(__forTest.passes()).toBeGreaterThanOrEqual(1);
    expect(__forTest.passes()).toBeLessThanOrEqual(2);
  });

  test("a write requests a sweep, so the cache stays under the cap over time", async () => {
    const { dataDir, src } = fixture();
    const orig = path.join(src, "shot.png");
    writeFileSync(orig, PNG);
    await writePreviewTwin(dataDir, orig);
    await __forTest.idle();
    expect(__forTest.passes()).toBeGreaterThanOrEqual(1);
  });
});
