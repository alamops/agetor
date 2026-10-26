import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * E2E coverage for docs/plans/fx-0.0.14-and-cursor-updates.md E4 (D33 flow
 * 4): the fx harness's Settings surface and fx 0.0.14's tool-call identity
 * metadata in the transcript.
 *
 * - The "Load profile MCP servers" switch (`harness-profile-mcp-toggle`,
 *   `Harness.profileMcpServers`, absent ⇒ on) persists through a reload.
 * - The Ask hint (`harness-fx-ask-hint`) shows for a harness whose
 *   `fx status --json` reports `permission_mode: "ask"`
 *   (`HarnessStatus.fxProfilePermissionMode`) and not for `"auto"`.
 * - The fake fx driver's tool-meta scenario: the internal
 *   `capability_search` call is never rendered, the MCP call reads
 *   "e2e-mcp · lookup", and the structured notice becomes a status line.
 *
 * Per-harness status answers come from e2e/fixtures.ts's fx stub, which
 * prints the file named by `AGETOR_E2E_FX_STATUS_JSON` for `status --json`
 * when that variable is set. It's set here through each additional
 * harness's own `env` map — the same `harnessEnv` merge the real status
 * probe and model discovery use — so the first test proves that path over
 * REST before any UI assertion leans on it.
 */

/** Literal copy of `FAKE_FX_TOOL_META_PROMPT_MARKER` (src/bun/agents.ts) —
 *  a Playwright spec can't import `src/bun/*` (`bun:sqlite` doesn't resolve
 *  under Node's loader), same rationale as e2e/fx-interactions.spec.ts. */
const FAKE_FX_TOOL_META_PROMPT_MARKER = "__agetor_fake_fx_tool_meta__";

test.describe.configure({ mode: "serial" });

const suffix = randomUUID().slice(0, 8);
const ASK_HARNESS = { id: `fx-ask-e2e-${suffix}`, label: `fx.sh (ask profile e2e ${suffix})` };
const AUTO_HARNESS = { id: `fx-auto-e2e-${suffix}`, label: `fx.sh (auto profile e2e ${suffix})` };

const createdTaskIds: string[] = [];

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

/** Writes a `status --json` answer file for one harness and returns its path. */
function writeStatusFile(backend: E2EBackend, name: string, body: Record<string, unknown>): string {
  const dir = path.join(backend.dataDir, "fx-harness-settings-e2e");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(body));
  return file;
}

async function createFxHarness(
  backend: E2EBackend,
  harness: { id: string; label: string },
  env: Record<string, string>,
): Promise<void> {
  const res = await fetch(`${backend.apiBase}/harnesses`, {
    method: "POST",
    headers: { ...auth(backend), "content-type": "application/json" },
    body: JSON.stringify({ id: harness.id, kind: "fx", label: harness.label, home: null, bin: null, env }),
  });
  if (!res.ok) throw new Error(`POST /harnesses -> ${res.status}: ${await res.text()}`);
}

