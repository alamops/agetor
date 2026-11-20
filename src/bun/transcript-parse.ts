// Pure transcript-reading and parsing primitives for the Claude subagent
// watcher (docs/architecture/core-responsiveness.md, docs/plans/non-blocking-core.md).
//
// Everything here is side-effect free at import and safe to load inside a
// worker thread: the only imports are node:fs / node:util and the no-follow
// helpers (which themselves only pull in node:fs and `disclaim.ts`).
//
// The byte semantics reproduce `readAppendedLinesSync` and `readMeta` in
// `claude-subagents.ts` exactly, so a reader that moves off the main thread
// sees the same line boundaries, cursors and parse results:
//   * only COMPLETE lines are returned; a trailing partial line (the writer
//     is mid-line, or a chunk boundary cut it) is left for the next read;
//   * the cut is made on the byte buffer (0x0a never occurs inside a
//     multi-byte UTF-8 sequence), so a chunk boundary can never split a
//     character or skew the cursor;
//   * a line longer than `maxBytes` still makes progress: while a clamped read
//     holds no newline the read keeps growing, chunk by chunk, until one turns
//     up or EOF (a genuine partial: nothing returned);
//   * the file is opened no-follow through `openReadNoFollow` (a symlink at
//     the final component, a FIFO or any non-regular file reads as "nothing");
//   * never throws: a missing, unreadable, non-regular or truncated file reads
//     as "nothing (more) appended".
// A single line IS size-capped (`MAX_LINE_BYTES`, 64 MB, a deliberate
// divergence from the watcher, which would grow one read until EOF): a line
// longer than the cap is never accumulated. Its bytes are read and discarded,
// the offset advances past its newline, and the chunk reports it with
// `tooLarge: true` (`ParsedLine.error === "tooLarge"` once split). A cap-sized
// line with no newline yet (the writer is mid-line) reads as "nothing" and is
// re-scanned, still without accumulating, on the next call. Lines at or under
// the cap behave exactly as before. The caller owns the path (the worker
// handler validates it against an `allowedRoot`, see workers/transcript-handler.ts).

import { closeSync, read as readCb } from "node:fs";
import { stat as statAsync } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { openReadNoFollow } from "./no-follow.ts";

const readAsync = promisify(readCb);

/** One `readChunk` result. `text` holds the decoded COMPLETE lines, each
 *  terminated by its `\n` (so `""` means no complete line was available);
 *  `nextOffset` is the byte offset just past the last `\n` read (equal to the
 *  requested offset when nothing complete was found); `eof` is true when no
 *  bytes beyond what this call read were on disk at the stat (false means call
 *  again for more); `size` is the file size at that stat (0 when the stat
 *  failed). */
export interface ChunkResult {
  text: string;
  nextOffset: number;
  eof: boolean;
  size: number;
  /** True when the line starting at the requested offset exceeded the line
   *  cap and was skipped: `text` is then "" and `nextOffset` is just past that
   *  line's newline. Absent otherwise. */
  tooLarge?: boolean;
}

/** One line of a chunk. `parsed` is the `JSON.parse` result (null for an empty
 *  line, a parse failure, or a literal `null`); `error` is set only for a
 *  parse failure (empty lines carry no error: the watcher skips them). */
export interface ParsedLine {
  raw: string;
  parsed: unknown | null;
  error?: string;
}

/** The `agent-<id>.meta.json` sidecar, with the same defaults `readMeta`
 *  applies. */
export interface TranscriptMeta {
  agentType: string | null;
  description: string | null;
  spawnDepth: number;
  toolUseId: string | null;
}

/** Upper bound on a meta sidecar. The real files are a few hundred bytes; the
 *  cap keeps a planted giant file from being read whole (the watcher's own
 *  read has no cap, so a larger one degrades to the defaults here). */
export const META_MAX_BYTES = 1024 * 1024;

/** Longest single line `readChunk` accumulates. A longer line is skipped and
 *  reported (`tooLarge`) so one planted or runaway line cannot exhaust memory. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

/** `ParsedLine.error` for a line skipped because it exceeded the cap. */
export const TOO_LARGE_ERROR = "tooLarge";

const META_READ_STEP = 16 * 1024;

function defaultMeta(): TranscriptMeta {
  return { agentType: null, description: null, spawnDepth: 1, toolUseId: null };
}

function normalizeChunkBytes(maxBytes: number): number {
  return Number.isFinite(maxBytes) ? Math.max(1, Math.floor(maxBytes)) : 1;
}

function normalizeLineCap(cap: number | undefined): number {
  return cap !== undefined && Number.isFinite(cap) ? Math.max(1, Math.floor(cap)) : MAX_LINE_BYTES;
}

function skipped(nextOffset: number, size: number): ChunkResult {
  return { text: "", nextOffset, eof: nextOffset >= size, size, tooLarge: true };
}

function none(offset: number, size: number): ChunkResult {
  return { text: "", nextOffset: offset, eof: true, size };
}

/** Assemble the result from the buffers read so far. Shared by both variants
 *  so they cannot drift. */
