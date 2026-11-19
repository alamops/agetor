# Plan — New Task panel and task-launch surfaces: one UI pattern

| Field | Value |
| --- | --- |
| Date | 2026-11-18 |
| Source | Pipeline task text and the owner's screenshot (outside the repo, transcribed in the investigation §1); `docs/plans/new-task-ui-ux-investigation.md`; `docs/plans/new-task-ui-ux-grill.md` (the contract) with `docs/plans/new-task-ui-ux-grill/round-{1,2}/answers.json` |
| Flags | none |
| Gates | grilled (2 rounds, complete, no one-way doors); approved by owner as written on 2026-11-18, with the §8 assumptions as defaults |
| Status | implemented on the branch; code-review rounds 1–4 fixed (see "Execution notes — review round 1", "— review round 2", "Review round 3" and "Review round 4"). The full e2e suite (532 tests) was green at round 1; round 2 re-ran only the affected specs (listed in its notes). Deviations are listed under "Execution notes" at the end. |
| Branch | `fix/agetor-new-task-ui-improvement` |
| Base SHA | `4d7f8bfb93320076aa86292d614d84d4b883ba7d` |

Decision ids (S1–S7, L1–L8, V1–V7, B1–B3, C1–C3, P1–P3) refer to the grill record. Assumptions this plan adds are A1–A14 in §8.

## 1. Objective & success criteria

**Objective.** The New Task panel and every surface that starts a task get one component and style pattern, and their UX improves by current form-design practice. Every feature stays reachable, and three bugs found on the way are fixed. The surfaces are the panel, "Work on this with Agetor" (issue), "Resolve with Agetor" (PR conflicts), Select projects, Branch naming, Clone → "Explain this repository", the Settings → Agents profile form, and the RunPanel send box.

Each criterion names the production path that produces it and the test that drives that path.

| # | Criterion | Production path | Proven by |
| --- | --- | --- | --- |
| SC1 | **One launch implementation** (S3). The panel's harness/mode/model/effort/speed/max-mode state comes from `useTaskLaunch`. `NewTaskForm.tsx` keeps no local copy: no `agentCache`, `pendingSeed`, `modelTouched`, `switchAgent` or `prefsLoaded`. | `App.tsx:2741` → `NewTaskForm` → `useTaskLaunch(true, { source })` (`lib/use-task-launch.ts`) → `TaskLaunchPickers` | `lib/launch-state.test.ts` (pins); `e2e/launch-behaviors.spec.ts` is green before the move (W1), after it (W2) and after the redesign (W4), with the spec body unchanged; `launch-style-guard.test.ts` greps the names |
| SC2 | **Every drifted behavior on every launch surface** (S4): model ↻; three-state status dot; rich harness tooltip; the unavailable/not-logged-in hint directly under the harness picker; Fable/Mythos 2x notes; per-kind cache on harness switch; remembered Speed and Max Mode; pipeline preflight and its loading/error/empty hints; "Manage agents…" in the Git dialogs | `TaskLaunchPickers` (sections layout) rendered by the panel and by both Git dialogs, all fed by `useTaskLaunch` | `e2e/launch-parity.spec.ts` runs one assertion table against the panel, the issue dialog and the PR dialog |
| SC3 | **Run is gated on harness availability** (S5) and on the pipeline preflight. The reason is shown as visible text. **Add to backlog** stays enabled. | `launchGate()` (`lib/launch-state.ts`) → `LaunchFooter` | `e2e/new-task-submit.spec.ts`; `e2e/copilot-harness-availability.spec.ts` (flipped, see T9) |
| SC4 | **Sections** Task / Workspace / Agent (L1). Workspace and Agent collapse to a summary line, and More options hides the rare fields (L2–L4). Both states persist per surface in localStorage. A non-default value or an error behind a closed control is announced on its toggle row. | `LaunchSection` + `MoreOptions` (`kanban/LaunchSection.tsx`) ← `lib/panel-collapse.ts` keys | `e2e/launch-layout.spec.ts` (persistence across reload; announcement; frequent fields never hidden) |
| SC5 | **Resizable panel**: 320–560 px, default 384, persisted, resizable by keyboard (L6) | `NewTaskForm` → `ResizeHandle` (`ui/resize-handle.tsx`) ← `lib/panel-width.ts` | `e2e/launch-layout.spec.ts` (drag, arrows, Home/End, reload, clamps) |
| SC6 | **Git dialogs in two columns** at ≥768 px viewport (`max-w-4xl`), one column below. The footer is sticky. The actions are Cancel and Run task (L7, C1). | `CreateTaskFromIssueDialog`/`ResolveConflictsDialog` → `DialogHeader/Body/Footer` + `LaunchFooter` | `e2e/launch-layout.spec.ts` (1280 px and 700 px viewports; footer visible after scrolling) |
| SC7 | **One visual system** (V1–V7): one picker family and no native `<select>` in the in-scope files except the listed exceptions; `h-9 text-sm` fields and toggles; subtle selected state; Switch for Isolate; Dialog parts; every control has an associated label; `text-2xs`/`text-3xs` instead of `text-[11px]`/`text-[10px]` in the in-scope files | the primitives in `src/mainview/components/ui/` (W1) used by every in-scope file | `src/mainview/launch-style-guard.test.ts` (static scan of the in-scope files); `getByLabel` assertions for every field name in `e2e/launch-layout.spec.ts` |
| SC8 | **B1**: Fast chosen in the panel is submitted for claude-code and codex | `NewTaskForm.submit` → `submitPicks()` → `App.onSubmit` → `api.createTask` | unit `submitPicks` test (observed red against the `:724` expression); `e2e/new-task-submit.spec.ts` reads the stored task's `speed` |
| SC9 | **B2**: no false "`@author` doesn't match a project file" warning in the issue dialog | `PromptComposer` unlisted-token filter (`:726`) → `isHandleLikeAtToken()` | `lib/at-highlight.test.ts`; `e2e/issue-task.spec.ts` assertion (warning absent for an author handle, still present for `@missing/file.ts`) |
| SC10 | **B3**: the stale `TaskLaunchPickers` header comment (`:49-57`) is rewritten | `TaskLaunchPickers.tsx` / `lib/use-task-launch.ts` | review |
| SC11 | **Copy and keyboard** (C1–C3): **Run task** everywhere; **Add to backlog** in the panel; **Cancel** + **Run task** in the dialogs. Cmd/Ctrl+Enter triggers Run task and is inert while a popover or autocomplete is open or while Run is disabled. The panel header no longer shows the CLI version. | `lib/use-submit-shortcut.ts` scoped to the panel `<aside>` and each dialog's content root; `LaunchFooter` | `e2e/launch-keyboard.spec.ts` |
| SC12 | **RunPanel send box** redesigned (S2). The send keys keep their current behavior: Enter sends, Shift+Enter inserts a new line, Cmd/Ctrl+Enter sends (it already does). | `RunPanel.tsx` dock (`:4950-5290`) → `PromptComposer` slots | `e2e/launch-keyboard.spec.ts` (send-key parity); existing RunPanel specs stay green |
| SC13 | **Style spec** `docs/architecture/task-launch-ui.md`, a CLAUDE.md Topic map row, and every doc that describes the old UI updated | docs | review checklist in T21 |
| SC14 | **Before/after screenshots** of every in-scope surface in both themes, send box included, attached to the PR (not committed) | temporary capture spec (T0 before, T22 after) | the image set exists for every row of the T0 list |
| SC15 | **All green**: `bun run typecheck`, `bun test`, the full e2e suite. None of the retired test ids is left in `e2e/` or `src/`. | — | W4 and W5 barriers |

## 2. Context & constraints

### Grounded findings (file:line at `4d7f8bfb`)

**`src/mainview/components/kanban/NewTaskForm.tsx` (1282 lines)** is the panel. It keeps its own launch state:
- `:228-300`: available harnesses and the one-time `defaultHarness` seed, with a fallback to the first available harness when the selected one disappears.
- `:329-352`: per-kind cache (`agentCache`), `pendingSeed` and `modelTouched` refs.
- `:366-433`: the mount-once seed from `listPreferences()`. For every kind it reads `lastMode/lastModel/lastEffort/lastSpeed/lastMaxMode:<kind>`. A model the curated list lacks, and every model of a `CLI_AUTHORITATIVE_CATALOG_KINDS` kind, becomes a pending seed.
- `:435-450`: `switchAgent` stashes the current picks and restores the next kind's.
- `:504-510`: `changeModel` marks `modelTouched` and resets Speed when the tiers are known.
- `:514-543`: the pending-seed effect (`seedModelStep`: wait/apply/default, `confirmed`).
- `:544-570`: the effort, speed, max-mode and mode fallback effects.
- `:592-623`: the profile stale guard (non-empty list) and the m19 pipeline stale guard (`pipelinesLoaded`).
- `:652-692`: `effectiveAgent/Kind/Status` (F2-3) and the overage check keyed on the pipeline start step (L-A8).
- `:694-767`: `canSubmit` (it has no availability gate) and `submit`.
  - **B1 is at `:724`**: `speed: … (kind === "cursor" || kind === "fx" ? speed : "off")`.
  - The prefs are written at `:747-756`.
- Markup:
  - `:867-871`: the header CLI version (C3).
  - `:923-959`: the pipeline picker and summary (`new-task-pipeline-*`; no preflight, no hints).
  - `:1012-1055`: the harness 2-column `Button` grid. The status dot is green/red and availability defaults to `true`; the rich tooltip is at `:1027-1039`.
  - `:1057-1108`: the Mode pills plus a `SearchSelect` (`h-8`).
  - `:1110-1173`: Model, with `refresh-models` and a native `Select h-8`, and Effort, also a native `Select`.
  - `:1175-1202`: Max Mode, then Speed (`new-task-speed`).
  - `:1204-1220`: the 2x notes.
  - `:1222-1243`: the unavailable hint at the end of the block.
  - `:1250-1276`: the footer ("To backlog", "Run task").
- Panel chrome: collapse at `:173-178` (`NEW_TASK_PANEL_COLLAPSED_KEY`), `focusNonce` spotlight at `:179-209`, aside-wide drop zone (not armed while collapsed) at `:776-793`, `w-80` / `w-11` rail at `:806`, clip layer at `:840-858`.

**`src/mainview/components/kanban/TaskLaunchPickers.tsx` (1007 lines)** holds the hook and the view the dialogs use.
- The header comment at `:49-57` is stale (B3).
- `useTaskLaunch` at `:207-650`:
  - It fetches harnesses, models and prefs itself on `open` (`:376-457`) and resolves the seed for the chosen kind only (`resolveSeedModel`).
  - It has no per-kind cache: `switchAgent` at `:514-525` resets to the kind defaults.
  - `rememberPicks` at `:553-561` writes only 3 prefs.
  - It has no profile stale guard. The pipeline stale guard and the preflight are at `:346-371`.
  - `effectiveLaunchable` is at `:582`.
- The view at `:669-979`:
  - harness grid at `:856-911` (three-state dot; hint directly under the grid),
  - native `Select` for Mode at `:913-920`,
  - Model/Effort at `:922-948` (no ↻),
  - Speed, then Max Mode, at `:950-972`.
- `createAndStartTask` is at `:992-1007`.

**The other consumers:**
- `CreateTaskFromIssueDialog.tsx:292-455`: `max-w-lg`, hand-rolled header/body/footer, "Create & start" at `:449`.
- `ResolveConflictsDialog.tsx:164-288`: the same shell, with the `locked` worktree.
- `CloneProjectDialog.tsx:427`: `TaskLaunchPickers` inside `<fieldset disabled={busy}>`, so every picker trigger must be a native `<button>`. The native provider `Select` is at `:326`.
- `AgentProfileFormDialog.tsx:225-249,338`: `useTaskLaunch(true, { initial })` plus `trackLaunchInteractions`.
- `lib/agent-profile-form.ts:28-35` (`LAUNCH_INTERACTION_SETTERS`): the Settings form's dirtiness tracker wraps exactly `switchAgent`, `setMode`, `setModel`, `setEffort`, `setSpeed` and `setMaxMode`.

**Shared blocks:**
- `WorktreeOptions.tsx`:
  - locked variant at `:272-302`, with a native checkbox at `:297`;
  - live `Branch · project` summary button at `:353-383`;
  - native Isolate checkbox at `:386-401`;
  - Branch name with gear and "Reset to pattern" link at `:403-460`.
- `ProjectSelection.tsx` owns `SelectProjectsButton`.
- `TaskTypePicker.tsx`: a `Button` grid (`variant="default"` when selected).
- `SpeedPicker.tsx`: `aria-pressed` buttons with test ids `${testId}-${tier}`. It has three consumers, including RunPanel task details (`task-speed`).
- `AgentProfilePicker.tsx:113-250` and `pipelines/PipelinePicker.tsx:99-230`: each has its own combobox (listbox, activedescendant, `min-h-9`). Both are also used in `pipelines/StepPanel.tsx:156,263`.
- `PromptComposer.tsx`:
  - `:726`: the unlisted-token filter, where B2 goes;
  - `:932-953`: the warning copy;
  - `:1054-1056`: where the warning renders.
  - The file contains a literal zero-width space, so BSD grep prints nothing for it. Use the Grep tool or `grep -a`.

**Primitives** (`src/mainview/components/ui/`):
- `dialog.tsx` has no Header/Body/Footer parts. Escape yields only to a `[data-popover-open]` marker **inside the dialog panel** (`:150`), plus a document-wide `[role="menu"]` exception (`:151`).
- `search-select.tsx` has no listbox roles and no arrow-key navigation. Its marker sits on the floating panel.
- `info-tip.tsx` portals its panel and puts the marker on that portaled panel (`:105-112`), so a dialog never sees it.
- `button.tsx` uses `disabled:pointer-events-none`: a disabled button shows no `title` tooltip. A gate reason must therefore be visible text.
- `switch.tsx` is a `<button role="switch">`.
- The repo has no Field, Label, Checkbox, segmented control or picker primitive.

