import {
  test,
  expect,
  type APIRequestContext,
  type E2EBackend,
  type Locator,
  type Page,
} from "./fixtures";
import { gotoApp as gotoAppUrl, openSettingsGeneral, getPreferences, putPreference } from "./helpers";

/**
 * E2E coverage for the Cmd+=/Cmd+-/Cmd+0 global font-size (UI zoom) feature
 * (docs/plans/cmd-font-size-controller.md, T4). Modeled directly on
 * e2e/theme.spec.ts's harness: real Chromium against the real webview
 * (Vite dev server) + the real Bun API/orchestrator (a per-worker instance
 * provisioned by the `backend` fixture in e2e/fixtures.ts) — no mocked
 * fetches.
 *
 * Assert **computed root font-size** only (`getComputedStyle(document
 * .documentElement).fontSize`), never screenshots — see theme.spec.ts's doc
 * comment for the full rationale (Chromium's rendering differs from the
 * WKWebView the app ships in).
 *
 * All tests in this file share this worker's one headless backend + SQLite
 * DB and run serially — each test still starts from a known preference via
 * the direct `PUT /preferences/fontSize` call in `setFontSizePreference`, so
 * ordering never has to be inferred from UI state (mirrors theme.spec.ts
 * exactly).
 *
 * The Settings → General "Font size" stepper (docs/plans/font-size-settings
 * -stepper.md, commit 68bc973) is a thin UI layer over the same
 * `useFontSize()` context the shortcut drives — same debounced persist, same
 * clamp — so its coverage below reuses the same state-cleanup and polling
 * conventions as the shortcut tests above.
 */

test.describe.configure({ mode: "serial" });

/** Arrange-only helper: seeds the persisted preference directly through the
 *  API so each test starts from a known state. */
async function setFontSizePreference(
  request: APIRequestContext,
  backend: E2EBackend,
  value: string,
): Promise<void> {
  await putPreference(request, backend, "fontSize", value);
}

async function getPersistedFontSize(
  request: APIRequestContext,
  backend: E2EBackend,
): Promise<string | undefined> {
  const body = await getPreferences(request, backend);
  return body.fontSize;
}

/** Navigates to the app boot URL — optionally carrying `&fontSize=<pct>` on
 *  the hash, mirroring what `buildWindowHash` (src/bun/window-url.ts) would
 *  produce for a persisted non-default value on the Vite dev path — and
 *  waits for real rendered content (the Settings button) rather than a
 *  fixed sleep. */
async function gotoApp(page: Page, backend: E2EBackend, bootFontSize?: number): Promise<void> {
  const url =
    bootFontSize === undefined
      ? backend.bootBase
      : `${backend.bootBase}&fontSize=${bootFontSize}`;
  await gotoAppUrl(page, url);
}

function rootFontSizePx(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
}

function rootInlineFontSize(page: Page): Promise<string> {
  return page.evaluate(() => document.documentElement.style.fontSize);
}

/** Same `metaKey` (Mac) vs `ctrlKey` (elsewhere) sniff the app itself uses
 *  (`isMacPlatform` in src/mainview/lib/platform.ts), evaluated in-page so
 *  the correct modifier is pressed regardless of the host platform Chromium
 *  reports. */
async function shortcutModifier(page: Page): Promise<"Meta" | "Control"> {
  const isMac = await page.evaluate(() => /mac/i.test(navigator.platform || navigator.userAgent || ""));
  return isMac ? "Meta" : "Control";
}

async function pressZoomIn(page: Page, mod: "Meta" | "Control"): Promise<void> {
  await page.keyboard.press(`${mod}+Equal`);
}

async function pressZoomOut(page: Page, mod: "Meta" | "Control"): Promise<void> {
  await page.keyboard.press(`${mod}+Minus`);
}

async function pressReset(page: Page, mod: "Meta" | "Control"): Promise<void> {
  await page.keyboard.press(`${mod}+Digit0`);
}

