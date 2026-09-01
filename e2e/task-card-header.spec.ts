import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for the kanban `TaskCard` header's 3-row layout
 * (src/mainview/components/kanban/TaskCard.tsx `CardHeader`):
 *
 *   row 1 — `justify-between` flex row: left cluster (task-type icon +
 *           conditional count badges), right (the harness badge).
 *   row 2 — only when `model`/`mode` is set: a right-aligned
 *           `[model, mode].join(" · ")` span.
 *   row 3 — the full-width title (`CardTitle`), no longer indented beside
 *           the icon.
 *
 * Seeds a task directly through the backend API (isolation "none", a plain
 * non-git temp dir as workdir — this spec never starts a run, so nothing
 * ever touches the filesystem or spawns an agent) with a task type, model,
 * and mode set, then asserts both presence (every row's content renders)
 * and geometry (the three rows stack in the right order, row 2 is right-
 * aligned, row 3 is full-width) via `boundingBox()` reads — coarse
 * tolerances only, no pixel-perfect assertions, per quote.spec.ts's own
 * "no pixel/screenshot assertions" convention for this harness (WKWebView,
 * the app's real target, renders differently from Chromium).
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

/** The row-1 harness badge (`<Badge variant="secondary">` in TaskCard.tsx).
 *  Not locatable via `getByText("claude-code", { exact: true })`:
 *  `@lobehub/icons`' `ClaudeCode.Color` glyph renders a hidden SVG
 *  `<title>Claude Code</title>` node, which DOM `textContent` (what
 *  Playwright's text matching reads) concatenates with the badge's own
 *  `claude-code` text node — the badge's real `textContent` is
 *  `"Claude Codeclaude-code"`, not `"claude-code"`, so an exact match never
 *  hits. `rounded-full` (Badge's pill shape) + `bg-secondary` (this badge's
 *  variant) is unique within the card — every button in `TaskCard.tsx` uses
 *  `rounded-md`, never `rounded-full` — and unambiguously selects the whole
 *  pill (icon + text), which is also what geometry assertions want. */
function harnessBadge(card: Locator) {
  return card.locator(".rounded-full.bg-secondary");
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

test.describe("task card header layout", () => {
  test("renders the type icon, harness badge, model·mode line, and title inside the card", async ({
    page,
    request,
    backend,
  }) => {
    const title = `header-e2e ${randomUUID()} verify the header layout renders`;
    await createHeaderTask(request, backend, title);

    await gotoApp(page, backend.bootBase);
    const card = taskCard(page, title);
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Row 1, left cluster: task-type icon. "bug" -> TASK_TYPES' "Bug" label
    // (src/shared/types.ts), applied verbatim as the icon's aria-label.
    await expect(card.locator('[aria-label="Bug"]')).toBeVisible();

    // Row 1, right: the harness badge renders `task.agent` verbatim (in
    // amongst the brand glyph's own hidden SVG <title> text — see
    // `harnessBadge`'s doc comment — hence `toContainText`, not an exact
    // match).
    await expect(harnessBadge(card)).toContainText("claude-code");

    // Row 2: `[model, mode].join(" · ")`.
    await expect(card.getByText("opus · auto", { exact: true })).toBeVisible();

    // Row 3: the full title.
    await expect(card.getByText(title, { exact: true })).toBeVisible();
  });

  test("lays the header out as three stacked rows: icon+badge, right-aligned model·mode, full-width title", async ({
    page,
    request,
    backend,
  }) => {
    const title = `header-e2e ${randomUUID()} confirm the three row geometry`;
    await createHeaderTask(request, backend, title);

    await gotoApp(page, backend.bootBase);
    const card = taskCard(page, title);
    await expect(card).toBeVisible({ timeout: 10_000 });

    const icon = card.locator('[aria-label="Bug"]');
    const badge = harnessBadge(card);
    const modelMode = card.getByText("opus · auto", { exact: true });
    const cardTitle = card.getByText(title, { exact: true });
    await expect(icon).toBeVisible();
    await expect(badge).toBeVisible();
    await expect(modelMode).toBeVisible();
    await expect(cardTitle).toBeVisible();

    const [iconBox, badgeBox, modelModeBox, titleBox] = await Promise.all([
      box(icon),
      box(badge),
      box(modelMode),
      box(cardTitle),
    ]);

    // --- Row 1: type icon and harness badge share a visual row -----------
    // Vertical overlap (both sit on the same `items-center` flex row) and
    // the icon comes first (left cluster) with the badge to its right.
    const iconMidY = iconBox.y + iconBox.height / 2;
    const badgeMidY = badgeBox.y + badgeBox.height / 2;
    expect(Math.abs(iconMidY - badgeMidY), "icon and harness badge should sit on the same row").toBeLessThan(8);
    expect(iconBox.x, "type icon should sit left of the harness badge").toBeLessThan(badgeBox.x);

    // --- Strict top-y row ordering: row 1 < row 2 < row 3 -----------------
    expect(modelModeBox.y, "model·mode row should sit below the icon/badge row").toBeGreaterThan(iconBox.y);
    expect(
      modelModeBox.y + modelModeBox.height,
      "model·mode row should sit entirely above the title row",
    ).toBeLessThan(titleBox.y);

    // --- Row 2 is right-aligned -------------------------------------------
    // Its right edge tracks the harness badge's right edge (both anchored
    // to the header's right content edge)...
    const modelModeRight = modelModeBox.x + modelModeBox.width;
    const badgeRight = badgeBox.x + badgeBox.width;
    expect(
      Math.abs(modelModeRight - badgeRight),
      "model·mode row's right edge should line up with the harness badge's right edge",
    ).toBeLessThan(8);
    // ...and it sits well clear of the header's left content edge (proving
    // it's right-aligned, not left-aligned like the title below it).
    expect(
      modelModeRight - iconBox.x,
      "model·mode row should be offset well clear of the left content edge",
    ).toBeGreaterThan(40);

    // --- Row 3 (title) is full-width: its left edge matches row 1's ------
    expect(
      Math.abs(titleBox.x - iconBox.x),
      "title should start at the same left edge as the type icon (no longer indented beside it)",
    ).toBeLessThan(4);
  });
});
