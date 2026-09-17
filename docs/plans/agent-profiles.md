# Plan — Agents (reusable agent profiles) + Agent picker on task launch

| Field | Value |
| --- | --- |
| Date | 2026-09-13 |
| Source | `/implement` request (conversation) — "Agents Creation Tool" + New Task agent picker |
| Config | AGENTS_CONFIG.yml (balanced: investigate/implement/tests sonnet, review opus, test-running haiku, planning self) |
| Flags | none |
| Gates | grilled with owner (13 questions, answered); plan approval pending |
| Branch | `feature/agents-creating-agents` (already a feature branch) |
| Base SHA | `fe65199` (release v0.1.8), tree clean |

## 1. Objective & success criteria

Let the user define named **Agents** — a reusable profile bundling *harness* (a harness id, so multi-account aliases work), *model*, *effort*, *mode*, *fast/max-mode* (cursor only), free-text *general instructions*, and a list of *skills* — manage them (create / edit / delete) in Settings and from the CLI, and pick one on task launch instead of picking harness/model/effort by hand.

Done means:

1. Settings → **Agents** section lists profiles as rich cards and supports create / edit / delete (delete behind the destructive confirm). Skills field is a chip input with autocomplete over the harness's user-level skills + plugins, free text accepted.
2. New Task form, Resolve-Conflicts dialog and Create-from-issue dialog carry an **Agent** picker whose options render harness icon + name + harness label + model · effort · mode + the first lines of the instructions. Picking one **replaces** the harness/mode/model/effort block with the selected card ("one selection"); "No agent" restores the manual block.
3. A task created from a profile stores `agentProfileId` + a full JSON **snapshot**; its own `agent/model/effort/mode/fast/maxMode` are copied from the profile. Before its first run the task follows the **live** profile (edits apply); from the first run on it uses the **snapshot** (edits/deletes never affect a task that ran). If the profile is gone at any point, the snapshot is used.
4. At every `startTask` (fresh session / re-run — never on follow-up messages) the launch prompt is
   ```
   <agent_instructions_defined_by_the_user>
   {instructions}

   Skills to use for this task (invoke each with its skill tool before starting): /a, /b
   </agent_instructions_defined_by_the_user>

   Your task:
   {prompt}
   ```
   and the transcript renders that tag as a collapsible "Agent instructions" block, not raw angle brackets.
5. Task details header and board card show the profile (name + harness icon, "(deleted)" when the profile no longer exists); the details dropdowns are locked while a profile is attached, with a **Detach** action that keeps the values and unlocks them. `PATCH /tasks/:id` refuses agent/mode/model/effort/fast/maxMode edits on a bound task (409) so the CLI can't bypass the lock.
6. CLI parity: `agetor agent ls|show|add|edit|rm`, `agetor add --profile <id|name>` (non-interactive and wizard), `agetor show`/`ls` print the profile name.
7. Unit + endpoint + orchestrator tests green; one Playwright spec covers the Settings CRUD, the launch-form picker, the injected block, the freeze-after-first-run rule and the deleted-profile fallback; `bun run typecheck` clean.

## 2. Context & constraints (Phase 1 findings)

