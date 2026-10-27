// `openEventStream` against a stubbed `fetch` that returns `ReadableStream`
// bodies, with injected timers so reconnect delays are observable without
// waiting (master-token plan, TT6).
import { describe, expect, test } from "bun:test";
import {
  backoffDelayMs,
  openEventStream,
  SSE_BACKOFF_MAX_MS,
  SSE_BACKOFF_MIN_MS,
  SseHttpError,
} from "./sse-fetch.ts";

const enc = new TextEncoder();

/** A body the test feeds by hand; `end()` is a clean close, `fail()` an error. */
function controlledBody() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => { ctl = c; } });
  return {
    body,
    push: (text: string) => ctl.enqueue(enc.encode(text)),
    pushBytes: (b: Uint8Array) => ctl.enqueue(b),
    end: () => ctl.close(),
    fail: (e: unknown) => ctl.error(e),
  };
}

function streamResponse(body: ReadableStream<Uint8Array>, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

/** Lets pending promise continuations (reads, fetch resolution) run. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function settle(times = 5) { for (let i = 0; i < times; i++) await tick(); }

interface FakeTimers {
  pending: Array<{ fn: () => void; ms: number; cleared: boolean }>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  /** Fire the oldest live timer. */
  fire: () => number;
  live: () => number;
}
function fakeTimers(): FakeTimers {
  const pending: FakeTimers["pending"] = [];
  return {
    pending,
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; pending.push(t); return t; },
    clearTimeout: (h) => { (h as { cleared: boolean }).cleared = true; },
    fire() {
      const t = pending.find((x) => !x.cleared);
      if (!t) throw new Error("no live timer");
      t.cleared = true;
      t.fn();
      return t.ms;
    },
    live: () => pending.filter((x) => !x.cleared).length,
  };
}

interface Call { url: string; init: RequestInit }
function harness(responders: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const timers = fakeTimers();
  let i = 0;
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const r = responders[Math.min(i, responders.length - 1)]!;
    i++;
    return r(call);
  }) as unknown as typeof fetch;
  const opts = {
    fetch: fetchStub,
    headers: { authorization: "Bearer T" },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    random: () => 0.5, // jitter factor exactly 1.0
  };
  return { calls, timers, opts };
}

