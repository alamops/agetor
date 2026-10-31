// Fetch-based Server-Sent-Events reader for the webview (master-token plan,
// D13/P8). The platform `EventSource` can't set an `Authorization` header, and
// the API no longer accepts the master token in a URL, so every stream the
// webview opens (`/events`, `/app/events`, `/tasks/:id/events`,
// `/runs/:id/events`) goes through `openEventStream` instead: a streaming
// `fetch` whose body is decoded with a `TextDecoder` and fed through the one
// shared frame parser (`src/shared/sse-parse.ts`, also used by the CLI).
//
// It reproduces the `EventSource` behaviour the callers rely on:
//   - named events go to `handlers.events[name]`, unnamed (`message`) frames to
//     `handlers.onMessage`; a block with no `data` dispatches nothing;
//   - after a clean end of the stream, or a network error, it reconnects:
//     after the server's own `retry:` value when the stream ever carried one,
//     else after a jittered backoff that starts at 1 s and doubles to 10 s (the
//     backoff resets once a connection is actually established);
//   - it STOPS for good on HTTP 401/403/404 (a stale token, a forbidden or an
//     unknown route will not fix itself by retrying). `EventSource` stops on
//     ANY non-200; a 5xx here (the core restarting, a proxy hiccup) is treated
//     like a network error and retried, since "the core is briefly down" is the
//     common cause and the old behaviour on a dropped connection was to retry;
//   - `onError` fires for every failure (network error, bad status), including
//     the one that stops the stream; a clean end of the stream is not a failure;
//   - it remembers the last SSE `id:` it saw across the reconnects of ONE
//     stream and sends it as `Last-Event-ID` on every connect after the first,
//     as `EventSource` does. Only the task stream (`/tasks/:id/events`) emits
//     ids today, so a forward-resuming server answers with just the rows past
//     that id; every other stream never has an id and is unaffected. An `id:`
//     on an otherwise empty block (a control frame) still advances it, and an
//     empty `id:` resets it to none (per the SSE spec);
//   - the returned function aborts the in-flight request and any pending
//     reconnect, and nothing is delivered or reconnected after it.
//
// WKWebView caps HTTP/1.1 connections per host at ~6 and two of them are the
// permanent SSE channels (see the RunPanel note in CLAUDE.md); a fetch body
// holds a connection exactly like an EventSource did, so this changes nothing
// about that budget.
import { createSseParser, type SseFrame } from "../../shared/sse-parse.ts";

export interface EventStreamHandlers {
  /** Unnamed (`message`) frames. */
  onMessage?(data: string): void;
  /** Named frames, keyed by the `event:` field. */
  events?: Record<string, (data: string) => void>;
  /** Every failure: a network error or a bad HTTP status. */
  onError?(e: unknown): void;
}

/** Thrown into `onError` for a non-2xx answer; `status` drives the stop rule. */
export class SseHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`event stream request failed: HTTP ${status}`);
    this.name = "SseHttpError";
    this.status = status;
  }
}

/** Seams for tests (and the only way the caller supplies the auth header). */
export interface EventStreamOptions {
  /** Extra request headers — the caller passes `authorization: Bearer …`. */
  headers?: Record<string, string>;
  /** Defaults to the global `fetch`, looked up per call so a test can stub it. */
  fetch?: typeof fetch;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Jitter source in [0, 1). */
  random?: () => number;
}

/** Statuses that end the stream instead of retrying (P8). */
export const SSE_STOP_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);
export const SSE_BACKOFF_MIN_MS = 1000;
export const SSE_BACKOFF_MAX_MS = 10_000;

/** Delay before reconnect attempt number `attempt` (0-based, reset on a good
 *  connection): doubles from 1 s, capped at 10 s, spread ±25 % so a core that
 *  restarts doesn't see every stream come back in the same millisecond. */