async function enableBuiltinFx(backend: E2EBackend): Promise<void> {
  const res = await fetch(`${backend.apiBase}/harnesses/fx`, {
    method: "PATCH",
    headers: { ...auth(backend), "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  if (!res.ok) throw new Error(`PATCH /harnesses/fx -> ${res.status}: ${await res.text()}`);
}

interface HarnessesPayload {
  harnesses: Array<{ id: string; profileMcpServers?: boolean }>;
  statuses: Array<{ harnessId: string; fxProfilePermissionMode?: string | null }>;
}

async function getHarnesses(request: APIRequestContext, backend: E2EBackend): Promise<HarnessesPayload> {
  const res = await request.get(`${backend.apiBase}/harnesses`, { headers: auth(backend) });
  expect(res.ok(), `GET /harnesses -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as HarnessesPayload;
}

/** Opens Settings and switches to the Harnesses section. */
async function openSettingsHarnesses(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  await dialog.getByRole("button", { name: "Harnesses", exact: true }).click();
  return dialog;
}

/** One harness's profile-MCP switch, by its accessible name (the rows carry
 *  no test id of their own; the switch's `aria-label` names the harness). */
function profileMcpSwitch(dialog: Locator, label: string): Locator {
  return dialog.getByRole("switch", { name: `Load profile MCP servers for ${label}`, exact: true });
}

/** The harness row around one of its controls — the bordered card that
 *  wraps the header line, the profile-MCP line and the Ask hint. */
function harnessRow(control: Locator): Locator {
  return control.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' rounded-md ')][1]");
}

function runPanel(page: Page): Locator {
  return page.locator("aside").last();
}

async function openTask(page: Page, title: string): Promise<Locator> {
  await page.getByText(title, { exact: true }).first().click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

test.describe("fx harness settings (fx 0.0.14)", () => {
  test.beforeAll(async ({ backend }) => {
    await enableBuiltinFx(backend);
    const askFile = writeStatusFile(backend, "ask", { auth: "AI_GATEWAY_API_KEY", permission_mode: "ask" });
    const autoFile = writeStatusFile(backend, "auto", { auth: "AI_GATEWAY_API_KEY", permission_mode: "auto" });
    await createFxHarness(backend, ASK_HARNESS, { AGETOR_E2E_FX_STATUS_JSON: askFile });
    await createFxHarness(backend, AUTO_HARNESS, { AGETOR_E2E_FX_STATUS_JSON: autoFile });
  });

  test.afterAll(async ({ backend }) => {
    for (const id of createdTaskIds) {
      await fetch(`${backend.apiBase}/tasks/${id}`, { method: "DELETE", headers: auth(backend) }).catch(() => {});
    }
    for (const h of [ASK_HARNESS, AUTO_HARNESS]) {
      await fetch(`${backend.apiBase}/harnesses/${h.id}`, { method: "DELETE", headers: auth(backend) }).catch(() => {});
    }
  });

  test("the stub's status --json answer reaches the probe through the harness env map", async ({
    request,
    backend,
  }) => {
    const payload = await getHarnesses(request, backend);
    const byId = new Map(payload.statuses.map((s) => [s.harnessId, s]));
    expect(byId.get(ASK_HARNESS.id)?.fxProfilePermissionMode).toBe("ask");
    expect(byId.get(AUTO_HARNESS.id)?.fxProfilePermissionMode).toBe("auto");
    // The built-in fx harness has no env seam, so the stub prints nothing
    // for `status --json` and the probe fails open, exactly as before.
    expect(byId.get("fx")?.fxProfilePermissionMode ?? null).toBeNull();
  });

  test("Ask hint: shown for permission_mode ask, absent for auto", async ({ page, backend }) => {
    await gotoApp(page, backend.bootBase);
    const dialog = await openSettingsHarnesses(page);

    const askRow = harnessRow(profileMcpSwitch(dialog, ASK_HARNESS.label));
    const autoRow = harnessRow(profileMcpSwitch(dialog, AUTO_HARNESS.label));
    await expect(askRow.getByText(ASK_HARNESS.label, { exact: true })).toBeVisible();
    await expect(autoRow.getByText(AUTO_HARNESS.label, { exact: true })).toBeVisible();

    // Statuses arrive in one `GET /harnesses` answer, so once the ask row's
    // hint is up the auto row's status is loaded too — its absence below is
    // a real "no hint", not "not probed yet".
    const hint = askRow.getByTestId("harness-fx-ask-hint");
    await expect(hint).toBeVisible({ timeout: 15_000 });
    await expect(hint).toContainText("fx's own profile starts in Ask mode");
    await expect(hint).toContainText("/permissions");
    await expect(autoRow.getByTestId("harness-fx-ask-hint")).toHaveCount(0);
    // Exactly one hint in the whole list: the built-in fx row (no status
    // answer) shows none either.
    await expect(dialog.getByTestId("harness-fx-ask-hint")).toHaveCount(1);
  });

  test("profile-MCP toggle: defaults on, persists off across a reload, and back on", async ({
    page,
    request,
    backend,
  }) => {
    await gotoApp(page, backend.bootBase);
    let dialog = await openSettingsHarnesses(page);
    let toggle = profileMcpSwitch(dialog, ASK_HARNESS.label);
    await expect(toggle).toHaveAttribute("data-testid", "harness-profile-mcp-toggle");
    // Absent ⇒ on.
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect
      .poll(async () => (await getHarnesses(request, backend)).harnesses.find((h) => h.id === ASK_HARNESS.id)?.profileMcpServers)
      .toBe(false);
    // The other fx harness is untouched.
    await expect(profileMcpSwitch(dialog, AUTO_HARNESS.label)).toHaveAttribute("aria-checked", "true");

    await page.reload();
    await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
    dialog = await openSettingsHarnesses(page);
    toggle = profileMcpSwitch(dialog, ASK_HARNESS.label);
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(async () => (await getHarnesses(request, backend)).harnesses.find((h) => h.id === ASK_HARNESS.id)?.profileMcpServers)
      .toBe(true);
  });

  test("tool meta: the internal call is hidden, the MCP call reads server · tool, the notice renders", async ({
    page,
    request,
    backend,
  }) => {
    const title = `fx-tool-meta-e2e ${randomUUID()}`;
    const createRes = await request.post(`${backend.apiBase}/tasks`, {
      headers: auth(backend),
      data: {
        title,
        prompt: `${FAKE_FX_TOOL_META_PROMPT_MARKER} ${title}`,
        agent: "fx",
        isolation: "none",
        workdir: tmpdir(),
      },
    });
    expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
    const task = (await createRes.json()) as { id: string };
    createdTaskIds.push(task.id);
    const startRes = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, { headers: auth(backend) });
    expect(startRes.ok(), `POST /tasks/${task.id}/start -> ${startRes.status()}`).toBeTruthy();

    await gotoApp(page, backend.bootBase);
    const panel = await openTask(page, title);

    await expect(panel.getByText("Looked it up: alpha is 42.", { exact: true })).toBeVisible({ timeout: 15_000 });

    // The MCP call is labelled `server · tool`, not fx's flattened id.
    await expect(panel.getByText("e2e-mcp · lookup", { exact: true })).toBeVisible();
    // The structured notice is one status line.
    await expect(panel.getByText("⚠ fx: e2e notice", { exact: true })).toBeVisible();

    // The internal discovery call and its result are persisted but never
    // rendered: neither fx's tool id, its title nor its result text shows.
    await expect(panel.getByText("capability_search")).toHaveCount(0);
    await expect(panel.getByText("Search capabilities")).toHaveCount(0);
    await expect(panel.getByText("1 capability: e2e-mcp · lookup")).toHaveCount(0);

    // ...while the rows themselves are still in the stored history.
    const eventsRes = await request.get(
      `${backend.apiBase}/tasks/${task.id}/events/page?beforeId=${Number.MAX_SAFE_INTEGER}&limit=200`,
      { headers: auth(backend) },
    );
    expect(eventsRes.ok(), `GET events/page -> ${eventsRes.status()}`).toBeTruthy();
    expect(await eventsRes.text()).toContain("capability_search");
  });
});
