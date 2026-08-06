# Plan — Worktrees list page (stale flag, ticket links, archive-delete, filters/sort)

| Field | Value |
| --- | --- |
| Date | 2026-07-17 |
| Source | /implement task: "add a worktrees list page with a stale flag … link them to their tickets … delete button → confirmation → ticket archiving (which deletes the worktree) … filters and sort … ticket status (column) … project per worktree" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/stale-worktrees |
| Base SHA | d6954f6 |
| Mode | **Autonomous** — grill + plan-approval gates bypassed; all assumptions logged in §8 |

## 1. Objective & success criteria

A "Worktrees" page (full-screen overlay, opened from the app header) listing every agetor-managed worktree currently materialized on disk, where the user can:

1. See at a glance which worktrees are **stale** (badge + reason).
2. Identify each worktree by its **project**, **branch**, and **ticket** (task) — and click the ticket to open its details panel.
3. See the ticket's **status** (kanban column).
4. **Delete** a worktree via a confirmation dialog that explains the ticket will be **archived**; archiving performs the worktree removal (existing deferred teardown).
5. **Filter** (text, project, status, staleness) and **sort** (updated, project, status, branch; asc/desc) the list.

Success: `bun run typecheck` green, `bun test` green including new backend tests for listing/staleness/force-archive/orphan-delete.

## 2. Context & constraints (from investigation)

- Worktrees live at `dataDir/worktrees/<task-id>` (`worktree.ts:505-507`, `WORKTREES_DIR` at `worktree.ts:12`, **not exported today**). No code enumerates that directory yet.
- `archiveTask` (`orchestrator.ts:1854-1902`): requires `column === "done"` and no active run; stamps `archivedAt`; defers session-kill → terminal-kill → `detachWorktree` through the **per-workdir FIFO teardown queue** (`enqueueTeardown`, `orchestrator.ts:118-186`). `detachWorktree` keeps the branch and **refuses dirty worktrees** (`worktree.ts:802-830`). Fleet invariant: any path touching a worktree must `await pendingTeardown(taskId)` first; never enumerate-and-kill `agetor-*` tmux sessions.
- `deleteTask` is the destructive path (branch + task row gone) — **not** what the user asked for; they explicitly asked for archive semantics.
- Archived state is only `tasks.archived_at` (migration 019); worktree presence is always computed live via `existsSync` (design decision in `docs/plans/archive-worktree-cleanup.md` — no worktree-state column). `sweepArchivedTeardowns` (`orchestrator.ts:1997-2018`) is the closest existing "stale" scan.
- Server: object-style `Bun.serve` routes, every route wrapped in `authed(...)`; long worktree ops call `server.timeout(req, 0)` first (`server.ts:3098-3105`). Archive route exists: `POST /tasks/:id/archive` (`server.ts:3118-3126`).
- Frontend: no routing — "pages" are full-screen overlays gated by a boolean in `App.tsx` (GitHubDialog pattern, header icon buttons at `App.tsx:605-622`). Task details open via `setSelected(task)`. Confirmations via `useConfirm()` (`confirm.tsx`); delete-task usage at `App.tsx:518-536` is the template. Filters via `MultiSearchSelect`/`Select` (`KanbanFilters.tsx`); no table primitive — div-row lists are the house style. Column labels: `COLUMNS` in `shared/types.ts:20-27`. Project name: `p.name || basename(p.path)` chain; compact paths via `abbreviateHome` (`lib/utils.ts:8`).
- Tests: `AGETOR_DATA_DIR` set at module top before imports, temp git repos via local `makeRepo()` helpers, dynamic imports after env setup, fake driver env vars (`orchestrator-archive-teardown.test.ts:6-41`).

## 3. Approach & key decisions

**Data source**: new `GET /worktrees` returning `WorktreeInfo[]`, computed by `orchestrator.listWorktrees()`: enumerate `WORKTREES_DIR` on disk, cross-reference `tasks.list()` by dir name (dir name == task id). **No git subprocesses in the bulk list** — staleness uses only DB + fs signals, avoiding the N+1 spawn fan-out the investigation flagged. Project name resolution happens client-side against the already-loaded `projects` list (no backend coupling).

**Staleness** (`stale: boolean` + `staleReasons: WorktreeStaleReason[]`):
- `"orphaned"` — dir on disk with no task row (crash/failed teardown leftovers).
- `"archived"` — owning task has `archivedAt != null` but the dir is still on disk (teardown pending, failed, or skipped because dirty).
- `"inactive"` — task not archived, no active run, and `now - task.updatedAt > WORKTREE_STALE_AFTER_MS` (7 days, constant in `shared/types.ts`).

**Delete = force-archive**: `archiveTask(taskId, { force?: boolean })` — `force` bypasses the `done`-column gate (still rejects an active run; teardown queue and dirty-worktree protection unchanged). Route: existing `POST /tasks/:id/archive` accepts an optional JSON body `{ force: true }`. Orphan dirs have no ticket to archive → `DELETE /worktrees/:id` removes the dir (id validated, path confined to `WORKTREES_DIR`, refuses if a task row exists, `await pendingTeardown(id)` first, best-effort `git worktree prune` in the source repo parsed from the `.git` pointer file).

