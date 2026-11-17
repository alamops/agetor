# Plan — Create all PRs: right title/body, right base, base-aware PR link

| Field | Value |
| --- | --- |
| Date | 2026-11-17 |
| Source | Spec `docs/specs/create-all-prs-title-and-base.md` (the pipeline's goal, copied unamended). Investigation `docs/plans/create-all-prs-title-and-base-investigation.md`. Grill record `docs/plans/create-all-prs-title-and-base-grill.md` (34 owner decisions, cited below as G#n). |
| Flags | none |
| Gates | grilled + approved by owner (2026-11-17). The owner picked the pinned-sha stale rule (D4, §8 Q1) over G#2's literal wording and approved the §8 calls as written. |
| Status | planned — approved |
| Branch | TBD — set when execution starts (the pipeline worktree is on `fix/agetor-create-all-prs-with-wrong-title-a`) |
| Base SHA | TBD — set when execution starts (HEAD at planning: `32aa7c3a`) |

## 1. Objective & success criteria

Fix the run panel's **Create all PRs** so every pull request it opens gets the title and description the agent proposed for that repository and head, and targets the right base branch even when that isn't the repo default. Rewrite the **Commit & push** prompt so the agent prints a `Base:` line and a link that already targets the destination branch. The owner widened the scope (G#15–#25): several PRs per repository, Create all PRs on single-repo tasks, an editable confirm list, and `prUrl` replaced by a `prs` list everywhere.

Each criterion names the production path that produces it and the test that drives that path.

| # | Criterion | Production path | Proven by |
| --- | --- | --- | --- |
| C1 | Each PR from Create all PRs carries the title/body the agent proposed for **that (repository, head)**: the newest matching proposal across runs. With no proposal, it gets the root task's title (the pipeline parent's for a step), an empty body and a "no proposal" hint. | RunPanel `create-all-prs` button → `CreatePrsDialog` → `buildPrPlan` (`collectRunProposals` → `attributeProposals` → `planPrRows`) → `runPrBatch` → `api.createGitHubPull` → `POST /github/pull-create` → `gitHost.pullCreate` | T17 scenarios S1 and S3 assert each recorded POST's `title`/`body`. T10 unit tests use a fixture shaped like the real three-PR reply. |
| C2 | Each live-head PR targets the base stored at task creation. If git proves that base stale, it targets the agent's base. Otherwise it targets the remote default. An extra head targets the agent's base, then the default. A base that isn't on the remote fails that row with a clear message. | `POST /tasks` → `createTask` → `resolveBaseBranchName` → `tasks.insert` (`base_branch`, `repositories[].baseBranch`). On press: `GET /github/pull-targets` → `pullTargets` (stale check, `onRemote`) → `chooseBase` → `pull-create` `base` | T17 S1 (stored `topic` base reaches the POST), S2 (a reset branch goes to the agent's `main`). Unit tests in T9, T10, T12. |
| C3 | The Commit & push prompt (single and multi, shared by the RunPanel chip, `agetor commit` and the TUI `c` key) asks for a `Base: <branch>` line, then a per-forge link that targets that base, naming the stored base with the escape clause. It still never names the product. | `commitPushPrompt(task)` (`src/shared/types.ts`) reading `baseBranch` → `sendRunInput` / `client.sendInput` / TUI `sendMessage` | T1 prompt tests. `src/cli/tui/Dashboard.test.tsx` compares against `commitPushPrompt(...)` and follows automatically. |
| C4 | One PR per matching proposal. Extra heads must exist on the remote and start unchecked. A head that already has a PR is skipped. A forge "already exists" answer shows as **already open** (with the URL when known), not as a failure. Create all PRs also appears on a single-repo task whose proposals name two or more heads without a PR. | Same path as C1, plus `createGitHubPull` already-exists classification → `/github/pull-create` error passthrough (`code`, `existingUrl`) | T17 S3 (unchecked extra head, missing head disabled), S4 (single-repo two heads), S5 (retry and already-open). Unit tests in T2, T10, T13. |
| C5 | PRs are recorded as `prs: TaskPr[]` on the task and on each repository entry. The run panel, task details and context menu list every PR. Task JSON keeps a deprecated derived `prUrl`. | `pull-create` stamping → `tasks.appendPr` / `tasks.appendRepositoryPr` → `toTask` → `GET /tasks` → RunPanel header View PR menu, repository details, `buildTaskContextMenu` | T7 DB and route tests, T11 builder tests, T17 S4 (`GET /tasks/:id` `prs` has two entries and the header menu lists both). |
| C6 | The single **Create PR** chip prefills the composer's base by the same rules. | RunPanel chip → `buildPrPlan` (live head only) → `onOpenPullRequest({ base })` → `GitHubDialog` prefill | T17 S6 (the composer's base input reads `topic`). T6 unit test. |

## 2. Context & constraints

### Grounded findings (file:line at planning HEAD `32aa7c3a`)

- **Title/body bug.** `createAllPrs` (`src/mainview/components/kanban/RunPanel.tsx:3785`) attributes proposals only through `Repository:` labels (`latestProposalsForTargets`, `src/mainview/lib/pr-proposal.ts:288`), with a blind single-target fallback (`pr-proposal.ts:326`). With no match it falls back to `task.title` and an empty body (`RunPanel.tsx:3828`). The parsed `link` is never read.
- **Base bug.** The base is always `defaults.base` from `/github/pull-defaults` (`RunPanel.tsx:3825`). For GitHub that is `origin/HEAD`, else the literal `"main"` (`src/bun/github.ts:1276`). `createTask` keeps only the resolved **sha** (`src/bun/orchestrator.ts:12542`, multi `:12577`). No column holds the branch name, and the last migration is `091_task_repositories.sql`.
- **Prompt.** `commitPushPrompt` (`src/shared/types.ts:6715`) never names a base, and the link git prints on push always targets the default branch. It is re-exported at `src/mainview/lib/api.ts:193` and used by `src/cli/commands/commit.ts:44` and `src/cli/tui/Dashboard.tsx:486`.
- **Storage.**
  - `Task.prUrl` (`types.ts:2164`) and `TaskRepository.prUrl` (`types.ts:2103`).
  - `pr_url` is written by the **generic** `tasks.update` SET (`src/bun/db.ts:1427`) and by insert (`db.ts:1318`).
  - Single-repo stamping calls `tasks.update(task.id, { prUrl })` (`src/bun/server.ts:3411`). Multi-repo stamping calls `tasks.setRepositoryPrUrl` (`db.ts:1822`, first write wins).
  - `setRepositories` merges the stored `prUrl` (`db.ts:1807`). `parseTaskRepositories` reads `prUrl` (`db.ts:1044`).
- **`prUrl` readers outside tests:**
  - `src/shared/multi-repo.ts:16,77,89`
  - `src/mainview/lib/task-context-menu.ts:147-165`
  - `src/mainview/App.tsx:2497,2509`
  - `src/mainview/lib/repo-removal.ts:84,112`
  - `src/mainview/lib/multi-repo-ui.ts:238-295`
  - `src/mainview/lib/pr-proposal.ts:259-264`
  - `RunPanel.tsx:2995,4195-4230,5069-5110,8930-8946`
  - `src/bun/pipeline-runner.ts:1441`, `src/bun/orchestrator.ts:12941`, `src/bun/task-repos.ts:78`
- **Fixtures.** About 80 test files build `Task` or `TaskRepository` literals with `prUrl: null`, such as `src/cli/test-fixtures.ts:28` and `src/bun/agents.test.ts:2855`. The repo's precedent for a new Task field is "optional at the type level only for fixture compatibility; `toTask` always sets it" (`types.ts:2183-2190`, `issueUrl`/`agentProfileId`/`harnessState`).
- **Forges.** Every forge call goes through `src/bun/git-host.ts` (`pullDefaults` `:360`, `pullCreate` `:382`).
  - `providerRepoForDir` (`src/bun/git-provider.ts:234`) picks `origin` first, then the first parseable remote. It doesn't return the remote's name.
  - None of the three adapters (`github.ts`, `gitlab.ts`, `bitbucket.ts`) has a branch-list or branch-lookup call (`grep branches` finds none).
  - `createGitHubPull` (`github.ts:1614`) reports a 422 as `apiError` = `message` only (`github.ts:1284`), so "already exists" reads as "Validation Failed".
- **The GitHub stub doesn't speak git.** `e2e/github-stub.ts` stubs the REST API only. The e2e repos' `origin` is `https://github.com/agetor-e2e/<repo>.git`, while pushes go to a local bare `local` remote (`e2e/multi-repo-task.spec.ts:221-224`, `:180-185`). A `git ls-remote origin` in e2e would hit the real github.com. This fact decides how branches are listed (§3 D2).
- **Git status is local-only.** `remoteSynced` makes no network call (`types.ts:2795-2804`). `fetchBranch`/`gitFetch` (`src/bun/worktree.ts:828-851`) are the network git helpers. Non-interactive git env, as in clone (`src/bun/clone.ts:1320`).
- **Fake driver.** The generic claude fake turn prints on **stdout** (`src/bun/agents.ts:3547`), and proposals are read from the `assistant` stream only. The marker precedent is `FAKE_CLAUDE_MD_IMAGE_PROMPT_MARKER` (`agents.ts:2398`, dispatch `:3294`). The handoff fake reads the task row via `tasks.get` (`agents.ts:1733`).
- **UI primitives.**
  - `<ContextMenu>` (`src/mainview/components/ui/context-menu.tsx:7-26`) has no submenu variant, and `<Select>` (`ui/select.tsx`) is a native select.
  - Component tests render static markup (`SelectProjectsDialog.test.tsx`).
  - RunPanel's per-task reset effect is at `RunPanel.tsx:1060-1095`, and the PR batch store at `src/mainview/lib/multi-repo-ui.ts:233-300`.
