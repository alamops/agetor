import { test, expect, beforeAll, afterAll, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-open-external-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Distinct from other server-test ports so parallel test runs don't fight.
process.env.AGETOR_API_PORT = "4423";

// Stub electrobun's native bridge before server.ts imports it — otherwise
// `Utils.openExternal` would actually pop a browser tab during the test run.
// Same approach as notifications.test.ts. The recorded array lets each test
// assert what the route ultimately handed to the OS.
const opened: string[] = [];
mock.module("electrobun/bun", () => ({
  Utils: {
    openExternal: (url: string) => {
      opened.push(url);
      return true;
    },
    openPath: () => true,
    openFileDialog: async () => [],
    showNotification: () => { /* noop */ },
  },
  BrowserWindow: class { /* unused */ },
  ApplicationMenu: { setApplicationMenu: () => { /* noop */ } },
  Updater: { /* noop */ },
}));

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

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch("http://127.0.0.1:4423/open-external", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

test("requires a token", async () => {
  const res = await fetch("http://127.0.0.1:4423/open-external", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com" }),
  });
  expect(res.status).toBe(401);
});

test("rejects missing url", async () => {
  opened.length = 0;
  const res = await post({});
  expect(res.status).toBe(400);
  expect(opened).toEqual([]);
});

test("rejects empty / whitespace url", async () => {
  opened.length = 0;
  const res = await post({ url: "   " });
  expect(res.status).toBe(400);
  expect(opened).toEqual([]);
});

test("rejects javascript: scheme", async () => {
  opened.length = 0;
  const res = await post({ url: "javascript:alert(1)" });
  expect(res.status).toBe(400);
  expect(opened).toEqual([]);
});

test("rejects file: scheme", async () => {
  opened.length = 0;
  const res = await post({ url: "file:///etc/passwd" });
  expect(res.status).toBe(400);
  expect(opened).toEqual([]);
});

test("rejects data: scheme", async () => {
  opened.length = 0;
  const res = await post({ url: "data:text/html,<script>alert(1)</script>" });
  expect(res.status).toBe(400);
  expect(opened).toEqual([]);
});

test("rejects custom scheme", async () => {
  opened.length = 0;
  const res = await post({ url: "vscode://open?file=/tmp/x" });
  expect(res.status).toBe(400);
  expect(opened).toEqual([]);
});

test("opens http URL", async () => {
  opened.length = 0;
  const res = await post({ url: "http://example.com/x" });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ opened: true, url: "http://example.com/x" });
  expect(opened).toEqual(["http://example.com/x"]);
});

test("opens https URL", async () => {
  opened.length = 0;
  const res = await post({ url: "https://example.com/y" });
  expect(res.status).toBe(200);
  expect(opened).toEqual(["https://example.com/y"]);
});

test("opens mailto URL", async () => {
  opened.length = 0;
  const res = await post({ url: "mailto:foo@example.com" });
  expect(res.status).toBe(200);
  expect(opened).toEqual(["mailto:foo@example.com"]);
});

test("error body does not echo the raw URL", async () => {
  // Server-side log-injection hygiene: even though the route is authed and
  // the response is JSON, keep user-supplied URL strings out of the reflected
  // error message in case downstream logging picks the body up unsanitized.
  const res = await post({ url: "javascript:NEEDLE_TOKEN_xyz" });
  const body = await res.text();
  expect(body).not.toContain("NEEDLE_TOKEN_xyz");
});
