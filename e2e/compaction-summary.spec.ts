import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for docs/plans/claude-code-placeholder.md (T6/TT7): Claude
 * Code's context compaction writes a `compact_boundary` system line, a
 * `user` line carrying `isCompactSummary: true` (Claude's own ~16 KB
 * summary) and an `informational` "Compacted while idle, …" notice. agetor
 * maps them at ingest to a status line, a `compaction_summary` event and a
 * second status line. The summary must render as a collapsed "Compaction
 * summary" block — never a YOU bubble, never offered for resend.
 *
 * Under the fake claude driver a prompt carrying the marker below emits that
 * exact chunk sequence (synthetic summary text), then a short reply.
 */

/** Mirrors `FAKE_CLAUDE_COMPACTION_PROMPT_MARKER` in `src/bun/agents.ts`
 *  (kept as a literal so this spec doesn't import bun-side code). */
const FAKE_CLAUDE_COMPACTION_PROMPT_MARKER = "__agetor_fake_claude_compaction__";
const SUMMARY_FIRST_LINE = "This session is being continued from a previous conversation that ran out of context.";

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
  column: string;
}

async function createAndStartTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
  prompt: string,
): Promise<TaskRow> {
  const auth = { authorization: `Bearer ${backend.apiToken}` };
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

async function taskColumn(request: APIRequestContext, backend: E2EBackend, id: string): Promise<string> {
  const res = await request.get(`${backend.apiBase}/tasks/${id}`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
  });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as TaskRow).column;
}

/** The run panel's slide-over `<aside>` — `.last()` because NewTaskForm's own
 *  always-present `<aside>` sidebar mounts first. */
function runPanel(page: Page) {
  return page.locator("aside").last();
}

async function openTask(page: Page, title: string) {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

test.describe("compaction summary", () => {
  test("renders status lines + a collapsed summary block, never a YOU bubble or a resend entry", async ({
    page,
    request,
    backend,
  }) => {
    const marker = randomUUID();
    const title = `compaction ${marker}`;
    const task = await createAndStartTask(
      request,
      backend,
      title,
      `compaction scenario ${marker} ${FAKE_CLAUDE_COMPACTION_PROMPT_MARKER}`,
    );

    // The fake turn settles on its own — the summary never opens or holds a
    // turn, and the task lands in review like any finished run.
    await expect.poll(() => taskColumn(request, backend, task.id), { timeout: 15_000 }).toBe("review");

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    await expect(panel.getByText("context compacted · 450k → 8.6k tokens")).toBeVisible();
    await expect(panel.getByText("Compacted while idle, before the prompt cache expired")).toBeVisible();

    const block = panel.getByTestId("compaction-summary-block");
    await expect(block).toHaveCount(1);
    await expect(block).toHaveAttribute("data-state", "collapsed");
    await expect(block).toContainText("Compaction summary");
    await expect(panel.getByTestId("compaction-summary-body")).toHaveCount(0);

    // File order: boundary status → summary block → notice status.
    const order = await panel.evaluate((root, needles) => {
      // textContent, not innerText: headers use CSS `uppercase`, which
      // innerText applies.
      const text = (root as HTMLElement).textContent ?? "";
      return needles.map((n) => text.indexOf(n));
    }, ["context compacted · 450k", "Compaction summary", "Compacted while idle"]);
    const [boundaryAt, summaryAt, noticeAt] = order as [number, number, number];
    expect(Math.min(boundaryAt, summaryAt, noticeAt)).toBeGreaterThanOrEqual(0);
    expect(boundaryAt).toBeLessThan(summaryAt);
    expect(summaryAt).toBeLessThan(noticeAt);

    await panel.getByTestId("compaction-summary-toggle").click();
    await expect(block).toHaveAttribute("data-state", "expanded");
    const body = panel.getByTestId("compaction-summary-body");
    await expect(body).toBeVisible();
    await expect(body).toContainText(SUMMARY_FIRST_LINE);

    // Never rendered as a YOU bubble (UserMessageBlock's root).
    await expect(
      panel.locator("div.rounded-2xl.rounded-br-md").filter({ hasText: SUMMARY_FIRST_LINE }),
    ).toHaveCount(0);

    // Never offered for resend: the picker lists the task's own prompt only.
    await panel.getByTestId("message-history-trigger").click();
    const popover = panel.getByTestId("message-history-popover");
    await expect(popover).toBeVisible();
    await expect(
      popover.locator('[data-testid="message-history-item"]').filter({ hasText: `compaction scenario ${marker}` }),
    ).toHaveCount(1);
    await expect(
      popover.locator('[data-testid="message-history-item"]').filter({ hasText: SUMMARY_FIRST_LINE }),
    ).toHaveCount(0);
  });
});
