import { afterAll, expect, test } from "bun:test";
import { createLiveCoreCheck, createSupervisor, type CoreChild } from "./login-daemon.ts";
import { DEFAULT_CONFIG } from "./login-daemon-machine.ts";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  coreCredsPath,
  isPidAlive,
  readCoreCreds,
  removeCoreCreds,
  writeCoreCreds,
  type CoreCreds,
} from "./core-creds.ts";
import { readLoginDaemonState, requestSupervisorStop } from "./login-daemon-state.ts";
import { rmTestDataDir } from "./test-data-dir.ts";

/**
 * Subprocess integration test of the login-item supervisor
 * (docs/plans/always-on-host.md §5, row I2): it runs the REAL
 * `src/bun/login-daemon.ts` as launchd would, with the headless core as its
 * child, and drives every row of the §3.2 table that is observable from
 * outside — boot, handoff to an app and the handback, core stop, the stop
 * control file, SIGTERM and a replaced `Info.plist`.
 *
 * Seams (all documented in login-daemon.ts): `AGETOR_LOGIN_DAEMON_CORE` points
 * the supervisor at `src/bun/headless.ts` instead of a bundled `headless.js`;
 * `AGETOR_LOGIN_ITEM_BUNDLE` at a fake bundle holding only `Info.plist`; tick
 * and handoff grace are shortened. The machine is under heavy load when these
 * run, so every wait polls against a generous deadline rather than sleeping a
 * fixed time. Ports 4475–4478 are this file's alone (one per scenario).
 *
 * Every process started here is killed in `finally` AND `afterAll`; the core is
 * a grandchild of this test (supervisor → core), so its pid is taken from the
 * state / creds files, not from a handle.
 */

const REPO = process.cwd();
const CORE_ENTRY = path.join(REPO, "src/bun/headless.ts");
const SUPERVISOR_ENTRY = path.join(REPO, "src/bun/login-daemon.ts");

/** Generous: boot of the headless core alone can take 15+ s on this machine. */
const BOOT_MS = 90_000;
const TEST_MS = 150_000;

type Proc = ReturnType<typeof Bun.spawn>;

/** Every pid this file might leave behind, killed in afterAll as a backstop. */
const stray = new Set<number>();
const strayProcs = new Set<Proc>();
const dirs: string[] = [];

afterAll(() => {
  for (const pid of stray) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  for (const p of strayProcs) p.kill("SIGKILL");
  for (const d of dirs) {
    try {
      rmTestDataDir(d);
    } catch {
      /* best-effort */
    }
  }
});

async function until<T>(
  label: string,
  fn: () => T | Promise<T>,
  timeoutMs: number = BOOT_MS,
  intervalMs = 50,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${label}`);
    await Bun.sleep(intervalMs);
  }
}

async function healthy(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    return ((await r.json().catch(() => null)) as { app?: string } | null)?.app === "agetor";
  } catch {
    return false;
  }
}

function newDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-login-daemon-"));
  dirs.push(dir);
  return dir;
}

/** A fake app bundle: the supervisor only ever stats `Contents/Info.plist`. */
function makeBundle(dir: string): string {
  const bundle = path.join(dir, "Fake.app");
  mkdirSync(path.join(bundle, "Contents"), { recursive: true });
  writeFileSync(path.join(bundle, "Contents", "Info.plist"), "<plist>v1</plist>");
  return bundle;
}

function env(dir: string, port: number, bundle: string, handoffGraceMs = 8000): Record<string, string> {
  const e: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "test",
    AGETOR_DATA_DIR: dir,
    AGETOR_API_PORT: String(port),
    AGETOR_LOGIN_DAEMON_CORE: CORE_ENTRY,
    AGETOR_LOGIN_ITEM_BUNDLE: bundle,
    AGETOR_LOGIN_ITEM_LABEL: "test.agetor.daemon",
    AGETOR_LOGIN_DAEMON_TICK_MS: "200",
    AGETOR_LOGIN_DAEMON_HANDOFF_GRACE_MS: String(handoffGraceMs),
    // Keep the core off the real machine: no tmux, no CLIs, no notifications.
    AGETOR_TMUX_BIN: "/bin/echo",
    AGETOR_CLAUDE_DRIVER: "fake",
    AGETOR_CODEX_DRIVER: "fake",
    AGETOR_CODEX_BIN: "/bin/echo",
    AGETOR_HEADLESS_NOTIFICATIONS: "0",
    AGETOR_HARNESS_AUTO_ENABLE: "0",
  };
  // The login-item defaults (idle off, launchedBy) must come from the
  // supervisor alone, not from this test runner's environment.
  delete e.AGETOR_DAEMON_IDLE_MS;
  delete e.AGETOR_LAUNCHED_BY;
  delete e.AGETOR_API_TOKEN;
  return e as Record<string, string>;
}

function startSupervisor(dir: string, port: number, bundle: string, handoffGraceMs?: number): Proc {
  const proc = Bun.spawn(["bun", SUPERVISOR_ENTRY], {
    cwd: REPO,
    env: env(dir, port, bundle, handoffGraceMs),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  strayProcs.add(proc);
  stray.add(proc.pid);
  return proc;
}

/** Kill the core(s) first (the supervisor's death would orphan them), then it. */
function cleanup(dir: string, sup: Proc): void {
  const pids = new Set<number>();
  const st = readLoginDaemonState(dir);
  if (st?.corePid) pids.add(st.corePid);
  const creds = readCoreCreds(dir);
  if (creds && creds.pid !== process.pid) pids.add(creds.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  sup.kill("SIGKILL");
}

async function exitedWithin(proc: Proc, ms: number, label: string): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for: ${label}`)), ms);
  });
  try {
    return await Promise.race([proc.exited, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Wait until the supervisor runs a healthy login-item core; returns its creds. */
async function untilCoreUp(dir: string, port: number, notPid?: number): Promise<CoreCreds> {
  const creds = await until("login-item core creds + /health", async () => {
    const c = readCoreCreds(dir);
    if (!c || c.launchedBy !== "login-item" || c.port !== port) return null;
    if (notPid !== undefined && c.pid === notPid) return null;
    return (await healthy(port)) ? c : null;
  });
  // The state file is written at boot, before the creds exist.
  await until("state file says running with the core pid", () => {
    const s = readLoginDaemonState(dir);
    return s?.state === "running" && s.corePid === creds.pid;
  });
  return creds;
}

function standInApp(dir: string, port: number): { stop(): void } {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ app: "agetor" });
      return new Response("ok");
    },
  });
  writeCoreCreds(
    {
      port,
      token: "s".repeat(64),
      pid: process.pid,
      kind: "app",
      version: "test",
      startedAt: Date.now(),
    },
    dir,
  );
  return {
    stop() {
      server.stop(true);
    },
  };
}

