import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Boots the real headless daemon as a subprocess and exercises the full
// lifecycle: it writes a cli-daemon creds file, serves the API, enforces auth,
// 501s native routes, and exits cleanly (removing creds) on POST /daemon/shutdown.
test("cli-daemon boots, writes creds, serves, and shuts down cleanly", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-daemon-boot-"));
  const port = 4471;
  const credsPath = path.join(dir, "agetor-core.json");
  // A known master so the test can tell it apart from what the creds file
  // carries (the daemon is a child process, so its CLI_TOKEN isn't visible here).
  const master = "m".repeat(64);

  const proc = Bun.spawn(["bun", "src/bun/headless.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGETOR_DATA_DIR: dir,
      AGETOR_API_PORT: String(port),
      AGETOR_DAEMON_IDLE_MS: "0", // disable idle shutdown for the test
      AGETOR_API_TOKEN: master,
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

    // The file carries the CLI-scoped token, never the master (D3): a fresh
    // 32-byte hex value that is not the master the daemon was given, and the
    // file itself is owner-only.
    expect(creds.token).toMatch(/^[0-9a-f]{64}$/);
    expect(creds.token).not.toBe(master);
    expect(statSync(credsPath).mode & 0o777).toBe(0o600);

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

    // The CLI token works on a CLI route but is refused on a desktop-only route
    // that exists headless; the master (held in memory by the app) gets through.
    const desktopOnly = `${base}/tasks/does-not-exist/terminals`;
    const refused = await fetch(desktopOnly, { headers: bearer });
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("desktop-only");
    expect((await fetch(desktopOnly, { headers: { authorization: `Bearer ${master}` } })).status).toBe(200);
    // …and the master is not what the file hands out: it never appears in it.
    expect(readFileSync(credsPath, "utf8")).not.toContain(master);

    // Graceful shutdown removes creds and exits 0.
    const sd = await fetch(`${base}/daemon/shutdown`, { method: "POST", headers: bearer });
    expect(sd.status).toBe(200);
    expect(await proc.exited).toBe(0);
    expect(existsSync(credsPath)).toBe(false);
  } finally {
    proc.kill();
  }
}, 30_000);

// A headless core ignores a stored `disclaimSpawnedAgents = "false"` (D6): there
// is no dialog to ask, and the SQLite file is writable by an agent, so "off" is
// only ever a request. The boot logs that it did so.
test("headless boot ignores a stored disclaimSpawnedAgents=false and logs it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-daemon-disclaim-"));
  const port = 4474;
  const env = {
    ...process.env,
    AGETOR_DATA_DIR: dir,
    AGETOR_API_PORT: String(port),
    AGETOR_DAEMON_IDLE_MS: "0",
  };

  // Seed the preference in the child's data dir through the real db module.
  const seed = Bun.spawn(
    [
      "bun",
      "-e",
      `import { preferences } from "./src/bun/db.ts"; preferences.set("disclaimSpawnedAgents", "false");`,
    ],
    { cwd: process.cwd(), env, stdout: "ignore", stderr: "pipe" },
  );
  expect(await seed.exited).toBe(0);

  const proc = Bun.spawn(["bun", "src/bun/headless.ts"], {
    cwd: process.cwd(),
    env,
    stdout: "ignore",
    stderr: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(300) })).ok) {
          up = true;
          break;
        }
      } catch {
        /* not up yet */
      }
      await Bun.sleep(100);
    }
    expect(up).toBe(true);

    const log = readFileSync(path.join(dir, "daemon.log"), "utf8");
    expect(log).toContain('disclaimSpawnedAgents is stored as "off"; ignored on headless');
    expect(log).toContain("permission isolation stays on");

    const creds = JSON.parse(readFileSync(path.join(dir, "agetor-core.json"), "utf8"));
    await fetch(`${base}/daemon/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${creds.token}` },
    });
    expect(await proc.exited).toBe(0);
  } finally {
    proc.kill();
  }
}, 30_000);
