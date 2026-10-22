// Route tests for the per-harness "load profile MCP servers" toggle
// (`Harness.profileMcpServers`, migration 073, docs/plans/
// fx-0.0.14-and-cursor-updates.md D3/D4): `POST /harnesses` and `PATCH
// /harnesses/:id` accept a boolean, 400 on anything else, persist it, and —
// like `enabled` — the toggle is allowed on a built-in row. Absent ⇒ on.
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Harness } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-harness-profile-mcp-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT.
process.env.AGETOR_API_PORT = "4734";

const BASE = "http://127.0.0.1:4734";
const ERROR = "profileMcpServers must be a boolean";

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
  rmTestDataDir(DATA_DIR);
});

beforeEach(() => {
  db.run(`DELETE FROM harnesses WHERE is_builtin = 0`);
  db.run(`UPDATE harnesses SET profile_mcp_servers = 1`);
});

const call = (p: string, init: RequestInit = {}) =>
  fetch(`${BASE}${p}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });

const createRaw = (overrides: Record<string, unknown> = {}) =>
  call("/harnesses", {
    method: "POST",
    body: JSON.stringify({ id: "fx-work", kind: "fx", label: "fx (work)", ...overrides }),
  });

const patch = (id: string, body: Record<string, unknown>) =>
  call(`/harnesses/${id}`, { method: "PATCH", body: JSON.stringify(body) });

const getHarness = async (id: string) => (await (await call(`/harnesses/${id}`)).json()) as Harness;

test("POST without the field defaults the toggle on", async () => {
  const res = await createRaw();
  expect(res.status).toBe(200);
  expect(((await res.json()) as Harness).profileMcpServers).toBe(true);
  expect((await getHarness("fx-work")).profileMcpServers).toBe(true);
});

test("POST with profileMcpServers: false persists it", async () => {
  const res = await createRaw({ profileMcpServers: false });
  expect(res.status).toBe(200);
  expect(((await res.json()) as Harness).profileMcpServers).toBe(false);
  expect((await getHarness("fx-work")).profileMcpServers).toBe(false);
});

test.each([["yes"], [1], [null]])("POST with profileMcpServers %j → 400 and nothing is created", async (value) => {
  const res = await createRaw({ profileMcpServers: value });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe(ERROR);
  expect((await call("/harnesses/fx-work")).status).toBe(404);
});

test("PATCH toggles an alias off and back on", async () => {
  await createRaw();
  const off = await patch("fx-work", { profileMcpServers: false });
  expect(off.status).toBe(200);
  expect(((await off.json()) as Harness).profileMcpServers).toBe(false);
  expect((await getHarness("fx-work")).profileMcpServers).toBe(false);
  const on = await patch("fx-work", { profileMcpServers: true });
  expect(((await on.json()) as Harness).profileMcpServers).toBe(true);
  expect((await getHarness("fx-work")).profileMcpServers).toBe(true);
});

test("PATCH alongside a config field applies both", async () => {
  await createRaw();
  const res = await patch("fx-work", { profileMcpServers: false, label: "fx (renamed)" });
  expect(res.status).toBe(200);
  const updated = (await res.json()) as Harness;
  expect(updated.profileMcpServers).toBe(false);
  expect(updated.label).toBe("fx (renamed)");
});

test("PATCH without the field leaves the toggle alone", async () => {
  await createRaw({ profileMcpServers: false });
  const res = await patch("fx-work", { label: "fx (other)" });
  expect(res.status).toBe(200);
  expect(((await res.json()) as Harness).profileMcpServers).toBe(false);
});

test("PATCH is allowed on the built-in fx row, like enabled", async () => {
  const res = await patch("fx", { profileMcpServers: false });
  expect(res.status).toBe(200);
  expect(((await res.json()) as Harness).profileMcpServers).toBe(false);
  expect((await getHarness("fx")).profileMcpServers).toBe(false);
});

test("PATCH on a built-in still refuses a config field next to the toggle, and applies nothing", async () => {
  const res = await patch("fx", { profileMcpServers: false, label: "nope" });
  expect(res.status).toBe(400);
  expect((await getHarness("fx")).profileMcpServers).toBe(true);
});

test.each([["yes"], [0], [null]])("PATCH with profileMcpServers %j → 400 and nothing is applied", async (value) => {
  await createRaw();
  const res = await patch("fx-work", { profileMcpServers: value, enabled: false, label: "should not land" });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe(ERROR);
  const after = await getHarness("fx-work");
  expect(after.profileMcpServers).toBe(true);
  expect(after.enabled).toBe(true);
  expect(after.label).toBe("fx (work)");
});
