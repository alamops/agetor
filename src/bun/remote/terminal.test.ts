import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fromBase64, toBase64 } from "@agetor/remote-protocol/bytes";
import type { AppEvent } from "../../shared/types.ts";
import type { AttachMessage, TerminalClient, TerminalDeps } from "./terminal.ts";
import type { DevicePrincipal, PhoneChannel } from "./types.ts";

// terminal.ts reaches the tmux driver, which opens the database on import: pin a throwaway data dir first (top level, before the imports).
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agt-terminal-"));
const { DecisionError } = await import("./decisions.ts");
const { MAX_PENDING_OUTPUT_BYTES, OUTPUT_CHUNK_BYTES, createLiveTerminalDeps, createTerminalManager } = await import("./terminal.ts");
const { resolveTmuxBin, tmuxSocketArgs } = await import("../tmux-resolution.ts");
const { rmTestDataDir } = await import("../test-data-dir.ts");
afterAll(() => rmTestDataDir(process.env.AGETOR_DATA_DIR!));

function principal(level: DevicePrincipal["level"] = "configure", sessionId = "s1", deviceId = "d1"): DevicePrincipal {
  return { kind: "device", deviceId, deviceName: "Ana's iPhone", level, sessionId, sessionHash: new Uint8Array(32), approvePub: new Uint8Array(65) };
}

function fakeChannel(p = principal()) {
  const sent: Array<{ type: string; body: Record<string, unknown> }> = [];
  const closeFns = new Set<(r: string) => void>();
  const peerFns = new Set<(b: boolean) => void>();
  let present = true;
  const ch: PhoneChannel = {
    principal: p,
    send: (type, body) => void sent.push({ type, body: body as Record<string, unknown> }),
    queuedBytes: () => 0,
    peerPresent: () => present,
    onClose: (fn) => (closeFns.add(fn), () => void closeFns.delete(fn)),
    onPeerChange: (fn) => (peerFns.add(fn), () => void peerFns.delete(fn)),
  };
  return {
    ch, sent, types: () => sent.map((s) => s.type),
    close: (r = "ended") => closeFns.forEach((f) => f(r)),
    setPeer: (v: boolean) => { present = v; peerFns.forEach((f) => f(v)); },
  };
}

class FakeClient implements TerminalClient {
  written: Uint8Array[] = [];
  resized: Array<[number, number]> = [];
  killed = 0;
  exitFns: Array<() => void> = [];
  constructor(readonly name: string, readonly size: { cols: number; rows: number }, readonly onData: (c: Uint8Array) => void) {}
  write(d: Uint8Array) { this.written.push(d); }
  resize(c: number, r: number) { this.resized.push([c, r]); }
  kill() { this.killed++; }
  onExit(fn: () => void) { this.exitFns.push(fn); }
}

function rig(over: Partial<TerminalDeps> = {}) {
  let t = 1_000_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const clients: FakeClient[] = [];
  const audit: Array<{ action: string; fields: Record<string, unknown> }> = [];
  const events: AppEvent[] = [];
  const verified: unknown[] = [];
  const deps: TerminalDeps = {
    decisions: { verifyTerminalAttach: async (_p, signed, target) => (verified.push({ signed, target }), signed.payload as never) },
    audit: { event: async (action, fields) => (audit.push({ action, fields: (fields ?? {}) as Record<string, unknown> }), { seq: audit.length, hash: "" }) },
    task: async (id) => (id === "t1" ? { agent: "claude-code" } : id === "acp" ? { agent: "cursor" } : null),
    sessionName: (id) => `agetor-${id}`,
    sessionAlive: async (n) => n !== "agetor-dead",
    spawnClient: (name, size, onData) => { const c = new FakeClient(name, size, onData); clients.push(c); return c; },
    broadcast: (e) => void events.push(e),
    now: () => t,
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (h) => void timers.delete(h as number),
    ...over,
  };
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      t = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }
    t = end;
  };
  return { mgr: createTerminalManager(deps), clients, audit, events, verified, advance, timers };
}

const attachMsg = (over: Partial<AttachMessage> = {}): AttachMessage => ({ id: "a1", taskId: "t1", cols: 80, rows: 24, payload: { signed: true }, sig: "ab".repeat(64), ...over });
const text = (s: string) => new TextEncoder().encode(s);

