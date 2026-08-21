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
- **e2e: not applicable** — desktop Electrobun app with no e2e harness in the repo; logic is covered by the extracted-pure-helper idiom the codebase standardizes on. Recorded decision, not an omission.

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
