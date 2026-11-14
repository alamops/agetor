# Plan — One Select Projects control for task creation

| Field | Value |
| --- | --- |
| Date | 2026-11-13 |
| Source | Pipeline task text + screenshot `screenshot-2026-11-13_15-07-41-ad004ca2.png` (outside the repo); investigation `docs/plans/select-projects-combined-investigation.md`; grill `docs/plans/select-projects-combined-grill.md` (14 decisions, all owner-accepted) |
| Flags | none |
| Gates | grilled + owner-accepted (14/14 decisions, 0 skipped); plan written for the pipeline's Implementing step |
| Status | implemented — see §10 execution record |
| Branch | `fix/agetor-multiple-repo-task` |
| Base SHA | `41d2692d` (verified: `git rev-parse --short HEAD`) |

## 1. Objective & success criteria

Replace New Task's split project UI (a single `ProjectPicker` plus a separate `Repositories` → “Use multiple repositories…” dialog) with **one full-width Select Projects control** that is the only selection surface, shows the selected count, gives **every** selected project the same Branch/Pull/Fetch row the single project has today, and forces + disables Isolate for 2+ projects. The same control replaces the issue dialog's and PR-conflict dialog's project/repository UI.

Each criterion names the production path that produces it and the test that drives that path.

| # | Success criterion | Production path | Proven by |
| --- | --- | --- | --- |
| SC1 | One full-width **Select Projects** button sits above the Isolate checkbox. Its label is `Select projects…` at zero, the project name at one, and `N projects selected` for N≥2. | `useProjectSelection` (`projectSelectionLabel`) → `SelectProjectsButton` inside `WorktreeOptions` → `NewTaskForm` / `CreateTaskFromIssueDialog` / locked `ResolveConflictsDialog` | ET1 (labels 0/1/2), T7/T8 typecheck |
| SC2 | Every selected project renders its own inline `Branch · <project>` row with the existing `BranchPicker` (base ref + Pull + Fetch), and each row's chosen ref rides the create payload as `repositories[].baseRef`. | `WorktreeOptions` rows → `useProjectSelection.setBaseRef` → `selectionPayload` → `POST /tasks` → `createTask` (`orchestrator.ts:12559-12578`) | ET1 (two projects, non-current refs, assert stored shas) |
| SC3 | Exactly one project keeps the historical single-repository payload shape (`workdir` + top-level `baseRef`) so a plain non-git folder still creates with isolation off. | `selectionPayload` single-entry branch → `worktreePayload` | UT2 + ET1 (single project, assert `workdir`/`baseRef`, no `repositories[]`) |
| SC4 | 2+ deduped projects force Isolate on and disable the checkbox; collapsing back to one leaves it checked and editable. | `useWorktreeOptions({ forceIsolate })` → `effectiveIsolate` → checkbox + branch-name visibility + `valid` | ET1 + unit by inspection in UT2 (payload forcing) |
| SC5 | Git-root dedupe decides the button count, the forced isolate and the payload: two subdirectories of one repository read as **one** project. | `SelectProjectsDialog` Save (`mergeSelectionsByRoot`) → `dedupeSelections` in `projectSelectionLabel`/`multiRepo` → `selectionPayload` | ET1 (dedupe scenario) + UT1 |
| SC6 | At least one project is required: the dialog draft may reach zero with Save disabled and a hint; Create/Run is disabled with no saved project. | `SelectProjectsDialog` Save gate → `NewTaskForm`/`CreateTaskFromIssueDialog` `canSubmit` | ET1 (draft zero) + T7/T8 |
| SC7 | The Select Projects dialog applies on Save, ignores outside clicks, closes on Escape/Cancel, offers search, and hosts Add folder / Clone repository / Import sessions. | `SelectProjectsDialog` + `Dialog closeOnBackdrop={false}` | ET1 (backdrop/Escape/search/entries) + T3 |
| SC8 | The issue dialog uses the same control with its issue repo first and locked; the PR-conflict dialog shows the PR repo locked in the same control, its branch read-only and Isolate checked/disabled. | `WorktreeOptions` live `lockedPath`; locked variant `{ branch, projectPath }` | ET2a (issue + resolve-conflicts specs) |
| SC9 | After submit the selected projects and every per-project ref are kept for the next task; the branch-name field resets to its pattern. | `NewTaskForm.submit` → `wt.resetAfterSubmit()` (branch only) + `selection.resetRefDirty()` | ET1 (submit twice / assert form state) |
| SC10 | The repo's docs describe the combined control, and no live code or current doc still describes the old split. | T14 edits | T15 grep sweep |

## 2. Context & constraints

### 2.1 Source ask (verbatim, outside the repo)

> Currently multiple repo is having the one selection and multiple selection
>
> Let’s do differently
>
> Let’s combine both.
>
> One Select Projects full width button in new task, on top of the Isolate checkbox.
>
> One selection is required.
>
> Once the projects are selected, the number of selected must show in the label of the button, just like currently.
>
> Per project selected, we must have the branch picker, pull and fetch features we have for one project.
>
> When more than one is selected, isolate is disabled and auto checked.

The screenshot (`screenshot-2026-11-13_15-07-41-ad004ca2.png`, outside the repo) shows today's order: `Project` picker → `Branch` row → `Isolate` → `Branch name` → `Repositories` → “Use multiple repositories…”. The owner's 14 decisions resolving the open questions are committed in `docs/plans/select-projects-combined-grill.md` (notably decisions 1, 2, 4, 5, 8, 11, 13, 14). The in-repo contract being amended is `docs/specs/multi-repo-tasks.md` §UI and `docs/architecture/multi-repo-tasks.md` §Surfaces.

### 2.2 Baseline and live facts checked in this worktree

| Fact | Command → result |
| --- | --- |
| Baseline commit | `git rev-parse --short HEAD` → `41d2692d` |
| Toolchain | `bun --version` → `1.3.10`; TypeScript 5.9.3; Playwright 1.62.1 (from the investigation, unchanged) |
| Focused webview helpers pass | `bun test src/mainview/lib/repo-selection.test.ts src/mainview/lib/multi-repo-ui.test.ts src/mainview/lib/worktree-payload.test.ts` → **66 pass, 0 fail**, 107 expect calls |
| Typecheck clean at baseline | `bun run typecheck` → no output |
| Working tree | only the three untracked planning records (`select-projects-combined-*`); no code changes |

### 2.3 Current state and data flow (file:line anchors)

- `src/mainview/components/kanban/NewTaskForm.tsx`
  - `workdir` is a separate state (`:247`), `repos: RepoSelection[]` mirrors it (`:250`), an effect copies `workdir` into an empty `repos` (`:255-257`), `multiRepo = repos.length > 1` (`:252`).
  - `useWorktreeOptions({ workdir, title, taskType })` owns isolate + the single `baseRef` + branch name (`:262`); a 2+ selection force-sets isolate through an **effect** (`:267-270`), so `wt.isolate` can be false for one render.
  - `fileScope` / `fileScopes` read `wt.baseRef` and `multiRepo` (`:320-329`).
  - `canSubmit` requires `workdir && repos.length > 0 && wt.valid` (`:646-648`); submit branches on `multiRepo` for the payload (`:650-722`).
  - JSX: Project block (`:865-882`), `WorktreeOptions` (`:883`), Repositories summary/button + dialog (`:884-934`).
- `WorktreeOptions.tsx`
  - `useWorktreeOptions` owns `isolate`, `baseRef`/`baseRefDirty`, branch config, branch field/validation, `payload()` (`:48-95`, `:103-232`).
  - `variant="multi"` hides the branch picker and isolate checkbox and shows an “always on” paragraph (`:292-293`, `:315`, `:331`, `:347-353`).
  - Locked variant renders a read-only branch + checked/disabled isolate (`:265-290`).
- `RepositoriesDialog.tsx`
  - Props `open/onClose/value/onSave/lockedPath` (`:18-28`); draft re-seeded on open (`:71-81`); per-repo base-ref text input only when deduped 2+ (`:89-90`, `:229-241`); Save resolves roots → `mergeSelectionsByRoot` → conflicts (`:146-182`); list is `max-h-72 overflow-y-auto` (`:201`); footer raw `N selected` (`:274-287`).
