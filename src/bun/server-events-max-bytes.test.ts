// Route-level companion for the phone-facing additions to the event routes (docs/architecture/core-responsiveness.md):
// `?maxBytes=` on the replay and the page, `GET /tasks/:id/events/:eventId`, `GET /interactions/pending`, `PUT /app/presence`,
// the route table, and Bun's routing of `/tasks/:id/events/page` versus `/tasks/:id/events/:eventId`.
// Top-level mkdtemp + env, like every server test (db.ts captures AGETOR_DATA_DIR at first import). Port 5412 is unique in src/.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunEventStream, Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-server-events-max-bytes-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "5412";
const BASE = "http://127.0.0.1:5412";

let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;
let server: { stop: () => void };
let token: string;
let cliToken: string;
let routeTable: typeof import("./route-table.ts");
let presenceMod: typeof import("./presence.ts");

beforeAll(async () => {
  ({ db, tasks, runs } = await import("./db.ts"));
  const srv = await import("./server.ts");
  routeTable = await import("./route-table.ts");
  presenceMod = await import("./presence.ts");
  const cfg = await import("./api-config.ts");
  token = cfg.API_TOKEN;
  cliToken = cfg.CLI_TOKEN;
  server = srv.startApiServer() as unknown as { stop: () => void };
});
afterAll(() => {
  server?.stop?.();
  rmTestDataDir(DATA_DIR);
});
afterEach(() => {
  db.run(`DELETE FROM run_events`);
  db.run(`DELETE FROM runs`);
  db.run(`DELETE FROM tasks`);
  presenceMod.__testing.reset();
});

function makeTaskRow(taskId: string): Task {
  return {
    id: taskId, title: "t", prompt: "p", agent: "claude-code", workdir: "/tmp", isolation: "none", taskType: "task",
    branch: null, branchSource: "created", worktreePath: null, baseRef: null, prUrl: null, mode: null, model: null, effort: null,
    speed: "off", maxMode: false, opencodeServer: "shared", references: [], backlog: [], plans: [], draft: null, column: "ready",
    runId: null, createdAt: Date.now(), updatedAt: Date.now(), hasOpenableRun: false, pendingInteractionCount: 0, openTerminalCount: 0,
    archivedAt: null,
  };
}

function seed(spec: RunEventStream[], size = 5): { taskId: string; runId: string; ids: number[] } {
  const taskId = randomUUID();
  const runId = randomUUID();
  tasks.insert(makeTaskRow(taskId));
  const now = Date.now();
  runs.insert({
    id: runId, taskId, agent: "claude-code", status: "succeeded", startedAt: now, endedAt: now + 1, exitCode: 0,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  const ids: number[] = [];
  db.transaction(() => {
    for (const st of spec) ids.push(runs.appendEvent(runId, st, "x".repeat(size))!.id);
  })();
  return { taskId, runId, ids };
}

const auth = (t = token) => ({ authorization: `Bearer ${t}` });
const get = (p: string, t = token) => fetch(`${BASE}${p}`, { headers: auth(t) });

/** Read an SSE response until it has `n` data frames or the timeout passes, then abort. */
async function sseFrames(p: string, n: number, ms = 3000): Promise<Array<{ event: string; data: any }>> {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}${p}`, { headers: auth(), signal: ctrl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const frames: Array<{ event: string; data: any }> = [];
  let buf = "";
  const deadline = Date.now() + ms;
  try {
    while (frames.length < n && Date.now() < deadline) {
      const r = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), 400))]);
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const lines = block.split("\n");
        const dataLine = lines.find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const ev = lines.find((l) => l.startsWith("event:"));
        frames.push({ event: ev ? ev.slice(6).trim() : "message", data: JSON.parse(dataLine.slice(5)) });
      }
    }
  } finally {
    ctrl.abort();
  }
  return frames;
}

describe("route table", () => {
  test("servedRoutes() holds the routes Bun serves, and the wrapped handlers answer", async () => {
    const routes = routeTable.servedRoutes();
    expect(typeof routes["/health"]).toBe("function");
    const res = await (routes["/health"] as (r: Request) => Response | Promise<Response>)(new Request(`${BASE}/health`));
    expect(await res!.json()).toEqual({ ok: true, app: "agetor" });
    expect(Object.keys(routes)).toContain("/tasks/:id/events/:eventId");
    expect(Object.keys(routes)).toContain("/interactions/pending");
  });
});

describe("GET /tasks/:id/events/page ?maxBytes", () => {
  test("a small ask returns fewer rows than the default page, and hasMore says there is more", async () => {
    const { taskId, ids } = seed(Array.from({ length: 40 }, () => "stdout" as RunEventStream), 20 * 1024);
    const beforeId = ids[ids.length - 1]! + 1;
    const all = await (await get(`/tasks/${taskId}/events/page?beforeId=${beforeId}&limit=2000`)).json() as { events: unknown[] };
    const small = await (await get(`/tasks/${taskId}/events/page?beforeId=${beforeId}&limit=2000&maxBytes=100000`)).json() as { events: Array<{ data: string }>; hasMore: boolean };
    expect(small.events.length).toBeLessThan(all.events.length);
    expect(small.events.reduce((n, e) => n + e.data.length, 0)).toBeLessThanOrEqual(100000 + 20 * 1024);
    expect(small.hasMore).toBe(true);
  });
  test("a malformed maxBytes is ignored, never a 400", async () => {
    const { taskId, ids } = seed(["stdout", "stdout"]);
    const res = await get(`/tasks/${taskId}/events/page?beforeId=${ids[1]! + 1}&maxBytes=abc`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { events: unknown[] }).events.length).toBe(2);
  });
});

describe("GET /tasks/:id/events ?maxBytes", () => {
  test("the replay honours it, and without it the window is unchanged", async () => {
    const { taskId } = seed(Array.from({ length: 60 }, () => "stdout" as RunEventStream), 50 * 1024);
    const small = await sseFrames(`/tasks/${taskId}/events?maxBytes=262144`, 40);
    const smallEvents = small.filter((f) => f.event === "message" && typeof f.data.id === "number");
    expect(smallEvents.length).toBeLessThan(12);
    expect(smallEvents.reduce((n, f) => n + f.data.data.length, 0)).toBeLessThanOrEqual(262144 + 50 * 1024);
    const full = await sseFrames(`/tasks/${taskId}/events`, 60);
    expect(full.filter((f) => f.event === "message" && typeof f.data.id === "number").length).toBeGreaterThan(40);
  });
});

describe("GET /tasks/:id/events/:eventId", () => {
  test("returns the raw stored event, and 404s for another task's event or an unknown task", async () => {
    const a = seed(["stdout", "tool_result"], 30);
    const b = seed(["stdout"]);
    const res = await get(`/tasks/${a.taskId}/events/${a.ids[1]}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: a.ids[1], runId: a.runId, taskId: a.taskId, stream: "tool_result", data: "x".repeat(30) });
    expect((await get(`/tasks/${a.taskId}/events/${b.ids[0]}`)).status).toBe(404);
    expect((await get(`/tasks/nope/events/${a.ids[0]}`)).status).toBe(404);
    expect((await get(`/tasks/${a.taskId}/events/99999999`)).status).toBe(404);
  });
  test("a non-numeric or non-positive id is a 400", async () => {
    const { taskId } = seed(["stdout"]);
    for (const bad of ["abc", "1.5", "-3", "0", "1e3"]) expect((await get(`/tasks/${taskId}/events/${bad}`)).status).toBe(400);
  });
  test("the CLI token may read it", async () => {
    const { taskId, ids } = seed(["stdout"]);
    expect((await get(`/tasks/${taskId}/events/${ids[0]}`, cliToken)).status).toBe(200);
  });
  test("`/events/page` still reaches the page handler (a static segment beats a param)", async () => {
    const { taskId, ids } = seed(["stdout", "stdout"]);
    const res = await get(`/tasks/${taskId}/events/page?beforeId=${ids[1]! + 1}`);
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()) as object).sort()).toEqual(["earliestId", "events", "hasMore"]);
    // And without beforeId the PAGE handler's own 400 answers, proving it was not read as eventId "page".
    const bad = await get(`/tasks/${taskId}/events/page`);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("beforeId");
  });
});

