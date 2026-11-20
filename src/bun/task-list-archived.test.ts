// `GET /tasks?archived=…&keep=…` (`TaskListArchived`,
// docs/architecture/core-responsiveness.md): the board poll and the TUI ask
// for `exclude` so archived tasks stay server-side; `keep` names tasks the
// list returns whatever their archive state. Covers the SQL filter in
// `tasks.list`, the route's query parsing and 400s, and the shared path
// builder both clients use. Same harness as server-speed-alias.test.ts:
// AGETOR_DATA_DIR and a unique AGETOR_API_PORT are set before `./db.ts` /
// `./server.ts` load.
import { test, expect, beforeAll, afterAll, afterEach, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TASK_LIST_KEEP_MAX, taskListPath, type Task } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-task-list-archived-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Unique port, distinct from every other *.test.ts file's AGETOR_API_PORT.
process.env.AGETOR_API_PORT = "4797";
const BASE = "http://127.0.0.1:4797";

let server: { stop: () => void };
let token: string;
let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;
let parseTaskListQuery: typeof import("./server.ts").parseTaskListQuery;

beforeAll(async () => {
  ({ db, tasks, runs } = await import("./db.ts"));
  const mod = await import("./server.ts");
  parseTaskListQuery = mod.parseTaskListQuery;
  server = mod.startApiServer() as unknown as { stop: () => void };
  token = mod.API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
  rmTestDataDir(DATA_DIR);
});

// Only this file's rows are removed: other files share the db singleton.
const createdTaskIds: string[] = [];
afterEach(() => {
  for (const id of createdTaskIds.splice(0)) {
    db.run(`DELETE FROM runs WHERE task_id = ?`, [id]);
    tasks.delete(id);
  }
});

function makeTask(archivedAt: number | null): string {
  const now = Date.now();
  const id = randomUUID();
  tasks.insert({
    id,
    title: `t-${archivedAt == null ? "live" : "archived"}`,
    prompt: "p",
    column: archivedAt == null ? "ready" : "done",
    agent: "claude-code",
    workdir: "/tmp",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    speed: "off", maxMode: false, opencodeServer: "shared",
    references: [], backlog: [], plans: [], draft: null,
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt,
    createdAt: now,
    updatedAt: now,
  });
  createdTaskIds.push(id);
  return id;
}

