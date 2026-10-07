# Plan — Duplicate agent leftovers

| Field | Value |
| --- | --- |
| Date | 2026-10-06 |
| Source | Follow-up to `docs/plans/duplicate-agent-profile.md`. Owner asked to implement the five items that plan left out. |
| Config | AGENTS_CONFIG.yml (balanced, pre-v3 `phases.runners`). `/implement --update` exists; this run does not rewrite the config. |
| Flags | none |
| Gates | Grill skipped by the owner. Assumptions below are the recommended answers. Plan still needs approval before any code. |
| Branch | `feature/duplicate-agents-feature` |
| Base SHA | `05c9a3ea10763f3fab36e447369510ba89a77f8d` (wave 0 committed the prior Settings e2e coverage; review diffs against this ref) |

## 1. Objective & success criteria

The Settings list Duplicate (prefilled create form, nothing inserted until Save) stays as it is. This run adds the five leftovers:

1. `agetor profile duplicate <ref> [--name <name>] [--with-tasks]` creates the copy immediately and prints it.
2. The agent edit subpage has a Duplicate button. A dirty edit asks to discard, then opens the same prefilled create form from the **saved** agent.
3. Copying tasks is opt-in and off by default: a checkbox on the duplicate form, and `--with-tasks` on the CLI. Each copied task is a new backlog card bound to the new agent.
4. `POST /agent-profiles/:id/duplicate` is the one writer. The CLI always uses it. The duplicate form uses it on Save (so an edited prefill and the task copy land together). Blank create and Edit keep `POST` / `PATCH`.
5. Pipeline `duplicateName` keeps the ` (copy)` suffix inside the 80-character cap. Pipeline duplicate still saves immediately.

Done when: the route, CLI, edit button, task-copy opt-in, and pipeline name fix are covered by unit or daemon tests; the edit-button and checkbox flows are in the existing Settings agents Playwright spec; typecheck is green.

## 2. Context & constraints

Grounded in the Phase 1 read (no spikes; the behavior is in-repo).

- List Duplicate already opens `{ kind: "agent-editor", profileId: null, duplicateFromId }` via `openAgentEditor(null, id)` (`SettingsDialog.tsx` ~691). Title is "Duplicate agent" (`SettingsDialog.tsx` ~599). Save calls `createAgentProfile` while `profileId` is null (`AgentProfileFormDialog.tsx` ~291).
- `duplicateAgentName` (`src/mainview/lib/agent-profile-form.ts` ~33) shortens the base and keeps the suffix, surrogate-safe, uniqueness `trim().toLowerCase()`. The server name cap is `AGENT_PROFILE_LIMITS.name` (80).
- Pipeline `duplicateName` (`PipelinesPage.tsx` ~225) slices the **whole** candidate to `PIPELINE_LIMITS.name` (80, `src/shared/types.ts`). A base of 80 characters loses ` (copy)` and then collides with itself. No unit test. `handleDuplicate` (~37) still calls `api.createPipeline` immediately.
- `leaveSubpage` (`SettingsDialog.tsx` ~541) already confirms "Discard unsaved changes?" from `subpageDirtyRef` and then runs a `proceed` callback. The edit-page button can reuse it: `leaveSubpage(() => setView(openAgentEditor(null, savedId)))`.
- `POST /agent-profiles` (`server.ts` ~4007) accepts a full profile body and 409s on `AgentProfileNameError`. It does not copy tasks.
- Tasks bind through `tasks.agent_profile_id` (`db.ts` `setAgentProfile`, `taskCount`). `createTask` (`orchestrator.ts` ~5932) overrides harness/model/effort/mode/fast/maxMode from `agentProfileId`. There is no duplicate-task path. Pipeline parent and step rows are a different object (`pipelineId` / `pipelineParentId`) and must not be copied. `taskCount` includes archived rows.
- CLI: `cmdAgentProfile` (`src/cli/commands/agent-profile.ts`). Subcommands listed in the `default` throw (~130), `USAGE["profile"]` (`usage.ts` ~166), the global help line (`index.ts` ~60), and `usage.test.ts` which pins that first line. Integration tests live in `src/cli/agent-profile-daemon.test.ts` (in-process server, port 4598). Pure flag tests live in `agent-profile.test.ts`. No TUI profile surface.
- `createTask` resolves `baseRef` with git and can write an issue snapshot. A SQL transaction cannot wrap that. Task-copy failure handling is specified in §3.
- Playwright must be launched as `bun ./node_modules/.bin/playwright` because `e2e/helpers.ts` imports `bun:sqlite`. The Settings agents spec is serial. `filter({ hasText })` is a substring, so a row named `X` also matches `X (copy)` unless it also `hasNotText: "(copy)"`.
- Host is Cursor. `claude -p` is not logged in, so labor runs on Cursor Task subagents (Sonnet for implement/tests, Opus for review). That substitution is announced, not a silent model swap.

