# Plan — Issue/PR modals: worktree + composer parity with the New Task panel (and drop the paste-URL row)

| Field | Value |
| --- | --- |
| Date | 2026-08-27 |
| Source | `/implement` conversation — "remove the from-issue-url field on the new task panel; make sure the create-from-Issue/PR modals can toggle Isolate and pick Branch-from, like the left panel; include the MCP/skill/plugin picker and `/` autocomplete" |
| Config | AGENTS_CONFIG.yml (balanced, v1 schema; host `claude_code`) |
| Flags | none |
| Gates | grilled + approved by owner (Phase 2 answers recorded in §8) |
| Branch | `fix/remove-from-issue-field-of-new-task` |
| Base SHA | `7c85f87295ed21501aadbcc87ff1b2184096f04f` (tree clean at start) |

## 1. Objective & success criteria

1. The New Task left panel no longer has the "From issue" paste-URL row. Nothing else about the panel changes (issue tasks are still created from the issue detail page's "Work on this with Agetor" and from `agetor add --issue`).
2. `CreateTaskFromIssueDialog` ("Work on this with Agetor") gains, with identical look and semantics to the left panel: the **Branch** (base ref) picker, the **Isolate (worktree)** toggle, and the **Branch name** field (live-resolved from the project's naming pattern, ⚙ opens `BranchNamingDialog`, Reset-to-pattern, validation). Submitting sends `isolation`/`baseRef`/`branch` exactly as the panel does.
3. `ResolveConflictsDialog` ("Resolve with Agetor") shows the same row **locked**: Isolate checked + disabled with an explanation, and the branch shown read-only as the PR head. No server change (the server rejects `existingBranch` without a worktree and ignores `baseRef` on that path — `orchestrator.ts:3477-3505`).
4. Both modals get the panel's prompt composer: `/` autocomplete (commands/skills/saved prompts), the "MCP · Skills · Plugins · Prompts" picker, the Files/Folders references picker, and paste-a-file-attaches-it. Picked references land on the task's `references` (server already merges them with the issue-snapshot ref — `orchestrator.ts:3665-3685`).
5. The composer and the worktree row become **shared components** used by the panel and both modals so the three can't drift (same rationale as `TaskLaunchPickers`).
6. Pressing Escape on an open popover inside a modal closes the popover, not the modal.
7. `bun run typecheck` and `bun test` green; e2e green for `e2e/issue-task.spec.ts` (rewritten) and a new `e2e/resolve-conflicts.spec.ts`.

## 2. Context & constraints (grounded findings)

**Paste-URL row (`src/mainview/components/kanban/NewTaskForm.tsx`)** — added in `7c85f87` (#199). Surface: state `:194-207` (`issueUrlDraft/issueBusy/issueError/issueLink/issueWarning`), refs + StrictMode mount flag `:241-252`, project-switch effect `:287-295`, `loadIssueFromUrl` `:585-632`, JSX `:865-928` (`issue-url-input`, `issue-url-load`, `issue-link-chip`, `issue-comments-warning`), submit fields `:658-659`, post-submit reset `:678-681`, `Props.onSubmit` fields `:109-114`. `withoutSnapshotParagraph` (`src/shared/issue-task.ts:272-323`, tests `issue-task.test.ts:710-777`) has no other caller → dead. Every other `issue-task.ts` export keeps callers (dialog, CLI, RunPanel, App, orchestrator). `promptOverage`/`promptByteOverage` in the form is a general Gemini argv-cap guard — **keep**. e2e: `e2e/issue-task.spec.ts:399-460` (two form-path tests) + `newTaskAside` `:182` + `selectProjectInForm` `:243` are the only users. Docs: `CLAUDE.md:38` names "the New Task form's paste-URL row" as one of three entry points and the `NewTaskForm` `commentsError` line.

**Left-panel worktree controls (`NewTaskForm.tsx`)** — state `:253-268` (`isolate` default `true`, `baseRef`, `branchConfig/branchOverride/branchDirty/branchToken/branchSettingsOpen`), config fetch `:275-284` (`api.getProjectBranchConfig`), derivations `:300-345` (`computedPattern` = `branchPattern(config, taskType)`, `projectName` = last path segment, `branchField` = `branchFieldState(...)` from `src/mainview/lib/branch-field.ts`, `branchValidation` = `validateBranchName(resolved)`), submit `:642-648` (`isolation`, `baseRef` only when isolate, `branch` = `branchField.submitValue` only when isolate), `canSubmit` `:578` (`!isolate || branchValidation.ok`), post-submit reset `:684-686` (`branchDirty=false`, fresh `branchToken`), JSX `:1016-1088` (BranchPicker "Branch" with isolate-dependent `title`; checkbox row with `GitBranch` icon and `isolateTitle` `:690-692`; `{isolate && …}` name field with ⚙ `SlidersHorizontal`, validation line, `→ resolved` preview, Reset), `BranchNamingDialog` `:1333-1339`. `ProjectPicker.onChange` resets `baseRef` `:1004-1008`. `BranchPicker.tsx` is already generic (`workdir/value/onChange/label/title/placement/disabled`; owns `listBranches`, Fetch/Pull, auto-select current branch).

**Left-panel composer (`NewTaskForm.tsx`)** — state `:378-391` (`references`, `agentCommands`, `agentExtensions`, `savedPrompts` + `loadSavedPrompts`, `promptRef`), capabilities effect `:393-413` (`api.listAgentCapabilities({agent, workdir, branch: baseRef})`, keyed `[agent, workdir, baseRef]`, harness **id** not kind), paste/drop capture `:713-760` (`applyCaptured` inserts `[basename]` markers at the caret via `readCaret/spliceAtSelection/restoreCaret` and `mergeRefs` into references; `reportCapture` → `dropHint`; `onPromptPaste` intercepts file pastes only; aside-wide `onAsideDrop` reuses both), JSX `:940-996` (label row + `ExtensionPicker align=right placement=below disabled={!workdir}`; `relative` wrapper with `Textarea onFocus={loadSavedPrompts}` + `SlashAutocomplete`; `dropHint` line; overage box; `ReferencesPicker variant="expandable" label="Files / Folders"`). RunPanel hand-wires the same trio (`RunPanel.tsx:1943-2009`, `:3004-3234`) with its own send gating — **out of scope**, left untouched. `DiffDialog` has no composer pieces.

**Caret gotcha** — any inserter other than `SlashAutocomplete` must call `setSelectionRange` **before** `focus()` (`ExtensionPicker.tsx:151-159`); the shared component must not reorder this.

**Modals** — `CreateTaskFromIssueDialog.tsx` posts `isolation: "worktree"` hardcoded (`:118`), no `baseRef`/`branch`/`references`; plain `<Textarea rows={12}>` `:231-239`; layout: info box → comments warning → Prompt → `TaskLaunchPickers` → overage → submitError; wrapped in `data-testid="issue-task-dialog"` (`display: contents`). `ResolveConflictsDialog.tsx` posts `isolation: "worktree"`, `existingBranch: context.headRef` (`:60-70`); plain `<Textarea rows={8}>`; no test ids. Both use `useTaskLaunch`/`createAndStartTask` (`TaskLaunchPickers.tsx`), whose input type is `Parameters<typeof api.createTask>[0]` → already accepts `isolation/baseRef/branch/existingBranch/references`. Both are stacked over `GitHubDialog` (a `Dialog`), so stacking is proven; `BranchNamingDialog` will be a third level — `dialog.tsx` keeps an `openDialogStack` so Escape/Tab go to the topmost.

**Server** — `POST /tasks` (`server.ts:3397-3464`) accepts all fields; `createTask` (`orchestrator.ts:3458-3688`): `isolation ?? "worktree"`, `baseRef` → sha, `existingBranch` path requires worktree + resolves `origin/<b>` then local, `taskType` validated with a default. `references` capped at 100 / 4096 chars each.

**Popovers inside a `Dialog`** — none portal: `SlashAutocomplete` (`absolute … top-full|bottom-full`), `ExtensionPicker` (`absolute z-30`), `SearchSelect` (`absolute z-50`). Inside the modal's `overflow-y-auto` body they extend the scroll area rather than being lost — same as inside the aside today. **Escape**: `SlashAutocomplete` `preventDefault()`s Escape (`:161-163`) but doesn't stop propagation; `ExtensionPicker` (`:83`) and `SearchSelect` (`:80`) close on a document keydown without marking it consumed; `dialog.tsx`'s `onKey` closes on every Escape reaching the document (`:97-101`) — it checks neither `defaultPrevented` nor the `data-popover-open` marker that `SearchSelect` (`search-select.tsx:139-142`) and the context menu already carry for RunPanel's benefit.

**Discovery data for e2e** — `listAgentCapabilities` for `claude-code` reads `<repo>/.claude/commands`, `<repo>/.claude/skills/*/SKILL.md`, `<repo>/.mcp.json`, plus `CLAUDE_BUILTINS` (`/init`, `/review`, `/security-review`, `/code-review`, `/simplify`, `/verify`, `/run`) — from the **source repo on disk**, no binary needed (`commands.ts:208-213`, `:625-649`). The fake driver (`AGETOR_CLAUDE_DRIVER=fake`, set by `e2e/fixtures.ts`) starts any task.

**e2e harness** — Playwright under Bun: `bun node_modules/@playwright/test/cli.js test <spec>` (`e2e/github-stub.ts:13-14`; not `bunx`). Worker-scoped headless backend + GitHub stub (`startGitHubStub(backend.githubStubPort, routes)`), shared Vite on :5173 (**gotcha**: `reuseExistingServer` will silently reuse a sibling worktree's Vite — make sure nothing else listens on 5173). `issue-task.spec.ts` has the issue fixture repo (`initRepo`, `origin` → `https://github.com/e2e-org/e2e-repo.git`), `openGitDialog` project pinning, `findTaskByTitle`, cleanup sweep. `pr-merged-state.spec.ts:114-236` has `prPayload({mergeable, mergeableState})` + `auxiliaryRoutes()` for a PR detail page. `Resolve with Agetor` shows when `provider==="github" && open && mergeable_state==="dirty" && !crossRepo && !merged` (`GitHubDialog.tsx:7213`, `:7994`). `fetchBranch` (`worktree.ts:536`) is best-effort with a 120 s kill; against the fake `origin` in a non-TTY subprocess git fails immediately ("could not read Username"), then `createTask` falls back to the local `refs/heads/<branch>`.

**Tests** — no React component tests exist for `src/mainview/components` (pure `.test.ts` in `lib/` only; `bunfig.toml` `root = "src"`). Keep to that: pure helpers get unit tests, UI gets e2e.

## 3. Approach & key decisions

- **D1 — Two shared modules, mirroring the `TaskLaunchPickers` precedent (hook + component in one file).** `PromptComposer.tsx` (composer) and `WorktreeOptions.tsx` (branch/isolate/name row). NewTaskForm adopts both; the two modals adopt both. RunPanel is deliberately not migrated (different gating/inline variant). *Reasoning-based; owner chose "shared component" in the grill.*
- **D2 — PR modal = locked variant of the same row**, no server change. `existingBranch` semantics stay exactly as documented in `docs/plans/resolve-pr-conflicts-with-agetor.md:97`. *Owner decision.*
- **D3 — Escape yields to popovers via the existing `data-popover-open` marker** (plus `e.defaultPrevented`) in `dialog.tsx`; `SlashAutocomplete`/`ExtensionPicker` popovers gain the marker. One convention across RunPanel, context menu, SearchSelect, Dialog. *Reasoning-based (code-read, not spiked).*
- **D4 — Issue modal mirrors the panel's "picker always visible, `baseRef` only sent when Isolate is on" behavior** (identical tooltips), rather than hiding it. *Parity over cleanliness; the owner asked for "like in the left panel".*
- **D5 — Branch name in the issue modal derives from the fixed task title** (`issueTaskTitle(thread.item)`) with `taskType: "task"` (the modal has no Type picker; server default). Noted in §8.
- **D6 — `withoutSnapshotParagraph` is deleted** with its tests (dead code after the row goes). `NewTaskForm`'s `Props.onSubmit` drops `issueUrl`/`issueSnapshot`.
- **D7 — `docs/plans/new-task-from-git-issue.md` stays as a historical record**; `CLAUDE.md` item 10 is rewritten (two entry points) and a new bullet documents the shared modules.

## 4. Work breakdown — implementation tasks

### Wave 1 (parallel; all files disjoint; no consumer changes yet)

**T1 — `PromptComposer` shared composer.** Owns **`src/mainview/components/kanban/PromptComposer.tsx`** (new) only.
Exports:
- `useAgentCapabilities(agent: string, workdir: string, branch?: string): { commands: AvailableCommand[]; extensions: AvailableExtension[] }` — lifts `NewTaskForm.tsx:393-413` verbatim (empty workdir → `[]`, cancelled flag, errors → `[]`, harness id not kind).
- `useSavedPrompts(): { savedPrompts: SavedPrompt[]; reload(): void }` — lifts `:383-390` (load on mount; `reload` on picker open and textarea focus).
- `usePromptCapture({ textareaRef, setPrompt, setReferences }): { dropHint, clearDropHint(), onPaste(e), handleResult(result) }` — lifts `applyCaptured`/`reportCapture`/`onPromptPaste` (`:713-760`) verbatim including the three `dropHintMessage` strings, `readCaret/spliceAtSelection/restoreCaret` and `mergeRefs`. `handleResult` is what an outer drop zone (the aside) calls.
- `PromptComposer` props: `value, onChange, agent, workdir, branch?, references, onReferencesChange, textareaRef?` (optional; internal ref otherwise), `capture?` (a `usePromptCapture` result; internal one otherwise — always call the hook, pick the external when given), `rows?` (default 6), `placeholder?` (default "What should the agent do? Type / for commands."), `label?` (default "Prompt"), `referencesLabel?` (default "Files / Folders"), `startingFolder?`, `disabled?`, `footer?: ReactNode` (rendered under the dropHint line — the overage box lives here), `className?`.
Renders exactly `NewTaskForm.tsx:940-996` minus the overage box: label row with `<ExtensionPicker extensions savedPrompts onPromptsOpen={reload} value onChange textareaRef placement="below" align="right" disabled={disabled || !workdir.trim()} />`; `relative` wrapper with `<Textarea ref data-testid="prompt-textarea" onPaste={capture.onPaste} onFocus={reload} onChange={…clears dropHint}>` + `<SlashAutocomplete commands savedPrompts value onChange textareaRef />`; `dropHint` `<p>`; `footer`; `<ReferencesPicker variant="expandable" label refs onChange startingFolder />`. Acceptance: file typechecks alone; no behavior invented — every string/prop copied from NewTaskForm; JSDoc explains the `capture` seam and the caret-before-focus rule.

**T2 — `WorktreeOptions` shared row + pure payload helper.** Owns **`src/mainview/components/kanban/WorktreeOptions.tsx`** (new) and **`src/mainview/lib/worktree-payload.ts`** (new) only.
- `worktree-payload.ts`: `worktreePayload({ isolate, baseRef, branchSubmitValue }): { isolation: Isolation; baseRef?: string; branch?: string }` reproducing `NewTaskForm.tsx:642-648` exactly (trim; `baseRef`/`branch` only when `isolate`; empty → `undefined`). Pure, no React.
- `useWorktreeOptions({ workdir, title, taskType }): WorktreeOptionsState` — lifts state `:253-268`, config fetch `:275-284`, derivations `:300-345`, and exposes `isolate/setIsolate/baseRef/setBaseRef/branchOverride/setBranchOverride/branchDirty/setBranchDirty/branchSettingsOpen/setBranchSettingsOpen/branchConfig/onBranchConfigSaved/branchField/branchValidation`, `valid` (`!isolate || branchValidation.ok`), `payload()` (→ `worktreePayload`), `resetBaseRef()` (project switch), `resetAfterSubmit()` (`:684-686`: `branchDirty=false`, `branchToken=newBranchToken()`; also `baseRef=""` — the form does `setBaseRef("")` at `:674`).
- `<WorktreeOptions state={…} />` renders `:1016-1088` + `:1333-1339` verbatim (BranchPicker "Branch" with the two `title` strings; checkbox with `data-testid="isolate-toggle"`, `GitBranch`, `isolateTitle` `:690-692`; `{isolate && …}` name field `data-testid="branch-name-input"` with ⚙, validation/preview/Reset; `BranchNamingDialog` with `projectPath/activeTaskType/onSaved`). Root `data-testid="worktree-options"`.
- `<WorktreeOptions locked={{ branch: string }} />` renders the same two rows read-only: "Branch" label + a disabled `Input` showing `branch` with hint text "PR head branch — checked out as-is" (`data-testid="locked-branch"`), and the Isolate checkbox `checked disabled` with `title="Always isolated — the PR's head branch is checked out in its own worktree, so your checkout stays clean."`. Root `data-testid="worktree-options-locked"`. No name field, no dialog.
Acceptance: typechecks alone; strings identical to NewTaskForm; `worktreePayload` documented as the single source of the submit mapping.

**T3 — Escape/Tab inside dialogs yield to open popovers.** Owns **`src/mainview/components/ui/dialog.tsx`**, **`src/mainview/components/kanban/SlashAutocomplete.tsx`**, **`src/mainview/components/kanban/ExtensionPicker.tsx`** only.
- `dialog.tsx` `onKey`: after the topmost check, `if (e.defaultPrevented) return;` and, for Escape, `if (document.querySelector("[data-popover-open]")) return;` (comment: mirrors RunPanel/context-menu convention; SearchSelect already carries the marker).
- `SlashAutocomplete.tsx`: popover root gets `data-popover-open=""` and `data-testid="slash-autocomplete"`; rows get `data-testid="slash-autocomplete-row"`.
- `ExtensionPicker.tsx`: popover root gets `data-popover-open=""` and `data-testid="extension-picker-popover"`; trigger button gets `data-testid="extension-picker-trigger"`; search input `data-testid="extension-picker-search"`; option rows `data-testid="extension-picker-row"`. Its document Escape handler additionally `e.preventDefault()`s **only while open**.
Acceptance: typecheck; no behavior change outside dialogs; an open popover's Escape no longer reaches a dialog's close.

### Wave 2 (parallel; after Wave 1 commits; files disjoint)

**T4 — NewTaskForm: drop the paste-URL row, adopt `PromptComposer` + `WorktreeOptions`.** Owns **`src/mainview/components/kanban/NewTaskForm.tsx`** only.
- Remove everything in §2 "Paste-URL row" (state, refs, effect, `loadIssueFromUrl`, JSX, submit fields, reset lines, `Props` fields, now-unused imports incl. `withoutSnapshotParagraph`, `parseIssueUrl`, `sameIssueUrl`, `buildIssueTaskPrompt`, `issueTaskTitle`, `renderIssueThreadMarkdown`, and any lucide icons only the row used). Keep `promptOverage`.
- Replace `:378-413` composer state/effect and `:940-996` JSX with `usePromptCapture` (kept at form level so `onAsideDrop` can call `capture.handleResult`) + `<PromptComposer … capture={capture} footer={overageBox} startingFolder={workdir || undefined} />`. `references` state stays in the form. Drag/drop, collapsed-rail, spotlight and drop-hint behavior unchanged.
- Replace `:253-268`, `:275-284`, `:300-345`, `:1016-1088`, `:1333-1339` with `useWorktreeOptions({ workdir, title, taskType })` + `<WorktreeOptions state={wt} />`; `ProjectPicker.onChange` → `wt.resetBaseRef()`; `canSubmit` → `wt.valid`; submit → `...wt.payload()`; reset → `wt.resetAfterSubmit()`; capabilities branch dep → `wt.baseRef`.
- Before editing, grep `e2e/*.spec.ts` for locators against the form (`label:text-is("Prompt")`, `"Project"`, `"Isolate"`, `Files / Folders`, `textarea` ordering) and preserve them.
Acceptance: typecheck; no visual/behavior change except the missing row; `App.tsx` untouched.

**T5 — Issue modal adopts both shared modules.** Owns **`src/mainview/components/kanban/CreateTaskFromIssueDialog.tsx`** only.
- `const wt = useWorktreeOptions({ workdir: context?.path ?? "", title: thread ? issueTaskTitle(thread.item) : "", taskType: "task" })`; `const [references, setReferences] = useState<TaskReference[]>([])`. On-open reset effect also calls `wt.resetAfterSubmit()` and `setReferences([])`.
- Layout: info box → comments warning → `<PromptComposer value={prompt} onChange={(v)=>{setPrompt(v); setPromptDirty(true)}} agent={launch.agent} workdir={context.path} branch={wt.baseRef || undefined} references onReferencesChange startingFolder={context.path} rows={12} footer={overageBox} />` → `<WorktreeOptions state={wt} />` → `<TaskLaunchPickers launch={launch} />` → submitError. (Overage box moves into `footer`.)
- Info-box copy: "Creates a task on a fresh branch in its own worktree." when `wt.isolate`, else "Runs directly in the project checkout (no worktree)."
- `canSubmit` adds `wt.valid`; submit payload: replace `isolation: "worktree"` with `...wt.payload()` and add `references`.
Acceptance: typecheck; existing `issue-task-dialog`/`issue-task-submit` test ids kept; the dialog's only `<textarea>` is still the prompt.

**T6 — PR modal locked row + composer; delete dead helper; docs.** Owns **`src/mainview/components/kanban/ResolveConflictsDialog.tsx`**, **`src/shared/issue-task.ts`**, **`src/shared/issue-task.test.ts`**, **`CLAUDE.md`** only.
- Dialog: `references` state (reset on open); `<PromptComposer … agent={launch.agent} workdir={context.path} branch={context.headRef} rows={8} startingFolder={context.path} />` replacing the `Textarea`; `<WorktreeOptions locked={{ branch: context.headRef }} />` after it, before `TaskLaunchPickers`; payload adds `references` (keep `isolation: "worktree"`, `existingBranch`). Add `data-testid="resolve-conflicts-dialog"` wrapper (same `display: contents` trick as the issue dialog) and `data-testid="resolve-conflicts-submit"`.
- `issue-task.ts`: delete `withoutSnapshotParagraph` (and any helper only it used); `issue-task.test.ts`: delete its describe block (`:710-777`).
- `CLAUDE.md:38`: two entry points instead of three; drop the `NewTaskForm` clause from the `commentsError` sentence; add a sentence that the issue dialog now carries the panel's worktree row + composer via the shared modules. Add a new item 11 to "Orchestration flow": `PromptComposer` (hooks + component, caret rule, `capture` seam) and `WorktreeOptions` (state hook, `worktreePayload`, locked variant for `existingBranch` tasks) — and the `dialog.tsx` `data-popover-open` rule.
Acceptance: typecheck; `bun test src/shared/issue-task.test.ts` green.

## 5. Work breakdown — test tasks

E2E **applies** (UI flows across webview → API → git). Run recipe: `bun run typecheck && bun test` for unit; e2e per spec with `bun node_modules/@playwright/test/cli.js test e2e/issue-task.spec.ts e2e/resolve-conflicts.spec.ts` (Playwright boots Vite on :5173 and the headless backend per worker via `e2e/fixtures.ts`; ensure :5173 is free first — `lsof -i :5173`). Full suite: `bun node_modules/@playwright/test/cli.js test`.

**TT1 — Rewrite `e2e/issue-task.spec.ts`** (owns that file only). Covers T4/T5/T1/T2/T3.
- Delete the two form-path tests, `newTaskAside`, `selectProjectInForm`; update the file header.
- `initRepo`: add a `develop` branch with one extra commit; plant `.claude/skills/e2e-skill/SKILL.md` (frontmatter `name: e2e-skill`, `description: …`) and `.mcp.json` `{"mcpServers": {"e2e-mcp": {"command": "true"}}}` (commit them).
- Keep the existing dialog-path test; add: (a) **Isolate off** → created task `isolation === "none"`, `branch === null`; (b) **Branch-from + name** → pick `develop` in the Branch picker (`label:text-is("Branch") + div button` inside `worktree-options`, search, click row), type `feature/e2e-custom` into `branch-name-input`, submit → `task.branch === "feature/e2e-custom"`, `task.baseRef === git rev-parse develop`, `isolation === "worktree"`; (c) **Composer** → type `/code-` in `prompt-textarea`, expect `slash-autocomplete` row `/code-review`, press Enter → value contains `/code-review `; type `/co` again, press Escape → `issue-task-dialog` still visible (T3 guard); click `extension-picker-trigger`, search `e2e-skill`, click row → value contains `/e2e-skill`; search `e2e-mcp`, click → contains `@e2e-mcp`; assert the "Files / Folders" picker is rendered (native panel not drivable). Every test deletes its task; scope locators to `page.getByTestId("issue-task-dialog")` (two `role=dialog`s are stacked).

**TT2 — New `e2e/resolve-conflicts.spec.ts` + unit test** (owns **`e2e/resolve-conflicts.spec.ts`** and **`src/mainview/lib/worktree-payload.test.ts`** only). Covers T6/T2/T3.
- Fixture: repo with `main` + local `feature-branch` (one commit ahead), `origin` → `https://github.com/e2e-org/e2e-repo.git`; copy `prPayload`/`auxiliaryRoutes` from `pr-merged-state.spec.ts` with `mergeable: false, mergeable_state: "dirty"` (extraction into a shared file is allowed only if `pr-merged-state.spec.ts` keeps identical behavior; copying is fine).
- Flow: open Git dialog → PR #42 detail → "Resolve with Agetor" → `resolve-conflicts-dialog`: `worktree-options-locked` visible, `isolate-toggle` checked + disabled, `locked-branch` value `feature-branch`; `/code-` → pick → value contains `/code-review `; Escape with the menu open keeps the dialog; submit → task `isolation === "worktree"`, `branch === "feature-branch"`, `branchSource === "existing"`; delete the task and assert `git rev-parse --verify feature-branch` still succeeds (existing-branch invariant). If `fetchBranch` against the fake origin proves slow (>10 s) in practice, switch the fixture's `origin` fetch URL to a local bare clone via `git config url.<bare>.insteadOf https://github.com/e2e-org/e2e-repo.git` and verify `providerRepoForDir` still reads GitHub.
- `worktree-payload.test.ts`: isolate on/off × baseRef empty/set × branch empty/set → exact payloads; trimming.

## 6. Execution waves

| Wave | Tasks | Barrier |
| --- | --- | --- |
| 1 | T1, T2, T3 (3 agents) | typecheck green; commit `wave 1: shared PromptComposer + WorktreeOptions; dialog Escape yields to popovers` |
| 2 | T4, T5, T6 (3 agents) | typecheck + `bun test` green; commit `wave 2: …` |
| Review | Phase 5 (opus, `code-review` skill) | fix list |
| Tests | TT1, TT2 (2 agents) | commit `tests: …` |
| Run | Phase 7 (haiku): typecheck, `bun test`, the two e2e specs, then full e2e | green or fix loop (≤3 rounds) |

## 7. Blast radius & risks

- **NewTaskForm refactor (T4)** is the largest diff on a 1.3k-line component with drag/drop, paste, collapsed-rail and spotlight interlocks. Mitigation: hooks lifted verbatim, `capture` seam keeps the aside-wide drop; other e2e specs that drive the form (onboarding, context-menu, etc.) run in Phase 7.
- **`dialog.tsx` change affects every dialog.** Only Escape-with-an-open-popover and already-`defaultPrevented` keys change — both are bug fixes (Settings' SearchSelects gain the same protection). A context menu open while a dialog is open now needs a second Escape — acceptable.
- **Popover geometry inside `overflow-y-auto` modal bodies**: popovers extend the scroll region (same as in the aside); `TaskLaunchPickers` below the row gives room. Playwright scrolls into view.
- **`fetchBranch` in the PR e2e** against a fake GitHub origin: expected to fail fast without a TTY; 120 s worst case with a fallback recipe in TT2.
- **Server contract unchanged**; `references` + issue snapshot merge is additive (`orchestrator.ts:3665-3685`).
- **Rollback**: revert the two commits; no migration, no data change.

## 8. Open questions / assumptions

Grill answers (owner, 2026-08-27): PR modal → **locked indicator**; issue modal → **full parity incl. branch-name field**; composer → **all three pieces as a shared component, NewTaskForm migrated**; e2e → **both modals + composer**.

Assumptions logged:
- Issue modal task type is `"task"` (no Type picker there); a bug-labelled issue still gets the `task` prefix. Candidate follow-up: Type picker in the modal.
- The Files/Folders picker's native open panel isn't e2e-drivable; only its presence is asserted.
- RunPanel keeps its own composer wiring (out of scope).
- `docs/plans/new-task-from-git-issue.md` is left as a historical record.
- `NewTaskForm`'s `Props.onSubmit` loses `issueUrl`/`issueSnapshot`; `App.tsx` spreads `input` and needs no edit.

## 9. Completeness ledger

Not run under `--no-follow-ups`. Candidate follow-ups surfaced: Type picker in the issue modal; migrating RunPanel onto `PromptComposer`; `updatedAt` display for saved prompts (pre-existing).
