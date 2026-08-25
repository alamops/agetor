export type ColumnId = "backlog" | "ready" | "running" | "blocked" | "review" | "done";

/**
 * The exact `HarnessStatus.reason` string the server emits when claude-code
 * is otherwise available but tmux can't be found. Shared so the UI can
 * detect tmux-missing without string-matching the user-facing copy — both
 * sides import this constant.
 */
export const TMUX_MISSING_REASON = "tmux is required to drive claude-code interactively";

/**
 * Sentinel prefix for the `status` chunk a driver emits when it detects that a
 * *running* task's tmux session has died unexpectedly mid-turn (crash, external
 * kill, tmux server gone). The orchestrator's chunk handler pattern-matches this
 * prefix to flip the card to `blocked` and settle the run, mirroring the
 * claude API-error path. Lives here (not in a driver file) because BOTH the
 * claude and codex drivers emit it and the orchestrator consumes it. */
export const SESSION_DIED_STATUS_PREFIX = "session ended: ";

/**
 * Sentinel prefix for the `status` chunk claude-tmux emits whenever the
 * JSONL reports a permission-mode change (plan/auto/acceptEdits/…). Emitted
 * only on change (not per-line), so the run panel's mode chip can derive its
 * current value by scanning `displayedEvents` for the latest match instead
 * of a dedicated API. Follows the `SESSION_DIED_STATUS_PREFIX` sentinel-chunk
 * convention.
 */
export const PERMISSION_MODE_STATUS_PREFIX = "permission-mode: ";

/**
 * Sentinel prefix for the `status` chunk fx-acp.ts emits per ACP
 * `usage_update` notification. Payload is JSON: `{used, size, cost?:
 * {amount, currency}}` (verbatim ACP shape — `used`/`size` are token counts,
 * `cost` is present only when fx reports one). RunPanel suppresses this
 * prefix from the transcript's status dividers (same as
 * `PERMISSION_MODE_STATUS_PREFIX` — that suppression is load-bearing, not
 * dead code) and instead derives the latest value into a small usage chip on
 * the run's summary row.
 */
export const FX_USAGE_STATUS_PREFIX = "fx-usage: ";

/**
 * Sentinel prefix for the `status` chunk fx-acp.ts emits once per turn with
 * the provider fx reports in its `session/new` / resume `configOptions`
 * (`{id:"provider", currentValue:"gateway"|"codex"|"grok"}` — fx ≥0.0.5
 * multi-provider auth). Payload is the bare provider value. Suppressed from
 * transcripts via `isInternalStatusSentinel`; RunPanel derives a small
 * run-row chip from the latest one.
 */
export const FX_PROVIDER_STATUS_PREFIX = "fx-provider: ";

/**
 * True for `status`-stream chunks that are UI-internal sentinel channels, not
 * transcript content: currently `PERMISSION_MODE_STATUS_PREFIX` (fed a chip,
 * now suppressed-only), `FX_USAGE_STATUS_PREFIX` (feeds the run-row usage
 * chip), and `FX_PROVIDER_STATUS_PREFIX` (feeds the run-row provider chip).
 * Every renderer of raw status events — RunPanel's status dividers,
 * the CLI's `agetor logs` formatter, and the TUI dashboard — must consult
 * this ONE predicate instead of maintaining its own prefix list, so a new
 * sentinel can't silently leak verbatim into one surface while another
 * suppresses it.
 */
export function isInternalStatusSentinel(data: string): boolean {
  return (
    data.startsWith(PERMISSION_MODE_STATUS_PREFIX) ||
    data.startsWith(FX_USAGE_STATUS_PREFIX) ||
    data.startsWith(FX_PROVIDER_STATUS_PREFIX)
  );
}

/**
 * The Settings section name where per-host git credentials live, interpolated
 * into the server-side credential-error hints (github.ts `privateRepoHint`,
 * gitlab.ts `authHint`, bitbucket.ts `bitbucketAccessHint` and friends) as
 * `Settings → ${GIT_HOST_TOKENS_SECTION}`, and reused as the section's own
 * label (GitHubTokensSection.tsx). The webview pattern-matches that same
 * phrase to recognize a credential error and swap the bare error row for an
 * actionable explainer panel (GitHubDialog.tsx / credential-error.ts). This
 * constant keeps those three — server hints, the section label, and the
 * webview's detection — in sync; it does NOT guarantee a full rename, since
 * the setup guide (GitHubSetupDialog) still names the section in informal
 * prose that won't follow a change here. */
export const GIT_HOST_TOKENS_SECTION = "Git host tokens";

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

export type AgentKind = "claude-code" | "codex" | "cursor" | "gemini" | "fx";

/**
 * A "harness" is the user-facing name for an agent configuration. Built-in
 * harnesses (`claude-code`, `codex`, `cursor`, `gemini`) wrap each CLI directly;
 * user-created harnesses are *aliases* that wrap the same underlying `kind`
 * with extra env, an alternate `bin` path, or a per-account `home` override
 * so the CLI's login/config writes to a separate dir (multi-account support).
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
   *  - cursor: emitted as a plain HOME=<home> override — `cursor-agent` has
   *    no documented dedicated config-dir env var, so isolating an
   *    additional account's login/config means re-homing the whole process
   *    (cursor doesn't touch the macOS keychain either, so this is safe).
   *  - gemini: emitted as GEMINI_CLI_HOME=<home>. Gemini CLI has its own
   *    dedicated home-override env var (verified in its bundled source —
   *    `homedir()` returns `process.env.GEMINI_CLI_HOME || os.homedir()`,
   *    and every gemini state dir — `.gemini/`, session chats, OAuth creds —
   *    is joined onto that), so unlike codex there's no need to touch the
   *    real `HOME` at all.
   *  - fx: emitted as a plain HOME=<home> override — fx has no dedicated
   *    config-dir env var (verified against fx v0.0.4 and v0.0.6 — no FX_HOME
   *    or FX_CONFIG_DIR in its strings), and its state lives hardcoded at
   *    `~/.fx/*`, so isolating an additional account's login/config means
   *    re-homing the whole process, same approach as cursor.
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

/** A user-global reusable prompt snippet — not tied to any task or project. */
export interface SavedPrompt {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
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
  /**
   * Login state, when the kind's probe can determine it cheaply and without
   * side effects — today only fx (`fx status --json` reports `auth`). Strictly
   * fail-open: `false` ONLY when the probe positively reported "missing";
   * `true` for any other reported value; `null` when the kind has no login
   * probe, the probe failed, or its output wasn't parseable — `null` must
   * never block a run.
   */
  loggedIn: boolean | null;
  /** The CLI's own login guidance (verbatim, e.g. fx's `auth_help`) when
   *  `loggedIn === false`; otherwise null. */
  authHelp: string | null;
}

/**
 * Where a `HarnessQuota` snapshot's data came from:
 *  - "api"    — fetched live from the provider's (undocumented) usage endpoint.
 *  - "cache"  — read from an on-disk file the CLI itself maintains (e.g.
 *               `.claude.json`'s `cachedUsageUtilization`, a codex sessions
 *               JSONL's `rate_limits`), used when the live fetch is unavailable.
 *  - "scrape" — reconstructed from a browser/IDE session (e.g. Cursor's web
 *               cookie), the most fragile source.
 */
export type QuotaSource = "api" | "cache" | "scrape";

/**
 * Outcome of the most recent attempt to fetch a harness's quota:
 *  - "ok"          — we have live or cached meters to show.
 *  - "unavailable" — the provider has no obtainable usage data for this
 *                     harness/account (e.g. no Cursor cookie, a Gemini
 *                     individual-tier account) — not an error, just nothing
 *                     to show.
 *  - "error"       — a fetch or parse attempt failed (network, auth, shape
 *                     change). `HarnessQuota.reason` carries detail for the UI.
 */
export type QuotaStatus = "ok" | "error" | "unavailable";

/**
 * One usage bar within a `HarnessQuota` snapshot — e.g. "5-hour session",
 * "weekly", "Opus", "credits". Providers report different meters, so this
 * shape is deliberately minimal and provider-agnostic.
 */
export interface QuotaMeter {
  /** Stable id within the snapshot (e.g. "five_hour", "seven_day_opus"). */
  id: string;
  /** User-facing label for the meter. */
  label: string;
  /** 0..100, how much of this meter's allotment has been used. */
  usedPercent: number;
  /** Epoch ms when this meter resets, or null if the provider didn't report one. */
  resetsAtMs: number | null;
  /** Optional model/window scope this meter applies to (e.g. "Opus", "Sonnet"). */
  scope?: string;
}

/**
 * Normalized per-harness usage/quota snapshot, as surfaced by the topbar
 * usage tracker (`GET /usage`, `harness_usage` AppEvent). Distinct from
 * `HarnessUsage` above — that type is task-count blast radius for the
 * disable-confirmation dialog and is unrelated to this feature.
 *
 * `meters` is intentionally dynamic: each provider returns a different set
 * (Claude may report session/weekly/Opus/Sonnet/routines/extra-credit;
 * Codex session/weekly/credits; Cursor plan/on-demand) and the UI renders
 * whatever's present rather than assuming a fixed list.
 */
export interface HarnessQuota {
  /** Harness id this snapshot is for. */
  harnessId: string;
  /** Underlying CLI kind — useful for the UI to render the right icon. */
  kind: AgentKind;
  /** Provider-reported plan/tier name, when known (e.g. "Pro", "Team"). */
  planType: string | null;
  status: QuotaStatus;
  source: QuotaSource;
  /** Epoch ms when this snapshot was produced (fetched or read from cache). */
  fetchedAtMs: number;
  meters: QuotaMeter[];
  /** User-facing explanation when `status` isn't "ok" — null when it is. */
  reason: string | null;
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
  {
    id: "cursor-additional",
    label: "Additional Cursor",
    description:
      "Another cursor-agent harness with its own HOME override so login and config are isolated from the built-in — cursor-agent has no dedicated config-dir env var, so a full HOME override is how accounts are separated.",
    kind: "cursor",
    suggestedHarnessId: "cursor-2",
    home: "{dataDir}/harnesses/cursor-2",
    bin: null,
    env: {},
  },
  {
    id: "gemini-additional",
    label: "Additional Gemini",
    description:
      "Another gemini harness with its own GEMINI_CLI_HOME so login and session history are isolated from the built-in.",
    kind: "gemini",
    suggestedHarnessId: "gemini-2",
    home: "{dataDir}/harnesses/gemini-2",
    bin: null,
    env: {},
  },
  {
    id: "fx-additional",
    label: "Additional fx",
    description:
      "Another fx harness with its own HOME override so login and config are isolated from the built-in — fx has no dedicated config-dir env var, so a full HOME override is how accounts are separated.",
    kind: "fx",
    suggestedHarnessId: "fx-2",
    home: "{dataDir}/harnesses/fx-2",
    bin: null,
    env: {},
  },
];

export type Isolation = "worktree" | "none";

/**
 * High-level classification of a task. Cosmetic only — drives the icon and
 * left-border color on the kanban card and the picker in NewTaskForm. Has no
 * effect on agent invocation, scheduling, or orchestration. New rows default
 * to "task"; legacy rows are backfilled by migration 020.
 */
export type TaskType = "task" | "bug" | "spike";

export interface TaskTypeMeta {
  id: TaskType;
  label: string;
  hint: string;
  /** Lucide icon name — resolved in the UI to the actual component. */
  icon: "Inbox" | "Bug" | "FlaskConical";
  /** Tailwind class fragments used to paint the icon (text-) and the card's
   *  left border (border-l-). Kept as fragments rather than full class names
   *  so the consumer composes them with `cn(...)`. */
  iconClass: string;
  borderClass: string;
}

// Task-type coloring rides the shared semantic tokens (index.css /
// tailwind.config.js) rather than literal palette classes, per the UI
// convention below. "bug" maps cleanly onto --danger (both are "something's
// wrong", same red/rose family as the literal it replaces) and "task" maps
// cleanly onto --info (its original literal was already sky, --info's own
// hue family) — genuine status-token reuse, not a stretch. "spike" has no
// clean status-token equivalent (it's a category, not a status), so it gets
// its own --spike token (violet) rather than being forced onto an existing
// one — see the --spike comment in index.css for why that isn't --merged.
export const TASK_TYPES: TaskTypeMeta[] = [
  {
    id: "task",
    label: "Task",
    hint: "Standard work item.",
    icon: "Inbox",
    iconClass: "text-info",
    borderClass: "border-l-info",
  },
  {
    id: "bug",
    label: "Bug",
    hint: "Defect to investigate or fix.",
    icon: "Bug",
    iconClass: "text-danger",
    borderClass: "border-l-danger",
  },
  {
    id: "spike",
    label: "Spike",
    hint: "Exploratory / research task.",
    icon: "FlaskConical",
    iconClass: "text-spike",
    borderClass: "border-l-spike",
  },
];

export const DEFAULT_TASK_TYPE: TaskType = "task";

export function taskTypeMeta(t: TaskType | null | undefined): TaskTypeMeta {
  return TASK_TYPES.find((x) => x.id === t) ?? TASK_TYPES[0]!;
}

// ───────────────────────────────────────────────────────────────────────────
// Branch nomenclature (per project)
// ───────────────────────────────────────────────────────────────────────────

/**
 * How agetor names the git branch it creates for a worktree-isolated task.
 * One rule per {@link TaskType}, so "feature"/"bug"/"spike" work can land on
 * differently-prefixed branches.
 */
export interface BranchNamingRule {
  /**
   * Leading segment of the branch, typically ending in "/" (e.g. `"feature/"`).
   * Fully customizable; validated to git-legal characters. May be empty.
   */
  prefix: string;
}

/**
 * Per-project branch nomenclature. Stored on the project row (JSON); a project
 * with no stored config falls back to {@link DEFAULT_BRANCH_CONFIG}.
 */
export interface BranchNamingConfig {
  /** Per-task-type prefix. Every {@link TaskType} id must have an entry. */
  rules: Record<TaskType, BranchNamingRule>;
  /** When true, the card title (slugified) forms the branch body. */
  includeSlug: boolean;
}

/**
 * Built-in defaults. The existing task types (task | bug | spike) map to the
 * conventional feature/ | fix/ | spike/ prefixes.
 */
export const DEFAULT_BRANCH_CONFIG: BranchNamingConfig = {
  rules: {
    task: { prefix: "feature/" },
    bug: { prefix: "fix/" },
    spike: { prefix: "spike/" },
  },
  includeSlug: true,
};

/**
 * Prefix of the pre-nomenclature branch scheme (`agetor/<short-id>-<slug>`).
 * Still emitted by `branchName()` as a legacy fallback, used to hide
 * agetor-managed branches from the base-ref picker, and treated as "no
 * meaningful prefix" by {@link branchCommitType}. Lives in shared so the one
 * magic prefix has a single definition rather than a copy per call site.
 */
