import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";
import {
  FAKE_CLAUDE_HANDOFF_PROMPT_MARKER,
  auth,
  boardCardById,
  createPipelineRest,
  createProfileRest,
  makeStep,
  startTaskRest,
  waitForPipelineRest,
  type TaskRow,
} from "./scroll-memory-helpers";

/**
 * E2e coverage for the formatted handoff card (docs/plans/formatted-handoff.md
 * §5 E1). A pipeline step agent ends its final message with
 * `<handoff>{json}</handoff>`; the step task's RunPanel renders it as a
 * compact card with a window-wide modal, the run view's history row shows the
 * same card, and the NEXT step's prompt bubble renders each untrusted span as
 * a `Handoff from "<step>" · untrusted` card plus a handoff-file chip.
 *
 * Every step is driven by the fake claude driver
 * (`FAKE_CLAUDE_HANDOFF_PROMPT_MARKER`, `src/bun/agents.ts`): the LAST marker
 * occurrence in a step's composed prompt wins, so each step's own
 * `instructions` carries its suffix (`rich`, `rich-blocked`, `mention`,
 * `invalid-then-done`, `done`). `rich` writes `agetor-handoff/notes.md` and
 * `agetor-handoff/report.txt` into the task's cwd and emits the canonical
 * rich handoff (copied literally below), whose 6th artifact
 * (`agetor-handoff/missing.md`) is never written.
 *
 * Every task gets its own `mkdtemp` workdir with `isolation: "none"` (pipeline
 * steps inherit the parent's workdir), so the fake writes into a per-test
 * directory and `missing.md` is truly missing; the dirs are removed in
 * `afterEach`. Each test runs on its own `freshBackend` with a 300 ms fake
 * resolve delay (the `backendEnv` option only reaches `freshBackend`, and it
 * is merged on top of the fixture's base env, so nothing else needs
 * repeating here).
 *
 * The headless backend has no native bridge: `/open-path` and `/reveal-path`
 * answer 404 for a missing path and 501 for an existing one, which surface as
 * the shared `AttachmentNotFoundDialog` / `AttachmentOpenErrorDialog`
 * (`#attachment-not-found-title` / `#attachment-open-error-title`).
 *
 * A step's prompt bubble quotes the handoff contract (it names `<handoff>`,
 * `</handoff>` and `schemaVersion`), so absence assertions on those strings
 * are always scoped to the card's own `[data-evid]` wrapper, never the page.
 */

const RICH_SUMMARY_WORD = "Rich";
const RICH_REASON = "e2e rich reason uniquetoken-reason";
const RICH_QUESTIONS = ["First e2e question?", "Second e2e question?"];
const RICH_PROSE = "Here is the rich handoff.";
const CONVERGE_TIMEOUT = 45_000;
const UI_TIMEOUT = 20_000;

// Each test boots its own backend and runs a pipeline end to end.
test.describe.configure({ timeout: 120_000 });

test.use({ backendEnv: { AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS: "300" } });

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeWorkdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agetor-handoff-e2e-"));
  tempDirs.push(dir);
  return dir;
}

test.afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort — the OS temp dir is cleaned eventually anyway
    }
  }
});

/** `POST /tasks` with a per-test workdir and `isolation: "none"`; a pipeline
 *  parent when `pipelineId` is given, else a plain claude-code task. */
