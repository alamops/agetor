// TS2: the phone terminal (grill D17) against the real gateway, the real API server and a REAL tmux session on agetor's test socket: attach
// needs a configure device and a signed attach; the Mac can Detach over HTTP; a revoke detaches; and in every case the tmux SESSION lives on.
// Skips loudly without tmux, and fails under CI=true (the CI runner installs tmux).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, toHex } from "@agetor/remote-protocol/bytes";
import { TestPhone } from "@agetor/remote-protocol/test-client";
import { startTestRelay, type TestRelay } from "@agetor/remote-protocol/test-relay";
import type { RemoteLevel } from "@agetor/remote-protocol/levels";

const TMUX = Bun.which("tmux");
const DATA = mkdtempSync(path.join(tmpdir(), "agt-it-terminal-"));
process.env.AGETOR_DATA_DIR = DATA;
process.env.AGETOR_API_PORT = "4854";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
if (TMUX) process.env.AGETOR_TMUX_BIN = TMUX;

const { startApiServer } = await import("../../server.ts");
const { startRemoteGateway } = await import("../gateway.ts");
const { FakeKeyHelper } = await import("../key-helper-fake.ts");
const { setKeyHelperForTests } = await import("../key-helper-api.ts");
const { registryEntryJson } = await import("../registry.ts");
const asyncDb = await import("../../db-async.ts");
const { db, harnesses, preferences, tasks } = await import("../../db.ts");
const { snapshotHarnessState } = await import("../../test-harness-state.ts");
const { createTask } = await import("../../orchestrator.ts");
const { resolveTmuxBin, tmuxSocketArgs } = await import("../../tmux-resolution.ts");
const { sessionNameFor } = await import("../../claude-tmux.ts");
const { rmTestDataDir } = await import("../../test-data-dir.ts");
const { API_TOKEN } = await import("../../api-config.ts");

const BASE = "http://127.0.0.1:4854";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(20);
  }
}
const tmux = (...args: string[]) => Bun.spawnSync([resolveTmuxBin(), ...tmuxSocketArgs(), ...args]);

let server: { stop: () => void };
let relay: TestRelay | null = null;
let helper: InstanceType<typeof FakeKeyHelper>;
let gateway: Awaited<ReturnType<typeof startRemoteGateway>> | null = null;
const phones: TestPhone[] = [];
const sessions: string[] = [];

/** A second account of the Claude kind: its tasks carry this harness id, not "claude-code". */
const SECOND_CLAUDE = "claude-it-second";
let restoreHarnesses: () => void = () => undefined;

beforeAll(() => {
  server = startApiServer() as unknown as { stop: () => void };
  restoreHarnesses = snapshotHarnessState();
  harnesses.insert({ id: SECOND_CLAUDE, kind: "claude-code", label: "Claude (second account)" });
});
afterAll(() => {
  server.stop();
  restoreHarnesses();
  rmTestDataDir(DATA);
});
afterEach(async () => {
  for (const p of phones.splice(0)) p.close();
  await gateway?.stop();
  gateway = null;
  relay?.stop();
  relay = null;
  setKeyHelperForTests(null);
  for (const s of sessions.splice(0)) tmux("kill-session", "-t", "=" + s);
  db.run(`DELETE FROM remote_devices`);
  preferences.set("remoteAccess", "off");
});

