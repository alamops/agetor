# Plan — "Resolve Conflicts" button in Task Details (multi-provider PR mergeability)

| Field | Value |
| --- | --- |
| Date | 2026-07-31 |
| Source | /implement conversation (owner request + AskUserQuestion answers) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/git-integration-resolving-conflicts |
| Base SHA | 5953e190c262b598ad36a10c449b984517bd19a1 (clean tree) |

## 1. Objective & success criteria

When a task has a PR (`task.prUrl`, the "View PR" link from #133) and that PR currently has merge conflicts, the Task Details modal (RunPanel) shows a **Resolve Conflicts** button. Clicking it sends a canned message to the task's agent (via the existing `sendRunInput` plumbing) instructing it to `git fetch origin`, merge `origin/<baseRef>` into the current branch, resolve every conflict treating **both sides' intent as important**, verify, and commit locally — **no push** (owner reviews + pushes via Commit & Push).

Owner decisions (Phase 2):
- **Push policy:** no push — reuse the #125 review-first contract.
- **Freshness:** fetch mergeability on panel open (+ the one-shot self-heal retry while the provider is still computing), a manual refresh affordance, and a re-fetch after the resolve/commit-push turn completes.
- **Scope:** must work for **GitHub, GitLab, and Bitbucket** — mergeability fetching gains GitLab/Bitbucket adapters + facade dispatch.

Success = button appears only for a conflicted, open, same-repo PR; clicking delivers the prompt to the live agent; `bun run typecheck` and full `bun test` green.

## 2. Context & constraints (Phase 1 findings)

- RunPanel **is** the Task Details modal (`App.tsx:844-858`). The durable "View PR" link renders in its header (`RunPanel.tsx:2006-2019`), deliberately outside the composer gate. PR-state-driven actions belong in the header; git-working-tree chips (Commit & push / Open PR) live in the composer row.
- Canned-send precedent: `sendCommitPush()` (`RunPanel.tsx:1899`) sends a prompt through `api.sendRunInput(resumableRunId, …)` with guards `!resumableRunId || modalPending || sending || backlogBusy`. `api.sendRunInput` is `retry: false` (duplicate paste hazard).
- `GET /github/pull-mergeability?path&number` (`server.ts:1458-1473`) already returns the full `GitHubPullMergeability` (`shared/types.ts:1636`): `mergeable`, `mergeableState`, `merged`, `headRef`, `baseRef`, `crossRepo`, `repo`, `pullNumber`… It calls `getGitHubPullMergeability` (`github.ts:2336`) **directly — GitHub-only**, with an in-request 3×1.2s retry while GitHub computes mergeability. GitHubDialog's fetch effect is *not* provider-gated, so it already fires (and errors) for GitLab/Bitbucket — facade dispatch fixes that for free.
- Facade pattern: `git-host.ts` (`pullDiff` at 374-379, `pullChecks` at 457-462): `providerRepoForDir(dir)` → 3-way dispatch → `{ok:true}&Shape | {ok:false,error}`. GitLab/Bitbucket adapters normalize onto the shared `GitHub*` types by convention (adapter doc comments, `gitlab.ts:27-47`, `bitbucket.ts:23-64`).
- GitLab MR detail: `GET /projects/:id/merge_requests/:iid` (pattern in `getGitLabPullChecks`, `gitlab.ts:848-875`). Response carries `detailed_merge_status`, `merge_status`, `has_conflicts`, `source_branch`, `target_branch`, `state`, `draft`, `source_project_id`/`target_project_id`, `sha`.
- Bitbucket PR detail: `GET /2.0/repositories/{ws}/{slug}/pullrequests/{id}` (pattern in `getBitbucketPullChecks`, `bitbucket.ts:850-874`) has **no conflict field**; the conflict signal is `/pullrequests/{id}/diffstat` entries with `status: "merge conflict"` (paginated; no diffstat plumbing exists yet).
- `task.prUrl` is an opaque html URL; per-provider shapes: GitHub `…/pull/N`, GitLab `…/-/merge_requests/N` (`gitlab-test-util.ts:48`), Bitbucket `…/pull-requests/N` (`bitbucket-network.test.ts:209`). No parser exists anywhere yet.
- Prompt template `buildResolveConflictsPrompt` (`src/mainview/lib/resolve-conflicts-prompt.ts`) already says exactly what the owner asked (fetch origin, merge `origin/<base>`, both intents survive, verify, commit, do not push) but requires `title`, which the mergeability response doesn't carry.
- `mergeabilityView` (`src/mainview/lib/mergeability.ts`) maps `mergeableState` (`dirty` → "Conflicts must be resolved…", tone bad). Its "GitHub is still checking mergeability…" copy is provider-specific and its tests pin the strings.
- Test conventions: mainview logic lives in pure `lib/*.ts` modules with `bun:test` files (no component tests). Bun-side network functions are tested with `mockGitHubFetch` route tables (`github-test-util.ts`, reused by `gitlab-test-util.ts` / bitbucket tests) + payload factories (`gitlabMergeRequest`, …).

## 3. Approach & key decisions

1. **No new server endpoint.** The webview parses `{provider, number}` out of `task.prUrl` (new pure lib) and calls the existing `/github/pull-mergeability` route with `path: task.workdir`. Rejected alternative: a task-keyed `GET /tasks/:id/pr-status` — more server surface for no additional capability (`pull-create` already guarantees `task.workdir` matches the PR's repo).
2. **Facade dispatch, keep names.** New `pullMergeability({dir, number})` in `git-host.ts`; route swaps to it. Route path and `api.getGitHubPullMergeability` keep their GitHub-branded names, matching the existing precedent (`/github/comments` etc. already serve all providers).
3. **GitLab mapping** (new `getGitLabPullMergeability` + `normalizeGitLabMergeability`): prefer `detailed_merge_status` — `conflict`→`dirty`, `mergeable`→`clean`, `need_rebase`→`behind`, `draft_status`→`draft`, `ci_still_running`→`unstable`, `blocked_status`/`discussions_not_resolved`/`not_approved`→`blocked`, `unchecked`/`checking`→`unknown` with `mergeable: null`; fall back to `has_conflicts`/`merge_status` when `detailed_merge_status` is absent. Reuse the same in-request retry loop (3×1.2s) while the state is `unchecked`/`checking`. `crossRepo` = `source_project_id !== target_project_id`; `headRef`/`baseRef` from `source_branch`/`target_branch`; `merged` = `state === "merged"`.
4. **Bitbucket mapping** (new `getBitbucketPullMergeability`): fetch PR detail (state, branches, cross-repo via `source.repository.full_name` vs `destination.repository.full_name`); if `state === "OPEN"`, fetch `/diffstat` pages (pagelen 100, follow `next`, cap ~10 pages): any entry with `status === "merge conflict"` → `dirty`/`mergeable:false`; none within cap → `clean`/`mergeable:true`; cap exceeded without a conflict hit, or diffstat error → `unknown`/`mergeable:null` (never false-clean). `MERGED`→`merged:true`. No retry loop (diffstat is synchronous).
5. **Prompt reuse with optional title.** `ResolveConflictsPromptInput.title` becomes `string | null`; the first line drops the `— "title"` clause when absent. Existing #125 callers unaffected; existing pinned tests updated in the same task.
6. **Provider-neutral copy** in `mergeabilityView`: "GitHub is still checking…" → "The provider is still checking mergeability…" (tests updated together). No other UI-logic change — GitLab/Bitbucket states arrive pre-mapped to the GitHub vocabulary.
7. **RunPanel wiring:** new state `prStatus` fetched by an effect gated on a successful `parsePrUrl(task.prUrl)`; one-shot per (task.id, prUrl) with a single 2.5s self-heal re-fetch when `mergeable === null && !merged` (GitHubDialog pattern); manual refresh icon; re-fetch when a turn ends (`task.runId` transitions non-null → null while the panel is open and prUrl is set — covers "after sending" once the resolve/commit-push turn actually finishes, the only moment remote state can have changed). Button gating via pure `canOfferResolveConflicts(...)`: parse ok && `mergeableState === "dirty"` && `!merged` && `!crossRepo`. Rendered in the **header** next to View PR; disabled (with title) when `!canSend || modalPending || sending || backlogBusy`; on click builds the prompt from the mergeability payload (`repo`, `pullNumber`, `headRef`, `baseRef`, title:null) and sends via `api.sendRunInput`, surfacing `res.reason` through the existing `sendHint` on failure, plus a transient "sent" confirmation and an immediate optimistic disable.

## 4. Work breakdown — implementation tasks

**Wave 1** (disjoint, parallel):
- **T1 — GitLab mergeability fetcher.** Owns `src/bun/gitlab.ts` only. Add `getGitLabPullMergeability(repo, number)` per §3.3, exporting the same `({ok:true} & GitHubPullMergeability) | {ok:false,error}` union; extract/normalize in a pure `normalizeGitLabMergeability` (exported for tests). Acceptance: typechecks; mirrors `getGitLabPullChecks` fetch/auth/error idiom.
- **T2 — Bitbucket mergeability fetcher.** Owns `src/bun/bitbucket.ts` only. Add `getBitbucketPullMergeability(repo, number)` + diffstat scan per §3.4 (pure `normalizeBitbucketMergeability` exported for tests). Acceptance: typechecks; mirrors `getBitbucketPullChecks` idiom; never returns false-clean on partial diffstat.
- **T3 — Mainview pure libs.** Owns `src/mainview/lib/pr-url.ts` (new), `src/mainview/lib/resolve-conflicts-prompt.ts` + `resolve-conflicts-prompt.test.ts`, `src/mainview/lib/mergeability.ts` + `mergeability.test.ts`. Add `parsePrUrl(url): {provider: GitProvider; number: number} | null` and `canOfferResolveConflicts(parsed, mergeability): boolean` in `pr-url.ts`; make prompt `title` optional (update pinned tests); provider-neutral "still checking" copy (update pinned tests). Acceptance: `bun test src/mainview/lib/resolve-conflicts-prompt.test.ts src/mainview/lib/mergeability.test.ts` green.

**Wave 2** (disjoint, parallel; after wave 1):
- **T4 — Facade + route.** Owns `src/bun/git-host.ts`, `src/bun/server.ts`. Add `pullMergeability` facade (model on `pullChecks`); swap the route's import/call to it (route body otherwise unchanged). Acceptance: typechecks; GitHub path still passes `{dir, number}` through to `getGitHubPullMergeability`.
- **T5 — RunPanel wiring.** Owns `src/mainview/components/kanban/RunPanel.tsx` only. Implement §3.7 (state, fetch effect with the documented dep discipline — key on `[task.id, task.prUrl]`, not `[task]`, because App.tsx's 2s /tasks poll rebuilds the task object; header button; refresh; turn-end re-fetch; send with guards + sendHint). Acceptance: typechecks; no change to existing send/backlog behavior.

## 5. Work breakdown — test tasks (Phase 6)

- **TT1** owns `src/bun/gitlab-network.test.ts`: `getGitLabPullMergeability` — conflict (`detailed_merge_status:"conflict"` → dirty), mergeable → clean, `unchecked` → retries then unknown, fallback path via `has_conflicts` only, cross-repo, merged MR. Use `mockGitLabFetch` + `gitlabMergeRequest` overrides.
- **TT2** owns `src/bun/bitbucket-network.test.ts`: PR detail + diffstat conflict → dirty; clean diffstat → clean; multi-page `next` follow; page-cap → unknown; diffstat error → unknown; MERGED state; cross-repo fork.
- **TT3** owns `src/mainview/lib/pr-url.test.ts` (new): all three URL shapes (incl. trailing segments/query/fragment, self-hosted GitLab hosts, non-PR URLs → null) and `canOfferResolveConflicts` gating (dirty/merged/crossRepo/unknown).
- **TT4** owns `src/bun/git-host-mergeability.test.ts` (new): facade dispatch per provider (mock fetch + `makeGitHubRepo`-style temp repos per each test-util), incl. the previously-untested GitHub path (backfills network coverage for `getGitHubPullMergeability`).

## 6. Execution waves

Phase 4: wave 1 = T1‖T2‖T3 → checkpoint (typecheck + commit) → wave 2 = T4‖T5 → checkpoint. Phase 5 review (opus) on `git diff 5953e19...HEAD`. Phase 6: TT1‖TT2‖TT3‖TT4. Phase 7: full `bun test` + `bun run typecheck` (haiku). Phase 8 as needed.

## 7. Blast radius & risks

- `/github/pull-mergeability` responses for GitLab/Bitbucket projects change from `{error}` to real payloads — GitHubDialog's badge starts working there (improvement, not a break). Its "Resolve with Agetor" button stays `provider === "github"`-gated (untouched).
- `resolve-conflicts-prompt.ts` is consumed by `ResolveConflictsDialog` (#125) — title stays supported; only the optional-absent branch is new.
- `mergeability.test.ts` / `resolve-conflicts-prompt.test.ts` pin exact strings — updated in T3, same commit.
- Bitbucket diffstat adds up to ~11 API calls for a huge conflicted-check; capped, and only on panel-open/refresh (no polling).
- `sendRunInput` auto-unarchives a task server-side; the button only renders on non-archived panels' header — acceptable.
- Rollback: revert the branch; no migrations, no schema changes.

## 8. Open questions / assumptions

- Assumes `task.branch` == PR headRef for task-originated PRs (holds by construction: PR is opened from the task's pushed branch; `pull-create` stamps `prUrl` only when `task.workdir` matches). The prompt's "you're already on the head branch" framing therefore stands.
- Bitbucket "clean" is inferred from absence of conflict-status diffstat entries — Bitbucket offers nothing stronger.
- GitLab self-hosted variance in `detailed_merge_status` handled by the `merge_status`/`has_conflicts` fallback.
