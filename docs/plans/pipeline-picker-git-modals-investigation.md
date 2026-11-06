# Investigation — Pipeline picker in the Git-integration launch modals

| Field | Value |
| --- | --- |
| Date | 2026-11-05 |
| Change | Add the New Task form's **Pipeline** picker ("one selection" with the Agent/profile picker) to the task-launch modals opened by Git integration — `CreateTaskFromIssueDialog` ("Work on this with Agetor", issue detail) and `ResolveConflictsDialog` ("Resolve with Agetor", PR detail) — so a task created from an issue or a conflicted PR can be launched as a pipeline parent instead of a single agent. |
| Agents | none (this pipeline step forbids subagents) — inline reading, `git`/`grep` static probes, one read-only Bun probe. |
| Flags | none — **no spikes run**: `node_modules` is absent in this worktree, so `bun run typecheck`, `bun test` and Playwright could not be executed here. |
| Branch | `feature/agetor-run-pipeline-from-git-integration` at `a5593d16` (clean; no commits beyond `main`) |

## 1. What we know

### 1.1 The contract

There is **no PRD, ticket or spec for this feature inside the repo**. The only contract is this pipeline step's task text. The closest in-repo specs are:

- `docs/plans/pipelines.md` — the original pipeline design, especially **D1/D5** (a pipeline task is a parent row; one-selection in New Task) and **T8** (the New Task `PipelinePicker`, lines 221–222).
- `docs/architecture/pipelines.md:151` — the current picker semantics: choosing a pipeline hides the harness/mode/model/effort block, clears the selected profile, and the create payload sends `pipelineId` **never alongside `agentProfileId`**.
- `docs/architecture/issue-tasks.md:5` and `:19` — the issue dialog and `ResolveConflictsDialog` are built on the shared `TaskLaunchPickers`, deliberately so they cannot drift.
- `docs/plans/resolve-pr-conflicts-with-agetor.md` — the PR-conflict dialog contract (`existingBranch`, locked worktree).
- `docs/architecture/clone-repository.md:61` — the fourth `TaskLaunchPickers` consumer; the backend gap that keeps it out of this change is documented in §1.6.

The owner's wording maps onto the code as follows:

| Owner phrase | App concept |
| --- | --- |
| "Work on this with Agetor button's modal" | `IssueActions` → `CreateTaskFromIssueDialog` (`GitHubDialog.tsx:7236`, `:7447`) |
| "modal from the PR" | `PullActions` → `ResolveConflictsDialog` (`GitHubDialog.tsx:7858`, `:8151`; only open GitHub PRs whose `mergeableState === "dirty"`, `!crossRepo`) |
| "Pipeline picker" | `PipelinePicker` + the New Task form's one-selection summary (`NewTaskForm.tsx:840–887`) |
| "possibly other modals opened by Git integration" | Inventory below: only these two create tasks; `CloneProjectDialog` is the one adjacent candidate |

### 1.2 The two in-scope modals today

**`CreateTaskFromIssueDialog.tsx`** (`src/mainview/components/kanban/CreateTaskFromIssueDialog.tsx`)
- Props `{open, onClose, context: IssueTaskContext, onCreated?}`; `useTaskLaunch(open)` at `:54`.
- Fetches the issue thread on open (`:109–134`), seeds an editable prompt (`:139–143`), seeds `TaskType` from the issue labels (`:148–152`), and owns `WorktreeOptions`/`PromptComposer` (`:76–96`, `:305–329`).
- Submit builds `createAndStartTask({...})` (`:173–206`) with `worktreePayload()`, `mode/model/effort/speed/maxMode`, optional `agentProfileId` (`:191`), `column:"ready"`, `references`, `taskType`, `issueUrl`, `issueSnapshot`; **no `pipelineId`** is sent.
- Submit gating: `canSubmit` at `:164–171` requires a fetched thread, non-empty prompt, `launch.effectiveStatus?.available`, `!submitting`, no prompt overage, and `wt.valid`.
- Prompt overage: `promptByteOverage(launch.effectiveKind, composeLaunchPrompt(launch.selectedProfile, prompt))` at `:157`; the warning names `launch.effectiveAgent` at `:162`.
- Renders `<TaskLaunchPickers launch={launch} />` at `:331`.