async function setup(level: RemoteLevel) {
  relay = startTestRelay({ limits: { framesPerSecond: 10_000 } });
  helper = new FakeKeyHelper();
  setKeyHelperForTests(helper);
  const phone = new TestPhone({ relayUrl: relay.url, timeoutMs: 5000 });
  phones.push(phone);
  const id = toHex(randomBytes(16));
  const row = { id, name: "Ana's iPhone", platform: "ios" as const, sessionPub: phone.sessionPub, approvePub: phone.approvePub, pushPub: phone.pushPub, level, enrolledAt: Date.now() };
  const sig = helper.signRegistryEntry(id, registryEntryJson(row));
  const linkSecret = randomBytes(32);
  await asyncDb.op("remote.addDevice", [{ ...row, appVersion: "1", linkSecret, sig }, { ts: Date.now(), action: "pair", deviceId: id }]);
  preferences.set("remoteAccess", "on");
  gateway = await startRemoteGateway({
    mode: "app",
    notificationPolicy: { registerSink: () => () => undefined },
    deps: { relayUrl: () => relay!.url, linkOptions: { backoff: { baseMs: 20, maxMs: 100 } }, gatePollMs: 50, noSchedulers: true, log: () => undefined },
  });
  await until(() => relay!.mailboxes().some((m) => m.core));
  const created = await createTask({ title: "terminal", prompt: "p", agent: "claude-code", workdir: DATA, isolation: "none" });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  const name = sessionNameFor(taskId);
  expect(tmux("new-session", "-d", "-s", name, "-x", "80", "-y", "24", "cat").exitCode).toBe(0);
  sessions.push(name);
  await phone.connect({ corePub: (await helper.status()).corePub, deviceId: id, linkSecret });
  return { phone, id, taskId, name };
}

const alive = (name: string) => tmux("has-session", "-t", "=" + name).exitCode === 0;
const seen = (phone: TestPhone, taskId: string) => phone.terminal.output(taskId);

