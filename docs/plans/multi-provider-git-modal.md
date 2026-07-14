# Plan — Multi-provider (GitHub / GitLab / Bitbucket) PRs & issues modal

| Field | Value |
| --- | --- |
| Date | 2026-07-14 |
| Source | /implement: "besides the modal name be Github, we're only supporting github there, we must support bitbucket and gitlab as well" + screenshot (modal shows "project does not have a GitHub remote") |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | fix/support-bitbucket-and-gitlab |
| Base SHA | dfb16bb7cfe107633aa905d48a04655675854a91 |
| Mode | **Autonomous** — grill + plan-approval gates bypassed; all owner decisions logged in §8 |

## 1. Objective & success criteria

A project whose remote points at GitLab or Bitbucket Cloud (including via `~/.ssh/config` host aliases like `git@gitlab-work.io:group/app.git`) gets a working PRs/MRs + issues modal instead of "project does not have a GitHub remote".

Success criteria:
- Modal title/terminology follows the selected project's provider (GitHub / GitLab "Merge requests" / Bitbucket).
- Core flow works on all three providers: list + filter PRs/MRs and issues, expand detail, view diff, list/create comments, inline line comments + replies, CI status, create PR/MR (incl. push-head), merge, close/decline, approve, create/update issue.
- GitHub-exclusive panels and actions are hidden (not broken) for non-GitHub projects.
- Existing GitHub behavior is unchanged; full test suite green (modulo the pre-existing `claude-followup-restart.test.ts` flake on base).

## 2. Context & constraints (grounded)

- `src/bun/github.ts` (~4,635 lines, ~80 exports). `canonicalGitHost` (github.ts:568) **already** maps any host containing github/gitlab/bitbucket → `github.com`/`gitlab.com`/`bitbucket.org`; `parseGitRemote` (582) is provider-agnostic; `parseGitHubRemote` (595) hard-filters to `github.com` — the single gate producing the error. `repoForDir` (820) returns a GitHub-only repo. **None of these three are exported** (only via `__githubInternals`) — they need real exports.
- Auth: `githubToken(host)` (856) resolves raw-ssh-alias host → `github-tokens.ts` store (`~/.agetor/github-tokens.json`, `{host, token, label}[]`, keyed by RAW pre-canonicalization host) → `GITHUB_TOKEN`/`GH_TOKEN` env → `gh auth token`. The store is host-keyed so it can hold gitlab/bitbucket alias hosts with **zero schema change**.
- Routes: ~70 `/github/*` routes in `src/bun/server.ts` (640–2447), 1:1 to github.ts exports, `authed(...)`, `{ok:false,error}` result convention.
- UI: `src/mainview/components/kanban/GitHubDialog.tsx` (8,427 lines). Trigger in `App.tsx:605-613`. Subtitle "Pull requests and issues" at GitHubDialog.tsx:2642. Provider identity is hardcoded strings, no badge component.
- Diff parsing is already provider-neutral: `git-diff.ts` `parseGitDiff` + `src/mainview/lib/diff-rows.ts` parse raw unified diffs; GitLab (`/raw_diffs`) and Bitbucket (`/diff`) both return raw unified diffs.
- Test conventions: `github-test-util.ts` (`makeGitHubRepo`/`makeAliasGitHubRepo` real git-init repos; `mockGitHubFetch` ordered route table over `globalThis.fetch`); `github-network.test.ts` exercises URL/headers/pagination end-to-end.
- Provider API facts (researched 2026-07, doc URLs in the research brief):
  - GitLab v4: project id = `encodeURIComponent("owner/name")`. MRs `GET /projects/:id/merge_requests` (`state=opened|closed|merged|all`, `labels`, `search`, `scope=created_by_me|assigned_to_me|reviews_for_me`, `order_by`, `sort`). Issues analogous. Detail `GET .../merge_requests/:iid`; raw diff `GET .../merge_requests/:iid/raw_diffs`; notes API for comments; discussions API + `position{base_sha,start_sha,head_sha,old_path,new_path,old_line,new_line}` for line comments (SHAs from `.../versions`); `PUT .../merge` (`squash`); `state_event=close|reopen`; `POST .../approve`; pipelines + `GET /projects/:id/repository/commits/:sha/statuses` for CI; `POST/PUT /projects/:id/issues`. Auth header `PRIVATE-TOKEN`. Pagination `page`/`per_page` + `Link rel=next`. Viewer: `GET /user`.
  - Bitbucket 2.0: `GET /2.0/repositories/{ws}/{slug}/pullrequests` (states OPEN/MERGED/DECLINED/SUPERSEDED, repeatable `state` param; BBQL `q=` for filters, `sort=-updated_on`); detail `GET .../pullrequests/:id`; raw diff `GET .../pullrequests/:id/diff`; comments `GET/POST .../comments` (inline `{path,to,from}`, replies via `parent.id`); `POST .../merge` (`merge_strategy: merge_commit|squash|fast_forward`); `POST .../decline`; `POST .../approve` + `POST .../request-changes`; commit build statuses `GET /2.0/repositories/{ws}/{slug}/commit/{sha}/statuses`; issues `GET/POST/PUT /2.0/.../issues` (**no labels**; states new/open/resolved/...; tracker optional per-repo and sunsets 2026-08-20 — best-effort with friendly 404 error). Auth: Basic (email + API token) or Bearer (access token). Pagination: body `next` URL. Viewer: `GET /2.0/user`. NO app passwords (dead 2026-06-09).
  - No official Bitbucket CLI; `glab` exists for GitLab (`GITLAB_TOKEN` env, `~/.config/glab-cli/config.yml`).

