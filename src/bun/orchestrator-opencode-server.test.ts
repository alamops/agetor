import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Run, Task } from "../shared/types.ts";

// The orchestrator's wiring of the OpenCode v2 server driver
// (docs/plans/opencode-server-driver.md, T11): the REAL driver, hub and server
// manager against the fake OpenCode server (`fixtures/opencode/fake-serve.ts`,
// hosted by the stub binary as a child of this process, no tmux). Covers
// start, steer, queued steer, Stop, restart reattach, server wake (and its
// deferral), the transports that must NOT take the server path, the 402 hint,
// permission cards, delete with a card open, the idle sweep and the quit stop.

setDefaultTimeout(60_000);

// db.ts captures AGETOR_DATA_DIR at first import: top level, before any import of it.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-opencode-orch-server-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

const STUB_BIN = path.resolve(import.meta.dir, "fixtures/opencode/stub-opencode.sh");
const WORKDIR = path.join(DATA_DIR, "work");
mkdirSync(WORKDIR, { recursive: true });

/** A binary that answers `--version` / `auth` like an OpenCode 1.x build (the tmux path is chosen, never launched). */
const V1_BIN = path.join(DATA_DIR, "opencode-v1");
writeFileSync(V1_BIN, ['#!/bin/sh', 'if [ "$1" = "--version" ]; then echo "1.19.4"; exit 0; fi', 'if [ "$1" = "auth" ]; then echo "[]"; exit 0; fi', "exit 0", ""].join("\n"));
chmodSync(V1_BIN, 0o755);
/** A tmux that refuses everything: a launch through the legacy driver fails at once, after its breadcrumb is written. */
const NO_TMUX = path.join(DATA_DIR, "tmux-refuses");
writeFileSync(NO_TMUX, "#!/bin/sh\nexit 1\n");
chmodSync(NO_TMUX, 0o755);

let db: typeof import("./db.ts");
let orch: typeof import("./orchestrator.ts");
let serverMod: typeof import("./opencode-server.ts");
let hubMod: typeof import("./opencode-hub.ts");
let interactions: typeof import("./interactions.ts");
let http: typeof import("./opencode-http.ts");
let subagentsMod: typeof import("./opencode-subagents.ts");
let fakeMarkers: typeof import("./fixtures/opencode/fake-serve.ts").FAKE_OC_MARKERS;
let restoreHarnesses: (() => void) | undefined;

beforeAll(async () => {
  // Other files in this process leave their own values behind (the fake driver, a fake tmux, a stub bin).
  setEnv("AGETOR_OPENCODE_DRIVER", undefined);
  setEnv("AGETOR_OPENCODE_TRANSPORT", undefined);
  setEnv("AGETOR_OPENCODE_BIN", STUB_BIN);
  setEnv("AGETOR_OPENCODE_SERVER_HOST", "direct");
  setEnv("FAKE_OC_BUN", process.execPath);
  setEnv("FAKE_OC_SPEED", "0.1");
  setEnv("FAKE_OC_HEARTBEAT_MS", "60000");
  db = await import("./db.ts");
  restoreHarnesses = (await import("./test-harness-state.ts")).snapshotHarnessState();
  orch = await import("./orchestrator.ts");
  serverMod = await import("./opencode-server.ts");
  hubMod = await import("./opencode-hub.ts");
  interactions = await import("./interactions.ts");
  http = await import("./opencode-http.ts");
  subagentsMod = await import("./opencode-subagents.ts");
  fakeMarkers = (await import("./fixtures/opencode/fake-serve.ts")).FAKE_OC_MARKERS;
  db.harnesses.setEnabled("opencode", true);
  // Boot order: servers adopted, orphans reconciled, THEN the wake handler.
  await serverMod.adoptOpencodeServers();
  await orch.reconcileOrphans();
  orch.startOpencodeServerDriver();
});

