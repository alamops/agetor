import { describe, expect, test } from "bun:test";
import type { Handoff, PipelineEdge, PipelineGraph, PipelineStep, PipelineStepRecord } from "../../shared/types.ts";
import {
  handoffCardsEnabled,
  handoffMatchLocation,
  handoffNextLabel,
  handoffStatusChip,
  handoffUsage,
  indexLastHandoffEventByRun,
  searchableHandoffText,
  splitHandoffMessageCached,
  stepIdForName,
} from "./handoff-view.ts";

function handoff(over: Partial<Handoff> = {}): Handoff {
  return {
    schemaVersion: 1,
    purpose: "Ship the widget",
    summary: "Built the thing",
    reason: "All done",
    next: null,
    artifacts: [],
    openQuestions: [],
    ...over,
  };
}

function step(id: string, name: string, over: Partial<PipelineStep> = {}): PipelineStep {
  return {
    id,
    name,
    instructions: "",
    agentProfileId: null,
    position: { x: 0, y: 0 },
    subagents: { profileIds: [], cap: null },
    transition: "choose",
    join: "any",
    ...over,
  };
}

function edge(id: string, from: string, to: string, label = ""): PipelineEdge {
  return { id, from, to, label };
}

function graph(steps: PipelineStep[], edges: PipelineEdge[]): PipelineGraph {
  return { steps, edges, startStepId: steps[0]?.id ?? null };
}

function record(over: Partial<PipelineStepRecord> = {}): PipelineStepRecord {
  return {
    seq: 1,
    stepId: "a",
    taskId: "t1",
    startedAt: 1,
    endedAt: 2,
    outcome: "succeeded",
    handoff: handoff(),
    nextStepIds: [],
    ...over,
  };
}

describe("handoffStatusChip", () => {
  test("absent status reads done", () => {
    expect(handoffStatusChip(handoff())).toEqual({ status: "done", label: "Done", tone: "success" });
  });
  test("explicit done and blocked", () => {
    expect(handoffStatusChip(handoff({ status: "done" })).status).toBe("done");
    expect(handoffStatusChip(handoff({ status: "blocked" }))).toEqual({
      status: "blocked",
      label: "Blocked",
      tone: "warning",
    });
  });
});

describe("handoffNextLabel", () => {
  const linear = graph([step("a", "Alpha"), step("b", "Beta")], [edge("e1", "a", "b")]);
  const branching = graph(
    [step("a", "Alpha"), step("b", "Beta"), step("c", "Gamma")],
    [edge("e1", "a", "b", "yes"), edge("e2", "a", "c", "no")],
  );
  const fanOut = graph(
    [step("a", "Alpha", { transition: "all" }), step("b", "Beta"), step("c", "Gamma")],
    [edge("e1", "a", "b"), edge("e2", "a", "c")],
  );

  test("a single outgoing edge ignores next (K9)", () => {
    expect(handoffNextLabel(handoff({ next: null }), linear, "a")).toEqual({
      text: "→ Beta",
      tone: "default",
      kind: "steps",
    });
    expect(handoffNextLabel(handoff({ next: "whatever" }), linear, "a").text).toBe("→ Beta");
  });
  test("choose resolves by name, case-insensitively", () => {
    expect(handoffNextLabel(handoff({ next: "gamma" }), branching, "a").text).toBe("→ Gamma");
  });
  test("a fan-out lists every target", () => {
    expect(handoffNextLabel(handoff({ next: null }), fanOut, "a").text).toBe("→ Beta, Gamma");
  });
  test("a step with no outgoing edge is the last step", () => {
    expect(handoffNextLabel(handoff({ next: "x" }), linear, "b")).toEqual({
      text: "Last step",
      tone: "default",
      kind: "last",
    });
  });
  test("an unmatched next is unknown, in the warning tone", () => {
    expect(handoffNextLabel(handoff({ next: "Nowhere" }), branching, "a")).toEqual({
      text: "→ Nowhere · unknown step",
      tone: "warning",
      kind: "unknown",
    });
  });
  test("several edges and no next is ambiguous, in the warning tone", () => {
    expect(handoffNextLabel(handoff({ next: null }), branching, "a")).toEqual({
      text: "→ ? · no next step chosen",
      tone: "warning",
      kind: "ambiguous",
    });
  });
  test("no graph: next verbatim, null reads Last step", () => {
    expect(handoffNextLabel(handoff({ next: "Beta" }), null, "a")).toEqual({
      text: "→ Beta",
      tone: "default",
      kind: "unresolved",
    });
    expect(handoffNextLabel(handoff({ next: null }), null, "a")).toEqual({
      text: "Last step",
      tone: "default",
      kind: "unresolved",
    });
    expect(handoffNextLabel(handoff({ next: "  " }), null, null).text).toBe("Last step");
  });
  test("source step not in the graph is unresolved too", () => {
    expect(handoffNextLabel(handoff({ next: "Beta" }), linear, "zzz")).toEqual({
      text: "→ Beta",
      tone: "default",
      kind: "unresolved",
    });
    expect(handoffNextLabel(handoff({ next: "Beta" }), linear, null).kind).toBe("unresolved");
  });
});

