# Grill — Create all PRs: right title/body, right base, base-aware PR link

| Field | Value |
| --- | --- |
| Date | 2026-11-17 |
| Source | The pipeline's overall goal (restated below; it isn't in the repo otherwise) and the investigation brief `docs/plans/create-all-prs-title-and-base-investigation.md` |
| Mode | interactive via decision form, answered by the owner in 3 rounds (21 + 10 + 7 questions, nothing skipped, nothing delegated) |
| Answers | `docs/plans/create-all-prs-title-and-base-grill/round-1/answers.json`, `round-2/answers.json`, `round-3/answers.json` |
| Flags | none |
| Spec | Restated here because the ask lives only in the pipeline prompt: *"The Create All PRs button is wrongly getting the PR's title and body the commit & push output generates for multiple PRs. And it is not creating the PR when the target is not the repo's default branch. We must fix it. Also, include reviewing the commit and push button's prompt to ask the agent to formulate the link already targeting the destination branch."* |

The owner answered every one-way door. None is unratified.

## What the grill changed about the work

The investigation scoped a parser and base fix. The owner widened it in three ways the plan must carry:

1. **Several PRs per repository are in scope.** Create all PRs opens one PR per matching proposal, not one per repository. It also appears on **single-repo** tasks whose proposals name two or more heads.
2. **`prUrl` is replaced by a `prs` list everywhere.** This covers the task, each repository entry, every webview reader, View PR and the context menu. `prUrl` stays in the Task JSON only as a deprecated value derived from `prs`.
3. **Every press goes through an editable confirm list.** It shows head → base and the title, with "base from" and "no proposal" hints, and extra-head rows start unchecked.

## Decisions

Source "owner (accepted)" means the owner picked my recommendation. "owner (override)" means they picked something else.

