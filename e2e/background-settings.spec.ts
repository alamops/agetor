import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp, openSettingsGeneral } from "./helpers";

/**
 * E2E for Settings → General → "Keep Agetor running in the background" and the
 * remote-access (preview) row (docs/plans/always-on-host.md §5 row E1, grill
 * C3/C9/C17).
 *
 * Nothing here talks to macOS. The headless backend runs with
 * `AGETOR_FAKE_LOGIN_ITEM=1`, which swaps the Swift login-item helper for a
 * file-backed fake at `<dataDir>/fake-login-item.json`
 * (`{ registration, info?, calls[] }` — every helper command the core issues
 * is appended to `calls`) and makes `background.ts` treat the platform as
 * darwin. The supervisor side is a second file, `<dataDir>/login-daemon.json`
 * (`LoginDaemonState`): a state is "parked" / "stopped" depending on whether a
 * LIVE supervisor is recorded there, and "live" only means the recorded pid is
 * alive — so the spec records its own `process.pid`.
 *
 * Every test uses `freshBackend` (a brand-new backend per test): the fake
 * remote-access seed (`AGETOR_FAKE_REMOTE_ACCESS=on`) is applied once per core
 * process, and the worker-shared `backend` fixture ignores `backendEnv`
 * entirely, so a shared backend could neither take the env nor start each
 * remote test from "on" again.
 *
 * The status is cached for 2 s core-side and the section re-reads every 5 s,
 * so the seed is always written BEFORE Settings is opened (the first read is
 * the one that sees it), and later assertions lean on `expect` retries rather
 * than fixed sleeps.
 */

const FAKE_FILE = "fake-login-item.json";
const SUPERVISOR_FILE = "login-daemon.json";

type Registration = "notRegistered" | "enabled" | "requiresApproval" | "notFound";

function fakePath(backend: E2EBackend): string {
  return path.join(backend.dataDir, FAKE_FILE);
}

function seedFakeHelper(
  backend: E2EBackend,
  seed: { registration: Registration; info?: Record<string, unknown> },
): void {
  mkdirSync(backend.dataDir, { recursive: true });
  writeFileSync(fakePath(backend), JSON.stringify({ ...seed, calls: [] }, null, 2));
}

/** The helper commands the core has issued so far (info/status polls included). */
function fakeCalls(backend: E2EBackend): string[] {
  try {
    const raw = JSON.parse(readFileSync(fakePath(backend), "utf8")) as { calls?: unknown };
    return Array.isArray(raw.calls) ? raw.calls.filter((c): c is string => typeof c === "string") : [];
  } catch {
    // The core rewrites the file on every call; a read can land mid-rename.
    return [];
  }
}

/** Record the Playwright worker itself as a live supervisor (`liveSupervisor`
 *  only checks that the pid is alive and the state isn't "stopped"). */
function seedSupervisor(backend: E2EBackend, state: "parked" | "running"): void {
  const now = Date.now();
  writeFileSync(
    path.join(backend.dataDir, SUPERVISOR_FILE),
    JSON.stringify({
      pid: process.pid,
      state,
      corePid: state === "running" ? process.pid : null,
      bundlePath: "/Applications/Agetor.app",
      version: "0.0.0-e2e",
      label: "sh.alamops.agetor.daemon",
      startedAt: now,
      updatedAt: now,
    }),
  );
}

async function openBackgroundSection(page: Page, backend: E2EBackend): Promise<Locator> {
  await gotoApp(page, backend.bootBase);
  const dialog = await openSettingsGeneral(page);
  const section = dialog.getByTestId("background-section");
  await expect(section).toBeVisible();
  return section;
}