**App wiring** (`App.tsx`):
- `profiles` (`:279`) and `pipelines` (`:353`) come from the module-cached `useAgentProfiles`/`usePipelines`. These are the same caches `useTaskLaunch` reads.
- The panel gets live `agents`/`harnesses`/`harnessStacks`/`agentModels`/`harnessModels` (15 s poll plus SSE-driven model refetch) and `onRefreshModels` (`:864-867`).
- The panel mount is at `:2741-2786`; its `onSubmit` sends column `ready` or `backlog`.
- The `GitHubDialog` mount (`:3053-3065`) passes `onOpenPipelines={openPipelinesFromGit}` (`:2600-2603`) and has no "manage agents" callback. `GitHubDialog.tsx` threads `onManagePipelines` into the issue dialog (`:7469`) and the PR dialog (`:8177`).

**RunPanel send dock** (`RunPanel.tsx:4950-5290`):
- read-only bars: pipeline parent (`:4950`), archived (`:4954`), "Viewing a background agent" (`:4958-4973`);
- `PromptComposer`, with `actions` (Save for later, Commit & push, Create all PRs, Create PR, Resolve Conflicts) at `:5030-5160` and `trailing` Send (`h-16 w-12`) at `:5205-5220`;
- `onKeyDown` at `:5255-5275`: Enter without Shift sends, or stashes when the task can't send. **Cmd/Ctrl+Enter already sends**, because the handler ignores modifiers. No other Cmd/Ctrl+Enter binding exists in `src/mainview` (`metaKey`/`ctrlKey` appear only in `find-shortcut.ts`, `font-size.ts` and `terminal-keys.ts`). So C2's parity assumption holds with no conflict.

**Layout persistence:**
- `lib/panel-collapse.ts`: generic `readCollapsed(key)`/`writeCollapsed(key)` with one key.
- `lib/panel-width.ts`: RunPanel-only constants and clamp.
- RunPanel's resize handle (`RunPanel.tsx:516-536, 642-649`: `role="separator"`, `aria-valuenow`, arrow keys, `data-testid="run-panel-resize"`) is the pattern to mirror.

**Tokens:** `tailwind.config.js` has no `fontSize` extension, so `text-2xs`/`text-3xs` are new keys. Font sizes aren't CSS variables, so `index.css` needs nothing. A class used before the token lands emits no CSS.

**e2e** (80 specs):
- 54 specs scope the panel as `locator("aside").first()`.
- Model is reached through the `refresh-models` XPath in 7 specs, Effort through its label's XPath in 5, Mode through its label's XPath in 6.
- `selectOption` is used on launch selects; `clone-project.spec.ts:111-115` has a `launchSelect` helper.
- Harness buttons are clicked by exact role name in copilot-harness, copilot-harness-availability, cursor-stream and codex-models.
- Type buttons: `issue-task.spec.ts:998-1000`.
- Speed `aria-pressed`: `agent-profiles-settings.spec.ts:824-825,1182`; `speed-picker.spec.ts:323-324,498`.
- "To backlog" appears in 4 specs, "Create & start" in issue-task and resolve-conflicts.
- `isolate-toggle` is used in 11 specs with `.check()`/`.uncheck()`/`toBeChecked()`. **Playwright 1.62's `kAriaCheckedRoles` includes `switch`**, so those calls keep working on a `role="switch"` button.
- **`copilot-harness-availability.spec.ts:139-142` asserts Run task is enabled for an unavailable harness.** S5 inverts this.

**Unit-test harness:** `bun test` with `root = "src"` (`bunfig.toml`). There is no DOM and no React hook runner. Component tests use `renderToStaticMarkup` (e.g. `WorktreeOptions.test.tsx`). So the hidden behaviors are pinned as **pure functions** (`lib/launch-state.ts`) plus **e2e**.

### Repo standards that apply

Sources: `CLAUDE.md`, and memory where noted.

- Semantic color tokens only. A new color token goes into `index.css` (both themes) and `tailwind.config.js` together. This plan adds font-size keys only, no colors.
- **Popover contract.** `data-popover-open=""` is present only while the popover is open, and the popover closes itself on Escape (`docs/architecture/prompt-composer.md`). A `fixed` overlay portals to `document.body`.
- Layout chrome lives in `localStorage` through `lib/panel-collapse.ts`-style helpers and is read synchronously in a lazy `useState`. Anything that affects a task goes through `api.setPreference`.
- **RunPanel is one long-lived instance.** New per-task state in `RunPanelBody` needs a line in the `[task.id]` reset effect (`docs/architecture/run-panel.md`).
- **WKWebView budget.** No new event stream or poll. The ↻ refresh in a dialog is a one-shot fetch.
- Tailwind v3 and hand-rolled primitives (no Radix). Don't use `bunx shadcn add` (it targets v4): write shadcn-shaped primitives by hand. The `@/` alias is set in both configs.
- Both themes must work. `ThemeProvider` is the runtime source.
- Docs move with behavior. Code comments cite `docs/architecture/<doc>.md`, never a CLAUDE.md section number (`claudemd-citations.test.ts`).
- Owner decisions still standing:
  - Select Projects grill 1–14 (`docs/plans/select-projects-combined-grill.md`): one combined control, read-only per-project Branch rows that reopen the dialog, one shared Branch name, auto-select the most recent project, the selection kept after submit.
  - "One selection" across Pipeline, Agent profile and manual harness (D5).
  - No last-used profile or pipeline (D12).
- Memory:
  - Run e2e as `bun node_modules/@playwright/test/cli.js test` (not `bunx`) with unique `AGETOR_E2E_VITE_PORT`/`AGETOR_E2E_PORT_OFFSET`, and one full-suite run at a time.
  - Dogfood in `~/.agetor-dev`, never `~/.agetor`.
  - Use `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`, and run `bun install` in a fresh worktree.
  - Scripted edits must assert their match count.
  - Subagent briefs must forbid `git stash`/`pop`/`checkout` of files the agent doesn't own.

### Live facts checked

