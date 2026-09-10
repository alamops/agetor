import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for markdown image rendering in agent transcripts
 * (docs/plans/markdown-image-rendering.md §5 TT4): a canned fake-driver
 * scenario runs a real turn through the real orchestrator, and this spec
 * proves the shared `MdImage` `img` override (`src/mainview/components/
 * kanban/MdImage.tsx`) + `classifyMdImageSrc`/`mdUrlTransform`
 * (`src/mainview/lib/md-image.ts`) render local image references as real
 * inline `<img>`s end to end — absolute paths, relative paths resolved
 * against the task's roots, `file://` URLs in a user-typed message, and the
 * fallback chips/dialogs for a missing file and a non-image extension.
 *
 * Structural template: `e2e/sent-files.spec.ts` (worker-scoped headless
 * backend, `isolation: "none"` + a `mkdtemp` workdir, `runPanel(page) =
 * page.locator("aside").last()`, `openTask`,
 * `test.describe.configure({ mode: "serial" })`). The "seed the prompt so
 * the orchestrator's unconditional prompt-echo produces a real `.agetor-md`
 * block" trick for the user-bubble test is `e2e/markdown-readability.spec
 * .ts`'s (see orchestrator.ts's "Echo the initial prompt as a 'user' event"
 * comment — it fires for every driver/scenario, before any agent chunk).
 */

/**
 * Mirrors `FAKE_CLAUDE_MD_IMAGE_PROMPT_MARKER` in `src/bun/agents.ts` (kept
 * as a literal, not an import — see sent-files.spec.ts's identical comment
 * for why `src/bun/*.ts` can't be imported from Playwright's Node process
 * while `src/shared/*.ts` can).
 */
const FAKE_CLAUDE_MD_IMAGE_PROMPT_MARKER = "__agetor_fake_claude_md_image__";

/**
 * Same real 1×1 transparent PNG the fake driver writes under
 * `<workdir>/agetor-md-images/shot.png` (`FAKE_PNG_1X1_BASE64` in
 * `src/bun/agents.ts`) — duplicated here (literal, same reason as the
 * marker above) so test 3 can write its own copy into a SECOND `mkdtemp`
 * directory outside any task's workdir, for the user-bubble `file://` /
 * bare-absolute-path scenario.
 */
const FAKE_PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Generous poll/assertion timeout — this machine runs under heavy load
 *  (see CLAUDE.md's `project_cli_tests_hang_under_load` memory entry), so
 *  every convergence wait below uses this instead of the 5s Playwright
 *  default. Mirrors `e2e/at-file-autocomplete.spec.ts`'s `CONVERGE_TIMEOUT`
 *  idiom. */
const CONVERGE_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
}

interface MdImageTask {
  task: TaskRow;
  workdir: string;
  mdImageDir: string;
  shotPath: string;
  missingPath: string;
  reportPath: string;
}

/** Create a task whose prompt embeds the markdown-image scenario marker
 *  (isolation "none", a fresh per-test temp dir as workdir — the fake
 *  driver writes a real `shot.png` under `<workdir>/agetor-md-images/`, and
 *  a fresh dir per test keeps every computed path collision-free across
 *  tests sharing this worker's backend) and start it. Returns the created
 *  task plus every path the scenario's four image refs point at (see the
 *  `FAKE_CLAUDE_MD_IMAGE_PROMPT_MARKER` branch in `src/bun/agents.ts` for
 *  the exact markdown emitted). */
async function createAndStartMdImageTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<MdImageTask> {
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-e2e-md-images-"));
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const prompt = `${FAKE_CLAUDE_MD_IMAGE_PROMPT_MARKER} ${title}`;
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: { title, prompt, isolation: "none", workdir },
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

  const mdImageDir = path.join(workdir, "agetor-md-images");
  return {
    task,
    workdir,
    mdImageDir,
    shotPath: path.join(mdImageDir, "shot.png"),
    missingPath: path.join(mdImageDir, "missing.png"),
    reportPath: path.join(mdImageDir, "report.pdf"),
  };
}

