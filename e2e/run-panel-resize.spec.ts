import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { getPreferences, gotoApp, openSettingsGeneral } from "./helpers";

/**
 * E2E coverage for the RunPanel's user-resizable width (drag handle on the
 * panel's left edge, persisted in localStorage — `src/mainview/lib/
 * panel-width.ts`) and for the configurable user-message pinning.
 *
 * Mirrors the boot/task-creation/panel-opening idiom from
 * `e2e/run-panel-header.spec.ts`: per-worker headless backend with
 * `AGETOR_CLAUDE_DRIVER=fake`, an isolation:"none" task in a plain temp dir,
 * started via the real HTTP API so the panel has real content.
 */

test.describe.configure({ mode: "serial" });

const WIDTH_KEY = "agetor:runPanelWidth";
const DEFAULT_WIDTH = 720;

async function createAndStartFakeClaudeTask(
  request: APIRequestContext,
  backend: E2EBackend,
  prompt: string,
): Promise<{ id: string }> {
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: { title: prompt, prompt, isolation: "none", workdir: tmpdir() },
  });
  expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
  const task = (await createRes.json()) as { id: string };

  const startRes = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, { headers: auth });
  expect(
    startRes.ok(),
    `POST /tasks/${task.id}/start -> ${startRes.status()}: ${await startRes.text()}`,
  ).toBeTruthy();

  return task;
}

/** The run panel's slide-over `<aside>` — `.last()` because NewTaskForm's
 *  sidebar is also an `<aside>`, mounted first in App.tsx's JSX. */
function runPanel(page: Page) {
  return page.locator("aside").last();
}

async function openTask(page: Page, title: string) {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

async function panelWidth(page: Page): Promise<number> {
  const box = await runPanel(page).boundingBox();
  expect(box, "run panel should have a bounding box").not.toBeNull();
  return box!.width;
}

test.describe("run panel resize", () => {
  test("drag widens the panel, the width persists across reloads, double-click resets, keyboard nudges", async ({
    page,
    request,
    backend,
  }) => {
    const prompt = `resize-e2e ${randomUUID()}`;
    await createAndStartFakeClaudeTask(request, backend, prompt);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, prompt);

    // --- (1) default width (nothing persisted yet) -------------------------
    expect(await panelWidth(page)).toBe(DEFAULT_WIDTH);

    // --- (2) drag the handle 120px left → panel grows to 840 ---------------
    const handle = panel.getByTestId("run-panel-resize");
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();
    const startX = handleBox!.x + handleBox!.width / 2;
    const startY = handleBox!.y + 300;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 120, startY, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => panelWidth(page)).toBe(DEFAULT_WIDTH + 120);

    // Committed to storage on drag end (this is what survives a restart).
    expect(await page.evaluate((k) => localStorage.getItem(k), WIDTH_KEY)).toBe(
      String(DEFAULT_WIDTH + 120),
    );

    // --- (3) the persisted width is applied on the very first paint after
    // a reload (synchronous initializer — no default-width flash to assert
    // around, the panel simply mounts at the stored width). `page.reload()`,
    // not a second `gotoApp`: navigating to the same hash-carrying URL is a
    // same-document navigation that would leave the app (and the open panel)
    // untouched. -------------------------------------------------------------
    await page.reload();
    await openTask(page, prompt);
    expect(await panelWidth(page)).toBe(DEFAULT_WIDTH + 120);

    // --- (4) double-click resets to the default -----------------------------
    await handle.dblclick();
    await expect.poll(() => panelWidth(page)).toBe(DEFAULT_WIDTH);
    expect(await page.evaluate((k) => localStorage.getItem(k), WIDTH_KEY)).toBe(String(DEFAULT_WIDTH));

    // --- (5) keyboard: the focused handle widens on ArrowLeft (the handle
    // sits on the panel's LEFT edge, so left = wider). -----------------------
    await handle.focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => panelWidth(page)).toBe(DEFAULT_WIDTH + 32);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => panelWidth(page)).toBe(DEFAULT_WIDTH);
  });

  test("user messages are sticky by default and can switch to a standard chat list", async ({
    page,
    request,
    backend,
  }) => {
    const prompt = `sticky-toggle-e2e ${randomUUID()}`;
    await createAndStartFakeClaudeTask(request, backend, prompt);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, prompt);

    // The prompt renders as a sticky user bubble by default.
    await expect(panel.getByText(prompt, { exact: true }).last()).toBeVisible();
    await expect(panel.locator("[data-evid].sticky")).toHaveCount(1);

    await panel.getByRole("button", { name: "Close" }).click();
    const settings = await openSettingsGeneral(page);
    const stickySwitch = settings.getByRole("switch", { name: "Sticky user messages" });
    await expect(stickySwitch).toBeChecked();
    await stickySwitch.click();
    await expect(stickySwitch).not.toBeChecked();
    await expect.poll(async () => (await getPreferences(request, backend)).stickyUserMessages).toBe("false");
    await settings.getByRole("button", { name: "Close" }).click();

    // Reload to prove the standard-list selection comes back from the
    // persisted preference, rather than only living in App state.
    await page.reload();
    await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
    const standardPanel = await openTask(page, prompt);
    await expect(standardPanel.locator("[data-evid].sticky")).toHaveCount(0);
  });
});
