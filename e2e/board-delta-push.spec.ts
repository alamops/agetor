import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { Request } from "@playwright/test";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for the board's delta + push path
 * (`docs/architecture/core-responsiveness.md` § Delta and push; plan
 * `docs/plans/non-blocking-core.md` X11). The board asks `GET /tasks?delta=1`
 * (with `&since=<cursor>` once it has one), the core pushes a content-free
 * `tasks-changed` event on the global stream, and the safety poll is only 15 s
 * while that stream is connected.
 *
 * Timing bounds are deliberately a little looser than the product's ~250 ms
 * (the machine running the suite is often heavily loaded) but far below the
 * 15 s safety poll and the 2 s disconnected poll, so a pass proves the push.
 */

const PUSH_BOUND_MS = 3_000;

function auth(backend: E2EBackend): { authorization: string; "content-type": string } {
  return { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
}

async function createTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title, prompt: title, isolation: "none", workdir: tmpdir(), ...extra },
  });
  expect(res.ok(), `POST /tasks -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}

async function patchTask(request: APIRequestContext, backend: E2EBackend, id: string, data: Record<string, unknown>) {
  const res = await request.patch(`${backend.apiBase}/tasks/${id}`, { headers: auth(backend), data });
  expect(res.ok(), `PATCH /tasks/${id} -> ${res.status()}: ${await res.text()}`).toBeTruthy();
}

async function archiveTask(request: APIRequestContext, backend: E2EBackend, id: string): Promise<void> {
  await patchTask(request, backend, id, { column: "done" });
  const res = await request.post(`${backend.apiBase}/tasks/${id}/archive`, { headers: auth(backend) });
  expect(res.ok(), `POST archive -> ${res.status()}: ${await res.text()}`).toBeTruthy();
}

/** The board's task-list request: `GET /tasks` with `delta=1`. */
function isDeltaGet(req: Request): boolean {
  if (req.method() !== "GET") return false;
  const u = new URL(req.url());
  return u.pathname === "/tasks" && u.searchParams.get("delta") === "1";
}

function taskCard(page: Page, id: string): Locator {
  return page.locator(`[data-task-id="${id}"]`);
}

function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

/** Resolves once the global event stream (`GET /events`) has answered, i.e.
 *  push is connected. Register BEFORE `gotoApp`. */
function globalStreamConnected(page: Page): Promise<unknown> {
  return page.waitForResponse((r) => new URL(r.url()).pathname === "/events", { timeout: 30_000 });
}

async function panelClosed(page: Page): Promise<void> {
  const backdrop = page.getByRole("button", { name: "Close task panel" });
  await expect
    .poll(
      async () =>
        backdrop.evaluateAll((els) => els.length === 0 || els.every((el) => getComputedStyle(el).pointerEvents === "none")),
      { timeout: 15_000, message: "task panel did not close" },
    )
    .toBe(true);
}

test.describe("board delta + push", () => {
  test("a change made through the API reaches the card within the push bound, far under the safety poll", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(90_000);
    const id = await createTask(request, backend, `push-a-${randomUUID()}`);
    const connected = globalStreamConnected(page);
    await gotoApp(page, backend.bootBase);
    await expect(taskCard(page, id)).toBeVisible();
    await connected;

    // A new task appears.
    const newTitle = `push-new-${randomUUID()}`;
    const t0 = Date.now();
    const newId = await createTask(request, backend, newTitle);
    await expect(taskCard(page, newId)).toBeVisible({ timeout: PUSH_BOUND_MS });
    const createdMs = Date.now() - t0;

    // An existing card's title changes.
    const renamed = `push-renamed-${randomUUID()}`;
    const t1 = Date.now();
    await patchTask(request, backend, id, { title: renamed });
    await expect(taskCard(page, id).getByText(renamed, { exact: true })).toBeVisible({ timeout: PUSH_BOUND_MS });
    const renamedMs = Date.now() - t1;
    console.log(`[board-delta-push] create ${createdMs} ms, rename ${renamedMs} ms`);
  });

  test("the first load is a snapshot, the idle poll sends delta=1&since=, and no two delta requests overlap during rapid mutations", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(120_000);
    const id = await createTask(request, backend, `overlap-${randomUUID()}`);

    const seen: { url: string; since: string | null; start: number; end: number | null }[] = [];
    const byReq = new Map<Request, (typeof seen)[number]>();
    page.on("request", (req) => {
      if (!isDeltaGet(req)) return;
      const entry = { url: req.url(), since: new URL(req.url()).searchParams.get("since"), start: Date.now(), end: null };
      seen.push(entry);
      byReq.set(req, entry);
    });
    const finish = (req: Request) => {
      const e = byReq.get(req);
      if (e) e.end = Date.now();
    };
    page.on("requestfinished", finish);
    page.on("requestfailed", finish);

    const connected = globalStreamConnected(page);
    await gotoApp(page, backend.bootBase);
    await expect(taskCard(page, id)).toBeVisible();
    await connected;

    expect(seen.length, "the board asked for a delta").toBeGreaterThan(0);
    expect(seen[0].since, "the first request has no cursor (snapshot)").toBeNull();
    expect(new URL(seen[0].url).searchParams.get("archived")).toBe("exclude");

    // Rapid mutations: pushes arrive faster than responses; the client must
    // queue one re-run, never overlap.
    const before = seen.length;
    let last = "";
    for (let i = 0; i < 12; i++) {
      last = `overlap-${i}-${randomUUID()}`;
      await patchTask(request, backend, id, { title: last });
    }
    await expect(taskCard(page, id).getByText(last, { exact: true })).toBeVisible({ timeout: PUSH_BOUND_MS * 2 });
    // Let the trailing fetch settle.
    await expect.poll(() => seen.every((e) => e.end !== null), { timeout: 10_000 }).toBe(true);

    const burst = seen.slice(before);
    expect(burst.length, "the mutations were delivered as delta requests").toBeGreaterThan(0);
    for (const e of burst) expect(e.since, `burst request carries a cursor: ${e.url}`).not.toBeNull();
    // Pairwise overlap across every request since load.
    const sorted = [...seen].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      expect(
        sorted[i].start >= (sorted[i - 1].end ?? Infinity),
        `delta request ${i} started before the previous one finished`,
      ).toBe(true);
    }

    // The safety poll: with the stream connected it fires every 15 s, idle,
    // and is a `since=` delta too.
    const idleStart = seen.length;
    await expect
      .poll(() => seen.length > idleStart, { timeout: 25_000, message: "no idle safety-poll request in 25 s" })
      .toBe(true);
    expect(seen[idleStart].since, "the idle poll sends since=").not.toBeNull();
    expect(new URL(seen[idleStart].url).searchParams.get("delta")).toBe("1");
  });

  test("archiving removes the card; deleting the open task closes its panel", async ({ page, request, backend }) => {
    test.setTimeout(90_000);
    const suffix = randomUUID();
    const archivedId = await createTask(request, backend, `rm-archive-${suffix}`);
    const deletedId = await createTask(request, backend, `rm-delete-${suffix}`);
    const connected = globalStreamConnected(page);
    await gotoApp(page, backend.bootBase);
    await expect(taskCard(page, archivedId)).toBeVisible();
    await expect(taskCard(page, deletedId)).toBeVisible();
    await connected;

    await archiveTask(request, backend, archivedId);
    await expect(taskCard(page, archivedId)).toHaveCount(0, { timeout: PUSH_BOUND_MS * 2 });

    // Open the second task, then delete it from "another client".
    await taskCard(page, deletedId).click();
    const panel = runPanel(page);
    await expect(panel).toHaveClass(/translate-x-0/);
    const del = await request.delete(`${backend.apiBase}/tasks/${deletedId}`, { headers: auth(backend) });
    expect(del.ok(), `DELETE -> ${del.status()}`).toBeTruthy();
    await expect(taskCard(page, deletedId)).toHaveCount(0, { timeout: PUSH_BOUND_MS * 2 });
    await panelClosed(page);
  });

  test("the All view is a snapshot without a cursor, Active drops it again, and an opened archived task is kept", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(120_000);
    const suffix = randomUUID();
    const liveId = await createTask(request, backend, `view-live-${suffix}`);
    const archId = await createTask(request, backend, `view-arch-${suffix}`);
    await archiveTask(request, backend, archId);

    const urls: string[] = [];
    page.on("request", (req) => { if (isDeltaGet(req)) urls.push(req.url()); });
    const connected = globalStreamConnected(page);
    await gotoApp(page, backend.bootBase);
    await expect(taskCard(page, liveId)).toBeVisible();
    await connected;
    await expect(taskCard(page, archId)).toHaveCount(0);

    const filter = page.getByTitle("Filter by archive state");

    // Active -> All: the very next delta request has no `since` and no
    // `archived` filter, and the archived card shows.
    let mark = urls.length;
    await filter.selectOption("all");
    await expect(taskCard(page, archId)).toBeVisible({ timeout: 15_000 });
    const allReq = new URL(urls[mark]);
    expect(allReq.searchParams.has("since"), "All view's first request is a snapshot").toBe(false);
    expect(allReq.searchParams.has("archived")).toBe(false);

    // Open the archived task, then back to Active: it rides `keep=`, stays
    // listed and its panel stays open.
    // The archived card is aria-disabled (no drag), so Playwright calls it "not enabled": force the click.
    await taskCard(page, archId).getByText(`view-arch-${suffix}`, { exact: true }).first().click({ force: true });
    const panel = runPanel(page);
    await expect(panel).toHaveClass(/translate-x-0/);
    mark = urls.length;
    await filter.selectOption("active");
    // Going back to Active does not fetch at once (only a view that NEEDS the
    // archive does); the next push or the 15 s safety poll carries the new
    // filter, as a snapshot.
    await expect.poll(() => urls.length > mark, { timeout: 30_000 }).toBe(true);
    const activeReq = new URL(urls[mark]);
    expect(activeReq.searchParams.has("since"), "switching view drops the cursor").toBe(false);
    expect(activeReq.searchParams.get("archived")).toBe("exclude");
    expect((activeReq.searchParams.get("keep") ?? "").split(",")).toContain(archId);
    // The Active board hides the archived card, but the task stays in the kept
    // list, so the panel on it is still open and still rendering.
    await expect(panel).toHaveClass(/translate-x-0/);
    await expect(panel.getByText(`view-arch-${suffix}`, { exact: true }).first()).toBeVisible();
    await expect(taskCard(page, liveId)).toBeVisible();

    // Close it: the keep set shrinks, so the next request stops naming it.
    await panel.getByRole("button", { name: "Close task details" }).click();
    await panelClosed(page);
    mark = urls.length;
    await expect
      .poll(
        () => urls.slice(mark).some((u) => !(new URL(u).searchParams.get("keep") ?? "").split(",").includes(archId)),
        { timeout: 30_000 },
      )
      .toBe(true);
    await expect(taskCard(page, archId)).toHaveCount(0);
    await expect(taskCard(page, liveId)).toBeVisible();
  });

  test("a decoration change (pending interaction card, open terminal) reaches the card badge via push", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(120_000);
    const suffix = randomUUID();
    const enable = await request.patch(`${backend.apiBase}/harnesses/cursor`, {
      headers: auth(backend),
      data: { enabled: true },
    });
    expect(enable.ok(), `PATCH /harnesses/cursor -> ${enable.status()}`).toBeTruthy();
    try {
      const askId = await createTask(request, backend, `deco-ask-${suffix}`, {
        agent: "cursor",
        prompt: `__agetor_fake_cursor_ask__ deco-ask-${suffix}`,
      });
      const termId = await createTask(request, backend, `deco-term-${suffix}`);

      const connected = globalStreamConnected(page);
      await gotoApp(page, backend.bootBase);
      await expect(taskCard(page, askId)).toBeVisible();
      await expect(taskCard(page, termId)).toBeVisible();
      await connected;

      // Starting the ask task registers a card in memory: no `tasks` row
      // change carries it, only the decoration push does the "Answer" button.
      const startRes = await request.post(`${backend.apiBase}/tasks/${askId}/start`, { headers: auth(backend) });
      expect(startRes.ok(), `start -> ${startRes.status()}`).toBeTruthy();
      await expect(taskCard(page, askId).getByRole("button", { name: "Answer", exact: true })).toBeVisible({
        timeout: 20_000,
      });

      // An open terminal: badge appears and disappears with the PTY.
      const termRes = await request.post(`${backend.apiBase}/tasks/${termId}/terminals`, {
        headers: auth(backend),
        data: {},
      });
      expect(termRes.ok(), `POST terminals -> ${termRes.status()}: ${await termRes.text()}`).toBeTruthy();
      const term = (await termRes.json()) as { id: string };
      const badge = taskCard(page, termId).getByTitle("1 open terminal");
      const t0 = Date.now();
      await expect(badge).toBeVisible({ timeout: 10_000 });
      console.log(`[board-delta-push] terminal badge after ${Date.now() - t0} ms`);
      const closeRes = await request.delete(`${backend.apiBase}/terminals/${term.id}`, { headers: auth(backend) });
      expect(closeRes.ok(), `DELETE terminal -> ${closeRes.status()}`).toBeTruthy();
      await expect(badge).toHaveCount(0, { timeout: 10_000 });
    } finally {
      await request.patch(`${backend.apiBase}/harnesses/cursor`, { headers: auth(backend), data: { enabled: false } });
    }
  });

  test("a legacy bare-array answer to ?delta=1 still renders the board and merges later changes", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(90_000);
    const first = await createTask(request, backend, `legacy-a-${randomUUID()}`);
    let stubbed = 0;
    // An older core ignores `delta=1` and answers the plain list: fetch the
    // real legacy list (same query minus delta/since) and hand it back.
    await page.route(
      (url) => url.pathname === "/tasks" && url.searchParams.get("delta") === "1",
      async (route) => {
        const url = new URL(route.request().url());
        url.searchParams.delete("delta");
        url.searchParams.delete("since");
        const real = await route.fetch({ url: url.toString() });
        const body = await real.json();
        expect(Array.isArray(body), "legacy answer is a bare array").toBe(true);
        stubbed++;
        await route.fulfill({ response: real, json: body });
      },
    );
    const connected = globalStreamConnected(page);
    await gotoApp(page, backend.bootBase);
    await expect(taskCard(page, first)).toBeVisible();
    await connected;
    expect(stubbed).toBeGreaterThan(0);

    const second = await createTask(request, backend, `legacy-b-${randomUUID()}`);
    await expect(taskCard(page, second)).toBeVisible({ timeout: PUSH_BOUND_MS * 2 });
    await archiveTask(request, backend, second);
    await expect(taskCard(page, second)).toHaveCount(0, { timeout: PUSH_BOUND_MS * 2 });
  });

  test.skip("after a core restart (new bootId) the board repopulates from a snapshot", () => {
    // Skipped: e2e/fixtures.ts provisions one backend process per worker (and
    // per `freshBackend` test) and exposes no way to stop and relaunch it on
    // the same data dir and port. Covered at unit level by
    // src/bun/task-list-delta.test.ts (a cursor from another boot snapshots)
    // and src/mainview/lib/task-delta-client.test.ts.
  });
});
