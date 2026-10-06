# Plan — Duplicate an agent into a prefilled create form

| Field | Value |
| --- | --- |
| Date | 2026-10-06 |
| Source | "a duplicate button to agents, similar to what we have for pipelines, so we can have an agent form prefilled to create a new agent" |
| Config | AGENTS_CONFIG.yml (balanced, pre-v3 schema — `phases.runners`, `defaults.fallback_model: sonnet`). `/implement --update` would move it to schema v3 without changing models. |
| Flags | none |
| Gates | Grill questions were skipped. Assumptions in §8. Plan still needs an explicit approve before any product code. |
| Branch | feature/duplicate-agents-feature |
| Base SHA | 39f2a4618c342be8486d397a1f2565578af50b83 |

Host for this run: **cursor** (this session has Cursor's Task tool, not Claude Code's Agent tool). Investigate was configured as `claude` / `sonnet` via `claude -p`. The CLI returned `Not logged in · Please run /login`, which is an auth failure, not a missing binary. The two investigation briefs were re-run on Cursor subagents with `claude-sonnet-5-5-low` and announced here. Later writing phases will try `claude -p` again and, if login is still missing, use the same Cursor substitution and say so.

## 1. Objective & success criteria

Settings → Agents gets a **Duplicate** button on each row. It opens the existing Add-agent subpage with the source agent's harness, model, effort, mode, fast, max mode, instructions, and skills filled in, and the name set to `Name (copy)` (then `Name (copy 2)`, …). Nothing is written until the user presses Save, which uses the normal `POST /agent-profiles` create. Cancel, Back, or Escape on an untouched prefill drops the draft and creates nothing.

Done when:

- Duplicating an agent opens the editor titled **Duplicate agent**, with the suffixed name and the copied fields.
- Save creates a second agent and returns to the list. The original is unchanged.
- A second duplicate of the same agent gets the next free `(copy N)` name.
- An untouched prefill does not ask to discard. Editing the name (or any other field) and then leaving does.
- A name that still collides (stale list) shows the existing save error from the 409.
- Unit tests cover the name helper and the settings-view shape. An e2e test covers the row → prefilled form → save path.

## 2. Context & constraints

Pipeline duplicate saves immediately. It does not open an editor.

- Button: `src/mainview/components/pipelines/PipelinesPage.tsx` (`data-testid="pipelines-duplicate"`, Copy icon between Edit and Delete).
- `handleDuplicate` (same file, ~37–53) calls `api.createPipeline` with the source description, graph, and maxSteps, then refreshes.
- `duplicateName` (~222–236) tries `"<base> (copy)"`, then `"<base> (copy 2)"`, truncated with `String.slice` to `PIPELINE_LIMITS.name`, uniqueness via `trim().toLowerCase()`. It shipped inside `6cd0241` (2026-09-29). `docs/plans/pipelines.md` only lists "edit/duplicate/delete"; the save-immediately choice is in the code. No e2e covers `pipelines-duplicate`. No CLI duplicate.

Agent create/edit is a Settings subpage, not an inline save.

- `SettingsView` member `{ kind: "agent-editor"; profileId: string | null }` — `src/mainview/lib/settings-dialog-view.ts:30`. `openAgentEditor` (~52–55). `null` is create.
- Settings → Agents row actions are text buttons Edit / Delete in `AgentProfilesSection.tsx` (~126–149), not icons. Add is `onAdd → openAgentEditor(null)`; Edit is `onEdit → openAgentEditor(id)` (`SettingsDialog.tsx` ~689–690).
- `AgentProfileForm` (`AgentProfileFormDialog.tsx`) only takes `profileId`. `null` mounts `AgentProfileFormBody` with `key="new"` and `editingProfile={null}` (~84–97). An id loads the row from `useAgentProfiles()` and seeds name, instructions, skills, and `useTaskLaunch({ initial })` on the first render (~159–188). Save is `profileId ? update : create` (~268).
- Dirty is `agentProfileTextDirty(form, baselineRef)` OR a launch-picker interaction (`agent-profile-form.ts:14–19`, form body ~190–230). The baseline is the first render. Seeding through that initializer leaves a prefilled create **clean**. A later `setForm` would mark it dirty. That distinction is load-bearing.
- Server name uniqueness is `trim().toLowerCase()` (`validateAgentProfileNameAndInstructions`, `src/bun/db.ts:1818–1827`). Cap is `AGENT_PROFILE_LIMITS.name` = 80 (`src/shared/agent-profile.ts`). Clash is 409 `AgentProfileNameError`. The form has no client-side uniqueness check; `saveError` already shows the server message.
- The form's React key in Settings is `` `${openCount}:${view.profileId ?? "new"}` `` (`SettingsDialog.tsx:763`). Two creates share `"new"`. A duplicate must not reuse that key or the blank-create body.
- Header title is `view.profileId ? "Edit agent" : "Add agent"` (`SettingsDialog.tsx:599`).
- No agent-duplicate route, column, or CLI subcommand exists. `POST /agent-profiles` is the create. Callers of create: this form (Settings subpage and `AgentProfileFormDialog` from a pipeline step), `agetor profile add`, and bundle import (direct `agentProfiles.insert`).

