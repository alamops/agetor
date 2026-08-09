import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_API_PORT, E2E_API_TOKEN, E2E_BASE_URL } from "../playwright.config";

/**
 * E2E coverage for the Auto/Dark/Light theme feature
 * (docs/plans/auto-dark-light-theme.md, T10). Runs Chromium against the real
 * webview served by `bun run hmr` and the real Bun API/orchestrator served
 * by `src/bun/headless.ts` (both started by `playwright.config.ts`'s
 * `webServer`) — no mocked fetches, no internal API calls standing in for UI
 * interaction.
 *
 * These assert **computed colors and DOM classes**, never pixel/screenshot
 * diffs: Chromium's rendering differs from the WKWebView the app actually
 * ships in, so a pixel baseline would be flaky and wouldn't reflect the real
 * product. `screenshot: "only-on-failure"` in the config still captures
 * human-reviewable artifacts on failure.
 *
 * Tests share one headless server + SQLite DB (see `E2E_DATA_DIR`) and run
 * serially — the persistence spec depends on the DB state a prior test left
 * behind, and each test still starts from a known preference via the direct
 * `PUT /preferences/theme` call in `setThemePreference`, so ordering never
 * has to be inferred from Settings-UI state.
 */

const API_BASE = `http://127.0.0.1:${E2E_API_PORT}`;
const BOOT_URL = `${E2E_BASE_URL}/#api=${E2E_API_PORT}&token=${E2E_API_TOKEN}`;

test.describe.configure({ mode: "serial" });

/** Arrange-only helper: seeds the persisted preference directly through the
 *  API so each test starts from a known state, without that setup step
 *  itself being the thing under test (spec 2 below drives the actual change
 *  through the Settings UI, which is what's meant to be under test). */
async function setThemePreference(
  request: APIRequestContext,
  value: "auto" | "dark" | "light",
): Promise<void> {
  const res = await request.put(`${API_BASE}/preferences/theme`, {
    headers: { authorization: `Bearer ${E2E_API_TOKEN}` },
    data: { value },
  });
  expect(res.ok()).toBeTruthy();
}

/** Navigates to the app boot URL and waits for real rendered content — the
 *  Settings button in the app bar — rather than a fixed sleep. */
async function gotoApp(page: Page): Promise<void> {
  await page.goto(BOOT_URL);
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
}

function isDark(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.classList.contains("dark"));
}

function colorScheme(page: Page): Promise<string> {
  return page.evaluate(() => document.documentElement.style.colorScheme);
}

function bodyBackground(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

async function openSettingsGeneral(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  return dialog;
}

test.describe("theme: boot resolution (no flash)", () => {
  for (const system of ["dark", "light"] as const) {
    test(`resolves "auto" to the system's ${system} scheme before first paint`, async ({
      page,
      request,
    }) => {
      await setThemePreference(request, "auto");

      // Record the `dark` class + color-scheme the instant the document
      // finishes parsing (i.e. right after index.html's blocking <head>
      // script has run, and well before React mounts) so we can prove the
      // theme was already settled then — not merely correct by the time our
      // assertions run after full load.
      await page.addInitScript(() => {
        (window as unknown as { __themeAtParse?: { cls: string; scheme: string } }).__themeAtParse =
          undefined;
        document.addEventListener(
          "readystatechange",
          () => {
            if (document.readyState !== "loading" && !(window as any).__themeAtParse) {
              (window as any).__themeAtParse = {
                cls: document.documentElement.className,
                scheme: document.documentElement.style.colorScheme,
              };
            }
          },
          { once: false },
        );
      });

      await page.emulateMedia({ colorScheme: system });
      await gotoApp(page);

      const atParse = await page.evaluate(
        () => (window as unknown as { __themeAtParse?: { cls: string; scheme: string } }).__themeAtParse,
      );
      expect(atParse, "theme should already be settled right after HTML parsing").toBeTruthy();

      const expectDark = system === "dark";
      expect(atParse!.cls.includes("dark")).toBe(expectDark);
      expect(atParse!.scheme).toBe(system);

      // And it must still match after the app has fully mounted — i.e. no
      // late correction/flip once React's ThemeProvider takes over.
      expect(await isDark(page)).toBe(expectDark);
      expect(await colorScheme(page)).toBe(system);
    });
  }
});

test.describe("theme: Settings → General picker", () => {
  test("selecting Light flips <html> off dark and repaints body; selecting Dark restores it", async ({
    page,
    request,
  }) => {
    await setThemePreference(request, "dark");
    await gotoApp(page);
    expect(await isDark(page)).toBe(true);
    const darkBg = await bodyBackground(page);

    const dialog = await openSettingsGeneral(page);
    await dialog.getByRole("button", { name: "Light", exact: true }).click();

    await expect
      .poll(() => isDark(page), { message: "expected <html> to lose the dark class" })
      .toBe(false);
    expect(await colorScheme(page)).toBe("light");
    const lightBg = await bodyBackground(page);
    expect(lightBg).not.toBe(darkBg);

    await dialog.getByRole("button", { name: "Dark", exact: true }).click();
    await expect
      .poll(() => isDark(page), { message: "expected <html> to regain the dark class" })
      .toBe(true);
    expect(await colorScheme(page)).toBe("dark");
    expect(await bodyBackground(page)).toBe(darkBg);
  });

  test("persists the choice across a reload", async ({ page, request }) => {
    await setThemePreference(request, "dark");
    await gotoApp(page);

    const dialog = await openSettingsGeneral(page);
    await dialog.getByRole("button", { name: "Light", exact: true }).click();
    await expect.poll(() => isDark(page)).toBe(false);

    await page.reload();
    await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();

    // Persisted server-side (PUT /preferences/theme), not client localStorage
    // — so a fresh load must come back Light without re-touching the UI.
    expect(await isDark(page)).toBe(false);
    expect(await colorScheme(page)).toBe("light");

    const prefs = await request.get(`${API_BASE}/preferences`, {
      headers: { authorization: `Bearer ${E2E_API_TOKEN}` },
    });
    expect((await prefs.json()).theme).toBe("light");
  });
});

test.describe("theme: Auto follows the system", () => {
  test("tracks the emulated OS preference, including a live flip while open", async ({
    page,
    request,
  }) => {
    await setThemePreference(request, "auto");
    await page.emulateMedia({ colorScheme: "light" });
    await gotoApp(page);
    expect(await isDark(page)).toBe(false);

    // Live flip — no reload, no re-navigation. This is the behavior
    // ThemeProvider's matchMedia "change" listener exists for.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect
      .poll(() => isDark(page), { message: "expected a live flip to dark on OS change" })
      .toBe(true);
    expect(await colorScheme(page)).toBe("dark");

    await page.emulateMedia({ colorScheme: "light" });
    await expect
      .poll(() => isDark(page), { message: "expected a live flip back to light on OS change" })
      .toBe(false);
    expect(await colorScheme(page)).toBe("light");
  });
});

test.describe("theme: token layer is live", () => {
  test("a converted status token (--danger) actually differs between themes", async ({
    page,
    request,
  }) => {
    const readDanger = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--danger").trim(),
      );

    await setThemePreference(request, "dark");
    await gotoApp(page);
    const dangerDark = await readDanger();

    const dialog = await openSettingsGeneral(page);
    await dialog.getByRole("button", { name: "Light", exact: true }).click();
    await expect.poll(() => isDark(page)).toBe(false);
    const dangerLight = await readDanger();

    expect(dangerDark).toBeTruthy();
    expect(dangerLight).toBeTruthy();
    expect(dangerLight).not.toBe(dangerDark);
  });
});