**`ResolveConflictsDialog.tsx`**
- Props `{open, onClose, context: ResolveConflictsContext, onCreated?}`; `useTaskLaunch(open)` at `:40`.
- Creates a task **on the PR head branch** via `isolation:"worktree"` + `existingBranch: context.headRef` (`:93–110`); renders `WorktreeOptions locked` (`:209`).
- Submit also sends `references`, `mode/model/effort/speed/maxMode`, optional `agentProfileId` (`:108`), `column:"ready"`; **no `pipelineId`**.
- Submit gating: `canSubmit` at `:85–86` requires a context, non-empty prompt, `launch.effectiveStatus?.available`, `!submitting`, no prompt overage.
- Prompt overage/name use `launch.effectiveKind` / `launch.effectiveAgent` (`:78`, `:83`).
- Renders `<TaskLaunchPickers launch={launch} />` at `:211`.
- Both dialogs submit through `createAndStartTask` (`TaskLaunchPickers.tsx:700–713`): `api.createTask` → `api.startTask`; a start failure deletes the just-created row and rethrows. That rollback matters for a pipeline parent: a start failure would delete the parent and cascade any step row.

### 1.3 The shared launch machinery (`TaskLaunchPickers.tsx`)

`TaskLaunchPickers.tsx` is the shared "launch one task from a prefilled prompt" module:
- `TaskLaunch` interface (`:44–138`) exposes loading/error, harnesses/agents/models, manual picks, `agentProfileId`/`selectedProfile`, `effectiveKind`/`effectiveAgent`/`effectiveStatus`, `rememberPicks`, `seed`.
- `useTaskLaunch(open, {withProfiles?, initial?})` (`:140–487`): self-fetches harnesses/statuses/models/prefs on open (`:236–323`), fetches profiles through the module-cached `useAgentProfiles` (`:226–231`), seeds manual picks, and resolves `effectiveAgent`/`effectiveKind` from the selected profile (`:437–447`).
- `TaskLaunchPickers` (`:500–691`) renders `AgentProfilePicker` then either the selected `AgentProfileCard` or the manual harness/mode/model/effort/speed/maxMode block. `hideProfilePicker` is used only by the agent-profile form (`AgentProfileFormDialog.tsx:338`).
- **Four consumers** (verified by grep):
  1. `CreateTaskFromIssueDialog.tsx:331`
  2. `ResolveConflictsDialog.tsx:211`
  3. `CloneProjectDialog.tsx:427` (ELI5 explainer; `useTaskLaunch(open)` at `:103`)
  4. `AgentProfileFormDialog.tsx:338` (Settings → Agents / pipeline step "New agent", via `AgentProfileFormBody`)

Consequences for this change:
- Pipeline support must be **opt-in**, or the Agent Settings form and the clone dialog would render a pipeline picker they cannot use.
- `effectiveAgent`/`effectiveKind`/`effectiveStatus` are the fields the two dialogs use for composer capabilities, prompt-overage checks, harness-auth hints and submit gating. If a pipeline is selected, those must describe the **pipeline's start-step profile**, not the hidden manual picker. Naively leaving them on the manual picker produces both false blocks and false allows (see §7).

### 1.4 New Task form's pipeline picker — the behavior to mirror

