import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, readSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openReadNoFollow } from "./no-follow.ts";
import {
  META_MAX_BYTES,
  parseLine,
  readChunk,
  readChunkSync,
  readMetaFile,
  readMetaFileSync,
  splitAndParseLines,
} from "./transcript-parse.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "agetor-transcript-parse-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let seq = 0;
function fixture(content: string | Buffer): string {
  const p = path.join(root, `f${++seq}.jsonl`);
  writeFileSync(p, content);
  return p;
}

// ---------------------------------------------------------------------------
// Reference: a fixed copy of today's watcher behavior.
//   readRangeSync / readAppendedLinesSync: src/bun/claude-subagents.ts:751-818
//   per-line parse: dispatchTailedLines, src/bun/claude-subagents.ts:2730-2748
//     (`if (!line) continue;` then `JSON.parse(line)` inside a try)
// The originals are module-private and the module pulls in db.ts, so the copy
// is the comparison point; if the watcher's implementation changes, update it.
// ---------------------------------------------------------------------------
function refReadRangeSync(fd: number, start: number, end: number): Buffer {
  const buf = Buffer.allocUnsafe(end - start);
  let got = 0;
  while (got < buf.length) {
    const n = readSync(fd, buf, got, buf.length - got, start + got);
    if (n === 0) break;
    got += n;
  }
  return got < buf.length ? buf.subarray(0, got) : buf;
}

function refReadAppendedLinesSync(
  filePath: string,
  offset: number,
  chunkBytes: number,
): { lines: string[]; next: number; more: boolean } {
  const none = { lines: [] as string[], next: offset, more: false };
  let st;
  try { st = statSync(filePath); } catch { return none; }
  if (!st.isFile() || st.size <= offset) return none;
  let fd;
  try { fd = openReadNoFollow(filePath); } catch { return none; }
  try {
    let size = st.size;
    let end = offset;
    let lastNewline = -1;
    const parts: Buffer[] = [];
    while (end < size) {
      const want = Math.min(size, end + chunkBytes);
      const part = refReadRangeSync(fd, end, want);
      if (part.length < want - end) size = end + part.length;
      const nl = part.lastIndexOf(0x0a);
      if (nl !== -1) lastNewline = end + nl;
      parts.push(part);
      end += part.length;
      if (lastNewline !== -1) break;
    }
    if (lastNewline === -1) return none;
    const buf = parts.length === 1 ? parts[0]! : Buffer.concat(parts, end - offset);
    const lines = buf.subarray(0, lastNewline - offset).toString("utf8").split("\n");
    return { lines, next: lastNewline + 1, more: end < size };
  } catch {
    return none;
  } finally {
    closeSync(fd);
  }
}

interface Step { lines: string[]; next: number; more: boolean }

function drainReference(p: string, chunk: number): Step[] {
  const steps: Step[] = [];
  let offset = 0;
  for (let i = 0; i < 100_000; i++) {
    const r = refReadAppendedLinesSync(p, offset, chunk);
    steps.push(r);
    if (r.next === offset) break;
    offset = r.next;
  }
  return steps;
}

function stepOf(r: { text: string; nextOffset: number; eof: boolean }): Step {
  return { lines: splitAndParseLines(r.text).map((l) => l.raw), next: r.nextOffset, more: !r.eof };
}

async function drainNewAsync(p: string, chunk: number): Promise<Step[]> {
  const steps: Step[] = [];
  let offset = 0;
  for (let i = 0; i < 100_000; i++) {
    const r = await readChunk(p, offset, chunk);
    steps.push(stepOf(r));
    if (r.nextOffset === offset) break;
    offset = r.nextOffset;
  }
  return steps;
}

function drainNewSync(p: string, chunk: number): Step[] {
  const steps: Step[] = [];
  let offset = 0;
  for (let i = 0; i < 100_000; i++) {
    const r = readChunkSync(p, offset, chunk);
    steps.push(stepOf(r));
    if (r.nextOffset === offset) break;
    offset = r.nextOffset;
  }
  return steps;
}

