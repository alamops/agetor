import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type E2EBackend, type Locator, type Page } from "./fixtures";
import {
  bearerHeaders,
  createStackAccount,
  createStackViaApi,
  deleteAll,
  gotoApp,
  limitStateCount,
  listStacks,
  openSettingsGeneral,
  queryBackendScalar,
  removeLimitStates,
  seedHarnessUsage,
  seedLimitState,
  seedSwapEvents,
} from "./helpers";
import type { HarnessQuota } from "../src/shared/types.ts";

/**
 * Settings → Harnesses (TT10): stacks are merged into the Harnesses page (no
 * "Stacks" sidebar entry). Create a stack in the editor, see its ordered
 * members with positions and quota meters, reorder with a pre-existing backup
 * file so the mirror preview dialog gates the save, handle a stale edit, clear
 * account-wide vs per-model cooldowns, Restore, and read the swap History.
 *
 * Accounts are API-created aliases with homes under this worker's data dir
 * (a Claude account's config root is its home). The fake driver marker is a
 * literal copy of `FAKE_CLAUDE_LIMIT_PROMPT_MARKER` (e2e cannot import
 * `src/bun/*`).
 */

test.describe.configure({ mode: "serial" });

const LIMIT_MARKER = "__agetor_fake_claude_limit__";
const suffix = randomUUID().slice(0, 8);
const A = `e2e-set-a-${suffix}`;
const B = `e2e-set-b-${suffix}`;
const D = `e2e-set-d-${suffix}`;
const C = `e2e-set-c-${suffix}`; // stays in no stack
const E = `e2e-set-e-${suffix}`; // in the "other stack" used by the disabled-option test
const F = `e2e-set-f-${suffix}`;
const BIG = Array.from({ length: 11 }, (_, i) => `e2e-set-big-${i}-${suffix}`);
const TRAIN = `E2E train ${suffix}`;
const OTHER = `E2E other ${suffix}`;
const BIG_STACK = `E2E big ${suffix}`;

const createdStackIds: string[] = [];
const createdHarnessIds: string[] = [];
const createdTaskIds: string[] = [];
const roots = new Map<string, string>();

async function account(backend: E2EBackend, id: string): Promise<void> {
  roots.set(id, await createStackAccount(backend, id));
  createdHarnessIds.push(id);
}

async function openHarnesses(page: Page, backend: E2EBackend): Promise<Locator> {
  await gotoApp(page, backend.bootBase);
  const dialog = await openSettingsGeneral(page);
  await dialog.getByRole("button", { name: "Harnesses", exact: true }).click();
  await expect(dialog.getByTestId("harness-stacks-section")).toBeVisible();
  return dialog;
}

function card(dialog: Locator, label: string): Locator {
  return dialog.getByTestId("harness-stack-row").filter({ hasText: label });
}

/** One account row inside a stack card (the card's own `ul > li` members). */
function memberRow(stackCard: Locator, label: string): Locator {
  return stackCard.locator("ul > li").filter({ has: stackCard.page().getByText(label, { exact: true }) });
}

/** The confirm dialog for a destructive/clear action, found by its title. */
function confirmDialog(page: Page, title: string | RegExp): Locator {
  return page.getByRole("dialog").filter({ hasText: title }).last();
}