- **Closest template: Saved Prompts** — migration `040_saved_prompts.sql` → `savedPrompts` module `src/bun/db.ts:1110-1176` → authed routes `src/bun/server.ts:3136-3186` → `api.ts:472-481` → `SavedPromptsSection.tsx` (inline form, `useConfirm({variant:"destructive"})`, no success toasts) → tests `saved-prompts.test.ts` / `saved-prompts-endpoint.test.ts` (unique `AGETOR_API_PORT` per file). Harnesses (`db.ts:899-1030`, `server.ts:2924-3120`, `src/cli/commands/harness.ts`) is the template for the CLI subcommand.
- **Snapshot precedent**: `baseRef`/`prUrl`/`issueUrl` are create-only and absent from `ALLOWED_PATCH_FIELDS` (`server.ts:375-378`). Server-managed task columns that the generic `tasks.update` SET clause (`db.ts:451-464`) skips and that are written only via targeted UPDATE helpers: `last_assistant_event_id`, `last_seen_event_id`, `sent_files`, `fx_recovery`. The two new task columns follow that pattern.
- **Harness delete guard**: `harnesses.delete` throws `HarnessInUseError(taskIds)` (`db.ts:865`, 409 at `server.ts:3121`, CLI `harness.ts:96-101`). A profile pointing at a harness must extend that guard, otherwise a profile silently breaks at create time.
- **No system-prompt mechanism** exists for any harness (`agents.ts` has zero `--append-system-prompt`/`--system-prompt` uses). Launch prompt assembly is `task.prompt` → `expandAtReferencesDetailed` → `appendReferences` (`orchestrator.ts:1051-1146`), echoed as the first `user` event (`orchestrator.ts:1155`). The preamble is composed around the *expanded* prompt and before `appendReferences`, so `@`-tokens in the instructions are never expanded (the preamble is authored text, not a path list) and references stay last.
- **Gemini argv budget**: `promptByteOverage` (`shared/prompt-limits.ts`) is checked client-side (`NewTaskForm.tsx:418`, the issue dialog) and server-side with the `expandedOverage && !rawOverage` rule (`orchestrator.ts:1065-1080`; pinned by `orchestrator-fx.test.ts` "spawn-throw hardening (gemini)"). Both "raw" and "expanded" must include the preamble so the rule's semantics are unchanged.
- **Skills without a workdir**: `GET /agent-discovery?agent=<harnessId>` accepts a missing `workdir` (`server.ts:3382-3405`; `listAgentCapabilities` at `commands.ts:625` always includes user-level entries and plugins). `api.listAgentCapabilities` (`api.ts:1160`) currently types `workdir: string` — make it optional. Skills are `extensions.filter(e => e.kind === "skill")` with `insert = "/" + name`.
- **Tag rendering**: `parseMessageSegments` (`shared/user-message.ts:290`, `TAG_OPEN_RE = /<([a-z][a-z0-9_-]*)…/`) accepts `agent_instructions_defined_by_the_user`; the generic labeled block in `MessageSegments.tsx` renders it today with the raw tag name as label, and `userMessageLines` prints `<name>›`. Both get a friendly label.
- **Two independent launch pickers**: `NewTaskForm.tsx` (hand-rolled block, L629-800: harness button grid, Code/Plan toggle + mode `SearchSelect`, model/effort `Select`, cursor-only fast/max toggles at L777-800) and `TaskLaunchPickers.tsx` (`useTaskLaunch` hook + `<TaskLaunchPickers>` markup, consumed by `ResolveConflictsDialog.tsx:203` and `CreateTaskFromIssueDialog.tsx:323`). `useTaskLaunch` lacks fast/maxMode today.
- **Picker primitives** (`ui/search-select.tsx`, `ui/multi-search-select.tsx`) render label + hint only — no rich card slot, no chips. New components are required; they must carry `data-popover-open=""` while open and close on Escape (dialog Escape contract, CLAUDE.md item 11).
- **Task details**: RunPanel `onAgentChange` (`RunPanel.tsx:6087-6111`) PATCHes agent+mode+model+effort in one call; server-side `reconcileTaskSession` drops/mirrors the live session. `AgentSelect`/`CompactSelect` at L6160-6240. `TaskCard.tsx:224-231` renders `AgentIcon` + raw `task.agent` badge and a `model · mode` line.
- **Settings**: `SETTINGS_SECTIONS` in `src/mainview/lib/settings-dialog-view.ts:4-9` (exhaustive `switch` in `SettingsDialog.tsx:~505`; Git and Prompts sections are always-mounted hidden divs so drafts survive section switches). `App.tsx:1001` has `openSettingsHarnesses` (sets `initialSection`) — the template for `openSettingsAgents`.
- **fast/maxMode** are cursor-only: `cursorModelSupportsFast(model, effort)` / `cursorModelSupportsMaxMode(model)` (`NewTaskForm.tsx:373-374`).
- **CLI**: dispatch `src/cli/index.ts:182` (`case "harness": case "harnesses":`), usage table `src/cli/usage.ts` (per-subcommand entries like `"harness add"`), `add.ts` flags L61-89 + `@clack/prompts` wizard L399+, `show.ts:20-25`, `ls.ts:93`, `manage.ts` (`agetor edit --model/--effort`).
- **Tests**: bun tests set `AGETOR_DATA_DIR` to a mkdtemp **before** dynamically importing `db.ts`; endpoint tests boot `startApiServer()` on a unique port and use `API_TOKEN`; never `rmSync` a live data dir (`rmTestDataDir`). e2e: `e2e/fixtures.ts` (headless backend, `AGETOR_CLAUDE_DRIVER=fake`, per-worker port/token), `e2e/helpers.ts` (`gotoApp`, `openSettingsGeneral`), kebab-case test ids scoped under a container id. Run with `bun node_modules/@playwright/test/cli.js test <spec>`, one Playwright run at a time.
- No spikes were needed: every load-bearing assumption (discovery without workdir, tag regex, prompt echo, patch allow-list) was settled by reading the code.

## 3. Approach & key decisions

| # | Decision | Why / alternative rejected |
| --- | --- | --- |
| D1 | Own table `agent_profiles` + two create-only task columns `agent_profile_id` (soft ref) and `agent_profile` (JSON snapshot). Both excluded from the generic `tasks.update` SET clause and from `ALLOWED_PATCH_FIELDS`; written only by `tasks.setAgentProfile` (targeted UPDATE, no `updated_at` bump). | Same pattern as `sent_files`/`fx_recovery`. A pure snapshot (no id) can't do the owner's "use the live agent by id, JSON only when it's gone"; a pure id can't survive delete. |
| D2 | **Freeze at first run.** `effectiveAgentProfile(task)` = live profile if `task.agentProfileId` resolves **and** the task has no run rows; else the snapshot. `startTask` re-copies the live values onto the task row and refreshes the snapshot right before minting the first run. | Reconciles "live by id" with "must not affect tasks that already ran". Re-runs after orphan/failure therefore reproduce exactly what the task first ran with. |
| D3 | Injection = prompt preamble (owner's exact wrapper tag), composed by one pure shared helper `composeLaunchPrompt(profile, prompt)` used by the orchestrator, the client budget pre-checks and the CLI. Empty instructions + no skills ⇒ no preamble, prompt unchanged. | Harness system-prompt flags are not uniformly available (only claude-code has one; gemini's replaces the whole system prompt). |
| D4 | Skills ride inside the preamble as a `/name` list with an explicit "invoke each with its skill tool" instruction. | A leading `/name` would be parsed as one slash command by claude; several can't be invoked that way. |
| D5 | "One selection": picking a profile hides the manual block in every launch surface; task details lock the four dropdowns with a **Detach** action (`DELETE /tasks/:id/agent-profile`, archived-guarded) and the server refuses bound-field PATCHes with 409. | Owner's answer to Q3. The PATCH guard is what keeps `agetor edit --model` honest. |
| D6 | Profile names are unique (case-insensitive, trimmed) → 409 on clash. | Makes `agetor add --profile <name>` unambiguous. |
| D7 | Deleting a **harness** that a profile references is refused (extends `HarnessInUseError` with `profileIds`); deleting a **profile** always succeeds (tasks keep their snapshot). | Mirrors the existing convention for tasks; a profile pointing at a missing harness would fail every create. |
| D8 | Skills autocomplete source = `GET /agent-discovery?agent=<harnessId>` with no `workdir`; free text accepted. | Owner Q11. Project skills only exist once a workdir is known. |
| D9 | Profile form reuses `useTaskLaunch` + `<TaskLaunchPickers>` (extended with fast/maxMode and a `seed(values)` setter) instead of a third hand-rolled picker block. | Stops a third copy of the harness/model/effort logic from appearing. |
| D10 | Shared card rendering `AgentProfileCard` (compact + full variants) used by the picker rows, the Settings list, the launch-form "selected" state and the details chip. | One rendering, four surfaces. |
| D11 | The transcript's first user bubble renders the preamble as a collapsible "Agent instructions" block (default collapsed) followed by the "Your task:" text; `MessageHistoryPicker` strips the preamble via `stripAgentInstructionsPreamble` so resending doesn't re-inject it as user text. | Owner Q6. |
| D12 | No "last used profile" preference; the default is "No agent". | Owner Q10. |
| D13 | CLI subcommand is `agetor agent` (alias `agents`); the task flag is `--profile <id|name>` because `--agent` already means harness id on `agetor add`/`edit`. Passing `--profile` together with `--agent/--model/--mode/--effort/--fast/--max-mode` is a usage error. | Owner asked for full parity; the flag name avoids an existing collision. |
| D14 | Snapshot shape carries the resolved harness *kind* and *label* too, so a deleted-harness or deleted-profile task still renders its chip/preamble without lookups. | Display must not depend on rows that may be gone. |

