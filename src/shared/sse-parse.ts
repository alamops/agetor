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
 *   - `id` is accepted and IGNORED: neither reader sends `Last-Event-ID` (the
 *     server replays by its own cursor), so the value would never be read.
 *
 * Input is already text — callers decode with a streaming `TextDecoder`, so a
 * multi-byte character split across network chunks never reaches this module.
 * Chunks may split anywhere, including mid-line and between the two bytes of a
 * CRLF.
 *
 * Retry representation (the one deliberate extension to the spec's dispatch
 * rule): the spec applies `retry:` to the connection the moment the line is
 * read, independent of dispatch, and a server that opens a stream with just
 * `retry: 3000\n\n` has sent a block with no `data`, which the spec never
 * dispatches. To keep that value reachable through a `push(): SseFrame[]`
 * API:
 *   - a block that dispatches (it has a `data` field) carries its `retry`, if
 *     the block had one, on the frame;
 *   - a block with a valid `retry` but NO `data` field yields a control frame
 *     `{ event: "", data: "", retry }`. `event` is `""` there — a real
 *     dispatched frame never has an empty type (an empty `event:` value
 *     dispatches as `"message"`), so `event === ""` means "retry only, not a
 *     message" and a reader that routes by `event` ignores it naturally.
 * A block with neither `data` nor a valid `retry` (an `event:`-only block, a
 * lone `id:`, stray comments) produces nothing, per the spec.
 */
export interface SseFrame {
  /** The event type. `"message"` when the block named none; `""` only on a
   *  retry-only control frame (see above). */
  event: string;
  /** The `data` lines joined with `\n` (may be `""` for a bare `data:` line). */
  data: string;
  /** Reconnection delay in ms, when the block carried a valid `retry:`. */
  retry?: number;
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

  function processLine(l: string, out: SseFrame[]): void {
    if (l === "") {
      // Blank line: dispatch (or discard) the block, then reset it.
      if (hasData) {
        const frame: SseFrame = { event: event === "" ? "message" : event, data };
        if (retry !== undefined) frame.retry = retry;
        out.push(frame);
      } else if (retry !== undefined) {
        out.push({ event: "", data: "", retry });
      }
      event = "";
      data = "";
      hasData = false;
      retry = undefined;
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
      default:
        // `id` and any unknown field: ignored (see the module comment).
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
