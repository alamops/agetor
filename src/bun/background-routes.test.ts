// Route-level tests for "Run Agetor in the background" and the remote-access
// preview switch (docs/plans/always-on-host.md §3.5, row I1): `/background`,
// `/background/start`, `/background/open-settings`, `/remote-access`,
// `PUT /preferences/remoteAccess`, the `background_changed` broadcast on
// `/app/events`, the `mode` body of `/daemon/shutdown` and the `completely`
// body of `/app/force-quit`.
//
// AGETOR_DATA_DIR and the ports are set at module scope BEFORE `./db.ts` /
// `./server.ts` are imported. Two servers run in-process: a headless one (no
// native bridge, like the CLI daemon, with `onShutdownRequest` recorded) on
// 4483 and one with `makeTestNative` on 4484. The login-item helper is the
// file-backed fake (`AGETOR_FAKE_LOGIN_ITEM=1`, `<dataDir>/fake-login-item.json`),
// seeded per test; the env var is toggled per test and restored in afterAll.
import { test, expect, beforeAll, afterAll, beforeEach, afterEach, describe } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REMOTE_ACCESS_PREF_KEY, type AppEvent, type BackgroundStatus, type RemoteAccessStatus } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";
import { makeTestNative } from "./test-native.ts";

// Env this file touches; snapshotted before the first assignment so afterAll
// puts every key back exactly (bun test shares one process across files).
const ENV_KEYS = [
  "AGETOR_DATA_DIR",
  "AGETOR_API_PORT",
  "AGETOR_FAKE_LOGIN_ITEM",
  "AGETOR_FAKE_REMOTE_ACCESS",
  "AGETOR_CLAUDE_BIN",
  "AGETOR_CODEX_BIN",
  "AGETOR_TMUX_BIN",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-background-routes-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Keep every harness probe cheap and local: no real CLI is ever spawned.
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
const HEADLESS = "http://127.0.0.1:4483";
const NATIVE = "http://127.0.0.1:4484";

// `db.ts` is a process-wide singleton: when another test file in the same
// `bun test` process opened it first, the core's data dir is THAT file's, not
// ours. The fake helper and the supervisor state file live in the core's data
// dir, so resolve both from `db.ts`'s own `dataDir` once it is loaded.
let FAKE_FILE = "";
let SUPERVISOR_FILE = "";

const shutdownRequests: ("stop" | "handoff")[] = [];
let nativeQuits = 0;

let servers: { stop: () => void }[] = [];
let master: string;
let cli: string;
let preferences: typeof import("./db.ts").preferences;
let quitGuard: typeof import("./quit-guard.ts");

beforeAll(async () => {
  const dbMod = await import("./db.ts");
  preferences = dbMod.preferences;
  FAKE_FILE = path.join(dbMod.dataDir, "fake-login-item.json");
  SUPERVISOR_FILE = path.join(dbMod.dataDir, "login-daemon.json");
  quitGuard = await import("./quit-guard.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  const { CLI_TOKEN } = await import("./api-config.ts");
  process.env.AGETOR_API_PORT = "4483";
  const headless = startApiServer({
    onShutdownRequest: (mode) => {
      shutdownRequests.push(mode);
    },
  }) as unknown as { stop: () => void };
  process.env.AGETOR_API_PORT = "4484";
  const withNative = startApiServer({
    native: makeTestNative({
      quit: () => {
        nativeQuits++;
      },
    }),
  }) as unknown as { stop: () => void };
  servers = [headless, withNative];
  master = API_TOKEN;
  cli = CLI_TOKEN;
});

afterAll(() => {
  for (const s of servers) s.stop();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmTestDataDir(DATA_DIR);
});

beforeEach(() => {
  process.env.AGETOR_FAKE_LOGIN_ITEM = "1";
  delete process.env.AGETOR_FAKE_REMOTE_ACCESS;
  rmSync(FAKE_FILE, { force: true });
  rmSync(SUPERVISOR_FILE, { force: true });
  preferences.set(REMOTE_ACCESS_PREF_KEY, "off");
  shutdownRequests.length = 0;
  nativeQuits = 0;
  // Drain a flag a previous test left armed (one-shot, module-level).
  quitGuard.consumeForceQuit();
  quitGuard.consumeQuitCompletely();
});

afterEach(() => {
  rmSync(SUPERVISOR_FILE, { force: true });
});

// -- helpers ----------------------------------------------------------------

function seedFake(registration: "enabled" | "notRegistered" | "requiresApproval", extra: Record<string, unknown> = {}) {
  writeFileSync(FAKE_FILE, JSON.stringify({ registration, calls: [], ...extra }));
}

function fakeState(): { registration: string; calls: string[] } {
  return JSON.parse(readFileSync(FAKE_FILE, "utf8")) as { registration: string; calls: string[] };
}

/** Helper calls other than the read-only probes every status derivation makes. */
function actionCalls(): string[] {
  return fakeState().calls.filter((c) => c !== "info" && c !== "status");
}

function seedRunningSupervisor() {
  const now = Date.now();
  writeFileSync(
    SUPERVISOR_FILE,
    JSON.stringify({
      pid: process.pid,
      state: "running",
      corePid: process.pid,
      bundlePath: "/Applications/Agetor.app",
      version: "0.0.0-test",
      label: "sh.alamops.agetor.daemon",
      startedAt: now,
      updatedAt: now,
    }),
  );
}

const req = (
  base: string,
  method: string,
  p: string,
  opts: { token?: string | null; body?: unknown; raw?: string } = {},
) => {
  const token = opts.token === undefined ? master : opts.token;
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let body: string | undefined;
  if (opts.raw !== undefined) {
    body = opts.raw;
    headers["content-type"] = "application/json";
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  return fetch(`${base}${p}`, { method, headers, body });
};

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(10);
  }
}

// -- GET /background --------------------------------------------------------

describe("GET /background", () => {
  test("requires a token", async () => {
    const res = await req(NATIVE, "GET", "/background", { token: null });
    expect(res.status).toBe(401);
  });

  test("answers the derived status for the app and for the CLI", async () => {
    seedFake("notRegistered");
    for (const token of [master, cli]) {
      const res = await req(NATIVE, "GET", "/background?fresh=1", { token });
      expect(res.status).toBe(200);
      const status = (await res.json()) as BackgroundStatus;
      expect(status.state).toBe("off");
      expect(status.registration).toBe("notRegistered");
      expect(status.remoteAccess).toBe(false);
      expect(status.supervisorPid).toBeNull();
    }
  });

  test("is readable headless too (status is not a desktop-only fact)", async () => {
    seedFake("enabled");
    const res = await req(HEADLESS, "GET", "/background?fresh=1", { token: cli });
    expect(res.status).toBe(200);
    const status = (await res.json()) as BackgroundStatus;
    // Enabled with no supervisor alive: macOS has it, nothing is running yet.
    expect(status.state).toBe("stopped");
    expect(status.registration).toBe("enabled");
  });

  test("reports a live supervisor as running with its pids", async () => {
    seedFake("enabled");
    seedRunningSupervisor();
    const status = (await (await req(NATIVE, "GET", "/background?fresh=1")).json()) as BackgroundStatus;
    expect(status.state).toBe("running");
    expect(status.supervisorPid).toBe(process.pid);
    expect(status.corePid).toBe(process.pid);
  });

  test("without ?fresh=1 a repeat read is served from the short cache", async () => {
    seedFake("notRegistered");
    await req(NATIVE, "GET", "/background?fresh=1");
    const probes = () => fakeState().calls.filter((c) => c === "status").length;
    const before = probes();
    await req(NATIVE, "GET", "/background");
    await req(NATIVE, "GET", "/background");
    expect(probes()).toBe(before);
    await req(NATIVE, "GET", "/background?fresh=1");
    expect(probes()).toBe(before + 1);
  });
});

// -- POST /background -------------------------------------------------------

describe("POST /background", () => {
  test("the CLI token is refused as desktop-only and nothing is registered", async () => {
    seedFake("notRegistered");
    const res = await req(NATIVE, "POST", "/background", { token: cli });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("desktop-only");
    expect(actionCalls()).toEqual([]);
    expect(fakeState().registration).toBe("notRegistered");
  });

  test("the app (master token) registers the login item and gets the enabled status", async () => {
    seedFake("notRegistered");
    const res = await req(NATIVE, "POST", "/background");
    expect(res.status).toBe(200);
    const status = (await res.json()) as BackgroundStatus;
    expect(status.registration).toBe("enabled");
    expect(status.state).toBe("stopped");
    expect(actionCalls()).toEqual(["register"]);
    expect(fakeState().registration).toBe("enabled");
  });

  test("an already-enabled item is not registered a second time", async () => {
    seedFake("enabled");
    const res = await req(NATIVE, "POST", "/background");
    expect(res.status).toBe(200);
    expect(actionCalls()).toEqual([]);
  });

  test("a macOS refusal comes back as a state, not an error", async () => {
    seedFake("notRegistered", {
      failNext: {
        command: "register",
        error: { domain: "SMAppServiceErrorDomain", code: 1, message: "Operation not permitted" },
      },
    });
    const res = await req(NATIVE, "POST", "/background");
    expect(res.status).toBe(200);
    const status = (await res.json()) as BackgroundStatus;
    expect(status.state).toBe("off");
    expect(status.detail).toContain("Operation not permitted");
  });

  test("approval pending is reported as needs-approval", async () => {
    seedFake("requiresApproval");
    const status = (await (await req(NATIVE, "GET", "/background?fresh=1")).json()) as BackgroundStatus;
    expect(status.state).toBe("needs-approval");
  });

  test("headless with no fake helper answers 501 (even for the master)", async () => {
    delete process.env.AGETOR_FAKE_LOGIN_ITEM;
    const res = await req(HEADLESS, "POST", "/background");
    expect(res.status).toBe(501);
  });

  test("headless with the fake helper seam is reachable for the app caller", async () => {
    seedFake("notRegistered");
    const res = await req(HEADLESS, "POST", "/background");
    expect(res.status).toBe(200);
    expect(((await res.json()) as BackgroundStatus).registration).toBe("enabled");
  });

  test("headless answers the CLI token 501 (policy headless501), never reaching the helper", async () => {
    seedFake("notRegistered");
    const res = await req(HEADLESS, "POST", "/background", { token: cli });
    expect(res.status).toBe(501);
    expect(actionCalls()).toEqual([]);
    expect(fakeState().registration).toBe("notRegistered");
  });
});

// -- DELETE /background -----------------------------------------------------

describe("DELETE /background", () => {
  test("unregisters the item and also turns remote access off (C3)", async () => {
    seedFake("enabled");
    preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
    const res = await req(NATIVE, "DELETE", "/background");
    expect(res.status).toBe(200);
    const status = (await res.json()) as BackgroundStatus;
    expect(status.state).toBe("off");
    expect(status.registration).toBe("notRegistered");
    expect(status.remoteAccess).toBe(false);
    expect(preferences.get(REMOTE_ACCESS_PREF_KEY)).toBe("off");
    expect(actionCalls()).toEqual(["unregister"]);
  });

  test("is allowed for the CLI token (turning it off is not desktop-only)", async () => {
    seedFake("enabled");
    const res = await req(NATIVE, "DELETE", "/background", { token: cli });
    expect(res.status).toBe(200);
    expect(((await res.json()) as BackgroundStatus).state).toBe("off");
    expect(fakeState().registration).toBe("notRegistered");
  });

  test("turning off while remote access is already off leaves it off", async () => {
    seedFake("enabled");
    const res = await req(NATIVE, "DELETE", "/background");
    expect(((await res.json()) as BackgroundStatus).remoteAccess).toBe(false);
    expect(preferences.get(REMOTE_ACCESS_PREF_KEY)).toBe("off");
  });

  test("with a live host, remote access reads back as on until DELETE clears it", async () => {
    // A running host keeps the C3 reconcile from switching remote access off
    // on its own, so the stored "on" is visible in the status first.
    seedFake("enabled");
    seedRunningSupervisor();
    preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
    const before = (await (await req(NATIVE, "GET", "/background?fresh=1")).json()) as BackgroundStatus;
    expect(before.state).toBe("running");
    expect(before.remoteAccess).toBe(true);
    const after = (await (await req(NATIVE, "DELETE", "/background")).json()) as BackgroundStatus;
    expect(after.remoteAccess).toBe(false);
    expect(preferences.get(REMOTE_ACCESS_PREF_KEY)).toBe("off");
  });
});

// -- POST /background/start -------------------------------------------------

describe("POST /background/start", () => {
  test("409 not-enabled when the item isn't registered", async () => {
    seedFake("notRegistered");
    const res = await req(NATIVE, "POST", "/background/start");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("not-enabled");
    expect(actionCalls()).toEqual([]);
  });

  test("409 already-running when a supervisor is alive", async () => {
    seedFake("enabled");
    seedRunningSupervisor();
    const res = await req(NATIVE, "POST", "/background/start");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("already-running");
    expect(actionCalls()).toEqual([]);
  });

  test("409 unavailable when the switch can't be used on this install", async () => {
    seedFake("enabled", { info: { channel: "dev" } });
    const res = await req(NATIVE, "POST", "/background/start");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("unavailable");
  });

  test("200 when enabled with nothing running: re-registers to boot a supervisor", async () => {
    seedFake("enabled");
    const res = await req(NATIVE, "POST", "/background/start");
    expect(res.status).toBe(200);
    expect(actionCalls()).toEqual(["reregister"]);
    const status = (await res.json()) as BackgroundStatus;
    expect(status.registration).toBe("enabled");
  });

  test("is reachable by the CLI token (agetor daemon background start)", async () => {
    seedFake("enabled");
    const res = await req(NATIVE, "POST", "/background/start", { token: cli });
    expect(res.status).toBe(200);
    expect(actionCalls()).toEqual(["reregister"]);
  });
});

// -- POST /background/open-settings -----------------------------------------

describe("POST /background/open-settings", () => {
  test("the CLI token is refused as desktop-only", async () => {
    seedFake("enabled");
    const res = await req(NATIVE, "POST", "/background/open-settings", { token: cli });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("desktop-only");
    expect(actionCalls()).toEqual([]);
  });

  test("the app opens System Settings through the helper", async () => {
    seedFake("enabled");
    const res = await req(NATIVE, "POST", "/background/open-settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(actionCalls()).toEqual(["openSettings"]);
  });

  test("a helper failure surfaces as a 500 with the message", async () => {
    seedFake("enabled", {
      failNext: { command: "openSettings", error: { domain: "x", code: 1, message: "settings pane unavailable" } },
    });
    const res = await req(NATIVE, "POST", "/background/open-settings");
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("settings pane unavailable");
  });

  test("headless answers the CLI token 501 (policy headless501) and never reaches the helper", async () => {
    seedFake("enabled");
    const res = await req(HEADLESS, "POST", "/background/open-settings", { token: cli });
    expect(res.status).toBe(501);
    expect(actionCalls()).toEqual([]);
  });

  test("headless with no fake helper answers the master 501 too", async () => {
    delete process.env.AGETOR_FAKE_LOGIN_ITEM;
    const res = await req(HEADLESS, "POST", "/background/open-settings");
    expect(res.status).toBe(501);
  });

  test("headless with the fake seam reaches the helper for the master (e2e seam)", async () => {
    seedFake("enabled");
    const res = await req(HEADLESS, "POST", "/background/open-settings");
    expect(res.status).toBe(200);
    expect(actionCalls()).toEqual(["openSettings"]);
  });
});

// -- /remote-access ---------------------------------------------------------

describe("/remote-access", () => {
  test("GET reports the preference as a preview switch, for both callers", async () => {
    for (const token of [master, cli]) {
      const res = await req(NATIVE, "GET", "/remote-access", { token });
      expect(res.status).toBe(200);
      expect((await res.json()) as RemoteAccessStatus).toEqual({ enabled: false, preview: true });
    }
    preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
    expect((await (await req(NATIVE, "GET", "/remote-access", { token: cli })).json()) as RemoteAccessStatus).toEqual({
      enabled: true,
      preview: true,
    });
  });

  test("DELETE turns it off and returns the new status (CLI token allowed)", async () => {
    preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
    const res = await req(NATIVE, "DELETE", "/remote-access", { token: cli });
    expect(res.status).toBe(200);
    expect((await res.json()) as RemoteAccessStatus).toEqual({ enabled: false, preview: true });
    expect(preferences.get(REMOTE_ACCESS_PREF_KEY)).toBe("off");
  });

  test("there is no way to turn it on over HTTP: POST/PUT on the route don't exist", async () => {
    for (const method of ["POST", "PUT"]) {
      const res = await req(NATIVE, method, "/remote-access", { body: { enabled: true } });
      expect(res.status).not.toBe(200);
    }
    expect(preferences.get(REMOTE_ACCESS_PREF_KEY)).toBe("off");
  });

  test("requires a token", async () => {
    expect((await req(NATIVE, "GET", "/remote-access", { token: null })).status).toBe(401);
    expect((await req(NATIVE, "DELETE", "/remote-access", { token: null })).status).toBe(401);
  });
});

describe("PUT /preferences/remoteAccess", () => {
  test('"on" is refused 403 native-only for the master AND the CLI token, and nothing is stored', async () => {
    for (const token of [master, cli]) {
      for (const base of [NATIVE, HEADLESS]) {
        const res = await req(base, "PUT", `/preferences/${REMOTE_ACCESS_PREF_KEY}`, { token, body: { value: "on" } });
        expect(res.status).toBe(403);
        expect(((await res.json()) as { code: string }).code).toBe("native-only");
      }
    }
    expect(preferences.get(REMOTE_ACCESS_PREF_KEY)).toBe("off");
  });

  test("any value other than exactly \"off\" is refused (truthy lookalikes included)", async () => {
    for (const value of ["true", "ON", "1", "", "yes"]) {
      const res = await req(NATIVE, "PUT", `/preferences/${REMOTE_ACCESS_PREF_KEY}`, { body: { value } });
      expect(res.status).toBe(403);
    }
    expect(preferences.get(REMOTE_ACCESS_PREF_KEY)).toBe("off");
  });

  test('"off" is accepted (204) for both callers and clears an enabled switch', async () => {
    for (const token of [master, cli]) {
      preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
      const res = await req(NATIVE, "PUT", `/preferences/${REMOTE_ACCESS_PREF_KEY}`, { token, body: { value: "off" } });
      expect(res.status).toBe(204);
      expect(preferences.get(REMOTE_ACCESS_PREF_KEY)).toBe("off");
    }
  });
});

// -- background_changed on /app/events --------------------------------------

describe("background_changed broadcast", () => {
  /** Open /app/events, run `trigger`, and resolve with the first
   *  `background_changed` event seen (or null after `ms`). Always cancels. */
  async function nextBackgroundEvent(trigger: () => Promise<unknown>, ms = 4000): Promise<AppEvent | null> {
    const ctl = new AbortController();
    const res = await fetch(`${NATIVE}/app/events`, {
      headers: { authorization: `Bearer ${master}` },
      signal: ctl.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    // The server flushes ": connected" first, so the subscription is live
    // before we mutate anything.
    while (!buf.includes(": connected")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    buf = "";
    const deadline = Date.now() + ms;
    try {
      await trigger();
      while (Date.now() < deadline) {
        const timeout = Bun.sleep(Math.max(0, deadline - Date.now())).then(() => "timeout" as const);
        const chunk = await Promise.race([reader.read(), timeout]);
        if (chunk === "timeout") break;
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        for (const frame of buf.split("\n\n")) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6)) as AppEvent;
          if (ev.type === "background_changed") return ev;
        }
      }
      return null;
    } finally {
      ctl.abort();
      await reader.cancel().catch(() => {});
    }
  }

  test("turning the background on pushes a background_changed with the new status", async () => {
    seedFake("notRegistered");
    const ev = await nextBackgroundEvent(() => req(NATIVE, "POST", "/background"));
    expect(ev).not.toBeNull();
    const e = ev as Extract<AppEvent, { type: "background_changed" }>;
    expect(e.status.registration).toBe("enabled");
    expect(typeof e.ts).toBe("number");
  });

  test("turning remote access off pushes one too", async () => {
    seedFake("enabled");
    seedRunningSupervisor();
    preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
    const ev = await nextBackgroundEvent(() => req(NATIVE, "DELETE", "/remote-access"));
    expect(ev).not.toBeNull();
    const e = ev as Extract<AppEvent, { type: "background_changed" }>;
    expect(e.status.remoteAccess).toBe(false);
  });

  test("a read-only GET does not broadcast", async () => {
    seedFake("enabled");
    const ev = await nextBackgroundEvent(() => req(NATIVE, "GET", "/background?fresh=1"), 600);
    expect(ev).toBeNull();
  });
});

// -- /daemon/shutdown {mode} -------------------------------------------------

describe("POST /daemon/shutdown mode", () => {
  test('{mode:"handoff"} calls the injected onShutdownRequest("handoff")', async () => {
    const res = await req(HEADLESS, "POST", "/daemon/shutdown", { token: cli, body: { mode: "handoff" } });
    expect(res.status).toBe(200);
    await waitFor(() => shutdownRequests.length > 0);
    expect(shutdownRequests).toEqual(["handoff"]);
  });

  test('{mode:"stop"}, no body, an empty body and a garbage body all mean "stop"', async () => {
    const attempts: Parameters<typeof req>[3][] = [
      { body: { mode: "stop" } },
      {},
      { raw: "" },
      { raw: "not json {" },
      { body: { mode: "bogus" } },
      { body: { mode: 7 } },
    ];
    let expected = 0;
    for (const opts of attempts) {
      const res = await req(HEADLESS, "POST", "/daemon/shutdown", { token: cli, ...opts });
      expect(res.status).toBe(200);
      expected++;
      await waitFor(() => shutdownRequests.length >= expected);
    }
    expect(shutdownRequests).toEqual(attempts.map(() => "stop"));
  });

  test("on the app the mode is ignored: the quit goes through the native host", async () => {
    const res = await req(NATIVE, "POST", "/daemon/shutdown", { body: { mode: "handoff" } });
    expect(res.status).toBe(200);
    await waitFor(() => nativeQuits > 0);
    expect(nativeQuits).toBe(1);
    expect(shutdownRequests).toEqual([]);
  });

  test("requires a token", async () => {
    const res = await req(HEADLESS, "POST", "/daemon/shutdown", { token: null, body: { mode: "handoff" } });
    expect(res.status).toBe(401);
    await Bun.sleep(30);
    expect(shutdownRequests).toEqual([]);
  });
});

// -- /app/force-quit {completely} --------------------------------------------

describe("POST /app/force-quit completely", () => {
  test("{completely:true} arms a complete quit and queues the native quit", async () => {
    const res = await req(NATIVE, "POST", "/app/force-quit", { body: { completely: true } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await waitFor(() => nativeQuits > 0);
    expect(quitGuard.consumeForceQuit()).toEqual({ completely: true });
    // One-shot: the flag is spent.
    expect(quitGuard.consumeForceQuit()).toBeNull();
  });

  test("no body, or a non-true value, arms a plain quit-anyway", async () => {
    for (const opts of [{}, { raw: "garbage" }, { body: { completely: "true" } }, { body: { completely: 1 } }]) {
      const res = await req(NATIVE, "POST", "/app/force-quit", opts);
      expect(res.status).toBe(200);
      expect(quitGuard.consumeForceQuit()).toEqual({ completely: false });
    }
    // Each call queued a native quit on the next tick; let them all land so
    // they can't leak into the next test's counter.
    await waitFor(() => nativeQuits >= 4);
  });

  test("a repeat call is a no-op and never changes the mode the first one chose", async () => {
    await req(NATIVE, "POST", "/app/force-quit", { body: { completely: true } });
    const second = await req(NATIVE, "POST", "/app/force-quit", { body: { completely: false } });
    expect(await second.json()).toEqual({ ok: true, alreadyArmed: true });
    await waitFor(() => nativeQuits > 0);
    await Bun.sleep(30);
    expect(nativeQuits).toBe(1);
    expect(quitGuard.consumeForceQuit()).toEqual({ completely: true });
  });

  test("the CLI token is refused as desktop-only and arms nothing", async () => {
    const res = await req(NATIVE, "POST", "/app/force-quit", { token: cli, body: { completely: true } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("desktop-only");
    expect(quitGuard.consumeForceQuit()).toBeNull();
    expect(nativeQuits).toBe(0);
  });

  test("headless answers 501 and arms nothing", async () => {
    const res = await req(HEADLESS, "POST", "/app/force-quit", { body: { completely: true } });
    expect(res.status).toBe(501);
    expect(quitGuard.consumeForceQuit()).toBeNull();
  });
});

test("the fake helper file really is where the routes read it (sanity)", () => {
  seedFake("enabled");
  expect(existsSync(FAKE_FILE)).toBe(true);
});
