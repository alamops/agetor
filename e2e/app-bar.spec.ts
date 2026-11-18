import { test, expect, type E2EBackend, type Locator, type Page } from "./fixtures";
import {
  bearerHeaders,
  createStackAccount,
  createStackViaApi,
  deleteAll,
  gotoApp,
  headerSettingsButton,
  injectSseFrame,
  installSseInjector,
  putPreference,
  seedHarnessUsage,
  seedLimitState,
} from "./helpers";
import type { HarnessQuota } from "../src/shared/types.ts";

/**
 * The window app bar (docs/architecture/app-bar.md): one aggregate Harnesses
 * button and its stack-grouped panel, the measured collapse at every width and
 * UI zoom, RunPanel overlap and the native-menu actions.
 *
 * Arrange (synthetic ids only): `claude-code` + three alias accounts, two of
 * them in a Claude Code stack, `codex`/`cursor`/`opencode` enabled and the
 * other built-ins off, which makes seven enabled harnesses like the owner's
 * bar. The stack's backup is cooling and a task on the primary hits the fake
 * driver's limit, so the task is parked in the all-exhausted state ("waiting
 * for quota") — the same recipe as e2e/harness-stack-swap.spec.ts.
 *
 * Native menu clicks need the native shell, so the `menu_action` event the
 * core would broadcast is injected into the webview's own `/app/events`
 * stream (`installSseInjector`) — the same bytes, the same `onMessage` path.
 */

/** Literal copy of `FAKE_CLAUDE_LIMIT_PROMPT_MARKER` (e2e cannot import `src/bun/*`). */
const LIMIT_MARKER = "__agetor_fake_claude_limit__";
const HOUR_MS = 3_600_000;

const ACCOUNT_A = "e2e-bar-a";
const ACCOUNT_B = "e2e-bar-b";
const ACCOUNT_C = "e2e-bar-c";
const FAILOVER_TITLE = "e2e bar parked task";

interface Arranged {
  stackId: string;
  taskId: string;
  harnessIds: string[];
}

function quota(harnessId: string, five: number, weekly: number): HarnessQuota {
  const now = Date.now();
  return {
    harnessId,
    kind: "claude-code",
    planType: "max",
    status: "ok",
    source: "cache",
    fetchedAtMs: now,
    meters: [
      { id: "five_hour", label: "Session (5h)", usedPercent: five, resetsAtMs: now + 3 * HOUR_MS },
      { id: "seven_day", label: "Weekly", usedPercent: weekly, resetsAtMs: now + 48 * HOUR_MS },
    ],
    reason: null,
  };
}

async function patchHarness(backend: E2EBackend, id: string, enabled: boolean): Promise<void> {
  const res = await fetch(`${backend.apiBase}/harnesses/${id}`, {
    method: "PATCH",
    headers: bearerHeaders(backend),
    body: JSON.stringify({ enabled }),
  });
  expect(res.ok, `PATCH /harnesses/${id} -> ${res.status}`).toBeTruthy();
}

async function waitForAllExhausted(backend: E2EBackend, taskId: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let last = "";
  while (Date.now() < deadline) {
    const res = await fetch(`${backend.apiBase}/tasks/${taskId}`, { headers: bearerHeaders(backend) });
    const task = (await res.json()) as { column: string; harnessState: { allExhausted?: unknown } | null };
    last = `${task.column} ${JSON.stringify(task.harnessState)}`;
    if (task.harnessState?.allExhausted != null && task.column !== "running") return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`task ${taskId} never reached all-exhausted (last: ${last})`);
}

