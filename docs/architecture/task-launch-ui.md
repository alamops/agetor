# Task launch UI

One component and style pattern for every surface that starts a task, so they cannot drift. This is the contract for `NewTaskForm`, `TaskLaunchPickers`, `lib/use-task-launch.ts`, `lib/launch-state.ts`, the picker family in `components/ui/`, and the Git launch dialogs. Read it before changing any of them.

## Surfaces

| Surface | Component | Layout |
|---|---|---|
| New Task panel | `kanban/NewTaskForm.tsx` | resizable sidebar (320–560 px, default 384, `ui/resize-handle.tsx`, persisted), sections |
| "Work on this with Agetor" (issue) | `kanban/CreateTaskFromIssueDialog.tsx` | `max-w-4xl` dialog, two columns from `md` (768 px), sections |
| "Resolve with Agetor" (PR conflicts) | `kanban/ResolveConflictsDialog.tsx` | same shell, the Workspace section is the locked variant |
| Select projects | `kanban/SelectProjectsDialog.tsx` | Dialog parts, sticky footer |
| Branch naming | `settings/BranchNamingDialog.tsx` | Dialog parts, sticky footer |
| Clone → "Explain this repository" | `kanban/CloneProjectDialog.tsx` | `TaskLaunchPickers layout="flat"` inside `<fieldset disabled={busy}>` |
| Settings → Agents form | `kanban/AgentProfileFormDialog.tsx` | `layout="flat"` with `hideProfilePicker` |
| RunPanel send box | `kanban/RunPanel.tsx` (dock) | composer, toolbar with the actions and Send at its end |

### Section and field order

Panel: **Type**, **Title**, **Prompt** (its label, then the full-width **MCP · Skills · Plugins · Prompts** picker, then the text box; + Files / Folders), then the collapsible **Workspace** and **Agent** sections, then the footer. The launch surfaces (panel and both Git dialogs) render the composer with `extensionPickerVariant="launch"`: the picker spans the prompt's width and has no Agents group (an agent is picked in the Agent section). RunPanel's send box keeps the compact `toolbar` variant, Agents included. The dialogs put Type and Prompt in the left column and the two sections in a fixed 22 rem right column; each column scrolls on its own, the footer never scrolls.

- **Workspace** (`WorkspaceSection.tsx`): Projects (Select projects, whose search box has a clear (×) button, `select-projects-search-clear`), one clickable `Branch · <project>` row per project, the Isolate switch. **More options**: Branch name.
- **Agent** (`TaskLaunchPickers.tsx`): Pipeline; with no pipeline the **Agent** (profile) picker ("Manage agents…") right under it, then the selected profile's card, or Harness (with its unavailable / auth / stack-fallback hints directly under it), Model (with ↻) and Effort, the usage note. **More options**: Code | Plan, the Approvals picker (the code variants), Speed, Max Mode.

**A launch always starts in Code.** `seedPickCache` ignores a remembered plan mode, `rememberPickPrefs` writes no `lastMode` for a plan launch (so a remembered code variant survives), `rememberPicks` caches the kind's picks with Code, and the panel switches back to Code after each submit. A Plan pick behind a closed More options is announced on its row (`Mode: Plan`). The `flat` layout (Clone, Settings → Agents) keeps Code | Plan inline between Harness and Model.

A collapsed section shows a one-line summary (`lib/launch-summary.ts`): `agetor · current branch · isolated · fix/7c5261`, `Claude Code · Opus 5.5 · High · Code`. A non-default value or an error behind a closed **More options** is announced on its row (`Speed: Fast`, `Branch name is invalid`, danger-toned); nothing that changes the launch hides silently. A selected profile's card shows right under the Agent picker.

## One launch state

Every surface renders from `useTaskLaunch` (`lib/use-task-launch.ts`); `lib/launch-state.ts` holds the pure rules (seeding, per-kind cache, remembered prefs, `submitPicks`, the Run gate) and has the unit tests, because `bun test` has no React hook runner.

