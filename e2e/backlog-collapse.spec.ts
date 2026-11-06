import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for the collapsible messages-backlog tray
 * (`docs/plans/messages-backlog-collapse.md`). The tray is a purely
 * presentational component whose collapse state, `aria-expanded`, unmounted
 * list and height reclaim only exist in the real DOM, so Playwright is the
 * only layer that can observe this behavior (there is no jsdom/testing-library
 * harness in the repo — `bunfig.toml` scopes `bun test` to `src/`).
 *
 * Every scenario drives the real app: a real board card click opens the run
 * panel, and the API setup below only seeds the task + drafts (the same
 * idiom as `e2e/task-switch-during-restore.spec.ts`). Helpers stay local to
 * this file on purpose — no shared `e2e/helpers.ts` edits.
 */

interface TaskRow {
  id: string;
  backlog: { id: string; text: string }[];
}

function authHeaders(backend: E2EBackend): Record<string, string> {
  return { authorization: `Bearer ${backend.apiToken}` };
}

/** Create an unstarted task (`isolation: "none"`, a plain temp workdir — no
 *  git, no agent). The run panel opens for a task with no runs, and the
 *  backlog tray is gated on the draft count rather than on a run, so no fake
 *  agent turn is needed here. */
async function createTask(request: APIRequestContext, backend: E2EBackend, title: string): Promise<string> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: authHeaders(backend),
    data: { title, prompt: title, isolation: "none", workdir: tmpdir() },
  });
  expect(res.ok(), `POST /tasks -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  const task = (await res.json()) as TaskRow;
  return task.id;
}

/** Seed one saved draft and return its id (the API returns the full Task). */
async function seedDraft(
  request: APIRequestContext,
  backend: E2EBackend,
  taskId: string,
  text: string,
): Promise<string> {
  const res = await request.post(`${backend.apiBase}/tasks/${taskId}/backlog`, {
    headers: authHeaders(backend),
    data: { text },
  });
  expect(res.ok(), `POST /tasks/${taskId}/backlog -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  const task = (await res.json()) as TaskRow;
  const item = task.backlog.find((i) => i.text === text);
  expect(item, `seeded draft "${text}" is in the returned task`).toBeTruthy();
  return item!.id;
}

/** The run panel's slide-over `<aside>` — `.last()` because NewTaskForm's
 *  sidebar is also an `<aside>`, mounted first in App.tsx's JSX. */
function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

/** Click the task card by exact title and wait for the panel's open
 *  transition (`translate-x-0`) — for a task with no run the composer still
 *  renders, but the archived case below replaces it with a static footer, so
 *  the class check is the only universal "panel is open" proof.
 *
 *  `forceClick` exists for archived cards only: dnd-kit's `useDraggable` is
 *  `disabled: archived` and stamps `aria-disabled="true"` on the card root, so
 *  Playwright's default click waits for "enabled" and times out even though
 *  the card's own `onClick` (open details) is live. `force` skips just that
 *  actionability wait — the same reason `e2e/font-size.spec.ts` forces its
 *  aria-disabled stepper clicks. */
async function openTask(
  page: Page,
  title: string,
  opts: { forceClick?: boolean } = {},
): Promise<Locator> {
  const card = page.getByText(title, { exact: true }).first();
  await (opts.forceClick ? card.click({ force: true }) : card.click());
  const panel = runPanel(page);
  await expect(panel).toHaveClass(/translate-x-0/);
  return panel;
}

/** Scopes a locator to the board `TaskCard` for the given exact title —
 *  `TaskCard.tsx`'s root `<Card>` carries `cursor-grab`. Mirrors
 *  `e2e/task-switch-during-restore.spec.ts`'s helper of the same name. */
function taskCard(page: Page, title: string): Locator {
  return page.locator(".cursor-grab").filter({ has: page.getByText(title, { exact: true }) });
}

/** Switch to another task's details while the current panel stays mounted
 *  (so `RunPanelBody` is NOT remounted — the keyed `BacklogTray` remounts
 *  instead, which is exactly what the session-only assertion exercises).
 *  `RunPanel`'s full-window backdrop intercepts pointer events aimed at board
 *  cards, so this goes through the task context menu's "Open details" action,
 *  dispatched onto the card the same way `TaskCard` handles a keyboard
 *  context-menu event. Mirrors `e2e/task-switch-during-restore.spec.ts`. */
async function openTaskWhilePanelOpen(page: Page, title: string): Promise<void> {
  await taskCard(page, title).dispatchEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 0,
    clientY: 0,
  });
  const openItem = page.locator('[data-testid="task-context-menu-open"]');
  await expect(openItem).toBeVisible();
  await openItem.click();
}

