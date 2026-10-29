import { test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { probeLiveCore, waitForPortFree, readCoreCreds, writeCoreCreds } from "./core-creds.ts";
import { CORE_EXIT_PARK } from "./daemon-mode.ts";
import { Database } from "bun:sqlite";

function spawnDaemon(dir: string, port: number) {
  return Bun.spawn(["bun", "src/bun/headless.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGETOR_DATA_DIR: dir,
      AGETOR_API_PORT: String(port),
      AGETOR_DAEMON_IDLE_MS: "0",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function waitUp(port: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(300) })).ok) {
        return true;
      }
    } catch {
      /* not up yet */
    }
    await Bun.sleep(100);
  }
  return false;
}

// The app⇄daemon handoff hinges on a running cli-daemon actually releasing its
// port when asked, so a new owner (the app, in production) can bind. This proves
// that release-and-rebind protocol end-to-end with subprocess daemons, using the
// same shared helpers (probeLiveCore, waitForPortFree) that index.ts uses.
test("cli-daemon releases its port on /daemon/shutdown so a new owner can bind", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-handoff-"));
  const port = 4473;
  const credsPath = path.join(dir, "agetor-core.json");

  const d1 = spawnDaemon(dir, port);
  let d2: ReturnType<typeof spawnDaemon> | null = null;
  try {
    expect(await waitUp(port)).toBe(true);
    const creds = readCoreCreds(dir);
    expect(creds?.kind).toBe("cli-daemon");
    // The handoff authenticates with the CLI token from the file (not the
    // master, which the daemon keeps in memory): /daemon/shutdown is app+cli.
    expect(creds?.token).toMatch(/^[0-9a-f]{64}$/);
    expect(await probeLiveCore(creds!)).toBe(true);

    // App-side handoff request (mirrors index.ts): ask the daemon to shut down,
    // then wait for the port to free.
    await fetch(`http://127.0.0.1:${port}/daemon/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds!.token}` },
    }).catch(() => {});
    expect(await waitForPortFree(port, 10_000)).toBe(true);
    expect(await d1.exited).toBe(0);
    expect(existsSync(credsPath)).toBe(false); // creds removed on shutdown

    // A fresh owner can now bind the just-freed port.
    d2 = spawnDaemon(dir, port);
    expect(await waitUp(port)).toBe(true);
    expect(readCoreCreds(dir)?.pid).toBe(d2.pid);
  } finally {
    d1.kill();
    d2?.kill();
  }
}, 30_000);

// A core that loses the bind to a LIVE core exits quietly — but the exit code
// depends on who launched it (docs/plans/always-on-host.md §3.1): a login-item
// core exits CORE_EXIT_PARK (76) so its supervisor parks behind the winner
// instead of reading a stop; a CLI core exits 0 as before. Ports 4479 / 4480.
//
// The winner is a stand-in "app" (a plain node:http listener plus a `kind:"app"`
// creds file naming this test's pid), not a second headless core: it binds in
// milliseconds and is live before the loser reaches its bind, so the core's bind
// fails with EADDRINUSE, which is the path under test (probeLiveCore then finds
// the stand-in live: pid alive, /health says agetor, /info accepts the token).
/** Seeds `dir`'s database with one task and one `running` fx run, in a
 *  subprocess so this test process never opens (and pins) a db.ts singleton.
 *  fx runs are never reattached, so any boot restore that ran would flip it
 *  to `orphaned`. */
async function seedRunningRun(dir: string): Promise<void> {
  const script = `
    const { tasks, runs } = await import(${JSON.stringify(path.resolve("src/bun/db.ts"))});
    const now = Date.now();
    tasks.insert({ id: "t-live", title: "live", prompt: "p", column: "running", agent: "fx", workdir: "/tmp",
      isolation: "none", taskType: "task", branch: null, branchSource: "created", worktreePath: null, baseRef: null,
      prUrl: null, mode: null, model: null, effort: null, speed: "off", maxMode: false, opencodeServer: "shared",
      references: [], backlog: [], plans: [], draft: null, hasOpenableRun: false, pendingInteractionCount: 0,
      openTerminalCount: 0, archivedAt: null, createdAt: now, updatedAt: now, runId: "r-live" });
    runs.insert({ id: "r-live", taskId: "t-live", agent: "fx", status: "running", startedAt: now, endedAt: null,
      exitCode: null, tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null,
      geminiSessionId: null, fxSessionId: null });
  `;
  const seed = Bun.spawn(["bun", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "test", AGETOR_DATA_DIR: dir } as Record<string, string>,
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await seed.exited) !== 0) throw new Error(`seed failed: ${await new Response(seed.stderr).text()}`);
}

