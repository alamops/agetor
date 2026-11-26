/**
 * A task's `agent` is a HARNESS ID, not a kind: the built-in rows use their kind as the id ("claude-code"), but a second account of the
 * same kind has an id of its own. The autonomy table and the terminal rules are keyed by KIND, so every live read resolves it here first
 * (`harnesses.getByIdOrKind`, the same lookup the plan-approval guard uses). An id with no row falls back to itself, which for the
 * autonomy table is an unknown kind and so counts as running without asking (fail closed).
 */

/**
 * Kinds that run one tmux session per task (or per turn) named `agetor-<task id>` on agetor's socket: the phone terminal may attach to
 * those, and only while `has-session` succeeds. ACP harnesses (cursor, fx) have no tmux session; the OpenCode 2.x server is hosted per
 * harness, not per task, so its session name never exists and the attach answers `no-terminal`.
 */
export const PHONE_TERMINAL_KINDS: ReadonlySet<string> = new Set(["claude-code", "codex", "gemini", "antigravity", "copilot", "opencode"]);

export async function resolveHarnessKind(agent: string): Promise<string> {
  const { harnesses } = await import("../db-async.ts");
  return (await harnesses.getByIdOrKind(agent))?.kind ?? agent;
}
