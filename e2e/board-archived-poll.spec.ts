import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { Request } from "@playwright/test";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp, putPreference } from "./helpers";

/**
 * E2E coverage for the board poll's archive filter (`TaskListArchived`,
 * docs/architecture/core-responsiveness.md). On the default "Active only"
 * view the 2 s `GET /tasks` poll asks for `archived=exclude`, so a DB with
 * thousands of archived tasks isn't re-shipped every tick; a view that shows
 * or counts archived tasks asks for the full list; whatever task is open is
 * named in `keep=` so archiving it never reads as the task vanishing.
 */

interface TaskRow { id: string; title: string; archivedAt: number | null }

function authHeaders(backend: E2EBackend): Record<string, string> {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function createTask(request: APIRequestContext, backend: E2EBackend, title: string): Promise<string> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: authHeaders(backend),
    data: { title, prompt: title, isolation: "none", workdir: tmpdir() },
  });
  expect(res.ok(), `POST /tasks -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as TaskRow).id;
}

/** Only a Done task can be archived; an unstarted one has no live run, so a
 *  PATCH to done and the plain archive route are enough. */
async function archiveTask(request: APIRequestContext, backend: E2EBackend, id: string): Promise<void> {
  const done = await request.patch(`${backend.apiBase}/tasks/${id}`, {
    headers: authHeaders(backend),
    data: { column: "done" },
  });
  expect(done.ok(), `PATCH column=done -> ${done.status()}: ${await done.text()}`).toBeTruthy();
  const res = await request.post(`${backend.apiBase}/tasks/${id}/archive`, { headers: authHeaders(backend) });
  expect(res.ok(), `POST archive -> ${res.status()}: ${await res.text()}`).toBeTruthy();
}

/** A board-poll `GET /tasks` (the list route itself, not `/tasks/:id/...`). */
function isTaskListGet(req: Request): boolean {
  if (req.method() !== "GET") return false;
  return new URL(req.url()).pathname === "/tasks";
}

/** Resolves with the next board-poll response's body and its query. */
async function nextTaskList(page: Page): Promise<{ params: URLSearchParams; tasks: TaskRow[] }> {
  const res = await page.waitForResponse((r) => isTaskListGet(r.request()) && r.ok());
  // The board asks for `?delta=1` now: a delta answer carries the changed rows
  // (all of them on a snapshot); a bare array is the legacy full list.
  const body = (await res.json()) as TaskRow[] | { tasks: TaskRow[] };
  return { params: new URL(res.url()).searchParams, tasks: Array.isArray(body) ? body : body.tasks };
}

/** Records every board-poll response from now on. A switch or a close now
 *  refetches at once, so a wait registered AFTER the action can miss the
 *  response; start the watch before the action and poll the recorded list. */
function watchTaskLists(page: Page): Array<{ params: URLSearchParams; tasks: TaskRow[] }> {
  const seen: Array<{ params: URLSearchParams; tasks: TaskRow[] }> = [];
  page.on("response", (r) => {
    if (!isTaskListGet(r.request()) || !r.ok()) return;
    void r.json().then((body: TaskRow[] | { tasks: TaskRow[] }) => {
      seen.push({ params: new URL(r.url()).searchParams, tasks: Array.isArray(body) ? body : body.tasks });
    }, () => {});
  });
  return seen;
}

/** The board card for a task id. By `data-task-id`, not `.cursor-grab`: an
 *  archived card is drag-disabled and carries no grab cursor. */
function taskCard(page: Page, id: string): Locator {
  return page.locator(`[data-task-id="${id}"]`);
}

/** The run panel's slide-over `<aside>` (`.last()`: NewTaskForm's sidebar is
 *  also an `<aside>`, mounted first). */
function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

test.describe("board poll archive filter", () => {
  test("Active only polls archived=exclude; All fetches the archive at once and shows it", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    const liveTitle = `poll-live-${randomUUID()}`;
    const archivedTitle = `poll-archived-${randomUUID()}`;
    const liveId = await createTask(request, backend, liveTitle);
    const archivedId = await createTask(request, backend, archivedTitle);
    await archiveTask(request, backend, archivedId);

    const listUrls: string[] = [];
    page.on("request", (req) => { if (isTaskListGet(req)) listUrls.push(req.url()); });

    await gotoApp(page, backend.bootBase);
    await expect(taskCard(page, liveId)).toBeVisible();

    // A steady-state poll on the Active view leaves the archive server-side.
    const poll = await nextTaskList(page);
    expect(poll.params.get("archived")).toBe("exclude");
    expect(poll.tasks.some((t) => t.id === archivedId)).toBe(false);
    expect(poll.tasks.every((t) => t.archivedAt == null)).toBe(true);
    // Every list request so far, the boot poll included, was an exclude one.
    expect(listUrls.length).toBeGreaterThan(0);
    for (const u of listUrls) expect(new URL(u).searchParams.get("archived")).toBe("exclude");
    await expect(taskCard(page, archivedId)).toHaveCount(0);

    // Switching to All asks for the full list right away (no `archived`
    // param), and the archived card renders from it.
    const full = nextTaskList(page);
    await page.getByTitle("Filter by archive state").selectOption("all");
    const fullPoll = await full;
    expect(fullPoll.params.has("archived")).toBe(false);
    expect(fullPoll.tasks.some((t) => t.id === archivedId)).toBe(true);
    await expect(taskCard(page, archivedId)).toBeVisible();
    await expect(taskCard(page, liveId)).toBeVisible();

    // Back to Active: the poll drops the archive again.
    const afterActive = watchTaskLists(page);
    await page.getByTitle("Filter by archive state").selectOption("active");
    await expect(taskCard(page, archivedId)).toHaveCount(0);
    await expect.poll(() => afterActive.at(-1)?.params.get("archived")).toBe("exclude");
  });

  test("the open task is kept while it is archived, and leaves the list once the panel closes", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    const title = `poll-keep-${randomUUID()}`;
    const id = await createTask(request, backend, title);

    await gotoApp(page, backend.bootBase);
    await taskCard(page, id).click();
    const panel = runPanel(page);
    await expect(panel).toHaveClass(/translate-x-0/);

    // Another client archives the open task. The Active view's poll names it
    // in `keep`, so it is still listed and the panel stays open on it.
    const seen = watchTaskLists(page);
    await archiveTask(request, backend, id);
    await expect.poll(() => seen.some(({ params, tasks }) =>
      params.get("archived") === "exclude"
        && (params.get("keep") ?? "").split(",").includes(id)
        && tasks.some((t) => t.id === id && t.archivedAt != null)), { timeout: 15_000 }).toBe(true);
    await expect(panel).toHaveClass(/translate-x-0/);
    await expect(panel.getByText(title, { exact: true }).first()).toBeVisible();

    // Closed (via its own button, not Escape: RunPanel's Escape listener is
    // rAF-gated on `open`): the next polls stop keeping it and it is gone.
    const backdrop = page.getByRole("button", { name: "Close task panel" });
    const closedFrom = seen.length;
    await panel.getByRole("button", { name: "Close task details" }).click();
    await expect
      .poll(
        async () =>
          backdrop.evaluateAll((els) => els.length === 0 || els.every((el) => getComputedStyle(el).pointerEvents === "none")),
        { timeout: 10_000, message: "task panel did not close" },
      )
      .toBe(true);
    await expect.poll(() => seen.slice(closedFrom).some(({ params, tasks }) =>
      !(params.get("keep") ?? "").split(",").includes(id) && !tasks.some((t) => t.id === id)), { timeout: 15_000 }).toBe(true);
    await expect(taskCard(page, id)).toHaveCount(0);
  });

  test("a replayed onboarding checklist counts archived tasks", async ({ page, request, freshBackend }) => {
    test.setTimeout(60_000);
    // The only task on this fresh backend is archived (and Done), so the
    // "create a task" and "run a task" steps are done only if the poll that
    // feeds onboarding carried archived tasks.
    const id = await createTask(request, freshBackend, `poll-onboarding-${randomUUID()}`);
    await archiveTask(request, freshBackend, id);
    await putPreference(request, freshBackend, "onboardingDismissed", "false");

    // Record every value the two steps ever render: the boot poll leaves the
    // archive out, and the checklist must wait for the full list rather than
    // flash these steps as not done in between.
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __onboardingSeen: string[] }).__onboardingSeen = seen;
      const record = () => {
        for (const id of ["task", "run"]) {
          const el = document.querySelector(`[data-testid="onboarding-step-${id}"]`);
          const v = el?.getAttribute("data-done");
          if (v != null) seen.push(`${id}:${v}`);
        }
      };
      new MutationObserver(record).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-done"] });
    });

    await gotoApp(page, freshBackend.bootBase, { seedOnboardingDismissed: false });
    await expect(page.getByTestId("onboarding-checklist")).toBeVisible();
    await expect(page.getByTestId("onboarding-step-task")).toHaveAttribute("data-done", "true");
    await expect(page.getByTestId("onboarding-step-run")).toHaveAttribute("data-done", "true");
    const seen = await page.evaluate(() => (window as unknown as { __onboardingSeen: string[] }).__onboardingSeen);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((v) => v.endsWith(":false"))).toEqual([]);
    // While the checklist can show, the poll carries the full list.
    const poll = await nextTaskList(page);
    expect(poll.params.has("archived")).toBe(false);
  });
});