function addSucceededRun(taskId: string): void {
  runs.insert({
    id: randomUUID(),
    taskId,
    agent: "claude-code",
    status: "succeeded",
    startedAt: Date.now(),
    endedAt: Date.now(),
    exitCode: 0,
    tmuxSession: null,
    claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
}

const ids = (list: readonly Task[]) => new Set(list.map((t) => t.id));

const getTasks = async (p: string) => {
  const res = await fetch(`${BASE}${p}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as unknown };
};

describe("tasks.list archive filter", () => {
  test("no argument returns archived and unarchived tasks", () => {
    const live = makeTask(null);
    const archived = makeTask(Date.now());
    const all = ids(tasks.list());
    expect(all.has(live)).toBe(true);
    expect(all.has(archived)).toBe(true);
  });

  test("exclude drops archived tasks, only keeps just them", () => {
    const live = makeTask(null);
    const archived = makeTask(Date.now());
    const excluded = ids(tasks.list({ archived: "exclude" }));
    expect(excluded.has(live)).toBe(true);
    expect(excluded.has(archived)).toBe(false);
    const only = ids(tasks.list({ archived: "only" }));
    expect(only.has(live)).toBe(false);
    expect(only.has(archived)).toBe(true);
  });

  test("keepIds returns a filtered-out task, with its runs still aggregated", () => {
    const live = makeTask(null);
    const kept = makeTask(Date.now());
    const dropped = makeTask(Date.now());
    addSucceededRun(kept);
    const list = tasks.list({ archived: "exclude", keepIds: [kept] });
    const byId = new Map(list.map((t) => [t.id, t]));
    expect(byId.has(live)).toBe(true);
    expect(byId.has(dropped)).toBe(false);
    expect(byId.get(kept)?.hasOpenableRun).toBe(true);
    // A kept id is listed once, and keep never filters an `only` list down.
    expect(list.filter((t) => t.id === kept)).toHaveLength(1);
    const only = ids(tasks.list({ archived: "only", keepIds: [live] }));
    expect(only.has(live)).toBe(true);
    expect(only.has(kept)).toBe(true);
  });

  test("keepIds naming an unknown id is harmless", () => {
    const live = makeTask(null);
    const list = ids(tasks.list({ archived: "exclude", keepIds: [randomUUID()] }));
    expect(list.has(live)).toBe(true);
  });
});

describe("parseTaskListQuery", () => {
  const parse = (qs: string) => parseTaskListQuery(new URLSearchParams(qs));

  test("an absent archived param is include with no keep", () => {
    expect(parse("")).toEqual({ archived: "include", keepIds: [] });
  });

  test("accepts each archived value", () => {
    for (const v of ["include", "exclude", "only"] as const) {
      expect(parse(`archived=${v}`)).toEqual({ archived: v, keepIds: [] });
    }
  });

  test("rejects an unknown archived value", () => {
    expect(parse("archived=none")).toEqual({ error: "archived must be one of include, exclude, only" });
    expect(parse("archived=")).toHaveProperty("error");
  });

  test("keep is split, trimmed, de-duplicated and stripped of empties", () => {
    expect(parse("archived=exclude&keep=a, b,,a,")).toEqual({ archived: "exclude", keepIds: ["a", "b"] });
  });

  test("keep over the cap is a 400-shaped error", () => {
    const many = Array.from({ length: TASK_LIST_KEEP_MAX + 1 }, (_, i) => `id${i}`).join(",");
    expect(parse(`archived=exclude&keep=${many}`)).toEqual({ error: `keep names at most ${TASK_LIST_KEEP_MAX} task ids` });
    const atCap = Array.from({ length: TASK_LIST_KEEP_MAX }, (_, i) => `id${i}`).join(",");
    expect(parse(`archived=exclude&keep=${atCap}`)).toHaveProperty("keepIds");
  });
});

describe("GET /tasks archived and keep params", () => {
  test("the bare route still returns archived tasks", async () => {
    const live = makeTask(null);
    const archived = makeTask(Date.now());
    const { status, body } = await getTasks("/tasks");
    expect(status).toBe(200);
    const got = ids(body as Task[]);
    expect(got.has(live)).toBe(true);
    expect(got.has(archived)).toBe(true);
  });

  test("archived=exclude with keep returns live tasks plus the kept archived one", async () => {
    const live = makeTask(null);
    const kept = makeTask(Date.now());
    const dropped = makeTask(Date.now());
    const { status, body } = await getTasks(taskListPath({ archived: "exclude", keep: [kept] }));
    expect(status).toBe(200);
    const got = ids(body as Task[]);
    expect(got.has(live)).toBe(true);
    expect(got.has(kept)).toBe(true);
    expect(got.has(dropped)).toBe(false);
  });

  test("archived=only returns only archived tasks", async () => {
    const live = makeTask(null);
    const archived = makeTask(Date.now());
    const { body } = await getTasks(taskListPath({ archived: "only" }));
    const got = ids(body as Task[]);
    expect(got.has(live)).toBe(false);
    expect(got.has(archived)).toBe(true);
  });

  test("a bad archived value is a 400 with the reason", async () => {
    const { status, body } = await getTasks("/tasks?archived=bogus");
    expect(status).toBe(400);
    expect(body).toEqual({ error: "archived must be one of include, exclude, only" });
  });
});

describe("taskListPath", () => {
  test("the default and include stay the bare route older cores understand", () => {
    expect(taskListPath()).toBe("/tasks");
    expect(taskListPath({ archived: "include", keep: ["a"] })).toBe("/tasks");
  });

  test("exclude carries keep; empty and duplicate ids are dropped", () => {
    expect(taskListPath({ archived: "exclude" })).toBe("/tasks?archived=exclude");
    expect(taskListPath({ archived: "exclude", keep: ["a", "", "b", "a"] })).toBe("/tasks?archived=exclude&keep=a%2Cb");
  });

  test("keep is capped so the request can't 400", () => {
    const many = Array.from({ length: TASK_LIST_KEEP_MAX + 5 }, (_, i) => `id${i}`);
    const qs = new URL(`http://x${taskListPath({ archived: "exclude", keep: many })}`).searchParams;
    expect(qs.get("keep")!.split(",")).toHaveLength(TASK_LIST_KEEP_MAX);
  });
});

