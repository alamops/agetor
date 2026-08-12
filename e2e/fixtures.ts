import { type ChildProcess, spawn } from "node:child_process";
import { type WriteStream, createWriteStream, existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";
import { E2E_BASE_URL } from "../playwright.config";

export { expect } from "@playwright/test";
export type { APIRequestContext, Locator, Page } from "@playwright/test";

/**
 * Worker-scoped headless-backend fixture (docs/plans/e2e-per-worker-backends
 * .md §3). Each Playwright worker spawns its own `bun src/bun/headless.ts`
 * on a dedicated data dir + port + token, so `bunx playwright test` can run
 * every spec file's worker in parallel without any of them racing shared
 * SQLite preference/task state. Vite stays single-instance and shared — see
 * `playwright.config.ts`'s `webServer` block.
 */
export interface E2EBackend {
  apiPort: number;
  apiToken: string;
  apiBase: string;
  bootBase: string;
  dataDir: string;
}

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

// Disjoint from 4317 (packaged app default), 4318 (legacy single-shared e2e
// port), and 4399-4531 (bun unit tests, one static port per file).
const BASE_API_PORT = 4600;

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 200;
const TEARDOWN_GRACE_MS = 4_000;

async function waitForHealth(apiBase: string, logFile: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiBase}/health`);
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }

  const logTail = existsSync(logFile)
    ? await readFile(logFile, "utf8")
        .then((s) => s.slice(-4_000))
        .catch(() => "<log file unreadable>")
    : "<no log file>";
  throw new Error(
    `headless backend at ${apiBase} never became healthy within ${HEALTH_TIMEOUT_MS}ms` +
      (lastError ? ` (last poll error: ${String(lastError)})` : "") +
      `\n--- log tail (${logFile}) ---\n${logTail}`,
  );
}

/** SIGTERM, wait up to TEARDOWN_GRACE_MS for a clean exit, SIGKILL fallback.
 *  Resolves only once the process has actually exited, so the caller can
 *  safely `rm -rf` the data dir right after (no file-lock/EBUSY race with a
 *  still-shutting-down SQLite connection). */
async function killGracefully(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timedOut = await Promise.race([
    exited.then(() => false as const),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), TEARDOWN_GRACE_MS)),
  ]);
  if (timedOut) {
    child.kill("SIGKILL");
    await exited;
  }
}

export const test = base.extend<{}, { backend: E2EBackend }>({
  backend: [
    async ({}, use, workerInfo) => {
      // `parallelIndex` is the stable 0..(workers-1) slot this worker
      // process occupies for the whole run; `workerIndex` increments every
      // time Playwright restarts a worker (e.g. after a crash), so a
      // restarted worker could reuse another worker's still-live
      // `workerIndex`-derived port. `parallelIndex` never collides with a
      // concurrently-running worker, which is what a port assignment needs.
      const apiPort = BASE_API_PORT + workerInfo.parallelIndex;
      const apiToken = `e2e-worker-token-${workerInfo.parallelIndex}`;
      const dataDir = await mkdtemp(path.join(tmpdir(), "agetor-e2e-"));
      const apiBase = `http://127.0.0.1:${apiPort}`;
      const logFile = path.join(dataDir, "backend.log");

      const logStream: WriteStream = createWriteStream(logFile);
      await new Promise<void>((resolve, reject) => {
        logStream.once("open", () => resolve());
        logStream.once("error", reject);
      });

      const child = spawn("bun", ["src/bun/headless.ts"], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          AGETOR_DATA_DIR: dataDir,
          AGETOR_API_PORT: String(apiPort),
          AGETOR_API_TOKEN: apiToken,
          // Disables headless.ts's idle self-shutdown (defaults to ~5min) —
          // a worker's backend must stay up for the whole run regardless of
          // gaps between tests.
          AGETOR_DAEMON_IDLE_MS: "0",
          // Same fake-driver combo orchestrator.test.ts uses: with
          // AGETOR_CLAUDE_DRIVER=fake, spawnAgent's claude-code branch
          // returns an in-process fake agent instead of shelling out to
          // tmux. checkHarness (the start-task pre-flight) is a separate
          // code path that doesn't know about the driver override — it
          // still resolves a claude-shaped binary AND a tmux binary
          // regardless — so AGETOR_CLAUDE_BIN/AGETOR_TMUX_BIN point both at
          // `/bin/echo` (always present) purely to satisfy that probe;
          // AGETOR_CLAUDE_ARGS is cleared so buildCommand's argv (recorded
          // by the fake but never executed) isn't polluted by an inherited
          // shell override. Required by quote.spec.ts; inert for the other
          // specs, which never start a run.
          AGETOR_CLAUDE_DRIVER: "fake",
          AGETOR_CLAUDE_BIN: "/bin/echo",
          AGETOR_TMUX_BIN: "/bin/echo",
          AGETOR_CLAUDE_ARGS: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.pipe(logStream);
      child.stderr?.pipe(logStream);

      // Race the health poll against an early exit/spawn failure (e.g. `bun`
      // not on PATH, or headless.ts throwing before it binds) so a
      // misconfigured child fails fast with a useful error instead of
      // burning the full health-poll timeout. `.catch(() => {})` on the
      // standalone reference keeps a late rejection (the child exiting
      // normally during teardown, well after the race has already resolved)
      // from surfacing as an unhandled rejection.
      const spawnError = new Promise<never>((_, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          reject(new Error(`headless backend exited early (code=${code}, signal=${signal})`));
        });
      });
      spawnError.catch(() => {});

      try {
        await Promise.race([waitForHealth(apiBase, logFile), spawnError]);
      } catch (err) {
        await killGracefully(child);
        logStream.end();
        await rm(dataDir, { recursive: true, force: true }).catch(() => {});
        throw err;
      }

      const backend: E2EBackend = {
        apiPort,
        apiToken,
        apiBase,
        bootBase: `${E2E_BASE_URL}/#api=${apiPort}&token=${apiToken}`,
        dataDir,
      };

      await use(backend);

      await killGracefully(child);
      logStream.end();
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    },
    { scope: "worker" },
  ],
});
