import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertCircle,
  ArrowUpFromLine,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileMinus,
  FilePen,
  FilePlus,
  FileSymlink,
  GitMerge,
  GitPullRequest,
  Loader2,
  MessageSquare,
  Milestone,
  Plus,
  RefreshCw,
  Search,
  Tag,
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
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { toRows, type DiffRow } from "@/lib/diff-rows";
import { mergeabilityView, type MergeTone } from "@/lib/mergeability";
import type {
  DiffFile,
  GitHubCheckRun,
  GitHubChecksResult,
  GitHubComment,
  GitHubListItem,
  GitHubPullLineComment,
  GitHubPullMergeability,
  GitHubRepoLabel,
  GitHubRepoMilestone,
  GitHubReviewThread,
  Project,
  TaskDiff,
} from "../../../shared/types.ts";

interface Props {
  open: boolean;
  projects: Project[];
  initialProjectPath?: string | null;
  onClose: () => void;
}

const basename = (p: string) => {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
};

const fmtDate = (value: string) => {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(d);
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

export function GitHubDialog({ open, projects, initialProjectPath, onClose }: Props) {
  const [projectPath, setProjectPath] = useState("");
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
  // All repo labels (powers the label datalist + the label manager).
  const [repoLabels, setRepoLabels] = useState<GitHubRepoLabel[]>([]);
  const [labelManagerOpen, setLabelManagerOpen] = useState(false);
  // All repo milestones (powers the milestone manager).
  const [repoMilestones, setRepoMilestones] = useState<GitHubRepoMilestone[]>([]);
  const [milestoneManagerOpen, setMilestoneManagerOpen] = useState(false);
  // The viewer login is token-scoped (identical across projects), so resolve it
  // once per session rather than on every open / project switch. A failed lookup
  // (e.g. the first project has no GitHub remote) leaves it unresolved so a later
  // project with a remote can still fill it in.
  const viewerResolved = useRef(false);
  const requestSeq = useRef(0);
  const diffSeq = useRef(0);
  const commentSeq = useRef(0);
  const reviewCommentSeq = useRef(0);
  const checksSeq = useRef(0);
  const mergeabilitySeq = useRef(0);
  // Bounds the self-healing re-poll when GitHub returns mergeable=null.
  const mergeabilityRetries = useRef<Record<number, number>>({});
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<number, TaskDiff | undefined>>({});
  const [diffLoading, setDiffLoading] = useState<Record<number, boolean | undefined>>({});
  const [diffErrors, setDiffErrors] = useState<Record<number, string | undefined>>({});
  const [checks, setChecks] = useState<Record<number, GitHubChecksResult | undefined>>({});
  const [checksLoading, setChecksLoading] = useState<Record<number, boolean | undefined>>({});
  const [checksErrors, setChecksErrors] = useState<Record<number, string | undefined>>({});
  const [mergeability, setMergeability] = useState<Record<number, GitHubPullMergeability | undefined>>({});
  const [mergeabilityLoading, setMergeabilityLoading] = useState<Record<number, boolean | undefined>>({});
  const [mergeabilityErrors, setMergeabilityErrors] = useState<Record<number, string | undefined>>({});
  const [comments, setComments] = useState<Record<number, GitHubComment[] | undefined>>({});
  const [commentsLoading, setCommentsLoading] = useState<Record<number, boolean | undefined>>({});
  const [commentErrors, setCommentErrors] = useState<Record<number, string | undefined>>({});
  const [commentDrafts, setCommentDrafts] = useState<Record<number, string | undefined>>({});
  const [commentSubmitting, setCommentSubmitting] = useState<Record<number, boolean | undefined>>({});
  const [reviewComments, setReviewComments] = useState<Record<number, GitHubPullLineComment[] | undefined>>({});
  // Resolvable review-comment threads (GraphQL), keyed by PR number; matched to
  // the flat review-comments list via each thread's rootCommentId.
  const [reviewThreads, setReviewThreads] = useState<Record<number, GitHubReviewThread[] | undefined>>({});
  // True when a PR has more than the first 100 review threads (resolve controls
  // then only cover the first page).
  const [reviewThreadsTruncated, setReviewThreadsTruncated] = useState<Record<number, boolean | undefined>>({});
  const [reviewCommentsLoading, setReviewCommentsLoading] = useState<Record<number, boolean | undefined>>({});
  const [reviewCommentErrors, setReviewCommentErrors] = useState<Record<number, string | undefined>>({});
  const [reviewReplyDrafts, setReviewReplyDrafts] = useState<Record<number, string | undefined>>({});
  const [reviewReplySubmitting, setReviewReplySubmitting] = useState<Record<number, boolean | undefined>>({});
  const [reviewDrafts, setReviewDrafts] = useState<Record<number, string | undefined>>({});
  // Inline comments queued for the next review submission (the "pending review"
  // batched flow), keyed by PR number.
  const [pendingReview, setPendingReview] = useState<Record<number, LineCommentTarget[] | undefined>>({});
  // True when the diff was invalidated (refreshed / branch updated) after comments
  // were queued — their line numbers may no longer match, so warn before submit.
  const [pendingStale, setPendingStale] = useState<Record<number, boolean | undefined>>({});
  const [closeDrafts, setCloseDrafts] = useState<Record<number, string | undefined>>({});
  const [mergeMethods, setMergeMethods] = useState<Record<number, GitHubPullMergeMethod | undefined>>({});
  const [labelDrafts, setLabelDrafts] = useState<Record<number, string | undefined>>({});
  const [assigneeDrafts, setAssigneeDrafts] = useState<Record<number, string | undefined>>({});
  const [milestoneDrafts, setMilestoneDrafts] = useState<Record<number, string | undefined>>({});
  const [reviewerDrafts, setReviewerDrafts] = useState<Record<number, string | undefined>>({});
  const [editorOpen, setEditorOpen] = useState<Record<number, boolean | undefined>>({});
  const [titleDrafts, setTitleDrafts] = useState<Record<number, string | undefined>>({});
  const [bodyDrafts, setBodyDrafts] = useState<Record<number, string | undefined>>({});
  const [actionBusy, setActionBusy] = useState<Record<number, string | undefined>>({});
  const [actionErrors, setActionErrors] = useState<Record<number, string | undefined>>({});
  const [actionMessages, setActionMessages] = useState<Record<number, string | undefined>>({});
  // Which panel triggered the last action, so its error/message renders next to
  // the control the user used ("actions" | "triage" | "edit"), not in a sibling.
  const [actionSource, setActionSource] = useState<Record<number, string | undefined>>({});
  const [issueComposerOpen, setIssueComposerOpen] = useState(false);
  const [newIssueTitle, setNewIssueTitle] = useState("");
  const [newIssueBody, setNewIssueBody] = useState("");
  const [newIssueLabels, setNewIssueLabels] = useState("");
  const [newIssueAssignees, setNewIssueAssignees] = useState("");
  const [newIssueMilestone, setNewIssueMilestone] = useState("");
  const [newIssueSubmitting, setNewIssueSubmitting] = useState(false);
  const [newIssueError, setNewIssueError] = useState<string | null>(null);
  const [pullComposerOpen, setPullComposerOpen] = useState(false);
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

  useEffect(() => {
    if (!open) return;
    setProjectPath((cur) => {
      if (initialProjectPath) return initialProjectPath;
      if (cur) return cur;
      return projects[0]?.path ?? "";
    });
  }, [open, initialProjectPath, projects]);

  const load = async (requestId = ++requestSeq.current) => {
    if (!projectPath) return;
    if (requestId !== requestSeq.current) return;
    setLoading(true);
    setError(null);
    try {
      const next = await api.listGitHubItems({
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
      });
      if (requestId !== requestSeq.current) return;
      setResult(next);
    } catch (e) {
      if (requestId !== requestSeq.current) return;
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestId === requestSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    const requestId = ++requestSeq.current;
    if (!open || !projectPath) {
      setLoading(false);
      return;
    }
    const t = setTimeout(() => { void load(requestId); }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectPath, kind, state, effectiveQuery, searchSyntax, labels, assignee, createdByMe, assignedToMe, reviewRequested]);

  useEffect(() => {
    diffSeq.current += 1;
    checksSeq.current += 1;
    mergeabilitySeq.current += 1;
    reviewCommentSeq.current += 1;
    setExpandedKey(null);
    setDiffs({});
    setDiffLoading({});
    setDiffErrors({});
    setChecks({});
    setChecksLoading({});
    setChecksErrors({});
    setMergeability({});
    setMergeabilityLoading({});
    setMergeabilityErrors({});
    mergeabilityRetries.current = {};
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
    setReviewDrafts({});
    setPendingReview({});
    setPendingStale({});
    setCloseDrafts({});
    setMergeMethods({});
    setLabelDrafts({});
    setAssigneeDrafts({});
    setMilestoneDrafts({});
    setReviewerDrafts({});
    setEditorOpen({});
    setTitleDrafts({});
    setBodyDrafts({});
    setActionBusy({});
    setActionErrors({});
    setActionMessages({});
    setActionSource({});
  }, [projectPath, kind, state, effectiveQuery, searchSyntax, labels, assignee, createdByMe, assignedToMe, reviewRequested]);

  // "Review requested" is a PR-only qualifier — drop it when viewing issues.
  useEffect(() => {
    if (kind !== "pulls") setReviewRequested(false);
  }, [kind]);

  useEffect(() => {
    setIssueComposerOpen(false);
    setNewIssueTitle("");
    setNewIssueBody("");
    setNewIssueLabels("");
    setNewIssueAssignees("");
    setNewIssueMilestone("");
    setNewIssueSubmitting(false);
    setNewIssueError(null);
    setPullComposerOpen(false);
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
  }, [projectPath, kind]);

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
    if (projectPath && !opts.some((p) => p.path === projectPath)) {
      opts.unshift({ path: projectPath, label: basename(projectPath) || projectPath });
    }
    return opts;
  }, [projects, projectPath]);

  const expandedItem = useMemo(() => {
    if (!expandedKey) return null;
    return result?.items.find((item) => `${item.kind}-${item.number}` === expandedKey) ?? null;
  }, [expandedKey, result]);

  useEffect(() => {
    if (!open || !projectPath || viewerResolved.current) return;
    let cancelled = false;
    api.getGitHubViewer({ path: projectPath })
      .then((r) => { if (!cancelled) { setViewerLogin(r.login); viewerResolved.current = true; } })
      // Leave unresolved on failure (e.g. no remote) so a later project retries.
      .catch(() => { /* keep the current (empty) login */ });
    return () => { cancelled = true; };
  }, [open, projectPath]);

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
    if (!open || !projectPath) { setRepoLabels([]); return; }
    let cancelled = false;
    api.listGitHubLabels({ path: projectPath })
      .then((r) => { if (!cancelled) setRepoLabels(r.labels); })
      .catch(() => { if (!cancelled) setRepoLabels([]); });
    return () => { cancelled = true; };
  }, [open, projectPath]);

  const refreshRepoMilestones = async () => {
    if (!projectPath) return;
    try {
      const r = await api.listGitHubMilestones({ path: projectPath });
      setRepoMilestones(r.milestones);
    } catch {
      // Milestones are convenience (manager only); ignore fetch failures.
    }
  };

  // Sort open milestones before closed, then by due date (undated last), then title.
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
    if (!open || !projectPath) { setRepoMilestones([]); return; }
    let cancelled = false;
    api.listGitHubMilestones({ path: projectPath })
      .then((r) => { if (!cancelled) setRepoMilestones(r.milestones); })
      .catch(() => { if (!cancelled) setRepoMilestones([]); });
    return () => { cancelled = true; };
  }, [open, projectPath]);

  useEffect(() => {
    if (!open || !projectPath || kind !== "pulls") return;
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
  }, [open, projectPath, kind]);

  useEffect(() => {
    if (!open || !projectPath || !expandedItem || expandedItem.kind !== "pulls") return;
    const number = expandedItem.number;
    if (diffs[number] || diffLoading[number] || diffErrors[number]) return;

    const requestId = ++diffSeq.current;
    setDiffLoading((cur) => ({ ...cur, [number]: true }));
    setDiffErrors((cur) => ({ ...cur, [number]: undefined }));
    api.getGitHubPullDiff({ path: projectPath, number })
      .then((diff) => {
        if (requestId !== diffSeq.current) return;
        setDiffs((cur) => ({ ...cur, [number]: diff }));
      })
      .catch((e: unknown) => {
        if (requestId !== diffSeq.current) return;
        setDiffErrors((cur) => ({ ...cur, [number]: e instanceof Error ? e.message : String(e) }));
      })
      .finally(() => {
        if (requestId !== diffSeq.current) return;
        setDiffLoading((cur) => ({ ...cur, [number]: false }));
      });
  }, [open, projectPath, expandedItem, diffs, diffLoading, diffErrors]);

  useEffect(() => {
    if (!open || !projectPath || !expandedItem || expandedItem.kind !== "pulls") return;
    const number = expandedItem.number;
    if (checks[number] || checksLoading[number] || checksErrors[number]) return;

    const requestId = ++checksSeq.current;
    setChecksLoading((cur) => ({ ...cur, [number]: true }));
    setChecksErrors((cur) => ({ ...cur, [number]: undefined }));
    api.getGitHubPullChecks({ path: projectPath, number })
      .then((payload) => {
        if (requestId !== checksSeq.current) return;
        setChecks((cur) => ({ ...cur, [number]: payload }));
      })
      .catch((e: unknown) => {
        if (requestId !== checksSeq.current) return;
        setChecksErrors((cur) => ({ ...cur, [number]: e instanceof Error ? e.message : String(e) }));
      })
      .finally(() => {
        if (requestId !== checksSeq.current) return;
        setChecksLoading((cur) => ({ ...cur, [number]: false }));
      });
  }, [open, projectPath, expandedItem, checks, checksLoading, checksErrors]);

  useEffect(() => {
    // Only open PRs surface a mergeability verdict — skip closed/merged ones so
    // we don't burn the server-side poll on data the UI never shows.
    if (!open || !projectPath || !expandedItem || expandedItem.kind !== "pulls" || expandedItem.state !== "open") return;
    const number = expandedItem.number;
    if (mergeability[number] || mergeabilityLoading[number] || mergeabilityErrors[number]) return;

    const requestId = ++mergeabilitySeq.current;
    setMergeabilityLoading((cur) => ({ ...cur, [number]: true }));
    setMergeabilityErrors((cur) => ({ ...cur, [number]: undefined }));
    api.getGitHubPullMergeability({ path: projectPath, number })
      .then((payload) => {
        if (requestId !== mergeabilitySeq.current) return;
        setMergeability((cur) => ({ ...cur, [number]: payload }));
        // GitHub may still be computing (`mergeable === null`). Self-heal with a
        // single delayed re-poll rather than making the user hit refresh.
        if (payload.mergeable === null && !payload.merged && (mergeabilityRetries.current[number] ?? 0) < 1) {
          mergeabilityRetries.current[number] = (mergeabilityRetries.current[number] ?? 0) + 1;
          setTimeout(() => {
            if (requestId !== mergeabilitySeq.current) return;
            setMergeability((cur) => ({ ...cur, [number]: undefined }));
            setMergeabilityErrors((cur) => ({ ...cur, [number]: undefined }));
          }, 2_500);
        }
      })
      .catch((e: unknown) => {
        if (requestId !== mergeabilitySeq.current) return;
        setMergeabilityErrors((cur) => ({ ...cur, [number]: e instanceof Error ? e.message : String(e) }));
      })
      .finally(() => {
        if (requestId !== mergeabilitySeq.current) return;
        setMergeabilityLoading((cur) => ({ ...cur, [number]: false }));
      });
  }, [open, projectPath, expandedItem, mergeability, mergeabilityLoading, mergeabilityErrors]);

  useEffect(() => {
    if (!open || !projectPath || !expandedItem) return;
    const number = expandedItem.number;
    if (comments[number] || commentsLoading[number] || commentErrors[number]) return;

    const requestId = ++commentSeq.current;
    setCommentsLoading((cur) => ({ ...cur, [number]: true }));
    setCommentErrors((cur) => ({ ...cur, [number]: undefined }));
    api.listGitHubComments({ path: projectPath, number })
      .then((payload) => {
        if (requestId !== commentSeq.current) return;
        setComments((cur) => ({ ...cur, [number]: payload.comments }));
      })
      .catch((e: unknown) => {
        if (requestId !== commentSeq.current) return;
        setCommentErrors((cur) => ({ ...cur, [number]: e instanceof Error ? e.message : String(e) }));
      })
      .finally(() => {
        if (requestId !== commentSeq.current) return;
        setCommentsLoading((cur) => ({ ...cur, [number]: false }));
      });
  }, [open, projectPath, expandedItem, comments, commentsLoading, commentErrors]);

  useEffect(() => {
    if (!open || !projectPath || !expandedItem || expandedItem.kind !== "pulls") return;
    const number = expandedItem.number;
    if (reviewComments[number] || reviewCommentsLoading[number] || reviewCommentErrors[number]) return;

    const requestId = ++reviewCommentSeq.current;
    setReviewCommentsLoading((cur) => ({ ...cur, [number]: true }));
    setReviewCommentErrors((cur) => ({ ...cur, [number]: undefined }));
    Promise.all([
      api.listGitHubPullReviewComments({ path: projectPath, number }),
      // Threads are supplementary (resolve controls) — degrade to none on failure.
      api.getGitHubPullReviewThreads({ path: projectPath, number })
        .catch(() => ({ threads: [] as GitHubReviewThread[], truncated: false })),
    ])
      .then(([commentsPayload, threadsPayload]) => {
        if (requestId !== reviewCommentSeq.current) return;
        setReviewComments((cur) => ({ ...cur, [number]: commentsPayload.comments }));
        setReviewThreads((cur) => ({ ...cur, [number]: threadsPayload.threads }));
        setReviewThreadsTruncated((cur) => ({ ...cur, [number]: threadsPayload.truncated }));
      })
      .catch((e: unknown) => {
        if (requestId !== reviewCommentSeq.current) return;
        setReviewCommentErrors((cur) => ({ ...cur, [number]: e instanceof Error ? e.message : String(e) }));
      })
      .finally(() => {
        if (requestId !== reviewCommentSeq.current) return;
        setReviewCommentsLoading((cur) => ({ ...cur, [number]: false }));
      });
  }, [open, projectPath, expandedItem, reviewComments, reviewCommentsLoading, reviewCommentErrors]);

  const submitComment = async (item: GitHubListItem) => {
    const body = (commentDrafts[item.number] ?? "").trim();
    if (!projectPath || !body || commentSubmitting[item.number]) return;
    setCommentSubmitting((cur) => ({ ...cur, [item.number]: true }));
    setCommentErrors((cur) => ({ ...cur, [item.number]: undefined }));
    try {
      const { comment } = await api.createGitHubComment({ path: projectPath, number: item.number, body });
      setComments((cur) => ({ ...cur, [item.number]: [...(cur[item.number] ?? []), comment] }));
      setCommentDrafts((cur) => ({ ...cur, [item.number]: "" }));
    } catch (e) {
      setCommentErrors((cur) => ({ ...cur, [item.number]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setCommentSubmitting((cur) => ({ ...cur, [item.number]: false }));
    }
  };

  const submitLineComment = async (item: GitHubListItem, target: LineCommentTarget) => {
    if (!projectPath || item.kind !== "pulls") return;
    const { comment } = await api.createGitHubPullLineComment({
      path: projectPath,
      number: item.number,
      body: target.body,
      filePath: target.filePath,
      line: target.line,
      side: target.side,
    });
    setReviewComments((cur) => ({ ...cur, [item.number]: [...(cur[item.number] ?? []), comment] }));
    setReviewCommentErrors((cur) => ({ ...cur, [item.number]: undefined }));
  };

  const submitReviewReply = async (item: GitHubListItem, commentId: number) => {
    const body = (reviewReplyDrafts[commentId] ?? "").trim();
    if (!projectPath || item.kind !== "pulls" || !body || reviewReplySubmitting[commentId]) return;
    setReviewReplySubmitting((cur) => ({ ...cur, [commentId]: true }));
    setReviewCommentErrors((cur) => ({ ...cur, [item.number]: undefined }));
    try {
      const { comment } = await api.replyGitHubPullLineComment({
        path: projectPath,
        number: item.number,
        commentId,
        body,
      });
      setReviewComments((cur) => ({ ...cur, [item.number]: [...(cur[item.number] ?? []), comment] }));
      setReviewReplyDrafts((cur) => ({ ...cur, [commentId]: "" }));
    } catch (e) {
      setReviewCommentErrors((cur) => ({ ...cur, [item.number]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setReviewReplySubmitting((cur) => ({ ...cur, [commentId]: false }));
    }
  };

  const editConversationComment = async (item: GitHubListItem, commentId: number, body: string) => {
    if (!projectPath) throw new Error("no project selected");
    const { comment } = await api.updateGitHubComment({ path: projectPath, commentId, kind: "issue", body });
    setComments((cur) => ({
      ...cur,
      [item.number]: (cur[item.number] ?? []).map((c) => (c.id === commentId ? comment : c)),
    }));
  };

  const deleteConversationComment = async (item: GitHubListItem, commentId: number) => {
    if (!projectPath) throw new Error("no project selected");
    await api.deleteGitHubComment({ path: projectPath, commentId, kind: "issue" });
    setComments((cur) => ({
      ...cur,
      [item.number]: (cur[item.number] ?? []).filter((c) => c.id !== commentId),
    }));
  };

  const editReviewComment = async (item: GitHubListItem, commentId: number, body: string) => {
    if (!projectPath) throw new Error("no project selected");
    const { comment } = await api.updateGitHubComment({ path: projectPath, commentId, kind: "review", body });
    // Keep the line-comment's path/line/side; only body + updatedAt change.
    setReviewComments((cur) => ({
      ...cur,
      [item.number]: (cur[item.number] ?? []).map((c) =>
        c.id === commentId ? { ...c, body: comment.body, updatedAt: comment.updatedAt } : c,
      ),
    }));
  };

  const deleteReviewComment = async (item: GitHubListItem, commentId: number) => {
    if (!projectPath) throw new Error("no project selected");
    await api.deleteGitHubComment({ path: projectPath, commentId, kind: "review" });
    setReviewComments((cur) => ({
      ...cur,
      [item.number]: (cur[item.number] ?? []).filter((c) => c.id !== commentId),
    }));
  };

  const toggleThreadResolved = async (item: GitHubListItem, thread: GitHubReviewThread) => {
    if (!projectPath) throw new Error("no project selected");
    const result = await api.setGitHubReviewThreadResolved({
      path: projectPath,
      threadId: thread.threadId,
      resolved: !thread.isResolved,
    });
    setReviewThreads((cur) => ({
      ...cur,
      [item.number]: (cur[item.number] ?? []).map((t) =>
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

  const markPullClosed = (number: number, replacement?: GitHubListItem) => {
    setResult((cur) => {
      if (!cur) return cur;
      let found = false;
      const items = cur.items.flatMap((item) => {
        if (item.kind !== "pulls" || item.number !== number) return [item];
        found = true;
        const next = replacement ?? { ...item, state: "closed" as const, closedAt: new Date().toISOString() };
        return itemMatchesActiveFilters(next) ? [next] : [];
      });
      return {
        ...cur,
        items: found ? items : cur.items,
      };
    });
  };

  const runPullReview = async (item: GitHubListItem, event: GitHubPullReviewEvent) => {
    const body = (reviewDrafts[item.number] ?? "").trim();
    const pending = pendingReview[item.number] ?? [];
    if (!projectPath || actionBusy[item.number]) return;
    // COMMENT/REQUEST_CHANGES need a summary note OR at least one pending inline
    // comment; APPROVE can be empty.
    if (event !== "APPROVE" && !body && pending.length === 0) {
      setActionErrors((cur) => ({
        ...cur,
        [item.number]: event === "COMMENT" ? "A review comment requires a note." : "Request changes requires a comment.",
      }));
      return;
    }
    setActionBusy((cur) => ({ ...cur, [item.number]: event }));
    setActionSource((cur) => ({ ...cur, [item.number]: "actions" }));
    setActionErrors((cur) => ({ ...cur, [item.number]: undefined }));
    setActionMessages((cur) => ({ ...cur, [item.number]: undefined }));
    try {
      const result = await api.reviewGitHubPull({
        path: projectPath,
        number: item.number,
        event,
        body,
        comments: pending.map((c) => ({ path: c.filePath, line: c.line, side: c.side, body: c.body })),
      });
      setActionMessages((cur) => ({
        ...cur,
        [item.number]: result.message ?? (event === "APPROVE"
          ? "Pull request approved."
          : event === "COMMENT" ? "Review submitted." : "Changes requested."),
      }));
      setReviewDrafts((cur) => ({ ...cur, [item.number]: "" }));
      // The pending inline comments were posted with the review — clear them and
      // refetch the review-comments list so they show up.
      if (pending.length > 0) {
        setPendingReview((cur) => ({ ...cur, [item.number]: [] }));
        setPendingStale((cur) => ({ ...cur, [item.number]: false }));
        setReviewComments((cur) => ({ ...cur, [item.number]: undefined }));
        setReviewThreads((cur) => ({ ...cur, [item.number]: undefined }));
        setReviewCommentErrors((cur) => ({ ...cur, [item.number]: undefined }));
      }
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [item.number]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [item.number]: undefined }));
    }
  };

  const addToReview = (item: GitHubListItem, target: LineCommentTarget) => {
    // A comment queued against the current diff starts a fresh (non-stale) queue.
    const wasEmpty = (pendingReview[item.number] ?? []).length === 0;
    setPendingReview((cur) => ({ ...cur, [item.number]: [...(cur[item.number] ?? []), target] }));
    if (wasEmpty) setPendingStale((cur) => ({ ...cur, [item.number]: false }));
  };

  const removePendingReview = (item: GitHubListItem, index: number) => {
    setPendingReview((cur) => ({ ...cur, [item.number]: (cur[item.number] ?? []).filter((_, i) => i !== index) }));
  };

  const runPullMerge = async (item: GitHubListItem) => {
    if (!projectPath || actionBusy[item.number]) return;
    const method = mergeMethods[item.number] ?? "merge";
    setActionBusy((cur) => ({ ...cur, [item.number]: "merge" }));
    setActionSource((cur) => ({ ...cur, [item.number]: "actions" }));
    setActionErrors((cur) => ({ ...cur, [item.number]: undefined }));
    setActionMessages((cur) => ({ ...cur, [item.number]: undefined }));
    try {
      const result = await api.mergeGitHubPull({ path: projectPath, number: item.number, method });
      if (result.merged) markPullClosed(item.number);
      setActionMessages((cur) => ({ ...cur, [item.number]: result.message ?? "Pull request merged." }));
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [item.number]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [item.number]: undefined }));
    }
  };

  const runUpdateBranch = async (item: GitHubListItem) => {
    if (!projectPath || item.kind !== "pulls" || actionBusy[item.number]) return;
    setActionBusy((cur) => ({ ...cur, [item.number]: "update-branch" }));
    setActionSource((cur) => ({ ...cur, [item.number]: "actions" }));
    setActionErrors((cur) => ({ ...cur, [item.number]: undefined }));
    setActionMessages((cur) => ({ ...cur, [item.number]: undefined }));
    try {
      const result = await api.updateGitHubPullBranch({ path: projectPath, number: item.number });
      setActionMessages((cur) => ({ ...cur, [item.number]: result.message ?? "Branch update started." }));
      // update-branch is async (202 Accepted) — GitHub merges the base into the
      // head in the background. Give it a moment before invalidating the caches,
      // otherwise the refetch races the merge and shows a stale "behind" verdict.
      await new Promise((r) => setTimeout(r, 2_000));
      // The head moved, so the cached mergeability, checks, and diff are stale —
      // clear them so their effects refetch against the new head. Reset the
      // mergeability retry budget so it can self-heal on the fresh head.
      mergeabilityRetries.current[item.number] = 0;
      setMergeability((cur) => ({ ...cur, [item.number]: undefined }));
      setMergeabilityErrors((cur) => ({ ...cur, [item.number]: undefined }));
      setChecks((cur) => ({ ...cur, [item.number]: undefined }));
      setChecksErrors((cur) => ({ ...cur, [item.number]: undefined }));
      setDiffs((cur) => ({ ...cur, [item.number]: undefined }));
      setDiffErrors((cur) => ({ ...cur, [item.number]: undefined }));
      // The head moved — any queued review comments now reference stale lines.
      setPendingStale((cur) => ({ ...cur, [item.number]: true }));
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [item.number]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [item.number]: undefined }));
    }
  };

  const runPullClose = async (item: GitHubListItem) => {
    if (!projectPath || actionBusy[item.number]) return;
    const comment = (closeDrafts[item.number] ?? "").trim();
    setActionBusy((cur) => ({ ...cur, [item.number]: "close" }));
    setActionSource((cur) => ({ ...cur, [item.number]: "actions" }));
    setActionErrors((cur) => ({ ...cur, [item.number]: undefined }));
    setActionMessages((cur) => ({ ...cur, [item.number]: undefined }));
    try {
      const result = await api.closeGitHubPull({ path: projectPath, number: item.number, comment });
      markPullClosed(item.number, result.item);
      setActionMessages((cur) => ({ ...cur, [item.number]: result.message ?? "Pull request closed." }));
      setCloseDrafts((cur) => ({ ...cur, [item.number]: "" }));
      if (comment && result.commentPosted !== false) {
        setComments((cur) => ({ ...cur, [item.number]: undefined }));
        setCommentErrors((cur) => ({ ...cur, [item.number]: undefined }));
      }
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [item.number]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [item.number]: undefined }));
    }
  };

  const runReopenPull = async (item: GitHubListItem) => {
    if (!projectPath || item.kind !== "pulls" || actionBusy[item.number]) return;
    setActionBusy((cur) => ({ ...cur, [item.number]: "reopen" }));
    setActionSource((cur) => ({ ...cur, [item.number]: "actions" }));
    setActionErrors((cur) => ({ ...cur, [item.number]: undefined }));
    setActionMessages((cur) => ({ ...cur, [item.number]: undefined }));
    try {
      const result = await api.reopenGitHubPull({ path: projectPath, number: item.number });
      // Keep the row visible even under a "closed" filter so the reopen is
      // legible; it drops out on the next refresh.
      upsertListItem(result.item, false, true);
      setActionMessages((cur) => ({ ...cur, [item.number]: result.message ?? "Pull request reopened." }));
      // Now open again — let the mergeability effect fetch a fresh verdict.
      mergeabilityRetries.current[item.number] = 0;
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [item.number]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [item.number]: undefined }));
    }
  };

  const runToggleDraft = async (item: GitHubListItem) => {
    if (!projectPath || item.kind !== "pulls" || actionBusy[item.number]) return;
    const nextDraft = !item.draft;
    setActionBusy((cur) => ({ ...cur, [item.number]: "draft" }));
    setActionSource((cur) => ({ ...cur, [item.number]: "actions" }));
    setActionErrors((cur) => ({ ...cur, [item.number]: undefined }));
    setActionMessages((cur) => ({ ...cur, [item.number]: undefined }));
    try {
      const result = await api.setGitHubPullDraft({ path: projectPath, number: item.number, draft: nextDraft });
      upsertListItem({ ...item, draft: result.draft });
      setActionMessages((cur) => ({ ...cur, [item.number]: result.message ?? "Draft state updated." }));
      // Draft ↔ ready flips mergeable_state (draft PRs report "draft"), so refresh.
      mergeabilityRetries.current[item.number] = 0;
      setMergeability((cur) => ({ ...cur, [item.number]: undefined }));
      setMergeabilityErrors((cur) => ({ ...cur, [item.number]: undefined }));
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [item.number]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [item.number]: undefined }));
    }
  };

  // `keepIfPresent` updates an existing row in place even when the replacement no
  // longer matches the active filters — used by in-panel state changes (e.g.
  // reopen) so the user sees the result instead of the row silently vanishing;
  // it drops out naturally on the next refresh.
  const upsertListItem = (replacement: GitHubListItem, prepend = false, keepIfPresent = false) => {
    setResult((cur) => {
      if (!cur) return cur;
      const exists = cur.items.some((item) => item.kind === replacement.kind && item.number === replacement.number);
      if (!itemMatchesActiveFilters(replacement) && !(keepIfPresent && exists)) {
        return {
          ...cur,
          items: cur.items.filter((item) => item.kind !== replacement.kind || item.number !== replacement.number),
        };
      }
      return {
        ...cur,
        items: exists
          ? cur.items.map((item) => item.kind === replacement.kind && item.number === replacement.number ? replacement : item)
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
      setIssueComposerOpen(false);
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
      });
      upsertListItem(result.item, true);
      setPullComposerOpen(false);
      setNewPullTitle("");
      setNewPullBody("");
      setNewPullReviewers("");
      setNewPullDraft(false);
      setActionMessages((cur) => ({ ...cur, [result.item.number]: result.message ?? "Pull request created." }));
    } catch (e) {
      setNewPullError(e instanceof Error ? e.message : String(e));
    } finally {
      setNewPullSubmitting(false);
    }
  };

  const updateIssueState = async (item: GitHubListItem, nextState: "open" | "closed") => {
    if (!projectPath || actionBusy[item.number]) return;
    setActionBusy((cur) => ({ ...cur, [item.number]: nextState }));
    setActionSource((cur) => ({ ...cur, [item.number]: "actions" }));
    setActionErrors((cur) => ({ ...cur, [item.number]: undefined }));
    setActionMessages((cur) => ({ ...cur, [item.number]: undefined }));
    try {
      const result = await api.updateGitHubIssue({ path: projectPath, number: item.number, state: nextState });
      upsertListItem(result.item);
      setActionMessages((cur) => ({ ...cur, [item.number]: result.message ?? "Issue updated." }));
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [item.number]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [item.number]: undefined }));
    }
  };

  const updateIssueLabels = async (item: GitHubListItem) => {
    if (!projectPath || actionBusy[item.number]) return;
    const nextLabels = splitLabels(labelDrafts[item.number] ?? item.labels.map((label) => label.name).join(", "));
    const nextAssignees = splitLabels(assigneeDrafts[item.number] ?? item.assignees.map((a) => a.login).join(", "));
    const rawMilestone = milestoneDrafts[item.number] ?? (item.milestone ? String(item.milestone.number) : "");
    const nextMilestone = parseMilestone(rawMilestone);
    if (nextMilestone === null) {
      setActionErrors((cur) => ({ ...cur, [item.number]: "Milestone must be a positive number." }));
      return;
    }
    setActionBusy((cur) => ({ ...cur, [item.number]: "labels" }));
    setActionSource((cur) => ({ ...cur, [item.number]: "triage" }));
    setActionErrors((cur) => ({ ...cur, [item.number]: undefined }));
    setActionMessages((cur) => ({ ...cur, [item.number]: undefined }));
    try {
      const result = await api.updateGitHubIssue({
        path: projectPath,
        number: item.number,
        kind: item.kind,
        labels: nextLabels,
        assignees: nextAssignees,
        milestone: rawMilestone.trim() ? nextMilestone : null,
      });
      // The /issues/:n response drops PR-only fields (e.g. `draft`); keep them
      // from the item we already have so a triage save can't flip the badge.
      upsertListItem(item.kind === "pulls" ? { ...result.item, draft: item.draft } : result.item);
      setLabelDrafts((cur) => ({ ...cur, [item.number]: result.item.labels.map((label) => label.name).join(", ") }));
      setAssigneeDrafts((cur) => ({ ...cur, [item.number]: result.item.assignees.map((a) => a.login).join(", ") }));
      setMilestoneDrafts((cur) => ({ ...cur, [item.number]: result.item.milestone ? String(result.item.milestone.number) : "" }));
      setActionMessages((cur) => ({ ...cur, [item.number]: "Triage updated." }));
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [item.number]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [item.number]: undefined }));
    }
  };

  const saveEdit = async (item: GitHubListItem) => {
    if (!projectPath || actionBusy[item.number]) return;
    const title = (titleDrafts[item.number] ?? item.title).trim();
    const body = bodyDrafts[item.number] ?? item.body;
    if (!title) {
      setActionErrors((cur) => ({ ...cur, [item.number]: "Title cannot be empty." }));
      return;
    }
    setActionBusy((cur) => ({ ...cur, [item.number]: "edit" }));
    setActionSource((cur) => ({ ...cur, [item.number]: "edit" }));
    setActionErrors((cur) => ({ ...cur, [item.number]: undefined }));
    setActionMessages((cur) => ({ ...cur, [item.number]: undefined }));
    try {
      const result = await api.updateGitHubIssue({ path: projectPath, number: item.number, kind: item.kind, title, body });
      upsertListItem(item.kind === "pulls" ? { ...result.item, draft: item.draft } : result.item);
      // Close and discard the drafts so reopening reflects the freshly-saved item.
      setEditorOpen((cur) => ({ ...cur, [item.number]: false }));
      setTitleDrafts((cur) => ({ ...cur, [item.number]: undefined }));
      setBodyDrafts((cur) => ({ ...cur, [item.number]: undefined }));
      setActionMessages((cur) => ({ ...cur, [item.number]: `${item.kind === "pulls" ? "Pull request" : "Issue"} updated.` }));
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [item.number]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [item.number]: undefined }));
    }
  };

  const requestReviewers = async (item: GitHubListItem) => {
    if (!projectPath || item.kind !== "pulls" || actionBusy[item.number]) return;
    const reviewers = splitLabels(reviewerDrafts[item.number] ?? "");
    if (reviewers.length === 0) {
      setActionErrors((cur) => ({ ...cur, [item.number]: "Enter at least one reviewer." }));
      return;
    }
    setActionBusy((cur) => ({ ...cur, [item.number]: "reviewers" }));
    setActionSource((cur) => ({ ...cur, [item.number]: "triage" }));
    setActionErrors((cur) => ({ ...cur, [item.number]: undefined }));
    setActionMessages((cur) => ({ ...cur, [item.number]: undefined }));
    try {
      const result = await api.requestGitHubPullReviewers({ path: projectPath, number: item.number, reviewers });
      setActionMessages((cur) => ({ ...cur, [item.number]: result.message ?? "Reviewers requested." }));
      setReviewerDrafts((cur) => ({ ...cur, [item.number]: "" }));
    } catch (e) {
      setActionErrors((cur) => ({ ...cur, [item.number]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setActionBusy((cur) => ({ ...cur, [item.number]: undefined }));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="github-dialog-title"
      className="flex max-h-[86vh] w-full max-w-5xl flex-col p-0"
    >
      <header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
        <div className="min-w-0">
          <div id="github-dialog-title" className="flex items-center gap-2 text-sm font-semibold">
            <GitPullRequest className="size-4 shrink-0 text-muted-foreground" />
            GitHub
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {result ? (
              <>
                {result.repo}
                {result.auth === "none" && " · unauthenticated"}
              </>
            ) : (
              "Pull requests and issues"
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="icon"
            variant={labelManagerOpen ? "secondary" : "ghost"}
            title="Manage labels"
            aria-label="Manage labels"
            disabled={!projectPath}
            onClick={() => { setLabelManagerOpen((v) => !v); setMilestoneManagerOpen(false); }}
          >
            <Tag className="size-4" />
          </Button>
          <Button
            size="icon"
            variant={milestoneManagerOpen ? "secondary" : "ghost"}
            title="Manage milestones"
            aria-label="Manage milestones"
            disabled={!projectPath}
            onClick={() => { setMilestoneManagerOpen((v) => !v); setLabelManagerOpen(false); }}
          >
            <Milestone className="size-4" />
          </Button>
          {result && (
            <Button
              size="icon"
              variant="ghost"
              title="Open repository on GitHub"
              aria-label="Open repository on GitHub"
              onClick={() => { void api.openExternal(result.webUrl); }}
            >
              <ExternalLink className="size-4" />
            </Button>
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
            PRs
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
        </div>
        <Input
          value={labels}
          onChange={(e) => setLabels(e.target.value)}
          placeholder="Labels, comma separated"
          className="h-8 text-xs"
          list="github-dialog-labels"
        />
        <Input
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          placeholder="Assignee"
          className="h-8 text-xs"
        />
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

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {labelManagerOpen && (
          <LabelManager
            labels={repoLabels}
            authenticated={result?.auth !== "none"}
            onCreate={createLabel}
            onEdit={editLabel}
            onDelete={removeLabel}
            onRefresh={() => { void refreshRepoLabels(); }}
            onClose={() => setLabelManagerOpen(false)}
          />
        )}
        {milestoneManagerOpen && (
          <MilestoneManager
            milestones={repoMilestones}
            authenticated={result?.auth !== "none"}
            onCreate={createMilestone}
            onEdit={editMilestone}
            onDelete={removeMilestone}
            onRefresh={() => { void refreshRepoMilestones(); }}
            onClose={() => setMilestoneManagerOpen(false)}
          />
        )}
        {kind === "pulls" && (
          <PullComposer
            open={pullComposerOpen}
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
            onOpenChange={setPullComposerOpen}
            onTitleChange={setNewPullTitle}
            onBodyChange={setNewPullBody}
            onHeadChange={setNewPullHead}
            onBaseChange={setNewPullBase}
            onReviewersChange={setNewPullReviewers}
            onDraftChange={setNewPullDraft}
            onPushHead={() => { void pushHead(); }}
            onSubmit={() => { void createPull(); }}
          />
        )}

        {kind === "issues" && (
          <IssueComposer
            open={issueComposerOpen}
            title={newIssueTitle}
            body={newIssueBody}
            labels={newIssueLabels}
            assignees={newIssueAssignees}
            milestone={newIssueMilestone}
            submitting={newIssueSubmitting}
            error={newIssueError}
            onOpenChange={setIssueComposerOpen}
            onTitleChange={setNewIssueTitle}
            onBodyChange={setNewIssueBody}
            onLabelsChange={setNewIssueLabels}
            onAssigneesChange={setNewIssueAssignees}
            onMilestoneChange={setNewIssueMilestone}
            onSubmit={() => { void createIssue(); }}
          />
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
            No {kind === "pulls" ? "pull requests" : "issues"} match these filters.
          </div>
        )}

        {result && result.items.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="px-1 text-xs text-muted-foreground">
              {result.items.length} {kind === "pulls" ? "pull requests" : "issues"}
            </div>
            {result.items.map((item) => (
              <GitHubItemRow
                key={`${item.kind}-${item.number}`}
                item={item}
                expanded={expandedKey === `${item.kind}-${item.number}`}
                diff={item.kind === "pulls" ? diffs[item.number] : undefined}
                diffLoading={item.kind === "pulls" ? !!diffLoading[item.number] : false}
                diffError={item.kind === "pulls" ? diffErrors[item.number] : undefined}
                checks={item.kind === "pulls" ? checks[item.number] : undefined}
                checksLoading={item.kind === "pulls" ? !!checksLoading[item.number] : false}
                checksError={item.kind === "pulls" ? checksErrors[item.number] : undefined}
                mergeability={item.kind === "pulls" ? mergeability[item.number] : undefined}
                mergeabilityLoading={item.kind === "pulls" ? !!mergeabilityLoading[item.number] : false}
                mergeabilityError={item.kind === "pulls" ? mergeabilityErrors[item.number] : undefined}
                reviewComments={item.kind === "pulls" ? reviewComments[item.number] : undefined}
                reviewCommentsLoading={item.kind === "pulls" ? !!reviewCommentsLoading[item.number] : false}
                reviewCommentError={item.kind === "pulls" ? reviewCommentErrors[item.number] : undefined}
                reviewReplyDrafts={reviewReplyDrafts}
                reviewReplySubmitting={reviewReplySubmitting}
                comments={comments[item.number]}
                commentsLoading={!!commentsLoading[item.number]}
                commentError={commentErrors[item.number]}
                commentDraft={commentDrafts[item.number] ?? ""}
                commentSubmitting={!!commentSubmitting[item.number]}
                reviewDraft={reviewDrafts[item.number] ?? ""}
                closeDraft={closeDrafts[item.number] ?? ""}
                mergeMethod={mergeMethods[item.number] ?? "merge"}
                actionBusy={actionBusy[item.number]}
                actionError={actionErrors[item.number]}
                actionMessage={actionMessages[item.number]}
                actionSource={actionSource[item.number]}
                labelDraft={labelDrafts[item.number] ?? item.labels.map((label) => label.name).join(", ")}
                assigneeDraft={assigneeDrafts[item.number] ?? item.assignees.map((a) => a.login).join(", ")}
                milestoneDraft={milestoneDrafts[item.number] ?? (item.milestone ? String(item.milestone.number) : "")}
                reviewerDraft={reviewerDrafts[item.number] ?? ""}
                editorOpen={!!editorOpen[item.number]}
                titleDraft={titleDrafts[item.number] ?? item.title}
                bodyDraft={bodyDrafts[item.number] ?? item.body}
                onEditToggle={(next) => {
                  setEditorOpen((cur) => ({ ...cur, [item.number]: next }));
                  if (next) {
                    setTitleDrafts((cur) => ({ ...cur, [item.number]: cur[item.number] ?? item.title }));
                    setBodyDrafts((cur) => ({ ...cur, [item.number]: cur[item.number] ?? item.body }));
                  } else {
                    // Cancel discards the draft so reopening reflects the live item.
                    setTitleDrafts((cur) => ({ ...cur, [item.number]: undefined }));
                    setBodyDrafts((cur) => ({ ...cur, [item.number]: undefined }));
                    setActionErrors((cur) => ({ ...cur, [item.number]: undefined }));
                  }
                }}
                onTitleDraftChange={(body) => setTitleDrafts((cur) => ({ ...cur, [item.number]: body }))}
                onBodyDraftChange={(body) => setBodyDrafts((cur) => ({ ...cur, [item.number]: body }))}
                onSaveEdit={() => { void saveEdit(item); }}
                onReviewerDraftChange={(body) => setReviewerDrafts((cur) => ({ ...cur, [item.number]: body }))}
                onRequestReviewers={() => { void requestReviewers(item); }}
                onReviewDraftChange={(body) => setReviewDrafts((cur) => ({ ...cur, [item.number]: body }))}
                onCloseDraftChange={(body) => setCloseDrafts((cur) => ({ ...cur, [item.number]: body }))}
                onMergeMethodChange={(method) => setMergeMethods((cur) => ({ ...cur, [item.number]: method }))}
                onReview={(event) => { void runPullReview(item, event); }}
                onMerge={() => { void runPullMerge(item); }}
                onUpdateBranch={() => { void runUpdateBranch(item); }}
                onReopenPull={() => { void runReopenPull(item); }}
                onToggleDraft={() => { void runToggleDraft(item); }}
                onClosePull={() => { void runPullClose(item); }}
                pendingReview={item.kind === "pulls" ? (pendingReview[item.number] ?? []) : []}
                pendingStale={item.kind === "pulls" ? !!pendingStale[item.number] : false}
                onAddToReview={(target) => addToReview(item, target)}
                onRemovePendingReview={(index) => removePendingReview(item, index)}
                onLineComment={(target) => submitLineComment(item, target)}
                onReviewReplyDraftChange={(commentId, body) => setReviewReplyDrafts((cur) => ({ ...cur, [commentId]: body }))}
                onSubmitReviewReply={(commentId) => { void submitReviewReply(item, commentId); }}
                viewerLogin={viewerLogin}
                reviewThreads={item.kind === "pulls" ? (reviewThreads[item.number] ?? []) : []}
                reviewThreadsTruncated={item.kind === "pulls" ? !!reviewThreadsTruncated[item.number] : false}
                onToggleThreadResolved={(thread) => toggleThreadResolved(item, thread)}
                onEditReviewComment={(commentId, body) => editReviewComment(item, commentId, body)}
                onDeleteReviewComment={(commentId) => deleteReviewComment(item, commentId)}
                onEditComment={(commentId, body) => editConversationComment(item, commentId, body)}
                onDeleteComment={(commentId) => deleteConversationComment(item, commentId)}
                onRetryReviewComments={() => {
                  if (item.kind !== "pulls") return;
                  setReviewCommentErrors((cur) => ({ ...cur, [item.number]: undefined }));
                }}
                onLabelDraftChange={(body) => setLabelDrafts((cur) => ({ ...cur, [item.number]: body }))}
                onAssigneeDraftChange={(body) => setAssigneeDrafts((cur) => ({ ...cur, [item.number]: body }))}
                onMilestoneDraftChange={(body) => setMilestoneDrafts((cur) => ({ ...cur, [item.number]: body }))}
                onIssueState={(nextState) => { void updateIssueState(item, nextState); }}
                onIssueLabels={() => { void updateIssueLabels(item); }}
                onCommentDraftChange={(body) => setCommentDrafts((cur) => ({ ...cur, [item.number]: body }))}
                onSubmitComment={() => { void submitComment(item); }}
                onRetryComments={() => {
                  setCommentErrors((cur) => ({ ...cur, [item.number]: undefined }));
                }}
                onRetryDiff={() => {
                  if (item.kind !== "pulls") return;
                  setDiffErrors((cur) => ({ ...cur, [item.number]: undefined }));
                }}
                onRetryChecks={() => {
                  if (item.kind !== "pulls") return;
                  setChecksErrors((cur) => ({ ...cur, [item.number]: undefined }));
                }}
                onRefreshDiff={() => {
                  if (item.kind !== "pulls") return;
                  setDiffs((cur) => ({ ...cur, [item.number]: undefined }));
                  setDiffErrors((cur) => ({ ...cur, [item.number]: undefined }));
                  // A refreshed diff may renumber lines under any queued comments.
                  if ((pendingReview[item.number] ?? []).length > 0) {
                    setPendingStale((cur) => ({ ...cur, [item.number]: true }));
                  }
                }}
                onRefreshChecks={() => {
                  if (item.kind !== "pulls") return;
                  setChecks((cur) => ({ ...cur, [item.number]: undefined }));
                  setChecksErrors((cur) => ({ ...cur, [item.number]: undefined }));
                }}
                onRefreshMergeability={() => {
                  if (item.kind !== "pulls") return;
                  mergeabilityRetries.current[item.number] = 0;
                  setMergeability((cur) => ({ ...cur, [item.number]: undefined }));
                  setMergeabilityErrors((cur) => ({ ...cur, [item.number]: undefined }));
                }}
                onToggle={() => {
                  const key = `${item.kind}-${item.number}`;
                  setExpandedKey((cur) => (cur === key ? null : key));
                }}
              />
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function PullComposer({
  open,
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
  onOpenChange,
  onTitleChange,
  onBodyChange,
  onHeadChange,
  onBaseChange,
  onReviewersChange,
  onDraftChange,
  onPushHead,
  onSubmit,
}: {
  open: boolean;
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
  onOpenChange: (open: boolean) => void;
  onTitleChange: (title: string) => void;
  onBodyChange: (body: string) => void;
  onHeadChange: (head: string) => void;
  onBaseChange: (base: string) => void;
  onReviewersChange: (reviewers: string) => void;
  onDraftChange: (draft: boolean) => void;
  onPushHead: () => void;
  onSubmit: () => void;
}) {
  if (!open) {
    return (
      <div className="mb-3 flex justify-end">
        <Button size="sm" onClick={() => onOpenChange(true)}>
          <Plus className="mr-2 size-3.5" />
          New PR
        </Button>
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-md border border-border/60 bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <GitPullRequest className="size-3.5" />
          New pull request
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
            title="Push the head branch to its remote so GitHub can open the pull request"
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
          The head branch must exist on the remote before GitHub can open the pull request — push it first if it's a new local branch.
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
          <Button size="sm" variant="ghost" disabled={submitting} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={submitting || !title.trim() || !head.trim() || !base.trim()} onClick={onSubmit}>
            {submitting ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Plus className="mr-2 size-3.5" />}
            Create PR
          </Button>
        </div>
      </div>
    </div>
  );
}

function IssueComposer({
  open,
  title,
  body,
  labels,
  assignees,
  milestone,
  submitting,
  error,
  onOpenChange,
  onTitleChange,
  onBodyChange,
  onLabelsChange,
  onAssigneesChange,
  onMilestoneChange,
  onSubmit,
}: {
  open: boolean;
  title: string;
  body: string;
  labels: string;
  assignees: string;
  milestone: string;
  submitting: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onTitleChange: (title: string) => void;
  onBodyChange: (body: string) => void;
  onLabelsChange: (labels: string) => void;
  onAssigneesChange: (assignees: string) => void;
  onMilestoneChange: (milestone: string) => void;
  onSubmit: () => void;
}) {
  if (!open) {
    return (
      <div className="mb-3 flex justify-end">
        <Button size="sm" onClick={() => onOpenChange(true)}>
          <Plus className="mr-2 size-3.5" />
          New issue
        </Button>
      </div>
    );
  }

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
        <Input
          value={labels}
          onChange={(e) => onLabelsChange(e.target.value)}
          placeholder="Labels, comma separated"
          className="h-8 text-xs"
          disabled={submitting}
        />
        <div className="grid gap-2 md:grid-cols-2">
          <Input
            value={assignees}
            onChange={(e) => onAssigneesChange(e.target.value)}
            placeholder="Assignees, comma separated"
            className="h-8 text-xs"
            disabled={submitting}
          />
          <Input
            value={milestone}
            onChange={(e) => onMilestoneChange(e.target.value)}
            placeholder="Milestone number"
            className="h-8 text-xs"
            disabled={submitting}
          />
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={submitting} onClick={() => onOpenChange(false)}>
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
  // A token is present. Note: GitHub still enforces push access — a read-only
  // collaborator sees the controls but the mutations 403.
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
      {authenticated && (
        <div className="mb-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.4fr)_auto]">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="h-8 text-xs" disabled={creating} />
          <div className="flex items-center gap-1">
            <span className="size-4 shrink-0 rounded-full border border-border/60" style={{ backgroundColor: labelSwatch(color) }} />
            <Input value={color} onChange={(e) => setColor(e.target.value)} placeholder="hex" className="h-8 w-20 text-xs" disabled={creating} />
          </div>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" className="h-8 text-xs" disabled={creating} />
          <Button size="sm" disabled={creating || !name.trim()} onClick={() => { void create(); }}>
            {creating ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Plus className="mr-2 size-3.5" />}
            Add
          </Button>
        </div>
      )}
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
      {authenticated && (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button size="icon" variant="ghost" className="size-6" title="Edit label" aria-label={`Edit ${label.name}`} disabled={!!busy} onClick={() => { reset(); setEditing(true); }}>
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
            <Button size="icon" variant="ghost" className="size-6 text-muted-foreground hover:text-rose-400" title="Delete label" aria-label={`Delete ${label.name}`} disabled={!!busy} onClick={() => setConfirm(true)}>
              <XCircle className="size-3.5" />
            </Button>
          )}
        </div>
      )}
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
      {authenticated && (
        <div className="mb-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.4fr)_auto]">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="h-8 text-xs" disabled={creating} />
          <Input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} title="Due date (optional)" className="h-8 w-36 text-xs" disabled={creating} />
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" className="h-8 text-xs" disabled={creating} />
          <Button size="sm" disabled={creating || !title.trim()} onClick={() => { void create(); }}>
            {creating ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Plus className="mr-2 size-3.5" />}
            Add
          </Button>
        </div>
      )}
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
      {authenticated && (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button size="icon" variant="ghost" className="size-6" title="Edit milestone" aria-label={`Edit ${milestone.title}`} disabled={!!busy} onClick={() => { reset(); setEditing(true); }}>
            <FilePen className="size-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[11px]"
            title={milestone.state === "open" ? "Close milestone" : "Reopen milestone"}
            disabled={!!busy}
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
            <Button size="icon" variant="ghost" className="size-6 text-muted-foreground hover:text-rose-400" title="Delete milestone" aria-label={`Delete ${milestone.title}`} disabled={!!busy} onClick={() => setConfirm(true)}>
              <XCircle className="size-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function GitHubItemRow({
  item,
  expanded,
  diff,
  diffLoading,
  diffError,
  checks,
  checksLoading,
  checksError,
  mergeability,
  mergeabilityLoading,
  mergeabilityError,
  reviewComments,
  reviewCommentsLoading,
  reviewCommentError,
  reviewReplyDrafts,
  reviewReplySubmitting,
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
  labelDraft,
  assigneeDraft,
  milestoneDraft,
  reviewerDraft,
  editorOpen,
  titleDraft,
  bodyDraft,
  onEditToggle,
  onTitleDraftChange,
  onBodyDraftChange,
  onSaveEdit,
  onReviewerDraftChange,
  onRequestReviewers,
  onReviewDraftChange,
  onCloseDraftChange,
  onMergeMethodChange,
  onReview,
  onMerge,
  onUpdateBranch,
  onReopenPull,
  onToggleDraft,
  onClosePull,
  pendingReview,
  pendingStale,
  onAddToReview,
  onRemovePendingReview,
  onLineComment,
  onReviewReplyDraftChange,
  onSubmitReviewReply,
  viewerLogin,
  reviewThreads,
  reviewThreadsTruncated,
  onToggleThreadResolved,
  onEditReviewComment,
  onDeleteReviewComment,
  onEditComment,
  onDeleteComment,
  onRetryReviewComments,
  onLabelDraftChange,
  onAssigneeDraftChange,
  onMilestoneDraftChange,
  onIssueState,
  onIssueLabels,
  onCommentDraftChange,
  onSubmitComment,
  onRetryComments,
  onRetryDiff,
  onRetryChecks,
  onRefreshDiff,
  onRefreshChecks,
  onRefreshMergeability,
  onToggle,
}: {
  item: GitHubListItem;
  expanded: boolean;
  diff?: TaskDiff;
  diffLoading: boolean;
  diffError?: string;
  checks?: GitHubChecksResult;
  checksLoading: boolean;
  checksError?: string;
  mergeability?: GitHubPullMergeability;
  mergeabilityLoading: boolean;
  mergeabilityError?: string;
  reviewComments?: GitHubPullLineComment[];
  reviewCommentsLoading: boolean;
  reviewCommentError?: string;
  reviewReplyDrafts: Record<number, string | undefined>;
  reviewReplySubmitting: Record<number, boolean | undefined>;
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
  labelDraft: string;
  assigneeDraft: string;
  milestoneDraft: string;
  reviewerDraft: string;
  editorOpen: boolean;
  titleDraft: string;
  bodyDraft: string;
  onEditToggle: (next: boolean) => void;
  onTitleDraftChange: (body: string) => void;
  onBodyDraftChange: (body: string) => void;
  onSaveEdit: () => void;
  onReviewerDraftChange: (body: string) => void;
  onRequestReviewers: () => void;
  onReviewDraftChange: (body: string) => void;
  onCloseDraftChange: (body: string) => void;
  onMergeMethodChange: (method: GitHubPullMergeMethod) => void;
  onReview: (event: GitHubPullReviewEvent) => void;
  onMerge: () => void;
  onUpdateBranch: () => void;
  onReopenPull: () => void;
  onToggleDraft: () => void;
  onClosePull: () => void;
  pendingReview: LineCommentTarget[];
  pendingStale: boolean;
  onAddToReview: (target: LineCommentTarget) => void;
  onRemovePendingReview: (index: number) => void;
  onLineComment: (target: LineCommentTarget) => Promise<void>;
  onReviewReplyDraftChange: (commentId: number, body: string) => void;
  onSubmitReviewReply: (commentId: number) => void;
  viewerLogin: string;
  reviewThreads: GitHubReviewThread[];
  reviewThreadsTruncated: boolean;
  onToggleThreadResolved: (thread: GitHubReviewThread) => Promise<void>;
  onEditReviewComment: (commentId: number, body: string) => Promise<void>;
  onDeleteReviewComment: (commentId: number) => Promise<void>;
  onEditComment: (commentId: number, body: string) => Promise<void>;
  onDeleteComment: (commentId: number) => Promise<void>;
  onRetryReviewComments: () => void;
  onLabelDraftChange: (body: string) => void;
  onAssigneeDraftChange: (body: string) => void;
  onMilestoneDraftChange: (body: string) => void;
  onIssueState: (state: "open" | "closed") => void;
  onIssueLabels: () => void;
  onCommentDraftChange: (body: string) => void;
  onSubmitComment: () => void;
  onRetryComments: () => void;
  onRetryDiff: () => void;
  onRetryChecks: () => void;
  onRefreshDiff: () => void;
  onRefreshChecks: () => void;
  onRefreshMergeability: () => void;
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
              title="View in Agetor"
            >
              #{item.number} {item.title}
            </button>
            {item.draft && (
              <span className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                Draft
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
          title={expanded ? "Collapse" : "Expand"}
          aria-label={`${expanded ? "Collapse" : "Expand"} #${item.number}`}
          onClick={onToggle}
        >
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          title="Open on GitHub"
          aria-label={`Open #${item.number} on GitHub`}
          onClick={() => { void api.openExternal(item.htmlUrl); }}
        >
          <ExternalLink className="size-4" />
        </Button>
      </div>
      {expanded && (
        <div className="border-t border-border/60 bg-background/40 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-[11px] font-medium uppercase text-muted-foreground">
              {item.kind === "pulls" ? "Pull request" : "Issue"} #{item.number}
            </div>
            {!editorOpen && (
              <Button size="sm" variant="ghost" className="h-7" onClick={() => onEditToggle(true)}>
                <FilePen className="mr-2 size-3.5" />
                Edit
              </Button>
            )}
          </div>
          {editorOpen ? (
            <ItemEditor
              title={titleDraft}
              body={bodyDraft}
              busy={actionBusy === "edit"}
              error={actionSource === "edit" ? actionError : undefined}
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
          {item.kind === "pulls" && (
            <>
              <PullActions
                item={item}
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
                onClosePull={onClosePull}
                onRefreshMergeability={onRefreshMergeability}
              />
              <PullTriage
                labelDraft={labelDraft}
                assigneeDraft={assigneeDraft}
                milestoneDraft={milestoneDraft}
                reviewerDraft={reviewerDraft}
                busy={actionBusy}
                prOpen={item.state === "open"}
                error={actionSource === "triage" ? actionError : undefined}
                message={actionSource === "triage" ? actionMessage : undefined}
                onLabelDraftChange={onLabelDraftChange}
                onAssigneeDraftChange={onAssigneeDraftChange}
                onMilestoneDraftChange={onMilestoneDraftChange}
                onReviewerDraftChange={onReviewerDraftChange}
                onSaveTriage={onIssueLabels}
                onRequestReviewers={onRequestReviewers}
              />
              <CheckRuns checks={checks} loading={checksLoading} error={checksError} onRetry={onRetryChecks} onRefresh={onRefreshChecks} />
              <PullDiff diff={diff} loading={diffLoading} error={diffError} onRetry={onRetryDiff} onRefresh={onRefreshDiff} onLineComment={onLineComment} onAddToReview={onAddToReview} pending={pendingReview} />
              <PendingReview comments={pendingReview} stale={pendingStale} onRemove={onRemovePendingReview} />
              <ReviewComments
                comments={reviewComments}
                loading={reviewCommentsLoading}
                error={reviewCommentError}
                replyDrafts={reviewReplyDrafts}
                replySubmitting={reviewReplySubmitting}
                viewerLogin={viewerLogin}
                threads={reviewThreads}
                threadsTruncated={reviewThreadsTruncated}
                onToggleResolved={onToggleThreadResolved}
                onEdit={onEditReviewComment}
                onDelete={onDeleteReviewComment}
                onDraftChange={onReviewReplyDraftChange}
                onSubmitReply={onSubmitReviewReply}
                onRetry={onRetryReviewComments}
              />
            </>
          )}
          {item.kind === "issues" && (
            <IssueActions
              item={item}
              labelDraft={labelDraft}
              assigneeDraft={assigneeDraft}
              milestoneDraft={milestoneDraft}
              busy={actionBusy}
              error={actionSource === "actions" || actionSource === "triage" ? actionError : undefined}
              message={actionSource === "actions" || actionSource === "triage" ? actionMessage : undefined}
              onLabelDraftChange={onLabelDraftChange}
              onAssigneeDraftChange={onAssigneeDraftChange}
              onMilestoneDraftChange={onMilestoneDraftChange}
              onIssueState={onIssueState}
              onIssueLabels={onIssueLabels}
            />
          )}
          <Conversation
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
      )}
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

const MERGE_TONE_CLASS: Record<MergeTone, string> = {
  ok: "text-emerald-400",
  warn: "text-amber-400",
  bad: "text-rose-400",
  muted: "text-muted-foreground",
};

function IssueActions({
  item,
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
}: {
  item: GitHubListItem;
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
}) {
  const isBusy = !!busy;
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
        <Input
          value={labelDraft}
          onChange={(e) => onLabelDraftChange(e.target.value)}
          placeholder="Labels, comma separated"
          className="h-8 text-xs"
          disabled={isBusy}
        />
        <Input
          value={assigneeDraft}
          onChange={(e) => onAssigneeDraftChange(e.target.value)}
          placeholder="Assignees, comma separated"
          className="h-8 text-xs"
          disabled={isBusy}
        />
        <Input
          value={milestoneDraft}
          onChange={(e) => onMilestoneDraftChange(e.target.value)}
          placeholder="Milestone number"
          className="h-8 text-xs"
          disabled={isBusy}
        />
        <Button size="sm" variant="outline" disabled={isBusy} onClick={onIssueLabels}>
          {busy === "labels" ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Tag className="mr-2 size-3.5" />}
          Save triage
        </Button>
      </div>
      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          variant="outline"
          disabled={isBusy}
          onClick={() => onIssueState(nextState)}
        >
          {busy === nextState ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <XCircle className="mr-2 size-3.5" />}
          {item.state === "open" ? "Close issue" : "Reopen issue"}
        </Button>
      </div>
    </div>
  );
}

function ItemEditor({
  title,
  body,
  busy,
  error,
  onTitleChange,
  onBodyChange,
  onCancel,
  onSave,
}: {
  title: string;
  body: string;
  busy: boolean;
  error?: string;
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
        <Button size="sm" disabled={busy || !title.trim()} onClick={onSave}>
          {busy ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <FilePen className="mr-2 size-3.5" />}
          Save
        </Button>
      </div>
    </div>
  );
}

function PullTriage({
  labelDraft,
  assigneeDraft,
  milestoneDraft,
  reviewerDraft,
  busy,
  prOpen,
  error,
  message,
  onLabelDraftChange,
  onAssigneeDraftChange,
  onMilestoneDraftChange,
  onReviewerDraftChange,
  onSaveTriage,
  onRequestReviewers,
}: {
  labelDraft: string;
  assigneeDraft: string;
  milestoneDraft: string;
  reviewerDraft: string;
  busy?: string;
  prOpen: boolean;
  error?: string;
  message?: string;
  onLabelDraftChange: (body: string) => void;
  onAssigneeDraftChange: (body: string) => void;
  onMilestoneDraftChange: (body: string) => void;
  onReviewerDraftChange: (body: string) => void;
  onSaveTriage: () => void;
  onRequestReviewers: () => void;
}) {
  const isBusy = !!busy;
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
        <Input
          value={labelDraft}
          onChange={(e) => onLabelDraftChange(e.target.value)}
          placeholder="Labels, comma separated"
          className="h-8 text-xs"
          disabled={isBusy}
        />
        <Input
          value={assigneeDraft}
          onChange={(e) => onAssigneeDraftChange(e.target.value)}
          placeholder="Assignees, comma separated"
          className="h-8 text-xs"
          disabled={isBusy}
        />
        <Input
          value={milestoneDraft}
          onChange={(e) => onMilestoneDraftChange(e.target.value)}
          placeholder="Milestone number"
          className="h-8 text-xs"
          disabled={isBusy}
        />
        <Button size="sm" variant="outline" disabled={isBusy} onClick={onSaveTriage}>
          {busy === "labels" ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Tag className="mr-2 size-3.5" />}
          Save triage
        </Button>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
        <Input
          value={reviewerDraft}
          onChange={(e) => onReviewerDraftChange(e.target.value)}
          placeholder={prOpen ? "Request reviewers, comma separated" : "Reviewers can only be requested on open PRs"}
          className="h-8 text-xs"
          disabled={isBusy || !prOpen}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={isBusy || !prOpen || !reviewerDraft.trim()}
          title={prOpen ? undefined : "Reviewers can only be requested on open pull requests"}
          onClick={onRequestReviewers}
        >
          {busy === "reviewers" ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <GitPullRequest className="mr-2 size-3.5" />}
          Request review
        </Button>
      </div>
    </div>
  );
}

function PullActions({
  item,
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
  onClosePull,
  onRefreshMergeability,
}: {
  item: GitHubListItem;
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
  onClosePull: () => void;
  onRefreshMergeability: () => void;
}) {
  const disabled = item.state !== "open" || !!busy;
  const view = item.state === "open" && mergeability ? mergeabilityView(mergeability) : null;
  const mergeDisabled = disabled || (view ? !view.canMerge : false);
  return (
    <div className="mt-3 rounded-md border border-border/60 bg-card p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <GitPullRequest className="size-3.5" />
          Actions
        </div>
        {item.state === "open" && (
          <Button size="sm" variant="ghost" className="h-7" disabled={!!busy} onClick={onToggleDraft}>
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
          <Button size="sm" variant="outline" className="h-7" disabled={!!busy} onClick={onReopenPull}>
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
            <span className={cn("inline-flex items-center gap-1.5 text-[11px]", MERGE_TONE_CLASS[view.tone])}>
              <span className={cn("size-2 shrink-0 rounded-full bg-current")} />
              {view.label}
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground">Mergeability unavailable.</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {view?.showUpdateBranch && (
              <Button size="sm" variant="outline" disabled={disabled} onClick={onUpdateBranch}>
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
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || (!reviewDraft.trim() && pendingCount === 0)}
              onClick={() => onReview("REQUEST_CHANGES")}
            >
              {busy === "REQUEST_CHANGES" ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <XCircle className="mr-2 size-3.5" />}
              Request
            </Button>
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
            <option value="merge">Create merge commit</option>
            <option value="squash">Squash and merge</option>
            <option value="rebase">Rebase and merge</option>
          </Select>
          <Button
            size="sm"
            className="mt-2"
            disabled={mergeDisabled}
            title={view && !view.canMerge ? view.label : undefined}
            onClick={onMerge}
          >
            {busy === "merge" ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <GitMerge className="mr-2 size-3.5" />}
            Merge
          </Button>
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
            disabled={disabled}
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
                  title="Open check on GitHub"
                  aria-label={`Open ${run.name} check on GitHub`}
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

function PullDiff({
  diff,
  loading,
  error,
  onRetry,
  onRefresh,
  onLineComment,
  onAddToReview,
  pending,
}: {
  diff?: TaskDiff;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onRefresh: () => void;
  onLineComment: (target: LineCommentTarget) => Promise<void>;
  onAddToReview: (target: LineCommentTarget) => void;
  pending: LineCommentTarget[];
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
  comments,
  loading,
  error,
  replyDrafts,
  replySubmitting,
  viewerLogin,
  threads,
  threadsTruncated,
  onToggleResolved,
  onEdit,
  onDelete,
  onDraftChange,
  onSubmitReply,
  onRetry,
}: {
  comments?: GitHubPullLineComment[];
  loading: boolean;
  error?: string;
  replyDrafts: Record<number, string | undefined>;
  replySubmitting: Record<number, boolean | undefined>;
  viewerLogin: string;
  threads: GitHubReviewThread[];
  threadsTruncated: boolean;
  onToggleResolved: (thread: GitHubReviewThread) => Promise<void>;
  onEdit: (commentId: number, body: string) => Promise<void>;
  onDelete: (commentId: number) => Promise<void>;
  onDraftChange: (commentId: number, body: string) => void;
  onSubmitReply: (commentId: number) => void;
  onRetry: () => void;
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
                  {thread && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto h-6 px-2 text-[11px]"
                      disabled={busyThread === thread.threadId}
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
                />
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
                comment={comment}
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
  comment,
  canModify,
  onEdit,
  onDelete,
}: {
  comment: GitHubComment;
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
}: {
  body: string;
  canModify: boolean;
  onEdit: (body: string) => Promise<void>;
  onDelete: () => Promise<void>;
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
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
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

function DiffFileBlock({
  file,
  onLineComment,
  onAddToReview,
  queuedKeys,
}: {
  file: DiffFile;
  onLineComment: (target: LineCommentTarget) => Promise<void>;
  onAddToReview: (target: LineCommentTarget) => void;
  queuedKeys: Set<string>;
}) {
  const meta = STATUS_META[file.status];
  const Icon = meta.icon;
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className="flex items-center gap-2 bg-muted/40 px-2 py-1.5">
        <Icon className={cn("size-3.5 shrink-0", meta.cls)} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {file.oldPath && <span className="text-muted-foreground">{file.oldPath} -&gt; </span>}
          {file.path}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {file.binary ? "binary" : <><span className="text-emerald-400">+{file.additions}</span> <span className="text-rose-400">-{file.deletions}</span></>}
        </span>
      </div>
      {file.binary ? (
        <div className="px-3 py-2 text-xs italic text-muted-foreground">Binary file, no textual diff.</div>
      ) : (
        <>
          <DiffBody file={file} hunks={file.hunks} onLineComment={onLineComment} onAddToReview={onAddToReview} queuedKeys={queuedKeys} />
          {file.truncated && (
            <div className="border-t border-border/60 px-3 py-1.5 text-[11px] italic text-muted-foreground">
              Diff truncated because this file's changes are too large to display in full.
            </div>
          )}
        </>
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
}: {
  file: DiffFile;
  hunks: string;
  onLineComment: (target: LineCommentTarget) => Promise<void>;
  onAddToReview: (target: LineCommentTarget) => void;
  queuedKeys: Set<string>;
}) {
  const rows = useMemo(() => toRows(hunks), [hunks]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [postedKey, setPostedKey] = useState<string | null>(null);

  const commentTarget = (r: DiffRow): Omit<LineCommentTarget, "body"> | null => {
    if (r.kind === "del" && r.old) {
      return { filePath: file.oldPath ?? file.path, line: r.old, side: "LEFT" };
    }
    if ((r.kind === "add" || r.kind === "ctx") && r.neu) {
      return { filePath: file.path, line: r.neu, side: "RIGHT" };
    }
    return null;
  };

  const submit = async (target: Omit<LineCommentTarget, "body">) => {
    const body = draft.trim();
    if (!body || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onLineComment({ ...target, body });
      setPostedKey(selectedKey);
      setSelectedKey(null);
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const queue = (target: Omit<LineCommentTarget, "body">) => {
    const body = draft.trim();
    if (!body || submitting) return;
    onAddToReview({ ...target, body });
    setSelectedKey(null);
    setDraft("");
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
                  }}
                >
                  <MessageSquare className="size-3.5" />
                </button>
              )}
              {postedKey === rowKey && (
                <span className="sticky right-0 shrink-0 bg-card/90 px-1 text-[11px] text-emerald-400">commented</span>
              )}
              {queued && postedKey !== rowKey && (
                <span className="sticky right-0 shrink-0 bg-card/90 px-1 text-[11px] text-sky-400">queued</span>
              )}
            </div>
            {selected && target && (
              <div className="border-y border-border/50 bg-background px-3 py-2 font-sans">
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={`Comment on ${target.side === "LEFT" ? "old" : "new"} line ${target.line}...`}
                  className="min-h-20 resize-y text-sm"
                  disabled={submitting}
                />
                {error && (
                  <div className="mt-2 flex items-center gap-1 text-xs text-rose-400">
                    <AlertCircle className="size-3.5" />
                    {error}
                  </div>
                )}
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={submitting}
                    onClick={() => {
                      setSelectedKey(null);
                      setDraft("");
                      setError(null);
                    }}
                  >
                    Cancel
                  </Button>
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