describe("GET /tasks conditional answer (ETag / 304)", () => {
  const ORIGIN = "http://localhost:5173";
  const fetchList = (p: string, etag?: string) =>
    fetch(`${BASE}${p}`, {
      headers: {
        authorization: `Bearer ${token}`,
        origin: ORIGIN,
        ...(etag ? { "if-none-match": etag } : {}),
      },
    });

  test("an unchanged list answers 304 with no body; the webview may send If-None-Match and read ETag", async () => {
    makeTask(null);
    const first = await fetchList("/tasks?archived=exclude");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-z]+"$/);
    expect(first.headers.get("access-control-expose-headers")).toContain("etag");
    expect(first.headers.get("access-control-allow-headers")).toContain("if-none-match");
    await first.json();

    const again = await fetchList("/tasks?archived=exclude", etag!);
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(etag);

    // A stale tag gets the full list.
    const stale = await fetchList("/tasks?archived=exclude", '"stale"');
    expect(stale.status).toBe(200);
    expect(Array.isArray(await stale.json())).toBe(true);
  });

  test("a task write, a run write and a stall mark each change the answer", async () => {
    const { markStalled, clearStalled } = await import("./stall-registry.ts");
    const id = makeTask(null);
    const tagOf = async () => {
      const res = await fetchList("/tasks?archived=exclude");
      expect(res.status).toBe(200);
      const list = (await res.json()) as (Task & { stalledSince: number | null })[];
      return { etag: res.headers.get("etag")!, row: list.find((t) => t.id === id)! };
    };
    const a = await tagOf();

    tasks.update(id, { title: "renamed" });
    const b = await tagOf();
    expect(b.etag).not.toBe(a.etag);
    expect(b.row.title).toBe("renamed");

    addSucceededRun(id);
    const c = await tagOf();
    expect(c.etag).not.toBe(b.etag);
    expect(c.row.hasOpenableRun).toBe(true);

    markStalled(id, 1234);
    try {
      const d = await tagOf();
      expect(d.etag).not.toBe(c.etag);
      expect(d.row.stalledSince).toBe(1234);
    } finally {
      clearStalled(id);
    }
    // The mark gone: back to the earlier content, so the earlier tag.
    expect((await tagOf()).etag).toBe(c.etag);
  });

  test("the bare route (CLI, TUI, older webviews) still gets a 200 array every time", async () => {
    makeTask(null);
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${BASE}/tasks`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    }
  });
});

describe("db: page cache and the task-list change counter", () => {
  test("the connection runs with a 64 MiB page cache", async () => {
    const { SQLITE_CACHE_KIB } = await import("./db.ts");
    expect(SQLITE_CACHE_KIB).toBe(65_536);
    expect(db.query<{ cache_size: number }, []>("PRAGMA cache_size").get()?.cache_size).toBe(-65_536);
  });

  test("writes to tasks, runs and subagents bump the version; reads don't", async () => {
    const { taskListDataVersion } = await import("./db.ts");
    const v0 = taskListDataVersion();
    tasks.list();
    expect(taskListDataVersion()).toBe(v0);
    const id = makeTask(null);
    const v1 = taskListDataVersion();
    expect(v1).not.toBe(v0);
    addSucceededRun(id);
    const v2 = taskListDataVersion();
    expect(v2).not.toBe(v1);
    db.run(
      `INSERT INTO subagents (id, task_id, run_id, parent_kind, source_path, status, started_at) VALUES (?, ?, (SELECT id FROM runs WHERE task_id = ? LIMIT 1), 'subagent', '/tmp/agent-x.jsonl', 'running', ?)`,
      [randomUUID(), id, id, Date.now()],
    );
    const v3 = taskListDataVersion();
    expect(v3).not.toBe(v2);
    db.run(`DELETE FROM subagents WHERE task_id = ?`, [id]);
  });
});
