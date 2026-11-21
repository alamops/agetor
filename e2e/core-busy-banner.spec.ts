import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  /**
   * `docs/plans/non-blocking-core.md` §1 criteria 2-3 / X10: with ~500 tasks
   * in the database and a heavy real-watcher turn re-attaching ~30 MB of
   * subagent transcripts, the board keeps following the core (a change made
   * through the API shows on a card within a bound) and the "core is busy"
   * banner never appears. The stall test above proves the banner CAN show;
   * this one proves a loaded-but-not-blocked core does not trip it.
   */
  test("500 seeded tasks plus a heavy watcher replay: the board keeps updating and the busy banner never shows", async ({
    page,
    request,
    freshBackend,
  }) => {
    test.setTimeout(400_000);
    const backend = freshBackend;
    const suffix = randomUUID();
    const SEEDED = 500;

    // Seed through the API, 25 at a time.
    for (let from = 0; from < SEEDED; from += 25) {
      await Promise.all(
        Array.from({ length: Math.min(25, SEEDED - from) }, async (_, i) => {
          const res = await request.post(`${backend.apiBase}/tasks`, {
            headers: auth(backend),
            data: { title: `seed-${suffix}-${from + i}`, prompt: "seed", isolation: "none", workdir: tmpdir() },
          });
          expect(res.ok(), `POST /tasks -> ${res.status()}`).toBeTruthy();
        }),
      );
    }

    // Heavy task: turn 1 writes 60 x 512 KB sidechain transcripts and attaches
    // the real watcher; the follow-up re-attaches it (rehydrate + replay).
    const workdirA = await mkdtemp(path.join(tmpdir(), "agetor-e2e-busy-"));
    const heavyRes = await request.post(`${backend.apiBase}/tasks`, {
      headers: auth(backend),
      data: {
        title: `heavy-${suffix}`,
        prompt: `stress __agetor_fake_claude_real_watcher__:60x512`,
        isolation: "none",
        workdir: workdirA,
      },
    });
    expect(heavyRes.ok()).toBeTruthy();
    const heavy = (await heavyRes.json()) as { id: string };
    const startRes = await request.post(`${backend.apiBase}/tasks/${heavy.id}/start`, { headers: auth(backend) });
    expect(startRes.ok(), `start -> ${startRes.status()}`).toBeTruthy();

    // Probe task in Done so its card is on screen among few siblings.
    const probeRes = await request.post(`${backend.apiBase}/tasks`, {
      headers: auth(backend),
      data: { title: `probe-${suffix}-0`, prompt: "probe", isolation: "none", workdir: tmpdir() },
    });
    const probe = (await probeRes.json()) as { id: string };
    const toDone = await request.patch(`${backend.apiBase}/tasks/${probe.id}`, {
      headers: auth(backend),
      data: { column: "done" },
    });
    expect(toDone.ok()).toBeTruthy();

    // Record any moment the banner is in the DOM, not just the instants we poll.
    await page.addInitScript(() => {
      (window as unknown as { __busySeen: number }).__busySeen = 0;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="core-busy-banner"]')) {
          (window as unknown as { __busySeen: number }).__busySeen++;
        }
      }).observe(document, { subtree: true, childList: true });
    });
    await gotoApp(page, backend.bootBase);
    await expect(page.getByText(`probe-${suffix}-0`, { exact: true })).toBeVisible({ timeout: 30_000 });
    const banner = page.getByTestId("core-busy-banner");

    // Wait for turn 1 to settle, then fire the follow-up (the re-attach) and
    // keep poking the board while it runs.
    let runId: string | null = null;
    await expect(async () => {
      const res = await request.get(`${backend.apiBase}/tasks/${heavy.id}`, { headers: auth(backend) });
      const t = (await res.json()) as { column: string; runId: string | null };
      expect(t.column).toBe("review");
      runId = t.runId;
    }).toPass({ timeout: 200_000 });
    let followUpDone = false;
    const followUp = request.post(`${backend.apiBase}/runs/${runId}/input`, {
      headers: auth(backend),
      data: { line: `follow-up-${suffix}` },
      timeout: 120_000,
    }).finally(() => { followUpDone = true; });

    const BOARD_UPDATE_BOUND_MS = 6_000;
    const latencies: number[] = [];
    // At least 8 probes, and keep going for as long as the replay is in flight.
    for (let i = 1; i <= 8 || (!followUpDone && i <= 60); i++) {
      const title = `probe-${suffix}-${i}`;
      const t0 = Date.now();
      const res = await request.patch(`${backend.apiBase}/tasks/${probe.id}`, {
        headers: auth(backend),
        data: { title },
      });
      expect(res.ok(), `PATCH title -> ${res.status()}`).toBeTruthy();
      await expect(page.getByText(title, { exact: true })).toBeVisible({ timeout: BOARD_UPDATE_BOUND_MS });
      latencies.push(Date.now() - t0);
      await expect(banner, `no busy banner (update ${i})`).toHaveCount(0);
      await page.waitForTimeout(300);
    }
    await followUp;
    await expect(banner).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __busySeen: number }).__busySeen)).toBe(0);
    console.log(`[core-busy-banner] board update latencies under heavy load: ${latencies.join("/")} ms`);
  });
});
