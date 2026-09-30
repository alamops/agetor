# Plan — Settings → Agents: Add / Edit open as a modal subpage

| Field | Value |
| --- | --- |
| Date | 2026-09-29 |
| Source | Task: "Agents page's New Agent should navigate to a modal's internal page with the back button to the agents list. The same for the `Edit` button" |
| Config | AGENTS_CONFIG.yml (balanced) — host `claude_code` |
| Flags | none |
| Gates | grilled + approved by owner (approved with a sweep-in: dirty confirms for the pipeline step's agent dialog and the harness editor) |
| Branch | fix/agents-new-edit-subpage |
| Base SHA | ea901ae |

## 1. Objective & success criteria

Clicking **Add agent** or a row's **Edit** in Settings → Agents navigates the
Settings modal to an internal subpage that holds the agent form, with a back
chevron in the modal header returning to the agents list — the same mechanism
the Harnesses editor already uses.

Done when:

- Add agent / Edit replace the list with the form subpage; the header shows a
  Back chevron and the title `Add agent` / `Edit agent`; the sidebar keeps
  **Agents** highlighted.
- Back, Escape and backdrop click return to the agents list (not close the
  modal). Save returns to the list with the row updated. Cancel returns
  immediately.
- With unsaved edits, every exit except Cancel — Back, Escape, backdrop, a
  sidebar section click, the modal's X — asks "Discard unsaved changes?".
  Declining stays on the form with the draft intact. A clean form never asks.
- Leaving the subpage discards the draft (returning to Agents shows the list).
- "Edit in Settings" (task agent-details dialog, pipeline satellite details)
  lands directly on that agent's edit subpage; "Manage agents…" still opens
  the list.
- The same dirty confirm guards the harness editor subpage and the pipeline
  step's "New agent…" dialog (swept in at plan approval).
- `bun run typecheck` green, unit tests green, the agent-profile e2e specs
  green.

## 2. Context & constraints

- The form renders inline under the list today: `AgentProfilesSection.tsx:144`
  (local `form` state, Add hidden and Edit disabled while open).
- The Settings modal's subpage mechanism is the `SettingsView` union in
  `src/mainview/lib/settings-dialog-view.ts` (`section | templates | editor`)
  — back chevron + title switch at `SettingsDialog.tsx:463-477`, Escape pop at
  `SettingsDialog.tsx:451-457`, body switch at `:628-687`.
- `backFromSubview()` is hardcoded to Harnesses (`settings-dialog-view.ts:52`);
  4 call sites in `SettingsDialog.tsx` plus the unit test.
- `AgentProfilesSection` is kept always-mounted (hidden via class) purely so an
  inline draft survives a section switch (`SettingsDialog.tsx:584-593`); that
  reason goes away with this change.
- `AgentProfileForm` already handles a not-yet-loaded edit target ("Loading…")
  and a missing one (error + Cancel only) — `AgentProfileFormDialog.tsx:63-116`.
  A deep link needs nothing more from it.
- The launch pickers' auto-reset effects live inside `useTaskLaunch` and call
  its internal `useState` setters; `TaskLaunchPickers` only ever calls the
  setters on the `launch` object it is handed (`TaskLaunchPickers.tsx:557-657`).
  So wrapping that object's setters observes user picks and nothing else.
- `Dialog` returns `null` when closed (`dialog.tsx:186`), so nothing survives a
  modal close regardless.
- `useConfirm()` stacks its own `Dialog`; Escape goes to the topmost panel, so
  Escape on the confirm cancels the confirm only.
- No jsdom in this repo — webview behaviour is covered by Playwright; pure
  helpers in `src/mainview/lib/` are the unit-test seam.

## 3. Approach & key decisions

- **Extend the union, don't add booleans.** New member
  `{ kind: "agent-editor"; profileId: string | null }` + `openAgentEditor()`.
  `backFromSubview` becomes view-aware (`backFromSubview(view)`), returning
  Agents for the new member and Harnesses for `templates`/`editor`.
  `activeSection` → `"agents"`, `resolveEscape` → `"pop"`.
  Rejected: keeping the form state inside `AgentProfilesSection` and reporting
  "subpage open" upward — two sources of truth for one navigation state.
- **The form renders in `SettingsDialog`'s body switch**, not inside the list
  section. `AgentProfilesSection` becomes list-only (`onAdd` / `onEdit` props)
  and moves into the section switch like `HarnessesSection`; the always-mounted
  wrapper and its comment are removed.
- **Dirty = text differs OR a launch pick was made.** Name/instructions/skills
  are compared by value against what the form opened with (pure helper,
  unit-tested). The harness/mode/model/effort/fast/max-mode block is tracked by
  interaction, through wrapped setters on the `launch` object handed to
  `TaskLaunchPickers`. Rejected: value-diffing the launch block — a create form
  seeds those values asynchronously from preferences and the hook's reset
  effects can adjust them, so an untouched form would read dirty.
- **One guard for every exit.** `SettingsDialog` routes Back, Escape/backdrop,
  sidebar clicks and X through a single `leaveSubpage(proceed)` that confirms
  only when the view is a form subpage (`agent-editor` or the harness `editor`)
  and that form reported dirty. Cancel and a successful Save bypass it. The
  templates picker holds no draft and never confirms.
- **Harness editor dirtiness is a plain value diff** — its six fields are all
  seeded synchronously from the template, so comparing against the initial
  values is exact (pure helper, unit-tested).
- **`AgentProfileFormDialog` guards its own close** (Escape, backdrop, X) with
  the same confirm, fed by the form's `onDirtyChange`; its Cancel stays
  immediate.
- **Deep link by prop.** `SettingsDialog` gains
  `initialAgentProfileId?: string | null`; the open effect prefers it over
  `initialSection`. `onOpenSettingsAgents` becomes
  `(profileId?: string) => void`, with a `typeof === "string"` guard in App so
  a handler passed straight to `onClick` can never turn a click event into an
  id.
- **`AgentProfileForm` gets `variant?: "card" | "page"`** (default `card`, what
  the pipeline step's dialog uses). `page` drops the bordered card and gives
  the footer the same top border the harness editor has.
- Labels (owner): button stays **Add agent**; titles `Add agent` / `Edit agent`.

## 4. Work breakdown — implementation tasks

**T1 — Settings modal subpage** (wave 1)
Owns: `src/mainview/lib/settings-dialog-view.ts`,
`src/mainview/lib/settings-dialog-view.test.ts`,
`src/mainview/lib/agent-profile-form.ts` (new),
`src/mainview/lib/agent-profile-form.test.ts` (new),
`src/mainview/lib/harness-editor-dirty.ts` (new),
`src/mainview/lib/harness-editor-dirty.test.ts` (new),
`src/mainview/components/settings/SettingsDialog.tsx`,
`src/mainview/components/settings/AgentProfilesSection.tsx`,
`src/mainview/components/kanban/AgentProfileFormDialog.tsx`.
Acceptance: union member + helpers + view-aware back; list-only section; form
subpage with header/back/title; dirty reporting (`onDirtyChange`, reset to
false on unmount); the single leave guard on all five exits; Save/Cancel pop
to the list; `initialAgentProfileId` honoured on open; stale comments
rewritten; harness `Editor` reports dirtiness and is covered by the same leave
guard; `AgentProfileFormDialog` confirms on a dirty close; unit tests for the
view helpers and both dirty helpers.

**T2 — Deep-link plumbing** (wave 1)
Owns: `src/mainview/App.tsx`,
`src/mainview/components/kanban/AgentProfileDetailsDialog.tsx`,
`src/mainview/components/pipelines/SubagentDetailsDialog.tsx`, and the
`onOpenSettingsAgents` prop type + pass-through lines only in
`src/mainview/components/kanban/RunPanel.tsx`,
`src/mainview/components/kanban/NewTaskForm.tsx`,
`src/mainview/components/pipelines/PipelineEditor.tsx`,
`src/mainview/components/pipelines/PipelineRunView.tsx`.
Acceptance: `settingsInitialAgentId` state set by `openSettingsAgents(id)`,
cleared by `openSettingsHarnesses`, the gear button path and Settings
`onClose`; both "Edit in Settings" buttons pass the profile id; every
"Manage agents…" site calls with no argument.

**T3 — Docs** (wave 2, orchestrator)
Owns: `CLAUDE.md` (item 15, "UI surfaces").

Contract between T1 and T2: `SettingsDialog` prop
`initialAgentProfileId?: string | null`.

## 5. Work breakdown — test tasks

- **Unit** (inside T1): `settings-dialog-view.test.ts` — `openAgentEditor`,
  `backFromSubview` per view kind, `activeSection`/`resolveEscape` for the new
  member; `agent-profile-form.test.ts` — the text-dirty helper;
  `harness-editor-dirty.test.ts` — the harness value diff.
- **E2E applies** — this is a user-visible navigation flow.
  **TT1** (one agent; Playwright runs must be serial) owns
  `e2e/agent-profiles-settings.spec.ts`, `e2e/agent-profiles.spec.ts`,
  `e2e/agent-profiles-launch.spec.ts`, `e2e/pipelines-editor.spec.ts`,
`e2e/identifier-inputs.spec.ts` (only if its harness-editor flow needs a
locator fix), `e2e/settings-subpage-guard.spec.ts` (new — harness editor):
  - repoint the form locator from the list section to the dialog (5 places);
  - fix the skills-picker Escape assertion (heading is now `Add agent`);
  - replace "Draft survives switching sections" with the discard behaviour;
  - new: subpage navigation (title, Back, sidebar highlight, list hidden);
    clean Back/Escape pop without a confirm; dirty confirm on Back, Escape,
    sidebar click and X — decline keeps the draft, accept discards; Cancel
    never confirms; a launch-picker change alone counts as dirty;
  - harness editor: clean Back pops without a confirm; dirty Back / Escape /
    sidebar click / X confirm, decline keeps the draft; Cancel never confirms;
  - pipeline step "New agent…" dialog: dirty Escape/X confirms, decline keeps
    the draft, clean close never asks;
  - deep link: "Edit in Settings" from the task agent-details dialog and from
    the pipeline satellite details lands on `Edit agent` for that profile,
    Back reaches the list.
- Run recipe: `export PATH="$HOME/.bun/bin:$PATH"`; `bun run typecheck`;
  `bun test src/mainview/lib`;
  `bun node_modules/@playwright/test/cli.js test e2e/agent-profiles-settings.spec.ts e2e/agent-profiles.spec.ts e2e/agent-profiles-launch.spec.ts e2e/pipelines-editor.spec.ts e2e/identifier-inputs.spec.ts e2e/settings-subpage-guard.spec.ts --reporter=list`
  (the Playwright config boots Vite and the headless backends itself; one
  Playwright run at a time).

## 6. Execution waves

1. **Wave 1** — T1 ∥ T2 (file-disjoint; joined by the prop contract).
   Barrier: `bun run typecheck` + `bun test src/mainview/lib`. Commit.
2. **Wave 2** — T3 docs. Commit.
3. Review → TT1 → run → fix.

## 7. Blast radius & risks

- `backFromSubview` signature change — every caller is in `SettingsDialog.tsx`
  and its test; typecheck catches a miss.
- `AgentProfileFormDialog` (pipeline step's "New agent…") shares
  `AgentProfileForm`; the new props are optional and default to today's
  rendering, and `e2e/pipelines-editor.spec.ts` covers that dialog.
- A Save in flight while the user leaves: `onSaved` only pops when the view is
  still the agent editor for that same profile id.
- `CLAUDE.md` is also being edited on `fix/review-claude-code-updates` by a
  peer (different section) — possible textual merge conflict, no semantic one.
- Rollback: revert the branch; no data, API or schema change.

## 8. Open questions / assumptions

Grill answers (owner, 2026-09-29):

| Question | Answer |
| --- | --- |
| Draft when leaving via the sidebar | Discarded, like Harnesses |
| Back/Escape on a dirty form | Confirm when dirty |
| Which exits the confirm guards | Every exit but Cancel |
| "Edit in Settings" | Deep-links to the edit subpage |
| Button label | Keep "Add agent" |
| Plan approval | Approved, plus dirty confirms for the pipeline step's agent dialog and the harness editor |

Review outcome (opus, `code-review` skill): 0 critical, 0 high, 1 medium, 3 low — all four fixed in
`b0ac044` (view reset on the open edge, late-save guard + clean-while-saving,
stale deep-link section, stale comments).

Known edge, accepted: closing the pipeline step's "New agent…" dialog while its
save is in flight still creates the agent but no longer auto-selects it on the
step (the late `onSaved` would have written through a stale `step` closure).

Assumptions: the sidebar stays visible on the subpage (as it does for the
harness editor); Cancel and Save stay at the bottom of the form.

## 9. Completeness ledger

| Remainder | Disposition |
| --- | --- |
| 4 `backFromSubview()` call sites + unit test | in this run — T1 |
| 5 e2e locators that look for the form inside the list section | in this run — TT1 |
| "Draft survives" e2e test now asserts removed behaviour | in this run — TT1 |
| Stale comments (always-mounted wrapper, section doc, form-dialog doc) | in this run — T1 |
| `CLAUDE.md` item 15 describes the inline form | in this run — T3 |
| "Edit in Settings" ×2 and "Manage agents…" call sites | in this run — T2 |
| Loading / missing-profile states on a deep link | in this run — already handled by `AgentProfileForm`, covered by T1 acceptance |
| Pipeline step "New agent…" dialog gaining a dirty confirm | in this run — T1 + TT1 (swept in by owner at plan approval) |
| Harness editor gaining a dirty confirm | in this run — T1 + TT1 (swept in by owner at plan approval) |
| `docs/plans/agent-profiles.md`, `settings-dialog-section-sidebar.md` | out of scope — historical plan records |
| CLI / TUI | out of scope — no equivalent surface exists |