describe("handoffUsage (D21)", () => {
  const base = { eventRunId: "r1", isLastBlockOfRun: true, runSettled: true };
  test("no record → null", () => {
    expect(handoffUsage({ ...base, record: null })).toBeNull();
  });
  test("null or absent handoffRunId (legacy) → null", () => {
    expect(handoffUsage({ ...base, record: record({ handoffRunId: null }) })).toBeNull();
    expect(handoffUsage({ ...base, record: record() })).toBeNull();
  });
  test("a different run supplied the handoff → not-used", () => {
    expect(handoffUsage({ ...base, record: record({ handoffRunId: "r2" }) })).toBe("not-used");
  });
  test("same run, last block → used", () => {
    expect(handoffUsage({ ...base, record: record({ handoffRunId: "r1" }) })).toBe("used");
  });
  test("same run, an earlier block → not-used", () => {
    expect(handoffUsage({ ...base, isLastBlockOfRun: false, record: record({ handoffRunId: "r1" }) })).toBe(
      "not-used",
    );
  });
  test("run not settled → null, whatever the record says", () => {
    expect(handoffUsage({ ...base, runSettled: false, record: record({ handoffRunId: "r1" }) })).toBeNull();
    expect(handoffUsage({ ...base, runSettled: false, record: record({ handoffRunId: "r2" }) })).toBeNull();
  });
});

describe("searchableHandoffText", () => {
  test("values only, no keys", () => {
    const text = searchableHandoffText(
      handoff({ next: "Beta", artifacts: ["docs/a.md"], openQuestions: ["Why?"], status: "blocked" }),
    );
    expect(text).toContain("Ship the widget");
    expect(text).toContain("Built the thing");
    expect(text).toContain("All done");
    expect(text).toContain("Beta");
    expect(text).toContain("docs/a.md");
    expect(text).toContain("Why?");
    expect(text).not.toContain("schemaVersion");
    expect(text).not.toContain("openQuestions");
    expect(text).not.toContain("blocked");
  });
  test("null next and empty fields are skipped", () => {
    expect(searchableHandoffText(handoff({ purpose: "", reason: "", summary: "only" }))).toBe("only");
  });
});

describe("handoffMatchLocation", () => {
  const h = handoff({
    summary: "The summary text",
    reason: "Reason-only-token",
    next: "Beta",
    artifacts: ["a1.md", "a2.md", "a3.md", "a4.md", "a5.md", "a6.md", "seventh-artifact.md", "free text note"],
    openQuestions: ["Question-token?"],
    purpose: "Purpose-token",
  });
  const roots = ["/w"];

  test("status label, next, summary → card", () => {
    expect(handoffMatchLocation(h, "done", { roots })).toBe("card");
    expect(handoffMatchLocation(h, "beta", { roots })).toBe("card");
    expect(handoffMatchLocation(h, "SUMMARY text", { roots })).toBe("card");
  });
  test("a visible chip label → card", () => {
    expect(handoffMatchLocation(h, "a3.md", { roots })).toBe("card");
  });
  test("reason, purpose, questions → modal", () => {
    expect(handoffMatchLocation(h, "reason-only-token", { roots })).toBe("modal");
    expect(handoffMatchLocation(h, "purpose-token", { roots })).toBe("modal");
    expect(handoffMatchLocation(h, "question-token", { roots })).toBe("modal");
  });
  test("an artifact past the chip limit and free text → modal", () => {
    expect(handoffMatchLocation(h, "seventh-artifact", { roots })).toBe("modal");
    expect(handoffMatchLocation(h, "free text", { roots })).toBe("modal");
  });
  test("chipLimit moves the boundary", () => {
    expect(handoffMatchLocation(h, "a3.md", { roots, chipLimit: 2 })).toBe("modal");
  });
  test("a note is a tooltip, not card text → modal", () => {
    const noted = handoff({ artifacts: ["docs/x.md (secret-note)"] });
    expect(handoffMatchLocation(noted, "secret-note")).toBe("modal");
    expect(handoffMatchLocation(noted, "docs/x.md")).toBe("card");
  });
  test("no hit, blank query, and JSON keys → null", () => {
    expect(handoffMatchLocation(h, "nothing-here", { roots })).toBeNull();
    expect(handoffMatchLocation(h, "   ", { roots })).toBeNull();
    expect(handoffMatchLocation(h, "schemaVersion", { roots })).toBeNull();
  });
});

