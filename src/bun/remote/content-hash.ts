/**
 * The exact content a phone shows and signs over (docs/specs/remote-readiness-spec.md "Signed decisions", grill E4, E5).
 *
 * For each consent target the core builds the BYTES to show (canonical JSON), their SHA-256 and, on the decision, rebuilds them from the
 * live state and compares: a plan revised since, a card answered on the Mac, a gate whose next steps changed, a mode that switched, all
 * change the hash and void the signature. The data comes from `ContentSources`; the live implementation reads the task, the pending
 * interaction registry and the pipeline run, and tests inject fixtures.
 *
 * What each target holds:
 *   plan           the plan markdown (`editedContent ?? content`) and its status, id and revision (the edit count is not stored, the
 *                  content itself is what the owner reads, so the hash is over it)
 *   plan-edit      the edited body the phone is about to save, and the plan it edits
 *   claude-plan    the plan Claude's ExitPlanMode modal asks about, plus WHICH row (auto mode or manual approval) and the task's mode
 *   tmux-card      the question text, the choices and the task's mode
 *   fx-permission  the tool call, the options and the task's mode
 *   gate           the gate's handoffs, step id, seq, next steps (the graph's edges out of the gate) and the task's mode (all six, E4);
 *                  the decision and the comment are in the signed payload itself
 *   fx-resume      the task's recovery record
 *   terminal       the task id and the tmux session name
 */
import { toHex, utf8 } from "@agetor/remote-protocol/bytes";
import { canonicalBytes } from "@agetor/remote-protocol/canonical-json";
import { contentHashOf } from "@agetor/remote-protocol/decision";
import type { ContentTarget } from "./types.ts";

export interface BuiltContent {
  bytes: Uint8Array;
  hash: string;
  /** The task the content belongs to, for autonomy checks. */
  taskId: string;
}

export interface ContentSources {
  plan(taskId: string, planId: string): Promise<{ markdown: string; status: string; name: string | null } | null>;
  /** The pending plan of a Claude ExitPlanMode modal, by the prompt id of its card. */
  claudePlan(taskId: string, promptId: string): Promise<{ plan: string; mode: string | null } | null>;
  tmuxCard(taskId: string, promptId: string): Promise<{ question: string; choices: Array<{ key: string; label: string }>; mode: string | null; answerKind: string | null } | null>;
  fxPermission(taskId: string, permissionId: string): Promise<{ toolCall: unknown; options: unknown; mode: string | null } | null>;
  gate(taskId: string, stepId: string, seq: number): Promise<{ handoffs: unknown; nextStepIds: string[]; mode: string | null } | null>;
  fxResume(taskId: string): Promise<{ recovery: unknown } | null>;
  /** Whether the task has a live tmux-hosted session named `tmuxSession` (the terminal attach target). */
  terminal(taskId: string, tmuxSession: string): Promise<{ ok: true } | null>;
}

const wrap = (taskId: string, obj: unknown): BuiltContent => {
  const bytes = canonicalBytes(obj);
  return { bytes, hash: contentHashOf(bytes), taskId };
};

/** Build the content for a target, or null when what it names no longer exists (answered, revised away, archived). */
export async function buildContent(target: ContentTarget, src: ContentSources): Promise<BuiltContent | null> {
  switch (target.kind) {
    case "plan": {
      const p = await src.plan(target.taskId, target.planId);
      return p ? wrap(target.taskId, { kind: "plan", taskId: target.taskId, planId: target.planId, status: p.status, name: p.name, markdown: p.markdown }) : null;
    }
    case "plan-edit": {
      const p = await src.plan(target.taskId, target.planId);
      return p ? wrap(target.taskId, { kind: "plan-edit", taskId: target.taskId, planId: target.planId, status: p.status, name: p.name, body: target.body }) : null;
    }
    case "claude-plan": {
      const p = await src.claudePlan(target.taskId, target.promptId);
      return p ? wrap(target.taskId, { kind: "claude-plan", taskId: target.taskId, promptId: target.promptId, row: target.row, mode: p.mode, plan: p.plan }) : null;
    }
    case "tmux-card": {
      const c = await src.tmuxCard(target.taskId, target.promptId);
      return c ? wrap(target.taskId, { kind: "tmux-card", taskId: target.taskId, promptId: target.promptId, mode: c.mode, answerKind: c.answerKind, question: c.question, choices: c.choices }) : null;
    }
    case "fx-permission": {
      const c = await src.fxPermission(target.taskId, target.permissionId);
      return c ? wrap(target.taskId, { kind: "fx-permission", taskId: target.taskId, permissionId: target.permissionId, mode: c.mode, toolCall: c.toolCall, options: c.options }) : null;
    }
    case "gate": {
      const g = await src.gate(target.taskId, target.stepId, target.seq);
      return g
        ? wrap(target.taskId, { kind: "gate", taskId: target.taskId, stepId: target.stepId, seq: target.seq, mode: g.mode, nextStepIds: [...g.nextStepIds].sort(), handoffs: g.handoffs })
        : null;
    }
    case "fx-resume": {
      const r = await src.fxResume(target.taskId);
      return r ? wrap(target.taskId, { kind: "fx-resume", taskId: target.taskId, recovery: r.recovery }) : null;
    }
    case "terminal": {
      const t = await src.terminal(target.taskId, target.tmuxSession);
      return t ? wrap(target.taskId, { kind: "terminal", taskId: target.taskId, tmuxSession: target.tmuxSession }) : null;
    }
  }
}

