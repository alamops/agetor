import { createSseParser } from "../shared/sse-parse.ts";
import { discoverCore } from "./api-client.ts";

/**
 * Minimal Server-Sent-Events reader over `fetch`. EventSource can't set the
 * Authorization header, so we read the stream by hand: feed the decoded body
 * through the shared frame parser (`createSseParser`, the same one the webview
 * uses), JSON-decode each unnamed (`message`) frame, skip `{type:"ping"}`
 * keepalives, and reconnect with full-jitter backoff — re-discovering the core
 * each attempt so the stream follows an app⇄daemon handoff or a relaunched core
 * whose token rotated.
 *
 * The token travels in an `authorization: Bearer` header, never in the URL
 * (D13): a query-string token lands in access logs and proxies' request lines.
 * `retry:` hints are ignored — the CLI keeps its own backoff. Named events are
 * skipped unless the caller asks for them with `opts.onNamedEvent` (the task
 * stream's `replay_meta`); the payload stream is unnamed JSON `data:` frames.
 *
 * Forward resume: the last SSE `id:` seen is kept across reconnect attempts and
 * echoed as `last-event-id`, so a stream whose server tags frames with ids
 * (`/tasks/:id/events`) picks up where it left off. Streams that never send an
 * id (`/events`, `/app/events`, clone progress) never send the header. An empty
 * `id:` resets it, per the SSE spec.
 */
export interface SseHandle {
  close(): void;
}

export interface SseOptions {
  dataDir?: string;
  onOpen?: () => void;
  onReconnect?: (attempt: number) => void;
  onError?: (err: unknown) => void;
  /** Called for every named (non-`message`) frame with its type and raw data,
   *  e.g. `replay_meta`. Never called for the parser's control-only frames. */
  onNamedEvent?: (event: string, data: string) => void;
}

export function streamSse<T>(
  pathname: string,
  onEvent: (e: T) => void,
  opts: SseOptions = {},
): SseHandle {
  let closed = false;
  const ac = new AbortController();
  // Survives reconnects (the parser, which is per-connection, does not).
  let lastEventId = "";

  async function loop() {
    let attempt = 0;
    while (!closed) {
      const core = await discoverCore(opts.dataDir);
      if (core) {
        const url = `http://127.0.0.1:${core.port}${pathname}`;
        try {
          const res = await fetch(url, {
            signal: ac.signal,
            headers: {
              accept: "text/event-stream",
              authorization: `Bearer ${core.token}`,
              ...(lastEventId ? { "last-event-id": lastEventId } : {}),
            },
          });
          if (!res.ok || !res.body) throw new Error(`SSE ${pathname} → ${res.status}`);
          opts.onOpen?.();
          attempt = 0;
          await pump(res.body, onEvent, opts.onNamedEvent, (id) => {
            lastEventId = id;
          });
          // Stream ended cleanly (server closed / core swapped) → reconnect.
        } catch (err) {
          if (closed) return;
          opts.onError?.(err);
        }
      }
      if (closed) return;
      attempt++;
      opts.onReconnect?.(attempt);
      await backoff(attempt, ac.signal);
    }
  }

  void loop();
  return {
    close() {
      closed = true;
      ac.abort();
    },
  };
}

async function pump<T>(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: T) => void,
  onNamedEvent: SseOptions["onNamedEvent"],
  onId: (id: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const parser = createSseParser();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    for (const frame of parser.push(dec.decode(value, { stream: true }))) {
      // Track the id before routing: a control frame (`event: ""`) can carry
      // one, and `""` resets it.
      if (frame.id !== undefined) onId(frame.id);
      // Only unnamed frames carry payloads; a named event goes to the opt-in
      // hook and the parser's control frame (`event: ""`) is not for us.
      if (frame.event !== "message") {
        if (frame.event !== "") onNamedEvent?.(frame.event, frame.data);
        continue;
      }
      const payload = frame.data.trim();
      if (!payload) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as { type?: string }).type === "ping"
      ) {
        continue;
      }
      onEvent(parsed as T);
    }
  }
}

async function backoff(attempt: number, signal: AbortSignal): Promise<void> {
  // Full-jitter exponential: base 250ms, doubling, capped at 5s. Jitter avoids
  // a reconnect storm when a daemon bounce drops many streams at once.
  const cap = Math.min(5000, 250 * 2 ** Math.min(attempt, 5));
  await sleep(Math.floor(Math.random() * cap), signal);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
