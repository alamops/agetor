# Plan — PR modal: refresh merge status on open + merged-state purple banner

| Field | Value |
| --- | --- |
| Date | 2026-08-21 |
| Source | /implement conversation + screenshot (merged PR still showing full Review/Merge/Close grid and stale mergeability banner) |
| Config | AGENTS_CONFIG.yml (balanced) |
| Flags | none |
| Gates | grilled + approved by owner |
| Branch | feature/pr-modal-merge-status-and-message |
| Base SHA | 1e5f65491e9f059a29da52bedee0604df98e5139 |

## 1. Objective & success criteria

1. Every time the PR detail view opens inside the GitHub dialog (dialog open via "View PR", row click from the list, re-navigation within the dialog, dialog reopen onto a surviving detail view), the PR's state **and** mergeability are re-fetched — no stale "Mergeability hasn't been verified" banner, and a PR merged outside agetor is detected.
2. When a PR is merged (`mergedAt` set), the Review/Merge/Close 3-column action grid **and** the mergeability banner are replaced by a single positive purple card: GitMerge icon + "Pull request successfully merged" + merged date, using the existing `--merged` token (GitHub's merge purple).
3. Merging from inside agetor shows the purple card immediately (local `mergedAt` stamp on merge success), corrected by the next real fetch.

Success: `bun run typecheck` green, `bun test` green, review clean, and the merged PR from the screenshot renders the purple card instead of the disabled grid.

## 2. Context & constraints (Phase 1 findings, verified against source)

- **Component:** `src/mainview/components/kanban/GitHubDialog.tsx` (monolith). Detail view state is the `GitHubDialogView` union (`src/mainview/lib/github-dialog-view.ts:29-38`, `openDetail(item)`).
- **`expandedItem`** (`GitHubDialog.tsx:1252-1259`) re-resolves the navigated item against `result.items` by `itemKey` (kind+number+sourcePath), falling back to the navigation snapshot. Per-item fetch path: `expandedItemPath = expandedItem?.sourcePath ?? projectPath` (`:1265`).
- **Mergeability staleness (root cause 1):** fetch effect `GitHubDialog.tsx:2250-2284` only fires when the cached item's `state === "open"` (`:2253`) and is cache-guarded at `:2256` (`mergeability[key] || mergeabilityLoading[key] || mergeabilityErrors[key]`) — opening the detail view never invalidates it. Manual refresh handler clears the caches + retry budget (`:3651-3656`).
- **Item staleness (root cause 2):** nothing re-fetches the item on detail entry, and detail views deliberately survive dialog close/reopen (`:1217-1220`) — a PR merged elsewhere keeps its cached `state: "open"`.
- **Fresh-detail machinery exists:** `api.getGitHubPullDetail(path, number)` → `GET /github/pull-detail` (`src/bun/server.ts:982-997` → `git-host.ts:460-469` → `github.ts:1948-1963`, plain REST `GET /pulls/{number}`) returns a full fresh `GitHubListItem` incl. `state`/`mergedAt`. Currently only used by the "View PR" prefill effect (`GitHubDialog.tsx:1180-1206`), which has the navigation-clobber (`viewRef`) + wrong-repo guards.
- **Cache patch helper exists:** `upsertListItem(next, false, true)` (keepIfPresent) — used by `markPullClosed` (`:2562-2565`) so a closed/merged row stays in `result.items` even when the filter no longer matches.
- **Merge success gap:** `runPullMerge` (`:2627-2644`) calls `markPullClosed(item)` at `:2637`, which stamps `state/closedAt` but **not** `mergedAt` (merge API response is just `{merged, sha, message}` — `github.ts:2392-2397`).
- **`PullActions`** (`GitHubDialog.tsx:7440-7773`): header row `7536-7572` (Convert-to-draft gated `state==="open"`, purple "Merged" tag gated `mergedAt` at `7548-7553`, ephemeral `actionMessages` line `7560-7571`); mergeability banner `7574-7625` (gated `state==="open"`); **Review/Merge/Close grid `7628-7754` renders unconditionally** — buttons merely `disabled` when not open (`:7503`).
- **Purple token exists:** `--merged` in `:root` and `.dark` (`src/mainview/index.css:46-49`, `:99-100`) mapped in `tailwind.config.js:60-63`; usable as `text-merged`, `bg-merged/10`, `border-merged/30`. Repo rule: semantic tokens only.
- **Test idiom:** dialog is not component-tested; logic is extracted into pure lib modules with `bun:test` unit tests (`mergeability.test.ts`, `github-dialog-view.test.ts`). Test command `bun test`; typecheck `bun run typecheck`.
- **Peer knowledge honored:** GitHubDialog prefill flow guards (wrong-repo, navigation-clobber via `viewRef`) must be mirrored by any new async fetch that lands in view state (fleet entry `f45b5cb6`).

## 3. Approach & key decisions

- **Refresh = fresh pull detail + mergeability invalidation, on every detail-view entry** (owner-confirmed). A new effect watches `view` transitions into `{kind:"detail"}` for a `pulls` item and fires once per entry:
  1. Clear `mergeability[key]`, `mergeabilityErrors[key]`, reset `mergeabilityRetries.current[key]` (mirrors the manual refresh handler) — the existing effect at `2250-2284` then refetches by itself for open PRs, and correctly skips merged/closed ones.
  2. `api.getGitHubPullDetail(itemPath, number)`; on success `upsertListItem(fresh, false, true)` **and** patch the view snapshot (`setView` to `openDetail(fresh)` only if still on the same item key via `viewRef`) so the fallback path (item absent from `result.items`) is also fresh.
  3. Failure is **silent** (keep showing cached data; the mergeability banner has its own error surface for open PRs; a toast on every open would be noisy offline). No wrong-repo guard needed here — the fetch is keyed off the already-trusted cached item, not a URL.
- **"Once per entry" bookkeeping:** a `lastDetailRefreshKeyRef` cleared whenever `view.kind !== "detail"` or `open === false`, so detail(A) → list → detail(A) refreshes again, and dialog reopen onto a surviving detail view refreshes. The "View PR" prefill effect (`1180-1206`) already fetches fresh detail; it may double-fetch once — acceptable, but the implementer may set the ref from the prefill path to dedupe (optional, low-risk only).
- **Merged banner replaces both the mergeability banner and the action grid** when `Boolean(item.mergedAt)`. Header row stays (Merged tag, ephemeral messages). Card: `GitMerge` icon (lucide, already imported for the Merged tag area), "Pull request successfully merged", "Merged on <formatted date>", `rounded-md border border-merged/30 bg-merged/10 text-merged` — reuse the file's existing date formatting helper. Closed-but-unmerged PRs keep today's behavior (out of scope).
- **Immediate post-merge purple** (owner-confirmed): extract a pure helper `mergedPullReplacement(item, mergedAtIso)` into a new lib module and use it in `runPullMerge`'s success path in place of the bare `markPullClosed(item)` (stamps `state:"closed"`, `closedAt`, `mergedAt`). Timestamps are client-approximate; the on-open refresh corrects them.
- Alternatives considered: mergeability-only refresh (rejected — cannot detect externally-merged PRs, fails objective 2); refreshing only on dialog open (rejected — user intuition of "opened" includes in-dialog navigation); new purple token (unnecessary — `--merged` exists).

## 4. Work breakdown — implementation tasks

- **T1 — lib helper + dialog changes** (single task; the helper and its consumer are too entangled to split without a fake wave barrier)
  - Files owned: `src/mainview/components/kanban/GitHubDialog.tsx`, `src/mainview/lib/pull-merged.ts` (new)
  - Goal: (a) new `pull-merged.ts` exporting `isMergedPull(item)` and `mergedPullReplacement(item, mergedAtIso?)`; (b) refresh-on-detail-entry effect per §3; (c) `runPullMerge` success path uses `mergedPullReplacement`; (d) `PullActions` renders the purple merged card in place of mergeability banner + grid when `isMergedPull(item)`.
  - Acceptance: typecheck green; no changes outside owned files; guards per §3 present.

## 5. Work breakdown — test tasks

- **T2 — unit tests** (after T1)
  - Files owned: `src/mainview/lib/pull-merged.test.ts` (new)
  - Goal: cover `isMergedPull` (mergedAt set / null / undefined-ish) and `mergedPullReplacement` (state flip, closedAt/mergedAt stamped, other fields preserved, explicit timestamp honored). Follow `mergeability.test.ts` fixture idiom.
- ~~**e2e: not applicable**~~ **Superseded by §10** — the repo *does* have a Playwright harness (`e2e/`, per-worker headless backends); the original investigation missed it. `e2e/pr-merged-state.spec.ts` now covers the feature end-to-end against a stubbed GitHub API (see §10.3 T7).

## 6. Execution waves

- Wave 1: T1 (one implementation agent, sonnet)
- Review (opus) on the diff vs base SHA
- Wave 2: T2 (one test agent, sonnet)
- Test run (haiku): `bun run typecheck` + `bun test`
- Fixes as needed (sonnet), re-run to green

## 7. Blast radius & risks

- `GitHubDialog.tsx` detail flow: the new effect must not clobber navigation (guards via `viewRef` + item-key check) and must not loop (ref bookkeeping; effect must not depend on state it sets, or must be entry-keyed).
- `upsertListItem(fresh, false, true)` with a merged item interacts with the open-filter list — the keepIfPresent path is exactly the one `markPullClosed` already exercises.
- Extra API call per detail entry (one `GET /pulls/{number}`) — negligible, matches the prefill flow's cost.
- Mergeability effect remains gated on `state === "open"` — after a refresh flips state to merged, the effect correctly stops polling; no wasted server-side poll.
- Rollback: revert the branch; no schema/API changes, UI-only.

## 8. Open questions / assumptions

- Silent failure on the detail-refresh fetch (no toast) — chosen for calm UX; flip to a toast if the owner prefers loud failures.
- Merged-date formatting reuses the file's existing date helper; exact wording "Pull request successfully merged" + "Merged on <date>" per approved preview.

---

## 10. Hardening pass (2026-08-21) — "make sure everything is right and is the best we can do"

| Field | Value |
| --- | --- |
| Source | owner follow-up after delivery; 3 fresh investigators (opus correctness re-review, opus UX/design review, sonnet runtime-verification feasibility) |
| Gates | grilled (card design + e2e decision) + owner approval of this section |
| Base SHA (this pass) | 46a70fa |
| Correction to §5 | the repo **does** have a Playwright e2e harness (`e2e/` + `playwright.config.ts`, per-worker headless backends via `e2e/fixtures.ts`). "e2e not applicable" was wrong; e2e **applies** and is added here. Run Playwright as `bun node_modules/@playwright/test/cli.js test …` (the `bunx` shim runs under Node and breaks on `bun:sqlite`). |

### 10.1 Owner decisions (grill)
- **Card design:** keep the positive headline "Pull request successfully merged" (GitHub's own persistent phrasing) but move to the app's status-card idiom: purple carried by icon + `border-merged/40` + `bg-merged/10`; headline `text-sm font-medium text-foreground`; secondary `text-xs text-muted-foreground` using `fmtRelativeDate` ("Merged today" / "Merged 3d ago" / falls back to full date); `px-3 py-6 min-h-[7.5rem]`; panel label reads "Merge status" when merged. Fixes the dark-mode AA failure of `text-merged/80` (~4.1:1).
- **E2E:** yes — add a real Playwright spec backed by a stub GitHub API, via a small product seam (`GITHUB_API_BASE` constant + `AGETOR_GITHUB_API_BASE` env override in `src/bun/github.ts`, mirroring Bitbucket's `BITBUCKET_API_BASE` idiom).

### 10.2 Fix list (both reviewers; all accepted unless noted)
Correctness (GitHubDialog.tsx):
- C1 **Duplicate mergeability fetch on first entry** — the refresh effect is declared after the mergeability fetch effect, so entry fires GET #1, bumps seq, re-fires GET #2 (3–7 identical `GET /pulls/{n}` incl. server polling). Fix: declare the refresh effect **above** the mergeability effect.
- C2 **In-app merge of a non-listed PR never shows the card** — `markPullClosed` only patches `result.items`; when the PR isn't in the loaded list `upsertListItem` drops it and `expandedItem` falls back to the frozen snapshot. Fix: `markPullClosed` also patches the view snapshot (`setView(cur => detail && sameItem(cur.item,next) ? openDetail(next) : cur)`) — single choke point for merge/close/reopen.
- C3 **No refresh affordance for closed/merged PRs; silent failure dead-end** — extract `refreshPullDetail(item)` (entry-refresh body) + `invalidateMergeability(key)` helpers; header button becomes a full "Refresh" (item + mergeability), rendered for every PR state, not just open; effect, manual button, and prefill share the helpers.
- C4 **Latent item-key shift** — pin identity: `fresh = { ...detail.item, sourcePath: item.sourcePath }`, bail if `itemKey(fresh) !== key`; guard `itemPath === AGGREGATE_PROJECT_PATH`; fix the stale "sourcePath is null in single-repo mode" doc comment (~:230).
- C5 **Structural update-only** — add an `updateOnly` option to `upsertListItem` evaluated inside the `setResult` updater (fresh state) so the effect no longer reads a stale `result` closure; document the deliberately-narrow deps with the file's `eslint-disable-next-line react-hooks/exhaustive-deps` + why idiom.
- C6 **itemMutationSeq invariant** — hoist the bump into a `mutateItems()` wrapper used by `upsertListItem` AND the direct `setResult` writers (`editLabel`, `removeLabel`, `editMilestone`, `removeMilestone`, `runTransferIssue`); fix the "every local item write goes through here" comment.
- C7 **"View PR" double fetch** — prefill part 2 already has the fresh item: set `lastDetailRefreshKeyRef` + call `invalidateMergeability(key)` before `setView(openDetail(result.item))` (dedupe without losing the mergeability refresh).
- C8 Unify `!detail.ok` and thrown-error paths (both reset the ref for retry). C9 `mergedPullReplacement` gets the `pulls` guard; test for `mergedAt: ""`; drop the unnecessary label cast in the test. C10 one-line comment on the sibling refresh handlers (`onRefreshDiff/Checks/CommitStatus`) noting they're shielded by `disabled={…Loading}`. C11 readability: extract the action grid into a sibling `PullActionGrid` component (or re-indent) so the merged branch reads `{merged ? <MergedPullCard/> : <PullActionGrid/>}`.
UX (PullActions):
- U1 card per §10.1; `role="status"`, `aria-hidden` icon; `tabIndex={-1}` + focus the card when it mounts and `document.activeElement === document.body` (focus was dropped by the grid unmounting after an in-app merge).
- U2 suppress the green `actionMessages` success line when merged (keep the header "Merged" tag + card; error line stays unconditional).
- U3 "Mergeability unavailable." one-frame flicker: render "Checking mergeability…" whenever `!mergeability && !mergeabilityError`.
- U4 entry-refresh affordance: `detailRefreshing` state (set around the entry fetch, per key) → `Loader2` spinner in the panel header row + Merge disabled with title "Checking latest state…" while refreshing (only Merge; Approve/Comment/Close stay live). Grid is **not** held (both reviewers agree).
- U5 queued-review hint copy branches on `merged` (no longer points at Approve/Comment/Request; says the PR is merged so they can no longer be posted; discard under "Pending review" below).
- U6 `runPullMerge` success clears `reviewDrafts[key]` (mirrors `runClosePull` clearing `closeDrafts`).
Declined: dropping the header "Merged" tag (kept — compact scan marker, matches list rows); "merged by / into base" (no `mergedBy`/`baseRef` on `GitHubListItem`; server change — different ticket); closed-unmerged state polish (different ticket).

### 10.3 Work breakdown
- **T5 — dialog polish + correctness** (wave 1). Files: `src/mainview/components/kanban/GitHubDialog.tsx`, `src/mainview/lib/pull-merged.ts`, `src/mainview/lib/pull-merged.test.ts`. Everything in §10.2. Acceptance: typecheck green, `bun test src/mainview/lib` green.
- **T6 — GitHub API seam + e2e plumbing** (wave 1, disjoint). Files: `src/bun/github.ts` (all 90 `https://api.github.com` literals → `${GITHUB_API_BASE}`; `const GITHUB_API_BASE = process.env.AGETOR_GITHUB_API_BASE ?? "https://api.github.com"`; any origin/Link-header checks derive from it; GraphQL too), `README.md` (env table row), `e2e/fixtures.ts` (per-worker `githubStubPort = 4800 + parallelIndex` exposed on `E2EBackend`; backend env gains `AGETOR_GITHUB_API_BASE=http://127.0.0.1:<port>` and `GITHUB_TOKEN=e2e-github-token` so token resolution never shells out to `gh`), `e2e/github-stub.ts` (new: tiny Node `http` stub — route table keyed by method+path regex, JSON responses, mutable state, per-route call log, 404 JSON + stderr log for unmatched paths). Acceptance: typecheck green; `bun test src/bun/github*.test.ts src/bun/pull-detail.test.ts src/bun/git-host*.test.ts` green; default behavior byte-identical.
- **T7 — Playwright spec** (wave 2, after T5+T6). File: `e2e/pr-merged-state.spec.ts` (new). Arrange: temp git repo with `origin = https://github.com/e2e-org/e2e-repo.git`, registered as a project via the API; stub routes for `/user`, `/repos/e2e-org/e2e-repo` (permissions.push true), pulls list, labels, `/pulls/42` (detail+mergeability), `PUT /pulls/42/merge`, plus whatever per-item fetches the dialog issues (discover by running with the unmatched-path log). Scenarios: (a) list says open, detail says merged → entering detail shows the `role="status"` card with "Pull request successfully merged", no Merge button; (b) detail open on first entry → grid; back to list; flip stub to merged; re-enter → card; assert `/pulls/42` detail hit count increased (refresh on every entry); (c) open + mergeable → click Merge → stub returns `{merged:true}` → card appears immediately, green success line absent. Run: `bun node_modules/@playwright/test/cli.js test e2e/pr-merged-state.spec.ts`.
- Then: opus review of `1e5f654..HEAD`, fixes, full `bun test` + full Playwright suite (fixture env change touches every worker).

### 10.4 Risks
- T6 touches 90 URL sites — mechanical, default unchanged, covered by `github.test.ts`/`github-network.test.ts` (89 literal URL assertions) which must stay green.
- Refresh effect reordering (C1) changes effect declaration order only; behavior verified by the reviewer's trace.
- Stub completeness for the dialog's many per-item fetches — unmatched routes 404; sections show their own errors but the Actions card/grid still renders; the spec asserts only on the Actions section.
