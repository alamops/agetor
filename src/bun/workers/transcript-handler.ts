// Worker-side handler for transcript reads. `src/bun/core-worker.ts` (the
// single worker entry, role `transcript`) routes each message it receives to
// `handleTranscriptMessage` and posts the returned reply back.
//
// Message contract (structured-clone friendly: plain objects, strings, numbers,
// booleans and arrays only; no class instances):
//
//   request  { id: number, op: "readChunk", args: { path, offset, maxBytes } }
//            { id: number, op: "readMeta",  args: { dir, id } }
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
// validation comes back as `ok: false`. Paths must be absolute; the caller owns
// confining them under the Claude config dir (`isPlainDirBelow`), and the read
// itself is no-follow on the final component.
//
// This module must stay free of main-thread side effects: no db.ts,
// orchestrator, server, interactions or terminals.

import path from "node:path";
import {
  readChunk,
  readMetaFile,
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
}

export interface ReadMetaArgs {
  dir: string;
  id: string;
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
    const { path: p, offset, maxBytes } = args;
    if (typeof p !== "string" || !path.isAbsolute(p) || p.includes("\0")) return "readChunk path must be an absolute path";
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
      return "readChunk offset must be a non-negative integer";
    }
    if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CHUNK_BYTES_LIMIT) {
      return `readChunk maxBytes must be an integer in [1, ${MAX_CHUNK_BYTES_LIMIT}]`;
    }
    return { id: msg.id, op: "readChunk", args: { path: p, offset, maxBytes } };
  }
  if (msg.op === "readMeta") {
    const { dir, id } = args;
    if (typeof dir !== "string" || !path.isAbsolute(dir) || dir.includes("\0")) return "readMeta dir must be an absolute path";
    if (typeof id !== "string" || !/^[\w.-]+$/.test(id)) return "readMeta id must be a plain file-name token";
    return { id: msg.id, op: "readMeta", args: { dir, id } };
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
          lines: splitAndParseLines(chunk.text),
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