| # | Topic | Question | Answer | Source |
| --- | --- | --- | --- | --- |
| 1 | Facts | What did the two real PRs get? | Both **opened**, against `main`, with the step title ("`<pipeline>` · Commit And Push") and an empty body. "Not creating" in the goal means *wrong base*. There's no second root cause. | owner, accepted (round-1#real-prs) |
| 2 | Base | Precedence for a repository's **live-head** PR | 1. The base branch stored at task creation. **2. If git proves the stored base stale, the agent's base.** "Stale" means the stored base's remote tip isn't an ancestor of the head (`git merge-base --is-ancestor`). 3. The remote default (`origin/HEAD`, then the provider's default). The confirm list shows both bases when they differ. | owner, override (round-1#base-precedence: stored > link > default), refined (round-2#stale-stored-base, accepted) |
| 3 | Base / data | Store the create-time base branch name? | **Yes.** Migration `092` adds a server-managed `tasks.base_branch`. Each repository entry gets a `baseBranch` field in its JSON. `createTask` records it. | owner, accepted, one-way door (round-1#store-base) |
| 4 | Base / data | What gets recorded when the base is `HEAD`? | The source repo's checked-out branch, **only if it exists on the remote**. Otherwise nothing, and the next source in #2 applies. | owner, accepted (round-1#head-base) |
| 5 | Base / errors | The chosen base isn't on the remote | **Fail that repository** with a clear message, e.g. "infra: base branch `develop` isn't on origin". There's no silent fallback. The other repositories continue and a retry is possible. | owner, accepted (round-1#missing-base) |
| 6 | Attribution | How is a proposal matched to a repository? | **A link match or a `Repository:` label.** A link matches when its host and owner/repo equal that repository's remote and its head names the branch. The blind "one unlabeled proposal goes to the one target" fallback is dropped, and a labeled block whose link names another repo is ignored for that repo. | owner, accepted (round-1#attribution) |
| 7 | Attribution | Which proposal is current? | The newest matching proposal **per (repository, head)**, across all runs. | owner, accepted (round-1#proposal-scope, extended by round-2#c-proposal-key) |
| 8 | Fallback | No proposal for a repository | The **root task's** title (the pipeline parent's for a step) and an empty body, flagged "no proposal" in the confirm list. Owner's note: "current behavior is using Pipeline name in the PR title (wrong)". | owner, accepted with note (round-1#no-proposal) |
| 9 | UX | One click, or confirm first? | **An editable confirm list.** One row per PR: `head → base`, where the base is a select of the remote's branches, an editable title, and "base from: task / agent / default", "no proposal" and base-mismatch hints. Then Create. | owner, accepted (round-1#confirm-list) |
| 10 | UX | Should the single-repo Create PR chip prefill the base? | **Yes**, by the same base rules. Adds `base?` to `GitHubPullPrefill`, and the composer's defaults effect must not overwrite it. | owner, accepted (round-1#single-chip-base) |
| 11 | Prompt | Link format | **A per-forge destination link.** GitHub: `https://github.com/<owner>/<repo>/compare/<base>...<head>?quick_pull=1`. GitLab: `…/-/merge_requests/new?merge_request[source_branch]=<head>&merge_request[target_branch]=<base>`. Bitbucket: `…/pull-requests/new?source=<head>&dest=<base>`. | owner, accepted (round-1#link-format) |
| 12 | Prompt | Should the prompt name the known base? | **Yes, with an escape clause:** "target `<base>` unless you moved the branch onto another base; then target that one". In a multi-repo prompt it goes on each repository's line. Used only when a base is stored. | owner, accepted (round-1#prompt-names-base) |
| 13 | Prompt | Explicit `Base:` line? | **Yes, plus the link.** Both prompts (single and multi) ask for `Base: <branch>` right above the link, inside each repository's block for multi. | owner, override (round-1#base-line); placement accepted (round-2#c-base-line-prompt) |
| 14 | Prompt / parse | The `Base:` line and the link disagree | **The `Base:` line wins**, and the confirm list flags the mismatch. "The agent's base" means the `Base:` line, then the link's base. | owner, accepted (round-2#base-line-conflict) |
| 15 | Scope | Several PRs per repository | **In scope:** one PR per matching proposal. | owner, override (round-1#multi-pr-per-repo) |
| 16 | Trust | Which heads may be opened besides the live checkout? | Any branch **on that repository's remote** that a proposal names. Each gets a confirm-list row that is **unchecked by default**; the live-head row is checked. | owner, accepted, one-way door (round-2#extra-heads-trust) |
| 17 | Base | Base for an extra (non-live-head) PR | The stored base belongs to the task branch only. An extra PR's base is the agent's base (`Base:` line, then link), then the remote default. It's editable in the confirm list. | owner, accepted (round-2#c-extra-base) |
| 18 | Errors | An extra head that isn't on the remote | Its row is shown **disabled** with "branch `<x>` isn't on origin", and no PR is attempted. | owner, accepted (round-2#c-extra-head-pushed) |
| 19 | Duplicates | A second press, or a PR that already exists | A head already stamped (live or extra) is skipped. A forge "a pull request already exists" answer shows as "already open" (with the URL when the forge returns one), not as a failure. | owner, accepted (round-2#c-duplicate) |
| 20 | Data | How are extra PRs recorded? | **`prUrl` is replaced with a `prs` list everywhere:** on the task, on each repository entry, and in every reader. | owner, override, one-way door (round-2#extra-pr-stamping) |
| 21 | Data | Shape of one PR entry | `{ url, head, base, number: number \| null, createdAt }`, in creation order. The **live-head PR** is the entry whose `head` matches the task's or repository's branch, not simply the first one. | owner, accepted (round-3#pr-entry-shape) |
| 22 | Data / migration | What happens to the old `tasks.pr_url` column? | 092 adds a server-managed `tasks.prs` JSON column and backfills it from `pr_url`. The old **column stays and is no longer read or written** (downgrade-safe). Multi-repo `repositories[].prUrl` converts to `prs` at read time and is rewritten on the next write; no column change. | owner, accepted, one-way door (round-3#pr-url-column) |
| 23 | Contract | `prUrl` in the Task JSON (`GET /tasks`, `agetor ls --json`) | **Add `prs`, and keep `prUrl` as a deprecated, derived, read-only field** holding the first PR's URL. Agetor never reads it itself. | owner, override, one-way door (round-3#task-json-field) |
| 24 | UX | Create all PRs on single-repo tasks | It appears when the newest matching proposals name **two or more distinct heads without a PR**, next to the existing Create PR chip, with the same confirm list. | owner, override (round-2#single-repo-multi); trigger accepted (round-3#single-repo-trigger) |
| 25 | UX | View PR with several PRs | **List them all.** The run panel shows each `head → base` link. The task card and context menu get one "View PR: `<head>`" item per PR, in a submenu past 3. | owner, accepted (round-3#view-pr-many) |
| 26 | Data | Server-managed rules | `tasks.base_branch` and `tasks.prs` are server-managed: not in `ALLOWED_PATCH_FIELDS`, skipped by the generic SET, never bump `updated_at`, written by targeted UPDATEs. Both go in `092`, and the CLAUDE.md list is updated. | owner, accepted (round-3#c-server-managed) |
| 27 | Pipelines | Step creation | A step's task-level `prs` starts empty (like `prUrl: null` today, `pipeline-runner.ts:1441`). `baseBranch` is copied like `baseRef` (`:1434`). `repositories[]`, with each entry's `prs` and `baseBranch`, is copied as today (`:1437`). | owner, accepted (round-3#c-pipeline-step) |
| 28 | Pipelines | A PR opened from a step's panel | Unchanged: it's stamped on the step only (already documented). | owner, accepted (round-1#c-pipeline-step-stamp) |
| 29 | Data | Backfilling the base for existing tasks | None. Existing tasks have no stored base and fall through to the next source in #2. | owner, accepted (round-1#c-no-backfill) |
| 30 | Parse | Name normalization | A picked `origin/develop` is stored as `develop` (the remote prefix is stripped when it names a configured remote). Link branches are URL-decoded (`release%2F1.2` → `release/1.2`). | owner, accepted (round-1#c-normalize) |
| 31 | Parse | Old transcripts | Old `pull/new/<branch>` links still attribute a proposal (by owner/repo and head), with no base taken from them. | owner, accepted (round-1#c-legacy-links) |
| 32 | Owner's pipeline | The owner's own "Commit And Push" step text | No code or doc change. Link attribution covers it, and the owner updates their step text themselves. | owner, override (round-1#owner-pipeline) |
| 33 | Acceptance | Tests | Unit tests for link and `Base:` parsing, attribution, base precedence (including stale detection) and the `prs` migration. Updated prompt tests. A new `FAKE_CLAUDE_*_PROMPT_MARKER` that emits proposal text on the **assistant** stream. An e2e that drives Create all PRs through the confirm list and asserts each PR's **title, body and base** via the GitHub stub's recorded POST bodies, including a non-default base, a stale stored base, an unchecked extra head and a single-repo task with two heads. | owner, accepted (round-1#c-tests) |
| 34 | Docs | Docs updated in the same change | `docs/architecture/multi-repo-tasks.md` (pull-create), `docs/architecture/run-panel.md` (Create all PRs), `docs/architecture/persistence.md` (new server-managed columns), the CLAUDE.md server-managed list, the `commitPushPrompt` and `pr-proposal.ts` header comments, and the Commit & push tooltip. `docs/plans/multi-repo-tasks.md` A10 is marked superseded. | owner, accepted (round-1#c-docs) |

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| `createAllPrs` attribution, base and confirm list (`RunPanel.tsx:3785`) | in this change | #2, #6, #9 |
| Single Create PR chip base prefill (`GitHubPullPrefill`, `GitHubDialog.tsx:198`, defaults effect `:2290`) | in this change | #10 |
| `commitPushPrompt`, single and multi (`types.ts:6715`), so also `agetor commit` and TUI `c` | in this change | #11–#13; the CLI and TUI follow automatically |
| Migration `092`: `tasks.base_branch`, `tasks.prs`, backfill of `prs` from `pr_url`; `repositories[].baseBranch`/`prs` in `parseTaskRepositories` (`db.ts:1021`) and `setRepositories` | in this change | #3, #20, #22, #26 |
| Every `prUrl` reader moved to `prs`: `db.ts`, `server.ts` stamping, `orchestrator.ts`, `pipeline-runner.ts`, `task-repos.ts`, `RunPanel`, `App.tsx` View PR, `task-context-menu.ts`, `pr-url.ts`, `commit-push.ts`, `multi-repo-ui.ts`, `repo-removal.ts`, `pr-proposal.ts`, `api.ts`, `shared/types.ts`, `shared/multi-repo.ts`, the e2e spec, CLI and TUI fixtures | in this change | #20 ("everywhere") |
| Deprecated derived `prUrl` in the Task JSON | in this change | #23 |
| Create all PRs on single-repo tasks with two or more heads | in this change | #24 |
| Several PRs per repository, extra-head rows, duplicate handling | in this change | #15–#19 |
| E2E seam: a new fake-claude assistant-stream proposal marker | in this change | #33 |
| Docs listed in #34 | in this change | #34 |
| The owner's own pipeline step text | out of scope | It lives in the owner's DB, not the repo; the owner updates it (#32) |
| Stamping a step's PR on the parent | out of scope | Already-documented limitation, a separate ticket (#28) |
| Backfilling the base branch for existing tasks | out of scope | Impossible to do reliably (one sha matched three refs); the fallback covers it (#29) |
| Dropping the `tasks.pr_url` column | out of scope | The owner chose to keep it for downgrade safety (#22); a later cleanup would need its own one-way decision |
| Removing the deprecated `prUrl` Task JSON field | out of scope | The owner chose to keep it (#23); removing it later is its own contract decision |

## Assumptions still open

- **The derived `prUrl` (#23) is computed per level.** The task-level value comes from `task.prs[0]`, so it stays `null` for a multi-repo task, as today. Each repository entry's `prUrl` comes from its own `prs[0]`. If the owner meant "the live-head PR" rather than "the first PR", the derivation changes. That's a one-line difference with no data impact.
- **The GitLab `target_branch` and Bitbucket `dest` parameters work as described** (community-sourced). If they don't, the link opens the new-PR page without a preselected target. The `Base:` line (#13/#14) still gives Create all PRs the base, so nothing breaks.
- **Agents will follow the new prompt.** When they don't (no `Base:` line, a `pull/new/` link), #2's fallback and the editable confirm list cover it.
- **Stale detection needs the stored base's remote tip locally.** It reads `refs/remotes/<remote>/<base>`. If that ref is missing locally, the stored base counts as not proven stale, and #5 decides whether it exists on the remote. The plan should state whether to `git fetch` first (the existing pushed/synced check may already do it).
- **The confirm list's base select lists the remote's branches.** The plan must pick the source: forge API branch list or `git ls-remote --heads`. Either works; no owner decision needed.
