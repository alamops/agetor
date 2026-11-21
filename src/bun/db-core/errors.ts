

/** Send and Retry use this when another task holds the session claim.
 *  A duplicate import's losing row still has `importedClaude` after the
 *  backfill (migration 070); that JSON is not permission to resume. */
export const IMPORTED_CLAUDE_HELD_ELSEWHERE =
  "another task already holds this Claude session";

/** Another task already holds this Claude session id.
 *  Follow-up runs reuse `runs.claude_session_id`, so that column is not the
 *  claim — `tasks.imported_claude_session_id` (migration 069) is. */
export class ImportedClaudeSessionTaken extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super("session is already imported");
    this.name = "ImportedClaudeSessionTaken";
    this.sessionId = sessionId;
  }
}

/** Send and Retry use this when another task holds the OpenCode session
 *  claim — the OpenCode counterpart of {@link IMPORTED_CLAUDE_HELD_ELSEWHERE}. */
export const IMPORTED_OPENCODE_HELD_ELSEWHERE =
  "another task already holds this OpenCode session";

/** Another task already holds this OpenCode session id
 *  (`tasks.imported_opencode_session_id`, migration 079) — the OpenCode
 *  counterpart of {@link ImportedClaudeSessionTaken}. */
export class ImportedOpencodeSessionTaken extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super("session is already imported");
    this.name = "ImportedOpencodeSessionTaken";
    this.sessionId = sessionId;
  }
}

export class HarnessInUseError extends Error {
  taskIds: string[];
  /** Ids of the {@link AgentProfile} rows referencing this harness — a
   *  profile delete never populates this list (deleting a profile always
   *  succeeds; only deleting the harness it points at can be refused). */
  profileIds: string[];
  constructor(taskIds: string[], profileIds: string[] = []) {
    const parts: string[] = [];
    if (taskIds.length > 0) parts.push(`${taskIds.length} task(s)`);
    if (profileIds.length > 0) parts.push(`${profileIds.length} agent(s)`);
    super(`harness in use by ${parts.length > 0 ? parts.join(" and ") : "0 task(s)"}`);
    this.taskIds = taskIds;
    this.profileIds = profileIds;
    this.name = "HarnessInUseError";
  }
}

export class HarnessBuiltinError extends Error {
  constructor(action: string) {
    super(`cannot ${action} a built-in harness`);
    this.name = "HarnessBuiltinError";
  }
}

/** Thrown by `agentProfiles.insert`/`update` when the (trimmed,
 *  case-insensitive) name collides with an existing profile — the `409` the
 *  server maps this to, and what makes `agetor add --profile <name>`
 *  unambiguous (`matchAgentProfileRef` in `shared/agent-profile.ts`). */
export class AgentProfileNameError extends Error {
  constructor(name: string) {
    super(`agent name "${name}" is already in use`);
    this.name = "AgentProfileNameError";
  }
}

/** True for a bun:sqlite `UNIQUE` constraint violation — the backstop that
 *  catches a name-key clash from a concurrent write that slipped past the
 *  `findByName` pre-check below (there is no cross-process locking here, so
 *  the pre-check alone can't be relied on to be race-free). */
export const isUniqueConstraintError = (e: unknown): boolean =>
  e instanceof Error && "code" in e && (e as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE";

/** Thrown by `pipelines.insert`/`update` when the (trimmed, case-insensitive)
 *  name collides with an existing pipeline — the `409` the server maps this
 *  to, and what makes `agetor pipeline show <name>` unambiguous
 *  (`matchPipelineRef` in `shared/pipeline.ts`). Mirrors
 *  {@link AgentProfileNameError}. */
export class PipelineNameError extends Error {
  constructor(name: string) {
    super(`pipeline name "${name}" is already in use`);
    this.name = "PipelineNameError";
  }
}
