// The planner behind "Create all PRs" and the single "Create PR" chip: which
// pull requests to open, with what title, body and base. Pure and DOM-free,
// with the two network reads (a repository's forge identity, and its remote
// branch facts) injected, so the whole decision is unit-testable.
//
//   proposals (pr-proposal.ts) ──attributeProposals──▶ (repository, head) pairs
//   + per-repository facts (pull-targets) ──chooseBase──▶ one base per row
//   ──planPrRows──▶ PrRow[] ──runPrBatch──▶ POST /github/pull-create
//
// The contract (attribution, base precedence, stale rule) is
// docs/architecture/multi-repo-tasks.md; the trust boundary (agent text never
// selects a repository, a remote or a branch name that reaches git unchecked)
// is docs/architecture/security.md.
import type { PullTargetsResult, RunEvent, Task, TaskPr } from "../../shared/types.ts";
import { validateBranchName } from "../../shared/types.ts";
import { isMultiRepoTask, repositoriesForTask } from "../../shared/multi-repo.ts";
import { prHeadBranch, repositoryPrHead, shouldOfferOpenPr, type TaskGitStatus } from "./commit-push.ts";
import { parseIssueUrl } from "../../shared/issue-task.ts";
import { prForHead } from "../../shared/task-prs.ts";
import { beginPrBatch, endPrBatch, markPrOpened, prOpenedInSession } from "./multi-repo-ui.ts";
import { linkMatchesRepo, parsePrLink, type PrLink, type RepoIdentity } from "./pr-link.ts";
import { collectRunProposals, type RunProposal } from "./pr-proposal.ts";

export type PrBaseSource = "task" | "agent" | "default" | "user";

/** One repository a PR action is about. */
export interface PrPlanRepo {
  /** Workspace name (a single-repo task: the sanitized basename of its workdir). */
  name: string;
  /** The directory forge calls run in. */
  projectPath: string;
  /**
   * The live checkout's PR head, already gated on pushed + synced state by the
   * caller (`repositoryPrHead` / `prHeadBranch`). Null: nothing sensible to PR from yet.
   */
  liveHead: string | null;
  /** The branch agetor created for this repository, shown when `liveHead` is null. */
  branch: string | null;
  /** PRs already recorded for this repository. */
  prs: readonly TaskPr[];
  /** The base branch recorded at task creation, and the sha it was pinned to. */
  storedBase: string | null;
  storedBaseSha: string | null;
  /** True for the repository the task's issue came from (`Closes #N` goes here only). */
  isIssueRepo: boolean;
  /** The forge identity, when already known (a cache hit); resolved through `deps.providerInfo` otherwise. */
  identity?: RepoIdentity | null;
}

export interface PrPlanInput {
  taskId: string;
  repos: PrPlanRepo[];
  events: RunEvent[];
  /** Title used when a row has no proposal: the root task's (the pipeline parent's for a step). */
  rootTitle: string;
  issueUrl: string | null;
  /** A multi-repository task: an unlabeled linkless proposal is never attributed. */
  multi: boolean;
  /** Plan the live head of each repository only (the single "Create PR" chip). */
  liveHeadOnly?: boolean;
}

export interface PrRow {
  key: string;
  repoName: string;
  projectPath: string;
  /** The git remote the forge identity came from, for messages. */
  remote: string | null;
  head: string;
  isLiveHead: boolean;
  checked: boolean;
  disabledReason: string | null;
  base: string;
  baseSource: PrBaseSource;
  baseOptions: Array<{ name: string; onRemote: boolean | null }>;
  baseError: string | null;
  hints: string[];
  title: string;
  body: string;
  hasProposal: boolean;
}

export type PrRowResult =
  | { status: "creating" }
  | { status: "created"; url: string }
  | { status: "already-open"; url: string | null }
  | { status: "failed"; error: string }
  | { status: "skipped"; reason: string };

export interface PullTargetsQuery {
  path: string;
  heads: string[];
  storedBase?: string | null;
  storedBaseSha?: string | null;
  liveHead?: string | null;
  /** `false`: skip the forge branch listing (the single chip needs only its own head and base). */
  listBranches?: boolean;
}