/** A stable key for a target, so a challenge is bound to exactly what it was issued for. */
export function targetKey(target: ContentTarget): string {
  return toHex(canonicalBytes(target));
}

// ── the live sources ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Sources over the running core. Imports are lazy so the module (and its unit tests) load without a database. Reads only: nothing here
 * mutates a task or an interaction.
 */
export function createLiveContentSources(): ContentSources {
  const tasks = async () => (await import("../db-async.ts")).tasks;
  const pending = async (taskId: string) => (await import("../interactions.ts")).listPendingForTask(taskId);
  const modeOf = async (taskId: string): Promise<string | null> => {
    const t = await (await tasks()).get(taskId);
    if (!t) return null;
    const { effectiveMode } = await import("./autonomy.ts");
    return effectiveMode(t);
  };
  return {
    async plan(taskId, planId) {
      const t = await (await tasks()).get(taskId);
      const p = t?.plans.find((x) => x.id === planId);
      return p ? { markdown: p.editedContent ?? p.content, status: p.status, name: p.name } : null;
    },
    async claudePlan(taskId, promptId) {
      const t = await (await tasks()).get(taskId);
      if (!t) return null;
      const card = (await pending(taskId)).find((r) => r.id === promptId && r.kind === "tmux_prompt");
      if (!card) return null;
      // The newest pending plan of the task is the one the modal asks about (the JSONL carries it while the modal is open).
      const plan = [...t.plans].reverse().find((p) => p.status === "pending");
      return plan ? { plan: plan.editedContent ?? plan.content, mode: await modeOf(taskId) } : null;
    },
    async tmuxCard(taskId, promptId) {
      const card = (await pending(taskId)).find((r) => r.id === promptId && r.kind === "tmux_prompt");
      if (!card || card.kind !== "tmux_prompt") return null;
      return { question: card.paneText, choices: card.choices.map((c) => ({ key: c.key, label: c.label })), mode: await modeOf(taskId), answerKind: card.answerKind ?? null };
    },
    async fxPermission(taskId, permissionId) {
      const card = (await pending(taskId)).find((r) => r.id === permissionId && r.kind === "fx_permission");
      if (!card || card.kind !== "fx_permission") return null;
      return { toolCall: card.toolCall, options: card.options, mode: await modeOf(taskId) };
    },
    async gate(taskId, stepId, seq) {
      const t = await (await tasks()).get(taskId);
      const run = t?.pipelineRun;
      const gate = run?.humanSteps?.find((g) => g.stepId === stepId && g.seq === seq);
      if (!t || !run || !gate) return null;
      const edges = run.snapshot?.graph.edges ?? [];
      const nextStepIds = edges.filter((e) => e.from === stepId).map((e) => e.to);
      return { handoffs: gate.arrivals.map((a) => ({ fromStepId: a.fromStepId, seq: a.seq, handoff: a.handoff, comment: a.comment ?? null })), nextStepIds, mode: await modeOf(taskId) };
    },
    async fxResume(taskId) {
      const t = await (await tasks()).get(taskId);
      return t?.fxRecovery ? { recovery: t.fxRecovery } : null;
    },
    async terminal(taskId, tmuxSession) {
      // Only a task whose harness keeps one tmux session per task (claude-code), and only that session by its derived name, and only
      // while it is alive on agetor's own socket.
      const t = await (await tasks()).get(taskId);
      if (!t || t.agent !== "claude-code") return null;
      const tmux = await import("../claude-tmux.ts");
      if (tmuxSession !== tmux.sessionNameFor(taskId)) return null;
      return (await tmux.sessionExistsByName(tmuxSession)) ? { ok: true } : null;
    },
  };
}

export { utf8 };