**UI**: new `WorktreesDialog` full-screen overlay (GitHubDialog pattern), header icon button in `App.tsx`. Div-row list; client-side filter/sort (list is small — one row per on-disk worktree). Clicking the ticket title closes the dialog and calls `setSelected(task)`. Delete uses `useConfirm({ variant: "destructive" })` with copy explaining: ticket will be archived, worktree removed, branch + AI history preserved, and a dirty worktree is left in place to protect uncommitted work.

**Alternatives considered**: (a) `deleteTask` for the delete button — rejected, user explicitly asked for archive semantics and `deleteTask` destroys the branch + history; (b) persisting a worktree-state column — rejected, contradicts the standing archive design decision (live `existsSync`); (c) bulk git dirty/merged checks in `GET /worktrees` — rejected for now (subprocess fan-out per poll), listed as a follow-up; (d) small centered `Dialog` instead of full-screen overlay — rejected, a list page with filters matches the GitHubDialog precedent.

## 4. Work breakdown — implementation tasks

| ID | Goal | Files owned | Deps | Acceptance |
| --- | --- | --- | --- | --- |
| T1 | Backend: `WorktreeInfo` type + staleness constants; export `WORKTREES_DIR`; `listWorktrees()`; `archiveTask` force option; orphan delete; routes `GET /worktrees`, `DELETE /worktrees/:id`, archive body parsing | `src/shared/types.ts`, `src/bun/worktree.ts`, `src/bun/orchestrator.ts`, `src/bun/server.ts` | — | Endpoints respond; staleness classified per §3; teardown-queue invariants respected |
| T2 | Frontend: `WorktreesDialog` overlay + filters/sort + confirm-delete; `App.tsx` wiring (header button, open-ticket); `api.ts` client fns | `src/mainview/components/worktrees/WorktreesDialog.tsx` (new), `src/mainview/App.tsx`, `src/mainview/lib/api.ts` | contract from T1 (types provided inline in brief) | Page opens, lists, filters, sorts; ticket opens details; delete confirms then force-archives / orphan-deletes |

## 5. Work breakdown — test tasks

| ID | Goal | Files owned | Covers |
| --- | --- | --- | --- |
| TT1 | Backend tests: `listWorktrees` (linked/orphaned/archived/inactive classification), `archiveTask` force gate (non-done + force ok, active-run still rejected), orphan delete (happy path, refuses live task id, path confinement) | `src/bun/worktrees-list.test.ts` (new) | T1 |

No frontend unit-test harness exists in this repo; T2 is covered by `bun run typecheck` and the review pass.

## 6. Execution waves

- **Wave 1**: T1 + T2 in parallel (disjoint file sets; T2 imports the shared types T1 writes — contract is fixed in both briefs; orchestrator runs typecheck at the wave barrier, not the agents mid-flight).
- **Wave 2**: TT1 (after review).

## 7. Blast radius & risks

- `archiveTask` signature change — existing callers (`server.ts` archive route, tests) keep working via optional param. Archiving from a non-`done` column leaves the task hidden-in-place in that column; unarchive restores it there (UI already handles archived cards in any column via the `archivedView` filter).
- New worktree-touching paths must respect `pendingTeardown` + never enumerate tmux sessions — orphan delete touches only the fs + `git worktree prune`, no session kills.
- `GET /worktrees` polling: fs-only (readdir + existsSync), safe at 5s cadence.
- Orphan delete is the only genuinely destructive new operation — mitigated by id validation, `WORKTREES_DIR` path confinement, and the task-row-exists refusal.

## 8. Open questions / assumptions (autonomous mode)

1. **Stale definition** chosen by me (§3): orphaned / archived-but-present / inactive-7-days. Threshold is a named constant (`WORKTREE_STALE_AFTER_MS`) — trivial to tune.
2. **"Delete" maps to force-archive**, not `deleteTask` — per the user's own wording ("the ticket will be archived"). Force bypasses the `done`-only gate so stale worktrees in any column can be cleaned; an active run still blocks it.
3. **Orphan dirs** (no ticket) are included in the list with a plain delete (no ticket to archive) — the user didn't ask, but a stale-worktrees page that can't show/clean orphans would silently miss the worst offenders.
4. **Dirty worktrees**: archive proceeds but the existing teardown skips removal (uncommitted work is never destroyed); the row will then show as stale/"archived". Confirmation copy mentions this.
5. **Project shown** = existing `Project.name || basename(path)` chain resolved client-side from `task.workdir`; orphan rows show the source repo parsed from the `.git` pointer when available, else "—".
6. List shows only worktrees **materialized on disk** (archived+already-detached tasks are not "worktrees" anymore and would be noise).
7. Client-side filter/sort (no server pagination) — worktree counts are small by construction.