export const LEGACY_BRANCH_PREFIX = "agetor/";

/** Max length of the slug portion of a branch body. */
const BRANCH_SLUG_MAX = 40;

/**
 * Turn arbitrary text into a git-legal, kebab-cased branch segment: lowercased,
 * every run of non-alphanumerics collapsed to a single "-", leading/trailing
 * "-" trimmed, length capped. Returns "" when the input has no usable
 * characters (callers supply a fallback such as a short id token).
 */
export function slugifyBranch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, BRANCH_SLUG_MAX)
    .replace(/-+$/g, "");
}

/**
 * A template tag the branch-name field recognizes and substitutes. Purely
 * descriptive metadata — {@link BRANCH_TEMPLATE_TAGS} drives the helper text
 * shown under the Branch name field; the substitution logic itself lives in
 * {@link renderBranchTemplate}.
 */
export interface BranchTemplateTag {
  /** The literal tag text, e.g. `"<slug>"`. */
  tag: string;
  /** One-line human description shown alongside the tag in the UI. */
  description: string;
}

/** Ordered list used by the UI helper text under the Branch name field. */
export const BRANCH_TEMPLATE_TAGS: readonly BranchTemplateTag[] = [
  { tag: "<slug>", description: "Task title, slugified (short id when empty)" },
  { tag: "<project_name>", description: "Project folder name, slugified" },
  { tag: "<type>", description: "Task type (task, bug, or spike)" },
  { tag: "<date>", description: "Creation date (YYYY-MM-DD)" },
  { tag: "<timestamp>", description: "Creation timestamp (YYYYMMDD-HHmmss)" },
  { tag: "<token>", description: "Short unique id" },
];

/**
 * The tags that carry the branch *body* (its per-task uniqueness). A rule
 * value containing one of these is a full template, so {@link branchPattern}
 * appends nothing to it; the other tags are decoration and don't suppress the
 * appended body.
 */
export const BRANCH_BODY_TAGS = ["<slug>", "<token>"] as const;

/** Inputs {@link renderBranchTemplate} substitutes into a template string. */
export interface BranchTemplateContext {
  title: string;
  /** Raw project folder name; the renderer slugifies it. */
  projectName: string;
  taskType: TaskType;
  /** Short unique token, e.g. 6 chars of the task id. */
  token: string;
  /** Injected for deterministic tests/previews; defaults to `new Date()`. */
  now?: Date;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Local-time `YYYY-MM-DD`. */
function formatBranchDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local-time `YYYYMMDD-HHmmss`. */
function formatBranchTimestamp(d: Date): string {
  const date = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `${date}-${time}`;
}

/**
 * True iff `value` contains at least one KNOWN template tag, i.e. one listed
 * in {@link BRANCH_TEMPLATE_TAGS}. An unknown `<...>` sequence does not count
 * — {@link renderBranchTemplate} passes those through literally, so a string
 * containing only unrecognized angle-bracket text is not "templated" from the
 * caller's point of view.
 */
export function hasBranchTemplateTags(value: string): boolean {
  return BRANCH_TEMPLATE_TAGS.some(({ tag }) => value.includes(tag));
}

/**
 * Render a branch-name template by substituting every known tag
 * ({@link BRANCH_TEMPLATE_TAGS}) with its resolved value:
 * - `<slug>` → the slugified title, falling back to `ctx.token` so it can
 *   never render empty (which would otherwise leave a dangling `feature/`).
 * - `<project_name>` → the slugified project name, falling back to
 *   `"project"`.
 * - `<type>` → `ctx.taskType` verbatim.
 * - `<date>` / `<timestamp>` → local-time formatted from `ctx.now` (defaults
 *   to `new Date()`); callers inject `now` for deterministic previews/tests.
 * - `<token>` → `ctx.token` verbatim.
 *
 * Unknown `<...>` sequences (e.g. a stray `<foo>`) are left untouched — git
 * allows `<`/`>` in ref names, so there's no need to reject or strip them.
 * A tag-free string is returned unchanged (identity); this is what lets a
 * plain literal branch name — the pre-template back-compat path — flow
 * through {@link renderBranchTemplate} unmodified.
 */
export function renderBranchTemplate(template: string, ctx: BranchTemplateContext): string {
  const now = ctx.now ?? new Date();
  const slug = slugifyBranch(ctx.title) || ctx.token;
  const projectSlug = slugifyBranch(ctx.projectName) || "project";
  return template
    .split("<slug>").join(slug)
    .split("<project_name>").join(projectSlug)
    .split("<type>").join(ctx.taskType)
    .split("<date>").join(formatBranchDate(now))
    .split("<timestamp>").join(formatBranchTimestamp(now))
    .split("<token>").join(ctx.token);
}

/**
 * The stable, tag-containing branch-name pattern for a task type — what the
 * New Task form shows before the user edits the field, and what the server
 * renders against at creation time when no override is supplied. Resolves the
 * per-type rule via the fallback chain (per-type rule → default config's rule
 * for that type → empty prefix), then returns the un-rendered template
 * (`<slug>`/`<token>`, `<date>`, `<type>`, …).
 *
 * If `rule.prefix` already contains a body tag (`<slug>` or `<token>`), it is
 * treated as a full template and returned verbatim — an explicit `<slug>` in
 * the prefix wins even when `config.includeSlug` is false, and nothing is
 * appended (that would double the tag). Otherwise the body tag
 * (`config.includeSlug ? "<slug>" : "<token>"`) is appended to the prefix as
 * before. Non-body tags (`<date>`, `<type>`, `<project_name>`, `<timestamp>`)
 * do not suppress the append — only `<slug>`/`<token>` count as a body.
 */
export function branchPattern(config: BranchNamingConfig, taskType: TaskType): string {
  const rule = config.rules[taskType] ?? DEFAULT_BRANCH_CONFIG.rules[taskType] ?? { prefix: "" };
  if (BRANCH_BODY_TAGS.some((tag) => rule.prefix.includes(tag))) return rule.prefix;
  return `${rule.prefix}${config.includeSlug ? "<slug>" : "<token>"}`;
}

/**
 * Validate a full git branch name against the same rules as
 * `git check-ref-format refs/heads/<name>`. Returns the offending reason on
 * failure so the UI can explain why an override was rejected. Note: underscore
 * is allowed; backslash is not.
 */
export function validateBranchName(
  name: string,
): { ok: true } | { ok: false; reason: string } {
  if (!name) return { ok: false, reason: "Branch name is empty." };
  if (name.startsWith("/") || name.endsWith("/")) {
    return { ok: false, reason: "Cannot start or end with '/'." };
  }
  if (name.endsWith(".")) return { ok: false, reason: "Cannot end with '.'." };
  if (name.includes("//")) return { ok: false, reason: "Cannot contain '//'." };
  if (name.includes("..")) return { ok: false, reason: "Cannot contain '..'." };
  if (name.includes("@{")) return { ok: false, reason: "Cannot contain '@{'." };
  if (name === "@") return { ok: false, reason: "Cannot be a single '@'." };
  // Control chars (incl. DEL), space, and ~ ^ : ? * [ \ are all forbidden.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f ~^:?*[\\]/.test(name)) {
    return {
      ok: false,
      reason: "Contains a disallowed character (space, ~, ^, :, ?, *, [, \\, or a control char).",
    };
  }
  for (const seg of name.split("/")) {
    if (seg === "") continue; // empty segments are caught by the "//" check above
    if (seg.startsWith(".")) return { ok: false, reason: "A path segment cannot start with '.'." };
    if (seg.endsWith(".lock")) return { ok: false, reason: "A path segment cannot end with '.lock'." };
  }
  return { ok: true };
}

/**
 * Validate a whole {@link BranchNamingConfig}: every task type must have a
 * string prefix that composes into a legal branch. Used by the settings dialog
 * (client) and the persist route (server) so a bad prefix can't be saved.
 */
export function validateBranchConfig(
  config: BranchNamingConfig,
): { ok: true } | { ok: false; reason: string } {
  for (const t of TASK_TYPES) {
    const rule = config.rules[t.id];
    if (!rule || typeof rule.prefix !== "string") {
      return { ok: false, reason: `Missing prefix for "${t.label}".` };
    }
    // Render the type's pattern through the authoritative template path so a
    // bare "feature/" passes but "feat ure/" (space) or "/x" (leading slash)
    // is rejected.
    const sample = renderBranchTemplate(branchPattern(config, t.id), {
      title: "example task",
      projectName: "project",
      taskType: t.id,
      token: "abc123",
    });
    const v = validateBranchName(sample);
    if (!v.ok) return { ok: false, reason: `"${rule.prefix}" is not a valid prefix — ${v.reason}` };
  }
  return { ok: true };
}

/**
 * Conventional-commit type suggested for a task's commit message, derived from
 * its {@link TaskType}. Keeps the "Commit & push" message consistent with the
 * branch nomenclature scheme (bug → fix, spike → chore, everything else feat).
 */
export function conventionalCommitType(t: TaskType | null | undefined): string {
  switch (t) {
    case "bug":
      return "fix";
    case "spike":
      return "chore";
    default:
      return "feat";
  }
}

/**
 * Commit-message type for a task, derived from its actual branch so the commit
 * matches the branch nomenclature: the branch's prefix with the trailing slash
 * removed (e.g. `"feature/add-login"` → `"feature"`, `"hotfix/nav"` → `"hotfix"`).
 * Because the branch body is always a single slash-free segment (slugify strips
 * slashes; the token has none), everything before the final `/` is exactly the
 * configured prefix. Used by the "Commit & push" action.
 *
 * Falls back to {@link conventionalCommitType} when the branch carries no
 * meaningful prefix:
 *  - no `/` at all — a slash-less manual override, or isolation off (no branch);
 *  - the legacy `agetor/` scheme (`agetor/<id>-<slug>`, pre-nomenclature rows),
 *    whose prefix is an internal implementation detail, not a commit type.
 */
export function branchCommitType(
  branch: string | null | undefined,
  taskType: TaskType | null | undefined,
): string {
  if (branch && !branch.startsWith(LEGACY_BRANCH_PREFIX)) {
    const i = branch.lastIndexOf("/");
    if (i > 0) return branch.slice(0, i);
  }
  return conventionalCommitType(taskType);
}

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
  /**
   * Cosmetic classification — drives the icon + left-border color on the
   * kanban card. No effect on orchestration. Persisted rows always carry a
   * value (default "task"; migration 020 backfills legacy rows).
   */
  taskType: TaskType;
  /** Branch name created for this task. Set after the worktree is first materialized. */
  branch: string | null;
  /**
   * "created" when agetor minted a fresh branch off `baseRef` (the default
   * for every task). "existing" when the task was pinned to a pre-existing
   * branch (e.g. a PR's head branch via `existingBranch` at create time) —
   * teardown paths must never `git branch -D` that branch. Migration 028
   * backfills legacy rows to "created".
   */
  branchSource: "created" | "existing";
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
   * URL of the pull request opened for this task's branch, or null if none
   * has been created yet. Set server-side, atomically with creation, by
   * `POST /github/pull-create` when the request carries this task's id —
   * never patchable directly (kept out of the PATCH allow-list, same
   * treatment as `branch`/`worktreePath`/`baseRef`). Once set, the UI shows
   * a durable "View PR" link instead of re-offering "Open PR".
   */
  prUrl: string | null;
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
   * Fast model variant toggle. Currently only consumed by Cursor, whose CLI
   * exposes Fast as part of the selected model id rather than as a standalone
   * flag. Non-Cursor harnesses ignore it.
   */
  fast: boolean;
  /**
   * Cursor Max Mode / large-context toggle. This is intentionally separate
   * from effort="max", which means maximum reasoning/thinking effort.
   * Non-Cursor harnesses ignore it.
   */
  maxMode: boolean;
  /**
   * Path-only references the user attached at task creation (files and
   * folders on the user's machine). Empty list when none. Inlined into the
   * launch prompt as text — agetor never copies or uploads these.
   */
  references: TaskReference[];
  /**
   * Saved, not-yet-sent draft messages for this task — a per-task memory of
   * things the user wants to send later but isn't ready to send now. Ordered
   * newest-intent-first by array position (the UI lets the user reorder).
   * Persisted as a JSON column, mirroring `references`. Empty list when none.
   * Sending a backlog item consumes it (removes it from this list).
   */
  backlog: BacklogMessage[];
  /**
   * The composer's unsent draft for this task — text plus any attached
   * references, persisted so closing and reopening the task details modal
   * (or restarting agetor) doesn't lose in-progress typing. Null when the
   * composer is empty. Distinct from `backlog`: the draft is implicit,
   * autosaved state ("what's sitting in the composer right now"), while
   * backlog items are explicit user-stashed drafts. Cleared when the draft
   * is sent, stashed via "Save for later" (which moves it into `backlog`),
   * or emptied by the user.
   */
  draft: TaskDraft | null;
  /**
   * Cursor plans detected from a run ending on `createPlanToolCall` (the
   * agent wrote a plan and stopped), plus claude-code plans detected from
   * `ExitPlanMode` tool_use/tool_result pairs in the chunk handler. Both are
   * server-managed — detected in `attachDoneHandler` (cursor) or the chunk
   * handler (claude), mutated only via the plan edit/approve routes for
   * cursor (claude plans are read-only records — approval stays a live
   * keystroke flow, not a route), never patchable through the generic task
   * PATCH. Empty for every task of another kind, and for tasks that haven't
   * produced a plan yet. At most one entry is ever `pending` at a time (see
   * {@link TaskPlan.status}).
   */
  plans: TaskPlan[];
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
   * `AskUserQuestion` / `ExitPlanMode` Claude built-ins, tool-call approval
   * requests, and unstructured in-REPL tmux prompts
   * (the "CLAUDE IS PAUSED ON A PROMPT" card). Computed in `tasks.list()` /
   * `tasks.get()` via `countPendingForTask` (interactions live in memory;
   * not persisted). Drives the kanban card's "Answer →" call-to-action.
   *
   * Codex's narrative `column='blocked'` signal is reflected via `task.column`,
   * not this counter — the card combines both at render time.
   */
  pendingInteractionCount: number;
  /**
   * Number of live terminal tabs open for this task. Each tab is an
   * interactive shell spawned via Bun's PTY (`Bun.spawn(..., { terminal })`)
   * and tracked in-memory by `src/bun/terminals.ts` — never persisted, since
   * the PTYs die with the app. Computed in `tasks.list()` / `tasks.get()` via
   * `countTerminals`, exactly like `pendingInteractionCount`. Drives the
   * kanban card's terminal badge (hidden when zero).
   */
  openTerminalCount: number;
  /**
   * Board-level TODO/task-tools progress summary — `{ completed, total }`
   * derived from the task's `TodoWrite`/`TaskCreate`/`TaskUpdate` tool
   * events via `deriveTodoProgress`/`summarizeTodoProgress`
   * (`src/shared/todo-progress.ts`) and persisted server-side by the
   * orchestrator's chunk handler whenever a todo-family chunk lands. Null
   * (or omitted) when the task has never emitted a todo-family tool call.
   * Server-managed (not in the PATCH allow-list) — this is what lets the
   * kanban board show a `3/8` mini-badge without loading per-task events on
   * every 2s poll.
   *
   * Optional (rather than required like `plans`) so the many existing
   * hand-built `Task` fixtures across `src/bun/*.test.ts` that predate this
   * field don't all need a mechanical `todoProgress: null` edit — `db.ts`
   * always populates it on read (`toTask`/`tasks.insert`/`tasks.update`), so
   * runtime code can treat a missing key the same as `null`.
   */
  todoProgress?: { completed: number; total: number } | null;
  /**
   * Whether this task has assistant messages the user hasn't seen yet —
   * `last_assistant_event_id > last_seen_event_id` (both watermarks live on
   * the `tasks` row, migration 045), computed in `db.ts`'s `toTask` and
   * never stored as its own column. `last_assistant_event_id` is bumped by
   * the orchestrator's chunk handler on every top-level (non-subagent)
   * `assistant` stream event; `last_seen_event_id` is bumped by
   * `POST /tasks/:id/seen` when the run panel opens or closes. Drives the
   * kanban card's colored corner dot.
   *
   * Optional (rather than required) for the same reason as `todoProgress`:
   * the many hand-built `Task` fixtures in `src/bun/*.test.ts` predate this
   * field and shouldn't all need a mechanical `unread: false` edit — `db.ts`
   * always populates it on read, so runtime code can treat a missing key the
   * same as `false`. Server-managed: not patchable, excluded from
   * `ALLOWED_PATCH_FIELDS`; the only writers are the chunk handler and the
   * dedicated mark-seen route.
   */
  unread?: boolean;
  createdAt: number;
  updatedAt: number;
  /**
   * Unix ms timestamp when the task was archived; null when not archived.
   * Archived tasks remain in their column (always `done` in practice — the
   * server rejects archive from other columns) but are hidden from the
   * default kanban filter and rendered read-only in the run panel.
   */
  archivedAt: number | null;
  /** Count of this task's subagents currently `status:"running"`. Derived per
   *  request by the server (never persisted, never patchable). Absent on payloads
   *  that don't join the subagents table. */
  runningSubagents?: number;
}

