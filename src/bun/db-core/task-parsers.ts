import path from "node:path";
import { AGENT_OPTIONS, PIPELINE_LIMITS, type AgentKind, type AgentProfileSnapshot, type BacklogMessage, type Handoff, type ImportedClaudeSession, type ImportedOpencodeSession, type OpencodeServerMode, OPENCODE_SERVER_MODES, type PipelineActiveStep, type PipelineBlock, type PipelineBlockKind, type PipelineGraph, type PipelineJoinArrival, type PipelinePendingLaunch, type PipelineRunSnapshot, type PipelineRunState, type PipelineRunStatus, type PipelineStepRecord, type SentFileEntry, type Task, type TaskDraft, type TaskPlan, type TaskReference, type Speed, type TaskRepository } from "../../shared/types.ts";
import { isSpeed, speedFromFast } from "../../shared/speed.ts";
import { repositoriesForTask } from "../../shared/multi-repo.ts";
import { firstPrUrl, legacyTaskPrs, parseTaskPrs } from "../../shared/task-prs.ts";
import { AGENT_PROFILE_LIMITS, normalizeSkillName } from "../../shared/agent-profile.ts";

export type TaskRow = {
  id: string; title: string; prompt: string; column: string; agent: string;
  workdir: string; isolation: string;
  task_type: string;
  branch: string | null; worktree_path: string | null; base_ref: string | null;
  branch_source: string;
  // Retired by migration 092: still read by the migration's backfill and kept
  // for a downgrade, but no longer written or read by agetor (`prs` replaced it).
  pr_url: string | null;
  // Migration 092: the branch NAME `base_ref` was resolved from at create time
  // (written only by `tasks.insert`), and the PRs opened for the task's branch
  // as `TaskPr[]` JSON (written only by `tasks.appendPr`). Both are skipped by
  // the generic `update` SET clause and never bump `updated_at`.
  base_branch: string | null;
  prs: string;
  issue_url: string | null;
  mode: string | null; model: string | null; effort: string | null;
  // Speed tier (migration 072, which dropped the old cursor-only `fast`
  // INTEGER column) — a CHECK keeps it to `off | fast | ultrafast`, but
  // `toTask` still validates through `isSpeed` before trusting it.
  speed: string;
  max_mode: number;
  refs: string;
  backlog: string;
  draft: string | null;
  plans: string;
  todo_progress: string | null;
  // Files delivered to the user via `SendUserFile` (migration 050). Written
  // exclusively by `tasks.mergeSentFiles`'s targeted UPDATE, never by the
  // generic `insert`/`update` paths below — see the comment on the `update`
  // SET clause for why.
  sent_files: string | null;
  // fx's paused-recovery state + auto-resume schedule (migration 051),
  // `TaskFxRecovery` JSON — written exclusively by `tasks.setFxRecovery`'s
  // targeted UPDATE, never by the generic `insert`/`update` paths below
  // (same rationale as `sent_files` above: an unrelated PATCH must not
  // clobber a live auto-resume timer). NULL for every task that isn't
  // currently paused.
  fx_recovery: string | null;
  // The agent profile this task was launched from (migration 053), if any —
  // a soft reference to `agent_profiles.id` plus a point-in-time JSON
  // snapshot (`AgentProfileSnapshot`). Written exclusively by `tasks.insert`
  // (at create time) and `tasks.setAgentProfile`'s targeted UPDATE, never by
  // the generic `insert`/`update` SET clause below — same rationale as
  // `sent_files`/`fx_recovery` above: an unrelated PATCH landing mid-first-run
  // must not clobber the snapshot. Both NULL means "no agent".
  agent_profile_id: string | null;
  agent_profile: string | null;
  // Pipeline binding (migration 058) — see the migration's doc comment for
  // the full split. `pipeline_id`/`pipeline_run` live on a pipeline PARENT
  // task, written by `tasks.insert` (create time) and `tasks.setPipelineRun`
  // (targeted UPDATE); `pipeline_parent_id`/`pipeline_step_id` live on a
  // hidden STEP task, written only by `tasks.insert`. None of the four are
  // touched by the generic `insert`/`update` SET clause below.
  pipeline_id: string | null;
  pipeline_run: string | null;
  pipeline_parent_id: string | null;
  pipeline_step_id: string | null;
  // Per-task harness-stack failover state (migration 084), `TaskHarnessState`
  // JSON. Written exclusively by `tasks.setHarnessState`'s targeted UPDATE —
  // never the generic `insert`/`update` paths below (same rationale as
  // `fx_recovery`: an unrelated PATCH must not clobber a pending swap).
  harness_state: string | null;
  // The branch agetor last observed checked out in the task's worktree
  // (migration 063; NULL = never observed, or detached HEAD at the last
  // observation). Written exclusively by `tasks.insert` (create time) and
  // `tasks.setCheckoutBranch`'s targeted UPDATE, never by the generic
  // `update` SET clause below — same rationale as `sent_files`/`fx_recovery`.
  checkout_branch: string | null;
  // Multi-repository task support (migration 091, issue #291):
  // `repositories` is `TaskRepository[]` JSON — `'[]'` for a single-repo row,
  // whose one entry `toTask` derives from the scalar columns. Written by
  // `tasks.insert` (create time) and `tasks.setRepositories` (after worktree
  // preparation) only; skipped by the generic `update` SET clause.
  // `issue_repo_path` names the repository whose remote matches `issue_url`.
  repositories: string;
  issue_repo_path: string | null;
  // Provenance for a Claude Code session imported from outside Agetor
  // (migration 068). Written exclusively by `tasks.setImportedClaude`, never
  // by `tasks.insert` (new rows stay NULL) or the generic `update` SET
  // clause — same rationale as `fx_recovery`/`checkout_branch`.
  imported_claude: string | null;
  // Which OpenCode server an opencode task's turns use (migration 079,
  // `OpencodeServerMode`). Patchable — the generic `update` SET clause
  // writes it. A CHECK keeps it to `shared | standalone`; `toTask` still
  // validates before trusting it.
  opencode_server: string;
  // Provenance for an OpenCode session imported from outside Agetor
  // (migration 079, `ImportedOpencodeSession` JSON). Written exclusively by
  // `tasks.setImportedOpencode`, never by `tasks.insert` or the generic
  // `update` SET clause — same rationale as `imported_claude`. Its claim
  // column `imported_opencode_session_id` is never read into `Task`.
  imported_opencode: string | null;
  // Unread-indicator watermark pair (migration 045). Not spread into `Task`
  // directly — only the derived `unread` boolean is (see `toTask`). Written
  // exclusively by `tasks.noteAssistantEvent` / `tasks.markSeen`, never by
  // the generic `insert`/`update` paths (see those methods for why).
  last_assistant_event_id: number | null;
  last_seen_event_id: number | null;
  run_id: string | null; created_at: number; updated_at: number;
  archived_at: number | null;
  /** SQLite EXISTS returns 0/1; we map to boolean in toTask. Computed via
   *  a correlated subquery in `list` / `get` — see those for the full SQL. */
  has_openable_run?: number;
};

