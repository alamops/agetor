import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openSettingsGeneral, getPreferences } from "./helpers";

/**
 * E2E coverage for first-run onboarding — the welcome dialog + live
 * "Getting started" checklist (docs/plans/onboarding-first-run.md, §5 TT2).
 * Runs Chromium against the real webview + real Bun API/orchestrator, same
 * as theme/font-size/quote — no mocked fetches.
 *
 * Unlike those three specs, every test here uses `freshBackend`
 * (e2e/fixtures.ts) instead of the worker-scoped `backend`: onboarding's
 * visibility rules (`resolveOnboardingVisibility` in
 * src/mainview/lib/onboarding.ts) branch on whether the `onboardingDismissed`
 * preference has *ever* been written (`dismissedPref === undefined`), and
 * there's no "unset preference" API. Several cases below need that exact
 * "never evaluated" state independently — a fresh welcome dialog, a Skip
 * that then persists, an existing-user auto-dismiss on first load — so
 * sharing one backend/DB across tests (the theme.spec.ts pattern) would let
 * whichever test runs first permanently consume that state for the rest of
 * the file. `freshBackend` sidesteps that entirely: a brand-new headless
 * backend + SQLite DB per test.
 *
 * `gotoApp`'s default (`e2e/helpers.ts`) seeds `onboardingDismissed="true"`
 * before navigating, which is exactly wrong for these tests — they need the
 * real first-run state — so every navigation here passes
 * `{ seedOnboardingDismissed: false }` except where a test deliberately wants
 * the dismissed/replay state (case 4).
 */

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

interface TaskRow {
  id: string;
  column: string;
}

/** Registers a project by absolute path (an authed `POST /projects`, per
 *  src/bun/server.ts:546-572) — the API equivalent of the native folder
 *  picker. `os.tmpdir()` always exists, and the fake driver never touches
 *  the filesystem, so it doesn't need to be a real git repo. */
async function registerProject(request: APIRequestContext, backend: E2EBackend): Promise<void> {
  const res = await request.post(`${backend.apiBase}/projects`, {
    headers: auth(backend),
    data: { path: tmpdir() },
  });
  expect(res.ok(), `POST /projects -> ${res.status()}: ${await res.text()}`).toBeTruthy();
}

/** Creates a task (isolation "none", a plain temp dir as workdir) via an
 *  authed `POST /tasks`. Returns the created row. */
