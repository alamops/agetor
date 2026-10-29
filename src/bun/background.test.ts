import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REMOTE_ACCESS_PREF_KEY, type BackgroundStatus } from "../shared/types.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

// The core-side background controller (docs/plans/always-on-host.md §3.3-§3.5;
// grill C3, C9, C10, C11, C17), driven end to end through the file-backed fake
// login-item helper (AGETOR_FAKE_LOGIN_ITEM=1). Under that seam background.ts
// treats the platform as darwin and the fake's channel data dir as this
// core's, so every state is reachable from a temp directory.
//
// db.ts is a process-wide singleton that opens whichever AGETOR_DATA_DIR was set
// at its FIRST import in the `bun test` process, so this file never assumes its
// own mkdtemp is the live data dir: it reads the real one from db.ts's
// `dataDir` export and puts/removes only its own fake-login-item.json /
// login-daemon.json files there.

const ENV_KEYS = [
  "AGETOR_DATA_DIR",
  "AGETOR_FAKE_LOGIN_ITEM",
  "AGETOR_FAKE_REMOTE_ACCESS",
  "AGETOR_LAUNCHED_BY",
  "AGETOR_LOGIN_ITEM_HELPER",
  "AGETOR_BACKGROUND_START_GRACE_MS",
] as const;
const savedEnv: Record<string, string | undefined> = {};

let tmp: string;
let dir: string; // db.ts's real data dir
let bg: typeof import("./background.ts");
let db: typeof import("./db.ts");
let daemonState: typeof import("./login-daemon-state.ts");

const fakeFile = () => path.join(dir, "fake-login-item.json");
const daemonFile = () => path.join(dir, "login-daemon.json");

function seedFake(state: Record<string, unknown> = {}): void {
  writeFileSync(fakeFile(), JSON.stringify({ registration: "notRegistered", calls: [], ...state }));
}
const readFake = () =>
  JSON.parse(readFileSync(fakeFile(), "utf8")) as {
    registration: string;
    calls: string[];
    failNext?: unknown;
  };
const callsOf = (name: string) => readFake().calls.filter((c) => c === name).length;

/** A live supervisor (this test process's pid is alive by definition). */
function seedSupervisor(over: Partial<import("./login-daemon-state.ts").LoginDaemonState> = {}): void {
  daemonState.writeLoginDaemonState(
    {
      pid: process.pid,
      state: "running",
      corePid: process.pid,
      bundlePath: "/Applications/Agetor.app",
      version: "1.0.0",
      label: "sh.alamops.agetor.daemon",
      startedAt: 1,
      updatedAt: 2,
      ...over,
    },
    dir,
  );
}

const remotePref = () => db.preferences.get(REMOTE_ACCESS_PREF_KEY);
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmp = mkdtempSync(path.join(tmpdir(), "background-test-"));
  process.env.AGETOR_DATA_DIR = tmp;
  process.env.AGETOR_FAKE_LOGIN_ITEM = "1";
  delete process.env.AGETOR_FAKE_REMOTE_ACCESS;
  delete process.env.AGETOR_LAUNCHED_BY;
  delete process.env.AGETOR_LOGIN_ITEM_HELPER;
  delete process.env.AGETOR_BACKGROUND_START_GRACE_MS;
  db = await import("./db.ts");
  dir = db.dataDir;
  daemonState = await import("./login-daemon-state.ts");
  bg = await import("./background.ts");
});