## 3. Approach & key decisions

1. **Adapter modules + thin dispatch facade; reuse existing wire types.** New `src/bun/gitlab.ts` and `src/bun/bitbucket.ts` implement the core subset, normalizing into the **existing** `GitHub*` shared types (`GitHubListItem`, `GitHubComment`, `GitHubPullLineComment`, `GitHubCheckRun`, …) so the UI/wire contract barely moves. No mass type rename (rejected: churn across 13k lines for zero behavior).
2. **Provider detection** in new `src/bun/git-provider.ts`: `providerRepoForDir(dir)` → `{ provider: "github"|"gitlab"|"bitbucket", host (canonical), remoteHost (raw alias), owner, name }`, built on the now-exported `parseGitRemote` + `canonicalGitHost`. GitHub path keeps using `repoForDir` internally — behavior identical.
3. **Dispatch at the route layer via facade** `src/bun/git-host.ts`: for the ~22 core operations, server.ts handlers call `gitHost.listItems(...)` etc., which detects the provider and dispatches to github/gitlab/bitbucket modules. Non-core routes keep calling github.ts directly (they are GitHub-only features). Route paths stay `/github/*` (no client URL churn); one new route `GET /github/provider-info?path=` returns provider + repo identity for the UI.
4. **Auth reuses the per-host token store as-is** (raw-host keyed). Resolution: store → env (`GITLAB_TOKEN` / `BITBUCKET_TOKEN` [+`BITBUCKET_EMAIL`]) → CLI (`glab` for GitLab; none for Bitbucket). Bitbucket credential convention: token value containing `:` → Basic (`email:api_token`, base64); otherwise Bearer (workspace/repo access token). Settings hint text updated.
5. **CI status collapses to the CheckRuns UI**: GitLab pipelines/statuses and Bitbucket build statuses are mapped into `GitHubCheckRun` shape; the separate CommitStatus panel stays GitHub-only.
6. **Feature gating in the dialog, driven by provider-info**: a `ProviderCaps` map (in shared/types.ts) declares which features each provider supports; the dialog hides unsupported affordances. GitHub loses nothing.
7. **Aggregate "All repositories" mode** dispatches per `sourcePath` through the facade, so mixed-provider aggregation works; items already carry `sourcePath`.

## 4. Work breakdown — implementation tasks