/** Locates the "Font size" `role="group"` row inside an already-open
 *  Settings dialog and returns its four addressable parts, per the markup
 *  pinned in SettingsDialog.tsx's `GeneralSection` (docs/plans/font-size-
 *  settings-stepper.md §2): a `role="group" aria-label="Font size"`
 *  container holding Decrease/readout/Increase/Reset. */
function fontSizeStepper(dialog: Locator) {
  const group = dialog.getByRole("group", { name: "Font size", exact: true });
  return {
    group,
    readout: group.getByRole("status"),
    decrease: group.getByRole("button", { name: "Decrease font size", exact: true }),
    increase: group.getByRole("button", { name: "Increase font size", exact: true }),
    reset: group.getByRole("button", { name: "Reset font size", exact: true }),
  };
}

test.describe("font-size: boot resolution (no flash)", () => {
  test("boots directly at a persisted non-default size, before first paint", async ({ page, request, backend }) => {
    await setFontSizePreference(request, backend, "140");

    // Record the computed root font-size the instant the document finishes
    // parsing (i.e. right after index.html's blocking <head> script has
    // run, and well before React mounts) so we can prove the size was
    // already scaled then — not merely correct by the time our assertions
    // run after full load. Mirrors theme.spec.ts's `__themeAtParse` capture.
    await page.addInitScript(() => {
      (window as unknown as { __fontSizeAtParse?: string }).__fontSizeAtParse = undefined;
      document.addEventListener(
        "readystatechange",
        () => {
          if (document.readyState !== "loading" && !(window as any).__fontSizeAtParse) {
            (window as any).__fontSizeAtParse = getComputedStyle(document.documentElement).fontSize;
          }
        },
        { once: false },
      );
    });

    // The Vite dev path has no window.__AGETOR preload — the persisted DB
    // value only reaches the client via the `fontSize` hash param (the same
    // one `buildWindowHash` appends for a non-default value on this path,
    // and the same one App.tsx's post-mount reconcile effect exists to
    // catch up on, too late for pre-paint, if this param is absent).
    await gotoApp(page, backend, 140);

    const atParse = await page.evaluate(
      () => (window as unknown as { __fontSizeAtParse?: string }).__fontSizeAtParse,
    );
    expect(atParse, "font size should already be scaled right after HTML parsing").toBe("22.4px");

    // And it must still hold after the app has fully mounted — no late
    // correction/flip once React's FontSizeProvider + boot-reconcile effect
    // take over.
    expect(await rootFontSizePx(page)).toBe("22.4px");

    await setFontSizePreference(request, backend, "100");
  });
});

test.describe("font-size: shortcut stepping", () => {
  test("Cmd/Ctrl+=/− steps the computed root font size by 10%, then persists after the debounce", async ({
    page,
    request,
    backend,
  }) => {
    await setFontSizePreference(request, backend, "100");
    await gotoApp(page, backend);
    expect(await rootFontSizePx(page)).toBe("16px");

    const mod = await shortcutModifier(page);

    await pressZoomIn(page, mod);
    await expect.poll(() => rootFontSizePx(page)).toBe("17.6px");

    await pressZoomIn(page, mod);
    await expect.poll(() => rootFontSizePx(page)).toBe("19.2px");

    await pressZoomOut(page, mod);
    await expect.poll(() => rootFontSizePx(page)).toBe("17.6px");

    // The PUT persist is debounced 300ms trailing-edge — poll the API
    // rather than asserting immediately after the last keypress.
    await expect
      .poll(() => getPersistedFontSize(request, backend), {
        message: "expected the settled 110% to persist to the server",
        timeout: 5_000,
      })
      .toBe("110");

    await setFontSizePreference(request, backend, "100");
  });
});

