import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, OPENCODE_STUB_SESSIONS_FILE, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for importing an OpenCode session started outside Agetor
 * (docs/plans/add-opencode-harness.md §5 W3-T2, flow 2; D-13). The stub
 * `opencode` binary (e2e/fixtures.ts) answers `session list` from
 * {@link OPENCODE_STUB_SESSIONS_FILE} in the project folder and
 * `session export` from the captured v2 fixture; the follow-up turn runs
 * through the fake driver.
 *
 * Import dialog row (kind `opencode`, harness "OpenCode") → Import → the task
 * lands in Review with the session's history → Run is refused with the 409
 * copy and hidden on the card → a follow-up resumes the imported session.
 * A listed session whose folder is gone shows the reason and can't be
 * imported.
 */

/** The parent session of the captured export (`v2-session-export.json`), one
 *  of the ids the stub's `session export` answers. */
const SESSION_ID = "ses_e8261398affehUf22D8iOXNtgS";
/** A session whose folder was never created. */
const VANISHED_ID = "ses_e82600000000VanishedE2E01";
const SESSION_TITLE = "Explain the project layout (opencode e2e)";
const VANISHED_TITLE = "Work in a deleted folder (opencode e2e)";

const CONVERGE_TIMEOUT = 30_000;

// HOME points at an empty dir so the Claude half of the dialog scans nothing
// of the machine's real ~/.claude (same seam as import-claude-sessions.spec).
const home = mkdtempSync(path.join(tmpdir(), "oc-import-e2e-home-"));
const project = path.join(home, "oc-project");
mkdirSync(project, { recursive: true });
writeFileSync(path.join(home, "agents.json"), "[]");
const updated = Date.parse("2026-10-01T00:00:00.000Z");
writeFileSync(
  path.join(project, OPENCODE_STUB_SESSIONS_FILE),
  JSON.stringify([
    { id: SESSION_ID, title: SESSION_TITLE, updated, created: updated - 60_000, projectId: "global", directory: project },
    {
      id: VANISHED_ID,
      title: VANISHED_TITLE,
      updated: updated - 120_000,
      created: updated - 180_000,
      projectId: "global",
      directory: path.join(home, "vanished"),
    },
  ]),
);