async function arrange(backend: E2EBackend): Promise<Arranged> {
  for (const id of ["antigravity", "copilot", "gemini", "fx"]) await patchHarness(backend, id, false);
  for (const id of ["codex", "cursor", "opencode"]) await patchHarness(backend, id, true);
  for (const id of [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C]) await createStackAccount(backend, id);
  const stack = await createStackViaApi(backend, "e2e bar stack", "claude-code", [ACCOUNT_A, ACCOUNT_B]);
  seedHarnessUsage(backend, quota("claude-code", 30, 60));
  seedHarnessUsage(backend, quota(ACCOUNT_A, 20, 40));
  seedHarnessUsage(backend, quota(ACCOUNT_B, 50, 70));
  seedLimitState(backend, { harnessId: ACCOUNT_B, untilMs: Date.now() + 2 * HOUR_MS, message: "Weekly limit reached" });
  const created = await fetch(`${backend.apiBase}/tasks`, {
    method: "POST",
    headers: bearerHeaders(backend),
    body: JSON.stringify({
      title: FAILOVER_TITLE,
      prompt: `go ${LIMIT_MARKER}`,
      agent: ACCOUNT_A,
      workdir: backend.dataDir,
      isolation: "none",
      model: "sonnet-4.6",
    }),
  });
  if (!created.ok) throw new Error(`POST /tasks -> ${created.status}: ${await created.text()}`);
  const taskId = ((await created.json()) as { id: string }).id;
  const started = await fetch(`${backend.apiBase}/tasks/${taskId}/start`, { method: "POST", headers: bearerHeaders(backend) });
  if (!started.ok) throw new Error(`POST /tasks/${taskId}/start -> ${started.status}`);
  await waitForAllExhausted(backend, taskId);
  return { stackId: stack.id, taskId, harnessIds: [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C] };
}

async function cleanup(backend: E2EBackend, a: Arranged): Promise<void> {
  await deleteAll(backend, [
    `/tasks/${a.taskId}`,
    `/harness-stacks/${a.stackId}`,
    ...a.harnessIds.map((id) => `/harnesses/${id}`),
  ]);
}

const banner = (page: Page) => page.getByRole("banner");
const harnessesButton = (page: Page) => banner(page).getByRole("button", { name: "Harnesses", exact: true });
const runPanel = (page: Page) => page.locator("aside").last();

/** The collapse step once the measurement has settled (three equal reads). */
async function settledStep(page: Page): Promise<number> {
  const read = () => page.getByTestId("app-bar").getAttribute("data-fit-step").then((v) => Number(v));
  let prev = await read();
  let stable = 0;
  const deadline = Date.now() + 5_000;
  while (stable < 3 && Date.now() < deadline) {
    await page.waitForTimeout(80);
    const next = await read();
    stable = next === prev ? stable + 1 : 0;
    prev = next;
  }
  return prev;
}

async function noSidewaysScroll(page: Page, where = "the window"): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), {
      message: `the document must not scroll sideways at ${where}`,
    })
    .toBeLessThanOrEqual(0);
}

async function expectReachable(page: Page, control: Locator, label: string): Promise<void> {
  await expect(control, label).toBeVisible();
  const box = await control.boundingBox();
  expect(box, `${label} has a box`).not.toBeNull();
  const viewport = page.viewportSize();
  expect(box!.x + box!.width, `${label} stays inside the window`).toBeLessThanOrEqual((viewport?.width ?? 0) + 0.5);
  expect(box!.x, `${label} is not clipped on the left`).toBeGreaterThanOrEqual(0);
  await control.click({ trial: true });
}

