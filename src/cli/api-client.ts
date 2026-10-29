import {
  readCoreCreds,
  probeLiveCore,
  type CoreCreds,
} from "../bun/core-creds.ts";
import type {
  Task,
  Run,
  RunEvent,
  Project,
  Harness,
  HarnessStatus,
  HarnessUsage,
  AgentKind,
  AgentProfile,
  BranchInfo,
  Pipeline,
  PipelineInput,
  Handoff,
  TaskReference,
  TaskDiff,
  TaskGitStatus,
  TaskTeardownPreview,
  GitHubIssueThreadResult,
  GitProvider,
  DbStats,
  DbCompactResult,
  RetentionPassResult,
  Speed,
  OpencodeServerMode,
  OpencodeSessionList,
  BackgroundStatus,
  RemoteAccessStatus,
} from "../shared/types.ts";
import type { NotificationKind } from "../shared/os-notification.ts";
import type { BundleExportResponse } from "../shared/bundle.ts";
import type { BundleImportOptions, BundleImportPlan, BundleImportResponse } from "../shared/bundle-import.ts";
import type { AnyRequest, AskQuestionsAnswer } from "../bun/interactions.ts";
import type { AvailableCommand, AvailableExtension } from "../bun/commands.ts";

/** A discovered, verified-live Agetor core (the app or a cli-daemon). */
export type CoreInfo = CoreCreds;

/** One-shot request timeout. Discovery is already timeout-guarded; this guards
 *  against a core that accepts the connection but then stalls on the request,
 *  which would otherwise hang the CLI indefinitely with no feedback. */
const REQUEST_TIMEOUT_MS = 15_000;
/** `start` synchronously prepares the git worktree (off the pinned base ref),
 *  which can be slow on a large/cold repo — give it a more generous budget so a
 *  slow worktree create doesn't surface as a false "core did not respond". */
const START_TIMEOUT_MS = 60_000;
/** The issue-thread route fetches the issue plus its full comment thread from
 *  the provider's API (GitHub/GitLab/Bitbucket) — a cold call, or one with a
 *  long comment thread across pages, can comfortably exceed the default 15s
 *  budget. Mirrors `START_TIMEOUT_MS`'s rationale. */
const ISSUE_THREAD_TIMEOUT_MS = 60_000;
/** `/projects/clone` runs a real `git clone` (network-bound, can take
 *  minutes on a large repo) and, on the server side, may retry it once with
 *  an auth header after an anonymous attempt fails — but the server bounds
 *  the *whole* clone (the anonymous attempt plus the optional token retry
 *  together) to one shared 10-minute budget, plus a few seconds of
 *  credential resolution. 15 minutes leaves headroom on top of that for the
 *  explainer task's own create+start work, without the CLI's default
 *  one-shot timeout aborting a legitimate long clone out from under it. */
const CLONE_TIMEOUT_MS = 15 * 60_000;
/** `POST /agent-profiles/:id/duplicate` with `copyTasks` re-creates every
 *  eligible task through `createTask`. A worktree task resolves a git ref,
 *  and the route opts out of Bun's idle timeout, so a large copy can run
 *  for minutes. 10 minutes lets the CLI hear that one response. The default
 *  15s budget would abort while the core was still inserting, and a retry
 *  would create a second profile. */
const DUPLICATE_WITH_TASKS_TIMEOUT_MS = 10 * 60_000;
/** `POST /notifications` only hands the post to the OS; a core that does not
 *  answer quickly is as good as absent, and the caller falls back to posting
 *  the notification itself. */
const NOTIFY_TIMEOUT_MS = 5_000;

/** `GET /claude-sessions` parses every transcript Agetor does not own the
 *  first time it sees it, and `POST /claude-sessions/recheck` first runs
 *  `claude agents --json` once per Claude config dir (up to 8 s each). Both
 *  routes opt out of the server's idle timeout. */
const CLAUDE_SESSIONS_TIMEOUT_MS = 5 * 60_000;
/** `GET /opencode-sessions` and its `recheck` run `opencode session list`
 *  once per OpenCode harness × registered project (plus a busy-check export
 *  per unfinished session). Both routes opt out of the server's idle
 *  timeout, same as the Claude pair. */
const OPENCODE_SESSIONS_TIMEOUT_MS = 5 * 60_000;
/** `POST /db/compact` runs `VACUUM` + `wal_checkpoint(TRUNCATE)` on the core's
 *  single main thread — it rewrites the whole database file, so on a
 *  multi-GB DB (~7.5 s/GB, `DB_COMPACT_SEC_PER_GB`) the core is unresponsive
 *  for tens of seconds or more, and longer on a slow disk. The default 15s
 *  budget would abort the CLI while the VACUUM was still running (leaving the
 *  user guessing whether it finished); 15 minutes comfortably covers even a
 *  very large, cold database. */
const COMPACT_TIMEOUT_MS = 15 * 60_000;
/** `POST /db/retention/run` awaits a whole archived-history retention pass.
 *  The pass is time-sliced so the core stays responsive, but a FIRST pass over
 *  a multi-GB database trims many thousands of rows and can take minutes —
 *  same 15-minute ceiling as {@link COMPACT_TIMEOUT_MS} so a legitimate long
 *  pass is never aborted client-side (a re-run just resumes, trimmed rows are
 *  skipped, but there's no reason to make the user do that). */
