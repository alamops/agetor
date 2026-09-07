import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.ts captures AGETOR_DATA_DIR at first import — set at the top level
// before any import of ./db.ts or ./server.ts (same convention as
// db-events-paging.test.ts / notifications.test.ts).
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-sse-initial-frame-"));
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT.
process.env.AGETOR_API_PORT = "4522";

let server: { stop: () => void; port: number };
let token: string;

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void; port: number };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

const BASE = () => `http://127.0.0.1:${server.port}`;

/** Reads the FIRST chunk of bytes off an SSE response body, racing a
 *  `timeoutMs` deadline so a route that never writes anything (the bug this
 *  file guards against) fails the test instead of hanging it. Returns the
 *  decoded text of that first chunk, or `null` if nothing arrived in time. */
async function readFirstChunk(url: string, timeoutMs: number): Promise<string | null> {
  const ctrl = new AbortController();
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    try {
      const r = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), timeoutMs)),
      ]);
      if (r.done || !r.value) return null;
      return new TextDecoder().decode(r.value);
    } finally {
      await reader.cancel().catch(() => {});
    }
  } finally {
    ctrl.abort();
  }
}

test("GET /events flushes an initial ': connected' comment frame immediately, before any real event or the 15s ping", async () => {
  const chunk = await readFirstChunk(`${BASE()}/events?token=${token}`, 2000);
  expect(chunk).not.toBeNull();
  expect(chunk).toStartWith(": connected");
});

test("GET /app/events flushes an initial ': connected' comment frame immediately, before any real event or the 15s ping", async () => {
  const chunk = await readFirstChunk(`${BASE()}/app/events?token=${token}`, 2000);
  expect(chunk).not.toBeNull();
  expect(chunk).toStartWith(": connected");
});
