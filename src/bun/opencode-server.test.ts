import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  lstatSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// db.ts captures AGETOR_DATA_DIR at first import — set it at module top level,
// before the dynamic imports below (same convention as siblings).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-opencode-server-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

const mod = await import("./opencode-server.ts");
const { rmTestDataDir } = await import("./test-data-dir.ts");
const { tmuxSocketArgs } = await import("./tmux-resolution.ts");
const {
  ensureOpencodeServer,
  adoptOpencodeServers,
  getOpencodeServer,
  noteOpencodeActivity,
  opencodeIdleSweep,
  stopOpencodeServer,
  stopIdleOpencodeServersSync,
  OPENCODE_SERVER_IDLE_MS,
  __forTest,
} = mod;
const checkOpencodeServerHealth = __forTest.checkHealth;
type Handle = Awaited<ReturnType<typeof ensureOpencodeServer>>;

const STUB_ROOT = mkdtempSync(path.join(tmpdir(), "agetor-opencode-server-stub-"));
const BUN = process.execPath;

// A stand-in `opencode`: records argv and each launch, and on `serve` execs a
// tiny Bun HTTP server that checks Basic auth on /api/info and prints the
// listening line. STUB_MODE picks a failure variant. Never the real binary.
const STUB_SERVER = `
const pw = process.env.OPENCODE_PASSWORD ?? "";
const dir = process.env.STUB_DIR ?? "";
const mode = process.env.STUB_MODE ?? "";
const fs = require("node:fs");
fs.writeFileSync(dir + "/pw", pw);
fs.writeFileSync(dir + "/autoupdate", process.env.OPENCODE_DISABLE_AUTOUPDATE ?? "");
fs.writeFileSync(dir + "/extra", process.env.STUB_EXTRA ?? "");
fs.writeFileSync(dir + "/pid", String(process.pid));
if (mode === "exit") { console.log("boom: cannot open database"); process.exit(1); }
if (mode === "leak") {
  console.log("server password " + pw);
  console.log("OPENCODE_PASSWORD=" + pw);
  console.log(pw);
  process.exit(1);
}
if (mode === "silent") { setInterval(() => {}, 1000); }
else {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (fs.existsSync(dir + "/slow")) await Bun.sleep(Number(fs.readFileSync(dir + "/slow", "utf8")));
      if (u.pathname !== "/api/info") return new Response("not found", { status: 404 });
      if (fs.existsSync(dir + "/unauth")) return new Response("no", { status: 401 });
      if (req.headers.get("authorization") !== "Basic " + btoa("opencode:" + pw)) return new Response("no", { status: 401 });
      return Response.json({ version: "2.1.3-stub", pid: process.pid });
    },
  });
  console.log("opencode server listening on http://127.0.0.1:" + server.port);
}
`;

function writeStub(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "stub-server.ts"), STUB_SERVER);
  const bin = path.join(dir, "opencode");
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" >> "${dir}/argv.log"
echo launch >> "${dir}/launches"
if [ "$1" = "serve" ]; then exec "${BUN}" "${dir}/stub-server.ts"; fi
exit 0
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

const tmuxAvailable = Bun.which("tmux") !== null;
if (!tmuxAvailable) {
  console.warn("[opencode-server.test] SKIPPING tmux-hosted tests: no `tmux` on PATH. Only the direct host is covered.");
}

const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmTestDataDir(DATA_DIR);
  rmTestDataDir(STUB_ROOT);
});

function pidOf(h: Handle): Promise<number> {
  return fetch(`${h.url}/api/info`, { headers: { Authorization: `Basic ${btoa(`opencode:${h.password}`)}` } })
    .then((r) => r.json())
    .then((b) => (b as { pid: number }).pid);
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timed out");
}

function modeOf(p: string): number {
  return statSync(p).mode & 0o777;
}

