import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, linkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parsePaxRecords, parseTar } from "./tar-read.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

const scratch = mkdtempSync(path.join(tmpdir(), "tar-read-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ---- hand-built archives -----------------------------------------------

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

/** One ustar header block. */
function header(opts: {
  name: string;
  size?: number;
  type?: string;
  prefix?: string;
  linkname?: string;
  magic?: string;
}): Uint8Array {
  const b = new Uint8Array(512);
  const put = (s: string, off: number, max: number) => {
    const bytes = enc.encode(s);
    b.set(bytes.subarray(0, max), off);
  };
  put(opts.name, 0, 100);
  put("0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(octal(opts.size ?? 0, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  put("        ", 148, 8); // checksum placeholder
  put(opts.type ?? "0", 156, 1);
  put(opts.linkname ?? "", 157, 100);
  put(opts.magic ?? "ustar\0", 257, 6);
  put("00", 263, 2);
  put(opts.prefix ?? "", 345, 155);
  let sum = 0;
  for (const v of b) sum += v;
  put(octal(sum, 7) .slice(0, 6) + "\0 ", 148, 8);
  return b;
}

function padTo512(data: Uint8Array): Uint8Array {
  const len = Math.ceil(data.length / 512) * 512;
  const out = new Uint8Array(len);
  out.set(data);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function fileEntry(name: string, content: string, extra?: Parameters<typeof header>[0]): Uint8Array {
  const data = enc.encode(content);
  return concat(header({ name, size: data.length, ...extra }), padTo512(data));
}

function paxRecords(rec: Record<string, string>): Uint8Array {
  let out = "";
  for (const [k, v] of Object.entries(rec)) {
    const body = ` ${k}=${v}\n`;
    // The length prefix counts its own digits: iterate to a fixpoint.
    const bodyBytes = enc.encode(body).length;
    let len = bodyBytes + 1;
    while (String(len).length + bodyBytes !== len) len = String(len).length + bodyBytes;
    out += `${len}${body}`;
  }
  return enc.encode(out);
}

function paxEntry(type: "x" | "g", rec: Record<string, string>): Uint8Array {
  const data = paxRecords(rec);
  return concat(header({ name: "PaxHeader/x", type, size: data.length }), padTo512(data));
}

const END = new Uint8Array(1024);

describe("parseTar (hand-built ustar)", () => {
  test("reads regular files, skips directories and symlinks", () => {
    const tar = concat(
      header({ name: "dir/", type: "5" }),
      fileEntry("dir/a.txt", "alpha"),
      header({ name: "dir/link", type: "2", linkname: "a.txt" }),
      fileEntry("dir/b.txt", "bravo\n"),
      END,
    );
    const got = parseTar(tar);
    expect(got.map((e) => e.path)).toEqual(["dir/a.txt", "dir/b.txt"]);
    expect(dec.decode(got[0]!.data)).toBe("alpha");
    expect(dec.decode(got[1]!.data)).toBe("bravo\n");
  });

  test("accepts the legacy NUL typeflag and strips ./ and trailing slashes", () => {
    const tar = concat(fileEntry("./x/y.md", "hi", { name: "./x/y.md", type: "\0" }), END);
    expect(parseTar(tar).map((e) => e.path)).toEqual(["x/y.md"]);
  });

  test("joins the ustar prefix and name", () => {
    const tar = concat(fileEntry("leaf.md", "p", { name: "leaf.md", prefix: "a/very/long/prefix/dir" }), END);
    expect(parseTar(tar)[0]!.path).toBe("a/very/long/prefix/dir/leaf.md");
  });

  test("ignores the prefix field of a non-ustar header", () => {
    const tar = concat(fileEntry("leaf.md", "p", { name: "leaf.md", prefix: "ignored", magic: "\0\0\0\0\0\0" }), END);
    expect(parseTar(tar)[0]!.path).toBe("leaf.md");
  });

  test("decodes UTF-8 names", () => {
    const tar = concat(fileEntry("skills/café-日本.md", "x"), END);
    expect(parseTar(tar)[0]!.path).toBe("skills/café-日本.md");
  });

  test("empty files and an empty archive", () => {
    expect(parseTar(new Uint8Array(0))).toEqual([]);
    expect(parseTar(END)).toEqual([]);
    const got = parseTar(concat(fileEntry("e.txt", ""), END));
    expect(got).toHaveLength(1);
    expect(got[0]!.data.length).toBe(0);
  });

  test("a missing end-of-archive marker is fine", () => {
    expect(parseTar(fileEntry("a", "1")).map((e) => e.path)).toEqual(["a"]);
  });
});

describe("parseTar (pax headers)", () => {
  test("per-file x header overrides path and applies to one entry only", () => {
    const longPath = `${"d".repeat(120)}/${"n".repeat(60)}.md`;
    const tar = concat(
      paxEntry("x", { path: longPath }),
      fileEntry("short", "one"),
      fileEntry("second", "two"),
      END,
    );
    const got = parseTar(tar);
    expect(got.map((e) => e.path)).toEqual([longPath, "second"]);
  });

  test("global g header supplies a default that an x header overrides", () => {
    const tar = concat(
      paxEntry("g", { comment: "ignored", path: "global/name.md" }),
      fileEntry("a", "1"),
      paxEntry("x", { path: "local/name.md" }),
      fileEntry("b", "2"),
      END,
    );
    expect(parseTar(tar).map((e) => e.path)).toEqual(["global/name.md", "local/name.md"]);
  });

  test("pax size overrides the header size", () => {
    const body = "x".repeat(700);
    const data = enc.encode(body);
    // Header says 0 bytes, pax says 700: the data blocks follow regardless.
    const tar = concat(
      paxEntry("x", { size: String(data.length) }),
      header({ name: "big.txt", size: 0 }),
      padTo512(data),
      fileEntry("after.txt", "ok"),
      END,
    );
    const got = parseTar(tar);
    expect(got.map((e) => e.path)).toEqual(["big.txt", "after.txt"]);
    expect(got[0]!.data.length).toBe(700);
  });

  test("record length prefix counts bytes, not characters", () => {
    const recs = parsePaxRecords(paxRecords({ path: "日本語/ファイル.md", linkpath: "ü" }));
    expect(recs.get("path")).toBe("日本語/ファイル.md");
    expect(recs.get("linkpath")).toBe("ü");
  });

  test("a malformed pax record stops that record list, not the parse", () => {
    expect(parsePaxRecords(enc.encode("garbage")).size).toBe(0);
    expect(parsePaxRecords(enc.encode("99 path=short\n")).size).toBe(0);
  });

  test("hard links resolve to an earlier file's bytes; unresolved ones are dropped", () => {
    const tar = concat(
      fileEntry("a/orig.md", "shared"),
      header({ name: "b/link.md", type: "1", linkname: "a/orig.md" }),
      header({ name: "c/dangling.md", type: "1", linkname: "nowhere.md" }),
      END,
    );
    const got = parseTar(tar);
    expect(got.map((e) => e.path)).toEqual(["a/orig.md", "b/link.md"]);
    expect(dec.decode(got[1]!.data)).toBe("shared");
  });

  test("a pax linkpath is honored for hard links", () => {
    const tar = concat(
      fileEntry("a.md", "A"),
      paxEntry("x", { linkpath: "a.md" }),
      header({ name: "b.md", type: "1", linkname: "truncated-in-header" }),
      END,
    );
    expect(parseTar(tar).map((e) => dec.decode(e.data))).toEqual(["A", "A"]);
  });
});

describe("parseTar (truncation and damage)", () => {
  const full = concat(fileEntry("one.md", "1".repeat(900)), fileEntry("two.md", "2".repeat(900)), END);

  test("a truncated final entry is dropped, earlier ones kept", () => {
    // one.md: header 0..512, data 512..1412 (padded to 1536). two.md: header
    // 1536..2048, data 2048..2948. Every cut inside two.md leaves only one.md.
    for (const cut of [1536 + 100, 1536 + 512, 2048 + 10, 2947]) {
      expect(parseTar(full.subarray(0, cut)).map((e) => e.path)).toEqual(["one.md"]);
    }
    // A cut inside one.md's data leaves nothing.
    expect(parseTar(full.subarray(0, 1000))).toEqual([]);
    expect(parseTar(full.subarray(0, 2948)).map((e) => e.path)).toEqual(["one.md", "two.md"]);
  });

  test("every prefix of an archive parses without throwing", () => {
    for (let n = 0; n <= full.length; n += 97) {
      expect(() => parseTar(full.subarray(0, n))).not.toThrow();
    }
  });

  test("a header with a bad checksum ends the parse", () => {
    const bad = fileEntry("one.md", "x");
    bad[0] = bad[0]! ^ 0xff;
    expect(parseTar(concat(bad, fileEntry("two.md", "y"), END))).toEqual([]);
  });

  test("random garbage yields nothing", () => {
    const junk = new Uint8Array(2048);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 31 + 7) & 0xff;
    expect(parseTar(junk)).toEqual([]);
  });

  test("returned data does not alias the input buffer", () => {
    const tar = concat(fileEntry("a", "keep"), END);
    const got = parseTar(tar);
    tar.fill(0);
    expect(dec.decode(got[0]!.data)).toBe("keep");
  });
});

describe("parseTar (archives written by /usr/bin/tar --format=pax)", () => {
  function makeArchive(root: string, args: string[]): Uint8Array {
    const res = Bun.spawnSync(["/usr/bin/tar", "-c", "-f", "-", "--format=pax", ...args], {
      env: { ...process.env, COPYFILE_DISABLE: "1", LC_ALL: "C" },
    });
    expect(res.exitCode).toBe(0);
    return new Uint8Array(res.stdout);
  }

  test("round-trips files incl. long and non-ASCII paths, skips dirs, resolves hard links", () => {
    const root = path.join(scratch, "real");
    const longDir = path.join("deep", "x".repeat(90), "y".repeat(90));
    mkdirSync(path.join(root, longDir), { recursive: true });
    mkdirSync(path.join(root, "emptydir"));
    writeFileSync(path.join(root, longDir, "SKILL.md"), "---\nname: long\n---\n");
    writeFileSync(path.join(root, "naïve 日本.md"), "unicode");
    writeFileSync(path.join(root, "orig.md"), "hard");
    linkSync(path.join(root, "orig.md"), path.join(root, "alias.md"));
    symlinkSync("orig.md", path.join(root, "sym.md"));

    const bytes = makeArchive(root, ["-C", root, "--", "."]);
    const got = new Map(parseTar(bytes).map((e) => [e.path, dec.decode(e.data)] as const));
    expect(got.get(`${longDir}/SKILL.md`)).toBe("---\nname: long\n---\n");
    expect(got.get("naïve 日本.md")).toBe("unicode");
    expect(got.get("orig.md")).toBe("hard");
    expect(got.get("alias.md")).toBe("hard"); // hard link, resolved
    expect(got.has("sym.md")).toBe(false); // symlink, not followed without -L
    expect([...got.keys()].some((k) => k.startsWith("emptydir"))).toBe(false);
    expect([...got.keys()].some((k) => k.includes("._"))).toBe(false);
  });

  test("-L follows symlinks into regular files", () => {
    const root = path.join(scratch, "follow");
    mkdirSync(path.join(root, "real"), { recursive: true });
    writeFileSync(path.join(root, "real", "f.md"), "via link");
    symlinkSync("real", path.join(root, "linkdir"));
    const bytes = makeArchive(root, ["-L", "-C", root, "--", "linkdir"]);
    const got = new Map(parseTar(bytes).map((e) => [e.path, dec.decode(e.data)] as const));
    expect(got.get("linkdir/f.md")).toBe("via link");
  });

  test("a real archive cut at every 1 KiB still parses prefix-wise", () => {
    const root = path.join(scratch, "cut");
    mkdirSync(root, { recursive: true });
    for (let i = 0; i < 6; i++) writeFileSync(path.join(root, `f${i}.txt`), `${i}`.repeat(1500));
    const bytes = makeArchive(root, ["-C", root, "--", "."]);
    const full = parseTar(bytes);
    expect(full).toHaveLength(6);
    for (let n = 0; n < bytes.length; n += 1024) {
      const part = parseTar(bytes.subarray(0, n));
      expect(part.length).toBeLessThanOrEqual(6);
      for (const e of part) expect(full.find((f) => f.path === e.path)?.data).toEqual(e.data);
    }
  });
});
