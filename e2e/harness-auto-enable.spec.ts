import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, headerSettingsButton } from "./helpers";

/**
 * E2E coverage for auto-enabling an installed built-in harness
 * (docs/plans/add-opencode-harness.md D-14, §5 W3-T2 flow 3). The backend
 * runs with `AGETOR_HARNESS_AUTO_ENABLE=1` and a stub `codex` that answers
 * `--version`; every other auto-enable kind points at a binary that doesn't
 * exist, so Codex is the only harness the pass can turn on.
 *
 * Boot (or the first `GET /harnesses`) turns Codex on and the notice reaches
 * the webview → toast "Turned on Codex…" → its Settings action shows Codex
 * on → the user turns it off → later polls leave it off, and no second toast
 * appears.
 */

const CONVERGE_TIMEOUT = 30_000;
const TOAST_TEXT = "Turned on Codex because it's installed — turn it off in Settings";

const stubDir = mkdtempSync(path.join(tmpdir(), "auto-enable-e2e-"));
const codexStub = path.join(stubDir, "codex");
writeFileSync(
  codexStub,
  ["#!/bin/sh", 'if [ "$1" = "--version" ]; then', '  echo "codex-cli 0.160.0"', "  exit 0", "fi", "exit 0", ""].join(
    "\n",
  ),
);
chmodSync(codexStub, 0o755);
const missing = path.join(stubDir, "not-installed");

test.use({
  backendEnv: {
    AGETOR_HARNESS_AUTO_ENABLE: "1",
    AGETOR_CODEX_BIN: codexStub,
    AGETOR_CURSOR_BIN: missing,
    AGETOR_GEMINI_BIN: missing,
    AGETOR_FX_BIN: missing,
    AGETOR_OPENCODE_BIN: missing,
  },
});

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

/** `GET /harnesses` — which also runs the auto-enable pass. */
async function harnessRows(request: APIRequestContext, backend: E2EBackend): Promise<Array<Record<string, any>>> {
  const res = await request.get(`${backend.apiBase}/harnesses`, { headers: auth(backend) });
  expect(res.ok(), `GET /harnesses -> ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { harnesses: Array<Record<string, any>> }).harnesses;
}

async function enabledOf(request: APIRequestContext, backend: E2EBackend, id: string): Promise<boolean | undefined> {
  return (await harnessRows(request, backend)).find((h) => h.id === id)?.enabled;
}

function toastWith(page: Page, text: string) {
  return page.locator("[data-sonner-toast]").filter({ hasText: text });
}

test("an installed Codex is turned on once with a toast, and turning it off sticks", async ({
  page,
  browser,
  request,
  freshBackend,
}) => {
  test.setTimeout(120_000);
  await gotoApp(page, freshBackend.bootBase);

  const toast = toastWith(page, TOAST_TEXT);
  await expect(toast).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  // Hovering pauses sonner's auto-dismiss timer, so the action below can't
  // race the toast closing on a loaded machine.
  await toast.hover();
  await expect(toast).toHaveCount(1);
  expect(await enabledOf(request, freshBackend, "codex")).toBe(true);
  // Nothing else was available, so nothing else was turned on.
  const rows = await harnessRows(request, freshBackend);
  for (const id of ["cursor", "gemini", "fx", "opencode"]) {
    expect(rows.find((h) => h.id === id)?.enabled, `${id} stays off`).toBe(false);
  }

  // The toast's action opens Settings → Harnesses with Codex on.
  await toast.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Settings" }) });
  await expect(dialog).toBeVisible();
  const disable = dialog.getByRole("switch", { name: "Disable Codex", exact: true });
  await expect(disable).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await expect(disable).toBeChecked();

  // Turn it off (no tasks are running, but the switch still confirms).
  await disable.click();
  await page.getByRole("button", { name: "Disable", exact: true }).click();
  const enable = dialog.getByRole("switch", { name: "Enable Codex", exact: true });
  await expect(enable).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await expect(enable).not.toBeChecked();
  await expect.poll(() => enabledOf(request, freshBackend, "codex"), { timeout: CONVERGE_TIMEOUT }).toBe(false);

  // The next polls (each `GET /harnesses` re-runs the pass) leave it off.
  expect(await enabledOf(request, freshBackend, "codex")).toBe(false);
  expect(await enabledOf(request, freshBackend, "codex")).toBe(false);

  // A newly connected client (its own browser context, so no Settings view
  // restored from storage) gets no second toast, and Codex is still off.
  const context = await browser.newContext();
  try {
    const fresh = await context.newPage();
    await gotoApp(fresh, freshBackend.bootBase);
    await headerSettingsButton(fresh).click();
    const reopened = fresh.getByRole("dialog");
    await expect(reopened.getByRole("heading", { name: "Settings" })).toBeVisible();
    await reopened.getByRole("button", { name: "Harnesses", exact: true }).click();
    await expect(reopened.getByRole("switch", { name: "Enable Codex", exact: true })).not.toBeChecked({
      timeout: CONVERGE_TIMEOUT,
    });
    await expect(toastWith(fresh, "Turned on Codex")).toHaveCount(0);
    expect(await enabledOf(request, freshBackend, "codex")).toBe(false);
  } finally {
    await context.close();
  }
});