test.describe("messages backlog collapse", () => {
  test("collapses to its header, unmounts the list, and hands the height back to the transcript", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    const title = `backlog-collapse-${randomUUID()}`;
    const taskId = await createTask(request, backend, title);
    const firstDraft = "draft alpha";
    const drafts = [
      firstDraft,
      "draft bravo",
      "draft charlie",
      "draft delta",
      "draft echo",
      "draft foxtrot",
      "draft golf",
      "draft hotel",
    ];
    for (const text of drafts) await seedDraft(request, backend, taskId, text);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    const tray = panel.getByTestId("backlog-tray");
    const toggle = tray.getByTestId("backlog-toggle");
    const list = tray.getByTestId("backlog-list");
    const count = tray.getByText("8", { exact: true });

    // Default expanded, with an accessible disclosure relationship.
    await expect(tray).toBeVisible();
    await expect(tray).toHaveAttribute("data-state", "expanded");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(list).toBeVisible();
    await expect(list).toHaveAttribute("id", (await toggle.getAttribute("aria-controls")) ?? "missing-aria-controls");
    await expect(list).toContainText(firstDraft);
    await expect(count).toBeVisible();
    const chevron = toggle.locator("svg").first();
    await expect(chevron).toHaveClass(/rotate-90/);

    const transcript = panel.getByTestId("transcript-log");
    const transcriptBefore = await transcript.boundingBox();
    const trayBefore = await tray.boundingBox();
    expect(transcriptBefore, "transcript box before collapse").not.toBeNull();
    expect(trayBefore, "tray box before collapse").not.toBeNull();

    await toggle.click();

    // Collapsed: the list is unmounted (not just hidden), the count survives.
    await expect(tray).toHaveAttribute("data-state", "collapsed");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(list).toHaveCount(0);
    await expect(count).toBeVisible();
    await expect(toggle).toContainText("saved messages — expand to review");
    await expect(chevron).not.toHaveClass(/rotate-90/);

    // The freed height goes to the transcript: with eight capped rows the
    // tray shrinks by its whole 160 px list window (~168 px with padding).
    const transcriptAfter = await transcript.boundingBox();
    const trayAfter = await tray.boundingBox();
    expect(transcriptAfter, "transcript box after collapse").not.toBeNull();
    expect(trayAfter, "tray box after collapse").not.toBeNull();
    expect(
      trayBefore!.height - trayAfter!.height,
      "collapsing the list shrinks the tray by its 160 px list window",
    ).toBeGreaterThan(100);
    expect(
      transcriptAfter!.height - transcriptBefore!.height,
      "the transcript reclaims the tray's freed height",
    ).toBeGreaterThan(100);

    // Expanding restores the drafts at the unchanged resting height cap.
    await toggle.click();
    await expect(tray).toHaveAttribute("data-state", "expanded");
    await expect(list).toBeVisible();
    await expect(list).toContainText(firstDraft);
    await expect(list).toHaveClass(/max-h-40/);
  });

  test("blocks collapse while a row is inline-editing and never discards the unsaved text", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    const title = `backlog-edit-block-${randomUUID()}`;
    const taskId = await createTask(request, backend, title);
    await seedDraft(request, backend, taskId, "first saved draft");
    await seedDraft(request, backend, taskId, "second saved draft");

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    const tray = panel.getByTestId("backlog-tray");
    const toggle = tray.getByTestId("backlog-toggle");
    const list = tray.getByTestId("backlog-list");
    await expect(tray).toHaveAttribute("data-state", "expanded");

    await tray.getByRole("button", { name: "Edit", exact: true }).first().click();
    const editor = panel.locator('textarea:not([data-testid="send-textarea"])');
    await expect(editor).toBeVisible();
    await editor.fill("edited but unsaved");

    // The tray explains why it can't collapse, and the list grows for the
    // editor's own height (unchanged 288 px cap).
    await expect(toggle).toHaveAttribute("aria-disabled", "true");
    await expect(toggle).toContainText("save or cancel your edit first");
    await expect(list).toHaveClass(/max-h-72/);

    // A real pointer click still lands (that's the point of `aria-disabled`
    // over native `disabled` — the control stays focusable and hoverable), but
    // Playwright's default actionability treats `aria-disabled="true"` as
    // "not enabled" and would wait forever. `force` skips only that wait; the
    // guarded `onClick` is what must keep the list mounted.
    await toggle.click({ force: true });
    await expect(tray).toHaveAttribute("data-state", "expanded");
    await expect(list).toBeVisible();
    await expect(editor).toHaveValue("edited but unsaved");

    // Cancelling clears the block, and the toggle works again.
    await tray.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(toggle).not.toHaveAttribute("aria-disabled", "true");
    await toggle.click();
    await expect(tray).toHaveAttribute("data-state", "collapsed");
    await expect(list).toHaveCount(0);
  });

  test("collapse is session-only: it resets on task switch and after the tray empties", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(90_000);
    const suffix = randomUUID();
    const titleA = `backlog-session-a-${suffix}`;
    const titleB = `backlog-session-b-${suffix}`;
    const taskA = await createTask(request, backend, titleA);
    const taskB = await createTask(request, backend, titleB);
    const draftA = `A's only draft ${suffix}`;
    const draftB = `B's only draft ${suffix}`;
    const draftAId = await seedDraft(request, backend, taskA, draftA);
    await seedDraft(request, backend, taskB, draftB);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, titleA);
    const tray = panel.getByTestId("backlog-tray");
    const toggle = tray.getByTestId("backlog-toggle");
    await expect(tray).toContainText(draftA);
    await expect(toggle).toBeVisible();
    await expect(tray).toHaveAttribute("data-state", "expanded");
    await toggle.click();
    await expect(tray).toHaveAttribute("data-state", "collapsed");

    // Switch to B without remounting RunPanelBody: B's keyed tray mounts
    // fresh, so it is expanded even though A's was collapsed.
    await openTaskWhilePanelOpen(page, titleB);
    await expect(tray).toContainText(draftB);
    await expect(tray).toHaveAttribute("data-state", "expanded");

    // Back to A: the keyed remount dropped the collapse, so A is expanded too.
    await openTaskWhilePanelOpen(page, titleA);
    await expect(tray).toContainText(draftA);
    await expect(tray).toHaveAttribute("data-state", "expanded");

    // Collapse, then empty the tray: the whole tray unmounts, and the next
    // saved draft mounts a brand-new (expanded) tray.
    await toggle.click();
    await expect(tray).toHaveAttribute("data-state", "collapsed");
    const deleted = await request.delete(`${backend.apiBase}/tasks/${taskA}/backlog/${draftAId}`, {
      headers: authHeaders(backend),
    });
    expect(deleted.ok(), `DELETE backlog item -> ${deleted.status()}: ${await deleted.text()}`).toBeTruthy();
    await expect(tray).toHaveCount(0, { timeout: 15_000 });

    await seedDraft(request, backend, taskA, "fresh draft after empty");
    await expect(tray).toBeVisible({ timeout: 15_000 });
    await expect(tray).toContainText("fresh draft after empty");
    await expect(tray).toHaveAttribute("data-state", "expanded");
    await expect(toggle).toBeVisible();
  });

  test("an archived task keeps the toggle, the read-only hint, and no row actions", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    const title = `backlog-archived-${randomUUID()}`;
    const taskId = await createTask(request, backend, title);
    const draft = "draft saved before archiving";
    await seedDraft(request, backend, taskId, draft);

    // Only a Done task can be archived; an unstarted task has no live run, so
    // the plain PATCH + archive path is enough (no fake agent needed).
    const done = await request.patch(`${backend.apiBase}/tasks/${taskId}`, {
      headers: authHeaders(backend),
      data: { column: "done" },
    });
    expect(done.ok(), `PATCH column=done -> ${done.status()}: ${await done.text()}`).toBeTruthy();
    const archived = await request.post(`${backend.apiBase}/tasks/${taskId}/archive`, {
      headers: authHeaders(backend),
    });
    expect(archived.ok(), `POST archive -> ${archived.status()}: ${await archived.text()}`).toBeTruthy();

    await gotoApp(page, backend.bootBase);
    await page.getByTitle("Filter by archive state").selectOption("archived");
    const panel = await openTask(page, title, { forceClick: true });
    const tray = panel.getByTestId("backlog-tray");
    const toggle = tray.getByTestId("backlog-toggle");
    const list = tray.getByTestId("backlog-list");

    await expect(tray).toBeVisible();
    await expect(tray).toHaveAttribute("data-state", "expanded");
    await expect(tray).toContainText("saved messages — unarchive the task to edit or send");
    await expect(list).toContainText(draft);
    // Read-only: the toggle is the ONLY affordance the tray adds.
    await expect(tray.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await expect(tray.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
    await expect(tray.getByRole("button", { name: "Send now", exact: true })).toHaveCount(0);
    await expect(toggle).toBeVisible();

    await toggle.click();
    await expect(tray).toHaveAttribute("data-state", "collapsed");
    await expect(list).toHaveCount(0);
    await expect(toggle).toContainText("saved messages — expand to review");

    await toggle.click();
    await expect(tray).toHaveAttribute("data-state", "expanded");
    await expect(tray).toContainText("saved messages — unarchive the task to edit or send");
    await expect(list).toContainText(draft);
  });
});