afterAll(async () => {
  for (const f of [fakeFile(), daemonFile()]) rmSync(f, { force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  db.preferences.set(REMOTE_ACCESS_PREF_KEY, "off");
  rmTestDataDir(tmp); // kept (returns false) when db.ts opened its sqlite here
});

beforeEach(async () => {
  delete process.env.AGETOR_LAUNCHED_BY;
  delete process.env.AGETOR_BACKGROUND_START_GRACE_MS;
  bg.__testing.resetStartGrace();
  rmSync(daemonFile(), { force: true });
  seedFake();
  db.preferences.set(REMOTE_ACCESS_PREF_KEY, "off");
  // Drop the 2 s status cache and any in-flight probe left by an earlier test.
  await bg.getBackgroundStatus({ fresh: true });
  await tick(5);
});

afterEach(async () => {
  delete process.env.AGETOR_LAUNCHED_BY;
  // Let deferred notifyChanged()/unregister timers from this test drain so they
  // can't write into the next one's fake file.
  await tick(25);
});

describe("getBackgroundStatus", () => {
  test("derives from the helper's registration: off, needs-approval, stopped", async () => {
    seedFake({ registration: "notRegistered" });
    expect((await bg.getBackgroundStatus({ fresh: true })).state).toBe("off");

    seedFake({ registration: "requiresApproval" });
    const approval = await bg.getBackgroundStatus({ fresh: true });
    expect(approval.state).toBe("needs-approval");
    expect(approval.registration).toBe("requiresApproval");

    seedFake({ registration: "enabled" });
    const stopped = await bg.getBackgroundStatus({ fresh: true });
    expect(stopped).toMatchObject({ state: "stopped", registration: "enabled", supervisorPid: null });
  });

  test("a live supervisor in login-daemon.json makes an enabled item running / parked / starting", async () => {
    seedFake({ registration: "enabled" });
    seedSupervisor({ state: "running", corePid: process.pid });
    expect(await bg.getBackgroundStatus({ fresh: true })).toMatchObject({
      state: "running",
      supervisorPid: process.pid,
      corePid: process.pid,
    });
    seedSupervisor({ state: "parked", corePid: null });
    expect((await bg.getBackgroundStatus({ fresh: true })).state).toBe("parked");
    seedSupervisor({ state: "waiting", corePid: null });
    expect((await bg.getBackgroundStatus({ fresh: true })).state).toBe("starting");
  });

  test("a supervisor file whose process is dead doesn't count", async () => {
    seedFake({ registration: "enabled" });
    // pid 2^22+ is beyond macOS's pid space.
    seedSupervisor({ pid: 99_999_999, state: "running", corePid: 99_999_998 });
    expect((await bg.getBackgroundStatus({ fresh: true })).state).toBe("stopped");
  });

  test("the login-item core itself reads running with its own pid", async () => {
    process.env.AGETOR_LAUNCHED_BY = "login-item";
    seedFake({ registration: "enabled" });
    expect(await bg.getBackgroundStatus({ fresh: true })).toMatchObject({
      state: "running",
      corePid: process.pid,
    });
  });

  test("an info override flows through: a dev-channel fake is unavailable", async () => {
    seedFake({ registration: "enabled", info: { channel: "dev" } });
    const s = await bg.getBackgroundStatus({ fresh: true });
    expect(s).toMatchObject({ state: "unavailable", unavailableReason: "dev-build", registration: null });
  });

  test("a helper failure is unavailable/helper-failed with the message", async () => {
    seedFake({
      registration: "enabled",
      failNext: { command: "status", error: { domain: "d", code: 1, message: "helper imploded" } },
    });
    const s = await bg.getBackgroundStatus({ fresh: true });
    expect(s.unavailableReason).toBe("helper-failed");
    expect(s.detail).toContain("helper imploded");
  });

  test("results are cached for ~2 s; fresh:true bypasses the cache", async () => {
    seedFake({ registration: "notRegistered" });
    const before = callsOf("info");
    await bg.getBackgroundStatus({ fresh: true });
    expect(callsOf("info")).toBe(before + 1);

    // macOS changes behind our back (the user flips it in System Settings)...
    const f = readFake();
    writeFileSync(fakeFile(), JSON.stringify({ ...f, registration: "enabled" }));

    // ...a cached read doesn't see it and doesn't touch the helper...
    expect((await bg.getBackgroundStatus()).state).toBe("off");
    expect((await bg.getBackgroundStatus()).state).toBe("off");
    expect(callsOf("info")).toBe(before + 1);

    // ...a fresh one does.
    expect((await bg.getBackgroundStatus({ fresh: true })).state).toBe("stopped");
    expect(callsOf("info")).toBe(before + 2);
  });

  test("concurrent callers share one helper probe", async () => {
    seedFake({ registration: "enabled" });
    const before = callsOf("info");
    const [a, b] = await Promise.all([
      bg.getBackgroundStatus({ fresh: true }),
      bg.getBackgroundStatus({ fresh: true }),
    ]);
    expect(callsOf("info")).toBe(before + 1);
    expect(b).toBe(a);
    expect(a.state).toBe("stopped");
  });
});

describe("C3 reconcile: remote access can't outlive a running host", () => {
  for (const registration of ["notRegistered", "requiresApproval"] as const) {
    test(`remote on + registration ${registration} → remote off`, async () => {
      seedFake({ registration });
      db.preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const s = await bg.getBackgroundStatus({ fresh: true });
        expect(s.remoteAccess).toBe(false);
        expect(remotePref()).toBe("off");
        expect(bg.getRemoteAccess()).toEqual({ enabled: false, preview: true });
        expect(warn.mock.calls.some((c) => String(c[0]).includes("remote access turned off"))).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });
  }

  test("remote on + enabled but stopped → remote off", async () => {
    seedFake({ registration: "enabled" });
    db.preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s = await bg.getBackgroundStatus({ fresh: true });
      expect(s.state).toBe("stopped");
      expect(s.remoteAccess).toBe(false);
      expect(remotePref()).toBe("off");
    } finally {
      warn.mockRestore();
    }
  });

  test("remote on + unavailable → remote off", async () => {
    seedFake({ registration: "enabled", info: { signed: false } });
    db.preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s = await bg.getBackgroundStatus({ fresh: true });
      expect(s.state).toBe("unavailable");
      expect(s.remoteAccess).toBe(false);
      expect(remotePref()).toBe("off");
    } finally {
      warn.mockRestore();
    }
  });

  for (const sup of [
    { state: "running", corePid: process.pid },
    { state: "parked", corePid: null },
    { state: "waiting", corePid: null },
  ] as const) {
    test(`remote stays on while the host is ${sup.state}`, async () => {
      seedFake({ registration: "enabled" });
      seedSupervisor(sup);
      db.preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
      const s = await bg.getBackgroundStatus({ fresh: true });
      expect(s.remoteAccess).toBe(true);
      expect(remotePref()).toBe("on");
    });
  }

  test("the reconcile reaches listeners from the next tick, with remoteAccess false", async () => {
    seedFake({ registration: "notRegistered" });
    db.preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
    const seen: BackgroundStatus[] = [];
    const off = bg.subscribeBackgroundChanges((s) => seen.push(s));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await bg.getBackgroundStatus({ fresh: true });
      expect(seen).toHaveLength(0); // not from inside the probe itself
      await tick(30);
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen.at(-1)!.remoteAccess).toBe(false);
    } finally {
      off();
      warn.mockRestore();
    }
  });

  test("a status read with remote already off is silent", async () => {
    seedFake({ registration: "notRegistered" });
    const seen: BackgroundStatus[] = [];
    const off = bg.subscribeBackgroundChanges((s) => seen.push(s));
    try {
      await bg.getBackgroundStatus({ fresh: true });
      await tick(30);
      expect(seen).toHaveLength(0);
    } finally {
      off();
    }
  });
});

