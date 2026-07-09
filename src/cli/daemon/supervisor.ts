import { openSync, closeSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverCore, type CoreInfo } from "../api-client.ts";
import { resolveDataDir } from "../../bun/core-creds.ts";

/**
 * Owns the lifecycle of the shared Agetor "core" from the CLI's side. The core
 * is whoever owns the API port — the desktop app, or a headless cli-daemon the
 * CLI spawns when the app is closed. The daemon shares the same
 * `$AGETOR_DATA_DIR` state, so tasks created from the CLI also appear in the app.
 */
export interface EnsureOptions {
  dataDir?: string;
  /** Override the port a freshly-spawned daemon should bind (default 4317). */
  port?: number;
  /** Fail instead of auto-spawning a daemon when nothing is running. */
  noDaemon?: boolean;
}

/** Return a live core, spawning a headless daemon if none is running. */
export async function ensureCore(opts: EnsureOptions = {}): Promise<CoreInfo> {
  const existing = await discoverCore(opts.dataDir);
  if (existing) return existing;
  if (opts.noDaemon) {
    throw new Error(
      "No Agetor core is running. Open the app, run `agetor daemon start`, or drop --no-daemon.",
    );
  }
  return spawnDaemon(opts);
}

/** Spawn a detached headless daemon and wait until it's serving. */
export async function spawnDaemon(opts: EnsureOptions = {}): Promise<CoreInfo> {
  const dataDir = opts.dataDir ?? resolveDataDir();
  mkdirSync(dataDir, { recursive: true });
  // Redirect the daemon's stdout/stderr into the same log it writes lifecycle
  // lines to, so a crash on boot leaves a trace the user can read.
  const logFd = openSync(path.join(dataDir, "daemon.log"), "a");

  const env: Record<string, string> = { ...process.env, AGETOR_DATA_DIR: dataDir };
  if (opts.port) env.AGETOR_API_PORT = String(opts.port);

  const proc = Bun.spawn(daemonCommand(), {
    env,
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
  });
  // The child dup'd the log fd; release the parent's copy so the CLI doesn't
  // hold a redundant descriptor for the rest of this invocation.
  closeSync(logFd);
  // Detach: the daemon must outlive this CLI invocation.
  proc.unref();

  const core = await waitForCore(opts.dataDir, 15_000);
  if (!core) {
    throw new Error(
      `Agetor daemon did not come up within 15s — see ${path.join(dataDir, "daemon.log")}`,
    );
  }
  return core;
}

/**
 * How to launch the daemon. In a source checkout we run `bun …/headless.ts`; in
 * the compiled standalone binary the `headless.ts` file isn't on disk, so we
 * re-exec ourselves with the hidden `__daemon` subcommand (the binary carries
 * the server stack and boots it lazily — see `src/cli/index.ts`).
 */
function daemonCommand(): string[] {
  const headless = path.resolve(
    fileURLToPath(new URL("../../bun/headless.ts", import.meta.url)),
  );
  if (existsSync(headless)) return [process.execPath, headless];
  return [process.execPath, "__daemon"];
}

async function waitForCore(
  dataDir: string | undefined,
  timeoutMs: number,
): Promise<CoreInfo | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const core = await discoverCore(dataDir);
    if (core) return core;
    await Bun.sleep(150);
  }
  return null;
}

/** Ask a running core to shut down. Returns false if nothing was running. */
export async function stopDaemon(dataDir?: string): Promise<boolean> {
  const core = await discoverCore(dataDir);
  if (!core) return false;
  try {
    await fetch(`http://127.0.0.1:${core.port}/daemon/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${core.token}` },
    });
  } catch {
    /* the core drops the connection as it exits — expected */
  }
  return true;
}