function refParse(line: string): { parsed: unknown; failed: boolean } | "skipped" {
  if (!line) return "skipped"; // dispatchTailedLines: `if (!line) continue`
  try { return { parsed: JSON.parse(line), failed: false }; } catch { return { parsed: null, failed: true }; }
}

async function expectParity(p: string, chunk: number): Promise<void> {
  const ref = drainReference(p, chunk);
  expect(ref.length).toBeGreaterThan(0);
  expect(drainNewSync(p, chunk)).toEqual(ref);
  expect(await drainNewAsync(p, chunk)).toEqual(ref);
  // Parse parity over every line the reference produced.
  const refLines = ref.flatMap((s) => s.lines);
  let offset = 0;
  const newParsed = [];
  for (;;) {
    const r = readChunkSync(p, offset, chunk);
    newParsed.push(...splitAndParseLines(r.text));
    if (r.nextOffset === offset) break;
    offset = r.nextOffset;
  }
  expect(newParsed.map((l) => l.raw)).toEqual(refLines);
  for (let i = 0; i < refLines.length; i++) {
    const want = refParse(refLines[i]!);
    const got = newParsed[i]!;
    if (want === "skipped") {
      expect(got).toEqual({ raw: "", parsed: null });
    } else {
      expect(got.parsed).toEqual(want.parsed);
      expect(got.error !== undefined).toBe(want.failed);
    }
  }
}

const json = (o: unknown) => JSON.stringify(o);

const fixtures: Record<string, () => string | Buffer> = {
  "plain LF lines": () => `${json({ a: 1 })}\n${json({ b: "two" })}\n${json({ c: [3] })}\n`,
  "CRLF line endings": () => `${json({ a: 1 })}\r\n${json({ b: 2 })}\r\n`,
  "trailing partial line": () => `${json({ a: 1 })}\n${json({ b: 2 })}\n{"partial":"no newl`,
  "only a partial line": () => `{"partial":"no newline yet"}`,
  "empty lines": () => `${json({ a: 1 })}\n\n\n${json({ b: 2 })}\n\n`,
  "invalid JSON": () => `${json({ a: 1 })}\nnot json at all\n{"unterminated":\n${json({ b: 2 })}\n`,
  "literal null and scalars": () => `null\n42\n"str"\ntrue\n`,
  "huge line over 256 KB": () =>
    `${json({ a: 1 })}\n${json({ big: "x".repeat(300 * 1024) })}\n${json({ b: 2 })}\n`,
  "huge unterminated tail": () => `${json({ a: 1 })}\n{"big":"${"y".repeat(300 * 1024)}`,
  "multi-byte UTF-8": () =>
    `${json({ t: "héllo wörld — 日本語のテキスト 🙂🚀 \u{1F9D1}‍\u{1F4BB}" })}\n${json({ t: "ü".repeat(500) })}\n`,
  "empty file": () => "",
  "single newline": () => "\n",
};