test.describe("font-size: clamping", () => {
  test("stepping down at the 100% floor stays clamped at 16px", async ({ page, request, backend }) => {
    await setFontSizePreference(request, backend, "100");
    await gotoApp(page, backend);
    expect(await rootFontSizePx(page)).toBe("16px");

    const mod = await shortcutModifier(page);
    await pressZoomOut(page, mod);
    await pressZoomOut(page, mod);

    // No state change occurs at the floor (stepFontSize clamps, and
    // applyStep's no-op guard skips setPercent entirely), so there is
    // nothing to poll for — assert directly, after giving any accidental
    // async update more than the debounce window to have shown up.
    await page.waitForTimeout(400);
    expect(await rootFontSizePx(page)).toBe("16px");
    expect(await rootInlineFontSize(page)).toBe("");

    const persisted = await getPersistedFontSize(request, backend);
    expect(persisted === undefined || persisted === "100").toBe(true);
  });

  test("stepping up past the 170% ceiling clamps at 27.2px", async ({ page, request, backend }) => {
    await setFontSizePreference(request, backend, "100");
    await gotoApp(page, backend);

    const mod = await shortcutModifier(page);
    // 7 presses reach the 170% ceiling (100 -> 170 in steps of 10); a few
    // extra presses confirm it stays clamped rather than overshooting.
    for (let i = 0; i < 10; i++) {
      await pressZoomIn(page, mod);
    }

    await expect.poll(() => rootFontSizePx(page)).toBe("27.2px");

    await expect
      .poll(() => getPersistedFontSize(request, backend), {
        message: "expected the clamped 170% to persist to the server",
        timeout: 5_000,
      })
      .toBe("170");

    await setFontSizePreference(request, backend, "100");
  });
});

test.describe("font-size: reset", () => {
  test("Cmd/Ctrl+0 resets to 100% and removes the inline style", async ({ page, request, backend }) => {
    await setFontSizePreference(request, backend, "140");
    await gotoApp(page, backend, 140);
    expect(await rootFontSizePx(page)).toBe("22.4px");

    const mod = await shortcutModifier(page);
    await pressReset(page, mod);

    await expect.poll(() => rootFontSizePx(page)).toBe("16px");
    expect(await rootInlineFontSize(page)).toBe("");

    await expect
      .poll(() => getPersistedFontSize(request, backend), {
        message: "expected the reset 100% to persist to the server",
        timeout: 5_000,
      })
      .toBe("100");
  });
});

test.describe("font-size: persists across reload", () => {
  test("a non-default size survives page.reload()", async ({ page, request, backend }) => {
    await setFontSizePreference(request, backend, "100");
    await gotoApp(page, backend);

    const mod = await shortcutModifier(page);
    await pressZoomIn(page, mod); // 110%
    await pressZoomIn(page, mod); // 120%
    await expect.poll(() => rootFontSizePx(page)).toBe("19.2px");

    // Wait for the debounced write to land before reloading, so the
    // persisted DB row actually holds 120% by the time the reload's boot
    // reconcile (App.tsx, fires once at mount) reads it back.
    await expect
      .poll(() => getPersistedFontSize(request, backend), {
        message: "expected 120% to persist before reloading",
        timeout: 5_000,
      })
      .toBe("120");

    // Reload keeps the same URL (no `fontSize` hash param was ever set on
    // it — the shortcut mutates React state, not the location bar), so on
    // this dev path the value only reaches the client via App.tsx's
    // post-mount `api.listPreferences()` reconcile, not a pre-paint boot
    // channel — hence polling rather than asserting the instant the
    // "Settings" button appears.
    await page.reload();
    await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
    await expect.poll(() => rootFontSizePx(page)).toBe("19.2px");

    await setFontSizePreference(request, backend, "100");
  });
});

