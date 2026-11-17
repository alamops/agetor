// `GET /github/pull-targets`: what Create all PRs needs to know about ONE
// repository's remote before it plans a pull request: its forge identity, its
// remotes and default branch, the branches the forge lists, whether each head
// (and the task's stored base) exists there, and whether the stored base has
// gone stale. Contract: docs/architecture/multi-repo-tasks.md; trust boundary:
// docs/architecture/security.md.
//
// Branch facts come from the forge's REST API (the system that accepts or
// rejects the PR), never `git ls-remote`, and nothing here runs `git fetch`:
// the stale check uses the pinned create-time sha, which is always local, and
// the forge's tip sha only when that object already exists locally. Every
// branch name that reaches a git argv has passed `validateBranchName` and a
// leading-`-` check; agent text never selects a repository or a remote.
import type { ForgeBranch, ProviderRepoInfo, PullTargetsResult } from "../shared/types.ts";
import { validateBranchName } from "../shared/types.ts";
import { childEnv, coreSpawn } from "./core-spawn.ts";
import * as gitHost from "./git-host.ts";
import { providerRemoteForDir } from "./git-provider.ts";

/** How many forge branch names a listing keeps. */
const BRANCH_CAP = 1000;
const BRANCH_LIST_MAX_PAGES = 10;
const GIT_TIMEOUT_MS = 5_000;
const SHA_RE = /^[0-9a-f]{7,64}$/i;

export interface GitResult {
  ok: boolean;
  stdout: string;
  exitCode: number;
}

export interface PullTargetsDeps {
  providerRemote(dir: string): Promise<{ info: ProviderRepoInfo; remote: string } | null>;
  listBranches(input: { dir: string; info: ProviderRepoInfo; maxPages: number }): Promise<
    { ok: true; branches: ForgeBranch[]; truncated: boolean } | { ok: false; error: string }
  >;
  branchInfo(input: { dir: string; info: ProviderRepoInfo; name: string }): Promise<
    { ok: true; branch: ForgeBranch | null } | { ok: false; error: string }
  >;
  remoteDefaultBranch(input: { dir: string; info: ProviderRepoInfo }): Promise<
    { ok: true; name: string } | { ok: false; error: string }
  >;
  git(args: string[], dir: string): Promise<GitResult>;
}

/**
 * Local, non-interactive git: a 5 s timeout and `GIT_TERMINAL_PROMPT=0` (no
 * command here talks to the network, but a credential helper must never block
 * the request either). Through `coreSpawn` like every spawn in the core.
 */