// Rows 1–3 of the §3.2 table in one flow: boot the core; hand the port to an
// app (core exits 76 → waiting → parked behind it); the app goes away and the
// supervisor takes the port back; then a plain shutdown ends the supervisor.
test(
  "supervisor boots the core, parks behind the app on handoff, takes the port back, and stops on a plain shutdown",
  async () => {
    const dir = newDir();
    const port = 4475;
    const bundle = makeBundle(dir);
    const sup = startSupervisor(dir, port, bundle);
    let standIn: { stop(): void } | null = null;
    try {
      // 1. Boot: the core carries the login-item identity and never idles out.
      const first = await untilCoreUp(dir, port);
      expect(first.kind).toBe("cli-daemon"); // C15: kind stays, launchedBy is additive
      expect(first.launchedBy).toBe("login-item");
      expect(first.pid).not.toBe(sup.pid);
      const state = readLoginDaemonState(dir);
      expect(state?.pid).toBe(sup.pid);
      expect(state?.bundlePath).toBe(bundle);
      expect(state?.label).toBe("test.agetor.daemon");
      const log = readFileSync(path.join(dir, "daemon.log"), "utf8");
      expect(log).toContain("launchedBy=login-item");
      expect(log).toContain("idle=off");

      // 2. Handoff: the app asks the core to give the port up.
      const res = await fetch(`http://127.0.0.1:${port}/daemon/shutdown`, {
        method: "POST",
        headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" },
        body: JSON.stringify({ mode: "handoff" }),
      });
      expect(res.status).toBe(200);
      // The core is a grandchild: poll its pid. The instant it is gone the
      // port is free, so the "app" binds it right away (inside the grace).
      await until("handed-off core exits", () => !isPidAlive(first.pid), BOOT_MS, 25);
      standIn = standInApp(dir, port);
      // 76 means "park, don't stop": the supervisor is still alive, did not
      // read the exit as a stop, and now sits behind the live "app".
      await until("state parked behind the app", () => readLoginDaemonState(dir)?.state === "parked");
      expect(readLoginDaemonState(dir)?.corePid).toBeNull();
      expect(isPidAlive(sup.pid)).toBe(true);
      expect(readCoreCreds(dir)?.kind).toBe("app");

      // Handback: the app leaves; the supervisor boots the core again.
      standIn.stop();
      standIn = null;
      removeCoreCreds(dir);
      const left = Date.now();
      const second = await untilCoreUp(dir, port, first.pid);
      const tookMs = Date.now() - left;
      expect(second.pid).not.toBe(first.pid);
      // One 200 ms tick notices the app is gone; the rest is the core's boot,
      // which is slow on a loaded machine — only assert it is bounded.
      expect(tookMs).toBeLessThan(60_000);

      // 3. A plain shutdown (no body = "stop") exits the core 0, so the
      // supervisor exits 0 — launchd then keeps the job down until next login.
      const stop = await fetch(`http://127.0.0.1:${port}/daemon/shutdown`, {
        method: "POST",
        headers: { authorization: `Bearer ${second.token}` },
      });
      expect(stop.status).toBe(200);
      expect(await exitedWithin(sup, BOOT_MS, "supervisor exit after a plain shutdown")).toBe(0);
      const done = readLoginDaemonState(dir);
      expect(done?.state).toBe("stopped");
      expect(done?.lastExit).toBe("stop");
      expect(done?.corePid).toBeNull();
      expect(existsSync(coreCredsPath(dir))).toBe(false);
    } finally {
      standIn?.stop();
      cleanup(dir, sup);
    }
  },
  TEST_MS,
);

