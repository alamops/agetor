import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend } from "./fixtures";
import {
  backdateArchivedAt,
  getPreferences,
  gotoApp,
  openSettingsGeneral,
  queryBackendScalar,
  seedArchivedToolResult,
} from "./helpers";

/**
 * E2E coverage for archived-history retention and database maintenance
 * (`docs/plans/non-blocking-session-restore.md`, decisions F/G/H — T8/T11/T13):
 *
 *   - the retention pass trims an oversized `tool_result` of a task archived
 *     past the cutoff to its first 4 KB, in place, one-way;
 *   - after unarchive, RunPanel still renders the row and says it was
 *     trimmed (`tool-result-trimmed`);
 *   - Settings → General: the age picker persists `archivedHistoryRetentionDays`,
 *     the size line shows, and "Compact database" runs (confirm → result);
 *   - Compact is REFUSED while a task is running, with a count.
 *
 * Arrangement that no HTTP route offers goes through the backend's SQLite
 * file (`seedArchivedToolResult`, `backdateArchivedAt` in `./helpers`): the
 * fake drivers only ever emit tiny tool results, and nobody waits 31 real
 * days. Everything asserted is read back through the product (the pass's own
 * response, the transcript UI, `/preferences`) — the one direct DB read is
 * the byte length of the seeded row, to prove the trim happened on disk.
 *
 * The retention scheduler is parked (huge boot delay + debounce) so only this
 * spec's explicit `POST /db/retention/run` ever trims — a boot-time or
 * preference-change pass racing the manual one would turn `trimmedRows` into
 * 0 and a "pass already running" 409.
 */

const SEED_BYTES = 64 * 1024;
const PARKED_SCHEDULER_ENV = {
  AGETOR_RETENTION_BOOT_DELAY_MS: "3600000",
  AGETOR_RETENTION_INTERVAL_MS: "3600000",
  AGETOR_RETENTION_DEBOUNCE_MS: "3600000",
};
const DAY_MS = 86_400_000;

function auth(backend: E2EBackend): { authorization: string; "content-type": string } {
  return { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
}

interface TaskDetail {
  id: string;
  column: string;
  runId: string | null;
}

async function createAndStart(request: APIRequestContext, backend: E2EBackend, title: string): Promise<TaskDetail> {
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title, prompt: title, isolation: "none", workdir: tmpdir() },
  });
  expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
  const task = (await createRes.json()) as TaskDetail;
  const startRes = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, { headers: auth(backend) });
  expect(startRes.ok(), `POST /tasks/${task.id}/start -> ${startRes.status()}: ${await startRes.text()}`).toBeTruthy();
  return task;
}