describe("turnOnBackground", () => {
  test("registers an unregistered item", async () => {
    seedFake({ registration: "notRegistered" });
    const s = await bg.turnOnBackground();
    expect(callsOf("register")).toBe(1);
    expect(s.registration).toBe("enabled");
    // Enabled, and launchd hasn't started the supervisor yet: starting, not stopped.
    expect(s.state).toBe("starting");
    expect(s.supervisorPid).toBeNull();
  });

  test("the starting grace ends when a supervisor reports, and lapses to stopped when none does", async () => {
    process.env.AGETOR_BACKGROUND_START_GRACE_MS = "120";
    seedFake({ registration: "notRegistered" });
    await bg.turnOnBackground();
    expect((await bg.getBackgroundStatus({ fresh: true })).state).toBe("starting");
    await tick(180);
    expect((await bg.getBackgroundStatus({ fresh: true })).state).toBe("stopped");

    // A reporting supervisor takes over the state and clears the grace for good.
    bg.__testing.resetStartGrace();
    seedFake({ registration: "notRegistered" });
    await bg.turnOnBackground();
    seedSupervisor({ state: "parked", corePid: null });
    expect((await bg.getBackgroundStatus({ fresh: true })).state).toBe("parked");
    rmSync(daemonFile(), { force: true });
    expect((await bg.getBackgroundStatus({ fresh: true })).state).toBe("stopped");
  });

  test("an already-enabled item isn't registered again", async () => {
    seedFake({ registration: "enabled" });
    await bg.turnOnBackground();
    expect(callsOf("register")).toBe(0);
  });

  test("macOS asking for approval is needs-approval with the System Settings pointer", async () => {
    seedFake({
      registration: "notRegistered",
      failNext: {
        command: "register",
        error: { domain: "SMAppServiceErrorDomain", code: 1, message: "Approve me in Settings" },
        registration: "requiresApproval",
      },
    });
    const s = await bg.turnOnBackground();
    expect(s.state).toBe("needs-approval");
    // The derived state's own pointer wins over the helper's error text.
    expect(s.detail).toContain("Login Items");
    expect(callsOf("register")).toBe(1);
  });

  test("a refused register (item stays off) shows the helper's error as detail", async () => {
    seedFake({
      registration: "notRegistered",
      failNext: {
        command: "register",
        error: { domain: "SMAppServiceErrorDomain", code: 1, message: "Operation not permitted" },
      },
    });
    const s = await bg.turnOnBackground();
    expect(s).toMatchObject({ state: "off", registration: "notRegistered", detail: "Operation not permitted" });
    // The next successful action clears it.
    const again = await bg.turnOnBackground();
    expect(again.registration).toBe("enabled");
    expect(again.detail).not.toBe("Operation not permitted");
  });

  test("an unavailable install is returned untouched and nothing is registered", async () => {
    seedFake({ registration: "notRegistered", info: { channel: "dev" } });
    const s = await bg.turnOnBackground();
    expect(s.state).toBe("unavailable");
    expect(callsOf("register")).toBe(0);
  });
});

