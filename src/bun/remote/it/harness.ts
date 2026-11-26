/**
 * The integration harness for the Companion (docs/architecture/remote-gateway.md, "Tests"): a REAL headless core as a child process
 * (`bun src/bun/headless.ts`, like e2e/fixtures.ts) with the fake key helper's state in a directory both the seeding script and the core read,
 * the relay seam pointed at the in-process test relay, and the headless phone playing the other end. Nothing here is a mock of the core.
 *
 * `NODE_ENV` is NOT `test` for the child (production-like db worker, no in-process shortcut); the seams are allowed by
 * `AGETOR_E2E_HARNESS_SEAMS=1`, exactly as the e2e backend does.
 */
import { coreSpawn, coreSpawnSync } from "../../core-spawn.ts";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { toHex } from "@agetor/remote-protocol/bytes";
import { mailboxId, mailboxKey, utcDate } from "@agetor/remote-protocol/derive";
import { TestPhone } from "@agetor/remote-protocol/test-client";
import { startTestRelay, type TestRelay } from "@agetor/remote-protocol/test-relay";
import type { RemoteLevel } from "@agetor/remote-protocol/levels";

export const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(cond: () => boolean | Promise<boolean>, ms = 8000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const p = s.port;
  await s.stop(true);
  return p as number;
}

export interface SeededDevice {
  id: string;
  linkSecret: Uint8Array;
  phone: TestPhone;
  level: RemoteLevel;
}

export interface CoreHandle {
  port: number;
  token: string;
  dataDir: string;
  helperDir: string;
  relay: TestRelay;
  devices: SeededDevice[];
  corePub: Uint8Array;
  /** The child's own pid. */
  pid(): number;
  api(method: string, p: string, body?: unknown, token?: string): Promise<Response>;
  /** Every secret this run created, as hex strings and raw bytes, for the log and file scans. */
  secrets(): string[];
  /** `kill -9`, no shutdown path. */
  kill9(): Promise<void>;
  /** Boot the core again on the same data dir (after a kill). */
  restart(): Promise<void>;
  stop(): Promise<void>;
  /** Every file under the data dir, as [relative path, bytes]. */
  files(): Array<[string, Buffer]>;
  readLog(name: string): string;
}

export interface CoreOptions {
  /** Called with every frame the relay sees (see `startTestRelay`'s `tap`). */
  tap?: (dir: "in" | "out", bytes: Uint8Array) => void;
  devices?: Array<{ name: string; level: RemoteLevel }>;
  remoteOn?: boolean;
  env?: Record<string, string>;
  /** Reuse these (for a second core on the same data dir). */
  reuse?: { dataDir: string; helperDir: string; relay: TestRelay; devices: SeededDevice[]; corePub: Uint8Array };
}

