# Plan — GitHub modal: PR/issue detail as a subpage (+ UI polish)

| Field | Value |
| --- | --- |
| Date | 2026-07-14 |
| Source | /implement invocation + screenshot `screenshot-2026-07-14_16-52-21-1a8d79dc.png` |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/open-pr-in-another-sub-page-of-the-modal |
| Base SHA | dfb16bb7cfe107633aa905d48a04655675854a91 |
| Mode | **Autonomous** — grill and plan-approval gates bypassed; all assumptions logged in §8 |

## 1. Objective & success criteria

Clicking a PR (or issue) in the GitHub modal's list must no longer expand it inline (accordion). Instead it opens a dedicated **detail subpage inside the same modal**, with a back affordance returning to the list (filters, scroll context and result set preserved). Secondary objective: a UI review-and-improve pass over the modal.

Done means:
- Clicking a list row title (or its chevron) navigates to a full-panel detail view rendering everything the accordion showed today (edit, reactions, merge/close actions, triage, checks, commits, diff, reviews, conversation).
- A back chevron in the modal header returns to the list; Escape pops the subpage first and only closes the modal from the list view.
- The list's fetched results/filters are untouched by navigation (no refetch on back).
- `bun run typecheck` green, `bun test` green, `vite build` green.

## 2. Context & constraints (Phase 1 findings)

- `GitHubDialog` lives in a single 8,427-line file `src/mainview/components/kanban/GitHubDialog.tsx:380`.
- Accordion state: `expandedKey: string | null` (`GitHubDialog.tsx:501`); rows toggle via `setExpandedKey` at `GitHubDialog.tsx:3358-3361`; expanded body is `GitHubItemRow`'s `{expanded && (...)}` block (`5994-6165`).
- Detail data loads via 7 lazy `useEffect`s keyed off derived `expandedItem` (`818-821`, effects `1737-1951`) into per-item maps keyed by `itemKey(item)` — these keep working if we derive `expandedItem` from the new view state instead.
- The app's canonical subpage pattern is `SettingsDialog.tsx:35-38` — a discriminated-union `View` state + back chevron in the header + body switch. Replicate it.
- 7 manager panels (Labels/Milestones/Releases/Notifications/Actions/Projects/Discussions) are mutually-exclusive booleans with ~120 lines of repeated "close the other six" logic (`2653-2769`) and no back affordance.
- No React tests for the dialog; mainview tests only cover pure `lib/` helpers (e.g. `mergeability.test.ts`, `diff-rows.test.ts`). Precedent (knowledge base): extract pure logic into `src/mainview/lib/` and unit-test it there.
- Bun-side GitHub API layer (`src/bun/github.ts`) is untouched by this feature.

## 3. Approach & key decisions

- **Full-panel replacement** (SettingsDialog precedent), not a slide-over. The header stays; while in detail view the filters row + "Mine" chips + toolbar icon buttons are hidden and replaced by: back chevron, `{Pull request|Issue} #N` title (+ repo badge in multi-repo mode), an "open on GitHub" external link for the item, and refresh.
- **One `View` union to rule the body**: `{ kind: "list" } | { kind: "detail"; item: GitHubListItem }`, plus (wave 2) the 7 manager booleans collapse into the same union (`{ kind: "panel"; panel: PanelKind }`). Pure helpers + types live in a new `src/mainview/lib/github-dialog-view.ts` so they're unit-testable.
- **Detail subpage covers issues too** — the accordion is shared between kinds today; splitting behavior by kind would be inconsistent.
- **Escape pops before closing**: `GitHubDialog` wraps the `onClose` it passes to `Dialog` — if `view.kind !== "list"`, go back to list instead of closing.
- **Keep the per-item lazy-fetch effects and state maps as-is**; only re-derive `expandedItem` from `view`. This minimizes blast radius in an 8.4k-line file.

Alternative considered: extracting the whole detail view into a routed sub-component file with its own data hook (`usePullRequestDetail`). Right long-term move, but it multiplies risk here (~90 props to re-thread); deferred — noted in §8.

## 4. Work breakdown — implementation tasks

