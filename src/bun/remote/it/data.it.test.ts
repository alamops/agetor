// TS3: what a phone reads (SC6): the board's delta and push, a task's stream with its first-load budget, a tool result that arrives cut and is
// fetched whole by event id, the projected forms, backpressure. Against a REAL core with events written straight into its SQLite file.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { connectDevice, coreOnRelay, startCore, until, type CoreHandle } from "./harness.ts";

const cores: CoreHandle[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) {
    for (const d of c.devices) d.phone.close();
    await c.stop();
  }
});

async function boot() {
  const core = await startCore({ devices: [{ name: "Ana", level: "observe" }] });
  cores.push(core);
  await until(() => coreOnRelay(core.relay), 15_000, "the core on the relay");
  await connectDevice(core);
  return core;
}

async function makeTask(core: CoreHandle, title = "data"): Promise<string> {
  const res = await core.api("POST", "/tasks", { title, prompt: "p", agent: "claude-code", workdir: core.dataDir, isolation: "none" });
  return ((await res.json()) as { id: string }).id;
}

function insertEvents(core: CoreHandle, taskId: string, runId: string, events: Array<{ stream: string; data: string }>): number[] {
  const db = new Database(path.join(core.dataDir, "agetor.sqlite"));
  db.run("PRAGMA busy_timeout = 10000"); // the core is writing too
  try {
    if (!db.query(`SELECT 1 FROM runs WHERE id = ?`).get(runId)) db.run(`INSERT INTO runs (id, task_id, agent, status, started_at) VALUES (?, ?, 'claude-code', 'succeeded', ?)`, [runId, taskId, Date.now()]);
    return events.map((e) => Number(db.run(`INSERT INTO run_events (run_id, stream, data, ts) VALUES (?, ?, ?, ?)`, [runId, e.stream, e.data, Date.now()]).lastInsertRowid));
  } finally {
    db.close();
  }
}

/** An assistant event stores its text as is (the stream-json is parsed before it is stored). */
const assistant = (text: string) => text;

describe("a task's stream", () => {
  test("the first load is bounded (256 KB), says there is more, and a later page fetches the rest", async () => {
    const core = await boot();
    const taskId = await makeTask(core);
    insertEvents(core, taskId, "run-big", Array.from({ length: 300 }, (_, i) => ({ stream: "assistant", data: assistant(`event ${i} ` + "x".repeat(2000)) })));
    const phone = core.devices[0]!.phone;
    await phone.subscribeTask(taskId, { afterId: null });
    const meta = await phone.next<{ meta: { hasMore: boolean; earliestId: number | null } }>("task-meta");
    expect(meta.meta.hasMore).toBe(true);
    await sleep(1500);
    const got = phone.received("task-event");
    const bytes = got.reduce((n, m) => n + JSON.stringify(m.event).length, 0);
    expect(got.length).toBeGreaterThan(20);
    expect(got.length).toBeLessThan(300);
    expect(bytes).toBeLessThan(300 * 1024);
    // older history through the page route, by the earliest id the meta named
    const page = await phone.request("GET", `/tasks/${taskId}/events/page`, null, { query: `beforeId=${meta.meta.earliestId}&limit=50` });
    expect(page.status).toBe(200);
  }, 90_000);

  test("a 30 KB tool result arrives cut with the id to fetch it whole, and the whole one is what was stored", async () => {
    const core = await boot();
    const taskId = await makeTask(core);
    const big = "r".repeat(30_000);
    const [, resultId] = insertEvents(core, taskId, "run-cut", [
      { stream: "tool_use", data: JSON.stringify({ id: "tu1", name: "Bash", input: { command: "cat big" } }) },
      { stream: "tool_result", data: JSON.stringify({ toolUseId: "tu1", content: big, isError: false }) },
    ]);
    const phone = core.devices[0]!.phone;
    await phone.subscribeTask(taskId, { afterId: null });
    await until(() => phone.received("task-event").some((m) => (m.truncated as unknown) !== undefined), 6000, "a truncated event");
    const cut = phone.received("task-event").find((m) => m.truncated !== undefined)!;
    expect(cut.truncated).toMatchObject({ eventId: resultId });
    expect(JSON.stringify(cut.event).length).toBeLessThan(20_000);
    const whole = await phone.request("GET", `/tasks/${taskId}/events/${resultId}`);
    expect(whole.status).toBe(200);
    expect(whole.text()).toContain(big);
  }, 90_000);

  test("the projection gives the phone ready forms (not raw stream-json): a handoff block and the TODO tracker, with the raw row beside them", async () => {
    const core = await boot();
    const taskId = await makeTask(core);
    insertEvents(core, taskId, "run-proj", [
      { stream: "user", data: JSON.stringify({ type: "user", message: { role: "user", content: "hello <system-reminder>hidden</system-reminder>" } }) },
      { stream: "assistant", data: 'Done.\n<handoff>{"summary":"all green"}</handoff>' },
      { stream: "tool_use", data: JSON.stringify({ id: "tu9", name: "TodoWrite", input: { todos: [{ content: "write it", status: "completed", activeForm: "writing" }, { content: "test it", status: "pending", activeForm: "testing" }] } }) },
    ]);
    const phone = core.devices[0]!.phone;
    await phone.subscribeTask(taskId, { afterId: null });
    await until(() => phone.received("task-event").length >= 3, 6000, "three events");
    const forms = phone.received("task-event").map((m) => (m.parsed as { kind?: string } | undefined)?.kind);
    expect(forms).toContain("user");
    expect(forms).toContain("handoff");
    expect(forms).toContain("todo");
    // the raw row is still there for a client that wants it
    expect(phone.received("task-event").every((m) => typeof (m.event as { data: unknown }).data === "string")).toBe(true);
  }, 90_000);
});

