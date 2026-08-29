import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  type WriteStream,
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  /** Port the per-worker/per-test stub GitHub API server should (or does)
   *  listen on — see `e2e/github-stub.ts`. The backend is launched with
   *  `AGETOR_GITHUB_API_BASE` pointed at this port, so a spec that starts
   *  `startGitHubStub(backend.githubStubPort, routes)` transparently becomes
   *  the app's GitHub API for the lifetime of that backend. */
  githubStubPort: number;
  /** Directory `POST /refs/pick` returns from in this headless backend.
   *  Use `plantPicks` — it clears first; the dir is worker-shared, so a
   *  spec that writes into it directly can leak stale files into a later
   *  spec's "files" pick. See the seam in server.ts. */
  fakePickDir: string;
  /** Clears `fakePickDir` (it's worker-shared, so a spec's leftover files
   *  would otherwise leak into the next spec's "files"-mode pick) and
   *  replants it with the given `{ name: content }` entries, returning
   *  their absolute paths in the same key order. Call this instead of
   *  writing into `fakePickDir` by hand before exercising the
   *  Files/Folder picker buttons. */
  plantPicks: (files: Record<string, string>) => Promise<string[]>;
}

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

// Disjoint from 4317 (packaged app default), 4318 (legacy single-shared e2e
// port), and 4399-4531 (bun unit tests, one static port per file).
const BASE_API_PORT = 4600;

// Overridable so a slow/loaded machine (many concurrent worker backends
// booting at once) can widen the budget without editing source — mirrors the
// old webServer timeout, which this fixture's health poll effectively
// replaced per worker.
const HEALTH_TIMEOUT_MS = Number(process.env.E2E_HEALTH_TIMEOUT_MS ?? 60_000);
const HEALTH_POLL_INTERVAL_MS = 200;
const TEARDOWN_GRACE_MS = 4_000;
const FINAL_KILL_WAIT_MS = 2_000;
const PREFLIGHT_TIMEOUT_MS = 2_000;

/**
 * fx's availability probe (`checkHarness` in src/bun/agent-status.ts) is a
 * DUAL probe — `--version` (generic, same as every other harness) AND
 * `--help`, whose output must contain "coding agent" — because the bare
 * name `fx` collides with an unrelated npm JSON-viewer CLI, and `--version`
 * alone can't tell them apart. That probe runs regardless of
 * `AGETOR_FX_DRIVER=fake` (the driver override only replaces `spawnAgent`'s
 * fx branch, not the separate start-task pre-flight), so a bare `/bin/echo`
 * — good enough for claude's probe below — would fail fx's `--help` check
 * and `startTask` would reject every fx run before the fake driver ever ran.
 * This stub script mirrors the one `src/bun/orchestrator-fx.test.ts` writes
 * for the identical reason.
 *
 * Written inside the given `dataDir` (a subdirectory, so it can't collide
 * with anything `headless.ts` itself creates there) rather than at its own
 * module-scope temp dir — `dataDir` is already `rm -rf`'d by
 * `provisionBackend`'s teardown (both the success and pre-health-check
 * failure paths), so the stub is cleaned up for free instead of leaking a
 * bare `mkdtempSync` directory per importing process for the lifetime of the
 * machine. Callers must invoke this after `dataDir` exists but before
 * spawning the backend, since `AGETOR_FX_BIN` must already point at an
 * executable file by the time `headless.ts` starts probing it.
 *
 * Also answers `fx models --json` (`src/bun/agent-discovery.ts`'s
 * `discoverFx`, added by `docs/plans/fx-model-catalog-refresh.md`), which
 * every enabled fx harness gets probed with — at boot, on enable, on manual
 * ↻, and periodically. Without a real answer here that probe would resolve
 * to an empty catalog (a malformed/non-JSON response degrades to `[]`,
 * never a throw — see `parseFxModels`), which would make every fx-model-
 * picker e2e assertion trivially true against an empty list instead of
 * proving the account-scoped merge (`mergeModelOptions`,
 * curated ∩ discovered + discovered-only) actually happened. The three ids
 * below are deliberately a small, fixed catalog independent of the real
 * fx.sh Gateway catalog: two overlap curated `AGENT_OPTIONS.fx.models` rows
 * (`zai/glm-5.3-flash` — the curated default — and `openai/gpt-5.2`) to
 * exercise the "curated ∩ discovered" intersection, and one
 * (`e2e/discovered-only`) has no curated row at all, to exercise the
 * discovered-only-id append path. Deliberately still NOT implementing
 * `status --json` — that keeps the pre-flight auth check failing OPEN
 * (`loggedIn: null`) against this stub, exactly as documented above and in
 * CLAUDE.md's fx bullet, so no e2e spec (this file's callers included) is
 * ever blocked by the auth pre-flight.
 */
