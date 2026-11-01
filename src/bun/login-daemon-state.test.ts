import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SUPERVISOR_STALE_MS,
  SUPERVISOR_STOP_MAX_AGE_MS,
  liveSupervisor,
  readLoginDaemonState,
  requestSupervisorStop,
  takeHandbackMarker,
  takeSupervisorStop,
  writeHandbackMarker,
  writeLoginDaemonState,
  type LoginDaemonState,
} from "./login-daemon-state.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

const root = mkdtempSync(path.join(tmpdir(), "agetor-login-state-"));
let n = 0;
/** A fresh data dir per test so files never leak between cases. */
function freshDir(): string {
  const d = path.join(root, `d${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
}

afterAll(() => {
  rmTestDataDir(root);
});

const mode = (f: string) => statSync(f).mode & 0o777;

function sample(over: Partial<LoginDaemonState> = {}): LoginDaemonState {
  return {
    pid: process.pid,
    state: "running",
    corePid: 4242,
    bundlePath: "/Applications/Agetor.app",
    version: "1.2.3",
    label: "sh.alamops.agetor.daemon",
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    ...over,
  };
}

/** A pid that is certain to be dead: a child that already exited. */
let deadPid = 0;
beforeAll(() => {
  const r = Bun.spawnSync(["/usr/bin/true"]);
  deadPid = r.pid;
});

describe("state file", () => {
  test("round-trips, with and without lastExit", () => {
    const dir = freshDir();
    const a = sample({ lastExit: "bundle-changed" });
    writeLoginDaemonState(a, dir);
    expect(readLoginDaemonState(dir)).toEqual(a);

    const b = sample({ state: "parked", corePid: null });
    writeLoginDaemonState(b, dir);
    const back = readLoginDaemonState(dir);
    expect(back).toEqual(b);
    expect(back && "lastExit" in back).toBe(false);
  });

  test("accepts every state and lastExit value", () => {
    const dir = freshDir();
    for (const state of ["parked", "waiting", "running", "stopped"] as const) {
      for (const lastExit of ["stop", "sigterm", "bundle-changed", "crash"] as const) {
        writeLoginDaemonState(sample({ state, lastExit }), dir);
        expect(readLoginDaemonState(dir)?.state).toBe(state);
        expect(readLoginDaemonState(dir)?.lastExit).toBe(lastExit);
      }
    }
  });

  test("is written at mode 0600, even over an existing looser file", () => {
    const dir = freshDir();
    const file = path.join(dir, "login-daemon.json");
    writeLoginDaemonState(sample(), dir);
    expect(mode(file)).toBe(0o600);
    chmodSync(file, 0o644);
    writeLoginDaemonState(sample({ updatedAt: 1_700_000_002_000 }), dir);
    expect(mode(file)).toBe(0o600);
  });

  test("is atomic: no tmp sibling is left behind after writes", () => {
    const dir = freshDir();
    for (let i = 0; i < 5; i++) writeLoginDaemonState(sample({ updatedAt: i + 1 }), dir);
    requestSupervisorStop(dir);
    writeHandbackMarker("update", dir);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual([
      "login-daemon-control.json",
      "login-daemon-handback.json",
      "login-daemon.json",
    ]);
  });

  test("a failed write cleans up its tmp file and leaves the old file untouched", () => {
    const dir = freshDir();
    // Make the target a directory so the final rename fails.
    mkdirSync(path.join(dir, "login-daemon.json"));
    expect(() => writeLoginDaemonState(sample(), dir)).toThrow();
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  test("creates a missing data dir", () => {
    const dir = path.join(freshDir(), "nested", "deeper");
    writeLoginDaemonState(sample(), dir);
    expect(readLoginDaemonState(dir)?.pid).toBe(process.pid);
  });

  test("a missing file reads as null", () => {
    expect(readLoginDaemonState(freshDir())).toBeNull();
  });

  test("corrupt and mis-shaped files read as null, never throw", () => {
    const dir = freshDir();
    const file = path.join(dir, "login-daemon.json");
    const bad: unknown[] = [
      "not json {",
      "",
      "null",
      "[]",
      "42",
      { ...sample(), pid: "12" },
      { ...sample(), pid: 0 },
      { ...sample(), pid: 1.5 },
      { ...sample(), state: "exploded" },
      { ...sample(), corePid: 0 },
      { ...sample(), corePid: "7" },
      { ...sample(), bundlePath: 5 },
      { ...sample(), version: null },
      { ...sample(), label: undefined },
      { ...sample(), startedAt: "now" },
      { ...sample(), updatedAt: NaN },
      { ...sample(), lastExit: "vanished" },
      { ...sample(), lastExit: 3 },
    ];
    for (const v of bad) {
      writeFileSync(file, typeof v === "string" ? v : JSON.stringify(v));
      expect(readLoginDaemonState(dir)).toBeNull();
    }
  });

  test("defaults to AGETOR_DATA_DIR at call time", () => {
    const dir = freshDir();
    const prev = process.env.AGETOR_DATA_DIR;
    try {
      process.env.AGETOR_DATA_DIR = dir;
      writeLoginDaemonState(sample({ version: "9.9.9" }));
      expect(readLoginDaemonState()?.version).toBe("9.9.9");
      expect(readLoginDaemonState(dir)?.version).toBe("9.9.9");
    } finally {
      if (prev === undefined) delete process.env.AGETOR_DATA_DIR;
      else process.env.AGETOR_DATA_DIR = prev;
    }
  });
});

describe("liveSupervisor", () => {
  test("a record whose pid is alive is the live supervisor", () => {
    const dir = freshDir();
    const s = sample({ state: "parked", corePid: null });
    writeLoginDaemonState(s, dir);
    expect(liveSupervisor(dir)).toEqual(s);
  });

  test("a stale pid (process gone) reads as null", () => {
    const dir = freshDir();
    writeLoginDaemonState(sample({ pid: deadPid }), dir);
    expect(readLoginDaemonState(dir)?.pid).toBe(deadPid); // the record itself is still readable
    expect(liveSupervisor(dir)).toBeNull();
  });

  test("a recorded clean stop reads as null even with a live pid", () => {
    const dir = freshDir();
    writeLoginDaemonState(sample({ state: "stopped", corePid: null, lastExit: "stop" }), dir);
    expect(liveSupervisor(dir)).toBeNull();
  });

  test("missing or corrupt file reads as null", () => {
    const dir = freshDir();
    expect(liveSupervisor(dir)).toBeNull();
    writeFileSync(path.join(dir, "login-daemon.json"), "garbage");
    expect(liveSupervisor(dir)).toBeNull();
  });
});

describe("stop request (control file)", () => {
  test("is written 0600, consumed once, and the file is removed", () => {
    const dir = freshDir();
    const file = path.join(dir, "login-daemon-control.json");
    requestSupervisorStop(dir);
    expect(mode(file)).toBe(0o600);
    expect(takeSupervisorStop(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    expect(takeSupervisorStop(dir)).toBe(false);
  });

  test("a request is stamped with requestedAt", () => {
    const dir = freshDir();
    requestSupervisorStop(dir, 1234);
    const raw = JSON.parse(readFileSync(path.join(dir, "login-daemon-control.json"), "utf8"));
    expect(raw).toEqual({ action: "stop", requestedAt: 1234 });
  });

  test("a stale request (no supervisor was running to read it) is ignored and removed", () => {
    const dir = freshDir();
    const now = 10_000_000;
    requestSupervisorStop(dir, now - SUPERVISOR_STOP_MAX_AGE_MS - 1);
    expect(takeSupervisorStop(dir, { now })).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    // Exactly at the limit is still honoured.
    requestSupervisorStop(dir, now - SUPERVISOR_STOP_MAX_AGE_MS);
    expect(takeSupervisorStop(dir, { now })).toBe(true);
  });

  test("a request written before the supervisor started cannot stop it", () => {
    const dir = freshDir();
    const now = 10_000_000;
    requestSupervisorStop(dir, now - 5_000);
    expect(takeSupervisorStop(dir, { now, supervisorStartedAt: now - 1_000 })).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    // Written while the supervisor was already running: honoured.
    requestSupervisorStop(dir, now - 500);
    expect(takeSupervisorStop(dir, { now, supervisorStartedAt: now - 1_000 })).toBe(true);
  });

  test("a legacy request without requestedAt is stale and removed", () => {
    const dir = freshDir();
    const file = path.join(dir, "login-daemon-control.json");
    writeFileSync(file, JSON.stringify({ action: "stop", at: Date.now() }));
    expect(takeSupervisorStop(dir)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    writeFileSync(file, JSON.stringify({ action: "stop", requestedAt: "now" }));
    expect(takeSupervisorStop(dir)).toBe(false);
  });

  test("no request reads false", () => {
    expect(takeSupervisorStop(freshDir())).toBe(false);
  });

  test("a malformed or foreign request is not a stop, but is still removed", () => {
    const dir = freshDir();
    const file = path.join(dir, "login-daemon-control.json");
    for (const body of ["not json", "null", JSON.stringify({ action: "start" }), JSON.stringify({}), "[]", "\"stop\""]) {
      writeFileSync(file, body);
      expect(takeSupervisorStop(dir)).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    }
  });
});

describe("handback marker", () => {
  test("round-trips, 0600, consumed on read", () => {
    const dir = freshDir();
    const file = path.join(dir, "login-daemon-handback.json");
    const before = Date.now();
    writeHandbackMarker("update", dir);
    expect(mode(file)).toBe(0o600);
    const m = takeHandbackMarker(120_000, dir);
    expect(m?.reason).toBe("update");
    expect(m!.at).toBeGreaterThanOrEqual(before);
    expect(m!.at).toBeLessThanOrEqual(Date.now());
    expect(readdirSync(dir)).toEqual([]);
    expect(takeHandbackMarker(120_000, dir)).toBeNull();
  });

  test("a marker older than the age limit is ignored, and still removed", () => {
    const dir = freshDir();
    const file = path.join(dir, "login-daemon-handback.json");
    writeFileSync(file, JSON.stringify({ reason: "update", at: Date.now() - 200_000 }));
    expect(takeHandbackMarker(120_000, dir)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);

    // The same marker is honoured under a longer limit.
    writeFileSync(file, JSON.stringify({ reason: "update", at: Date.now() - 200_000 }));
    expect(takeHandbackMarker(300_000, dir)?.reason).toBe("update");
  });

  test("malformed markers read null and are removed", () => {
    const dir = freshDir();
    const file = path.join(dir, "login-daemon-handback.json");
    for (const body of [
      "not json",
      "null",
      JSON.stringify({ reason: "crash", at: Date.now() }),
      JSON.stringify({ reason: "update" }),
      JSON.stringify({ reason: "update", at: "now" }),
    ]) {
      writeFileSync(file, body);
      expect(takeHandbackMarker(120_000, dir)).toBeNull();
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  test("missing marker reads null", () => {
    expect(takeHandbackMarker(120_000, freshDir())).toBeNull();
  });
});

describe("liveSupervisor pid-reuse guard", () => {
  test("a fresh heartbeat on a live pid is a live supervisor", () => {
    const dir = freshDir();
    const now = 5_000_000;
    writeLoginDaemonState(sample({ pid: process.pid, heartbeatAt: now - 1_000 }), dir);
    expect(liveSupervisor(dir, now)?.pid).toBe(process.pid);
  });

  test("a live pid whose heartbeat went stale is a recycled pid, not the supervisor", () => {
    const dir = freshDir();
    const now = 5_000_000;
    writeLoginDaemonState(sample({ pid: process.pid, heartbeatAt: now - SUPERVISOR_STALE_MS - 1 }), dir);
    expect(liveSupervisor(dir, now)).toBeNull();
  });

  test("a state file without a heartbeat is trusted on pid liveness alone", () => {
    const dir = freshDir();
    writeLoginDaemonState(sample({ pid: process.pid, updatedAt: 2 }), dir);
    expect(liveSupervisor(dir)?.pid).toBe(process.pid);
  });

  test("heartbeatAt round-trips and a non-numeric one reads as a corrupt file", () => {
    const dir = freshDir();
    writeLoginDaemonState(sample({ heartbeatAt: 99 }), dir);
    expect(readLoginDaemonState(dir)?.heartbeatAt).toBe(99);
    writeFileSync(path.join(dir, "login-daemon.json"), JSON.stringify({ ...sample(), heartbeatAt: "x" }));
    expect(readLoginDaemonState(dir)).toBeNull();
  });
});
