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

interface ListResponse {
  params: URLSearchParams;
  status: number;
  ifNoneMatch: string | undefined;
  /** The parsed list for a 200; null for a 304 (the conditional poll's
   *  "unchanged", which has no body). */
  tasks: TaskRow[] | null;
}

/** Records every board-poll response from now on, 200 and 304 alike. Install
 *  it before `gotoApp` so the boot poll is seen too. */
function recordTaskLists(page: Page): ListResponse[] {
  const seen: ListResponse[] = [];
  page.on("response", async (res) => {
    if (!isTaskListGet(res.request())) return;
    const entry: ListResponse = {
      params: new URL(res.url()).searchParams,
      status: res.status(),
      ifNoneMatch: (await res.request().allHeaders())["if-none-match"],
      tasks: null,
    };
    if (entry.status === 200) {
      try { entry.tasks = (await res.json()) as TaskRow[]; } catch { return; }
    }
    seen.push(entry);
  });
  return seen;
}

/** The most recent recorded response that carried a list. */
function lastList(seen: ListResponse[]): (ListResponse & { tasks: TaskRow[] }) | undefined {
  return [...seen].reverse().find((e): e is ListResponse & { tasks: TaskRow[] } => e.tasks !== null);
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
    const seen = recordTaskLists(page);

    await gotoApp(page, backend.bootBase);
    await expect(taskCard(page, liveId)).toBeVisible();

    // A poll on the Active view leaves the archive server-side.
    await expect.poll(() => lastList(seen)?.params.get("archived")).toBe("exclude");
    const poll = lastList(seen)!;
    expect(poll.tasks.some((t) => t.id === archivedId)).toBe(false);
    expect(poll.tasks.every((t) => t.archivedAt == null)).toBe(true);
    // Every list request so far, the boot poll included, was an exclude one.
    expect(listUrls.length).toBeGreaterThan(0);
    for (const u of listUrls) expect(new URL(u).searchParams.get("archived")).toBe("exclude");
    await expect(taskCard(page, archivedId)).toHaveCount(0);

    // Switching to All asks for the full list right away (no `archived`
    // param), and the archived card renders from it.
    await page.getByTitle("Filter by archive state").selectOption("all");
    await expect.poll(() => {
      const last = lastList(seen);
      return !!last && !last.params.has("archived") && last.tasks.some((t) => t.id === archivedId);
    }).toBe(true);
    await expect(taskCard(page, archivedId)).toBeVisible();
    await expect(taskCard(page, liveId)).toBeVisible();

    // Back to Active: the poll drops the archive again.
    await page.getByTitle("Filter by archive state").selectOption("active");
    await expect(taskCard(page, archivedId)).toHaveCount(0);
    await expect.poll(() => seen.at(-1)?.params.get("archived")).toBe("exclude");
  });

  test("an unchanged board answers 304 to the conditional poll, and a change still reaches the board", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    const seen = recordTaskLists(page);
    await gotoApp(page, backend.bootBase);

    // After the first full answer the poll sends its ETag back and, with
    // nothing changed, gets an empty 304.
    await expect.poll(() => seen.some((e) => e.status === 304), { timeout: 15_000 }).toBe(true);
    const notModified = seen.find((e) => e.status === 304)!;
    expect(notModified.ifNoneMatch).toMatch(/^"[0-9a-z]+"$/);

    // A task created elsewhere changes the list: the next poll is a full
    // answer and the card shows up.
    const id = await createTask(request, backend, `poll-304-${randomUUID()}`);
    await expect(taskCard(page, id)).toBeVisible({ timeout: 15_000 });
    expect(lastList(seen)!.tasks.some((t) => t.id === id)).toBe(true);
  });

  test("the open task is kept while it is archived, and leaves the list once the panel closes", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    const title = `poll-keep-${randomUUID()}`;
    const id = await createTask(request, backend, title);

    const seen = recordTaskLists(page);
    await gotoApp(page, backend.bootBase);
    await taskCard(page, id).click();
    const panel = runPanel(page);
    await expect(panel).toHaveClass(/translate-x-0/);

    // Another client archives the open task. The Active view's poll names it
    // in `keep`, so it is still listed and the panel stays open on it.
    await archiveTask(request, backend, id);
    await expect.poll(() => {
      const last = lastList(seen);
      return !!last && last.params.get("archived") === "exclude"
        && (last.params.get("keep") ?? "").split(",").includes(id)
        && last.tasks.some((t) => t.id === id && t.archivedAt != null);
    }, { timeout: 15_000 }).toBe(true);
    await expect(panel).toHaveClass(/translate-x-0/);
    await expect(panel.getByText(title, { exact: true }).first()).toBeVisible();

    // Closed (via its own button, not Escape: RunPanel's Escape listener is
    // rAF-gated on `open`): the next polls stop keeping it and it is gone.
    const backdrop = page.getByRole("button", { name: "Close task panel" });
    await panel.getByRole("button", { name: "Close task details" }).click();
    await expect
      .poll(
        async () =>
          backdrop.evaluateAll((els) => els.length === 0 || els.every((el) => getComputedStyle(el).pointerEvents === "none")),
        { timeout: 10_000, message: "task panel did not close" },
      )
      .toBe(true);
    await expect.poll(() => {
      const last = lastList(seen);
      return !!last && !(last.params.get("keep") ?? "").split(",").includes(id) && !last.tasks.some((t) => t.id === id);
    }, { timeout: 15_000 }).toBe(true);
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
    const lists = recordTaskLists(page);
    await expect.poll(() => lists.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(lists.at(-1)!.params.has("archived")).toBe(false);
  });
});
