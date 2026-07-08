import { test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { probeLiveCore, waitForPortFree, readCoreCreds } from "./core-creds.ts";

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