/** Why a worktree is flagged `stale` in {@link WorktreeInfo}. A worktree can
 *  carry more than one reason at once (e.g. archived AND past the inactivity
 *  threshold). */
export type WorktreeStaleReason = "orphaned" | "archived" | "inactive";

/** How long a task can go without an update before its worktree is flagged
 *  `"inactive"` — 7 days. */
export const WORKTREE_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** How long a claude session must sit idle (no in-flight turn, no pending
 *  interaction, no session activity) before the idle-session reaper kills its
 *  tmux session to reclaim the REPL's memory. Follow-ups after a reap resume
 *  via `claude --resume` (spawnResumedSession) instead of a live paste. */
export const IDLE_SESSION_REAP_MS = 30 * 60 * 1000; // 30 minutes

/** Cadence of the orchestrator's idle-session reap sweep. */
export const SESSION_REAP_SWEEP_MS = 5 * 60 * 1000; // 5 minutes

/** Cadence of the background per-harness usage/quota poll sweep. */
export const USAGE_POLL_SWEEP_MS = 10 * 60 * 1000; // 10 minutes

/** Per-harness floor: skip re-fetching a usage snapshot fresher than this.
 *  A force-refresh (e.g. the popover's Refresh button) bypasses the floor. */
export const USAGE_MIN_REFRESH_MS = 60 * 1000; // 1 minute

/** `QuotaMeter.usedPercent` at/above which the UI renders amber ("warn"). */
export const USAGE_WARN_PERCENT = 70;

/** `QuotaMeter.usedPercent` at/above which the UI renders red ("crit"). */
export const USAGE_CRIT_PERCENT = 90;

/** Agent kinds with a usage provider registered bun-side (the
 *  `USAGE_PROVIDERS` registry in `src/bun/usage/poller.ts` is typed against
 *  this list, so the two can't drift). The webview uses it to decide whether
 *  a chip without a snapshot should say "enable the harness / refresh" vs
 *  "usage tracking isn't supported for this kind yet" (gemini/grok). */
export const USAGE_SUPPORTED_KINDS = ["claude-code", "codex", "cursor"] as const satisfies readonly AgentKind[];

/**
 * A git worktree materialized on disk under `dataDir/worktrees/`, as surfaced
 * by `GET /worktrees`. One row per directory found on disk — computed live by
 * `orchestrator.listWorktrees()` from fs + DB signals only (no git
 * subprocesses in the bulk listing).
 */
export interface WorktreeInfo {
  /** Directory basename under `dataDir/worktrees/` — equal to the owning task's id by construction. */
  id: string;
  /** Absolute worktree directory path on disk. */
  path: string;
  /** Owning task id, or null for an orphaned dir with no matching task row. */
  taskId: string | null;
  /** Owning task's title, or null when orphaned. */
  taskTitle: string | null;
  /** Owning task's kanban column, or null when orphaned. */
  column: ColumnId | null;
  /** Owning task's `archivedAt`, or null when orphaned or not archived. */
  archivedAt: number | null;
  /** Owning task's `updatedAt`, or null when orphaned. */
  taskUpdatedAt: number | null;
  /** Owning task's branch, or null when orphaned. */
  branch: string | null;
  /** Source repo path — `task.workdir` for an owned worktree; for an orphan, a
   *  best-effort parse of the `.git` pointer file, or null if unreadable. */
  workdir: string | null;
  /** True when the owning task currently has a run in flight. */
  runActive: boolean;
  /** True when at least one background agent/workflow (subagent row) for the
   *  owning task is still `status:"running"`. This is also why an
   *  old-but-held worktree is not flagged `"inactive"` — see
   *  {@link WorktreeStaleReason}. Always `false` for orphaned rows (no
   *  owning task). */
  heldByBackgroundAgents: boolean;
  /** True when `staleReasons` is non-empty. */
  stale: boolean;
  /** Every reason this worktree is considered stale; empty when not stale. */
  staleReasons: WorktreeStaleReason[];
}

/**
 * Outcome of the worktree teardown an archive triggered, as surfaced by
 * `POST /tasks/:id/archive` when the caller passes `awaitTeardown: true`.
 *
 * Archive normally defers teardown onto a per-workdir background queue and
 * responds in milliseconds, so the response carries no outcome at all. The
 * Worktrees page's "Archive & delete" is the one caller that needs to know
 * whether the directory is *actually* gone before it refreshes the list — it
 * opts in, and gets this back.
 *
 * `reason` is only meaningful when `removed` is false:
 * - `"dirty"` — the checkout had uncommitted changes and `forceWorktree` was
 *   not set, so it was deliberately left in place. (`hasUncommittedChanges`
 *   folds git errors into this too — it returns null on a failing `git
 *   status`, which the caller treats as "don't touch".)
 * - `"no-worktree"` / `"already-absent"` — there was nothing to remove. Not a
 *   failure; callers should treat these as success.
 * - `"failed"` — removal was attempted and the directory is still there.
 */
export interface WorktreeTeardownResult {
  /** True when the worktree directory is no longer on disk after the teardown. */
  removed: boolean;
  /** Why `removed` is false. Absent when `removed` is true. */
  reason?: "dirty" | "no-worktree" | "already-absent" | "failed";
}

/**
 * On-demand live git status for a single worktree, as surfaced by
 * `GET /worktrees/:id/git-status`. Not part of the bulk `GET /worktrees`
 * listing — computing this spawns git subprocesses, so it's fetched per row
 * rather than on every poll.
 */
export interface WorktreeGitStatus {
  /** Working tree has uncommitted changes (staged, unstaged, or untracked). */
  dirty: boolean;
  /** Commits on HEAD not yet pushed / ahead of base (see getAheadCount). 0 when unknown. */
  ahead: number;
  /** HEAD is an ancestor of the source repo's default branch — its work already
   *  landed, so the worktree is safe to delete. null when it can't be determined
   *  (no resolvable default branch, or a git error) — never a false "merged". */
  merged: boolean | null;
  /** The dir isn't inspectable (missing, not a git repo, git failed). When true,
   *  the other fields are not meaningful. */
  ignored: boolean;
}

/**
 * On-demand live git status for a single *task*, as surfaced by
 * `GET /tasks/:id/git-status`. Distinct from {@link WorktreeGitStatus} (which
 * backs the orphan-worktree management UI) — this one drives the run panel's
 * "Commit & push" and "Open PR" chips.
 */
export interface TaskGitStatus {
  /** Working tree has uncommitted changes (staged, unstaged, or untracked). */
  hasChanges: boolean;
  /**
   * Commits on HEAD not yet pushed, computed against the task's upstream if
   * one exists, else against the pinned `baseRef` (see `getAheadCount`). `0`
   * when unknown. This is the "commit & push" ahead count — distinct from
   * `remoteSynced`'s own upstream-only ahead check below.
   */
  ahead: number;
  /** The dir isn't inspectable (missing, not a git repo, git failed). When true,
   *  the other fields default to their "nothing to offer" values and shouldn't
   *  be read as meaningful. */
  ignored: boolean;
  /** The task's branch has a configured upstream (i.e. has been pushed at
   *  least once) — computed locally via `remoteSyncState`, no network call. */
  hasUpstream: boolean;
  /**
   * `hasUpstream && ahead(@{u}..HEAD) === 0` — the branch exists on the
   * remote and local HEAD has nothing left to push. Gates the "Open PR"
   * affordance. A remote strictly ahead of local (`behind > 0`) does not
   * block this — only unpushed local commits do.
   */
  remoteSynced: boolean;
  /**
   * Short name of the branch the task's dir currently has checked out, or
   * `null` on a detached HEAD / uninspectable dir. Distinct from
   * `task.branch`, which is agetor's *worktree-managed* branch and is `null`
   * for every `isolation: "none"` task — this is the live git answer, and
   * it's what lets an isolation-none task on the user's own feature branch
   * still offer "Create PR" (see `prHeadBranch` in `lib/commit-push.ts`).
   */
  branch: string | null;
  /** `branch` is the repo's default branch, so a PR from it would degenerate
   *  to base == head. `false` also means "couldn't determine" — see
   *  `HeadBranchState.isDefaultBranch` in `worktree.ts` for why unknown
   *  resolves to offering the affordance rather than hiding it. */
  isDefaultBranch: boolean;
}

/** A live terminal tab for a task. Returned by the terminal REST endpoints;
 *  state lives only in memory in `src/bun/terminals.ts`. */
