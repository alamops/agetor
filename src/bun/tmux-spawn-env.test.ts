import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmTestDataDir } from "./test-data-dir.ts";

/* Regression: `Bun.spawn` without an `env` option gives the child Bun's
 * startup env snapshot, NOT the live `process.env`. `rehydratePath()` mutates
 * `process.env.PATH` after startup, so a tmux client spawned bare never saw
 * the rehydrated PATH — and tmux sets a pane's PATH from the CLIENT's PATH
 * (overriding `new-session -e PATH=…`). A packaged-app launch (launchd's
 * `/usr/bin:/bin`) therefore broke every `#!/usr/bin/env node` CLI (codex).
 * Each test mutates PATH at runtime — exactly what rehydratePath() does.
 *
 * Isolation: spawnTmuxNewSession() calls ensureDisclaimedServer() internally,
 * so AGETOR_TMUX_BIN and AGETOR_TMUX_SOCKET are pinned in beforeEach — before
 * any test body can reach tmux — to a fake binary and a private socket. No
 * test can touch the shared `agetor-test` socket or a real tmux server except
 * the integration test, which uses its own uniquely named socket and kills it. */

// db.ts captures AGETOR_DATA_DIR at first import — set before the dynamic imports.
const savedDataDir = process.env.AGETOR_DATA_DIR;
// Deterministic (not mkdtemp): db.ts opens agetor.sqlite once per `bun test`
// process and never closes it, so when this file wins the import race the dir
// can't be deleted without breaking later files. A fixed name bounds that
// worst case to ONE reused dir instead of one leaked dir per run.
const testDataDir = path.join(tmpdir(), "agetor-tmux-spawn-env-data");
mkdirSync(testDataDir, { recursive: true });
process.env.AGETOR_DATA_DIR = testDataDir;

const { spawnTmuxNewSession, ensureDisclaimedServer } = await import("./tmux-resolution.ts");
const { sessionExistsByName } = await import("./claude-tmux.ts");

const ENV_KEYS = ["PATH", "AGETOR_TMUX_BIN", "AGETOR_TMUX_SOCKET"] as const;
let saved: Record<string, string | undefined> = {};
let tempDirs: string[] = [];
let privateSocket = "";
const realTmux = Bun.which("tmux");

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  privateSocket = `agetor-test-spawnenv-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  process.env.AGETOR_TMUX_SOCKET = privateSocket;
  // Default to a harmless fake so nothing can start a real tmux server by accident.
  process.env.AGETOR_TMUX_BIN = path.join(makeTemp("agetor-notmux-"), "tmux-does-not-exist");
});

/** tmux's socket file: $TMUX_TMPDIR (default /tmp) / tmux-<uid> / <name>. Derived
 *  rather than queried from a live server so cleanup works even when the pane
 *  died fast and the server already exited. */
function socketFile(name: string): string {
  return path.join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid!()}`, name);
}

/** Kill any server on this test's private socket and unlink its socket file.
 *  Runs from afterEach too, because bun's test timeout abandons a test body
 *  without running its `finally`. */
function destroyPrivateSocket(realBin: string | null) {
  if (realBin && privateSocket) Bun.spawnSync([realBin, "-L", privateSocket, "kill-server"]);
  if (privateSocket) rmSync(socketFile(privateSocket), { force: true });
}

afterEach(() => {
  destroyPrivateSocket(realTmux);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  tempDirs = [];
});

afterAll(() => {
  if (savedDataDir === undefined) delete process.env.AGETOR_DATA_DIR;
  else process.env.AGETOR_DATA_DIR = savedDataDir;
  // Removes the dir unless the live sqlite is in it (see testDataDir above).
  rmTestDataDir(testDataDir);
});

