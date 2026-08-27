import { test, expect } from "bun:test";
import type { Subagent, SubagentStatus } from "../../shared/types.ts";
import {
  shouldShowSubagentTabs,
  resolveActiveStream,
  splitTabsForOverflow,
  sortSubagentTabs,
  anySubagentRunning,
  MAX_VISIBLE_TABS,
} from "./subagent-tabs.ts";

function sub(
  id: string,
  status: SubagentStatus,
  startedAt = 0,
  parentKind: Subagent["parentKind"] = "subagent",
): Subagent {
  return {
    id, taskId: "t", runId: "r", parentKind,
    agentType: "Explore", description: "x", spawnDepth: 1, sourcePath: `/p/agent-${id}.jsonl`,
    status, startedAt, endedAt: status === "running" ? null : startedAt + 1,
  };
}

/** Workflow container row helper — id/sourcePath mirror the workflow's own
 *  background taskId/transcriptDir per the shared-types doc comment, but the
 *  exact values don't matter for these pure-derivation tests. */
function container(id: string, status: SubagentStatus, startedAt = 0): Subagent {
  return sub(id, status, startedAt, "workflow");
}

test("shouldShowSubagentTabs: hidden with none, shown while a subagent runs", () => {
  expect(shouldShowSubagentTabs([], true)).toBe(false);
  expect(shouldShowSubagentTabs([sub("a", "completed")], false)).toBe(false);
  expect(shouldShowSubagentTabs([sub("a", "running")], false)).toBe(true);
});

test("shouldShowSubagentTabs: a finished subagent stays visible while the parent turn runs", () => {
  // The decision: keep a just-finished tab readable until the turn resolves.
  expect(shouldShowSubagentTabs([sub("a", "completed")], true)).toBe(true);
  // Parent resolved + nothing running → collapse.
  expect(shouldShowSubagentTabs([sub("a", "completed")], false)).toBe(false);
});

test("anySubagentRunning", () => {
  expect(anySubagentRunning([sub("a", "completed"), sub("b", "running")])).toBe(true);
  expect(anySubagentRunning([sub("a", "completed")])).toBe(false);
});

test("resolveActiveStream: collapses to main when hidden, missing, or main", () => {
  const subs = [sub("a", "running")];
  expect(resolveActiveStream("main", true, subs)).toBe("main");
  expect(resolveActiveStream("a", true, subs)).toBe("a");        // valid + shown → keep
  expect(resolveActiveStream("a", false, subs)).toBe("main");    // strip hidden → reset
  expect(resolveActiveStream("ghost", true, subs)).toBe("main"); // vanished → reset
});

test("splitTabsForOverflow: no overflow under the limit", () => {
  const subs = [sub("a", "completed"), sub("b", "completed")];
  const { visible, overflow } = splitTabsForOverflow(subs, "main", 6);
  expect(visible.length).toBe(2);
  expect(overflow.length).toBe(0);
});