`NewTaskForm.tsx` already implements the intended UX:
- State `pipelineId` at `:208`; `selectedPipeline` at `:524`.
- Stale-selection guard: clear a selected pipeline once the list is known-loaded and no longer contains it (`:536–540`).
- Start step via `resolveStartStep(selectedPipeline.graph)` (`:548`; helper `src/shared/pipeline.ts:680–688`), then its profile and harness (`:549–553`).
- `effectiveAgent` falls back to the pipeline start-step profile's harness (`:568–570`); `overageKind`/`overageLabel` are pipeline-specific and `null` when the start profile is unresolved (`:598–608`).
- Submit payload includes `pipelineId` **only when set** (`:647`); `agentProfileId` is omitted when a pipeline is selected because the pickers clear each other (`:844–848`, `:884–888`). `mode/model/effort/...` are still sent, but the server overrides them from the pipeline.
- `rememberPicks` writes no preferences when a profile **or pipeline** is selected (`:659–666`); after submit both selections are cleared (`:672–673`).
- JSX: a `Pipeline` label + `PipelinePicker` (`:841–852`), then either the summary card (`Workflow` icon, name, "N steps · starts with <profile>", "Change" button; `:854–877`) or the Agent picker + manual block (`:879+`).
- `PipelinePicker` (`src/mainview/components/pipelines/PipelinePicker.tsx:34–243`) is a controlled searchable popover with `data-testid`s (`pipeline-picker`, `-trigger`, `-popover`, `-row`, `-none`, `-clear`) and, critically, `data-popover-open` only while open (`:143`) — the nested-dialog Escape contract (`docs/architecture/prompt-composer.md`, `CLAUDE.md:110`).
- The list comes from module-cached `usePipelines` (`src/mainview/lib/pipelines.ts:68–100`), which App already mounts after preferences load (`App.tsx:341`). No new API or hook is needed.
- Existing e2e coverage of the picker UX/summary is `e2e/pipelines-run.spec.ts:266–285`.

### 1.5 Backend: no schema or route change is required for the two dialogs

- `api.createTask` already types `pipelineId?: string` (`src/mainview/lib/api.ts:1667`) and `listPipelines` exists (`:690`).
- `POST /tasks` already accepts the tri-state `pipelineId` (`src/bun/server.ts:5492–5504`), and `createTask`:
  - rejects `pipelineId` + `agentProfileId` (`orchestrator.ts:8494–8497`),
  - validates the pipeline id/graph/every step profile (`:8498–8515`),
  - mirrors the start step's profile into the parent's cosmetic agent/model/effort/speed/maxMode fields (`:8545–8548`, `:8700–8725`),
  - stores `pipelineId` + initial idle `pipelineRun` (`:8723–8728`).
- `startTaskInner` branches a pipeline parent straight to `startPipelineRun` **before** harness/profile pre-flight (`orchestrator.ts:2054–2057`); the parent never spawns an agent.
- `startPipelineRun` (`pipeline-runner.ts:1731+`) validates/snapshots the graph, resolves the start step (human start forbidden), and materializes the shared worktree once. Each step row copies the parent's `workdir/isolation/branch/branchSource/worktreePath/baseRef`.
- `existingBranch` is resolved **before** the pipeline binding (`orchestrator.ts:8429–8470`), and `prepareWorkdir` checks out an existing-branch task on that branch (`worktree.ts:1009–1073`). Therefore `pipelineId` + `existingBranch` is a supported combination in code: a pipeline launched from the PR-conflict dialog would run every step in the worktree checked out on the PR head branch, exactly as the single-agent task does today. No route validation rejects the combination.
- CLI parity already exists: `agetor add --issue <url> --pipeline <id|name>` is supported by `baseInput` (`src/cli/commands/add.ts:458–490`) and the argument/wizard plumbing (`:255–271`, `:569–602`). The app's issue dialog is the surface missing parity.

### 1.6 "Other modals opened by Git integration" — inventory

| Surface | Creates a task? | Pipeline support today | Verdict |
| --- | --- | --- | --- |
| `CreateTaskFromIssueDialog` (issue detail) | yes | no | **in scope** (explicit) |
| `ResolveConflictsDialog` (PR detail, GitHub dirty PR) | yes | no | **in scope** (explicit) |
| `CloneProjectDialog` ("Clone repository…", Projects sidebar) | yes, the ELI5 explainer | no; `POST /projects/clone` validates a fixed launch whitelist (`server.ts:1178–1237`) and passes that to `createTask` (`:1787–1795`), so any `pipelineId` in the body is silently dropped | Git-adjacent, **not** opened by the Git dialog; would need server work (validate pipeline before cloning, decide ELI5 + `isolation:"none"` semantics). Ask the owner. |
| `AgentProfileFormDialog` (Settings → Agents / pipeline step "New agent") | no (saves a profile) | must stay none | out |
| `RunPanel` "Resolve Conflicts" (`RunPanel.tsx` around `:3770–3800`) | no — sends a message to the existing task | n/a | out |
| `GitHubDialog` itself (New PR / New issue composers) | no | n/a | out |
| `GitHubSetupDialog` (credentials guide) | no | n/a | out |