async function createTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<TaskRow> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title, prompt: title, isolation: "none", workdir: tmpdir() },
  });
  expect(res.ok(), `POST /tasks -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as TaskRow;
}

/** Starts a task via an authed `POST /tasks/:id/start`. The backend's fake
 *  claude driver (`AGETOR_CLAUDE_DRIVER=fake`, set by fixtures.ts) means this
 *  never shells out to tmux — `startTask` still flips the task's column to
 *  "running" synchronously before returning, which is already enough for
 *  onboarding's "run" step (`RUN_DONE_COLUMNS` includes "running"). */
async function startTask(request: APIRequestContext, backend: E2EBackend, id: string): Promise<void> {
  const res = await request.post(`${backend.apiBase}/tasks/${id}/start`, { headers: auth(backend) });
  expect(res.ok(), `POST /tasks/${id}/start -> ${res.status()}: ${await res.text()}`).toBeTruthy();
}

function welcome(page: Page) {
  return page.getByTestId("onboarding-welcome");
}

function checklist(page: Page) {
  return page.getByTestId("onboarding-checklist");
}

function step(page: Page, id: "harness" | "project" | "task" | "run") {
  return page.getByTestId(`onboarding-step-${id}`);
}

test.describe("onboarding: fresh backend", () => {
  test("shows the welcome dialog and checklist, with the harness step already done", async ({
    page,
    freshBackend,
  }) => {
    await gotoApp(page, freshBackend.bootBase, { seedOnboardingDismissed: false });

    await expect(welcome(page)).toBeVisible();
    await expect(checklist(page)).toBeVisible();

    // The fake driver's claude-code binary probe points AGETOR_CLAUDE_BIN
    // and AGETOR_TMUX_BIN at /bin/echo (fixtures.ts) — `checkHarness`
    // resolves that as an existing absolute path, spawns it with
    // `--version`, gets exit code 0, and reports `available: true`. Since
    // claude-code is enabled by default, the harness step is already done on
    // a totally virgin backend, before any project/task/run exists.
    await expect(step(page, "harness")).toHaveAttribute("data-done", "true");
    await expect(step(page, "project")).toHaveAttribute("data-done", "false");
    await expect(step(page, "task")).toHaveAttribute("data-done", "false");
    await expect(step(page, "run")).toHaveAttribute("data-done", "false");
  });
});

test.describe("onboarding: skip", () => {
  test("Skip hides onboarding immediately and the dismissal persists across reload", async ({
    page,
    request,
    freshBackend,
  }) => {
    await gotoApp(page, freshBackend.bootBase, { seedOnboardingDismissed: false });
    await expect(welcome(page)).toBeVisible();

    await page.getByRole("button", { name: "Skip — I know my way around" }).click();
    await expect(welcome(page)).toHaveCount(0);
    await expect(checklist(page)).toHaveCount(0);

    // Reload without re-seeding (still opting out of gotoApp's default
    // seeding) so this proves the *persisted* pref is what's keeping
    // onboarding hidden, not a redundant seed from this navigation.
    await gotoApp(page, freshBackend.bootBase, { seedOnboardingDismissed: false });
    await expect(welcome(page)).toHaveCount(0);
    await expect(checklist(page)).toHaveCount(0);

    const prefs = await getPreferences(request, freshBackend);
    expect(prefs.onboardingDismissed).toBe("true");
  });
});

test.describe("onboarding: progressive check-off", () => {
  test("each step checks off live as harness/project/task/run land, then the checklist auto-dismisses", async ({
    page,
    request,
    freshBackend,
  }) => {
    await gotoApp(page, freshBackend.bootBase, { seedOnboardingDismissed: false });
    await expect(welcome(page)).toBeVisible();

    await page.getByRole("button", { name: "Get started" }).click();
    await expect(welcome(page)).toHaveCount(0);
    await expect(checklist(page)).toBeVisible();
    await expect(step(page, "project")).toHaveAttribute("data-done", "false");

    await registerProject(request, freshBackend);
    await expect(step(page, "project")).toHaveAttribute("data-done", "true", { timeout: 10_000 });

    const task = await createTask(request, freshBackend, `onboarding-e2e-${Date.now()}`);
    await expect(step(page, "task")).toHaveAttribute("data-done", "true", { timeout: 10_000 });

    // Starting the task flips its column to "running" synchronously
    // server-side (before startTask even returns) — that alone satisfies
    // the "run" step (`RUN_DONE_COLUMNS` includes "running"), which makes
    // all 4 steps done in the same render pass. `resolveOnboardingVisibility`
    // hides the checklist the instant `allDone` is true (not just once the
    // async auto-dismiss pref write lands) — so there's no window where the
    // "run" step is visibly checked off with the checklist still on screen;
    // the checklist disappearing IS the observable proof the run step (and
    // therefore every step) went done. The existing-user upgrade path
    // (`autoDismiss`) then persists the pref without any dismiss click.
    await startTask(request, freshBackend, task.id);
    await expect(checklist(page)).toHaveCount(0, { timeout: 10_000 });
    await expect
      .poll(() => getPreferences(request, freshBackend).then((p) => p.onboardingDismissed), {
        message: "expected auto-dismiss to persist onboardingDismissed=true",
        timeout: 10_000,
      })
      .toBe("true");
  });
});

test.describe("onboarding: replay from Settings", () => {
  test("Settings -> General -> 'Show getting started guide' brings the checklist back; dismiss hides it again", async ({
    page,
    request,
    freshBackend,
  }) => {
    // Seed a completed setup (project + task + run) on a virgin backend, then
    // let gotoApp's default seeding mark it dismissed — this is exactly
    // "a seeded-dismissed backend with a completed setup" per the plan.
    await registerProject(request, freshBackend);
    const task = await createTask(request, freshBackend, `onboarding-replay-e2e-${Date.now()}`);
    await startTask(request, freshBackend, task.id);

    await gotoApp(page, freshBackend.bootBase);
    await expect(welcome(page)).toHaveCount(0);
    await expect(checklist(page)).toHaveCount(0);

    const dialog = await openSettingsGeneral(page);
    await dialog.getByTestId("settings-replay-onboarding").click();

    // The button's onClick awaits the preference write, then closes the
    // dialog — App re-reads the pref on close.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(checklist(page)).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);

    // Everything was already set up before the first load, so replay shows
    // every step already done.
    await expect(step(page, "harness")).toHaveAttribute("data-done", "true");
    await expect(step(page, "project")).toHaveAttribute("data-done", "true");
    await expect(step(page, "task")).toHaveAttribute("data-done", "true");
    await expect(step(page, "run")).toHaveAttribute("data-done", "true");

    await page.getByRole("button", { name: "Dismiss — I know my way around" }).click();
    await expect(checklist(page)).toHaveCount(0);

    const prefs = await getPreferences(request, freshBackend);
    expect(prefs.onboardingDismissed).toBe("true");
  });
});

test.describe("onboarding: existing-user guard", () => {
  test("a backend that already has a completed setup before first load never shows onboarding, and auto-marks it dismissed", async ({
    page,
    request,
    freshBackend,
  }) => {
    // Seed harness(already available)/project/task/run BEFORE the page ever
    // loads, with the dismissal pref left untouched (absent) — the scenario
    // an upgrading user's existing data represents.
    await registerProject(request, freshBackend);
    const task = await createTask(request, freshBackend, `onboarding-existing-e2e-${Date.now()}`);
    await startTask(request, freshBackend, task.id);

    await gotoApp(page, freshBackend.bootBase, { seedOnboardingDismissed: false });

    // Never appears, not even for a beat — all 4 steps already derive as
    // done on the very first render pass that has real data loaded.
    await expect(welcome(page)).toHaveCount(0);
    await expect(checklist(page)).toHaveCount(0);

    await expect
      .poll(() => getPreferences(request, freshBackend).then((p) => p.onboardingDismissed), {
        message: "expected the existing-user upgrade path to auto-set onboardingDismissed=true",
        timeout: 10_000,
      })
      .toBe("true");
  });
});