function runStatus(dir: string, runId: string): string | null {
  const db = new Database(path.join(dir, "agetor.sqlite"), { readonly: true });
  try {
    return db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(runId)?.status ?? null;
  } finally {
    db.close();
  }
}

async function loserExitCode(
  port: number,
  loserLaunchedBy?: "login-item",
  opts: { seedRunningRun?: boolean } = {},
): Promise<{
  code: number;
  winnerStillOwnsPort: boolean;
  dir: string;
}> {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-lost-bind-"));
  if (opts.seedRunningRun) await seedRunningRun(dir);
  const token = "w".repeat(64);
  const winner = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") {
      res.end(JSON.stringify({ app: "agetor" }));
    } else if (req.url === "/info" && req.headers.authorization === `Bearer ${token}`) {
      res.end("{}");
    } else {
      res.statusCode = 401;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve, reject) => {
    winner.once("error", reject);
    winner.listen(port, "127.0.0.1", () => resolve());
  });
  writeCoreCreds(
    { port, token, pid: process.pid, kind: "app", version: "test", startedAt: Date.now() },
    dir,
  );

  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "test",
    AGETOR_DATA_DIR: dir,
    AGETOR_API_PORT: String(port),
    AGETOR_DAEMON_IDLE_MS: "0",
    AGETOR_HEADLESS_NOTIFICATIONS: "0",
    AGETOR_TMUX_BIN: "/bin/echo",
    AGETOR_HARNESS_AUTO_ENABLE: "0",
  };
  delete env.AGETOR_LAUNCHED_BY;
  if (loserLaunchedBy) env.AGETOR_LAUNCHED_BY = loserLaunchedBy;
  const loser = Bun.spawn(["bun", "src/bun/headless.ts"], {
    cwd: process.cwd(),
    env: env as Record<string, string>,
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const code = await Promise.race([
      loser.exited,
      Bun.sleep(100_000).then(() => {
        throw new Error("the losing core did not exit");
      }),
    ]);
    // The loser must not have touched the winner's creds or its port.
    const creds = readCoreCreds(dir);
    const winnerStillOwnsPort = creds?.pid === process.pid && creds.kind === "app" && (await probeLiveCore(creds));
    return { code, winnerStillOwnsPort, dir };
  } finally {
    loser.kill();
    winner.close();
  }
}

test("a login-item core that loses the bind to a live core exits 76 (park)", async () => {
  const { code, winnerStillOwnsPort } = await loserExitCode(4479, "login-item");
  expect(code).toBe(CORE_EXIT_PARK);
  expect(code).toBe(76);
  expect(winnerStillOwnsPort).toBe(true);
}, 150_000);

test("a CLI core that loses the bind to a live core exits 0", async () => {
  const { code, winnerStillOwnsPort } = await loserExitCode(4480);
  expect(code).toBe(0);
  expect(winnerStillOwnsPort).toBe(true);
}, 150_000);

// The bind is the ownership claim (boot-gate.ts): a core that loses the port
// must exit BEFORE its boot restore, or it would act on runs the live owner is
// driving — this is the app-opens-while-the-background-core-runs race, seen
// from the loser's side. Port 4615.
test("a core that loses the bind never runs its boot restore (a live owner's running run stays running)", async () => {
  const { code, winnerStillOwnsPort, dir } = await loserExitCode(4615, "login-item", { seedRunningRun: true });
  expect(code).toBe(CORE_EXIT_PARK);
  expect(winnerStillOwnsPort).toBe(true);
  expect(runStatus(dir, "r-live")).toBe("running");
}, 150_000);
