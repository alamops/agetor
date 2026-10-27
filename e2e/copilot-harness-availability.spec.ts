import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E failure states of the GitHub Copilot harness's availability probe
 * (docs/plans/github-copilot-harness.md §3.10, D2/D16). Copilot is seeded
 * ENABLED, so every user without the CLI sees it listed — the app must say
 * why it can't run and how to install it, and refuse a start before any run
 * row exists:
 *
 * 1. Not installed (the fixture's default: `AGETOR_COPILOT_BIN` points at a
 *    path that never exists) — Settings row enabled but red, New Task's
 *    inline install hint, and "Run task" refused with the cask hint.
 * 2. AWS Copilot on PATH instead (a binary of the same name whose `--version`
 *    lacks "GitHub Copilot CLI") — the identity gate's reason in the same
 *    three places.
 *
 * The happy paths (stub opted in) live in e2e/copilot-harness.spec.ts.
 */

const CASK_HINT = "brew install --cask copilot-cli";
const AWS_REASON = "`copilot` isn't GitHub Copilot CLI (AWS Copilot ships a binary of the same name)";

/** An AWS-Copilot-shaped `copilot`: answers `--version` the way AWS's CLI
 *  does. Written per process at load, before any backend spawns. */
const awsStubDir = mkdtempSync(path.join(tmpdir(), "agetor-e2e-aws-copilot-"));
const awsStubBin = path.join(awsStubDir, "copilot");
writeFileSync(
  awsStubBin,
  ["#!/bin/sh", 'if [ "$1" = "--version" ]; then echo "copilot version: v1.34.0"; exit 0; fi', "exit 0", ""].join("\n"),
);
chmodSync(awsStubBin, 0o755);

test.afterAll(() => {
  rmSync(awsStubDir, { recursive: true, force: true });
});

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function listTasks(request: APIRequestContext, backend: E2EBackend): Promise<Array<Record<string, any>>> {
  const res = await request.get(`${backend.apiBase}/tasks`, { headers: auth(backend) });
  expect(res.ok(), `GET /tasks -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as Array<Record<string, any>>;
}

async function listRuns(request: APIRequestContext, backend: E2EBackend, id: string): Promise<Array<Record<string, any>>> {
  const res = await request.get(`${backend.apiBase}/tasks/${id}/runs`, { headers: auth(backend) });
  expect(res.ok(), `GET /tasks/${id}/runs -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as Array<Record<string, any>>;
}

async function registerProject(backend: E2EBackend, name: string): Promise<void> {
  const dir = path.join(backend.dataDir, "e2e-projects", createHash("sha1").update(name).digest("hex").slice(0, 12));
  mkdirSync(dir, { recursive: true });
  const res = await fetch(`${backend.apiBase}/projects`, {
    method: "POST",
    headers: { ...auth(backend), "content-type": "application/json" },
    body: JSON.stringify({ path: dir, name }),
  });
  if (!res.ok) throw new Error(`POST /projects -> ${res.status}: ${await res.text()}`);
}

async function selectProject(form: Locator, projectName: string): Promise<void> {
  await form
    .getByTitle(
      "Pick the working directory the agent runs in. Add new ones with the folder picker at the bottom of the list.",
    )
    .click();
  const search = form.getByPlaceholder("Search projects…");
  await expect(search).toBeVisible();
  await search.fill(projectName);
  const row = form.getByRole("button", { name: projectName });
  await expect(row).toBeVisible();
  await row.click();
}

async function openSettingsHarnesses(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  await dialog.getByRole("button", { name: "Harnesses", exact: true }).click();
  return dialog;
}

/** The bordered card around one harness row, found from one of its controls. */
function harnessRow(control: Locator): Locator {
  return control.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' rounded-md ')][1]");
}

/**
 * Settings row: enabled (seeded on) yet unavailable — the red status dot,
 * whose tooltip is the probe's reason, and no green dot.
 */
