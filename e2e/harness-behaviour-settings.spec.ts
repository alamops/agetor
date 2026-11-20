import { test, expect } from "./fixtures";
import { getPreferences, gotoApp, openSettingsGeneral, openSettingsHarnesses } from "./helpers";

/**
 * Settings → General is grouped, and every harness-specific row lives on
 * Settings → Harnesses → Behaviour (docs/plans/claude-enter-to-confirm-prompts.md
 * T5, owner decisions D2/D3). No preference key changed: each control writes
 * the key it always wrote, which this spec reads back through the API.
 */

const AUTO_TRUST_PREF = "claude_auto_trust_repositories";

test("General shows its groups and none of the harness-specific rows", async ({ page, freshBackend }) => {
  await gotoApp(page, freshBackend.bootBase);
  const dialog = await openSettingsGeneral(page);
  for (const group of ["appearance", "tasks", "privacy-security", "background", "getting-started"]) {
    await expect(dialog.getByTestId(`settings-group-${group}`)).toBeVisible();
  }
  await expect(dialog.getByTestId("claude-sessions-launch-scan")).toHaveCount(0);
  await expect(dialog.getByTestId("settings-fx-auto-resume")).toHaveCount(0);
  await expect(dialog.getByTestId("claude-auto-trust")).toHaveCount(0);
  await expect(dialog.getByText("tmux for Claude Code")).toHaveCount(0);
});

test("Harnesses → Behaviour shows the Claude Code and fx blocks", async ({ page, freshBackend }) => {
  await gotoApp(page, freshBackend.bootBase);
  const dialog = await openSettingsHarnesses(page);
  const claude = dialog.getByTestId("harness-behaviour-claude");
  await expect(claude.getByText("tmux for Claude Code")).toBeVisible();
  await expect(claude.getByTestId("claude-auto-trust")).toBeVisible();
  await expect(claude.getByTestId("claude-sessions-launch-scan")).toBeVisible();
  await expect(claude.getByText("Look for Claude Code and OpenCode sessions on launch")).toBeVisible();
  const fx = dialog.getByTestId("harness-behaviour-fx");
  await expect(fx.getByTestId("settings-fx-auto-resume")).toBeVisible();
  await expect(fx.getByTestId("settings-fx-auto-resume-delay")).toBeVisible();
});

test("the auto-trust switch is on by default and writes its preference both ways", async ({ page, request, freshBackend }) => {
  await gotoApp(page, freshBackend.bootBase);
  const dialog = await openSettingsHarnesses(page);
  const toggle = dialog.getByTestId("claude-auto-trust");
  await expect(toggle).toBeChecked();
  expect((await getPreferences(request, freshBackend))[AUTO_TRUST_PREF]).toBeUndefined();

  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(async () => (await getPreferences(request, freshBackend))[AUTO_TRUST_PREF]).toBe("0");

  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect.poll(async () => (await getPreferences(request, freshBackend))[AUTO_TRUST_PREF]).toBe("1");
});

test("a stored off value is read back when Settings reopens", async ({ page, request, freshBackend }) => {
  await gotoApp(page, freshBackend.bootBase);
  let dialog = await openSettingsHarnesses(page);
  await dialog.getByTestId("claude-auto-trust").click();
  await expect.poll(async () => (await getPreferences(request, freshBackend))[AUTO_TRUST_PREF]).toBe("0");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  dialog = await openSettingsHarnesses(page);
  await expect(dialog.getByTestId("claude-auto-trust")).not.toBeChecked();
});