test.describe("settings → harnesses → stacks", () => {
  test.beforeAll(async ({ backend }) => {
    for (const id of [A, B, D, C, E, F, ...BIG]) await account(backend, id);
    // Quota snapshots must be in the DB before the page loads (`GET /usage` is
    // read once at mount). A is fresh, B is older than the 20-minute stale
    // line, D deliberately has none.
    const now = Date.now();
    const snapshot = (harnessId: string, fetchedAtMs: number): HarnessQuota => ({
      harnessId,
      kind: "claude-code",
      planType: "Pro",
      status: "ok",
      source: "api",
      fetchedAtMs,
      reason: null,
      meters: [
        { id: "five_hour", label: "5-hour", usedPercent: 40, resetsAtMs: now + 3_600_000 },
        { id: "seven_day", label: "Weekly", usedPercent: 70, resetsAtMs: now + 86_400_000 },
      ],
    });
    seedHarnessUsage(backend, snapshot(A, now));
    seedHarnessUsage(backend, snapshot(B, now - 30 * 60_000));
  });

  test.afterAll(async ({ backend }) => {
    removeLimitStates(backend, createdHarnessIds);
    await deleteAll(backend, [
      ...createdTaskIds.map((id) => `/tasks/${id}`),
      ...createdStackIds.map((id) => `/harness-stacks/${id}`),
      ...createdHarnessIds.map((id) => `/harnesses/${id}`),
    ]);
  });

  test("there is no Stacks sidebar entry and Harnesses carries the stack section", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsGeneral(page);
    await expect(dialog.getByRole("button", { name: "Stacks", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Harnesses", exact: true }).click();
    await expect(dialog.getByTestId("harness-stacks-section")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "New stack" })).toBeVisible();
  });

  test("create a stack: the card lists its members in order with positions", async ({ page, backend }) => {
    const dialog = await openHarnesses(page, backend);
    await dialog.getByRole("button", { name: "New stack" }).click();
    await expect(dialog.getByTestId("harness-stack-editor")).toBeVisible();
    await dialog.getByLabel("Name").fill(TRAIN);
    await dialog.getByRole("button", { name: "Claude Code" }).click();

    const picker = dialog.getByLabel("Add account");
    for (const id of [A, B, D]) {
      await picker.selectOption(id);
      await dialog.getByRole("button", { name: "Add", exact: true }).click();
    }
    await dialog.getByRole("button", { name: "Create stack" }).click();

    const stackCard = card(dialog, TRAIN);
    await expect(stackCard).toBeVisible();
    // Positions render in member order: primary first, then the backups.
    await expect(stackCard.getByTestId("harness-stack-position")).toHaveText(["1 Primary", "2 Backup", "3 Backup"]);
    await expect(memberRow(stackCard, A).getByTestId("harness-stack-chip")).toHaveText("1/3");
    await expect(memberRow(stackCard, D).getByTestId("harness-stack-chip")).toHaveText("3/3");

    const created = (await listStacks(backend)).find((s) => s.label === TRAIN);
    expect(created).toBeTruthy();
    createdStackIds.push(created!.id);
    expect(created!.members.map((m) => m.harnessId)).toEqual([A, B, D]);

    // The unstacked account is under "Other accounts", with no position.
    await expect(dialog.getByText("Other accounts")).toBeVisible();
    await expect(memberRow(stackCard, C)).toHaveCount(0);
  });

  test("each member shows a quota meter: fresh, stale, and none", async ({ page, backend }) => {
    const dialog = await openHarnesses(page, backend);
    const stackCard = card(dialog, TRAIN);
    await expect(stackCard).toBeVisible();

    const fresh = memberRow(stackCard, A).getByTestId("harness-quota-meter");
    await expect(fresh).toHaveAttribute("aria-label", "5-hour 40%, Weekly 70%");

    // Older than 20 minutes: dimmed and labelled stale (the failover ignores it too).
    const stale = memberRow(stackCard, B).getByTestId("harness-quota-meter");
    await expect(stale).toHaveAttribute("aria-label", "5-hour 40%, Weekly 70%, stale");
    await expect(stale).toContainText("stale");

    await expect(memberRow(stackCard, D).getByTestId("harness-quota-meter")).toHaveText("no quota data");
    // An account in no stack never gets a meter.
    const others = dialog.getByText(C, { exact: true }).locator("xpath=ancestor::div[contains(@class,'rounded-md')][1]");
    await expect(others.getByTestId("harness-quota-meter")).toHaveCount(0);
  });

  test("reorder over a backup's own file: preview dialog, Cancel saves nothing, Save and mirror writes", async ({ page, backend }) => {
    // Pre-existing files: B (about to become primary) and A (about to become a backup).
    writeFileSync(path.join(roots.get(B)!, "CLAUDE.md"), "B primary instructions\n");
    writeFileSync(path.join(roots.get(A)!, "CLAUDE.md"), "A own notes\n");

    const dialog = await openHarnesses(page, backend);
    await card(dialog, TRAIN).getByRole("button", { name: `Edit stack ${TRAIN}` }).click();
    await expect(dialog.getByTestId("harness-stack-editor")).toBeVisible();
    await dialog.getByRole("button", { name: `Move ${B} up` }).click();
    await dialog.getByRole("button", { name: "Save stack" }).click();

    const preview = page.getByTestId("mirror-preview-dialog");
    await expect(preview).toBeVisible();
    // Names only: the backup account, the file it loses, and the saved original.
    await expect(preview).toContainText(A);
    await expect(preview).toContainText("CLAUDE.md (overwritten)");
    await expect(preview).toContainText("Backed up first");

    // Cancel: nothing was written.
    await preview.getByRole("button", { name: "Cancel" }).click();
    await expect(preview).toHaveCount(0);
    expect(readFileSync(path.join(roots.get(A)!, "CLAUDE.md"), "utf8")).toBe("A own notes\n");
    expect((await listStacks(backend)).find((s) => s.label === TRAIN)!.members.map((m) => m.harnessId)).toEqual([A, B, D]);

    // Save again and confirm.
    await dialog.getByRole("button", { name: "Save stack" }).click();
    await expect(preview).toBeVisible();
    await preview.getByRole("button", { name: "Save and mirror" }).click();
    await expect(preview).toHaveCount(0);
    await expect(page.getByText("Stack updated", { exact: true })).toBeVisible();

    await expect
      .poll(async () => (await listStacks(backend)).find((s) => s.label === TRAIN)!.members.map((m) => m.harnessId))
      .toEqual([B, A, D]);
    // The primary's file replaced the backup's, and the original was saved first.
    expect(readFileSync(path.join(roots.get(A)!, "CLAUDE.md"), "utf8")).toBe("B primary instructions\n");
    const backup = path.join(backend.dataDir, "mirror-backups", A, "files", "CLAUDE.md");
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(backup, "utf8")).toBe("A own notes\n");
  });

  test("Restore appears only on accounts with mirror records, and puts the original back", async ({ page, backend }) => {
    const dialog = await openHarnesses(page, backend);
    const stackCard = card(dialog, TRAIN);
    await expect(stackCard).toBeVisible();

    const restoreOf = (id: string) => dialog.getByRole("button", { name: `Restore pre-stack config for ${id}` });
    await expect(restoreOf(A)).toBeVisible();
    // B is the primary (the mirror never wrote into it) and C was never in a stack.
    await expect(restoreOf(B)).toHaveCount(0);
    await expect(restoreOf(C)).toHaveCount(0);
    await expect(memberRow(stackCard, A).getByTestId("harness-mirror-restore")).toHaveCount(1);

    await restoreOf(A).click();
    const confirm = confirmDialog(page, `Restore pre-stack config on ${A}?`);
    // A is a current backup, so the dialog warns the next mirror re-applies.
    await expect(confirm).toContainText("the next mirror will re-apply");
    await confirm.getByRole("button", { name: "Restore", exact: true }).click();

    await expect(page.getByText("Pre-stack config restored")).toBeVisible();
    expect(readFileSync(path.join(roots.get(A)!, "CLAUDE.md"), "utf8")).toBe("A own notes\n");
  });

  test("a stack edited elsewhere gives the reload toast instead of overwriting", async ({ page, backend }) => {
    const dialog = await openHarnesses(page, backend);
    await card(dialog, TRAIN).getByRole("button", { name: `Edit stack ${TRAIN}` }).click();
    await expect(dialog.getByTestId("harness-stack-editor")).toBeVisible();
    await dialog.getByLabel("Name").fill("Local rename");

    // Another client renames the stack after this editor loaded it.
    const stack = (await listStacks(backend)).find((s) => s.label === TRAIN)!;
    const res = await fetch(`${backend.apiBase}/harness-stacks/${stack.id}`, {
      method: "PATCH",
      headers: bearerHeaders(backend),
      body: JSON.stringify({ label: `${TRAIN} (api)`, expectedUpdatedAt: stack.updatedAt }),
    });
    expect(res.status).toBe(200);

    await dialog.getByRole("button", { name: "Save stack" }).click();
    await expect(page.getByText("This stack changed elsewhere — reloaded")).toBeVisible();
    // The draft was replaced by the stored copy, and the local rename never landed.
    await expect(dialog.getByLabel("Name")).toHaveValue(`${TRAIN} (api)`);
    expect((await listStacks(backend)).some((s) => s.label === "Local rename")).toBe(false);
    // Put the name back for the tests below.
    const again = (await listStacks(backend)).find((s) => s.id === stack.id)!;
    const back = await fetch(`${backend.apiBase}/harness-stacks/${stack.id}`, {
      method: "PATCH",
      headers: bearerHeaders(backend),
      body: JSON.stringify({ label: TRAIN, expectedUpdatedAt: again.updatedAt }),
    });
    expect(back.status).toBe(200);
  });

  test("Clear on the account-wide chip clears only that row; a per-model chip clears only its model", async ({ page, backend }) => {
    const until = Date.now() + 6 * 3_600_000;
    seedLimitState(backend, { harnessId: A, untilMs: until, message: "Weekly limit reached" });
    seedLimitState(backend, { harnessId: A, untilMs: until + 60_000, model: "sonnet-4.6", message: "Sonnet cap hit" });
    expect(limitStateCount(backend, A)).toBe(2);

    const dialog = await openHarnesses(page, backend);
    const row = memberRow(card(dialog, TRAIN), A);
    const chips = row.getByTestId("harness-cooling-chip");
    await expect(chips).toHaveCount(2);
    // The provider's message is the chip's tooltip and plain text beside it.
    await expect(chips.nth(0)).toHaveAttribute("title", "Weekly limit reached");
    await expect(row.getByText("Weekly limit reached").first()).toBeVisible();
    await expect(chips.nth(1)).toContainText("for sonnet-4.6");

    await row.getByRole("button", { name: `Clear cooldown on ${A}`, exact: true }).click();
    const accountWide = confirmDialog(page, `Clear the account-wide cooldown on ${A}?`);
    await expect(accountWide).toBeVisible();
    await accountWide.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(chips).toHaveCount(1);
    expect(limitStateCount(backend, A, "")).toBe(0);
    expect(limitStateCount(backend, A, "sonnet-4.6")).toBe(1);

    await row.getByRole("button", { name: `Clear cooldown on ${A} for sonnet-4.6` }).click();
    const perModel = confirmDialog(page, `Clear the sonnet-4.6 cooldown on ${A}?`);
    await expect(perModel).toBeVisible();
    await perModel.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(chips).toHaveCount(0);
    expect(limitStateCount(backend, A)).toBe(0);
  });

  test("History lists a swap that really happened, and pages with Load more", async ({ page, request, backend }) => {
    const stack = (await listStacks(backend)).find((s) => s.label === TRAIN)!;
    const primary = stack.members[0]!.harnessId;
    const backup = stack.members[1]!.harnessId;
    const res = await request.post(`${backend.apiBase}/tasks`, {
      headers: bearerHeaders(backend),
      data: {
        title: `history ${suffix}`,
        prompt: `work ${LIMIT_MARKER}`,
        agent: primary,
        workdir: backend.dataDir,
        isolation: "none",
        model: "sonnet-4.6",
        effort: "high",
      },
    });
    expect(res.status()).toBe(200);
    const taskId = ((await res.json()) as { id: string }).id;
    createdTaskIds.push(taskId);
    expect((await request.post(`${backend.apiBase}/tasks/${taskId}/start`, { headers: bearerHeaders(backend) })).ok()).toBe(true);
    await expect
      .poll(() => queryBackendScalar(backend, "SELECT COUNT(*) AS n FROM harness_swap_events WHERE stack_id = ? AND trigger = 'limit'", [stack.id]), {
        timeout: 20_000,
      })
      .toBe(1);

    const dialog = await openHarnesses(page, backend);
    await card(dialog, TRAIN).getByRole("button", { name: `History of stack ${TRAIN}` }).click();
    const history = dialog.getByTestId("harness-stack-history");
    await expect(history).toBeVisible();
    await expect(history.locator("li")).toHaveCount(1);
    await expect(history).toContainText(`limit: ${primary} → ${backup}`);
    await expect(history).toContainText(`Task: history ${suffix}`);
    await expect(history.getByRole("button", { name: "Load more" })).toHaveCount(0);

    // 60 more rows: the first page is 50, Load more fetches the rest.
    seedSwapEvents(backend, { stackId: stack.id, count: 60, fromLabel: primary, toLabel: backup });
    await history.getByRole("button", { name: "Refresh history" }).click();
    await expect(history.locator("li")).toHaveCount(50);
    await history.getByRole("button", { name: "Load more" }).click();
    await expect(history.locator("li")).toHaveCount(61);
    await expect(history.getByRole("button", { name: "Load more" })).toHaveCount(0);

    removeLimitStates(backend, [primary, backup]);
  });

  test("an account already in another stack is listed disabled with the reason", async ({ page, backend }) => {
    const other = await createStackViaApi(backend, OTHER, "claude-code", [E, F]);
    createdStackIds.push(other.id);
    const dialog = await openHarnesses(page, backend);
    await dialog.getByRole("button", { name: "New stack" }).click();
    await expect(dialog.getByTestId("harness-stack-editor")).toBeVisible();

    const picker = dialog.getByLabel("Add account");
    const optionE = picker.locator(`option[value="${E}"]`);
    await expect(optionE).toBeDisabled();
    await expect(optionE).toHaveText(`${E} — in stack "${OTHER}"`);

    // Dirty the draft so Back exercises the discard guard.
    await dialog.getByLabel("Name").fill("Discard me");
    await dialog.getByRole("button", { name: "Back" }).click();
    await confirmDialog(page, "Discard unsaved changes?").getByRole("button", { name: "Discard" }).click();
    await expect(dialog.getByTestId("harness-stacks-section")).toBeVisible();
  });

  test("the editor excludes accounts of another harness kind", async ({ page, backend }) => {
    const dialog = await openHarnesses(page, backend);
    await dialog.getByRole("button", { name: "New stack" }).click();
    await expect(dialog.getByTestId("harness-stack-editor")).toBeVisible();
    await dialog.getByRole("button", { name: "Codex" }).click();

    // A, B and C are Claude accounts, so a Codex draft never offers them.
    const picker = dialog.getByLabel("Add account");
    for (const id of [A, B, C]) await expect(picker.locator("option", { hasText: id })).toHaveCount(0);
    await expect(picker.locator("option")).not.toHaveCount(0);

    await dialog.getByRole("button", { name: "Back" }).click();
    await confirmDialog(page, "Discard unsaved changes?").getByRole("button", { name: "Discard" }).click();
    await expect(dialog.getByTestId("harness-stacks-section")).toBeVisible();
  });

  test("more than ten members is saved with a visible warning", async ({ page, backend }) => {
    const big = await createStackViaApi(backend, BIG_STACK, "claude-code", BIG);
    createdStackIds.push(big.id);

    const dialog = await openHarnesses(page, backend);
    const bigCard = card(dialog, BIG_STACK);
    await expect(bigCard).toBeVisible();
    await expect(bigCard.getByText(/More than 10 accounts/)).toBeVisible();
    await bigCard.getByRole("button", { name: `Edit stack ${BIG_STACK}` }).click();
    await expect(dialog.getByTestId("stack-warnings")).toContainText("More than 10 accounts");
  });

  test("an account row's own Edit button is named for the account, not the stack", async ({ page, backend }) => {
    const dialog = await openHarnesses(page, backend);
    const stackCard = card(dialog, TRAIN);
    await expect(stackCard).toBeVisible();
    await expect(memberRow(stackCard, A).getByRole("button", { name: `Edit ${A}`, exact: true })).toBeVisible();
    await expect(stackCard.getByRole("button", { name: `Edit stack ${TRAIN}`, exact: true })).toBeVisible();
  });

  test("delete asks for confirmation (and says the history goes too), then removes the stack", async ({ page, backend }) => {
    const dialog = await openHarnesses(page, backend);
    await card(dialog, TRAIN).getByRole("button", { name: `Delete stack ${TRAIN}` }).click();
    const confirm = confirmDialog(page, `Delete stack "${TRAIN}"?`);
    await expect(confirm).toContainText("account-switch history is deleted too");
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(card(dialog, TRAIN)).toHaveCount(0);

    expect((await listStacks(backend)).some((s) => s.label === TRAIN)).toBe(false);
    // The swap history went with the stack.
    expect(queryBackendScalar(backend, "SELECT COUNT(*) AS n FROM harness_swap_events WHERE stack_id = ?", [createdStackIds[0]!])).toBe(0);
  });
});
