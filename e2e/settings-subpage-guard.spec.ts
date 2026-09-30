import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for the dirty-leave guard on the Settings → Harnesses editor
 * subpage (docs/plans/agents-new-edit-subpage.md §3 — the harness editor was
 * swept into the same "Discard unsaved changes?" confirm the Agents editor
 * got; the Agents half lives in `e2e/agent-profiles-settings.spec.ts`).
 *
 * Every way out of the harness editor — the header Back button, Escape, a
 * backdrop click, a sidebar section click and the header X — routes through
 * `SettingsDialog`'s single `leaveSubpage` guard, which confirms only when a
 * form subpage (`editor` / `agent-editor`) reported dirty. The editor's own
 * Cancel bypasses it. The template picker ("Add harness" step 1) holds no
 * draft and never confirms. Dirty = any of the six editor fields differing
 * from what it was seeded with (`harnessEditorDirty`); this spec dirties the
 * Label field.
 *
 * Nothing here ever saves: the Add-harness flow stops at the editor page and
 * is left via Back/Cancel/Discard, and the one Edit scenario edits a
 * throwaway harness created over REST (built-in harness rows have no Edit
 * button — `!h.isBuiltin` gates it) and deletes it in `afterAll`, so no
 * persistent state is mutated. One serial `describe` sharing the worker
 * backend (`e2e/fixtures.ts`).
 *
 * Locator note: while the confirm is open TWO `role="dialog"` elements exist
 * (`Dialog` puts the role on the full-screen backdrop). Bare
 * `getByRole("dialog")` is ambiguous then, so the Settings modal is located by
 * its own title id and the confirm by its accessible name.
 */

test.describe.configure({ mode: "serial" });

const CONVERGE_TIMEOUT = 20_000;

// Throwaway harness for the Edit scenario, torn down in `afterAll`.
let editHarnessId = "";
let editHarnessLabel = "";

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

// ---- Locator helpers ----

/** The Settings modal, located by its title id (see the file comment). */
function settingsModal(page: Page): Locator {
  return page.getByRole("dialog").filter({ has: page.locator("#settings-dialog-title") });
}

/** The shared confirm dialog (`ui/confirm.tsx`) the dirty-leave guard raises. */
function discardConfirm(page: Page): Locator {
  return page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
}

/** Click the dimmed backdrop (the `role="dialog"` overlay's own padding,
 *  outside the panel) — the panel stops propagation, the overlay routes the
 *  click to `onClose`. */
async function clickBackdrop(modal: Locator): Promise<void> {
  await modal.click({ position: { x: 4, y: 4 } });
}

/** Opens Settings and switches to the Harnesses section. */
async function openSettingsHarnesses(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const modal = settingsModal(page);
  await expect(modal.getByRole("heading", { name: "Settings" })).toBeVisible();
  await modal.getByRole("button", { name: "Harnesses", exact: true }).click();
  await expectHarnessesList(modal);
  return modal;
}

