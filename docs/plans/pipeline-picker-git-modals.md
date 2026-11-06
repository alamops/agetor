# Plan — Pipeline picker in the Git-integration launch modals

| Field | Value |
| --- | --- |
| Date | 2026-11-06 |
| Source | Pipeline step task text ("Add the Pipeline picker on the Work on this with Agetor button's modal…") + `docs/plans/pipeline-picker-git-modals-investigation.md` + `docs/plans/pipeline-picker-git-modals-grill.md` (rounds 1–2 under `docs/plans/pipeline-picker-git-modals-grill/`) |
| Flags | none |
| Gates | grilled + owner-settled (12 decisions, no open owner questions); plan approved for execution by this pipeline step |
| Status | implemented — typecheck + focused/guard e2e green; `bun test` 11754 pass / 2 pre-existing unrelated failures (`daemon-handoff`, `orchestrator-opencode-server`) |
| Branch | `feature/agetor-run-pipeline-from-git-integration` |
| Base SHA | `a5593d16` |

## 1. Objective & success criteria

**Objective.** In the two Git-integration task-launch dialogs — `CreateTaskFromIssueDialog` ("Work on this with Agetor", issue detail) and `ResolveConflictsDialog` ("Resolve with Agetor", GitHub PR detail) — let the user select a saved pipeline and launch the task as a pipeline parent, with New Task's exact one-selection UX and a pre-submit runnability check, without changing any other `TaskLaunchPickers` consumer.

Each criterion names the production path that produces it and the test that drives that path.

| # | Success criterion | Production path | Proven by |
| --- | --- | --- | --- |
| 1 | Issue dialog renders a **Pipeline** picker above the Agent picker; picking a pipeline hides the Agent picker + manual block and shows the summary card (name, step count, "starts with <profile>", **Change**); Change clears the selection and restores the Agent block. | `IssueActions` (`GitHubDialog.tsx:7236`) → `CreateTaskFromIssueDialog` (`:7447`) → `TaskLaunchPickers` → `PipelinePicker` | T6 e2e (`e2e/issue-task.spec.ts`) |
| 2 | Same picker, summary and Change behavior in the PR-conflicts dialog. | `PullActions` (`GitHubDialog.tsx:7858`) → `ResolveConflictsDialog` (`:8151`) → `TaskLaunchPickers` → `PipelinePicker` | T7 e2e (`e2e/resolve-conflicts.spec.ts`) |
| 3 | Submitting with a pipeline selected sends `pipelineId` and **never** `agentProfileId`; the server creates a pipeline parent. The issue dialog keeps its worktree options; the PR dialog keeps `isolation:"worktree"` + `existingBranch: headRef`. | dialog `submit()` → `createAndStartTask` (`TaskLaunchPickers.tsx:700`) → `POST /tasks` → `createTask` (`orchestrator.ts:8493-8515`) → `startTask` → `startPipelineRun` | T6 + T7 e2e (task-row assertions) |
| 4 | An unrunnable pipeline is listed but blocks **Create & start** with an inline reason: invalid stored graph, no/ambiguous start step, human start step, any non-human step with no/deleted profile, or the start step's harness disabled/unavailable/logged out. Clearing the pipeline restores a normal single-agent launch. | `resolvePipelineLaunch` (new) → `useTaskLaunch` → summary reason → both dialogs' `canSubmit` | T1 unit + T6/T7 e2e |
| 5 | While a pipeline is selected, the composer's discovery, the overage check, the availability/auth hint and submit gating describe the **start-step profile's harness**, never the hidden manual picker. A pipeline whose start profile uses an unavailable harness is blocked even though the manual harness is available; a normal launch in the same dialog stays enabled. | `useTaskLaunch`'s `effectiveAgent`/`effectiveKind`/`effectiveStatus`/`overageKind`/`overageLabel` | T1 unit (preflight) + T6/T7 e2e (unavailable-start-harness case) |
| 6 | The picker's **Manage pipelines…** row closes both stacked dialogs and opens the Pipelines list; when the draft is dirty it asks "Discard this task draft and open Pipelines?" first, and Cancel keeps the dialog open. | `PipelinePicker` manage row → dialog handler → `onManagePipelines` → `GitHubDialog` → `App.openPipelinesFromGit` (`closeGithubDialog` + `openPipelinesPage`) | T6 + T7 e2e |
| 7 | Other launch surfaces are unchanged: Agent Settings (`withProfiles:false`, `hideProfilePicker`) and `CloneProjectDialog` render no pipeline UI; `NewTaskForm`'s picker is unchanged apart from the manage row honoring `disabled`. | `withPipelines` defaults to `false`; all new props optional; `PipelinePicker` change is additive | T9 guard e2e (`agent-profiles*`, `clone-*`, `pipelines-run`) + typecheck |
| 8 | The subsystem docs describe the new surfaces in the same change. | `docs/architecture/{pipelines,issue-tasks,agent-profiles,clone-repository}.md` | T8 review |

## 2. Context & constraints

### Grounded findings (all re-checked at `a5593d16`)