function suite(host: "direct" | "tmux", skip: boolean): void {
  const d = skip ? describe.skip : describe;
  d(`opencode server manager (${host} host)`, () => {
    const stubDir = path.join(STUB_ROOT, host);
    const bin = writeStub(stubDir);
    const ids = new Set<string>();
    const newId = (): string => {
      const id = `t-${host}-${randomUUID().slice(0, 8)}`;
      ids.add(id);
      return id;
    };
    const spec = (id: string, env: Record<string, string> = {}) => ({
      harnessId: id,
      bin,
      env: { STUB_DIR: stubDir, ...env },
      cwd: STUB_ROOT,
    });
    const launches = (): number => (existsSync(path.join(stubDir, "launches")) ? readFileSync(path.join(stubDir, "launches"), "utf8").split("\n").filter(Boolean).length : 0);

    beforeAll(() => {
      setEnv("AGETOR_OPENCODE_SERVER_HOST", host === "direct" ? "direct" : undefined);
    });
    // Every test gets its own server directory, so none depends on (or can see)
    // another's state files.
    beforeEach(() => {
      __forTest.setServerDir(mkdtempSync(path.join(STUB_ROOT, `${host}-dir-`)));
      rmSync(path.join(stubDir, "slow"), { force: true });
      rmSync(path.join(stubDir, "unauth"), { force: true });
    });
    afterEach(async () => {
      try {
        for (const id of ids) await stopOpencodeServer(id);
      } finally {
        // Reap whatever a failed expect left behind: direct children by
        // pid, tmux sessions by exact name.
        __forTest.reapDirect();
        for (const id of ids) Bun.spawnSync(["tmux", ...tmuxSocketArgs(), "kill-session", "-t", `=${__forTest.sessionNameFor(id)}:`]);
        ids.clear();
        __forTest.forget();
        __forTest.restoreDefaults();
        rmSync(path.join(stubDir, "slow"), { force: true });
        rmSync(path.join(stubDir, "unauth"), { force: true });
        writeFileSync(path.join(stubDir, "launches"), "");
      }
    });

    test("starts a server, health-checks it, and keeps state private", async () => {
      const id = newId();
      const h = await ensureOpencodeServer(spec(id));
      expect(h.harnessId).toBe(id);
      expect(h.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(h.version).toBe("2.1.3-stub");
      expect(h.tmuxSession).toBe(host === "tmux" ? `agetor-ocsrv-${id}` : null);
      expect(Buffer.from(h.password, "base64url").length).toBe(32);
      expect(getOpencodeServer(id)).toBe(h);
      expect(await checkOpencodeServerHealth(h)).toBe(true);
      expect(await checkOpencodeServerHealth({ ...h, password: "wrong" })).toBe(false);

      const state = __forTest.statePath(id);
      expect(modeOf(state)).toBe(0o600);
      expect(modeOf(__forTest.serverDir())).toBe(0o700);
      const saved = JSON.parse(readFileSync(state, "utf8"));
      expect(saved).toMatchObject({ harnessId: id, url: h.url, password: h.password, tmuxSession: h.tmuxSession });
      expect(modeOf(__forTest.logPath(id))).toBe(0o600);
      expect(existsSync(__forTest.envPath(id))).toBe(false); // consumed (or never written)

      // The server got the spec env, the agetor password and the autoupdate default.
      expect(readFileSync(path.join(stubDir, "pw"), "utf8")).toBe(h.password);
      expect(readFileSync(path.join(stubDir, "autoupdate"), "utf8")).toBe("1");
    });

    test("a spec value wins over the autoupdate default", async () => {
      const id = newId();
      await ensureOpencodeServer(spec(id, { OPENCODE_DISABLE_AUTOUPDATE: "0", STUB_EXTRA: "it's \"quoted\" $HOME" }));
      expect(readFileSync(path.join(stubDir, "autoupdate"), "utf8")).toBe("0");
      expect(readFileSync(path.join(stubDir, "extra"), "utf8")).toBe("it's \"quoted\" $HOME");
    });

    test("the password never reaches argv, the log or the state of another file", async () => {
      const id = newId();
      const h = await ensureOpencodeServer(spec(id));
      const argv = readFileSync(path.join(stubDir, "argv.log"), "utf8");
      expect(argv).toContain("serve --hostname 127.0.0.1 --port 0");
      expect(argv).not.toContain(h.password);
      const log = readFileSync(__forTest.logPath(id), "utf8");
      expect(log).toContain("opencode server listening on http://127.0.0.1:");
      expect(log).not.toContain(h.password);
      // No live process carries it in its argv (tmux's own included).
      const ps = Bun.spawnSync(["ps", "-axww", "-o", "args="]).stdout.toString();
      expect(ps.length).toBeGreaterThan(0);
      expect(ps).not.toContain(h.password);
      const files = readdirSync(__forTest.serverDir()).filter((n) => n.startsWith(id));
      for (const f of files) {
        if (f === `${id}.json`) continue;
        expect(readFileSync(path.join(__forTest.serverDir(), f), "utf8")).not.toContain(h.password);
      }
    });

    test.skipIf(host !== "tmux")("no tmux client invocation carries the password in its argv", async () => {
      const real = Bun.which("tmux")!;
      const wrapper = path.join(stubDir, "tmux-wrapper");
      const record = path.join(stubDir, "tmux-argv.log");
      writeFileSync(record, "");
      writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${record}"\nexec "${real}" "$@"\n`);
      chmodSync(wrapper, 0o755);
      setEnv("AGETOR_TMUX_BIN", wrapper);
      try {
        const id = newId();
        const h = await ensureOpencodeServer(spec(id, { STUB_EXTRA: "api-key-value" }));
        const seen = readFileSync(record, "utf8");
        expect(seen).toContain("new-session");
        expect(seen).toContain(`agetor-ocsrv-${id}`);
        expect(seen).not.toContain(h.password);
        expect(seen).not.toContain("OPENCODE_PASSWORD");
        expect(seen).not.toContain("api-key-value"); // the whole server env stays out of argv
        await stopOpencodeServer(id);
      } finally {
        setEnv("AGETOR_TMUX_BIN", savedEnv.AGETOR_TMUX_BIN);
      }
    });

    test("concurrent ensure calls share one launch", async () => {
      const id = newId();
      const results = await Promise.all(Array.from({ length: 6 }, () => ensureOpencodeServer(spec(id))));
      expect(results).toHaveLength(6);
      for (const r of results) expect(r).toBe(results[0]!);
      expect(launches()).toBe(1);
    });

    test("a healthy server is reused, even with the health cache off", async () => {
      __forTest.setHealthCacheMs(0);
      const id = newId();
      const a = await ensureOpencodeServer(spec(id));
      const b = await ensureOpencodeServer(spec(id));
      expect(b).toBe(a);
      expect(launches()).toBe(1);
    });

    test("different harnesses get different servers and passwords", async () => {
      const [a, b] = [newId(), newId()];
      const [ha, hb] = await Promise.all([ensureOpencodeServer(spec(a)), ensureOpencodeServer(spec(b))]);
      expect(ha.url).not.toBe(hb.url);
      expect(ha.password).not.toBe(hb.password);
      expect(launches()).toBe(2);
    });

    test("a dead server is replaced by a fresh one", async () => {
      __forTest.setHealthCacheMs(0);
      const id = newId();
      const first = await ensureOpencodeServer(spec(id));
      process.kill(await pidOf(first), "SIGKILL");
      await waitFor(async () => !(await checkOpencodeServerHealth(first, 300)));
      const second = await ensureOpencodeServer(spec(id));
      expect(second.url).not.toBe(first.url);
      expect(second.password).not.toBe(first.password);
      expect(await checkOpencodeServerHealth(second)).toBe(true);
      expect(launches()).toBe(2);
      expect(JSON.parse(readFileSync(__forTest.statePath(id), "utf8")).password).toBe(second.password);
    });

    const slowOn = (ms: number): void => writeFileSync(path.join(stubDir, "slow"), String(ms));
    const slowOff = (): void => rmSync(path.join(stubDir, "slow"), { force: true });
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    test("a stopped server is really gone: its process dies and, under tmux, the session too", async () => {
      const id = newId();
      const h = await ensureOpencodeServer(spec(id));
      const pid = await pidOf(h);
      if (host === "tmux") {
        // `exec` in the inner script makes the pane's pid the server itself;
        // without it the pane is a `sh` wrapper and signals miss the server.
        const panes = Bun.spawnSync(["tmux", ...tmuxSocketArgs(), "list-panes", "-t", `=${h.tmuxSession}:`, "-F", "#{pane_pid}"]);
        expect(Number(panes.stdout.toString().trim())).toBe(pid);
        expect(await __forTest.tmuxHasSession(h.tmuxSession!)).toBe("alive");
      }
      await stopOpencodeServer(id);
      expect(alive(pid)).toBe(false);
      if (host === "tmux") {
        expect(await __forTest.tmuxHasSession(h.tmuxSession!)).toBe("gone");
        const has = Bun.spawnSync(["tmux", ...tmuxSocketArgs(), "has-session", "-t", `=${h.tmuxSession}:`]);
        expect(has.exitCode).toBe(1);
      }
    });

    describe("a planted state file never makes agetor signal a foreign pid", () => {
      const plant = (id: string, pid: number, url: string): void => {
        mkdirSync(__forTest.serverDir(), { recursive: true, mode: 0o700 });
        writeFileSync(
          __forTest.statePath(id),
          JSON.stringify({
            harnessId: id,
            url,
            password: "planted-password",
            tmuxSession: host === "tmux" ? __forTest.sessionNameFor(id) : null,
            startedAt: 1,
            hostPid: pid,
          }),
          { mode: 0o600 },
        );
      };
      const withSacrificial = async (fn: (pid: number) => Promise<void>): Promise<void> => {
        const sac = Bun.spawn(["sleep", "120"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        try {
          await fn(sac.pid);
          expect(alive(sac.pid)).toBe(true);
          expect(sac.exitCode).toBeNull();
        } finally {
          sac.kill("SIGKILL");
          await sac.exited;
        }
      };

      test("adoption of a never-healthy or refused state leaves the pid alone, and does not wait out the grace", async () => {
        await withSacrificial(async (pid) => {
          const [a, b] = [newId(), newId()];
          plant(a, pid, "");
          plant(b, pid, "http://127.0.0.1:9");
          const t0 = Date.now();
          expect(await adoptOpencodeServers()).toEqual([]);
          expect(Date.now() - t0).toBeLessThan(1_500);
          expect(existsSync(__forTest.statePath(a))).toBe(false);
          expect(existsSync(__forTest.statePath(b))).toBe(false);
        });
      });

      test("stop and ensure over a planted state leave the pid alone", async () => {
        await withSacrificial(async (pid) => {
          const [a, b] = [newId(), newId()];
          plant(a, pid, "http://127.0.0.1:9");
          await stopOpencodeServer(a);
          plant(b, pid, "http://127.0.0.1:9");
          const h = await ensureOpencodeServer(spec(b));
          expect(await checkOpencodeServerHealth(h)).toBe(true);
          expect(h.password).not.toBe("planted-password");
        });
      });

      test.skipIf(host !== "tmux")("a null tmux session outside the direct host is refused as planted", async () => {
        await withSacrificial(async (pid) => {
          // A copy of a live, healthy server's state with the session nulled:
          // the only thing wrong with it is the null.
          const id = newId();
          await ensureOpencodeServer(spec(id));
          const state = JSON.parse(readFileSync(__forTest.statePath(id), "utf8"));
          writeFileSync(__forTest.statePath(id), JSON.stringify({ ...state, tmuxSession: null, hostPid: pid }), { mode: 0o600 });
          __forTest.forget();
          expect(await adoptOpencodeServers()).toEqual([]);
          expect(getOpencodeServer(id)).toBeNull();
          expect(existsSync(__forTest.statePath(id))).toBe(false);
        });
      });
    });

    describe("a live but slow server is never destroyed (I3)", () => {
      test("adoption keeps a server whose info times out, state intact", async () => {
        __forTest.setHealthCacheMs(0);
        const id = newId();
        const h = await ensureOpencodeServer(spec(id));
        const pid = await pidOf(h);
        const stateBefore = readFileSync(__forTest.statePath(id), "utf8");
        __forTest.setHealthTimeoutMs(200);
        slowOn(1_500);
        __forTest.forget();

        const adopted = await adoptOpencodeServers();
        expect(adopted.map((a) => a.harnessId)).toEqual([id]);
        expect(getOpencodeServer(id)?.url).toBe(h.url);
        expect(readFileSync(__forTest.statePath(id), "utf8")).toBe(stateBefore);
        expect(alive(pid)).toBe(true);
        if (host === "tmux") expect(await __forTest.tmuxHasSession(h.tmuxSession!)).toBe("alive");

        // ensure refuses to replace it...
        await expect(ensureOpencodeServer(spec(id))).rejects.toThrow(/not responding/);
        expect(alive(pid)).toBe(true);
        expect(launches()).toBe(1);
        // ...and reuses it as soon as it answers.
        slowOff();
        const again = await ensureOpencodeServer(spec(id));
        expect(again.url).toBe(h.url);
        expect(launches()).toBe(1);
      });

      test("ensure on a running server that stops answering throws instead of replacing it", async () => {
        __forTest.setHealthCacheMs(0);
        const id = newId();
        const h = await ensureOpencodeServer(spec(id));
        const pid = await pidOf(h);
        __forTest.setHealthTimeoutMs(200);
        slowOn(1_500);
        await expect(ensureOpencodeServer(spec(id))).rejects.toThrow(/not responding/);
        expect(alive(pid)).toBe(true);
        expect(getOpencodeServer(id)).toBe(h);
        expect(existsSync(__forTest.statePath(id))).toBe(true);
        expect(launches()).toBe(1);
        slowOff();
        expect(await ensureOpencodeServer(spec(id))).toBe(h);
      });

      test.skipIf(host !== "tmux")("a failed tmux call is not proof the server is gone", async () => {
        __forTest.setHealthCacheMs(0);
        const id = newId();
        const h = await ensureOpencodeServer(spec(id));
        const pid = await pidOf(h);
        const real = Bun.which("tmux")!;
        const wrapper = path.join(stubDir, "tmux-failing");
        writeFileSync(wrapper, `#!/bin/sh\ncase "$*" in *has-session*) echo "server exited unexpectedly" >&2; exit 2;; esac\nexec "${real}" "$@"\n`);
        chmodSync(wrapper, 0o755);
        __forTest.setHealthTimeoutMs(200);
        slowOn(1_500);
        __forTest.forget();
        setEnv("AGETOR_TMUX_BIN", wrapper);
        try {
          const adopted = await adoptOpencodeServers();
          expect(adopted.map((a) => a.harnessId)).toEqual([id]);
          expect(existsSync(__forTest.statePath(id))).toBe(true);
          expect(alive(pid)).toBe(true);
        } finally {
          setEnv("AGETOR_TMUX_BIN", savedEnv.AGETOR_TMUX_BIN);
        }
        expect(await __forTest.tmuxHasSession(h.tmuxSession!)).toBe("alive");
      });

      test("a server that rejects our password is provably not ours and is cleaned up", async () => {
        const id = newId();
        const h = await ensureOpencodeServer(spec(id));
        const pid = await pidOf(h);
        const state = JSON.parse(readFileSync(__forTest.statePath(id), "utf8"));
        writeFileSync(__forTest.statePath(id), JSON.stringify({ ...state, password: "not-the-password" }), { mode: 0o600 });
        __forTest.forget();
        expect(await adoptOpencodeServers()).toEqual([]);
        expect(existsSync(__forTest.statePath(id))).toBe(false);
        await waitFor(() => !alive(pid));
      });
    });

    describe("health never kills a busy server (I3)", () => {
      const reset = (): Promise<Response> => Promise.reject(Object.assign(new Error("socket closed"), { code: "ECONNRESET" }));
      const refused = (): Promise<Response> => Promise.reject(Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" }));

      test("a connection reset against a live host is neither adopted-away nor replaced", async () => {
        __forTest.setHealthCacheMs(0);
        const id = newId();
        const h = await ensureOpencodeServer(spec(id));
        const pid = await pidOf(h);
        const stateBefore = readFileSync(__forTest.statePath(id), "utf8");
        __forTest.forget();
        __forTest.setFetchImpl(reset as unknown as typeof fetch);

        expect((await adoptOpencodeServers()).map((a) => a.harnessId)).toEqual([id]);
        expect(readFileSync(__forTest.statePath(id), "utf8")).toBe(stateBefore);
        for (const isBusy of [() => true, () => false, undefined]) {
          await expect(ensureOpencodeServer({ ...spec(id), isBusy })).rejects.toThrow(/not responding/);
        }
        expect(alive(pid)).toBe(true);
        expect(launches()).toBe(1);
        expect(getOpencodeServer(id)?.url).toBe(h.url);
        __forTest.setFetchImpl(null);
        expect((await ensureOpencodeServer(spec(id))).url).toBe(h.url);
      });

      test("a refused connection is dead, but a busy turn still blocks the restart", async () => {
        __forTest.setHealthCacheMs(0);
        const id = newId();
        const h = await ensureOpencodeServer(spec(id));
        const pid = await pidOf(h);
        __forTest.setFetchImpl(refused as unknown as typeof fetch);
        await expect(ensureOpencodeServer({ ...spec(id), isBusy: () => true })).rejects.toThrow(/not responding/);
        await expect(ensureOpencodeServer({ ...spec(id), isBusy: () => { throw new Error("no gate"); } })).rejects.toThrow(/not responding/);
        expect(alive(pid)).toBe(true);
        expect(launches()).toBe(1);
        // Idle: the same proof replaces it.
        __forTest.setFetchImpl(null);
        const live = await ensureOpencodeServer(spec(id)); // still the same, healthy server
        expect(live.url).toBe(h.url);
        // Only the first probe is refused; the replacement's own probes must go through.
        let n = 0;
        __forTest.setFetchImpl(((...a: Parameters<typeof fetch>) => (n++ < 1 ? refused() : fetch(...a))) as typeof fetch);
        const next = await ensureOpencodeServer({ ...spec(id), isBusy: () => false });
        expect(next.url).not.toBe(h.url);
        expect(launches()).toBe(2);
      });

      test("a single 401 is re-probed, a persistent one is proof", async () => {
        __forTest.setHealthCacheMs(0);
        const id = newId();
        const h = await ensureOpencodeServer(spec(id));
        let n = 0;
        __forTest.setFetchImpl(((...a: Parameters<typeof fetch>) => (n++ < 1 ? Promise.resolve(new Response("no", { status: 401 })) : fetch(...a))) as typeof fetch);
        expect((await ensureOpencodeServer(spec(id))).url).toBe(h.url); // transient 401: kept
        expect(launches()).toBe(1);

        const pid = await pidOf(h);
        writeFileSync(path.join(stubDir, "unauth"), "");
        __forTest.setFetchImpl(null);
        await expect(ensureOpencodeServer({ ...spec(id), isBusy: () => true })).rejects.toThrow(/not responding/);
        expect(alive(pid)).toBe(true);
      });
    });

    describe("a quit that cannot await", () => {
      test("stopIdleOpencodeServersSync stops idle servers before it returns, never a busy one", async () => {
        const [idle, working, gate] = [newId(), newId(), newId()];
        const hi = await ensureOpencodeServer(spec(idle));
        const hw = await ensureOpencodeServer(spec(working));
        const hg = await ensureOpencodeServer(spec(gate));
        const idlePid = await pidOf(hi);
        const stopped = stopIdleOpencodeServersSync((hid) => {
          if (hid === working) return true;
          if (hid === gate) throw new Error("gate unavailable");
          return false;
        });
        // Synchronous effects: already visible with no await in between.
        expect(stopped).toEqual([idle]);
        expect(getOpencodeServer(idle)).toBeNull();
        expect(existsSync(__forTest.statePath(idle))).toBe(false);
        expect(existsSync(__forTest.logPath(idle))).toBe(false);
        await waitFor(() => !alive(idlePid));
        if (host === "tmux") expect(await __forTest.tmuxHasSession(hi.tmuxSession!)).toBe("gone");
        expect(await checkOpencodeServerHealth(hw)).toBe(true);
        expect(await checkOpencodeServerHealth(hg)).toBe(true);
        expect(existsSync(__forTest.statePath(working))).toBe(true);
        expect(stopIdleOpencodeServersSync(() => false).sort()).toEqual([gate, working].sort());
      });

      test.skipIf(host !== "tmux")("a broken tmux never makes it throw", async () => {
        const id = newId();
        await ensureOpencodeServer(spec(id));
        setEnv("AGETOR_TMUX_BIN", path.join(STUB_ROOT, "no-such-tmux"));
        try {
          expect(stopIdleOpencodeServersSync(() => false)).toEqual([id]);
        } finally {
          setEnv("AGETOR_TMUX_BIN", savedEnv.AGETOR_TMUX_BIN);
        }
      });
    });

    describe("adoption is parallel and bounded", () => {
      test("slow servers are judged concurrently, not one after another", async () => {
        __forTest.setHealthCacheMs(0);
        const ids = [newId(), newId(), newId()];
        const hs = await Promise.all(ids.map((id) => ensureOpencodeServer(spec(id))));
        const pids = await Promise.all(hs.map(pidOf));
        __forTest.setHealthTimeoutMs(250); // each judgement: 250 + 500 ms
        slowOn(2_000);
        __forTest.forget();
        const t0 = Date.now();
        const adopted = await adoptOpencodeServers();
        const took = Date.now() - t0;
        expect(adopted.map((a) => a.harnessId).sort()).toEqual([...ids].sort());
        expect(took).toBeLessThan(1_300); // serial would be >= 2.25 s
        for (const id of ids) expect(existsSync(__forTest.statePath(id))).toBe(true);
        for (const pid of pids) expect(alive(pid)).toBe(true);
      });

      test("a server undecided at the budget is kept unhealthy, and a late verdict cannot kill it", async () => {
        __forTest.setHealthCacheMs(0);
        const id = newId();
        const h = await ensureOpencodeServer(spec(id));
        const pid = await pidOf(h);
        const stateBefore = readFileSync(__forTest.statePath(id), "utf8");
        // Slow, then a persistent 401 (two answers of 300 ms each): judged
        // "dead", but only after ~600 ms, well past the 150 ms budget.
        __forTest.setHealthTimeoutMs(400);
        writeFileSync(path.join(stubDir, "unauth"), "");
        slowOn(300);
        __forTest.setAdoptBudgetMs(150);
        __forTest.forget();
        const adopted = await adoptOpencodeServers();
        expect(adopted.map((a) => a.harnessId)).toEqual([id]);
        await new Promise((r) => setTimeout(r, 1_800)); // let the late verdict land
        expect(alive(pid)).toBe(true);
        expect(readFileSync(__forTest.statePath(id), "utf8")).toBe(stateBefore);
        expect(getOpencodeServer(id)?.url).toBe(h.url);
      });
    });

    test("stop never acts on a state file that names another harness's server", async () => {
      const [victim, other] = [newId(), newId()];
      const hv = await ensureOpencodeServer(spec(victim));
      const pid = await pidOf(hv);
      mkdirSync(__forTest.serverDir(), { recursive: true, mode: 0o700 });
      writeFileSync(__forTest.statePath(other), readFileSync(__forTest.statePath(victim), "utf8"), { mode: 0o600 });
      await stopOpencodeServer(other);
      expect(existsSync(__forTest.statePath(other))).toBe(false);
      expect(alive(pid)).toBe(true);
      expect(await checkOpencodeServerHealth(hv)).toBe(true);
      expect(existsSync(__forTest.statePath(victim))).toBe(true);
    });

    describe("a changed launch (bin, env, cwd) is noticed", () => {
      test("an idle server is restarted on the new settings", async () => {
        const id = newId();
        const a = await ensureOpencodeServer(spec(id, { STUB_EXTRA: "one" }));
        const same = await ensureOpencodeServer(spec(id, { STUB_EXTRA: "one" }));
        expect(same).toBe(a);
        expect(same.stale).toBeUndefined();
        const b = await ensureOpencodeServer({ ...spec(id, { STUB_EXTRA: "two" }), isBusy: () => false });
        expect(b.url).not.toBe(a.url);
        expect(b.stale).toBeUndefined();
        expect(readFileSync(path.join(stubDir, "extra"), "utf8")).toBe("two");
        expect(launches()).toBe(2);
        expect(await checkOpencodeServerHealth(a, 300)).toBe(false);
        // Only the digest is stored, never the env values.
        const raw = readFileSync(__forTest.statePath(id), "utf8");
        expect(JSON.parse(raw).fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(raw).not.toContain("two");
      });

      test("a busy server is kept and the handle says it is stale", async () => {
        const id = newId();
        const a = await ensureOpencodeServer(spec(id, { STUB_EXTRA: "one" }));
        const kept = await ensureOpencodeServer({ ...spec(id, { STUB_EXTRA: "two" }), isBusy: () => true });
        expect(kept.stale).toBe(true);
        expect(kept.url).toBe(a.url);
        expect(kept.password).toBe(a.password);
        const unsure = await ensureOpencodeServer({ ...spec(id, { STUB_EXTRA: "two" }), isBusy: () => { throw new Error("no gate"); } });
        expect(unsure.stale).toBe(true);
        expect(launches()).toBe(1);
        expect(await checkOpencodeServerHealth(a)).toBe(true);
        // Once idle, the same request restarts it.
        const fresh = await ensureOpencodeServer({ ...spec(id, { STUB_EXTRA: "two" }), isBusy: () => false });
        expect(fresh.url).not.toBe(a.url);
        expect(fresh.stale).toBeUndefined();
      });

      test("a changed cwd counts, and so does an adopted server's launch", async () => {
        const id = newId();
        const a = await ensureOpencodeServer(spec(id));
        __forTest.forget();
        await adoptOpencodeServers();
        const moved = await ensureOpencodeServer({ ...spec(id), cwd: mkdtempSync(path.join(STUB_ROOT, "cwd-")) });
        expect(moved.url).not.toBe(a.url);
        expect(launches()).toBe(2);
      });
    });

    describe("state file hygiene", () => {
      const planted = (id: string): { harnessId: string; url: string; password: string; tmuxSession: null; startedAt: number } => ({
        harnessId: id,
        url: "http://127.0.0.1:9",
        password: "planted-password",
        tmuxSession: null,
        startedAt: 1,
      });

      /** A healthy server whose state file would be adopted if it were trusted. */
      async function liveServer(id: string): Promise<{ h: Handle; pid: number; json: string }> {
        const h = await ensureOpencodeServer(spec(id));
        const pid = await pidOf(h);
        const json = readFileSync(__forTest.statePath(id), "utf8");
        __forTest.forget(); // a new core
        return { h, pid, json };
      }
      const reap = (pid: number): void => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      };

      test("a state file broader than 0600 is refused, not adopted", async () => {
        const id = newId();
        const { h, pid } = await liveServer(id);
        chmodSync(__forTest.statePath(id), 0o644);
        const next = await ensureOpencodeServer(spec(id));
        expect(next.password).not.toBe(h.password);
        expect(launches()).toBe(2);
        expect(modeOf(__forTest.statePath(id))).toBe(0o600);
        reap(pid);
      });

      test("a symlinked state file is not followed", async () => {
        const id = newId();
        const { h, pid, json } = await liveServer(id);
        const target = path.join(STUB_ROOT, `target-${id}.json`);
        writeFileSync(target, json, { mode: 0o600 });
        unlinkSync(__forTest.statePath(id));
        symlinkSync(target, __forTest.statePath(id));
        const next = await ensureOpencodeServer(spec(id));
        expect(next.password).not.toBe(h.password);
        expect(launches()).toBe(2);
        expect(readFileSync(target, "utf8")).toBe(json); // untouched
        expect(statSync(__forTest.statePath(id)).isFile()).toBe(true);
        expect(lstatSync(__forTest.statePath(id)).isSymbolicLink()).toBe(false);
        expect(modeOf(__forTest.statePath(id))).toBe(0o600);
        reap(pid);
      });

      test("a state file for another harness id is refused", async () => {
        const id = newId();
        const other = newId();
        const { h, pid, json } = await liveServer(id);
        writeFileSync(__forTest.statePath(other), json, { mode: 0o600 }); // filed under the wrong name
        const next = await ensureOpencodeServer(spec(other));
        expect(next.password).not.toBe(h.password);
        expect(launches()).toBe(2);
        reap(pid);
      });

      test("garbage and a non-loopback url are regenerated", async () => {
        const a = newId();
        const b = newId();
        mkdirSync(__forTest.serverDir(), { recursive: true, mode: 0o700 });
        writeFileSync(__forTest.statePath(a), "{not json", { mode: 0o600 });
        writeFileSync(__forTest.statePath(b), JSON.stringify({ ...planted(b), url: "http://evil.example:80" }), { mode: 0o600 });
        const [ha, hb] = await Promise.all([ensureOpencodeServer(spec(a)), ensureOpencodeServer(spec(b))]);
        expect(ha.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
        expect(hb.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
      });
    });

    test("adopt keeps a healthy server and cleans a dead one", async () => {
      const [live, dead, crashed] = [newId(), newId(), newId()];
      const hl = await ensureOpencodeServer(spec(live));
      const hd = await ensureOpencodeServer(spec(dead));
      process.kill(await pidOf(hd), "SIGKILL");
      await waitFor(async () => !(await checkOpencodeServerHealth(hd, 300)));
      // A start that never became healthy leaves an empty-url state.
      writeFileSync(
        __forTest.statePath(crashed),
        JSON.stringify({ harnessId: crashed, url: "", password: "x", tmuxSession: host === "tmux" ? __forTest.sessionNameFor(crashed) : null, startedAt: 1 }),
        { mode: 0o600 },
      );
      __forTest.forget(); // a new core: nothing in memory

      const adopted = await adoptOpencodeServers();
      expect(adopted.map((a) => a.harnessId)).toEqual([live]);
      expect(adopted[0]).toMatchObject({ url: hl.url, password: hl.password });
      expect(getOpencodeServer(live)?.url).toBe(hl.url);
      expect(getOpencodeServer(dead)).toBeNull();
      expect(existsSync(__forTest.statePath(dead))).toBe(false);
      expect(existsSync(__forTest.statePath(crashed))).toBe(false);
      expect(await checkOpencodeServerHealth(hl)).toBe(true);
      expect(launches()).toBe(2); // adoption never launches
    });

    test("an adopted server is reused by ensure, not relaunched", async () => {
      const id = newId();
      const h = await ensureOpencodeServer(spec(id));
      __forTest.forget();
      await adoptOpencodeServers();
      const again = await ensureOpencodeServer(spec(id));
      expect(again.url).toBe(h.url);
      expect(launches()).toBe(1);
    });

    test("the idle sweep stops only idle servers that are not busy", async () => {
      __forTest.setIdleMs(1_000);
      const id = newId();
      const h = await ensureOpencodeServer(spec(id));
      const t0 = Date.now();
      noteOpencodeActivity(id, t0);
      expect(await opencodeIdleSweep(t0 + 999, () => false)).toEqual([]);
      expect(await opencodeIdleSweep(t0 + 5_000, () => true)).toEqual([]);
      expect(await opencodeIdleSweep(t0 + 5_000, () => { throw new Error("gate unavailable"); })).toEqual([]);
      expect(await checkOpencodeServerHealth(h)).toBe(true);
      // Fresh activity keeps it alive.
      noteOpencodeActivity(id, t0 + 5_000);
      expect(await opencodeIdleSweep(t0 + 5_500, () => false)).toEqual([]);

      expect(await opencodeIdleSweep(t0 + 6_000, (hid) => hid !== id)).toEqual([id]);
      expect(getOpencodeServer(id)).toBeNull();
      expect(existsSync(__forTest.statePath(id))).toBe(false);
      expect(existsSync(__forTest.logPath(id))).toBe(false);
      await waitFor(async () => !(await checkOpencodeServerHealth(h, 300)));
    });

    test("the default idle window is 30 minutes", () => {
      expect(OPENCODE_SERVER_IDLE_MS).toBe(30 * 60_000);
    });

    test("stop kills the server, removes its files, and is idempotent", async () => {
      const id = newId();
      const h = await ensureOpencodeServer(spec(id));
      await Promise.all([stopOpencodeServer(id), stopOpencodeServer(id)]);
      await stopOpencodeServer(id);
      await stopOpencodeServer(newId()); // unknown id
      expect(getOpencodeServer(id)).toBeNull();
      expect(existsSync(__forTest.statePath(id))).toBe(false);
      expect(existsSync(__forTest.logPath(id))).toBe(false);
      await waitFor(async () => !(await checkOpencodeServerHealth(h, 300)));
    });

    test("ensure after stop starts a new server", async () => {
      const id = newId();
      const a = await ensureOpencodeServer(spec(id));
      const stop = stopOpencodeServer(id);
      const b = await ensureOpencodeServer(spec(id)); // queued behind the stop
      await stop;
      expect(b.url).not.toBe(a.url);
      expect(await checkOpencodeServerHealth(b)).toBe(true);
    });

    test("a server that exits at start fails with the log tail and leaves nothing behind", async () => {
      const id = newId();
      let err: Error | undefined;
      await ensureOpencodeServer(spec(id, { STUB_MODE: "exit" })).catch((e) => { err = e as Error; });
      expect(err?.message).toContain("OpenCode server failed to start");
      expect(err?.message).toContain("boom: cannot open database");
      expect(getOpencodeServer(id)).toBeNull();
      expect(existsSync(__forTest.statePath(id))).toBe(false);
      // The next ensure retries cleanly.
      const h = await ensureOpencodeServer(spec(id));
      expect(await checkOpencodeServerHealth(h)).toBe(true);
    });

    test("the password is redacted from a failed start's error", async () => {
      const id = newId();
      let err: Error | undefined;
      await ensureOpencodeServer(spec(id, { STUB_MODE: "leak" })).catch((e) => { err = e as Error; });
      const pw = readFileSync(path.join(stubDir, "pw"), "utf8");
      expect(pw.length).toBeGreaterThan(20);
      expect(err?.message).toContain("failed to start");
      expect(err?.message).toContain("[redacted]");
      expect(err?.message).not.toContain(pw);
    });

    test("a server that never listens times out and is cleaned up", async () => {
      __forTest.setStartBudgetMs(800);
      const id = newId();
      let err: Error | undefined;
      await ensureOpencodeServer(spec(id, { STUB_MODE: "silent" })).catch((e) => { err = e as Error; });
      expect(err?.message).toContain("did not report a listening address");
      expect(getOpencodeServer(id)).toBeNull();
      expect(existsSync(__forTest.statePath(id))).toBe(false);
      // The server really died (not left for afterEach to reap).
      const pid = Number(readFileSync(path.join(stubDir, "pid"), "utf8"));
      expect(pid).toBeGreaterThan(1);
      await waitFor(() => !alive(pid));
      if (host === "tmux") expect(await __forTest.tmuxHasSession(__forTest.sessionNameFor(id))).toBe("gone");
    });
  });
}

describe("id handling", () => {
  test("filenames and session names only ever contain [A-Za-z0-9_-]", () => {
    expect(__forTest.safeId("opencode")).toBe("opencode");
    for (const raw of ["../../etc/passwd", "a b", "x/y", "ünï", "", "a".repeat(200)]) {
      expect(__forTest.safeId(raw)).toMatch(/^[A-Za-z0-9_-]{1,80}$/);
    }
    expect(__forTest.safeId("a.b")).not.toBe(__forTest.safeId("a_b"));
  });

  test("redact removes the password and password-looking text", () => {
    const out = __forTest.redact("server password abc123 OPENCODE_PASSWORD=zzz Authorization: Basic Zm9v hi sekret!", "sekret!");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("zzz");
    expect(out).not.toContain("Zm9v");
    expect(out).not.toContain("sekret!");
  });
});

suite("direct", false);
suite("tmux", !tmuxAvailable);