- **Composer prefill.** `GitHubPullPrefill` (`GitHubDialog.tsx:199`) is consumed at `:1229-1240`. The defaults effect at `:2283-2296` already does `setNewPullBase((cur) => cur || defaults.base)`.

### Repo rules that bear on this change (CLAUDE.md unless noted)

- **Server-managed columns.** They are skipped by the generic SET, absent from `ALLOWED_PATCH_FIELDS`, written by targeted UPDATEs, and never bump `updated_at`. The CLAUDE.md list is updated in the same change. See `docs/architecture/persistence.md`.
- **Migrations.** Numbered `.sql` file plus an entry in `src/bun/migrations/index.ts`, append only. The next id is `092`.
- **Every route needs a `ROUTE_POLICY` entry**, plus `pathParams` when CLI-reachable with a path (`src/bun/route-policy.ts`, `GH_QUERY` at `:139`).
- **Every spawn goes through `coreSpawn`.** `github.ts`'s `run` (`:544`) already does, and the new git calls use it.
- **`src/shared/` stays free of runtime imports** from either process.
- **Prompts never name the product**, and agetor adds no text of its own to a message.
- **Persisted events stay raw.** Proposal parsing is client-side.
- **RunPanel is one long-lived instance.** New per-task state needs a reset line, keyed children carry their component's name, and an overlay positioned `fixed` portals to `document.body`.
- **A popover inside a dialog** carries `data-popover-open` and closes on Escape. The confirm list therefore uses a native `<select>` and no popover.
- **Semantic color tokens only** (`text-warning`, `text-danger`, …).
- **Code comments cite `docs/architecture/<doc>.md`**, never a numbered CLAUDE.md section (`src/bun/claudemd-citations.test.ts`).
- **Tests.** DB tests set `AGETOR_DATA_DIR` at the top level, use `await import`, and clean up with `rmTestDataDir`. Tests use temp git repos, never the cwd repo.
- **Memory rules.**
  - No real ticket, repo or client names in fixtures.
  - In agetor worktrees, prefix `PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`.
  - Run e2e with `bun node_modules/@playwright/test/cli.js test`, one run at a time.
  - Scripted edits must assert their match count.

### Live facts checked (read-only)

| Check | How | Result |
| --- | --- | --- |
| The e2e GitHub identity is unreachable over git | read `e2e/multi-repo-task.spec.ts:221-224` and the stub header | `origin` is github.com and pushes use `local`. So branch existence must come from the forge REST API, which the stub serves. |
| No forge adapter can list branches | `grep -n branches src/bun/{github,gitlab,bitbucket}.ts` | none |
| Next migration id | `tail src/bun/migrations/index.ts` | last is `091_task_repositories` |
| Prompt-pinning tests | `grep -l commitPushPrompt src e2e` | `src/shared/branch.test.ts`, `src/shared/multi-repo.test.ts`, `src/cli/tui/Dashboard.test.tsx` (follows the function) |
| E2E specs touching PR surfaces | `grep -l 'prUrl\|view-pr\|create-all-prs' e2e` | `e2e/multi-repo-task.spec.ts`, `e2e/task-context-menu.spec.ts` |

## 3. Approach & key decisions

The fix has five parts.

- **Shared.** A `TaskPr` record and its helpers, plus the prompt rewrite.
- **Storage.** Migration 092 adds `tasks.base_branch` and `tasks.prs`. Entries in `repositories[]` gain `baseBranch` and `prs`. Stamping appends.
- **Core.** Create-time base recording, forge branch listing, and one read-only route, `GET /github/pull-targets`, which answers per repository: remote identity, default branch, remote branches, whether given heads exist, and whether the stored base is stale.
- **Webview logic.** A pure parser that reads every proposal with its `Base:` line, link and label, a pure planner (attribution → base precedence → rows), and a batch runner.
- **UI.** A confirm dialog, RunPanel wiring, PR lists in the header, task details and context menu (with a submenu primitive), and the composer base prefill.

