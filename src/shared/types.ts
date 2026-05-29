export type ColumnId = "backlog" | "ready" | "running" | "blocked" | "review" | "done";

/**
 * The exact `HarnessStatus.reason` string the server emits when claude-code
 * is otherwise available but tmux can't be found. Shared so the UI can
 * detect tmux-missing without string-matching the user-facing copy — both
 * sides import this constant.
 */
export const TMUX_MISSING_REASON = "tmux is required to drive claude-code interactively";

export const COLUMNS: { id: ColumnId; label: string }[] = [
  { id: "backlog", label: "Backlog" },
  { id: "ready", label: "Ready" },
  { id: "running", label: "Running" },
  { id: "blocked", label: "Blocked" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

/**
 * Heuristic patterns we use to detect "the agent is waiting on the user" from
 * its stdout/stderr stream. Match is case-insensitive. Currently only run
 * against codex output — interactive claude (the new default) doesn't surface
 * permission prompts through stdout; they pop up inside the TUI, and the
 * orchestrator skips this check for claude-code.
 *
 * Kept in shared/types so both the orchestrator (detect + flip column) and
 * tests (assert on the same patterns) point at the same source of truth.
 */
export const APPROVAL_PROMPT_PATTERNS: RegExp[] = [
  /\bdo you want (?:me )?to\b/i,
  /\bproceed\?/i,
  /\bapproval (?:required|needed)\b/i,
  /\bplease confirm\b/i,
  /\bwaiting for (?:your )?approval\b/i,
  /\bwould you like (?:me )?to\b/i,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\byes\/no\b/i,
];

export function isApprovalPrompt(text: string): boolean {
  return APPROVAL_PROMPT_PATTERNS.some((re) => re.test(text));
}

export type AgentKind = "claude-code" | "codex";

/**
 * A "harness" is the user-facing name for an agent configuration. Built-in
 * harnesses (`claude-code`, `codex`) wrap each CLI directly; user-created
 * harnesses are *aliases* that wrap the same underlying `kind` with extra
 * env, an alternate `bin` path, or a per-account `home` override so the
 * CLI's login/config writes to a separate dir (multi-account support).
 *
 * `tasks.agent` (free-form TEXT) stores the harness id — for built-ins the
 * id equals the kind, so legacy rows resolve without any backfill.
 */
export interface Harness {
  /** Slug used as the row id and as the value stored on `tasks.agent`. */
  id: string;
  kind: AgentKind;
  label: string;
  isBuiltin: boolean;
  /** Optional per-harness config root.
   *  - claude-code: emitted as CLAUDE_CONFIG_DIR=<home> (treated by claude as
   *    the `.claude/` equivalent). HOME is deliberately NOT overridden — on
   *    macOS that would point claude's keychain lookup at a non-existent
   *    `<home>/Library/Keychains/login.keychain-db` and surface as
   *    "Not logged in" even with valid tokens.
   *  - codex: emitted as HOME=<home> + CODEX_HOME=<home>/.codex (codex doesn't
   *    use the macOS keychain, so re-homing it is safe).
   *  NULL means "inherit the agetor process env". */
  home: string | null;
  /** Optional binary path override. NULL falls back to the AGETOR_*_BIN
   *  env var (back-compat), then to the kind's default name on PATH. */
  bin: string | null;
  /** Arbitrary key/value env vars merged on top of the kind's defaults and
   *  the home-derived block. Power-user surface. */
  env: Record<string, string>;
  /** Soft-delete flag. Disabled harnesses are hidden from the New Task
   *  picker and the default-harness selector, but the row stays in the DB
   *  so historical `tasks.agent = <id>` references keep resolving. The
   *  orchestrator refuses to start new runs on a disabled harness;
   *  in-flight runs are unaffected. Built-ins are toggleable too — this
   *  is the one carve-out from the built-in immutability rule. */
  enabled: boolean;
}

export interface HarnessUsage {
  /** Harness id this usage report is for. */
  harnessId: string;
  /** Task ids currently in column='running' that reference this harness.
   *  Surfaced in the disable-confirmation dialog so the user knows what's
   *  in flight before they hide the harness from the picker. */
  runningTaskIds: string[];
  /** Total number of tasks (any column) referencing this harness — used
   *  to communicate the soft-delete blast radius. */
  totalTaskCount: number;
}

export interface HarnessStatus {
  /** The harness this status is for. */
  harnessId: string;
  /** Underlying CLI kind — useful for the UI to render the right icon. */
  kind: AgentKind;
  /** The binary the probe tried to invoke (post override). */
  bin: string;
  available: boolean;
  path: string | null;
  version: string | null;
  /** Short, user-facing reason when `available` is false. */
  reason: string | null;
  /** Suggested install command when missing. */
  installHint: string | null;
}

/**
 * Pre-canned configurations the Add-harness form offers as starting points.
 * Templates live in code (not the DB) — picking one only pre-fills the form;
 * the user can tweak any field before save. The `id` here is the template's
 * identifier in the picker, not the harness id that will be stored.
 */
export interface HarnessTemplate {
  id: string;
  label: string;
  description: string;
  kind: AgentKind;
  /** Suggested harness id slug. UI may tweak before save. */
  suggestedHarnessId: string;
  /** Suggested HOME override. The `~` prefix is resolved client-side
   *  against `GET /defaults`. NULL means "no HOME override". */
  home: string | null;
  bin: string | null;
  env: Record<string, string>;
}

export const HARNESS_TEMPLATES: HarnessTemplate[] = [
  // `{dataDir}` is a placeholder substituted in the Settings dialog before
  // the editor opens — resolves to ~/.agetor for the packaged .app or
  // ~/.agetor-dev under `bun run dev`, so the suggested HOME tracks whichever
  // tree agetor is actually using. The value stored on the harness row is
  // the resolved absolute path.
  {
    id: "claude-code-additional",
    label: "Additional Claude Code",
    description:
      "Another claude-code harness with its own CLAUDE_CONFIG_DIR so login, history, and config live separately from the built-in.",
    kind: "claude-code",
    suggestedHarnessId: "claude-2",
    home: "{dataDir}/harnesses/claude-2",
    bin: null,
    env: {},
  },
  {
    id: "codex-additional",
    label: "Additional Codex",
    description:
      "Another codex harness with its own CODEX_HOME so login and history are isolated from the built-in.",
    kind: "codex",
    suggestedHarnessId: "codex-2",
    home: "{dataDir}/harnesses/codex-2",
    bin: null,
    env: {},
  },
];

export type Isolation = "worktree" | "none";

export interface Task {
  id: string;
  title: string;
  prompt: string;
  column: ColumnId;
  /**
   * Harness id this task runs under. Free-form string at the schema level;
   * resolved at spawn time against the `harnesses` table. For back-compat
   * `"claude-code"` and `"codex"` are seeded as built-in harness ids, so
   * any legacy row continues to resolve.
   */
  agent: string;
  workdir: string;
  /** "worktree" runs the agent in a per-task git worktree off `workdir`. "none" runs directly in `workdir`. */
  isolation: Isolation;
  /** Branch name created for this task. Set after the worktree is first materialized. */
  branch: string | null;
  /** Absolute path to the per-task worktree. Set after the worktree is first materialized. */
  worktreePath: string | null;
  /**
   * Resolved sha that the worktree was (or will be) created from. Pinned at
   * create time so re-runs share a stable starting commit even after the
   * source repo's HEAD moves. Null when the workdir wasn't a git repo at
   * create time (no isolation possible).
   */
  baseRef: string | null;
  /**
   * Friendly mode id ("auto", "ask", "acceptEdits", "plan", …). Maps to
   * agent-specific CLI flags in `src/bun/agents.ts`. NULL means "use the
   * agent's hands-off default" (back-compat: --dangerously-skip-permissions
   * for claude-code, --full-auto for codex).
   */
  mode: string | null;
  /**
   * Friendly model id ("opus-4.8", "sonnet-4.6", "haiku-4.5", "gpt-5", …).
   * Mapped to a `--model <name>` flag in `src/bun/agents.ts`. NULL means
   * "use the agent's default model" (no flag passed).
   */
  model: string | null;
  /**
   * Reasoning effort knob ("minimal" | "low" | "medium" | "high" for codex's
   * reasoning models). NULL means "use the agent's default" (no flag passed).
   * Currently only consumed by codex (`-c model_reasoning_effort=…`);
   * claude-code stores it for symmetry but doesn't translate it yet.
   */
  effort: string | null;
  /**
   * Path-only references the user attached at task creation (files and
   * folders on the user's machine). Empty list when none. Inlined into the
   * launch prompt as text — agetor never copies or uploads these.
   */
  references: TaskReference[];
  runId: string | null;
  /**
   * True when this task has at least one run whose status is
   * `succeeded`, `running`, or `orphaned`. Used by the kanban card to
   * swap the primary "Run" button for "Open" — once a task has produced
   * useful output, the natural next action is to inspect the panel
   * rather than start over. Failed / cancelled runs don't count: those
   * are explicit "restart" cases. Server-computed in `tasks.list()` /
   * `tasks.get()` via an `EXISTS` subquery on the runs table — never
   * persisted on the row itself.
   */
  hasOpenableRun: boolean;
  /**
   * Number of pending interactions waiting on the user for this task —
   * `ask_user` MCP calls, `AskUserQuestion` / `ExitPlanMode` Claude built-ins,
   * and tool-call approval requests. Computed in `tasks.list()` / `tasks.get()`
   * via `countPendingForTask` (interactions live in memory; not persisted).
   * Drives the kanban card's "Answer →" call-to-action.
   *
   * Codex's narrative `column='blocked'` signal is reflected via `task.column`,
   * not this counter — the card combines both at render time.
   */
  pendingInteractionCount: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * A path reference attached to a task or a follow-up message. We do not copy
 * or upload the file — only the absolute path is recorded, then inlined into
 * the prompt / message as plain text so the agent can read it from disk
 * itself. Folders carry `isDirectory: true` so the prompt formatter can
 * append a trailing slash (and the UI shows a folder icon).
 */
export interface TaskReference {
  /** Absolute filesystem path. */
  path: string;
  /** True for directories — affects icon + trailing slash in prompts. */
  isDirectory: boolean;
}

export interface AgentOption {
  /** Stored on the task and passed to `buildCommand`. */
  id: string;
  /** What the UI shows. */
  label: string;
  /** One-line hint under the option in the picker. */
  hint?: string;
}

export interface AgentOptions {
  models: AgentOption[];
  modes: AgentOption[];
  efforts: AgentOption[];
}

/**
 * Per-kind default model and effort. These are the values the UI pre-selects
 * for a new task, the migration backfills onto legacy NULL rows, and the
 * orchestrator falls back to when a `createTask` request omits them. There is
 * no "let the CLI pick" placeholder anymore — every task carries an explicit
 * model.
 *
 * "Best" here means: most capable model + a sane high-effort default. Picked
 * deliberately so a run starts with strong reasoning instead of whatever the
 * CLI happens to default to.
 */
export const DEFAULT_MODEL: Record<AgentKind, string> = {
  "claude-code": "opus-4.8",
  "codex": "gpt-5.5",
};
export const DEFAULT_EFFORT: Record<AgentKind, string> = {
  "claude-code": "high",
  "codex": "high",
};

/**
 * Maps the prominent two-way "Code vs Plan" UI toggle onto a concrete mode id
 * per agent. The toggle is the primary mode picker in the UI; the full
 * per-agent mode dropdown stays accessible behind an "Advanced" disclosure so
 * niche options (acceptEdits, ask) aren't lost. Codex has no first-class plan
 * mode — we route Plan to "ask" there since it's the closest "don't auto-act"
 * posture available.
 */
/**
 * "Code vs Plan" pill posture used by NewTaskForm. Clicking Code flips the
 * mode dropdown to the agent's most-permissive "let the model act" value;
 * clicking Plan flips it to the corresponding "describe only" value.
 *
 * For claude-code, `Code` resolves to `auto` — claude's real
 * `--permission-mode auto` where the server-side AI classifier decides
 * per call. Agetor installs a narrow PreToolUse hook (AskUserQuestion +
 * ExitPlanMode only) so the classifier handles everything else without
 * being short-circuited by our hook. `bypass` is the explicit
 * "no classifier, no MCP, no clarifying-question channel" mode for
 * users who want pure `--dangerously-skip-permissions`. See
 * `installScopeForMode` in src/bun/hook-installer.ts.
 */
export const CODE_PLAN_MODE: Record<AgentKind, { code: string; plan: string }> = {
  "claude-code": { code: "auto", plan: "plan" },
  "codex": { code: "auto", plan: "ask" },
};

/**
 * Canonical effort levels exposed in the UI, ordered **highest → lowest**.
 * Not every (agent, model) combo accepts every level — see
 * `MODEL_EFFORT_SUPPORT` below.
 *
 * Mapping per agent (see `src/bun/agents.ts`):
 *   codex       → `-c model_reasoning_effort=<id>`
 *   claude-code → thinking-keyword appended to the prompt:
 *                   low → "think"        medium → "think hard"
 *                   high → "think harder" xhigh → "think very hard"
 *                   max → "ultrathink"
 *
 * `none` is kept in the canonical list for future codex-only "reasoning-off"
 * models — currently no model in our list opts into it, so it never renders.
 */
export const EFFORT_OPTIONS: AgentOption[] = [
  { id: "max", label: "Max", hint: "Absolute maximum effort. Slowest, most thorough." },
  { id: "xhigh", label: "Extra high", hint: "Extended capability for long-horizon work. Opus 4.8 / 4.7 / codex only." },
  { id: "high", label: "High", hint: "Deep reasoning. The API default where supported." },
  { id: "medium", label: "Medium", hint: "Balanced speed vs. capability." },
  { id: "low", label: "Low", hint: "Most efficient. Best for simple tasks." },
  { id: "none", label: "None", hint: "Skip reasoning entirely (reasoning-only models)." },
];

/**
 * Per-model effort support. Sourced from official docs:
 *   - Anthropic effort parameter:
 *       https://platform.claude.com/docs/en/build-with-claude/effort
 *     Opus 4.7 → low/medium/high/xhigh/max
 *     Sonnet 4.6 → low/medium/high/max
 *     Haiku 4.5 → effort parameter NOT supported
 *   - Codex `model_reasoning_effort`:
 *       https://developers.openai.com/codex/config-advanced
 *     gpt-5.5 / gpt-5 / gpt-5-codex → low/medium/high/xhigh
 *     (minimal kept out of UI)
 *
 * An empty list means "this model does not accept the effort flag at all"
 * (e.g. Haiku 4.5) — the UI collapses the dropdown and `buildCommand` emits
 * no env var / `-c` flag for that case.
 */
export const MODEL_EFFORT_SUPPORT: Record<AgentKind, Record<string, string[]>> = {
  // Per https://platform.claude.com/docs/en/build-with-claude/effort the
  // effort parameter is API-supported on Opus 4.8 / 4.7 / 4.6 / Sonnet 4.6
  // / Opus 4.5 (xhigh is Opus-only; Sonnet 4.6 has no xhigh; Haiku 4.5
  // doesn't support effort at all). The `/effort` CLI command accepts more
  // levels but the underlying API request would fail for unsupported pairs,
  // so we filter at the picker rather than letting the user fire bad runs.
  "claude-code": {
    "opus-4.8": ["max", "xhigh", "high", "medium", "low"],
    "opus-4.7": ["max", "xhigh", "high", "medium", "low"],
    "sonnet-4.6": ["max", "high", "medium", "low"],
    // Haiku 4.5 doesn't support the effort parameter — `supportedEfforts`
    // returns `[]` and the picker disables itself.
    "haiku-4.5": [],
  },
  codex: {
    "gpt-5.5": ["xhigh", "high", "medium", "low"],
    "gpt-5": ["xhigh", "high", "medium", "low"],
    "gpt-5-codex": ["xhigh", "high", "medium", "low"],
  },
};

/**
 * Effort options the picker should show for a given (agent, model). Returns
 * an empty list when the model doesn't accept the effort flag (Haiku 4.5).
 * Unknown model ids fall back to the agent's `DEFAULT_MODEL` support set so a
 * user-pasted future model still gets a sensible picker. Returned in the
 * EFFORT_OPTIONS order (highest → lowest).
 */
export function supportedEfforts(agent: AgentKind, model: string | null): AgentOption[] {
  const key = model ?? DEFAULT_MODEL[agent];
  const ids =
    MODEL_EFFORT_SUPPORT[agent][key]
    ?? MODEL_EFFORT_SUPPORT[agent][DEFAULT_MODEL[agent]]
    ?? [];
  const allowed = new Set(ids);
  return EFFORT_OPTIONS.filter((o) => allowed.has(o.id));
}

/**
 * Permission modes claude exposes per model. As of claude 2.1.143 (verified
 * by spawning `claude --model claude-sonnet-4-6 --permission-mode auto -p`
 * directly) every mode agetor surfaces is universally supported across
 * claude models, so the deny list is empty. Kept as a structure rather
 * than removed so the picker stays ready for a future model-specific
 * carve-out (historic case: `--permission-mode auto` was Opus-4.7-only on
 * earlier releases). Unknown model ids fall back to the default model's
 * deny set — better than spawning a CLI-arg error mid-run.
 */
const MODEL_MODE_DENY: Record<AgentKind, Record<string, string[]>> = {
  "claude-code": {
    "opus-4.8": [],
    "opus-4.7": [],
    "sonnet-4.6": [],
    "haiku-4.5": [],
  },
  codex: {},
};

export function supportedModes(agent: AgentKind, model: string | null): AgentOption[] {
  const key = model ?? DEFAULT_MODEL[agent];
  const deny = new Set(
    MODEL_MODE_DENY[agent][key]
    ?? MODEL_MODE_DENY[agent][DEFAULT_MODEL[agent]]
    ?? [],
  );
  return AGENT_OPTIONS[agent].modes.filter((m) => !deny.has(m.id));
}

export const AGENT_OPTIONS: Record<AgentKind, AgentOptions> = {
  "claude-code": {
    models: [
      { id: "opus-4.8", label: "Opus 4.8", hint: "Most capable; slower." },
      { id: "opus-4.7", label: "Opus 4.7", hint: "Previous flagship." },
      { id: "sonnet-4.6", label: "Sonnet 4.6", hint: "Balanced." },
      { id: "haiku-4.5", label: "Haiku 4.5", hint: "Fast and cheap." },
    ],
    modes: [
      { id: "auto", label: "Auto", hint: "Hands-off — claude's auto-mode AI classifier decides per call. Clarifying questions and plan-approval modals route to agetor's UI." },
      { id: "bypass", label: "Bypass", hint: "Hands-off and silent — no classifier, no clarifying-question channel, no plan-approval modal. Pure --dangerously-skip-permissions. Use when you fully trust the prompt." },
      { id: "acceptEdits", label: "Accept edits", hint: "Auto-accept file edits, ask for the rest." },
      { id: "plan", label: "Plan only", hint: "Plan without making changes." },
      { id: "ask", label: "Ask before changes", hint: "Standard interactive permissions." },
    ],
    // The full list lives in `EFFORT_OPTIONS`. We surface every id this agent
    // can ever produce so legacy rows (e.g. effort="xhigh" set under codex,
    // then switched to claude-code) still resolve their stored value to a
    // label rather than displaying a bare id.
    efforts: EFFORT_OPTIONS,
  },
  codex: {
    models: [
      { id: "gpt-5.5", label: "GPT-5.5", hint: "Most capable; recommended default." },
      { id: "gpt-5-codex", label: "GPT-5 Codex" },
      { id: "gpt-5", label: "GPT-5" },
    ],
    modes: [
      { id: "auto", label: "Auto (--full-auto)", hint: "Run without approval prompts." },
      { id: "ask", label: "Ask before changes", hint: "Codex's default — prompts before each action." },
    ],
    efforts: EFFORT_OPTIONS,
  },
};

export type RunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  /** Run was active when agetor last shut down; reconciled at next boot. */
  | "orphaned";

export interface Run {
  id: string;
  taskId: string;
  /** Harness id the run launched under. Same semantics as `Task.agent`. */
  agent: string;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  /**
   * Name of the tmux session that hosted this run's claude-code REPL. Same
   * value across every run for a given task under the one-session-per-task
   * model. NULL for codex runs and pre-migration legacy rows.
   */
  tmuxSession: string | null;
  /**
   * Claude Code's own per-session uuid (the basename of the JSONL file under
   * `~/.claude/projects/<encoded-cwd>/<id>.jsonl`). Captured when the tmux
   * driver discovers the JSONL after spawn. Used to drive `claude --resume`
   * when the user keeps talking to a task whose original tmux session has
   * been torn down. NULL for codex and legacy rows.
   */
  claudeSessionId: string | null;
}

/**
 * Streams the run panel listens on. Codex (and any unstructured agent)
 * uses the flat trio: stdout / stderr / status. Claude's JSONL is parsed
 * into typed events so the UI can render each one with its own component
 * (text vs. thinking vs. tool call vs. tool result).
 *
 *   stdout       — raw bytes from a non-claude agent (codex)
 *   stderr       — error bytes from any agent
 *   status       — orchestrator-side commentary (started, mode change, …)
 *   interaction  — pending approval/question card (data = JSON)
 *   assistant    — claude assistant text block (markdown)
 *   thinking     — claude extended-thinking block
 *   tool_use     — claude tool call (data = JSON { id, name, input })
 *   tool_result  — output of a tool call (data = JSON { toolUseId, content })
 */
export type RunEventStream =
  | "stdout"
  | "stderr"
  | "status"
  | "interaction"
  | "interaction_resolved"
  | "user"
  | "assistant"
  | "thinking"
  | "tool_use"
  | "tool_result";

export interface RunEvent {
  runId: string;
  taskId: string;
  stream: RunEventStream;
  data: string;
  ts: number;
}

/**
 * App-wide lifecycle events that drive toasts and any other "what just
 * happened across all tasks" UI. Streamed from `GET /events` (live-only, no
 * replay). Distinct from `RunEvent` so the toast hook doesn't have to
 * re-derive transitions from the firehose of per-run output.
 *
 *   run-status — fires once when a run reaches a terminal state.
 *   column     — fires every time a task's column changes; `prev` is the
 *                column the row held immediately before the update.
 */
export type GlobalEvent =
  | {
      kind: "run-status";
      taskId: string;
      runId: string;
      status: "succeeded" | "failed" | "cancelled" | "orphaned";
      ts: number;
    }
  | {
      kind: "column";
      taskId: string;
      runId: string | null;
      column: ColumnId;
      prev: ColumnId | null;
      ts: number;
    }
  | {
      kind: "update";
      status: UpdateStatus;
      /** Remote version string from update.json, when known. */
      version: string | null;
      /** Human-readable detail (error message, etc). */
      message: string | null;
      ts: number;
    };

/**
 * App-level events the webview subscribes to over `GET /app/events`. Used
 * for cross-cutting flows that aren't tied to a single task — currently:
 *
 *   quit_request — main process intercepted Cmd+Q / window close with N
 *                  runs still active. Webview shows a confirm modal; the
 *                  user picks Quit-anyway (POST /app/force-quit) or stays.
 */
export type AppEvent =
  | {
      type: "quit_request";
      runningRunCount: number;
      runningTaskTitles: string[];
      ts: number;
    };

/**
 * Lifecycle of the Electrobun self-updater as exposed to the UI. Mirrors the
 * subset of `Updater`'s internal state we want to surface — the underlying
 * state machine has ~25 substates (downloading-patch, decompressing, …) but
 * the user only cares about three things: am I current, is something coming,
 * is it ready to restart into. `error` and `unsupported` cover the cases
 * where we can't tell.
 *
 *   idle        — last check found no update.
 *   checking    — actively probing the update feed.
 *   downloading — update available, pulling the .app.tar.zst now.
 *   ready       — fully downloaded and staged; clicking apply restarts.
 *   error       — last check or download failed; we'll retry on the next tick.
 *   unsupported — running under `bun run dev` (channel === "dev"), so the
 *                 updater short-circuits; surfaced only for diagnostics.
 */
export type UpdateStatus =
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "error"
  | "unsupported";

export interface ToolUseEventData {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultEventData {
  toolUseId: string;
  /** Either a plain string (most tools) or a content-block array (rich
   *  tools like the built-in Task/Agent). Pass through verbatim so the
   *  renderer can inspect it. */
  content: unknown;
}

/**
 * A working directory the user has registered as a "project". Surfaced in the
 * workdir picker on the New Task form so common paths don't need to be typed
 * every time. Auto-populated on `createTask`; explicit entries come from the
 * native folder dialog (POST /projects/pick).
 */
export interface Project {
  path: string;
  name: string;
  addedAt: number;
}

/**
 * @deprecated Use {@link HarnessStatus} instead. Kept as a type alias so the
 * webview code that already imported `AgentStatus` doesn't need to rename;
 * the shape is now per-harness (multiple rows can share a `kind`).
 */
export type AgentStatus = HarnessStatus;