## 3. Approach & key decisions

Open the existing agent-editor subpage in create mode, seeded from the source row. Do not add an API, and do not save on click. Pipeline duplicate is the placement and name-suffix precedent only. The user asked for a prefilled form, which is the opposite of pipeline's immediate save.

**View.** Extend the existing member rather than adding a new `kind` (so `backFromSubview`, `activeSection`, `resolveEscape`, and `isFormSubpage` keep working):

```ts
{ kind: "agent-editor"; profileId: string | null; duplicateFromId: string | null }
```

`openAgentEditor(profileId, duplicateFromId = null)`. Edit (`profileId` set) always passes `duplicateFromId: null`. Duplicate is `openAgentEditor(null, sourceId)`. Blank Add stays `openAgentEditor(null)`.

**Form.** Add optional `duplicateFromId?: string | null` to `AgentProfileForm` (default `null`). When `profileId` is null and `duplicateFromId` is set, resolve that row from `useAgentProfiles()` the same way edit does (loading line, then the missing-profile error). Build the seed as a copy of that row whose `name` is `duplicateAgentName(...)`. Mount `AgentProfileFormBody` with `profileId={null}` (so Save creates) and `editingProfile={seed}`, keyed `dup-${source.id}`. Blank create is unchanged.

**Name.** New pure `duplicateAgentName(base, existingNames, maxLen)` in `src/mainview/lib/agent-profile-form.ts`.

- Candidates: `` `${base} (copy)` ``, then `` `${base} (copy ${n})` `` for n = 2, 3, … up to 999.
- Uniqueness: `trim().toLowerCase()`, matching `name_key`.
- Cap: UTF-16 `length` against `maxLen` (the server uses `.length`). Shorten the **base** so the suffix still fits. If the cut would leave a trailing high surrogate, drop it. Do not copy pipeline `duplicateName`'s `slice` of the whole candidate, which can eat the suffix on an 80-character name.
- The candidate list includes every loaded profile name, including the source.

**Dirty.** Because the seed is the first render, the baseline is the suffixed name and the copied instructions/skills, and `useTaskLaunch`'s `initial` does not set `launchTouched`. An untouched duplicate does not confirm on leave. Changing any of those fields does. Do not initialize `launchTouched` to true.

**Chrome.**

- Row button label **Duplicate**, `data-testid="agent-profile-duplicate"`, ghost button between Edit and Delete, same size as those two. The agent row uses words; the pipeline row uses icons. Match the agent row.
- Subpage title **Duplicate agent** when `duplicateFromId` is set and `profileId` is null. **Add agent** and **Edit agent** stay as they are.
- Settings form `key` includes the source id: `` `${openCount}:${view.profileId ?? view.duplicateFromId ?? "new"}` ``.
- `onSaved` already pops when the current view is still this create (`profileId === null`). That holds for duplicate.

**Out of this run** (see §9): CLI, a Duplicate button on the edit subpage, changing pipeline duplicate, a new route.

These decisions are from the code plus the skipped grill (§8), not from a spike. No spike was required: the form already seeds an edit from a profile object on first render, and create vs update is `profileId == null`.

## 4. Work breakdown — implementation tasks

### T1 — Name helper

- **Owns:** `src/mainview/lib/agent-profile-form.ts`
- **Depends on:** none
- **Goal:** export `duplicateAgentName(base: string, existingNames: readonly string[], maxLen?: number): string` with the rules in §3. Default `maxLen` to `AGENT_PROFILE_LIMITS.name`.
- **Acceptance:** `"Bug fixer"` with no collision → `"Bug fixer (copy)"`. Existing `"Bug fixer (copy)"` → `"Bug fixer (copy 2)"`. An 80-character base still ends with ` (copy)` and `result.length <= 80`. Comparison ignores trim and case. Does not throw.

### T2 — Settings view