// Row 4, plus the isolation rule: parked behind an app from the very start, the
// supervisor must never open a database (login-daemon.ts must not reach db.ts).
test(
  "a supervisor parked behind a live app opens no database and exits 0 on the stop control file",
  async () => {
    const dir = newDir();
    const port = 4476;
    const bundle = makeBundle(dir);
    const standIn = standInApp(dir, port);
    const sup = startSupervisor(dir, port, bundle);
    try {
      await until("state parked", () => readLoginDaemonState(dir)?.state === "parked");
      expect(readLoginDaemonState(dir)?.corePid).toBeNull();
      // Let several ticks pass while parked, then look for any database file.
      await Bun.sleep(1500);
      expect(readLoginDaemonState(dir)?.state).toBe("parked");
      expect(existsSync(path.join(dir, "agetor.sqlite"))).toBe(false);
      expect(existsSync(path.join(dir, "agetor.sqlite-wal"))).toBe(false);

      requestSupervisorStop(dir);
      expect(await exitedWithin(sup, BOOT_MS, "supervisor exit after the stop file")).toBe(0);
      const done = readLoginDaemonState(dir);
      expect(done?.state).toBe("stopped");
      expect(done?.lastExit).toBe("stop");
      // The control file was consumed, and no core was ever started.
      expect(existsSync(path.join(dir, "login-daemon-control.json"))).toBe(false);
      expect(readCoreCreds(dir)?.kind).toBe("app"); // the app's creds are untouched
      expect(existsSync(path.join(dir, "agetor.sqlite"))).toBe(false);
    } finally {
      standIn.stop();
      cleanup(dir, sup);
    }
  },
  TEST_MS,
);

// Row 5: launchd stopping the job delivers SIGTERM to the supervisor; the core
// is terminated through the supervisor and the creds go with it.
test(
  "SIGTERM stops the core and the supervisor with exit 0 and removes the creds",
  async () => {
    const dir = newDir();
    const port = 4477;
    const bundle = makeBundle(dir);
    const sup = startSupervisor(dir, port, bundle);
    try {
      const core = await untilCoreUp(dir, port);
      sup.kill("SIGTERM");
      expect(await exitedWithin(sup, BOOT_MS, "supervisor exit after SIGTERM")).toBe(0);
      expect(isPidAlive(core.pid)).toBe(false);
      expect(existsSync(coreCredsPath(dir))).toBe(false);
      const done = readLoginDaemonState(dir);
      expect(done?.state).toBe("stopped");
      expect(done?.lastExit).toBe("sigterm");
    } finally {
      cleanup(dir, sup);
    }
  },
  TEST_MS,
);

// Row 6: an update replaces the bundle's Info.plist (new inode). Once the new
// file has been stable for a moment the supervisor stops its core and exits 75
// so launchd relaunches it from the new bundle.
test(
  "a replaced Info.plist makes the supervisor stop its core and exit 75",
  async () => {
    const dir = newDir();
    const port = 4478;
    const bundle = makeBundle(dir);
    const sup = startSupervisor(dir, port, bundle);
    try {
      const core = await untilCoreUp(dir, port);
      const plist = path.join(bundle, "Contents", "Info.plist");
      const next = `${plist}.new`;
      writeFileSync(next, "<plist>v2</plist>");
      renameSync(next, plist); // a new inode, as an app update would leave
      expect(await exitedWithin(sup, BOOT_MS, "supervisor exit after Info.plist changed")).toBe(75);
      expect(isPidAlive(core.pid)).toBe(false);
      const done = readLoginDaemonState(dir);
      expect(done?.state).toBe("stopped");
      expect(done?.lastExit).toBe("bundle-changed");
    } finally {
      cleanup(dir, sup);
    }
  },
  TEST_MS,
);