describe("regression: remote access turned on right after the host is registered survives the supervisor's first-report lag", () => {
  test("register → remote on → status read before login-daemon.json exists: remote stays on", async () => {
    seedFake({ registration: "notRegistered" });
    const registered = await bg.turnOnBackground();
    expect(registered.state).toBe("starting");
    // This is what the native box does once the host is enabled.
    bg.setRemoteAccessOnFromNativeBox();
    await tick(40); // let the deferred change notification and any reconcile run
    const s = await bg.getBackgroundStatus({ fresh: true });
    expect(s.state).toBe("starting");
    expect(s.remoteAccess).toBe(true);
    expect(remotePref()).toBe("on");
  });

  test("if no supervisor ever reports, the grace lapses and the C3 reconcile turns remote off", async () => {
    process.env.AGETOR_BACKGROUND_START_GRACE_MS = "100";
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      seedFake({ registration: "notRegistered" });
      await bg.turnOnBackground();
      bg.setRemoteAccessOnFromNativeBox();
      await tick(160);
      const s = await bg.getBackgroundStatus({ fresh: true });
      expect(s.state).toBe("stopped");
      expect(s.remoteAccess).toBe(false);
      expect(remotePref()).toBe("off");
    } finally {
      warn.mockRestore();
    }
  });

  test("an enabled item that is genuinely stopped (no grace) still turns remote off", async () => {
    seedFake({ registration: "enabled" });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      bg.setRemoteAccessOnFromNativeBox();
      const s = await bg.getBackgroundStatus({ fresh: true });
      expect(s.state).toBe("stopped");
      expect(s.remoteAccess).toBe(false);
      expect(remotePref()).toBe("off");
    } finally {
      warn.mockRestore();
    }
  });

  test("startBackgroundNow on a stopped host also reads starting until the supervisor reports", async () => {
    seedFake({ registration: "enabled" });
    const s = await bg.startBackgroundNow();
    expect(callsOf("reregister")).toBe(1);
    expect(s.state).toBe("starting");
  });

  test("turning the background off clears the grace", async () => {
    seedFake({ registration: "notRegistered" });
    await bg.turnOnBackground();
    seedFake({ registration: "enabled" });
    await bg.turnOffBackground();
    seedFake({ registration: "enabled" }); // as if re-enabled elsewhere
    expect((await bg.getBackgroundStatus({ fresh: true })).state).toBe("stopped");
  });
});

