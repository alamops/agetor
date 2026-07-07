import { discoverCore } from "./api-client.ts";

/**
 * Minimal Server-Sent-Events reader over `fetch`. EventSource can't set the
 * Authorization header, and the API authenticates SSE via `?token=`, so we read
 * the stream by hand: parse `data: …\n\n` frames, JSON-decode each, skip
 * `{type:"ping"}` keepalives, and reconnect with full-jitter backoff —
 * re-discovering the core each attempt so the stream follows an app⇄daemon
 * handoff or a relaunched core whose token rotated.
 */
export interface SseHandle {
  close(): void;
}

export interface SseOptions {
  dataDir?: string;
  onOpen?: () => void;
  onReconnect?: (attempt: number) => void;
  onError?: (err: unknown) => void;
}

export function streamSse<T>(
  pathname: string,
  onEvent: (e: T) => void,
  opts: SseOptions = {},
): SseHandle {
  let closed = false;
  const ac = new AbortController();

  async function loop() {
    let attempt = 0;
    while (!closed) {
      const core = await discoverCore(opts.dataDir);
      if (core) {
        const sep = pathname.includes("?") ? "&" : "?";
        const url = `http://127.0.0.1:${core.port}${pathname}${sep}token=${core.token}`;
        try {
          const res = await fetch(url, {
            signal: ac.signal,
            headers: { accept: "text/event-stream" },
          });
          if (!res.ok || !res.body) throw new Error(`SSE ${pathname} → ${res.status}`);
          opts.onOpen?.();
          attempt = 0;
          await pump(res.body, onEvent);
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
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
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
