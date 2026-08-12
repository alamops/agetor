import { Database } from "bun:sqlite";
import path from "node:path";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { E2EBackend } from "./fixtures";
import type { HarnessQuota } from "../src/shared/types.ts";

/**
 * Helpers shared across e2e/*.spec.ts. Parametrized by the worker's
 * `E2EBackend` (e2e/fixtures.ts) rather than the old static
 * E2E_API_PORT/E2E_API_TOKEN module constants — each worker now owns its own
 * backend, so there is no single fixed port/token pair to close over.
 */

/** Navigates to a boot URL and waits for real rendered content — the
 *  Settings button in the app bar — rather than a fixed sleep. Callers
 *  assemble the URL themselves (`backend.bootBase` plus any spec-specific
 *  hash params, e.g. font-size.spec's `&fontSize=`). */
export async function gotoApp(page: Page, url: string): Promise<void> {
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

/**
 * Arrange-only helper for the per-harness usage tracker (docs/plans/harness-
 * usage-tracker.md): seeds a `harness_usage` snapshot directly into the
 * worker's isolated SQLite DB, bypassing the poller entirely.
 *
 * There is no ingestion route that works offline — `POST
 * /harnesses/:id/usage/refresh` hits the real provider (Anthropic/OpenAI/
 * Cursor) over the network — so a deterministic e2e test can't seed a known
 * meter through the HTTP API the way `putPreference` does. The app instead
 * boot-seeds the topbar tracker via `GET /usage`, which reads straight from
 * the `harness_usage` table (`src/bun/server.ts`'s `/usage` route, `db.ts`'s
 * `harnessUsage.getAll()`) with no other side effects — so writing the same
 * row this helper's backend counterpart (`harnessUsage.upsert`, `src/bun/db
 * .ts`) would write, directly via `bun:sqlite`, reproduces exactly what a
 * real poll would have persisted. Must run BEFORE `gotoApp` — App.tsx reads
 * `GET /usage` once, at mount.
 *
 * Opens and closes its own `Database` handle per call rather than caching
 * one on the backend fixture: this runs a handful of times per spec, well
 * off any hot path, and a short-lived handle can't outlive (and so can't
 * conflict with) the backend process's own WAL-mode connection to the same
 * file.
 */
export function seedHarnessUsage(backend: E2EBackend, quota: HarnessQuota): void {
  const db = new Database(path.join(backend.dataDir, "agetor.sqlite"));
  try {
    db.run(
      `INSERT INTO harness_usage (harness_id, snapshot_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(harness_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at`,
      [quota.harnessId, JSON.stringify(quota), Date.now()],
    );
  } finally {
    db.close();
  }
}
