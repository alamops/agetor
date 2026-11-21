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