- **Exactly two Git dialogs create tasks.** `grep` for `createAndStartTask`/`api.createTask` finds only `App.tsx` (New Task), `CreateTaskFromIssueDialog.tsx:178`, `ResolveConflictsDialog.tsx:93`, and the shared helper. `TaskLaunchPickers` has four consumers (`TaskLaunchPickers.tsx:331`, `ResolveConflictsDialog.tsx:211`, `CloneProjectDialog.tsx:427`, `AgentProfileFormDialog.tsx:338`); only the first two are Git launch dialogs. `CloneProjectDialog` is out: `POST /projects/clone` validates a fixed launch whitelist and drops `pipelineId` (`src/bun/server.ts:1178-1237`, `:1787-1795`).
- **No backend, route, schema, migration or type change is needed.** `api.createTask` already types `pipelineId` (`src/mainview/lib/api.ts:1667`); `POST /tasks` accepts it (`server.ts:5492-5504`); `createTask` rejects `pipelineId` + `agentProfileId`, validates the graph/start step/every non-human step's profile and mirrors the start step's cosmetic fields (`orchestrator.ts:8493-8515`, `:8545-8548`, `:8700-8732`); `startTask` branches a pipeline parent to `startPipelineRun` before its own harness gates (`orchestrator.ts:2054-2057`); the runner re-resolves and forbids a human start step (`pipeline-runner.ts:1826-1833`).
- **The server's step-start gate is the preflight template.** `startTaskInner` rejects a disabled harness, an unavailable harness, and `loggedIn === false` with exact user-facing copy (`orchestrator.ts:2100-2141`). `createTask` rejects `step "<name>" has no agent`, `agent for step "<name>" no longer exists`, `pipeline graph is invalid: …`, and `pipeline has no resolvable start step` (`orchestrator.ts:8498-8515`). The preflight should reuse that wording so the inline reason reads like the error the user would otherwise get after a create-then-rollback.
- **`existingBranch` + `pipelineId` is supported.** `createTask` resolves `existingBranch` before pipeline binding (`orchestrator.ts:8429-8470`); `prepareWorkdir` checks out the existing branch (`worktree.ts:1009-1073`); the runner materializes the parent worktree once and every step copies `branch`/`worktreePath` (`pipeline-runner.ts:1024-1032`, `:1346-1401`).
- **New Task is the parity target.** `pipelineId` state at `NewTaskForm.tsx:208`; stale guard at `:524-539`; start step/profile/harness at `:548-553`; `effectiveAgent` at `:568-570`; pipeline overage at `:598-608`; payload at `:647`; `rememberPicks` skip at `:659-666`; post-submit reset at `:672-673`; JSX at `:840-898`.
- **The pipeline list is already module-cached.** `usePipelines` (`src/mainview/lib/pipelines.ts:68-100`) exposes `pipelines/loading/loaded/error/refresh`; App mounts it after preferences load (`App.tsx:341`); `refreshPipelines()` is exported for create-time `taskCount` refreshes (`pipelines.ts:108-110`). `useAgentProfiles` likewise exposes `loaded` (`src/mainview/lib/agent-profiles.ts:63-101`).
- **`PipelinePicker` already satisfies the nested-dialog contract.** `data-popover-open` only while open (`PipelinePicker.tsx:143`), Escape closes before the Dialog (`:48-60`), stable test ids (`pipeline-picker`, `-trigger`, `-popover`, `-row`, `-none`, `-clear`). Its manage row (`:224-238`) currently ignores `disabled`.
- **No React component-test harness.** `bunfig.toml` scopes `bun test` to `src/`; there is no jsdom/testing-library. Pure helpers are unit-tested in `src/mainview/lib/*.test.ts`; all UI behavior is proven by Playwright.
- **Import `PipelinePicker` directly, not through the `@/components/pipelines` barrel.** The barrel pulls `StepPanel` → `AgentProfileFormDialog` → `TaskLaunchPickers`, which would close the cycle `TaskLaunchPickers → pipelines/index → StepPanel → AgentProfileFormDialog → TaskLaunchPickers`; `@/lib/pipelines` is safe (it has no component imports).
- **This worktree has no `node_modules`** (`bun 1.3.10`); `bun run typecheck` currently fails with `tsc: command not found`. Install before any verification.

### Repo rules that bear on this change

- **One-selection semantics** are already the documented picker contract: choosing a pipeline hides the harness/mode/model/effort block, clears the selected profile, and the payload never carries both ids (`docs/architecture/pipelines.md:151`, `docs/plans/pipelines.md:221-222`).
- **The issue and PR dialogs deliberately share `TaskLaunchPickers` so they cannot drift** (`docs/architecture/issue-tasks.md:5`). The new UI goes in the shared module behind an opt-in, not duplicated per dialog.
- **A launch surface must show the selected profile's own harness in `effectiveAgent`/`effectiveStatus`, never the hidden manual picker** (`docs/architecture/agent-profiles.md:42`). A pipeline extends the same rule to the start-step profile.
- **A popover inside a dialog carries `data-popover-open=""` only while open and closes on Escape** (`CLAUDE.md:110`); `PipelinePicker` already complies.
- **Update the subsystem doc in the same change** (`CLAUDE.md:5`).
- **Server-managed columns** (`pipeline_id`, `pipeline_run`, `pipeline_parent_id`, `pipeline_step_id`, …) are never patched by generic updates (`CLAUDE.md:97`); this change never touches them.
- **`src/shared/` stays free of runtime imports from either process**; the new pure helper lives under `src/mainview/lib/` because it consumes webview-side launch state, and only imports types/pure functions from `src/shared/`.