afterAll(async () => {
  orch.stopOpencodeServerDriver();
  hubMod.closeOpencodeHub();
  for (const id of ["opencode", "opencode-ks", "opencode-v1"]) await serverMod.stopOpencodeServer(id).catch(() => {});
  serverMod.__forTest.reapDirect();
  serverMod.__forTest.forget();
  restoreHarnesses?.();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const { rmTestDataDir } = await import("./test-data-dir.ts");
  rmTestDataDir(DATA_DIR);
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 30_000, what = "condition"): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

async function newTask(over: Partial<Parameters<typeof orch.createTask>[0]> = {}): Promise<Task> {
  const created = await orch.createTask({
    title: "opencode server task",
    prompt: "hello",
    agent: "opencode",
    workdir: WORKDIR,
    isolation: "none",
    taskType: "task",
    ...over,
  });
  if ("error" in created) throw new Error(created.error);
  return created.task;
}
async function start(task: Task): Promise<string> {
  const res = await orch.startTask(task.id);
  if ("error" in res) throw new Error(res.error);
  return res.runId;
}
/** Runs oldest first. */
const runsOf = (taskId: string): Run[] => [...db.runs.listForTask(taskId)].reverse();
const allSettled = (taskId: string) => db.runs.listForTask(taskId).length > 0 && db.runs.listForTask(taskId).every((r) => r.status !== "running");
const settled = (taskId: string, ms?: number) => waitFor(() => allSettled(taskId), ms, `task ${taskId} to settle`);
const eventsOf = (runId: string, stream: string) => db.runs.events(runId).filter((e) => e.stream === stream && e.subagentId == null).map((e) => e.data);
const statusOf = (runId: string) => eventsOf(runId, "status");
const assistantOf = (runId: string) => eventsOf(runId, "assistant").join("\n");
const pending = (taskId: string) => interactions.listPendingForTask(taskId);
const sessionOf = (taskId: string) => db.runs.sessionIdsForTask(taskId, "opencode_session_id")[0]?.sessionId ?? null;
const serverClient = () => {
  const h = serverMod.getOpencodeServer("opencode");
  if (!h) throw new Error("no OpenCode server is running");
  return http.createOpencodeClient({ url: h.url, password: h.password });
};

test("start: the turn runs on the agetor-owned server, breadcrumb server=agetor, review", async () => {
  const task = await newTask({ prompt: "hello   there" });
  const runId = await start(task);
  await settled(task.id);
  const run = db.runs.get(runId)!;
  expect(run.status).toBe("succeeded");
  expect(db.tasks.get(task.id)!.column).toBe("review");
  expect(run.opencodeSessionId).toMatch(/^ses_/);
  expect(statusOf(runId)[0]).toMatch(/^opencode 2\.x · server=agetor · /);
  expect(subagentsMod.opencodeTurnOfRun(runId)).toEqual({ major: 2, server: "agetor" });
  expect(assistantOf(runId)).toContain("ACK: hello there");
  expect(serverMod.getOpencodeServer("opencode")).not.toBeNull();
  // The session is watched for a server wake once it has a session.
  await waitFor(() => orch.__opencodeServerForTest.watchedTask("opencode", run.opencodeSessionId!) === task.id, 10_000, "the wake watch");
});

test("steer: a message sent mid-turn folds into the same run (no new run row)", async () => {
  const task = await newTask({ prompt: `go ${fakeMarkers.steer}` });
  const runId = await start(task);
  await waitFor(() => eventsOf(runId, "tool_use").length > 0, 30_000, "the tool step");
  const sent = await orch.sendInput(runId, "BANANA");
  expect(sent).toMatchObject({ delivered: true, runId });
  await settled(task.id);
  expect(runsOf(task.id).length).toBe(1);
  expect(db.runs.get(runId)!.status).toBe("succeeded");
  expect(assistantOf(runId)).toContain("[steer: BANANA]");
  expect(eventsOf(runId, "user")).toHaveLength(2);
  expect(statusOf(runId).some((s) => s.includes("couldn't deliver"))).toBe(false);
});

test("a steer the server can't take yet is queued as the next turn, with a status line", async () => {
  const task = await newTask({ prompt: "first" });
  const runId = await start(task);
  // The prompt has not been sent (server, session and subscription come first): steer answers "unavailable".
  const sent = await orch.sendInput(runId, "second");
  expect(sent).toMatchObject({ delivered: true, runId });
  await waitFor(() => runsOf(task.id).length === 2 && allSettled(task.id), 40_000, "the queued turn");
  const [first, second] = runsOf(task.id);
  expect(statusOf(first!.id).some((s) => s.includes("couldn't deliver to the running OpenCode turn — sending it next"))).toBe(true);
  expect(eventsOf(first!.id, "user")).toHaveLength(2); // both bubbles sit on the first run
  expect(eventsOf(second!.id, "user")).toHaveLength(1); // the queued turn is a run of its own, like every queued OpenCode turn
  expect(second!.opencodeSessionId).toBe(first!.opencodeSessionId);
  expect(assistantOf(second!.id)).toContain("ACK: second");
});

test("Stop interrupts the session: run cancelled, task back to ready", async () => {
  const task = await newTask({ prompt: `run ${fakeMarkers.slow}` });
  const runId = await start(task);
  await waitFor(() => eventsOf(runId, "tool_use").length > 0, 30_000, "the tool step");
  expect(await orch.cancelRun(runId)).toBe(true);
  await settled(task.id, 20_000);
  expect(db.runs.get(runId)!.status).toBe("cancelled");
  expect(db.tasks.get(task.id)!.column).toBe("ready");
});

test("a provider 402 fails the run with the error line and the quota hint", async () => {
  const task = await newTask({ prompt: `fail ${fakeMarkers.error}` });
  const runId = await start(task);
  await settled(task.id);
  expect(db.runs.get(runId)!.status).toBe("failed");
  expect(db.tasks.get(task.id)!.column).toBe("ready");
  const line = statusOf(runId).find((s) => s.startsWith("opencode: Upstream request failed"));
  expect(line).toBeDefined();
  expect(line).toContain("Go subscription");
});

test("Ask mode: the permission card is answered through the registry, the turn continues", async () => {
  const task = await newTask({ prompt: `do it ${fakeMarkers.permission}`, mode: "ask" });
  const runId = await start(task);
  await waitFor(() => pending(task.id).length === 1, 30_000, "the permission card");
  expect(pending(task.id)[0]).toMatchObject({ taskId: task.id, runId });
  expect(interactions.answerOpencodePermission(pending(task.id)[0]!.id, { decision: "once" })).toBe(true);
  await settled(task.id);
  expect(db.runs.get(runId)!.status).toBe("succeeded");
  expect(assistantOf(runId)).toContain("The command ran: hi");
  expect(pending(task.id)).toHaveLength(0);
});

test("restart: a running server turn reattaches over HTTP and its run completes once", async () => {
  const task = await newTask({ prompt: `do it ${fakeMarkers.permission}`, mode: "ask" });
  const runId = await start(task);
  await waitFor(() => pending(task.id).length === 1, 30_000, "the permission card");
  const cardId = pending(task.id)[0]!.id;
  // The core goes away: turns detach (not settled), servers keep running; the next core adopts them.
  orch.stopOpencodeServerDriver();
  serverMod.__forTest.forget();
  expect(serverMod.getOpencodeServer("opencode")).toBeNull();
  expect((await serverMod.adoptOpencodeServers()).map((h) => h.harnessId)).toContain("opencode");
  expect(db.runs.get(runId)!.status).toBe("running");
  expect(await orch.reconcileOrphans()).toBe(0); // reattached, nothing orphaned
  orch.startOpencodeServerDriver();
  await waitFor(() => statusOf(runId).some((s) => s.includes("reconnected to live session")), 30_000, "the reattach");
  // The same card, still open; answer it and the one run finishes.
  await waitFor(() => orch.__opencodeServerForTest.liveTurns().driving === 1, 30_000, "the reattached turn");
  // The card never left the registry; the new driver takes it over once its catch-up has run.
  await sleep(1500);
  expect(pending(task.id).map((c) => c.id)).toEqual([cardId]);
  interactions.answerOpencodePermission(cardId, { decision: "once" });
  await settled(task.id);
  expect(runsOf(task.id)).toHaveLength(1);
  expect(db.runs.get(runId)!.status).toBe("succeeded");
  expect(assistantOf(runId).split("The command ran: hi").length).toBe(2); // once, not twice
  expect(db.tasks.get(task.id)!.column).toBe("review");
});

test("restart with no server for a server run: the run is orphaned and the task goes to ready", async () => {
  const task = await newTask({ prompt: `run ${fakeMarkers.slow}` });
  const runId = await start(task);
  await waitFor(() => eventsOf(runId, "tool_use").length > 0, 30_000, "the tool step");
  orch.stopOpencodeServerDriver();
  await serverMod.stopOpencodeServer("opencode"); // the host died with the machine
  expect(await orch.reconcileOrphans()).toBe(1);
  expect(db.runs.get(runId)!.status).toBe("orphaned");
  expect(db.tasks.get(task.id)!.column).toBe("ready");
  orch.startOpencodeServerDriver();
});

test("server wake: a background child finishing mints a run with origin agent, card running then review", async () => {
  const task = await newTask({ prompt: `launch ${fakeMarkers.wake}` });
  const first = await start(task);
  await waitFor(() => runsOf(task.id).length === 2 && allSettled(task.id), 45_000, "the wake run");
  const [a, b] = runsOf(task.id);
  expect(a!.id).toBe(first);
  expect(a!.origin ?? null).toBeNull();
  expect(b!.origin).toBe("agent");
  expect(b!.status).toBe("succeeded");
  expect(b!.opencodeSessionId).toBe(a!.opencodeSessionId);
  expect(statusOf(b!.id)[0]).toMatch(/server=agetor/);
  expect(assistantOf(b!.id)).toContain("The background subagent finished");
  expect(assistantOf(b!.id)).not.toContain("LAUNCHED");
  await waitFor(() => db.tasks.get(task.id)!.column === "review", 15_000, "the card to reach review");
});

test("wake while the task's own turn is live is deferred, then minted after that run settles (no lost reply)", async () => {
  const task = await newTask({ prompt: `do it ${fakeMarkers.permission}`, mode: "ask" });
  const runId = await start(task);
  await waitFor(() => pending(task.id).length === 1, 30_000, "the permission card");
  const sid = sessionOf(task.id)!;
  await waitFor(() => orch.__opencodeServerForTest.watchedTask("opencode", sid) === task.id, 10_000, "the wake watch");
  orch.__opencodeServerForTest.wake("opencode", sid, { type: "session.execution.started", id: "evt_test_wake_1", created: Date.now() });
  await sleep(100);
  expect(runsOf(task.id)).toHaveLength(1); // refused for now: same live turn
  expect(orch.__opencodeServerForTest.deferredWakes()).toBe(1);
  interactions.answerOpencodePermission(pending(task.id)[0]!.id, { decision: "once" });
  await waitFor(() => runsOf(task.id).length === 2 && allSettled(task.id), 40_000, "the deferred wake run");
  expect(db.runs.get(runId)!.status).toBe("succeeded");
  const second = runsOf(task.id)[1]!;
  expect(second.origin).toBe("agent");
  expect(second.opencodeSessionId).toBe(sid);
  expect(orch.__opencodeServerForTest.deferredWakes()).toBe(0);
});

test("a wake that arrived during a turn the user then stops is dropped, not minted", async () => {
  const task = await newTask({ prompt: `run ${fakeMarkers.slow}` });
  const runId = await start(task);
  await waitFor(() => eventsOf(runId, "tool_use").length > 0, 30_000, "the tool step");
  const sid = sessionOf(task.id)!;
  await waitFor(() => orch.__opencodeServerForTest.watchedTask("opencode", sid) === task.id, 10_000, "the wake watch");
  orch.__opencodeServerForTest.wake("opencode", sid, { type: "session.execution.started", id: "evt_test_wake_2", created: Date.now() });
  expect(orch.__opencodeServerForTest.deferredWakes()).toBe(1);
  expect(await orch.cancelRun(runId)).toBe(true);
  await settled(task.id, 20_000);
  await sleep(300);
  expect(runsOf(task.id)).toHaveLength(1);
  expect(orch.__opencodeServerForTest.deferredWakes()).toBe(0);
});

test("a wake for a session nobody watches (archived, unknown) mints nothing", async () => {
  const task = await newTask({ prompt: "quick" });
  await start(task);
  await settled(task.id);
  const sid = sessionOf(task.id)!;
  orch.__opencodeServerForTest.wake("opencode", "ses_unknownsession", { type: "session.execution.started", id: "evt_test_wake_3", created: Date.now() });
  db.tasks.update(task.id, { column: "done" });
  const archived = await orch.archiveTask(task.id);
  expect(archived).not.toHaveProperty("error");
  orch.__opencodeServerForTest.wake("opencode", sid, { type: "session.execution.started", id: "evt_test_wake_4", created: Date.now() });
  await sleep(300);
  expect(runsOf(task.id)).toHaveLength(1);
});

test("delete with a permission card open cancels the card and tears the turn down without hanging", async () => {
  const task = await newTask({ prompt: `do it ${fakeMarkers.permission}`, mode: "ask" });
  const runId = await start(task);
  await waitFor(() => pending(task.id).length === 1, 30_000, "the permission card");
  const t0 = Date.now();
  await orch.deleteTask(task.id);
  expect(Date.now() - t0).toBeLessThan(25_000);
  expect(pending(task.id)).toHaveLength(0);
  expect(db.tasks.get(task.id)).toBeNull();
  expect(db.runs.get(runId)).toBeNull();
  await waitFor(() => orch.__opencodeServerForTest.liveTurns().driving === 0, 10_000, "the turn to be forgotten");
});

test("the kill switch sends an OpenCode 2 turn down the legacy tmux path (no server, breadcrumb without agetor)", async () => {
  setEnv("AGETOR_TMUX_BIN", NO_TMUX);
  setEnv("AGETOR_OPENCODE_TRANSPORT", "run");
  try {
    db.harnesses.insert({ id: "opencode-ks", kind: "opencode", label: "OpenCode (kill switch)", bin: STUB_BIN });
    db.harnesses.setEnabled("opencode-ks", true);
    const task = await newTask({ agent: "opencode-ks" });
    const res = await orch.startTask(task.id);
    const runId = "runId" in res ? res.runId : (db.runs.listForTask(task.id)[0]?.id ?? "");
    await settled(task.id);
    expect(statusOf(runId)[0]).toMatch(/^opencode 2\.x · server=(shared|standalone) · /);
    expect(serverMod.getOpencodeServer("opencode-ks")).toBeNull();
  } finally {
    setEnv("AGETOR_OPENCODE_TRANSPORT", undefined);
    setEnv("AGETOR_TMUX_BIN", savedEnv.AGETOR_TMUX_BIN);
  }
});

test("an OpenCode 1.x CLI takes the tmux path; Ask there runs without approvals and says so", async () => {
  setEnv("AGETOR_TMUX_BIN", NO_TMUX);
  try {
    db.harnesses.insert({ id: "opencode-v1", kind: "opencode", label: "OpenCode 1", bin: V1_BIN });
    db.harnesses.setEnabled("opencode-v1", true);
    const task = await newTask({ agent: "opencode-v1", mode: "ask" });
    const res = await orch.startTask(task.id);
    const runId = "runId" in res ? res.runId : (db.runs.listForTask(task.id)[0]?.id ?? "");
    await settled(task.id);
    expect(statusOf(runId)[0]).toMatch(/^opencode 1\.x · server=n\/a · /);
    expect(statusOf(runId).some((s) => s.includes("Ask mode needs OpenCode 2"))).toBe(true);
    expect(serverMod.getOpencodeServer("opencode-v1")).toBeNull();
  } finally {
    setEnv("AGETOR_TMUX_BIN", savedEnv.AGETOR_TMUX_BIN);
  }
});

test("idle sweep: a server a turn or card is using, or that has an executing session, is never stopped", async () => {
  const farFuture = Date.now() + 60 * 60_000;
  // (1) a card is open
  const task = await newTask({ prompt: `do it ${fakeMarkers.permission}`, mode: "ask" });
  await start(task);
  await waitFor(() => pending(task.id).length === 1, 30_000, "the permission card");
  expect(await orch.runOpencodeIdleSweep(farFuture)).toEqual([]);
  expect(serverMod.getOpencodeServer("opencode")).not.toBeNull();
  interactions.answerOpencodePermission(pending(task.id)[0]!.id, { decision: "once" });
  await settled(task.id);

  // (2) no agetor run, but the server is executing a session (a background subagent could be)
  const c = serverClient();
  const created = await c.createSession({ directory: WORKDIR, title: "outside agetor" });
  await c.prompt(created.id, { text: `run ${fakeMarkers.slow}`, delivery: "steer" });
  await sleep(300);
  expect(Object.keys(await c.activeSessions())).toContain(created.id);
  expect(await orch.runOpencodeIdleSweep(farFuture)).toEqual([]);
  expect(serverMod.getOpencodeServer("opencode")).not.toBeNull();
  await c.interrupt(created.id);
  for (let i = 0; i < 100 && Object.keys(await c.activeSessions()).length > 0; i++) await sleep(50);

  // (3) idle, past the window: stopped, and its hub stream closed
  expect(await orch.runOpencodeIdleSweep(farFuture)).toEqual(["opencode"]);
  expect(serverMod.getOpencodeServer("opencode")).toBeNull();
});

test("a real quit stops an idle server; the next turn starts a new one", async () => {
  const task = await newTask({ prompt: "again" });
  await start(task);
  await settled(task.id);
  expect(serverMod.getOpencodeServer("opencode")).not.toBeNull();
  await orch.stopIdleOpencodeServersOnRealQuit();
  expect(serverMod.getOpencodeServer("opencode")).toBeNull();
  // A follow-up on the same session starts a fresh server and resumes (the fake server keeps no state across restarts: fresh session).
  const task2 = await newTask({ prompt: "after the quit" });
  const runId = await start(task2);
  await settled(task2.id);
  expect(db.runs.get(runId)!.status).toBe("succeeded");
  expect(serverMod.getOpencodeServer("opencode")).not.toBeNull();
});