/** Create + start a task WITHOUT the marker whose prompt is pure markdown
 *  referencing a real image that lives OUTSIDE the task's own workdir — so
 *  `shortenTaskPaths` (which only folds paths under a task's own roots,
 *  `RunPanel.tsx`'s `pathRoots`) can never turn it into an `@rel` mention
 *  before `MdImage` ever sees it. Exercises only the orchestrator's
 *  unconditional prompt-echo (see this file's header comment) — the fake
 *  driver's assistant-side reply for a non-marker prompt is irrelevant
 *  here, so isolation/workdir choice for the task itself doesn't matter
 *  beyond being a valid non-git temp dir. */
async function createAndStartUserImageTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
  imagePath: string,
): Promise<TaskRow> {
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-e2e-md-images-user-"));
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const prompt = `![u1](file://${imagePath})\n\n![u2](${imagePath})`;
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: { title, prompt, isolation: "none", workdir },
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

/** The run panel's slide-over `<aside>` — see sent-files.spec.ts's identical
 *  helper for why `.last()` is the right pick (NewTaskForm's sidebar is also
 *  an `<aside>`, mounted first in App.tsx's JSX). */
function runPanel(page: Page) {
  return page.locator("aside").last();
}

/** Click a task card by its exact title and wait for the run panel to mount
 *  (composer textarea visible) — same idiom as sent-files.spec.ts's
 *  `openTask`. */
async function openTask(page: Page, title: string) {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

/** Waits for the markdown-image scenario's one assistant chunk to have
 *  streamed and rendered. Its leading sentence ("Here are the
 *  screenshots.") is unique to this scenario and always precedes the four
 *  image refs inside the SAME markdown chunk — `AssistantBlock` renders a
 *  whole chunk's markdown tree in one React commit (`ReactMarkdown` is not
 *  streamed piecemeal, see markdown-readability.spec.ts's identical note)
 *  — so this is a reliable "the images are in the DOM now" gate regardless
 *  of whether the (very fast) fake turn already finished before this page
 *  navigated here, replayed either way over the task's unified SSE event
 *  stream. Scoped to `panel` so it can never cross another test's task. */
async function waitForMdImageScenario(panel: Locator) {
  await expect(panel.getByText("Here are the screenshots.", { exact: true })).toBeVisible({
    timeout: CONVERGE_TIMEOUT,
  });
}

test.describe("markdown image rendering", () => {
  test("assistant stream renders local images, and missing/non-image refs degrade to labeled chips (never a broken glyph)", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    const title = `md-images-e2e ${randomUUID()}`;
    const { shotPath, missingPath, reportPath } = await createAndStartMdImageTask(request, backend, title);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    await waitForMdImageScenario(panel);

    // --- absolute + relative refs both render as real images, both
    //     resolving to the SAME real file on disk ---------------------------
    const images = panel.locator('[data-testid="md-image"]');
    await expect(images).toHaveCount(2, { timeout: CONVERGE_TIMEOUT });

    for (let i = 0; i < 2; i++) {
      const img = images.nth(i);
      await expect(img).toHaveAttribute("data-path", shotPath);
      const src = await img.getAttribute("src");
      expect(src, `image ${i} src should hit the preview route`).toContain("/files/preview?path=");
      expect(src, `image ${i} src should carry the resolved absolute path`).toContain(
        encodeURIComponent(shotPath),
      );
      await expect
        .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
          timeout: CONVERGE_TIMEOUT,
        })
        .toBeGreaterThan(0);
    }

    const captions = panel.locator('[data-testid="md-image-caption"]');
    await expect(captions).toHaveCount(2);
    await expect(captions.filter({ hasText: "Absolute shot" })).toHaveCount(1);
    await expect(captions.filter({ hasText: "Relative shot" })).toHaveCount(1);

    // --- a real image path that was never written -> fallback chip, never
    //     the browser's broken-image glyph ----------------------------------
    const fallback = panel.locator('[data-testid="md-image-fallback"]');
    await expect(fallback).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
    await expect(fallback).toContainText(path.basename(missingPath));

    // --- a non-image extension -> file chip, decided purely by extension,
    //     independent of whether the file actually exists -------------------
    const fileChip = panel.locator('[data-testid="md-image-file"]');
    await expect(fileChip).toHaveCount(1);
    await expect(fileChip).toContainText(path.basename(reportPath));
  });

  test("clicking a rendered image opens the headless 'couldn't open' dialog; clicking the missing-file chip opens the not-found dialog", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    const title = `md-images-e2e-click ${randomUUID()}`;
    const { missingPath } = await createAndStartMdImageTask(request, backend, title);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    await waitForMdImageScenario(panel);

    // --- click a real, loaded image: /open-path 404-checks existence first
    //     (it exists), then answers 501 under the headless backend ---------
    const images = panel.locator('[data-testid="md-image"]');
    await expect(images).toHaveCount(2, { timeout: CONVERGE_TIMEOUT });
    await images.first().click();

    const openErrorTitle = page.locator("#attachment-open-error-title");
    await expect(openErrorTitle).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    const openErrorDialog = page.getByRole("dialog").filter({ has: openErrorTitle });
    await openErrorDialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(openErrorTitle).toHaveCount(0);

    // --- click the missing-file fallback chip: a definite 404 --------------
    const fallback = panel.locator('[data-testid="md-image-fallback"]');
    await expect(fallback).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
    await fallback.click();

    const notFoundTitle = page.locator("#attachment-not-found-title");
    await expect(notFoundTitle).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    const notFoundDialog = page.getByRole("dialog").filter({ has: notFoundTitle });
    await expect(notFoundDialog).toContainText(missingPath);
    await notFoundDialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(notFoundTitle).toHaveCount(0);
  });

  test("user bubble renders both a file:// ref and a bare-absolute-path ref to the same real image", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    // A SECOND mkdtemp dir, deliberately outside the task's own workdir (see
    // `createAndStartUserImageTask`'s header comment) — otherwise
    // `shortenTaskPaths` would fold the absolute path back to an `@rel`
    // mention before `MdImage` ever classifies it.
    const imgDir = mkdtempSync(path.join(tmpdir(), "agetor-e2e-md-images-src-"));
    const imgPath = path.join(imgDir, "shot.png");
    writeFileSync(imgPath, Buffer.from(FAKE_PNG_1X1_BASE64, "base64"));

    const title = `md-images-e2e-user ${randomUUID()}`;
    await createAndStartUserImageTask(request, backend, title, imgPath);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    // The bubble may render collapsed (`max-h-[4.8rem] overflow-hidden`), so
    // assert counts/attributes and poll `naturalWidth` rather than
    // `toBeVisible` on the images themselves.
    const bubble = panel.locator(".rounded-br-md .agetor-md");
    const bubbleImages = bubble.locator('[data-testid="md-image"]');
    await expect(bubbleImages).toHaveCount(2, { timeout: CONVERGE_TIMEOUT });

    for (let i = 0; i < 2; i++) {
      const img = bubbleImages.nth(i);
      await expect(img).toHaveAttribute("data-path", imgPath);
      await expect
        .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
          timeout: CONVERGE_TIMEOUT,
        })
        .toBeGreaterThan(0);
    }
  });

  test("MdImage renders inline content only — no new .agetor-md wrapper containers", async ({
    page,
    request,
    backend,
  }) => {
    test.setTimeout(60_000);
    const title = `md-images-e2e-wrappers ${randomUUID()}`;
    await createAndStartMdImageTask(request, backend, title);

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);
    await waitForMdImageScenario(panel);

    // Exactly two `.agetor-md` blocks: the "you" bubble echoing the prompt
    // (marker + title, no images) and the assistant's one markdown block
    // (the four image refs). `MdImage` must never introduce an extra
    // block-level wrapper — e2e/markdown-readability.spec.ts's "exactly one
    // .agetor-md per bubble" assumption depends on that, and this is the
    // regression check for it.
    await expect(panel.locator(".agetor-md")).toHaveCount(2, { timeout: CONVERGE_TIMEOUT });
  });
});
