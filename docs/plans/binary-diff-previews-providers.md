# Plan — Binary previews follow-up: GitLab/Bitbucket blobs + root-relative untracked paths

| Field | Value |
| --- | --- |
| Date | 2026-08-12 |
| Source | /implement follow-up on docs/plans/binary-diff-previews.md open items 1 & 4 |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/load-binary-files-on-diff-modal-and-git |
| Base SHA | 04969c4 (end of first run) |
| Mode | Autonomous — gates self-resolved; assumptions in §8 |

## 1. Objective & success criteria
(a) GitLab and Bitbucket PR diffs render binary previews like GitHub's (server `pullBlob` branches
implemented; UI gate widened); (b) `getTaskDiff`'s untracked-file entries become repo-root-relative
so one `TaskDiff` no longer mixes path namespaces. Typecheck + unit + e2e stay green.

## 2. Context (investigated, verified)
- Dispatch seam: git-host.ts:428-436 `pullBlob` (isSafeRelPath already applied; github branch live;
  else 501). `PullBlobResult.ok` carries `ref` for the route's content-addressed ETag.
- Providers receive `ProviderRepoInfo { provider, host, remoteHost, owner, name }` (types.ts:2646).
- GitLab: auth `PRIVATE-TOKEN` via fetchGitLab (gitlab.ts:85-109); project id = encodeURIComponent
  ("owner/name") (encodeProjectId :111). MR detail `diff_refs.base_sha` IS the merge base (GitLab
  docs, confirmed); `/versions` endpoint (used by createGitLabPullLineComment :746) is the
  synchronous fallback since diff_refs populates async. Raw file: GET /projects/:id/repository/
  files/:urlencoded-path/raw?ref=<sha> returns raw bytes, PRIVATE-TOKEN auth. Fork MRs: new side
  lives in `source_project_id` (numeric id valid as :id).
- Bitbucket: auth Basic/Bearer via fetchBitbucket (bitbucket.ts:190-215); raw file: GET /2.0/
  repositories/{ws}/{slug}/src/{commit}/{path} returns raw bytes (docs confirmed). PR diff is
  merge-base-anchored (three-dot; Atlassian blog confirmed). CORRECTION (Phase-5 review): an
  official merge-base endpoint DOES exist — GET /2.0/repositories/{ws}/{slug}/merge-base/
  {sha1..sha2} returns the best common ancestor commit (api-group-commits docs). The original
  "no endpoint" fact was an investigation miss; §3.2's redirect-sniff was rebuilt on the
  documented endpoint in the review-fix wave.
  PR detail carries source.commit.hash / destination.commit.hash (source read at :953, :1093).
  Cross-repo: source/destination repository full_names read in normalizeBitbucketMergeability.
- github.ts getGitHubPullBlob (:1710-1940) is the structural template (pullDetailCache 60s TTL,
  mergeBaseCache, contentTypeForPreviewPath, 20MB double-guard, ok+ref shape).
- UI gate: GitHubDialog.tsx:6598 blobCtx useMemo `provider === "github"` — documented v1 restriction.
- worktree.ts:919-934 untracked loop emits CWD-relative paths (git ls-files run in cwd);
  getTaskDiffBlob :1024-1056 root-join-then-cwd-fallback exists precisely to absorb that.
- Existing tests asserting the 501s: git-host.test.ts (T6's dispatch tests) — will need updating in
  the same change that removes the 501s.

## 3. Approach & key decisions
1. **GitLab old side = diff_refs.base_sha** (merge base, no compare round-trip); fallback to
   `/versions` latest (`base_commit_sha`/`head_commit_sha`) when diff_refs absent/incomplete.
   New side = head_sha, fetched from source project when `source_project_id !== target_project_id`.
2. **Bitbucket old side**: primary — fetch `/pullrequests/{n}/diff` with `redirect: "manual"` and
   parse the resolved `{source}..{dest}`-style spec from the Location header if it yields a usable
   merge-base sha; fallback — `destination.commit.hash` **approximation**, clearly doc-commented
   (same "approximated" convention the module already uses). No commits-pagination walk (unbounded,
   and wrong under back-merges anyway). — decision
3. **Both new provider functions mirror github.ts's shape**: per-PR detail cache (60s TTL, 200-cap
   wholesale clear), MAX_BLOB_PREVIEW_BYTES double-guard, contentTypeForPreviewPath, local
   result type structurally matching PullBlobResult (avoids git-host import-direction issue),
   `ref` = the sha actually fetched.