### Live facts checked

| Fact | Check | Result |
| --- | --- | --- |
| Baseline dependencies | `ls node_modules`; `bun --version` | absent; `1.3.10` — run `bun install --frozen-lockfile` first |
| A naive JSON graph passes the shared resolver | `bun -e 'import {resolveStartStep,validatePipelineGraph} from "./src/shared/pipeline.ts"; …'` (investigation §2) | `{"ok":true,"start":"Plan"}` |
| Pipeline e2e fixtures exist | `e2e/pipelines-run.spec.ts:84-147` | `makeStep`, `createProfileRest`, `createPipelineRest` (copy locally; specs do not cross-import) |
| Full-page pipelines list is testable | `src/mainview/components/pipelines/PipelinesPage.tsx:95` | `data-testid="pipelines-page"`; rows carry `data-pipeline-id` and read `Used by N task(s)` (`:176-179`) |
| Confirm provider is mounted | `src/mainview/main.tsx:10` | `ConfirmProvider` wraps the app; `useConfirm()` is available in both dialogs |
| Manage target callback exists | `App.tsx:1983-1985`, `:2485-2489` | `openPipelinesPage` routes through `navigate`; `closeGithubDialog` clears `githubOpen` + prefills |

### Runtime & trust shape

Local, single-user desktop app: one Bun main process owns SQLite + the loopback API; the webview is the only client. This is a UI-only change. Pipeline validation stays server-authoritative (`createTask`/`startPipelineRun`); the dialog preflight is advisory and may race a deletion. Issue text remains behind `ISSUE_UNTRUSTED_CONTENT_WARNING`; selecting a pipeline changes neither the prompt nor the fencing. No new role, tenancy boundary, remote input, fetch loop, config key, feature flag, or migration.

## 3. Approach & key decisions

**Chosen approach.** Extend the existing shared launch module behind a `withPipelines` opt-in (default `false`), put all runnability rules in one new pure helper, and let each dialog keep only its own draft/manage wiring.

| Decision | Alternatives rejected | Why (evidence vs. reasoning) |
| --- | --- | --- |
| `useTaskLaunch(open, { withPipelines: true })` + a pipeline section inside `TaskLaunchPickers` | (a) duplicate ~80 lines of picker/summary in each dialog; (b) a separate pipeline-only dialog | One implementation is the documented anti-drift rule (`docs/architecture/issue-tasks.md:5`); opt-in keeps the Agent form and clone dialog untouched. Evidence + owner D2. |
| A pure `resolvePipelineLaunch` in `src/mainview/lib/pipeline-launch.ts` mirrors the server's rules/messages | (a) let the submit hit the server and rely on `submitError`; (b) ad-hoc checks in each dialog | A post-create failure triggers `createAndStartTask`'s delete-rollback (`TaskLaunchPickers.tsx:700-713`); preflight is the owner's mitigation (D3). One helper is unit-testable without a React harness. Reasoning grounded in server code. |
| The start-step profile is the effective launch identity | Keep the hidden manual harness for `effective*` | Otherwise a valid pipeline is blocked by the manual harness and an invalid one is allowed by it (grill "effective launch identity"). Evidence + owner D2/D3. |
| Pipeline-only `loggedIn !== false` is enforced **inside the preflight** | Add `loggedIn` to the shared `effectiveStatus` submit gate | The shared gate would change existing single-agent/profile dialog behavior. Owner D4 chose pipeline-only. |
| Manage row uses `useConfirm` in the dialog and closes the inner dialog before the outer | Navigate from inside the picker; navigation with the Git dialog still open | Two stacked overlays would leave the full-page view under the still-open Git dialog (owner D6); `ConfirmProvider` is already mounted. Evidence. |
| Pipeline resets on every open (hook) and on context change (dialogs) | Persist the selection like the Agent profile | Owner D5; New Task clears both after submit. |
| Reuse `usePipelines`' module cache; no new fetch/poll | Fetch pipelines inside each dialog | Cache is already mounted at App boot (`App.tsx:341`); owner D9. |
| Payload keeps the hidden manual `mode/model/effort/speed/maxMode`, sends `agent: effectiveAgent` and only `pipelineId` | Reconstruct all start-step values client-side | The server overrides the cosmetic fields from the start step (`orchestrator.ts:8545-8548`, `:8700-8725`); sending `effectiveAgent` keeps the body self-consistent and matches `NewTaskForm.tsx:625`. Reasoning. |
| List-load failure disables the picker only when there is **no usable cache** (`error && !loaded && pipelines.length === 0`) | Disable on any `error` | `usePipelines` keeps a stale-but-known cache after a failed refetch (`pipelines.ts:57-67`); disabling a known list on a transient refresh failure would be a regression. Reasoning; satisfies D9's intent. |

## 4. Work breakdown — implementation tasks

