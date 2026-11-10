import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * Settings → Stacks (TT8): create a stack in the UI, see the primary/backup
 * order, reorder it, edit it, see the >10 warning, exclude another harness
 * kind, and delete it. The accounts are API-created aliases with homes under
 * this worker's data dir.
 */

test.describe.configure({ mode: "serial" });

const suffix = randomUUID().slice(0, 8);
const A = `e2e-stacks-a-${suffix}`;
const B = `e2e-stacks-b-${suffix}`;
const BIG = Array.from({ length: 11 }, (_, i) => `e2e-stacks-big-${i}-${suffix}`);
const createdStackIds: string[] = [];
const createdHarnessIds: string[] = [];

function auth(backend: E2EBackend): Record<string, string> {
  return { authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" };
}

async function createAccount(backend: E2EBackend, id: string): Promise<void> {
  const home = path.join(backend.dataDir, "harnesses", id);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, ".credentials.json"), "{}");
  const res = await fetch(`${backend.apiBase}/harnesses`, {
    method: "POST",
    headers: auth(backend),
    body: JSON.stringify({ id, kind: "claude-code", label: id, home }),
  });
  if (!res.ok) throw new Error(`POST /harnesses -> ${res.status}: ${await res.text()}`);
  createdHarnessIds.push(id);
}

async function createStack(
  backend: E2EBackend,
  label: string,
  members: string[],
): Promise<{ id: string; members: Array<{ harnessId: string }> }> {
  const res = await fetch(`${backend.apiBase}/harness-stacks`, {
    method: "POST",
    headers: auth(backend),
    body: JSON.stringify({ label, kind: "claude-code", members, mirrorMode: "safe" }),
  });
  if (!res.ok) throw new Error(`POST /harness-stacks -> ${res.status}: ${await res.text()}`);
  const stack = await res.json() as { id: string; members: Array<{ harnessId: string }> };
  createdStackIds.push(stack.id);
  return stack;
}

async function openSettingsStacks(page: Page, backend: E2EBackend): Promise<Locator> {
  await gotoApp(page, backend.bootBase);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  await dialog.getByRole("button", { name: "Stacks", exact: true }).click();
  return dialog;
}

