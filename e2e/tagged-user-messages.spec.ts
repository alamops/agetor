import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for U3 of docs/plans/tagged-user-messages.md: the run panel's
 * "you" bubble renders any balanced top-level `<name>…</name>` tag as a
 * structured block (`src/mainview/components/kanban/MessageSegments.tsx`)
 * instead of literal `<tag>` text — both machine-emitted tags (a forked
 * background-skill launch, a `!`-shell-escape) and a user's own prompt tags.
 *
 * Modeled directly on e2e/markdown-readability.spec.ts's harness: the fake
 * claude driver (`AGETOR_CLAUDE_DRIVER=fake`, set by the `backend` fixture)
 * only ever emits a canned `assistant` reply, but `startTask` unconditionally
 * echoes the task's own prompt back as a `user` stream event regardless of
 * driver (orchestrator.ts, "Echo the initial prompt as a 'user' event so the
 * panel renders it") — so seeding the *prompt* with the tagged text is
 * enough to exercise `UserMessageBlock` -> `MessageSegments` for real,
 * without needing a controllable assistant reply.
 */

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
}

/** Create a task (isolation "none", a plain non-git temp dir as workdir — the
 *  fake driver never touches the filesystem) with a distinct title/prompt and
 *  start it, so orchestrator.ts's prompt-echo puts `prompt` on the `user`
 *  stream as a real message the run panel renders. Fails loudly via `expect`
 *  rather than leaving a silent 400 for a later step to trip on. */
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

  const startRes = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, {
    headers: auth,
  });
  expect(
    startRes.ok(),
    `POST /tasks/${task.id}/start -> ${startRes.status()}: ${await startRes.text()}`,
  ).toBeTruthy();

  return task;
}

/** The run panel's slide-over `<aside>` — see markdown-readability.spec.ts's
 *  identical helper for why `.last()` is the right pick (RunPanel mounts
 *  after NewTaskForm's own always-present `<aside>` sidebar). */
function runPanel(page: Page) {
  return page.locator("aside").last();
}

/** Click a task card by its exact title and wait for the composer textarea
 *  to mount as proof the run panel is open. */
async function openTask(page: Page, title: string) {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

test.describe("tagged user messages", () => {
  test("forked background-skill launch renders as command output + skill card, no raw tags, no 'you' header", async ({
    page,
    request,
    backend,
  }) => {
    const marker = randomUUID();
    const title = `tagged-forked-skill ${marker}`;
    const prompt =
      "<local-command-stdout>Running in the background as @code-review</local-command-stdout>\n" +
      '<forked-skill-launch>{"agentId":"a7db6829e09d1ba9b","skillName":"code-review","description":"/code-review"}</forked-skill-launch>';

    await createAndStartTask(request, backend, title, prompt);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    const outputBlock = panel.locator('[data-testid="command-output-block"]');
    await expect(outputBlock).toBeVisible();
    await expect(outputBlock).toContainText("Running in the background as @code-review");

    const skillCard = panel.locator('[data-testid="forked-skill-card"]');
    await expect(skillCard).toBeVisible();
    await expect(skillCard).toContainText("Skill launched in background");
    await expect(skillCard).toContainText("/code-review");
    await expect(skillCard).toContainText("agent a7db6829");

    // The bubble is the nearest ancestor `rounded-2xl` div (UserMessageBlock's
    // own root, RunPanel.tsx).
    const bubble = skillCard.locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");
    const bubbleText = await bubble.innerText();
    expect(bubbleText).not.toContain("<forked-skill-launch");
    expect(bubbleText).not.toContain("<local-command-stdout");

    // A purely machine-emitted message shows no "you" header at all — every
    // block it renders already carries its own label (hasAuthoredContent in
    // MessageSegments.tsx).
    await expect(bubble.getByText("you", { exact: true })).toHaveCount(0);
  });

  test("user-typed <context> tag renders as a labeled block alongside markdown prose, with a 'you' header", async ({
    page,
    request,
    backend,
  }) => {
    const marker = randomUUID();
    const title = `tagged-user-context ${marker}`;
    const prompt = "<context>\nWe are migrating the billing module.\n</context>\n\nPlease summarize the risks.";

    await createAndStartTask(request, backend, title, prompt);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    const tagBlock = panel.locator('[data-testid="user-tag-block"][data-tag="context"]');
    await expect(tagBlock).toBeVisible();
    await expect(tagBlock).toContainText("We are migrating the billing module.");

    const bubble = tagBlock.locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");
    await expect(bubble.locator(".agetor-md p", { hasText: "Please summarize the risks." })).toBeVisible();

    // Authored content (the trailing prose) is present, so the "you" header
    // shows, unlike the purely-machine-emitted case above.
    await expect(bubble.getByText("you", { exact: true }).first()).toBeVisible();

    const bubbleText = await bubble.innerText();
    expect(bubbleText).not.toContain("<context>");
  });

  test("shell escape renders as a shell-input block with a 'shell' label", async ({ page, request, backend }) => {
    const marker = randomUUID();
    const title = `tagged-shell-escape ${marker}`;
    const prompt = "<bash-input>supabase db push --linked</bash-input>";

    await createAndStartTask(request, backend, title, prompt);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    const shellBlock = panel.locator('[data-testid="shell-input-block"]');
    await expect(shellBlock).toBeVisible();
    await expect(shellBlock).toContainText("$ supabase db push --linked");
    await expect(shellBlock).toContainText("shell");
  });
});