describe("attach", () => {
  test("a configure device with a good signature attaches to the task's own session, and everyone is told", async () => {
    const r = rig();
    const c = fakeChannel();
    await r.mgr.attach(c.ch, attachMsg());
    expect(c.types()).toEqual(["terminal-attached"]);
    expect(r.clients[0]).toMatchObject({ name: "agetor-t1", size: { cols: 80, rows: 24 } });
    expect(r.verified[0]).toMatchObject({ target: { kind: "terminal", taskId: "t1", tmuxSession: "agetor-t1" } });
    expect(r.audit.map((a) => a.action)).toEqual(["terminal-attach"]);
    expect(r.events.map((e) => (e as { type: string }).type)).toEqual(["phone_terminal", "remote_action"]);
    expect(r.events[0]).toMatchObject({ type: "phone_terminal", taskId: "t1", deviceId: "d1", attached: true });
    expect(r.mgr.attachedTerminals()).toEqual([expect.objectContaining({ taskId: "t1", deviceId: "d1", deviceName: "Ana's iPhone" })]);
  });
  test("below configure it is a level error and nothing is spawned", async () => {
    const r = rig();
    for (const level of ["observe", "respond", "operate"] as const) {
      const c = fakeChannel(principal(level));
      await r.mgr.attach(c.ch, attachMsg());
      expect(c.sent[0]).toMatchObject({ type: "error", body: { id: "a1", code: "level" } });
    }
    expect(r.clients).toHaveLength(0);
  });
  test("an ACP harness, a missing task and a dead session are all no-terminal", async () => {
    const r = rig();
    for (const taskId of ["acp", "missing", "dead"]) {
      const c = fakeChannel();
      await r.mgr.attach(c.ch, attachMsg({ taskId }));
      expect(c.sent[0]).toMatchObject({ type: "error", body: { code: "no-terminal" } });
    }
    const dead = rig({ task: async () => ({ agent: "claude-code" }), sessionName: () => "agetor-dead" });
    const c = fakeChannel();
    await dead.mgr.attach(c.ch, attachMsg());
    expect(c.sent[0]!.body.code).toBe("no-terminal");
    expect(r.clients).toHaveLength(0);
  });
  test("a bad signature is refused with the check that failed, audited, and spawns nothing", async () => {
    const r = rig({ decisions: { verifyTerminalAttach: async () => { throw new DecisionError("signature"); } } });
    const c = fakeChannel();
    await r.mgr.attach(c.ch, attachMsg());
    expect(c.sent[0]).toMatchObject({ type: "error", body: { code: "signature" } });
    expect(r.clients).toHaveLength(0);
    expect(r.audit).toEqual([{ action: "refusal", fields: expect.objectContaining({ resultCode: "signature" }) }]);
  });
  test("a second phone replaces the first, which is told", async () => {
    const r = rig();
    const a = fakeChannel(principal("configure", "s1", "d1"));
    const b = fakeChannel(principal("configure", "s2", "d2"));
    await r.mgr.attach(a.ch, attachMsg());
    await r.mgr.attach(b.ch, attachMsg({ id: "a2" }));
    expect(a.sent.at(-1)).toEqual({ type: "terminal-closed", body: { taskId: "t1", reason: "replaced" } });
    expect(r.clients[0]!.killed).toBe(1);
    expect(r.mgr.attachedTerminals().map((t) => t.deviceId)).toEqual(["d2"]);
  });
});

describe("output", () => {
  test("output within 50 ms goes out as one message; over 16 KB it is split", async () => {
    const r = rig();
    const c = fakeChannel();
    await r.mgr.attach(c.ch, attachMsg());
    const cl = r.clients[0]!;
    cl.onData(text("hel"));
    cl.onData(text("lo\n"));
    expect(c.types()).toEqual(["terminal-attached"]);
    r.advance(50);
    expect(c.sent.slice(1)).toEqual([{ type: "terminal-output", body: { taskId: "t1", data: toBase64(text("hello\n")) } }]);
    cl.onData(new Uint8Array(OUTPUT_CHUNK_BYTES * 2 + 100).fill(65));
    r.advance(50);
    const outs = c.sent.filter((s) => s.type === "terminal-output").slice(1);
    expect(outs.map((o) => fromBase64(String(o.body.data)).length)).toEqual([OUTPUT_CHUNK_BYTES, OUTPUT_CHUNK_BYTES, 100]);
  });
  test("a phone that cannot keep up is detached instead of being sent garbage", async () => {
    const r = rig();
    const c = fakeChannel();
    await r.mgr.attach(c.ch, attachMsg());
    r.clients[0]!.onData(new Uint8Array(MAX_PENDING_OUTPUT_BYTES + 1));
    expect(c.sent.at(-1)).toEqual({ type: "terminal-closed", body: { taskId: "t1", reason: "too-slow" } });
    expect(r.clients[0]!.killed).toBe(1);
  });
});