test.describe("app bar", () => {
  test("fits every width at 100% and 170% UI zoom without sideways scroll and keeps every action reachable", async ({
    page,
    freshBackend: backend,
  }) => {
    test.setTimeout(420_000);
    const arranged = await arrange(backend);
    try {
      const widths = [1440, 1100, 900, 720];
      for (const zoom of [100, 170]) {
        await page.setViewportSize({ width: 1440, height: 900 });
        // The persisted preference wins over the boot hash, so set both (the
        // pattern e2e/font-size.spec.ts uses). A hash-only change would be a
        // same-document navigation, so leave the page first to force a boot.
        await putPreference(page.request, backend, "fontSize", String(zoom));
        await page.goto("about:blank");
        await gotoApp(page, `${backend.bootBase}&fontSize=${zoom}`);
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(`${(16 * zoom) / 100}px`);
        await expect(harnessesButton(page)).toBeVisible();
        const steps: number[] = [];
        for (const width of widths) {
          await page.setViewportSize({ width, height: 900 });
          const step = await settledStep(page);
          steps.push(step);
          const where = `${width}px @ ${zoom}%`;

          await noSidewaysScroll(page, where);
          const header = page.getByTestId("app-bar");
          const geometry = await header.evaluate((el) => {
            const cs = getComputedStyle(el);
            return { height: el.getBoundingClientRect().height, paddingLeft: cs.paddingLeft };
          });
          expect(geometry.height, `bar height at ${where}`).toBe(40);
          expect(geometry.paddingLeft, `traffic-light inset at ${where}`).toBe("80px");

          const bar = banner(page);
          await expectReachable(page, bar.getByRole("button", { name: "Settings", exact: true }), `Settings at ${where}`);
          await expectReachable(page, bar.getByRole("button", { name: "Pipelines", exact: true }), `Pipelines at ${where}`);
          await expectReachable(page, bar.getByRole("button", { name: "Git", exact: true }), `Git at ${where}`);
          await expectReachable(page, bar.getByRole("button", { name: "Worktrees", exact: true }), `Worktrees at ${where}`);
          await expectReachable(page, harnessesButton(page), `Harnesses at ${where}`);

          // Import is either a bar button or reachable through More.
          const importButton = bar.getByTestId("import-claude-sessions-open");
          if (await importButton.count()) {
            await expectReachable(page, importButton, `Import at ${where}`);
          } else {
            const more = bar.getByTestId("app-bar-more");
            await expectReachable(page, more, `More at ${where}`);
            await more.click();
            const item = page.getByRole("menuitem", { name: "Import sessions…" });
            await expect(item, `Import in More at ${where}`).toBeVisible();
            await page.keyboard.press("Escape");
            await expect(item).toBeHidden();
            await expect(more, `focus returns to More at ${where}`).toBeFocused();
          }
        }
        if (zoom === 100) expect(steps[0], "1440 px @ 100% needs no collapse").toBe(0);
        for (let i = 1; i < steps.length; i++) {
          expect(steps[i], `the collapse step never decreases as the window narrows (${zoom}%: ${steps.join(",")})`).toBeGreaterThanOrEqual(
            steps[i - 1]!,
          );
        }
        if (zoom === 170) expect(steps[steps.length - 1]!, "720 px @ 170% collapses").toBeGreaterThanOrEqual(1);
      }
    } finally {
      await cleanup(backend, arranged);
    }
  });

  test("the Harnesses button and panel show stacks, failover activity and reach Settings", async ({
    page,
    freshBackend: backend,
  }) => {
    test.setTimeout(240_000);
    const arranged = await arrange(backend);
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoApp(page, backend.bootBase);
      const button = harnessesButton(page);
      await expect(button).toBeVisible();

      // The button: count, failover badge, meter; no per-account chips in the bar.
      await expect(button.getByTestId("harnesses-button-count")).toHaveText("7");
      await expect(button.getByTestId("harnesses-button-badge")).toHaveText("1");
      await expect(button.getByTestId("harnesses-button-meter")).toBeVisible();
      await expect(banner(page).getByRole("button", { name: ACCOUNT_A, exact: true })).toHaveCount(0);

      // The task count lives in the board's filter row, not the bar.
      await expect(page.getByTestId("board-task-count")).toHaveText(/^\d+ tasks$/);
      await expect(banner(page).getByText(/\d+ tasks/)).toHaveCount(0);

      // Open the panel: stack first, members in order, the backup's cooldown chip.
      await button.click();
      const panel = page.getByRole("dialog", { name: "Harnesses" });
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAttribute("data-popover-open", "");
      await expect(panel).toHaveAttribute("data-popover-keys", "escape-only");
      await expect(button).toHaveAttribute("aria-expanded", "true");

      const stack = panel.getByTestId(`harnesses-panel-stack-${arranged.stackId}`);
      await expect(stack).toBeVisible();
      await expect(stack).toContainText("e2e bar stack");
      await expect(stack).toContainText("Stack");
      const rows = stack.locator('[data-testid^="harnesses-panel-account-"]');
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toHaveAttribute("data-testid", `harnesses-panel-account-${ACCOUNT_A}`);
      await expect(rows.nth(0)).toContainText("Primary");
      await expect(rows.nth(1)).toHaveAttribute("data-testid", `harnesses-panel-account-${ACCOUNT_B}`);
      await expect(rows.nth(1)).toContainText("Backup 1");
      await expect(rows.nth(1).getByTestId("harness-cooldown-chip").first()).toBeVisible();
      // The unstacked account sits below the stack, after it in document order.
      const plain = panel.getByTestId(`harnesses-panel-account-${ACCOUNT_C}`);
      await expect(plain).toBeVisible();
      const order = await panel.evaluate(
        (el, ids) => {
          const html = el.innerHTML;
          return ids.map((id) => html.indexOf(id));
        },
        [`harnesses-panel-stack-${arranged.stackId}`, `harnesses-panel-account-${ACCOUNT_C}`],
      );
      expect(order[0]).toBeGreaterThanOrEqual(0);
      expect(order[1]).toBeGreaterThan(order[0]!);

      // Failover activity: listed under the stack and opens the task.
      const failover = stack.getByTestId(`harnesses-panel-failover-${arranged.taskId}`);
      await expect(failover).toContainText("waiting for quota");

      // Escape closes and returns focus to the button.
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await expect(button).toBeFocused();

      // Swap history opens Settings on that stack's history.
      await button.click();
      await panel.getByRole("button", { name: "Swap history" }).click();
      await expect(panel).toBeHidden();
      const history = page.getByRole("dialog", { name: "Stack history" });
      await expect(history.getByTestId("harness-stack-history")).toBeVisible();
      await expect(history).toContainText("e2e bar parked task");
      // Escape on a Settings subpage steps back to the section, so close the dialog itself.
      await history.getByRole("button", { name: "Close" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // The failover row opens the task's RunPanel.
      await button.click();
      await panel.getByTestId(`harnesses-panel-failover-${arranged.taskId}`).click();
      await expect(panel).toBeHidden();
      await expect(runPanel(page).locator("textarea")).toBeVisible();
    } finally {
      await cleanup(backend, arranged);
    }
  });

  test("with RunPanel open the bar stays usable and every menu action opens its target", async ({
    page,
    freshBackend: backend,
  }) => {
    test.setTimeout(300_000);
    const arranged = await arrange(backend);
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await installSseInjector(page, "/app/events");
      await gotoApp(page, backend.bootBase);
      await page.getByText(FAILOVER_TITLE, { exact: true }).first().click();
      await expect(runPanel(page).locator("textarea")).toBeVisible();

      // RunPanel's backdrop covers the whole window, bar included, while it is
      // open (a press on the bar closes the panel), so the native menu is the
      // way to reach the bar's actions then. The document must still never
      // scroll sideways, at any width.
      for (const width of [1440, 1100, 900, 720]) {
        await page.setViewportSize({ width, height: 900 });
        await noSidewaysScroll(page, `${width}px with RunPanel open`);
      }
      await page.setViewportSize({ width: 1440, height: 900 });

      // Menu actions reach the webview with RunPanel open. Each dialog is
      // closed before the next action (a menu action is a no-op under a modal).
      const inject = (action: string) =>
        injectSseFrame(page, "/app/events", { type: "menu_action", action, ts: Date.now() });

      await inject("settings");
      const settings = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Settings" }) });
      await expect(settings).toBeVisible();
      // A second action while the modal is open does nothing.
      await inject("worktrees");
      await expect(page.getByRole("dialog", { name: "Worktrees" })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(settings).toBeHidden();

      await inject("git");
      await expect(page.locator("#github-dialog-title")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator("#github-dialog-title")).toBeHidden();

      await inject("worktrees");
      await expect(page.getByRole("dialog", { name: "Worktrees" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Worktrees" })).toBeHidden();

      await inject("import-sessions");
      await expect(page.getByRole("dialog", { name: "Import sessions" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Import sessions" })).toBeHidden();

      // ⌘, / Ctrl+, opens Settings, exactly once.
      await page.keyboard.press("ControlOrMeta+Comma");
      await expect(settings).toBeVisible();
      await expect(page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Settings" }) })).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(settings).toBeHidden();

      // An action closes the Harnesses panel it found open. (Close RunPanel
      // first: its backdrop would swallow the click on the bar.)
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Close task panel" })).toHaveCount(0);
      await harnessesButton(page).click();
      await expect(page.getByRole("dialog", { name: "Harnesses" })).toBeVisible();
      await inject("worktrees");
      await expect(page.getByRole("dialog", { name: "Worktrees" })).toBeVisible();
      await expect(page.getByRole("dialog", { name: "Harnesses" })).toBeHidden();
      await page.keyboard.press("Escape");

      // Pipelines page: reachable from the menu, and it carries no task count.
      await inject("pipelines");
      await expect(page.getByTestId("pipelines-page")).toBeVisible();
      await expect(page.getByTestId("board-task-count")).toHaveCount(0);
      await expect(headerSettingsButton(page)).toBeVisible();
    } finally {
      await cleanup(backend, arranged);
    }
  });
});