describe("openEventStream", () => {
  test("sends the auth header and accept, with no token in the URL", async () => {
    const b = controlledBody();
    const h = harness([() => streamResponse(b.body)]);
    const close = openEventStream("http://core/events", {}, h.opts);
    await settle();
    expect(h.calls).toHaveLength(1);
    const headers = h.calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer T");
    expect(headers.accept).toBe("text/event-stream");
    expect(h.calls[0]!.url).toBe("http://core/events");
    close();
  });

  test("routes unnamed frames to onMessage and named frames to events[name]", async () => {
    const b = controlledBody();
    const h = harness([() => streamResponse(b.body)]);
    const messages: string[] = [];
    const named: string[] = [];
    const close = openEventStream(
      "http://core/tasks/t/events",
      { onMessage: (d) => messages.push(d), events: { replay_meta: (d) => named.push(d) } },
      h.opts,
    );
    await settle();
    b.push('event: replay_meta\ndata: {"earliestId":1}\n\n');
    b.push('data: {"id":1}\n\n: keepalive\n\ndata: {"id":2}\n\n');
    await settle();
    expect(named).toEqual(['{"earliestId":1}']);
    expect(messages).toEqual(['{"id":1}', '{"id":2}']);
    close();
  });

  test("handles frames split across chunks and multi-byte characters split mid-sequence", async () => {
    const b = controlledBody();
    const h = harness([() => streamResponse(b.body)]);
    const messages: string[] = [];
    const close = openEventStream("http://core/events", { onMessage: (d) => messages.push(d) }, h.opts);
    await settle();
    const bytes = enc.encode("data: héllo €\n\n");
    // Split inside the two-byte "é" and the three-byte "€".
    const eAcute = bytes.indexOf(0xc3);
    const euro = bytes.indexOf(0xe2);
    b.pushBytes(bytes.slice(0, eAcute + 1));
    b.pushBytes(bytes.slice(eAcute + 1, euro + 1));
    b.pushBytes(bytes.slice(euro + 1));
    await settle();
    expect(messages).toEqual(["héllo €"]);
    close();
  });

  test("does not dispatch a block without data, or a retry-only control frame", async () => {
    const b = controlledBody();
    const h = harness([() => streamResponse(b.body)]);
    const messages: string[] = [];
    const named: string[] = [];
    const close = openEventStream(
      "http://core/events",
      { onMessage: (d) => messages.push(d), events: { x: (d) => named.push(d) } },
      h.opts,
    );
    await settle();
    b.push("event: x\n\nretry: 1234\n\n");
    await settle();
    expect(messages).toEqual([]);
    expect(named).toEqual([]);
    close();
  });

  test("reconnects after a clean end with the jittered backoff, then resets it", async () => {
    const first = controlledBody();
    const second = controlledBody();
    const h = harness([() => streamResponse(first.body), () => streamResponse(second.body)]);
    const messages: string[] = [];
    const close = openEventStream("http://core/events", { onMessage: (d) => messages.push(d) }, h.opts);
    await settle();
    first.push("data: a\n\n");
    first.end();
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.timers.live()).toBe(1);
    expect(h.timers.fire()).toBe(SSE_BACKOFF_MIN_MS);
    await settle();
    expect(h.calls).toHaveLength(2);
    second.push("data: b\n\n");
    await settle();
    expect(messages).toEqual(["a", "b"]);
    close();
  });

  test("backoff doubles across consecutive failures up to the cap, and resets after a good connection", async () => {
    const good = controlledBody();
    const h = harness([
      () => { throw new TypeError("Load failed"); },
      () => { throw new TypeError("Load failed"); },
      () => { throw new TypeError("Load failed"); },
      () => streamResponse(good.body),
      () => { throw new TypeError("Load failed"); },
    ]);
    const errors: unknown[] = [];
    const close = openEventStream("http://core/events", { onError: (e) => errors.push(e) }, h.opts);
    await settle();
    expect(errors).toHaveLength(1);
    expect(h.timers.fire()).toBe(1000);
    await settle();
    expect(h.timers.fire()).toBe(2000);
    await settle();
    expect(h.timers.fire()).toBe(4000);
    await settle();
    expect(h.calls).toHaveLength(4); // the fourth connected
    good.end();
    await settle();
    // Reset by the good connection: back to the bottom of the range.
    expect(h.timers.fire()).toBe(1000);
    await settle();
    expect(errors).toHaveLength(4);
    close();
  });

  test("backoffDelayMs doubles, caps at 10 s and jitters within +-25%", () => {
    expect(backoffDelayMs(0, () => 0.5)).toBe(1000);
    expect(backoffDelayMs(1, () => 0.5)).toBe(2000);
    expect(backoffDelayMs(3, () => 0.5)).toBe(8000);
    expect(backoffDelayMs(4, () => 0.5)).toBe(SSE_BACKOFF_MAX_MS);
    expect(backoffDelayMs(99, () => 0.5)).toBe(SSE_BACKOFF_MAX_MS);
    expect(backoffDelayMs(0, () => 0)).toBe(750);
    expect(backoffDelayMs(0, () => 0.999)).toBeLessThanOrEqual(1250);
  });

  test("honors a retry: value from the stream for the next reconnect", async () => {
    const first = controlledBody();
    const h = harness([() => streamResponse(first.body), () => streamResponse(controlledBody().body)]);
    const close = openEventStream("http://core/events", {}, h.opts);
    await settle();
    first.push("retry: 3500\n\n");
    first.end();
    await settle();
    expect(h.timers.fire()).toBe(3500);
    await settle();
    expect(h.calls).toHaveLength(2);
    close();
  });

  test("honors a retry: value that rode on a dispatched frame", async () => {
    const first = controlledBody();
    const h = harness([() => streamResponse(first.body), () => streamResponse(controlledBody().body)]);
    const messages: string[] = [];
    const close = openEventStream("http://core/events", { onMessage: (d) => messages.push(d) }, h.opts);
    await settle();
    first.push("retry: 777\ndata: hi\n\n");
    first.end();
    await settle();
    expect(messages).toEqual(["hi"]);
    expect(h.timers.fire()).toBe(777);
    close();
  });

  test("reconnects after a network error mid-stream and reports it", async () => {
    const first = controlledBody();
    const h = harness([() => streamResponse(first.body), () => streamResponse(controlledBody().body)]);
    const errors: unknown[] = [];
    const close = openEventStream("http://core/events", { onError: (e) => errors.push(e) }, h.opts);
    await settle();
    first.fail(new TypeError("network down"));
    await settle();
    expect(errors).toHaveLength(1);
    expect(h.timers.fire()).toBe(1000);
    await settle();
    expect(h.calls).toHaveLength(2);
    close();
  });

  test.each([401, 403, 404])("stops for good on HTTP %d (reports it, never reconnects)", async (status) => {
    const h = harness([() => new Response("nope", { status })]);
    const errors: unknown[] = [];
    openEventStream("http://core/events", { onError: (e) => errors.push(e) }, h.opts);
    await settle();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SseHttpError);
    expect((errors[0] as SseHttpError).status).toBe(status);
    expect(h.timers.live()).toBe(0);
    expect(h.calls).toHaveLength(1);
  });

  test("retries on a 5xx (the core restarting) with backoff", async () => {
    const h = harness([
      () => new Response("down", { status: 503 }),
      () => streamResponse(controlledBody().body),
    ]);
    const errors: unknown[] = [];
    const close = openEventStream("http://core/events", { onError: (e) => errors.push(e) }, h.opts);
    await settle();
    expect((errors[0] as SseHttpError).status).toBe(503);
    expect(h.timers.fire()).toBe(1000);
    await settle();
    expect(h.calls).toHaveLength(2);
    close();
  });

  test("close aborts the in-flight request and nothing is delivered or reconnected after", async () => {
    const b = controlledBody();
    const h = harness([() => streamResponse(b.body)]);
    const messages: string[] = [];
    const errors: unknown[] = [];
    const close = openEventStream(
      "http://core/events",
      { onMessage: (d) => messages.push(d), onError: (e) => errors.push(e) },
      h.opts,
    );
    await settle();
    const signal = h.calls[0]!.init.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    close();
    expect(signal.aborted).toBe(true);
    try { b.push("data: late\n\n"); } catch { /* stream already torn down */ }
    await settle();
    expect(messages).toEqual([]);
    expect(errors).toEqual([]); // our own abort is not a failure
    expect(h.timers.live()).toBe(0);
    expect(h.calls).toHaveLength(1);
  });

  test("close during the reconnect wait cancels the pending reconnect", async () => {
    const first = controlledBody();
    const h = harness([() => streamResponse(first.body), () => streamResponse(controlledBody().body)]);
    const close = openEventStream("http://core/events", {}, h.opts);
    await settle();
    first.end();
    await settle();
    expect(h.timers.live()).toBe(1);
    close();
    expect(h.timers.live()).toBe(0);
    await settle();
    expect(h.calls).toHaveLength(1);
  });

  test("a throwing message handler is reported and does not stop the stream", async () => {
    const b = controlledBody();
    const h = harness([() => streamResponse(b.body)]);
    const seen: string[] = [];
    const errors: unknown[] = [];
    const close = openEventStream(
      "http://core/events",
      {
        onMessage: (d) => { seen.push(d); if (d === "boom") throw new Error("handler bug"); },
        onError: (e) => errors.push(e),
      },
      h.opts,
    );
    await settle();
    b.push("data: boom\n\ndata: after\n\n");
    await settle();
    expect(seen).toEqual(["boom", "after"]);
    expect(errors).toHaveLength(1);
    close();
  });
});
