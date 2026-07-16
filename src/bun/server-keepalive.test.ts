import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

// Regression test for the "cannot reach agetor API" WKWebView bug: Bun.serve
// defaults `idleTimeout` to 10s, which was killing pooled keep-alive sockets
// (and any handler that legitimately took >10s to respond) before the fix in
// src/bun/server.ts set `idleTimeout: 255`. We hold a raw TCP connection idle
// for just over 10s and prove the *same* socket is still usable afterwards —
// a plain `fetch` wouldn't deterministically prove connection reuse, since
// Bun/undici's client pool could silently open a fresh socket for the second
// request even if the first one had been dropped.

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-server-keepalive-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT.
process.env.AGETOR_API_PORT = "4472";

const PORT = 4472;

let server: { stop: () => void };
let token: string;

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

/** Parsed result of reading one HTTP/1.1 response off a raw socket. */
type HttpResponse = { status: number; headers: Record<string, string>; body: string };

/**
 * Reads exactly one HTTP/1.1 response from `socket`, using the `Content-Length`
 * header to know when the body is complete (every route in this server
 * returns a `json()` response, which Bun always emits with a fixed
 * `Content-Length` rather than chunked transfer-encoding). Any bytes read
 * past the end of this response are returned as `leftover` so callers that
 * reuse the same socket for a second request don't lose them.
 */
function readHttpResponse(
  socket: net.Socket,
  seed = "",
): Promise<HttpResponse & { leftover: string }> {
  return new Promise((resolve, reject) => {
    let buf = seed;

    const onData = (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const headerBlock = buf.slice(0, headerEnd);
      const [statusLine, ...headerLines] = headerBlock.split("\r\n");
      const statusMatch = /^HTTP\/1\.1\s+(\d+)/.exec(statusLine ?? "");
      if (!statusMatch) {
        cleanup();
        reject(new Error(`malformed status line: ${statusLine}`));
        return;
      }
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }

      const contentLength = Number(headers["content-length"] ?? "0");
      const bodyStart = headerEnd + 4;
      const haveBody = buf.length - bodyStart;
      if (haveBody < contentLength) return; // wait for more data

      const body = buf.slice(bodyStart, bodyStart + contentLength);
      const leftover = buf.slice(bodyStart + contentLength);
      cleanup();
      resolve({ status: Number(statusMatch[1]), headers, body, leftover });
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before a full response was read"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

function connect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: PORT }, () => resolve(socket));
    socket.once("error", reject);
  });
}

function buildRequest(path: string, token: string): string {
  return (
    `GET ${path} HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${PORT}\r\n` +
    `Authorization: Bearer ${token}\r\n` +
    `Connection: keep-alive\r\n` +
    `\r\n`
  );
}

test(
  "an idle-for-11s keep-alive socket survives and serves a second request (idleTimeout: 255 regression)",
  async () => {
    const socket = await connect();
    try {
      socket.write(buildRequest("/tasks", token));
      const first = await readHttpResponse(socket);
      expect(first.status).toBe(200);

      // Bun's default idleTimeout is 10s; wait just past it with no traffic
      // on the socket at all. Under the old default the server would have
      // torn down this connection during the wait.
      await new Promise((r) => setTimeout(r, 11_000));

      socket.write(buildRequest("/tasks", token));
      const second = await readHttpResponse(socket, first.leftover);
      expect(second.status).toBe(200);
      expect(socket.destroyed).toBe(false);
    } finally {
      socket.destroy();
    }
  },
  20_000,
);

test(
  "/health still responds normally while the idle-keepalive test's socket sits open",
  async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  },
  20_000,
);