export interface PrPlanDeps {
  providerInfo(path: string): Promise<RepoIdentity | null>;
  pullTargets(query: PullTargetsQuery): Promise<PullTargetsResult>;
}

// ── Repositories in scope ──────────────────────────────────────────────────

/**
 * The repositories a PR action is about, with each one's live PR head. A
 * single-repo task is one entry (head from `prHeadBranch`, gated on pushed and
 * synced state like the "Create PR" chip); a multi-repo task is one per
 * repository (head from `repositoryPrHead` against that repository's entry in
 * the batched git status). `identity` is left unset for the planner to resolve.
 */
export function planReposForTask(
  task: Pick<
    Task,
    | "workdir"
    | "isolation"
    | "branch"
    | "branchSource"
    | "worktreePath"
    | "baseRef"
    | "checkoutBranch"
    | "prUrl"
    | "prs"
    | "baseBranch"
    | "repositories"
    | "multiRepo"
    | "issueUrl"
    | "issueRepoPath"
  >,
  gitStatus: TaskGitStatus | null,
): PrPlanRepo[] {
  const multi = isMultiRepoTask(task);
  const entries = repositoriesForTask(task);
  return entries.map((entry) => {
    const status = multi
      ? (gitStatus && "repositories" in gitStatus ? gitStatus.repositories?.find((r) => r.name === entry.name) ?? null : null)
      : gitStatus;
    const liveHead = multi
      ? repositoryPrHead(entry, status)
      : shouldOfferOpenPr(status)
        ? prHeadBranch(task.branch ?? null, status, task.branchSource)
        : null;
    return {
      name: entry.name,
      projectPath: multi ? (entry.worktreePath ?? entry.path) : task.workdir,
      liveHead,
      branch: entry.branch,
      prs: entry.prs ?? [],
      storedBase: entry.baseBranch ?? null,
      storedBaseSha: entry.baseRef ?? null,
      // Only the repository the issue came from may close it.
      isIssueRepo: multi ? entry.path === task.issueRepoPath : !!task.issueUrl,
    };
  });
}

// ── Issue directive ────────────────────────────────────────────────────────

/**
 * Prefills the "Closes #N" (GitHub/GitLab) / "Issue #N" (Bitbucket) line into a
 * PR body when the task was created from an issue. No-op when `issueUrl`
 * doesn't parse, or the body already references the issue number (a
 * word-boundary check: `#7` must not match `#71`).
 */
export function appendIssueCloseDirective(body: string, issueUrl: string | null | undefined): string {
  const parsed = parseIssueUrl(issueUrl);
  if (!parsed) return body;
  const marker = `#${parsed.number}`;
  if (new RegExp(`#${parsed.number}(?!\\d)`).test(body)) return body;
  const directive = parsed.provider === "bitbucket" ? `Issue ${marker}` : `Closes ${marker}`;
  return body ? `${body}\n\n${directive}` : directive;
}

// ── Attribution ────────────────────────────────────────────────────────────

/** A proposal attributed to a (repository, head), with the base its link named. */
export interface AttributedProposal extends RunProposal {
  linkBase: string | null;
}

/** Repository name → head → the newest proposal for that pair. */
export type Attribution = Map<string, Map<string, AttributedProposal>>;

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Assign each proposal to the (repository, head) it is for. A proposal belongs
 * to repository R and head H when either holds:
 *  - its link's host and full `owner/name` path equal R's forge identity and the
 *    link names head H (a fork head is never attributed); or
 *  - its `Repository:` label equals R's workspace name and its link, if any,
 *    doesn't name another repository. H is then the link's head, else R's live head.
 * On a single-repository task an unlabeled proposal with no PR link at all goes
 * to the live head, as the single chip always did. Anything else is left
 * unattributed: agent text never picks a repository on a guess. The newest
 * proposal per (R, H) wins across runs.
 */
