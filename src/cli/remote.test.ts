// `agetor remote [status | off]` (docs/plans/always-on-host.md §3.5, §3.8, task I3).
//
// Runs the real CLI entry point as a subprocess against a real in-process
// `startApiServer()` (unique port 4487), found the way the CLI finds any core: a
// creds file carrying the CLI token. The point of the suite is the asymmetry the
// plan hangs the whole feature on — the CLI can read remote access and turn it
// OFF, and there is deliberately no way to turn it ON from here — so besides the
// two subcommands it pins that `remote on` is refused before any request, and
// that the preference the core stores stays exactly as it was.
//
// Isolation. `AGETOR_DATA_DIR` and the port are set before any `../bun/*` import
// (the db opens on import). Every subprocess gets `--data-dir`, a throwaway
// `HOME` and `--no-daemon`, so none can start a daemon or reach the user's real
// core on 4317. The login-item helper is the file-backed fake, so the core's
// status probe after a change never runs a real binary.
import { test, expect, beforeAll, afterAll, beforeEach, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "../bun/test-data-dir.ts";

const HOME = realpathSync(mkdtempSync(path.join(tmpdir(), "agetor-cli-remote-home-")));
const LIVE_DIR = mkdtempSync(path.join(tmpdir(), "agetor-cli-remote-live-"));
/** A data dir with no core in it. */
const EMPTY_DIR = path.join(HOME, "empty");
mkdirSync(EMPTY_DIR, { recursive: true });
const PORT = 4487;

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
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

import { REMOTE_ACCESS_PREF_KEY } from "../shared/types.ts";
import { CORE_CREDS_FILENAME, writeCoreCreds } from "../bun/core-creds.ts";

let server: { stop: () => void };
/** The data dir the in-process server really uses (`db.ts` is a process-wide
 *  singleton, so another test file may have opened it first). */
let SERVER_DIR = LIVE_DIR;
let preferences: typeof import("../bun/db.ts").preferences;

beforeAll(async () => {
  const db = await import("../bun/db.ts");
  SERVER_DIR = db.dataDir;
  preferences = db.preferences;
  const { CLI_TOKEN } = await import("../bun/api-config.ts");
  const { startApiServer } = await import("../bun/server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  mkdirSync(SERVER_DIR, { recursive: true });
  writeCoreCreds(
    {
      port: PORT,
      token: CLI_TOKEN,
      pid: process.pid,
      kind: "cli-daemon",
      version: "0.0.0-test",
      startedAt: Date.now(),
    },
    SERVER_DIR,
  );
});

afterAll(() => {
  server?.stop?.();
  rmSync(path.join(SERVER_DIR, CORE_CREDS_FILENAME), { force: true });
  rmSync(path.join(SERVER_DIR, "fake-login-item.json"), { force: true });
  rmTestDataDir(LIVE_DIR);
  rmSync(HOME, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const CLI_ENTRY = path.resolve(import.meta.dir, "index.ts");

// Each test launches the CLI (a cold bun start + its imports); on a loaded
// machine that outgrows bun's 5 s default.
setDefaultTimeout(60_000);

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function agetor(args: string[], dataDir: string): Promise<CliResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of ["AGETOR_API_TOKEN", "AGETOR_LAUNCHED_BY", "AGETOR_DAEMON_IDLE_MS"]) delete env[k];
  Object.assign(env, {
    HOME,
    AGETOR_DATA_DIR: dataDir,
    AGETOR_API_PORT: String(PORT),
    AGETOR_FAKE_LOGIN_ITEM: "1",
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

const remoteIs = () => preferences.get(REMOTE_ACCESS_PREF_KEY);

beforeEach(() => {
  preferences.set(REMOTE_ACCESS_PREF_KEY, "off");
});

test("remote status reports the core's remote-access setting (and bare `remote` is status)", async () => {
  const off = await agetor(["remote", "status"], SERVER_DIR);
  expect(off.code).toBe(0);
  expect(off.stdout.trim()).toBe("Remote access (preview): off");

  preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
  const on = await agetor(["remote", "status"], SERVER_DIR);
  expect(on.code).toBe(0);
  expect(on.stdout.trim()).toBe("Remote access (preview): on");

  const bare = await agetor(["remote"], SERVER_DIR);
  expect(bare.stdout.trim()).toBe("Remote access (preview): on");
  // Reading never changes it.
  expect(remoteIs()).toBe("on");
});

test("remote status --json prints the RemoteAccessStatus shape", async () => {
  preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
  const res = await agetor(["remote", "status", "--json"], SERVER_DIR);
  expect(res.code).toBe(0);
  expect(JSON.parse(res.stdout)).toEqual({ enabled: true, preview: true });
});

test("remote off turns it off in the core and says so", async () => {
  preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
  const res = await agetor(["remote", "off"], SERVER_DIR);
  expect(res.code).toBe(0);
  expect(res.stdout.trim()).toBe("Remote access (preview): off");
  expect(remoteIs()).toBe("off");
  // A later read agrees.
  expect((await agetor(["remote", "status"], SERVER_DIR)).stdout.trim()).toBe("Remote access (preview): off");
});

test("remote off --json, and off when already off", async () => {
  preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
  const res = await agetor(["remote", "off", "--json"], SERVER_DIR);
  expect(res.code).toBe(0);
  expect(JSON.parse(res.stdout)).toEqual({ enabled: false, preview: true });
  expect(remoteIs()).toBe("off");

  const again = await agetor(["remote", "off", "--json"], SERVER_DIR);
  expect(again.code).toBe(0);
  expect(JSON.parse(again.stdout)).toEqual({ enabled: false, preview: true });
});

test("there is no `remote on`: it is refused before any request and changes nothing", async () => {
  preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
  for (const sub of ["on", "enable", "true"]) {
    const res = await agetor(["remote", sub], SERVER_DIR);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(`unknown remote subcommand: ${sub} (use status | off)`);
  }
  expect(remoteIs()).toBe("on");

  // Off stays off: nothing here can raise it.
  preferences.set(REMOTE_ACCESS_PREF_KEY, "off");
  const res = await agetor(["remote", "on"], SERVER_DIR);
  expect(res.code).toBe(1);
  expect(remoteIs()).toBe("off");
});

test("a stray flag or extra argument is refused with the usage line", async () => {
  preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
  for (const args of [
    ["remote", "status", "--foo"],
    ["remote", "off", "extra"],
  ]) {
    const res = await agetor(args, SERVER_DIR);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("usage: agetor remote [status | off]");
  }
  // `off --foo` must not have switched anything off.
  expect(remoteIs()).toBe("on");
});

test("remote status and off with no core fail instead of starting a daemon", async () => {
  for (const sub of ["status", "off"]) {
    const res = await agetor(["remote", sub], EMPTY_DIR);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("No Agetor core is running");
  }
  expect(existsSync(path.join(EMPTY_DIR, CORE_CREDS_FILENAME))).toBe(false);
  expect(existsSync(path.join(EMPTY_DIR, "daemon.log"))).toBe(false);
});
