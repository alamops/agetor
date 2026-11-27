// TS1: a core that dies mid-session and a new one that takes over the same data dir (docs/architecture/remote-gateway.md "Handoff"): the phone
// re-handshakes on its own and resumes each task stream from its cursor with no duplicate events. `kill -9`, not a clean stop: nothing runs.
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

async function makeTask(core: CoreHandle): Promise<string> {
  const res = await core.api("POST", "/tasks", { title: "handoff", prompt: "p", agent: "claude-code", workdir: core.dataDir, isolation: "none" });
  if (res.status !== 200 && res.status !== 201) throw new Error(`task create failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

function addEvents(core: CoreHandle, taskId: string, runId: string, from: number, to: number): void {
  const db = new Database(path.join(core.dataDir, "agetor.sqlite"));
  db.run("PRAGMA busy_timeout = 10000"); // the core is writing too
  try {
    if (from === 1) db.run(`INSERT INTO runs (id, task_id, agent, status, started_at) VALUES (?, ?, 'claude-code', 'succeeded', ?)`, [runId, taskId, Date.now()]);
    for (let i = from; i <= to; i++) db.run(`INSERT INTO run_events (run_id, stream, data, ts) VALUES (?, 'assistant', ?, ?)`, [runId, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `message ${i}` }] } }), Date.now()]);
  } finally {
    db.close();
  }
}

describe("handoff", () => {
  test("kill -9 core A mid-session, start core B on the same data dir: the phone re-handshakes and resumes from its cursor with no duplicates", async () => {
    const a = await startCore({ devices: [{ name: "Ana", level: "observe" }] });
    cores.push(a);
    const taskId = await makeTask(a);
    addEvents(a, taskId, "run-handoff-1", 1, 3);
    await until(() => coreOnRelay(a.relay), 15_000, "core A on the relay");
    const phone = a.devices[0]!.phone;
    await connectDevice(a);
    await phone.subscribeTask(taskId, { afterId: null });
    await until(() => phone.received("task-event").length >= 3, 8000, "the first three events");
    const seen = phone.received("task-event").map((m) => (m.event as { id: number }).id);
    expect(seen).toEqual([...seen].sort((x, y) => x - y));
    const cursor = Math.max(...seen);

    await a.kill9();
    // Core A is gone mid-session. Events written while nobody serves the port:
    addEvents(a, taskId, "run-handoff-1", 4, 6);

    const b = await startCore({ reuse: { dataDir: a.dataDir, helperDir: a.helperDir, relay: a.relay, devices: a.devices, corePub: a.corePub } });
    cores.push(b);
    await until(() => coreOnRelay(b.relay), 20_000, "core B on the relay");
    const before = phone.received("task-event").length;
    await connectDevice(b);
    await phone.subscribeTask(taskId, { afterId: cursor });
    await until(() => phone.received("task-event").length - before >= 3, 8000, "events 4 to 6");
    const resumed = phone.received("task-event").slice(before).map((m) => (m.event as { id: number }).id);
    // exactly the events after the cursor, each once
    expect(resumed.filter((id) => id <= cursor)).toEqual([]);
    expect(new Set(resumed).size).toBe(resumed.length);
    expect(Math.max(...resumed)).toBeGreaterThan(cursor);
    // the whole run, seen across both cores, has no id twice
    const all = phone.received("task-event").map((m) => (m.event as { id: number }).id);
    expect(new Set(all).size).toBe(all.length);
  }, 120_000);

  test("a phone that connects to the new core with a cursor from the old one gets a snapshot request, not garbage, when the cursor is ahead of the log", async () => {
    const core = await startCore({ devices: [{ name: "Ana", level: "observe" }] });
    cores.push(core);
    const taskId = await makeTask(core);
    addEvents(core, taskId, "run-handoff-2", 1, 2);
    await until(() => coreOnRelay(core.relay), 15_000, "the core on the relay");
    await connectDevice(core);
    const phone = core.devices[0]!.phone;
    await phone.subscribeTask(taskId, { afterId: 999_999 });
    const meta = await phone.next<{ meta: { snapshotRequired?: boolean } }>("task-meta");
    expect(meta.meta.snapshotRequired).toBe(true);
  }, 90_000);
});
