import { test, expect } from "./fixtures";
import { gotoApp, seedHarnessUsage } from "./helpers";
import type { HarnessQuota } from "../src/shared/types.ts";

/**
 * E2E coverage for the per-harness usage tracker's topbar chip
 * (docs/plans/harness-usage-tracker.md) — the mini-bar rendered inline in a
 * harness chip, and the click-to-open popover that lists every meter, the
 * plan type, and a manual Refresh button (`src/mainview/components/usage
 * /UsageMeter.tsx` / `UsagePopover.tsx`).
 *
 * There is no ingestion route that works offline — the only way to populate
 * a `HarnessQuota` is `POST /harnesses/:id/usage/refresh`, which calls out to
 * the real provider (Anthropic/OpenAI/Cursor). So this spec seeds a known
 * snapshot directly into the worker's isolated SQLite DB via
 * `seedHarnessUsage` (e2e/helpers.ts) *before* navigating — App.tsx's
 * `GET /usage` boot-seed (fired once at mount, src/mainview/App.tsx) is what
 * turns that row into the `usage` state the chip renders from.
 *
 * Only the built-in `claude-code` harness is enabled by default (see
 * migration 038's seed data), and `AGETOR_CLAUDE_BIN`/`AGETOR_TMUX_BIN`
 * point at `/bin/echo` in every worker's backend (e2e/fixtures.ts), so its
 * chip is deterministically available and rendered — no dependency on a real
 * `claude`/`tmux` install on the machine running these tests. The other
 * built-ins seeded by migration 046 (`codex`, `cursor`, `gemini`, `fx`) ship
 * `enabled=0` and `visibleTopbarAgents` (src/mainview/lib/usage.ts) filters
 * the topbar to enabled harnesses only, so none of them render a chip at
 * all — not even a plain, usage-less span (docs/plans
 * /hide-disabled-harnesses-topbar.md).
 *
 * Assert DOM structure/classes/text — same convention as theme.spec.ts and
 * font-size.spec.ts (real Chromium against the real webview + a real Bun
 * API/orchestrator, no mocked fetches, no screenshot diffs).
 */

const NOW = Date.now();
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** `worstMeter` (src/mainview/lib/usage.ts) picks the highest `usedPercent`
 *  — the 95% "Weekly" meter — so the mini-bar and its tier color are driven
 *  by that one, while the popover lists both. 95 >= USAGE_CRIT_PERCENT (90)
 *  so the mini-bar and the "Weekly" row both render with the crit
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

test("renders the claude-code chip's worst-meter mini-bar and its popover's meter rows, plan, and Refresh; Escape closes it", async ({
  page,
  backend,
}) => {
  seedHarnessUsage(backend, claudeCodeQuota());
  await gotoApp(page, backend.bootBase);

  // The chip only becomes a clickable UsagePopover-wrapped button once both
  // `GET /harnesses` (agents/harnesses lists) and `GET /usage` (this test's
  // seeded snapshot) have resolved — both fire async at mount, so this is
  // the first real wait point, not just gotoApp's "Settings button" check.
  // Scoped to the app-bar (`<header>`, implicit role "banner") — the New
  // Task form's agent picker also has a button named "Claude Code", and an
  // unscoped role query would hit both (strict-mode violation).
  const banner = page.getByRole("banner");
  const chip = banner.getByRole("button", { name: "Claude Code", exact: true });
  await expect(chip).toBeVisible();

  // The other built-in harnesses (Codex, Cursor, Gemini CLI, fx.sh) are
  // disabled by default and must not render a chip — not a button, not any
  // other element — in the topbar (docs/plans
  // /hide-disabled-harnesses-topbar.md). Labels per src/bun/migrations
  // /046_fx_harness.sql; `exact: true` so "Gemini CLI" doesn't collide with
  // a future "Gemini" label elsewhere.
  for (const label of ["Codex", "Cursor", "Gemini CLI", "fx.sh"]) {
    await expect(banner.getByRole("button", { name: label, exact: true })).toHaveCount(0);
  }

  // Mini-bar: a fixed-size track (`bg-muted`) with a fill span colored by
  // the worst meter's tier. aria-hidden on both spans (decorative), so they
  // aren't reachable via role queries — locate by class within the chip.
  const miniBarFill = chip.locator("span.bg-danger");
  await expect(miniBarFill).toHaveCount(1);
  const fillStyle = await miniBarFill.getAttribute("style");
  expect(fillStyle, "mini-bar fill width should reflect the worst meter's 95%").toContain("95%");

  // Open the popover.
  await chip.click();
  const dialog = page.getByRole("dialog", { name: "Claude Code usage" });
  await expect(dialog).toBeVisible();

  // Header: harness label + plan type.
  await expect(dialog.getByText("Claude Code", { exact: true })).toBeVisible();
  await expect(dialog.getByText("max", { exact: true })).toBeVisible();

  // Meter rows: label + rounded percent for each seeded meter.
  await expect(dialog.getByText("Session (5h)", { exact: true })).toBeVisible();
  await expect(dialog.getByText("42%", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Weekly", { exact: true })).toBeVisible();
  await expect(dialog.getByText("95%", { exact: true })).toBeVisible();

  // The 95%-used "Weekly" row's own fill bar should also carry the crit
  // color, independent of the chip's mini-bar assertion above. Walk up from
  // the exact-text label span (2 levels: span -> header row div -> the
  // per-meter row div that also holds the track/fill) rather than filtering
  // by `hasText`, which would also match the ancestor container holding
  // *both* meters.
  const weeklyRow = dialog.getByText("Weekly", { exact: true }).locator("xpath=../..");
  await expect(weeklyRow.locator("div.bg-danger")).toHaveCount(1);

  // Manual Refresh control.
  await expect(dialog.getByRole("button", { name: "Refresh usage" })).toBeVisible();

  // Escape closes it.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
