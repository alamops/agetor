/**
 * One read of "was this task imported from a session started outside
 * Agetor, and in what state is that import?" across both importable kinds —
 * Claude Code (`task.importedClaude`) and OpenCode (`task.importedOpencode`,
 * `docs/plans/add-opencode-harness.md` D-13). Every gate that used to read
 * `importedClaude` directly (the start 409, the send refusal, RunPanel,
 * TaskCard, the context menu, the CLI) reads this instead, so a new
 * importable kind is one more branch here, not one more check per gate.
 * Pure and shared, free of runtime imports from either process side.
 */
import type { Task } from "./types.ts";

export interface ImportedSessionInfo {
  /** The kind the session came from (its harness's `kind`). */
  kind: "claude-code" | "opencode";
  /** The external session id — a Claude uuid or an OpenCode `ses_…` id. */
  sessionId: string;
  status: "importing" | "ready" | "failed";
  error: string | null;
}

/**
 * The task's imported-session provenance, or `null` for a task that wasn't
 * imported. Claude is read first; the two can't both be set on one task
 * (each import creates its own task), so the order only matters for a
 * hand-built fixture.
 */
export function importedSessionOf(
  t: Pick<Task, "importedClaude" | "importedOpencode">,
): ImportedSessionInfo | null {
  const claude = t.importedClaude;
  if (claude) {
    return { kind: "claude-code", sessionId: claude.sessionId, status: claude.status, error: claude.error };
  }
  const opencode = t.importedOpencode;
  if (opencode) {
    return { kind: "opencode", sessionId: opencode.sessionId, status: opencode.status, error: opencode.error };
  }
  return null;
}