describe("turnOffBackground", () => {
  test("turns remote access off and unregisters", async () => {
    seedFake({ registration: "enabled" });
    seedSupervisor();
    db.preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
    const s = await bg.turnOffBackground();
    expect(remotePref()).toBe("off");
    expect(callsOf("unregister")).toBe(1);
    expect(readFake().registration).toBe("notRegistered");
    expect(s).toMatchObject({ state: "off", registration: "notRegistered", remoteAccess: false });
  });

  test("C3 ordering: remote access is switched off BEFORE the helper unregisters", async () => {
    seedFake({ registration: "enabled" });
    seedSupervisor();
    db.preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
    // Observe the fake's call log at the instant the preference is written.
    const realSet = db.preferences.set;
    const callsAtPrefWrite: string[][] = [];
    db.preferences.set = (key: string, value: string) => {
      if (key === REMOTE_ACCESS_PREF_KEY && value === "off") callsAtPrefWrite.push(readFake().calls);
      realSet(key, value);
    };
    try {
      await bg.turnOffBackground();
    } finally {
      db.preferences.set = realSet;
    }
    expect(callsAtPrefWrite.length).toBeGreaterThanOrEqual(1);
    expect(callsAtPrefWrite[0]).not.toContain("unregister");
    expect(callsOf("unregister")).toBe(1);
  });

  test("a failed unregister is reported in detail and registration stays enabled", async () => {
    seedFake({
      registration: "enabled",
      failNext: { command: "unregister", error: { domain: "d", code: 5, message: "macOS refused" } },
    });
    seedSupervisor();
    db.preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s = await bg.turnOffBackground();
      expect(s.registration).toBe("enabled");
      expect(s.state).not.toBe("off");
      expect(remotePref()).toBe("off"); // still off first, regardless
    } finally {
      warn.mockRestore();
    }
  });

  test("an unavailable install: remote is still turned off, nothing unregistered", async () => {
    seedFake({ registration: "enabled", info: { signed: false } });
    db.preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
    const s = await bg.turnOffBackground();
    expect(s.state).toBe("unavailable");
    expect(remotePref()).toBe("off");
    expect(callsOf("unregister")).toBe(0);
  });

  test("inside the login-item core the unregister is deferred past the reply (C9)", async () => {
    process.env.AGETOR_LAUNCHED_BY = "login-item";
    seedFake({ registration: "enabled" });
    seedSupervisor();
    db.preferences.set(REMOTE_ACCESS_PREF_KEY, "on");

    const s = await bg.turnOffBackground();
    // The answer is the PREDICTED off status, and the helper hasn't been asked
    // yet (unregistering makes launchd kill this very process).
    expect(s).toMatchObject({
      state: "off",
      registration: "notRegistered",
      remoteAccess: false,
      supervisorPid: null,
      corePid: null,
    });
    expect(readFake().calls).not.toContain("unregister");
    expect(remotePref()).toBe("off");

    await tick(40);
    expect(callsOf("unregister")).toBe(1);
    expect(readFake().registration).toBe("notRegistered");
  });

  test("the predicted off status is what listeners and an immediate cached read see", async () => {
    process.env.AGETOR_LAUNCHED_BY = "login-item";
    seedFake({ registration: "enabled" });
    seedSupervisor();
    const seen: BackgroundStatus[] = [];
    const off = bg.subscribeBackgroundChanges((st) => seen.push(st));
    try {
      await bg.turnOffBackground();
      expect(seen[0]).toMatchObject({ state: "off", registration: "notRegistered" });
      expect((await bg.getBackgroundStatus()).state).toBe("off");
    } finally {
      off();
    }
  });
});