async function createTaskInDir(
  backend: E2EBackend,
  input: { title: string; prompt: string; workdir: string; pipelineId?: string },
): Promise<TaskRow> {
  const res = await fetch(`${backend.apiBase}/tasks`, {
    method: "POST",
    headers: auth(backend),
    body: JSON.stringify({
      title: input.title,
      prompt: input.prompt,
      isolation: "none",
      workdir: input.workdir,
      ...(input.pipelineId ? { pipelineId: input.pipelineId } : {}),
    }),
  });
  if (!res.ok) throw new Error(`POST /tasks -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as TaskRow;
}

interface SeededPipeline {
  task: TaskRow;
  title: string;
  workdir: string;
  steps: { id: string; name: string }[];
}

/**
 * Builds a linear pipeline whose steps carry the given fake-handoff suffixes
 * (step names `A`, `B`, …), creates its parent task in a fresh workdir,
 * starts it and waits until `pipelineRun.status` reads `untilStatus`.
 */
async function runPipeline(
  backend: E2EBackend,
  suffixes: string[],
  untilStatus: "done" | "blocked",
): Promise<SeededPipeline> {
  const profileId = await createProfileRest(backend, `Handoff Runner ${randomUUID().slice(0, 8)}`);
  const steps = suffixes.map((suffix, i) =>
    makeStep({
      id: randomUUID(),
      name: String.fromCharCode(65 + i),
      agentProfileId: profileId,
      instructions: `Do your part. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:${suffix}`,
    }),
  );
  const edges = steps.slice(1).map((s, i) => ({ from: steps[i]!.id, to: s.id }));
  const pipelineId = await createPipelineRest(backend, `Handoff Pipeline ${randomUUID().slice(0, 8)}`, steps, edges);
  const workdir = makeWorkdir();
  const title = `Formatted handoff ${randomUUID()}`;
  const task = await createTaskInDir(backend, {
    title,
    prompt: "Exercise the formatted handoff card.",
    workdir,
    pipelineId,
  });
  await startTaskRest(backend, task.id);
  const settled = await waitForPipelineRest(
    backend,
    task.id,
    (t) => t.pipelineRun?.status === untilStatus,
    CONVERGE_TIMEOUT,
  );
  return { task: settled, title, workdir, steps: steps.map((s) => ({ id: s.id, name: s.name })) };
}

// ---------------------------------------------------------------------------
// Navigation + locators
// ---------------------------------------------------------------------------

/** The run panel's slide-over `<aside>` — `.last()` because NewTaskForm's own
 *  always-present `<aside>` sidebar mounts first. */
function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

function stepNode(page: Page, stepId: string): Locator {
  return page.locator(`[data-testid="pipeline-step-node"][data-step-id="${stepId}"]`);
}

/** A history row by the "#<seq> <stepName>" prefix `HistoryRow` renders
 *  (rows are newest-first, so position is not execution order). */
function historyRowFor(page: Page, stepName: string): Locator {
  return page
    .locator('[data-testid="pipeline-run-history-row"]')
    .filter({ hasText: new RegExp(`^#\\d+ ${stepName}`) });
}

/** Board → the pipeline parent's card → the full-page run view. */
async function openRunView(page: Page, backend: E2EBackend, taskId: string): Promise<void> {
  await gotoApp(page, backend.bootBase);
  await boardCardById(page, taskId).click();
  await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
}

/** Run view → click a step node → that step task's RunPanel (pipeline strip
 *  visible, panel slid in). */
async function openStepPanel(page: Page, backend: E2EBackend, seeded: SeededPipeline, stepName: string): Promise<Locator> {
  await openRunView(page, backend, seeded.task.id);
  const step = seeded.steps.find((s) => s.name === stepName);
  if (!step) throw new Error(`no step named ${stepName}`);
  await stepNode(page, step.id).click();
  const panel = runPanel(page);
  await expect(panel.getByTestId("run-panel-pipeline-strip")).toBeVisible({ timeout: UI_TIMEOUT });
  await expect(panel).toHaveClass(/translate-x-0/);
  return panel;
}

function transcriptCard(panel: Locator): Locator {
  return panel.locator('[data-testid="handoff-card"][data-variant="transcript"]');
}

/** The `[data-evid]` search carrier wrapping a rendered event. */
function evidWrapper(inner: Locator): Locator {
  return inner.locator("xpath=ancestor::*[@data-evid][1]");
}

/** Asserts `earlier` precedes `later` in document order (both resolved to
 *  their first match). */
async function expectBefore(page: Page, earlier: Locator, later: Locator): Promise<void> {
  const a = await earlier.first().elementHandle();
  const b = await later.first().elementHandle();
  if (!a || !b) throw new Error("expectBefore: element not found");
  const following = await page.evaluate(
    ([x, y]) => Boolean(x!.compareDocumentPosition(y!) & Node.DOCUMENT_POSITION_FOLLOWING),
    [a, b] as const,
  );
  expect(following, "expected the first element to precede the second in document order").toBe(true);
}

/** Same in-page Meta/Control sniff the app uses (`isMacPlatform`). */
async function shortcutModifier(page: Page): Promise<"Meta" | "Control"> {
  const isMac = await page.evaluate(() => /mac/i.test(navigator.platform || navigator.userAgent || ""));
  return isMac ? "Meta" : "Control";
}

/**
 * Clicks the "Show more" toggle of the user bubble that contains `inner`
 * (`UserMessageBlock` caps a long bubble at `max-h-[4.8rem] overflow-hidden`
 * and the toggle carries no test id). No-op when the bubble has no toggle.
 */
async function expandUserBubble(inner: Locator): Promise<void> {
  const bubble = inner.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' rounded-br-md ')][1]");
  await expect(bubble).toHaveCount(1);
  const toggle = bubble.getByRole("button", { name: "Show more", exact: true });
  // `needsToggle` is measured after mount, so give the toggle a moment to appear.
  await toggle.last().waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  if ((await toggle.count()) > 0) {
    await toggle.last().click();
    await expect(bubble.getByRole("button", { name: "Show less", exact: true })).toBeVisible();
  }
}

