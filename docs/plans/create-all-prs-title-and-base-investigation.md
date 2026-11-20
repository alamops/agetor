# Investigation — Create all PRs: wrong title/body, wrong base, and a base-aware PR link

| Field | Value |
| --- | --- |
| Date | 2026-11-17 |
| Change | Fix the run panel's "Create all PRs" so each pull request gets the title/description the agent proposed for *that* repository and targets the right base branch (not always the repo default), and change the Commit & push prompt so the agent's PR link already targets the destination branch. Informs the grill and the plan. |
| Agents | none: the pipeline step forbade subagents, so the codebase, history, web and spike passes ran inline |
| Flags | none (spikes ran in the session scratchpad, read-only on the repo) |

## 1. What we know

### The two defects, traced to code

**A. Title/body.** `createAllPrs` (`src/mainview/components/kanban/RunPanel.tsx:3785`) reads proposals with
`latestProposalsForTargets(events, todo.map(r => r.name))` (`RunPanel.tsx:3814`). That maps proposals to
repositories **only** through a `Repository: <name>` label line (`REPO_LABEL_RE`, `src/mainview/lib/pr-proposal.ts:174`;
`parseRepositoryProposals`, `pr-proposal.ts:226`). Without labels, an unlabeled proposal is attributed only when
exactly one repository is targeted (`latestProposalsForTargets`, `pr-proposal.ts:288`; fallback at `pr-proposal.ts:326`).
A repository with no attributed proposal gets `title: proposal?.title || task.title` and an empty body
(`RunPanel.tsx:3828`). The proposal's parsed `link` (`pr-proposal.ts:110`) is never read by any caller.

**B. Base.** Every PR's base is `defaults.base` from `GET /github/pull-defaults` (`RunPanel.tsx:3825`, `:3830`), which for
GitHub is `defaultBaseBranch(dir)`: `git symbolic-ref refs/remotes/origin/HEAD`, else the literal `"main"`
(`src/bun/github.ts:1276`). GitLab/Bitbucket use the provider's default branch (`src/bun/git-host.ts:360`). Nothing
consults the branch the task was created from. The task can't supply it anyway: `createTask` resolves the
requested base ref (`src/bun/orchestrator.ts:12542`, multi `:12577`) to a **sha** and stores only that
(`tasks.base_ref`, `repositories[].baseRef`). The branch *name* the user picked in the per-repository base picker
(`SelectProjectsDialog.tsx:376`, a `BranchInfo.name` such as `develop` or `origin/develop`) is discarded. No column
holds it: dev DB `pragma_table_info('tasks')` has `base_ref` only, and the last migration is `091_task_repositories.sql`.

**C. The prompt.** `commitPushPrompt` (`src/shared/types.ts:6715`) is shared by the RunPanel chip, `agetor commit`
(`src/cli/commands/commit.ts:44`) and the TUI `c` key (`src/cli/tui/Dashboard.tsx:486`). Single repo: "print the
full link to open a pull request for the branch (git prints one in the push output; otherwise build it from the
remote URL)" (`types.ts:6755`). Multi: a `Repository: <name>` line, then the link, title and description per
repository (`types.ts:6735`). Neither names a destination branch, and the link git prints on push
(`…/pull/new/<branch>` on GitHub) always targets the **default** branch.

### What actually happened (prod DB, read-only; names withheld)

- One real use of Create all PRs exists. It ran on a two-repository pipeline task (an "app" repo and an "infra" repo), from the panel
  of its **pipeline step "Commit And Push"**. Both entries were stamped with a PR URL. 14 multi-repo rows exist in total, and every
  other one has no PR.
- That step's prompt is the **owner's own pipeline step text**, a copy of the *single-repository* `commitPushPrompt`
  with no `Repository:` label instruction. Agetor appended the `Repositories:` block to it. The agent's reply proposed **three** PRs with
  headings like `**PR-1: <repo> → \`main\`.**`, a bare `…/pull/new/<branch>` link each, then `PR title:`/`PR description:`
  blocks. It named a non-default destination in prose: "infra → `<feature-base>` … not `main`".
