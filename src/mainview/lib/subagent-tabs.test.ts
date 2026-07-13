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

function sub(id: string, status: SubagentStatus, startedAt = 0): Subagent {
  return {
    id, taskId: "t", runId: "r", parentKind: "subagent",
    agentType: "Explore", description: "x", spawnDepth: 1, sourcePath: `/p/agent-${id}.jsonl`,
    status, startedAt, endedAt: status === "running" ? null : startedAt + 1,
  };
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