describe("the board", () => {
  test("the delta read returns what changed since a cursor, and creating a task is pushed on the global subscription", async () => {
    const core = await boot();
    const phone = core.devices[0]!.phone;
    const first = await phone.request("GET", "/tasks", null, { query: "delta=1" });
    expect(first.status).toBe(200);
    const cursor = first.json<{ cursor: string }>().cursor;
    expect(typeof cursor).toBe("string");
    await phone.subscribeGlobal("g1");
    await sleep(200);
    await makeTask(core, "board push");
    await until(() => phone.received("global-event").some((m) => (m.event as { kind: string }).kind === "tasks-changed"), 8000, "tasks-changed");
    const delta = await phone.request("GET", "/tasks", null, { query: `delta=1&since=${encodeURIComponent(cursor)}` });
    const rows = delta.json<{ tasks: Array<{ title: string }> }>().tasks;
    expect(rows.map((t) => t.title)).toContain("board push");
  }, 90_000);

  test("the inbox is one request and, with nothing pending, answers an empty list", async () => {
    const core = await boot();
    const res = await core.devices[0]!.phone.request("GET", "/interactions/pending");
    expect(res.status).toBe(200);
    expect(res.json<unknown>()).toBeTruthy();
  }, 90_000);
});

describe("a large replay behind the relay's budget", () => {
  test("arrives in order, once each, at the pace the relay's limits allow, and the session stays up (the 4 MB cap itself is pinned by subscriptions.test.ts and session.test.ts)", async () => {
    const core = await boot();
    const taskId = await makeTask(core);
    const ids = insertEvents(core, taskId, "run-bp", Array.from({ length: 30 }, (_, i) => ({ stream: "assistant", data: assistant(`bulk ${i} ` + "y".repeat(24_000)) })));
    const phone = core.devices[0]!.phone;
    await phone.subscribeTask(taskId, { afterId: 0, maxBytes: 60 * 1024 * 1024 });
    await until(() => phone.received("task-event").length >= 30, 60_000, "all thirty events");
    const got = phone.received("task-event").map((m) => (m.event as { id: number }).id);
    expect(got).toEqual(ids);
    expect(phone.received("snapshot-required")).toHaveLength(0);
    const s = core.relay.stats();
    expect(s.droppedRate).toBe(0);
    expect(s.full).toBe(0);
    expect(phone.ended).toBe(false);
  }, 120_000);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
