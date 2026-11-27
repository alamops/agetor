import { test, expect } from "./fixtures";
import { gotoApp, openSettingsGeneral } from "./helpers";
import { seedDevice, startRemoteWorld } from "./remote-helpers";

/**
 * Settings → Remote access (docs/architecture/remote-gateway.md, plan UI1): the paired phones with their level and trust, Revoke, and the
 * audit log with its chain status. Devices are seeded by `e2e/remote-helpers.ts`: rows signed by the fake key helper's registry key into the
 * backend's SQLite file, one signed by a stranger so the core lists it as "Not trusted".
 */
const world = startRemoteWorld();
test.afterAll(() => world.close());

test.describe("Settings → Remote access", () => {
  test.use({ backendEnv: world.env });

  test("lists the phones, shows an untrusted one as such, revokes one, and the Activity log records it with the chain intact", async ({ page, freshBackend }) => {
    const ana = seedDevice(world, freshBackend, { name: "Ana's iPhone", level: "operate" });
    const forged = seedDevice(world, freshBackend, { name: "Forged phone", badSignature: true });

    await gotoApp(page, freshBackend.bootBase);
    const dialog = await openSettingsGeneral(page);
    const section = dialog.getByTestId("remote-access-section");
    await expect(section).toBeVisible({ timeout: 20_000 });

    // The seeded list renders
    await expect(section.getByTestId(`remote-device-${ana.id}`)).toContainText("Ana's iPhone");
    await expect(section.getByTestId(`remote-device-${ana.id}`)).toContainText("operate");
    await expect(section.getByTestId(`remote-device-${forged.id}`).getByTestId("remote-device-not-trusted")).toContainText("Not trusted");
    // the pairing hint is text, not a button
    await expect(section.getByTestId("remote-pair-hint")).toContainText("Agetor › Pair a Phone…");
    await expect(section.getByRole("button", { name: /^Pair/ })).toHaveCount(0);

    // Revoke goes through a confirm dialog
    await section.getByTestId(`remote-device-revoke-${ana.id}`).click();
    const confirm = page.getByRole("dialog").filter({ hasText: "Revoke Ana's iPhone?" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(section.getByTestId(`remote-device-${ana.id}`)).toContainText("Not trusted: revoked", { timeout: 20_000 });
    await expect(section.getByTestId(`remote-device-revoke-${ana.id}`)).toHaveCount(0);

    // Activity shows the revoke, and the chain verifies
    await expect(section.getByTestId("remote-log")).toContainText("Phone revoked", { timeout: 20_000 });
    await expect(section.getByTestId("remote-log-chain")).toHaveAttribute("data-ok", "true");
    await expect(section.getByTestId("remote-log-chain")).toContainText("The log is intact.");
  });

  test("the Mac's name is validated and saved", async ({ page, freshBackend }) => {
    await gotoApp(page, freshBackend.bootBase);
    const dialog = await openSettingsGeneral(page);
    const section = dialog.getByTestId("remote-access-section");
    await expect(section).toBeVisible({ timeout: 20_000 });
    const name = section.getByTestId("remote-mac-name");
    const save = section.getByTestId("remote-mac-name-save");
    await name.fill("");
    await expect(save).toBeDisabled();
    await name.fill("Studio Mac");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(save).toBeDisabled({ timeout: 10_000 });
    const res = await page.request.get(`${freshBackend.apiBase}/remote-access`, { headers: { authorization: `Bearer ${freshBackend.apiToken}` } });
    expect(((await res.json()) as { macName: string }).macName).toBe("Studio Mac");
  });

  test("the background card and the Remote access section never disagree for long when the probe turns remote access off", async ({ page, freshBackend }) => {
    // No live host is recorded, so the background probe turns the seeded switch off (remote access never stays on over a host that isn't
    // running). The two surfaces poll on their own clocks (5 s and 10 s); whichever reads Off first tells the other at once.
    await gotoApp(page, freshBackend.bootBase);
    const dialog = await openSettingsGeneral(page);
    const section = dialog.getByTestId("remote-access-section");
    await expect(section).toBeVisible({ timeout: 20_000 });
    const card = dialog.getByTestId("background-section").getByTestId("remote-access-state");
    const own = section.getByTestId("remote-access-switch-state");
    const off = async (l: typeof card) => (await l.getAttribute("data-enabled")) === "false";
    await expect.poll(async () => (await off(card)) || (await off(own)), { timeout: 30_000, intervals: [100] }).toBe(true);
    await expect(card).toHaveAttribute("data-enabled", "false", { timeout: 2_000 });
    await expect(own).toHaveAttribute("data-enabled", "false", { timeout: 2_000 });
  });
});