- **Owns:** `src/mainview/lib/settings-dialog-view.ts`
- **Depends on:** none
- **Goal:** add `duplicateFromId: string | null` on the `agent-editor` member. `openAgentEditor(profileId, duplicateFromId = null)` returns both fields. If `profileId` is non-null, force `duplicateFromId` to null. Exhaustive switches stay valid without new branches (`agent-editor` is still one kind).
- **Acceptance:** blank, edit, and duplicate are three distinct values. `backFromSubview` / `activeSection` / `resolveEscape` / `isFormSubpage` behavior for `agent-editor` is unchanged.

### T3 — Form seed

- **Owns:** `src/mainview/components/kanban/AgentProfileFormDialog.tsx`
- **Depends on:** T1
- **Goal:** optional `duplicateFromId` on `AgentProfileForm`. Resolution order: edit (`profileId` set) unchanged; else duplicate (resolve source, seed name via `duplicateAgentName` against `profiles.map(p => p.name)`, body `profileId={null}`, key `dup-${id}`); else today's blank create. The pipeline-step `AgentProfileFormDialog` does not pass `duplicateFromId`.
- **Acceptance:** Save on a duplicate calls create, not update. Missing source uses the existing not-found state (Cancel only). Untouched seed is not dirty (`onDirtyChange(false)` after mount).

### T4 — Row button and subpage chrome

- **Owns:** `src/mainview/components/settings/AgentProfilesSection.tsx`, `src/mainview/components/settings/SettingsDialog.tsx`
- **Depends on:** T2, T3
- **Goal:** `onDuplicate: (profile: AgentProfile) => void` on the section. Button as in §3. Settings wires `onDuplicate={(p) => setView(openAgentEditor(null, p.id))}`, passes `duplicateFromId={view.duplicateFromId}` into `AgentProfileForm`, updates the title and the form `key`. `openAgentEditor(null)` and `openAgentEditor(id)` call sites keep working with the new default argument.
- **Acceptance:** Duplicate on a row opens the subpage described in §1. Add and Edit are unchanged. Deep link `initialAgentProfileId` still opens edit (`duplicateFromId: null`).

No `TODO` / `FIXME` / stub in any of these tasks. Remainder outside the owned files goes back to the orchestrator, not into a comment.

## 5. Work breakdown — test tasks

E2e applies. This is a user-visible Settings flow (row → form → save) that crosses the webview and `POST /agent-profiles`.

**Run recipe**

- Unit: `bun test src/mainview/lib/agent-profile-form.test.ts src/mainview/lib/settings-dialog-view.test.ts`
- E2e: `bunx playwright test e2e/agent-profiles-settings.spec.ts` (Playwright starts `bun run hmr` via `playwright.config.ts` `webServer`, unless one is already up). Specs use `e2e/fixtures.ts` (per-worker headless backend). Delete agents the spec creates. Do not assert list-wide counts.
- Typecheck: `bun run typecheck`

### T5 — Unit tests

- **Owns:** `src/mainview/lib/agent-profile-form.test.ts`, `src/mainview/lib/settings-dialog-view.test.ts`
- **Covers:** T1, T2
- **Cases:** the name examples in T1, including the 80-character base and a case-insensitive collision. `openAgentEditor(null)`, `openAgentEditor("prof-1")`, and `openAgentEditor(null, "prof-1")` equal the objects in §3. Existing `backFromSubview` / `activeSection` / `resolveEscape` / `isFormSubpage` expectations updated for the new field and still green. `openAgentEditor("prof-1", "other")` stores `duplicateFromId: null`.

### T6 — E2e

- **Owns:** `e2e/agent-profiles-settings.spec.ts` (extend; do not add a new spec file)
- **Covers:** T3, T4
- **Cases:**
  1. Create an agent with a unique name, instructions, and a non-default model if the fixture's harness allows a model change; otherwise assert harness + instructions + the name suffix, which the form always shows.
  2. Click `agent-profile-duplicate` on that row. The editor (`agent-profile-editor`) is showing, the dialog title is "Duplicate agent", `agent-profile-name` is `"<name> (copy)"`, instructions match.
  3. Save. The list contains the original and the copy. Open the copy and confirm instructions survived.
  4. Duplicate the original again. The name field is `"<name> (copy 2)"`.
  5. Open Duplicate and press Back without edits. No confirm dialog. No extra agent appears.
  6. Open Duplicate, change the name, press Back. The discard confirm appears. Dismissing it stays on the form. Accepting it returns to the list and does not create the agent.

