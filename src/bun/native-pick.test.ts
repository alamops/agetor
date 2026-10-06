import { describe, expect, test } from "bun:test";
import { pickedPaths, singlePickedPath } from "./native-pick.ts";

/** Electrobun returns the panel's answer split on ",". */
const split = (...paths: string[]) => paths.join(",").split(",");

describe("singlePickedPath", () => {
  test("re-joins a comma-split pick and never trims it", () => {
    expect(singlePickedPath(split("/x/Backups, 2026"))).toBe("/x/Backups, 2026");
    expect(singlePickedPath(["/x/Exports "])).toBe("/x/Exports ");
  });

  test("a cancelled panel or a relative answer isn't a pick", () => {
    expect(singlePickedPath([])).toBeNull();
    expect(singlePickedPath([""])).toBeNull();
    expect(singlePickedPath(["relative/folder"])).toBeNull();
  });
});

describe("pickedPaths", () => {
  test("splits several picks and re-joins a path containing a comma", () => {
    const onDisk = new Set(["/a", "/b", "/a/one.txt", "/a/Foo, Bar.txt", "/b/two"]);
    expect(pickedPaths(split("/a/one.txt", "/a/Foo, Bar.txt", "/b/two"), (p) => onDisk.has(p))).toEqual([
      "/a/one.txt",
      "/a/Foo, Bar.txt",
      "/b/two",
    ]);
  });

  test("a name containing ',/' is re-joined only when the joined path exists", () => {
    const onDisk = new Set(["/a/x,/y"]);
    expect(pickedPaths(split("/a/x,/y"), (p) => onDisk.has(p))).toEqual(["/a/x,/y"]);
    // A sibling named like the first half doesn't split it: the second half
    // alone doesn't exist.
    const besideSibling = new Set(["/a/x", "/a/x,/y"]);
    expect(pickedPaths(split("/a/x,/y"), (p) => besideSibling.has(p))).toEqual(["/a/x,/y"]);
    // Both halves exist on their own, side by side in one folder: two picks.
    expect(pickedPaths(split("/a/x", "/a/y"), () => true)).toEqual(["/a/x", "/a/y"]);
    expect(pickedPaths(split("/a/x", "/a/sub/y"), () => true)).toEqual(["/a/x", "/a/sub/y"]);
  });

  test("an ambiguous tail outside the head's folder is re-joined", () => {
    // `/Library` exists on every Mac; a folder "Backups," holding a
    // "Library" beside a sibling "Backups" is one pick, not two from
    // different listings.
    const onDisk = new Set(["/d", "/d/Backups", "/d/Backups,", "/d/Backups,/Library", "/Library"]);
    expect(pickedPaths(split("/d/Backups,/Library"), (p) => onDisk.has(p))).toEqual(["/d/Backups,/Library"]);
    // Two root-level picks stay two.
    expect(pickedPaths(split("/Library", "/Users"), () => true)).toEqual(["/Library", "/Users"]);
  });

  test("a path through several folders whose names end in ',' is re-joined whole", () => {
    const onDisk = new Set([
      "/d",
      "/d/Backups,",
      "/d/Backups,/2026,",
      "/d/Backups,/2026,/f.json",
      "/d/Backups,/2026,/Foo, Bar.json",
      "/d/other.json",
    ]);
    const has = (p: string) => onDisk.has(p);
    expect(pickedPaths(split("/d/Backups,/2026,/f.json"), has)).toEqual(["/d/Backups,/2026,/f.json"]);
    expect(
      pickedPaths(split("/d/Backups,/2026,/f.json", "/d/Backups,/2026,/Foo, Bar.json", "/d/other.json"), has),
    ).toEqual(["/d/Backups,/2026,/f.json", "/d/Backups,/2026,/Foo, Bar.json", "/d/other.json"]);
    // A picked folder whose own name ends in ",": the trailing empty piece.
    expect(pickedPaths(split("/d/Backups,/2026,"), has)).toEqual(["/d/Backups,/2026,"]);
  });

  test("separate picks don't scan every later piece", () => {
    const files = Array.from({ length: 200 }, (_, n) => `/a/f${n}.txt`);
    let calls = 0;
    const onDisk = new Set(["/a", ...files]);
    const result = pickedPaths(split(...files), (p) => {
      calls++;
      return onDisk.has(p);
    });
    expect(result).toEqual(files);
    expect(calls).toBeLessThan(files.length * 4);
  });

  test("a cancelled panel is no picks; a stray relative answer is dropped", () => {
    expect(pickedPaths([])).toEqual([]);
    expect(pickedPaths([""])).toEqual([]);
    expect(pickedPaths(["relative"], () => true)).toEqual([]);
  });
});