## 3. Approach & key decisions

**One route, two callers.** `POST /agent-profiles/:id/duplicate` reads the source profile and inserts a new one.

- Omitted fields are copied from the source (harness, model, effort, mode, fast, maxMode, instructions, skills).
- A present field overrides the copy, so the Settings form can send the edited prefill.
- `name` omitted → server calls the shared copy-name helper against existing profile names. `name` present → used as given; a clash is 409 and nothing is written.
- `copyTasks` omitted or false → no tasks. `true` → copy eligible tasks after the profile insert.
- Unknown source → 404. Archived is not a profile state. Validation errors → 400, nothing written.

**Task copy is opt-in and narrow.** Eligible source rows: `agent_profile_id` = source, `archived_at` is null, `pipeline_id` is null, `pipeline_parent_id` is null. Each copy is a new task via `createTask` with `title`, `prompt`, `workdir`, `isolation`, `baseRef`, `references`, `taskType`, and `agentProfileId` set to the **new** profile. Column stays the create default (backlog). Not copied: runs, events, worktree path, branch, backlog drafts, sent files, plans, unread, `issueUrl` / `prUrl` / issue snapshot, pipeline fields. Copies are not started.

If the profile insert succeeds and a later task copy throws, the new profile and any tasks already created stay. The 201 body is `{ profile, copiedTasks, taskCopyErrors }`. `copiedTasks` is the created tasks (empty when `copyTasks` is false). `taskCopyErrors` is `{ sourceTaskId, error }[]`. The CLI prints a yellow line per error and still exits 0 when the profile exists; a 4xx/5xx from the profile insert itself is a hard failure.

**Shared name helper.** Move `duplicateAgentName` to `src/shared/duplicate-name.ts` (no runtime imports outside `src/shared/`). `agent-profile-form.ts` re-exports it so current importers keep working. Pipeline `duplicateName` becomes a call to that function with `PIPELINE_LIMITS.name`. Pipeline still saves immediately; only the truncation bug changes.

**Edit-page Duplicate copies the saved row.** The button is on the page-variant footer only when `profileId` is set (hidden on Add, on the duplicate form, and on the pipeline "New agent…" dialog). It calls `leaveSubpage`, so a dirty draft must be discarded before the prefill opens. The prefill is the saved profile, not the draft. The list-row button is unchanged.

**CLI creates immediately** because there is no form. `--name` overrides the generated name. `--with-tasks` sets `copyTasks: true`. No other field flags: editing fields is `profile edit` on the new id. Human output: `✓ duplicated profile <name> (<id>)` plus `copied N tasks` when `--with-tasks`. `--json` prints the route body.

These decisions are assumptions from the skipped grill (§8), not measured spikes.

## 4. Work breakdown — implementation tasks

### T1 — Shared copy-name helper, pipeline uses it

Owns:

- `src/shared/duplicate-name.ts` (new; move the function and `endsInHighSurrogate`)
- `src/mainview/lib/agent-profile-form.ts` (delete the function, re-export from shared)
- `src/mainview/components/pipelines/PipelinesPage.tsx` (`duplicateName` delegates to the shared helper with `PIPELINE_LIMITS.name`; `handleDuplicate` stays immediate `createPipeline`)

Acceptance: an 80-character pipeline base duplicates to a name that ends with ` (copy)` and is at most 80 UTF-16 code units. Agent form still imports `duplicateAgentName` from `agent-profile-form.ts`. No behavior change to pipeline save.

### T2 — Duplicate route and task copy

Depends on T1. Owns:

- `src/bun/duplicate-agent-profile.ts` (new; load source, build input, insert profile, copy eligible tasks)
- `src/bun/server.ts` (one route `POST /agent-profiles/:id/duplicate`, authed, same validation style as `POST /agent-profiles`)
- `src/mainview/lib/api.ts` (`duplicateAgentProfile`)
- `src/cli/api-client.ts` (client method only; the command is T3)

Acceptance: omitted body copies every profile field and generates the name. Explicit `name` and field overrides win. 404 unknown id. 409 clash writes nothing. `copyTasks: true` copies only non-archived, non-pipeline tasks, bound to the new id, backlog, and does not start them. A task-copy throw leaves the profile and records `taskCopyErrors`. `copyTasks` false or omitted copies zero tasks. Source profile row is unchanged.

### T3 — CLI `profile duplicate`

Depends on T2. Owns:

- `src/cli/commands/agent-profile.ts`
- `src/cli/usage.ts`
- `src/cli/usage.test.ts` (the pinned `USAGE["profile"]` first line)
- `src/cli/index.ts` (global help line only)
- `CLAUDE.md` (the item-15 profile subcommand list only — one phrase adding `duplicate`)

Acceptance: `duplicate <ref> [--name <n>] [--with-tasks]`. Unknown ref errors before the route call, same as `show`. `--json` prints the body. Human line names the new profile. `--with-tasks` is the only way the CLI copies tasks. Help text lists the subcommand. Export/import stay in front of `getClient`.

### T4 — Edit-page button and copy-tasks checkbox

Depends on T2. Disjoint from T3. Owns:

- `src/mainview/components/kanban/AgentProfileFormDialog.tsx`
- `src/mainview/components/settings/SettingsDialog.tsx`

Acceptance:

- Page-variant edit footer shows `Duplicate` (`data-testid="agent-profile-form-duplicate"`) before Cancel. Hidden when not editing a saved profile.
- Click runs `leaveSubpage(() => setView(openAgentEditor(null, id)))`. Dirty → existing discard confirm. Cancel stays on the edit. Confirm opens "Duplicate agent" prefilled from the saved row.
- Duplicate form shows a checkbox, default off (`data-testid="agent-profile-copy-tasks"`): "Also copy tasks that use this agent". Helper text says new backlog cards; runs and pipeline steps stay on the original.
- Save on a duplicate calls `duplicateAgentProfile(sourceId, fields + copyTasks)` instead of `createAgentProfile`. Blank create and Edit are unchanged. A `taskCopyErrors` entry toasts and still closes on a created profile, matching the 201 contract.

## 5. Work breakdown — test tasks

E2e applies. The user-visible flows are the edit-page button and the checkbox. CLI and the route are process-boundary and get daemon/endpoint tests. Pipeline truncation is a pure helper and gets a unit test.

Recipe: unit `bun test <file>`. Endpoint tests follow `src/bun/agent-profiles` / server tests with `AGETOR_DATA_DIR` in a temp dir. CLI: `src/cli/agent-profile-daemon.test.ts`. E2e: `bun ./node_modules/.bin/playwright test e2e/agent-profiles-settings.spec.ts` (serial; append tests, do not insert before the first test). Typecheck: `./node_modules/.bin/tsc --noEmit`.

### T5 — Unit tests for the shared helper

Depends on T1. Owns `src/shared/duplicate-name.test.ts` and moves the existing `duplicateAgentName` cases in `src/mainview/lib/agent-profile-form.test.ts` only if they would otherwise duplicate; keep one assertion in the webview file that the re-export still works, and put the cap/surrogate/pipeline-max cases in the shared file. Include: 80-char base ends with ` (copy)` and length ≤ 80; emoji base does not cut a surrogate; `(copy 2)` on collision.

### T6 — Route tests

Depends on T2. Owns a new `src/bun/duplicate-agent-profile.test.ts` (or the existing agent-profile endpoint file if that is where `POST /agent-profiles` is tested — prefer a new file so it does not collide with T5). Cases: copy fields and generated name; `--name` clash 409; unknown id 404; `copyTasks` copies a normal task and skips an archived task and a pipeline step; source unchanged; one failing `createTask` returns `taskCopyErrors` and still returns the profile.

### T7 — CLI tests

Depends on T3. Owns `src/cli/commands/agent-profile.test.ts` (flag parse if a pure parser is added) and `src/cli/agent-profile-daemon.test.ts`. Cases: duplicate prints the new name; second duplicate is `(copy 2)`; `--name` taken fails; `--with-tasks` copies one backlog task and does not copy a pipeline step; `--json` shape.

### T8 — Settings e2e

Depends on T4. Owns `e2e/agent-profiles-settings.spec.ts` only (append). Cases:

- From the edit subpage, Duplicate opens "Duplicate agent" with the saved name plus ` (copy)`. Dirty name, Duplicate, dismiss confirm, name still dirty. Confirm discard, prefill shows the saved name plus ` (copy)`, not the dirty name.
- Checkbox off, Save, no new task for that profile (`taskCount` stays 0 if the source had a task... source taskCount unchanged, new profile `taskCount` 0).
- Checkbox on, source has one ordinary task created via the API, Save, new profile `taskCount` is 1, source `taskCount` unchanged, new task title matches, column is backlog.

Do not assert a list-wide agent count. Source rows must `hasNotText: "(copy)"`.

## 6. Execution waves

