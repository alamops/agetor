import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-refs-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4421";

// A scratch tree to resolve against: one file, one directory.
const SCRATCH = mkdtempSync(path.join(tmpdir(), "agetor-refs-scratch-"));
const FILE = path.join(SCRATCH, "notes.txt");
const DIR = path.join(SCRATCH, "src");
writeFileSync(FILE, "x");
mkdirSync(DIR);

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

const resolve = (paths: string[]) =>
  fetch("http://127.0.0.1:4421/refs/resolve", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ paths }),
  });

test("/refs/resolve stats files and directories", async () => {
  const res = await resolve([FILE, DIR]);
  expect(res.status).toBe(200);
  const { refs } = (await res.json()) as { refs: { path: string; isDirectory: boolean }[] };
  expect(refs).toEqual([
    { path: FILE, isDirectory: false },
    { path: DIR, isDirectory: true },
  ]);
});

test("/refs/resolve drops paths that don't exist", async () => {
  const res = await resolve([FILE, path.join(SCRATCH, "gone.txt")]);
  const { refs } = (await res.json()) as { refs: { path: string }[] };
  expect(refs.map((r) => r.path)).toEqual([FILE]);
});

test("/refs/resolve ignores relative paths", async () => {
  const res = await resolve(["notes.txt", FILE]);
  const { refs } = (await res.json()) as { refs: { path: string }[] };
  expect(refs.map((r) => r.path)).toEqual([FILE]);
});

test("/refs/resolve dedupes repeated paths", async () => {
  const res = await resolve([FILE, FILE, DIR]);
  const { refs } = (await res.json()) as { refs: { path: string }[] };
  expect(refs.map((r) => r.path)).toEqual([FILE, DIR]);
});

test("/refs/resolve drops comma-split fragments (native-panel comma-path failure mode)", async () => {
  // When the native open-panel returns a comma-joined string and a picked
  // path itself contains a comma, the client splits it into pieces. The
  // non-existent fragments must fall out rather than reach the prompt as
  // broken refs. Simulate `/Users/.../Foo, Bar.txt` → ["…/Foo", " Bar.txt"].
  const res = await resolve([path.join(SCRATCH, "Foo"), " Bar.txt", FILE]);
  const { refs } = (await res.json()) as { refs: { path: string }[] };
  expect(refs.map((r) => r.path)).toEqual([FILE]);
});

test("/refs/resolve requires a token", async () => {
  const res = await fetch("http://127.0.0.1:4421/refs/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: [FILE] }),
  });
  expect(res.status).toBe(401);
});
