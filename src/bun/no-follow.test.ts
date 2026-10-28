import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { disclaimEnabled } from "./disclaim.ts";
import {
  isPlainDirBelow,
  openReadNoFollow,
  readAccountFileText,
  readTextNoFollow,
  readTextNonBlocking,
} from "./no-follow.ts";
import { withDisclaimOn } from "./test-disclaim-on.ts";

const dir = mkdtempSync(path.join(tmpdir(), "agetor-no-follow-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a regular file reads normally; a symlink at the final component is refused with ELOOP", () => {
  const real = path.join(dir, "real.txt");
  writeFileSync(real, "hello\n");
  const link = path.join(dir, "link.txt");
  symlinkSync(real, link);

  expect(readTextNoFollow(real)).toBe("hello\n");
  const fd = openReadNoFollow(real);
  expect(readFileSync(fd, "utf8")).toBe("hello\n");
  closeSync(fd);

  expect(() => readTextNoFollow(link)).toThrow(expect.objectContaining({ code: "ELOOP" }));
  expect(() => openReadNoFollow(link)).toThrow(expect.objectContaining({ code: "ELOOP" }));
});

test("a symlinked parent directory is still followed (only the final component is checked)", () => {
  const sub = path.join(dir, "sub");
  mkdirSync(sub);
  writeFileSync(path.join(sub, "f.txt"), "x");
  symlinkSync(sub, path.join(dir, "sublink"));
  expect(readTextNoFollow(path.join(dir, "sublink", "f.txt"))).toBe("x");
});

test("a missing file throws ENOENT like readFileSync", () => {
  expect(() => readTextNoFollow(path.join(dir, "missing"))).toThrow(expect.objectContaining({ code: "ENOENT" }));
});

test.skipIf(process.platform === "win32")("a named pipe is refused at once instead of blocking the thread", () => {
  const fifo = path.join(dir, "fifo.jsonl");
  expect(spawnSync("/usr/bin/mkfifo", [fifo]).status).toBe(0);
  const started = Date.now();
  // No writer ever opens the pipe: a blocking open/read would hang this test.
  expect(() => readTextNoFollow(fifo)).toThrow(expect.objectContaining({ code: "EINVAL" }));
  expect(() => openReadNoFollow(fifo)).toThrow(expect.objectContaining({ code: "EINVAL" }));
  expect(Date.now() - started).toBeLessThan(1_000);
});

test("a file over maxBytes is refused with EFBIG; within it reads normally", () => {
  const f = path.join(dir, "sized.txt");
  writeFileSync(f, "x".repeat(100));
  expect(readTextNoFollow(f, { maxBytes: 100 })).toHaveLength(100);
  expect(() => readTextNoFollow(f, { maxBytes: 99 })).toThrow(expect.objectContaining({ code: "EFBIG" }));
});

// readTextNonBlocking: the switch-off reader for agent-writable files. Only
// the hang matters there (Agetor's identity isn't at stake), so a symlink is
// followed, but a FIFO or a directory is refused at once.
describe("readTextNonBlocking", () => {
  test("reads a regular file, and follows a symlink at the final component", () => {
    const real = path.join(dir, "nb-real.txt");
    writeFileSync(real, "héllo\n");
    const link = path.join(dir, "nb-link.txt");
    symlinkSync(real, link);
    expect(readTextNonBlocking(real)).toBe("héllo\n");
    expect(readTextNonBlocking(link)).toBe("héllo\n");
  });

  test.skipIf(process.platform === "win32")("a named pipe, or a symlink to one, is refused at once", () => {
    const fifo = path.join(dir, "nb-fifo.json");
    expect(spawnSync("/usr/bin/mkfifo", [fifo]).status).toBe(0);
    const link = path.join(dir, "nb-fifo-link.json");
    symlinkSync(fifo, link);
    const started = Date.now();
    // No writer ever opens the pipe: a blocking open would hang this test.
    expect(() => readTextNonBlocking(fifo)).toThrow(expect.objectContaining({ code: "EINVAL" }));
    expect(() => readTextNonBlocking(link)).toThrow(expect.objectContaining({ code: "EINVAL" }));
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("a directory is refused with EINVAL; a missing file throws ENOENT", () => {
    const sub = path.join(dir, "nb-dir");
    mkdirSync(sub);
    expect(() => readTextNonBlocking(sub)).toThrow(expect.objectContaining({ code: "EINVAL" }));
    expect(() => readTextNonBlocking(path.join(dir, "nb-missing"))).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  test("maxBytes: at the limit reads, one byte over is EFBIG", () => {
    const f = path.join(dir, "nb-sized.txt");
    writeFileSync(f, "y".repeat(64));
    expect(readTextNonBlocking(f, { maxBytes: 64 })).toHaveLength(64);
    expect(() => readTextNonBlocking(f, { maxBytes: 63 })).toThrow(expect.objectContaining({ code: "EFBIG" }));
  });
});

test("isPlainDirBelow: real directories pass; a symlinked, missing or file component fails", () => {
  const base = path.join(dir, "base");
  mkdirSync(path.join(base, "a", "b"), { recursive: true });
  writeFileSync(path.join(base, "file"), "");
  const elsewhere = path.join(dir, "elsewhere");
  mkdirSync(path.join(elsewhere, "b"), { recursive: true });
  symlinkSync(elsewhere, path.join(base, "linked"));

  expect(isPlainDirBelow(base, base)).toBe(true);
  expect(isPlainDirBelow(base, path.join(base, "a", "b"))).toBe(true);
  expect(isPlainDirBelow(base, path.join(base, "linked"))).toBe(false);
  // A real leaf below a symlinked component is refused too.
  expect(isPlainDirBelow(base, path.join(base, "linked", "b"))).toBe(false);
  expect(isPlainDirBelow(base, path.join(base, "missing"))).toBe(false);
  expect(isPlainDirBelow(base, path.join(base, "file"))).toBe(false);
  // Outside the base is never "below" it; a name starting with `..` is inside.
  expect(isPlainDirBelow(path.join(base, "a"), base)).toBe(false);
  mkdirSync(path.join(base, "..dots"));
  expect(isPlainDirBelow(base, path.join(base, "..dots"))).toBe(true);
  // The base itself is trusted even when it is a symlink.
  expect(isPlainDirBelow(path.join(base, "linked"), path.join(base, "linked", "b"))).toBe(true);
});

describe("readAccountFileText", () => {
  const acct = path.join(dir, "acct");
  mkdirSync(acct);
  const real = path.join(acct, "real.json");
  writeFileSync(real, '{"a":1}');
  const link = path.join(acct, "link.json");
  symlinkSync(real, link);

  test("with the switch off a user's own symlinked dotfile still reads", () => {
    expect(disclaimEnabled()).toBe(false);
    expect(readAccountFileText(real, 1024)).toBe('{"a":1}');
    expect(readAccountFileText(link, 1024)).toBe('{"a":1}');
  });

  test.skipIf(process.platform !== "darwin")("while disclaiming a symlinked file is refused with ELOOP", async () => {
    await withDisclaimOn(() => {
      expect(disclaimEnabled()).toBe(true);
      expect(readAccountFileText(real, 1024)).toBe('{"a":1}');
      expect(() => readAccountFileText(link, 1024)).toThrow(expect.objectContaining({ code: "ELOOP" }));
    });
  });

  test("a named pipe is refused at once in both modes; a file over maxBytes is refused", async () => {
    const fifo = path.join(acct, "fifo.json");
    expect(spawnSync("/usr/bin/mkfifo", [fifo]).status).toBe(0);
    const started = Date.now();
    expect(() => readAccountFileText(fifo, 1024)).toThrow(expect.objectContaining({ code: "EINVAL" }));
    await withDisclaimOn(() => {
      expect(() => readAccountFileText(fifo, 1024)).toThrow(expect.objectContaining({ code: "EINVAL" }));
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(() => readAccountFileText(real, 3)).toThrow(expect.objectContaining({ code: "EFBIG" }));
  });
});
