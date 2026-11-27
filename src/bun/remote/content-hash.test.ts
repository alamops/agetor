import { describe, expect, test } from "bun:test";
import { buildContent, targetKey, type ContentSources } from "./content-hash.ts";
import type { ContentTarget } from "./types.ts";

function sources(over: Partial<ContentSources> = {}): ContentSources {
  return {
    plan: async () => ({ markdown: "# Plan\n1. do it", status: "pending", name: "Plan" }),
    claudePlan: async () => ({ plan: "# Claude plan", mode: "auto" }),
    tmuxCard: async () => ({ question: "Do you want to proceed?", choices: [{ key: "1", label: "Yes" }, { key: "2", label: "No" }], mode: "ask", answerKind: "choice" }),
    fxPermission: async () => ({ toolCall: { name: "bash", command: "ls" }, options: [{ optionId: "allow-once" }], mode: "ask" }),
    gate: async () => ({ handoffs: [{ fromStepId: "s1", summary: "done" }], nextStepIds: ["s3", "s2"], mode: "auto" }),
    fxResume: async () => ({ recovery: { kind: "paused", count: 1 } }),
    terminal: async () => ({ ok: true }),
    ...over,
  };
}

const T: Record<string, ContentTarget> = {
  plan: { kind: "plan", taskId: "t1", planId: "p1" },
  planEdit: { kind: "plan-edit", taskId: "t1", planId: "p1", body: "edited" },
  claudePlan: { kind: "claude-plan", taskId: "t1", promptId: "q1", row: "auto" },
  tmux: { kind: "tmux-card", taskId: "t1", promptId: "q1" },
  fx: { kind: "fx-permission", taskId: "t1", permissionId: "x1" },
  gate: { kind: "gate", taskId: "t1", stepId: "g", seq: 4 },
  resume: { kind: "fx-resume", taskId: "t1" },
  terminal: { kind: "terminal", taskId: "t1", tmuxSession: "agetor-0123456789ab" },
};

describe("content bytes and hashes", () => {
  test("every target builds bytes whose hash is sha256 of exactly those bytes", async () => {
    for (const [name, target] of Object.entries(T)) {
      const c = await buildContent(target, sources());
      expect(c, name).not.toBeNull();
      expect(c!.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(c!.taskId).toBe("t1");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", c!.bytes as BufferSource));
      expect(c!.hash).toBe("sha256:" + Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""));
    }
  });

  test("the same content gives the same hash; any change gives another", async () => {
    const a = await buildContent(T.plan!, sources());
    expect((await buildContent(T.plan!, sources()))!.hash).toBe(a!.hash);
    const changes: Array<[string, ContentSources]> = [
      ["plan text", sources({ plan: async () => ({ markdown: "# Plan\n1. do something else", status: "pending", name: "Plan" }) })],
      ["plan status", sources({ plan: async () => ({ markdown: "# Plan\n1. do it", status: "approved", name: "Plan" }) })],
    ];
    for (const [what, s] of changes) expect((await buildContent(T.plan!, s))!.hash, what).not.toBe(a!.hash);
  });

  test("the plan edit is bound to the edited body, and to the plan it edits", async () => {
    const a = await buildContent(T.planEdit!, sources());
    const b = await buildContent({ ...(T.planEdit as Extract<ContentTarget, { kind: "plan-edit" }>), body: "edited!" }, sources());
    expect(a!.hash).not.toBe(b!.hash);
    expect(a!.hash).not.toBe((await buildContent(T.plan!, sources()))!.hash);
  });

  test("a Claude plan names its row and the task's mode: row 1 and row 2 hash differently, and a mode switch voids it", async () => {
    const auto = await buildContent(T.claudePlan!, sources());
    const manual = await buildContent({ ...(T.claudePlan as Extract<ContentTarget, { kind: "claude-plan" }>), row: "manual" }, sources());
    expect(auto!.hash).not.toBe(manual!.hash);
    const switched = await buildContent(T.claudePlan!, sources({ claudePlan: async () => ({ plan: "# Claude plan", mode: "bypass" }) }));
    expect(switched!.hash).not.toBe(auto!.hash);
  });

  test("a tmux card covers the question, every choice and the mode", async () => {
    const base = await buildContent(T.tmux!, sources());
    const relabelled = sources({ tmuxCard: async () => ({ question: "Do you want to proceed?", choices: [{ key: "1", label: "Yes, always" }, { key: "2", label: "No" }], mode: "ask", answerKind: "choice" }) });
    const requestion = sources({ tmuxCard: async () => ({ question: "Delete everything?", choices: [{ key: "1", label: "Yes" }, { key: "2", label: "No" }], mode: "ask", answerKind: "choice" }) });
    const remode = sources({ tmuxCard: async () => ({ question: "Do you want to proceed?", choices: [{ key: "1", label: "Yes" }, { key: "2", label: "No" }], mode: "auto", answerKind: "choice" }) });
    for (const s of [relabelled, requestion, remode]) expect((await buildContent(T.tmux!, s))!.hash).not.toBe(base!.hash);
  });

  test("a gate covers handoffs, step, seq, next steps (order-insensitive) and mode", async () => {
    const base = await buildContent(T.gate!, sources());
    expect((await buildContent(T.gate!, sources({ gate: async () => ({ handoffs: [{ fromStepId: "s1", summary: "done" }], nextStepIds: ["s2", "s3"], mode: "auto" }) })))!.hash).toBe(base!.hash);
    const nextChanged = sources({ gate: async () => ({ handoffs: [{ fromStepId: "s1", summary: "done" }], nextStepIds: ["s2", "s9"], mode: "auto" }) });
    const handoffChanged = sources({ gate: async () => ({ handoffs: [{ fromStepId: "s1", summary: "ALTERED" }], nextStepIds: ["s3", "s2"], mode: "auto" }) });
    const modeChanged = sources({ gate: async () => ({ handoffs: [{ fromStepId: "s1", summary: "done" }], nextStepIds: ["s3", "s2"], mode: "ask" }) });
    for (const s of [nextChanged, handoffChanged, modeChanged]) expect((await buildContent(T.gate!, s))!.hash).not.toBe(base!.hash);
    const otherSeq = await buildContent({ ...(T.gate as Extract<ContentTarget, { kind: "gate" }>), seq: 5 }, sources());
    expect(otherSeq!.hash).not.toBe(base!.hash);
  });

  test("a target that no longer exists builds nothing", async () => {
    const gone: ContentSources = {
      plan: async () => null, claudePlan: async () => null, tmuxCard: async () => null, fxPermission: async () => null,
      gate: async () => null, fxResume: async () => null, terminal: async () => null,
    };
    for (const [name, target] of Object.entries(T)) expect(await buildContent(target, gone), name).toBeNull();
  });

  test("targetKey is stable and distinguishes every field", () => {
    expect(targetKey(T.plan!)).toBe(targetKey({ planId: "p1", taskId: "t1", kind: "plan" } as ContentTarget));
    expect(targetKey(T.plan!)).not.toBe(targetKey({ ...(T.plan as Extract<ContentTarget, { kind: "plan" }>), planId: "p2" }));
  });
});
