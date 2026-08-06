# Plan — New PR as a Git Integration page + task Open/View PR routes into the modal

| Field | Value |
| --- | --- |
| Date | 2026-07-30 |
| Source | /implement invocation: "New PR should be a page in the Git Integration, just like when opening a PR. And the Open or View PR from the Task should open the Git Integration modal and on that page" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/new-pr |
| Base SHA | 5953e190c262b598ad36a10c449b984517bd19a1 (tree clean) |
| Mode | **Autonomous** — grill + plan-approval gates bypassed (headless run, no owner present); all assumptions logged in §8 |

## 1. Objective & success criteria

1. The New-PR composer in the Git Integration modal (`GitHubDialog`) becomes a **dedicated subpage** of the modal — same navigation pattern as the PR/issue detail subpage (back-chevron header, Escape pops to list, filter bar/panels/list hidden while on the page).
2. The task's **"Open PR"** chip (RunPanel, post commit-&-push) opens the modal directly **on that New-PR page**, prefilled as today.
3. The task's **"View PR"** header link opens the modal **on that PR's detail subpage** instead of jumping straight to the browser (browser access remains via the detail page's open-on-GitHub affordance; external open remains the fallback if the PR can't be fetched).

Done = typecheck green, `bun test` green, behaviors verified in code review.

## 2. Context & constraints (verified findings)

