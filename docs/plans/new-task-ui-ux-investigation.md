# Investigation: New Task UI/UX redesign (panel and Git-integration launch dialogs)

| Field | Value |
| --- | --- |
| Date | 2026-11-18 |
| Change | Give the New Task panel and the Git-integration "start a task" dialogs one clear visual and component pattern, improve the UX by current form-design practice, and keep every feature reachable. This brief informs the grill (scope and design decisions) and then the plan. |
| Agents | none, as the pipeline step requires (inline reading, 1 web pass, 1 screenshot spike) |
| Flags | none |

## 1. What we know

### Contract
- The only contract is the task text plus an owner screenshot of the lower half of the New Task panel (Files/Folders → project → Branch row → Isolate → Branch name → Pipeline → Agent → Harness grid with 7 accounts → Mode → Model/Effort → footer). Both live **outside the repo**, attached to the pipeline task. There is no PRD or spec, so the grill output (`docs/plans/new-task-ui-ux-grill.md`) has to become the contract.
- Goal, in the owner's words: the New Task UI "doesn't have a clear pattern of its styles and components". Improve its UI/UX following best practices, including the Git-integration modals that start a task. "All features must be preserved and accessible."

### The surfaces in scope, and what renders them
| Surface | Entry | File | Launch block |
| --- | --- | --- | --- |
| New Task panel (left `<aside>`, `w-80`, collapsible to a `w-11` rail) | always mounted, `App.tsx:2740` | `src/mainview/components/kanban/NewTaskForm.tsx` (1282 lines) | **its own hand-written copy** (`NewTaskForm.tsx:917-1247`) |
| "Work on this with Agetor" (issue → task) | `GitHubDialog.tsx:7343` (`IssueActions`) | `CreateTaskFromIssueDialog.tsx` (456 lines) | `TaskLaunchPickers` |
| "Resolve with Agetor" (PR conflicts → task) | `GitHubDialog.tsx:8104` (`PullActions`) | `ResolveConflictsDialog.tsx` (289 lines) | `TaskLaunchPickers` |
| Select projects (opened from the panel and the issue dialog) | `WorktreeOptions.tsx:343` | `SelectProjectsDialog.tsx` (468 lines) | n/a |
| Branch naming settings (gear on the Branch name field) | `WorktreeOptions.tsx:430` | `settings/BranchNamingDialog.tsx` | n/a |

Shared building blocks, already lifted out of `NewTaskForm` and consumed verbatim (decision captured in the fleet KB and in `docs/plans/issue-pr-modal-worktree-composer-parity.md`):
- `PromptComposer.tsx`: the label row, the `ExtensionPicker` ("MCP · Skills · Plugins · Agents · Prompts"), the textarea with `/` and `@` autocompletes, the drop hint, the unresolved-`@` warning, and `ReferencesPicker`. **There are 4 consumers, and RunPanel's send dock is one of them** (`RunPanel.tsx:4985`), so any visual change here also lands in the run panel.
- `WorktreeOptions.tsx`: the Select Projects button, the `Branch · <project>` summary rows, Isolate, and the Branch name field plus gear. There is a `locked` variant for Resolve conflicts (`:272-303`).
- `TaskTypePicker.tsx`: the Task/Bug/Spike grid.
- `TaskLaunchPickers.tsx`: the `useTaskLaunch` hook (`:207-650`), the `TaskLaunchPickers` view (`:669-979`) and `createAndStartTask` (`:992`). **It has 5 consumers**: the issue dialog, Resolve conflicts, `CloneProjectDialog.tsx:427` (the "Explain this repository" task), `AgentProfileFormDialog.tsx:338` (Settings → Agents, `hideProfilePicker`), and the docs. `NewTaskForm` does **not** use it.

### Finding 1: two launch-picker implementations that have drifted (the main structural cause)
`NewTaskForm` keeps its own harness/mode/model/effort/speed/max-mode state and markup, while every dialog uses `TaskLaunchPickers`. The two now differ, which is the "no clear pattern" the owner sees:

| Aspect | New Task panel (`NewTaskForm.tsx`) | Dialogs (`TaskLaunchPickers.tsx`) |
| --- | --- | --- |
| Mode | Code/Plan pills **plus** a `SearchSelect` with hints and an InfoTip: two controls for one value (`:1057-1108`) | a plain native `<Select>`, no hints, no Code/Plan (`:913-920`) |
| Model refresh ↻ | yes (`refresh-models`, `:1114-1137`) | no |
| Harness button tooltip | account email + today's token burn + reason/path/version (`:1027-1039`) | reason/path/version only (`:869-878`) |
| Harness status dot | green/red, availability defaults to `true` (`:1017, :1045-1050`) | green/**amber when logged out**/red, availability defaults to `false` (`:861-888`) |
| Unavailable / not-logged-in hint position | at the end of the block (`:1224-1243`) | directly under the harness grid (`:894-910`) |
| Fable / Mythos "2x usage" notes | yes (`:1204-1220`) | no |
| Max Mode vs Speed order | Max Mode, then Speed | Speed, then Max Mode |
| Pipeline section | no loading/error/empty hints, **no runnability preflight** (`resolvePipelineLaunch`), test ids `new-task-pipeline-*` | loading/error/empty hints, preflight blocks submit with a reason, test ids `launch-pipeline-*` |
| "Manage agents…" row in the Agent picker | yes (`onOpenSettingsAgents`) | not wired (`onManageProfiles` is never passed by the dialogs) |
| Switching harness | per-kind cache restores the previous picks for that kind (`:435-450`) | resets to the kind's defaults (`:514-525`) |
| Remembered picks | `lastMode/lastModel/lastEffort/lastSpeed/lastMaxMode` | `lastMode/lastModel/lastEffort` only (`:553-561`) |
| Gating submit on harness availability | no (by design: "To backlog" still works) | yes (`effectiveLaunchable`) |

### Finding 2: a real bug in New Task (Fast speed is dropped for claude-code and codex)
`NewTaskForm.tsx:724` sends `speed: kind === "cursor" || kind === "fx" ? speed : "off"`. That line dates from `c5cf1a2d` (Oct 25, when only cursor/fx had tiers). Wave 4 (`57e161e1`, Nov 17) made the Speed picker appear for claude-code and codex (`src/shared/speed.ts:73-75`, contract in `docs/architecture/harnesses.md:30-34`). So the panel **shows** Fast, **remembers** it as `lastSpeed:<kind>`, and **submits Off**. The dialogs send `launch.speed` unconditionally, so they are correct. No test catches this: `e2e/claude-models.spec.ts:122-129` clicks Fast in the form but creates its task through the API (`:131-134`), and `e2e/speed-picker.spec.ts` covers only the fx and cursor form paths.

### Finding 3: a false warning in the issue dialog
The issue prompt names people with `@login` (`src/shared/issue-task.ts:286`, `:439`). The composer's unresolved-`@` warning (`PromptComposer.tsx:719-953`) excludes extension names but not handles, so **every issue with an author shows** "`@<author>` doesn't match a project file — it will be sent as plain text". This was seen in the baseline screenshot `06-issue-dialog.png`.