| ID | Goal | Owned files | Depends on | Acceptance (scenarios) | Risk | Wired by |
| --- | --- | --- | --- | --- | --- | --- |
| **T1** | Add one pure preflight that decides whether a selected pipeline can launch, with the server's own wording. | `src/mainview/lib/pipeline-launch.ts` (new)<br>`src/mainview/lib/pipeline-launch.test.ts` (new) | — | Unit cases in §5 (T1); the function never mutates its inputs and returns the start step/profile/harness/status even when blocked. | `tests` | Imported by T2's hook. |
| **T2** | Add the opt-in pipeline state to `useTaskLaunch`; render the shared Pipeline section/summary/problem; make `createAndStartTask` refresh the pipeline list; let the manage row honor `disabled`. | `src/mainview/components/kanban/TaskLaunchPickers.tsx`<br>`src/mainview/components/pipelines/PipelinePicker.tsx` | T1 | **Given** `withPipelines` omitted, **then** `TaskLaunchPickers` renders exactly today's DOM and the hook reports `withPipelines:false`, `pipelineId:null`. **Given** `withPipelines:true`, **then** the section appears above Agent; the list uses the module cache. **When** a pipeline is picked, **then** `agentProfileId` is cleared, the Agent picker/manual block disappears, the summary shows name/steps/"starts with", and Change clears it. **When** an Agent profile is picked, **then** `pipelineId` clears. **When** the selected pipeline disappears after `pipelinesLoaded`, **then** it clears (never while not loaded). **When** the list is loading/empty/failed, **then** "Loading pipelines…"/"No pipelines yet."/"Couldn't load pipelines" render, and only the failed-no-cache state disables the picker. **When** the pipeline is unrunnable, **then** `pipelineProblem` is the reason and `pipelineReady` is false. **When** selected, **then** `effectiveAgent/effectiveKind/effectiveStatus/overageKind/overageLabel` describe the start-step profile. **When** `rememberPicks()` runs with a pipeline, **then** no preference is written. **When** `createAndStartTask` succeeds with `pipelineId`, **then** `refreshPipelines()` is fired (not awaited). **When** the picker is disabled, **then** the manage row and summary Change button are disabled too. **When** `withPipelines:true` is passed without `withProfiles`, **then** the hook still loads profiles (pipeline preflight needs them) rather than sticking at `checking`. | `state`, `tests` | T3/T4 pass `{ withPipelines: true }`; T5 supplies the manage callback. |
| **T3** | Wire `CreateTaskFromIssueDialog` to the pipeline flow: opt in, reset on open/context, pipeline-aware overage/canSubmit/payload, dirty manage confirm. | `src/mainview/components/kanban/CreateTaskFromIssueDialog.tsx` | T2 | **Given** a valid pipeline selected, **when** submitting, **then** the body sends `pipelineId`, `agent: effectiveAgent`, no `agentProfileId`, and keeps `wt.payload()`/references/taskType/issue metadata. **Given** an unrunnable pipeline, **then** Create & start is disabled and the reason renders; **when** Change clears it, **then** submit re-enables when the rest of the draft is valid. **When** the dialog opens or its issue context changes, **then** the pipeline clears. **When** Manage is clicked with no changes, **then** the dialog closes and `onManagePipelines` runs; with a changed prompt/references/type/worktree/pipeline, **then** the discard confirm must be accepted first. **When** the dialog is submitting, **then** the picker/manage row are disabled. | `state`, `tests` | T5 threads `onManagePipelines` from `IssueActions`; App mounts the tree. |
| **T4** | Same wiring for `ResolveConflictsDialog`, including a context-keyed reset for the PR identity. | `src/mainview/components/kanban/ResolveConflictsDialog.tsx` | T2 | **Given** a valid pipeline selected, **when** submitting, **then** the body sends `pipelineId`, `agent: effectiveAgent`, no `agentProfileId`, and keeps `isolation:"worktree"`/`existingBranch: headRef`/references. **Given** an unrunnable pipeline, **then** submit is disabled with the reason. **When** the dialog opens or `context.path/number/headRef` changes, **then** the pipeline clears (prompt dirty/references reset too). **When** Manage is clicked clean/dirty, **then** the same close/confirm behavior as T3. | `state`, `tests` | T5 threads `onManagePipelines` from `PullActions`. |
| **T5** | Thread the manage callback from App through the Git dialog and close both stacked dialogs before navigating. | `src/mainview/components/kanban/GitHubDialog.tsx`<br>`src/mainview/App.tsx` | T3, T4 (same wave; prop names pinned below) | **Given** `GitHubDialog` is rendered without `onOpenPipelines`, **then** the dialogs render no manage row (optional prop). **Given** `App` supplies it, **then** a manage click closes the issue/PR dialog and the Git dialog, then switches `view` to `pipelines`. **When** the pipelines view is showing, **then** no Git overlay remains. `onOpenPipelines` is a stable `useCallback`. | `none` | `App.tsx:2932` is the production mount. |
| **T8** | Update the four subsystem docs to describe the new surfaces and the opt-in. | `docs/architecture/pipelines.md`<br>`docs/architecture/issue-tasks.md`<br>`docs/architecture/agent-profiles.md`<br>`docs/architecture/clone-repository.md` | T3, T4, T5 | Docs name both dialogs, the one-selection/preflight/manage/reset behavior, and explicitly say the clone dialog remains pipeline-free. No stale claim that only New Task has a picker. | `none` | Docs are the contract (`CLAUDE.md:5`). |
| **T9** | Prove the whole change green and keep the plan's `Status` current. | `docs/plans/pipeline-picker-git-modals.md` (`Status` only) | T6, T7, T8 | Run the §5 recipe from a clean install: typecheck, `bun test`, focused e2e, guard e2e all green. Update `Status` to `tests green`. If any baseline test is red for unrelated reasons, record it in the PR body rather than claiming green. | `tests` | — |

