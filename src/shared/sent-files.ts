/**
 * Grammar for Claude Code's `SendUserFile` tool — the "send files to the
 * user" built-in available when a Remote Control client is connected or in a
 * managed cloud session. Shared by both processes (webview card, CLI/TUI
 * formatter, bun orchestrator detection) so "what counts as a sent file"
 * can't drift between surfaces — same decision as `user-message.ts` and
 * `todo-progress.ts`. Kept free of runtime imports from either process side.
 *
 * Ground truth, from 14 real Claude Code 2.1.258–2.1.263 transcripts plus a
 * live probe (2026-09-07):
 *
 *   tool_use input:
 *     { files: string[], caption?: string, status?: "normal"|"proactive",
 *       display?: "render"|"attach" }
 *     Paths were absolute in every observed call; the tool description
 *     allows cwd-relative too.
 *
 *   success tool_result content (string, possibly wrapped in text blocks):
 *     "2 files delivered to user.\n  /abs/a.png → file_uuid: <uuid>\n  …"
 *     (singular: "1 file delivered to user.\n  …"). Claude's own
 *     `toolUseResult` object additionally carries a structured
 *     `attachments[]` array — forwarded (sanitized) as
 *     `ToolResultAttachment[]`.
 *
 *   error tool_result (e.g. a directory path): `is_error: true`, content
 *     `"<tool_use_error>Attachment \"<path>\" is not a regular file.
 *     </tool_use_error>"`. A plain `"Error: …"` prefix is also plausible.
 *     `toolUseResult` is a bare string on error, not an object — nothing to
 *     forward as attachments.
 *
 * Known upstream bug (issues #76739/#88889/#90455): the success text is
 * returned even when client-side delivery silently fails — "delivered" here
 * means "the tool reported delivery", nothing more.
 */
import type { SentFileEntry, ToolResultAttachment } from "./types.ts";

/** Claude's built-in tool name. */
export const SENT_FILES_TOOL_NAME = "SendUserFile";

/** Cap on `task.sentFiles` — oldest entries drop off once exceeded. */
export const MAX_SENT_FILES = 200;

/** Matches the leading count in a successful delivery message
 *  ("N file(s) delivered to user…"). Capture group 1 is the count. */
export const SENT_FILES_DELIVERED_RE = /^(\d+) files? delivered to user/;