export function attributeProposals(
  proposals: readonly RunProposal[],
  repos: ReadonlyArray<Pick<PrPlanRepo, "name" | "liveHead"> & { identity?: RepoIdentity | null }>,
  opts: { multi: boolean },
): Attribution {
  const out: Attribution = new Map();
  const sorted = [...proposals].sort((a, b) => a.order - b.order);
  for (const p of sorted) {
    const link: PrLink | null = p.link ? parsePrLink(p.link) : null;
    let repo: (typeof repos)[number] | undefined;
    let head: string | null = null;

    if (link) {
      const matches = repos.filter((r) => r.identity && linkMatchesRepo(link, r.identity));
      repo = matches.find((r) => p.repositoryLabel && sameName(r.name, p.repositoryLabel)) ?? matches[0];
      if (repo) head = link.head;
    }
    if (!repo && p.repositoryLabel) {
      const labeled = repos.find((r) => sameName(r.name, p.repositoryLabel!));
      // A link that names another repository (a known identity that doesn't match) disqualifies the label.
      const namesAnother = labeled && link && labeled.identity && !linkMatchesRepo(link, labeled.identity);
      if (labeled && !namesAnother) {
        repo = labeled;
        head = link?.head ?? labeled.liveHead;
      }
    }
    if (!repo && !opts.multi && repos.length === 1 && !p.repositoryLabel && !link) {
      repo = repos[0];
      head = repo!.liveHead;
    }
    if (!repo || !head) continue;

    let byHead = out.get(repo.name);
    if (!byHead) {
      byHead = new Map();
      out.set(repo.name, byHead);
    }
    byHead.set(head, { ...p, linkBase: link?.base ?? null });
  }
  return out;
}

// ── Base choice ────────────────────────────────────────────────────────────

/**
 * The agent's base as a branch name: `refs/heads/` and `<remote>/` prefixes
 * (for a configured remote) are stripped, and a value that isn't a valid
 * branch name is dropped.
 */
export function normalizeAgentBase(raw: string | null | undefined, remotes: readonly string[]): string | null {
  if (!raw) return null;
  let v = raw.trim();
  v = v.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
  const slash = v.indexOf("/");
  if (slash > 0 && remotes.includes(v.slice(0, slash))) v = v.slice(slash + 1);
  if (!v || v.startsWith("-")) return null;
  return validateBranchName(v).ok ? v : null;
}

export interface ChooseBaseInput {
  isLiveHead: boolean;
  storedBase: string | null;
  /** `true` when the git checks proved the stored base stale; `null` when they couldn't tell. */
  storedStale: boolean | null;
  agentBase: string | null;
  defaultBase: string | null;
}

export interface ChosenBase {
  base: string | null;
  source: PrBaseSource | null;
  hints: string[];
}

/**
 * The one place a PR's base is decided. A live-head PR targets the stored base
 * (recorded at task creation) unless git proved it stale, then the agent's base,
 * then the remote default. With no stored base the agent's comes before the
 * default. An extra head never uses the stored base: agent, then default.
 * `hints` names the candidate that lost when it differs, for the confirm list.
 */
export function chooseBase(input: ChooseBaseInput): ChosenBase {
  const { isLiveHead, storedBase, storedStale, agentBase, defaultBase } = input;
  const hints: string[] = [];
  const useStored = isLiveHead && !!storedBase && storedStale !== true;
  if (isLiveHead && storedBase && storedStale === true) {
    hints.push(`stored base \`${storedBase}\` looks stale: the branch was moved off it`);
  }
  if (useStored) {
    if (agentBase && agentBase !== storedBase) hints.push(`agent suggests \`${agentBase}\``);
    return { base: storedBase, source: "task", hints };
  }
  if (agentBase) {
    if (defaultBase && defaultBase !== agentBase && !(isLiveHead && storedBase)) {
      hints.push(`remote default is \`${defaultBase}\``);
    }
    return { base: agentBase, source: "agent", hints };
  }
  if (defaultBase) return { base: defaultBase, source: "default", hints };
  return { base: null, source: null, hints };
}

// ── Rows ───────────────────────────────────────────────────────────────────

const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-");

/** The row key for a (repository, head) pair. */
export function prRowKey(repoName: string, head: string): string {
  return `${repoName}::${head}`;
}

/** The test-id slug for a row. */
export function prRowSlug(repoName: string, head: string): string {
  return `${slug(repoName)}-${slug(head)}`;
}

function baseOnRemote(name: string, targets: PullTargetsResult | null): boolean | null {
  if (!targets) return null;
  if (targets.branches.includes(name)) return true;
  if (targets.defaultBranch === name) return true;
  if (targets.storedBase?.name === name && targets.storedBase.onRemote !== null) return targets.storedBase.onRemote;
  if (targets.branchesError || targets.branchesTruncated) return null;
  return false;
}

