/**
 * Which tasks run WITHOUT asking (docs/specs/remote-readiness-spec.md "Signed decisions and the unlock window").
 *
 * Content a phone sends into a task that acts without asking (a follow-up, an answer, a draft, an edited plan) reaches an agent that will
 * simply do it, so it needs the unlock window: a recent biometric. A task that asks before acting needs only the session. The table
 * below is pinned per harness kind and mode; a test walks `AGENT_OPTIONS` and fails on any mode with no explicit entry.
 *
 * FAIL CLOSED: an unknown harness kind, or a mode this table does not name, counts as running without asking.
 */
import { AGENT_OPTIONS, defaultModeFor } from "../../shared/types.ts";

/** `true` = the mode runs tool calls (or at least edits) without a per-call approval. */
export const AUTONOMY: Readonly<Record<string, Readonly<Record<string, boolean>>>> = {
  "claude-code": { auto: true, bypass: true, acceptEdits: true, plan: false, ask: false },
  codex: { auto: true, ask: false },
  cursor: { auto: true, plan: false, ask: false },
  gemini: { auto: true, ask: false },
  fx: { yolo: true, auto: true, ask: false },
  // "ask" on antigravity is --mode accept-edits: edits go through without approval.
  antigravity: { auto: true, plan: false, ask: true },
  opencode: { auto: true, ask: false, plan: false },
  copilot: { auto: true, plan: false, ask: false },
};

export interface AutonomyTask {
  agent: string;
  mode: string | null | undefined;
}

/** The effective mode of a task: its own, or its harness's default. */
export function effectiveMode(task: AutonomyTask): string | null {
  if (task.mode) return task.mode;
  const kind = task.agent as keyof typeof AGENT_OPTIONS;
  return kind in AGENT_OPTIONS ? defaultModeFor(kind) : null;
}

/** Whether content sent into this task is acted on without asking. Unknown kinds and modes: true. */
export function runsWithoutAsking(task: AutonomyTask): boolean {
  const mode = effectiveMode(task);
  if (mode === null) return true;
  const table = Object.prototype.hasOwnProperty.call(AUTONOMY, task.agent) ? AUTONOMY[task.agent] : undefined;
  if (!table || !Object.prototype.hasOwnProperty.call(table, mode)) return true;
  return table[mode] === true;
}
