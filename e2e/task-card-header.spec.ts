import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for the kanban `TaskCard` body order (layout C1,
 * docs/architecture/task-card.md; src/mainview/components/kanban/TaskCard.tsx):
 *
 *   title    — full width, with the task-type icon inline before the text
 *   identity — ONE text line: agent · model · mode (truncates, never wraps
 *              into a second row, never sits beside a fixed-width slot)
 *   status   — the count stats and chips (absent for a task with none)
 *   preview  — the first prose paragraph of the prompt
 *   repo · branch, then the actions
 *
 * Seeds a task directly through the backend API (isolation "none", a plain
 * non-git temp dir as workdir — this spec never starts a run, so nothing
 * ever touches the filesystem or spawns an agent) with a task type, model,
 * and mode set, then asserts both presence (every part renders) and
 * geometry (the parts stack in that order, all left-aligned to the card's
 * content edge) via `boundingBox()` reads — coarse tolerances only, no
 * pixel-perfect assertions, per quote.spec.ts's own "no pixel/screenshot
 * assertions" convention for this harness (WKWebView, the app's real target,
 * renders differently from Chromium). Every-state overflow checking is
 * e2e/task-card-bounds.spec.ts's job.
 */

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
}

/** Create (but never start) a task with a task type + model + mode set, so
 *  the board card renders every header row this spec asserts on. isolation
 *  "none" + a plain temp dir keeps this a pure API/DB round-trip — no git,
 *  no worktree, no agent process. */
async function createHeaderTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<TaskRow> {
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: {
      title,
      prompt: "investigate and fix the reported defect",
      isolation: "none",
      workdir: tmpdir(),
      agent: "claude-code",
      taskType: "bug",
      model: "opus",
      mode: "auto",
    },
  });
  expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
  return (await createRes.json()) as TaskRow;
}

/** Scopes a locator to the board `TaskCard` for the given exact title —
 *  mirrors `e2e/unread-indicator.spec.ts`'s `taskCard` helper: the root
 *  `<Card>` carries `cursor-grab` (drag-handle styling unique to board
 *  cards; the run panel's `<aside>` never has it), so this can't
 *  accidentally match anything else in the DOM. */
function taskCard(page: Page, title: string) {
  return page.locator(".cursor-grab").filter({ has: page.getByText(title, { exact: true }) });
}

/** Bounding boxes are asserted repeatedly below; a thin wrapper keeps every
 *  call site honest about non-null (Playwright returns null only for a
 *  detached/invisible element, which every locator here has already been
 *  proven visible before this is called). */
async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, "expected a visible element with a bounding box").not.toBeNull();
  return b!;
}

test.describe("task card body layout (C1)", () => {
  test("renders the type icon, identity line, preview and title inside the card", async ({
    page,
    request,
    backend,
  }) => {
    const title = `header-e2e ${randomUUID()} verify the card layout renders`;
    await createHeaderTask(request, backend, title);

    await gotoApp(page, backend.bootBase);
    const card = taskCard(page, title);
    await expect(card).toBeVisible({ timeout: 10_000 });

    // The type icon sits inline in the title. "bug" -> TASK_TYPES' "Bug"
    // label (src/shared/types.ts), applied verbatim as the icon's aria-label.
    await expect(card.locator('[aria-label="Bug"]')).toBeVisible();
    await expect(card.getByText(title, { exact: true })).toBeVisible();

    // Identity: the harness id, then `[model, mode].join(" · ")` — one line.
    const identity = card.locator('[data-part="identity"]');
    await expect(identity).toContainText("claude-code");
    await expect(identity).toContainText("Opus · auto");

    await expect(card.locator('[data-part="preview"]')).toHaveText("investigate and fix the reported defect");
  });

  test("stacks title, identity and preview in that order, flush left", async ({ page, request, backend }) => {
    const title = `header-e2e ${randomUUID()} confirm the body order`;
    await createHeaderTask(request, backend, title);

    await gotoApp(page, backend.bootBase);
    const card = taskCard(page, title);
    await expect(card).toBeVisible({ timeout: 10_000 });

    const cardTitle = card.locator('[data-part="title"]');
    const identity = card.locator('[data-part="identity"]');
    const preview = card.locator('[data-part="preview"]');
    const icon = card.locator('[aria-label="Bug"]');
    await expect(cardTitle).toBeVisible();
    await expect(identity).toBeVisible();
    await expect(preview).toBeVisible();

    const [titleBox, identityBox, previewBox, iconBox] = await Promise.all([
      box(cardTitle),
      box(identity),
      box(preview),
      box(icon),
    ]);

    // Strict top-to-bottom order: title < identity < preview.
    expect(titleBox.y + titleBox.height, "the identity line sits below the title").toBeLessThanOrEqual(identityBox.y + 1);
    expect(identityBox.y + identityBox.height, "the preview sits below the identity line").toBeLessThanOrEqual(previewBox.y + 1);

    // The identity is one line (a 12 px line box plus slack), not a wrapped block.
    expect(identityBox.height, "identity is a single text line").toBeLessThan(24);

    // The type icon leads the title, and every part starts at the same left edge.
    expect(Math.abs(iconBox.x - titleBox.x), "the type icon starts the title").toBeLessThan(4);
    expect(Math.abs(identityBox.x - titleBox.x), "identity is flush with the title").toBeLessThan(4);
    expect(Math.abs(previewBox.x - titleBox.x), "preview is flush with the title").toBeLessThan(4);
  });
});