function baseErrorFor(
  base: string,
  head: string,
  onRemote: boolean | null,
  remote: string | null,
): string | null {
  if (!base) return "No base branch could be determined; pick one.";
  if (base === head) return `The base and the head are the same branch (\`${base}\`).`;
  if (onRemote === false) return `Base branch \`${base}\` isn't on ${remote ?? "origin"}.`;
  return null;
}

function baseOptionsFor(
  targets: PullTargetsResult | null,
  extras: readonly string[],
): Array<{ name: string; onRemote: boolean | null }> {
  const seen = new Set<string>();
  const out: Array<{ name: string; onRemote: boolean | null }> = [];
  for (const name of targets?.branches ?? []) {
    if (!seen.has(name)) {
      seen.add(name);
      out.push({ name, onRemote: true });
    }
  }
  for (const name of extras) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, onRemote: baseOnRemote(name, targets) });
  }
  return out;
}

/** Heads of proposals attributed to a repository, live head first, in text order. */
function headsOf(repo: PrPlanRepo, byHead: Map<string, AttributedProposal> | undefined): string[] {
  const heads: string[] = [];
  if (repo.liveHead) heads.push(repo.liveHead);
  for (const h of byHead?.keys() ?? []) if (!heads.includes(h)) heads.push(h);
  return heads;
}

/** A branch name the core accepts in a pull-targets query (valid, and not an option). */
function isValidBranchName(name: string): boolean {
  return name.length > 0 && !name.startsWith("-") && validateBranchName(name).ok;
}

/**
 * Whether a head already has a PR: recorded on the task, opened by a batch this
 * session, or (for the live head only) a converted legacy record with no head,
 * which `livePr` also treats as the live checkout's PR, so the gate and the
 * header agree.
 */
export function headHasPr(
  taskId: string,
  repo: Pick<PrPlanRepo, "name" | "prs"> & { liveHead?: string | null },
  head: string,
): boolean {
  if (prForHead(repo.prs, head) || prOpenedInSession(taskId, repo.name, head)) return true;
  return repo.liveHead === head && repo.prs.some((p) => p.head === null);
}

/**
 * Proposal heads that still need a pull request: every head a proposal is
 * attributed to, minus those that already have one (recorded or opened this
 * session). Backs the Create-all-PRs button's gate; the caller adds the live
 * head's own state.
 */
export function proposalHeadsNeedingPr(
  input: Pick<PrPlanInput, "taskId" | "repos" | "multi"> & { proposals: readonly RunProposal[] },
): Array<{ repoName: string; head: string }> {
  const attribution = attributeProposals(input.proposals, input.repos, { multi: input.multi });
  const out: Array<{ repoName: string; head: string }> = [];
  for (const repo of input.repos) {
    for (const head of attribution.get(repo.name)?.keys() ?? []) {
      if (!headHasPr(input.taskId, repo, head)) out.push({ repoName: repo.name, head });
    }
  }
  return out;
}

interface RepoFacts {
  repo: PrPlanRepo;
  attributed: Map<string, AttributedProposal> | undefined;
  targets: PullTargetsResult | null;
  targetsError: string | null;
}