async function remoteAccessEnabled(backend: E2EBackend, request: Page["request"]): Promise<boolean> {
  const res = await request.get(`${backend.apiBase}/remote-access`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
  });
  expect(res.ok(), `GET /remote-access -> ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { enabled: boolean }).enabled;
}

test.describe("Settings → Keep Agetor running in the background", () => {
  test.use({ backendEnv: { AGETOR_FAKE_LOGIN_ITEM: "1" } });

  test("off → turning it on registers the item, reads 'starting' until the supervisor reports, then 'parked'", async ({
    page,
    freshBackend,
  }) => {
    seedFakeHelper(freshBackend, { registration: "notRegistered" });
    // Deliberately NO supervisor file yet: right after `register` launchd has
    // not started the supervisor, so the status must read "starting" (the
    // grace window in background.ts), not "stopped".

    const section = await openBackgroundSection(page, freshBackend);
    const state = section.getByTestId("background-state");
    const toggle = section.getByTestId("background-toggle");

    await expect(state).toHaveText("Off", { timeout: 15_000 });
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await toggle.click();

    await expect(state).toHaveText("On — starting…", { timeout: 15_000 });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(fakeCalls(freshBackend)).toContain("register");

    // The supervisor the registration started now writes its state file.
    seedSupervisor(freshBackend, "parked");
    await expect(state).toHaveText("On, parked while the app is open", { timeout: 20_000 });
    await expect(section.getByTestId("background-error")).toHaveCount(0);
  });

  test("needs approval → Open Login Items asks the helper to open System Settings", async ({
    page,
    freshBackend,
  }) => {
    seedFakeHelper(freshBackend, { registration: "requiresApproval" });

    const section = await openBackgroundSection(page, freshBackend);
    await expect(section.getByTestId("background-state")).toHaveText(
      "Needs approval in System Settings › Login Items",
      { timeout: 15_000 },
    );
    // Registered in any form shows the switch on; only `off` shows it off.
    await expect(section.getByTestId("background-toggle")).toHaveAttribute("aria-checked", "true");
    await expect(section.getByTestId("background-start-now")).toHaveCount(0);
    expect(fakeCalls(freshBackend)).not.toContain("openSettings");

    await section.getByTestId("background-open-login-items").click();

    await expect.poll(() => fakeCalls(freshBackend), { timeout: 15_000 }).toContain("openSettings");
    await expect(section.getByTestId("background-error")).toHaveCount(0);
  });

  test("stopped (enabled, no supervisor) → Start now re-registers the item", async ({
    page,
    freshBackend,
  }) => {
    // Enabled, and no login-daemon.json at all → nothing is running.
    seedFakeHelper(freshBackend, { registration: "enabled" });

    const section = await openBackgroundSection(page, freshBackend);
    await expect(section.getByTestId("background-state")).toHaveText(
      "On — stopped, starts again at next login",
      { timeout: 15_000 },
    );
    await expect(section.getByTestId("background-open-login-items")).toHaveCount(0);
    expect(fakeCalls(freshBackend)).not.toContain("reregister");

    await section.getByTestId("background-start-now").click();

    await expect.poll(() => fakeCalls(freshBackend), { timeout: 15_000 }).toContain("reregister");
    await expect(section.getByTestId("background-error")).toHaveCount(0);
  });

  test("unsigned build → the switch is disabled and the reason is shown", async ({
    page,
    freshBackend,
  }) => {
    seedFakeHelper(freshBackend, { registration: "notRegistered", info: { signed: false } });

    const section = await openBackgroundSection(page, freshBackend);
    await expect(section.getByTestId("background-state")).toHaveText("Unavailable", { timeout: 15_000 });
    await expect(section.getByTestId("background-unavailable")).toContainText(
      "Unavailable in unsigned builds",
    );
    const toggle = section.getByTestId("background-toggle");
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    // No action buttons while unavailable.
    await expect(section.getByTestId("background-start-now")).toHaveCount(0);
    await expect(section.getByTestId("background-open-login-items")).toHaveCount(0);
    // Nothing was registered behind the disabled switch.
    expect(fakeCalls(freshBackend)).not.toContain("register");
  });

  test("remote access reads off (with where to turn it on) when the seed is absent", async ({
    page,
    freshBackend,
  }) => {
    seedFakeHelper(freshBackend, { registration: "enabled" });
    seedSupervisor(freshBackend, "parked");

    const section = await openBackgroundSection(page, freshBackend);
    await expect(section.getByTestId("background-state")).toHaveText("On, parked while the app is open", {
      timeout: 15_000,
    });
    const remote = section.getByTestId("remote-access-state");
    await expect(remote).toHaveAttribute("data-enabled", "false");
    await expect(remote).toContainText("Turn it on from Agetor › Remote Access…");
    // The webview has no way to turn it on, so there is no switch to find.
    await expect(section.getByTestId("remote-access-turn-off")).toHaveCount(0);
  });
});

test.describe("Settings → Remote access (preview) row", () => {
  // Both keys in ONE call: a nested `test.use({ backendEnv })` replaces the
  // whole object rather than merging into it.
  test.use({ backendEnv: { AGETOR_FAKE_LOGIN_ITEM: "1", AGETOR_FAKE_REMOTE_ACCESS: "on" } });

  // These seed a live supervisor on purpose: the `AGETOR_FAKE_REMOTE_ACCESS`
  // seed writes the preference directly, and remote access must NOT stay on
  // over a host that isn't running (C3), so the rows below need a real host
  // under them. The native Remote Access… box (register → remote on, before
  // the supervisor's first state file) can't be driven from a browser; that
  // race is pinned by src/bun/remote-access-box.test.ts and background.test.ts.

  test("shows on over a parked host; Turn off switches it off and the host stays on", async ({
    page,
    request,
    freshBackend,
  }) => {
    seedFakeHelper(freshBackend, { registration: "enabled" });
    seedSupervisor(freshBackend, "parked");

    const section = await openBackgroundSection(page, freshBackend);
    const remote = section.getByTestId("remote-access-state");
    await expect(remote).toHaveAttribute("data-enabled", "true", { timeout: 15_000 });
    await expect(remote).toContainText("nothing can pair with this Mac yet");
    expect(await remoteAccessEnabled(freshBackend, request)).toBe(true);

    await section.getByTestId("remote-access-turn-off").click();

    await expect(remote).toHaveAttribute("data-enabled", "false", { timeout: 15_000 });
    await expect(section.getByTestId("remote-access-turn-off")).toHaveCount(0);
    // The core agrees (not just the optimistic UI) …
    await expect.poll(() => remoteAccessEnabled(freshBackend, request), { timeout: 15_000 }).toBe(false);
    // … and turning only remote access off leaves the background host alone.
    await expect(section.getByTestId("background-state")).toHaveText("On, parked while the app is open");
    expect(fakeCalls(freshBackend)).not.toContain("unregister");
  });

  test("turning the background off also turns remote access off (C3)", async ({
    page,
    request,
    freshBackend,
  }) => {
    seedFakeHelper(freshBackend, { registration: "enabled" });
    seedSupervisor(freshBackend, "parked");

    const section = await openBackgroundSection(page, freshBackend);
    const remote = section.getByTestId("remote-access-state");
    const state = section.getByTestId("background-state");
    await expect(remote).toHaveAttribute("data-enabled", "true", { timeout: 15_000 });
    await expect(state).toHaveText("On, parked while the app is open");

    await section.getByTestId("background-toggle").click();

    // Remote access is on, so turning the host off asks first.
    const confirm = page.getByRole("dialog").filter({ hasText: "Turn off background mode?" });
    await expect(confirm).toContainText("This also turns off remote access.");
    // "Keep on" backs out without touching anything.
    await confirm.getByRole("button", { name: "Keep on" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(remote).toHaveAttribute("data-enabled", "true");
    expect(fakeCalls(freshBackend)).not.toContain("unregister");

    await section.getByTestId("background-toggle").click();
    await page
      .getByRole("dialog")
      .filter({ hasText: "Turn off background mode?" })
      .getByRole("button", { name: "Turn off" })
      .click();

    await expect(state).toHaveText("Off", { timeout: 15_000 });
    await expect(section.getByTestId("background-toggle")).toHaveAttribute("aria-checked", "false");
    await expect(remote).toHaveAttribute("data-enabled", "false", { timeout: 15_000 });
    await expect.poll(() => remoteAccessEnabled(freshBackend, request), { timeout: 15_000 }).toBe(false);
    expect(fakeCalls(freshBackend)).toContain("unregister");
  });
});