- `ProjectPicker.tsx` — single-select `SearchSelect`, `autoSelectFirst` (`:67-76`), footer Browse/Clone/Import (`:118-148`), mounts `CloneProjectDialog`/`ImportSessionsDialog` as siblings (`:153-162`). Only product caller: `NewTaskForm` (`:54`, `:867`).
- `repo-selection.ts` — `dedupeSelections` (`:28-39`), `selectionNames`/`selectionName` (`:42-49`), `repositoryFileScopes` (`:59-73`), `collapseToProject` (`:117-126`), `pinPrimaryRepository` (`:136-156`).
- `multi-repo-ui.ts` — base-ref carry `seedRepositoriesDialogValue`/`applyRepositoriesSave` (`:27-78`), git-root merge/conflict (`:102-146`), session guard (`:155-168`).
- `worktree-payload.ts` — `worktreePayload` maps isolate/baseRef/branch (`:33-39`).
- `dialog.tsx` — backdrop click always closes (`:205-224`); Escape/Tab handling (`:96-191`).
- `CreateTaskFromIssueDialog.tsx` — shares `useWorktreeOptions`/`WorktreeOptions`/`RepositoriesDialog`; issue repo locked first (`:428-449`); dirty check uses `wt.baseRefDirty` (`:214-221`); submit branches on `multiRepo` (`:242-290`); JSX (`:414-451`).
- `ResolveConflictsDialog.tsx` — renders `WorktreeOptions locked={{ branch: context.headRef }}` (`:252`).
- `BranchPicker.tsx` — already generic per `workdir`, `value`, `onChange`, `onAutoSelect`, `label`, `title`, `placement`, `disabled` (`:7-31`); auto-selects the current branch on load (`:182-189`); Pull/Fetch act per workdir (`:123-159`).
- `SearchSelect` — trigger + **absolutely positioned** popover (`search-select.tsx:140-149`); `IDENTIFIER_INPUT_PROPS` on its search box (`:153-160`). This is why branch rows stay inline, not inside the dialog's scroll box.

### 2.4 Server contract (read, not changed)

- `POST /tasks` accepts `workdir` + optional `repositories: [{ path, baseRef? }]`.
- A **1-entry** `repositories` payload goes through the ordinary single path and honors that entry's `baseRef` (`orchestrator.ts:12521-12542`), but that entry must be a git repository: `resolveRepositorySet` rejects any path with no resolved root (`task-repos.ts:59-63`). So a single selection **must** keep `workdir` + top-level `baseRef` — a plain non-git folder with isolation off would otherwise 400.
- A **2+** selection requires `isolation: "worktree"`, rejects `existingBranch` (`orchestrator.ts:12515-12520`), dedupes by git root (`task-repos.ts:64-66`), resolves each entry's base ref, and mints one shared branch name per repo with a `-N` fallback (`orchestrator.ts:12559-12578`, `12791-12819`). The shared name is anchored on the first kept repository's `branchConfig` (`:12551`, `:12807`).
- No server, schema, migration, route or policy change is required. All routes used already exist: `/projects`, `/projects/pick`, `/projects/repo-root` (app-only), `/projects/branches|fetch|pull` (`api.ts:944-1049`).

### 2.5 UI and runtime constraints

- `SearchSelect`'s popover is `absolute`; the dialog's row list is `max-h-72 overflow-y-auto`. Per-project `BranchPicker`s must stay **inline in the form** (grill decision 1) or they clip. This is code-evidenced, not a guess.
- A popover inside a dialog must carry `data-popover-open` only while open and close on Escape (`CLAUDE.md:112`, `dialog.tsx:96-153`). The new search input is a plain identifier input, not a popover.
- A `fixed` overlay portals to `document.body` unless a transformed ancestor rebases it (`CLAUDE.md:113`). The new dialog is a normal `Dialog` inside the aside/dialog; no transform ancestor.
- WKWebView allows ~6 connections/host, two are permanent SSE (`CLAUDE.md:107`). Each selected project mounts one `BranchPicker` that calls `/projects/branches` once. Expected 2–3 projects is fine; 10+ is a separate performance ticket (out of scope).
- No unit test renders `NewTaskForm`/`WorktreeOptions`; Playwright is the only real-UI coverage. A button-only change stays green in `bun test`, so the e2e must pick **non-current** refs and assert stored shas (investigation §2).

### 2.6 Repo rules that apply

| Rule | Path | Consequence |
| --- | --- | --- |
| Update the subsystem doc in the same change | `CLAUDE.md:5` | Spec, multi-repo architecture, prompt-composer, issue-tasks, security, clone-repository, session-import, topic map and README move with the code. |
| No new raw spawn/route/path-bearing field | `CLAUDE.md:88-91` | Reuse the existing project/git routes; no server edit. |
| `src/shared/` has no runtime imports from either process | `CLAUDE.md:102` | New pure helpers stay in `src/mainview/lib/`. |
| Semantic color tokens only | `CLAUDE.md:172` | New hint/error copy uses `text-warning`/`text-destructive`/`text-muted-foreground`. |
| Popover / dialog Escape contract | `CLAUDE.md:112`, `docs/architecture/prompt-composer.md:18-24` | Any picker that ends up inside the dialog keeps the marker contract; branch rows stay outside. |
| Overlay portal rule | `CLAUDE.md:113` | The dialog uses the existing `Dialog` primitive; no new transformed container. |
| E2E is real-DOM/real-backend, per-worker backend | `playwright.config.ts`, `e2e/fixtures.ts` | UI coverage goes in Playwright; native pickers are not testable (register via `POST /projects`). |

### 2.7 Runtime and trust shape

- Desktop app: one Bun core, one React webview, one SQLite DB. No cross-instance concurrency, no migration ordering.
- No new privileged action: the dialog reads `/projects` (app token) and resolves `/projects/repo-root` (app-only); branch list/fetch/pull are existing `app+cli` routes used by the webview with the app token. Selected paths still come from the registered-projects table or the native folder picker; the server still validates every repository path at create time.
- The change is webview-only. Rollback is a UI revert; tasks already created keep their stored `repositories[]`.

## 3. Approach & key decisions

### 3.1 Chosen shape

```
New Task / issue dialog:
  [ Select Projects — full width button ]   ← 1 project name / N projects selected / Select projects…
  Branch · <project A>   [branch trigger]  Pull  Fetch
  Branch · <project B>   [branch trigger]  Pull  Fetch
  [x] Isolate (worktree)                    ← checked+disabled for 2+, checked+editable on collapse
  Branch name  [feature/<slug>]  ⚙
```

Select Projects opens a Save-based modal (search + project rows + Add folder/Clone/Import) which owns **selection only**. Every per-project base ref is edited in the inline rows. On Save the dialog resolves git roots, dedupes by root, preserves refs, and hands the kept list back. The PR-conflict dialog renders the same button locked to its PR repo, the read-only branch row, and a checked/disabled isolate checkbox.

