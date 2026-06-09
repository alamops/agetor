import { test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureCore, stopDaemon } from "./daemon/supervisor.ts";
import { AgetorClient, discoverCore } from "./api-client.ts";
import { coreCredsPath } from "../bun/core-creds.ts";

// End-to-end: the supervisor spawns a real headless daemon, the typed client
// talks to it over HTTP, a second ensureCore discovers the SAME daemon (no
// double-spawn), and stopDaemon tears it down.
test("supervisor spawns a daemon and the client talks to it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agetor-cli-int-"));
  const opts = { dataDir: dir, port: 4489 };
  try {
    const core = await ensureCore(opts);
    expect(core.kind).toBe("cli-daemon");
    expect(core.port).toBe(4489);
    expect(existsSync(coreCredsPath(dir))).toBe(true);

    const client = new AgetorClient(core);
    expect(typeof (await client.info()).version).toBe("string");
    expect(await client.listTasks()).toEqual([]);

    // ensureCore again → discovers the same running daemon, no new process.
    const again = await ensureCore(opts);
    expect(again.pid).toBe(core.pid);

    // discoverCore directly also finds it.
    const found = await discoverCore(dir);
    expect(found?.port).toBe(4489);
  } finally {
    await stopDaemon(dir);
    for (let i = 0; i < 30 && existsSync(coreCredsPath(dir)); i++) {
      await Bun.sleep(100);
    }
    expect(existsSync(coreCredsPath(dir))).toBe(false);
  }
}, 30_000);
