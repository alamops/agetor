import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCoreCreds } from "../bun/core-creds.ts";
import { streamSse, type SseHandle } from "./sse.ts";

/**
 * `streamSse` against a local stub core: `discoverCore` reads the creds file,
 * checks the pid, `/health` and an authed `/info`, then the SSE route is served
 * by the same stub. The stub records the request it saw on the stream route.
 */
const TOKEN = "t0k3n-for-sse-test";

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let handle: SseHandle | null = null;
let seen: { url: string; authorization: string | null; accept: string | null }[];
let body: string[];

function startStub() {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ app: "agetor" });
      if (url.pathname === "/info") {
        return req.headers.get("authorization") === `Bearer ${TOKEN}`
          ? Response.json({})
          : new Response("no", { status: 401 });
      }
      seen.push({
        url: req.url,
        authorization: req.headers.get("authorization"),
        accept: req.headers.get("accept"),
      });
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const c of body) controller.enqueue(enc.encode(c));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  writeCoreCreds(
    {
      port: server.port as number,
      token: TOKEN,
      pid: process.pid,
      kind: "cli-daemon",
      version: "test",
      startedAt: Date.now(),
    },
    dir,
  );
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "agetor-sse-"));
  seen = [];
  body = [];
});

afterEach(() => {
  handle?.close();
  handle = null;
  server?.stop(true);
});

/** Resolve once `n` events arrived (or fail after a bounded wait). */
function collect<T>(n: number, pathname: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const got: T[] = [];
    const timer = setTimeout(
      () => reject(new Error(`timed out with ${JSON.stringify(got)}`)),
      5000,
    );
    handle = streamSse<T>(
      pathname,
      (e) => {
        got.push(e);
        if (got.length >= n) {
          clearTimeout(timer);
          resolve(got);
        }
      },
      { dataDir: dir },
    );
  });
}

test("sends the token in an Authorization header, never in the URL", async () => {
  body = ['data: {"n":1}\n\n'];
  startStub();
  await collect<{ n: number }>(1, "/app/events");
  expect(seen.length).toBeGreaterThanOrEqual(1);
  const req = seen[0]!;
  expect(req.authorization).toBe(`Bearer ${TOKEN}`);
  expect(req.accept).toBe("text/event-stream");
  expect(req.url).not.toContain("token=");
  expect(req.url).not.toContain(TOKEN);
});

test("keeps an existing query string untouched and adds no token", async () => {
  body = ['data: {"n":1}\n\n'];
  startStub();
  await collect(1, "/tasks/abc/events?anchor=0");
  const url = new URL(seen[0]!.url);
  expect(url.pathname).toBe("/tasks/abc/events");
  expect(url.search).toBe("?anchor=0");
});

test("drops pings, comments and named events; delivers message frames", async () => {
  body = [
    ": keepalive\n\n",
    'data: {"type":"ping"}\n\n',
    'event: task\ndata: {"named":true}\n\n',
    'retry: 100\n\n',
    'data: {"n":1}\n\n',
    "data: not json\n\n",
    'data: {"n":2}\n\n',
  ];
  startStub();
  const got = await collect<{ n: number }>(2, "/events");
  expect(got).toEqual([{ n: 1 }, { n: 2 }]);
});

test("reassembles frames and CRLF endings split across chunks", async () => {
  body = ['da', 'ta: {"n"', ':1}\r', '\n\r', '\ndata: {"n":2}\r\n\r\n'];
  startStub();
  const got = await collect<{ n: number }>(2, "/events");
  expect(got).toEqual([{ n: 1 }, { n: 2 }]);
});

test("joins multi-line data before decoding JSON", async () => {
  body = ['data: {"a":\ndata: 1}\n\n'];
  startStub();
  const got = await collect<{ a: number }>(1, "/events");
  expect(got).toEqual([{ a: 1 }]);
});