describe("startBackgroundNow (C17)", () => {
  test("unavailable install → BackgroundStartError(unavailable)", async () => {
    seedFake({ registration: "enabled", info: { channel: "dev" } });
    const err = await bg.startBackgroundNow().catch((e) => e);
    expect(err).toBeInstanceOf(bg.BackgroundStartError);
    expect(err.code).toBe("unavailable");
    expect(callsOf("reregister")).toBe(0);
  });

  test("not enabled → not-enabled", async () => {
    for (const registration of ["notRegistered", "requiresApproval"]) {
      seedFake({ registration });
      const err = await bg.startBackgroundNow().catch((e) => e);
      expect(err).toBeInstanceOf(bg.BackgroundStartError);
      expect(err.code).toBe("not-enabled");
      expect(callsOf("reregister")).toBe(0);
    }
  });

  test("any live host (running, parked, starting) → already-running", async () => {
    for (const sup of [
      { state: "running", corePid: process.pid },
      { state: "parked", corePid: null },
      { state: "waiting", corePid: null },
    ] as const) {
      seedFake({ registration: "enabled" });
      seedSupervisor(sup);
      const err = await bg.startBackgroundNow().catch((e) => e);
      expect(err).toBeInstanceOf(bg.BackgroundStartError);
      expect(err.code).toBe("already-running");
      expect(callsOf("reregister")).toBe(0);
    }
  });

  test("enabled but stopped → reregister, and the fresh status comes back", async () => {
    seedFake({ registration: "enabled" });
    const seen: BackgroundStatus[] = [];
    const off = bg.subscribeBackgroundChanges((s) => seen.push(s));
    try {
      const s = await bg.startBackgroundNow();
      expect(callsOf("reregister")).toBe(1);
      expect(s.registration).toBe("enabled");
      expect(seen.at(-1)).toEqual(s);
    } finally {
      off();
    }
  });

  test("a failed reregister still answers, with the failure as detail", async () => {
    seedFake({
      registration: "enabled",
      failNext: { command: "reregister", error: { domain: "d", code: 2, message: "launchd said no" } },
    });
    const s = await bg.startBackgroundNow();
    expect(s.detail).toBe("launchd said no");
  });

  test("BackgroundStartError carries its code and name", () => {
    const e = new bg.BackgroundStartError("not-enabled", "msg");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BackgroundStartError");
    expect(e.code).toBe("not-enabled");
    expect(e.message).toBe("msg");
  });
});

describe("openLoginItems", () => {
  test("asks the helper to open System Settings", async () => {
    await bg.openLoginItems();
    expect(callsOf("openSettings")).toBe(1);
  });

  test("a helper failure propagates", async () => {
    seedFake({
      failNext: { command: "openSettings", error: { domain: "d", code: 1, message: "cannot open" } },
    });
    await expect(bg.openLoginItems()).rejects.toThrow("cannot open");
  });
});

describe("change listeners", () => {
  test("fire with a fresh status after each action, and unsubscribe stops them", async () => {
    seedFake({ registration: "notRegistered" });
    const seen: BackgroundStatus[] = [];
    const off = bg.subscribeBackgroundChanges((s) => seen.push(s));
    await bg.turnOnBackground();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.registration).toBe("enabled");

    off();
    await bg.turnOffBackground();
    expect(seen).toHaveLength(1);
  });

  test("a throwing listener is isolated: others still run and the action succeeds", async () => {
    seedFake({ registration: "notRegistered" });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const seen: BackgroundStatus[] = [];
    const offBad = bg.subscribeBackgroundChanges(() => {
      throw new Error("listener bug");
    });
    const offGood = bg.subscribeBackgroundChanges((s) => seen.push(s));
    try {
      const s = await bg.turnOnBackground();
      expect(s.registration).toBe("enabled");
      expect(seen).toHaveLength(1);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("listener threw"))).toBe(true);
    } finally {
      offBad();
      offGood();
      warn.mockRestore();
    }
  });

  test("setRemoteAccessOff notifies only when it actually changed something", async () => {
    seedFake({ registration: "enabled" });
    seedSupervisor();
    const seen: BackgroundStatus[] = [];
    const off = bg.subscribeBackgroundChanges((s) => seen.push(s));
    try {
      bg.setRemoteAccessOff(); // already off → silent
      await tick(30);
      expect(seen).toHaveLength(0);

      db.preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
      bg.setRemoteAccessOff();
      expect(remotePref()).toBe("off");
      await tick(30);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.remoteAccess).toBe(false);
    } finally {
      off();
    }
  });
});