describe.skipIf(!TMUX && process.env.CI !== "true")("the phone terminal", () => {
  test("a configure device with a signed attach reaches the session; the session is the same one the Mac has", async () => {
    if (!TMUX) throw new Error("tmux is required in CI");
    const t = await setup("configure");
    await t.phone.terminal.attach(t.taskId, t.name);
    await t.phone.next("terminal-attached");
    await t.phone.terminal.input(t.taskId, "from-the-phone\n");
    await until(() => seen(t.phone, t.taskId).includes("from-the-phone"));
    // The Mac's own view of the same session shows it too (polled: the pane redraws on tmux's schedule, not ours).
    const pane = () => tmux("capture-pane", "-p", "-t", "=" + t.name + ":").stdout.toString();
    await until(() => pane().includes("from-the-phone"));
    expect(pane()).toContain("from-the-phone");
  }, 60_000);

  test("an operate device is refused at the level, and nothing attaches", async () => {
    if (!TMUX) throw new Error("tmux is required in CI");
    const t = await setup("operate");
    await expect(t.phone.terminal.attach(t.taskId, t.name)).rejects.toThrow(/level/);
    expect((await (await fetch(`${BASE}/remote-access`, { headers: { authorization: `Bearer ${API_TOKEN}` } })).json() as { attachedTerminals: unknown[] }).attachedTerminals).toEqual([]);
  }, 60_000);

  test("an attach signed by another key is refused", async () => {
    if (!TMUX) throw new Error("tmux is required in CI");
    const t = await setup("configure");
    const { p256 } = await import("@noble/curves/nist.js");
    await t.phone.terminal.attach(t.taskId, t.name, { cols: 80, rows: 24 }, { signWith: p256.utils.randomSecretKey() }).catch(() => undefined);
    const err = await t.phone.next<{ code: string }>("error");
    expect(err.code).toBe("signature");
    expect(alive(t.name)).toBe(true);
  }, 60_000);

  test("the Mac's Detach over HTTP ends the phone's terminal and the session survives", async () => {
    if (!TMUX) throw new Error("tmux is required in CI");
    const t = await setup("configure");
    await t.phone.terminal.attach(t.taskId, t.name);
    await t.phone.next("terminal-attached");
    const status = (await (await fetch(`${BASE}/remote-access`, { headers: { authorization: `Bearer ${API_TOKEN}` } })).json()) as { attachedTerminals: Array<{ taskId: string }> };
    expect(status.attachedTerminals.map((a) => a.taskId)).toEqual([t.taskId]);
    const res = await fetch(`${BASE}/tasks/${t.taskId}/phone-terminal`, { method: "DELETE", headers: { authorization: `Bearer ${API_TOKEN}` } });
    expect(await res.json()).toEqual({ ok: true, detached: true });
    const closed = await t.phone.next<{ taskId: string; reason: string }>("terminal-closed");
    expect(closed).toEqual({ taskId: t.taskId, reason: "mac-detach" });
    expect(alive(t.name)).toBe(true);
  }, 60_000);

  test("revoking the device detaches its terminal, and the session survives", async () => {
    if (!TMUX) throw new Error("tmux is required in CI");
    const t = await setup("configure");
    await t.phone.terminal.attach(t.taskId, t.name);
    await t.phone.next("terminal-attached");
    const res = await fetch(`${BASE}/remote-access/devices/${t.id}`, { method: "DELETE", headers: { authorization: `Bearer ${API_TOKEN}` } });
    expect(res.status).toBe(200);
    await until(() => (gateway!.terminals?.attachedTerminals().length ?? 1) === 0, 2000);
    expect(alive(t.name)).toBe(true);
  }, 60_000);

  test("S5: archiving the task detaches the phone's terminal first, with the reason task-archived", async () => {
    if (!TMUX) throw new Error("tmux is required in CI");
    const t = await setup("configure");
    await t.phone.terminal.attach(t.taskId, t.name);
    await t.phone.next("terminal-attached");
    const res = await fetch(`${BASE}/tasks/${t.taskId}/archive`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    // the phone hears why (not "exited", which is what a tmux session killed under it would say)
    expect(await t.phone.next<{ taskId: string; reason: string }>("terminal-closed")).toEqual({ taskId: t.taskId, reason: "task-archived" });
    expect(gateway!.terminals?.attachedTerminals()).toEqual([]);
    const detach = (await asyncDb.remoteAudit.page({ limit: 50 })).find((a) => a.action === "terminal-detach");
    expect(detach?.resultCode).toBe("task-archived");
  }, 60_000);

  test("S5: deleting the task detaches the phone's terminal first, with the reason task-deleted", async () => {
    if (!TMUX) throw new Error("tmux is required in CI");
    const t = await setup("configure");
    await t.phone.terminal.attach(t.taskId, t.name);
    await t.phone.next("terminal-attached");
    const res = await fetch(`${BASE}/tasks/${t.taskId}`, { method: "DELETE", headers: { authorization: `Bearer ${API_TOKEN}` } });
    expect(res.status, await res.clone().text()).toBe(204);
    expect(await t.phone.next<{ taskId: string; reason: string }>("terminal-closed")).toEqual({ taskId: t.taskId, reason: "task-deleted" });
    expect(gateway!.terminals?.attachedTerminals()).toEqual([]);
  }, 60_000);

  test("S4: a task on a second account of a tmux kind offers its terminal like the built-in one: the challenge and the attach both pass", async () => {
    if (!TMUX) throw new Error("tmux is required in CI");
    const t = await setup("configure");
    tasks.update(t.taskId, { agent: SECOND_CLAUDE });
    expect(tasks.get(t.taskId)!.agent).toBe(SECOND_CLAUDE);
    await t.phone.terminal.attach(t.taskId, t.name);
    await t.phone.next("terminal-attached");
    await t.phone.terminal.input(t.taskId, "second-account\n");
    await until(() => seen(t.phone, t.taskId).includes("second-account"));
    expect(gateway!.terminals?.attachedTerminals().map((a) => a.taskId)).toEqual([t.taskId]);
  }, 60_000);

  test("a task with no tmux session (or a harness that has none) answers no-terminal", async () => {
    if (!TMUX) throw new Error("tmux is required in CI");
    const t = await setup("configure");
    tmux("kill-session", "-t", "=" + t.name);
    // The challenge for a terminal that is not there is refused as gone: there is nothing to show, so nothing to sign.
    await expect(t.phone.terminal.attach(t.taskId, t.name)).rejects.toThrow(/gone/);
    expect(gateway!.terminals?.attachedTerminals()).toEqual([]);
  }, 60_000);
});

describe("tmux availability", () => {
  test("tmux is present, or this suite said so loudly (and fails under CI=true)", () => {
    if (!TMUX) {
      if (process.env.CI === "true") throw new Error("tmux is required in CI (brew install tmux, or bun run vendor:tmux)");
      console.warn("SKIPPED LOUDLY: tmux not found, the phone terminal integration tests did not run");
    }
    expect(true).toBe(true);
  });
});
