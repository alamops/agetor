# Investigation — Combined single/multi project selection ("Select Projects")

| Field | Value |
| --- | --- |
| Date | 2026-11-13 |
| Change | Replace New Task's two project selectors (the single `ProjectPicker` plus the separate `Repositories` → "Use multiple repositories…" dialog) with one full-width **Select Projects** control, show the selected count on it, give every selected project the same branch-picker / Pull / Fetch row the single project has today, and force + disable Isolate for 2+ projects. This brief tells `grill` and `write-plan` what the current UI/state/payload contract is, which constraints are load-bearing, and which decisions only the owner can make. |
| Agents | 1 (inline; this step prohibits subagents) |
| Flags | none |
| Baseline | `41d2692d` on `fix/agetor-multiple-repo-task`; `HEAD == origin/main`; working tree clean. Bun 1.3.10, TypeScript 5.9.3, Playwright 1.62.1, git 2.54.0. |
| Web | `websearch` was unavailable (cancelled by the tool layer). One live reference was fetched: shadcn/ui's Combobox docs (multi-select = combobox + chips; count/label in the trigger). The stronger local precedent is `MultiSearchSelect` below. |

## 1. What we know

### 1.1 The ask and the current screen

The attached screenshot (outside the repo) shows New Task's project section, top to bottom:

1. `Project` label + single-select `SearchSelect` showing `renoverse-infra`.
2. `Branch` label + the current branch + `Pull` / `Fetch`.
3. `Isolate (worktree)` checkbox (checked).
4. `Branch name` input (`fix/7a0345`) with the naming-settings gear.
5. `Repositories` label + a full-width outline button **"Use multiple repositories…"**.

The owner wants (task text, verbatim intent):

- one full-width **Select Projects** button in New Task, on top of the Isolate checkbox;
- at least one selection;
- the number of selected projects in the button label, "just like currently";
- **per selected project**, the branch picker + Pull + Fetch that one project has today;
- when more than one is selected, Isolate is **disabled and auto-checked**.

The closest existing contract is `docs/specs/multi-repo-tasks.md` (UI section `:126-129`) and its architecture contract `docs/architecture/multi-repo-tasks.md` (`:471-482`). Both currently specify the exact split the owner now wants removed: one repo keeps the inline project/branch fields; 2+ uses the shared `Repositories` dialog and no inline per-repo branch inputs. This request supersedes that part of issue #291's decision 16 (`docs/plans/multi-repo-tasks-grill.md:39`). The new decision record must say so explicitly.

### 1.2 Current state and data flow (New Task)

`src/mainview/components/kanban/NewTaskForm.tsx`:

- `workdir` is the single selected project path (`:247`); `repos: RepoSelection[]` mirrors it and holds the multi set (`:250`); `multiRepo = repos.length > 1` (`:252`).
- An effect copies `workdir` into `repos` when the latter is empty (`:255-257`).
- `useWorktreeOptions({ workdir, title, taskType })` owns `isolate`, the single `baseRef`, the branch-name field and the per-project branch-naming config (`:262`).
- A 2+ selection force-sets `wt.isolate = true` (`:267-270`). It is a state effect, so the checkbox can be false for one render before it flips.
- `fileScope` for the `@` popover / capability discovery is `{ dir: workdir, ref: isolate ? (wt.baseRef || "HEAD") : null }` (`:320-323`); multi uses `repositoryFileScopes(repos, isolate)` (`:326-329`).
- `canSubmit` requires `title && prompt && workdir && repos.length > 0 && wt.valid` (`:646-648`); `wt.valid` is `!isolate || branchValidation.ok` (`WorktreeOptions.tsx:187`).
- Submit (`:650-722`):
  - multi: `isolation: "worktree"`, the shared `branch`, and `repositories: repos.map(({path, baseRef}) => …)` (`:667-676`);
  - single: `wt.payload()` → `worktreePayload` maps `isolate`/`baseRef`/`branch` (`src/mainview/lib/worktree-payload.ts:33-39`).
- JSX Project block (label + `ProjectPicker`, `:865-882`), `WorktreeOptions` (`:883`), then the `Repositories` block (`:884-934`): a "N repositories" summary + Manage when multi, else the "Use multiple repositories…" button (disabled until `workdir`).
- `ProjectPicker` (`src/mainview/components/kanban/ProjectPicker.tsx`) is a single-value `SearchSelect`; `autoSelectFirst` promotes `projects[0]` (most recently added/upserted) on load (`:67-76`). Its footer has Browse for folder / Clone repository / Import sessions (`:118-148`), and it mounts `CloneProjectDialog` + `ImportSessionsDialog` as siblings (`:153-162`).
- `ProjectPicker` has exactly one product caller: `NewTaskForm` (`:54`, `:867`).

`WorktreeOptions.tsx`:

- `useWorktreeOptions` owns `isolate` (default `true`, `:104`), `baseRef` (`:105`), branch config fetch (`:135-143`), branch field/validation (`:166-187`), `payload()` (`:189`), and resets (`:193-204`).
- The live component renders one `BranchPicker` (`:315-329`), the isolate checkbox (`:331-345`), and (while isolated) the branch-name field + `BranchNamingDialog` (`:355-409`).
- `variant="multi"` currently **hides both** the branch picker and the isolate checkbox (`:292-293`, `:315`, `:331`) and shows a paragraph explaining isolation is always on (`:347-353`). That is exactly the UI the new ask says to change.

`RepositoriesDialog.tsx`:

- Props: `open`, `onClose`, `value: RepoSelection[]`, `onSave`, `lockedPath?` (`:18-28`).
- Draft is re-seeded from `value` on each open (`:71-81`); the list is every registered project plus draft extras (`:99-106`), in a `max-h-72 … overflow-y-auto` box (`:201`).
- A per-repository base-ref text `Input` is shown **only** when the deduped draft is 2+ (`:89-90`, `:229-241`); for one repo it says "Branches from the Branch field's base ref." (`:238-240`).
- Save resolves each path's git root via `api.getProjectRepoRoot` (`:146-163`), then `mergeSelectionsByRoot` dedupes by root and detects two different base refs on one root (`:166-173`); Save is disabled at zero (`:282`). The footer shows `{draft.length} selected` (`:276`).
- Callers: `NewTaskForm` (`:55`, `:912`), `CreateTaskFromIssueDialog` (`:19`, `:428`).

Base-ref carry between the inline picker and the dialog is implemented by `seedRepositoriesDialogValue` / `applyRepositoriesSave` (`src/mainview/lib/multi-repo-ui.ts:27-78`) and `collapseToProject` (`src/mainview/lib/repo-selection.ts:117-126`). This entire carry exists only because one repo's base ref lives in `useWorktreeOptions` and 2+ live in the dialog; a design where every selected project owns a base ref makes it mostly obsolete.

### 1.3 The payload and server contract (read, not changed)

- `POST /tasks` takes `workdir` plus optional `repositories: [{ path, baseRef? }]`; `createTask` treats a **1-entry** `repositories` selection through the ordinary single-repo path and lets that entry's `baseRef` win (`src/bun/orchestrator.ts:12521-12542`).
- A **2+** selection requires `isolation: "worktree"`, rejects `existingBranch`, dedupes by git root (`src/bun/task-repos.ts:59-66`), resolves each entry's base ref to a sha, mints one shared branch name per repo (with per-repo `-N` fallback), and assigns `workdir` to the per-task workspace root (`orchestrator.ts:12514-12520`, `12559-12578`, `12841-12865`).
- A single *non-git* folder is allowed with `isolation: "none"`; sending it as `repositories: [{path}]` is **rejected** ("not inside a git repository", `task-repos.ts:59-63`). So the client must keep the old single-repo payload shape (`workdir` + top-level `baseRef`) when exactly one project is selected.
- `Project` (`src/shared/types.ts:6775`) and `BranchInfo` (`:6795`) already carry everything the picker needs. `/projects/branches`, `/projects/fetch`, `/projects/pull` are existing routes (`src/mainview/lib/api.ts:1031-1049`); `BranchPicker` already calls them for any `workdir` (`BranchPicker.tsx:77-159`).
- **No server, schema, migration, route-policy or data change is required.** The whole change is webview state/UI, plus tests and docs.

### 1.4 The shared issue-dialog surface

`CreateTaskFromIssueDialog.tsx` uses the same `useWorktreeOptions`/`WorktreeOptions` and the same `RepositoriesDialog` (`:84-104`, `:414-451`). Its issue repo is always first and locked in the dialog (`:436`, `lockedPath`), extras are pinned through `pinPrimaryRepository` (`:445`), and its "discard this draft?" check treats `!wt.isolate` / `wt.baseRefDirty` / `wt.branchDirty` / `launch.pipelineId` as dirty (`:214-221`). If the branch picker moves out of `WorktreeOptions` (or the dialog owns base refs), that dirty check needs a replacement signal, or a base-ref-only edit stops prompting before "Manage pipelines…" discards it.

The repo's stated convention is panel/modal parity (`docs/architecture/issue-tasks.md:19`: the issue dialog sends `isolation`/`baseRef`/`branch`/`references` "exactly like the panel"). Leaving the issue dialog on the old two-selector UI while New Task gets the combined one would either fork the shared `RepositoriesDialog` or make that doc false.

### 1.5 UI primitives and hard constraints

