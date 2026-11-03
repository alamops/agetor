import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Run, Task } from "../shared/types.ts";

// The orchestrator's wiring of the OpenCode v2 server driver
// (docs/plans/opencode-server-driver.md, T11): the REAL driver, hub and server
// manager against the fake OpenCode server (`fixtures/opencode/fake-serve.ts`,
// hosted by the stub binary as a child of this process, no tmux). Covers
// start, steer, queued steer, Stop, restart reattach, server wake (its
// deferral, and plan R3: a wake after a Stop or onto a parked card runs, one
// with no card is interrupted), the transports that must NOT take the server
// path, the 402 hint, permission cards, delete with a card open, a server crash
// mid-turn, the idle sweep and the quit stop. The Stop-tail (R4) and
// gone-task (R3) tests run through the hub's real event order: nothing feeds
// the wake handler by hand there.

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
/** The stub behind a `--version` that takes 3 s while SLOW_VERSION_FLAG exists (a follow-up's version probe holds its spawn). */
const SLOW_VERSION_FLAG = path.join(DATA_DIR, "slow-version");
const SLOW_VERSION_BIN = path.join(DATA_DIR, "opencode-slow-version");
writeFileSync(SLOW_VERSION_BIN, ["#!/bin/sh", `if [ "$1" = "--version" ] && [ -f "${SLOW_VERSION_FLAG}" ]; then sleep 3; fi`, `exec "${STUB_BIN}" "$@"`, ""].join("\n"));
chmodSync(SLOW_VERSION_BIN, 0o755);
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
let agentStatus: typeof import("./agent-status.ts");
let driverMod: typeof import("./opencode-driver.ts");
let ocsMod: typeof import("./orchestrator-opencode-server.ts");
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
  // Well under the hub's 45 s stall watchdog, so a quiet stream is never read as stalled.
  setEnv("FAKE_OC_HEARTBEAT_MS", "2000");
  // Sibling files leave a fake tmux (often /bin/echo) behind: this file's
  // servers run on the direct host, and the legacy-path tests pin their own.
  setEnv("AGETOR_TMUX_BIN", undefined);
  db = await import("./db.ts");
  restoreHarnesses = (await import("./test-harness-state.ts")).snapshotHarnessState();
  orch = await import("./orchestrator.ts");
  serverMod = await import("./opencode-server.ts");
  hubMod = await import("./opencode-hub.ts");
  interactions = await import("./interactions.ts");
  http = await import("./opencode-http.ts");
  subagentsMod = await import("./opencode-subagents.ts");
  agentStatus = await import("./agent-status.ts");
  driverMod = await import("./opencode-driver.ts");
  ocsMod = await import("./orchestrator-opencode-server.ts");
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
  hubMod.__forTest.resetBackoff();
  interactions.__testing.reset();
  for (const id of HARNESS_IDS) await serverMod.stopOpencodeServer(id).catch(() => {});
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

/** Every harness a test here starts a server for (afterAll stops them all). */
const HARNESS_IDS = [
  "opencode", "opencode-ks", "opencode-v1", "opencode-fp", "opencode-fp2", "opencode-dead", "opencode-cold",
  "opencode-cold2", "opencode-cold3", "opencode-slow", "opencode-crash", "opencode-s1",
  "opencode-r4", "opencode-r4b", "opencode-r4c", "opencode-sf1", "opencode-sf3", "opencode-sf5", "opencode-stuck", "opencode-crash2", "opencode-gone",
];
/** A fake running at this speed answers slowly enough that an interrupt sent at an execution's start always lands before it ends. */
const R4_SPEED = "50";

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
/** How the session's last execution ended, from its newest `idle` record on the fake (null: none yet). */
async function lastIdleOutcome(sessionId: string, harnessId = "opencode"): Promise<string | null> {
  const page = await serverClient(harnessId).listMessages(sessionId, { limit: 50, order: "desc" });
  const idle = page.data.find((m: { type?: string }) => m?.type === "idle") as { outcome?: string } | undefined;
  return idle?.outcome ?? null;
}
/** The session's last execution was INTERRUPTED (not merely over: one that finished on its own fails this). */
async function expectInterrupted(sessionId: string, harnessId = "opencode"): Promise<void> {
  const c = serverClient(harnessId);
  for (let i = 0; i < 200 && sessionId in (await c.activeSessions()); i++) await sleep(50);
  expect(Object.keys(await c.activeSessions())).not.toContain(sessionId);
  expect(await lastIdleOutcome(sessionId, harnessId)).toBe("interrupted");
}
/** Wake decisions the orchestrator took for a session. */
const wakesOf = (sessionId: string) => orch.__opencodeServerForTest.wakeLog().filter((w) => w.sessionId === sessionId).map((w) => w.outcome);
/**
 * Once the parent is idle: its "subagent cancelled" notices, each either
 * delivered in an execution (with how that execution ended) or still parked in
 * the inbox (OpenCode parks input left pending by an interrupt).
 */