4. **Untracked-path normalization at the source**: getTaskDiff prefixes each untracked `rel` with
   `path.relative(root, cwd)` (posix-joined) so DiffFile.path is always root-relative; the
   `--no-index` git call keeps using the cwd-relative path. getTaskDiffBlob's cwd-fallback stays
   (harmless, defensive) with an updated comment. UI display changes for subdir-workdir tasks
   (paths now shown root-relative) — accepted as more correct/consistent.
5. **UI gate widens** to any concrete provider (`github | gitlab | bitbucket`) on pull items;
   `mixed`/null keep the placeholder.

## 4. Work breakdown — implementation
Contracts (wave-1 tasks compile together):
```ts
// gitlab.ts
export async function getGitLabPullBlob(repo: ProviderRepoInfo, number: number, relPath: string, side: "old" | "new"): Promise<GitLabBlobResult>; // structurally = PullBlobResult
// bitbucket.ts
export async function getBitbucketPullBlob(repo: ProviderRepoInfo, number: number, relPath: string, side: "old" | "new"): Promise<BitbucketBlobResult>; // structurally = PullBlobResult
```

| ID | Goal | Owns | Deps |
| --- | --- | --- | --- |
| A | getGitLabPullBlob (per §3.1/§3.3) + pullBlob dispatch for BOTH new providers + update git-host.test.ts's two 501 dispatch tests to the new behavior | src/bun/gitlab.ts, src/bun/git-host.ts, src/bun/git-host.test.ts | — |
| B | getBitbucketPullBlob (per §3.2/§3.3) | src/bun/bitbucket.ts | — |
| C | Root-relative untracked paths in getTaskDiff (§3.4) + comment update in getTaskDiffBlob + adjust/extend worktree.test.ts (subdir-workdir untracked assertions) | src/bun/worktree.ts, src/bun/worktree.test.ts | — |
| D | Widen blobCtx gate (§3.5) | src/mainview/components/kanban/GitHubDialog.tsx | wave 1 |

## 5. Work breakdown — tests
| ID | Goal | Owns | Covers |
| --- | --- | --- | --- |
| E | Network-mocked unit tests: gitlab-network.test.ts (blob happy path old/new, fork MR source-project routing, diff_refs→versions fallback, 404/413), bitbucket-network.test.ts (blob happy path, redirect-parse merge base, destination-tip fallback, 404/413) — following each file's existing mock harness | src/bun/gitlab-network.test.ts, src/bun/bitbucket-network.test.ts | A, B |

E2e: NOT applicable for provider blobs (needs live GitLab/Bitbucket PRs); existing
e2e/binary-diff.spec.ts already covers the task-diff surface C touches — recorded decision.

## 6. Execution waves
Wave 1: A, B, C (disjoint). Wave 2: D. Review (opus) → test task E → full run (typecheck, bun test, playwright).

## 7. Blast radius & risks
- git-host.test.ts 501 assertions must change with the dispatch (A owns both, same change).
- Untracked-path normalization changes DiffFile.path values for subdir-workdir tasks: consumers are
  DiffDialog display, compose-from-diff labels (both fine with root-relative), getTaskDiffBlob
  (root-join-first already), e2e spec (uses repo-root workdirs — unaffected).
- Bitbucket merge-base approximation can show a drifted "Before" when the destination moved AND
  touched the same file and the redirect-parse failed — bounded, documented.
- GitLab raw-file rate limit (5/min for >10MB blobs) — acceptable for modal-scoped fetches.

## 8. Open questions / assumptions (autonomous mode)
1. ~~Bitbucket redirect-Location parse~~ SUPERSEDED by review: merge base resolved via the
   official /merge-base/{revspec} endpoint; destination-tip fallback retained for resolver
   failure (incl. cross-repo edge cases); cache validated by retry-on-404. — decision (revised)
1b. `/github/pull-blob` route name now serves all three providers — kept deliberately (renaming
   would churn the URL builder + tests for a cosmetic win); recorded here so it reads as a
   decision, not a bug. The GitHubDialog "mixed"-provider exclusion is conservative, not
   required (itemPath is per-item) — left as-is. — decision
2. Bitbucket commit-hash length unverified in docs; we pass through whatever the API returns
   (src/{commit}/ accepts either). — assumption
3. GitLab fork-MR new-side routing via numeric source_project_id. — assumption (doc-supported)
4. No e2e for provider blobs (no live PR fixtures). — decision
5. Subdir-workdir tasks now display root-relative untracked paths (behavior change, more
   consistent). — decision