### Contracts every task implements against (verbatim)

`src/shared/types.ts`:

```ts
export interface AgentProfile {
  id: string;                 // uuid
  name: string;               // unique, trimmed, case-insensitive
  harness: string;            // harness id (Task.agent semantics)
  model: string;
  effort: string | null;
  mode: string | null;        // null ⇒ defaultModeFor(kind) at spawn
  fast: boolean;              // cursor only
  maxMode: boolean;           // cursor only
  instructions: string;       // may be ""
  skills: string[];           // bare skill names, no leading "/", deduped, max 50, each ≤ 100 chars
  createdAt: number;
  updatedAt: number;
}
/** What a task keeps: the profile as it was when captured, plus the resolved harness identity. */
export interface AgentProfileSnapshot {
  id: string; name: string; harness: string; harnessKind: AgentKind; harnessLabel: string;
  model: string; effort: string | null; mode: string | null; fast: boolean; maxMode: boolean;
  instructions: string; skills: string[];
  capturedAt: number;
}
// Task additions (both optional at the type level for fixture compatibility, like issueUrl; toTask always sets them):
//   agentProfileId?: string | null;
//   agentProfile?: AgentProfileSnapshot | null;
```

`src/shared/agent-profile.ts` (pure, no runtime imports from either side):

```ts
export const AGENT_INSTRUCTIONS_TAG = "agent_instructions_defined_by_the_user";
export const AGENT_PROFILE_LIMITS = { name: 80, instructions: 20_000, skills: 50, skillName: 100 } as const;
export function normalizeSkillName(raw: string): string;          // trim, strip leading "/", collapse whitespace → "" if invalid
export function composeLaunchPrompt(profile: Pick<AgentProfileSnapshot,"instructions"|"skills"> | null, prompt: string): string;
export function stripAgentInstructionsPreamble(text: string): string;  // inverse for display/resend; identity when no preamble
export function agentProfileSummary(p: {harnessLabel: string; model: string; effort: string|null; mode: string|null}): string; // "harness · model · effort · mode"
export function matchAgentProfileRef(profiles: AgentProfile[], ref: string): { profile: AgentProfile } | { error: string }; // id, then unique case-insensitive name; ambiguous/unknown → error
export function snapshotFromProfile(p: AgentProfile, harness: { kind: AgentKind; label: string }, now: number): AgentProfileSnapshot;
```

Routes (`src/bun/server.ts`, all `authed`):

| Route | Body / result |
| --- | --- |
| `GET /agent-profiles` | `AgentProfile[]` (name ASC) |
| `POST /agent-profiles` | `{name, harness, model, effort?, mode?, fast?, maxMode?, instructions?, skills?}` → `AgentProfile`; 400 invalid/unknown harness, 409 duplicate name |
| `GET /agent-profiles/:id` | `AgentProfile` / 404 |
| `PATCH /agent-profiles/:id` | partial of the POST body → `AgentProfile`; same validation |
| `DELETE /agent-profiles/:id` | `{ok:true}` / 404 — never blocked |
| `POST /tasks` | additive `agentProfileId?: string` — server resolves the profile and **overrides** agent/model/effort/mode/fast/maxMode from it; 400 unknown id |
| `DELETE /tasks/:id/agent-profile` | detach → returns the full `Task`; 404, 409 archived |
| `PATCH /tasks/:id` | 409 `{error:"task is bound to agent \"<name>\" — detach it first"}` when the patch touches agent/mode/model/effort/fast/maxMode and `agent_profile_id` is set |
| `DELETE /harnesses/:id` | 409 payload gains `profileIds: string[]` |

DB (`src/bun/db.ts`): `agentProfiles.{list, get, findByName, insert, update, delete}` (+ `AgentProfileNameError`), `tasks.setAgentProfile(taskId, profileId | null, snapshot | null)` (targeted UPDATE, no `updated_at`), `runs.countForTask(taskId): number`, `harnesses.delete` also checks `agent_profiles.harness_id`.

## 4. Work breakdown — implementation tasks

### Wave 1 — foundation (2 agents, disjoint)

**T1 — shared contracts + pure helpers.** Owns `src/shared/types.ts`, `src/shared/agent-profile.ts` (new), `src/shared/user-message.ts` (only: `userMessageLines` prints `agent›` for the new tag; add the tag name to nothing else — it must stay a generic tag for `parseMessageSegments`).
Acceptance: the verbatim contracts above exist; `composeLaunchPrompt` returns the exact wrapper from §1 (skills line omitted when empty; whole preamble omitted when instructions is blank and skills empty); `stripAgentInstructionsPreamble(composeLaunchPrompt(p, x)) === x` for every `x`; `matchAgentProfileRef` prefers exact id, then unique case-insensitive name, error text lists the candidates on ambiguity. `bun run typecheck` may fail until T2 lands (consumers of `Task` fixtures) — T1 must add the two new fields to `Task` as optional so existing fixtures compile.

