# Grill — one Select Projects control for New Task

| Field | Value |
| --- | --- |
| Date | 2026-11-13 |
| Source | Pipeline task text + screenshot `screenshot-2026-11-13_15-07-41-ad004ca2.png` (outside the repo); investigation `docs/plans/select-projects-combined-investigation.md` |
| Mode | interactive via decision form, answered by the owner in 2 rounds |
| Answers | `docs/plans/select-projects-combined-grill/round-1/answers.json`, `docs/plans/select-projects-combined-grill/round-2/answers.json` |
| Flags | none |
| Spec | `docs/specs/multi-repo-tasks.md` — amend the UI section in this change; the new ask itself lives outside the repo and is recorded here |

**Supersedes** `docs/plans/multi-repo-tasks-grill.md` decision 16 (single repo keeps inline fields, 2+ uses the dialog). **Preserves** decision 13 (no primary repository) — the first selected project anchors only the shared branch-name preview, not the data model.

## Settled facts (from the investigation, not re-asked)

- **Webview-only.** No server, schema, migration, route or policy change. `/projects/branches`, `/projects/fetch`, `/projects/pull` and `/projects/repo-root` already exist; `BranchPicker` already calls them.
- **No trust change.** Selected paths still come from the registered-projects table or the native folder picker; the server still validates every repository path at create time. No new privileged action, route or token.
- **Payload shape is load-bearing.** Exactly one project keeps the old `workdir` + top-level `baseRef` shape because a 1-entry `repositories` array rejects a non-git folder; 2+ sends `repositories[]` with per-entry refs.
- **Count and Isolate are post-dedupe.** Two subdirectories of one repository create a single-repo task, so the deduped set decides “2+”, the button count, and the forced Isolate.
- **Runtime shape is unchanged.** One Bun core, one React webview, one SQLite DB; no cross-instance concurrency or migration ordering to reason about.

## Decisions

