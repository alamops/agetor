/**
 * The phone projection of events (docs/specs/remote-readiness-spec.md "A phone projection of events (new)").
 *
 * The native apps share no code with the webview, so the core runs the parsers in `src/shared` and sends each event with its parsed
 * form: the iOS and Android apps render that instead of porting the parsers twice. Applied at SEND time only; persisted rows are
 * never touched (CLAUDE.md: persisted events stay raw).
 *
 * What is parsed here is exactly what the shared parsers cover:
 *   - tagged user messages and pasted-content unwrapping (`user-message.ts`),
 *   - the TODO tracker from a `TodoWrite` snapshot (`todo-progress.ts`),
 *   - sent files, request and result (`sent-files.ts`),
 *   - handoff blocks in assistant text (`handoff-locator.ts`),
 *   - compaction summaries (`compaction.ts`).
 * Parsers that live only in `src/mainview` (event dedup, the ask-card and pipeline-attention views, path shortening, the markdown-image
 * classifier) are NOT copied here: they are raw-only for the phone and listed in the plan's completeness ledger. A parse that fails
 * yields `parsed: null`; the raw event always goes out.
 *
 * A tool result over 16 KB goes out cut (`trimToolResultData` with `PHONE_TOOL_RESULT_BYTES`) with `truncated: {eventId, fullBytes}`; the
 * phone fetches the whole text with `GET /tasks/:id/events/:eventId`.
 */
import { compactionSummaryBytes, compactionSummaryLine } from "../../shared/compaction.ts";
import { findHandoffBlocks, mayContainHandoffOpenTag } from "../../shared/handoff-locator.ts";
import { SENT_FILES_TOOL_NAME, parseSentFilesToolResult, parseSentFilesToolUse, sanitizeToolResultAttachments } from "../../shared/sent-files.ts";
import { deriveTodoProgress } from "../../shared/todo-progress.ts";
import { trimToolResultData, utf8Length } from "../../shared/tool-result-trim.ts";
import { PHONE_TOOL_RESULT_BYTES, type RunEvent } from "../../shared/types.ts";
import { normalizeDeliveredUserText, parseUserMessage, unwrapPastedContent } from "../../shared/user-message.ts";

export interface Truncated {
  eventId: number;
  fullBytes: number;
}

export interface ProjectedEvent {
  /** The event as the phone gets it: the stored row, except a tool result over 16 KB, whose `data` is cut. */
  raw: RunEvent;
  /** The parsed form for this stream, or null when there is none (or the parse did not apply). */
  parsed: Record<string, unknown> | null;
  truncated?: Truncated;
}

function tryJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function projectUser(ev: RunEvent): Record<string, unknown> | null {
  const text = normalizeDeliveredUserText(unwrapPastedContent(ev.data));
  const message = parseUserMessage(ev.data);
  return { kind: "user", text, message };
}

function projectAssistant(ev: RunEvent): Record<string, unknown> | null {
  // The assistant row is JSON `{text}` for most harnesses and plain text for others; read the text either way.
  const parsed = tryJson(ev.data);
  const text = isObject(parsed) && typeof parsed.text === "string" ? parsed.text : ev.data;
  if (!mayContainHandoffOpenTag(text)) return null;
  const blocks = findHandoffBlocks(text);
  if (blocks.length === 0) return null;
  return { kind: "handoff", blocks: blocks.map((b) => ({ ...b, inner: text.slice(b.openEnd, b.closeStart) })) };
}

function projectToolUse(ev: RunEvent): Record<string, unknown> | null {
  const j = tryJson(ev.data);
  if (!isObject(j) || typeof j.name !== "string") return null;
  if (j.name === SENT_FILES_TOOL_NAME) {
    const request = parseSentFilesToolUse(j.name, j.input);
    return request ? { kind: "sent-files-request", request } : null;
  }
  if (j.name === "TodoWrite") {
    const progress = deriveTodoProgress([{ stream: "tool_use", data: ev.data }]);
    return progress ? { kind: "todo", progress } : null;
  }
  return null;
}

function projectToolResult(ev: RunEvent): Record<string, unknown> | null {
  const j = tryJson(ev.data);
  if (!isObject(j)) return null;
  const attachments = sanitizeToolResultAttachments(j.attachments);
  if (attachments === null || attachments.length === 0) return null;
  // Only a result with attachments is a SendUserFile delivery; a plain result has no parsed form of its own.
  const result = parseSentFilesToolResult(j.content, j.isError === true, attachments);
  return { kind: "sent-files-result", result };
}

function projectCompaction(ev: RunEvent): Record<string, unknown> | null {
  return { kind: "compaction-summary", line: compactionSummaryLine(ev.data), bytes: compactionSummaryBytes(ev.data) };
}

/** Project one stored event for a phone. Never throws: a parser that cannot handle a row leaves `parsed: null`. */
export function projectEvent(ev: RunEvent, now: number = Date.now()): ProjectedEvent {
  let raw = ev;
  let truncated: Truncated | undefined;
  const eventId = ev.id;
  if (ev.stream === "tool_result" && typeof eventId === "number" && utf8Length(ev.data) > PHONE_TOOL_RESULT_BYTES) {
    const cut = trimToolResultData(ev.data, PHONE_TOOL_RESULT_BYTES, now);
    if (cut) {
      raw = { ...ev, data: cut.data };
      truncated = { eventId, fullBytes: cut.originalBytes };
    }
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    switch (ev.stream) {
      case "user":
        parsed = projectUser(ev);
        break;
      case "assistant":
        parsed = projectAssistant(ev);
        break;
      case "tool_use":
        parsed = projectToolUse(ev);
        break;
      case "tool_result":
        parsed = projectToolResult(ev);
        break;
      case "compaction_summary":
        parsed = projectCompaction(ev);
        break;
      default:
        parsed = null;
    }
  } catch {
    parsed = null;
  }
  return truncated ? { raw, parsed, truncated } : { raw, parsed };
}