**T2 — persistence.** Owns `src/bun/migrations/052_agent_profiles.sql`, `src/bun/migrations/053_task_agent_profile.sql`, `src/bun/migrations/index.ts`, `src/bun/db.ts`.
Migration 052: `agent_profiles(id TEXT PK, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE /* lower(trim(name)) */, harness_id TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, mode TEXT, fast INTEGER NOT NULL DEFAULT 0, max_mode INTEGER NOT NULL DEFAULT 0, instructions TEXT NOT NULL DEFAULT '', skills_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`. Migration 053: `ALTER TABLE tasks ADD COLUMN agent_profile_id TEXT; ALTER TABLE tasks ADD COLUMN agent_profile TEXT;` with the doc comment stating both are written only by `tasks.setAgentProfile`/`tasks.insert` and skipped by the generic SET clause. No backfill (existing rows are "no agent").
Acceptance: `toTask` parses both (`parseAgentProfileSnapshot` sanitizes like `parseBacklog`); `tasks.insert` accepts `agentProfileId`/`agentProfile`; `tasks.update` SET clause skips both (comment updated); `tasks.setAgentProfile`, `runs.countForTask`, `agentProfiles` module (insert/update maintain `name_key`, duplicate → `AgentProfileNameError`; skills normalized via T1's `normalizeSkillName`, capped); `harnesses.delete` throws `HarnessInUseError` extended with `profileIds` (constructor `(taskIds, profileIds = [])`, message mentions both counts when non-zero). T2 imports T1's helpers by the names in §3; if T1 hasn't landed when T2 typechecks, T2 still writes against those names.

Barrier: `bun run typecheck` + `bun test src/bun/db.test.ts src/bun/harnesses.test.ts src/bun/saved-prompts.test.ts` (existing) green.

### Wave 2 — server, webview primitives, CLI (3 agents, disjoint)

**T3 — server + orchestrator.** Owns `src/bun/server.ts`, `src/bun/orchestrator.ts`.
- Routes from the §3 table (validation mirrors `/saved-prompts`: non-object JSON guard, trims, `harnesses.getByIdOrKind` for the harness, `mode` passthrough, `effort` passthrough (same null-clear-only philosophy as tasks), `skills` via `normalizeSkillName`, limits from `AGENT_PROFILE_LIMITS`).
- `createTask`: `agentProfileId` → `agentProfiles.get` (400 on miss) → override agent/model/effort/mode/fast/maxMode → `snapshotFromProfile` → insert with both columns. Body-provided values for those fields are ignored when a profile is given.
- `startTask` (in `startTaskInner`, **before** the harness pre-flight): `effectiveAgentProfile(task)` (live iff `task.agentProfileId` resolves AND `runs.countForTask(taskId) === 0`); when live and it differs from the snapshot, `tasks.update` the six copied fields + `tasks.setAgentProfile` with a fresh snapshot, then re-read `task`. Launch prompt: `composeLaunchPrompt(effective, expandedPrompt)` and `composeLaunchPrompt(effective, task.prompt)` feed the existing overage rule (both raw and expanded include the preamble, so `expandedOverage && !rawOverage` keeps its meaning and `orchestrator-fx.test.ts` stays green); `promptWithRefs = appendReferences(composeLaunchPrompt(effective, expandedPrompt), task.references)`.
- `sendInput` unchanged (no injection on follow-ups).
- PATCH guard (409) and `DELETE /tasks/:id/agent-profile` (archived → 409, returns `withRunningSubagents(task)`), harness 409 payload gains `profileIds`.
- `deleteTask`/archive: nothing to clean (snapshot lives on the row).
Acceptance: `bun run typecheck`; existing `orchestrator*.test.ts` green.

**T4 — webview API + primitives.** Owns `src/mainview/lib/api.ts`, `src/mainview/lib/agent-profiles.ts` (new: `useAgentProfiles()` module-cached hook with `refresh()`, `filterAgentProfiles(list, query)`, `resolveTaskProfileDisplay(task, liveList)` → `{name, harnessKind, harnessLabel, deleted}`), `src/mainview/components/kanban/AgentProfileCard.tsx` (new), `src/mainview/components/kanban/AgentProfilePicker.tsx` (new), `src/mainview/components/kanban/SkillsPicker.tsx` (new).
- `api.ts`: `listAgentProfiles/getAgentProfile/createAgentProfile/updateAgentProfile/deleteAgentProfile/detachTaskAgentProfile`; `createTask` input gains `agentProfileId?`; `listAgentCapabilities` `workdir` becomes optional (omit the query param when absent).
- `AgentProfileCard`: props `{ profile: AgentProfile | AgentProfileSnapshot, harnesses?: Harness[], variant: "row" | "selected" | "chip", deleted?: boolean }` — `AgentIcon` by kind, name, `agentProfileSummary`, instructions clamped to 2 lines (`line-clamp-2`), skills as small mono chips (first 4 + "+N"), semantic tokens only (`text-muted-foreground`, `bg-card`, `border-border`, `text-warning` for "(deleted)").
- `AgentProfilePicker`: controlled `{ value: string | null, onChange, profiles, harnesses, onManage?: () => void, disabled? }`. Trigger button shows "No agent — pick harness manually" or the selected card (`variant="selected"` with a clear ×). Popover: search input (filters by name/harness/model/instructions), "No agent" row, one `AgentProfileCard variant="row"` per profile, roving keyboard focus (↑/↓/Enter/Escape), portal-free, `data-popover-open=""` while open, closes on Escape / outside mousedown, optional footer "Manage agents…" (calls `onManage`). Test ids: `agent-profile-picker`, `agent-profile-picker-trigger`, `agent-profile-picker-popover`, `agent-profile-picker-search`, `agent-profile-picker-none`, `agent-profile-picker-row` (+ `data-profile-id`), `agent-profile-picker-clear`, `agent-profile-picker-manage`.
- `SkillsPicker`: controlled `{ value: string[], onChange, harnessId: string | null, disabled? }`. Chips with remove ×, one text input; on focus/typing fetches `api.listAgentCapabilities({agent: harnessId})` (skills only, cached per harness id) and shows a filtered suggestion list below (`data-popover-open=""` while open, `data-popover-keys="escape-only"`); Enter/Tab/comma commits the highlighted suggestion or the free text (normalized via `normalizeSkillName`, deduped, ignores empty), Backspace on an empty input removes the last chip, Escape closes the list only. Test ids: `skills-picker`, `skills-picker-input`, `skills-picker-chip` (+ `data-skill`), `skills-picker-remove`, `skills-picker-row`.
Acceptance: components compile in isolation; no new tokens introduced (CLAUDE.md undefined-token trap).

**T5 — CLI.** Owns `src/cli/api-client.ts`, `src/cli/commands/agent-profile.ts` (new), `src/cli/index.ts`, `src/cli/usage.ts`, `src/cli/commands/add.ts`, `src/cli/commands/show.ts`, `src/cli/commands/ls.ts`, `src/cli/commands/manage.ts`, `src/cli/tui/Dashboard.tsx` (only if it prints `task.agent`; otherwise untouched).
- `api-client`: `listAgentProfiles/getAgentProfile/createAgentProfile/patchAgentProfile/deleteAgentProfile/detachTaskAgentProfile`, `CreateTaskInput.agentProfileId`.
- `agetor agent <ls|show <ref>|add <name> …|edit <ref> …|rm <ref>>` (alias `agents`), flags `--harness <id> --model <id> --effort <id> --mode <id> --fast/--no-fast --max-mode/--no-max-mode --instructions <text> --instructions-file <path|-> --skill <name>` (repeatable; `edit --clear-skills`), `--json` everywhere, table output for `ls` (name, harness, model, effort, mode, skills count, instructions preview). `<ref>` resolves via `matchAgentProfileRef` over `listAgentProfiles()`.
- `agetor add --profile <ref>`: non-interactive → resolve, send `agentProfileId`, usage error when combined with `--agent/--model/--mode/--effort/--fast/--no-fast/--max-mode/--no-max-mode`; wizard → a first `select` "Agent" step listing profiles (label = name, hint = summary) plus "Pick harness manually"; picking a profile skips the harness/model/mode/effort steps and does not touch the `lastModel:<kind>` preferences.
- `agetor show`: `agent profile: <name> (<id>)` line (+ `(deleted)` when `GET /agent-profiles/:id` 404s — one extra call only when the task has an id); `agetor ls`: agent column shows `<profile name>` with the harness in dim parens when attached; `manage.ts` (`agetor edit`): surface the 409 message verbatim, plus `agetor edit <id> --detach-profile` calling the detach route.
- `usage.ts`: entries for `agent`, `agent add`, `agent edit`, and the `--profile` line in `add`'s usage.
Acceptance: `bun run typecheck`; `bun test src/cli/commands/add.test.ts` green (extend in Phase 6).

Barrier: `bun run typecheck` green; `bun test src/bun` green.

### Wave 3 — UI integration (2 agents, disjoint)

**T6 — Settings section + shared launch pickers + the two dialogs.** Owns `src/mainview/lib/settings-dialog-view.ts`, `src/mainview/lib/settings-dialog-view.test.ts`, `src/mainview/components/settings/SettingsDialog.tsx`, `src/mainview/components/settings/AgentProfilesSection.tsx` (new), `src/mainview/components/kanban/TaskLaunchPickers.tsx`, `src/mainview/components/kanban/ResolveConflictsDialog.tsx`, `src/mainview/components/kanban/CreateTaskFromIssueDialog.tsx`.
- `SETTINGS_SECTIONS` gains `{ id: "agents", label: "Agents" }` between Harnesses and Git Integration; `SettingsDialog` renders `AgentProfilesSection` as an always-mounted hidden div (draft survival, same as Prompts) and the exhaustive switch gets its `case "agents": return null`. Harness delete error copy mentions agents when `profileIds` is non-empty.
- `useTaskLaunch(open, opts?)` gains `fast/maxMode/setFast/setMaxMode` (+ `fastAvailable/maxModeAvailable` using the cursor helpers; auto-clear like NewTaskForm L388-392), `agentProfileId/setAgentProfileId`, `profiles` (via `useAgentProfiles`), `seed(values: Partial<{agent, mode, model, effort, fast, maxMode}>)` for the edit form, and its `TaskLaunchPickers` markup renders `<AgentProfilePicker>` on top; when a profile is selected the harness/mode/model/effort block is replaced by the card. Add cursor-only fast/max toggles to the markup (test ids `launch-fast-toggle`, `launch-max-mode-toggle`). `createAndStartTask` callers pass `agentProfileId` — both dialogs add it to their payload (and their `promptByteOverage` pre-check uses `composeLaunchPrompt(selectedProfile, prompt)`).
- `AgentProfilesSection`: list of `AgentProfileCard variant="row"` with Edit/Delete (delete via `useConfirm({variant:"destructive"})`, error toast `duration: Infinity`, no success toast); inline `AgentProfileForm` (create/edit): name input, `<TaskLaunchPickers launch={…} hideProfilePicker />` for harness/mode/model/effort/fast/max, instructions textarea (`data-testid="agent-profile-instructions"`), `<SkillsPicker harnessId={launch.agent}>`; Save calls create/update; validation errors inline; Edit disabled while a form is open (Saved Prompts convention). Test ids: `agent-profiles-section`, `agent-profile-add`, `agent-profile-row` (+ `data-profile-id`), `agent-profile-edit`, `agent-profile-delete`, `agent-profile-form`, `agent-profile-name`, `agent-profile-save`, `agent-profile-cancel`, `agent-profile-form-error`.
Acceptance: typecheck; `settings-dialog-view.test.ts` updated for the fifth section.

**T7 — New Task form, App plumbing, task details, board card, transcript.** Owns `src/mainview/components/kanban/NewTaskForm.tsx`, `src/mainview/App.tsx`, `src/mainview/components/kanban/RunPanel.tsx`, `src/mainview/components/kanban/TaskCard.tsx`, `src/mainview/components/kanban/Column.tsx` (only if its memo comparator must learn the new fields — check `TaskCard` props), `src/mainview/components/kanban/MessageSegments.tsx`, `src/mainview/components/kanban/MessageHistoryPicker.tsx`.
- `NewTaskForm`: `<AgentProfilePicker>` above the harness grid (`useAgentProfiles`, refetch on Settings close via the existing `harnesses` refresh signal or a `profilesVersion` prop from App); when set, hide the harness grid + Code/Plan + mode/model/effort + fast/max block and show the selected card; `promptOverage = promptByteOverage(kind, composeLaunchPrompt(selectedProfile, prompt))` with `kind` = the profile's harness kind; submit sends `agentProfileId` (and the profile's values for the existing fields). "Manage agents…" → `onOpenSettingsAgents` prop.
- `App.tsx`: `openSettingsAgents` (mirrors `openSettingsHarnesses`), threaded to `NewTaskForm` and `RunPanel`; refetch profiles when Settings closes.
- `RunPanel`: header chip `data-testid="task-agent-profile-chip"` (`AgentProfileCard variant="chip"`, `deleted` when the live list lacks the id; tooltip = summary); when `task.agentProfileId` is set the Agent/Mode/Model/Effort (and cursor fast/max) controls render disabled with hint "Bound to agent <name> — detach to edit" and a **Detach** button (`task-agent-profile-detach`) calling `api.detachTaskAgentProfile` and merging the returned task.
- `TaskCard`: the agent badge shows the profile name instead of the raw harness id when a snapshot exists (`title` = harness id, `data-testid="task-card-agent-profile"`), "(deleted)" suffix not shown on the card (space); keep the `model · mode` line.
- `MessageSegments`: `AGENT_INSTRUCTIONS_TAG` renders as a collapsible block labeled "Agent instructions" (collapsed by default, `data-testid="agent-instructions-block"`, chevron toggle, body via the existing markdown renderer with `MD_URL_TRANSFORM`); `MessageHistoryPicker` lists `stripAgentInstructionsPreamble(text)`.
Acceptance: typecheck; existing `task-context-menu`/`task-card` e2e unaffected.

