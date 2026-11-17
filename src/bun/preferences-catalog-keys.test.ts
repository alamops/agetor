import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Top-level, before any db.ts/server.ts import (db.ts captures the data dir at
// first import). Unique port, distinct from every other *.test.ts file's.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-preferences-catalog-keys-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "5311";

let server: { stop: () => void };
let appToken: string;
let cliToken: string;
let preferences: typeof import("./db.ts").preferences;
const url = (p: string) => `http://127.0.0.1:5311${p}`;
const put = (key: string, token: string, value = "x") =>
  fetch(url(`/preferences/${encodeURIComponent(key)}`), {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });

beforeAll(async () => {
  ({ preferences } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  ({ CLI_TOKEN: cliToken } = await import("./api-config.ts"));
  server = startApiServer() as unknown as { stop: () => void };
  appToken = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

test("GET /preferences omits every modelCatalog:* key but lists the others", async () => {
  preferences.set("modelCatalog:kind:claude-code", "{\"v\":1}");
  preferences.set("modelCatalog:harness:codex", "{\"v\":1}");
  preferences.set("lastModel:codex", "gpt-6");
  const res = await fetch(url("/preferences"), { headers: { authorization: `Bearer ${appToken}` } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, string>;
  expect(Object.keys(body).filter((k) => k.startsWith("modelCatalog:"))).toEqual([]);
  expect(body["lastModel:codex"]).toBe("gpt-6");
  // The rows exist; they are just not exposed.
  expect(preferences.get("modelCatalog:kind:claude-code")).not.toBeNull();
});

test("PUT /preferences/modelCatalog:* is refused for the app and the CLI token, and nothing is stored", async () => {
  for (const [name, token] of [["app", () => appToken], ["cli", () => cliToken]] as const) {
    const key = `modelCatalog:kind:planted-by-${name}`;
    const res = await put(key, token());
    expect(res.status, name).toBe(403);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe("server-managed");
    expect(preferences.get(key), name).toBeNull();
  }
});

test("other preference keys are unaffected for both callers", async () => {
  expect((await put("lastModel:gemini", appToken, "a")).status).toBe(204);
  expect((await put("lastEffort:gemini", cliToken, "b")).status).toBe(204);
  expect(preferences.get("lastModel:gemini")).toBe("a");
  expect(preferences.get("lastEffort:gemini")).toBe("b");
});