So the evidence says **exactly two Git-integration dialogs create tasks**; "possibly other modals" concretely means only the clone dialog, which has a backend gap.

### 1.7 Standards that apply

- **One-selection semantics** are already documented for the picker: choosing a pipeline hides the harness/mode/model/effort block, clears the selected profile, and the payload never carries both ids — `docs/architecture/pipelines.md:151`, `docs/plans/pipelines.md:221–222`.
- **The issue and PR dialogs are deliberately on shared `TaskLaunchPickers` so they cannot drift** — `docs/architecture/issue-tasks.md:5`.
- **The picker's launch surface must show the selected profile's own harness in `effectiveAgent`/`effectiveStatus`, never the hidden manual picker** — `docs/architecture/agent-profiles.md:42`. A pipeline extends the same rule: the start-step profile is the actual launch.
- **A popover inside a dialog carries `data-popover-open=""` only while open and closes on Escape** — `CLAUDE.md:110`, `docs/architecture/prompt-composer.md`; `PipelinePicker` already complies (`PipelinePicker.tsx:143`).
- **Update the subsystem doc in the same change** — `CLAUDE.md:5`. This change affects `docs/architecture/pipelines.md` (entry points/picker), `docs/architecture/issue-tasks.md` (shared pickers now include Pipeline), and arguably `docs/architecture/agent-profiles.md:42–44` (what "one selection" can now mean).
- **No component unit-test harness exists**: `bunfig.toml` scopes `bun test` to `src/`, and the repo has no React/jsdom testing-library setup; UI changes are proven by Playwright e2e (`package.json:25`, `playwright.config.ts`, docs plan precedent).
- **Server-managed columns** include `pipelineId`/`pipelineRun`; this change never patches them — `CLAUDE.md:97`.
- **No new dependency, route, migration or generated code** is involved.

### 1.8 Runtime & trust shape

- Local, single-user desktop app: one Bun main process owns SQLite + the localhost HTTP API; the React webview talks to it over loopback with per-launch tokens (`CLAUDE.md:21–27`). This change is a webview-only launch-surface change.
- Pipeline creation/execution stays server-authoritative: the server re-validates the pipeline id/graph/profiles, and pipeline parents never spawn agents themselves. No new trust boundary or user role is introduced.
- Issue text is already treated as untrusted in the seeded prompt (`docs/architecture/issue-tasks.md`); selecting a pipeline does not change that. Pipeline handoffs carry their own untrusted-content fencing (`docs/architecture/pipelines.md`).
- The only multi-surface concern is module-cached data (`usePipelines` / `useAgentProfiles`), which is shared per webview process, not across users.

## 2. What we proved