/** Statuses that mean "this task has produced something worth re-opening
 *  the panel for". Failed / cancelled are explicit restart cases and
 *  don't qualify — the user almost always wants to re-Run those.
 *  Literals are inlined into the SQL (rather than `?`-bound) so the
 *  parameter tuple stays empty and bun:sqlite's parameter-typing stays
 *  simple. */
export const OPENABLE_STATUSES_SQL = `('succeeded', 'running', 'orphaned')`;

export const parseRefs = (raw: string): TaskReference[] => {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((r): TaskReference[] => {
      if (!r || typeof r !== "object") return [];
      const path = (r as { path?: unknown }).path;
      if (typeof path !== "string" || !path) return [];
      const isDirectory = Boolean((r as { isDirectory?: unknown }).isDirectory);
      return [{ path, isDirectory }];
    });
  } catch { return []; }
};

/** Coerce the raw refs value (already a TaskReference[]-ish) through the same
 *  sanitizer `parseRefs` applies to on-disk JSON, so a backlog item's refs are
 *  validated identically whether they come from the DB column or a fresh
 *  client payload. */
export const sanitizeRefs = (value: unknown): TaskReference[] =>
  Array.isArray(value) ? parseRefs(JSON.stringify(value)) : [];

export const parseBacklog = (raw: string): BacklogMessage[] => {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((m): BacklogMessage[] => {
      if (!m || typeof m !== "object") return [];
      const id = (m as { id?: unknown }).id;
      if (typeof id !== "string" || !id) return [];
      const text = (m as { text?: unknown }).text;
      const createdAt = (m as { createdAt?: unknown }).createdAt;
      return [{
        id,
        text: typeof text === "string" ? text : "",
        references: sanitizeRefs((m as { references?: unknown }).references),
        createdAt: typeof createdAt === "number" ? createdAt : 0,
      }];
    });
  } catch { return []; }
};

/** Every status a {@link TaskPlan} may carry. A row with an unrecognized
 *  status (future/foreign build, hand-edited DB) coerces to a NON-actionable
 *  state — "approved" when approvedAt proves an approval happened, else
 *  "superseded" — never "pending": approve is non-idempotent (writes a file,
 *  messages a live agent), so corruption must not resurrect an approve button.
 *  Losing the record entirely would still be worse, so it is kept. `rejected`
 *  (claude-code `ExitPlanMode` plans only — a resolved-but-not-approved
 *  outcome) is a real, non-corrupt terminal status, not a fallback target. */
export const PLAN_STATUSES = new Set<string>(["pending", "approved", "superseded", "rejected"]);

export const parsePlans = (raw: string): TaskPlan[] => {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((p): TaskPlan[] => {
      if (!p || typeof p !== "object") return [];
      const id = (p as { id?: unknown }).id;
      const toolCallId = (p as { toolCallId?: unknown }).toolCallId;
      const runId = (p as { runId?: unknown }).runId;
      const content = (p as { content?: unknown }).content;
      if (typeof id !== "string" || !id) return [];
      if (typeof toolCallId !== "string" || !toolCallId) return [];
      if (typeof runId !== "string" || !runId) return [];
      if (typeof content !== "string") return [];
      const name = (p as { name?: unknown }).name;
      const editedContent = (p as { editedContent?: unknown }).editedContent;
      const status = (p as { status?: unknown }).status;
      const createdAt = (p as { createdAt?: unknown }).createdAt;
      const approvedAt = (p as { approvedAt?: unknown }).approvedAt;
      const approvedEdited = (p as { approvedEdited?: unknown }).approvedEdited;
      const filePath = (p as { filePath?: unknown }).filePath;
      return [{
        id,
        toolCallId,
        runId,
        name: typeof name === "string" ? name : null,
        content,
        editedContent: typeof editedContent === "string" ? editedContent : null,
        // An unknown/corrupt status must never coerce to "pending" — that
        // would resurrect an already-approved (or superseded) plan as
        // actionable again, and `approvePlan`/the approve route are
        // non-idempotent (a second approval re-sends the message). Fall
        // back on whether `approvedAt` is set: a numeric timestamp means it
        // really was approved, so keep it "approved"; otherwise treat the
        // corrupt row as history that's no longer actionable.
        status: typeof status === "string" && PLAN_STATUSES.has(status)
          ? (status as TaskPlan["status"])
          : typeof approvedAt === "number"
            ? "approved"
            : "superseded",
        createdAt: typeof createdAt === "number" ? createdAt : 0,
        approvedAt: typeof approvedAt === "number" ? approvedAt : null,
        approvedEdited: approvedEdited === true,
        filePath: typeof filePath === "string" ? filePath : null,
      }];
    });
  } catch { return []; }
};

/** Parse the stored draft JSON, tolerating NULL (no draft), malformed JSON,
 *  and legacy/bad shapes — all collapse to `null` rather than throwing.
 *  References are sanitized through the same `sanitizeRefs` path as backlog
 *  items. An apparently-well-formed but effectively-empty draft (blank text,
 *  no references) also normalizes to `null` so a stray write can't leave a
 *  zombie draft that silently reappears in the composer. Non-empty text is
 *  otherwise preserved verbatim — no trimming of the stored value. */