export interface TerminalTab {
  id: string;
  taskId: string;
  /** Display label for the tab (e.g. "Terminal 1"). */
  title: string;
  /** Working directory the shell was spawned in (worktree path or workdir). */
  cwd: string;
  createdAt: number;
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

/**
 * A saved, not-yet-sent draft message parked on a task's backlog. Carries the
 * same shape a follow-up message assembles from the composer: free-text plus
 * any attached file/folder references. When the user sends it, the text and
 * references are inlined (via `appendReferences`) exactly like a normal
 * follow-up, then the item is removed from the backlog.
 */
export interface BacklogMessage {
  /** Stable id, assigned server-side, used to target edit/delete/reorder/send. */
  id: string;
  /** The draft message text. May be empty when the item is references-only. */
  text: string;
  /** File/folder references to inline when this draft is eventually sent. */
  references: TaskReference[];
  /** Unix ms timestamp when the draft was saved. */
  createdAt: number;
}

/**
 * The composer's single unsent draft for a task — text plus any attached
 * references, autosaved while the user types and restored on reopen. Unlike
 * {@link BacklogMessage}, there is at most one per task and it carries no id
 * or timestamp: it's ephemeral working state, not an explicit stashed item.
 */
export type TaskDraft = {
  /** The draft message text, preserved verbatim (never trimmed). */
  text: string;
  /** File/folder references currently attached in the composer. */
  references: TaskReference[];
};

/**
 * A plan Cursor wrote via its `createPlanToolCall` tool and then stopped on
 * (the common "finished after planning" behavior). Detected server-side in
 * `attachDoneHandler` when a run resolves `succeeded` and its last `tool_use`
 * event is `createPlanToolCall`; persisted on `task.plans` so it survives the
 * 2s `/tasks` poll and restarts. Approving writes the effective content to a
 * `.plan.md` file inside the task's worktree and auto-sends an approval
 * message that resumes the agent.
 */
export interface TaskPlan {
  /** 8-char lowercase hex hash of `toolCallId` — safe for filenames/URLs,
   *  since Cursor's raw call_ids contain embedded newlines. */
  id: string;
  /** Raw call_id from the `createPlanToolCall` tool_use event (may contain
   *  `\n`) — matches the event so the UI can pair a plan record to its card. */
  toolCallId: string;
  /** Run whose terminal `tool_use` produced this plan. */
  runId: string;
  /** `args.name` from the tool call, or null when Cursor didn't supply one. */
  name: string | null;
  /** Original plan markdown, verbatim from `args.plan`. Never mutated after
   *  creation — edits live in `editedContent` so "Revert Changes" has
   *  something to revert to. */
  content: string;
  /** Unapproved user edits, persisted on explicit Save actions only (no
   *  autosave — see the StrictMode/flush-on-unmount hazard this sidesteps).
   *  Null when there is no draft, or when a draft was cleared back to the
   *  original. The effective plan content is `editedContent ?? content`. */
  editedContent: string | null;
  /**
   * `pending` — awaiting approval, editable, the one plan a task can act on.
   * `approved` — terminal; the modal becomes read-only.
   * `superseded` — a newer `createPlanToolCall` run landed while this one was
   * still pending. Chat turns do NOT supersede a pending plan — only another
   * detected plan does.
   * `rejected` — terminal; a claude-code `ExitPlanMode` plan whose matching
   * tool_result was neither the approval string nor an edited-plan approval
   * (the user rejected it, or the turn was interrupted before approval).
   * Cursor plans never land in this state — cursor's approve/edit routes are
   * the only way a cursor plan resolves.
   */
  status: "pending" | "approved" | "superseded" | "rejected";
  /** Unix ms timestamp when the plan was detected. */
  createdAt: number;
  /** Unix ms timestamp when approved, or null while pending/superseded. */
  approvedAt: number | null;
  /** True when the approved content came from `editedContent` rather than
   *  the original `content` — drives the approval message wording. */
  approvedEdited: boolean;
  /** Worktree-relative path the effective plan was written to at approval
   *  time (e.g. `.cursor/plans/<slug>_<id>.plan.md`), or null before
   *  approval. */
  filePath: string | null;
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

export interface CursorModelSpec {
  label: string;
  hint?: string;
  /** Whether Cursor accepts a large-context / Max Mode override for this base model. */
  supportsMaxMode?: boolean;
  /** Cursor's concrete model ids for each thinking level this base model supports. */
  effortIds?: Partial<Record<string, string>>;
  /** Thinking levels that Cursor exposes as a separate Fast variant. */
  fastEfforts?: string[];
  /** Fast model id for models with a fast toggle but no thinking levels. */
  fastId?: string;
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
  // Default to Opus 5 — the most-capable Opus, priced identically to Opus 4.8
  // ($5/$25 per MTok). Mythos 5 and Fable 5 sit above it in the picker but
  // cost 2x the usage, so the default stays on the most-capable non-premium
  // tier.
  "claude-code": "opus-5",
  "codex": "gpt-5.6-sol",
  // Grok 4.6 (high effort via DEFAULT_EFFORT) — replaces cursor-agent's own
  // "auto" as agetor's default so new tasks pin an explicit flagship model.
  "cursor": "cursor-grok-4.6",
  // gemini-3-pro-preview is the current flagship per google-gemini/gemini-cli
  // docs (verified 2026-08-06). Deliberately NOT the "auto" alias — a spike
  // showed "auto" internally routes across mixed pro/flash-lite models even
  // for simple prompts, which fails "always default to the best available
  // model" (root CLAUDE.md). Pin an explicit flagship instead.
  "gemini": "gemini-3-pro-preview",
  // fx's own compiled default since 0.0.6 — Kimi K3 (Fast mode on),
  // following fx's own default rather than picking one ourselves. Ids are
  // Vercel AI Gateway ids, passed verbatim. fx is exempt from the "always
  // default to the best available model" rule above: the Gateway bills per
  // token to the user's own account, and this tier is the tuned sweet spot
  // for fx's agentic loop rather than a cost compromise — flagship tiers
  // (gpt-5.5, claude-sonnet-5/opus-5, gemini-3.1-pro-preview) remain one
  // click away in the picker.
  "fx": "moonshotai/kimi-k3",
};
export const DEFAULT_EFFORT: Record<AgentKind, string> = {
  "claude-code": "high",
  "codex": "high",
  // Models with `effortIds` default to High where they expose it (else their
  // first available level — e.g. claude-4.6-sonnet only exposes medium).
  // Models without `effortIds` ("auto", composer-2.5, the Gemini rows, …)
  // decline effort and store NULL.
  "cursor": "high",
  // Gemini has no per-invocation effort/thinking-budget flag (verified via
  // `gemini --help` on CLI 0.54.0 — thinkingBudget/thinkingLevel are
  // settings.json-only, not scriptable per-task without a race across
  // concurrent tasks). MODEL_EFFORT_SUPPORT.gemini is empty for every model
  // so the picker collapses; this default is unused but kept for symmetry.
  "gemini": "high",
  // fx has no per-invocation effort/reasoning flag (its models are routed
  // through the Vercel AI Gateway verbatim, with no CLI-level effort knob).
  // MODEL_EFFORT_SUPPORT.fx is empty for every model so the picker collapses;
  // this default is unused but kept for symmetry.
  "fx": "high",
};

export const CURSOR_MODEL_SPECS: Record<string, CursorModelSpec> = {
  // Ids verified against `cursor-agent models` (CLI 2026.08.11): grok 4.6 ships
  // as cursor-grok-4.6-{low,medium,high,xhigh} plus -fast variants of all four —
  // no bare id, no max tier, no 1M/Max-Mode variant. The unsuffixed "Cursor
  // Grok 4.6" label is the high tier, same convention as 4.5.
  "cursor-grok-4.6": {
    label: "Cursor Grok 4.6",
    hint: "Recommended default — Cursor-hosted Grok 4.6.",
    effortIds: {
      xhigh: "cursor-grok-4.6-xhigh",
      high: "cursor-grok-4.6-high",
      medium: "cursor-grok-4.6-medium",
      low: "cursor-grok-4.6-low",
    },
    fastEfforts: ["xhigh", "high", "medium", "low"],
  },
  "auto": { label: "Auto", hint: "Cursor picks the model." },
  "gpt-5.3-codex": {
    label: "Codex 5.3",
    hint: "Cursor-hosted Codex 5.3.",
    supportsMaxMode: true,
    effortIds: {
      xhigh: "gpt-5.3-codex-xhigh",
      high: "gpt-5.3-codex-high",
      medium: "gpt-5.3-codex",
      low: "gpt-5.3-codex-low",
    },
    fastEfforts: ["xhigh", "high", "medium", "low"],
  },
  "cursor-grok-4.5": {
    label: "Cursor Grok 4.5",
    hint: "Cursor-hosted Grok model.",
    effortIds: {
      high: "cursor-grok-4.5-high",
      medium: "cursor-grok-4.5-medium",
      low: "cursor-grok-4.5-low",
    },
    fastEfforts: ["high", "medium", "low"],
  },
  "composer-2.5": {
    label: "Composer 2.5",
    hint: "Cursor's own fast agentic model.",
    fastId: "composer-2.5-fast",
  },
  "claude-opus-5": {
    label: "Opus 5",
    hint: "Anthropic Opus 5 via Cursor.",
    supportsMaxMode: true,
    effortIds: {
      max: "claude-opus-5-thinking-max",
      xhigh: "claude-opus-5-thinking-xhigh",
      high: "claude-opus-5-thinking-high",
      medium: "claude-opus-5-thinking-medium",
      low: "claude-opus-5-thinking-low",
    },
    fastEfforts: ["max", "xhigh", "high", "medium", "low"],
  },
  "claude-opus-4-8": {
    label: "Opus 4.8",
    hint: "Anthropic Opus 4.8 via Cursor.",
    supportsMaxMode: true,
    effortIds: {
      max: "claude-opus-4-8-max",
      xhigh: "claude-opus-4-8-xhigh",
      high: "claude-opus-4-8-high",
      medium: "claude-opus-4-8-medium",
      low: "claude-opus-4-8-low",
    },
    fastEfforts: ["max", "xhigh", "high", "medium", "low"],
  },
  "gpt-5.6-sol": {
    label: "GPT-5.6 Sol",
    hint: "Cursor-hosted GPT-5.6 Sol.",
    supportsMaxMode: true,
    effortIds: {
      max: "gpt-5.6-sol-max",
      xhigh: "gpt-5.6-sol-xhigh",
      high: "gpt-5.6-sol-high",
      medium: "gpt-5.6-sol-medium",
      low: "gpt-5.6-sol-low",
      none: "gpt-5.6-sol-none",
    },
    fastEfforts: ["max", "xhigh", "high", "medium", "low", "none"],
  },
  "gpt-5.5": {
    label: "GPT-5.5",
    hint: "OpenAI GPT-5.5 via Cursor.",
    supportsMaxMode: true,
    effortIds: {
      xhigh: "gpt-5.5-extra-high",
      high: "gpt-5.5-high",
      medium: "gpt-5.5-medium",
      low: "gpt-5.5-low",
      none: "gpt-5.5-none",
    },
    fastEfforts: ["xhigh", "high", "medium", "low", "none"],
  },
  "claude-fable-5": {
    label: "Fable 5",
    hint: "Anthropic Fable 5 via Cursor.",
    supportsMaxMode: true,
    effortIds: {
      max: "claude-fable-5-max",
      xhigh: "claude-fable-5-xhigh",
      high: "claude-fable-5-high",
      medium: "claude-fable-5-medium",
      low: "claude-fable-5-low",
    },
  },
  "claude-sonnet-5": {
    label: "Sonnet 5",
    hint: "Anthropic Sonnet 5 via Cursor.",
    supportsMaxMode: true,
    effortIds: {
      max: "claude-sonnet-5-max",
      xhigh: "claude-sonnet-5-xhigh",
      high: "claude-sonnet-5-high",
      medium: "claude-sonnet-5-medium",
      low: "claude-sonnet-5-low",
    },
  },
  "gpt-5.6-terra": {
    label: "GPT-5.6 Terra",
    hint: "Cursor-hosted GPT-5.6 Terra.",
    supportsMaxMode: true,
    effortIds: {
      max: "gpt-5.6-terra-max",
      xhigh: "gpt-5.6-terra-xhigh",
      high: "gpt-5.6-terra-high",
      medium: "gpt-5.6-terra-medium",
      low: "gpt-5.6-terra-low",
      none: "gpt-5.6-terra-none",
    },
    fastEfforts: ["max", "xhigh", "high", "medium", "low", "none"],
  },
  "claude-4.6-sonnet": {
    label: "Sonnet 4.6",
    hint: "Anthropic Sonnet 4.6 via Cursor.",
    supportsMaxMode: true,
    effortIds: { medium: "claude-4.6-sonnet-medium" },
  },
  "claude-opus-4-7": {
    label: "Opus 4.7",
    hint: "Anthropic Opus 4.7 via Cursor.",
    supportsMaxMode: true,
    effortIds: {
      max: "claude-opus-4-7-max",
      xhigh: "claude-opus-4-7-xhigh",
      high: "claude-opus-4-7-high",
      medium: "claude-opus-4-7-medium",
      low: "claude-opus-4-7-low",
    },
    fastEfforts: ["max", "xhigh", "high", "medium", "low"],
  },
  "gpt-5.4": {
    label: "GPT-5.4",
    hint: "OpenAI GPT-5.4 via Cursor.",
    supportsMaxMode: true,
    effortIds: {
      xhigh: "gpt-5.4-xhigh",
      high: "gpt-5.4-high",
      medium: "gpt-5.4-medium",
      low: "gpt-5.4-low",
    },
    fastEfforts: ["xhigh", "high", "medium"],
  },
  "claude-4.6-opus": {
    label: "Opus 4.6",
    hint: "Anthropic Opus 4.6 via Cursor.",
    supportsMaxMode: true,
    effortIds: { max: "claude-4.6-opus-max", high: "claude-4.6-opus-high" },
  },
  "claude-4.5-opus": {
    label: "Opus 4.5",
    hint: "Anthropic Opus 4.5 via Cursor.",
    supportsMaxMode: true,
    effortIds: { high: "claude-4.5-opus-high" },
  },
  "gpt-5.2": {
    label: "GPT-5.2",
    hint: "OpenAI GPT-5.2 via Cursor.",
    effortIds: {
      xhigh: "gpt-5.2-xhigh",
      high: "gpt-5.2-high",
      medium: "gpt-5.2",
      low: "gpt-5.2-low",
    },
    fastEfforts: ["xhigh", "high", "medium", "low"],
  },
  "gpt-5.6-luna": {
    label: "GPT-5.6 Luna",
    hint: "Cursor-hosted GPT-5.6 Luna.",
    supportsMaxMode: true,
    effortIds: {
      max: "gpt-5.6-luna-max",
      xhigh: "gpt-5.6-luna-xhigh",
      high: "gpt-5.6-luna-high",
      medium: "gpt-5.6-luna-medium",
      low: "gpt-5.6-luna-low",
      none: "gpt-5.6-luna-none",
    },
    fastEfforts: ["max", "xhigh", "high", "medium", "low", "none"],
  },
  "gemini-3.6-flash": {
    label: "Gemini 3.6 Flash",
    hint: "Google Gemini 3.6 Flash via Cursor.",
    effortIds: {
      high: "gemini-3.6-flash-high",
      medium: "gemini-3.6-flash-medium",
      low: "gemini-3.6-flash-low",
      minimal: "gemini-3.6-flash-minimal",
    },
  },
  "gemini-3.1-pro": { label: "Gemini 3.1 Pro", hint: "Google Gemini 3.1 Pro via Cursor." },
  "gpt-5.4-mini": {
    label: "GPT-5.4 Mini",
    hint: "OpenAI GPT-5.4 Mini via Cursor.",
    effortIds: {
      xhigh: "gpt-5.4-mini-xhigh",
      high: "gpt-5.4-mini-high",
      medium: "gpt-5.4-mini-medium",
      low: "gpt-5.4-mini-low",
      none: "gpt-5.4-mini-none",
    },
  },
  "gpt-5.4-nano": {
    label: "GPT-5.4 Nano",
    hint: "OpenAI GPT-5.4 Nano via Cursor.",
    effortIds: {
      xhigh: "gpt-5.4-nano-xhigh",
      high: "gpt-5.4-nano-high",
      medium: "gpt-5.4-nano-medium",
      low: "gpt-5.4-nano-low",
      none: "gpt-5.4-nano-none",
    },
  },
  "claude-4.5-sonnet": { label: "Sonnet 4.5", hint: "Anthropic Sonnet 4.5 via Cursor.", supportsMaxMode: true },
  "gpt-5.1": {
    label: "GPT-5.1",
    hint: "OpenAI GPT-5.1 via Cursor.",
    effortIds: { high: "gpt-5.1-high", medium: "gpt-5.1", low: "gpt-5.1-low" },
  },
  "gemini-3-flash": { label: "Gemini 3 Flash", hint: "Google Gemini 3 Flash via Cursor." },
  "gemini-3.5-flash": { label: "Gemini 3.5 Flash", hint: "Google Gemini 3.5 Flash via Cursor." },
  "claude-4-sonnet": {
    label: "Sonnet 4",
    hint: "Anthropic Sonnet 4 via Cursor.",
    effortIds: { high: "claude-4-sonnet-thinking", none: "claude-4-sonnet" },
  },
  "gpt-5-mini": { label: "GPT-5 Mini", hint: "OpenAI GPT-5 Mini via Cursor." },
  "kimi-k3": {
    label: "Kimi K3",
    hint: "Kimi K3 via Cursor.",
    supportsMaxMode: true,
    effortIds: { max: "kimi-k3-max", high: "kimi-k3-high", low: "kimi-k3-low" },
  },
  "kimi-k2.7-code": { label: "Kimi K2.7 Code", hint: "Kimi K2.7 Code via Cursor." },
  "glm-5.2": {
    label: "GLM 5.2",
    hint: "GLM 5.2 via Cursor.",
    effortIds: { max: "glm-5.2-max", high: "glm-5.2-high" },
  },
};

export function cursorModelSupportsFast(model: string | null, effort: string | null): boolean {
  const spec = CURSOR_MODEL_SPECS[model ?? DEFAULT_MODEL.cursor];
  if (!spec) return false;
  if (spec.fastId && !spec.effortIds) return true;
  if (!effort) return false;
  return spec.fastEfforts?.includes(effort) ?? false;
}

export function cursorModelSupportsMaxMode(model: string | null): boolean {
  return CURSOR_MODEL_SPECS[model ?? DEFAULT_MODEL.cursor]?.supportsMaxMode === true;
}

export function cursorModelIdCoveredByCatalog(id: string): boolean {
  if (CURSOR_MODEL_SPECS[id]) return true;
  return Object.values(CURSOR_MODEL_SPECS).some((spec) => {
    if (spec.fastId === id) return true;
    return Object.values(spec.effortIds ?? {}).some((variant) => variant === id || `${variant}-fast` === id);
  });
}

export function cursorModelArg(model: string, effort: string | null, fast: boolean, maxMode = false): string {
  const spec = CURSOR_MODEL_SPECS[model];
  if (!spec) return model;
  if (!spec.effortIds) {
    const baseId = fast && spec.fastId ? spec.fastId : model;
    return maxMode && spec.supportsMaxMode ? `${baseId}[context=1m]` : baseId;
  }
  const desiredEffort =
    effort && spec.effortIds[effort]
      ? effort
      : DEFAULT_EFFORT.cursor && spec.effortIds[DEFAULT_EFFORT.cursor]
        ? DEFAULT_EFFORT.cursor
        : Object.keys(spec.effortIds)[0];
  if (!desiredEffort) return model;
  const baseId = spec.effortIds[desiredEffort] ?? model;
  if (maxMode && spec.supportsMaxMode) {
    const params = [`context=1m`, `effort=${desiredEffort}`];
    if (cursorModelSupportsFast(model, desiredEffort)) params.push(`fast=${fast ? "true" : "false"}`);
    return `${model}[${params.join(",")}]`;
  }
  return fast && spec.fastEfforts?.includes(desiredEffort) ? `${baseId}-fast` : baseId;
}

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
 * per call. Agetor is non-invasive: it installs no PreToolUse hook and no
 * MCP server, so AskUserQuestion / ExitPlanMode / tool-permission prompts
 * all run natively in the tmux pane and are surfaced through the scraper.
 * `bypass` is the explicit pure `--dangerously-skip-permissions` mode.
 */
export const CODE_PLAN_MODE: Record<AgentKind, { code: string; plan: string }> = {
  "claude-code": { code: "auto", plan: "plan" },
  "codex": { code: "auto", plan: "ask" },
  // Cursor has no first-class plan mode either — same posture as codex:
  // Plan routes to "ask" (propose-only; cursor cannot execute unapproved
  // actions headlessly).
  "cursor": { code: "auto", plan: "ask" },
  // Gemini's `--approval-mode plan` is a real read-only mode (verified via
  // `gemini --help` on CLI 0.54.0), closer to claude's native `plan` than
  // codex's read-only-sandbox stand-in — but reuse codex's "ask" id since
  // AGENT_OPTIONS.gemini.modes below labels it the same "Read-only" way.
  "gemini": { code: "auto", plan: "ask" },
  // fx has three of its own permission modes (yolo/auto/ask — see
  // AGENT_OPTIONS.fx.modes below). Like every other kind, Code resolves to
  // modes[0] — "auto" (fx's LLM auto-review resolves most tool calls;
  // anything unresolved surfaces as an approval card) — the
  // hands-off-but-reviewed default, not "yolo" (permission checks disabled
  // entirely): a Plan→Code pill round-trip must not escalate a task past
  // what it started at. "yolo" stays reachable only as an explicit picker
  // choice. Plan resolves to "ask" (only pre-approved rules run; everything
  // else surfaces as an approval card).
  "fx": { code: "auto", plan: "ask" },
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
 * `none` is currently used only by GPT-5.6-family Codex models.
 */
export const EFFORT_OPTIONS: AgentOption[] = [
  { id: "max", label: "Max thinking", hint: "Absolute maximum reasoning effort. Separate from Cursor Max Mode context." },
  { id: "xhigh", label: "Extra high", hint: "Extended capability for long-horizon work. Fable 5 / Mythos 5 / Opus 5 / 4.8 / 4.7 / 4.6 / Sonnet 5 / codex." },
  { id: "high", label: "High", hint: "Deep reasoning. The API default where supported." },
  { id: "medium", label: "Medium", hint: "Balanced speed vs. capability." },
  { id: "low", label: "Low", hint: "Most efficient. Best for simple tasks." },
  { id: "minimal", label: "Minimal", hint: "Smallest reasoning budget where Cursor exposes it." },
  { id: "none", label: "No thinking", hint: "Skip thinking where the model exposes a no-thinking variant." },
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
 *     GPT-5.6 family → none/low/medium/high/xhigh/max
 *     gpt-5.5 / gpt-5 / gpt-5-codex → low/medium/high/xhigh
 *
 * An empty list means "this model does not accept the effort flag at all"
 * (e.g. Haiku 4.5) — the UI collapses the dropdown and `buildCommand` emits
 * no env var / `-c` flag for that case.
 */
export const MODEL_EFFORT_SUPPORT: Record<AgentKind, Record<string, string[]>> = {
  // Per https://platform.claude.com/docs/en/build-with-claude/effort the
  // effort parameter is API-supported on Fable 5 / Mythos 5 / Opus 5 / 4.8 /
  // 4.7 / 4.6 / Sonnet 5 / Sonnet 4.6 / Opus 4.5 (xhigh is Fable-5-, Mythos-5-,
  // Opus-, and Sonnet-5-only; Sonnet 4.6 has no xhigh; Haiku 4.5 doesn't
  // support effort at all). The `/effort` CLI command accepts more
  // levels but the underlying API request would fail for unsupported pairs,
  // so we filter at the picker rather than letting the user fire bad runs.
  "claude-code": {
    // Mythos 5 shares Fable 5's request surface (same underlying model).
    "mythos-5": ["max", "xhigh", "high", "medium", "low"],
    // Fable 5 shares Opus 4.7/4.8's request surface (effort low→max, xhigh).
    "fable-5": ["max", "xhigh", "high", "medium", "low"],
    // Opus 5 supports the full effort ladder incl. xhigh (per claude-api skill).
    "opus-5": ["max", "xhigh", "high", "medium", "low"],
    "opus-4.8": ["max", "xhigh", "high", "medium", "low"],
    "opus-4.7": ["max", "xhigh", "high", "medium", "low"],
    "opus-4.6": ["max", "xhigh", "high", "medium", "low"],
    // Sonnet 5 is the first Sonnet-tier model with xhigh (full low→max range).
    "sonnet-5": ["max", "xhigh", "high", "medium", "low"],
    "sonnet-4.6": ["max", "high", "medium", "low"],
    // Haiku 4.5 doesn't support the effort parameter — `supportedEfforts`
    // returns `[]` and the picker disables itself.
    "haiku-4.5": [],
  },
  codex: {
    // Cyber's own model page doesn't enumerate efforts; assume the GPT-5.6
    // family surface (the set Sol documents). Revisit if codex rejects none/max.
    "gpt-5.6-cyber": ["max", "xhigh", "high", "medium", "low", "none"],
    "gpt-5.6-sol": ["max", "xhigh", "high", "medium", "low", "none"],
    "gpt-5.6-terra": ["max", "xhigh", "high", "medium", "low", "none"],
    "gpt-5.6-luna": ["max", "xhigh", "high", "medium", "low", "none"],
    "gpt-5.5": ["xhigh", "high", "medium", "low"],
    "gpt-5": ["xhigh", "high", "medium", "low"],
    "gpt-5-codex": ["xhigh", "high", "medium", "low"],
  },
  cursor: Object.fromEntries(
    Object.entries(CURSOR_MODEL_SPECS).map(([id, spec]) => [
      id,
      spec.effortIds ? EFFORT_OPTIONS.map((o) => o.id).filter((effort) => Boolean(spec.effortIds?.[effort])) : [],
    ]),
  ) as Record<string, string[]>,
  // Empty for every model: gemini has no per-invocation effort flag (see
  // DEFAULT_EFFORT.gemini comment above). supportedEfforts() falls back to
  // [] for any model key here, which collapses the effort picker in the UI —
  // the same treatment claude-code's haiku-4.5 gets.
  gemini: {
    "gemini-3-pro-preview": [],
    "gemini-3.1-pro-preview": [],
    "gemini-2.5-pro": [],
    "gemini-3.7-flash": [],
    "gemini-3.5-flash": [],
    "gemini-2.5-flash": [],
  },
  // Empty for every model: fx has no per-invocation effort/reasoning flag —
  // its models route through the Vercel AI Gateway verbatim with no CLI-level
  // knob to tune. Same treatment as gemini above.
  fx: {
    "moonshotai/kimi-k3": [],
    "moonshotai/kimi-k3-fast": [],
    "zai/glm-5.2-fast": [],
    "anthropic/claude-opus-5": [],
    "anthropic/claude-sonnet-5": [],
    "openai/gpt-5.5": [],
    "google/gemini-3.1-pro-preview": [],
  },
};

/**
 * Effort options the picker should show for a given (agent, model). Returns
 * an empty list when the model doesn't accept the effort flag (Haiku 4.5).
 * Unknown model ids fall back to the agent's `DEFAULT_MODEL` support set so a
 * user-pasted future model still gets a sensible picker — except for cursor,
 * where effort is encoded in the model id itself (`cursorModelArg`): an
 * unknown cursor id passes through verbatim, so any effort picked for it
 * would silently never reach the CLI. Those report no efforts instead.
 * Returned in the EFFORT_OPTIONS order (highest → lowest).
 */
export function supportedEfforts(agent: AgentKind, model: string | null): AgentOption[] {
  if (agent === "cursor" && model !== null && !(model in MODEL_EFFORT_SUPPORT.cursor)) return [];
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
    "mythos-5": [],
    "fable-5": [],
    "opus-5": [],
    "opus-4.8": [],
    "opus-4.7": [],
    "opus-4.6": [],
    "sonnet-5": [],
    "sonnet-4.6": [],
    "haiku-4.5": [],
  },
  codex: {},
  // No per-model mode carve-outs for cursor either — both modes it exposes
  // (auto/ask) are universally available across its model list.
  cursor: {},
  gemini: {},
  fx: {},
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
      { id: "mythos-5", label: "Mythos 5", hint: "Fable 5's twin — same capability and cost; requires approved-org (Project Glasswing) access. Uses 2x the usage of Opus." },
      { id: "fable-5", label: "Fable 5", hint: "Most powerful tier — above Opus. Uses 2x the usage of Opus." },
      { id: "opus-5", label: "Opus 5", hint: "Most capable Opus; same usage cost as 4.8." },
      { id: "opus-4.8", label: "Opus 4.8", hint: "Prior Opus flagship." },
      { id: "opus-4.7", label: "Opus 4.7", hint: "Prior flagship; same effort range as 4.8." },
      { id: "opus-4.6", label: "Opus 4.6", hint: "Earlier Opus generation." },
      { id: "sonnet-5", label: "Sonnet 5", hint: "Near-Opus quality on coding/agentic work at Sonnet cost." },
      { id: "sonnet-4.6", label: "Sonnet 4.6", hint: "Prior Sonnet generation." },
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
      { id: "gpt-5.6-cyber", label: "GPT-5.6 Cyber", hint: "Cybersecurity-tuned GPT-5.6. Requires OpenAI Daybreak approval on an API-key account; rejected on ChatGPT plans." },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", hint: "Recommended default — flagship GPT-5.6 capability." },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", hint: "Balanced GPT-5.6 model for strong performance at lower cost." },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", hint: "Efficient GPT-5.6 model for high-volume workloads." },
      { id: "gpt-5.5", label: "GPT-5.5", hint: "Previous recommended default — works on ChatGPT plans." },
      { id: "gpt-5-codex", label: "GPT-5 Codex", hint: "Requires an API-key account; rejected on ChatGPT plans." },
      { id: "gpt-5", label: "GPT-5", hint: "Requires an API-key account; rejected on ChatGPT plans." },
    ],
    modes: [
      { id: "auto", label: "Auto (workspace-write)", hint: "Edit files without approval prompts." },
      { id: "ask", label: "Read-only", hint: "Inspect only — codex can't modify files (read-only sandbox)." },
    ],
    efforts: EFFORT_OPTIONS,
  },
  cursor: {
    models: Object.entries(CURSOR_MODEL_SPECS).map(([id, spec]) => ({
      id,
      label: spec.label,
      hint: spec.hint,
    })),
    modes: [
      { id: "auto", label: "Auto (force)", hint: "Hands-off — runs with --force, executing edits and commands without approval prompts." },
      { id: "ask", label: "Read-only", hint: "Propose-only — cursor cannot execute unapproved actions headlessly." },
    ],
    efforts: EFFORT_OPTIONS,
  },
  gemini: {
    // Pro tier first, then Flash tier; newest first within each tier.
    models: [
      { id: "gemini-3-pro-preview", label: "Gemini 3 Pro (preview)", hint: "Recommended default — current flagship." },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)", hint: "Newer preview tier." },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", hint: "Prior stable flagship." },
      { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", hint: "Latest and most capable Flash — strong on coding and agentic work at Flash cost." },
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", hint: "Fast, lower cost — prior Flash generation." },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "Fast, lower cost, earlier generation." },
    ],
    modes: [
      { id: "auto", label: "Auto (yolo)", hint: "Edit files without approval prompts (--yolo)." },
      { id: "ask", label: "Read-only", hint: "Inspect only — gemini can't modify files (--approval-mode plan)." },
    ],
    // No model in MODEL_EFFORT_SUPPORT.gemini accepts the effort flag, so the
    // picker collapses for every model — see EFFORT_OPTIONS list comment.
    efforts: EFFORT_OPTIONS,
  },
  fx: {
    // Vercel AI Gateway ids, passed verbatim.
    models: [
      { id: "moonshotai/kimi-k3", label: "Kimi K3", hint: "fx's compiled default since 0.0.6 — Fast mode." },
      { id: "moonshotai/kimi-k3-fast", label: "Kimi K3 Fast", hint: "Fast variant of fx's default." },
      { id: "zai/glm-5.2-fast", label: "GLM 5.2 Fast", hint: "Cheap, fast tier via the Gateway." },
      { id: "anthropic/claude-opus-5", label: "Claude Opus 5", hint: "Anthropic's top tier via the Gateway." },
      { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", hint: "Anthropic's fast flagship via the Gateway." },
      { id: "openai/gpt-5.5", label: "GPT-5.5", hint: "OpenAI flagship via the Gateway." },
      { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview", hint: "Google flagship via the Gateway." },
    ],
    modes: [
      { id: "auto", label: "Auto", hint: "fx's LLM auto-review resolves most tool calls; anything unresolved surfaces as an approval card." },
      { id: "yolo", label: "Yolo", hint: "Disables fx permission checks — full access." },
      { id: "ask", label: "Read-only-ish", hint: "Only pre-approved rules run; everything else surfaces as an approval card." },
    ],
    // No model in MODEL_EFFORT_SUPPORT.fx accepts the effort flag, so the
    // picker collapses for every model — see EFFORT_OPTIONS list comment.
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
   * Name of the tmux session that hosted this run's REPL (claude-code) or
   * one-shot `codex exec` turn (codex). For claude it's the same value across
   * every run for a task (one persistent session); for codex each turn spawns
   * a fresh session that shares the per-task name. NULL for pre-migration
   * legacy rows.
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
  /**
   * Codex's own conversation/thread id (the `thread_id` from its `--json`
   * stream's `thread.started` event). Captured when the codex tmux driver
   * tails the run's JSONL log. Drives `codex exec resume <thread_id>` for
   * follow-up turns and is the reattach key for a mid-turn codex run. NULL
   * for claude-code and legacy rows.
   */
  codexSessionId: string | null;
  /**
   * Cursor's own conversation/session id (the `session_id` carried on every
   * event in its `--output-format stream-json` NDJSON stream, first seen on
   * `system/init`). Captured when the cursor tmux driver tails the run's
   * NDJSON log. Drives `cursor-agent --resume <session_id>` for follow-up
   * turns and is the reattach key for a mid-turn cursor run. NULL for
   * claude-code/codex and legacy rows.
   */
  cursorSessionId: string | null;
  /**
   * Gemini CLI's own per-session uuid — self-issued by agetor (not
   * discovered from the CLI) and passed as `--session-id` on the first turn,
   * `--resume` on every follow-up. Captured synchronously at spawn time
   * (mirrors claude's pre-generated-uuid pattern), unlike codex's
   * discovered-from-an-event `codexSessionId`. NULL for claude-code/codex
   * and legacy rows.
   */
  geminiSessionId: string | null;
  /**
   * fx's own conversation/session id — DISCOVERED (not pre-generated), the
   * ACP `session/new` result's `sessionId`. Captured by the fx-acp driver and
   * persisted for `session/resume` on follow-up turns, mirroring codex's
   * discovered-from-an-event `codexSessionId` rather than gemini's
   * self-issued-uuid pattern. NULL for every other agent kind and legacy rows.
   */
  fxSessionId: string | null;
  /**
   * How this run came to exist. `null`/undefined = user-initiated (Run
   * button, a follow-up message typed into the panel — every run before
   * this field existed). `"continuation"` = opened automatically by the
   * orchestrator after the same claude session auto-resumed post `end_turn`
   * (e.g. it delegated to a background task and later kept talking once
   * that task finished). Optional so callers that don't pass it (most of
   * them — only the continuation-run factory sets it) keep compiling
   * unchanged; DB rows predating migration 023 read back as null.
   */
  origin?: "continuation" | null;
}

/** One changed file in a task's git diff (worktree vs its pinned base). */
export interface DiffFile {
  /** Repo-relative path of the file in its new state. */
  path: string;
  /** Previous path for renames; null otherwise. */
  oldPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed";
  /** Lines added (`+`) in this file's hunks. 0 for binary. */
  additions: number;
  /** Lines removed (`-`) in this file's hunks. 0 for binary. */
  deletions: number;
  /** True when git reports the file as binary (no textual hunks). */
  binary: boolean;
  /**
   * Unified-diff body for this file (the `@@ … @@` hunks, without the
   * `diff --git` header). Empty for binary files. May be truncated — see
   * `truncated`.
   */
  hunks: string;
  /** True when `hunks` was cut off because the file's diff was very large. */
  truncated: boolean;
}

/**
 * A task's git diff: everything its worktree changed relative to the pinned
 * base ref (committed + uncommitted + newly created files). Returned by
 * `GET /tasks/:id/diff`.
 */
export interface TaskDiff {
  /** Short base sha the diff is computed against, or null when not applicable. */
  base: string | null;
  files: DiffFile[];
  /**
   * Friendly explanation when there's nothing to show — e.g. the task has no
   * worktree yet, isolation is off, or the worktree is clean. Absent when
   * `files` is non-empty.
   */
  note?: string;
}

export type GitHubItemKind = "pulls" | "issues";
export type GitHubItemState = "open" | "closed" | "all";

export interface GitHubLabel {
  name: string;
  color: string | null;
}

/** A repository label as returned by the labels-management endpoints (carries a
 *  description, unlike the lighter GitHubLabel embedded in an item). `color` is
 *  6-hex without a leading `#`. */
export interface GitHubRepoLabel {
  name: string;
  color: string;
  description: string;
}

export interface GitHubLabelsResult {
  repo: string;
  labels: GitHubRepoLabel[];
}

export interface GitHubUser {
  login: string;
  avatarUrl: string | null;
  htmlUrl: string | null;
}

export interface GitHubAssigneesResult {
  repo: string;
  assignees: GitHubUser[];
}

export interface GitHubMilestone {
  number: number;
  title: string;
}

/** A repository milestone as returned by the milestone-management endpoints
 *  (carries state, description, due date and issue counts, unlike the lighter
 *  GitHubMilestone embedded in an item). `dueOn` is an ISO8601 string or null. */
export interface GitHubRepoMilestone {
  number: number;
  title: string;
  state: "open" | "closed";
  description: string;
  dueOn: string | null;
  openIssues: number;
  closedIssues: number;
  htmlUrl: string;
}

export interface GitHubMilestonesResult {
  repo: string;
  milestones: GitHubRepoMilestone[];
}

export interface GitHubListItem {
  kind: GitHubItemKind;
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  htmlUrl: string;
  author: GitHubUser | null;
  assignees: GitHubUser[];
  milestone: GitHubMilestone | null;
  body: string;
  labels: GitHubLabel[];
  comments: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Set (to a timestamp) only for a merged pull request; null otherwise —
   *  lets the UI distinguish a merged PR from a closed-unmerged one, which the
   *  `state: "closed"` value alone conflates. Always null for issues. */
  mergedAt: string | null;
  /** Whether the conversation is locked (REST `locked` field). Applies to both
   *  issues and pull requests — GitHub locks both through the same
   *  `/issues/:number/lock` endpoint. Defaults to `false` when the source
   *  response omits the field (some list paths do). */
  locked: boolean;
  /** Local filesystem path of the project this item came from (G8, multi-repo
   *  aggregation). Single-repo listing sets this to that repo's dir; every
   *  per-item action resolves `item.sourcePath ?? projectPath` so writes land
   *  on the correct repo even when the list aggregates several. Null only for
   *  items normalized without a known dir (shouldn't happen in practice —
   *  every list/action call site threads one through). */
  sourcePath: string | null;
}

/** Rate-limit snapshot parsed from a GitHub API response's `x-ratelimit-*`
 *  headers (see `parseRateLimit` in `src/bun/github.ts`). `resource` is
 *  GitHub's own bucket name (e.g. "core" or "search" — the Search API has a
 *  much tighter ~30/min budget than the ~5000/hr core budget). */
export interface GitHubRateLimit {
  remaining: number;
  limit: number;
  resource: string;
}

/** The viewer's permission level on a repo, from `GET /repos/:o/:r`'s
 *  `permissions` object. Drives push-only-control gating (F13) — `push` is
 *  the one the UI cares about; `admin`/`maintain` ride along for future use.
 *  Unauthenticated (no token) resolves to all-false rather than erroring,
 *  mirroring `getGitHubViewer`'s no-token behavior. */
export interface GitHubRepoPermissions {
  push: boolean;
  admin: boolean;
  maintain: boolean;
}

export interface GitHubListResult {
  /** Single-repo mode: "owner/name". Aggregate mode (G8): a display summary
   *  like "3 repositories" — see `repos` for the actual slugs. */
  repo: string;
  /** Null in aggregate mode (G8) — there's no single repo to open. */
  webUrl: string | null;
  auth: "token" | "none";
  items: GitHubListItem[];
  /** Page number this result represents — mirrors the request's `page`
   *  (defaults to 1). Used by the "Load more" flow to request `page + 1`.
   *  Aggregate mode (G8) always reports page 1 — "Load more" is disabled. */
  page: number;
  /** True when another page is available beyond this one — derived from the
   *  REST `link: rel="next"` header, or from the Search API's `total_count`
   *  (capped at GitHub's 1000-result search ceiling). In aggregate mode (G8)
   *  this instead means "at least one aggregated repo had more than the
   *  first page fetched" (the merged list is truncated to one page per repo). */
  hasMore: boolean;
  /** Rate-limit snapshot from the headers of the response that produced this
   *  page, or null when the headers were absent. Aggregate mode (G8) reports
   *  the tightest-remaining snapshot across the fanned-out per-repo calls. */
  rateLimit: GitHubRateLimit | null;
  /** Aggregate mode only (G8): the resolved "owner/name" slug of every repo
   *  whose fetch succeeded (dirs without a GitHub remote, or that otherwise
   *  failed, are silently skipped). Undefined in single-repo mode. */
  repos?: string[];
}

export interface GitHubComment {
  id: number;
  body: string;
  htmlUrl: string;
  author: GitHubUser | null;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubPullLineComment extends GitHubComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
}

export interface GitHubCommentsResult {
  repo: string;
  itemNumber: number;
  comments: GitHubComment[];
}

export interface GitHubPullReviewCommentsResult {
  repo: string;
  pullNumber: number;
  comments: GitHubPullLineComment[];
}

/** A resolvable review-comment thread (from GraphQL). `rootCommentId` is the
 *  REST databaseId of the thread's first comment, so the UI can match a thread
 *  to a comment in the flat review-comments list. */
export interface GitHubReviewThread {
  threadId: string;
  rootCommentId: number;
  isResolved: boolean;
  isOutdated: boolean;
}

export interface GitHubPullReviewThreadsResult {
  repo: string;
  pullNumber: number;
  threads: GitHubReviewThread[];
  /** True when GitHub reported more than the first page of review threads, so
   *  the resolve controls only cover the first 100. */
  truncated: boolean;
}

export interface GitHubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface GitHubChecksResult {
  repo: string;
  pullNumber: number;
  sha: string;
  checkRuns: GitHubCheckRun[];
}

/** A single context entry in a commit's combined status (`GET
 *  /commits/:ref/status`) — the legacy Status API, distinct from the
 *  check-runs `GitHubChecksResult` above (some CI providers still only post
 *  through this older API, so both are shown). */
export interface GitHubCommitStatusContext {
  context: string;
  state: string;
  description: string | null;
  targetUrl: string | null;
}

/** Normalized combined-status payload — the shape `normalizeCommitStatus`
 *  produces from the raw response, before the request-scoped `repo`/`ref`
 *  are stitched on at the call site (see `GitHubCommitStatusResult`). */
export interface GitHubCommitStatus {
  state: "success" | "pending" | "failure" | "error" | "";
  total: number;
  statuses: GitHubCommitStatusContext[];
}

export interface GitHubCommitStatusResult extends GitHubCommitStatus {
  repo: string;
  ref: string;
}

/** A single commit on a pull request, from `GET /pulls/:n/commits`.
 *  `messageHeadline` is the first line of the commit message; `author` prefers
 *  the top-level GitHub-user `author` (has a `login`) over the raw git author,
 *  falling back to null when the commit's author isn't a known GitHub user. */
export interface GitHubPullCommit {
  sha: string;
  messageHeadline: string;
  author: GitHubUser | null;
  authoredDate: string;
  htmlUrl: string;
}

export interface GitHubPullCommitsResult {
  repo: string;
  pullNumber: number;
  commits: GitHubPullCommit[];
}

/** A repository release, from `GET /repos/:o/:r/releases` (F18). `body` is
 *  the release notes markdown; `targetCommitish` is the branch/sha the tag
 *  was (or will be) cut from. */
export interface GitHubRelease {
  id: number;
  tagName: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  publishedAt: string | null;
  createdAt: string;
  htmlUrl: string;
  targetCommitish: string;
}

export interface GitHubReleasesResult {
  repo: string;
  releases: GitHubRelease[];
}

/** A repository tag, from `GET /repos/:o/:r/tags` — powers the release
 *  manager's tag-name datalist (F18). Tags aren't paginated per-repo scope in
 *  the UI, so this result carries no `repo` field (unlike the other list
 *  results here). */
export interface GitHubTag {
  name: string;
  commitSha: string;
}

export interface GitHubTagsResult {
  tags: GitHubTag[];
}

/** A single GitHub Actions workflow run, from `GET
 *  /repos/:o/:r/actions/runs` (F20). `status` is GitHub's coarse run state
 *  (`queued` | `in_progress` | `completed` | …); `conclusion` is only set
 *  once `status === "completed"` (`success` | `failure` | `cancelled` |
 *  `skipped` | `neutral` | `timed_out` | `action_required` | …), null while
 *  still running. */
export interface GitHubWorkflowRun {
  id: number;
  name: string;
  displayTitle: string;
  status: string;
  conclusion: string | null;
  event: string;
  headBranch: string;
  runNumber: number;
  htmlUrl: string;
  createdAt: string;
  workflowId: number;
}

export interface GitHubWorkflowRunsResult {
  repo: string;
  runs: GitHubWorkflowRun[];
}

/** A single workflow definition, from `GET /repos/:o/:r/actions/workflows`
 *  (F20) — powers the "run a workflow" dispatch picker. `state` is
 *  `active` | `disabled_manually` | … ; only `active` ones are dispatchable. */
export interface GitHubWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

export interface GitHubWorkflowsResult {
  workflows: GitHubWorkflow[];
}

/** An issue a pull request will close on merge (GraphQL
 *  `closingIssuesReferences`), read-only — surfaced as a "Closes: #N" line. */
export interface GitHubLinkedIssue {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
}

export interface GitHubLinkedIssuesResult {
  repo: string;
  pullNumber: number;
  issues: GitHubLinkedIssue[];
}

/** A child issue tracked under a parent via GitHub's sub-issues REST API
 *  (`/issues/:number/sub_issues`). `id` is the child's REST database id —
 *  distinct from its display `number` — because removing a sub-issue
 *  (`DELETE /issues/:number/sub_issue`) addresses the child by id, not
 *  number, so the UI needs it without a second round trip. */
export interface GitHubSubIssue {
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  htmlUrl: string;
}

export interface GitHubSubIssuesResult {
  repo: string;
  issueNumber: number;
  subIssues: GitHubSubIssue[];
}

/** A repo-linked GitHub Projects v2 board, from GraphQL
 *  `repository.projectsV2.nodes` (F21/G11). Projects v2 is GraphQL-only —
 *  there's no REST equivalent. `number` is the project's board number (used
 *  in its URL), distinct from the opaque GraphQL `id` every mutation keys on. */
export interface GitHubProjectV2 {
  id: string;
  number: number;
  title: string;
  url: string;
}

export interface GitHubProjectsV2Result {
  projects: GitHubProjectV2[];
}

/** A single-select field on a project (e.g. "Status"), with its selectable
 *  options. Non-select fields (text, number, date, iteration…) are not
 *  represented here — `options` is empty for any field this UI doesn't drive
 *  a dropdown for. */
export interface GitHubProjectField {
  id: string;
  name: string;
  options: { id: string; name: string }[];
}

/** A single item on a project board — an Issue, PullRequest, or DraftIssue
 *  (GraphQL `content.__typename`), plus its current value for the project's
 *  "Status" single-select field (if any). `number`/`title` come from the
 *  underlying content for Issue/PullRequest; a DraftIssue has no `number`
 *  (null) and its own `title`. `contentType: "other"` covers any future
 *  content type GraphQL might add that this UI doesn't special-case. */
export interface GitHubProjectItem {
  itemId: string;
  contentType: "Issue" | "PullRequest" | "DraftIssue" | "other";
  number: number | null;
  title: string;
  statusOptionId: string | null;
  statusOptionName: string | null;
}

/** `statusField` is the project's field named "Status" (if it's a
 *  single-select field) — the UI uses its `options` to populate each row's
 *  status dropdown. Null when the project has no such field, in which case
 *  the UI hides the status column entirely. */
export interface GitHubProjectItemsResult {
  items: GitHubProjectItem[];
  statusField: GitHubProjectField | null;
}

/** A GitHub Discussions thread (GraphQL-only — F22/G12). `answered` is derived
 *  from `isAnswered`/`answerChosenAt` — true once one of the thread's comments
 *  has been marked the accepted answer. `author` is null for a deleted
 *  account (GraphQL nulls the field rather than erroring). */
export interface GitHubDiscussion {
  id: string;
  number: number;
  title: string;
  url: string;
  category: string;
  author: string | null;
  createdAt: string;
  answered: boolean;
}

/** A Discussions category (e.g. "Q&A", "Announcements") — listed only to
 *  populate the create-discussion form's category picker. Scope decision A2:
 *  category *management* (create/edit/delete a category) is out of scope. */
export interface GitHubDiscussionCategory {
  id: string;
  name: string;
}

/** `auth` mirrors `GitHubListResult.auth`: discussions are readable without a
 *  token, but the UI gates create/comment/answer on `auth !== "none"` — any
 *  authenticated user can do those, not just someone with push access (G12
 *  gating note; distinct from every other manager panel, which gates writes
 *  on push). */
export interface GitHubDiscussionsResult {
  discussions: GitHubDiscussion[];
  categories: GitHubDiscussionCategory[];
  auth: "token" | "none";
}

/** A single comment on a discussion thread. `isAnswer` reflects whether GitHub
 *  currently has this comment marked as the discussion's accepted answer. */
export interface GitHubDiscussionComment {
  id: string;
  body: string;
  author: string | null;
  createdAt: string;
  isAnswer: boolean;
}

/** A discussion's full detail — body + comments. `answerable` reflects the
 *  discussion's *category* (`category.isAnswerable`, e.g. "Q&A" is answerable,
 *  "Announcements" isn't) — the UI hides the mark/unmark-answer control when
 *  false regardless of who's viewing. */
export interface GitHubDiscussionDetail {
  id: string;
  title: string;
  body: string;
  comments: GitHubDiscussionComment[];
  answerable: boolean;
}

/** GitHub's mergeability verdict for a PR, from `GET /pulls/:n`.
 *  `mergeable` is null while GitHub computes it in the background (poll again).
 *  `mergeableState` is GitHub's coarse status: clean | dirty (conflicts) |
 *  behind (base moved) | blocked (required reviews/checks) | unstable (checks
 *  pending/failing but mergeable) | draft | has_hooks | unknown.
 *  `autoMerge` reflects the REST `auto_merge` field (non-null once enabled). */
export interface GitHubPullMergeability {
  repo: string;
  pullNumber: number;
  mergeable: boolean | null;
  mergeableState: string;
  rebaseable: boolean | null;
  merged: boolean;
  draft: boolean;
  /** Normalized to `"open" | "closed" | "merged" | "unknown"` — provider
   *  state vocabularies collapsed onto one small set so callers don't need
   *  provider-specific branching. */
  state: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  autoMerge: boolean;
  /** Full `owner/name` of the repo the head branch lives in, or null when the
   *  REST payload omitted `head.repo` (e.g. the fork was deleted). */
  headRepo: string | null;
  /** True when the head branch lives on a different repo than the base (a
   *  fork PR), or when `headRepo` couldn't be determined at all — the
   *  "Resolve with Agetor" flow only supports same-repo PRs. */
  crossRepo: boolean;
}

export type GitHubPullReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
export type GitHubPullMergeMethod = "merge" | "squash" | "rebase";

export interface GitHubActionResult {
  ok: true;
  message?: string;
  commentPosted?: boolean;
}

export interface GitHubPullMergeResult extends GitHubActionResult {
  merged: boolean;
  sha: string | null;
}

export interface GitHubPullDefaultsResult {
  repo: string;
  head: string;
  base: string;
}

export type GitHubReactionContent = "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";

/** Discriminates which entity a reaction (or reaction list) targets. For `issue`,
 *  `id` is the issue/PR **number** — issues and PRs share the
 *  `/issues/:number/reactions` endpoint. `issueComment` / `reviewComment` carry a
 *  comment's REST id (`/issues/comments/:id` vs `/pulls/comments/:id`). */
export interface GitHubReactionSubject {
  type: "issue" | "issueComment" | "reviewComment";
  id: number;
}

/** One content's aggregated reaction count for a subject, plus the viewer's own
 *  reaction id (non-null only when the viewer has reacted with this content) so
 *  the UI can toggle a chip off via DELETE without a second lookup. */
export interface GitHubReactionSummary {
  content: GitHubReactionContent;
  count: number;
  viewerReactionId: number | null;
}

export interface GitHubReactionsResult {
  reactions: GitHubReactionSummary[];
}

/** A GitHub notification thread (`GET /notifications`), scoped to the current
 *  repo (F14). `subjectType` is GitHub's own subject kind ("PullRequest",
 *  "Issue", "Commit", "Discussion", …) — not narrowed to `GitHubItemKind`
 *  since notifications cover subjects the rest of the UI doesn't model.
 *  `subjectUrl`/`latestCommentUrl` are api.github.com URLs (or null); the UI
 *  opens whichever is present via `api.openExternal`. */
export interface GitHubNotification {
  id: string;
  unread: boolean;
  reason: string;
  updatedAt: string;
  title: string;
  subjectType: string;
  subjectUrl: string | null;
  /** Browsable HTML URL derived from `subjectUrl` (api.github.com → github.com),
   *  so the UI opens the page rather than the raw JSON. Null when not derivable. */
  htmlUrl: string | null;
  latestCommentUrl: string | null;
  repo: string;
}

export interface GitHubNotificationsResult {
  repo: string;
  notifications: GitHubNotification[];
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
 *   subagent     — background/sub-agent lifecycle delta (data = JSON
 *                  SubagentEvent). Live-only (never persisted to run_events):
 *                  the `/tasks/:id/subagents` snapshot covers panel reopen, so
 *                  this stream just keeps the open panel's tab strip in sync.
 *                  The subagent's actual transcript content rides the normal
 *                  user/assistant/tool_* streams, tagged via `subagentId`.
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
  | "tool_result"
  | "subagent";

/** Max number of persisted events `GET /tasks/:id/events` replays on SSE
 *  (re)connect — the most recent window; older history is fetched on demand
 *  via `GET /tasks/:id/events/page`. */
export const EVENTS_REPLAY_LIMIT = 800;

/** Max number of events the run panel keeps in webview memory for one task.
 *  When live streaming pushes past this, the oldest events are trimmed and the
 *  "Load earlier" affordance re-appears. */
export const EVENTS_WINDOW_MAX = 3000;

/** Named SSE event (`event: replay_meta`) sent as the FIRST frame of
 *  `GET /tasks/:id/events`, before the replayed window. Unnamed `message`
 *  listeners ignore it, so old clients are unaffected. */
export const TASK_EVENTS_REPLAY_META_EVENT = "replay_meta";

/** Payload of the {@link TASK_EVENTS_REPLAY_META_EVENT} frame. */
export interface TaskEventsReplayMeta {
  /** DB id of the earliest event included in the replayed window, or null when
   *  the task has no persisted events. */
  earliestId: number | null;
  /** True when older events exist before `earliestId` (drives "Load earlier"). */
  hasMore: boolean;
}

export interface RunEvent {
  runId: string;
  taskId: string;
  stream: RunEventStream;
  data: string;
  ts: number;
  /**
   * When set, this event belongs to a background/sub agent's stream rather than
   * the task's main agent stream (NULL/undefined = main). The run panel
   * partitions the unified event scrollback by this id to drive the read-only
   * per-subagent tabs. Threaded from `run_events.subagent_id`.
   */
  subagentId?: string | null;
  /**
   * `run_events.id`, present on replayed/paged persisted events (SSE replay
   * window, `/tasks/:id/events/page`); absent on live-broadcast frames, which
   * have no row yet at broadcast time.
   */
  id?: number;
}

/** Lifecycle state of a tracked background/sub agent. Mirrors `RunStatus` plus
 *  the subagent-specific transitions. */
export type SubagentStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "orphaned";

/**
 * A background / sub agent the main agent spawned, tracked so the run panel can
 * offer a read-only tab into its live stream. `parentKind` distinguishes:
 * an in-session Claude Code subagent (`"subagent"`); an independent `claude --bg`
 * session (`"bg_session"`); a Claude Code Workflow (`/workflow`) run's container
 * row (`"workflow"` — id = the workflow's background taskId, sourcePath = its
 * transcriptDir, no event stream of its own — exists to hold the task in
 * `running` for the workflow's lifetime); and one agent inside a workflow
 * (`"workflow_agent"` — a normal sidechain transcript rendered as a read-only
 * tab).
 */
export interface Subagent {
  /** Claude's agentId — the basename of `subagents/agent-<id>.jsonl`. */
  id: string;
  taskId: string;
  /** Parent run that was in flight when this subagent was spawned. */
  runId: string | null;
  parentKind: "subagent" | "bg_session" | "workflow" | "workflow_agent";
  /** Registered subagent type, e.g. "Explore" / "general-purpose". */
  agentType: string | null;
  /** Short human label from the spawning Agent tool call. */
  description: string | null;
  /** 1 = spawned by the main agent; >1 = spawned by another subagent. */
  spawnDepth: number;
  /** Absolute path to the subagent's JSONL transcript. */
  sourcePath: string;
  /** The parent `Agent` tool_use id (meta.json.toolUseId) — the correlation
   *  key used to settle this row off a `tool_result` block in the MAIN
   *  session JSONL when the subagent's own transcript never writes a
   *  terminal end_turn line. Null pre-fix / when the meta sidecar lacked it.
   *  Optional (not just nullable) so object literals built before this field
   *  existed — fixtures across several test files — still satisfy the type. */
  toolUseId?: string | null;
  status: SubagentStatus;
  startedAt: number;
  endedAt: number | null;
}

/** Payload of a `stream: "subagent"` RunEvent (JSON-encoded in `data`). Lets an
 *  open run panel add/flip a tab the instant a subagent starts or finishes,
 *  without re-polling the snapshot endpoint. */
export interface SubagentEvent {
  phase: "started" | "finished";
  subagent: Subagent;
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
      /** Why the transition fired, when the column alone is ambiguous.
       *  Lets the UI pick a more accurate toast copy — e.g. an
       *  `api-error`-driven `blocked` reads as "API error — retry" rather
       *  than the generic "waiting on you" used for permission prompts.
       *  Unset for transitions whose reason is fully implied by the
       *  (prev, column) pair (e.g. plain success → review). */
      reason?: "api-error" | "approval" | "session-died" | "unknown-command";
    }
  | {
      kind: "update";
      status: UpdateStatus;
      /** Remote version string from update.json, when known. */
      version: string | null;
      /** Human-readable detail (error message, etc). */
      message: string | null;
      ts: number;
    }
  | {
      /**
       * A question / permission prompt was registered (`pending`) or cleared
       * (`resolved`). Distinct from the per-task `interaction` SSE event (which
       * only reaches the open RunPanel): this rides the app-level bus so the
       * notification hook can alert the user — with a native OS notification
       * and a "Waiting on you" toast — even when the agetor window is
       * backgrounded mid-workflow and the panel can't repaint the card.
       */
      kind: "interaction";
      taskId: string;
      runId: string;
      state: "pending" | "resolved";
      /** Stable id of the interaction, so the UI can track which prompts are
       *  live per task (several can stack) and clear the alert only once the
       *  last one resolves. */
      interactionId: string;
      ts: number;
    };

/**
 * App-level events the webview subscribes to over `GET /app/events`. Used
 * for cross-cutting flows that aren't tied to a single task — currently:
 *
 *   quit_request — main process intercepted Cmd+Q / window close with N
 *                  runs still active. Webview shows a confirm modal; the
 *                  user picks Quit-anyway (POST /app/force-quit) or stays.
 *   open_task    — a native notification deep-link (`agetor://task/<id>`)
 *                  was clicked. Webview opens that task's RunPanel.
 *   harness_usage — the background usage poller (or a force-refresh) produced
 *                  a fresh `HarnessQuota` snapshot for one harness. Webview
 *                  updates that harness's topbar chip in place.
 */
export type AppEvent =
  | {
      type: "quit_request";
      runningRunCount: number;
      runningTaskTitles: string[];
      ts: number;
    }
  | {
      type: "open_task";
      taskId: string;
      ts: number;
    }
  | {
      type: "harness_usage";
      quota: HarnessQuota;
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
 * The "Commit & push" follow-up prompt, shared by the webview's RunPanel chip
 * and the CLI's `agetor commit` / dashboard `c` action so the instruction stays
 * identical across surfaces.
 *
 * The commit-subject type is derived from the task's branch prefix, so the
 * commit matches the project's branch nomenclature (`feature/x` → `feature:`),
 * falling back to feat/fix/chore by task type when the branch carries no
 * prefix. The branch is shell-quoted because git ref names may legally contain
 * shell metacharacters; `'\''` is the POSIX escape for an embedded quote.
 *
 * After the commit/push, the prompt first asks for the full link to open a
 * pull request for the branch — as plain text above the code blocks, not
 * fenced, so react-markdown's GFM autolinking renders it clickable (git prints
 * the link in the push output for GitHub/GitLab/Bitbucket; otherwise it can be
 * built from the remote URL). It then asks the agent to propose a pull
 * request title and description, each emitted in its own fenced code block so
 * agetor renders a one-click copy button per field — the user copies the title
 * into the New PR composer's Title field and the description into its
 * Description field without a second turn. Two blocks (not one) because the
 * composer has two separate fields; the copy button grabs a whole fenced block.
 *
 * The description block uses a FOUR-backtick fence on purpose: PR descriptions
 * routinely contain their own ``` code fences (test output, snippets), and a
 * 3-backtick outer fence is closed early by the first inner ```, truncating the
 * copied text. A 4-backtick fence is closed only by >=4 backticks, so inner ```
 * blocks survive verbatim (verified against micromark, react-markdown's parser:
 * 4-tick outer -> one <pre>; 3-tick outer -> two, split at the inner fence).
 */
export function commitPushPrompt(task: Pick<Task, "branch" | "taskType">): string {
  const ccType = branchCommitType(task.branch, task.taskType);
  const branchLabel = task.branch ? `'${task.branch.replace(/'/g, "'\\''")}'` : "<branch>";
  return (
    `Commit all changes with a clear commit message ` +
    `(prefix the subject with "${ccType}:", e.g. "${ccType}: ...") summarizing the work, ` +
    `then push the current branch to origin. ` +
    `If the branch has no upstream yet, set it with \`git push -u origin ${branchLabel}\`. ` +
    `After pushing, first print the full link to open a pull request for the branch ` +
    `(git prints one in the push output; otherwise build it from the remote URL) as ` +
    `plain text on its own line — not inside a code block. ` +
    `Below the link, propose the pull request as two fenced code blocks so each can be ` +
    `copied with one click: first a "PR title:" line followed by a \`\`\` block containing ` +
    `only the concise one-line title, then a "PR description:" line followed by a ` +
    `\`\`\`\` four-backtick block containing the description in markdown (what changed and ` +
    `why) — use four backticks so any \`\`\` code fences inside the description don't ` +
    `close the block early. ` +
    `Do not include any AI attribution in the commit message, PR title, or PR description — ` +
    `no "Generated with Claude Code" / "Generated by AI" footers, robot emoji, or ` +
    `Co-Authored-By trailers crediting an AI tool.`
  );
}