- `SearchSelect` is a trigger + an **absolutely positioned** popover (`src/mainview/components/ui/search-select.tsx:140-149`). `MultiSearchSelect` is its multi-select sibling; its trigger label is already **single item's label, or `"<n> selected"`** (`src/mainview/components/ui/multi-search-select.tsx:99-107`). This is the closest in-repo precedent for "the number of selected shows in the label".
- **Popover clipping is a real constraint.** `SearchSelect`'s popover is `absolute`, so any ancestor with `overflow-y-auto`/`overflow-hidden` clips it. The RepositoriesDialog list is `max-h-72 overflow-y-auto` (`RepositoriesDialog.tsx:201`), and the New Task form is inside `flex-1 … overflow-y-auto` (`NewTaskForm.tsx:829`). Putting a `BranchPicker` inside the dialog's current scrolling row list would clip its branch popover — its list alone allows `max-h-64` (256 px) plus a search header and the trigger row, inside a 288 px scroll box. Any design that puts branch pickers inside a scrollable dialog needs a fixed/portal popover or a non-clipping layout. This is determinism, not a guess, but it is the main reason the placement decision below is load-bearing.
- The repo rule for overlays: an overlay positioned `fixed` portals to `document.body`; a transformed ancestor rebases it (`CLAUDE.md:113`). Any new portal must also uphold the `data-popover-open` / Escape contract (`CLAUDE.md:112`, `dialog.tsx:96-153`).
- `BranchPicker` (`src/mainview/components/kanban/BranchPicker.tsx`) is already generic: `workdir`, `value`, `onChange`, `onAutoSelect`, `label`, `title`, `placement`, `disabled` (`:7-31`). It auto-selects the repo's current branch when `value` is empty (`:182-189`) — the same behavior the single New Task picker has today. `onAutoSelect` is the seam that lets a caller distinguish that programmatic seed from a user pick (used today by the issue dialog's dirty check).
- `BranchPicker` can only pick an **existing branch row**; it cannot type a tag or SHA. The 2+ Repositories dialog currently offers a free-text `Input` (`:230-236`), so replacing it with `BranchPicker` loses tag/SHA entry (the server still accepts any ref via API/CLI). Parity with the single project means branch-only is acceptable, but it is a user-visible reduction worth confirming.
- Each `BranchPicker` eagerly calls `GET /projects/branches` on mount. N selected projects means N branch-list requests; the webview has ~6 connections per host and two permanent SSE streams (`CLAUDE.md:107`). For the usual 2–3 projects this is fine; for a 10+ selection it is a scheduling issue. No existing bounded pool is wired for this (the `@` scopes use `MULTI_SCOPE_CONCURRENCY = 2`, `docs/architecture/multi-repo-tasks.md:490-492`).
- `RepositoriesDialog`'s current base-ref `Input` does **not** spread `IDENTIFIER_INPUT_PROPS`; `SearchSelect`/`BranchPicker` search inputs do. Any new search/ref input must spread the identifier props (`CLAUDE.md` UI conventions; `e2e/identifier-inputs.spec.ts`).
- Existing test ids/labels that e2e depends on: `worktree-options`, `isolate-toggle`, `branch-name-input`, `new-task-repositories`, `Use multiple repositories…`, the ProjectPicker trigger title `"Pick the working directory the agent runs in. Add new ones with the folder picker at the bottom of the list."`, and the branch picker title `"Base ref the worktree branches from. Pick the current branch row to use what's checked out at task start."`.

### 1.6 Standards that apply

| Rule | Path | Consequence |
| --- | --- | --- |
| Update the subsystem doc in the same change. | `CLAUDE.md:5` | `multi-repo-tasks.md`, `prompt-composer.md`, `issue-tasks.md`, the spec's UI section, the topic map and the security doc's "Repositories dialog" mentions must move with the code. |
| Popover inside a dialog carries `data-popover-open` only while open and closes on Escape. | `CLAUDE.md:112`, `docs/architecture/prompt-composer.md` | Any branch/project picker moved into a dialog must keep the contract. |
| Fixed overlay portals to `document.body`; transformed ancestors rebase it. | `CLAUDE.md:113` | A portal-based picker is the robust fix for scroll clipping if branch pickers live in the dialog. |
| No new raw spawn / route / path-bearing field. | `CLAUDE.md:88-90` | No server change; reuse `/projects/branches|fetch|pull|repo-root`. |
| Server-managed task columns stay server-managed. | `CLAUDE.md:99` | `repositories` remains a create payload; the UI never PATCHes it. |
| Semantic color tokens only. | `CLAUDE.md:172` | Any new warning/error copy uses `text-warning`/`text-destructive` etc. |
| `src/shared/` has no runtime imports from either process. | `CLAUDE.md:102` | New pure helpers belong in `src/mainview/lib/` or `src/shared/` only if both sides need them. |
| E2E is real-DOM/real-backend, per-worker backend. | `playwright.config.ts:1-31`, `e2e/fixtures.ts` | UI coverage is Playwright, not a component harness. There are **no unit tests that render `NewTaskForm`** — a naive button-only change keeps `bun test` green. |

### 1.7 Runtime & trust shape

- Desktop app: one Bun core, one React webview, one SQLite DB. The New Task form is a left rail `<aside>` always mounted; the Repositories dialog is a `fixed` overlay rendered inside it (no portal).
- No new privileged action: the dialog reads the project list (`GET /projects`, already app-token) and resolves roots (`GET /projects/repo-root`, app-only). Branch listing/fetch/pull are existing `app+cli` routes with the CLI path gate; the webview uses the app token. No agent code or third-party input reaches these paths differently than today.
- Path trust: selected paths come from the registered-projects table or the native folder picker; the server still validates every repository path inside a git repo at create time. The UI does not widen path access.