describe("input", () => {
  test("input and resize reach the tmux client; the input is not in the audit", async () => {
    const r = rig();
    const c = fakeChannel();
    await r.mgr.attach(c.ch, attachMsg());
    r.mgr.input(c.ch, { taskId: "t1", data: toBase64(text("MY-SECRET-PASSWORD\n")) });
    r.mgr.resize(c.ch, { taskId: "t1", cols: 100, rows: 30 });
    expect(new TextDecoder().decode(r.clients[0]!.written[0])).toBe("MY-SECRET-PASSWORD\n");
    expect(r.clients[0]!.resized).toEqual([[100, 30]]);
    expect(JSON.stringify(r.audit)).not.toContain("SECRET");
    expect(JSON.stringify(r.audit)).not.toContain(toBase64(text("MY-SECRET-PASSWORD\n")));
  });
  test("another session's input, an unattached task's input and bad base64 are ignored", async () => {
    const r = rig();
    const c = fakeChannel();
    await r.mgr.attach(c.ch, attachMsg());
    r.mgr.input(fakeChannel(principal("configure", "other")).ch, { taskId: "t1", data: toBase64(text("x")) });
    r.mgr.input(c.ch, { taskId: "t2", data: toBase64(text("x")) });
    r.mgr.input(c.ch, { taskId: "t1", data: "!!!not base64" });
    expect(r.clients[0]!.written).toHaveLength(0);
  });
});

describe("every way it ends kills only the tmux client, tells the phone, audits and raises the app event", () => {
  async function attached() {
    const r = rig();
    const c = fakeChannel();
    await r.mgr.attach(c.ch, attachMsg());
    r.events.length = 0;
    r.audit.length = 0;
    return { r, c };
  }
  const closedWith = (c: ReturnType<typeof fakeChannel>) => (c.sent.at(-1)!.body as { reason: string }).reason;

  test("the phone detaches", async () => {
    const { r, c } = await attached();
    r.mgr.detach(c.ch, "t1");
    expect([c.sent.at(-1)!.type, closedWith(c)]).toEqual(["terminal-closed", "detached"]);
    expect(r.clients[0]!.killed).toBe(1);
    expect(r.audit[0]).toMatchObject({ action: "terminal-detach", fields: { resultCode: "detached" } });
    expect(r.events[0]).toMatchObject({ type: "phone_terminal", attached: false });
    expect(r.mgr.attachedTerminals()).toEqual([]);
  });
  test("the session closes", async () => {
    const { r, c } = await attached();
    c.close("revoked");
    expect(r.clients[0]!.killed).toBe(1);
    expect(r.mgr.attachedTerminals()).toEqual([]);
  });
  test("the phone is away for more than 30 s (and coming back in time keeps it)", async () => {
    const { r, c } = await attached();
    c.setPeer(false);
    r.advance(29_000);
    c.setPeer(true);
    r.advance(60_000);
    expect(r.mgr.attachedTerminals()).toHaveLength(1);
    c.setPeer(false);
    r.advance(30_000);
    expect(closedWith(c)).toBe("phone-away");
    expect(r.clients[0]!.killed).toBe(1);
  });
  test("15 minutes without input (input resets it)", async () => {
    const { r, c } = await attached();
    r.advance(14 * 60_000);
    r.mgr.input(c.ch, { taskId: "t1", data: toBase64(text("ls\n")) });
    r.advance(14 * 60_000);
    expect(r.mgr.attachedTerminals()).toHaveLength(1);
    r.advance(60_000);
    expect(closedWith(c)).toBe("idle");
  });
  test("the Mac's Detach, a task archived, a device revoked", async () => {
    const a = await attached();
    expect(a.r.mgr.detachForTask("t1", "mac-detach")).toBe(true);
    expect(closedWith(a.c)).toBe("mac-detach");
    expect(a.r.mgr.detachForTask("t1", "mac-detach")).toBe(false);
    const b = await attached();
    b.r.mgr.detachForDevice("d1", "revoked");
    expect(closedWith(b.c)).toBe("revoked");
    b.r.mgr.detachForDevice("nobody", "revoked");
  });
  test("the tmux client exits by itself", async () => {
    const { r, c } = await attached();
    r.clients[0]!.exitFns.forEach((f) => f());
    expect(closedWith(c)).toBe("exited");
  });
  test("ending twice is harmless", async () => {
    const { r, c } = await attached();
    r.mgr.detach(c.ch, "t1");
    r.mgr.detach(c.ch, "t1");
    c.close();
    expect(r.clients[0]!.killed).toBe(1);
    expect(r.audit.filter((a) => a.action === "terminal-detach")).toHaveLength(1);
  });
  test("stop detaches everything", async () => {
    const { r } = await attached();
    r.mgr.stop();
    expect(r.mgr.attachedTerminals()).toEqual([]);
  });
});

