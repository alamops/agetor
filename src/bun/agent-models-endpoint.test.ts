import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Top-level, before any db.ts/server.ts import: db.ts captures
// AGETOR_DATA_DIR at first import (same convention as
// fx-permissions-endpoint.test.ts / approvals-endpoint.test.ts). A dedicated
// port avoids colliding with any other test file's server in the same
// `bun test` run.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-agent-models-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4571";

let server: { stop: () => void } | null = null;
let token: string;
let harnesses: typeof import("./db.ts").harnesses;
const url = (p: string) => `http://127.0.0.1:4571${p}`;

beforeAll(async () => {
  ({ harnesses } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
  // `bun test` runs every *.test.ts file in one process (see db.ts's own
  // comment on this), so a harness left behind here would otherwise leak
  // into any sibling test file's own harness-count/discovery assertions in
  // a full-suite run (e.g. model-discovery.test.ts's broadcast tests).
  try {
    harnesses.delete("fx-endpoint-test");
  } catch {
    /* best effort */
  }
});

test("GET /agent-models still returns the byte-compatible kind-keyed map, with an 'fx' array key (fx-permissions-endpoint.test.ts / manage.test.ts pin this shape)", async () => {
  const res = await fetch(url("/agent-models"), {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body["claude-code"])).toBe(true);
  expect(Array.isArray(body["codex"])).toBe(true);
  expect(Array.isArray(body["cursor"])).toBe(true);
  expect(Array.isArray(body["gemini"])).toBe(true);
  expect(Array.isArray(body["fx"])).toBe(true);
});

test("GET /agent-models — unauthenticated request is rejected", async () => {
  const res = await fetch(url("/agent-models"));
  expect(res.status).toBe(401);
});

test("GET /agent-models/harnesses returns { ready: boolean, byHarness } with a key for the built-in (enabled-by-default) claude-code harness", async () => {
  const res = await fetch(url("/agent-models/harnesses"), {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(typeof body.ready).toBe("boolean");
  expect(typeof body.byHarness).toBe("object");
  // claude-code ships enabled by default (unlike codex/cursor/gemini/fx,
  // which seed disabled — see migrations 016/032/037/046), so it's always
  // present regardless of what the test DB's other harnesses look like.
  expect(Array.isArray(body.byHarness["claude-code"])).toBe(true);
  // A disabled built-in must not appear.
  expect(body.byHarness["codex"]).toBeUndefined();
});

test("GET /agent-models/harnesses — unauthenticated request is rejected", async () => {
  const res = await fetch(url("/agent-models/harnesses"));
  expect(res.status).toBe(401);
});

test("POST /agent-models still returns the byte-compatible kind-keyed map", async () => {
  const res = await fetch(url("/agent-models"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body["claude-code"])).toBe(true);
  expect(Array.isArray(body["fx"])).toBe(true);
});

test("POST /agent-models?harness=fx refreshes just that harness and still returns the kind-keyed map at 200", async () => {
  const res = await fetch(url("/agent-models?harness=fx"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body["fx"])).toBe(true);
});

test("POST /agent-models?harness=<unknown-id> falls back to a full sweep rather than erroring", async () => {
  const res = await fetch(url("/agent-models?harness=does-not-exist"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body["claude-code"])).toBe(true);
});

test("POST /agent-models — unauthenticated request is rejected", async () => {
  const res = await fetch(url("/agent-models"), { method: "POST" });
  expect(res.status).toBe(401);
});

test("POST /harnesses (create a new fx alias) is reflected in GET /agent-models/harnesses once discovery settles", async () => {
  const createRes = await fetch(url("/harnesses"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "fx-endpoint-test", kind: "fx", label: "fx (endpoint test)" }),
  });
  expect(createRes.status).toBe(200);

  const res = await fetch(url("/agent-models/harnesses"), {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  // Newly created harnesses default to enabled, so it must appear in the
  // per-harness map immediately (independent of whether its background
  // discovery probe — triggered fire-and-forget by the create route — has
  // resolved yet: an unresolved probe just means an empty array here).
  expect(Array.isArray(body.byHarness["fx-endpoint-test"])).toBe(true);
});
