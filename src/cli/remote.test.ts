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
  expect(off.stdout.trim().split("\n")[0]).toBe("Remote access (preview): off");

  preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
  const on = await agetor(["remote", "status"], SERVER_DIR);
  expect(on.code).toBe(0);
  expect(on.stdout.trim().split("\n")[0]).toBe("Remote access (preview): on");

  const bare = await agetor(["remote"], SERVER_DIR);
  expect(bare.stdout.trim().split("\n")[0]).toBe("Remote access (preview): on");
  // Reading never changes it.
  expect(remoteIs()).toBe("on");
});

test("remote status --json prints the RemoteAccessStatus shape", async () => {
  preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
  const res = await agetor(["remote", "status", "--json"], SERVER_DIR);
  expect(res.code).toBe(0);
  expect(JSON.parse(res.stdout)).toMatchObject({ enabled: true, preview: true, companion: true });
});

test("remote off turns it off in the core and says so", async () => {
  preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
  const res = await agetor(["remote", "off"], SERVER_DIR);
  expect(res.code).toBe(0);
  expect(res.stdout.trim().split("\n")[0]).toBe("Remote access (preview): off");
  expect(remoteIs()).toBe("off");
  // A later read agrees.
  expect((await agetor(["remote", "status"], SERVER_DIR)).stdout.trim().split("\n")[0]).toBe("Remote access (preview): off");
});

test("remote off --json, and off when already off", async () => {
  preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
  const res = await agetor(["remote", "off", "--json"], SERVER_DIR);
  expect(res.code).toBe(0);
  expect(JSON.parse(res.stdout)).toMatchObject({ enabled: false, preview: true });
  expect(remoteIs()).toBe("off");

  const again = await agetor(["remote", "off", "--json"], SERVER_DIR);
  expect(again.code).toBe(0);
  expect(JSON.parse(again.stdout)).toMatchObject({ enabled: false, preview: true });
});