/** Parsed, validated shape of a `SendUserFile` tool_use's `input`. */
export interface SentFilesRequest {
  files: string[];
  caption: string | null;
  status: "normal" | "proactive" | null;
  display: "render" | "attach" | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate and normalize a tool_use `{ name, input }` pair as a
 * `SendUserFile` request. Returns `null` unless `name` is exactly
 * {@link SENT_FILES_TOOL_NAME}, `input` is a plain object, and `input.files`
 * is an array yielding at least one non-empty (post-trim) string — non-string
 * and empty entries are dropped silently; an all-empty/absent `files` yields
 * `null` rather than an empty request. `caption` is trimmed to a non-empty
 * string or `null`; `status`/`display` pass through only their known literal
 * values, else `null` (an unrecognized or absent value is treated the same).
 */
export function parseSentFilesToolUse(name: string, input: unknown): SentFilesRequest | null {
  if (name !== SENT_FILES_TOOL_NAME) return null;
  if (!isPlainObject(input)) return null;

  const rawFiles = input.files;
  if (!Array.isArray(rawFiles)) return null;
  const seen = new Set<string>();
  const files: string[] = [];
  for (const f of rawFiles) {
    if (typeof f !== "string") continue;
    const trimmed = f.trim();
    if (trimmed.length === 0) continue;
    // Dedupe by exact string, first occurrence wins — keeps the card header,
    // status row, CLI line and orchestrator persistence all agreeing on "how
    // many files" a call requested.
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    files.push(trimmed);
  }
  if (files.length === 0) return null;

  const rawCaption = input.caption;
  const caption = typeof rawCaption === "string" && rawCaption.trim().length > 0
    ? rawCaption.trim()
    : null;

  const rawStatus = input.status;
  const status: SentFilesRequest["status"] =
    rawStatus === "normal" || rawStatus === "proactive" ? rawStatus : null;

  const rawDisplay = input.display;
  const display: SentFilesRequest["display"] =
    rawDisplay === "render" || rawDisplay === "attach" ? rawDisplay : null;

  return { files, caption, status, display };
}

/** Flatten a tool_result's `content` to plain text — mirrors
 *  `src/bun/claude-tmux.ts`'s `toolResultText` (string passes through;
 *  an array of content blocks joins the `.text` of `type: "text"` blocks,
 *  discarding anything else; any other shape is `""`), except blocks here
 *  join with `"\n"` rather than claude-tmux's `""` — sent-file delivery
 *  text is line-oriented (`"N files delivered…\n  <path> → …"`) and this
 *  module never observes multi-block content in practice, so the separator
 *  choice is defensive rather than load-bearing. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((x): x is { type: "text"; text?: string } =>
      Boolean(x) && typeof x === "object" && (x as { type?: string }).type === "text")
    .map((x) => x.text ?? "")
    .join("\n");
}

/** Parsed outcome of a `SendUserFile` tool_result. `isError` is `true` only
 *  when the tool_result itself was `is_error` — it's what distinguishes a
 *  genuine send failure (`isError: true`) from a non-error result that still
 *  didn't deliver anything, e.g. a user-declined/interrupted call (see
 *  {@link parseSentFilesToolResult}'s doc comment). */
export interface SentFilesResult {
  delivered: boolean;
  deliveredCount: number | null;
  error: string | null;
  attachments: ToolResultAttachment[];
  isError: boolean;
}

const TOOL_USE_ERROR_WRAPPER_RE = /<tool_use_error>([\s\S]*?)<\/tool_use_error>/;
const ERROR_PREFIX_RE = /^Error:\s*/;

/**
 * Parse a `SendUserFile` tool_result. On `isError`, the wrapping
 * `<tool_use_error>…</tool_use_error>` tag (when present) is stripped down
 * to its inner text, a leading `"Error: "` prefix is stripped, and the
 * result is trimmed — an empty message (shouldn't happen, but tool text is
 * never fully trusted) falls back to `"Send failed."`.
 *
 * Otherwise (`isError` falsy) delivery is judged by content, not merely by
 * the absence of an error: `delivered` requires the text to match
 * {@link SENT_FILES_DELIVERED_RE} OR `attachments` to be non-empty (claude's
 * own structured, authoritative record of what actually went out). This
 * matters because claude-tmux.ts deliberately rewrites a user-interrupted/
 * declined `SendUserFile` tool_result to a non-error result whose content is
 * "Declined — Claude is waiting for your direction." — without this check
 * that text would satisfy the old "any non-error result is delivered" rule
 * and get recorded as a successful send. A non-error result that fails the
 * test returns `delivered: false` with `error` set to the trimmed text (or
 * `"Not delivered."` when the text is empty) — mirroring the error-branch's
 * "never surface a blank message" discipline — and an empty `attachments`.
 *
 * A result that DOES pass — either shape — counts as delivered:
 * `deliveredCount` is the number captured by {@link SENT_FILES_DELIVERED_RE}
 * when the text matches, else `null` (an unrecognized-but-attachment-backed
 * success shape still counts as delivered — just without a known count), and
 * `attachments` passes through the (already-sanitized) array the caller
 * supplies, defaulting to `[]`.
 */
export function parseSentFilesToolResult(
  content: unknown,
  isError: boolean | undefined,
  attachments?: ToolResultAttachment[] | null,
): SentFilesResult {
  const text = toolResultText(content);

  if (isError) {
    const wrapped = TOOL_USE_ERROR_WRAPPER_RE.exec(text);
    const unwrapped = wrapped ? wrapped[1] ?? "" : text;
    const message = unwrapped.replace(ERROR_PREFIX_RE, "").trim();
    return {
      delivered: false,
      deliveredCount: null,
      error: message.length > 0 ? message : "Send failed.",
      attachments: [],
      isError: true,
    };
  }

  const match = SENT_FILES_DELIVERED_RE.exec(text);
  const resolvedAttachments = attachments ?? [];
  const delivered = match !== null || resolvedAttachments.length > 0;

  if (!delivered) {
    const trimmed = text.trim();
    return {
      delivered: false,
      deliveredCount: null,
      error: trimmed.length > 0 ? trimmed : "Not delivered.",
      attachments: [],
      isError: false,
    };
  }

  const deliveredCount = match && match[1] !== undefined ? Number(match[1]) : null;

  return {
    delivered: true,
    deliveredCount,
    error: null,
    attachments: resolvedAttachments,
    isError: false,
  };
}

/**
 * Sanitize a raw `toolUseResult.attachments` value (claude's shape:
 * `{ path, size, isImage, media_type, pathValidated, file_uuid }`) down to
 * the {@link ToolResultAttachment} contract. Returns `null` when `raw` isn't
 * an array at all (nothing to forward — distinct from `[]`, which means "an
 * array with nothing usable in it"); malformed items (no non-empty string
 * `path`) are dropped rather than failing the whole array. Unrecognized
 * fields (`pathValidated`, `file_uuid`) are dropped — this module only keeps
 * what the card/badge/CLI actually use.
 */
export function sanitizeToolResultAttachments(raw: unknown): ToolResultAttachment[] | null {
  if (!Array.isArray(raw)) return null;

  const out: ToolResultAttachment[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;

    const rawPath = item.path;
    if (typeof rawPath !== "string") continue;
    const path = rawPath.trim();
    if (path.length === 0) continue;

    const rawSize = item.size;
    const size = typeof rawSize === "number" && Number.isFinite(rawSize) && rawSize >= 0
      ? rawSize
      : null;

    const rawIsImage = item.isImage;
    const isImage = typeof rawIsImage === "boolean" ? rawIsImage : null;

    const rawMediaType = item.media_type ?? item.mediaType;
    const mediaType = typeof rawMediaType === "string" && rawMediaType.trim().length > 0
      ? rawMediaType.trim()
      : null;

    out.push({ path, size, isImage, mediaType });
  }
  return out;
}

/**
 * Merge newly delivered files into a task's persisted `sentFiles` list.
 * `incoming` entries always replace an `existing` entry sharing the same
 * `path` (a fresher detection wins even when its metadata is sparser); when
 * `incoming` itself carries more than one entry for the same path, the one
 * with the latest `sentAt` wins. The result is sorted by `sentAt` ascending
 * (ties broken by `path`) and capped to the most recent {@link MAX_SENT_FILES}
 * entries — the oldest overflow silently drops off.
 */
export function mergeSentFiles(existing: SentFileEntry[], incoming: SentFileEntry[]): SentFileEntry[] {
  const byPath = new Map<string, SentFileEntry>();
  for (const entry of existing) byPath.set(entry.path, entry);

  const incomingByPath = new Map<string, SentFileEntry>();
  for (const entry of incoming) {
    const prev = incomingByPath.get(entry.path);
    if (!prev || entry.sentAt >= prev.sentAt) incomingByPath.set(entry.path, entry);
  }
  for (const [path, entry] of incomingByPath) byPath.set(path, entry);

  const merged = Array.from(byPath.values());
  merged.sort((a, b) => a.sentAt - b.sentAt || a.path.localeCompare(b.path));
  return merged.slice(-MAX_SENT_FILES);
}

/** Last path segment of `path`, after stripping trailing `/`s (a directory
 *  ref keeps its own name, not an empty string). Returns `path` unchanged
 *  when there's no `/` left to split on. */
export function sentFileBasename(path: string): string {
  let p = path;
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

const BYTE_UNITS = ["KB", "MB", "GB", "TB"] as const;

/** Human-friendly byte size: `"0 B"` / `"512 B"` below 1 KB (whole bytes,
 *  rounded), one decimal place from KB up (base 1024). Mirrors the style of
 *  `formatTurnDuration` in `src/bun/claude-tmux.ts` — simple, purpose-built,
 *  no external formatting library. */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return "0 B";
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
}

/**
 * One-line, plain-text (no ANSI, no emoji — callers prefix their own 📎)
 * summary of a `SendUserFile` call, for the CLI/TUI's tool-line rendering.
 * Basenames only, in `req.files` order:
 *
 *   - `result === null` (no tool_result yet): `"sending 2 files: a.png, b.md"`
 *   - delivered: `"sent 2 files: a.png (233.2 KB), b.md"` — a file's size
 *     renders only when `result.attachments` has a matching (by exact path)
 *     entry with a known `size`; singular form for one file.
 *   - error (`result.isError`): `"send failed (a.png, b.md): <error>"`
 *   - non-error, not delivered (e.g. declined/interrupted):
 *     `"not delivered (a.png, b.md): <error>"`
 */
export function sentFilesSummaryLine(req: SentFilesRequest, result: SentFilesResult | null): string {
  const basenames = req.files.map(sentFileBasename);
  const count = req.files.length;
  const noun = count === 1 ? "file" : "files";

  if (result === null) {
    return `sending ${count} ${noun}: ${basenames.join(", ")}`;
  }

  if (!result.delivered) {
    const verb = result.isError ? "send failed" : "not delivered";
    return `${verb} (${basenames.join(", ")}): ${result.error ?? "Send failed."}`;
  }

  const sizeByPath = new Map<string, number>();
  for (const attachment of result.attachments) {
    if (attachment.size !== null) sizeByPath.set(attachment.path, attachment.size);
  }
  const parts = req.files.map((path) => {
    const base = sentFileBasename(path);
    const size = sizeByPath.get(path);
    return size === undefined ? base : `${base} (${formatByteSize(size)})`;
  });
  return `sent ${count} ${noun}: ${parts.join(", ")}`;
}