/** Asserts the modal is on the plain Harnesses list (section view). */
async function expectHarnessesList(modal: Locator): Promise<void> {
  await expect(modal.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(modal.getByRole("button", { name: "Harnesses", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(modal.getByRole("button", { name: "Add harness", exact: true })).toBeVisible({
    timeout: CONVERGE_TIMEOUT,
  });
  await expect(modal.getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
}

/** Harnesses → Add harness → first template → the (untouched) editor page. */
async function openAddHarnessEditor(page: Page): Promise<{ modal: Locator; labelInput: Locator }> {
  const modal = await openSettingsHarnesses(page);
  const addButton = modal.getByRole("button", { name: "Add harness", exact: true });
  await expect(addButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
  await addButton.click();
  // The template button's accessible name includes its description, so match
  // on the label text (same approach as `e2e/identifier-inputs.spec.ts`).
  const templateButton = modal.getByRole("button").filter({ hasText: "Additional Claude Code" });
  await expect(templateButton).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await templateButton.click();
  const labelInput = modal.getByPlaceholder("Claude (work)");
  await expect(labelInput).toBeVisible({ timeout: CONVERGE_TIMEOUT });
  await expect(modal.getByRole("heading", { name: "Add harness" })).toBeVisible();
  return { modal, labelInput };
}

/** The harness row's "Edit" button, found via the row's label text (rows have
 *  no test id) — the nearest bordered `rounded-md` ancestor is the row. */
function harnessRowEdit(modal: Locator, label: string): Locator {
  return modal
    .getByText(label, { exact: true })
    .locator("xpath=ancestor::div[contains(@class,'rounded-md') and contains(@class,'border')][1]")
    .getByRole("button", { name: "Edit", exact: true });
}

test.describe("Settings → Harnesses editor — dirty-leave guard", () => {
  test("Reopening Settings after closing from the clean harness editor starts on General with no editor mounted", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const { modal, labelInput } = await openAddHarnessEditor(page);
    await expect(labelInput).toBeVisible();

    // Clean editor: the header X closes the whole modal with no confirm.
    await modal.getByRole("button", { name: "Close", exact: true }).click();
    await expect(discardConfirm(page)).toHaveCount(0);
    await expect(modal).toBeHidden();

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(modal.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(modal.getByRole("button", { name: "General", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(modal.getByRole("heading", { name: "Add harness" })).toHaveCount(0);
    await expect(modal.getByPlaceholder("Claude (work)")).toHaveCount(0);
    await expect(modal.getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
  });

  test("Clean editor: Back, Escape and backdrop pop to the Harnesses list with no confirm (the template picker never confirms either)", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const { modal } = await openAddHarnessEditor(page);
    // Sanity: on the editor subpage — Back shown, list hidden.
    await expect(modal.getByRole("button", { name: "Back", exact: true })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Harnesses", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );

    // Back.
    await modal.getByRole("button", { name: "Back", exact: true }).click();
    await expectHarnessesList(modal);
    await expect(discardConfirm(page)).toHaveCount(0);

    // Escape pops (not closes) — no confirm.
    await modal.getByRole("button", { name: "Add harness", exact: true }).click();
    await modal.getByRole("button").filter({ hasText: "Additional Claude Code" }).click();
    await expect(modal.getByPlaceholder("Claude (work)")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await page.keyboard.press("Escape");
    await expectHarnessesList(modal);
    await expect(discardConfirm(page)).toHaveCount(0);
    await expect(modal).toBeVisible();

    // Backdrop click pops — no confirm.
    await modal.getByRole("button", { name: "Add harness", exact: true }).click();
    await modal.getByRole("button").filter({ hasText: "Additional Claude Code" }).click();
    await expect(modal.getByPlaceholder("Claude (work)")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await clickBackdrop(modal);
    await expectHarnessesList(modal);
    await expect(discardConfirm(page)).toHaveCount(0);
    await expect(modal).toBeVisible();

    // The template picker (step 1) holds no draft: Back, Escape and a sidebar
    // click all leave it without asking.
    await modal.getByRole("button", { name: "Add harness", exact: true }).click();
    await expect(modal.getByRole("button").filter({ hasText: "Additional Claude Code" })).toBeVisible({
      timeout: CONVERGE_TIMEOUT,
    });
    await modal.getByRole("button", { name: "Back", exact: true }).click();
    await expectHarnessesList(modal);
    await modal.getByRole("button", { name: "Add harness", exact: true }).click();
    await expect(modal.getByRole("button").filter({ hasText: "Additional Claude Code" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expectHarnessesList(modal);
    await modal.getByRole("button", { name: "Add harness", exact: true }).click();
    await expect(modal.getByRole("button").filter({ hasText: "Additional Claude Code" })).toBeVisible();
    await modal.getByRole("button", { name: "General", exact: true }).click();
    await expect(modal.getByRole("button", { name: "General", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(discardConfirm(page)).toHaveCount(0);
  });

  test("Dirty Back confirms: decline keeps the typed Label, accept pops to the list", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const { modal, labelInput } = await openAddHarnessEditor(page);
    const typed = `Guard Label ${randomUUID().slice(0, 8)}`;
    await labelInput.fill(typed);

    await modal.getByRole("button", { name: "Back", exact: true }).click();
    const confirm = discardConfirm(page);
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("Your edits to this harness will be lost.");
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(modal.getByRole("heading", { name: "Add harness" })).toBeVisible();
    await expect(labelInput).toHaveValue(typed);

    await modal.getByRole("button", { name: "Back", exact: true }).click();
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expectHarnessesList(modal);
  });

  test("Dirty Escape confirms: Escape on the confirm declines, accept pops (does not close)", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const { modal, labelInput } = await openAddHarnessEditor(page);
    const typed = `Guard Escape ${randomUUID().slice(0, 8)}`;
    await labelInput.fill(typed);

    await page.keyboard.press("Escape");
    const confirm = discardConfirm(page);
    await expect(confirm).toBeVisible();
    // Escape with the confirm on top closes only the confirm (= decline).
    await page.keyboard.press("Escape");
    await expect(confirm).toBeHidden();
    await expect(modal.getByRole("heading", { name: "Add harness" })).toBeVisible();
    await expect(labelInput).toHaveValue(typed);

    await page.keyboard.press("Escape");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expectHarnessesList(modal);
    await expect(modal).toBeVisible();
  });

  test("Dirty backdrop click confirms: decline keeps the typed Label, accept pops", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const { modal, labelInput } = await openAddHarnessEditor(page);
    const typed = `Guard Backdrop ${randomUUID().slice(0, 8)}`;
    await labelInput.fill(typed);

    await clickBackdrop(modal);
    const confirm = discardConfirm(page);
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(labelInput).toHaveValue(typed);

    await clickBackdrop(modal);
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expectHarnessesList(modal);
    await expect(modal).toBeVisible();
  });

  test("Dirty sidebar click confirms: decline keeps the typed Label, accept navigates to that section", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const { modal, labelInput } = await openAddHarnessEditor(page);
    const typed = `Guard Sidebar ${randomUUID().slice(0, 8)}`;
    await labelInput.fill(typed);

    await modal.getByRole("button", { name: "General", exact: true }).click();
    const confirm = discardConfirm(page);
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(modal.getByRole("heading", { name: "Add harness" })).toBeVisible();
    await expect(labelInput).toHaveValue(typed);
    await expect(modal.getByRole("button", { name: "Harnesses", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await modal.getByRole("button", { name: "General", exact: true }).click();
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(modal.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(modal.getByRole("button", { name: "General", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(modal.getByPlaceholder("Claude (work)")).toHaveCount(0);
  });

  test("Dirty header X confirms: decline keeps the typed Label, accept closes the whole modal", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const { modal, labelInput } = await openAddHarnessEditor(page);
    const typed = `Guard Close ${randomUUID().slice(0, 8)}`;
    await labelInput.fill(typed);

    await modal.getByRole("button", { name: "Close", exact: true }).click();
    const confirm = discardConfirm(page);
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(modal).toBeVisible();
    await expect(labelInput).toHaveValue(typed);

    await modal.getByRole("button", { name: "Close", exact: true }).click();
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(modal).toBeHidden();
  });

  test("Cancel never confirms — even on a dirty editor", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const { modal, labelInput } = await openAddHarnessEditor(page);
    await labelInput.fill(`Guard Cancel ${randomUUID().slice(0, 8)}`);

    await modal.getByRole("button", { name: "Cancel", exact: true }).click();
    await expectHarnessesList(modal);
    await expect(discardConfirm(page)).toHaveCount(0);
    await expect(modal).toBeVisible();
  });

  test("Edit harness (throwaway, never saved): clean Back pops; dirty Back confirms, decline keeps the typed Label, accept leaves the stored harness untouched", async ({
    page,
    request,
    backend,
  }) => {
    // Built-in rows have no Edit button, so edit a throwaway harness made
    // over REST (deleted in afterAll). It is never saved through the editor.
    const homeDir = await mkdtemp(path.join(tmpdir(), "agetor-e2e-settings-subpage-guard-"));
    editHarnessId = `guard-edit-${randomUUID().slice(0, 8)}`;
    editHarnessLabel = `Guard Edit ${randomUUID().slice(0, 8)}`;
    const res = await request.post(`${backend.apiBase}/harnesses`, {
      headers: auth(backend),
      data: { id: editHarnessId, kind: "claude-code", label: editHarnessLabel, home: homeDir },
    });
    expect(res.ok(), `POST /harnesses -> ${res.status()}: ${await res.text()}`).toBeTruthy();

    await gotoApp(page, backend.bootBase);
    const modal = await openSettingsHarnesses(page);

    // Clean Edit → Back: no confirm.
    await harnessRowEdit(modal, editHarnessLabel).click();
    await expect(modal.getByRole("heading", { name: "Edit harness" })).toBeVisible();
    const labelInput = modal.getByPlaceholder("Claude (work)");
    await expect(labelInput).toHaveValue(editHarnessLabel);
    await modal.getByRole("button", { name: "Back", exact: true }).click();
    await expectHarnessesList(modal);
    await expect(discardConfirm(page)).toHaveCount(0);

    // Dirty Edit → Back: decline keeps the typed value, accept leaves.
    await harnessRowEdit(modal, editHarnessLabel).click();
    await expect(modal.getByRole("heading", { name: "Edit harness" })).toBeVisible();
    const typed = `${editHarnessLabel} renamed`;
    await labelInput.fill(typed);
    await modal.getByRole("button", { name: "Back", exact: true }).click();
    const confirm = discardConfirm(page);
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(modal.getByRole("heading", { name: "Edit harness" })).toBeVisible();
    await expect(labelInput).toHaveValue(typed);

    await modal.getByRole("button", { name: "Back", exact: true }).click();
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expectHarnessesList(modal);

    // Nothing was saved: the row still carries the original label, and the
    // server agrees.
    await expect(modal.getByText(editHarnessLabel, { exact: true })).toBeVisible();
    const listRes = await request.get(`${backend.apiBase}/harnesses`, { headers: auth(backend) });
    expect(listRes.ok(), `GET /harnesses -> ${listRes.status()}`).toBeTruthy();
    const body = (await listRes.json()) as { harnesses?: { id: string; label: string }[] } | { id: string; label: string }[];
    const harnesses = Array.isArray(body) ? body : (body.harnesses ?? []);
    expect(harnesses.find((h) => h.id === editHarnessId)?.label).toBe(editHarnessLabel);
  });
});

test.afterAll(async ({ backend }) => {
  // Best-effort cleanup of the throwaway harness — raw `fetch` (the `request`
  // fixture is test-scoped), never blocks teardown.
  if (editHarnessId) {
    await fetch(`${backend.apiBase}/harnesses/${editHarnessId}`, {
      method: "DELETE",
      headers: auth(backend),
    }).catch(() => {});
  }
});