const RETENTION_RUN_TIMEOUT_MS = 15 * 60_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /**
   * The response body's machine-readable `code`, when the core sent one
   * (`desktop-only`, `path-not-accessible`, …). Derived from `body` so every
   * `new ApiError(status, body, msg)` site keeps working unchanged; the
   * human sentence stays in `message`, which `req` already takes from the
   * body's `error`, so the CLI's central printer shows a refusal plainly.
   */
  get code(): string | undefined {
    const b = this.body;
    if (typeof b === "object" && b !== null && "code" in b) {
      const code = (b as { code: unknown }).code;
      if (typeof code === "string") return code;
    }
    return undefined;
  }
}

export interface ClaudeSessionSummary {
  sessionId: string;
  cwd: string;
  title: string;
  gitBranch: string | null;
  importable: boolean;
  blockedReason: "long-path" | "missing-folder" | "live" | "no-harness" | null;
  liveHint: string | null;
  liveness: "live" | "idle" | "unknown";
}

export interface ClaudeSessionSummaryList {
  sessions: ClaudeSessionSummary[];
  /** Oldest cached liveness probe behind the list; null when a config dir
   *  has none. Optional: an older core does not send it. */
  livenessCheckedAt?: number | null;
}

/**
 * Discover the running core via the creds file and verify it's alive + ours.
 * Returns null when nothing is running (or the creds are stale). `dataDir`
 * defaults to `$AGETOR_DATA_DIR` (or `~/.agetor`); pass it to target a
 * specific data tree (e.g. the dev `~/.agetor-dev`).
 */
export async function discoverCore(dataDir?: string): Promise<CoreInfo | null> {
  const creds = readCoreCreds(dataDir);
  if (!creds) return null;
  return (await probeLiveCore(creds)) ? creds : null;
}

