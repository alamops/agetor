import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp, putPreference, selectProject } from "./helpers";
import {
  plantFakeCodexAppServer,
  writeFakeCodexCatalog,
  type FakeCodexModel,
} from "../src/bun/test-codex-app-server.ts";
import { AGENT_OPTIONS, CODE_PLAN_MODE, DEFAULT_MODEL } from "../src/shared/types.ts";
import { expectHarness, modeField, modelField, newTaskPanel, openMore, type PickerHandle } from "./launch-helpers";

/**
 * E2E coverage for the codex side of docs/plans/dynamic-model-catalog.md:
 * a trusted codex catalog is authoritative (`CLI_AUTHORITATIVE_CATALOG_KINDS`),
 * so a built-in row the CLI does not list is never offered (pre-flight would
 * refuse it), and a remembered `lastModel:codex` naming such a row must not
 * leave the New Task form on it (review S-A: `seedModelStep` in
 * `src/shared/model-catalog.ts`, the seed effect in `NewTaskForm.tsx`).
 *
 * The backend's codex is a stub (`plantFakeCodexAppServer` with `version` and
 * `catalogFile`): it answers `--version` (so the harness reads as installed)
 * and serves `model/list` from a file read on every request, so a test can
 * change what the CLI reports while the backend runs. Its list carries the
 * owner's default (`DEFAULT_MODEL.codex`), one other built-in row and one id
 * only the CLI knows; it lacks the built-in `gpt-5.6-*` rows.
 *
 * 1. Catalog loaded before the form opens: a remembered unlisted built-in
 *    model starts the form on the default, and the picker does not offer it.
 * 2. Remembered models the CLI does list (built-in, then CLI-only) are kept.
 * 3. A task stored on an unlisted model keeps it in the run panel editor, as
 *    an unlisted row with an honest hint.
 * 4. Catalog lands after the form opened: the remembered built-in model is
 *    applied while only the curated rows vouch for it, then the form moves to
 *    the default once the catalog lands without it.
 */

const CODEX_VERSION = "codex-cli 0.166.0";
/** The owner's default, which the stub lists. */
const DEFAULT = DEFAULT_MODEL.codex;
/** Built-in rows the stub's list lacks. */
const UNLISTED = "gpt-5.6-sol";
const ALSO_UNLISTED = "gpt-5.6-terra";
/** A built-in row the stub lists. */
const LISTED_BUILTIN = "gpt-6-astra";
/** An id only the CLI knows. */
const CLI_ONLY = "gpt-7-e2e";

const CATALOG: FakeCodexModel[] = [
  { id: CLI_ONLY, displayName: "GPT-7 E2E", efforts: ["low", "high"] },
  { id: DEFAULT, displayName: "GPT-6.1 Sol", efforts: ["low", "medium", "high"] },
  { id: LISTED_BUILTIN, displayName: "GPT-6 Astra", efforts: ["low", "medium", "high"] },
];

/** One stub per backend configuration. Under /tmp: a short path, and never a
 *  bloated $TMPDIR. */
function plantCodexStub(withCatalog: boolean): { bin: string; catalogFile: string } {
  const dir = mkdtempSync(path.join("/tmp", "agetor-e2e-codex-models-"));
  const catalogFile = path.join(dir, "model-list.json");
  if (withCatalog) writeFakeCodexCatalog(catalogFile, CATALOG);
  const bin = plantFakeCodexAppServer({ pages: [], dir, version: CODEX_VERSION, catalogFile });
  return { bin, catalogFile };
}

const LOADED_STUB = plantCodexStub(true);
const LATE_STUB = plantCodexStub(false);

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
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

/** The built-in codex row ships disabled; enabling it probes its catalog
 *  (`refreshHarnessModels`). */