- Peer branches, checked 2026-11-18 with `git log main..refs/heads/<b>` and their grill records:
  - `fix/agetor-app-bar-ui-improvement` (App.tsx chip strip `:2632-2680`; uses `ui/tooltip.tsx` and `ui/context-menu.tsx`),
  - `fix/agetor-card-ui-improvement` (adds a `--warning-solid-foreground` color token in `index.css` and `tailwind.config.js` `colors`; adds a CLAUDE.md Webview rule and a `task-card.md` Topic map row; doesn't change `ui/badge|button|card`),
  - `fix/agetor-broken-for-visibility-file` (AttachmentChips, MdImage, SentFilesCard).

  All three are at the grill stage with no commits. **None adds `text-2xs`/`text-3xs`, Field/Label, a picker or a segmented control.** The expected merge points are `tailwind.config.js` (a different block), CLAUDE.md (adjacent Topic map rows) and `App.tsx` (different regions).
- `src/bun/index.ts` sets no window `minWidth`, so the one-column dialog layout below 768 px is reachable.

## 3. Approach & key decisions

1. **Behavior first, pixels second.** *(Reasoning.)* W2 moves the panel onto the unified hook while keeping today's JSX (only B1 and S5 change). It proves the W1 pin specs still green with their bodies unchanged. W4 then replaces the DOM. The hidden behaviors depend on effect ordering (prefs vs catalog arrival, `modelTouched`), so changing state and DOM in one step would make any regression impossible to attribute.
2. **One hook, two data modes.** *(Evidence: App and the hook already share the profile and pipeline module caches, `App.tsx:279,353`.)* `useTaskLaunch(open, { source })`:
   - With `source`, the panel's mode, harness, status, stack and model data come from App's live props and the ↻ refresh calls `source.refreshModels`.
   - Without `source`, the dialogs self-fetch on open exactly as today, and ↻ does `api.refreshAgentModels(agent)` and refetches both maps.
   - Profiles and pipelines always come from the module caches.
   - Rejected: threading App's data into the 9.9k-line `GitHubDialog` (Clone is also nested inside Select projects), and making the panel self-fetch (it would lose the 15 s refresh and the SSE model updates).
3. **Pure decision logic in `lib/launch-state.ts`.** *(Evidence: there is no React test harness.)* The seed, switch, remember, submit, gate, primary-mode and status-tone rules become pure functions, unit-tested against today's NewTaskForm behavior *before* the move. The hook keeps only the orchestration.
4. **NewTaskForm's seeding algorithm wins** (per-kind cache, pending seed, `seedModelStep`, `modelTouched`), and the dialogs adopt it (S3 keeps the panel's hidden behaviors). A characterization test runs today's dialog seeding (copied into the test as an oracle) against the unified seeding on a fixture matrix. Any divergence is listed in the PR body. *(A9)*
5. **Picker family = a new `ui/picker.tsx`.**
   - It is a combobox and listbox with full keyboard navigation, an optional search box, a row render prop, a footer slot, inline or popover placement, and a portaled `fixed` popover that flips above or below and is clamped to the viewport.
   - **The `data-popover-open` marker goes on the picker's root (inside the trigger's DOM subtree), only while the popover is open.** `Dialog` looks for the marker inside the dialog panel only (`dialog.tsx:150`), and a portaled popover isn't inside it. That is InfoTip's latent bug, and this design avoids it.
   - While focus is inside the popover, the picker handles Escape and Tab itself with `preventDefault`. React's listener on the portal container runs before `Dialog`'s document listener, which then returns early on `defaultPrevented`.
   - `AgentProfilePicker`, `PipelinePicker`, the new `HarnessPicker`, Model, Effort and the Mode variant move onto it (V2's list).
   - `SearchSelect` is left unchanged (P1: no edits to existing primitives' defaults). That includes the Select projects `BranchPicker`: it's already custom, it isn't in V2's list, and `e2e/helpers.ts:592-603` relies on its in-flow `data-popover-open` panel.
6. **`ui/segmented-control.tsx`** (`role="radiogroup"`/`radio`, `aria-checked`, roving tabindex, arrow keys) is used for Type, Code | Plan and the Speed tiers. The Speed test ids keep their names; `aria-pressed` assertions become `toBeChecked()`.
7. **Sections.** *(A4, A8)*
   - `LaunchSection` has a header button (`aria-expanded`, `aria-controls`), a summary line while collapsed, and a body. `MoreOptions` is a disclosure inside an open section.
   - State is kept per surface (`panel`, `dialog`) under `agetor:launch:<surface>:<section>:collapsed` and `agetor:launch:<surface>:<section>:more`. By default every section is open and More options is closed.
   - **A non-default value or an error behind a closed control is announced on the control's row.** Examples: "More options · Speed: Fast"; a danger-toned summary "Branch name is invalid".
   - A selected agent profile's card stays visible even while the profile picker sits behind a closed More options.
8. **Gate.** *(A2, A3)*
   - `launchGate()` returns `{ canRun, canBacklog, runBlockedReason }`. Run requires `effectiveLaunchable && pipelineReady`; neither condition applies to Add to backlog (S5).
   - The reason renders in the footer (`launch-run-blocked-reason`), linked from Run with `aria-describedby`.
   - A harness whose status isn't known yet gets a muted "Checking status…" dot, and Run waits for the status. That is the dialogs' existing `effectiveLaunchable` semantics.
9. **Mode.** `ModeControl` is a Code | Plan SegmentedControl that calls `launch.setMode(CODE_PLAN_MODE[kind].code|plan)`. Clicking Code while a code variant is active does nothing, as today. The per-harness Plan tooltips move to `lib/launch-copy.ts`. The variant picker (Auto / Accept edits / Ask… with hints) appears only when the kind has more than one code variant, and sits behind Agent → More options (S7, L4).
10. **Picks change only through the tracked setters.** `TaskLaunchPickers` and its children change picks only through `switchAgent`, `setMode`, `setModel`, `setEffort`, `setSpeed`, `setMaxMode`, `setAgentProfileId` and `setPipelineId`. Settings → Agents' dirtiness tracker (`lib/agent-profile-form.ts:28-35`) therefore keeps working. A static test enforces this.
11. **Dialogs.** *(A5)* `max-w-4xl` (56rem). At Tailwind `md` (768 px viewport):
    - The body becomes `grid-cols-[minmax(0,1fr)_22rem]`.
    - Left column: context notice, Type, Prompt, Files. Right column: the Workspace and Agent sections, surface `dialog`.
    - Each column scrolls on its own on `md+`. Below 768 px the body is one column with one scroll.
    - `DialogFooter` sits outside the scroll region, so it is always visible.
    - 22rem equals the panel's default content width (384 − 2 × 16 px), so the shared sections render at the width they were designed for.
12. **Cmd/Ctrl+Enter** *(C2, A10)*:
    - Detected by the pure predicate `isSubmitShortcut` (`lib/submit-shortcut.ts`, same shape as `find-shortcut.ts`).
    - `useSubmitShortcut` attaches it to the form root (the panel `<aside>` and each dialog's content root), not the document. It is inert on `defaultPrevented` (an autocomplete consumed the key), while any `[data-popover-open]` is inside the scope, or when `canRun` is false.
    - The Run button shows `<Kbd aria-hidden>⌘↵</Kbd>` (Ctrl ↵ off macOS) and carries `aria-keyshortcuts`, so its accessible name stays exactly "Run task".
    - The RunPanel send box keeps its keys. Its hint reads "Enter to send · Shift+Enter for a new line".
13. **B2** lives client-side in `lib/at-highlight.ts` (`isHandleLikeAtToken`). It applies to the composer's warning filter only. The highlight backdrop, server expansion, the issue prompt text and `agetor add --issue` are unchanged.
14. **e2e without double churn.** W1 adds `e2e/launch-helpers.ts` (implemented on today's DOM) and moves the affected specs onto it. W4 rewrites only the helpers' internals for the new DOM and test ids, plus the semantic changes (C1 renames, S5, radios). The test-id map below is pinned so W4's UI and e2e tasks can code against it in parallel.
15. **Control sizes** *(V3, A6)*. Fields and toggles are `h-9 text-sm`. Footer actions are `size="default"` (`h-9`). Inline secondary actions (↻, gear, Reset to pattern, Change, the send-box toolbar actions, Back to Main) are `size="sm"` ghost or secondary (`h-8`). That is a documented exception for inline actions, not fields.
16. **Delivery** *(A13)*. One branch, with a checkpoint commit per wave. Recommended PR cut: a two-PR stack at the W2 checkpoint.
    - Slice A (W1–W2): foundations, the hook move, B1/B2/B3/S5. The DOM is unchanged except for B1/S5.
    - Slice B (W3–W5): the redesign, the e2e migration, the send box, docs.

    Each slice is green on its own.

### Pinned interfaces (in-wave tasks code against these)

**`lib/launch-state.ts`** (W1-T3):
```ts
export type LaunchPicks = { mode: string; model: string; effort: string | null; speed: Speed; maxMode: boolean };
export type PickCache = Record<AgentKind, LaunchPicks>;
export type PendingSeeds = Partial<Record<AgentKind, { model: string; effort: string | null; applied?: boolean }>>;
export function defaultPicks(kind: AgentKind): LaunchPicks;
export function initialPickCache(): PickCache;
export function seedPickCache(cache: PickCache, prefs: Record<string, string | undefined>): { cache: PickCache; pending: PendingSeeds }; // NewTaskForm :366-433
export function switchPicks(cache: PickCache, fromKind: AgentKind, current: LaunchPicks, toKind: AgentKind): { cache: PickCache; next: LaunchPicks }; // :435-450
export function rememberPickPrefs(kind: AgentKind, picks: LaunchPicks): Array<[key: string, value: string]>; // :749-755 — 5 keys, lastEffort skipped when null, lastMaxMode = String(kind === "cursor" && maxMode)
export function submitPicks(a: { kind: AgentKind; picks: LaunchPicks; profile: AgentProfile | null }): { mode: string | null; model: string | null; effort: string | null; speed: Speed; maxMode: boolean }; // B1: speed = picks.speed for every kind; maxMode only for cursor; profile values when a profile is set
export function primaryModeOf(kind: AgentKind, mode: string): "code" | "plan";
export function modeForPrimary(kind: AgentKind, mode: string, target: "code" | "plan"): string | null; // null = no-op
export function codeVariants(kind: AgentKind, model: string): AgentOption[];
export type StatusTone = "ok" | "warn" | "error" | "unknown";
export function harnessStatusTone(status: AgentStatus | undefined): StatusTone;
export function launchGate(i: {
  title: string; prompt: string; requireTitle: boolean; reposCount: number; worktreeValid: boolean;
  overage: boolean; effectiveLaunchable: boolean; effectiveHarnessLabel: string;
  pipelineSelected: boolean; pipelineReady: boolean; pipelineState: PipelineLaunchState; pipelineProblem: string | null;
}): { canRun: boolean; canBacklog: boolean; runBlockedReason: string | null };
```
**`lib/launch-copy.ts`** (W1-T3): `planModeTooltip(kind)` (the `:1073-1088` table), `CODE_MODE_TOOLTIP`, `harnessTooltip(status, harnessId)` (`:1027-1039` order: email, today's tokens, reason, auth help, path, version), `usageNote(kind, modelId, modelLabel)` (Fable/Mythos, `:1204-1220`), `effortTooltip(kind, hasEfforts)` (`:1154-1160`).
**`lib/launch-summary.ts`** (W1-T3): `workspaceSummary({ projectLabels, baseRefs, isolate, branch })` → `"agetor · current branch · isolated · fix/7c5261"`; `agentSummary({ pipelineName, profileName, harnessLabel, modelLabel, effortLabel, primary })` → `"Claude Code · Opus 5.5 · High · Code"`; `moreOptionsNotes(...)` → the list of non-default rare values (`"Speed: Fast"`, `"Max Mode"`, `"Mode: Accept edits"`, `"Branch name edited"`).
**`useTaskLaunch`** (W2-T7; `TaskLaunchPickers.tsx` re-exports it, its type and `createAndStartTask` so imports keep working):
```ts
export interface LaunchSource {
  harnesses: Harness[]; agents: AgentStatus[]; stacks: HarnessStack[];
  agentModels: AgentModelMap; harnessModels: Record<string, DiscoveredModel[]>;
  refreshModels: (harnessId?: string) => Promise<void>;
}
useTaskLaunch(open, { withProfiles?, withPipelines?, initial?, source?: LaunchSource })
// TaskLaunch keeps every existing field and adds:
refreshModels(): Promise<void>; refreshingModels: boolean; profilesLoaded: boolean;
primaryMode: "code" | "plan"; codeVariants: AgentOption[]; statusTone(harnessId: string): StatusTone;
```
**`TaskLaunchPickers`** (W4-T11): `{ launch; layout: "sections" | "flat"; surface?: "panel" | "dialog"; hideProfilePicker?; onManageProfiles?; onManagePipelines?; disabled? }`. In the `sections` layout it renders the **Agent** `LaunchSection` itself.
**`LaunchSection`** (W3-T10b): `{ id: "workspace" | "agent"; surface; title; summary: ReactNode; tone?: "default" | "danger"; children; more?: { notes: string[]; tone?; children } }`. **`LaunchFooter`** (W3-T10b): `{ primary: { label: "Run task"; onClick; disabled; testId; busy? }; secondary?: { label; onClick; disabled; testId }; reason?: string | null; error?: string | null; shortcutScopeRef }`.
**`Picker`** (W1-T2): `{ value; onChange; items: PickerItem[] (value, label, hint?, disabled?, group?); renderItem?; renderValue?; searchable?; placeholder?; emptyLabel?; footer?; disabled?; id? (for <label htmlFor>); testId?: string /* root; trigger = `${testId}-trigger`, popover `-popover`, search `-search`, options `-option` with data-value */; "aria-describedby"? }`. The trigger carries `data-value={value}`.

### Test-id map (pinned; one `launch-` prefix)

| Element | Test id | Status |
| --- | --- | --- |
| panel root `<aside>` | `new-task-panel` | new; `<aside>` stays the first aside on the page |
| panel resize separator | `new-task-panel-resize` | new |
| sections | `launch-section-workspace`, `launch-section-agent`; `-toggle`, `-summary`; More options `launch-more-<section>` (button) and `launch-more-<section>-region` | new |
| harness picker | `launch-harness-picker` (+`-trigger/-popover/-search/-option`); option `data-value=<harness id>` with accessible name = the harness label; dot `launch-harness-status` with `data-tone` | new; replaces the harness button grid |
| Code \| Plan | `launch-mode` (radiogroup), `launch-mode-code`, `launch-mode-plan` | new |
| Mode variant | `launch-mode-variant-picker` (+ parts) | new |
| Model / ↻ / Effort | `launch-model-picker`, `launch-refresh-models`, `launch-effort-picker` (+ parts) | new; `refresh-models` **retired** |
| Speed | `launch-speed`, `launch-speed-<tier>`, `-hint`, `-note` (radios) | `new-task-speed*` **retired**; RunPanel's `task-speed` unchanged |
| Max Mode | `launch-max-mode-toggle` | kept |
| Pipeline | `launch-pipeline-picker`, `-summary`, `-change`, `-problem`, `-checking`, `launch-pipelines-loading|error` | `new-task-pipeline-picker|summary|clear` **retired** |
| hints | `launch-agent-unavailable-hint`, `launch-stack-fallback-hint`, `launch-usage-note` | `agent-profile-harness-unavailable` **retired** (merged into the first) |
| footer | `launch-run` (panel), `launch-backlog`, `launch-cancel`, `launch-run-blocked-reason`; dialog Run keeps `issue-task-submit` / `resolve-conflicts-submit` | new / kept |
| kept as-is | `prompt-textarea`, `task-type-picker` (now a radiogroup), `isolate-toggle` (now a switch), `branch-name-input`, `select-projects-button`, `selected-branches`, `branch-row-<name>`, `worktree-options[-locked]`, `locked-branch`, `agent-profile-picker*`, `pipeline-picker*`, `issue-task-dialog`, `resolve-conflicts-dialog`, `stack-position-chip`, `send-textarea`, `at-unresolved-warning` | kept |

Accessible names kept: "Run task", "Cancel", "Send", "Expand new task panel" / "Collapse new task panel", placeholder "Short description", dialog "Select projects". Renamed (C1): "To backlog" → **"Add to backlog"**, "Create & start" → **"Run task"**. Field labels resolvable by `getByLabel`: Type, Title, Prompt, Projects, Isolate (worktree), Branch name, Pipeline, Agent, Harness, Mode, Model, Effort, Speed, Max Mode.

## 4. Work breakdown — implementation tasks

Overview (the acceptance for each task is in its card below):

| ID | Wave | Goal | Owned files | Depends on | Risk | Wired by |
| --- | --- | --- | --- | --- | --- | --- |
| T0 | 0 | "Before" screenshots | none in the repo (temp spec deleted; output in the session scratchpad) | — | none | — |
| T2 | 1 | Tokens + UI primitives | `tailwind.config.js`; new `ui/field.tsx`, `ui/picker.tsx`, `ui/segmented-control.tsx`, `ui/kbd.tsx`, `ui/resize-handle.tsx`, `ui/notice.tsx`, `ui/disclosure.tsx`; additive exports in `ui/dialog.tsx`; new `lib/listbox-nav.ts`, `lib/popover-position.ts` + tests; new `components/ui/primitives.test.tsx` | — | none | consumed by W3/W4 tasks |
| T3 | 1 | Pure launch logic + characterization pins | new `lib/launch-state.ts`, `lib/launch-copy.ts`, `lib/launch-summary.ts` + `.test.ts` each | — | state | T7 (hook), T10/T11/T15/T16 |
| T4 | 1 | Layout persistence + submit predicate | `lib/panel-collapse.ts`, `lib/panel-collapse.test.ts`, `lib/panel-width.ts`, `lib/panel-width.test.ts`; new `lib/submit-shortcut.ts` + test | — | none | T10b, T15 |
| T5 | 1 | B2 fix | `lib/at-highlight.ts`, `lib/at-highlight.test.ts`, `components/kanban/PromptComposer.tsx` (filter only) | — | trust (input parsing) | `PromptComposer` (every consumer) |
| T6a | 1 | e2e helper layer + behavior pins + group-A specs moved onto helpers | new `e2e/launch-helpers.ts`, new `e2e/launch-behaviors.spec.ts`; `claude-models`, `codex-models`, `copilot-harness`, `copilot-harness-availability`, `cursor-stream`, `fx-models`, `fx-interactions`, `fx-recovery`, `opencode-harness`, `speed-picker` specs | — | tests | Playwright |
| T6b | 1 | Group-B specs moved onto helpers + B2 e2e | `issue-task`, `resolve-conflicts`, `agent-profiles`, `agent-profiles-dialogs`, `agent-profiles-launch`, `agent-profiles-settings`, `clone-project`, `clone-providers`, `pipelines-run`, `select-projects`, `multi-repo-task`, `at-file-autocomplete`, `branch-scoped-capabilities`, `identifier-inputs`, `harness-stack-switch`, `import-claude-sessions` specs | T6a's pinned helper API | tests | Playwright |
| T7 | 2 | Unified `useTaskLaunch` (S3/S4 behaviors) + B3 | new `lib/use-task-launch.ts`; `components/kanban/TaskLaunchPickers.tsx` (hook removed → re-export; view unchanged except binding) | T3 | state, concurrency (async seeds) | consumed by NewTaskForm (T8) and the 4 dialogs |
| T8 | 2 | NewTaskForm on the hook (old JSX), B1, S5 | `components/kanban/NewTaskForm.tsx`, `App.tsx` | T3, T7 API | state | `App.tsx:2741` |
| T9 | 2 | B1/S5 e2e | new `e2e/new-task-submit.spec.ts`; `e2e/copilot-harness-availability.spec.ts` | T8 | tests | Playwright |
| T10a | 3 | Picker-family consumers | `AgentProfilePicker.tsx`, `pipelines/PipelinePicker.tsx`, `SpeedPicker.tsx`, `TaskTypePicker.tsx`; new `HarnessPicker.tsx`, `ModeControl.tsx`; new `kanban/launch-pickers.test.tsx`; `e2e/launch-helpers.ts` (the Type and Speed helpers only) | T2, T3 | none | T11; StepPanel inherits; Type/Speed are live in the panel and dialogs at once |
| T10b | 3 | Sections, footer, submit hook | new `kanban/LaunchSection.tsx`, `kanban/LaunchFooter.tsx`, `lib/use-submit-shortcut.ts`, `kanban/launch-layout.test.tsx` | T2, T3, T4 | none | T11, T15, T16 |
| T12 | 3 | Workspace block + Select projects + Branch naming | `WorktreeOptions.tsx`, `WorktreeOptions.test.tsx`, `ProjectSelection.tsx`, `SelectProjectsDialog.tsx`, `SelectProjectsDialog.test.tsx`, `settings/BranchNamingDialog.tsx` | T2, T3 | none | T15, T16 |
| T13 | 3 | Composer chrome | `PromptComposer.tsx`, `ReferencesPicker.tsx`, `ExtensionPicker.tsx` | T2, T5 | none | panel, dialogs, RunPanel |
| T11 | 4 | `TaskLaunchPickers` view rewrite | `TaskLaunchPickers.tsx`; new `kanban/TaskLaunchPickers.test.tsx` | T7, T10a, T10b | state | T15, T16, T18 |
| T15 | 4 | Panel redesign | `NewTaskForm.tsx` | T10b, T11 API, T12, T13 | state | `App.tsx:2741` |
| T16 | 4 | Git dialogs redesign + Manage agents wiring | `CreateTaskFromIssueDialog.tsx`, `ResolveConflictsDialog.tsx`, `GitHubDialog.tsx`, `App.tsx` | T10b, T11 API, T12, T13 | state | `GitHubDialog` `IssueActions`/`PullActions` |
| T18 | 4 | Clone (explain) + Settings → Agents | `CloneProjectDialog.tsx`, `AgentProfileFormDialog.tsx`, `lib/agent-profile-form.test.ts` | T11 API | state | `SelectProjectsDialog`, Settings |
| T14 | 4 | RunPanel send box redesign | `RunPanel.tsx` (dock region only) | T2, T13 | state | `RunPanelBody` |
| T19a | 4 | e2e switch, group A | `e2e/launch-helpers.ts` + the group-A specs (T6a list) + `e2e/new-task-submit.spec.ts`. `e2e/launch-behaviors.spec.ts` is not owned by anyone: its body must stay unchanged (SC1). | T15, T11 pinned ids | tests | Playwright |
| T19b | 4 | e2e switch, group B | the group-B specs (T6b list) + `onboarding`, `backlog-collapse`, `run-panel-header` | T16, T18 pinned ids | tests | Playwright |
| T20 | 5 | New e2e specs | new `e2e/launch-layout.spec.ts`, `e2e/launch-keyboard.spec.ts`, `e2e/launch-parity.spec.ts` | W4 | tests | Playwright |
| T21 | 5 | Docs + style spec | new `docs/architecture/task-launch-ui.md`; `CLAUDE.md`; `docs/architecture/{prompt-composer,issue-tasks,harnesses,agent-profiles,pipelines,clone-repository,multi-repo-tasks,harness-stacks,harness-fx,at-file-references,run-panel}.md` | W4 | none | — |
| T22 | 5 | Guards, contrast, "after" screenshots | new `src/mainview/launch-style-guard.test.ts`, `src/mainview/launch-contrast.test.ts`; temp capture spec (deleted) | W4 | tests | `bun test` |
| T23 | 6 | Final verification and report | this plan's `Status`; PR body | all | none | — |

### Task cards

**T0 — "Before" screenshots (orchestrator, before W1).**
Copy `e2e/issue-task.spec.ts`'s setup into a temporary `e2e/zz-tmp-launch-shots.spec.ts` (a `testDir` outside `e2e/` doesn't load; investigation §2). Capture with `colorScheme` dark and light, viewport 1440×1900 @2x, into `<scratchpad>/shots/before/<surface>-<state>-<theme>.png`. Delete the spec. `git status` must be clean afterwards.

Surfaces and states:
- **panel**: empty; filled; Agent popover open; harness grid with 7 harnesses; Mode variant open; Model select open; pipeline selected; profile selected; unavailable harness.
- **issue dialog**: top; bottom.
- **PR conflicts dialog**.
- **Select projects**: stacked on the issue dialog.
- **Branch naming**.
- **Clone → Explain**.
- **Settings → Agents form**.
- **RunPanel send box**: idle; with toolbar actions; background-agent bar; archived notice.

T22 re-shoots the same list after the change, plus the new states (collapsed sections, More options open, one-column dialog).

**T2 — Tokens and primitives (additive; P1).**
- `tailwind.config.js` `theme.extend.fontSize`: `"2xs": ["0.6875rem", { lineHeight: "1rem" }]`, `"3xs": ["0.625rem", { lineHeight: "0.875rem" }]`. No other config change.
- **`ui/field.tsx`**:
  - `Field` provides context `{ id, descriptionId, errorId }` through `useId`.
  - `FieldLabel` (`<label htmlFor>`, `text-xs font-medium text-muted-foreground`), `Label` (standalone), `FieldDescription` (`text-2xs text-muted-foreground`), `FieldError` (`text-2xs text-destructive`, `role="alert"`), `FieldGroup` (`role="group"`, `aria-labelledby`).
  - `useFieldControl()` returns `{ id, "aria-describedby", "aria-invalid" }`.
- **`ui/picker.tsx`** follows the interface pinned in §3.
- **`ui/segmented-control.tsx`**: `{ value, onChange, items: { value, label, icon?, title?, disabled?, testId? }[], "aria-labelledby"?, testId?, size?: "default" | "sm" }`.
- **`ui/kbd.tsx`**; **`ui/resize-handle.tsx`** (`{ value, min, max, onChange, onCommit, onReset, label, testId, side: "right" }`); **`ui/notice.tsx`** (`tone: "info" | "warning" | "danger" | "muted"`, icon, `action?`); **`ui/disclosure.tsx`** (button + region, `aria-expanded`/`aria-controls`, an optional trailing note).
- **`ui/dialog.tsx`**: add `DialogHeader`, `DialogTitle` (takes `id` for `labelledBy`), `DialogDescription`, `DialogBody` (`min-h-0 flex-1 overflow-y-auto`), `DialogFooter` (`shrink-0 border-t`), `DialogClose` (ghost icon button, `aria-label="Close"`). `Dialog`'s own props, classes and keyboard behavior are unchanged.
- Pure helpers: `lib/listbox-nav.ts` (next/prev/home/end with wrap, skipping disabled; type-ahead) and `lib/popover-position.ts` (above/below choice and viewport clamp).

Acceptance:
- (a) A `Picker`'s trigger is `<button type="button">` with `aria-haspopup="listbox"`, `aria-expanded` and `aria-controls`. Inside a `<fieldset disabled>` it is disabled (static markup shows no `disabled` attribute needed; this is proven in `primitives.test.tsx` by rendering inside a fieldset and in Clone's e2e in T19b).
- (b) Closed: no `data-popover-open` anywhere. Open: the marker is on the root element and not on the portaled popover.
- (c) Arrow keys, Home, End and Enter select. Type-ahead works when the list isn't searchable. Disabled options are skipped. Escape closes the popover, calls `preventDefault` and returns focus to the trigger. Tab closes the popover and calls `preventDefault`, so `Dialog` ignores it.
- (d) The popover flips above when space below is under its height, and is clamped 8 px inside the viewport (`popover-position.test.ts`). It closes on an outside mousedown, an outside scroll and a resize.
- (d2) The portal root stops click, contextmenu and drag events from bubbling through the React tree, so a drag over the popover never arms the panel's aside-wide drop zone, and a click never reaches a wrapper's handlers. Keydown and mousedown are *not* stopped, because Dialog's Escape and Tab, the font-size shortcut and outside-click closing all need them. Escape and Tab use `preventDefault` only. (JubarteAI knowledge `e328dc72`, the portaled ContextMenu-in-Dialog analysis.)
- (e) `SegmentedControl` renders `role="radiogroup"` with radios that carry `aria-checked`. Only the checked radio has `tabIndex=0`. The selected style is `bg-accent text-accent-foreground border-primary/60` (subtle, V1). It is never `bg-primary`.
- (f) `FieldLabel`'s `htmlFor` equals the control's `id` in the markup.
- (g) The Dialog parts render as children of the panel, and a `DialogBody` inside a `max-h` flex panel is the only scroll region.
- (h) `bun test`, `bun run typecheck` and the full e2e suite are unchanged and green (no consumer yet).
- (i) The new primitive names are listed in the T2 report so the orchestrator can announce them to the peer agents (P1).

**T3 — Pure launch logic, written before the move (S3 pins).**
Implement the §3 signatures by moving the decision rules out of `NewTaskForm.tsx` (cited lines) and `TaskLaunchPickers.tsx`. Neither file changes in this task. Write the tests first, from today's code. Acceptance (`lib/launch-state.test.ts`):
1. `seedPickCache`:
   - A valid `lastMode/lastModel/lastEffort/lastSpeed/lastMaxMode:<kind>` seeds that kind.
   - An invalid mode or an invalid speed is ignored.
   - A model the curated list lacks becomes a pending seed. So does any model of a `CLI_AUTHORITATIVE_CATALOG_KINDS` kind.
   - An effort unsupported by the seeded model collapses to the default, or to `null` when the model takes no effort.
   - Every kind is seeded in one pass.
2. `switchPicks`: codex(picks X) → claude → codex returns X. Two harnesses of the same kind share one slot.
3. `rememberPickPrefs`: exactly the 5 keys. `lastEffort` is omitted when the effort is `null`. `lastMaxMode` is `"false"` for a non-cursor kind even with `maxMode: true`.
4. `submitPicks` (B1):
   - claude-code with `speed: "fast"` gives `"fast"`, and so does codex.
   - A profile's values replace the manual picks.
   - `maxMode` is false for every kind except cursor.
   - **Observed red**: run this test once with `submitPicks` returning the `:724` expression, and paste the failure into the task report.
5. `primaryModeOf`/`modeForPrimary`: Code while in a code variant returns `null` (no-op); Plan maps to `CODE_PLAN_MODE[kind].plan`.
6. `harnessStatusTone`:
   - unavailable → `error`;
   - available but logged out → `warn`;
   - available → `ok`;
   - status `undefined` → `unknown`.
7. `launchGate`:
   - Missing title (when required), prompt or project → both actions blocked, with a reason naming only what is missing ("Add a title, a prompt and a project" when all three are).
   - Invalid worktree or overage → both actions blocked.
   - Harness not launchable → **only Run** blocked, with the reason "<Harness> can't start: <reason>. Add it to the backlog or pick another harness".
   - Pipeline `checking` or `blocked` → only Run blocked, with that state's text.
   - Everything valid → no reason.
8. **Seeding characterization.** For each kind × {remembered model: curated / catalog-only / unknown} × {catalog: empty / trusted / logged-out}, the unified result after the catalog arrives (`seedPickCache` + the pending step through `seedModelStep`) is compared with the dialog oracle (`resolveSeedModel ?? resolveDefaultModel`, copied into the test file). Every difference is asserted *as a documented expectation* and listed in the T3 report for the PR body. The test fails if a new, unlisted difference appears.
9. `launch-copy` and `launch-summary` produce exactly the strings the current UI renders (Plan tooltips per kind, harness tooltip order, the 2x notes), plus the new summary formats.

**T4 — Layout persistence and the submit predicate.**
- `panel-collapse.ts`: add `launchSectionKey(surface, section)`, `launchMoreKey(surface, section)` and `NEW_TASK_PANEL_WIDTH_KEY = "agetor:newTaskPanelWidth"`. The existing exports are unchanged.
- `panel-width.ts`:
  - Add a generic `clampWidth(width, { min, max, viewportWidth?, maxViewportFraction? })`.
  - Add `NEW_TASK_PANEL_{DEFAULT,MIN,MAX}_WIDTH = 384/320/560`, `readNewTaskPanelWidth(viewport)` and `writeNewTaskPanelWidth()`.
  - Keep a 480 px minimum board: the panel width is capped at `viewport − 480`, and never below 320.
  - The RunPanel exports behave identically: the existing `panel-width.test.ts` cases pass unchanged.
- `submit-shortcut.ts`:
  - `isSubmitShortcut(e, isMac)`: Meta+Enter on macOS or Ctrl+Enter elsewhere; no Alt, no Shift, and not the other modifier.
  - `shouldFireSubmit({ defaultPrevented, scopeHasOpenPopover, canRun })`.
  - Both have tests, including storage that throws (falls back to the default) and junk values.

**T5 — B2.** Add `isHandleLikeAtToken(path)` to `lib/at-highlight.ts`. It is true only when the path has no `/` or `.` and matches `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`. Apply it in `PromptComposer.tsx`'s unlisted filter at `:726`, beside the existing `extensionNames` check, so handle-like tokens are neither warned about nor stat-verified. Acceptance:
- `@octocat` and `@some-user` aren't warned.
- `@missing/file.ts`, `@notes.md` and `@src/` are still warned when unlisted.
- A listed file is never affected: listed tokens don't reach the filter.
- `src/shared/issue-task.ts` and the server-side expansion are unchanged (`git diff --stat` shows neither).
- No other line of `PromptComposer.tsx` changes; T13 owns that file in W3.

**T6a — e2e helper layer and behavior pins (on today's DOM).**
Create `e2e/launch-helpers.ts` with these pinned names. Every function takes a `scope` Locator: the panel, a dialog, or the Settings form.
- `newTaskPanel(page)`, `expandLaunch(scope)`
- `pickHarness(scope, label)`, `expectHarness(scope, label)`, `harnessStatus(scope, label)`
- `pickModel(scope, id)`, `expectModel(scope, id)`, `modelOptionIds(scope)`, `refreshModelsButton(scope)`
- `pickEffort(scope, id)`, `expectEffort(scope, id)`, `effortOptionIds(scope)`, `expectEffortDisabled(scope)`
- `setPrimaryMode(scope, "code"|"plan")`, `expectPrimaryMode(scope, …)`, `pickModeVariant(scope, label)`, `expectModeVariant(scope, label)`
- `speedOption(scope, tier)`, `expectSpeed(scope, tier)`, `expectSpeedTier(picker, tier)` (for any SpeedPicker root, including RunPanel's `task-speed`)
- `pickTaskType(scope, label)`, `expectTaskType(scope, label)`
- `runTaskButton(scope)`, `backlogButton(scope)`, `fillNewTask(page, { title, prompt })`

Every `aria-pressed` assertion on a speed tier and every Type-button locator also moves onto these helpers in W1. T10a can then change those controls to radios in W3 by editing only the helpers.

On today's DOM these use the current locators: native `selectOption`/`toHaveValue`, the harness buttons, the Mode label XPath, and `expandLaunch` as a no-op. Then:
- Add `e2e/launch-behaviors.spec.ts`. Its scenarios each create through the UI and verify through UI state after `page.reload()`, so they don't depend on the DOM shape beyond the helpers:
  - P1: per-kind cache across codex → claude → codex.
  - P2: remembered mode/model/effort/speed per kind after a backlog submit and a reload, using the codex catalog stub from `speed-picker.spec.ts`.
  - P3: a catalog-only `lastModel:claude-code` (set through the preferences API) is applied once discovery lands, using `claude-models.spec.ts`'s stub.
  - P4: the `defaultHarness` pref selects its harness on reload.
  - P5: a selected pipeline deleted through the API is cleared once the list refreshes.
  - P6: a selected profile deleted through the API is cleared.
  - P7: Isolate stays as set across two submits.
- Move the group-A specs' launch locators onto the helpers. Their assertions stay the same.

Acceptance: `launch-behaviors.spec.ts` and every group-A spec pass on the current UI. No spec's assertion changes; only its locators do.

**T6b — Group-B specs onto the helpers, plus B2.**
Move the group-B specs onto the helpers the same way. Replace `clone-project.spec.ts`'s `launchSelect` (`:111-115`) with them. Add the B2 assertion to `issue-task.spec.ts`:
- with the stub issue's author present, `at-unresolved-warning` is absent;
- after typing ` @missing/file.ts` it appears.

Acceptance: all group-B specs green on the current UI, with T5 in the tree.

**T7 — The unified hook (S3, S4 behaviors; B3).**
Move `useTaskLaunch` to `lib/use-task-launch.ts`. `TaskLaunchPickers.tsx` re-exports `useTaskLaunch`, `TaskLaunch` and `LaunchSource`, so existing imports compile. The view keeps its markup. Add:
- (a) **`source` mode.** Data comes from `source`. There is no fetch. `loading` is `false` and `loadError` is `null`.
  - Prefs seed the per-kind cache **once per mount**, through `seedPickCache` and `listPreferences`.
  - `defaultHarness` is applied once, when the first non-empty harness list arrives.
  - When the selected harness disappears from the enabled list, the selection falls back to the first available harness (`NewTaskForm:279-300`).
- (b) **Self-fetch mode** (no `source`) keeps today's fetch-on-open. The cache is re-seeded from prefs **on every open**.
- (c) `switchAgent` uses `switchPicks` (per-kind cache restore) in both modes. `seed()` still overrides after a switch, and `initial` (Settings edit) bypasses prefs and the cache for its kind.
- (d) Pending seed and `modelTouched` (`NewTaskForm:504-543`) in both modes: a user `setModel` marks the kind touched, and a later seed never overrides it.
- (e) A **profile stale guard**, gated on `profilesLoaded`, next to the existing pipeline guard.
- (f) `rememberPicks` writes `rememberPickPrefs` (5 keys) and updates the in-memory cache. It stays a no-op while a profile or pipeline is selected.
- (g) `refreshModels`/`refreshingModels`. Source mode calls `source.refreshModels(agent)`. Self-fetch mode calls `api.refreshAgentModels(agent)` and then refetches `listAgentModels` and `listHarnessModels` into state. No poll, no stream.
- (h) `primaryMode`, `codeVariants`, `statusTone`.
- (i) Rewrite the stale header comment (B3).

Acceptance:
- `lib/launch-state.test.ts`, `agent-profile-form.test.ts` and the full `bun test` pass.
- The e2e specs `launch-behaviors`, `issue-task`, `resolve-conflicts`, `clone-project`, `agent-profiles-settings`, `agent-profiles-dialogs` and `pipelines-run` pass.
- A Settings edit of a profile still shows the profile's own values: the `initial` race fix (F2) holds and `agent-profiles-settings` covers it.
- The dialogs' fetch still runs only while `open` (the network log in `issue-task.spec.ts`'s closed-dialog case shows no `/harnesses` call before opening).

**T8 — NewTaskForm on the hook (old JSX); B1; S5.**
- Replace `:228-300`, `:329-570` and `:588-692` with `const launch = useTaskLaunch(true, { withPipelines: true, source })`. `source` is built from the props.
- Bind the existing JSX to `launch.*`: harness grid → `launch.switchAgent`, Mode → `launch.setMode`, Model → `launch.setModel`, and so on.
- `submit` uses `submitPicks` (which fixes B1) and `launch.rememberPicks()`. The panel's existing `profiles`/`pipelines`/`pipelinesLoaded` props are removed from `NewTaskForm` and from `App.tsx:2741-2754`: the hook reads the same module caches.
- Gate with `launchGate`:
  - **Run task** disabled when `!canRun`.
  - **To backlog** disabled only when `!canBacklog`.
  - The reason renders as `<p data-testid="launch-run-blocked-reason">` above the footer. T15 restyles it.
- In the existing pipeline summary card, render `launch.pipelineProblem` and the `checking` line.

Acceptance:
- `rg -n "agentCache|pendingSeed|modelTouched|switchAgent|prefsLoaded|setRefreshingModels" src/mainview/components/kanban/NewTaskForm.tsx` returns nothing, and the file shrinks by at least 400 lines.
- `launch-behaviors.spec.ts` passes with its body unchanged.
- Every panel spec passes.
- `onboarding.spec.ts` (`focusNonce`) and `backlog-collapse.spec.ts` pass.

**T9 — B1 and S5 e2e.**
`e2e/new-task-submit.spec.ts`:
- (1) claude-code with the claude stub catalog offering Fast: pick Fast, submit "To backlog" (renamed in W4), and `GET /tasks/:id` returns `speed: "fast"`.
- (2) The same for codex with its service-tier stub.
- (3) cursor Fast is still submitted.
- (4) An unavailable harness:
  - **Run task** is disabled;
  - `launch-run-blocked-reason` contains the harness reason;
  - To backlog is enabled and creates a Backlog card.

Flip `copilot-harness-availability.spec.ts:139-142`:
- Run task is disabled with the reason.
- Add to backlog creates the card.
- Starting it from the card is refused with the cask hint, and no run row exists. That keeps the old server-refusal coverage.

Each test is observed red on the W1 checkpoint (B1: the speed is `"off"`; S5: Run is enabled). Record both in the report.

**T10a — Picker-family consumers.**
- Rebuild `AgentProfilePicker` and `PipelinePicker` on `Picker`. Every existing test id, the "None" row and the Manage row stay, and so does the stale-selection display.
- New `HarnessPicker`:
  - searchable;
  - each row shows icon, **full** label, `StackPositionChip`, status dot (`data-tone`; `unknown` is muted, titled "Checking status…") and the account email on a second line;
  - the row's `title` comes from `harnessTooltip`;
  - the option's accessible name equals the label;
  - the trigger shows the current choice.
- Rebuild `SpeedPicker` and `TaskTypePicker` on `SegmentedControl`. Test ids, the "(not offered)" stale tier, the hint and the note stay.
- New `ModeControl`: Code | Plan (with tooltips from `launch-copy`) plus the variant `Picker` with hints.

Because `SpeedPicker` and `TaskTypePicker` change in place and are mounted right away, T10a also updates `expectSpeedTier`, `speedOption`, `expectSpeed`, `pickTaskType` and `expectTaskType` in `e2e/launch-helpers.ts`, for example `toBeChecked()` on `role="radio"`. `speed-picker`, `agent-profiles-settings` and `issue-task` must pass with their bodies unchanged.

Acceptance (`launch-pickers.test.tsx`, static markup):
- No `<select>` is rendered.
- The radio and listbox roles are present.
- The test ids match the §3 map.
- The `unknown` tone is rendered when the status is missing.
- `StepPanel` still compiles and `pipelines-editor.spec.ts` passes.

**T10b — Sections, footer and the submit hook.**
`LaunchSection` and `MoreOptions` follow §3 decision 7. Each reads its state in a lazy `useState` through `readCollapsed(launchSectionKey(…))` and writes it on change. The `MoreOptions` row lists `notes` (for example "Speed: Fast") and carries a danger tone when told to.

`LaunchFooter` follows the pinned props.
- It renders the reason (`aria-live="polite"`) and the error.
- Run is `variant="default"` with a `Kbd` hint (`aria-hidden`) and `aria-keyshortcuts`; the secondary action is `outline`; Cancel is `ghost`.
- A busy state shows "Running…" with a spinner.

`useSubmitShortcut(scopeRef, onRun, canRun)` uses T4's predicates and adds a keydown listener on the scope element only.

Acceptance (static markup plus predicate tests):
- The toggle has `aria-expanded`/`aria-controls` and the summary renders only while collapsed.
- The Run button's accessible text content, without `aria-hidden` nodes, is exactly "Run task".
- The shortcut doesn't fire when `defaultPrevented`, when a `[data-popover-open]` is inside the scope, or when `canRun` is false.

**T12 — Workspace block, Select projects, Branch naming.**
`WorktreeOptions`, both variants:
- Isolate → `Switch` with an associated `FieldLabel`, keeping `data-testid="isolate-toggle"`. The locked variant is checked and disabled.
- `Branch · project` → a visibly clickable row (hover background, chevron, focus ring), keeping `selected-branches` and `branch-row-*`.
- Branch name → `Field` with the gear as a ghost icon button and "Reset to pattern" as a ghost `size="sm"` button.
- `text-2xs`/`text-3xs` replace the px sizes.
- Branch name renders through a `branchName` render slot, so the Workspace section can put it behind More options (T15/T16 pass the section). Pinned prop: `renderBranchName?: (node: ReactNode) => ReactNode`, defaulting to inline.

`SelectProjectsButton` becomes an h-9 field-style trigger.

`SelectProjectsDialog`:
- Dialog parts.
- The row checkboxes stay native (multi-select list semantics) with `accent-primary` and a label.
- The per-project `BranchPicker` (on `SearchSelect`, inline) is left unchanged, so `e2e/helpers.ts:582-603` keeps working (§9).

`BranchNamingDialog`: Dialog parts, `Field`, text tokens.

Acceptance:
- The updated `WorktreeOptions.test.tsx` asserts `role="switch"` and `aria-checked`, and that the label's `htmlFor` matches.
- The updated `SelectProjectsDialog.test.tsx` passes.
- `select-projects`, `multi-repo-task` and `issue-task` (the stacked dialog and the Escape order) pass.

**T13 — Composer chrome.**
- The `PromptComposer` label row uses `FieldLabel htmlFor` pointing at the textarea's `id`. Consumers that pass `label={null}` must pass `textareaAriaLabel` (an additive prop).
- The Extensions trigger is an h-8 ghost button that truncates on one line (no wrap at 352 px).
- Hints, the drop hint and the warning use text tokens.
- Add the additive slot `toolbarEnd?: ReactNode`, right-aligned in the toolbar row.
- `ReferencesPicker` block chrome: `FieldLabel` "Files / Folders" and ghost h-8 actions. **The chip component is unchanged** (the peer attachment-chip branch).
- `ExtensionPicker`: restyle the trigger only.
- No existing prop changes meaning (RunPanel passes many slots; `prompt-composer.md`).

Acceptance:
- `PromptComposer-discovery.test.ts` passes.
- `at-file-autocomplete`, `at-file-truncated`, `branch-scoped-capabilities` and the RunPanel send specs (`quote`, `sent-files`, `pasted-content`) pass.

**T11 — The `TaskLaunchPickers` view.**
Rewrite the view with the T10a/T10b components. `layout="sections"` renders the Agent `LaunchSection`. The summary comes from `agentSummary`, and the danger tone applies while the effective harness can't launch or the pipeline is blocked.

Order inside the section:
1. Pipeline, with its loading/error/empty hints, or the summary card with a ghost "Change" button, the problem and the checking line.
2. If no pipeline is selected: the selected profile card (always visible) with the unavailable, auth and stack-fallback hints.
3. If no profile is selected: the Harness picker, followed directly by the unavailable hint (`launch-agent-unavailable-hint`), `HarnessAuthHint` and the stack-fallback hint.
4. Mode (Code | Plan).
5. Model (with `launch-refresh-models` calling `launch.refreshModels`, spinning while `refreshingModels`) and Effort, in a 2-column grid. The usage note (`launch-usage-note`) goes under them.
6. **More options**: the Agent profile picker (with "Manage agents…" when `onManageProfiles` is given), the Mode variant (when there is more than one), Speed (when `showsSpeedPicker`) and Max Mode (cursor). Its notes come from `moreOptionsNotes`.

`layout="flat"` renders the same fields with no section and no More options. Every field uses `Field` with an associated label.

Acceptance:
- `TaskLaunchPickers.test.tsx` (static markup) checks that:
  - every §3 test id is present in the sections layout;
  - the flat layout has no `launch-more-agent`;
  - no `<select>` is rendered.
- A static scan of `TaskLaunchPickers.tsx`, `HarnessPicker.tsx` and `ModeControl.tsx` finds no `launch.set…` call outside the 8 allowed setters, and no `setPrimaryMode`.

**T15 — Panel redesign.**
- Width: the `<aside data-testid="new-task-panel">` width comes from state. It is read from `readNewTaskPanelWidth(window.innerWidth)`, set with a `ResizeHandle` on the right edge (z-10, below the z-20 collapse toggle), and saved on commit. The transition is off while dragging. Double-click resets to 384. The clip layer uses the state width. The rail stays `w-11`.
- Header: "New task" plus the InfoTip. **No version** (C3).
- Body:
  - **Task**: Type (`SegmentedControl`), Title (`Field`), Prompt plus Files.
  - **Workspace**: a `LaunchSection` with `workspaceSummary` and Branch name in More options through `renderBranchName`, using surface `panel`.
  - **Agent**: `<TaskLaunchPickers layout="sections" surface="panel" onManageProfiles={onOpenSettingsAgents} onManagePipelines={onOpenPipelines} />`.
- Footer: `LaunchFooter` with **Add to backlog** (`launch-backlog`) and **Run task** (`launch-run`), the reason and `useSubmitShortcut` on the aside.
- Kept as-is: the drop zone (not armed while collapsed), the spotlight and `focusNonce` (expand and focus Title), Isolate sticking across submits, and the selection being kept after submit.
- `App.tsx`'s props stay as T8 left them.

Acceptance:
- The onboarding, backlog-collapse and every panel spec (through the T19a helpers) pass.
- `launch-behaviors.spec.ts` passes with only `launch-helpers.ts` changed.
- The aside is still the first `<aside>` on the page.

**T16 — Git dialogs and the Manage agents wiring.**
Both dialogs:
- Dialog parts, `max-w-4xl`, and the two-column body per §3 decision 11 (surface `dialog`).
- The issue context box and the PR merge box become a `Notice` in the left column.
- The issue dialog's left column holds Type, then Prompt and Files. The right column holds the Workspace section (live, with the issue repo locked) and the Agent section via `TaskLaunchPickers`.
- The PR dialog's Workspace section is the `locked` variant.
- Footer: **Cancel** (`launch-cancel`) and **Run task** (keeping the `issue-task-submit`/`resolve-conflicts-submit` ids), the `submitError`, and the shortcut on the dialog content root.
- `canSubmit` comes from `launchGate` (`requireTitle: false`) plus the dialog's own conditions (thread loaded, not submitting).
- **Manage agents.** Add an `onManageAgents` prop. It reuses each dialog's `managePipelines` confirm-then-close flow, generalized to `leaveForPage(navigate)`. `GitHubDialog` threads `onOpenSettingsAgents` through `IssueActions` and `PullActions`. `App.tsx` adds `openSettingsAgentsFromGit` (close the Git dialog, then `openSettingsAgents()`) and passes it.

Acceptance:
- `issue-task`, `resolve-conflicts`, `agent-profiles-dialogs` and `pipelines-run` pass.
- In the issue dialog, "Manage agents…" with a dirty draft asks for confirmation, then lands on Settings → Agents with the Git dialog closed (covered in `launch-parity.spec.ts`).
- The dialogs still fetch nothing while closed.

**T18 — Clone (Explain) and Settings → Agents.**
- `CloneProjectDialog`: Dialog parts; `TaskLaunchPickers layout="flat"` still inside `<fieldset disabled={busy}>`; text tokens; `Field` labels in the Explain block. The provider `Select` stays native (§9).
- `AgentProfileFormDialog`: Dialog parts; `layout="flat"` with `hideProfilePicker`; `Field` labels; the `agent-profile-copy-tasks` checkbox stays native with `accent-primary`.
- In `agent-profile-form.test.ts`, assert that `LAUNCH_INTERACTION_SETTERS` covers every setter T11's static scan allows (except the profile and pipeline setters, which this form hides).

Acceptance: `clone-project`, `clone-providers`, `agent-profiles-settings` and `agent-profiles` pass. Busy-state pickers are disabled through the fieldset (an e2e assertion in T19b).

**T14 — RunPanel send box.**
Dock region only (`:4950-5290`):
- **Read-only bars.** The pipeline-parent, archived and background-agent bars become `Notice tone="muted"`. Background-agent gets an `Eye` icon and a ghost `size="sm"` "Back to Main" button.
- **Toolbar.** One row with `flex-wrap gap-1.5`. Its actions (Save for later, Commit & push, Create all PRs, Create PR, Resolve Conflicts) are `size="sm"` ghost or secondary buttons with `size-3.5` icons. Keep their labels, titles, disabled logic and `data-testid`s.
- **Send.** It moves from `trailing` to `toolbarEnd`: a primary `h-9` button with the Send icon, `aria-label="Send"` and the tooltip "Send — Enter · Shift+Enter for a new line". The live/resume tooltip wording is kept.
- **Textarea.** `text-sm` and `textareaAriaLabel="Message"`.
- **Not changed:** the `onKeyDown` logic, `send()`, `saveForLater()`, the gating, and every per-task state. If any state is added, its reset line goes in the `[task.id]` effect.

Acceptance:
- `git diff` of `RunPanel.tsx` stays inside the dock region and the import list.
- The RunPanel specs pass: `quote`, `sent-files`, `pasted-content`, `run-panel-header`, `cursor-ask`, `fx-interactions`, `messages-backlog` (if present), `pr-merged-state`.
- Send-key parity is covered by T20.

**T19a / T19b — e2e switch to the new DOM.**
- T19a rewrites `launch-helpers.ts`'s internals to the §3 test ids: `Picker` option clicks, the trigger's `data-value`, the radios, and `expandLaunch` opening collapsed sections and More options where needed.
- Then T19a and T19b apply the semantic changes:
  - "To backlog" → "Add to backlog";
  - "Create & start" → "Run task";
  - check that no direct `aria-pressed` or Type-button locator is left (T10a already moved both to radios through the helpers in W3);
  - `div.border-destructive\/40` → `launch-agent-unavailable-hint`;
  - retired ids → their new ids;
  - the Clone busy-fieldset assertion.

Acceptance: at the W4 barrier, `rg -n "refresh-models|new-task-speed|new-task-pipeline|agent-profile-harness-unavailable|To backlog|Create & start" e2e src` returns nothing outside the CHANGELOG/docs history, and the **full** e2e suite is green.

**T20 — New e2e.**

`launch-layout.spec.ts`:
- Workspace and Agent collapse to their summaries (text from `workspaceSummary`/`agentSummary`) and stay that way after a reload. More options does too.
- With More options closed and Speed set to Fast, the toggle row reads "Speed: Fast".
- An invalid branch name behind a closed More options shows a danger-toned summary, and Run and Add to backlog are blocked with a reason.
- The frequent fields (Type, Title, Prompt, Files, Project, Isolate, Pipeline, Harness, Model, Effort, Mode) are visible while their section is open and More options is closed.
- `getByLabel` resolves every §3 field name exactly once.
- The resize handle: drag to 500 px, reload and get 500. ArrowRight +16. Home → 320, End → 560. Double-click → 384. The width is capped by the viewport (480 px minimum board).
- The issue dialog is two columns at 1280×900 and one column at 700×900. After scrolling the left column to the end, the footer is visible.

`launch-keyboard.spec.ts`:
- Cmd/Ctrl+Enter from the Title field runs the task in the panel (a card appears in Ready or Running) and in the issue and PR dialogs.
- It does nothing while a `Picker` is open, while the `/` autocomplete is open, or while Run is disabled.
- Escape in a `Picker` inside the issue dialog closes only the picker; a second Escape closes the dialog.
- Tab moves through the panel's fields in visual order, with no trap.
- Arrow keys with Enter pick a model.
- Send box: Enter sends; Shift+Enter inserts a new line; Cmd/Ctrl+Enter sends; Enter with the slash autocomplete open picks the suggestion and sends nothing.

`launch-parity.spec.ts`. One table, run against the panel, the issue dialog and the PR dialog:
- ↻ issues the refresh request and the model list updates.
- The logged-out stub harness shows `data-tone="warn"`.
- The tooltip contains the account email.
- The unavailable hint is the next sibling block after the harness picker.
- A Fable model shows `launch-usage-note`.
- codex → claude → codex restores the picks.
- Speed and Max Mode are remembered after a launch.
- A blocked pipeline disables Run with the reason.
- The empty, loading and error pipeline hints.
- "Manage agents…" (the dialogs; the panel already had it).

Every new test is shown red against a broken copy of the behavior. For example, comment out the `writeCollapsed` call and the persistence test must fail. Record this in the report.

**T21 — Docs.**
New `docs/architecture/task-launch-ui.md`, the style spec. It covers:
- the surfaces and their layouts, with the section and field order and which fields sit behind More options;
- the picker family and when to use which control;
- control sizes, with the h-8 inline-action exception;
- spacing (`space-y-3` between fields, `gap-1.5` label to control, section padding);
- the type scale (`text-sm` fields, `text-xs` labels, `text-2xs` helper text, `text-3xs` meta);
- the selected, disabled, error, warning and unknown states, and both themes;
- the dialog parts and the two-column rule;
- the popover marker-on-root rule for portaled pickers;
- the submit shortcut and send-key parity;
- the test-id map and the helper layer;
- localStorage keys;
- the gate rule.

CLAUDE.md:
- A Topic map row for `task-launch-ui.md`, covering `NewTaskForm`, `TaskLaunchPickers`, `lib/use-task-launch.ts`, `lib/launch-state.ts`, `ui/picker.tsx`, `ui/field.tsx`, `ui/segmented-control.tsx` and the Git launch dialogs.
- UI conventions bullets: the `text-2xs`/`text-3xs` tokens are the rem-based small sizes for new UI; Field/Label for every control; one picker family; the marker-on-root rule.

Update:
- `prompt-composer.md`: the new slots, `textareaAriaLabel`, the label association, the Isolate switch, and the Select projects Dialog parts.
- `issue-tasks.md`: the dialog composition, the two columns, Run task, Manage agents.
- `harnesses.md:30-34`: "NewTaskForm remembers" becomes the hook remembering for every surface; `launch-speed` everywhere.
- `agent-profiles.md:41-42`: the pickers on `Picker`, and the profile picker behind More options.
- `pipelines.md:151-155`: one picker everywhere, and the panel now has the preflight.
- `clone-repository.md:61-62`: the flat layout.
- `multi-repo-tasks.md:471`.
- `harness-stacks.md:1871`: the hint location.
- `harness-fx.md:145`.
- `at-file-references.md`: the handle-like token rule.
- `run-panel.md`: the send box layout and unchanged keys.

Acceptance:
- `claudemd-citations.test.ts` passes.
- `rg -n "To backlog|Create & start|new-task-speed|refresh-models" docs/architecture CLAUDE.md` returns nothing.

**T22 — Guards, contrast, screenshots.**
`launch-style-guard.test.ts` reads the in-scope files and fails on:
- `<select`, or a `Select` import from `@/components/ui/select`, except `CloneProjectDialog.tsx`'s provider;
- `type="checkbox"`, except `SelectProjectsDialog.tsx` and `AgentProfileFormDialog.tsx`'s `agent-profile-copy-tasks`;
- `text-[10px]` or `text-[11px]`;
- `variant={… ? "default" : "outline"}`, the old selected-state pattern;
- `agentCache|pendingSeed|modelTouched` in `NewTaskForm.tsx`;
- `InfoTip` inside the two Git dialogs, which would hit the portaled-marker Escape bug (§9).

The in-scope files are the T8–T18 component files, the WorktreeOptions family and the dialogs.

`launch-contrast.test.ts` parses the `:root` and `.dark` HSL tokens in `index.css`. It asserts a WCAG contrast of at least 4.5 for these text-on-background pairs in both themes:
- `foreground`/`card`,
- `muted-foreground`/`card`,
- `accent-foreground`/`accent` (the selected state),
- `primary-foreground`/`primary`,
- `destructive`/`card`.

It asserts at least 3.0 for the selected ring `primary` against `card` (a non-text UI boundary). If a pair fails, report it rather than change a token (P1: no edits to existing tokens). The owner then picks a class-level fix.

Finally, run the T0 capture list "after", plus the new states, in both themes.

**T23 — Final.**
- Re-run typecheck, `bun test` and the full e2e suite on the final head.
- Re-check the peer branches for `text-2xs`, `text-3xs`, `ui/field|picker|segmented-control` and Topic map conflicts (`git log main..refs/heads/<peer>`).
- Write the PR body: decisions, the T3 seeding divergences, the screenshots, the assumptions, and the delivery slices.
- Set this plan's `Status` to current.

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| T3 tests | unit | S3 pins, B1, S5, copy and summaries | `lib/launch-state.test.ts`, `lib/launch-copy.test.ts`, `lib/launch-summary.test.ts` | written before T7/T8; B1 observed red against `:724` |
| T2 tests | unit | primitives' roles, attributes, marker, keyboard math, positioning | `lib/listbox-nav.test.ts`, `lib/popover-position.test.ts`, `components/ui/primitives.test.tsx` | as in the T2 card |
| T4 tests | unit | storage fallbacks, clamps, shortcut predicate | `lib/panel-collapse.test.ts`, `lib/panel-width.test.ts`, `lib/submit-shortcut.test.ts` | the RunPanel width cases unchanged |
| T5 tests | unit | B2 | `lib/at-highlight.test.ts` | handles skipped; paths still warned |
| T10a/T10b/T11/T12 tests | unit (static markup) | component structure, ids, label association, no `<select>`, setter scan | `kanban/launch-pickers.test.tsx`, `kanban/launch-layout.test.tsx`, `kanban/TaskLaunchPickers.test.tsx`, `WorktreeOptions.test.tsx`, `SelectProjectsDialog.test.tsx` | as in the cards |
| T18 test | unit | the tracked-setter coverage | `lib/agent-profile-form.test.ts` | the allowed-setter list ⊆ `LAUNCH_INTERACTION_SETTERS` ∪ {profile, pipeline} |
| T22 tests | unit (static) | SC7 guard, AA contrast | `src/mainview/launch-style-guard.test.ts`, `src/mainview/launch-contrast.test.ts` | as in the T22 card |
| T6a | e2e | S3 hidden-behavior pins (assembled flow, SC1) | `e2e/launch-behaviors.spec.ts` | green at W1, W2 and W4 with the same body |
| T9 | e2e | SC3, SC8 | `e2e/new-task-submit.spec.ts`, `e2e/copilot-harness-availability.spec.ts` | red on W1, green on W2 |
| T20 | e2e | SC2, SC4, SC5, SC6, SC11, SC12 | `e2e/launch-layout.spec.ts`, `e2e/launch-keyboard.spec.ts`, `e2e/launch-parity.spec.ts` | each test shown red against a broken copy |

Every test must be able to fail. A missing stub binary or env makes the test fail loudly, never return early.

**E2e applies.** The flows are user-visible, and they cross the webview → HTTP API → SQLite boundary (create, start, preferences). The flows: create from the panel (run and backlog); create from the issue and PR dialogs; harness, model and mode switching with remembered picks; collapse, resize and width persistence; the keyboard paths; the send box.

**Run recipe.**
```bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
bun install                      # fresh worktree only
bun run typecheck
bun test                         # unit (root = src)
# one spec, from a coding agent (unique ports per concurrent agent):
AGETOR_E2E_VITE_PORT=52<NN> AGETOR_E2E_PORT_OFFSET=<NN>00 \
  bun node_modules/@playwright/test/cli.js test e2e/<spec>.spec.ts --workers=1
# full suite: only at a wave barrier, one run at a time:
AGETOR_E2E_VITE_PORT=5197 AGETOR_E2E_PORT_OFFSET=3000 bun node_modules/@playwright/test/cli.js test
```
- `e2e/fixtures.ts` starts a headless core per worker on a temp `AGETOR_DATA_DIR`, with fake drivers and stub harness bins. `e2e/github-stub.ts` serves issues and PRs.
- No credentials are needed. Never point a run at `~/.agetor`.
- For live UI iteration, use `bun run dev:hmr` against `~/.agetor-dev`.
- Screenshots come from a temporary `e2e/zz-tmp-*.spec.ts` (T0/T22), deleted before any commit.

## 6. Execution waves

| Wave | Tasks (parallel) | Barrier |
| --- | --- | --- |
| 0 | T0 | before-screenshot set complete; tree clean |
| 1 | T2, T3, T4, T5, T6a, T6b | typecheck, `bun test` and the **full e2e suite** green on today's UI; announce the primitives and tokens to the peer agents (JubarteAI); checkpoint commit "wave 1: launch foundations, pins, helper layer, B2" |
| 2 | T7, T8, T9 | full green; `launch-behaviors.spec.ts` body unchanged since W1 (`git diff <W1>..HEAD -- e2e/launch-behaviors.spec.ts` is empty); checkpoint. **Slice A ends here.** |
| 3 | T10a, T10b, T12, T13 | full green (the new components aren't mounted by the panel or the dialogs yet, except T12/T13's in-place restyles, whose specs pass through the helpers); checkpoint |
| 4 | T11, T15, T16, T18, T14, T19a, T19b | full green; zero retired ids; `e2e/launch-behaviors.spec.ts` still unchanged since W1; checkpoint. In-wave tasks code against §3's pinned props and test ids. |
| 5 | T20, T21, T22 | full green; guard and contrast tests green; after-screenshots complete; checkpoint |
| 6 | T23 | final report |

- **File-collision check.** No path repeats within a wave. `PromptComposer.tsx` belongs to T5 in W1 and T13 in W3. `NewTaskForm.tsx` belongs to T8 in W2 and T15 in W4. `App.tsx` belongs to T8 in W2 and T16 in W4. `TaskLaunchPickers.tsx` belongs to T7 in W2 and T11 in W4. `e2e/launch-helpers.ts` belongs to T6a in W1, T10a in W3 (Type and Speed helpers) and T19a in W4. `copilot-harness-availability.spec.ts` belongs to T6a in W1, T9 in W2 and T19a in W4.
- **Spec ownership outside the e2e tasks.** T12, T13 and T14 own no spec files. Their restyles keep every existing locator: labels, test ids, placeholders and accessible names (the Isolate switch stays `.check()`-compatible). Their acceptance is "the listed specs pass unchanged". If a spec breaks anyway, the task reports it with the failing locator, and the orchestrator fixes it once at the barrier. No in-wave agent edits a spec it doesn't own.
- **Concurrency.** Coding agents run only their own specs, with unique ports. The orchestrator runs the full suite at each barrier, one run at a time.
- **Delivery.** One branch. The PR may be cut as a two-PR stack at the W2 checkpoint (§3 decision 16).

## 7. Invariants, runtime shape & risks

**Invariants — each with one enforcement point:**
- **One launch state.** Every task-launch surface's harness, mode, model, effort, speed and max-mode come from `useTaskLaunch` (`lib/use-task-launch.ts`). The guard test (T22) forbids local copies in `NewTaskForm.tsx`.
- **One mapping per payload part.** The launch values go through `submitPicks` and the worktree values through `selectionPayload`, on the panel, issue and PR paths. The create payload shape is otherwise unchanged.
- **One selection.** Pipeline and profile are mutually exclusive, enforced in the hook's `setPipelineId`/`setAgentProfileId`.
- **The Run gate.** `launchGate` is the single rule for the panel and both Git dialogs. Run needs `effectiveLaunchable && pipelineReady`; neither applies to Add to backlog.
- **Remembered picks.** Only `rememberPicks` → `rememberPickPrefs` writes `lastMode|lastModel|lastEffort|lastSpeed|lastMaxMode:<kind>`. It is never called for a profile or pipeline launch (D12).
- **The popover contract.** Every new popover goes through `ui/picker.tsx`: the marker is on the root only while open, and the popover closes itself on Escape and Tab.
- **The tracked setters.** The view changes picks only through the 8 allowed setters (T11's static scan).
- **Layout chrome.** Section, More options and width state live in localStorage through `lib/panel-collapse.ts`/`lib/panel-width.ts` and are read synchronously. They are never preferences.
- **The send box.** Its keys and send semantics are owned by `RunPanel.tsx:5255-5275` and unchanged.

**Runtime shape.**
- The change is webview-only: no route, migration, server behavior or CLI change.
- The panel is a single instance, always mounted. The dialogs are mounted unconditionally and fetch only while `open`; `refreshModels` runs only on a click.
- No new SSE stream or poll (WKWebView budget).
- Rollback means reverting the branch. No data is touched beyond new localStorage keys. Old builds ignore them.
- **Behavior changes, as decided:**
  - S5: Run is disabled for an unavailable harness;
  - B1: Fast is now actually sent;
  - the dialogs remember Speed and Max Mode and restore picks per kind;
  - the panel blocks Run on a bad pipeline.

**Blast radius.**
- `pipelines/StepPanel.tsx` inherits the new pickers' look but not their layout.
- RunPanel task details' `task-speed` becomes radios: the same ids and values, the role changes.
- `CloneProjectDialog` is mounted inside `SelectProjectsDialog`, which is opened from the panel and the issue dialog.
- `SearchSelect` stays for every out-of-scope consumer.
- About 25 e2e specs change locators, and 3 change semantics (C1, S5, radios).

**Risks and mitigations.**

| Risk | Mitigation |
| --- | --- |
| Seed-ordering regressions in the hook move | Pure pins (T3) and e2e pins (T6a) before the move; the DOM is frozen during W2 |
| A portaled popover breaks Escape in a dialog | The marker-on-root rule; T20's Escape-order test |
| `fieldset disabled` stops disabling Clone's pickers | Native-button triggers; T19b assertion |
| Settings → Agents dirtiness breaks | Setter scan (T11) and coverage test (T18) |
| Merge conflicts with the peers | Additive primitives; different `tailwind.config.js` block; adjacent CLAUDE.md rows; distinct `App.tsx` regions. Re-check in T23 |
| AA contrast fails for a token pair | T22 reports it; no silent token edit |

**Cross-repo dependencies:** none.

## 8. Open questions / assumptions

**Unratified one-way decisions:** none. The grill found no one-way doors, and this plan adds none.

Carried from the grill:
- **A1 — Round-1 integrity.** The pasted round-1 answers match the form submission.

Added by this plan. Each is a reversible default, and the owner can flip any of them at approval:
- **A2 — Unknown status.** A harness with no status row yet shows a muted dot titled "Checking status…", and Run waits for the status. That is the dialogs' existing `effectiveLaunchable` semantics, now in the panel too. *Why:* the three-state rule has no state for "not loaded", and red before load falsely alarms in an always-mounted panel.
- **A3 — Pipeline preflight.** It blocks **Run task** only. Add to backlog stays enabled, and the server's `createTask` validation still refuses a broken graph with its own error. *Why:* S5 keeps backlog as the "queue it anyway" path.
- **A4 — Persistence scope.** Section and More options state is kept per surface: panel, and both Git dialogs together. By default the sections are open and More options is closed.
- **A5 — Dialog numbers.** `max-w-4xl` (56rem), a fixed 22rem right column, and the Tailwind `md` breakpoint (768 px viewport). The window has no minimum width, so the one-column layout is reachable and tested.
- **A6 — Inline action size.** Inline secondary actions (↻, gear, Reset to pattern, Change, send-box toolbar actions, Back to Main) stay `h-8`. Fields, toggles and footer actions are `h-9` (V3).
- **A7 — Manage agents placement.** "Manage agents…" is added to the issue and PR dialogs. It isn't added to Clone, which is nested inside Select projects: navigating away from there would have to unwind two or three overlays. Settings → Agents hides the picker anyway.
- **A8 — Hidden values.** A non-default rare value behind a closed More options is announced on its row. A selected profile's card stays visible even while its picker sits behind More options.
- **A9 — Seeding.** The dialogs adopt the panel's seeding algorithm. Any difference from today's dialog seeding, found by T3's characterization, is listed in the PR body rather than preserved.
- **A10 — Send box.** The Send button moves from the tall side button to the toolbar's end. The keys are unchanged: C2 parity is confirmed, since the handler at `RunPanel.tsx:5263` ignores modifiers and no other Cmd/Ctrl+Enter binding exists.
- **A11 — Peer tokens.** Checked 2026-11-18: no collisions. Re-check at merge (T23).
- **A12 — Profile payload in the dialogs.** The panel and both Git dialogs use `submitPicks`, so a dialog with a selected profile now sends the profile's own values next to `agentProfileId`, as the panel already does. The server overrides from the profile in both cases, so its behavior doesn't change.
- **A13 — Delivery.** One branch; a two-PR stack at the W2 checkpoint is recommended, not required.
- **A14 — Panel width default.** The default panel width grows from 320 to 384 px (L6), so the board loses 64 px by default. The user can drag it back.

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| NewTaskForm local launch state (~450 lines) | in this run | T8 (state), T15 (duplicated JSX) |
| Hidden behaviors pinned before the move: per-kind cache, pending seeds, `modelTouched`, m19 stale guards (plus the hook's missing profile guard), F2-3 `effectiveStatus`, L-A8 overage on the start step | in this run | T3, T6a (pins); T7 (moved in) |
| Panel-only behaviors: sticky Isolate, `focusNonce` spotlight, aside drop zone not armed while collapsed, collapse rail, selection kept after submit | in this run | T15 (acceptance) |
| S4 drifted behaviors on every surface | in this run | T7, T10a, T11; proven by T20 parity |
| S5 gate and the flipped availability spec | in this run | T3, T8, T9 |
| B1 Fast speed and its form-submit e2e | in this run | T3, T8, T9 |
| B2 false `@author` warning | in this run | T5, T6b |
| B3 stale comment | in this run | T7 |
| C1 copy, C2 shortcut, C3 header version | in this run | T10b, T15, T16 (C1/C3); T4, T10b, T15, T16, T20 (C2) |
| L5 harness picker | in this run | T10a |
| L6 resizable panel | in this run | T2, T4, T15, T20 |
| L7 two-column dialogs with sticky footer | in this run | T16, T20 |
| L8 clickable Branch row; ghost Reset to pattern and Change | in this run | T12, T11 |
| V1–V7 primitives and their adoption | in this run | T2 plus T10a–T18 |
| Isolate Switch, live and locked | in this run | T12 |
| Dialog parts: issue, PR, Select projects, Branch naming, Clone, Agent profile form | in this run | T16, T12, T18 |
| "Manage agents…" in the Git dialogs (App + GitHubDialog wiring) | in this run | T16 |
| `TaskLaunchPickers` consumers: issue, PR, Clone, Settings → Agents | in this run | T16, T18 |
| `PromptComposer` consumers: panel, issue, PR, RunPanel | in this run | T13, T15, T16, T14 |
| RunPanel send box full redesign (S2) and its screenshots | in this run | T14, T0/T22, T20 |
| `AgentProfilePicker`/`PipelinePicker` on the picker family (StepPanel inherits its look) | in this run | T10a |
| StepPanel layout redesign | out of scope | owner (grill dispositions): the pipeline editor is a different surface |
| `SpeedPicker` in RunPanel task details: role change only, no layout | in this run | T10a (through the primitive) |
| `StackPositionChip`/`AgentIcon`: used as-is | in this run (unchanged) | P1 |
| Select projects per-project `BranchPicker` (on `SearchSelect`) | out of scope | Already a custom picker, not in V2's family list. `e2e/helpers.ts:592-603` depends on its in-flow marker panel. Restyling it is a different ticket. |
| Clone provider native `Select` | out of scope | Not part of "Explain this repository", the only Clone surface S1 names. A different ticket. |
| "Manage agents…" in Clone | out of scope | A7: unwinding nested overlays is a navigation change; a different ticket. The owner can flip it at approval. |
| e2e locator migration (~25 specs) and retired ids | in this run | T6a/T6b (helpers), T19a/T19b (switch) |
| New e2e: Speed submit, Cmd/Ctrl+Enter, collapse/More options persistence, resize, dialog layout, parity, send-key parity | in this run | T9, T20 |
| Docs describing the old UI (11 files) | in this run | T21 |
| Style spec, CLAUDE.md Topic map row and UI-conventions bullets | in this run | T21 |
| A11y bar: labels, keyboard, visible focus, AA contrast in both themes | in this run | T2, T10–T18, T20, T22 |
| Before/after screenshots, both themes, every surface | in this run | T0, T22 |
| Announce the primitives and tokens to the peers; re-check at merge | in this run | W1 barrier (orchestrator), T23 |
| App-wide `text-[11px]`/`text-[10px]` sweep (~490 uses) | out of scope | owner (round-1#text-tokens) |
| Other dialogs adopting the Dialog parts | out of scope | owner (round-1#dialog-parts) |
| An "Add to backlog" action in the dialogs | out of scope | owner (round-1#cta) |
| InfoTip puts `data-popover-open` on its portaled panel, so a dialog's Escape doesn't yield to it; `dialog.tsx`'s carrier comment is stale about it | out of scope | Pre-existing primitive bug outside these surfaces; P1 forbids editing existing primitives here. The launch dialogs use no InfoTip (T22 guard). A different ticket. |
| RunPanel's own resize handle onto the new `ResizeHandle` | out of scope | A refactor of a non-send-box surface; a different ticket |
| CLI/TUI parity | not applicable | Webview-only change; the create payload shape is unchanged |

## Execution notes (step 4 — Implementing)

Changes to the plan made while executing it, none of them one-way doors:

- **No interim steps.** The plan staged `NewTaskForm` onto the hook with its OLD markup (T8) and an old-DOM e2e helper layer (T6a) before the redesign, to attribute regressions. This run had no subagents and a machine at load 100+, so e2e could not be run between stages; it went straight to the final DOM. The behavior pins are the pure `lib/launch-state.test.ts` (including the seeding characterization against the dialogs' old rule: no divergence found, so nothing to list in the PR body) and the e2e specs below. `e2e/launch-behaviors.spec.ts` (P1–P7) was **not written**; its coverage is split across `launch-state.test.ts`, `new-task-submit.spec.ts`, `launch-layout.spec.ts`, `launch-keyboard.spec.ts`, the issue-task additions and the migrated profile/pipeline specs.
- **`gotoApp` opens every More options by default** (`launchMoreOpen: true`), so the 25+ specs that reach Branch name, Speed, the profile picker, the Approvals picker or Max Mode keep working without clicking through; `launch-layout.spec.ts` opts out to test the real default.
- **`launch-parity.spec.ts` was folded into `issue-task.spec.ts`** (the issue dialog already owns the GitHub stub): layout at 1280 / 700 px, labelled fields, ↻ and Manage agents, and the Cmd/Ctrl+Enter / Escape order.
- **Agent/pipeline pickers** keep their pinned part test ids by letting `Picker` take a per-row `testId` and a `partsTestId`; their popover is now portaled, so specs query it on `page`.
- **Error text uses `text-danger`** (the per-theme status token), not `text-destructive`, whose dark value fails AA on the card; `launch-contrast.test.ts` asserts the pairs.
- **`ModeVariantPicker`'s label is "Approvals"** (so `getByLabel("Mode")` resolves one field).

## Execution notes — review round 1 (step 6 — Implementing)

The code review of `57175e2a` sent the branch back. What changed, and what was re-scoped:

- **B1 (blocker) fixed.** `e2e/agent-profiles-settings.spec.ts` was restored from `4d7f8bfb` (26 tests) and moved onto `launch-helpers.ts` (`modelField`/`effortField`/`modeField`, `pickHarness`/`expectHarness`, `openMore` + `speedOption`/`maxModeToggle`; the speed assertions are `toBeChecked()` radios now). 26/26 pass.
- **M1 fixed.** `useTaskLaunch` bumps a `seedGeneration` on every self-fetch open and the pending-seed effect is keyed on it. `e2e/issue-task.spec.ts` "a second open of the issue dialog keeps the remembered codex model and effort" is red without the dep and green with it.
- **A second defect found by the new P2 pin, fixed.** A remembered Fast tier (and cursor Max Mode) was dropped on every restart when the remembered model was one only the CLI catalog knows: the reset effects ran in the same commit that applied the seed, against the default model. The seed now holds them (`seedHold`, `PendingSeed.settled`) until the form renders the applied model, and judges them against the fallback model when the catalog rules the remembered one out.
- **M2 delivered**, with these re-scopes:
  - `e2e/launch-behaviors.spec.ts` P1–P7 are written on the final DOM (the plan's "on today's DOM first" staging was already dropped in step 4). P5 deletes the pipeline from the Pipelines page, which is what refreshes the shared list; P6 deletes the profile through the API and closes Settings, which refreshes the profile list. Neither list is polled, so an API-only delete is correctly not noticed until a refresh.
  - `launch-parity.spec.ts` stays folded into `issue-task.spec.ts` (issue dialog) and `resolve-conflicts.spec.ts` (PR dialog: labelled fields, ↻, Manage agents row, two columns, status tone `ok`/`error`, the unavailable-harness hint and the visible blocked reason). The self-fetch-only behaviors are asserted in the issue spec: remembered Speed and Max Mode seed the dialog (cursor), and the per-open re-seed (codex). The logged-out `warn` tone has no e2e stub that can produce it; it stays pinned by `harnessStatusTone` in `launch-state.test.ts`.
  - T9: codex Fast and cursor Fast + Max Mode submit e2e are in `new-task-submit.spec.ts` (the codex app-server stub gained a `fast` flag that serves a `priority` service tier).
  - T16: "Manage agents…" is covered end to end in `issue-task.spec.ts`: Tab reaches the footer row, a dirty draft asks to discard, Cancel keeps the dialog, Discard opens Settings on Agents.
  - SC14: superseded by round 2, which completed the set (the round-1 note said the before shots were deferred to PR time, and its "panel with More options" shot was the default view).
  - T23 (peer re-check, 2026-11-18): the three peers now have commits. A trial merge (`git merge-tree`) of each into this branch conflicts in two files only: `e2e/harness-stack-switch.spec.ts` (with `fix/agetor-app-bar-ui-improvement`) and `docs/architecture/pipelines.md` (with `fix/agetor-card-ui-improvement`); every other overlap (`App.tsx`, `CLAUDE.md`, `tailwind.config.js`, `RunPanel.tsx`, `helpers.ts`) merges cleanly. None adds `text-2xs`/`text-3xs`, Field, a picker or a segmented control.
- **S1** `LaunchFooter`'s reason id is `useId()`, so a dialog's Run never resolves to the always-mounted panel's reason (unit + PR-dialog e2e).
- **S2** `Picker`'s Tab walks the panel's own stops (search or list, then the footer controls) and closes only at either end; Enter and the arrows belong to a focused footer control.
- **S3** `ReferencesPicker` no longer renders an `InfoTip` (its help is plain text), and the style guard now scans every component the Git dialogs render. The primitive bug itself stays out of scope (P1).
- **S4** the status-tone assertion in the parity test asserts `ok` and the PR parity test also asserts `error`; neither can pass on a placeholder.
- **Full e2e run (SC15), 2026-11-18, 532 tests, 3 workers:** 528 passed, 2 flaky (passed on retry: `pipelines-run` Restart, `tagged-user-messages` silent shell escape — neither touches a launch surface) and 1 real failure, `theme.spec` "GET /pipelines is never requested before GET /preferences": the always-mounted panel's `useTaskLaunch` read the shared pipeline list at mount, ahead of App's prefs-gated read. Fixed: in source mode the hook enables `usePipelines` only once the boot preferences have been read. `theme`, `launch-behaviors` and `pipelines-run` re-run green (42 tests). Unit: `bun test src/mainview src/shared` 4474 pass, typecheck clean.
- **Nits from the review:** `useFieldControl`/`FieldError`/`FieldGroup` had no production caller and no control's `aria-describedby` pointed at its `FieldDescription`, and the in-session panel width stayed clamped after a window shrink. Both are fixed in round 2 (below).

## Execution notes — review round 2 (step 8 — Implementing)

The round-2 review at `70dca452` sent the branch back with R-M1, R-S1–R-S3 and five nits. Nothing is deferred.

- **R-M1 — SC14 complete.** The base commit `4d7f8bfb` was checked out in a detached worktree (`bun install`, removed afterwards) and the same temporary capture specs ran on it and on the head, dark and light, at 1440 px wide and @2x. They were deleted before this commit. Output (not committed): `~/.agetor/screenshots/new-task-ui-before/` (20 images) and `~/.agetor/screenshots/new-task-ui-after/` (26 images). Surfaces, each in both themes: panel empty, panel filled, profile selected, Select projects, Clone → Explain, Branch naming, Settings → Agents form, the RunPanel send box (idle, task open), the issue dialog and the PR-conflicts dialog. After only: harness picker open, model picker open and **More options actually open** (the round-1 "More options" shot was the default view, so the earlier files are replaced). Before cannot show an open harness or model picker: they were native `<select>`s, which a headless screenshot never renders open, and the base has no More options. Not captured on either side: a pipeline selected in the panel (it is shown by the P9 flow instead), the 7-harness grid beyond the extra harnesses in the header, and the send box's toolbar-action, background-agent-bar and archived-notice variants (they need a live agent run; the idle send box is the redesigned surface).
- **R-S1 — parity rows, each with its proof.**
  - Dialog ↻ self-fetch round trip: new e2e in `issue-task.spec.ts` ("↻ in the dialog re-probes the harness, then refetches both model lists": the per-harness POST, then both catalog reads, then the button idle and a model still picked).
  - Panel blocked-pipeline Run gate: new `launch-behaviors.spec.ts` P9 (the reason shows, Run task is disabled, Add to backlog stays enabled, Change restores Run).
  - Fable/Mythos 2x note: unit `usageNote` in `launch-copy.test.ts` and the rendered note in `TaskLaunchPickers.test.tsx`.
  - Account email in the harness tooltip: unit `harnessTooltip` in `launch-copy.test.ts`.
  - Pipeline loading, error and empty hints: new rendering unit in `TaskLaunchPickers.test.tsx`.
  - Codex → Claude → codex in a dialog: the dialogs run the same `switchPicks` as the panel, pinned in `launch-state.test.ts`; the panel flow is e2e P1. No dialog-level e2e: the dialog uses the one hook.
  - The logged-out `warn` tone stays unit-only (`harnessStatusTone`); no e2e stub reports logged-out, which is the owner's open question below.
- **R-S2 fixed.** The Fast and Max Mode reset effects now depend on `model` as well, so they re-judge the tier when a remembered model's seed releases its hold, even when the default and the restored model offer the same tier set. New e2e P8 (a remembered `lastSpeed:codex = fast` with a remembered catalog-only codex model that has no Fast tier). Observed red without the dependency and green with it.
- **R-S3 fixed.** `Field` now owns only the control id and the description id (`fieldDescriptionId`). `useFieldControl`, `FieldError`, `FieldGroup` and `Field`'s `invalid` prop were removed: nothing used them. The harness, model, pipeline and approvals pickers name their hint in `aria-describedby`, and the branch-name input names both its error and its multi-project description. `task-launch-ui.md` and its Components table match. The plan's §3 primitives list (above) still names the removed helpers: it records the original design, not the shipped one.
- **Nits.** The Status line is current. P5 is titled for what it does (deletes on the Pipelines page). P3's redundant assertion is gone (`expectModel` already reads `data-value`). The InfoTip guard now walks the import closure of the two Git dialogs, so a component added later is covered without a list. The panel keeps the width the user chose and clamps only what it shows, so widening the window gives the chosen width back (extended the resize e2e: 900 px → 420, back to 1280 px → 500).
- **Environment trap hit.** A stray Vite from another worktree held :5173, so a default-port Playwright run would have exercised that branch's webview. These runs used `AGETOR_E2E_VITE_PORT=5291 AGETOR_E2E_PORT_OFFSET=3000`; the offsets 300 collided with macOS's :5000.
- **Verification (round 2).** `bun run typecheck` clean; `bun test src/mainview src/shared` 4475 pass, 0 fail. E2e (private ports, 2 workers): `launch-layout`, `launch-behaviors` (P1–P9), `launch-keyboard`, `new-task-submit`, `issue-task`, `resolve-conflicts`, `agent-profiles-launch`, `agent-profiles-settings` and `clone-project`: 91 passed, 0 failed, 0 flaky. These are the specs that drive the files this round touched; the full 532-test suite was not re-run (the machine's load stayed above 14).

### Review round 3 — Bug Fix

- **S1 fixed.** `IsolateRow`'s Switch names its note (`aria-describedby` only when a note shows, so nothing dangles), and the locked Branch input names its "PR head branch" description. Both pinned in `WorktreeOptions.test.tsx` (the described-by id resolves to the `<p>` carrying the text).
- **N1 fixed.** `NewTaskForm` seeds `preferredWidth` from the stored width limited only to the panel's own 320–560 range (`readNewTaskPanelWidth(Infinity)`); only the displayed width is limited by the window. New `launch-layout.spec.ts` case: saved 500 px, start at 900 px wide (shows 420), widen (shows 500 and `aria-valuenow` 500).
- **N2 fixed.** P8 asserts `launch-more-agent` has `aria-expanded="true"` before the negative Speed check, so it cannot pass on a closed section.
- **Left as is (owner decisions).** `KanbanFilters.tsx` stays untouched (the app-bar branch owns the search-box fix); plan A3 stays as written.
- **Verification.** `bun run typecheck` clean; `bun test src/mainview src/shared` 4476 pass, 0 fail; e2e on private ports (`launch-layout`, `launch-behaviors`, `issue-task`, `resolve-conflicts`): 42 passed, 0 failed. The full 532-test suite still runs on the final head before the PR.

### Review round 4 — Bug Fix

- **S1 fixed.** `CreateTaskFromIssueDialog` shows its footer reason only once the form is on screen (thread loaded, no error, a context). While the thread loads the footer says "Loading the issue…"; after a failed fetch, or with no context, it shows nothing, because the empty prompt is not the user's omission. New `issue-task.spec.ts` case holds `/github/issue-thread` (footer reads "Loading the issue…", never "Add a prompt"), then fails it with a 500 (error shown, no reason). Red on the previous head, green now.
- **N1 fixed.** The double-click reset shows `clampNewTaskPanelWidth(default, window.innerWidth)` and stores the plain default, so `aria-valuenow` never exceeds `aria-valuemax` in a narrow window.
- **N2 fixed.** `ResizeHandle` commits a pointer release only when the pointer moved, and a key press only when the width changes. A click on the handle or an `End`/`ArrowRight` at the limit no longer replaces the saved width with the window-limited one. New `launch-layout.spec.ts` case: saved 500, 900 px window, click and keys, widen, still 500; a reset in a 700 px window stays within the range. Red on the previous head, green now.
- **N3 fixed.** `launchGate`'s missing-fields reason names only what is missing ("Add a title", "Add a prompt and a project", …); unit-pinned.
- **N4 fixed.** `LaunchGate.backlogBlockedReason` had no reader, so it is removed (the type, the gate and the plan's §3 signature).
- **N5 fixed.** The Status line names rounds 1–4.
- **Left as is (owner decisions).** Plan A3 (Add to backlog stays enabled for a pipeline the server's `createTask` refuses) and the merge order with `fix/agetor-app-bar-ui-improvement`'s `KanbanFilters` change.
- **Verification.** `bun run typecheck` clean; `bun test src/mainview src/shared` 4477 pass, 0 fail. E2e on private ports (`launch-layout`, `new-task-submit`, `launch-behaviors`, `issue-task`, `resolve-conflicts`): 49 passed, 0 failed. The full 532-test suite still runs on the final head before the PR.