export const parseDraft = (raw: unknown): TaskDraft | null => {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const text = (parsed as { text?: unknown }).text;
    const draft: TaskDraft = {
      text: typeof text === "string" ? text : "",
      references: sanitizeRefs((parsed as { references?: unknown }).references),
    };
    if (!draft.text.trim() && draft.references.length === 0) return null;
    return draft;
  } catch { return null; }
};

/** Parse the stored `todo_progress` JSON, tolerating NULL (no todo-family
 *  tool call observed yet), malformed JSON, and unexpected shapes — all
 *  collapse to `null` rather than throwing, same treatment as `parseDraft`.
 *  Only `{ completed: number, total: number }` is accepted, and only when
 *  both are non-negative integers with `completed <= total`
 *  (`{completed:9,total:0}` or a negative count is exactly as invalid as a
 *  missing/wrong-typed field) — anything else is discarded wholesale rather
 *  than partially trusted, since a corrupt summary is worse than none. */
export const parseTodoProgress = (raw: string | null): Task["todoProgress"] => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const completed = (parsed as { completed?: unknown }).completed;
    const total = (parsed as { total?: unknown }).total;
    if (
      typeof completed !== "number" || !Number.isInteger(completed) || completed < 0
      || typeof total !== "number" || !Number.isInteger(total) || total < 0
      || completed > total
    ) return null;
    return { completed, total };
  } catch { return null; }
};

/** Parse the stored `sent_files` JSON, tolerating NULL (no `SendUserFile`
 *  delivery observed yet), malformed JSON, and a non-array top level — all
 *  collapse to `null`, same treatment as `parseTodoProgress`. Unlike that
 *  parser, a well-formed array with some malformed items is partially
 *  trusted: each item is validated independently and a malformed one is
 *  dropped rather than invalidating the whole list (an array that ends up
 *  empty after dropping still returns `[]`, not `null` — the distinction
 *  `sanitizeToolResultAttachments` in `shared/sent-files.ts` also draws).
 *  Field rules mirror `SentFileEntry`: `path` a non-empty string; `size` a
 *  finite number `>= 0` else `null`; `mediaType` a string else `null`;
 *  `isImage` a boolean else `null`; `sentAt` a finite number (required —
 *  there's nothing sane to default a missing delivery timestamp to);
 *  `runId` a string (required). */
export const parseSentFiles = (raw: unknown): SentFileEntry[] | null => {
  if (raw === null || raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch { return null; }
  if (!Array.isArray(parsed)) return null;

  const out: SentFileEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;

    const path = rec.path;
    if (typeof path !== "string" || path.length === 0) continue;

    const rawSize = rec.size;
    const size = typeof rawSize === "number" && Number.isFinite(rawSize) && rawSize >= 0
      ? rawSize
      : null;

    const rawMediaType = rec.mediaType;
    const mediaType = typeof rawMediaType === "string" ? rawMediaType : null;

    const rawIsImage = rec.isImage;
    const isImage = typeof rawIsImage === "boolean" ? rawIsImage : null;

    const sentAt = rec.sentAt;
    if (typeof sentAt !== "number" || !Number.isFinite(sentAt)) continue;

    const runId = rec.runId;
    if (typeof runId !== "string") continue;

    out.push({ path, size, mediaType, isImage, sentAt, runId });
  }
  return out;
};

/** Every {@link AgentKind} value a stored `harnessKind` may legitimately
 *  carry — derived from {@link AGENT_OPTIONS}'s own keys rather than
 *  hardcoded, so a sixth agent kind can't silently null every existing
 *  snapshot (`AGENT_OPTIONS` is the single source of truth `AgentKind`
 *  itself is keyed against in `shared/types.ts`). A snapshot whose
 *  `harnessKind` isn't one of these is treated as corrupt (see
 *  {@link parseAgentProfileSnapshot}) rather than cast blindly, since it
 *  drives `AgentIcon`/`defaultModeFor`-style lookups on the client. */
export const AGENT_KINDS = new Set<string>(Object.keys(AGENT_OPTIONS));

/**
 * Normalize a raw `skills` value (from a JSON blob — either an
 * {@link AgentProfile} row or a task's {@link AgentProfileSnapshot}) into the
 * same shape `agentProfiles.insert`/`update` enforce: each entry run through
 * {@link normalizeSkillName} (dropping anything that normalizes to `""`),
 * deduplicated (first occurrence wins), and capped at
 * `AGENT_PROFILE_LIMITS.skills`. A non-array input yields `[]`.
 */
export const sanitizeSkillsList = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const name = normalizeSkillName(entry);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= AGENT_PROFILE_LIMITS.skills) break;
  }
  return out;
};

/**
 * Parse a task's stored `agent_profile` JSON column into an
 * {@link AgentProfileSnapshot}, tolerating NULL (no agent bound), malformed
 * JSON, and unexpected shapes — all collapse to `null`, same treatment as
 * `parseSentFiles`/`parseTaskFxRecovery`. Every field is validated
 * defensively since the snapshot drives display (chip, transcript preamble)
 * without any further lookup: `id`/`name`/`harness`/`model` must be strings,
 * `harnessKind` must be a known {@link AgentKind}, `harnessLabel` is a
 * cosmetic display string that must not be load-bearing — a missing or
 * non-string value falls back to the (already-validated) `harness` id rather
 * than nulling the whole snapshot, `effort`/`mode` a string or `null`,
 * `speed` read through {@link readSnapshotSpeed} (a valid tier, else the
 * legacy pre-072 `fast` boolean, else `"off"`) and emitted alongside its
 * derived `fast`, `maxMode` coerced to a boolean, `instructions` a string
 * (default `""`), `skills` sanitized via {@link sanitizeSkillsList}, and
 * `capturedAt` a number (default `0`), and `opencodeServer`, when present, a
 * valid `OpencodeServerMode` (invalid reads as `"shared"`; absent — every
 * snapshot frozen before migration 079 — stays absent and means `"shared"`).
 */
export const parseAgentProfileSnapshot = (raw: string | null): AgentProfileSnapshot | null => {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return sanitizeAgentProfileSnapshot(parsed);
};

