import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { E2EBackend } from "./fixtures";

/**
 * Helpers shared across e2e/*.spec.ts. Parametrized by the worker's
 * `E2EBackend` (e2e/fixtures.ts) rather than the old static
 * E2E_API_PORT/E2E_API_TOKEN module constants — each worker now owns its own
 * backend, so there is no single fixed port/token pair to close over.
 */

export interface GotoAppOptions {
  /**
   * Defaults to `true`: before navigating, seeds `onboardingDismissed="true"`
   * directly against the backend this `url` points at, so the first-run
   * welcome dialog / "Getting started" checklist (docs/plans/onboarding-
   * first-run.md) never appears for a spec that isn't testing it. Every
   * fresh per-worker backend (e2e/fixtures.ts's `backend`) starts with that
   * preference absent — which is exactly the "show onboarding" state — so
   * without this default, theme/font-size/quote specs would get a welcome
   * dialog overlay blocking their first click. Only e2e/onboarding.spec.ts
   * needs the real first-run state, via `{ seedOnboardingDismissed: false }`.
   */
  seedOnboardingDismissed?: boolean;
}

/** Preference key onboarding's visibility logic reads
 *  (`ONBOARDING_DISMISSED_PREF` in src/mainview/lib/onboarding.ts) — kept as
 *  a literal here rather than imported so this file has no dependency on
 *  mainview source. */
const ONBOARDING_DISMISSED_KEY = "onboardingDismissed";

/** Pulls `apiBase`/`token` out of a boot URL's `#api=<port>&token=<token>`
 *  hash. Used so `gotoApp` can seed a preference through `page.request`
 *  (available on `Page` without a separate `request` fixture) without
 *  widening its signature to take a full `E2EBackend` object — every
 *  existing caller already builds a plain url string (some, like font-
 *  size.spec.ts, append extra hash params of their own), so keeping `url`
 *  as the second parameter means zero edits to those call sites. */
function backendFromBootUrl(url: string): { apiBase: string; token: string } | null {
  const hashIndex = url.indexOf("#");
  if (hashIndex === -1) return null;
  const params = new URLSearchParams(url.slice(hashIndex + 1));
  const port = params.get("api");
  const token = params.get("token");
  if (!port || !token) return null;
  return { apiBase: `http://127.0.0.1:${port}`, token };
}

/** Navigates to a boot URL and waits for real rendered content — the
 *  Settings button in the app bar — rather than a fixed sleep. Callers
 *  assemble the URL themselves (`backend.bootBase` plus any spec-specific
 *  hash params, e.g. font-size.spec's `&fontSize=`). See `GotoAppOptions`
 *  for the default onboarding-dismissal seeding. */
export async function gotoApp(page: Page, url: string, options: GotoAppOptions = {}): Promise<void> {
  const { seedOnboardingDismissed = true } = options;
  if (seedOnboardingDismissed) {
    const backend = backendFromBootUrl(url);
    if (backend) {
      const res = await page.request.put(`${backend.apiBase}/preferences/${ONBOARDING_DISMISSED_KEY}`, {
        headers: { authorization: `Bearer ${backend.token}` },
        data: { value: "true" },
      });
      if (!res.ok()) {
        throw new Error(
          `gotoApp: failed to seed ${ONBOARDING_DISMISSED_KEY} (${res.status()} ${await res.text()})`,
        );
      }
    }
  }
  await page.goto(url);
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
}

/** Opens Settings → General (the default section on open — no tab click
 *  needed) and waits for the dialog to render. */
export async function openSettingsGeneral(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  return dialog;
}

/** Arrange-only helper: seeds a persisted preference directly through the
 *  API so a test starts from a known state, without that setup step itself
 *  being the thing under test. */
export async function putPreference(
  request: APIRequestContext,
  backend: E2EBackend,
  key: string,
  value: string,
): Promise<void> {
  const res = await request.put(`${backend.apiBase}/preferences/${key}`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
    data: { value },
  });
  expect(res.ok()).toBeTruthy();
}

/** Reads back the full persisted-preferences object. */
export async function getPreferences(
  request: APIRequestContext,
  backend: E2EBackend,
): Promise<Record<string, string>> {
  const res = await request.get(`${backend.apiBase}/preferences`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
  });
  return (await res.json()) as Record<string, string>;
}