- `run_events` has **zero** sends of the canned multi-repo prompt ("Commit all changes in every repository"). The
  labeled format Create all PRs depends on has never been produced in real use.
- Installed app (`/Applications/Agetor.app`, `version.json` 1.2.0, bundle checked by `grep`) contains the same
  `createAllPrs` code as this branch (`title:c?.title||e.title … base:a.base`).

### Prior decisions and standards that apply

- Contract: `docs/plans/multi-repo-tasks.md` T12 and assumption A10 ("Agents print `Repository: <name>` before each
  proposal; the parser tolerates a missing label only when exactly one repo has a proposal"). The grill decision is
  `docs/plans/multi-repo-tasks-grill.md` #9 (per-repo best effort; results and retries per repo). The link ask comes from
  `docs/plans/commit-push-pr-link.md` (#120). The task ask itself lives only in this pipeline's prompt, outside the
  repo, so the plan must restate it.
- `docs/architecture/multi-repo-tasks.md:292-306`: pull-create stamps by worktree path. A PR opened from a pipeline step is
  stamped on the step only (documented limitation). Proposal prefill is repository-scoped. `docs/architecture/run-panel.md:73,79`
  covers Create all PRs and its in-flight store. Both need updating with the change.
- CLAUDE.md rules that bear on this:
  - A new task column is **server-managed**: excluded from `ALLOWED_PATCH_FIELDS` and from the generic SET, never bumps
    `updated_at`, and is written by a targeted UPDATE.
  - Migrations are append-only numbered `.sql` files plus an `index.ts` entry. The next one is `092`.
  - Prompts never name the product (`commitPushPrompt` already complies).
  - `src/shared/` stays free of runtime imports from either process.
  - Every new route needs a `ROUTE_POLICY` entry, plus `pathParams` when it takes a path.
- Memory: never commit real ticket ids, client names or repo names. Fixtures stay synthetic.

### Runtime and trust shape

The webview drives PR creation through the Bun core's localhost API with the user's stored forge token
(`createGitHubPull`, `src/bun/github.ts:1614`). Every proposal field (title, body, link, and with this change base and
head) is **agent-written text**, so a confused or prompt-injected agent can put any URL in its reply. The guard is
that a link may only *attribute* a proposal to a repository whose remote owner/name and live PR head it matches.
A base read from the link only changes the target branch of a PR the user asked for. It never reaches another repo or
head. One webview instance; Create all PRs keeps a per-task in-flight store (`src/mainview/lib/multi-repo-ui.ts:233`).

### Web facts (forge link formats)

- GitHub (documented): a compare URL with query params pre-fills a PR,
  `https://github.com/<owner>/<repo>/compare/<base>...<head>?quick_pull=1` (also `title`, `body`, `labels`,
  `milestone`, `assignees`, `projects`, `template`). `expand=1` is widely used but undocumented. Source:
  <https://docs.github.com/en/pull-requests/reference/using-query-parameters-to-create-a-pull-request>.
  `git check-ref-format` forbids `..` in ref names, so splitting `<base>...<head>` on `...` is unambiguous.
- GitLab (community-sourced, not in official docs):
  `…/-/merge_requests/new?merge_request[source_branch]=<head>&merge_request[target_branch]=<base>` (brackets
  percent-encoded in git's own push hint). Source:
  <https://fabianlee.org/2023/05/21/gitlab-generating-url-that-can-be-used-for-merge-request-from-fork-to-upstream/>,
  <https://gitlab.com/gitlab-org/gitlab/-/issues/15964>.
- Bitbucket Cloud (community-sourced): `…/pull-requests/new?source=<head>&dest=<base>`. No official parameter list.
  Source: Atlassian Community threads ("Pull Request URL Parameters").

## 2. What we proved

| Question | Verdict | Evidence (command → output) | Versions | Artifact |
| --- | --- | --- | --- | --- |
| Does Create all PRs attribute the real reply's proposals when both repos are targeted? | **No.** Both repos fall back to `task.title` (the step's "`<pipeline>` · Commit And Push") and an empty body | `bun check.ts <reply>` → `labeled blocks: 0`, `map size for 2 targets: 0` | this branch (v1.2.1), bun in PATH | scratchpad `spikes/real-reply-attribution/check.ts` |
| With one target (a retry after a partial failure, or one repo left), is the unlabeled fallback right? | **No (latent bug).** It returns the *last* proposal in the reply, so the app repo would get the infra PR's title/body | same script → `if only qa targeted: <infra title>` | same | same |
| Can proposals be attributed by their link (remote owner/repo plus head branch)? | **Yes, 3/3.** Two match the two repos' live heads. The third is a second branch in the app repo and would be skipped | `bun by-link.ts <reply>` → `{repo, head}` per proposal | same | scratchpad `spikes/real-reply-attribution/by-link.ts` |
| Does a compare link carry the base? | **Yes.** `compare/fix/a...fix/b?quick_pull=1` gives base `fix/a`, and the encoded `release%2F1.2...feature%2Fa` decodes | same script | same | same |
| Was the infra task created from a non-default branch? | **Yes.** The pinned base sha is exactly the tip of `origin/<feature-base>`, while `origin/HEAD` is `origin/main` | `git for-each-ref --points-at <baseRef>` → `origin/<feature-base>` (plus 2 local refs); `git symbolic-ref --short refs/remotes/origin/HEAD` → `origin/main` | local git | — |
| Is the create-time base always the right destination? | **No.** Mid-pipeline the agent reset the app repo's task branch onto `origin/main` (reflog `branch: Reset to origin/main`), so its pinned base (a feature branch) went stale and `main` was correct | `git merge-base --is-ancestor <baseRef> <task branch>` → not an ancestor; `git reflog` | local git | — |
| Could the investigation read the two real PRs' title/base? | **Inconclusive.** `gh` is not logged in, and reading through the local core API was denied | `gh pr view` → "gh auth login" | — | — |

Would the tests notice? The two e2e Create all PRs tests (`e2e/multi-repo-task.spec.ts:480`, `:555`) assert only the
PR count, the `Closes #N` placement and the stamps. No test asserts the **title**, the **base**, or proposal
attribution through the button. `pr-proposal.test.ts:470-650` covers only the labeled format. A green suite
proves nothing about either defect today.

## 3. What we're assuming

- **"Not creating the PR when the target is not the default branch"** means the PR is opened against the default branch
  (wrong base), not that creation errors out. The code always sends `origin/HEAD` and the infra entry got stamped. If it
  actually failed (a 422), there is a second root cause to find.
- **The agent knows the destination.** In the real case it named it correctly in prose. Asking for a compare-style link
  (or an explicit base line) makes that machine-readable. If agents ignore the ask, Create all PRs still needs a fallback base.
- **The GitLab `target_branch` and Bitbucket `dest` parameters work as described.** If they don't, the link still opens the
  MR/PR page, just without the target pre-selected. Only GitHub's form is officially documented.
- **One PR per repository, head = the live checkout** (`repositoryPrHead`, `src/mainview/lib/commit-push.ts`) stays the
  model. The real reply's second app-repo branch is out of reach without a scope change.

## 4. What we must ask the owner

1. **Base precedence for Create all PRs.** Proposed order:
   1. the base in the agent's newest matching link (or explicit base line);
   2. the base branch recorded at task creation (new, see Q2);
   3. `origin/HEAD`.

   The real case needs 1 to beat 2 (the app repo was moved onto `main`) and 2 to beat 3 (the infra base).
2. **Record the create-time base branch name?** That needs migration `092` (a server-managed `tasks.base_branch`), a
   `repositories[].baseBranch` field (`parseTaskRepositories`, `src/bun/db.ts:1021`), `createTask`, and the pipeline
   step copy (`src/bun/pipeline-runner.ts:1434`). Existing rows can't be backfilled reliably: `--points-at` returned three
   refs for one sha. And should a base of `HEAD` record the branch the source repo had checked out at create time?
3. **Attribution without labels.** Attribute by link: the remote owner/repo, from `GET /github/provider-info`, plus the
   live head. Labels stay as an alternative. And should the "single unlabeled → single target" fallback be dropped
   whenever the proposal's link names a different repo? That fixes the latent wrong-repo bug.
4. **No proposal for a repository.** Today such a PR opens with the task title (for a step, "`<pipeline>` · Commit And
   Push") and an empty body. Options: (a) skip that repo and report "no PR proposal found"; (b) use the pipeline parent's title;
   (c) keep the current fallback.
5. **Confirm before creating?** One-click as today, or a small confirm listing each repo's head → base and title (editable)?
6. **Prompt shape.**
   - Both prompts (single and multi) ask for a destination-targeted link: GitHub `compare/<base>...<head>?quick_pull=1`
     (or `expand=1`), GitLab `target_branch`, Bitbucket `dest`.
   - Should agetor put the known base in the prompt ("target `<base>` unless the work moved to another base")?
   - Should the agent also print an explicit `Base: <branch>` line, which is easier to parse than a URL?
7. **Single-repo "Create PR" chip.** Also prefill the composer's base from the proposal? That adds `base` to
   `GitHubPullPrefill` (`src/mainview/components/kanban/GitHubDialog.tsx:199`, consumed at `:1235`; the defaults
   effect at `:2290` must not overwrite it).
8. **A base that doesn't exist on the remote.** Fail that repository with a clear message (recommended), or fall back to
   the default branch?
9. **More than one PR per repository** (the real reply proposed two for the app repo): out of scope?
10. **Owner-authored pipeline prompts.** The owner's "Commit And Push" step reproduces the old single-repo text. Rely on
    link attribution to cover it, or also update that pipeline or bundle guidance? The latter is outside this repo.
11. **Please confirm** what the two real PRs got for title and base. The investigation couldn't read them.

## 5. Completeness inventory

- **Callers (direct and indirect)**
  - `createAllPrs` and the Create all PRs button (`RunPanel.tsx:3785`, `:5068-5080`).
  - The single "Create PR" chip (`RunPanel.tsx:5081-5106`, using `latestProposalForRepository`/`latestPrProposal`).
  - `GitHubDialog` New-PR composer (prefill `:199`, `:1229-1240`; defaults `:2283-2296`; create `:3236-3249`).
  - `commitPushPrompt`, sent by the RunPanel chip (`RunPanel.tsx:3712`), `agetor commit` (`src/cli/commands/commit.ts:44`)
    and the TUI `c` key (`src/cli/tui/Dashboard.tsx:486`); re-exported from `src/mainview/lib/api.ts:193`.
  - `/github/pull-defaults` and `/github/pull-create` (`src/bun/server.ts:3337`, `:3350`; policy `src/bun/route-policy.ts:241-242`).
- **Entry points new code must be wired into**
  - Parser additions in `src/mainview/lib/pr-proposal.ts` (exported, used by RunPanel).
  - Remote identity per repo via `api` `/github/provider-info` (`src/mainview/lib/api.ts:1232`).
  - If the base is stored: `migrations/092_*.sql` and `src/bun/migrations/index.ts`, `createTask`, `toTask`/`parseTaskRepositories`,
    the server-managed-column lists, and pipeline step creation.
- **Propagation surface**
  - `PrProposal` (would gain `base`/`head`/`repo`).
  - `GitHubPullPrefill` (`base?`).
  - `Task`/`TaskRepository`/`TaskRepositoryInput` in `src/shared/types.ts:2078-2114`.
  - CLI `TaskRow` fixtures and e2e `TaskRow` types.
  - The `repositories` JSON (`setRepositories` merge rules).
- **Existing data**
  - No backfill is possible from the pinned sha alone. Existing tasks fall back.
  - 14 multi-repo rows in the owner's DB; single-repo rows carry the same gap.
- **Tests pinning current behavior (will change)**
  - `src/shared/branch.test.ts:190-240` (single prompt wording and order).
  - `src/shared/multi-repo.test.ts:184-223` (multi prompt; "single prompt byte-identical").
  - `src/mainview/lib/pr-proposal.test.ts:470-660`, including "attributes an unlabeled proposal only when there is one target" at `:628`.
  - `src/mainview/lib/commit-push.test.ts:155`.
  - `src/cli/tui/Dashboard.test.tsx:175-222` (compares to `commitPushPrompt(...)`, so it follows automatically).
  - `e2e/multi-repo-task.spec.ts:480`, `:555`.
- **E2E seam gap.** The fake claude driver's generic turn emits `fake response to: <prompt>` on **stdout**
  (`src/bun/agents.ts:3547`), and the parser reads only the `assistant` stream. An e2e that drives proposals through
  the button needs a new `FAKE_CLAUDE_*_PROMPT_MARKER` that emits assistant text (precedent:
  `FAKE_CLAUDE_MD_IMAGE_PROMPT_MARKER`, `agents.ts:2398`). The GitHub stub already records POST bodies, so title and
  base are assertable.
- **Docs / config describing current behavior**
  - `docs/architecture/multi-repo-tasks.md:292-306`.
  - `docs/architecture/run-panel.md:73,79`.
  - The `commitPushPrompt` doc comment (`types.ts:6686-6714`) and the `pr-proposal.ts` header comment.
  - The Commit & push button tooltip (`RunPanel.tsx:5053`).
  - `docs/plans/multi-repo-tasks.md` A10 (superseded by the new rule).
- **What the change would orphan.** Possibly the unlabeled single-target fallback in `latestRepositoryProposals`
  (depending on Q3). Nothing else.

## 6. Runnability

- Start locally: `bun install`, then `bun run dev:hmr` (Vite plus Electrobun) against `~/.agetor-dev`. Never use prod `~/.agetor`.
  In agetor worktrees, prefix `PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`.
- Tests:
  - `bun run typecheck`
  - `bun test src/mainview/lib/pr-proposal.test.ts src/mainview/lib/commit-push.test.ts src/mainview/lib/multi-repo-ui.test.ts src/shared/branch.test.ts src/shared/multi-repo.test.ts src/cli/tui/Dashboard.test.tsx`
  - Server and DB, if the base is stored: `bun test src/bun/pull-create-task-url.test.ts src/bun/server-multi-repo.test.ts src/bun/orchestrator-multi-repo.test.ts src/bun/db-run-events-plans.test.ts src/bun/route-policy.test.ts`
- E2E: Playwright, run with `bun node_modules/@playwright/test/cli.js test e2e/multi-repo-task.spec.ts` (not `bunx`;
  one run at a time). It uses the GitHub stub (`startGitHubStub`) and local bare remotes (`createPushedMultiTask`).

## 7. Risks and blast radius

- **Trust.** A link-derived base or head must be bounded by the repo's own remote and live head, or a stray URL could
  attribute another repository's title/body.
- **Base guessing.**
  - A wrong base opens a PR showing someone else's commits (the agent's own warning: "otherwise the PR will show
    \#<n>'s 47 commits").
  - A base that doesn't exist makes GitHub answer 422.
  - `defaultBaseBranch` falls back to a literal `"main"` when `origin/HEAD` is unset (a `master` repo would get the wrong base).
- **Prompt regressions.**
  - Changing the canned text changes the CLI/TUI too.
  - Older transcripts carry `pull/new/<branch>` links with no base. The parser must keep accepting them, with base unknown.
- **Pipelines.** A PR opened from a step panel stamps the step only (documented). The parent's Create all PRs can still
  re-try it and surface a 422.
- **Migration** (if chosen) is one-way like every migration. The server-managed column rules apply.