Barrier: `bun run typecheck`; `bun run build` (vite) succeeds.

### Wave 4 — docs (1 agent or self)

**T8 — docs.** Owns `CLAUDE.md` (new Orchestration-flow item 15 "Agents (agent profiles)" summarizing D1–D14 and the routes), `docs/plans/agent-profiles.md` (this file: fill the landed-notes section), `README.md` (feature list line if one exists for Saved Prompts/Harnesses).

## 5. Work breakdown — test tasks

E2e **applies**: the feature is a UI→API→DB→agent-launch flow, the app runs headless under Playwright with the fake claude driver, and the freeze/fallback rules are only observable through the assembled system.

| ID | Layer | Covers | Owns |
| --- | --- | --- | --- |
| TT1 | unit | `composeLaunchPrompt`/`strip…`/`normalizeSkillName`/`matchAgentProfileRef`/`snapshotFromProfile`; `userMessageLines` `agent›` label | `src/shared/agent-profile.test.ts`, `src/shared/user-message.test.ts` (extend) |
| TT2 | db | `agentProfiles` CRUD, unique-name error, skills normalization/cap, `tasks.setAgentProfile` + generic-update skip, `runs.countForTask`, harness delete blocked by a profile (`profileIds`) | `src/bun/agent-profiles.test.ts` (new) |
| TT3 | endpoint | all routes incl. 400/404/409 shapes, `POST /tasks` with `agentProfileId` overriding body fields, PATCH 409 guard, detach route (+archived 409), harness DELETE 409 payload | `src/bun/agent-profiles-endpoint.test.ts` (new, unique `AGETOR_API_PORT`) |
| TT4 | orchestrator | fake claude driver: first `user` event equals `appendReferences(composeLaunchPrompt(...), refs)`; live-before-first-run refresh copies edited model + refreshes snapshot; after a run, a profile edit does not change the task and a re-run injects the snapshot; deleted profile → snapshot; gemini overage rule with preamble (both branches); no injection on `sendInput` | `src/bun/orchestrator-agent-profiles.test.ts` (new) |
| TT5 | webview lib | `filterAgentProfiles`, `resolveTaskProfileDisplay`, settings-view fifth section | `src/mainview/lib/agent-profiles.test.ts` (new), `settings-dialog-view.test.ts` (already touched by T6) |
| TT6 | CLI | `agent` flag parsing + `--instructions-file -`; `add --profile` resolution/usage-error/`--json`; `ls`/`show` rendering with a profile | `src/cli/commands/agent-profile.test.ts` (new), `src/cli/commands/add.test.ts` (extend) |
| TT7 | e2e | Settings → Agents create (skills via free text + a suggestion row when the environment lists any — click the exact row, never "first match"), edit, delete-confirm; New Task picker → card replaces block → create & start → transcript "Agent instructions" block + "Your task:" → board badge shows name → details chip + locked dropdowns → Detach unlocks; edit profile after run → `GET /tasks/:id` snapshot unchanged; new unstarted task picks up live edit on start; delete profile → chip "(deleted)" and re-run still injects | `e2e/agent-profiles.spec.ts` (new) |

