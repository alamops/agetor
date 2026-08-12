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
export const E2E_VITE_PORT = 5173;
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
    command: "bun run hmr",
    url: E2E_BASE_URL,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
  },
});
