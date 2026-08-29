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

const pick = (mode: "files" | "folder") =>
  fetch("http://127.0.0.1:4421/refs/pick", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });

test("/refs/pick is unavailable in headless mode when the fake-pick seam is unset", async () => {
  // Guards against the seam changing behavior when AGETOR_FAKE_PICK_REFS_DIR
  // is absent — no `native` bridge exists in this test process, so the
  // request must still fall through to the same 501 the real headless
  // backend returns.
  delete process.env.AGETOR_FAKE_PICK_REFS_DIR;
  const res = await pick("files");
  expect(res.status).toBe(501);
});

test("/refs/pick honors AGETOR_FAKE_PICK_REFS_DIR", async () => {
  const pickDir = mkdtempSync(path.join(tmpdir(), "agetor-refs-pick-"));
  writeFileSync(path.join(pickDir, "b.txt"), "b");
  writeFileSync(path.join(pickDir, "a.txt"), "a");
  mkdirSync(path.join(pickDir, "subdir")); // not a regular file — must be excluded from "files" mode
  process.env.AGETOR_FAKE_PICK_REFS_DIR = pickDir;
  try {
    const filesRes = await pick("files");
    expect(filesRes.status).toBe(200);
    const { refs: fileRefs } = (await filesRes.json()) as { refs: { path: string; isDirectory: boolean }[] };
    expect(fileRefs).toEqual([
      { path: path.join(pickDir, "a.txt"), isDirectory: false },
      { path: path.join(pickDir, "b.txt"), isDirectory: false },
    ]);

    const folderRes = await pick("folder");
    expect(folderRes.status).toBe(200);
    const { refs: folderRefs } = (await folderRes.json()) as { refs: { path: string; isDirectory: boolean }[] };
    expect(folderRefs).toEqual([{ path: pickDir, isDirectory: true }]);
  } finally {
    delete process.env.AGETOR_FAKE_PICK_REFS_DIR;
  }
});

test("/refs/pick returns a cancelled pick when AGETOR_FAKE_PICK_REFS_DIR doesn't exist", async () => {
  process.env.AGETOR_FAKE_PICK_REFS_DIR = path.join(SCRATCH, "does-not-exist");
  try {
    const res = await pick("files");
    expect(res.status).toBe(200);
    const { refs } = (await res.json()) as { refs: unknown[] };
    expect(refs).toEqual([]);
  } finally {
    delete process.env.AGETOR_FAKE_PICK_REFS_DIR;
  }
});