| # | Topic | Question | Answer | Source | Confidence |
| --- | --- | --- | --- | --- | --- |
| 1 | Layout | Where do the per-project Branch / Pull / Fetch rows live? | Inline in the form: Select Projects button → one `Branch` row per selected project → Isolate → shared Branch name. The single Project picker, the single Branch row, and the old Repositories summary/Manage block are removed. **Superseded 2026-11-13 (owner, on reviewing the screenshots):** the branch picker, Pull and Fetch move into the Select Projects dialog, under each checked project; the form keeps one read-only `Branch · <project>` line per project (decision 5's listing). See plan §10.5. | owner (round-1/answers.json#branch-rows, accepted recommendation; note: “btw, we're removing the one project/branch selection”) | high |
| 2 | Apply & dismissal | Does selection apply on Save or live; and how does the dialog close? | Save/Cancel. Git-root dedupe and same-root base-ref conflicts stay on Save. The Select Projects dialog ignores outside clicks; Escape and Cancel still close. The rule is scoped to this dialog only. | owner (round-1/answers.json#apply-boundary; round-2/answers.json#dismiss-behavior; both accepted recommendations; note: “and avoid closing the modal/dialog when clicking outside”) | high |
| 3 | Minimum one | What happens when the user tries to deselect the last project? | “One selection is required” means at least one, not exactly one. The draft may reach zero; Save is disabled with a “select at least one” hint. The saved form always has ≥1 because Save cannot apply zero. | owner (round-1/answers.json#minimum-one, accepted recommendation) | high |
| 4 | Surfaces | Which task-creation surfaces use the combined control, and what may it change on the PR side? | New Task, the issue task dialog (“Work on this with Agetor”), and the PR conflict dialog (“Resolve with Agetor”). On the PR side the PR's repo is shown locked in the same control; no extra repositories. No new PR “work on this” entry. | owner (round-2/answers.json#scope-surfaces + #pr-selection, accepted recommendations; round-1/answers.json#scope note “issues, pr, resolve conflicts from the pr, new task, etc.”) | high |
| 5 | Button label & listing | What does the button say, and what is listed under it? | 1 → project name; 2+ → “N projects selected”. The per-project rows are the listing (each reads `Branch · <project>` and shows its selected ref); no additional summary line. | owner (round-1/answers.json#button-label; round-2/answers.json#summary-under-button; both accepted recommendations; note: “but keep listing the project and branch selected under that, like we have today”) | high |
| 6 | Base-ref entry | Keep a tag/SHA input per project? | No. Branch rows only, parity with the single-project picker; tag/SHA stays available through the API/CLI. | owner (round-1/answers.json#tag-sha, accepted recommendation) | high |
| 7 | Default selection | Auto-select the most recently added project when the form opens empty? | Yes. | owner (round-1/answers.json#auto-select, accepted recommendation) | high |
| 8 | Isolate on collapse | What happens to Isolate when a 2+ selection drops to one? | It stays checked and becomes editable. | owner (round-1/answers.json#isolate-collapse, accepted recommendation) | high |
| 9 | Pull/Fetch | Per-row only, or bulk actions too? | Per-row Pull/Fetch exactly as today; no Pull all / Fetch all. | owner (round-1/answers.json#pull-fetch, accepted recommendation) | high |
| 10 | Dialog affordances | Search, management actions, and the zero-project state? | Add a search filter. Move Browse for folder / Clone repository / Import sessions into the Select Projects dialog. Keep the button enabled with zero registered projects; the dialog's empty state offers Add folder. | owner (round-1/answers.json#dialog-actions, accepted recommendation) | high |
| 11 | Row identity & removal | How is each row identified, and how is a project removed? | Rows read `Branch · <project name>` (path added when two names collide). **Refined 2026-11-13 (owner):** the added path is the fewest trailing folders that tell the colliding projects apart (`billing/api`), not the full path, whose distinguishing end was truncated away in the narrow form; the full path stays in the tooltip. Removal happens only in the Select Projects dialog; no per-row X. | owner (round-1/answers.json#row-label-remove, accepted recommendation) | high |
| 12 | Shared branch name | One branch-name field or one per project? | One shared `Branch name`; its preview uses the first selected project's `branchConfig`; the server mints one name with a per-repo `-N` fallback. This is not a “primary repo” in the data model (prior decision 13 is preserved). | owner (round-1/answers.json#branch-name, accepted recommendation) | high |
| 13 | Count | Raw checked count or deduped count? | Deduped git-root count for both the label and the forced Isolate; keep the “(some share a git root)” note. | owner (round-1/answers.json#deduped-count, accepted recommendation) | high |
| 14 | Persistence | Keep the selection after creating a task? | Yes, keep every selected project and each ref for the next task. | owner (round-1/answers.json#keep-selection, accepted recommendation) | high |

## Plan implications

- `repos: RepoSelection[]` becomes the single source of truth for the selection and every base ref. `useWorktreeOptions` no longer owns a single `baseRef`; the PR locked variant keeps its read-only branch.
- `multiRepo` is computed after git-root dedupe. Forced isolation and `canSubmit` use the effective `multiRepo || isolate`, not the raw checkbox state.
- Create payload: exactly one project → the old `workdir` + top-level `baseRef` shape (a 1-entry `repositories` array rejects a plain folder); 2+ → `isolation: "worktree"`, `repositories[]` with per-entry refs, one shared `branch`.
- The Select Projects dialog owns selection only; per-project refs are edited in the inline rows. The dialog ignores outside clicks; Escape/Cancel close it.
- `CreateTaskFromIssueDialog` keeps its issue repo first and locked. Its “discard this draft?” check must aggregate every per-project ref (and ignore `BranchPicker`'s auto-selected current branch).
- `ResolveConflictsDialog` keeps its PR repo/head branch locked and gains the same combined control in locked mode; its branch row stays read-only and Isolate stays checked/disabled.
- `Dialog` needs a scoped `closeOnBackdrop={false}` (or equivalent); the default stays close-on-backdrop for every other caller.

## Completeness dispositions

| Item | Disposition | Owner or reason |
| --- | --- | --- |
| `docs/specs/multi-repo-tasks.md:126-129` UI section | in this change | Repo rule `CLAUDE.md:5`; supersedes multi-repo grill #16 |
| `docs/architecture/multi-repo-tasks.md:471-482` Surfaces | in this change | Same rule |
| `docs/architecture/prompt-composer.md:16,33` (`useWorktreeOptions`/base-ref carry) | in this change | The carry helpers and single-ref ownership go away |
| `docs/architecture/issue-tasks.md:19` parity claim | in this change | The issue dialog adopts the same control |
| `CLAUDE.md:49,69` topic map (`RepositoriesDialog`, `WorktreeOptions`) | in this change | Names/ownership move |
| `docs/architecture/security.md:15,287` “Repositories dialog's git-root lookup” | in this change | Rename/retarget to the Select Projects dialog |
| `README.md:177-180` Quick start “Pick a project folder” | in this change | Reword if the old picker is named |
| Retire `ProjectPicker.tsx`; move `CloneProjectDialog`/`ImportSessionsDialog` mounts into the combined control | in this change | Only product caller is `NewTaskForm` |
| Remove `collapseToProject` (`repo-selection.ts:117-126`) and its tests | in this change | Obsolete with no separate Project picker |
| Remove `seedRepositoriesDialogValue` / `applyRepositoriesSave` (`multi-repo-ui.ts:27-78`) and their tests | in this change | Every selected project owns its ref |
| Collapse `WorktreeOptions` `variant="multi"` and the “isolation is always on” paragraph | in this change | Branch rows render for every project |
| `NewTaskForm` state/epilogue: `workdir`+`repos` split, `multiRepo`, forced-isolate effect, `canSubmit`, submit payload, post-submit reset | in this change | Core wiring |
| `CreateTaskFromIssueDialog` dirty check + locked repo | in this change | Round-2 #scope-surfaces; round-1 #scope |
| `ResolveConflictsDialog` locked-row integration | in this change | Round-2 #pr-selection |
| Scoped `Dialog` `closeOnBackdrop` prop | in this change | Round-2 #dismiss-behavior |
| Pure tests for 0/1/multi/isolate-off payloads, dedupe, label and count | in this change | `worktree-payload.test.ts`, `repo-selection.test.ts`, `multi-repo-ui.test.ts` |
| Update 11 e2e specs that drive the ProjectPicker trigger/search, plus the 2 clone specs and `multi-repo-task.spec.ts`, to a shared `selectProjects` helper | in this change | The old trigger/search/footer move |
| New e2e: 1 project; 2 projects with non-current refs asserting stored `repositories[].baseRef`; Isolate checked+disabled; dedupe; outside-click ignored; Escape closes; issue and PR surfaces | in this change | Acceptance bar; no unit test renders the form |
| CLI/TUI `--repo` behavior | out of scope | Already repeatable; no visual picker to combine and no server contract change |
| Tag/SHA UI entry | out of scope | Round-1 #tag-sha; API/CLI escape hatch remains |
| New “Work on this PR with Agetor” entry | out of scope | Round-2 #scope-surfaces did not select it; separate feature |
| Multi-repo conflict tasks (extra repos on the PR side) | out of scope | Round-2 #pr-selection chose locked-only; the server rejects `existingBranch` for 2+ (`orchestrator.ts:12518-12519`) |
| Client-side blocking of a non-git folder in a 2+ selection | out of scope | Pre-existing create-time validation (server 400); not introduced by this UI consolidation; different ticket |
| Lazy/bounded branch-list loading for 10+ projects | out of scope | Expected selection is 2–3; the existing >10 warning stays; a bounded pool is a separate performance ticket |
| Historical `docs/plans/multi-repo-tasks*.md` records | out of scope | Historical records are not rewritten; this record supersedes #16 |

## Assumptions still open

- **Eager branch-list fan-out.** Each `BranchPicker` calls `/projects/branches` on mount. For the expected 2–3 selection this is fine under the webview's ~6-connections-per-host budget (`CLAUDE.md:107`); 10+ is a separate performance ticket. *If wrong:* add lazy loading or a bounded pool.
- **Auto-selected refs.** Each `BranchPicker` preselects its repo's current branch on mount. That pins the same commit as HEAD, so no behavioral drift, but the issue dialog's dirty check must use `onAutoSelect` to ignore the seed. *If wrong:* merely opening the issue dialog starts prompting “discard this draft?”.
- **Client `workdir` = first selected project.** It still drives the branch-name preview, `startingFolder` and the single `fileScope`; the server assigns the workspace root for 2+. *If wrong:* the preview and `@` scope point at the wrong directory.
- **Zero-state copy.** Button says “Select projects…”, dialog title “Select projects”, search placeholder “Search projects…”. *If wrong:* one-line copy change.
- **No feature flag or migration.** Reverting the UI restores the old selectors; tasks already created keep their stored `repositories[]`. *If wrong:* the plan needs a flag and a rollout story.
- **Dialog footer vs button count.** The dialog footer keeps today's raw `N selected` plus the “(some share a git root)” note while the draft is open; the button shows the deduped count after Save. *If wrong:* the footer needs the deduped count too, and the raw number of checked rows becomes invisible while editing.
- **Management actions.** Add folder selects the new project (today's behavior); Clone repository and Import sessions refresh the list without forcing a selection (today's `ProjectPicker` footer). *If wrong:* the dialog needs a “select the newly cloned/imported project” step.
- **Loading and error states.** The dialog fetches the project list on open (today's behavior); a per-row `BranchPicker` keeps its own “couldn't list branches” tooltip and Pull/Fetch spinner/error. *If wrong:* the plan needs a shared loading/error surface inside the dialog.
- **Save-time root lookup failure.** An entry whose root cannot be resolved is kept with `root: null` (today's behavior), so an unreadable path fails at create rather than silently disappearing from the selection. *If wrong:* the dialog needs an explicit “cannot inspect this folder” state.
- **PR conflict dialog shape.** Its branch row stays read-only and its Isolate checkbox stays checked/disabled; only the selection summary adopts the combined look. *If wrong:* the PR surface needs the full per-project row treatment.