async function expectSettingsRowUnavailable(
  page: Page,
  reason: RegExp | string,
  version: string | null,
): Promise<void> {
  const dialog = await openSettingsHarnesses(page);
  const toggle = dialog.getByRole("switch", { name: "Disable GitHub Copilot", exact: true });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  const row = harnessRow(toggle);
  const redDot = row.locator("span.bg-danger-solid");
  await expect(redDot).toBeVisible({ timeout: 15_000 });
  await expect(row.locator("span.bg-success-solid")).toHaveCount(0);
  await expect(redDot).toHaveAttribute("title", reason);
  await expect(row).toContainText("copilot · copilot");
  // The probed `--version` line is shown as-is (AWS's, so the user can tell);
  // a missing binary has none.
  if (version !== null) await expect(row).toContainText(version);
  await expect(row).not.toContainText("GitHub Copilot CLI");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

/**
 * New Task: picking GitHub Copilot shows the inline unavailable box (reason +
 * cask hint). "Run task" then creates the card but the start is refused with
 * the same reason and hint: the error toast shows it, the task never gets a
 * run, and it stays out of `running`.
 */
async function expectRunRefused(
  page: Page,
  request: APIRequestContext,
  backend: E2EBackend,
  projectName: string,
  reason: RegExp | string,
): Promise<void> {
  const form = page.locator("aside").first();
  const copilotButton = form.getByRole("button", { name: "GitHub Copilot", exact: true });
  await expect(copilotButton).toBeVisible({ timeout: 20_000 });
  // The harness button's own status dot is red too.
  await expect(copilotButton.locator("span.bg-danger-solid")).toBeVisible({ timeout: 15_000 });
  await copilotButton.click();
  await selectProject(form, projectName);

  const unavailable = form.locator("div.border-destructive\\/40").filter({ hasText: CASK_HINT });
  await expect(unavailable).toBeVisible({ timeout: 15_000 });
  await expect(unavailable).toContainText(reason);

  const title = `copilot-unavailable ${randomUUID().slice(0, 8)}`;
  await form.getByPlaceholder("Short description").fill(title);
  const prompt = form.getByTestId("prompt-textarea");
  await prompt.click();
  await prompt.fill("this should never reach an agent");
  // An unavailable harness doesn't disable the button: the start pre-flight
  // is what refuses it.
  const runButton = form.getByRole("button", { name: "Run task", exact: true });
  await expect(runButton).toBeEnabled({ timeout: 15_000 });
  await runButton.click();

  const toast = page.getByText(/GitHub Copilot is not available/).first();
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expect(toast).toContainText(`Install it with: ${CASK_HINT}`);

  await expect
    .poll(async () => (await listTasks(request, backend)).find((t) => t.title === title)?.id ?? null, { timeout: 15_000 })
    .not.toBeNull();
  const task = (await listTasks(request, backend)).find((t) => t.title === title)!;
  expect(task.agent).toBe("copilot");
  expect(task.column).not.toBe("running");
  expect(task.runId).toBeNull();
  expect(await listRuns(request, backend, task.id)).toEqual([]);

  // The API refuses the same start directly, with a 400 and the same copy.
  const res = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, { headers: auth(backend) });
  expect(res.status()).toBe(400);
  const body = (await res.json()) as { error?: string };
  expect(body.error).toMatch(/^GitHub Copilot is not available — /);
  expect(body.error).toContain(`Install it with: ${CASK_HINT}`);
  if (typeof reason === "string") expect(body.error).toContain(reason);
  else expect(body.error).toMatch(reason);
  expect(await listRuns(request, backend, task.id)).toEqual([]);
}

test.describe("GitHub Copilot harness availability", () => {
  test.describe.configure({ timeout: 90_000 });

  test.describe("not installed (the default for a machine without the CLI)", () => {
    test("Settings shows it enabled but red; New Task shows the cask hint; Run task is refused with no run", async ({
      page,
      request,
      freshBackend,
    }) => {
      // Registered before the app loads, so the picker lists it.
      const projectName = `copilot-unavailable-${randomUUID()}`;
      await registerProject(freshBackend, projectName);
      await gotoApp(page, freshBackend.bootBase);
      const notFound = /not found on PATH/;
      await expectSettingsRowUnavailable(page, notFound, null);
      await expectRunRefused(page, request, freshBackend, projectName, notFound);
    });
  });

  test.describe("AWS Copilot's same-named binary on PATH", () => {
    test.use({ backendEnv: { AGETOR_COPILOT_BIN: awsStubBin } });

    test("the identity gate's reason shows in Settings and New Task, and the start is refused", async ({
      page,
      request,
      freshBackend,
    }) => {
      const projectName = `copilot-aws-${randomUUID()}`;
      await registerProject(freshBackend, projectName);
      await gotoApp(page, freshBackend.bootBase);
      await expectSettingsRowUnavailable(page, AWS_REASON, "copilot version: v1.34.0");
      await expectRunRefused(page, request, freshBackend, projectName, AWS_REASON);
    });
  });
});