export function backoffDelayMs(attempt: number, random: () => number): number {
  const base = Math.min(SSE_BACKOFF_MIN_MS * 2 ** Math.max(0, attempt), SSE_BACKOFF_MAX_MS);
  return Math.round(base * (0.75 + 0.5 * random()));
}

export function openEventStream(
  url: string,
  handlers: EventStreamHandlers,
  opts: EventStreamOptions = {},
): () => void {
  const setTimer = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const random = opts.random ?? Math.random;

  let closed = false;
  let controller: AbortController | null = null;
  let timer: unknown = null;
  /** Failed/ended connections since the last established one. */
  let attempt = 0;
  /** The server's own `retry:` value, once it has sent one (sticks, as in
   *  `EventSource`). */
  let serverRetryMs: number | null = null;
  /** The last SSE `id:` this stream saw; lives outside the per-connect loop so
   *  it survives reconnects (a failed attempt keeps it for the next one). */
  let lastEventId: string | null = null;

  const reportError = (e: unknown): void => {
    try {
      handlers.onError?.(e);
    } catch { /* a throwing error handler must not kill the reader */ }
  };

  const dispatch = (frame: SseFrame): void => {
    if (frame.retry !== undefined) serverRetryMs = frame.retry;
    // Before the control-frame return below: an id-only block must advance the
    // cursor too. `""` is the spec's reset-to-none.
    if (frame.id !== undefined) lastEventId = frame.id === "" ? null : frame.id;
    // `event === ""` is the parser's retry-only control frame, not a message.
    if (frame.event === "") return;
    // The spec never dispatches a block whose data buffer is empty.
    if (frame.data === "") return;
    try {
      if (frame.event === "message") handlers.onMessage?.(frame.data);
      else handlers.events?.[frame.event]?.(frame.data);
    } catch (e) {
      // One bad handler must not tear the stream down; surface it like any
      // other failure and keep reading.
      reportError(e);
    }
  };

  const scheduleReconnect = (): void => {
    if (closed) return;
    const delay = serverRetryMs ?? backoffDelayMs(attempt, random);
    attempt += 1;
    timer = setTimer(() => {
      timer = null;
      void connect();
    }, delay);
  };

  async function connect(): Promise<void> {
    if (closed) return;
    const ctl = new AbortController();
    controller = ctl;
    try {
      const doFetch = opts.fetch ?? fetch;
      const res = await doFetch(url, {
        headers: {
          accept: "text/event-stream",
          ...opts.headers,
          ...(lastEventId !== null ? { "last-event-id": lastEventId } : {}),
        },
        // No `cache:` option on purpose: "no-store" makes the browser add
        // `Cache-Control`/`Pragma` request headers, which the core's CORS
        // preflight (it allows `authorization` and `content-type` only)
        // rejects. The stream route answers `cache-control: no-cache` itself.
        signal: ctl.signal,
      });
      if (closed) return;
      if (!res.ok) {
        // Release the connection; the body (if any) is not a stream.
        void res.body?.cancel().catch(() => {});
        reportError(new SseHttpError(res.status));
        if (SSE_STOP_STATUSES.has(res.status)) {
          closed = true;
          return;
        }
        scheduleReconnect();
        return;
      }
      if (!res.body) throw new Error("event stream response has no body");

      // Established: a later failure starts the backoff from the bottom again.
      attempt = 0;
      const decoder = new TextDecoder();
      const parser = createSseParser();
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (closed) return;
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (closed) return;
          dispatch(frame);
        }
      }
      // Flush a multi-byte sequence the decoder was holding at the end.
      const tail = decoder.decode();
      if (tail !== "") for (const frame of parser.push(tail)) dispatch(frame);
      if (closed) return;
      scheduleReconnect();
    } catch (e) {
      if (closed) return; // our own abort
      reportError(e);
      scheduleReconnect();
    }
  }

  void connect();

  return () => {
    if (closed) return;
    closed = true;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    controller?.abort();
  };
}
