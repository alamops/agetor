// Reading the bytes of a file an AGENT chose, on behalf of the webview: the
// image an agent's markdown or `SendUserFile` call points at (`/files/preview`)
// and a working-tree file of a task's diff (`/tasks/:id/diff/blob`, new side).
// docs/plans/master-token-agent-read.md, D26(j).
//
// Why this module exists. The webview fetches those bytes with the master
// token, but the PATH is the agent's: `![](/Users/u/Documents/a.png)`, or a
// relative ref resolved through a symlink the agent planted in its worktree.
// Desktop-only routing doesn't help — the request comes from the app itself.
// If the core opened the file in its own process, the read would be made under
// Agetor's TCC identity, so an agent could use the app as a confused deputy to
// read (or provoke permission prompts for) protected folders it can't reach
// itself. So while the disclaim switch is on (`disclaimEnabled()`) the file is
// opened by a short-lived DISCLAIMED child of Apple system tools (`/bin/sh`,
// `/usr/bin/stat`, `/bin/cat`) that is responsible for itself — exactly the
// access the agent already has. With the switch off, agents run with Agetor's
// identity anyway (D7), so the read stays in-process.
//
// The disclaimed path streams: the child prints one header line (`O <size>
// <mtime>`) and then `exec`s `cat`, whose stdout becomes the response body —
// one exec per image, no buffering in the core. The header comes before any
// byte of content, the path travels only as an argv element after `--`, and
// `LC_ALL=C` keeps `stat`'s messages parseable.

import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { childEnv, coreSpawn } from "./core-spawn.ts";
import { disclaimEnabled } from "./disclaim.ts";
import { openReadNoFollow } from "./no-follow.ts";

/** Budget for the child to answer with its header and first bytes. A pending
 *  TCC prompt blocks the child, never the core. */
const OPEN_TIMEOUT_MS = 10_000;
/** Budget for the rest of the body once it started flowing. */
const BODY_TIMEOUT_MS = 60_000;
/** The header line is a token and two numbers; anything longer is garbage. */
const HEADER_CAP_BYTES = 4096;
const STDERR_CAP_BYTES = 4096;
/** An `If-None-Match` longer than this can't be one of our ETags. */
const IF_NONE_MATCH_MAX = 256;

export type FileBytesOpen =
  | { kind: "ok"; etag: string; size: number; body: ReadableStream<Uint8Array> | Blob | Uint8Array<ArrayBuffer> }
  | { kind: "not-modified"; etag: string }
  /** Missing, or not a regular file (directory, FIFO, device, and — without
   *  `followSymlinks` — a symlink). */
  | { kind: "missing" }
  | { kind: "too-large"; size: number }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string };

export interface FileBytesOptions {
  /** Follow a symlink at the final component (`stat -L`). Without it a
   *  symlink reads as `missing`. */
  followSymlinks: boolean;
  /** The request's `If-None-Match`; a match answers `not-modified` without
   *  reading the file. */
  ifNoneMatch?: string | null;
  /** Refuse a file larger than this (`too-large`) before reading it. */
  maxBytes?: number;
}

/**
 * Open `p` (absolute) for reading on behalf of the webview. Never throws. An
 * `ok` result's body is exactly `size` bytes long; a streamed body that ends
 * short errors instead of closing, so a truncated image never reads as whole.
 */
export async function openFileBytes(p: string, opts: FileBytesOptions): Promise<FileBytesOpen> {
  if (!p || p.includes("\0")) return { kind: "missing" };
  if (opts.maxBytes !== undefined && (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 0)) {
    return { kind: "error", message: `invalid maxBytes: ${opts.maxBytes}` };
  }
  return disclaimEnabled() ? openDisclaimed(p, opts) : openInProcess(p, opts);
}

/**
 * `openFileBytes`, collected into memory. Callers that buffer must pass
 * `maxBytes`, which bounds the allocation.
 */
export async function readFileBytes(
  p: string,
  opts: FileBytesOptions & { maxBytes: number },
): Promise<
  | { kind: "ok"; etag: string; bytes: Uint8Array<ArrayBuffer> }
  | Exclude<FileBytesOpen, { kind: "ok" } | { kind: "not-modified" }>
  | { kind: "not-modified"; etag: string }
> {
  const r = await openFileBytes(p, opts);
  if (r.kind !== "ok") return r;
  try {
    return { kind: "ok", etag: r.etag, bytes: await collect(r.body, r.size) };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

async function collect(body: ReadableStream<Uint8Array> | Blob | Uint8Array<ArrayBuffer>, size: number): Promise<Uint8Array<ArrayBuffer>> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  const out = new Uint8Array(size);
  let off = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, off);
    off += value.length;
  }
  return out;
}

function isMissingCode(code: unknown): boolean {
  return code === "ENOENT" || code === "ENOTDIR";
}