/** A snapshot's speed tier: its own `speed` when that is a valid tier, else
 *  the legacy `fast` boolean every snapshot written before migration 072
 *  carries (`true` → `"fast"`), else `"off"`. Frozen snapshots (a task's
 *  `agent_profile` column, a pipeline run's `snapshot.profiles`) are never
 *  rewritten by a migration, so this read is the only upgrade path. */
export const readSnapshotSpeed = (rec: Record<string, unknown>): Speed =>
  isSpeed(rec.speed) ? rec.speed : speedFromFast(rec.fast === true);

/** A row's `speed` column (validated — the CHECK already guards it, but a
 *  hand-edited row must not reach a launch as an unknown tier) plus the
 *  derived `fast` every Task / AgentProfile response carries for older
 *  clients (D13). Shared by `toTask` and `toAgentProfile`. */
export const speedFields = (raw: string): { speed: Speed; fast: boolean } => {
  const speed: Speed = isSpeed(raw) ? raw : "off";
  return { speed, fast: speed !== "off" };
};

/** The object-level half of {@link parseAgentProfileSnapshot} — shared with
 *  `sanitizeRunSnapshot`'s `profiles` map, whose entries are already-parsed
 *  objects rather than a JSON column. */
export const sanitizeAgentProfileSnapshot = (parsed: unknown): AgentProfileSnapshot | null => {
  if (!parsed || typeof parsed !== "object") return null;
  const rec = parsed as Record<string, unknown>;

  const id = rec.id;
  const name = rec.name;
  const harness = rec.harness;
  const model = rec.model;
  const harnessKind = rec.harnessKind;
  if (typeof id !== "string" || !id) return null;
  if (typeof name !== "string" || !name) return null;
  if (typeof harness !== "string" || !harness) return null;
  if (typeof model !== "string" || !model) return null;
  if (typeof harnessKind !== "string" || !AGENT_KINDS.has(harnessKind)) return null;

  const harnessLabel = typeof rec.harnessLabel === "string" && rec.harnessLabel ? rec.harnessLabel : harness;
  const effort = rec.effort;
  const mode = rec.mode;
  const instructions = rec.instructions;
  const capturedAt = rec.capturedAt;
  const speed = readSnapshotSpeed(rec);

  return {
    id,
    name,
    harness,
    harnessKind: harnessKind as AgentKind,
    harnessLabel,
    model,
    effort: typeof effort === "string" ? effort : null,
    mode: typeof mode === "string" ? mode : null,
    speed,
    fast: speed !== "off",
    maxMode: rec.maxMode === true,
    // Absent (every snapshot frozen before migration 079) stays absent —
    // readers treat that as "shared" — so a stored snapshot round-trips
    // unchanged; an invalid value reads as "shared".
    ...(rec.opencodeServer !== undefined ? { opencodeServer: readOpencodeServer(rec.opencodeServer) } : {}),
    instructions: typeof instructions === "string" ? instructions : "",
    skills: sanitizeSkillsList(rec.skills),
    capturedAt: typeof capturedAt === "number" ? capturedAt : 0,
  };
};

export const isFiniteNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

export const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

export const PIPELINE_RUN_STATUSES = new Set<string>(["idle", "running", "blocked", "done", "cancelled", "review"]);

export const PIPELINE_BLOCK_KINDS = new Set<string>([
  "step-failed", "step-blocked", "handoff-missing", "handoff-invalid", "step-cap", "profile-missing", "join-incomplete",
]);

/** A stored `Handoff` is trusted structurally, not deeply — it was produced
 *  by `parseHandoff` (`shared/pipeline.ts`) before ever reaching this
 *  column, so re-validating every field here would just duplicate that
 *  parser. Anything that isn't a plain object collapses to `null`. */
export const sanitizeStoredHandoff = (raw: unknown): Handoff | null => (isPlainObject(raw) ? (raw as unknown as Handoff) : null);

/** One entry of `PipelineRunState.active` — dropped wholesale (not
 *  partially trusted) when any of its three required fields is the wrong
 *  shape, since a malformed active-step entry is unusable for orchestration
 *  either way. */
export const sanitizeActiveStep = (raw: unknown): PipelineActiveStep | null => {
  if (!isPlainObject(raw)) return null;
  const { stepId, taskId, seq } = raw as Record<string, unknown>;
  if (typeof stepId !== "string" || !stepId) return null;
  if (typeof taskId !== "string" || !taskId) return null;
  if (!isFiniteNumber(seq)) return null;
  return { stepId, taskId, seq };
};

export const sanitizeJoinArrival = (raw: unknown): PipelineJoinArrival | null => {
  if (!isPlainObject(raw)) return null;
  const { fromStepId, seq } = raw as Record<string, unknown>;
  if (typeof fromStepId !== "string" || !fromStepId) return null;
  if (!isFiniteNumber(seq)) return null;
  // Same `handoffField` cap the writer applies (and `sanitizeBlockPending`
  // applies to `humanFeedback`): a hand-edited or pre-cap row must not put an
  // unbounded owner comment into a join/pending arrival, the board poll and
  // the next prompt (R-N2).
  const comment = typeof raw.comment === "string" && raw.comment.length > 0
    ? raw.comment.slice(0, PIPELINE_LIMITS.handoffField)
    : null;
  return {
    fromStepId,
    seq,
    handoff: sanitizeStoredHandoff((raw as Record<string, unknown>).handoff),
    ...(comment !== null ? { comment } : {}),
  };
};

export const sanitizeJoins = (raw: unknown): PipelineRunState["joins"] => {
  if (!isPlainObject(raw)) return {};
  const out: PipelineRunState["joins"] = {};
  for (const [stepId, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) continue;
    const rawArrivals = (value as Record<string, unknown>).arrivals;
    const arrivals = Array.isArray(rawArrivals)
      ? rawArrivals.map(sanitizeJoinArrival).filter((a): a is PipelineJoinArrival => a !== null)
      : [];
    out[stepId] = { arrivals };
  }
  return out;
};

/** `PipelineBlock.pending` — the run-level launch (a step-cap/profile-missing
 *  retry, or a join-incomplete launch) Retry would re-attempt. Dropped
 *  wholesale (never persisted as a half-valid shape) when `stepId` is
 *  missing/empty; `arrivals` reuses `sanitizeJoinArrival`, same as
 *  `sanitizeJoins` above, silently dropping any junk entry. The Return-only
 *  fields are carried through so a hold cannot lose a human decision. */