- **Source mode** (`opts.source`): the panel hands the hook App's live harness, status, stack and catalog data (15 s poll plus the SSE-driven refetch). The hook fetches only the remembered preferences, once per mount, and applies `defaultHarness` once.
- **Self-fetch mode**: a dialog fetches on `open` and re-seeds the per-kind cache on every open (a `seedGeneration` counter re-runs the pending-seed effect each time, because `prefsLoaded` stays true and the catalog ids rarely change: without it a second open dropped the remembered codex/copilot model and effort for the default). A closed dialog fetches nothing.
- Both modes share the per-kind pick cache (codex → claude → codex restores the codex picks), the pending seed for a remembered model only the CLI catalog carries (`resolveSeedOutcome`), `modelTouched` (a hand pick is never overridden), the seed hold (while a remembered model is still waiting for the catalog, or has just been applied but not yet rendered, the Speed and Max Mode reset effects stand down, so a remembered Fast is not judged against the default model the form shows in between), the stale profile / pipeline guards (gated on their lists having loaded), and the five `last*:<kind>` preferences written by `rememberPickPrefs` (never for a profile or pipeline launch).
- `submitPicks` is the one mapping from picks to the create payload for the panel and both Git dialogs: Fast is submitted for every kind, a profile's values replace the manual picks, Max Mode is cursor-only.
- The view changes picks only through the tracked setters (`switchAgent`, `setMode`, `setModel`, `setEffort`, `setSpeed`, `setMaxMode`, `setAgentProfileId`, `setPipelineId`). Settings → Agents' dirtiness tracker (`lib/agent-profile-form.ts`, `LAUNCH_INTERACTION_SETTERS`) wraps exactly those; two static tests enforce it.

### The Run gate

`launchGate` (`lib/launch-state.ts`) is the single rule. A missing title (panel only), prompt or project, an invalid worktree or an oversize prompt blocks both **Run task** and **Add to backlog**. An unavailable harness, a harness whose status has not arrived, or a pipeline that is checking or blocked blocks only Run. The reason is visible text under the footer (`launch-run-blocked-reason`) because a disabled `Button` shows no `title` tooltip.

## Components

| Need | Use |
|---|---|
| choose one of many, searchable or long | `ui/picker.tsx` (`Picker`) |
| choose one of 2–4 always-visible values | `ui/segmented-control.tsx` (a radiogroup): Type, Code \| Plan, Speed |
| on / off | `ui/switch.tsx` with a `FieldLabel` (Isolate, Max Mode) |
| a labelled control | `ui/field.tsx`: `Field controlId` + `FieldLabel htmlFor`; help text is a `FieldDescription` (or an element with `fieldDescriptionId(controlId)`) and the control names it in `aria-describedby`; an error is a `Notice` or a `role="alert"` line the control also names |
| an inline message | `ui/notice.tsx` (`info`, `warning`, `danger`, `muted`) |
| rare fields | `ui/disclosure.tsx` via `LaunchSection` / `MoreOptions` |
| a modal | `ui/dialog.tsx` + `DialogHeader/Title/Description/Body/Footer/Close` |
| a search box over a list | `ui/search-input.tsx` (`SearchInput`): magnifier, identifier props, and a clear (×) button shown while there is text that refocuses the box |
| a shortcut hint | `ui/kbd.tsx` (`aria-hidden`, plus `aria-keyshortcuts` on the control) |

A native `<select>` is not used on the launch surfaces, with one exception: Clone's provider select (not part of "Explain this repository"). The native checkboxes that remain are the Select projects rows (multi-select list semantics) and the agent-copy option; both carry `accent-primary`.

### Picker contract

`Picker` is the popover contract of `docs/architecture/prompt-composer.md` applied to a portaled panel:

- The trigger is a native `<button>` (`aria-haspopup="listbox"`, `aria-expanded`, `aria-controls`), so a surrounding `<fieldset disabled>` disables it.
- **`data-popover-open=""` sits on the picker's root, only while open, and never on the portaled panel.** `Dialog` looks for the marker inside the dialog panel only; a marker on a portaled panel would be invisible to it (that is `InfoTip`'s latent bug, which is why neither Git dialog, nor any component it renders (the references picker included), uses an `InfoTip`; help text there is plain visible text, and a static test enforces it).
- While focus is inside the panel the picker handles Escape and Tab itself with `preventDefault` (Escape returns focus to the trigger). Tab walks the panel's own stops (the search box or list, then each footer control such as "Manage agents…") and closes the popover only when it leaves either end; Enter, arrows and type-ahead belong to the focused footer control while focus is in the footer. React's listener on the portal container runs before `Dialog`'s document listener, which returns early on `defaultPrevented`.
- The panel stops click, context-menu and drag events from bubbling through the React tree (a drag over it must not arm the panel's drop zone). Keydown and mousedown are not stopped.
- It flips above or below (`lib/popover-position.ts`), is clamped 8 px inside the viewport, re-measures when its rows change and grows to fit rows that arrive while it is open (`naturalPopoverHeight` adds back what a stale max-height hides), and closes on an outside mousedown, a scroll of an ancestor of the trigger, and a resize. Arrow keys, Home, End, Enter and type-ahead (`lib/listbox-nav.ts`).
- Test ids: root `testId`, trigger `<parts>-trigger` (with `data-value`), `-popover`, `-search`, each row `-option` (with `data-value`; a caller may override a row's id, as `agent-profile-picker-row` does).

## Style

- **Sizes.** Fields and toggles are `h-9 text-sm`; the footer actions are `size="default"` (`h-9`). Inline secondary actions (↻, the gear, Reset to pattern, Change, the send-box toolbar actions, Back to Main) are `size="sm"` (`h-8`): a documented exception for inline actions, not fields.
- **Type scale.** `text-sm` fields, `text-xs` labels, `text-2xs` (0.6875 rem) helper text, `text-3xs` (0.625 rem) meta. The rem tokens are in `tailwind.config.js` (`theme.extend.fontSize`); use them instead of `text-[11px]` / `text-[10px]` in new UI (a static test covers the launch files; the app-wide sweep is a separate ticket).
- **Spacing.** `space-y-3` between fields, `gap-1.5` from label to control, `px-3 pb-3` inside a section.
- **States.** Selected is subtle: `bg-accent text-accent-foreground border-primary/60`, never a filled `bg-primary` (the one filled control on a surface is Run). Errors use the `danger` token (`text-danger`), warnings `warning`, an unknown status a muted dot titled "Checking status…". Colors are semantic tokens only; `launch-contrast.test.ts` asserts AA contrast of the pairs in both themes.
- **Copy.** **Run task** everywhere; **Add to backlog** in the panel; **Cancel** + **Run task** in the dialogs.
- **Shortcut.** Cmd+Enter (Ctrl+Enter off macOS) runs the task (`lib/use-submit-shortcut.ts`, scoped to the panel `<aside>` and each dialog's content root; inert while a picker or other keyboard-owning popover is open, when the key is typed inside any open popover, when an autocomplete consumed it (Enter on a `/` or `@` suggestion), or while Run is disabled; an escape-only popover the key didn't come from, such as the `@` "couldn't list files" notice or a `/` menu left open while focus moved to another field (the chord then runs the prompt as typed), doesn't block it — `SUBMIT_BLOCKING_POPOVERS` in `lib/submit-shortcut.ts`). The Run button's accessible name stays exactly "Run task". The RunPanel send box keeps its keys: Enter sends, Shift+Enter inserts a new line, Cmd/Ctrl+Enter sends.

## Persistence

Layout chrome lives in `localStorage` through `lib/panel-collapse.ts` and `lib/panel-width.ts`, read synchronously in a lazy `useState`; never a preference.

- `agetor:launch:<panel|dialog>:<workspace|agent>:collapsed` — a section's collapsed flag (default open)
- `agetor:launch:<panel|dialog>:<workspace|agent>:more` — More options open (default closed)
- `agetor:newTaskPanelWidth` — the panel width (px) — the width the user chose; a narrower window clamps what is shown, never the choice, so a wider window gives it back
- `agetor:newTaskPanelCollapsed` — the whole panel

The two Git dialogs share the `dialog` surface keys.

## Test ids and the e2e helper layer

`new-task-panel`, `new-task-panel-resize`, `extension-picker-trigger`, `select-projects-search[-clear]`, `agent-profiles-search[-clear]` (Settings → Agents; `agent-profiles-no-matches`), `launch-section-<workspace|agent>[-toggle|-summary]`, `launch-more-<section>[-region|-note]`, `launch-harness-picker` (+ parts; each row's dot is `launch-harness-status` with `data-tone`), `launch-mode` (`data-mode`, `data-kind`; radios `launch-mode-code|plan`), `launch-mode-variant-picker`, `launch-model-picker`, `launch-refresh-models`, `launch-effort-picker`, `launch-speed[-<tier>|-hint|-note]` (RunPanel's own is `task-speed`), `launch-max-mode-toggle`, `launch-pipeline-picker|summary|change|problem|checking`, `launch-pipelines-loading|error`, `launch-agent-unavailable-hint`, `launch-stack-fallback-hint`, `launch-usage-note`, `launch-run`, `launch-backlog`, `launch-cancel`, `launch-run-blocked-reason`; the dialogs keep `issue-task-submit` / `resolve-conflicts-submit`.

Specs reach a field through `e2e/launch-helpers.ts` (`pickHarness`, `pickModel`, `modelField(scope).expectValue`, `setPrimaryMode`, `pickSpeed`, `openMore`, …) instead of structural XPath; `gotoApp` opens every More options by default (`launchMoreOpen: false` opts out, as `launch-layout.spec.ts` does).
