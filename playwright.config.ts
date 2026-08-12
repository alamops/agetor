import { defineConfig, devices } from "@playwright/test";

/**
 * E2E harness for the theme feature (docs/plans/auto-dark-light-theme.md,
 * T10). Drives the real Bun API + orchestrator via `scripts/dev-headless.sh`
 * (landed in 94b1f2d) — no Electrobun window, just Vite on :5173 and the
 * headless backend — against Chromium. This is the "spike verdict" recipe
 * from the plan's §2, not a fresh exploration.
 *
 * Pinning `AGETOR_API_TOKEN` (rather than scraping the token file
 * `dev-headless.sh` persists to `$AGETOR_DATA_DIR/headless-dev/token`) keeps
 * the harness deterministic. This is a disposable, e2e-only value — the API
 * it authorizes is loopback-bound (127.0.0.1) and only lives for the
 * duration of `bun run test:e2e`.
 *
 * `AGETOR_DATA_DIR` is a dedicated `~/.agetor-dev-e2e` directory, distinct
 * from both the real `~/.agetor` (never touch — that's the user's live data)
 * and `~/.agetor-dev` (the interactive `bun run dev:hmr` dir) so an
 * automated test run can't disturb either.
 */
export const E2E_VITE_PORT = 5173;
export const E2E_API_PORT = 4318;
export const E2E_API_TOKEN =
  "e2e0000000000000000000000000000000000000000000000000000000000";
export const E2E_DATA_DIR = `${process.env.HOME}/.agetor-dev-e2e`;
export const E2E_BASE_URL = `http://localhost:${E2E_VITE_PORT}`;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  // `fullyParallel: false` only serializes tests WITHIN a file — Playwright
  // still gives each spec file its own worker, and every worker hits the one
  // shared headless backend + SQLite data dir. Cross-file races on shared
  // preference state (theme, fontSize) flake the suite; one worker keeps it
  // deterministic.
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["list"]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // `dev-headless.sh start` backgrounds the actual vite/bun processes via
    // `nohup … &` and returns immediately once the API is healthy — so the
    // command Playwright spawns wouldn't otherwise stay alive for it to
    // manage. Trapping SIGTERM/SIGINT/EXIT to run `… stop` and then tailing
    // the logs (keeping the shell in the foreground) lets Playwright's
    // normal "kill the webServer process on teardown" path double as the
    // proven recipe's teardown step, without a separate globalTeardown file.
    command:
      'bash -c \'trap "scripts/dev-headless.sh stop" EXIT INT TERM; scripts/dev-headless.sh start; tail -f "$AGETOR_DATA_DIR/headless-dev/backend.log" "$AGETOR_DATA_DIR/headless-dev/vite.log"\'',
    // The backend (not vite) is the slower, dependency-bearing half — vite
    // typically answers on :5173 within a few hundred ms, well before the
    // Bun API has finished opening/migrating SQLite. Gating readiness on
    // vite alone let Playwright start running tests (which hit the API
    // directly, e.g. `setThemePreference`) before the backend was actually
    // listening, causing an intermittent ECONNREFUSED. Health-checking the
    // backend instead is a stronger guarantee, since `dev-headless.sh`
    // starts vite first — by the time the backend is healthy, vite has had
    // even more of a head start.
    url: `http://127.0.0.1:${E2E_API_PORT}/health`,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    env: {
      AGETOR_DATA_DIR: E2E_DATA_DIR,
      AGETOR_API_PORT: String(E2E_API_PORT),
      AGETOR_API_TOKEN: E2E_API_TOKEN,
      // Added for e2e/quote.spec.ts (docs/plans/quote-messages-list.md §5
      // TT2). Same fake-driver combo `orchestrator.test.ts` uses: with
      // AGETOR_CLAUDE_DRIVER=fake, spawnAgent's claude-code branch returns an
      // in-process fake agent instead of shelling out to tmux, so a run can
      // be driven end to end without a real `claude` CLI or tmux session.
      // `checkHarness` (the start-task pre-flight) is a separate code path
      // that doesn't know about the driver override — it still resolves a
      // `claude`-shaped binary AND a tmux binary regardless — so
      // AGETOR_CLAUDE_BIN/AGETOR_TMUX_BIN point both at `/bin/echo` (always
      // present) purely to satisfy that probe; AGETOR_CLAUDE_ARGS is cleared
      // so buildCommand's argv (recorded by the fake but never executed)
      // isn't polluted by an inherited shell override. Inert for
      // theme.spec.ts, which never starts a run.
      AGETOR_CLAUDE_DRIVER: "fake",
      AGETOR_CLAUDE_BIN: "/bin/echo",
      AGETOR_TMUX_BIN: "/bin/echo",
      AGETOR_CLAUDE_ARGS: "",
    },
  },
});
