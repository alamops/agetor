// Worker-side handler for transcript reads. `src/bun/core-worker.ts` (the
// single worker entry, role `transcript`) routes each message it receives to
// `handleTranscriptMessage` and posts the returned reply back.
//
// Message contract (structured-clone friendly: plain objects, strings, numbers,
// booleans and arrays only; no class instances):
//
//   request  { id: number, op: "readChunk", args: { path, offset, maxBytes, allowedRoot? } }
//            { id: number, op: "readMeta",  args: { dir, id, allowedRoot? } }
//   reply    { id, ok: true,  result }
//            { id, ok: false, error: { message: string, code?: string } }
//
//   readChunk result: { lines: ParsedLine[], nextOffset, eof, size }
//     `lines` are the complete lines read, each { raw, parsed, error? } (see
//     transcript-parse.ts); `nextOffset`/`eof`/`size` as in `ChunkResult`.
//   readMeta result: TranscriptMeta (defaults on any failure, like readMeta).
//
// `id` is echoed so the main thread can match a reply to its request. The
// handler never throws: a malformed request or an argument that fails
// validation comes back as `ok: false`.
//
// PATH CONTRACT. The handler does not trust an absolute path from the main
// thread to be safe. Every caller (the subagent watcher, T11) MUST pass
// `allowedRoot`: the subagents directory it already validated and watches.
// With `allowedRoot` the handler refuses (`ok: false`, code EINVAL, no read attempted) unless
//   * `allowedRoot` and the path are absolute, NUL-free and contain no `..`
//     segment before normalisation;
//   * readChunk: the file lies directly under `allowedRoot` (a bare file name,
//     no sub-directory); readMeta: `dir` is `allowedRoot` or below it;
//   * every directory component from `allowedRoot` (exclusive, trusted as-is)
//     down to the file's directory is a real directory, not a symlink
//     (`isPlainDirBelow`, src/bun/no-follow.ts, the same rule the watcher
//     applies before listing or watching).
// The file itself is opened no-follow (a symlink, FIFO or non-regular file reads
// as "nothing"). Without `allowedRoot` the legacy behaviour remains (absolute
// path only), kept for tests and callers that confine the path themselves; new
// callers must not omit it. A single line over `MAX_LINE_BYTES` (64 MB) comes
// back as `{ raw: "", parsed: null, error: "tooLarge" }`, the offset advanced
// past it.
//
// This module must stay free of main-thread side effects: no db.ts,
// orchestrator, server, interactions or terminals.

import path from "node:path";
import { isPlainDirBelow } from "../no-follow.ts";
import {
  readChunk,
  readMetaFile,
  TOO_LARGE_ERROR,
  splitAndParseLines,
  type ParsedLine,
  type TranscriptMeta,
} from "../transcript-parse.ts";

/** Largest `maxBytes` a request may ask for. The watcher uses 256 KB. */
export const MAX_CHUNK_BYTES_LIMIT = 64 * 1024 * 1024;

export interface ReadChunkArgs {
  path: string;
  offset: number;
  maxBytes: number;
  /** Directory the file must sit directly in (plain, non-symlinked). */
  allowedRoot?: string;
}

export interface ReadMetaArgs {
  dir: string;
  id: string;
  /** Directory `dir` must be, or lie below (plain, non-symlinked). */
  allowedRoot?: string;
}

export type TranscriptRequest =
  | { id: number; op: "readChunk"; args: ReadChunkArgs }
  | { id: number; op: "readMeta"; args: ReadMetaArgs };

export interface ReadChunkReply {
  lines: ParsedLine[];
  nextOffset: number;
  eof: boolean;
  size: number;
}

export type TranscriptReply =
  | { id: number; ok: true; result: ReadChunkReply | TranscriptMeta }
  | { id: number; ok: false; error: { message: string; code?: string } };

function fail(id: number, message: string, code = "EINVAL"): TranscriptReply {
  return { id, ok: false, error: { message, code } };
}

