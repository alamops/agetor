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
  BranchInfo,
  TaskReference,
  TaskDiff,
  TaskGitStatus,
  GitHubIssueThreadResult,
} from "../shared/types.ts";
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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
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
  /** `unresolvedRefs` (omitted when empty) lists the raw `@`-tokens (verbatim,
   *  `@` included) in the task's prompt that didn't resolve to a real file
   *  under the freshly-materialized worktree/workdir — CLAUDE.md §12's
   *  send-time expansion contract. Advisory only; the run still starts. */
  startTask(id: string): Promise<{ runId: string; unresolvedRefs?: string[] }> {
    return this.req("POST", `/tasks/${id}/start`, undefined, START_TIMEOUT_MS);
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
   *  cwd. Advisory only; delivery isn't blocked on it. */
  sendInput(
    runId: string,
    line: string,
  ): Promise<{ delivered: boolean; runId?: string; reason?: string; unresolvedRefs?: string[] }> {
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
   *  list for that model — feed it to `discoveredEffortsFor`. */
  agentModels(): Promise<Record<string, { id: string; label?: string; efforts?: string[] }[]>> {
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
    byHarness: Record<string, { id: string; label?: string; efforts?: string[] }[]>;
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
  refreshAgentModels(harnessId?: string): Promise<Record<string, { id: string; label?: string; efforts?: string[] }[]>> {
    const qs = harnessId ? `?harness=${encodeURIComponent(harnessId)}` : "";
    return this.req("POST", `/agent-models${qs}`);
  }
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
  fast?: boolean;
  maxMode?: boolean;
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
  fast?: boolean;
  maxMode?: boolean;
  taskType?: string;
}

/** Body for POST /harnesses (kind: claude-code | codex | cursor | gemini). */
export interface CreateHarnessInput {
  id: string;
  kind: AgentKind;
  label: string;
  home?: string | null;
  bin?: string | null;
  env?: Record<string, string>;
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
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
