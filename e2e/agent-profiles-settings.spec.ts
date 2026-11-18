import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";
import { AGENT_PROFILE_LIMITS } from "../src/shared/agent-profile.ts";

/**
 * E2e coverage for the Settings → Agents surface itself (docs/plans/agent-
 * profiles.md §1/§3) — `e2e/agent-profiles.spec.ts` already covers the
 * launch-side flow (New Task picker → run → transcript → freeze → delete),
 * so this file goes deep on the Settings form/list instead: validation,
 * edit-seeding (the exact race `docs/plans/agent-profiles.md` §10's "Review"
 * notes call out — `useTaskLaunch`'s `initial` option), the `SkillsPicker`'s
 * keyboard/mouse contract, the cursor speed picker and max-mode toggle, the
 * disabled-harness marker, the harness-delete guard, duplicate-name/task-count
 * edge cases — and (docs/plans/agents-new-edit-subpage.md) the Add/Edit
 * SUBPAGE: "Add agent" / a row's "Edit" replace the list inside the Settings
 * modal with an editor page (heading "Add agent"/"Edit agent", a header Back
 * button, sidebar "Agents" still current), Back/Escape/backdrop pop to the
 * list, and every exit but the form's own Cancel asks "Discard unsaved
 * changes?" when the draft is dirty. The same guard on the harness editor
 * lives in `e2e/settings-subpage-guard.spec.ts`; the pipeline step's "New
 * agent" dialog is covered in `e2e/pipelines-editor.spec.ts`. This file also
 * covers Duplicate → prefilled subpage → save.
 *
 * One serial `describe` sharing the worker backend (`e2e/fixtures.ts`) and
 * building on itself exactly like `e2e/agent-profiles.spec.ts` does: scenario
 * 1 creates "Widget Builder", scenario 2 edits it (no-op save), scenario 8
 * renames a fresh profile to clash with it. Scenarios 3/4 use their own
 * disposable Add-form drafts (never saved). Scenarios 5/6 bind profiles to
 * the built-in `cursor` harness, which ships disabled (migration 032) — each
 * enables it via REST first.
 *
 * `SkillsPicker` discovery reads the REAL `~/.claude` of the machine running
 * this suite (`GET /agent-discovery?agent=claude-code`, no workdir), so its
 * *extra* rows are environment-dependent — but `/code-review` and `/simplify`
 * are hardcoded `CLAUDE_BUILTINS` (`src/bun/commands.ts`) always present
 * regardless of environment, appended last, which is why scenario 3 targets
 * those two names specifically (mirroring `e2e/agent-profiles.spec.ts`'s
 * `addSkill` helper's own doc comment).
 *
 * A note on one sub-step of scenario 3: the task brief this file was written
 * against described "Tab with the suggestion list closed" as a no-op. Reading
 * `SkillsPicker.tsx`'s `onKeyDown` (and its own module doc comment — "Enter /
 * Tab / `,` commits the highlighted suggestion when the popover is showing
 * one, else the typed text") shows Tab commits non-empty typed free text
 * exactly like Enter/",", regardless of whether the popover is open — the
 * real "no commit, focus moves" case is an INPUT that normalizes to empty
 * (blank, or a bare "/"), not "list closed" per se. Scenario 3 tests the
 * actual, correct behavior on both sides of that line rather than asserting
 * something the component was never built to do — see its own inline
 * comments for the two sub-cases and CLAUDE.md/AGENTS instructions' "keep the
 * correct assertion, report expected vs actual" rule.
 */

test.describe.configure({ mode: "serial" });

const CONVERGE_TIMEOUT = 20_000;

const WIDGET_BUILDER_NAME = `Widget Builder ${randomUUID()}`;
const WIDGET_BUILDER_INSTRUCTIONS = "Always sand the edges before painting.";
let widgetBuilderId = "";

// Non-builtin harness + its bound profile, created in scenario 7 and torn
// down by the end of that same scenario (the profile is deleted so the
// harness delete can succeed) — nothing later depends on either surviving.
let guardHarnessId = "";
let guardProfileId = "";

// Every OTHER profile this file creates and saves (via REST or the Settings
// UI) that isn't already torn down inline by its own scenario — tracked here
// so `afterAll` can delete them. This worker's backend is shared by every
// spec file in this run (`e2e/fixtures.ts`), so a profile left behind here
// would otherwise leak into another file's absolute-count assertions.
const createdProfileIds: string[] = [];

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

// ---- Locator helpers ----

/** Opens Settings and switches to the Agents section — mirrors
 *  `e2e/agent-profiles.spec.ts`'s identical helper. */
async function openSettingsAgents(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  await dialog.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(dialog.getByTestId("agent-profiles-section")).toBeVisible();
  return dialog;
}

/** Opens Settings and switches to the Harnesses section. */
async function openSettingsHarnesses(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  await dialog.getByRole("button", { name: "Harnesses", exact: true }).click();
  return dialog;
}

test.afterAll(async ({ backend }) => {
  // Best-effort cleanup for anything a failed scenario left dangling — uses
  // raw `fetch` rather than the `request` fixture (test-scoped, not safely
  // available in `afterAll`), mirroring `e2e/agent-profiles.spec.ts`'s own
  // afterAll. Never blocks teardown.
  const headers = { ...auth(backend), "content-type": "application/json" };
  for (const id of createdProfileIds.splice(0)) {
    await fetch(`${backend.apiBase}/agent-profiles/${id}`, { method: "DELETE", headers }).catch(() => {});
  }
  if (guardProfileId) {
    await fetch(`${backend.apiBase}/agent-profiles/${guardProfileId}`, { method: "DELETE", headers }).catch(
      () => {},
    );
  }
  if (guardHarnessId) {
    await fetch(`${backend.apiBase}/harnesses/${guardHarnessId}`, { method: "DELETE", headers }).catch(() => {});
  }
  // Leave cursor disabled — its shipped-disabled default — rather than
  // leaking an enabled state into whatever runs next on this worker.
  await fetch(`${backend.apiBase}/harnesses/cursor`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ enabled: false }),
  }).catch(() => {});
});