function handoffDialog(page: Page): Locator {
  return page.getByTestId("handoff-dialog");
}

function openErrorDialog(page: Page): Locator {
  return page.getByRole("dialog").filter({ has: page.locator("#attachment-open-error-title") });
}

function notFoundDialog(page: Page): Locator {
  return page.getByRole("dialog").filter({ has: page.locator("#attachment-not-found-title") });
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

test.describe("formatted handoff", () => {
  test("(1) card: a rich handoff renders as a compact card with prose above it", async ({ page, freshBackend }) => {
    const backend = freshBackend;
    const seeded = await runPipeline(backend, ["rich", "done"], "done");
    const panel = await openStepPanel(page, backend, seeded, "A");

    const card = transcriptCard(panel);
    await expect(card).toHaveCount(1, { timeout: UI_TIMEOUT });
    await expect(card).toHaveAttribute("data-status", "done");
    await expect(card.getByTestId("handoff-card-status")).toContainText("Done");
    // Single outgoing edge: the runner ignores `next:null` and goes to B (K9).
    const next = card.getByTestId("handoff-card-next");
    await expect(next).toContainText("→ B", { timeout: UI_TIMEOUT });
    await expect(next).toHaveAttribute("data-next-kind", "steps");
    await expect(card.getByTestId("handoff-card-summary")).toContainText(RICH_SUMMARY_WORD);
    await expect(card.getByTestId("handoff-card-artifact")).toHaveCount(6);
    await expect(card.getByTestId("handoff-card-more")).toContainText("+2");
    await expect(card.getByTestId("handoff-card-questions")).toHaveText("? 2 open questions");
    await expect(card.getByTestId("handoff-card-open")).toBeVisible();

    // The prose before the block renders above the card, in the same event.
    const wrapper = evidWrapper(card);
    await expect(wrapper).toHaveCount(1);
    const prose = wrapper.getByText(RICH_PROSE, { exact: false });
    await expect(prose).toBeVisible();
    await expectBefore(page, prose, card);

    // No raw tag/JSON leaks into the rendered event (scoped: the step's
    // prompt bubble legitimately quotes the contract).
    const wrapperText = (await wrapper.textContent()) ?? "";
    expect(wrapperText).not.toContain("</handoff>");
    expect(wrapperText).not.toContain("<handoff>");
    expect(wrapperText).not.toContain("schemaVersion");
  });

  test("(2) modal: Open shows formatted sections, pipeline context, Raw and Copy JSON; Escape closes only the modal", async ({
    page,
    context,
    freshBackend,
  }) => {
    const backend = freshBackend;
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const seeded = await runPipeline(backend, ["rich", "done"], "done");
    const panel = await openStepPanel(page, backend, seeded, "A");

    const card = transcriptCard(panel);
    await expect(card).toHaveCount(1, { timeout: UI_TIMEOUT });
    await card.getByTestId("handoff-card-open").click();

    const dialog = handoffDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("handoff-dialog-step")).toContainText("A");
    await expect(dialog.getByTestId("handoff-dialog-next")).toContainText("B");
    await expect(dialog.getByTestId("handoff-dialog-usage")).toHaveAttribute("data-usage", "used", {
      timeout: UI_TIMEOUT,
    });
    await expect(dialog.getByTestId("handoff-dialog-artifact-text")).toHaveCount(2);
    const questions = dialog.getByTestId("handoff-dialog-questions");
    for (const q of RICH_QUESTIONS) await expect(questions).toContainText(q);
    await expect(dialog).toContainText(RICH_REASON);

    // Raw view: pretty-printed JSON.
    await dialog.getByTestId("handoff-dialog-view-raw").click();
    await expect(dialog.getByTestId("handoff-dialog-raw")).toContainText('"schemaVersion": 1');
    await dialog.getByTestId("handoff-dialog-view-formatted").click();
    await expect(dialog.getByTestId("handoff-dialog-raw")).toHaveCount(0);

    // Copy JSON → the clipboard holds the handoff as JSON.
    await dialog.getByTestId("handoff-dialog-copy").click();
    await expect
      .poll(
        async () => {
          const clip = await page.evaluate(() => navigator.clipboard.readText());
          try {
            return (JSON.parse(clip) as { reason?: unknown }).reason ?? null;
          } catch {
            return null;
          }
        },
        { timeout: UI_TIMEOUT },
      )
      .toBe(RICH_REASON);

    // Escape closes only the modal; the panel stays open.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(panel).toHaveClass(/translate-x-0/);
    await expect(panel.getByTestId("run-panel-pipeline-strip")).toBeVisible();
  });

  test("(3) artifacts: missing chip dims and 404s, an existing chip and Reveal in Finder 501, the URL chip is a url", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const seeded = await runPipeline(backend, ["rich", "done"], "done");
    const panel = await openStepPanel(page, backend, seeded, "A");

    const card = transcriptCard(panel);
    await expect(card).toHaveCount(1, { timeout: UI_TIMEOUT });
    const chips = card.getByTestId("handoff-card-artifact");
    await expect(chips).toHaveCount(6);

    // URL chip.
    const urlChip = card.locator('[data-testid="handoff-card-artifact"][data-artifact-kind="url"]');
    await expect(urlChip).toHaveCount(1);
    await expect(urlChip).toContainText("example.invalid");

    // The never-written path is marked missing once /refs/resolve answers.
    const missingChip = chips.filter({ hasText: "missing.md" });
    await expect(missingChip).toHaveCount(1);
    await expect(missingChip).toHaveAttribute("data-missing", "true", { timeout: UI_TIMEOUT });
    const existingChip = chips.filter({ hasText: "report.txt" });
    await expect(existingChip).toHaveCount(1);
    await expect(existingChip).toHaveAttribute("data-artifact-kind", "path");
    await expect(existingChip).not.toHaveAttribute("data-missing", "true");

    // Missing chip → not-found dialog.
    await missingChip.click();
    const notFound = notFoundDialog(page);
    await expect(notFound).toBeVisible({ timeout: UI_TIMEOUT });
    await expect(notFound).toContainText("missing.md");
    await notFound.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("#attachment-not-found-title")).toHaveCount(0);

    // Existing chip → /open-path exists → headless 501 → couldn't-open dialog.
    await existingChip.click();
    const openError = openErrorDialog(page);
    await expect(openError).toBeVisible({ timeout: UI_TIMEOUT });
    await expect(openError).toContainText("report.txt");
    await openError.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("#attachment-open-error-title")).toHaveCount(0);

    // Right-click → artifact menu → Reveal in Finder → headless 501.
    await existingChip.click({ button: "right" });
    const menu = page.getByTestId("handoff-artifact-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("handoff-artifact-menu-reveal")).toHaveText("Reveal in Finder");
    await menu.getByTestId("handoff-artifact-menu-reveal").click();
    await expect(openErrorDialog(page)).toBeVisible({ timeout: UI_TIMEOUT });
    await openErrorDialog(page).getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("#attachment-open-error-title")).toHaveCount(0);
    await expect(panel).toHaveClass(/translate-x-0/);
  });

  test("(4) run view: A's history row shows the history card, and Open shows the modal", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const seeded = await runPipeline(backend, ["rich", "done"], "done");
    await openRunView(page, backend, seeded.task.id);

    const row = historyRowFor(page, "A");
    await expect(row).toHaveCount(1, { timeout: UI_TIMEOUT });
    await row.getByRole("button").first().click();
    const holder = row.getByTestId("pipeline-run-history-handoff");
    await expect(holder).toBeVisible();
    const card = holder.locator('[data-testid="handoff-card"][data-variant="history"]');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(RICH_SUMMARY_WORD);
    await expect(card).toHaveAttribute("data-status", "done");

    await card.getByTestId("handoff-card-open").click();
    const dialog = handoffDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(RICH_REASON);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
  });

  test("(5) prompt card + handoff-file chip: B's prompt shows A's handoff as an untrusted card and the file chip opens the modal", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const seeded = await runPipeline(backend, ["rich", "done"], "done");
    const panel = await openStepPanel(page, backend, seeded, "B");

    const promptCard = panel.locator('[data-testid="handoff-card"][data-variant="prompt"]');
    await expect(promptCard).toHaveCount(1, { timeout: UI_TIMEOUT });
    // The card sits in the prompt bubble's collapsed (max-height, overflow
    // hidden) body — expand the bubble before interacting with anything in it.
    await expandUserBubble(promptCard);
    await expect(promptCard).toContainText('Handoff from "A" · untrusted');
    await expect(promptCard.getByTestId("handoff-card-summary")).toContainText(RICH_SUMMARY_WORD);

    const chip = panel.getByTestId("handoff-file-chip");
    await expect(chip).toHaveCount(1);
    await chip.click();
    const dialog = handoffDialog(page);
    await expect(dialog).toBeVisible({ timeout: UI_TIMEOUT });
    await expect(dialog).toContainText(RICH_REASON);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(panel).toHaveClass(/translate-x-0/);
  });

  test("(6) invalid: an unparsable block renders as an Invalid handoff card, then a valid card follows the reminder", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const seeded = await runPipeline(backend, ["invalid-then-done"], "done");
    const panel = await openStepPanel(page, backend, seeded, "A");

    const invalid = panel.getByTestId("handoff-invalid-card");
    await expect(invalid).toHaveCount(1, { timeout: UI_TIMEOUT });
    const raw = invalid.getByTestId("handoff-invalid-raw");
    await expect(raw).toHaveCount(1);
    // The raw body sits in a collapsed <details>.
    const rawOpen = await raw.evaluate((el) => {
      const details = el.closest("details") ?? el.querySelector("details");
      return details ? details.open : null;
    });
    expect(rawOpen).toBe(false);

    const reminder = panel.getByTestId("handoff-reminder-badge");
    await expect(reminder).toHaveCount(1, { timeout: UI_TIMEOUT });
    const valid = transcriptCard(panel);
    await expect(valid).toHaveCount(1, { timeout: UI_TIMEOUT });
    await expect(valid).toHaveAttribute("data-status", "done");

    await expectBefore(page, invalid, reminder);
    await expectBefore(page, reminder, valid);
  });

  test("(7) blocked: a status:\"blocked\" handoff renders a blocked card", async ({ page, freshBackend }) => {
    const backend = freshBackend;
    const seeded = await runPipeline(backend, ["rich-blocked"], "blocked");
    const panel = await openStepPanel(page, backend, seeded, "A");

    const card = panel.locator('[data-testid="handoff-card"][data-status="blocked"]');
    await expect(card).toHaveCount(1, { timeout: UI_TIMEOUT });
    await expect(card).toHaveAttribute("data-variant", "transcript");
    await expect(card.getByTestId("handoff-card-status")).toContainText("Blocked");
  });

  test("(8) search: a match only in the modal lands on the card's event and shows the in-handoff hint", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const seeded = await runPipeline(backend, ["rich", "done"], "done");
    const panel = await openStepPanel(page, backend, seeded, "A");

    const card = transcriptCard(panel);
    await expect(card).toHaveCount(1, { timeout: UI_TIMEOUT });
    await expect(card.getByTestId("handoff-card-search-hint")).toHaveCount(0);

    await page.keyboard.press(`${await shortcutModifier(page)}+KeyF`);
    const input = panel.getByRole("textbox", { name: "Search messages" });
    await expect(input).toBeFocused();
    await input.fill("uniquetoken-reason");
    await expect(panel.getByText("1/1", { exact: true })).toBeVisible({ timeout: UI_TIMEOUT });
    await input.press("Enter");

    // The highlighted [data-evid] carrier is the card's event.
    const matched = panel.locator("[data-evid].ring-1");
    await expect(matched).toHaveCount(1);
    await expect(matched.locator('[data-testid="handoff-card"]')).toHaveCount(1);
    await expect(card.getByTestId("handoff-card-search-hint")).toBeVisible({ timeout: UI_TIMEOUT });
  });

  test("(9) gating: a plain (non-pipeline) task shows the raw handoff text and no card", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const workdir = makeWorkdir();
    const title = `Plain handoff ${randomUUID()}`;
    const task = await createTaskInDir(backend, {
      title,
      prompt: `Plain task with a handoff. ${FAKE_CLAUDE_HANDOFF_PROMPT_MARKER}:rich`,
      workdir,
    });
    await startTaskRest(backend, task.id);
    await expect
      .poll(
        async () => {
          const res = await fetch(`${backend.apiBase}/tasks/${task.id}`, { headers: auth(backend) });
          return ((await res.json()) as TaskRow).column;
        },
        { timeout: CONVERGE_TIMEOUT },
      )
      .toBe("review");

    await gotoApp(page, backend.bootBase);
    await boardCardById(page, task.id).click();
    const panel = runPanel(page);
    await expect(panel.locator("textarea")).toBeVisible();
    await expect(panel.getByText(RICH_PROSE, { exact: false }).first()).toBeVisible({ timeout: UI_TIMEOUT });
    // The block stays raw text (the prompt here carries no contract text).
    await expect(panel).toContainText(`"reason":"${RICH_REASON}"`);
    await expect(panel).toContainText("</handoff>");
    await expect(panel.getByTestId("handoff-card")).toHaveCount(0);
    await expect(panel.getByTestId("handoff-invalid-card")).toHaveCount(0);
  });

  test("(10) mention: an inline-code `<handoff>` mention before the real block still renders a card and advances without a reminder", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const seeded = await runPipeline(backend, ["mention"], "done");
    // The runner took the real block: no reminder was sent.
    const history = (seeded.task.pipelineRun?.history ?? []) as Array<{
      stepId: string;
      responseKind?: string | null;
      reminder?: unknown;
    }>;
    expect(history).toHaveLength(1);
    expect(history[0]!.responseKind).toBe("handoff");
    expect(history[0]!.reminder ?? null).toBeNull();

    await openRunView(page, backend, seeded.task.id);
    await expect(page.getByTestId("pipeline-run-status")).toHaveText("Done");
    const row = historyRowFor(page, "A");
    await expect(row).toHaveCount(1, { timeout: UI_TIMEOUT });
    await expect(row.getByTestId("pipeline-run-reminder")).toHaveCount(0);

    const step = seeded.steps[0]!;
    await stepNode(page, step.id).click();
    const panel = runPanel(page);
    await expect(panel.getByTestId("run-panel-pipeline-strip")).toBeVisible({ timeout: UI_TIMEOUT });
    const card = transcriptCard(panel);
    await expect(card).toHaveCount(1, { timeout: UI_TIMEOUT });
    await expect(card).toHaveAttribute("data-status", "done");
    await expect(card.getByTestId("handoff-card-summary")).toContainText("fake summary for mention");
    // The prose with the inline-code mention renders above the card.
    const wrapper = evidWrapper(card);
    await expectBefore(page, wrapper.getByText("I checked the", { exact: false }), card);
    await expect(panel.getByTestId("handoff-reminder-badge")).toHaveCount(0);
  });

  test("(11) modal artifact menu: Escape closes only the menu, even when focus left it; the next Escape closes the modal", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const seeded = await runPipeline(backend, ["rich", "done"], "done");
    const panel = await openStepPanel(page, backend, seeded, "A");

    const card = transcriptCard(panel);
    await expect(card).toHaveCount(1, { timeout: UI_TIMEOUT });
    await card.getByTestId("handoff-card-open").click();
    const dialog = handoffDialog(page);
    await expect(dialog).toBeVisible();
    const row = dialog.getByTestId("handoff-dialog-artifact").filter({ hasText: "report.txt" });
    await expect(row).toHaveCount(1);
    const menu = page.getByTestId("handoff-artifact-menu");

    // Focus inside the menu: the menu's own handler consumes Escape.
    await row.click({ button: "right" });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(dialog).toBeVisible();

    // Focus outside the menu: the dialog's document listener runs before the menu's own
    // backstop and must yield to the open menu (it used to close the whole modal).
    await row.click({ button: "right" });
    await expect(menu).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(dialog).toBeVisible();

    // With the menu gone, Escape closes the modal and only the modal.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(panel).toHaveClass(/translate-x-0/);
    await expect(panel.getByTestId("run-panel-pipeline-strip")).toBeVisible();
  });

  test("(12) a chip the stat called missing still asks the OS; a click the stat contradicts re-stats the whole set", async ({
    page,
    freshBackend,
  }) => {
    const backend = freshBackend;
    const seeded = await runPipeline(backend, ["rich", "done"], "done");
    const panel = await openStepPanel(page, backend, seeded, "A");

    const card = transcriptCard(panel);
    await expect(card).toHaveCount(1, { timeout: UI_TIMEOUT });
    const chips = card.getByTestId("handoff-card-artifact");
    const missingChip = chips.filter({ hasText: "missing.md" });
    const existingChip = chips.filter({ hasText: "report.txt" });
    await expect(missingChip).toHaveAttribute("data-missing", "true", { timeout: UI_TIMEOUT });
    await expect(existingChip).not.toHaveAttribute("data-missing", "true");

    // The file appears after the stat. The click asks the OS anyway (the chip used to go straight
    // to the not-found dialog): /open-path finds the file and the headless backend answers 501.
    // (A 501 is an error answer, which the chip reads as saying nothing about existence, so only
    // the desktop app's 200 re-stats here — the 404 below shows the forced re-stat instead.)
    writeFileSync(join(seeded.workdir, "agetor-handoff", "missing.md"), "written after the stat\n");
    await missingChip.click();
    const openError = openErrorDialog(page);
    await expect(openError).toBeVisible({ timeout: UI_TIMEOUT });
    await expect(openError).toContainText("missing.md");
    await expect(page.locator("#attachment-not-found-title")).toHaveCount(0);
    await openError.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("#attachment-open-error-title")).toHaveCount(0);

    // The other way round: a file removed after the stat → not-found dialog, and the chip dims.
    rmSync(join(seeded.workdir, "agetor-handoff", "report.txt"));
    await existingChip.click();
    const notFound = notFoundDialog(page);
    await expect(notFound).toBeVisible({ timeout: UI_TIMEOUT });
    await expect(notFound).toContainText("report.txt");
    await notFound.getByRole("button", { name: "Close", exact: true }).click();
    await expect(existingChip).toHaveAttribute("data-missing", "true", { timeout: UI_TIMEOUT });
    // That 404 contradicted the stat, which forced a re-stat of the card's whole path set: the
    // file written above now reads as present, long before the 30 s cache entry would expire.
    await expect(missingChip).not.toHaveAttribute("data-missing", "true", { timeout: UI_TIMEOUT });
  });

  test("(13) a mounted card re-stats its chips on hover once the cached stat has expired (no polling)", async ({
    page,
    freshBackend,
  }) => {
    // Waits out the 30 s artifact-stat TTL (ARTIFACT_STATS_TTL_MS) on top of the pipeline run.
    test.setTimeout(180_000);
    const backend = freshBackend;
    const seeded = await runPipeline(backend, ["rich", "done"], "done");
    const panel = await openStepPanel(page, backend, seeded, "A");

    const card = transcriptCard(panel);
    await expect(card).toHaveCount(1, { timeout: UI_TIMEOUT });
    const missingChip = card.getByTestId("handoff-card-artifact").filter({ hasText: "missing.md" });
    await expect(missingChip).toHaveAttribute("data-missing", "true", { timeout: UI_TIMEOUT });
    writeFileSync(join(seeded.workdir, "agetor-handoff", "missing.md"), "written after the stat\n");

    // Nothing polls: each attempt moves the pointer off the chips and back onto them. A hover
    // inside the TTL reuses the cached stat; the first one past it stats again.
    await expect
      .poll(
        async () => {
          await page.mouse.move(0, 0);
          await missingChip.hover();
          return missingChip.getAttribute("data-missing");
        },
        { timeout: 60_000, intervals: [2_000] },
      )
      .toBeNull();
  });
});
