import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { HarnessQuota } from "../../../shared/types.ts";
import { AccountUsageRow, type AccountUsageRowProps } from "./AccountUsageRow.tsx";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function props(o: Partial<AccountUsageRowProps> = {}): AccountUsageRowProps {
  return {
    harnessId: "acct-a",
    kind: "claude-code",
    label: "Account A",
    tone: "success",
    statusText: "Ready",
    detail: null,
    quota: null,
    stale: false,
    cooldowns: [],
    runningTasks: 0,
    usageSupported: true,
    now: NOW,
    onRefresh: async () => {},
    ...o,
  };
}
const html = (o: Partial<AccountUsageRowProps> = {}) => renderToStaticMarkup(<AccountUsageRow {...props(o)} />);

function quota(o: Partial<HarnessQuota> = {}): HarnessQuota {
  return {
    harnessId: "acct-a",
    kind: "claude-code",
    planType: "max",
    status: "ok",
    source: "api",
    fetchedAtMs: NOW - 120_000,
    meters: [
      { id: "five_hour", label: "Session (5h)", usedPercent: 42, resetsAtMs: NOW + 3 * HOUR },
      { id: "seven_day", label: "Weekly", usedPercent: 95, resetsAtMs: null, scope: "all models" },
    ],
    reason: null,
    ...o,
  };
}

describe("AccountUsageRow placeholders", () => {
  test("an unsupported kind says so and offers no Refresh", () => {
    const markup = html({ usageSupported: false });
    expect(markup).toContain("Usage tracking isn&#x27;t supported for this harness yet.");
    expect(markup).not.toContain('aria-label="Refresh usage"');
  });

  test("a supported kind with no snapshot yet explains the first poll and offers Refresh", () => {
    const markup = html();
    expect(markup).toContain("No usage data yet — the first poll runs shortly, or refresh now.");
    expect(markup).toContain('aria-label="Refresh usage"');
  });

  test("a snapshot with no meters shows the provider's reason, or a default", () => {
    expect(html({ quota: quota({ meters: [], status: "unavailable", reason: "No Cursor cookie" }) })).toContain("No Cursor cookie");
    expect(html({ quota: quota({ meters: [], reason: null }) })).toContain("No usage data");
  });
});

describe("AccountUsageRow content", () => {
  test("lists every meter with its percent, scope, tier color and reset", () => {
    const markup = html({ quota: quota() });
    expect(markup).toContain("Session (5h)");
    expect(markup).toContain(">42%<");
    expect(markup).toContain("Weekly");
    expect(markup).toContain("all models");
    expect(markup).toContain(">95%<");
    expect(markup).toContain("bg-success");
    expect(markup).toContain("bg-danger");
    expect(markup).toContain("resets in 3h");
    expect(markup).toContain("max");
    expect(markup).toContain("updated 2m ago");
  });

  test("a stale snapshot prefixes the age and dims the bars", () => {
    const markup = html({ quota: quota(), stale: true });
    expect(markup).toContain("stale · updated 2m ago");
    expect(markup).toContain("opacity-60");
  });

  test("the status text is spelled out and the position label shows", () => {
    const markup = html({ statusText: "Cooling until 14:30", tone: "warning", positionLabel: "Backup 1" });
    expect(markup).toContain("Cooling until 14:30");
    expect(markup).toContain("Backup 1");
    expect(markup).toContain('data-testid="harnesses-panel-account-acct-a"');
  });

  test("the status is announced once: the chip's dot is decorative", () => {
    const markup = html({ statusText: "Cooling until 14:30", tone: "warning" });
    expect(markup).not.toContain('aria-label="Cooling until 14:30"');
    expect(markup).toContain('aria-hidden="true"');
  });

  test("running tasks are counted", () => {
    expect(html({ runningTasks: 1 })).toContain("1 running task<");
    expect(html({ runningTasks: 3 })).toContain("3 running tasks");
  });

  test("a cooldown chip renders provider text escaped, never as markup", () => {
    const markup = html({
      cooldowns: [
        { key: "acct-a:", text: "usage limit · until 14:30", ariaLabel: "Cooling: usage limit, until 14:30", model: null, message: "<b>boom</b>" },
      ],
    });
    expect(markup).toContain('data-testid="harness-cooldown-chip"');
    expect(markup).toContain("usage limit · until 14:30");
    expect(markup).not.toContain("<b>boom</b>");
    expect(markup).toContain("&lt;b&gt;boom&lt;/b&gt;");
  });

  test("the CLI detail text is escaped too", () => {
    const markup = html({ detail: "<img src=x onerror=1>" });
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
  });
});