describe("readChunk / splitAndParseLines parity with the watcher's read path", () => {
  for (const [name, make] of Object.entries(fixtures)) {
    const content = make();
    // A 1-byte chunk over a 300 KB line is hundreds of thousands of reads;
    // the big fixtures use the sizes that still straddle and exceed the line.
    const big = content.length > 100 * 1024;
    const sizes = big ? [4096, 64 * 1024, 256 * 1024] : [1, 3, 7, 64, 4096, 256 * 1024];
    test(`${name} (chunk sizes ${sizes.join(", ")})`, async () => {
      const p = fixture(content);
      for (const chunk of sizes) {
        await expectParity(p, chunk);
      }
    });
  }

  test("a multi-byte character split across a chunk boundary is never cut", async () => {
    // Every emoji is 4 bytes; a 5-byte chunk lands mid-character on most reads.
    const lines = Array.from({ length: 20 }, (_, i) => json({ i, t: "🙂".repeat(i + 1) }));
    const p = fixture(lines.join("\n") + "\n");
    const got: string[] = [];
    let offset = 0;
    for (;;) {
      const r = await readChunk(p, offset, 5);
      got.push(...splitAndParseLines(r.text).map((l) => l.raw));
      if (r.nextOffset === offset) break;
      offset = r.nextOffset;
    }
    expect(got).toEqual(lines);
    expect(got.every((l) => !l.includes("�"))).toBe(true);
  });

  test("a trailing partial line is held back, then returned once its newline lands", async () => {
    const p = fixture(`${json({ a: 1 })}\n{"b":`);
    const first = await readChunk(p, 0, 256 * 1024);
    expect(splitAndParseLines(first.text).map((l) => l.parsed)).toEqual([{ a: 1 }]);
    expect(first.nextOffset).toBe(json({ a: 1 }).length + 1);
    writeFileSync(p, `${json({ a: 1 })}\n{"b":2}\n`);
    const second = await readChunk(p, first.nextOffset, 256 * 1024);
    expect(splitAndParseLines(second.text).map((l) => l.parsed)).toEqual([{ b: 2 }]);
    expect(second.eof).toBe(true);
  });

  test("a line longer than maxBytes is returned whole (the read grows until a newline turns up)", async () => {
    const big = json({ big: "z".repeat(1000) });
    const p = fixture(`${json({ a: 1 })}\n${big}\n${json({ b: 2 })}\n`);
    const first = await readChunk(p, 0, 16);
    expect(splitAndParseLines(first.text).map((l) => l.raw)).toEqual([json({ a: 1 })]);
    expect(first.eof).toBe(false);
    // The 16-byte reads grow past the line until a chunk holds its newline; whatever
    // complete lines that last chunk also holds come with it, as in the watcher.
    const second = await readChunk(p, first.nextOffset, 16);
    const secondLines = splitAndParseLines(second.text).map((l) => l.raw);
    expect(secondLines[0]).toBe(big);
    expect(secondLines.length).toBeGreaterThanOrEqual(1);
    expect(second.nextOffset).toBeGreaterThan(first.nextOffset + big.length);
  });

  test("seeded property test: random files and chunk sizes match the reference", async () => {
    let state = 0x2545f491;
    const rnd = () => {
      state ^= state << 13; state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5; state >>>= 0;
      return state / 0x100000000;
    };
    const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const alphabet = ["a", "b", " ", "é", "日", "🙂", "\"", "\\", "\r", "{", "}"];
    const word = (n: number) => Array.from({ length: n }, () => pick(alphabet)).join("");
    const iterations = 150;
    let withBigLine = 0;
    for (let i = 0; i < iterations; i++) {
      const parts: string[] = [];
      const lineCount = Math.floor(rnd() * 12);
      for (let j = 0; j < lineCount; j++) {
        const kind = rnd();
        if (kind < 0.45) parts.push(json({ n: j, s: word(Math.floor(rnd() * 40)) }));
        else if (kind < 0.6) parts.push("");
        else if (kind < 0.75) parts.push(word(Math.floor(rnd() * 30))); // mostly invalid JSON
        else if (kind < 0.85) parts.push(json({ n: j }) + "\r");
        else if (kind < 0.9) { parts.push(json({ big: word(3000) })); withBigLine++; }
        else parts.push(json([j, null, true]));
      }
      let text = parts.join("\n");
      if (parts.length > 0 && rnd() < 0.7) text += "\n";
      if (rnd() < 0.3) text += word(Math.floor(rnd() * 20)); // trailing partial
      const p = fixture(text);
      await expectParity(p, 1 + Math.floor(rnd() * 400));
    }
    expect(iterations).toBe(150);
    expect(withBigLine).toBeGreaterThan(0);
  });
});