// ---------------------------------------------------------------------------
// in-process (switch off)
// ---------------------------------------------------------------------------

function openInProcess(p: string, opts: FileBytesOptions): FileBytesOpen {
  if (opts.followSymlinks) {
    let st;
    try {
      st = statSync(p);
    } catch (err) {
      return inProcessFailure(err);
    }
    // Only regular files: a FIFO or device named `*.png` would otherwise hang
    // the response stream forever.
    if (!st.isFile()) return { kind: "missing" };
    if (opts.maxBytes !== undefined && st.size > opts.maxBytes) return { kind: "too-large", size: st.size };
    const etag = `"${st.size}-${st.mtimeMs}"`;
    if (opts.ifNoneMatch === etag) return { kind: "not-modified", etag };
    // `Bun.file` opens lazily, once the response is already 200; check the
    // file can be opened first so an unreadable one is `denied`.
    try {
      closeSync(openSync(p, constants.O_RDONLY | constants.O_NONBLOCK));
    } catch (err) {
      return inProcessFailure(err);
    }
    return { kind: "ok", etag, size: st.size, body: Bun.file(p) };
  }

  let fd: number;
  try {
    fd = openReadNoFollow(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ELOOP: a symlink; EINVAL: not a regular file — both "not a file here".
    if (code === "ELOOP" || code === "EINVAL") return { kind: "missing" };
    return inProcessFailure(err);
  }
  try {
    const st = fstatSync(fd);
    if (opts.maxBytes !== undefined && st.size > opts.maxBytes) return { kind: "too-large", size: st.size };
    const etag = `"${st.size}-${st.mtimeMs}"`;
    if (opts.ifNoneMatch === etag) return { kind: "not-modified", etag };
    const bytes = readFileSync(fd);
    // The file can grow between the fstat and the read.
    if (opts.maxBytes !== undefined && bytes.length > opts.maxBytes) {
      return { kind: "too-large", size: bytes.length };
    }
    return { kind: "ok", etag, size: bytes.length, body: new Uint8Array(bytes) };
  } catch (err) {
    return inProcessFailure(err);
  } finally {
    closeSync(fd);
  }
}

function inProcessFailure(err: unknown): FileBytesOpen {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (isMissingCode(code)) return { kind: "missing" };
  const message = err instanceof Error ? err.message : String(err);
  if (code === "EPERM" || code === "EACCES") return { kind: "denied", message };
  return { kind: "error", message };
}

// ---------------------------------------------------------------------------
// disclaimed child (switch on)
// ---------------------------------------------------------------------------

/**
 * `$1` path, `$2` the request's If-None-Match (or empty), `$3` `1` to follow a
 * symlink at the final component, `$4` the size limit (or empty). First line
 * of stdout is a token:
 *   `M`              missing, or not a regular file
 *   `E` + message    stat failed for another reason (message on the next line)
 *   `L <size>`       over the limit
 *   `N <size> <mt>`  matches If-None-Match; nothing more is read
 *   `O <size> <mt>`  the file's bytes follow
 * `stat`'s format names no path, so a name with spaces or newlines can't
 * desync the header. A dangling symlink still stats under `-L` (as "Symbolic
 * Link"), so it reads as missing by type.
 */
const OPEN_SCRIPT = `
if [ "$3" = 1 ]; then follow=-L; else follow=; fi
out=$(/usr/bin/stat $follow -f '%z %Fm %HT' -- "$1" 2>&1)
if [ "$?" -ne 0 ]; then
  case "$out" in
    *"No such file or directory"*|*"Not a directory"*) printf 'M\\n' ;;
    *) printf 'E\\n%s\\n' "$out" ;;
  esac
  exit 0
fi
size=\${out%% *}
rest=\${out#* }
mtime=\${rest%% *}
type=\${rest#* }
if [ "$type" != "Regular File" ]; then printf 'M\\n'; exit 0; fi
if [ -n "$4" ] && [ "$size" -gt "$4" ]; then printf 'L %s\\n' "$size"; exit 0; fi
if [ -n "$2" ] && [ "\\"$size-$mtime\\"" = "$2" ]; then printf 'N %s %s\\n' "$size" "$mtime"; exit 0; fi
printf 'O %s %s\\n' "$size" "$mtime"
exec /bin/cat -- "$1"
`;

const DENIED_RE = /Operation not permitted|Permission denied/;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

async function readText(stream: ReadableStream<Uint8Array> | null | undefined, cap: number): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  let buf: Uint8Array = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      if (buf.length < cap) buf = concat(buf, value.subarray(0, cap - buf.length));
    }
  } catch {
    // a killed child's pipe can error; keep what arrived
  }
  return new TextDecoder().decode(buf).trim();
}

