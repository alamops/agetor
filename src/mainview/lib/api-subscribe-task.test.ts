// `api.subscribeTask` against a stubbed `fetch`: the `replay_meta` frame is
// shape-checked through `parseReplayMeta` before it reaches the panel (a
// malformed one is dropped, never cast), the resume hints ride through, row
// frames keep their server `id`, and pings never reach `onEvent`
// (docs/plans/event-stream-forward-resume.md T7).
import { afterEach, describe, expect, test } from "bun:test";
import { api } from "./api.ts";
import type { RunEvent, TaskEventsReplayMeta } from "../../shared/types.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const enc = new TextEncoder();

/** Serve one SSE body (kept open, so no reconnect fires during the test) and
 *  record each request's headers. */
function serve(sse: string): Array<Record<string, string>> {
  const requests: Array<Record<string, string>> = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    requests.push({ ...((init?.headers as Record<string, string>) ?? {}) });
    const body = new ReadableStream<Uint8Array>({
      start: (c) => c.enqueue(enc.encode(sse)),
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return requests;
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const meta = (m: unknown) => `event: replay_meta\ndata: ${typeof m === "string" ? m : JSON.stringify(m)}\n\n`;
const row = (e: RunEvent) => `id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`;

describe("api.subscribeTask", () => {
  test("passes a resume meta through with its hint, and row frames with their server id", async () => {
    const r1: RunEvent = { id: 41, runId: "r", taskId: "t", stream: "assistant", data: "a", ts: 1 };
    const r2: RunEvent = { id: 42, runId: "r", taskId: "t", stream: "status", data: "b", ts: 2 };
    serve(meta({ earliestId: null, hasMore: false, resumedAfter: 40 }) + row(r1) + `data: {"type":"ping"}\n\n` + row(r2));
    const metas: TaskEventsReplayMeta[] = [];
    const events: RunEvent[] = [];
    const close = api.subscribeTask("t", (e) => events.push(e), (m) => metas.push(m));
    await settle();
    close();
    expect(metas).toEqual([{ earliestId: null, hasMore: false, resumedAfter: 40 }]);
    expect(events).toEqual([r1, r2]);
  });

  test("passes a snapshot meta through with the fresh window's earliestId / hasMore", async () => {
    serve(meta({ earliestId: 7, hasMore: true, snapshotRequired: true }));
    const metas: TaskEventsReplayMeta[] = [];
    const close = api.subscribeTask("t", () => {}, (m) => metas.push(m));
    await settle();
    close();
    expect(metas).toEqual([{ earliestId: 7, hasMore: true, snapshotRequired: true }]);
  });

  test("drops a malformed meta (bad JSON or wrong shape) and keeps streaming rows", async () => {
    const r1: RunEvent = { id: 5, runId: "r", taskId: "t", stream: "assistant", data: "still here", ts: 1 };
    serve(
      meta("{not json")
        + meta({ earliestId: "3", hasMore: false })
        + meta({ earliestId: null })
        + meta([1, 2])
        + row(r1),
    );
    const metas: TaskEventsReplayMeta[] = [];
    const events: RunEvent[] = [];
    const close = api.subscribeTask("t", (e) => events.push(e), (m) => metas.push(m));
    await settle();
    close();
    expect(metas).toEqual([]);
    expect(events).toEqual([r1]);
  });

  test("a wrong-typed hint is dropped, not the whole meta (it then reads as a fresh connect)", async () => {
    serve(meta({ earliestId: 3, hasMore: false, resumedAfter: "40", snapshotRequired: "yes" }));
    const metas: TaskEventsReplayMeta[] = [];
    const close = api.subscribeTask("t", () => {}, (m) => metas.push(m));
    await settle();
    close();
    expect(metas).toEqual([{ earliestId: 3, hasMore: false }]);
  });

  test("the first connect sends no last-event-id", async () => {
    const requests = serve(meta({ earliestId: null, hasMore: false }));
    const close = api.subscribeTask("t", () => {}, () => {});
    await settle();
    close();
    expect(requests).toHaveLength(1);
    expect(requests[0]!["last-event-id"]).toBeUndefined();
  });
});