async function enableCodex(backend: E2EBackend): Promise<void> {
  const res = await fetch(`${backend.apiBase}/harnesses/codex`, {
    method: "PATCH",
    headers: { ...auth(backend), "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  if (!res.ok) throw new Error(`PATCH /harnesses/codex -> ${res.status}: ${await res.text()}`);
}

/** The ids the core currently holds for the built-in codex harness. */
async function codexCatalogIds(request: APIRequestContext, backend: E2EBackend): Promise<string[]> {
  const res = await request.get(`${backend.apiBase}/agent-models/harnesses`, { headers: auth(backend) });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { byHarness: Record<string, { id: string }[]> };
  return (body.byHarness.codex ?? []).map((m) => m.id);
}

async function waitForCodexCatalog(request: APIRequestContext, backend: E2EBackend): Promise<void> {
  await expect
    .poll(() => codexCatalogIds(request, backend), {
      timeout: 20_000,
      message: "the core never loaded the codex stub's model list",
    })
    .toContain(CLI_ONLY);
}

function newTaskForm(page: Page): Locator {
  return page.locator("aside").first();
}

function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

/** The New Task form's Model `<select>` (see e2e/claude-models.spec.ts). */
function modelSelect(page: Page): PickerHandle {
  return modelField(newTaskPanel(page));
}

/** Row values of a launch picker, or of a native `<select>` (the run panel's details editor). */
async function optionValues(select: PickerHandle | Locator): Promise<string[]> {
  if ("optionValues" in select) return select.optionValues();
  return select.locator("option").evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value));
}

/**
 * Remember `model`, plus `defaultHarness: codex` as the positive signal that
 * the remembered picks have been read (the model assertions that follow would
 * otherwise pass before a wrong seed lands). Codex offers no Code mode besides
 * its default, so a remembered mode can't be that signal; a remembered `ask`
 * (codex's Plan) is still stored, and the form must ignore it.
 */
async function rememberCodexPicks(request: APIRequestContext, backend: E2EBackend, model: string): Promise<void> {
  await putPreference(request, backend, "lastModel:codex", model);
  await putPreference(request, backend, "lastMode:codex", "ask");
  await putPreference(request, backend, "defaultHarness", "codex");
}

/** Open the New Task form and wait until the remembered picks are applied: the
 *  form lands on Codex by itself (`defaultHarness` applies only once the
 *  preferences are read, in the same step that seeds the remembered picks), and
 *  starts in Code even though `lastMode:codex` says `ask`. */
async function openFormOnCodex(page: Page, backend: E2EBackend, projectName: string): Promise<Locator> {
  await gotoApp(page, backend.bootBase);
  const form = newTaskForm(page);
  await expectHarness(form, "Codex");
  await selectProject(page, form, projectName);
  await openMore(form);
  await modeField(form).expectValue(CODE_PLAN_MODE.codex.code, { timeout: 15_000 });
  return form;
}

test.describe("Codex model catalog from the CLI", () => {
  test.describe.configure({ timeout: 90_000 });

  test("the premise holds: the stub lacks built-in rows, lists one, and adds one agetor has no row for", () => {
    const builtIn = AGENT_OPTIONS.codex.models.map((m) => m.id);
    for (const id of [DEFAULT, UNLISTED, ALSO_UNLISTED, LISTED_BUILTIN]) expect(builtIn, id).toContain(id);
    expect(builtIn).not.toContain(CLI_ONLY);
    const listed = CATALOG.map((m) => m.id);
    expect(listed).not.toContain(UNLISTED);
    expect(listed).not.toContain(ALSO_UNLISTED);
  });

  test.describe("the catalog is loaded before the form opens", () => {
    test.use({ backendEnv: { AGETOR_CODEX_BIN: LOADED_STUB.bin } });

    test("a remembered built-in model the CLI's list lacks starts the form on the default, and the picker doesn't offer it", async ({
      page,
      request,
      freshBackend,
    }) => {
      const projectName = `codex-models-e2e-${randomUUID()}`;
      await registerProject(freshBackend, projectName);
      await rememberCodexPicks(request, freshBackend, UNLISTED);
      await enableCodex(freshBackend);
      await waitForCodexCatalog(request, freshBackend);

      await openFormOnCodex(page, freshBackend, projectName);
      const select = modelSelect(page);
      await select.expectValue(DEFAULT);
      const values = await optionValues(select);
      expect(values).toEqual(expect.arrayContaining([CLI_ONLY, DEFAULT, LISTED_BUILTIN]));
      // Every row the CLI did not list would be refused at start: none is offered.
      expect(values).not.toContain(UNLISTED);
      expect(values).not.toContain(ALSO_UNLISTED);
      expect(new Set(values).size).toBe(values.length);
    });

    test("a remembered model the CLI does list is kept: a built-in one, then one only the CLI knows", async ({
      page,
      request,
      freshBackend,
    }) => {
      const projectName = `codex-models-kept-e2e-${randomUUID()}`;
      await registerProject(freshBackend, projectName);
      await rememberCodexPicks(request, freshBackend, LISTED_BUILTIN);
      await enableCodex(freshBackend);
      await waitForCodexCatalog(request, freshBackend);

      await openFormOnCodex(page, freshBackend, projectName);
      await modelSelect(page).expectValue(LISTED_BUILTIN);

      await putPreference(request, freshBackend, "lastModel:codex", CLI_ONLY);
      await page.reload();
      await openFormOnCodex(page, freshBackend, projectName);
      await modelSelect(page).expectValue(CLI_ONLY, { timeout: 15_000 });
    });

    test("a task stored on a model the CLI no longer lists keeps it in the run panel editor, marked as not in the CLI's list", async ({
      page,
      request,
      freshBackend,
    }) => {
      await enableCodex(freshBackend);
      await waitForCodexCatalog(request, freshBackend);
      const workdir = path.join(freshBackend.dataDir, "e2e-task-workdir");
      mkdirSync(workdir, { recursive: true });
      const title = `codex unlisted ${randomUUID().slice(0, 8)}`;
      const created = await request.post(`${freshBackend.apiBase}/tasks`, {
        headers: auth(freshBackend),
        data: { title, prompt: "p", agent: "codex", model: UNLISTED, isolation: "none", workdir },
      });
      expect(created.ok(), await created.text()).toBeTruthy();

      await gotoApp(page, freshBackend.bootBase);
      const card = page.getByText(title, { exact: true }).first();
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.click();
      const panel = runPanel(page);
      await panel.getByText("Task details", { exact: true }).click();
      const panelModel = panel.locator("select").filter({ has: page.locator(`option[value="${CLI_ONLY}"]`) }).first();
      await expect(panelModel).toHaveValue(UNLISTED, { timeout: 15_000 });
      await expect(panelModel.locator(`option[value="${UNLISTED}"]`)).toHaveAttribute("title", /Not in this CLI's model list/);
      const values = await optionValues(panelModel);
      expect(values.filter((v) => v === UNLISTED)).toHaveLength(1);
      // The other rows the CLI lacks are still not offered next to it.
      expect(values).not.toContain(ALSO_UNLISTED);
      expect(values).toEqual(expect.arrayContaining([CLI_ONLY, DEFAULT, LISTED_BUILTIN]));
    });
  });

  test.describe("the catalog lands after the form applied the remembered model", () => {
    test.use({ backendEnv: { AGETOR_CODEX_BIN: LATE_STUB.bin } });

    test("a remembered built-in model shown while only the curated rows vouch for it moves to the default once the catalog lands without it", async ({
      page,
      request,
      freshBackend,
    }) => {
      const projectName = `codex-models-late-e2e-${randomUUID()}`;
      await registerProject(freshBackend, projectName);
      await rememberCodexPicks(request, freshBackend, UNLISTED);
      // The stub has no list yet: enabling probes it and finds nothing.
      await enableCodex(freshBackend);

      const form = await openFormOnCodex(page, freshBackend, projectName);
      const select = modelSelect(page);
      // No trusted catalog: the curated rows are all offered and the remembered one is applied.
      await select.expectValue(UNLISTED, { timeout: 15_000 });
      expect(await optionValues(select)).toContain(ALSO_UNLISTED);

      // The CLI now reports its list (without the remembered model); the manual
      // refresh probes it again and refetches.
      writeFakeCodexCatalog(LATE_STUB.catalogFile, CATALOG);
      await form.getByTestId("launch-refresh-models").click();
      await expect
        .poll(() => optionValues(select), { timeout: 20_000, message: "the refreshed codex list never reached the picker" })
        .toContain(CLI_ONLY);
      await select.expectValue(DEFAULT, { timeout: 15_000 });
      const values = await optionValues(select);
      expect(values).not.toContain(UNLISTED);
      expect(values).not.toContain(ALSO_UNLISTED);
    });
  });
});
