import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentStatus, Harness, HarnessLimitState, HarnessStack, Task } from "../../../shared/types.ts";
import { buildHarnessBarModel } from "@/lib/harness-bar";
import { HarnessesPanel, HarnessesPanelBody } from "./HarnessesPanel.tsx";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const harness = (id: string): Harness => ({ id, kind: "claude-code", label: id, isBuiltin: false, home: null, bin: null, env: {}, enabled: true });
const status = (id: string): AgentStatus =>
  ({ harnessId: id, kind: "claude-code", bin: "claude", available: true, path: "/bin/claude", version: "1", reason: null, installHint: null, account: null, usage: null, loggedIn: null, authHelp: null }) as AgentStatus;
const stack = (id: string, ids: string[]): HarnessStack => ({
  id,
  label: `${id} label`,
  kind: "claude-code",
  mirrorMode: "safe",
  members: ids.map((h, i) => ({ harnessId: h, position: i, label: h, kind: "claude-code" as const, enabled: true })),
  createdAt: 0,
  updatedAt: 0,
  warnings: [],
});
const cooldown = (harnessId: string): HarnessLimitState => ({
  harnessId,
  reason: "quota",
  source: "claude-pane",
  message: "<script>x</script>",
  exhaustedUntilMs: NOW + HOUR,
  updatedAt: 0,
  model: "sonnet-4.6",
});
const waiting = (id: string, stackId: string): Task =>
  ({
    id,
    title: `title ${id}`,
    column: "ready",
    agent: "acct-a",
    archivedAt: null,
    harnessState: {
      stackId,
      position: 0,
      tried: [],
      pendingSwap: null,
      allExhausted: { at: 0, attempts: 1, max: 3, nextAttemptAt: 0, earliestResetAtMs: NOW + HOUR, reason: "quota" },
    },
  }) as unknown as Task;

function model(ids: string[], stacks: HarnessStack[] = [], tasks: Task[] = [], limitStates: HarnessLimitState[] = []) {
  return buildHarnessBarModel(
    { agents: ids.map(status), harnesses: ids.map(harness), stacks, limitStates, usage: {}, tasks },
    NOW,
  );
}
const noop = () => {};
const actions = {
  onRefreshUsage: async () => {},
  onOpenHarnessSettings: noop,
  onOpenStackHistory: noop,
  onOpenFailoverTask: noop,
  onClose: noop,
};
const body = (m: ReturnType<typeof model>) => renderToStaticMarkup(<HarnessesPanelBody model={m} now={NOW} {...actions} />);

describe("HarnessesPanelBody", () => {
  const ids = ["acct-a", "acct-b", "acct-c", "acct-d"];
  const markup = body(model(ids, [stack("s1", ["acct-a", "acct-b"])], [waiting("t1", "s1"), waiting("t2", "gone")], [cooldown("acct-b")]));

  test("the stack section comes before the other accounts", () => {
    const stackAt = markup.indexOf('data-testid="harnesses-panel-stack-s1"');
    const accountAt = markup.indexOf('data-testid="harnesses-panel-account-acct-c"');
    expect(stackAt).toBeGreaterThanOrEqual(0);
    expect(accountAt).toBeGreaterThan(stackAt);
    expect(markup).toContain("Other accounts");
  });

  test("the stack heading names the stack in words and has one labelled dot per member", () => {
    expect(markup).toContain("s1 label");
    expect(markup).toContain(">Stack<");
    expect(markup).toContain('aria-label="acct-a: Ready"');
    expect(markup).toContain('aria-label="acct-b: Ready"');
  });

  test("members carry their position labels, in stack order", () => {
    const primary = markup.indexOf("Primary");
    const backup = markup.indexOf("Backup 1");
    expect(primary).toBeGreaterThan(0);
    expect(backup).toBeGreaterThan(primary);
  });

  test("a per-model cooldown shows as a chip, with the provider message escaped", () => {
    expect(markup).toContain('data-testid="harness-cooldown-chip"');
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
  });

  test("failover tasks sit under their stack; ones on a missing stack go to 'Other failover activity'", () => {
    expect(markup).toContain('data-testid="harnesses-panel-failover-t1"');
    expect(markup).toContain("waiting for quota until");
    const otherAt = markup.indexOf("Other failover activity");
    expect(otherAt).toBeGreaterThan(markup.indexOf("harnesses-panel-failover-t1"));
    expect(markup.indexOf('data-testid="harnesses-panel-failover-t2"')).toBeGreaterThan(otherAt);
  });

  test("the stack offers Refresh, Manage and Swap history", () => {
    expect(markup).toContain("Refresh usage");
    expect(markup).toContain("Manage stack…");
    expect(markup).toContain("Swap history");
  });

  test("with every member blocked, the heading says 'all out' with the reset", () => {
    const blocked = body(
      model(["acct-a", "acct-b"], [stack("s1", ["acct-a", "acct-b"])], [], [
        { ...cooldown("acct-a"), model: null },
        { ...cooldown("acct-b"), model: null },
      ]),
    );
    expect(blocked).toContain("all out · resets");
  });

  test("with no enabled harness it shows the empty state and the way to Settings", () => {
    const empty = body(model([]));
    expect(empty).toContain("No harnesses enabled");
    expect(empty).toContain("Open Settings → Harnesses");
  });

  test("plain accounts only: no 'Other accounts' heading", () => {
    expect(body(model(["acct-a"]))).not.toContain("Other accounts");
  });
});

describe("HarnessesPanel", () => {
  test("renders nothing while closed", () => {
    expect(
      renderToStaticMarkup(
        <HarnessesPanel open={false} anchor={null} panelId="p" model={model(["acct-a"])} now={NOW} {...actions} />,
      ),
    ).toBe("");
  });
});