test("splitTabsForOverflow: overflows past the limit in spawn order", () => {
  const subs = Array.from({ length: 9 }, (_, i) => sub(`s${i}`, "completed", i));
  const { visible, overflow } = splitTabsForOverflow(subs, "main", 6);
  expect(visible.map((s) => s.id)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
  expect(overflow.map((s) => s.id)).toEqual(["s6", "s7", "s8"]);
});

test("splitTabsForOverflow: never hides a running or the active tab", () => {
  // 8 completed + one running late one (s8) + active is s7 (completed, late).
  const subs = Array.from({ length: 9 }, (_, i) => sub(`s${i}`, i === 8 ? "running" : "completed", i));
  const { visible, overflow } = splitTabsForOverflow(subs, "s7", 6);
  // The running (s8) and the active (s7) must be visible despite being last.
  expect(visible.map((s) => s.id)).toContain("s8");
  expect(visible.map((s) => s.id)).toContain("s7");
  expect(overflow.map((s) => s.id)).not.toContain("s8");
  expect(overflow.map((s) => s.id)).not.toContain("s7");
});

test("sortSubagentTabs: running agents sort ahead of finished ones", () => {
  const subs = [sub("a", "completed", 0), sub("b", "running", 1), sub("c", "failed", 2), sub("d", "running", 3)];
  expect(sortSubagentTabs(subs).map((s) => s.id)).toEqual(["b", "d", "a", "c"]);
});

test("sortSubagentTabs: stable — spawn order kept within each group", () => {
  // Every non-"running" status trails, in spawn order; no shuffling among peers.
  const subs = [
    sub("a", "cancelled", 0), sub("b", "running", 1), sub("c", "orphaned", 2),
    sub("d", "running", 3), sub("e", "completed", 4),
  ];
  expect(sortSubagentTabs(subs).map((s) => s.id)).toEqual(["b", "d", "a", "c", "e"]);
});

test("sortSubagentTabs: does not mutate its input (it's React state)", () => {
  const subs = [sub("a", "completed", 0), sub("b", "running", 1)];
  const sorted = sortSubagentTabs(subs);
  expect(subs.map((s) => s.id)).toEqual(["a", "b"]); // original untouched
  expect(sorted).not.toBe(subs);
});

test("sortSubagentTabs: no-ops on empty and all-same-status lists", () => {
  expect(sortSubagentTabs([])).toEqual([]);
  const running = [sub("a", "running", 0), sub("b", "running", 1)];
  expect(sortSubagentTabs(running).map((s) => s.id)).toEqual(["a", "b"]);
});

test("sortSubagentTabs + splitTabsForOverflow: running fill the head, finished overflow", () => {
  // 9 agents, the last 3 running → sorted head is the running ones, and the
  // oldest finished tabs are what fall behind the "+N" pill.
  const subs = Array.from({ length: 9 }, (_, i) => sub(`s${i}`, i >= 6 ? "running" : "completed", i));
  const { visible, overflow } = splitTabsForOverflow(sortSubagentTabs(subs), "main", 6);
  expect(visible.map((s) => s.id)).toEqual(["s6", "s7", "s8", "s0", "s1", "s2"]);
  expect(overflow.map((s) => s.id)).toEqual(["s3", "s4", "s5"]);
});

test("MAX_VISIBLE_TABS default applies", () => {
  const subs = Array.from({ length: 8 }, (_, i) => sub(`s${i}`, "completed", i));
  const { visible } = splitTabsForOverflow(subs, "main");
  expect(visible.length).toBe(MAX_VISIBLE_TABS);
});

// ── Claude Code Workflow container/agent rows ───────────────────────────────

test("sortSubagentTabs: excludes a workflow container row from tab derivation", () => {
  const subs = [container("wf", "running", 0), sub("a", "completed", 1)];
  expect(sortSubagentTabs(subs).map((s) => s.id)).toEqual(["a"]);
});

test("sortSubagentTabs: a solo running container yields zero tabs", () => {
  const subs = [container("wf", "running", 0)];
  expect(sortSubagentTabs(subs)).toEqual([]);
});

test("sortSubagentTabs: workflow_agent rows are treated exactly like subagent rows", () => {
  const subs = [
    sub("a", "completed", 0, "subagent"),
    sub("b", "running", 1, "workflow_agent"),
    sub("c", "completed", 2, "workflow_agent"),
  ];
  // Running sorts first regardless of parentKind, finished trail in spawn order.
  expect(sortSubagentTabs(subs).map((s) => s.id)).toEqual(["b", "a", "c"]);
});

test("sortSubagentTabs: mixed container + subagent + workflow_agent list — stable ordering, container dropped", () => {
  const subs = [
    container("wf", "running", 0),
    sub("a", "completed", 1, "workflow_agent"),
    sub("b", "running", 2, "subagent"),
    sub("c", "completed", 3, "workflow_agent"),
  ];
  expect(sortSubagentTabs(subs).map((s) => s.id)).toEqual(["b", "a", "c"]);
});

test("anySubagentRunning: a running workflow container counts as running", () => {
  expect(anySubagentRunning([container("wf", "running")])).toBe(true);
  expect(anySubagentRunning([container("wf", "completed")])).toBe(false);
});

test("shouldShowSubagentTabs: a solo running container shows no tabs (nothing tabbable yet)", () => {
  // The container alone satisfies "something is active" but there's nothing to
  // switch to, so the strip stays collapsed rather than showing an empty shell.
  expect(shouldShowSubagentTabs([container("wf", "running")], false)).toBe(false);
});

test("shouldShowSubagentTabs: a running container keeps the strip open around a finished wave", () => {
  // First wave's agent finished; the container is still running between waves.
  // The strip must stay open so the finished tab from wave 1 stays readable.
  const subs = [container("wf", "running", 0), sub("a", "completed", 1, "workflow_agent")];
  expect(shouldShowSubagentTabs(subs, false)).toBe(true);
});

test("shouldShowSubagentTabs: a finished container with a finished agent and no running parent turn collapses", () => {
  const subs = [container("wf", "completed", 0), sub("a", "completed", 1, "workflow_agent")];
  expect(shouldShowSubagentTabs(subs, false)).toBe(false);
});

test("resolveActiveStream: a workflow container id is never a valid stream to land on", () => {
  const subs = [container("wf", "running", 0), sub("a", "running", 1, "workflow_agent")];
  expect(resolveActiveStream("wf", true, subs)).toBe("main");
  expect(resolveActiveStream("a", true, subs)).toBe("a");
});

// ── bg_session (backgrounded shell) tab coverage ────────────────────────────
// docs/plans/fix-bg-shell-detection.md §2-3: a `Bash(run_in_background: true)`
// shell surfaces as a `parentKind: "bg_session"` row and must be tabbable
// exactly like a `"subagent"`/`"workflow_agent"` row (only `"workflow"`
// containers are excluded by `isTabbable`) — no new logic needed here, this
// just locks in that the existing generic handling covers the new kind.

test("sortSubagentTabs: a bg_session row is included and sorts with running-first ordering", () => {
  const subs = [
    sub("a", "completed", 0, "subagent"),
    sub("b", "running", 1, "bg_session"),
    sub("c", "completed", 2, "workflow_agent"),
  ];
  expect(sortSubagentTabs(subs).map((s) => s.id)).toEqual(["b", "a", "c"]);
});

test("shouldShowSubagentTabs: a lone running bg_session row shows tabs even with the parent turn idle", () => {
  expect(shouldShowSubagentTabs([sub("shell", "running", 0, "bg_session")], false)).toBe(true);
});

test("resolveActiveStream: accepts a running bg_session row's id", () => {
  const subs = [sub("shell", "running", 0, "bg_session")];
  expect(resolveActiveStream("shell", true, subs)).toBe("shell");
});

test("shouldShowSubagentTabs: a completed bg_session row with the parent turn idle collapses the strip", () => {
  expect(shouldShowSubagentTabs([sub("shell", "completed", 0, "bg_session")], false)).toBe(false);
});

// ── monitor (Claude Code Monitor) tab coverage ──────────────────────────────
// docs/plans/claude-code-monitors-hold-running.md §3/§5 TT2: a live Claude
// Code `Monitor` tool call surfaces as a `parentKind: "monitor"` row and must
// be tabbable exactly like a `"subagent"`/`"bg_session"`/`"workflow_agent"`
// row (only `"workflow"` containers are excluded by `isTabbable`) — no new
// logic needed here, this just locks in that the existing generic handling
// covers the new kind, mirroring the bg_session coverage above.

test("sortSubagentTabs: a monitor row is included and sorts with running-first ordering", () => {
  const subs = [
    sub("a", "completed", 0, "subagent"),
    sub("b", "running", 1, "monitor"),
    sub("c", "completed", 2, "workflow_agent"),
  ];
  expect(sortSubagentTabs(subs).map((s) => s.id)).toEqual(["b", "a", "c"]);
});

test("anySubagentRunning: a running monitor row counts as running", () => {
  expect(anySubagentRunning([sub("m", "running", 0, "monitor")])).toBe(true);
  expect(anySubagentRunning([sub("m", "completed", 0, "monitor")])).toBe(false);
});

test("shouldShowSubagentTabs: a lone running monitor row shows tabs even with the parent turn idle", () => {
  expect(shouldShowSubagentTabs([sub("m", "running", 0, "monitor")], false)).toBe(true);
});

test("resolveActiveStream: accepts a running monitor row's id", () => {
  const subs = [sub("m", "running", 0, "monitor")];
  expect(resolveActiveStream("m", true, subs)).toBe("m");
});

test("shouldShowSubagentTabs: a completed monitor row with the parent turn idle collapses the strip", () => {
  expect(shouldShowSubagentTabs([sub("m", "completed", 0, "monitor")], false)).toBe(false);
});
