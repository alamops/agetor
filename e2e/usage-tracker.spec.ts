import { test, expect } from "./fixtures";
import { gotoApp, seedHarnessUsage } from "./helpers";
import type { HarnessQuota } from "../src/shared/types.ts";

/**
 * E2E coverage for the per-harness usage tracker as the app bar shows it
 * (docs/plans/harness-usage-tracker.md, docs/architecture/app-bar.md): the
 * single Harnesses button carries one meter, and its panel lists every meter,
 * the plan type and a manual Refresh button per account
 * (`src/mainview/components/app-bar/`).
 *
 * There is no ingestion route that works offline — the only way to populate
 * a `HarnessQuota` is `POST /harnesses/:id/usage/refresh`, which calls out to
 * the real provider (Anthropic/OpenAI/Cursor). So this spec seeds a known
 * snapshot directly into the worker's isolated SQLite DB via
 * `seedHarnessUsage` (e2e/helpers.ts) *before* navigating — App.tsx's
 * `GET /usage` boot-seed (fired once at mount, src/mainview/App.tsx) is what
 * turns that row into the `usage` state the bar renders from.
 *
 * Only the built-in `claude-code` harness is enabled by default (see
 * migration 038's seed data), and `AGETOR_CLAUDE_BIN`/`AGETOR_TMUX_BIN`
 * point at `/bin/echo` in every worker's backend (e2e/fixtures.ts), so its
 * account is deterministically available — no dependency on a real
 * `claude`/`tmux` install on the machine running these tests. The other
 * built-ins seeded by migration 046 (`codex`, `cursor`, `gemini`, `fx`) ship
 * `enabled=0` and `visibleTopbarAgents` (src/mainview/lib/usage.ts) keeps the
 * bar's model to enabled harnesses only, so none of them gets a row in the
 * panel.
 *
 * Assert DOM structure/classes/text — same convention as theme.spec.ts and
 * font-size.spec.ts (real Chromium against the real webview + a real Bun
 * API/orchestrator, no mocked fetches, no screenshot diffs).
 */

const NOW = Date.now();
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** The bar's meter is the tightest unit's worst BLOCKING meter — the 95%
 *  "Weekly" one (`seven_day`) — so the button's meter and its tier color are
 *  driven by that one, while the panel lists both. 95 >= USAGE_CRIT_PERCENT
 *  (90) so the meter and the "Weekly" row both render with the crit
 *  `bg-danger` fill class. */
function claudeCodeQuota(): HarnessQuota {
  return {
    harnessId: "claude-code",
    kind: "claude-code",
    planType: "max",
    status: "ok",
    source: "cache",
    fetchedAtMs: NOW,
    meters: [
      { id: "five_hour", label: "Session (5h)", usedPercent: 42, resetsAtMs: NOW + 3 * HOUR_MS },
      { id: "seven_day", label: "Weekly", usedPercent: 95, resetsAtMs: NOW + 2 * DAY_MS },
    ],
    reason: null,
  };
}

test("the Harnesses button shows the worst-meter bar, its panel lists the meter rows, plan and Refresh; Escape closes it", async ({
  page,
  request,
  backend,
}) => {
  // The "disabled harnesses get no row" assertion below needs the other
  // built-ins at their shipped default (disabled), but this worker's backend
  // is shared with sibling spec files that enable some of them (the fx
  // specs enable fx.sh, agent-profiles-* enable cursor/gemini) — so pin that
  // precondition here instead of relying on file order. Every such sibling
  // enables what it needs itself, so this can't leak the other way.
  for (const id of ["codex", "cursor", "gemini", "fx"]) {
    const res = await request.patch(`${backend.apiBase}/harnesses/${id}`, {
      headers: { authorization: `Bearer ${backend.apiToken}` },
      data: { enabled: false },
    });
    expect(res.ok(), `PATCH /harnesses/${id} -> ${res.status()}`).toBeTruthy();
  }
  seedHarnessUsage(backend, claudeCodeQuota());
  await gotoApp(page, backend.bootBase);

  // The button's meter only appears once both `GET /harnesses` (agents and
  // harnesses lists) and `GET /usage` (this test's seeded snapshot) have
  // resolved — both fire async at mount, so this is the first real wait
  // point, not just gotoApp's "Settings button" check. Scoped to the app bar
  // (`<header>`, implicit role "banner").
  const banner = page.getByRole("banner");
  const button = banner.getByRole("button", { name: "Harnesses", exact: true });
  await expect(button).toBeVisible();

  // The meter: a fixed-size track (`bg-muted`, aria-hidden) whose fill span is
  // colored by the worst meter's tier.
  const meter = button.getByTestId("harnesses-button-meter");
  await expect(meter).toBeVisible();
  const fill = meter.locator("span.bg-danger");
  await expect(fill).toHaveCount(1);
  expect(await fill.getAttribute("style"), "the fill width should reflect the worst meter's 95%").toContain("95%");

  // Open the panel.
  await button.click();
  const dialog = page.getByRole("dialog", { name: "Harnesses" });
  await expect(dialog).toBeVisible();

  // The other built-in harnesses (Codex, Cursor, Gemini CLI, fx.sh) are
  // disabled by default and must not get a row in the panel
  // (docs/plans/hide-disabled-harnesses-topbar.md). Labels per
  // src/bun/migrations/046_fx_harness.sql.
  for (const id of ["codex", "cursor", "gemini", "fx"]) {
    await expect(dialog.getByTestId(`harnesses-panel-account-${id}`)).toHaveCount(0);
  }

  const row = dialog.getByTestId("harnesses-panel-account-claude-code");
  await expect(row).toBeVisible();

  // Header: harness label + plan type.
  // (The brand icon's SVG also carries a <title> "Claude Code", so target the
  // label span.)
  await expect(row.locator("span.font-medium", { hasText: "Claude Code" })).toBeVisible();
  await expect(row.getByText("max", { exact: true })).toBeVisible();

  // Meter rows: label + rounded percent for each seeded meter.
  await expect(row.getByText("Session (5h)", { exact: true })).toBeVisible();
  await expect(row.getByText("42%", { exact: true })).toBeVisible();
  await expect(row.getByText("Weekly", { exact: true })).toBeVisible();
  await expect(row.getByText("95%", { exact: true })).toBeVisible();

  // The 95%-used "Weekly" row's own fill bar should also carry the crit
  // color, independent of the button's meter assertion above. Walk up from
  // the exact-text label span (2 levels: span -> header row div -> the
  // per-meter row div that also holds the track/fill) rather than filtering
  // by `hasText`, which would also match the ancestor container holding
  // *both* meters.
  const weeklyRow = row.getByText("Weekly", { exact: true }).locator("xpath=../..");
  await expect(weeklyRow.locator("div.bg-danger")).toHaveCount(1);

  // Manual Refresh control.
  await expect(row.getByRole("button", { name: "Refresh usage" })).toBeVisible();

  // Escape closes it, and focus returns to the button.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
});