**T1 — Foundation: provider detection + shared types + auth plumbing** (Wave 1)
Files owned: `src/shared/types.ts`, `src/bun/git-provider.ts` (new), `src/bun/github.ts` (export-only edits), `src/bun/github-tokens.ts` (doc/label tweaks only).
- Export `parseGitRemote`, `canonicalGitHost`, `repoForDir`, `githubToken` (keep `__githubInternals` intact).
- `git-provider.ts`: `GitProvider` dispatch on canonical host; `providerRepoForDir(dir)` (mirrors `repoForDir`'s remote iteration: `origin` first, then others, first parseable wins); `gitlabToken(host)` (store → `GITLAB_TOKEN` → `glab config get token --host <canonical>` best-effort 5s timeout); `bitbucketCreds(host)` (store → `BITBUCKET_TOKEN`+`BITBUCKET_EMAIL`; `email:token` → Basic, else Bearer). Reuse `tokenForHost` from github-tokens.ts.
- types.ts: `GitProvider = "github"|"gitlab"|"bitbucket"`, `ProviderRepoInfo`, `ProviderCaps` + `PROVIDER_CAPS` const (flags: labels, milestones, searchSyntax, reviewRequested, checks, commitStatus, reactions, draft, autoMerge, suggestions, subIssues, projects, discussions, actions, notifications, releases, issueTracker, requestChanges, mergeMethods list, terminology strings {pullNoun:"Pull request"|"Merge request", pullAbbrev:"PR"|"MR"}).
- Acceptance: typecheck green; `providerRepoForDir` resolves alias hosts (`git@gitlab-work.io:acme/app.git` → gitlab) exactly like the github path does.

**T2 — GitLab adapter** (Wave 2, parallel with T3)
Files owned: `src/bun/gitlab.ts` (new only).
Implements (all returning existing `{ok:true …}|{ok:false,error}` unions with existing shared types): `listGitLabItems` (MRs+issues, filters: state/labels/search/scope/order_by; maps `iid`→number, `description`→body, state opened→open, merged→merged flag semantics matching `GitHubListItem`), `getGitLabPullDefaults` (default_branch from `GET /projects/:id`), `createGitLabPull`, `getGitLabPullDiff` (raw_diffs → `parseGitDiff`), `listGitLabComments`/`createGitLabComment` (notes), `listGitLabPullLineComments` (discussions w/ position → `GitHubPullLineComment`, old_line→LEFT, new_line→RIGHT), `createGitLabPullLineComment` (fetch versions for SHAs; side RIGHT→new_line, LEFT→old_line), `replyGitLabLineComment` (discussion notes), `getGitLabPullChecks` (latest MR head pipeline + commit statuses → `GitHubCheckRun[]`; status map: running→in_progress, pending→queued, success/failed/canceled/skipped→completed+conclusion), `mergeGitLabPull` (merge|squash), `closeGitLabPull`/`reopenGitLabPull` (state_event), `approveGitLabPull`, `createGitLabIssue`, `updateGitLabIssue`, `getGitLabViewer` (`GET /user` → login=username), `listGitLabLabels` (for the labels filter/triage). Internal: `fetchGitLab` (PRIVATE-TOKEN header, 30s abort, api base `https://<canonical-or-raw?>/api/v4` — use canonical host `gitlab.com` for cloud; self-hosted out of scope, §8), `encodeProjectId(owner,name)`, pagination via `page/per_page` + Link header, `__gitlabInternals` export for tests.
Acceptance: typecheck green; no imports from server.ts/db.ts; mirrors github.ts error-string style ("project does not have a supported git remote" is produced by the facade, not here — adapter assumes a resolved repo arg `{remoteHost, owner, name}`).

**T3 — Bitbucket adapter** (Wave 2, parallel with T2)
Files owned: `src/bun/bitbucket.ts` (new only).
Same contract style: `listBitbucketItems` (PRs via repeatable `state` params + BBQL `q=` for query/author/reviewer; issues via issue tracker; state map OPEN→open, MERGED→merged, DECLINED/SUPERSEDED→closed; sort `-updated_on`/`-created_on`; "best match" degrades to `-updated_on`), `getBitbucketPullDefaults` (`mainbranch.name` from repo GET), `createBitbucketPull`, `getBitbucketPullDiff` (raw diff → `parseGitDiff`), `listBitbucketComments`/`createBitbucketComment` (non-inline comments; `content.raw`), `listBitbucketPullLineComments` (inline `{path,to,from}` → side to→RIGHT/from→LEFT), `createBitbucketPullLineComment`, `replyBitbucketLineComment` (`parent.id`), `getBitbucketPullChecks` (PR commit statuses → `GitHubCheckRun[]`: INPROGRESS→in_progress, SUCCESSFUL→success, FAILED→failure, STOPPED→cancelled), `mergeBitbucketPull` (merge_strategy map: merge→merge_commit, squash→squash, rebase→fast_forward exposure per caps), `closeBitbucketPull` (decline), `approveBitbucketPull`, `requestChangesBitbucketPull`, `createBitbucketIssue`, `updateBitbucketIssue` (issue state machine: open/new→open, resolved/closed/etc→closed; 404 → friendly "issue tracker is not enabled for this repository"), `getBitbucketViewer` (`GET /2.0/user` → login=username). Internal: `fetchBitbucket` (Basic when creds contain email, else Bearer; base `https://api.bitbucket.org`), pagination follows body `next` URL, `__bitbucketInternals` for tests.
Acceptance: typecheck green; standalone module.

**T4 — Facade + routes + client API** (Wave 3)
Files owned: `src/bun/git-host.ts` (new), `src/bun/server.ts`, `src/mainview/lib/api.ts`.
- `git-host.ts`: `providerInfoForDir(dir)` → `{ok, provider, owner, name, host}|{ok:false,error}`; dispatch wrappers for the core ops (listItems incl. aggregate-across-repos per-sourcePath dispatch, pullDefaults, pullCreate, pullDiff, comments list/create, line comments list/create/reply, pullChecks, pullMerge, pullClose, pullReopen, pullReview/approve+requestChanges, issueCreate, issueUpdate, viewer, labels). GitHub branch delegates to existing github.ts functions untouched. Non-supported op on a provider → `{ok:false, error:"not supported on <provider>"}` (defense; UI hides these anyway). Unknown provider → `{ok:false, error:"project does not have a supported git remote (GitHub, GitLab, or Bitbucket)"}`.
- server.ts: repoint ONLY the core routes listed above to git-host.ts; add `GET /github/provider-info`. All other `/github/*` routes untouched.
- api.ts: add `getProviderInfo(path)`; existing wrappers unchanged (same URLs).
- Acceptance: typecheck green; GitHub requests flow through identical code paths as before (github.ts functions unchanged).

**T5 — Dialog UI: provider awareness** (Wave 4, single agent)
Files owned: `src/mainview/components/kanban/GitHubDialog.tsx`, `src/mainview/App.tsx`.
- Fetch provider-info when `projectPath` changes (aggregate mode → provider "mixed": generic labels, GitHub-only panels hidden unless all selected repos are GitHub — simplest: hidden in aggregate unless every project resolves github; acceptable v1: hide in aggregate mode when any non-GitHub project present, existing behavior otherwise).
- Title header: provider display name ("GitHub"/"GitLab"/"Bitbucket"; aggregate → "Git"); subtitle stays "Pull requests and issues" (GitLab: "Merge requests and issues"). Tab label "PRs"→"MRs" for GitLab. "New PR"→"New MR". App.tsx toolbar `aria-label`/`title` → "Git pull requests and issues".
- Gate via `PROVIDER_CAPS[provider]`: hide labels filter+triage (bitbucket), milestones (bitbucket), search-syntax GH toggle (non-github), "Review requested" mine-filter (bitbucket keeps it → maps server-side to reviewers; keep visible), comments sort option (non-github → drop "comments" from sort fields), reactions/sub-issues/pin/lock/transfer/suggestions/auto-merge/draft-toggle/update-branch/CommitStatus panel/linked-issues (github-only), manager panels: Labels/Milestones/Releases/Notifications/Actions/Projects/Discussions buttons (github-only), merge-method options from caps (gitlab: merge+squash; bitbucket: merge+squash+fast-forward), review verdicts (gitlab: approve+comment; bitbucket: approve+request-changes+comment).
- Error copy: surface backend errors as-is (backend now says "supported git remote").
- Acceptance: typecheck + vite build green; GitHub project renders identically to today.

## 5. Work breakdown — test tasks (Phase 6)

**TT1** — `src/bun/git-provider.test.ts` + facade tests (`git-host.test.ts`): provider detection across https/ssh/scp/alias hosts; dispatch routing; unsupported-op errors; token resolution order (env manipulation à la github-tokens tests). Owns those two new files only.
**TT2** — `src/bun/gitlab.test.ts` + `src/bun/gitlab-network.test.ts` + `src/bun/gitlab-test-util.ts`: normalizers (item/comment/line-comment/check mapping, state maps, LEFT/RIGHT↔old/new), URL/header (PRIVATE-TOKEN)/pagination via mock-fetch harness patterned on github-test-util.ts (makeAliasRepo with gitlab alias host). Owns those three new files.
**TT3** — `src/bun/bitbucket.test.ts` + `src/bun/bitbucket-network.test.ts` + `src/bun/bitbucket-test-util.ts`: BBQL building, state maps, inline to/from↔side, Basic-vs-Bearer header choice, `next`-URL pagination, issue-tracker-404 friendly error. Owns those three new files.

## 6. Execution waves

- Wave 1: T1 (blocks everything — types + exports).
- Wave 2: T2 ∥ T3 (disjoint new files).
- Wave 3: T4.
- Wave 4: T5.
- Review (Phase 5) → Tests Wave: TT1 ∥ TT2 ∥ TT3 (disjoint) → run suite → fixes.

## 7. Blast radius & risks

- github.ts edits limited to adding `export` keywords — regression risk near zero; full github test suite is the guard.
- server.ts core-route repointing is the riskiest edit (route bodies rewritten to call the facade) — mitigated by keeping request/response shapes identical and by github-network.test.ts exercising GitHub flows end-to-end through routes? (they exercise github.ts directly — the facade's GitHub branch is a pass-through, low risk).
- GitHubDialog.tsx is 8.4k lines — gating must be additive (`caps.x && …`) to avoid layout regressions for GitHub.
- Bitbucket issue tracker sunsets 2026-08-20 — implemented best-effort with friendly errors; noted for roadmap.
- Bitbucket diff truncation limits (8000 lines/200 files) — raw diff may be truncated server-side; parser tolerates it.
- Self-hosted GitLab/Bitbucket Server are OUT of scope (canonical-host heuristic maps any *gitlab* host to gitlab.com cloud API).

## 8. Open questions / assumptions (autonomous mode — logged, not asked)

1. **Scope cut**: "support bitbucket and gitlab" = core PR/MR+issue flow only; the 15 GitHub-exclusive panels (Projects, Discussions, Actions, Notifications, Releases, Reactions, Sub-issues, …) stay GitHub-only and hidden elsewhere. Full parity is structurally impossible (Bitbucket has no such APIs).
2. **Cloud only**: gitlab.com and bitbucket.org (API v2 cloud). Self-hosted instances deferred (the ssh-alias canonicalization heuristic can't distinguish them anyway).
3. **Types**: reuse `GitHub*` shared types as neutral wire shapes rather than renaming — smallest diff, zero UI churn.
4. **Routes stay under `/github/*`** + new `/github/provider-info`; renaming the namespace would churn the client for no behavior.
5. **Token store shared**: gitlab/bitbucket tokens live in the existing `github-tokens.json` per-raw-host store (it's host-keyed already). Bitbucket Basic credentials stored as `email:api_token` in the token field.
6. **Aggregate mode**: mixed providers aggregate core items; GitHub-only panels hidden in aggregate when any selected repo is non-GitHub.
7. **Bitbucket "Review requested"** approximated with `reviewers.username="<me>"` BBQL (no request-state machine exists there).
8. **App passwords not supported** (dead as of 2026-06-09) — API tokens / access tokens only.