describe("splitHandoffMessageCached", () => {
  const block = `<handoff>${JSON.stringify(handoff())}</handoff>`;
  test("returns the same object for the same text", () => {
    const text = `Prose before\n${block}\nafter`;
    const a = splitHandoffMessageCached(text);
    expect(splitHandoffMessageCached(text)).toBe(a);
    expect(a.before).toBe("Prose before\n");
    expect(a.after).toBe("\nafter");
    expect(a.block?.result.ok).toBe(true);
  });
  test("survives more than 512 distinct texts and stays correct", () => {
    const first = splitHandoffMessageCached("first text");
    for (let i = 0; i < 600; i++) splitHandoffMessageCached(`filler ${i}`);
    // Evicted: recomputed, equal in value.
    const again = splitHandoffMessageCached("first text");
    expect(again).toEqual(first);
    // And a recent one is still cached.
    const recent = splitHandoffMessageCached("filler 599");
    expect(splitHandoffMessageCached("filler 599")).toBe(recent);
  });
  test("a recently used entry outlives older ones", () => {
    const keep = splitHandoffMessageCached("keep-me");
    for (let i = 0; i < 400; i++) splitHandoffMessageCached(`a ${i}`);
    expect(splitHandoffMessageCached("keep-me")).toBe(keep); // refresh recency
    for (let i = 0; i < 400; i++) splitHandoffMessageCached(`b ${i}`);
    expect(splitHandoffMessageCached("keep-me")).toBe(keep);
  });
});

describe("indexLastHandoffEventByRun", () => {
  const block = (summary: string) => `<handoff>${JSON.stringify(handoff({ summary }))}</handoff>`;
  test("last main-stream assistant event with a real block, per run", () => {
    const events = [
      { runId: "r1", stream: "assistant", data: `x ${block("one")}` },
      { runId: "r1", stream: "assistant", data: "plain" },
      { runId: "r1", stream: "assistant", data: block("two") },
      { runId: "r2", stream: "assistant", data: block("three") },
      { runId: "r2", stream: "assistant", data: "tail" },
    ];
    expect([...indexLastHandoffEventByRun(events)]).toEqual([
      ["r1", 2],
      ["r2", 3],
    ]);
  });
  test("skips subagent events, other streams and blocks in code", () => {
    const events = [
      { runId: "r1", stream: "assistant", data: block("real") },
      { runId: "r1", stream: "assistant", data: block("sub"), subagentId: "sa-1" },
      { runId: "r1", stream: "user", data: block("user") },
      { runId: "r1", stream: "assistant", data: `quoted \`${block("inline")}\`` },
      { runId: "r1", stream: "assistant", data: "```\n" + block("fenced") + "\n```" },
      { runId: "r1", stream: "assistant", data: block("null sub"), subagentId: null },
    ];
    expect(indexLastHandoffEventByRun(events).get("r1")).toBe(5);
    expect(indexLastHandoffEventByRun(events.slice(0, 5)).get("r1")).toBe(0);
  });
  test("an upper-case tag counts, like the locator (shared case-insensitive pre-check)", () => {
    const events = [{ runId: "r1", stream: "assistant", data: `<HANDOFF>${JSON.stringify(handoff({}))}</HANDOFF>` }];
    expect(indexLastHandoffEventByRun(events).get("r1")).toBe(0);
  });
  test("a run with no real block has no entry", () => {
    expect(indexLastHandoffEventByRun([{ runId: "r1", stream: "assistant", data: "no block" }]).size).toBe(0);
  });
  test("an invalid block still counts (it renders as the invalid card)", () => {
    const events = [{ runId: "r1", stream: "assistant", data: "<handoff>not json</handoff>" }];
    expect(indexLastHandoffEventByRun(events).get("r1")).toBe(0);
  });
});

describe("handoffCardsEnabled", () => {
  test("all conditions must hold", () => {
    expect(handoffCardsEnabled({ isStepTask: true, kind: "claude-code", mainStream: true })).toBe(true);
    expect(handoffCardsEnabled({ isStepTask: false, kind: "claude-code", mainStream: true })).toBe(false);
    expect(handoffCardsEnabled({ isStepTask: true, kind: "claude-code", mainStream: false })).toBe(false);
  });
  test("delta-stream harnesses are off; unknown kind is on", () => {
    expect(handoffCardsEnabled({ isStepTask: true, kind: "gemini", mainStream: true })).toBe(false);
    expect(handoffCardsEnabled({ isStepTask: true, kind: "antigravity", mainStream: true })).toBe(false);
    expect(handoffCardsEnabled({ isStepTask: true, kind: "codex", mainStream: true })).toBe(true);
    expect(handoffCardsEnabled({ isStepTask: true, kind: null, mainStream: true })).toBe(true);
    expect(handoffCardsEnabled({ isStepTask: true, kind: undefined, mainStream: true })).toBe(true);
  });
});

describe("stepIdForName", () => {
  const g = graph([step("a", "Alpha Step"), step("b", "Beta")], []);
  test("matches by stepNameKey", () => {
    expect(stepIdForName(g, "  alpha   STEP ")).toBe("a");
    expect(stepIdForName(g, "Beta")).toBe("b");
  });
  test("no graph or no match → null", () => {
    expect(stepIdForName(null, "Alpha Step")).toBeNull();
    expect(stepIdForName(g, "Gamma")).toBeNull();
  });
});
