import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for the task context menu (docs/plans/task-context-menu.md
 * §5 TT3) — right-click on a kanban card opening our own portaled HTML menu
 * (`src/mainview/components/ui/context-menu.tsx`, wired in `App.tsx`'s
 * `taskMenu` state + `buildTaskContextMenu`,
 * `src/mainview/lib/task-context-menu.ts`) — and the native-context-menu
 * suppression policy (`keepsNativeContextMenu` /
 * `NATIVE_CONTEXT_MENU_SELECTOR` in `src/mainview/lib/context-menu.ts`, D2
 * (b) in the plan). Drives Chromium against the real webview + real Bun
 * API/orchestrator (a per-worker instance from `e2e/fixtures.ts`'s `backend`
 * fixture), same idiom as `e2e/unread-indicator.spec.ts` and
 * `e2e/todo-progress.spec.ts`.
 *
 * `test.describe.configure({ mode: "serial" })`: every test in this file
 * shares the one worker backend/DB, and case (e) deliberately reuses the
 * plain backlog task created in case (a) (see `backlogTaskTitle` below) to
 * cover "a task with no assistant messages shows neither read entry" without
 * creating a third throwaway task — that only works if (a) always runs
 * before (e), which serial mode + declaration order guarantees.
 */
const FAKE_CLAUDE_TODOS_PROMPT_MARKER = "__agetor_fake_claude_todos__";

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
  branch: string | null;
}

/** Create a task via the API (mirrors `e2e/unread-indicator.spec.ts`'s
 *  `createAndStartFakeTodoTask`, minus the auto-start). Defaults to
 *  `isolation: "none"` — only case (f) needs a real worktree/branch. */
async function createTask(
  request: APIRequestContext,
  backend: E2EBackend,
  data: { title: string; prompt: string; workdir: string; isolation?: "none" | "worktree" },
): Promise<TaskRow> {
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: { ...data, isolation: data.isolation ?? "none" },
  });
  expect(res.ok(), `POST /tasks -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as TaskRow;
}

async function startTask(request: APIRequestContext, backend: E2EBackend, taskId: string): Promise<void> {
  const res = await request.post(`${backend.apiBase}/tasks/${taskId}/start`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
  });
  expect(res.ok(), `POST /tasks/${taskId}/start -> ${res.status()}: ${await res.text()}`).toBeTruthy();
}

async function deleteTask(request: APIRequestContext, backend: E2EBackend, taskId: string): Promise<void> {
  await request
    .delete(`${backend.apiBase}/tasks/${taskId}`, { headers: { authorization: `Bearer ${backend.apiToken}` } })
    .catch(() => { /* best-effort cleanup */ });
}

/** Create a task whose prompt embeds the fake driver's todos-scenario marker
 *  and start it — the only canned scenario that emits a genuine top-level
 *  `assistant` chunk, which is what bumps the unread watermark. Identical to
 *  `e2e/unread-indicator.spec.ts`'s helper of the same name. */
async function createAndStartFakeTodoTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<TaskRow> {
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const prompt = `${FAKE_CLAUDE_TODOS_PROMPT_MARKER} ${title}`;
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: { title, prompt, isolation: "none", workdir: tmpdir() },
  });
  expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
  const task = (await createRes.json()) as TaskRow;

  const startRes = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, { headers: auth });
  expect(
    startRes.ok(),
    `POST /tasks/${task.id}/start -> ${startRes.status()}: ${await startRes.text()}`,
  ).toBeTruthy();

  return task;
}

/** Polls `GET /tasks/:id` until `unread` matches `expected` — same idiom as
 *  `e2e/unread-indicator.spec.ts`'s helper of the same name. */
async function waitForUnread(
  request: APIRequestContext,
  backend: E2EBackend,
  taskId: string,
  expected: boolean,
): Promise<void> {
  await expect(async () => {
    const res = await request.get(`${backend.apiBase}/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${backend.apiToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const task = (await res.json()) as { unread: boolean };
    expect(task.unread).toBe(expected);
  }).toPass({ timeout: 10_000 });
}

/** Polls `GET /tasks/:id` until `branch` is materialized — `startTask`
 *  creates the worktree/branch synchronously before the fake driver "runs",
 *  so this should resolve immediately, but polling avoids any race against
 *  the HTTP response landing before the DB write is visible to a fresh
 *  request. */