- Subpage navigation is the `GitHubDialogView` union in `src/mainview/lib/github-dialog-view.ts:26-29` — `{kind:"list"} | {kind:"detail"; item: GitHubListItem} | {kind:"panel"; panel}` with helpers `openDetail/openPanel/backToList/togglePanel/resolveEscape`. `GitHubDialog.tsx` holds `view` state (line 554), header 3-way ternary (2845-2913), body ternary (3207), `Dialog onClose` pops via `resolveEscape` (2834-2840). **No exhaustive switch on `view.kind` anywhere** — every consumer is an ad-hoc boolean (`showDetail` 2823, `isPanelView` 2824); a new member must be manually threaded through header, toolbar (2926), filter bar (3038), body.
- The composer is currently **inline, boolean-gated**: `pullComposerOpen` (648) / `issueComposerOpen` (640); `PullComposer` (3646-3806) / `IssueComposer` (3808-3922) render inside the list body at 3522/3549, gated `kind==="pulls"|"issues" && !isAggregate`. The "New PR"/"New issue" trigger button is embedded *inside* each composer component when closed (3693-3701 / 3843-3851). Escape while composing **closes the whole dialog** today (view is still `"list"`).
- Submit: `createPull` (2675-2706) / `createIssue` (2626-2657) → `POST /github/pull-create` / `issue-create` → `upsertListItem(result.item, true)` (prepend), closes composer, success banner — **no navigation to detail**.
- Reset asymmetry (**known bug**): `[projectPath, kind]` effect (938-960) resets both composers; `[open]` close-reset (987-997) resets **only** the pull composer — issue-composer state leaks across opens of the always-mounted singleton (`App.tsx:864-873`).
- `pullPrefill` one-shot (from PR #133): producer `RunPanel.tsx:2405-2423` ("Open PR" chip, gated `!task.prUrl && task.branch != null && shouldOfferOpenPr(gitStatus) && !sending`) → `App.tsx:846-849` sets `githubPullPrefill` + opens; consumption is a two-effect dance (`GitHubDialog.tsx:685-696` sets projectPath/kind; 969-979, declared *after* the `[projectPath,kind]` reset, opens + seeds) with `lastPullPrefillRef`/`pendingPullPrefillRef` dedupe.
- "View PR": `RunPanel.tsx:2011-2019`, an `ExternalLink` (file-private, 3856-3879, `^(https?|mailto):` whitelist, `api.openExternal`) on `task.prUrl` — full provider `html_url`, set server-side only by `pull-create` (`server.ts:1657-1664`), never patchable. **No PR-URL parser exists anywhere; no fetch-single-PR/issue route exists** (`/github/discussion?path=&number=` proves the single-item-GET pattern for discussions only). Detail views need a **full `GitHubListItem`** (`openDetail(item)`; `expandedItem` memo 1020-1027 re-resolves against `result.items` by `itemKey` with snapshot fallback).
- Server side resolves owner/repo fresh from the directory's git remote (`providerRepoForDir`, `git-provider.ts`) — `projectPath` is a filesystem path; RunPanel deliberately passes `task.workdir` (not `worktreePath`).
- `git-host.ts` is the multi-provider dispatch layer (github/gitlab/bitbucket adapters, `withSourcePath(item, dir)` stamping). Mutation routes (e.g. `pullReopen` 527) already return fresh mapped items per provider.
- Tests: pure-logic only (no jsdom/RTL). `github-dialog-view.test.ts` (helpers), `pr-proposal.test.ts`, `commit-push.test.ts`, `pull-create-task-url.test.ts` (server route w/ network-test utils `github-test-util.ts` etc.). Test cmd: `bun test`; typecheck: `bun run typecheck`.
- RunPanel is the **only** PR entry point in the webview (TaskCard/Column/DiffDialog have zero PR code).

## 3. Approach & key decisions

- **Compose = 4th view-union member** `{ kind: "compose" }` (no payload: which composer shows follows the dialog's existing pulls/issues `kind` state, mirroring how the list body already switches). Alternative considered — `{kind:"compose"; itemKind}` payload — rejected: duplicates existing `kind` state and invites drift.
- **Both composers** ride the new view (PR *and* issue): same mechanics, keeps the union coherent, and unifying the `[open]` reset fixes the issue-composer leak. (Assumption A1.)
- **Post-create navigation**: success now navigates to the created item's **detail subpage** (`setView(openDetail(result.item))`) after `upsertListItem(result.item, true)` — "a page, just like when opening a PR" end-to-end. (A2.)
- **View PR** routes through a new one-shot `pullDetailPrefill` prop (mirroring `pullPrefill`'s dance): App passes `{ projectPath, number, prUrl }`; the dialog sets projectPath/kind, fetches the item via a **new `GET /github/pull-detail?path=&number=` route**, then `setView(openDetail(item))`. On fetch failure: toast + fall back to `api.openExternal(prUrl)` (old behavior preserved). (A3.)
- **New server route** implemented in `git-host.ts` (`pullDetail({dir, number})`) dispatching per provider, reusing each adapter's existing single-item fetch/mappers (the same ones mutation responses use). GitHub support is mandatory; GitLab/Bitbucket best-effort — a friendly `{ok:false,error}` triggers the UI fallback. (A4.)
- **PR number parsing** from `task.prUrl` in a new pure module `src/mainview/lib/pr-url.ts` (handles `/pull/N`, `/merge_requests/N`, `/pull-requests/N` tails; returns `number | null`; null → keep old external-link behavior).
- Escape/back semantics: compose **pops to list** via `resolveEscape` (behavior change from close-dialog — consistent with detail/panel). Draft fields keep their current lifecycle (survive a pop; wiped on project/kind change and on dialog close).
- Filter-change effect (865-931) pops `compose` like `detail` (stale draft under changed scope is confusing; also the filter bar is hidden in compose anyway).

## 4. Work breakdown — implementation tasks

**T1 — backend single-PR fetch + API client** (Wave 1)
- Owns: `src/bun/git-host.ts`, `src/bun/github.ts`, `src/bun/gitlab.ts`, `src/bun/bitbucket.ts` (only if needed), `src/bun/server.ts`, `src/mainview/lib/api.ts`.
- Goal: `pullDetail({dir, number}) → {ok:true; item: GitHubListItem} | {ok:false; error}` in git-host (provider dispatch, `withSourcePath`); route `GET /github/pull-detail?path=&number=` in server.ts following the object-style `routes` shape + existing param validation idioms; client fn `getGitHubPullDetail(path, number)` in api.ts following its fetch/auth idioms.
- Acceptance: typecheck green; route returns a mapped item for GitHub repos; non-numeric/missing params → 400-style error like sibling routes.

**T2 — compose view-union refactor** (Wave 1)
- Owns: `src/mainview/lib/github-dialog-view.ts`, `src/mainview/components/kanban/GitHubDialog.tsx`.
- Goal: add `{kind:"compose"}` + `openCompose()`; `resolveEscape` returns `"pop"` for compose; delete `pullComposerOpen`/`issueComposerOpen`; move trigger buttons out of the composer components into the list toolbar area (`setView(openCompose())`, still gated `!isAggregate` + matching `kind`); compose header branch (back chevron + "New pull request"/"New issue" per `kind`); hide filter bar, panels, and list in compose view; composer Cancel → `setView(backToList())`; `pullPrefill` part-2 sets `setView(openCompose())` instead of the boolean; success handler navigates `setView(openDetail(result.item))`; unify `[open]` reset (both composers' fields + `setView(backToList())` on close); filter-change effect pops compose.
- Acceptance: typecheck green; no references to the deleted booleans remain; aggregate mode shows no compose trigger.

**T3 — View PR routing + detailPrefill wiring** (Wave 2 — depends on T1's api fn and T2's view refactor)
- Owns: `src/mainview/lib/pr-url.ts` (new), `src/mainview/components/kanban/GitHubDialog.tsx`, `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/App.tsx`.
- Goal: `parsePullNumber(url): number | null` pure helper; `pullDetailPrefill?: { projectPath: string; number: number; prUrl: string } | null` prop on GitHubDialog with two-effect + pending/last-ref consumption (set projectPath + kind "pulls"; once landed, await `getGitHubPullDetail`; success → `setView(openDetail(item))`; failure → sonner toast + `api.openExternal(prUrl)` + close nothing); RunPanel "View PR" becomes a button invoking new prop `onViewPullRequest({projectPath: task.workdir, prUrl: task.prUrl})` (falls back to ExternalLink behavior when `parsePullNumber` returns null); App holds `githubPullDetailPrefill` state (set by callback + parse, cleared in dialog `onClose`), passes prop, and includes it in the `initialProjectPath` fallback chain.
- Acceptance: typecheck green; prefill consumed exactly once; close clears state in App like `githubPullPrefill`.

## 5. Work breakdown — test tasks

**U1 — mainview pure-logic tests** (covers T2, T3 frontend)
- Owns: `src/mainview/lib/github-dialog-view.test.ts`, `src/mainview/lib/pr-url.test.ts` (new).
- compose member: openCompose, resolveEscape pop, togglePanel from compose, backToList; pr-url: github/gitlab/bitbucket shapes, trailing slashes/query/fragment, garbage, non-PR urls → null.

**U2 — bun server/git-host tests** (covers T1)
- Owns: one new test file in `src/bun/` (e.g. `pull-detail.test.ts`), following `github-network.test.ts`/`github-test-util.ts` mock conventions and the `AGETOR_DATA_DIR` mkdtemp rule.
- Route param validation, GitHub happy path returns mapped item with sourcePath, provider/remote-missing error shape.

## 6. Execution waves

- Wave 1: T1 ∥ T2 (file-disjoint). Barrier: typecheck + commit.
- Wave 2: T3. Then typecheck + commit.
- Phase 5 review (opus) → Phase 6: U1 ∥ U2 (file-disjoint) → Phase 7 `bun test` (haiku) → Phase 8 fixes if needed.

## 7. Blast radius & risks

- `GitHubDialog.tsx` is ~8.9k lines with zero component-test coverage — regressions ride on typecheck + review + pure-logic tests. Mitigate: T2 keeps the flat field state as-is (only the open/closed mechanism moves into `view`).
- No exhaustive `view.kind` switch: T2 must audit every `showDetail`/`isPanelView`/`!showDetail` site (header 2845-2913, toolbar 2926, filter bar 3038, body 3207).
- Escape-while-composing changes from "close dialog" to "pop to list" — intentional, called out here.
- `pullPrefill` sequencing (declaration order vs the `[projectPath,kind]` reset effect) must be preserved when part 2 switches to `setView`.
- Aggregate mode must never enter compose (no valid target repo).
- Peer coordination: active peer silver-ridge-6ad2 works `fix/fix-bg-agent-api-error-catch` (background-agent streams) — no file overlap expected except possibly `RunPanel.tsx`; their branch is separate, merge-time only.

## 8. Open questions / assumptions (autonomous mode)

- **A1**: Issue composer is folded into the same compose page (uniformity; fixes the `[open]`-reset leak). User only asked about New PR.
- **A2**: Successful create navigates to the new item's detail subpage instead of list + banner.
- **A3**: "View PR" is modal-first; browser open remains reachable from the detail page and as the automatic fallback when the item can't be fetched/parsed.
- **A4**: GitLab/Bitbucket single-PR fetch is best-effort; errors degrade to external open.
- **A5**: Kanban cards / other surfaces stay untouched (RunPanel is the only PR entry point today).
- **A6**: Draft fields persist across a back-pop within one open (matching current cancel semantics); wiped on close/project change as today.