/** Thin typed client over the localhost HTTP API. One per discovered core. */
export class AgetorClient {
  readonly base: string;
  constructor(
    readonly core: Pick<CoreInfo, "port" | "token">,
  ) {
    this.base = `http://127.0.0.1:${core.port}`;
  }

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.core.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ApiError(
          0,
          null,
          `core did not respond within ${timeoutMs / 1000}s (${method} ${path})`,
        );
      }
      throw new ApiError(
        0,
        null,
        `cannot reach core (${method} ${path}): ${(e as Error)?.message ?? String(e)}`,
      );
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const msg =
        (parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : null) ?? `${method} ${path} → ${res.status}`;
      throw new ApiError(res.status, parsed, msg);
    }
    return parsed as T;
  }

  // ── tasks ────────────────────────────────────────────────────────────────
  listTasks(): Promise<Task[]> {
    return this.req("GET", "/tasks");
  }
  getTask(id: string): Promise<Task> {
    return this.req("GET", `/tasks/${id}`);
  }
  // POST/PATCH/archive return the bare Task on success; errors come back as
  // 4xx and surface as a thrown ApiError from `req`.
  createTask(input: CreateTaskInput): Promise<Task> {
    return this.req("POST", "/tasks", input);
  }
  patchTask(id: string, patch: PatchTaskInput): Promise<Task> {
    return this.req("PATCH", `/tasks/${id}`, patch);
  }
  deleteTask(id: string): Promise<void> {
    return this.req("DELETE", `/tasks/${id}`);
  }
  /** Which branches `deleteTask` would remove (`task.branch`, plus the branch a
   *  drifted worktree is actually on, after the default-branch / PR-head /
   *  held-by-another-task exclusions). `null` when the running core predates
   *  the route (404) — callers fall back to their generic wording. */
  async getTeardownPreview(id: string): Promise<TaskTeardownPreview | null> {
    try {
      return await this.req<TaskTeardownPreview>("GET", `/tasks/${encodeURIComponent(id)}/teardown-preview`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }
  /** `unresolvedRefs` (omitted when empty) lists the raw `@`-tokens (verbatim,
   *  `@` included) in the task's prompt that didn't resolve to a real file
   *  under the freshly-materialized worktree/workdir — CLAUDE.md §12's
   *  send-time expansion contract. Advisory only; the run still starts.
   *  `pending` (omitted when falsy): spawn hasn't settled yet — run row exists, agent launch continues detached (plan §3.1). */
  startTask(
    id: string,
  ): Promise<{ runId: string; unresolvedRefs?: string[]; pending?: true }> {
    return this.req("POST", `/tasks/${id}/start`, undefined, START_TIMEOUT_MS);
  }
  listClaudeSessions(): Promise<ClaudeSessionSummaryList> {
    return this.req("GET", "/claude-sessions", undefined, CLAUDE_SESSIONS_TIMEOUT_MS);
  }
  recheckClaudeSessions(): Promise<ClaudeSessionSummaryList> {
    return this.req("POST", "/claude-sessions/recheck", undefined, CLAUDE_SESSIONS_TIMEOUT_MS);
  }
  importClaudeSessions(ids: string[]): Promise<{ results: { id: string; taskId?: string; error?: string }[] }> {
    // The route opts out of the server idle timeout. The default 15s budget
    // aborts a transcript import that is still running.
    return this.req("POST", "/claude-sessions/import", { ids }, CLONE_TIMEOUT_MS);
  }
  listOpencodeSessions(): Promise<OpencodeSessionList> {
    return this.req("GET", "/opencode-sessions", undefined, OPENCODE_SESSIONS_TIMEOUT_MS);
  }
  recheckOpencodeSessions(): Promise<OpencodeSessionList> {
    return this.req("POST", "/opencode-sessions/recheck", undefined, OPENCODE_SESSIONS_TIMEOUT_MS);
  }
  /** `harnessId` names the OpenCode harness to import under (default: the
   *  one that listed each session). */
  importOpencodeSessions(
    ids: string[],
    harnessId?: string,
  ): Promise<{ results: { id: string; taskId?: string; error?: string }[] }> {
    // The route opts out of the server idle timeout; an export of a long
    // session plus its event replay can outlast the default 15s budget.
    return this.req("POST", "/opencode-sessions/import", harnessId ? { ids, harnessId } : { ids }, CLONE_TIMEOUT_MS);
  }
  /** Re-run a failed OpenCode history backfill; the route waits for it. */
  retryOpencodeSessionImport(taskId: string): Promise<{ ok: true }> {
    return this.req("POST", `/tasks/${encodeURIComponent(taskId)}/opencode-session/retry`, undefined, CLONE_TIMEOUT_MS);
  }
  archiveTask(id: string): Promise<Task> {
    return this.req("POST", `/tasks/${id}/archive`);
  }
  unarchiveTask(id: string): Promise<Task> {
    return this.req("POST", `/tasks/${id}/unarchive`);
  }
  getRuns(id: string): Promise<Run[]> {
    return this.req("GET", `/tasks/${id}/runs`);
  }
  getDiff(id: string): Promise<TaskDiff> {
    return this.req("GET", `/tasks/${id}/diff`);
  }
  getGitStatus(id: string): Promise<TaskGitStatus> {
    return this.req("GET", `/tasks/${id}/git-status`);
  }

  // ── runs ─────────────────────────────────────────────────────────────────
  /** `unresolvedRefs` (omitted when empty) mirrors `startTask`'s field — the
   *  raw `@`-tokens in `line` that didn't resolve against the task's live
   *  cwd. Advisory only; delivery isn't blocked on it.
   *  `pending` (omitted when falsy): spawn hasn't settled yet — run row exists, agent launch continues detached (plan §3.1). */
  sendInput(
    runId: string,
    line: string,
  ): Promise<{
    delivered: boolean;
    runId?: string;
    reason?: string;
    unresolvedRefs?: string[];
    pending?: true;
  }> {
    return this.req("POST", `/runs/${runId}/input`, { line });
  }
  cancelRun(runId: string): Promise<{ ok?: boolean; cancelled?: boolean }> {
    return this.req("POST", `/runs/${runId}/cancel`);
  }
  rebuildEvents(runId: string): Promise<{ events: RunEvent[]; reason?: string }> {
    return this.req("GET", `/runs/${runId}/rebuild-events`);
  }

  // ── interactions (needs-answer) ────────────────────────────────────────────
  pendingInteractions(taskId: string): Promise<AnyRequest[]> {
    return this.req("GET", `/tasks/${taskId}/interactions/pending`);
  }
  answerAskQuestions(
    id: string,
    answers: AskQuestionsAnswer["answers"],
  ): Promise<{ ok: boolean }> {
    return this.req("POST", `/ask-questions/${id}/answer`, { answers });
  }
  answerTmuxPrompt(
    id: string,
    body: { key?: string; reject?: boolean },
  ): Promise<{ ok: boolean; error?: string }> {
    return this.req("POST", `/tmux-prompts/${id}/answer`, body);
  }
  answerFxPermission(
    id: string,
    body: { optionId: string } | { cancel: true },
  ): Promise<{ ok: boolean }> {
    return this.req("POST", `/fx-permissions/${id}/answer`, body);
  }
  /** Continue an fx response a Vercel AI Gateway rate limit (or another
   *  recoverable provider error) paused mid-turn — `docs/plans/
   *  fix-fx-harness-rate-limit.md` §3.5. Sends no new prompt; the server
   *  spawns a fresh run in the task's existing fx session with
   *  `_meta.fx.continueRecovery: true`, resuming from fx's own checkpoint.
   *  Only an fx task whose latest run ended with a resumable `paused`
   *  recovery sentinel qualifies — the server 400s/404s/409s otherwise, and
   *  that error text (including fx's own verbatim `-32602` message on a
   *  rejected continue) propagates as a thrown `ApiError` like every other
   *  call here. */
  resumeFxRecovery(taskId: string): Promise<{ ok: true; runId: string }> {
    return this.req("POST", `/tasks/${encodeURIComponent(taskId)}/fx-resume`);
  }
  /** Cancel a pending fx auto-resume timer (`docs/plans/
   *  fx-recovery-follow-ups.md` §3.4) without resuming the paused response
   *  itself — the task stays paused, `task.fxRecovery.autoResume` clears to
   *  `null` with `autoResumeStopped: "cancelled"`. 400 when the task isn't
   *  currently paused with a pending timer, 404 for a bad task id; both
   *  propagate as a thrown `ApiError` like every other call here. */
  cancelFxAutoResume(taskId: string): Promise<{ ok: true }> {
    return this.req("DELETE", `/tasks/${encodeURIComponent(taskId)}/fx-auto-resume`);
  }

  // ── background + remote access (docs/plans/always-on-host.md §3.5) ────────
  /** `GET /background` — the derived "Keep Agetor running in the background"
   *  state. `fresh` bypasses the core's 2 s status cache. A 404 `ApiError`
   *  means the running core predates the route. */
  getBackground(opts: { fresh?: boolean } = {}): Promise<BackgroundStatus> {
    const qs = opts.fresh ? "?fresh=1" : "";
    return this.req("GET", `/background${qs}`);
  }
  /** `DELETE /background` — unregister the login item (also turns remote
   *  access off). Allowed for the CLI token; turning it ON is desktop-only. */
  turnOffBackground(): Promise<BackgroundStatus> {
    // The helper's unregister may take up to ~25 s (login-item-helper.ts), so
    // the default 15 s would abandon a call that is still succeeding.
    return this.req("DELETE", "/background", undefined, START_TIMEOUT_MS);
  }
  /** `POST /background/start` — start the background core now. 409 `ApiError`
   *  (body `{ error, code }`) unless the login item is enabled and no
   *  supervisor is alive. */
  startBackground(): Promise<BackgroundStatus> {
    // reregister may take up to ~31 s (login-item-helper.ts).
    return this.req("POST", "/background/start", undefined, START_TIMEOUT_MS);
  }
  /** `GET /remote-access` — remote access (preview) on/off. */
  getRemoteAccess(): Promise<RemoteAccessStatus> {
    return this.req("GET", "/remote-access");
  }
  /** `DELETE /remote-access` — turn remote access off. There is deliberately
   *  no CLI route that turns it on (only the app's native box can). */
  turnOffRemoteAccess(): Promise<RemoteAccessStatus> {
    return this.req("DELETE", "/remote-access");
  }
  /** `POST /daemon/shutdown`. No `mode` sends no body, which the core reads as
   *  `"stop"`; `"handoff"` is what the app sends a background core it is
   *  taking the port from. The core usually exits before answering, so a
   *  dropped connection surfaces as an `ApiError` with status 0 — callers that
   *  mean "stop it and move on" swallow it. */
  async shutdownCore(mode?: "stop" | "handoff"): Promise<void> {
    await this.req<unknown>("POST", "/daemon/shutdown", mode ? { mode } : undefined);
  }

  // ── database maintenance (docs/plans/non-blocking-session-restore.md §2.4) ─
  /** `GET /db/stats` — size on disk, reclaimable bytes, the Compact time
   *  estimate, in-flight run count and the retention status. A 404 means the
   *  running core predates the route (`ApiError`, callers say so). */
  dbStats(): Promise<DbStats> {
    return this.req("GET", "/db/stats");
  }
  /** `POST /db/compact` — `VACUUM` the database. Blocks the core for the
   *  duration (see {@link COMPACT_TIMEOUT_MS}). A refusal while runs are in
   *  flight is a 409 `ApiError` whose `body` is `{ error, activeRunCount }`
   *  and whose `message` is the server's `error` text. */
  compactDb(): Promise<DbCompactResult> {
    return this.req("POST", "/db/compact", undefined, COMPACT_TIMEOUT_MS);
  }
  /** `POST /db/retention/run` — run one archived-history retention pass now.
   *  400 `ApiError` when the `archivedHistoryRetentionDays` preference is
   *  `off`; 409 while a pass is already running. */
  runRetentionPass(): Promise<RetentionPassResult> {
    return this.req("POST", "/db/retention/run", undefined, RETENTION_RUN_TIMEOUT_MS);
  }

  // ── notifications ──────────────────────────────────────────────────────────
  /** `POST /notifications` — post a desktop notification through the core's
   *  native bridge (the app). Rejects with an `ApiError` on any non-2xx,
   *  including the headless core's 501, so the caller can fall back. */
  notifyOS(input: {
    title: string;
    body?: string;
    subtitle?: string;
    silent?: boolean;
    taskId?: string;
    kind?: NotificationKind;
  }): Promise<{ ok: boolean }> {
    return this.req("POST", "/notifications", input, NOTIFY_TIMEOUT_MS);
  }

  // ── projects ───────────────────────────────────────────────────────────────
  listProjects(): Promise<Project[]> {
    return this.req("GET", "/projects");
  }
  addProject(path: string, name?: string): Promise<Project> {
    return this.req("POST", "/projects", { path, name });
  }
  removeProject(path: string): Promise<void> {
    return this.req("DELETE", "/projects", { path });
  }
  listBranches(path: string): Promise<BranchInfo[]> {
    return this.req("GET", `/projects/branches?path=${encodeURIComponent(path)}`);
  }
  /** Clone a GitHub/GitLab/Bitbucket repo as a new project (`POST
   *  /projects/clone`, plan `docs/plans/clone-repository-all-providers.md`
   *  §3 D6, progress + cancel per Addendum A). `provider` only matters for
   *  `owner/repo` shorthand — a full URL's own detected provider wins
   *  server-side; `dest` must already be absolute (the CLI resolves it
   *  against its own cwd before calling this). `eli5` defaults server-side
   *  to `true` (create + start an explainer task); pass `false` to skip it.
   *  `cloneId` (a client-minted UUID) correlates this call with the
   *  `clone_progress` `AppEvent`s broadcast on `GET /app/events` while the
   *  clone is in flight, and is what {@link cancelClone} targets — the
   *  server mints its own id and echoes it back when the caller omits one,
   *  but every caller that wants to observe progress or cancel must pass
   *  its own so it's known before the response arrives. Uses
   *  {@link CLONE_TIMEOUT_MS} instead of the default budget — see its doc
   *  comment. A cancelled clone rejects with a 409 `ApiError` whose `body`
   *  carries `{ cancelled: true }` (see `cancelClone`). */
  cloneProject(input: {
    url: string;
    provider?: GitProvider;
    dest?: string;
    eli5?: boolean;
    cloneId?: string;
  }): Promise<{
    project: Project;
    // Optional: the response field is additive, and this CLI talks to
    // whatever core is already running rather than one it just built — an
    // older daemon predating this field omits it, so callers must tolerate
    // a clone succeeding with no `provider` back.
    provider?: GitProvider;
    eli5TaskId: string | null;
    eli5Error: string | null;
    // Optional for the same reason: an older daemon never echoes it back,
    // and a caller that didn't pass one in already has whatever it minted.
    cloneId?: string;
  }> {
    return this.req("POST", "/projects/clone", input, CLONE_TIMEOUT_MS);
  }
  /** Cancel the in-flight `POST /projects/clone` request identified by
   *  `cloneId` (`DELETE /projects/clone/:cloneId`, Addendum A) — kills the
   *  running `git clone` process server-side and removes any destination
   *  directory it created (an existing empty dir it cloned into is left).
   *  The held POST itself then rejects with a 409 `ApiError`, never this
   *  call's own response. 404 (already settled, or an id nothing ever
   *  registered) propagates as a thrown `ApiError` like every other call
   *  here — `cmdClone`'s SIGINT handler is the caller that expects and
   *  swallows that specific case. */
  cancelClone(cloneId: string): Promise<{ ok: boolean }> {
    return this.req("DELETE", `/projects/clone/${encodeURIComponent(cloneId)}`);
  }
  /** List a scope's files for the `@`-mention picker (`GET /files/index`) —
   *  the same route the webview's `useProjectFiles` calls. Two modes,
   *  mirroring `src/bun/project-files.ts` / CLAUDE.md §12: pass `ref` to list
   *  the tracked files at that ref (previewing a worktree that hasn't been
   *  materialized yet — e.g. an isolated task before its first run); omit it
   *  to list the live working tree at `dir` (tracked + untracked-not-
   *  ignored). Capped at `MAX_PROJECT_FILES` server-side; `truncated` reports
   *  when that cap was hit. */
  listProjectFiles(scope: {
    dir: string;
    ref?: string | null;
    /** Full-depth server-side search (monorepo fallback past the 20k cap):
     *  when set — the empty string counts — the server ranks files + derived
     *  directories over the ENTIRE listing with the shared scorer and returns
     *  up to `limit` (default 50) matches; `truncated` then reports the
     *  internal scan cap, not the display cap. */
    q?: string | null;
    limit?: number;
  }): Promise<{ files: string[]; truncated: boolean }> {
    const params = new URLSearchParams({ dir: scope.dir });
    if (scope.ref) params.set("ref", scope.ref);
    if (scope.q != null) params.set("q", scope.q);
    if (scope.limit != null) params.set("limit", String(scope.limit));
    return this.req("GET", `/files/index?${params.toString()}`);
  }

  // ── github issues ────────────────────────────────────────────────────────
  /** Fetch a GitHub/GitLab/Bitbucket issue (identified by its provider number)
   *  and its full comment thread for the repo at `path` — the same route the
   *  webview's issue dialogs and New Task form use. Powers `agetor add
   *  --issue`'s derived title/prompt/snapshot. */
  getIssueThread(path: string, number: number): Promise<{ ok: true } & GitHubIssueThreadResult> {
    const params = new URLSearchParams({ path, number: String(number) });
    return this.req("GET", `/github/issue-thread?${params.toString()}`, undefined, ISSUE_THREAD_TIMEOUT_MS);
  }

  // ── harnesses ──────────────────────────────────────────────────────────────
  listHarnesses(): Promise<{ harnesses: Harness[]; statuses: HarnessStatus[] }> {
    return this.req("GET", "/harnesses");
  }
  createHarness(input: CreateHarnessInput): Promise<Harness> {
    return this.req("POST", "/harnesses", input);
  }
  patchHarness(id: string, patch: HarnessPatchInput): Promise<Harness> {
    return this.req("PATCH", `/harnesses/${id}`, patch);
  }
  deleteHarness(id: string): Promise<void> {
    return this.req("DELETE", `/harnesses/${id}`);
  }
  harnessUsage(id: string): Promise<HarnessUsage> {
    return this.req("GET", `/harnesses/${id}/usage`);
  }
  harnessShellEnv(id: string): Promise<HarnessShellEnv> {
    return this.req("GET", `/harnesses/${id}/shell-env`);
  }
  info(): Promise<{ version: string }> {
    return this.req("GET", "/info");
  }
  defaults(): Promise<{ home: string; cwd: string; dataDir: string }> {
    return this.req("GET", "/defaults");
  }

  // ── agent profiles ──────────────────────────────────────────────────────
  /** `GET /agent-profiles` — every profile, name ASC. */
  listAgentProfiles(): Promise<AgentProfile[]> {
    return this.req("GET", "/agent-profiles");
  }
  /** `GET /agent-profiles/:id` — 404 propagates as a thrown `ApiError`. */
  getAgentProfile(id: string): Promise<AgentProfile> {
    return this.req("GET", `/agent-profiles/${encodeURIComponent(id)}`);
  }
  /** `POST /agent-profiles` — 400 unknown/invalid harness, 409 duplicate
   *  (case-insensitive, trimmed) name; both propagate as a thrown `ApiError`. */
  createAgentProfile(input: AgentProfileInput): Promise<AgentProfile> {
    return this.req("POST", "/agent-profiles", input);
  }
  /** `POST /agent-profiles/:id/duplicate` — 404 unknown source, 409 name clash.
   *  Task-copy failures come back in `taskCopyErrors`, not as an error. */
  async duplicateAgentProfile(id: string, input: DuplicateAgentProfileInput): Promise<DuplicateAgentProfileResult> {
    try {
      return await this.req(
        "POST",
        `/agent-profiles/${encodeURIComponent(id)}/duplicate`,
        input,
        input.copyTasks ? DUPLICATE_WITH_TASKS_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
      );
    } catch (e) {
      // The server may already have inserted the profile (and any task copies)
      // before the socket dropped. A blind retry would create another one.
      if (e instanceof ApiError && e.status === 0) {
        throw new ApiError(
          0,
          e.body,
          `${e.message} — the copy may have been created; check the profile list before retrying`,
        );
      }
      throw e;
    }
  }
  /** `PATCH /agent-profiles/:id` — same validation as create. */
  patchAgentProfile(id: string, patch: Partial<AgentProfileInput>): Promise<AgentProfile> {
    return this.req("PATCH", `/agent-profiles/${encodeURIComponent(id)}`, patch);
  }
  /** `DELETE /agent-profiles/:id` — never blocked; tasks that already ran
   *  keep their snapshot. */
  deleteAgentProfile(id: string): Promise<void> {
    return this.req("DELETE", `/agent-profiles/${encodeURIComponent(id)}`);
  }
  /** `DELETE /tasks/:id/agent-profile` — detach a bound task from its
   *  profile (keeps the copied agent/model/effort/mode/speed/maxMode values,
   *  unlocks them for PATCH). Returns the full updated `Task`; 404 unknown
   *  task, 409 archived. */
  detachTaskAgentProfile(taskId: string): Promise<Task> {
    return this.req("DELETE", `/tasks/${encodeURIComponent(taskId)}/agent-profile`);
  }

  // ── pipelines ────────────────────────────────────────────────────────────
  /** `GET /pipelines` — every pipeline, name ASC, with `taskCount`. */
  listPipelines(): Promise<Pipeline[]> {
    return this.req("GET", "/pipelines");
  }
  /** `GET /pipelines/:id` — 404 propagates as a thrown `ApiError`. */
  getPipeline(id: string): Promise<Pipeline> {
    return this.req("GET", `/pipelines/${encodeURIComponent(id)}`);
  }
  /** `POST /pipelines` — 400 invalid graph/limits, 409 duplicate
   *  (case-insensitive, trimmed) name; both propagate as a thrown `ApiError`. */
  createPipeline(input: PipelineInput): Promise<Pipeline> {
    return this.req("POST", "/pipelines", input);
  }
  /** `PATCH /pipelines/:id` — same validation as create (partial body). */
  updatePipeline(id: string, patch: Partial<PipelineInput>): Promise<Pipeline> {
    return this.req("PATCH", `/pipelines/${encodeURIComponent(id)}`, patch);
  }
  /** `DELETE /pipelines/:id` — never blocked; tasks already launched from it
   *  keep their frozen run snapshot. */
  deletePipeline(id: string): Promise<void> {
    return this.req("DELETE", `/pipelines/${encodeURIComponent(id)}`);
  }
  // ── Agents + Pipelines bundle (docs/plans/agents-pipelines-import-export.md) ──
  /** `POST /bundle/export` — the canonical bundle text for a selection (ids,
   *  or `all`). 400 on an empty selection or an unknown id. */
  exportBundle(selection: { agentIds?: string[]; pipelineIds?: string[]; all?: boolean }): Promise<BundleExportResponse> {
    return this.bundleReq("/bundle/export", selection, undefined, "the core's answer to the export was lost — try again");
  }
  /** `POST /bundle/import/preview` — dry run: what an import would create,
   *  rename and bind. 400 `{ error, code }` for a file that doesn't parse.
   *  Probes harness status, hence the longer budget. */
  previewBundleImport(text: string, options: BundleImportOptions = {}): Promise<BundleImportPlan> {
    return this.bundleReq(
      "/bundle/import/preview",
      { text, options },
      START_TIMEOUT_MS,
      "the core's answer to the preview was lost — try again",
    );
  }
  /** `POST /bundle/import` — all or nothing. 400 as preview; 409 `{ error,
   *  plan }` (thrown `ApiError` with that body) when the plan is blocked, or
   *  when `planFingerprint` (a previewed plan's) no longer matches. */
  importBundle(
    text: string,
    options: BundleImportOptions = {},
    planFingerprint?: string,
  ): Promise<BundleImportResponse> {
    const body = planFingerprint === undefined ? { text, options } : { text, options, planFingerprint };
    return this.bundleReq(
      "/bundle/import",
      body,
      START_TIMEOUT_MS,
      "the core's answer to the import was lost, so the import may have run — check `agetor profile ls` and `agetor pipeline ls` before importing again",
      true,
    );
  }

  /** A `/bundle/*` POST whose 2xx must be a JSON object. `req` hands back an
   *  unparsable body as its raw string (and a body cut off mid-read throws a
   *  bare TypeError), which the printers would trip over — after an import
   *  that may well have committed. Either case throws `lost` instead.
   *  `transportLost` (the import) also maps a request that got no answer at
   *  all — a timeout or a dropped socket, `ApiError(0)` from `req` — to
   *  `lost`, keeping `req`'s own text as the cause: the request may have
   *  reached the core, and a rerun would create "(imported)" duplicates. */
  private async bundleReq<T>(
    path: string,
    body: unknown,
    timeoutMs: number | undefined,
    lost: string,
    transportLost = false,
  ): Promise<T> {
    let parsed: unknown;
    try {
      parsed = await this.req<unknown>("POST", path, body, timeoutMs);
    } catch (e) {
      if (e instanceof ApiError) {
        if (transportLost && e.status === 0) throw new ApiError(0, null, `${lost} (${e.message})`);
        throw e;
      }
      throw new ApiError(0, null, lost);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ApiError(0, null, lost);
    return parsed as T;
  }

  /** `GET /tasks/:id/pipeline` — `id` is a pipeline (parent) task's id; 404
   *  unknown task, 400 the task isn't a pipeline task. Returns the parent
   *  task (with its live `pipelineRun`) plus every hidden step task
   *  (`pipelineParentId === id`) it has launched so far. */
  getPipelineRun(taskId: string): Promise<{ task: Task; steps: Task[] }> {
    return this.req("GET", `/tasks/${encodeURIComponent(taskId)}/pipeline`);
  }
  /** `POST /tasks/:id/pipeline/retry` — retry the current blocked/cancelled
   *  step execution(s). 409 unless the pipeline run is actually blocked or
   *  cancelled. `targetTaskId` narrows the retry to one specific active
   *  execution's task id (the route's optional body `taskId`) — omitted,
   *  every eligible active execution plus every pending run-level block is
   *  retried, same as before this parameter existed. */
  retryPipeline(taskId: string, targetTaskId?: string): Promise<Task> {
    // `START_TIMEOUT_MS`, like `startTask`/`restartPipeline`: the route
    // re-verifies (and may re-materialize) the shared worktree before it
    // relaunches a step, which is exactly the slow git work the generous
    // start budget exists for.
    return this.req(
      "POST",
      `/tasks/${encodeURIComponent(taskId)}/pipeline/retry`,
      targetTaskId !== undefined ? { taskId: targetTaskId } : undefined,
      START_TIMEOUT_MS,
    );
  }
  /** `POST /tasks/:id/pipeline/cancel` — stop every active step execution
   *  and return the pipeline task to `ready`. */
  cancelPipeline(taskId: string): Promise<Task> {
    return this.req("POST", `/tasks/${encodeURIComponent(taskId)}/pipeline/cancel`);
  }
  /** `POST /tasks/:id/pipeline/advance` — manually resolve whatever the run
   *  is currently waiting on: `nextStepIds: null` ends the run here
   *  (terminal), a non-empty array launches each named step id. `fromTaskId`
   *  targets a specific blocked/awaiting execution when more than one is in
   *  play (e.g. a fan-out); omitted, the sole such execution is used. 400
   *  bad body, 404 unknown parent, 409 wrong run state — all propagate as a
   *  thrown `ApiError`. */
  advancePipeline(
    taskId: string,
    body: { nextStepIds: string[] | null; handoff?: Partial<Handoff>; fromTaskId?: string },
  ): Promise<Task> {
    // `START_TIMEOUT_MS` for the same reason as `retryPipeline`: advancing
    // launches the named next step(s), refreshing the shared worktree first.
    return this.req("POST", `/tasks/${encodeURIComponent(taskId)}/pipeline/advance`, body, START_TIMEOUT_MS);
  }
  /** `POST /tasks/:id/pipeline/restart` — restart a pipeline run from its
   *  start step (e.g. one that already finished `done`), discarding current
   *  progress. Mirrors `startTask`'s own response shape (it launches the
   *  first step's agent synchronously, same as a plain start) rather than
   *  returning the task — 404 unknown parent, 400 not a pipeline task, 409
   *  every other failure (already running, snapshot build failed, …), all
   *  propagating as a thrown `ApiError`. */
  restartPipeline(taskId: string): Promise<{ runId: string; pending?: true }> {
    return this.req("POST", `/tasks/${encodeURIComponent(taskId)}/pipeline/restart`, undefined, START_TIMEOUT_MS);
  }

  // ── preferences (cross-session key/value store) ────────────────────────────
  getPreferences(): Promise<Record<string, string>> {
    return this.req("GET", "/preferences");
  }
  setPreference(key: string, value: string): Promise<void> {
    return this.req("PUT", `/preferences/${encodeURIComponent(key)}`, { value });
  }

  // ── agent discovery (slash commands + extensions) ──────────────────────────
  agentDiscovery(
    agent: string,
    workdir: string | null,
    branch: string | null,
  ): Promise<{ commands: AvailableCommand[]; extensions: AvailableExtension[] }> {
    const params = new URLSearchParams({ agent });
    if (workdir) params.set("workdir", workdir);
    if (branch) params.set("branch", branch);
    return this.req("GET", `/agent-discovery?${params.toString()}`);
  }
  /** Kind-level discovered model catalog (fx's row is the built-in fx
   *  harness's list). The server's actual shape has always been
   *  `{id, label?}[]` per kind — the prior `string[]` annotation here was
   *  wrong, just never exercised since callers only ever read `.id`.
   *  `efforts` (bare effort ids the CLI reported; codex only today) is
   *  present only when the daemon's discovery probe reported a non-empty
   *  list for that model — feed it to `discoveredEffortsFor`. `fast`/
   *  `ultrafast` (fx ≥0.0.14 speed options) are present only when `true`. */
  agentModels(): Promise<Record<string, DiscoveredModelRow[]>> {
    return this.req("GET", "/agent-models");
  }
  /** Per-harness discovered model catalog — a key per *enabled* harness
   *  (not just per kind), so a second fx harness with its own account sees
   *  its own list. `ready` is false until the first full discovery sweep
   *  has resolved at least once since boot. Falls back to the kind map
   *  (via `.catch` at the call site) against an older daemon that hasn't
   *  landed this route yet. */
  harnessModels(): Promise<{
    ready: boolean;
    byHarness: Record<string, DiscoveredModelRow[]>;
  }> {
    return this.req("GET", "/agent-models/harnesses");
  }
  /** Force a fresh discovery sweep. Omit `harnessId` to refresh every
   *  enabled harness; pass one to refresh just that harness (e.g. right
   *  after `fx login`). Returns the same kind-keyed map as `agentModels()`
   *  — byte-compatible with that route, so a refresh of a non-built-in fx
   *  harness (e.g. `fx-2`) is NOT reflected in this response (the kind map
   *  only ever carries the built-in fx harness's list). Callers that need
   *  the per-harness view must call `harnessModels()` afterwards. */
  refreshAgentModels(harnessId?: string): Promise<Record<string, DiscoveredModelRow[]>> {
    const qs = harnessId ? `?harness=${encodeURIComponent(harnessId)}` : "";
    return this.req("POST", `/agent-models${qs}`);
  }
}

/** One row of a discovered model catalog (`GET /agent-models`, `GET
 *  /agent-models/harnesses`) — the server's `DiscoveredModel` shape. */
export interface DiscoveredModelRow {
  id: string;
  label?: string;
  efforts?: string[];
  fast?: boolean;
  ultrafast?: boolean;
}

/** Body for POST /tasks (mirrors the server's accepted fields). */
export interface CreateTaskInput {
  title: string;
  prompt: string;
  agent?: string;
  workdir?: string;
  isolation?: "worktree" | "none";
  mode?: string | null;
  model?: string | null;
  effort?: string | null;
  /** Speed tier. The CLI always sends `speed`, never the legacy `fast`
   *  alias (`resolveSpeedInput` on the server still accepts it). */
  speed?: Speed;
  maxMode?: boolean;
  /** OpenCode's server option (D-4); the server defaults it to `"shared"`. */
  opencodeServer?: OpencodeServerMode;
  taskType?: string;
  /** Match the app's "Run task", which creates the task in "ready" before
   *  starting (vs "backlog" when queued). */
  column?: string;
  references?: TaskReference[];
  baseRef?: string;
  /** GitHub/GitLab/Bitbucket issue this task was seeded from (create-only). */
  issueUrl?: string;
  /** Rendered issue + comment-thread snapshot; requires `issueUrl`. */
  issueSnapshot?: string;
  /** Id of an {@link AgentProfile} to launch from (create-only) — the server
   *  resolves it and overrides `agent`/`model`/`effort`/`mode`/`speed`/
   *  `maxMode`/`opencodeServer` from the profile; 400 on an unknown id.
   *  Mutually exclusive with setting those seven fields yourself — the CLI (`agetor add
   *  --profile`) enforces that client-side before this ever reaches the
   *  wire. */
  agentProfileId?: string;
  /** Id of a {@link Pipeline} to launch this task from (create-only) — the
   *  server validates it, seeds the parent's idle `pipelineRun` state, and
   *  sets the (cosmetic — the parent never itself spawns an agent) `agent`
   *  field from the pipeline's start step's harness. 400 on an unknown id,
   *  and 400 when combined with `agentProfileId` — mutually exclusive, and
   *  the CLI (`agetor add --pipeline`) enforces that client-side before this
   *  ever reaches the wire, mirroring `agentProfileId`'s own guard. */
  pipelineId?: string;
}

/** Body shared by `POST /agent-profiles` and `PATCH /agent-profiles/:id`
 *  (partial there). Mirrors {@link AgentProfile} minus its server-assigned
 *  `id`/`createdAt`/`updatedAt`. */
export interface AgentProfileInput {
  name: string;
  harness: string;
  model: string;
  effort: string | null;
  mode: string | null;
  speed: Speed;
  maxMode: boolean;
  /** OpenCode's server option (D-4). Omitted ⇒ `"shared"` on create,
   *  unchanged on PATCH, copied from the source on duplicate. */
  opencodeServer?: OpencodeServerMode;
  instructions: string;
  skills: string[];
}

/** Body for `POST /agent-profiles/:id/duplicate`; omitted fields copy the source. */
export interface DuplicateAgentProfileInput extends Partial<AgentProfileInput> {
  copyTasks?: boolean;
}

export interface DuplicateAgentProfileResult {
  profile: AgentProfile;
  copiedTasks: Task[];
  taskCopyErrors: { sourceTaskId: string; error: string }[];
}

/** Server-side allow-list for PATCH /tasks/:id. */
export interface PatchTaskInput {
  title?: string;
  prompt?: string;
  agent?: string;
  workdir?: string;
  column?: string;
  mode?: string | null;
  model?: string | null;
  effort?: string | null;
  speed?: Speed;
  maxMode?: boolean;
  opencodeServer?: OpencodeServerMode;
  taskType?: string;
}

/** Body for POST /harnesses (kind: any {@link AgentKind}). */
export interface CreateHarnessInput {
  id: string;
  kind: AgentKind;
  label: string;
  home?: string | null;
  bin?: string | null;
  env?: Record<string, string>;
  /** fx only: load fx's own profile MCP servers (`_meta.fx.profileMcpServers`)
   *  into each session. Omitted ⇒ the server default (on). */
  profileMcpServers?: boolean;
}

/** Resolved harness environment for `agetor harness shell` (GET /harnesses/:id/shell-env). */
export interface HarnessShellEnv {
  env: Record<string, string>;
  binDir: string | null;
  launch: string;
  kind: AgentKind;
}

/** Body for PATCH /harnesses/:id. label/home/bin/env are config edits (rejected
 *  on built-ins); enabled is a soft-delete toggle allowed even on built-ins. */
export interface HarnessPatchInput {
  label?: string;
  home?: string | null;
  bin?: string | null;
  env?: Record<string, string>;
  enabled?: boolean;
  /** fx only: the "Load profile MCP servers" toggle. */
  profileMcpServers?: boolean;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