function writeFxStubBin(dataDir: string): string {
  const binDir = path.join(dataDir, "fx-stub-bin");
  mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, "fx");
  writeFileSync(
    binPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "--help" ]; then',
      '  echo "Fast, native coding agent for the terminal"',
      "  exit 0",
      "fi",
      'if [ "$1" = "--version" ]; then',
      '  echo "0.0.4-fake"',
      "  exit 0",
      "fi",
      'if [ "$1" = "models" ] && [ "$2" = "--json" ]; then',
      '  echo \'{"kind":"models","count":3,"shown_count":3,"more_count":0,"private_models_hidden":false,"ids":["zai/glm-5.3-flash","openai/gpt-5.2","e2e/discovered-only"]}\'',
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

async function tailFile(filePath: string, maxBytes = 4_000): Promise<string> {
  if (!existsSync(filePath)) return `<${filePath} not found>`;
  try {
    const contents = await readFile(filePath, "utf8");
    return contents.slice(-maxBytes);
  } catch {
    return `<${filePath} unreadable>`;
  }
}

/** headless.ts's real diagnostics (bind failures, shutdown reason, idle
 *  reaper errors) go through `daemonLog` to `<dataDir>/daemon.log`, NOT to
 *  the piped stdout/stderr in `backend.log` — most startup failures leave
 *  backend.log empty and the useful signal in daemon.log. Tail both so a
 *  failure message always points at the actual cause. */
async function formatLogTails(logFile: string, daemonLogFile: string): Promise<string> {
  const [stdoutTail, daemonTail] = await Promise.all([tailFile(logFile), tailFile(daemonLogFile)]);
  return (
    `--- stdout/stderr tail (${logFile}) ---\n${stdoutTail}\n` +
    `--- daemon log tail (${daemonLogFile}) ---\n${daemonTail}`
  );
}

/** Pre-flight guard against adopting a stale/foreign backend: `/health` is
 *  unauthenticated, so if anything is already listening on this worker's
 *  port (an orphaned headless.ts from a prior interrupted run, most likely)
 *  the post-spawn health poll would happily treat it as "ours" — the token
 *  mismatch would only surface later, on the first authenticated request,
 *  far from this fixture and hard to diagnose. Fail fast here instead. */
async function assertPortFree(apiBase: string, apiPort: number): Promise<void> {
  let answered: boolean;
  try {
    await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS) });
    answered = true;
  } catch {
    answered = false; // connection refused/timed out — port is free, proceed
  }
  if (!answered) return;
  throw new Error(
    `port ${apiPort} is already serving something (pre-flight GET ${apiBase}/health got a ` +
      `response before we spawned anything) — a stale headless.ts from a prior run is the ` +
      `likely cause. Recover with:\n  lsof -ti :${apiPort} | xargs kill`,
  );
}

async function waitForHealth(apiBase: string): Promise<void> {
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
  throw new Error(
    `headless backend at ${apiBase} never became healthy within ${HEALTH_TIMEOUT_MS}ms` +
      (lastError ? ` (last poll error: ${String(lastError)})` : ""),
  );
}