test.use({
  backendEnv: {
    HOME: home,
    AGETOR_CLAUDE_AGENTS_JSON: path.join(home, "agents.json"),
    CLAUDE_CONFIG_DIR: "",
  },
});

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function setup(backend: E2EBackend): Promise<void> {
  const enable = await fetch(`${backend.apiBase}/harnesses/opencode`, {
    method: "PATCH",
    headers: { ...auth(backend), "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  if (!enable.ok) throw new Error(`PATCH /harnesses/opencode -> ${enable.status}: ${await enable.text()}`);
  const proj = await fetch(`${backend.apiBase}/projects`, {
    method: "POST",
    headers: { ...auth(backend), "content-type": "application/json" },
    body: JSON.stringify({ path: project, name: "oc-project" }),
  });
  if (!proj.ok) throw new Error(`POST /projects -> ${proj.status}: ${await proj.text()}`);
}

async function getTask(request: APIRequestContext, backend: E2EBackend, id: string): Promise<Record<string, any>> {
  const res = await request.get(`${backend.apiBase}/tasks/${id}`, { headers: auth(backend) });
  expect(res.ok(), `GET /tasks/${id} -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as Record<string, any>;
}

async function taskRuns(request: APIRequestContext, backend: E2EBackend, id: string): Promise<Array<Record<string, any>>> {
  const res = await request.get(`${backend.apiBase}/tasks/${id}/runs`, { headers: auth(backend) });
  expect(res.ok(), `GET /tasks/${id}/runs -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as Array<Record<string, any>>;
}

function taskCard(page: Page, title: string): Locator {
  return page.locator('[class*="cursor-grab"]').filter({ hasText: title });
}

async function openImportDialog(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Import Claude Code sessions" }).click();
  const dialog = page.getByTestId("import-claude-sessions-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

function opencodeRow(dialog: Locator, title: string): Locator {
  return dialog.locator('[data-testid="import-session-row"][data-kind="opencode"]').filter({ hasText: title });
}

test("an OpenCode session imports into Review with its history, refuses Run, and a follow-up resumes it", async ({
  page,
  request,
  freshBackend,
}) => {
  test.setTimeout(180_000);
  await setup(freshBackend);
  await gotoApp(page, freshBackend.bootBase);
  const dialog = await openImportDialog(page);

  const row = opencodeRow(dialog, SESSION_TITLE);
  await expect(row).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
  await expect(row.getByTestId("import-sessions-harness")).toHaveText("OpenCode");
  await expect(row.getByTestId("import-sessions-harness")).toHaveAttribute("title", "opencode");
  await expect(row).toContainText("oc-project");
  await expect(row.getByTestId("import-claude-session-reason")).toHaveCount(0);
  const importButton = row.getByRole("button", { name: "Import", exact: true });
  await expect(importButton).toBeEnabled();
  await importButton.click();
  // An imported session is owned from then on, so the row leaves the list.
  await expect(opencodeRow(dialog, SESSION_TITLE)).toHaveCount(0, { timeout: CONVERGE_TIMEOUT });
  await page.getByRole("button", { name: "Close" }).click();

  // The task: in Review, bound to the session, history backfilled.
  let taskId = "";
  await expect
    .poll(
      async () => {
        const res = await request.get(`${freshBackend.apiBase}/tasks`, { headers: auth(freshBackend) });
        const list = (await res.json()) as Array<Record<string, any>>;
        const task = list.find((t) => t.title === SESSION_TITLE);
        taskId = task?.id ?? "";
        return task ? { column: task.column, status: task.importedOpencode?.status } : null;
      },
      { timeout: CONVERGE_TIMEOUT },
    )
    .toEqual({ column: "review", status: "ready" });
  const task = await getTask(request, freshBackend, taskId);
  expect(task.agent).toBe("opencode");
  expect(task.isolation).toBe("none");
  expect(task.workdir).toBe(project);
  expect(task.importedOpencode.sessionId).toBe(SESSION_ID);
  expect(task.importedOpencode.harnessId).toBe("opencode");
  const seed = await taskRuns(request, freshBackend, taskId);
  expect(seed).toHaveLength(1);
  expect(seed[0]).toMatchObject({ origin: "imported", status: "succeeded", opencodeSessionId: SESSION_ID });

  // Run is refused: the card offers Open instead, and the route 409s.
  const card = taskCard(page, SESSION_TITLE);
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByRole("button", { name: "Open", exact: true })).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await expect(card.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);
  const start = await request.post(`${freshBackend.apiBase}/tasks/${taskId}/start`, { headers: auth(freshBackend) });
  expect(start.status()).toBe(409);
  expect(await start.json()).toMatchObject({
    error: "imported OpenCode session — send a message to continue",
    code: "imported-session",
  });

  await card.getByRole("button", { name: "Open", exact: true }).click();
  const panel = page.locator("aside").last();
  await expect(panel.getByTestId("run-origin-imported")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  const transcript = panel.getByTestId("transcript-log");
  await expect(transcript.getByText(/^Do exactly these steps: 1\) Use your read tool/).first()).toBeVisible();
  await expect(transcript.getByRole("button", { name: /subagent/ })).toBeVisible();
  await expect(transcript.getByText("DONE", { exact: true })).toBeVisible();
  await expect(panel.getByText("OpenCode history is still importing…")).toHaveCount(0);

  // A follow-up resumes the imported session (`-s <id>`) on the harness that
  // listed it.
  const textarea = panel.getByTestId("send-textarea");
  await expect(textarea).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
  await textarea.fill("what did you find?");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(panel.getByText(`resuming OpenCode session ${SESSION_ID.slice(0, 8)}…`, { exact: true })).toBeVisible({
    timeout: CONVERGE_TIMEOUT,
  });
  await expect(panel.getByText(/^opencode 2\.x · server=shared · /)).toHaveCount(1);
  await expect(panel.getByText("fake response to: what did you find?", { exact: true })).toBeVisible({
    timeout: CONVERGE_TIMEOUT,
  });
  await expect
    .poll(
      async () => {
        const runs = await taskRuns(request, freshBackend, taskId);
        return runs.map((r) => ({ status: r.status, session: r.opencodeSessionId }));
      },
      { timeout: CONVERGE_TIMEOUT },
    )
    .toEqual([
      { status: "succeeded", session: SESSION_ID },
      { status: "succeeded", session: SESSION_ID },
    ]);
});

test("an OpenCode session whose folder is gone is listed with the reason and cannot be imported", async ({
  page,
  freshBackend,
}) => {
  await setup(freshBackend);
  await gotoApp(page, freshBackend.bootBase);
  const dialog = await openImportDialog(page);
  const row = opencodeRow(dialog, VANISHED_TITLE);
  await expect(row).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
  await expect(row.getByTestId("import-claude-session-reason")).toHaveText("Session folder no longer exists");
  await expect(row.getByRole("button", { name: "Import", exact: true })).toBeDisabled();
  await expect(row.getByTestId("import-claude-session-select")).toBeDisabled();
});
