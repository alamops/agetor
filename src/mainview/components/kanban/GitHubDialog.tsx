import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowDownWideNarrow,
  ArrowRightLeft,
  ArrowUpFromLine,
  ArrowUpWideNarrow,
  Ban,
  Bell,
  BellOff,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  ExternalLink,
  FileMinus,
  FilePen,
  FilePlus,
  FileSymlink,
  FileText,
  GitMerge,
  GitPullRequest,
  Kanban,
  ListTree,
  Loader2,
  Lock,
  MessageSquare,
  MessagesSquare,
  Milestone,
  Pin,
  PinOff,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  RotateCcw,
  Search,
  Sparkles,
  Tag,
  Unlock,
  Workflow,
  X,
  XCircle,
} from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  api,
  type GitHubItemKind,
  type GitHubItemState,
  type GitHubListResult,
  type GitHubPullMergeMethod,
  type GitHubPullReviewEvent,
  type GitHubReactionContent,
  type GitHubReactionSubject,
  type GitHubReactionSummary,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { toRows, type DiffRow } from "@/lib/diff-rows";
import { mergeabilityView, type MergeTone } from "@/lib/mergeability";
import { ResolveConflictsDialog, type ResolveConflictsContext } from "./ResolveConflictsDialog";
import {
  backToList,
  openCompose,
  openDetail,
  resolveEscape,
  togglePanel,
  type GitHubDialogView,
  type GitHubPanelKind,
} from "@/lib/github-dialog-view";
import type {
  DiffFile,
  GitHubCheckRun,
  GitHubChecksResult,
  GitHubComment,
  GitHubCommitStatusResult,
  GitHubDiscussion,
  GitHubDiscussionCategory,
  GitHubDiscussionComment,
  GitHubDiscussionDetail,
  GitHubLinkedIssue,
  GitHubListItem,
  GitHubNotification,
  GitHubPullCommit,
  GitHubPullLineComment,
  GitHubPullMergeability,
  GitHubProjectField,
  GitHubProjectItem,
  GitHubProjectV2,
  GitHubRateLimit,
  GitHubRelease,
  GitHubRepoLabel,
  GitHubRepoMilestone,
  GitHubReviewThread,
  GitHubSubIssue,
  GitHubTag,
  GitHubUser,
  GitHubWorkflow,
  GitHubWorkflowRun,
  GitProvider,
  Project,
  ProviderCaps,
  TaskDiff,
} from "../../../shared/types.ts";
import { PROVIDER_CAPS } from "../../../shared/types.ts";

/** One-shot prefill for the New-PR composer (T3, "Open PR" from a task's run
 *  panel): selects the given project, switches to the pulls tab, opens the
 *  composer, and seeds head/title/body from the agent's parsed reply. */
export interface GitHubPullPrefill {
  projectPath: string;
  head: string;
  title: string;
  body: string;
  taskId: string;
}

/** One-shot prefill for the PR detail subpage (T4, "View PR" from a task's
 *  run panel): selects the given project, switches to the pulls tab, fetches
 *  the single PR by number, and navigates straight to `openDetail(item)` —
 *  landing on the same in-app detail subpage a list click would, instead of
 *  shelling out to the browser. `prUrl` is kept alongside so a fetch failure
 *  can still fall back to the plain external link. */
export interface GitHubPullDetailPrefill {
  projectPath: string;
  number: number;
  prUrl: string;
}

interface Props {
  open: boolean;
  projects: Project[];
  initialProjectPath?: string | null;
  /** Consumed exactly once per distinct object (tracked by reference) — see
   *  the two-part effect pair around `pendingPullPrefillRef` below for why a
   *  single effect can't do this safely against the composer's own
   *  reset-on-project/kind-change effect. */
  pullPrefill?: GitHubPullPrefill | null;
  /** Same one-shot-by-reference contract as `pullPrefill` above, mirrored
   *  with its own ref pair — see the two-part effect pair around
   *  `pendingPullDetailPrefillRef` below. */
  pullDetailPrefill?: GitHubPullDetailPrefill | null;
  onClose: () => void;
}

const basename = (p: string) => {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
};

/** Stable per-item identity (G8, multi-repo aggregation). Item numbers are
 *  per-repo, so an aggregated list routinely holds two items with the same
 *  kind+number (repo A PR #5 and repo B PR #5). Keying anything on number alone
 *  collides — React row keys, the detail-view lookup, and every per-item state map. The
 *  composite key disambiguates by the item's own repo path. In single-repo mode
 *  `sourcePath` is null, so the key is exactly the historical `${kind}-${number}`
 *  — existing behavior (and tests) unchanged. */
function itemKey(item: Pick<GitHubListItem, "kind" | "number" | "sourcePath">): string {
  return item.sourcePath
    ? `${item.sourcePath}::${item.kind}-${item.number}`
    : `${item.kind}-${item.number}`;
}

/** Whether two list items are the same underlying GitHub item — kind + number
 *  scoped to the same repo. Used by every in-place list mutation
 *  (upsert/close/transfer/label reconcile) so a change to repo B's #5 can't
 *  overwrite repo A's #5 in aggregate mode. */
function sameItem(
  a: Pick<GitHubListItem, "kind" | "number" | "sourcePath">,
  b: Pick<GitHubListItem, "kind" | "number" | "sourcePath">,
): boolean {
  return a.kind === b.kind && a.number === b.number && (a.sourcePath ?? null) === (b.sourcePath ?? null);
}

const fmtDate = (value: string) => {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(d);
};

// A coarse "today" / "3d ago" for compact commit rows; falls back to the plain
// date once it's more than a month old, where the exact day matters more than
// the relative distance.
const fmtRelativeDate = (value: string) => {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 30) return `${diffDays}d ago`;
  return fmtDate(value);
};