/** SIGTERM, wait up to TEARDOWN_GRACE_MS for a clean exit, SIGKILL fallback.
 *  Resolves once the process has exited (or we've waited as long as we're
 *  willing to), so the caller can `rm -rf` the data dir right after without
 *  racing a still-shutting-down SQLite connection. Never hangs: a child that
 *  never spawned (`pid === undefined`, e.g. `bun` missing from PATH raised
 *  ENOENT) has nothing to wait for, and the post-SIGKILL wait is bounded —
 *  a process wedged in uninterruptible I/O would otherwise stall teardown
 *  forever. */
async function killGracefully(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;

  let settled = false;
  const exited = new Promise<void>((resolve) => {
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // ENOENT-style spawn failures can emit 'error'+'close' without ever
    // firing 'exit'; listen for both so we don't wait on the one that never
    // comes.
    child.once("exit", done);
    child.once("close", done);
  });

  child.kill("SIGTERM");
  const timedOut = await Promise.race([
    exited.then(() => false as const),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), TEARDOWN_GRACE_MS)),
  ]);
  if (timedOut) {
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, FINAL_KILL_WAIT_MS))]);
  }
}

/**
 * Spawns one `headless.ts` backend on `apiPort`/`apiToken`, waits for it to
 * become healthy, hands it to `use()`, and tears it down afterward. Shared by
 * both `backend` (worker-scoped — one long-lived instance reused by every
 * test in a worker) and `freshBackend` (test-scoped — a brand-new instance
 * per test; see that fixture's doc comment for why it exists) below.
 * `logLabel` only affects log/error messages (e.g. "worker 2" vs a test
 * title) so a startup failure or mid-suite-death report points at the right
 * instance.
 */
