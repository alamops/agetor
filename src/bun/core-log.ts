/**
 * Persistent, non-blocking core log (docs/plans/non-blocking-core.md, T1).
 *
 * The packaged app points the core's stdio at /dev/null, so every
 * `console.warn` (the event-loop-lag stall lines above all) vanished. This
 * module tees `console.log/info/warn/error/debug` into
 * `<dataDir>/logs/core.log` while still calling the original method.
 *
 * It must never become the stall it records:
 *   - a console call only formats, redacts and pushes a string onto an
 *     in-memory queue; the file write happens in a batch, at most every
 *     {@link FLUSH_EVERY_MS} or once the queue passes {@link FLUSH_BYTES},
 *     through an async `fs/promises` handle. There is no per-line sync write;
 *   - the queue is bounded ({@link MAX_QUEUE_BYTES}); past it the OLDEST lines
 *     are dropped and a counted marker is written instead;
 *   - rotation (`core.log` -> `.1` -> `.2`, three files in all) runs inside the
 *     async writer;
 *   - a write error is reported once to the ORIGINAL console and then
 *     rate-limited; it never reaches the caller.
 * The one sync write is the best-effort flush on `process.on("exit")`.
 *
 * Secrets: every line passes through {@link redactLogText} before it is queued.
 * Boot registers the master token, the CLI token and any OpenCode password via
 * {@link registerLogSecret}; the pattern layer (Authorization/Bearer headers,
 * `token=` values, plus everything `redactSecrets` in opencode-http.ts covers)
 * catches the rest (docs/architecture/security.md).
 *
 * Leaf on purpose: imports only `core-creds` (the data-dir resolver) and the
 * import-free `opencode-http` redactor, so db.ts and everything else can load
 * it first.
 *
 * Enablement: on by default except under `bun test` (`NODE_ENV === "test"`),
 * where `AGETOR_CORE_LOG=1` turns it on; `AGETOR_CORE_LOG=0` disables it
 * anywhere.
 */
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { chmod, mkdir, open, rename, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { format } from "node:util";
import { resolveDataDir } from "./core-creds.ts";
import { redactSecrets } from "./opencode-http.ts";

/** Rotate once the live file passes this size. daemon-log.ts keeps its own
 *  identical constant; it could adopt these later. */
export const CORE_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Total files kept: `core.log`, `core.log.1`, `core.log.2`. */
export const CORE_LOG_FILES = 3;
const FLUSH_EVERY_MS = 200;
const FLUSH_BYTES = 64 * 1024;
/** In-memory ceiling between two flushes. */
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
/** One line is cut here so a single huge payload can't dominate the queue. It
 *  also bounds redaction cost: the URL-userinfo pattern inside `redactSecrets`
 *  is quadratic on a long run with no whitespace (measured 85 ms at 8,000
 *  chars, 16 ms at 4,000), and a log call must stay far under the 100 ms
 *  main-thread budget. */
const MAX_LINE_CHARS = 4096;
/** A secret shorter than this is not registered: replacing "ab" everywhere
 *  would shred the log without protecting anything. */
const MIN_SECRET_CHARS = 6;
/** Most flush passes one `flushCoreLog()` makes while writers keep appending. */
const MAX_DRAIN_PASSES = 50;
const WRITE_ERROR_REPORT_EVERY_MS = 60_000;

type Level = "log" | "info" | "warn" | "error" | "debug";
const LEVELS: Level[] = ["log", "info", "warn", "error", "debug"];

const secrets = new Set<string>();

/** Register a literal secret (token, password) to be replaced everywhere it
 *  appears in a log line, including inside a longer string. */
export function registerLogSecret(value: string | null | undefined): void {
  if (typeof value !== "string" || value.length < MIN_SECRET_CHARS) return;
  secrets.add(value);
}

/** The one redactor for log text: registered secrets, then Bearer/Authorization
 *  and `token=` patterns, then `redactSecrets` (OpenCode password forms). */
export function redactLogText(text: string): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join("[redacted]");
  }
  out = out
    // "Bearer xyz" of any length (redactSecrets only catches 8+ chars).
    .replace(/\b(bearer)(\s+)[^\s"']+/gi, "$1$2[redacted]")
    // `token=…` / `access_token: …` in a URL, header dump or JSON.
    .replace(/(\b\w*token["']?\s*[=:]\s*["']?)[^\s&"',;}]+/gi, "$1[redacted]");
  return redactSecrets(out);
}

// --- state -----------------------------------------------------------------

interface Config {
  dir: string;
  file: string;
  maxBytes: number;
  files: number;
}

let installed = false;
let config: Config | null = null;
let originals: Partial<Record<Level, (...args: unknown[]) => void>> = {};
/** The console methods as they were before the tee, restored on uninstall. */
let rawConsole: Partial<Record<Level, (typeof console)[Level]>> = {};
let exitHandler: (() => void) | null = null;

let queue: string[] = [];
let queueBytes = 0;
let droppedLines = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Lines handed to an in-progress write; kept so the exit flush can still
 *  write them if the async write never completes. */
let inFlight = "";
let chain: Promise<void> = Promise.resolve();
let handle: FileHandle | null = null;
let fileSize = 0;
let lastErrorReportAt = Number.NEGATIVE_INFINITY;
let inTee = false;

function coreLogEnabled(): boolean {
  const env = process.env.AGETOR_CORE_LOG;
  if (env === "0") return false;
  if (env === "1") return true;
  return process.env.NODE_ENV !== "test";
}

function reportWriteError(e: unknown): void {
  const now = Date.now();
  if (now - lastErrorReportAt < WRITE_ERROR_REPORT_EVERY_MS) return;
  lastErrorReportAt = now;
  try {
    // The ORIGINAL console: the patched one would queue this very line again.
    (originals.error ?? (() => {}))(
      "[agetor] core log write failed:",
      e instanceof Error ? e.message : String(e),
    );
  } catch {
    /* nothing left to do */
  }
}

// --- enqueue ---------------------------------------------------------------

function enqueue(level: Level, args: unknown[]): void {
  let text: string;
  try {
    text = format(...args.map((a) => (a instanceof Error ? (a.stack ?? `${a.name}: ${a.message}`) : a)));
  } catch {
    text = "[unformattable log arguments]";
  }
  if (text.length > MAX_LINE_CHARS) text = `${text.slice(0, MAX_LINE_CHARS)}... [truncated]`;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redactLogText(text)}\n`;
  queue.push(line);
  queueBytes += line.length;
  // Drop the OLDEST lines past the ceiling. A head index would avoid the O(n)
  // shift, but the ceiling is only reached in a storm and one splice below
  // amortises it.
  if (queueBytes > MAX_QUEUE_BYTES) {
    let drop = 0;
    let freed = 0;
    while (drop < queue.length - 1 && queueBytes - freed > MAX_QUEUE_BYTES / 2) {
      freed += queue[drop]!.length;
      drop++;
    }
    queue.splice(0, drop);
    queueBytes -= freed;
    droppedLines += drop;
  }
  if (queueBytes >= FLUSH_BYTES) {
    // Not synchronously: the caller (a route handler) must not pay for it.
    scheduleFlush(0);
  } else {
    scheduleFlush(FLUSH_EVERY_MS);
  }
}

function scheduleFlush(delayMs: number): void {
  if (flushTimer !== null && delayMs > 0) return;
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void runFlush();
  }, delayMs);
  // Never keep the process alive for a pending log flush; exit flushes it.
  (flushTimer as { unref?: () => void }).unref?.();
}

function takeBatch(): string {
  let out = "";
  if (droppedLines > 0) {
    out += `${new Date().toISOString()} WARN [agetor] core log: ${droppedLines} lines dropped (log storm)\n`;
    droppedLines = 0;
  }
  out += queue.join("");
  queue = [];
  queueBytes = 0;
  return out;
}

// --- async writer ----------------------------------------------------------

async function openHandle(cfg: Config): Promise<FileHandle> {
  await mkdir(cfg.dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by the umask and ignored for an existing dir.
  await chmod(cfg.dir, 0o700).catch(() => {});
  const h = await open(cfg.file, "a", 0o600);
  await chmod(cfg.file, 0o600).catch(() => {});
  try {
    fileSize = (await stat(cfg.file)).size;
  } catch {
    fileSize = 0;
  }
  return h;
}

async function rotate(cfg: Config): Promise<void> {
  if (handle) {
    const h = handle;
    handle = null;
    await h.close().catch(() => {});
  }
  // Shift oldest-first: rename overwrites, so the last generation falls off.
  for (let i = cfg.files - 2; i >= 1; i--) {
    await rename(`${cfg.file}.${i}`, `${cfg.file}.${i + 1}`).catch(() => {});
  }
  await rename(cfg.file, `${cfg.file}.1`).catch(() => {});
  fileSize = 0;
}

async function writeBatch(batch: string): Promise<void> {
  const cfg = config;
  if (!cfg || batch === "") return;
  if (!handle) handle = await openHandle(cfg);
  if (fileSize > cfg.maxBytes) {
    await rotate(cfg);
    handle = await openHandle(cfg);
  }
  await handle.write(batch);
  fileSize += Buffer.byteLength(batch);
}

function runFlush(): Promise<void> {
  chain = chain.then(async () => {
    if (queue.length === 0 && droppedLines === 0) return;
    const batch = takeBatch();
    inFlight = batch;
    try {
      await writeBatch(batch);
    } catch (e) {
      // Drop this batch (no unbounded retry) and reopen on the next one.
      if (handle) {
        const h = handle;
        handle = null;
        await h.close().catch(() => {});
      }
      reportWriteError(e);
    } finally {
      inFlight = "";
    }
  }).catch(() => {
    // Unreachable in practice (the body catches), but a rejected chain would
    // wedge every later flush, so it can never be left rejected.
  });
  return chain;
}

/** Write everything queued so far. Resolves (never rejects) once the queue is
 *  empty or {@link MAX_DRAIN_PASSES} passes have run. For a graceful quit. */
export async function flushCoreLog(): Promise<void> {
  if (!installed) return;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  for (let pass = 0; pass < MAX_DRAIN_PASSES; pass++) {
    await runFlush();
    if (queue.length === 0 && droppedLines === 0) break;
  }
}

function exitFlush(): void {
  const cfg = config;
  if (!cfg) return;
  try {
    const rest = inFlight + takeBatch();
    if (rest === "") return;
    mkdirSync(cfg.dir, { recursive: true, mode: 0o700 });
    appendFileSync(cfg.file, rest, { mode: 0o600 });
    chmodSync(cfg.file, 0o600);
  } catch {
    /* exiting; nowhere left to report */
  }
}

// --- install ---------------------------------------------------------------

/** Install the console tee. Idempotent; a no-op when disabled for this
 *  environment. */
export function installCoreLog(opts: { dataDir?: string; maxBytes?: number; files?: number } = {}): void {
  if (installed) return;
  if (!coreLogEnabled()) return;
  const dir = path.join(opts.dataDir ?? resolveDataDir(), "logs");
  config = {
    dir,
    file: path.join(dir, "core.log"),
    maxBytes: opts.maxBytes !== undefined && opts.maxBytes > 0 ? opts.maxBytes : CORE_LOG_MAX_BYTES,
    files: Math.max(2, opts.files ?? CORE_LOG_FILES),
  };
  installed = true;
  originals = {};
  rawConsole = {};
  for (const level of LEVELS) {
    rawConsole[level] = console[level];
    const original = console[level].bind(console) as (...args: unknown[]) => void;
    originals[level] = original;
    console[level] = (...args: unknown[]): void => {
      try {
        original(...args);
      } finally {
        if (!inTee) {
          inTee = true;
          try {
            enqueue(level, args);
          } catch {
            /* logging never throws into callers */
          } finally {
            inTee = false;
          }
        }
      }
    };
  }
  exitHandler = exitFlush;
  process.on("exit", exitHandler);
}

/** Restore the console and close the file (tests, and a clean shutdown that
 *  wants the console back). Flushes first. */
export async function uninstallCoreLog(): Promise<void> {
  if (!installed) return;
  await flushCoreLog();
  for (const level of LEVELS) {
    const raw = rawConsole[level];
    if (raw) console[level] = raw;
  }
  if (exitHandler) process.off("exit", exitHandler);
  exitHandler = null;
  originals = {};
  rawConsole = {};
  installed = false;
  config = null;
  queue = [];
  queueBytes = 0;
  droppedLines = 0;
  secrets.clear();
  if (handle) {
    const h = handle;
    handle = null;
    await h.close().catch(() => {});
  }
}