/**
 * A working directory the user has registered as a "project". Surfaced in the
 * workdir picker on the New Task form so common paths don't need to be typed
 * every time. Explicit entries come from the native folder dialog
 * (POST /projects/pick).
 */
export interface Project {
  path: string;
  name: string;
  addedAt: number;
  /**
   * Per-project branch nomenclature. Null when the user hasn't customized it —
   * consumers fall back to {@link DEFAULT_BRANCH_CONFIG}.
   */
  branchConfig: BranchNamingConfig | null;
}

/**
 * A branch in a project repo, as returned by `GET /projects/branches` and
 * surfaced by the new-task base-ref picker. The single source of truth shared
 * by the server (`listBranches` in src/bun/worktree.ts), the webview (`api.ts` /
 * `BranchPicker`), and the CLI — the previous per-side copies had already
 * silently drifted (the client one omitted `remote`). Keep it that way: do not
 * re-declare this interface, since TypeScript would silently merge the two
 * declarations rather than flag the duplicate.
 */
export interface BranchInfo {
  /** Short ref name, e.g. "main", "feature/x", or "origin/feature/x". */
  name: string;
  /** Unix-ms timestamp of the tip commit, used to sort recents first. */
  committedAt: number;
  /** True for the branch currently checked out at the repo. */
  current: boolean;
  /** True for remote-tracking refs (`refs/remotes/<remote>/<name>`). */
  remote: boolean;
  /** Short name of the upstream tracking ref (e.g. "origin/main"), or null when
   *  the branch has no configured upstream or is itself a remote-tracking ref. */
  upstream: string | null;
  /** Commits the upstream has that this branch lacks ("behind" count). 0 when up
   *  to date; null when there's no upstream. Reflects the last fetch (compared
   *  against the local remote-tracking ref, not the network). */
  behind: number | null;
  /** Commits this branch has that the upstream lacks ("ahead" count). Used to
   *  detect divergence (ahead > 0 && behind > 0). Null when there's no upstream. */
  ahead: number | null;
}