### 1.8 Contract location

The new request exists only in the pipeline task text + attached screenshot, **outside the repo**. The closest committed contract is `docs/specs/multi-repo-tasks.md` (`:126-129`), which currently specifies the opposite split. The grill/write-plan steps must commit the new decision (and amend the spec/architecture docs); a reviewer cannot check code against a screenshot.

## 2. What we proved

| Question | Verdict | Evidence (command → output / measurement) | Versions | Artifact |
| --- | --- | --- | --- | --- |
| Does the current helper layer still pass at this baseline? | Yes | `bun test src/mainview/lib/repo-selection.test.ts src/mainview/lib/multi-repo-ui.test.ts src/mainview/lib/worktree-payload.test.ts` → 66 pass, 0 fail, 107 expect calls | Bun 1.3.10 | terminal |
| Does the worktree install and typecheck? | Yes | `bun install --frozen-lockfile` → 696 packages in 4.62 s; `bun run typecheck` → clean (no output) | Bun 1.3.10, TS 5.9.3 | terminal |
| Can a 1-entry `repositories` payload carry a non-git folder? | **No** | `resolveRepositorySet` rejects any path whose `resolveRoot` is null (`src/bun/task-repos.ts:59-63`); existing `task-repos.test.ts` asserts "not inside a git repository" | — | code + existing test |
| Does a 1-entry `repositories` payload become a single-repo task and honor its `baseRef`? | Yes | `createTask` `keptRepositories.length === 1` branch sets `workdir` to that path and reads `singleRepoInput.baseRef` (`orchestrator.ts:12521-12542`) | — | code |
| Would a naive UI-only change be caught by unit tests? | **No** | `grep` finds no test that renders `NewTaskForm`/`WorktreeOptions`; the only coverage is Playwright e2e | — | `src/mainview/components/kanban/*.test.*` (none) |
| Do branch pickers clip inside the RepositoriesDialog list? | **Yes, by CSS** | `SearchSelect` popover is `absolute` (`search-select.tsx:140-149`); the list is `max-h-72 overflow-y-auto` (`RepositoriesDialog.tsx:201`) | — | code |

No spikes were run. Every load-bearing technical question was answerable by reading the source and existing tests; the remaining unknowns are owner decisions, not experiments. (The one CSS constraint above is deterministic; a spike would only re-observe it.)

## 3. What we're assuming