async function cancelledNotices(sessionId: string, harnessId: string): Promise<{ delivered: (string | null)[]; parked: number }> {
  const c = serverClient(harnessId);
  for (let i = 0; i < 400 && sessionId in (await c.activeSessions()); i++) await sleep(25);
  const msgs = (await c.listMessages(sessionId, { limit: 200, order: "asc" })).data as { type?: string; outcome?: string; metadata?: { state?: string } }[];
  const delivered: (string | null)[] = [];
  msgs.forEach((m, i) => {
    if (m.type !== "synthetic" || m.metadata?.state !== "cancelled") return;
    const idle = msgs.slice(i + 1).find((x) => x.type === "idle");
    delivered.push(idle?.outcome ?? null);
  });
  const parked = (await c.listInbox(sessionId)).filter((x) => x.type === "synthetic" && x.metadata?.state === "cancelled").length;
  return { delivered, parked };
}
/** A harness whose fake server runs at `speed` (its env reaches the server it starts). */
function addSlowHarness(id: string, speed = R4_SPEED, bin = STUB_BIN, env: Record<string, string> = {}): void {
  addHarness(id, bin);
  db.harnesses.update(id, { env: { FAKE_OC_SPEED: speed, ...env } });
}
const serverClient = (harnessId = "opencode") => {
  const h = serverMod.getOpencodeServer(harnessId);
  if (!h) throw new Error("no OpenCode server is running");
  return http.createOpencodeClient({ url: h.url, password: h.password });
};
/** Start an execution on `sessionId` from outside agetor (what a background child's result does). */
async function executeOnServer(sessionId: string, text: string, harnessId = "opencode"): Promise<void> {
  const c = serverClient(harnessId);
  const idles = async () =>
    (await c.listMessages(sessionId, { limit: 200, order: "desc" })).data.filter((m: { type?: string }) => m?.type === "idle").length;
  const before = await idles();
  await c.prompt(sessionId, { text, delivery: "steer" });
  // Started: executing now, or already over (an interrupt may end it within milliseconds).
  for (let i = 0; i < 200; i++) {
    if (sessionId in (await c.activeSessions()) || (await idles()) > before) return;
    await sleep(25);
  }
  throw new Error(`no execution started on ${sessionId}`);
}
/** The run's done handler has finished (its last line is the exit status). */
const doneHandled = (runId: string) => statusOf(runId).some((l) => /^(cancelled \(exit:|exit:|cancelled$)/.test(l));
function addHarness(id: string, bin = STUB_BIN): void {
  db.harnesses.insert({ id, kind: "opencode", label: `OpenCode (${id})`, bin });
  db.harnesses.setEnabled(id, true);
}
const hostPidOf = (harnessId: string) =>
  (JSON.parse(readFileSync(serverMod.__forTest.statePath(harnessId), "utf8")) as { hostPid: number }).hostPid;

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

test("a message steered into a turn that is stopped before OpenCode delivered it becomes the next turn; nothing is left parked in the inbox", async () => {
  // A harness whose server is not running yet: starting it takes far longer than the send.
  addHarness("opencode-cold");
  const task = await newTask({ prompt: `first ${fakeMarkers.slow}`, agent: "opencode-cold" });
  const runId = await start(task);
  const sent = await orch.sendInput(runId, "second");
  expect(sent).toMatchObject({ delivered: true, runId });
  // The turn is still running (it only ends on a Stop): the message went into
  // it, and waits in OpenCode's inbox (the tool step never reaches a boundary).
  await waitFor(() => eventsOf(runId, "tool_use").length > 0, 30_000, "the tool step");
  const sid = sessionOf(task.id)!;
  await waitFor(() => eventsOf(runId, "user").length === 2, 10_000, "the steered bubble");
  expect(await orch.cancelRun(runId)).toBe(true);
  await waitFor(() => doneHandled(runId), 20_000, "the done handler");
  expect(db.runs.get(runId)!.status).toBe("cancelled");
  // OpenCode parks input an interrupt left pending (it would deliver it with
  // the next prompt): the Stop takes it back out and sends it as the next turn.
  await waitFor(() => runsOf(task.id).length === 2 && allSettled(task.id), 30_000, "the requeued turn");
  const [first, next] = runsOf(task.id);
  expect(first!.id).toBe(runId);
  expect(next!.origin ?? null).toBeNull(); // the user's turn, not a wake
  expect(next!.status).toBe("succeeded");
  expect(next!.opencodeSessionId).toBe(sid);
  expect(assistantOf(next!.id)).toContain("ACK: second");
  expect(await serverClient("opencode-cold").listInbox(sid)).toEqual([]);
  expect(wakesOf(sid)).not.toContain("minted");
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
  // A Zen model: the hint names the Go models only for OpenCode's own provider.
  const task = await newTask({ prompt: `fail ${fakeMarkers.error}`, model: "opencode/deepseek-v4.1-flash" });
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
  // The handler decides synchronously: deferred while the task's own turn is live.
  expect(orch.__opencodeServerForTest.deferredWakes()).toBe(1);
  expect(runsOf(task.id)).toHaveLength(1);
  interactions.answerOpencodePermission(pending(task.id)[0]!.id, { decision: "once" });
  await waitFor(() => runsOf(task.id).length === 2 && allSettled(task.id), 40_000, "the deferred wake run");
  expect(db.runs.get(runId)!.status).toBe("succeeded");
  const second = runsOf(task.id)[1]!;
  expect(second.origin).toBe("agent");
  expect(second.opencodeSessionId).toBe(sid);
  expect(orch.__opencodeServerForTest.deferredWakes()).toBe(0);
});

test("a wake that arrived during a turn the user then stops is interrupted by the Stop, not minted", async () => {
  const task = await newTask({ prompt: `run ${fakeMarkers.slow}` });
  const runId = await start(task);
  await waitFor(() => eventsOf(runId, "tool_use").length > 0, 30_000, "the tool step");
  const sid = sessionOf(task.id)!;
  await waitFor(() => orch.__opencodeServerForTest.watchedTask("opencode", sid) === task.id, 10_000, "the wake watch");
  orch.__opencodeServerForTest.wake("opencode", sid, { type: "session.execution.started", id: "evt_test_wake_2", created: Date.now() });
  expect(orch.__opencodeServerForTest.deferredWakes()).toBe(1);
  expect(await orch.cancelRun(runId)).toBe(true);
  // The Stop takes the deferred wake at once and interrupts its execution (nobody listens to a deferred one).
  expect(orch.__opencodeServerForTest.deferredWakes()).toBe(0);
  await settled(task.id, 20_000);
  await waitFor(() => doneHandled(runId), 10_000, "the done handler");
  await expectInterrupted(sid);
  expect(runsOf(task.id)).toHaveLength(1);
});

test("an archived task's session stays watched after the next refresh, and an execution OpenCode starts on it is interrupted", async () => {
  const task = await newTask({ prompt: "quick" });
  await start(task);
  await settled(task.id);
  const sid = sessionOf(task.id)!;
  await waitFor(() => orch.__opencodeServerForTest.watchedTask("opencode", sid) === task.id, 10_000, "the wake watch");
  db.tasks.update(task.id, { column: "done" });
  const archived = await orch.archiveTask(task.id);
  expect(archived).not.toHaveProperty("error");
  // A refresh after the archive still names the session (for 24 h), mapped to "interrupt".
  await orch.__opencodeServerForTest.refreshWatchNow();
  expect(orch.__opencodeServerForTest.watchedTask("opencode", sid)).toBe(task.id);
  await executeOnServer(sid, `again ${fakeMarkers.slow}`);
  await expectInterrupted(sid);
  expect(wakesOf(sid)).toContain("interrupted-no-card");
  expect(runsOf(task.id)).toHaveLength(1);
});

test("a deleted task's session stays watched (tombstone), and an execution OpenCode starts on it later is interrupted", async () => {
  const task = await newTask({ prompt: "quick" });
  await start(task);
  await settled(task.id);
  const sid = sessionOf(task.id)!;
  await waitFor(() => orch.__opencodeServerForTest.watchedTask("opencode", sid) === task.id, 10_000, "the wake watch");
  await orch.deleteTask(task.id);
  expect(db.tasks.get(task.id)).toBeNull();
  // The task's runs are gone: only the tombstone keeps the session watched.
  await orch.__opencodeServerForTest.refreshWatchNow();
  expect(orch.__opencodeServerForTest.watchedTask("opencode", sid)).toBe(task.id);
  await executeOnServer(sid, `later ${fakeMarkers.slow}`);
  await expectInterrupted(sid);
  expect(wakesOf(sid)).toContain("interrupted-no-card");
  expect(db.runs.listForTask(task.id)).toHaveLength(0);
});

test("delete with no local handle interrupts the session's background subagent over HTTP, and the parent's cancelled notice is interrupted too", async () => {
  addSlowHarness("opencode-gone");
  const task = await newTask({ prompt: `launch ${fakeMarkers.wake}`, agent: "opencode-gone" });
  const first = await start(task);
  await waitFor(() => db.runs.get(first)!.status === "succeeded", 60_000, "the first turn");
  await waitFor(() => db.subagents.listForTask(task.id).some((x) => x.status === "running"), 30_000, "the background child");
  const sid = sessionOf(task.id)!;
  const [child] = subagentsMod.listOpenOpencodeChildSessions(task.id);
  expect(child).toBeDefined();
  // The core hands over and comes back without a boot linger: no handle of this
  // core follows the child any more (a linger that ended, a boot that did not listen).
  orch.stopOpencodeServerDriver();
  orch.startOpencodeServerDriver();
  expect(orch.__opencodeServerForTest.liveTurns().lingering).toBe(0);
  expect(child! in (await serverClient("opencode-gone").activeSessions())).toBe(true);
  await orch.deleteTask(task.id);
  await expectInterrupted(child!, "opencode-gone");
  expect(subagentsMod.wasOpencodeChildStoppedByAgetor(child!)).toBe(true);
  // The child's "cancelled" notice wakes the parent: interrupted, not run.
  const notices = await cancelledNotices(sid, "opencode-gone");
  expect(notices.delivered.length + notices.parked).toBe(1);
  for (const outcome of notices.delivered) expect(outcome).toBe("interrupted");
  if (notices.delivered.length > 0) expect(wakesOf(sid).some((o) => o.startsWith("interrupted-"))).toBe(true);
  expect(wakesOf(sid)).not.toContain("minted");
});

test("a wake for a task that moved to another harness interrupts the execution on the old server", async () => {
  addHarness("opencode-cold2");
  const task = await newTask({ prompt: "quick" });
  await start(task);
  await settled(task.id);
  const sid = sessionOf(task.id)!;
  await waitFor(() => orch.__opencodeServerForTest.watchedTask("opencode", sid) === task.id, 10_000, "the wake watch");
  const before = db.tasks.get(task.id)!;
  db.tasks.update(task.id, { agent: "opencode-cold2" });
  await orch.reconcileTaskSession(task.id, before, db.tasks.get(task.id)!);
  // The hub still watches the session on the old harness's server: the execution there has no card.
  await waitFor(() => orch.__opencodeServerForTest.watchedTask("opencode", sid) === task.id, 10_000, "the old watch");
  await executeOnServer(sid, `again ${fakeMarkers.slow}`);
  await expectInterrupted(sid);
  expect(runsOf(task.id)).toHaveLength(1);
});

test("a wake after the user's Stop becomes an agent run and pulls a parked card (Done, Backlog, Blocked) back to Running", async () => {
  const task = await newTask({ prompt: `run ${fakeMarkers.slow}` });
  const runId = await start(task);
  await waitFor(() => eventsOf(runId, "tool_use").length > 0, 30_000, "the tool step");
  const sid = sessionOf(task.id)!;
  await waitFor(() => orch.__opencodeServerForTest.watchedTask("opencode", sid) === task.id, 10_000, "the wake watch");
  expect(await orch.cancelRun(runId)).toBe(true);
  await settled(task.id, 20_000);
  await expectInterrupted(sid);
  let expected = 1;
  for (const column of ["ready", "done", "backlog", "blocked"] as const) {
    db.tasks.update(task.id, { column });
    // OpenCode starts an execution on the session by itself (the hub's real wake).
    await executeOnServer(sid, `wake ${column} ${fakeMarkers.slow}`);
    expected += 1;
    await waitFor(() => runsOf(task.id).length === expected, 30_000, `the wake run from ${column}`);
    const woke = runsOf(task.id)[expected - 1]!;
    expect(woke.origin).toBe("agent");
    expect(woke.opencodeSessionId).toBe(sid);
    expect(woke.tmuxSession).toBeNull(); // a server turn has no tmux session of its own
    expect(db.tasks.get(task.id)!.column).toBe("running");
    expect(db.tasks.get(task.id)!.runId).toBe(woke.id);
    await waitFor(() => eventsOf(woke.id, "tool_use").length > 0, 30_000, "the woken turn's tool step");
    expect(await orch.cancelRun(woke.id)).toBe(true);
    await settled(task.id, 20_000);
    await expectInterrupted(sid);
  }
});

test("Stop on a live turn with a background subagent: both are interrupted, and the child's cancelled notice is the Stop's tail, never a run (R4, real hub order)", async () => {
  addSlowHarness("opencode-r4");
  try {
    const task = await newTask({ prompt: `launch ${fakeMarkers.bgslow}`, agent: "opencode-r4" });
    const first = await start(task);
    // The child runs, and the parent itself is busy in its own shell.
    await waitFor(() => eventsOf(first, "tool_use").length >= 2, 60_000, "the parent's own shell step");
    await waitFor(() => db.subagents.listForTask(task.id).some((x) => x.status === "running"), 30_000, "the background child");
    const sid = sessionOf(task.id)!;
    const [child] = subagentsMod.listOpenOpencodeChildSessions(task.id);
    expect(db.runs.get(first)!.status).toBe("running");
    expect(await orch.cancelRun(first)).toBe(true);
    await waitFor(() => doneHandled(first), 20_000, "the done handler");
    expect(db.runs.get(first)!.status).toBe("cancelled");
    await expectInterrupted(child!, "opencode-r4");
    await waitFor(() => db.subagents.listForTask(task.id).every((x) => x.status !== "running"), 20_000, "the child row");
    expect(db.subagents.listForTask(task.id).map((x) => x.status)).toEqual(["cancelled"]);
    // The root is interrupted first, so the child's notice lands on an idle
    // parent and OpenCode starts an execution for it: the hub reports it, the
    // orchestrator reads it as the tail of this Stop and interrupts it.
    const notices = await cancelledNotices(sid, "opencode-r4");
    expect(notices).toEqual({ delivered: ["interrupted"], parked: 0 });
    expect(wakesOf(sid)).toContain("interrupted-tail");
    expect(await lastIdleOutcome(sid, "opencode-r4")).toBe("interrupted");
    expect(runsOf(task.id)).toHaveLength(1);
    expect(runsOf(task.id).some((r) => r.origin === "agent")).toBe(false);
  } finally {
    await serverMod.stopOpencodeServer("opencode-r4");
  }
});

test("Stop on a held task lingering for two background subagents: both are interrupted, their notices are the Stop's tail; a later execution is a wake like any other (R3, R4)", async () => {
  addSlowHarness("opencode-r4b");
  try {
    const task = await newTask({ prompt: `launch ${fakeMarkers.wake}`, agent: "opencode-r4b" });
    const first = await start(task);
    await waitFor(() => db.runs.get(first)!.status === "succeeded", 60_000, "the first turn");
    await waitFor(() => orch.__opencodeServerForTest.liveTurns().lingering === 1, 30_000, "the first linger");
    // A second turn launches a second background subagent; the first one is adopted.
    expect(await orch.sendInput(first, `again ${fakeMarkers.wake}`)).toMatchObject({ delivered: true });
    await waitFor(() => runsOf(task.id).length === 2 && allSettled(task.id), 60_000, "the second turn");
    const second = runsOf(task.id)[1]!;
    expect(second.status).toBe("succeeded");
    await waitFor(() => db.subagents.listForTask(task.id).filter((x) => x.status === "running").length === 2, 30_000, "two background children");
    await waitFor(() => orch.__opencodeServerForTest.liveTurns().lingering === 1, 30_000, "the linger");
    expect(db.tasks.get(task.id)!.column).toBe("running"); // held
    const sid = sessionOf(task.id)!;
    const children = subagentsMod.listOpenOpencodeChildSessions(task.id);
    expect(children).toHaveLength(2);
    expect(await orch.cancelRun(second.id)).toBe(true);
    expect(orch.__opencodeServerForTest.liveTurns().lingering).toBe(0);
    for (const child of children) await expectInterrupted(child, "opencode-r4b");
    await waitFor(() => db.subagents.listForTask(task.id).every((x) => x.status !== "running"), 20_000, "the child rows");
    expect(db.subagents.listForTask(task.id).map((x) => x.status)).toEqual(["cancelled", "cancelled"]);
    // Each notice was either run (and that execution interrupted as the Stop's
    // tail) or parked by OpenCode behind an interrupt; none became a run.
    const notices = await cancelledNotices(sid, "opencode-r4b");
    expect(notices.delivered.length + notices.parked).toBe(2);
    expect(notices.delivered.length).toBeGreaterThan(0);
    for (const outcome of notices.delivered) expect(outcome).toBe("interrupted");
    expect(wakesOf(sid)).toContain("interrupted-tail");
    expect(wakesOf(sid)).not.toContain("minted");
    expect(runsOf(task.id)).toHaveLength(2);
    // Whatever OpenCode runs on the parent next is not refused because of that
    // Stop (plan R3): a user message among its input makes it new work, even
    // with a parked notice delivered ahead of it.
    await executeOnServer(sid, `carry on ${fakeMarkers.slow}`, "opencode-r4b");
    await waitFor(() => runsOf(task.id).some((r) => r.origin === "agent" && r.status === "running"), 60_000, "the wake run");
    expect(db.tasks.get(task.id)!.column).toBe("running");
    const woke = runsOf(task.id).find((r) => r.origin === "agent" && r.status === "running")!;
    expect(await orch.cancelRun(woke.id)).toBe(true);
    await settled(task.id, 30_000);
    await expectInterrupted(sid, "opencode-r4b");
  } finally {
    await serverMod.stopOpencodeServer("opencode-r4b");
  }
});

test("a wake the hub could not see enqueued is classified from the server: a delivered cancelled notice of a child agetor stopped is a tail, anything else new work", async () => {
  addSlowHarness("opencode-r4c");
  try {
    const task = await newTask({ prompt: `launch ${fakeMarkers.wake}`, agent: "opencode-r4c" });
    const first = await start(task);
    await waitFor(() => db.runs.get(first)!.status === "succeeded", 60_000, "the first turn");
    await waitFor(() => db.subagents.listForTask(task.id).some((x) => x.status === "running"), 30_000, "the background child");
    const sid = sessionOf(task.id)!;
    const [child] = subagentsMod.listOpenOpencodeChildSessions(task.id);
    const c = serverClient("opencode-r4c");
    // Nobody acts on the wake this causes: the driver is down while it runs.
    orch.stopOpencodeServerDriver();
    try {
      expect(await orch.__opencodeServerForTest.classifyUnknown("opencode-r4c", sid)).toBe("unknown"); // idle, nothing new
      subagentsMod.noteOpencodeChildStoppedByAgetor({ taskId: task.id, childSessionId: child! });
      expect(await c.interrupt(child!)).toBe(true);
      // The notice starts a parent execution (slow enough to look at while it runs).
      for (let i = 0; i < 200 && !(sid in (await c.activeSessions())); i++) await sleep(10);
      expect(sid in (await c.activeSessions())).toBe(true);
      expect(await orch.__opencodeServerForTest.classifyUnknown("opencode-r4c", sid)).toBe("tail");
      for (let i = 0; i < 400 && sid in (await c.activeSessions()); i++) await sleep(25);
      // A user message is new work.
      await c.prompt(sid, { text: `user ${fakeMarkers.slow}`, delivery: "steer" });
      for (let i = 0; i < 200 && !(sid in (await c.activeSessions())); i++) await sleep(10);
      expect(await orch.__opencodeServerForTest.classifyUnknown("opencode-r4c", sid)).toBe("unknown");
      await c.interrupt(sid);
    } finally {
      orch.startOpencodeServerDriver();
    }
  } finally {
    await serverMod.stopOpencodeServer("opencode-r4c");
  }
});

test("a Stop that finds a wake waiting on a follow-up's spawn interrupts that wake's execution, not just forgets it", async () => {
  addHarness("opencode-sf1", SLOW_VERSION_BIN);
  try {
    const task = await newTask({ prompt: "quick", agent: "opencode-sf1" });
    const first = await start(task);
    await settled(task.id);
    const sid = sessionOf(task.id)!;
    await waitFor(() => orch.__opencodeServerForTest.watchedTask("opencode-sf1", sid) === task.id, 10_000, "the wake watch");
    // The follow-up's version probe takes 3 s: its run row is minted, no driver listens yet.
    writeFileSync(SLOW_VERSION_FLAG, "");
    agentStatus.__testing.clearStatusCache();
    const sending = orch.sendInput(first, "a follow-up");
    await waitFor(() => (db.tasks.get(task.id)!.runId ?? first) !== first, 10_000, "the follow-up's run row");
    const next = db.tasks.get(task.id)!.runId!;
    // A background result starts an execution meanwhile: the wake waits for the spawn.
    await executeOnServer(sid, `background result ${fakeMarkers.slow}`, "opencode-sf1");
    await waitFor(() => wakesOf(sid).includes("deferred"), 10_000, "the deferred wake");
    expect(await orch.cancelRun(next)).toBe(true);
    expect(orch.__opencodeServerForTest.deferredWakes()).toBe(0);
    await expectInterrupted(sid, "opencode-sf1");
    expect(wakesOf(sid)).toContain("interrupted-dropped");
    await sending;
    await waitFor(() => db.runs.get(next)!.status !== "running", 30_000, "the follow-up to settle");
    expect(db.runs.get(next)!.status).toBe("cancelled");
  } finally {
    rmSync(SLOW_VERSION_FLAG, { force: true });
    await serverMod.stopOpencodeServer("opencode-sf1");
  }
});

test("the Stop's tail arriving while a follow-up is starting waits for it instead of interrupting under its message", async () => {
  addHarness("opencode-sf3", SLOW_VERSION_BIN);
  try {
    const task = await newTask({ prompt: "quick", agent: "opencode-sf3" });
    const first = await start(task);
    await settled(task.id);
    const sid = sessionOf(task.id)!;
    await waitFor(() => orch.__opencodeServerForTest.watchedTask("opencode-sf3", sid) === task.id, 10_000, "the wake watch");
    const child = `ses_tailchild${task.id.replace(/-/g, "").slice(0, 12)}`;
    subagentsMod.noteOpencodeChildStoppedByAgetor({ taskId: task.id, childSessionId: child });
    writeFileSync(SLOW_VERSION_FLAG, "");
    agentStatus.__testing.clearStatusCache();
    const sending = orch.sendInput(first, "a follow-up");
    await waitFor(() => (db.tasks.get(task.id)!.runId ?? first) !== first, 10_000, "the follow-up's run row");
    const next = db.tasks.get(task.id)!.runId!;
    const tail = { items: [{ inboxId: "msg_tail", synthetic: true, source: "subagent", childID: child, state: "cancelled" }], known: true };
    orch.__opencodeServerForTest.wake("opencode-sf3", sid, { type: "session.execution.started", id: "evt_test_tail_starting", created: Date.now() }, tail);
    expect(wakesOf(sid)).toContain("deferred");
    expect(wakesOf(sid)).not.toContain("interrupted-tail");
    expect(orch.__opencodeServerForTest.deferredWakes()).toBe(1);
    expect(await orch.cancelRun(next)).toBe(true);
    await sending;
    await waitFor(() => db.runs.get(next)!.status !== "running", 30_000, "the follow-up to settle");
  } finally {
    rmSync(SLOW_VERSION_FLAG, { force: true });
    await serverMod.stopOpencodeServer("opencode-sf3");
  }
});

test("a Stop OpenCode never confirms: the still-open execution's wake is interrupted on retry, never minted as a run", async () => {
  addHarness("opencode-stuck");
  const restoreTimings = driverMod.__forTest.setTimings({ stopConfirmMs: 500 });
  try {
    const task = await newTask({ prompt: `run ${fakeMarkers.stuck}`, agent: "opencode-stuck" });
    const runId = await start(task);
    await waitFor(() => eventsOf(runId, "tool_use").length > 0, 30_000, "the tool step");
    const sid = sessionOf(task.id)!;
    await waitFor(() => orch.__opencodeServerForTest.watchedTask("opencode-stuck", sid) === task.id, 10_000, "the wake watch");
    expect(await orch.cancelRun(runId)).toBe(true);
    await waitFor(() => doneHandled(runId), 20_000, "the done handler");
    expect(db.runs.get(runId)!.status).toBe("cancelled");
    expect(statusOf(runId)).toContain("OpenCode didn't confirm the stop");
    // The server still runs the execution the user stopped: the hub reports it
    // once the driver lets go, and the retry interrupts it instead of a run.
    await waitFor(() => wakesOf(sid).includes("interrupted-stopped"), 15_000, "the stopped execution's interrupt");
    expect(sid in (await serverClient("opencode-stuck").activeSessions())).toBe(true); // the stuck fake ignores interrupts
    expect(wakesOf(sid)).not.toContain("minted");
    expect(runsOf(task.id)).toHaveLength(1);
    expect(db.tasks.get(task.id)!.column).toBe("ready");
  } finally {
    restoreTimings();
    await serverMod.stopOpencodeServer("opencode-stuck");
  }
});

test("Stop right after a follow-up registered (its prompt not sent yet) also ends the earlier turn's linger and interrupts its background subagent", async () => {
  addSlowHarness("opencode-sf5");
  // Hold the follow-up between its registration and its prompt.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let gated = false;
  try {
    const task = await newTask({ prompt: `launch ${fakeMarkers.wake}`, agent: "opencode-sf5" });
    const first = await start(task);
    await waitFor(() => db.runs.get(first)!.status === "succeeded", 60_000, "the first turn");
    await waitFor(() => orch.__opencodeServerForTest.liveTurns().lingering === 1, 30_000, "the linger");
    const [child] = subagentsMod.listOpenOpencodeChildSessions(task.id);
    const restoreDeps = driverMod.__forTest.setDeps({
      ensureServer: async (spec) => {
        gated = true;
        await gate;
        return serverMod.ensureOpencodeServer(spec);
      },
    });
    try {
      const sending = orch.sendInput(first, "a follow-up");
      await waitFor(() => gated && orch.__opencodeServerForTest.liveTurns().driving === 1, 10_000, "the follow-up's registration");
      const next = db.tasks.get(task.id)!.runId!;
      expect(next).not.toBe(first);
      expect(await orch.cancelRun(next)).toBe(true);
      expect(orch.__opencodeServerForTest.liveTurns().lingering).toBe(0);
      release();
      await sending;
      await waitFor(() => db.runs.get(next)!.status !== "running", 30_000, "the follow-up to settle");
      expect(db.runs.get(next)!.status).toBe("cancelled");
      await expectInterrupted(child!, "opencode-sf5");
      await waitFor(() => db.subagents.listForTask(task.id).every((x) => x.status !== "running"), 20_000, "the child row");
      expect(db.subagents.listForTask(task.id).map((x) => x.status)).toEqual(["cancelled"]);
    } finally {
      release();
      restoreDeps();
    }
  } finally {
    await serverMod.stopOpencodeServer("opencode-sf5");
  }
});

test("Stop during a follow-up's pending spawn, with a linger listening: the linger ends AND the new turn is cancelled", async () => {
  addHarness("opencode-s1", SLOW_VERSION_BIN);
  setEnv("FAKE_OC_SPEED", "3"); // only the server this test starts runs slow
  try {
    const task = await newTask({ prompt: `launch ${fakeMarkers.wake}`, agent: "opencode-s1" });
    const first = await start(task);
    setEnv("FAKE_OC_SPEED", "0.1");
    await waitFor(() => db.runs.get(first)!.status === "succeeded", 60_000, "the first turn");
    await waitFor(() => orch.__opencodeServerForTest.liveTurns().lingering === 1, 30_000, "the linger");
    // The follow-up's version probe takes 3 s: its run row is minted, its agent not yet registered.
    writeFileSync(SLOW_VERSION_FLAG, "");
    agentStatus.__testing.clearStatusCache();
    const sending = orch.sendInput(first, "a follow-up");
    await waitFor(() => (db.tasks.get(task.id)!.runId ?? first) !== first, 10_000, "the follow-up's run row");
    const next = db.tasks.get(task.id)!.runId!;
    expect(db.runs.get(next)!.status).toBe("running");
    expect(await orch.cancelRun(next)).toBe(true);
    expect(orch.__opencodeServerForTest.liveTurns().lingering).toBe(0);
    await sending;
    await waitFor(() => db.runs.get(next)!.status !== "running", 30_000, "the follow-up to settle");
    expect(db.runs.get(next)!.status).toBe("cancelled");
    expect(assistantOf(next)).not.toContain("ACK: a follow-up");
  } finally {
    rmSync(SLOW_VERSION_FLAG, { force: true });
    setEnv("FAKE_OC_SPEED", "0.1");
    await serverMod.stopOpencodeServer("opencode-s1");
  }
});

test("boot linger candidates: a recently orphaned child counts, one orphaned past the re-check window does not", async () => {
  const task = await newTask({ prompt: "quick" });
  const runId = await start(task);
  await settled(task.id);
  const sid = sessionOf(task.id)!;
  const child = `ses_lingerchild${task.id.replace(/-/g, "").slice(0, 12)}`;
  subagentsMod.registerOpencodeChildSession({ taskId: task.id, runId, parentSessionId: sid, childSessionId: child, depth: 1, background: true });
  const now = Date.now();
  const mine = () => orch.__opencodeServerForTest.lingerCandidates([], now).filter((c) => c.taskId === task.id);
  db.subagents.setStatus(subagentsMod.opencodeSubagentId(child), "orphaned", now - subagentsMod.ORPHAN_RECHECK_MAX_AGE_MS - 1000);
  expect(mine()).toEqual([]);
  db.subagents.setStatus(subagentsMod.opencodeSubagentId(child), "orphaned", now - 60_000);
  expect(mine()).toEqual([{ taskId: task.id, runId, harnessId: "opencode", sessionId: sid }]);
  // A task with a run still running is reattached instead, never lingered.
  expect(orch.__opencodeServerForTest.lingerCandidates([task.id], now).filter((c) => c.taskId === task.id)).toEqual([]);
  db.subagents.setStatus(subagentsMod.opencodeSubagentId(child), "failed", now);
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

test("Ask card answered with an empty reject refuses the tool and the turn continues: run succeeds, task to review (plan R1)", async () => {
  const task = await newTask({ prompt: `do it ${fakeMarkers.permission}`, mode: "ask" });
  const runId = await start(task);
  await waitFor(() => pending(task.id).length === 1, 30_000, "the permission card");
  interactions.answerOpencodePermission(pending(task.id)[0]!.id, { decision: "reject" });
  await settled(task.id, 30_000);
  expect(db.runs.get(runId)!.status).toBe("succeeded");
  expect(db.tasks.get(task.id)!.column).toBe("review");
  expect(runsOf(task.id)).toHaveLength(1);
});

test("the server's restart gate: a fresh spawn does not count itself, an attach always counts, every other turn counts", async () => {
  const task = await newTask({ prompt: `run ${fakeMarkers.slow}` });
  const runId = await start(task);
  await waitFor(() => eventsOf(runId, "tool_use").length > 0, 30_000, "the tool step");
  const own = orch.__opencodeServerForTest.turnHooks("opencode", runId, task.id, "spawn");
  const attached = orch.__opencodeServerForTest.turnHooks("opencode", runId, task.id, "attach");
  const other = orch.__opencodeServerForTest.turnHooks("opencode", "some-other-run", "some-other-task");
  expect(own.isBusy()).toBe(false); // idle apart from itself: a changed config may restart the server
  expect(attached.isBusy()).toBe(true); // joining a running execution: a restart would kill it
  expect(other.isBusy()).toBe(true); // a different turn is using it
  expect(await orch.cancelRun(runId)).toBe(true);
  await settled(task.id, 20_000);
});

test("restart with changed harness settings: the reattached turn keeps its server (no restart under it) and completes", async () => {
  addHarness("opencode-fp2");
  const task = await newTask({ prompt: `do it ${fakeMarkers.permission}`, mode: "ask", agent: "opencode-fp2" });
  const runId = await start(task);
  await waitFor(() => pending(task.id).length === 1, 30_000, "the permission card");
  const before = serverMod.getOpencodeServer("opencode-fp2")!;
  expect(db.runs.get(runId)!.tmuxSession).toBeNull(); // a server turn has no tmux session of its own
  orch.stopOpencodeServerDriver();
  interactions.__testing.reset();
  serverMod.__forTest.forget();
  await serverMod.adoptOpencodeServers();
  // The settings changed while the core was away: the adopted server no longer matches them.
  db.harnesses.update("opencode-fp2", { env: { AGETOR_TEST_FINGERPRINT: "changed-under-a-live-turn" } });
  expect(await orch.reconcileOrphans()).toBe(0);
  orch.startOpencodeServerDriver();
  await waitFor(() => pending(task.id).length === 1, 30_000, "the card to be re-raised");
  expect(serverMod.getOpencodeServer("opencode-fp2")!.startedAt).toBe(before.startedAt);
  interactions.answerOpencodePermission(pending(task.id)[0]!.id, { decision: "once" });
  await settled(task.id);
  expect(db.runs.get(runId)!.status).toBe("succeeded");
  expect(assistantOf(runId)).toContain("The command ran: hi");
  expect(serverMod.getOpencodeServer("opencode-fp2")!.startedAt).toBe(before.startedAt);
});

test("a message whose steer was still waiting when the user stopped a pipeline step goes to the backlog, not a new turn", async () => {
  addHarness("opencode-cold3");
  const { newStep } = await import("../shared/pipeline.ts");
  const profile = db.agentProfiles.insert({
    name: `oc-step-${Date.now()}`,
    harness: "opencode-cold3",
    model: "opencode-go/deepseek-v4.1-flash",
    effort: null,
    mode: null,
    speed: "off",
    maxMode: false,
    instructions: "",
    skills: [],
  });
  const A = newStep({ name: "A", agentProfileId: profile.id, instructions: `do A ${fakeMarkers.slow}` });
  const pipeline = db.pipelines.insert({ name: `oc-step-${Date.now()}`, graph: { steps: [A], edges: [], startStepId: A.id }, maxSteps: 25 });
  const created = await orch.createTask({ title: "oc step", prompt: `goal ${fakeMarkers.slow}`, workdir: WORKDIR, isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  const started = await orch.startTask(created.task.id);
  if ("error" in started) throw new Error(started.error);
  let step: Task | undefined;
  await waitFor(() => {
    step = db.tasks.stepsForParent(created.task.id)[0];
    return step?.column === "running" && !!step.runId && orch.__opencodeServerForTest.liveTurns().driving > 0;
  }, 30_000, "the step's turn");
  const stepRun = step!.runId!;
  // The server is still starting: the steer waits for the turn's first prompt.
  const sending = orch.sendInput(stepRun, "typed before the stop");
  // Its bubble is on the run once the steer is in flight.
  await waitFor(() => eventsOf(stepRun, "user").length === 2, 10_000, "the steer to be in flight");
  expect(await orch.cancelRun(stepRun)).toBe(true);
  await sending;
  await waitFor(() => db.runs.get(stepRun)!.status === "cancelled" && doneHandled(stepRun), 30_000, "the stopped step");
  await waitFor(() => db.tasks.get(step!.id)!.backlog.some((b) => b.text === "typed before the stop"), 10_000, "the backlog entry");
  expect(db.runs.listForTask(step!.id).map((r) => r.id)).toEqual([stepRun]);
  expect(statusOf(stepRun).some((l) => l.startsWith("queued message not sent — this pipeline step was stopped"))).toBe(true);
});

test("a server crash mid-turn fails the run with a status line; the next turn starts a new server and resumes the same session", async () => {
  addHarness("opencode-crash");
  db.harnesses.update("opencode-crash", { env: { FAKE_OC_STATE_FILE: path.join(DATA_DIR, "crash-sessions.json") } });
  // Give up on the dead server in seconds, not the production minutes. The
  // manager's health cache is left as it is: the hub's give-up clears it
  // (`noteOpencodeServerLost`), so the next turn re-probes and replaces the
  // dead server instead of being handed its url.
  hubMod.__forTest.setBackoff({ baseMs: 50, maxMs: 200, maxFailures: 3 });
  try {
  const task = await newTask({ prompt: `run ${fakeMarkers.slow}`, agent: "opencode-crash" });
  const runId = await start(task);
  await waitFor(() => eventsOf(runId, "tool_use").length > 0, 30_000, "the tool step");
  const sid = sessionOf(task.id)!;
  const before = serverMod.getOpencodeServer("opencode-crash")!;
  process.kill(hostPidOf("opencode-crash"), "SIGKILL");
  await waitFor(() => db.runs.get(runId)!.status !== "running", 90_000, "the run to give up on the dead server");
  expect(db.runs.get(runId)!.status).toBe("failed");
  expect(db.tasks.get(task.id)!.column).toBe("ready");
  expect(statusOf(runId).some((l) => l.startsWith("OpenCode server connection lost"))).toBe(true);
  const sent = await orch.sendInput(runId, "after the crash");
  expect(sent).toMatchObject({ delivered: true });
  await waitFor(() => runsOf(task.id).length === 2 && allSettled(task.id), 60_000, "the next turn");
  const next = runsOf(task.id)[1]!;
  expect(next.status).toBe("succeeded");
  expect(next.opencodeSessionId).toBe(sid);
  expect(assistantOf(next.id)).toContain("ACK: after the crash");
  expect(statusOf(next.id).some((l) => l.includes("couldn't resume"))).toBe(false);
  expect(serverMod.getOpencodeServer("opencode-crash")!.startedAt).not.toBe(before.startedAt);
  } finally {
    hubMod.__forTest.resetBackoff();
  }
});

test("a server crash mid-turn with a background subagent: its row is retired, so the next turn neither adopts it nor holds the task", async () => {
  addHarness("opencode-crash2");
  db.harnesses.update("opencode-crash2", { env: { FAKE_OC_STATE_FILE: path.join(DATA_DIR, "crash2-sessions.json") } });
  hubMod.__forTest.setBackoff({ baseMs: 50, maxMs: 200, maxFailures: 3 });
  try {
    const task = await newTask({ prompt: `launch ${fakeMarkers.bgslow}`, agent: "opencode-crash2" });
    const runId = await start(task);
    await waitFor(() => eventsOf(runId, "tool_use").length >= 2, 30_000, "the parent's own shell step");
    await waitFor(() => db.subagents.listForTask(task.id).some((x) => x.status === "running"), 30_000, "the background child");
    process.kill(hostPidOf("opencode-crash2"), "SIGKILL");
    await waitFor(() => db.runs.get(runId)!.status !== "running", 90_000, "the run to give up on the dead server");
    expect(db.runs.get(runId)!.status).toBe("failed");
    expect(statusOf(runId).some((l) => l.startsWith("OpenCode server connection lost"))).toBe(true);
    // Nothing will ever settle the child the crash cut off: retired, not running.
    expect(db.subagents.listForTask(task.id).map((x) => x.status)).not.toContain("running");
    expect(await orch.sendInput(runId, "after the crash")).toMatchObject({ delivered: true });
    await waitFor(() => runsOf(task.id).length === 2 && allSettled(task.id), 60_000, "the next turn");
    const next = runsOf(task.id)[1]!;
    expect(next.status).toBe("succeeded");
    expect(assistantOf(next.id)).toContain("ACK: after the crash");
    await waitFor(() => db.tasks.get(task.id)!.column !== "running", 15_000, "the card to leave Running");
    expect(db.tasks.get(task.id)!.column).toBe("review");
    expect(db.subagents.listForTask(task.id).map((x) => x.status)).not.toContain("running");
    // Nothing follows the dead child either (a linger would keep the server up for 24 h).
    expect(ocsMod.liveLingeringOpencodeTurns(task.id)).toHaveLength(0);
  } finally {
    hubMod.__forTest.resetBackoff();
    await serverMod.stopOpencodeServer("opencode-crash2");
  }
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
    setEnv("AGETOR_TMUX_BIN", undefined);
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
    setEnv("AGETOR_TMUX_BIN", undefined);
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
  // Positive proof of death (the host is gone) and past the idle window.
  const stopped = await orch.runOpencodeIdleSweep(Date.now() + 60 * 60_000);
  expect(stopped).toContain("opencode-dead");
  expect(serverMod.getOpencodeServer("opencode-dead")).toBeNull();
});

test("a sweep keeps a server that is only slow: a timeout is no proof of death", async () => {
  addHarness("opencode-slow");
  const task = await newTask({ agent: "opencode-slow", prompt: "hi" });
  await start(task);
  await settled(task.id);
  const handle = serverMod.getOpencodeServer("opencode-slow")!;
  const hostPid = hostPidOf("opencode-slow");
  process.kill(hostPid, "SIGSTOP"); // alive, but answers nothing
  try {
    const stopped = await orch.runOpencodeIdleSweep(Date.now() + 60 * 60_000);
    expect(stopped).not.toContain("opencode-slow");
    expect(serverMod.getOpencodeServer("opencode-slow")?.startedAt).toBe(handle.startedAt);
  } finally {
    process.kill(hostPid, "SIGCONT");
  }
  // Answering again: the next turn uses the same server.
  const again = await newTask({ agent: "opencode-slow", prompt: "again" });
  await start(again);
  await settled(again.id);
  expect(serverMod.getOpencodeServer("opencode-slow")?.startedAt).toBe(handle.startedAt);
});

test("quit right after a long turn: the probe that saw it executing no longer counts once it ended", async () => {
  const task = await newTask({ prompt: `run ${fakeMarkers.slow}` });
  const runId = await start(task);
  await waitFor(() => eventsOf(runId, "tool_use").length > 0, 30_000, "the tool step");
  const sid = sessionOf(task.id)!;
  // The sweep's probe sees the session executing (and stops nothing: inside the idle window).
  expect(await orch.runOpencodeIdleSweep(Date.now())).not.toContain("opencode");
  expect(await orch.cancelRun(runId)).toBe(true);
  await settled(task.id, 20_000);
  await expectInterrupted(sid);
  expect(orch.stopIdleOpencodeServersOnRealStop()).toContain("opencode");
  expect(serverMod.getOpencodeServer("opencode")).toBeNull();
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