| Question | Verdict | Evidence | Versions / artifact |
| --- | --- | --- | --- |
| Which Git-integration surfaces create a task? | Exactly two: `CreateTaskFromIssueDialog` and `ResolveConflictsDialog`. | `grep -rn "createAndStartTask" src/mainview` and `grep -rn "api.createTask" src/mainview` → only `App.tsx` (New Task), the two dialogs, and `TaskLaunchPickers.createAndStartTask`; `grep -rn "TaskLaunchPickers" src/mainview` → 4 consumers, only two are Git dialogs | — |
| Has pipeline support ever existed in these dialogs? | No. | `git log --oneline -S "pipelineId" -- src/mainview/components/kanban/CreateTaskFromIssueDialog.tsx` and the same for `ResolveConflictsDialog.tsx` → empty; the only `NewTaskForm` hit is the original pipeline commit `6cd0241a` | — |
| Does the server already accept `pipelineId` from any API caller? | Yes, no change needed. | `server.ts:5492–5504` (wire shape), `orchestrator.ts:8493–8515` (validation), `api.ts:1667` (typed client) | — |
| Can a pipeline task be created on an existing branch (the PR case)? | Yes, by code path. | `orchestrator.ts:8429–8470` resolves `existingBranch` before pipeline binding; `pipeline-runner.ts:1731+`/`prepareWorkdir` reuse the parent branch; no route or `createTask` guard rejects the pair | — |
| Does `CloneProjectDialog` support pipelines? | No — the clone route's whitelist drops `pipelineId`. | `server.ts:1178–1237` builds only `{agentProfileId}` or `{agent, mode, model, effort, speed, maxMode, opencodeServer}`; `:1787–1795` passes that `launch` to `createTask` | — |
| Is the pipeline list already available to the webview? | Yes, module-cached; no new request layer. | `src/mainview/lib/pipelines.ts:68–100` (`usePipelines`), `App.tsx:341` mounts it after prefs load, `api.ts:690` | — |
| Does `PipelinePicker` satisfy the nested-dialog popover contract? | Yes. | `PipelinePicker.tsx:143` renders `data-popover-open` only while open; Escape listener at `:48–60`; `dialog.tsx:149` yields | — |
| Does the start-step resolver work on a minimal graph? | Yes. | `bun -e 'import {resolveStartStep,validatePipelineGraph} from "./src/shared/pipeline.ts"; const p={id:"p1",name:"Plan",instructions:"",agentProfileId:"a1",position:{x:0,y:0},subagents:{profileIds:[],cap:null},transition:"choose",join:"any"}; const v=validatePipelineGraph({steps:[p],edges:[],startStepId:null}); console.log(JSON.stringify({ok:v.ok,start:v.ok?resolveStartStep(v.graph)?.name:null}))'` → `{"ok":true,"start":"Plan"}` | bun 1.3.10 |
| Can the baseline be typechecked/tests run in this worktree? | **No — environment, not a code failure.** | `bun run typecheck` → `tsc: command not found`; `ls node_modules` → absent; `bun --version` → `1.3.10` | Requires `bun install --frozen-lockfile` |
| Is there a component-test layer? | No; UI changes are e2e-only. | `bunfig.toml:1–10` (`root = "src"`), `package.json` has no jsdom/testing-library; repo convention is Playwright | — |

**Not spiked, and why:** no runtime risk is load-bearing here beyond what code reading settles. The module-graph cycle risk (§7) is avoidable by importing `PipelinePicker` directly; a spike would only prove a workaround for a pattern we should not ship. Web search was unavailable in this environment (the search tool returned `cancelled`), but no new third-party library or external API/version is involved — every pattern used here (the existing picker, the existing hook, the existing dialog stack) is already in the repo — so no web source would change a decision.

## 3. What we're assuming

1. **The intended UX is New Task parity**, not a separate "pipeline-only" form: a `Pipeline` picker above the Agent picker, mutual exclusion, a summary card, and the manual harness block hidden while a pipeline is selected. If the owner wants a pipeline picker that coexists with the agent picker, the server's existing 400 (`createTask` rejects both ids) makes that impossible without a semantic change.
2. **`useTaskLaunch`/`TaskLaunchPickers` is the right extension point**, with a `withPipelines` opt-in (default false) so the Agent Settings form and clone dialog are untouched. If the owner wants only the issue dialog (not PR), the plan can wire one consumer; the shared implementation does not change.
3. **No backend, route, migration or type change is needed** for the two dialogs. If the owner includes the clone dialog, that assumption breaks (server whitelist + pre-clone validation + ELI5 semantics).
4. **The pipeline's start-step profile is the launch identity** used for `effectiveAgent`/`effectiveKind`/`effectiveStatus`, prompt-composer capability discovery, the overage check and the summary's "starts with" line. If the plan instead keeps the hidden manual harness, submit gating and capability discovery are wrong in opposite directions.
5. **Only the two dialogs are in scope**; the clone dialog is a separate decision (see §4.1).
6. **A selected pipeline persists across modal reopens** like the selected Agent profile does today (`useTaskLaunch` never clears `agentProfileId` on open; `CloneProjectDialog` clears it manually only for its own flow). New Task clears both after submit. If the owner wants a per-open reset, the plan adds one line in the hook/dialog and an e2e assertion.
7. **The modal pipeline picker does not render "Manage pipelines…"**: the Agent picker in these dialogs also passes no `onManageProfiles`, so both pickers are manage-free inside the Git dialog. If the owner wants the row, it needs a new callback threaded `App → GitHubDialog → IssueActions/PullActions → dialog → TaskLaunchPickers`.
8. **The success flow stays "Create & start" + the existing inline success chip**; no automatic navigation to the pipeline run view, matching the issue/PR behavior today and New Task's behavior.

## 4. What we must ask the owner