/** Fake tmux: appends the PATH IT was started with to a log, then exits 0. */
function installPathRecordingTmux(): string {
  const dir = makeTemp("agetor-faketmux-path-");
  const bin = path.join(dir, "tmux");
  const log = path.join(dir, "path.log");
  writeFileSync(
    bin,
    `#!${process.execPath}\n` +
      `import { appendFileSync } from "node:fs";\n` +
      `appendFileSync(${JSON.stringify(log)}, (process.env.PATH ?? "") + "\\n");\n`,
  );
  chmodSync(bin, 0o755);
  process.env.AGETOR_TMUX_BIN = bin;
  return log;
}

const readLog = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);

/** What rehydratePath() does: prepend a dir to the live process.env.PATH. */
function mutatePath(): string {
  const marker = makeTemp("agetor-rehydrated-");
  process.env.PATH = `${marker}:${process.env.PATH}`;
  return marker;
}

test("spawnTmuxNewSession: a post-startup PATH mutation reaches the tmux client", async () => {
  const log = installPathRecordingTmux();
  const marker = mutatePath();
  await spawnTmuxNewSession(process.env.AGETOR_TMUX_BIN!, ["new-session"]);
  const seen = readLog(log); // start-server (ensureDisclaimedServer) + new-session
  expect(seen.length).toBeGreaterThan(0);
  for (const p of seen) expect(p.split(":")).toContain(marker);
});

test("ensureDisclaimedServer: a post-startup PATH mutation reaches the tmux client", async () => {
  const log = installPathRecordingTmux();
  const marker = mutatePath();
  await ensureDisclaimedServer();
  const seen = readLog(log);
  expect(seen.length).toBeGreaterThan(0);
  for (const p of seen) expect(p.split(":")).toContain(marker);
});

test("claude-tmux runner: a post-startup PATH mutation reaches the tmux client", async () => {
  const log = installPathRecordingTmux();
  const marker = mutatePath();
  await sessionExistsByName("agetor-spawn-env-probe");
  const seen = readLog(log);
  expect(seen.length).toBeGreaterThan(0);
  for (const p of seen) expect(p.split(":")).toContain(marker);
});

test.skipIf(!realTmux)(
  "real tmux: a `#!/usr/bin/env node` CLI resolves node that exists only in the runtime-mutated PATH",
  async () => {
    const work = makeTemp("agetor-shebang-");
    const nodeDir = path.join(work, "nodebin");
    const cliDir = path.join(work, "clibin");
    const out = path.join(work, "out.txt");
    mkdirSync(nodeDir);
    mkdirSync(cliDir);
    // Fake node exists ONLY in nodeDir, which is never on the startup PATH.
    writeFileSync(path.join(nodeDir, "node"), "#!/bin/sh\necho NODE_RESOLVED\n");
    writeFileSync(path.join(cliDir, "codex"), "#!/usr/bin/env node\n");
    chmodSync(path.join(nodeDir, "node"), 0o755);
    chmodSync(path.join(cliDir, "codex"), 0o755);

    process.env.AGETOR_TMUX_BIN = realTmux!;
    // AGETOR_TMUX_SOCKET is already the private per-test socket from beforeEach.
    process.env.PATH = `${nodeDir}:${process.env.PATH}`; // what rehydratePath() does
    const socketPath = socketFile(privateSocket);
    try {
      // Mirrors spawnCodexViaTmux: absolute CLI path, PATH forwarded via -e.
      const res = await spawnTmuxNewSession(realTmux!, [
        "-L", privateSocket, "new-session", "-d", "-s", "shebang",
        "-e", `PATH=${process.env.PATH}`,
        "--", "sh", "-c", `${path.join(cliDir, "codex")} > ${out} 2>&1`,
      ]);
      expect(res.status).toBe(0);
      for (let i = 0; i < 50 && (!existsSync(out) || readFileSync(out, "utf8") === ""); i++) await Bun.sleep(100);
      expect(readFileSync(out, "utf8").trim()).toBe("NODE_RESOLVED");
    } finally {
      // The server may already be gone (exit-empty) and can leave its socket file
      // behind; remove it ourselves, then prove nothing remains.
      destroyPrivateSocket(realTmux);
      expect(existsSync(socketPath)).toBe(false);
    }
  },
  15_000,
);