Alternatives considered (from the investigation's option table), and why they lost:

- **B — branch rows inside the dialog**: literal “button → Isolate”, but `SearchSelect`'s absolute popover is clipped by `max-h-72 overflow-y-auto` (`RepositoriesDialog.tsx:201`, `search-select.tsx:140-149`); it would need a portal/fixed picker mode and hides refs after Save. Rejected by grill decision 1.
- **C — live `MultiSearchSelect` popover**: exact count-label convention, but no Save step means git-root dedupe and base-ref conflicts become async/live, and there is no home for Add folder/Clone/Import. Rejected by decision 2.
- **D — keep both selectors**: contradicts the ask.
- **Extend `useWorktreeOptions` with per-repo refs**: the hook is also mounted by the locked PR variant and is about worktree state; selection belongs in a dedicated hook. Chosen: a new `useProjectSelection` + the pure `selectionPayload` builder keep one owner per concern and are unit-testable.

### 3.2 State ownership (pinned for parallel work)

- `repos: RepoSelection[]` is the **single source of truth** for selection and every per-project base ref. `workdir` is derived (`repos[0]?.path ?? ""`); there is no separate selected-project state.
- `selectionPayload({ repos, isolate, branchSubmitValue })` in `src/mainview/lib/worktree-payload.ts` is the only mapping from the selection to `workdir`/`isolation`/`baseRef`/`branch`/`repositories`. Both forms spread its result.
- `multiRepo` is `dedupeSelections(repos).length > 1` (post-dedupe, per decision 13).
- Isolate is derived: `effectiveIsolate = forceIsolate || isolate` inside `useWorktreeOptions`. The payload, `valid`, checkbox state and branch-name visibility all read `effectiveIsolate` — no render-time race. One contained effect keeps the raw toggle sticky at true when `forceIsolate` turns on, so collapsing to one leaves it checked (decision 8).
- `useProjectSelection` owns the selection, the auto-select-on-open behavior (most recently added project, decision 7), and the `refDirty` flag that distinguishes a user ref pick from `BranchPicker`'s auto-selected current branch.
- The shared branch name stays one field (decision 12); its preview uses the first selected project's `branchConfig`, matching the server's first-kept-repo anchor. Not a “primary repo” in the data model.

### 3.3 Decisions resting on evidence vs. reasoning

Evidence: payload shape (1-entry rejects non-git folders; 2+ needs worktree), popover clipping, per-project route reuse, session-guard behavior, current state/race. Owner decisions: layout, dialog dismissal, scope (New Task + issue + PR), label/count rule, no tag/SHA UI, auto-select, isolate collapse, per-row Pull/Fetch only, search/management actions, row naming/removal, shared branch name, deduped count, keeping selection after submit.

## 4. Work breakdown — implementation tasks

> Pinned interfaces (wave 3 codes against these before they exist on disk):
>
> - `useProjectSelection({ autoSelect?, enabled? })` → `{ repos, setRepos, workdir, multiRepo, setBaseRef(path, ref), setBaseRefAuto(path, ref), refDirty, resetRefDirty }`.
> - `<SelectProjectsButton label={…} onClick={…} disabled? locked? />` — full-width `<button data-testid="select-projects-button">`.
> - `<SelectProjectsDialog open onClose value onSave lockedPath? />` — dialog accessible name **Select projects**.
> - `<WorktreeOptions state repos onReposChange onBaseRefChange onBaseRefAuto lockedPath? />` or `<WorktreeOptions locked={{ branch, projectPath }} />`.
> - `useWorktreeOptions({ workdir, title, taskType, enabled?, forceIsolate? })`; state exposes `isolate`, `setIsolate`, `effectiveIsolate`, `forceIsolate`, `branchField`, `branchValidation`, `valid`, `resetAfterSubmit`, `resetForOpen` (no `baseRef*`, no `payload()`).
> - `selectionPayload({ repos, isolate, branchSubmitValue })` → `{ workdir, isolation, baseRef?, branch?, repositories? }`.
> - Test ids: `select-projects-button`, `select-projects-search`, `select-projects-row-<slug>`, `select-projects-save-error`, `branch-row-<slug>`; keep `worktree-options`, `worktree-options-locked`, `isolate-toggle`, `branch-name-input`, `locked-branch`, `project-clone-open`, `project-import-sessions-open`, `Select ${path}`, `Remove ${path}`.

| ID | Goal | Owned files | Depends on | Acceptance (scenarios) | Risk | Wired by |
| --- | --- | --- | --- | --- | --- | --- |
| **T1** | Add the selection-model helpers: display name, button label, row labels, ref update; keep the old helpers for now. | `src/mainview/lib/repo-selection.ts`; `src/mainview/lib/repo-selection.test.ts` | — | `projectSelectionLabel([])` → `Select projects…`; one → its path basename; two distinct roots → `2 projects selected`; two paths with the same known root → the single kept name. `projectRowLabels` uses the basename and appends ` — <path>` to both rows when basenames collide. `updateSelectionBaseRef` replaces only the target entry (order/root/other refs preserved) and is a no-op for an unknown path. `projectDisplayName` returns the raw basename (matching today's trigger), not the slug. Existing tests still pass: `bun test src/mainview/lib/repo-selection.test.ts`. | tests | T5/T7 consume it; no production entry point yet |
| **T2** | Add the pure create-payload builder for a selection. | `src/mainview/lib/worktree-payload.ts`; `src/mainview/lib/worktree-payload.test.ts` | — | 0 → inert `workdir:""`, `isolation:"none"`, no refs. 1 + isolate on → `workdir` + `isolation:"worktree"` + trimmed top-level `baseRef` + verbatim `branch`, **no `repositories`**. 1 + isolate off → `isolation:"none"`, no baseRef/branch. 2+ → `isolation:"worktree"` even when `isolate:false`; `workdir` = first kept path; `repositories` in order with trimmed per-entry refs (blank omitted); no top-level `baseRef`. Two paths under one known root → single shape. Unknown roots are kept. `bun test src/mainview/lib/worktree-payload.test.ts`. | tests | T7/T8 spread it into `POST /tasks` |
| **T3** | Add scoped backdrop dismissal to the shared dialog primitive. | `src/mainview/components/ui/dialog.tsx` | — | `closeOnBackdrop` defaults to `true`, so every existing caller is unchanged. With `false`, a click on the fixed backdrop does not call `onClose`; Escape still does (existing handler untouched). `bun run typecheck`. | none | T6 passes `false`; ET1 proves it |
| **T4** | Add the shared Playwright helpers for the new control. | `e2e/helpers.ts` | — | Exports `openSelectProjects(page, scope)`, `chooseProjects(page, scope, paths)` (clears every non-disabled row, then checks in `paths` order so the first path is truly first), `selectProject(page, scope, path)`, `branchRow(scope, name)`, `selectBaseBranch(page, scope, name, branch)`. `chooseProjects` waits for the first requested row, skips disabled/locked rows, clicks Save, waits for the dialog to hide. No existing helper changes; `bun run typecheck`. | tests | T12/T13 import them |
| **T5** | Create the selection hook and the full-width button. | `src/mainview/components/kanban/ProjectSelection.tsx` (new) | T1 | `useProjectSelection`: derives `workdir`/`multiRepo`; when `autoSelect`/`enabled` and `repos` is empty, fetches `/projects` once and selects the most recently added project; `setBaseRef` updates that entry and marks it user-dirty, `setBaseRefAuto` updates without marking; `refDirty` is false for auto-selected/removed/blank refs; `resetRefDirty` clears. `SelectProjectsButton` renders a full-width button with `data-testid="select-projects-button"`, folder icon, truncating label, optional lock icon, disabled support. Typecheck; no render test exists (e2e T12). | state | T7/T8 render both |
| **T6** | Create the Select Projects dialog (replaces `RepositoriesDialog`). | `src/mainview/components/kanban/SelectProjectsDialog.tsx` (new) | T3 | 1+ selection; Save disabled at zero with a “Select at least one project.” hint; search filters rows by name/path using `IDENTIFIER_INPUT_PROPS`; title “Select projects”; Add folder in the header; Clone repository / Import sessions in the footer (dialogs mounted as siblings, list refreshed on success); **no per-repo ref inputs**; unchecking then re-checking a project within one session restores its `root`/`baseRef` from the opening value (no silent ref loss); Save resolves roots, dedupes, preserves refs, and closes; same-root ref conflict keeps the dialog open with `select-projects-save-error` naming both and telling the user to remove one or keep one inline ref; Cancel/Escape/reopen abandon an in-flight lookup (`createSessionGuard`); outside click ignored (`closeOnBackdrop={false}`); zero-registered empty state offers Add folder. Typecheck. | state | T7 renders it inside `WorktreeOptions` |
| **T7** | Rewire the New Task form and worktree row to the combined control; remove the old single-project and Repositories UI. | `src/mainview/components/kanban/WorktreeOptions.tsx`; `src/mainview/components/kanban/NewTaskForm.tsx` | T1, T2, T5, T6 | `WorktreeOptions` live: Select Projects button → dialog → one `BranchPicker` per repo (`label="Branch · <name>"`, `data-testid="branch-row-<workspace name>"`, `placement="bottom"`, existing titles) → Isolate checkbox (`checked={effectiveIsolate}`, `disabled={forceIsolate}`) → branch-name field while `effectiveIsolate`; no `variant="multi"`, no “always on” paragraph; empty selection shows a “select a project” hint. `useWorktreeOptions` drops baseRef/payload, takes `forceIsolate`, derives `effectiveIsolate`/`valid`, keeps isolate sticky with one effect. `NewTaskForm`: `repos` from `useProjectSelection`, `workdir` derived, remove the workdir→repos sync and forced-isolate effects, `fileScope` ref = `repos[0].baseRef`, `fileScopes` = `repositoryFileScopes(repos, wt.effectiveIsolate)`, `canSubmit` unchanged in spirit, submit spreads `selectionPayload`, post-submit keeps selection+refs and resets branch name/ref-dirty, delete the Project block and the whole Repositories block. | state, tests | `NewTaskForm` is rendered by `App` (existing) |
| **T8** | Move the issue and PR dialogs onto the same control and payload. | `src/mainview/components/kanban/CreateTaskFromIssueDialog.tsx`; `src/mainview/components/kanban/ResolveConflictsDialog.tsx` | T1, T2, T5, T6 | Issue dialog: seeds `repos` from the issue path on open (still first/locked), renders `WorktreeOptions` with `lockedPath`, drops the `Repositories` summary/Manage block and the carry helpers, uses `selectionPayload` in submit, `fileScope` ref from the first repo, `fileScopes` at `effectiveIsolate`. `draftDirty` = prompt/references/type/isolate/branchDirty **or** a user-picked ref (`refDirty`) **or** extras (`repos.length > 1`) **or** pipeline — merely opening the dialog/auto-selecting a ref does not prompt. PR dialog: `WorktreeOptions locked={{ branch: context.headRef, projectPath: context.path }}` renders a disabled locked Select Projects button (PR repo name), the read-only branch row and checked/disabled Isolate. Typecheck. | state, tests | Existing `GitHubDialog` mounts both (unchanged) |
| **T9** | Retire the base-ref carry helpers once refs live on the selection. | `src/mainview/lib/multi-repo-ui.ts`; `src/mainview/lib/multi-repo-ui.test.ts` | T7, T8 (same wave) | Delete `seedRepositoriesDialogValue`, `applyRepositoriesSave`, `InlineBaseRefChange` and their tests. Keep `mergeSelectionsByRoot`, `describeRootConflict` (copy now says “Remove one, or close and keep one base ref in the Branch rows.”), `createSessionGuard`. `bun test src/mainview/lib/multi-repo-ui.test.ts` green with the git-root merge/conflict/guard cases only. | tests | No production caller remains after T7/T8 |
| **T10** | Retire the collapse/pin helpers and their tests. | `src/mainview/lib/repo-selection.ts`; `src/mainview/lib/repo-selection.test.ts` | T7, T8 (same wave) | Delete `collapseToProject`, `pinPrimaryRepository` and their describes; the issue dialog no longer needs pinning because the dialog's `lockedPath` keeps the issue repo first and `mergeSelectionsByRoot` keeps the first path per root. Kept helpers (`dedupeSelections`, `selectionNames`, `repositoryFileScopes`, `taskProjectPath`, `issueProjectPath`, T1's additions) all still tested. | tests | No production caller remains after T7/T8 |
| **T11** | Delete the retired modules and retarget stale comments. | `src/mainview/components/kanban/ProjectPicker.tsx` (delete); `src/mainview/components/kanban/RepositoriesDialog.tsx` (delete); `src/mainview/components/kanban/BranchPicker.tsx` (comment); `src/mainview/components/kanban/CloneProjectDialog.tsx` (comment); `src/cli/commands/add.ts` (comment only) | T7, T8 (same wave) | Both files are gone; no file under `src` imports `./ProjectPicker` or `./RepositoriesDialog`; comments no longer claim `ProjectPicker` mounts the dialogs or that `WorktreeOptions` alone calls `onAutoSelect`; the CLI comment names `SelectProjectsDialog`. `bun run typecheck`. | none | — |
| **T12** | Add the new end-to-end spec for the combined control. | `e2e/select-projects.spec.ts` (new) | T4, T7, T8 | Scenarios: (a) one project → button shows its basename, Isolate enabled/checked, one `Branch · <name>` row; pick a **non-current** branch, Run, assert `workdir`/`isolation`/top-level `baseRef` sha and no multi flag; (b) two projects → `2 projects selected`, Isolate checked+disabled, two rows; pick a non-current ref in each, Run, assert `multiRepo` + `repositories[].baseRef` shas; (c) repo + sibling → after Save the label is the single project's name, Isolate enabled, task is single-repository; (d) outside click leaves the dialog open, Escape/Cancel close it; (e) search filters; (f) zero draft disables Save with the hint; (g) after a submit the button/rows keep the selection and refs while the branch name resets; (h) a registered **non-git** folder alone with Isolate unchecked creates with `workdir` = that folder and `isolation:"none"` (proves the single shape is never sent as `repositories[]`). | tests | Playwright |
| **T13a** | Update the clone, identifier, issue and resolve-conflicts specs to the new control. | `e2e/clone-project.spec.ts`; `e2e/clone-providers.spec.ts`; `e2e/identifier-inputs.spec.ts`; `e2e/issue-task.spec.ts`; `e2e/resolve-conflicts.spec.ts` | T4, T7, T8 | Clone specs open Select Projects first, then click `project-clone-open`; identifier-inputs opens the dialog and asserts the search box's four attributes (instead of the removed ProjectPicker trigger), and keeps the Branch/branch-name assertions on the single row; issue-task opens `select-projects-button`, asserts the issue row is checked/disabled and no “Manage” remains, adds an extra, saves, submits and still sees the issue-repo-first stored set; resolve-conflicts asserts the locked Select Projects button is visible/disabled with the PR repo name, plus the existing locked branch/isolate assertions. All five specs pass. | tests | Playwright |
| **T13b** | Rewrite the multi-repository spec's real-UI creation to the new flow. | `e2e/multi-repo-task.spec.ts` | T4, T7, T8 | `beforeAll` creates a non-current `topic` branch in repoA and repoB. Deterministic order: `chooseProjects` clears the auto-selected row then checks repoA, repoB, repoSibling in order; assert the dialog offers no base-ref inputs; Save → label `2 projects selected`; set `topic` in both inline rows (`selectBaseBranch`); assert isolate checked+disabled; Run and assert stored paths `[repoA, repoB]` and `repositories[*].baseRef` = each repo's `rev-parse topic`; sibling still dedupes away. The rest of the file's API-driven scenarios stay unchanged and pass. | tests | Playwright |
| **T13c** | Update the remaining specs that drive the old ProjectPicker trigger/search. | `e2e/cursor-stream.spec.ts`; `e2e/copilot-harness.spec.ts`; `e2e/copilot-harness-availability.spec.ts`; `e2e/speed-picker.spec.ts`; `e2e/fx-recovery.spec.ts`; `e2e/fx-interactions.spec.ts`; `e2e/opencode-harness.spec.ts` | T4, T7, T8 | Replace each local `selectProject` (old trigger title + `Search projects…` popover) with the shared helper; the registered-project setup and every task assertion stay unchanged; specs that rely on auto-select (`at-file-autocomplete`, `branch-scoped-capabilities`) are left alone and re-run by T15. All seven specs pass. | tests | Playwright |
| **T14** | Update every current doc that describes the old split. | `docs/specs/multi-repo-tasks.md`; `docs/architecture/multi-repo-tasks.md`; `docs/architecture/prompt-composer.md`; `docs/architecture/issue-tasks.md`; `docs/architecture/security.md`; `docs/architecture/clone-repository.md`; `docs/architecture/session-import.md`; `CLAUDE.md`; `README.md` | T7, T8, T9, T10, T11 | Spec §UI and multi-repo §Surfaces describe one Select Projects control (1+ selection, count label, per-project inline branch rows, Save dialog with search/management actions, dedupe, forced isolate, issue/PR variants). prompt-composer loses the base-ref carry and describes `selectionPayload` + `effectiveIsolate`; issue-tasks says the dialog uses the same control with the issue repo locked; security retargets the repo-root lookup to Select Projects; clone-repository and session-import point their Clone/Import entries at the Select Projects dialog; CLAUDE's topic map names `SelectProjectsDialog`; README's quick start says select one or more projects, last one preselected. | none | — |
| **T15** | Verify the final head and refresh this plan's claims. | `docs/plans/select-projects-combined.md` | T12, T13a, T13b, T13c, T14 | `bun run typecheck` clean; focused unit green; the affected Playwright files (T12/T13 + `at-file-autocomplete`, `branch-scoped-capabilities`, `agent-profiles-dialogs`, `multi-repo-task`) pass on the final tree; `rg` sweep shows no live references to `ProjectPicker`/`RepositoriesDialog`/`Use multiple repositories`/`collapseToProject`/`seedRepositoriesDialogValue`/`applyRepositoriesSave`/`wt.payload`/`variant="multi"` outside `docs/plans` history; update Status/actual counts and list any known flake. | tests | — |

## 5. Work breakdown — test tasks

Unit tests are colocated with the module they test (the repo convention) and are owned by the implementation task that changes that module, so no separate agent can collide on the file.

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| UT1 | unit | T1, T10 | `src/mainview/lib/repo-selection.test.ts` | Label 0/1/2+/dedupe; row collision labels; ref update; remaining helpers still covered; removed-helper describes gone. Must be shown red against a broken label/update (e.g. count before dedupe). |
| UT2 | unit | T2 | `src/mainview/lib/worktree-payload.test.ts` | 0/1/isolate-off/multi/dedupe/per-entry refs/top-level shape; existing `worktreePayload` cases still pass. Must be shown red if the single case emits `repositories` or the multi case emits top-level `baseRef`. |
| UT3 | unit | T9 | `src/mainview/lib/multi-repo-ui.test.ts` | Git-root merge keeps refs, detects conflicts, keeps unknown roots; guard invalidates; carry-helper describes gone. Must be shown red against a merge that drops the collapsed entry's ref. |
| ET1 | e2e | T3, T5, T6, T7 (via T12) | `e2e/select-projects.spec.ts`; helper additions in `e2e/helpers.ts` | SC1/SC2/SC3/SC4/SC5/SC6/SC7/SC9 scenarios above. Non-current refs are mandatory so a wired row is distinguishable from HEAD. |
| ET2a | e2e | T8 (issue + PR surfaces) | `e2e/clone-project.spec.ts`; `e2e/clone-providers.spec.ts`; `e2e/identifier-inputs.spec.ts`; `e2e/issue-task.spec.ts`; `e2e/resolve-conflicts.spec.ts` | SC8. |
| ET2b | e2e | T7/T8 multi payload | `e2e/multi-repo-task.spec.ts` | SC2/SC4/SC5 through the real form. |
| ET2c | e2e | project selection used by other flows | `e2e/cursor-stream.spec.ts`; `e2e/copilot-harness.spec.ts`; `e2e/copilot-harness-availability.spec.ts`; `e2e/speed-picker.spec.ts`; `e2e/fx-recovery.spec.ts`; `e2e/fx-interactions.spec.ts`; `e2e/opencode-harness.spec.ts` | The selection still reaches every harness flow. |

**E2e applicability:** applies — the change has user-visible flows through the real webview and crosses UI → API → DB on create. It is not a pure-library change.

**Run recipe:**

- App + services: `playwright.config.ts` starts Vite on `:5173` (`AGETOR_E2E_VITE_PORT` overrides); `e2e/fixtures.ts` provisions one headless Bun backend per worker with its own `AGETOR_DATA_DIR`, port, token and fake drivers. No credentials needed.
- Register projects with `POST /projects` (the native picker is not available headless). Create non-current branches with `git branch <name>` in the temp repos.
- Commands:
  - `bun node_modules/@playwright/test/cli.js test e2e/select-projects.spec.ts`
  - `bun node_modules/@playwright/test/cli.js test e2e/multi-repo-task.spec.ts e2e/issue-task.spec.ts e2e/resolve-conflicts.spec.ts e2e/identifier-inputs.spec.ts`
  - `bun node_modules/@playwright/test/cli.js test e2e/clone-project.spec.ts e2e/clone-providers.spec.ts e2e/cursor-stream.spec.ts e2e/copilot-harness.spec.ts e2e/copilot-harness-availability.spec.ts e2e/speed-picker.spec.ts e2e/fx-recovery.spec.ts e2e/fx-interactions.spec.ts e2e/opencode-harness.spec.ts`
  - Full: `bun node_modules/@playwright/test/cli.js test`
- Unit: `bun test src/mainview/lib/repo-selection.test.ts src/mainview/lib/multi-repo-ui.test.ts src/mainview/lib/worktree-payload.test.ts`; full `bun test` before the final sign-off.
- Every test must be shown able to fail: unit tests red against a deliberately broken helper; e2e specs red against the pre-change tree where the scenario exists, and the new spec red if the per-repo ref is not wired into the payload.

## 6. Execution waves

| Wave | Tasks (parallel, disjoint files) | Barrier state |
| --- | --- | --- |
| 1 | T1, T2, T3, T4 | Green: typecheck + focused unit. New exports exist but are not yet referenced by production code. |
| 2 | T5, T6 | Green: typecheck. New components exist but are not yet mounted. |
| 3 | T7, T8, T9, T10, T11 | `bun run typecheck` and `bun test` **green**; the app renders the new UI. **Known red:** Playwright specs that drive the removed ProjectPicker/Repositories UI — `clone-project`, `clone-providers`, `identifier-inputs`, `multi-repo-task`, `cursor-stream`, `copilot-harness`, `copilot-harness-availability`, `speed-picker`, `fx-recovery`, `fx-interactions`, `opencode-harness`, plus the issue/Manage and resolve-conflicts assertions in `issue-task`/`resolve-conflicts`. T12/T13a-c turn them green at barrier 4. This checkpoint is for resuming code work, not for merging. |
| 4 | T12, T13a, T13b, T13c, T14 | Green: every affected Playwright file passes and docs match. |
| 5 | T15 | Green: final verification recorded in this plan; full suite is the merge gate. |

**Delivery:** one PR. The change is one subsystem (webview task-creation UI) and CI requires the e2e updates alongside the code, so a stack would leave the intermediate PR knowingly red. Review it as two commits/checkpoints (waves 1–3 code + unit; waves 4–5 e2e + docs). If the owner wants smaller diffs, split at wave 3 only with an explicit “e2e red until the next PR” note — not recommended.

## 7. Invariants, runtime shape & risks

**Invariants**

- **Selection → payload** goes only through `selectionPayload` (`src/mainview/lib/worktree-payload.ts`). No form maps refs itself; both forms spread the result. New paths (retry, issue, PR) must call it.
- **2+ deduped projects ⇒ worktree isolation** is derived once: `multiRepo = dedupeSelections(repos).length > 1` feeds `useWorktreeOptions({ forceIsolate })`, and `selectionPayload` independently forces `isolation: "worktree"` for 2+. Neither reads the raw checkbox.
- **Count/label/forced isolate are post-dedupe** through `dedupeSelections` only. Unknown roots are kept (never silently dropped); the dialog resolves roots on Save.
- **At least one selection** is enforced at two named surfaces: the dialog's Save is disabled at zero, and each form's `canSubmit` requires `repos.length > 0`. No other path can create a task from the UI.
- **Auto vs. user ref** is distinguishable only in `useProjectSelection`: `setBaseRefAuto` never marks dirty; `setBaseRef` does. The issue dialog's discard prompt reads `refDirty`.
- **No new trust surface**: no route/schema/policy change; paths still originate from the project table or the native picker and are validated server-side at create.

**Runtime shape:** one Bun core, one webview, one SQLite DB. The dialog's root lookups are async and guarded by `createSessionGuard`; a Cancel/Escape/reopen drops the result. Branch-list fetches are tagged per workdir by `BranchPicker`, so removing/reordering rows cannot apply a stale list. No migration, no cross-instance concern, no background loop. Rollback = revert the UI; existing tasks keep their stored `repositories[]`.

**Blast radius:** three task-creation surfaces (`NewTaskForm`, `CreateTaskFromIssueDialog`, `ResolveConflictsDialog`); shared modules `WorktreeOptions`, `repo-selection`, `multi-repo-ui`, `worktree-payload`, `dialog`; 16 Playwright files; nine current docs. No CLI/TUI behavior change (`--repo` is already repeatable and has no visual picker).

**Cross-repo dependencies:** none.

## 8. Open questions / assumptions

Owner decisions are closed (grill record, 14/14). No unratified one-way-door decision: the change is reversible UI with no data migration, auth, money or public contract change. These assumptions are carried from the grill record; none blocks execution:

1. **Auto-selected refs.** Each `BranchPicker` preselects its repo's current branch; `onAutoSelect` keeps that out of `refDirty`, so opening the issue dialog never starts a “discard this draft?” prompt. *If wrong:* the dirty check over-prompts.
2. **Eager branch fan-out.** N rows fetch N branch lists. Fine at the expected 2–3; 10+ is a separate performance ticket (the >10 warning stays).
3. **Deduped count after Save.** The dialog footer keeps the raw `N selected` plus the “(some share a git root)” note; the button shows the deduped count. *If wrong:* move the dedupe into the footer too.
4. **Client `workdir` = first selected project.** It still drives the branch-name preview, `startingFolder` and the single `fileScope`; the server assigns the workspace root for 2+.
5. **Zero-state copy.** Button “Select projects…”, dialog title “Select projects”, search “Search projects…”. One-line change if the owner prefers different wording.
6. **No feature flag or migration.** Reverting the UI restores the old selectors; created tasks are unaffected.
7. **Management actions.** Add folder adds + selects; Clone/Import refresh the list without forcing a selection (today's `ProjectPicker` footer behavior). *If wrong:* the dialog needs a “select the new project” step.
8. **Same-root base-ref conflict is terminal in the dialog.** Because refs are edited inline, the dialog can only name the conflict and tell the user to remove one row or close and keep one inline ref. This is effectively unreachable from the UI (new draft rows start with no ref and Save dedupes), but the guard stays defensive. *If wrong:* a conflict-only ref input can be re-added.
9. **Project display name is the path basename**, matching today's `ProjectPicker` trigger (`displayValue`), not the registered `Project.name` slug. *If wrong:* one helper change to prefer the registered name.
10. **Save-time root lookup failure keeps `root: null`**, so the entry stays selected and fails at create rather than disappearing. Same as today.
11. **PR dialog shape:** the locked control is a disabled button showing the PR repo; no extra selection, branch read-only, isolate checked/disabled.
12. **Branch-only refs:** no tag/SHA UI (owner decision 6); the API/CLI escape hatch remains.

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| New selection helpers (label/row name/ref update) | in this run | T1 |
| Create-payload builder for 0/1/multi | in this run | T2 |
| `Dialog closeOnBackdrop` | in this run | T3 |
| Shared e2e selection helpers | in this run | T4 |
| `useProjectSelection` + `SelectProjectsButton` | in this run | T5 |
| `SelectProjectsDialog` (1+ selection, search, management actions, dismissal, no ref inputs) | in this run | T6 |
| `WorktreeOptions` live/locked row rework; `variant="multi"` removal | in this run | T7/T8 |
| `useWorktreeOptions` baseRef/payload removal, `forceIsolate`/`effectiveIsolate` | in this run | T7 |
| `NewTaskForm` state, scopes, `canSubmit`, submit payload, post-submit reset, JSX | in this run | T7 |
| `CreateTaskFromIssueDialog` seed/locked row/dirty check/payload/scopes | in this run | T8 |
| `ResolveConflictsDialog` locked control | in this run | T8 |
| `seedRepositoriesDialogValue` / `applyRepositoriesSave` + tests | in this run | T9 |
| `collapseToProject` + tests | in this run | T10 |
| `pinPrimaryRepository` (now guaranteed by `lockedPath` + root merge) + tests | in this run | T10 |
| `ProjectPicker.tsx` retirement + `autoSelectFirst` moved into the hook | in this run | T5/T11 |
| `RepositoriesDialog.tsx` retirement/rename | in this run | T6/T11 |
| Stale comments in `BranchPicker`, `CloneProjectDialog`, CLI `add.ts` | in this run | T11 |
| Unit tests: label/rows/ref update; payload; merge/guard | in this run | UT1/UT2/UT3 (T1/T2/T9) |
| New e2e spec: 1 project, 2 projects + stored refs, dedupe, isolate, dismissal, search, zero, persistence | in this run | T12 |
| 13 Playwright specs: the 11 that drive the old ProjectPicker trigger/search (including the 2 clone specs and multi-repo) + issue-task + resolve-conflicts | in this run | T13a/T13b/T13c |
| Issue-dialog locked row + extras e2e | in this run | T13a |
| PR-conflict locked control e2e | in this run | T13a |
| Spec, architecture docs, prompt-composer, issue-tasks, security, clone-repository, session-import, topic map, README | in this run | T14 |
| `at-file-autocomplete`, `branch-scoped-capabilities`, `agent-profiles-dialogs` re-verify | in this run | T15 (no edit expected) |
| Final claim refresh (status, counts, grep sweep) | in this run | T15 |
| CLI/TUI `--repo` behavior | out of scope | Already repeatable; no visual picker to combine and no server contract change |
| Tag/SHA UI entry | out of scope | Grill decision 6; API/CLI escape hatch remains |
| New “Work on this PR with Agetor” entry | out of scope | Grill decision 4 did not select it; separate feature |
| Multi-repo conflict tasks (extra repos on the PR side) | out of scope | Grill decision 4 chose locked-only; the server rejects `existingBranch` for 2+ (`orchestrator.ts:12518-12519`) |
| Client-side blocking of a non-git folder in a 2+ selection | out of scope | Pre-existing create-time validation (server 400); not introduced by this consolidation |
| Lazy/bounded branch-list loading for 10+ projects | out of scope | Expected 2–3; the >10 warning stays; separate performance ticket |
| Historical `docs/plans/multi-repo-tasks*.md` records | out of scope | Historical records are not rewritten; the grill record supersedes decision 16 |

## 10. Execution record (2026-11-13)

All 15 tasks and every unit/e2e test group in §5 were implemented on `fix/agetor-multiple-repo-task` from base `41d2692d`. No plan change, no unratified decision, no out-of-scope code.

| Task | Outcome |
| --- | --- |
| T1 | `projectDisplayName`, `projectSelectionLabel`, `projectRowLabels`, `updateSelectionBaseRef` in `src/mainview/lib/repo-selection.ts`; `collapseToProject`/`pinPrimaryRepository` removed with their tests (T10). |
| T2 | `selectionPayload` in `src/mainview/lib/worktree-payload.ts`; the single case delegates to the retained `worktreePayload`, so that mapping still has a production caller. |
| T3 | `Dialog closeOnBackdrop` (default `true`), `SelectProjectsDialog` passes `false`. |
| T4 | `openSelectProjects`, `chooseProjects`, `selectProject`, `branchRow`, `selectBaseBranch` in `e2e/helpers.ts`. |
| T5 | `useProjectSelection` + `SelectProjectsButton` in `ProjectSelection.tsx` (auto-select, post-dedupe `multiRepo`, per-entry refs, `refDirty`/`resetRefDirty`; the label is derived at the render site with `projectSelectionLabel`). |
| T6 | `SelectProjectsDialog.tsx`: 1+ selection, search (name/path), Add folder/Clone/Import, recheck restores root/ref, Save root merge + conflict, session guard, no backdrop dismissal. |
| T7 | `WorktreeOptions` live/locked rewrite; `useWorktreeOptions` takes `forceIsolate`, exposes `effectiveIsolate`, drops baseRef/`payload()`; `NewTaskForm` uses the selection hook + `selectionPayload`; old Project/Repositories UI deleted. |
| T8 | Issue dialog seeded/locked issue repo via the same control/payload (`refDirty` drives its dirty check); PR dialog locked `{ branch, projectPath }` with checked/disabled Isolate. |
| T9 | Base-ref carry helpers + tests deleted; `describeRootConflict` copy now points at the Branch rows. |
| T10 | Collapse/pin helpers + tests deleted. |
| T11 | `ProjectPicker.tsx` / `RepositoriesDialog.tsx` deleted; stale comments retargeted (`BranchPicker`, `CloneProjectDialog`, CLI `add.ts`). |
| T12 | `e2e/select-projects.spec.ts` — 11 scenarios (one, two + per-row Pull/Fetch + dialog entries, basename collision labels, uncheck-Isolate → 2+ → collapse, dedupe, dismissal, focused search, zero draft, persistence, non-git folder, form-side at-least-one guard). |
| T13a-c | `identifier-inputs`, `issue-task`, `resolve-conflicts`, `multi-repo-task` + the seven harness specs / two clone specs moved to the shared control and helpers. |
| T14 | Spec and architecture docs (`multi-repo-tasks`, `prompt-composer`, `issue-tasks`, `security`, `clone-repository`, `session-import`), `CLAUDE.md` topic map and `README.md` quick start updated. |
| T15 | This record; verification below. |

**Verification**

- `bun run typecheck` → clean, final tree.
- `bun test src/mainview/lib/repo-selection.test.ts src/mainview/lib/multi-repo-ui.test.ts src/mainview/lib/worktree-payload.test.ts` → 67 pass / 0 fail.
- Red proofs (temporarily broken helper, then restored): UT1 red when the label counts before dedupe; UT2 red when the single case emits `repositories[]` (and the isolate-off case breaks); UT3 red when the root merge drops a collapsed entry's ref.
- `bun node_modules/@playwright/test/cli.js test e2e/select-projects.spec.ts` → 10/10 pass (includes the collapse-to-one and form-side guard cases added in the review round).
- `… test e2e/multi-repo-task.spec.ts e2e/issue-task.spec.ts e2e/resolve-conflicts.spec.ts e2e/identifier-inputs.spec.ts` → 35/35 pass as one parallel batch on the final tree.
- `… test e2e/clone-project.spec.ts e2e/clone-providers.spec.ts e2e/cursor-stream.spec.ts e2e/copilot-harness.spec.ts e2e/copilot-harness-availability.spec.ts e2e/speed-picker.spec.ts e2e/fx-interactions.spec.ts e2e/opencode-harness.spec.ts` → all pass (one fx-recovery countdown test timed out once under the full batch, then passed 15/15 on its own — a load flake, not the selection UI).
- `… test e2e/at-file-autocomplete.spec.ts e2e/branch-scoped-capabilities.spec.ts e2e/agent-profiles-dialogs.spec.ts` → 21/21 pass (no edits needed).
- Full `bun test` → 13,375 pass / 32 skip / 2 fail; both failures were `beforeEach`/`afterEach` hook timeouts in `orchestrator-hold-scope-claim.test.ts` and `orchestrator-harness-switch-now.test.ts`, and both files pass 46/46 when run alone. Known flake, unrelated to this change (no orchestrator code touched).
- `rg` sweep: no live reference to `ProjectPicker`, `RepositoriesDialog`, `Use multiple repositories`, `collapseToProject`, `pinPrimaryRepository`, `seedRepositoriesDialogValue`, `applyRepositoriesSave`, `wt.payload`, `variant="multi"` or `new-task-repositories`/`issue-repositories` outside `docs/plans` history. `Search projects…` survives only as the Select Projects dialog's search placeholder (and two unrelated filter bars).
- `quality_gates.py wiring --worktree` → 10 new exports, 0 not reached; `hygiene --worktree` → no leads after restructuring two floating-promise call sites.

### 10.1 Review-round fixes (2026-11-13)

The code review of `459f2c27` found no behavior defect; these follow-ups landed on top of it:

- **Committed the planning record.** `select-projects-combined-grill.md`, its two `round-*/answers.json` files and `select-projects-combined-investigation.md` were untracked although §2.1 cites them as committed; all three are in the commit now.
- **Missing coverage added to `e2e/select-projects.spec.ts`.** A collapse test (2 projects → Isolate checked+disabled → save back to 1 → still checked, enabled, editable, branch-name field follows) and a form-side guard test on a test-scoped `freshBackend` with zero projects (title+prompt filled, `Select projects…` + hint shown, To backlog and Run task both disabled).
- **Stale pointers retired.** `api.ts`, `route-policy.ts`, `server.ts` and `multi-repo-ui.test.ts` say Select Projects instead of the deleted Repositories dialog; `issue-task.spec.ts` says `refDirty`; the `identifier-inputs` test title/comment names the Select Projects search box.
- **Add folder starts at the current project.** `SelectProjectsDialog` passes the first selected path to `api.pickProject`, matching the retired picker's `value` behavior.
- **Stale per-path ref markers pruned.** `useProjectSelection` drops `userRefPaths` entries whose project left the selection, so remove-then-re-add can't read as dirty on a fresh ref.
- **Core-four batch re-run on the final tree** → 35/35 in one parallel batch under `retries: 0` (the earlier 35/35 claim was retracted and is now backed by this run); typecheck clean and focused unit 67/67 re-run after the fixes.

### 10.2 Second review-round fixes (2026-11-13)

The re-review of `fd02ea3b` found no blockers; these should-fix items and nits landed on top of it:

- **R-S1 — branch rows are labelled with the project, not the workspace slug.** `WorktreeOptions` now renders `Branch · <projectRowLabels[i]>`: the project's basename, with the full path appended when two selected projects share one, matching grill decision 11 and the dialog's own rows. `data-testid="branch-row-<workspace slug>"` keeps the sanitized, collision-safe ids (`api`, `api-2`) that `e2e/helpers.ts` addresses. A new e2e scenario registers two repositories whose basename both are `api` on a test-scoped `freshBackend` and asserts both path-disambiguated labels plus distinct test ids; it is red against the previous slug label (verified).
- **R-S2 — the collapse scenario now proves the forced-on effect.** It unchecks Isolate on one project first (`branch-name-input` gone), goes to two (checked + disabled), then saves back to one and asserts checked + editable. Deleting `if (forceIsolate) setIsolate(true)` now turns it red (verified); the previous default-path version stayed green because the raw toggle was already true.
- **Dialog focus.** `SelectProjectsDialog` passes `initialFocusRef` so the cursor lands in the search box on open; the search scenario asserts it.
- **No stale-draft window during Save.** While a Save's git-root lookup is in flight, the row checkboxes, remove buttons, Add folder, Clone repository and Import sessions controls are disabled and `toggle`/`addFolder`/`save` ignore re-entry, so the resolved snapshot cannot be overwritten by a late edit. Save is also disabled while the native folder picker is open.
- **Dead state removed.** `useProjectSelection` no longer exposes the unused `label`; callers derive it with `projectSelectionLabel` at the render site (pinned interface above updated).
- **Coverage nits closed.** The two-project scenario asserts each row's own Pull and Fetch and that the dialog hosts Add folder / Clone repository / Import sessions; the search scenario asserts initial focus.
- **README corrected.** Quick start says the most recently added project is preselected (`/projects` is `ORDER BY added_at DESC`), not "the last one you used".
- **Re-verified on the final tree:** typecheck clean; focused unit 67/67; `e2e/select-projects.spec.ts` 11/11; core-four batch (multi-repo-task, issue-task, resolve-conflicts, identifier-inputs) 35/35 under `retries: 0`.

### 10.3 Test-writer round (2026-11-13)

The write-tests step added coverage for behavior that the implementation rounds had only exercised by hand or left to the dialog's internals:

| Layer | File | Added |
| --- | --- | --- |
| unit (new) | `src/mainview/components/kanban/ProjectSelection.test.tsx` | `SelectProjectsButton` label 0/1/2, full-width dialog trigger, explicit `disabled`, and the locked variant (disabled, lock icon, no chevron, PR-repo title). |
| unit (new) | `src/mainview/components/kanban/WorktreeOptions.test.tsx` | Button-before-Isolate order; zero/one/many-selection renders; `Branch · <project>` rows with `branch-row-<slug>` ids (including basename collisions); forced+disabled Isolate read from `effectiveIsolate` while the raw toggle is still false; isolate-off hides the branch name; the locked PR variant (repo name, read-only branch, checked+disabled Isolate). |
| unit | `repo-selection.test.ts` | `3 projects selected` count case. |
| unit | `worktree-payload.test.ts` | `selectionPayload` never mutates the live selection. |
| e2e | `e2e/select-projects.spec.ts` | (j) Cancel discards the draft and reopening reseeds from the saved selection; (k) uncheck→recheck inside one dialog keeps a project's non-current base ref and it reaches `repositories[].baseRef`; (l) each row's Pull/Fetch POSTs that project's own path (repoB gets a bare origin so Pull is enabled); (m) a Save in flight disables the rows/remove/Add folder until the gated `/projects/repo-root` completes; (n) Add folder opens at the current selection and selects the added project. |
| e2e | `e2e/issue-task.spec.ts` | A user-picked base ref in the issue dialog's inline row makes the draft dirty (`refDirty`), so “Manage pipelines…” asks before discarding; cancelling keeps the pick. The existing clean-draft case already pins the automatic current-branch seed as *not* dirty. |

**Verification:** `bun run typecheck` clean; focused unit 81/81 across the five files; `e2e/select-projects.spec.ts` 16/16 with `--retries=0`; the new `issue-task` scenario passes on its own. Red proofs (mutation, then restored): slug-labelled rows and a non-disabled locked button each turn the new unit tests red; a hard-coded 2-project label turns the 3+ case red; a collapsed recheck that rebuilds `{path, root:null}`, a row wired to `repos[0]`, a checkbox that ignores `busy`, `pickProject()` without the starting folder, a removed re-seed, and `refDirty` forced to `false` each turn their e2e scenario red. `quality_gates.py hygiene --worktree` → 0 leads.

### 10.4 Test-loop verification (2026-11-13)

Full-suite run of the whole tree at `755b2c71`. **No product or test defect was found; no code or test was changed in this round.**

| Layer / gate | Command | Result |
| --- | --- | --- |
| Typecheck | `bun run typecheck` | clean |
| Focused unit | `bun test ProjectSelection.test.tsx WorktreeOptions.test.tsx repo-selection.test.ts multi-repo-ui.test.ts worktree-payload.test.ts` | **81 pass / 0 fail** |
| Full unit | `bun test --reporter=junit` | **13,390 pass / 32 skip / 1 fail** of 13,423 in 529 files; the one failure is the `orchestrator-hold-scope-claim.test.ts` **afterAll** hook hitting Bun's 5 s hook timeout (its single test passed). The file passes 1/1 alone, `src/bun` is untouched apart from comments, and the same hook timeout is the pre-existing full-suite flake recorded in §10 — environment load, not behavior. The 32 skips are the existing real-binary/`AGETOR_REAL_*` gates, unchanged from the base run. |
| Full e2e | `bun node_modules/@playwright/test/cli.js test --workers=3` | **492 passed / 0 failed** (14.0 min, `retries: 0`) |
| Affected e2e batch | `… select-projects multi-repo-task issue-task resolve-conflicts identifier-inputs --workers=2` | **52/52 pass** (1.8 min) |
| Adjacent e2e batch | `… at-file-autocomplete branch-scoped-capabilities clone-project clone-providers agent-profiles-dialogs cursor-stream copilot-harness copilot-harness-availability speed-picker fx-recovery fx-interactions opencode-harness --workers=2` | **86/87 pass**; the one failure was `speed-picker` "Task details (cursor)…" timing out under a machine-load spike (load avg 40+ from unrelated processes), re-ran green alone (7.1 s) and the whole file green **13/13**. |
| Flake re-runs | `… multi-repo-task.spec.ts --workers=1`; `… speed-picker.spec.ts --workers=1` | **11/11** and **13/13** — both files that failed during the load spike pass on a clean re-run. Two earlier full-suite attempts under load average 35–59 produced only worker-starvation timeouts (whole files at exactly their per-test timeout); the low-load run above is the reported result. |
| Static gates | `quality_gates.py wiring --worktree` / `hygiene --worktree` | 10 new exports, **0 not reached**; **0 hygiene leads** |

No flaky *product* path surfaced: every rerun of the feature's own specs (`select-projects`, `multi-repo-task`, `issue-task`, `resolve-conflicts`, `identifier-inputs`) was green under `retries: 0`.

### 10.5 Owner revision: branch pickers move into the dialog (2026-11-13)

Reviewing the screenshots, the owner reversed grill decision 1: each selected project's branch picker, Pull and Fetch now sit **inside the Select Projects dialog**, under that project's checked row, instead of as inline rows in the form. Decision 1 is marked superseded in the grill record; decision 5's listing survives as a read-only summary in the form.

| Area | Change |
| --- | --- |
| `SearchSelect` / `BranchPicker` | New `placement="inline"`: the panel renders in flow under its trigger (still `data-popover-open` while open, still closes on Escape) and scrolls itself into view. It is the only placement the dialog's scrolling project list can't clip — the reason decision 1 kept the rows out of the dialog. `triggerTestId` (`branch-picker-trigger`) for e2e. |
| `SelectProjectsDialog` | Every checked row renders a `BranchPicker` (label `Branch`, Pull, Fetch) with `placement="inline"`. Base refs are part of the draft: Save applies them, Cancel discards them; uncheck → recheck restores the opening ref and its pick marker. The pickers' automatic current-branch seed is tracked apart from user picks and **dropped on Save** (`keepUserPickedRefs`, applied before `mergeSelectionsByRoot`), so a seed can never conflict with a pick on the same root or be saved as one. `BASE_REF_TITLE` / `BASE_REF_OFF_TITLE` moved here. List height `min(60vh, 100vh − 18rem)`. |
| `useProjectSelection` | `setBaseRef`, `setBaseRefAuto`, `resetRefDirty` and the user-pick marker set are gone: refs only arrive through Save and every saved ref is a pick, so `refDirty` is simply "any selected project has a base ref". |
| `WorktreeOptions` | The inline `BranchPicker` rows are replaced by one read-only `Branch · <project>` line per project (saved ref or "current branch", `branch-row-<slug>` ids kept), inside a button that reopens the dialog. Labels truncate with a path tooltip, which also fixes the review finding that a long same-name label overflowed the sidebar. |
| Payload | Unchanged mapping. An untouched project now sends no `baseRef` instead of its current branch name; the server resolves both to the same HEAD sha. |
| Tests | Unit: `SelectProjectsDialog.test.tsx` (new; picker per checked row, saved ref shown, tooltip vs Isolate, locked row, entries), `keepUserPickedRefs` cases in `multi-repo-ui.test.ts`, branch-summary cases in `WorktreeOptions.test.tsx`. E2E: helpers `dialogBranchPicker` / `pickDialogBranch`, `selectBaseBranch` now picks in the dialog and saves; `select-projects` gains (o) Cancel discards a pick, (p) the seed is not saved (summary "current branch", HEAD sha stored), (q) the branch list is never clipped and Escape closes it before the dialog; `multi-repo-task`, `issue-task`, `identifier-inputs`, `branch-scoped-capabilities` drive the dialog pickers. |
| Docs | `docs/architecture/multi-repo-tasks.md`, `docs/specs/multi-repo-tasks.md`, `docs/architecture/prompt-composer.md`, `docs/architecture/issue-tasks.md`, README quick start. |

**Verification:** `bun run typecheck` clean (includes `e2e/`); `bun test src/mainview` 2,252/2,252; `e2e/select-projects.spec.ts` 19/19; affected e2e batch (`select-projects`, `multi-repo-task`, `issue-task`, `resolve-conflicts`, `identifier-inputs`, `branch-scoped-capabilities`, `--workers=2`, `retries: 0`) **58/58** on the final tree. Red proofs (mutation, then restored): a floating (`bottom`) picker in the dialog fails (q); saving the draft without `keepUserPickedRefs` fails (p).

### 10.6 Review follow-ups: same-name labels and the dialog backdrop (2026-11-13)

- **Same-name labels keep the part that differs.** `projectRowLabels` used to append the full path on a basename collision; in the narrow form the truncated label showed only the shared prefix (`api — /var/folders/w…` twice). It now uses the fewest trailing folders that are unique among the colliding paths (`billing/api`, `identity/api`; full path only when no shorter suffix is unique, e.g. `/api` vs `/x/api`). Grill decision 11 is annotated. Unit cases in `repo-selection.test.ts` (long shared prefix, three-way collision, full-path fallback, trailing slash) and `WorktreeOptions.test.tsx`; the e2e collision scenario asserts `<parent>/api` and the full-path tooltip.
- **"The board shifts when a dialog opens" was the backdrop, not the board.** Measured in Chromium: the overlay's box was `top 12px, height viewport − 12px`. `Dialog` renders inline, and `WorktreeOptions`' `space-y-3` sibling rule (`> :not([hidden]) ~ :not([hidden]) { margin-top: .75rem }`) applied to the `fixed inset-0` overlay, leaving a 12px strip of the page uncovered above the backdrop (the light band in the captures; an element screenshot of the dialog cropped from y=12, which read as a shift). It predates this branch (the old Repositories dialog sat in a spaced column too) and also hit `BranchNamingDialog`. Fix: the overlay carries `!m-0`. `e2e/select-projects.spec.ts` (d) asserts the backdrop's box equals the viewport; red without the fix (`y: 12`). The document itself never scrolled (`scrollY` 0 throughout); a transient 3px overflow of the main column during first paint settles within a second and is unrelated.

