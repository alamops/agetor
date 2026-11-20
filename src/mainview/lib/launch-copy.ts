/**
 * The explanatory strings of the launch pickers, kept out of the JSX so every
 * surface renders the same words and the tests can pin them.
 */
import { formatTokens } from "@/lib/utils";
import type { AgentKind, AgentStatus } from "../../shared/types.ts";

export const CODE_MODE_TOOLTIP =
  "Execute changes (auto / accept edits / ask all live under Code — pick the exact variant under More options).";

/** The Plan button's tooltip: what Plan means for each harness. */
export function planModeTooltip(kind: AgentKind): string {
  switch (kind) {
    case "codex":
      return "Codex has no native plan mode — routed to 'ask' so nothing auto-executes.";
    case "cursor":
      return "Routed to cursor-agent's --mode plan — a real read-only planning mode. Approving the plan switches the task to Auto (force).";
    case "copilot":
      return "Routed to Copilot's --mode plan — approving the plan switches the task to Auto";
    case "gemini":
      return "Routed to gemini's --approval-mode plan — a real read-only mode, no changes made.";
    case "antigravity":
      return "Routed to agy's --mode plan — a real read-only planning mode.";
    case "opencode":
      return "Routed to OpenCode's Plan agent — no file edits, but shell commands still run.";
    case "fx":
      return "fx has no native plan mode — routed to 'ask': only pre-approved rules run; anything else surfaces as an approval card in the run panel.";
    default:
      return "Plan only — agent describes what it would do without making changes.";
  }
}

/**
 * A harness row's tooltip. The account email and today's token burn come first:
 * with two accounts of one harness, "which account is this and does it have
 * headroom" is the decision being made. Falls back to the harness id.
 */
export function harnessTooltip(status: AgentStatus | undefined, harnessId: string): string {
  return (
    [
      status?.account?.email,
      status?.usage &&
        `today ${formatTokens(status.usage.today.inputTokens + status.usage.today.outputTokens)} tok`,
      status?.reason,
      status?.loggedIn === false ? (status.authHelp ?? "Not logged in") : null,
      status?.path,
      status?.version,
    ]
      .filter(Boolean)
      .join(" — ") || harnessId
  );
}

/** The usage note under Model: Fable models bill at 2x Opus; Mythos models are
 *  Fable's access-gated twin. Family check (not an exact id) so every point
 *  release picks it up with no code change. `null` when nothing applies. */
export function usageNote(kind: AgentKind, modelId: string | null | undefined, modelLabel: string | undefined): string | null {
  if (kind !== "claude-code" || !modelId) return null;
  const label = modelLabel ?? modelId;
  if (modelId.startsWith("fable-")) return `${label} uses 2x the usage of Opus.`;
  if (modelId.startsWith("mythos-")) {
    return `${label} uses 2x the usage of Opus and requires approved-org (Project Glasswing) access.`;
  }
  return null;
}

/** The Effort field's tooltip. */
export function effortTooltip(kind: AgentKind, hasEfforts: boolean): string {
  if (!hasEfforts) return "This model doesn't accept a reasoning-effort flag.";
  if (kind === "claude-code") return "Appends a thinking keyword (think / think hard / ultrathink) to the prompt.";
  return "Reasoning effort — higher = slower but more thorough.";
}

/** The stack-fallback line shown when the chosen account can't start but a
 *  backup in its stack can serve the run. */
export const STACK_FALLBACK_HINT =
  "This account can't start right now — the run starts on the next usable account in its stack.";
