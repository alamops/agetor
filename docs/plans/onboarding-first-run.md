# Plan — First-run onboarding (welcome + live Getting Started checklist)

| Field | Value |
| --- | --- |
| Date | 2026-08-12 |
| Source | /implement request + GitHub issue "New users don't know what to do first" |
| Config | AGENTS_CONFIG.yml (balanced) |
| Branch | feature/onboarding-process |
| Base SHA | 2a4f1a1f3eb8a88aae8bd9581592a5c109d87a85 (tree clean apart from this plan) |

## 1. Objective & success criteria

A brand-new agetor user (fresh data dir, zero tasks) opens the app and immediately understands what agetor is and what to do first. Concretely:

- A **welcome dialog** appears once on first run, explaining the workflow in a few sentences (task = prompt + project + harness; cards move Backlog → Ready → Running → Review/Done).
- A **"Getting started" checklist card** fills the empty board area with 4 live steps, each auto-checked from real state and offering a one-click action:
  1. **Harness ready** — done when ≥1 enabled harness probe reports `available`. Otherwise shows per-harness status (installed/missing/disabled) with install hints, login guidance ("Open in Terminal" + the exact login command), and a deep link to Settings → Harnesses.
  2. **Add a project** — done when ≥1 registered project exists.
  3. **Create your first task** — done when ≥1 task exists. Action expands/focuses the New Task panel.
  4. **Run it** — done when any task has ever left backlog/ready (column ∈ running/review/done/blocked).
- Dismissable ("I know my way around"), auto-completes when all steps are done, **never shows for existing users** (data with completed steps ⇒ silently marked dismissed).
- Replayable from Settings → General ("Show getting started guide").
- A short **workflow explainer** (InfoTip) near the New Task panel header addresses the issue's "12 unexplained fields" complaint.
- While onboarding is visible, empty kanban columns show a one-line muted hint of what each column means.

Success = e2e spec proves: fresh backend shows welcome + checklist; steps check off as harness/project/task/run land; dismissal persists across reload; replay works. `bun run typecheck`, `bun test`, `bunx playwright test` all green.

## 2. Context & constraints (Phase 1 findings)

- **No empty state exists**: `Column.tsx:35-70` renders a bare list; `App.tsx:780-784` shows "0 tasks". Onboarding is greenfield — no prior attempt in git history or docs/plans.
- **Board layout**: `App.tsx:814-902` — `NewTaskForm` sidebar + `<main>` with columns. Tasks polled 2s (`App.tsx:240-300`), harness statuses (`api.listHarnesses()` → `HarnessStatus[]`) polled 15s (`App.tsx:250-256, 301`).
- **Harness probe is install-only**: `agent-status.ts:72-121` returns `{ available, path, version, reason, installHint }` per harness row; login state is NOT detectable (decision: guidance only, no new probes). `INSTALL_HINTS` per kind at `agent-status.ts:10-15`. Manual login flow exists: `api.openHarnessTerminal(id)` → POST `/harnesses/:id/open-terminal` (native; 501 headless), with per-kind login copy precedent in `HARNESS_HOME_COPY` (`SettingsDialog.tsx:135-156`).
- **Projects**: GET `/projects` (`server.ts:546-`), consumed by `ProjectPicker`. Registered-projects count is the step-2 signal.
- **Preferences KV**: `preferences` table (migration 011), GET `/preferences` + PUT `/preferences/:key` (string values). Keys like `theme`, `fontSize`, `defaultHarness`. **No migration needed** for the new key. Reads are always best-effort (`.catch` keep-defaults idiom).
- **Settings dialog**: sidebar sections from `settings-dialog-view.ts:4-9` (`general|harnesses|git|prompts`); no deep-link prop today — `open` effect resets to General (`SettingsDialog.tsx:257-264`). App holds only `settingsOpen: boolean` (`App.tsx:163`).
- **Reusable primitives**: `Dialog`, `Card`, `Button`, `Badge`, `InfoTip` (`components/ui/`), `panel-collapse.ts` localStorage util (`NEW_TASK_PANEL_COLLAPSED_KEY`), `TmuxMissingBanner`/`TmuxInstallDialog` guided-fix precedents, `GitHubSetupDialog` numbered `GuideStep[]` pattern.
- **Theming rule**: semantic tokens only (`text-success`, `bg-info/10`, …); any new token must land in `index.css` **and** `tailwind.config.js` together (no new tokens planned — reuse existing).
- **Churn warning**: `NewTaskForm.tsx` and `SettingsDialog.tsx` change weekly — no pixel/label anchors; use props/`data-*` markers.
- **Delivery conventions**: pure logic in `src/mainview/lib/*.ts` with colocated bun unit tests (no DOM test harness exists); e2e via per-worker backend fixtures (`e2e/fixtures.ts`, fake claude driver `AGETOR_CLAUDE_DRIVER=fake`, seed via authed POSTs); run with `bunx playwright test` (no package.json script); squash PR titled `feature: … (#NNN)`.
- **Codex + Cursor ship disabled by default** (migrations 016/024) — deliberate; onboarding must not auto-enable (decision: show "disabled — enable in Settings" + deep link).