function hasDotDot(p: string): boolean {
  return p.split(/[\\/]/).includes("..");
}

function plainAbsolute(p: unknown): p is string {
  return typeof p === "string" && path.isAbsolute(p) && !p.includes("\0") && !hasDotDot(p);
}

/** Null when `dir` is acceptable under `allowedRoot` (or no root was given),
 *  else the refusal message. */
function checkRoot(allowedRoot: unknown, dir: string): string | null {
  if (allowedRoot === undefined) return null;
  if (!plainAbsolute(allowedRoot)) return "allowedRoot must be a plain absolute path";
  if (!plainAbsolute(dir)) return "path must be a plain absolute path";
  if (!isPlainDirBelow(allowedRoot, path.normalize(dir))) return "path is not a plain location under allowedRoot";
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Validate an unknown message into a `TranscriptRequest`, or an error string. */
export function parseTranscriptRequest(msg: unknown): TranscriptRequest | string {
  if (!isObject(msg)) return "transcript request must be an object";
  if (typeof msg.id !== "number" || !Number.isInteger(msg.id)) return "transcript request needs an integer id";
  const args = msg.args;
  if (!isObject(args)) return "transcript request needs args";
  if (msg.op === "readChunk") {
    const { path: p, offset, maxBytes, allowedRoot } = args;
    if (typeof p !== "string" || !path.isAbsolute(p) || p.includes("\0")) return "readChunk path must be an absolute path";
    if (allowedRoot !== undefined) {
      if (hasDotDot(p)) return "readChunk path must not contain '..'";
      const refusal = checkRoot(allowedRoot, path.dirname(p));
      if (refusal) return refusal;
    }
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
      return "readChunk offset must be a non-negative integer";
    }
    if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CHUNK_BYTES_LIMIT) {
      return `readChunk maxBytes must be an integer in [1, ${MAX_CHUNK_BYTES_LIMIT}]`;
    }
    return {
      id: msg.id,
      op: "readChunk",
      args: { path: p, offset, maxBytes, ...(typeof allowedRoot === "string" ? { allowedRoot } : {}) },
    };
  }
  if (msg.op === "readMeta") {
    const { dir, id, allowedRoot } = args;
    if (typeof dir !== "string" || !path.isAbsolute(dir) || dir.includes("\0")) return "readMeta dir must be an absolute path";
    if (typeof id !== "string" || !/^[\w.-]+$/.test(id) || id === "." || id === "..") return "readMeta id must be a plain file-name token";
    if (allowedRoot !== undefined) {
      if (hasDotDot(dir)) return "readMeta dir must not contain '..'";
      const refusal = checkRoot(allowedRoot, dir);
      if (refusal) return refusal;
    }
    return {
      id: msg.id,
      op: "readMeta",
      args: { dir, id, ...(typeof allowedRoot === "string" ? { allowedRoot } : {}) },
    };
  }
  return "unknown transcript op";
}

/** Handle one request. Always resolves with a reply carrying the request's id
 *  (or -1 when the message had none). */
export async function handleTranscriptMessage(msg: unknown): Promise<TranscriptReply> {
  const req = parseTranscriptRequest(msg);
  if (typeof req === "string") {
    const id = isObject(msg) && typeof msg.id === "number" ? msg.id : -1;
    return fail(id, req);
  }
  try {
    if (req.op === "readChunk") {
      const chunk = await readChunk(req.args.path, req.args.offset, req.args.maxBytes);
      return {
        id: req.id,
        ok: true,
        result: {
          lines: chunk.tooLarge
            ? [{ raw: "", parsed: null, error: TOO_LARGE_ERROR }]
            : splitAndParseLines(chunk.text),
          nextOffset: chunk.nextOffset,
          eof: chunk.eof,
          size: chunk.size,
        },
      };
    }
    return { id: req.id, ok: true, result: await readMetaFile(req.args.dir, req.args.id) };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return fail(req.id, err instanceof Error ? err.message : String(e), err?.code ?? "EIO");
  }
}