async function waitForBranch(request: APIRequestContext, backend: E2EBackend, taskId: string): Promise<string> {
  let branch: string | null = null;
  await expect(async () => {
    const res = await request.get(`${backend.apiBase}/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${backend.apiToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const task = (await res.json()) as { branch: string | null };
    expect(task.branch).not.toBeNull();
    branch = task.branch;
  }).toPass({ timeout: 15_000 });
  return branch!;
}

/** The run panel's slide-over `<aside>` — see `e2e/quote.spec.ts`'s
 *  identical helper for why `.last()` is the right pick (`NewTaskForm`'s
 *  sidebar is also an `<aside>`, mounted first in `App.tsx`'s JSX). */
function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

/** The New Task sidebar's prompt composer — the one surface case (h) needs
 *  to prove keeps the native context menu (it's editable text). */
function promptTextarea(page: Page): Locator {
  return page.locator("aside").first().locator("textarea").first();
}

/** Scopes a locator to the board `TaskCard` for the given exact title —
 *  `TaskCard.tsx`'s root `<Card>` carries `cursor-grab` (drag handle
 *  styling, unique to board cards), so this can't accidentally match
 *  anything inside the run panel or the menu. Mirrors
 *  `e2e/unread-indicator.spec.ts`'s helper of the same name. */
function taskCard(page: Page, title: string): Locator {
  return page.locator(".cursor-grab").filter({ has: page.getByText(title, { exact: true }) });
}

function unreadDot(page: Page, title: string): Locator {
  return taskCard(page, title).locator('[aria-label="New messages"]');
}

/** The task context menu panel — `App.tsx` renders exactly one
 *  `<ContextMenu testId="task-context-menu" …>` for the whole board, so
 *  this locator is unambiguous regardless of which card opened it. */
function menu(page: Page): Locator {
  return page.locator('[data-testid="task-context-menu"]');
}

function menuItem(page: Page, action: string): Locator {
  return page.locator(`[data-testid="task-context-menu-${action}"]`);
}

/**
 * Bring a card fully into view and let `.kanban-scroll`'s horizontal scroll
 * settle before it gets right-clicked. Needed for any card in a column that
 * starts beyond the fixed 1280px test viewport (Review, Done at 6 columns
 * wide): scrolling it into view AND right-clicking it within one
 * Playwright `.click()` call leaves a couple of `scroll` events trailing
 * the click by tens of ms — the browser's native "keep the newly-focused
 * element in view" adjustment (mousedown focuses the card's `tabindex="0"`
 * root) stacked on top of Playwright's own pre-click auto-scroll — landing
 * right in the window where the context menu that click just opened is
 * already listening for a scroll to close itself (by design, matching
 * `InfoTip`). Doing the scroll — and waiting for it to fully settle —
 * *before* the click means neither auto-scroll has anything left to do at
 * click time, so no trailing scroll event races the freshly opened menu.
 * Confirmed empirically: without this, right-clicking a Review-column card
 * opens the menu and then immediately closes it before any assertion can
 * observe it.
 */
async function scrollCardIntoView(page: Page, title: string): Promise<void> {
  const card = taskCard(page, title);
  await card.evaluate((el) => el.scrollIntoView({ block: "nearest", inline: "center" }));
  await page.evaluate(async () => {
    const el = document.querySelector(".kanban-scroll");
    if (!el) return;
    let last = el.scrollLeft;
    let stable = 0;
    while (stable < 5) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (el.scrollLeft === last) {
        stable++;
      } else {
        stable = 0;
        last = el.scrollLeft;
      }
    }
  });
}

/** Right-clicks a card by its exact title (after settling any horizontal
 *  board scroll — see `scrollCardIntoView`). `.first()` resolves the
 *  `CardTitle` (renders before the card's own prompt-preview paragraph in
 *  DOM order) over any later text match — same idiom as
 *  `e2e/quote.spec.ts`'s `openTask`, just with `button: "right"`. */
async function rightClickCard(page: Page, title: string): Promise<void> {
  await scrollCardIntoView(page, title);
  await page.getByText(title, { exact: true }).first().click({ button: "right" });
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/** One throwaway git repo with a single empty commit — enough for
 *  `isolation: "worktree"` task creation to pin a `baseRef` (needs a
 *  resolvable `HEAD`) and for `POST /tasks/:id/start` to materialize a real
 *  worktree + branch. `--allow-empty` skips writing any tracked file since
 *  case (f) only needs a branch name, not real diff content. Mirrors
 *  `e2e/pr-merged-state.spec.ts`'s `initRepo` (`commit.gpgsign false` avoids
 *  hanging on a machine with commit signing configured). */
async function initGitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agetor-e2e-ctxmenu-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "e2e@example.com"]);
  git(dir, ["config", "user.name", "e2e"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);
  return dir;
}

// Set by case (a), read by case (e) — see the file header comment for why
// this cross-test dependency is intentional under serial mode.
let backlogTaskTitle = "";

test.describe("task context menu", () => {
  test("opens with the expected menu entries for a backlog task, focuses the first item", async ({
    page,
    request,
    backend,
  }) => {
    backlogTaskTitle = `ctxmenu-a ${randomUUID()}`;
    await createTask(request, backend, { title: backlogTaskTitle, prompt: backlogTaskTitle, workdir: tmpdir() });

    await gotoApp(page, backend.bootBase);
    await rightClickCard(page, backlogTaskTitle);

    const panel = menu(page);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("role", "menu");

    // A fresh, never-started, isolation="none" backlog task: only Open,
    // Run, View changes, Open in Finder, and Delete apply — no branch, no
    // PR, no active run, not in review/done, no assistant messages yet.
    for (const action of ["open", "start", "diff", "open-in-finder", "delete"]) {
      await expect(menuItem(page, action)).toBeVisible();
    }
    for (const action of [
      "stop",
      "mark-done",
      "archive",
      "unarchive",
      "view-pr",
      "mark-read",
      "mark-unread",
      "copy-branch",
      "copy-worktree-path",
    ]) {
      await expect(menuItem(page, action)).toHaveCount(0);
    }

    const items = panel.locator('[role="menuitem"]');
    await expect(items).toHaveCount(5);
    await expect(items.last()).toHaveAttribute("data-testid", "task-context-menu-delete");

    await expect(menuItem(page, "open")).toBeFocused();
  });

  test("Escape and an outside click both close the menu", async ({ page, request, backend }) => {
    const title = `ctxmenu-b ${randomUUID()}`;
    await createTask(request, backend, { title, prompt: title, workdir: tmpdir() });

    await gotoApp(page, backend.bootBase);

    await rightClickCard(page, title);
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu(page)).toBeHidden();

    await rightClickCard(page, title);
    await expect(menu(page)).toBeVisible();
    // Top-left corner of `<main>` — behind `KanbanFilters`' `px-4 py-2`
    // container padding, never a card or the menu panel itself.
    await page.locator("main").click({ position: { x: 5, y: 5 } });
    await expect(menu(page)).toBeHidden();
  });

  test("right-clicking a second card moves the menu to it", async ({ page, request, backend }) => {
    const titleA = `ctxmenu-c-a ${randomUUID()}`;
    const titleB = `ctxmenu-c-b ${randomUUID()}`;
    await createTask(request, backend, { title: titleA, prompt: titleA, workdir: tmpdir() });
    await createTask(request, backend, { title: titleB, prompt: titleB, workdir: tmpdir() });

    await gotoApp(page, backend.bootBase);

    await rightClickCard(page, titleA);
    await expect(menu(page)).toBeVisible();

    await rightClickCard(page, titleB);
    // The outside-contextmenu capture listener (ui/context-menu.tsx) closes
    // the menu for A and TaskCard B's own bubble-phase handler reopens it
    // for B within the same batch — there is only ever one menu instance.
    await expect(menu(page)).toBeVisible();
    await expect(menu(page)).toHaveCount(1);

    await menuItem(page, "open").click();
    const panel = runPanel(page);
    await expect(panel.locator("textarea")).toBeVisible();
    await expect(panel.getByText(titleB, { exact: true }).first()).toBeVisible();
  });

  test("Open details opens the run panel for the right-clicked task", async ({ page, request, backend }) => {
    const title = `ctxmenu-d ${randomUUID()}`;
    await createTask(request, backend, { title, prompt: title, workdir: tmpdir() });

    await gotoApp(page, backend.bootBase);
    await rightClickCard(page, title);
    await menuItem(page, "open").click();

    const panel = runPanel(page);
    await expect(panel.locator("textarea")).toBeVisible();
    await expect(panel.getByText(title, { exact: true }).first()).toBeVisible();
  });

  test("Mark as unread / Mark as read toggle the board's unread dot", async ({ page, request, backend }) => {
    const title = `ctxmenu-e ${randomUUID()}`;
    const task = await createAndStartFakeTodoTask(request, backend, title);
    await waitForUnread(request, backend, task.id, true);

    // Mark seen directly (equivalent to opening + closing the run panel,
    // which is what a real user would do) so the task starts this scenario
    // caught up.
    const seenRes = await request.post(`${backend.apiBase}/tasks/${task.id}/seen`, {
      headers: { authorization: `Bearer ${backend.apiToken}` },
    });
    expect(seenRes.ok()).toBeTruthy();
    await waitForUnread(request, backend, task.id, false);

    await gotoApp(page, backend.bootBase);

    // Caught up + has an assistant message -> "Mark as unread" offered,
    // "Mark as read" is not.
    await rightClickCard(page, title);
    await expect(menuItem(page, "mark-unread")).toBeVisible();
    await expect(menuItem(page, "mark-read")).toHaveCount(0);
    await menuItem(page, "mark-unread").click();

    await expect(unreadDot(page, title)).toBeVisible();
    await waitForUnread(request, backend, task.id, true);

    // Unread -> "Mark as read" offered, "Mark as unread" is not.
    await rightClickCard(page, title);
    await expect(menuItem(page, "mark-read")).toBeVisible();
    await expect(menuItem(page, "mark-unread")).toHaveCount(0);
    await menuItem(page, "mark-read").click();

    await expect(unreadDot(page, title)).toBeHidden();
    await waitForUnread(request, backend, task.id, false);

    // A task with NO assistant messages at all (the plain backlog task from
    // case (a)) must show neither read entry — `hasAssistantMessages` gates
    // "Mark as unread", and it was never marked unread in the first place.
    expect(backlogTaskTitle, "case (a) must run before case (e)").not.toBe("");
    await rightClickCard(page, backlogTaskTitle);
    await expect(menuItem(page, "mark-read")).toHaveCount(0);
    await expect(menuItem(page, "mark-unread")).toHaveCount(0);
  });

  test("Copy branch name copies the branch and shows a toast", async ({ page, context, request, backend }) => {
    const repoDir = await initGitRepo();
    let taskId: string | null = null;
    try {
      const title = `ctxmenu-f ${randomUUID()}`;
      const task = await createTask(request, backend, {
        title,
        prompt: title,
        workdir: repoDir,
        isolation: "worktree",
      });
      taskId = task.id;
      await startTask(request, backend, task.id);
      const branch = await waitForBranch(request, backend, task.id);

      // Chromium supports granting clipboard permissions on the context;
      // WebKit (agetor's real target) does not have an equivalent
      // Playwright API, which is exactly why the toast is the primary
      // assertion below and the clipboard read is best-effort.
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await gotoApp(page, backend.bootBase);

      await rightClickCard(page, title);
      await menuItem(page, "copy-branch").click();

      await expect(page.getByText("Copied branch name")).toBeVisible();

      try {
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        expect(clip).toBe(branch);
      } catch {
        // Clipboard read unsupported/denied in this context — the toast
        // assertion above already proves the copy path ran.
      }
    } finally {
      if (taskId) await deleteTask(request, backend, taskId);
      await rm(repoDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("Delete… asks for confirmation before removing the task", async ({ page, request, backend }) => {
    const title = `ctxmenu-g ${randomUUID()}`;
    await createTask(request, backend, { title, prompt: title, workdir: tmpdir() });

    await gotoApp(page, backend.bootBase);
    await rightClickCard(page, title);
    await menuItem(page, "delete").click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(`Delete "${title}"?`)).toBeVisible();

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    // Cancelled, not confirmed — the card is still on the board.
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  });

  test("suppresses the native context menu everywhere except editable text, and opens our own menu on a task card", async ({
    page,
    request,
    backend,
  }) => {
    const title = `ctxmenu-h ${randomUUID()}`;
    await createTask(request, backend, { title, prompt: title, workdir: tmpdir() });

    await gotoApp(page, backend.bootBase);

    // Dispatching a real, cancelable `contextmenu` MouseEvent and reading
    // back `defaultPrevented` proves the actual suppression policy ran
    // (AppInner's document-level listener + TaskCard's own preventDefault),
    // not a stand-in for it.
    const bodyPrevented = await page.evaluate(() => {
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(bodyPrevented).toBe(true);

    const textarea = promptTextarea(page);
    await expect(textarea).toBeVisible();
    const textareaPrevented = await textarea.evaluate((el) => {
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(textareaPrevented).toBe(false);

    // Selected read-only text: the native menu is the only mouse path to
    // Copy / Look Up there, so the suppressor lets it through while a
    // non-empty selection exists — and suppresses again once it collapses.
    // A column header is plain, selectable text (cards are `select-none`).
    const heading = page.locator("main h2").first();
    await expect(heading).toBeVisible();
    const withSelection = await heading.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      const selectedText = sel.toString();
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      const prevented = ev.defaultPrevented;
      sel.removeAllRanges();
      const after = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      document.body.dispatchEvent(after);
      return { selectedText, prevented, preventedAfterCollapse: after.defaultPrevented };
    });
    expect(withSelection.selectedText.trim().length).toBeGreaterThan(0);
    expect(withSelection.prevented).toBe(false);
    expect(withSelection.preventedAfterCollapse).toBe(true);

    const card = taskCard(page, title);
    const cardPrevented = await card.evaluate((el) => {
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(cardPrevented).toBe(true);

    // The same dispatched event is also a real right-click as far as React
    // is concerned (it bubbles to the delegated root listener), so it
    // should have opened the menu too.
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu(page)).toBeHidden();
  });
});