/**
 * @deprecated Use {@link HarnessStatus} instead. Kept as a type alias so the
 * webview code that already imported `AgentStatus` doesn't need to rename;
 * the shape is now per-harness (multiple rows can share a `kind`).
 */
export type AgentStatus = HarnessStatus;

/**
 * Multi-provider git-forge support (docs/plans/multi-provider-git-modal.md).
 * `canonicalGitHost` in `src/bun/github.ts` already maps any host containing
 * "github"/"gitlab"/"bitbucket" to the provider's cloud hostname — this is
 * the provider identifier that maps to that canonical host 1:1.
 */
export type GitProvider = "github" | "gitlab" | "bitbucket";

/**
 * A resolved provider + repo identity for a project directory, as returned by
 * `providerRepoForDir` (`src/bun/git-provider.ts`) and the `provider-info`
 * route consumed by the GitHub/GitLab/Bitbucket dialog.
 */
export interface ProviderRepoInfo {
  provider: GitProvider;
  /** Canonical provider host, e.g. "gitlab.com" — NOT the token-store key. */
  host: string;
  /** Raw (pre-canonicalization) remote host — e.g. the ssh-alias host a user
   *  pins per-identity in `~/.ssh/config`. This is the token-store key (see
   *  `github-tokens.ts`'s host-keyed store and `docs/plans/github-multi-identity-tokens.md`) —
   *  callers resolving a token for this repo must use `remoteHost`, not `host`. */
  remoteHost: string;
  owner: string;
  name: string;
}