export const sanitizeBlockPending = (raw: unknown): PipelinePendingLaunch | null => {
  if (!isPlainObject(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const stepId = rec.stepId;
  if (typeof stepId !== "string" || !stepId) return null;
  const arrivals = Array.isArray(rec.arrivals)
    ? rec.arrivals.map(sanitizeJoinArrival).filter((a): a is PipelineJoinArrival => a !== null)
    : [];
  const returnToStepId = typeof rec.returnToStepId === "string" && rec.returnToStepId.length > 0
    ? rec.returnToStepId
    : undefined;
  const humanFeedback = typeof rec.humanFeedback === "string" && rec.humanFeedback.length > 0
    ? rec.humanFeedback.slice(0, PIPELINE_LIMITS.handoffField)
    : undefined;
  return {
    stepId,
    arrivals,
    ...(returnToStepId !== undefined ? { returnToStepId } : {}),
    ...(rec.returned === true ? { returned: true } : {}),
    ...(humanFeedback !== undefined ? { humanFeedback } : {}),
  };
};

export const sanitizeBlock = (raw: unknown): PipelineBlock | null => {
  if (!isPlainObject(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const kind = rec.kind;
  if (typeof kind !== "string" || !PIPELINE_BLOCK_KINDS.has(kind)) return null;
  const taskId = typeof rec.taskId === "string" ? rec.taskId : null;
  const stepId = typeof rec.stepId === "string" ? rec.stepId : null;
  const message = typeof rec.message === "string" ? rec.message : "";
  const pending = sanitizeBlockPending(rec.pending);
  return { taskId, stepId, kind: kind as PipelineBlockKind, message, ...(pending ? { pending } : {}) };
};

export const STEP_RECORD_OUTCOMES = new Set<string>(["succeeded", "failed", "cancelled", "advanced-manually", "returned"]);

/** {@link PipelineStepRecord.human} — a human gate's decision. Dropped to
 *  `null` when malformed (the history record itself still stands; the
 *  decision is a label for prior rounds). */
export const sanitizeHumanDecision = (raw: unknown): PipelineStepRecord["human"] => {
  if (!isPlainObject(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const decision = rec.decision;
  if (decision !== "accept" && decision !== "return") return null;
  // Same `handoffField` cap the decision route enforces (R-N2): a hand-edited
  // or pre-cap row must not put an unbounded owner comment into the history,
  // prior-rounds list and the next prompt.
  const comment = typeof rec.comment === "string" && rec.comment.length > 0
    ? rec.comment.slice(0, PIPELINE_LIMITS.handoffField)
    : null;
  const mode = rec.mode === "fresh" || rec.mode === "resume" ? rec.mode : undefined;
  const returnToStepId = typeof rec.returnToStepId === "string" && rec.returnToStepId.length > 0 ? rec.returnToStepId : null;
  return { decision, comment, ...(mode ? { mode } : {}), returnToStepId };
};

/** {@link PipelineStepRecord.responseKind}'s value set — see {@link
 *  StepResponseKind} in `src/shared/types.ts`. */
export const STEP_RESPONSE_KINDS = new Set<string>([
  "handoff", "handoff-blocked", "handoff-missing", "handoff-invalid", "user-ask", "error", "cancelled",
]);

/** An unrecognized/malformed `responseKind` collapses to `null` (same as a
 *  record written before this field existed) rather than dropping the whole
 *  history entry — it's purely a UI label, never consulted for control flow
 *  by `resolveNextSteps`/`deriveRunStatus`/etc. */
export const sanitizeResponseKind = (raw: unknown): NonNullable<PipelineStepRecord["responseKind"]> | null =>
  typeof raw === "string" && STEP_RESPONSE_KINDS.has(raw)
    ? (raw as NonNullable<PipelineStepRecord["responseKind"]>)
    : null;

export const STEP_REMINDER_REASONS = new Set<string>(["handoff-missing", "handoff-invalid", "handoff-next-unknown"]);

/** {@link PipelineStepRecord.reminder} — the one-shot automatic handoff
 *  reminder the runner records against an execution (`pipeline-runner.ts`'s
 *  `handleRunStatus`). A malformed value collapses to `null` (treated the
 *  same as "never reminded") rather than dropping the whole history entry —
 *  the worst case is one extra reminder attempt, never a control-flow bug.
 *  `delivered` defaults to `true` for a row written before that field
 *  existed — every reminder ever persisted so far was in fact delivered (the
 *  runner only records one once `sendInput` succeeds), so a missing value is
 *  a pre-field row, not evidence of a failed send. */
export const sanitizeStepReminder = (raw: unknown): NonNullable<PipelineStepRecord["reminder"]> | null => {
  if (!isPlainObject(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const at = rec.at;
  const reason = rec.reason;
  const detail = rec.detail;
  const runId = rec.runId;
  const deliveredRaw = rec.delivered;
  if (!isFiniteNumber(at)) return null;
  if (typeof reason !== "string" || !STEP_REMINDER_REASONS.has(reason)) return null;
  if (typeof detail !== "string") return null;
  if (runId !== null && typeof runId !== "string") return null;
  if (deliveredRaw !== undefined && typeof deliveredRaw !== "boolean") return null;
  const delivered = typeof deliveredRaw === "boolean" ? deliveredRaw : true;
  return {
    at,
    reason: reason as "handoff-missing" | "handoff-invalid" | "handoff-next-unknown",
    runId: runId ?? null,
    detail,
    delivered,
  };
};

/** One completed/cancelled execution in `PipelineRunState.history` — dropped
 *  wholesale when its identity fields (`stepId`/`taskId`/`seq`/`startedAt`)
 *  are malformed, since a history entry with no usable identity can't be
 *  attributed to any step anyway; every other field defaults leniently. */
export const sanitizeStepRecord = (raw: unknown): PipelineStepRecord | null => {
  if (!isPlainObject(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const stepId = rec.stepId;
  const taskId = rec.taskId;
  const seq = rec.seq;
  const startedAt = rec.startedAt;
  if (typeof stepId !== "string" || !stepId) return null;
  // A human gate's record has no task row — `null` is its valid value.
  if (taskId !== null && (typeof taskId !== "string" || !taskId)) return null;
  if (!isFiniteNumber(seq)) return null;
  if (!isFiniteNumber(startedAt)) return null;

  const endedAt = isFiniteNumber(rec.endedAt) ? rec.endedAt : null;
  const outcome = typeof rec.outcome === "string" && STEP_RECORD_OUTCOMES.has(rec.outcome)
    ? (rec.outcome as PipelineStepRecord["outcome"])
    : null;
  const nextStepIds = Array.isArray(rec.nextStepIds)
    ? rec.nextStepIds.filter((x): x is string => typeof x === "string")
    : [];

  return {
    seq, stepId, taskId: taskId as string | null, startedAt, endedAt, outcome,
    handoff: sanitizeStoredHandoff(rec.handoff),
    nextStepIds,
    human: sanitizeHumanDecision(rec.human),
    returnToStepId: typeof rec.returnToStepId === "string" && rec.returnToStepId.length > 0 ? rec.returnToStepId : null,
    responseKind: sanitizeResponseKind(rec.responseKind),
    reminder: sanitizeStepReminder(rec.reminder),
    // Always emitted (like responseKind/reminder above) so the read shape is
    // stable: a record saved before these fields existed reads null/false/null.
    handoffRunId: typeof rec.handoffRunId === "string" ? rec.handoffRunId : null,
    handoffFromOtherRun: rec.handoffFromOtherRun === true,
    attemptStartedAt: isFiniteNumber(rec.attemptStartedAt) ? rec.attemptStartedAt : null,
    stoppedAt: isFiniteNumber(rec.stoppedAt) ? rec.stoppedAt : null,
    stoppedRunId: typeof rec.stoppedRunId === "string" ? rec.stoppedRunId : null,
  };
};

/** Sanitize a `PipelineRunState.snapshot`-shaped value: `null`/non-object
 *  collapses to `null` (no snapshot yet — the run hasn't been started).
 *  `profiles` is kept lenient — "a record of objects" per the design, not
 *  re-validated field-by-field against `AgentProfileSnapshot` — since it was
 *  written by our own `snapshotFromProfile` and deep-validating it here
 *  would only duplicate that call site.
 *
 *  m18: unlike `parsePipelineGraph` (the `pipelines` table's own live `graph`
 *  column, still deep-validated via `validatePipelineGraph` on every read —
 *  see that function's doc), a run snapshot's `graph` is validated at run
 *  start by `startPipelineRun` (which refuses to start the run at all on a
 *  bad graph) and captured exactly once at that point, and nothing ever
 *  mutates a `pipeline_run` column's snapshot after it's written —
 *  re-validating the whole graph on every read (every task poll, every
 *  pipeline route) only spends cycles re-checking something that can't have
 *  changed. Only shape-check enough to make it safe to hand to the
 *  step-resolution helpers (`resolveNextSteps`/`stepNameById`/…), which
 *  just index into `.steps`/`.edges` arrays: a `graph` that isn't even an
 *  object with array `steps`/`edges` collapses the whole snapshot to `null`
 *  (an un-runnable snapshot is as good as none) exactly like before. */
/** `PipelineRunState.humanSteps` — pending human gates. Entries without a
 *  usable `stepId`/`seq`/`startedAt` are dropped; arrivals reuse
 *  `sanitizeJoinArrival`. */
export const sanitizeHumanSteps = (raw: unknown): NonNullable<PipelineRunState["humanSteps"]> => {
  if (!Array.isArray(raw)) return [];
  const out: NonNullable<PipelineRunState["humanSteps"]> = [];
  for (const value of raw) {
    if (!isPlainObject(value)) continue;
    const rec = value as Record<string, unknown>;
    const stepId = rec.stepId;
    const seq = rec.seq;
    const startedAt = rec.startedAt;
    if (typeof stepId !== "string" || !stepId) continue;
    if (!isFiniteNumber(seq) || !isFiniteNumber(startedAt)) continue;
    const arrivals = Array.isArray(rec.arrivals)
      ? rec.arrivals.map(sanitizeJoinArrival).filter((a): a is PipelineJoinArrival => a !== null)
      : [];
    out.push({ stepId, seq, startedAt, arrivals });
  }
  return out;
};

/** Minimal shape check for one `PipelineGraph.steps` entry — a plain object
 *  with a string `id` and a `position` that's a plain object with numeric
 *  `x`/`y`. Anything else (a bare string, `null`, a step missing `position`,
 *  a `position` with non-numeric coordinates) is unsafe to hand to the
 *  pipeline editor or the step-resolution helpers (shared by `parsePipelineGraph`
 *  below and `sanitizeRunSnapshot`), which index into both
 *  fields unconditionally. */
export const isShapeSafePipelineStep = (x: unknown): boolean => {
  if (!isPlainObject(x)) return false;
  if (typeof x.id !== "string") return false;
  const pos = x.position;
  if (!isPlainObject(pos)) return false;
  return isFiniteNumber(pos.x) && isFiniteNumber(pos.y);
};

/** Minimal shape check for one `PipelineGraph.edges` entry — a plain object
 *  with string `from`/`to`. */
export const isShapeSafePipelineEdge = (x: unknown): boolean =>
  isPlainObject(x) && typeof x.from === "string" && typeof x.to === "string";

export const sanitizeRunSnapshot = (raw: unknown): PipelineRunSnapshot | null => {
  if (!isPlainObject(raw)) return null;
  const rec = raw as Record<string, unknown>;
  // L-S7: the same per-entry shape checks `parsePipelineGraph` applies to
  // the live template graph — a `steps` entry without a string `id` or a
  // numeric `position`, or an `edges` entry without string `from`/`to`,
  // collapses the whole snapshot to null rather than reaching the
  // step-resolution helpers that index into those fields unconditionally.
  if (
    !isPlainObject(rec.graph) ||
    !Array.isArray(rec.graph.steps) ||
    !Array.isArray(rec.graph.edges) ||
    !rec.graph.steps.every(isShapeSafePipelineStep) ||
    !rec.graph.edges.every(isShapeSafePipelineEdge)
  ) {
    return null;
  }
  const graph = rec.graph as unknown as PipelineGraph;

  // Each profile goes through the same sanitizer a task's own
  // `agent_profile` column uses, so a run frozen before migration 072 (whose
  // profiles carry only the legacy `fast` boolean) reads back with a real
  // `speed`. An entry that sanitizer refuses is still kept (the lenient
  // "record of objects" contract above — a step launch reads its fields
  // straight off it), with only its speed pair normalized.
  const profiles: PipelineRunSnapshot["profiles"] = {};
  if (isPlainObject(rec.profiles)) {
    for (const [id, value] of Object.entries(rec.profiles)) {
      if (!isPlainObject(value)) continue;
      const speed = readSnapshotSpeed(value);
      profiles[id] = sanitizeAgentProfileSnapshot(value)
        ?? ({ ...value, speed, fast: speed !== "off", ...(value.opencodeServer !== undefined ? { opencodeServer: readOpencodeServer(value.opencodeServer) } : {}) } as unknown as AgentProfileSnapshot);
    }
  }

  const maxSteps = isFiniteNumber(rec.maxSteps) ? rec.maxSteps : PIPELINE_LIMITS.maxStepsDefault;
  const capturedAt = isFiniteNumber(rec.capturedAt) ? rec.capturedAt : 0;

  return { graph, profiles, maxSteps, capturedAt };
};

/**
 * Parse a pipeline task's stored `pipeline_run` JSON column into a
 * {@link PipelineRunState}, tolerating NULL (not a pipeline task, or a
 * pipeline task that predates a column backfill — neither happens in
 * practice since `pipeline_run` is always written at insert time for a
 * pipeline-bound task, but the parser is defensive like every other JSON
 * column in this file), malformed JSON, and unexpected shapes — all
 * collapse to `null`. Only `pipelineId` is hard-required (a non-empty
 * string); every other field defaults leniently so a partially-corrupt run
 * row degrades gracefully instead of vanishing outright — see the
 * per-collection sanitizers above for exactly what's dropped vs. defaulted.
 */
export const parsePipelineRunState = (raw: string | null): PipelineRunState | null => {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const rec = parsed;

  const pipelineId = rec.pipelineId;
  if (typeof pipelineId !== "string" || !pipelineId) return null;

  const pipelineName = typeof rec.pipelineName === "string" ? rec.pipelineName : "";
  const status: PipelineRunStatus = typeof rec.status === "string" && PIPELINE_RUN_STATUSES.has(rec.status)
    ? (rec.status as PipelineRunStatus)
    : "idle";

  const active = Array.isArray(rec.active)
    ? rec.active.map(sanitizeActiveStep).filter((a): a is PipelineActiveStep => a !== null)
    : [];
  const blocked = Array.isArray(rec.blocked)
    ? rec.blocked.map(sanitizeBlock).filter((b): b is PipelineBlock => b !== null)
    : [];
  const history = Array.isArray(rec.history)
    ? rec.history.map(sanitizeStepRecord).filter((h): h is PipelineStepRecord => h !== null)
    : [];
  const humanSteps = sanitizeHumanSteps(rec.humanSteps);

  // L-S4: both counters are (safe) integers by construction — the runner
  // only ever increments them by one — so a fractional, negative, or
  // beyond-2^53 stored value is corruption, not a real run. `capExtensions` is additionally capped at
  // `PIPELINE_LIMITS.capExtensionsMax` so `effectiveStepCap` can never scale
  // a run's allowance by an absurd factor off a hand-edited row.
  const stepCount = Number.isSafeInteger(rec.stepCount) && (rec.stepCount as number) >= 0 ? (rec.stepCount as number) : 0;
  // An old row has no run-wide seq counter: derive it from the highest seq
  // already used, so the next human gate or agent execution can't collide.
  let seqCounter = Number.isSafeInteger(rec.seqCounter) && (rec.seqCounter as number) >= 0
    ? (rec.seqCounter as number)
    : undefined;
  if (seqCounter === undefined) {
    let max = 0;
    for (const h of history) if (h.seq > max) max = h.seq;
    for (const g of humanSteps) if (g.seq > max) max = g.seq;
    for (const a of active) if (a.seq > max) max = a.seq;
    seqCounter = max;
  }
  const startedAt = isFiniteNumber(rec.startedAt) ? rec.startedAt : null;
  const endedAt = isFiniteNumber(rec.endedAt) ? rec.endedAt : null;

  return {
    pipelineId,
    pipelineName,
    snapshot: sanitizeRunSnapshot(rec.snapshot),
    status,
    active,
    joins: sanitizeJoins(rec.joins),
    blocked,
    history,
    humanSteps,
    seqCounter,
    stepCount,
    startedAt,
    endedAt,
    capExtensions: Number.isSafeInteger(rec.capExtensions) && (rec.capExtensions as number) >= 0
      ? Math.min(rec.capExtensions as number, PIPELINE_LIMITS.capExtensionsMax)
      : undefined,
    // A row written before the marker existed (no key at all): a `cancelled`
    // run was stopped, so it reads as stopped when it ended. Any other value
    // (an explicit `null` — every write since stores the key — or junk) is a
    // cleared marker and stays `null`, so it round-trips and is never
    // mistaken for a legacy row on the next read.
    stopRequestedAt: isFiniteNumber(rec.stopRequestedAt)
      ? rec.stopRequestedAt
      : !("stopRequestedAt" in rec) && status === "cancelled"
        ? (endedAt ?? 0)
        : null,
  };
};

/** Optional pre-computed grouped counts, threaded in by `tasks.list()` so a
 *  multi-row query does one pass over each in-memory registry instead of a
 *  per-row `countPendingForTask`/`countTerminals` scan (289 tasks × 2 linear
 *  scans on every 2s `/tasks` poll, before this). Single-task reads
 *  (`tasks.get`, `insert`, `update`) omit this and fall back to the
 *  per-task counters — called far less often than the poll. */
export interface TaskCounts {
  pending?: Map<string, number>;
  terminals?: Map<string, number>;
}

export const IMPORTED_CLAUDE_STATUSES = new Set(["importing", "ready", "failed"]);

/** Tolerant read of `tasks.imported_claude`. Bad JSON, or a shape missing a
 *  required field, reads as null — never throws. */
export function parseImportedClaude(raw: string | null | undefined): ImportedClaudeSession | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.sessionId !== "string" || o.sessionId.length === 0) return null;
  if (typeof o.configDir !== "string" || o.configDir.length === 0) return null;
  if (typeof o.status !== "string" || !IMPORTED_CLAUDE_STATUSES.has(o.status)) return null;
  if (typeof o.importedAt !== "number" || !Number.isFinite(o.importedAt)) return null;
  if (typeof o.backfillOffset !== "number" || !Number.isFinite(o.backfillOffset) || o.backfillOffset < 0) return null;
  const gitBranch = o.gitBranch === null ? null : typeof o.gitBranch === "string" ? o.gitBranch : undefined;
  if (gitBranch === undefined) return null;
  const error = o.error === null ? null : typeof o.error === "string" ? o.error : undefined;
  if (error === undefined) return null;
  return {
    sessionId: o.sessionId,
    gitBranch,
    importedAt: o.importedAt,
    configDir: o.configDir,
    status: o.status as ImportedClaudeSession["status"],
    backfillOffset: o.backfillOffset,
    error,
  };
}

export const IMPORTED_OPENCODE_STATUSES = new Set(["importing", "ready", "failed"]);

/** Tolerant read of `tasks.imported_opencode`, same contract as
 *  {@link parseImportedClaude}: bad JSON, or a shape missing a required
 *  field, reads as null — never throws. */
export function parseImportedOpencode(raw: string | null | undefined): ImportedOpencodeSession | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.sessionId !== "string" || o.sessionId.length === 0) return null;
  if (typeof o.harnessId !== "string" || o.harnessId.length === 0) return null;
  if (typeof o.directory !== "string" || o.directory.length === 0) return null;
  if (typeof o.status !== "string" || !IMPORTED_OPENCODE_STATUSES.has(o.status)) return null;
  if (typeof o.importedAt !== "number" || !Number.isFinite(o.importedAt)) return null;
  const error = o.error === null ? null : typeof o.error === "string" ? o.error : undefined;
  if (error === undefined) return null;
  return {
    sessionId: o.sessionId,
    harnessId: o.harnessId,
    directory: o.directory,
    importedAt: o.importedAt,
    status: o.status as ImportedOpencodeSession["status"],
    error,
  };
}

/** A row's `opencode_server` column, or a snapshot's `opencodeServer` field:
 *  a valid {@link OpencodeServerMode}, else `"shared"` (the column default).
 *  Shared by `toTask`, `toAgentProfile` and the profile-snapshot reader. */
export const readOpencodeServer = (raw: unknown): OpencodeServerMode =>
  (OPENCODE_SERVER_MODES as readonly unknown[]).includes(raw) ? (raw as OpencodeServerMode) : "shared";

/**
 * Parse a `tasks.repositories` column into a validated `TaskRepository[]`.
 * Anything malformed (not JSON, not an array, an entry missing `path`) reads
 * as `[]` — the caller then derives the single-repository entry from the
 * scalar columns, so a corrupted column can never crash a board poll. Values
 * are re-read defensively because this column is server-managed but still
 * lives in a user-editable SQLite file.
 */
export const parseTaskRepositories = (raw: unknown): TaskRepository[] => {
  if (typeof raw !== "string" || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: TaskRepository[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    if (typeof o.path !== "string" || o.path.length === 0) continue;
    if (typeof o.name !== "string" || o.name.length === 0) continue;
    const branch = typeof o.branch === "string" ? o.branch : null;
    const checkoutBranch = typeof o.checkoutBranch === "string" ? o.checkoutBranch : null;
    // An entry written before migration 092 carries a single `prUrl`: convert
    // it on read (the head is the last-seen checkout, else the branch; the base
    // and number were never recorded). A stored `prs` always wins.
    const prs = Array.isArray(o.prs)
      ? parseTaskPrs(o.prs)
      : legacyTaskPrs(typeof o.prUrl === "string" ? o.prUrl : null, checkoutBranch ?? branch);
    out.push({
      path: o.path,
      name: o.name,
      branch,
      branchSource: o.branchSource === "existing" ? "existing" : "created",
      worktreePath: typeof o.worktreePath === "string" ? o.worktreePath : null,
      baseRef: typeof o.baseRef === "string" ? o.baseRef : null,
      checkoutBranch,
      prUrl: firstPrUrl(prs),
      prs,
      baseBranch: typeof o.baseBranch === "string" ? o.baseBranch : null,
    });
  }
  return out;
};

/**
 * The JSON a `tasks.repositories` write stores. The deprecated derived `prUrl`
 * is dropped (it is recomputed from `prs` on every read), so the column holds
 * one source of truth per entry.
 */
export const serializeRepositories = (repos: readonly TaskRepository[]): string =>
  JSON.stringify(
    repos.map(({ prUrl, ...rest }) => ({
      ...rest,
      // A caller still holding the older shape (a `prUrl` and no `prs`) keeps
      // its PR: it is converted here, exactly as the read path would.
      prs: rest.prs ?? legacyTaskPrs(prUrl, rest.checkoutBranch ?? rest.branch),
    })),
  );

/**
 * The one-entry repository array a single-repository row derives, through the
 * same `repositoriesForTask` every other process uses (so the core and the
 * webview/CLI can't derive it differently). `branchSource` is normalized here
 * because the column is free text; the shared helper trusts its input.
 */
export const derivedRepositories = (r: TaskRow): TaskRepository[] =>
  repositoriesForTask({
    workdir: r.workdir,
    isolation: r.isolation as Task["isolation"],
    branch: r.branch,
    branchSource: r.branch_source === "existing" ? "existing" : "created",
    worktreePath: r.worktree_path,
    baseRef: r.base_ref,
    checkoutBranch: r.checkout_branch ?? null,
    prs: parseTaskPrs(r.prs),
    baseBranch: r.base_branch ?? null,
    repositories: [],
  });