/** Build the rows for one repository from its attribution and remote facts. Pure. */
export function planPrRows(input: PrPlanInput, facts: RepoFacts): PrRow[] {
  const { repo, attributed, targets, targetsError } = facts;
  const remote = targets?.remote ?? null;
  const remotes = targets?.remotes?.length ? targets.remotes : ["origin"];
  const rows: PrRow[] = [];

  if (!repo.liveHead && !input.liveHeadOnly) {
    // Nothing pushed to open a PR from yet. Only worth a row when the repository has no PR at all.
    if (repo.prs.length === 0) {
      const head = repo.branch ?? "";
      rows.push({
        key: prRowKey(repo.name, head),
        repoName: repo.name,
        projectPath: repo.projectPath,
        remote,
        head,
        isLiveHead: true,
        checked: false,
        disabledReason: "branch is not pushed yet",
        base: "",
        baseSource: "default",
        baseOptions: [],
        baseError: null,
        hints: [],
        title: input.rootTitle,
        body: "",
        hasProposal: false,
      });
    }
    return rows;
  }

  const heads = input.liveHeadOnly ? (repo.liveHead ? [repo.liveHead] : []) : headsOf(repo, attributed);
  for (const head of heads) {
    if (headHasPr(input.taskId, repo, head)) continue;
    const isLiveHead = head === repo.liveHead;
    const proposal = attributed?.get(head) ?? null;
    const hints: string[] = [];

    const lineBase = normalizeAgentBase(proposal?.baseLine, remotes);
    const linkBase = normalizeAgentBase(proposal?.linkBase, remotes);
    if (lineBase && linkBase && lineBase !== linkBase) {
      hints.push(`the \`Base:\` line says \`${lineBase}\` but the link says \`${linkBase}\``);
    }
    const agentBase = lineBase ?? linkBase;
    const stored = isLiveHead ? repo.storedBase : null;
    const storedFacts = targets?.storedBase && stored && targets.storedBase.name === stored ? targets.storedBase : null;
    const chosen = chooseBase({
      isLiveHead,
      storedBase: stored,
      storedStale: storedFacts?.stale ?? null,
      agentBase,
      defaultBase: targets?.defaultBranch ?? null,
    });
    hints.push(...chosen.hints);
    if (targetsError) hints.push(`couldn't read ${remote ?? "the remote"}: ${targetsError}`);
    if (targets?.branchesError) hints.push(`couldn't list branches: ${targets.branchesError}`);

    const base = chosen.base ?? "";
    const onRemote = base ? baseOnRemote(base, targets) : null;
    const baseOptions = baseOptionsFor(targets, [base, stored ?? "", agentBase ?? "", targets?.defaultBranch ?? ""]);

    let disabledReason: string | null = null;
    if (!isLiveHead) {
      const facts = targets?.heads.find((h) => h.name === head);
      if (!isValidBranchName(head)) disabledReason = `\`${head}\` isn't a valid branch name`;
      else if (facts?.onRemote === false) disabledReason = `branch \`${head}\` isn't on ${remote ?? "origin"}`;
      else if (!facts || facts.onRemote === null) {
        disabledReason = `can't confirm \`${head}\` is on ${remote ?? "origin"}`;
      }
    }
    if (!proposal) hints.push("no proposal found: using the task title");

    const body = proposal?.description ?? "";
    rows.push({
      key: prRowKey(repo.name, head),
      repoName: repo.name,
      projectPath: repo.projectPath,
      remote,
      head,
      isLiveHead,
      checked: isLiveHead && disabledReason === null,
      disabledReason,
      base,
      baseSource: chosen.source ?? "default",
      baseOptions,
      baseError: baseErrorFor(base, head, onRemote, remote),
      hints,
      title: proposal?.title || input.rootTitle,
      body: isLiveHead && repo.isIssueRepo ? appendIssueCloseDirective(body, input.issueUrl) : body,
      hasProposal: !!proposal,
    });
  }
  return rows;
}

/**
 * Plan every pull request a press of Create all PRs (or the single chip, with
 * `liveHeadOnly`) would open: resolve each repository's forge identity,
 * attribute the agent's proposals, read each repository's remote facts, and
 * build the rows. A failing facts read degrades that repository's rows (live
 * heads stay creatable, extra heads disable) instead of failing the plan.
 */