### Pinned interfaces (so same-wave tasks cannot drift)

```ts
// src/mainview/lib/pipeline-launch.ts
export type PipelineLaunchState = "no-pipeline" | "checking" | "blocked" | "ready";

export interface PipelineLaunchResolution {
  state: PipelineLaunchState;
  /** User-facing reason when state === "blocked"; mirrors the server's messages. */
  reason: string | null;
  startStep: PipelineStep | null;
  startProfile: AgentProfile | null;
  startHarness: Harness | null;
  startStatus: AgentStatus | undefined;
}

export function resolvePipelineLaunch(input: {
  graph: PipelineGraph | null;
  profiles: AgentProfile[];
  profilesLoaded: boolean;
  harnesses: Harness[];
  agents: AgentStatus[];
}): PipelineLaunchResolution;
```

```ts
// TaskLaunch additions (useTaskLaunch + TaskLaunchPickers read these)
withPipelines: boolean;
pipelines: Pipeline[];
pipelinesLoaded: boolean;
pipelinesLoading: boolean;
pipelinesError: string | null;
pipelineId: string | null;
setPipelineId: (id: string | null) => void;
selectedPipeline: Pipeline | null;
pipelineState: PipelineLaunchState;
pipelineProblem: string | null;
pipelineReady: boolean;
pipelineStartProfile: AgentProfile | null;
overageKind: AgentKind | null;
overageLabel: string;
```

```ts
// Component props added in T2/T3/T4/T5
TaskLaunchPickers({ launch, hideProfilePicker?, onManageProfiles?, onManagePipelines?, disabled? })
CreateTaskFromIssueDialog({ open, onClose, context, onCreated?, onManagePipelines? })
ResolveConflictsDialog({ open, onClose, context, onCreated?, onManagePipelines? })
GitHubDialog({ ..., onOpenPipelines?: () => void })
```

Dialog-scoped test ids added by T2: `launch-pipeline-picker`, `launch-pipeline-summary`, `launch-pipeline-change`, `launch-pipeline-problem`, `launch-pipeline-checking`, `launch-pipelines-loading`, `launch-pipelines-error`.

### Preflight rule order (T1)

1. `graph == null` → `no-pipeline`.
2. `validatePipelineGraph(graph)` fails → `blocked` with `pipeline graph is invalid: <error>`.
3. `resolveStartStep(validated.graph)` returns `null` → `blocked` with `pipeline has no resolvable start step`.
4. Resolved start step is human → `blocked` with the validator/runner wording (defense in depth; the validator normally catches it first).
5. `!profilesLoaded` and the start profile cannot already be resolved from the warm cache → `checking`.
6. Any non-human step with `!agentProfileId` → `blocked` with `step "<name>" has no agent`.
7. Any non-human step whose `agentProfileId` is absent from `profiles` → `blocked` with `agent for step "<name>" no longer exists`.
8. Start profile's harness missing or `!harness.enabled` → `blocked` with `<label/name> is disabled — re-enable it in Settings to start new runs.` (missing harness uses the profile's raw harness id as the label).
9. `startStatus` missing or `!startStatus.available` → `blocked` with `<label> is not available — <reason>[. Install with: <hint>]`.
10. `startStatus.loggedIn === false` → `blocked` with `<label> isn't logged in — <authHelp ?? "run its login command">`.
11. Otherwise `ready`.

`profilesLoaded === false` must never produce a "profile deleted" reason; it produces `checking` until the first successful profile fetch.

## 5. Work breakdown — test tasks