test.describe("font-size: Settings stepper", () => {
  test("clicking Increase steps the readout and the computed root size, and persists after the debounce", async ({
    page,
    request,
    backend,
  }) => {
    await setFontSizePreference(request, backend, "100");
    await gotoApp(page, backend);
    const dialog = await openSettingsGeneral(page);
    const { readout, increase } = fontSizeStepper(dialog);

    await expect(readout).toHaveText("100%");
    await increase.click();
    await expect(readout).toHaveText("110%");
    await increase.click();
    await expect(readout).toHaveText("120%");

    // The dialog doesn't block root scaling — the stepper drives the same
    // `useFontSize()` context the shortcut does.
    expect(await rootFontSizePx(page)).toBe("19.2px");

    await expect
      .poll(() => getPersistedFontSize(request, backend), {
        message: "expected the settled 120% to persist to the server",
        timeout: 5_000,
      })
      .toBe("120");

    await setFontSizePreference(request, backend, "100");
  });

  test("clicking Reset returns to 100%, clears the inline style, and persists", async ({ page, request, backend }) => {
    await setFontSizePreference(request, backend, "140");
    await gotoApp(page, backend, 140);
    const dialog = await openSettingsGeneral(page);
    const { readout, reset } = fontSizeStepper(dialog);

    await expect(readout).toHaveText("140%");
    expect(await rootFontSizePx(page)).toBe("22.4px");

    await reset.click();

    await expect(readout).toHaveText("100%");
    await expect.poll(() => rootFontSizePx(page)).toBe("16px");
    expect(await rootInlineFontSize(page)).toBe("");

    await expect
      .poll(() => getPersistedFontSize(request, backend), {
        message: "expected the reset 100% to persist to the server",
        timeout: 5_000,
      })
      .toBe("100");
  });

  test("Decrease/Reset are aria-disabled at the 100% floor (and a click on Decrease is a no-op); Increase is aria-disabled at the 170% ceiling", async ({
    page,
    request,
    backend,
  }) => {
    await setFontSizePreference(request, backend, "100");
    await gotoApp(page, backend);
    const dialog = await openSettingsGeneral(page);
    const { readout, decrease, increase, reset } = fontSizeStepper(dialog);

    await expect(decrease).toHaveAttribute("aria-disabled", "true");
    await expect(reset).toHaveAttribute("aria-disabled", "true");
    await expect(increase).toHaveAttribute("aria-disabled", "false");

    // aria-disabled (not the `disabled` DOM property) leaves the button in
    // the DOM as a clickable element — the onClick handler guard is what
    // makes this a no-op, per docs/plans/font-size-settings-stepper.md's
    // contract. Playwright's own actionability check treats aria-disabled
    // the same as the native `disabled` attribute and refuses a plain
    // `.click()` (it waits for "enabled", timing out), so `force: true` is
    // required here to actually dispatch the click and exercise the
    // handler's own guard rather than Playwright's unrelated guard.
    await decrease.click({ force: true });
    await page.waitForTimeout(400);
    await expect(readout).toHaveText("100%");
    expect(await rootFontSizePx(page)).toBe("16px");
    const persistedAtFloor = await getPersistedFontSize(request, backend);
    expect(persistedAtFloor === undefined || persistedAtFloor === "100").toBe(true);

    // 7 clicks reach the 170% ceiling (100 -> 170 in steps of 10).
    for (let i = 0; i < 7; i++) {
      await increase.click();
    }

    await expect(readout).toHaveText("170%");
    await expect(increase).toHaveAttribute("aria-disabled", "true");
    expect(await rootFontSizePx(page)).toBe("27.2px");

    await setFontSizePreference(request, backend, "100");
  });
});

test.describe("font-size: Settings ↔ shortcut coherence", () => {
  test("pressing the keyboard shortcut while Settings is open updates the live readout", async ({
    page,
    request,
    backend,
  }) => {
    await setFontSizePreference(request, backend, "100");
    await gotoApp(page, backend);
    const dialog = await openSettingsGeneral(page);
    const { readout } = fontSizeStepper(dialog);
    await expect(readout).toHaveText("100%");

    const mod = await shortcutModifier(page);
    await pressZoomIn(page, mod);
    await expect(readout).toHaveText("110%");
    await pressZoomIn(page, mod);
    await expect(readout).toHaveText("120%");

    expect(await rootFontSizePx(page)).toBe("19.2px");

    await expect
      .poll(() => getPersistedFontSize(request, backend), {
        message: "expected the settled 120% to persist to the server",
        timeout: 5_000,
      })
      .toBe("120");

    await setFontSizePreference(request, backend, "100");
  });
});
