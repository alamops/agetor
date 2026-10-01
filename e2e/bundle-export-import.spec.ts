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

  test("(7) Choose file imports the picked .json file", async ({ page, backend }) => {
    await backend.plantPicks({ "picked.agetor.json": bundleText({ name: "Picked Agent", key: "picked" }) });
    await gotoApp(page, backend.bootBase);
    const section = await openSettingsAgents(page);
    await section.getByTestId("bundle-import-open").click();
    const dialog = importDialog(page);
    await dialog.getByTestId("bundle-import-choose-file").click();
    await expect(dialog.getByText("picked.agetor.json")).toBeVisible();
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
    await expect(importDialog(page)).toBeHidden();
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