## 3. Approach & key decisions

- **Shape** (owner decision): welcome dialog + live checklist card; no blocking wizard, no spotlight tour (churn risk).
- **Login** (owner decision): guidance only — surface install status, exact login command per kind, "Open in Terminal". No auth-state probing.
- **Disabled harnesses** (owner decision): visible with deep link to Settings → Harnesses; never auto-enabled.
- **Multi-account** (owner decision): one sentence pointing at Settings → Harnesses → Add; no dedicated step.
- **Persistence**: server preference key **`onboardingDismissed`** (`"true"`/`"false"`; absent = never dismissed). Server-side, cross-session, no migration. Not paint-blocking, so the async preferences path is fine (unlike theme/collapse). Replay = write `"false"`.
- **Existing users**: on first evaluation after data loads, if the pref is unset and all steps already derive as done, silently write `"true"` — upgrading users never see onboarding. Welcome *dialog* additionally requires `tasks.length === 0`.
- **All logic is pure and unit-tested** in `src/mainview/lib/onboarding.ts`; components stay thin (no DOM test harness exists).
- **No server changes at all** — the entire feature is webview-side + one new preference key.

## 4. Work breakdown — implementation tasks

Shared contracts (pinned so parallel tasks can't drift):

- `src/mainview/lib/onboarding.ts` exports:
  - `type OnboardingStepId = "harness" | "project" | "task" | "run"`
  - `type OnboardingStep = { id: OnboardingStepId; done: boolean }`
  - `deriveOnboardingSteps(input: { statuses: HarnessStatus[]; enabledHarnessIds: Set<string> | null; projectCount: number; tasks: Pick<Task, "column">[] }): OnboardingStep[]`
  - `type OnboardingVisibility = { showWelcome: boolean; showChecklist: boolean; autoDismiss: boolean }`
  - `resolveOnboardingVisibility(input: { dismissedPref: string | undefined; loaded: boolean; steps: OnboardingStep[]; taskCount: number; welcomeAcknowledged: boolean }): OnboardingVisibility`
  - `ONBOARDING_DISMISSED_PREF = "onboardingDismissed"`
- `SettingsDialog` gains prop `initialSection?: SettingsSectionId` (applied in the existing `open` effect; default unchanged).
- `NewTaskForm` gains prop `focusNonce?: number` — when it increments: expand the panel (reuse `writeCollapsed`), focus the Title input, brief highlight.
- `App.tsx` replaces `settingsOpen: boolean` with `settingsOpen` + `settingsInitialSection` (or a single `SettingsSectionId | null` state) and passes both new props down.

### Wave 1 (parallel, disjoint)

- **T1 — onboarding logic lib**
  Files: `src/mainview/lib/onboarding.ts` (new), `src/mainview/lib/onboarding.test.ts` (new).
  Implements the contracts above. Step rules: harness done ⇔ some status is `available` AND (enabledHarnessIds is null OR contains its harnessId); project done ⇔ `projectCount > 0`; task done ⇔ `tasks.length > 0`; run done ⇔ some task column ∈ {running, review, done, blocked}. Visibility rules per §3 (incl. `autoDismiss` when pref unset + all done + loaded). Unit tests cover every rule + existing-user auto-dismiss + replay (`"false"` after `"true"`).
  Acceptance: `bun test src/mainview/lib/onboarding.test.ts` green; no imports from components.

- **T2 — Settings deep-link + replay button**
  Files: `src/mainview/components/settings/SettingsDialog.tsx`, `src/mainview/lib/settings-dialog-view.ts` (only if a helper is genuinely needed).
  Adds `initialSection?: SettingsSectionId` prop honored when the dialog opens; adds a "Getting started" row in **General** with a "Show getting started guide" button that writes `onboardingDismissed="false"` via `api.setPreference` and closes the dialog. Must respect the PR #150 overflow contract.
  Acceptance: typecheck green; opening with `initialSection="harnesses"` lands on Harnesses; button writes the pref.

### Wave 2 (parallel, disjoint; depends on Wave 1)

- **T3 — onboarding components + App wiring + column hints**
  Files: `src/mainview/components/onboarding/WelcomeDialog.tsx` (new), `src/mainview/components/onboarding/OnboardingChecklist.tsx` (new), `src/mainview/App.tsx`, `src/mainview/components/kanban/Column.tsx`.
  - `WelcomeDialog`: Dialog-based, copy seeded from README "Getting started" + the issue's suggested copy; "Get started" (ack → checklist) and "Skip — I know my way around" (writes dismissed pref).
  - `OnboardingChecklist`: full-size centered card when `tasks.length === 0`, compact strip above the board otherwise. Step rows with done/pending icons (semantic tokens only). Harness step detail: per-harness dot + version, install hint for missing, "disabled — Enable in Settings" deep link, login guidance block (per-kind login command + "Open in Terminal" via `api.openHarnessTerminal`, error-toasted if 501), one-line multi-account pointer. Project step: point at New Task panel's Project picker (fires `focusNonce`). Task step: fires `focusNonce`. Run step: informational copy. Dismiss link writes pref. `data-testid` markers for e2e (`onboarding-welcome`, `onboarding-checklist`, `onboarding-step-<id>`).
  - `App.tsx`: derive steps/visibility from existing polled state (`tasks`, `agents`, projects list — add a lightweight projects fetch if none exists in App), fetch prefs once (already done for fontSize), implement `autoDismiss` write-once effect, render dialog + card, thread `settingsInitialSection` and `focusNonce`.
  - `Column.tsx`: optional `emptyHint?: string` shown muted when the column has no tasks — passed by App only while checklist is visible. Hints: Backlog "Ideas you haven't queued yet" / Ready "Waiting for you to press Run" / Running "Agents working right now" / Blocked "Needs your attention".
  Acceptance: typecheck green; zero-state renders welcome + card; no render when pref `"true"`.

- **T4 — New Task panel affordances**
  Files: `src/mainview/components/kanban/NewTaskForm.tsx`.
  - `focusNonce?: number` prop: on increment, expand (reuse existing collapse state + `writeCollapsed`), focus Title, transient ring highlight (~1.5s, semantic token).
  - Workflow InfoTip beside the "New task" header: 3–4 sentences on how the fields fit together (Type/Title/Prompt = what to do; Project/Branch/Isolate = where; Harness/Mode/Model/Effort = which agent and how). Reuses `InfoTip`.
  Acceptance: typecheck green; no change to submit behavior or field defaults.

## 5. Work breakdown — test tasks

- **TT1 — unit tests** land with T1 (colocated, per repo convention). Any gaps found later: extend `onboarding.test.ts`.
- **TT2 — e2e spec** `e2e/onboarding.spec.ts` (new file; may touch `e2e/helpers.ts` only to add small shared helpers):
  1. Fresh backend → welcome dialog + checklist visible; harness step already done (fake driver reports available).
  2. Skip → nothing shown after reload (pref persisted server-side).
  3. Fresh backend: register project via authed POST `/projects` → step 2 checks off; create task (POST `/tasks`, isolation "none") → step 3; start it (fake driver) → step 4 after settle; checklist auto-completes/disappears; pref now `"true"`.
  4. Replay: Settings → General → "Show getting started guide" → checklist visible again.
  5. Existing-user guard: seed a done-state backend (project + task run) before first page load → onboarding never appears, pref auto-set.
  **e2e applies** (user-visible flow, harness exists). Run recipe: shared Vite via Playwright `webServer`, per-worker headless backend fixture (`e2e/fixtures.ts`) with fake driver env; command `bunx playwright test e2e/onboarding.spec.ts`.

## 6. Execution waves

- Wave 1: T1 ∥ T2 → checkpoint (typecheck + bun test + commit).
- Wave 2: T3 ∥ T4 → checkpoint (typecheck + bun test + commit). (T3/T4 are file-disjoint; the `focusNonce` contract is pinned in §4 so both sides compile after the wave completes.)
- Phase 5 review → Phase 6: TT2 (single agent) → Phase 7 full run (bun test + typecheck + playwright) → Phase 8 fixes if needed.

## 7. Blast radius & risks

- `App.tsx` is the app shell — wiring errors break everything; mitigated by typecheck + e2e boot assertions in existing specs (`theme.spec.ts` exercises boot).
- `Column.tsx` renders every column — the hint must not disturb drag-and-drop (dnd-kit) drop zones; hint goes inside the existing empty list container, non-interactive.
- `NewTaskForm` focus effect must not steal focus outside onboarding actions (only fires on nonce increment, never on mount).
- Settings `initialSection` must not regress the existing reset-to-General behavior when opened normally.
- `openHarnessTerminal` is 501 under headless — checklist must degrade (toast, guidance text still useful). e2e must not click it.
- Existing e2e specs assume no unexpected overlays: welcome dialog appears on fresh backends, which every worker gets. **TT2/T3 must ensure existing specs keep passing** — simplest: existing helpers' `gotoApp` flows through a backend that has no tasks, so the welcome dialog WILL appear and could block clicks in theme/font-size/quote specs. Mitigation (pinned): `e2e/fixtures.ts` or `helpers.ts` seeds `onboardingDismissed="true"` via `putPreference` in `gotoApp` by default, with an opt-out used only by `onboarding.spec.ts`. This is a required part of TT2 (and must be validated in Phase 7 by running the whole suite).
- No server/DB changes; rollback = revert the squash commit.

## 8. Open questions / assumptions

- Copy is drafted by the implementer seeded from README + the GitHub issue; owner may reword at review.
- Assumes `HarnessStatus` rows for disabled harnesses are distinguishable client-side (join with the Settings harness listing if the status payload lacks `enabled`); T3 resolves against actual API shape.
- The GitHub issue's suggested empty-state copy is folded into the checklist card rather than a separate bare "No tasks yet" block.
