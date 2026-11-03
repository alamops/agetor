import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  for (const id of ["opencode", "opencode-ks", "opencode-v1", "opencode-fp", "opencode-dead", "opencode-cold"]) await serverMod.stopOpencodeServer(id).catch(() => {});
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
/** The server no longer has this session executing (Stop/delete really interrupted it). */
async function expectInterrupted(sessionId: string): Promise<void> {
  const c = serverClient();
  for (let i = 0; i < 100 && sessionId in (await c.activeSessions()); i++) await sleep(50);
  expect(Object.keys(await c.activeSessions())).not.toContain(sessionId);
}
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

test("a message sent before the prompt reached the server still folds into the same turn", async () => {
  // A harness whose server is not running yet: starting it takes far longer than the send.
  db.harnesses.insert({ id: "opencode-cold", kind: "opencode", label: "OpenCode (cold)", bin: STUB_BIN });
  db.harnesses.setEnabled("opencode-cold", true);
  const task = await newTask({ prompt: `first ${fakeMarkers.slow}`, agent: "opencode-cold" });
  const runId = await start(task);
  const sent = await orch.sendInput(runId, "second");
  expect(sent).toMatchObject({ delivered: true, runId });
  // The turn is still running (it only ends on a Stop), and the message went into it.
  await waitFor(() => eventsOf(runId, "tool_use").length > 0, 30_000, "the tool step");
  expect(await orch.cancelRun(runId)).toBe(true);
  await settled(task.id, 20_000);
  // A steer that had been queued instead would start a second turn once this one stopped.
  await sleep(500);
  expect(runsOf(task.id)).toHaveLength(1);
  expect(eventsOf(runId, "user")).toHaveLength(2);
  expect(statusOf(runId).some((l) => l.includes("couldn't deliver"))).toBe(false);
});

test("a message sent while a Stop is in progress is queued as the next turn", async () => {
  const task = await newTask({ prompt: `run ${fakeMarkers.slow}` });
  const runId = await start(task);
  await waitFor(() => eventsOf(runId, "tool_use").length > 0, 30_000, "the tool step");
  const stopping = orch.cancelRun(runId); // the handle is flagged cancelled synchronously
  const sent = await orch.sendInput(runId, "after the stop");
  expect(sent).toMatchObject({ delivered: true, runId });
  await stopping;
  await waitFor(() => runsOf(task.id).length === 2 && allSettled(task.id), 40_000, "the queued turn");
  const [first, second] = runsOf(task.id);
  expect(first!.status).toBe("cancelled");
  expect(eventsOf(first!.id, "user")).toHaveLength(2); // both bubbles sit on the first run
  expect(eventsOf(second!.id, "user")).toHaveLength(1); // the queued turn is a run of its own, like every queued OpenCode turn
  expect(second!.opencodeSessionId).toBe(first!.opencodeSessionId);
  expect(assistantOf(second!.id)).toContain("ACK: after the stop");
});