### Finding 4: the visual inconsistencies, each traced to its source
- **Control heights**: `Input` is `h-9 text-sm` (`ui/input.tsx`). `Select` is `h-9 text-sm`, but the panel overrides it to `h-8`. The `SearchSelect` trigger is `h-9 text-sm`, also overridden to `h-8 text-xs`. The Agent and Pipeline triggers are `min-h-9 text-sm` (`AgentProfilePicker.tsx:121`, `PipelinePicker.tsx:107`). `SelectProjectsButton` is `py-1.5 text-xs`. Toggle buttons are `size="sm"` `h-8 text-xs`. So five field heights and two type sizes sit in one column (visible in every screenshot).
- **Four dropdown implementations side by side**: native `<Select>` (Model, Effort), `SearchSelect` (Mode), a custom popover (Agent, Pipeline), and the custom Extension picker. They differ in trigger style, open style and keyboard behavior.
- **Selected state uses the primary CTA style**: Type, Harness and Mode toggles use `variant="default"`, which is solid white in dark mode and solid black in light. These compete with the primary "Run task" button. The run button is disabled until valid, so the selected chips are the brightest things on the panel.
- **A native checkbox** for Isolate (`WorktreeOptions.tsx:397`, a blue OS checkbox in the screenshots). Elsewhere toggles use the hand-rolled `Switch` (Max Mode). The repo has no `Checkbox` primitive.
- **Labels aren't associated with their controls**: every field is `<label className="text-muted-foreground">Title</label>` with no `htmlFor` and no wrapping. There is no `Label`/`Field` primitive. Screen readers get unlabeled inputs, and clicking a label does nothing.
- **Fixed px text sizes**: hint and helper text use `text-[11px]`/`text-[10px]` (43 occurrences in the six in-scope files; 531 app-wide). The app's Cmd+/− font-size controller scales the root `rem` (`lib/font-size.ts`), so these lines **don't scale**. This is an app-wide convention, not New Task-specific.
- **No grouping**: about 16 controls sit in one flat `space-y-3` column. The header InfoTip explains three groups (what / where / who) that the layout never shows.
- **Tight width**: at `w-80`, harness names truncate ("GitHub Co…", "Claude PBS…"; the owner has 4 Claude accounts, which differ mainly by the truncated suffix). The Extensions trigger wraps to two lines, and branch names and the `Branch · project` row truncate.
- **Low-affordance controls**: the `Branch · <project>   ⑂ current branch` summary is a `<button>` styled as muted text (`WorktreeOptions.tsx:362-389`). "Reset to pattern" is a bare underline link. "Change" on the pipeline card is a text link.
- **Dialog chrome is hand-rolled per dialog**: `Dialog` (`ui/dialog.tsx`) has no Header/Body/Footer/Title parts. The issue and PR dialogs share a header + X + bordered footer by copy-paste, `SelectProjectsDialog` uses another layout (no X, `h-4 w-4` icons instead of `size-4`), and there are no shared action-row conventions.
- **CTA vocabulary**: the panel offers "To backlog" / "Run task", while the dialogs offer "Cancel" / "Create & start" for the same create-and-start action. There is no Cmd/Ctrl+Enter submit anywhere in these forms.
- **Header**: the panel header shows the selected CLI's raw `--version` string at the right (`:867-871`). It reads "--version" with stub bins and adds little.
- **Dialog layout**: the issue dialog is a single `max-w-lg` column that repeats the panel (info box, Type, a 12-row prompt, Files, Select Projects, Branch, Isolate, Branch name, Pipeline + empty hint, Agent, Harness, Mode, Model/Effort). That is a long scroll at 85vh (`07-issue-dialog-bottom.png`).

### Standards that apply (repo rules)
- Semantic status tokens only (`text-success`, `bg-warning/10`), never palette classes. A new token must land in **both** `src/mainview/index.css` (`:root` and `.dark`) and `tailwind.config.js`, or Tailwind emits nothing (the undefined-token trap). There is no `--popover` token: popovers use `bg-card`. (CLAUDE.md, "UI conventions")
- Primitives under `src/mainview/components/ui/` are **hand-rolled with no Radix dependency** (`package.json` has none; `ui/switch.tsx` says so). Tailwind is **v3** (`tailwindcss ^3`). The current shadcn CLI and docs target Tailwind v4 and Radix/Base UI, and v3 projects are pointed to `v3.shadcn.com`. So new primitives (Field/Label, Checkbox, ToggleGroup or segmented control, dialog parts) should be **hand-written** on shadcn's shape, not added with `bunx shadcn add`. (Web, see Sources.)
- Popovers inside a dialog must carry `data-popover-open=""` only while open and close on Escape (`docs/architecture/prompt-composer.md`). Any new picker must follow this or the dialog becomes impossible to close from the keyboard.
- A `fixed` overlay inside a transformed ancestor must portal to `document.body`. `Dialog` renders inline and needs `!m-0` inside `space-y-*` (prompt-composer.md, last paragraph; asserted by `e2e/select-projects.spec.ts`).
- Layout chrome state (collapsed panels, section open/closed) goes in `localStorage` through `lib/panel-collapse.ts`, read synchronously on first render. Anything that changes the task or agent goes through `api.setPreference`.
- Light and dark must both work. `ThemeProvider` is the runtime source.
- Owner decisions still standing: the Select Projects grill decisions 1–14 (`docs/plans/select-projects-combined-grill.md`: one combined control, read-only per-project Branch rows that reopen the dialog, one shared Branch name, auto-select the most recent project, keep the selection after submit). "One selection" across Pipeline / Agent profile / manual harness (plan D5). No last-used profile or pipeline (D12).

