// `agetor daemon` and the background (login-item) state it reports
// (docs/plans/always-on-host.md §3.8, task I3).
//
// These run the real CLI entry point (`src/cli/index.ts`) as a subprocess:
//  - against a real in-process `startApiServer()` for the paths that talk to a
//    live core (`daemon status`, `daemon stop`, `daemon background off`), found
//    the way the real CLI finds a core — through a creds file the test writes;
//  - against no core at all for the offline paths (`daemon status` with
//    nothing running, `daemon start` re-registering a stopped login item).
// A subprocess, not a direct `cmdDaemon()` call, because the offline derivation
// compares the channel's expected data dir (`<home>/.agetor`) with the CLI's own,
// and Bun fixes `os.homedir()` at process start — the only way to give the CLI
// a throwaway home is to launch it with `HOME` set. The subprocess's stdout is a
// pipe, so the CLI prints plain (no ANSI), exactly as in scripts.
//
// The macOS login-item helper is replaced by its file-backed fake
// (`AGETOR_FAKE_LOGIN_ITEM=1`, `<dataDir>/fake-login-item.json`): the test seeds
// the registration and reads back `calls` to see exactly what the CLI and the
// core asked the helper to do.
//
// Isolation. `AGETOR_DATA_DIR` and the port (4486) are set before any `../bun/*`
// import (the db opens on import); every CLI subprocess gets `--data-dir`, a
// throwaway `HOME`, and `--no-daemon`, so none of them can start a daemon or
// reach the user's real core on 4317.
import { test, expect, beforeAll, afterAll, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "../bun/test-data-dir.ts";

const HOME = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-cli-bg-home-")));
/** Data dir of the in-process server (live-core tests). */
const LIVE_DIR = mkdtempSync(path.join(tmpdir(), "agetor-cli-bg-live-"));
/** Where a stable install keeps its data under `HOME` — the dir the offline
 *  derivation expects, so the fake's "stable, in /Applications" info reads as
 *  this install rather than "another install owns the login item". */
const OFFLINE_DIR = path.join(HOME, ".agetor");
mkdirSync(OFFLINE_DIR, { recursive: true });
const PORT = 4486;

const ENV_KEYS = [
  "AGETOR_DATA_DIR",
  "AGETOR_API_PORT",
  "AGETOR_FAKE_LOGIN_ITEM",
  "AGETOR_CLAUDE_BIN",
  "AGETOR_CODEX_BIN",
  "AGETOR_TMUX_BIN",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.AGETOR_DATA_DIR = LIVE_DIR;
process.env.AGETOR_API_PORT = String(PORT);
process.env.AGETOR_FAKE_LOGIN_ITEM = "1";
// Harness probes stay local and instant; nothing here starts a task.
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

import type { BackgroundRegistration } from "../shared/types.ts";
import { REMOTE_ACCESS_PREF_KEY } from "../shared/types.ts";
import { CORE_CREDS_FILENAME, writeCoreCreds } from "../bun/core-creds.ts";
import { takeSupervisorStop, writeLoginDaemonState } from "../bun/login-daemon-state.ts";

let server: { stop: () => void };
/** The data dir the in-process server (and so its fake helper) really uses —
 *  `db.ts` is a process-wide singleton, so another file may have opened it first. */
let SERVER_DIR = LIVE_DIR;
let preferences: typeof import("../bun/db.ts").preferences;
let getBackgroundStatus: typeof import("../bun/background.ts").getBackgroundStatus;
let CLI_TOKEN = "";
const shutdownRequests: string[] = [];

beforeAll(async () => {
  const db = await import("../bun/db.ts");
  SERVER_DIR = db.dataDir;
  preferences = db.preferences;
  ({ getBackgroundStatus } = await import("../bun/background.ts"));
  ({ CLI_TOKEN } = await import("../bun/api-config.ts"));
  const { startApiServer } = await import("../bun/server.ts");
  // `onShutdownRequest` is the seam the headless core uses; recording it keeps
  // `POST /daemon/shutdown` from calling process.exit inside the test runner.
  server = startApiServer({
    onShutdownRequest: (mode) => {
      shutdownRequests.push(mode);
    },
  }) as unknown as { stop: () => void };
});

afterAll(() => {
  server?.stop?.();
  clearDir(SERVER_DIR);
  clearDir(OFFLINE_DIR);
  rmTestDataDir(LIVE_DIR);
  rmSync(HOME, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---------------------------------------------------------------------------
// Fixtures

const FILES = [
  CORE_CREDS_FILENAME,
  "fake-login-item.json",
  "login-daemon.json",
  "login-daemon-control.json",
  "login-daemon-handback.json",
  "daemon.log",
];

function clearDir(dir: string): void {
  for (const f of FILES) rmSync(path.join(dir, f), { force: true });
}

const fakePath = (dir: string) => path.join(dir, "fake-login-item.json");

interface FakeFile {
  registration: BackgroundRegistration;
  calls: string[];
  info?: Record<string, unknown>;
  failNext?: { command: string; error: { domain: string; code: number; message: string } };
}

function seedFake(dir: string, state: Partial<FakeFile> = {}): void {
  mkdirSync(dir, { recursive: true });
  const full: FakeFile = { registration: "enabled", calls: [], ...state };
  writeFileSync(fakePath(dir), JSON.stringify(full));
}

function readFake(dir: string): FakeFile {
  return JSON.parse(readFileSync(fakePath(dir), "utf8")) as FakeFile;
}

/** A creds file pointing the CLI at the in-process server. */
function writeCreds(dir: string, launchedBy?: "login-item"): void {
  mkdirSync(dir, { recursive: true });
  writeCoreCreds(
    {
      port: PORT,
      token: CLI_TOKEN,
      pid: process.pid,
      kind: "cli-daemon",
      version: "0.0.0-test",
      startedAt: Date.now(),
      ...(launchedBy ? { launchedBy } : {}),
    },
    dir,
  );
}

/** A live supervisor record: `pid` is this test process, so `liveSupervisor`
 *  sees it as alive. */
function writeSupervisor(
  dir: string,
  state: "running" | "waiting" | "parked",
  corePid: number | null,
): void {
  const now = Date.now();
  writeLoginDaemonState(
    {
      pid: process.pid,
      state,
      corePid,
      bundlePath: "/Applications/Agetor.app",
      version: "0.0.0-test",
      label: "sh.alamops.agetor.daemon",
      startedAt: now,
      updatedAt: now,
    },
    dir,
  );
}

/** Seed the in-process server's view: fake registration + supervisor state,
 *  then refresh the server's 2 s status cache so the next `GET /background`
 *  reflects it, and zero the fake's call log the refresh just wrote to. */
async function seedLive(
  registration: BackgroundRegistration,
  opts: { supervisor?: "running" | "waiting" | "parked" | null; failNext?: FakeFile["failNext"] } = {},
): Promise<void> {
  clearDir(SERVER_DIR);
  seedFake(SERVER_DIR, { registration });
  if (opts.supervisor) {
    writeSupervisor(SERVER_DIR, opts.supervisor, opts.supervisor === "running" ? process.pid : null);
  }
  await getBackgroundStatus({ fresh: true });
  seedFake(SERVER_DIR, { registration: readFake(SERVER_DIR).registration, failNext: opts.failNext });
}

// ---------------------------------------------------------------------------
// Running the real CLI

const CLI_ENTRY = path.resolve(import.meta.dir, "index.ts");

// Every test launches the CLI (a cold bun start + its imports) one or more times;
// on a loaded machine that outgrows bun's 5 s default.
setDefaultTimeout(60_000);

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `agetor <args>` against `dataDir` with a throwaway `HOME`. Always
 *  `--no-daemon`, so a missing core is an error, never a spawned daemon. */
async function agetor(args: string[], dataDir: string, extraEnv: Record<string, string> = {}): Promise<CliResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of ["AGETOR_API_TOKEN", "AGETOR_LAUNCHED_BY", "AGETOR_DAEMON_IDLE_MS"]) delete env[k];
  Object.assign(env, {
    HOME,
    AGETOR_DATA_DIR: dataDir,
    AGETOR_API_PORT: String(PORT),
    AGETOR_FAKE_LOGIN_ITEM: "1",
    ...extraEnv,
  });
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, "--no-daemon", "--data-dir", dataDir, ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 40_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    proc.kill();
  }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await Bun.sleep(25);
  }
  return cond();
}

beforeEach(() => {
  shutdownRequests.length = 0;
  clearDir(SERVER_DIR);
  clearDir(OFFLINE_DIR);
});

afterEach(() => {
  clearDir(SERVER_DIR);
  clearDir(OFFLINE_DIR);
});

/** The offline derivation uses the CLI's own platform, so it only reaches
 *  states past `not-macos` on macOS. */
const macTest = process.platform === "darwin" ? test : test.skip;

// ---------------------------------------------------------------------------
// With a live core (read through GET /background)

test("daemon status asks the live core for its background state", async () => {
  await seedLive("enabled", { supervisor: "running" });
  writeCreds(SERVER_DIR);
  const res = await agetor(["daemon", "status"], SERVER_DIR);
  expect(res.code).toBe(0);
  expect(res.stdout).toContain(`127.0.0.1:${PORT}`);
  // The live path: the server derives it (fake data-dir override). The CLI's
  // own offline derivation, with this data dir not being `HOME/.agetor`, would
  // have answered "unavailable" instead.
  const line = res.stdout.split("\n").find((l) => l.startsWith("background:"));
  expect(line).toBeDefined();
  expect(line).toContain("running");
  expect(line).toContain("sh.alamops.agetor.daemon");
  expect(line).toContain(`supervisor pid ${process.pid}`);
  expect(line).toContain(`core pid ${process.pid}`);
  expect(res.stdout).not.toContain("unavailable");
});

test("daemon status --json adds launchedBy and the background object", async () => {
  await seedLive("enabled", { supervisor: "running" });
  writeCreds(SERVER_DIR, "login-item");
  const res = await agetor(["daemon", "status", "--json"], SERVER_DIR);
  expect(res.code).toBe(0);
  const j = JSON.parse(res.stdout);
  expect(j.running).toBe(true);
  expect(j.kind).toBe("cli-daemon");
  expect(j.launchedBy).toBe("login-item");
  expect(j.port).toBe(PORT);
  expect(j.token).toBeUndefined(); // creds stay secret
  expect(j.background).toMatchObject({
    state: "running",
    registration: "enabled",
    label: "sh.alamops.agetor.daemon",
    supervisorPid: process.pid,
    corePid: process.pid,
    remoteAccess: false,
  });
  expect(res.stdout).not.toContain(CLI_TOKEN);

  // A core the CLI itself spawned has no launchedBy.
  writeCreds(SERVER_DIR);
  const plain = JSON.parse((await agetor(["daemon", "status", "--json"], SERVER_DIR)).stdout);
  expect(plain.launchedBy).toBeNull();
});

test("daemon status shows a login-item core's origin on its first line", async () => {
  await seedLive("enabled", { supervisor: "running" });
  writeCreds(SERVER_DIR, "login-item");
  const res = await agetor(["daemon", "status"], SERVER_DIR);
  expect(res.code).toBe(0);
  expect(res.stdout.split("\n")[0]).toContain("launchedBy login-item");
});

test("daemon background status reads the live core and --json prints the object", async () => {
  await seedLive("requiresApproval");
  writeCreds(SERVER_DIR);
  const res = await agetor(["daemon", "background", "status"], SERVER_DIR);
  expect(res.code).toBe(0);
  expect(res.stdout).toContain("background: needs approval");
  expect(res.stdout).toContain("Login Items");

  const json = JSON.parse((await agetor(["daemon", "background", "status", "--json"], SERVER_DIR)).stdout);
  expect(json.state).toBe("needs-approval");
  expect(json.registration).toBe("requiresApproval");
  // The bare `daemon background` is `status`.
  const bare = await agetor(["daemon", "background"], SERVER_DIR);
  expect(bare.stdout).toContain("background: needs approval");
});

test("daemon background off unregisters the login item and turns remote access off", async () => {
  await seedLive("enabled", { supervisor: "running" });
  writeCreds(SERVER_DIR);
  preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
  expect(preferences.get(REMOTE_ACCESS_PREF_KEY)).toBe("on");

  const res = await agetor(["daemon", "background", "off"], SERVER_DIR);
  expect(res.code).toBe(0);
  expect(res.stdout).toContain("background: off");
  const fake = readFake(SERVER_DIR);
  expect(fake.calls).toContain("unregister");
  expect(fake.registration).toBe("notRegistered");
  // Remote access cannot outlive the host (C3): off before the unregister.
  expect(preferences.get(REMOTE_ACCESS_PREF_KEY)).toBe("off");
});

test("daemon background off --json prints the resulting status", async () => {
  await seedLive("enabled");
  writeCreds(SERVER_DIR);
  const res = await agetor(["daemon", "background", "off", "--json"], SERVER_DIR);
  expect(res.code).toBe(0);
  const j = JSON.parse(res.stdout);
  expect(j).toMatchObject({ state: "off", registration: "notRegistered", remoteAccess: false });
  expect(readFake(SERVER_DIR).calls).toContain("unregister");
});

test("daemon background off with no core fails instead of starting a daemon", async () => {
  seedFake(OFFLINE_DIR, { registration: "enabled" });
  const res = await agetor(["daemon", "background", "off"], OFFLINE_DIR);
  expect(res.code).toBe(1);
  expect(res.stderr).toContain("No Agetor core is running");
  expect(readFake(OFFLINE_DIR).calls).not.toContain("unregister");
  expect(existsSync(path.join(OFFLINE_DIR, CORE_CREDS_FILENAME))).toBe(false);
  expect(existsSync(path.join(OFFLINE_DIR, "daemon.log"))).toBe(false);
});

// ---------------------------------------------------------------------------
// daemon stop

const LOGIN_ITEM_STOP_LINE =
  "○ stopped — the background core starts again at next login (turn it off with `agetor daemon background off`)";

test("daemon stop on a login-item core asks for 'stop' and says it returns at next login", async () => {
  await seedLive("enabled", { supervisor: "running" });
  writeCreds(SERVER_DIR, "login-item");
  const res = await agetor(["daemon", "stop"], SERVER_DIR);
  expect(res.code).toBe(0);
  expect(res.stdout.trim()).toBe(LOGIN_ITEM_STOP_LINE);
  expect(await waitFor(() => shutdownRequests.length > 0)).toBe(true);
  // No body → "stop": a handoff would park the core instead of ending it.
  expect(shutdownRequests).toEqual(["stop"]);
});

test("daemon stop --json reports the login-item origin", async () => {
  await seedLive("enabled", { supervisor: "running" });
  writeCreds(SERVER_DIR, "login-item");
  const res = await agetor(["daemon", "stop", "--json"], SERVER_DIR);
  expect(res.code).toBe(0);
  expect(JSON.parse(res.stdout)).toEqual({ stopped: true, launchedBy: "login-item" });
  expect(await waitFor(() => shutdownRequests.length > 0)).toBe(true);
});

test("daemon stop on an ordinary daemon keeps the plain wording", async () => {
  await seedLive("notRegistered");
  writeCreds(SERVER_DIR);
  const res = await agetor(["daemon", "stop"], SERVER_DIR);
  expect(res.code).toBe(0);
  expect(res.stdout.trim()).toBe("○ shutdown requested");
  expect(res.stdout).not.toContain("next login");
  expect(await waitFor(() => shutdownRequests.length > 0)).toBe(true);
  expect(shutdownRequests).toEqual(["stop"]);
});

test("daemon stop with no core but a waiting supervisor asks it to stand down", async () => {
  writeSupervisor(OFFLINE_DIR, "waiting", null);
  const res = await agetor(["daemon", "stop"], OFFLINE_DIR);
  expect(res.code).toBe(0);
  expect(res.stdout).toContain(`asked the background supervisor (pid ${process.pid}) to stand down`);
  expect(takeSupervisorStop(OFFLINE_DIR)).toBe(true);

  const json = await agetor(["daemon", "stop", "--json"], OFFLINE_DIR);
  expect(JSON.parse(json.stdout)).toEqual({ stopped: false, supervisorStopRequested: true });
  expect(takeSupervisorStop(OFFLINE_DIR)).toBe(true);
});

test("daemon stop with nothing running says so and writes no stop request", async () => {
  const res = await agetor(["daemon", "stop"], OFFLINE_DIR);
  expect(res.code).toBe(0);
  expect(res.stdout.trim()).toBe("○ no core was running");
  expect(takeSupervisorStop(OFFLINE_DIR)).toBe(false);
  expect(JSON.parse((await agetor(["daemon", "stop", "--json"], OFFLINE_DIR)).stdout)).toEqual({
    stopped: false,
  });
});

// ---------------------------------------------------------------------------
// With no core: derived from the helper + the supervisor state file

macTest("offline daemon status derives the background state without starting anything", async () => {
  seedFake(OFFLINE_DIR, { registration: "enabled" });
  const res = await agetor(["daemon", "status"], OFFLINE_DIR);
  expect(res.code).toBe(0);
  expect(res.stdout).toContain("○ no Agetor core running");
  const line = res.stdout.split("\n").find((l) => l.startsWith("background:"));
  expect(line).toContain("stopped");
  expect(line).toContain("agetor daemon start");
  // It looked, and only looked: the helper saw info + status, nothing was
  // registered, and no daemon, creds file, log or database appeared.
  expect(readFake(OFFLINE_DIR).calls).toEqual(["info", "status"]);
  expect(existsSync(path.join(OFFLINE_DIR, CORE_CREDS_FILENAME))).toBe(false);
  expect(existsSync(path.join(OFFLINE_DIR, "daemon.log"))).toBe(false);
  expect(existsSync(path.join(OFFLINE_DIR, "agetor.sqlite"))).toBe(false);
});

macTest("offline daemon status --json has running:false and the background object", async () => {
  seedFake(OFFLINE_DIR, { registration: "enabled" });
  const res = await agetor(["daemon", "status", "--json"], OFFLINE_DIR);
  expect(res.code).toBe(0);
  const j = JSON.parse(res.stdout);
  expect(j.running).toBe(false);
  expect(j.launchedBy).toBeUndefined();
  expect(j.background).toMatchObject({
    state: "stopped",
    registration: "enabled",
    label: "sh.alamops.agetor.daemon",
    supervisorPid: null,
    corePid: null,
    // The setting lives in the core's database, which a CLI with no core can't read.
    remoteAccess: false,
  });
});

macTest("offline daemon status follows the registration and the supervisor's state file", async () => {
  const stateOf = async () =>
    (JSON.parse((await agetor(["daemon", "background", "status", "--json"], OFFLINE_DIR)).stdout) as {
      state: string;
    }).state;

  seedFake(OFFLINE_DIR, { registration: "notRegistered" });
  expect(await stateOf()).toBe("off");
  seedFake(OFFLINE_DIR, { registration: "requiresApproval" });
  expect(await stateOf()).toBe("needs-approval");
  seedFake(OFFLINE_DIR, { registration: "enabled" });
  expect(await stateOf()).toBe("stopped");
  writeSupervisor(OFFLINE_DIR, "parked", null);
  expect(await stateOf()).toBe("parked");
  writeSupervisor(OFFLINE_DIR, "waiting", null);
  expect(await stateOf()).toBe("starting");
  writeSupervisor(OFFLINE_DIR, "running", process.pid);
  expect(await stateOf()).toBe("running");
});

// ---------------------------------------------------------------------------
// daemon start

macTest("daemon start re-registers a stopped login item and waits for the core", async () => {
  seedFake(OFFLINE_DIR, { registration: "enabled" });
  // Stand in for launchd + the supervisor: once the helper has been asked to
  // re-register, a login-item core "comes up" (its creds appear).
  const comeUp = (async () => {
    if (await waitFor(() => readFake(OFFLINE_DIR).calls.includes("reregister"), 30_000)) {
      writeCreds(OFFLINE_DIR, "login-item");
    }
  })();
  const res = await agetor(["daemon", "start"], OFFLINE_DIR);
  await comeUp;
  expect(res.code).toBe(0);
  expect(res.stdout).toContain("started the background core");
  expect(res.stdout).toContain(`127.0.0.1:${PORT}`);
  expect(readFake(OFFLINE_DIR).calls).toEqual(["info", "status", "reregister"]);
  // It re-registered the login item instead of spawning a CLI daemon beside it.
  expect(existsSync(path.join(OFFLINE_DIR, "daemon.log"))).toBe(false);
}, 60_000);

macTest("daemon start --json prints the core that came up", async () => {
  seedFake(OFFLINE_DIR, { registration: "enabled" });
  const comeUp = (async () => {
    if (await waitFor(() => readFake(OFFLINE_DIR).calls.includes("reregister"), 30_000)) {
      writeCreds(OFFLINE_DIR, "login-item");
    }
  })();
  const res = await agetor(["daemon", "start", "--json"], OFFLINE_DIR);
  await comeUp;
  expect(res.code).toBe(0);
  const j = JSON.parse(res.stdout);
  expect(j).toMatchObject({ kind: "cli-daemon", port: PORT, launchedBy: "login-item" });
  expect(j.token).toBeUndefined();
}, 60_000);

macTest("daemon start surfaces a refused re-register", async () => {
  seedFake(OFFLINE_DIR, {
    registration: "enabled",
    failNext: {
      command: "reregister",
      error: { domain: "SMAppServiceErrorDomain", code: 1, message: "Operation not permitted" },
    },
  });
  const res = await agetor(["daemon", "start"], OFFLINE_DIR);
  expect(res.code).toBe(1);
  expect(res.stderr).toContain("could not start the background core: Operation not permitted");
  expect(readFake(OFFLINE_DIR).calls).toContain("reregister");
});

macTest("daemon start does not re-register unless the login item is stopped", async () => {
  // Turned off: the plain path (here --no-daemon, so a clean refusal).
  seedFake(OFFLINE_DIR, { registration: "notRegistered" });
  const off = await agetor(["daemon", "start"], OFFLINE_DIR);
  expect(off.code).toBe(1);
  expect(off.stderr).toContain("No Agetor core is running");
  expect(readFake(OFFLINE_DIR).calls).not.toContain("reregister");

  // Enabled with a supervisor that is about to boot a core: leave it alone.
  seedFake(OFFLINE_DIR, { registration: "enabled" });
  writeSupervisor(OFFLINE_DIR, "waiting", null);
  const starting = await agetor(["daemon", "start"], OFFLINE_DIR);
  expect(starting.code).toBe(1);
  expect(readFake(OFFLINE_DIR).calls).not.toContain("reregister");
});

test("daemon start with a live core reports it and touches nothing", async () => {
  await seedLive("enabled", { supervisor: "running" });
  writeCreds(SERVER_DIR, "login-item");
  const res = await agetor(["daemon", "start"], SERVER_DIR);
  expect(res.code).toBe(0);
  expect(res.stdout).toContain("core ready (cli-daemon)");
  expect(readFake(SERVER_DIR).calls).not.toContain("reregister");
});

// ---------------------------------------------------------------------------
// Usage errors

test("unknown subcommands and stray flags are refused the way the house commands refuse them", async () => {
  const unknown = await agetor(["daemon", "bogus"], OFFLINE_DIR);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("unknown daemon subcommand: bogus");
  expect(unknown.stderr).toContain("background");

  const stray = await agetor(["daemon", "status", "--foo"], OFFLINE_DIR);
  expect(stray.code).toBe(1);
  expect(stray.stderr).toContain("usage: agetor daemon");

  const badBackground = await agetor(["daemon", "background", "on"], OFFLINE_DIR);
  expect(badBackground.code).toBe(1);
  expect(badBackground.stderr).toContain("unknown daemon background subcommand: on");
  expect(badBackground.stderr).toContain("status | off");

  const strayBackground = await agetor(["daemon", "background", "off", "--foo"], OFFLINE_DIR);
  expect(strayBackground.code).toBe(1);
  expect(strayBackground.stderr).toContain("usage: agetor daemon");
  // None of these registered or unregistered anything.
  expect(existsSync(fakePath(OFFLINE_DIR))).toBe(false);
});