async function openDisclaimed(p: string, opts: FileBytesOptions): Promise<FileBytesOpen> {
  const inm = opts.ifNoneMatch && opts.ifNoneMatch.length <= IF_NONE_MATCH_MAX ? opts.ifNoneMatch : "";
  let proc: ReturnType<typeof coreSpawn>;
  try {
    proc = coreSpawn(
      [
        "/bin/sh",
        "-c",
        OPEN_SCRIPT,
        "sh",
        p,
        inm,
        opts.followSymlinks ? "1" : "0",
        opts.maxBytes === undefined ? "" : String(opts.maxBytes),
      ],
      { env: { ...childEnv(), LC_ALL: "C" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
  } catch (err) {
    return { kind: "error", message: `could not start helper (${err instanceof Error ? err.message : String(err)})` };
  }

  const kill = () => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  };
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timedOut = true;
    kill();
  }, OPEN_TIMEOUT_MS);
  const stopTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const stderr = readText(proc.stderr as ReadableStream<Uint8Array> | null, STDERR_CAP_BYTES);
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const read = async (): Promise<Uint8Array | null> => {
    try {
      const r = await reader.read();
      return r.done || !r.value ? null : r.value;
    } catch {
      return null;
    }
  };
  const close = async () => {
    stopTimer();
    kill();
    await reader.cancel().catch(() => {});
  };
  const fail = async (r: FileBytesOpen): Promise<FileBytesOpen> => {
    await close();
    return r;
  };
  const timeoutResult = (): FileBytesOpen => ({
    kind: "error",
    message: `timed out after ${OPEN_TIMEOUT_MS / 1000} s (a macOS permission prompt may be waiting)`,
  });

  // Header line.
  let buf: Uint8Array = new Uint8Array(0);
  let nl = -1;
  while (nl < 0) {
    const chunk = await read();
    if (!chunk) break;
    buf = concat(buf, chunk);
    nl = buf.indexOf(0x0a);
    if (nl < 0 && buf.length > HEADER_CAP_BYTES) return fail({ kind: "error", message: "unexpected helper output" });
  }
  if (nl < 0) {
    if (timedOut) return fail(timeoutResult());
    const err = await stderr;
    return fail({ kind: "error", message: err || "helper produced no answer" });
  }
  const header = new TextDecoder().decode(buf.subarray(0, nl)).split(" ");
  let first: Uint8Array = buf.subarray(nl + 1);
  const token = header[0];

  if (token === "M") return fail({ kind: "missing" });
  if (token === "E") {
    let msg = new TextDecoder().decode(first);
    while (msg.length < STDERR_CAP_BYTES) {
      const chunk = await read();
      if (!chunk) break;
      msg += new TextDecoder().decode(chunk);
    }
    msg = msg.trim() || "stat failed";
    return fail(DENIED_RE.test(msg) ? { kind: "denied", message: msg } : { kind: "error", message: msg });
  }
  const size = Number(header[1]);
  if (!Number.isSafeInteger(size) || size < 0) return fail({ kind: "error", message: "unexpected helper output" });
  if (token === "L") return fail({ kind: "too-large", size });
  const etag = `"${size}-${header[2] ?? ""}"`;
  if (token === "N") return fail({ kind: "not-modified", etag });
  if (token !== "O" || header.length !== 3) return fail({ kind: "error", message: "unexpected helper output" });

  if (size === 0) {
    await close();
    return { kind: "ok", etag, size: 0, body: new Uint8Array(0) };
  }
  // `stat` answers for a protected file that `cat` can't read, so wait for the
  // first byte before answering 200: a refused read becomes `denied`, not a
  // response that dies after its headers.
  if (first.length === 0) {
    const chunk = await read();
    if (!chunk) {
      if (timedOut) return fail(timeoutResult());
      const err = await stderr;
      if (DENIED_RE.test(err)) return fail({ kind: "denied", message: err });
      return fail({ kind: "error", message: err || "file ended before its size" });
    }
    first = chunk;
  }

  // Streaming. Cut at `size` (a file that grew is not read past it) and error
  // on a short read, so a client never mistakes a truncated body for a whole one.
  stopTimer();
  timer = setTimeout(kill, BODY_TIMEOUT_MS);
  let sent = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    stopTimer();
    if (proc.exitCode === null) kill();
    reader.cancel().catch(() => {});
  };
  const push = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array) => {
    const part = chunk.length > size - sent ? chunk.subarray(0, size - sent) : chunk;
    sent += part.length;
    if (part.length) controller.enqueue(part);
    if (sent >= size) {
      finish();
      controller.close();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push(controller, first);
    },
    async pull(controller) {
      if (finished) return;
      const chunk = await read();
      if (finished) return;
      if (!chunk) {
        finish();
        controller.error(new Error(`file ended after ${sent} of ${size} bytes`));
        return;
      }
      push(controller, chunk);
    },
    cancel() {
      finish();
    },
  });
  return { kind: "ok", etag, size, body };
}