export async function startCore(opts: CoreOptions = {}): Promise<CoreHandle> {
  const relay = opts.reuse?.relay ?? startTestRelay({ limits: { framesPerSecond: 10_000 }, tap: opts.tap });
  const dataDir = opts.reuse?.dataDir ?? mkdtempSync(path.join(tmpdir(), "agt-it-core-"));
  const helperDir = opts.reuse?.helperDir ?? path.join(dataDir, "..", `${path.basename(dataDir)}-helper`);
  mkdirSync(helperDir, { recursive: true });
  // `coreSpawn` scrubs the master token from a child's env (the point of it), so the harness authenticates with the CLI token the core writes to
  // its creds file, the same way `agetor` does.
  let token = "";
  const port = await freePort();

  let devices: SeededDevice[] = opts.reuse?.devices ?? [];
  let corePub = opts.reuse?.corePub ?? new Uint8Array(0);
  if (!opts.reuse) {
    const phones = (opts.devices ?? []).map((d) => ({ d, phone: new TestPhone({ relayUrl: relay.url, timeoutMs: 6000 }) }));
    const spec = phones.map(({ d, phone }) => ({ name: d.name, level: d.level, sessionPub: toHex(phone.sessionPub), approvePub: toHex(phone.approvePub), pushPub: toHex(phone.pushPub) }));
    const seeded = coreSpawnSync("bun", [path.join(import.meta.dir, "seed-devices.ts"), dataDir, helperDir, JSON.stringify(spec)], { env: { ...process.env, NODE_ENV: "test" }, cwd: REPO_ROOT, encoding: "utf8" });
    if (seeded.status !== 0) throw new Error(`seeding failed: ${String(seeded.stderr)}`);
    const parsed = JSON.parse(String(seeded.stdout).trim().split("\n").pop()!) as { corePub: string; devices: Array<{ id: string; linkSecret: string }> };
    corePub = Uint8Array.from(Buffer.from(parsed.corePub, "hex"));
    devices = phones.map(({ d, phone }, i) => ({ id: parsed.devices[i]!.id, linkSecret: Uint8Array.from(Buffer.from(parsed.devices[i]!.linkSecret, "hex")), phone, level: d.level }));
  }

  let child: ReturnType<typeof coreSpawn> | null = null;
  const env = {
    ...process.env,
    NODE_ENV: undefined,
    AGETOR_DATA_DIR: dataDir,
    AGETOR_API_PORT: String(port),
    AGETOR_DAEMON_IDLE_MS: "600000",
    AGETOR_HEADLESS_NOTIFICATIONS: "0",
    AGETOR_E2E_HARNESS_SEAMS: "1",
    AGETOR_FAKE_KEY_HELPER: "1",
    AGETOR_FAKE_KEY_HELPER_DIR: helperDir,
    AGETOR_REMOTE_RELAY_URL: relay.url,
    AGETOR_REMOTE_PUSH_URL: "http://127.0.0.1:9",
    AGETOR_FAKE_LOGIN_ITEM: "1",
    ...(opts.remoteOn === false ? {} : { AGETOR_FAKE_REMOTE_ACCESS: "on" }),
    AGETOR_CLAUDE_DRIVER: "fake",
    AGETOR_CLAUDE_BIN: "/bin/echo",
    AGETOR_TMUX_BIN: "/bin/echo",
    AGETOR_CLAUDE_ARGS: "",
    AGETOR_HARNESS_AUTO_ENABLE: "0",
    ...opts.env,
  } as NodeJS.ProcessEnv;
  delete env.NODE_ENV;

  const boot = async () => {
    child = coreSpawn(["bun", "src/bun/headless.ts"], { cwd: REPO_ROOT, env: env as Record<string, string>, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await until(async () => {
      try {
        const creds = JSON.parse(readFileSync(path.join(dataDir, "agetor-core.json"), "utf8")) as { token?: string; port?: number; pid?: number };
        if (creds.port !== port || !creds.token || creds.pid !== child?.pid) return false;
        const ok = (await fetch(`http://127.0.0.1:${port}/info`, { headers: { authorization: `Bearer ${creds.token}` } })).status === 200;
        if (ok) token = creds.token;
        return ok;
      } catch {
        return false;
      }
    }, 30_000, "the core to answer /info");
  };
  await boot();

  const handle: CoreHandle = {
    port, get token() { return token; }, dataDir, helperDir, relay, devices, corePub,
    pid: () => child?.pid ?? -1,
    api: (method, p, body, tok) =>
      fetch(`http://127.0.0.1:${port}${p}`, {
        method,
        headers: { authorization: `Bearer ${tok ?? token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    secrets: () => {
      const out: string[] = [token];
      for (const d of devices) out.push(toHex(d.linkSecret), toHex(d.phone.sessionSecret), toHex(d.phone.approveSecret), toHex(d.phone.pushSecret));
      return out;
    },
    async kill9() {
      const c = child;
      if (!c) return;
      c.kill(9);
      await c.exited;
      child = null;
    },
    async restart() {
      if (child) await handle.kill9();
      await boot();
    },
    async stop() {
      const c = child;
      if (c) {
        c.kill(15);
        await Promise.race([c.exited, sleep(5000)]);
        if (c.exitCode === null) c.kill(9);
        child = null;
      }
      if (!opts.reuse) {
        relay.stop();
        rmSync(dataDir, { recursive: true, force: true });
        rmSync(helperDir, { recursive: true, force: true });
      }
    },
    files() {
      const out: Array<[string, Buffer]> = [];
      const walk = (dir: string) => {
        for (const e of readdirSync(dir)) {
          const p = path.join(dir, e);
          const st = statSync(p);
          if (st.isDirectory()) walk(p);
          else if (st.size < 200 * 1024 * 1024) out.push([path.relative(dataDir, p), readFileSync(p)]);
        }
      };
      walk(dataDir);
      return out;
    },
    readLog(name) {
      try {
        return readFileSync(path.join(dataDir, name), "utf8");
      } catch {
        return "";
      }
    },
  };
  return handle;
}

/** Connect device `i` of a core. */
export async function connectDevice(core: CoreHandle, i = 0): Promise<Record<string, unknown>> {
  const d = core.devices[i]!;
  return await d.phone.connect({ corePub: core.corePub, deviceId: d.id, linkSecret: d.linkSecret });
}

/** Whether the core is joined to device `i`'s mailbox on the relay right now (today's id). */
export function coreOnDeviceMailbox(core: CoreHandle, i: number): boolean {
  const id = toHex(mailboxId(mailboxKey(core.devices[i]!.linkSecret, utcDate(Date.now()))));
  return core.relay.mailboxes().some((m) => m.id === id && m.core);
}

export function coreOnRelay(relay: TestRelay): boolean {
  return relay.mailboxes().some((m) => m.core);
}
