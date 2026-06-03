import type {
  AgentKind,
  AgentStatus,
  AppEvent,
  ColumnId,
  GlobalEvent,
  Harness,
  HarnessStatus,
  HarnessUsage,
  Isolation,
  Project,
  Run,
  RunEvent,
  Task,
  TaskDiff,
  TaskReference,
  TaskType,
  TerminalTab,
  UpdateStatus,
} from "../../shared/types.ts";

export interface UpdateSnapshot {
  status: UpdateStatus;
  version: string | null;
  error: string | null;
  lastCheckedAt: number | null;
}

export interface BranchInfo { name: string; committedAt: number; current: boolean }

export interface AvailableCommand {
  name: string;
  description: string;
  source: "user" | "project";
  kind: "command" | "skill";
}

/** An MCP server / skill / plugin surfaced by the prompt-top picker.
 *  `insert` is the token dropped into the textarea (`/name` for skills,
 *  `@name` for MCP servers and plugins). */
export interface AvailableExtension {
  name: string;
  insert: string;
  description: string;
  source: "user" | "project";
  kind: "mcp" | "skill" | "plugin";
}

/** Per-agent model id list discovered from the CLI at boot. */
export interface AgentModelMap {
  "claude-code": { id: string; label?: string }[];
  "codex": { id: string; label?: string }[];
}

/** Pending tool-call approval (from claude's PreToolUse hook). */
export interface PendingApproval {
  kind: "approval";
  id: string;
  taskId: string;
  runId: string;
  toolName: string;
  toolInput: unknown;
  createdAt: number;
}

/** Pending clarifying question (from the ask_user MCP tool). */
export interface PendingQuestion {
  kind: "question";
  id: string;
  taskId: string;
  runId: string;
  question: string;
  choices?: string[];
  multi?: boolean;
  createdAt: number;
}

/** Pending multi-question card from claude's built-in AskUserQuestion tool
 *  (intercepted via PreToolUse hook). */
export interface PendingAskQuestions {
  kind: "ask_questions";
  id: string;
  taskId: string;
  runId: string;
  questions: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string }>;
  }>;
  createdAt: number;
}

/** Pending plan-approval card from claude's built-in ExitPlanMode tool
 *  (intercepted via PreToolUse hook). */
export interface PendingPlanApproval {
  kind: "plan_approval";
  id: string;
  taskId: string;
  runId: string;
  plan: string;
  createdAt: number;
}

/** Modal the tmux pane scraper detected — typically a plan-mode safety
 *  dialog or another REPL prompt the PreToolUse hook system never sees.
 *  Each `choices[i].key` is the literal keystroke the server will
 *  `tmux send-keys` on click. */
export interface PendingTmuxPrompt {
  kind: "tmux_prompt";
  id: string;
  taskId: string;
  runId: string;
  paneText: string;
  choices: Array<{ key: string; label: string }>;
  fingerprint: string;
  createdAt: number;
}

export type PendingInteraction =
  | PendingApproval
  | PendingQuestion
  | PendingAskQuestions
  | PendingPlanApproval
  | PendingTmuxPrompt;

