import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
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
  noteOpencodeServerLost,
  classifyOpencodeServer,
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
      if (fs.existsSync(dir + "/slow")) {
        // A barrier for tests: the manager is inside this (slow) request now.
        fs.writeFileSync(dir + "/probed", u.pathname);
        await Bun.sleep(Number(fs.readFileSync(dir + "/slow", "utf8")));
      }
      if (fs.existsSync(dir + "/unauth")) return new Response("no", { status: 401 });
      if (req.headers.get("authorization") !== "Basic " + btoa("opencode:" + pw)) return new Response("no", { status: 401 });
      if (u.pathname === "/api/session/active") {
        if (fs.existsSync(dir + "/active-fail")) return Response.json({ _tag: "InternalError", message: "boom" }, { status: 500 });
        return Response.json({ data: fs.existsSync(dir + "/active") ? { ses_busy: { type: "running" } } : {} });
      }
      if (u.pathname !== "/api/info") return new Response("not found", { status: 404 });
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

// `bun test` runs every file in ONE process, and about forty sibling files set
// `AGETOR_TMUX_BIN=/bin/echo` at their top level and never restore it. Left in
// place, `has-session` "succeeds" forever (every start/stop burns its grace
// windows, so even the direct host overruns the test timeout) and `new-session`
// starts nothing. So this file pins its own tmux seams for its whole run: the
// real tmux (no override) on a socket of its own, which also keeps a sibling's
// `kill-server` on the shared `agetor-test` socket from reaching these sessions.
// Tests that swap in a wrapper put it back with `useRealTmux()`, never with the
// value `savedEnv` captured (that may be the leak).
const OWN_TMUX_SOCKET = `agetor-test-ocsrv-${process.pid}`;
function useRealTmux(): void {
  setEnv("AGETOR_TMUX_BIN", undefined);
}
beforeAll(() => {
  useRealTmux();
  setEnv("AGETOR_TMUX_SOCKET", OWN_TMUX_SOCKET);
  setEnv("AGETOR_DISCLAIM_BIN", undefined);
});