Both waves edit the same monolithic file, so implementation is **sequential (2 waves × 1 agent)** — no same-file parallelism.

**T1 (Wave 1) — Detail subpage (core feature).** Owns: `src/mainview/components/kanban/GitHubDialog.tsx`, new `src/mainview/lib/github-dialog-view.ts`.
- Add `View` union + helpers in the new lib file (`openDetail(item)`, `backToList`, `resolveEscape(view)` returning `"pop" | "close"`).
- Replace `expandedKey` with `view` state; derive `expandedItem` from `view`.
- Row click/chevron → `setView(detail)`; chevron becomes a "open detail" affordance (`ChevronRight`, no down state); fix `title="View in Agetor"` copy to "Open details".
- Move the `{expanded && ...}` block out of the row into a detail-view render path that shows item header, then the existing sub-components (ItemEditor/Reactions/PullActions/PullTriage/CheckRuns/CommitStatus/PullCommits/PullDiff/PendingReview/ReviewComments/IssueActions/Conversation) full-width.
- Header in detail mode: back chevron (aria-label "Back"), kind+number title, repo badge when multi-repo, item external link, refresh.
- Escape pops to list; modal close only from list. List state (results, filters, scroll container) untouched on back.
- Acceptance: feature works end-to-end; typecheck green.

**T2 (Wave 2) — UI review/improve pass.** Owns: same file (+ lib file).
- Collapse the 7 manager booleans into the `View` union (`{ kind: "panel"; panel: PanelKind }`); toolbar buttons call one setter; panels get the same back-chevron header treatment; remove the ~120 lines of mutual-exclusion boilerplate.
- Consistency audit: loading/empty/error states in detail subpage match list conventions (`Loader2` spinner idiom); icon buttons keep `title`+`aria-label` pairs; spacing normalized (`text-xs`, `rounded-md border-border/60` idiom).
- Keep hardcoded status colors as-is (dark-only app; token migration is out of scope — §8).
- Acceptance: no behavioral regressions to the panels; typecheck green.

## 5. Work breakdown — test tasks

**TT1** — unit tests for `src/mainview/lib/github-dialog-view.ts` (view transitions, escape resolution, detail-for-issues, panel exclusivity) in `github-dialog-view.test.ts`, following `mergeability.test.ts` idiom. Covers T1+T2 logic.
**TT2** — regression: full `bun test` + `bun run typecheck` + `bunx vite build` (no new bun-side tests needed; API layer untouched).

## 6. Execution waves

1. Wave 1: T1 (single agent) → checkpoint commit.
2. Wave 2: T2 (single agent) → checkpoint commit.
3. Review (Phase 5, opus) → fixes if must-fix.
4. TT1 (single agent) → TT2 run (haiku) → fix loop if red.

## 7. Blast radius & risks

- `GitHubItemRow` consumes ~90 drilled props; moving the expanded block changes its prop surface — the compiler will catch misses (typecheck is the gate).
- The 7 lazy-fetch effects key on `expandedItem`; if the derivation breaks, detail panels render empty. Manual check: effects still fire when `view.kind === "detail"`.
- Escape handling: `Dialog` primitive owns Escape → wrap `onClose`; risk of double-close if the primitive also closes on backdrop click (same wrapper applies).
- Peer overlap: agent `early-bay-8f6e` is extending this same modal for Bitbucket/GitLab on another branch — merge conflicts expected; they were warned via fleet message.
- Rollback: revert the two wave commits; no data/schema changes.

## 8. Open questions / assumptions (autonomous mode)

1. **Assumed** the detail subpage covers both PRs and issues (shared accordion today).
2. **Assumed** full-panel replacement à la SettingsDialog, not a split/slide-over.
3. **Assumed** filters/toolbar hidden while in detail view (back + title + item link + refresh shown instead).
4. **Assumed** folding the 7 manager panels into the same view union is in scope for "review and improve the UI" (it fixes the inconsistent close UX); their internals are untouched.
5. **Deferred**: splitting the 8.4k-line file into modules and a `usePullRequestDetail` hook; semantic-token migration for hardcoded status colors.
6. **Assumed** Escape-pops-subpage-first is the desired modal behavior.