test("Stop interrupts the session: run cancelled, task back to ready", async () => {
  const task = await newTask({ prompt: `run ${fakeMarkers.slow}` });
  const runId = await start(task);
  await waitFor(() => eventsOf(runId, "tool_use").length > 0, 30_000, "the tool step");
  const sid = sessionOf(task.id)!;
  expect(sid in (await serverClient().activeSessions())).toBe(true); // it is executing before the Stop
  expect(await orch.cancelRun(runId)).toBe(true);
  await settled(task.id, 20_000);
  expect(db.runs.get(runId)!.status).toBe("cancelled");
  expect(db.tasks.get(task.id)!.column).toBe("ready");
  await expectInterrupted(sid);
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
  const oldCardId = pending(task.id)[0]!.id;
  // The core goes away: turns detach (not settled), servers keep running; the next core adopts them.
  // A new process has an EMPTY card registry: only the server still knows the request.
  orch.stopOpencodeServerDriver();
  interactions.__testing.reset();
  expect(pending(task.id)).toHaveLength(0);
  serverMod.__forTest.forget();
  expect(serverMod.getOpencodeServer("opencode")).toBeNull();
  expect((await serverMod.adoptOpencodeServers()).map((h) => h.harnessId)).toContain("opencode");
  expect(db.runs.get(runId)!.status).toBe("running");
  expect(await orch.reconcileOrphans()).toBe(0); // reattached, nothing orphaned
  orch.startOpencodeServerDriver();
  await waitFor(() => statusOf(runId).some((s) => s.includes("reconnected to live session")), 30_000, "the reattach");
  // The reattached driver re-lists the server's open request and raises a NEW card for it.
  await waitFor(() => pending(task.id).length === 1, 30_000, "the card to be re-raised");
  const cardId = pending(task.id)[0]!.id;
  expect(cardId).not.toBe(oldCardId);
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

test("a wake for a task that was watched and then archived mints nothing", async () => {
  const task = await newTask({ prompt: "quick" });
  await start(task);
  await settled(task.id);
  const sid = sessionOf(task.id)!;
  // Watched first: the refusal below is the archived check, not an unknown session.
  await waitFor(() => orch.__opencodeServerForTest.watchedTask("opencode", sid) === task.id, 10_000, "the wake watch");
  db.tasks.update(task.id, { column: "done" });
  const archived = await orch.archiveTask(task.id);
  expect(archived).not.toHaveProperty("error");
  orch.__opencodeServerForTest.wake("opencode", sid, { type: "session.execution.started", id: "evt_test_wake_4", created: Date.now() });
  await sleep(300);
  expect(runsOf(task.id)).toHaveLength(1);
});

test("a wake never revives a task the user stopped, until their next message; parked columns refuse too", async () => {
  const task = await newTask({ prompt: `run ${fakeMarkers.slow}` });
  const runId = await start(task);
  await waitFor(() => eventsOf(runId, "tool_use").length > 0, 30_000, "the tool step");
  const sid = sessionOf(task.id)!;
  await waitFor(() => orch.__opencodeServerForTest.watchedTask("opencode", sid) === task.id, 10_000, "the wake watch");
  expect(await orch.cancelRun(runId)).toBe(true);
  await settled(task.id, 20_000);
  await expectInterrupted(sid);
  // Stopped by the user: the server starting something on the session is not a reason to run again.
  orch.__opencodeServerForTest.wake("opencode", sid, { type: "session.execution.started", id: "evt_test_wake_5", created: Date.now() });
  await sleep(300);
  expect(runsOf(task.id)).toHaveLength(1);
  // The user's next message ends the stop...
  const sent = await orch.sendInput(runId, "carry on");
  expect(sent).toMatchObject({ delivered: true });
  await waitFor(() => runsOf(task.id).length === 2 && allSettled(task.id), 40_000, "the follow-up turn");
  await waitFor(() => orch.__opencodeServerForTest.watchedTask("opencode", sid) === task.id, 10_000, "the wake watch again");
  // ...but a card parked in Done, Backlog or Blocked still refuses.
  for (const column of ["done", "backlog", "blocked"] as const) {
    db.tasks.update(task.id, { column });
    orch.__opencodeServerForTest.wake("opencode", sid, { type: "session.execution.started", id: `evt_test_wake_6_${column}`, created: Date.now() });
    await sleep(200);
    expect(runsOf(task.id)).toHaveLength(2);
  }
  // In review it wakes: the stop really was cleared.
  db.tasks.update(task.id, { column: "review" });
  orch.__opencodeServerForTest.wake("opencode", sid, { type: "session.execution.started", id: "evt_test_wake_7", created: Date.now() });
  await waitFor(() => runsOf(task.id).length === 3 && allSettled(task.id), 30_000, "the wake run");
  expect(runsOf(task.id)[2]!.origin).toBe("agent");
});

test("Stop on a held task (background child running) disposes the lingering handle; the child finishing wakes nothing", async () => {
  // Slow motion, so the child is still running when the Stop lands.
  await serverMod.stopOpencodeServer("opencode");
  setEnv("FAKE_OC_SPEED", "3");
  try {
    const task = await newTask({ prompt: `launch ${fakeMarkers.wake}` });
    const first = await start(task);
    await waitFor(() => db.runs.get(first)!.status === "succeeded", 60_000, "the first turn");
    await waitFor(() => db.subagents.listForTask(task.id).some((x) => x.status === "running"), 30_000, "the background child");
    expect(db.tasks.get(task.id)!.column).toBe("running"); // held
    expect(orch.__opencodeServerForTest.liveTurns().lingering).toBe(1);
    expect(await orch.cancelRun(first)).toBe(true);
    expect(orch.__opencodeServerForTest.liveTurns().lingering).toBe(0);
    await waitFor(() => !db.subagents.listForTask(task.id).some((x) => x.status === "running"), 20_000, "the child row to settle");
    // The server finishes the child and hands its result to the parent; with no stop-marker that was a wake.
    await sleep(6000);
    expect(runsOf(task.id)).toHaveLength(1);
    expect(db.tasks.get(task.id)!.column).not.toBe("running");
  } finally {
    await serverMod.stopOpencodeServer("opencode");
    setEnv("FAKE_OC_SPEED", "0.1");
  }
});

test("restart with a held task: the next core listens for the child again instead of orphaning it, and the wake still lands", async () => {
  await serverMod.stopOpencodeServer("opencode");
  setEnv("FAKE_OC_SPEED", "3");
  try {
    const task = await newTask({ prompt: `launch ${fakeMarkers.wake}` });
    const first = await start(task);
    await waitFor(() => db.runs.get(first)!.status === "succeeded", 60_000, "the first turn");
    await waitFor(() => db.subagents.listForTask(task.id).some((x) => x.status === "running"), 30_000, "the background child");
    orch.stopOpencodeServerDriver(); // the core goes away
    interactions.__testing.reset();
    serverMod.__forTest.forget();
    await serverMod.adoptOpencodeServers();
    expect(await orch.reconcileOrphans()).toBe(0);
    orch.startOpencodeServerDriver();
    // Not orphaned: still running, and a handle is listening for it.
    expect(db.subagents.listForTask(task.id).map((x) => x.status)).toContain("running");
    expect(db.subagents.listForTask(task.id).map((x) => x.status)).not.toContain("orphaned");
    expect(orch.__opencodeServerForTest.liveTurns().lingering).toBe(1);
    await waitFor(() => runsOf(task.id).length === 2 && allSettled(task.id), 60_000, "the wake run after the restart");
    expect(runsOf(task.id)[1]!.origin).toBe("agent");
  } finally {
    await serverMod.stopOpencodeServer("opencode");
    setEnv("FAKE_OC_SPEED", "0.1");
  }
});

test("Ask card answered with an empty reject stops the turn: run cancelled, task ready, not failed", async () => {
  const task = await newTask({ prompt: `do it ${fakeMarkers.permission}`, mode: "ask" });
  const runId = await start(task);
  await waitFor(() => pending(task.id).length === 1, 30_000, "the permission card");
  const sid = sessionOf(task.id)!;
  interactions.answerOpencodePermission(pending(task.id)[0]!.id, { decision: "reject" });
  await settled(task.id, 30_000);
  expect(db.runs.get(runId)!.status).toBe("cancelled");
  expect(db.tasks.get(task.id)!.column).toBe("ready");
  await expectInterrupted(sid);
});

test("the server's restart gate does not count the turn that is asking, but counts every other", async () => {
  const task = await newTask({ prompt: `run ${fakeMarkers.slow}` });
  const runId = await start(task);
  await waitFor(() => eventsOf(runId, "tool_use").length > 0, 30_000, "the tool step");
  const own = orch.__opencodeServerForTest.turnHooks("opencode", runId, task.id);
  const other = orch.__opencodeServerForTest.turnHooks("opencode", "some-other-run", "some-other-task");
  expect(own.isBusy()).toBe(false); // idle apart from itself: a changed config may restart the server
  expect(other.isBusy()).toBe(true); // a different turn is using it
  expect(await orch.cancelRun(runId)).toBe(true);
  await settled(task.id, 20_000);
});

test("a changed harness config restarts an otherwise idle server for the next turn (the turn doesn't count itself as busy)", async () => {
  db.harnesses.insert({ id: "opencode-fp", kind: "opencode", label: "OpenCode (fingerprint)", bin: STUB_BIN });
  db.harnesses.setEnabled("opencode-fp", true);
  const a = await newTask({ agent: "opencode-fp", prompt: "one" });
  const runA = await start(a);
  await settled(a.id);
  const before = serverMod.getOpencodeServer("opencode-fp")!;
  expect(before).not.toBeNull();
  db.harnesses.update("opencode-fp", { env: { AGETOR_TEST_FINGERPRINT: "changed" } });
  const b = await newTask({ agent: "opencode-fp", prompt: "two" });
  const runB = await start(b);
  await settled(b.id);
  const after = serverMod.getOpencodeServer("opencode-fp")!;
  expect(after.startedAt).not.toBe(before.startedAt); // a new server: the old one was idle
  expect(db.runs.get(runB)!.status).toBe("succeeded");
  expect(statusOf(runA).concat(statusOf(runB)).some((l) => l.includes("changed harness settings"))).toBe(false);
});

test("delete with a permission card open cancels the card and tears the turn down without hanging", async () => {
  const task = await newTask({ prompt: `do it ${fakeMarkers.permission}`, mode: "ask" });
  const runId = await start(task);
  await waitFor(() => pending(task.id).length === 1, 30_000, "the permission card");
  const sid = sessionOf(task.id)!;
  const t0 = Date.now();
  await orch.deleteTask(task.id);
  expect(Date.now() - t0).toBeLessThan(25_000);
  expect(pending(task.id)).toHaveLength(0);
  expect(db.tasks.get(task.id)).toBeNull();
  expect(db.runs.get(runId)).toBeNull();
  await waitFor(() => orch.__opencodeServerForTest.liveTurns().driving === 0, 10_000, "the turn to be forgotten");
  await expectInterrupted(sid);
});

test("the kill switch sends an OpenCode 2 turn down the legacy tmux path (no server, breadcrumb without agetor)", async () => {
  setEnv("AGETOR_TMUX_BIN", NO_TMUX);
  setEnv("AGETOR_OPENCODE_TRANSPORT", "run");
  try {
    db.harnesses.insert({ id: "opencode-ks", kind: "opencode", label: "OpenCode (kill switch)", bin: STUB_BIN });
    db.harnesses.setEnabled("opencode-ks", true);
    const task = await newTask({ agent: "opencode-ks", mode: "ask" });
    const res = await orch.startTask(task.id);
    const runId = "runId" in res ? res.runId : (db.runs.listForTask(task.id)[0]?.id ?? "");
    await settled(task.id);
    expect(statusOf(runId)[0]).toMatch(/^opencode 2\.x · server=(shared|standalone) · /);
    expect(serverMod.getOpencodeServer("opencode-ks")).toBeNull();
    // Ask can't show approvals without the driver: said so, and not as an OpenCode 1 limitation.
    expect(statusOf(runId).some((l) => l.includes("server driver, which is switched off"))).toBe(true);
    expect(statusOf(runId).some((l) => l.includes("Ask mode needs OpenCode 2"))).toBe(false);
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
  expect(await orch.runOpencodeIdleSweep(farFuture)).not.toContain("opencode");
  expect(serverMod.getOpencodeServer("opencode")).not.toBeNull();
  interactions.answerOpencodePermission(pending(task.id)[0]!.id, { decision: "once" });
  await settled(task.id);

  // (2) no agetor run, but the server is executing a session (a background subagent could be)
  const c = serverClient();
  const created = await c.createSession({ directory: WORKDIR, title: "outside agetor" });
  await c.prompt(created.id, { text: `run ${fakeMarkers.slow}`, delivery: "steer" });
  await sleep(300);
  expect(Object.keys(await c.activeSessions())).toContain(created.id);
  expect(await orch.runOpencodeIdleSweep(farFuture)).not.toContain("opencode");
  expect(serverMod.getOpencodeServer("opencode")).not.toBeNull();
  await c.interrupt(created.id);
  for (let i = 0; i < 100 && Object.keys(await c.activeSessions()).length > 0; i++) await sleep(50);

  // (3) idle, past the window: stopped, and its hub stream closed
  expect(await orch.runOpencodeIdleSweep(farFuture)).toContain("opencode");
  expect(serverMod.getOpencodeServer("opencode")).toBeNull();
});

test("a sweep classifies a dead server that can't be asked anything: stopped and forgotten, not retried forever", async () => {
  db.harnesses.insert({ id: "opencode-dead", kind: "opencode", label: "OpenCode (dead)", bin: STUB_BIN });
  db.harnesses.setEnabled("opencode-dead", true);
  const task = await newTask({ agent: "opencode-dead", prompt: "hi" });
  await start(task);
  await settled(task.id);
  expect(serverMod.getOpencodeServer("opencode-dead")).not.toBeNull();
  // The host dies behind the manager's back (only this harness's server).
  const hostPid = (JSON.parse(readFileSync(serverMod.__forTest.statePath("opencode-dead"), "utf8")) as { hostPid: number }).hostPid;
  process.kill(hostPid, "SIGKILL");
  await sleep(300);
  const stopped = await orch.runOpencodeIdleSweep(Date.now());
  expect(stopped).toContain("opencode-dead");
  expect(serverMod.getOpencodeServer("opencode-dead")).toBeNull();
});

test("quit: the before-quit decision stops idle servers synchronously; a hand-over to the background host and busy servers are left alone", async () => {
  const task = await newTask({ prompt: "again" });
  await start(task);
  await settled(task.id);
  expect(serverMod.getOpencodeServer("opencode")).not.toBeNull();
  await orch.runOpencodeIdleSweep(Date.now()); // the quit can't probe: it uses the last probe's answer
  // A hand-over (background host armed, not "quit completely") leaves every server running.
  expect(orch.stopOpencodeServersOnQuit({ completely: false, backgroundArmed: true })).toEqual([]);
  expect(serverMod.getOpencodeServer("opencode")).not.toBeNull();
  // A real quit with a card open: busy, untouched.
  const busy = await newTask({ prompt: `do it ${fakeMarkers.permission}`, mode: "ask" });
  await start(busy);
  await waitFor(() => pending(busy.id).length === 1, 30_000, "the permission card");
  expect(orch.stopOpencodeServersOnQuit({ completely: false, backgroundArmed: false })).toEqual([]);
  expect(serverMod.getOpencodeServer("opencode")).not.toBeNull();
  interactions.answerOpencodePermission(pending(busy.id)[0]!.id, { decision: "once" });
  await settled(busy.id);
  // A real quit, idle: stopped before the call returns (no await: the process exits right after).
  const stopped = orch.stopOpencodeServersOnQuit({ completely: false, backgroundArmed: false });
  expect(stopped).toEqual(["opencode"]);
  expect(serverMod.getOpencodeServer("opencode")).toBeNull();
  // "Quit completely" stops them even with the background host armed.
  const again = await newTask({ prompt: "once more" });
  await start(again);
  await settled(again.id);
  expect(orch.stopOpencodeServersOnQuit({ completely: true, backgroundArmed: true })).toEqual(["opencode"]);
  expect(serverMod.getOpencodeServer("opencode")).toBeNull();
  // The next turn starts a new server.
  const task2 = await newTask({ prompt: "after the quit" });
  const runId = await start(task2);
  await settled(task2.id);
  expect(db.runs.get(runId)!.status).toBe("succeeded");
  expect(serverMod.getOpencodeServer("opencode")).not.toBeNull();
});