test.describe("settings stacks", () => {
  test.beforeAll(async ({ backend }) => {
    await createAccount(backend, A);
    await createAccount(backend, B);
  });

  test.afterAll(async ({ backend }) => {
    for (const id of createdStackIds) {
      await fetch(`${backend.apiBase}/harness-stacks/${id}`, {
        method: "DELETE",
        headers: auth(backend),
      }).catch(() => {});
    }
    for (const id of createdHarnessIds) {
      await fetch(`${backend.apiBase}/harnesses/${id}`, { method: "DELETE", headers: auth(backend) }).catch(() => {});
    }
  });

  test("create, reorder and show the chip", async ({ page, backend }) => {
    const dialog = await openSettingsStacks(page, backend);
    await expect(dialog.getByTestId("harness-stacks-section")).toBeVisible();
    await dialog.getByRole("button", { name: "New stack" }).click();

    await expect(dialog.getByTestId("harness-stack-editor")).toBeVisible();
    await dialog.getByLabel("Name").fill("E2E train");
    await dialog.getByRole("button", { name: "Claude Code" }).click();

    const picker = dialog.getByLabel("Add account");
    await picker.selectOption(A);
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await picker.selectOption(B);
    await dialog.getByRole("button", { name: "Add", exact: true }).click();

    // Primary is first; move B up so it becomes the primary.
    await dialog.getByRole("button", { name: `Move ${B} up` }).click();
    await dialog.getByRole("button", { name: "Create stack" }).click();

    await expect(dialog.getByTestId("harness-stack-row").filter({ hasText: "E2E train" })).toBeVisible();
    const stacksPayload = await (await fetch(`${backend.apiBase}/harness-stacks`, { headers: auth(backend) })).json() as {
      stacks: Array<{ id: string; label: string; members: Array<{ harnessId: string }> }>;
    };
    const created = stacksPayload.stacks.find((s) => s.label === "E2E train");
    expect(created).toBeTruthy();
    createdStackIds.push(created!.id);
    // The reorder is persisted, not just painted: B moved above A.
    expect(created!.members.map((m) => m.harnessId)).toEqual([B, A]);
    // Harnesses section carries the position chip for both accounts.
    await dialog.getByRole("button", { name: "Harnesses", exact: true }).click();
    await expect(dialog.getByTestId("harness-stack-chip").first()).toBeVisible();
  });

  test("edit renames the stack and persists a new primary", async ({ page, backend }) => {
    const dialog = await openSettingsStacks(page, backend);
    const row = dialog.getByTestId("harness-stack-row").filter({ hasText: "E2E train" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Edit" }).click();

    await expect(dialog.getByTestId("harness-stack-editor")).toBeVisible();
    await dialog.getByLabel("Name").fill("E2E train renamed");
    // Move A above B so A is the primary again.
    await dialog.getByRole("button", { name: `Move ${A} up` }).click();
    await dialog.getByRole("button", { name: "Save stack" }).click();

    await expect(dialog.getByTestId("harness-stack-row").filter({ hasText: "E2E train renamed" })).toBeVisible();
    const stacksPayload = await (await fetch(`${backend.apiBase}/harness-stacks`, { headers: auth(backend) })).json() as {
      stacks: Array<{ id: string; label: string; members: Array<{ harnessId: string }> }>;
    };
    const edited = stacksPayload.stacks.find((s) => s.label === "E2E train renamed");
    expect(edited).toBeTruthy();
    expect(edited!.members.map((m) => m.harnessId)).toEqual([A, B]);
  });

  test("an account already in another stack is listed disabled with the reason (R18)", async ({ page, backend }) => {
    const dialog = await openSettingsStacks(page, backend);
    await dialog.getByRole("button", { name: "New stack" }).click();
    await expect(dialog.getByTestId("harness-stack-editor")).toBeVisible();

    // A and B are members of "E2E train renamed". The picker used to hide
    // them, which read as "the account does not exist"; the round-18 fix lists
    // them disabled with the owning stack named.
    const picker = dialog.getByLabel("Add account");
    const optionA = picker.locator(`option[value="${A}"]`);
    const optionB = picker.locator(`option[value="${B}"]`);
    await expect(optionA).toBeDisabled();
    await expect(optionB).toBeDisabled();
    await expect(optionA).toHaveText(`${A} — in stack "E2E train renamed"`);
    await expect(optionB).toHaveText(`${B} — in stack "E2E train renamed"`);

    // Dirty the draft so Back exercises the discard guard (the same path a
    // user takes after typing a name).
    await dialog.getByLabel("Name").fill("Discard me");
    await dialog.getByRole("button", { name: "Back" }).click();
    const confirm = page.getByRole("dialog").filter({ hasText: "Discard unsaved changes?" });
    await confirm.getByRole("button", { name: "Discard" }).click();
    await expect(dialog.getByTestId("harness-stacks-section")).toBeVisible();
  });

  test("the editor excludes accounts of another harness kind", async ({ page, backend }) => {
    const dialog = await openSettingsStacks(page, backend);
    await dialog.getByRole("button", { name: "New stack" }).click();
    await expect(dialog.getByTestId("harness-stack-editor")).toBeVisible();
    await dialog.getByRole("button", { name: "Codex" }).click();

    // A and B are Claude accounts, so a Codex draft never offers them. The
    // worker's built-in Codex account may still be offered.
    const picker = dialog.getByLabel("Add account");
    await expect(picker.locator("option", { hasText: A })).toHaveCount(0);
    await expect(picker.locator("option", { hasText: B })).toHaveCount(0);
    await expect(picker.locator("option")).not.toHaveCount(0);

    // Leave without saving: the dirty guard asks first.
    await dialog.getByRole("button", { name: "Back" }).click();
    const confirm = page.getByRole("dialog").filter({ hasText: "Discard unsaved changes?" });
    await confirm.getByRole("button", { name: "Discard" }).click();
    await expect(dialog.getByTestId("harness-stacks-section")).toBeVisible();
  });

  test("more than ten members is saved with a visible warning", async ({ page, backend }) => {
    for (const id of BIG) await createAccount(backend, id);
    await createStack(backend, "E2E big train", BIG);

    const dialog = await openSettingsStacks(page, backend);
    const row = dialog.getByTestId("harness-stack-row").filter({ hasText: "E2E big train" });
    await expect(row).toBeVisible();
    await expect(row.getByText(/More than 10 accounts/)).toBeVisible();
    // The editor shows the same non-blocking warning and still saves.
    await row.getByRole("button", { name: "Edit" }).click();
    await expect(dialog.getByTestId("stack-warnings")).toContainText("More than 10 accounts");
  });

  test("delete removes the stack", async ({ page, backend }) => {
    const dialog = await openSettingsStacks(page, backend);
    const row = dialog.getByTestId("harness-stack-row").filter({ hasText: "E2E train renamed" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Delete stack E2E train renamed" }).click();
    const confirm = page.getByRole("dialog").filter({ hasText: 'Delete stack "E2E train renamed"?' });
    await confirm.getByRole("button", { name: "Confirm" }).click();
    await expect(dialog.getByTestId("harness-stack-row").filter({ hasText: "E2E train renamed" })).toHaveCount(0);

    const stacksPayload = await (await fetch(`${backend.apiBase}/harness-stacks`, { headers: auth(backend) })).json() as {
      stacks: Array<{ label: string }>;
    };
    expect(stacksPayload.stacks.some((s) => s.label === "E2E train renamed")).toBe(false);
  });
});
