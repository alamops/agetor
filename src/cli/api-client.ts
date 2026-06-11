import {
  readCoreCreds,
  probeLiveCore,
  type CoreCreds,
} from "../bun/core-creds.ts";
import type {
  Task,
  Run,
  Project,
  Harness,
  HarnessStatus,
  HarnessUsage,
  AgentKind,
  BranchInfo,
  TaskReference,
  TaskDiff,
} from "../shared/types.ts";
import type { AnyRequest, AskQuestionsAnswer } from "../bun/interactions.ts";

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
  startTask(id: string): Promise<{ runId: string }> {
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
  getGitStatus(id: string): Promise<{ hasChanges: boolean; ignored?: boolean }> {
    return this.req("GET", `/tasks/${id}/git-status`);
  }

  // ── runs ─────────────────────────────────────────────────────────────────
  sendInput(
    runId: string,
    line: string,
  ): Promise<{ delivered: boolean; runId?: string; reason?: string }> {
    return this.req("POST", `/runs/${runId}/input`, { line });
  }
  cancelRun(runId: string): Promise<{ ok?: boolean; cancelled?: boolean }> {
    return this.req("POST", `/runs/${runId}/cancel`);
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
  info(): Promise<{ version: string }> {
    return this.req("GET", "/info");
  }
  defaults(): Promise<{ home: string; cwd: string; dataDir: string }> {
    return this.req("GET", "/defaults");
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
  taskType?: string;
  /** Match the app's "Run task", which creates the task in "ready" before
   *  starting (vs "backlog" when queued). */
  column?: string;
  references?: TaskReference[];
  baseRef?: string;
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
  taskType?: string;
}

/** Body for POST /harnesses (kind must be claude-code; codex is "coming soon"). */
export interface CreateHarnessInput {
  id: string;
  kind: AgentKind;
  label: string;
  home?: string | null;
  bin?: string | null;
  env?: Record<string, string>;
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