async function runGit(args: string[], dir: string): Promise<GitResult> {
  let proc: ReturnType<typeof coreSpawn>;
  try {
    proc = coreSpawn(["git", ...args], {
      cwd: dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv({ GIT_TERMINAL_PROMPT: "0" }),
    });
  } catch {
    return { ok: false, stdout: "", exitCode: 127 };
  }
  const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
  try {
    const [stdout, , exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    return { ok: exitCode === 0, stdout: stdout.trim(), exitCode };
  } finally {
    clearTimeout(timer);
  }
}

const defaultDeps: PullTargetsDeps = {
  providerRemote: providerRemoteForDir,
  listBranches: (i) => gitHost.listBranches(i),
  branchInfo: (i) => gitHost.branchInfo(i),
  remoteDefaultBranch: (i) => gitHost.remoteDefaultBranch(i),
  git: runGit,
};

export interface PullTargetsInput {
  dir: string;
  heads: string[];
  storedBase?: string | null;
  storedBaseSha?: string | null;
  liveHead?: string | null;
}

/** A branch name that may reach a git argv or a forge URL. */
export function isSafeBranchName(name: string): boolean {
  return name.length > 0 && !name.startsWith("-") && validateBranchName(name).ok;
}

/**
 * Whether `ancestor` is reachable from `ref`: true / false, or null when git
 * can't say (an object or ref is missing, git errored). Both operands are
 * validated by the caller (a hex sha and a `refs/heads/<safe name>`), and
 * `--end-of-options` keeps even a hostile value from being read as an option.
 */
async function isAncestor(deps: PullTargetsDeps, dir: string, ancestor: string, ref: string): Promise<boolean | null> {
  let res = await deps.git(["merge-base", "--is-ancestor", "--end-of-options", ancestor, ref], dir);
  // Exit 129 is a usage error: a git too old to know `--end-of-options`. The
  // operands are validated, so the plain form is safe.
  if (res.exitCode === 129) res = await deps.git(["merge-base", "--is-ancestor", ancestor, ref], dir);
  if (res.exitCode === 0) return true;
  if (res.exitCode === 1) return false;
  return null;
}

/**
 * The stored base is stale when the task's branch was moved off it: the pinned
 * create-time sha is not an ancestor of the live head AND the base's remote tip
 * is not a known ancestor either. Either being an ancestor proves the branch
 * is still on (or was rebased or merged forward onto) the base, so it is not
 * stale. `null` (unknown, treated as not stale) when neither can be proven.
 * A base that merely advanced on the remote while the head still contains the
 * pinned sha is NOT stale.
 */
async function storedBaseStale(
  deps: PullTargetsDeps,
  dir: string,
  liveHead: string | null | undefined,
  storedBaseSha: string | null | undefined,
  tipSha: string | null,
): Promise<boolean | null> {
  if (!liveHead || !isSafeBranchName(liveHead)) return null;
  const headRef = `refs/heads/${liveHead}`;
  const pinned = storedBaseSha && SHA_RE.test(storedBaseSha) ? storedBaseSha : null;
  const pinnedAncestor = pinned ? await isAncestor(deps, dir, pinned, headRef) : null;
  if (pinnedAncestor === true) return false;
  let tipAncestor: boolean | null = null;
  if (tipSha && SHA_RE.test(tipSha)) {
    const have = await deps.git(["cat-file", "-e", `${tipSha}^{commit}`], dir);
    if (have.ok) tipAncestor = await isAncestor(deps, dir, tipSha, headRef);
  }
  if (tipAncestor === true) return false;
  if (pinnedAncestor === false) return true;
  return null;
}

/** `<remote>/HEAD`'s branch name, from the local remote-tracking ref (no network). */
async function localDefaultBranch(deps: PullTargetsDeps, dir: string, remote: string): Promise<string | null> {
  if (!isSafeBranchName(remote)) return null;
  const res = await deps.git(["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`], dir);
  if (!res.ok || !res.stdout) return null;
  const raw = res.stdout.trim();
  return raw.startsWith(`${remote}/`) ? raw.slice(remote.length + 1) : raw;
}

export async function pullTargets(
  input: PullTargetsInput,
  deps: PullTargetsDeps = defaultDeps,
): Promise<({ ok: true } & PullTargetsResult) | { ok: false; error: string }> {
  const dir = input.dir;
  const resolved = await deps.providerRemote(dir);
  if (!resolved) return { ok: false, error: "project does not have a supported git remote (GitHub, GitLab, or Bitbucket)" };
  const { info, remote } = resolved;

  const remotesRes = await deps.git(["remote"], dir);
  const remotes = remotesRes.ok ? remotesRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [remote];

  let defaultBranch = await localDefaultBranch(deps, dir, remote);
  if (!defaultBranch) {
    const forge = await deps.remoteDefaultBranch({ dir, info });
    defaultBranch = forge.ok ? forge.name : null;
  }

  const listing = await deps.listBranches({ dir, info, maxPages: BRANCH_LIST_MAX_PAGES });
  const listed = listing.ok ? listing.branches.slice(0, BRANCH_CAP) : [];
  const truncated = listing.ok ? listing.truncated || listing.branches.length > BRANCH_CAP : false;
  const byName = new Map(listed.map((b) => [b.name, b]));

  /** Whether the forge has the branch, plus its tip when the forge reported one. */
  const remoteFact = async (name: string): Promise<{ onRemote: boolean | null; sha: string | null }> => {
    if (!isSafeBranchName(name)) return { onRemote: false, sha: null };
    if (!listing.ok) return { onRemote: null, sha: null };
    const hit = byName.get(name);
    if (hit) return { onRemote: true, sha: hit.sha };
    if (!truncated) return { onRemote: false, sha: null };
    // Beyond a truncated listing: ask the forge about this one name.
    const one = await deps.branchInfo({ dir, info, name });
    if (!one.ok) return { onRemote: null, sha: null };
    return { onRemote: one.branch !== null, sha: one.branch?.sha ?? null };
  };

  const headNames = [...new Set(input.heads)];
  const heads = await Promise.all(
    headNames.map(async (name) => ({ name, onRemote: (await remoteFact(name)).onRemote })),
  );

  let storedBase: PullTargetsResult["storedBase"] = null;
  if (input.storedBase) {
    const fact = await remoteFact(input.storedBase);
    const stale = isSafeBranchName(input.storedBase)
      ? await storedBaseStale(deps, dir, input.liveHead, input.storedBaseSha, fact.sha)
      : null;
    storedBase = { name: input.storedBase, onRemote: fact.onRemote, stale };
  }

  return {
    ok: true,
    provider: info.provider,
    host: info.host,
    owner: info.owner,
    name: info.name,
    remote,
    remotes,
    defaultBranch,
    branches: listed.map((b) => b.name),
    branchesTruncated: truncated,
    branchesError: listing.ok ? null : listing.error,
    heads,
    storedBase,
  };
}