describe("remote access preference", () => {
  test("defaults to off and reports preview", () => {
    expect(bg.getRemoteAccess()).toEqual({ enabled: false, preview: true });
  });

  test("setRemoteAccessOnFromNativeBox turns it on and tells listeners", async () => {
    seedFake({ registration: "enabled" });
    seedSupervisor(); // a running host, so the C3 reconcile leaves it on
    const seen: BackgroundStatus[] = [];
    const off = bg.subscribeBackgroundChanges((s) => seen.push(s));
    try {
      bg.setRemoteAccessOnFromNativeBox();
      expect(remotePref()).toBe("on");
      expect(bg.getRemoteAccess().enabled).toBe(true);
      await tick(30);
      expect(seen.at(-1)).toMatchObject({ remoteAccess: true, state: "running" });
    } finally {
      off();
    }
  });

  test("setRemoteAccessOff then switches it off again", async () => {
    seedFake({ registration: "enabled" });
    seedSupervisor();
    bg.setRemoteAccessOnFromNativeBox();
    bg.setRemoteAccessOff();
    expect(bg.getRemoteAccess().enabled).toBe(false);
    expect(remotePref()).toBe("off");
  });
});

describe("AGETOR_FAKE_REMOTE_ACCESS=on seed", () => {
  // `fakeRemoteSeeded` is a once-per-process module flag, and the module cache
  // is shared by every file `bun test` runs, so this is exercised in a fresh
  // process with its own data dir rather than in-process.
  async function run(env: Record<string, string>, script: string): Promise<string> {
    const childDir = mkdtempSync(path.join(tmp, "seed-"));
    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        ...(process.env as Record<string, string>),
        AGETOR_DATA_DIR: childDir,
        NODE_ENV: "test",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [out, err] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
      ]);
      await proc.exited;
      if (proc.exitCode !== 0) throw new Error(`child failed (${proc.exitCode}): ${err}`);
      // db.ts logs its applied migrations to stdout; the answer is the last line.
      return out.trim().split("\n").at(-1)!;
    } finally {
      proc.kill();
    }
  }
  const script = `
    const bg = await import(${JSON.stringify(path.resolve(import.meta.dir, "background.ts"))});
    const first = bg.getRemoteAccess().enabled;
    // An explicit "off" is not re-seeded by a later read.
    bg.setRemoteAccessOff();
    console.log(JSON.stringify({ first, afterOff: bg.getRemoteAccess().enabled }));
    process.exit(0);
  `;

  test("seeds the preference on at the first read, once", async () => {
    const out = await run({ AGETOR_FAKE_LOGIN_ITEM: "1", AGETOR_FAKE_REMOTE_ACCESS: "on" }, script);
    expect(JSON.parse(out)).toEqual({ first: true, afterOff: false });
  });

  test("is ignored without AGETOR_FAKE_LOGIN_ITEM=1", async () => {
    const out = await run({ AGETOR_FAKE_LOGIN_ITEM: "0", AGETOR_FAKE_REMOTE_ACCESS: "on" }, script);
    expect(JSON.parse(out)).toEqual({ first: false, afterOff: false });
  });

  test("is ignored for any value but 'on'", async () => {
    const out = await run({ AGETOR_FAKE_LOGIN_ITEM: "1", AGETOR_FAKE_REMOTE_ACCESS: "yes" }, script);
    expect(JSON.parse(out)).toEqual({ first: false, afterOff: false });
  });
});
