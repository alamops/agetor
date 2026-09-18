import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";
import { AGETOR_PASTE_LEAD_IN } from "../src/shared/user-message.ts";

/**
 * E2E coverage for docs/plans/pasted-content-tags.md: Claude Code (2.1.277+,
 * server-side rollout) wraps a bracketed paste in
 * `<pasted_content id="hhhh">…</pasted_content id="hhhh">`, and agetor types
 * its own lead-in line ahead of that paste — so the JSONL twin of every
 * agetor send carries both. The run panel's "you" bubble must show only what
 * the user actually wrote.
 *
 * Same harness as e2e/tagged-user-messages.spec.ts: under the fake claude
 * driver `startTask` echoes the task's own prompt as a `user` stream event,
 * so seeding the PROMPT with the twin shape drives `UserMessageBlock` for
 * real. Fixture shapes are the ones captured from a live 2.1.277 session.
 */

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
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

  const startRes = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, {
    headers: auth,
  });
  expect(
    startRes.ok(),
    `POST /tasks/${task.id}/start -> ${startRes.status()}: ${await startRes.text()}`,
  ).toBeTruthy();

  return task;
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

/** UserMessageBlock's own root (`rounded-2xl rounded-br-md`, RunPanel.tsx),
 *  picked by class rather than by walking up from a text match: the raw
 *  prompt also lives in the collapsed Task-details editor and in the fake
 *  driver's "fake response to: …" reply, and neither sits inside a bubble. */
function bubbleOf(panel: ReturnType<typeof runPanel>, text: string) {
  return panel.locator("div.rounded-2xl.rounded-br-md").filter({ hasText: text }).first();
}

test.describe("pasted_content wrapper", () => {
  test("a wrapped-only send renders just its body", async ({ page, request, backend }) => {
    const marker = randomUUID();
    const title = `pasted-wrapped ${marker}`;
    const body = `first line ${marker}\n\nA truly living world`;
    const prompt = `\n\n<pasted_content id="1b6a">\n${body}\n</pasted_content id="1b6a">\n`;

    await createAndStartTask(request, backend, title, prompt);
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    const bubble = bubbleOf(panel, `first line ${marker}`);
    await expect(bubble).toBeVisible();
    await expect(bubble).toContainText("A truly living world");
    const bubbleText = await bubble.innerText();
    expect(bubbleText).not.toContain("pasted_content");
    expect(bubbleText).not.toContain("1b6a");
    await expect(bubble.getByText("you", { exact: true })).toHaveCount(1);
  });

  test("agetor's lead-in line and the wrapper are both hidden", async ({ page, request, backend }) => {
    const marker = randomUUID();
    const title = `pasted-lead-in ${marker}`;
    const prompt =
      `${AGETOR_PASTE_LEAD_IN}\n\n\n<pasted_content id="0a7d">\n` +
      `Create a file named smoke.txt ${marker}\nThen reply with only: DONE\n</pasted_content id="0a7d">\n`;

    await createAndStartTask(request, backend, title, prompt);
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    const bubble = bubbleOf(panel, `Create a file named smoke.txt ${marker}`);
    await expect(bubble).toBeVisible();
    await expect(bubble).toContainText("Then reply with only: DONE");
    const bubbleText = await bubble.innerText();
    expect(bubbleText).not.toContain("pasted_content");
    expect(bubbleText).not.toContain(AGETOR_PASTE_LEAD_IN);
  });

  test("a lead-in send claude did not wrap (short message / flag off) hides the lead-in", async ({
    page,
    request,
    backend,
  }) => {
    const marker = randomUUID();
    const title = `pasted-lead-in-unwrapped ${marker}`;
    const prompt = `${AGETOR_PASTE_LEAD_IN}\nsay only: PONG ${marker}`;

    await createAndStartTask(request, backend, title, prompt);
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    const bubble = bubbleOf(panel, `say only: PONG ${marker}`);
    await expect(bubble).toBeVisible();
    expect(await bubble.innerText()).not.toContain(AGETOR_PASTE_LEAD_IN);
  });

  test("a user's own prompt tag inside a wrapped send still renders as a labeled block", async ({
    page,
    request,
    backend,
  }) => {
    const marker = randomUUID();
    const title = `pasted-with-context ${marker}`;
    const prompt =
      `${AGETOR_PASTE_LEAD_IN}\n\n\n<pasted_content id="b826">\n` +
      `<context>\nWe are migrating billing ${marker}.\n</context>\n\nPlease summarize the risks.\n` +
      `</pasted_content id="b826">\n`;

    await createAndStartTask(request, backend, title, prompt);
    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    const bubble = bubbleOf(panel, "Please summarize the risks.");
    await expect(bubble).toBeVisible();
    await expect(bubble).toContainText(`We are migrating billing ${marker}.`);
    const bubbleText = await bubble.innerText();
    expect(bubbleText).not.toContain("pasted_content");
    expect(bubbleText).not.toContain("<context>");
    expect(bubbleText).not.toContain(AGETOR_PASTE_LEAD_IN);
  });
});
