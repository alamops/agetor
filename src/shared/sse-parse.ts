/**
 * Pure Server-Sent-Events frame parser, shared by the webview's fetch-based
 * reader and the CLI's `streamSse` (D13 / P8). Neither side can use the
 * platform `EventSource` any more: it cannot set an `Authorization` header, and
 * the API no longer accepts the token in the URL. Both read the response body by
 * hand and feed decoded text through this one parser, so "what counts as a
 * frame" cannot drift between them.
 *
 * It follows the WHATWG "event stream interpretation" rules:
 *   - a line ends in CRLF, LF or a lone CR (a CR at the end of one chunk
 *     followed by an LF at the start of the next is ONE line break);
 *   - `field: value` strips a single optional leading space from the value, and
 *     a line with no colon is a field with an empty value;
 *   - lines starting with `:` are comments (the server's keepalive pings) and
 *     are dropped;
 *   - `data` lines join with `\n`, `event` sets the type, and an empty line
 *     dispatches the block;
 *   - one leading U+FEFF at the very start of the stream is stripped;
 *   - `id` is surfaced on the frame of its block (forward resume: readers echo
 *     the last one back as `Last-Event-ID` on reconnect). A value containing
 *     U+0000 is ignored, per the spec. The parser stays per-block — keeping the
 *     "last event id" across blocks is the reader's job, since it must outlive
 *     the connection (and so the parser) anyway. `id:` with an empty value is
 *     reported as `id: ""`, which consumers read as "reset to none".
 *
 * Input is already text — callers decode with a streaming `TextDecoder`, so a
 * multi-byte character split across network chunks never reaches this module.
 * Chunks may split anywhere, including mid-line and between the two bytes of a
 * CRLF.
 *
 * Retry/id representation (the one deliberate extension to the spec's dispatch
 * rule): the spec applies `retry:` (and `id:`) to the connection the moment the
 * line is read, independent of dispatch, and a server that opens a stream with
 * just `retry: 3000\n\n` has sent a block with no `data`, which the spec never
 * dispatches. To keep those values reachable through a `push(): SseFrame[]`
 * API:
 *   - a block that dispatches (it has a `data` field) carries its `retry` and
 *     `id`, if the block had them, on the frame;
 *   - a block with a valid `retry` and/or an `id` but NO `data` field yields a
 *     control frame `{ event: "", data: "", id?, retry? }`. `event` is `""`
 *     there — a real dispatched frame never has an empty type (an empty
 *     `event:` value dispatches as `"message"`), so `event === ""` means
 *     "control only, not a message" and a reader that routes by `event`
 *     ignores it naturally.
 * A block with none of `data`, a valid `retry` or an `id` (an `event:`-only
 * block, stray comments) produces nothing, per the spec.
 */
export interface SseFrame {
  /** The event type. `"message"` when the block named none; `""` only on a
   *  retry-only control frame (see above). */
  event: string;
  /** The `data` lines joined with `\n` (may be `""` for a bare `data:` line). */
  data: string;
  /** Reconnection delay in ms, when the block carried a valid `retry:`. */
  retry?: number;
  /** The block's own `id:` value (`""` for a bare/empty `id:`, meaning "reset
   *  the last event id"). Absent when the block had none or it contained
   *  U+0000. */
  id?: string;
}

export interface SseParser {
  /** Feed the next chunk of decoded text; returns every frame it completed. */
  push(chunk: string): SseFrame[];
}

const LINE_BREAK = /[\r\n]/g;
const DIGITS_ONLY = /^[0-9]+$/;

export function createSseParser(): SseParser {
  /** The unterminated tail of the previous chunk (the line being built). */
  let line = "";
  /** The last line ended with a CR, so an LF opening the next chunk (or
   *  following immediately) is the second half of that same CRLF. */
  let skipLf = false;
  /** Nothing has been consumed yet, so a leading BOM is still strippable. */
  let atStart = true;

  // The block being assembled.
  let event = "";
  let data = "";
  let hasData = false;
  let retry: number | undefined;
  let id: string | undefined;

  function processLine(l: string, out: SseFrame[]): void {
    if (l === "") {
      // Blank line: dispatch (or discard) the block, then reset it.
      if (hasData) {
        const frame: SseFrame = { event: event === "" ? "message" : event, data };
        if (id !== undefined) frame.id = id;
        if (retry !== undefined) frame.retry = retry;
        out.push(frame);
      } else if (retry !== undefined || id !== undefined) {
        const frame: SseFrame = { event: "", data: "" };
        if (id !== undefined) frame.id = id;
        if (retry !== undefined) frame.retry = retry;
        out.push(frame);
      }
      event = "";
      data = "";
      hasData = false;
      retry = undefined;
      id = undefined;
      return;
    }
    if (l.charCodeAt(0) === 0x3a /* ":" */) return; // comment / keepalive

    const colon = l.indexOf(":");
    let field: string;
    let value: string;
    if (colon === -1) {
      field = l;
      value = "";
    } else {
      field = l.slice(0, colon);
      value = l.slice(colon + 1);
      if (value.charCodeAt(0) === 0x20) value = value.slice(1);
    }
    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        // Each data line contributes `value` plus a LF; the trailing LF is
        // dropped at dispatch. Appending the separator before every line but
        // the first is the same string without a final slice.
        data = hasData ? `${data}\n${value}` : value;
        hasData = true;
        break;
      case "retry":
        if (DIGITS_ONLY.test(value)) retry = Number.parseInt(value, 10);
        break;
      case "id":
        // A NUL makes the whole field ignored (WHATWG), not just trimmed.
        if (!value.includes("\u0000")) id = value;
        break;
      default:
        // Unknown fields are ignored.
        break;
    }
  }

  return {
    push(chunk: string): SseFrame[] {
      const out: SseFrame[] = [];
      if (chunk === "") return out;
      let text = chunk;
      if (atStart) {
        atStart = false;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      }

      let pos = 0;
      if (skipLf) {
        skipLf = false;
        if (text.charCodeAt(0) === 0x0a) pos = 1;
      }

      LINE_BREAK.lastIndex = pos;
      for (;;) {
        const m = LINE_BREAK.exec(text);
        if (m === null) break;
        const at = m.index;
        processLine(line + text.slice(pos, at), out);
        line = "";
        if (text.charCodeAt(at) === 0x0d) {
          // CR: swallow an immediately following LF; if the chunk ends right
          // here, remember to swallow one that opens the next chunk.
          if (at + 1 < text.length) {
            pos = text.charCodeAt(at + 1) === 0x0a ? at + 2 : at + 1;
          } else {
            pos = at + 1;
            skipLf = true;
          }
        } else {
          pos = at + 1;
        }
        LINE_BREAK.lastIndex = pos;
      }
      line += text.slice(pos);
      return out;
    },
  };
}
