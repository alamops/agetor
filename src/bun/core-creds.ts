import { homedir } from "node:os";
import path from "node:path";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  chmodSync,
} from "node:fs";

/**
 * The "core credentials" file is how an out-of-process client (the `agetor`
 * CLI, or a second app launch) discovers and authenticates to the running
 * Agetor core. The API token is generated fresh per launch and lives only in
 * memory (see `api-config.ts`), so without this file a separate process has no
 * way to authorize a single request against the localhost API.
 *
 * Exactly one process owns the port at a time and writes this file right after
 * the server binds: the Electrobun app (`kind: "app"`) or the headless CLI
 * daemon (`kind: "cli-daemon"`). It is removed best-effort on clean shutdown.
 *
 * This module deliberately imports nothing from `db.ts` (which opens SQLite on
 * import) so the CLI can read creds without booting a database.
 */
export interface CoreCreds {
  /** Port the core's HTTP API is bound to on 127.0.0.1. */
  port: number;
  /** Per-launch bearer token (also accepted as `?token=` on SSE URLs). */
  token: string;
  /** PID of the owning process, for a `kill(pid, 0)` liveness check. */
  pid: number;
  /** Which surface owns the port — drives the app's handoff decision. */
  kind: "app" | "cli-daemon";
  /** App/CLI version that wrote the file (for skew warnings). */
  version: string;
  /** Unix ms the core started. */
  startedAt: number;
}

export const CORE_CREDS_FILENAME = "agetor-core.json";

/**
 * Resolve the data dir the same way `db.ts` does, but lazily (at call time)
 * and without importing `db.ts`. Reading `AGETOR_DATA_DIR` at call time keeps
 * us in agreement with `db.ts` even under the test auto-allocate path (which
 * sets the env var before any creds call runs).
 */
export function resolveDataDir(): string {
  return process.env.AGETOR_DATA_DIR ?? path.join(homedir(), ".agetor");
}

export function coreCredsPath(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, CORE_CREDS_FILENAME);
}

/**
 * Write the creds file atomically at mode 0600 (write a tmp sibling, then
 * rename over the target) so a reader never sees a half-written or
 * world-readable file. Best-effort chmod afterwards in case the umask or an
 * existing file left looser bits.
 */
export function writeCoreCreds(creds: CoreCreds, dataDir?: string): void {
  const file = coreCredsPath(dataDir);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(creds), { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
}

export function readCoreCreds(dataDir?: string): CoreCreds | null {
  let raw: string;
  try {
    raw = readFileSync(coreCredsPath(dataDir), "utf8");
  } catch {
    return null; // missing file → no core
  }
  try {
    const v = JSON.parse(raw) as Partial<CoreCreds>;
    if (
      v &&
      typeof v.port === "number" &&
      typeof v.token === "string" &&
      typeof v.pid === "number" &&
      (v.kind === "app" || v.kind === "cli-daemon") &&
      typeof v.version === "string" &&
      typeof v.startedAt === "number"
    ) {
      return v as CoreCreds;
    }
  } catch {
    /* corrupt JSON → treat as no core */
  }
  return null;
}

export function removeCoreCreds(dataDir?: string): void {
  try {
    unlinkSync(coreCredsPath(dataDir));
  } catch {
    /* best-effort — may already be gone */
  }
}

/**
 * Existence/permission check via signal 0 (sends no signal). Same convention
 * `wipe-dev.ts` uses for the pid file. A leftover creds file from a crashed
 * process fails here once the pid is recycled or gone.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify a discovered core is actually live and ours: the pid is alive, `/health`
 * self-identifies as agetor (guards against another service grabbing the port,
 * e.g. OTLP gRPC also defaults to 4317), and an authed `/info` probe accepts the
 * token (a 401 means the file is stale from a prior launch whose token rotated).
 */
export async function probeLiveCore(
  creds: CoreCreds,
  timeoutMs = 800,
): Promise<boolean> {
  if (!isPidAlive(creds.pid)) return false;
  const base = `http://127.0.0.1:${creds.port}`;
  try {
    const health = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!health.ok) return false;
    const hbody = (await health.json().catch(() => null)) as
      | { app?: string }
      | null;
    if (!hbody || hbody.app !== "agetor") return false;

    const info = await fetch(`${base}/info`, {
      headers: { Authorization: `Bearer ${creds.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return info.ok; // 200 → token valid; 401 → stale
  } catch {
    return false; // connection refused / timeout / DNS → not live
  }
}

/**
 * Poll until nothing is listening on `port` (the previous owner released it),
 * or the timeout elapses. Returns true if the port became free. Used by the
 * app⇄daemon handoff (app waits for the cli-daemon to exit before binding) and
 * by the CLI daemon supervisor.
 */
export async function waitForPortFree(
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(250),
      });
      await res.body?.cancel().catch(() => {});
      // Still answering → the previous owner hasn't released the port yet.
    } catch (e) {
      // A timeout means something is still bound but slow to answer — keep
      // waiting rather than declaring the port free (declaring it free too
      // early makes the caller rebind and hit EADDRINUSE). Connection-refused
      // is the real "released" signal.
      const name = (e as { name?: string })?.name;
      if (name !== "TimeoutError" && name !== "AbortError") {
        return true; // connection refused / no listener → free
      }
    }
    await Bun.sleep(150);
  }
  return false;
}