1. **"One selection is required" means at least one selected project**, not exactly one. If it meant exactly one, multi-repo creation would be dead, contradicting the same sentence's "when more than one is selected". *If wrong:* the entire multi path disappears and the task becomes single-only.
2. **"Per project selected, we must have the branch picker, pull and fetch" means the existing base-ref `BranchPicker`, one per selected project**, not a new per-project branch-name editor. The server supports one shared branch name with per-repo fallback; per-project branch names would be a server/data change out of this task's scope. *If wrong:* `repositories[].branch` / branch plan / prompt block / PR surfaces all change.
3. **The shared branch-name field stays one field** (first selected project's nomenclature), because `createTask` derives the shared name from the first kept repo and resolves it per repo. *If wrong:* branch naming becomes per-project and `docs/architecture/multi-repo-tasks.md` §Creation changes.
4. **The single-repo payload shape stays the old shape** (`workdir` + top-level `baseRef`), because a 1-entry `repositories` payload rejects non-git folders and the CLI already deliberately keeps one repo on the old shape (`src/cli/commands/add.ts:616-625`). *If wrong:* plain-folder tasks with isolation off break.
5. **`multiRepo` remains a post-dedupe decision** (git-root collapse can turn two selected paths into one repository). The count/forced isolate must use the deduped list, as the dialog does today via `getProjectRepoRoot` + `mergeSelectionsByRoot`. *If wrong:* two subdirectories of one repo show "2 projects", force isolation, and create a single-repo task — a visible lie.
6. **The most-recently-added project is still auto-selected on form open** (today's `ProjectPicker` behavior). *If wrong:* many e2e specs that never explicitly pick a project (`e2e/at-file-autocomplete.spec.ts:324-328`, `e2e/branch-scoped-capabilities.spec.ts:123-125`) start with no workdir and fail; users get an extra click.
7. **The proposal is webview-only.** No server route/schema/migration is needed. *If wrong:* the plan must add routes/policy/migrations and the blast radius grows.
8. **The issue dialog should follow the panel** (shared `RepositoriesDialog`, shared `WorktreeOptions`). *If wrong:* either the dialog gets a mode flag or New Task needs a second component, and `issue-tasks.md:19`'s parity claim goes stale.
9. **Branch-only base refs are acceptable** (no tag/SHA typing) because that is what the single-project picker offers today. *If wrong:* keep an advanced ref input alongside the picker and add its identifier props/tests.
10. **The selection surface stays a Save-based dialog** (not a live popover), because git-root dedupe and the "two base refs on one root" conflict (`multi-repo-ui.ts:94-146`) are currently enforced on Save. *If wrong:* a live `MultiSearchSelect` needs async root resolution and a conflict state on every toggle.

### 3.1 Design options considered (evidence, not a decision)

| Option | Shape | Why it could work | Why it is risky / what it costs |
| --- | --- | --- | --- |
| **A — One modal "Select Projects" dialog + per-project branch rows inline in the form** (recommended for robustness) | Replace the `Project` label/picker and the `Repositories` block with one full-width button; the existing `RepositoriesDialog` (upgraded to 1+ selection, search, Add folder/clone/import) is the picker; `WorktreeOptions` renders one `BranchPicker` per selected project, then the disabled/checked Isolate, then Branch name | Literal "per project branch picker + Pull + Fetch"; base refs stay visible without reopening; reuses `BranchPicker` with no popover-portal work; keeps `worktree-options`/`branch-name-input` test seams; dedupe/conflict logic stays on the dialog's Save | The button is above the branch rows, not directly adjacent to Isolate; the form grows with N projects (scrolls); N eager branch-list requests; a same-git-root base-ref **conflict** is detected on Save but the refs to fix it live behind the dialog, so the user must Cancel, edit the inline rows, and reopen (or the dialog keeps a conflict-only text input) |
| **B — One modal dialog owns both selection and per-project branch rows** | The same button; the upgraded dialog shows a `BranchPicker` under every selected project; the form is just button → Isolate → Branch name | Smallest form; exactly "button on top of Isolate"; per-project configuration lives in one place; compact for many projects | `SearchSelect`'s absolute popover is clipped by the dialog's scroll box (`RepositoriesDialog.tsx:201`) — needs a portal/fixed-mode picker or a non-clipping layout; base refs invisible after closing; bigger change to `SearchSelect`; dirty tracking for the issue dialog moves into the dialog |
| **C — Live `MultiSearchSelect` popover + per-project rows inline** | Replace the Project trigger with the existing multi-select primitive; its trigger already renders `1 → label, N → "N selected"` (`multi-search-select.tsx:99-107`); add a footer for Add folder/clone/import | Least new component code; exact count-label convention; familiar combobox | No Save step, so git-root dedupe and base-ref conflicts must become async/live; the popover is narrow for adding management actions; same form density as A |
| **D — Keep both selectors** | Leave `ProjectPicker` and add the combined button as a third path | No migration risk | Directly contradicts the ask; three ways to pick projects; rejected |

The investigation does **not** select an option; the owner's answer to Q1/Q2 below decides. The design's hard constraints are: dedupe before the count/isolate state, single-repo payload shape for a plain folder, and a non-clipping picker if branch rows go inside a scrollable dialog.

## 4. What we must ask the owner

1. **Where do the per-project branch pickers live — and what is the exact form order?** (a) Inline in the New Task sidebar, one `Branch` row per selected project, under the Select Projects button and above Isolate [recommended: base refs stay visible, no dialog-popover clipping, reuses `BranchPicker` exactly as the single project has it]; (b) inside the Select Projects dialog, one row per selected project, so the form is literally button → Isolate → Branch name [compact, but needs a portal/fixed popover or a non-clipping layout]; (c) both. *Why it matters:* this sentence is the only ambiguity that changes the component architecture, the e2e locators, and whether `SearchSelect` needs a portal mode.
2. **Does "Select Projects" open a modal dialog or a popover?** The existing `RepositoriesDialog` (Save/Cancel, git-root dedupe, base-ref conflict) is the natural home for 1+ selection; a `MultiSearchSelect` popover is more compact but has no Save step, so dedupe and conflict handling would have to become live/async. *Why it matters:* the count and the forced-isolate state must reflect the **deduped** set; a raw checkbox count can say "2 projects" while the server creates a single-repo task.
3. **Scope: New Task only, or the issue dialog too?** `CreateTaskFromIssueDialog` shares `RepositoriesDialog`, `useWorktreeOptions` and `WorktreeOptions`; leaving it on the old split means forking the dialog or making `docs/architecture/issue-tasks.md:19`'s "exactly like the panel" claim false. *Recommendation:* both surfaces, with the issue repo locked first. *Why it matters:* if both, the issue dialog's `wt.baseRefDirty`-based "discard draft?" check needs a replacement when base refs move; if only New Task, the shared component needs a mode flag.
4. **Exact button-label rule.** (a) 1 selected → the project's display name; 2+ → `"2 projects selected"` [recommended: matches the current `MultiSearchSelect` trigger and the current single Project trigger]; (b) always `"N selected"`; (c) `"N repositories"` via `repositoryCountLabel`. *Why it matters:* this is the accessible name and every e2e locator; also whether users can see *which* project is selected without reopening.
5. **Minimum-one behavior.** Allow the dialog draft to reach zero (Save/Create disabled, with a "select at least one" hint), or prevent unchecking the last project? *Recommendation:* allow zero in the draft, disable Save/Create; the saved form always has ≥1 (auto-selected). *Why it matters:* users often switch a single selection by unchecking the old before checking the new.
6. **Keep auto-selecting the most recently added project on form open?** Today `ProjectPicker`'s `autoSelectFirst` does (`ProjectPicker.tsx:67-76`), and several e2e specs rely on it. *Recommendation:* keep it and show that project's name in the button; the dialog opens with it checked. *Why it matters:* starting empty makes the form invalid on open, adds a click, and breaks tests that register a project and type a prompt without selecting.
7. **Per-project Pull/Fetch semantics.** Same as today's single picker: Pull fast-forwards the **selected base-ref branch** in that project's source repo; Fetch runs `--all --prune`; both mutate the user's checkout. *Recommendation:* same. *Why it matters:* N rows mean N potential network operations and source-checkout mutations before a task is even created; confirm that's wanted and that there is no "fetch all" requirement.
8. **Tags/SHAs.** The single picker only offers existing branch rows; the current 2+ dialog's text input accepts any ref. Replacing it with `BranchPicker` removes tag/SHA entry. *Recommendation:* accept branch-only parity; keep the API/CLI escape hatch. *Why it matters:* if someone pins a tag today, this is a regression; an "advanced ref" input is a small addition but adds a second control per project.
9. **Shared branch name.** Confirm one `Branch name` for all selected projects (server contract: one desired name per repo, `-N` fallback). *Why it matters:* per-project names are a server/data change and would rewrite the launch-prompt/PR docs.
10. **Isolate after collapsing back to one.** If the user had 2 projects (Isolate disabled+checked) and removes one, should Isolate stay checked (now editable) or return to its previous/unchecked state? *Recommendation:* stay checked; the user can uncheck. *Why it matters:* a surprise uncheck would silently change the task's layout.
11. **Where do Add folder / Clone repository / Import sessions go?** They live in `ProjectPicker`'s footer today; if `ProjectPicker` is retired they must move into the combined surface (recommended) or lose an entry point. *Why it matters:* `e2e/clone-project.spec.ts` / `clone-providers.spec.ts` open Clone from that entry; the App header's Import sessions entry remains either way.
12. **Count basis.** Show the deduped count (what the server will create) or the raw number of checked paths? *Recommendation:* deduped, with the existing "some share a git root" note. *Why it matters:* the isolate decision and the count must not lie about a single-repo create.

Questions 1–4 are the load-bearing ones; 5–12 are refinements the plan can default if the owner has no preference.

## 5. Completeness inventory

### Callers (direct and indirect)

- `ProjectPicker`: `NewTaskForm.tsx:54,867` only (product). E2E: `e2e/clone-project.spec.ts`, `clone-providers.spec.ts`, `identifier-inputs.spec.ts`, `multi-repo-task.spec.ts`, `cursor-stream.spec.ts`, `copilot-harness.spec.ts`, `copilot-harness-availability.spec.ts`, `speed-picker.spec.ts`, `fx-recovery.spec.ts`, `fx-interactions.spec.ts`, `opencode-harness.spec.ts` (11 files).
- `RepositoriesDialog`: `NewTaskForm.tsx:55,912`; `CreateTaskFromIssueDialog.tsx:19,428`.
- `useWorktreeOptions` / `WorktreeOptions`: `NewTaskForm.tsx:61,262,883`; `CreateTaskFromIssueDialog.tsx:18,84,414`; `ResolveConflictsDialog.tsx:11,252` (locked variant only).
- `repo-selection` helpers: `NewTaskForm.tsx:56` (`collapseToProject`, `repositoryFileScopes`, `selectionName`, `RepoSelection`); `CreateTaskFromIssueDialog.tsx:20` (`pinPrimaryRepository`, `repositoryFileScopes`, `selectionName`); `RepositoriesDialog.tsx:7-13` (`dedupeSelections`, `selectionName`, `selectionNames`, `tooManyRepositories`, `RepoSelection`); `App.tsx:83` and `RunPanel.tsx:47` (`issueProjectPath`, `taskProjectPath` — not affected).
- `multi-repo-ui` helpers: `NewTaskForm.tsx:57` and `CreateTaskFromIssueDialog.tsx:21` (`applyRepositoriesSave`, `seedRepositoriesDialogValue` — candidates for removal); `RepositoriesDialog.tsx:14` (`createSessionGuard`, `describeRootConflict`, `mergeSelectionsByRoot`); `App.tsx:84`, `RunPanel.tsx:37`, `TaskCard.tsx:20`, `DiffDialog.tsx:24` (other helpers, not affected).
- `worktreePayload`: `NewTaskForm.tsx`/`CreateTaskFromIssueDialog.tsx` via `wt.payload()`; `worktree-payload.test.ts`.
- `BranchPicker`: `WorktreeOptions.tsx:17,315-329` (today), plus the per-project rows in the new design.

### Entry points new code must be wired into

- `NewTaskForm`: project/branch/repositories JSX (`:865-934`), `canSubmit` (`:646`), `submit` payload (`:650-722`), `fileScope`/`fileScopes` (`:320-329`), post-submit reset (`:713-721`), `PromptComposer startingFolder` (`:852`).
- `CreateTaskFromIssueDialog`: worktree/repositories JSX (`:414-451`), `canSubmit`/`draftDirty` (`:202-221`), submit payload (`:242-290`), `fileScope`/`fileScopes` (`:113-125`).
- `WorktreeOptions` (live variant props/JSX) and `useWorktreeOptions` (baseRef ownership / `valid` / `payload`).
- `RepositoriesDialog` (1+ selection, search, management footer, per-project branch rows if option B).
- `App` (only if the project list/refresh is passed down; today `NewTaskForm` fetches its own).
- `src/mainview/lib/worktree-payload.ts` (single/multi payload mapping) and whichever pure helper owns the count/label/dedupe merge.
- `e2e/helpers.ts` if a shared `selectProjects` helper is added; every spec listed above.

### Propagation surface

- `RepoSelection` (`path`, `root`, `baseRef`) and the create payload's `repositories[]` / top-level `baseRef` shape.
- `WorktreeOptionsState` / `WorktreePayload` types and every `payload()` caller.
- Dialog props (`value`, `onSave`, `lockedPath`) and the returned selection order.
- `multiRepo` / effective-isolate derivation and `canSubmit`.
- Dirty tracking for the issue dialog (`baseRefDirty` today).
- Test ids, button labels, trigger titles, "N selected" text.
- Docs listed below.

### Existing data a migration would have to backfill

- None. No DB column, no preference, no on-disk layout changes. `repositories` is already persisted for existing multi tasks; existing single tasks are untouched. The projects table and its `added_at` ordering are read-only here.

### Docs / config / examples that describe current behavior

- `docs/specs/multi-repo-tasks.md:126-129` (UI: one repo inline, 2+ dialog, per-repo base only in the dialog).
- `docs/architecture/multi-repo-tasks.md:471-482` (Surfaces: exactly the split being replaced).
- `docs/architecture/prompt-composer.md:16` (`useWorktreeOptions` owns base-ref/`payload()`), `:33` (the dialog's base-ref carry and single-vs-multi rules).
- `docs/architecture/issue-tasks.md:19` (issue dialog "exactly like the panel").
- `CLAUDE.md:49` (topic map names `RepositoriesDialog`), `:69` (topic map names `WorktreeOptions`).
- `docs/architecture/security.md:15,287` ("the Repositories dialog's git-root lookup").
- `README.md:177-180` (Quick start "Pick a project folder").
- Historical records that should **not** be rewritten: `docs/plans/multi-repo-tasks.md`, `...-grill.md`, `...-smoke.md`; the new grill/plan records the superseding decision.

### What the change would orphan

- `ProjectPicker.tsx` itself (if retired) and its `CloneProjectDialog`/`ImportSessionsDialog` mounts; its `autoSelectFirst` logic must move.
- `collapseToProject` (`repo-selection.ts:117-126`) — only NewTaskForm uses it.
- `seedRepositoriesDialogValue` / `applyRepositoriesSave` (`multi-repo-ui.ts:27-78`) and their tests — if every selected project owns its base ref.
- `useWorktreeOptions`' `baseRef`/`setBaseRef`/`setBaseRefAuto`/`baseRefDirty`/`resetBaseRef`/`payload` (depending on the chosen option) and `worktreePayload`'s single/multi mapping.
- `WorktreeOptions`' `variant="multi"` behavior (hide branch + isolate) and the "Worktrees isolation is always on…" paragraph.
- The `Repositories` summary block, "Manage", "Use multiple repositories…", the per-repo text input, and `data-testid="new-task-repositories"`.
- The ProjectPicker/branch-picker trigger titles and `Search projects…` placeholder that 11 e2e specs use.
- The docs statements above.

## 6. Runnability

- **Install:** `bun install --frozen-lockfile` (run here → 696 packages, 4.62 s; leaves `git status` clean — `node_modules/` is ignored).
- **Typecheck:** `bun run typecheck` (run here → green).
- **Unit/integration:** `bun test` (full suite ~4 min per the prior investigation), or focused: `bun test src/mainview/lib/repo-selection.test.ts src/mainview/lib/multi-repo-ui.test.ts src/mainview/lib/worktree-payload.test.ts` (run here → 66 pass). `bun test src/mainview/lib/*` for the webview helpers. There is no `NewTaskForm` unit test.
- **E2E:** `bun node_modules/@playwright/test/cli.js test e2e/multi-repo-task.spec.ts` (or another spec). `playwright.config.ts` starts Vite on `:5173` (override `AGETOR_E2E_VITE_PORT`), `e2e/fixtures.ts` provisions one headless Bun backend per worker (own `AGETOR_DATA_DIR`/port/token, fake drivers, `AGETOR_GITHUB_API_BASE` stub), and Playwright 1.62.1 + Chromium are installed here. No credentials needed. Native folder pickers are not testable in the headless backend (`/projects/pick` is `app`-only/native); register projects with `POST /projects` instead.
- **Dev UI:** `bun run dev:hmr` (Vite + Electrobun, `AGETOR_DATA_DIR=$HOME/.agetor-dev`, `AGETOR_API_PORT=4318`); do not dogfood against `~/.agetor`.
- **Test hygiene:** set `AGETOR_DATA_DIR` at the top level of any unit test importing `db.ts`/`orchestrator.ts`; use `rmTestDataDir`; snapshot/restore harness rows with `snapshotHarnessState()` if a test mutates them. E2E specs are serial within a file and per-worker parallel across files.
- **Current repo facts:** `HEAD 41d2692d` (`main`), branch `fix/agetor-multiple-repo-task`, clean tree before this brief; no pending changes from other steps in this worktree.

## 7. Risks & blast radius

1. **E2E blast radius is large.** 11 specs use the ProjectPicker trigger/search, 2 clone specs use its footer, `multi-repo-task.spec.ts` owns the only real-UI multi creation, and `branch-scoped-capabilities.spec.ts`/`identifier-inputs.spec.ts` assert the branch-picker location and identifier props. A shared `selectProjects` helper is the cheap path; updating each local helper is mechanical but must not mask a broken flow. Watch the auto-selected project in the shared worker backend: `multi-repo-task.spec.ts` registers `repoSibling` (same git root as `repoA`) last, so the dialog opens with it selected; checking `repoA` on top would dedupe to `repoSibling` (first selected wins), not the expected `repoA` — the test must clear the auto-selected row before checking its intended set.
2. **Popover clipping if branch pickers go inside the dialog.** `SearchSelect`'s absolute popover inside `max-h-72 overflow-y-auto` is clipped. Options: keep branch rows inline (recommended), portal the popover (follow `CLAUDE.md:113` + `data-popover-open`), or use a non-popover control. Do not put a `BranchPicker` in the current scroll row list without solving this.
3. **Count/isolate must be post-dedupe.** `getProjectRepoRoot` is async and app-only; two sibling dirs collapse to one repo. If the new UI computes `multiRepo` from raw toggles, it disables Isolate for a single-repo create. Keep `mergeSelectionsByRoot`/`describeRootConflict` on the Save path (or reimplement them live). If the branch pickers are inline in the form (option A), the dialog can detect a same-root base-ref conflict but cannot resolve it — it must either keep a conflict-only ref input or tell the user to cancel and edit the rows; decide this before choosing A.
4. **Single vs multi payload shape.** A 1-entry `repositories` array rejects a plain non-git folder; a single selection must still send `workdir` + top-level `baseRef`. A naive "always send repositories" breaks isolation-off folder tasks. Add a pure test for the 4 cases (0/1/multi/isolate-off).
5. **Isolate is derived in an effect today.** `wt.isolate` can be false for a render while `multiRepo` is true; `canSubmit`/payload must use an effective `multiRepo || isolate`, not the raw state, or an invalid branch name could pass during the transition.
6. **BranchPicker auto-select changes the meaning of "empty".** Mounting a `BranchPicker` for a selected project auto-pins that repo's current branch; that's the same commit as HEAD at create time, so no behavioral drift, but the issue dialog's dirty check must distinguish auto-select (`onAutoSelect`) from a user pick, or "Manage pipelines…" starts prompting after merely opening the form/dialog.
7. **Tag/SHA entry disappears** if the text input is replaced by `BranchPicker`; the server still accepts any ref, but the UI loses it. Confirm with the owner; keep an advanced input if needed.
8. **N eager branch-list requests** on a large selection (each `BranchPicker` calls `/projects/branches` on mount). The webview's ~6 connections/host and 2 SSE streams are the budget; for 10+ projects consider lazy loading or a bounded pool. The current dialog already warns above 10.
9. **Issue dialog parity/dirty tracking.** If both surfaces change, `CreateTaskFromIssueDialog`'s `draftDirty` (`wt.baseRefDirty` today) and `pinPrimaryRepository` need careful rewiring; if only New Task changes, the shared `RepositoriesDialog` needs a mode or a fork.
10. **UI density.** N branch rows (each with label + Pull + Fetch + trigger) in a 320 px rail is tall; the form already scrolls, but the lower pickers' popovers can clip at the scroll viewport edge. A disclosure per project or a compact label ("Branch · <project>") may be needed.
11. **Docs drift.** The spec, architecture doc, prompt-composer doc, issue-tasks doc, topic map and security doc all describe the old split. The repo rule requires updating them in the same change; a stale "one repo keeps inline fields" line is a review finding.
12. **Test gap (naive-change warning).** No unit test renders the form. A change that adds the button/count but never wires the per-project base refs into the create payload stays green in `bun test`; the e2e must pick a **non-current** branch in each of two repos and assert the stored `repositories[].baseRef` shas (and assert the old trigger/summary are gone, Isolate is checked+disabled, and the count is deduped). A test that leaves the default current branch cannot tell the picker is wired.
13. **Rollback is low-risk.** No data/schema change; reverting the UI restores the old selector. The only persistent effects are tasks already created with the new payload (which the server already supports).