test("there is no `remote on`: it is refused before any request and changes nothing", async () => {
  preferences.set(REMOTE_ACCESS_PREF_KEY, "on");
  for (const sub of ["on", "enable", "true"]) {
    const res = await agetor(["remote", sub], SERVER_DIR);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(`unknown remote subcommand: ${sub} (use status | off |`);
    // the list of what exists names neither `on` nor `pair`
    expect(res.stderr.replace(/unknown remote subcommand: \S+/, "")).not.toMatch(/\b(on|pair)\b/);
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
    expect(res.stderr).toContain("usage: agetor remote [status | off");
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


// ── devices, revoke, log (docs/architecture/remote-gateway.md) ─────────────────────────────────────────────────────────────────
// The in-process core uses the fake key helper, and the rows are signed by its registry key the way a pairing signs them.
import { p256 } from "@noble/curves/nist.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { randomBytes, toHex } from "@agetor/remote-protocol/bytes";
import type { RemoteLevel } from "@agetor/remote-protocol/levels";
import { resolveDevice } from "./commands/remote.ts";

let helperFake: import("../bun/remote/key-helper-fake.ts").FakeKeyHelper;
let setHelper: typeof import("../bun/remote/key-helper-api.ts").setKeyHelperForTests;

async function enroll(over: { name: string; level?: RemoteLevel; badSig?: boolean; id?: string }): Promise<string> {
  const { registryEntryJson } = await import("../bun/remote/registry.ts");
  const asyncDb = await import("../bun/db-async.ts");
  const id = over.id ?? toHex(randomBytes(16));
  const row = {
    id, name: over.name, platform: "ios" as const, sessionPub: p256.getPublicKey(p256.utils.randomSecretKey(), false),
    approvePub: p256.getPublicKey(p256.utils.randomSecretKey(), false), pushPub: x25519.getPublicKey(x25519.utils.randomSecretKey()), level: over.level ?? "respond", enrolledAt: Date.now(),
  };
  const sig = over.badSig ? new Uint8Array(64).fill(1) : helperFake.signRegistryEntry(id, registryEntryJson(row));
  await asyncDb.op("remote.addDevice", [{ ...row, appVersion: "1", linkSecret: randomBytes(32), sig }, { ts: Date.now(), action: "pair", deviceId: id }]);
  return id;
}

async function helperOn(): Promise<void> {
  if (helperFake) return;
  const { FakeKeyHelper } = await import("../bun/remote/key-helper-fake.ts");
  ({ setKeyHelperForTests: setHelper } = await import("../bun/remote/key-helper-api.ts"));
  helperFake = new FakeKeyHelper();
  setHelper(helperFake);
}

test("remote devices lists the phones with their trust, and --json is the route's own shape; names are escaped", async () => {
  await helperOn();
  const db = await import("../bun/db.ts");
  db.db.run(`DELETE FROM remote_devices`);
  const good = await enroll({ name: "Ana's iPhone", level: "operate" });
  await enroll({ name: "Forged\u202e", badSig: true });
  const res = await agetor(["remote", "devices"], SERVER_DIR);
  expect(res.code).toBe(0);
  expect(res.stdout).toContain(good.slice(0, 8));
  expect(res.stdout).toContain("Ana's iPhone");
  expect(res.stdout).toContain("operate");
  expect(res.stdout).toContain("NOT TRUSTED (signature)");
  expect(res.stdout).not.toContain("\u202e");
  const json = await agetor(["remote", "devices", "--json"], SERVER_DIR);
  expect((JSON.parse(json.stdout) as { devices: unknown[] }).devices).toHaveLength(2);
});

test("remote revoke <device> by id prefix or exact name; an unknown or ambiguous one is refused and nothing is revoked", async () => {
  await helperOn();
  const db = await import("../bun/db.ts");
  db.db.run(`DELETE FROM remote_devices`);
  const a = await enroll({ name: "Ana", id: "ab" + "0".repeat(30) });
  const b = await enroll({ name: "Ana", id: "ab" + "1".repeat(30) });
  const c2 = await enroll({ name: "Ben" });
  const ambiguous = await agetor(["remote", "revoke", "Ana"], SERVER_DIR);
  expect(ambiguous.code).toBe(1);
  expect(ambiguous.stderr).toContain("matches 2 devices");
  const prefixTwo = await agetor(["remote", "revoke", "ab"], SERVER_DIR);
  expect(prefixTwo.code).toBe(1); // under 4 characters is never a prefix
  const unknown = await agetor(["remote", "revoke", "zzzzzz"], SERVER_DIR);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("no device matches");
  const status = (id: string) => db.db.query<{ status: string }, [string]>(`SELECT status FROM remote_devices WHERE id = ?`).get(id)?.status;
  expect([status(a), status(b), status(c2)]).toEqual(["active", "active", "active"]);

  const byName = await agetor(["remote", "revoke", "Ben"], SERVER_DIR);
  expect(byName.code).toBe(0);
  expect(status(c2)).toBe("revoked");
  const byPrefix = await agetor(["remote", "revoke", a.slice(0, 6)], SERVER_DIR);
  expect(byPrefix.code).toBe(0);
  expect(status(a)).toBe("revoked");
  expect(status(b)).toBe("active");
});

test("remote revoke-all needs --yes, and with it revokes every phone", async () => {
  await helperOn();
  const db = await import("../bun/db.ts");
  db.db.run(`DELETE FROM remote_devices`);
  const id = await enroll({ name: "Ana" });
  const refused = await agetor(["remote", "revoke-all"], SERVER_DIR);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("--yes");
  expect(db.db.query<{ status: string }, [string]>(`SELECT status FROM remote_devices WHERE id = ?`).get(id)?.status).toBe("active");
  const done = await agetor(["remote", "revoke-all", "--yes"], SERVER_DIR);
  expect(done.code).toBe(0);
  expect(db.db.query<{ status: string }, [string]>(`SELECT status FROM remote_devices WHERE id = ?`).get(id)?.status).toBe("revoked");
});

test("remote log prints the chain status and the rows; --limit is validated", async () => {
  await helperOn();
  const res = await agetor(["remote", "log", "--limit", "5"], SERVER_DIR);
  expect(res.code).toBe(0);
  expect(res.stdout).toContain("audit chain: intact");
  expect(res.stdout).toContain("ACTION");
  for (const bad of [["--limit", "0"], ["--limit", "x"], ["--limit"], ["--nope"]]) {
    expect((await agetor(["remote", "log", ...bad], SERVER_DIR)).code, bad.join(" ")).toBe(1);
  }
});

test("there is still no `pair` and no `on`", async () => {
  for (const sub of ["pair", "on", "add", "level"]) {
    const res = await agetor(["remote", sub], SERVER_DIR);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("unknown remote subcommand");
  }
});

test("resolveDevice: an id prefix of 4+ characters or an exact name, never a guess", () => {
  const mk = (id: string, name: string) => ({ id, name, platform: "ios" as const, appVersion: "1", level: "respond" as const, trust: "trusted" as const, enrolledAt: 1, lastSeenAt: null, pushRegistered: false, online: false });
  const ds = [mk("abcd" + "0".repeat(28), "Ana"), mk("abce" + "0".repeat(28), "Ben"), mk("ffff" + "0".repeat(28), "Ana")];
  expect(resolveDevice(ds, "Ben").name).toBe("Ben");
  expect(resolveDevice(ds, "abcd").id.startsWith("abcd")).toBe(true);
  expect(resolveDevice(ds, "ABCD").id.startsWith("abcd")).toBe(true);
  expect(() => resolveDevice(ds, "Ana")).toThrow("matches 2 devices");
  expect(() => resolveDevice(ds, "abc")).toThrow("no device matches");
  expect(() => resolveDevice(ds, "")).toThrow("which device");
  expect(() => resolveDevice(ds, "nobody")).toThrow("no device matches");
});

afterAll(() => {
  setHelper?.(null);
});