describe("GET /interactions/pending", () => {
  test("answers {cards, gates}, and the per-task route is unchanged", async () => {
    const { taskId } = seed(["stdout"]);
    const res = await get(`/interactions/pending`);
    expect(res.status).toBe(200);
    // The interaction registry is process-wide and `bun test` runs every file in one process, so another file's leftover cards may be
    // listed: assert the shape, and that nothing is pending for this task.
    const body = (await res.json()) as { cards: Array<{ taskId: string }>; gates: Array<{ taskId: string }> };
    expect(Object.keys(body).sort()).toEqual(["cards", "gates"]);
    expect(Array.isArray(body.cards) && Array.isArray(body.gates)).toBe(true);
    expect(body.cards.filter((c) => c.taskId === taskId)).toEqual([]);
    expect(body.gates.filter((g) => g.taskId === taskId)).toEqual([]);
    const perTask = await get(`/tasks/${taskId}/interactions/pending`);
    expect(await perTask.json()).toEqual([]);
  });
  test("a pending card is listed with its parentTaskId", async () => {
    const { taskId } = seed(["stdout"]);
    const interactions = await import("./interactions.ts");
    const reg = interactions.registerTmuxPrompt({
      taskId, runId: "r1", paneText: "Do you want to proceed?", fingerprint: "fp-1",
      choices: [{ key: "1", label: "Yes" }, { key: "2", label: "No" }],
    });
    void reg.answer.catch(() => undefined);
    const res = await (await get(`/interactions/pending`)).json() as { cards: Array<{ taskId: string; parentTaskId: string }> };
    expect(res.cards.filter((c) => c.taskId === taskId).map((c) => [c.taskId, c.parentTaskId])).toEqual([[taskId, taskId]]);
    interactions.cancelPendingForTask(taskId, "test done");
  });
});

describe("PUT /app/presence", () => {
  const put = (body: unknown, t = token) => fetch(`${BASE}/app/presence`, { method: "PUT", headers: { ...auth(t), "content-type": "application/json" }, body: JSON.stringify(body) });
  test("a valid report reaches the presence store", async () => {
    const res = await put({ focused: true, selectedTaskId: "t1", view: "run-panel" });
    expect(res.status).toBe(200);
    expect(presenceMod.presence()).toMatchObject({ focused: true, selectedTaskId: "t1", view: "run-panel" });
  });
  test("a bad body is a 400 and changes nothing", async () => {
    for (const bad of [{}, { focused: "yes", selectedTaskId: null, view: null }, { focused: true, selectedTaskId: 5, view: null }, { focused: true, selectedTaskId: null, view: "other" }, { focused: true, selectedTaskId: "", view: null }]) {
      expect((await put(bad)).status).toBe(400);
    }
    expect(presenceMod.presence().focused).toBe(false);
  });
  test("the CLI token is refused (desktop only)", async () => {
    const res = await put({ focused: true, selectedTaskId: null, view: null }, cliToken);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("desktop-only");
  });
});
