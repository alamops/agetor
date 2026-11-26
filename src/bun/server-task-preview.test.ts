// GET /tasks/:id/files/preview (docs/architecture/remote-gateway.md): the task-scoped image preview a phone or the CLI reads. Same bytes and
// content types as /files/preview, but it never follows a symlink and never reads a preview twin, and an unknown task is a 404.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-task-preview-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4486";
const BASE = "http://127.0.0.1:4486";

const SCRATCH = mkdtempSync(path.join(tmpdir(), "agetor-task-preview-scratch-"));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_FILE = path.join(SCRATCH, "shot.png");
writeFileSync(PNG_FILE, PNG);
const LINK = path.join(SCRATCH, "link.png");
symlinkSync(PNG_FILE, LINK);
const DIR_PNG = path.join(SCRATCH, "dir.png");
mkdirSync(DIR_PNG);
const TXT = path.join(SCRATCH, "note.txt");
writeFileSync(TXT, "hi");
const SVG = path.join(SCRATCH, "pic.svg");
writeFileSync(SVG, "<svg xmlns='http://www.w3.org/2000/svg'/>");

let server: { stop: () => void };
let master: string;
let cli: string;
let taskId: string;

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer } = await import("./server.ts");
  const { API_TOKEN, CLI_TOKEN } = await import("./api-config.ts");
  server = startApiServer() as unknown as { stop: () => void };
  master = API_TOKEN;
  cli = CLI_TOKEN;
  const { createTask } = await import("./orchestrator.ts");
  const created = await createTask({ title: "preview", prompt: "p", agent: "claude-code", workdir: SCRATCH, isolation: "none" });
  if ("error" in created) throw new Error(created.error);
  taskId = created.task.id;
});

afterAll(() => {
  server?.stop?.();
  rmTestDataDir(DATA_DIR);
});

const get = (id: string, p: string, token: string | null = master, headers: Record<string, string> = {}) =>
  fetch(`${BASE}/tasks/${id}/files/preview?path=${encodeURIComponent(p)}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

describe("GET /tasks/:id/files/preview", () => {
  test("serves the image bytes with the image content type and hardening headers, to either token", async () => {
    for (const token of [master, cli]) {
      const res = await get(taskId, PNG_FILE, token);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
      expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    }
  });

  test("an SVG is served as an image and carries the sandbox CSP", async () => {
    const res = await get(taskId, SVG);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg");
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  });

  test("needs a token; an unknown task is 404; a missing, relative or non-image path is 400", async () => {
    expect((await get(taskId, PNG_FILE, null)).status).toBe(401);
    expect((await get("no-such-task", PNG_FILE)).status).toBe(404);
    expect((await get(taskId, "")).status).toBe(400);
    expect((await get(taskId, "shot.png")).status).toBe(400);
    expect((await get(taskId, TXT)).status).toBe(400);
  });

  test("a file that does not exist, and a directory named like an image, are 404", async () => {
    expect((await get(taskId, path.join(SCRATCH, "gone.png"))).status).toBe(404);
    expect((await get(taskId, DIR_PNG)).status).toBe(404);
  });

  test("NEVER follows a symlink (the desktop route does): a link an agent planted is not a way to read another file", async () => {
    const viaTask = await get(taskId, LINK);
    expect([403, 404]).toContain(viaTask.status);
    // the same link through the desktop-only route still works for the app: the difference is the point
    const desktop = await fetch(`${BASE}/files/preview?path=${encodeURIComponent(LINK)}`, { headers: { authorization: `Bearer ${master}` } });
    expect(desktop.status).toBe(200);
  });

  test("revalidates: the ETag round-trips to a 304", async () => {
    const first = await get(taskId, PNG_FILE);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const again = await get(taskId, PNG_FILE, master, { "if-none-match": etag! });
    expect(again.status).toBe(304);
  });
});
