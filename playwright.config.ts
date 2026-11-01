import { defineConfig, devices } from "@playwright/test";

/**
 * E2E harness for the theme, font-size, and quote-on-select features
 * (docs/plans/auto-dark-light-theme.md T10, cmd-font-size-controller.md T4,
 * quote-messages-list.md §5 TT2). Drives Chromium against two pieces of real
 * infrastructure — no mocked fetches, no component harness standing in for
 * the actual DOM:
 *
 *   - **One shared Vite dev server** (`bun run hmr`, :5173), started by the
 *     `webServer` block below. Vite must stay single-instance — it's pinned
 *     to `port: 5173, strictPort: true` (vite.config.ts) — and CAN be
 *     shared across every worker's browser context, because it's stateless:
 *     each worker's page just carries its own backend's port/token on the
 *     `#api=<port>&token=<token>` URL hash, which the client already reads
 *     at boot (src/mainview/lib/api.ts).
 *   - **One headless Bun backend per Playwright worker** (its own
 *     `AGETOR_DATA_DIR`, `AGETOR_API_PORT`, and token), provisioned by the
 *     worker-scoped `backend` fixture in e2e/fixtures.ts. Because each
 *     worker's SQLite state (theme/fontSize preferences, tasks) is fully
 *     isolated from every other worker's, spec files can run in parallel
 *     without racing each other — see e2e/fixtures.ts for spawn/health-poll/
 *     teardown, and e2e/helpers.ts for the gotoApp/openSettingsGeneral/
 *     preference helpers shared across specs, both parametrized by the
 *     worker's `E2EBackend`.
 *
 * `docs/plans/e2e-per-worker-backends.md` has the full design; this config
 * used to also own backend spawning (a single shared `scripts/dev-headless
 * .sh`-driven backend gated behind `workers: 1`) before that moved to the
 * per-worker fixture.
 */
/** An integer env var in `[min, max]`, `fallback` when unset or blank. Any
 *  other value throws, so a typo fails the run when the config loads instead
 *  of turning every derived port into `NaN`. */
export function e2eIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim() ?? "";
  if (raw === "") return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max} (got "${raw}")`);
  }
  return value;
}

/** Ports Chromium refuses to connect to (`ERR_UNSAFE_PORT`, its
 *  `kRestrictedPorts` list in net/base/port_util.cc). Every e2e page loads the
 *  webview from the Vite port and calls its worker's backend on an API port,
 *  so landing either on one of these fails every request in the browser with
 *  a network error that never mentions the port. */
export const CHROMIUM_RESTRICTED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103,
  104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513,
  514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** `port` unchanged, or a thrown error when Chromium would refuse to connect
 *  to it. `name` says which override or range produced it, so the fix (a
 *  different value) is obvious. Allowed ports pass straight through. */
export function assertBrowserSafePort(name: string, port: number): number {
  if (CHROMIUM_RESTRICTED_PORTS.has(port)) {
    throw new Error(
      `${name} resolved to port ${port}, which Chromium blocks (ERR_UNSAFE_PORT) — choose a different AGETOR_E2E_VITE_PORT / AGETOR_E2E_PORT_OFFSET`,
    );
  }
  return port;
}

// `AGETOR_E2E_VITE_PORT` moves the shared Vite server off :5173 for one run —
// needed when another checkout's dev server already holds :5173, because
// `reuseExistingServer` would otherwise silently serve THAT checkout's webview.
export const E2E_VITE_PORT = assertBrowserSafePort(
  "AGETOR_E2E_VITE_PORT",
  e2eIntEnv("AGETOR_E2E_VITE_PORT", 5173, 1, 65535),
);
export const E2E_BASE_URL = `http://localhost:${E2E_VITE_PORT}`;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  // `fullyParallel: false` only serializes tests WITHIN a file — Playwright
  // still gives each spec file its own worker, and (since e2e/fixtures.ts)
  // each worker now owns its own headless backend + data dir, so cross-file
  // races on shared preference state are no longer possible. That's what
  // let the old `workers: 1` cap (needed when every worker hit one shared
  // backend) go away.
  retries: 0,
  reporter: process.env.CI ? [["list"]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: E2E_VITE_PORT === 5173 ? "bun run hmr" : `bunx vite --port ${E2E_VITE_PORT}`,
    url: E2E_BASE_URL,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
  },
});
