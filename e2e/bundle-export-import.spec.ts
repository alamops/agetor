import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";
import { DEFAULT_MODEL } from "../src/shared/types.ts";

/**
 * E2e coverage for exporting and importing Agents and Pipelines as an agetor
 * bundle (docs/plans/agents-pipelines-import-export.md TT-D): export from
 * Settings → Agents and the Pipelines page (Save to Downloads via the
 * `AGETOR_DOWNLOADS_DIR` seam = `backend.downloadsDir`, Copy JSON, Choose
 * folder via the fake-pick seam), multi-select and Export all, and import by
 * Paste, Choose file (fake-pick seam) and drag (a synthetic `drop` whose
 * `DataTransfer` carries a real `File`), with the preview's harness
 * fallback, enable-harness switch, unknown-kind re-bind, name edit/clash,
 * legacy badge and parse errors.
 *
 * Serial, on the worker-shared backend: every test starts from a wiped slate
 * (all Agents and Pipelines deleted over REST, extra harnesses removed, the
 * built-in codex harness back to its shipped disabled state) and `afterAll`
 * wipes again and restores codex, so nothing leaks into other spec files'
 * absolute counts. Only synthetic harness ids appear here.
 */

test.describe.configure({ mode: "serial" });

const CONVERGE_TIMEOUT = 20_000;

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function rest<T>(
  request: APIRequestContext,
  backend: E2EBackend,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  p: string,
  body?: unknown,
): Promise<T> {
  const res = await request.fetch(`${backend.apiBase}${p}`, {
    method,
    headers: { ...auth(backend), "content-type": "application/json" },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(res.ok(), `${method} ${p} → ${res.status()} ${await res.text()}`).toBeTruthy();
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

interface ProfileRow { id: string; name: string; harness: string; model: string; effort: string | null }
interface PipelineRow { id: string; name: string; graph: { steps: { agentProfileId: string | null }[] } }
interface HarnessRow { id: string; kind: string; enabled: boolean; isBuiltin: boolean }

async function wipe(request: APIRequestContext, backend: E2EBackend): Promise<void> {
  for (const p of await rest<PipelineRow[]>(request, backend, "GET", "/pipelines")) {
    await rest(request, backend, "DELETE", `/pipelines/${p.id}`);
  }
  for (const p of await rest<ProfileRow[]>(request, backend, "GET", "/agent-profiles")) {
    await rest(request, backend, "DELETE", `/agent-profiles/${p.id}`);
  }
  const { harnesses } = await rest<{ harnesses: HarnessRow[] }>(request, backend, "GET", "/harnesses");
  for (const h of harnesses) {
    if (!h.isBuiltin) await rest(request, backend, "DELETE", `/harnesses/${h.id}`);
  }
  await rest(request, backend, "PATCH", "/harnesses/codex", { enabled: false });
}

async function createSecondaryHarness(request: APIRequestContext, backend: E2EBackend): Promise<void> {
  await rest(request, backend, "POST", "/harnesses", {
    id: "secondary-claude-code",
    kind: "claude-code",
    label: "Claude Code (secondary)",
  });
}

async function createProfile(
  request: APIRequestContext,
  backend: E2EBackend,
  name: string,
  harness = "claude-code",
): Promise<ProfileRow> {
  return rest<ProfileRow>(request, backend, "POST", "/agent-profiles", {
    name,
    harness,
    model: "opus-5.5",
    effort: "high",
    instructions: `Instructions for ${name}.`,
  });
}

async function createPipeline(
  request: APIRequestContext,
  backend: E2EBackend,
  name: string,
  stepProfileId: string,
  delegateProfileId: string,
): Promise<PipelineRow> {
  return rest<PipelineRow>(request, backend, "POST", "/pipelines", {
    name,
    graph: {
      steps: [
        {
          id: "s1",
          name: "Plan",
          instructions: "Plan the work.",
          agentProfileId: stepProfileId,
          position: { x: 0, y: 0 },
          subagents: { profileIds: [delegateProfileId], cap: null },
        },
        {
          id: "s2",
          name: "Build",
          instructions: "",
          agentProfileId: delegateProfileId,
          position: { x: 240, y: 0 },
          subagents: { profileIds: [], cap: null },
        },
      ],
      edges: [{ id: "e1", from: "s1", to: "s2", label: "" }],
      startStepId: "s1",
    },
  });
}

/** A one-Agent bundle whose harness isn't on this machine. */
function bundleText(agent: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      format: "agetor-bundle",
      version: 1,
      exportedAt: "2026-10-01T00:00:00.000Z",
      agetorVersion: "1.0.0",
      agents: [
        {
          key: "remote-worker",
          name: "Remote Worker",
          harness: { id: "secondary-claude-code", kind: "claude-code", label: "Claude Code (secondary)" },
          model: "opus-5.5",
          effort: "high",
          mode: null,
          fast: false,
          maxMode: false,
          instructions: "Work carefully.",
          skills: [],
          ...agent,
        },
      ],
      pipelines: [],
      ...extra,
    },
    null,
    2,
  );
}

async function openSettingsAgents(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog").filter({ has: page.locator("#settings-dialog-title") });
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  await dialog.getByRole("button", { name: "Agents", exact: true }).click();
  const section = dialog.getByTestId("agent-profiles-section");
  await expect(section).toBeVisible();
  return section;
}

async function openSettingsPipelines(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog").filter({ has: page.locator("#settings-dialog-title") });
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  await dialog.getByRole("button", { name: "Pipelines", exact: true }).click();
  const section = dialog.getByTestId("pipelines-section");
  await expect(section).toBeVisible();
  return section;
}

function agentRow(section: Locator, name: string): Locator {
  return section.locator('[data-testid="agent-profile-row"]').filter({ hasText: name });
}

async function openPipelinesPage(page: Page): Promise<Locator> {
  await page.getByTestId("pipelines-button").click();
  const pageRoot = page.getByTestId("pipelines-page");
  await expect(pageRoot).toBeVisible();
  return pageRoot;
}

function importDialog(page: Page): Locator {
  return page.getByTestId("bundle-import-dialog");
}

function exportDialog(page: Page): Locator {
  return page.getByTestId("bundle-export-dialog");
}

/** Open the import dialog from `list`, paste `text` and preview it. */
async function pasteAndPreview(page: Page, list: Locator, text: string): Promise<Locator> {
  await list.getByTestId("bundle-import-open").click();
  const dialog = importDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("bundle-import-paste").fill(text);
  await dialog.getByTestId("bundle-import-paste-preview").click();
  return dialog;
}

async function readJson(file: string): Promise<{
  format: string;
  agents: { key: string; name: string; harness: unknown }[];
  pipelines: { name: string; graph: { steps: { agent: string | null; subagents: { agents: string[] } }[] } }[];
}> {
  return JSON.parse(await readFile(file, "utf8"));
}

/** Dispatch a synthetic file drag + drop of `text` (as `name`) on `target`. */
async function dropFile(page: Page, target: Locator, text: string, name = "dropped.agetor.json"): Promise<void> {
  const dt = await page.evaluateHandle(
    ([content, fileName]) => {
      const d = new DataTransfer();
      d.items.add(new File([content], fileName, { type: "application/json" }));
      return d;
    },
    [text, name] as const,
  );
  await target.dispatchEvent("dragover", { dataTransfer: dt });
  await target.dispatchEvent("drop", { dataTransfer: dt });
}

/**
 * Before a negative check after a drop: give a (regressed) drop handler the
 * time it would need to act. The handler reads the file with the async
 * `File.text()` and React then commits, so wait past an equal read, two
 * frames and a short timeout — otherwise "nothing opened" passes before a
 * wrong handler ever ran.
 */
async function settleDrop(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new File(["{}"], "settle.json").text();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 300));
  });
}

/** Hold every request whose path is `pathname` until `release()` runs. */
async function holdRequests(page: Page, pathname: string): Promise<{ release: () => void; seen: () => number }> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let count = 0;
  await page.route(
    (url) => url.pathname === pathname,
    async (route) => {
      count++;
      await gate;
      await route.continue();
    },
  );
  return { release, seen: () => count };
}

let codexInitiallyEnabled = false;

test.beforeAll(async ({ request, backend }) => {
  const { harnesses } = await rest<{ harnesses: HarnessRow[] }>(request, backend, "GET", "/harnesses");
  codexInitiallyEnabled = harnesses.find((h) => h.id === "codex")?.enabled ?? false;
});

test.beforeEach(async ({ request, backend }) => {
  await wipe(request, backend);
  await backend.plantPicks({});
});

test.afterAll(async ({ request, backend }) => {
  await wipe(request, backend);
  await rest(request, backend, "PATCH", "/harnesses/codex", { enabled: codexInitiallyEnabled });
  await backend.plantPicks({});
});