1. **Is "other modals opened by Git integration" meant to include the Clone repository dialog?** Evidence: only `CreateTaskFromIssueDialog` and `ResolveConflictsDialog` create tasks from the Git dialog; `CloneProjectDialog` uses the same `TaskLaunchPickers` for its ELI5 explainer, but `POST /projects/clone` drops any pipeline field (`server.ts:1178–1237`, `:1787–1795`). *Why it matters: including it means server work (pre-clone pipeline validation, `pipelineId` in the clone route, `isolation:"none"` pipeline semantics) rather than a UI-only change; excluding it keeps the change small and correct.*
2. **Confirm the "one selection" behavior:** should picking a pipeline clear the selected Agent profile and hide the harness/mode/model/effort block, showing the same summary card ("N steps · starts with …" + Change) as New Task? *Why it matters: this is the established pipeline rule (`docs/architecture/pipelines.md:151`, `NewTaskForm.tsx:840–887`) and the server rejects `pipelineId` + `agentProfileId` together (`orchestrator.ts:8494–8497`); any other UX requires a new contract.*
3. **What should happen when the chosen pipeline is not runnable** — start step has no profile, a referenced profile was deleted, or its harness is disabled/logged out? Recommended: show an inline reason in the summary and disable **Create & start** (using the start-step profile's real harness status), rather than letting the click hit a server error or a `createAndStartTask` rollback that deletes the parent. *Why it matters: `createTask` validates all step profiles (`orchestrator.ts:8503–8515`) but not harness availability; `startPipelineRun`/step `startTask` can still fail after creation, and `createAndStartTask` deletes the just-created row on start failure (`TaskLaunchPickers.tsx:700–713`). Note the two dialogs currently gate only on `available`, not `loggedIn`; `CloneProjectDialog` already adds `loggedIn !== false` for exactly this post-side-effect failure reason (`CloneProjectDialog.tsx:177–182`).*
4. **Should a selected pipeline survive closing and reopening the modal?** Today a selected Agent profile does; New Task resets both after submit. *Why it matters: `useTaskLaunch`'s open effect (`:236–323`) does not clear the profile; the issue dialog's per-open reset (`:109–134`) resets prompt/type/worktree/references but not launch selections. Either answer is cheap, but the e2e assertion differs.*
5. **Should the modal picker have a "Manage pipelines…" row?** The Agent picker in these dialogs has no "Manage agents…" row today; adding one requires threading a callback from `App.tsx` through `GitHubDialog` (whose only settings-style callback today is `onOpenSettings`, `App.tsx:2932–2943`) and closing both stacked dialogs before navigating. *Why it matters: a naive row would open the full-page pipelines view underneath the still-open Git dialog (an overlay rebase problem, `CLAUDE.md:111`).*
6. **Should creating a pipeline task from an issue/PR auto-open the pipeline run view?** Recommended: no — keep the existing "Task created and started" chip and let the user find the card (or open it from the board), matching today's behavior for single-agent tasks. *Why it matters: `onCreated` in `IssueActions`/`PullActions` only shows a timed chip (`GitHubDialog.tsx:7330–7336`, `:8092–8098`); auto-navigation would need `App`'s `navigate`/`openPipelineRun` wired through the inner dialog.*
7. **For the PR-conflict dialog specifically: confirm pipelines are allowed on the PR head branch.** The code supports it (`existingBranch` + parent worktree; steps share that worktree), but every step will receive the conflict-resolution goal and commits land on the PR's head branch — the same as a single-agent task today. If the owner wants a restriction (e.g. only pipelines whose steps are review-oriented), the picker needs filtering. *Why it matters: `ResolveConflictsDialog`'s prompt/worktree contract (`:93–110`, `buildResolveConflictsPrompt`) assumes one agent resolving then committing locally; a multi-step pipeline changes that assumption only in sequencing, not in mechanics.*

## 5. Completeness inventory

### 5.1 Callers of the changed surfaces

- `useTaskLaunch`: `CreateTaskFromIssueDialog.tsx:54`, `ResolveConflictsDialog.tsx:40`, `CloneProjectDialog.tsx:103`, `AgentProfileFormDialog.tsx:225`.
- `TaskLaunchPickers`: same four (`:331`, `:211`, `:427`, `:338`).
- `createAndStartTask`: `CreateTaskFromIssueDialog.tsx:178`, `ResolveConflictsDialog.tsx:93`.
- `TaskLaunch` type consumers: `agent-profile-form.ts`'s `trackLaunchInteractions` (structural, copies unknown fields), `AgentProfileFormDialog.tsx:247`.
- `PipelinePicker` consumers today: `NewTaskForm.tsx:843`; this change adds `TaskLaunchPickers` (and therefore both dialogs).

### 5.2 Entry points new code must be wired into

- `useTaskLaunch(open, { withPipelines: true })` in both dialogs (or a prop on `TaskLaunchPickers` if the hook is not extended).
- `TaskLaunchPickers` JSX: render the `Pipeline` section and the selected-pipeline summary; suppress the Agent picker/manual block when selected.
- Both dialogs' submit objects: add `...(pipelineId ? { pipelineId } : {})` and keep `agentProfileId` omitted when a pipeline is selected.
- Optional: after a successful create, call `refreshPipelines()` (as `NewTaskForm` does at `App.tsx:2661`) so the picker's/settings' `taskCount` isn't stale.
- Optional only (if §4.5 says yes): `App.tsx` → `GitHubDialog` → `IssueActions`/`PullActions` manage callback.
- No route table, job registry, composition root, config loading or migration touch.

### 5.3 Propagation surface

- `TaskLaunch` interface + `useTaskLaunch` return shape (`pipelineId`, `setPipelineId`, `selectedPipeline`, `pipelines`, `pipelinesLoaded`, `pipelinesError?`, `pipelineStartStep`, `pipelineStartProfile`, maybe `pipelinesEnabled`).
- `TaskLaunchPickers` markup and any new test ids.
- `CreateTaskFromIssueDialog.submit` / `canSubmit` / overage label.
- `ResolveConflictsDialog.submit` / `canSubmit` / overage label.
- `docs/architecture/pipelines.md:151`, `docs/architecture/issue-tasks.md:5`, optionally `docs/architecture/agent-profiles.md:42–44` and `README.md:60`/`:178`.
- New/extended e2e spec(s); no `src/shared` types, server, DB, bundle or CLI changes.
- No generated code or fixtures.

### 5.4 Existing data a migration would have to backfill

- **None.** `pipelines.graph` and `tasks.pipeline_run` are JSON; `tasks.pipeline_id` already exists; creating a task with `pipelineId` uses the existing columns. No SQL migration, no backfill.

### 5.5 Docs / config / examples that describe current behavior

- `docs/architecture/pipelines.md:151` — entry points/picker semantics.
- `docs/architecture/issue-tasks.md:5`, `:19` — issue dialog's shared pickers.
- `docs/architecture/clone-repository.md:61` — fourth consumer; keep accurate (pipeline remains off there unless §4.1 changes it).
- `docs/architecture/agent-profiles.md:42–44` — "one selection" and profile-vs-manual gating; pipeline becomes a third selection kind.
- `docs/plans/pipelines.md:221–222` — historical design; no rewrite needed, but a follow-up note could mention the new surfaces.
- `README.md:60`, `:178–196` — optional user-facing mention of launching a pipeline from an issue/PR.
- No config/env/example files.

### 5.6 What the change would orphan

- Nothing. No existing export, flag, route or preference becomes dead. `NewTaskForm`'s hand-rolled pipeline block could be extracted into a shared component, but that is optional refactoring, not an orphan.

## 6. Runnability

- **Dependencies:** `node_modules` is absent in this worktree. `bun run typecheck` fails with `tsc: command not found`; this is not a code failure. Run `bun install --frozen-lockfile` before any typecheck/test/e2e step.
- **Typecheck:** `bun run typecheck` (`package.json:25`).
- **Unit/integration:** `bun test` — Bun runner, scoped to `src/` by `bunfig.toml`, with `src/test-preload.ts`.
- **E2E:** Playwright under Bun — `bun node_modules/@playwright/test/cli.js test e2e/agent-profiles-dialogs.spec.ts` (or `e2e/issue-task.spec.ts` / `e2e/resolve-conflicts.spec.ts`). The shared Vite server is pinned to :5173 (`playwright.config.ts`; `reuseExistingServer` will silently reuse another checkout's Vite, so ensure nothing else holds 5173 or set `AGETOR_E2E_VITE_PORT`). Each worker gets its own headless backend/token/data dir and a GitHub stub (`e2e/fixtures.ts`). The fake Claude driver is enabled by the fixture (`AGETOR_CLAUDE_DRIVER=fake`).
- **Dev app:** `bun run dev` (Electrobun + `~/.agetor-dev`, API :4318) or `bun run dev:hmr` for Vite + app; `bun run hmr` alone is the webview.
- **Useful existing fixtures for the new e2e:** `e2e/agent-profiles-dialogs.spec.ts` already creates a profile and opens both dialogs (`createProfile` at `:235–256`, `openIssueTaskDialog` at `:306–331`, `openResolveConflictsDialog` at `:333–359`); `e2e/pipelines-run.spec.ts` has `makeStep` (`:84–95`) and `createPipelineRest` (`:117–147`), and the picker test at `:266–285`. Copying the small REST helpers is the repo's stated convention for these specs (they deliberately avoid cross-spec imports).

## 7. Risks & blast radius

- **Shared-hook regression:** `TaskLaunchPickers`/`useTaskLaunch` is used by the Agent Settings form and the clone dialog. Any new field or conditional must be opt-in (`withPipelines:false` default) and must leave the manual/profile branches byte-for-byte behavior-compatible; the e2e suites `e2e/agent-profiles.spec.ts`, `e2e/agent-profiles-dialogs.spec.ts`, `e2e/clone-project.spec.ts`, `e2e/clone-providers.spec.ts` are the guard.
- **Effective launch identity:** if a pipeline is selected but `effectiveAgent`/`effectiveStatus` still point at the hidden manual harness, the dialogs can block a valid pipeline (manual harness unavailable) or allow an invalid one (pipeline start harness unavailable). `effectiveKind` also drives the Gemini 4 KB overage warning; the pipeline case must key on the start step's harness, and an unresolved start profile should produce a visible warning rather than a silent disabled button.
- **Module cycle:** importing `PipelinePicker` through the `@/components/pipelines` barrel from `TaskLaunchPickers` would create `TaskLaunchPickers → pipelines/index → StepPanel → AgentProfileFormDialog → TaskLaunchPickers`. Import `@/components/pipelines/PipelinePicker` directly (and keep `usePipelines` from `@/lib/pipelines`) to avoid it.
- **Duplicate test ids:** the board's `NewTaskForm` always renders a `pipeline-picker` in the aside while the Git dialog is stacked over it, so any e2e locator must be scoped to the dialog (`issueTaskDialog.getByTestId("pipeline-picker")`), never `page.getByTestId(...)`.
- **Nested modal geometry:** the modal body is `overflow-y-auto`; `PipelinePicker` opens downward and extends the scroll region, like `AgentProfilePicker` already does. No CSS change is expected, but the picker belongs above the Agent block so it has room; Playwright scrolls into view. Escape is already handled by `data-popover-open`.
- **Invalid/unrunnable pipelines:** the picker lists every stored pipeline, including hand-edited/legacy graphs that pass the shape check but fail `validatePipelineGraph` on create, or whose step profile is gone. The server rejects them; the UX should surface that before submit (see §4.3) or rely on the dialog's inline `submitError`.
- **PR branch collision:** `createTask` rejects an `existingBranch` already checked out by another non-archived task (`orchestrator.ts:8449–8453`). This is existing behavior for single-agent conflict tasks and unchanged by pipelines; the error must still surface inline.
- **Create-then-start rollback:** `createAndStartTask` deletes the newly created row if `startTask` fails (`TaskLaunchPickers.tsx:700–713`). For a pipeline parent this cascade-deletes any step row created before the failure. This is existing dialog behavior, but a pipeline's start has more failure surface (step profile/harness, graph, worktree); §4.3's preflight is the mitigation.
- **Docs drift:** the pipeline architecture doc's entry-point line and the issue-tasks doc's shared-picker sentence become stale unless updated in the same change (`CLAUDE.md:5`).
- **Verification gap:** no baseline could be run here because dependencies are absent; the implementation step must install and run `bun run typecheck`, `bun test`, and the focused Playwright specs before claiming green.