async function provisionBackend(
  apiPort: number,
  apiToken: string,
  githubStubPort: number,
  logLabel: string,
  use: (backend: E2EBackend) => Promise<void>,
): Promise<void> {
  const apiBase = `http://127.0.0.1:${apiPort}`;

  await assertPortFree(apiBase, apiPort);

  const dataDir = await mkdtemp(path.join(tmpdir(), "agetor-e2e-"));
  const logFile = path.join(dataDir, "backend.log");
  const daemonLogFile = path.join(dataDir, "daemon.log");
  // Must happen before the spawn below — see writeFxStubBin's doc comment.
  const fxStubBinPath = writeFxStubBin(dataDir);
  // Backs the `/refs/pick` test seam (src/bun/server.ts) — a spec plants
  // files here, then clicks the picker's Files/Folder button, and the
  // headless backend returns them instead of opening a native panel that
  // doesn't exist in this environment. Created up front (like the fx stub
  // bin above) so a spec can write into it before the backend even boots.
  const fakePickDir = path.join(dataDir, "fake-picks");
  mkdirSync(fakePickDir, { recursive: true });

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
      // 10 min, not disabled (0): the idle-shutdown loop in headless.ts
      // only fires once there's been no running run AND no attached
      // client for the whole timeout, so it can't trip during an active
      // suite. What it buys us: if this fixture's own teardown ever
      // fails to kill the child (crash, bug), the backend self-reaps
      // instead of squatting on its port forever.
      AGETOR_DAEMON_IDLE_MS: "600000",
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
      // fx routes through the in-process fake driver (spawnAgent's fx
      // branch) exactly like claude-code above, and e2e/fx-interactions
      // .spec.ts exercises it — this is not inert. Unlike claude, whose
      // start-task pre-flight is satisfied by a binary-shaped `/bin/echo`,
      // fx's `checkHarness` (agent-status.ts) dual-probes `--version` AND
      // `--help`, requiring "coding agent" in the `--help` output to
      // disambiguate Vercel's fx from an unrelated npm JSON-viewer CLI of
      // the same name — that probe runs regardless of the driver override,
      // so `AGETOR_FX_BIN` points at the stub script written into this
      // backend's own `dataDir` above (mirrors
      // `src/bun/orchestrator-fx.test.ts`'s) instead of `/bin/echo`. Note:
      // codex/cursor/gemini have no equivalent fake-driver wiring in this
      // fixture — no spec here starts a run on any of them.
      AGETOR_FX_DRIVER: "fake",
      AGETOR_FX_BIN: fxStubBinPath,
      // Points every GitHub REST/GraphQL call this backend makes at a local
      // stub server instead of the real api.github.com (see
      // src/bun/github.ts's `GITHUB_API_BASE` seam and e2e/github-stub.ts).
      // Specs that never open the Git dialog never hit this — it's inert
      // until something calls startGitHubStub(backend.githubStubPort, ...).
      AGETOR_GITHUB_API_BASE: `http://127.0.0.1:${githubStubPort}`,
      // Test seam for `/refs/pick` (src/bun/server.ts) — see fakePickDir
      // above. Never set in production launches.
      AGETOR_FAKE_PICK_REFS_DIR: fakePickDir,
      // So `githubToken()` resolves this literal token from env and never
      // shells out to `gh auth token` on the dev machine (which could hang,
      // fail, or leak a real token into a test run).
      GITHUB_TOKEN: "e2e-github-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  // Surfaces a backend that dies mid-suite (crash, OOM, someone `kill`s
  // it by hand) instead of leaving it silent — later tests would just
  // see ECONNREFUSED and point at the wrong thing. Guarded by
  // `tearingDown` so our own intentional kill in the teardown path below
  // isn't misreported as a mid-suite death.
  let tearingDown = false;
  // Boxed in an object (rather than a bare reassigned `let`) so TS
  // doesn't narrow the read below back to `null` across the intervening
  // `await use(backend)` — a plain closure-mutated `let` loses that
  // narrowing.
  const deathReport: { info: { code: number | null; signal: NodeJS.Signals | null } | null } = {
    info: null,
  };
  child.on("exit", (code, signal) => {
    if (!tearingDown) deathReport.info = { code, signal };
  });

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
    await Promise.race([waitForHealth(apiBase), spawnError]);
    // `/health` answered, but confirm it was actually *our* child that
    // answered it and not some other process that raced in and bound
    // the port after assertPortFree's pre-flight check but before (or
    // during) our own spawn — e.g. our child crashed immediately after
    // binding and something else grabbed the now-free port before this
    // check ran.
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `${apiBase}/health answered but our child (pid ${child.pid}) had already exited ` +
          `(code=${child.exitCode}, signal=${child.signalCode}) — another process owns that port.`,
      );
    }
  } catch (err) {
    const tails = await formatLogTails(logFile, daemonLogFile);
    tearingDown = true;
    await killGracefully(child);
    logStream.end();
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`${(err as Error).message}\n${tails}`);
  }

  // Backs `E2EBackend.plantPicks` — see its JSDoc on the interface above.
  // Closes over `fakePickDir` so callers never have to pass it themselves.
  async function plantPicks(files: Record<string, string>): Promise<string[]> {
    await rm(fakePickDir, { recursive: true, force: true });
    await mkdir(fakePickDir, { recursive: true });
    const paths: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(fakePickDir, name);
      await writeFile(filePath, content);
      paths.push(filePath);
    }
    return paths;
  }

  const backend: E2EBackend = {
    apiPort,
    apiToken,
    apiBase,
    bootBase: `${E2E_BASE_URL}/#api=${apiPort}&token=${apiToken}`,
    dataDir,
    githubStubPort,
    fakePickDir,
    plantPicks,
  };

  await use(backend);

  if (deathReport.info) {
    const tails = await formatLogTails(logFile, daemonLogFile);
    // eslint-disable-next-line no-console -- deliberate loud stderr so the
    // report points at infrastructure, not a flaky test.
    console.error(
      `[e2e] backend for ${logLabel} died mid-suite: ` +
        `code=${deathReport.info.code} signal=${deathReport.info.signal}\n${tails}`,
    );
  }

  tearingDown = true;
  await killGracefully(child);
  logStream.end();
  if (process.env.E2E_KEEP_DATA_DIR) {
    console.log(`[e2e] E2E_KEEP_DATA_DIR set — keeping ${dataDir}`);
  } else {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Disjoint from BASE_API_PORT's worker range (4600 + up to ~workers) with a
// wide gap — `freshBackend` below is test-scoped, so at most a handful of
// these run concurrently even on a many-worker machine.
const FRESH_BASE_API_PORT = 4700;

// Disjoint from BASE_API_PORT (4600+) and FRESH_BASE_API_PORT (4700+) above —
// each worker's (and each freshBackend test's) stub GitHub API server gets
// its own port so parallel workers/tests never collide on it, mirroring how
// the two API-port ranges stay disjoint from each other.
const GITHUB_STUB_BASE_PORT = 4800;
const FRESH_GITHUB_STUB_BASE_PORT = 4900;

export const test = base.extend<{ freshBackend: E2EBackend }, { backend: E2EBackend }>({
  backend: [
    async ({}, use, workerInfo) => {
      // `parallelIndex` is the stable 0..(workers-1) slot this worker
      // process occupies for the whole run; `workerIndex` increments every
      // time Playwright restarts a worker (e.g. after a crash), so a
      // restarted worker could reuse another worker's still-live
      // `workerIndex`-derived port. `parallelIndex` never collides with a
      // concurrently-running worker, which is what a port assignment needs.
      const apiPort = BASE_API_PORT + workerInfo.parallelIndex;
      // Random, not deterministic: a deterministic per-worker token would
      // let a stale backend still bound to this port (see assertPortFree
      // above) silently authenticate as "ours" if the pre-flight check ever
      // raced it. A random token makes any such impostor fail auth loudly
      // instead.
      const apiToken = `e2e-w${workerInfo.parallelIndex}-${randomUUID()}`;
      const githubStubPort = GITHUB_STUB_BASE_PORT + workerInfo.parallelIndex;
      await provisionBackend(apiPort, apiToken, githubStubPort, `worker ${workerInfo.parallelIndex}`, use);
    },
    { scope: "worker" },
  ],

  // Test-scoped: a brand-new headless backend + SQLite DB spawned for this
  // one test and torn down right after, unlike `backend` above (worker-
  // scoped, shared by every test in the file). theme/font-size/quote reset
  // the one preference they care about before each test and are fine sharing
  // a DB. Onboarding can't do that: `resolveOnboardingVisibility` (src/
  // mainview/lib/onboarding.ts) branches on whether `onboardingDismissed` has
  // *ever* been written (`dismissedPref === undefined`), and there is no
  // "unset preference" API — once any test writes that key (directly, via
  // Skip/Dismiss, or via the auto-dismiss-when-all-steps-done effect), no
  // later test sharing that DB could ever observe the "never evaluated"
  // state again. Several onboarding.spec.ts cases need exactly that state
  // independently (fresh welcome dialog, skip-then-persist, existing-user
  // auto-dismiss), so each gets its own virgin backend instead of fighting
  // over one shared DB.
  freshBackend: async ({}, use, testInfo) => {
    const apiPort = FRESH_BASE_API_PORT + testInfo.parallelIndex;
    const apiToken = `e2e-fresh-w${testInfo.parallelIndex}-${randomUUID()}`;
    const githubStubPort = FRESH_GITHUB_STUB_BASE_PORT + testInfo.parallelIndex;
    await provisionBackend(apiPort, apiToken, githubStubPort, `test "${testInfo.title}"`, use);
  },
});
