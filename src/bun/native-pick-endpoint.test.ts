import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeTestNative } from "./test-native.ts";

// The native open-panel branches of `/refs/pick` and `/projects/pick`, driven
// through a stub bridge that answers the way Electrobun's `openFileDialog`
// does: the panel's paths joined with "," and split back on ",".
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-native-pick-endpoint-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4442";
delete process.env.AGETOR_FAKE_PICK_REFS_DIR;

const SCRATCH = mkdtempSync(path.join(tmpdir(), "agetor-native-pick-scratch-"));
const COMMA_DIR = path.join(SCRATCH, "Backups, 2026");
const COMMA_FILE = path.join(SCRATCH, "Foo, Bar.txt");
const SPACE_FILE = path.join(SCRATCH, "notes ");
const PLAIN_FILE = path.join(SCRATCH, "plain.txt");
mkdirSync(COMMA_DIR);
writeFileSync(COMMA_FILE, "x");
writeFileSync(SPACE_FILE, "x");
writeFileSync(PLAIN_FILE, "x");

let answer: string[] = [];
let server: { stop: () => void };
let token: string;

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  const native = makeTestNative({ openFileDialog: async () => answer });
  server = startApiServer({ native }) as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
  rmSync(SCRATCH, { recursive: true, force: true });
});

beforeEach(() => {
  answer = [];
});

/** What Electrobun hands back for these picks. */
const panelAnswer = (...paths: string[]) => paths.join(",").split(",");

const post = (route: string, body: unknown) =>
  fetch(`http://127.0.0.1:4442${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("/refs/pick re-joins comma paths and keeps a trailing space", async () => {
  answer = panelAnswer(PLAIN_FILE, COMMA_FILE, SPACE_FILE);
  const res = await post("/refs/pick", { mode: "files" });
  expect(res.status).toBe(200);
  const { refs } = (await res.json()) as { refs: { path: string; isDirectory: boolean }[] };
  expect(refs).toEqual([
    { path: PLAIN_FILE, isDirectory: false },
    { path: COMMA_FILE, isDirectory: false },
    { path: SPACE_FILE, isDirectory: false },
  ]);
});

test("/refs/pick: a cancelled panel is no refs", async () => {
  answer = [""];
  const res = await post("/refs/pick", { mode: "folder" });
  expect(((await res.json()) as { refs: unknown[] }).refs).toEqual([]);
});

test("/projects/pick registers a folder whose path has a comma", async () => {
  answer = panelAnswer(COMMA_DIR);
  const res = await post("/projects/pick", {});
  expect(res.status).toBe(200);
  const { project } = (await res.json()) as { project: { path: string; name: string } | null };
  expect(project?.path).toBe(COMMA_DIR);
  expect(project?.name).toBe("Backups, 2026");
});

test("/projects/pick: a cancelled panel registers nothing", async () => {
  answer = [];
  const res = await post("/projects/pick", {});
  expect(((await res.json()) as { project: unknown }).project).toBeNull();
});