### Runtime and trust shape
Webview-only. No new route, migration or server behavior is needed for a pure UI redesign. The three bug fixes are client-side too: Finding 2 changes the client payload only, and the server already accepts every `isSpeed` value (`orchestrator.ts:12995`). The panel is a single instance mounted for the app's lifetime. The dialogs mount unconditionally inside `GitHubDialog` and gate their fetches on `open`, and that gating must survive. The WKWebView 6-connection budget is untouched as long as no new stream or poll is added.

## 2. What we proved
| Question | Verdict | Evidence | Versions | Artifact |
| --- | --- | --- | --- | --- |
| Can we capture today's New Task panel and issue dialog as a baseline, headless, without touching `~/.agetor`? | **yes** | A temp spec `e2e/zz-tmp-ui-baseline.spec.ts` (setup copied from `e2e/issue-task.spec.ts:1-626`), run with `AGETOR_E2E_VITE_PORT=5197 AGETOR_E2E_PORT_OFFSET=3000 bun node_modules/@playwright/test/cli.js test e2e/zz-tmp-ui-baseline.spec.ts --workers=1` → 1 passed (16.8 s). The temp spec was deleted afterwards and `git status` is clean. | bun 1.3.10, Playwright from the lockfile, Chromium, 1440×1900 @2x | 8 PNGs in the session scratchpad (`spikes/ui-baseline/shots/`): panel empty, filled, Agent popover, light theme, issue dialog top and bottom, Select projects stacked on the issue dialog. Not committed; the recipe re-creates them. |
| Does a Playwright config whose `testDir` is outside `e2e/` work? | **no** | `AggregateError: 2 errors building "<scratch>/spec/baseline.spec.ts"` / "No tests found", even with `node_modules` symlinked. The spec only runs from inside `e2e/`. | same | none |
| Would the current suite catch the Finding 2 speed drop? | **no** (from reading) | Every claude/codex form-path speed assertion stops at the UI; their tasks are created through the API (`e2e/claude-models.spec.ts:122-134`). The plan must add a form-submit assertion. | n/a | none |

## 3. What we're assuming
- **The redesign is presentational plus consolidation; payloads stay as they are.** The create payload shape (`selectionPayload`, `createAndStartTask`) stays unchanged except for the Finding 2 fix. If the owner wants behavior changes (for example gating "Run task" on availability), the plan grows a behavior section and its tests.
- **Unifying the launch block is acceptable.** The cleanest route to "one pattern" is one shared launch-picker component used by the panel and every `TaskLaunchPickers` consumer. That changes Settings → Agents and the Clone dialog visually as well. If the owner wants those left alone, the shared component needs a "compact/legacy" variant, or the scope stops at the panel and the two Git dialogs.
- **E2E churn is acceptable** if locators are updated in the same change. About 15 specs scope the panel as `page.locator("aside").first()` (for example `e2e/codex-models.spec.ts:111-113`). They reach Model as `getByTestId("refresh-models").locator("xpath=../..").locator("select")` (7 specs) and Effort as `getByText("Effort").locator("xpath=..").locator("select")` (4 specs). Mode is reached as `getByText("Mode").locator("xpath=following-sibling::div[2]//button")` (codex/copilot/cursor/fx specs). Field-label text is used as an anchor too ("Harness", "Agent", "Mode", "Effort"). Wrapping fields in sections, moving the refresh button, or replacing native selects breaks these. If churn isn't acceptable, the redesign has to keep these DOM anchors exactly.
- **The panel stays a left sidebar.** It stays always mounted, collapsible, a drop zone, and the onboarding spotlight target (`focusNonce`). If it should become a dialog or a wider resizable panel, the collapse persistence, onboarding and drop-zone contracts change.