export async function buildPrPlan(input: PrPlanInput, deps: PrPlanDeps): Promise<PrRow[]> {
  const repos = await Promise.all(
    input.repos.map(async (r) => {
      if (r.identity !== undefined) return r;
      const identity = await deps.providerInfo(r.projectPath).catch(() => null);
      return { ...r, identity };
    }),
  );
  const attribution = attributeProposals(collectRunProposals(input.events), repos, { multi: input.multi });

  const perRepo = await Promise.all(
    repos.map(async (repo): Promise<RepoFacts> => {
      const attributed = attribution.get(repo.name);
      const heads = input.liveHeadOnly ? (repo.liveHead ? [repo.liveHead] : []) : headsOf(repo, attributed);
      // A name the core would refuse (the route 400s on it) never goes into the query.
      const candidates = heads.filter((h) => !headHasPr(input.taskId, repo, h) && isValidBranchName(h));
      if (candidates.length === 0) return { repo, attributed, targets: null, targetsError: null };
      try {
        const targets = await deps.pullTargets({
          path: repo.projectPath,
          heads: candidates,
          storedBase: repo.storedBase,
          storedBaseSha: repo.storedBaseSha,
          liveHead: repo.liveHead,
          // The single chip needs only its own head and base, which are looked up by name.
          ...(input.liveHeadOnly ? { listBranches: false } : {}),
        });
        return { repo, attributed, targets, targetsError: null };
      } catch (e) {
        return { repo, attributed, targets: null, targetsError: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  return perRepo.flatMap((facts) => planPrRows(input, facts));
}

/**
 * Apply a user edit to a row and recompute its base error: a new base is
 * checked against the row's option list (a base the listing proved missing is
 * an error, the same base and head is an error).
 */
export function editPrRow(row: PrRow, patch: { checked?: boolean; base?: string; title?: string }): PrRow {
  const next: PrRow = { ...row };
  if (patch.checked !== undefined) next.checked = patch.checked && row.disabledReason === null;
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.base !== undefined) {
    next.base = patch.base;
    next.baseSource = "user";
    const onRemote = row.baseOptions.find((o) => o.name === patch.base)?.onRemote ?? null;
    next.baseError = baseErrorFor(patch.base, row.head, onRemote, row.remote);
  }
  return next;
}

// ── Running a batch ────────────────────────────────────────────────────────

export interface PrBatchDeps {
  createPull(row: PrRow): Promise<{ url: string }>;
  onResult(key: string, result: PrRowResult): void;
}

export interface PrBatchSummary {
  created: number;
  alreadyOpen: number;
  failed: string[];
  /** Another walk for this task was already running; nothing was done. */
  busy?: boolean;
}

/** A forge's "a pull request already exists" answer, as `/github/pull-create` passes it through. */
export function alreadyOpenOf(error: unknown): { url: string | null } | null {
  const body = error && typeof error === "object" ? (error as { body?: unknown }).body : null;
  if (!body || typeof body !== "object") return null;
  const o = body as { code?: unknown; existingUrl?: unknown };
  if (o.code !== "already-exists") return null;
  return { url: typeof o.existingUrl === "string" && o.existingUrl ? o.existingUrl : null };
}

/**
 * Create the checked, error-free rows in order, best effort: a failure doesn't
 * stop the walk. An "already exists" answer counts as already open, not a
 * failure. One walk per task (`beginPrBatch`); a created PR is remembered for
 * the session so a press before the next board poll can't open it twice.
 */
export async function runPrBatch(taskId: string, rows: readonly PrRow[], deps: PrBatchDeps): Promise<PrBatchSummary> {
  if (!beginPrBatch(taskId)) return { created: 0, alreadyOpen: 0, failed: [], busy: true };
  const summary: PrBatchSummary = { created: 0, alreadyOpen: 0, failed: [] };
  try {
    for (const row of rows) {
      if (!row.checked) continue;
      // Re-checked here, not only when planned: an extra head is opened only after an explicit tick on a branch the forge listed.
      if (row.disabledReason !== null || row.baseError !== null) {
        deps.onResult(row.key, { status: "skipped", reason: row.disabledReason ?? row.baseError ?? "not ready" });
        continue;
      }
      if (!row.title.trim()) {
        deps.onResult(row.key, { status: "skipped", reason: "A title is required." });
        continue;
      }
      deps.onResult(row.key, { status: "creating" });
      try {
        const { url } = await deps.createPull(row);
        markPrOpened(taskId, row.repoName, row.head);
        summary.created += 1;
        deps.onResult(row.key, { status: "created", url });
      } catch (e) {
        const open = alreadyOpenOf(e);
        if (open) {
          summary.alreadyOpen += 1;
          deps.onResult(row.key, { status: "already-open", url: open.url });
        } else {
          const message = e instanceof Error ? e.message : String(e);
          summary.failed.push(`${row.repoName} (${row.head}): ${message}`);
          deps.onResult(row.key, { status: "failed", error: message });
        }
      }
    }
  } finally {
    endPrBatch(taskId);
  }
  return summary;
}