| Wave | Tasks | Barrier |
| --- | --- | --- |
| 0 | Commit the already-dirty Settings e2e file alone, if it is still dirty. No new product code. | Before T1 |
| 1 | T1 | Shared helper exists |
| 2 | T2 | Route exists |
| 3 | T3 and T4 in parallel (disjoint files) | CLI and UI both call the route |
| 4 | T5, T6, T7, T8 in parallel (disjoint test files) | Tests exist |
| 5 | Run unit + the Settings e2e + typecheck. Fix loop if red. | Green |

Review runs after wave 3, before or overlapping wave 4. The reviewer is told tests are not in the diff yet.

## 7. Blast radius & risks

- `server.ts` and `orchestrator.ts` are hot. Task copy goes through `createTask`, not a hand-rolled insert, so worktree pinning and profile override stay in one place. The new module owns the loop.
- `createTask` plus `agentProfileId` re-reads the profile. The copy must pass the **new** id after insert, not the source id.
- A task whose `baseRef` does not resolve fails that one copy and becomes a `taskCopyError`. The profile remains.
- Settings form key `${openCount}:${profileId ?? duplicateFromId ?? "new"}` changes when moving from edit to duplicate, so the body remounts. Inner keys `dup-${id}` vs the edit id already differ.
- Pipeline list duplicate is the only caller of `duplicateName`. Immediate save stays.
- `usage.test.ts` will fail if the profile help line changes and the test is not updated (T3 owns that test file; T7 must not also edit it — T3 includes the assertion update, T7 adds daemon cases only).
- Peer `ocean-spring-e136` was on `fix/pipeline-done` in another worktree. This branch is `feature/duplicate-agents-feature`. Pipeline file touch is `PipelinesPage.tsx` only.

## 8. Open questions / assumptions

Grill skipped. Each row is the recommended answer, used as the plan. Low-confidence rows are the ones whose other answer would change the shape.

| Question | Answer used | Source | Confidence |
| --- | --- | --- | --- |
| CLI shape | Create immediately. Optional `--name`. No other field flags. | CLI has no form; `profile add` already posts a full body | high |
| Edit-page button | Opens the saved-row prefill. Dirty edit goes through `leaveSubpage`. | `leaveSubpage` already discards then runs `proceed` | high |
| Copy the unsaved draft? | No. | Draft is not the saved agent; copying it would skip the discard confirm's meaning | high |
| Copy tasks? | Yes, opt-in, default off (checkbox and `--with-tasks`). | Owner listed it; always-on would create N cards on every Duplicate | medium — **shape change if they wanted always-on or not at all** |
| Which tasks? | Non-archived, not a pipeline parent, not a pipeline step. New backlog cards. Same title, prompt, workdir, isolation, baseRef, references, taskType. Bound to the new agent. No runs, worktrees, issue/PR links, or auto-start. | `createTask` + pipeline rows are a different object | medium — **shape change if issue links or archived tasks should copy** |
| New route? | Yes, `POST /agent-profiles/:id/duplicate`, because the profile and the optional task copies are one operation. | `POST /agent-profiles` cannot name the source | high if tasks are in; drop the route only if task copy is cut |
| Partial task-copy failure | Profile stays, errors listed, HTTP 201 | `createTask` does git I/O; a SQL rollback cannot undo it | medium |
| Pipeline helper | Fix suffix truncation only. Still immediate save. | The reported bug | high |
| Pipeline CLI duplicate | Out of scope | Not in the leftover list | high |

## 9. Completeness ledger

| Item | Disposition |
| --- | --- |
| Shared name helper used by the agent form, the route, and pipeline duplicate | In this run — T1, T2 |
| CLI help, usage test, index help line, unknown-subcommand string | In this run — T3 |
| `CLAUDE.md` item 15 subcommand list | In this run — T3 |
| Edit footer button, dirty guard, checkbox, Save path | In this run — T4 |
| Route validation, 404, 409, task filter, partial failure | In this run — T2, T6 |
| Settings e2e for the button and the checkbox | In this run — T8 |
| Daemon test for the CLI | In this run — T7 |
| List-row Duplicate | Already shipped. Unchanged. Not a leftover. |
| Blank create and Edit save paths | Stay on POST/PATCH — T4 |
| Pipeline "New agent…" dialog | No Duplicate button (no saved profile). Out of scope — different surface. |
| TUI profile commands | No profile UI there. Out of scope. |
| `agetor pipeline duplicate` | Out of scope — a different command, not requested. |
| Copying runs, worktrees, starting the copies, issue/PR provenance | Out of scope — a different ticket (would spawn work or fork provenance). |
| Bundle export of the new profile | No change. A duplicated profile is an ordinary row. |
| Rewriting `AGENTS_CONFIG.yml` to schema v3 | Out of scope — `/implement --update`. |