E2e run recipe (from Phase 1): `bun install` once; `bun node_modules/@playwright/test/cli.js test e2e/agent-profiles.spec.ts` (fixtures boot the headless backend per worker with `AGETOR_CLAUDE_DRIVER=fake`; no external services; one Playwright run at a time on this machine). Full suites: `bun run typecheck && bun test` then the e2e spec.

## 6. Execution waves

1. **Wave 1**: T1 ∥ T2 → checkpoint (typecheck, `bun test src/bun`).
2. **Wave 2**: T3 ∥ T4 ∥ T5 → checkpoint (typecheck, `bun test src/bun src/cli`).
3. **Wave 3**: T6 ∥ T7 → checkpoint (typecheck, `bun run build`).
4. **Wave 4**: T8 (docs) — can run alongside Phase 5 review since it owns only docs.
5. Phase 5 review → Phase 6 tests (TT1 ∥ TT2 ∥ TT3 ∥ TT4 ∥ TT5 ∥ TT6 ∥ TT7, all file-disjoint) → Phase 7 run → Phase 8 fixes.

File-ownership check: no file appears in two tasks of the same wave (T6/T7 split NewTaskForm vs TaskLaunchPickers; App.tsx only in T7; `settings-dialog-view.test.ts` in T6 then TT5 in a later phase).

