import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Verifies the headless contract of the DI refactor: with NO `native` injected
// (the way the cli-daemon starts the server), non-native routes work but every
// native-host route returns 501 instead of crashing on a missing Electrobun.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-headless-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4467";
const PORT = 4467;

let server: { stop: () => void };
let token: string;

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void }; // headless: no native
  token = API_TOKEN;
});

afterAll(() => server?.stop?.());

const auth = () => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});
const u = (p: string) => `http://127.0.0.1:${PORT}${p}`;

test("non-native routes work headless (/info, /tasks)", async () => {
  expect((await fetch(u("/info"), { headers: auth() })).status).toBe(200);
  expect((await fetch(u("/tasks"), { headers: auth() })).status).toBe(200);
});

test("every native-host route returns 501 when running headless", async () => {
  const cases: Array<[string, RequestInit]> = [
    ["/notifications", { method: "POST", headers: auth(), body: JSON.stringify({ title: "x" }) }],
    ["/open-external", { method: "POST", headers: auth(), body: JSON.stringify({ url: "https://example.com" }) }],
    ["/open-path", { method: "POST", headers: auth(), body: JSON.stringify({ path: "/tmp" }) }],
    ["/projects/pick", { method: "POST", headers: auth(), body: "{}" }],
    ["/refs/pick", { method: "POST", headers: auth(), body: "{}" }],
    ["/updates/status", { method: "GET", headers: auth() }],
    ["/updates/check", { method: "POST", headers: auth() }],
    ["/updates/apply", { method: "POST", headers: auth() }],
    ["/window/focus", { method: "POST", headers: auth() }],
  ];
  for (const [p, init] of cases) {
    const res = await fetch(u(p), init);
    expect({ route: p, status: res.status }).toEqual({ route: p, status: 501 });
  }
});

test("native routes still enforce the token (401 without it)", async () => {
  const res = await fetch(u("/notifications"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "x" }),
  });
  expect(res.status).toBe(401);
});