// ── with a real tmux ───────────────────────────────────────────────────────────────────────────────────────────────────────

// The real tmux, found on PATH: other test files in the same `bun test` process point AGETOR_TMUX_BIN at /bin/echo while they run, so the
// real-tmux test sets the override itself for its own duration.
const tmuxPath = (() => {
  const bin = Bun.which("tmux");
  return bin && Bun.spawnSync([bin, "-V"]).exitCode === 0 ? bin : null;
})();

describe("with a real tmux", () => {
  const sessions: string[] = [];
  const savedBin = process.env.AGETOR_TMUX_BIN;
  afterEach(async () => {
    if (savedBin === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = savedBin;
    for (const s of sessions.splice(0)) Bun.spawnSync([resolveTmuxBin(), ...tmuxSocketArgs(), "kill-session", "-t", "=" + s]);
  });

  test("attach, echo through a session running cat, detach on idle: the session is still alive", async () => {
    if (!tmuxPath) {
      if (process.env.CI === "true") throw new Error("tmux is required in CI (bun run vendor:tmux, or install it)");
      console.warn("SKIPPED (tmux not found): the real-tmux terminal test did not run");
      return;
    }
    process.env.AGETOR_TMUX_BIN = tmuxPath;
    const name = `agetor-term${Math.random().toString(36).slice(2, 8)}`;
    sessions.push(name);
    const run = (args: string[]) => Bun.spawnSync([resolveTmuxBin(), ...tmuxSocketArgs(), ...args]);
    expect(run(["new-session", "-d", "-s", name, "-x", "80", "-y", "24", "cat"]).exitCode).toBe(0);

    const live = createLiveTerminalDeps();
    const r = rig({
      task: async () => ({ agent: "claude-code" }),
      sessionName: () => name,
      sessionAlive: async (n) => run(["has-session", "-t", "=" + n]).exitCode === 0,
      spawnClient: live.spawnClient,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      limits: { coalesceMs: 20, idleMs: 600 },
    });
    const c = fakeChannel();
    await r.mgr.attach(c.ch, attachMsg({ taskId: "t1" }));
    expect(c.types()[0]).toBe("terminal-attached");
    r.mgr.input(c.ch, { taskId: "t1", data: toBase64(text("hello-from-phone\n")) });
    const seen = () => c.sent.filter((s) => s.type === "terminal-output").map((s) => new TextDecoder().decode(fromBase64(String(s.body.data)))).join("");
    const end = Date.now() + 5000;
    while (!seen().includes("hello-from-phone") && Date.now() < end) await new Promise((res) => setTimeout(res, 25));
    expect(seen()).toContain("hello-from-phone");

    // idle: detached, and the session (and its cat) lives on
    const until = Date.now() + 5000;
    while (r.mgr.attachedTerminals().length > 0 && Date.now() < until) await new Promise((res) => setTimeout(res, 25));
    expect(c.sent.at(-1)).toEqual({ type: "terminal-closed", body: { taskId: "t1", reason: "idle" } });
    await new Promise((res) => setTimeout(res, 100));
    expect(run(["has-session", "-t", "=" + name]).exitCode).toBe(0);
    const pane = Bun.spawnSync([resolveTmuxBin(), ...tmuxSocketArgs(), "capture-pane", "-p", "-t", "=" + name + ":"]).stdout.toString();
    expect(pane).toContain("hello-from-phone");
  }, 20_000);
});