afterAll(() => {
  if (tmuxAvailable) {
    Bun.spawnSync(["tmux", "-L", OWN_TMUX_SOCKET, "kill-server"], { stdout: "ignore", stderr: "ignore" });
    // The server is gone but tmux leaves its socket file; one per run would pile up.
    rmSync(path.join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`, OWN_TMUX_SOCKET), { force: true });
  }
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
    const MARKERS = ["slow", "unauth", "probed", "active", "active-fail"];
    beforeEach(() => {
      __forTest.setServerDir(mkdtempSync(path.join(STUB_ROOT, `${host}-dir-`)));
      for (const m of MARKERS) rmSync(path.join(stubDir, m), { force: true });
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
        for (const m of MARKERS) rmSync(path.join(stubDir, m), { force: true });
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
        useRealTmux();
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

    test("a server the hub lost is probed again within the health-cache window, and replaced when dead", async () => {
      __forTest.setHealthCacheMs(60_000);
      const id = newId();
      const first = await ensureOpencodeServer(spec(id));
      process.kill(await pidOf(first), "SIGKILL");
      await waitFor(async () => !(await checkOpencodeServerHealth(first, 300)));
      // Still inside the cache window: without the lost note the dead url is handed out again.
      expect((await ensureOpencodeServer(spec(id))).url).toBe(first.url);
      noteOpencodeServerLost(id);
      expect(getOpencodeServer(id)?.url).toBe(first.url); // the note stops nothing by itself
      const second = await ensureOpencodeServer(spec(id));
      expect(second.url).not.toBe(first.url);
      expect(await checkOpencodeServerHealth(second)).toBe(true);
      noteOpencodeServerLost(newId()); // unknown harness: a no-op
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
          useRealTmux();
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

      test.skipIf(host !== "tmux")("a broken tmux never makes it throw and loses nothing (N7)", async () => {
        const id = newId();
        const h = await ensureOpencodeServer(spec(id));
        setEnv("AGETOR_TMUX_BIN", path.join(STUB_ROOT, "no-such-tmux"));
        try {
          // The kill failed: the server is not reported stopped, still registered,
          // and its state, env and log stay for the next boot to judge.
          expect(stopIdleOpencodeServersSync(() => false)).toEqual([]);
        } finally {
          useRealTmux();
        }
        expect(getOpencodeServer(id)).toBe(h);
        expect(existsSync(__forTest.statePath(id))).toBe(true);
        expect(existsSync(__forTest.logPath(id))).toBe(true);
        expect(await checkOpencodeServerHealth(h)).toBe(true);
        // With tmux back, the same call really stops it and removes the files.
        expect(stopIdleOpencodeServersSync(() => false)).toEqual([id]);
        expect(existsSync(__forTest.statePath(id))).toBe(false);
        expect(existsSync(__forTest.logPath(id))).toBe(false);
      });

      test.skipIf(host !== "tmux")("a kill-session that times out keeps the state file (N7)", async () => {
        const id = newId();
        await ensureOpencodeServer(spec(id));
        const wrapper = path.join(stubDir, "tmux-hang-kill");
        writeFileSync(wrapper, `#!/bin/sh\ncase "$*" in *kill-session*) exec sleep 30;; esac\nexec "${Bun.which("tmux")}" "$@"\n`);
        chmodSync(wrapper, 0o755);
        setEnv("AGETOR_TMUX_BIN", wrapper);
        __forTest.setSyncTmuxTimeoutMs(300);
        try {
          expect(stopIdleOpencodeServersSync(() => false)).toEqual([]);
        } finally {
          useRealTmux();
        }
        expect(existsSync(__forTest.statePath(id))).toBe(true);
        expect(getOpencodeServer(id)).not.toBeNull();
      });

      test.skipIf(host !== "tmux")("a session that is already gone counts as stopped and its files go", async () => {
        const id = newId();
        const h = await ensureOpencodeServer(spec(id));
        Bun.spawnSync(["tmux", ...tmuxSocketArgs(), "kill-session", "-t", `=${h.tmuxSession}:`]);
        expect(stopIdleOpencodeServersSync(() => false)).toEqual([id]);
        expect(existsSync(__forTest.statePath(id))).toBe(false);
      });
    });

    describe("the server directory is re-verified before every write and unlink (S12)", () => {
      /** Move the real dir aside and put a symlink to `evil` in its place. */
      function swapForSymlink(id: string): { evil: string; decoys: Map<string, string> } {
        const dir = __forTest.serverDir();
        const evil = mkdtempSync(path.join(STUB_ROOT, "evil-"));
        const decoys = new Map<string, string>();
        for (const ext of ["json", "env", "log"]) {
          const f = path.join(evil, `${id}.${ext}`);
          writeFileSync(f, `decoy-${ext}`);
          decoys.set(f, `decoy-${ext}`);
        }
        renameSync(dir, `${dir}.moved`);
        symlinkSync(evil, dir);
        return { evil, decoys };
      }
      const untouched = (evil: string, decoys: Map<string, string>): void => {
        expect(readdirSync(evil).sort()).toEqual([...decoys.keys()].map((f) => path.basename(f)).sort());
        for (const [f, content] of decoys) expect(readFileSync(f, "utf8")).toBe(content);
      };

      test("a symlinked dir swapped in after ensure: stopOpencodeServer still stops the server but unlinks nothing through the link", async () => {
        const id = newId();
        const h = await ensureOpencodeServer(spec(id));
        const pid = await pidOf(h);
        const { evil, decoys } = swapForSymlink(id);
        await stopOpencodeServer(id);
        expect(alive(pid)).toBe(false);
        expect(getOpencodeServer(id)).toBeNull();
        untouched(evil, decoys);
      });

      test("the sync quit stop likewise unlinks nothing through the link", async () => {
        const id = newId();
        await ensureOpencodeServer(spec(id));
        const { evil, decoys } = swapForSymlink(id);
        expect(stopIdleOpencodeServersSync(() => false)).toEqual([id]);
        untouched(evil, decoys);
      });

      test("a write into a swapped dir is refused", async () => {
        const id = newId();
        await ensureOpencodeServer(spec(id));
        const { evil, decoys } = swapForSymlink(id);
        expect(() => __forTest.writePrivateFile(path.join(__forTest.serverDir(), `${id}.json`), "{}")).toThrow(/plain directory|resolves somewhere else/);
        untouched(evil, decoys);
      });

      test("a start whose dir is swapped mid-start fails without writing or unlinking through the link, and stops the server it launched (SF6)", async () => {
        __forTest.setStartBudgetMs(8_000);
        const id = newId();
        rmSync(path.join(stubDir, "pid"), { force: true });
        // Hold the start in its health probe (a slow /api/info) and swap only
        // once the stub reports the probe is in flight: the manager is then
        // past every log read, so the swap lands right before the final state
        // write, however loaded the machine is.
        slowOn(700);
        try {
          const pending = ensureOpencodeServer(spec(id)).then(() => null, (e: Error) => e);
          await waitFor(() => existsSync(path.join(stubDir, "probed")), 10_000);
          const pid = Number(readFileSync(path.join(stubDir, "pid"), "utf8"));
          expect(pid).toBeGreaterThan(1);
          const { evil, decoys } = swapForSymlink(id);
          const err = await pending;
          expect(err).toBeInstanceOf(Error);
          expect(String(err?.message)).toMatch(/directory/); // the dir check refused, not a timeout
          untouched(evil, decoys);
          expect(getOpencodeServer(id)).toBeNull();
          // The launched server did not outlive the failed start.
          expect(alive(pid)).toBe(false);
          if (host === "tmux") expect(await __forTest.tmuxHasSession(__forTest.sessionNameFor(id))).toBe("gone");
        } finally {
          slowOff();
        }
      }, 30_000);

      test("a swapped parent directory (a symlink to a copy) is refused too", () => {
        const base = mkdtempSync(path.join(STUB_ROOT, "parent-swap-"));
        const parent = path.join(base, "data");
        const dir = path.join(parent, "opencode-servers");
        __forTest.setServerDir(dir);
        __forTest.ensureServerDir();
        writeFileSync(path.join(dir, "x.json"), "{}", { mode: 0o600 });
        expect(() => __forTest.verifyServerDir()).not.toThrow();
        // The copy passes every lstat, owner and realpath check: only the pin catches it.
        cpSync(parent, `${parent}.copy`, { recursive: true });
        renameSync(parent, `${parent}.moved`);
        symlinkSync(`${parent}.copy`, parent);
        expect(() => __forTest.verifyServerDir()).toThrow(/replaced/);
        expect(() => __forTest.writePrivateFile(path.join(dir, "y.json"), "{}")).toThrow(/replaced/);
        expect(existsSync(path.join(`${parent}.copy`, "opencode-servers", "y.json"))).toBe(false);
        expect(() => __forTest.ensureServerDir()).toThrow(/replaced/);
      });

      test("a server directory removed and made again by this process is accepted", () => {
        const dir = path.join(mkdtempSync(path.join(STUB_ROOT, "remade-")), "opencode-servers");
        __forTest.setServerDir(dir);
        __forTest.ensureServerDir();
        rmSync(dir, { recursive: true });
        expect(() => __forTest.ensureServerDir()).not.toThrow();
        expect(() => __forTest.verifyServerDir()).not.toThrow();
      });

      test("a state file in a swapped dir is not read, so it never names what to kill", async () => {
        const id = newId();
        await ensureOpencodeServer(spec(id));
        const { evil } = swapForSymlink(id);
        // A decoy that looks like a perfectly good state file.
        writeFileSync(path.join(evil, `${id}.json`), JSON.stringify({ harnessId: id, url: "", password: "x", tmuxSession: host === "tmux" ? __forTest.sessionNameFor(id) : null, startedAt: 1 }), { mode: 0o600 });
        expect(__forTest.verifyServerDir).toThrow();
        __forTest.forget();
        await expect(adoptOpencodeServers()).resolves.toEqual([]);
        expect(existsSync(path.join(evil, `${id}.json`))).toBe(true); // not even "cleaned up"
      });

      test("an intact dir passes", () => {
        __forTest.setServerDir(mkdtempSync(path.join(STUB_ROOT, "intact-")));
        expect(() => __forTest.verifyServerDir()).not.toThrow();
      });
    });

    describe("classifyOpencodeServer", () => {
      const slow = (ms: number): void => writeFileSync(path.join(stubDir, "slow"), String(ms));

      test("unknown when this core holds no server for the harness", async () => {
        expect(await classifyOpencodeServer(newId())).toBe("unknown");
      });

      test("alive for a server that answers", async () => {
        const id = newId();
        await ensureOpencodeServer(spec(id));
        expect(await classifyOpencodeServer(id)).toBe("alive");
      });

      test("dead once the server process is gone, and it removes nothing itself", async () => {
        const id = newId();
        const h = await ensureOpencodeServer(spec(id));
        process.kill(await pidOf(h), "SIGKILL");
        await waitFor(async () => !(await checkOpencodeServerHealth(h, 300)));
        expect(await classifyOpencodeServer(id, 500)).toBe("dead");
        expect(getOpencodeServer(id)).toBe(h);
        expect(existsSync(__forTest.statePath(id))).toBe(true);
      });

      test("dead when the password is rejected twice in a row", async () => {
        const id = newId();
        await ensureOpencodeServer(spec(id));
        writeFileSync(path.join(stubDir, "unauth"), "");
        expect(await classifyOpencodeServer(id, 500)).toBe("dead");
      });

      test("unresponsive, not dead, for a live host that only times out", async () => {
        const id = newId();
        const h = await ensureOpencodeServer(spec(id));
        const pid = await pidOf(h);
        slow(3_000);
        expect(await classifyOpencodeServer(id, 150)).toBe("unresponsive");
        expect(alive(pid)).toBe(true);
        expect(getOpencodeServer(id)).toBe(h);
        rmSync(path.join(stubDir, "slow"), { force: true });
        expect(await classifyOpencodeServer(id, 1_000)).toBe("alive"); // it recovered
      });

      test("unknown while the harness's server is being replaced", async () => {
        __forTest.setHealthCacheMs(0);
        const id = newId();
        const first = await ensureOpencodeServer(spec(id));
        process.kill(await pidOf(first), "SIGKILL");
        await waitFor(async () => !(await checkOpencodeServerHealth(first, 300)));
        const replacing = ensureOpencodeServer(spec(id));
        expect(await classifyOpencodeServer(id, 500)).toBe("unknown");
        await replacing;
      });
    });

    test.skipIf(host !== "direct")("a fresh start never calls tmux on the direct host (S19)", async () => {
      const record = path.join(stubDir, "tmux-calls.log");
      const wrapper = path.join(stubDir, "tmux-record");
      writeFileSync(record, "");
      writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${record}"\nexec "${Bun.which("tmux") ?? "/usr/bin/true"}" "$@"\n`);
      chmodSync(wrapper, 0o755);
      setEnv("AGETOR_TMUX_BIN", wrapper);
      try {
        const id = newId();
        await ensureOpencodeServer(spec(id));
        await stopOpencodeServer(id);
      } finally {
        useRealTmux();
      }
      expect(readFileSync(record, "utf8")).toBe("");
    });

    test.skipIf(host !== "tmux")("a wedged new-session is bounded, killed, and leaves nothing behind (S8)", async () => {
      const pidFile = path.join(stubDir, "wedged-new-session.pid");
      const wrapper = path.join(stubDir, "tmux-wedge-new");
      rmSync(pidFile, { force: true });
      writeFileSync(wrapper, `#!/bin/sh\ncase "$*" in *new-session*) echo $$ > "${pidFile}"; exec sleep 30;; esac\nexec "${Bun.which("tmux")}" "$@"\n`);
      chmodSync(wrapper, 0o755);
      setEnv("AGETOR_TMUX_BIN", wrapper);
      __forTest.setNewSessionTimeoutMs(1_000);
      const id = newId();
      const t0 = Date.now();
      try {
        await expect(ensureOpencodeServer(spec(id))).rejects.toThrow(/timed out/);
      } finally {
        useRealTmux();
      }
      expect(Date.now() - t0).toBeLessThan(8_000);
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(pid).toBeGreaterThan(1);
      await waitFor(() => !alive(pid)); // the wedged client was killed
      expect(existsSync(__forTest.statePath(id))).toBe(false);
      expect(existsSync(__forTest.envPath(id))).toBe(false);
      expect(getOpencodeServer(id)).toBeNull();
      expect(launches()).toBe(0);
    });

    test.skipIf(host !== "tmux")("new-session's preamble and call share one budget", async () => {
      // start-server (the preamble) takes most of the budget, then new-session
      // wedges: the call gets only what is left, not a fresh budget of its own.
      const wrapper = path.join(stubDir, "tmux-slow-start");
      writeFileSync(wrapper, `#!/bin/sh\ncase "$*" in *start-server*) exec sleep 1.5;; *new-session*) exec sleep 30;; esac\nexec "${Bun.which("tmux")}" "$@"\n`);
      chmodSync(wrapper, 0o755);
      setEnv("AGETOR_TMUX_BIN", wrapper);
      __forTest.setNewSessionTimeoutMs(2_000);
      try {
        const t0 = Date.now();
        const res = await __forTest.tmuxNewSession([...tmuxSocketArgs(), "new-session", "-d", "-s", `agetor-ocsrv-budget-${process.pid}`, "--", "true"]);
        const took = Date.now() - t0;
        expect(res.status).toBeNull();
        expect(res.stderr).toMatch(/timed out/);
        expect(took).toBeGreaterThanOrEqual(1_900);
        expect(took).toBeLessThan(2_900); // two separate budgets would be >= 3.5 s
      } finally {
        useRealTmux();
      }
    });

    describe("a tmux server that dies under a new-session", () => {
      // A wrapper that fails the first `failures` new-session calls the way tmux
      // does when its server exits under the client, then runs the real tmux.
      function racingTmux(failures: number): { counter: string } {
        const real = Bun.which("tmux")!;
        const wrapper = path.join(stubDir, "tmux-racing");
        const counter = path.join(stubDir, "tmux-new-session-count");
        writeFileSync(counter, "");
        writeFileSync(
          wrapper,
          `#!/bin/sh
case "$*" in
  *new-session*)
    echo x >> "${counter}"
    if [ "$(wc -l < "${counter}")" -le ${failures} ]; then echo "server exited unexpectedly" >&2; exit 1; fi;;
esac
exec "${real}" "$@"
`,
        );
        chmodSync(wrapper, 0o755);
        setEnv("AGETOR_TMUX_BIN", wrapper);
        return { counter };
      }
      const newSessionCalls = (counter: string): number => readFileSync(counter, "utf8").split("\n").filter(Boolean).length;

      test.skipIf(host !== "tmux")("a transient failure is retried and the server still starts", async () => {
        const { counter } = racingTmux(1);
        try {
          const h = await ensureOpencodeServer(spec(newId()));
          expect(await checkOpencodeServerHealth(h)).toBe(true);
          expect(newSessionCalls(counter)).toBe(2);
          expect(launches()).toBe(1); // the failed attempt never ran the server
        } finally {
          useRealTmux();
        }
      });

      test.skipIf(host !== "tmux")("a persistent failure gives up after the retry cap and leaves nothing behind", async () => {
        const { counter } = racingTmux(100);
        const id = newId();
        try {
          await expect(ensureOpencodeServer(spec(id))).rejects.toThrow(/server exited unexpectedly/);
          expect(newSessionCalls(counter)).toBe(3); // the first try plus two retries
        } finally {
          useRealTmux();
        }
        expect(existsSync(__forTest.statePath(id))).toBe(false);
        expect(existsSync(__forTest.envPath(id))).toBe(false);
        expect(launches()).toBe(0);
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
        await __forTest.adoptionSettled(); // the late verdict has landed
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

      describe("the server itself is asked before a settings restart (C4)", () => {
        test("a session executing on the server keeps it, as stale", async () => {
          const id = newId();
          const a = await ensureOpencodeServer(spec(id, { STUB_EXTRA: "one" }));
          writeFileSync(path.join(stubDir, "active"), ""); // the server reports ses_busy running
          const kept = await ensureOpencodeServer({ ...spec(id, { STUB_EXTRA: "two" }), isBusy: () => false });
          expect(kept.stale).toBe(true);
          expect(kept.url).toBe(a.url);
          expect(kept.startedAt).toBe(a.startedAt);
          expect(launches()).toBe(1);
          expect(await checkOpencodeServerHealth(a)).toBe(true);
        });

        test("a failed or slow session/active keeps it, as stale", async () => {
          const id = newId();
          const a = await ensureOpencodeServer(spec(id, { STUB_EXTRA: "one" }));
          writeFileSync(path.join(stubDir, "active-fail"), "");
          const failed = await ensureOpencodeServer({ ...spec(id, { STUB_EXTRA: "two" }), isBusy: () => false });
          expect(failed).toMatchObject({ stale: true, url: a.url, startedAt: a.startedAt });
          rmSync(path.join(stubDir, "active-fail"), { force: true });
          // An answer slower than the gate's bound counts as no answer.
          __forTest.setRestartGateTimeoutMs(150);
          __forTest.setHealthCacheMs(60_000); // only the gate sees the slow server
          slowOn(1_000);
          const slow = await ensureOpencodeServer({ ...spec(id, { STUB_EXTRA: "two" }), isBusy: () => false });
          expect(slow).toMatchObject({ stale: true, url: a.url, startedAt: a.startedAt });
          slowOff();
          expect(launches()).toBe(1);
        });

        test("an idle server is restarted as before", async () => {
          const id = newId();
          const a = await ensureOpencodeServer(spec(id, { STUB_EXTRA: "one" }));
          const b = await ensureOpencodeServer({ ...spec(id, { STUB_EXTRA: "two" }), isBusy: () => false });
          expect(b.stale).toBeUndefined();
          expect(b.startedAt).not.toBe(a.startedAt);
          expect(b.url).not.toBe(a.url);
          expect(launches()).toBe(2);
        });
      });
    });

    test.skipIf(host !== "tmux")("a stop that tmux never confirms keeps the record and the state (SF7)", async () => {
      const id = newId();
      const h = await ensureOpencodeServer(spec(id));
      const stateBefore = readFileSync(__forTest.statePath(id), "utf8");
      // Every tmux call wedges, so has-session can only say "unknown".
      const wrapper = path.join(stubDir, "tmux-wedge-all");
      writeFileSync(wrapper, `#!/bin/sh\nexec sleep 30\n`);
      chmodSync(wrapper, 0o755);
      setEnv("AGETOR_TMUX_BIN", wrapper);
      __forTest.setTmuxTimeoutMs(200);
      __forTest.setStopGraceMs(300);
      __forTest.setIdleMs(0);
      try {
        expect(await stopOpencodeServer(id)).toBe(false);
        expect(getOpencodeServer(id)?.url).toBe(h.url);
        expect(readFileSync(__forTest.statePath(id), "utf8")).toBe(stateBefore);
        expect(existsSync(__forTest.logPath(id))).toBe(true);
        // The sweep does not report it stopped, so its caller keeps the hub.
        expect(await opencodeIdleSweep(Date.now() + 1_000, () => false)).toEqual([]);
        expect(getOpencodeServer(id)?.url).toBe(h.url);
      } finally {
        useRealTmux();
      }
      expect(await checkOpencodeServerHealth(h)).toBe(true);
      // With tmux back, the next sweep judges it again and really stops it.
      expect(await opencodeIdleSweep(Date.now() + 1_000, () => false)).toEqual([id]);
      expect(getOpencodeServer(id)).toBeNull();
      expect(existsSync(__forTest.statePath(id))).toBe(false);
    }, 20_000);

    test.skipIf(host !== "direct")("a state file with no tmux session is adopted only for a child this process spawned", async () => {
      const sac = Bun.spawn(["sleep", "120"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      try {
        // A copy of a live, healthy server's state naming a pid that is not ours.
        const id = newId();
        await ensureOpencodeServer(spec(id));
        const state = JSON.parse(readFileSync(__forTest.statePath(id), "utf8"));
        expect(state.tmuxSession).toBeNull();
        writeFileSync(__forTest.statePath(id), JSON.stringify({ ...state, hostPid: sac.pid }), { mode: 0o600 });
        __forTest.forget();
        expect(await adoptOpencodeServers()).toEqual([]);
        expect(getOpencodeServer(id)).toBeNull();
        expect(existsSync(__forTest.statePath(id))).toBe(false);
        expect(sac.exitCode).toBeNull();
        // ensure never adopts it either: it starts its own server.
        writeFileSync(__forTest.statePath(id), JSON.stringify({ ...state, hostPid: sac.pid }), { mode: 0o600 });
        const fresh = await ensureOpencodeServer(spec(id));
        expect(fresh.password).not.toBe(state.password);
        expect(launches()).toBe(2);
        expect(sac.exitCode).toBeNull();
        // The genuine article (this process's own child) is still adopted.
        __forTest.forget();
        expect((await adoptOpencodeServers()).map((a) => a.harnessId)).toEqual([id]);
      } finally {
        sac.kill("SIGKILL");
        await sac.exited;
      }
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

describe("bounded external calls (S8)", () => {
  const dir = mkdtempSync(path.join(STUB_ROOT, "bounded-"));
  const alivePid = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  afterEach(() => {
    useRealTmux();
    __forTest.restoreDefaults();
  });

  test("a wedged tmux has-session is 'unknown' (never proof of death) and the client is killed", async () => {
    const pidFile = path.join(dir, "has-session.pid");
    const wrapper = path.join(dir, "tmux-hang");
    writeFileSync(wrapper, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`);
    chmodSync(wrapper, 0o755);
    setEnv("AGETOR_TMUX_BIN", wrapper);
    __forTest.setTmuxTimeoutMs(1_000);
    const t0 = Date.now();
    expect(await __forTest.tmuxHasSession("agetor-ocsrv-anything")).toBe("unknown");
    expect(Date.now() - t0).toBeLessThan(5_000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await waitFor(() => !alivePid(pid));
  });

  test("a wedged ps yields an empty table, so nothing is signalled", async () => {
    const pidFile = path.join(dir, "ps.pid");
    const wrapper = path.join(dir, "ps-hang");
    writeFileSync(wrapper, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`);
    chmodSync(wrapper, 0o755);
    __forTest.setPsBin(wrapper);
    __forTest.setTmuxTimeoutMs(1_000); // room for the wrapper to start on a loaded machine
    const t0 = Date.now();
    expect((await __forTest.processTable()).size).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5_000);
    await waitFor(() => !alivePid(Number(readFileSync(pidFile, "utf8"))));
  });

  test("a healthy ps still lists processes", async () => {
    const table = await __forTest.processTable();
    expect(table.get(process.pid)).toBe(process.ppid);
  });
});

describe("the health probe reads a capped body (S13)", () => {
  afterEach(() => {
    __forTest.restoreDefaults();
  });
  const handle = { harnessId: "cap", url: "http://127.0.0.1:9", password: "pw", tmuxSession: null, startedAt: 1 };
  /** A 200 whose body streams `chunks` chunks of 1 KiB, counting what was pulled. */
  function streaming(chunks: number): { fetch: typeof fetch; pulled: () => number } {
    let pulled = 0;
    const f = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            pulled++;
            if (pulled === 1) c.enqueue(new TextEncoder().encode(`{"version":"2.1.3","pad":"`));
            else if (pulled <= chunks) c.enqueue(new Uint8Array(1024).fill(0x61));
            else {
              c.enqueue(new TextEncoder().encode(`"}`));
              c.close();
            }
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    return { fetch: f, pulled: () => pulled };
  }

  test("a body past the cap fails the probe, and is not read to the end", async () => {
    __forTest.setProbeMaxBytes(16 * 1024);
    const s = streaming(1_000); // ~1 MiB
    __forTest.setFetchImpl(s.fetch);
    expect(await __forTest.checkHealth(handle)).toBe(false);
    expect(s.pulled()).toBeLessThan(100);
  });

  test("a body within the cap passes", async () => {
    __forTest.setProbeMaxBytes(16 * 1024);
    __forTest.setFetchImpl(streaming(4).fetch);
    expect(await __forTest.checkHealth(handle)).toBe(true);
  });

  test("a declared content-length past the cap fails before any body is read", async () => {
    __forTest.setProbeMaxBytes(100);
    __forTest.setFetchImpl((async () => new Response("{}", { status: 200, headers: { "content-length": "101" } })) as unknown as typeof fetch);
    expect(await __forTest.checkHealth(handle)).toBe(false);
  });
});

describe("the direct test host is gated (N1)", () => {
  const withEnv = (vars: Record<string, string | undefined>, fn: () => void): void => {
    const keys = Object.keys(vars);
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) {
        if (vars[k] === undefined) delete process.env[k];
        else process.env[k] = vars[k];
      }
      fn();
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  };

  test("honored under NODE_ENV=test", () => {
    withEnv({ AGETOR_OPENCODE_SERVER_HOST: "direct", NODE_ENV: "test", AGETOR_E2E_OPENCODE_DIRECT_HOST: undefined }, () => {
      expect(__forTest.hostIsDirect()).toBe(true);
    });
  });
  test("honored with the e2e flag outside NODE_ENV=test", () => {
    withEnv({ AGETOR_OPENCODE_SERVER_HOST: "direct", NODE_ENV: undefined, AGETOR_E2E_OPENCODE_DIRECT_HOST: "1" }, () => {
      expect(__forTest.hostIsDirect()).toBe(true);
    });
  });
  test("ignored in a packaged-build-like environment", () => {
    for (const nodeEnv of [undefined, "production"]) {
      withEnv({ AGETOR_OPENCODE_SERVER_HOST: "direct", NODE_ENV: nodeEnv, AGETOR_E2E_OPENCODE_DIRECT_HOST: undefined }, () => {
        expect(__forTest.hostIsDirect()).toBe(false);
      });
    }
    withEnv({ AGETOR_OPENCODE_SERVER_HOST: "direct", NODE_ENV: "production", AGETOR_E2E_OPENCODE_DIRECT_HOST: "0" }, () => {
      expect(__forTest.hostIsDirect()).toBe(false);
    });
  });
  test("never on without the host variable", () => {
    withEnv({ AGETOR_OPENCODE_SERVER_HOST: undefined, NODE_ENV: "test", AGETOR_E2E_OPENCODE_DIRECT_HOST: "1" }, () => {
      expect(__forTest.hostIsDirect()).toBe(false);
    });
  });
});

describe("id handling", () => {
  test("filenames and session names only ever contain [A-Za-z0-9_-]", () => {
    expect(__forTest.safeId("opencode")).toBe("opencode");
    for (const raw of ["../../etc/passwd", "a b", "x/y", "ünï", "", "a".repeat(200)]) {
      expect(__forTest.safeId(raw)).toMatch(/^[A-Za-z0-9_-]{1,80}$/);
    }
    expect(__forTest.safeId("a.b")).not.toBe(__forTest.safeId("a_b"));
  });

  test("redact removes the password and password-looking text", () => {
    const out = __forTest.redact("server password: abc123 OPENCODE_PASSWORD=zzz Authorization: Basic Zm9v hi sekret!", "sekret!");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("zzz");
    expect(out).not.toContain("Zm9v");
    expect(out).not.toContain("sekret!");
    expect(__forTest.redact('{"password":"q1","OPENCODE_PASSWORD": "q2"}')).toBe('{"password":"[redacted]","OPENCODE_PASSWORD": "[redacted]"}');
  });
});

suite("direct", false);
suite("tmux", !tmuxAvailable);