function assemble(parts: Buffer[], offset: number, end: number, lastNewline: number, size: number): ChunkResult {
  const buf = parts.length === 1 ? parts[0]! : Buffer.concat(parts, end - offset);
  const text = buf.subarray(0, lastNewline + 1 - offset).toString("utf8");
  return { text, nextOffset: lastNewline + 1, eof: end >= size, size };
}

async function readRange(fd: number, start: number, end: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(end - start);
  let got = 0;
  while (got < buf.length) {
    const { bytesRead } = await readAsync(fd, buf, got, buf.length - got, start + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return got < buf.length ? buf.subarray(0, got) : buf;
}

/** Read at most ~`maxBytes` of what was appended to `filePath` since `offset`
 *  and return its complete lines. Async: the reads go through the libuv pool,
 *  so a caller on a latency-sensitive loop is not blocked by the I/O. */
export async function readChunk(
  filePath: string,
  offset: number,
  maxBytes: number,
  maxLineBytes?: number,
): Promise<ChunkResult> {
  const lineCap = normalizeLineCap(maxLineBytes);
  const chunkBytes = Math.min(normalizeChunkBytes(maxBytes), lineCap);
  let st;
  try { st = await statAsync(filePath); } catch { return none(offset, 0); }
  if (!st.isFile() || st.size <= offset) return none(offset, st.size);
  let fd;
  try { fd = openReadNoFollow(filePath); } catch { return none(offset, st.size); }
  try {
    let size = st.size;
    let end = offset;
    let lastNewline = -1;
    const parts: Buffer[] = [];
    let skipping = false;
    while (end < size) {
      const want = Math.min(size, end + chunkBytes);
      const part = await readRange(fd, end, want);
      if (part.length < want - end) size = end + part.length;
      const first = part.indexOf(0x0a);
      if (first !== -1) {
        if (end + first - offset > lineCap) return skipped(end + first + 1, size); // the line at `offset` is over the cap
        lastNewline = end + part.lastIndexOf(0x0a);
        parts.push(part);
        end += part.length;
        break;
      }
      end += part.length;
      if (!skipping) {
        parts.push(part);
        if (end - offset > lineCap) { skipping = true; parts.length = 0; } // discard, never accumulate
      }
    }
    if (lastNewline === -1) return none(offset, size);
    return assemble(parts, offset, end, lastNewline, size);
  } catch {
    return none(offset, st.size);
  } finally {
    closeSync(fd);
  }
}

/** `JSON.parse` of one line with the error kept, never thrown. An empty line
 *  is returned as-is (parsed null, no error) because the watcher skips it. */
export function parseLine(raw: string): ParsedLine {
  if (raw === "") return { raw, parsed: null };
  try {
    return { raw, parsed: JSON.parse(raw) as unknown };
  } catch (e) {
    return { raw, parsed: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Split `ChunkResult.text` into lines (the final `\n` yields no trailing empty
 *  element, exactly like the watcher's `split("\n")` on the text without its
 *  last newline) and parse each. Never throws: a bad line keeps its error
 *  beside its raw text. */
export function splitAndParseLines(text: string): ParsedLine[] {
  if (text === "") return [];
  const raws = text.split("\n");
  if (raws[raws.length - 1] === "") raws.pop();
  return raws.map(parseLine);
}

function metaFromText(text: string): TranscriptMeta {
  const o = JSON.parse(text) as Record<string, unknown>;
  return {
    agentType: typeof o.agentType === "string" ? o.agentType : null,
    description: typeof o.description === "string" ? o.description : null,
    spawnDepth: typeof o.spawnDepth === "number" ? o.spawnDepth : 1,
    toolUseId: typeof o.toolUseId === "string" ? o.toolUseId : null,
  };
}

function metaPath(dir: string, id: string): string {
  return path.join(dir, `agent-${id}.meta.json`);
}

/** Equivalent of `readMeta`: tolerates absence, a symlink, a non-regular file, an oversized file and malformed JSON by returning the defaults. */
export async function readMetaFile(
  dir: string,
  id: string,
  /** Test seam only: `afterOpen` runs once the file is open (a test grows the
   *  file there), `onRead` sees each read's byte count. */
  hooks?: { afterOpen?: () => void; onRead?: (bytes: number) => void },
): Promise<TranscriptMeta> {
  try {
    const fd = openReadNoFollow(metaPath(dir, id), { maxBytes: META_MAX_BYTES });
    try {
      hooks?.afterOpen?.();
      // Bounded while reading, not only at open: a file that grows past the cap
      // after the open is never read beyond cap + 1 bytes.
      const parts: Buffer[] = [];
      let pos = 0;
      while (pos <= META_MAX_BYTES) {
        const buf = Buffer.allocUnsafe(Math.min(META_READ_STEP, META_MAX_BYTES + 1 - pos));
        const { bytesRead } = await readAsync(fd, buf, 0, buf.length, pos);
        if (bytesRead === 0) break;
        hooks?.onRead?.(bytesRead);
        parts.push(buf.subarray(0, bytesRead));
        pos += bytesRead;
      }
      if (pos > META_MAX_BYTES) return defaultMeta();
      return metaFromText(Buffer.concat(parts).toString("utf8"));
    } finally {
      closeSync(fd);
    }
  } catch {
    return defaultMeta();
  }
}
