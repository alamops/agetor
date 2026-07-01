import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Boots the real headless daemon as a subprocess and exercises the full
// lifecycle: it writes a cli-daemon creds file, serves the API, enforces auth,
// 501s native routes, and exits cleanly (removing creds) on POST /daemon/shutdown.
test("cli-daemon boots, writes creds, serves, and shuts down cleanly", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-daemon-boot-"));
  const port = 4471;
  const credsPath = path.join(dir, "agetor-core.json");

  const proc = Bun.spawn(["bun", "src/bun/headless.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGETOR_DATA_DIR: dir,
      AGETOR_API_PORT: String(port),
      AGETOR_DAEMON_IDLE_MS: "0", // disable idle shutdown for the test
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const base = `http://127.0.0.1:${port}`;
  try {
    // Wait for the server to bind.
    let up = false;
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(300) });
        if (r.ok) {
          up = true;
          break;
        }
      } catch {
        /* not up yet */
      }
      await Bun.sleep(100);
    }
    expect(up).toBe(true);

    // Creds file written with the daemon identity.
    expect(existsSync(credsPath)).toBe(true);
    const creds = JSON.parse(readFileSync(credsPath, "utf8"));
    expect(creds.kind).toBe("cli-daemon");
    expect(creds.port).toBe(port);
    expect(typeof creds.token).toBe("string");
    expect(creds.pid).toBe(proc.pid);

    const bearer = { authorization: `Bearer ${creds.token}` };
    expect((await fetch(`${base}/info`, { headers: bearer })).status).toBe(200);
    expect((await fetch(`${base}/info`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/notifications`, {
          method: "POST",
          headers: { ...bearer, "content-type": "application/json" },
          body: JSON.stringify({ title: "x" }),
        })
      ).status,
    ).toBe(501);

    // Graceful shutdown removes creds and exits 0.
    const sd = await fetch(`${base}/daemon/shutdown`, { method: "POST", headers: bearer });
    expect(sd.status).toBe(200);
    expect(await proc.exited).toBe(0);
    expect(existsSync(credsPath)).toBe(false);
  } finally {
    proc.kill();
  }
}, 30_000);