function splitLabels(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseMilestone(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The label / assignee / milestone controls shared by <IssueActions> and
 *  <PullTriage>. Drives real pickers off the already-fetched repo labels,
 *  assignees, and milestones, falling back to the original free-text inputs
 *  when that repo data hasn't loaded (or the project is unauthenticated) so
 *  triage never regresses to "no way to set this". The drafts stay the same
 *  comma-joined strings the save path (`updateIssueLabels`) already parses
 *  with `splitLabels`/`parseMilestone`, so no save-path changes are needed. */
function LabelAssigneeMilestoneFields({
  repoLabels,
  repoAssignees,
  repoMilestones,
  labelDraft,
  assigneeDraft,
  milestoneDraft,
  disabled,
  // Provider gating (T5): labels are Bitbucket-unsupported (caps.labels) and
  // milestones are GitLab/Bitbucket-unsupported (caps.milestones). Both
  // default to `true` so every existing GitHub call site (which never passes
  // these) renders exactly as before.
  showLabels = true,
  showMilestones = true,
  onLabelDraftChange,
  onAssigneeDraftChange,
  onMilestoneDraftChange,
}: {
  repoLabels: GitHubRepoLabel[];
  repoAssignees: GitHubUser[];
  repoMilestones: GitHubRepoMilestone[];
  labelDraft: string;
  assigneeDraft: string;
  milestoneDraft: string;
  disabled?: boolean;
  showLabels?: boolean;
  showMilestones?: boolean;
  onLabelDraftChange: (body: string) => void;
  onAssigneeDraftChange: (body: string) => void;
  onMilestoneDraftChange: (body: string) => void;
}) {
  const selectedLabels = useMemo(() => new Set(splitLabels(labelDraft)), [labelDraft]);
  const selectedAssignees = useMemo(() => new Set(splitLabels(assigneeDraft)), [assigneeDraft]);

  const toggleLabel = (name: string) => {
    const next = new Set(selectedLabels);
    if (next.has(name)) next.delete(name); else next.add(name);
    onLabelDraftChange(Array.from(next).join(", "));
  };
  const toggleAssignee = (login: string) => {
    const next = new Set(selectedAssignees);
    if (next.has(login)) next.delete(login); else next.add(login);
    onAssigneeDraftChange(Array.from(next).join(", "));
  };

  // Render the repo list PLUS any currently-set value missing from it (a label
  // removed from the repo, an assignee no longer assignable, a milestone past
  // the fetch cap) so set-but-unlisted values stay visible and de-selectable
  // rather than silently stranded.
  const labelNames = useMemo(() => {
    const names = repoLabels.map((l) => l.name);
    return [...names, ...[...selectedLabels].filter((n) => !names.includes(n))];
  }, [repoLabels, selectedLabels]);
  const assigneeLogins = useMemo(() => {
    const logins = repoAssignees.map((u) => u.login);
    return [...logins, ...[...selectedAssignees].filter((l) => !logins.includes(l))];
  }, [repoAssignees, selectedAssignees]);
  const milestoneOptions = useMemo(() => {
    const opts = repoMilestones.map((m) => ({ value: String(m.number), label: m.title }));
    if (milestoneDraft && !opts.some((o) => o.value === milestoneDraft)) {
      opts.push({ value: milestoneDraft, label: `#${milestoneDraft}` });
    }
    return opts;
  }, [repoMilestones, milestoneDraft]);

  const chipCls = (active: boolean) =>
    cn(
      "rounded-full border px-2 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
      active
        ? "border-primary bg-primary/20 text-foreground"
        : "border-input text-muted-foreground hover:text-foreground",
    );

  return (
    <>
      {showLabels && (repoLabels.length > 0 ? (
        <div
          className="flex h-8 flex-wrap items-center gap-1 overflow-y-auto rounded-md border border-input bg-transparent px-1.5 py-1"
          title="Labels"
        >
          {labelNames.map((name) => (
            <button
              key={name}
              type="button"
              disabled={disabled}
              onClick={() => toggleLabel(name)}
              className={chipCls(selectedLabels.has(name))}
            >
              {name}
            </button>
          ))}
        </div>
      ) : (
        <Input
          value={labelDraft}
          onChange={(e) => onLabelDraftChange(e.target.value)}
          placeholder="Labels, comma separated"
          className="h-8 text-xs"
          disabled={disabled}
        />
      ))}
      {repoAssignees.length > 0 ? (
        <div
          className="flex h-8 flex-wrap items-center gap-1 overflow-y-auto rounded-md border border-input bg-transparent px-1.5 py-1"
          title="Assignees"
        >
          {assigneeLogins.map((login) => (
            <button
              key={login}
              type="button"
              disabled={disabled}
              onClick={() => toggleAssignee(login)}
              className={chipCls(selectedAssignees.has(login))}
            >
              {login}
            </button>
          ))}
        </div>
      ) : (
        <Input
          value={assigneeDraft}
          onChange={(e) => onAssigneeDraftChange(e.target.value)}
          placeholder="Assignees, comma separated"
          className="h-8 text-xs"
          disabled={disabled}
        />
      )}
      {showMilestones && (repoMilestones.length > 0 ? (
        <Select
          value={milestoneDraft}
          onChange={(e) => onMilestoneDraftChange(e.target.value)}
          className="h-8 text-xs"
          disabled={disabled}
          aria-label="Milestone"
        >
          <option value="">— none —</option>
          {milestoneOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          value={milestoneDraft}
          onChange={(e) => onMilestoneDraftChange(e.target.value)}
          placeholder="Milestone number"
          className="h-8 text-xs"
          disabled={disabled}
        />
      ))}
    </>
  );
}

const STATUS_META: Record<DiffFile["status"], { icon: typeof FilePlus; cls: string }> = {
  added: { icon: FilePlus, cls: "text-emerald-400" },
  modified: { icon: FilePen, cls: "text-amber-400" },
  deleted: { icon: FileMinus, cls: "text-rose-400" },
  renamed: { icon: FileSymlink, cls: "text-sky-400" },
};

interface LineCommentTarget {
  filePath: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
}

/** Cheap client-side check for "does this review comment's body contain a
 *  ```suggestion fence" — gates whether the Apply control renders at all. The
 *  authoritative extraction (used to actually apply the change) lives
 *  server-side in `parseSuggestion` (src/bun/github.ts); this only needs to
 *  detect presence, not extract the body. */
function hasSuggestion(body: string): boolean {
  // Require the newline after the info string so this gate matches the
  // server-side extractor (`parseSuggestion`) exactly — a body ending in a bare
  // ```suggestion is not an appliable suggestion and mustn't show an Apply button.
  return /```suggestion\r?\n/.test(body);
}

// Shared tooltip for every push-only control disabled by F13 gating.
const PUSH_ONLY_TITLE = "Requires write access to this repository";

// Sentinel `projectPath` value selecting "All repositories" (G8, multi-repo
// aggregation / F15) — not a real filesystem path, so every effect that needs
// a concrete repo (viewer login excepted, which falls back to the first
// registered project) must special-case it. Chosen to be exceedingly unlikely
// to collide with a real project path.
const AGGREGATE_PROJECT_PATH = "__agetor_all_repositories__";

// Shared tooltip for the repo-scoped toolbar buttons (labels/milestones/
// notifications) and the new-PR/new-issue composers, all disabled in
// aggregate mode since they need a single concrete repo.
const AGGREGATE_DISABLED_TITLE = "Select a single project — not available across all repositories";

// Human titles for the manager-panel header (back-chevron subpage treatment),
// keyed by `GitHubPanelKind`.
const PANEL_TITLES: Record<GitHubPanelKind, string> = {
  labels: "Labels",
  milestones: "Milestones",
  releases: "Releases",
  notifications: "Notifications",
  actions: "Actions",
  projects: "Projects",
  discussions: "Discussions",
};

/** Subtle "API: 4823/5000" (or "search: 27/30") indicator (F17). Muted by
 *  default; tints amber when remaining budget drops under 10% of the limit —
 *  the Search API's ~30/min ceiling is small enough that this can trip during
 *  normal use, which is the point of surfacing it at all. */
function RateLimitBadge({ rateLimit }: { rateLimit: GitHubRateLimit }) {
  const low = rateLimit.limit > 0 && rateLimit.remaining / rateLimit.limit < 0.1;
  return (
    <span
      className={cn("shrink-0 text-[11px]", low ? "font-medium text-amber-400" : "text-muted-foreground")}
      title={`GitHub API rate limit (${rateLimit.resource}): ${rateLimit.remaining} of ${rateLimit.limit} requests remaining`}
    >
      {rateLimit.resource}: {rateLimit.remaining}/{rateLimit.limit}
    </span>
  );
}

export function GitHubDialog({ open, projects, initialProjectPath, pullPrefill, pullDetailPrefill, onClose }: Props) {
  const [projectPath, setProjectPath] = useState("");
  // "All repositories" (G8/F15) — see AGGREGATE_PROJECT_PATH.
  const isAggregate = projectPath === AGGREGATE_PROJECT_PATH;
  // Provider awareness (T5, docs/plans/multi-provider-git-modal.md): which git
  // forge the current project (or, in aggregate mode, the whole registered set)
  // resolves to. `null` while unresolved (or on lookup failure) — treated the
  // same as "mixed" by `caps` below so the dialog never renders a half-known
  // provider's gaps; it only ever narrows once resolution lands. Cached per
  // project path so switching between two already-seen projects is instant and
  // aggregate mode doesn't refetch on every render.
  const [provider, setProvider] = useState<GitProvider | "mixed" | null>(null);
  const providerCache = useRef<Map<string, GitProvider | null>>(new Map());
  const [kind, setKind] = useState<GitHubItemKind>("pulls");
  const [state, setState] = useState<GitHubItemState>("open");
  const [query, setQuery] = useState("");
  // When on, the search box holds raw GitHub search qualifiers sent server-side
  // via the Search API, instead of a client-side substring filter.
  const [searchSyntax, setSearchSyntax] = useState(false);
  // In GH mode the box is committed explicitly (Enter), not live-searched — so a
  // half-typed qualifier doesn't fire an invalid Search request on every keystroke.
  const [searchSubmitted, setSearchSubmitted] = useState("");
  const effectiveQuery = searchSyntax ? searchSubmitted : query;
  const [labels, setLabels] = useState("");
  const [assignee, setAssignee] = useState("");
  // "Involvement" quick filters (served via the Search API on the backend).
  const [createdByMe, setCreatedByMe] = useState(false);
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [reviewRequested, setReviewRequested] = useState(false);
  const [result, setResult] = useState<GitHubListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Authenticated user's login, so edit/delete controls appear only on the
  // viewer's own comments. Empty when unauthenticated.
  const [viewerLogin, setViewerLogin] = useState("");
  // Whether the viewer has push access to the current repo (F13). Optimistic
  // (true) while unresolved so controls aren't disabled during the brief
  // window before the permissions check lands — only flips to `false` once
  // resolved, never hides a control (see `canPushResolvedFor` below).
  const [canPush, setCanPush] = useState(true);
  // Sort field + direction (F16) — re-fetches page 1 on change, like the other
  // filters below. "best-match" is the default: it omits sort/order entirely so
  // the Search API returns relevance-ranked results for free-text queries (and
  // the REST path falls back to its own created-desc default). The api client
  // maps "best-match" to "no sort param".
  const [sortField, setSortField] = useState<"best-match" | "created" | "updated" | "comments">("best-match");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  // Tracks in-flight/finished "Load more" fetches, separate from the initial
  // `loading` flag so the existing list stays visible while more loads.
  const [loadingMore, setLoadingMore] = useState(false);
  // True during the 250ms filter/sort debounce window, before the reload fetch
  // actually starts. "Load more" is gated on this: the debounce effect bumps
  // requestSeq up front, so a load-more click in the window would otherwise
  // out-race (and silently drop) the pending reload for the new filters.
  const [reloadPending, setReloadPending] = useState(false);
  // All repo labels (powers the label datalist + the label manager).
  const [repoLabels, setRepoLabels] = useState<GitHubRepoLabel[]>([]);
  // All repo milestones (powers the milestone manager).
  const [repoMilestones, setRepoMilestones] = useState<GitHubRepoMilestone[]>([]);
  // All assignable repo users (powers the triage assignee picker). Convenience
  // data only — no manager UI, so failures are swallowed like labels/milestones.
  const [repoAssignees, setRepoAssignees] = useState<GitHubUser[]>([]);
  // Repo releases (F18) — powers the releases manager. Repo-scoped like
  // labels/milestones, so disabled in aggregate mode.
  const [repoReleases, setRepoReleases] = useState<GitHubRelease[]>([]);
  // Repo tags — feeds the release manager's tag-name datalist. Lazy — only
  // fetched while the manager is open, mirroring notifications below.
  const [repoTags, setRepoTags] = useState<GitHubTag[]>([]);
  // Actions (F20) — recent workflow runs + dispatchable workflows. Both are
  // lazy — like notifications/tags, only fetched while the manager is open.
  const [workflowRuns, setWorkflowRuns] = useState<GitHubWorkflowRun[]>([]);
  const [workflows, setWorkflows] = useState<GitHubWorkflow[]>([]);
  const [actionsLoading, setActionsLoading] = useState(false);
  const [actionsError, setActionsError] = useState<string | null>(null);
  const actionsSeq = useRef(0);
  // Per-run in-flight action ("rerun" | "rerun-failed" | "cancel") and the
  // last error for that run, both keyed by run id — mirrors the notification
  // per-thread busy/error maps.
  const [workflowRunBusy, setWorkflowRunBusy] = useState<Record<number, string | undefined>>({});
  const [workflowRunErrors, setWorkflowRunErrors] = useState<Record<number, string | undefined>>({});
  // "Run a workflow" dispatch form state.
  const [dispatchWorkflowId, setDispatchWorkflowId] = useState("");
  const [dispatchRef, setDispatchRef] = useState("");
  const [dispatchInputs, setDispatchInputs] = useState<{ key: string; value: string }[]>([]);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [dispatchMessage, setDispatchMessage] = useState<string | null>(null);
  // Repo notifications inbox (F14) — private (token-gated), so nothing is
  // preloaded until the panel is opened; the fetch itself surfaces the
  // "sign in" error when unauthenticated.
  const [notifications, setNotifications] = useState<GitHubNotification[]>([]);
  // Guards both the lazy-load effect and the manual refresh so a slower fetch
  // (e.g. unread→all toggled mid-request) can't clobber a newer result.
  const notificationsSeq = useRef(0);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsError, setNotificationsError] = useState<string | null>(null);
  // false = unread only (GitHub's own default); true = all recent notifications.
  const [notificationsShowAll, setNotificationsShowAll] = useState(false);
  const [notificationsMarkAllBusy, setNotificationsMarkAllBusy] = useState(false);
  // Per-thread in-flight action ("read" | "ignore" | "unsubscribe") and the
  // last error for that thread, both keyed by notification id.
  const [notificationBusy, setNotificationBusy] = useState<Record<string, string | undefined>>({});
  const [notificationRowErrors, setNotificationRowErrors] = useState<Record<string, string | undefined>>({});
  // The viewer login is token-scoped (identical across projects), so resolve it
  // once per session rather than on every open / project switch. A failed lookup
  // (e.g. the first project has no GitHub remote) leaves it unresolved so a later
  // project with a remote can still fill it in.
  const viewerResolved = useRef(false);
  // Push access is per-repo (unlike the viewer's login), so this caches the
  // project path it was last resolved for rather than a plain boolean —
  // switching projects re-resolves. A failed lookup leaves it unresolved so
  // the effect retries on the next render for that same project.
  const canPushResolvedFor = useRef<string | null>(null);
  const requestSeq = useRef(0);
  const diffSeq = useRef(0);
  const commentSeq = useRef(0);
  const reviewCommentSeq = useRef(0);
  const checksSeq = useRef(0);
  const commitStatusSeq = useRef(0);
  const mergeabilitySeq = useRef(0);
  const commitsSeq = useRef(0);
  const linkedIssuesSeq = useRef(0);
  // Bounds the self-healing re-poll when GitHub returns mergeable=null. Keyed by
  // itemKey (G8) so two same-numbered PRs across repos don't share a retry budget.
  const mergeabilityRetries = useRef<Record<string, number>>({});
  const [view, setView] = useState<GitHubDialogView>({ kind: "list" });
  // Derived rather than independent booleans — the 7 manager panels are
  // mutually exclusive with each other and with the detail subpage by
  // construction of the `GitHubDialogView` union, so there's no "close the
  // other six" bookkeeping left to do on toggle (see `togglePanel`).
  const labelManagerOpen = view.kind === "panel" && view.panel === "labels";
  const milestoneManagerOpen = view.kind === "panel" && view.panel === "milestones";
  const releaseManagerOpen = view.kind === "panel" && view.panel === "releases";
  const notificationsOpen = view.kind === "panel" && view.panel === "notifications";
  const actionsManagerOpen = view.kind === "panel" && view.panel === "actions";
  const projectsManagerOpen = view.kind === "panel" && view.panel === "projects";
  const discussionsManagerOpen = view.kind === "panel" && view.panel === "discussions";
  const [diffs, setDiffs] = useState<Record<string, TaskDiff | undefined>>({});
  const [diffLoading, setDiffLoading] = useState<Record<string, boolean | undefined>>({});
  const [diffErrors, setDiffErrors] = useState<Record<string, string | undefined>>({});
  const [checks, setChecks] = useState<Record<string, GitHubChecksResult | undefined>>({});
  const [checksLoading, setChecksLoading] = useState<Record<string, boolean | undefined>>({});
  const [checksErrors, setChecksErrors] = useState<Record<string, string | undefined>>({});
  // Combined commit status (F19, the legacy Status API) — keyed and lazy-fetched
  // like `checks` above, but keyed off the PR head sha (resolved from `checks`
  // once it lands) rather than the PR number.
  const [commitStatus, setCommitStatus] = useState<Record<string, GitHubCommitStatusResult | undefined>>({});
  const [commitStatusLoading, setCommitStatusLoading] = useState<Record<string, boolean | undefined>>({});
  const [commitStatusErrors, setCommitStatusErrors] = useState<Record<string, string | undefined>>({});
  const [mergeability, setMergeability] = useState<Record<string, GitHubPullMergeability | undefined>>({});
  const [mergeabilityLoading, setMergeabilityLoading] = useState<Record<string, boolean | undefined>>({});
  const [mergeabilityErrors, setMergeabilityErrors] = useState<Record<string, string | undefined>>({});
  const [commits, setCommits] = useState<Record<string, GitHubPullCommit[] | undefined>>({});
  const [commitsLoading, setCommitsLoading] = useState<Record<string, boolean | undefined>>({});
  const [commitsErrors, setCommitsErrors] = useState<Record<string, string | undefined>>({});
  const [linkedIssues, setLinkedIssues] = useState<Record<string, GitHubLinkedIssue[] | undefined>>({});
  const [linkedIssuesLoading, setLinkedIssuesLoading] = useState<Record<string, boolean | undefined>>({});
  const [linkedIssuesErrors, setLinkedIssuesErrors] = useState<Record<string, string | undefined>>({});
  const [comments, setComments] = useState<Record<string, GitHubComment[] | undefined>>({});
  const [commentsLoading, setCommentsLoading] = useState<Record<string, boolean | undefined>>({});
  const [commentErrors, setCommentErrors] = useState<Record<string, string | undefined>>({});
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string | undefined>>({});
  const [commentSubmitting, setCommentSubmitting] = useState<Record<string, boolean | undefined>>({});
  const [reviewComments, setReviewComments] = useState<Record<string, GitHubPullLineComment[] | undefined>>({});
  // Resolvable review-comment threads (GraphQL), keyed by PR number; matched to
  // the flat review-comments list via each thread's rootCommentId.
  const [reviewThreads, setReviewThreads] = useState<Record<string, GitHubReviewThread[] | undefined>>({});
  // True when a PR has more than the first 100 review threads (resolve controls
  // then only cover the first page).
  const [reviewThreadsTruncated, setReviewThreadsTruncated] = useState<Record<string, boolean | undefined>>({});
  const [reviewCommentsLoading, setReviewCommentsLoading] = useState<Record<string, boolean | undefined>>({});
  const [reviewCommentErrors, setReviewCommentErrors] = useState<Record<string, string | undefined>>({});
  // Keyed by review-comment id (globally unique across repos), not item key —
  // safe under aggregation without the composite-key treatment.
  const [reviewReplyDrafts, setReviewReplyDrafts] = useState<Record<number, string | undefined>>({});
  const [reviewReplySubmitting, setReviewReplySubmitting] = useState<Record<number, boolean | undefined>>({});
  // Keyed by review-comment id (not PR number) — apply-suggestion is a
  // per-comment action, mirroring reviewReplySubmitting's own keying.
  const [applySuggestionBusy, setApplySuggestionBusy] = useState<Record<number, boolean | undefined>>({});
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, string | undefined>>({});
  // Inline comments queued for the next review submission (the "pending review"
  // batched flow), keyed by PR number.
  const [pendingReview, setPendingReview] = useState<Record<string, LineCommentTarget[] | undefined>>({});
  // True when the diff was invalidated (refreshed / branch updated) after comments
  // were queued — their line numbers may no longer match, so warn before submit.
  const [pendingStale, setPendingStale] = useState<Record<string, boolean | undefined>>({});
  const [closeDrafts, setCloseDrafts] = useState<Record<string, string | undefined>>({});
  const [mergeMethods, setMergeMethods] = useState<Record<string, GitHubPullMergeMethod | undefined>>({});
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string | undefined>>({});
  const [assigneeDrafts, setAssigneeDrafts] = useState<Record<string, string | undefined>>({});
  const [milestoneDrafts, setMilestoneDrafts] = useState<Record<string, string | undefined>>({});
  const [reviewerDrafts, setReviewerDrafts] = useState<Record<string, string | undefined>>({});
  const [teamReviewerDrafts, setTeamReviewerDrafts] = useState<Record<string, string | undefined>>({});
  const [editorOpen, setEditorOpen] = useState<Record<string, boolean | undefined>>({});
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string | undefined>>({});
  const [bodyDrafts, setBodyDrafts] = useState<Record<string, string | undefined>>({});
  const [actionBusy, setActionBusy] = useState<Record<string, string | undefined>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string | undefined>>({});
  const [actionMessages, setActionMessages] = useState<Record<string, string | undefined>>({});
  // Which panel triggered the last action, so its error/message renders next to
  // the control the user used ("actions" | "triage" | "edit"), not in a sibling.
  const [actionSource, setActionSource] = useState<Record<string, string | undefined>>({});
  // Optional `lock_reason` picked before locking an issue/PR conversation.
  const [lockReasonDrafts, setLockReasonDrafts] = useState<Record<string, string | undefined>>({});
  // "owner/name" typed into the transfer-issue control, and whether the
  // disruptive two-step confirm has been armed for that row.
  const [transferDrafts, setTransferDrafts] = useState<Record<string, string | undefined>>({});
  const [transferConfirm, setTransferConfirm] = useState<Record<string, boolean | undefined>>({});
  // Success banner for a completed transfer — shown at the list level since the
  // transferred item is removed from `result.items` the moment it succeeds.
  const [transferNotice, setTransferNotice] = useState<{ message: string; url: string } | null>(null);
  const [newIssueTitle, setNewIssueTitle] = useState("");
  const [newIssueBody, setNewIssueBody] = useState("");
  const [newIssueLabels, setNewIssueLabels] = useState("");
  const [newIssueAssignees, setNewIssueAssignees] = useState("");
  const [newIssueMilestone, setNewIssueMilestone] = useState("");
  const [newIssueSubmitting, setNewIssueSubmitting] = useState(false);
  const [newIssueError, setNewIssueError] = useState<string | null>(null);
  const [newPullTitle, setNewPullTitle] = useState("");
  const [newPullBody, setNewPullBody] = useState("");
  const [newPullHead, setNewPullHead] = useState("");
  const [newPullBase, setNewPullBase] = useState("");
  const [newPullReviewers, setNewPullReviewers] = useState("");
  const [newPullDraft, setNewPullDraft] = useState(false);
  const [newPullSubmitting, setNewPullSubmitting] = useState(false);
  const [newPullError, setNewPullError] = useState<string | null>(null);
  const [newPullPushing, setNewPullPushing] = useState(false);
  const [newPullPushError, setNewPullPushError] = useState<string | null>(null);
  const [newPullPushMessage, setNewPullPushMessage] = useState<string | null>(null);
  // Task id to tag onto the next `createPull()` call — set by prefill
  // consumption below, cleared wherever composer state itself resets so a
  // later manual "New PR" from the same dialog doesn't inherit it.
  const [pullPrefillTaskId, setPullPrefillTaskId] = useState<string | null>(null);
  // Tracks which prefill object (by reference) we've started/finished
  // consuming, so a re-render with the same `pullPrefill` prop never re-fires.
  const lastPullPrefillRef = useRef<GitHubPullPrefill | null>(null);
  // Holds a prefill that part 1 (below) has pointed project/kind at but part
  // 2 (after the composer-reset effect) hasn't applied yet.
  const pendingPullPrefillRef = useRef<GitHubPullPrefill | null>(null);
  // Same one-shot-by-reference bookkeeping as the pair above, for the PR
  // detail subpage prefill instead of the New-PR composer prefill.
  const lastPullDetailPrefillRef = useRef<GitHubPullDetailPrefill | null>(null);
  const pendingPullDetailPrefillRef = useRef<GitHubPullDetailPrefill | null>(null);

  useEffect(() => {
    if (!open) return;
    setProjectPath((cur) => {
      if (initialProjectPath) return initialProjectPath;
      if (cur) return cur;
      return projects[0]?.path ?? "";
    });
  }, [open, initialProjectPath, projects]);

  // Prefill consumption, part 1 of 2: point project + kind at the prefill's
  // task. Deliberately doesn't open the composer yet — the composer-reset
  // effect below (keyed on [projectPath, kind]) would fire in the same pass
  // this causes and wipe it right back closed. Part 2, declared *after* that
  // reset effect, does the actual open+seed once project/kind have landed.
  useEffect(() => {
    if (!open || !pullPrefill) return;
    if (lastPullPrefillRef.current === pullPrefill) return;
    lastPullPrefillRef.current = pullPrefill;
    pendingPullPrefillRef.current = pullPrefill;
    setProjectPath(pullPrefill.projectPath);
    setKind("pulls");
  }, [open, pullPrefill]);

  // PR-detail prefill consumption, part 1 of 2 — same shape as the New-PR
  // prefill's part 1 above: point project + kind at the target PR, but leave
  // the actual fetch-and-navigate to part 2 (declared after the composer-
  // reset effect) so a project switch has already landed.
  useEffect(() => {
    if (!open || !pullDetailPrefill) return;
    if (lastPullDetailPrefillRef.current === pullDetailPrefill) return;
    lastPullDetailPrefillRef.current = pullDetailPrefill;
    pendingPullDetailPrefillRef.current = pullDetailPrefill;
    setProjectPath(pullDetailPrefill.projectPath);
    setKind("pulls");
  }, [open, pullDetailPrefill]);

  // Stable signal of the aggregate candidate set (G8): the joined project paths
  // when "All repositories" is selected, "" otherwise. Threaded into the reload
  // effect's deps so registering/removing a project while aggregating refreshes
  // the list — without the every-render array identity of `projects` thrashing
  // the single-repo path (where this stays a constant "").
  const aggregatePathsKey = useMemo(
    () => (isAggregate ? projects.map((p) => p.path).join("\n") : ""),
    [isAggregate, projects],
  );

  // Resolve provider-info (T5) whenever the selected project (or, in aggregate
  // mode, the candidate set) changes. Single-repo: one lookup, cached by path.
  // Aggregate: resolve every registered project (cached individually so
  // re-entering aggregate mode doesn't refetch already-known repos), then
  // collapse to "github" only if every one of them is GitHub — otherwise
  // "mixed". `provider` starts `null` each time the target changes, so a
  // stale provider from the previously-selected project can never leak onto
  // the next one while the new lookup is in flight.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const resolveOne = async (path: string): Promise<GitProvider | null> => {
      const cached = providerCache.current.get(path);
      if (cached !== undefined) return cached;
      try {
        const res = await api.getProviderInfo(path);
        const resolved = res.ok ? res.provider : null;
        providerCache.current.set(path, resolved);
        return resolved;
      } catch {
        providerCache.current.set(path, null);
        return null;
      }
    };
    if (isAggregate) {
      setProvider(null);
      void (async () => {
        const resolved = await Promise.all(projects.map((p) => resolveOne(p.path)));
        if (cancelled) return;
        setProvider(resolved.length > 0 && resolved.every((r) => r === "github") ? "github" : "mixed");
      })();
    } else if (projectPath) {
      setProvider(null);
      void resolveOne(projectPath).then((resolved) => {
        if (!cancelled) setProvider(resolved);
      });
    } else {
      setProvider(null);
    }
    return () => {
      cancelled = true;
    };
  }, [open, isAggregate, projectPath, aggregatePathsKey]);

  // While unresolved (null) or in aggregate mode with mixed providers, default
  // to GitHub's capability set so terminology/gating never flicker for the
  // (overwhelmingly common) GitHub case during the brief lookup window.
  const caps: ProviderCaps = provider === "mixed" || provider === null ? PROVIDER_CAPS.github : PROVIDER_CAPS[provider];
  // GitHub-exclusive panels (Labels/Milestones/Releases/Notifications/Actions/
  // Projects/Discussions manager buttons, per plan §8.6) require a *confirmed*
  // GitHub repo, unlike `caps` above which defaults to GitHub's flags while
  // unresolved — a manager panel that briefly appears then vanishes once a
  // non-GitHub project resolves is worse than a beat of extra latency before
  // it appears. Mixed aggregate mode has no single repo these panels could
  // act on either way.
  const panelsEnabled = provider === "github";

  // GitLab/Bitbucket have no raw search-qualifier syntax (caps.searchSyntax) —
  // if a provider switch lands on one of them while "GH mode" was left on from
  // a previously-selected GitHub project, fall back to the plain substring
  // filter rather than silently keeping the query box in a mode it can't use.
  useEffect(() => {
    if (!caps.searchSyntax && searchSyntax) setSearchSyntax(false);
  }, [caps.searchSyntax, searchSyntax]);

  // Same guard for the "Comments" sort option (GitHub-only, caps.commentSort)
  // — a provider switch away from GitHub can't leave the sort stuck on an
  // option that no longer appears in the dropdown.
  useEffect(() => {
    if (!caps.commentSort && sortField === "comments") setSortField("best-match");
  }, [caps.commentSort, sortField]);

  // `page`/`append` power the "Load more" flow (F16): a plain refresh or a
  // filter/sort change always fetches page 1 and replaces `result`; "Load
  // more" fetches `page + 1` and appends, deduped by kind+number in case a
  // page boundary shifted between requests. `requestId` reuses the existing
  // request-seq guard so a stale in-flight page (e.g. the user changed a
  // filter while "Load more" was still loading) can't land after a newer
  // fetch has already replaced the list.
  const load = async (opts?: { requestId?: number; page?: number; append?: boolean }) => {
    if (!projectPath) return;
    const requestId = opts?.requestId ?? ++requestSeq.current;
    if (requestId !== requestSeq.current) return;
    // "Load more" is disabled in aggregate mode (G8) — each fetch always
    // covers page 1 per repo, merged fresh.
    const append = !!opts?.append && !isAggregate;
    const targetPage = opts?.page ?? 1;
    if (append) setLoadingMore(true); else setLoading(true);
    setError(null);
    try {
      const next = isAggregate
        ? await api.listGitHubItemsAcrossRepos({
            paths: projects.map((p) => p.path),
            kind,
            state,
            query: searchSyntax ? "" : query,
            searchQuery: searchSyntax ? searchSubmitted : "",
            labels: splitLabels(labels),
            assignee,
            createdByMe,
            assignedToMe,
            reviewRequested: kind === "pulls" && reviewRequested,
            sort: sortField === "best-match" ? undefined : sortField,
            direction: sortDirection,
          })
        : await api.listGitHubItems({
            path: projectPath,
            kind,
            state,
            // The one search box is either a client-side substring filter or raw
            // GitHub search qualifiers (committed on Enter), depending on the GH toggle.
            query: searchSyntax ? "" : query,
            searchQuery: searchSyntax ? searchSubmitted : "",
            labels: splitLabels(labels),
            assignee,
            createdByMe,
            assignedToMe,
            reviewRequested: kind === "pulls" && reviewRequested,
            page: targetPage,
            // "best-match" → omit the sort param entirely (relevance on search,
            // created-desc default on REST).
            sort: sortField === "best-match" ? undefined : sortField,
            direction: sortDirection,
          });
      if (requestId !== requestSeq.current) return;
      setResult((cur) => {
        if (!append || !cur) return next;
        const seen = new Set(cur.items.map((it) => itemKey(it)));
        const appended = next.items.filter((it) => !seen.has(itemKey(it)));
        return { ...next, items: [...cur.items, ...appended] };
      });
    } catch (e) {
      if (requestId !== requestSeq.current) return;
      if (!append) setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestId === requestSeq.current) {
        if (append) setLoadingMore(false); else setLoading(false);
      }
    }
  };

  const loadMore = () => {
    if (isAggregate || !result || !result.hasMore || loading || loadingMore || reloadPending) return;
    const requestId = ++requestSeq.current;
    void load({ requestId, page: result.page + 1, append: true });
  };

  useEffect(() => {
    const requestId = ++requestSeq.current;
    if (!open || !projectPath) {
      setLoading(false);
      setReloadPending(false);
      return;
    }
    setReloadPending(true);
    const t = setTimeout(() => { setReloadPending(false); void load({ requestId }); }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectPath, kind, state, effectiveQuery, searchSyntax, labels, assignee, createdByMe, assignedToMe, reviewRequested, sortField, sortDirection, aggregatePathsKey]);

  useEffect(() => {
    diffSeq.current += 1;
    checksSeq.current += 1;
    commitStatusSeq.current += 1;
    mergeabilitySeq.current += 1;
    commitsSeq.current += 1;
    linkedIssuesSeq.current += 1;
    reviewCommentSeq.current += 1;
    // Only pop an open detail or compose view back to the list — a manager
    // panel (still showing the filter controls) should survive a filter
    // edit. Functional update so `view` doesn't need to be a dep (popping
    // must not re-trigger this effect on its own view-driven state changes).
    setView((cur) => (cur.kind === "detail" || cur.kind === "compose" ? backToList() : cur));
    setDiffs({});
    setDiffLoading({});
    setDiffErrors({});
    setChecks({});
    setChecksLoading({});
    setChecksErrors({});
    setCommitStatus({});
    setCommitStatusLoading({});
    setCommitStatusErrors({});
    setMergeability({});
    setMergeabilityLoading({});
    setMergeabilityErrors({});
    mergeabilityRetries.current = {};
    setCommits({});
    setCommitsLoading({});
    setCommitsErrors({});
    setLinkedIssues({});
    setLinkedIssuesLoading({});
    setLinkedIssuesErrors({});
    setComments({});
    setCommentsLoading({});
    setCommentErrors({});
    setCommentDrafts({});
    setCommentSubmitting({});
    setReviewComments({});
    setReviewThreads({});
    setReviewThreadsTruncated({});
    setReviewCommentsLoading({});
    setReviewCommentErrors({});
    setReviewReplyDrafts({});
    setReviewReplySubmitting({});
    setApplySuggestionBusy({});
    setReviewDrafts({});
    setPendingReview({});
    setPendingStale({});
    setCloseDrafts({});
    setMergeMethods({});
    setLabelDrafts({});
    setAssigneeDrafts({});
    setMilestoneDrafts({});
    setReviewerDrafts({});
    setTeamReviewerDrafts({});
    setEditorOpen({});
    setTitleDrafts({});
    setBodyDrafts({});
    setActionBusy({});
    setActionErrors({});
    setActionMessages({});
    setActionSource({});
    setLockReasonDrafts({});
    setTransferDrafts({});
    setTransferConfirm({});
    setTransferNotice(null);
  }, [projectPath, kind, state, effectiveQuery, searchSyntax, labels, assignee, createdByMe, assignedToMe, reviewRequested, sortField, sortDirection, aggregatePathsKey]);

  // "Review requested" is a PR-only qualifier — drop it when viewing issues.
  useEffect(() => {
    if (kind !== "pulls") setReviewRequested(false);
  }, [kind]);

  useEffect(() => {
    // Also pops an active compose page back to the list — this is what keeps
    // aggregate mode ("All repositories", which switches `projectPath` to the
    // synthetic aggregate value) from ever showing the compose page: a
    // project switch into aggregate fires this same effect.
    setView((cur) => (cur.kind === "compose" ? backToList() : cur));
    setNewIssueTitle("");
    setNewIssueBody("");
    setNewIssueLabels("");
    setNewIssueAssignees("");
    setNewIssueMilestone("");
    setNewIssueSubmitting(false);
    setNewIssueError(null);
    setNewPullTitle("");
    setNewPullBody("");
    setNewPullHead("");
    setNewPullBase("");
    setNewPullReviewers("");
    setNewPullDraft(false);
    setNewPullSubmitting(false);
    setNewPullError(null);
    setNewPullPushing(false);
    setNewPullPushError(null);
    setNewPullPushMessage(null);
    setPullPrefillTaskId(null);
  }, [projectPath, kind]);

  // Prefill consumption, part 2 of 2: declared *after* the reset effect above
  // and sharing its [projectPath, kind] deps, so in the render where part 1
  // changes them, both fire in the same pass — reset runs first (declaration
  // order), then this one re-opens/seeds, so the prefill wins instead of
  // being wiped back to closed/empty. Also re-checks on `pullPrefill` itself
  // for the edge case where project/kind already matched (no reset firing at
  // all) when a new prefill arrived.
  useEffect(() => {
    if (!open) return;
    const pending = pendingPullPrefillRef.current;
    if (!pending || projectPath !== pending.projectPath || kind !== "pulls") return;
    setView(openCompose());
    setNewPullHead(pending.head);
    setNewPullTitle(pending.title);
    setNewPullBody(pending.body);
    setPullPrefillTaskId(pending.taskId);
    pendingPullPrefillRef.current = null;
  }, [open, projectPath, kind, pullPrefill]);

  // PR-detail prefill consumption, part 2 of 2 — declared after the reset
  // effect for the same reason as the New-PR prefill's part 2: the reset
  // effect's `[projectPath, kind]` deps fire in the same pass as part 1's
  // `setProjectPath`/`setKind`, and declaration order makes reset run first,
  // so by the time this runs the list body wouldn't have been popped back
  // over whatever we're about to set here. Fetches the single PR by number
  // and navigates to its detail subpage; guards against a stale in-flight
  // fetch (dialog closed/reopened, or these deps re-firing for another
  // reason) via the effect's own `cancelled` cleanup flag, same pattern as
  // any other fetch-in-effect. Falls back to the plain external link on any
  // failure — including a well-formed `{ ok: false }` body, in case a future
  // server change starts returning one instead of a non-2xx status.
  useEffect(() => {
    if (!open) return;
    const pending = pendingPullDetailPrefillRef.current;
    if (!pending || projectPath !== pending.projectPath || kind !== "pulls") return;
    pendingPullDetailPrefillRef.current = null;
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.getGitHubPullDetail(pending.projectPath, pending.number);
        if (cancelled) return;
        if (!result?.ok || !result.item) throw new Error("Pull request not found");
        setView(openDetail(result.item));
      } catch (err) {
        if (cancelled) return;
        toast.error(err instanceof Error ? err.message : "Could not load the pull request");
        void api.openExternal(pending.prUrl);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectPath, kind, pullDetailPrefill]);

  // Close wipes both composers' field state + prefill bookkeeping, and pops an
  // active compose page back to the list. Without the pull-composer half of
  // this, the dialog (which stays mounted) reopens later — often on the SAME
  // project, since `initialProjectPath` falls back to the selected task's
  // workdir, so the [projectPath, kind] reset above never fires — with the
  // previous task's seeded composer and, worse, its `pullPrefillTaskId` still
  // armed: a manual "New PR" would then stamp an unrelated PR's URL onto that
  // task. The issue-composer fields are cleared here too (previously only the
  // pull composer was — issue-composer state used to leak across opens).
  // Detail/panel views are deliberately left untouched — they already survive
  // close/reopen, and that's unrelated to this cleanup.
  useEffect(() => {
    if (open) return;
    setView((cur) => (cur.kind === "compose" ? backToList() : cur));
    setNewIssueTitle("");
    setNewIssueBody("");
    setNewIssueLabels("");
    setNewIssueAssignees("");
    setNewIssueMilestone("");
    setNewIssueSubmitting(false);
    setNewIssueError(null);
    setNewPullTitle("");
    setNewPullBody("");
    setNewPullHead("");
    setNewPullBase("");
    setPullPrefillTaskId(null);
    pendingPullPrefillRef.current = null;
    lastPullPrefillRef.current = null;
    pendingPullDetailPrefillRef.current = null;
    lastPullDetailPrefillRef.current = null;
  }, [open]);

  const availableLabels = useMemo(() => {
    // Prefer the full repo-label list; fall back to labels seen on loaded items
    // (e.g. before the labels fetch resolves or when unauthenticated).
    const names = new Set<string>(repoLabels.map((l) => l.name));
    for (const item of result?.items ?? []) {
      for (const label of item.labels) names.add(label.name);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [result, repoLabels]);

  const projectOptions = useMemo(() => {
    const opts = projects.map((p) => ({ path: p.path, label: p.name || basename(p.path) || p.path }));
    if (projectPath && projectPath !== AGGREGATE_PROJECT_PATH && !opts.some((p) => p.path === projectPath)) {
      opts.unshift({ path: projectPath, label: basename(projectPath) || projectPath });
    }
    // "All repositories" (G8/F15) always leads the list — the backend filters
    // the candidate paths down to the ones with a GitHub remote.
    opts.unshift({ path: AGGREGATE_PROJECT_PATH, label: "All repositories" });
    return opts;
  }, [projects, projectPath]);

  const expandedItem = useMemo(() => {
    if (view.kind !== "detail") return null;
    // Re-resolve against the freshest `result.items` (by composite key) so the
    // detail subpage reflects live updates (labels, state, …) the same way the
    // old accordion did; fall back to the snapshot captured on navigation if
    // the item has since dropped out of the filtered results.
    return result?.items.find((candidate) => itemKey(candidate) === itemKey(view.item)) ?? view.item;
  }, [view, result]);
  // Resolved path for the currently-expanded item's per-item data fetches
  // (diff/checks/mergeability/commits/linkedIssues/comments/reviewComments) —
  // falls back to `projectPath` in single-repo mode; in aggregate mode every
  // item carries its own repo's `sourcePath` from the merge in
  // `listGitHubItemsAcrossRepos`.
  const expandedItemPath = expandedItem?.sourcePath ?? projectPath;

  /** Small "owner/name"-ish badge shown on each row in aggregate mode (G8) —
   *  the local project's display name for `item.sourcePath`, matching what the
   *  project selector already shows for that project. */
  const repoLabelFor = (item: GitHubListItem): string => {
    if (!item.sourcePath) return "";
    const proj = projects.find((p) => p.path === item.sourcePath);
    return proj?.name || basename(item.sourcePath) || item.sourcePath;
  };

  useEffect(() => {
    if (!open || viewerResolved.current) return;
    // The viewer's login is token-scoped, not repo-scoped, so any repo with a
    // GitHub remote can resolve it. In aggregate mode (G8) there's no single
    // `projectPath` to ask, so try each registered project in order until one
    // succeeds — falling back to just `projects[0]` would leave the login empty
    // forever if that first project happens to have no GitHub remote (a
    // no-remote lookup rejects, and the deps here don't retry per-project).
    const candidates = isAggregate ? projects.map((p) => p.path) : (projectPath ? [projectPath] : []);
    if (candidates.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const p of candidates) {
        if (cancelled) return;
        try {
          const r = await api.getGitHubViewer({ path: p });
          if (cancelled) return;
          setViewerLogin(r.login);
          viewerResolved.current = true;
          return; // first project with a GitHub remote wins
        } catch {
          // No remote / lookup failed — try the next candidate.
        }
      }
    })();
    return () => { cancelled = true; };
  }, [open, projectPath, isAggregate, projects]);

  // Push access (F13) is per-repo, so re-resolve on every project switch —
  // unlike the viewer login above. Stays optimistic (canPush=true) while a
  // fresh project's check is in flight so controls aren't disabled during
  // that brief window; only flips to disabled once resolved false.
  useEffect(() => {
    if (!open) return;
    if (isAggregate) {
      // canPush varies per repo in aggregate mode (G8) — resolving it per item
      // would mean one permissions round-trip per repo per row. Simpler and
      // still correct: gate optimistically (assume push, let GitHub reject a
      // write with a real error) rather than disabling every push-only control.
      setCanPush(true);
      canPushResolvedFor.current = null; // force re-resolve if the user switches back to a single repo
      return;
    }
    if (!projectPath || canPushResolvedFor.current === projectPath) return;
    let cancelled = false;
    setCanPush(true);
    api.getGitHubRepoPermissions({ path: projectPath })
      .then((r) => {
        if (cancelled) return;
        setCanPush(r.push);
        canPushResolvedFor.current = projectPath;
      })
      // Leave unresolved on failure (e.g. no remote): `canPushResolvedFor` isn't
      // set, so this project re-resolves the next time the effect's deps change
      // (a project switch back to it, or the dialog reopening) rather than
      // caching a wrongly-optimistic value permanently.
      .catch(() => { /* keep the current (optimistic) canPush */ });
    return () => { cancelled = true; };
  }, [open, projectPath, isAggregate]);

  const refreshRepoLabels = async () => {
    if (!projectPath) return;
    try {
      const r = await api.listGitHubLabels({ path: projectPath });
      setRepoLabels(r.labels);
    } catch {
      // Labels are convenience (datalist + manager); ignore fetch failures.
    }
  };

  const sortLabels = (ls: GitHubRepoLabel[]) => [...ls].sort((a, b) => a.name.localeCompare(b.name));

  const createLabel = async (name: string, color: string, description: string) => {
    if (!projectPath) throw new Error("no project selected");
    const { label } = await api.createGitHubLabel({ path: projectPath, name, color, description });
    setRepoLabels((cur) => sortLabels([...cur.filter((l) => l.name !== label.name), label]));
  };

  const editLabel = async (name: string, patch: { newName?: string; color?: string; description?: string }) => {
    if (!projectPath) throw new Error("no project selected");
    const { label } = await api.updateGitHubLabel({ path: projectPath, name, ...patch });
    setRepoLabels((cur) => sortLabels([...cur.filter((l) => l.name !== name), label]));
    // Reconcile the renamed/recolored label on any loaded item so its badge
    // doesn't show the stale name/color.
    setResult((cur) => cur && {
      ...cur,
      items: cur.items.map((it) => ({
        ...it,
        labels: it.labels.map((l) => (l.name === name ? { name: label.name, color: label.color } : l)),
      })),
    });
  };

  const removeLabel = async (name: string) => {
    if (!projectPath) throw new Error("no project selected");
    await api.deleteGitHubLabel({ path: projectPath, name });
    setRepoLabels((cur) => cur.filter((l) => l.name !== name));
    // Drop the deleted label from any loaded item that carried it.
    setResult((cur) => cur && {
      ...cur,
      items: cur.items.map((it) => ({ ...it, labels: it.labels.filter((l) => l.name !== name) })),
    });
  };

  useEffect(() => {
    // Repo labels are single-repo data (the datalist + LabelManager, both
    // disabled in aggregate mode) — skip the fetch entirely rather than
    // hitting the aggregate sentinel path.
    if (!open || !projectPath || isAggregate) { setRepoLabels([]); return; }
    let cancelled = false;
    api.listGitHubLabels({ path: projectPath })
      .then((r) => { if (!cancelled) setRepoLabels(r.labels); })
      .catch(() => { if (!cancelled) setRepoLabels([]); });
    return () => { cancelled = true; };
  }, [open, projectPath, isAggregate]);

  // Sort open milestones before closed, then by due date (undated last), then title.
  // Applied on every set (load, refresh, and optimistic mutation) so the order is
  // stable from first paint rather than reshuffling after the first change.
  const sortMilestones = (ms: GitHubRepoMilestone[]) =>
    [...ms].sort((a, b) => {
      if (a.state !== b.state) return a.state === "open" ? -1 : 1;
      if (a.dueOn !== b.dueOn) {
        if (!a.dueOn) return 1;
        if (!b.dueOn) return -1;
        return a.dueOn.localeCompare(b.dueOn);
      }
      return a.title.localeCompare(b.title);
    });

  const refreshRepoMilestones = async () => {
    if (!projectPath) return;
    try {
      const r = await api.listGitHubMilestones({ path: projectPath });
      setRepoMilestones(sortMilestones(r.milestones));
    } catch {
      // Milestones are convenience (manager only); ignore fetch failures.
    }
  };

  const createMilestone = async (title: string, description: string, dueOn: string) => {
    if (!projectPath) throw new Error("no project selected");
    const { milestone } = await api.createGitHubMilestone({ path: projectPath, title, description, dueOn: dueOn || undefined });
    setRepoMilestones((cur) => sortMilestones([...cur, milestone]));
  };

  const editMilestone = async (
    number: number,
    patch: { title?: string; description?: string; dueOn?: string | null; state?: "open" | "closed" },
  ) => {
    if (!projectPath) throw new Error("no project selected");
    const { milestone } = await api.updateGitHubMilestone({ path: projectPath, number, ...patch });
    setRepoMilestones((cur) => sortMilestones(cur.map((m) => (m.number === number ? milestone : m))));
    // Reconcile the renamed milestone on any loaded item so its badge stays fresh.
    setResult((cur) => cur && {
      ...cur,
      items: cur.items.map((it) =>
        it.milestone && it.milestone.number === number
          ? { ...it, milestone: { number: milestone.number, title: milestone.title } }
          : it,
      ),
    });
  };

  const removeMilestone = async (number: number) => {
    if (!projectPath) throw new Error("no project selected");
    await api.deleteGitHubMilestone({ path: projectPath, number });
    setRepoMilestones((cur) => cur.filter((m) => m.number !== number));
    // Drop the deleted milestone from any loaded item that carried it.
    setResult((cur) => cur && {
      ...cur,
      items: cur.items.map((it) =>
        it.milestone && it.milestone.number === number ? { ...it, milestone: null } : it,
      ),
    });
  };

  useEffect(() => {
    if (!open || !projectPath || isAggregate) { setRepoMilestones([]); return; }
    let cancelled = false;
    api.listGitHubMilestones({ path: projectPath })
      .then((r) => { if (!cancelled) setRepoMilestones(sortMilestones(r.milestones)); })
      .catch(() => { if (!cancelled) setRepoMilestones([]); });
    return () => { cancelled = true; };
  }, [open, projectPath, isAggregate]);

  useEffect(() => {
    if (!open || !projectPath || isAggregate) { setRepoAssignees([]); return; }
    let cancelled = false;
    api.listGitHubAssignees({ path: projectPath })
      .then((r) => { if (!cancelled) setRepoAssignees(r.assignees); })
      .catch(() => { if (!cancelled) setRepoAssignees([]); });
    return () => { cancelled = true; };
  }, [open, projectPath, isAggregate]);

  // Newest first (by publishedAt, falling back to createdAt for drafts) — the
  // server already sorts this way, but re-sort after every mutation so the
  // manager's own create/edit doesn't reshuffle the list out of order.
  const sortReleases = (rs: GitHubRelease[]) =>
    [...rs].sort((a, b) => (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt));

  const refreshRepoReleases = async () => {
    if (!projectPath) return;
    try {
      const r = await api.listGitHubReleases({ path: projectPath });
      setRepoReleases(sortReleases(r.releases));
    } catch {
      // Releases are manager-only convenience data; ignore fetch failures.
    }
  };

  const createRelease = async (
    tagName: string,
    name: string,
    body: string,
    draft: boolean,
    prerelease: boolean,
  ) => {
    if (!projectPath) throw new Error("no project selected");
    const { release } = await api.createGitHubRelease({ path: projectPath, tagName, name, body, draft, prerelease });
    setRepoReleases((cur) => sortReleases([...cur, release]));
  };

  const editRelease = async (
    id: number,
    patch: { name?: string; body?: string; draft?: boolean; prerelease?: boolean; tagName?: string },
  ) => {
    if (!projectPath) throw new Error("no project selected");
    const { release } = await api.updateGitHubRelease({ path: projectPath, id, ...patch });
    setRepoReleases((cur) => sortReleases(cur.map((r) => (r.id === id ? release : r))));
  };

  const removeRelease = async (id: number) => {
    if (!projectPath) throw new Error("no project selected");
    await api.deleteGitHubRelease({ path: projectPath, id });
    setRepoReleases((cur) => cur.filter((r) => r.id !== id));
  };

  useEffect(() => {
    if (!open || !projectPath || isAggregate) { setRepoReleases([]); return; }
    let cancelled = false;
    api.listGitHubReleases({ path: projectPath })
      .then((r) => { if (!cancelled) setRepoReleases(sortReleases(r.releases)); })
      .catch(() => { if (!cancelled) setRepoReleases([]); });
    return () => { cancelled = true; };
  }, [open, projectPath, isAggregate]);

  // Tags are manager-only convenience data (the create-release tag datalist),
  // so — like notifications — fetched lazily only while the panel is open
  // rather than unconditionally on every project switch.
  useEffect(() => {
    if (!open || !releaseManagerOpen || !projectPath || isAggregate) { setRepoTags([]); return; }
    let cancelled = false;
    api.listGitHubTags({ path: projectPath })
      .then((r) => { if (!cancelled) setRepoTags(r.tags); })
      .catch(() => { if (!cancelled) setRepoTags([]); });
    return () => { cancelled = true; };
  }, [open, releaseManagerOpen, projectPath, isAggregate]);

  // Lazy — only fetches while the panel is open (notifications are private
  // and the fetch itself surfaces the sign-in error, so there's no point
  // preloading before the user opens the panel).
  useEffect(() => {
    // The toolbar button that opens this panel is disabled in aggregate mode
    // (notifications are single-repo), so `isAggregate` is defense-in-depth.
    if (!open || !notificationsOpen || !projectPath || isAggregate) return;
    const requestId = ++notificationsSeq.current;
    setNotificationsLoading(true);
    setNotificationsError(null);
    api.listGitHubNotifications({ path: projectPath, all: notificationsShowAll })
      .then((r) => { if (requestId === notificationsSeq.current) setNotifications(r.notifications); })
      .catch((e) => { if (requestId === notificationsSeq.current) setNotificationsError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (requestId === notificationsSeq.current) setNotificationsLoading(false); });
  }, [open, notificationsOpen, projectPath, notificationsShowAll, isAggregate]);

  const refreshNotifications = async () => {
    if (!projectPath) return;
    const requestId = ++notificationsSeq.current;
    setNotificationsLoading(true);
    setNotificationsError(null);
    try {
      const r = await api.listGitHubNotifications({ path: projectPath, all: notificationsShowAll });
      if (requestId === notificationsSeq.current) setNotifications(r.notifications);
    } catch (e) {
      if (requestId === notificationsSeq.current) setNotificationsError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestId === notificationsSeq.current) setNotificationsLoading(false);
    }
  };

  const markNotificationRead = async (id: string) => {
    if (!projectPath) return;
    setNotificationBusy((cur) => ({ ...cur, [id]: "read" }));
    setNotificationRowErrors((cur) => ({ ...cur, [id]: undefined }));
    try {
      await api.markGitHubNotificationRead({ path: projectPath, threadId: id });
      // Unread-only view: the read thread no longer matches the filter, drop
      // it. "All" view: keep the row but clear its unread dot.
      setNotifications((cur) => (
        notificationsShowAll
          ? cur.map((n) => (n.id === id ? { ...n, unread: false } : n))
          : cur.filter((n) => n.id !== id)
      ));
    } catch (e) {
      setNotificationRowErrors((cur) => ({ ...cur, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setNotificationBusy((cur) => ({ ...cur, [id]: undefined }));
    }
  };

  const markAllNotificationsRead = async () => {
    if (!projectPath || notificationsMarkAllBusy) return;
    setNotificationsMarkAllBusy(true);
    setNotificationsError(null);
    try {
      await api.markAllGitHubNotificationsRead({ path: projectPath });
      setNotifications((cur) => (
        notificationsShowAll ? cur.map((n) => ({ ...n, unread: false })) : []
      ));
    } catch (e) {
      setNotificationsError(e instanceof Error ? e.message : String(e));
    } finally {
      setNotificationsMarkAllBusy(false);
    }
  };

  const ignoreNotificationThread = async (id: string) => {
    if (!projectPath) return;
    setNotificationBusy((cur) => ({ ...cur, [id]: "ignore" }));
    setNotificationRowErrors((cur) => ({ ...cur, [id]: undefined }));
    try {
      await api.setGitHubThreadSubscription({ path: projectPath, threadId: id, ignored: true });
      // Ignoring a thread also marks it read on GitHub — mirror mark-read so the
      // user sees the action land (drop in unread view, clear the dot in "all").
      setNotifications((cur) => (
        notificationsShowAll
          ? cur.map((n) => (n.id === id ? { ...n, unread: false } : n))
          : cur.filter((n) => n.id !== id)
      ));
    } catch (e) {
      setNotificationRowErrors((cur) => ({ ...cur, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setNotificationBusy((cur) => ({ ...cur, [id]: undefined }));
    }
  };

  const unsubscribeNotificationThread = async (id: string) => {
    if (!projectPath) return;
    setNotificationBusy((cur) => ({ ...cur, [id]: "unsubscribe" }));
    setNotificationRowErrors((cur) => ({ ...cur, [id]: undefined }));
    try {
      await api.unsubscribeGitHubThread({ path: projectPath, threadId: id });
      // Unsubscribed — the user won't get further updates, so drop it from the
      // unread view (clear the dot in "all") to acknowledge the action.
      setNotifications((cur) => (
        notificationsShowAll
          ? cur.map((n) => (n.id === id ? { ...n, unread: false } : n))
          : cur.filter((n) => n.id !== id)
      ));
    } catch (e) {
      setNotificationRowErrors((cur) => ({ ...cur, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setNotificationBusy((cur) => ({ ...cur, [id]: undefined }));
    }
  };

  // Lazy — like notifications/tags, only fetched while the Actions panel is
  // open. Fetches runs + workflows together since both power the same panel.
  useEffect(() => {
    // The toolbar button that opens this panel is disabled in aggregate mode
    // (Actions is single-repo), so `isAggregate` is defense-in-depth.
    if (!open || !actionsManagerOpen || !projectPath || isAggregate) return;
    const requestId = ++actionsSeq.current;
    setActionsLoading(true);
    setActionsError(null);
    Promise.all([
      api.listGitHubWorkflowRuns({ path: projectPath }),
      api.listGitHubWorkflows({ path: projectPath }),
    ])
      .then(([runsRes, workflowsRes]) => {
        if (requestId !== actionsSeq.current) return;
        setWorkflowRuns(runsRes.runs);
        setWorkflows(workflowsRes.workflows);
      })
      .catch((e) => { if (requestId === actionsSeq.current) setActionsError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (requestId === actionsSeq.current) setActionsLoading(false); });
  }, [open, actionsManagerOpen, projectPath, isAggregate]);

  const refreshActions = async () => {
    // Guard the deferred post-dispatch refresh (a 1.5s timer): if the panel was
    // closed in the meantime, skip the fetch + state writes for a dead panel.
    if (!projectPath || !actionsManagerOpen) return;
    const requestId = ++actionsSeq.current;
    setActionsLoading(true);
    setActionsError(null);
    try {
      const [runsRes, workflowsRes] = await Promise.all([
        api.listGitHubWorkflowRuns({ path: projectPath }),
        api.listGitHubWorkflows({ path: projectPath }),
      ]);
      if (requestId === actionsSeq.current) {
        setWorkflowRuns(runsRes.runs);
        setWorkflows(workflowsRes.workflows);
      }
    } catch (e) {
      if (requestId === actionsSeq.current) setActionsError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestId === actionsSeq.current) setActionsLoading(false);
    }
  };

  const rerunWorkflowRun = async (runId: number, failedOnly: boolean) => {
    if (!projectPath) return;
    const action = failedOnly ? "rerun-failed" : "rerun";
    setWorkflowRunBusy((cur) => ({ ...cur, [runId]: action }));
    setWorkflowRunErrors((cur) => ({ ...cur, [runId]: undefined }));
    try {
      await api.rerunGitHubWorkflowRun({ path: projectPath, runId, failedOnly });
      // Optimistic: reflect the queued re-run immediately rather than waiting
      // for a manual refresh — GitHub takes a moment to actually restart it.
      setWorkflowRuns((cur) => cur.map((r) => (r.id === runId ? { ...r, status: "queued", conclusion: null } : r)));
    } catch (e) {
      setWorkflowRunErrors((cur) => ({ ...cur, [runId]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setWorkflowRunBusy((cur) => ({ ...cur, [runId]: undefined }));
    }
  };

  const cancelWorkflowRun = async (runId: number) => {
    if (!projectPath) return;
    setWorkflowRunBusy((cur) => ({ ...cur, [runId]: "cancel" }));
    setWorkflowRunErrors((cur) => ({ ...cur, [runId]: undefined }));
    try {
      await api.cancelGitHubWorkflowRun({ path: projectPath, runId });
      setWorkflowRuns((cur) => cur.map((r) => (r.id === runId ? { ...r, status: "completed", conclusion: "cancelled" } : r)));
    } catch (e) {
      setWorkflowRunErrors((cur) => ({ ...cur, [runId]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setWorkflowRunBusy((cur) => ({ ...cur, [runId]: undefined }));
    }
  };

  const addDispatchInputRow = () => setDispatchInputs((cur) => [...cur, { key: "", value: "" }]);
  const removeDispatchInputRow = (index: number) => setDispatchInputs((cur) => cur.filter((_, i) => i !== index));
  const updateDispatchInputRow = (index: number, patch: Partial<{ key: string; value: string }>) =>
    setDispatchInputs((cur) => cur.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const dispatchWorkflow = async () => {
    if (!projectPath || dispatchBusy) return;
    const workflowId = Number(dispatchWorkflowId);
    const ref = dispatchRef.trim();
    if (!Number.isInteger(workflowId) || workflowId <= 0 || !ref) return;
    setDispatchBusy(true);
    setDispatchError(null);
    setDispatchMessage(null);
    try {
      const inputs: Record<string, string> = {};
      for (const row of dispatchInputs) {
        const key = row.key.trim();
        if (key) inputs[key] = row.value;
      }
      const res = await api.dispatchGitHubWorkflow({
        path: projectPath,
        workflowId,
        ref,
        inputs: Object.keys(inputs).length > 0 ? inputs : undefined,
      });
      setDispatchMessage(res.message);
      // Give GitHub a beat to register the run, then refresh the list so the
      // new dispatch shows up without a manual click.
      setTimeout(() => { void refreshActions(); }, 1500);
    } catch (e) {
      setDispatchError(e instanceof Error ? e.message : String(e));
    } finally {
      setDispatchBusy(false);
    }
  };

  // Projects v2 (F21/G11) — repo-linked project boards. Lazy — like
  // notifications/actions, only fetched while the manager is open. Scope
  // decision A1: manage items + status on EXISTING projects, not creation or
  // field-schema edits.
  const [projectsV2, setProjectsV2] = useState<GitHubProjectV2[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const projectsSeq = useRef(0);
  // The selected board's own items, fetched once a project is picked from the
  // panel's project <Select>. Cleared whenever the selection or project path
  // changes so a stale board's items can't linger under a new selection.
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [projectItems, setProjectItems] = useState<GitHubProjectItem[]>([]);
  const [projectStatusField, setProjectStatusField] = useState<GitHubProjectField | null>(null);
  const [projectItemsLoading, setProjectItemsLoading] = useState(false);
  const [projectItemsError, setProjectItemsError] = useState<string | null>(null);
  const projectItemsSeq = useRef(0);
  // Per-item in-flight action ("status" | "remove") and the last error for
  // that item, both keyed by itemId — mirrors the workflow-run busy/error maps.
  const [projectItemBusy, setProjectItemBusy] = useState<Record<string, string | undefined>>({});
  const [projectItemErrors, setProjectItemErrors] = useState<Record<string, string | undefined>>({});
  // "Add issue/PR by #number" form state.
  const [projectAddNumber, setProjectAddNumber] = useState("");
  const [projectAddKind, setProjectAddKind] = useState<"issue" | "pr">("issue");
  const [projectAddBusy, setProjectAddBusy] = useState(false);
  const [projectAddError, setProjectAddError] = useState<string | null>(null);

  useEffect(() => {
    // The toolbar button that opens this panel is disabled in aggregate mode
    // (Projects v2 is single-repo), so `isAggregate` is defense-in-depth.
    if (!open || !projectsManagerOpen || !projectPath || isAggregate) return;
    const requestId = ++projectsSeq.current;
    setProjectsLoading(true);
    setProjectsError(null);
    api.listGitHubProjectsV2({ path: projectPath })
      .then((r) => { if (requestId === projectsSeq.current) setProjectsV2(r.projects); })
      .catch((e) => { if (requestId === projectsSeq.current) setProjectsError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (requestId === projectsSeq.current) setProjectsLoading(false); });
  }, [open, projectsManagerOpen, projectPath, isAggregate]);

  const refreshProjects = async () => {
    if (!projectPath || !projectsManagerOpen) return;
    const requestId = ++projectsSeq.current;
    setProjectsLoading(true);
    setProjectsError(null);
    try {
      const r = await api.listGitHubProjectsV2({ path: projectPath });
      if (requestId === projectsSeq.current) setProjectsV2(r.projects);
    } catch (e) {
      if (requestId === projectsSeq.current) setProjectsError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestId === projectsSeq.current) setProjectsLoading(false);
    }
  };

  // A project switch (or the panel/project changing under it) drops the
  // previously selected board — its items belong to a project that may no
  // longer even be in `projectsV2`.
  useEffect(() => {
    setSelectedProjectId("");
    setProjectItems([]);
    setProjectStatusField(null);
    setProjectItemsError(null);
  }, [projectPath, isAggregate, projectsManagerOpen]);

  // Switching the selected board also clears the add-form + per-item feedback so
  // a stale "add #5 failed" banner from board A doesn't linger under board B.
  useEffect(() => {
    setProjectAddNumber("");
    setProjectAddError(null);
    setProjectItemErrors({});
    setProjectItemBusy({});
  }, [selectedProjectId]);

  useEffect(() => {
    if (!open || !projectsManagerOpen || !projectPath || isAggregate || !selectedProjectId) return;
    const requestId = ++projectItemsSeq.current;
    setProjectItemsLoading(true);
    setProjectItemsError(null);
    api.getGitHubProjectItems({ path: projectPath, projectId: selectedProjectId })
      .then((r) => {
        if (requestId !== projectItemsSeq.current) return;
        setProjectItems(r.items);
        setProjectStatusField(r.statusField);
      })
      .catch((e) => { if (requestId === projectItemsSeq.current) setProjectItemsError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (requestId === projectItemsSeq.current) setProjectItemsLoading(false); });
  }, [open, projectsManagerOpen, projectPath, isAggregate, selectedProjectId]);

  const refreshProjectItems = async () => {
    if (!projectPath || !selectedProjectId) return;
    const requestId = ++projectItemsSeq.current;
    setProjectItemsLoading(true);
    setProjectItemsError(null);
    try {
      const r = await api.getGitHubProjectItems({ path: projectPath, projectId: selectedProjectId });
      if (requestId === projectItemsSeq.current) {
        setProjectItems(r.items);
        setProjectStatusField(r.statusField);
      }
    } catch (e) {
      if (requestId === projectItemsSeq.current) setProjectItemsError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestId === projectItemsSeq.current) setProjectItemsLoading(false);
    }
  };

  const setProjectItemStatus = async (itemId: string, optionId: string, optionName: string) => {
    if (!projectPath || !selectedProjectId || !projectStatusField) return;
    setProjectItemBusy((cur) => ({ ...cur, [itemId]: "status" }));
    setProjectItemErrors((cur) => ({ ...cur, [itemId]: undefined }));
    // Optimistic — reflect the new status immediately rather than waiting on
    // a refetch; reverted (implicitly, by the row's own error text) if the
    // mutation below fails.
    const previous = projectItems.find((it) => it.itemId === itemId);
    setProjectItems((cur) => cur.map((it) => (it.itemId === itemId ? { ...it, statusOptionId: optionId, statusOptionName: optionName } : it)));
    try {
      await api.setGitHubProjectItemStatus({
        path: projectPath,
        projectId: selectedProjectId,
        itemId,
        fieldId: projectStatusField.id,
        optionId,
      });
    } catch (e) {
      setProjectItemErrors((cur) => ({ ...cur, [itemId]: e instanceof Error ? e.message : String(e) }));
      if (previous) {
        setProjectItems((cur) => cur.map((it) => (it.itemId === itemId ? previous : it)));
      }
    } finally {
      setProjectItemBusy((cur) => ({ ...cur, [itemId]: undefined }));
    }
  };

  const removeProjectItem = async (itemId: string) => {
    if (!projectPath || !selectedProjectId) return;
    setProjectItemBusy((cur) => ({ ...cur, [itemId]: "remove" }));
    setProjectItemErrors((cur) => ({ ...cur, [itemId]: undefined }));
    try {
      await api.removeGitHubProjectItem({ path: projectPath, projectId: selectedProjectId, itemId });
      setProjectItems((cur) => cur.filter((it) => it.itemId !== itemId)); // success unmounts this row
    } catch (e) {
      setProjectItemErrors((cur) => ({ ...cur, [itemId]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setProjectItemBusy((cur) => ({ ...cur, [itemId]: undefined }));
    }
  };

  const addProjectItem = async () => {
    if (!projectPath || !selectedProjectId || projectAddBusy) return;
    const num = Number(projectAddNumber);
    if (!Number.isInteger(num) || num <= 0) return;
    setProjectAddBusy(true);
    setProjectAddError(null);
    try {
      await api.addGitHubProjectItem({
        path: projectPath,
        projectId: selectedProjectId,
        contentNumber: num,
        contentKind: projectAddKind,
      });
      setProjectAddNumber("");
      // The add mutation only returns the new item's id, not its title/number/
      // content type — refetch to pick those up (explicitly allowed by spec).
      await refreshProjectItems();
    } catch (e) {
      setProjectAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setProjectAddBusy(false);
    }
  };

  // Discussions (GraphQL-only — F22/G12). Lazy, like Projects/Actions/
  // Notifications: only fetched while the manager is open. `discussionsAuth`
  // mirrors `GitHubListResult.auth` — create/comment/answer are gated on
  // `discussionsAuth !== "none"` (any authenticated user), NOT on `canPush`,
  // per the G12 gating note; delete is gated on own-content OR `canPush`.
  const [discussions, setDiscussions] = useState<GitHubDiscussion[]>([]);
  const [discussionCategories, setDiscussionCategories] = useState<GitHubDiscussionCategory[]>([]);
  const [discussionsAuth, setDiscussionsAuth] = useState<"token" | "none">("none");
  const [discussionsLoading, setDiscussionsLoading] = useState(false);
  const [discussionsError, setDiscussionsError] = useState<string | null>(null);
  const discussionsSeq = useRef(0);
  // The selected thread's detail (body + comments), fetched once a discussion
  // row is expanded.
  const [selectedDiscussion, setSelectedDiscussion] = useState<GitHubDiscussion | null>(null);
  const [discussionDetail, setDiscussionDetail] = useState<GitHubDiscussionDetail | null>(null);
  const [discussionDetailLoading, setDiscussionDetailLoading] = useState(false);
  const [discussionDetailError, setDiscussionDetailError] = useState<string | null>(null);
  const discussionDetailSeq = useRef(0);
  const [discussionCommentDraft, setDiscussionCommentDraft] = useState("");
  const [discussionCommentBusy, setDiscussionCommentBusy] = useState(false);
  const [discussionCommentError, setDiscussionCommentError] = useState<string | null>(null);
  // Per-comment in-flight action ("answer" | "delete") and last error, keyed
  // by comment id — mirrors `projectItemBusy`/`projectItemErrors`.
  const [discussionCommentBusyMap, setDiscussionCommentBusyMap] = useState<Record<string, string | undefined>>({});
  const [discussionCommentErrors, setDiscussionCommentErrors] = useState<Record<string, string | undefined>>({});
  // Per-row (list) busy/error for deleting a whole discussion.
  const [discussionRowBusy, setDiscussionRowBusy] = useState<Record<string, boolean>>({});
  const [discussionRowErrors, setDiscussionRowErrors] = useState<Record<string, string | undefined>>({});
  // "New discussion" composer.
  const [discussionCreateOpen, setDiscussionCreateOpen] = useState(false);
  const [newDiscussionCategoryId, setNewDiscussionCategoryId] = useState("");
  const [newDiscussionTitle, setNewDiscussionTitle] = useState("");
  const [newDiscussionBody, setNewDiscussionBody] = useState("");
  const [discussionCreateBusy, setDiscussionCreateBusy] = useState(false);
  const [discussionCreateError, setDiscussionCreateError] = useState<string | null>(null);

  useEffect(() => {
    // The toolbar button that opens this panel is disabled in aggregate mode
    // (Discussions is single-repo), so `isAggregate` is defense-in-depth.
    if (!open || !discussionsManagerOpen || !projectPath || isAggregate) return;
    const requestId = ++discussionsSeq.current;
    setDiscussionsLoading(true);
    setDiscussionsError(null);
    api.listGitHubDiscussions({ path: projectPath })
      .then((r) => {
        if (requestId !== discussionsSeq.current) return;
        setDiscussions(r.discussions);
        setDiscussionCategories(r.categories);
        setDiscussionsAuth(r.auth);
      })
      .catch((e) => { if (requestId === discussionsSeq.current) setDiscussionsError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (requestId === discussionsSeq.current) setDiscussionsLoading(false); });
  }, [open, discussionsManagerOpen, projectPath, isAggregate]);

  const refreshDiscussions = async () => {
    if (!projectPath || !discussionsManagerOpen) return;
    const requestId = ++discussionsSeq.current;
    setDiscussionsLoading(true);
    setDiscussionsError(null);
    try {
      const r = await api.listGitHubDiscussions({ path: projectPath });
      if (requestId === discussionsSeq.current) {
        setDiscussions(r.discussions);
        setDiscussionCategories(r.categories);
        setDiscussionsAuth(r.auth);
      }
    } catch (e) {
      if (requestId === discussionsSeq.current) setDiscussionsError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestId === discussionsSeq.current) setDiscussionsLoading(false);
    }
  };

  // A project switch (or the panel closing) drops the previously selected
  // thread and any composer drafts tied to it — same reasoning as
  // `useEffect` clearing `selectedProjectId` on project switch.
  useEffect(() => {
    setSelectedDiscussion(null);
    setDiscussionDetail(null);
    setDiscussionDetailError(null);
    setDiscussionCreateOpen(false);
    setDiscussionCreateError(null);
    setNewDiscussionCategoryId("");
    setNewDiscussionTitle("");
    setNewDiscussionBody("");
  }, [projectPath, isAggregate, discussionsManagerOpen]);

  // Default the create form's category picker to the first one loaded, so the
  // <Select> isn't left on a blank option once categories arrive.
  useEffect(() => {
    if (discussionCategories.length === 0) return;
    setNewDiscussionCategoryId((cur) => cur || discussionCategories[0]!.id);
  }, [discussionCategories]);

  useEffect(() => {
    setDiscussionCommentDraft("");
    setDiscussionCommentError(null);
    setDiscussionCommentBusyMap({});
    setDiscussionCommentErrors({});
  }, [selectedDiscussion]);

  useEffect(() => {
    if (!open || !discussionsManagerOpen || !projectPath || isAggregate || !selectedDiscussion) return;
    const requestId = ++discussionDetailSeq.current;
    setDiscussionDetailLoading(true);
    setDiscussionDetailError(null);
    api.getGitHubDiscussion({ path: projectPath, number: selectedDiscussion.number })
      .then((r) => { if (requestId === discussionDetailSeq.current) setDiscussionDetail(r.detail); })
      .catch((e) => { if (requestId === discussionDetailSeq.current) setDiscussionDetailError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (requestId === discussionDetailSeq.current) setDiscussionDetailLoading(false); });
  }, [open, discussionsManagerOpen, projectPath, isAggregate, selectedDiscussion]);

  const refreshDiscussionDetail = async () => {
    if (!projectPath || !selectedDiscussion) return;
    const requestId = ++discussionDetailSeq.current;
    setDiscussionDetailLoading(true);
    setDiscussionDetailError(null);
    try {
      const r = await api.getGitHubDiscussion({ path: projectPath, number: selectedDiscussion.number });
      if (requestId === discussionDetailSeq.current) setDiscussionDetail(r.detail);
    } catch (e) {
      if (requestId === discussionDetailSeq.current) setDiscussionDetailError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestId === discussionDetailSeq.current) setDiscussionDetailLoading(false);
    }
  };

  const toggleDiscussion = (discussion: GitHubDiscussion) => {
    setSelectedDiscussion((cur) => (cur && cur.id === discussion.id ? null : discussion));
  };

  const submitDiscussionComment = async () => {
    if (!projectPath || !selectedDiscussion || discussionCommentBusy) return;
    const body = discussionCommentDraft.trim();
    if (!body) return;
    setDiscussionCommentBusy(true);
    setDiscussionCommentError(null);
    try {
      // The mutation only returns the new comment's id, not its author/timestamp
      // — refetch to pick those up (same tradeoff as `addProjectItem`).
      await api.addGitHubDiscussionComment({ path: projectPath, discussionId: selectedDiscussion.id, body });
      setDiscussionCommentDraft("");
      await refreshDiscussionDetail();
    } catch (e) {
      setDiscussionCommentError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscussionCommentBusy(false);
    }
  };

  const setDiscussionAnswer = async (comment: GitHubDiscussionComment, answer: boolean) => {
    if (!projectPath) return;
    setDiscussionCommentBusyMap((cur) => ({ ...cur, [comment.id]: "answer" }));
    setDiscussionCommentErrors((cur) => ({ ...cur, [comment.id]: undefined }));
    // Optimistic — GitHub only allows one accepted answer per discussion, so
    // marking one clears any other locally too; reverted on failure below.
    const discussionId = discussionDetail?.id;
    const priorAnswers = new Map((discussionDetail?.comments ?? []).map((c) => [c.id, c.isAnswer]));
    setDiscussionDetail((cur) => cur && ({
      ...cur,
      comments: cur.comments.map((c) => (c.id === comment.id ? { ...c, isAnswer: answer } : answer ? { ...c, isAnswer: false } : c)),
    }));
    try {
      await api.setGitHubDiscussionAnswer({ path: projectPath, commentId: comment.id, answer });
      // Keep the collapsed list row's "answered" badge in sync (the list is lazy,
      // not polled) — one accepted answer per discussion, so mark ⇒ answered.
      if (discussionId) setDiscussions((cur) => cur.map((d) => (d.id === discussionId ? { ...d, answered: answer } : d)));
    } catch (e) {
      setDiscussionCommentErrors((cur) => ({ ...cur, [comment.id]: e instanceof Error ? e.message : String(e) }));
      // Restore only the isAnswer flags from the snapshot, functionally — so a
      // comment appended concurrently (or other field edits) isn't clobbered.
      setDiscussionDetail((cur) => cur && ({
        ...cur,
        comments: cur.comments.map((c) => (priorAnswers.has(c.id) ? { ...c, isAnswer: priorAnswers.get(c.id)! } : c)),
      }));
    } finally {
      setDiscussionCommentBusyMap((cur) => ({ ...cur, [comment.id]: undefined }));
    }
  };

  const deleteDiscussionComment = async (comment: GitHubDiscussionComment) => {
    if (!projectPath) return;
    setDiscussionCommentBusyMap((cur) => ({ ...cur, [comment.id]: "delete" }));
    setDiscussionCommentErrors((cur) => ({ ...cur, [comment.id]: undefined }));
    try {
      await api.deleteGitHubDiscussionComment({ path: projectPath, commentId: comment.id });
      setDiscussionDetail((cur) => cur && ({ ...cur, comments: cur.comments.filter((c) => c.id !== comment.id) })); // success unmounts this row
    } catch (e) {
      setDiscussionCommentErrors((cur) => ({ ...cur, [comment.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setDiscussionCommentBusyMap((cur) => ({ ...cur, [comment.id]: undefined }));
    }
  };

  const deleteDiscussionRow = async (discussion: GitHubDiscussion) => {
    if (!projectPath) return;
    setDiscussionRowBusy((cur) => ({ ...cur, [discussion.id]: true }));
    setDiscussionRowErrors((cur) => ({ ...cur, [discussion.id]: undefined }));
    try {
      await api.deleteGitHubDiscussion({ path: projectPath, discussionId: discussion.id });
      setDiscussions((cur) => cur.filter((d) => d.id !== discussion.id)); // success unmounts this row
      setSelectedDiscussion((cur) => (cur && cur.id === discussion.id ? null : cur));
    } catch (e) {
      setDiscussionRowErrors((cur) => ({ ...cur, [discussion.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setDiscussionRowBusy((cur) => ({ ...cur, [discussion.id]: false }));
    }
  };

  const createDiscussion = async () => {
    if (!projectPath || discussionCreateBusy) return;
    const title = newDiscussionTitle.trim();
    const body = newDiscussionBody.trim();
    if (!newDiscussionCategoryId || !title || !body) return;
    setDiscussionCreateBusy(true);
    setDiscussionCreateError(null);
    try {
      await api.createGitHubDiscussion({ path: projectPath, categoryId: newDiscussionCategoryId, title, body });
      setNewDiscussionTitle("");
      setNewDiscussionBody("");
      setDiscussionCreateOpen(false);
      // The create mutation only returns number/url — refetch for the full row.
      await refreshDiscussions();
    } catch (e) {
      setDiscussionCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscussionCreateBusy(false);
    }
  };

  useEffect(() => {
    // The New PR composer is hidden in aggregate mode (needs a concrete repo).
    if (!open || !projectPath || kind !== "pulls" || isAggregate) return;
    let cancelled = false;
    api.getGitHubPullDefaults({ path: projectPath })
      .then((defaults) => {
        if (cancelled) return;
        setNewPullHead((cur) => cur || defaults.head);
        setNewPullBase((cur) => cur || defaults.base);
      })
      .catch(() => {
        // Defaults are convenience only; creation will surface real errors.
      });
    return () => { cancelled = true; };
  }, [open, projectPath, kind, isAggregate]);

  useEffect(() => {
    if (!open || !projectPath || !expandedItem || expandedItem.kind !== "pulls") return;
    const number = expandedItem.number;
    const key = itemKey(expandedItem);
    if (diffs[key] || diffLoading[key] || diffErrors[key]) return;

    const requestId = ++diffSeq.current;
    setDiffLoading((cur) => ({ ...cur, [key]: true }));
    setDiffErrors((cur) => ({ ...cur, [key]: undefined }));
    api.getGitHubPullDiff({ path: expandedItemPath, number })
      .then((diff) => {
        if (requestId !== diffSeq.current) return;
        setDiffs((cur) => ({ ...cur, [key]: diff }));
      })
      .catch((e: unknown) => {
        if (requestId !== diffSeq.current) return;
        setDiffErrors((cur) => ({ ...cur, [key]: e instanceof Error ? e.message : String(e) }));
      })
      .finally(() => {
        if (requestId !== diffSeq.current) return;
        setDiffLoading((cur) => ({ ...cur, [key]: false }));
      });
  }, [open, projectPath, expandedItem, diffs, diffLoading, diffErrors]);

  useEffect(() => {
    if (!open || !projectPath || !expandedItem || expandedItem.kind !== "pulls") return;
    const number = expandedItem.number;
    const key = itemKey(expandedItem);
    if (checks[key] || checksLoading[key] || checksErrors[key]) return;

    const requestId = ++checksSeq.current;
    setChecksLoading((cur) => ({ ...cur, [key]: true }));
    setChecksErrors((cur) => ({ ...cur, [key]: undefined }));
    api.getGitHubPullChecks({ path: expandedItemPath, number })
      .then((payload) => {
        if (requestId !== checksSeq.current) return;
        setChecks((cur) => ({ ...cur, [key]: payload }));
      })
      .catch((e: unknown) => {
        if (requestId !== checksSeq.current) return;
        setChecksErrors((cur) => ({ ...cur, [key]: e instanceof Error ? e.message : String(e) }));
      })
      .finally(() => {
        if (requestId !== checksSeq.current) return;
        setChecksLoading((cur) => ({ ...cur, [key]: false }));
      });
  }, [open, projectPath, expandedItem, checks, checksLoading, checksErrors]);

  useEffect(() => {
    // F19 — the combined status needs a commit sha, not a PR number. Reuse the
    // sha `checks` already resolved via the server's pullHeadSha lookup (which
    // covers open/closed/merged PRs alike); fall back to mergeability's
    // headSha (only fetched for open PRs). Skip until one of them lands —
    // there's nothing to fetch yet.
    if (!open || !projectPath || !expandedItem || expandedItem.kind !== "pulls") return;
    const key = itemKey(expandedItem);
    const sha = checks[key]?.sha ?? mergeability[key]?.headSha;
    if (!sha) return;
    if (commitStatus[key] || commitStatusLoading[key] || commitStatusErrors[key]) return;

    const requestId = ++commitStatusSeq.current;
    setCommitStatusLoading((cur) => ({ ...cur, [key]: true }));
    setCommitStatusErrors((cur) => ({ ...cur, [key]: undefined }));
    api.getGitHubCommitStatus({ path: expandedItemPath, ref: sha })
      .then((payload) => {
        if (requestId !== commitStatusSeq.current) return;
        setCommitStatus((cur) => ({ ...cur, [key]: payload }));
      })
      .catch((e: unknown) => {
        if (requestId !== commitStatusSeq.current) return;
        setCommitStatusErrors((cur) => ({ ...cur, [key]: e instanceof Error ? e.message : String(e) }));
      })
      .finally(() => {
        if (requestId !== commitStatusSeq.current) return;
        setCommitStatusLoading((cur) => ({ ...cur, [key]: false }));
      });
  }, [open, projectPath, expandedItem, checks, mergeability, commitStatus, commitStatusLoading, commitStatusErrors]);

  useEffect(() => {
    // Only open PRs surface a mergeability verdict — skip closed/merged ones so
    // we don't burn the server-side poll on data the UI never shows.
    if (!open || !projectPath || !expandedItem || expandedItem.kind !== "pulls" || expandedItem.state !== "open") return;
    const number = expandedItem.number;
    const key = itemKey(expandedItem);
    if (mergeability[key] || mergeabilityLoading[key] || mergeabilityErrors[key]) return;

    const requestId = ++mergeabilitySeq.current;
    setMergeabilityLoading((cur) => ({ ...cur, [key]: true }));
    setMergeabilityErrors((cur) => ({ ...cur, [key]: undefined }));
    api.getGitHubPullMergeability({ path: expandedItemPath, number })
      .then((payload) => {
        if (requestId !== mergeabilitySeq.current) return;
        setMergeability((cur) => ({ ...cur, [key]: payload }));
        // GitHub may still be computing (`mergeable === null`). Self-heal with a
        // single delayed re-poll rather than making the user hit refresh.
        if (payload.mergeable === null && !payload.merged && (mergeabilityRetries.current[key] ?? 0) < 1) {
          mergeabilityRetries.current[key] = (mergeabilityRetries.current[key] ?? 0) + 1;
          setTimeout(() => {
            if (requestId !== mergeabilitySeq.current) return;
            setMergeability((cur) => ({ ...cur, [key]: undefined }));
            setMergeabilityErrors((cur) => ({ ...cur, [key]: undefined }));
          }, 2_500);
        }
      })
      .catch((e: unknown) => {
        if (requestId !== mergeabilitySeq.current) return;
        setMergeabilityErrors((cur) => ({ ...cur, [key]: e instanceof Error ? e.message : String(e) }));
      })
      .finally(() => {
        if (requestId !== mergeabilitySeq.current) return;
        setMergeabilityLoading((cur) => ({ ...cur, [key]: false }));
      });
  }, [open, projectPath, expandedItem, mergeability, mergeabilityLoading, mergeabilityErrors]);

  useEffect(() => {
    if (!open || !projectPath || !expandedItem || expandedItem.kind !== "pulls") return;
    const number = expandedItem.number;
    const key = itemKey(expandedItem);
    if (commits[key] || commitsLoading[key] || commitsErrors[key]) return;

    const requestId = ++commitsSeq.current;
    setCommitsLoading((cur) => ({ ...cur, [key]: true }));
    setCommitsErrors((cur) => ({ ...cur, [key]: undefined }));
    api.listGitHubPullCommits({ path: expandedItemPath, number })
      .then((payload) => {
        if (requestId !== commitsSeq.current) return;
        setCommits((cur) => ({ ...cur, [key]: payload.commits }));
      })
      .catch((e: unknown) => {
        if (requestId !== commitsSeq.current) return;
        setCommitsErrors((cur) => ({ ...cur, [key]: e instanceof Error ? e.message : String(e) }));
      })
      .finally(() => {
        if (requestId !== commitsSeq.current) return;
        setCommitsLoading((cur) => ({ ...cur, [key]: false }));
      });
  }, [open, projectPath, expandedItem, commits, commitsLoading, commitsErrors]);

  useEffect(() => {
    if (!open || !projectPath || !expandedItem || expandedItem.kind !== "pulls") return;
    const number = expandedItem.number;
    const key = itemKey(expandedItem);
    if (linkedIssues[key] || linkedIssuesLoading[key] || linkedIssuesErrors[key]) return;

    const requestId = ++linkedIssuesSeq.current;
    setLinkedIssuesLoading((cur) => ({ ...cur, [key]: true }));
    setLinkedIssuesErrors((cur) => ({ ...cur, [key]: undefined }));
    api.getGitHubPullLinkedIssues({ path: expandedItemPath, number })
      .then((payload) => {
        if (requestId !== linkedIssuesSeq.current) return;
        setLinkedIssues((cur) => ({ ...cur, [key]: payload.issues }));
      })
      .catch((e: unknown) => {
        if (requestId !== linkedIssuesSeq.current) return;
        setLinkedIssuesErrors((cur) => ({ ...cur, [key]: e instanceof Error ? e.message : String(e) }));
      })
      .finally(() => {
        if (requestId !== linkedIssuesSeq.current) return;
        setLinkedIssuesLoading((cur) => ({ ...cur, [key]: false }));
      });
  }, [open, projectPath, expandedItem, linkedIssues, linkedIssuesLoading, linkedIssuesErrors]);

  useEffect(() => {
    if (!open || !projectPath || !expandedItem) return;
    const number = expandedItem.number;
    const key = itemKey(expandedItem);
    if (comments[key] || commentsLoading[key] || commentErrors[key]) return;

    const requestId = ++commentSeq.current;
    setCommentsLoading((cur) => ({ ...cur, [key]: true }));
    setCommentErrors((cur) => ({ ...cur, [key]: undefined }));
    api.listGitHubComments({ path: expandedItemPath, number, kind: expandedItem.kind })
      .then((payload) => {
        if (requestId !== commentSeq.current) return;
        setComments((cur) => ({ ...cur, [key]: payload.comments }));
      })
      .catch((e: unknown) => {
        if (requestId !== commentSeq.current) return;
        setCommentErrors((cur) => ({ ...cur, [key]: e instanceof Error ? e.message : String(e) }));
      })
      .finally(() => {
        if (requestId !== commentSeq.current) return;
        setCommentsLoading((cur) => ({ ...cur, [key]: false }));
      });
  }, [open, projectPath, expandedItem, comments, commentsLoading, commentErrors]);

  useEffect(() => {
    if (!open || !projectPath || !expandedItem || expandedItem.kind !== "pulls") return;
    const number = expandedItem.number;
    const key = itemKey(expandedItem);
    if (reviewComments[key] || reviewCommentsLoading[key] || reviewCommentErrors[key]) return;

    const requestId = ++reviewCommentSeq.current;
    setReviewCommentsLoading((cur) => ({ ...cur, [key]: true }));
    setReviewCommentErrors((cur) => ({ ...cur, [key]: undefined }));
    Promise.all([
      api.listGitHubPullReviewComments({ path: expandedItemPath, number }),
      // Threads are supplementary (resolve controls) — degrade to none on failure.
      api.getGitHubPullReviewThreads({ path: expandedItemPath, number })
        .catch(() => ({ threads: [] as GitHubReviewThread[], truncated: false })),
    ])
      .then(([commentsPayload, threadsPayload]) => {
        if (requestId !== reviewCommentSeq.current) return;
        setReviewComments((cur) => ({ ...cur, [key]: commentsPayload.comments }));
        setReviewThreads((cur) => ({ ...cur, [key]: threadsPayload.threads }));
        setReviewThreadsTruncated((cur) => ({ ...cur, [key]: threadsPayload.truncated }));
      })
      .catch((e: unknown) => {
        if (requestId !== reviewCommentSeq.current) return;
        setReviewCommentErrors((cur) => ({ ...cur, [key]: e instanceof Error ? e.message : String(e) }));
      })
      .finally(() => {
        if (requestId !== reviewCommentSeq.current) return;
        setReviewCommentsLoading((cur) => ({ ...cur, [key]: false }));
      });
  }, [open, projectPath, expandedItem, reviewComments, reviewCommentsLoading, reviewCommentErrors]);

  const submitComment = async (item: GitHubListItem) => {
    const itemPath = item.sourcePath ?? projectPath;
    const body = (commentDrafts[itemKey(item)] ?? "").trim();
    if (!projectPath || !body || commentSubmitting[itemKey(item)]) return;
    setCommentSubmitting((cur) => ({ ...cur, [itemKey(item)]: true }));
    setCommentErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    try {
      const { comment } = await api.createGitHubComment({ path: itemPath, number: item.number, body, kind: item.kind });
      setComments((cur) => ({ ...cur, [itemKey(item)]: [...(cur[itemKey(item)] ?? []), comment] }));
      setCommentDrafts((cur) => ({ ...cur, [itemKey(item)]: "" }));
    } catch (e) {
      setCommentErrors((cur) => ({ ...cur, [itemKey(item)]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setCommentSubmitting((cur) => ({ ...cur, [itemKey(item)]: false }));
    }
  };

  const submitLineComment = async (item: GitHubListItem, target: LineCommentTarget) => {
    const itemPath = item.sourcePath ?? projectPath;
    if (!projectPath || item.kind !== "pulls") return;
    const { comment } = await api.createGitHubPullLineComment({
      path: itemPath,
      number: item.number,
      body: target.body,
      filePath: target.filePath,
      line: target.line,
      side: target.side,
    });
    setReviewComments((cur) => ({ ...cur, [itemKey(item)]: [...(cur[itemKey(item)] ?? []), comment] }));
    setReviewCommentErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
  };

  const submitReviewReply = async (item: GitHubListItem, commentId: number) => {
    const itemPath = item.sourcePath ?? projectPath;
    const body = (reviewReplyDrafts[commentId] ?? "").trim();
    if (!projectPath || item.kind !== "pulls" || !body || reviewReplySubmitting[commentId]) return;
    setReviewReplySubmitting((cur) => ({ ...cur, [commentId]: true }));
    setReviewCommentErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    try {
      const { comment } = await api.replyGitHubPullLineComment({
        path: itemPath,
        number: item.number,
        commentId,
        body,
      });
      setReviewComments((cur) => ({ ...cur, [itemKey(item)]: [...(cur[itemKey(item)] ?? []), comment] }));
      setReviewReplyDrafts((cur) => ({ ...cur, [commentId]: "" }));
    } catch (e) {
      setReviewCommentErrors((cur) => ({ ...cur, [itemKey(item)]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setReviewReplySubmitting((cur) => ({ ...cur, [commentId]: false }));
    }
  };

  const applySuggestion = async (item: GitHubListItem, commentId: number) => {
    const itemPath = item.sourcePath ?? projectPath;
    if (!projectPath || applySuggestionBusy[commentId]) return;
    setApplySuggestionBusy((cur) => ({ ...cur, [commentId]: true }));
    setReviewCommentErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    try {
      await api.applyGitHubSuggestion({ path: itemPath, number: item.number, commentId });
      // Refetch — mirrors the "clear to undefined so the loader effect refires"
      // convention used elsewhere in this file (e.g. runPullReview above).
      setReviewComments((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    } catch (e) {
      setReviewCommentErrors((cur) => ({ ...cur, [itemKey(item)]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setApplySuggestionBusy((cur) => ({ ...cur, [commentId]: false }));
    }
  };

  const editConversationComment = async (item: GitHubListItem, commentId: number, body: string) => {
    const itemPath = item.sourcePath ?? projectPath;
    if (!projectPath) throw new Error("no project selected");
    const { comment } = await api.updateGitHubComment({ path: itemPath, commentId, kind: "issue", body });
    setComments((cur) => ({
      ...cur,
      [itemKey(item)]: (cur[itemKey(item)] ?? []).map((c) => (c.id === commentId ? comment : c)),
    }));
  };

  const deleteConversationComment = async (item: GitHubListItem, commentId: number) => {
    const itemPath = item.sourcePath ?? projectPath;
    if (!projectPath) throw new Error("no project selected");
    await api.deleteGitHubComment({ path: itemPath, commentId, kind: "issue" });
    setComments((cur) => ({
      ...cur,
      [itemKey(item)]: (cur[itemKey(item)] ?? []).filter((c) => c.id !== commentId),
    }));
  };

  const editReviewComment = async (item: GitHubListItem, commentId: number, body: string) => {
    const itemPath = item.sourcePath ?? projectPath;
    if (!projectPath) throw new Error("no project selected");
    const { comment } = await api.updateGitHubComment({ path: itemPath, commentId, kind: "review", body });
    // Keep the line-comment's path/line/side; only body + updatedAt change.
    setReviewComments((cur) => ({
      ...cur,
      [itemKey(item)]: (cur[itemKey(item)] ?? []).map((c) =>
        c.id === commentId ? { ...c, body: comment.body, updatedAt: comment.updatedAt } : c,
      ),
    }));
  };

  const deleteReviewComment = async (item: GitHubListItem, commentId: number) => {
    const itemPath = item.sourcePath ?? projectPath;
    if (!projectPath) throw new Error("no project selected");
    await api.deleteGitHubComment({ path: itemPath, commentId, kind: "review" });
    setReviewComments((cur) => ({
      ...cur,
      [itemKey(item)]: (cur[itemKey(item)] ?? []).filter((c) => c.id !== commentId),
    }));
  };

  const toggleThreadResolved = async (item: GitHubListItem, thread: GitHubReviewThread) => {
    const itemPath = item.sourcePath ?? projectPath;
    if (!projectPath) throw new Error("no project selected");
    const result = await api.setGitHubReviewThreadResolved({
      path: itemPath,
      threadId: thread.threadId,
      resolved: !thread.isResolved,
    });
    setReviewThreads((cur) => ({
      ...cur,
      [itemKey(item)]: (cur[itemKey(item)] ?? []).map((t) =>
        t.threadId === thread.threadId ? { ...t, isResolved: result.resolved } : t,
      ),
    }));
  };

  const itemMatchesActiveFilters = (item: GitHubListItem) => {
    if (item.kind !== kind) return false;
    if (state !== "all" && item.state !== state) return false;
    // In GH-search mode `query` is raw qualifiers evaluated server-side, not a
    // substring — skip the client match (a locally-upserted item is accepted).
    const q = searchSyntax ? "" : query.trim().toLowerCase();
    if (q) {
      const hay = [
        item.title,
        item.body,
        String(item.number),
        item.author?.login ?? "",
        item.labels.map((label) => label.name).join(" "),
      ].join("\n").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    const requiredLabels = splitLabels(labels).map((label) => label.toLowerCase());
    if (requiredLabels.length > 0) {
      const have = new Set(item.labels.map((label) => label.name.toLowerCase()));
      if (!requiredLabels.every((label) => have.has(label))) return false;
    }
    const assigneeFilter = assignee.trim().toLowerCase();
    if (assigneeFilter) {
      const have = new Set(item.assignees.map((a) => a.login.toLowerCase()));
      if (!have.has(assigneeFilter)) return false;
    }
    // Involvement filters are served by the Search API; re-apply the ones a list
    // item can prove so an optimistic upsert doesn't insert a non-matching item
    // (`reviewRequested` isn't derivable from a list item, so it's accepted).
    if (viewerLogin) {
      if (createdByMe && item.author?.login !== viewerLogin) return false;
      if (assignedToMe && !item.assignees.some((a) => a.login === viewerLogin)) return false;
    }
    return true;
  };

  // Identity is the closed PR itself (kind+number+sourcePath), not just the
  // number — in aggregate mode (G8) two repos can each have a PR #5, and only
  // the one that was actually closed should flip/drop.
  // Routed through `upsertListItem`'s `keepIfPresent` (like reopen) so the row
  // stays in `result.items` with its updated state even when "merged"/"closed"
  // no longer matches the active filter (default "open") — otherwise the open
  // detail subpage falls back to its frozen open-state navigation snapshot.
  const markPullClosed = (target: GitHubListItem, replacement?: GitHubListItem) => {
    const next = replacement ?? { ...target, state: "closed" as const, closedAt: new Date().toISOString() };
    upsertListItem(next, false, true);
  };

  const runPullReview = async (item: GitHubListItem, event: GitHubPullReviewEvent) => {
    const itemPath = item.sourcePath ?? projectPath;
    const body = (reviewDrafts[itemKey(item)] ?? "").trim();
    const pending = pendingReview[itemKey(item)] ?? [];
    if (!projectPath || actionBusy[itemKey(item)]) return;
    // COMMENT/REQUEST_CHANGES need a summary note OR at least one pending inline
    // comment; APPROVE can be empty.
    if (event !== "APPROVE" && !body && pending.length === 0) {
      setActionErrors((cur) => ({
        ...cur,
        [itemKey(item)]: event === "COMMENT" ? "A review comment requires a note." : "Request changes requires a comment.",
      }));
      return;
    }
    setActionBusy((cur) => ({ ...cur, [itemKey(item)]: event }));
    setActionSource((cur) => ({ ...cur, [itemKey(item)]: "actions" }));
    setActionErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    setActionMessages((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    try {
      const result = await api.reviewGitHubPull({
        path: itemPath,
        number: item.number,
        event,
        body,
        comments: pending.map((c) => ({ path: c.filePath, line: c.line, side: c.side, body: c.body })),
      });
      setActionMessages((cur) => ({
        ...cur,
        [itemKey(item)]: result.message ?? (event === "APPROVE"
          ? "Pull request approved."
          : event === "COMMENT" ? "Review submitted." : "Changes requested."),
      }));
      setReviewDrafts((cur) => ({ ...cur, [itemKey(item)]: "" }));
      // The pending inline comments were posted with the review — clear them and
      // refetch the review-comments list so they show up.
      if (pending.length > 0) {
        setPendingReview((cur) => ({ ...cur, [itemKey(item)]: [] }));
        setPendingStale((cur) => ({ ...cur, [itemKey(item)]: false }));
        setReviewComments((cur) => ({ ...cur, [itemKey(item)]: undefined }));
        setReviewThreads((cur) => ({ ...cur, [itemKey(item)]: undefined }));
        setReviewCommentErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
      }
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [itemKey(item)]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    }
  };

  const addToReview = (item: GitHubListItem, target: LineCommentTarget) => {
    // A comment queued against the current diff starts a fresh (non-stale) queue.
    const wasEmpty = (pendingReview[itemKey(item)] ?? []).length === 0;
    setPendingReview((cur) => ({ ...cur, [itemKey(item)]: [...(cur[itemKey(item)] ?? []), target] }));
    if (wasEmpty) setPendingStale((cur) => ({ ...cur, [itemKey(item)]: false }));
  };

  const removePendingReview = (item: GitHubListItem, index: number) => {
    setPendingReview((cur) => ({ ...cur, [itemKey(item)]: (cur[itemKey(item)] ?? []).filter((_, i) => i !== index) }));
  };

  const runPullMerge = async (item: GitHubListItem) => {
    const itemPath = item.sourcePath ?? projectPath;
    if (!projectPath || actionBusy[itemKey(item)]) return;
    const method = mergeMethods[itemKey(item)] ?? "merge";
    setActionBusy((cur) => ({ ...cur, [itemKey(item)]: "merge" }));
    setActionSource((cur) => ({ ...cur, [itemKey(item)]: "actions" }));
    setActionErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    setActionMessages((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    try {
      const result = await api.mergeGitHubPull({ path: itemPath, number: item.number, method });
      if (result.merged) markPullClosed(item);
      setActionMessages((cur) => ({ ...cur, [itemKey(item)]: result.message ?? "Pull request merged." }));
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [itemKey(item)]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    }
  };

  const runUpdateBranch = async (item: GitHubListItem) => {
    const itemPath = item.sourcePath ?? projectPath;
    if (!projectPath || item.kind !== "pulls" || actionBusy[itemKey(item)]) return;
    setActionBusy((cur) => ({ ...cur, [itemKey(item)]: "update-branch" }));
    setActionSource((cur) => ({ ...cur, [itemKey(item)]: "actions" }));
    setActionErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    setActionMessages((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    try {
      const result = await api.updateGitHubPullBranch({ path: itemPath, number: item.number });
      setActionMessages((cur) => ({ ...cur, [itemKey(item)]: result.message ?? "Branch update started." }));
      // update-branch is async (202 Accepted) — GitHub merges the base into the
      // head in the background. Give it a moment before invalidating the caches,
      // otherwise the refetch races the merge and shows a stale "behind" verdict.
      await new Promise((r) => setTimeout(r, 2_000));
      // The head moved, so the cached mergeability, checks, commit status, and
      // diff are stale — clear them so their effects refetch against the new
      // head. Reset the mergeability retry budget so it can self-heal on the
      // fresh head.
      mergeabilityRetries.current[itemKey(item)] = 0;
      setMergeability((cur) => ({ ...cur, [itemKey(item)]: undefined }));
      setMergeabilityErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
      setChecks((cur) => ({ ...cur, [itemKey(item)]: undefined }));
      setChecksErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
      setCommitStatus((cur) => ({ ...cur, [itemKey(item)]: undefined }));
      setCommitStatusErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
      setDiffs((cur) => ({ ...cur, [itemKey(item)]: undefined }));
      setDiffErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
      // The head moved — any queued review comments now reference stale lines.
      setPendingStale((cur) => ({ ...cur, [itemKey(item)]: true }));
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [itemKey(item)]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    }
  };

  const runPullClose = async (item: GitHubListItem) => {
    const itemPath = item.sourcePath ?? projectPath;
    if (!projectPath || actionBusy[itemKey(item)]) return;
    const comment = (closeDrafts[itemKey(item)] ?? "").trim();
    setActionBusy((cur) => ({ ...cur, [itemKey(item)]: "close" }));
    setActionSource((cur) => ({ ...cur, [itemKey(item)]: "actions" }));
    setActionErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    setActionMessages((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    try {
      const result = await api.closeGitHubPull({ path: itemPath, number: item.number, comment });
      markPullClosed(item, result.item);
      setActionMessages((cur) => ({ ...cur, [itemKey(item)]: result.message ?? "Pull request closed." }));
      setCloseDrafts((cur) => ({ ...cur, [itemKey(item)]: "" }));
      if (comment && result.commentPosted !== false) {
        setComments((cur) => ({ ...cur, [itemKey(item)]: undefined }));
        setCommentErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
      }
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [itemKey(item)]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    }
  };

  const runReopenPull = async (item: GitHubListItem) => {
    const itemPath = item.sourcePath ?? projectPath;
    if (!projectPath || item.kind !== "pulls" || actionBusy[itemKey(item)]) return;
    setActionBusy((cur) => ({ ...cur, [itemKey(item)]: "reopen" }));
    setActionSource((cur) => ({ ...cur, [itemKey(item)]: "actions" }));
    setActionErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    setActionMessages((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    try {
      const result = await api.reopenGitHubPull({ path: itemPath, number: item.number });
      // Keep the row visible even under a "closed" filter so the reopen is
      // legible; it drops out on the next refresh.
      upsertListItem(result.item, false, true);
      setActionMessages((cur) => ({ ...cur, [itemKey(item)]: result.message ?? "Pull request reopened." }));
      // Now open again — let the mergeability effect fetch a fresh verdict.
      mergeabilityRetries.current[itemKey(item)] = 0;
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [itemKey(item)]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    }
  };

  const runToggleDraft = async (item: GitHubListItem) => {
    const itemPath = item.sourcePath ?? projectPath;
    if (!projectPath || item.kind !== "pulls" || actionBusy[itemKey(item)]) return;
    const nextDraft = !item.draft;
    setActionBusy((cur) => ({ ...cur, [itemKey(item)]: "draft" }));
    setActionSource((cur) => ({ ...cur, [itemKey(item)]: "actions" }));
    setActionErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    setActionMessages((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    try {
      const result = await api.setGitHubPullDraft({ path: itemPath, number: item.number, draft: nextDraft });
      upsertListItem({ ...item, draft: result.draft });
      setActionMessages((cur) => ({ ...cur, [itemKey(item)]: result.message ?? "Draft state updated." }));
      // Draft ↔ ready flips mergeable_state (draft PRs report "draft"), so refresh.
      mergeabilityRetries.current[itemKey(item)] = 0;
      setMergeability((cur) => ({ ...cur, [itemKey(item)]: undefined }));
      setMergeabilityErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [itemKey(item)]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    }
  };

  const runToggleAutoMerge = async (item: GitHubListItem) => {
    const itemPath = item.sourcePath ?? projectPath;
    if (!projectPath || item.kind !== "pulls" || actionBusy[itemKey(item)]) return;
    const enable = !mergeability[itemKey(item)]?.autoMerge;
    const mergeMethod = mergeMethods[itemKey(item)] ?? "merge";
    setActionBusy((cur) => ({ ...cur, [itemKey(item)]: "auto-merge" }));
    setActionSource((cur) => ({ ...cur, [itemKey(item)]: "actions" }));
    setActionErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    setActionMessages((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    try {
      const result = await api.setGitHubPullAutoMerge({ path: itemPath, number: item.number, enable, mergeMethod });
      setActionMessages((cur) => ({ ...cur, [itemKey(item)]: result.message ?? "Auto-merge updated." }));
      // Optimistically flip the cached mergeability rather than refetching —
      // GitHub's mergeable computation isn't affected by this toggle.
      setMergeability((cur) => {
        const existing = cur[itemKey(item)];
        if (!existing) return cur;
        return { ...cur, [itemKey(item)]: { ...existing, autoMerge: result.autoMergeEnabled } };
      });
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [itemKey(item)]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    }
  };

  const runToggleLock = async (item: GitHubListItem) => {
    const itemPath = item.sourcePath ?? projectPath;
    if (!projectPath || actionBusy[itemKey(item)]) return;
    const nextLocked = !item.locked;
    setActionBusy((cur) => ({ ...cur, [itemKey(item)]: "lock" }));
    setActionSource((cur) => ({ ...cur, [itemKey(item)]: "actions" }));
    setActionErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    setActionMessages((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    try {
      const result = await api.setGitHubIssueLock({
        path: itemPath,
        number: item.number,
        locked: nextLocked,
        lockReason: nextLocked ? (lockReasonDrafts[itemKey(item)] || undefined) : undefined,
      });
      upsertListItem({ ...item, locked: result.locked }, false, true);
      setActionMessages((cur) => ({ ...cur, [itemKey(item)]: result.message ?? "Lock state updated." }));
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [itemKey(item)]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    }
  };

  // First click arms a confirm step (transfer is disruptive/irreversible); the
  // second click actually fires the transfer. Changing the target repo re-arms
  // the confirm (handled by onTransferDraftChange below).
  const runTransferIssue = async (item: GitHubListItem) => {
    const itemPath = item.sourcePath ?? projectPath;
    if (!projectPath || item.kind !== "issues" || actionBusy[itemKey(item)]) return;
    const targetRepo = (transferDrafts[itemKey(item)] ?? "").trim();
    if (!targetRepo) return;
    if (!transferConfirm[itemKey(item)]) {
      setTransferConfirm((cur) => ({ ...cur, [itemKey(item)]: true }));
      return;
    }
    setActionBusy((cur) => ({ ...cur, [itemKey(item)]: "transfer" }));
    setActionSource((cur) => ({ ...cur, [itemKey(item)]: "actions" }));
    setActionErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    setActionMessages((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    try {
      const result = await api.transferGitHubIssue({ path: itemPath, number: item.number, targetRepo });
      setTransferNotice({ message: result.message ?? `Issue transferred to ${targetRepo}.`, url: result.url });
      // The issue no longer lives in this repo — drop it from the list rather
      // than reconciling it in place.
      setResult((cur) => cur && { ...cur, items: cur.items.filter((it) => !sameItem(it, item)) });
      setView((cur) => (cur.kind === "detail" && sameItem(cur.item, item) ? backToList() : cur));
      setTransferDrafts((cur) => ({ ...cur, [itemKey(item)]: "" }));
      setTransferConfirm((cur) => ({ ...cur, [itemKey(item)]: false }));
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [itemKey(item)]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    }
  };

  // `keepIfPresent` updates an existing row in place even when the replacement no
  // longer matches the active filters — used by in-panel state changes (e.g.
  // reopen) so the user sees the result instead of the row silently vanishing;
  // it drops out naturally on the next refresh.
  const upsertListItem = (replacement: GitHubListItem, prepend = false, keepIfPresent = false) => {
    setResult((cur) => {
      if (!cur) return cur;
      // Match on kind+number+sourcePath (G8) so a write to repo B's #5 can't
      // overwrite repo A's #5 in an aggregated list.
      const exists = cur.items.some((item) => sameItem(item, replacement));
      if (!itemMatchesActiveFilters(replacement) && !(keepIfPresent && exists)) {
        return {
          ...cur,
          items: cur.items.filter((item) => !sameItem(item, replacement)),
        };
      }
      return {
        ...cur,
        items: exists
          ? cur.items.map((item) => sameItem(item, replacement) ? replacement : item)
          : prepend ? [replacement, ...cur.items] : [...cur.items, replacement],
      };
    });
  };

  const createIssue = async () => {
    const title = newIssueTitle.trim();
    if (!projectPath || !title || newIssueSubmitting) return;
    const milestone = parseMilestone(newIssueMilestone);
    if (milestone === null) {
      setNewIssueError("Milestone must be a positive number.");
      return;
    }
    setNewIssueSubmitting(true);
    setNewIssueError(null);
    try {
      const result = await api.createGitHubIssue({
        path: projectPath,
        title,
        body: newIssueBody,
        labels: splitLabels(newIssueLabels),
        assignees: splitLabels(newIssueAssignees),
        milestone,
      });
      upsertListItem(result.item, true);
      // Land on the created issue's detail subpage rather than just closing
      // back to the list — mirrors clicking the row you just made.
      setView(openDetail(result.item));
      setNewIssueTitle("");
      setNewIssueBody("");
      setNewIssueLabels("");
      setNewIssueAssignees("");
      setNewIssueMilestone("");
    } catch (e) {
      setNewIssueError(e instanceof Error ? e.message : String(e));
    } finally {
      setNewIssueSubmitting(false);
    }
  };

  const pushHead = async () => {
    const head = newPullHead.trim();
    if (!projectPath || !head || newPullPushing) return;
    setNewPullPushing(true);
    setNewPullPushError(null);
    setNewPullPushMessage(null);
    try {
      const res = await api.gitPush(projectPath, head);
      setNewPullPushMessage(res.remote ? `Pushed ${head} to ${res.remote}.` : `Pushed ${head}.`);
    } catch (e) {
      setNewPullPushError(e instanceof Error ? e.message : String(e));
    } finally {
      setNewPullPushing(false);
    }
  };

  const createPull = async () => {
    const title = newPullTitle.trim();
    const head = newPullHead.trim();
    const base = newPullBase.trim();
    if (!projectPath || !title || !head || !base || newPullSubmitting) return;
    setNewPullSubmitting(true);
    setNewPullError(null);
    try {
      const result = await api.createGitHubPull({
        path: projectPath,
        title,
        head,
        base,
        body: newPullBody,
        draft: newPullDraft,
        reviewers: splitLabels(newPullReviewers),
        taskId: pullPrefillTaskId ?? undefined,
      });
      upsertListItem(result.item, true);
      // Land on the created pull's detail subpage rather than just closing
      // back to the list — mirrors clicking the row you just made.
      setView(openDetail(result.item));
      setNewPullTitle("");
      setNewPullBody("");
      setNewPullReviewers("");
      setNewPullDraft(false);
      setPullPrefillTaskId(null);
      setActionMessages((cur) => ({ ...cur, [result.item.number]: result.message ?? "Pull request created." }));
    } catch (e) {
      setNewPullError(e instanceof Error ? e.message : String(e));
    } finally {
      setNewPullSubmitting(false);
    }
  };

  const updateIssueState = async (item: GitHubListItem, nextState: "open" | "closed") => {
    const itemPath = item.sourcePath ?? projectPath;
    if (!projectPath || actionBusy[itemKey(item)]) return;
    setActionBusy((cur) => ({ ...cur, [itemKey(item)]: nextState }));
    setActionSource((cur) => ({ ...cur, [itemKey(item)]: "actions" }));
    setActionErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    setActionMessages((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    try {
      const result = await api.updateGitHubIssue({ path: itemPath, number: item.number, state: nextState });
      // Keep the row (and its updated state) visible even under a filter it no
      // longer matches — mirrors pull merge/close and reopen so the open detail
      // subpage reflects the close immediately instead of a frozen snapshot.
      upsertListItem(result.item, false, true);
      setActionMessages((cur) => ({ ...cur, [itemKey(item)]: result.message ?? "Issue updated." }));
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [itemKey(item)]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    }
  };

  const updateIssueLabels = async (item: GitHubListItem) => {
    const itemPath = item.sourcePath ?? projectPath;
    if (!projectPath || actionBusy[itemKey(item)]) return;
    const nextLabels = splitLabels(labelDrafts[itemKey(item)] ?? item.labels.map((label) => label.name).join(", "));
    const nextAssignees = splitLabels(assigneeDrafts[itemKey(item)] ?? item.assignees.map((a) => a.login).join(", "));
    const rawMilestone = milestoneDrafts[itemKey(item)] ?? (item.milestone ? String(item.milestone.number) : "");
    const nextMilestone = parseMilestone(rawMilestone);
    if (nextMilestone === null) {
      setActionErrors((cur) => ({ ...cur, [itemKey(item)]: "Milestone must be a positive number." }));
      return;
    }
    setActionBusy((cur) => ({ ...cur, [itemKey(item)]: "labels" }));
    setActionSource((cur) => ({ ...cur, [itemKey(item)]: "triage" }));
    setActionErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    setActionMessages((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    try {
      const result = await api.updateGitHubIssue({
        path: itemPath,
        number: item.number,
        kind: item.kind,
        labels: nextLabels,
        assignees: nextAssignees,
        milestone: rawMilestone.trim() ? nextMilestone : null,
      });
      // The /issues/:n response drops PR-only fields (e.g. `draft`); keep them
      // from the item we already have so a triage save can't flip the badge.
      upsertListItem(item.kind === "pulls" ? { ...result.item, draft: item.draft } : result.item);
      setLabelDrafts((cur) => ({ ...cur, [itemKey(item)]: result.item.labels.map((label) => label.name).join(", ") }));
      setAssigneeDrafts((cur) => ({ ...cur, [itemKey(item)]: result.item.assignees.map((a) => a.login).join(", ") }));
      setMilestoneDrafts((cur) => ({ ...cur, [itemKey(item)]: result.item.milestone ? String(result.item.milestone.number) : "" }));
      setActionMessages((cur) => ({ ...cur, [itemKey(item)]: "Triage updated." }));
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [itemKey(item)]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    }
  };

  const saveEdit = async (item: GitHubListItem) => {
    const itemPath = item.sourcePath ?? projectPath;
    if (!projectPath || actionBusy[itemKey(item)]) return;
    const title = (titleDrafts[itemKey(item)] ?? item.title).trim();
    const body = bodyDrafts[itemKey(item)] ?? item.body;
    if (!title) {
      setActionErrors((cur) => ({ ...cur, [itemKey(item)]: "Title cannot be empty." }));
      return;
    }
    setActionBusy((cur) => ({ ...cur, [itemKey(item)]: "edit" }));
    setActionSource((cur) => ({ ...cur, [itemKey(item)]: "edit" }));
    setActionErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    setActionMessages((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    try {
      const result = await api.updateGitHubIssue({ path: itemPath, number: item.number, kind: item.kind, title, body });
      upsertListItem(item.kind === "pulls" ? { ...result.item, draft: item.draft } : result.item);
      // Close and discard the drafts so reopening reflects the freshly-saved item.
      setEditorOpen((cur) => ({ ...cur, [itemKey(item)]: false }));
      setTitleDrafts((cur) => ({ ...cur, [itemKey(item)]: undefined }));
      setBodyDrafts((cur) => ({ ...cur, [itemKey(item)]: undefined }));
      setActionMessages((cur) => ({ ...cur, [itemKey(item)]: `${item.kind === "pulls" ? caps.pullNoun : "Issue"} updated.` }));
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [itemKey(item)]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    }
  };

  const requestReviewers = async (item: GitHubListItem) => {
    const itemPath = item.sourcePath ?? projectPath;
    if (!projectPath || item.kind !== "pulls" || actionBusy[itemKey(item)]) return;
    const reviewers = splitLabels(reviewerDrafts[itemKey(item)] ?? "");
    const teamReviewers = splitLabels(teamReviewerDrafts[itemKey(item)] ?? "");
    if (reviewers.length === 0 && teamReviewers.length === 0) {
      setActionErrors((cur) => ({ ...cur, [itemKey(item)]: "Enter at least one reviewer or team." }));
      return;
    }
    setActionBusy((cur) => ({ ...cur, [itemKey(item)]: "reviewers" }));
    setActionSource((cur) => ({ ...cur, [itemKey(item)]: "triage" }));
    setActionErrors((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    setActionMessages((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    try {
      const result = await api.requestGitHubPullReviewers({ path: itemPath, number: item.number, reviewers, teamReviewers });
      setActionMessages((cur) => ({ ...cur, [itemKey(item)]: result.message ?? "Reviewers requested." }));
      setReviewerDrafts((cur) => ({ ...cur, [itemKey(item)]: "" }));
      setTeamReviewerDrafts((cur) => ({ ...cur, [itemKey(item)]: "" }));
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [itemKey(item)]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [itemKey(item)]: undefined }));
    }
  };

  // Detail, panel, and compose are distinct, mutually-exclusive members of
  // the `GitHubDialogView` union, so no defensive "is anything else open"
  // check is needed — opening any of them just replaces `view`.
  const showDetail = view.kind === "detail";
  const isPanelView = view.kind === "panel";
  const isComposeView = view.kind === "compose";

  const openItemDetail = (item: GitHubListItem) => {
    setView(openDetail(item));
  };
  const closeDetail = () => setView(backToList());

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (resolveEscape(view) === "pop") {
          closeDetail();
          return;
        }
        onClose();
      }}
      labelledBy="github-dialog-title"
      className="flex max-h-[86vh] w-full max-w-5xl flex-col p-0"
    >
      <header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
        {showDetail && expandedItem ? (
          <div className="flex min-w-0 items-center gap-2">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Back"
              title="Back to list"
              onClick={closeDetail}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <div className="min-w-0">
              <div id="github-dialog-title" className="flex items-center gap-2 text-sm font-semibold">
                {expandedItem.kind === "pulls" ? caps.pullNoun : "Issue"} #{expandedItem.number}
                {isAggregate && repoLabelFor(expandedItem) && (
                  <span
                    className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground"
                    title="Repository this item belongs to"
                  >
                    {repoLabelFor(expandedItem)}
                  </span>
                )}
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">{expandedItem.title}</div>
            </div>
          </div>
        ) : isPanelView ? (
          <div className="flex min-w-0 items-center gap-2">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Back"
              title="Back to list"
              onClick={closeDetail}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <div className="min-w-0">
              <div id="github-dialog-title" className="text-sm font-semibold">
                {PANEL_TITLES[view.panel]}
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {result ? result.repo : caps.providerName}
              </div>
            </div>
          </div>
        ) : isComposeView ? (
          <div className="flex min-w-0 items-center gap-2">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Back"
              title="Back to list"
              onClick={closeDetail}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <div className="min-w-0">
              <div id="github-dialog-title" className="text-sm font-semibold">
                {kind === "pulls" ? `New ${caps.pullNoun.toLowerCase()}` : "New issue"}
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {result ? result.repo : caps.providerName}
              </div>
            </div>
          </div>
        ) : (
          <div className="min-w-0">
            <div id="github-dialog-title" className="flex items-center gap-2 text-sm font-semibold">
              <GitPullRequest className="size-4 shrink-0 text-muted-foreground" />
              {provider === "mixed" ? "Git" : caps.providerName}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 truncate text-xs text-muted-foreground">
              {result ? (
                <>
                  <span className="truncate">
                    {result.repo}
                    {result.auth === "none" && " · unauthenticated"}
                  </span>
                  {/* Rate-limit badge is GitHub API-specific (F17) — gate it so a
                      GitLab/Bitbucket repo never renders a "GitHub API" tooltip. */}
                  {result.rateLimit && provider === "github" && <RateLimitBadge rateLimit={result.rateLimit} />}
                </>
              ) : (
                `${caps.pullNounPlural} and issues`
              )}
            </div>
          </div>
        )}
        <div className="flex shrink-0 items-center gap-2">
          {showDetail && expandedItem && (
            <Button
              size="icon"
              variant="ghost"
              title={`Open on ${caps.providerName}`}
              aria-label={`Open on ${caps.providerName}`}
              onClick={() => { void api.openExternal(expandedItem.htmlUrl); }}
            >
              <ExternalLink className="size-4" />
            </Button>
          )}
          {/* Repo-level toolbar (manager panel toggles + "open repository")
              stays up while browsing the list or a manager panel (the toggles
              are how panels switch and toggle off) — hidden on the detail and
              compose subpages, which have their own back-chevron header. */}
          {!showDetail && !isComposeView && (
          <>
          {panelsEnabled && caps.labels && (
            <Button
              size="icon"
              variant={labelManagerOpen ? "secondary" : "ghost"}
              title={isAggregate ? AGGREGATE_DISABLED_TITLE : "Manage labels"}
              aria-label="Manage labels"
              disabled={!projectPath || isAggregate}
              onClick={() => setView((cur) => togglePanel(cur, "labels"))}
            >
              <Tag className="size-4" />
            </Button>
          )}
          {panelsEnabled && caps.milestones && (
            <Button
              size="icon"
              variant={milestoneManagerOpen ? "secondary" : "ghost"}
              title={isAggregate ? AGGREGATE_DISABLED_TITLE : "Manage milestones"}
              aria-label="Manage milestones"
              disabled={!projectPath || isAggregate}
              onClick={() => setView((cur) => togglePanel(cur, "milestones"))}
            >
              <Milestone className="size-4" />
            </Button>
          )}
          {panelsEnabled && caps.releases && (
            <Button
              size="icon"
              variant={releaseManagerOpen ? "secondary" : "ghost"}
              title={isAggregate ? AGGREGATE_DISABLED_TITLE : "Manage releases"}
              aria-label="Manage releases"
              disabled={!projectPath || isAggregate}
              onClick={() => setView((cur) => togglePanel(cur, "releases"))}
            >
              <Rocket className="size-4" />
            </Button>
          )}
          {panelsEnabled && caps.notifications && (
            <Button
              size="icon"
              variant={notificationsOpen ? "secondary" : "ghost"}
              title={isAggregate ? AGGREGATE_DISABLED_TITLE : "Notifications"}
              aria-label="Notifications"
              disabled={!projectPath || isAggregate}
              onClick={() => setView((cur) => togglePanel(cur, "notifications"))}
            >
              <Bell className="size-4" />
            </Button>
          )}
          {panelsEnabled && caps.actions && (
            <Button
              size="icon"
              variant={actionsManagerOpen ? "secondary" : "ghost"}
              title={isAggregate ? AGGREGATE_DISABLED_TITLE : "Actions"}
              aria-label="Actions"
              disabled={!projectPath || isAggregate}
              onClick={() => setView((cur) => togglePanel(cur, "actions"))}
            >
              <Workflow className="size-4" />
            </Button>
          )}
          {panelsEnabled && caps.projects && (
            <Button
              size="icon"
              variant={projectsManagerOpen ? "secondary" : "ghost"}
              title={isAggregate ? AGGREGATE_DISABLED_TITLE : "Projects"}
              aria-label="Projects"
              disabled={!projectPath || isAggregate}
              onClick={() => setView((cur) => togglePanel(cur, "projects"))}
            >
              <Kanban className="size-4" />
            </Button>
          )}
          {panelsEnabled && caps.discussions && (
            <Button
              size="icon"
              variant={discussionsManagerOpen ? "secondary" : "ghost"}
              title={isAggregate ? AGGREGATE_DISABLED_TITLE : "Discussions"}
              aria-label="Discussions"
              disabled={!projectPath || isAggregate}
              onClick={() => setView((cur) => togglePanel(cur, "discussions"))}
            >
              <MessagesSquare className="size-4" />
            </Button>
          )}
          {result && result.webUrl && (
            <Button
              size="icon"
              variant="ghost"
              title={`Open repository on ${caps.providerName}`}
              aria-label={`Open repository on ${caps.providerName}`}
              onClick={() => { void api.openExternal(result.webUrl!); }}
            >
              <ExternalLink className="size-4" />
            </Button>
          )}
          </>
          )}
          <Button
            size="icon"
            variant="ghost"
            title="Refresh"
            aria-label="Refresh GitHub items"
            disabled={!projectPath || loading}
            onClick={() => { void load(); }}
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </Button>
        </div>
      </header>

      {/* Filter bar serves the item list, which stays visible below an open
          manager panel — hidden only on the detail and compose subpages,
          which replace the list entirely. */}
      {!showDetail && !isComposeView && (
      <div className="grid gap-2 border-b border-border/60 p-3 md:grid-cols-[minmax(0,1.2fr)_auto_auto]">
        <Select
          value={projectPath}
          onChange={(e) => setProjectPath(e.target.value)}
          title="Project"
          aria-label="Project"
        >
          {projectOptions.length === 0 && <option value="">No projects</option>}
          {projectOptions.map((p) => (
            <option key={p.path} value={p.path}>
              {p.label}
            </option>
          ))}
        </Select>
        <div className="flex rounded-md border border-input p-0.5">
          <Button
            size="sm"
            variant={kind === "pulls" ? "secondary" : "ghost"}
            className="h-7"
            onClick={() => setKind("pulls")}
          >
            {caps.pullAbbrevPlural}
          </Button>
          <Button
            size="sm"
            variant={kind === "issues" ? "secondary" : "ghost"}
            className="h-7"
            onClick={() => setKind("issues")}
          >
            Issues
          </Button>
        </div>
        <Select
          value={state}
          onChange={(e) => setState(e.target.value as GitHubItemState)}
          title="State"
          aria-label="State"
          className="h-8 text-xs"
        >
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="all">All</option>
        </Select>
        <div className="relative md:col-span-2">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (searchSyntax && e.key === "Enter") {
                e.preventDefault();
                setSearchSubmitted(query);
              }
            }}
            placeholder={searchSyntax ? "GitHub search — press Enter (is:open label:bug sort:updated…)" : "Search title, body, number, author…"}
            className="h-8 pl-8 pr-14 text-xs"
          />
          {caps.searchSyntax && (
            <Button
              size="sm"
              variant={searchSyntax ? "secondary" : "ghost"}
              className="absolute right-1 top-1/2 h-6 -translate-y-1/2 px-2 text-[10px] font-medium uppercase"
              disabled={result?.auth === "none"}
              title={
                result?.auth === "none"
                  ? "Sign in to GitHub to use search syntax"
                  : "Toggle GitHub search syntax (is:open author:me label:bug sort:updated…) — runs server-side via the Search API on Enter"
              }
              onClick={() => {
                const next = !searchSyntax;
                setSearchSyntax(next);
                if (next) setSearchSubmitted(query);
              }}
            >
              GH
            </Button>
          )}
        </div>
        {caps.labels && (
          <Input
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
            placeholder="Labels, comma separated"
            className="h-8 text-xs"
            list="github-dialog-labels"
          />
        )}
        <Input
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          placeholder="Assignee"
          className="h-8 text-xs"
        />
        <div className="flex items-center gap-1.5 md:col-span-2">
          <span className="text-[11px] text-muted-foreground">Sort:</span>
          <Select
            value={sortField}
            onChange={(e) => setSortField(e.target.value as "best-match" | "created" | "updated" | "comments")}
            title="Sort by"
            aria-label="Sort by"
            className="h-8 w-32 text-xs"
          >
            <option value="best-match">Best match</option>
            <option value="created">Created</option>
            <option value="updated">Updated</option>
            {caps.commentSort && <option value="comments">Comments</option>}
          </Select>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            title={sortDirection === "desc" ? "Descending — click for ascending" : "Ascending — click for descending"}
            aria-label="Toggle sort direction"
            onClick={() => setSortDirection((d) => (d === "desc" ? "asc" : "desc"))}
          >
            {sortDirection === "desc" ? <ArrowDownWideNarrow className="size-3.5" /> : <ArrowUpWideNarrow className="size-3.5" />}
          </Button>
        </div>
        <datalist id="github-dialog-labels">
          {availableLabels.map((label) => <option key={label} value={label} />)}
        </datalist>
        <div className="col-span-full flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Mine:</span>
          {(() => {
            const unauth = result?.auth === "none";
            const hint = unauth ? "Sign in to GitHub to filter by your own involvement" : undefined;
            return (
              <>
                <Button
                  size="sm"
                  variant={createdByMe ? "secondary" : "ghost"}
                  className="h-6 px-2 text-[11px]"
                  disabled={unauth}
                  title={hint}
                  onClick={() => setCreatedByMe((v) => !v)}
                >
                  Created
                </Button>
                <Button
                  size="sm"
                  variant={assignedToMe ? "secondary" : "ghost"}
                  className="h-6 px-2 text-[11px]"
                  disabled={unauth}
                  title={hint}
                  onClick={() => setAssignedToMe((v) => !v)}
                >
                  Assigned
                </Button>
                {kind === "pulls" && (
                  <Button
                    size="sm"
                    variant={reviewRequested ? "secondary" : "ghost"}
                    className="h-6 px-2 text-[11px]"
                    disabled={unauth}
                    title={hint}
                    onClick={() => setReviewRequested((v) => !v)}
                  >
                    Review requested
                  </Button>
                )}
              </>
            );
          })()}
        </div>
      </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {showDetail && expandedItem ? (
          <GitHubItemDetail
            item={expandedItem}
            caps={caps}
            provider={provider}
            itemPath={expandedItemPath}
            canPush={canPush}
            viewerLogin={viewerLogin}
            diff={expandedItem.kind === "pulls" ? diffs[itemKey(expandedItem)] : undefined}
            diffLoading={expandedItem.kind === "pulls" ? !!diffLoading[itemKey(expandedItem)] : false}
            diffError={expandedItem.kind === "pulls" ? diffErrors[itemKey(expandedItem)] : undefined}
            checks={expandedItem.kind === "pulls" ? checks[itemKey(expandedItem)] : undefined}
            checksLoading={expandedItem.kind === "pulls" ? !!checksLoading[itemKey(expandedItem)] : false}
            checksError={expandedItem.kind === "pulls" ? checksErrors[itemKey(expandedItem)] : undefined}
            commitStatus={expandedItem.kind === "pulls" ? commitStatus[itemKey(expandedItem)] : undefined}
            commitStatusLoading={expandedItem.kind === "pulls" ? !!commitStatusLoading[itemKey(expandedItem)] : false}
            commitStatusError={expandedItem.kind === "pulls" ? commitStatusErrors[itemKey(expandedItem)] : undefined}
            mergeability={expandedItem.kind === "pulls" ? mergeability[itemKey(expandedItem)] : undefined}
            mergeabilityLoading={expandedItem.kind === "pulls" ? !!mergeabilityLoading[itemKey(expandedItem)] : false}
            mergeabilityError={expandedItem.kind === "pulls" ? mergeabilityErrors[itemKey(expandedItem)] : undefined}
            commits={expandedItem.kind === "pulls" ? commits[itemKey(expandedItem)] : undefined}
            commitsLoading={expandedItem.kind === "pulls" ? !!commitsLoading[itemKey(expandedItem)] : false}
            commitsError={expandedItem.kind === "pulls" ? commitsErrors[itemKey(expandedItem)] : undefined}
            linkedIssues={expandedItem.kind === "pulls" ? linkedIssues[itemKey(expandedItem)] : undefined}
            reviewComments={expandedItem.kind === "pulls" ? reviewComments[itemKey(expandedItem)] : undefined}
            reviewCommentsLoading={expandedItem.kind === "pulls" ? !!reviewCommentsLoading[itemKey(expandedItem)] : false}
            reviewCommentError={expandedItem.kind === "pulls" ? reviewCommentErrors[itemKey(expandedItem)] : undefined}
            reviewReplyDrafts={reviewReplyDrafts}
            reviewReplySubmitting={reviewReplySubmitting}
            applySuggestionBusy={applySuggestionBusy}
            comments={comments[itemKey(expandedItem)]}
            commentsLoading={!!commentsLoading[itemKey(expandedItem)]}
            commentError={commentErrors[itemKey(expandedItem)]}
            commentDraft={commentDrafts[itemKey(expandedItem)] ?? ""}
            commentSubmitting={!!commentSubmitting[itemKey(expandedItem)]}
            reviewDraft={reviewDrafts[itemKey(expandedItem)] ?? ""}
            closeDraft={closeDrafts[itemKey(expandedItem)] ?? ""}
            mergeMethod={mergeMethods[itemKey(expandedItem)] ?? "merge"}
            actionBusy={actionBusy[itemKey(expandedItem)]}
            actionError={actionErrors[itemKey(expandedItem)]}
            actionMessage={actionMessages[itemKey(expandedItem)]}
            actionSource={actionSource[itemKey(expandedItem)]}
            repoLabels={repoLabels}
            repoAssignees={repoAssignees}
            repoMilestones={repoMilestones}
            labelDraft={labelDrafts[itemKey(expandedItem)] ?? expandedItem.labels.map((label) => label.name).join(", ")}
            assigneeDraft={assigneeDrafts[itemKey(expandedItem)] ?? expandedItem.assignees.map((a) => a.login).join(", ")}
            milestoneDraft={milestoneDrafts[itemKey(expandedItem)] ?? (expandedItem.milestone ? String(expandedItem.milestone.number) : "")}
            reviewerDraft={reviewerDrafts[itemKey(expandedItem)] ?? ""}
            teamReviewerDraft={teamReviewerDrafts[itemKey(expandedItem)] ?? ""}
            editorOpen={!!editorOpen[itemKey(expandedItem)]}
            titleDraft={titleDrafts[itemKey(expandedItem)] ?? expandedItem.title}
            bodyDraft={bodyDrafts[itemKey(expandedItem)] ?? expandedItem.body}
            onEditToggle={(next) => {
              const key = itemKey(expandedItem);
              setEditorOpen((cur) => ({ ...cur, [key]: next }));
              if (next) {
                setTitleDrafts((cur) => ({ ...cur, [key]: cur[key] ?? expandedItem.title }));
                setBodyDrafts((cur) => ({ ...cur, [key]: cur[key] ?? expandedItem.body }));
              } else {
                // Cancel discards the draft so reopening reflects the live item.
                setTitleDrafts((cur) => ({ ...cur, [key]: undefined }));
                setBodyDrafts((cur) => ({ ...cur, [key]: undefined }));
                setActionErrors((cur) => ({ ...cur, [key]: undefined }));
              }
            }}
            onTitleDraftChange={(body) => setTitleDrafts((cur) => ({ ...cur, [itemKey(expandedItem)]: body }))}
            onBodyDraftChange={(body) => setBodyDrafts((cur) => ({ ...cur, [itemKey(expandedItem)]: body }))}
            onSaveEdit={() => { void saveEdit(expandedItem); }}
            onReviewerDraftChange={(body) => setReviewerDrafts((cur) => ({ ...cur, [itemKey(expandedItem)]: body }))}
            onTeamReviewerDraftChange={(body) => setTeamReviewerDrafts((cur) => ({ ...cur, [itemKey(expandedItem)]: body }))}
            onRequestReviewers={() => { void requestReviewers(expandedItem); }}
            onReviewDraftChange={(body) => setReviewDrafts((cur) => ({ ...cur, [itemKey(expandedItem)]: body }))}
            onCloseDraftChange={(body) => setCloseDrafts((cur) => ({ ...cur, [itemKey(expandedItem)]: body }))}
            onMergeMethodChange={(method) => setMergeMethods((cur) => ({ ...cur, [itemKey(expandedItem)]: method }))}
            onReview={(event) => { void runPullReview(expandedItem, event); }}
            onMerge={() => { void runPullMerge(expandedItem); }}
            onUpdateBranch={() => { void runUpdateBranch(expandedItem); }}
            onReopenPull={() => { void runReopenPull(expandedItem); }}
            onToggleDraft={() => { void runToggleDraft(expandedItem); }}
            onToggleAutoMerge={() => { void runToggleAutoMerge(expandedItem); }}
            onClosePull={() => { void runPullClose(expandedItem); }}
            pendingReview={expandedItem.kind === "pulls" ? (pendingReview[itemKey(expandedItem)] ?? []) : []}
            pendingStale={expandedItem.kind === "pulls" ? !!pendingStale[itemKey(expandedItem)] : false}
            onAddToReview={(target) => addToReview(expandedItem, target)}
            onRemovePendingReview={(index) => removePendingReview(expandedItem, index)}
            onLineComment={(target) => submitLineComment(expandedItem, target)}
            onReviewReplyDraftChange={(commentId, body) => setReviewReplyDrafts((cur) => ({ ...cur, [commentId]: body }))}
            onSubmitReviewReply={(commentId) => { void submitReviewReply(expandedItem, commentId); }}
            reviewThreads={expandedItem.kind === "pulls" ? (reviewThreads[itemKey(expandedItem)] ?? []) : []}
            reviewThreadsTruncated={expandedItem.kind === "pulls" ? !!reviewThreadsTruncated[itemKey(expandedItem)] : false}
            onToggleThreadResolved={(thread) => toggleThreadResolved(expandedItem, thread)}
            onEditReviewComment={(commentId, body) => editReviewComment(expandedItem, commentId, body)}
            onDeleteReviewComment={(commentId) => deleteReviewComment(expandedItem, commentId)}
            onApplySuggestion={(commentId) => { void applySuggestion(expandedItem, commentId); }}
            onEditComment={(commentId, body) => editConversationComment(expandedItem, commentId, body)}
            onDeleteComment={(commentId) => deleteConversationComment(expandedItem, commentId)}
            onRetryReviewComments={() => {
              if (expandedItem.kind !== "pulls") return;
              setReviewCommentErrors((cur) => ({ ...cur, [itemKey(expandedItem)]: undefined }));
            }}
            onLabelDraftChange={(body) => setLabelDrafts((cur) => ({ ...cur, [itemKey(expandedItem)]: body }))}
            onAssigneeDraftChange={(body) => setAssigneeDrafts((cur) => ({ ...cur, [itemKey(expandedItem)]: body }))}
            onMilestoneDraftChange={(body) => setMilestoneDrafts((cur) => ({ ...cur, [itemKey(expandedItem)]: body }))}
            onIssueState={(nextState) => { void updateIssueState(expandedItem, nextState); }}
            onIssueLabels={() => { void updateIssueLabels(expandedItem); }}
            lockReasonDraft={lockReasonDrafts[itemKey(expandedItem)] ?? ""}
            onLockReasonDraftChange={(body) => setLockReasonDrafts((cur) => ({ ...cur, [itemKey(expandedItem)]: body }))}
            onToggleLock={() => { void runToggleLock(expandedItem); }}
            transferDraft={transferDrafts[itemKey(expandedItem)] ?? ""}
            onTransferDraftChange={(body) => {
              setTransferDrafts((cur) => ({ ...cur, [itemKey(expandedItem)]: body }));
              setTransferConfirm((cur) => ({ ...cur, [itemKey(expandedItem)]: false }));
            }}
            transferConfirming={!!transferConfirm[itemKey(expandedItem)]}
            onTransferIssue={() => { void runTransferIssue(expandedItem); }}
            onCancelTransfer={() => setTransferConfirm((cur) => ({ ...cur, [itemKey(expandedItem)]: false }))}
            onCommentDraftChange={(body) => setCommentDrafts((cur) => ({ ...cur, [itemKey(expandedItem)]: body }))}
            onSubmitComment={() => { void submitComment(expandedItem); }}
            onRetryComments={() => {
              setCommentErrors((cur) => ({ ...cur, [itemKey(expandedItem)]: undefined }));
            }}
            onRetryDiff={() => {
              if (expandedItem.kind !== "pulls") return;
              setDiffErrors((cur) => ({ ...cur, [itemKey(expandedItem)]: undefined }));
            }}
            onRetryChecks={() => {
              if (expandedItem.kind !== "pulls") return;
              setChecksErrors((cur) => ({ ...cur, [itemKey(expandedItem)]: undefined }));
            }}
            onRetryCommitStatus={() => {
              if (expandedItem.kind !== "pulls") return;
              setCommitStatusErrors((cur) => ({ ...cur, [itemKey(expandedItem)]: undefined }));
            }}
            onRefreshDiff={() => {
              if (expandedItem.kind !== "pulls") return;
              setDiffs((cur) => ({ ...cur, [itemKey(expandedItem)]: undefined }));
              setDiffErrors((cur) => ({ ...cur, [itemKey(expandedItem)]: undefined }));
              // A refreshed diff may renumber lines under any queued comments.
              if ((pendingReview[itemKey(expandedItem)] ?? []).length > 0) {
                setPendingStale((cur) => ({ ...cur, [itemKey(expandedItem)]: true }));
              }
            }}
            onRefreshChecks={() => {
              if (expandedItem.kind !== "pulls") return;
              setChecks((cur) => ({ ...cur, [itemKey(expandedItem)]: undefined }));
              setChecksErrors((cur) => ({ ...cur, [itemKey(expandedItem)]: undefined }));
            }}
            onRefreshCommitStatus={() => {
              if (expandedItem.kind !== "pulls") return;
              setCommitStatus((cur) => ({ ...cur, [itemKey(expandedItem)]: undefined }));
              setCommitStatusErrors((cur) => ({ ...cur, [itemKey(expandedItem)]: undefined }));
            }}
            onRefreshMergeability={() => {
              if (expandedItem.kind !== "pulls") return;
              mergeabilityRetries.current[itemKey(expandedItem)] = 0;
              setMergeability((cur) => ({ ...cur, [itemKey(expandedItem)]: undefined }));
              setMergeabilityErrors((cur) => ({ ...cur, [itemKey(expandedItem)]: undefined }));
            }}
            onRetryCommits={() => {
              if (expandedItem.kind !== "pulls") return;
              setCommitsErrors((cur) => ({ ...cur, [itemKey(expandedItem)]: undefined }));
            }}
          />
        ) : isComposeView ? (
          // Compose is its own dedicated subpage — render only the composer,
          // never the manager panels or the item list underneath it. Which
          // composer shows follows the dialog's existing pulls/issues `kind`
          // state, exactly like the list body below does.
          kind === "pulls" ? (
            <PullComposer
              caps={caps}
              title={newPullTitle}
              body={newPullBody}
              head={newPullHead}
              base={newPullBase}
              reviewers={newPullReviewers}
              draft={newPullDraft}
              submitting={newPullSubmitting}
              error={newPullError}
              pushing={newPullPushing}
              pushError={newPullPushError}
              pushMessage={newPullPushMessage}
              onTitleChange={setNewPullTitle}
              onBodyChange={setNewPullBody}
              onHeadChange={setNewPullHead}
              onBaseChange={setNewPullBase}
              onReviewersChange={setNewPullReviewers}
              onDraftChange={setNewPullDraft}
              onPushHead={() => { void pushHead(); }}
              onCancel={() => setView(backToList())}
              onSubmit={() => { void createPull(); }}
            />
          ) : (
            <IssueComposer
              caps={caps}
              title={newIssueTitle}
              body={newIssueBody}
              labels={newIssueLabels}
              assignees={newIssueAssignees}
              milestone={newIssueMilestone}
              submitting={newIssueSubmitting}
              error={newIssueError}
              onTitleChange={setNewIssueTitle}
              onBodyChange={setNewIssueBody}
              onLabelsChange={setNewIssueLabels}
              onAssigneesChange={setNewIssueAssignees}
              onMilestoneChange={setNewIssueMilestone}
              onCancel={() => setView(backToList())}
              onSubmit={() => { void createIssue(); }}
            />
          )
        ) : (
        <>
        {labelManagerOpen && (
          <LabelManager
            labels={repoLabels}
            authenticated={canPush}
            onCreate={createLabel}
            onEdit={editLabel}
            onDelete={removeLabel}
            onRefresh={() => { void refreshRepoLabels(); }}
            onClose={() => setView(backToList())}
          />
        )}
        {milestoneManagerOpen && (
          <MilestoneManager
            milestones={repoMilestones}
            authenticated={canPush}
            onCreate={createMilestone}
            onEdit={editMilestone}
            onDelete={removeMilestone}
            onRefresh={() => { void refreshRepoMilestones(); }}
            onClose={() => setView(backToList())}
          />
        )}
        {releaseManagerOpen && (
          <ReleasesManager
            releases={repoReleases}
            tags={repoTags}
            authenticated={canPush}
            onCreate={createRelease}
            onEdit={editRelease}
            onDelete={removeRelease}
            onRefresh={() => { void refreshRepoReleases(); }}
            onClose={() => setView(backToList())}
          />
        )}
        {notificationsOpen && (
          <NotificationsPanel
            notifications={notifications}
            loading={notificationsLoading}
            error={notificationsError}
            showAll={notificationsShowAll}
            onToggleShowAll={() => setNotificationsShowAll((v) => !v)}
            onRefresh={() => { void refreshNotifications(); }}
            onMarkAllRead={() => { void markAllNotificationsRead(); }}
            markAllBusy={notificationsMarkAllBusy}
            onMarkRead={(id) => { void markNotificationRead(id); }}
            onIgnore={(id) => { void ignoreNotificationThread(id); }}
            onUnsubscribe={(id) => { void unsubscribeNotificationThread(id); }}
            busy={notificationBusy}
            rowErrors={notificationRowErrors}
            onClose={() => setView(backToList())}
          />
        )}
        {actionsManagerOpen && (
          <ActionsPanel
            runs={workflowRuns}
            workflows={workflows}
            loading={actionsLoading}
            error={actionsError}
            authenticated={canPush}
            runBusy={workflowRunBusy}
            runErrors={workflowRunErrors}
            onRerun={(runId) => { void rerunWorkflowRun(runId, false); }}
            onRerunFailed={(runId) => { void rerunWorkflowRun(runId, true); }}
            onCancel={(runId) => { void cancelWorkflowRun(runId); }}
            dispatchWorkflowId={dispatchWorkflowId}
            onDispatchWorkflowIdChange={setDispatchWorkflowId}
            dispatchRef={dispatchRef}
            onDispatchRefChange={setDispatchRef}
            dispatchInputs={dispatchInputs}
            onAddDispatchInputRow={addDispatchInputRow}
            onRemoveDispatchInputRow={removeDispatchInputRow}
            onUpdateDispatchInputRow={updateDispatchInputRow}
            dispatchBusy={dispatchBusy}
            dispatchError={dispatchError}
            dispatchMessage={dispatchMessage}
            onDispatch={() => { void dispatchWorkflow(); }}
            onRefresh={() => { void refreshActions(); }}
            onClose={() => setView(backToList())}
          />
        )}
        {projectsManagerOpen && (
          <ProjectsPanel
            projects={projectsV2}
            loading={projectsLoading}
            error={projectsError}
            authenticated={canPush}
            selectedProjectId={selectedProjectId}
            onSelectProject={setSelectedProjectId}
            items={projectItems}
            statusField={projectStatusField}
            itemsLoading={projectItemsLoading}
            itemsError={projectItemsError}
            itemBusy={projectItemBusy}
            itemErrors={projectItemErrors}
            onSetStatus={(itemId, optionId, optionName) => { void setProjectItemStatus(itemId, optionId, optionName); }}
            onRemoveItem={(itemId) => { void removeProjectItem(itemId); }}
            addNumber={projectAddNumber}
            onAddNumberChange={setProjectAddNumber}
            addKind={projectAddKind}
            onAddKindChange={setProjectAddKind}
            addBusy={projectAddBusy}
            addError={projectAddError}
            onAddItem={() => { void addProjectItem(); }}
            onRefresh={() => { void refreshProjects(); }}
            onRefreshItems={() => { void refreshProjectItems(); }}
            onClose={() => setView(backToList())}
          />
        )}
        {discussionsManagerOpen && (
          <DiscussionsPanel
            discussions={discussions}
            categories={discussionCategories}
            auth={discussionsAuth}
            canPush={canPush}
            viewerLogin={viewerLogin}
            loading={discussionsLoading}
            error={discussionsError}
            rowBusy={discussionRowBusy}
            rowErrors={discussionRowErrors}
            onSelect={toggleDiscussion}
            onDelete={(discussion) => { void deleteDiscussionRow(discussion); }}
            selected={selectedDiscussion}
            detail={discussionDetail}
            detailLoading={discussionDetailLoading}
            detailError={discussionDetailError}
            commentDraft={discussionCommentDraft}
            onCommentDraftChange={setDiscussionCommentDraft}
            commentBusy={discussionCommentBusy}
            commentError={discussionCommentError}
            onSubmitComment={() => { void submitDiscussionComment(); }}
            commentBusyMap={discussionCommentBusyMap}
            commentErrors={discussionCommentErrors}
            onSetAnswer={(comment, answer) => { void setDiscussionAnswer(comment, answer); }}
            onDeleteComment={(comment) => { void deleteDiscussionComment(comment); }}
            createOpen={discussionCreateOpen}
            onCreateOpenChange={setDiscussionCreateOpen}
            newCategoryId={newDiscussionCategoryId}
            onNewCategoryIdChange={setNewDiscussionCategoryId}
            newTitle={newDiscussionTitle}
            onNewTitleChange={setNewDiscussionTitle}
            newBody={newDiscussionBody}
            onNewBodyChange={setNewDiscussionBody}
            createBusy={discussionCreateBusy}
            createError={discussionCreateError}
            onCreate={() => { void createDiscussion(); }}
            onRefresh={() => { void refreshDiscussions(); }}
            onClose={() => setView(backToList())}
          />
        )}
        {/* Trigger buttons for the compose subpage (moved out of the composer
            components themselves — those now always render in "open" form,
            only ever mounted on the compose page). */}
        {kind === "pulls" && !isAggregate && (
          <div className="mb-3 flex justify-end">
            <Button size="sm" onClick={() => setView(openCompose())}>
              <Plus className="mr-2 size-3.5" />
              New {caps.pullAbbrev}
            </Button>
          </div>
        )}

        {kind === "issues" && !isAggregate && (
          <div className="mb-3 flex justify-end">
            <Button size="sm" onClick={() => setView(openCompose())}>
              <Plus className="mr-2 size-3.5" />
              New issue
            </Button>
          </div>
        )}

        {transferNotice && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
            <span className="flex items-center gap-1">
              <CheckCircle2 className="size-3.5" />
              {transferNotice.message}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => { void api.openExternal(transferNotice.url); }}>
                Open
              </Button>
              <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => setTransferNotice(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {!loading && error && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-rose-400">
            <AlertCircle className="size-4" /> {error}
          </div>
        )}

        {loading && !result && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading GitHub…
          </div>
        )}

        {!loading && !error && result && result.items.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-muted-foreground">
            <GitPullRequest className="size-6 opacity-40" />
            No {kind === "pulls" ? caps.pullNounPlural.toLowerCase() : "issues"} match these filters.
          </div>
        )}

        {result && result.items.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="px-1 text-xs text-muted-foreground">
              {result.items.length} {kind === "pulls" ? caps.pullNounPlural.toLowerCase() : "issues"}
            </div>
            {result.items.map((item) => (
              <GitHubItemRow
                key={itemKey(item)}
                item={item}
                caps={caps}
                repoBadge={isAggregate ? repoLabelFor(item) : undefined}
                onToggle={() => openItemDetail(item)}
              />
            ))}
            {/* "Load more" is disabled in aggregate mode (G8) — each aggregate
                fetch already covers page 1 per repo; `result.hasMore` there
                means "at least one repo's results were truncated to one page"
                rather than "there's a page 2 to fetch". */}
            {result.hasMore && !isAggregate && (
              <div className="flex justify-center py-1">
                <Button size="sm" variant="outline" disabled={loadingMore || loading || reloadPending} onClick={loadMore}>
                  {loadingMore ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
                  Load more
                </Button>
              </div>
            )}
            {result.hasMore && isAggregate && (
              <div className="px-1 text-[11px] text-muted-foreground">
                Some repositories have more results than shown here — switch to a single project to see them all.
              </div>
            )}
          </div>
        )}
        </>
        )}
      </div>
    </Dialog>
  );
}

// Always rendered in "open" form — only ever mounted on the compose subpage
// (see the `isComposeView` branch above). The "New <pull>" trigger that used
// to gate this component closed lives in the list view instead, since
// opening now navigates to a dedicated page rather than toggling local state.
function PullComposer({
  caps,
  title,
  body,
  head,
  base,
  reviewers,
  draft,
  submitting,
  error,
  pushing,
  pushError,
  pushMessage,
  onTitleChange,
  onBodyChange,
  onHeadChange,
  onBaseChange,
  onReviewersChange,
  onDraftChange,
  onPushHead,
  onCancel,
  onSubmit,
}: {
  caps: ProviderCaps;
  title: string;
  body: string;
  head: string;
  base: string;
  reviewers: string;
  draft: boolean;
  submitting: boolean;
  error: string | null;
  pushing: boolean;
  pushError: string | null;
  pushMessage: string | null;
  onTitleChange: (title: string) => void;
  onBodyChange: (body: string) => void;
  onHeadChange: (head: string) => void;
  onBaseChange: (base: string) => void;
  onReviewersChange: (reviewers: string) => void;
  onDraftChange: (draft: boolean) => void;
  onPushHead: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="mb-3 rounded-md border border-border/60 bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <GitPullRequest className="size-3.5" />
          New {caps.pullNoun.toLowerCase()}
        </div>
        {error && (
          <span className="inline-flex items-center gap-1 text-[11px] text-rose-400">
            <AlertCircle className="size-3.5" />
            {error}
          </span>
        )}
      </div>
      <div className="grid gap-2">
        <Input
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder="Title"
          className="h-8 text-sm"
          disabled={submitting}
        />
        <div className="grid gap-2 md:grid-cols-2">
          <Input
            value={head}
            onChange={(e) => onHeadChange(e.target.value)}
            placeholder="Head branch"
            className="h-8 text-xs"
            disabled={submitting}
          />
          <Input
            value={base}
            onChange={(e) => onBaseChange(e.target.value)}
            placeholder="Base branch"
            className="h-8 text-xs"
            disabled={submitting}
          />
        </div>
        <Textarea
          value={body}
          onChange={(e) => onBodyChange(e.target.value)}
          placeholder="Markdown body..."
          className="min-h-24 resize-y text-sm"
          disabled={submitting}
        />
        <Input
          value={reviewers}
          onChange={(e) => onReviewersChange(e.target.value)}
          placeholder="Reviewers, comma separated"
          className="h-8 text-xs"
          disabled={submitting}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={submitting || pushing || !head.trim()}
            onClick={onPushHead}
            title={`Push the head branch to its remote so ${caps.providerName} can open the ${caps.pullNoun.toLowerCase()}`}
          >
            {pushing ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <ArrowUpFromLine className="mr-2 size-3.5" />}
            Push head
          </Button>
          {pushMessage && (
            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
              <CheckCircle2 className="size-3.5" />
              {pushMessage}
            </span>
          )}
          {pushError && (
            <span className="inline-flex items-center gap-1 text-[11px] text-rose-400">
              <AlertCircle className="size-3.5" />
              {pushError}
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          The head branch must exist on the remote before {caps.providerName} can open the {caps.pullNoun.toLowerCase()} — push it first if it's a new local branch.
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={draft}
            disabled={submitting}
            onChange={(e) => onDraftChange(e.target.checked)}
          />
          Draft
        </label>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={submitting} onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={submitting || !title.trim() || !head.trim() || !base.trim()} onClick={onSubmit}>
            {submitting ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Plus className="mr-2 size-3.5" />}
            Create {caps.pullAbbrev}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Always rendered in "open" form — only ever mounted on the compose subpage
// (see the `isComposeView` branch above). The "New issue" trigger that used
// to gate this component closed lives in the list view instead, since
// opening now navigates to a dedicated page rather than toggling local state.
function IssueComposer({
  caps,
  title,
  body,
  labels,
  assignees,
  milestone,
  submitting,
  error,
  onTitleChange,
  onBodyChange,
  onLabelsChange,
  onAssigneesChange,
  onMilestoneChange,
  onCancel,
  onSubmit,
}: {
  caps: ProviderCaps;
  title: string;
  body: string;
  labels: string;
  assignees: string;
  milestone: string;
  submitting: boolean;
  error: string | null;
  onTitleChange: (title: string) => void;
  onBodyChange: (body: string) => void;
  onLabelsChange: (labels: string) => void;
  onAssigneesChange: (assignees: string) => void;
  onMilestoneChange: (milestone: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="mb-3 rounded-md border border-border/60 bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Plus className="size-3.5" />
          New issue
        </div>
        {error && (
          <span className="inline-flex items-center gap-1 text-[11px] text-rose-400">
            <AlertCircle className="size-3.5" />
            {error}
          </span>
        )}
      </div>
      <div className="grid gap-2">
        <Input
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder="Title"
          className="h-8 text-sm"
          disabled={submitting}
        />
        <Textarea
          value={body}
          onChange={(e) => onBodyChange(e.target.value)}
          placeholder="Markdown body..."
          className="min-h-24 resize-y text-sm"
          disabled={submitting}
        />
        {caps.labels && (
          <Input
            value={labels}
            onChange={(e) => onLabelsChange(e.target.value)}
            placeholder="Labels, comma separated"
            className="h-8 text-xs"
            disabled={submitting}
          />
        )}
        <div className="grid gap-2 md:grid-cols-2">
          <Input
            value={assignees}
            onChange={(e) => onAssigneesChange(e.target.value)}
            placeholder="Assignees, comma separated"
            className="h-8 text-xs"
            disabled={submitting}
          />
          {caps.milestones && (
            <Input
              value={milestone}
              onChange={(e) => onMilestoneChange(e.target.value)}
              placeholder="Milestone number"
              className="h-8 text-xs"
              disabled={submitting}
            />
          )}
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={submitting} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={submitting || !title.trim()} onClick={onSubmit}>
          {submitting ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Plus className="mr-2 size-3.5" />}
          Create issue
        </Button>
      </div>
    </div>
  );
}

function labelSwatch(color: string): string {
  return color.trim() ? `#${color.replace(/^#/, "")}` : "transparent";
}

function LabelManager({
  labels,
  authenticated,
  onCreate,
  onEdit,
  onDelete,
  onRefresh,
  onClose,
}: {
  labels: GitHubRepoLabel[];
  // The viewer has push access to this repo (F13). Controls stay visible but
  // disabled (with a tooltip) when false, rather than hidden, so the UI still
  // communicates the capability exists.
  authenticated: boolean;
  onCreate: (name: string, color: string, description: string) => Promise<void>;
  onEdit: (name: string, patch: { newName?: string; color?: string; description?: string }) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    const n = name.trim();
    if (!n || creating) return;
    setCreating(true);
    setError(null);
    try {
      await onCreate(n, color, description);
      setName("");
      setColor("");
      setDescription("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="mb-3 rounded-md border border-border/60 bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Tag className="size-3.5" />
          Labels ({labels.length})
        </div>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" className="size-6" title="Refresh labels" aria-label="Refresh labels" onClick={onRefresh}>
            <RefreshCw className="size-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      <div className="mb-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.4fr)_auto]">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="h-8 text-xs" disabled={creating || !authenticated} />
        <div className="flex items-center gap-1">
          <span className="size-4 shrink-0 rounded-full border border-border/60" style={{ backgroundColor: labelSwatch(color) }} />
          <Input value={color} onChange={(e) => setColor(e.target.value)} placeholder="hex" className="h-8 w-20 text-xs" disabled={creating || !authenticated} />
        </div>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" className="h-8 text-xs" disabled={creating || !authenticated} />
        <Button
          size="sm"
          disabled={creating || !name.trim() || !authenticated}
          title={authenticated ? undefined : PUSH_ONLY_TITLE}
          onClick={() => { void create(); }}
        >
          {creating ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Plus className="mr-2 size-3.5" />}
          Add
        </Button>
      </div>
      {error && (
        <div className="mb-2 flex items-center gap-1 text-[11px] text-rose-400">
          <AlertCircle className="size-3.5" />
          {error}
        </div>
      )}
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {labels.length === 0 ? (
          <div className="px-1 py-2 text-[11px] text-muted-foreground">No labels in this repository.</div>
        ) : (
          labels.map((l) => <LabelRow key={l.name} label={l} authenticated={authenticated} onEdit={onEdit} onDelete={onDelete} />)
        )}
      </div>
    </div>
  );
}

function LabelRow({
  label,
  authenticated,
  onEdit,
  onDelete,
}: {
  label: GitHubRepoLabel;
  authenticated: boolean;
  onEdit: (name: string, patch: { newName?: string; color?: string; description?: string }) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(label.name);
  const [color, setColor] = useState(label.color);
  const [description, setDescription] = useState(label.description);
  const [busy, setBusy] = useState<null | "save" | "delete">(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setName(label.name); setColor(label.color); setDescription(label.description); setError(null); };

  const save = async () => {
    if (busy || !name.trim()) return;
    setBusy("save");
    setError(null);
    try {
      await onEdit(label.name, { newName: name.trim(), color, description });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const del = async () => {
    if (busy) return;
    setBusy("delete");
    setError(null);
    try {
      await onDelete(label.name); // success unmounts this row
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
      setConfirm(false);
    }
  };

  if (editing) {
    return (
      <div className="rounded border border-border/60 p-2">
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.4fr)]">
          <Input value={name} onChange={(e) => setName(e.target.value)} className="h-7 text-xs" disabled={busy === "save"} />
          <div className="flex items-center gap-1">
            <span className="size-4 shrink-0 rounded-full border border-border/60" style={{ backgroundColor: labelSwatch(color) }} />
            <Input value={color} onChange={(e) => setColor(e.target.value)} placeholder="hex" className="h-7 w-20 text-xs" disabled={busy === "save"} />
          </div>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" className="h-7 text-xs" disabled={busy === "save"} />
        </div>
        {error && (
          <div className="mt-1 flex items-center gap-1 text-[11px] text-rose-400">
            <AlertCircle className="size-3.5" />
            {error}
          </div>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={busy === "save"} onClick={() => { setEditing(false); reset(); }}>
            Cancel
          </Button>
          <Button size="sm" className="h-6 px-2 text-[11px]" disabled={busy === "save" || !name.trim()} onClick={() => { void save(); }}>
            {busy === "save" ? <Loader2 className="mr-1 size-3 animate-spin" /> : <FilePen className="mr-1 size-3" />}
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded px-1 py-1 text-xs">
      <span
        className="shrink-0 rounded border px-1.5 py-0.5 text-[11px]"
        style={{ borderColor: label.color ? `#${label.color}` : undefined, backgroundColor: label.color ? `#${label.color}22` : undefined }}
      >
        {label.name}
      </span>
      {label.description && <span className="min-w-0 flex-1 truncate text-muted-foreground">{label.description}</span>}
      {error && <span className="truncate text-[11px] text-rose-400">{error}</span>}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          title={authenticated ? "Edit label" : PUSH_ONLY_TITLE}
          aria-label={`Edit ${label.name}`}
          disabled={!!busy || !authenticated}
          onClick={() => { reset(); setEditing(true); }}
        >
          <FilePen className="size-3.5" />
        </Button>
        {confirm ? (
          <>
            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px] text-rose-400" disabled={busy === "delete"} onClick={() => { void del(); }}>
              {busy === "delete" ? <Loader2 className="size-3 animate-spin" /> : "Confirm"}
            </Button>
            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" disabled={busy === "delete"} onClick={() => setConfirm(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="icon"
            variant="ghost"
            className="size-6 text-muted-foreground hover:text-rose-400"
            title={authenticated ? "Delete label" : PUSH_ONLY_TITLE}
            aria-label={`Delete ${label.name}`}
            disabled={!!busy || !authenticated}
            onClick={() => setConfirm(true)}
          >
            <XCircle className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

/** An ISO due date → the bare `YYYY-MM-DD` a native date input expects. */
function dueDateInput(dueOn: string | null): string {
  return dueOn ? dueOn.slice(0, 10) : "";
}

function MilestoneManager({
  milestones,
  authenticated,
  onCreate,
  onEdit,
  onDelete,
  onRefresh,
  onClose,
}: {
  milestones: GitHubRepoMilestone[];
  // A token is present. Note: GitHub still enforces push access — a read-only
  // collaborator sees the controls but the mutations 403.
  authenticated: boolean;
  onCreate: (title: string, description: string, dueOn: string) => Promise<void>;
  onEdit: (
    number: number,
    patch: { title?: string; description?: string; dueOn?: string | null; state?: "open" | "closed" },
  ) => Promise<void>;
  onDelete: (number: number) => Promise<void>;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    const t = title.trim();
    if (!t || creating) return;
    setCreating(true);
    setError(null);
    try {
      await onCreate(t, description, dueOn);
      setTitle("");
      setDueOn("");
      setDescription("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="mb-3 rounded-md border border-border/60 bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Milestone className="size-3.5" />
          Milestones ({milestones.length})
        </div>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" className="size-6" title="Refresh milestones" aria-label="Refresh milestones" onClick={onRefresh}>
            <RefreshCw className="size-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      <div className="mb-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.4fr)_auto]">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="h-8 text-xs" disabled={creating || !authenticated} />
        <Input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} title="Due date (optional)" className="h-8 w-36 text-xs" disabled={creating || !authenticated} />
        <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" className="h-8 text-xs" disabled={creating || !authenticated} />
        <Button
          size="sm"
          disabled={creating || !title.trim() || !authenticated}
          title={authenticated ? undefined : PUSH_ONLY_TITLE}
          onClick={() => { void create(); }}
        >
          {creating ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Plus className="mr-2 size-3.5" />}
          Add
        </Button>
      </div>
      {error && (
        <div className="mb-2 flex items-center gap-1 text-[11px] text-rose-400">
          <AlertCircle className="size-3.5" />
          {error}
        </div>
      )}
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {milestones.length === 0 ? (
          <div className="px-1 py-2 text-[11px] text-muted-foreground">No milestones in this repository.</div>
        ) : (
          milestones.map((m) => <MilestoneRow key={m.number} milestone={m} authenticated={authenticated} onEdit={onEdit} onDelete={onDelete} />)
        )}
      </div>
    </div>
  );
}

function MilestoneRow({
  milestone,
  authenticated,
  onEdit,
  onDelete,
}: {
  milestone: GitHubRepoMilestone;
  authenticated: boolean;
  onEdit: (
    number: number,
    patch: { title?: string; description?: string; dueOn?: string | null; state?: "open" | "closed" },
  ) => Promise<void>;
  onDelete: (number: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(milestone.title);
  const [dueOn, setDueOn] = useState(dueDateInput(milestone.dueOn));
  const [description, setDescription] = useState(milestone.description);
  const [busy, setBusy] = useState<null | "save" | "delete" | "state">(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTitle(milestone.title);
    setDueOn(dueDateInput(milestone.dueOn));
    setDescription(milestone.description);
    setError(null);
  };

  const save = async () => {
    if (busy || !title.trim()) return;
    setBusy("save");
    setError(null);
    try {
      // Send dueOn only when the field is non-empty (the API can't clear a due
      // date), so leaving it blank preserves the existing one.
      await onEdit(milestone.number, { title: title.trim(), description, ...(dueOn ? { dueOn } : {}) });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const toggleState = async () => {
    if (busy) return;
    setBusy("state");
    setError(null);
    try {
      await onEdit(milestone.number, { state: milestone.state === "open" ? "closed" : "open" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const del = async () => {
    if (busy) return;
    setBusy("delete");
    setError(null);
    try {
      await onDelete(milestone.number); // success unmounts this row
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
      setConfirm(false);
    }
  };

  if (editing) {
    return (
      <div className="rounded border border-border/60 p-2">
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.4fr)]">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} className="h-7 text-xs" disabled={busy === "save"} />
          <Input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} title="Due date" className="h-7 w-36 text-xs" disabled={busy === "save"} />
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" className="h-7 text-xs" disabled={busy === "save"} />
        </div>
        {error && (
          <div className="mt-1 flex items-center gap-1 text-[11px] text-rose-400">
            <AlertCircle className="size-3.5" />
            {error}
          </div>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={busy === "save"} onClick={() => { setEditing(false); reset(); }}>
            Cancel
          </Button>
          <Button size="sm" className="h-6 px-2 text-[11px]" disabled={busy === "save" || !title.trim()} onClick={() => { void save(); }}>
            {busy === "save" ? <Loader2 className="mr-1 size-3 animate-spin" /> : <FilePen className="mr-1 size-3" />}
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded px-1 py-1 text-xs">
      <Milestone className={cn("size-3.5 shrink-0", milestone.state === "closed" ? "text-muted-foreground" : "text-emerald-400")} />
      <span className={cn("min-w-0 shrink truncate font-medium", milestone.state === "closed" && "text-muted-foreground line-through")}>
        {milestone.title}
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {milestone.openIssues} open · {milestone.closedIssues} closed
        {milestone.dueOn && ` · due ${dueDateInput(milestone.dueOn)}`}
      </span>
      {error && <span className="truncate text-[11px] text-rose-400">{error}</span>}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          title={authenticated ? "Edit milestone" : PUSH_ONLY_TITLE}
          aria-label={`Edit ${milestone.title}`}
          disabled={!!busy || !authenticated}
          onClick={() => { reset(); setEditing(true); }}
        >
          <FilePen className="size-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-[11px]"
          title={authenticated ? (milestone.state === "open" ? "Close milestone" : "Reopen milestone") : PUSH_ONLY_TITLE}
          disabled={!!busy || !authenticated}
          onClick={() => { void toggleState(); }}
        >
          {busy === "state" ? <Loader2 className="size-3 animate-spin" /> : milestone.state === "open" ? "Close" : "Reopen"}
        </Button>
        {confirm ? (
          <>
            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px] text-rose-400" disabled={busy === "delete"} onClick={() => { void del(); }}>
              {busy === "delete" ? <Loader2 className="size-3 animate-spin" /> : "Confirm"}
            </Button>
            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" disabled={busy === "delete"} onClick={() => setConfirm(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="icon"
            variant="ghost"
            className="size-6 text-muted-foreground hover:text-rose-400"
            title={authenticated ? "Delete milestone" : PUSH_ONLY_TITLE}
            aria-label={`Delete ${milestone.title}`}
            disabled={!!busy || !authenticated}
            onClick={() => setConfirm(true)}
          >
            <XCircle className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

/** A release's publish date for display — falls back to `createdAt` for a
 *  draft, which has no `publishedAt` yet. */
function releaseDateLabel(release: GitHubRelease): string {
  const date = release.publishedAt ?? release.createdAt;
  return date ? fmtDate(date) : "";
}

function ReleasesManager({
  releases,
  tags,
  authenticated,
  onCreate,
  onEdit,
  onDelete,
  onRefresh,
  onClose,
}: {
  releases: GitHubRelease[];
  tags: GitHubTag[];
  authenticated: boolean;
  onCreate: (tagName: string, name: string, body: string, draft: boolean, prerelease: boolean) => Promise<void>;
  onEdit: (
    id: number,
    patch: { name?: string; body?: string; draft?: boolean; prerelease?: boolean; tagName?: string },
  ) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [tagName, setTagName] = useState("");
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [prerelease, setPrerelease] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    const t = tagName.trim();
    if (!t || creating) return;
    setCreating(true);
    setError(null);
    try {
      await onCreate(t, name, body, draft, prerelease);
      setTagName("");
      setName("");
      setBody("");
      setDraft(false);
      setPrerelease(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="mb-3 rounded-md border border-border/60 bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Rocket className="size-3.5" />
          Releases ({releases.length})
        </div>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" className="size-6" title="Refresh releases" aria-label="Refresh releases" onClick={onRefresh}>
            <RefreshCw className="size-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      <div className="mb-2 grid gap-2 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)]">
        <Input
          value={tagName}
          onChange={(e) => setTagName(e.target.value)}
          placeholder="Tag name"
          className="h-8 text-xs"
          list="github-dialog-release-tags"
          disabled={creating || !authenticated}
        />
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Release title (optional)" className="h-8 text-xs" disabled={creating || !authenticated} />
        <datalist id="github-dialog-release-tags">
          {tags.map((t) => <option key={t.name} value={t.name} />)}
        </datalist>
      </div>
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Release notes (optional, markdown)"
        className="mb-2 min-h-16 resize-y text-xs"
        disabled={creating || !authenticated}
      />
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <input type="checkbox" checked={draft} disabled={creating || !authenticated} onChange={(e) => setDraft(e.target.checked)} />
          Draft
        </label>
        <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <input type="checkbox" checked={prerelease} disabled={creating || !authenticated} onChange={(e) => setPrerelease(e.target.checked)} />
          Pre-release
        </label>
        <Button
          size="sm"
          className="ml-auto"
          disabled={creating || !tagName.trim() || !authenticated}
          title={authenticated ? undefined : PUSH_ONLY_TITLE}
          onClick={() => { void create(); }}
        >
          {creating ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Plus className="mr-2 size-3.5" />}
          Add
        </Button>
      </div>
      {error && (
        <div className="mb-2 flex items-center gap-1 text-[11px] text-rose-400">
          <AlertCircle className="size-3.5" />
          {error}
        </div>
      )}
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {releases.length === 0 ? (
          <div className="px-1 py-2 text-[11px] text-muted-foreground">No releases in this repository.</div>
        ) : (
          releases.map((r) => <ReleaseRow key={r.id} release={r} authenticated={authenticated} onEdit={onEdit} onDelete={onDelete} />)
        )}
      </div>
    </div>
  );
}

function ReleaseRow({
  release,
  authenticated,
  onEdit,
  onDelete,
}: {
  release: GitHubRelease;
  authenticated: boolean;
  onEdit: (
    id: number,
    patch: { name?: string; body?: string; draft?: boolean; prerelease?: boolean; tagName?: string },
  ) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(release.name);
  const [body, setBody] = useState(release.body);
  const [draft, setDraft] = useState(release.draft);
  const [prerelease, setPrerelease] = useState(release.prerelease);
  const [busy, setBusy] = useState<null | "save" | "delete">(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName(release.name);
    setBody(release.body);
    setDraft(release.draft);
    setPrerelease(release.prerelease);
    setError(null);
  };

  const save = async () => {
    if (busy) return;
    setBusy("save");
    setError(null);
    try {
      await onEdit(release.id, { name, body, draft, prerelease });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const del = async () => {
    if (busy) return;
    setBusy("delete");
    setError(null);
    try {
      await onDelete(release.id); // success unmounts this row
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
      setConfirm(false);
    }
  };

  if (editing) {
    return (
      <div className="rounded border border-border/60 p-2">
        <div className="grid gap-2 md:grid-cols-[minmax(0,0.6fr)_minmax(0,1fr)]">
          <span className="flex items-center truncate rounded border border-border/60 px-2 text-[11px] text-muted-foreground">{release.tagName}</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Release title" className="h-7 text-xs" disabled={busy === "save"} />
        </div>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Release notes" className="mt-2 min-h-16 resize-y text-xs" disabled={busy === "save"} />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input type="checkbox" checked={draft} disabled={busy === "save"} onChange={(e) => setDraft(e.target.checked)} />
            Draft
          </label>
          <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input type="checkbox" checked={prerelease} disabled={busy === "save"} onChange={(e) => setPrerelease(e.target.checked)} />
            Pre-release
          </label>
        </div>
        {error && (
          <div className="mt-1 flex items-center gap-1 text-[11px] text-rose-400">
            <AlertCircle className="size-3.5" />
            {error}
          </div>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={busy === "save"} onClick={() => { setEditing(false); reset(); }}>
            Cancel
          </Button>
          <Button size="sm" className="h-6 px-2 text-[11px]" disabled={busy === "save"} onClick={() => { void save(); }}>
            {busy === "save" ? <Loader2 className="mr-1 size-3 animate-spin" /> : <FilePen className="mr-1 size-3" />}
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded px-1 py-1 text-xs">
      <Rocket className="size-3.5 shrink-0 text-emerald-400" />
      <span className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{release.tagName}</span>
      <span className="min-w-0 shrink truncate font-medium">{release.name || release.tagName}</span>
      {release.draft && <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">Draft</span>}
      {release.prerelease && <span className="shrink-0 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-400">Pre-release</span>}
      <span className="shrink-0 text-[11px] text-muted-foreground">{releaseDateLabel(release)}</span>
      {error && <span className="truncate text-[11px] text-rose-400">{error}</span>}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          title="Open release on GitHub"
          aria-label={`Open ${release.tagName} on GitHub`}
          onClick={() => { void api.openExternal(release.htmlUrl); }}
        >
          <ExternalLink className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          title={authenticated ? "Edit release" : PUSH_ONLY_TITLE}
          aria-label={`Edit ${release.tagName}`}
          disabled={!!busy || !authenticated}
          onClick={() => { reset(); setEditing(true); }}
        >
          <FilePen className="size-3.5" />
        </Button>
        {confirm ? (
          <>
            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px] text-rose-400" disabled={busy === "delete"} onClick={() => { void del(); }}>
              {busy === "delete" ? <Loader2 className="size-3 animate-spin" /> : "Confirm"}
            </Button>
            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" disabled={busy === "delete"} onClick={() => setConfirm(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="icon"
            variant="ghost"
            className="size-6 text-muted-foreground hover:text-rose-400"
            title={authenticated ? "Delete release" : PUSH_ONLY_TITLE}
            aria-label={`Delete ${release.tagName}`}
            disabled={!!busy || !authenticated}
            onClick={() => setConfirm(true)}
          >
            <XCircle className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

function NotificationsPanel({
  notifications,
  loading,
  error,
  showAll,
  onToggleShowAll,
  onRefresh,
  onMarkAllRead,
  markAllBusy,
  onMarkRead,
  onIgnore,
  onUnsubscribe,
  busy,
  rowErrors,
  onClose,
}: {
  notifications: GitHubNotification[];
  loading: boolean;
  error: string | null;
  showAll: boolean;
  onToggleShowAll: () => void;
  onRefresh: () => void;
  onMarkAllRead: () => void;
  markAllBusy: boolean;
  onMarkRead: (id: string) => void;
  onIgnore: (id: string) => void;
  onUnsubscribe: (id: string) => void;
  busy: Record<string, string | undefined>;
  rowErrors: Record<string, string | undefined>;
  onClose: () => void;
}) {
  const unreadCount = notifications.filter((n) => n.unread).length;
  return (
    <div className="mb-3 rounded-md border border-border/60 bg-card p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Bell className="size-3.5" />
          Notifications ({showAll ? notifications.length : unreadCount})
        </div>
        <div className="flex items-center gap-1">
          <div className="flex rounded-md border border-input p-0.5">
            <Button
              size="sm"
              variant={!showAll ? "secondary" : "ghost"}
              className="h-6 px-2 text-[11px]"
              onClick={() => { if (showAll) onToggleShowAll(); }}
            >
              Unread
            </Button>
            <Button
              size="sm"
              variant={showAll ? "secondary" : "ghost"}
              className="h-6 px-2 text-[11px]"
              onClick={() => { if (!showAll) onToggleShowAll(); }}
            >
              All
            </Button>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            disabled={loading || notifications.length === 0 || markAllBusy}
            onClick={onMarkAllRead}
          >
            {markAllBusy ? <Loader2 className="mr-1 size-3 animate-spin" /> : <Check className="mr-1 size-3" />}
            Mark all read
          </Button>
          <Button size="icon" variant="ghost" className="size-6" title="Refresh notifications" aria-label="Refresh notifications" disabled={loading} onClick={onRefresh}>
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      {error && (
        <div className="mb-2 flex items-center gap-1 text-[11px] text-rose-400">
          <AlertCircle className="size-3.5" />
          {error}
        </div>
      )}
      <div className="max-h-72 space-y-1 overflow-y-auto">
        {!error && notifications.length === 0 ? (
          <div className="px-1 py-2 text-[11px] text-muted-foreground">
            {loading ? "Loading…" : "No notifications."}
          </div>
        ) : (
          notifications.map((n) => (
            <NotificationRow
              key={n.id}
              notification={n}
              busy={busy[n.id]}
              error={rowErrors[n.id]}
              onMarkRead={() => onMarkRead(n.id)}
              onIgnore={() => onIgnore(n.id)}
              onUnsubscribe={() => onUnsubscribe(n.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function NotificationRow({
  notification,
  busy,
  error,
  onMarkRead,
  onIgnore,
  onUnsubscribe,
}: {
  notification: GitHubNotification;
  busy: string | undefined;
  error: string | undefined;
  onMarkRead: () => void;
  onIgnore: () => void;
  onUnsubscribe: () => void;
}) {
  // Prefer the browsable HTML URL; the api.github.com subject/comment URLs
  // would open raw JSON in the browser.
  const openUrl = notification.htmlUrl ?? notification.subjectUrl;
  return (
    <div className="rounded px-1 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            notification.unread ? "bg-sky-400" : "bg-transparent",
          )}
          aria-hidden
        />
        {openUrl ? (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left hover:underline"
            title={notification.title}
            onClick={() => { void api.openExternal(openUrl); }}
          >
            {notification.title}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate">{notification.title}</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            title="Mark as read"
            aria-label={`Mark ${notification.title} as read`}
            disabled={!!busy}
            onClick={onMarkRead}
          >
            {busy === "read" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[11px]"
            title="Ignore this conversation"
            disabled={!!busy}
            onClick={onIgnore}
          >
            {busy === "ignore" ? <Loader2 className="size-3 animate-spin" /> : <BellOff className="mr-1 size-3" />}
            Ignore
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[11px]"
            title="Unsubscribe from this thread"
            disabled={!!busy}
            onClick={onUnsubscribe}
          >
            {busy === "unsubscribe" ? <Loader2 className="size-3 animate-spin" /> : <X className="mr-1 size-3" />}
            Unsubscribe
          </Button>
        </div>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 pl-3.5 text-[11px] text-muted-foreground">
        <span className="truncate">{notification.reason.replace(/_/g, " ")}</span>
        {notification.updatedAt && (
          <>
            <span>·</span>
            <span>{fmtRelativeDate(notification.updatedAt)}</span>
          </>
        )}
      </div>
      {error && (
        <div className="mt-0.5 flex items-center gap-1 pl-3.5 text-[11px] text-rose-400">
          <AlertCircle className="size-3.5" />
          {error}
        </div>
      )}
    </div>
  );
}

/** Workflow run status/conclusion → color, mirroring `checkClass` (check-runs)
 *  and `commitStatusClass` (combined status). Not-yet-completed runs
 *  (queued/in_progress/waiting) read as "in flight" (sky); a completed run is
 *  emerald for a clean conclusion, rose otherwise (failure/cancelled/
 *  timed_out/action_required/…). */
function workflowRunClass(run: GitHubWorkflowRun): string {
  if (run.status !== "completed") return "text-sky-400";
  if (run.conclusion === "success" || run.conclusion === "neutral" || run.conclusion === "skipped") {
    return "text-emerald-400";
  }
  return "text-rose-400";
}

/** Label shown on the run's status pill — the conclusion once completed
 *  (e.g. "success", "cancelled"), otherwise the coarse status (e.g.
 *  "in_progress", "queued"). */
function workflowRunLabel(run: GitHubWorkflowRun): string {
  return (run.status === "completed" ? run.conclusion : run.status) ?? run.status;
}

function ActionsPanel({
  runs,
  workflows,
  loading,
  error,
  authenticated,
  runBusy,
  runErrors,
  onRerun,
  onRerunFailed,
  onCancel,
  dispatchWorkflowId,
  onDispatchWorkflowIdChange,
  dispatchRef,
  onDispatchRefChange,
  dispatchInputs,
  onAddDispatchInputRow,
  onRemoveDispatchInputRow,
  onUpdateDispatchInputRow,
  dispatchBusy,
  dispatchError,
  dispatchMessage,
  onDispatch,
  onRefresh,
  onClose,
}: {
  runs: GitHubWorkflowRun[];
  workflows: GitHubWorkflow[];
  loading: boolean;
  error: string | null;
  authenticated: boolean;
  runBusy: Record<number, string | undefined>;
  runErrors: Record<number, string | undefined>;
  onRerun: (runId: number) => void;
  onRerunFailed: (runId: number) => void;
  onCancel: (runId: number) => void;
  dispatchWorkflowId: string;
  onDispatchWorkflowIdChange: (id: string) => void;
  dispatchRef: string;
  onDispatchRefChange: (ref: string) => void;
  dispatchInputs: { key: string; value: string }[];
  onAddDispatchInputRow: () => void;
  onRemoveDispatchInputRow: (index: number) => void;
  onUpdateDispatchInputRow: (index: number, patch: Partial<{ key: string; value: string }>) => void;
  dispatchBusy: boolean;
  dispatchError: string | null;
  dispatchMessage: string | null;
  onDispatch: () => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const activeWorkflows = workflows.filter((w) => w.state === "active");
  const dispatchDisabled = dispatchBusy || !authenticated || !dispatchWorkflowId || !dispatchRef.trim();
  return (
    <div className="mb-3 rounded-md border border-border/60 bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Workflow className="size-3.5" />
          Actions ({runs.length})
        </div>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" className="size-6" title="Refresh Actions" aria-label="Refresh Actions" disabled={loading} onClick={onRefresh}>
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      {error && (
        <div className="mb-2 flex items-center gap-1 text-[11px] text-rose-400">
          <AlertCircle className="size-3.5" />
          {error}
        </div>
      )}
      <div className="mb-3 max-h-56 space-y-1 overflow-y-auto">
        {!error && runs.length === 0 ? (
          <div className="px-1 py-2 text-[11px] text-muted-foreground">
            {loading ? "Loading…" : "No recent workflow runs."}
          </div>
        ) : (
          runs.map((r) => (
            <WorkflowRunRow
              key={r.id}
              run={r}
              authenticated={authenticated}
              busy={runBusy[r.id]}
              error={runErrors[r.id]}
              onRerun={() => onRerun(r.id)}
              onRerunFailed={() => onRerunFailed(r.id)}
              onCancel={() => onCancel(r.id)}
            />
          ))
        )}
      </div>

      <div className="border-t border-border/60 pt-2">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Play className="size-3.5" />
          Run a workflow
        </div>
        <div className="mb-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,0.6fr)]">
          <Select
            value={dispatchWorkflowId}
            onChange={(e) => onDispatchWorkflowIdChange(e.target.value)}
            title="Workflow"
            aria-label="Workflow"
            className="h-8 text-xs"
            disabled={dispatchBusy || !authenticated}
          >
            <option value="">Select a workflow…</option>
            {activeWorkflows.map((w) => (
              <option key={w.id} value={String(w.id)}>{w.name}</option>
            ))}
          </Select>
          <Input
            value={dispatchRef}
            onChange={(e) => onDispatchRefChange(e.target.value)}
            placeholder="Ref (branch, tag, or sha) — e.g. main"
            className="h-8 text-xs"
            disabled={dispatchBusy || !authenticated}
          />
        </div>
        <div className="mb-2 space-y-1.5">
          {dispatchInputs.map((row, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                value={row.key}
                onChange={(e) => onUpdateDispatchInputRow(i, { key: e.target.value })}
                placeholder="Input name"
                className="h-7 flex-1 text-xs"
                disabled={dispatchBusy || !authenticated}
              />
              <Input
                value={row.value}
                onChange={(e) => onUpdateDispatchInputRow(i, { value: e.target.value })}
                placeholder="Value"
                className="h-7 flex-1 text-xs"
                disabled={dispatchBusy || !authenticated}
              />
              <Button
                size="icon"
                variant="ghost"
                className="size-6 shrink-0"
                title="Remove input"
                aria-label={`Remove input ${i + 1}`}
                disabled={dispatchBusy || !authenticated}
                onClick={() => onRemoveDispatchInputRow(i)}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            disabled={dispatchBusy || !authenticated}
            onClick={onAddDispatchInputRow}
          >
            <Plus className="mr-1 size-3" />
            Add input
          </Button>
        </div>
        {dispatchError && (
          <div className="mb-2 flex items-center gap-1 text-[11px] text-rose-400">
            <AlertCircle className="size-3.5" />
            {dispatchError}
          </div>
        )}
        {dispatchMessage && !dispatchError && (
          <div className="mb-2 flex items-center gap-1 text-[11px] text-emerald-400">
            <Check className="size-3.5" />
            {dispatchMessage}
          </div>
        )}
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={dispatchDisabled}
            title={authenticated ? undefined : PUSH_ONLY_TITLE}
            onClick={onDispatch}
          >
            {dispatchBusy ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Play className="mr-2 size-3.5" />}
            Run
          </Button>
        </div>
      </div>
    </div>
  );
}

function WorkflowRunRow({
  run,
  authenticated,
  busy,
  error,
  onRerun,
  onRerunFailed,
  onCancel,
}: {
  run: GitHubWorkflowRun;
  authenticated: boolean;
  busy: string | undefined;
  error: string | undefined;
  onRerun: () => void;
  onRerunFailed: () => void;
  onCancel: () => void;
}) {
  const isBusy = !!busy;
  // Anything not yet completed is cancellable — includes queued, in_progress,
  // and the approval-gate states (waiting, pending, requested).
  const cancellable = run.status !== "completed";
  return (
    <div className="rounded px-1 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span className={cn("shrink-0 text-[10px] font-medium uppercase tracking-wide", workflowRunClass(run))}>
          {workflowRunLabel(run)}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium" title={run.displayTitle || run.name}>
          {run.displayTitle || run.name}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">#{run.runNumber}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            title="Open run on GitHub"
            aria-label={`Open run #${run.runNumber} on GitHub`}
            onClick={() => { void api.openExternal(run.htmlUrl); }}
          >
            <ExternalLink className="size-3.5" />
          </Button>
          {cancellable && (
            <Button
              size="icon"
              variant="ghost"
              className="size-6 text-muted-foreground hover:text-rose-400"
              title={authenticated ? "Cancel run" : PUSH_ONLY_TITLE}
              aria-label={`Cancel run #${run.runNumber}`}
              disabled={isBusy || !authenticated}
              onClick={onCancel}
            >
              {busy === "cancel" ? <Loader2 className="size-3.5 animate-spin" /> : <Ban className="size-3.5" />}
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            title={authenticated ? "Re-run" : PUSH_ONLY_TITLE}
            aria-label={`Re-run #${run.runNumber}`}
            disabled={isBusy || !authenticated}
            onClick={onRerun}
          >
            {busy === "rerun" ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[11px]"
            title={authenticated ? "Re-run failed jobs only" : PUSH_ONLY_TITLE}
            disabled={isBusy || !authenticated}
            onClick={onRerunFailed}
          >
            {busy === "rerun-failed" ? <Loader2 className="size-3 animate-spin" /> : null}
            Failed only
          </Button>
        </div>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 pl-0.5 text-[11px] text-muted-foreground">
        <span className="truncate">{run.event}</span>
        <span>·</span>
        <span className="truncate">{run.headBranch}</span>
        {run.createdAt && (
          <>
            <span>·</span>
            <span>{fmtRelativeDate(run.createdAt)}</span>
          </>
        )}
      </div>
      {error && (
        <div className="mt-0.5 flex items-center gap-1 pl-0.5 text-[11px] text-rose-400">
          <AlertCircle className="size-3.5" />
          {error}
        </div>
      )}
    </div>
  );
}

function ProjectsPanel({
  projects,
  loading,
  error,
  authenticated,
  selectedProjectId,
  onSelectProject,
  items,
  statusField,
  itemsLoading,
  itemsError,
  itemBusy,
  itemErrors,
  onSetStatus,
  onRemoveItem,
  addNumber,
  onAddNumberChange,
  addKind,
  onAddKindChange,
  addBusy,
  addError,
  onAddItem,
  onRefresh,
  onRefreshItems,
  onClose,
}: {
  projects: GitHubProjectV2[];
  loading: boolean;
  error: string | null;
  authenticated: boolean;
  selectedProjectId: string;
  onSelectProject: (id: string) => void;
  items: GitHubProjectItem[];
  statusField: GitHubProjectField | null;
  itemsLoading: boolean;
  itemsError: string | null;
  itemBusy: Record<string, string | undefined>;
  itemErrors: Record<string, string | undefined>;
  onSetStatus: (itemId: string, optionId: string, optionName: string) => void;
  onRemoveItem: (itemId: string) => void;
  addNumber: string;
  onAddNumberChange: (v: string) => void;
  addKind: "issue" | "pr";
  onAddKindChange: (k: "issue" | "pr") => void;
  addBusy: boolean;
  addError: string | null;
  onAddItem: () => void;
  onRefresh: () => void;
  onRefreshItems: () => void;
  onClose: () => void;
}) {
  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;
  const addDisabled = addBusy || !authenticated || !selectedProjectId || !addNumber.trim();
  return (
    <div className="mb-3 rounded-md border border-border/60 bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Kanban className="size-3.5" />
          Projects{projects.length > 0 && ` (${projects.length})`}
        </div>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" className="size-6" title="Refresh projects" aria-label="Refresh projects" disabled={loading} onClick={onRefresh}>
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      {error && (
        <div className="mb-2 flex items-center gap-1 text-[11px] text-rose-400">
          <AlertCircle className="size-3.5" />
          {error}
        </div>
      )}
      <div className="mb-2">
        <Select
          value={selectedProjectId}
          onChange={(e) => onSelectProject(e.target.value)}
          title="Project"
          aria-label="Project"
          className="h-8 text-xs"
          disabled={loading || projects.length === 0}
        >
          <option value="">
            {loading ? "Loading projects…" : projects.length === 0 ? "No projects linked to this repository" : "Select a project…"}
          </option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>#{p.number} {p.title}</option>
          ))}
        </Select>
      </div>

      {selectedProjectId && (
        <>
          <div className="mb-2 flex items-center justify-between gap-2 border-t border-border/60 pt-2">
            <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <span>Items{!itemsLoading && ` (${items.length})`}</span>
              {selectedProject && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  title="Open project on GitHub"
                  aria-label="Open project on GitHub"
                  onClick={() => { void api.openExternal(selectedProject.url); }}
                >
                  <ExternalLink className="size-3.5" />
                </Button>
              )}
            </div>
            <Button size="icon" variant="ghost" className="size-6" title="Refresh items" aria-label="Refresh items" disabled={itemsLoading} onClick={onRefreshItems}>
              {itemsLoading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            </Button>
          </div>
          {itemsError && (
            <div className="mb-2 flex items-center gap-1 text-[11px] text-rose-400">
              <AlertCircle className="size-3.5" />
              {itemsError}
            </div>
          )}
          <div className="mb-3 max-h-56 space-y-1 overflow-y-auto">
            {!itemsError && items.length === 0 ? (
              <div className="px-1 py-2 text-[11px] text-muted-foreground">
                {itemsLoading ? "Loading…" : "No items on this project board."}
              </div>
            ) : (
              items.map((it) => (
                <ProjectItemRow
                  key={it.itemId}
                  item={it}
                  statusField={statusField}
                  authenticated={authenticated}
                  busy={itemBusy[it.itemId]}
                  error={itemErrors[it.itemId]}
                  onSetStatus={(optionId, optionName) => onSetStatus(it.itemId, optionId, optionName)}
                  onRemove={() => onRemoveItem(it.itemId)}
                />
              ))
            )}
          </div>

          <div className="border-t border-border/60 pt-2">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Plus className="size-3.5" />
              Add issue/PR by number
            </div>
            <div className="mb-1 flex items-center gap-1.5">
              <Select
                value={addKind}
                onChange={(e) => onAddKindChange(e.target.value === "pr" ? "pr" : "issue")}
                title="Content kind"
                aria-label="Content kind"
                className="h-8 w-20 shrink-0 text-xs"
                disabled={addBusy || !authenticated}
              >
                <option value="issue">Issue</option>
                <option value="pr">PR</option>
              </Select>
              <Input
                value={addNumber}
                onChange={(e) => onAddNumberChange(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="#number"
                className="h-8 flex-1 text-xs"
                disabled={addBusy || !authenticated}
                onKeyDown={(e) => { if (e.key === "Enter" && !addDisabled) onAddItem(); }}
              />
              <Button
                size="sm"
                disabled={addDisabled}
                title={authenticated ? undefined : PUSH_ONLY_TITLE}
                onClick={onAddItem}
              >
                {addBusy ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Plus className="mr-2 size-3.5" />}
                Add
              </Button>
            </div>
            {addError && (
              <div className="flex items-center gap-1 text-[11px] text-rose-400">
                <AlertCircle className="size-3.5" />
                {addError}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ProjectItemRow({
  item,
  statusField,
  authenticated,
  busy,
  error,
  onSetStatus,
  onRemove,
}: {
  item: GitHubProjectItem;
  statusField: GitHubProjectField | null;
  authenticated: boolean;
  busy: string | undefined;
  error: string | undefined;
  onSetStatus: (optionId: string, optionName: string) => void;
  onRemove: () => void;
}) {
  const isBusy = !!busy;
  const Icon = item.contentType === "PullRequest" ? GitPullRequest : item.contentType === "DraftIssue" ? FileText : CircleDot;
  const iconClass = item.contentType === "PullRequest"
    ? "text-emerald-400"
    : item.contentType === "DraftIssue"
      ? "text-muted-foreground"
      : "text-sky-400";
  const label = item.contentType === "DraftIssue"
    ? item.title || "(untitled draft)"
    : item.number != null
      ? `#${item.number} ${item.title || "(untitled)"}`
      : item.title || "(untitled)";
  return (
    <div className="rounded px-1 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <Icon className={cn("size-3.5 shrink-0", iconClass)} />
        <span className="min-w-0 flex-1 truncate font-medium" title={label}>{label}</span>
        {statusField && (
          <Select
            value={item.statusOptionId ?? ""}
            onChange={(e) => {
              const optionId = e.target.value;
              // "— no status —" (empty value) is display-only — there's no
              // clear-field mutation wired up (scope decision A1), so picking
              // it is a no-op; the controlled value snaps back to the item's
              // actual current status.
              if (!optionId) return;
              const option = statusField.options.find((o) => o.id === optionId);
              if (option) onSetStatus(option.id, option.name);
            }}
            title="Status"
            aria-label={`Status for ${label}`}
            className="h-6 w-28 shrink-0 text-[11px]"
            disabled={isBusy || !authenticated}
          >
            <option value="">— no status —</option>
            {statusField.options.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </Select>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="size-6 shrink-0 text-muted-foreground hover:text-rose-400"
          title={authenticated ? "Remove from project" : PUSH_ONLY_TITLE}
          aria-label={`Remove ${label} from project`}
          disabled={isBusy || !authenticated}
          onClick={onRemove}
        >
          {busy === "remove" ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
        </Button>
      </div>
      {error && (
        <div className="mt-0.5 flex items-center gap-1 pl-0.5 text-[11px] text-rose-400">
          <AlertCircle className="size-3.5" />
          {error}
        </div>
      )}
    </div>
  );
}

/** Discussions (GraphQL-only — F22/G12) — toolbar-toggled manager panel,
 *  mirroring `ProjectsPanel`'s structure (list + lazy detail-on-select).
 *  Gating differs from every other manager panel here: create/comment/answer
 *  need only a token (`auth !== "none"`), NOT `canPush` — see the G12 gating
 *  note. Delete (discussion or comment) allows own content OR `canPush`. */
function DiscussionsPanel({
  discussions,
  categories,
  auth,
  canPush,
  viewerLogin,
  loading,
  error,
  rowBusy,
  rowErrors,
  onSelect,
  onDelete,
  selected,
  detail,
  detailLoading,
  detailError,
  commentDraft,
  onCommentDraftChange,
  commentBusy,
  commentError,
  onSubmitComment,
  commentBusyMap,
  commentErrors,
  onSetAnswer,
  onDeleteComment,
  createOpen,
  onCreateOpenChange,
  newCategoryId,
  onNewCategoryIdChange,
  newTitle,
  onNewTitleChange,
  newBody,
  onNewBodyChange,
  createBusy,
  createError,
  onCreate,
  onRefresh,
  onClose,
}: {
  discussions: GitHubDiscussion[];
  categories: GitHubDiscussionCategory[];
  auth: "token" | "none";
  canPush: boolean;
  viewerLogin: string;
  loading: boolean;
  error: string | null;
  rowBusy: Record<string, boolean>;
  rowErrors: Record<string, string | undefined>;
  onSelect: (discussion: GitHubDiscussion) => void;
  onDelete: (discussion: GitHubDiscussion) => void;
  selected: GitHubDiscussion | null;
  detail: GitHubDiscussionDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  commentDraft: string;
  onCommentDraftChange: (v: string) => void;
  commentBusy: boolean;
  commentError: string | null;
  onSubmitComment: () => void;
  commentBusyMap: Record<string, string | undefined>;
  commentErrors: Record<string, string | undefined>;
  onSetAnswer: (comment: GitHubDiscussionComment, answer: boolean) => void;
  onDeleteComment: (comment: GitHubDiscussionComment) => void;
  createOpen: boolean;
  onCreateOpenChange: (v: boolean) => void;
  newCategoryId: string;
  onNewCategoryIdChange: (v: string) => void;
  newTitle: string;
  onNewTitleChange: (v: string) => void;
  newBody: string;
  onNewBodyChange: (v: string) => void;
  createBusy: boolean;
  createError: string | null;
  onCreate: () => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const authenticated = auth !== "none";
  const createDisabled = createBusy || !authenticated || !newCategoryId || !newTitle.trim() || !newBody.trim();
  return (
    <div className="mb-3 rounded-md border border-border/60 bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <MessagesSquare className="size-3.5" />
          <span>Discussions{discussions.length > 0 && ` (${discussions.length})`}</span>
          {!authenticated && <span className="text-[10px]">· unauthenticated</span>}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant={createOpen ? "secondary" : "ghost"}
            className="h-6 px-2 text-[11px]"
            disabled={!authenticated}
            title={authenticated ? undefined : "Sign in to GitHub to start a discussion"}
            onClick={() => onCreateOpenChange(!createOpen)}
          >
            <Plus className="mr-1 size-3.5" />
            New
          </Button>
          <Button size="icon" variant="ghost" className="size-6" title="Refresh discussions" aria-label="Refresh discussions" disabled={loading} onClick={onRefresh}>
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      {error && (
        <div className="mb-2 flex items-center gap-1 text-[11px] text-rose-400">
          <AlertCircle className="size-3.5" />
          {error}
        </div>
      )}

      {createOpen && (
        <div className="mb-3 rounded-md border border-border/60 bg-background/40 p-2">
          <div className="mb-1.5 flex items-center gap-1.5">
            <Select
              value={newCategoryId}
              onChange={(e) => onNewCategoryIdChange(e.target.value)}
              title="Category"
              aria-label="Category"
              className="h-8 w-36 shrink-0 text-xs"
              disabled={createBusy || categories.length === 0}
            >
              {categories.length === 0 && <option value="">No categories</option>}
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
            <Input
              value={newTitle}
              onChange={(e) => onNewTitleChange(e.target.value)}
              placeholder="Title"
              className="h-8 flex-1 text-xs"
              disabled={createBusy}
            />
          </div>
          <Textarea
            value={newBody}
            onChange={(e) => onNewBodyChange(e.target.value)}
            placeholder="Write your discussion…"
            className="min-h-20 resize-y text-xs"
            disabled={createBusy}
          />
          <div className="mt-1.5 flex justify-end">
            <Button size="sm" disabled={createDisabled} onClick={onCreate}>
              {createBusy ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Plus className="mr-2 size-3.5" />}
              Create
            </Button>
          </div>
          {createError && (
            <div className="mt-1 flex items-center gap-1 text-[11px] text-rose-400">
              <AlertCircle className="size-3.5" />
              {createError}
            </div>
          )}
        </div>
      )}

      <div className="max-h-96 space-y-1 overflow-y-auto">
        {!error && discussions.length === 0 ? (
          <div className="px-1 py-2 text-[11px] text-muted-foreground">
            {loading ? "Loading…" : "No discussions yet."}
          </div>
        ) : (
          discussions.map((d) => (
            <DiscussionRow
              key={d.id}
              discussion={d}
              expanded={selected?.id === d.id}
              canDelete={canPush || (!!viewerLogin && d.author === viewerLogin)}
              busy={!!rowBusy[d.id]}
              error={rowErrors[d.id]}
              onToggle={() => onSelect(d)}
              onDelete={() => onDelete(d)}
            >
              {selected?.id === d.id && (
                <DiscussionDetailView
                  detail={detail}
                  loading={detailLoading}
                  error={detailError}
                  authenticated={authenticated}
                  canPush={canPush}
                  viewerLogin={viewerLogin}
                  commentDraft={commentDraft}
                  onCommentDraftChange={onCommentDraftChange}
                  commentBusy={commentBusy}
                  commentError={commentError}
                  onSubmitComment={onSubmitComment}
                  commentBusyMap={commentBusyMap}
                  commentErrors={commentErrors}
                  onSetAnswer={onSetAnswer}
                  onDeleteComment={onDeleteComment}
                />
              )}
            </DiscussionRow>
          ))
        )}
      </div>
    </div>
  );
}

function DiscussionRow({
  discussion,
  expanded,
  canDelete,
  busy,
  error,
  onToggle,
  onDelete,
  children,
}: {
  discussion: GitHubDiscussion;
  expanded: boolean;
  canDelete: boolean;
  busy: boolean;
  error: string | undefined;
  onToggle: () => void;
  onDelete: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border/50 bg-background/30">
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
        <MessagesSquare className="size-3.5 shrink-0 text-sky-400" />
        <span className="min-w-0 flex-1 truncate font-medium" title={discussion.title}>
          #{discussion.number} {discussion.title}
        </span>
        {discussion.category && (
          <span className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {discussion.category}
          </span>
        )}
        {discussion.answered && (
          <span title="Answered">
            <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400" />
          </span>
        )}
        <span className="shrink-0 text-[10px] text-muted-foreground">{discussion.author ?? "unknown"}</span>
        <Button
          size="icon"
          variant="ghost"
          className="size-6 shrink-0"
          title="Open on GitHub"
          aria-label={`Open discussion #${discussion.number} on GitHub`}
          onClick={() => { void api.openExternal(discussion.url); }}
        >
          <ExternalLink className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-6 shrink-0 text-muted-foreground hover:text-rose-400"
          title={canDelete ? "Delete discussion" : PUSH_ONLY_TITLE}
          aria-label={`Delete discussion #${discussion.number}`}
          disabled={busy || !canDelete}
          onClick={onDelete}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-6 shrink-0"
          title={expanded ? "Collapse" : "Expand"}
          aria-label={`${expanded ? "Collapse" : "Expand"} discussion #${discussion.number}`}
          onClick={onToggle}
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </Button>
      </div>
      {error && (
        <div className="flex items-center gap-1 px-2 pb-1.5 text-[11px] text-rose-400">
          <AlertCircle className="size-3.5" />
          {error}
        </div>
      )}
      {children}
    </div>
  );
}

function DiscussionDetailView({
  detail,
  loading,
  error,
  authenticated,
  canPush,
  viewerLogin,
  commentDraft,
  onCommentDraftChange,
  commentBusy,
  commentError,
  onSubmitComment,
  commentBusyMap,
  commentErrors,
  onSetAnswer,
  onDeleteComment,
}: {
  detail: GitHubDiscussionDetail | null;
  loading: boolean;
  error: string | null;
  authenticated: boolean;
  canPush: boolean;
  viewerLogin: string;
  commentDraft: string;
  onCommentDraftChange: (v: string) => void;
  commentBusy: boolean;
  commentError: string | null;
  onSubmitComment: () => void;
  commentBusyMap: Record<string, string | undefined>;
  commentErrors: Record<string, string | undefined>;
  onSetAnswer: (comment: GitHubDiscussionComment, answer: boolean) => void;
  onDeleteComment: (comment: GitHubDiscussionComment) => void;
}) {
  return (
    <div className="border-t border-border/50 bg-card p-2">
      {loading && !detail && (
        <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading discussion…
        </div>
      )}
      {!loading && error && (
        <div className="flex items-center gap-1 py-2 text-[11px] text-rose-400">
          <AlertCircle className="size-3.5" />
          {error}
        </div>
      )}
      {detail && (
        <>
          {detail.body && (
            <div className="markdown-body mb-2 max-h-40 overflow-y-auto rounded border border-border/50 bg-background/40 px-2 py-1.5 text-xs">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.body}</ReactMarkdown>
            </div>
          )}
          <div className="space-y-1.5">
            {detail.comments.length === 0 ? (
              <div className="px-1 py-1.5 text-[11px] text-muted-foreground">No comments yet.</div>
            ) : (
              detail.comments.map((c) => (
                <DiscussionCommentRow
                  key={c.id}
                  comment={c}
                  answerable={detail.answerable}
                  canDelete={canPush || (!!viewerLogin && c.author === viewerLogin)}
                  canAnswer={authenticated}
                  busy={commentBusyMap[c.id]}
                  error={commentErrors[c.id]}
                  onSetAnswer={(answer) => onSetAnswer(c, answer)}
                  onDelete={() => onDeleteComment(c)}
                />
              ))
            )}
          </div>
          <div className="mt-2 rounded border border-border/50 bg-background/40 p-1.5">
            <Textarea
              value={commentDraft}
              onChange={(e) => onCommentDraftChange(e.target.value)}
              placeholder={authenticated ? "Add a comment…" : "Sign in to GitHub to comment"}
              className="min-h-16 resize-y border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
              disabled={commentBusy || !authenticated}
            />
            <div className="mt-1 flex items-center justify-between gap-2">
              {commentError && (
                <div className="flex items-center gap-1 text-[11px] text-rose-400">
                  <AlertCircle className="size-3.5" />
                  {commentError}
                </div>
              )}
              <div className="ml-auto">
                <Button
                  size="sm"
                  className="h-7"
                  disabled={commentBusy || !authenticated || !commentDraft.trim()}
                  title={authenticated ? undefined : "Sign in to GitHub to comment"}
                  onClick={onSubmitComment}
                >
                  {commentBusy ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <MessageSquare className="mr-2 size-3.5" />}
                  Comment
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function DiscussionCommentRow({
  comment,
  answerable,
  canDelete,
  canAnswer,
  busy,
  error,
  onSetAnswer,
  onDelete,
}: {
  comment: GitHubDiscussionComment;
  answerable: boolean;
  canDelete: boolean;
  canAnswer: boolean;
  busy: string | undefined;
  error: string | undefined;
  onSetAnswer: (answer: boolean) => void;
  onDelete: () => void;
}) {
  const isBusy = !!busy;
  return (
    <div className="rounded border border-border/50 bg-background/40 px-2 py-1.5 text-xs">
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">{comment.author ?? "unknown"}</span>
        <span>{fmtDate(comment.createdAt)}</span>
        {comment.isAnswer && (
          <span className="flex items-center gap-0.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
            <Check className="size-3" /> Answer
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {answerable && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 text-[10px]"
              disabled={isBusy || !canAnswer}
              title={canAnswer ? undefined : "Sign in to GitHub to mark an answer"}
              onClick={() => onSetAnswer(!comment.isAnswer)}
            >
              {busy === "answer" ? <Loader2 className="size-3 animate-spin" /> : comment.isAnswer ? "Unmark answer" : "Mark answer"}
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-5 text-muted-foreground hover:text-rose-400"
            title={canDelete ? "Delete comment" : PUSH_ONLY_TITLE}
            aria-label="Delete comment"
            disabled={isBusy || !canDelete}
            onClick={onDelete}
          >
            {busy === "delete" ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
          </Button>
        </div>
      </div>
      <div className="markdown-body text-xs">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{comment.body}</ReactMarkdown>
      </div>
      {error && (
        <div className="mt-1 flex items-center gap-1 text-[11px] text-rose-400">
          <AlertCircle className="size-3.5" />
          {error}
        </div>
      )}
    </div>
  );
}

function GitHubItemRow({
  item,
  caps,
  repoBadge,
  onToggle,
}: {
  item: GitHubListItem;
  // Terminology/link labels follow the project's provider (multi-provider
  // support, docs/plans/multi-provider-git-modal.md).
  caps: ProviderCaps;
  // Aggregate mode (G8/F15): shows a small repo badge next to the title
  // (redundant, and hidden, in single-repo mode) so items from different
  // repos are distinguishable in the merged list.
  repoBadge?: string;
  // Navigates to the detail subpage for this item (GitHubDialogView).
  onToggle: () => void;
}) {
  const merged = item.kind === "pulls" && !!item.mergedAt;
  const stateClass = item.state === "open"
    ? "text-emerald-400"
    : merged
      ? "text-violet-400"
      : "text-rose-400";
  return (
    <div className="rounded-md border border-border/60 bg-card">
      <div className="flex items-start gap-3 p-3">
        <GitPullRequest className={cn("mt-0.5 size-4 shrink-0", stateClass)} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <button
              type="button"
              className="min-w-0 truncate text-left text-sm font-medium hover:underline"
              onClick={onToggle}
              title="Open details"
            >
              #{item.number} {item.title}
            </button>
            {item.draft && (
              <span className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                Draft
              </span>
            )}
            {repoBadge && (
              <span
                className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                title="Repository this item belongs to"
              >
                {repoBadge}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{merged ? "merged" : item.state}</span>
            {item.author && <span>by {item.author.login}</span>}
            {item.assignees.length > 0 && <span>assigned {item.assignees.map((a) => a.login).join(", ")}</span>}
            {item.milestone && <span>milestone {item.milestone.title}</span>}
            <span>updated {fmtDate(item.updatedAt)}</span>
            {item.comments > 0 && (
              <span className="inline-flex items-center gap-1">
                <MessageSquare className="size-3" />
                {item.comments}
              </span>
            )}
          </div>
          {item.labels.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {item.labels.map((label) => (
                <span
                  key={label.name}
                  className="rounded border px-1.5 py-0.5 text-[11px]"
                  style={{
                    borderColor: label.color ? `#${label.color}` : undefined,
                    backgroundColor: label.color ? `#${label.color}22` : undefined,
                  }}
                >
                  {label.name}
                </span>
              ))}
            </div>
          )}
          {item.body && (
            <div className="markdown-body mt-2 max-h-28 overflow-hidden text-xs text-muted-foreground">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {item.body}
              </ReactMarkdown>
            </div>
          )}
        </div>
        <Button
          size="icon"
          variant="ghost"
          title="Open details"
          aria-label={`Open details for #${item.number}`}
          onClick={onToggle}
        >
          <ChevronRight className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          title={`Open on ${caps.providerName}`}
          aria-label={`Open #${item.number} on ${caps.providerName}`}
          onClick={() => { void api.openExternal(item.htmlUrl); }}
        >
          <ExternalLink className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Full-panel detail subpage for a single PR/issue (T1, replaces the old
 * inline accordion expansion of `GitHubItemRow`). Renders the exact same
 * content the accordion used to show — item header + Edit, linked issues,
 * body/editor, reactions, and (kind-specific) merge/triage/checks/commits/
 * diff/reviews or issue actions, then the conversation thread — just
 * full-width instead of nested under a row. All data/props are threaded from
 * `GitHubDialog`'s own per-item state maps, keyed by `itemKey(item)`, exactly
 * as they were when passed into `GitHubItemRow`'s expanded block.
 */
function GitHubItemDetail({
  item,
  caps,
  provider,
  itemPath,
  canPush,
  viewerLogin,
  diff,
  diffLoading,
  diffError,
  checks,
  checksLoading,
  checksError,
  commitStatus,
  commitStatusLoading,
  commitStatusError,
  mergeability,
  mergeabilityLoading,
  mergeabilityError,
  commits,
  commitsLoading,
  commitsError,
  linkedIssues,
  reviewComments,
  reviewCommentsLoading,
  reviewCommentError,
  reviewReplyDrafts,
  reviewReplySubmitting,
  applySuggestionBusy,
  comments,
  commentsLoading,
  commentError,
  commentDraft,
  commentSubmitting,
  reviewDraft,
  closeDraft,
  mergeMethod,
  actionBusy,
  actionError,
  actionMessage,
  actionSource,
  repoLabels,
  repoAssignees,
  repoMilestones,
  labelDraft,
  assigneeDraft,
  milestoneDraft,
  reviewerDraft,
  teamReviewerDraft,
  editorOpen,
  titleDraft,
  bodyDraft,
  onEditToggle,
  onTitleDraftChange,
  onBodyDraftChange,
  onSaveEdit,
  onReviewerDraftChange,
  onTeamReviewerDraftChange,
  onRequestReviewers,
  onReviewDraftChange,
  onCloseDraftChange,
  onMergeMethodChange,
  onReview,
  onMerge,
  onUpdateBranch,
  onReopenPull,
  onToggleDraft,
  onToggleAutoMerge,
  onClosePull,
  pendingReview,
  pendingStale,
  onAddToReview,
  onRemovePendingReview,
  onLineComment,
  onReviewReplyDraftChange,
  onSubmitReviewReply,
  reviewThreads,
  reviewThreadsTruncated,
  onToggleThreadResolved,
  onEditReviewComment,
  onDeleteReviewComment,
  onApplySuggestion,
  onEditComment,
  onDeleteComment,
  onRetryReviewComments,
  onLabelDraftChange,
  onAssigneeDraftChange,
  onMilestoneDraftChange,
  onIssueState,
  onIssueLabels,
  lockReasonDraft,
  onLockReasonDraftChange,
  onToggleLock,
  transferDraft,
  onTransferDraftChange,
  transferConfirming,
  onTransferIssue,
  onCancelTransfer,
  onCommentDraftChange,
  onSubmitComment,
  onRetryComments,
  onRetryDiff,
  onRetryChecks,
  onRetryCommitStatus,
  onRefreshDiff,
  onRefreshChecks,
  onRefreshCommitStatus,
  onRefreshMergeability,
  onRetryCommits,
}: {
  item: GitHubListItem;
  caps: ProviderCaps;
  // "github" gates the GitHub-exclusive per-item affordances (reactions,
  // sub-issues, pin, lock, transfer, suggestion-apply, pending-review batch,
  // thread-resolve, reviewer-request UI) that even `caps` can't express
  // because their write path is GitHub GraphQL/REST-specific, not merely
  // "unsupported on this provider's core API".
  provider: GitProvider | "mixed" | null;
  itemPath: string;
  canPush: boolean;
  viewerLogin: string;
  diff?: TaskDiff;
  diffLoading: boolean;
  diffError?: string;
  checks?: GitHubChecksResult;
  checksLoading: boolean;
  checksError?: string;
  commitStatus?: GitHubCommitStatusResult;
  commitStatusLoading: boolean;
  commitStatusError?: string;
  mergeability?: GitHubPullMergeability;
  mergeabilityLoading: boolean;
  mergeabilityError?: string;
  commits?: GitHubPullCommit[];
  commitsLoading: boolean;
  commitsError?: string;
  linkedIssues?: GitHubLinkedIssue[];
  reviewComments?: GitHubPullLineComment[];
  reviewCommentsLoading: boolean;
  reviewCommentError?: string;
  reviewReplyDrafts: Record<number, string | undefined>;
  reviewReplySubmitting: Record<number, boolean | undefined>;
  applySuggestionBusy: Record<number, boolean | undefined>;
  comments?: GitHubComment[];
  commentsLoading: boolean;
  commentError?: string;
  commentDraft: string;
  commentSubmitting: boolean;
  reviewDraft: string;
  closeDraft: string;
  mergeMethod: GitHubPullMergeMethod;
  actionBusy?: string;
  actionError?: string;
  actionMessage?: string;
  actionSource?: string;
  repoLabels: GitHubRepoLabel[];
  repoAssignees: GitHubUser[];
  repoMilestones: GitHubRepoMilestone[];
  labelDraft: string;
  assigneeDraft: string;
  milestoneDraft: string;
  reviewerDraft: string;
  teamReviewerDraft: string;
  editorOpen: boolean;
  titleDraft: string;
  bodyDraft: string;
  onEditToggle: (next: boolean) => void;
  onTitleDraftChange: (body: string) => void;
  onBodyDraftChange: (body: string) => void;
  onSaveEdit: () => void;
  onReviewerDraftChange: (body: string) => void;
  onTeamReviewerDraftChange: (body: string) => void;
  onRequestReviewers: () => void;
  onReviewDraftChange: (body: string) => void;
  onCloseDraftChange: (body: string) => void;
  onMergeMethodChange: (method: GitHubPullMergeMethod) => void;
  onReview: (event: GitHubPullReviewEvent) => void;
  onMerge: () => void;
  onUpdateBranch: () => void;
  onReopenPull: () => void;
  onToggleDraft: () => void;
  onToggleAutoMerge: () => void;
  onClosePull: () => void;
  pendingReview: LineCommentTarget[];
  pendingStale: boolean;
  onAddToReview: (target: LineCommentTarget) => void;
  onRemovePendingReview: (index: number) => void;
  onLineComment: (target: LineCommentTarget) => Promise<void>;
  onReviewReplyDraftChange: (commentId: number, body: string) => void;
  onSubmitReviewReply: (commentId: number) => void;
  reviewThreads: GitHubReviewThread[];
  reviewThreadsTruncated: boolean;
  onToggleThreadResolved: (thread: GitHubReviewThread) => Promise<void>;
  onEditReviewComment: (commentId: number, body: string) => Promise<void>;
  onDeleteReviewComment: (commentId: number) => Promise<void>;
  onApplySuggestion: (commentId: number) => void;
  onEditComment: (commentId: number, body: string) => Promise<void>;
  onDeleteComment: (commentId: number) => Promise<void>;
  onRetryReviewComments: () => void;
  onLabelDraftChange: (body: string) => void;
  onAssigneeDraftChange: (body: string) => void;
  onMilestoneDraftChange: (body: string) => void;
  onIssueState: (state: "open" | "closed") => void;
  onIssueLabels: () => void;
  lockReasonDraft: string;
  onLockReasonDraftChange: (body: string) => void;
  onToggleLock: () => void;
  transferDraft: string;
  onTransferDraftChange: (body: string) => void;
  transferConfirming: boolean;
  onTransferIssue: () => void;
  onCancelTransfer: () => void;
  onCommentDraftChange: (body: string) => void;
  onSubmitComment: () => void;
  onRetryComments: () => void;
  onRetryDiff: () => void;
  onRetryChecks: () => void;
  onRetryCommitStatus: () => void;
  onRefreshDiff: () => void;
  onRefreshChecks: () => void;
  onRefreshCommitStatus: () => void;
  onRefreshMergeability: () => void;
  onRetryCommits: () => void;
}) {
  // The item's own author may close/reopen and edit the title/body of their own
  // issue/PR without repo push access — so those specific controls gate on this
  // wider flag, while genuinely push-only actions (merge, lock, pin, transfer,
  // labels/milestones, reviewers, auto-merge) stay on `canPush` alone.
  const canModifyOwn = canPush || (!!viewerLogin && item.author?.login === viewerLogin);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[11px] font-medium uppercase text-muted-foreground">
          {item.kind === "pulls" ? caps.pullNoun : "Issue"} #{item.number}
        </div>
        {!editorOpen && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            disabled={!canModifyOwn}
            title={canModifyOwn ? undefined : PUSH_ONLY_TITLE}
            onClick={() => onEditToggle(true)}
          >
            <FilePen className="mr-2 size-3.5" />
            Edit
          </Button>
        )}
      </div>
      {item.kind === "pulls" && caps.linkedIssues && linkedIssues && linkedIssues.length > 0 && (
        <LinkedIssuesLine issues={linkedIssues} />
      )}
      {editorOpen ? (
        <ItemEditor
          title={titleDraft}
          body={bodyDraft}
          busy={actionBusy === "edit"}
          error={actionSource === "edit" ? actionError : undefined}
          canSave={canModifyOwn}
          onTitleChange={onTitleDraftChange}
          onBodyChange={onBodyDraftChange}
          onCancel={() => onEditToggle(false)}
          onSave={onSaveEdit}
        />
      ) : (
        <div className="max-h-64 overflow-y-auto rounded-md border border-border/50 bg-card px-3 py-2 text-sm">
          {item.body ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {item.body}
            </ReactMarkdown>
          ) : (
            <div className="text-sm italic text-muted-foreground">No description.</div>
          )}
        </div>
      )}
      {caps.reactions && (
        <Reactions path={itemPath} subject={{ type: "issue", id: item.number }} viewer={viewerLogin} />
      )}
      {item.kind === "pulls" && (
        <>
          <PullActions
            item={item}
            caps={caps}
            provider={provider}
            itemPath={itemPath}
            reviewDraft={reviewDraft}
            closeDraft={closeDraft}
            mergeMethod={mergeMethod}
            busy={actionBusy}
            error={actionSource === "actions" ? actionError : undefined}
            message={actionSource === "actions" ? actionMessage : undefined}
            mergeability={mergeability}
            mergeabilityLoading={mergeabilityLoading}
            mergeabilityError={mergeabilityError}
            onReviewDraftChange={onReviewDraftChange}
            onCloseDraftChange={onCloseDraftChange}
            onMergeMethodChange={onMergeMethodChange}
            pendingCount={pendingReview.length}
            onReview={onReview}
            onMerge={onMerge}
            onUpdateBranch={onUpdateBranch}
            onReopenPull={onReopenPull}
            onToggleDraft={onToggleDraft}
            onToggleAutoMerge={onToggleAutoMerge}
            onClosePull={onClosePull}
            onRefreshMergeability={onRefreshMergeability}
            canPush={canPush}
            canModifyOwn={canModifyOwn}
          />
          <PullTriage
            caps={caps}
            provider={provider}
            repoLabels={repoLabels}
            repoAssignees={repoAssignees}
            repoMilestones={repoMilestones}
            labelDraft={labelDraft}
            assigneeDraft={assigneeDraft}
            milestoneDraft={milestoneDraft}
            reviewerDraft={reviewerDraft}
            teamReviewerDraft={teamReviewerDraft}
            busy={actionBusy}
            prOpen={item.state === "open"}
            error={actionSource === "triage" ? actionError : undefined}
            message={actionSource === "triage" ? actionMessage : undefined}
            onLabelDraftChange={onLabelDraftChange}
            onAssigneeDraftChange={onAssigneeDraftChange}
            onMilestoneDraftChange={onMilestoneDraftChange}
            onReviewerDraftChange={onReviewerDraftChange}
            onTeamReviewerDraftChange={onTeamReviewerDraftChange}
            onSaveTriage={onIssueLabels}
            onRequestReviewers={onRequestReviewers}
            canPush={canPush}
          />
          <CheckRuns checks={checks} loading={checksLoading} error={checksError} onRetry={onRetryChecks} onRefresh={onRefreshChecks} />
          {caps.commitStatusPanel && (
            <CommitStatus status={commitStatus} loading={commitStatusLoading} error={commitStatusError} onRetry={onRetryCommitStatus} onRefresh={onRefreshCommitStatus} />
          )}
          <PullCommits commits={commits} loading={commitsLoading} error={commitsError} onRetry={onRetryCommits} />
          <PullDiff diff={diff} loading={diffLoading} error={diffError} onRetry={onRetryDiff} onRefresh={onRefreshDiff} onLineComment={onLineComment} onAddToReview={onAddToReview} pending={pendingReview} allowBatchReview={provider === "github"} />
          {provider === "github" && (
            <PendingReview comments={pendingReview} stale={pendingStale} onRemove={onRemovePendingReview} />
          )}
          <ReviewComments
            path={itemPath}
            caps={caps}
            resolveSupported={provider === "github"}
            comments={reviewComments}
            loading={reviewCommentsLoading}
            error={reviewCommentError}
            replyDrafts={reviewReplyDrafts}
            replySubmitting={reviewReplySubmitting}
            viewerLogin={viewerLogin}
            threads={reviewThreads}
            threadsTruncated={reviewThreadsTruncated}
            prOpen={item.state === "open"}
            applyBusy={applySuggestionBusy}
            onToggleResolved={onToggleThreadResolved}
            onEdit={onEditReviewComment}
            onDelete={onDeleteReviewComment}
            onApply={onApplySuggestion}
            onDraftChange={onReviewReplyDraftChange}
            onSubmitReply={onSubmitReviewReply}
            onRetry={onRetryReviewComments}
            canPush={canPush}
            canResolveThreads={canModifyOwn}
          />
        </>
      )}
      {item.kind === "issues" && (
        <IssueActions
          item={item}
          caps={caps}
          path={itemPath}
          repoLabels={repoLabels}
          repoAssignees={repoAssignees}
          repoMilestones={repoMilestones}
          labelDraft={labelDraft}
          assigneeDraft={assigneeDraft}
          milestoneDraft={milestoneDraft}
          busy={actionBusy}
          canPush={canPush}
          canModifyOwn={canModifyOwn}
          error={actionSource === "actions" || actionSource === "triage" ? actionError : undefined}
          message={actionSource === "actions" || actionSource === "triage" ? actionMessage : undefined}
          onLabelDraftChange={onLabelDraftChange}
          onAssigneeDraftChange={onAssigneeDraftChange}
          onMilestoneDraftChange={onMilestoneDraftChange}
          onIssueState={onIssueState}
          onIssueLabels={onIssueLabels}
          lockReasonDraft={lockReasonDraft}
          onLockReasonDraftChange={onLockReasonDraftChange}
          onToggleLock={onToggleLock}
          transferDraft={transferDraft}
          onTransferDraftChange={onTransferDraftChange}
          transferConfirming={transferConfirming}
          onTransferIssue={onTransferIssue}
          onCancelTransfer={onCancelTransfer}
        />
      )}
      <Conversation
        path={itemPath}
        caps={caps}
        comments={comments}
        loading={commentsLoading}
        error={commentError}
        draft={commentDraft}
        submitting={commentSubmitting}
        viewerLogin={viewerLogin}
        onEdit={onEditComment}
        onDelete={onDeleteComment}
        onDraftChange={onCommentDraftChange}
        onSubmit={onSubmitComment}
        onRetry={onRetryComments}
      />
    </div>
  );
}

function checkClass(run: GitHubCheckRun): string {
  if (run.status !== "completed") return "text-sky-400";
  if (run.conclusion === "success" || run.conclusion === "neutral" || run.conclusion === "skipped") {
    return "text-emerald-400";
  }
  return "text-rose-400";
}

/** Combined-status (F19) state → color, shared by the summary line and each
 *  per-context row. GitHub's states: success/pending/failure/error, plus the
 *  empty string when a ref has no statuses at all. */
function commitStatusClass(state: string): string {
  if (state === "success") return "text-emerald-400";
  if (state === "pending") return "text-sky-400";
  if (state === "failure" || state === "error") return "text-rose-400";
  return "text-muted-foreground";
}

const MERGE_TONE_CLASS: Record<MergeTone, string> = {
  ok: "text-emerald-400",
  warn: "text-amber-400",
  bad: "text-rose-400",
  muted: "text-muted-foreground",
};

/** Merge-method dropdown label for the neutral `GitHubPullMergeMethod`
 *  vocabulary (see the `PROVIDER_CAPS.mergeMethods` doc comment in
 *  shared/types.ts): Bitbucket has no "rebase and merge" strategy — its
 *  linear-history option is `fast_forward`, mapped onto the shared "rebase"
 *  value, so it reads as "Fast-forward" rather than GitHub/GitLab's "Rebase
 *  and merge" wording. */
function mergeMethodLabel(method: GitHubPullMergeMethod, provider: GitProvider | "mixed" | null): string {
  if (method === "rebase" && provider === "bitbucket") return "Fast-forward";
  if (method === "merge") return "Create merge commit";
  if (method === "squash") return "Squash and merge";
  return "Rebase and merge";
}

function IssueActions({
  item,
  caps,
  path,
  repoLabels,
  repoAssignees,
  repoMilestones,
  labelDraft,
  assigneeDraft,
  milestoneDraft,
  busy,
  error,
  message,
  onLabelDraftChange,
  onAssigneeDraftChange,
  onMilestoneDraftChange,
  onIssueState,
  onIssueLabels,
  lockReasonDraft,
  onLockReasonDraftChange,
  onToggleLock,
  transferDraft,
  onTransferDraftChange,
  transferConfirming,
  onTransferIssue,
  onCancelTransfer,
  canPush,
  canModifyOwn,
}: {
  item: GitHubListItem;
  caps: ProviderCaps;
  path: string;
  repoLabels: GitHubRepoLabel[];
  repoAssignees: GitHubUser[];
  repoMilestones: GitHubRepoMilestone[];
  labelDraft: string;
  assigneeDraft: string;
  milestoneDraft: string;
  busy?: string;
  error?: string;
  message?: string;
  onLabelDraftChange: (body: string) => void;
  onAssigneeDraftChange: (body: string) => void;
  onMilestoneDraftChange: (body: string) => void;
  onIssueState: (state: "open" | "closed") => void;
  onIssueLabels: () => void;
  lockReasonDraft: string;
  onLockReasonDraftChange: (body: string) => void;
  onToggleLock: () => void;
  transferDraft: string;
  onTransferDraftChange: (body: string) => void;
  transferConfirming: boolean;
  onTransferIssue: () => void;
  onCancelTransfer: () => void;
  canPush: boolean;
  // Push access OR being the issue's own author — gates close/reopen only.
  // Everything else here (triage save, lock, pin, transfer) stays push-only.
  canModifyOwn: boolean;
}) {
  const isBusy = !!busy;
  const pushDisabled = isBusy || !canPush;
  const pushTitle = canPush ? undefined : PUSH_ONLY_TITLE;
  const ownDisabled = isBusy || !canModifyOwn;
  const ownTitle = canModifyOwn ? undefined : PUSH_ONLY_TITLE;
  const nextState = item.state === "open" ? "closed" : "open";
  return (
    <div className="mt-3 rounded-md border border-border/60 bg-card p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Tag className="size-3.5" />
          Issue actions
        </div>
        {message && (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
            <CheckCircle2 className="size-3.5" />
            {message}
          </span>
        )}
        {error && (
          <span className="inline-flex items-center gap-1 text-[11px] text-rose-400">
            <AlertCircle className="size-3.5" />
            {error}
          </span>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.7fr)_auto]">
        <LabelAssigneeMilestoneFields
          repoLabels={repoLabels}
          repoAssignees={repoAssignees}
          repoMilestones={repoMilestones}
          labelDraft={labelDraft}
          assigneeDraft={assigneeDraft}
          milestoneDraft={milestoneDraft}
          disabled={isBusy}
          showLabels={caps.labels}
          showMilestones={caps.milestones}
          onLabelDraftChange={onLabelDraftChange}
          onAssigneeDraftChange={onAssigneeDraftChange}
          onMilestoneDraftChange={onMilestoneDraftChange}
        />
        <Button size="sm" variant="outline" disabled={pushDisabled} title={pushTitle} onClick={onIssueLabels}>
          {busy === "labels" ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Tag className="mr-2 size-3.5" />}
          Save triage
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={ownDisabled}
          title={ownTitle}
          onClick={() => onIssueState(nextState)}
        >
          {busy === nextState ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <XCircle className="mr-2 size-3.5" />}
          {item.state === "open" ? "Close issue" : "Reopen issue"}
        </Button>
        {caps.pinIssue && <IssuePinToggle path={path} number={item.number} canPush={canPush} />}
      </div>

      {caps.lockConversation && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
          <Select
            value={lockReasonDraft}
            onChange={(e) => onLockReasonDraftChange(e.target.value)}
            className="h-8 w-40 text-xs"
            disabled={isBusy || item.locked || !canPush}
            title="Lock reason (optional)"
            aria-label="Lock reason"
          >
            <option value="">No reason</option>
            <option value="off-topic">Off-topic</option>
            <option value="too heated">Too heated</option>
            <option value="resolved">Resolved</option>
            <option value="spam">Spam</option>
          </Select>
          <Button size="sm" variant="outline" disabled={pushDisabled} title={pushTitle} onClick={onToggleLock}>
            {busy === "lock" ? (
              <Loader2 className="mr-2 size-3.5 animate-spin" />
            ) : item.locked ? (
              <Unlock className="mr-2 size-3.5" />
            ) : (
              <Lock className="mr-2 size-3.5" />
            )}
            {item.locked ? "Unlock conversation" : "Lock conversation"}
          </Button>
        </div>
      )}

      {caps.subIssues && <SubIssues path={path} issueNumber={item.number} canPush={canPush} />}

      {caps.issueTransfer && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
          <Input
            value={transferDraft}
            onChange={(e) => onTransferDraftChange(e.target.value)}
            placeholder="Transfer to owner/repo"
            className="h-8 w-48 text-xs"
            disabled={isBusy || !canPush}
          />
          {transferConfirming ? (
            <>
              <span className="text-[11px] text-amber-400">
                Transfer #{item.number} to {transferDraft.trim() || "…"}? This can't be undone.
              </span>
              <Button size="sm" variant="destructive" disabled={pushDisabled || !transferDraft.trim()} title={pushTitle} onClick={onTransferIssue}>
                {busy === "transfer" ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <ArrowRightLeft className="mr-2 size-3.5" />}
                Confirm transfer
              </Button>
              <Button size="sm" variant="ghost" disabled={isBusy} onClick={onCancelTransfer}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" disabled={pushDisabled || !transferDraft.trim()} title={pushTitle} onClick={onTransferIssue}>
              <ArrowRightLeft className="mr-2 size-3.5" />
              Transfer issue
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Self-contained pin/unpin control. GitHub's REST issue payload doesn't
 *  carry pin state (GraphQL-only), so this lazily reads it via
 *  `getGitHubIssuePinned` on mount rather than threading yet another field
 *  through the parent's already-large per-item state. */
function IssuePinToggle({ path, number, canPush }: { path: string; number: number; canPush: boolean }) {
  const [pinned, setPinned] = useState<boolean | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!path) return;
    const requestId = ++seq.current;
    setLoading(true);
    setError(null);
    api.getGitHubIssuePinned({ path, number })
      .then((r) => { if (requestId === seq.current) setPinned(r.pinned); })
      .catch((e: unknown) => { if (requestId === seq.current) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (requestId === seq.current) setLoading(false); });
  }, [path, number]);

  const toggle = async () => {
    if (busy || pinned === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.setGitHubIssuePinned({ path, number, pinned: !pinned });
      setPinned(res.pinned);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={busy || loading || pinned === undefined || !canPush}
        title={canPush ? undefined : PUSH_ONLY_TITLE}
        onClick={() => void toggle()}
      >
        {busy || loading ? (
          <Loader2 className="mr-2 size-3.5 animate-spin" />
        ) : pinned ? (
          <PinOff className="mr-2 size-3.5" />
        ) : (
          <Pin className="mr-2 size-3.5" />
        )}
        {pinned ? "Unpin issue" : "Pin issue"}
      </Button>
      {error && <span className="text-[11px] text-rose-400">{error}</span>}
    </div>
  );
}

/** Self-contained sub-issues panel: lazily fetches the child list the first
 *  time it's expanded, and owns its own add/remove busy state. Kept separate
 *  from the parent's per-item state (like `IssuePinToggle`) since both `path`
 *  and `issueNumber` fully determine its data. */
function SubIssues({ path, issueNumber, canPush }: { path: string; issueNumber: number; canPush: boolean }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<GitHubSubIssue[] | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0);

  const load = () => {
    if (!path) return;
    const requestId = ++seq.current;
    setLoading(true);
    setError(null);
    api.listGitHubSubIssues({ path, number: issueNumber })
      .then((r) => { if (requestId === seq.current) setItems(r.subIssues); })
      .catch((e: unknown) => { if (requestId === seq.current) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (requestId === seq.current) setLoading(false); });
  };

  useEffect(() => {
    if (open && items === undefined && !loading) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, path, issueNumber]);

  const add = async () => {
    const childNumber = Number(addDraft.trim().replace(/^#/, ""));
    if (!Number.isInteger(childNumber) || childNumber <= 0 || busy) return;
    setBusy("add");
    setError(null);
    try {
      const res = await api.addGitHubSubIssue({ path, number: issueNumber, childNumber });
      // Dedupe on id — re-adding an already-linked child can return the existing
      // link, which would otherwise duplicate the row (and its React key).
      setItems((cur) => [...(cur ?? []).filter((c) => c.id !== res.subIssue.id), res.subIssue]);
      setAddDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (child: GitHubSubIssue) => {
    if (busy) return;
    setBusy(`remove:${child.id}`);
    setError(null);
    try {
      await api.removeGitHubSubIssue({ path, number: issueNumber, childId: child.id });
      setItems((cur) => (cur ?? []).filter((c) => c.id !== child.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3 rounded-md border border-border/60 bg-card p-3">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <ListTree className="size-3.5" />
          Sub-issues{items ? ` (${items.length})` : ""}
        </span>
        {open ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
      </button>
      {open && (
        <div className="mt-3">
          {loading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Loading sub-issues…
            </div>
          )}
          {error && (
            <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-rose-400">
              <span className="flex items-center gap-1">
                <AlertCircle className="size-3.5" /> {error}
              </span>
              <Button size="sm" variant="ghost" className="h-6 px-2" onClick={load}>
                Retry
              </Button>
            </div>
          )}
          {!loading && !error && items && items.length === 0 && (
            <div className="text-xs italic text-muted-foreground">No sub-issues yet.</div>
          )}
          {items && items.length > 0 && (
            <ul className="flex flex-col gap-1">
              {items.map((child) => (
                <li key={child.id} className="flex items-center justify-between gap-2 rounded border border-border/40 px-2 py-1 text-xs">
                  <button
                    type="button"
                    className="min-w-0 truncate text-left hover:underline"
                    onClick={() => { void api.openExternal(child.htmlUrl); }}
                  >
                    #{child.number} {child.title}
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className={child.state === "open" ? "text-emerald-400" : "text-rose-400"}>{child.state}</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-6"
                      disabled={busy === `remove:${child.id}` || !canPush}
                      title={canPush ? `Remove #${child.number}` : PUSH_ONLY_TITLE}
                      aria-label={`Remove #${child.number}`}
                      onClick={() => void remove(child)}
                    >
                      {busy === `remove:${child.id}` ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex items-center gap-2">
            <Input
              value={addDraft}
              onChange={(e) => setAddDraft(e.target.value)}
              placeholder="Add by #number"
              className="h-8 w-32 text-xs"
              disabled={busy === "add" || !canPush}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy === "add" || !addDraft.trim() || !canPush}
              title={canPush ? undefined : PUSH_ONLY_TITLE}
              onClick={() => void add()}
            >
              {busy === "add" ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Plus className="mr-2 size-3.5" />}
              Add
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ItemEditor({
  title,
  body,
  busy,
  error,
  canSave,
  onTitleChange,
  onBodyChange,
  onCancel,
  onSave,
}: {
  title: string;
  body: string;
  busy: boolean;
  error?: string;
  // Whether the viewer may save this edit — repo push access OR being the
  // item's own author (title/body edits are allowed to the author).
  canSave: boolean;
  onTitleChange: (title: string) => void;
  onBodyChange: (body: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-card p-3">
      {error && (
        <div className="mb-2 flex items-center gap-1 text-[11px] text-rose-400">
          <AlertCircle className="size-3.5" />
          {error}
        </div>
      )}
      <div className="grid gap-2">
        <Input
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder="Title"
          className="h-8 text-sm"
          disabled={busy}
        />
        <Textarea
          value={body}
          onChange={(e) => onBodyChange(e.target.value)}
          placeholder="Markdown body..."
          className="min-h-32 resize-y text-sm"
          disabled={busy}
        />
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy || !title.trim() || !canSave} title={canSave ? undefined : PUSH_ONLY_TITLE} onClick={onSave}>
          {busy ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <FilePen className="mr-2 size-3.5" />}
          Save
        </Button>
      </div>
    </div>
  );
}

function PullTriage({
  caps,
  provider,
  repoLabels,
  repoAssignees,
  repoMilestones,
  labelDraft,
  assigneeDraft,
  milestoneDraft,
  reviewerDraft,
  teamReviewerDraft,
  busy,
  prOpen,
  error,
  message,
  onLabelDraftChange,
  onAssigneeDraftChange,
  onMilestoneDraftChange,
  onReviewerDraftChange,
  onTeamReviewerDraftChange,
  onSaveTriage,
  onRequestReviewers,
  canPush,
}: {
  caps: ProviderCaps;
  // Reviewer-request UI is GitHub-only (GitLab/Bitbucket reviewer assignment
  // isn't part of the adapters' core subset — see git-host.ts's `pullCreate`
  // doc comment); gate on a confirmed GitHub repo, not merely `caps`.
  provider: GitProvider | "mixed" | null;
  repoLabels: GitHubRepoLabel[];
  repoAssignees: GitHubUser[];
  repoMilestones: GitHubRepoMilestone[];
  labelDraft: string;
  assigneeDraft: string;
  milestoneDraft: string;
  reviewerDraft: string;
  teamReviewerDraft: string;
  busy?: string;
  prOpen: boolean;
  error?: string;
  message?: string;
  onLabelDraftChange: (body: string) => void;
  onAssigneeDraftChange: (body: string) => void;
  onMilestoneDraftChange: (body: string) => void;
  onReviewerDraftChange: (body: string) => void;
  onTeamReviewerDraftChange: (body: string) => void;
  onSaveTriage: () => void;
  onRequestReviewers: () => void;
  canPush: boolean;
}) {
  const isBusy = !!busy;
  const pushDisabled = isBusy || !canPush;
  const pushTitle = canPush ? undefined : PUSH_ONLY_TITLE;
  const reviewersTitle = !prOpen
    ? "Reviewers can only be requested on open pull requests"
    : pushTitle;
  return (
    <div className="mt-3 rounded-md border border-border/60 bg-card p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Tag className="size-3.5" />
          Triage
        </div>
        {message && (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
            <CheckCircle2 className="size-3.5" />
            {message}
          </span>
        )}
        {error && (
          <span className="inline-flex items-center gap-1 text-[11px] text-rose-400">
            <AlertCircle className="size-3.5" />
            {error}
          </span>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.7fr)_auto]">
        <LabelAssigneeMilestoneFields
          repoLabels={repoLabels}
          repoAssignees={repoAssignees}
          repoMilestones={repoMilestones}
          labelDraft={labelDraft}
          assigneeDraft={assigneeDraft}
          milestoneDraft={milestoneDraft}
          disabled={isBusy}
          showLabels={caps.labels}
          showMilestones={caps.milestones}
          onLabelDraftChange={onLabelDraftChange}
          onAssigneeDraftChange={onAssigneeDraftChange}
          onMilestoneDraftChange={onMilestoneDraftChange}
        />
        <Button size="sm" variant="outline" disabled={pushDisabled} title={pushTitle} onClick={onSaveTriage}>
          {busy === "labels" ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Tag className="mr-2 size-3.5" />}
          Save triage
        </Button>
      </div>
      {provider === "github" && (
        <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <Input
            value={reviewerDraft}
            onChange={(e) => onReviewerDraftChange(e.target.value)}
            placeholder={prOpen ? "Reviewers, comma separated" : "Reviewers can only be requested on open PRs"}
            className="h-8 text-xs"
            disabled={isBusy || !prOpen || !canPush}
          />
          <Input
            value={teamReviewerDraft}
            onChange={(e) => onTeamReviewerDraftChange(e.target.value)}
            placeholder={prOpen ? "Teams, comma separated (org slugs)" : "Teams can only be requested on open PRs"}
            className="h-8 text-xs"
            disabled={isBusy || !prOpen || !canPush}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={pushDisabled || !prOpen || (!reviewerDraft.trim() && !teamReviewerDraft.trim())}
            title={reviewersTitle}
            onClick={onRequestReviewers}
          >
            {busy === "reviewers" ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <GitPullRequest className="mr-2 size-3.5" />}
            Request review
          </Button>
        </div>
      )}
    </div>
  );
}

function PullActions({
  item,
  caps,
  provider,
  itemPath,
  reviewDraft,
  closeDraft,
  mergeMethod,
  busy,
  error,
  message,
  mergeability,
  mergeabilityLoading,
  mergeabilityError,
  pendingCount,
  onReviewDraftChange,
  onCloseDraftChange,
  onMergeMethodChange,
  onReview,
  onMerge,
  onUpdateBranch,
  onReopenPull,
  onToggleDraft,
  onToggleAutoMerge,
  onClosePull,
  onRefreshMergeability,
  canPush,
  canModifyOwn,
}: {
  item: GitHubListItem;
  caps: ProviderCaps;
  // The draft-toggle *write* is GitHub GraphQL-only even though GitLab and
  // Bitbucket both support draft PRs at creation time (caps.draft stays true
  // for them) — see the ProviderCaps doc comment. Gate the toggle control
  // itself on a confirmed GitHub repo; the draft badge elsewhere is ungated.
  provider: GitProvider | "mixed" | null;
  itemPath: string;
  reviewDraft: string;
  closeDraft: string;
  mergeMethod: GitHubPullMergeMethod;
  busy?: string;
  error?: string;
  message?: string;
  mergeability?: GitHubPullMergeability;
  mergeabilityLoading: boolean;
  mergeabilityError?: string;
  pendingCount: number;
  onReviewDraftChange: (body: string) => void;
  onCloseDraftChange: (body: string) => void;
  onMergeMethodChange: (method: GitHubPullMergeMethod) => void;
  onReview: (event: GitHubPullReviewEvent) => void;
  onMerge: () => void;
  onUpdateBranch: () => void;
  onReopenPull: () => void;
  onToggleDraft: () => void;
  onToggleAutoMerge: () => void;
  onClosePull: () => void;
  onRefreshMergeability: () => void;
  canPush: boolean;
  // Push access OR being the PR's own author — gates close/reopen only.
  // Merge, auto-merge, update-branch and draft-toggle stay push-only.
  canModifyOwn: boolean;
}) {
  const disabled = item.state !== "open" || !!busy;
  const view = item.state === "open" && mergeability ? mergeabilityView(mergeability) : null;
  const mergeDisabled = disabled || !canPush || (view ? !view.canMerge : false);
  const mergeTitle = !canPush ? PUSH_ONLY_TITLE : view && !view.canMerge ? view.label : undefined;
  const pushDisabled = disabled || !canPush;
  const pushTitle = canPush ? undefined : PUSH_ONLY_TITLE;
  const ownTitle = canModifyOwn ? undefined : PUSH_ONLY_TITLE;
  // Reopen shows only on a closed PR, so it can't reuse `disabled`
  // (which is always true off the open state) — gate it on busy + own-modify.
  const reopenDisabled = !!busy || !canModifyOwn;
  // Close needs an open PR (via `disabled`) plus push-or-author.
  const closeDisabled = disabled || !canModifyOwn;
  const canResolveConflicts =
    provider === "github" &&
    item.state === "open" &&
    !!mergeability &&
    mergeability.mergeableState === "dirty" &&
    !mergeability.crossRepo &&
    !mergeability.merged;
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveConfirmed, setResolveConfirmed] = useState(false);
  const resolveContext: ResolveConflictsContext | null =
    canResolveConflicts && mergeability
      ? {
          path: itemPath,
          repo: mergeability.repo,
          number: item.number,
          title: item.title,
          headRef: mergeability.headRef,
          baseRef: mergeability.baseRef,
        }
      : null;
  return (
    <div className="mt-3 rounded-md border border-border/60 bg-card p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <GitPullRequest className="size-3.5" />
          Actions
        </div>
        {item.state === "open" && provider === "github" && (
          <Button size="sm" variant="ghost" className="h-7" disabled={!!busy || !canPush} title={pushTitle} onClick={onToggleDraft}>
            {busy === "draft" ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <FilePen className="mr-2 size-3.5" />}
            {item.draft ? "Mark ready for review" : "Convert to draft"}
          </Button>
        )}
        {item.state !== "open" && item.mergedAt && (
          <span className="inline-flex items-center gap-1 text-[11px] text-violet-400">
            <GitMerge className="size-3.5" />
            Merged
          </span>
        )}
        {item.state !== "open" && !item.mergedAt && (
          <Button size="sm" variant="outline" className="h-7" disabled={reopenDisabled} title={ownTitle} onClick={onReopenPull}>
            {busy === "reopen" ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <GitPullRequest className="mr-2 size-3.5" />}
            Reopen
          </Button>
        )}
        {message && (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
            <CheckCircle2 className="size-3.5" />
            {message}
          </span>
        )}
        {error && (
          <span className="inline-flex items-center gap-1 text-[11px] text-rose-400">
            <AlertCircle className="size-3.5" />
            {error}
          </span>
        )}
      </div>

      {item.state === "open" && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border/50 bg-background/40 px-3 py-2">
          {mergeabilityLoading && !mergeability ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Checking mergeability…
            </span>
          ) : mergeabilityError ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-rose-400">
              <AlertCircle className="size-3.5" /> {mergeabilityError}
            </span>
          ) : view ? (
            <>
              <span className={cn("inline-flex items-center gap-1.5 text-[11px]", MERGE_TONE_CLASS[view.tone])}>
                <span className={cn("size-2 shrink-0 rounded-full bg-current")} />
                {view.label}
              </span>
              {canResolveConflicts && (
                <Button size="sm" variant="outline" onClick={() => setResolveOpen(true)}>
                  <GitMerge className="mr-2 size-3.5" />
                  Resolve with Agetor
                </Button>
              )}
              {resolveConfirmed && (
                <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
                  <CheckCircle2 className="size-3.5" />
                  Task created and started — check the board
                </span>
              )}
            </>
          ) : (
            <span className="text-[11px] text-muted-foreground">Mergeability unavailable.</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {caps.updateBranch && view?.showUpdateBranch && (
              <Button size="sm" variant="outline" disabled={pushDisabled} title={pushTitle} onClick={onUpdateBranch}>
                {busy === "update-branch" ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <ArrowUpFromLine className="mr-2 size-3.5" />}
                Update branch
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              title="Refresh mergeability"
              aria-label="Refresh mergeability"
              disabled={mergeabilityLoading}
              onClick={onRefreshMergeability}
            >
              {mergeabilityLoading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="min-w-0">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium uppercase text-muted-foreground">Review</span>
            {pendingCount > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] text-sky-400">
                <MessageSquare className="size-3 shrink-0" />
                {pendingCount} inline comment{pendingCount === 1 ? "" : "s"} queued
              </span>
            )}
          </div>
          <Textarea
            value={reviewDraft}
            onChange={(e) => onReviewDraftChange(e.target.value)}
            placeholder={pendingCount > 0 ? "Optional review summary — submits the queued comments" : "Review note..."}
            className="min-h-20 resize-y text-xs"
            disabled={disabled}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => onReview("APPROVE")}
            >
              {busy === "APPROVE" ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <CheckCircle2 className="mr-2 size-3.5" />}
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || (!reviewDraft.trim() && pendingCount === 0)}
              onClick={() => onReview("COMMENT")}
            >
              {busy === "COMMENT" ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <MessageSquare className="mr-2 size-3.5" />}
              Comment
            </Button>
            {caps.requestChanges && (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || (!reviewDraft.trim() && pendingCount === 0)}
                onClick={() => onReview("REQUEST_CHANGES")}
              >
                {busy === "REQUEST_CHANGES" ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <XCircle className="mr-2 size-3.5" />}
                Request
              </Button>
            )}
          </div>
        </div>

        <div className="min-w-0">
          <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">Merge</div>
          <Select
            value={mergeMethod}
            onChange={(e) => onMergeMethodChange(e.target.value as GitHubPullMergeMethod)}
            className="h-8 text-xs"
            disabled={disabled}
            title="Merge method"
            aria-label="Merge method"
          >
            {caps.mergeMethods.map((method) => (
              <option key={method} value={method}>
                {mergeMethodLabel(method, provider)}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            className="mt-2"
            disabled={mergeDisabled}
            title={mergeTitle}
            onClick={onMerge}
          >
            {busy === "merge" ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <GitMerge className="mr-2 size-3.5" />}
            Merge
          </Button>
          {item.state === "open" && caps.autoMerge && (
            <div className="mt-2 flex items-center gap-2">
              {mergeability?.autoMerge ? (
                <>
                  <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
                    <CheckCircle2 className="size-3.5" /> Auto-merge enabled
                  </span>
                  <Button size="sm" variant="outline" disabled={pushDisabled} title={pushTitle} onClick={onToggleAutoMerge}>
                    {busy === "auto-merge" ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
                    Disable
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pushDisabled || !mergeability}
                  title={!canPush ? PUSH_ONLY_TITLE : !mergeability ? "Waiting for mergeability…" : undefined}
                  onClick={onToggleAutoMerge}
                >
                  {busy === "auto-merge" ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <GitMerge className="mr-2 size-3.5" />}
                  Enable auto-merge
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="min-w-0">
          <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">Close</div>
          <Textarea
            value={closeDraft}
            onChange={(e) => onCloseDraftChange(e.target.value)}
            placeholder="Optional close comment..."
            className="min-h-20 resize-y text-xs"
            disabled={disabled}
          />
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            disabled={closeDisabled}
            title={ownTitle}
            onClick={onClosePull}
          >
            {busy === "close" ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <XCircle className="mr-2 size-3.5" />}
            Close PR
          </Button>
        </div>
      </div>

      {pendingCount > 0 && (
        <div className="mt-3 flex items-start gap-1.5 text-[11px] text-amber-400">
          <AlertCircle className="mt-px size-3.5 shrink-0" />
          {pendingCount} review comment{pendingCount === 1 ? "" : "s"} queued — submit via Approve / Comment / Request; merging or closing won't post {pendingCount === 1 ? "it" : "them"}.
        </div>
      )}
      <ResolveConflictsDialog
        open={resolveOpen}
        onClose={() => setResolveOpen(false)}
        context={resolveContext}
        onCreated={() => {
          setResolveConfirmed(true);
          setTimeout(() => setResolveConfirmed(false), 5_000);
        }}
      />
    </div>
  );
}

/** Compact "Closes: #12 #34" line for the issues a PR will close on merge —
 *  read-only, so just a row of links (closed ones dimmed/struck through). */
function LinkedIssuesLine({ issues }: { issues: GitHubLinkedIssue[] }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
      <span className="font-medium text-foreground/80">Closes:</span>
      {issues.map((issue) => (
        <button
          key={issue.number}
          type="button"
          className={cn(
            "hover:underline",
            issue.state === "CLOSED" && "text-muted-foreground/60 line-through",
          )}
          title={issue.title}
          onClick={() => { void api.openExternal(issue.url); }}
        >
          #{issue.number}
        </button>
      ))}
    </div>
  );
}

/** Collapsible "Commits (N)" section for the PR's commits — data is fetched
 *  automatically once the row expands (mirrors `checks`/`mergeability`); this
 *  local `open` state only controls whether the fetched list is shown. */
function PullCommits({
  commits,
  loading,
  error,
  onRetry,
}: {
  commits?: GitHubPullCommit[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((cur) => !cur)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          Commits{commits ? ` (${commits.length})` : ""}
        </span>
        {loading && <Loader2 className="size-3.5 animate-spin" />}
      </button>
      {open && (
        <div className="mt-2">
          {loading && !commits && (
            <div className="flex items-center justify-center gap-2 rounded-md border border-border/60 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading commits...
            </div>
          )}
          {!loading && error && (
            <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-border/60 py-6 text-center text-sm text-rose-400">
              <div className="flex items-center gap-2">
                <AlertCircle className="size-4" /> {error}
              </div>
              <Button size="sm" variant="outline" onClick={onRetry}>
                Retry
              </Button>
            </div>
          )}
          {!loading && !error && commits && commits.length === 0 && (
            <div className="rounded-md border border-border/60 px-3 py-6 text-center text-sm text-muted-foreground">
              No commits found for this pull request.
            </div>
          )}
          {!loading && !error && commits && commits.length > 0 && (
            <div className="overflow-hidden rounded-md border border-border/60">
              {commits.map((commit) => (
                <div key={commit.sha} className="flex items-center gap-2 border-b border-border/50 px-3 py-2 last:border-b-0">
                  <button
                    type="button"
                    className="shrink-0 font-mono text-[11px] text-muted-foreground hover:underline"
                    title="Open commit"
                    aria-label={`Open commit ${commit.sha.slice(0, 7)}`}
                    onClick={() => { void api.openExternal(commit.htmlUrl); }}
                  >
                    {commit.sha.slice(0, 7)}
                  </button>
                  <span className="min-w-0 flex-1 truncate text-sm">{commit.messageHeadline}</span>
                  {commit.author && (
                    <span className="shrink-0 text-xs text-muted-foreground">{commit.author.login}</span>
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground">{fmtRelativeDate(commit.authoredDate)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CheckRuns({
  checks,
  loading,
  error,
  onRetry,
  onRefresh,
}: {
  checks?: GitHubChecksResult;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="mt-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <GitPullRequest className="size-3.5" />
          Checks
        </div>
        <div className="flex items-center gap-2">
          {checks && (
            <div className="font-mono text-[11px] text-muted-foreground">
              {checks.sha.slice(0, 7)}
            </div>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            title="Refresh checks"
            aria-label="Refresh checks"
            disabled={loading}
            onClick={onRefresh}
          >
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </Button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 rounded-md border border-border/60 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading checks...
        </div>
      )}
      {!loading && error && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-border/60 py-6 text-center text-sm text-rose-400">
          <div className="flex items-center gap-2">
            <AlertCircle className="size-4" /> {error}
          </div>
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}
      {!loading && !error && checks && checks.checkRuns.length === 0 && (
        <div className="rounded-md border border-border/60 px-3 py-6 text-center text-sm text-muted-foreground">
          No check runs found for this pull request head.
        </div>
      )}
      {!loading && !error && checks && checks.checkRuns.length > 0 && (
        <div className="overflow-hidden rounded-md border border-border/60">
          {checks.checkRuns.map((run) => (
            <div key={run.id} className="flex items-center gap-2 border-b border-border/50 px-3 py-2 last:border-b-0">
              <span className={cn("size-2 shrink-0 rounded-full bg-current", checkClass(run))} />
              <span className="min-w-0 flex-1 truncate text-sm">{run.name}</span>
              <span className={cn("shrink-0 text-xs", checkClass(run))}>
                {run.status === "completed" ? run.conclusion ?? "completed" : run.status}
              </span>
              {run.htmlUrl && (
                <Button
                  size="icon"
                  variant="ghost"
                  title="Open check"
                  aria-label={`Open ${run.name} check`}
                  onClick={() => { void api.openExternal(run.htmlUrl!); }}
                >
                  <ExternalLink className="size-3.5" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** F19 — the combined status from GitHub's legacy Status API, shown next to
 *  the check-runs section above. Distinct data source (some CI providers
 *  still only post through this older API), so it's possible for one to have
 *  entries while the other doesn't. Hidden entirely when there's nothing to
 *  show (`total === 0`) rather than rendering an empty section. */
function CommitStatus({
  status,
  loading,
  error,
  onRetry,
  onRefresh,
}: {
  status?: GitHubCommitStatusResult;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onRefresh: () => void;
}) {
  // The legacy combined-status API is rarely populated (most repos post via
  // check-runs), so most PR expansions resolve to empty. Render nothing until we
  // actually have contexts to show — otherwise every expand flashes a header +
  // "Loading…" box that immediately unmounts. `total` can also diverge from the
  // surviving `statuses` (defensive), so gate visibility on the array length.
  const hasContent = !!status && status.statuses.length > 0;
  if (loading && !status) return null;
  if (!loading && !error && !hasContent) return null;

  return (
    <div className="mt-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <GitPullRequest className="size-3.5" />
          Commit status
        </div>
        <div className="flex items-center gap-2">
          {hasContent && (
            <span className={cn("text-[11px] font-medium capitalize", commitStatusClass(status.state))}>
              {status.state || "unknown"}
            </span>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            title="Refresh commit status"
            aria-label="Refresh commit status"
            disabled={loading}
            onClick={onRefresh}
          >
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </Button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 rounded-md border border-border/60 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading commit status...
        </div>
      )}
      {!loading && error && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-border/60 py-6 text-center text-sm text-rose-400">
          <div className="flex items-center gap-2">
            <AlertCircle className="size-4" /> {error}
          </div>
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}
      {!loading && !error && hasContent && (
        <div className="overflow-hidden rounded-md border border-border/60">
          {status!.statuses.map((ctx) => (
            <div key={ctx.context} className="flex items-center gap-2 border-b border-border/50 px-3 py-2 last:border-b-0">
              <span className={cn("size-2 shrink-0 rounded-full bg-current", commitStatusClass(ctx.state))} />
              <span className="min-w-0 flex-1 truncate text-sm">{ctx.context}</span>
              {ctx.description && <span className="min-w-0 max-w-[40%] truncate text-xs text-muted-foreground">{ctx.description}</span>}
              <span className={cn("shrink-0 text-xs capitalize", commitStatusClass(ctx.state))}>{ctx.state || "unknown"}</span>
              {ctx.targetUrl && (
                <Button
                  size="icon"
                  variant="ghost"
                  title="Open status target on GitHub"
                  aria-label={`Open ${ctx.context} status on GitHub`}
                  onClick={() => { void api.openExternal(ctx.targetUrl!); }}
                >
                  <ExternalLink className="size-3.5" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PullDiff({
  diff,
  loading,
  error,
  onRetry,
  onRefresh,
  onLineComment,
  onAddToReview,
  pending,
  allowBatchReview,
}: {
  diff?: TaskDiff;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onRefresh: () => void;
  onLineComment: (target: LineCommentTarget) => Promise<void>;
  onAddToReview: (target: LineCommentTarget) => void;
  pending: LineCommentTarget[];
  // GitLab/Bitbucket reviews don't support GitHub's "pending review" batch of
  // inline comments (see git-host.ts's `PullReviewInput` doc comment — the
  // facade silently drops a non-GitHub review's `comments` array), so
  // "Add to review" would queue comments that are never actually submitted.
  // Hide the batch affordance entirely on those providers; a single inline
  // comment still posts immediately via `onLineComment`.
  allowBatchReview: boolean;
}) {
  const totals = useMemo(() => {
    const files = diff?.files ?? [];
    return files.reduce(
      (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
      { additions: 0, deletions: 0 },
    );
  }, [diff]);

  const queuedKeys = useMemo(
    () => new Set(pending.map((c) => `${c.filePath}|${c.line}|${c.side}`)),
    [pending],
  );

  return (
    <div className="mt-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <GitPullRequest className="size-3.5" />
          Diff
        </div>
        <div className="flex items-center gap-2">
          {diff && diff.files.length > 0 && (
            <div className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {diff.files.length} {diff.files.length === 1 ? "file" : "files"}
              {" "}
              <span className="text-emerald-400">+{totals.additions}</span>{" "}
              <span className="text-rose-400">-{totals.deletions}</span>
            </div>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            title="Refresh diff"
            aria-label="Refresh diff"
            disabled={loading}
            onClick={onRefresh}
          >
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </Button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 rounded-md border border-border/60 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading diff...
        </div>
      )}
      {!loading && error && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-border/60 py-8 text-center text-sm text-rose-400">
          <div className="flex items-center gap-2">
            <AlertCircle className="size-4" /> {error}
          </div>
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}
      {!loading && !error && diff && diff.files.length === 0 && (
        <div className="rounded-md border border-border/60 px-3 py-8 text-center text-sm text-muted-foreground">
          {diff.note ?? "No diff returned for this pull request."}
        </div>
      )}
      {!loading && !error && diff && diff.files.length > 0 && (
        <div className="max-h-[55vh] overflow-y-auto rounded-md border border-border/60">
          {diff.files.map((file) => (
            <DiffFileBlock
              key={`${file.oldPath ?? ""}->${file.path}`}
              file={file}
              onLineComment={onLineComment}
              onAddToReview={onAddToReview}
              queuedKeys={queuedKeys}
              allowBatchReview={allowBatchReview}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PendingReview({
  comments,
  stale,
  onRemove,
}: {
  comments: LineCommentTarget[];
  stale: boolean;
  onRemove: (index: number) => void;
}) {
  if (comments.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <MessageSquare className="size-3.5" />
        Pending review ({comments.length})
      </div>
      {stale && (
        <div className="mb-2 flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-400">
          <AlertCircle className="mt-px size-3.5 shrink-0" />
          The diff changed since these were queued — their line numbers may be stale, and GitHub rejects the whole review if any line no longer matches. Re-queue them against the current diff before submitting.
        </div>
      )}
      <div className="flex flex-col gap-2">
        {comments.map((c, i) => (
          <div key={`${c.filePath}-${c.side}-${c.line}-${i}`} className="rounded-md border border-border/60 bg-card">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/50 px-3 py-2 text-xs text-muted-foreground">
              <span className="min-w-0 truncate font-mono">{c.filePath}:{c.line}</span>
              <span>{c.side === "LEFT" ? "old" : "new"} side</span>
              <Button
                size="icon"
                variant="ghost"
                className="ml-auto size-6"
                title="Remove from review"
                aria-label="Remove from review"
                onClick={() => onRemove(i)}
              >
                <XCircle className="size-3.5" />
              </Button>
            </div>
            <div className="whitespace-pre-wrap px-3 py-2 text-sm">{c.body}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Submit these with Approve / Comment / Request in the Actions panel above.
      </p>
    </div>
  );
}

function ReviewComments({
  path,
  caps,
  comments,
  loading,
  error,
  replyDrafts,
  replySubmitting,
  viewerLogin,
  threads,
  threadsTruncated,
  prOpen,
  applyBusy,
  onToggleResolved,
  onEdit,
  onDelete,
  onApply,
  onDraftChange,
  onSubmitReply,
  onRetry,
  canPush,
  canResolveThreads,
  resolveSupported,
}: {
  path: string;
  caps: ProviderCaps;
  comments?: GitHubPullLineComment[];
  loading: boolean;
  error?: string;
  replyDrafts: Record<number, string | undefined>;
  replySubmitting: Record<number, boolean | undefined>;
  viewerLogin: string;
  threads: GitHubReviewThread[];
  threadsTruncated: boolean;
  // Suggestion "Apply" only makes sense on an open PR with the current file
  // reachable in the same repo — see applyGitHubSuggestion's cross-fork guard.
  prOpen: boolean;
  applyBusy: Record<number, boolean | undefined>;
  onToggleResolved: (thread: GitHubReviewThread) => Promise<void>;
  onEdit: (commentId: number, body: string) => Promise<void>;
  onDelete: (commentId: number) => Promise<void>;
  onApply: (commentId: number) => void;
  onDraftChange: (commentId: number, body: string) => void;
  onSubmitReply: (commentId: number) => void;
  onRetry: () => void;
  // Gates the Apply-suggestion button (a push-only write to the head branch).
  canPush: boolean;
  // Resolving/reopening a thread needs write access OR being the PR author, so
  // this is the wider `canPush || prAuthorIsViewer` flag — distinct from
  // `canPush`, which the apply-suggestion write still needs on its own.
  canResolveThreads: boolean;
  // Thread resolve/reopen is a GitHub GraphQL-only concept — GitLab/Bitbucket
  // review threads have no equivalent — so this is gated separately from
  // `canResolveThreads` (which only expresses *who* may resolve, not whether
  // the provider supports resolving at all).
  resolveSupported: boolean;
}) {
  const [busyThread, setBusyThread] = useState<string | null>(null);
  const [threadError, setThreadError] = useState<{ id: string; msg: string } | null>(null);
  const threadByRoot = new Map(threads.map((t) => [t.rootCommentId, t]));
  const toggle = async (thread: GitHubReviewThread) => {
    if (busyThread) return;
    setBusyThread(thread.threadId);
    setThreadError(null);
    try {
      await onToggleResolved(thread);
    } catch (e) {
      setThreadError({ id: thread.threadId, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyThread(null);
    }
  };
  return (
    <div className="mt-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <MessageSquare className="size-3.5" />
          Review comments
        </div>
        {comments && (
          <div className="text-[11px] text-muted-foreground">
            {comments.length} {comments.length === 1 ? "comment" : "comments"}
          </div>
        )}
      </div>

      {threadsTruncated && (
        <div className="mb-2 flex items-start gap-1.5 text-[11px] text-amber-400">
          <AlertCircle className="mt-px size-3.5 shrink-0" />
          This pull request has more than 100 review threads — resolve controls cover only the first 100.
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center gap-2 rounded-md border border-border/60 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading review comments...
        </div>
      )}
      {!loading && error && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-border/60 py-6 text-center text-sm text-rose-400">
          <div className="flex items-center gap-2">
            <AlertCircle className="size-4" /> {error}
          </div>
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}
      {!loading && !error && comments && comments.length === 0 && (
        <div className="rounded-md border border-border/60 px-3 py-6 text-center text-sm text-muted-foreground">
          No review comments yet.
        </div>
      )}
      {!loading && !error && comments && comments.length > 0 && (
        <div className="flex flex-col gap-2">
          {comments.map((comment) => {
            const draft = replyDrafts[comment.id] ?? "";
            const submitting = !!replySubmitting[comment.id];
            const thread = threadByRoot.get(comment.id);
            return (
              <div key={comment.id} className="rounded-md border border-border/60 bg-card">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/50 px-3 py-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{comment.author?.login ?? "unknown"}</span>
                  <span>{comment.path}:{comment.line}</span>
                  <span>{comment.side === "LEFT" ? "old" : "new"} side</span>
                  <span>{fmtDate(comment.createdAt)}</span>
                  {thread?.isResolved && (
                    <span className="inline-flex items-center gap-1 text-emerald-400">
                      <CheckCircle2 className="size-3" />
                      resolved
                    </span>
                  )}
                  {thread?.isOutdated && (
                    <span className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] uppercase">
                      outdated
                    </span>
                  )}
                  {thread && resolveSupported && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto h-6 px-2 text-[11px]"
                      disabled={busyThread === thread.threadId || !canResolveThreads}
                      title={canResolveThreads ? undefined : PUSH_ONLY_TITLE}
                      onClick={() => { void toggle(thread); }}
                    >
                      {busyThread === thread.threadId
                        ? <Loader2 className="mr-1 size-3 animate-spin" />
                        : thread.isResolved ? <RefreshCw className="mr-1 size-3" /> : <CheckCircle2 className="mr-1 size-3" />}
                      {thread.isResolved ? "Reopen" : "Resolve"}
                    </Button>
                  )}
                </div>
                {thread && threadError?.id === thread.threadId && (
                  <div className="flex items-center gap-1 border-b border-border/50 px-3 py-1.5 text-[11px] text-rose-400">
                    <AlertCircle className="size-3.5" />
                    {threadError.msg}
                  </div>
                )}
                <EditableCommentBody
                  body={comment.body}
                  canModify={!!viewerLogin && comment.author?.login === viewerLogin}
                  onEdit={(body) => onEdit(comment.id, body)}
                  onDelete={() => onDelete(comment.id)}
                  suggestion={caps.suggestions && hasSuggestion(comment.body) ? {
                    canApply: !!viewerLogin && prOpen,
                    canPush,
                    applying: !!applyBusy[comment.id],
                    onApply: () => onApply(comment.id),
                  } : undefined}
                />
                {caps.reactions && (
                  <div className="px-3 pb-2">
                    <Reactions path={path} subject={{ type: "reviewComment", id: comment.id }} viewer={viewerLogin} />
                  </div>
                )}
                <div className="border-t border-border/50 p-2">
                  <Textarea
                    value={draft}
                    onChange={(e) => onDraftChange(comment.id, e.target.value)}
                    placeholder="Reply..."
                    className="min-h-16 resize-y text-sm"
                    disabled={submitting}
                  />
                  <div className="mt-2 flex justify-end">
                    <Button size="sm" disabled={submitting || !draft.trim()} onClick={() => onSubmitReply(comment.id)}>
                      {submitting ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <MessageSquare className="mr-2 size-3.5" />}
                      Reply
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Conversation({
  path,
  caps,
  comments,
  loading,
  error,
  draft,
  submitting,
  viewerLogin,
  onEdit,
  onDelete,
  onDraftChange,
  onSubmit,
  onRetry,
}: {
  path: string;
  caps: ProviderCaps;
  comments?: GitHubComment[];
  loading: boolean;
  error?: string;
  draft: string;
  submitting: boolean;
  viewerLogin: string;
  onEdit: (commentId: number, body: string) => Promise<void>;
  onDelete: (commentId: number) => Promise<void>;
  onDraftChange: (body: string) => void;
  onSubmit: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="mt-3 border-t border-border/60 pt-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <MessageSquare className="size-3.5" />
          Conversation
        </div>
        {comments && (
          <div className="text-[11px] text-muted-foreground">
            {comments.length} {comments.length === 1 ? "comment" : "comments"}
          </div>
        )}
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 rounded-md border border-border/60 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading comments...
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-border/60 py-6 text-center text-sm text-rose-400">
          <div className="flex items-center gap-2">
            <AlertCircle className="size-4" /> {error}
          </div>
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}

      {!loading && !error && comments && (
        <div className="flex flex-col gap-2">
          {comments.length === 0 ? (
            <div className="rounded-md border border-border/60 px-3 py-6 text-center text-sm text-muted-foreground">
              No comments yet.
            </div>
          ) : (
            comments.map((comment) => (
              <CommentBlock
                key={comment.id}
                path={path}
                caps={caps}
                comment={comment}
                viewerLogin={viewerLogin}
                canModify={!!viewerLogin && comment.author?.login === viewerLogin}
                onEdit={(body) => onEdit(comment.id, body)}
                onDelete={() => onDelete(comment.id)}
              />
            ))
          )}
        </div>
      )}

      <div className="mt-3 rounded-md border border-border/60 bg-card p-2">
        <Textarea
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder="Add a comment..."
          className="min-h-24 resize-y border-0 px-2 shadow-none focus-visible:ring-0"
          disabled={submitting}
        />
        <div className="mt-2 flex justify-end">
          <Button
            size="sm"
            onClick={onSubmit}
            disabled={submitting || draft.trim().length === 0}
          >
            {submitting ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <MessageSquare className="mr-2 size-3.5" />}
            Comment
          </Button>
        </div>
      </div>
    </div>
  );
}

function CommentBlock({
  path,
  caps,
  comment,
  viewerLogin,
  canModify,
  onEdit,
  onDelete,
}: {
  path: string;
  caps: ProviderCaps;
  comment: GitHubComment;
  viewerLogin: string;
  canModify: boolean;
  onEdit: (body: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-card">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/50 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{comment.author?.login ?? "unknown"}</span>
        <span>commented {fmtDate(comment.createdAt)}</span>
        {comment.updatedAt && comment.updatedAt !== comment.createdAt && <span>edited {fmtDate(comment.updatedAt)}</span>}
      </div>
      <EditableCommentBody body={comment.body} canModify={canModify} onEdit={onEdit} onDelete={onDelete} />
      {caps.reactions && (
        <div className="px-3 pb-2">
          <Reactions path={path} subject={{ type: "issueComment", id: comment.id }} viewer={viewerLogin} />
        </div>
      )}
    </div>
  );
}

/** Renders a comment's markdown body, with inline Edit + confirm-Delete controls
 *  when the viewer owns it. `onEdit`/`onDelete` reject on failure; the parent
 *  updates/removes the comment from its list on success (which unmounts on delete). */
function EditableCommentBody({
  body,
  canModify,
  onEdit,
  onDelete,
  suggestion,
}: {
  body: string;
  canModify: boolean;
  onEdit: (body: string) => Promise<void>;
  onDelete: () => Promise<void>;
  /** When set, `body` contains at least one ```suggestion fence — renders it as
   *  a distinct "Suggested change" block instead of a plain code block, with an
   *  Apply button when `canApply`. Undefined when the comment has no suggestion,
   *  or the caller doesn't support applying one (e.g. conversation comments).
   *  `canApply` gates whether the control renders at all (unauthenticated / PR
   *  closed — structural, not push-related); `canPush` (F13) only disables the
   *  visible button with a tooltip, per the show-but-disable gating rule. */
  suggestion?: { canApply: boolean; canPush: boolean; applying: boolean; onApply: () => void };
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  const [busy, setBusy] = useState<null | "save" | "delete">(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const next = draft.trim();
    if (!next || busy) return;
    setBusy("save");
    setError(null);
    try {
      await onEdit(next);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const del = async () => {
    if (busy) return;
    setBusy("delete");
    setError(null);
    try {
      await onDelete();
      // success unmounts this block (parent removes the comment)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
      setConfirmDelete(false);
    }
  };

  if (editing) {
    return (
      <div className="px-3 py-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="min-h-20 resize-y text-sm"
          disabled={busy === "save"}
        />
        {error && (
          <div className="mt-2 flex items-center gap-1 text-xs text-rose-400">
            <AlertCircle className="size-3.5" />
            {error}
          </div>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={busy === "save"} onClick={() => { setEditing(false); setDraft(body); setError(null); }}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy === "save" || !draft.trim()} onClick={() => { void save(); }}>
            {busy === "save" ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <FilePen className="mr-2 size-3.5" />}
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-3 py-2 text-sm">
      {body ? (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={suggestion ? {
            code({ className, children }) {
              if (typeof className === "string" && /language-suggestion/.test(className)) {
                return (
                  <span className="my-2 block overflow-hidden rounded-md border border-emerald-500/40 bg-emerald-500/10">
                    <span className="flex items-center justify-between gap-2 border-b border-emerald-500/30 px-2 py-1">
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-400">
                        <Sparkles className="size-3" />
                        Suggested change
                      </span>
                      {suggestion.canApply && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11px]"
                          disabled={suggestion.applying || !suggestion.canPush}
                          title={suggestion.canPush ? undefined : PUSH_ONLY_TITLE}
                          onClick={() => suggestion.onApply()}
                        >
                          {suggestion.applying
                            ? <Loader2 className="mr-1 size-3 animate-spin" />
                            : <CheckCircle2 className="mr-1 size-3" />}
                          Apply
                        </Button>
                      )}
                    </span>
                    <span className="block overflow-x-auto whitespace-pre px-3 py-2 font-mono text-xs">
                      {children}
                    </span>
                  </span>
                );
              }
              return <code className={className}>{children}</code>;
            },
          } : undefined}
        >
          {body}
        </ReactMarkdown>
      ) : (
        <span className="italic text-muted-foreground">Empty comment.</span>
      )}
      {error && (
        <div className="mt-2 flex items-center gap-1 text-xs text-rose-400">
          <AlertCircle className="size-3.5" />
          {error}
        </div>
      )}
      {canModify && (
        <div className="mt-2 flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            disabled={!!busy}
            onClick={() => { setDraft(body); setEditing(true); setError(null); }}
          >
            <FilePen className="mr-1 size-3" />
            Edit
          </Button>
          {confirmDelete ? (
            <>
              <span className="text-[11px] text-muted-foreground">Delete this comment?</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px] text-rose-400"
                disabled={busy === "delete"}
                onClick={() => { void del(); }}
              >
                {busy === "delete" ? <Loader2 className="mr-1 size-3 animate-spin" /> : <XCircle className="mr-1 size-3" />}
                Confirm
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                disabled={busy === "delete"}
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px] text-muted-foreground hover:text-rose-400"
              disabled={!!busy}
              onClick={() => setConfirmDelete(true)}
            >
              <XCircle className="mr-1 size-3" />
              Delete
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// Fixed render order for both the picker and the resulting chips — mirrors
// `REACTION_CONTENT_ORDER` in src/bun/github.ts (kept as a separate literal
// here since api.ts only re-exports types, not backend consts).
const REACTION_CONTENTS: GitHubReactionContent[] = [
  "+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes",
];
const REACTION_EMOJI: Record<GitHubReactionContent, string> = {
  "+1": "👍",
  "-1": "👎",
  laugh: "😄",
  hooray: "🎉",
  confused: "😕",
  heart: "❤️",
  rocket: "🚀",
  eyes: "👀",
};
const REACTION_LABEL: Record<GitHubReactionContent, string> = {
  "+1": "thumbs up",
  "-1": "thumbs down",
  laugh: "laugh",
  hooray: "hooray",
  confused: "confused",
  heart: "heart",
  rocket: "rocket",
  eyes: "eyes",
};

/** Reaction chips (👍 👎 😄 🎉 😕 ❤️ 🚀 👀) for an issue/PR or a comment, plus a
 *  "+" picker to add one. Self-contained: fetches its own list lazily on mount
 *  (i.e. whenever the parent renders it — the parent panels already gate that on
 *  "row expanded" / "comments loaded"), tracks its own busy/error state, and
 *  guards the fetch with its own request-seq ref, mirroring the other panels'
 *  pattern for their own per-item fetches. Clicking a highlighted (viewer-owned)
 *  chip removes the reaction; clicking the picker adds one — both optimistic. */
function Reactions({
  path,
  subject,
  viewer,
}: {
  path: string;
  subject: GitHubReactionSubject;
  viewer: string;
}) {
  const [reactions, setReactions] = useState<GitHubReactionSummary[] | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<GitHubReactionContent | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const seq = useRef(0);
  const subjectKey = `${subject.type}:${subject.id}`;

  useEffect(() => {
    if (!path) return;
    const requestId = ++seq.current;
    setLoading(true);
    setError(null);
    api.listGitHubReactions({ path, subject, viewer })
      .then((payload) => {
        if (requestId !== seq.current) return;
        setReactions(payload.reactions);
      })
      .catch((e: unknown) => {
        if (requestId !== seq.current) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (requestId !== seq.current) return;
        setLoading(false);
      });
    // `subject`/`viewer` are re-derived from `subjectKey`/`viewer` below; the
    // subject object identity changes every render, so we key off its
    // primitive fields instead to avoid re-fetching in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, subjectKey, viewer]);

  // Keep optimistic inserts in the same fixed order the backend returns.
  const sortReactions = (list: GitHubReactionSummary[]) =>
    [...list].sort((a, b) => REACTION_CONTENTS.indexOf(a.content) - REACTION_CONTENTS.indexOf(b.content));

  const add = async (content: GitHubReactionContent) => {
    // Don't mutate before the first list load resolves — an in-flight GET would
    // otherwise clobber the optimistic entry (or drop peers' reactions).
    if (busy || !path || reactions === undefined) return;
    setBusy(content);
    setPickerOpen(false);
    setError(null);
    // Bump the seq so the (already-resolved) fetch effect can't overwrite us.
    seq.current++;
    setReactions((cur) => {
      const list = cur ?? [];
      const existing = list.find((r) => r.content === content);
      return existing
        ? list.map((r) => (r.content === content ? { ...r, count: r.count + 1 } : r))
        : sortReactions([...list, { content, count: 1, viewerReactionId: null }]);
    });
    try {
      const res = await api.addGitHubReaction({ path, subject, content });
      setReactions((cur) => (cur ?? []).map((r) => (r.content === content ? { ...r, viewerReactionId: res.reactionId } : r)));
    } catch (e) {
      setReactions((cur) => (cur ?? [])
        .map((r) => (r.content === content ? { ...r, count: Math.max(0, r.count - 1) } : r))
        .filter((r) => r.count > 0));
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (summary: GitHubReactionSummary) => {
    if (busy || !path || summary.viewerReactionId == null) return;
    const reactionId = summary.viewerReactionId;
    setBusy(summary.content);
    setPickerOpen(false);
    setError(null);
    seq.current++;
    setReactions((cur) => (cur ?? [])
      .map((r) => (r.content === summary.content ? { ...r, count: Math.max(0, r.count - 1), viewerReactionId: null } : r))
      .filter((r) => r.count > 0));
    try {
      await api.removeGitHubReaction({ path, subject, reactionId });
    } catch (e) {
      setReactions((cur) => {
        const list = cur ?? [];
        const existing = list.find((r) => r.content === summary.content);
        return existing
          ? list.map((r) => (r.content === summary.content ? { ...r, count: r.count + 1, viewerReactionId: reactionId } : r))
          : sortReactions([...list, { ...summary }]);
      });
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // Picker click mirrors the chip: toggle off if the viewer already owns it.
  const toggle = (content: GitHubReactionContent) => {
    const existing = (reactions ?? []).find((r) => r.content === content);
    if (existing?.viewerReactionId != null) void remove(existing);
    else void add(content);
  };

  const owns = (content: GitHubReactionContent) =>
    (reactions ?? []).some((r) => r.content === content && r.viewerReactionId != null);

  const visible = (reactions ?? []).filter((r) => r.count > 0);

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1" onMouseLeave={() => setPickerOpen(false)}>
      {loading && reactions === undefined && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
      {visible.map((r) => (
        <button
          key={r.content}
          type="button"
          disabled={busy === r.content}
          title={REACTION_LABEL[r.content]}
          onClick={() => { void (r.viewerReactionId != null ? remove(r) : add(r.content)); }}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs leading-none",
            r.viewerReactionId != null
              ? "border-primary/60 bg-primary/10 text-foreground"
              : "border-border/60 text-muted-foreground hover:bg-accent",
          )}
        >
          <span>{REACTION_EMOJI[r.content]}</span>
          <span>{r.count}</span>
        </button>
      ))}
      <div className="relative">
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          title="Add reaction"
          aria-label="Add reaction"
          disabled={!!busy || reactions === undefined}
          onClick={() => setPickerOpen((cur) => !cur)}
        >
          <Plus className="size-3.5" />
        </Button>
        {pickerOpen && (
          <div className="absolute left-0 top-7 z-10 flex gap-0.5 rounded-md border border-border/60 bg-popover p-1 shadow-md">
            {REACTION_CONTENTS.map((content) => (
              <button
                key={content}
                type="button"
                title={REACTION_LABEL[content]}
                disabled={busy === content}
                onClick={() => toggle(content)}
                className={cn(
                  "rounded px-1 py-0.5 text-sm hover:bg-accent",
                  owns(content) && "bg-primary/15 ring-1 ring-primary/50",
                )}
              >
                {REACTION_EMOJI[content]}
              </button>
            ))}
          </div>
        )}
      </div>
      {error && (
        <span className="text-[11px] text-rose-400" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}

function DiffFileBlock({
  file,
  onLineComment,
  onAddToReview,
  queuedKeys,
  allowBatchReview,
}: {
  file: DiffFile;
  onLineComment: (target: LineCommentTarget) => Promise<void>;
  onAddToReview: (target: LineCommentTarget) => void;
  queuedKeys: Set<string>;
  allowBatchReview: boolean;
}) {
  const meta = STATUS_META[file.status];
  const Icon = meta.icon;
  const bodyId = `diff-file-${file.path}`;
  const [open, setOpen] = useState(true);
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className="sticky top-0 z-10 bg-background">
        <button
          type="button"
          className="flex w-full select-text items-center gap-2 bg-muted/40 px-2 py-1.5 text-left"
          onClick={() => {
            if (window.getSelection()?.toString()) return;
            setOpen((cur) => !cur);
          }}
          aria-expanded={open}
          aria-controls={bodyId}
        >
          {open ? (
            <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <Icon className={cn("size-3.5 shrink-0", meta.cls)} />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {file.oldPath && <span className="text-muted-foreground">{file.oldPath} -&gt; </span>}
            {file.path}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {file.binary ? "binary" : <><span className="text-emerald-400">+{file.additions}</span> <span className="text-rose-400">-{file.deletions}</span></>}
          </span>
        </button>
      </div>
      {open && (
        <div id={bodyId}>
          {file.binary ? (
            <div className="px-3 py-2 text-xs italic text-muted-foreground">Binary file, no textual diff.</div>
          ) : (
            <>
              <DiffBody file={file} hunks={file.hunks} onLineComment={onLineComment} onAddToReview={onAddToReview} queuedKeys={queuedKeys} allowBatchReview={allowBatchReview} />
              {file.truncated && (
                <div className="border-t border-border/60 px-3 py-1.5 text-[11px] italic text-muted-foreground">
                  Diff truncated because this file's changes are too large to display in full.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DiffBody({
  file,
  hunks,
  onLineComment,
  onAddToReview,
  queuedKeys,
  allowBatchReview,
}: {
  file: DiffFile;
  hunks: string;
  onLineComment: (target: LineCommentTarget) => Promise<void>;
  onAddToReview: (target: LineCommentTarget) => void;
  queuedKeys: Set<string>;
  allowBatchReview: boolean;
}) {
  const rows = useMemo(() => toRows(hunks), [hunks]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [postedKey, setPostedKey] = useState<string | null>(null);
  // When on, the submitted body is wrapped in a ```suggestion fence — GitHub's
  // "suggested change" syntax. Reset whenever the compose panel closes/reopens
  // so it never silently leaks onto an unrelated comment.
  const [suggestMode, setSuggestMode] = useState(false);

  const commentTarget = (r: DiffRow): Omit<LineCommentTarget, "body"> | null => {
    if (r.kind === "del" && r.old) {
      return { filePath: file.oldPath ?? file.path, line: r.old, side: "LEFT" };
    }
    if ((r.kind === "add" || r.kind === "ctx") && r.neu) {
      return { filePath: file.path, line: r.neu, side: "RIGHT" };
    }
    return null;
  };

  const composedBody = () => {
    const raw = draft.trim();
    return suggestMode ? "```suggestion\n" + raw + "\n```" : raw;
  };

  const submit = async (target: Omit<LineCommentTarget, "body">) => {
    const raw = draft.trim();
    if (!raw || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onLineComment({ ...target, body: composedBody() });
      setPostedKey(selectedKey);
      setSelectedKey(null);
      setDraft("");
      setSuggestMode(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const queue = (target: Omit<LineCommentTarget, "body">) => {
    const raw = draft.trim();
    if (!raw || submitting) return;
    onAddToReview({ ...target, body: composedBody() });
    setSelectedKey(null);
    setDraft("");
    setSuggestMode(false);
    setError(null);
  };

  return (
    <div className="overflow-x-auto bg-card font-mono text-xs leading-relaxed">
      {rows.map((r, i) => {
        const target = commentTarget(r);
        const rowKey = `${r.kind}-${r.old ?? ""}-${r.neu ?? ""}-${i}`;
        const selected = selectedKey === rowKey;
        const queued = target ? queuedKeys.has(`${target.filePath}|${target.line}|${target.side}`) : false;
        return (
          <div key={rowKey}>
            <div
              className={cn(
                "group flex",
                r.kind === "add" && "bg-emerald-500/10",
                r.kind === "del" && "bg-rose-500/10",
                r.kind === "hunk" && "bg-sky-500/10 text-sky-300",
                r.kind === "meta" && "text-muted-foreground",
              )}
            >
              <span className="w-10 shrink-0 select-none border-r border-border/40 px-1 text-right text-muted-foreground/60">
                {r.old ?? ""}
              </span>
              <span className="w-10 shrink-0 select-none border-r border-border/40 px-1 text-right text-muted-foreground/60">
                {r.neu ?? ""}
              </span>
              <span
                className={cn(
                  "shrink-0 select-none px-1 text-center",
                  r.kind === "add" && "text-emerald-400",
                  r.kind === "del" && "text-rose-400",
                )}
              >
                {r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre px-1">{r.text || " "}</span>
              {target && (
                <button
                  type="button"
                  className="sticky right-0 hidden shrink-0 items-center bg-card/90 px-1 text-muted-foreground hover:text-foreground group-hover:inline-flex"
                  title="Comment on this line"
                  aria-label="Comment on this line"
                  onClick={() => {
                    setSelectedKey(selected ? null : rowKey);
                    setDraft("");
                    setError(null);
                    setSuggestMode(false);
                  }}
                >
                  <MessageSquare className="size-3.5" />
                </button>
              )}
              {postedKey === rowKey && (
                <span className="sticky right-0 shrink-0 bg-card/90 px-1 text-[11px] text-emerald-400">commented</span>
              )}
              {allowBatchReview && queued && postedKey !== rowKey && (
                <span className="sticky right-0 shrink-0 bg-card/90 px-1 text-[11px] text-sky-400">queued</span>
              )}
            </div>
            {selected && target && (
              <div className="border-y border-border/50 bg-background px-3 py-2 font-sans">
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={suggestMode
                    ? "Proposed replacement text..."
                    : `Comment on ${target.side === "LEFT" ? "old" : "new"} line ${target.line}...`}
                  className="min-h-20 resize-y text-sm font-mono"
                  disabled={submitting}
                />
                <div className="mt-2 flex items-center justify-between gap-2">
                  <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={suggestMode}
                      disabled={submitting}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setSuggestMode(checked);
                        // Pre-fill from the target line's current text so the
                        // user edits from what's already there, not a blank box.
                        if (checked && !draft.trim()) setDraft(r.text);
                      }}
                    />
                    <Sparkles className="size-3.5" />
                    Suggest change
                  </label>
                  {error && (
                    <div className="flex items-center gap-1 text-xs text-rose-400">
                      <AlertCircle className="size-3.5" />
                      {error}
                    </div>
                  )}
                </div>
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={submitting}
                    onClick={() => {
                      setSelectedKey(null);
                      setDraft("");
                      setError(null);
                      setSuggestMode(false);
                    }}
                  >
                    Cancel
                  </Button>
                  {allowBatchReview && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={submitting || !draft.trim()}
                      title="Queue this comment for a single review submission"
                      onClick={() => queue(target)}
                    >
                      <Plus className="mr-2 size-3.5" />
                      Add to review
                    </Button>
                  )}
                  <Button size="sm" disabled={submitting || !draft.trim()} onClick={() => { void submit(target); }}>
                    {submitting ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <MessageSquare className="mr-2 size-3.5" />}
                    Comment
                  </Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