The decisions follow. *(E)* rests on evidence, *(R)* on reasoning, and *(G#n)* is the owner's grill decision.

- **D1 — Pinned shapes (G#21, G#23).**
  - `TaskPr = { url; head: string | null; base: string | null; number: number | null; createdAt: number }`. `head` and `base` are null only on an entry converted from a legacy `prUrl`.
  - `Task.prs?` / `Task.baseBranch?` and `TaskRepository.prs?` / `TaskRepository.baseBranch?` are **optional at the type level for fixture compatibility**. `toTask` and `parseTaskRepositories` always set them, which is the repo's own precedent *(E)*.
  - `prUrl` stays a required, deprecated field, derived as `prs[0]?.url ?? null` per level. A multi task's task-level `prs` is always `[]`, so its `prUrl` stays null, as today.
  - Agetor code reads `prs` through `taskPrsOf` (`src/shared/task-prs.ts`). It falls back to a legacy `prUrl` **only when `prs` is absent**, which is JSON from an older core, as with a newer CLI talking to an older running app. That is the same tolerance `isMultiRepoTask`'s count fallback gives (`src/shared/multi-repo.ts`).
  - About 80 fixture files need no edit.
- **D2 — Branch facts come from the forge REST API, not `git ls-remote` *(E)*.** The forge is the system that accepts or rejects the PR. The API is reachable with the token the PR needs anyway. It is the only source the e2e stub can serve: e2e `origin` is github.com, and the stub does not speak git. This settles the grill's open assumption about the base-select source. The cost is one adapter function per forge: list (paginated, capped at 1,000 names) and a single-branch lookup.
- **D3 — No `git fetch` *(R)*.** This settles the grill's open assumption. The stale check (D4) uses the pinned create-time sha, which is always local, plus the forge's tip sha only when that object already exists locally (`git cat-file -e`). A fetch would mutate remote-tracking refs as a side effect of opening a dialog, and it costs a network round trip per repository.
- **D4 — The stale definition, corrected from G#2's literal wording *(R; ratified by the owner at plan approval, 2026-11-17)*.** G#2 says a stored base is stale when "the stored base's **remote tip** isn't an ancestor of the head". That flags every task whose base branch simply advanced on the remote (others merged into `develop` after the task branched), which is the normal case. It would hand the PR to the agent's base exactly when the owner chose the stored base to win.
  - The rule here: **stale ⇔ the pinned create-time sha (`baseRef`) is not an ancestor of the live head, AND the stored base's remote tip is not a known ancestor either.**
  - It is **not stale** if either is an ancestor (the branch was rebased or merged forward). It is **unknown** (`null`, treated as not stale) when neither can be proven.
  - It reproduces the investigation's proof (`git merge-base --is-ancestor <baseRef> <task branch>` failed after the agent's reset onto `origin/main`). It keeps G#2's intent: get both real repositories right with no manual edit.
- **D5 — Base precedence (G#2, G#14, G#17, G#29) in one pure function, `chooseBase`.**
  - Live-head row:
    1. The stored base (source "task"), unless D4 proves it stale.
    2. The agent's base (source "agent"): the `Base:` line, then the link's base.
    3. The remote default (source "default"): `<remote>/HEAD`, then the forge's default branch. The literal-`"main"` fallback is never used.
  - **With no stored base** (legacy tasks, isolation `none`, a sha or tag pick), the agent's base comes before the default *(R)*. This is the owner's round-1 order "stored > link > default" (G#2 history), and G#29 says such tasks "fall through to the next source".
  - Extra-head row: the agent's base, then the default.
  - The confirm list shows the other candidate as a hint when it differs ("agent suggests `main`" or "stored base `develop` looks stale").
  - A chosen base that the listing proves missing on the remote gives the row an error and blocks that row only (G#5). The select still lets the user pick another.
- **D6 — Attribution (G#6, G#7, G#31) in one pure function, `attributeProposals`.**
  - A proposal belongs to repository R, head H when either holds:
    - its link's host and full `owner/name` path equal R's identity (case-insensitive, `.git` stripped; compared as one slash-joined path because GitLab nested groups split differently in the remote and link parsers) and the link names head H;
    - its `Repository:` label equals R's workspace name and its link, if any, doesn't name another repository. H is then the link's head, else R's live head.
  - The newest proposal per (R, H) wins, across runs: the later run, then later in the text.
  - Legacy `pull/new/<branch>` links attribute (head only, no base).
  - The blind "one unlabeled proposal → the one target" fallback is **removed**.
  - On a **single-repo** task, an unlabeled proposal with **no link at all** goes to the live head *(R; §8 Q3)*. There is only one repository, and today's single chip already does this. A proposal whose link names another repository or head is never re-attributed.
- **D7 — Proposal parsing.** `parsePrProposals(text)` returns every complete proposal (the existing title-and-description fence rules).
  - Each proposal's link and `Base:` line are the nearest ones above its `PR title:` label, searched only back to the end of the previous proposal's description fence. A proposal without its own link can't inherit a sibling's.
  - Its label is the most recent `Repository:` line above it, as today's block semantics.
  - A link line may be bare, `<url>`, a lone markdown link `[text](url)`, or `Label: url`.
- **D8 — Link formats (G#11).** The prompt asks for these. The parser reads them, plus GitHub `pull/new/<head>`. It URL-decodes names (G#30) and splits `compare/<base>...<head>` on `...`. Git forbids `..` in ref names (investigation §1).

  | Forge | Link | Read |
  | --- | --- | --- |
  | GitHub | `…/<owner>/<repo>/compare/<base>...<head>?quick_pull=1` | base, head |
  | GitHub | `…/compare/<head>` | head only |
  | GitHub | `…/pull/new/<head>` (legacy) | head only |
  | GitLab | `…/<namespace>/<project>/-/merge_requests/new?merge_request[source_branch]=<head>&merge_request[target_branch]=<base>` (brackets raw or percent-encoded) | base, head |
  | Bitbucket | `…/<ws>/<repo>/pull-requests/new?source=<head>&dest=<base>` | base, head |

  A fork head (`owner:branch`) is never attributed.
- **D9 — Normalizing the agent's base (G#30).** Strip `refs/heads/`. Strip `<remote>/` when `<remote>` is a configured remote (the list comes from `pull-targets`). Strip backticks and emphasis. A value that fails `validateBranchName` is dropped.
- **D10 — Create-time base name (G#3, G#4, G#30).** `resolveBaseBranchName(dir, requested)` runs `git rev-parse --symbolic-full-name --end-of-options <ref>`.
  - `refs/heads/<b>` → `b`, and `refs/remotes/<remote>/<b>` → `b`.
  - A tag, a sha or empty output → `null`.
  - `HEAD` → `git symbolic-ref --quiet --short HEAD` = `b`, recorded only if `refs/remotes/<upstream remote, else origin>/<b>` exists locally (no network at create).
  - A picked branch that exists only locally is recorded, and G#5 reports it at PR time.
  - An `existingBranch` task records `null`.
- **D11 — Already-exists handling (G#19).**
  - GitHub's 422 `errors[].message` "A pull request already exists for …" maps to `{ code: "already-exists", existingUrl }`. `existingUrl` comes from one `GET /repos/{o}/{r}/pulls?head=<owner>:<head>&state=open&per_page=1` and is omitted if that lookup fails.
  - Other 422s report `errors[].message` instead of "Validation Failed".
  - GitLab's 409 "Another open merge request already exists … !<iid>" maps to `already-exists`, with the URL built from the iid.
  - Bitbucket: a best-effort message pattern (§8 Q10).
  - The webview shows "already open" and **does not stamp** the PR. Stamping a PR agetor didn't open was not decided (§9).
- **D12 — `Closes #N` (existing rule) goes only on the issue repository's live-head PR *(R; §8 Q4)*.** Two PRs both closing one issue would close it on whichever merges first.
- **D13 — UI.**
  - **Confirm dialog.** One row per head: checkbox, `head → <native Select of remote branches>`, title `Input`, a collapsed description preview, and hints. It is a container (`CreatePrsDialog`) over a static-renderable view (`CreatePrsDialogView`).
  - **Header View PR.** One PR in scope: the button as today. Two or more: the button opens the existing `<ContextMenu>` anchored at the button, one `View PR: <head> → <base>` item per PR. The primitive portals and carries `data-popover-open`.
  - **Task card context menu.** One `View PR: <head>` item per PR (multi: `View <repo> PR: <head>`). Past 3, they move into a "View pull requests" submenu, a new variant of the primitive (G#25).
  - **Header PR for mergeability and Resolve Conflicts.** `headerPr(prs, [liveHead, taskBranch])` is the live-head PR, else the first.
- **D14 — Deliver as one PR, reviewed commit by commit, one checkpoint commit per wave.** The slices aren't independently wired: the route's only caller is the dialog, and the dialog needs the route. §6 has the estimate.

Rejected alternatives:

- **`git ls-remote` for the branch list.** It can't run in e2e (D2), and its result depends on local remote naming.
- **Keeping the blind single-target fallback.** It caused the latent wrong-repo bug the investigation proved.
- **Making `prs` required.** That edits about 80 fixture files for no behavioral gain.
- **A searchable popover select.** It brings in the dialog Escape/`data-popover-open` contract. A native `<select>` is enough.
- **Writing `pr_url` alongside `prs` for downgrades.** The owner chose to stop writing it (G#22).

## 4. Work breakdown — implementation tasks

Every task owns its own unit tests (listed in its files) and must show each new test **failing** against a broken copy of the behavior before calling it done. "Pinned" interfaces below are the contract sibling tasks code against in the same wave. Don't change them without changing this plan.

### Pinned interfaces

```ts
// src/shared/types.ts (T1)
export interface TaskPr { url: string; head: string | null; base: string | null; number: number | null; createdAt: number }
export interface ForgeBranch { name: string; sha: string | null }
// Task:           prs?: TaskPr[]; baseBranch?: string | null;   prUrl stays (deprecated, derived)
// TaskRepository: prs?: TaskPr[]; baseBranch?: string | null;   prUrl stays (deprecated, derived)
export interface PullTargetsResult {
  provider: GitProvider; host: string; owner: string; name: string;
  remote: string;                 // git remote the identity came from
  remotes: string[];              // every configured remote name
  defaultBranch: string | null;   // <remote>/HEAD, else the forge default; never a guessed "main"
  branches: string[];             // forge branch names (cap 1000)
  branchesTruncated: boolean;
  branchesError: string | null;   // listing failed; existence below is then null (unknown)
  heads: Array<{ name: string; onRemote: boolean | null }>;
  storedBase: { name: string; onRemote: boolean | null; stale: boolean | null } | null;
}

// src/shared/task-prs.ts (T1) — pure
parseTaskPrs(raw: unknown): TaskPr[]                       // array or JSON string; drops invalid entries
legacyTaskPrs(prUrl: string | null | undefined, head: string | null, createdAt?: number): TaskPr[]
taskPrsOf(x: { prs?: TaskPr[] | null; prUrl?: string | null }): TaskPr[]   // prs, else legacyTaskPrs(prUrl, null) for older-core JSON
prForHead(prs: readonly TaskPr[], head: string | null | undefined): TaskPr | null
livePr(prs: readonly TaskPr[], heads: readonly (string | null | undefined)[]): TaskPr | null  // head match, else a head:null entry
headerPr(prs: readonly TaskPr[], heads: readonly (string | null | undefined)[]): TaskPr | null // livePr ?? prs[0] ?? null
firstPrUrl(prs: readonly TaskPr[]): string | null
appendTaskPr(prs: readonly TaskPr[], entry: TaskPr): TaskPr[]          // dedupe by url (returns input when duplicate)

// src/bun/db.ts (T7)
tasks.appendPr(taskId: string, entry: TaskPr): Task | null                 // single-repo rows; no-op on multi
tasks.appendRepositoryPr(taskId: string, selector: string, entry: TaskPr): Task | null // multi; selector = name|path|worktreePath
// tasks.setRepositoryPrUrl is removed

// forge adapters (T2) — all return { ok: false; error: string } on failure
listGitHubBranches(input: { dir: string; maxPages?: number }): Promise<{ ok: true; branches: ForgeBranch[]; truncated: boolean } | …>
getGitHubBranch(input: { dir: string; name: string }): Promise<{ ok: true; branch: ForgeBranch | null } | …>   // null = 404
getGitHubDefaultBranch(input: { dir: string }): Promise<{ ok: true; name: string } | …>
listGitLabBranches(repo: ProviderRepoInfo, opts?: { maxPages?: number }) / getGitLabBranch(repo, name)        // same result shapes
listBitbucketBranches(repo: ProviderRepoInfo, opts?: { maxPages?: number }) / getBitbucketBranch(repo, name)
// pull-create failures may carry: { ok: false; error: string; code?: "already-exists"; existingUrl?: string }

// src/bun/git-provider.ts (T9)
providerRemoteForDir(dir: string): Promise<{ info: ProviderRepoInfo; remote: string } | null>
// src/bun/pr-targets.ts (T9)
pullTargets(input: { dir: string; heads: string[]; storedBase?: string | null; storedBaseSha?: string | null; liveHead?: string | null },
            deps?: PullTargetsDeps): Promise<({ ok: true } & PullTargetsResult) | { ok: false; error: string }>
// route (T13): GET /github/pull-targets?path=&head=(0..20, repeatable)&storedBase=&storedBaseSha=&liveHead=

// src/bun/worktree.ts (T12)
resolveBaseBranchName(dir: string, requestedRef: string): Promise<string | null>

// src/mainview/lib/pr-link.ts (T3)
type ForgeKind = "github" | "gitlab" | "bitbucket"
interface PrLink { forge: ForgeKind; host: string; owner: string; repo: string; head: string | null; base: string | null }
parsePrLink(url: string): PrLink | null
linkMatchesRepo(link: PrLink, id: { host: string; owner: string; name: string }): boolean
// src/mainview/lib/pr-proposal.ts (T3) — new API (legacy exports stay until T15)
interface PrProposal { title: string; description: string; link: string | null; baseLine: string | null; repositoryLabel: string | null }
parsePrProposals(text: string): PrProposal[]
interface RunProposal extends PrProposal { runId: string; order: number }   // order grows with recency
collectRunProposals(events: RunEvent[]): RunProposal[]                      // assistant, non-subagent

// src/mainview/lib/pr-plan.ts (T10)
type PrBaseSource = "task" | "agent" | "default" | "user"
interface PrRow {
  key: string; repoName: string; projectPath: string; remote: string | null; head: string; isLiveHead: boolean;
  checked: boolean; disabledReason: string | null;
  base: string; baseSource: PrBaseSource; baseOptions: Array<{ name: string; onRemote: boolean | null }>; baseError: string | null;
  hints: string[]; title: string; body: string; hasProposal: boolean;
}
type PrRowResult = { status: "creating" } | { status: "created"; url: string } | { status: "already-open"; url: string | null }
                 | { status: "failed"; error: string } | { status: "skipped"; reason: string }
buildPrPlan(input: PrPlanInput, deps: { providerInfo(path): Promise<RepoIdentity | null>; pullTargets(q): Promise<PullTargetsResult> }): Promise<PrRow[]>
editPrRow(row: PrRow, patch: { checked?: boolean; base?: string; title?: string }): PrRow   // recomputes baseError
runPrBatch(taskId: string, rows: PrRow[], deps: { createPull(row): Promise<{ url: string }>; onResult(key, r: PrRowResult): void }): Promise<{ created: number; alreadyOpen: number; failed: string[] }>
proposalHeadsNeedingPr(input): Array<{ repoName: string; head: string }>   // gate for the button

// src/mainview/components/kanban/CreatePrsDialog.tsx (T14)
interface CreatePrsDialogProps { open: boolean; task: Task; events: RunEvent[];
  gitStatus: TaskGitStatus | null;                     // RunPanel's batched status (multi entries in .repositories)
  onClose(): void; onPrsStamped(taskId: string): void }

// src/mainview/components/kanban/GitHubDialog.tsx (T6)
interface GitHubPullPrefill { …; base?: string }
```

### Tasks

| ID | Goal | Owned files | Depends on | Acceptance (scenarios, and how each is proven) | Risk | Wired by |
| --- | --- | --- | --- | --- | --- | --- |
| **T1** | Shared PR record, helpers, repository derivation, and the Commit & push prompt rewrite | `src/shared/types.ts`, `src/shared/task-prs.ts` (new), `src/shared/multi-repo.ts`, `src/shared/task-prs.test.ts` (new), `src/shared/branch.test.ts`, `src/shared/multi-repo.test.ts` | — | **Types:** the pinned types exist. `prUrl` doc comments say "deprecated, derived from `prs[0]`, never read by agetor". `bun run typecheck` stays green with every fixture untouched. **Helpers:** `parseTaskPrs` drops entries missing `url`, coerces bad `number` to null, and returns `[]` for malformed JSON. `livePr` prefers a head match over a `head:null` entry. `headerPr` falls back to `prs[0]`. `appendTaskPr` dedupes by URL. All proven in `task-prs.test.ts`. **Derivation:** `repositoriesForTask` derives the single entry with `prs`, `baseBranch` and a derived `prUrl`, and returns a multi task's stored entries unchanged (`multi-repo.test.ts`). Its parameter type **still accepts `prUrl`**, used through `taskPrsOf` only when `prs` is absent. That keeps `db.ts`'s literal at `:1065`, which T7 changes in wave 2, compiling at the wave-1 barrier. **Single prompt:** with `baseBranch: "develop"` it contains `Base: <branch>`, the escape clause "unless you moved", and all three forge link templates (`compare/<base>...<head>?quick_pull=1`, `merge_request[target_branch]`, `dest=`). It says git's push-output link targets the default branch. It keeps the title/description fences, the four-backtick rule and the no-attribution sentence, and has no `Agetor`/`agetor` substring. With `baseBranch` null it asks for the branch the work started from (the default if unsure). **Multi prompt:** each `Repositories:` line carries `base '<b>'` when stored, and each repository block asks for `Repository:`, then `Base:`, then the link. **Both prompts:** "repeat the block for each pull request you propose" is present. All proven in `branch.test.ts` and `multi-repo.test.ts`. | none | consumers: T7 (db), T10/T11/T15 (webview), `commit.ts`/`Dashboard.tsx` call `commitPushPrompt` unchanged |
| **T2** | Forge branch listing/lookup, default branch, and already-exists classification | `src/bun/github.ts`, `src/bun/gitlab.ts`, `src/bun/bitbucket.ts`, `src/bun/github-branches.test.ts` (new), `src/bun/gitlab-branches.test.ts` (new), `src/bun/bitbucket-branches.test.ts` (new) | — (codes against T1's `ForgeBranch`) | **GitHub list:** follows `per_page=100&page=N` until a short page or `maxPages` (default 10); `truncated` true at the cap; uses the `remoteHost` token when present. A 401/404 maps to the existing `privateRepoHint` message. **GitHub lookup:** 200 → branch, 404 → `null`. The name is URL-encoded per path segment, so `release/1.2` survives. `getGitHubDefaultBranch` reads `default_branch` from `GET /repos/{o}/{r}`. **GitLab:** list and lookup with the whole name URL-encoded (`%2F`). **Bitbucket:** list follows `next` up to the cap, `pagelen=100`. **GitHub create:** a 422 whose `errors[].message` matches /already exists/ maps to `{code:"already-exists", existingUrl}` (one pulls-search lookup; no URL when that fails). Other 422s include `errors[].message` in `error`. **GitLab create:** a 409 "already exists … !12" maps to `already-exists` with `…/-/merge_requests/12`. **Bitbucket create:** a duplicate message maps to `already-exists`. Every case is proven with each adapter's existing fetch test util (`github-test-util.ts`, `gitlab-test-util.ts`, `bitbucket-test-util.ts`). | external, trust | T9 (`pr-targets.ts`) and T13 (route passthrough) |
| **T3** | Parse every proposal with its `Base:` line, link and label, and parse forge links | `src/mainview/lib/pr-link.ts` (new), `src/mainview/lib/pr-link.test.ts` (new), `src/mainview/lib/pr-proposal.ts`, `src/mainview/lib/pr-proposal.test.ts` | — | **Link parsing:** every format in D8, with percent-encoded and raw brackets. `release%2F1.2...feature%2Fa` decodes. An `owner:branch` head reads as a fork, so `head` is null. A GitLab nested `group/sub/project` reads `owner="group/sub"`. A PR page (`/pull/12`), a non-PR URL or garbage → `null`, and it never throws. **Repo match:** `linkMatchesRepo` compares host plus the **full slash-joined path** `owner/repo` against `id.owner + "/" + id.name`, case-insensitive with `.git` ignored. For a GitLab nested project the remote parser gives `{owner:"group", name:"sub/project"}` (`parseGitRemote`, `github.ts:602`) while the link gives `owner:"group/sub", repo:"project"`, so a per-field comparison would never match. A test pins the nested case. **Proposal parsing:** a synthetic three-proposal reply in the real reply's shape (`**PR-1: app → \`main\`**` headings, bare `pull/new` links, `PR title:`/`PR description:` blocks) gives three proposals, each with its own link. A second proposal **without** a link gets `link: null`, not the first one's. `Base:` variants are read (emphasis, backticks, `Base branch:`). The label is the most recent `Repository:` above. `\r\n` and bare `\r` input works. A 4-tick description holding ``` survives. **Runs:** `collectRunProposals` ignores subagent and non-assistant events and orders by run, then by position. Legacy exports and their tests keep passing until T15. | trust | T10 (`pr-plan.ts`) |
| **T4** | Submenu support in the ContextMenu primitive | `src/mainview/components/ui/context-menu.tsx`, `src/mainview/lib/context-menu.ts`, `src/mainview/lib/context-menu.test.ts` | — | **Variant:** `ContextMenuItem` gains `{ type: "submenu"; id; label; icon?; items: leaf items[] }`. **Opening:** hover, Enter or ArrowRight opens a portaled child panel (`position: fixed`, the same styling and `role="menu"`, `data-testid` `${testId}-${id}-submenu`). **Closing:** ArrowLeft or the first Escape closes only the child and returns focus to its parent item. A second Escape closes the menu. Choosing a child item calls its `onSelect` and closes everything. Outside-click rules are unchanged. **Placement:** a new pure `placeSubmenu(anchorRect, size, viewport)` opens to the right and flips left on overflow, clamped to the 8 px margin (unit tests). **Navigation:** `moveMenuIndex` treats a submenu item as focusable. **Marker:** the root panel keeps `data-popover-open=""`. | none | T11 (App maps `children` → submenu) and T15 (header PR menu uses leaf items only) |
| **T5** | Fake claude marker that emits a proposal reply on the assistant stream | `src/bun/agents.ts`, `src/bun/agents-fake-pr-proposal.test.ts` (new) | — | **Marker:** exported `FAKE_CLAUDE_PR_PROPOSAL_PROMPT_MARKER = "__agetor_fake_claude_pr_proposal__"`, used as `marker:<base64url template>`. On turn 1 the fake decodes the template, replaces `{{branch:<repoName>}}` with that repository's `branch` from `tasks.get(taskId).repositories`, and `{{branch}}` with `task.branch`. It emits **one** `assistant` chunk, then `turn complete`. **Bad input:** malformed base64 emits a `status` line `fake pr proposal: bad template`, then completes. A placeholder with no matching branch is left verbatim. Follow-up turns behave like the generic fake. The doc comment says e2e keeps a literal copy. All proven in the new test, with `AGETOR_CLAUDE_DRIVER=fake` and a temp data dir. | tests | the fake claude driver dispatch in `agents.ts` (same chain as `FAKE_CLAUDE_MD_IMAGE_PROMPT_MARKER`) |
| **T6** | The composer accepts a prefilled base | `src/mainview/components/kanban/GitHubDialog.tsx`, `src/mainview/components/kanban/GitHubDialog-prefill.test.ts` (new) | — | **Type:** `GitHubPullPrefill.base?: string`. **Seeding:** part 2 of the prefill seeds `newPullBase` when `base` is set, through an exported pure `prefillPullFields(pending)` that returns `{ head, title, body, base? }`. **Defaults:** the defaults effect never overwrites a non-empty base, both when defaults resolve **before** the prefill lands and **after**. Proven by a unit test of `prefillPullFields` plus a test of the defaults merge helper (extract `mergePullDefaults(cur, defaults)`). | none | T15 (the chip passes `base`) |
| **T7** | Migration 092 and the DB layer: `base_branch`, `prs`, append-only stamping; server stamping moved to `prs` | `src/bun/migrations/092_task_base_branch_and_prs.sql` (new), `src/bun/migrations/index.ts`, `src/bun/db.ts`, `src/bun/server.ts` (**only** the `/github/pull-create` stamping block, `:3392-3417`), `src/bun/db-task-prs.test.ts` (new), `src/bun/db-repositories.test.ts`, `src/bun/db-repositories-fixes.test.ts`, `src/bun/pull-create-task-url.test.ts`, `src/bun/server-multi-repo.test.ts`, `src/bun/server-multi-repo-fixes.test.ts` | T1 | **Migration:** `ALTER TABLE tasks ADD COLUMN base_branch TEXT`; `ADD COLUMN prs TEXT NOT NULL DEFAULT '[]'`. Backfill: rows with non-empty `pr_url` get `json_array(json_object('url', pr_url, 'head', COALESCE(checkout_branch, branch), 'base', NULL, 'number', NULL, 'createdAt', updated_at))`. `pr_url` is untouched. Registered as `{ id: "092_task_base_branch_and_prs" }`. A re-run is a no-op. Proven by migrating a fixture DB seeded at 091. **Read:** `toTask` sets `prs`, `baseBranch` and `prUrl = firstPrUrl(prs)` (null for multi). **Read-time conversion:** `parseTaskRepositories` reads an entry's `prs`, or converts a legacy `prUrl` with `legacyTaskPrs(prUrl, checkoutBranch ?? branch)`. It reads `baseBranch` and derives entry `prUrl`. **Persisted JSON:** every repositories write (`setRepositories`, `setRepositoryCheckout`, `appendRepositoryPr`, `tasks.insert`) serializes entries **without** a `prUrl` key. **Insert:** writes `prs` and `base_branch`, and `pr_url` NULL. **Generic update:** the SET no longer writes `pr_url`, and `prs`/`base_branch` aren't in it. A `tasks.update(id, { prs, baseBranch, prUrl })` leaves all three unchanged. **Appends:** `appendPr` appends to single rows (no-op on multi, no-op on a duplicate URL). `appendRepositoryPr` matches name, path or worktreePath (no-op on single rows). Neither bumps `updated_at`. **Merge:** `setRepositories` keeps stored `prs` and `baseBranch` over the incoming snapshot. **Server stamping:** `pull-create` with `taskId` appends `{url: item.htmlUrl, head: body.head, base: body.base, number: item.number, createdAt: Date.now()}`. A second PR from another head **appends** (first-write-wins is gone). Archived, unknown and mismatched-dir tasks are not stamped. **Not patchable:** a `PATCH` carrying `prs` is ignored. All proven in the listed test files. | data, migration, state | `db.ts` module load (`migrate`), `POST /github/pull-create` |
| **T9** | Core `pullTargets`: identity, remotes, default branch, branch facts, stale check | `src/bun/pr-targets.ts` (new), `src/bun/git-host.ts`, `src/bun/git-provider.ts`, `src/bun/pr-targets.test.ts` (new) | T2 | **Facade:** `git-host.ts` dispatches `listBranches({dir,maxPages})`, `branchInfo({dir,name})` and `remoteDefaultBranch({dir})` per provider, and `pullCreate` passes through `code`/`existingUrl`. `providerRemoteForDir` returns the remote name with the identity, in `providerRepoForDir`'s order. **Default branch:** `defaultBranch` is `git symbolic-ref refs/remotes/<remote>/HEAD`, else the forge default, else `null`. **Heads:** `onRemote` comes from the list, or from `branchInfo` when the list is truncated and the name is absent. `null` when listing failed (`branchesError` set). **Stale check** (temp git repos plus injected fake forge deps): (a) the base advanced on the remote while the head still contains the pinned sha → `stale:false`. (b) The head was reset onto another branch (neither pinned nor tip is an ancestor) → `stale:true`. (c) The pinned sha is not an ancestor but the tip is (base force-pushed, head rebased) → `false`. (d) No pinned sha and the tip object is missing locally → `null`. **Input safety:** names that fail `validateBranchName` or start with `-` never reach git argv (`onRemote:false`, no spawn; asserted with a spy). The stale check uses `--end-of-options`. **Process rules:** every git call goes through `run` (`coreSpawn`) with a 5 s timeout, no `fetch` is issued (asserted), and git runs with `GIT_TERMINAL_PROMPT=0`. | external, trust, concurrency | T13 (route) |
| **T10** | Webview planning: attribution, base precedence, rows, batch runner, session store, provider-info cache, API client | `src/mainview/lib/pr-plan.ts` (new), `src/mainview/lib/pr-plan.test.ts` (new), `src/mainview/lib/provider-info-cache.ts` (new), `src/mainview/lib/provider-info-cache.test.ts` (new), `src/mainview/lib/multi-repo-ui.ts`, `src/mainview/lib/multi-repo-ui.test.ts`, `src/mainview/lib/api.ts` | T1, T3 | **Real-reply reproduction** (synthetic names): repos `app` and `infra`. The reply proposes app's live head, infra's live head and a second app branch, with `pull/new` links and no labels. Each live-head row gets **its own** proposal's title and body, never `task.title` and never the sibling's. The second app branch becomes an extra row, unchecked. **Base precedence:** infra's stored `feature-base`, not stale → base `feature-base`, source task. App's stored base with `stale:true` and no agent base → default `main`, hint "stored base … looks stale". **Precedence cases:** `Base:` line vs link base disagree → the line wins, with a mismatch hint. No stored base → the agent's base, else the default. An extra head never uses the stored base. A stored base with `onRemote:false` → `baseError` "base branch `develop` isn't on origin"; changing the base via `editPrRow` clears it. Base equal to head → error. **Attribution:** a labeled block whose link names another repo is ignored for that repo. A multi-repo unlabeled linkless proposal is unattributed. A single-repo one goes to the live head. Newest per (repo, head) across two runs. An agent base of `origin/develop` normalizes to `develop`. **Row states:** an extra head with `onRemote:false` or `null` is disabled ("branch `x` isn't on origin"). A head already in `prs` or opened this session is excluded. A repository without a live head gives a disabled "not pushed yet" row. No proposal → `rootTitle`, empty body, "no proposal" hint. `Closes #N` only on the issue repository's live-head row. **`runPrBatch`:** walks checked, error-free rows in order, best effort. A failure doesn't stop the walk. `already-exists` → `already-open` (with `existingUrl`). It calls `markPrOpened(taskId, repo, head)` on success and is guarded by `beginPrBatch`. **Store:** `multi-repo-ui.ts` adds `markPrOpened`/`prOpenedInSession`, keyed by (task, repo, head), and keeps the old exports until T15. **Cache:** `provider-info-cache` dedupes in-flight calls per path, has a 5-min TTL (30 s for errors) and notifies subscribers. **API client:** `api.getPullTargets(...)`. `createGitHubPull` keeps `retry:false`, and its `ApiError.body` carries `code`/`existingUrl`. All proven in `pr-plan.test.ts` with injected deps, no network. | trust, state | T14 (dialog), T15 (RunPanel gate, single chip) |
| **T11** | PR list readers outside RunPanel: context menu builder and App handlers | `src/mainview/lib/task-context-menu.ts`, `src/mainview/lib/task-context-menu.test.ts`, `src/mainview/App.tsx` | T1, T4 | **Builder:** `TaskMenuEntry` gains `prUrl?` and `children?`. Single task, 1 PR → one entry `View PR: <head>`. A converted legacy entry (`head:null`) → `View pull request`. Three PRs → three flat entries. Four PRs → one `View pull requests` entry with four children. Multi → `View <repo> PR: <head>`, counted across repositories for the >3 rule. Item ids are `view-pr-<n>` (`view-prs` for the submenu). PRs are read through `taskPrsOf`. **App:** it maps `children` to the T4 submenu variant and opens `entry.prUrl` against the right `projectPath` (the repository's `worktreePath ?? path` for multi, `t.workdir` for single), keeping the snapshot-first rationale. Builder proven in `task-context-menu.test.ts`; App by typecheck plus T17. | none | App's `taskMenuItems` memo |
| **T12** | Record the base branch name at create time; carry it through steps and repository sets | `src/bun/worktree.ts`, `src/bun/orchestrator.ts`, `src/bun/pipeline-runner.ts`, `src/bun/task-repos.ts`, `src/bun/worktree-base-branch.test.ts` (new), `src/bun/orchestrator-base-branch.test.ts` (new), `src/bun/pipelines.test.ts` | T7 | **`resolveBaseBranchName`** (temp repos): `develop` → `develop`, `origin/release/1.2` → `release/1.2`, `refs/heads/x` → `x`, a tag → null, a sha → null. `HEAD` on a branch with `refs/remotes/origin/<b>` → `b`. `HEAD` on a local-only branch → null. Detached `HEAD` → null. A name starting with `-` → null, with no git call. **`createTask`:** a single-repo task sets `baseBranch` alongside `baseRef`. Multi sets each `repositories[].baseBranch` from that entry's requested ref, else the task-level default, else HEAD. `existingBranch` → null. Isolation `none` (no pin) → null. Every new entry carries `prs: []`. **Step copy:** a pipeline step copies `baseBranch`, starts with `prs: []`, and copies `repositories[]` with their `prs` and `baseBranch`. All proven in the listed tests, with temp repos and a temp data dir. | data, state | `POST /tasks` → `createTask`, pipeline runner step launch |
| **T13** | The `GET /github/pull-targets` route, its policy, and the pull-create error passthrough | `src/bun/server.ts` (the new route, and the `pull-create` error response only), `src/bun/route-policy.ts`, `src/bun/server-pull-targets.test.ts` (new) | T7, T9 | **Route:** `GET /github/pull-targets?path=…&head=a&head=b&storedBase=develop&storedBaseSha=<sha>&liveHead=a` → 200 with `PullTargetsResult` (temp repo plus fake deps injected through a test seam, or the GitHub API base env against a local stub server). **Input errors:** missing `path` → 400, more than 20 `head` → 400, an invalid branch name → 400 naming it, a malformed `storedBaseSha` → 400. **Policy:** `ROUTE_POLICY` has `"/github/pull-targets": { GET: GH_QUERY }`, so `route-policy.test.ts` passes and a CLI-token caller is path-gated. **Error passthrough:** a `pull-create` failure with `code` answers `400 {error, code, existingUrl?}`. | trust, external | `startApiServer` routes table, `applyRoutePolicy` |
| **T14** | The Create-PRs confirm dialog | `src/mainview/components/kanban/CreatePrsDialog.tsx` (new), `src/mainview/components/kanban/CreatePrsDialog.test.tsx` (new) | T10 | **Planning:** on open, the container calls `buildPrPlan` with the real `api` and shows a loading state. The root title comes from `api.getTask(task.pipelineParentId)` for a step task, and is `task.title` otherwise. **View markup** (`CreatePrsDialogView`, static render): per row, a checkbox (live rows checked, extras unchecked), `head →` a native `<Select>` whose options are the remote branches plus any current/stored/agent/default base not listed (suffixed "(not on <remote>)"), a title `Input`, a "base from task/agent/default/you" badge, hints, a disabled reason and the base error. **Create button:** reads "Create N pull requests" and is disabled when N = 0 or a checked row has a `baseError`. **During and after the walk:** a per-row status (creating, created with link, already open with link, failed with message). Closing the dialog mid-walk doesn't stop it, and setState after unmount is guarded. A final toast summarizes (created, already open, failed). On completion it calls `onPrsStamped(taskId)`. **Test ids:** `create-prs-dialog`, `create-prs-row-<repo>-<head-slug>`, `create-prs-base-…`, `create-prs-submit`. View markup proven by `CreatePrsDialog.test.tsx`; the container by T17. | state | T15 mounts it in RunPanel |
| **T15** | RunPanel wiring: the button gate and dialog, the single chip base, the header PR menu, details PR lists, tooltip; removal of orphaned legacy exports | `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/lib/repo-removal.ts`, `src/mainview/lib/repo-removal.test.ts`, `src/mainview/lib/pr-proposal.ts` (delete legacy exports), `src/mainview/lib/pr-proposal.test.ts` (delete their tests), `src/mainview/lib/multi-repo-ui.ts` (delete `markRepositoryPrOpened`/`repositoriesForPrBatch`), `src/mainview/lib/multi-repo-ui.test.ts` | T6, T10, T11, T14 | **Details rows** (moved here from T11 so the shape change and its only reader land together): `repositoryDetails` returns `prs` (each `{url, head, base}`) and `baseText` (`develop · 1a2b3c4d5e6f`, or the sha only when no `baseBranch`) instead of `prUrl`/`base`. Proven in `repo-removal.test.ts`. **Button:** `create-all-prs` opens `CreatePrsDialog` (mounted with `key={\`create-prs-dialog-${task.id}\`}`). **Multi gate:** a repository whose live head has no PR (`!prForHead(repo.prs, liveHead)`) OR `proposalHeadsNeedingPr(...)` non-empty. **Single gate:** at least 2 distinct heads needing a PR. Proposal parsing for the gate is memoized on (task id, assistant-event count, last assistant event id), is skipped while `task.column === "running"`, and reads identities through the provider-info cache (`useSyncExternalStore`). **Single chip:** shown while `!livePr(prs, [prHead])`. A click shows a busy state, runs `buildPrPlan` for the live head only, and calls `onOpenPullRequest({…, base})`. If planning fails it opens without a base. **Header:** `headerPr(prs, [liveHead, taskBranch])` drives View PR and the mergeability fetch (effect deps stay URL strings). With 2+ PRs in scope the button opens a `<ContextMenu>` at its rect, listing `View PR: <head> → <base>`. **Details:** the repository details section lists every PR as a `head → base` link (`task-details-repo-pr-<repo>-<n>`). **Copy:** the Commit & push tooltip mentions the `Base:` line and the targeted link. **Reset:** the `[task.id]` effect gets reset lines for `createPrsOpen`, the chip busy state and the header PR menu. **After stamping:** `onPrsStamped` refetches the task and merges `prs` and `repositories` via `onTaskFieldsChanged`. **Cleanup:** the legacy `latestPrProposal`, `latestProposalForRepository`, `latestProposalsForTargets`, `latestRepositoryProposals`, `parseRepositoryProposals`, `repositoriesNeedingPr`, `markRepositoryPrOpened` and `repositoriesForPrBatch` are deleted, with `grep` showing zero remaining references. Proven by typecheck, the suite, and T17. | state | RunPanel render (App) |
| **T16** | Docs and contract notes | `docs/architecture/multi-repo-tasks.md`, `docs/architecture/run-panel.md`, `docs/architecture/persistence.md`, `docs/architecture/pipelines.md`, `docs/architecture/task-context-menu.md`, `docs/architecture/security.md`, `docs/plans/multi-repo-tasks.md`, `CLAUDE.md` | T1–T15 (text describes landed behavior) | **multi-repo-tasks.md:** the `TaskRepository` shape (`prs`, `baseBranch`, derived `prUrl`), append-only pull-create stamping, link/label attribution replacing A10, and the prompt's `Base:` line and links. **run-panel.md:** the confirm list, the store keyed by (task, repo, head), the header PR menu, the single-repo trigger, and the new fake marker documented beside the flow it exercises. **persistence.md:** 092 (`base_branch`, `prs`, backfill, `pr_url` retired), the server-managed rules, and the `setRepositories` merge of `prs`/`baseBranch`. **pipelines.md:422:** an already-existing PR now shows as "already open", and steps copy `baseBranch`. **task-context-menu.md:** per-PR entries and the submenu past 3. **security.md:** the `pull-targets` policy and the agent-text trust boundary (link attribution bounded by remote identity; extra heads opt-in and checked against the forge). **plans/multi-repo-tasks.md:** A10 marked superseded with a pointer to this plan. **CLAUDE.md:** `base_branch` and `prs` added to the server-managed list, `pr_url` noted as retired. `bun test src/bun/claudemd-citations.test.ts` passes. | none | n/a |
| **T17** | E2E: Create all PRs through the confirm list, asserting title, body and base; context-menu locator update | `e2e/multi-repo-task.spec.ts`, `e2e/github-stub.ts`, `e2e/task-context-menu.spec.ts` | T5, T12, T13, T15 | See §5 (scenarios S1–S6) | tests | Playwright fixtures |

## 5. Work breakdown — test tasks

Unit and integration tests are owned by the implementation task that changes the module under test (§4 "Owned files"), so test ownership stays partitioned the same way. Each must be shown red against a broken copy of the behavior: invert the stale rule, re-add the blind fallback, drop the dedupe, let the generic SET write `prs`. A test that needs git skips loudly only if `git` is missing, and fails in CI.

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| U1 | unit | T1 helpers and prompt | `src/shared/task-prs.test.ts`, `src/shared/branch.test.ts`, `src/shared/multi-repo.test.ts` | as T1 |
| U2 | unit | T2 forge adapters | `src/bun/{github,gitlab,bitbucket}-branches.test.ts` | as T2 |
| U3 | unit | T3 parsers | `src/mainview/lib/pr-link.test.ts`, `src/mainview/lib/pr-proposal.test.ts` | as T3 |
| U4 | unit | T4 submenu geometry and navigation | `src/mainview/lib/context-menu.test.ts` | as T4 |
| U5 | unit | T5 fake marker | `src/bun/agents-fake-pr-proposal.test.ts` | as T5 |
| U6 | unit | T6 prefill merge | `src/mainview/components/kanban/GitHubDialog-prefill.test.ts` | as T6 |
| I1 | integration (DB, route) | T7 migration, DB and stamping | `src/bun/db-task-prs.test.ts`, `db-repositories*.test.ts`, `pull-create-task-url.test.ts`, `server-multi-repo*.test.ts` | as T7. The migration test runs 001→091, seeds rows, then applies 092. |
| I2 | integration (git) | T9 stale check and branch facts | `src/bun/pr-targets.test.ts` | as T9, against real temp git repos |
| U7 | unit | T10 planner and batch | `src/mainview/lib/pr-plan.test.ts`, `provider-info-cache.test.ts`, `multi-repo-ui.test.ts` | as T10 |
| U8 | unit | T11 builder; T15 details rows | `task-context-menu.test.ts` (T11), `repo-removal.test.ts` (T15) | as T11 and T15 |
| I3 | integration (git + DB) | T12 create-time base | `src/bun/worktree-base-branch.test.ts`, `src/bun/orchestrator-base-branch.test.ts`, `src/bun/pipelines.test.ts` | as T12 |
| I4 | integration (route) | T13 | `src/bun/server-pull-targets.test.ts`, the existing `route-policy.test.ts` | as T13 |
| U9 | unit (static markup) | T14 | `src/mainview/components/kanban/CreatePrsDialog.test.tsx` | as T14 |
| E1 | e2e | C1–C6 end to end (T17) | `e2e/multi-repo-task.spec.ts`, `e2e/github-stub.ts`, `e2e/task-context-menu.spec.ts` | S1–S6 below |

**E2E applies.** The change is a user-visible flow that crosses webview → core API → git and the forge (stub).

**Shared setup** (T17 owns it):

- `e2e/github-stub.ts` gains `githubRepoRoutes(owner, repo, { defaultBranch, branches: Record<name, sha> })`. It answers `GET /repos/:o/:r`, `GET …/branches` (one page) and `GET …/branches/:name` (404 when absent).
- Tasks are created with prompts carrying a literal copy of `__agetor_fake_claude_pr_proposal__:<base64url template>` (the e2e backend runs `AGETOR_CLAUDE_DRIVER=fake`).
- Templates use the new reply format: `Repository:`, `Base:`, a compare link with `{{branch:<repo>}}`, `PR title:`, `PR description:`.
- `createPushedMultiTask` gains `baseRef` and `prompt` options.

**Scenarios:**

- **S1 — non-default base, per-repo title and body.** A two-repo task is created with both repositories based on `topic`. Press Create all PRs, the dialog shows 2 checked rows with the proposals' titles and base `topic` (from task), and pressing Create gives 2 POSTs. Each POST's `title` and `body` equal that repository's proposal, `base` is `topic` and `head` is the task branch. Only frontend's body contains `Closes #291`. `GET /tasks/:id` shows `repositories[].prs[0]` = `{url, head, base:"topic", number}` and derived `prUrl` set.
- **S2 — stale stored base.** Before pressing, backend's task branch is reset onto `main` with a new commit and force-pushed to `local`. Its proposal says `Base: main`. The row shows base `main` (from agent) with the "stored base `topic` looks stale" hint, and the POST base is `main`. Frontend keeps `topic`.
- **S3 — extra heads.** Frontend's reply also proposes `e2e-extra` (pushed to `local` and listed by the stub) and `e2e-missing` (not listed).
  - The `e2e-extra` row is unchecked. The test checks it and presses Create: 3 POSTs, and the extra PR's `base` is the agent's `main`.
  - The `e2e-missing` row is disabled with "isn't on origin", and no POST names it.
  - Frontend `prs` has 2 entries. The task-card context menu shows `View frontend PR: …` entries.
- **S4 — single-repo task with two heads.** The Create all PRs button is visible on a single-repo task. Checking both rows and pressing Create gives 2 POSTs with their own titles. `GET /tasks/:id` `prs` has 2 entries and `prUrl` equals the first. The header View PR button opens a menu listing both `head → base` items.
- **S5 — retry and already open** (the existing retry test, moved onto the dialog). The first press fails frontend (stub 500) and creates backend. After a reload, the second press offers only frontend's row. The stub answers 422 with `errors:[{message:"A pull request already exists for agetor-e2e:<head>."}]` and a pulls-search route returns the URL. The row shows "already open" with that URL, and backend's POST count stays 1.
- **S6 — single Create PR chip base.** A single-repo task created from `topic` has a synced branch. Clicking Create PR opens the composer with the base input value `topic`.

The existing scenario "opens one PR per repository and adds Closes only to the issue repository" is folded into S1. `e2e/task-context-menu.spec.ts:262` switches its `view-pr` absence check to a `[data-testid^="task-context-menu-view-pr"]` locator.

**Run recipe:**

```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
bun install                                   # fresh worktree
bun run typecheck
bun test src/shared src/mainview/lib src/mainview/components/kanban \
  src/bun/db-task-prs.test.ts src/bun/db-repositories.test.ts src/bun/db-repositories-fixes.test.ts \
  src/bun/pull-create-task-url.test.ts src/bun/server-multi-repo.test.ts src/bun/server-multi-repo-fixes.test.ts \
  src/bun/pr-targets.test.ts src/bun/server-pull-targets.test.ts src/bun/route-policy.test.ts \
  src/bun/worktree-base-branch.test.ts src/bun/orchestrator-base-branch.test.ts src/bun/pipelines.test.ts \
  src/bun/github-branches.test.ts src/bun/gitlab-branches.test.ts src/bun/bitbucket-branches.test.ts \
  src/bun/agents-fake-pr-proposal.test.ts src/bun/claudemd-citations.test.ts src/cli/tui/Dashboard.test.tsx
bun test                                      # full suite before the final barrier (check `uptime` first; serialize with other agents)
bun node_modules/@playwright/test/cli.js test e2e/multi-repo-task.spec.ts e2e/task-context-menu.spec.ts   # one Playwright run at a time
```

The e2e backend and Vite are started by `playwright.config.ts` (`webServer`, worker-scoped `headless.ts` with a temp data dir and the GitHub stub port). No credentials or seed data are needed beyond what the fixtures create. Never point a run at `~/.agetor`.

## 6. Execution waves

| Wave | Tasks (parallel) | Barrier: green before the checkpoint commit |
| --- | --- | --- |
| 1 | T1, T2, T3, T4, T5, T6 | Typecheck. U1–U6. The whole existing suite. Legacy parsers, `prUrl` readers and fixtures are untouched, and the new optional fields are unused. |
| 2 | T7, T9, T10, T11 | Typecheck. I1, I2, U7, U8. The suite. `toTask` now derives `prUrl` from `prs`, so the old RunPanel and old App keep working on the derived field. |
| 3 | T12, T13, T14 | Typecheck. I3, I4, U9. The suite. |
| 4 | T15, T16 | Typecheck. The full suite. `grep -rn` shows no reference to the deleted legacy exports or to `setRepositoryPrUrl`. |
| 5 | T17 | E1 green (S1–S6 plus the untouched multi-repo and context-menu scenarios), then the full suite once more. |

Same-wave dependencies code against the §4 pinned interfaces:

- T7 and T9 in wave 2 depend on wave-1 tasks only.
- T10 needs T1 and T3 (wave 1).
- T11 needs T1 and T4 (wave 1).

**File-collision check.** Each wave was cross-checked and no path appears twice.

- **Wave 1:** T1 owns `src/shared/{types,task-prs,multi-repo}.ts`. T2 owns the forge adapters. T3 owns `pr-link.ts`/`pr-proposal.ts`. T4 owns the context menu files. T5 owns `agents.ts`. T6 owns `GitHubDialog.tsx`.
- **Wave 2:** T7 owns `db.ts`, the migrations and `server.ts` (stamping block). T9 owns `pr-targets.ts`, `git-host.ts` and `git-provider.ts`. T10 owns `pr-plan.ts`, `provider-info-cache.ts`, `multi-repo-ui.ts` and `api.ts`. T11 owns `task-context-menu.ts` and `App.tsx`.
- **Wave 3:** T12 owns `worktree.ts`, `orchestrator.ts`, `pipeline-runner.ts` and `task-repos.ts`. T13 owns `server.ts` (route and error passthrough) and `route-policy.ts`. T14 owns `CreatePrsDialog.*`.
- **Wave 4:** T15 owns `RunPanel.tsx`, `repo-removal.*`, `pr-proposal.*` and `multi-repo-ui.*`. T16 owns the docs and `CLAUDE.md`.

There is no T8: the server stamping block was merged into T7, because the DB change and its only writer must land in the same wave to keep barrier 2 green.
- **Wave 5:** T17 owns the e2e files.

Cross-wave re-ownership (`server.ts` T7→T13, `pr-proposal.ts` T3→T15, `multi-repo-ui.ts` T10→T15) is sequential, never concurrent.

**Review gates.** Waves 2 and 3 carry `data`/`migration`/`trust` risk (T7, T9, T10, T13). Review them before wave 4 builds on them.

**Delivery.** One PR, reviewed per wave commit, estimated at about 2.5k lines of product code and 2.5k lines of tests. A stack doesn't slice cleanly. The new route's only caller is the dialog (wave 3/4), and the storage change (wave 2) is unobservable without the UI that lists `prs`. Each slice would ship unwired code, which this plan forbids.

## 7. Invariants, runtime shape & risks

**Invariants:**

- **Attribution.** A proposal is attributed to repository R only when its link's host+owner/name equals R's provider identity, or its `Repository:` label equals R's name and its link doesn't name another repository. Enforced at `attributeProposals` (`pr-plan.ts`). The Create all PRs rows, the single chip prefill and the button gate (`proposalHeadsNeedingPr`) all route through it.
- **Extra heads.** A PR from a head other than the live checkout is opened only after an explicit tick, and only when the forge listing says the branch exists. Enforced at `planPrRows` (`checked:false`, disabled unless `onRemote === true`). `runPrBatch` re-checks before each create.
- **Base choice.** Base selection follows D5 in exactly one place, `chooseBase` (`pr-plan.ts`). The dialog's "edited by you" path goes through `editPrRow`, which re-validates against the listing.
- **PR records.** PR records are only ever **appended** by `POST /github/pull-create` stamping, through `tasks.appendPr` / `tasks.appendRepositoryPr`: targeted UPDATEs, no `updated_at` bump. They are never written by PATCH or the generic SET.
- **Stored base.** `base_branch` and `repositories[].baseBranch` are written only by `tasks.insert`, from `createTask` and the step copy, and never change after.
- **Branch names into git.** Agent-supplied branch names reach git argv only after `validateBranchName` and a leading-`-` check, in `pr-targets.ts`. Forge URLs encode names. No agent text ever selects a repository or a remote.
- **Product name.** No prompt text names the product (T1 test).
- **Raw events.** Persisted events stay raw. All proposal parsing is client-side.

**Runtime shape:**

- One core and one webview.
- **Stamping race.** Two concurrent `pull-create` stamps are serialized by bun:sqlite's synchronous read-modify-write inside one JS turn (`appendPr` does get + UPDATE with no await between).
- **Concurrent presses.** `beginPrBatch` keeps it to one walk per task, and `prOpenedInSession` covers the gap before the poll.
- **Crash between create and stamp.** The PR exists unstamped. The next press gets "already exists", which is shown as already open (D11), not as a failure.
- **Forge outage or a missing token.** `branchesError` is set and existence is unknown. Live heads stay creatable, extra heads are disabled, and the forge's own error surfaces per row.
- No kill switch is needed: the old one-click path is gone, and the dialog is the gate.

**Blast radius:**

- **Task JSON** (`GET /tasks`, `agetor ls --json`) gains `prs` and `baseBranch`. `prUrl` keeps its meaning (the first PR).
- **Migration 092** is additive. `pr_url` is kept but no longer written. A downgrade to ≤1.2.1 still runs, but won't see PRs opened after the upgrade, which is accepted (G#22).
- **Prompt text** changes for the CLI and TUI too (C3).
- **Context-menu labels** change ("View PR: <head>").
- **Pipeline steps** copy `baseBranch`.

**Cross-repo dependencies:** none.

## 8. Open questions / assumptions

**Unratified one-way decisions:** none. The owner answered every one-way door (G#3, G#16, G#20, G#22, G#23).

**Plan-level calls, all approved by the owner at plan approval (2026-11-17)** (two-way, reversible in code):

1. **Q1 — Stale definition (D4). Owner picked the pinned-sha rule.** It corrects G#2's literal wording ("the stored base's remote tip isn't an ancestor") to "the pinned create-time sha is not an ancestor and the remote tip is not a known ancestor". The literal rule would call every normally-advanced base stale and hand the PR to the agent's base.
2. **Q2 — No stored base (D5).** The agent's base comes before the remote default, matching the owner's round-1 order.
3. **Q3 — Single-repo, unlabeled, linkless proposal (D6).** It goes to the live head (today's single-chip behavior). In multi-repo tasks such a proposal is never attributed.
4. **Q4 — `Closes #N` (D12).** Only the issue repository's live-head PR gets it.
5. **Q5 — Extra head with unknown remote status.** When the listing fails, the extra-head row is disabled. Only the live head stays creatable.
6. **Q6 — Already-exists PRs (D11).** They are shown as already open and not stamped onto the task.

**Assumptions proceeding:**

- **Branch facts.** They come from the forge REST API (D2). No `git fetch` is issued (D3).
- **Proposal window.** Proposals are read from the run panel's loaded event window, as today. A Commit & push reply older than the loaded history isn't seen, and its row shows "no proposal" with an editable title.
- **Derived `prUrl`.** It is `prs[0]` per level (the grill's open assumption, kept).
- **Q7 — Older-core JSON.** `taskPrsOf` reads `prUrl` only when `prs` is absent, so a newer CLI or webview reading an older core's JSON still sees its PR. G#23 says agetor never reads `prUrl`. This is the one tolerant fallback, never reached with a same-version core.
- **Converted legacy entries.**
  - Task level (092 backfill): `head = checkout_branch ?? branch`, `base`/`number` null, `createdAt = updated_at`.
  - Repository level (read time): `head = checkoutBranch ?? branch`, `base`/`number` null, `createdAt = 0`.
- **Q10 — Unverified forge behavior.** GitLab `target_branch` and Bitbucket `dest` link parameters are community-sourced. Bitbucket's duplicate-PR error wording is unverified, so its already-exists match is a best-effort pattern with a synthetic fixture. A miss shows as an ordinary failure, the pre-change behavior. The `Base:` line keeps Create all PRs correct even if a link parameter is ignored.
- **Agents may ignore the new prompt.** D5 and D6 plus the editable list cover a missing `Base:` line or a `pull/new` link.

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| `createAllPrs` attribution, base and confirm list (`RunPanel.tsx:3785`) | in this run | T10, T14, T15 |
| Proposal parser: all proposals, `Base:` line, per-proposal link window | in this run | T3 |
| Forge link parsing (GitHub compare and `pull/new`, GitLab, Bitbucket) | in this run | T3 |
| Blind single-target fallback removed (`pr-proposal.ts:326`) | in this run | T15 (deletion), D6 |
| Create-time base name: single, multi, HEAD rule, normalization | in this run | T12 |
| Migration 092 (`base_branch`, `prs`, backfill) and its index entry | in this run | T7 |
| `parseTaskRepositories` / `setRepositories` / `setRepositoryCheckout` / insert / generic SET moved to `prs`; `setRepositoryPrUrl` removed | in this run | T7 |
| Server stamping appends (`server.ts:3392-3417`) | in this run | T7 |
| `pull-create` already-exists classification and passthrough (GitHub, GitLab, Bitbucket) | in this run | T2, T9, T13 |
| Forge branch list, lookup and default branch (3 providers) | in this run | T2, T9 |
| `GET /github/pull-targets` and its `ROUTE_POLICY` entry | in this run | T13 |
| `api.ts` client (`getPullTargets`, error body) | in this run | T10 |
| `commitPushPrompt` single and multi, and its doc comment; CLI `agetor commit` and TUI `c` follow automatically | in this run | T1 |
| Tests pinning the old prompt (`branch.test.ts:190-240`, `multi-repo.test.ts:184-223`) | in this run | T1 |
| `Task`/`TaskRepository` types, `TaskPr`, derived `prUrl` | in this run | T1 |
| `repositoriesForTask` / `RepoTaskShape` (`multi-repo.ts:16,77,89`) | in this run | T1 |
| About 80 fixture files with `prUrl: null` | in this run, **no edit needed** by design (optional `prs`/`baseBranch`, D1) | T1 |
| Fixtures that drive PR behavior with `prUrl: "…"` (`task-context-menu.test.ts`, `pull-create-task-url.test.ts`, `server-multi-repo*.test.ts`, `db-repositories*.test.ts`, `repo-removal.test.ts`, `pr-proposal.test.ts`) | in this run | T7, T11, T15 |
| Pipeline step copy (`pipeline-runner.ts:1434-1441`) | in this run | T12 |
| `orchestrator.ts:12941` and `task-repos.ts:78` entry construction | in this run | T12 |
| Context menu per-PR entries and the submenu past 3 | in this run | T4, T11 |
| App View-PR handlers (`App.tsx:2497,2509`) | in this run | T11 |
| Repository details rows (`repo-removal.ts:84,112`, `RunPanel.tsx:8930`) | in this run | T15 |
| RunPanel header View PR, mergeability source, PR menu | in this run | T15 |
| Single Create PR chip base prefill (`GitHubPullPrefill`, defaults effect) | in this run | T6, T15 |
| Create all PRs on single-repo tasks | in this run | T10, T15 |
| PR batch store keyed by (task, repo, head) | in this run | T10, T15 |
| Orphaned legacy exports (`latestPrProposal`, `latestProposalForRepository`, `latestProposalsForTargets`, `latestRepositoryProposals`, `parseRepositoryProposals`, `repositoriesNeedingPr`, `markRepositoryPrOpened`, `repositoriesForPrBatch`, `tasks.setRepositoryPrUrl`) | in this run | T15, T7 |
| Commit & push tooltip (`RunPanel.tsx:5053`) | in this run | T15 |
| `pr-proposal.ts` header comment | in this run | T3 |
| Fake-claude assistant-stream proposal marker | in this run | T5 |
| E2E: title, body and base via the stub; stale; extra heads; single-repo; retry and already open; chip base | in this run | T17 |
| `e2e/task-context-menu.spec.ts:262` `view-pr` locator | in this run | T17 |
| Docs: `multi-repo-tasks.md`, `run-panel.md`, `persistence.md`, `pipelines.md:422`, `task-context-menu.md`, `security.md`, plans A10, CLAUDE.md list | in this run | T16 |
| Spec copied into the repo (`docs/specs/create-all-prs-title-and-base.md`) | in this run (written at planning; commit it first, as its own docs commit) | planning |
| `GitHubDialog` base field stays a free-text input | out of scope | The composer UX isn't part of the ask. The prefill (C6) is the change. |
| `/github/pull-defaults`' literal `"main"` fallback (`github.ts:1276`) used when the composer opens without a prefill | out of scope | Create all PRs and the chip no longer read it (D5 uses `<remote>/HEAD`, then the forge default). Changing the composer's own default is a different ticket. |
| Stamping a PR found as "already exists" onto the task | out of scope | No owner decision. It would record a PR agetor didn't open, which is a separate behavior change. |
| The owner's own "Commit And Push" pipeline step text | out of scope | It lives in the owner's DB. Owner decision G#32. |
| Stamping a step's PR on the pipeline parent | out of scope | Documented limitation. Owner decision G#28. |
| Backfilling `base_branch` for existing tasks | out of scope | Not reliably possible (one sha matched three refs). Owner decision G#29. |
| Dropping the `tasks.pr_url` column | out of scope | Kept for downgrade safety. Owner decision G#22. |
| Removing the deprecated derived `prUrl` from Task JSON | out of scope | Contract kept. Owner decision G#23. |
| Loading older history to find a proposal beyond the panel's loaded window | out of scope | Existing behavior of every proposal reader. The editable title covers it (§8). |