describe("parseLine / splitAndParseLines", () => {
  test("bad lines keep an error beside the raw text and never throw", () => {
    const out = splitAndParseLines(`{"a":1}\nnot json\n\n{"b":\n`);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ raw: `{"a":1}`, parsed: { a: 1 } });
    expect(out[1]!.raw).toBe("not json");
    expect(out[1]!.parsed).toBeNull();
    expect(typeof out[1]!.error).toBe("string");
    expect(out[2]).toEqual({ raw: "", parsed: null });
    expect(out[3]!.error).toBeDefined();
  });

  test("text without a trailing newline keeps its last line; empty text yields no lines", () => {
    expect(splitAndParseLines("")).toEqual([]);
    expect(splitAndParseLines(`{"a":1}`)).toHaveLength(1);
    expect(splitAndParseLines("\n")).toEqual([{ raw: "", parsed: null }]);
  });

  test("parseLine of a literal null has no error", () => {
    expect(parseLine("null")).toEqual({ raw: "null", parsed: null });
  });
});

describe("no-follow and tolerance", () => {
  test("a symlinked transcript reads as nothing, exactly like the watcher's read", async () => {
    const target = fixture(`${json({ a: 1 })}\n`);
    const link = path.join(root, `link${++seq}.jsonl`);
    symlinkSync(target, link);
    // The watcher's copy refuses it (ELOOP -> none); the new readers do too.
    expect(refReadAppendedLinesSync(link, 0, 4096).lines).toEqual([]);
    const syncRes = readChunkSync(link, 0, 4096);
    expect(syncRes.text).toBe("");
    expect(syncRes.nextOffset).toBe(0);
    const asyncRes = await readChunk(link, 0, 4096);
    expect(asyncRes.text).toBe("");
    expect(asyncRes.nextOffset).toBe(0);
    // Sanity: the target itself reads fine, so the refusal is the symlink's.
    expect((await readChunk(target, 0, 4096)).text).not.toBe("");
  });

  test("a missing file, a directory and an offset at or past EOF read as nothing", async () => {
    const dir = path.join(root, `dir${++seq}`);
    mkdirSync(dir);
    const p = fixture(`${json({ a: 1 })}\n`);
    const size = statSync(p).size;
    for (const target of [path.join(root, "does-not-exist.jsonl"), dir]) {
      expect((await readChunk(target, 0, 4096)).nextOffset).toBe(0);
      expect(readChunkSync(target, 0, 4096).nextOffset).toBe(0);
    }
    for (const off of [size, size + 100]) {
      const r = await readChunk(p, off, 4096);
      expect(r).toEqual({ text: "", nextOffset: off, eof: true, size });
    }
  });
});

describe("readMetaFile", () => {
  const metaDir = path.join(root, "subagents");
  mkdirSync(metaDir);
  const write = (id: string, content: string) => writeFileSync(path.join(metaDir, `agent-${id}.meta.json`), content);
  const defaults = { agentType: null, description: null, spawnDepth: 1, toolUseId: null };

  test("parses the sidecar and applies the readMeta defaults per field", async () => {
    write("full", json({ agentType: "Explore", description: "look around", spawnDepth: 2, toolUseId: "toolu_1" }));
    write("partial", json({ agentType: "Plan", spawnDepth: "deep", description: 5 }));
    const full = { agentType: "Explore", description: "look around", spawnDepth: 2, toolUseId: "toolu_1" };
    expect(await readMetaFile(metaDir, "full")).toEqual(full);
    expect(readMetaFileSync(metaDir, "full")).toEqual(full);
    const partial = { agentType: "Plan", description: null, spawnDepth: 1, toolUseId: null };
    expect(await readMetaFile(metaDir, "partial")).toEqual(partial);
    expect(readMetaFileSync(metaDir, "partial")).toEqual(partial);
  });

  test("absent, malformed, symlinked and oversized sidecars give the defaults", async () => {
    write("bad", "{not json");
    write("real", json({ agentType: "Explore" }));
    symlinkSync(path.join(metaDir, "agent-real.meta.json"), path.join(metaDir, "agent-linked.meta.json"));
    write("huge", json({ agentType: "Explore", pad: "x".repeat(META_MAX_BYTES) }));
    for (const id of ["missing", "bad", "linked", "huge"]) {
      expect(await readMetaFile(metaDir, id)).toEqual(defaults);
      expect(readMetaFileSync(metaDir, id)).toEqual(defaults);
    }
    expect((await readMetaFile(metaDir, "real")).agentType).toBe("Explore");
  });
});
