import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-files-preview-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT.
process.env.AGETOR_API_PORT = "4441";

// A scratch tree with fixtures: a real (tiny) PNG, a directory whose name
// happens to end in ".png" (must still 404, not be treated as a file), and a
// non-image file.
const SCRATCH = mkdtempSync(path.join(tmpdir(), "agetor-files-preview-scratch-"));
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_FILE = path.join(SCRATCH, "shot.png");
writeFileSync(PNG_FILE, PNG_MAGIC);
const DIR_PNG = path.join(SCRATCH, "dir.png");
mkdirSync(DIR_PNG);
const TXT_FILE = path.join(SCRATCH, "note.txt");
writeFileSync(TXT_FILE, "hello");
const UPPER_PNG_FILE = path.join(SCRATCH, "shout.PNG");
writeFileSync(UPPER_PNG_FILE, PNG_MAGIC);

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

const previewUrl = (p: string) =>
  `http://127.0.0.1:4441/files/preview?path=${encodeURIComponent(p)}`;

const previewWithHeader = (p: string) =>
  fetch(previewUrl(p), { headers: { authorization: `Bearer ${token}` } });

const previewWithQueryToken = (p: string) =>
  fetch(`${previewUrl(p)}&token=${token}`);

test("/files/preview requires a token", async () => {
  const res = await fetch(previewUrl(PNG_FILE));
  expect(res.status).toBe(401);
});

test("/files/preview accepts an Authorization: Bearer header", async () => {
  const res = await previewWithHeader(PNG_FILE);
  expect(res.status).toBe(200);
});

test("/files/preview accepts a ?token= query param (the <img> path)", async () => {
  const res = await previewWithQueryToken(PNG_FILE);
  expect(res.status).toBe(200);
});

test("/files/preview 400s when path is missing", async () => {
  const res = await fetch(`http://127.0.0.1:4441/files/preview?path=`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(400);
});

test("/files/preview 400s on a relative path", async () => {
  const res = await previewWithHeader("shot.png");
  expect(res.status).toBe(400);
});

test("/files/preview 400s on a non-image extension", async () => {
  const res = await previewWithHeader(TXT_FILE);
  expect(res.status).toBe(400);
});

test("/files/preview 404s for a nonexistent .png path", async () => {
  const res = await previewWithHeader(path.join(SCRATCH, "gone.png"));
  expect(res.status).toBe(404);
});

test("/files/preview 404s for a directory named like an image (dir.png)", async () => {
  const res = await previewWithHeader(DIR_PNG);
  expect(res.status).toBe(404);
});

test("/files/preview 200s with matching bytes, content-type, and cache headers", async () => {
  const res = await previewWithHeader(PNG_FILE);
  expect(res.status).toBe(200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect(bytes).toEqual(new Uint8Array(PNG_MAGIC));
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("cache-control") ?? "").toContain("must-revalidate");
  expect(res.headers.get("etag")).toBeTruthy();
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});

test("/files/preview 304s on a matching If-None-Match with an empty body", async () => {
  const first = await previewWithHeader(PNG_FILE);
  const etag = first.headers.get("etag");
  expect(etag).toBeTruthy();

  const second = await fetch(previewUrl(PNG_FILE), {
    headers: {
      authorization: `Bearer ${token}`,
      "if-none-match": etag as string,
    },
  });
  expect(second.status).toBe(304);
  const body = await second.arrayBuffer();
  expect(body.byteLength).toBe(0);
});

test("/files/preview is case-insensitive on the extension (.PNG)", async () => {
  const res = await previewWithHeader(UPPER_PNG_FILE);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
});