## 4. What we must ask the owner
1. **Scope of surfaces.** The panel plus both Git dialogs (issue, PR conflicts) are clearly in. Are `SelectProjectsDialog` and `BranchNamingDialog` (opened from them) in? What about the other `TaskLaunchPickers` consumers that a shared redesign changes automatically: Clone → "Explain this repository", and Settings → Agents? And RunPanel's send dock, which shares `PromptComposer`? A restyled composer label row or references strip appears there too unless it gets a variant.
2. **One launch-picker component.** Should `NewTaskForm` move onto a shared launch picker (recommended; it ends the drift in Finding 1)? If yes, for each drifted behavior, which version wins: Code/Plan pills (panel) vs a single Mode select (dialogs); model ↻ everywhere; amber logged-out dot everywhere; the per-kind cache on harness switch; remembering speed and max mode in the dialogs too; the pipeline preflight in the panel too; "Manage agents…" in the dialogs too?
3. **Information architecture.** Group the form into labelled sections (for example **Task**: type, title, prompt, files; **Workspace**: projects, branch, isolate, branch name; **Agent**: pipeline / agent / harness, mode, model, effort, speed)? Put rarely changed settings behind progressive disclosure, for example an "Advanced" collapsible holding branch name, model/effort/speed, or a one-line summary such as "Claude Code · Opus 5.5 · High · Code" that expands? Which fields does the owner touch on most tasks?
4. **Harness selection at scale.** With 7+ accounts the 2-column button grid truncates names. Options: keep the grid at a wider width; switch to a searchable combobox with icon, status dot and stack position; or use a one-column list. Also, should the panel widen (`w-80` → `w-96`) or become resizable (stored in localStorage like the collapse state)?
5. **Visual language decisions.** Should a selected toggle use a subtle selected style (accent background + ring) instead of the solid primary CTA style? Which control height becomes the standard: `h-8` (dense, matches the sidebar) or `h-9` (the primitives' default)? Native `<select>` or the custom `SearchSelect` for Model and Effort? Introduce rem-based small text tokens (for example `text-2xs` = 0.6875rem) so helper text follows the Cmd+/− font size, in these surfaces only or app-wide?
6. **Dialog layout.** Keep the issue and PR dialogs as one `max-w-lg` column that mirrors the panel, or move to a wider two-column dialog (prompt and context on the left, workspace and agent settings on the right)? Should we add shared `DialogHeader` / `DialogBody` / `DialogFooter` parts to `ui/dialog.tsx` and adopt them in these dialogs (and later in the others)?
7. **Bugs found on the way.** Should the redesign fix them in scope? (a) Finding 2: Fast dropped for claude-code/codex in New Task. (b) Finding 3: false `@author` warnings in the issue dialog; fix by ignoring handles taken from the seeded issue text, by dropping `@` from author names in the prompt (shared with `agetor add --issue`), or by suppressing the warning for seeded content. (c) The panel has no pipeline preflight. (d) The dialogs don't remember speed or max mode.
8. **Actions and copy.** One vocabulary for the create action: "Run task" / "To backlog" vs "Create & start" / "Cancel"? Add Cmd/Ctrl+Enter to submit (and which action it triggers in the panel: Run or Backlog)? Keep the CLI-version text in the panel header?
9. **Test churn.** Is it OK to update the ~15 e2e specs' DOM-path locators (and move them onto stable test ids such as `new-task-model-select` and `new-task-mode-select`), or must the redesign keep today's DOM anchors?
10. **Acceptance bar.** Which counts as done: before/after screenshots in both themes for each surface, a written component and style spec (tokens, sizes, spacing, states) committed under `docs/`, or both? Is any accessibility bar expected beyond label association and keyboard parity?

## 5. Completeness inventory
- **Callers and consumers**
  - `App.tsx:2740-2786` mounts `NewTaskForm` and owns `onSubmit` (`api.createTask` + `startAndNotifyBranch`).
  - `GitHubDialog.tsx:7461` mounts `CreateTaskFromIssueDialog`; `GitHubDialog.tsx:8169` mounts `ResolveConflictsDialog`.
  - `TaskLaunchPickers` consumers: `CreateTaskFromIssueDialog.tsx:421`, `ResolveConflictsDialog.tsx:254`, `CloneProjectDialog.tsx:427`, `AgentProfileFormDialog.tsx:338`.
  - `PromptComposer` consumers: `NewTaskForm.tsx:887`, `CreateTaskFromIssueDialog.tsx:394`, `ResolveConflictsDialog.tsx:233`, `RunPanel.tsx:4985`.
  - `WorktreeOptions`: `NewTaskForm.tsx:911`, `CreateTaskFromIssueDialog.tsx:414`, `ResolveConflictsDialog.tsx:252` (locked).
  - `TaskTypePicker`: `NewTaskForm.tsx:875`, `CreateTaskFromIssueDialog.tsx:389`.
  - `SpeedPicker`: the panel (`new-task-speed`), `TaskLaunchPickers` (`launch-speed`), RunPanel task details (`task-speed`).
  - `AgentProfilePicker` and `PipelinePicker` also appear in `pipelines/StepPanel.tsx:156,263`.
  - `StackPositionChip` and `AgentIcon` are also used by the App Bar and TaskCard, which **peer agents are redesigning** (see section 7).
- **Entry points to wire into**: there is no new route or registry. Any new primitive goes under `src/mainview/components/ui/`, plus a `components.json` alias if needed. The onboarding focus hook is `App.tsx:2044` → `focusNonce`. The collapse key is `NEW_TASK_PANEL_COLLAPSED_KEY` in `lib/panel-collapse.ts`. Any new section-collapse key belongs there too.
- **Propagation surface**: the create payload type (`NewTaskForm` `Props.onSubmit` `:77-112`, `api.createTask`) stays unchanged. The pure mappings that must stay single-source are `lib/worktree-payload.ts` (`selectionPayload`), `shared/model-catalog.ts`, `shared/speed.ts`, `lib/pipeline-launch.ts` and `lib/stack-launch.ts`. Test ids that e2e relies on (keep or migrate deliberately): `prompt-textarea`, `task-type-picker`, `isolate-toggle`, `branch-name-input`, `select-projects-button`, `selected-branches`, `branch-row-<name>`, `refresh-models`, `new-task-speed[-tier]`, `new-task-pipeline-picker|summary|clear`, `agent-profile-picker[-trigger|-popover|-row|-clear|-manage]`, `pipeline-picker-trigger`, `launch-pipeline-*`, `launch-speed`, `launch-max-mode-toggle`, `launch-agent-unavailable-hint`, `launch-stack-fallback-hint`, `agent-profile-harness-unavailable`, `issue-task-dialog`, `issue-task-submit`, `resolve-conflicts-dialog`, `resolve-conflicts-submit`, `worktree-options[-locked]`, `locked-branch`, `refs-*`, `stack-position-chip`. Accessible names that are asserted: the buttons "Run task" and "To backlog", harness buttons by exact label (`getByRole("button", { name: "Codex", exact: true })`), "Collapse/Expand new task panel", the placeholder "Short description", and the dialog name "Select projects".
- **Existing data to backfill**: none. Preferences read and written: `lastMode|lastModel|lastEffort|lastSpeed|lastMaxMode:<kind>`, `defaultHarness`, and localStorage `agetor:*` collapse keys. Any new remembered layout state should use a new localStorage key.
- **Docs that describe current behavior** (update them in the same change): `docs/architecture/prompt-composer.md`, `issue-tasks.md` (the dialog's composition paragraph), `harnesses.md:30-34` (Speed, "NewTaskForm remembers"), `agent-profiles.md:41-42`, `pipelines.md:151-155` (New Task and Git dialog pipeline pickers), `clone-repository.md:61-62`, `multi-repo-tasks.md` (Select Projects control), `harness-stacks.md:1871`, plus the CLAUDE.md "UI conventions" section if new tokens or primitives become conventions.
- **What the change would orphan**: if the panel adopts the shared launch block, `NewTaskForm`'s local launch state (about 450 lines: `agentCache`, seed effects, `switchAgent`, the duplicated JSX at `:917-1247`) goes away. The per-kind cache and pending-seed logic must move into `useTaskLaunch`, or be dropped by decision. `TaskLaunchPickers`' header comment ("ResolveConflictsDialog itself is refactored onto this module in a later change") is stale today.

## 6. Runnability
- **Setup**: `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`, then `bun install` (done in this worktree). For live UI iteration use `bun run dev:hmr` (Vite :5173 + Electrobun) against `~/.agetor-dev`, never `~/.agetor`.
- **Type check**: `bun run typecheck`.
- **Unit tests**: `bun test`. Component tests render with `react-dom/server`'s `renderToStaticMarkup` (no DOM) and assert on markup strings and test ids, for example `src/mainview/components/kanban/WorktreeOptions.test.tsx` (labels "Isolate", "Branch · api", "Always on when more than one project is selected."), `ProjectSelection.test.tsx` and `SelectProjectsDialog.test.tsx`.
- **E2E**: `bun node_modules/@playwright/test/cli.js test [spec]` (not `bunx`). It needs a free Vite port, so set `AGETOR_E2E_VITE_PORT` and `AGETOR_E2E_PORT_OFFSET` when other worktrees run e2e. Fixtures: `e2e/fixtures.ts` (a headless core per worker), `e2e/helpers.ts:483-620` (Select Projects helpers), `e2e/github-stub.ts`. The most affected specs: `issue-task`, `resolve-conflicts`, `select-projects`, `multi-repo-task`, `agent-profiles*`, `pipelines-run`, `speed-picker`, `claude-models`, `codex-models`, `copilot-harness*`, `cursor-stream`, `fx-models`, `fx-interactions`, `fx-recovery`, `opencode-harness`, `clone-project`, `at-file-*`, `branch-scoped-capabilities`, `onboarding`, `backlog-collapse`.
- **Visual baseline recipe**: copy `e2e/issue-task.spec.ts`'s setup (lines 1-626) into `e2e/zz-tmp-*.spec.ts`, add `page.screenshot` / `locator("aside").first().screenshot` calls with `test.use({ viewport: {width:1440,height:1900}, deviceScaleFactor: 2, colorScheme: "dark" })`, run it, and delete it. A `testDir` outside `e2e/` doesn't load (section 2).

## 7. Risks and blast radius
- **Parallel UI redesigns** in the fleet on other branches: the App Bar harness chips (`fix/agetor-app-bar-ui-improvement`), the TaskCard (`fix/agetor-card-ui-improvement`), and the message-preview image chip (`fix/agetor-broken-for-visibility-file`). Likely collision points are `ui/*` primitives, `index.css` / `tailwind.config.js` tokens, `StackBadge.tsx` (`StackPositionChip`), `AgentIcon.tsx`, and `ReferencesPicker.tsx`'s chips. A coordination message was sent on 2026-11-18. Expect merge conflicts unless one branch owns the shared primitives.
- **RunPanel regression** through `PromptComposer`: any default-style change shows up in the send dock unless it is variant-gated (RunPanel passes many layout slots; see `prompt-composer.md`).
- **Settings → Agents and the Clone dialog** change visually if `TaskLaunchPickers` is restyled or replaced. `e2e/agent-profiles-*` and `e2e/clone-project.spec.ts` assert the "Harness" label's presence and absence.
- **Escape/Tab contract**: every new popover or combobox inside a dialog must carry `data-popover-open` correctly, or the issue and PR dialogs can't be closed from the keyboard.
- **Hidden behavior in `NewTaskForm`** that a unification could lose: the per-kind cache, pending seeds for catalog-only models, the `modelTouched` guard, preferences seeded after the catalog, the stale-profile and stale-pipeline guards (m19), `effectiveStatus` vs `selectedStatus` (F2-3), the gemini overage check keyed on the pipeline's start step (L-A8), the sticky Isolate across submits, the spotlight and `focusNonce`, the aside-wide drop zone (not armed while collapsed), and the collapse rail. Each needs a test before moving.
- **Theme parity**: restyled selected states must be checked in both themes. The light-mode Agent trigger already reads differently from the Pipeline trigger in the baseline.

## Sources (web)
- [shadcn/ui: Field component (Field, FieldSet, FieldGroup, FieldLabel, FieldDescription, FieldError; `role="group"`, `htmlFor`, `data-invalid`)](https://ui.shadcn.com/docs/components/radix/field)
- [shadcn/ui v3 docs, the line for Tailwind v3 projects (`components.json` "new-york")](https://v3.shadcn.com/docs/components-json)
- [NN/g: 4 principles to reduce cognitive load in forms (grouping into sections)](https://nngroup.com/articles/4-principles-reduce-cognitive-load)
- [Infor design: form pattern (accordions and progressive disclosure for optional or advanced fields)](https://design.infor.com/patterns/interactions/form/)
- [UX Planet: inline segmented controls instead of dropdowns for 2–5 options](https://uxplanet.org/building-great-mobile-forms-2fa8e9a258cc?imm_mid=0ed72d)
- [Smashing Magazine: designing efficient web forms (single column, labels, actions)](https://www.smashingmagazine.com/2017/06/designing-efficient-web-forms)
