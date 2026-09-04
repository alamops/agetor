import type {
  AgentKind,
  AgentStatus,
  AppEvent,
  BranchInfo,
  BranchNamingConfig,
  ColumnId,
  GlobalEvent,
  GitHubIssueThreadResult,
  GitHubItemKind,
  GitHubItemState,
  GitHubCheckRun,
  GitHubComment,
  GitHubCommentsResult,
  GitHubChecksResult,
  GitHubCommitStatus,
  GitHubCommitStatusResult,
  GitHubAssigneesResult,
  GitProvider,
  GitHubDiscussion,
  GitHubDiscussionCategory,
  GitHubDiscussionComment,
  GitHubDiscussionDetail,
  GitHubDiscussionsResult,
  GitHubLabelsResult,
  GitHubRepoLabel,
  GitHubMilestonesResult,
  GitHubRepoMilestone,
  GitHubLinkedIssue,
  GitHubLinkedIssuesResult,
  GitHubListItem,
  GitHubListResult,
  GitHubNotification,
  GitHubNotificationsResult,
  GitHubPullCommit,
  GitHubPullCommitsResult,
  GitHubPullDefaultsResult,
  GitHubPullLineComment,
  GitHubPullMergeability,
  GitHubPullMergeMethod,
  GitHubPullReviewCommentsResult,
  GitHubPullReviewThreadsResult,
  GitHubPullMergeResult,
  GitHubPullReviewEvent,
  GitHubProjectField,
  GitHubProjectItem,
  GitHubProjectItemsResult,
  GitHubProjectV2,
  GitHubProjectsV2Result,
  GitHubReactionContent,
  GitHubReactionsResult,
  GitHubReactionSubject,
  GitHubReactionSummary,
  GitHubRelease,
  GitHubReleasesResult,
  GitHubRepoPermissions,
  GitHubSubIssue,
  GitHubSubIssuesResult,
  GitHubTag,
  GitHubTagsResult,
  GitHubWorkflow,
  GitHubWorkflowRun,
  GitHubWorkflowRunsResult,
  GitHubWorkflowsResult,
  Harness,
  HarnessQuota,
  HarnessStatus,
  HarnessUsage,
  Isolation,
  Project,
  Run,
  RunEvent,
  SavedPrompt,
  Subagent,
  Task,
  TaskDiff,
  TaskEventsReplayMeta,
  TaskGitStatus,
  TaskReference,
  TaskType,
  TerminalTab,
  UpdateStatus,
  WorktreeGitStatus,
  WorktreeInfo,
  WorktreeTeardownResult,
} from "../../shared/types.ts";
import { TASK_EVENTS_REPLAY_META_EVENT } from "../../shared/types.ts";
import { fetchWithRecovery } from "./net-retry.ts";

export interface UpdateSnapshot {
  status: UpdateStatus;
  version: string | null;
  error: string | null;
  lastCheckedAt: number | null;
}

// Re-exported from shared so existing `import { type BranchInfo } from "@/lib/api"`
// callers (BranchPicker) keep working while the single definition lives in
// src/shared/types.ts (server + webview share one wire shape).
export type { BranchInfo, BranchNamingConfig };
export type {
  GitHubCheckRun,
  GitHubChecksResult,
  GitHubComment,
  GitHubCommentsResult,
  GitHubCommitStatus,
  GitHubCommitStatusResult,
  GitHubIssueThreadResult,
  GitHubItemKind,
  GitHubItemState,
  GitProvider,
  GitHubAssigneesResult,
  GitHubDiscussion,
  GitHubDiscussionCategory,
  GitHubDiscussionComment,
  GitHubDiscussionDetail,
  GitHubDiscussionsResult,
  GitHubLabelsResult,
  GitHubRepoLabel,
  GitHubMilestonesResult,
  GitHubRepoMilestone,
  GitHubLinkedIssue,
  GitHubLinkedIssuesResult,
  GitHubListItem,
  GitHubListResult,
  GitHubNotification,
  GitHubNotificationsResult,
  GitHubPullCommit,
  GitHubPullCommitsResult,
  GitHubPullDefaultsResult,
  GitHubPullLineComment,
  GitHubPullMergeability,
  GitHubPullMergeMethod,
  GitHubPullReviewCommentsResult,
  GitHubPullReviewThreadsResult,
  GitHubPullMergeResult,
  GitHubPullReviewEvent,
  GitHubProjectField,
  GitHubProjectItem,
  GitHubProjectItemsResult,
  GitHubProjectV2,
  GitHubProjectsV2Result,
  GitHubReactionContent,
  GitHubReactionsResult,
  GitHubReactionSubject,
  GitHubReactionSummary,
  GitHubRelease,
  GitHubReleasesResult,
  GitHubRepoPermissions,
  GitHubSubIssue,
  GitHubSubIssuesResult,
  GitHubTag,
  GitHubTagsResult,
  GitHubWorkflow,
  GitHubWorkflowRun,
  GitHubWorkflowRunsResult,
  GitHubWorkflowsResult,
};
export { commitPushPrompt } from "../../shared/types.ts";

/** Where a command/extension comes from. `plugin` entries are contributed by an
 *  enabled Claude Code plugin and are namespaced `<plugin>:<name>`; `builtin`
 *  entries are baked into the harness binary (e.g. /init, /review). */
export type EntrySource = "user" | "project" | "plugin" | "builtin";

export interface AvailableCommand {
  name: string;
  description: string;
  source: EntrySource;
  kind: "command" | "skill";
}

/** An MCP server / skill / plugin surfaced by the prompt-top picker.
 *  `insert` is the token dropped into the textarea (`/name` for skills,
 *  `@name` for MCP servers and plugins). */
export interface AvailableExtension {
  name: string;
  insert: string;
  description: string;
  source: EntrySource;
  kind: "mcp" | "skill" | "plugin";
}

/** Per-kind model id list from the CLI's own catalog discovery — kept fresh
 *  by the boot sweep, the periodic 15-minute re-probe, harness-status
 *  transitions, and a manual refresh (`refreshAgentModels`), not just at
 *  boot. For fx (account-scoped catalogs), this kind-level map reflects the
 *  built-in harness only — see `HarnessModelMap` for the per-harness list a
 *  multi-account setup needs. */
export interface AgentModelMap {
  "claude-code": { id: string; label?: string; efforts?: string[] }[];
  "codex": { id: string; label?: string; efforts?: string[] }[];
  "cursor": { id: string; label?: string; efforts?: string[] }[];
  "gemini": { id: string; label?: string; efforts?: string[] }[];
  "fx": { id: string; label?: string; efforts?: string[] }[];
}

/** Per-harness model id list from `GET /agent-models/harnesses` — one entry
 *  per *enabled* harness (every kind, not just fx; non-fx harnesses carry
 *  their kind's list so callers have a single lookup keyed by harness id,
 *  which is what `task.agent` / the New Task form's `agent` state hold).
 *  `ready` is false until the boot discovery sweep has resolved at least
 *  once — before that, `byHarness` may be incomplete or empty. `efforts`
 *  carries the CLI-discovered per-model reasoning-effort ids (codex only
 *  today; see `discoveredEffortsFor` in `src/shared/model-options.ts`). */
export interface HarnessModelMap {
  ready: boolean;
  byHarness: Record<string, { id: string; label?: string; efforts?: string[] }[]>;
}

/** Pending multi-question card from claude's built-in AskUserQuestion tool
 *  (scraper-sourced). */
export interface PendingAskQuestions {
  kind: "ask_questions";
  id: string;
  taskId: string;
  runId: string;
  questions: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string; preview?: string }>;
  }>;
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
  /** True when the scraper couldn't parse this modal into choices (footer-
   *  gated fallback or stuck-turn watchdog) — `choices` is always `[]` in
   *  that case. The RunPanel renders an "Open in Terminal" fallback card
   *  instead of choice buttons. */
  unparsable?: boolean;
}