async function getTask(request: APIRequestContext, backend: E2EBackend, id: string): Promise<TaskDetail> {
  const res = await request.get(`${backend.apiBase}/tasks/${id}`, { headers: auth(backend) });
  expect(res.ok(), `GET /tasks/${id} -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as TaskDetail;
}

async function waitForReview(request: APIRequestContext, backend: E2EBackend, id: string, timeout = 30_000) {
  await expect(async () => {
    expect((await getTask(request, backend, id)).column).toBe("review");
  }).toPass({ timeout });
}

test.describe("archived history retention", () => {
  test.use({ backendEnv: PARKED_SCHEDULER_ENV });

  test("trims an archived task's oversized tool result, shows the trimmed note after unarchive, and persists the age picker; Compact runs", async ({
    page,
    request,
    freshBackend,
  }) => {
    test.setTimeout(120_000);
    const backend = freshBackend;
    const title = `retention-${randomUUID()}`;

    const created = await createAndStart(request, backend, title);
    await waitForReview(request, backend, created.id);
    const settled = await getTask(request, backend, created.id);
    expect(settled.runId, "settled task carries its last run id").toBeTruthy();

    // A 64 KB tool_result (with its paired tool_use) on the run, then archive
    // the task and age the archive past the default 30-day cutoff.
    const seeded = seedArchivedToolResult(backend, {
      taskId: created.id,
      runId: settled.runId as string,
      bytes: SEED_BYTES,
    });
    const rowBytes = () =>
      queryBackendScalar(backend, "SELECT length(data) AS n FROM run_events WHERE id = ?", [seeded.toolResultEventId]);
    expect(rowBytes(), "seeded row is the oversized payload").toBeGreaterThan(SEED_BYTES);

    // Only a task in Done can be archived.
    const doneRes = await request.patch(`${backend.apiBase}/tasks/${created.id}`, {
      headers: auth(backend),
      data: { column: "done" },
    });
    expect(doneRes.ok(), `PATCH column=done -> ${doneRes.status()}: ${await doneRes.text()}`).toBeTruthy();
    const archiveRes = await request.post(`${backend.apiBase}/tasks/${created.id}/archive`, { headers: auth(backend) });
    expect(archiveRes.ok(), `POST archive -> ${archiveRes.status()}: ${await archiveRes.text()}`).toBeTruthy();
    backdateArchivedAt(backend, created.id, 31 * DAY_MS);

    // The pass (default preference: 30 days) trims it.
    const passRes = await request.post(`${backend.apiBase}/db/retention/run`, { headers: auth(backend), timeout: 60_000 });
    expect(passRes.ok(), `POST /db/retention/run -> ${passRes.status()}: ${await passRes.text()}`).toBeTruthy();
    const pass = (await passRes.json()) as { trimmedRows: number; freedBytes: number; aborted: boolean };
    expect(pass.trimmedRows, "the pass trimmed at least the seeded row").toBeGreaterThanOrEqual(1);
    expect(pass.freedBytes).toBeGreaterThan(SEED_BYTES / 2);
    expect(pass.aborted).toBe(false);
    expect(rowBytes(), "the row shrank on disk").toBeLessThan(SEED_BYTES / 4);

    // Unarchive: the task comes back to life with a trimmed (but intact) row.
    const unarchiveRes = await request.post(`${backend.apiBase}/tasks/${created.id}/unarchive`, {
      headers: auth(backend),
    });
    expect(unarchiveRes.ok(), `POST unarchive -> ${unarchiveRes.status()}: ${await unarchiveRes.text()}`).toBeTruthy();

    await gotoApp(page, backend.bootBase);
    await page.locator(".cursor-grab").filter({ has: page.getByText(title, { exact: true }) }).click();
    const panel = page.locator("aside").last();
    // The paired tool card renders collapsed; expand it to reach the result.
    const toolCard = panel.getByRole("button", { name: /Bash/ }).first();
    await expect(toolCard).toBeVisible({ timeout: 15_000 });
    await toolCard.click();
    const trimmedNote = panel.getByTestId("tool-result-trimmed");
    await expect(trimmedNote).toBeVisible();
    await expect(trimmedNote).toContainText("trimmed by retention");
    await page.getByRole("button", { name: "Close task details" }).click();

    // Settings → General: the picker, the size line, Compact.
    const dialog = await openSettingsGeneral(page);
    const picker = dialog.getByTestId("settings-archived-history-retention");
    await expect(picker).toBeVisible();
    await expect(dialog.getByTestId("settings-db-stats")).toBeVisible();
    await picker.selectOption("90");
    await expect
      .poll(async () => (await getPreferences(request, backend)).archivedHistoryRetentionDays, {
        message: "retention preference persisted",
        timeout: 10_000,
      })
      .toBe("90");

    // Compact with nothing running: confirm, then the result line. The
    // blocking modal may be too brief to catch on a tiny database, so seeing
    // it is optional; the result is the contract.
    const sawCompacting = page
      .getByTestId("settings-db-compacting")
      .waitFor({ state: "attached", timeout: 10_000 })
      .then(
        () => true,
        () => false,
      );
    await dialog.getByTestId("settings-db-compact").click();
    await page.getByRole("button", { name: "Compact", exact: true }).click();
    await expect(dialog.getByTestId("settings-db-compact-result")).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByTestId("settings-db-compact-result")).toContainText("Compacted:");
    await expect(dialog.getByTestId("settings-db-compact-refused")).toHaveCount(0);
    await expect(dialog.getByTestId("settings-db-compact-error")).toHaveCount(0);
    console.log(`[archived-history-retention] compacting modal observed: ${await sawCompacting}`);
  });
});

test.describe("database compaction guard", () => {
  // Every fake spawn takes 15 s, so a started task stays "starting" (counted
  // by activeRunCount) long enough to drive the UI against it. This test's
  // own task never has to settle.
  test.use({ backendEnv: { ...PARKED_SCHEDULER_ENV, AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS: "15000" } });

  test("Compact is refused while a task is running", async ({ page, request, freshBackend }) => {
    test.setTimeout(90_000);
    const backend = freshBackend;

    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsGeneral(page);
    await expect(dialog.getByTestId("settings-db-compact")).toBeVisible();

    await createAndStart(request, backend, `compact-guard-${randomUUID()}`);

    await dialog.getByTestId("settings-db-compact").click();
    await page.getByRole("button", { name: "Compact", exact: true }).click();
    const refused = dialog.getByTestId("settings-db-compact-refused");
    await expect(refused).toBeVisible({ timeout: 15_000 });
    await expect(refused).toContainText("1 task running");
    await expect(dialog.getByTestId("settings-db-compact-result")).toHaveCount(0);
  });
});
