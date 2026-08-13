import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Task } from "../shared/types.ts";

// Set AGETOR_DATA_DIR BEFORE importing db.ts (which captures it at top-level
// import) — same convention as worktree.test.ts / task-events.test.ts.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-server-blob-data-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT
// (files-preview-endpoint.test.ts uses 4441; see its header comment for the
// convention).
process.env.AGETOR_API_PORT = "4551";

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), "agetor-server-blob-repo-"));
  await git(["init", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  writeFileSync(path.join(repo, "README"), "hi\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "init"], repo);
  return repo;
}

function fakeTask(overrides: Partial<Task> & { workdir: string }): Task {
  return {
    id: randomUUID(),
    title: "Fix the thing",
    prompt: "p",
    column: "ready",
    agent: "claude-code",
    isolation: "worktree",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    fast: false,
    maxMode: false,
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BYTES = Buffer.concat([PNG_MAGIC, Buffer.from("preview-fixture")]);
// Not a real PDF — the route only cares about the extension/content-type
// mapping, never parses the bytes.
const PDF_BYTES = Buffer.from("%PDF-1.4 fixture bytes");

let server: { stop: () => void };
let token: string;

// A single shared task with a real worktree, reused (read-only) across the
// happy-path tests below: a committed PNG (for old-side/etag coverage), a
// committed PDF, a committed .txt (non-previewable), and a working-tree
// modification to the PNG (so "new" and "old" bytes genuinely differ).
let task: Task;

beforeAll(async () => {
  const { tasks } = await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;

  const { prepareWorkdir, resolveRef } = await import("./worktree.ts");
  const repo = await makeRepo();
  writeFileSync(path.join(repo, "logo.png"), PNG_BYTES);
  writeFileSync(path.join(repo, "doc.pdf"), PDF_BYTES);
  writeFileSync(path.join(repo, "notes.txt"), "hello");
  await git(["add", "."], repo);
  await git(["commit", "-m", "add fixtures"], repo);
  const base = await resolveRef(repo, "HEAD");

  const draft = fakeTask({ workdir: repo, baseRef: base });
  const prepared = await prepareWorkdir(draft);
  if ("error" in prepared) throw new Error(prepared.error);

  // Working-tree modification so old-side vs new-side bytes genuinely
  // differ (exercises the ETag round-trip meaningfully).
  writeFileSync(path.join(prepared.cwd, "logo.png"), Buffer.concat([PNG_MAGIC, Buffer.from("modified")]));

  task = { ...draft, worktreePath: prepared.worktreePath, branch: prepared.branch };
  tasks.insert(task);
});

afterAll(() => {
  server?.stop?.();
});

const BASE_URL = "http://127.0.0.1:4551";
const blobUrl = (taskId: string, p: string, side: string) =>
  `${BASE_URL}/tasks/${taskId}/diff/blob?path=${encodeURIComponent(p)}&side=${side}`;

const withHeader = (url: string) => fetch(url, { headers: { authorization: `Bearer ${token}` } });
const withQueryToken = (url: string) => fetch(`${url}&token=${token}`);

test("/tasks/:id/diff/blob requires a token", async () => {
  const res = await fetch(blobUrl(task.id, "logo.png", "new"));
  expect(res.status).toBe(401);
});

test("/tasks/:id/diff/blob accepts a ?token= query param", async () => {
  const res = await withQueryToken(blobUrl(task.id, "logo.png", "new"));
  expect(res.status).toBe(200);
});

test("/tasks/:id/diff/blob 404s for an unknown task", async () => {
  const res = await withHeader(blobUrl(randomUUID(), "logo.png", "new"));
  expect(res.status).toBe(404);
});

test("/tasks/:id/diff/blob 400s when path is missing", async () => {
  const res = await withHeader(`${BASE_URL}/tasks/${task.id}/diff/blob?side=new`);
  expect(res.status).toBe(400);
});

test("/tasks/:id/diff/blob 400s when side is missing or invalid", async () => {
  const missing = await withHeader(`${BASE_URL}/tasks/${task.id}/diff/blob?path=logo.png`);
  expect(missing.status).toBe(400);

  const bad = await withHeader(`${BASE_URL}/tasks/${task.id}/diff/blob?path=logo.png&side=sideways`);
  expect(bad.status).toBe(400);
});

test("/tasks/:id/diff/blob 415s a non-previewable extension", async () => {
  const res = await withHeader(blobUrl(task.id, "notes.txt", "new"));
  expect(res.status).toBe(415);
});

test("/tasks/:id/diff/blob 200s the new side with matching bytes, content-type, and cache headers", async () => {
  const res = await withHeader(blobUrl(task.id, "logo.png", "new"));
  expect(res.status).toBe(200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect(Buffer.from(bytes)).toEqual(Buffer.concat([PNG_MAGIC, Buffer.from("modified")]));
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cache-control") ?? "").toContain("must-revalidate");
  expect(res.headers.get("etag")).toBeTruthy();
});

test("/tasks/:id/diff/blob 200s the old side with the committed bytes, distinct from the new side", async () => {
  const res = await withHeader(blobUrl(task.id, "logo.png", "old"));
  expect(res.status).toBe(200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect(Buffer.from(bytes)).toEqual(PNG_BYTES);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cache-control") ?? "").toContain("must-revalidate");
  expect(res.headers.get("etag")).toBeTruthy();
});

test("/tasks/:id/diff/blob 200s a PDF with application/pdf content-type", async () => {
  const res = await withHeader(blobUrl(task.id, "doc.pdf", "new"));
  expect(res.status).toBe(200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect(Buffer.from(bytes)).toEqual(PDF_BYTES);
  expect(res.headers.get("content-type")).toBe("application/pdf");
});

test("/tasks/:id/diff/blob 304s on a matching If-None-Match with an empty body (new side)", async () => {
  const first = await withHeader(blobUrl(task.id, "logo.png", "new"));
  const etag = first.headers.get("etag");
  expect(etag).toBeTruthy();

  const second = await fetch(blobUrl(task.id, "logo.png", "new"), {
    headers: { authorization: `Bearer ${token}`, "if-none-match": etag as string },
  });
  expect(second.status).toBe(304);
  const body = await second.arrayBuffer();
  expect(body.byteLength).toBe(0);
});

test("/tasks/:id/diff/blob 304s on a matching If-None-Match with an empty body (old side)", async () => {
  const first = await withHeader(blobUrl(task.id, "logo.png", "old"));
  const etag = first.headers.get("etag");
  expect(etag).toBeTruthy();

  const second = await fetch(blobUrl(task.id, "logo.png", "old"), {
    headers: { authorization: `Bearer ${token}`, "if-none-match": etag as string },
  });
  expect(second.status).toBe(304);
  const body = await second.arrayBuffer();
  expect(body.byteLength).toBe(0);
});
