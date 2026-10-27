import { afterAll, expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openReadNoFollow, readTextNoFollow } from "./no-follow.ts";

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