| ID | Layer | Covers | Owned files | Acceptance |
| --- | --- | --- | --- | --- |
| **T1** | Unit | `resolvePipelineLaunch` | `src/mainview/lib/pipeline-launch.test.ts` | Given a valid one-step graph + loaded profile + available harness → `ready`, correct `startStep/startProfile/startHarness/startStatus`. Invalid graph (duplicate step name / dangling `startStepId`) → `blocked` with the validator message. Two root steps + `startStepId:null` → `blocked`, no resolvable start. Human start (graph validator message) → `blocked`. A later non-human step with `agentProfileId:null` → `blocked` naming it. A later step pointing at a missing profile with `profilesLoaded:true` → `blocked`. Same input with `profilesLoaded:false` → `checking` (no false "deleted"). Missing/deleted start profile → `blocked`. Start harness missing / disabled → `blocked`. `available:false` → `blocked` with `reason`. `loggedIn:false` (available true) → `blocked` with `authHelp`. `loggedIn:null` → `ready`. Inputs are not mutated (deep-equal before/after). Each assertion is observed red against a deliberately broken copy of the rule (e.g. skip the human/profile/harness check), then the helper is restored. |
| **T6** | e2e | Criteria 1, 3, 4, 5, 6 in the issue dialog; T2/T3/T5 | `e2e/issue-task.spec.ts` | New tests, each creating its profile/pipeline over REST **before** `gotoApp` (the `usePipelines`/`useAgentProfiles` module caches are populated at boot/open). Extend the spec's local `findTaskByTitle` return type with `pipelineId`, `agentProfileId` and `pipelineRun`. (a) pick a pipeline → summary + Agent/manual block hidden; Change restores; picking a profile then a pipeline clears the profile card; submit creates a parent with `pipelineId`, `agentProfileId` null, `pipelineRun` non-null, issue metadata intact; after create, close the Git dialog, click the header Pipelines button, and assert the pipeline row shows "Used by 1 task" (proves `refreshPipelines`). (b) a one-step pipeline with `agentProfileId:null` blocks submit with `launch-pipeline-problem`; Change re-enables. (c) a pipeline whose start profile uses a deliberately unavailable custom harness (helper copied from `agent-profiles-dialogs.spec.ts:264-280`) blocks with that harness's reason; Change restores the manual launch and re-enables submit — proves the effective identity is the start profile. (d) Manage from a clean draft closes the issue dialog + Git dialog and shows `pipelines-page`; with a typed prompt it shows the discard confirm, Cancel keeps the dialog, confirm navigates. Locators are scoped to the issue dialog (`issueTaskDialog.getByTestId(...)`), never `page`. Best-effort-delete the fixture pipeline/profile in `afterAll`. |
| **T7** | e2e | Criteria 2, 3, 4, 5, 6 in the PR dialog; T2/T4/T5 | `e2e/resolve-conflicts.spec.ts` | Same three flows as T6 copied into this spec (its own `makeStep`/`createProfileRest`/`createPipelineRest`, per the repo's no-cross-spec-import convention), extending its local `TaskRow` with `pipelineId`, `agentProfileId` and `pipelineRun`. The create-and-start case asserts the parent is `isolation:"worktree"`, `branch === HEAD_BRANCH`, `branchSource === "existing"`, `pipelineId` set, `agentProfileId` null. The manage case asserts both dialogs close and `pipelines-page` appears; dirty confirm behaves as in T6. Delete the parent (cascades steps) at test end. |

**E2e applicability: applies.** Both changes are user-visible flows in dialogs (UI → loopback API → SQLite → runner). The app runs locally and the repo already has the Playwright harness + fake driver.

**Run recipe** (from the repo root, after `bun install --frozen-lockfile`):

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
# Ensure nothing else holds :5173 (playwright.config.ts reuses it silently),
# or set AGETOR_E2E_VITE_PORT.
bun node_modules/@playwright/test/cli.js test e2e/issue-task.spec.ts e2e/resolve-conflicts.spec.ts
# Guard suites for the shared modules:
bun node_modules/@playwright/test/cli.js test \
  e2e/agent-profiles.spec.ts e2e/agent-profiles-dialogs.spec.ts \
  e2e/clone-project.spec.ts e2e/clone-providers.spec.ts \
  e2e/pipelines-run.spec.ts
```

Each Playwright worker gets its own headless backend/token/data dir and GitHub stub (`e2e/fixtures.ts`); the fake Claude driver is enabled by the fixture (`AGETOR_CLAUDE_DRIVER=fake`). No credentials or seed data beyond the specs' own REST fixtures. Every new e2e must be shown failing before the corresponding UI exists (or with the picker hidden) so it can actually fail.

## 6. Execution waves

**Wave 0 (environment, not a task):** `bun install --frozen-lockfile`. Commit nothing from it (`node_modules` is ignored; `--frozen-lockfile` must not change `bun.lock`).

| Wave | Tasks (parallel) | Barrier |
| --- | --- | --- |
| 1 | **T1** | `bun run typecheck` + `bun test src/mainview/lib/pipeline-launch.test.ts` green; checkpoint commit. |
| 2 | **T2** | `bun run typecheck` + `bun test` green (T1's tests included); no e2e yet — the UI is inert until a dialog opts in. Checkpoint commit. |
| 3 | **T3, T4, T5** (disjoint files; T5 depends on the pinned prop names, not on ordering) | `bun run typecheck` + `bun test` green; both dialogs compile with the optional callback. Checkpoint commit. |
| 4 | **T6, T7, T8** | Focused Playwright specs green; docs reviewed against the code. Checkpoint commit. |
| 5 | **T9** | Clean-install typecheck + `bun test` + focused + guard e2e green; `Status` updated. Final checkpoint. |

**Delivery slice:** one PR. Estimated ~900–1,300 changed lines (source ~350, unit tests ~250, e2e ~400, docs ~30) — reviewable as a single diff; no cross-repo dependency, no migration, no flag.

## 7. Invariants, runtime shape & risks

### Invariants and their single enforcement point

| Invariant | Enforced at | Every path routes through it |
| --- | --- | --- |
| A task is launched from **at most one** of {agent profile, pipeline}. | `useTaskLaunch`'s wrapped `setAgentProfileId`/`setPipelineId` (each non-null pick clears the other). | Picker onChange, Change button, stale guard, per-open/context reset. NewTaskForm keeps its own existing inline rule. |
| A selected pipeline must be **launch-ready** before submit. | `resolvePipelineLaunch` (one rule order) → `pipelineReady` → both dialogs' `canSubmit`. | Any future dialog that opts into `withPipelines` gets the same gate. |
| Pipeline launches, and only pipeline launches, require the start harness to be enabled/available and `loggedIn !== false`. | Preflight steps 8–10. | The shared `effectiveStatus`-only gate is left unchanged for manual/profile launches. |
| While a pipeline is selected, the launch identity and overage kind come from its **start-step profile**. | `useTaskLaunch`'s `effectiveAgent/effectiveKind/effectiveStatus/overageKind/overageLabel`. | Composer `agent` prop, overage warning, auth hint, canSubmit. |
| The create payload never carries `pipelineId` + `agentProfileId`. | Mutual-exclusion setters + conditional spreads in both submits; the server also rejects both. | Both dialogs; e2e asserts the created row. |
| Opening a dialog (or changing its issue/PR context) starts with no pipeline selected. | `useTaskLaunch`'s open effect + each dialog's context reset effect. | Both dialogs. |
| Manage closes the inner dialog, then the Git dialog, before navigating. | Dialog handler calls `onClose()` then `onManagePipelines`; `App.openPipelinesFromGit` calls `closeGithubDialog()` then `openPipelinesPage()`. | Both manage rows. |
| Non-Git consumers never see pipeline UI. | `withPipelines` default `false`; manage callback optional. | Agent Settings form, `CloneProjectDialog`. |

### Runtime shape

One Bun process + one webview; no multi-instance or rolling-deploy concerns. No new request: the picker reads the module-cached `GET /pipelines` already mounted at App boot, and the preflight is in-memory. A crash between create and start is the existing `createAndStartTask` rollback (parent deleted, steps cascade); preflight narrows it but does not make it transactional. Dependency outage: if `/pipelines` fails, the section shows the error and allows a normal single-agent launch; if harness/profile fetches fail, the dialog's existing load-error state wins. Kill switch: none needed — UI-only, server already accepts `pipelineId`. Rollback: revert the commit; no data to unwind.

### Blast radius

- `TaskLaunchPickers`/`useTaskLaunch`: four consumers; two unchanged by default (`CloneProjectDialog`, `AgentProfileFormDialog`). Guard suites in §5.
- `PipelinePicker`: shared with `NewTaskForm`; only the manage row gains a `disabled` attribute (undefined there → unchanged).
- `GitHubDialog`: a new optional prop threaded through `GitHubItemDetail` → `IssueActions`/`PullActions` → the two dialogs; no other mount exists.
- `App`: one new `useCallback` + one prop.
- No server, DB, route, shared type, CLI, bundle, or generated-code change.
- Known existing behaviors left intact: `createAndStartTask` delete-on-start-failure; `existingBranch` branch-collision error (surfaces inline); step tasks inherit references but not `issueUrl`.

### Cross-repo dependencies

None.

## 8. Open questions / assumptions

**No unratified one-way doors.** No schema/auth/money/public-contract change; the only payload field (`pipelineId`) is already accepted and validated by the server.

Plan-level assumptions (all from the grill or code evidence; none blocks execution):

1. `usePipelines` is normally warm when a Git dialog opens (`App.tsx:341`). If a dialog is the first consumer, the section shows "Loading pipelines…" and the stale guard does not clear a selection until `pipelinesLoaded` is true.
2. `useAgentProfiles.loaded` becomes available to the hook; until the first successful fetch the preflight reports `checking`, never "profile deleted".
3. Manage lands on the full-page Pipelines list (`App.openPipelinesPage`), not Settings → Pipelines (owner D6/assumption).
4. "Dirty" for the manage confirm is exactly: prompt edited, references attached, issue task type edited, any worktree option changed from its open-seed, or a pipeline selected. The worktree comparison is cheap because `resetForOpen()` restores `isolate:true`, `baseRef:""`, `branchDirty:false`; no narrower definition is needed.
5. Clearing a pipeline does **not** restore the Agent profile it cleared (New Task parity).
6. The summary's "starts with" line is omitted when the start profile is unresolved; the inline reason carries the explanation.
7. Only the **start-step** harness is preflighted; later steps' harnesses surface as run blocks, as they do for a New Task pipeline today. `createTask` still validates every non-human step's *profile*.
8. Payload keeps the hidden manual `mode/model/effort/speed/maxMode`; the server overrides them from the start step. `agent` is `effectiveAgent`.
9. e2e fixtures (profiles/pipelines) must be created **before** `gotoApp` because both lists are module-cached; a mid-session create would not appear without a refresh.
10. E2E runs on a free `:5173` (or `AGETOR_E2E_VITE_PORT`); `reuseExistingServer` would silently use another checkout's Vite.
11. No feature flag; a user with zero pipelines sees the always-visible section with "No pipeline"/"No pipelines yet." (owner D9).

## 9. Completeness ledger

| Item | Disposition | Task ID / reason / who deferred |
| --- | --- | --- |
| Preflight for invalid graph / no start / human start / missing-or-deleted profile / disabled-unavailable-logged-out start harness | in this run | T1 (rules), T2 (surface), T6/T7 (e2e) |
| Pipeline-only `loggedIn !== false` gate | in this run | T1, T2 |
| `withPipelines` opt-in (default false), `pipelineId`, selected pipeline, start profile, effective identity, stale guard, per-open reset, `rememberPicks` skip | in this run | T2 |
| `profilesLoaded`/`pipelinesLoaded`/`pipelinesLoading`/`pipelinesError` surfaced through the hook | in this run | T2 |
| Pipeline section above Agent, summary card, Change, disabled reason, loading/empty/list-error states, busy disable, dialog-scoped test ids | in this run | T2 |
| `createAndStartTask` → `refreshPipelines()` after a successful pipeline create | in this run | T2; asserted by T6 |
| Issue dialog: opt-in, reset on open/context, overage/canSubmit/payload, manage confirm | in this run | T3 |
| PR dialog: same, on the PR head branch, context-keyed reset | in this run | T4 |
| Manage callback threading `App → GitHubDialog → GitHubItemDetail → IssueActions/PullActions → dialog → TaskLaunchPickers → PipelinePicker`; close both stacked dialogs before navigating | in this run | T5 |
| e2e coverage in both dialogs (mutual exclusion, summary, payload, unrunnable block, create-and-start, effective-identity/unavailable-harness case, manage clean/dirty) | in this run | T6, T7 |
| Typecheck, `bun test`, focused + guard Playwright suites | in this run | T9 |
| Docs: `pipelines.md`, `issue-tasks.md`, `agent-profiles.md`, `clone-repository.md` | in this run | T8 |
| `CloneProjectDialog` pipeline support (`POST /projects/clone` whitelist, pre-clone validation, `isolation:"none"` semantics) | out of scope | owner D1 — separate ticket; requires server work |
| `POST /projects/clone` `pipelineId` field | out of scope | owner D1 |
| `AgentProfileFormDialog` pipeline picker | out of scope | profile editor, not a task-launch surface; `hideProfilePicker` must stay pipeline-free |
| `RunPanel` "Resolve Conflicts" pipeline picker | out of scope | sends a message to an existing task, not a new task |
| `GitHubDialog` New PR / New issue composers | out of scope | no task creation |
| CLI `agetor add --issue --pipeline` | no change | already supported (`src/cli/commands/add.ts:458-490`, `:255-271`, `:569-602`) |
| `issueUrl`/`issueSnapshot` on **step** tasks | out of scope | existing runner sets `issueUrl:null` on steps (`pipeline-runner.ts:1380`); parent retains the link — separate server change |
| Auto-open the pipeline run view after create | out of scope | owner D7 chose stay-put + existing chip |
| "Last used pipeline" preference / persistence | out of scope | owner D5 chose reset each open |
| Picker filtering by runnable state / archived-hidden pipelines / runnable badges | out of scope | owner D3 chose list-all + inline reason; no archived concept |
| "Manage agents…" row in these dialogs | out of scope | not requested; Agent picker stays exactly as today |
| Feature flag / rollout | none | local single-user UI; server contract unchanged |
| Data migration / backfill | none | `pipeline_id`/`pipeline_run` already exist |
| React component/unit test harness for `TaskLaunchPickers` | out of scope | repo convention is Playwright (`bunfig.toml`; no jsdom) |
| README user-facing mention | out of scope (optional) | not required by `CLAUDE.md`; the live contract is the architecture docs |
| `docs/plans/pipelines.md` historical design record | out of scope | historical plan; do not rewrite |
| Pipeline task title changes ("[pipeline name] …") | out of scope | keep the existing issue/PR titles; the board badge identifies pipelines |
| Multi-step PR warning / pipeline restriction on the conflict modal | out of scope | owner D8 chose allow-all, no warning |
| Whole-graph harness preflight (later steps) | out of scope | grill assumption: only the start-step harness is preflighted |
| Rollback behavior on start failure | unchanged | keep `createAndStartTask`'s delete-rollback; preflight is best-effort |
| Branch-collision error on the PR head branch | unchanged | existing `createTask` guard surfaces inline |
| `TaskLaunch` structural consumers (`agent-profile-form.ts`'s `trackLaunchInteractions`, `AgentProfileFormDialog`) | no change expected | verify with `bun run typecheck` (T9) |

## 10. Execution notes — plan changes the owner hasn't ratified

1. **`WorktreeOptions`/`BranchPicker` gained explicit base-ref dirty tracking** (`baseRefDirty` + an optional `onAutoSelect` prop). Reason: §8 assumption 4 claimed `resetForOpen()` restores `baseRef: ""`, so a non-empty ref meant "user changed it" — but `BranchPicker` auto-selects the repo's current branch as soon as the branch list loads, which made every freshly opened issue dialog read dirty and always ask before "Manage pipelines…". The new flag marks only a user pick (and `resetForOpen`/`resetAfterSubmit` clear it), keeping the planned dirty definition accurate. Both changes are additive and default-inert for `NewTaskForm` (same values, no behavior change).
2. **`e2e` helpers tolerate `GitHubDialog`'s surviving detail view.** Reason: the dialog deliberately keeps its last detail view across a close/reopen, which the manage-row tests hit after navigating to Pipelines and back; the helpers wait for either the list-view Project combobox or the detail's launch button instead of assuming a fresh list. Test-only.

