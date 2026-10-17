import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { plainEncodedProjectPath } from "../shared/claude-session-meta.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-cs-routes-"));
process.env.AGETOR_DATA_DIR ??= DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER ??= "fake";
process.env.AGETOR_CLAUDE_BIN ??= "/bin/echo";
process.env.AGETOR_TMUX_BIN ??= "/bin/echo";

const BASE = "http://127.0.0.1:4648";
const home = mkdtempSync(path.join(tmpdir(), "cc-http-home-"));
const stub = path.join(home, "agents.json");
writeFileSync(stub, "[]");

let token = "";
let stop: (() => void) | null = null;
let tasks: typeof import("./db.ts").tasks;

beforeAll(async () => {
  ({ tasks } = await import("./db.ts"));
  const server = await import("./server.ts");
  token = server.API_TOKEN;
  process.env.AGETOR_API_PORT = "4648";
  const started = server.startApiServer() as unknown as { stop: () => void };
  stop = () => started.stop();
});

afterAll(() => {
  stop?.();
  rmSync(home, { recursive: true, force: true });
  rmTestDataDir(DATA_DIR);
});

function plant(sessionId: string, cwd: string): void {
  expect(plainEncodedProjectPath(cwd).length).toBeLessThanOrEqual(200);
  mkdirSync(cwd, { recursive: true });
  const dir = path.join(home, ".claude", "projects", plainEncodedProjectPath(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({
    type: "user",
    uuid: `${sessionId}-u`,
    cwd,
    timestamp: "2026-10-02T00:00:00.000Z",
    message: { role: "user", content: "imported over http" },
  }) + "\n");
}

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const prevHome = process.env.HOME;
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  const prevStub = process.env.AGETOR_CLAUDE_AGENTS_JSON;
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.AGETOR_CLAUDE_AGENTS_JSON = stub;
  try {
    return await fn();
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    if (prevStub === undefined) delete process.env.AGETOR_CLAUDE_AGENTS_JSON;
    else process.env.AGETOR_CLAUDE_AGENTS_JSON = prevStub;
  }
}

function get(p: string) {
  return fetch(`${BASE}${p}`, { headers: { authorization: `Bearer ${token}` } });
}
function post(p: string, body: unknown) {
  return fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("list, recheck, import, and the imported-session start refusal", async () => {
  const cwd = path.join(home, "repo");
  plant("http-idle", cwd);
  plant("http-live", path.join(home, "live-repo"));
  await withHome(async () => {
    const listed = await get("/claude-sessions");
    expect(listed.status).toBe(200);
    const first = await listed.json() as { sessions: { sessionId: string; jsonlPath?: string }[] };
    expect(first.sessions.some((s) => s.sessionId === "http-idle")).toBe(true);
    expect(first.sessions.every((s) => s.jsonlPath === undefined)).toBe(true);

    writeFileSync(stub, "[]");
    const rechecked = await post("/claude-sessions/recheck", {});
    expect(rechecked.status).toBe(200);
    const idle = ((await rechecked.json()) as { sessions: { sessionId: string; importable: boolean }[] })
      .sessions.find((s) => s.sessionId === "http-idle");
    expect(idle?.importable).toBe(true);

    const bad = await post("/claude-sessions/import", { ids: "nope" });
    expect(bad.status).toBe(400);

    writeFileSync(stub, JSON.stringify([{ sessionId: "http-live" }]));
    const live = await post("/claude-sessions/import", { ids: ["http-live"] });
    expect(live.status).toBe(200);
    const liveBody = await live.json() as { results: { id: string; error?: string; taskId?: string }[] };
    expect(liveBody.results[0]?.taskId).toBeUndefined();
    expect(liveBody.results[0]?.error).toBeTruthy();

    writeFileSync(stub, "[]");
    const imported = await post("/claude-sessions/import", { ids: ["http-idle"] });
    expect(imported.status).toBe(200);
    const body = await imported.json() as { results: { taskId?: string; error?: string }[] };
    expect(body.results[0]?.error).toBeUndefined();
    const task = tasks.get(body.results[0]!.taskId!);
    expect(task?.column).toBe("review");
    expect(task?.importedClaude?.sessionId).toBe("http-idle");

    const started = await post(`/tasks/${task!.id}/start`, {});
    expect(started.status).toBe(409);
    const startBody = await started.json() as { code?: string };
    expect(startBody.code).toBe("imported-session");

    const again = await get("/claude-sessions");
    expect(again.status).toBe(200);
    const listedAgain = (await again.json() as { sessions: { sessionId: string }[] }).sessions;
    expect(listedAgain.some((s) => s.sessionId === "http-idle")).toBe(false);
    expect(listedAgain.some((s) => s.sessionId === "http-live")).toBe(true);
  });
});

test("retry on a missing task is 404", async () => {
  const res = await post(`/tasks/${randomUUID()}/claude-session/retry`, {});
  expect(res.status).toBe(404);
});