/** The ACP tool call an fx permission request is asking about — mirrors
 *  `FxPermissionToolCall` on the server (`src/bun/interactions.ts`). Only
 *  `toolCallId` is guaranteed; `title`/`kind`/`rawInput` are rendered
 *  generically when absent. */
export interface FxPermissionToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
}

/** One selectable option fx offered. `kind` is a hint from ACP's
 *  `PermissionOptionKind` (`allow_once` | `allow_always` | `reject_once` |
 *  `reject_always`) but kept as a plain optional string since fx documents
 *  additional session-scoped kinds beyond those four — the card renders
 *  fx's own `name` verbatim rather than hardcoding a fixed set. */
export interface FxPermissionOption {
  optionId: string;
  name: string;
  kind?: string;
}

/** Pending fx ACP `session/request_permission` call (real in-process
 *  awaiter — unlike the two scraper-sourced kinds above, resolving this
 *  directly unblocks fx's turn; there is no pane and no keystroke leg).
 *  Mirrors `FxPermissionRequest` on the server. */
export interface PendingFxPermission {
  kind: "fx_permission";
  id: string;
  taskId: string;
  runId: string;
  createdAt: number;
  toolCall: FxPermissionToolCall;
  options: FxPermissionOption[];
  /** The agetor mode (`auto` | `ask`) that caused this request to surface
   *  as a card — `yolo` auto-allows and never reaches here. */
  mode: "auto" | "ask";
}

export type PendingInteraction =
  | PendingAskQuestions
  | PendingTmuxPrompt
  | PendingFxPermission;

/** One stored per-host git credential, as surfaced to the webview. The store
 *  is shared across GitHub/GitLab/Bitbucket — `host` may be a plain provider
 *  domain (github.com, gitlab.com, bitbucket.org) or a raw ssh alias host
 *  (e.g. github-work.com, bitbucket-work.com). The raw credential is never
 *  returned — `tokenPreview` is a redacted tail (e.g. "…abcd"). Routes keep
 *  the `/github/tokens` path and the `GitHub` type-name prefix for
 *  backwards compatibility with existing stored tokens; the type name is
 *  legacy naming only, not a GitHub-only shape. */
export interface GitHubTokenInfo {
  host: string;
  label: string | null;
  tokenPreview: string;
}

/** Response shape for the (misleadingly-named, back-compat) `/github/tokens`
 *  routes, which actually serve credentials for any supported git host —
 *  GitHub, GitLab, and Bitbucket. `detectedHosts` are the distinct raw
 *  remote hosts (including ssh aliases, across all three providers) seen
 *  across registered project dirs — used to suggest hosts that don't have a
 *  token yet. */
export interface GitHubTokensResult {
  tokens: GitHubTokenInfo[];
  detectedHosts: string[];
}