// Read api port + token, preferring globals injected by the Bun side via
// BrowserWindow's `preload` option — that path works under the native
// views:// scheme, which rejects URLs carrying a fragment or query.
// Fall back to URL hash for the Vite HMR path, which loads from a plain
// http:// URL where the hash payload still works.
declare global {
  interface Window { __AGETOR?: { port: string; token: string } }
}
// Guard `window` access for the test runtime (`bun test` runs this module
// outside a browser). Production paths always have a real window, so the
// `?? undefined` fallback never trips at runtime in the app.
const _win = typeof window !== "undefined" ? window : undefined;
const injected = _win?.__AGETOR;
const params = new URLSearchParams(
  ((_win?.location.hash || _win?.location.search) ?? "").replace(/^[#?]/, ""),
);
const API_PORT = injected?.port ?? params.get("api") ?? "4317";
const API_TOKEN = injected?.token ?? params.get("token") ?? "";
const BASE = `http://127.0.0.1:${API_PORT}`;

/** Error thrown for any non-2xx API response. Carries the parsed JSON body
 *  so callers can read structured fields (e.g. the `taskIds` list returned
 *  by `DELETE /harnesses/:id` when the harness is still in use) instead of
 *  re-parsing the message string. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${API_TOKEN}`,
        ...(init?.headers ?? {}),
      },
    });
  } catch (e) {
    // WebKit's bare "Load failed" tells us nothing — replace with
    // something the user can act on.
    const msg = (e as Error).message ?? String(e);
    throw new Error(
      msg === "Load failed"
        ? `cannot reach agetor API at ${BASE} (${path}) — is the bun process running? Try restarting \`bun run dev\`.`
        : msg,
    );
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body && typeof body === "object" && "error" in body && body.error)
      ? String(body.error)
      : `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status, body);
  }
  return body as T;
}

export interface AppDefaults { home: string; cwd: string; dataDir: string }

export interface HarnessesPayload { harnesses: Harness[]; statuses: HarnessStatus[] }
export interface HarnessInput {
  id: string;
  kind: AgentKind;
  label: string;
  home: string | null;
  bin: string | null;
  env: Record<string, string>;
}

export const api = {
  defaults: () => j<AppDefaults>("/defaults"),
  info: () => j<{ version: string }>("/info"),
  /** Toggle the window's macOS "zoom" state. Wired up to double-click on
   *  the app bar in App.tsx because Electrobun's drag region doesn't
   *  implement the native title-bar double-click gesture. */
  toggleWindowZoom: () =>
    j<{ ok: boolean; skipped?: string }>("/window/toggle-zoom", { method: "POST" }),
  getUpdateStatus: () => j<UpdateSnapshot>("/updates/status"),
  checkForUpdate: () => j<UpdateSnapshot>("/updates/check", { method: "POST" }),
  applyUpdate: () => j<{ ok: true }>("/updates/apply", { method: "POST" }),
  listAgents: () => j<AgentStatus[]>("/agents"),
  listHarnesses: () => j<HarnessesPayload>("/harnesses"),
  createHarness: (input: HarnessInput) =>
    j<Harness>("/harnesses", { method: "POST", body: JSON.stringify(input) }),
  updateHarness: (id: string, patch: Partial<Omit<HarnessInput, "id" | "kind">>) =>
    j<Harness>(`/harnesses/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteHarness: (id: string) =>
    j<void>(`/harnesses/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setHarnessEnabled: (id: string, enabled: boolean) =>
    j<Harness>(`/harnesses/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),
  getHarnessUsage: (id: string) =>
    j<HarnessUsage>(`/harnesses/${encodeURIComponent(id)}/usage`),
  openHarnessTerminal: (id: string) =>
    j<{ ok: true }>(`/harnesses/${encodeURIComponent(id)}/open-terminal`, {
      method: "POST",
    }),
  listAgentModels: () => j<AgentModelMap>("/agent-models"),
  refreshAgentModels: () => j<AgentModelMap>("/agent-models", { method: "POST" }),
  listProjects: () => j<Project[]>("/projects"),
  pickProject: (startingFolder?: string) =>
    j<{ project: Project | null }>("/projects/pick", {
      method: "POST",
      body: JSON.stringify({ startingFolder }),
    }),
  deleteProject: (p: string) =>
    j<void>("/projects", { method: "DELETE", body: JSON.stringify({ path: p }) }),
  /** Open a native file/folder picker and return the chosen references.
   *  WKWebView never exposes `File.path`, so this native panel is the only
   *  reliable way to turn a user pick into an absolute path. Returns `[]` on
   *  cancel. `isDirectory` follows `mode`. */
  pickRefs: (mode: "files" | "folder", startingFolder?: string) =>
    j<{ refs: TaskReference[] }>("/refs/pick", {
      method: "POST",
      body: JSON.stringify({ mode, startingFolder }),
    }).then((r) => r.refs),
  /** Resolve absolute paths (pulled from a drag/drop's file:// URLs) into
   *  references — the server stats each for directory-ness and drops any
   *  that no longer exist. */
  resolveRefs: (paths: string[]) =>
    j<{ refs: TaskReference[] }>("/refs/resolve", {
      method: "POST",
      body: JSON.stringify({ paths }),
    }).then((r) => r.refs),
  listBranches: (dir: string) =>
    j<BranchInfo[]>(`/projects/branches?path=${encodeURIComponent(dir)}`),
  getTmuxSource: () =>
    j<{
      source: "system" | "bundled";
      bundledAvailable: boolean;
      bundledPath: string;
      resolvedBin: string;
    }>("/tmux-source"),
  setTmuxSource: (source: "system" | "bundled") =>
    j<{ ok: true; source: "system" | "bundled" }>("/tmux-source", {
      method: "POST",
      body: JSON.stringify({ source }),
    }),
  listPreferences: () => j<Record<string, string>>("/preferences"),
  setPreference: (key: string, value: string) =>
    j<void>(`/preferences/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
  listAgentCapabilities: (opts: { agent: string; workdir: string; branch?: string }) => {
    // Slash commands/skills + MCP/skill/plugin extensions in one fetch. `agent`
    // is a harness id (built-ins use id-equals-kind, so "claude-code" / "codex"
    // still works). The server resolves to the harness via getByIdOrKind and
    // reads from the harness's own home when set.
    const q = new URLSearchParams({ agent: opts.agent });
    if (opts.workdir) q.set("workdir", opts.workdir);
    if (opts.branch) q.set("branch", opts.branch);
    return j<{ commands: AvailableCommand[]; extensions: AvailableExtension[] }>(
      `/agent-discovery?${q.toString()}`,
    );
  },
  listTasks: () => j<Task[]>("/tasks"),
  createTask: (input: {
    title: string;
    prompt: string;
    /** Harness id — see `listHarnesses()`. Built-in ids are `claude-code` / `codex`. */
    agent: string;
    workdir: string;
    isolation: Isolation;
    baseRef?: string;
    mode?: string | null;
    model?: string | null;
    effort?: string | null;
    /** Initial column. Defaults to "backlog" if omitted. */
    column?: ColumnId;
    references?: TaskReference[];
    taskType?: TaskType;
  }) => j<Task>("/tasks", { method: "POST", body: JSON.stringify(input) }),
  updateTask: (id: string, patch: Partial<Task>) =>
    j<Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  moveTask: (id: string, column: ColumnId) =>
    j<Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ column }) }),
  deleteTask: (id: string) => j<void>(`/tasks/${id}`, { method: "DELETE" }),
  startTask: (id: string) => j<{ runId: string }>(`/tasks/${id}/start`, { method: "POST" }),
  archiveTask: (id: string) => j<Task>(`/tasks/${id}/archive`, { method: "POST" }),
  unarchiveTask: (id: string) => j<Task>(`/tasks/${id}/unarchive`, { method: "POST" }),

  // Terminal tabs. State is in-memory on the bun side; the live byte stream
  // runs over the WebSocket whose URL `terminalSocketUrl` builds.
  listTerminals: (taskId: string) => j<TerminalTab[]>(`/tasks/${taskId}/terminals`),
  createTerminal: (taskId: string) =>
    j<TerminalTab>(`/tasks/${taskId}/terminals`, { method: "POST" }),
  closeTerminal: (id: string) => j<void>(`/terminals/${id}`, { method: "DELETE" }),
  /** ws:// URL for a terminal's duplex stream. EventSource-style token in the
   *  query string since WebSockets can't set the Authorization header. */
  terminalSocketUrl: (id: string) =>
    `ws://127.0.0.1:${API_PORT}/terminals/${encodeURIComponent(id)}/ws?token=${encodeURIComponent(API_TOKEN)}`,
  listRuns: (taskId: string) => j<Run[]>(`/tasks/${taskId}/runs`),
  /** Everything the task's worktree changed vs its pinned base. Empty `files`
   *  + a `note` when there's no worktree or no diff. */
  getTaskDiff: (taskId: string) => j<TaskDiff>(`/tasks/${taskId}/diff`),
  getTaskGitStatus: (taskId: string) =>
    j<{ hasChanges: boolean; ignored: boolean }>(`/tasks/${taskId}/git-status`),
  cancelRun: (runId: string) =>
    j<{ cancelled: boolean }>(`/runs/${runId}/cancel`, { method: "POST" }),
  sendRunInput: (runId: string, line: string) =>
    j<{ delivered: true; runId: string } | { delivered: false; reason: string }>(
      `/runs/${runId}/input`,
      { method: "POST", body: JSON.stringify({ line }) },
    ),
  /**
   * Open a file or directory with the OS default app. `path` may be absolute
   * or, when `taskId` is supplied, relative to the task's cwd
   * (worktreePath ?? workdir).
   */
  openPath: (input: { path: string; taskId?: string }) =>
    j<{ opened: boolean; path: string }>(`/open-path`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /**
   * Open an http(s) or mailto URL in the OS default browser. The webview is
   * sandboxed; `target="_blank"` does nothing, so anchor clicks need to
   * round-trip through the Bun main process to reach `Utils.openExternal`.
   */
  openExternal: (url: string) =>
    j<{ opened: boolean; url: string }>(`/open-external`, {
      method: "POST",
      body: JSON.stringify({ url }),
    }),

  /**
   * Open the claude-code task's tmux session in a new Terminal.app window.
   * Returns the session name on success. Server-side checks the session is
   * actually live and that the task uses a claude-code harness.
   */
  openTmux: (taskId: string) =>
    j<{ ok: true; sessionName: string }>(`/tasks/${taskId}/open-tmux`, {
      method: "POST",
    }),

  /** Persist an in-memory image (clipboard paste or macOS floating-thumbnail
   *  drag) to disk and get back its absolute path. Bypasses `j()` because the
   *  body is raw bytes, not JSON. */
  uploadScreenshot: async (blob: Blob): Promise<{ path: string; basename: string }> => {
    const res = await fetch(`${BASE}/screenshots`, {
      method: "POST",
      headers: {
        "content-type": blob.type || "application/octet-stream",
        "authorization": `Bearer ${API_TOKEN}`,
      },
      body: blob,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = body && typeof body === "object" && "error" in body && body.error
        ? String((body as { error: unknown }).error)
        : `${res.status} ${res.statusText}`;
      throw new Error(msg);
    }
    return body as { path: string; basename: string };
  },

  /** Interactions: tool-call approvals and clarifying questions. */
  answerApproval: (
    id: string,
    body: {
      decision: "allow" | "deny";
      reason?: string;
      remember?: boolean;
      /** Optional permissions.allow entry from the UI's granularity chooser.
       *  Server falls back to the tool's most-specific scope if absent. */
      entry?: string;
    },
  ) =>
    j<{ ok: boolean }>(`/approvals/${id}/answer`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  answerQuestion: (id: string, body: { selected: string[]; custom?: string }) =>
    j<{ ok: boolean }>(`/questions/${id}/answer`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Answer claude's AskUserQuestion (intercepted via PreToolUse hook). One
   *  entry per question in the original tool input, in the same order. */
  answerAskQuestions: (id: string, body: { answers: Array<{ selected: string[]; custom?: string }> }) =>
    j<{ ok: boolean }>(`/ask-questions/${id}/answer`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Answer claude's ExitPlanMode (intercepted via PreToolUse hook). */
  answerPlanApproval: (
    id: string,
    body: { choice: "approve_auto" | "approve_implement" | "approve_ask" | "reject"; revision?: string },
  ) =>
    j<{ ok: boolean }>(`/plan-approvals/${id}/answer`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Answer a tmux-pane-scraped REPL prompt. `key` must be one of the
   *  keys advertised on the request — the server validates against the
   *  recorded set before injecting keystrokes via `tmux send-keys`. */
  answerTmuxPrompt: (id: string, body: { key: string }) =>
    j<{ ok: boolean }>(`/tmux-prompts/${id}/answer`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listPendingInteractions: (taskId: string) =>
    j<PendingInteraction[]>(`/tasks/${taskId}/interactions/pending`),
  /** Re-parse a run's events from claude's on-disk JSONL session
   *  transcript. Use when the persisted `run_events` rows pre-date the
   *  structured-event refactor (the legacy mapper truncated tool inputs
   *  at 500 chars, so the in-DB copy is missing the tail bytes). Returns
   *  an empty list + `reason` when the JSONL is gone or the run had no
   *  claude session id (e.g. codex runs). */
  rebuildRunEvents: (runId: string) =>
    j<{ events: RunEvent[]; source?: string; reason?: string }>(
      `/runs/${runId}/rebuild-events`,
    ),

  /** Fire a native macOS notification via the Bun process. Fire-and-forget
   *  — the OS handles display; clicking the notification just focuses the
   *  app (Electrobun's bridge doesn't expose a click callback). The
   *  matching in-app toast carries the deep-link. */
  notifyOS: (input: { title: string; body?: string; subtitle?: string; silent?: boolean }) =>
    j<{ ok: boolean }>("/notifications", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /** App-wide lifecycle event stream. Live-only (no replay) — subscribers
   *  see events from the moment they connect. Used by the toast hook in
   *  App.tsx to surface success / error / pending-input across every task
   *  without subscribing per-task. */
  subscribeGlobalEvents(onEvent: (e: GlobalEvent) => void): () => void {
    const es = new EventSource(`${BASE}/events?token=${encodeURIComponent(API_TOKEN)}`);
    es.onmessage = (m) => {
      try {
        const parsed = JSON.parse(m.data);
        if (parsed.type === "ping") return;
        onEvent(parsed as GlobalEvent);
      } catch { /* ignore */ }
    };
    // Logged so a future debug session has a breadcrumb when toasts stop
    // arriving (typically: stale token, backend restart). EventSource
    // auto-reconnects, so this is informational — no UI surfacing.
    es.onerror = (e) => { console.warn("[agetor] global events stream error", e); };
    return () => es.close();
  },

  /** App-level event stream — currently carries the quit_request signal
   *  the main process sends when the user hits Cmd+Q while runs are
   *  active. Live-only (no replay). */
  subscribeAppEvents(onEvent: (e: AppEvent) => void): () => void {
    const es = new EventSource(`${BASE}/app/events?token=${encodeURIComponent(API_TOKEN)}`);
    es.onmessage = (m) => {
      try {
        const parsed = JSON.parse(m.data);
        if (parsed.type === "ping") return;
        onEvent(parsed as AppEvent);
      } catch { /* ignore */ }
    };
    es.onerror = (e) => { console.warn("[agetor] app events stream error", e); };
    return () => es.close();
  },

  /** Tell the main process to quit despite running tasks. Used by the
   *  QuitConfirmDialog after the user picks "Quit anyway". Fire-and-forget
   *  — the response races process exit. */
  forceQuit: () => j<{ ok: boolean }>("/app/force-quit", { method: "POST" }),

  subscribeRun(runId: string, onEvent: (e: RunEvent) => void): () => void {
    // EventSource can't set headers, so the server also accepts the token via query.
    const es = new EventSource(`${BASE}/runs/${runId}/events?token=${encodeURIComponent(API_TOKEN)}`);
    es.onmessage = (m) => {
      try {
        const parsed = JSON.parse(m.data);
        if (parsed.type === "ping") return;
        onEvent(parsed as RunEvent);
      } catch { /* ignore */ }
    };
    es.onerror = (e) => { console.warn("[agetor] run events stream error", runId, e); };
    return () => es.close();
  },
  /** Unified task-level event stream: every run's events, merged in id
   *  order. Replaces per-run subscriptions for the run panel so the user
   *  sees the whole conversation as one scrollback. */
  subscribeTask(taskId: string, onEvent: (e: RunEvent) => void): () => void {
    const es = new EventSource(`${BASE}/tasks/${taskId}/events?token=${encodeURIComponent(API_TOKEN)}`);
    es.onmessage = (m) => {
      try {
        const parsed = JSON.parse(m.data);
        if (parsed.type === "ping") return;
        onEvent(parsed as RunEvent);
      } catch { /* ignore */ }
    };
    es.onerror = (e) => { console.warn("[agetor] task events stream error", taskId, e); };
    return () => es.close();
  },
};