## 6. Execution waves

| Wave | Tasks | Barrier |
| --- | --- | --- |
| 1 | T1, T2 in parallel | both landed |
| 2 | T3, then T4 | T3 before T4, because T4 passes the prop T3 adds. T4's two files stay with one agent. |
| 3 (Phase 6) | T5 and T6 in parallel | after the implementation review |

T3 and T4 are sequenced, not parallel: the only call site that passes `duplicateFromId` is `SettingsDialog.tsx`, which T4 owns, and the prop is added in T3's file. Sequencing avoids a broken typecheck between them.

## 7. Blast radius & risks

- `openAgentEditor` gains an optional second argument. Call sites: `settings-dialog-view.ts`, `SettingsDialog.tsx` (three: deep link ~266, Add, Edit). Tests in `settings-dialog-view.test.ts` compare the whole object and must learn `duplicateFromId`.
- `AgentProfileForm` is also mounted by `AgentProfileFormDialog` (pipeline step "New agent…"). The new prop defaults to `null`, so that dialog stays a blank create.
- Dirty-tracking must stay first-render seeding. An effect that copies fields after mount will make every duplicate look dirty and prompt on Back. That is the bug to avoid.
- Name cap uses UTF-16 length, same as the server. A code-point slice could disagree with `trimmed.length > 80`.
- Client uniqueness is against the cached list. A 409 still surfaces in `agent-profile-form-error`. No retry loop.
- A disabled or missing harness uses the same `useTaskLaunch` initial path as Edit. No special duplicate fallback.
- Rollback is a revert of the four production files. No migration.

## 8. Open questions / assumptions

The grill was presented and skipped. Proceeding on these. Each one is reversible.

| Question | Answer | Source | Confidence |
| --- | --- | --- | --- |
| Save immediately, like pipelines, or open a form? | Open a prefilled create form. Nothing is inserted on click. | The request: "so we can have an agent form prefilled to create a new agent". Pipeline immediate-save would ignore that. | high |
| What goes in Name? | `Name (copy)`, then `Name (copy 2)`, … A same-name prefill cannot be saved (409). A blank name cannot be saved either. | Pipeline `duplicateName`, plus the server `name_key` rule. | high |
| Where is the button? | Settings → Agents row only, between Edit and Delete. | Pipelines have a single list button. The request says "a duplicate button", singular, similar to that. | medium — skipped question; edit-page and CLI were the alternatives |
| Untouched Back / Escape? | Leave quietly. Confirm only after an edit. | Existing dirty model, if the seed is the first render. Forcing a confirm would mean marking a prefill dirty, which the form is built not to do. | high |
| Subpage title? | "Duplicate agent" when opened from Duplicate. Add and Edit titles unchanged. | Judgment. Low blast radius. | medium |
| Button look? | Text "Duplicate", matching Edit and Delete on that row. | The agent row is labeled buttons; the pipeline row is icons. Matching the row the button sits on. | high |

No one-way decision was scoped out. No data migration, no public API change, no auth change.

## 9. Completeness ledger

| Candidate | Disposition |
| --- | --- |
| Settings → Agents row button, navigation, title, form key | In this run — T4 |
| Form seed from the source profile, Save creates | In this run — T3 |
| Unique `(copy)` / `(copy N)` name, suffix survives the 80-character cap | In this run — T1 |
| `duplicateFromId` on the existing `agent-editor` view; edit forces it null | In this run — T2 |
| Untouched prefill is clean; edited prefill confirms discard | In this run — T3 (falls out of first-render seed) + T6 asserts it |
| Loading and missing-source states | In this run — T3 reuses the edit form's existing states |
| 409 name clash still shown on the form | In this run — existing `saveError`; no new UI |
| Unit + e2e coverage of the above | In this run — T5, T6 |
| `AgentProfileFormDialog` (pipeline "New agent…") stays a blank create | In this run — prop defaults null; T3 must not require it |
| CLI `agetor profile duplicate` | Out of scope — a different surface. Pipelines have no CLI duplicate, and the request is a button that opens the form. |
| Duplicate button on the edit subpage | Out of scope — a second entry point. Pipelines do not duplicate from the editor. |
| Changing pipeline `duplicateName` (it can drop the suffix when the base is at the cap) | Out of scope — pre-existing, and this run does not share that function. |
| Copying tasks bound to the source agent | Out of scope — `taskCount` is server-derived. A new agent starts at 0. |
| New `POST /agent-profiles/duplicate` route | Out of scope — the create route already accepts every copied field. |
