import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SavedPrompt } from "../shared/types.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-saved-prompts-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT.
process.env.AGETOR_API_PORT = "4451";

const BASE = "http://127.0.0.1:4451";

let server: { stop: () => void };
let token: string;
let db: typeof import("./db.ts").db;

beforeAll(async () => {
  ({ db } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

beforeEach(() => {
  db.run(`DELETE FROM saved_prompts`);
});

const call = (p: string, init: RequestInit = {}) =>
  fetch(`${BASE}${p}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

const callNoAuth = (p: string, init: RequestInit = {}) =>
  fetch(`${BASE}${p}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

test("GET /saved-prompts on an empty table returns []", async () => {
  const res = await call("/saved-prompts");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);
});

test("POST /saved-prompts happy path creates and returns the prompt", async () => {
  const res = await call("/saved-prompts", {
    method: "POST",
    body: JSON.stringify({ name: "Greeting", content: "Say hello" }),
  });
  expect(res.status).toBe(200);
  const created = (await res.json()) as SavedPrompt;
  expect(created.name).toBe("Greeting");
  expect(created.content).toBe("Say hello");
  expect(typeof created.id).toBe("string");

  const list = await (await call("/saved-prompts")).json();
  expect(list).toEqual([created]);
});

test("POST /saved-prompts trims name and content", async () => {
  const res = await call("/saved-prompts", {
    method: "POST",
    body: JSON.stringify({ name: "  Padded  ", content: "  padded content  " }),
  });
  expect(res.status).toBe(200);
  const created = (await res.json()) as SavedPrompt;
  expect(created.name).toBe("Padded");
  expect(created.content).toBe("padded content");
});

test.each([
  ["missing name", { content: "has content" }],
  ["blank name", { name: "", content: "has content" }],
  ["whitespace-only name", { name: "   ", content: "has content" }],
])("POST /saved-prompts with %s → 400", async (_label, body) => {
  const res = await call("/saved-prompts", { method: "POST", body: JSON.stringify(body) });
  expect(res.status).toBe(400);
  const parsed = (await res.json()) as { error: string };
  expect(parsed.error).toBeTruthy();
});

test.each([
  ["missing content", { name: "Has name" }],
  ["blank content", { name: "Has name", content: "" }],
  ["whitespace-only content", { name: "Has name", content: "   " }],
])("POST /saved-prompts with %s → 400", async (_label, body) => {
  const res = await call("/saved-prompts", { method: "POST", body: JSON.stringify(body) });
  expect(res.status).toBe(400);
  const parsed = (await res.json()) as { error: string };
  expect(parsed.error).toBeTruthy();
});

test.each([
  ["null", "null"],
  ["array", "[]"],
  ["string", '"x"'],
])("POST /saved-prompts with a non-object JSON body (%s) → 400, not 500", async (_label, raw) => {
  const res = await call("/saved-prompts", { method: "POST", body: raw });
  expect(res.status).toBe(400);
  const parsed = (await res.json()) as { error: string };
  expect(parsed.error).toBeTruthy();
});

test("PATCH /saved-prompts/:id updates name only", async () => {
  const created = (await (
    await call("/saved-prompts", {
      method: "POST",
      body: JSON.stringify({ name: "Before", content: "unchanged" }),
    })
  ).json()) as SavedPrompt;

  const res = await call(`/saved-prompts/${created.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "After" }),
  });
  expect(res.status).toBe(200);
  const updated = (await res.json()) as SavedPrompt;
  expect(updated.name).toBe("After");
  expect(updated.content).toBe("unchanged");
});

test("PATCH /saved-prompts/:id updates content only", async () => {
  const created = (await (
    await call("/saved-prompts", {
      method: "POST",
      body: JSON.stringify({ name: "Stays", content: "before content" }),
    })
  ).json()) as SavedPrompt;

  const res = await call(`/saved-prompts/${created.id}`, {
    method: "PATCH",
    body: JSON.stringify({ content: "after content" }),
  });
  expect(res.status).toBe(200);
  const updated = (await res.json()) as SavedPrompt;
  expect(updated.name).toBe("Stays");
  expect(updated.content).toBe("after content");
});

test.each([
  ["blank name", { name: "   " }],
  ["blank content", { content: "   " }],
])("PATCH /saved-prompts/:id with %s → 400 and leaves the row untouched", async (_label, patch) => {
  const created = (await (
    await call("/saved-prompts", {
      method: "POST",
      body: JSON.stringify({ name: "Keep", content: "keep content" }),
    })
  ).json()) as SavedPrompt;

  const res = await call(`/saved-prompts/${created.id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  expect(res.status).toBe(400);
  const parsed = (await res.json()) as { error: string };
  expect(parsed.error).toBeTruthy();

  const stillThere = (await (await call(`/saved-prompts`)).json()) as SavedPrompt[];
  const row = stillThere.find((p) => p.id === created.id)!;
  expect(row.name).toBe("Keep");
  expect(row.content).toBe("keep content");
});

test("PATCH /saved-prompts/:id on an unknown id → 404", async () => {
  const res = await call("/saved-prompts/does-not-exist", {
    method: "PATCH",
    body: JSON.stringify({ name: "x" }),
  });
  expect(res.status).toBe(404);
  const parsed = (await res.json()) as { error: string };
  expect(parsed.error).toBeTruthy();
});

test.each([
  ["null", "null"],
  ["array", "[]"],
  ["string", '"x"'],
])("PATCH /saved-prompts/:id with a non-object JSON body (%s) → not 500", async (_label, raw) => {
  // No fields present in the normalized-to-{} body → patch is a no-op, so
  // this exercises the "unknown id" 404 path rather than a 400; either way
  // it must not be a 500.
  const res = await call("/saved-prompts/does-not-exist", { method: "PATCH", body: raw });
  expect(res.status).not.toBe(500);
  expect([400, 404]).toContain(res.status);
});

test("PATCH /saved-prompts/:id with a non-object JSON body on a real id is a no-op 200", async () => {
  const created = (await (
    await call("/saved-prompts", {
      method: "POST",
      body: JSON.stringify({ name: "Untouched", content: "untouched content" }),
    })
  ).json()) as SavedPrompt;

  const res = await call(`/saved-prompts/${created.id}`, { method: "PATCH", body: "null" });
  expect(res.status).toBe(200);
  const updated = (await res.json()) as SavedPrompt;
  expect(updated.name).toBe("Untouched");
  expect(updated.content).toBe("untouched content");
});

test("DELETE /saved-prompts/:id happy path returns { ok: true } and the list omits it", async () => {
  const created = (await (
    await call("/saved-prompts", {
      method: "POST",
      body: JSON.stringify({ name: "Doomed", content: "doomed content" }),
    })
  ).json()) as SavedPrompt;

  const res = await call(`/saved-prompts/${created.id}`, { method: "DELETE" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });

  const list = (await (await call("/saved-prompts")).json()) as SavedPrompt[];
  expect(list.find((p) => p.id === created.id)).toBeUndefined();
});

test("DELETE /saved-prompts/:id on an unknown id → 404", async () => {
  const res = await call("/saved-prompts/does-not-exist", { method: "DELETE" });
  expect(res.status).toBe(404);
  const parsed = (await res.json()) as { error: string };
  expect(parsed.error).toBeTruthy();
});

test.each([
  ["GET /saved-prompts", "/saved-prompts", "GET"],
  ["POST /saved-prompts", "/saved-prompts", "POST"],
  ["PATCH /saved-prompts/:id", "/saved-prompts/some-id", "PATCH"],
  ["DELETE /saved-prompts/:id", "/saved-prompts/some-id", "DELETE"],
])("%s without a bearer token → 401", async (_label, p, method) => {
  const res = await callNoAuth(p, { method });
  expect(res.status).toBe(401);
});