// Read api port + token, preferring globals injected by the Bun side via
// BrowserWindow's `preload` option — that path works under the native
// views:// scheme, which rejects URLs carrying a fragment or query.
// Fall back to URL hash for the Vite HMR path, which loads from a plain
// http:// URL where the hash payload still works.
declare global {
  interface Window { __AGETOR?: { port: string; token: string; theme?: string; fontSize?: number | string } }
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

async function j<T>(
  path: string,
  init?: RequestInit,
  opts?: { retry?: boolean },
): Promise<T> {
  // fetchWithRecovery absorbs transient socket-layer rejections (WebKit's
  // bare "Load failed" — see net-retry.ts) via a health-gated single retry
  // before giving up; it throws a truthful error when the server really is
  // unreachable. HTTP error statuses still fall through to the !res.ok
  // handling below unchanged. `opts.retry: false` (set by a handful of
  // non-idempotent callers below) still probes health for the error
  // message but never re-issues the request.
  const res = await fetchWithRecovery({ fetchImpl: fetch, base: BASE }, path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${API_TOKEN}`,
      ...(init?.headers ?? {}),
    },
  }, opts);
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

/** One page of older task events, as returned by `GET /tasks/:id/events/page`
 *  (the "Load earlier" backward-paging cursor). Ascending order (oldest
 *  first), same shape as the SSE stream's events plus `id` — the real
 *  `run_events` row id, which the SSE stream never carries (see
 *  `TaskEventsReplayMeta`) but this paging route does, since it's exactly
 *  what the next `beforeId` needs. */
export interface TaskEventsPage {
  events: (RunEvent & { id: number })[];
  earliestId: number | null;
  hasMore: boolean;
}

/** One previously-sent message, as returned by
 *  `GET /tasks/:id/messages/history` — drives `MessageHistoryPicker`. Newest
 *  first, already coarsely deduped server-side (client still re-dedups after
 *  its own slash-command-XML/refs-block cleaning — see that component). */
export interface SentMessageItem {
  id: number;
  text: string;
  ts: number;
  taskId: string;
  taskTitle: string;
  project: string;
  agent: string;
}

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
  /** Ask the main process to raise + focus the app window. A WKWebView's own
   *  `window.focus()` can't activate the host NSApplication, so every "bring
   *  agetor to front" affordance (toast clicks, etc.) has to round-trip
   *  through here instead. Best-effort UI polish: swallows failures behind a
   *  console.warn rather than throwing into a React event handler. */
  focusWindow: (): Promise<void> =>
    j<{ ok: true }>("/window/focus", { method: "POST" })
      .then(() => undefined)
      .catch((e) => { console.warn("[agetor] focusWindow failed", e); }),
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
  /** Persisted quota/usage snapshots for every harness — seeds the topbar
   *  usage tracker on boot (`GET /usage`, distinct from `getHarnessUsage`
   *  above, which is unrelated task-count blast radius). Live updates
   *  arrive afterwards via the `harness_usage` `AppEvent` on
   *  `subscribeAppEvents`. */
  getAllUsage: () => j<HarnessQuota[]>("/usage"),
  /** Force a fresh quota fetch for one harness, bypassing the poller's
   *  cadence floor — the popover's manual Refresh button. */
  refreshHarnessUsage: (id: string) =>
    j<HarnessQuota>(`/harnesses/${encodeURIComponent(id)}/usage/refresh`, { method: "POST" }),
  openHarnessTerminal: (id: string) =>
    j<{ ok: true }>(`/harnesses/${encodeURIComponent(id)}/open-terminal`, {
      method: "POST",
    }),
  listSavedPrompts: () => j<SavedPrompt[]>("/saved-prompts"),
  createSavedPrompt: (input: { name: string; content: string }) =>
    j<SavedPrompt>("/saved-prompts", { method: "POST", body: JSON.stringify(input) }),
  updateSavedPrompt: (id: string, patch: { name?: string; content?: string }) =>
    j<SavedPrompt>(`/saved-prompts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteSavedPrompt: (id: string) =>
    j<{ ok: true }>(`/saved-prompts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listAgentModels: () => j<AgentModelMap>("/agent-models"),
  /** Per-harness model catalog (fx account-scoped, one entry per enabled
   *  harness) — see `HarnessModelMap`. */
  listHarnessModels: () => j<HarnessModelMap>("/agent-models/harnesses"),
  /** Force a fresh discovery probe. Omit `harnessId` to refresh every
   *  enabled harness; pass one to refresh just that harness (the picker's
   *  manual ↻ button). Always returns the unchanged kind-level map — refetch
   *  `listHarnessModels()` separately for the per-harness view. */
  refreshAgentModels: (harnessId?: string) =>
    j<AgentModelMap>(
      harnessId ? `/agent-models?harness=${encodeURIComponent(harnessId)}` : "/agent-models",
      { method: "POST" },
    ),
  listProjects: () => j<Project[]>("/projects"),
  pickProject: (startingFolder?: string) =>
    j<{ project: Project | null }>("/projects/pick", {
      method: "POST",
      body: JSON.stringify({ startingFolder }),
    }),
  deleteProject: (p: string) =>
    j<void>("/projects", { method: "DELETE", body: JSON.stringify({ path: p }) }),
  /** Per-project branch nomenclature. GET resolves to built-in defaults when the
   *  project has no stored config, so the form always gets a usable shape. */
  getProjectBranchConfig: (p: string) =>
    j<BranchNamingConfig>(`/projects/settings?path=${encodeURIComponent(p)}`),
  setProjectBranchConfig: (p: string, config: BranchNamingConfig) =>
    j<Project>("/projects/settings", {
      method: "PUT",
      body: JSON.stringify({ path: p, config }),
    }),
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
  /** Recover the real paths of the drag/drop that just ended, off the macOS
   *  drag pasteboard — WKWebView exposes no `file://` URLs on a drop, so this
   *  is the fallback for non-image files/folders dragged from Finder. The
   *  server stats each (directory-ness correct, nonexistent dropped). */
  dragRefs: () =>
    j<{ refs: TaskReference[] }>("/refs/drag", { method: "POST" }).then((r) => r.refs),
  listBranches: (dir: string) =>
    j<BranchInfo[]>(`/projects/branches?path=${encodeURIComponent(dir)}`),
  /** `git fetch --all --prune` on the project so newly pushed remote branches
   *  show up in the branch picker. Resolves once the fetch completes; the
   *  caller re-lists branches afterwards. */
  gitFetch: (dir: string) =>
    j<{ ok: true }>("/projects/fetch", {
      method: "POST",
      body: JSON.stringify({ path: dir }),
    }),
  /** Fast-forward a single local `branch` to its upstream (the picker's Git Pull
   *  button). The caller re-lists branches afterwards so the behind indicator
   *  refreshes. Rejects (ApiError) on divergence, missing upstream, or network
   *  failure — the git stderr rides along as the error message. */
  gitPull: (dir: string, branch: string) =>
    j<{ ok: true }>("/projects/pull", {
      method: "POST",
      body: JSON.stringify({ path: dir, branch }),
    }),
  /** Push a local `branch` to its remote and set upstream (the New PR composer's
   *  Push button) so a local-only branch can be opened as a pull request.
   *  Rejects (ApiError) on a rejected push, missing remote, or network failure —
   *  the git stderr rides along as the error message. */
  gitPush: (dir: string, branch: string) =>
    j<{ ok: true; remote?: string }>("/projects/push", {
      method: "POST",
      body: JSON.stringify({ path: dir, branch }),
    }),
  listGitHubItems: (input: {
    path: string;
    kind: GitHubItemKind;
    state: GitHubItemState;
    query?: string;
    labels?: string[];
    assignee?: string;
    createdByMe?: boolean;
    assignedToMe?: boolean;
    reviewRequested?: boolean;
    searchQuery?: string;
    page?: number;
    sort?: "created" | "updated" | "comments";
    direction?: "asc" | "desc";
  }) => {
    const q = new URLSearchParams({
      path: input.path,
      kind: input.kind,
      state: input.state,
    });
    if (input.query) q.set("q", input.query);
    if (input.labels && input.labels.length > 0) q.set("labels", input.labels.join(","));
    if (input.assignee) q.set("assignee", input.assignee);
    if (input.createdByMe) q.set("createdByMe", "1");
    if (input.assignedToMe) q.set("assignedToMe", "1");
    if (input.reviewRequested) q.set("reviewRequested", "1");
    if (input.searchQuery) q.set("searchQuery", input.searchQuery);
    if (input.page) q.set("page", String(input.page));
    if (input.sort) q.set("sort", input.sort);
    if (input.direction) q.set("direction", input.direction);
    return j<GitHubListResult>(`/github/items?${q.toString()}`);
  },
  /** Multi-repo aggregation (G8/F15) — "All repositories" in the GitHub
   *  dialog. Same filters as `listGitHubItems`, fanned out server-side across
   *  every path with a GitHub remote and merged into one list; each item
   *  carries its own repo's path as `sourcePath`. `page`/"Load more" aren't
   *  supported — the aggregate result always covers the first page per repo. */
  listGitHubItemsAcrossRepos: (input: {
    paths: string[];
    kind: GitHubItemKind;
    state: GitHubItemState;
    query?: string;
    labels?: string[];
    assignee?: string;
    createdByMe?: boolean;
    assignedToMe?: boolean;
    reviewRequested?: boolean;
    searchQuery?: string;
    sort?: "created" | "updated" | "comments";
    direction?: "asc" | "desc";
  }) =>
    j<GitHubListResult>("/github/items-aggregate", {
      method: "POST",
      body: JSON.stringify({
        paths: input.paths,
        kind: input.kind,
        state: input.state,
        q: input.query,
        labels: input.labels,
        assignee: input.assignee,
        createdByMe: input.createdByMe,
        assignedToMe: input.assignedToMe,
        reviewRequested: input.reviewRequested,
        searchQuery: input.searchQuery,
        sort: input.sort,
        direction: input.direction,
      }),
    }),
  getGitHubRepoPermissions: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<{ ok: true } & GitHubRepoPermissions>(`/github/repo-permissions?${q.toString()}`);
  },
  getGitHubPullDiff: (input: { path: string; number: number }) => {
    const q = new URLSearchParams({
      path: input.path,
      number: String(input.number),
    });
    return j<TaskDiff>(`/github/pull-diff?${q.toString()}`);
  },
  getGitHubPullDetail: (path: string, number: number) => {
    const q = new URLSearchParams({ path, number: String(number) });
    return j<{ ok: true; item: GitHubListItem }>(`/github/pull-detail?${q.toString()}`);
  },
  /** A single issue plus its full comment thread — powers every "create a
   *  task from this issue" entry point (dialog, New Task form paste-URL).
   *  `opts.includeComments: false` (the "View issue" prefill's use case, which
   *  only needs the item) appends `includeComments=false` to skip the
   *  server's comments fetch; omitted (the default `true`) sends no query
   *  param at all, matching every other optional-flag param in this file. */
  getGitHubIssueThread: (path: string, number: number, opts?: { includeComments?: boolean }) => {
    const q = new URLSearchParams({ path, number: String(number) });
    if (opts?.includeComments === false) q.set("includeComments", "false");
    return j<{ ok: true } & GitHubIssueThreadResult>(`/github/issue-thread?${q.toString()}`);
  },
  getGitHubPullChecks: (input: { path: string; number: number }) => {
    const q = new URLSearchParams({
      path: input.path,
      number: String(input.number),
    });
    return j<GitHubChecksResult>(`/github/pull-checks?${q.toString()}`);
  },
  getGitHubPullMergeability: (input: { path: string; number: number }) => {
    const q = new URLSearchParams({
      path: input.path,
      number: String(input.number),
    });
    return j<GitHubPullMergeability>(`/github/pull-mergeability?${q.toString()}`);
  },
  updateGitHubPullBranch: (input: { path: string; number: number }) =>
    j<{ ok: true; message?: string }>("/github/pull-update-branch", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  reopenGitHubPull: (input: { path: string; number: number }) =>
    j<{ ok: true; message?: string; item: GitHubListResult["items"][number] }>("/github/pull-reopen", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setGitHubPullDraft: (input: { path: string; number: number; draft: boolean }) =>
    j<{ ok: true; draft: boolean; message?: string }>("/github/pull-draft", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setGitHubPullAutoMerge: (input: { path: string; number: number; enable: boolean; mergeMethod?: GitHubPullMergeMethod }) =>
    j<{ ok: true; autoMergeEnabled: boolean; message?: string }>("/github/pull-auto-merge", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listGitHubPullCommits: (input: { path: string; number: number }) => {
    const q = new URLSearchParams({
      path: input.path,
      number: String(input.number),
    });
    return j<GitHubPullCommitsResult>(`/github/pull-commits?${q.toString()}`);
  },
  getGitHubPullLinkedIssues: (input: { path: string; number: number }) => {
    const q = new URLSearchParams({
      path: input.path,
      number: String(input.number),
    });
    return j<GitHubLinkedIssuesResult>(`/github/pull-linked-issues?${q.toString()}`);
  },
  getGitHubPullDefaults: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<GitHubPullDefaultsResult>(`/github/pull-defaults?${q.toString()}`);
  },
  // `kind` ("pulls"|"issues") lets GitLab/Bitbucket route to the right
  // notes/comments endpoint (their APIs split MR/PR comments from issue
  // comments, unlike GitHub's single endpoint) — see git-host.ts's
  // `ListCommentsInput` doc comment. Optional/additive: omitted, the server
  // defaults to "pulls" (GitHub ignores it entirely).
  listGitHubComments: (input: { path: string; number: number; kind?: GitHubItemKind }) => {
    const q = new URLSearchParams({
      path: input.path,
      number: String(input.number),
    });
    if (input.kind) q.set("kind", input.kind);
    return j<GitHubCommentsResult>(`/github/comments?${q.toString()}`);
  },
  createGitHubComment: (input: { path: string; number: number; body: string; kind?: GitHubItemKind }) =>
    // retry: false — a replay would post a duplicate PR/issue comment.
    j<{ comment: GitHubComment }>("/github/comments", {
      method: "POST",
      body: JSON.stringify(input),
    }, { retry: false }),
  getGitHubViewer: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<{ ok: true; login: string }>(`/github/viewer?${q.toString()}`);
  },
  // Provider detection (T4, docs/plans/multi-provider-git-modal.md) — call
  // before the other GitHub* helpers to learn which provider (GitHub/GitLab/
  // Bitbucket) a project's git remote resolves to.
  getProviderInfo: (path: string) => {
    const q = new URLSearchParams({ path });
    return j<{ ok: true; provider: GitProvider; owner: string; name: string; host: string; remoteHost: string }>(
      `/github/provider-info?${q.toString()}`,
    );
  },
  listGitHubLabels: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<GitHubLabelsResult>(`/github/labels?${q.toString()}`);
  },
  createGitHubLabel: (input: { path: string; name: string; color: string; description?: string }) =>
    j<{ ok: true; label: GitHubRepoLabel }>("/github/labels", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateGitHubLabel: (input: { path: string; name: string; newName?: string; color?: string; description?: string }) =>
    j<{ ok: true; label: GitHubRepoLabel }>("/github/label-update", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteGitHubLabel: (input: { path: string; name: string }) =>
    j<{ ok: true; message?: string }>("/github/label-delete", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listGitHubAssignees: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<GitHubAssigneesResult>(`/github/assignees?${q.toString()}`);
  },
  listGitHubMilestones: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<GitHubMilestonesResult>(`/github/milestones?${q.toString()}`);
  },
  createGitHubMilestone: (input: { path: string; title: string; description?: string; dueOn?: string }) =>
    j<{ ok: true; milestone: GitHubRepoMilestone }>("/github/milestones", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateGitHubMilestone: (input: {
    path: string;
    number: number;
    title?: string;
    description?: string;
    dueOn?: string | null;
    state?: "open" | "closed";
  }) =>
    j<{ ok: true; milestone: GitHubRepoMilestone }>("/github/milestone-update", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteGitHubMilestone: (input: { path: string; number: number }) =>
    j<{ ok: true; message?: string }>("/github/milestone-delete", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listGitHubReleases: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<GitHubReleasesResult>(`/github/releases?${q.toString()}`);
  },
  createGitHubRelease: (input: {
    path: string;
    tagName: string;
    name?: string;
    body?: string;
    draft?: boolean;
    prerelease?: boolean;
    targetCommitish?: string;
  }) =>
    j<{ ok: true; release: GitHubRelease }>("/github/releases", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateGitHubRelease: (input: {
    path: string;
    id: number;
    name?: string;
    body?: string;
    draft?: boolean;
    prerelease?: boolean;
    tagName?: string;
  }) =>
    j<{ ok: true; release: GitHubRelease }>("/github/release-update", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteGitHubRelease: (input: { path: string; id: number }) =>
    j<{ ok: true; message?: string }>("/github/release-delete", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listGitHubTags: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<GitHubTagsResult>(`/github/tags?${q.toString()}`);
  },
  listGitHubWorkflowRuns: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<GitHubWorkflowRunsResult>(`/github/workflow-runs?${q.toString()}`);
  },
  listGitHubWorkflows: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<GitHubWorkflowsResult>(`/github/workflows?${q.toString()}`);
  },
  rerunGitHubWorkflowRun: (input: { path: string; runId: number; failedOnly?: boolean }) =>
    j<{ ok: true; message: string }>("/github/workflow-rerun", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  cancelGitHubWorkflowRun: (input: { path: string; runId: number }) =>
    j<{ ok: true; message: string }>("/github/workflow-cancel", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  dispatchGitHubWorkflow: (input: { path: string; workflowId: number; ref: string; inputs?: Record<string, string> }) =>
    j<{ ok: true; message: string }>("/github/workflow-dispatch", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getGitHubCommitStatus: (input: { path: string; ref: string }) => {
    const q = new URLSearchParams({ path: input.path, ref: input.ref });
    return j<GitHubCommitStatusResult>(`/github/commit-status?${q.toString()}`);
  },
  updateGitHubComment: (input: { path: string; commentId: number; kind: "issue" | "review"; body: string }) =>
    j<{ ok: true; comment: GitHubComment }>("/github/comment-update", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteGitHubComment: (input: { path: string; commentId: number; kind: "issue" | "review" }) =>
    j<{ ok: true; message?: string }>("/github/comment-delete", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  createGitHubPullLineComment: (input: {
    path: string;
    number: number;
    body: string;
    filePath: string;
    line: number;
    side: "LEFT" | "RIGHT";
  }) =>
    j<{ comment: GitHubPullLineComment }>("/github/pull-line-comment", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listGitHubPullReviewComments: (input: { path: string; number: number }) => {
    const q = new URLSearchParams({
      path: input.path,
      number: String(input.number),
    });
    return j<GitHubPullReviewCommentsResult>(`/github/pull-review-comments?${q.toString()}`);
  },
  getGitHubPullReviewThreads: (input: { path: string; number: number }) => {
    const q = new URLSearchParams({
      path: input.path,
      number: String(input.number),
    });
    return j<GitHubPullReviewThreadsResult>(`/github/pull-review-threads?${q.toString()}`);
  },
  setGitHubReviewThreadResolved: (input: { path: string; threadId: string; resolved: boolean }) =>
    j<{ ok: true; resolved: boolean; message?: string }>("/github/review-thread-resolve", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  replyGitHubPullLineComment: (input: { path: string; number: number; commentId: number; body: string }) =>
    j<{ comment: GitHubPullLineComment }>("/github/pull-line-comment-reply", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  reviewGitHubPull: (input: {
    path: string;
    number: number;
    event: GitHubPullReviewEvent;
    body?: string;
    comments?: { path: string; line: number; side: "LEFT" | "RIGHT"; body: string }[];
  }) =>
    j<{ ok: true; message?: string }>("/github/pull-review", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  mergeGitHubPull: (input: {
    path: string;
    number: number;
    method: GitHubPullMergeMethod;
    title?: string;
    message?: string;
  }) =>
    j<GitHubPullMergeResult>("/github/pull-merge", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  closeGitHubPull: (input: { path: string; number: number; comment?: string }) =>
    j<{ ok: true; message?: string; item?: GitHubListResult["items"][number]; commentPosted?: boolean }>("/github/pull-close", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  createGitHubPull: (input: {
    path: string;
    title: string;
    head: string;
    base: string;
    body?: string;
    draft?: boolean;
    reviewers?: string[];
    /** When set, the server persists the created PR's URL onto this task
     *  (`tasks.pr_url`) atomically with creation — see `Task.prUrl`. */
    taskId?: string;
  }) =>
    j<{ ok: true; message?: string; item: GitHubListResult["items"][number] }>("/github/pull-create", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  createGitHubIssue: (input: {
    path: string;
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
    milestone?: number | null;
  }) =>
    j<{ ok: true; message?: string; item: GitHubListResult["items"][number] }>("/github/issue-create", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateGitHubIssue: (input: {
    path: string;
    number: number;
    kind?: GitHubItemKind;
    title?: string;
    body?: string;
    state?: "open" | "closed";
    labels?: string[];
    assignees?: string[];
    milestone?: number | null;
  }) =>
    j<{ ok: true; message?: string; item: GitHubListResult["items"][number] }>("/github/issue-update", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setGitHubIssueLock: (input: { path: string; number: number; locked: boolean; lockReason?: string }) =>
    j<{ ok: true; locked: boolean; message?: string }>("/github/issue-lock", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setGitHubIssuePinned: (input: { path: string; number: number; pinned: boolean }) =>
    j<{ ok: true; pinned: boolean; message?: string }>("/github/issue-pin", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getGitHubIssuePinned: (input: { path: string; number: number }) => {
    const q = new URLSearchParams({ path: input.path, number: String(input.number) });
    return j<{ ok: true; pinned: boolean }>(`/github/issue-pinned?${q.toString()}`);
  },
  listGitHubSubIssues: (input: { path: string; number: number }) => {
    const q = new URLSearchParams({ path: input.path, number: String(input.number) });
    return j<GitHubSubIssuesResult>(`/github/sub-issues?${q.toString()}`);
  },
  addGitHubSubIssue: (input: { path: string; number: number; childNumber: number }) =>
    j<{ ok: true; subIssue: GitHubSubIssue; message?: string }>("/github/sub-issue-add", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  removeGitHubSubIssue: (input: { path: string; number: number; childId: number }) =>
    j<{ ok: true; message?: string }>("/github/sub-issue-remove", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  transferGitHubIssue: (input: { path: string; number: number; targetRepo: string }) =>
    j<{ ok: true; url: string; message?: string }>("/github/issue-transfer", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listGitHubProjectsV2: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<GitHubProjectsV2Result>(`/github/projects?${q.toString()}`);
  },
  getGitHubProjectItems: (input: { path: string; projectId: string }) => {
    const q = new URLSearchParams({ path: input.path, projectId: input.projectId });
    return j<GitHubProjectItemsResult>(`/github/project-items?${q.toString()}`);
  },
  addGitHubProjectItem: (input: { path: string; projectId: string; contentNumber: number; contentKind: "issue" | "pr" }) =>
    j<{ ok: true; itemId: string }>("/github/project-item-add", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  removeGitHubProjectItem: (input: { path: string; projectId: string; itemId: string }) =>
    j<{ ok: true; message?: string }>("/github/project-item-remove", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setGitHubProjectItemStatus: (input: { path: string; projectId: string; itemId: string; fieldId: string; optionId: string }) =>
    j<{ ok: true; message?: string }>("/github/project-item-status", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listGitHubDiscussions: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<GitHubDiscussionsResult>(`/github/discussions?${q.toString()}`);
  },
  getGitHubDiscussion: (input: { path: string; number: number }) => {
    const q = new URLSearchParams({ path: input.path, number: String(input.number) });
    return j<{ ok: true; detail: GitHubDiscussionDetail }>(`/github/discussion?${q.toString()}`);
  },
  createGitHubDiscussion: (input: { path: string; categoryId: string; title: string; body: string }) =>
    j<{ ok: true; number: number; url: string }>("/github/discussion-create", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  addGitHubDiscussionComment: (input: { path: string; discussionId: string; body: string }) =>
    j<{ ok: true; commentId: string }>("/github/discussion-comment", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setGitHubDiscussionAnswer: (input: { path: string; commentId: string; answer: boolean }) =>
    j<{ ok: true; isAnswer: boolean }>("/github/discussion-answer", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteGitHubDiscussion: (input: { path: string; discussionId: string }) =>
    j<{ ok: true; message?: string }>("/github/discussion-delete", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteGitHubDiscussionComment: (input: { path: string; commentId: string }) =>
    j<{ ok: true; message?: string }>("/github/discussion-comment-delete", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  requestGitHubPullReviewers: (input: { path: string; number: number; reviewers: string[]; teamReviewers?: string[] }) =>
    j<{ ok: true; message?: string }>("/github/pull-reviewers", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  applyGitHubSuggestion: (input: { path: string; number: number; commentId: number }) =>
    j<{ ok: true; message: string }>("/github/pull-apply-suggestion", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listGitHubReactions: (input: { path: string; subject: GitHubReactionSubject; viewer?: string }) => {
    const q = new URLSearchParams({
      path: input.path,
      subjectType: input.subject.type,
      subjectId: String(input.subject.id),
    });
    if (input.viewer) q.set("viewer", input.viewer);
    return j<GitHubReactionsResult>(`/github/reactions?${q.toString()}`);
  },
  addGitHubReaction: (input: { path: string; subject: GitHubReactionSubject; content: GitHubReactionContent }) =>
    j<{ ok: true; reactionId: number; content: GitHubReactionContent }>("/github/reaction-add", {
      method: "POST",
      body: JSON.stringify({
        path: input.path,
        subjectType: input.subject.type,
        subjectId: input.subject.id,
        content: input.content,
      }),
    }),
  removeGitHubReaction: (input: { path: string; subject: GitHubReactionSubject; reactionId: number }) =>
    j<{ ok: true }>("/github/reaction-remove", {
      method: "POST",
      body: JSON.stringify({
        path: input.path,
        subjectType: input.subject.type,
        subjectId: input.subject.id,
        reactionId: input.reactionId,
      }),
    }),
  listGitHubNotifications: (input: { path: string; all?: boolean }) => {
    const q = new URLSearchParams({ path: input.path, all: input.all ? "true" : "false" });
    return j<GitHubNotificationsResult>(`/github/notifications?${q.toString()}`);
  },
  markGitHubNotificationRead: (input: { path: string; threadId: string }) =>
    j<{ ok: true }>("/github/notification-read", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  markAllGitHubNotificationsRead: (input: { path: string }) =>
    j<{ ok: true; message: string }>("/github/notifications-read-all", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getGitHubThreadSubscription: (input: { path: string; threadId: string }) => {
    const q = new URLSearchParams({ path: input.path, threadId: input.threadId });
    return j<{ ok: true; subscribed: boolean; ignored: boolean }>(`/github/thread-subscription?${q.toString()}`);
  },
  setGitHubThreadSubscription: (input: { path: string; threadId: string; ignored: boolean }) =>
    j<{ ok: true; subscribed: boolean; ignored: boolean }>("/github/thread-subscription", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  unsubscribeGitHubThread: (input: { path: string; threadId: string }) =>
    j<{ ok: true }>("/github/thread-unsubscribe", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /** Stored per-host git credentials (GitHub, GitLab, and Bitbucket all
   *  share this store) + hosts detected across registered projects — drives
   *  the "Git host tokens" Settings section. Route path kept as
   *  `/github/tokens` for back-compat with existing stored credentials. */
  listGitHubTokens: () => j<GitHubTokensResult>("/github/tokens"),
  /** Upsert the credential for `input.host`. Returns the refreshed list —
   *  never the raw token. */
  setGitHubToken: (input: { host: string; token: string; label?: string | null }) =>
    j<GitHubTokensResult>("/github/tokens", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  deleteGitHubToken: (host: string) =>
    j<{ ok: true }>(`/github/tokens/${encodeURIComponent(host)}`, { method: "DELETE" }),
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
  /** File/directory listing for the `@` file-reference popover and
   *  highlighter — `GET /files/index`. Two modes, chosen by whether `ref` is
   *  given: with a `ref`, the server resolves tracked files at that ref via
   *  `git ls-tree` (the shape a not-yet-created worktree will have once it's
   *  materialized); without one, it resolves the live working tree via
   *  `git ls-files` (tracked + untracked, minus ignored/deleted). `ref` is
   *  omitted from the request entirely when blank/null so the server always
   *  sees "no ref" rather than an empty-string one. `truncated` is true when
   *  the listing hit the server's file-count cap.
   *
   *  `q` switches to server-side search mode (monorepo fallback past the 20k
   *  display cap): when set — the empty string counts, `null`/`undefined`
   *  omit the param entirely — the server ranks files + derived directories
   *  over the ENTIRE listing with the shared `filterFileEntries` scorer and
   *  returns up to `limit` (server default 50) matches; `truncated` then
   *  reports the internal 250k scan cap instead of the 20k display cap. See
   *  `searchProjectFiles` (`use-project-files.ts`), the `@` popover's
   *  consumer of this mode. */
  listProjectFiles: (scope: { dir: string; ref?: string | null; q?: string | null; limit?: number }) => {
    const params = new URLSearchParams({ dir: scope.dir });
    if (scope.ref) params.set("ref", scope.ref);
    if (scope.q != null) params.set("q", scope.q);
    if (scope.limit != null) params.set("limit", String(scope.limit));
    return j<{ files: string[]; truncated: boolean }>(`/files/index?${params.toString()}`);
  },
  listTasks: () => j<Task[]>("/tasks"),
  /** Single task by id, fresh from the server (bypasses the 2s board poll's
   *  staleness). Used to re-check a task's persisted draft right after the
   *  panel seeds from a possibly-stale polled object — see RunPanel's
   *  pristine-adopt seeding. 404s (task deleted) surface as ApiError. */
  getTask: (id: string) => j<Task>(`/tasks/${id}`),
  createTask: (input: {
    title: string;
    prompt: string;
    /** Harness id — see `listHarnesses()`. Built-in ids are `claude-code` / `codex`. */
    agent: string;
    workdir: string;
    isolation: Isolation;
    baseRef?: string;
    /** Explicit branch name for worktree isolation. Overrides the project's
     *  nomenclature; the server validates it and makes it unique. */
    branch?: string;
    /** Check the worktree out on this pre-existing branch (e.g. a PR's head
     *  branch) instead of minting a fresh one. Requires worktree isolation. */
    existingBranch?: string;
    mode?: string | null;
    model?: string | null;
    effort?: string | null;
    fast?: boolean;
    maxMode?: boolean;
    /** Initial column. Defaults to "backlog" if omitted. */
    column?: ColumnId;
    references?: TaskReference[];
    taskType?: TaskType;
    /** URL of the issue this task is created from — validated and same-repo
     *  checked server-side (`createTask`); powers "View issue" and the
     *  PR-body `Closes #N` prefill. */
    issueUrl?: string;
    /** Full markdown snapshot of the issue + its comment thread, written to
     *  a per-task file and attached as a reference. Only meaningful
     *  alongside `issueUrl`. */
    issueSnapshot?: string;
  }) =>
    // retry: false — a replay would create a duplicate task + branch.
    j<Task>("/tasks", { method: "POST", body: JSON.stringify(input) }, { retry: false }),
  updateTask: (id: string, patch: Partial<Task>) =>
    j<Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  moveTask: (id: string, column: ColumnId) =>
    j<Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ column }) }),
  deleteTask: (id: string) => j<void>(`/tasks/${id}`, { method: "DELETE" }),
  startTask: (id: string) => j<{ runId: string }>(`/tasks/${id}/start`, { method: "POST" }),
  /** `force: true` bypasses the done-column gate (still rejects an active
   *  run) — used by the Worktrees page's "Archive & delete" flow to archive
   *  a stale worktree's task regardless of its current column. `stopRun:
   *  true` additionally stops any in-flight run/background agents before
   *  archiving — required (server-enforced) to archive a running/blocked
   *  task at all; the caller is expected to confirm with the user first.
   *  `forceWorktree: true` discards uncommitted changes in the worktree's
   *  checkout during teardown (never the branch, commits, or run/AI
   *  history) — also part of the Worktrees page's "Archive & delete", after
   *  the caller has warned the user. `awaitTeardown: true` makes the
   *  request block until the worktree removal has actually finished (no
   *  timeout is set server-side), and the response then carries a
   *  `teardown` outcome describing whether the directory is really gone —
   *  omit it and the archive returns immediately with teardown deferred to
   *  a background queue, as before. Omitting all four flags sends no body,
   *  matching the original archive-from-`done` callers unchanged.
   *
   *  `retry: false` only when `awaitTeardown` is set — matching
   *  `createTask`/`sendRunInput`'s idiom above. The route sets an unbounded
   *  server timeout and blocks on the *entire* per-workdir teardown FIFO
   *  (every same-repo teardown queued ahead of this one), which can run well
   *  past WKWebView's own request timeout even though the operation is
   *  succeeding server-side. A default retry on that timeout would silently
   *  re-issue a second, non-idempotent archive against a task the user may
   *  have already resumed (re-running `dropSession`/`killTerminalsForTask`,
   *  re-queuing a second worktree teardown behind the first). The
   *  fire-and-forget archive (no `awaitTeardown`, e.g. the kanban button)
   *  returns fast and keeps the default retry — it isn't the non-idempotent
   *  hazard this guards against. */
  archiveTask: (
    id: string,
    opts?: { force?: boolean; stopRun?: boolean; forceWorktree?: boolean; awaitTeardown?: boolean },
  ) =>
    j<Task & { teardown?: WorktreeTeardownResult }>(`/tasks/${id}/archive`, {
      method: "POST",
      ...(opts?.force || opts?.stopRun || opts?.forceWorktree || opts?.awaitTeardown
        ? {
            body: JSON.stringify({
              force: !!opts.force,
              stopRun: !!opts.stopRun,
              forceWorktree: !!opts.forceWorktree,
              awaitTeardown: !!opts.awaitTeardown,
            }),
          }
        : {}),
    }, opts?.awaitTeardown ? { retry: false } : undefined),
  unarchiveTask: (id: string) => j<Task>(`/tasks/${id}/unarchive`, { method: "POST" }),

  /** Every git worktree materialized on disk under `dataDir/worktrees/`,
   *  cross-referenced against the tasks table. Drives the Worktrees page. */
  listWorktrees: () => j<WorktreeInfo[]>("/worktrees"),
  /** Removes an orphaned worktree directory (no owning task row) — a
   *  task-backed worktree is torn down via `archiveTask(id, { force: true })`
   *  instead, since deleting it destroys the ticket. */
  deleteWorktree: (id: string) => j<void>(`/worktrees/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** On-demand live dirty/ahead/merged status for a single worktree — not part
   *  of the bulk listing above (that stays fs+DB-only to avoid a subprocess
   *  fan-out per poll). Fetched per row by the Worktrees page. */
  getWorktreeGitStatus: (id: string) =>
    j<WorktreeGitStatus>(`/worktrees/${encodeURIComponent(id)}/git-status`),

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
  /** Backward page of a task's persisted events, older than `beforeId`
   *  (exclusive) — drives the run panel's "Load earlier" affordance once the
   *  bounded SSE replay window (`EVENTS_REPLAY_LIMIT`) has been exhausted.
   *  `beforeId` is required by the route; `limit` defaults server-side to
   *  `EVENTS_REPLAY_LIMIT` when omitted. */
  fetchTaskEventsPage: (taskId: string, beforeId: number, limit?: number) => {
    const q = new URLSearchParams({ beforeId: String(beforeId) });
    if (limit) q.set("limit", String(limit));
    return j<TaskEventsPage>(`/tasks/${taskId}/events/page?${q.toString()}`);
  },
  /** Past sent messages across every task and harness, newest first — backs
   *  `MessageHistoryPicker`'s "insert a past message" dropdown. `taskId` only
   *  selects which task's endpoint is called (and gates 404-on-unknown-task);
   *  it does not scope the returned payload. */
  fetchMessageHistory: (taskId: string, limit?: number) => {
    const q = limit ? `?${new URLSearchParams({ limit: String(limit) }).toString()}` : "";
    return j<{ messages: SentMessageItem[] }>(`/tasks/${taskId}/messages/history${q}`);
  },
  /** Background/sub agents tracked for a task — drives the run panel's
   *  read-only per-subagent tab strip. Polled like `listRuns`; live deltas
   *  also arrive on the task SSE as `stream: "subagent"` events. */
  listSubagents: (taskId: string) => j<Subagent[]>(`/tasks/${taskId}/subagents`),
  /** Everything the task's worktree changed vs its pinned base. Empty `files`
   *  + a `note` when there's no worktree or no diff. */
  getTaskDiff: (taskId: string) => j<TaskDiff>(`/tasks/${taskId}/diff`),
  getTaskGitStatus: (taskId: string) =>
    j<TaskGitStatus>(`/tasks/${taskId}/git-status`),
  cancelRun: (runId: string) =>
    j<{ cancelled: boolean }>(`/runs/${runId}/cancel`, { method: "POST" }),
  // Mirrors the orchestrator's `SendInputResult` (src/bun/orchestrator.ts) —
  // keep the two in sync. `withheld`/`savedToBacklog` are only ever present
  // alongside `delivered: false`: they distinguish "claude is showing a
  // modal, so the message was withheld and re-stashed into the backlog tray"
  // from an ordinary delivery failure (run/task not found, worktree restore
  // failure, …), which carries neither flag.
  sendRunInput: (runId: string, line: string) =>
    // retry: false — a replay would paste a duplicate message into a live
    // agent tmux session.
    j<
      // `unresolvedRefs` = raw `@` tokens the server-side expansion left
      // verbatim. The webview deliberately doesn't render it post-send —
      // PromptComposer's inline warning covers it pre-send.
      | { delivered: true; runId: string; unresolvedRefs?: string[] }
      | { delivered: false; reason: string; withheld?: boolean; savedToBacklog?: boolean }
    >(
      `/runs/${runId}/input`,
      { method: "POST", body: JSON.stringify({ line }) },
      { retry: false },
    ),
  /** Bumps the task's read watermark to its latest assistant event, clearing
   *  `task.unread`. Called on opening/switching/closing the run panel — see
   *  App.tsx's `selected`-tracking effect. Returns the full updated Task so
   *  the caller can reconcile it into board state immediately (optimistic —
   *  don't wait for the next poll). Idempotent; safe to fire-and-forget. */
  markTaskSeen: (taskId: string) =>
    j<Task>(`/tasks/${taskId}/seen`, { method: "POST" }),
  /** Re-flags a task's read watermark as unread — the board's task context
   *  menu's "Mark as unread" entry, restoring `task.unread`'s "New messages"
   *  dot. No-op (server-side) when the task has no assistant messages yet
   *  (`task.hasAssistantMessages` is the client-side gate for showing the
   *  menu entry at all). Returns the full updated Task so the caller can
   *  merge only the `unread` field back into board state, same as
   *  `markTaskSeen`. */
  markTaskUnread: (taskId: string) =>
    j<Task>(`/tasks/${taskId}/seen`, { method: "DELETE" }),

  // Messages backlog — saved, not-yet-sent draft messages parked on a task.
  // Every mutation returns the full updated Task so the caller can re-sync.
  addBacklogItem: (taskId: string, input: { text: string; references?: TaskReference[] }) =>
    j<Task>(`/tasks/${taskId}/backlog`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateBacklogItem: (
    taskId: string,
    itemId: string,
    patch: { text?: string; references?: TaskReference[] },
  ) =>
    j<Task>(`/tasks/${taskId}/backlog/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteBacklogItem: (taskId: string, itemId: string) =>
    j<Task>(`/tasks/${taskId}/backlog/${itemId}`, { method: "DELETE" }),
  /** Replace the backlog order with `order` (item ids, desired sequence). */
  reorderBacklog: (taskId: string, order: string[]) =>
    j<Task>(`/tasks/${taskId}/backlog`, {
      method: "PUT",
      body: JSON.stringify({ order }),
    }),

  // Cursor plans — detected `createPlanToolCall` records on `task.plans`.
  // Every mutation returns the full updated Task so the caller can re-sync.
  /** Persist (or clear, with `null`) unapproved edits to a pending plan.
   *  Rejected (400) once the plan is no longer `pending`. */
  savePlanEdit: (taskId: string, planId: string, editedContent: string | null) =>
    j<Task>(`/tasks/${encodeURIComponent(taskId)}/plans/${encodeURIComponent(planId)}`, {
      method: "PATCH",
      body: JSON.stringify({ editedContent }),
    }),
  /** Approve a pending plan: the server writes the effective content
   *  (edited ?? original) to a `.plan.md` file in the task's worktree and
   *  auto-sends an approval message that resumes the agent.
   *  `retry: false` — like `sendRunInput`, a replay would re-send a
   *  duplicate approval message to a live agent session. */
  approvePlan: (taskId: string, planId: string) =>
    j<Task>(`/tasks/${encodeURIComponent(taskId)}/plans/${encodeURIComponent(planId)}/approve`, {
      method: "POST",
    }, { retry: false }),

  // Composer draft — the single unsent text+refs autosaved from the task
  // details modal. Every mutation returns the full updated Task.
  setTaskDraft: (taskId: string, draft: { text: string; references: TaskReference[] }) =>
    j<Task>(`/tasks/${taskId}/draft`, {
      method: "PUT",
      body: JSON.stringify(draft),
    }),
  clearTaskDraft: (taskId: string) =>
    j<Task>(`/tasks/${taskId}/draft`, { method: "DELETE" }),
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

  /** Absolute URL for an inline `<img>` thumbnail of a referenced image path.
   *  `<img>` can't set an Authorization header any more than EventSource can,
   *  so the token rides along as a query param exactly like
   *  `subscribeRun`/`subscribeTask`'s `?token=`. `GET /files/preview`
   *  responds 401 with a missing/bad token, 400 for a non-absolute or
   *  non-image path, 404 when the path doesn't exist (or isn't a regular
   *  file), and 200 with the raw image bytes otherwise; callers handle the
   *  error cases via the `<img>` element's own `onError`. */
  filePreviewUrl: (path: string): string =>
    `${BASE}/files/preview?path=${encodeURIComponent(path)}&token=${encodeURIComponent(API_TOKEN)}`,

  /** Absolute URL for a task's worktree-diff binary blob (old or new side of
   *  a binary file), for `<img src>` use in `BinaryFilePreview`. Same
   *  `?token=` pattern as `filePreviewUrl` — `<img>` can't set an
   *  `Authorization` header. Backed by `GET /tasks/:id/diff/blob`, which
   *  resolves `side: "old"` via `git show <baseRef>:<path>` and `side:
   *  "new"` from the on-disk file in the task's cwd (worktree or workdir),
   *  mirroring what `getTaskDiff`'s underlying `git diff` compared. */
  taskDiffBlobUrl: (taskId: string, path: string, side: "old" | "new"): string =>
    `${BASE}/tasks/${taskId}/diff/blob?path=${encodeURIComponent(path)}&side=${side}&token=${encodeURIComponent(API_TOKEN)}`,

  /** Absolute URL for a GitHub PR's binary blob (old or new side), for
   *  `<img src>` use in `BinaryFilePreview`. Identifying params mirror
   *  `getGitHubPullDiff` (`path`, `number`) exactly, plus the blob-specific
   *  `filePath` (repo-relative file path — carried as a distinct param name
   *  from `path`, which is the local repo dir used to resolve the GitHub
   *  remote) and `side`. Backed by `GET /github/pull-blob`: the old side
   *  anchors at the PR's merge base (the `.diff` shown is a three-dot
   *  diff), the new side at the PR head sha. */
  pullBlobUrl: (opts: { path: string; number: number; filePath: string; side: "old" | "new" }): string => {
    const q = new URLSearchParams({
      path: opts.path,
      number: String(opts.number),
      filePath: opts.filePath,
      side: opts.side,
      token: API_TOKEN,
    });
    return `${BASE}/github/pull-blob?${q.toString()}`;
  },

  /** Fetch binary blob bytes via an `Authorization: Bearer` header — used
   *  for PDF panes, which go through `fetch`/pdf.js rather than an `<img>`
   *  tag. This function always authenticates via the header, same as every
   *  other `api.*` call; it doesn't rely on (or care about) a `?token=` in
   *  `url` even though `url` is typically one of `taskDiffBlobUrl`'s /
   *  `pullBlobUrl`'s outputs, which DO append one — those builders are
   *  shared with `<img src>` consumers, which can't set headers at all, so
   *  their URLs carry a token unconditionally. Throws an `Error` whose
   *  message distinguishes a missing blob ("missing", 404) from one over
   *  the server's size cap ("too-large", 413) from any other failure, so
   *  callers can render a matching empty state. */
  fetchBlobBytes: async (url: string): Promise<ArrayBuffer> => {
    const res = await fetch(url, {
      headers: { "authorization": `Bearer ${API_TOKEN}` },
    });
    if (!res.ok) {
      if (res.status === 404) throw new Error("missing");
      if (res.status === 413) throw new Error("too-large");
      throw new Error(`${res.status} ${res.statusText}`);
    }
    return res.arrayBuffer();
  },
  /** Lightweight status probe for a blob URL, used to classify an `<img>`
   *  `onError` (SF-10) without downloading the — possibly large — body the
   *  way `fetchBlobBytes` does: the response is read only for its status,
   *  then its body is cancelled unread. Same three-way classification as
   *  `fetchBlobBytes`, as a return value instead of a thrown error since
   *  this is a best-effort classification, not a load path a caller awaits
   *  before rendering. */
  probeBlobStatus: async (url: string): Promise<"missing" | "too-large" | "ok" | "error"> => {
    try {
      const res = await fetch(url, { headers: { "authorization": `Bearer ${API_TOKEN}` } });
      void res.body?.cancel();
      if (res.status === 404) return "missing";
      if (res.status === 413) return "too-large";
      return res.ok ? "ok" : "error";
    } catch {
      return "error";
    }
  },

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

  /** Byte-copy fallback for a path-less non-image file (dropped or pasted)
   *  that has no recoverable original path — the server writes the raw bytes
   *  to `dataDir/attachments/` and returns the on-disk path. Bypasses `j()`
   *  because the body is raw bytes, not JSON; same shape as
   *  `uploadScreenshot`. */
  uploadAttachment: async (blob: Blob, name: string): Promise<{ path: string; basename: string }> => {
    const res = await fetch(`${BASE}/attachments?name=${encodeURIComponent(name)}`, {
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

  /** Answer claude's AskUserQuestion (scraper-sourced). One entry per
   *  question in the original tool input, in the same order.
   *
   *  Mirrors `sendRunInput`'s shape for the custom/free-text answer path —
   *  that's the only branch capable of a withhold (dismissing the modal then
   *  delivering the answer as a follow-up turn via `sendInput`; the
   *  drive-a-numbered-modal path types keys straight into the open modal, no
   *  paste to withhold). `withheld`/`savedToBacklog`/`reason` are only ever
   *  present alongside `ok: false`, and only for that free-text path — see
   *  `/ask-questions/:id/answer` in server.ts. */
  answerAskQuestions: (id: string, body: { answers: Array<{ selected: string[]; custom?: string }> }) =>
    j<{ ok: boolean; withheld?: boolean; savedToBacklog?: boolean; reason?: string }>(
      `/ask-questions/${id}/answer`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
  /** Answer a tmux-pane-scraped REPL prompt. `key` must be one of the
   *  keys advertised on the request — the server validates against the
   *  recorded set before injecting keystrokes via `tmux send-keys`. */
  answerTmuxPrompt: (id: string, body: { key: string } | { reject: true }) =>
    j<{ ok: boolean }>(`/tmux-prompts/${id}/answer`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Answer an fx ACP permission request. `{ optionId }` must be one of the
   *  option ids the request advertised — the server validates against the
   *  recorded set before echoing it back into the ACP RPC reply.
   *  `{ cancel: true }` is the Stop/delete path. */
  answerFxPermission: (id: string, body: { optionId: string } | { cancel: true }) =>
    j<{ ok: boolean }>(`/fx-permissions/${id}/answer`, {
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
   *  claude session id (e.g. codex runs).
   *
   *  `limit`, when passed, bounds the rebuild to the most recent `limit`
   *  mapped events (ascending) and the response carries `hasMore` — so an
   *  automatic/background rebuild doesn't silently replace the panel's
   *  bounded live window with an unbounded full-history dump. Omitted
   *  (the manual "Rebuild from session JSONL" button's case), the server
   *  returns the legacy full array with no `hasMore` field. */
  rebuildRunEvents: (runId: string, limit?: number) =>
    j<{ events: RunEvent[]; hasMore?: boolean; source?: string; reason?: string }>(
      `/runs/${runId}/rebuild-events${limit ? `?limit=${limit}` : ""}`,
    ),

  /** Fire a native macOS notification via the Bun process. Fire-and-forget
   *  — the OS handles display. When `taskId` is provided, the Bun side
   *  encodes it into an `agetor://task/<id>` deep-link so clicking the
   *  notification opens straight to that task, not just app focus. */
  notifyOS: (input: {
    title: string;
    body?: string;
    subtitle?: string;
    silent?: boolean;
    taskId?: string;
  }) =>
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

  /** App-level event stream — carries `quit_request` (the main process
   *  sends it when the user hits Cmd+Q while runs are active), `open_task`
   *  (a native-notification deep-link click), `harness_usage` (a fresh
   *  usage/quota snapshot from the background poller or a force-refresh —
   *  see `getAllUsage`/`refreshHarnessUsage`), and `agent_models_changed`
   *  (the model-discovery scheduler re-probed one or more harnesses and at
   *  least one catalog changed — refetch `listAgentModels`/
   *  `listHarnessModels`). No type whitelist here: every `AppEvent` variant
   *  is forwarded to `onEvent` as-is, so a new variant needs no change in
   *  this function. Live-only (no replay). */
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
   *  sees the whole conversation as one scrollback.
   *
   *  `onReplayMeta`, when supplied, receives the named `replay_meta` frame the
   *  server sends as the FIRST frame of every (re)connect — the bounded
   *  replay window's earliest event id and whether older history exists
   *  (drives the run panel's "Load earlier" button). It's a *named* SSE
   *  event (`event: replay_meta`), invisible to `onmessage`, so registering
   *  the listener only when a caller asks for it costs nothing for callers
   *  that don't care. */
  subscribeTask(
    taskId: string,
    onEvent: (e: RunEvent) => void,
    onReplayMeta?: (meta: TaskEventsReplayMeta) => void,
  ): () => void {
    const es = new EventSource(`${BASE}/tasks/${taskId}/events?token=${encodeURIComponent(API_TOKEN)}`);
    if (onReplayMeta) {
      es.addEventListener(TASK_EVENTS_REPLAY_META_EVENT, (m: MessageEvent) => {
        try {
          onReplayMeta(JSON.parse(m.data) as TaskEventsReplayMeta);
        } catch { /* ignore malformed */ }
      });
    }
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