/**
 * Per-provider feature flags + terminology driving the GitHub/GitLab/Bitbucket
 * dialog's gating (Wave 4, `GitHubDialog.tsx`): affordances the selected
 * provider doesn't support are hidden rather than shown broken. GitHub is the
 * baseline the dialog was originally built against, so every flag is `true`
 * there; GitLab/Bitbucket flip off whatever their APIs can't back (see the
 * provider API facts in the plan's §2 for the source of each flag).
 */
export interface ProviderCaps {
  labels: boolean;
  milestones: boolean;
  /** GitHub's raw search-qualifier syntax (`label:bug sort:updated`) — GitHub
   *  only; GitLab/Bitbucket use structured filters instead. */
  searchSyntax: boolean;
  reviewRequestedFilter: boolean;
  checks: boolean;
  /** The separate GitHub commit-status panel (distinct from the CheckRuns UI,
   *  which GitLab/Bitbucket statuses are normalized into instead). */
  commitStatusPanel: boolean;
  reactions: boolean;
  draft: boolean;
  autoMerge: boolean;
  suggestions: boolean;
  subIssues: boolean;
  projects: boolean;
  discussions: boolean;
  actions: boolean;
  notifications: boolean;
  releases: boolean;
  issueTracker: boolean;
  requestChanges: boolean;
  updateBranch: boolean;
  linkedIssues: boolean;
  commentSort: boolean;
  lockConversation: boolean;
  pinIssue: boolean;
  issueTransfer: boolean;
  mergeMethods: GitHubPullMergeMethod[];
  providerName: string;
  /** Singular term for a "pull request" in this provider's own terminology. */
  pullNoun: string;
  pullNounPlural: string;
  pullAbbrev: string;
  pullAbbrevPlural: string;
}

