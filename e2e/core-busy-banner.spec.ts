import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type E2EBackend } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for the app-level "core is busy" banner
 * (`docs/plans/non-blocking-session-restore.md`, decision E / task T5 —
 * `src/mainview/lib/core-busy.ts`, `components/CoreBusyBanner.tsx`).
 *
 * What this pins: when the core stops answering altogether (its single Bun
 * thread held — a session restore, a VACUUM), a webview request that has been
 * pending past 3 s triggers a `/health` probe, two consecutive probes get no
 * answer within their 1.5 s abort, and the strip shows; once the core answers again the strip
 * clears by itself; and NOTHING was aborted or re-issued on the way — the
 * request that was pending across the stall completes and the panel renders
 * its transcript from it. The probe/threshold arithmetic itself is covered by
 * `core-busy.test.ts` with injected timers; this spec proves the real wiring
 * (api.ts `j()` → `trackRequest`, the unauthenticated `/health` probe, the
 * banner mount in App.tsx) against a genuinely blocked backend.
 *
 * The block comes from `POST /test/block-event-loop {ms}`, a route that only
 * exists when the backend started with `AGETOR_TEST_BLOCK_ROUTE=1` (set via
 * `backendEnv` below, so no other spec's backend has it).
 */

test.use({ backendEnv: { AGETOR_TEST_BLOCK_ROUTE: "1" } });

/** How long the core is held. Banner timeline (from the block being fired):
 *  +0.5 s before the panel's requests go pending, +3 s threshold, +1.5 s
 *  first probe abort, +2 s re-probe interval, +1.5 s second probe abort
 *  (`FAILED_PROBES_TO_SHOW` = 2) => visible at ~8.5 s, so a 12 s block leaves
 *  ~3.5 s of margin for a loaded machine. */
const BLOCK_MS = 12_000;
/** The banner must appear within this long of the block being fired. */
const BANNER_APPEAR_MS = 11_000;
/** …and be gone this long after the block ended. */
const BANNER_CLEAR_MS = 4_000;

function auth(backend: E2EBackend): { authorization: string; "content-type": string } {
  return { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
}

test.describe("core busy banner", () => {
  test("a blocked core shows the banner after a pending request, clears when it answers, and aborts nothing", async ({
    page,
    request,
    freshBackend,
  }) => {
    test.setTimeout(120_000);
    const backend = freshBackend;
    const title = `core-busy-${randomUUID()}`;

    const createRes = await request.post(`${backend.apiBase}/tasks`, {
      headers: auth(backend),
      data: { title, prompt: title, isolation: "none", workdir: tmpdir() },
    });
    expect(createRes.ok(), `POST /tasks -> ${createRes.status()}`).toBeTruthy();
    const task = (await createRes.json()) as { id: string };
    const startRes = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, { headers: auth(backend) });
    expect(startRes.ok(), `POST /tasks/${task.id}/start -> ${startRes.status()}`).toBeTruthy();
    await expect(async () => {
      const res = await request.get(`${backend.apiBase}/tasks/${task.id}`, { headers: auth(backend) });
      expect(((await res.json()) as { column: string }).column).toBe("review");
    }).toPass({ timeout: 30_000 });

    await gotoApp(page, backend.bootBase);
    const card = page.locator(".cursor-grab").filter({ has: page.getByText(title, { exact: true }) });
    await expect(card).toBeVisible();
    const banner = page.getByTestId("core-busy-banner");
    await expect(banner, "no banner on a healthy core").toHaveCount(0);

    // Hold the core. NOT awaited: the response only arrives when the block
    // ends. The long request timeout keeps Playwright's own client from
    // giving up on it.
    const blockedAt = Date.now();
    const block = request.post(`${backend.apiBase}/test/block-event-loop`, {
      headers: auth(backend),
      data: { ms: BLOCK_MS },
      timeout: 60_000,
    });
    // Let the server actually pick the request up and start blocking, so the
    // requests below land on a stalled core rather than being answered first.
    await page.waitForTimeout(500);

    // Opening the panel fires tracked webview requests (runs, events, git
    // status, …) that now sit unanswered.
    await card.click();
    const panel = page.locator("aside").last();

    await expect(banner).toBeVisible({ timeout: Math.max(1_000, BANNER_APPEAR_MS - (Date.now() - blockedAt)) });
    const appearedAfterMs = Date.now() - blockedAt;
    await expect(banner).toContainText("Agetor is busy");

    // The core answers again: the block call itself returns, then the strip
    // clears on its own — nothing for the user to click.
    const blockRes = await block;
    expect(blockRes.ok(), `POST /test/block-event-loop -> ${blockRes.status()}`).toBeTruthy();
    const unblockedAt = Date.now();
    await expect(banner).toHaveCount(0, { timeout: BANNER_CLEAR_MS });
    const clearedAfterMs = Date.now() - unblockedAt;

    // Nothing was aborted: the request that was pending across the stall
    // completed, so the panel renders the task's transcript.
    await expect(panel.getByText(`fake response to: ${title}`, { exact: true })).toBeVisible({ timeout: 15_000 });
    console.log(`[core-busy-banner] banner appeared after ${appearedAfterMs} ms, cleared ${clearedAfterMs} ms after the block ended`);
  });
});