// ---------------------------------------------------------------------------
// Unit tests (no subprocess): the pid-reuse guard and the idle heartbeat.

const credsOf = (over: Partial<CoreCreds> = {}): CoreCreds => ({
  port: 4999,
  token: "t".repeat(64),
  pid: 424242,
  kind: "app",
  version: "test",
  startedAt: 1,
  ...over,
});

test("liveCore: a creds pid recycled by an unrelated process (probe fails) is not a live core", async () => {
  let probes = 0;
  const check = createLiveCoreCheck({
    readCreds: () => credsOf(),
    selfPid: 1,
    isPidAlive: () => true, // the recycled pid is alive...
    probe: async () => {
      probes++;
      return false; // ...but nothing agetor answers on the port
    },
  });
  expect(await check(null)).toBe(false);
  expect(probes).toBe(1);
});

test("liveCore: a confirmed core is probed once per TTL, not every tick", async () => {
  let t = 0;
  let probes = 0;
  const check = createLiveCoreCheck({
    readCreds: () => credsOf(),
    selfPid: 1,
    now: () => t,
    ttlMs: 5000,
    isPidAlive: () => true,
    probe: async () => {
      probes++;
      return true;
    },
  });
  for (t = 0; t < 4000; t += 1000) expect(await check(null)).toBe(true);
  expect(probes).toBe(1);
  t = 5000;
  expect(await check(null)).toBe(true);
  expect(probes).toBe(2);
});

test("liveCore: a dead pid, our own pid, our own child and a missing file never probe", async () => {
  let probes = 0;
  const probe = async () => {
    probes++;
    return true;
  };
  const mk = (creds: CoreCreds | null, alive: boolean) =>
    createLiveCoreCheck({ readCreds: () => creds, selfPid: 7, isPidAlive: () => alive, probe });
  expect(await mk(null, true)(null)).toBe(false);
  expect(await mk(credsOf({ pid: 7 }), true)(null)).toBe(false);
  expect(await mk(credsOf({ pid: 9 }), true)(9)).toBe(false);
  expect(await mk(credsOf(), false)(null)).toBe(false);
  expect(probes).toBe(0);
});

test("liveCore: one failed probe of a core seen live is tolerated, the second drops it", async () => {
  let t = 0;
  let answer = true;
  const check = createLiveCoreCheck({
    readCreds: () => credsOf(),
    selfPid: 1,
    now: () => t,
    ttlMs: 1000,
    isPidAlive: () => true,
    probe: async () => answer,
  });
  expect(await check(null)).toBe(true);
  answer = false;
  t = 2000;
  expect(await check(null)).toBe(true); // a slow answer on a loaded machine
  t = 4000;
  expect(await check(null)).toBe(false); // still failing: gone
  answer = true;
  t = 6000;
  expect(await check(null)).toBe(true); // recovers
});

test("supervisor: an idle parked supervisor refreshes its state heartbeat and awaits an async liveCore", async () => {
  let t = 1_000_000;
  const writes: { state: string; at: number }[] = [];
  let ticks = 0;
  const sup = createSupervisor({
    now: () => t,
    tickMs: 1,
    config: DEFAULT_CONFIG,
    startup: { lastExit: undefined, handbackMarker: false },
    liveCore: async () => true,
    takeStop: () => {
      ticks++;
      t += 10_000; // each tick, ten seconds pass
      return ticks >= 8;
    },
    bundleSig: () => undefined,
    spawnCore: () => {
      throw new Error("must not spawn while parked");
    },
    writeState: (f) => writes.push({ state: f.state, at: t }),
    log: () => {},
    heartbeatMs: 25_000,
  });
  expect(await sup.run()).toBe(0);
  const parked = writes.filter((w) => w.state === "parked");
  // Start write + at least two heartbeats while idle (8 ticks x 10 s, 25 s apart).
  expect(parked.length).toBeGreaterThanOrEqual(3);
});

test("supervisor: a core that crashes is retried after a backoff, not by exiting", async () => {
  let t = 0;
  let spawns = 0;
  let stop = false;
  const sup = createSupervisor({
    now: () => t,
    tickMs: 1,
    config: DEFAULT_CONFIG,
    startup: { lastExit: undefined, handbackMarker: false },
    liveCore: () => false,
    takeStop: () => {
      t += 500;
      return stop;
    },
    bundleSig: () => undefined,
    spawnCore: (): CoreChild => {
      spawns++;
      if (spawns >= 3) stop = true;
      return { pid: 100 + spawns, kill() {}, exited: Promise.resolve({ code: 1, signal: null }) };
    },
    writeState: () => {},
    log: () => {},
  });
  expect(await sup.run()).toBe(0); // only the stop request ended it
  expect(spawns).toBe(3);
});