/**
 * Per-provider capability + terminology table. GitHub is full-featured (the
 * dialog's original baseline); GitLab and Bitbucket flip off flags for panels
 * and actions their APIs don't support (Projects/Discussions/Actions/
 * Notifications/Releases/Reactions/SubIssues/Suggestions/AutoMerge/
 * UpdateBranch/LinkedIssues/CommentSort/Lock/Pin/Transfer are GitHub-only).
 *
 * `mergeMethods` reuses {@link GitHubPullMergeMethod} ("merge"|"squash"|"rebase")
 * as the neutral merge-strategy vocabulary:
 * - GitHub: merge, squash, rebase (all three, unchanged).
 * - GitLab: merge, squash (GitLab has no rebase-as-a-merge-strategy option —
 *   its "rebase" action rewrites the branch before merging, it isn't a merge
 *   strategy choice like GitHub's).
 * - Bitbucket: merge, squash, rebase — Bitbucket's three `merge_strategy`
 *   values are `merge_commit` / `squash` / `fast_forward`. There is no
 *   fast-forward entry in {@link GitHubPullMergeMethod}, so `fast_forward`
 *   (a linear, no-merge-commit history — the same end result GitHub's
 *   "rebase and merge" produces) is mapped to `"rebase"` here; the adapter
 *   (Wave 2/T3, `src/bun/bitbucket.ts`) is responsible for translating
 *   `"rebase"` back to `merge_strategy: "fast_forward"` on the wire.
 */
export const PROVIDER_CAPS: Record<GitProvider, ProviderCaps> = {
  github: {
    labels: true,
    milestones: true,
    searchSyntax: true,
    reviewRequestedFilter: true,
    checks: true,
    commitStatusPanel: true,
    reactions: true,
    draft: true,
    autoMerge: true,
    suggestions: true,
    subIssues: true,
    projects: true,
    discussions: true,
    actions: true,
    notifications: true,
    releases: true,
    issueTracker: true,
    requestChanges: true,
    updateBranch: true,
    linkedIssues: true,
    commentSort: true,
    lockConversation: true,
    pinIssue: true,
    issueTransfer: true,
    mergeMethods: ["merge", "squash", "rebase"],
    providerName: "GitHub",
    pullNoun: "Pull request",
    pullNounPlural: "Pull requests",
    pullAbbrev: "PR",
    pullAbbrevPlural: "PRs",
  },
  gitlab: {
    labels: true,
    milestones: false,
    searchSyntax: false,
    reviewRequestedFilter: true,
    checks: true,
    commitStatusPanel: false,
    reactions: false,
    draft: true,
    autoMerge: false,
    suggestions: false,
    subIssues: false,
    projects: false,
    discussions: false,
    actions: false,
    notifications: false,
    releases: false,
    issueTracker: true,
    requestChanges: false,
    updateBranch: false,
    linkedIssues: false,
    commentSort: false,
    lockConversation: false,
    pinIssue: false,
    issueTransfer: false,
    mergeMethods: ["merge", "squash"],
    providerName: "GitLab",
    pullNoun: "Merge request",
    pullNounPlural: "Merge requests",
    pullAbbrev: "MR",
    pullAbbrevPlural: "MRs",
  },
  bitbucket: {
    labels: false,
    milestones: false,
    searchSyntax: false,
    reviewRequestedFilter: true,
    checks: true,
    commitStatusPanel: false,
    reactions: false,
    draft: true,
    autoMerge: false,
    suggestions: false,
    subIssues: false,
    projects: false,
    discussions: false,
    actions: false,
    notifications: false,
    releases: false,
    issueTracker: true,
    requestChanges: true,
    updateBranch: false,
    linkedIssues: false,
    commentSort: false,
    lockConversation: false,
    pinIssue: false,
    issueTransfer: false,
    // merge_commit/squash/fast_forward → merge/squash/rebase; see the
    // ProviderCaps doc comment above for the fast_forward↔"rebase" mapping.
    mergeMethods: ["merge", "squash", "rebase"],
    providerName: "Bitbucket",
    pullNoun: "Pull request",
    pullNounPlural: "Pull requests",
    pullAbbrev: "PR",
    pullAbbrevPlural: "PRs",
  },
};

// ───────────────────────────────────────────────────────────────────────────
// Theme (Auto / Dark / Light)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The user-facing theme choice, persisted as the `theme` key in the
 * `preferences` table (see `src/bun/db.ts`) and round-tripped through
 * `GET/PUT /preferences`. "auto" follows the OS appearance
 * (`prefers-color-scheme`) and live-reacts to it changing while the app is
 * open; "dark"/"light" pin an explicit choice. Unset/invalid persisted values
 * resolve to "auto" — see `parseThemePreference` in `src/mainview/lib/theme.ts`.
 */
export type ThemePreference = "auto" | "dark" | "light";

/** The concrete theme actually painted — what `preference` resolves to once
 *  "auto" has been settled against the OS/system appearance. */
export type ResolvedTheme = "dark" | "light";

/** Options for the Settings → General theme picker, in display order. */
export const THEME_PREFERENCES: readonly { id: ThemePreference; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
];

// ───────────────────────────────────────────────────────────────────────────
// Font size (Cmd+= / Cmd+- global UI zoom)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The current root font size (16px) is both the DEFAULT and the MINIMUM —
 * Cmd+- has nowhere to go below "what it looks like today". FONT_SIZE_MAX
 * (170%) and FONT_SIZE_STEP (10%) are the generous-but-layout-safe bounds
 * chosen in docs/plans/cmd-font-size-controller.md §8. Persisted as the
 * `fontSize` key in the `preferences` table (see `src/bun/db.ts`) as a plain
 * percent string ("100"–"170"), round-tripped through `GET/PUT /preferences`
 * exactly like `theme`. Applied as
 * `document.documentElement.style.fontSize = (16 * pct/100) + "px"`; at
 * exactly FONT_SIZE_DEFAULT the inline style is omitted entirely so the
 * default state stays pristine (and the boot no-flash channels can skip the
 * write).
 */
export const FONT_SIZE_MIN = 100;
export const FONT_SIZE_MAX = 170;
export const FONT_SIZE_STEP = 10;
export const FONT_SIZE_DEFAULT = 100;

/** Root `<html>` font size at 100% (px) — the rem baseline every percent is
 *  scaled against (`FONT_SIZE_BASE_PX * pct/100`). Consumed by `src/bun/index.ts`
 *  (preload apply-script) and duplicated inline in `src/mainview/index.html`'s
 *  blocking boot script, which can't import a module before first paint. */
export const FONT_SIZE_BASE_PX = 16;

/** xterm terminal pane font size at 100% (px) — the separate baseline
 *  `TerminalView.tsx` scales against, since xterm renders to canvas outside
 *  the CSS/rem cascade `FONT_SIZE_BASE_PX` drives. */
export const TERMINAL_FONT_SIZE_BASE_PX = 12;

/**
 * Parse anything (a persisted preference string, a hash-fragment param, a
 * `window.__AGETOR` global, …) into a valid integer font-size percent,
 * clamped to [FONT_SIZE_MIN, FONT_SIZE_MAX]. Accepts a string ("120",
 * "120.5") or a number; floats are rounded to the nearest integer before
 * clamping. Anything else — null/undefined, an empty/non-numeric string,
 * NaN, ±Infinity — falls back to FONT_SIZE_DEFAULT. Never throws.
 */
export function clampFontSizePercent(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseFloat(raw) : NaN;
  if (!Number.isFinite(n)) return FONT_SIZE_DEFAULT;
  const rounded = Math.round(n);
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, rounded));
}