test.describe("bundle export / import", () => {
  test("(1) row Export → Save to Downloads writes the bundle with the harness id, kind and label; again writes (2)", async ({
    page,
    request,
    backend,
  }) => {
    await createSecondaryHarness(request, backend);
    await createProfile(request, backend, "Secondary Worker", "secondary-claude-code");

    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    await agentRow(section, "Secondary Worker").getByTestId("bundle-row-export").click();
    const dialog = exportDialog(page);
    await expect(dialog.getByTestId("bundle-export-summary")).toContainText("1 Agent");
    await expect(dialog.getByTestId("bundle-export-summary")).toContainText("secondary-worker.agetor.json");
    await dialog.getByTestId("bundle-export-downloads").click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Exported 1 Agent")).toBeVisible();
    // Headless: no Finder to reveal in, so the toast names the path.
    await expect(page.getByText(`Saved to ${path.join(backend.downloadsDir, "secondary-worker.agetor.json")}`)).toBeVisible();

    const file = path.join(backend.downloadsDir, "secondary-worker.agetor.json");
    const bundle = await readJson(file);
    expect(bundle.format).toBe("agetor-bundle");
    expect(bundle.agents).toHaveLength(1);
    expect(bundle.agents[0]!.harness).toEqual({
      id: "secondary-claude-code",
      kind: "claude-code",
      label: "Claude Code (secondary)",
    });

    await agentRow(section, "Secondary Worker").getByTestId("bundle-row-export").click();
    await exportDialog(page).getByTestId("bundle-export-downloads").click();
    await expect(exportDialog(page)).toBeHidden();
    await expect.poll(() => existsSync(path.join(backend.downloadsDir, "secondary-worker (2).agetor.json"))).toBe(true);

    // Stacked dialogs: Escape closes the export dialog, not Settings.
    await agentRow(section, "Secondary Worker").getByTestId("bundle-row-export").click();
    await expect(exportDialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(exportDialog(page)).toBeHidden();
    await expect(section).toBeVisible();
  });

  test("(2) Copy JSON puts the bundle text on the clipboard", async ({ page, context, request, backend }) => {
    await createProfile(request, backend, "Clipboard Agent");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    await agentRow(section, "Clipboard Agent").getByTestId("bundle-row-export").click();
    const dialog = exportDialog(page);
    await expect(dialog.getByTestId("bundle-export-summary")).toContainText("1 Agent");
    await dialog.getByTestId("bundle-export-copy").click();
    await expect(page.getByText("Copied 1 Agent as JSON")).toBeVisible();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    const parsed = JSON.parse(clip) as { format: string; agents: { name: string }[] };
    expect(parsed.format).toBe("agetor-bundle");
    expect(parsed.agents.map((a) => a.name)).toEqual(["Clipboard Agent"]);
    expect(clip.endsWith("}\n")).toBe(true);
  });

  test("(2b) a failed export build offers Retry", async ({ page, request, backend }) => {
    await createProfile(request, backend, "Retry Agent");
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    await page.route(
      (url) => url.pathname === "/bundle/export",
      (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify({ error: "export exploded" }),
        }),
    );
    await agentRow(section, "Retry Agent").getByTestId("bundle-row-export").click();
    const dialog = exportDialog(page);
    await expect(dialog.getByTestId("bundle-export-summary")).toContainText("export exploded");
    await expect(dialog.getByTestId("bundle-export-status")).toContainText("Export failed");
    await expect(dialog.getByTestId("bundle-export-downloads")).toBeDisabled();
    await page.unrouteAll({ behavior: "wait" });
    await dialog.getByTestId("bundle-export-retry").click();
    await expect(dialog.getByTestId("bundle-export-summary")).toContainText("1 Agent", { timeout: CONVERGE_TIMEOUT });
    await expect(dialog.getByTestId("bundle-export-retry")).toHaveCount(0);
    // Retry unmounts itself, so focus lands on the named summary region.
    await expect(dialog.getByRole("region", { name: "Export summary" })).toBeFocused();
    await expect(dialog.getByTestId("bundle-export-downloads")).toBeEnabled();
  });

  test("(2c) an export the core refuses (400) offers no Retry", async ({ page, request, backend }) => {
    await createProfile(request, backend, "Refused Agent");
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    await page.route(
      (url) => url.pathname === "/bundle/export",
      (route) =>
        route.fulfill({
          status: 400,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify({ error: "nothing to export" }),
        }),
    );
    await agentRow(section, "Refused Agent").getByTestId("bundle-row-export").click();
    const dialog = exportDialog(page);
    await expect(dialog.getByTestId("bundle-export-summary")).toContainText("nothing to export");
    await expect(dialog.getByTestId("bundle-export-retry")).toHaveCount(0);
    await expect(dialog.getByTestId("bundle-export-downloads")).toBeDisabled();
    await page.unrouteAll({ behavior: "wait" });
  });

  test("(3) Choose folder writes into the picked folder", async ({ page, request, backend }) => {
    await createProfile(request, backend, "Folder Agent");
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    await agentRow(section, "Folder Agent").getByTestId("bundle-row-export").click();
    await exportDialog(page).getByTestId("bundle-export-folder").click();
    await expect(exportDialog(page)).toBeHidden();
    await expect.poll(() => existsSync(path.join(backend.fakePickDir, "folder-agent.agetor.json"))).toBe(true);
  });

  test("(4) Pipelines page: a pipeline export embeds its Agents once and steps reference keys", async ({
    page,
    request,
    backend,
  }) => {
    const planner = await createProfile(request, backend, "Planner");
    const builder = await createProfile(request, backend, "Builder");
    const pipeline = await createPipeline(request, backend, "Delivery Flow", planner.id, builder.id);

    await gotoApp(page, backend.bootBase);
    const list = await openPipelinesPage(page);
    await list.locator(`[data-testid="pipelines-row"][data-pipeline-id="${pipeline.id}"]`).getByTestId("bundle-row-export").click();
    const dialog = exportDialog(page);
    await expect(dialog.getByTestId("bundle-export-summary")).toContainText("2 Agents, 1 Pipeline");
    await dialog.getByTestId("bundle-export-downloads").click();
    await expect(dialog).toBeHidden();

    const file = path.join(backend.downloadsDir, "delivery-flow.agetor.json");
    await expect.poll(() => existsSync(file)).toBe(true);
    const bundle = await readJson(file);
    expect(bundle.agents.map((a) => a.name)).toEqual(["Planner", "Builder"]);
    expect(bundle.pipelines[0]!.graph.steps.map((s) => s.agent)).toEqual(["planner", "builder"]);
    expect(bundle.pipelines[0]!.graph.steps[0]!.subagents.agents).toEqual(["builder"]);
    expect(JSON.stringify(bundle)).not.toContain(planner.id);
  });

  test("(5) multi-select exports the selected rows; Export all exports everything", async ({ page, request, backend }) => {
    const a = await createProfile(request, backend, "Alpha");
    await createProfile(request, backend, "Bravo");
    const c = await createProfile(request, backend, "Charlie");
    await createPipeline(request, backend, "Everything Flow", a.id, c.id);

    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    await expect(section.getByTestId("bundle-export-selected")).toBeDisabled();
    await agentRow(section, "Alpha").getByTestId("bundle-row-select").check();
    await agentRow(section, "Charlie").getByTestId("bundle-row-select").check();
    await expect(section.getByTestId("bundle-export-selected")).toContainText("Export selected (2)");
    await section.getByTestId("bundle-export-selected").click();
    await expect(exportDialog(page).getByTestId("bundle-export-summary")).toContainText("2 Agents");
    await expect(exportDialog(page).getByTestId("bundle-export-summary")).toContainText(/agetor-export-\d{4}-\d{2}-\d{2}\.agetor\.json/);
    await exportDialog(page).getByRole("button", { name: "Close" }).click();

    // Select-all toggles every row; toggling again clears.
    await section.getByTestId("bundle-select-all").check();
    await expect(section.getByTestId("bundle-export-selected")).toContainText("Export selected (3)");
    await section.getByTestId("bundle-select-all").uncheck();
    await expect(section.getByTestId("bundle-export-selected")).toBeDisabled();

    await section.getByTestId("bundle-export-all").click();
    await expect(exportDialog(page).getByTestId("bundle-export-summary")).toContainText("3 Agents, 1 Pipeline");
    await exportDialog(page).getByTestId("bundle-export-downloads").click();
    await expect(exportDialog(page)).toBeHidden();
    await expect
      .poll(() => readdir(backend.downloadsDir).catch(() => [] as string[]))
      .toContainEqual(expect.stringMatching(/^agetor-export-\d{4}-\d{2}-\d{2}\.agetor\.json$/));
  });

  test("(6) Paste import: a missing harness falls back with a warning; a second import is renamed (imported)", async ({
    page,
    request,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    const dialog = await pasteAndPreview(page, section, bundleText());
    const row = dialog.locator('[data-testid="bundle-import-agent-row"][data-agent-key="remote-worker"]');
    await expect(row).toHaveAttribute("data-resolution", "fallback");
    await expect(row.getByTestId("bundle-import-warning")).toContainText("isn't on this machine");
    await expect(row.getByTestId("bundle-import-agent-harness")).toHaveValue("claude-code");
    await expect(dialog.getByTestId("bundle-import-third-party-note")).toBeVisible();
    await row.getByTestId("bundle-import-agent-instructions").locator("summary").click();
    await expect(row.getByTestId("bundle-import-agent-instructions")).toContainText("Work carefully.");
    await dialog.getByTestId("bundle-import-confirm").click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Imported 1 Agent")).toBeVisible();
    await expect(agentRow(section, "Remote Worker")).toBeVisible();
    const profiles = await rest<ProfileRow[]>(request, backend, "GET", "/agent-profiles");
    expect(profiles.map((p) => [p.name, p.harness])).toEqual([["Remote Worker", "claude-code"]]);

    const again = await pasteAndPreview(page, section, bundleText());
    await expect(again.getByTestId("bundle-import-agent-name")).toHaveValue("Remote Worker (imported)");
    await again.getByTestId("bundle-import-confirm").click();
    await expect(again).toBeHidden();
    await expect(agentRow(section, "Remote Worker (imported)")).toBeVisible();
  });

  test("(6b) a name taken between the preview and Confirm stops the import and shows the new preview", async ({
    page,
    request,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    const dialog = await pasteAndPreview(page, section, bundleText());
    await expect(dialog.getByTestId("bundle-import-agent-name")).toHaveValue("Remote Worker");
    // Another surface (the CLI, a second window) takes the name meanwhile.
    await createProfile(request, backend, "Remote Worker");
    await dialog.getByTestId("bundle-import-confirm").click();
    // Shown as a changed plan, not a failure; Confirm says so.
    await expect(dialog.getByTestId("bundle-import-plan-changed")).toContainText("Nothing was imported");
    await expect(dialog.getByTestId("bundle-import-error")).toHaveCount(0);
    await expect(dialog.getByTestId("bundle-import-status")).toContainText("Updated plan: 1 Agent, ready to import");
    await expect(dialog.getByTestId("bundle-import-confirm")).toHaveText("Import updated plan");
    await expect(dialog.getByTestId("bundle-import-agent-name")).toHaveValue("Remote Worker (imported)");
    let names = (await rest<ProfileRow[]>(request, backend, "GET", "/agent-profiles")).map((p) => p.name);
    expect(names).toEqual(["Remote Worker"]);
    // Confirming the new preview imports exactly it.
    await dialog.getByTestId("bundle-import-confirm").click();
    await expect(dialog).toBeHidden();
    names = (await rest<ProfileRow[]>(request, backend, "GET", "/agent-profiles")).map((p) => p.name).sort();
    expect(names).toEqual(["Remote Worker", "Remote Worker (imported)"]);
  });

  test("(6c) after a 409 swaps in a changed plan, Confirm settles disabled and ignores a double-click's second click", async ({
    page,
    request,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    const dialog = await pasteAndPreview(page, section, bundleText());
    const confirm = dialog.getByTestId("bundle-import-confirm");
    await expect(dialog.getByTestId("bundle-import-agent-name")).toHaveValue("Remote Worker");
    // Every commit the dialog sends, so a swallowed click is proven to have
    // sent nothing (the previews go to `/bundle/import/preview`).
    let importPosts = 0;
    page.on("request", (req) => {
      if (req.method() === "POST" && new URL(req.url()).pathname.endsWith("/bundle/import")) importPosts += 1;
    });
    await createProfile(request, backend, "Remote Worker");

    // Read Confirm's state in the very frame the notice first renders: the
    // notice and the settle-disable land in one commit, so this can't race
    // the 800 ms timer the way a separate assertion after it could.
    const atNotice = page.waitForFunction(() => {
      if (!document.querySelector('[data-testid="bundle-import-plan-changed"]')) return false;
      const btn = document.querySelector<HTMLButtonElement>('[data-testid="bundle-import-confirm"]');
      // Confirm is `aria-disabled` (it keeps keyboard focus while disabled).
      const disabled = btn ? btn.disabled || btn.getAttribute("aria-disabled") === "true" : null;
      return { disabled, label: btn?.textContent ?? null };
    });
    await confirm.click();
    expect(await (await atNotice).jsonValue()).toEqual({ disabled: true, label: "Import updated plan" });
    expect(importPosts).toBe(1);
    await expect(dialog.getByTestId("bundle-import-plan-changed")).toContainText("Nothing was imported");
    await expect(dialog.getByTestId("bundle-import-agent-name")).toHaveValue("Remote Worker (imported)");
    // Disabling itself while it imported didn't drop keyboard focus.
    await expect(confirm).toBeFocused();

    // Once the settle window is over the button is live again; a click that
    // is the second of a double-click (detail 2) is still not a decision
    // about the new plan, so it must import nothing.
    await expect(confirm).toBeEnabled();
    // Dispatch and read back in one page turn, two frames later: a click the
    // handler acted on would already have flipped Confirm to "Importing…" and
    // dropped the notice (`doImport` sets both synchronously), so this reads
    // the outcome without racing the request.
    const afterDoubleClick = await page.evaluate(async () => {
      const btn = document.querySelector<HTMLButtonElement>('[data-testid="bundle-import-confirm"]')!;
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, detail: 2 }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const now = document.querySelector<HTMLButtonElement>('[data-testid="bundle-import-confirm"]');
      return {
        label: now?.textContent ?? null,
        disabled: now ? now.disabled || now.getAttribute("aria-disabled") === "true" : null,
        notice: document.querySelector('[data-testid="bundle-import-plan-changed"]') !== null,
      };
    });
    expect(afterDoubleClick).toEqual({ label: "Import updated plan", disabled: false, notice: true });
    await expect(dialog).toBeVisible();
    expect(importPosts).toBe(1);
    expect((await rest<ProfileRow[]>(request, backend, "GET", "/agent-profiles")).map((p) => p.name)).toEqual([
      "Remote Worker",
    ]);

    // A plain click (detail 1) on the same button imports the updated plan.
    await confirm.dispatchEvent("click", { detail: 1 });
    await expect(dialog).toBeHidden();
    expect(importPosts).toBe(2);
    const names = (await rest<ProfileRow[]>(request, backend, "GET", "/agent-profiles")).map((p) => p.name).sort();
    expect(names).toEqual(["Remote Worker", "Remote Worker (imported)"]);
  });

  test("(6d) a double-click's second click counts again once the 5 s window after a plan swap is over", async ({
    page,
    request,
    backend,
  }) => {
    // A controllable clock (it runs in real time until fast-forwarded), so
    // the window can be passed without a 5 s wait.
    await page.clock.install();
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    const dialog = await pasteAndPreview(page, section, bundleText());
    const confirm = dialog.getByTestId("bundle-import-confirm");
    await expect(dialog.getByTestId("bundle-import-agent-name")).toHaveValue("Remote Worker");
    await createProfile(request, backend, "Remote Worker");
    await confirm.click();
    await expect(dialog.getByTestId("bundle-import-plan-changed")).toContainText("Nothing was imported");
    await expect(dialog.getByTestId("bundle-import-agent-name")).toHaveValue("Remote Worker (imported)");
    await expect(confirm).toBeEnabled();
    await page.clock.fastForward(5_100);
    // Past the window, even a detail-2 click is a decision about the plan shown.
    await confirm.dispatchEvent("click", { detail: 2 });
    await expect(dialog).toBeHidden();
    const names = (await rest<ProfileRow[]>(request, backend, "GET", "/agent-profiles")).map((p) => p.name).sort();
    expect(names).toEqual(["Remote Worker", "Remote Worker (imported)"]);
  });

  test("(7) Choose file imports the picked .json file", async ({ page, backend }) => {
    await backend.plantPicks({ "picked.agetor.json": bundleText({ name: "Picked Agent", key: "picked" }) });
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    await section.getByTestId("bundle-import-open").click();
    const dialog = importDialog(page);
    await dialog.getByTestId("bundle-import-choose-file").click();
    await expect(dialog.getByText("picked.agetor.json")).toBeVisible();
    await expect(dialog.locator('[data-testid="bundle-import-agent-row"][data-agent-key="picked"]')).toBeVisible();
    // Other file → Choose file is usable again (the pick's own load must not
    // strand it on "Choosing…"), and picks the file again.
    await dialog.getByTestId("bundle-import-back").click();
    await expect(dialog.getByTestId("bundle-import-choose-file")).toBeEnabled();
    await dialog.getByTestId("bundle-import-choose-file").click();
    await expect(dialog.locator('[data-testid="bundle-import-agent-row"][data-agent-key="picked"]')).toBeVisible();
    await dialog.getByTestId("bundle-import-confirm").click();
    await expect(dialog).toBeHidden();
    await expect(agentRow(section, "Picked Agent")).toBeVisible();
  });

  test("(8) dropping a .json file onto the list opens the import preview", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    const text = bundleText({ name: "Dropped Agent", key: "dropped" });
    const dt = await page.evaluateHandle((content) => {
      const d = new DataTransfer();
      d.items.add(new File([content], "dropped.agetor.json", { type: "application/json" }));
      return d;
    }, text);
    await section.dispatchEvent("dragover", { dataTransfer: dt });
    await section.dispatchEvent("drop", { dataTransfer: dt });
    const dialog = importDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-testid="bundle-import-agent-row"][data-agent-key="dropped"]')).toBeVisible();
    await dialog.getByTestId("bundle-import-confirm").click();
    await expect(dialog).toBeHidden();
    await expect(agentRow(section, "Dropped Agent")).toBeVisible();

    // A non-.json drop is refused with a toast, and opens nothing.
    const txt = await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.items.add(new File(["hello"], "notes.txt", { type: "text/plain" }));
      return d;
    });
    await section.dispatchEvent("dragover", { dataTransfer: txt });
    await section.dispatchEvent("drop", { dataTransfer: txt });
    await expect(page.getByText("Can't import that file")).toBeVisible();
    await settleDrop(page);
    await expect(importDialog(page)).toBeHidden();

    // Several files at once are refused too — never only the first imported.
    const two = await page.evaluateHandle((content) => {
      const d = new DataTransfer();
      d.items.add(new File([content], "one.agetor.json", { type: "application/json" }));
      d.items.add(new File([content], "two.agetor.json", { type: "application/json" }));
      return d;
    }, text);
    await section.dispatchEvent("dragover", { dataTransfer: two });
    await section.dispatchEvent("drop", { dataTransfer: two });
    await expect(page.getByText("Drop one file at a time — 2 files were dropped.")).toBeVisible();
    await settleDrop(page);
    await expect(importDialog(page)).toBeHidden();
  });

  test("(8b) a drop on an open dialog never reaches the list's drop zone", async ({ page, request, backend }) => {
    await createProfile(request, backend, "Exported Agent");
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);

    // A file dropped on the Export dialog (portaled, but rendered by the
    // list) doesn't open Import on top of it.
    await agentRow(section, "Exported Agent").getByTestId("bundle-row-export").click();
    const exp = exportDialog(page);
    await expect(exp.getByTestId("bundle-export-summary")).toContainText("1 Agent");
    await dropFile(page, exp, bundleText({ name: "Sneaky Agent", key: "sneaky" }));
    await settleDrop(page);
    await expect(importDialog(page)).toHaveCount(0);
    await expect(exp).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(exp).toBeHidden();

    // A drop on the Import dialog's backdrop leaves the preview and its edits alone.
    const dialog = await pasteAndPreview(page, section, bundleText());
    const name = dialog.getByTestId("bundle-import-agent-name");
    await name.fill("Edited Name");
    const backdrop = page.getByRole("dialog").filter({ has: dialog });
    await dropFile(page, backdrop, bundleText({ name: "Other Agent", key: "other" }));
    await settleDrop(page);
    await expect(page.getByRole("dialog").filter({ hasText: "Replace this import?" })).toHaveCount(0);
    await expect(dialog.locator('[data-testid="bundle-import-agent-row"][data-agent-key="other"]')).toHaveCount(0);
    await expect(dialog.locator('[data-testid="bundle-import-agent-row"][data-agent-key="remote-worker"]')).toBeVisible();
    await expect(name).toHaveValue("Edited Name");

    // A drop on the dialog itself replaces the edited preview only once confirmed.
    await dropFile(page, dialog, bundleText({ name: "Other Agent", key: "other" }));
    const ask = page.getByRole("dialog").filter({ hasText: "Replace this import?" });
    await expect(ask).toBeVisible();
    await ask.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(name).toHaveValue("Edited Name");
    await dropFile(page, dialog, bundleText({ name: "Other Agent", key: "other" }));
    await page.getByRole("dialog").filter({ hasText: "Replace this import?" }).getByRole("button", { name: "Replace" }).click();
    await expect(dialog.locator('[data-testid="bundle-import-agent-row"][data-agent-key="other"]')).toBeVisible();

    // "Other file" over an edited preview asks first, like close and drop do.
    const otherName = dialog.getByTestId("bundle-import-agent-name");
    await otherName.fill("Edited Again");
    await dialog.getByTestId("bundle-import-back").click();
    const discard = page.getByRole("dialog").filter({ hasText: "Discard this import?" });
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(otherName).toHaveValue("Edited Again");
    await dialog.getByTestId("bundle-import-back").click();
    await page.getByRole("dialog").filter({ hasText: "Discard this import?" }).getByRole("button", { name: "Discard" }).click();
    await expect(dialog.getByTestId("bundle-import-paste")).toBeVisible();
  });

  test("(8c) dropping the same file again re-previews it", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    const text = bundleText({ name: "Same Agent", key: "same" });
    await dropFile(page, section, text);
    const dialog = importDialog(page);
    const row = dialog.locator('[data-testid="bundle-import-agent-row"][data-agent-key="same"]');
    await expect(row).toBeVisible();
    // Before the fix, identical text cleared the plan without a new request
    // and the dialog sat on "Preparing the preview…" forever.
    const again = page.waitForRequest((r) => r.url().endsWith("/bundle/import/preview"), { timeout: CONVERGE_TIMEOUT });
    await dropFile(page, dialog, text);
    await again;
    await expect(dialog.getByText("Preparing the preview…")).toHaveCount(0, { timeout: CONVERGE_TIMEOUT });
    await expect(row).toBeVisible();
    await expect(dialog.getByTestId("bundle-import-confirm")).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
  });

  test("(8d) Confirm waits for a stale preview; a failed one keeps the plan with Retry; closing with edits asks", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    const dialog = await pasteAndPreview(page, section, bundleText());
    const confirmButton = dialog.getByTestId("bundle-import-confirm");
    const row = dialog.locator('[data-testid="bundle-import-agent-row"][data-agent-key="remote-worker"]');
    await expect(confirmButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await expect(dialog.getByTestId("bundle-import-status")).toContainText("Preview ready: 1 Agent");

    // An edit makes the plan stale: Confirm stays disabled until its own
    // preview answers.
    const held = await holdRequests(page, "/bundle/import/preview");
    await dialog.getByTestId("bundle-import-agent-name").fill("Held Name");
    await expect.poll(held.seen, { timeout: CONVERGE_TIMEOUT }).toBe(1);
    await expect(confirmButton).toBeDisabled();
    await expect(dialog.locator("footer").getByText("Updating preview…")).toBeVisible();
    held.release();
    await expect(confirmButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await page.unrouteAll({ behavior: "wait" });

    // A failed re-preview keeps the last plan on screen, offers Retry, and
    // Confirm stays disabled (the plan is out of date).
    let failedPreviews = 0;
    await page.route(
      (url) => url.pathname === "/bundle/import/preview",
      (route) => {
        failedPreviews++;
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify({ error: "preview exploded" }),
        });
      },
    );
    await dialog.getByTestId("bundle-import-agent-name").fill("Broken Name");
    await expect(dialog.getByTestId("bundle-import-error")).toContainText("preview exploded", { timeout: CONVERGE_TIMEOUT });
    await expect(row).toBeVisible();
    await expect(confirmButton).toBeDisabled();
    await expect(dialog.locator("footer").getByText("The preview is out of date")).toBeVisible();
    // Reverting to the options the shown plan was made for doesn't make it
    // current again while previews fail: Confirm stays disabled.
    const failedBefore = failedPreviews;
    await dialog.getByTestId("bundle-import-agent-name").fill("Held Name");
    await expect.poll(() => failedPreviews, { timeout: CONVERGE_TIMEOUT }).toBe(failedBefore + 1);
    await expect(dialog.getByTestId("bundle-import-error")).toContainText("preview exploded");
    await expect(confirmButton).toBeDisabled();
    await expect(dialog.locator("footer").getByText("The preview is out of date")).toBeVisible();
    await page.unrouteAll({ behavior: "wait" });
    await dialog.getByTestId("bundle-import-retry").click();
    await expect(dialog.getByRole("region", { name: "Import preview" })).toBeFocused();
    await expect(dialog.getByTestId("bundle-import-error")).toHaveCount(0, { timeout: CONVERGE_TIMEOUT });
    await expect(confirmButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });

    // Closing with edits asks; Cancel keeps the preview.
    await dialog.getByTestId("bundle-import-close").click();
    const discard = page.getByRole("dialog").filter({ hasText: "Discard this import?" });
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog.getByTestId("bundle-import-agent-name")).toHaveValue("Held Name");

    // While the import runs, the preview and every way out are locked.
    const importing = await holdRequests(page, "/bundle/import");
    await confirmButton.click();
    await expect.poll(importing.seen, { timeout: CONVERGE_TIMEOUT }).toBe(1);
    await expect(dialog.getByTestId("bundle-import-agent-name")).toBeDisabled();
    await expect(dialog.getByTestId("bundle-import-agent-harness")).toBeDisabled();
    await expect(dialog.getByTestId("bundle-import-close")).toBeDisabled();
    await expect(dialog.getByTestId("bundle-import-back")).toBeDisabled();
    await expect(dialog.getByTestId("bundle-import-status")).toHaveText("Importing…");
    importing.release();
    await expect(dialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    await page.unrouteAll({ behavior: "wait" });
    await expect(agentRow(section, "Held Name")).toBeVisible();
  });

  test("(8f) an import whose answer is lost re-previews, so a landed import can't be clicked in twice", async ({
    page,
    request,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    const dialog = await pasteAndPreview(page, section, bundleText());
    const confirmButton = dialog.getByTestId("bundle-import-confirm");
    await expect(confirmButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    // The import commits on the server, but its answer never arrives.
    await page.route(
      (url) => url.pathname === "/bundle/import",
      async (route) => {
        await route.fetch();
        await route.abort("failed");
      },
    );
    await confirmButton.click();
    await expect(dialog.getByTestId("bundle-import-error")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await page.unrouteAll({ behavior: "wait" });
    // The re-preview sees the committed Agent: the same Confirm would now
    // create a renamed copy, and says so.
    await expect(dialog.getByTestId("bundle-import-agent-name")).toHaveValue("Remote Worker (imported)", {
      timeout: CONVERGE_TIMEOUT,
    });
    // The re-preview's fingerprint differs from the confirmed one, which is
    // the verdict: it ran.
    await expect(dialog.getByTestId("bundle-import-error")).toContainText("Import most likely ran:");
    const profiles = await rest<ProfileRow[]>(request, backend, "GET", "/agent-profiles");
    expect(profiles.map((p) => p.name)).toEqual(["Remote Worker"]);
    await expect(agentRow(section, "Remote Worker")).toBeVisible();
  });

  test("(8f2) a lost import of a typed name that ran isn't called safe to import again", async ({
    page,
    request,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    const dialog = await pasteAndPreview(page, section, bundleText());
    const confirmButton = dialog.getByTestId("bundle-import-confirm");
    // A typed name is never suffixed: once this import lands, its re-plan
    // keeps the name (and the fingerprint) but blocks it as name-in-use.
    await dialog.getByTestId("bundle-import-agent-name").fill("Typed Worker");
    await expect(confirmButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await page.route(
      (url) => url.pathname === "/bundle/import",
      async (route) => {
        await route.fetch();
        await route.abort("failed");
      },
    );
    await confirmButton.click();
    await expect(dialog.getByTestId("bundle-import-error")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await page.unrouteAll({ behavior: "wait" });
    await expect(dialog.getByTestId("bundle-import-error")).toContainText("Import most likely ran:", {
      timeout: CONVERGE_TIMEOUT,
    });
    await expect(dialog.getByTestId("bundle-import-error")).not.toContainText("safe to import again");
    // A warning, not a failure: it may well have run.
    await expect(dialog.getByTestId("bundle-import-error")).toHaveAttribute("data-tone", "warning");
    await expect(dialog.getByTestId("bundle-import-status")).toContainText("Import most likely ran:");
    // The sticky warning still carries the plan, so its changes are announced.
    await expect(dialog.getByTestId("bundle-import-status")).toContainText("Current plan: 1 Agent, 1 blocking issue");
    await expect(dialog.getByTestId("bundle-import-agent-name")).toHaveValue("Typed Worker");
    await expect(confirmButton).toBeDisabled();
    const profiles = await rest<ProfileRow[]>(request, backend, "GET", "/agent-profiles");
    expect(profiles.map((p) => p.name)).toEqual(["Typed Worker"]);
    // Renaming past the taken name makes the plan importable again, but the
    // verdict stays up: nothing else would say this import already ran.
    await dialog.getByTestId("bundle-import-agent-name").fill("Renamed Worker");
    await expect(confirmButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await expect(dialog.getByTestId("bundle-import-error")).toContainText("Import most likely ran:");
    await expect(dialog.getByTestId("bundle-import-status")).toContainText("Import most likely ran:");
    await expect(dialog.getByTestId("bundle-import-status")).toContainText("Current plan: 1 Agent, ready to import");
  });

  test("(8i) a lost import that never ran says so once the re-preview matches the confirmed one", async ({
    page,
    request,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    const dialog = await pasteAndPreview(page, section, bundleText());
    const confirmButton = dialog.getByTestId("bundle-import-confirm");
    await expect(confirmButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    // The request is dropped before it reaches the core; /health still
    // answers, so it reads as a lost answer, not an unreachable core.
    await page.route(
      (url) => url.pathname === "/bundle/import",
      (route) => route.abort("failed"),
    );
    await confirmButton.click();
    await expect(dialog.getByTestId("bundle-import-error")).toContainText("Import didn't run:", {
      timeout: CONVERGE_TIMEOUT,
    });
    await page.unrouteAll({ behavior: "wait" });
    await expect(dialog.getByTestId("bundle-import-agent-name")).toHaveValue("Remote Worker");
    expect(await rest<ProfileRow[]>(request, backend, "GET", "/agent-profiles")).toEqual([]);
    // Safe to import again, and the same Confirm does.
    await expect(confirmButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await confirmButton.click();
    await expect(dialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    await expect(agentRow(section, "Remote Worker")).toBeVisible();
  });

  test("(8i2) a lost import's verdict locks the preview; a failed verdict preview unlocks it, and an edit leaves a warning", async ({
    page,
    request,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    const dialog = await pasteAndPreview(page, section, bundleText());
    const confirmButton = dialog.getByTestId("bundle-import-confirm");
    const nameInput = dialog.getByTestId("bundle-import-agent-name");
    const status = dialog.getByTestId("bundle-import-status");
    await expect(confirmButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    // The import commits on the server, but its answer never arrives; the
    // re-preview that would give the verdict is held, then fails.
    await page.route(
      (url) => url.pathname === "/bundle/import",
      async (route) => {
        await route.fetch();
        await route.abort("failed");
      },
    );
    let releaseVerdict!: () => void;
    const verdictGate = new Promise<void>((r) => (releaseVerdict = r));
    let previews = 0;
    await page.route(
      (url) => url.pathname === "/bundle/import/preview",
      async (route) => {
        previews++;
        await verdictGate;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify({ error: "preview exploded" }),
        });
      },
    );
    await confirmButton.click();
    await expect.poll(() => previews, { timeout: CONVERGE_TIMEOUT }).toBeGreaterThan(0);
    const pending = dialog.getByTestId("bundle-import-error").filter({ hasText: "Import may have run:" });
    await expect(pending).toContainText("Checking it against a refreshed preview");
    await expect(pending).toHaveAttribute("data-tone", "warning");
    // Until the verdict, no edit can replace its re-preview, and Confirm waits.
    await expect(nameInput).toBeDisabled();
    await expect(confirmButton).toBeDisabled();

    // The verdict's preview fails: the preview unlocks (Retry has to work),
    // and the live region says the verdict is still unknown.
    releaseVerdict();
    await expect(dialog.getByTestId("bundle-import-error").filter({ hasText: "preview exploded" })).toBeVisible({
      timeout: CONVERGE_TIMEOUT,
    });
    await expect(status).toContainText("Preview failed: preview exploded");
    await expect(status).toContainText("Whether the import ran is still unknown");
    await expect(nameInput).toBeEnabled();
    await expect(confirmButton).toBeDisabled();
    await page.unrouteAll({ behavior: "wait" });

    // An edit now previews other options: nothing is left to compare the
    // confirmed plan against, so the warning says to look instead.
    await nameInput.fill("Other Worker");
    const warning = dialog.getByTestId("bundle-import-error").filter({ hasText: "Import may have run:" });
    await expect(warning).toContainText("the options changed before a refreshed preview could tell", {
      timeout: CONVERGE_TIMEOUT,
    });
    // The failed preview's box goes once the new options' preview lands.
    await expect(dialog.getByTestId("bundle-import-error")).toHaveCount(1, { timeout: CONVERGE_TIMEOUT });
    await expect(warning).toHaveAttribute("data-tone", "warning");
    await expect(status).toContainText("Import may have run:");
    // It did run.
    const profiles = await rest<ProfileRow[]>(request, backend, "GET", "/agent-profiles");
    expect(profiles.map((p) => p.name)).toEqual(["Remote Worker"]);
    // The warning stays over later edits, and Confirm works (the name is free).
    await nameInput.fill("Third Worker");
    await expect(confirmButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await expect(warning).toContainText("the options changed before a refreshed preview could tell");
  });

  test("(8i3) closing while a lost import's verdict is pending leaves a toast", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    const dialog = await pasteAndPreview(page, section, bundleText());
    const confirmButton = dialog.getByTestId("bundle-import-confirm");
    await expect(confirmButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    // The answer is lost (the core still answers /health), and the verdict's
    // re-preview is held, so the verdict is still pending at close.
    await page.route(
      (url) => url.pathname === "/bundle/import",
      (route) => route.abort("failed"),
    );
    const held = await holdRequests(page, "/bundle/import/preview");
    await confirmButton.click();
    await expect.poll(held.seen, { timeout: CONVERGE_TIMEOUT }).toBeGreaterThan(0);
    await expect(dialog.getByTestId("bundle-import-error")).toContainText("Import may have run:");
    await dialog.getByTestId("bundle-import-close").click();
    await expect(dialog).toBeHidden();
    const toastItem = page.locator("[data-sonner-toast]").filter({ hasText: "Import didn't finish" });
    await expect(toastItem).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(toastItem).toContainText("check your Agents and Pipelines before importing the file again");
    await expect(toastItem).toHaveCount(1);
    held.release();
    await page.unrouteAll({ behavior: "wait" });
    await toastItem.getByRole("button", { name: "Close toast" }).click();
    await expect(toastItem).toHaveCount(0);
  });

  test("(8j) an import answered after its page was left reports the outcome in a toast", async ({ page, backend }) => {
    type Answer = { status: number; body: (fingerprint: string) => unknown } | "abort";
    const cases: { answer: Answer; toast: string }[] = [
      {
        answer: { status: 409, body: () => ({ error: "blocked", plan: { canImport: false, fingerprint: "other" } }) },
        toast: "The import is blocked. Open Import again to see why.",
      },
      {
        // The re-plan is identical to the confirmed one (a name race): the
        // core's own reason, not "something changed".
        answer: {
          status: 409,
          body: (fingerprint) => ({
            error: "import failed — nothing was imported: a name was taken meanwhile",
            plan: { canImport: true, fingerprint },
          }),
        },
        toast: "a name was taken meanwhile. Open Import again to retry.",
      },
      {
        answer: { status: 409, body: () => ({ error: "changed", plan: { canImport: true, fingerprint: "other" } }) },
        toast: "Something on this machine changed since the preview",
      },
      {
        answer: { status: 500, body: () => ({ error: "import failed — nothing was imported: disk full" }) },
        toast: "disk full. Open Import again to retry.",
      },
      { answer: "abort", toast: "check your Agents and Pipelines before importing the file again" },
    ];
    await gotoApp(page, backend.bootBase);
    for (const c of cases) {
      const pageRoot = await openPipelinesPage(page);
      const dialog = await pasteAndPreview(page, pageRoot, bundleText());
      const confirmButton = dialog.getByTestId("bundle-import-confirm");
      await expect(confirmButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      await page.route(
        (url) => url.pathname === "/bundle/import",
        async (route) => {
          const { planFingerprint } = route.request().postDataJSON() as { planFingerprint: string };
          await gate;
          if (c.answer === "abort") return route.abort("failed");
          return route.fulfill({
            status: c.answer.status,
            contentType: "application/json",
            body: JSON.stringify(c.answer.body(planFingerprint)),
          });
        },
      );
      const sent = page.waitForRequest((r) => new URL(r.url()).pathname === "/bundle/import");
      await confirmButton.click();
      await sent;
      // No guard while the import runs (it commits either way): the page
      // leaves, and the dialog with it.
      await pageRoot.getByTestId("pipelines-back").evaluate((el) => (el as HTMLButtonElement).click());
      await expect(pageRoot).toBeHidden({ timeout: CONVERGE_TIMEOUT });
      release();
      const toastItem = page.locator("[data-sonner-toast]").filter({ hasText: c.toast });
      await expect(toastItem).toBeVisible({ timeout: CONVERGE_TIMEOUT });
      await page.unrouteAll({ behavior: "wait" });
      // These toasts stay until dismissed, and would cover the next round's
      // Import button.
      await toastItem.getByRole("button", { name: "Close toast" }).click();
      await expect(toastItem).toHaveCount(0);
    }
  });

  test("(8j2) an import the core refused keeps the shown plan current: no re-preview, Confirm stays usable", async ({
    page,
    request,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    const dialog = await pasteAndPreview(page, section, bundleText());
    const confirmButton = dialog.getByTestId("bundle-import-confirm");
    await expect(confirmButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    // The core answers with an error: its one transaction wrote nothing, so
    // the plan is still current — unlike a lost answer, nothing re-previews.
    await page.route(
      (url) => url.pathname === "/bundle/import",
      (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify({ error: "import failed — nothing was imported: disk full" }),
        }),
    );
    let previews = 0;
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/bundle/import/preview") previews++;
    });
    await confirmButton.click();
    const error = dialog.getByTestId("bundle-import-error");
    // A refusal, not a lost answer: the danger tone, and "Nothing was
    // imported" said once, never "may have run".
    await expect(error).toHaveText("Nothing was imported: disk full", { timeout: CONVERGE_TIMEOUT });
    await expect(error).toHaveAttribute("data-tone", "danger");
    // The plan stays current. A lost answer would set its error together
    // with an out-of-date plan, so Confirm would be disabled and the live
    // region would say "Import may have run:" with no current plan.
    await expect(confirmButton).toBeEnabled();
    await expect(dialog.getByTestId("bundle-import-status")).toHaveText(
      "Nothing was imported: disk full. Current plan: 1 Agent, ready to import",
    );
    await page.unrouteAll({ behavior: "wait" });
    // Confirm still works: the same plan imports once the core accepts it.
    await confirmButton.click();
    await expect(dialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    await expect
      .poll(async () => (await rest<ProfileRow[]>(request, backend, "GET", "/agent-profiles")).map((p) => p.name))
      .toEqual(["Remote Worker"]);
    // And nothing re-previewed along the way.
    expect(previews).toBe(0);
  });

  test("(8k) a dropped file whose read finishes after an import started is refused with a toast", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    const dialog = await pasteAndPreview(page, section, bundleText());
    const confirmButton = dialog.getByTestId("bundle-import-confirm");
    await expect(confirmButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    // Hold every File.text() read until released.
    await page.evaluate(() => {
      const w = window as unknown as { __releaseRead: () => void };
      const original = File.prototype.text;
      const gate = new Promise<void>((r) => (w.__releaseRead = r));
      File.prototype.text = async function (this: File) {
        await gate;
        return original.call(this);
      };
    });
    const held = await holdRequests(page, "/bundle/import");
    // The drop is taken while the preview is idle…
    await dropFile(page, dialog, bundleText({ key: "late", name: "Late Drop" }));
    // …and an import starts before the file has been read.
    await confirmButton.click();
    await expect.poll(() => held.seen()).toBe(1);
    await page.evaluate(() => (window as unknown as { __releaseRead: () => void }).__releaseRead());
    await expect(page.getByText("Can't import that file now")).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    // The import the user confirmed goes ahead untouched.
    held.release();
    await expect(dialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    await expect(agentRow(section, "Remote Worker")).toBeVisible();
    await expect(agentRow(section, "Late Drop")).toHaveCount(0);
  });

  test("(8h) an import the core never answers (health check down too) keeps the plan, with one error", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    const dialog = await pasteAndPreview(page, section, bundleText());
    const confirmButton = dialog.getByTestId("bundle-import-confirm");
    await expect(confirmButton).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    let previews = 0;
    await page.route(
      (url) => url.pathname === "/bundle/import/preview",
      (route) => {
        previews++;
        return route.continue();
      },
    );
    await page.route(
      (url) => url.pathname === "/bundle/import" || url.pathname === "/health",
      (route) => route.abort("failed"),
    );
    await confirmButton.click();
    await expect(dialog.getByTestId("bundle-import-error")).toContainText("most likely didn't run", {
      timeout: CONVERGE_TIMEOUT,
    });
    // No re-preview stacks a second error box under it; the plan stays current.
    // A regressed re-preview would only go out after the dialog's 250 ms
    // preview debounce, so wait past it before counting — asserting at once
    // would pass before it ever fired.
    await expect(
      page.waitForRequest((r) => new URL(r.url()).pathname === "/bundle/import/preview", { timeout: 1_000 }),
    ).rejects.toThrow();
    await expect(dialog.getByTestId("bundle-import-error")).toHaveCount(1);
    expect(previews).toBe(0);
    await expect(confirmButton).toBeEnabled();
    await page.unrouteAll({ behavior: "wait" });
    // Once the core answers again, the same Confirm imports.
    await confirmButton.click();
    await expect(dialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    await expect(agentRow(section, "Remote Worker")).toBeVisible();
  });

  test("(8g) an app-level navigation away from the Pipelines page asks while an edited import preview is open", async ({
    page,
    request,
    backend,
  }) => {
    const planner = await createProfile(request, backend, "Planner");
    const pipeline = await createPipeline(request, backend, "Guarded Flow", planner.id, planner.id);
    const discard = page.getByRole("dialog").filter({ hasText: "Discard this import?" });
    const editor = page.getByTestId("pipeline-editor");

    await gotoApp(page, backend.bootBase);
    let pageRoot = await openPipelinesPage(page);
    const editButton = () =>
      pageRoot.locator(`[data-testid="pipelines-row"][data-pipeline-id="${pipeline.id}"]`).getByTestId("pipelines-edit");
    const dialog = await pasteAndPreview(page, pageRoot, bundleText());
    await expect(dialog.getByTestId("bundle-import-confirm")).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await dialog.getByTestId("bundle-import-agent-name").fill("Edited Name");

    // The page's Back and a row's Edit sit under the modal, so no real click
    // reaches them; a navigation that does anyway (a toast, a deep link)
    // goes through `navigate` and its guard — both the page's own `onBack`
    // and its `onOpenEditor`.
    await pageRoot.getByTestId("pipelines-back").evaluate((el) => (el as HTMLButtonElement).click());
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(discard).toBeHidden();
    await expect(pageRoot).toBeVisible();
    await expect(dialog.getByTestId("bundle-import-agent-name")).toHaveValue("Edited Name");

    await editButton().evaluate((el) => (el as HTMLButtonElement).click());
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(discard).toBeHidden();
    await expect(editor).toHaveCount(0);
    await expect(dialog.getByTestId("bundle-import-agent-name")).toHaveValue("Edited Name");

    // Discard closes the import at once and the editor opens.
    await editButton().evaluate((el) => (el as HTMLButtonElement).click());
    await discard.getByRole("button", { name: "Discard" }).click();
    await expect(dialog).toBeHidden();
    await expect(editor).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await editor.getByTestId("pipeline-back").click();
    pageRoot = page.getByTestId("pipelines-page");
    await expect(pageRoot).toBeVisible();

    // A preview closed without edits leaves no guard behind: real clicks
    // navigate straight through.
    await pasteAndPreview(page, pageRoot, bundleText());
    await expect(dialog.getByTestId("bundle-import-confirm")).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await dialog.getByTestId("bundle-import-close").click();
    await expect(dialog).toBeHidden();
    await editButton().click();
    await expect(editor).toBeVisible({ timeout: CONVERGE_TIMEOUT });
    await expect(discard).toHaveCount(0);
    await editor.getByTestId("pipeline-back").click();
    await expect(pageRoot).toBeVisible();

    // Nor does one whose edits were discarded on close.
    await pasteAndPreview(page, pageRoot, bundleText());
    await expect(dialog.getByTestId("bundle-import-confirm")).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await dialog.getByTestId("bundle-import-agent-name").fill("Edited Again");
    await dialog.getByTestId("bundle-import-close").click();
    await discard.getByRole("button", { name: "Discard" }).click();
    await expect(dialog).toBeHidden();
    await pageRoot.getByTestId("pipelines-back").click();
    await expect(pageRoot).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    await expect(discard).toHaveCount(0);

    // And Back with an edited preview: Discard leaves for the board.
    pageRoot = await openPipelinesPage(page);
    await pasteAndPreview(page, pageRoot, bundleText());
    await expect(dialog.getByTestId("bundle-import-confirm")).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await dialog.getByTestId("bundle-import-agent-name").fill("Edited Name");
    await pageRoot.getByTestId("pipelines-back").evaluate((el) => (el as HTMLButtonElement).click());
    await discard.getByRole("button", { name: "Discard" }).click();
    await expect(dialog).toBeHidden();
    await expect(pageRoot).toBeHidden({ timeout: CONVERGE_TIMEOUT });
  });

  test("(8e) an oversized paste is refused before any request; an unpreviewed paste asks before closing", async ({
    page,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    await section.getByTestId("bundle-import-open").click();
    const dialog = importDialog(page);
    let previews = 0;
    page.on("request", (r) => {
      if (r.url().endsWith("/bundle/import/preview")) previews++;
    });
    // 2-byte characters: over the 2 MB cap in UTF-8 with half as many characters.
    await dialog.getByTestId("bundle-import-paste").fill("é".repeat(1024 * 1024 + 1));
    await dialog.getByTestId("bundle-import-paste-preview").click();
    await expect(dialog.getByTestId("bundle-import-paste-error")).toContainText("too large");
    await expect(dialog.getByTestId("bundle-import-status")).toContainText("too large");
    await expect(dialog.getByTestId("bundle-import-paste")).toBeVisible();
    expect(previews).toBe(0);

    // Under 2 MB, but control characters escape to six bytes each in the
    // request body: refused as too large to send, not as over 2 MB.
    await dialog.getByTestId("bundle-import-paste").fill("\u0001".repeat(1024 * 1024));
    await dialog.getByTestId("bundle-import-paste-preview").click();
    await expect(dialog.getByTestId("bundle-import-paste-error")).toContainText("too large to send");
    await expect(dialog.getByTestId("bundle-import-paste-error")).not.toContainText("the limit is 2 MB");
    expect(previews).toBe(0);

    await dialog.getByTestId("bundle-import-close").click();
    const discard = page.getByRole("dialog").filter({ hasText: "Discard the pasted JSON?" });
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "Discard" }).click();
    await expect(dialog).toBeHidden();
  });

  test("(9) a disabled fallback harness can be enabled as part of the import", async ({ page, request, backend }) => {
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    const text = bundleText({
      key: "coder",
      name: "Remote Coder",
      harness: { id: "codex-2", kind: "codex", label: "Codex (second account)" },
      model: "gpt-6.1-sol",
      effort: "high",
    });
    const dialog = await pasteAndPreview(page, section, text);
    const harnessRow = dialog.locator('[data-testid="bundle-import-harness-row"][data-harness-id="codex"]');
    await expect(harnessRow.getByTestId("bundle-import-warning").filter({ hasText: "disabled" })).toBeVisible();
    await harnessRow.getByTestId("bundle-import-harness-enable").click();
    await expect(harnessRow.getByTestId("bundle-import-harness-enable")).toHaveAttribute("aria-checked", "true");
    await expect(harnessRow.getByTestId("bundle-import-warning").filter({ hasText: "disabled" })).toHaveCount(0);
    await dialog.getByTestId("bundle-import-confirm").click();
    await expect(dialog).toBeHidden();

    const { harnesses } = await rest<{ harnesses: HarnessRow[] }>(request, backend, "GET", "/harnesses");
    expect(harnesses.find((h) => h.id === "codex")!.enabled).toBe(true);
    // Settings reloaded its harness list without reopening: the imported
    // Agent's row no longer carries the disabled-harness marker.
    const row = agentRow(section, "Remote Coder");
    await expect(row).toBeVisible();
    await expect(row.getByTestId("agent-profile-card-harness-disabled")).toHaveCount(0);
  });

  test("(10) an unknown harness kind blocks until re-bound; the imported Agent gets the default model", async ({
    page,
    request,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    const text = bundleText({
      key: "future",
      name: "Future Agent",
      harness: { id: "grok-2", kind: "grok", label: "Grok" },
      model: "grok-9",
      effort: "max",
    });
    const dialog = await pasteAndPreview(page, section, text);
    const row = dialog.locator('[data-testid="bundle-import-agent-row"][data-agent-key="future"]');
    await expect(row.getByTestId("bundle-import-blocking")).toContainText("doesn't know");
    await expect(dialog.getByTestId("bundle-import-confirm")).toBeDisabled();
    await row.getByTestId("bundle-import-agent-harness").selectOption("claude-code");
    await expect(row).toHaveAttribute("data-resolution", "rebound", { timeout: CONVERGE_TIMEOUT });
    await expect(dialog.getByTestId("bundle-import-confirm")).toBeEnabled();
    await dialog.getByTestId("bundle-import-confirm").click();
    await expect(dialog).toBeHidden();
    const [agent] = await rest<ProfileRow[]>(request, backend, "GET", "/agent-profiles");
    expect([agent!.name, agent!.harness, agent!.model, agent!.effort]).toEqual([
      "Future Agent",
      "claude-code",
      DEFAULT_MODEL["claude-code"],
      null,
    ]);
  });

  test("(11) an edited name that clashes blocks Confirm; a free one imports", async ({ page, request, backend }) => {
    await createProfile(request, backend, "Existing Agent");
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    const dialog = await pasteAndPreview(page, section, bundleText());
    const name = dialog.getByTestId("bundle-import-agent-name");
    await name.fill("existing agent");
    await expect(dialog.getByTestId("bundle-import-blocking")).toContainText("already in use", { timeout: CONVERGE_TIMEOUT });
    await expect(dialog.getByTestId("bundle-import-confirm")).toBeDisabled();
    await name.fill("Renamed On Import");
    await expect(dialog.getByTestId("bundle-import-blocking")).toHaveCount(0, { timeout: CONVERGE_TIMEOUT });
    await expect(dialog.getByTestId("bundle-import-confirm")).toBeEnabled();
    await dialog.getByTestId("bundle-import-confirm").click();
    await expect(dialog).toBeHidden();
    await expect(agentRow(section, "Renamed On Import")).toBeVisible();
  });

  test("(11b) an Agent whose key shadows Object.prototype shows its own name and bound harness", async ({
    page,
    request,
    backend,
  }) => {
    await createSecondaryHarness(request, backend);
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    // An exported Agent named "Constructor" gets the key "constructor".
    const dialog = await pasteAndPreview(page, section, bundleText({ key: "constructor", name: "Constructor" }));
    const row = dialog.locator('[data-testid="bundle-import-agent-row"][data-agent-key="constructor"]');
    await expect(row).toHaveAttribute("data-resolution", "exact");
    await expect(row.getByTestId("bundle-import-agent-name")).toHaveValue("Constructor");
    await expect(row.getByTestId("bundle-import-agent-harness")).toHaveValue("secondary-claude-code");
    // Re-binding and then picking the original harness again drops the
    // override: the planner's own (exact) resolution comes back.
    const harnessSelect = row.getByTestId("bundle-import-agent-harness");
    await harnessSelect.selectOption("claude-code");
    await expect(row).toHaveAttribute("data-resolution", "mapped", { timeout: CONVERGE_TIMEOUT });
    await harnessSelect.selectOption("secondary-claude-code");
    await expect(row).toHaveAttribute("data-resolution", "exact", { timeout: CONVERGE_TIMEOUT });
    await expect(dialog.getByTestId("bundle-import-confirm")).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await dialog.getByTestId("bundle-import-confirm").click();
    await expect(dialog).toBeHidden();
    await expect(agentRow(section, "Constructor")).toBeVisible();
    const profiles = await rest<ProfileRow[]>(request, backend, "GET", "/agent-profiles");
    expect(profiles.map((p) => [p.name, p.harness])).toEqual([["Constructor", "secondary-claude-code"]]);
  });

  test("(12) a legacy pipeline file shows the legacy badge and imports, matching its Agent by name", async ({
    page,
    request,
    backend,
  }) => {
    const local = await createProfile(request, backend, "Legacy Planner");
    const legacy = JSON.stringify({
      name: "Legacy Flow",
      graph: {
        steps: [
          { id: "s1", name: "Plan", agentProfileId: "id-from-another-machine", profileName: "legacy planner", position: { x: 0, y: 0 } },
        ],
        edges: [],
        startStepId: "s1",
      },
    });
    await gotoApp(page, backend.bootBase);
    const list = await openPipelinesPage(page);
    const dialog = await pasteAndPreview(page, list, legacy);
    await expect(dialog.getByTestId("bundle-import-legacy")).toBeVisible();
    await expect(dialog.getByTestId("bundle-import-pipeline-row")).toContainText("(matched by name)");
    await expect(dialog.getByTestId("bundle-import-pipeline-name")).toHaveValue("Legacy Flow");
    await dialog.getByTestId("bundle-import-confirm").click();
    await expect(dialog).toBeHidden();
    await expect(list.locator('[data-testid="pipelines-row"]').filter({ hasText: "Legacy Flow" })).toBeVisible();
    const [pipeline] = await rest<PipelineRow[]>(request, backend, "GET", "/pipelines");
    expect(pipeline!.graph.steps[0]!.agentProfileId).toBe(local.id);
  });

  test("(14) Settings → Pipelines: a row exports, and a dropped bundle imports with (imported) names", async ({
    page,
    request,
    backend,
  }) => {
    const planner = await createProfile(request, backend, "Planner");
    const builder = await createProfile(request, backend, "Builder");
    const pipeline = await createPipeline(request, backend, "Delivery Flow", planner.id, builder.id);

    await gotoApp(page, backend.bootBase);
    const section = await openSettingsPipelines(page);
    await section
      .locator(`[data-testid="pipelines-section-row"][data-pipeline-id="${pipeline.id}"]`)
      .getByTestId("bundle-row-export")
      .click();
    const exported = exportDialog(page);
    await expect(exported.getByTestId("bundle-export-summary")).toContainText("2 Agents, 1 Pipeline");
    await exported.getByTestId("bundle-export-downloads").click();
    await expect(exported).toBeHidden();
    const file = path.join(backend.downloadsDir, "delivery-flow.agetor.json");
    await expect.poll(() => existsSync(file)).toBe(true);
    const text = await readFile(file, "utf8");
    expect((await readJson(file)).pipelines.map((p) => p.name)).toEqual(["Delivery Flow"]);

    // The same file dropped back onto the section: every name is taken, so
    // the preview renames them, and the import rewires steps to the copies.
    await dropFile(page, section, text);
    const dialog = importDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("bundle-import-pipeline-name")).toHaveValue("Delivery Flow (imported)", {
      timeout: CONVERGE_TIMEOUT,
    });
    await expect(dialog.getByTestId("bundle-import-confirm")).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await dialog.getByTestId("bundle-import-confirm").click();
    await expect(dialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    await expect(
      section.locator('[data-testid="pipelines-section-row"]').filter({ hasText: "Delivery Flow (imported)" }),
    ).toBeVisible();
    const profiles = await rest<ProfileRow[]>(request, backend, "GET", "/agent-profiles");
    const copies = new Map(profiles.map((p) => [p.name, p.id]));
    const imported = (await rest<PipelineRow[]>(request, backend, "GET", "/pipelines")).find(
      (p) => p.name === "Delivery Flow (imported)",
    )!;
    expect(imported.graph.steps.map((st) => st.agentProfileId)).toEqual([
      copies.get("Planner (imported)"),
      copies.get("Builder (imported)"),
    ]);
  });

  test("(15) dropping a bundle onto the Pipelines page opens the import preview and imports", async ({
    page,
    request,
    backend,
  }) => {
    const planner = await createProfile(request, backend, "Planner");
    const builder = await createProfile(request, backend, "Builder");
    const pipeline = await createPipeline(request, backend, "Delivery Flow", planner.id, builder.id);
    const { text } = await rest<{ text: string }>(request, backend, "POST", "/bundle/export", {
      pipelineIds: [pipeline.id],
    });
    // Start from an empty machine: the pipeline and its Agents are recreated
    // under their own names.
    await wipe(request, backend);

    await gotoApp(page, backend.bootBase);
    const list = await openPipelinesPage(page);
    await dropFile(page, list, text);
    const dialog = importDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("bundle-import-pipeline-name")).toHaveValue("Delivery Flow", {
      timeout: CONVERGE_TIMEOUT,
    });
    await expect(dialog.getByTestId("bundle-import-confirm")).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await dialog.getByTestId("bundle-import-confirm").click();
    await expect(dialog).toBeHidden({ timeout: CONVERGE_TIMEOUT });
    await expect(list.locator('[data-testid="pipelines-row"]').filter({ hasText: "Delivery Flow" })).toBeVisible();
    const profiles = await rest<ProfileRow[]>(request, backend, "GET", "/agent-profiles");
    expect(profiles.map((p) => p.name).sort()).toEqual(["Builder", "Planner"]);

    // A non-.json drop on the page is refused with a toast, and opens nothing.
    await dropFile(page, list, "hello", "notes.txt");
    await expect(page.getByText("Can't import that file")).toBeVisible();
    await settleDrop(page);
    await expect(importDialog(page)).toBeHidden();
  });

  test("(16) Escape closes a confirm stacked on the import dialog first, then asks again", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    const dialog = await pasteAndPreview(page, section, bundleText());
    const nameInput = dialog.getByTestId("bundle-import-agent-name");
    await expect(dialog.getByTestId("bundle-import-confirm")).toBeEnabled({ timeout: CONVERGE_TIMEOUT });
    await nameInput.fill("Escaped Worker");
    await dialog.getByTestId("bundle-import-close").click();
    const discard = page.getByRole("dialog").filter({ hasText: "Discard this import?" });
    await expect(discard).toBeVisible();
    // The first Escape closes only the confirm on top; the import keeps its edit.
    await page.keyboard.press("Escape");
    await expect(discard).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(nameInput).toHaveValue("Escaped Worker");
    // The next Escape is the import dialog's own, which asks again.
    await nameInput.focus();
    await page.keyboard.press("Escape");
    await expect(discard).toBeVisible();
    await expect(dialog).toBeVisible();
    await discard.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(dialog).toBeHidden();
    // Settings stays open underneath: only the import dialog closed.
    await expect(section).toBeVisible();
  });

  test("(17) names that differ only by an invisible character export distinct, with a warning, and re-import unrenamed", async ({
    page,
    request,
    backend,
  }) => {
    // The app stores both names: `name_key` is lower(trim(name)), which keeps
    // the zero-width space. Export cleaning would make them equal.
    await createProfile(request, backend, "Reviewer");
    await createProfile(request, backend, "Reviewer\u200b");

    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    await section.getByTestId("bundle-export-all").click();
    const exp = exportDialog(page);
    await expect(exp.getByTestId("bundle-export-summary")).toContainText("2 Agents");
    // The helper's instructions quote the name, so they carry the U+200B too.
    await expect(exp.getByTestId("bundle-export-warning")).toHaveText([
      'Agent "Reviewer 2": control or invisible characters were removed from its name, instructions; after cleanup its name matched another one in this export, so it was renamed to keep them distinct',
    ]);
    // The Downloads seam folder is shared by the whole spec: an earlier
    // test's export of the same name is already there, so look for the new one.
    const before = new Set(await readdir(backend.downloadsDir).catch(() => [] as string[]));
    await exp.getByTestId("bundle-export-downloads").click();
    await expect(exp).toBeHidden();
    let saved = "";
    await expect
      .poll(async () => {
        const files = await readdir(backend.downloadsDir).catch(() => [] as string[]);
        saved = files.find((f) => !before.has(f) && /^agetor-export-\d{4}-\d{2}-\d{2}( \(\d+\))?\.agetor\.json$/.test(f)) ?? "";
        return saved;
      })
      .not.toBe("");
    const text = await readFile(path.join(backend.downloadsDir, saved), "utf8");
    expect((await readJson(path.join(backend.downloadsDir, saved))).agents.map((a) => a.name).sort()).toEqual([
      "Reviewer",
      "Reviewer 2",
    ]);

    // A fresh machine: the file's two names don't clash with each other, so
    // neither is renamed "(imported)".
    await wipe(request, backend);
    const dialog = await pasteAndPreview(page, section, text);
    const names = dialog.getByTestId("bundle-import-agent-name");
    await expect(names).toHaveCount(2);
    await expect(names.nth(0)).toHaveValue("Reviewer");
    await expect(names.nth(1)).toHaveValue("Reviewer 2");
    await expect(dialog.getByTestId("bundle-import-confirm")).toBeEnabled();
    await dialog.getByTestId("bundle-import-confirm").click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Imported 2 Agents")).toBeVisible();
    const profiles = await rest<ProfileRow[]>(request, backend, "GET", "/agent-profiles");
    expect(profiles.map((p) => p.name).sort()).toEqual(["Reviewer", "Reviewer 2"]);
  });

  test("(13) invalid JSON and a newer format version show an error", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    const dialog = await pasteAndPreview(page, section, "{ not json");
    await expect(dialog.getByTestId("bundle-import-error")).toContainText("invalid JSON");
    await expect(dialog.getByTestId("bundle-import-confirm")).toBeDisabled();

    await dialog.getByTestId("bundle-import-back").click();
    await dialog.getByTestId("bundle-import-paste").fill(JSON.stringify({ format: "agetor-bundle", version: 2, agents: [] }));
    await dialog.getByTestId("bundle-import-paste-preview").click();
    await expect(dialog.getByTestId("bundle-import-error")).toContainText("update agetor to import this file");
  });
});