## 7. Blast radius & risks

- **`tasks.update` SET clause** grows a skip-list entry, not a column: a wrong edit there would clobber snapshots on every PATCH → TT2 pins it.
- **`orchestrator-fx.test.ts` gemini overage pin**: including the preamble in *both* raw and expanded budgets keeps the "already over budget rides the spawn-throw path" behavior; TT4 adds the profile variant.
- **`reconcileTaskSession`**: the first-run refresh touches agent/model before any session exists, so no session drop fires. The PATCH guard prevents the UI/CLI from changing bound fields, so reconcile is never asked to mirror a profile change mid-session.
- **Prompt echo dedup**: the first `user` event now carries the preamble; the JSONL twin claude writes carries the same text, so `(runId, data)` dedup still matches.
- **Harness delete**: newly blocked by profiles — Settings and `agetor harness rm` copy updated (T6/T5) so the 409 reads correctly.
- **Existing tasks/rows**: unaffected (`NULL` columns read as "no agent"; migration is additive).
- **MessageHistoryPicker**: stripped preamble is display-only; resend sends the stripped text (desired).
- Rollback: additive migrations; disabling the picker leaves rows harmless.

## 8. Open questions / assumptions

- A1 (assumption, owner-confirmed indirectly): "must not affect tasks that ran" is implemented as *freeze at first run* (D2). A not-yet-started task follows live edits, including a harness change.
- A2: Profile `mode` uses the same id vocabulary as tasks; `null` means the kind default (`defaultModeFor`). The Settings form always stores an explicit mode (the picker's value), so `null` only arises from the CLI.
- A3: Instructions are not `@`-expanded (authored text). Skills tokens are `/name`; agetor never validates that a skill exists at launch (same as the composer's insert today).
- A4: No SSE broadcast for profile CRUD; pickers refetch on open and when Settings closes (same polling posture as harnesses/prompts).
- A5: Effort stored on a profile is passthrough (null-clear-only philosophy of the task PATCH guard); the form only offers `supportedEfforts` rows.

## 9. Completeness ledger

| Remainder | Disposition |
| --- | --- |
| Profile picker on Resolve-Conflicts + Create-from-issue dialogs | **in this run** — T6 |
| `useTaskLaunch` lacked fast/maxMode (needed by the profile form) | **in this run** — T6 |
| Client-side gemini budget pre-check with preamble (NewTaskForm + issue dialog) | **in this run** — T7 / T6 |
| Server-side budget rule with preamble | **in this run** — T3 |
| Harness delete while a profile references it | **in this run** — T2/T3/T5/T6 (409 + copy) |
| `agetor edit --model` on a bound task | **in this run** — server 409 (T3) + CLI copy/`--detach-profile` (T5) |
| Task details lock + Detach | **in this run** — T3/T7 |
| Board card + TUI/CLI display of the profile | **in this run** — T7 / T5 |
| MessageHistoryPicker resend of the first prompt re-injecting the preamble | **in this run** — T7 (strip) |
| CLI `userMessageLines` label for the new tag (`agetor logs`, TUI) | **in this run** — T1 |
| Docs: CLAUDE.md item, plan landed notes, README | **in this run** — T8 |
| Archived tasks: detach refused | **in this run** — T3 |
| Existing rows backfill | not needed — NULL = no agent (additive) |
| Remember last-used profile | **out of scope** — owner Q10 said no |
| Per-workdir (project-level) skills in the Settings autocomplete | **out of scope** — profiles are workdir-agnostic (owner Q11); project skills still work via free text |
| Harness-native system-prompt flags (claude `--append-system-prompt`) | **out of scope** — owner chose prompt injection (Q4); revisit as its own ticket if a harness-level channel is ever wanted |
| "Used by N tasks" counter on a profile row | **in this run** — owner asked for it after delivery; server-derived `taskCount` (`agentProfiles.taskCounts`/`taskCount` in `db.ts`, stamped on every `/agent-profiles*` response by `server.ts`), Settings row + delete-confirm copy, CLI `agent ls`/`agent show` |
| Duplicating/cloning a profile | **out of scope** — different ticket |

## 10. Landed notes

Delivered on `feature/agents-creating-agents` (base `fe65199`), commits: `0d8cdbc` plan · `f110588` wave 1 · `b62d5b5` wave 2 · `9056190` wave 3 + docs · `cb1a4c7` tests + review fixes · a follow-up commit pinning one test precondition.

**Review (Opus, `code-review` skill):** 1 critical, 3 major, 12 minor, 2 nits, 2 docs — all addressed in `cb1a4c7`:
- critical: `POST /tasks` rejected `agentProfileId: null`, which every webview launch surface sent by default → server accepts null, clients omit the key when unset.
- major: Settings edit-form seed race (`useTaskLaunch` open-effect overwrote the seed from `last*` prefs) → `useTaskLaunch(open, { initial })`, `loading` initialised to `open`; `SkillsPicker` committed the first suggestion on Tab/Enter → `active = -1` until navigated, empty text never `preventDefault`s; launch dialogs gated submit on the hidden manual harness → `effectiveAgent`/`effectiveStatus` on the hook, availability/auth hints rendered in the selected-card branch.
- minor: drift check ignored nothing (`capturedAt` always differed) → `agentProfileSnapshotDrifted`; `[]` vs not-loaded → `useAgentProfiles().loaded`; RunPanel auto-clear effects on bound tasks → early-return; empty `harnessLabel` nulled the snapshot → defaults to the harness id; `AGENT_KINDS` derived from `AGENT_OPTIONS`; failed skill-suggestion fetch was cached → never cached; skills validation made strict (400 on non-string entry / >50 after normalisation); chip now snapshot-first with live list only deciding `deleted`; Detach merges the returned task optimistically via `onTaskFieldsChanged`; disabled-harness marker on cards; `--instructions-file` trims both channels; active-row reset on array identity; ARIA combobox wiring.
- orchestrator-found: a profile with `effort: null` stranded the launch (`buildCommand` requires effort) → `defaultEffortFor` at both copy points.

**Tests:** `bun run typecheck` clean. Full `bun test`: 5315 pass / 3 skip; the only branch-related failure was a precondition flake in `orchestrator-agent-profiles.test.ts` (assumed cursor disabled while `db.ts` is a process-wide singleton across files) — pinned explicitly. `src/bun/reconcile.test.ts` "startTask honors cancel" fails identically on the base commit in this environment (real tmux + codex cancel) and is unrelated. E2e: `e2e/agent-profiles.spec.ts` 4/4, plus `issue-task` / `resolve-conflicts` / `task-context-menu` 16/16.

**Ledger outcome:** every "in this run" row landed; out-of-scope rows unchanged; no owner-deferred rows.

**E2E coverage sweep (owner request, 2026-09-14):** five Playwright specs plus one in-process CLI integration test now cover the whole surface — `e2e/agent-profiles.spec.ts` (the original four flows), `e2e/agent-profiles-settings.spec.ts` (form validation/pickers, edit seeding, SkillsPicker keyboard, draft survival across sections, cursor-only toggles, disabled-harness marker, harness delete blocked by a profile, duplicate + task count), `e2e/agent-profiles-launch.spec.ts` (picker UX/search/keyboard/clear/empty state, "Manage agents…" deep link + refresh on Settings close, gemini overage with the preamble, unavailable-harness hint, empty-profile launch, locked details + optimistic Detach, history picker stripping, block collapsed on remount, deleted profile resets the form), `e2e/agent-profiles-dialogs.spec.ts` (Create-from-issue and Resolve-Conflicts with a profile, unavailable-harness gating, Escape closes popover then dialog), `e2e/agent-profiles-api.spec.ts` (REST edges: null/unknown id, PATCH 409 guard, archived detach, validation 400s/409s, taskCount transitions, harness delete 409, freeze rule, snapshot survives a harness relabel), and `src/cli/agent-profile-daemon.test.ts` (real `startApiServer()` + real client through `cmdAgentProfile`/`cmdAdd`/`show`). Test ids added for stable locators: `agent-profile-harness-unavailable` (NewTaskForm), `launch-agent-unavailable-hint` (TaskLaunchPickers), `message-history-trigger/popover/item`. Two lessons: e2e backends are per worker and shared by every spec file in that worker, so every spec deletes what it creates in `afterAll` and never asserts list-wide counts; and `useTaskLaunch` now seeds its six launch values synchronously from `opts.initial` (the edit form used to flash claude-code defaults until the harness fetch resolved). Verified: 32/32 with `--workers=1`; the default 5-worker run flakes on timing only while the machine carries a foreign VM + Simulator load (load average >150).

**Follow-up (2026-09-13):** owner asked for a "used by N tasks" counter after delivery. Added `taskCount?: number` to `AgentProfile` (`types.ts`); `agentProfiles.taskCounts()`/`taskCount(id)` in `db.ts` (one grouped query for the list route, a targeted single-profile query otherwise); `withTaskCount`/`withTaskCounts` in `server.ts` stamp it onto every `/agent-profiles*` response (list, and single-resource GET/POST/PATCH). Settings row renders "Used by N task(s)" / "Not used by any task yet" (`data-testid="agent-profile-task-count"`) and the delete-confirm description now names the exact bound-task count. CLI: `agetor agent ls` gains a `tasks` column (after `skills`, before `instructions`) via the exported pure `formatAgentProfileListRow`; `agetor agent show` prints a `used by:` line via the exported `taskCountText`. Tests: db-level counts (0/1/3 across profiles, detach lowers it, task delete lowers it, archived tasks still counted), endpoint-level (`taskCount` on list/GET/POST/PATCH, transitions on bind/detach/delete), CLI unit tests for both pure helpers, and `e2e/agent-profiles.spec.ts`'s delete scenario now asserts the row reads "Used by 2 tasks" (task from scenario 3's "ran" task plus task B, both still bound; task A from scenario 2 was detached) before deleting. `bun run typecheck` clean; `bun test src/bun/agent-profiles.test.ts src/bun/agent-profiles-endpoint.test.ts src/cli/commands/agent-profile.test.ts src/mainview` — 1240 pass / 0 fail; `e2e/agent-profiles.spec.ts` 4/4.
